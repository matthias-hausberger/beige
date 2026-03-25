import type { SessionContext } from "../types/session.js";
import type { BeigeConfig } from "../config/schema.js";
import type { PluginRegistry } from "../plugins/registry.js";

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
 * Deep-merge two objects. Arrays are replaced, not concatenated.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Executes tool handlers on the gateway host.
 * Tools register their handlers here. The socket server calls this to run tools.
 */
export class ToolRunner {
  private handlers = new Map<string, ToolHandler>();
  private config: BeigeConfig | null = null;
  private pluginRegistry: PluginRegistry | null = null;

  /**
   * Set the config reference so the runner can resolve per-agent plugin configs.
   */
  setConfig(config: BeigeConfig): void {
    this.config = config;
  }

  /**
   * Set the plugin registry so the runner can execute preToolExec/postToolExec hooks.
   */
  setPluginRegistry(registry: PluginRegistry): void {
    this.pluginRegistry = registry;
  }

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

    // Execute preToolExec hooks — may deny the call
    if (this.pluginRegistry) {
      const preResult = await this.pluginRegistry.executePreToolExec({
        toolName,
        args,
        sessionKey: sessionContext?.agentName ? `${sessionContext.channel ?? "unknown"}:${sessionContext.agentName}` : "",
        agentName: sessionContext?.agentName ?? "",
      });
      if (!preResult.allow) {
        return {
          output: preResult.reason ?? `Tool call '${toolName}' denied by hook.`,
          exitCode: 1,
        };
      }
    }

    // Resolve the effective config for this tool call:
    // base plugin config + per-agent pluginConfigs override (if any)
    const config = this.resolveToolConfig(toolName, sessionContext?.agentName);

    let result = await handler(args, config, sessionContext);

    // Execute postToolExec hooks — may transform the result
    if (this.pluginRegistry) {
      const postResult = await this.pluginRegistry.executePostToolExec({
        toolName,
        args,
        result,
        sessionKey: sessionContext?.agentName ? `${sessionContext.channel ?? "unknown"}:${sessionContext.agentName}` : "",
        agentName: sessionContext?.agentName ?? "",
      });
      if (postResult.result) {
        result = postResult.result;
      }
    }

    return result;
  }

  hasHandler(toolName: string): boolean {
    return this.handlers.has(toolName);
  }

  /**
   * Resolve the effective config for a tool call by deep-merging the base
   * plugin config with any per-agent pluginConfigs override.
   *
   * For a tool named "git" or "git.status", the plugin name is "git".
   * Base config comes from config.plugins.git.config.
   * Agent override comes from config.agents.<agent>.pluginConfigs.git.
   */
  private resolveToolConfig(
    toolName: string,
    agentName?: string
  ): Record<string, unknown> | undefined {
    if (!this.config) return undefined;

    // Derive plugin name from tool name (e.g. "slack.send_message" → "slack")
    const pluginName = toolName.includes(".") ? toolName.split(".")[0] : toolName;

    const baseConfig = this.config.plugins?.[pluginName]?.config;
    const agentOverride = agentName
      ? this.config.agents[agentName]?.pluginConfigs?.[pluginName]
      : undefined;

    if (!baseConfig && !agentOverride) return undefined;
    if (!agentOverride) return baseConfig;
    if (!baseConfig) return agentOverride;

    return deepMerge(baseConfig, agentOverride);
  }
}
