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
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { resolve } from "path";
import { homedir } from "os";
import type { BeigeConfig, AgentConfig } from "../config/schema.js";
import type { OnToolStart } from "../gateway/agent-manager.js";
import { SessionSettingsStore, resolveSessionSetting } from "../gateway/session-settings.js";
import { BeigeSessionStore } from "../gateway/sessions.js";

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
 * Session settings:
 * - /v on|off  or  /verbose on|off  — toggle verbose tool-call notifications
 * - Settings are persisted per-session in ~/.beige/sessions/session-settings.json
 */

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7433";

export interface TUIOptions {
  config: BeigeConfig;
  agentName: string;
  gatewayUrl?: string;
}

export async function launchTUI(opts: TUIOptions): Promise<void> {
  const { config, agentName } = opts;
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

  // Verify agent exists
  const agentsRes = await fetch(`${gatewayUrl}/api/agents`);
  const { agents } = (await agentsRes.json()) as { agents: Array<{ name: string; tools: string[] }> };
  const agentInfo = agents.find((a) => a.name === agentName);
  if (!agentInfo) {
    console.error(
      `[TUI] Unknown agent '${agentName}'. Available: ${agents.map((a) => a.name).join(", ")}`
    );
    process.exit(1);
  }

  const agentConfig = config.agents[agentName];

  // ── Auth (LLM keys — session runs locally) ────────────────
  const authStorage = AuthStorage.create();
  for (const [provider, providerConfig] of Object.entries(config.llm.providers)) {
    if (providerConfig.apiKey) {
      authStorage.setRuntimeApiKey(provider, providerConfig.apiKey);
    }
  }
  const modelRegistry = new ModelRegistry(authStorage);
  const model = resolveModel(agentConfig, modelRegistry);

  // ── Session settings (verbose mode etc.) ──────────────────
  const settingsStore = new SessionSettingsStore();
  const sessionKey = BeigeSessionStore.tuiKey(agentName);

  // Mutable ref shared with tool proxies so we can toggle at runtime
  const toolStartHandlerRef: { fn: OnToolStart | undefined } = { fn: undefined };

  // Wire initial verbose state from settings store
  const initialVerbose = resolveSessionSetting(
    "verbose",
    false,
    undefined,  // TUI has no channel-level config defaults (no telegram-style config)
    settingsStore.get(sessionKey, "verbose")
  );
  if (initialVerbose) {
    toolStartHandlerRef.fn = makeTUIToolStartHandler();
  }

  // ── Core tools that proxy to gateway API ──────────────────
  const coreTools = createProxyTools(agentName, gatewayUrl, toolStartHandlerRef);

  // ── System prompt ─────────────────────────────────────────
  const toolContext = await fetchToolContext(gatewayUrl, agentName, agentInfo.tools);
  const systemPrompt = buildSystemPrompt(agentName, toolContext);

  // ── Session persistence ───────────────────────────────────
  const sessionsDir = resolve(homedir(), ".beige", "sessions", agentName);
  let sessionManager: ReturnType<typeof SessionManager.create>;
  try {
    sessionManager = SessionManager.continueRecent(process.cwd(), sessionsDir);
  } catch {
    sessionManager = SessionManager.create(process.cwd(), sessionsDir);
  }

  // ── Beige extension (registers /v and /verbose commands) ──
  const extensionsResult = await buildBeigeExtension(
    sessionKey,
    settingsStore,
    toolStartHandlerRef
  );

  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    getPathMetadata: () => new Map(),
    extendResources: () => {},
    reload: async () => {},
  };

  // ── Create pi session ─────────────────────────────────────
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
    modelRegistry,
  });

  // ── Launch pi TUI ─────────────────────────────────────────
  console.log(`[TUI] Agent: ${agentName} (${agentConfig.model.provider}/${agentConfig.model.model})`);
  console.log(`[TUI] Tools: ${agentInfo.tools.join(", ") || "(core only)"}`);
  console.log(`[TUI] Verbose: ${initialVerbose ? "on" : "off"} — use /verbose on|off to toggle`);

  const mode = new InteractiveMode(session, {});
  await mode.run();
}

// ── Beige extension factory ───────────────────────────────────────────────────

/**
 * Build the inline "beige" extension that registers /v and /verbose commands
 * for toggling verbose mode from within the TUI.
 *
 * Commands are intercepted by InteractiveMode before being sent to the LLM.
 */
async function buildBeigeExtension(
  sessionKey: string,
  settingsStore: SessionSettingsStore,
  toolStartHandlerRef: { fn: OnToolStart | undefined }
): Promise<LoadExtensionsResult> {
  const runtime = createExtensionRuntime();

  // Command handler shared by /verbose and /v
  const handleVerbose = async (args: string, ctx: any) => {
    const arg = args.trim().toLowerCase();

    if (!arg || (arg !== "on" && arg !== "off")) {
      const current = settingsStore.get(sessionKey, "verbose") ?? false;
      ctx.ui.notify(
        `Verbose mode is currently ${current ? "ON" : "OFF"}. Usage: /verbose on|off`,
        "info"
      );
      return;
    }

    const enable = arg === "on";
    settingsStore.set(sessionKey, "verbose", enable);

    // Mutate the shared ref — all proxy tool closures pick up immediately
    toolStartHandlerRef.fn = enable ? makeTUIToolStartHandler() : undefined;

    ctx.ui.notify(
      enable
        ? "🔊 Verbose mode ON — tool calls will be shown as they execute."
        : "🔇 Verbose mode OFF — tool calls are hidden.",
      "info"
    );
  };

  // Build the extension object manually (loadExtensionFromFactory is not exported)
  const extension: Extension = {
    path: "<beige-tui>",
    resolvedPath: "<beige-tui>",
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map<string, RegisteredCommand>([
      ["verbose", {
        name: "verbose",
        description: "Toggle tool-call notifications: /verbose on|off",
        handler: handleVerbose,
      }],
      ["v", {
        name: "v",
        description: "Shorthand for /verbose: /v on|off",
        handler: handleVerbose,
      },
    ]]),
    flags: new Map(),
    shortcuts: new Map(),
  };

  return {
    extensions: [extension],
    errors: [],
    runtime,
  };
}

// ── TUI tool-start handler ────────────────────────────────────────────────────

/**
 * When verbose mode is ON in the TUI, print tool calls to stdout.
 * This integrates with the pi TUI's existing output (the TUI captures stdout).
 */
function makeTUIToolStartHandler(): OnToolStart {
  return (toolName: string, params: Record<string, unknown>) => {
    const label = formatToolCall(toolName, params);
    // Write directly to stderr so it doesn't interfere with TUI rendering
    // The TUI renders on stdout; stderr messages appear above the TUI frame.
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
  agentName: string,
  gatewayUrl: string,
  handlerRef: { fn: OnToolStart | undefined }
): ToolDefinition[] {
  async function callGateway(
    tool: string,
    params: Record<string, any>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const res = await fetch(`${gatewayUrl}/api/agents/${encodeURIComponent(agentName)}/exec`, {
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
      description:
        "Write content to a file in the sandbox. Creates parent directories if needed.",
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
      description:
        "Apply a find-and-replace patch to a file in the sandbox. The oldText must match exactly.",
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
      description:
        "Execute a command in the sandbox. The command runs in /workspace by default.",
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

async function fetchToolContext(
  gatewayUrl: string,
  agentName: string,
  toolNames: string[]
): Promise<string> {
  if (toolNames.length === 0) return "";

  const lines = [
    "## Available Tools",
    "",
    "The following tools are available via `/tools/bin/` in the sandbox:",
    "",
  ];

  for (const name of toolNames) {
    lines.push(`- **${name}** — run with \`exec: /tools/bin/${name} <args>\``);
  }

  lines.push("");
  lines.push("Read tool documentation: `exec: cat /tools/packages/<name>/README.md`");
  return lines.join("\n");
}

function buildSystemPrompt(agentName: string, toolContext: string): string {
  return `You are an AI agent named "${agentName}" running inside a secure sandbox managed by the Beige agent system.

## Environment

- You run inside a Docker container with a writable workspace at \`/workspace\`.
- You have 4 core tools: \`read\`, \`write\`, \`patch\`, and \`exec\`.
- Additional tools are available as executables in \`/tools/bin/\`. Run them with \`exec\`.
- Tool documentation is available in \`/tools/packages/<name>/\`.
- Your working directory is \`/workspace\`. Files you create persist here.
- You can write and execute scripts (TypeScript via Deno, shell scripts, Python, etc.).

## How to Use Tools

To call a tool, use the \`exec\` core tool:
\`\`\`
exec: /tools/bin/<tool-name> <args...>
\`\`\`

To write and run a script:
1. Use \`write\` to create a script file in \`/workspace\`
2. Use \`exec\` to run it (e.g., \`exec deno run --allow-all /workspace/script.ts\`)

Scripts can call tools by executing \`/tools/bin/<tool-name>\` as subprocesses.

${toolContext}

## Guidelines

- Be helpful and proactive.
- When tasks require multiple steps, write scripts to chain tool calls.
- If you're unsure about a tool, read its documentation in \`/tools/packages/<name>/\`.
- Always handle errors gracefully.
`;
}

function resolveModel(agentConfig: AgentConfig, modelRegistry: ModelRegistry) {
  const { provider, model: modelId } = agentConfig.model;
  const model = getModel(provider as any, modelId);
  if (model) return model;
  const custom = modelRegistry.find(provider, modelId);
  if (custom) return custom;
  throw new Error(`Model not found: ${provider}/${modelId}`);
}
