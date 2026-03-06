import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface AuditEntry {
  ts: string;
  agent: string;
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

/** Format a Date as "YYYY-MM-DD HH:mm:ss" in local time. */
function formatTimestamp(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export class AuditLogger {
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    mkdirSync(dirname(logPath), { recursive: true });
  }

  log(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(this.logPath, line);

    const ts = formatTimestamp(new Date(entry.ts));
    const emoji = entry.decision === "allowed" ? "✓" : "✗";
    const typeLabel = entry.type === "core_tool" ? "CORE" : "TOOL";
    const argsStr = entry.args.join(" ");
    const agentTool = `${entry.agent}/${entry.tool}`;

    if (entry.phase === "started") {
      // "→ started" line — no duration yet
      console.log(
        `[AUDIT] [${ts}] ${emoji} ${typeLabel} ${agentTool} ${argsStr} → ${entry.decision}, started`
      );
    } else {
      // "→ finished" line — include duration (and error if present)
      const durationStr = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : "";
      const errorStr = entry.error ? `, error: ${entry.error}` : "";
      console.log(
        `[AUDIT] [${ts}] ${emoji} ${typeLabel} ${agentTool} ${argsStr} → finished${durationStr}${errorStr}`
      );
    }
  }

  /**
   * Create a timed audit entry. Call .finish() when done.
   * For "denied" decisions, logs immediately (no started/finished split).
   * For "allowed" decisions, logs a "started" line immediately, then a "finished"
   * line when .finish() is called.
   */
  start(
    agent: string,
    type: "core_tool" | "tool",
    tool: string,
    args: string[],
    decision: "allowed" | "denied",
    target?: "gateway" | "sandbox"
  ): AuditTimer {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      agent,
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
      ts: new Date().toISOString(),
      phase: "finished",
      durationMs: Date.now() - this.startTime,
      exitCode: result.exitCode,
      outputBytes: result.outputBytes,
      error: result.error,
    };
    this.logger.log(finishedEntry);
  }
}
