/**
 * Shared test fixtures and factories.
 * Import from './test/fixtures.js' (relative to src/).
 */

import type { BeigeConfig, AgentConfig, PluginConfig, LLMProviderConfig, SkillConfig } from "../config/schema.js";

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
    plugins: {},
    agents: {
      assistant: {
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        tools: [],
      },
    },
    ...overrides,
  };
}

/**
 * Full config with plugins and multiple agents.
 */
export function createFullConfig(): BeigeConfig {
  return {
    llm: {
      providers: {
        anthropic: { apiKey: "test-anthropic-key" },
        openai: { apiKey: "test-openai-key", baseUrl: "https://api.openai.com/v1" },
      },
    },
    plugins: {
      git: {
        path: "/plugins/git",
      },
      chrome: {
        path: "/plugins/chrome",
        config: { headless: true },
      },
    },
    agents: {
      assistant: {
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        tools: ["git"],
      },
      researcher: {
        model: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "medium" },
        fallbackModels: [
          { provider: "openai", model: "gpt-4o" },
        ],
        tools: ["git", "chrome"],
      },
      restricted: {
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        tools: [],
      },
    },
  };
}

/**
 * Create a mock agent config.
 */
export function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    tools: [],
    ...overrides,
  };
}

/**
 * Create a mock plugin config.
 */
export function createPluginConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    path: "/plugins/test",
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
 * Sample plugin manifest for testing.
 */
export const samplePluginManifest = {
  name: "test-plugin",
  description: "A test plugin for unit tests",
  commands: ["run <arg>", "status"],
  provides: { tools: ["test-plugin"] },
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
