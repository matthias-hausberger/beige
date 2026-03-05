#!/usr/bin/env node

/**
 * Beige CLI
 *
 * The gateway always runs. Channels are interfaces plugged into it.
 *
 * Usage:
 *   beige                              Start gateway (configured channels only)
 *   beige --tui [agent]                Start gateway + attach interactive TUI
 *   beige --config <path>              Use a specific config file
 *
 * Examples:
 *   beige                              Gateway with Telegram (if configured)
 *   beige --tui                        Gateway + TUI (first agent)
 *   beige --tui travel                 Gateway + TUI for "travel" agent
 *   beige -c prod.json5 --tui          Different config + TUI
 *   beige --tui travel -r session.jsonl Resume specific session
 */

import { resolve } from "path";
import { loadConfig } from "./config/loader.js";
import { Gateway } from "./gateway/gateway.js";

// ── Parse args ──────────────────────────────────────────────────────

let configPath = "config.json5";
let tuiAgent: string | undefined;
let tuiEnabled = false;
let resumeFile: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--config" || arg === "-c") {
    configPath = args[++i];
  } else if (arg === "--tui" || arg === "tui") {
    tuiEnabled = true;
    // Next non-flag arg is the agent name
    if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
      tuiAgent = args[++i];
    }
  } else if (arg === "--resume" || arg === "-r") {
    resumeFile = args[++i];
  } else if (arg === "--help" || arg === "-h") {
    console.log(`
Beige — Secure sandboxed agent system

The gateway always runs. Channels (Telegram, TUI) are interfaces plugged into it.

Usage:
  beige                                  Start gateway
  beige --tui [agent]                    Start gateway + interactive TUI
  beige --tui [agent] --resume <file>    Resume a specific session

Options:
  --tui [agent]              Attach interactive TUI channel
  -c, --config <path>        Config file (default: config.json5)
  -r, --resume <file>        Resume a specific session file (with --tui)
  -h, --help                 Show this help

TUI commands (inside the interactive session):
  /new                       Start a new conversation session
  /resume                    Pick a previous session to continue
  /sessions                  List sessions for the current agent
  /agent [name]              Switch to a different beige agent
`);
    process.exit(0);
  }
}

// ── Load config + start gateway ─────────────────────────────────────

console.log(`[BEIGE] Loading config from: ${resolve(configPath)}`);

const config = loadConfig(configPath);

// Resolve TUI agent name
if (tuiEnabled && !tuiAgent) {
  const agentNames = Object.keys(config.agents);
  if (agentNames.length === 0) {
    console.error("[BEIGE] No agents defined in config");
    process.exit(1);
  }
  tuiAgent = agentNames[0];
  if (agentNames.length > 1) {
    console.log(
      `[BEIGE] No agent specified for TUI, using '${tuiAgent}'. Available: ${agentNames.join(", ")}`
    );
  }
}

const gateway = new Gateway(config);

// Graceful shutdown
const shutdown = async () => {
  console.log("\n[BEIGE] Received shutdown signal...");
  await gateway.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await gateway.start({
    tui: tuiAgent,
    tuiResumeFile: resumeFile,
  });
} catch (err) {
  console.error("[BEIGE] Failed to start:", err);
  process.exit(1);
}
