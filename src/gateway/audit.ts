import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { formatLocalTimestamp } from "./logger.js";
import {
  rotateFileIfNeeded,
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_MAX_FILES,
} from "./log-rotation.js";

export interface AuditEntry {
  ts: string;
  agent: string;
  session?: string;
  model?: string;
  channel?: string;
  phase: "started" | "finished";
  type: "core_tool" | "tool";
  tool: string;
  args: string[];
  decision: "allowed" | "denied";
  target?: "gateway" | "sandbox";
  durationMs?: number;
  exitCode?: number;
  outputBytes?: number;
  error?: string;
}

/**
 * Optional session/model/channel context attached to an audit entry.
 * All fields are optional so callers only need to supply what they know.
 */
export interface AuditContext {
  session?: string;
  model?: string;
  channel?: string;
}

/** Format context fields as a bracketed suffix, e.g. " [session=… model=… channel=…]". */
function contextSuffix(entry: AuditEntry): string {
  const parts: string[] = [];
  if (entry.session) parts.push(`session=${entry.session}`);
  if (entry.model)   parts.push(`model=${entry.model}`);
  if (entry.channel) parts.push(`channel=${entry.channel}`);
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

export class AuditLogger {
  private logPath: string;
  private maxSizeBytes: number;
  private maxFiles: number;

  constructor(
    logPath: string,
    opts?: { maxSizeBytes?: number; maxFiles?: number }
  ) {
    this.logPath = logPath;
    this.maxSizeBytes = opts?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
    mkdirSync(dirname(logPath), { recursive: true });
  }

  log(entry: AuditEntry): void {
    // Rotate before appending so we never write past the size limit.
    rotateFileIfNeeded(this.logPath, this.maxSizeBytes, this.maxFiles);

    const line = JSON.stringify(entry) + "\n";
    appendFileSync(this.logPath, line);

    const ts = formatLocalTimestamp(new Date(entry.ts));
    const emoji = entry.decision === "allowed" ? "✓" : "✗";
    const typeLabel = entry.type === "core_tool" ? "CORE" : "TOOL";
    const argsStr = entry.args.join(" ");
    const agentTool = `${entry.agent}/${entry.tool}`;
    const ctx = contextSuffix(entry);

    if (entry.phase === "started") {
      // "→ started" line — no duration yet
      console.log(
        `[AUDIT] [${ts}]${ctx} ${emoji} ${typeLabel} ${agentTool} ${argsStr} → ${entry.decision}, started`
      );
    } else {
      // "→ finished" line — include duration (and error if present)
      const durationStr = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : "";
      const errorStr = entry.error ? `, error: ${entry.error}` : "";
      console.log(
        `[AUDIT] [${ts}]${ctx} ${emoji} ${typeLabel} ${agentTool} ${argsStr} → finished${durationStr}${errorStr}`
      );
    }
  }

  /**
   * Create a timed audit entry. Call .finish() when done.
   * For "denied" decisions, logs immediately (no started/finished split).
   * For "allowed" decisions, logs a "started" line immediately, then a "finished"
   * line when .finish() is called.
   *
   * @param ctx  Optional session/model/channel context so every audit line is
   *             traceable back to the exact session and model that triggered it.
   */
  start(
    agent: string,
    type: "core_tool" | "tool",
    tool: string,
    args: string[],
    decision: "allowed" | "denied",
    target?: "gateway" | "sandbox",
    ctx?: AuditContext
  ): AuditTimer {
    const entry: AuditEntry = {
      ts: formatLocalTimestamp(),
      agent,
      ...(ctx?.session  !== undefined ? { session: ctx.session }   : {}),
      ...(ctx?.model    !== undefined ? { model: ctx.model }       : {}),
      ...(ctx?.channel  !== undefined ? { channel: ctx.channel }   : {}),
      phase: decision === "denied" ? "finished" : "started",
      type,
      tool,
      args,
      decision,
      target,
    };

    // Always log on start — denied tools are fully logged here; allowed tools
    // get a "started" line now and a "finished" line after execution.
    this.log(entry);

    return new AuditTimer(this, entry);
  }
}

export class AuditTimer {
  private startTime: number;

  constructor(
    private logger: AuditLogger,
    private entry: AuditEntry
  ) {
    this.startTime = Date.now();
  }

  finish(result: { exitCode?: number; outputBytes?: number; error?: string }): void {
    // Only write a "finished" entry for allowed tools (denied was already fully logged).
    if (this.entry.decision === "denied") return;

    const finishedEntry: AuditEntry = {
      ...this.entry,
      ts: formatLocalTimestamp(),
      phase: "finished",
      durationMs: Date.now() - this.startTime,
      exitCode: result.exitCode,
      outputBytes: result.outputBytes,
      error: result.error,
    };
    this.logger.log(finishedEntry);
  }
}
