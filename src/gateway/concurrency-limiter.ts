/**
 * Per-provider concurrency limiter using semaphore pattern.
 *
 * Tracks active requests per provider and enforces configurable limits.
 * Requests that exceed limits queue and await until a slot frees up.
 */

export interface ConcurrencyLimiterConfig {
  /** Default concurrency if not specified for a provider */
  defaultConcurrency: number;
  /** Per-provider max concurrency */
  providerLimits: Record<string, number>;
}

interface ProviderSlots {
  /** Max concurrent requests allowed */
  max: number;
  /** Currently active requests */
  active: number;
  /** Queue of resolvers waiting for slots */
  queue: Array<() => void>;
}

export class ConcurrencyLimiter {
  private providerSlots: Map<string, ProviderSlots> = new Map();
  private config: ConcurrencyLimiterConfig;

  constructor(config: ConcurrencyLimiterConfig) {
    this.config = config;
  }

  /**
   * Acquire a slot for the given provider/model.
   * If limit exceeded, queues and awaits until slot frees.
   */
  async acquire(provider: string, model: string): Promise<void> {
    const key = `${provider}/${model}`;
    let slots = this.providerSlots.get(key);

    if (!slots) {
      // Initialize on first use
      const max = this.config.providerLimits[key] ?? this.config.providerLimits[provider] ?? this.config.defaultConcurrency;
      slots = { max, active: 0, queue: [] };
      this.providerSlots.set(key, slots);
    }

    if (slots.active < slots.max) {
      // Slot available - take it immediately
      slots.active++;
      return;
    }

    // No slot available - queue and await
    await new Promise<void>((resolve) => {
      slots!.queue.push(resolve);
    });

    // When this resolves, slot is reserved for us
    slots!.active++;
  }

  /**
   * Release a slot after request completes.
   * Wakes up next queued request if any.
   */
  release(provider: string, model: string): void {
    const key = `${provider}/${model}`;
    const slots = this.providerSlots.get(key);

    if (!slots) {
      console.warn(`[CONCURRENCY] No slots tracked for ${key}`);
      return;
    }

    slots.active = Math.max(0, slots.active - 1);

    // Wake up next queued request if any
    const next = slots.queue.shift();
    if (next) {
      next();
    }
  }

  /**
   * Get current active count for a provider/model.
   */
  getActive(provider: string, model: string): number {
    const key = `${provider}/${model}`;
    return this.providerSlots.get(key)?.active ?? 0;
  }

  /**
   * Get queue depth for a provider/model.
   */
  getQueueDepth(provider: string, model: string): number {
    const key = `${provider}/${model}`;
    return this.providerSlots.get(key)?.queue.length ?? 0;
  }

  /**
   * Get statistics for all providers.
   */
  getStats(): Record<string, { active: number; queued: number; max: number }> {
    const stats: Record<string, { active: number; queued: number; max: number }> = {};
    for (const [key, slots] of this.providerSlots.entries()) {
      stats[key] = {
        active: slots.active,
        queued: slots.queue.length,
        max: slots.max,
      };
    }
    return stats;
  }
}
