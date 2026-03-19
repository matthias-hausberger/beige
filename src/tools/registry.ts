import { resolve } from "path";
import type { BeigeConfig, ToolManifest } from "../config/schema.js";
import { loadToolManifest, type ToolHandler, type ToolRunner, type ToolHandlerContext } from "./runner.js";

export interface LoadedTool {
  name: string;
  manifest: ToolManifest;
  path: string;
  handler?: ToolHandler;
}

/**
 * Deep-merge two plain objects. Arrays and non-object values from `override`
 * replace those in `base`; nested plain objects are merged recursively.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

export async function loadTools(
  config: BeigeConfig,
  runner: ToolRunner,
  context?: ToolHandlerContext
): Promise<Map<string, LoadedTool>> {
  const tools = new Map<string, LoadedTool>();

  // Cache imported modules so agent-specific overrides don't re-import
  const moduleCache = new Map<string, Record<string, unknown>>();

  // ── Phase 1: Load base (top-level) tool handlers ──────────────────────
  for (const [name, toolConfig] of Object.entries(config.tools)) {
    const manifest = loadToolManifest(toolConfig.path);
    const loaded: LoadedTool = {
      name,
      manifest,
      path: toolConfig.path,
    };

    if (toolConfig.target === "gateway") {
      const handlerPath = resolve(toolConfig.path, "index.ts");
      try {
        const mod = await import(handlerPath) as Record<string, unknown>;
        moduleCache.set(name, mod);
        if (typeof mod.createHandler === "function") {
          const handlerContext: ToolHandlerContext = { ...context };
          const handler = (mod.createHandler as Function)(toolConfig.config ?? {}, handlerContext);
          runner.registerHandler(name, handler);
          loaded.handler = handler;
        } else {
          console.error(`[TOOLS] Tool '${name}' at ${handlerPath} missing createHandler export`);
        }
      } catch (err) {
        console.error(`[TOOLS] Failed to load handler for '${name}':`, err);
      }
    }

    tools.set(name, loaded);
  }

  // ── Phase 2: Load agent-specific tool handler overrides ───────────────
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    if (!agentConfig.toolConfigs) continue;

    for (const [toolName, agentOverride] of Object.entries(agentConfig.toolConfigs)) {
      const toolConfig = config.tools[toolName];
      if (!toolConfig || toolConfig.target !== "gateway") continue;

      const mod = moduleCache.get(toolName);
      if (!mod || typeof mod.createHandler !== "function") continue;

      const baseConfig = toolConfig.config ?? {};
      const mergedConfig = deepMerge(baseConfig, agentOverride);
      const handlerContext: ToolHandlerContext = { ...context };
      const agentKey = `${agentName}:${toolName}`;

      try {
        const handler = (mod.createHandler as Function)(mergedConfig, handlerContext);
        runner.registerHandler(agentKey, handler);

        // Register the agent-specific loaded tool entry
        const baseTool = tools.get(toolName);
        if (baseTool) {
          tools.set(agentKey, {
            name: toolName,
            manifest: baseTool.manifest,
            path: baseTool.path,
            handler,
          });
        }

        console.log(`[TOOLS] Registered agent-specific handler '${agentKey}' (merged config)`);
      } catch (err) {
        console.error(`[TOOLS] Failed to load agent handler '${agentKey}':`, err);
      }
    }
  }

  return tools;
}

/**
 * Build tool context string for the system prompt.
 * Lists available tools with their descriptions and commands.
 */
export function buildToolContext(
  agentTools: string[],
  loadedTools: Map<string, LoadedTool>
): string {
  const lines: string[] = [
    "## Available Tools",
    "",
    "Tools are available as executables in `/tools/bin/`. Use the `exec` core tool to run them.",
    "Tool usage guides are at `/tools/packages/<name>/SKILL.md` — read this first when using a tool.",
    "Tool reference documentation (config, prerequisites) is at `/tools/packages/<name>/README.md`.",
    "",
  ];

  for (const toolName of agentTools) {
    const tool = loadedTools.get(toolName);
    if (!tool) continue;

    lines.push(`### ${toolName}`);
    lines.push(`${tool.manifest.description}`);
    if (tool.manifest.commands?.length) {
      lines.push("Commands:");
      for (const cmd of tool.manifest.commands) {
        lines.push(`  /tools/bin/${toolName} ${cmd}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
