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
import { resolve, join } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import type { BeigeConfig, AgentConfig, ModelRef } from "../config/schema.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { AuditLogger } from "./audit.js";
import type { BeigeSessionStore } from "./sessions.js";
import { createCoreTools, type ToolStartHandlerRef } from "../tools/core.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { buildSkillContext, validateSkillDeps, type LoadedSkill } from "../skills/registry.js";

/**
 * Load the system prompt template from the file alongside this module.
 * The template file is always shipped as part of the package (copied by build:assets).
 * Throws if the file is missing — this is a packaging/build error that must be fixed.
 */
function loadSystemPromptTemplate(): string {
  const templatePath = fileURLToPath(new URL("./system-prompt.template.md", import.meta.url));
  try {
    return readFileSync(templatePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to load system prompt template at ${templatePath}. ` +
      `This file must be present — run 'pnpm run build' to ensure it's copied to dist/. ` +
      `Original error: ${err instanceof Error ? err.message : err}`
    );
  }
}

const SYSTEM_PROMPT_TEMPLATE = loadSystemPromptTemplate();
import { ProviderHealthTracker, extractRateLimitInfo } from "./provider-health.js";
import { parseSessionKey, type SessionContext } from "../types/session.js";
import { beigeDir } from "../paths.js";
import { validateModelAllowed } from "../config/restricted-model-registry.js";

/**
 * Callback fired by the gateway when the agent is about to execute a tool.
 * Channels use this to show verbose tool-call notifications.
 *
 * @param toolName   The core tool being called (read, write, patch, exec).
 * @param params     The parameters passed to the tool.
 */
export type OnToolStart = (toolName: string, params: Record<string, unknown>) => void;

export interface ManagedSession {
  agentName: string;
  sessionKey: string;
  session: AgentSession;
  /** The current model reference (may differ from agent's default if fallback is active) */
  currentModel: ModelRef;
  /** Number of currently in-flight prompt calls on this session. */
  inflightCount: number;
  /** Resolvers that fire once inflightCount drops to zero. */
  drainResolvers: Array<() => void>;
  /**
   * Mutable handler reference shared with core tool closures.
   * Update `.fn` to change the active handler without recreating tools.
   */
  toolStartHandlerRef: ToolStartHandlerRef;
}

/**
 * Manages agent sessions. Supports multiple concurrent sessions per agent
 * (e.g. one per channel chat/thread).
 *
 * Each agent has one sandbox + socket. Sessions share the sandbox but have
 * independent conversation histories.
 *
 * Supports fallback models: if the primary model fails after retries, it tries
 * each fallback model in order. Rate limits are tracked per-provider/model.
 */
export class AgentManager {
  /** sessionKey → ManagedSession */
  private sessions = new Map<string, ManagedSession>();
  /** Tracks provider health and rate limits */
  private providerHealth = new ProviderHealthTracker();
  /** Beige home directory */
  private beigeDir = beigeDir();

  constructor(
    private config: BeigeConfig,
    private sandbox: SandboxManager,
    private audit: AuditLogger,
    private pluginRegistry: PluginRegistry,
    private loadedSkills: Map<string, LoadedSkill>,
    private authStorage: AuthStorage,
    private modelRegistry: ModelRegistry,
    private sessionStore: BeigeSessionStore
  ) {}

  /**
   * Get or create a session for a given key.
   *
   * @param sessionKey  Unique key (e.g. "tui:assistant:default" or "channelName:chatId:threadId")
   * @param agentName   Which agent to use
   * @param opts.forceNew     If true, always create a new session (for /new command)
   * @param opts.sessionFile  If set, open this specific session file (for /resume)
   * @param opts.onToolStart  Callback fired when a core tool is about to execute (verbose mode)
   */
  async getOrCreateSession(
    sessionKey: string,
    agentName: string,
    opts?: { forceNew?: boolean; sessionFile?: string; onToolStart?: OnToolStart }
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

    // Validate skill dependencies
    validateSkillDeps(agentConfig.skills ?? [], agentConfig.tools, this.loadedSkills);

    // Build pi session — wire onToolStart so channels get notified on tool calls.
    // Store the ref on the ManagedSession so it can be mutated at runtime (verbose toggle).
    const toolStartHandlerRef: ToolStartHandlerRef = { fn: opts?.onToolStart };
    const agentDir = resolve(this.beigeDir, "agents", agentName);
    const workspaceDir = agentConfig.workspaceDir 
      ?? resolve(agentDir, "workspace");
    const sessionContext = { ...parseSessionKey(sessionKey), agentName, agentDir, workspaceDir, onToolStart: toolStartHandlerRef.fn };
    const coreTools = createCoreTools(agentName, this.sandbox, this.audit, toolStartHandlerRef, sessionContext);
    const toolContext = buildPluginToolContext(agentConfig.tools, this.pluginRegistry);
    const skillContext = buildSkillContext(agentConfig.skills ?? [], this.loadedSkills);
    const systemPrompt = buildSystemPrompt(agentName, toolContext, skillContext);
    const agentsFiles = readWorkspaceAgentsMd(workspaceDir);

    const model = this.resolveModel(agentConfig);

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles }),
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
      currentModel: agentConfig.model,
      inflightCount: 0,
      drainResolvers: [],
      toolStartHandlerRef,
    };

    this.sessions.set(sessionKey, managed);
    console.log(`[AGENT] Session ready for '${agentName}' (key: ${sessionKey})`);

    // Fire sessionCreated hook (fire-and-forget — don't block session return)
    this.pluginRegistry.executeSessionCreated({
      sessionKey,
      agentName,
      channel: "unknown",
    }).catch((err) => console.error(`[AGENT] sessionCreated hook error:`, err));

    return managed;
  }

  /**
   * Send a message to a session and collect the full response.
   * Implements fallback logic: if the primary model fails after retries,
   * tries each fallback model in order.
   */
  async prompt(
    sessionKey: string,
    agentName: string,
    message: string,
    opts?: { onToolStart?: OnToolStart; channel?: string }
  ): Promise<string> {
    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    // Execute prePrompt hooks — may transform or block the message
    const preResult = await this.pluginRegistry.executePrePrompt({
      message,
      sessionKey,
      agentName,
      channel: opts?.channel ?? "unknown",
    });
    if (preResult.block) {
      return preResult.reason ?? "Message blocked by plugin hook.";
    }
    const effectiveMessage = preResult.message;

    // Build list of models to try: primary + fallbacks
    const modelsToTry = this.getModelsToTry(agentConfig);

    let lastError: Error | undefined;

    for (const modelRef of modelsToTry) {
      const { provider, model: modelId } = modelRef;

      // Skip if this model is in cooldown
      if (this.providerHealth.isCoolingDown(provider, modelId)) {
        const remaining = this.providerHealth.getRemainingCooldown(provider, modelId);
        console.log(
          `[AGENT] Skipping ${provider}/${modelId} — in cooldown for ${Math.round(remaining / 1000)}s`
        );
        continue;
      }

      console.log(`[AGENT] Attempting prompt with ${provider}/${modelId}`);

      try {
        const result = await this.promptWithModel(
          sessionKey,
          agentName,
          effectiveMessage,
          modelRef,
          opts
        );

        // Success — mark provider as healthy
        this.providerHealth.markHealthy(provider, modelId);

        // Execute postResponse hooks — may transform or suppress the response
        const postResult = await this.pluginRegistry.executePostResponse({
          response: result,
          sessionKey,
          agentName,
          channel: opts?.channel ?? "unknown",
        });
        if (postResult.block) {
          return "";
        }
        return postResult.response;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        // Check if it's a rate limit
        const rateLimitInfo = extractRateLimitInfo(err);
        if (rateLimitInfo.isRateLimit) {
          this.providerHealth.markRateLimited(
            provider,
            modelId,
            rateLimitInfo.retryAfterMs,
            error.message
          );
          console.log(
            `[AGENT] ${provider}/${modelId} rate limited, trying next model`
          );
          continue;
        }

        // Non-rate-limit error — mark as failed but try next
        this.providerHealth.markFailed(provider, modelId, error.message);
        console.error(
          `[AGENT] ${provider}/${modelId} failed: ${error.message}, trying next model`
        );
      }
    }

    // All models failed
    throw new Error(
      `All models failed for agent '${agentName}'. Last error: ${lastError?.message ?? "unknown"}`
    );
  }

  /**
   * Send a message and stream deltas via callback.
   * Implements fallback logic: if the primary model fails after retries,
   * tries each fallback model in order.
   */
  async promptStreaming(
    sessionKey: string,
    agentName: string,
    message: string,
    onDelta: (delta: string) => void,
    opts?: { onToolStart?: OnToolStart; channel?: string }
  ): Promise<string> {
    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    // Execute prePrompt hooks — may transform or block the message
    const preResult = await this.pluginRegistry.executePrePrompt({
      message,
      sessionKey,
      agentName,
      channel: opts?.channel ?? "unknown",
    });
    if (preResult.block) {
      const blocked = preResult.reason ?? "Message blocked by plugin hook.";
      onDelta(blocked);
      return blocked;
    }
    const effectiveMessage = preResult.message;

    // Build list of models to try: primary + fallbacks
    const modelsToTry = this.getModelsToTry(agentConfig);

    let lastError: Error | undefined;

    for (const modelRef of modelsToTry) {
      const { provider, model: modelId } = modelRef;

      // Skip if this model is in cooldown
      if (this.providerHealth.isCoolingDown(provider, modelId)) {
        const remaining = this.providerHealth.getRemainingCooldown(provider, modelId);
        console.log(
          `[AGENT] Skipping ${provider}/${modelId} — in cooldown for ${Math.round(remaining / 1000)}s`
        );
        continue;
      }

      console.log(`[AGENT] Attempting streaming prompt with ${provider}/${modelId}`);

      try {
        const result = await this.promptStreamingWithModel(
          sessionKey,
          agentName,
          effectiveMessage,
          onDelta,
          modelRef,
          opts
        );

        // Success — mark provider as healthy
        this.providerHealth.markHealthy(provider, modelId);

        // Execute postResponse hooks (note: for streaming, the deltas have
        // already been sent; postResponse can still log/transform the final text)
        const postResult = await this.pluginRegistry.executePostResponse({
          response: result,
          sessionKey,
          agentName,
          channel: opts?.channel ?? "unknown",
        });
        return postResult.block ? "" : postResult.response;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        // Check if it's a rate limit
        const rateLimitInfo = extractRateLimitInfo(err);
        if (rateLimitInfo.isRateLimit) {
          this.providerHealth.markRateLimited(
            provider,
            modelId,
            rateLimitInfo.retryAfterMs,
            error.message
          );
          console.log(
            `[AGENT] ${provider}/${modelId} rate limited, trying next model`
          );
          continue;
        }

        // Non-rate-limit error — mark as failed but try next
        this.providerHealth.markFailed(provider, modelId, error.message);
        console.error(
          `[AGENT] ${provider}/${modelId} failed: ${error.message}, trying next model`
        );
      }
    }

    // All models failed
    throw new Error(
      `All models failed for agent '${agentName}'. Last error: ${lastError?.message ?? "unknown"}`
    );
  }

  /**
   * Get the list of models to try, skipping those in cooldown.
   * Returns primary model + fallbacks that are not currently rate-limited.
   */
  private getModelsToTry(agentConfig: AgentConfig): ModelRef[] {
    const models: ModelRef[] = [agentConfig.model];

    if (agentConfig.fallbackModels) {
      models.push(...agentConfig.fallbackModels);
    }

    return models;
  }

  /**
   * Execute a prompt with a specific model (internal).
   */
  private async promptWithModel(
    sessionKey: string,
    agentName: string,
    message: string,
    modelRef: ModelRef,
    opts?: { onToolStart?: OnToolStart }
  ): Promise<string> {
    const managed = await this.getOrCreateSessionWithModel(
      sessionKey,
      agentName,
      modelRef,
      opts
    );
    managed.inflightCount++;

    try {
      return await new Promise<string>((resolve, reject) => {
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
    } finally {
      this.decrementInflight(managed);
    }
  }

  /**
   * Execute a streaming prompt with a specific model (internal).
   */
  private async promptStreamingWithModel(
    sessionKey: string,
    agentName: string,
    message: string,
    onDelta: (delta: string) => void,
    modelRef: ModelRef,
    opts?: { onToolStart?: OnToolStart }
  ): Promise<string> {
    const managed = await this.getOrCreateSessionWithModel(
      sessionKey,
      agentName,
      modelRef,
      opts
    );
    managed.inflightCount++;

    try {
      return await new Promise<string>((resolve, reject) => {
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
    } finally {
      this.decrementInflight(managed);
    }
  }

  /**
   * Get or create a session with a specific model.
   * This allows switching models without creating a new session key.
   */
  private async getOrCreateSessionWithModel(
    sessionKey: string,
    agentName: string,
    modelRef: ModelRef,
    opts?: { onToolStart?: OnToolStart; forceNew?: boolean }
  ): Promise<ManagedSession> {
    // If forceNew, dispose old session and create fresh
    if (opts?.forceNew) {
      await this.disposeSession(sessionKey);
    }

    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    // Validate that the requested model is allowed for this agent
    const allowedModels = this.getAllowedModels(agentConfig);
    validateModelAllowed(modelRef.provider, modelRef.model, allowedModels);

    // Check if we need to recreate the session with a different model
    const existing = this.sessions.get(sessionKey);

    // If session exists with the same model, return it
    if (existing) {
      const { provider, model: modelId } = modelRef;
      const currentRef = existing.currentModel;

      if (currentRef.provider === provider && currentRef.model === modelId) {
        return existing;
      }

      // Different model — dispose and recreate
      console.log(
        `[AGENT] Switching session ${sessionKey} from ${currentRef.provider}/${currentRef.model} to ${provider}/${modelId}`
      );
      existing.session.dispose();
      this.sessions.delete(sessionKey);
    }

    // Determine session file
    let sessionFile: string | undefined;
    if (opts?.forceNew) {
      sessionFile = this.sessionStore.createSession(sessionKey, agentName);
    } else {
      sessionFile = this.sessionStore.getSessionFile(sessionKey);
      if (!sessionFile) {
        sessionFile = this.sessionStore.createSession(sessionKey, agentName);
      }
    }

    console.log(`[AGENT] Creating session for '${agentName}' with model ${modelRef.provider}/${modelRef.model} (key: ${sessionKey})`);

    // Validate skill dependencies
    validateSkillDeps(agentConfig.skills ?? [], agentConfig.tools, this.loadedSkills);

    // Build pi session
    const toolStartHandlerRef: ToolStartHandlerRef = { fn: opts?.onToolStart };
    const agentDir = resolve(this.beigeDir, "agents", agentName);
    const workspaceDir = agentConfig.workspaceDir 
      ?? resolve(agentDir, "workspace");
    const sessionContext = { ...parseSessionKey(sessionKey), agentName, agentDir, workspaceDir, onToolStart: toolStartHandlerRef.fn };
    const coreTools = createCoreTools(agentName, this.sandbox, this.audit, toolStartHandlerRef, sessionContext);
    const toolContext = buildPluginToolContext(agentConfig.tools, this.pluginRegistry);
    const skillContext = buildSkillContext(agentConfig.skills ?? [], this.loadedSkills);
    const systemPrompt = buildSystemPrompt(agentName, toolContext, skillContext);
    const agentsFiles = readWorkspaceAgentsMd(workspaceDir);

    const model = this.resolveModelFromRef(modelRef);

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles }),
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
      const { dir } = await import("path").then((p) => ({ dir: p.dirname(sessionFile!) }));
      sessionManager = SessionManager.create(process.cwd(), dir);
    }

    const { session } = await createAgentSession({
      model,
      thinkingLevel: (modelRef.thinkingLevel as any) ?? "off",
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
      currentModel: modelRef,
      inflightCount: 0,
      drainResolvers: [],
      toolStartHandlerRef,
    };

    this.sessions.set(sessionKey, managed);
    console.log(`[AGENT] Session ready for '${agentName}' (key: ${sessionKey})`);

    // Fire sessionCreated hook (fire-and-forget — don't block session return)
    this.pluginRegistry.executeSessionCreated({
      sessionKey,
      agentName,
      channel: "unknown",
    }).catch((err) => console.error(`[AGENT] sessionCreated hook error:`, err));

    return managed;
  }

  /**
   * Wait for all currently in-flight prompt / promptStreaming calls to finish,
   * then dispose every session. New calls made after drainAll() starts will
   * still complete before disposal — drainAll() re-waits until quiet.
   *
   * Safe to call multiple times; idempotent once all sessions are disposed.
   */
  async drainAll(): Promise<void> {
    console.log("[AGENT] Draining in-flight LLM calls...");

    // Wait for every managed session to have inflightCount === 0.
    const drainSession = (managed: ManagedSession): Promise<void> => {
      if (managed.inflightCount === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        managed.drainResolvers.push(resolve);
      });
    };

    // Add a timeout to prevent hanging on stuck calls (10 seconds)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Drain timeout")), 10000);
    });

    // Iteratively wait until the whole map is quiet (new sessions could be
    // created by concurrent callers while we wait).
    let quiet = false;
    while (!quiet) {
      const pending = [...this.sessions.values()];
      await Promise.race([
        Promise.all(pending.map(drainSession)),
        timeoutPromise,
      ]);
      // Check again — no new calls should have started after drainResolvers fire
      quiet = [...this.sessions.values()].every((s) => s.inflightCount === 0);
    }

    console.log("[AGENT] All in-flight calls finished. Disposing sessions...");
    for (const [, managed] of this.sessions) {
      managed.session.dispose();
    }
    this.sessions.clear();
    console.log("[AGENT] Sessions drained and disposed.");
  }

  /**
   * Start a new session for a key (disposes old one).
   * If an existing session has an onToolStart handler, it is re-registered.
   */
  async newSession(
    sessionKey: string,
    agentName: string,
    opts?: { onToolStart?: OnToolStart }
  ): Promise<ManagedSession> {
    // Carry over onToolStart from the old session if not explicitly provided
    const existingHandler = this.sessions.get(sessionKey)?.toolStartHandlerRef.fn;
    // Reset in session store — creates new file, keeps old one
    this.sessionStore.resetSession(sessionKey, agentName);
    return this.getOrCreateSession(sessionKey, agentName, {
      forceNew: true,
      onToolStart: opts?.onToolStart ?? existingHandler,
    });
  }

  /**
   * Update the onToolStart handler for an existing session without recreating it.
   * Used when verbose mode is toggled at runtime.
   */
  updateToolStartHandler(sessionKey: string, onToolStart: OnToolStart | undefined): void {
    const managed = this.sessions.get(sessionKey);
    if (managed) {
      // Mutating the ref updates all tool closures immediately — no recreation needed.
      managed.toolStartHandlerRef.fn = onToolStart;
    }
  }

  /**
   * Dispose a specific session.
   */
  async disposeSession(sessionKey: string): Promise<void> {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.session.dispose();
      this.sessions.delete(sessionKey);

      // Fire sessionDisposed hook (fire-and-forget)
      this.pluginRegistry.executeSessionDisposed({
        sessionKey,
        agentName: existing.agentName,
        channel: "unknown",
      }).catch((err) => console.error(`[AGENT] sessionDisposed hook error:`, err));
    }
  }

  /**
   * Dispose all sessions immediately (no drain).
   */
  async shutdown(): Promise<void> {
    for (const [, managed] of this.sessions) {
      managed.session.dispose();
    }
    this.sessions.clear();
  }

  // ── Private helpers ────────────────────────────────────────────────

  private decrementInflight(managed: ManagedSession): void {
    managed.inflightCount = Math.max(0, managed.inflightCount - 1);
    if (managed.inflightCount === 0 && managed.drainResolvers.length > 0) {
      const resolvers = managed.drainResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  private resolveModel(agentConfig: AgentConfig) {
    return this.resolveModelFromRef(agentConfig.model);
  }

  private resolveModelFromRef(modelRef: ModelRef) {
    const { provider, model: modelId } = modelRef;
    // Prefer ModelRegistry.find() over the static getModel() because the registry
    // applies OAuth provider transformations (e.g. modifyModels) that update baseUrl.
    // This is critical for GitHub Copilot business subscriptions where the baseUrl
    // must be rewritten based on the proxy-ep in the access token.
    const registryModel = this.modelRegistry.find(provider, modelId);
    if (registryModel) return registryModel;
    const model = getModel(provider as any, modelId);
    if (model) return model;
    throw new Error(`Model not found: ${provider}/${modelId}. Check your config and API keys.`);
  }

  /**
   * Build the list of allowed models for an agent.
   */
  private getAllowedModels(agentConfig: AgentConfig): Array<{ provider: string; modelId: string }> {
    const allowed: Array<{ provider: string; modelId: string }> = [
      { provider: agentConfig.model.provider, modelId: agentConfig.model.model },
    ];

    if (agentConfig.fallbackModels) {
      for (const fallback of agentConfig.fallbackModels) {
        allowed.push({ provider: fallback.provider, modelId: fallback.model });
      }
    }

    return allowed;
  }

  /**
   * Get the onToolStart callback for a session (used for verbose notifications).
   */
  getOnToolStartCallback(sessionKey: string): ((toolName: string, params: Record<string, unknown>) => void) | undefined {
    return this.sessions.get(sessionKey)?.toolStartHandlerRef.fn;
  }
}

/**
 * Read the workspace AGENTS.md file from the host filesystem.
 * Returns the content as an agentsFiles array suitable for the resource loader,
 * or an empty array if the file doesn't exist.
 */
export function readWorkspaceAgentsMd(workspaceDir: string): Array<{ path: string; content: string }> {
  const agentsMdPath = join(workspaceDir, "AGENTS.md");
  try {
    if (existsSync(agentsMdPath)) {
      const content = readFileSync(agentsMdPath, "utf-8");
      return [{ path: "/workspace/AGENTS.md", content }];
    }
  } catch {
    // Non-fatal — agent will just not have AGENTS.md in context
  }
  return [];
}

/**
 * Build tool context string for the system prompt from the plugin registry.
 */
function buildPluginToolContext(
  agentTools: string[],
  registry: PluginRegistry
): string {
  if (agentTools.length === 0) return "";

  const lines: string[] = ["## Available Tools", ""];

  for (const toolName of agentTools) {
    const tool = registry.getTool(toolName);
    if (!tool) continue;

    lines.push(`### ${toolName}`);
    lines.push(`${tool.description}`);
    if (tool.commands?.length) {
      lines.push("Commands:");
      for (const cmd of tool.commands) {
        lines.push(`  ${toolName} ${cmd}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function buildSystemPrompt(agentName: string, toolContext: string, skillContext: string = ""): string {
  return SYSTEM_PROMPT_TEMPLATE
    .replace(/\{\{agentName\}\}/g, agentName)
    .replace(/\{\{toolContext\}\}/g, toolContext)
    .replace(/\{\{skillContext\}\}/g, skillContext);
}
