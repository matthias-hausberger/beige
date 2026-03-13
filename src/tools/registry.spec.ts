import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadTools, buildToolContext } from "./registry.js";
import { ToolRunner } from "./runner.js";
import { createMinimalConfig } from "../test/fixtures.js";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadTools", () => {
  let tempDir: string;
  let runner: ToolRunner;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-registry-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    runner = new ToolRunner();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const createToolPackage = (
    name: string,
    target: "gateway" | "sandbox",
    hasHandler = false
  ) => {
    const toolDir = join(tempDir, name);
    mkdirSync(toolDir, { recursive: true });

    writeFileSync(
      join(toolDir, "tool.json"),
      JSON.stringify({
        name,
        description: `Test tool: ${name}`,
        commands: ["run", "status"],
        target,
      })
    );

    if (hasHandler) {
      writeFileSync(
        join(toolDir, "index.ts"),
        `
          export function createHandler(config) {
            return async (args) => {
              return { output: "handled: " + args.join(" "), exitCode: 0 };
            };
          }
        `
      );
    }
  };

  it("loads tool manifests", async () => {
    createToolPackage("test-tool", "gateway");
    createToolPackage("sandbox-tool", "sandbox");

    const config = createMinimalConfig({
      tools: {
        "test-tool": { path: join(tempDir, "test-tool"), target: "gateway" },
        "sandbox-tool": { path: join(tempDir, "sandbox-tool"), target: "sandbox" },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["test-tool", "sandbox-tool"],
        },
      },
    });

    const tools = await loadTools(config, runner);

    expect(tools.size).toBe(2);
    expect(tools.get("test-tool")).toBeDefined();
    expect(tools.get("sandbox-tool")).toBeDefined();
  });

  it("registers handler for gateway tools", async () => {
    createToolPackage("gateway-tool", "gateway", true);

    const config = createMinimalConfig({
      tools: {
        "gateway-tool": { path: join(tempDir, "gateway-tool"), target: "gateway" },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["gateway-tool"],
        },
      },
    });

    await loadTools(config, runner);

    expect(runner.hasHandler("gateway-tool")).toBe(true);
  });

  it("does not register handler for sandbox tools", async () => {
    createToolPackage("sandbox-tool", "sandbox", true);

    const config = createMinimalConfig({
      tools: {
        "sandbox-tool": { path: join(tempDir, "sandbox-tool"), target: "sandbox" },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["sandbox-tool"],
        },
      },
    });

    await loadTools(config, runner);

    expect(runner.hasHandler("sandbox-tool")).toBe(false);
  });

  it("handles tools without createHandler export", async () => {
    const toolDir = join(tempDir, "no-handler");
    mkdirSync(toolDir, { recursive: true });

    writeFileSync(
      join(toolDir, "tool.json"),
      JSON.stringify({
        name: "no-handler",
        description: "Tool without handler",
        target: "gateway",
      })
    );

    writeFileSync(join(toolDir, "index.ts"), "// No createHandler export");

    const config = createMinimalConfig({
      tools: {
        "no-handler": { path: toolDir, target: "gateway" },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["no-handler"],
        },
      },
    });

    // Should not throw
    const tools = await loadTools(config, runner);

    expect(tools.size).toBe(1);
    expect(runner.hasHandler("no-handler")).toBe(false);
  });

  it("handles missing tool.json gracefully", async () => {
    const toolDir = join(tempDir, "broken-tool");
    mkdirSync(toolDir, { recursive: true });
    // No tool.json

    const config = createMinimalConfig({
      tools: {
        "broken-tool": { path: toolDir, target: "gateway" },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["broken-tool"],
        },
      },
    });

    // Should not throw, but tool won't be loaded
    await expect(loadTools(config, runner)).rejects.toThrow();
  });

  it("sets loaded tool properties correctly", async () => {
    createToolPackage("test", "gateway");

    const config = createMinimalConfig({
      tools: {
        test: { path: join(tempDir, "test"), target: "gateway" },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["test"],
        },
      },
    });

    const tools = await loadTools(config, runner);
    const tool = tools.get("test");

    expect(tool?.name).toBe("test");
    expect(tool?.manifest.name).toBe("test");
    expect(tool?.manifest.description).toBe("Test tool: test");
    expect(tool?.manifest.target).toBe("gateway");
    expect(tool?.path).toBe(join(tempDir, "test"));
  });
});

describe("buildToolContext", () => {
  it("builds context string for agent tools", () => {
    const loadedTools = new Map([
      [
        "kv",
        {
          name: "kv",
          manifest: {
            name: "kv",
            description: "Key-value store",
            commands: ["set <key> <value>", "get <key>"],
            target: "gateway" as const,
          },
          path: "/tools/kv",
        },
      ],
      [
        "browser",
        {
          name: "browser",
          manifest: {
            name: "browser",
            description: "Web browser automation",
            commands: ["navigate <url>", "screenshot"],
            target: "sandbox" as const,
          },
          path: "/tools/browser",
        },
      ],
    ]);

    const context = buildToolContext(["kv", "browser"], loadedTools);

    expect(context).toContain("## Available Tools");
    expect(context).toContain("### kv");
    expect(context).toContain("Key-value store");
    expect(context).toContain("### browser");
    expect(context).toContain("Web browser automation");
    expect(context).toContain("/tools/bin/kv set");
    expect(context).toContain("/tools/bin/browser navigate");
  });

  it("handles empty tools list", () => {
    const context = buildToolContext([], new Map());

    expect(context).toContain("## Available Tools");
    // Should still have the basic description
    expect(context).toContain("/tools/bin/");
  });

  it("skips tools not in loaded map", () => {
    const loadedTools = new Map([
      ["kv", { name: "kv", manifest: { name: "kv", description: "KV store", target: "gateway" as const }, path: "/tools/kv" }],
    ]);

    const context = buildToolContext(["kv", "missing"], loadedTools);

    expect(context).toContain("### kv");
    expect(context).not.toContain("### missing");
  });

  it("handles tools without commands", () => {
    const loadedTools = new Map([
      [
        "simple",
        {
          name: "simple",
          manifest: {
            name: "simple",
            description: "A simple tool",
            target: "gateway" as const,
          },
          path: "/tools/simple",
        },
      ],
    ]);

    const context = buildToolContext(["simple"], loadedTools);

    expect(context).toContain("A simple tool");
    expect(context).not.toContain("Commands:");
  });
});
