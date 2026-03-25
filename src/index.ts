/**
 * Programmatic entry point.
 * For CLI usage, see src/cli.ts.
 */

export { Gateway } from "./gateway/gateway.js";
export { GatewayAPI } from "./gateway/api.js";
export { loadConfig } from "./config/loader.js";
export { BeigeSessionStore } from "./gateway/sessions.js";
export {
  formatChannelError,
  /** @deprecated Use formatChannelError instead */
  formatTelegramError,
  isAllModelsExhausted,
  formatAllModelsExhaustedError,
  getErrorTag,
} from "./gateway/llm-errors.js";
export { launchTUI } from "./channels/tui.js";
export type { BeigeConfig } from "./config/schema.js";

// Plugin system exports — used by plugin authors (e.g. beige-toolkit)
export {
  PluginRegistry,
  createPluginContext,
  createLogger,
} from "./plugins/index.js";

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
} from "./plugins/index.js";
