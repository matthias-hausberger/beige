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
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { parseSessionEntries, getLastAssistantUsage, calculateContextTokens } from "@mariozechner/pi-coding-agent";
import { streamSimple } from "@mariozechner/pi-ai";
import { beigeDir } from "../paths.js";
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

/**
 * Mutable reference to the ModelRegistry.
 * Populated after model registry is created in the gateway.
 */
export interface ModelRegistryRef {
  current: ModelRegistry | null;
}

export interface PluginContextDeps {
  config: BeigeConfig;
  agentManagerRef: AgentManagerRef;
  modelRegistryRef: ModelRegistryRef;
  sessionStore: BeigeSessionStore;
  settingsStore: SessionSettingsStore;
  registry: PluginRegistry;
}

export function createPluginContext(deps: PluginContextDeps): PluginContext {
  const { config, agentManagerRef, modelRegistryRef, sessionStore, settingsStore, registry } = deps;

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
      return mgr.prompt(sessionKey, agentName, message, opts);
    },

    async promptStreaming(sessionKey, agentName, message, onDelta, opts) {
      const mgr = getAgentManager();
      return mgr.promptStreaming(sessionKey, agentName, message, onDelta, opts);
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

    persistSessionModel(sessionKey, agentName, provider, modelId) {
      // Validate the model is in the agent's allowed list before persisting.
      const agentConfig = config.agents[agentName];
      if (!agentConfig) return;
      const allowed = [agentConfig.model, ...(agentConfig.fallbackModels ?? [])];
      const isAllowed = allowed.some((m) => m.provider === provider && m.model === modelId);
      if (!isAllowed) {
        console.warn(
          `[PLUGIN_CTX] persistSessionModel: ${provider}/${modelId} is not in the ` +
          `allowed list for agent '${agentName}' — ignoring.`
        );
        return;
      }
      sessionStore.updateMetadata(sessionKey, { activeModel: { provider, modelId } });
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

    async disposeSession(sessionKey): Promise<void> {
      await getAgentManager().disposeSession(sessionKey);
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
        inputTokens: calculateContextTokens(usage),
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

    // ── Direct LLM access ──────────────────────────────────
    async llmPrompt(provider, modelId, messages, opts) {
      if (!modelRegistryRef.current) {
        throw new Error(
          "ModelRegistry not yet initialized. llmPrompt() can only be called after gateway startup."
        );
      }
      const reg = modelRegistryRef.current;

      // Resolve model from registry
      const model = reg.find(provider, modelId);
      if (!model) {
        throw new Error(
          `Model "${provider}/${modelId}" not found in the model registry. ` +
          `Check that the provider and model ID match a registered model.`
        );
      }

      // Resolve API key through AuthStorage (handles API keys, OAuth, env vars)
      const apiKey = await reg.getApiKey(model);
      if (!apiKey) {
        throw new Error(
          `No credentials found for provider "${provider}". ` +
          `Configure an API key in auth.json, log in via OAuth, or set the corresponding environment variable.`
        );
      }

      // Build pi-ai Context
      const context = {
        systemPrompt: opts?.systemPrompt,
        messages: messages.map((m) => ({
          role: m.role as "user",
          content: m.content,
          timestamp: Date.now(),
        })),
        tools: [],
      };

      // Stream and collect response text
      const eventStream = streamSimple(model, context, {
        apiKey,
        maxTokens: opts?.maxTokens ?? model.maxTokens,
        reasoning: opts?.thinkingLevel === "off" ? undefined : opts?.thinkingLevel,
      });

      const textParts: string[] = [];

      for await (const event of eventStream) {
        if (event.type === "text_delta") {
          textParts.push(event.delta);
        }
      }

      const result = textParts.join("");
      if (!result) {
        throw new Error("LLM returned no text content.");
      }

      return result;
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

    // Default dataDir; overridden per-plugin in loader.ts
    dataDir: resolve(beigeDir(), "data", "unknown"),
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
