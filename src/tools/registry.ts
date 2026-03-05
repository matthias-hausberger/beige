import { resolve } from "path";
import type { BeigeConfig, ToolManifest } from "../config/schema.js";
import { loadToolManifest, type ToolHandler, type ToolRunner } from "./runner.js";

export interface LoadedTool {
  name: string;
  manifest: ToolManifest;
  path: string;
  handler?: ToolHandler;
}

/**
 * Load all tool packages from config, register gateway-targeted handlers.
 */
export async function loadTools(
  config: BeigeConfig,
  runner: ToolRunner
): Promise<Map<string, LoadedTool>> {
  const tools = new Map<string, LoadedTool>();

  for (const [name, toolConfig] of Object.entries(config.tools)) {
    const manifest = loadToolManifest(toolConfig.path);
    const loaded: LoadedTool = {
      name,
      manifest,
      path: toolConfig.path,
    };

    // For gateway-targeted tools, dynamically import the handler
    if (toolConfig.target === "gateway") {
      const handlerPath = resolve(toolConfig.path, "index.ts");
      try {
        const mod = await import(handlerPath);
        if (typeof mod.createHandler === "function") {
          const handler = mod.createHandler(toolConfig.config ?? {});
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
    "Tool documentation is available in `/tools/packages/<name>/`.",
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
