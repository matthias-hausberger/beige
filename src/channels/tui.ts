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
import { getModel } from "@mariozechner/pi-ai";
import { resolve, basename } from "path";
import { existsSync, mkdirSync } from "fs";
import { beigeDir } from "../paths.js";
import type { BeigeConfig, AgentConfig } from "../config/schema.js";
import type { OnToolStart } from "../gateway/agent-manager.js";
import { buildSystemPrompt, readWorkspaceAgentsMd } from "../gateway/agent-manager.js";
import { SessionSettingsStore, resolveSessionSetting } from "../gateway/session-settings.js";
import { BeigeSessionStore } from "../gateway/sessions.js";
import { loadSkills, validateSkillDeps, type LoadedSkill } from "../skills/registry.js";
import { RestrictedModelRegistry, buildAllowedModels } from "../config/restricted-model-registry.js";

/** Shape of an agent entry returned by the gateway's GET /api/agents endpoint. */
interface GatewayAgentInfo {
  name: string;
  tools: string[];
  skills: string[];
  toolContext: string;
  skillContext: string;
}

/**
 * TUI channel — runs in a separate process and connects to the gateway HTTP API.
 *
 * Architecture:
 * - The LLM session runs locally (pi InteractiveMode — full pi experience)
 * - Core tool execution (read/write/patch/exec) is proxied to the gateway API
 * - The gateway owns the sandboxes, audit, and policy enforcement
 *
 * This gives you the best of both worlds:
 * - Full pi TUI (editor, streaming, model switching, compaction, history)
 * - Sandboxed tool execution managed by the gateway
 *
 * Commands:
 * - /new                     — Start a fresh session (pi built-in, works correctly)
 * - /beige-resume [n]       — Resume a previous beige session
 * - /beige-sessions         — List saved beige sessions for the current agent
 * - /beige-agent [name]     — Switch to a different beige agent
 * - /beige-verbose on|off   — Toggle verbose tool-call notifications
 * - /v on|off               — Shorthand for /beige-verbose
 *
 * Note: Beige-specific commands use the "beige-" prefix to avoid conflicts
 * with pi built-ins. /new is pi's built-in command which resets the session
 * in-place — this is the correct approach (creating a new AgentSession would
 * leave InteractiveMode with a stale reference).
 */

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7433";

export interface TUIOptions {
  config: BeigeConfig;
  agentName: string;
  gatewayUrl?: string;
}

/**
 * Mutable state shared between the TUI and extension commands.
 */
interface TUIState {
  agentName: string;
  agentConfig: AgentConfig;
  session: AgentSession | null;
  toolStartHandlerRef: { fn: OnToolStart | undefined };
  gatewayUrl: string;
  config: BeigeConfig;
  authStorage: AuthStorage;
  /** Restricted registry that only exposes models allowed for this agent */
  modelRegistry: RestrictedModelRegistry;
  /** Underlying unrestricted registry for internal lookups */
  underlyingModelRegistry: ModelRegistry;
  settingsStore: SessionSettingsStore;
  sessionStore: BeigeSessionStore;
  loadedSkills: Map<string, LoadedSkill>;
}

export async function launchTUI(opts: TUIOptions): Promise<void> {
  const { config } = opts;
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

  // ── Auth (LLM keys — session runs locally) ────────────────
  // Use beige's own auth/models files so credentials are isolated from pi's
  // ~/.pi/agent/auth.json.  /login and /logout persist to ~/.beige/auth.json.
  const beigeAuthPath = resolve(beigeDir(), "auth.json");
  const beigeModelsPath = resolve(beigeDir(), "models.json");
  const authStorage = AuthStorage.create(beigeAuthPath);
  for (const [provider, providerConfig] of Object.entries(config.llm.providers)) {
    if (providerConfig.apiKey) {
      authStorage.setRuntimeApiKey(provider, providerConfig.apiKey);
    }
  }
  const modelRegistry = new ModelRegistry(authStorage, beigeModelsPath);

  // Register custom providers from config (baseUrl, api overrides)
  for (const [provider, providerConfig] of Object.entries(config.llm.providers)) {
    if (providerConfig.baseUrl || providerConfig.api) {
      modelRegistry.registerProvider(provider, {
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        api: providerConfig.api as any,
      });
    }
  }

  // ── Load skills ────────────────────────────────────────────
  const loadedSkills = await loadSkills(config);

  // ── Create restricted model registry ──────────────────────
  // The agent can only use models defined in its config (model + fallbackModels)
  const agentConfig = config.agents[agentName];
  const allowedModels = buildAllowedModels(agentConfig.model, agentConfig.fallbackModels);
  const restrictedModelRegistry = new RestrictedModelRegistry(modelRegistry, allowedModels);

  // ── Shared state ──────────────────────────────────────────
  const settingsStore = new SessionSettingsStore();
  const sessionStore = new BeigeSessionStore();
  const toolStartHandlerRef: { fn: OnToolStart | undefined } = { fn: undefined };

  const state: TUIState = {
    agentName,
    agentConfig,
    session: null,
    toolStartHandlerRef,
    gatewayUrl,
    config,
    authStorage,
    modelRegistry: restrictedModelRegistry,
    underlyingModelRegistry: modelRegistry,
    settingsStore,
    sessionStore,
    loadedSkills,
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
  // systemPromptRef and agentsFilesRef are shared mutable refs read by the
  // resource loader.  They are updated by /beige-agent (switch agent) and by
  // the session_switch handler (re-read AGENTS.md after /new).
  const systemPromptRef: { value: string } = { value: "" };
  const agentsFilesRef: { value: Array<{ path: string; content: string }> } = { value: [] };
  const extensionsResult = await buildBeigeExtension(state, agentNames, systemPromptRef, agentsFilesRef);
  await createSession(state, extensionsResult, systemPromptRef, agentsFilesRef);

  if (!state.session) {
    console.error("[TUI] Failed to create initial session");
    process.exit(1);
  }

  // ── Launch pi TUI ─────────────────────────────────────────
  console.log(`[TUI] Agent: ${agentName} (${state.agentConfig.model.provider}/${state.agentConfig.model.model})`);

  // Show allowed models (for model switching)
  const availableModels = state.modelRegistry.getAvailable();
  if (availableModels.length > 1) {
    const modelList = availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
    console.log(`[TUI] Allowed models: ${modelList}`);
  }

  console.log(`[TUI] Tools: ${agentInfo.tools.join(", ") || "(core only)"}`);
  console.log(`[TUI] Verbose: ${initialVerbose ? "on" : "off"} — use /beige-verbose on|off to toggle`);
  console.log(`[TUI] Commands: /new, /beige-resume, /beige-sessions, /beige-agent <name>, /beige-verbose on|off (or /v on|off)`);

  // Suppress pi's "update available" banner — beige manages its own update lifecycle.
  process.env.PI_SKIP_VERSION_CHECK = "1";

  const mode = new InteractiveMode(state.session, {});
  await mode.run();
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
  const { agentName, agentConfig, gatewayUrl, authStorage, modelRegistry, underlyingModelRegistry, toolStartHandlerRef, loadedSkills } = state;

  // Fetch agent info from gateway
  const agentsRes = await fetch(`${gatewayUrl}/api/agents`);
  const { agents } = (await agentsRes.json()) as { agents: GatewayAgentInfo[] };
  const agentInfo = agents.find((a) => a.name === agentName);
  const toolNames = agentInfo?.tools ?? [];
  const skillNames = agentInfo?.skills ?? [];

  // Validate skill dependencies
  validateSkillDeps(skillNames, toolNames, loadedSkills);

  // Use underlying registry for model lookup (restricted registry delegates find())
  const model = resolveModel(agentConfig, underlyingModelRegistry);
  // Pass a getter so tool calls always route to the currently-active agent,
  // even after /beige-agent switches state.agentName.
  const coreTools = createProxyTools(() => state.agentName, gatewayUrl, toolStartHandlerRef);

  // Use pre-built tool/skill context from the gateway (which has full tool manifests).
  const toolContext = agentInfo?.toolContext ?? "";
  const skillContext = agentInfo?.skillContext ?? "";

  // Populate the shared mutable ref with the initial system prompt.
  systemPromptRef.value = buildSystemPrompt(agentName, toolContext, skillContext);

  // Read workspace AGENTS.md so it's injected into the system prompt context.
  const agentDir = resolve(beigeDir(), "agents", agentName);
  const workspaceDir = agentConfig.workspaceDir ?? resolve(agentDir, "workspace");
  agentsFilesRef.value = readWorkspaceAgentsMd(workspaceDir);

  const sessionsDir = resolve(beigeDir(), "sessions", agentName);
  // Always start a fresh session. Users can resume via /beige-resume.
  const sessionManager = SessionManager.create(process.cwd(), sessionsDir);

  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: agentsFilesRef.value }),
    // Read from mutable ref so updates from /beige-agent are reflected.
    getSystemPrompt: () => systemPromptRef.value,
    getAppendSystemPrompt: () => [],
    getPathMetadata: () => new Map(),
    extendResources: () => {},
    reload: async () => {},
  };

  const { session } = await createAgentSession({
    model,
    thinkingLevel: (agentConfig.model.thinkingLevel as any) ?? "off",
    tools: [],
    customTools: coreTools,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3 },
    }),
    resourceLoader,
    authStorage,
    // Pass underlying registry for session creation
    modelRegistry: modelRegistry.getUnderlying(),
  });

  // Replace the session's modelRegistry with our restricted version
  // This ensures the TUI's model switcher only shows allowed models
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
        // Show list if no arg provided
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

    // Delegate to the pi SDK's switchSession(), which loads the session
    // file into the existing AgentSession and re-renders the chat UI.
    // This avoids a stale-session-reference bug where InteractiveMode's
    // internal this.session would still point to the old disposed session.
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

    // Switch to new agent
    const newAgentConfig = state.config.agents[arg];
    if (!newAgentConfig) {
      ctx.ui.notify(`Agent '${arg}' not found in config.`, "error");
      return;
    }

    // Update state fields — proxy tools and resource loader read these dynamically.
    state.agentName = arg;
    state.agentConfig = newAgentConfig;

    // Update restricted model registry for new agent's allowed models.
    const allowedModels = buildAllowedModels(newAgentConfig.model, newAgentConfig.fallbackModels);
    state.modelRegistry = new RestrictedModelRegistry(state.underlyingModelRegistry, allowedModels);
    if (state.session) {
      (state.session as any)._modelRegistry = state.modelRegistry;
    }

    // Rebuild the system prompt for the new agent and push it into both the
    // shared ref (read by resourceLoader.getSystemPrompt() on future rebuilds)
    // and the session's cached _baseSystemPrompt (used before every LLM call).
    const agentsRes = await fetch(`${state.gatewayUrl}/api/agents`);
    const { agents } = (await agentsRes.json()) as { agents: GatewayAgentInfo[] };
    const agentInfo = agents.find((a) => a.name === arg);
    // Use pre-built tool/skill context from the gateway (which has full tool manifests).
    const toolContext = agentInfo?.toolContext ?? "";
    const skillContext = agentInfo?.skillContext ?? "";
    const newSystemPrompt = buildSystemPrompt(arg, toolContext, skillContext);
    systemPromptRef.value = newSystemPrompt;

    // Update agents files for the new agent's workspace.
    const newAgentDir = resolve(beigeDir(), "agents", arg);
    const newWorkspaceDir = newAgentConfig.workspaceDir ?? resolve(newAgentDir, "workspace");
    agentsFilesRef.value = readWorkspaceAgentsMd(newWorkspaceDir);

    if (state.session) {
      // Trigger a full rebuild so pi's buildSystemPrompt picks up both the
      // updated system prompt ref AND the fresh AGENTS.md from getAgentsFiles().
      const toolNames = state.session.getActiveToolNames();
      (state.session as any)._baseSystemPrompt = (state.session as any)._rebuildSystemPrompt(toolNames);
      (state.session as any).agent.setSystemPrompt((state.session as any)._baseSystemPrompt);
    }

    // Update verbose handler for new session key.
    const sessionKey = BeigeSessionStore.tuiKey(arg);
    const verbose = resolveSessionSetting(
      "verbose",
      false,
      undefined,
      state.settingsStore.get(sessionKey, "verbose")
    );
    state.toolStartHandlerRef.fn = verbose ? makeTUIToolStartHandler() : undefined;

    // Point the SessionManager at the new agent's session directory so that
    // ctx.newSession() creates the .jsonl file under ~/.beige/sessions/<new-agent>/
    // instead of the original agent's directory.
    if (state.session) {
      const newSessionsDir = resolve(beigeDir(), "sessions", arg);
      mkdirSync(newSessionsDir, { recursive: true });
      (state.session.sessionManager as any).sessionDir = newSessionsDir;
    }

    // Switch to the new agent's configured model so the fresh session doesn't
    // inherit the previous agent's model.  setModel() validates the API key
    // via the (already-updated) restricted model registry, records a model
    // change event in the session journal, and re-clamps the thinking level.
    if (state.session) {
      const newModel = resolveModel(newAgentConfig, state.modelRegistry);
      await state.session.setModel(newModel);
    }

    // Start a fresh session in the new agent's session directory.
    // ctx.newSession() resets the existing AgentSession in-place (no new
    // instance), so InteractiveMode's internal reference stays valid.
    await ctx.newSession();
    ctx.ui.notify(`🔄 Switched to agent '${arg}'.`, "info");
  };

  // Build the extension object
  const extension: Extension = {
    path: "<beige-tui>",
    resolvedPath: "<beige-tui>",
    handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      // Re-read AGENTS.md on /new and session switches so that edits the
      // agent made during the previous session are picked up.
      ["session_switch", [async () => {
        const dir = resolve(beigeDir(), "agents", state.agentName);
        const ws = state.agentConfig.workspaceDir ?? resolve(dir, "workspace");
        agentsFilesRef.value = readWorkspaceAgentsMd(ws);
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

/**
 * List human-initiated sessions for an agent, sorted newest-first.
 *
 * Delegates to BeigeSessionStore.listSessions() so that sessions created
 * by toolkit tools (e.g. agent-to-agent sub-agent sessions, which carry
 * metadata.depth > 0) are automatically excluded.  Only sessions the user
 * started directly appear in /beige-sessions and /beige-resume.
 */
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveModel(agentConfig: AgentConfig, modelRegistry: ModelRegistry | RestrictedModelRegistry) {
  const { provider, model: modelId } = agentConfig.model;
  // Prefer ModelRegistry.find() over the static getModel() because the registry
  // applies OAuth provider transformations (e.g. modifyModels) that update baseUrl.
  // For GitHub Copilot business subscriptions, the OAuth provider rewrites baseUrl
  // from api.individual.githubcopilot.com → api.business.githubcopilot.com based
  // on the proxy-ep in the access token. Using the static getModel() would return
  // the unmodified built-in model with the wrong baseUrl, causing 421 Misdirected
  // Request errors.
  const registryModel = modelRegistry.find(provider, modelId);
  if (registryModel) return registryModel;
  const model = getModel(provider as any, modelId);
  if (model) return model;
  throw new Error(`Model not found: ${provider}/${modelId}`);
}
