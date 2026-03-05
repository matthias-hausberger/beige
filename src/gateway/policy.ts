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
   * Get the target for a tool (gateway or sandbox).
   */
  getToolTarget(toolName: string): "gateway" | "sandbox" | undefined {
    const tool = this.config.tools[toolName];
    return tool?.target;
  }
}
