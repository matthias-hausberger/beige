/**
 * Plugin system types.
 *
 * This file defines the core interfaces that plugins implement and the gateway
 * uses to load, register, and interact with plugins.
 *
 * Plugins are the single unit of extension in Beige. A plugin can:
 * - Register tools available to agents
 * - Register a channel adapter (for receiving/sending messages)
 * - Register hooks into the session/gateway lifecycle
 * - Register skills mounted into agent sandboxes
 * - Run background processes (via start/stop lifecycle)
 */

import type { SessionContext } from "../types/session.js";

// ── Plugin Manifest (plugin.json) ────────────────────────────────────────────

/**
 * Declarative manifest describing what a plugin provides.
 * Read from plugin.json in the plugin package directory.
 */
export interface PluginManifest {
  /** Plugin identifier. Must be unique across all plugins. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** What this plugin provides (declarative, for validation + introspection). */
  provides?: {
    /** Whether this plugin registers a channel adapter. */
    channel?: boolean;
    /** Tool names this plugin registers. Must start with the plugin name. */
    tools?: string[];
    /** Hook names this plugin registers. */
    hooks?: string[];
    /** Skill names this plugin registers. */
    skills?: string[];
  };
  /** JSON Schema for plugin config validation. */
  configSchema?: Record<string, unknown>;
  /**
   * Default config template with placeholder values.
   * Used by `beige plugins install` to populate config.json5 entries.
   * Placeholder values like "<YOUR_API_KEY>" signal to the user what to fill in.
   */
  defaultConfig?: Record<string, unknown>;
  /**
   * CLI commands this plugin exposes.
   * Listed in the system prompt so agents know how to call the tool.
   */
  commands?: string[];
}

// ── Tool types ───────────────────────────────────────────────────────────────

export interface ToolResult {
  output: string;
  exitCode: number;
}

/**
 * A tool registered by a plugin.
 *
 * Tool names must start with the plugin name:
 * - Single-tool plugin "git" → tool name "git"
 * - Multi-tool plugin "slack" → tool names "slack.send_message", etc.
 */
export interface PluginTool {
  /** Tool name. Must equal or start with `pluginName.` */
  name: string;
  /** Short description (included in system prompt). */
  description: string;
  /** Usage hints shown in the system prompt. */
  commands?: string[];
  /** The handler function called when the tool is invoked. */
  handler: ToolHandler;
}

export type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: SessionContext
) => Promise<ToolResult>;

// ── Channel types ────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  parseMode?: "html" | "markdown";
}

/**
 * A channel adapter registered by a plugin.
 * Channels can send messages back to users.
 */
export interface ChannelAdapter {
  /** Send a message to a specific chat/thread. */
  sendMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
    options?: SendMessageOptions
  ): Promise<void>;

  /** Whether this channel supports sending proactive messages. */
  supportsMessaging(): boolean;
}

// ── Skill types ──────────────────────────────────────────────────────────────

/**
 * A skill registered by a plugin.
 * Skills are read-only knowledge packages mounted into agent sandboxes.
 */
export interface PluginSkill {
  /** Skill name. */
  name: string;
  /** Absolute path to the skill directory (containing SKILL.md, README.md, etc.). */
  path: string;
  /** Human-readable description. */
  description: string;
}

// ── Hook types ───────────────────────────────────────────────────────────────

/** All hook names the plugin system supports. */
export type HookName =
  | "prePrompt"
  | "postResponse"
  | "preToolExec"
  | "postToolExec"
  | "sessionCreated"
  | "sessionDisposed"
  | "gatewayStarted"
  | "gatewayShutdown";

// ── Hook event types ─────────────────────────────────────────────────────────

export interface PrePromptEvent {
  message: string;
  sessionKey: string;
  agentName: string;
  channel: string;
}

export interface PrePromptResult {
  /** Transformed message (or original if unchanged). */
  message: string;
  /** If true, the message is blocked and not sent to the LLM. */
  block?: boolean;
  /** Reason for blocking (returned to the channel). */
  reason?: string;
}

export interface PostResponseEvent {
  response: string;
  sessionKey: string;
  agentName: string;
  channel: string;
}

export interface PostResponseResult {
  /** Transformed response (or original if unchanged). */
  response: string;
  /** If true, the response is suppressed and not delivered. */
  block?: boolean;
}

export interface PreToolExecEvent {
  toolName: string;
  args: string[];
  sessionKey: string;
  agentName: string;
}

export interface PreToolExecResult {
  /** If false, the tool call is denied. */
  allow: boolean;
  /** Reason for denial (returned to the LLM as tool error). */
  reason?: string;
}

export interface PostToolExecEvent {
  toolName: string;
  args: string[];
  result: ToolResult;
  sessionKey: string;
  agentName: string;
}

export interface PostToolExecResult {
  /** Optionally transform the tool result. */
  result?: ToolResult;
}

export interface SessionLifecycleEvent {
  sessionKey: string;
  agentName: string;
  channel: string;
}

export interface GatewayLifecycleEvent {
  /** No additional data for gateway lifecycle events. */
}

/** Maps hook names to their event and result types. */
export interface HookTypeMap {
  prePrompt: { event: PrePromptEvent; result: PrePromptResult };
  postResponse: { event: PostResponseEvent; result: PostResponseResult };
  preToolExec: { event: PreToolExecEvent; result: PreToolExecResult };
  postToolExec: { event: PostToolExecEvent; result: PostToolExecResult };
  sessionCreated: { event: SessionLifecycleEvent; result: void };
  sessionDisposed: { event: SessionLifecycleEvent; result: void };
  gatewayStarted: { event: GatewayLifecycleEvent; result: void };
  gatewayShutdown: { event: GatewayLifecycleEvent; result: void };
}

export type HookHandler<H extends HookName = HookName> =
  (event: HookTypeMap[H]["event"]) => Promise<HookTypeMap[H]["result"]>;

// ── Plugin Registrar ─────────────────────────────────────────────────────────

/**
 * Passed to plugin.register(). Plugins use this to register tools, channels,
 * hooks, and skills with the gateway.
 *
 * Tool name validation is enforced here: all tool names must equal the plugin
 * name or start with `pluginName.`.
 */
export interface PluginRegistrar {
  /** Register a tool. Name must start with the plugin name. */
  tool(tool: PluginTool): void;

  /** Register a channel adapter. */
  channel(adapter: ChannelAdapter): void;

  /** Register a hook handler. */
  hook<H extends HookName>(hookName: H, handler: HookHandler<H>): void;

  /** Register a skill. */
  skill(skill: PluginSkill): void;
}

// ── Reply Target ─────────────────────────────────────────────────────────────

/**
 * Where to route responses for a session.
 */
export interface ReplyTarget {
  /** Which channel to route the response to. */
  channel: string;
  /** Channel-specific addressing (chat ID, thread ID, webhook URL, etc.). */
  address: Record<string, string>;
}

// ── Session Settings ─────────────────────────────────────────────────────────

/**
 * Mutable session state that channels and plugins can read and modify.
 */
export interface SessionSettings {
  /** Current LLM model. */
  model?: {
    provider: string;
    model: string;
    thinkingLevel?: string;
  };
  /** Where to route responses. */
  replyTo?: ReplyTarget;
  /** Show tool-call notifications. */
  verbose?: boolean;
  /** Stream responses in real-time. */
  streaming?: boolean;
  /** Which channel created this session. */
  channel?: string;
  /** Plugin-attached arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

// ── Model info types ─────────────────────────────────────────────────────────

/** Metadata for a registered model, as surfaced to plugins. */
export interface ModelInfo {
  provider: string;
  modelId: string;
  name: string;
  /** Total context window size in tokens. */
  contextWindow: number;
  /** Maximum output tokens the model can generate in a single response. */
  maxTokens: number;
}

/** Most-recent token usage for a session, read from the session file. */
export interface SessionUsage {
  /** Total input tokens sent on the last LLM turn (= current context size). */
  inputTokens: number;
  /** Output tokens generated on the last LLM turn. */
  outputTokens: number;
  /** Cache-read tokens (Anthropic prompt caching). */
  cacheReadTokens: number;
  /** Cache-write tokens (Anthropic prompt caching). */
  cacheWriteTokens: number;
}

// ── Plugin Context ───────────────────────────────────────────────────────────

/**
 * Provided by the gateway to each plugin at creation time.
 * Plugins use this to interact with sessions, tools, channels, and config.
 */
export interface PluginContext {
  // ── Session operations ─────────────────────────────────
  /** Send a prompt to an agent session, get the full response. */
  prompt(sessionKey: string, agentName: string, message: string, opts?: PromptOpts): Promise<string>;

  /** Send a streaming prompt. */
  promptStreaming(
    sessionKey: string,
    agentName: string,
    message: string,
    onDelta: (delta: string) => void,
    opts?: PromptOpts
  ): Promise<string>;

  /** Create a new session (discards old history for this key). */
  newSession(sessionKey: string, agentName: string): Promise<void>;

  /** Create a new session file and return the session file path. */
  createSession(sessionKey: string, agentName: string, metadata?: Record<string, unknown>): string;

  // ── Session settings ───────────────────────────────────
  /** Get a session's current settings. */
  getSessionSettings(sessionKey: string): SessionSettings;

  /** Update session settings (partial update, deep-merged). */
  updateSessionSettings(sessionKey: string, update: Partial<SessionSettings>): void;

  /** Attach/update plugin metadata on a session. */
  setSessionMetadata(sessionKey: string, key: string, value: unknown): void;

  /** Read plugin metadata from a session. */
  getSessionMetadata(sessionKey: string, key: string): unknown;

  // ── Session data access ─────────────────────────────────
  /** List sessions for an agent (for session history tools). */
  listSessions(agentName: string, opts?: { includeToolSessions?: boolean }): Array<{
    sessionId: string;
    sessionFile: string;
    agentName: string;
    createdAt: string;
    firstMessage: string;
  }>;

  /** Get a session entry by key (for session history tools). */
  getSessionEntry(sessionKey: string): {
    agentName: string;
    sessionFile: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
  } | undefined;

  // ── Cross-plugin tool invocation ───────────────────────
  /** Invoke a registered tool by name (from any plugin). */
  invokeTool(toolName: string, args: string[], sessionContext?: SessionContext): Promise<ToolResult>;

  // ── Session compaction ─────────────────────────────────
  /**
   * Manually compact the session context.
   * Aborts any in-flight operation first, then runs an LLM summarisation
   * pass that replaces old history with a summary, freeing context tokens.
   *
   * Throws if no session exists, the session is too small to compact,
   * or it's already been compacted without new content since.
   *
   * Returns the number of tokens the context held before compaction and
   * the generated summary text.
   */
  compactSession(sessionKey: string): Promise<{ tokensBefore: number; summary: string }>;

  // ── Session control ────────────────────────────────────
  /**
   * Whether a prompt is currently in flight for this session.
   * Use this to decide whether to steer (interrupt) vs. start a new turn.
   */
  isSessionActive(sessionKey: string): boolean;

  /**
   * Abort the current operation and wait until the agent is idle.
   * The in-flight prompt/promptStreaming call resolves with any partial response
   * already accumulated. No-op if the session is idle or doesn't exist.
   */
  abortSession(sessionKey: string): Promise<void>;

  /**
   * Steer the currently running session with a new message.
   * Delivered after the current tool finishes, skipping remaining tool calls —
   * exactly like pressing ESC and typing a new message in the TUI.
   * No-op if no session exists for the key.
   */
  steerSession(sessionKey: string, text: string): Promise<void>;

  /**
   * Dispose the in-memory pi session for a session key, without touching the
   * `.jsonl` session file on disk. History is preserved — the next prompt call
   * will reload the session from disk under whatever agentName is passed.
   *
   * Use this when you want to switch agents or models on an existing session:
   * abort the session, dispose it, then call prompt() with the new agentName
   * (which calls getOrCreateSession and finds the existing file).
   *
   * No-op if no in-memory session exists for this key.
   */
  disposeSession(sessionKey: string): Promise<void>;

  // ── Model info ─────────────────────────────────────────
  /**
   * Look up a model's metadata (context window, max output tokens, etc.)
   * by provider and model ID. Returns undefined if the model is not registered.
   */
  getModel(provider: string, modelId: string): ModelInfo | undefined;

  /**
   * Get the most recent token usage for a session by reading the session file.
   * Returns undefined if the session has no assistant messages yet.
   *
   * `inputTokens` reflects the full context sent to the LLM on the last turn —
   * i.e. the current context size in tokens.
   */
  getSessionUsage(sessionKey: string): SessionUsage | undefined;

  /**
   * Get the currently active model for a session by reading the last
   * `model_change` entry from the session file.
   * Returns undefined if no session exists or no model has been set yet.
   */
  getSessionModel(sessionKey: string): { provider: string; modelId: string } | undefined;

  // ── Config & info ──────────────────────────────────────
  /** The full resolved Beige config (read-only). */
  readonly config: Readonly<Record<string, unknown>>;

  /** List of configured agent names. */
  readonly agentNames: string[];

  // ── Plugin registry (read-only view) ───────────────────
  /** Get a registered channel adapter by name. */
  getChannel(name: string): ChannelAdapter | undefined;

  /** Get all registered tool names. */
  getRegisteredTools(): string[];

  // ── Logging ────────────────────────────────────────────
  /** Namespaced logger (logs are prefixed with plugin name). */
  log: PluginLogger;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PromptOpts {
  /** Which channel initiated this prompt. */
  channel?: string;
  /** Where to route the response. */
  replyTo?: ReplyTarget;
  /** Tool-start notification callback. */
  onToolStart?: (toolName: string, params: Record<string, unknown>) => void;
  /**
   * Called each time a new assistant LLM turn starts.
   * In streaming mode this signals that a new response is beginning — any
   * previously streamed content from an earlier turn (emitted before tool calls)
   * should be discarded. Only the content streamed after the last call to this
   * callback is the final response.
   */
  onAssistantTurnStart?: () => void;

  /**
   * Override the model for this specific prompt call, bypassing the agent's
   * default model and fallback list. The model must still be in the agent's
   * allowed list (primary or one of its fallbackModels).
   *
   * The in-memory session is disposed and recreated with this model if the
   * current session is using a different one — history (the .jsonl file) is
   * always preserved.
   */
  modelOverride?: { provider: string; model: string };

  /**
   * Called when auto-compaction starts (either threshold or overflow recovery).
   * Fires after the prompt response has already been delivered, as compaction
   * runs as a post-response background task.
   */
  onAutoCompactionStart?: () => void;

  /**
   * Called when auto-compaction finishes.
   * `tokensBefore` is the context size before compaction (undefined on failure).
   * `willRetry` is true for overflow recovery — the original prompt is being retried.
   */
  onAutoCompactionEnd?: (result: {
    success: boolean;
    tokensBefore?: number;
    willRetry: boolean;
    errorMessage?: string;
  }) => void;
}

// ── Plugin Instance ──────────────────────────────────────────────────────────

/**
 * The object returned by a plugin's createPlugin() function.
 * The gateway calls register(), then start(), and stop() on shutdown.
 */
export interface PluginInstance {
  /**
   * Called during plugin loading. Register tools, channels, hooks, and skills here.
   * All registration must happen synchronously within this call.
   */
  register(registrar: PluginRegistrar): void;

  /**
   * Called after ALL plugins are registered and gateway infrastructure is ready.
   * Start background processes here (polling, timers, watchers).
   * Optional — plugins with no background work can omit this.
   */
  start?(): Promise<void>;

  /**
   * Called on gateway shutdown (in reverse plugin order).
   * Clean up background processes here.
   * Optional — plugins with no cleanup can omit this.
   */
  stop?(): Promise<void>;
}

/**
 * The factory function that every plugin must export as its default export
 * or named export `createPlugin`.
 */
export type CreatePluginFn = (
  config: Record<string, unknown>,
  ctx: PluginContext
) => PluginInstance;
