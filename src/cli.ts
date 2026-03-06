#!/usr/bin/env node

/**
 * Beige CLI
 *
 * Usage:
 *   beige                              Show help
 *   beige gateway start                Start the gateway as a background daemon
 *   beige gateway start --foreground   Start the gateway in the foreground (for debugging)
 *   beige gateway stop                 Stop the running gateway daemon
 *   beige gateway status               Show whether the gateway daemon is running
 *   beige gateway logs                 Show gateway logs
 *   beige gateway logs -f              Follow gateway logs (tail -f)
 *   beige tui [agent]                  Connect to a running gateway via TUI
 *   beige --config <path>              Use a specific config file
 *
 *   Shell 1:  beige                    ← starts gateway daemon
 *   Shell 2:  beige tui testo          ← interactive TUI, proxies tools to gateway
 */

import { resolve } from "path";
import { homedir } from "os";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  createReadStream,
} from "fs";
import { spawn } from "child_process";
import { watch } from "fs";

// ── Paths ────────────────────────────────────────────────────────────

const BEIGE_DIR = resolve(homedir(), ".beige");
const PID_FILE = resolve(BEIGE_DIR, "gateway.pid");
const LOG_FILE = resolve(BEIGE_DIR, "logs", "gateway.log");

// ── Helpers ──────────────────────────────────────────────────────────

function ensureDirs() {
  mkdirSync(resolve(BEIGE_DIR, "logs"), { recursive: true });
}

/** Read the stored PID, or null if the file doesn't exist. */
function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

/** Return true if a process with the given PID is currently running. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdGatewayStart(configPath: string, foreground: boolean): Promise<void> {
  if (!foreground) {
    // Check whether a daemon is already running
    const existingPid = readPid();
    if (existingPid !== null && isRunning(existingPid)) {
      console.log(`[BEIGE] Gateway is already running (PID ${existingPid})`);
      process.exit(0);
    }

    ensureDirs();

    // Open log file for append (create if absent)
    const logFd = openSync(LOG_FILE, "a");

    // Re-invoke this same entry point in foreground mode.
    // argv[0] is always `node` regardless of whether tsx is used as a loader,
    // so we detect TypeScript source by the .ts extension on argv[1] and
    // inject `--import tsx/esm` so the child can resolve TS imports.
    const isTs = process.argv[1].endsWith(".ts");
    const spawnArgs = isTs
      ? ["--import", "tsx/esm", process.argv[1], "gateway", "start", "--foreground", "--config", configPath]
      : [process.argv[1], "gateway", "start", "--foreground", "--config", configPath];

    const child = spawn(process.execPath, spawnArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });
    child.unref();

    writeFileSync(PID_FILE, String(child.pid), "utf-8");
    console.log(`[BEIGE] Gateway daemon started (PID ${child.pid})`);
    console.log(`[BEIGE] Logs: ${LOG_FILE}`);
    console.log(`[BEIGE] Run 'beige gateway logs -f' to follow`);
    process.exit(0);
  }

  // ── Foreground path (used directly or spawned by the daemon launcher) ──

  const { loadConfig } = await import("./config/loader.js");
  console.log(`[BEIGE] Loading config from: ${resolve(configPath)}`);
  const config = loadConfig(configPath);

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

function cmdGatewayStop(): void {
  const pid = readPid();
  if (pid === null) {
    console.log("[BEIGE] No PID file found — gateway may not be running");
    process.exit(0);
  }
  if (!isRunning(pid)) {
    console.log(`[BEIGE] Gateway (PID ${pid}) is not running`);
    process.exit(0);
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[BEIGE] Sent SIGTERM to gateway (PID ${pid})`);
  } catch (err) {
    console.error(`[BEIGE] Failed to stop gateway (PID ${pid}):`, err);
    process.exit(1);
  }
}

function cmdGatewayStatus(): void {
  const pid = readPid();
  if (pid === null || !isRunning(pid)) {
    console.log("[BEIGE] Gateway: stopped");
  } else {
    console.log(`[BEIGE] Gateway: running (PID ${pid})`);
    console.log(`[BEIGE] Logs:    ${LOG_FILE}`);
  }
}

function cmdGatewayLogs(follow: boolean): void {
  if (!existsSync(LOG_FILE)) {
    console.log(`[BEIGE] Log file not found: ${LOG_FILE}`);
    process.exit(1);
  }

  if (!follow) {
    // Dump the whole file and exit
    const content = readFileSync(LOG_FILE, "utf-8");
    process.stdout.write(content);
    return;
  }

  // Follow mode: stream existing content then watch for new bytes
  let position = 0;

  function flush() {
    try {
      const buf = readFileSync(LOG_FILE);
      if (buf.length > position) {
        process.stdout.write(buf.subarray(position));
        position = buf.length;
      }
    } catch {
      // file temporarily unavailable — ignore
    }
  }

  // Output everything already in the file
  flush();

  // Watch for writes and flush incrementally
  watch(LOG_FILE, () => flush());

  // Keep the process alive
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

// ── Parse args ───────────────────────────────────────────────────────

const defaultConfigPath = resolve(homedir(), ".beige", "config.json5");
let configPath = defaultConfigPath;
let gatewayUrl: string | undefined;

type Mode =
  | { kind: "gateway-start"; foreground: boolean }
  | { kind: "gateway-stop" }
  | { kind: "gateway-status" }
  | { kind: "gateway-logs"; follow: boolean }
  | { kind: "tui"; agentName?: string };

function printHelp() {
  console.log(`
Beige — Secure sandboxed agent system

Usage:
  beige gateway <command>                Manage the gateway daemon
  beige tui [agent]                      Connect TUI to running gateway

Options:
  -c, --config <path>        Config file (default: ~/.beige/config.json5)
  -g, --gateway <url>        Gateway URL for TUI (default: http://127.0.0.1:7433)
  -h, --help                 Show this help

Run 'beige gateway' for gateway-specific commands.
`);
}

function printGatewayHelp() {
  console.log(`
Beige — Gateway commands

Usage:
  beige gateway start                    Start the gateway daemon
  beige gateway start --foreground       Start the gateway in the foreground
  beige gateway stop                     Stop the gateway daemon
  beige gateway status                   Show gateway daemon status
  beige gateway logs                     Show gateway logs
  beige gateway logs -f                  Follow gateway logs

Options:
  -c, --config <path>        Config file (default: ~/.beige/config.json5)
  -h, --help                 Show this help
`);
}

function parseArgs(): Mode {
  const args = process.argv.slice(2);

  // Pull out global flags first
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" || args[i] === "-c") {
      configPath = args[i + 1];
      args.splice(i, 2);
      i--;
    } else if (args[i] === "--gateway" || args[i] === "-g") {
      gatewayUrl = args[i + 1];
      args.splice(i, 2);
      i--;
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  // No subcommand → show help
  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const [cmd, sub, ...rest] = args;

  if (cmd === "gateway") {
    if (!sub || sub === "--help" || sub === "-h") {
      printGatewayHelp();
      process.exit(0);
    }
    if (sub === "start") {
      const foreground = rest.includes("--foreground") || rest.includes("-F");
      return { kind: "gateway-start", foreground };
    }
    if (sub === "stop") return { kind: "gateway-stop" };
    if (sub === "status") return { kind: "gateway-status" };
    if (sub === "logs") {
      const follow = rest.includes("-f") || rest.includes("--follow");
      return { kind: "gateway-logs", follow };
    }
    console.error(`[BEIGE] Unknown gateway subcommand: ${sub}`);
    printGatewayHelp();
    process.exit(1);
  }

  if (cmd === "tui") {
    return { kind: "tui", agentName: sub };
  }

  console.error(`[BEIGE] Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

const mode = parseArgs();

// ── Dispatch ─────────────────────────────────────────────────────────

if (mode.kind === "gateway-start") {
  await cmdGatewayStart(configPath, mode.foreground);
} else if (mode.kind === "gateway-stop") {
  cmdGatewayStop();
} else if (mode.kind === "gateway-status") {
  cmdGatewayStatus();
} else if (mode.kind === "gateway-logs") {
  cmdGatewayLogs(mode.follow);
} else if (mode.kind === "tui") {
  // ── Mode: TUI ─────────────────────────────────────────────────────

  const { loadConfig } = await import("./config/loader.js");
  console.log(`[BEIGE] Loading config from: ${resolve(configPath)}`);
  const config = loadConfig(configPath);

  const agentNames = Object.keys(config.agents);
  if (agentNames.length === 0) {
    console.error("[BEIGE] No agents defined in config");
    process.exit(1);
  }

  let agentName = mode.agentName;
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
    `http://${config.gateway?.host ?? "127.0.0.1"}:${config.gateway?.port ?? 7433}`;

  const { launchTUI } = await import("./channels/tui.js");

  try {
    await launchTUI({ config, agentName, gatewayUrl: url });
  } catch (err) {
    console.error("[BEIGE] TUI error:", err);
    process.exit(1);
  }
}
