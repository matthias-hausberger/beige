import { describe, it, expect } from "vitest";
import { RestrictedModelRegistry, buildAllowedModels, validateModelAllowed } from "./restricted-model-registry.js";
import { ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";

describe("RestrictedModelRegistry", () => {
  // Create a mock model
  const createMockModel = (provider: string, id: string): Model<Api> => ({
    provider,
    id,
    name: `${provider}/${id}`,
    contextWindow: 100000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    api: "anthropic-messages" as Api,
    baseUrl: `https://api.${provider}.com`,
  });

  // Create a mock underlying registry
  const createMockRegistry = (models: Model<Api>[]): Partial<ModelRegistry> => {
    return {
      getAvailable: () => models,
      find: (provider: string, modelId: string) =>
        models.find((m) => m.provider === provider && m.id === modelId),
      getAll: () => models,
    };
  };

  it("filters getAvailable() to only allowed models", () => {
    const allModels = [
      createMockModel("anthropic", "claude-sonnet-4"),
      createMockModel("anthropic", "claude-3-5-sonnet"),
      createMockModel("openai", "gpt-4"),
    ];

    const mockRegistry = createMockRegistry(allModels) as ModelRegistry;
    const allowedModels = [
      { provider: "anthropic", modelId: "claude-sonnet-4" },
      { provider: "openai", modelId: "gpt-4" },
    ];

    const restricted = new RestrictedModelRegistry(mockRegistry, allowedModels);
    const available = restricted.getAvailable();

    expect(available).toHaveLength(2);
    expect(available.map((m) => `${m.provider}/${m.id}`).sort()).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4",
    ]);
  });

  it("returns empty array when no models are available", () => {
    const mockRegistry = createMockRegistry([]) as ModelRegistry;
    const allowedModels = [{ provider: "anthropic", modelId: "claude-sonnet-4" }];

    const restricted = new RestrictedModelRegistry(mockRegistry, allowedModels);
    const available = restricted.getAvailable();

    expect(available).toHaveLength(0);
  });

  it("excludes models not in allowed list even if available", () => {
    const allModels = [
      createMockModel("anthropic", "claude-sonnet-4"),
      createMockModel("openai", "gpt-4"),
    ];

    const mockRegistry = createMockRegistry(allModels) as ModelRegistry;
    const allowedModels = [{ provider: "anthropic", modelId: "claude-sonnet-4" }];

    const restricted = new RestrictedModelRegistry(mockRegistry, allowedModels);
    const available = restricted.getAvailable();

    expect(available).toHaveLength(1);
    expect(available[0].id).toBe("claude-sonnet-4");
  });

  it("delegates find() to underlying registry", () => {
    const allModels = [createMockModel("anthropic", "claude-sonnet-4")];
    const mockRegistry = createMockRegistry(allModels) as ModelRegistry;
    const restricted = new RestrictedModelRegistry(mockRegistry, []);

    const found = restricted.find("anthropic", "claude-sonnet-4");
    expect(found?.id).toBe("claude-sonnet-4");
  });

  it("delegates getAll() to underlying registry", () => {
    const allModels = [
      createMockModel("anthropic", "claude-sonnet-4"),
      createMockModel("openai", "gpt-4"),
    ];
    const mockRegistry = createMockRegistry(allModels) as ModelRegistry;
    const restricted = new RestrictedModelRegistry(mockRegistry, []);

    const all = restricted.getAll();
    expect(all).toHaveLength(2);
  });

  it("getUnderlying() returns the original registry", () => {
    const mockRegistry = createMockRegistry([]) as ModelRegistry;
    const restricted = new RestrictedModelRegistry(mockRegistry, []);

    expect(restricted.getUnderlying()).toBe(mockRegistry);
  });
});

describe("buildAllowedModels", () => {
  it("builds list from primary model only", () => {
    const model = { provider: "anthropic", model: "claude-sonnet-4" };
    const allowed = buildAllowedModels(model);

    expect(allowed).toEqual([{ provider: "anthropic", modelId: "claude-sonnet-4" }]);
  });

  it("includes fallback models in order", () => {
    const model = { provider: "anthropic", model: "claude-sonnet-4" };
    const fallbackModels = [
      { provider: "anthropic", model: "claude-3-5-sonnet" },
      { provider: "openai", model: "gpt-4" },
    ];

    const allowed = buildAllowedModels(model, fallbackModels);

    expect(allowed).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet-4" },
      { provider: "anthropic", modelId: "claude-3-5-sonnet" },
      { provider: "openai", modelId: "gpt-4" },
    ]);
  });

  it("handles empty fallbackModels array", () => {
    const model = { provider: "anthropic", model: "claude-sonnet-4" };
    const allowed = buildAllowedModels(model, []);

    expect(allowed).toHaveLength(1);
  });
});

describe("validateModelAllowed", () => {
  it("does not throw for allowed model", () => {
    const allowedModels = [
      { provider: "anthropic", modelId: "claude-sonnet-4" },
      { provider: "openai", modelId: "gpt-4" },
    ];

    expect(() => validateModelAllowed("anthropic", "claude-sonnet-4", allowedModels)).not.toThrow();
    expect(() => validateModelAllowed("openai", "gpt-4", allowedModels)).not.toThrow();
  });

  it("throws for non-allowed model", () => {
    const allowedModels = [{ provider: "anthropic", modelId: "claude-sonnet-4" }];

    expect(() => validateModelAllowed("openai", "gpt-4", allowedModels)).toThrow(
      "Model openai/gpt-4 is not allowed for this agent"
    );
  });

  it("includes allowed models in error message", () => {
    const allowedModels = [
      { provider: "anthropic", modelId: "claude-sonnet-4" },
      { provider: "anthropic", modelId: "claude-3-5-sonnet" },
    ];

    try {
      validateModelAllowed("openai", "gpt-4", allowedModels);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("anthropic/claude-sonnet-4");
      expect(message).toContain("anthropic/claude-3-5-sonnet");
    }
  });
});
