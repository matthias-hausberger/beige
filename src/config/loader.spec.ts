import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "./loader.js";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("JSON5 parsing", () => {
    it("parses valid JSON5 with comments", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          // This is a comment
          llm: {
            providers: {
              anthropic: { apiKey: "test-key" },
            },
          },
          tools: {},
          agents: {
            /* Multi-line
               comment */
            assistant: {
              model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
              tools: [],
            },
          },
          channels: {},
        }
      `);

      const config = loadConfig(configPath);
      expect(config.llm.providers.anthropic.apiKey).toBe("test-key");
      expect(config.agents.assistant).toBeDefined();
    });

    it("parses unquoted keys", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test" } } },
          tools: {},
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: [] } },
          channels: {},
        }
      `);

      const config = loadConfig(configPath);
      expect(config.llm.providers.anthropic).toBeDefined();
    });

    it("parses trailing commas", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test", }, }, },
          tools: {},
          agents: {
            assistant: { model: { provider: "anthropic", model: "claude", }, tools: [], },
          },
          channels: {},
        }
      `);

      const config = loadConfig(configPath);
      expect(config.llm.providers.anthropic.apiKey).toBe("test");
    });
  });

  describe("environment variable resolution", () => {
    it("resolves ${ENV_VAR} references", () => {
      process.env.TEST_API_KEY = "my-secret-key";

      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "\${TEST_API_KEY}" } } },
          tools: {},
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: [] } },
          channels: {},
        }
      `);

      const config = loadConfig(configPath);
      expect(config.llm.providers.anthropic.apiKey).toBe("my-secret-key");

      delete process.env.TEST_API_KEY;
    });

    it("resolves env vars in nested objects", () => {
      process.env.TEST_TOKEN = "bot-token-123";

      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test" } } },
          tools: {},
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: [] } },
          channels: {
            telegram: {
              enabled: true,
              token: "\${TEST_TOKEN}",
              allowedUsers: [123],
              agentMapping: { default: "assistant" },
            },
          },
        }
      `);

      const config = loadConfig(configPath);
      expect(config.channels.telegram?.token).toBe("bot-token-123");

      delete process.env.TEST_TOKEN;
    });

    it("throws when env var is not set", () => {
      delete process.env.NONEXISTENT_VAR;

      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "\${NONEXISTENT_VAR}" } } },
          tools: {},
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: [] } },
          channels: {},
        }
      `);

      expect(() => loadConfig(configPath)).toThrow("NONEXISTENT_VAR");
    });

    it("resolves env vars in arrays", () => {
      process.env.ALLOWED_USER = "999888";

      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test" } } },
          tools: {},
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: [] } },
          channels: {
            telegram: {
              enabled: true,
              token: "test",
              allowedUsers: [123, "\${ALLOWED_USER}"],
              agentMapping: { default: "assistant" },
            },
          },
        }
      `);

      const config = loadConfig(configPath);
      // Note: JSON5 parses strings in number arrays as strings
      // The actual validation would convert these
      expect(config.channels.telegram?.allowedUsers).toContain("999888");

      delete process.env.ALLOWED_USER;
    });
  });

  describe("path resolution", () => {
    it("resolves relative tool paths against config directory", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test" } } },
          tools: {
            mytool: { path: "./tools/mytool", target: "gateway" },
          },
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: ["mytool"] } },
          channels: {},
        }
      `);

      const config = loadConfig(configPath);
      expect(config.tools.mytool.path).toBe(join(tempDir, "tools/mytool"));
    });

    it("keeps absolute tool paths unchanged", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test" } } },
          tools: {
            mytool: { path: "/absolute/path/to/tool", target: "gateway" },
          },
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: ["mytool"] } },
          channels: {},
        }
      `);

      const config = loadConfig(configPath);
      expect(config.tools.mytool.path).toBe("/absolute/path/to/tool");
    });
  });

  describe("validation", () => {
    it("validates config schema after loading", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: {} },
          tools: {},
          agents: {},
          channels: {},
        }
      `);

      // Should not throw - empty providers/agents is valid
      expect(() => loadConfig(configPath)).not.toThrow();
    });
  });
});
