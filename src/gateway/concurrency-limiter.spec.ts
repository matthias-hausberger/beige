import { describe, it, beforeEach } from "vitest";
import { expect } from "vitest";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";

describe("ConcurrencyLimiter", () => {
  let limiter: ConcurrencyLimiter;

  beforeEach(() => {
    limiter = new ConcurrencyLimiter({
      defaultConcurrency: 2,
      providerLimits: {},
    });
  });

  describe("basic slot acquisition and release", () => {
    it("should acquire slot immediately when available", async () => {
      await limiter.acquire("openai", "gpt-4");
      await limiter.acquire("openai", "gpt-4");

      expect(limiter.getActive("openai", "gpt-4")).toBe(2);
      expect(limiter.getQueueDepth("openai", "gpt-4")).toBe(0);
    });

    it("should queue request when limit exceeded", async () => {
      let thirdAcquired = false;

      // Acquire both slots
      await limiter.acquire("openai", "gpt-4");
      await limiter.acquire("openai", "gpt-4");

      // Third request should queue
      limiter.acquire("openai", "gpt-4").then(() => {
        thirdAcquired = true;
      });

      // Third not acquired yet
      expect(thirdAcquired).toBe(false);
      expect(limiter.getQueueDepth("openai", "gpt-4")).toBe(1);

      // Release one slot
      limiter.release("openai", "gpt-4");

      // Wait a bit for the queued request to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now third should acquire
      expect(thirdAcquired).toBe(true);
      expect(limiter.getActive("openai", "gpt-4")).toBe(2);
      expect(limiter.getQueueDepth("openai", "gpt-4")).toBe(0);
    });

    it("should release slot and decrement active count", async () => {
      await limiter.acquire("openai", "gpt-4");
      await limiter.acquire("openai", "gpt-4");

      expect(limiter.getActive("openai", "gpt-4")).toBe(2);

      limiter.release("openai", "gpt-4");
      expect(limiter.getActive("openai", "gpt-4")).toBe(1);

      limiter.release("openai", "gpt-4");
      expect(limiter.getActive("openai", "gpt-4")).toBe(0);
    });
  });

  describe("per-provider limits", () => {
    it("should respect per-provider limits", async () => {
      const providerLimiter = new ConcurrencyLimiter({
        defaultConcurrency: 1,
        providerLimits: {
          "anthropic": 5,
          "openai": 2,
        },
      });

      // Anthropic should get 5 slots
      for (let i = 0; i < 5; i++) {
        await providerLimiter.acquire("anthropic", "claude-3-opus");
      }
      expect(providerLimiter.getActive("anthropic", "claude-3-opus")).toBe(5);

      // OpenAI should only get 2
      await providerLimiter.acquire("openai", "gpt-4");
      await providerLimiter.acquire("openai", "gpt-4");
      expect(providerLimiter.getActive("openai", "gpt-4")).toBe(2);

      // Third OpenAI request should queue
      let queued = false;
      providerLimiter.acquire("openai", "gpt-4").then(() => {
        queued = true;
      });
      expect(queued).toBe(false);
      expect(providerLimiter.getQueueDepth("openai", "gpt-4")).toBe(1);
    });
  });

  describe("slot release on error path", () => {
    it("should allow re-acquisition after release", async () => {
      await limiter.acquire("openai", "gpt-4");
      limiter.release("openai", "gpt-4");

      // Should be able to acquire again after release
      await limiter.acquire("openai", "gpt-4");
      assert.strictEqual(limiter.getActive("openai", "gpt-4"), 1);
    });
  });

  describe("multiple models per provider", () => {
    it("should track slots separately for different models", async () => {
      const providerLimiter = new ConcurrencyLimiter({
        defaultConcurrency: 2,
        providerLimits: {
          "openai": 3,
        },
      });

      // Acquire across different models
      await providerLimiter.acquire("openai", "gpt-4");
      await providerLimiter.acquire("openai", "gpt-4-turbo");
      await providerLimiter.acquire("openai", "gpt-3.5-turbo");

      // Each model should have 1 active
      expect(providerLimiter.getActive("openai", "gpt-4")).toBe(1);
      expect(providerLimiter.getActive("openai", "gpt-4-turbo")).toBe(1);
      expect(providerLimiter.getActive("openai", "gpt-3.5-turbo")).toBe(1);

      // Fourth request should queue (provider limit is 3)
      let queued = false;
      providerLimiter.acquire("openai", "gpt-4").then(() => {
        queued = true;
      });
      expect(queued).toBe(false);
    });
  });

  describe("queue processing", () => {
    it("should process queue in FIFO order", async () => {
      let firstAcquired = false;
      let secondAcquired = false;
      let thirdAcquired = false;

      // Fill up slots
      await limiter.acquire("openai", "gpt-4");
      await limiter.acquire("openai", "gpt-4");

      // Queue three requests
      limiter.acquire("openai", "gpt-4").then(() => { firstAcquired = true; });
      limiter.acquire("openai", "gpt-4").then(() => { secondAcquired = true; });
      limiter.acquire("openai", "gpt-4").then(() => { thirdAcquired = true; });

      // Release first slot - first queued should acquire
      limiter.release("openai", "gpt-4");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(firstAcquired).toBe(true);
      expect(secondAcquired).toBe(false);
      expect(thirdAcquired).toBe(false);

      // Release second slot - second queued should acquire
      limiter.release("openai", "gpt-4");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(firstAcquired).toBe(true);
      expect(secondAcquired).toBe(true);
      expect(thirdAcquired).toBe(false);

      // Release third slot - third queued should acquire
      limiter.release("openai", "gpt-4");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(firstAcquired).toBe(true);
      expect(secondAcquired).toBe(true);
      expect(thirdAcquired).toBe(true);
    });
  });

  describe("getStats", () => {
    it("should return statistics for all providers", async () => {
      await limiter.acquire("openai", "gpt-4");
      await limiter.acquire("openai", "gpt-4");

      // Queue one
      limiter.acquire("openai", "gpt-4").then(() => {});

      // Another provider
      await limiter.acquire("anthropic", "claude-3");

      const stats = limiter.getStats();

      expect(stats["openai/gpt-4"].active).toBe(2);
      expect(stats["openai/gpt-4"].queued).toBe(1);
      expect(stats["openai/gpt-4"].max).toBe(2);

      expect(stats["anthropic/claude-3"].active).toBe(1);
      expect(stats["anthropic/claude-3"].queued).toBe(0);
      expect(stats["anthropic/claude-3"].max).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("should handle release when no slots tracked", () => {
      // Should not throw
      limiter.release("unknown", "model");
    });

    it("should handle negative active count gracefully", () => {
      limiter.release("openai", "gpt-4");
      expect(limiter.getActive("openai", "gpt-4")).toBe(0);
    });

    it("should use default concurrency when no provider limit set", async () => {
      await limiter.acquire("unknown-provider", "model");
      expect(limiter.getActive("unknown-provider", "model")).toBe(1);
    });
  });
});
