/**
 * Plugin registry.
 *
 * Central store for all plugin-registered tools, channels, hooks, and skills.
 * Created once per gateway lifecycle; passed to plugins via PluginRegistrar.
 */

import type {
  PluginTool,
  ChannelAdapter,
  HookName,
  HookHandler,
  PluginSkill,
  PluginRegistrar,
  HookTypeMap,
  PrePromptEvent,
  PrePromptResult,
  PostResponseEvent,
  PostResponseResult,
  PreToolExecEvent,
  PreToolExecResult,
  PostToolExecEvent,
  PostToolExecResult,
  SessionLifecycleEvent,
  GatewayLifecycleEvent,
} from "./types.js";

// ── Hook entry (stores plugin name for debugging/logging) ────────────────────

interface HookEntry<H extends HookName = HookName> {
  pluginName: string;
  handler: HookHandler<H>;
}

// ── Plugin Registry ──────────────────────────────────────────────────────────

export class PluginRegistry {
  private tools = new Map<string, PluginTool>();
  private channels = new Map<string, ChannelAdapter>();
  private hooks = new Map<HookName, HookEntry[]>();
  private skills = new Map<string, PluginSkill>();
  /** Tracks which plugin registered each tool (for error messages). */
  private toolOwners = new Map<string, string>();

  // ── Tool registration ──────────────────────────────────────────────

  registerTool(pluginName: string, tool: PluginTool): void {
    // Enforce naming: tool name must equal plugin name or start with pluginName.
    if (tool.name !== pluginName && !tool.name.startsWith(`${pluginName}.`)) {
      throw new Error(
        `Plugin '${pluginName}' tried to register tool '${tool.name}'. ` +
        `Tool names must equal the plugin name or start with '${pluginName}.'.`
      );
    }

    // Check for conflicts
    if (this.tools.has(tool.name)) {
      const existingOwner = this.toolOwners.get(tool.name);
      throw new Error(
        `Tool name conflict: '${tool.name}' is already registered by plugin '${existingOwner}'.`
      );
    }

    this.tools.set(tool.name, tool);
    this.toolOwners.set(tool.name, pluginName);
    console.log(`[PLUGINS] Registered tool '${tool.name}' (from plugin '${pluginName}')`);
  }

  getTool(name: string): PluginTool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): Map<string, PluginTool> {
    return new Map(this.tools);
  }

  getRegisteredToolNames(): string[] {
    return [...this.tools.keys()];
  }

  // ── Channel registration ───────────────────────────────────────────

  registerChannel(name: string, adapter: ChannelAdapter): void {
    if (this.channels.has(name)) {
      throw new Error(`Channel '${name}' is already registered.`);
    }
    this.channels.set(name, adapter);
    console.log(`[PLUGINS] Registered channel '${name}'`);
  }

  getChannel(name: string): ChannelAdapter | undefined {
    return this.channels.get(name);
  }

  hasChannel(name: string): boolean {
    return this.channels.has(name);
  }

  // ── Hook registration ──────────────────────────────────────────────

  registerHook<H extends HookName>(pluginName: string, hookName: H, handler: HookHandler<H>): void {
    let entries = this.hooks.get(hookName);
    if (!entries) {
      entries = [];
      this.hooks.set(hookName, entries);
    }
    entries.push({ pluginName, handler: handler as unknown as HookHandler });
    console.log(`[PLUGINS] Registered hook '${hookName}' (from plugin '${pluginName}')`);
  }

  // ── Hook execution ─────────────────────────────────────────────────
  // Hooks execute sequentially in registration order (= config order).

  async executePrePrompt(event: PrePromptEvent): Promise<PrePromptResult> {
    const entries = this.hooks.get("prePrompt") ?? [];
    let currentMessage = event.message;

    for (const entry of entries) {
      const handler = entry.handler as HookHandler<"prePrompt">;
      const result = await handler({ ...event, message: currentMessage });
      if (result.block) {
        return result;
      }
      currentMessage = result.message;
    }

    return { message: currentMessage };
  }

  async executePostResponse(event: PostResponseEvent): Promise<PostResponseResult> {
    const entries = this.hooks.get("postResponse") ?? [];
    let currentResponse = event.response;

    for (const entry of entries) {
      const handler = entry.handler as HookHandler<"postResponse">;
      const result = await handler({ ...event, response: currentResponse });
      if (result.block) {
        return result;
      }
      currentResponse = result.response;
    }

    return { response: currentResponse };
  }

  async executePreToolExec(event: PreToolExecEvent): Promise<PreToolExecResult> {
    const entries = this.hooks.get("preToolExec") ?? [];

    for (const entry of entries) {
      const handler = entry.handler as HookHandler<"preToolExec">;
      const result = await handler(event);
      if (!result.allow) {
        return result;
      }
    }

    return { allow: true };
  }

  async executePostToolExec(event: PostToolExecEvent): Promise<PostToolExecResult> {
    const entries = this.hooks.get("postToolExec") ?? [];
    let currentResult = event.result;

    for (const entry of entries) {
      const handler = entry.handler as HookHandler<"postToolExec">;
      const hookResult = await handler({ ...event, result: currentResult });
      if (hookResult.result) {
        currentResult = hookResult.result;
      }
    }

    return { result: currentResult };
  }

  async executeSessionCreated(event: SessionLifecycleEvent): Promise<void> {
    const entries = this.hooks.get("sessionCreated") ?? [];
    for (const entry of entries) {
      const handler = entry.handler as HookHandler<"sessionCreated">;
      await handler(event);
    }
  }

  async executeSessionDisposed(event: SessionLifecycleEvent): Promise<void> {
    const entries = this.hooks.get("sessionDisposed") ?? [];
    for (const entry of entries) {
      const handler = entry.handler as HookHandler<"sessionDisposed">;
      await handler(event);
    }
  }

  async executeGatewayStarted(): Promise<void> {
    const entries = this.hooks.get("gatewayStarted") ?? [];
    for (const entry of entries) {
      const handler = entry.handler as HookHandler<"gatewayStarted">;
      await handler({});
    }
  }

  async executeGatewayShutdown(): Promise<void> {
    const entries = this.hooks.get("gatewayShutdown") ?? [];
    for (const entry of entries) {
      const handler = entry.handler as HookHandler<"gatewayShutdown">;
      await handler({});
    }
  }

  // ── Skill registration ─────────────────────────────────────────────

  registerSkill(pluginName: string, skill: PluginSkill): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill '${skill.name}' is already registered.`);
    }
    this.skills.set(skill.name, skill);
    console.log(`[PLUGINS] Registered skill '${skill.name}' (from plugin '${pluginName}')`);
  }

  getSkill(name: string): PluginSkill | undefined {
    return this.skills.get(name);
  }

  getAllSkills(): Map<string, PluginSkill> {
    return new Map(this.skills);
  }

  // ── Registrar factory ──────────────────────────────────────────────

  /**
   * Create a PluginRegistrar scoped to a specific plugin.
   * Enforces tool naming rules and routes registrations to the correct stores.
   */
  createRegistrar(pluginName: string): PluginRegistrar {
    return {
      tool: (tool) => this.registerTool(pluginName, tool),
      channel: (adapter) => this.registerChannel(pluginName, adapter),
      hook: (hookName, handler) => this.registerHook(pluginName, hookName, handler),
      skill: (skill) => this.registerSkill(pluginName, skill),
    };
  }
}
