/**
 * Beige configuration schema.
 * Config is loaded from a YAML file. Environment variables are resolved at load time.
 */

export interface BeigeConfig {
  llm: LLMConfig;
  tools: Record<string, ToolConfig>;
  agents: Record<string, AgentConfig>;
  gateway?: GatewayServerConfig;
  channels: ChannelsConfig;
}

export interface LLMConfig {
  providers: Record<string, LLMProviderConfig>;
}

export interface LLMProviderConfig {
  apiKey: string;
  baseUrl?: string;
  api?: string; // "anthropic-messages" | "openai-completions" | etc.
}

export interface ToolConfig {
  /** Path to the tool package directory (relative to config file) */
  path: string;
  /** Where the tool handler executes */
  target: "gateway" | "sandbox";
  /** Arbitrary tool-specific configuration */
  config?: Record<string, unknown>;
}

export interface AgentConfig {
  model: ModelRef;
  fallbackModels?: ModelRef[];
  /** List of tool names from the tools registry that this agent can use */
  tools: string[];
  sandbox?: SandboxConfig;
}

export interface ModelRef {
  provider: string;
  model: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
}

export interface SandboxConfig {
  image?: string; // Docker image, defaults to "beige-sandbox:latest"
  extraMounts?: Record<string, string>; // host:container
  extraEnv?: Record<string, string>;
}

export interface GatewayServerConfig {
  host?: string;     // default: "127.0.0.1"
  port?: number;     // default: 7433
  logFile?: string;  // default: ~/.beige/logs/gateway.log
}

export interface ChannelsConfig {
  telegram?: TelegramChannelConfig;
}

/**
 * Channel-level default settings. These can be overridden per-session
 * by the user (e.g. via Telegram commands or TUI slash commands).
 */
export interface ChannelDefaultSettings {
  /**
   * If true, the channel is notified whenever the agent calls a tool
   * (e.g. "🔧 exec: ls -la"). Default: false.
   */
  verbose?: boolean;
}

export interface TelegramChannelConfig {
  enabled: boolean;
  token: string;
  allowedUsers: number[];
  agentMapping: {
    default: string;
    // future: per-chat routing
  };
  /** Channel-level setting defaults (overridable per-session). */
  defaults?: ChannelDefaultSettings;
}

// ---

export interface ToolManifest {
  name: string;
  description: string;
  commands?: string[];
  target: "gateway" | "sandbox";
}

export function validateConfig(config: unknown): BeigeConfig {
  const c = config as BeigeConfig;

  if (!c.llm?.providers || typeof c.llm.providers !== "object") {
    throw new Error("Config: llm.providers is required");
  }
  if (!c.tools || typeof c.tools !== "object") {
    throw new Error("Config: tools is required");
  }
  if (!c.agents || typeof c.agents !== "object") {
    throw new Error("Config: agents is required");
  }

  // Validate agent tool references
  for (const [agentName, agent] of Object.entries(c.agents)) {
    if (!agent.model?.provider || !agent.model?.model) {
      throw new Error(`Config: agents.${agentName}.model requires provider and model`);
    }
    for (const toolName of agent.tools) {
      if (!c.tools[toolName]) {
        throw new Error(
          `Config: agent '${agentName}' references unknown tool '${toolName}'`
        );
      }
    }
  }

  // Validate channel agent references
  if (c.channels?.telegram?.enabled) {
    const defaultAgent = c.channels.telegram.agentMapping?.default;
    if (defaultAgent && !c.agents[defaultAgent]) {
      throw new Error(
        `Config: telegram.agentMapping.default references unknown agent '${defaultAgent}'`
      );
    }
  }

  return c;
}
