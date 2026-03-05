import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { BeigeConfig, AgentConfig } from "../config/schema.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { AuditLogger } from "./audit.js";
import { createCoreTools } from "../tools/core.js";
import { buildToolContext, type LoadedTool } from "../tools/registry.js";

export interface ManagedAgent {
  name: string;
  session: AgentSession;
  config: AgentConfig;
}

/**
 * Manages agent sessions. Each agent gets:
 * - A pi SDK AgentSession with custom core tools
 * - A Docker sandbox container
 * - A Unix socket for tool routing
 */
export class AgentManager {
  private agents = new Map<string, ManagedAgent>();

  constructor(
    private config: BeigeConfig,
    private sandbox: SandboxManager,
    private audit: AuditLogger,
    private loadedTools: Map<string, LoadedTool>,
    private authStorage: AuthStorage,
    private modelRegistry: ModelRegistry
  ) {}

  /**
   * Initialize an agent: create sandbox, create pi session.
   */
  async initAgent(agentName: string): Promise<ManagedAgent> {
    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    // Check if already initialized
    const existing = this.agents.get(agentName);
    if (existing) return existing;

    console.log(`[AGENT] Initializing agent '${agentName}'...`);

    // Create core tools (they execute in the sandbox)
    const coreTools = createCoreTools(agentName, this.sandbox, this.audit);

    // Build system prompt with tool context
    const toolContext = buildToolContext(agentConfig.tools, this.loadedTools);
    const systemPrompt = buildSystemPrompt(agentName, toolContext);

    // Resolve model
    const model = this.resolveModel(agentConfig);

    // Create pi SDK session
    const loader = new DefaultResourceLoader({
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      model,
      thinkingLevel: (agentConfig.model.thinkingLevel as any) ?? "off",
      tools: [], // No built-in tools — we provide our own
      customTools: coreTools,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 3 },
      }),
      resourceLoader: loader,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    const managed: ManagedAgent = {
      name: agentName,
      session,
      config: agentConfig,
    };

    this.agents.set(agentName, managed);
    console.log(`[AGENT] Agent '${agentName}' ready`);

    return managed;
  }

  /**
   * Send a message to an agent and collect the full response.
   */
  async prompt(agentName: string, message: string): Promise<string> {
    const agent = await this.initAgent(agentName);

    return new Promise<string>((resolve, reject) => {
      let responseText = "";

      const unsubscribe = agent.session.subscribe((event) => {
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

      agent.session.prompt(message).catch((err) => {
        unsubscribe();
        reject(err);
      });
    });
  }

  /**
   * Send a message and stream deltas via callback.
   */
  async promptStreaming(
    agentName: string,
    message: string,
    onDelta: (delta: string) => void
  ): Promise<string> {
    const agent = await this.initAgent(agentName);

    return new Promise<string>((resolve, reject) => {
      let responseText = "";

      const unsubscribe = agent.session.subscribe((event) => {
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

      agent.session.prompt(message).catch((err) => {
        unsubscribe();
        reject(err);
      });
    });
  }

  getAgent(name: string): ManagedAgent | undefined {
    return this.agents.get(name);
  }

  async shutdown(): Promise<void> {
    for (const [name, agent] of this.agents) {
      agent.session.dispose();
    }
    this.agents.clear();
  }

  private resolveModel(agentConfig: AgentConfig) {
    const { provider, model: modelId } = agentConfig.model;
    // Try built-in models first
    const model = getModel(provider, modelId);
    if (model) return model;

    // Try model registry (custom models)
    const custom = this.modelRegistry.find(provider, modelId);
    if (custom) return custom;

    throw new Error(
      `Model not found: ${provider}/${modelId}. Check your config and API keys.`
    );
  }
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
