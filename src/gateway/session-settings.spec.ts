import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SessionSettingsStore,
  resolveSessionSetting,
} from "./session-settings.js";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SessionSettingsStore", () => {
  let tempDir: string;
  let store: SessionSettingsStore;
  let originalHomedir: () => string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-settings-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    // Store temporarily overrides homedir behavior via the constructor
    // We need to test the actual file operations, so we'll create a store
    // and verify it works with our temp directory structure
    store = new SessionSettingsStore();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("get and set", () => {
    it("returns undefined for unset settings", () => {
      const value = store.get("test-session", "verbose");
      expect(value).toBeUndefined();
    });

    it("sets and gets a setting", () => {
      store.set("test-session", "verbose", true);

      expect(store.get("test-session", "verbose")).toBe(true);
    });

    it("overwrites existing setting", () => {
      store.set("test-session", "verbose", true);
      store.set("test-session", "verbose", false);

      expect(store.get("test-session", "verbose")).toBe(false);
    });

    it("tracks different sessions independently", () => {
      store.set("session-1", "verbose", true);
      store.set("session-2", "verbose", false);

      expect(store.get("session-1", "verbose")).toBe(true);
      expect(store.get("session-2", "verbose")).toBe(false);
    });

    it("tracks different settings for same session", () => {
      store.set("test-session", "verbose", true);
      store.set("test-session", "streaming", false);

      expect(store.get("test-session", "verbose")).toBe(true);
      expect(store.get("test-session", "streaming")).toBe(false);
    });
  });

  describe("clear", () => {
    it("clears a specific setting", () => {
      store.set("test-session", "verbose", true);
      store.set("test-session", "streaming", false);

      store.clear("test-session", "verbose");

      expect(store.get("test-session", "verbose")).toBeUndefined();
      expect(store.get("test-session", "streaming")).toBe(false);
    });

    it("is safe to call on non-existent setting", () => {
      // Should not throw
      store.clear("unknown-session", "verbose");
    });
  });

  describe("clearAll", () => {
    it("clears all settings for a session", () => {
      store.set("test-session", "verbose", true);
      store.set("test-session", "streaming", false);

      store.clearAll("test-session");

      expect(store.get("test-session", "verbose")).toBeUndefined();
      expect(store.get("test-session", "streaming")).toBeUndefined();
    });

    it("is safe to call on non-existent session", () => {
      // Should not throw
      store.clearAll("unknown-session");
    });
  });

  describe("getAll", () => {
    it("returns all settings for a session", () => {
      store.set("test-session", "verbose", true);
      store.set("test-session", "streaming", false);

      const all = store.getAll("test-session");

      expect(all).toEqual({ verbose: true, streaming: false });
    });

    it("returns empty object for unknown session", () => {
      const all = store.getAll("unknown-session");

      expect(all).toEqual({});
    });

    it("returns a copy (not mutable reference)", () => {
      store.set("test-session", "verbose", true);

      const all = store.getAll("test-session");
      all.verbose = false;

      expect(store.get("test-session", "verbose")).toBe(true);
    });
  });

  describe("persistence", () => {
    it("persists settings to disk", () => {
      store.set("test-session", "verbose", true);

      // Create a new store to verify persistence
      const newStore = new SessionSettingsStore();

      expect(newStore.get("test-session", "verbose")).toBe(true);
    });

    it("persists cleared settings", () => {
      store.set("test-session", "verbose", true);
      store.clear("test-session", "verbose");

      const newStore = new SessionSettingsStore();

      expect(newStore.get("test-session", "verbose")).toBeUndefined();
    });
  });
});

describe("resolveSessionSetting", () => {
  it("returns session override when set", () => {
    const result = resolveSessionSetting(
      "verbose",
      false, // system default
      undefined, // channel default
      true // session override
    );

    expect(result).toBe(true);
  });

  it("returns channel default when no session override", () => {
    const result = resolveSessionSetting(
      "verbose",
      false, // system default
      true, // channel default
      undefined // no session override
    );

    expect(result).toBe(true);
  });

  it("returns system default when no overrides", () => {
    const result = resolveSessionSetting(
      "verbose",
      false, // system default
      undefined,
      undefined
    );

    expect(result).toBe(false);
  });

  it("session override takes precedence over channel default", () => {
    const result = resolveSessionSetting(
      "verbose",
      false, // system default
      true, // channel default
      false // session override
    );

    expect(result).toBe(false);
  });

  it("works with streaming setting", () => {
    const result = resolveSessionSetting(
      "streaming",
      true, // system default
      false, // channel default
      undefined
    );

    expect(result).toBe(false);
  });
});
