/**
 * Structured gateway logger.
 *
 * Wraps console.log / console.error with:
 * - ISO-8601 timestamps on every line
 * - Optional agent / session / channel context tags
 * - A child-logger factory for scoped log contexts (agent, session)
 *
 * All output still goes to stdout/stderr so it is captured by the existing
 * gateway.log redirect and any process supervisor (systemd, Docker, pm2).
 *
 * Usage:
 *   import { log, warn, error, createLogger } from "./logger.js";
 *
 *   // Top-level
 *   log("[GATEWAY]", "Started");
 *
 *   // Scoped child logger
 *   const logger = createLogger({ agent: "assistant", session: "tui:assistant:default" });
 *   logger.log("[AGENT]", "Session ready");
 *   // → 2026-03-28T01:32:00.123Z [AGENT] agent=assistant session=tui:assistant:default Session ready
 */

export interface LogContext {
  agent?: string;
  session?: string;
  channel?: string;
  /** Active model identifier, e.g. "anthropic/claude-sonnet-4-5". */
  model?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function contextSuffix(ctx: LogContext): string {
  const parts: string[] = [];
  if (ctx.agent) parts.push(`agent=${ctx.agent}`);
  if (ctx.session) parts.push(`session=${ctx.session}`);
  if (ctx.channel) parts.push(`channel=${ctx.channel}`);
  if (ctx.model) parts.push(`model=${ctx.model}`);
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

// ── Global helpers (no context) ───────────────────────────────────────────────

/** Info-level log to stdout with timestamp. */
export function log(prefix: string, ...args: unknown[]): void {
  console.log(`${ts()} ${prefix}`, ...args);
}

/** Warning-level log to stderr with timestamp. */
export function warn(prefix: string, ...args: unknown[]): void {
  console.warn(`${ts()} ${prefix}`, ...args);
}

/** Error-level log to stderr with timestamp. */
export function error(prefix: string, ...args: unknown[]): void {
  console.error(`${ts()} ${prefix}`, ...args);
}

// ── Child logger ──────────────────────────────────────────────────────────────

export interface ScopedLogger {
  log(prefix: string, ...args: unknown[]): void;
  warn(prefix: string, ...args: unknown[]): void;
  error(prefix: string, ...args: unknown[]): void;
  /** Derive a child logger with additional / overridden context. */
  child(extra: LogContext): ScopedLogger;
}

/**
 * Create a scoped logger that prepends agent/session/channel context to every
 * log line.  Use this inside agent-manager and session handlers so every log
 * line is traceable back to a specific agent+session without manual bookkeeping.
 */
export function createLogger(ctx: LogContext = {}): ScopedLogger {
  const suffix = contextSuffix(ctx);

  return {
    log(prefix: string, ...args: unknown[]): void {
      console.log(`${ts()} ${prefix}${suffix}`, ...args);
    },
    warn(prefix: string, ...args: unknown[]): void {
      console.warn(`${ts()} ${prefix}${suffix}`, ...args);
    },
    error(prefix: string, ...args: unknown[]): void {
      console.error(`${ts()} ${prefix}${suffix}`, ...args);
    },
    child(extra: LogContext): ScopedLogger {
      return createLogger({ ...ctx, ...extra });
    },
  };
}
