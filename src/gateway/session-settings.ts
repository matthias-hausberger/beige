import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { beigeDir } from "../paths.js";

/**
 * Per-session setting overrides.
 *
 * Settings are layered:
 *   system default → channel config default → session override
 *
 * Session overrides are stored in ~/.beige/sessions/session-settings.json
 * and survive gateway restarts.
 */
export interface SessionSettings {
  /** Whether to forward tool-start notifications to the channel. */
  verbose?: boolean;
  /** Whether to stream responses in real-time (vs. send when complete). */
  streaming?: boolean;
}

/**
 * Known setting keys with their types (for type-safe access).
 */
export interface KnownSettings {
  verbose: boolean;
  streaming: boolean;
}

export type SettingKey = keyof KnownSettings;

/**
 * Persistent store for per-session setting overrides.
 * Stored at ~/.beige/sessions/session-settings.json.
 */
export class SessionSettingsStore {
  private filePath: string;
  private data: Record<string, SessionSettings>;

  constructor() {
    const dir = resolve(beigeDir(), "sessions");
    mkdirSync(dir, { recursive: true });
    this.filePath = resolve(dir, "session-settings.json");
    this.data = this.load();
  }

  /**
   * Get a single setting override for a session, or undefined if not set.
   */
  get<K extends SettingKey>(sessionKey: string, setting: K): KnownSettings[K] | undefined {
    const overrides = this.data[sessionKey];
    if (!overrides) return undefined;
    const value = overrides[setting];
    // undefined means "not overridden"
    return value as KnownSettings[K] | undefined;
  }

  /**
   * Set a setting override for a session.
   */
  set<K extends SettingKey>(sessionKey: string, setting: K, value: KnownSettings[K]): void {
    if (!this.data[sessionKey]) {
      this.data[sessionKey] = {};
    }
    this.data[sessionKey][setting] = value;
    this.save();
  }

  /**
   * Clear a specific setting override (revert to channel / system default).
   */
  clear<K extends SettingKey>(sessionKey: string, setting: K): void {
    if (!this.data[sessionKey]) return;
    delete this.data[sessionKey][setting];
    if (Object.keys(this.data[sessionKey]).length === 0) {
      delete this.data[sessionKey];
    }
    this.save();
  }

  /**
   * Clear all overrides for a session (e.g. when /new is called).
   */
  clearAll(sessionKey: string): void {
    if (this.data[sessionKey]) {
      delete this.data[sessionKey];
      this.save();
    }
  }

  /**
   * Get all overrides for a session.
   */
  getAll(sessionKey: string): SessionSettings {
    return { ...this.data[sessionKey] };
  }

  // ── Private ────────────────────────────────────────────────────────

  private load(): Record<string, SessionSettings> {
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

/**
 * Resolves the effective value of a setting by merging layers:
 *   1. System default (hardcoded)
 *   2. Channel config default (from config.json5)
 *   3. Session override (from SessionSettingsStore)
 */
export function resolveSessionSetting<K extends SettingKey>(
  setting: K,
  systemDefault: KnownSettings[K],
  channelDefault: KnownSettings[K] | undefined,
  sessionOverride: KnownSettings[K] | undefined
): KnownSettings[K] {
  if (sessionOverride !== undefined) return sessionOverride;
  if (channelDefault !== undefined) return channelDefault;
  return systemDefault;
}
