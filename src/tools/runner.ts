import type { SessionContext } from "../types/session.js";
import { readFileSync } from "fs";
import { resolve } from "path";

export interface ToolResult {
  output: string;
  exitCode: number;
}

export type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: SessionContext
) => Promise<ToolResult>;

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

  async run(toolName: string, args: string[], sessionContext?: SessionContext): Promise<ToolResult> {
    // Prefer agent-specific handler (registered as "agentName:toolName"),
    // fall back to the base handler.
    const agentKey = sessionContext?.agentName
      ? `${sessionContext.agentName}:${toolName}`
      : undefined;
    const handler =
      (agentKey && this.handlers.get(agentKey)) ?? this.handlers.get(toolName);
    if (!handler) {
      return {
        output: `Unknown tool: ${toolName}`,
        exitCode: 1,
      };
    }
    return handler(args, undefined, sessionContext);
  }

  hasHandler(toolName: string): boolean {
    return this.handlers.has(toolName);
  }
}
