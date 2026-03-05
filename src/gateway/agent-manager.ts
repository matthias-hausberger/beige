import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createExtensionRuntime,
  type AgentSession,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { BeigeConfig, AgentConfig } from "../config/schema.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { AuditLogger } from "./audit.js";
import type { BeigeSessionStore } from "./sessions.js";
import { createCoreTools } from "../tools/core.js";
import { buildToolContext, type LoadedTool } from "../tools/registry.js";

export interface ManagedSession {
  agentName: string;
  sessionKey: string;
  session: AgentSession;
}

/**
 * Manages agent sessions. Supports multiple concurrent sessions per agent
 * (e.g. one per Telegram chat/thread).
 *
 * Each agent has one sandbox + socket. Sessions share the sandbox but have
 * independent conversation histories.
 */
export class AgentManager {
  /** sessionKey → ManagedSession */
  private sessions = new Map<string, ManagedSession>();

  constructor(
    private config: BeigeConfig,
    private sandbox: SandboxManager,
    private audit: AuditLogger,
    private loadedTools: Map<string, LoadedTool>,
    private authStorage: AuthStorage,
    private modelRegistry: ModelRegistry,
    private sessionStore: BeigeSessionStore
  ) {}

  /**
   * Get or create a session for a given key.
   *
   * @param sessionKey  Unique key (e.g. "telegram:123:456" or "tui:assistant:default")
   * @param agentName   Which agent to use
   * @param opts.forceNew  If true, always create a new session (for /new command)
   * @param opts.sessionFile  If set, open this specific session file (for /resume)
   */
  async getOrCreateSession(
    sessionKey: string,
    agentName: string,
    opts?: { forceNew?: boolean; sessionFile?: string }
  ): Promise<ManagedSession> {
    // If forceNew, dispose old session and create fresh
    if (opts?.forceNew) {
      await this.disposeSession(sessionKey);
    }

    // Return cached session if it exists
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    // Determine session file
    let sessionFile: string | undefined;
    if (opts?.sessionFile) {
      sessionFile = opts.sessionFile;
    } else if (!opts?.forceNew) {
      sessionFile = this.sessionStore.getSessionFile(sessionKey);
    }

    // Create new session file if none exists
    if (!sessionFile) {
      sessionFile = this.sessionStore.createSession(sessionKey, agentName);
    }

    console.log(`[AGENT] Creating session for '${agentName}' (key: ${sessionKey})`);

    // Build pi session
    const coreTools = createCoreTools(agentName, this.sandbox, this.audit);
    const toolContext = buildToolContext(agentConfig.tools, this.loadedTools);
    const systemPrompt = buildSystemPrompt(agentName, toolContext);

    const model = this.resolveModel(agentConfig);

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
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

    // Use file-based session manager for persistence
    let sessionManager: ReturnType<typeof SessionManager.create>;
    try {
      sessionManager = SessionManager.open(sessionFile);
    } catch {
      // File doesn't exist yet or is empty — create new
      const { dir } = await import("path").then((p) => ({ dir: p.dirname(sessionFile!) }));
      sessionManager = SessionManager.create(process.cwd(), dir);
    }

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
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    const managed: ManagedSession = {
      agentName,
      sessionKey,
      session,
    };

    this.sessions.set(sessionKey, managed);
    console.log(`[AGENT] Session ready for '${agentName}' (key: ${sessionKey})`);

    return managed;
  }

  /**
   * Send a message to a session and collect the full response.
   */
  async prompt(sessionKey: string, agentName: string, message: string): Promise<string> {
    const managed = await this.getOrCreateSession(sessionKey, agentName);

    return new Promise<string>((resolve, reject) => {
      let responseText = "";

      const unsubscribe = managed.session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          responseText += event.assistantMessageEvent.delta;
        }

        if (event.type === "agent_end") {
          unsubscribe();
          resolve(responseText);
        }
      });

      managed.session.prompt(message).catch((err) => {
        unsubscribe();
        reject(err);
      });
    });
  }

  /**
   * Send a message and stream deltas via callback.
   */
  async promptStreaming(
    sessionKey: string,
    agentName: string,
    message: string,
    onDelta: (delta: string) => void
  ): Promise<string> {
    const managed = await this.getOrCreateSession(sessionKey, agentName);

    return new Promise<string>((resolve, reject) => {
      let responseText = "";

      const unsubscribe = managed.session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          const delta = event.assistantMessageEvent.delta;
          responseText += delta;
          onDelta(delta);
        }

        if (event.type === "agent_end") {
          unsubscribe();
          resolve(responseText);
        }
      });

      managed.session.prompt(message).catch((err) => {
        unsubscribe();
        reject(err);
      });
    });
  }

  /**
   * Start a new session for a key (disposes old one).
   */
  async newSession(sessionKey: string, agentName: string): Promise<ManagedSession> {
    // Reset in session store — creates new file, keeps old one
    this.sessionStore.resetSession(sessionKey, agentName);
    return this.getOrCreateSession(sessionKey, agentName, { forceNew: true });
  }

  /**
   * Dispose a specific session.
   */
  async disposeSession(sessionKey: string): Promise<void> {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.session.dispose();
      this.sessions.delete(sessionKey);
    }
  }

  /**
   * Dispose all sessions.
   */
  async shutdown(): Promise<void> {
    for (const [, managed] of this.sessions) {
      managed.session.dispose();
    }
    this.sessions.clear();
  }

  private resolveModel(agentConfig: AgentConfig) {
    const { provider, model: modelId } = agentConfig.model;
    const model = getModel(provider, modelId);
    if (model) return model;
    const custom = this.modelRegistry.find(provider, modelId);
    if (custom) return custom;
    throw new Error(`Model not found: ${provider}/${modelId}. Check your config and API keys.`);
  }
}

export function buildSystemPrompt(agentName: string, toolContext: string): string {
  return `You are an AI agent named "${agentName}" running inside a secure sandbox managed by the Beige agent system.

## Environment

- You run inside a Docker container with a writable workspace at \`/workspace\`.
- You have 4 core tools: \`read\`, \`write\`, \`patch\`, and \`exec\`.
- Additional tools are available as executables in \`/tools/bin/\`. Run them with \`exec\`.
- Tool documentation is available in \`/tools/packages/<name>/\`.
- Your working directory is \`/workspace\`. Files you create persist here.
- You can write and execute scripts (TypeScript via Deno, shell scripts, Python, etc.).
- Your AGENTS.md file is at \`/workspace/AGENTS.md\`. You can read and modify it.

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
