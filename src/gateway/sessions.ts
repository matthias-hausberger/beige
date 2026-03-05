import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

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
    this.beigeDir = resolve(homedir(), ".beige");
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
   */
  createSession(key: string, agentName: string): string {
    const agentDir = resolve(this.sessionsDir, agentName);
    mkdirSync(agentDir, { recursive: true });

    const sessionId = generateSessionId();
    const sessionFile = resolve(agentDir, `${sessionId}.jsonl`);

    this.sessionMap[key] = {
      agentName,
      sessionFile,
      createdAt: new Date().toISOString(),
    };
    this.saveMap();

    return sessionFile;
  }

  /**
   * Reset a key's session — creates a new session file.
   * The old session file is kept on disk for history.
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
   * List all sessions for a given agent.
   */
  listSessions(agentName: string): SessionInfo[] {
    const agentDir = resolve(this.sessionsDir, agentName);
    if (!existsSync(agentDir)) return [];

    const files = readdirSync(agentDir).filter((f) => f.endsWith(".jsonl"));
    return files.map((f) => {
      const filePath = resolve(agentDir, f);
      const firstLine = readFirstLine(filePath);
      return {
        sessionFile: filePath,
        sessionId: f.replace(".jsonl", ""),
        agentName,
        firstMessage: extractFirstMessage(firstLine),
        createdAt: extractTimestamp(firstLine),
      };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
  }

  /**
   * List all sessions across all agents.
   */
  listAllSessions(): SessionInfo[] {
    if (!existsSync(this.sessionsDir)) return [];

    const agents = readdirSync(this.sessionsDir).filter((f) => {
      const fullPath = resolve(this.sessionsDir, f);
      try {
        return readdirSync(fullPath).some((file) => file.endsWith(".jsonl"));
      } catch {
        return false;
      }
    });

    return agents.flatMap((agent) => this.listSessions(agent));
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
