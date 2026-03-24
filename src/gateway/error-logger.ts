/**
 * Structured error logging for the Beige gateway.
 *
 * Provides:
 * - Error classification (network, auth, rate_limit, model, system, unknown)
 * - Structured JSON logging to file and console
 * - Context capture (agent, session, model, operation)
 *
 * @see BEIGE-005 for design rationale
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "fs";
import { join, resolve } from "path";
import { beigeDir } from "../paths.js";

// ── Types ────────────────────────────────────────────────────────────────

export type ErrorType =
  | "network"      // Timeout, connection refused, DNS failure
  | "auth"         // Invalid API key, unauthorized, forbidden
  | "rate_limit"   // 429, too many requests
  | "model"        // Context too long, invalid response, model error
  | "system"       // Out of memory, disk full, process error
  | "unknown";     // Everything else

export interface ErrorContext {
  agent?: string;
  session?: string;
  model?: string;
  operation: string;
  [key: string]: unknown;
}

export interface ErrorLogEntry {
  timestamp: string;
  type: ErrorType;
  message: string;
  stack?: string;
  context: ErrorContext;
}

// ── Configuration ────────────────────────────────────────────────────────

const MAX_LOG_SIZE_MB = 10;
const MAX_LOG_FILES = 5;

// ── Error Classification ──────────────────────────────────────────────────

/**
 * Classify an error into a known type based on its message and properties.
 */
export function classifyError(err: unknown): ErrorType {
  if (!(err instanceof Error)) {
    return "unknown";
  }

  const msg = err.message.toLowerCase();
  const name = err.constructor.name.toLowerCase();

  // Network errors
  if (
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("etimedout") ||
    msg.includes("eai_again") // DNS lookup failure
  ) {
    return "network";
  }

  // Auth errors
  if (
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("authentication") ||
    msg.includes("forbidden") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("api key") ||
    msg.includes("access token") ||
    msg.includes("permission denied")
  ) {
    return "auth";
  }

  // Rate limits
  if (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("quota") ||
    msg.includes("rate_limit") ||
    name.includes("ratelimit")
  ) {
    return "rate_limit";
  }

  // Model errors
  if (
    msg.includes("context") ||
    msg.includes("token") ||
    msg.includes("prompt is too long") ||
    msg.includes("maximum context") ||
    msg.includes("model") && msg.includes("not found") ||
    msg.includes("invalid response") ||
    msg.includes("malformed") ||
    msg.includes("parsing") && msg.includes("response")
  ) {
    return "model";
  }

  // System errors
  if (
    msg.includes("out of memory") ||
    msg.includes("enomem") ||
    msg.includes("enospc") || // No space left on device
    msg.includes("disk full") ||
    msg.includes("spawn") ||
    msg.includes("child process") ||
    name.includes("systemerror") ||
    name.includes("rangeerror")
  ) {
    return "system";
  }

  return "unknown";
}

// ── Logging Functions ─────────────────────────────────────────────────────

let errorLogPath: string | null = null;

/**
 * Get the path to the error log file.
 * Lazily initializes the log directory if needed.
 */
function getErrorLogPath(): string {
  if (!errorLogPath) {
    const logsDir = resolve(beigeDir(), "logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    errorLogPath = join(logsDir, "error.log");
  }
  return errorLogPath;
}

/**
 * Rotate log files if the current log exceeds MAX_LOG_SIZE_MB.
 * Keeps up to MAX_LOG_FILES rotated logs.
 */
function rotateLogIfNeeded(): void {
  const logPath = getErrorLogPath();
  if (!existsSync(logPath)) return;

  try {
    const stats = statSync(logPath);
    const sizeMB = stats.size / (1024 * 1024);

    if (sizeMB >= MAX_LOG_SIZE_MB) {
      // Delete oldest rotated file if it exists
      const oldestPath = `${logPath}.${MAX_LOG_FILES}`;
      if (existsSync(oldestPath)) {
        // Use unlinkSync via dynamic import to avoid unused import warning
        import("fs").then(({ unlinkSync }) => unlinkSync(oldestPath)).catch(() => {});
      }

      // Rotate existing files: .4 -> .5, .3 -> .4, etc.
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const currentPath = `${logPath}.${i}`;
        const nextPath = `${logPath}.${i + 1}`;
        if (existsSync(currentPath)) {
          renameSync(currentPath, nextPath);
        }
      }

      // Rename current log to .1
      renameSync(logPath, `${logPath}.1`);
      console.log("[ERROR_LOGGER] Rotated error log");
    }
  } catch {
    // Ignore rotation errors — logging is best-effort
  }
}

/**
 * Log a structured error entry.
 * Writes to both console.error and the error log file.
 */
export function logError(
  type: ErrorType,
  message: string,
  context: ErrorContext,
  err?: Error
): void {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    context,
  };

  if (err?.stack) {
    entry.stack = err.stack;
  }

  // Log to console with color-coded type
  const typeColors: Record<ErrorType, string> = {
    network: "\x1b[33m",    // Yellow
    auth: "\x1b[35m",       // Magenta
    rate_limit: "\x1b[36m", // Cyan
    model: "\x1b[34m",      // Blue
    system: "\x1b[31m",     // Red
    unknown: "\x1b[37m",    // White
  };
  const reset = "\x1b[0m";
  const color = typeColors[type];

  console.error(
    `${color}[ERROR:${type.toUpperCase()}]${reset} ${message} ` +
    `[${context.operation}]` +
    (context.agent ? ` agent=${context.agent}` : "") +
    (context.model ? ` model=${context.model}` : "")
  );

  // Write to file (best-effort)
  try {
    rotateLogIfNeeded();
    appendFileSync(getErrorLogPath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch (writeErr) {
    // If we can't write to the log file, at least log to console
    console.error("[ERROR_LOGGER] Failed to write to error log:", writeErr);
  }
}

/**
 * Convenience wrapper that classifies and logs an error in one call.
 */
export function logErrorAuto(err: unknown, context: ErrorContext): void {
  const type = classifyError(err);
  const message = err instanceof Error ? err.message : String(err);
  logError(type, message, context, err instanceof Error ? err : undefined);
}

/**
 * Log an unhandled rejection with full context.
 * Call this from the gateway startup to catch any unhandled promise rejections.
 */
export function logUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
  const type = classifyError(reason);
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : `Non-Error rejection: ${JSON.stringify(reason)}`;

  logError(type, `Unhandled rejection: ${message}`, {
    operation: "unhandledRejection",
    promise: "[Promise]", // Don't serialize the promise itself
  }, reason instanceof Error ? reason : undefined);
}

/**
 * Create a child logger with pre-filled context.
 * Useful for operations that share the same agent/session/model.
 */
export function createErrorLogger(baseContext: ErrorContext): {
  log: (type: ErrorType, message: string, err?: Error, extraContext?: ErrorContext) => void;
  logAuto: (err: unknown, extraContext?: ErrorContext) => void;
} {
  return {
    log(type: ErrorType, message: string, err?: Error, extraContext?: ErrorContext) {
      logError(type, message, { ...baseContext, ...extraContext }, err);
    },
    logAuto(err: unknown, extraContext?: ErrorContext) {
      logErrorAuto(err, { ...baseContext, ...extraContext });
    },
  };
}
