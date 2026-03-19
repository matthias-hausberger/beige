import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolRunner, loadToolManifest } from "./runner.js";
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

    it("passes config to handler", async () => {
      const handler: ToolHandler = async (args, config) => ({
        output: `Config: ${JSON.stringify(config)}`,
        exitCode: 0,
      });

      runner.registerHandler("configured", handler);

      const result = await runner.run("configured", ["test"]);

      // Config is undefined when called via run() directly
      expect(result.output).toContain("undefined");
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
  });
});

describe("loadToolManifest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-tool-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads valid tool.json", () => {
    const toolDir = join(tempDir, "my-tool");
    mkdirSync(toolDir);

    writeFileSync(join(toolDir, "tool.json"), JSON.stringify({
      name: "my-tool",
      description: "A test tool",
      commands: ["run <arg>", "status"],
      target: "gateway",
    }));

    const manifest = loadToolManifest(toolDir);

    expect(manifest.name).toBe("my-tool");
    expect(manifest.description).toBe("A test tool");
    expect(manifest.commands).toEqual(["run <arg>", "status"]);
    expect(manifest.target).toBe("gateway");
  });

  it("loads minimal tool.json", () => {
    const toolDir = join(tempDir, "minimal-tool");
    mkdirSync(toolDir);

    writeFileSync(join(toolDir, "tool.json"), JSON.stringify({
      name: "minimal",
      description: "Minimal tool",
      target: "sandbox",
    }));

    const manifest = loadToolManifest(toolDir);

    expect(manifest.name).toBe("minimal");
    expect(manifest.commands).toBeUndefined();
    expect(manifest.target).toBe("sandbox");
  });

  it("throws when tool.json is missing", () => {
    const toolDir = join(tempDir, "no-manifest");
    mkdirSync(toolDir);

    expect(() => loadToolManifest(toolDir)).toThrow();
  });

  it("throws when tool.json is invalid JSON", () => {
    const toolDir = join(tempDir, "invalid-manifest");
    mkdirSync(toolDir);

    writeFileSync(join(toolDir, "tool.json"), "not valid json");

    expect(() => loadToolManifest(toolDir)).toThrow();
  });
});
