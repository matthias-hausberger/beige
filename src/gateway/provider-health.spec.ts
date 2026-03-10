import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ProviderHealthTracker,
  extractRateLimitInfo,
} from "./provider-health.js";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

describe("ProviderHealthTracker", () => {
  let tracker: ProviderHealthTracker;
  let testDataDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testDataDir = join(tmpdir(), `beige-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    // Override HOME to use our temp directory
    originalHome = process.env.HOME;
    process.env.HOME = testDataDir;

    // Create tracker which will use our temp HOME
    tracker = new ProviderHealthTracker();
  });

  afterEach(() => {
    // Restore original HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    // Clean up temp directory
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe("isCoolingDown", () => {
    it("returns false when no cooldown is set", () => {
      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(false);
    });

    it("returns true when provider is in cooldown", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000);

      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(true);
    });

    it("returns false after cooldown expires", async () => {
      vi.useFakeTimers();

      tracker.markRateLimited("anthropic", "claude-sonnet", 100); // 100ms cooldown

      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(true);

      vi.advanceTimersByTime(150);

      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(false);

      vi.useRealTimers();
    });

    it("tracks different providers independently", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000);

      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(true);
      expect(tracker.isCoolingDown("openai", "gpt-4")).toBe(false);
    });

    it("tracks different models independently", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000);

      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(true);
      expect(tracker.isCoolingDown("anthropic", "claude-opus")).toBe(false);
    });
  });

  describe("getRemainingCooldown", () => {
    it("returns 0 when not cooling down", () => {
      expect(tracker.getRemainingCooldown("anthropic", "claude-sonnet")).toBe(0);
    });

    it("returns remaining time in milliseconds", () => {
      vi.useFakeTimers();

      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000);

      const remaining = tracker.getRemainingCooldown("anthropic", "claude-sonnet");
      expect(remaining).toBeGreaterThan(59_000);
      expect(remaining).toBeLessThanOrEqual(60_000);

      vi.advanceTimersByTime(30_000);

      const remainingAfter = tracker.getRemainingCooldown("anthropic", "claude-sonnet");
      expect(remainingAfter).toBeGreaterThan(29_000);
      expect(remainingAfter).toBeLessThanOrEqual(30_000);

      vi.useRealTimers();
    });
  });

  describe("markRateLimited", () => {
    it("sets cooldown with custom retry-after", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 120_000);

      const remaining = tracker.getRemainingCooldown("anthropic", "claude-sonnet");
      expect(remaining).toBeGreaterThan(119_000);
    });

    it("uses default cooldown when no retry-after provided", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet");

      const remaining = tracker.getRemainingCooldown("anthropic", "claude-sonnet");
      // Default is 30 minutes = 1,800,000 ms
      expect(remaining).toBeGreaterThan(1_700_000);
    });

    it("stores error message", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000, "Rate limit exceeded");

      const entry = tracker.get("anthropic", "claude-sonnet");
      expect(entry?.lastError).toBe("Rate limit exceeded");
    });

    it("increments consecutive failures", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet");
      tracker.markRateLimited("anthropic", "claude-sonnet");

      const entry = tracker.get("anthropic", "claude-sonnet");
      expect(entry?.consecutiveFailures).toBe(2);
    });
  });

  describe("markFailed", () => {
    it("increments consecutive failures without setting cooldown", () => {
      tracker.markFailed("anthropic", "claude-sonnet", "Connection error");

      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(false);

      const entry = tracker.get("anthropic", "claude-sonnet");
      expect(entry?.consecutiveFailures).toBe(1);
      expect(entry?.lastError).toBe("Connection error");
    });
  });

  describe("markHealthy", () => {
    it("clears consecutive failures", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet");
      tracker.markHealthy("anthropic", "claude-sonnet");

      const entry = tracker.get("anthropic", "claude-sonnet");
      expect(entry?.consecutiveFailures).toBe(0);
    });

    it("clears rate limit info", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000);
      tracker.markHealthy("anthropic", "claude-sonnet");

      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(false);

      const entry = tracker.get("anthropic", "claude-sonnet");
      expect(entry?.retryAfter).toBeUndefined();
      expect(entry?.rateLimitedAt).toBeUndefined();
    });

    it("clears error message", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000, "Error");
      tracker.markHealthy("anthropic", "claude-sonnet");

      const entry = tracker.get("anthropic", "claude-sonnet");
      expect(entry?.lastError).toBeUndefined();
    });

    it("does nothing for unknown provider/model", () => {
      // Should not throw
      tracker.markHealthy("unknown", "unknown");
    });
  });

  describe("clearCooldown", () => {
    it("clears cooldown but keeps failure count", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000);
      tracker.clearCooldown("anthropic", "claude-sonnet");

      expect(tracker.isCoolingDown("anthropic", "claude-sonnet")).toBe(false);

      const entry = tracker.get("anthropic", "claude-sonnet");
      expect(entry?.consecutiveFailures).toBe(1);
    });
  });

  describe("getCoolingDown", () => {
    it("returns all providers currently in cooldown", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000);
      tracker.markRateLimited("openai", "gpt-4", 60_000);

      const cooling = tracker.getCoolingDown();

      expect(cooling.length).toBe(2);
      expect(cooling.map((c) => `${c.provider}/${c.model}`)).toContain("anthropic/claude-sonnet");
      expect(cooling.map((c) => `${c.provider}/${c.model}`)).toContain("openai/gpt-4");
    });

    it("excludes providers that are not in cooldown", () => {
      tracker.markRateLimited("anthropic", "claude-sonnet", 60_000);

      const cooling = tracker.getCoolingDown();

      expect(cooling.length).toBe(1);
      expect(cooling[0].provider).toBe("anthropic");
    });

    it("excludes expired cooldowns", async () => {
      vi.useFakeTimers();

      tracker.markRateLimited("anthropic", "claude-sonnet", 100);
      vi.advanceTimersByTime(150);

      const cooling = tracker.getCoolingDown();
      expect(cooling.length).toBe(0);

      vi.useRealTimers();
    });
  });
});

describe("extractRateLimitInfo", () => {
  describe("HTTP status detection", () => {
    it("detects 429 status as rate limit", () => {
      const error = { status: 429 };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
    });

    it("detects 429 statusCode as rate limit", () => {
      const error = { statusCode: 429 };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
    });

    it("extracts retry-after from headers (seconds)", () => {
      const error = {
        status: 429,
        headers: { "retry-after": "60" },
      };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
      expect(info.retryAfterMs).toBe(60_000);
    });

    it("extracts retry-after from headers (numeric)", () => {
      const error = {
        status: 429,
        headers: { "retry-after": 120 },
      };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
      expect(info.retryAfterMs).toBe(120_000);
    });
  });

  describe("error message patterns", () => {
    it("detects 'rate_limit' in error type", () => {
      const error = { error: { type: "rate_limit_error" } };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
    });

    it("detects 'rate limit' in error message", () => {
      const error = { message: "Rate limit exceeded. Please retry." };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
    });

    it("detects 'too many requests' in error message", () => {
      const error = { message: "Too many requests" };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
    });

    it("detects 'overloaded' in error message", () => {
      const error = { message: "API is overloaded" };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
    });

    it("detects 'capacity' in error message", () => {
      const error = { error: { message: "Insufficient capacity" } };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
    });

    it("detects 'temporarily unavailable' in error message", () => {
      const error = { message: "Service temporarily unavailable" };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(true);
    });
  });

  describe("non-rate-limit errors", () => {
    it("returns false for generic errors", () => {
      const error = { message: "Internal server error", status: 500 };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(false);
    });

    it("returns false for auth errors", () => {
      const error = { message: "Invalid API key", status: 401 };
      const info = extractRateLimitInfo(error);

      expect(info.isRateLimit).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(extractRateLimitInfo(null).isRateLimit).toBe(false);
      expect(extractRateLimitInfo(undefined).isRateLimit).toBe(false);
    });

    it("returns false for non-object errors", () => {
      expect(extractRateLimitInfo("error string").isRateLimit).toBe(false);
      expect(extractRateLimitInfo(123).isRateLimit).toBe(false);
    });
  });

  describe("retry-after parsing", () => {
    it("parses numeric retry-after", () => {
      const error = { status: 429, headers: { "retry-after": 30 } };
      const info = extractRateLimitInfo(error);

      expect(info.retryAfterMs).toBe(30_000);
    });

    it("parses string numeric retry-after", () => {
      const error = { status: 429, headers: { "retry-after": "45" } };
      const info = extractRateLimitInfo(error);

      expect(info.retryAfterMs).toBe(45_000);
    });

    it("handles missing retry-after", () => {
      const error = { status: 429 };
      const info = extractRateLimitInfo(error);

      expect(info.retryAfterMs).toBeUndefined();
    });

    it("handles Retry-After with capital letters", () => {
      const error = {
        status: 429,
        headers: { "Retry-After": "60" },
      };
      const info = extractRateLimitInfo(error);

      expect(info.retryAfterMs).toBe(60_000);
    });
  });
});
