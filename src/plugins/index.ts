/**
 * Plugin system — public exports.
 */

export { PluginRegistry } from "./registry.js";
export { loadPlugins, startPlugins, stopPlugins, loadPluginManifest } from "./loader.js";
export { ensurePluginsInstalled } from "./installer.js";
export { createPluginContext, createLogger } from "./context.js";
export type { AgentManagerRef, ModelRegistryRef, PluginContextDeps } from "./context.js";
export type { LoadedPlugin } from "./loader.js";

// Re-export all plugin types so consumers (beige-toolkit) can import from beige
export type {
  PluginManifest,
  PluginInstance,
  PluginContext,
  PluginRegistrar,
  PluginTool,
  PluginSkill,
  PluginLogger,
  ChannelAdapter,
  SendMessageOptions,
  ToolResult,
  ToolHandler,
  ReplyTarget,
  SessionSettings,
  PromptOpts,
  CreatePluginFn,
  HookName,
  HookHandler,
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
  ModelInfo,
  LlmMessage,
  LlmTextContent,
  LlmImageContent,
  LlmPromptOpts,
} from "./types.js";
