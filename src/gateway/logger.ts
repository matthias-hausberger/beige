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

/**
 * Format a Date as a local-timezone ISO-8601-like string.
 *
 * Unlike Date.toISOString() which always outputs UTC (Z suffix),
 * this produces a human-readable local timestamp with timezone offset.
 *
 * @param date   Date to format (defaults to now).
 * @param short  If true, use compact offset like "+2" instead of "+02:00".
 *               Short format is NOT parseable by `new Date()` — use only for display/logs.
 *               Default: false (produces parseable "+02:00" format).
 */
export function formatLocalTimestamp(date: Date = new Date(), short: boolean = false): string {
  const offsetMin = date.getTimezoneOffset();
  const sign = offsetMin <= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMin);
  const tzHours = Math.floor(absOffset / 60);
  const tzMinutes = absOffset % 60;

  let tz: string;
  if (short) {
    // Compact: "+2", "-5", "+5:30"
    tz = tzMinutes === 0
      ? `${sign}${tzHours}`
      : `${sign}${tzHours}:${String(tzMinutes).padStart(2, "0")}`;
  } else {
    // Standard parseable: "+02:00", "-05:00", "+05:30"
    tz = `${sign}${String(tzHours).padStart(2, "0")}:${String(tzMinutes).padStart(2, "0")}`;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${tz}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts(): string {
  return formatLocalTimestamp(new Date(), true);
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
