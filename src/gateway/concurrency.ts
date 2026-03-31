/**
 * Per-provider concurrency limiter.
 *
 * When a provider has a concurrency limit configured, requests beyond that
 * limit queue up and await until a slot frees up. Providers without a limit
 * (concurrency = -1 or undefined) pass through immediately.
 */

import type { BeigeConfig } from "../config/schema.js";

interface Waiter {
  resolve: () => void;
}

interface ProviderSlot {
  limit: number;       // -1 = unlimited
  active: number;
  queue: Waiter[];
}

export class ConcurrencyLimiter {
  private providers = new Map<string, ProviderSlot>();

  constructor(config: BeigeConfig) {
    for (const [name, providerConfig] of Object.entries(config.llm.providers)) {
      const limit = providerConfig.concurrency ?? -1;
      this.providers.set(name, { limit, active: 0, queue: [] });
    }
  }

  /**
   * Acquire a concurrency slot for the given provider.
   * Resolves immediately if under the limit or unlimited.
   * Returns a release function that MUST be called when done.
   */
  async acquire(provider: string): Promise<() => void> {
    let slot = this.providers.get(provider);
    if (!slot) {
      // Unknown provider — no limit
      slot = { limit: -1, active: 0, queue: [] };
      this.providers.set(provider, slot);
    }

    if (slot.limit === -1 || slot.active < slot.limit) {
      slot.active++;
      return this.releaseFor(slot);
    }

    // Wait for a slot to free up
    await new Promise<void>((resolve) => {
      slot!.queue.push({ resolve });
    });
    slot.active++;
    return this.releaseFor(slot);
  }

  private releaseFor(slot: ProviderSlot): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slot.active--;
      const next = slot.queue.shift();
      if (next) {
        next.resolve();
      }
    };
  }
}
