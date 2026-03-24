import type { BeigeConfig } from "../config/schema.js";

/**
 * Policy engine. Deny by default.
 * Checks whether an agent is allowed to use a specific tool.
 */
export class PolicyEngine {
  constructor(private config: BeigeConfig) {}

  /**
   * Check if an agent is allowed to use a core tool (read, write, patch, exec).
   * Core tools are always allowed for any configured agent.
   */
  isCoreTool(tool: string): boolean {
    return ["read", "write", "patch", "exec"].includes(tool);
  }

  /**
   * Check if an agent is allowed to execute a tool.
   */
  isToolAllowed(agentName: string, toolName: string): boolean {
    const agent = this.config.agents[agentName];
    if (!agent) return false;
    return agent.tools.includes(toolName);
  }

  /**
   * Check if an agent exists in the config.
   */
  isAgentValid(agentName: string): boolean {
    return agentName in this.config.agents;
  }

  /**
   * Get the target for a tool. In the plugin system, all plugin-registered
   * tools run on the gateway. Core tools are handled directly.
   */
  getToolTarget(toolName: string): "gateway" | "sandbox" | undefined {
    // In the plugin architecture, all registered tools target the gateway.
    // The plugin config doesn't have a "target" field — plugins always run in-process.
    const plugin = this.config.plugins?.[toolName];
    if (plugin) return "gateway";
    // For dotted tool names (e.g. telegram.send_message), check the base plugin
    const baseName = toolName.split(".")[0];
    if (this.config.plugins?.[baseName]) return "gateway";
    return undefined;
  }
}
