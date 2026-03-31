import { describe, it, expect } from "vitest";
import { ConcurrencyLimiter } from "./concurrency.js";
import type { BeigeConfig } from "../config/schema.js";

function makeConfig(providers: Record<string, { concurrency?: number }>): BeigeConfig {
  const llmProviders: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(providers)) {
    llmProviders[name] = { ...cfg };
  }
  return { llm: { providers: llmProviders }, agents: {} } as any;
}

describe("ConcurrencyLimiter", () => {
  it("unlimited provider passes through immediately", async () => {
    const limiter = new ConcurrencyLimiter(makeConfig({ anthropic: {} }));
    const release = await limiter.acquire("anthropic");
    expect(typeof release).toBe("function");
    release();
  });

  it("respects concurrency limit and queues excess requests", async () => {
    const limiter = new ConcurrencyLimiter(makeConfig({ zai: { concurrency: 2 } }));
    const order: number[] = [];

    const r1 = await limiter.acquire("zai");
    const r2 = await limiter.acquire("zai");

    // Third request should be queued
    let r3Resolved = false;
    const p3 = limiter.acquire("zai").then((release) => {
      r3Resolved = true;
      return release;
    });

    // Give microtasks a chance to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(r3Resolved).toBe(false);

    // Release one slot — p3 should resolve
    r1();
    await new Promise((r) => setTimeout(r, 10));
    expect(r3Resolved).toBe(true);

    const r3 = await p3;
    r2();
    r3();
  });

  it("unknown provider has no limit", async () => {
    const limiter = new ConcurrencyLimiter(makeConfig({}));
    const releases = [];
    for (let i = 0; i < 100; i++) {
      releases.push(await limiter.acquire("unknown"));
    }
    releases.forEach((r) => r());
  });

  it("release is idempotent", async () => {
    const limiter = new ConcurrencyLimiter(makeConfig({ zai: { concurrency: 1 } }));
    const r1 = await limiter.acquire("zai");
    r1();
    r1(); // double release should not break things

    const r2 = await limiter.acquire("zai");
    r2();
  });

  it("queued requests are served FIFO", async () => {
    const limiter = new ConcurrencyLimiter(makeConfig({ zai: { concurrency: 1 } }));
    const order: number[] = [];

    const r1 = await limiter.acquire("zai");

    const p2 = limiter.acquire("zai").then((r) => { order.push(2); return r; });
    const p3 = limiter.acquire("zai").then((r) => { order.push(3); return r; });

    r1();
    const r2 = await p2;
    r2();
    const r3 = await p3;
    r3();

    expect(order).toEqual([2, 3]);
  });
});
