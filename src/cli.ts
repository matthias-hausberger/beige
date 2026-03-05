#!/usr/bin/env node

/**
 * Beige CLI
 *
 * Usage:
 *   beige                              Start the gateway (API server + channels)
 *   beige tui [agent]                  Connect to a running gateway via TUI
 *   beige --config <path>              Use a specific config file
 *
 * The gateway runs in one shell, the TUI connects to it from another:
 *
 *   Shell 1:  beige                    ← starts gateway, sandboxes, API
 *   Shell 2:  beige tui testo          ← interactive TUI, proxies tools to gateway
 */

import { resolve } from "path";
import { homedir } from "os";
import { loadConfig } from "./config/loader.js";

// ── Parse args ──────────────────────────────────────────────────────

const defaultConfigPath = resolve(homedir(), ".beige", "config.json5");
let configPath = defaultConfigPath;
let mode: "gateway" | "tui" = "gateway";
let agentName: string | undefined;
let gatewayUrl: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--config" || arg === "-c") {
    configPath = args[++i];
  } else if (arg === "--gateway" || arg === "-g") {
    gatewayUrl = args[++i];
  } else if (arg === "tui") {
    mode = "tui";
    if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
      agentName = args[++i];
    }
  } else if (arg === "--help" || arg === "-h") {
    console.log(`
Beige — Secure sandboxed agent system

Usage:
  beige                                  Start the gateway
  beige tui [agent]                      Connect TUI to running gateway

Start the gateway in one shell, then connect with TUI from another:

  Shell 1:  beige
  Shell 2:  beige tui testo

Options:
  -c, --config <path>        Config file (default: ~/.beige/config.json5)
  -g, --gateway <url>        Gateway URL for TUI (default: http://127.0.0.1:7433)
  -h, --help                 Show this help
`);
    process.exit(0);
  }
}

// ── Load config ─────────────────────────────────────────────────────

console.log(`[BEIGE] Loading config from: ${resolve(configPath)}`);
const config = loadConfig(configPath);

// ── Mode: Gateway ───────────────────────────────────────────────────

if (mode === "gateway") {
  const { Gateway } = await import("./gateway/gateway.js");
  const gateway = new Gateway(config);

  const shutdown = async () => {
    console.log("\n[BEIGE] Shutting down...");
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await gateway.start();
  } catch (err) {
    console.error("[BEIGE] Failed to start gateway:", err);
    process.exit(1);
  }
}

// ── Mode: TUI ───────────────────────────────────────────────────────

if (mode === "tui") {
  // Resolve agent name
  const agentNames = Object.keys(config.agents);
  if (agentNames.length === 0) {
    console.error("[BEIGE] No agents defined in config");
    process.exit(1);
  }

  if (!agentName) {
    agentName = agentNames[0];
    if (agentNames.length > 1) {
      console.log(
        `[BEIGE] No agent specified, using '${agentName}'. Available: ${agentNames.join(", ")}`
      );
    }
  }

  if (!config.agents[agentName]) {
    console.error(
      `[BEIGE] Unknown agent '${agentName}'. Available: ${agentNames.join(", ")}`
    );
    process.exit(1);
  }

  const url =
    gatewayUrl ??
    `http://${config.server?.host ?? "127.0.0.1"}:${config.server?.port ?? 7433}`;

  const { launchTUI } = await import("./channels/tui.js");

  try {
    await launchTUI({
      config,
      agentName,
      gatewayUrl: url,
    });
  } catch (err) {
    console.error("[BEIGE] TUI error:", err);
    process.exit(1);
  }
}
