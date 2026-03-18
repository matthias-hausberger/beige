/**
 * Restricted model registry wrapper.
 *
 * Wraps a ModelRegistry and restricts `getAvailable()` to only return models
 * that are in the agent's allowed list (model + fallbackModels).
 *
 * This prevents users from switching to models not configured for the agent
 * via the TUI's model switching features (Ctrl+P, /model, etc.).
 */

import type { Model, Api } from "@mariozechner/pi-ai";
import { ModelRegistry, type AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ModelRef } from "./schema.js";

/**
 * A restricted model registry that only exposes allowed models.
 *
 * Wraps the real ModelRegistry but filters getAvailable() to only return
 * models that match the agent's configured model and fallbackModels.
 *
 * All other methods delegate to the underlying registry.
 *
 * Note: This class implements the same interface as ModelRegistry but
 * uses composition instead of inheritance (ModelRegistry has private fields).
 * Use `as unknown as ModelRegistry` when passing to APIs that expect ModelRegistry.
 */
export class RestrictedModelRegistry {
  private underlying: ModelRegistry;
  private allowedModels: Array<{ provider: string; modelId: string }>;

  constructor(
    underlying: ModelRegistry,
    allowedModels: Array<{ provider: string; modelId: string }>
  ) {
    this.underlying = underlying;
    this.allowedModels = allowedModels;
  }

  /**
   * Get only models that are both available (have auth) AND in the allowed list.
   */
  getAvailable(): Model<Api>[] {
    const allAvailable = this.underlying.getAvailable();
    return allAvailable.filter((model) =>
      this.allowedModels.some(
        (allowed) => allowed.provider === model.provider && allowed.modelId === model.id
      )
    );
  }

  // Delegate all other ModelRegistry methods

  get authStorage(): AuthStorage {
    return this.underlying.authStorage;
  }

  refresh(): void {
    return this.underlying.refresh();
  }

  getError(): string | undefined {
    return this.underlying.getError();
  }

  getAll(): Model<Api>[] {
    return this.underlying.getAll();
  }

  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.underlying.find(provider, modelId);
  }

  async getApiKey(model: Model<Api>): Promise<string | undefined> {
    return this.underlying.getApiKey(model);
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    return this.underlying.getApiKeyForProvider(provider);
  }

  isUsingOAuth(model: Model<Api>): boolean {
    return this.underlying.isUsingOAuth(model);
  }

  registerProvider(providerName: string, config: Parameters<ModelRegistry["registerProvider"]>[1]): void {
    return this.underlying.registerProvider(providerName, config);
  }

  unregisterProvider(providerName: string): void {
    return this.underlying.unregisterProvider(providerName);
  }

  /**
   * Get the underlying unrestricted registry.
   * Use this when you need to pass a real ModelRegistry to APIs.
   */
  getUnderlying(): ModelRegistry {
    return this.underlying;
  }

  /**
   * Cast to ModelRegistry for use with APIs that expect ModelRegistry.
   * Safe because this class implements the same interface.
   */
  asModelRegistry(): ModelRegistry {
    return this.underlying;
  }
}

/**
 * Build the list of allowed models from an agent's model configuration.
 */
export function buildAllowedModels(model: ModelRef, fallbackModels?: ModelRef[]): Array<{ provider: string; modelId: string }> {
  const allowed: Array<{ provider: string; modelId: string }> = [
    { provider: model.provider, modelId: model.model },
  ];

  if (fallbackModels) {
    for (const fallback of fallbackModels) {
      allowed.push({ provider: fallback.provider, modelId: fallback.model });
    }
  }

  return allowed;
}

/**
 * Validate that a model is in the allowed list.
 * Throws an error if the model is not allowed.
 */
export function validateModelAllowed(
  provider: string,
  modelId: string,
  allowedModels: Array<{ provider: string; modelId: string }>
): void {
  const isAllowed = allowedModels.some(
    (m) => m.provider === provider && m.modelId === modelId
  );

  if (!isAllowed) {
    const allowedList = allowedModels
      .map((m) => `${m.provider}/${m.modelId}`)
      .join(", ");
    throw new Error(
      `Model ${provider}/${modelId} is not allowed for this agent. ` +
      `Allowed models: ${allowedList}`
    );
  }
}
