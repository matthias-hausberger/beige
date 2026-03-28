import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolRunner } from "./runner.js";
import type { ToolHandler } from "./runner.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ToolRunner", () => {
  let runner: ToolRunner;

  beforeEach(() => {
    runner = new ToolRunner();
  });

  describe("registerHandler", () => {
    it("registers a handler for a tool", () => {
      const handler: ToolHandler = async () => ({ output: "ok", exitCode: 0 });
      runner.registerHandler("test-tool", handler);

      expect(runner.hasHandler("test-tool")).toBe(true);
    });

    it("overwrites existing handler", () => {
      const handler1: ToolHandler = async () => ({ output: "v1", exitCode: 0 });
      const handler2: ToolHandler = async () => ({ output: "v2", exitCode: 0 });

      runner.registerHandler("test-tool", handler1);
      runner.registerHandler("test-tool", handler2);

      // The second handler should be registered
      expect(runner.hasHandler("test-tool")).toBe(true);
    });
  });

  describe("hasHandler", () => {
    it("returns false for unregistered tool", () => {
      expect(runner.hasHandler("unknown")).toBe(false);
    });

    it("returns true for registered tool", () => {
      runner.registerHandler("test", async () => ({ output: "", exitCode: 0 }));
      expect(runner.hasHandler("test")).toBe(true);
    });
  });

  describe("run", () => {
    it("executes registered handler", async () => {
      const handler: ToolHandler = async (args) => ({
        output: `Args: ${args.join(", ")}`,
        exitCode: 0,
      });

      runner.registerHandler("echo", handler);

      const result = await runner.run("echo", ["a", "b", "c"]);

      expect(result.output).toBe("Args: a, b, c");
      expect(result.exitCode).toBe(0);
    });

    it("returns error for unknown tool", async () => {
      const result = await runner.run("unknown", ["args"]);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Unknown tool");
    });

    it("passes config to handler when set", async () => {
      const handler: ToolHandler = async (args, config) => ({
        output: `Config: ${JSON.stringify(config)}`,
        exitCode: 0,
      });

      runner.registerHandler("configured", handler);

      // Without config set on runner, config is undefined
      const result = await runner.run("configured", ["test"]);
      expect(result.output).toContain("undefined");
    });

    it("resolves per-agent plugin config and passes to handler", async () => {
      const handler: ToolHandler = async (args, config) => ({
        output: `Config: ${JSON.stringify(config)}`,
        exitCode: 0,
      });

      runner.registerHandler("git", handler);
      runner.setConfig({
        llm: { providers: { anthropic: {} } },
        plugins: {
          git: { config: { defaultBranch: "main", timeout: 30 } },
        },
        agents: {
          dev: {
            model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            tools: ["git"],
            pluginConfigs: {
              git: { defaultBranch: "develop" },
            },
          },
          basic: {
            model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            tools: ["git"],
          },
        },
      });

      // Agent with override — should deep-merge
      const devResult = await runner.run("git", ["status"], {
        channel: "test",
        agentName: "dev",
      } as any);
      expect(JSON.parse(devResult.output.replace("Config: ", ""))).toEqual({
        defaultBranch: "develop",
        timeout: 30,
      });

      // Agent without override — should get base config
      const basicResult = await runner.run("git", ["status"], {
        channel: "test",
        agentName: "basic",
      } as any);
      expect(JSON.parse(basicResult.output.replace("Config: ", ""))).toEqual({
        defaultBranch: "main",
        timeout: 30,
      });
    });

    it("resolves config for dotted tool names", async () => {
      const handler: ToolHandler = async (args, config) => ({
        output: `Config: ${JSON.stringify(config)}`,
        exitCode: 0,
      });

      runner.registerHandler("telegram.send", handler);
      runner.setConfig({
        llm: { providers: { anthropic: {} } },
        plugins: {
          telegram: { config: { botToken: "abc123" } },
        },
        agents: {},
      });

      const result = await runner.run("telegram.send", ["hello"]);
      expect(JSON.parse(result.output.replace("Config: ", ""))).toEqual({
        botToken: "abc123",
      });
    });

    it("handles handler errors", async () => {
      const handler: ToolHandler = async () => {
        throw new Error("Handler failed");
      };

      runner.registerHandler("failing", handler);

      // The runner doesn't catch errors - they propagate
      await expect(runner.run("failing", [])).rejects.toThrow("Handler failed");
    });

    it("handles async handlers", async () => {
      const handler: ToolHandler = async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { output: "async result", exitCode: 0 };
      };

      runner.registerHandler("async", handler);

      const result = await runner.run("async", []);

      expect(result.output).toBe("async result");
    });

    it("prefers agent-specific handler when sessionContext.agentName is set", async () => {
      const baseHandler: ToolHandler = async () => ({ output: "base", exitCode: 0 });
      const agentHandler: ToolHandler = async () => ({ output: "agent-specific", exitCode: 0 });

      runner.registerHandler("my-tool", baseHandler);
      runner.registerHandler("researcher:my-tool", agentHandler);

      // With agent name — should use agent-specific handler
      const agentResult = await runner.run("my-tool", [], {
        channel: "test",
        agentName: "researcher",
      } as any);
      expect(agentResult.output).toBe("agent-specific");

      // Without agent name — should fall back to base handler
      const baseResult = await runner.run("my-tool", []);
      expect(baseResult.output).toBe("base");
    });

    it("falls back to base handler when no agent-specific handler exists", async () => {
      const baseHandler: ToolHandler = async () => ({ output: "base", exitCode: 0 });

      runner.registerHandler("my-tool", baseHandler);

      // Agent name provided but no agent-specific handler registered
      const result = await runner.run("my-tool", [], {
        channel: "test",
        agentName: "assistant",
      } as any);
      expect(result.output).toBe("base");
    });

    it("returns error when neither agent-specific nor base handler exists", async () => {
      const result = await runner.run("missing", [], {
        channel: "test",
        agentName: "assistant",
      } as any);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Unknown tool");
    });

    it("calls onToolStart callback with tool name and parsed args", async () => {
      const handler: ToolHandler = async () => ({ output: "test result", exitCode: 0 });
      runner.registerHandler("test", handler);

      const onToolStart = vi.fn();
      const result = await runner.run("test", ["key1=val1", "key2=val2"], {
        channel: "test",
        agentName: "assistant",
        onToolStart,
      } as any);

      // Verify callback was invoked with correct args
      // argsToObject only maps "key=value" style args; positional args without "=" are ignored.
      expect(onToolStart).toHaveBeenCalledWith("test", { _args: ["key1=val1", "key2=val2"], key1: "val1", key2: "val2" });
      expect(result.output).toBe("test result");
    });
  });
});

