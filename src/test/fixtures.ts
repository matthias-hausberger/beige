/**
 * Shared test fixtures and factories.
 * Import from './test/fixtures.js' (relative to src/).
 */

import type { BeigeConfig, AgentConfig, ToolConfig, LLMProviderConfig, SkillConfig } from "../config/schema.js";

/**
 * Minimal valid config for testing.
 */
export function createMinimalConfig(overrides: Partial<BeigeConfig> = {}): BeigeConfig {
  return {
    llm: {
      providers: {
        anthropic: { apiKey: "test-key" },
      },
    },
    tools: {},
    agents: {
      assistant: {
        model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        tools: [],
      },
    },
    channels: {},
    ...overrides,
  };
}

/**
 * Full config with tools and multiple agents.
 */
export function createFullConfig(): BeigeConfig {
  return {
    llm: {
      providers: {
        anthropic: { apiKey: "test-anthropic-key" },
        openai: { apiKey: "test-openai-key", baseUrl: "https://api.openai.com/v1" },
      },
    },
    tools: {
      kv: {
        path: "/tools/kv",
        target: "gateway",
      },
      browser: {
        path: "/tools/browser",
        target: "sandbox",
        config: { headless: true },
      },
    },
    agents: {
      assistant: {
        model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        tools: ["kv"],
      },
      researcher: {
        model: { provider: "anthropic", model: "claude-sonnet-4-20250514", thinkingLevel: "medium" },
        fallbackModels: [
          { provider: "openai", model: "gpt-4o" },
        ],
        tools: ["kv", "browser"],
      },
      restricted: {
        model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        tools: [],
      },
    },
    channels: {
      telegram: {
        enabled: true,
        token: "test-token",
        allowedUsers: [123456789],
        agentMapping: { default: "assistant" },
      },
    },
  };
}

/**
 * Create a mock agent config.
 */
export function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    tools: [],
    ...overrides,
  };
}

/**
 * Create a mock tool config.
 */
export function createToolConfig(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    path: "/tools/test",
    target: "gateway",
    ...overrides,
  };
}

/**
 * Create a mock provider config.
 */
export function createProviderConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    apiKey: "test-key",
    ...overrides,
  };
}

/**
 * Create a mock skill config.
 */
export function createSkillConfig(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    path: "/skills/test",
    ...overrides,
  };
}

/**
 * Sample tool manifest for testing.
 */
export const sampleToolManifest = {
  name: "test-tool",
  description: "A test tool for unit tests",
  commands: ["run <arg>", "status"],
  target: "gateway" as const,
};

/**
 * Create a temp directory for tests that need file system access.
 * Returns the directory path and a cleanup function.
 */
export function createTempDir(): { path: string; cleanup: () => void } {
  const { tmpdir } = require("os");
  const { mkdirSync, rmSync } = require("fs");
  const { join } = require("path");

  const path = join(tmpdir(), `beige-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });

  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}
