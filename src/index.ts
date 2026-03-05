/**
 * Programmatic entry point.
 * For CLI usage, see src/cli.ts.
 */

export { Gateway } from "./gateway/gateway.js";
export { GatewayAPI } from "./gateway/api.js";
export { loadConfig } from "./config/loader.js";
export { BeigeSessionStore } from "./gateway/sessions.js";
export { launchTUI } from "./channels/tui.js";
export type { BeigeConfig } from "./config/schema.js";
