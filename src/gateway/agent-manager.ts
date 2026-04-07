import { getModel, isContextOverflow } from "@mariozechner/pi-ai";
import { logErrorAuto } from "./error-logger.js";
import { createLogger } from "./logger.js";
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
import { createCoreTools, type ToolStartHandlerRef, type CurrentModelRef, type HeartbeatRef } from "../tools/core.js";
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

/**
 * Maximum inactivity time before a prompt is considered stuck.
 *
 * The watchdog is reset on every session event (text delta, tool execution,
 * turn start/end, retries, etc.). It only fires if the session emits
 * absolutely nothing for this duration — meaning the LLM or tool runner
 * has silently frozen without ever reaching agent_end.
 *
 * A legitimately busy agent (many tool calls, long computations) will keep
 * resetting the watchdog and will never time out no matter how long it runs.
 * Set to 10 minutes of silence — far above any normal inter-event gap.
 */
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Sentinel error thrown when the watchdog fires.
 * Caught in runWithFallback to trigger session disposal before the next
 * model attempt — prevents a poisoned (stuck) AgentSession from being reused.
 */
class PromptTimeoutError extends Error {
  readonly isPromptTimeout = true;
  constructor(modelLabel: string) {
    super(`Prompt timed out (${modelLabel}) — no agent_end received`);
    this.name = "PromptTimeoutError";
  }
}
import { ProviderHealthTracker, extractRateLimitInfo } from "./provider-health.js";
import { parseSessionKey, type SessionContext } from "../types/session.js";
import { beigeDir } from "../paths.js";
import { validateModelAllowed, buildAllowedModels } from "../config/restricted-model-registry.js";
import { ConcurrencyLimiter } from "./concurrency.js";

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
  /**
   * Mutable model reference shared with core tool closures.
   * Kept in sync with currentModel so tools always see the live model
   * (including during fallback switches) without being recreated.
   */
  currentModelRef: CurrentModelRef;
  /**
   * Mutable heartbeat ref shared with core tool closures.
   * Set by executePromptWithModel to the watchdog arm function so that
   * tool executions reset the inactivity timer — prevents long-running
   * tools (e.g. `pnpm test`) from triggering a false timeout.
   */
  heartbeatRef: HeartbeatRef;
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
  /** Per-provider concurrency limiter */
  private concurrencyLimiter: ConcurrencyLimiter;
  /** Beige home directory */
  private beigeDir = beigeDir();
  /**
   * Number of active direct LLM stream calls proxied via /api/chat/stream.
   * These are TUI sessions whose AgentSession lives in the TUI process —
   * they aren't tracked in `sessions`, so we count them separately so
   * drainAll() can wait for them to finish before a gateway restart.
   */
  private activeStreamCount = 0;
  private streamDrainResolvers: Array<() => void> = [];

  constructor(
    private config: BeigeConfig,
    private sandbox: SandboxManager,
    private audit: AuditLogger,
    private pluginRegistry: PluginRegistry,
    private loadedSkills: Map<string, LoadedSkill>,
    private authStorage: AuthStorage,
    private modelRegistry: ModelRegistry,
    private sessionStore: BeigeSessionStore
  ) {
    this.concurrencyLimiter = new ConcurrencyLimiter(config);
  }

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
    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    return this.getOrCreateSessionWithModel(
      sessionKey,
      agentName,
      agentConfig.model,
      opts
    );
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
    opts?: { onToolStart?: OnToolStart; onAutoCompactionStart?: () => void; onAutoCompactionEnd?: (r: { success: boolean; tokensBefore?: number; willRetry: boolean; errorMessage?: string }) => void; channel?: string; modelOverride?: { provider: string; model: string } }
  ): Promise<string> {
    return this.runWithFallback(sessionKey, agentName, message, {
      ...opts,
      operationLabel: "prompt",
    });
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
    opts?: { onToolStart?: OnToolStart; onAssistantTurnStart?: () => void; onAutoCompactionStart?: () => void; onAutoCompactionEnd?: (r: { success: boolean; tokensBefore?: number; willRetry: boolean; errorMessage?: string }) => void; channel?: string; modelOverride?: { provider: string; model: string } }
  ): Promise<string> {
    return this.runWithFallback(sessionKey, agentName, message, {
      ...opts,
      operationLabel: "promptStreaming",
      onDelta,
    });
  }

  /**
   * Shared fallback loop for prompt() and promptStreaming().
   *
   * Handles: prePrompt hooks → model fallback loop → per-model prompt
   * execution → postResponse hooks.  The only difference between the
   * non-streaming and streaming variants is the presence of onDelta /
   * onAssistantTurnStart callbacks — both funnel through the same
   * executePromptWithModel() implementation.
   */
  private async runWithFallback(
    sessionKey: string,
    agentName: string,
    message: string,
    opts: {
      onToolStart?: OnToolStart;
      onDelta?: (delta: string) => void;
      onAssistantTurnStart?: () => void;
      onAutoCompactionStart?: () => void;
      onAutoCompactionEnd?: (r: { success: boolean; tokensBefore?: number; willRetry: boolean; errorMessage?: string }) => void;
      channel?: string;
      modelOverride?: { provider: string; model: string };
      operationLabel: string;
    }
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
      channel: opts.channel ?? "unknown",
    });
    if (preResult.block) {
      const blocked = preResult.reason ?? "Message blocked by plugin hook.";
      opts.onDelta?.(blocked);
      return blocked;
    }
    const effectiveMessage = preResult.message;

    // Build list of models to try: explicit override → per-session override → primary + fallbacks.
    // getModelsToTry only honours explicit user overrides (persisted via /model),
    // NOT automatic fallback state — so sessions always try primary first once
    // its cooldown expires.
    const modelsToTry = opts.modelOverride
      ? [opts.modelOverride]
      : this.getModelsToTry(agentConfig, sessionKey);

    // Track the primary model so we can detect fallback switches
    const primaryModel = modelsToTry[0];

    let lastError: Error | undefined;
    /** Reason for the most recent model skip/failure (used in modelSwitched event). */
    let lastSkipReason: "fallback_rate_limit" | "fallback_error" | "fallback_timeout" = "fallback_error";

    // ── Multi-pass retry loop ────────────────────────────────────────
    //
    // Instead of trying each model once and giving up, we loop through
    // the model list up to MAX_PASSES times.  A model is eligible for
    // retry on the next pass if:
    //   a) it is NOT in rate-limit cooldown (retryAfter > now), AND
    //   b) it has NOT accumulated MAX_FAILURES_PER_MODEL consecutive
    //      failures within this single prompt run.
    //
    // This handles transient "overloaded" errors gracefully: if model A
    // fails once and model B also fails once, model A gets another shot
    // on the next pass — the overload may have cleared in the meantime.
    //
    // Rate-limited models (HTTP 429 with retryAfter) are still skipped
    // globally; only non-cooldown failures use the retry passes.

    const MAX_PASSES = 3;
    const MAX_FAILURES_PER_MODEL = 3;

    /** Per-model failure count within this prompt run. Key: "provider/model" */
    const runFailures = new Map<string, number>();

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let anyEligible = false;

      for (const modelRef of modelsToTry) {
        const { provider, model: modelId } = modelRef;
        const modelLabel = `${provider}/${modelId}`;
        const modelKey = modelLabel;
        const modelLogger = createLogger({ agent: agentName, session: sessionKey, model: modelLabel });

        // Skip if this model is in rate-limit cooldown (global, persisted)
        if (this.providerHealth.isCoolingDown(provider, modelId)) {
          const remaining = this.providerHealth.getRemainingCooldown(provider, modelId);
          modelLogger.log(
            "[AGENT]",
            `Skipping — in cooldown for ${Math.round(remaining / 1000)}s`
          );
          lastSkipReason = "fallback_rate_limit";
          continue;
        }

        // Skip if this model has exhausted its per-run failure budget
        const failures = runFailures.get(modelKey) ?? 0;
        if (failures >= MAX_FAILURES_PER_MODEL) {
          continue;
        }

        anyEligible = true;
        const passLabel = MAX_PASSES > 1 ? ` (pass ${pass + 1}/${MAX_PASSES})` : "";
        modelLogger.log("[AGENT]", `Attempting ${opts.operationLabel}${passLabel}`);

        try {
          const result = await this.executePromptWithModel(
            sessionKey,
            agentName,
            effectiveMessage,
            modelRef,
            opts
          );

          // Success — mark provider as healthy and reset run failures
          this.providerHealth.markHealthy(provider, modelId);
          modelLogger.log("[AGENT]", `${opts.operationLabel} succeeded`);

          // Fire modelSwitched hook if we ended up on a different model than primary
          if (provider !== primaryModel.provider || modelId !== primaryModel.model) {
            const channel = opts.channel ?? parseSessionKey(sessionKey).channel;
            this.pluginRegistry.executeModelSwitched({
              sessionKey,
              agentName,
              channel,
              previousModel: { provider: primaryModel.provider, modelId: primaryModel.model },
              newModel: { provider, modelId },
              reason: lastSkipReason,
            }).catch((err) => modelLogger.error("[AGENT]", `modelSwitched hook error: ${err}`));
          }

          // Execute postResponse hooks — may transform or suppress the response
          const postResult = await this.pluginRegistry.executePostResponse({
            response: result,
            sessionKey,
            agentName,
            channel: opts.channel ?? "unknown",
          });
          return postResult.block ? "" : postResult.response;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          lastError = error;

          // Track per-run failures for this model
          runFailures.set(modelKey, (runFailures.get(modelKey) ?? 0) + 1);
          const currentFailures = runFailures.get(modelKey)!;

          // Check if it's a rate limit
          const rateLimitInfo = extractRateLimitInfo(err);
          if (rateLimitInfo.isRateLimit) {
            // Log the full error details BEFORE cooldown so we can diagnose
            const cooldownType = rateLimitInfo.isHard ? "HARD (HTTP 429)" : "SOFT (pattern match)";
            modelLogger.warn("[AGENT]", `Rate limit detected — ${cooldownType}`);
            modelLogger.warn("[AGENT]", `  Detection reason: ${rateLimitInfo.detectionReason}`);
            modelLogger.warn("[AGENT]", `  Error message: ${error.message}`);
            modelLogger.warn("[AGENT]", `  Error stack: ${error.stack ?? "(no stack)"}`);
            // Log raw error properties for maximum visibility
            try {
              const errObj = err as Record<string, any>;
              const details: Record<string, unknown> = {};
              for (const key of ["status", "statusCode", "code", "type", "headers", "body", "response", "error", "cause"]) {
                if (errObj[key] !== undefined) details[key] = errObj[key];
              }
              if (Object.keys(details).length > 0) {
                modelLogger.warn("[AGENT]", `  Error details: ${JSON.stringify(details, null, 2).substring(0, 2000)}`);
              }
            } catch { /* best-effort */ }

            this.providerHealth.markRateLimited(
              provider,
              modelId,
              rateLimitInfo.retryAfterMs,
              error.message,
              rateLimitInfo.isHard ?? true
            );
            const effectiveCooldown = rateLimitInfo.retryAfterMs != null
              ? `${Math.round(rateLimitInfo.retryAfterMs / 1000)}s (from retry-after)`
              : rateLimitInfo.isHard ? "300s (default hard)" : "60s (default soft)";
            modelLogger.warn("[AGENT]", `  Cooldown: ${effectiveCooldown} — trying next model`);
            // Rate-limited models are exhausted for this run (cooldown handles global skip)
            runFailures.set(modelKey, MAX_FAILURES_PER_MODEL);
            lastSkipReason = "fallback_rate_limit";
            continue;
          }

          // Non-rate-limit error — mark as failed, may retry on next pass
          this.providerHealth.markFailed(provider, modelId, error.message);
          modelLogger.error(
            "[AGENT]",
            `Failed (${currentFailures}/${MAX_FAILURES_PER_MODEL}): ${error.message}`,
            error.stack ?? "(no stack trace)"
          );
          // Log raw error properties for diagnosis
          try {
            const errObj = err as Record<string, any>;
            const details: Record<string, unknown> = {};
            for (const key of ["status", "statusCode", "code", "type", "headers", "body", "response", "error", "cause"]) {
              if (errObj[key] !== undefined) details[key] = errObj[key];
            }
            if (Object.keys(details).length > 0) {
              modelLogger.error("[AGENT]", `Error details: ${JSON.stringify(details, null, 2).substring(0, 2000)}`);
            }
          } catch { /* best-effort */ }
          logErrorAuto(error, { operation: opts.operationLabel, agent: agentName, session: sessionKey, model: modelLabel });

          // If the session timed out, the underlying AgentSession is stuck and
          // must be disposed before the next model attempt — otherwise
          // getOrCreateSessionWithModel would return the same poisoned session.
          if ((error as any).isPromptTimeout) {
            await this.disposeSession(sessionKey);
            modelLogger.log("[AGENT]", `Disposed stuck session after timeout; next attempt will start fresh`);
            lastSkipReason = "fallback_timeout";
          } else {
            lastSkipReason = "fallback_error";
          }
        }
      }

      // If no model was eligible this pass, stop early
      if (!anyEligible) break;
    }

    // All models failed
    throw new Error(
      `All models failed for agent '${agentName}'. Last error: ${lastError?.message ?? "unknown"}`
    );
  }

  /**
   * Get the ordered list of models to try for a session prompt.
   *
   * Only **explicit user overrides** (set via /model, Ctrl+P, or a channel
   * command and persisted to session metadata as `activeModel`) shift the
   * fallback chain start.  The in-memory `currentModel` — which may have been
   * set by a previous automatic fallback — is intentionally NOT used here so
   * that sessions always try the primary model first once its cooldown expires.
   *
   * Fallback order when an explicit override is active:
   *   [override, …remaining fallbacks after override in config order]
   *
   * Fallback order when no override is set:
   *   [primary, …fallbackModels]
   */
  private getModelsToTry(agentConfig: AgentConfig, sessionKey?: string): ModelRef[] {
    const allModels: ModelRef[] = [agentConfig.model, ...(agentConfig.fallbackModels ?? [])];

    if (sessionKey) {
      // Only honour explicit user overrides persisted to session metadata —
      // NOT the in-memory currentModel which may have been set by automatic
      // fallback.  This ensures sessions return to the primary model once
      // its rate-limit cooldown expires instead of staying stuck on a fallback.
      const stored = this.sessionStore.getEntry(sessionKey)?.metadata?.activeModel as
        | { provider: string; modelId: string }
        | undefined;

      if (stored) {
        const overrideRef = allModels.find(
          (m) => m.provider === stored.provider && m.model === stored.modelId
        );
        if (overrideRef) {
          const startIdx = allModels.findIndex(
            (m) => m.provider === overrideRef.provider && m.model === overrideRef.model
          );
          if (startIdx > 0) {
            // Start from the override model; if it fails, continue with remaining fallbacks.
            return allModels.slice(startIdx);
          }
        }
      }
    }

    return allModels;
  }

  /**
   * Execute a prompt with a specific model (internal).
   *
   * Handles both buffered and streaming modes.  When `opts.onDelta` is
   * provided, text deltas are forwarded to the callback as they arrive
   * (streaming mode).  Otherwise only the final accumulated text is
   * returned (buffered mode).
   */
  private async executePromptWithModel(
    sessionKey: string,
    agentName: string,
    message: string,
    modelRef: ModelRef,
    opts?: {
      onToolStart?: OnToolStart;
      onDelta?: (delta: string) => void;
      onAssistantTurnStart?: () => void;
      onAutoCompactionStart?: () => void;
      onAutoCompactionEnd?: (r: { success: boolean; tokensBefore?: number; willRetry: boolean; errorMessage?: string }) => void;
    }
  ): Promise<string> {
    const managed = await this.getOrCreateSessionWithModel(
      sessionKey,
      agentName,
      modelRef,
      opts
    );
    managed.inflightCount++;

    const release = await this.concurrencyLimiter.acquire(modelRef.provider);
    try {
      return await new Promise<string>((resolve, reject) => {
        let responseText = "";
        let settled = false;

        // Inactivity watchdog: fires only if the session emits NO events at all
        // for INACTIVITY_TIMEOUT_MS. The timer is reset on every event received
        // from the subscriber, so a busy agent (many tool calls, long LLM turns)
        // can run indefinitely without being killed — the timeout only triggers
        // when the session has been completely silent (truly stuck / hung).
        const modelLabel = `${modelRef.provider}/${modelRef.model}`;
        const promptLogger = createLogger({ agent: agentName, session: sessionKey, model: modelLabel });

        let watchdog: ReturnType<typeof setTimeout>;
        const armWatchdog = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            if (!settled) {
              settled = true;
              const timeoutErr = new PromptTimeoutError(modelLabel);
              promptLogger.error("[AGENT]", `${timeoutErr.message} (no activity for ${INACTIVITY_TIMEOUT_MS / 1000}s)`);
              // Clean up the subscription so we stop receiving events from the
              // stuck session — unsubscribe is assigned after this closure, but by
              // the time the timer fires it will have been set (setTimeout is async).
              try { unsubscribe(); } catch { /* best-effort */ }
              // Abort the underlying pi session so any in-flight HTTP request is
              // cancelled and the session can be safely disposed by runWithFallback.
              managed.session.abort().catch(() => { /* best-effort */ });
              reject(timeoutErr);
            }
          }, INACTIVITY_TIMEOUT_MS);
        };

        // Arm the watchdog immediately — reset on each incoming event.
        armWatchdog();

        // Wire the heartbeat so core tool executions also reset the watchdog.
        // This prevents long-running tools (e.g. `pnpm test`) from triggering
        // a false timeout — the watchdog only fires if NOTHING happens (no
        // session events AND no tool calls) for the full timeout period.
        managed.heartbeatRef.fn = armWatchdog;

        const unsubscribe = managed.session.subscribe(
          makeSessionSubscriber({
            sessionKey,
            onActivity: armWatchdog,
            onTextReset: () => {
              responseText = "";
              opts?.onAssistantTurnStart?.();
            },
            onTextDelta: (delta) => {
              responseText += delta;
              opts?.onDelta?.(delta);
            },
            onSettle: (errMsg) => {
              if (!settled) {
                settled = true;
                clearTimeout(watchdog);
                managed.heartbeatRef.fn = undefined;
                if (errMsg) {
                  promptLogger.error("[AGENT]", `LLM error: ${errMsg}`);
                  reject(new Error(errMsg));
                } else {
                  resolve(responseText);
                }
              }
            },
            onCleanup: () => unsubscribe(),
            opts,
          })
        );

        managed.session.prompt(message).catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(watchdog);
            const errMsg = err instanceof Error ? err.message : String(err);
            promptLogger.error("[AGENT]", `session.prompt() rejected: ${errMsg}`, err instanceof Error ? err.stack : "");
            unsubscribe();
            reject(err);
          }
        });
      });
    } finally {
      release();
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
    opts?: { onToolStart?: OnToolStart; forceNew?: boolean; sessionFile?: string }
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
    const allowedModels = buildAllowedModels(agentConfig.model, agentConfig.fallbackModels);
    validateModelAllowed(modelRef.provider, modelRef.model, allowedModels);

    // Check if we need to recreate the session with a different model
    const existing = this.sessions.get(sessionKey);

    // If session exists with the same model, return it (but update onToolStart
    // if the caller provided a new one — this is needed for runtime verbose
    // toggles and other callback changes without recreating the session).
    if (existing) {
      const { provider, model: modelId } = modelRef;
      const currentRef = existing.currentModel;

      if (
        currentRef.provider === provider &&
        currentRef.model === modelId &&
        currentRef.compactionThreshold === modelRef.compactionThreshold
      ) {
        if (opts?.onToolStart !== undefined) {
          existing.toolStartHandlerRef.fn = opts.onToolStart;
        }
        return existing;
      }

      // Different model — dispose and recreate
      createLogger({ agent: agentName, session: sessionKey, model: `${currentRef.provider}/${currentRef.model}` }).log(
        "[AGENT]",
        `Switching model to ${provider}/${modelId}`
      );
      existing.session.dispose();
      this.sessions.delete(sessionKey);
    }

    // Determine session file
    let sessionFile: string | undefined;
    if (opts?.sessionFile) {
      sessionFile = opts.sessionFile;
    } else if (opts?.forceNew) {
      sessionFile = this.sessionStore.createSession(sessionKey, agentName);
    } else {
      sessionFile = this.sessionStore.getSessionFile(sessionKey);
      if (!sessionFile) {
        sessionFile = this.sessionStore.createSession(sessionKey, agentName);
      }
    }

    // Check whether the session has a stored model preference (set when the
    // user explicitly switched models).  If it is in the agent's allowed list,
    // honour it instead of always starting with the caller's modelRef.
    // This makes model selection persist across restarts and channels.
    if (!opts?.forceNew && !opts?.sessionFile) {
      const storedModel = this.sessionStore.getEntry(sessionKey)?.metadata?.activeModel as
        | { provider: string; modelId: string }
        | undefined;
      if (storedModel) {
        const allowedModels = buildAllowedModels(agentConfig.model, agentConfig.fallbackModels);
        const isAllowed = allowedModels.some(
          (m) => m.provider === storedModel.provider && m.modelId === storedModel.modelId
        );
        if (isAllowed) {
          // Find the full ModelRef (with thinkingLevel etc.) from the agent config
          const allRefs: ModelRef[] = [agentConfig.model, ...(agentConfig.fallbackModels ?? [])];
          const storedRef = allRefs.find(
            (m) => m.provider === storedModel.provider && m.model === storedModel.modelId
          );
          if (storedRef && (storedRef.provider !== modelRef.provider || storedRef.model !== modelRef.model)) {
            createLogger({ agent: agentName, session: sessionKey, model: `${storedRef.provider}/${storedRef.model}` }).log(
              "[AGENT]",
              `Restoring stored model preference (overrides default ${modelRef.provider}/${modelRef.model})`
            );
            modelRef = storedRef;
          }
        }
      }
    }

    createLogger({ agent: agentName, session: sessionKey, model: `${modelRef.provider}/${modelRef.model}` }).log("[AGENT]", `Creating session`);

    // Resolve the full SDK model so we have the `input` capability array.
    // This is also used below for the pi session; resolve once and reuse.
    const resolvedModel = this.resolveModelFromRef(modelRef);

    // Mutable model ref shared with core tool closures — updated on fallback switch.
    const currentModelRef: CurrentModelRef = {
      current: {
        provider: resolvedModel.provider,
        id: resolvedModel.id,
        input: resolvedModel.input as ("text" | "image")[],
      },
    };

    // Validate skill dependencies
    validateSkillDeps(agentConfig.skills ?? [], agentConfig.tools, this.loadedSkills);

    // Build pi session
    const toolStartHandlerRef: ToolStartHandlerRef = { fn: opts?.onToolStart };
    const heartbeatRef: HeartbeatRef = { fn: undefined };
    const agentDir = resolve(this.beigeDir, "agents", agentName);
    const workspaceDir = agentConfig.workspaceDir 
      ?? resolve(agentDir, "workspace");
    const sessionContext = { ...parseSessionKey(sessionKey), agentName, agentDir, workspaceDir, onToolStart: toolStartHandlerRef.fn };
    const coreTools = createCoreTools(agentName, this.sandbox, this.audit, toolStartHandlerRef, sessionContext, currentModelRef, heartbeatRef);
    const toolContext = buildPluginToolContext(agentConfig.tools, this.pluginRegistry);
    const skillContext = buildSkillContext(agentConfig.skills ?? [], this.loadedSkills);
    const systemPrompt = buildSystemPrompt(agentName, toolContext, skillContext, sessionContext);
    const agentsFiles = readWorkspaceAgentsMd(workspaceDir);

    const model = resolvedModel;

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
        compaction: buildCompactionSettings(
          modelRef,
          model.contextWindow,
          createLogger({ agent: agentName, session: sessionKey, model: `${modelRef.provider}/${modelRef.model}` })
        ),
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
      currentModelRef,
      heartbeatRef,
    };

    this.sessions.set(sessionKey, managed);
    createLogger({ agent: agentName, session: sessionKey, model: `${modelRef.provider}/${modelRef.model}` }).log("[AGENT]", `Session ready`);

    // Fire sessionCreated hook (fire-and-forget — don't block session return)
    this.pluginRegistry.executeSessionCreated({
      sessionKey,
      agentName,
      channel: parseSessionKey(sessionKey).channel,
    }).catch((err) => createLogger({ agent: agentName, session: sessionKey, model: `${modelRef.provider}/${modelRef.model}` }).error(`[AGENT]`, `sessionCreated hook error:`, err));

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
    createLogger().log("[AGENT]", "Draining in-flight LLM calls...");

    // Wait for every managed session to have inflightCount === 0.
    const drainSession = (managed: ManagedSession): Promise<void> => {
      if (managed.inflightCount === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        managed.drainResolvers.push(resolve);
      });
    };

    // Also wait for active direct LLM streams proxied via /api/chat/stream
    // (TUI sessions whose AgentSession lives in the TUI process, not here).
    const drainDirectStreams = (): Promise<void> => {
      if (this.activeStreamCount === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        this.streamDrainResolvers.push(resolve);
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
        Promise.all([...pending.map(drainSession), drainDirectStreams()]),
        timeoutPromise,
      ]);
      // Check again — no new calls should have started after drainResolvers fire
      quiet =
        [...this.sessions.values()].every((s) => s.inflightCount === 0) &&
        this.activeStreamCount === 0;
    }

    createLogger().log("[AGENT]", "All in-flight calls finished. Disposing sessions...");
    for (const [, managed] of this.sessions) {
      managed.session.dispose();
    }
    this.sessions.clear();
    createLogger().log("[AGENT]", "Sessions drained and disposed.");
  }

  /**
   * Start a new session for a key (disposes old one).
   * If an existing session has an onToolStart handler, it is re-registered.
   */
  async newSession(
    sessionKey: string,
    agentName: string,
    opts?: { onToolStart?: OnToolStart; onAutoCompactionStart?: () => void; onAutoCompactionEnd?: (r: { success: boolean; tokensBefore?: number; willRetry: boolean; errorMessage?: string }) => void }
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
        channel: parseSessionKey(sessionKey).channel,
      }).catch((err) => createLogger({ agent: existing.agentName, session: sessionKey, model: `${existing.currentModel.provider}/${existing.currentModel.model}` }).error(`[AGENT]`, `sessionDisposed hook error:`, err));
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

  // ── Gateway API helpers (used by handleChatStream) ─────────────────

  /**
   * Get the ordered list of models to try for a direct LLM stream call
   * (used by GatewayAPI.handleChatStream).
   *
   * Returns the requested model followed by any subsequent fallback models
   * so the endpoint can transparently retry on rate-limit errors using the
   * same ProviderHealthTracker that AgentManager uses for session prompts.
   */
  getModelsToTryForStream(
    agentName: string,
    requestedProvider: string,
    requestedModelId: string
  ): ModelRef[] {
    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      // Unknown agent — just try what was requested
      return [{ provider: requestedProvider, model: requestedModelId }];
    }

    const allModels = this.getModelsToTry(agentConfig);
    const startIdx = allModels.findIndex(
      (m) => m.provider === requestedProvider && m.model === requestedModelId
    );

    // If the requested model isn't in the agent's configured list, try only it
    if (startIdx === -1) {
      return [{ provider: requestedProvider, model: requestedModelId }];
    }

    // Return from the requested model onward (skip models earlier in the list
    // that the TUI may have already tried in a previous request)
    return allModels.slice(startIdx);
  }

  /** True if the given model is currently in rate-limit cooldown. */
  isModelCoolingDown(provider: string, modelId: string): boolean {
    return this.providerHealth.isCoolingDown(provider, modelId);
  }

  /** Mark a model as healthy after a successful LLM call. */
  markModelHealthy(provider: string, modelId: string): void {
    this.providerHealth.markHealthy(provider, modelId);
  }

  /** Mark a model as rate-limited so it is skipped for the cooldown period. */
  markModelRateLimited(provider: string, modelId: string, retryAfterMs?: number, message?: string, hard: boolean = true): void {
    this.providerHealth.markRateLimited(provider, modelId, retryAfterMs, message, hard);
  }

  /** Mark a model as failed (non-rate-limit error) for health tracking purposes. */
  markModelFailed(provider: string, modelId: string, message?: string): void {
    this.providerHealth.markFailed(provider, modelId, message);
  }

  /** Get health/cooldown info for a model. Returns undefined if no data recorded. */
  getModelHealth(provider: string, modelId: string): {
    isCoolingDown: boolean;
    remainingCooldownMs: number;
    lastError?: string;
    consecutiveFailures: number;
  } | undefined {
    const entry = this.providerHealth.get(provider, modelId);
    if (!entry) return undefined;
    return {
      isCoolingDown: this.providerHealth.isCoolingDown(provider, modelId),
      remainingCooldownMs: this.providerHealth.getRemainingCooldown(provider, modelId),
      lastError: entry.lastError,
      consecutiveFailures: entry.consecutiveFailures,
    };
  }

  /**
   * Increment the count of active direct LLM streams (TUI proxy calls).
   * Call this when /api/chat/stream begins; pair with decrementActiveStream.
   * drainAll() waits for this count to reach zero before disposing sessions.
   */
  incrementActiveStream(): void {
    this.activeStreamCount++;
  }

  /**
   * Decrement the active stream count and wake any drainAll() waiters
   * if the count reaches zero.
   */
  decrementActiveStream(): void {
    this.activeStreamCount = Math.max(0, this.activeStreamCount - 1);
    if (this.activeStreamCount === 0 && this.streamDrainResolvers.length > 0) {
      const resolvers = this.streamDrainResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
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
   * Get the onToolStart callback for a session (used for verbose notifications).
   */
  getOnToolStartCallback(sessionKey: string): ((toolName: string, params: Record<string, unknown>) => void) | undefined {
    return this.sessions.get(sessionKey)?.toolStartHandlerRef.fn;
  }

  /** Expose the model registry so plugins can look up model metadata (e.g. context window size). */
  getModelRegistry(): ModelRegistry {
    return this.modelRegistry;
  }

  /**
   * Manually compact the session context.
   * Aborts any in-flight operation first, then runs an LLM summarisation pass
   * and replaces the session history with the compacted version.
   *
   * Throws if:
   *   - No session exists for the key (user hasn't sent a message yet)
   *   - The session is already compacted / too small to compact
   *   - No API key is available for the current model
   */
  async compactSession(sessionKey: string): Promise<{ tokensBefore: number; summary: string }> {
    // If no in-memory session exists the gateway may have been restarted after the
    // session was originally created. The session file is still on disk — restore it
    // from the session store before compacting.
    if (!this.sessions.has(sessionKey)) {
      const agentName = this.sessionStore.getAgentName(sessionKey);
      if (!agentName) {
        throw new Error("No session found for this chat. Send a message first to start one.");
      }
      createLogger({ agent: agentName, session: sessionKey }).log(
        "[AGENT]", "Restoring session for compaction"
      );
      await this.getOrCreateSession(sessionKey, agentName);
    }

    const managed = this.sessions.get(sessionKey);
    if (!managed) {
      throw new Error("Failed to restore session. Send a message first.");
    }

    const compactLogger = createLogger({ agent: managed.agentName, session: sessionKey, model: `${managed.currentModel.provider}/${managed.currentModel.model}` });
    compactLogger.log("[AGENT]", "Manual compaction requested");
    const result = await managed.session.compact();
    compactLogger.log("[AGENT]", `Compaction complete: ${result.tokensBefore} tokens freed`);
    return { tokensBefore: result.tokensBefore, summary: result.summary };
  }

  /**
   * Whether a prompt is currently in flight for a session.
   * Used by channel plugins to decide whether to steer vs. start a new turn.
   */
  isSessionActive(sessionKey: string): boolean {
    const managed = this.sessions.get(sessionKey);
    return managed !== undefined && managed.inflightCount > 0;
  }

  /**
   * Abort the current operation for a session and wait until the agent is idle.
   * The in-flight prompt/promptStreaming call will resolve with whatever
   * partial response the agent had accumulated.
   * No-op if no session exists or the session is already idle.
   */
  async abortSession(sessionKey: string): Promise<void> {
    const managed = this.sessions.get(sessionKey);
    if (!managed) return;
    await managed.session.abort();
  }

  /**
   * Steer the currently running session with a new message.
   * The message is delivered after the current tool finishes, interrupting
   * remaining queued tool calls — exactly like pressing ESC and typing in the TUI.
   * No-op if no session exists for the key.
   */
  async steerSession(sessionKey: string, text: string): Promise<void> {
    const managed = this.sessions.get(sessionKey);
    if (!managed) return;
    await managed.session.steer(text);
  }
}

/**
 * Build a session event subscriber that correctly handles the full lifecycle
 * of a prompt, including post-response auto-compaction.
 *
 * Key behaviour:
 * - On agent_end: settle the promise (resolve or reject) but keep the
 *   subscription alive briefly so compaction events can still be received.
 *   Auto-compaction fires AFTER agent_end inside _processAgentEvent, so if
 *   we unsubscribed immediately on agent_end we'd never see it.
 * - If auto_compaction_start fires within 2 s of agent_end: extend the
 *   subscription until auto_compaction_end arrives.
 * - Otherwise: unsubscribe after the 2 s safety timeout.
 */
function makeSessionSubscriber(params: {
  sessionKey: string;
  /** Called on every event — used to reset the inactivity watchdog timer. */
  onActivity?: () => void;
  onTextReset: () => void;
  onTextDelta: (delta: string) => void;
  onSettle: (errMsg: string | undefined) => void;
  onCleanup: () => void;
  opts?: {
    onAutoCompactionStart?: () => void;
    onAutoCompactionEnd?: (result: { success: boolean; tokensBefore?: number; willRetry: boolean; errorMessage?: string }) => void;
  };
}) {
  const { onActivity, onTextReset, onTextDelta, onSettle, onCleanup, opts } = params;

  let settled = false;
  let compactionInProgress = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    onCleanup();
  };

  return (event: { type: string; message?: { role: string }; assistantMessageEvent?: { type: string; delta?: string }; messages?: readonly unknown[]; result?: { tokensBefore?: number }; aborted?: boolean; willRetry?: boolean; errorMessage?: string }) => {
    // Reset the inactivity watchdog on every event — the agent is alive as
    // long as it keeps emitting (tool calls, deltas, retries, turns, etc.).
    onActivity?.();

    if (event.type === "message_start" && event.message?.role === "assistant") {
      onTextReset();
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta" &&
      event.assistantMessageEvent.delta !== undefined
    ) {
      onTextDelta(event.assistantMessageEvent.delta);
    }

    if (event.type === "agent_end") {
      const errMsg = extractLLMError((event.messages ?? []) as Parameters<typeof extractLLMError>[0]);
      settled = true;
      onSettle(errMsg);

      // Stay subscribed briefly so we can catch any compaction that starts
      // immediately after (compaction is triggered inside _processAgentEvent
      // after _emit(agent_end), so it follows in the same async chain).
      cleanupTimer = setTimeout(() => {
        if (!compactionInProgress) cleanup();
      }, 2000);
    }

    if (event.type === "auto_compaction_start") {
      compactionInProgress = true;
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      opts?.onAutoCompactionStart?.();
    }

    if (event.type === "auto_compaction_end") {
      compactionInProgress = false;
      opts?.onAutoCompactionEnd?.({
        success: !event.aborted && event.result !== undefined,
        tokensBefore: event.result?.tokensBefore,
        willRetry: event.willRetry ?? false,
        errorMessage: event.errorMessage,
      });
      if (settled) cleanup();
    }
  };
}

/**
 * Inspect the messages from an agent_end event and return the errorMessage
 * from the last assistant message if it ended with stopReason "error".
 * Returns undefined if the session ended normally.
 */
/**
 * Build CompactionSettings for a model session.
 *
 * If the ModelRef has a compactionThreshold, convert it to a reserveTokens
 * value that makes shouldCompact() trigger at exactly that token count:
 *
 *   shouldCompact fires when: contextTokens > contextWindow - reserveTokens
 *   → reserveTokens = contextWindow - compactionThreshold
 *
 * Falls back to pi's default (reserveTokens = 16384) when no threshold is set.
 *
 * @param logger  Scoped logger carrying the current agent/session/model context.
 */
function buildCompactionSettings(
  modelRef: ModelRef,
  contextWindow: number,
  logger: import("./logger.js").ScopedLogger
): { enabled: boolean; reserveTokens?: number } {
  if (modelRef.compactionThreshold === undefined) {
    return { enabled: true };
  }

  const reserveTokens = contextWindow - modelRef.compactionThreshold;
  if (reserveTokens <= 0) {
    logger.warn(
      "[AGENT]",
      `compactionThreshold ${modelRef.compactionThreshold} is >= contextWindow ` +
      `${contextWindow} — using default threshold.`
    );
    return { enabled: true };
  }

  logger.log(
    "[AGENT]",
    `Custom compaction threshold: ${modelRef.compactionThreshold} tokens (reserveTokens=${reserveTokens})`
  );
  return { enabled: true, reserveTokens };
}

function extractLLMError(messages: readonly { role: string; stopReason?: string; errorMessage?: string; usage?: unknown; provider?: string; model?: string }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      if (msg.stopReason === "error" && msg.errorMessage) {
        // Skip context overflow errors — pi handles those transparently via
        // auto-compaction + retry. Surfacing them as rejections would
        // interfere with that mechanism and double-report the error.
        if (isContextOverflow(msg as Parameters<typeof isContextOverflow>[0])) {
          return undefined;
        }
        return msg.errorMessage;
      }
      // Last assistant message found but not an error — session ended normally
      return undefined;
    }
  }
  return undefined;
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
export function buildPluginToolContext(
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

export function buildSystemPrompt(agentName: string, toolContext: string, skillContext: string = "", sessionCtx?: SessionContext): string {
  // Build the session context section only for non-TUI channels where the
  // channel/chatId/threadId are meaningful (e.g. Telegram, Discord).
  let sessionContextSection = "";
  if (sessionCtx && sessionCtx.channel && sessionCtx.channel !== "tui") {
    const lines = [
      "## Session Context",
      "",
      "The current conversation was initiated via an external channel. Use these",
      "details when calling channel tools that need to address the user (e.g.",
      "sending a file or message back to the same chat).",
      "",
      `- **Channel**: ${sessionCtx.channel}`,
      `- **Chat ID**: ${sessionCtx.chatId ?? "none"}`,
      `- **Thread ID**: ${sessionCtx.threadId ?? "none"}`,
      "",
    ];
    sessionContextSection = lines.join("\n") + "\n";
  }

  return SYSTEM_PROMPT_TEMPLATE
    .replace(/\{\{agentName\}\}/g, agentName)
    .replace(/\{\{toolContext\}\}/g, toolContext)
    .replace(/\{\{skillContext\}\}/g, skillContext)
    .replace(/\{\{sessionContext\}\}/g, sessionContextSection);
}
