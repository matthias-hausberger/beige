/**
 * Programmatic entry point.
 * For CLI usage, see src/cli.ts.
 */

export { Gateway } from "./gateway/gateway.js";
export { loadConfig } from "./config/loader.js";
export { BeigeSessionStore } from "./gateway/sessions.js";
export type { BeigeConfig } from "./config/schema.js";
