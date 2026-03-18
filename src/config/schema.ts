/**
 * Beige configuration schema.
 *
 * Single source of truth: TypeBox schemas define the shape, TypeScript types
 * are derived with Static<>, and a JSON Schema is generated from the same
 * definitions via `pnpm run schema:generate`.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ── Primitive schemas ────────────────────────────────────────────────────────

const ModelRef = Type.Object(
  {
    provider: Type.String({ description: "Provider name — must match a key in llm.providers" }),
    model: Type.String({ description: "Model ID as the provider expects it" }),
    thinkingLevel: Type.Optional(
      Type.Union(
        [
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ],
        { description: "Extended thinking budget. Only affects models that support it." }
      )
    ),
  },
  { title: "ModelRef" }
);

const SandboxConfig = Type.Object(
  {
    image: Type.Optional(
      Type.String({ description: 'Docker image name. Default: "beige-sandbox:latest"' })
    ),
    extraMounts: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Additional host→container bind mounts. Reduces isolation — use carefully.",
      })
    ),
    extraEnv: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          "Environment variables passed to the container. Visible to the agent — never use for secrets.",
      })
    ),
  },
  { title: "SandboxConfig" }
);

const AgentConfig = Type.Object(
  {
    model: ModelRef,
    fallbackModels: Type.Optional(
      Type.Array(ModelRef, {
        description:
          "Fallback models tried in order when the primary model fails or is rate-limited",
      })
    ),
    tools: Type.Array(Type.String(), {
      description: "Tool names from the tools registry that this agent can invoke",
    }),
    skills: Type.Optional(
      Type.Array(Type.String(), {
        description: "Skill names from the skills registry mounted into this agent's sandbox",
      })
    ),
    workspaceDir: Type.Optional(
      Type.String({
        description:
          "Absolute or relative path (to config file) for the agent's workspace. Defaults to ~/.beige/agents/<agentName>/workspace/. Mounted at /workspace in sandbox.",
      })
    ),
    sandbox: Type.Optional(SandboxConfig),
  },
  { title: "AgentConfig" }
);

const LLMProviderConfig = Type.Object(
  {
    apiKey: Type.Optional(
      Type.String({
        description:
          'API key. Use "${VAR_NAME}" to read from environment. Not required for local providers (e.g. Ollama).',
      })
    ),
    baseUrl: Type.Optional(
      Type.String({
        description:
          "Custom API endpoint URL. Required for non-built-in providers (ZAI, Groq, Ollama, etc.).",
      })
    ),
    api: Type.Optional(
      Type.Union(
        [
          Type.Literal("anthropic-messages"),
          Type.Literal("openai-completions"),
          Type.Literal("openai-responses"),
          Type.Literal("google-generative-ai"),
        ],
        {
          description:
            'API protocol. Auto-set for built-in providers (anthropic, openai, google). Required for custom providers.',
        }
      )
    ),
  },
  { title: "LLMProviderConfig" }
);

const LLMConfig = Type.Object(
  {
    providers: Type.Record(Type.String(), LLMProviderConfig, {
      description:
        "Named LLM providers. Each key becomes a provider name agents can reference.",
    }),
  },
  { title: "LLMConfig" }
);

const ToolConfig = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the tool package directory. Resolved relative to the config file unless absolute.",
    }),
    target: Type.Union([Type.Literal("gateway"), Type.Literal("sandbox")], {
      description: '"gateway" runs the handler on the host process. "sandbox" is planned.',
    }),
    config: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Arbitrary config object passed to createHandler(config) at startup",
      })
    ),
    _toolkit: Type.Optional(
      Type.String({
        description: "Internal: set by the loader for tools auto-discovered from toolkits",
      })
    ),
  },
  { title: "ToolConfig" }
);

const SkillConfig = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the skill package directory. Resolved relative to the config file unless absolute.",
    }),
  },
  { title: "SkillConfig" }
);

const GatewayServerConfig = Type.Object(
  {
    host: Type.Optional(
      Type.String({ description: 'HTTP API bind address. Default: "127.0.0.1"' })
    ),
    port: Type.Optional(
      Type.Number({ description: "HTTP API port. Default: 7433" })
    ),
    logFile: Type.Optional(
      Type.String({
        description:
          "Daemon stdout/stderr log file. Default: ~/.beige/logs/gateway.log",
      })
    ),
  },
  { title: "GatewayServerConfig" }
);

const ChannelDefaultSettings = Type.Object(
  {
    verbose: Type.Optional(
      Type.Boolean({
        description:
          "Send a notification for every tool call the agent makes (e.g. 🔧 exec: ls). Default: false",
      })
    ),
    streaming: Type.Optional(
      Type.Boolean({
        description:
          "Stream responses to the user in real-time. Default: true",
      })
    ),
  },
  { title: "ChannelDefaultSettings" }
);

const TelegramChannelConfig = Type.Object(
  {
    enabled: Type.Boolean({ description: "Set to true to activate the Telegram bot" }),
    token: Type.String({
      description: 'Telegram bot token from @BotFather. Use "${TELEGRAM_BOT_TOKEN}".',
    }),
    allowedUsers: Type.Array(Type.Number(), {
      description:
        "Telegram user IDs permitted to interact with the bot. All others are silently ignored.",
    }),
    agentMapping: Type.Object(
      {
        default: Type.String({
          description: "Agent name that handles all incoming messages",
        }),
      },
      { description: "Maps Telegram chats to agents" }
    ),
    defaults: Type.Optional(ChannelDefaultSettings),
  },
  { title: "TelegramChannelConfig" }
);

const ChannelsConfig = Type.Object(
  {
    telegram: Type.Optional(TelegramChannelConfig),
  },
  { title: "ChannelsConfig" }
);

// ── Root schema ──────────────────────────────────────────────────────────────

export const BeigeConfigSchema = Type.Object(
  {
    llm: LLMConfig,
    tools: Type.Record(Type.String(), ToolConfig, {
      description: "Tool registry. Each key becomes the tool name used in agent configs and /tools/bin/.",
    }),
    skills: Type.Optional(
      Type.Record(Type.String(), SkillConfig, {
        description: "Skill registry. Each key becomes the skill name used in agent configs.",
      })
    ),
    agents: Type.Record(Type.String(), AgentConfig, {
      description:
        "Agent definitions. Each agent gets its own Docker sandbox, Unix socket, and LLM session.",
    }),
    gateway: Type.Optional(GatewayServerConfig),
    channels: Type.Optional(ChannelsConfig),
  },
  {
    title: "BeigeConfig",
    description: "Beige configuration file (config.json5). JSON5 format — comments and trailing commas are allowed.",
  }
);

// ── Derived TypeScript types (no change to callsites) ────────────────────────

export type BeigeConfig = Static<typeof BeigeConfigSchema>;
export type LLMProviderConfig = Static<typeof LLMProviderConfig>;
export type ToolConfig = Static<typeof ToolConfig>;
export type SkillConfig = Static<typeof SkillConfig>;
export type AgentConfig = Static<typeof AgentConfig>;
export type ModelRef = Static<typeof ModelRef>;
export type SandboxConfig = Static<typeof SandboxConfig>;
export type GatewayServerConfig = Static<typeof GatewayServerConfig>;
export type ChannelsConfig = Static<typeof ChannelsConfig>;
export type TelegramChannelConfig = Static<typeof TelegramChannelConfig>;
export type ChannelDefaultSettings = Static<typeof ChannelDefaultSettings>;

// ── Manifests (not part of config.json5, kept here for co-location) ──────────

export interface SkillManifest {
  name: string;
  description: string;
  /** Default: "README.md" */
  contextFile?: string;
  requires?: {
    tools?: string[];
    skills?: string[];
  };
}

export interface ToolManifest {
  name: string;
  description: string;
  commands?: string[];
  target: "gateway" | "sandbox";
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateConfig(config: unknown): BeigeConfig {
  // TypeBox structural check
  if (!Value.Check(BeigeConfigSchema, config)) {
    const errors = [...Value.Errors(BeigeConfigSchema, config)];
    const first = errors[0];
    throw new Error(
      `Config: ${first ? `${first.path} — ${first.message}` : "invalid configuration"}`
    );
  }

  const c = config as BeigeConfig;

  // Cross-reference checks TypeBox cannot express (references between keys)
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
    for (const skillName of agent.skills ?? []) {
      if (!c.skills?.[skillName]) {
        throw new Error(
          `Config: agent '${agentName}' references unknown skill '${skillName}'`
        );
      }
    }
  }

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
