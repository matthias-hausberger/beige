import { describe, it, expect } from "vitest";
import { validateConfig } from "./schema.js";
import { createMinimalConfig, createFullConfig } from "../test/fixtures.js";

describe("validateConfig", () => {
  describe("valid configs", () => {
    it("accepts minimal valid config", () => {
      const config = createMinimalConfig();
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts full config with plugins and multiple agents", () => {
      const config = createFullConfig();
      // Note: tool references are now validated after plugin loading, not at config level
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts config with fallback models", () => {
      const config = createMinimalConfig({
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            fallbackModels: [
              { provider: "openai", model: "gpt-4o" },
            ],
            tools: [],
          },
        },
      });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts config with thinking level", () => {
      const config = createMinimalConfig({
        agents: {
          assistant: {
            model: {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              thinkingLevel: "high",
            },
            tools: [],
          },
        },
      });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts config with sandbox options", () => {
      const config = createMinimalConfig({
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            tools: [],
            sandbox: {
              image: "custom-sandbox:v1",
              extraMounts: { "/host/path": "/container/path" },
              extraEnv: { DEBUG: "true" },
            },
          },
        },
      });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts config with gateway settings", () => {
      const config = createMinimalConfig({
        gateway: {
          host: "0.0.0.0",
          port: 8080,
          logFile: "/var/log/beige.log",
        },
      });
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe("missing required fields", () => {
    it("throws when llm.providers is missing", () => {
      const config = { ...createMinimalConfig(), llm: {} as any };
      expect(() => validateConfig(config)).toThrow(/llm.*providers/);
    });

    it("throws when agents is missing", () => {
      const { agents, ...config } = createMinimalConfig() as any;
      expect(() => validateConfig(config)).toThrow(/agents/);
    });
  });

  describe("agent validation", () => {
    it("throws when agent model.provider is missing", () => {
      const config = createMinimalConfig({
        agents: {
          assistant: {
            model: { provider: "", model: "claude-sonnet-4-6" },
            tools: [],
          } as any,
        },
      });
      expect(() => validateConfig(config)).toThrow("model requires provider");
    });

    it("throws when agent model.model is missing", () => {
      const config = createMinimalConfig({
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "" },
            tools: [],
          } as any,
        },
      });
      expect(() => validateConfig(config)).toThrow("model requires provider and model");
    });

    it("accepts config with skills", () => {
      const config = createMinimalConfig({
        skills: {
          "code-review": { path: "/skills/code-review" },
          "testing": { path: "/skills/testing" },
        },
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            tools: [],
            skills: ["code-review", "testing"],
          },
        },
      });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts config with pluginConfigs for a plugin in config.plugins", () => {
      const config = createMinimalConfig({
        plugins: {
          kv: { path: "/plugins/kv", config: { timeout: 1000 } },
        },
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            tools: ["kv"],
            pluginConfigs: {
              kv: { timeout: 5000 },
            },
          },
        },
      });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("throws when pluginConfigs references a plugin not in config.plugins", () => {
      const config = createMinimalConfig({
        plugins: {
          kv: { path: "/plugins/kv" },
        },
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            tools: ["kv"],
            pluginConfigs: {
              browser: { headless: true },
            },
          },
        },
      });
      expect(() => validateConfig(config)).toThrow(
        "has pluginConfigs for 'browser' but that plugin is not in config.plugins"
      );
    });
  });
});
