import { Type } from "@sinclair/typebox";
import {
  createAgentSession,
  InteractiveMode,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createExtensionRuntime,
  type ToolDefinition,
  type ResourceLoader,
  type LoadExtensionsResult,
  type Extension,
  type RegisteredCommand,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import {
  getModel,
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { resolve, basename } from "path";
import { existsSync, mkdirSync } from "fs";
import { beigeDir } from "../paths.js";
import type { OnToolStart } from "../gateway/agent-manager.js";
import { buildSystemPrompt, readWorkspaceAgentsMd } from "../gateway/agent-manager.js";
import { SessionSettingsStore, resolveSessionSetting } from "../gateway/session-settings.js";
import { BeigeSessionStore } from "../gateway/sessions.js";
import { RestrictedModelRegistry, buildAllowedModels } from "../config/restricted-model-registry.js";

// ── Types from gateway API ───────────────────────────────────────────────────

/** Shape of an agent entry returned by the gateway's GET /api/agents endpoint. */
interface GatewayAgentInfo {
  name: string;
  model: { provider: string; model: string };
  fallbackModels: Array<{ provider: string; model: string }>;
  tools: string[];
  skills: string[];
  toolContext: string;
  skillContext: string;
  workspaceDir?: string;
}

/** Shape of model metadata returned by GET /api/agents/:name/models. */
interface GatewayModelInfo {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: unknown;
  thinkingLevel: string;
}

/**
 * TUI channel — runs in a separate process and connects to the gateway HTTP API.
 *
 * Architecture:
 * - LLM calls are proxied through the gateway (the only process that needs API keys)
 * - Core tool execution (read/write/patch/exec) is also proxied to the gateway
 * - The gateway owns auth, sandboxes, audit, and policy enforcement
 * - The TUI never loads the config file and never needs API keys
 *
 * This gives you:
 * - Full pi TUI (editor, streaming, model switching, compaction, history)
 * - Sandboxed tool execution managed by the gateway
 * - LLM calls routed through the gateway's auth + provider setup
 *
 * Commands:
 * - /new                     — Start a fresh session (pi built-in, works correctly)
 * - /beige-resume [n]       — Resume a previous beige session
 * - /beige-sessions         — List saved beige sessions for the current agent
 * - /beige-agent [name]     — Switch to a different beige agent
 * - /beige-verbose on|off   — Toggle verbose tool-call notifications
 * - /v on|off               — Shorthand for /beige-verbose
 */

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7433";

export interface TUIOptions {
  agentName?: string;
  gatewayUrl?: string;
}

/**
 * Mutable state shared between the TUI and extension commands.
 */
interface TUIState {
  agentName: string;
  /** Minimal agent config fetched from gateway (model refs + workspaceDir) */
  agentModelRef: { provider: string; model: string };
  agentFallbackRefs: Array<{ provider: string; model: string }>;
  workspaceDir: string;
  session: AgentSession | null;
  toolStartHandlerRef: { fn: OnToolStart | undefined };
  gatewayUrl: string;
  authStorage: AuthStorage;
  /** Restricted registry that only exposes models allowed for this agent */
  modelRegistry: RestrictedModelRegistry;
  /** Underlying unrestricted registry for internal lookups */
  underlyingModelRegistry: ModelRegistry;
  settingsStore: SessionSettingsStore;
  sessionStore: BeigeSessionStore;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function launchTUI(opts: TUIOptions): Promise<void> {
  const gatewayUrl = opts.gatewayUrl ?? DEFAULT_GATEWAY_URL;

  // Verify gateway is reachable
  try {
    const res = await fetch(`${gatewayUrl}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[TUI] Connected to gateway at ${gatewayUrl}`);
  } catch (err) {
    console.error(
      `[TUI] Cannot connect to gateway at ${gatewayUrl}\n` +
      `      Start the gateway first: beige\n` +
      `      Error: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  // Fetch available agents from gateway
  const agentsRes = await fetch(`${gatewayUrl}/api/agents`);
  const { agents } = (await agentsRes.json()) as { agents: GatewayAgentInfo[] };
  const agentNames = agents.map((a) => a.name);

  let agentName = opts.agentName;
  if (!agentName) {
    agentName = agentNames[0];
    if (agentNames.length > 1) {
      console.log(`[TUI] No agent specified, using '${agentName}'. Available: ${agentNames.join(", ")}`);
    }
  }

  const agentInfo = agents.find((a) => a.name === agentName);
  if (!agentInfo) {
    console.error(`[TUI] Unknown agent '${agentName}'. Available: ${agentNames.join(", ")}`);
    process.exit(1);
  }

  // ── Auth storage (no real keys — LLM calls go through gateway proxy) ──
  const beigeAuthPath = resolve(beigeDir(), "auth.json");
  const beigeModelsPath = resolve(beigeDir(), "models.json");
  const authStorage = AuthStorage.create(beigeAuthPath);
  const modelRegistry = new ModelRegistry(authStorage, beigeModelsPath);

  // ── Register proxy providers ─────────────────────────────
  // For each provider used by this agent, register a provider with a custom
  // streamSimple that proxies LLM calls through the gateway.  The gateway
  // resolves the API key and forwards to the real LLM provider.
  const modelsRes = await fetch(`${gatewayUrl}/api/agents/${encodeURIComponent(agentName)}/models`);
  const { models: modelInfos } = (await modelsRes.json()) as { models: GatewayModelInfo[] };

  if (modelInfos.length === 0) {
    console.error(`[TUI] No models found for agent '${agentName}'`);
    process.exit(1);
  }

  // Group models by provider and register each provider with proxy streamSimple
  const providerModels = new Map<string, GatewayModelInfo[]>();
  for (const m of modelInfos) {
    const list = providerModels.get(m.provider) ?? [];
    list.push(m);
    providerModels.set(m.provider, list);
  }

  for (const [provider, providerModelInfos] of providerModels) {
    // Set a dummy runtime key so the model appears "available" to pi's registry.
    // The actual API key is resolved by the gateway proxy.
    authStorage.setRuntimeApiKey(provider, "beige-gateway-proxy");

    modelRegistry.registerProvider(provider, {
      // api is required by ModelRegistry when streamSimple is provided.
      // All models for a given provider share the same API protocol.
      api: providerModelInfos[0].api as any,
      // apiKey is required when defining models — the gateway resolves the
      // real key; this placeholder just satisfies ModelRegistry validation.
      apiKey: "beige-gateway-proxy",
      baseUrl: modelInfos[0].baseUrl,
      streamSimple: createProxyStreamSimple(gatewayUrl),
      models: providerModelInfos.map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api as any,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        headers: m.headers,
        compat: m.compat as any,
      })),
    });
  }

  // ── Create restricted model registry ──────────────────────
  const primaryRef = agentInfo.model;
  const fallbackRefs = agentInfo.fallbackModels ?? [];
  const allowedModels = buildAllowedModels(primaryRef, fallbackRefs);
  const restrictedModelRegistry = new RestrictedModelRegistry(modelRegistry, allowedModels);

  // ── Workspace dir ────────────────────────────────────────
  const agentDir = resolve(beigeDir(), "agents", agentName);
  const workspaceDir = agentInfo.workspaceDir ?? resolve(agentDir, "workspace");

  // ── Shared state ──────────────────────────────────────────
  const settingsStore = new SessionSettingsStore();
  const sessionStore = new BeigeSessionStore();
  const toolStartHandlerRef: { fn: OnToolStart | undefined } = { fn: undefined };

  const state: TUIState = {
    agentName,
    agentModelRef: primaryRef,
    agentFallbackRefs: fallbackRefs,
    workspaceDir,
    session: null,
    toolStartHandlerRef,
    gatewayUrl,
    authStorage,
    modelRegistry: restrictedModelRegistry,
    underlyingModelRegistry: modelRegistry,
    settingsStore,
    sessionStore,
  };

  // Wire initial verbose state
  const sessionKey = BeigeSessionStore.tuiKey(agentName);
  const initialVerbose = resolveSessionSetting(
    "verbose",
    false,
    undefined,
    settingsStore.get(sessionKey, "verbose")
  );
  if (initialVerbose) {
    toolStartHandlerRef.fn = makeTUIToolStartHandler();
  }

  // ── Build extension and create session ───────────────────
  const systemPromptRef: { value: string } = { value: "" };
  const agentsFilesRef: { value: Array<{ path: string; content: string }> } = { value: [] };
  const extensionsResult = await buildBeigeExtension(state, agentNames, systemPromptRef, agentsFilesRef);
  await createSession(state, extensionsResult, systemPromptRef, agentsFilesRef);

  if (!state.session) {
    console.error("[TUI] Failed to create initial session");
    process.exit(1);
  }

  // ── Launch pi TUI ─────────────────────────────────────────
  console.log(`[TUI] Agent: ${agentName} (${primaryRef.provider}/${primaryRef.model})`);

  const availableModels = state.modelRegistry.getAvailable();
  if (availableModels.length > 1) {
    const modelList = availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
    console.log(`[TUI] Allowed models: ${modelList}`);
  }

  console.log(`[TUI] Tools: ${agentInfo.tools.join(", ") || "(core only)"}`);
  console.log(`[TUI] LLM: proxied via gateway (no local API keys needed)`);
  console.log(`[TUI] Verbose: ${initialVerbose ? "on" : "off"} — use /beige-verbose on|off to toggle`);
  console.log(`[TUI] Commands: /new, /beige-resume, /beige-sessions, /beige-agent <name>, /beige-verbose on|off (or /v on|off)`);

  // Suppress pi's "update available" banner — beige manages its own update lifecycle.
  process.env.PI_SKIP_VERSION_CHECK = "1";

  const mode = new InteractiveMode(state.session, {});
  await mode.run();
}

// ── LLM proxy ────────────────────────────────────────────────────────────────

/**
 * Create a streamSimple function that proxies LLM calls through the gateway.
 *
 * The gateway resolves the API key, selects the correct stream function based
 * on the model's api field, and streams AssistantMessageEvent objects back as
 * newline-delimited JSON.
 */
function createProxyStreamSimple(
  gatewayUrl: string
): (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  return (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();

    (async () => {
      try {
        const res = await fetch(`${gatewayUrl}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: model.provider,
            modelId: model.id,
            context,
            options: {
              reasoning: options?.reasoning,
              maxTokens: options?.maxTokens,
              temperature: options?.temperature,
            },
          }),
          signal: options?.signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          stream.push({
            type: "error",
            reason: "error",
            error: makeErrorMessage(model, "error", `Gateway ${res.status}: ${errorText}`),
          });
          stream.end();
          return;
        }

        // Read newline-delimited JSON stream
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.trim()) {
              const event = JSON.parse(line) as AssistantMessageEvent;
              stream.push(event);
            }
          }
        }

        stream.end();
      } catch (err) {
        const isAborted = (err as any).name === "AbortError";
        stream.push({
          type: "error",
          reason: isAborted ? "aborted" : "error",
          error: makeErrorMessage(
            model,
            isAborted ? "aborted" : "error",
            isAborted ? undefined : (err instanceof Error ? err.message : String(err))
          ),
        });
        stream.end();
      }
    })();

    return stream;
  };
}

/** Build a minimal AssistantMessage for error/abort events. */
function makeErrorMessage(
  model: { api: string; provider: string; id: string },
  stopReason: "error" | "aborted",
  errorMessage?: string
) {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

// ── Session creation ──────────────────────────────────────────────────────────

/**
 * Create a new pi session for the current agent in state.
 *
 * `systemPromptRef` is a mutable ref whose `.value` is read by the resource
 * loader on every call to `getSystemPrompt()`. This function populates it with
 * the initial system prompt. Update it (and sync to session._baseSystemPrompt)
 * when switching agents so the new context takes effect without recreating the
 * AgentSession.
 */
async function createSession(
  state: TUIState,
  extensionsResult: LoadExtensionsResult,
  systemPromptRef: { value: string },
  agentsFilesRef: { value: Array<{ path: string; content: string }> }
): Promise<void> {
  const { agentName, agentModelRef, gatewayUrl, authStorage, modelRegistry, underlyingModelRegistry, toolStartHandlerRef, workspaceDir } = state;

  // Fetch agent info from gateway (for tool/skill context)
  const agentsRes = await fetch(`${gatewayUrl}/api/agents`);
  const { agents } = (await agentsRes.json()) as { agents: GatewayAgentInfo[] };
  const agentInfo = agents.find((a) => a.name === agentName);

  // Resolve the model from the proxy registry
  const model = underlyingModelRegistry.find(agentModelRef.provider, agentModelRef.model);
  if (!model) {
    throw new Error(`Model not found: ${agentModelRef.provider}/${agentModelRef.model}`);
  }

  // Pass a getter so tool calls always route to the currently-active agent
  const coreTools = createProxyTools(() => state.agentName, gatewayUrl, toolStartHandlerRef);

  // Use pre-built tool/skill context from the gateway
  const toolContext = agentInfo?.toolContext ?? "";
  const skillContext = agentInfo?.skillContext ?? "";
  systemPromptRef.value = buildSystemPrompt(agentName, toolContext, skillContext);

  // Read workspace AGENTS.md so it's injected into the system prompt context.
  agentsFilesRef.value = readWorkspaceAgentsMd(workspaceDir);

  const sessionsDir = resolve(beigeDir(), "sessions", agentName);
  const sessionManager = SessionManager.create(process.cwd(), sessionsDir);

  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: agentsFilesRef.value }),
    getSystemPrompt: () => systemPromptRef.value,
    getAppendSystemPrompt: () => [],
    getPathMetadata: () => new Map(),
    extendResources: () => {},
    reload: async () => {},
  };

  // Find the GatewayModelInfo for the thinking level
  const modelsRes = await fetch(`${gatewayUrl}/api/agents/${encodeURIComponent(agentName)}/models`);
  const { models: modelInfos } = (await modelsRes.json()) as { models: GatewayModelInfo[] };
  const currentModelInfo = modelInfos.find((m) => m.id === agentModelRef.model && m.provider === agentModelRef.provider);
  const thinkingLevel = (currentModelInfo?.thinkingLevel ?? "off") as any;

  const { session } = await createAgentSession({
    model,
    thinkingLevel,
    tools: [],
    customTools: coreTools,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3 },
    }),
    resourceLoader,
    authStorage,
    modelRegistry: modelRegistry.getUnderlying(),
  });

  // Replace the session's modelRegistry with our restricted version
  (session as any)._modelRegistry = modelRegistry;

  state.session = session;
}

// ── Beige extension factory ───────────────────────────────────────────────────

/**
 * Build the inline "beige" extension that registers all TUI commands.
 */
async function buildBeigeExtension(
  state: TUIState,
  availableAgents: string[],
  systemPromptRef: { value: string },
  agentsFilesRef: { value: Array<{ path: string; content: string }> }
): Promise<LoadExtensionsResult> {
  const runtime = createExtensionRuntime();

  // ── /verbose and /v ───────────────────────────────────────
  const handleVerbose = async (args: string, ctx: any) => {
    const sessionKey = BeigeSessionStore.tuiKey(state.agentName);
    const arg = args.trim().toLowerCase();

    if (!arg || (arg !== "on" && arg !== "off")) {
      const current = state.settingsStore.get(sessionKey, "verbose") ?? false;
      ctx.ui.notify(`Verbose mode is currently ${current ? "ON" : "OFF"}. Usage: /beige-verbose on|off`, "info");
      return;
    }

    const enable = arg === "on";
    state.settingsStore.set(sessionKey, "verbose", enable);
    state.toolStartHandlerRef.fn = enable ? makeTUIToolStartHandler() : undefined;

    ctx.ui.notify(
      enable
        ? "🔊 Verbose mode ON — tool calls will be shown as they execute."
        : "🔇 Verbose mode OFF — tool calls are hidden.",
      "info"
    );
  };

  // ── /sessions ─────────────────────────────────────────────
  const handleSessions = async (_args: string, ctx: any) => {
    const sessions = listSessions(state.agentName);
    if (sessions.length === 0) {
      ctx.ui.notify("No saved sessions for this agent.", "info");
      return;
    }

    const lines = [`📋 Sessions for agent '${state.agentName}':`, ""];
    for (let i = 0; i < Math.min(sessions.length, 10); i++) {
      const s = sessions[i];
      const date = s.timestamp.toLocaleDateString();
      const time = s.timestamp.toLocaleTimeString();
      lines.push(`  ${i + 1}. ${basename(s.file)} (${date} ${time})`);
    }
    if (sessions.length > 10) {
      lines.push(`  ... and ${sessions.length - 10} more`);
    }
    lines.push("");
    lines.push("Use /beige-resume <number> to continue a session.");

    ctx.ui.notify(lines.join("\n"), "info");
  };

  // ── /resume ───────────────────────────────────────────────
  const handleResume = async (args: string, ctx: any) => {
    const sessions = listSessions(state.agentName);
    if (sessions.length === 0) {
      ctx.ui.notify("No saved sessions to resume.", "info");
      return;
    }

    const arg = args.trim();
    let index = parseInt(arg, 10) - 1;
    if (isNaN(index) || index < 0 || index >= sessions.length) {
      if (arg === "") {
        ctx.ui.notify(
          `Usage: /beige-resume <number>\n\nSessions:\n${sessions
            .slice(0, 5)
            .map((s, i) => `  ${i + 1}. ${basename(s.file)}`)
            .join("\n")}`,
          "info"
        );
      } else {
        ctx.ui.notify(`Invalid session number. Use /beige-sessions to see available sessions.`, "error");
      }
      return;
    }

    const targetSession = sessions[index];
    await ctx.switchSession(targetSession.file);
    ctx.ui.notify(`📂 Resumed session: ${basename(targetSession.file)}`, "info");
  };

  // ── /agent ────────────────────────────────────────────────
  const handleAgent = async (args: string, ctx: any) => {
    const arg = args.trim();

    if (!arg) {
      ctx.ui.notify(
        `Current agent: ${state.agentName}\n\nAvailable agents:\n${availableAgents.map((a) => `  • ${a}`).join("\n")}\n\nUsage: /beige-agent <name>`,
        "info"
      );
      return;
    }

    if (!availableAgents.includes(arg)) {
      ctx.ui.notify(
        `Unknown agent '${arg}'. Available: ${availableAgents.join(", ")}`,
        "error"
      );
      return;
    }

    if (arg === state.agentName) {
      ctx.ui.notify(`Already using agent '${arg}'.`, "info");
      return;
    }

    // Fetch new agent info from gateway
    const agentsRes = await fetch(`${state.gatewayUrl}/api/agents`);
    const { agents } = (await agentsRes.json()) as { agents: GatewayAgentInfo[] };
    const newAgentInfo = agents.find((a) => a.name === arg);
    if (!newAgentInfo) {
      ctx.ui.notify(`Agent '${arg}' not found on gateway.`, "error");
      return;
    }

    // Fetch model metadata for the new agent
    const modelsRes = await fetch(`${state.gatewayUrl}/api/agents/${encodeURIComponent(arg)}/models`);
    const { models: newModelInfos } = (await modelsRes.json()) as { models: GatewayModelInfo[] };

    if (newModelInfos.length === 0) {
      ctx.ui.notify(`No models configured for agent '${arg}'.`, "error");
      return;
    }

    // Register proxy providers for the new agent's models
    const providerModels = new Map<string, GatewayModelInfo[]>();
    for (const m of newModelInfos) {
      const list = providerModels.get(m.provider) ?? [];
      list.push(m);
      providerModels.set(m.provider, list);
    }

    for (const [provider, pModelInfos] of providerModels) {
      state.authStorage.setRuntimeApiKey(provider, "beige-gateway-proxy");
      state.underlyingModelRegistry.registerProvider(provider, {
        api: pModelInfos[0].api as any,
        apiKey: "beige-gateway-proxy",
        baseUrl: pModelInfos[0].baseUrl,
        streamSimple: createProxyStreamSimple(state.gatewayUrl),
        models: pModelInfos.map((m) => ({
          id: m.id,
          name: m.name,
          api: m.api as any,
          reasoning: m.reasoning,
          input: m.input,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          headers: m.headers,
          compat: m.compat as any,
        })),
      });
    }

    // Update state
    state.agentName = arg;
    state.agentModelRef = newAgentInfo.model;
    state.agentFallbackRefs = newAgentInfo.fallbackModels ?? [];
    state.workspaceDir = newAgentInfo.workspaceDir ?? resolve(beigeDir(), "agents", arg, "workspace");

    // Update restricted model registry
    const allowedModels = buildAllowedModels(state.agentModelRef, state.agentFallbackRefs);
    state.modelRegistry = new RestrictedModelRegistry(state.underlyingModelRegistry, allowedModels);
    if (state.session) {
      (state.session as any)._modelRegistry = state.modelRegistry;
    }

    // Rebuild system prompt
    const toolContext = newAgentInfo.toolContext ?? "";
    const skillContext = newAgentInfo.skillContext ?? "";
    systemPromptRef.value = buildSystemPrompt(arg, toolContext, skillContext);
    agentsFilesRef.value = readWorkspaceAgentsMd(state.workspaceDir);

    if (state.session) {
      const toolNames = state.session.getActiveToolNames();
      (state.session as any)._baseSystemPrompt = (state.session as any)._rebuildSystemPrompt(toolNames);
      (state.session as any).agent.setSystemPrompt((state.session as any)._baseSystemPrompt);
    }

    // Update verbose handler
    const sessionKey = BeigeSessionStore.tuiKey(arg);
    const verbose = resolveSessionSetting(
      "verbose",
      false,
      undefined,
      state.settingsStore.get(sessionKey, "verbose")
    );
    state.toolStartHandlerRef.fn = verbose ? makeTUIToolStartHandler() : undefined;

    // Point session manager at new agent's session directory
    if (state.session) {
      const newSessionsDir = resolve(beigeDir(), "sessions", arg);
      mkdirSync(newSessionsDir, { recursive: true });
      (state.session.sessionManager as any).sessionDir = newSessionsDir;
    }

    // Switch to new agent's model
    if (state.session) {
      const newModel = state.underlyingModelRegistry.find(state.agentModelRef.provider, state.agentModelRef.model);
      if (newModel) {
        const newModelInfo = newModelInfos.find((m) => m.id === state.agentModelRef.model && m.provider === state.agentModelRef.provider);
        await state.session.setModel(newModel);
      }
    }

    // Start a fresh session
    await ctx.newSession();
    ctx.ui.notify(`🔄 Switched to agent '${arg}'.`, "info");
  };

  // Build the extension object
  const extension: Extension = {
    path: "<beige-tui>",
    resolvedPath: "<beige-tui>",
    handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["session_switch", [async () => {
        agentsFilesRef.value = readWorkspaceAgentsMd(state.workspaceDir);
        if (state.session) {
          const toolNames = state.session.getActiveToolNames();
          (state.session as any)._baseSystemPrompt = (state.session as any)._rebuildSystemPrompt(toolNames);
          (state.session as any).agent.setSystemPrompt((state.session as any)._baseSystemPrompt);
        }
      }]],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map<string, RegisteredCommand>([
      ["beige-verbose", { name: "beige-verbose", description: "Toggle tool-call notifications: /beige-verbose on|off", handler: handleVerbose }],
      ["v", { name: "v", description: "Shorthand for /beige-verbose: /v on|off", handler: handleVerbose }],
      ["beige-sessions", { name: "beige-sessions", description: "List saved beige sessions for the current agent", handler: handleSessions }],
      ["beige-resume", { name: "beige-resume", description: "Resume a previous beige session: /beige-resume <number>", handler: handleResume }],
      ["beige-agent", { name: "beige-agent", description: "Switch to a different beige agent: /beige-agent <name>", handler: handleAgent }],
    ]),
    flags: new Map(),
    shortcuts: new Map(),
  };

  return { extensions: [extension], errors: [], runtime };
}

// ── Session listing helper ────────────────────────────────────────────────────

interface SessionEntry {
  file: string;
  timestamp: Date;
}

function listSessions(agentName: string): SessionEntry[] {
  const store = new BeigeSessionStore();
  return store.listSessions(agentName).map((info) => ({
    file: info.sessionFile,
    timestamp: new Date(info.createdAt),
  }));
}

// ── TUI tool-start handler ────────────────────────────────────────────────────

function makeTUIToolStartHandler(): OnToolStart {
  return (toolName: string, params: Record<string, unknown>) => {
    const label = formatToolCall(toolName, params);
    process.stderr.write(`\r🔧 ${label}\n`);
  };
}

function formatToolCall(toolName: string, params: Record<string, unknown>): string {
  switch (toolName) {
    case "exec": {
      const cmd = String(params.command ?? "");
      return `exec: ${cmd.length > 100 ? cmd.slice(0, 97) + "…" : cmd}`;
    }
    case "read": {
      return `read: ${params.path}`;
    }
    case "write": {
      const bytes = params.bytes != null ? ` (${params.bytes} bytes)` : "";
      return `write: ${params.path}${bytes}`;
    }
    case "patch": {
      return `patch: ${params.path}`;
    }
    default:
      return `${toolName}: ${JSON.stringify(params).slice(0, 100)}`;
  }
}

// ── Proxy core tools ──────────────────────────────────────────────────────────

function createProxyTools(
  getAgentName: () => string,
  gatewayUrl: string,
  handlerRef: { fn: OnToolStart | undefined }
): ToolDefinition[] {
  async function callGateway(
    tool: string,
    params: Record<string, any>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const res = await fetch(`${gatewayUrl}/api/agents/${encodeURIComponent(getAgentName())}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, params }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{ type: "text", text: `Gateway error (${res.status}): ${text}` }],
        isError: true,
      };
    }

    return (await res.json()) as any;
  }

  return [
    {
      name: "read",
      label: "Read File",
      description:
        "Read the contents of a file in the sandbox. Paths are relative to /workspace or absolute within the sandbox.",
      parameters: Type.Object({
        path: Type.String({ description: "File path to read" }),
        offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { path: string; offset?: number; limit?: number };
        handlerRef.fn?.("read", { path: p.path });
        const result = await callGateway("read", p as Record<string, any>);
        return { content: result.content as any, details: {}, isError: result.isError };
      },
    },
    {
      name: "write",
      label: "Write File",
      description: "Write content to a file in the sandbox. Creates parent directories if needed.",
      parameters: Type.Object({
        path: Type.String({ description: "File path to write" }),
        content: Type.String({ description: "Content to write to the file" }),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { path: string; content: string };
        handlerRef.fn?.("write", { path: p.path, bytes: Buffer.byteLength(p.content) });
        const result = await callGateway("write", p as Record<string, any>);
        return { content: result.content as any, details: {}, isError: result.isError };
      },
    },
    {
      name: "patch",
      label: "Patch File",
      description: "Apply a find-and-replace patch to a file in the sandbox. The oldText must match exactly.",
      parameters: Type.Object({
        path: Type.String({ description: "File path to patch" }),
        oldText: Type.String({ description: "Exact text to find and replace" }),
        newText: Type.String({ description: "New text to replace with" }),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { path: string; oldText: string; newText: string };
        handlerRef.fn?.("patch", { path: p.path });
        const result = await callGateway("patch", p as Record<string, any>);
        return { content: result.content as any, details: {}, isError: result.isError };
      },
    },
    {
      name: "exec",
      label: "Execute Command",
      description: "Execute a command in the sandbox. The command runs in /workspace by default.",
      parameters: Type.Object({
        command: Type.String({ description: "The command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 120)" })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { command: string; timeout?: number };
        handlerRef.fn?.("exec", { command: p.command });
        const result = await callGateway("exec", p as Record<string, any>);
        return { content: result.content as any, details: {}, isError: result.isError };
      },
    },
  ];
}
