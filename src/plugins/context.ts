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
import { readFileSync } from "fs";
import { parseSessionEntries, getLastAssistantUsage } from "@mariozechner/pi-coding-agent";
import type {
  PluginContext,
  PluginLogger,
  PromptOpts,
  ToolResult,
  SessionSettings,
  ChannelAdapter,
  ReplyTarget,
  ModelInfo,
  SessionUsage,
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
        onAssistantTurnStart: opts?.onAssistantTurnStart,
      });
    },

    async newSession(sessionKey, agentName) {
      const mgr = getAgentManager();
      await mgr.newSession(sessionKey, agentName);
    },

    createSession(sessionKey, agentName, metadata) {
      return sessionStore.createSession(sessionKey, agentName, metadata);
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
      // model, replyTo, channel, metadata are stored via session map entry metadata
      if (update.model || update.replyTo || update.channel || update.metadata) {
        const metaUpdate: Record<string, unknown> = {};
        if (update.model) metaUpdate._model = update.model;
        if (update.replyTo) metaUpdate._replyTo = update.replyTo;
        if (update.channel) metaUpdate._channel = update.channel;
        if (update.metadata) {
          const entry = sessionStore.getEntry(sessionKey);
          const existingPluginMeta = (entry?.metadata?._pluginMeta as Record<string, unknown>) ?? {};
          metaUpdate._pluginMeta = { ...existingPluginMeta, ...update.metadata };
        }
        sessionStore.updateMetadata(sessionKey, metaUpdate);
      }
    },

    setSessionMetadata(sessionKey, key, value) {
      sessionStore.updateMetadata(sessionKey, { [`plugin_${key}`]: value });
    },

    getSessionMetadata(sessionKey, key) {
      const entry = sessionStore.getEntry(sessionKey);
      return entry?.metadata?.[`plugin_${key}`];
    },

    // ── Session data access ─────────────────────────────────
    listSessions(agentName, opts) {
      return sessionStore.listSessions(agentName, opts);
    },

    getSessionEntry(sessionKey) {
      return sessionStore.getEntry(sessionKey);
    },

    // ── Cross-plugin tool invocation ───────────────────────
    async invokeTool(toolName, args, sessionContext) {
      const tool = registry.getTool(toolName);
      if (!tool) {
        return { output: `Unknown tool: ${toolName}`, exitCode: 1 };
      }
      return tool.handler(args, undefined, sessionContext);
    },

    // ── Session compaction ─────────────────────────────────
    async compactSession(sessionKey): Promise<{ tokensBefore: number; summary: string }> {
      return getAgentManager().compactSession(sessionKey);
    },

    // ── Session control ────────────────────────────────────
    isSessionActive(sessionKey): boolean {
      return getAgentManager().isSessionActive(sessionKey);
    },

    async abortSession(sessionKey): Promise<void> {
      await getAgentManager().abortSession(sessionKey);
    },

    async steerSession(sessionKey, text): Promise<void> {
      await getAgentManager().steerSession(sessionKey, text);
    },

    // ── Model info ─────────────────────────────────────────
    getModel(provider, modelId): ModelInfo | undefined {
      const registry = getAgentManager().getModelRegistry();
      const model = registry.find(provider, modelId);
      if (!model) return undefined;
      return {
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      };
    },

    getSessionUsage(sessionKey): SessionUsage | undefined {
      const entries = readSessionEntries(sessionKey);
      if (!entries) return undefined;

      const usage = getLastAssistantUsage(entries);
      if (!usage) return undefined;

      return {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: usage.cacheWrite ?? 0,
      };
    },

    getSessionModel(sessionKey): { provider: string; modelId: string } | undefined {
      const entries = readSessionEntries(sessionKey);
      if (!entries) return undefined;

      // Walk backwards to find the last model_change entry
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "model_change") {
          return { provider: entry.provider, modelId: entry.modelId };
        }
      }
      return undefined;
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
    // Default logger; overridden per-plugin in loader.ts with a namespaced one
    log: createLogger("plugins"),
  };

  return ctx;

  // ── Internal helpers ─────────────────────────────────────

  /**
   * Read and parse the session .jsonl file for a given session key.
   * Returns the SessionEntry array (header filtered out), or undefined if the
   * session doesn't exist or the file can't be read.
   */
  function readSessionEntries(sessionKey: string): Parameters<typeof getLastAssistantUsage>[0] | undefined {
    const entry = sessionStore.getEntry(sessionKey);
    if (!entry?.sessionFile) return undefined;

    let content: string;
    try {
      content = readFileSync(entry.sessionFile, "utf-8");
    } catch {
      return undefined;
    }

    const fileEntries = parseSessionEntries(content);
    // parseSessionEntries returns FileEntry[] (SessionHeader | SessionEntry[]).
    // Filter out the "session" header so we're left with SessionEntry[].
    return fileEntries.filter(
      (e) => (e as { type: string }).type !== "session"
    ) as Parameters<typeof getLastAssistantUsage>[0];
  }

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
