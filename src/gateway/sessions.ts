import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { beigeDir } from "../paths.js";

/**
 * Beige session store.
 *
 * Maps external identifiers (Telegram chat+thread, TUI session name, etc.)
 * to pi session files on disk.
 *
 * Session files are stored at:
 *   ~/.beige/sessions/<agent>/<session-id>.jsonl
 *
 * A mapping file tracks which external key maps to which session:
 *   ~/.beige/sessions/session-map.json
 */
export class BeigeSessionStore {
  private beigeDir: string;
  private sessionsDir: string;
  private mapFile: string;
  private sessionMap: Record<string, SessionMapEntry>;

  constructor() {
    this.beigeDir = beigeDir();
    this.sessionsDir = resolve(this.beigeDir, "sessions");
    this.mapFile = resolve(this.sessionsDir, "session-map.json");
    mkdirSync(this.sessionsDir, { recursive: true });
    this.sessionMap = this.loadMap();
  }

  /**
   * Get the session file path for a given key, or undefined if no session exists.
   */
  getSessionFile(key: string): string | undefined {
    const entry = this.sessionMap[key];
    if (!entry) return undefined;
    // Verify the file still exists
    if (!existsSync(entry.sessionFile)) {
      delete this.sessionMap[key];
      this.saveMap();
      return undefined;
    }
    return entry.sessionFile;
  }

  /**
   * Create a new session file for a given key and agent.
   * Returns the path to the new session file.
   *
   * Pass `metadata` to attach arbitrary caller-owned data to the entry.
   * Beige stores and returns this data as-is and never interprets it.
   */
  createSession(key: string, agentName: string, metadata?: Record<string, unknown>): string {
    const agentDir = resolve(this.sessionsDir, agentName);
    mkdirSync(agentDir, { recursive: true });

    const sessionId = generateSessionId();
    const sessionFile = resolve(agentDir, `${sessionId}.jsonl`);

    this.sessionMap[key] = {
      agentName,
      sessionFile,
      createdAt: new Date().toISOString(),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    this.saveMap();

    return sessionFile;
  }

  /**
   * Return the raw SessionMapEntry for a session key, or undefined if the
   * key is not registered.  Callers use this to read back metadata they
   * previously wrote via createSession().
   */
  getEntry(key: string): SessionMapEntry | undefined {
    return this.sessionMap[key];
  }

  /**
   * Reset a key's session — creates a new session file.
   * The old session file is kept on disk for history.
   *
   * Note: metadata from the previous entry is intentionally not carried over.
   * The new session starts as a fresh top-level session (no metadata).  Callers
   * that need to preserve metadata (e.g. to maintain depth tracking) should
   * call createSession() directly with the desired metadata instead.
   */
  resetSession(key: string, agentName: string): string {
    // Don't delete old file — keep it for /resume
    return this.createSession(key, agentName);
  }

  /**
   * Get the agent name for a session key.
   */
  getAgentName(key: string): string | undefined {
    return this.sessionMap[key]?.agentName;
  }

  /**
   * List sessions for a given agent that were initiated by a human (i.e.
   * have no metadata, or have metadata without a positive `depth` value).
   *
   * Sessions created by toolkit tools (such as agent-to-agent) attach metadata
   * with a `depth > 0` field.  Those sessions represent internal
   * agent-to-agent or sub-agent invocations and are intentionally excluded
   * from user-facing session lists — they would be confusing to resume and
   * are not the user's direct conversation history.
   *
   * Pass `{ includeToolSessions: true }` to bypass this filter and return
   * every session file on disk regardless of metadata.
   */
  listSessions(agentName: string, opts?: { includeToolSessions?: boolean }): SessionInfo[] {
    const agentDir = resolve(this.sessionsDir, agentName);
    if (!existsSync(agentDir)) return [];

    // Build a reverse map: sessionFile path → entry, for O(1) metadata lookup.
    const fileToEntry = this.buildFileToEntryMap();

    const files = readdirSync(agentDir).filter((f) => f.endsWith(".jsonl"));
    return files
      .map((f) => {
        const filePath = resolve(agentDir, f);
        const entry = fileToEntry.get(filePath);

        // Exclude tool-initiated sessions unless caller explicitly opts in.
        if (!opts?.includeToolSessions) {
          const depth = entry?.metadata?.depth;
          if (typeof depth === "number" && depth > 0) return null;
        }

        const firstLine = readFirstLine(filePath);
        return {
          sessionFile: filePath,
          sessionId: f.replace(".jsonl", ""),
          agentName,
          firstMessage: extractFirstMessage(firstLine),
          createdAt: extractTimestamp(firstLine),
        };
      })
      .filter((s): s is SessionInfo => s !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
  }

  /**
   * List all sessions across all agents.
   * Tool-initiated sessions (depth > 0 in metadata) are excluded by default.
   * Pass `{ includeToolSessions: true }` to include them.
   */
  listAllSessions(opts?: { includeToolSessions?: boolean }): SessionInfo[] {
    if (!existsSync(this.sessionsDir)) return [];

    const agents = readdirSync(this.sessionsDir).filter((f) => {
      const fullPath = resolve(this.sessionsDir, f);
      try {
        return readdirSync(fullPath).some((file) => file.endsWith(".jsonl"));
      } catch {
        return false;
      }
    });

    return agents.flatMap((agent) => this.listSessions(agent, opts));
  }

  /**
   * Build a session key for Telegram.
   */
  static telegramKey(chatId: number, threadId?: number): string {
    return threadId ? `telegram:${chatId}:${threadId}` : `telegram:${chatId}`;
  }

  /**
   * Build a session key for TUI.
   */
  static tuiKey(agentName: string, sessionId?: string): string {
    return sessionId ? `tui:${agentName}:${sessionId}` : `tui:${agentName}:default`;
  }

  // ── Private ────────────────────────────────────────────

  /**
   * Build a reverse lookup: absolute session file path → SessionMapEntry.
   * Used by listSessions() to check metadata without a linear scan per file.
   */
  private buildFileToEntryMap(): Map<string, SessionMapEntry> {
    const map = new Map<string, SessionMapEntry>();
    for (const entry of Object.values(this.sessionMap)) {
      map.set(entry.sessionFile, entry);
    }
    return map;
  }

  private loadMap(): Record<string, SessionMapEntry> {
    try {
      return JSON.parse(readFileSync(this.mapFile, "utf-8"));
    } catch {
      return {};
    }
  }

  private saveMap(): void {
    writeFileSync(this.mapFile, JSON.stringify(this.sessionMap, null, 2));
  }
}

export interface SessionMapEntry {
  agentName: string;
  sessionFile: string;
  createdAt: string;
  /**
   * Arbitrary key-value metadata attached at session creation time.
   * Beige does not interpret this field — it is owned entirely by the caller
   * (e.g. a toolkit tool that needs to persist per-session state such as
   * invocation depth, parent session key, or channel-specific data).
   */
  metadata?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionFile: string;
  sessionId: string;
  agentName: string;
  firstMessage: string;
  createdAt: string;
}

function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${date}-${time}-${rand}`;
}

function readFirstLine(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n")[0] || "";
  } catch {
    return "";
  }
}

function extractFirstMessage(line: string): string {
  try {
    const parsed = JSON.parse(line);
    // pi session files have different entry formats
    if (parsed.content && typeof parsed.content === "string") {
      return parsed.content.slice(0, 100);
    }
    if (parsed.firstMessage) {
      return parsed.firstMessage.slice(0, 100);
    }
    return "(session)";
  } catch {
    return "(session)";
  }
}

function extractTimestamp(line: string): string {
  try {
    const parsed = JSON.parse(line);
    return parsed.timestamp ? new Date(parsed.timestamp).toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}
