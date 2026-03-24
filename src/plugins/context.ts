/**
 * PluginContext implementation.
 *
 * Bridges the plugin interface to the gateway internals.
 * Created once per gateway lifecycle and shared with all plugins.
 */

import type { BeigeConfig } from "../config/schema.js";
import type { AgentManager, OnToolStart } from "../gateway/agent-manager.js";
import type { BeigeSessionStore } from "../gateway/sessions.js";
import type { SessionSettingsStore } from "../gateway/session-settings.js";
import type { SessionContext } from "../types/session.js";
import type {
  PluginContext,
  PluginLogger,
  PromptOpts,
  ToolResult,
  SessionSettings,
  ChannelAdapter,
  ReplyTarget,
} from "./types.js";
import type { PluginRegistry } from "./registry.js";

/**
 * Mutable reference to the AgentManager.
 * The context is created before the AgentManager, so we use a ref that is
 * populated later. Plugin methods that need the AgentManager resolve it at
 * call time.
 */
export interface AgentManagerRef {
  current: AgentManager | null;
}

export interface PluginContextDeps {
  config: BeigeConfig;
  agentManagerRef: AgentManagerRef;
  sessionStore: BeigeSessionStore;
  settingsStore: SessionSettingsStore;
  registry: PluginRegistry;
}

export function createPluginContext(deps: PluginContextDeps): PluginContext {
  const { config, agentManagerRef, sessionStore, settingsStore, registry } = deps;

  function getAgentManager(): AgentManager {
    if (!agentManagerRef.current) {
      throw new Error(
        "AgentManager not yet initialized. This method can only be called after gateway startup."
      );
    }
    return agentManagerRef.current;
  }

  const ctx: PluginContext = {
    // ── Session operations ─────────────────────────────────
    async prompt(sessionKey, agentName, message, opts) {
      const mgr = getAgentManager();
      return mgr.prompt(sessionKey, agentName, message, {
        onToolStart: opts?.onToolStart,
      });
    },

    async promptStreaming(sessionKey, agentName, message, onDelta, opts) {
      const mgr = getAgentManager();
      return mgr.promptStreaming(sessionKey, agentName, message, onDelta, {
        onToolStart: opts?.onToolStart,
      });
    },

    async newSession(sessionKey, agentName) {
      const mgr = getAgentManager();
      await mgr.newSession(sessionKey, agentName);
    },

    // ── Session settings ───────────────────────────────────
    getSessionSettings(sessionKey) {
      const overrides = settingsStore.getAll(sessionKey);
      return {
        verbose: overrides.verbose,
        streaming: overrides.streaming,
        // model, channel, replyTo, metadata are stored in the session map entry
        ...getSessionMapSettings(sessionKey),
      };
    },

    updateSessionSettings(sessionKey, update) {
      if (update.verbose !== undefined) {
        settingsStore.set(sessionKey, "verbose", update.verbose);
      }
      if (update.streaming !== undefined) {
        settingsStore.set(sessionKey, "streaming", update.streaming);
      }
      // model, replyTo, metadata are stored via session map entry metadata
      if (update.model || update.replyTo || update.channel || update.metadata) {
        const entry = sessionStore.getEntry(sessionKey);
        if (entry) {
          const existingMeta = entry.metadata ?? {};
          if (update.model) existingMeta._model = update.model;
          if (update.replyTo) existingMeta._replyTo = update.replyTo;
          if (update.channel) existingMeta._channel = update.channel;
          if (update.metadata) {
            existingMeta._pluginMeta = {
              ...(existingMeta._pluginMeta as Record<string, unknown> ?? {}),
              ...update.metadata,
            };
          }
          // The session map is re-saved by updating the entry
          // For now we store via a new session creation with metadata
          // TODO: Add an updateMetadata method to BeigeSessionStore
        }
      }
    },

    setSessionMetadata(sessionKey, key, value) {
      const entry = sessionStore.getEntry(sessionKey);
      if (entry) {
        const meta = entry.metadata ?? {};
        meta[`plugin_${key}`] = value;
        // Store back — requires session store support
      }
    },

    getSessionMetadata(sessionKey, key) {
      const entry = sessionStore.getEntry(sessionKey);
      return entry?.metadata?.[`plugin_${key}`];
    },

    // ── Cross-plugin tool invocation ───────────────────────
    async invokeTool(toolName, args, sessionContext) {
      const tool = registry.getTool(toolName);
      if (!tool) {
        return { output: `Unknown tool: ${toolName}`, exitCode: 1 };
      }
      return tool.handler(args, undefined, sessionContext);
    },

    // ── Config & info ──────────────────────────────────────
    get config() {
      return config as Readonly<Record<string, unknown>>;
    },

    get agentNames() {
      return Object.keys(config.agents);
    },

    // ── Plugin registry (read-only view) ───────────────────
    getChannel(name) {
      return registry.getChannel(name);
    },

    getRegisteredTools() {
      return registry.getRegisteredToolNames();
    },

    // ── Logging ────────────────────────────────────────────
    log: createLogger("plugins"),
  };

  return ctx;

  // ── Internal helpers ─────────────────────────────────────

  function getSessionMapSettings(sessionKey: string): Partial<SessionSettings> {
    const entry = sessionStore.getEntry(sessionKey);
    if (!entry?.metadata) return {};
    const meta = entry.metadata;
    const result: Partial<SessionSettings> = {};
    if (meta._model) result.model = meta._model as SessionSettings["model"];
    if (meta._replyTo) result.replyTo = meta._replyTo as ReplyTarget;
    if (meta._channel) result.channel = meta._channel as string;
    if (meta._pluginMeta) result.metadata = meta._pluginMeta as Record<string, unknown>;
    return result;
  }
}

export function createLogger(prefix: string): PluginLogger {
  return {
    info: (msg) => console.log(`[${prefix.toUpperCase()}] ${msg}`),
    warn: (msg) => console.warn(`[${prefix.toUpperCase()}] ${msg}`),
    error: (msg) => console.error(`[${prefix.toUpperCase()}] ${msg}`),
  };
}
