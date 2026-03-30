import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { beigeDir } from "../paths.js";

/**
 * Provider health tracking for rate limit handling and fallback logic.
 *
 * Tracks per-provider rate limits and cooldown periods. When a provider
 * hits a rate limit, it's marked as "cooling down" until the retry-after
 * time expires. If no retry-after is provided, a default cooldown is used.
 *
 * Persisted to ~/.beige/data/provider-health.json so it survives restarts.
 */

export interface ProviderHealthEntry {
  /** ISO timestamp when the provider hit a rate limit. */
  rateLimitedAt?: string;
  /** ISO timestamp when we can retry (from retry-after header or default). */
  retryAfter?: string;
  /** Number of consecutive failures (resets on success). */
  consecutiveFailures: number;
  /** Last error message (for debugging). */
  lastError?: string;
}

export interface ProviderHealthData {
  /** provider/model → health entry */
  providers: Record<string, ProviderHealthEntry>;
  /** When the data was last persisted */
  lastUpdated: string;
}

/** Default cooldown when a 429 status is returned but no retry-after header is provided (5 minutes) */
const DEFAULT_HARD_COOLDOWN_MS = 5 * 60 * 1000;

/** Cooldown for soft rate-limit detection (pattern-matched errors, not HTTP 429) (60 seconds) */
const DEFAULT_SOFT_COOLDOWN_MS = 60 * 1000;

/** Key format: "provider/model" */
type ProviderKey = string;

/**
 * Tracks provider health and rate limits.
 */
export class ProviderHealthTracker {
  private filePath: string;
  private data: ProviderHealthData;

  constructor() {
    const dir = resolve(beigeDir(), "data");
    mkdirSync(dir, { recursive: true });
    this.filePath = resolve(dir, "provider-health.json");
    this.data = this.load();
  }

  /**
   * Get the health entry for a provider/model.
   */
  get(provider: string, model: string): ProviderHealthEntry | undefined {
    const key = this.makeKey(provider, model);
    return this.data.providers[key];
  }

  /**
   * Check if a provider/model is currently in cooldown (rate limited).
   */
  isCoolingDown(provider: string, model: string): boolean {
    const entry = this.get(provider, model);
    if (!entry?.retryAfter) return false;

    const retryAfter = new Date(entry.retryAfter).getTime();
    const now = Date.now();

    if (now >= retryAfter) {
      // Cooldown expired — clear it
      this.clearCooldown(provider, model);
      return false;
    }

    return true;
  }

  /**
   * Get the remaining cooldown time in milliseconds, or 0 if not cooling down.
   */
  getRemainingCooldown(provider: string, model: string): number {
    const entry = this.get(provider, model);
    if (!entry?.retryAfter) return 0;

    const retryAfter = new Date(entry.retryAfter).getTime();
    const now = Date.now();
    const remaining = retryAfter - now;

    return Math.max(0, remaining);
  }

  /**
   * Mark a provider/model as rate limited.
   * @param retryAfterMs  Optional retry-after time in ms. If not provided, uses default.
   * @param error         Optional error message for debugging.
   */
  markRateLimited(
    provider: string,
    model: string,
    retryAfterMs?: number,
    error?: string,
    /** Whether this is a hard rate limit (HTTP 429) or a soft one (pattern-matched). */
    hard: boolean = true
  ): void {
    const key = this.makeKey(provider, model);
    const now = new Date();
    const cooldownMs = retryAfterMs ?? (hard ? DEFAULT_HARD_COOLDOWN_MS : DEFAULT_SOFT_COOLDOWN_MS);
    const retryAfter = new Date(now.getTime() + cooldownMs);

    const existing = this.data.providers[key] ?? { consecutiveFailures: 0 };

    this.data.providers[key] = {
      ...existing,
      rateLimitedAt: now.toISOString(),
      retryAfter: retryAfter.toISOString(),
      consecutiveFailures: existing.consecutiveFailures + 1,
      lastError: error,
    };

    this.save();
    console.log(
      `[PROVIDER_HEALTH] ${key} rate limited until ${retryAfter.toISOString()}` +
      (error ? ` (${error})` : "")
    );
  }

  /**
   * Mark a provider/model as failed (but not necessarily rate limited).
   */
  markFailed(provider: string, model: string, error?: string): void {
    const key = this.makeKey(provider, model);
    const existing = this.data.providers[key] ?? { consecutiveFailures: 0 };

    this.data.providers[key] = {
      ...existing,
      consecutiveFailures: existing.consecutiveFailures + 1,
      lastError: error,
    };

    this.save();
  }

  /**
   * Mark a provider/model as healthy (successful response).
   */
  markHealthy(provider: string, model: string): void {
    const key = this.makeKey(provider, model);
    const existing = this.data.providers[key];

    if (existing && (existing.consecutiveFailures > 0 || existing.retryAfter)) {
      this.data.providers[key] = {
        consecutiveFailures: 0,
        // Clear rate limit info on success
        rateLimitedAt: undefined,
        retryAfter: undefined,
        lastError: undefined,
      };
      this.save();
      console.log(`[PROVIDER_HEALTH] ${key} marked healthy`);
    }
  }

  /**
   * Clear the cooldown for a provider/model.
   */
  clearCooldown(provider: string, model: string): void {
    const key = this.makeKey(provider, model);
    const existing = this.data.providers[key];

    if (existing) {
      this.data.providers[key] = {
        ...existing,
        rateLimitedAt: undefined,
        retryAfter: undefined,
      };
      this.save();
    }
  }

  /**
   * Get all provider/model keys that are currently in cooldown.
   */
  getCoolingDown(): Array<{ provider: string; model: string; retryAfter: Date }> {
    const now = Date.now();
    const result: Array<{ provider: string; model: string; retryAfter: Date }> = [];

    for (const [key, entry] of Object.entries(this.data.providers)) {
      if (entry.retryAfter) {
        const retryAfter = new Date(entry.retryAfter);
        if (retryAfter.getTime() > now) {
          const [provider, model] = key.split("/");
          result.push({ provider, model, retryAfter });
        }
      }
    }

    return result;
  }

  // ── Private ────────────────────────────────────────────────────────

  private makeKey(provider: string, model: string): ProviderKey {
    return `${provider}/${model}`;
  }

  private load(): ProviderHealthData {
    if (!existsSync(this.filePath)) {
      return { providers: {}, lastUpdated: new Date().toISOString() };
    }

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as ProviderHealthData;
    } catch {
      return { providers: {}, lastUpdated: new Date().toISOString() };
    }
  }

  private save(): void {
    this.data.lastUpdated = new Date().toISOString();
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

/**
 * Extract rate limit info from an error response.
 * Checks for common patterns in API error responses.
 */
export function extractRateLimitInfo(error: unknown): {
  isRateLimit: boolean;
  retryAfterMs?: number;
  /** True if this is a hard rate limit (HTTP 429), false if pattern-matched. */
  isHard?: boolean;
  /** The detection method used (for logging). */
  detectionReason?: string;
} {
  if (!error || typeof error !== "object") {
    return { isRateLimit: false };
  }

  const err = error as Record<string, any>;

  // Check for HTTP status 429
  if (err.status === 429 || err.statusCode === 429) {
    const retryAfter = err.headers?.["retry-after"] ?? err.headers?.["Retry-After"];
    return {
      isRateLimit: true,
      retryAfterMs: parseRetryAfter(retryAfter),
      isHard: true,
      detectionReason: `HTTP ${err.status ?? err.statusCode}`,
    };
  }

  // Check for error type/message patterns
  const errorType = err.error?.type ?? err.type ?? "";
  const errorMessage = err.message ?? err.error?.message ?? "";

  const rateLimitPatterns = [
    "rate_limit",
    "rate limit",
    "too many requests",
    "overloaded",
    "capacity",
    "temporarily unavailable",
  ];

  const combined = `${errorType} ${errorMessage}`.toLowerCase();
  const matchedPattern = rateLimitPatterns.find((p) => combined.includes(p));

  if (matchedPattern) {
    const retryAfter = err.headers?.["retry-after"] ?? err.headers?.["Retry-After"];
    return {
      isRateLimit: true,
      retryAfterMs: parseRetryAfter(retryAfter),
      isHard: false,
      detectionReason: `pattern match: "${matchedPattern}" in "${combined.substring(0, 200)}"`,
    };
  }

  return { isRateLimit: false };
}

/**
 * Parse a retry-after header value.
 * Can be either a number of seconds or an HTTP date.
 */
function parseRetryAfter(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "number") {
    return value * 1000; // seconds to ms
  }

  const num = parseInt(value, 10);
  if (!isNaN(num)) {
    return num * 1000; // seconds to ms
  }

  // Try parsing as HTTP date
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return undefined;
}
