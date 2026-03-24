import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
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
          plugins: {},
          agents: {
            /* Multi-line comment */
            assistant: {
              model: { provider: "anthropic", model: "claude-sonnet-4-6" },
              tools: [],
            },
          },
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
          plugins: {},
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: [] } },
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
          plugins: {},
          agents: {
            assistant: { model: { provider: "anthropic", model: "claude", }, tools: [], },
          },
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
          plugins: {},
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: [] } },
        }
      `);

      const config = loadConfig(configPath);
      expect(config.llm.providers.anthropic.apiKey).toBe("my-secret-key");

      delete process.env.TEST_API_KEY;
    });

    it("throws when env var is not set", () => {
      delete process.env.NONEXISTENT_VAR;

      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "\${NONEXISTENT_VAR}" } } },
          plugins: {},
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: [] } },
        }
      `);

      expect(() => loadConfig(configPath)).toThrow("NONEXISTENT_VAR");
    });

    it("resolves env vars in arrays", () => {
      process.env.EXTRA_TOOL = "my-env-tool";

      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test" } } },
          plugins: {},
          agents: {
            assistant: {
              model: { provider: "anthropic", model: "claude" },
              tools: ["\${EXTRA_TOOL}"],
            },
          },
        }
      `);

      // env var resolves in arrays — the value is substituted
      const config = loadConfig(configPath);
      expect(config.agents.assistant.tools).toContain("my-env-tool");

      delete process.env.EXTRA_TOOL;
    });
  });

  describe("path resolution", () => {
    it("resolves relative plugin paths against config directory", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test" } } },
          plugins: {
            myplugin: { path: "./plugins/myplugin" },
          },
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: ["myplugin"] } },
        }
      `);

      const config = loadConfig(configPath);
      expect(config.plugins!.myplugin.path).toBe(join(tempDir, "plugins/myplugin"));
    });

    it("keeps absolute plugin paths unchanged", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: { anthropic: { apiKey: "test" } } },
          plugins: {
            myplugin: { path: "/absolute/path/to/plugin" },
          },
          agents: { assistant: { model: { provider: "anthropic", model: "claude" }, tools: ["myplugin"] } },
        }
      `);

      const config = loadConfig(configPath);
      expect(config.plugins!.myplugin.path).toBe("/absolute/path/to/plugin");
    });
  });

  describe("validation", () => {
    it("validates config schema after loading", () => {
      const configPath = join(tempDir, "config.json5");
      writeFileSync(configPath, `
        {
          llm: { providers: {} },
          plugins: {},
          agents: {},
        }
      `);

      expect(() => loadConfig(configPath)).not.toThrow();
    });
  });
});
