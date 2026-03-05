import type { BeigeConfig, ToolManifest } from "../config/schema.js";
import { readFileSync } from "fs";
import { resolve } from "path";

export interface ToolResult {
  output: string;
  exitCode: number;
}

export type ToolHandler = (args: string[], config?: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Executes tool handlers on the gateway host.
 * Tools register their handlers here. The socket server calls this to run tools.
 */
export class ToolRunner {
  private handlers = new Map<string, ToolHandler>();

  registerHandler(toolName: string, handler: ToolHandler): void {
    this.handlers.set(toolName, handler);
    console.log(`[TOOLS] Registered handler for '${toolName}'`);
  }

  async run(toolName: string, args: string[]): Promise<ToolResult> {
    const handler = this.handlers.get(toolName);
    if (!handler) {
      return {
        output: `Unknown tool: ${toolName}`,
        exitCode: 1,
      };
    }
    return handler(args);
  }

  hasHandler(toolName: string): boolean {
    return this.handlers.has(toolName);
  }
}

/**
 * Load tool manifests from the config.
 */
export function loadToolManifest(toolPath: string): ToolManifest {
  const manifestPath = resolve(toolPath, "tool.json");
  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as ToolManifest;
}
