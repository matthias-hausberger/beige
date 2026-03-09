import { describe, it, expect } from "vitest";
import { validateConfig } from "./schema.js";
import { createMinimalConfig, createFullConfig } from "../test/fixtures.js";

describe("validateConfig", () => {
  describe("valid configs", () => {
    it("accepts minimal valid config", () => {
      const config = createMinimalConfig();
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts full config with tools and multiple agents", () => {
      const config = createFullConfig();
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts config with fallback models", () => {
      const config = createMinimalConfig({
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
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
              model: "claude-sonnet-4-20250514",
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
            model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
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
      expect(() => validateConfig(config)).toThrow("llm.providers is required");
    });

    it("throws when tools is missing", () => {
      const { tools, ...config } = createMinimalConfig() as any;
      expect(() => validateConfig(config)).toThrow("tools is required");
    });

    it("throws when agents is missing", () => {
      const { agents, ...config } = createMinimalConfig() as any;
      expect(() => validateConfig(config)).toThrow("agents is required");
    });
  });

  describe("agent validation", () => {
    it("throws when agent model.provider is missing", () => {
      const config = createMinimalConfig({
        agents: {
          assistant: {
            model: { provider: "", model: "claude-sonnet-4-20250514" },
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

    it("throws when agent references unknown tool", () => {
      const config = createMinimalConfig({
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
            tools: ["nonexistent-tool"],
          },
        },
      });
      expect(() => validateConfig(config)).toThrow("unknown tool 'nonexistent-tool'");
    });
  });

  describe("channel validation", () => {
    it("throws when telegram agentMapping.default references unknown agent", () => {
      const config = createMinimalConfig({
        channels: {
          telegram: {
            enabled: true,
            token: "test-token",
            allowedUsers: [123],
            agentMapping: { default: "nonexistent-agent" },
          },
        },
      });
      expect(() => validateConfig(config)).toThrow("unknown agent 'nonexistent-agent'");
    });

    it("accepts disabled telegram channel even with invalid agent mapping", () => {
      const config = createMinimalConfig({
        channels: {
          telegram: {
            enabled: false,
            token: "test-token",
            allowedUsers: [123],
            agentMapping: { default: "nonexistent-agent" },
          },
        },
      });
      // Disabled channels are not validated for agent references
      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});
