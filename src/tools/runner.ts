import type { BeigeConfig, ToolManifest } from "../config/schema.js";
import type { SessionContext } from "../types/session.js";
import { readFileSync } from "fs";
import { resolve } from "path";

export interface ToolResult {
  output: string;
  exitCode: number;
}

export interface ToolHandlerContext {
  channelRegistry?: import("../channels/registry.js").ChannelRegistry;
  /**
   * Mutable reference to the AgentManager, populated after it is created.
   * Tools receive a ref (not the instance directly) because tools are loaded
   * before the AgentManager is constructed — the ref is always resolved by
   * the time any tool handler is actually invoked.
   */
  agentManagerRef?: { current: import("../gateway/agent-manager.js").AgentManager | null };
  /**
   * The session store, available to tools that need to read or write
   * per-session metadata.
   */
  sessionStore?: import("../gateway/sessions.js").BeigeSessionStore;
  /**
   * The full resolved Beige config.  Tools may use this to validate agent
   * names, inspect tool lists, etc.
   */
  beigeConfig?: import("../config/schema.js").BeigeConfig;
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
    const handler = this.handlers.get(toolName);
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

/**
 * Load tool manifests from the config.
 */
export function loadToolManifest(toolPath: string): ToolManifest {
  const manifestPath = resolve(toolPath, "tool.json");
  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as ToolManifest;
}
