import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface AuditEntry {
  ts: string;
  agent: string;
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

export class AuditLogger {
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    mkdirSync(dirname(logPath), { recursive: true });
  }

  log(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(this.logPath, line);
    // Also log to console for dev visibility
    const emoji = entry.decision === "allowed" ? "✓" : "✗";
    const typeLabel = entry.type === "core_tool" ? "CORE" : "TOOL";
    console.log(
      `[AUDIT] ${emoji} ${typeLabel} ${entry.agent}/${entry.tool} ${entry.args.join(" ")} → ${entry.decision}${entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ""}`
    );
  }

  /**
   * Create a timed audit entry. Call .finish() when done.
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
      type,
      tool,
      args,
      decision,
      target,
    };

    if (decision === "denied") {
      this.log(entry);
    }

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
    this.entry.durationMs = Date.now() - this.startTime;
    this.entry.exitCode = result.exitCode;
    this.entry.outputBytes = result.outputBytes;
    this.entry.error = result.error;
    this.logger.log(this.entry);
  }
}
