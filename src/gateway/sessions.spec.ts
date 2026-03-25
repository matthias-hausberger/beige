import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BeigeSessionStore,
  type SessionInfo,
} from "./sessions.js";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

describe("BeigeSessionStore", () => {
  let tempDir: string;
  let store: BeigeSessionStore;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    // Save and override HOME
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    store = new BeigeSessionStore();
  });

  afterEach(() => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper to create a session with an actual file on disk
  const createSessionWithFile = (key: string, agentName: string): string => {
    const sessionFile = store.createSession(key, agentName);
    // Create the actual file (the store only creates the mapping)
    writeFileSync(sessionFile, "");
    return sessionFile;
  };

  describe("getSessionFile", () => {
    it("returns undefined for unknown session key", () => {
      const result = store.getSessionFile("unknown-key");
      expect(result).toBeUndefined();
    });

    it("returns session file path for existing session", () => {
      const key = "telegram:123:456";
      const sessionFile = createSessionWithFile(key, "assistant");

      const result = store.getSessionFile(key);
      expect(result).toBe(sessionFile);
    });

    it("returns undefined if session file was deleted", () => {
      const key = "telegram:123:456";
      const sessionFile = createSessionWithFile(key, "assistant");

      // Delete the session file
      rmSync(sessionFile, { force: true });

      const result = store.getSessionFile(key);
      expect(result).toBeUndefined();
    });
  });

  describe("createSession", () => {
    it("creates session file path in correct directory", () => {
      const key = "telegram:123";
      const sessionFile = store.createSession(key, "assistant");

      expect(sessionFile).toContain("assistant");
      expect(sessionFile).toContain(".jsonl");
      // Directory should exist
      expect(existsSync(dirname(sessionFile))).toBe(true);
    });

    it("creates unique session IDs", () => {
      const key1 = "telegram:1";
      const key2 = "telegram:2";

      const file1 = store.createSession(key1, "assistant");
      const file2 = store.createSession(key2, "assistant");

      expect(file1).not.toBe(file2);
    });

    it("creates agent directory if it doesn't exist", () => {
      const key = "telegram:new";
      const sessionFile = store.createSession(key, "new-agent");

      expect(existsSync(dirname(sessionFile))).toBe(true);
    });
  });

  describe("resetSession", () => {
    it("creates new session file for key", () => {
      const key = "telegram:123";
      const originalFile = createSessionWithFile(key, "assistant");

      const newFile = store.resetSession(key, "assistant");
      writeFileSync(newFile, ""); // Create the file

      expect(newFile).not.toBe(originalFile);
      expect(existsSync(originalFile)).toBe(true); // Old file still exists
      expect(existsSync(newFile)).toBe(true);
    });

    it("updates session mapping to new file", () => {
      const key = "telegram:123";
      createSessionWithFile(key, "assistant");
      const newFile = store.resetSession(key, "assistant");
      writeFileSync(newFile, ""); // Create the file

      const currentFile = store.getSessionFile(key);

      expect(currentFile).toBe(newFile);
    });
  });

  describe("getAgentName", () => {
    it("returns agent name for session key", () => {
      store.createSession("telegram:123", "assistant");

      const result = store.getAgentName("telegram:123");

      expect(result).toBe("assistant");
    });

    it("returns undefined for unknown key", () => {
      const result = store.getAgentName("unknown");

      expect(result).toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("returns empty array for agent with no sessions", () => {
      const sessions = store.listSessions("unknown-agent");

      expect(sessions).toEqual([]);
    });

    it("returns sessions for agent", () => {
      createSessionWithFile("key1", "assistant");
      createSessionWithFile("key2", "assistant");

      const sessions = store.listSessions("assistant");

      expect(sessions.length).toBe(2);
    });

    it("sorts sessions newest first", async () => {
      // Create sessions with slight delay
      createSessionWithFile("session-1", "assistant");
      await new Promise((r) => setTimeout(r, 10));
      createSessionWithFile("session-2", "assistant");

      const sessions = store.listSessions("assistant");

      // Sessions are sorted by createdAt descending (newest first)
      // The second session was created later, so it should be first
      expect(new Date(sessions[0].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(sessions[1].createdAt).getTime()
      );
    });

    it("includes session metadata", () => {
      createSessionWithFile("key", "assistant");

      const sessions = store.listSessions("assistant");

      expect(sessions[0].agentName).toBe("assistant");
      expect(sessions[0].sessionId).toBeTruthy();
      expect(sessions[0].sessionFile).toBeTruthy();
    });
  });

  describe("listAllSessions", () => {
    it("returns sessions across all agents", () => {
      createSessionWithFile("key1", "assistant");
      createSessionWithFile("key2", "researcher");

      const sessions = store.listAllSessions();

      expect(sessions.length).toBe(2);
      const agentNames = sessions.map((s) => s.agentName);
      expect(agentNames).toContain("assistant");
      expect(agentNames).toContain("researcher");
    });

    it("returns empty array when no sessions", () => {
      const sessions = store.listAllSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe("static key builders", () => {
    describe("tuiKey", () => {
      it("builds key for agent without session", () => {
        const key = BeigeSessionStore.tuiKey("assistant");
        expect(key).toBe("tui:assistant:default");
      });

      it("builds key for agent with session", () => {
        const key = BeigeSessionStore.tuiKey("assistant", "session-123");
        expect(key).toBe("tui:assistant:session-123");
      });
    });
  });

  describe("persistence", () => {
    it("persists session map across store instances", () => {
      const key = "telegram:persistence-test";
      createSessionWithFile(key, "assistant");

      // Create a new store
      const newStore = new BeigeSessionStore();

      expect(newStore.getSessionFile(key)).toBeDefined();
      expect(newStore.getAgentName(key)).toBe("assistant");
    });

    it("persists session-map.json file", () => {
      const key = "telegram:persist";
      store.createSession(key, "assistant");

      const mapPath = join(tempDir, ".beige", "sessions", "session-map.json");
      expect(existsSync(mapPath)).toBe(true);
    });
  });

  // ── New: metadata support ────────────────────────────────────────────────

  describe("createSession with metadata", () => {
    it("stores metadata on the session entry", () => {
      const key = "a2a:tui:coder:default:reviewer:ts1";
      store.createSession(key, "reviewer", { depth: 1, invokedBy: "coder" });

      const entry = store.getEntry(key);
      expect(entry?.metadata?.depth).toBe(1);
      expect(entry?.metadata?.invokedBy).toBe("coder");
    });

    it("entry has no metadata field when none is supplied", () => {
      const key = "tui:assistant:default";
      store.createSession(key, "assistant");

      const entry = store.getEntry(key);
      expect(entry?.metadata).toBeUndefined();
    });

    it("metadata is persisted across store instances", () => {
      const key = "a2a:persist:test";
      const meta = { depth: 2, parentSessionKey: "tui:coder:default", invokedBy: "coder" };
      store.createSession(key, "reviewer", meta);

      const newStore = new BeigeSessionStore();
      const entry = newStore.getEntry(key);

      expect(entry?.metadata?.depth).toBe(2);
      expect(entry?.metadata?.parentSessionKey).toBe("tui:coder:default");
      expect(entry?.metadata?.invokedBy).toBe("coder");
    });

    it("supports arbitrary metadata shapes without schema enforcement", () => {
      const key = "custom:meta:key";
      store.createSession(key, "agent", {
        customToolData: { nested: { value: 42 } },
        tags: ["a", "b"],
        active: true,
      });

      const entry = store.getEntry(key);
      expect((entry?.metadata?.customToolData as any)?.nested?.value).toBe(42);
      expect(entry?.metadata?.tags).toEqual(["a", "b"]);
      expect(entry?.metadata?.active).toBe(true);
    });
  });

  describe("getEntry", () => {
    it("returns undefined for an unregistered key", () => {
      expect(store.getEntry("nonexistent:key")).toBeUndefined();
    });

    it("returns the full entry for a registered key", () => {
      const key = "tui:coder:default";
      store.createSession(key, "coder");

      const entry = store.getEntry(key);
      expect(entry).toBeDefined();
      expect(entry?.agentName).toBe("coder");
      expect(entry?.sessionFile).toContain("coder");
      expect(entry?.createdAt).toBeTruthy();
    });

    it("returns undefined after session file is deleted and getSessionFile cleans the map", () => {
      const key = "tui:cleanup:test";
      const file = createSessionWithFile(key, "assistant");

      // Confirm entry exists
      expect(store.getEntry(key)).toBeDefined();

      // Delete the file and trigger cleanup via getSessionFile
      rmSync(file, { force: true });
      store.getSessionFile(key); // triggers map cleanup

      // Entry should now be gone
      expect(store.getEntry(key)).toBeUndefined();
    });

    it("reflects the most recent session after resetSession", () => {
      const key = "tui:reset:test";
      createSessionWithFile(key, "assistant");
      const newFile = store.resetSession(key, "assistant");

      const entry = store.getEntry(key);
      expect(entry?.sessionFile).toBe(newFile);
    });

    it("resetSession does not carry over metadata from the previous entry", () => {
      const key = "a2a:reset:meta:test";
      store.createSession(key, "reviewer", { depth: 1, invokedBy: "coder" });

      store.resetSession(key, "reviewer");

      const entry = store.getEntry(key);
      expect(entry?.metadata).toBeUndefined();
    });
  });

  // ── Tool-session filtering in listSessions / listAllSessions ─────────────

  describe("listSessions — tool-session filtering", () => {
    it("excludes sessions with metadata.depth > 0 by default", () => {
      // Human-initiated session (no metadata)
      const humanFile = createSessionWithFile("tui:coder:default", "coder");
      // Sub-agent session (depth: 1)
      store.createSession("a2a:tui:coder:default:coder:ts1", "coder", { depth: 1, invokedBy: "coder" });
      writeFileSync(store.getEntry("a2a:tui:coder:default:coder:ts1")!.sessionFile, "");

      const sessions = store.listSessions("coder");

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionFile).toBe(humanFile);
    });

    it("includes all sessions when includeToolSessions is true", () => {
      createSessionWithFile("tui:coder:default", "coder");
      store.createSession("a2a:tui:coder:default:coder:ts1", "coder", { depth: 1, invokedBy: "coder" });
      writeFileSync(store.getEntry("a2a:tui:coder:default:coder:ts1")!.sessionFile, "");

      const sessions = store.listSessions("coder", { includeToolSessions: true });

      expect(sessions).toHaveLength(2);
    });

    it("includes sessions with depth: 0 in metadata (explicitly top-level)", () => {
      // depth: 0 is a valid explicit marker for a top-level session
      store.createSession("tui:explicit:depth0", "coder", { depth: 0 });
      writeFileSync(store.getEntry("tui:explicit:depth0")!.sessionFile, "");

      const sessions = store.listSessions("coder");

      expect(sessions).toHaveLength(1);
    });

    it("excludes depth-2 sessions (grandchild agents)", () => {
      store.createSession("a2a:child:grandchild:ts1", "coder", { depth: 2, invokedBy: "coder" });
      writeFileSync(store.getEntry("a2a:child:grandchild:ts1")!.sessionFile, "");

      const sessions = store.listSessions("coder");

      expect(sessions).toHaveLength(0);
    });

    it("handles session files with no map entry (orphaned files) — includes them", () => {
      // A session file that has no entry in the map (e.g. created outside beige
      // or from an older version) has no metadata and should be shown.
      const orphanDir = join(tempDir, ".beige", "sessions", "coder");
      mkdirSync(orphanDir, { recursive: true });
      writeFileSync(join(orphanDir, "20260101-120000-orphan.jsonl"), "");

      const sessions = store.listSessions("coder");

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionFile).toContain("orphan");
    });
  });

  describe("listAllSessions — tool-session filtering", () => {
    it("excludes tool sessions across all agents by default", () => {
      createSessionWithFile("tui:coder:default", "coder");
      createSessionWithFile("tui:reviewer:default", "reviewer");
      store.createSession("a2a:coder:reviewer:ts1", "reviewer", { depth: 1, invokedBy: "coder" });
      writeFileSync(store.getEntry("a2a:coder:reviewer:ts1")!.sessionFile, "");

      const all = store.listAllSessions();

      expect(all).toHaveLength(2);
      expect(all.map((s) => s.agentName).sort()).toEqual(["coder", "reviewer"]);
      // The sub-agent reviewer session must not appear — only the human one
      expect(all.filter((s) => s.agentName === "reviewer")).toHaveLength(1);
    });

    it("includes all sessions when includeToolSessions is true", () => {
      createSessionWithFile("tui:coder:default", "coder");
      store.createSession("a2a:coder:reviewer:ts1", "reviewer", { depth: 1, invokedBy: "coder" });
      writeFileSync(store.getEntry("a2a:coder:reviewer:ts1")!.sessionFile, "");

      const all = store.listAllSessions({ includeToolSessions: true });

      expect(all).toHaveLength(2);
    });
  });
});
