import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadTools, buildToolContext, deepMerge } from "./registry.js";
import { ToolRunner } from "./runner.js";
import { createMinimalConfig } from "../test/fixtures.js";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("deepMerge", () => {
  it("merges flat objects", () => {
    const base = { a: 1, b: 2 };
    const override = { b: 3, c: 4 };
    expect(deepMerge(base, override)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("deep-merges nested objects", () => {
    const base = { viewport: { width: 1280, height: 720 }, timeout: 30000 };
    const override = { viewport: { width: 1920 } };
    expect(deepMerge(base, override)).toEqual({
      viewport: { width: 1920, height: 720 },
      timeout: 30000,
    });
  });

  it("replaces arrays (does not merge them)", () => {
    const base = { items: [1, 2, 3] };
    const override = { items: [4, 5] };
    expect(deepMerge(base, override)).toEqual({ items: [4, 5] });
  });

  it("replaces null values", () => {
    const base = { a: { nested: true } };
    const override = { a: null };
    expect(deepMerge(base, override)).toEqual({ a: null });
  });

  it("replaces primitives in override", () => {
    const base = { a: "string" };
    const override = { a: 42 };
    expect(deepMerge(base, override)).toEqual({ a: 42 });
  });

  it("does not mutate base or override", () => {
    const base = { a: { x: 1 }, b: 2 };
    const override = { a: { y: 2 }, c: 3 };
    const baseCopy = JSON.parse(JSON.stringify(base));
    const overrideCopy = JSON.parse(JSON.stringify(override));

    deepMerge(base, override);

    expect(base).toEqual(baseCopy);
    expect(override).toEqual(overrideCopy);
  });

  it("handles empty base", () => {
    expect(deepMerge({}, { a: 1 })).toEqual({ a: 1 });
  });

  it("handles empty override", () => {
    expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it("handles deeply nested merges", () => {
    const base = { level1: { level2: { level3: { a: 1, b: 2 } } } };
    const override = { level1: { level2: { level3: { b: 99 } } } };
    expect(deepMerge(base, override)).toEqual({
      level1: { level2: { level3: { a: 1, b: 99 } } },
    });
  });

  it("override can replace an object with a primitive", () => {
    const base = { a: { nested: true } };
    const override = { a: "flat" };
    expect(deepMerge(base, override)).toEqual({ a: "flat" });
  });
});

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

  it("passes ToolHandlerContext fields to createHandler", async () => {
    // Write a tool that captures the context object it receives
    const toolDir = join(tempDir, "ctx-tool");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      join(toolDir, "tool.json"),
      JSON.stringify({ name: "ctx-tool", description: "Context test", target: "gateway" })
    );
    // The handler records the context it was given into a module-level variable
    // so the test can inspect it after loadTools() returns.
    writeFileSync(
      join(toolDir, "index.ts"),
      `
        export let capturedContext = undefined;
        export function createHandler(config, context) {
          capturedContext = context;
          return async (args) => ({ output: "ok", exitCode: 0 });
        }
      `
    );

    const config = createMinimalConfig({
      tools: { "ctx-tool": { path: toolDir, target: "gateway" } },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["ctx-tool"],
        },
      },
    });

    const agentManagerRef = { current: null };
    const sessionStore = { getEntry: () => undefined, createSession: () => "" } as any;
    const beigeConfig = config;

    await loadTools(config, runner, { agentManagerRef, sessionStore, beigeConfig });

    // Import the tool module to read the captured context
    const mod = await import(join(toolDir, "index.ts"));
    expect(mod.capturedContext).toBeDefined();
    expect(mod.capturedContext.agentManagerRef).toBe(agentManagerRef);
    expect(mod.capturedContext.sessionStore).toBe(sessionStore);
    expect(mod.capturedContext.beigeConfig).toBe(beigeConfig);
  });

  it("works without context argument (backward compatible)", async () => {
    createToolPackage("compat-tool", "gateway", true);

    const config = createMinimalConfig({
      tools: { "compat-tool": { path: join(tempDir, "compat-tool"), target: "gateway" } },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["compat-tool"],
        },
      },
    });

    // Should not throw — context is optional
    await expect(loadTools(config, runner)).resolves.toBeDefined();
    expect(runner.hasHandler("compat-tool")).toBe(true);
  });

  it("registers agent-specific handlers for toolConfigs overrides", async () => {
    // Create a tool that echoes its config back so we can verify the merge
    const toolDir = join(tempDir, "configurable");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      join(toolDir, "tool.json"),
      JSON.stringify({ name: "configurable", description: "Configurable tool", target: "gateway" })
    );
    writeFileSync(
      join(toolDir, "index.ts"),
      `
        export function createHandler(config) {
          return async (args) => {
            return { output: JSON.stringify(config), exitCode: 0 };
          };
        }
      `
    );

    const config = createMinimalConfig({
      tools: {
        configurable: {
          path: toolDir,
          target: "gateway",
          config: { timeout: 1000, headless: true },
        },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["configurable"],
          // No toolConfigs — uses top-level config
        },
        researcher: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["configurable"],
          toolConfigs: {
            configurable: { timeout: 5000 },
          },
        },
      },
    });

    const tools = await loadTools(config, runner);

    // Base handler registered
    expect(runner.hasHandler("configurable")).toBe(true);
    // Agent-specific handler registered
    expect(runner.hasHandler("researcher:configurable")).toBe(true);

    // Verify base handler returns top-level config
    const baseResult = await runner.run("configurable", []);
    expect(JSON.parse(baseResult.output)).toEqual({ timeout: 1000, headless: true });

    // Verify agent-specific handler returns deep-merged config
    const agentResult = await runner.run("researcher:configurable", []);
    expect(JSON.parse(agentResult.output)).toEqual({ timeout: 5000, headless: true });
  });

  it("does not register agent-specific handlers when no toolConfigs", async () => {
    createToolPackage("plain-tool", "gateway", true);

    const config = createMinimalConfig({
      tools: {
        "plain-tool": { path: join(tempDir, "plain-tool"), target: "gateway" },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["plain-tool"],
        },
      },
    });

    await loadTools(config, runner);

    expect(runner.hasHandler("plain-tool")).toBe(true);
    expect(runner.hasHandler("assistant:plain-tool")).toBe(false);
  });

  it("skips agent-specific handlers for sandbox tools", async () => {
    createToolPackage("sandbox-cfg", "sandbox", true);

    const config = createMinimalConfig({
      tools: {
        "sandbox-cfg": { path: join(tempDir, "sandbox-cfg"), target: "sandbox" },
      },
      agents: {
        assistant: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["sandbox-cfg"],
          toolConfigs: {
            "sandbox-cfg": { some: "override" },
          },
        },
      },
    });

    await loadTools(config, runner);

    expect(runner.hasHandler("sandbox-cfg")).toBe(false);
    expect(runner.hasHandler("assistant:sandbox-cfg")).toBe(false);
  });

  it("deep-merges nested tool config with agent override", async () => {
    const toolDir = join(tempDir, "nested-cfg");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      join(toolDir, "tool.json"),
      JSON.stringify({ name: "nested-cfg", description: "Nested config tool", target: "gateway" })
    );
    writeFileSync(
      join(toolDir, "index.ts"),
      `
        export function createHandler(config) {
          return async () => ({ output: JSON.stringify(config), exitCode: 0 });
        }
      `
    );

    const config = createMinimalConfig({
      tools: {
        "nested-cfg": {
          path: toolDir,
          target: "gateway",
          config: {
            viewport: { width: 1280, height: 720 },
            blockedDomains: [],
          },
        },
      },
      agents: {
        researcher: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          tools: ["nested-cfg"],
          toolConfigs: {
            "nested-cfg": {
              viewport: { width: 1920 },
              blockedDomains: ["ads.example.com"],
            },
          },
        },
      },
    });

    await loadTools(config, runner);

    const result = await runner.run("researcher:nested-cfg", []);
    expect(JSON.parse(result.output)).toEqual({
      viewport: { width: 1920, height: 720 },
      blockedDomains: ["ads.example.com"],
    });
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
