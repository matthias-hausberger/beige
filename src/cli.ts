#!/usr/bin/env node

/**
 * Beige CLI
 *
 * Usage:
 *   beige                              Show help
 *   beige gateway start                Start the gateway as a background daemon
 *   beige gateway start --foreground   Start the gateway in the foreground (for debugging)
 *   beige gateway stop                 Stop the running gateway daemon
 *   beige gateway restart              Gracefully restart the gateway (drain, reload config, recreate sandboxes)
 *   beige gateway status               Show whether the gateway daemon is running
 *   beige gateway logs                 Show gateway logs
 *   beige gateway logs -f              Follow gateway logs (tail -f)
 *   beige tui [agent]                  Connect to a running gateway via TUI
 *   beige install <source>             Install a toolkit (npm, github, local, url)
 *   beige toolkit <command>            Manage toolkits
 *   beige --config <path>              Use a specific config file
 *
 *   Shell 1:  beige                    ← starts gateway daemon
 *   Shell 2:  beige tui testo          ← interactive TUI, proxies tools to gateway
 */

import { resolve } from "path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
} from "fs";
import { spawn } from "child_process";
import { watch } from "fs";
import { runSetup } from "./install.js";
import { beigeDir } from "./paths.js";
import {
  installToolkit,
  removeToolkit,
  listInstalledToolkits,
  getInstalledToolkit,
  sourceToString,
} from "./toolkit/index.js";

// ── Paths ────────────────────────────────────────────────────────────

// beigeDir() is called lazily (inside functions) so that BEIGE_HOME is
// already resolved by the time the value is needed.
function getPidFile(): string { return resolve(beigeDir(), "gateway.pid"); }
function getLogFile(): string { return resolve(beigeDir(), "logs", "gateway.log"); }

// ── Helpers ──────────────────────────────────────────────────────────

function ensureDirs() {
  mkdirSync(resolve(beigeDir(), "logs"), { recursive: true });
}

/** Read the stored PID, or null if the file doesn't exist. */
function readPid(): number | null {
  const pidFile = getPidFile();
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf-8").trim();
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

async function cmdSetup(_force: boolean): Promise<void> {
  console.log("[BEIGE] Running setup…");
  const result = await runSetup();

  if (result.created.length > 0) {
    console.log("\n[BEIGE] Created:");
    for (const p of result.created) console.log(`  + ${p}`);
  }
  if (result.skipped.length > 0) {
    console.log("\n[BEIGE] Already exists (skipped):");
    for (const p of result.skipped) console.log(`  ~ ${p}`);
  }
  if (result.created.length === 0 && result.skipped.length === 0) {
    console.log("[BEIGE] Nothing to do.");
  }
  console.log("\n[BEIGE] Setup complete.");
}

/**
 * Auto-setup on first run: if no config exists yet, silently bootstrap
 * the beige home directory (respects BEIGE_HOME).
 */
async function maybeAutoSetup(): Promise<void> {
  const configPath = resolve(beigeDir(), "config.json5");
  if (existsSync(configPath)) return;

  console.log(`[BEIGE] First run — setting up ${beigeDir()}…`);
  const result = await runSetup();
  if (result.created.length > 0) {
    console.log("[BEIGE] Created:");
    for (const p of result.created) console.log(`  + ${p}`);
    console.log();
  }
}

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
    const logFile = getLogFile();
    const logFd = openSync(logFile, "a");

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

    writeFileSync(getPidFile(), String(child.pid), "utf-8");
    console.log(`[BEIGE] Gateway daemon started (PID ${child.pid})`);
    console.log(`[BEIGE] Logs: ${logFile}`);
    console.log(`[BEIGE] Run 'beige gateway logs -f' to follow`);
    process.exit(0);
  }

  // ── Foreground path (used directly or spawned by the daemon launcher) ──

  const { loadConfig } = await import("./config/loader.js");
  console.log(`[BEIGE] Loading config from: ${resolve(configPath)}`);
  const config = loadConfig(configPath);

  const { Gateway } = await import("./gateway/gateway.js");
  const gateway = new Gateway(config, configPath);

  const shutdown = async () => {
    console.log("\n[BEIGE] Shutting down...");
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // SIGHUP → graceful in-place restart (reload config, recreate sandboxes)
  process.on("SIGHUP", () => {
    console.log("[BEIGE] Received SIGHUP — restarting gateway...");
    gateway.restart().catch((err) => {
      console.error("[BEIGE] Restart failed:", err);
    });
  });

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

function cmdGatewayRestart(): void {
  const pid = readPid();
  if (pid === null) {
    console.log("[BEIGE] No PID file found — gateway is not running");
    console.log("[BEIGE] Run 'beige gateway start' to start it");
    process.exit(1);
  }
  if (!isRunning(pid)) {
    console.log(`[BEIGE] Gateway (PID ${pid}) is not running`);
    console.log("[BEIGE] Run 'beige gateway start' to start it");
    process.exit(1);
  }
  try {
    process.kill(pid, "SIGHUP");
    console.log(`[BEIGE] Sent SIGHUP to gateway (PID ${pid}) — graceful restart initiated`);
    console.log(`[BEIGE] Follow progress with: beige gateway logs -f`);
  } catch (err) {
    console.error(`[BEIGE] Failed to signal gateway (PID ${pid}):`, err);
    process.exit(1);
  }
}

function cmdGatewayStatus(): void {
  const pid = readPid();
  if (pid === null || !isRunning(pid)) {
    console.log("[BEIGE] Gateway: stopped");
  } else {
    console.log(`[BEIGE] Gateway: running (PID ${pid})`);
    console.log(`[BEIGE] Logs:    ${getLogFile()}`);
  }
}

function cmdGatewayLogs(follow: boolean): void {
  const logFile = getLogFile();
  if (!existsSync(logFile)) {
    console.log(`[BEIGE] Log file not found: ${logFile}`);
    process.exit(1);
  }

  if (!follow) {
    // Dump the whole file and exit
    const content = readFileSync(logFile, "utf-8");
    process.stdout.write(content);
    return;
  }

  // Follow mode: stream existing content then watch for new bytes
  let position = 0;

  function flush() {
    try {
      const buf = readFileSync(logFile);
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
  watch(logFile, () => flush());

  // Keep the process alive
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

// ── Parse args ───────────────────────────────────────────────────────

const defaultConfigPath = resolve(beigeDir(), "config.json5");
let configPath = defaultConfigPath;
let gatewayUrl: string | undefined;

type Mode =
  | { kind: "gateway-start"; foreground: boolean }
  | { kind: "gateway-stop" }
  | { kind: "gateway-restart" }
  | { kind: "gateway-status" }
  | { kind: "gateway-logs"; follow: boolean }
  | { kind: "tui"; agentName?: string }
  | { kind: "setup"; force: boolean }
  | { kind: "install"; source: string; force: boolean }
  | { kind: "toolkit-list" }
  | { kind: "toolkit-show"; name: string }
  | { kind: "toolkit-remove"; name: string }
  | { kind: "toolkit-update" };

function printHelp() {
  console.log(`
Beige — Secure sandboxed agent system

Usage:
  beige setup                            First-time setup (copies tools, writes default config)
  beige gateway <command>                Manage the gateway daemon
  beige tui [agent]                      Connect TUI to running gateway
  beige install <source>                 Install a toolkit (npm, github, local, url)
  beige toolkit <command>                Manage toolkits

Options:
  -c, --config <path>        Config file (default: ~/.beige/config.json5)
  -g, --gateway <url>        Gateway URL for TUI (default: http://127.0.0.1:7433)
  -v, --version              Show version
  -h, --help                 Show this help

Run 'beige gateway' for gateway-specific commands.
Run 'beige toolkit' for toolkit-specific commands.
`);
}

function printToolkitHelp() {
  console.log(`
Beige — Toolkit commands

Usage:
  beige install <source>                 Install a toolkit
  beige toolkit list                     List installed toolkits
  beige toolkit show <name>              Show toolkit details
  beige toolkit remove <name>            Remove a toolkit
  beige toolkit update                   Update all installed toolkits

Install sources:
  npm:@scope/toolkit-name                NPM package
  github:owner/repo                      GitHub repository
  github:owner/repo#tag                  GitHub repository with tag/branch
  ./path/to/toolkit                      Local directory
  https://.../toolkit.tar.gz             URL to tarball

Options:
  --force, -f                Force install even with conflicts
  -h, --help                 Show this help
`);
}

function printGatewayHelp() {
  console.log(`
Beige — Gateway commands

Usage:
  beige gateway start                    Start the gateway daemon
  beige gateway start --foreground       Start the gateway in the foreground
  beige gateway stop                     Stop the gateway daemon
  beige gateway restart                  Gracefully restart the gateway (drain, reload config, recreate sandboxes)
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
    } else if (args[i] === "--version" || args[i] === "-v") {
      const pkgPath = new URL("../package.json", import.meta.url);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      console.log(pkg.version);
      process.exit(0);
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
    if (sub === "restart") return { kind: "gateway-restart" };
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

  if (cmd === "setup") {
    const force = args.includes("--force") || args.includes("-f");
    return { kind: "setup", force };
  }

  if (cmd === "install") {
    if (!sub || sub === "--help" || sub === "-h") {
      printToolkitHelp();
      process.exit(sub === "--help" || sub === "-h" ? 0 : 1);
    }
    const force = rest.includes("--force") || rest.includes("-f");
    return { kind: "install", source: sub, force };
  }

  if (cmd === "toolkit") {
    if (!sub || sub === "--help" || sub === "-h") {
      printToolkitHelp();
      process.exit(0);
    }
    if (sub === "list") {
      return { kind: "toolkit-list" };
    }
    if (sub === "show") {
      const name = rest[0];
      if (!name) {
        console.error("[BEIGE] Missing toolkit name. Usage: beige toolkit show <name>");
        process.exit(1);
      }
      return { kind: "toolkit-show", name };
    }
    if (sub === "remove") {
      const name = rest[0];
      if (!name) {
        console.error("[BEIGE] Missing toolkit name. Usage: beige toolkit remove <name>");
        process.exit(1);
      }
      return { kind: "toolkit-remove", name };
    }
    if (sub === "update") {
      return { kind: "toolkit-update" };
    }
    console.error(`[BEIGE] Unknown toolkit subcommand: ${sub}`);
    printToolkitHelp();
    process.exit(1);
  }

  console.error(`[BEIGE] Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

const mode = parseArgs();

// ── Auto-setup on first npm-global run ────────────────────────────────
// Skipped for `beige setup` itself (it handles output its own way) and for
// source installs.  For every other command, silently bootstrap ~/.beige if
// no config exists yet.
if (mode.kind !== "setup") {
  await maybeAutoSetup();
}

// ── Dispatch ─────────────────────────────────────────────────────────

if (mode.kind === "setup") {
  await cmdSetup(mode.force);
} else if (mode.kind === "gateway-start") {
  await cmdGatewayStart(configPath, mode.foreground);
} else if (mode.kind === "gateway-stop") {
  cmdGatewayStop();
} else if (mode.kind === "gateway-restart") {
  cmdGatewayRestart();
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
} else if (mode.kind === "install") {
  await cmdInstall(mode.source, mode.force);
} else if (mode.kind === "toolkit-list") {
  cmdToolkitList();
} else if (mode.kind === "toolkit-show") {
  cmdToolkitShow(mode.name);
} else if (mode.kind === "toolkit-remove") {
  cmdToolkitRemove(mode.name);
} else if (mode.kind === "toolkit-update") {
  await cmdToolkitUpdate();
}

async function cmdInstall(source: string, force: boolean): Promise<void> {
  console.log(`[BEIGE] Installing toolkit from: ${source}`);
  
  const result = await installToolkit(source, { force });
  
  if (!result.success) {
    if (result.conflicts && result.conflicts.length > 0) {
      console.error("[BEIGE] Tool name conflicts detected:");
      for (const conflict of result.conflicts) {
        console.error(`  - ${conflict}`);
      }
      console.error("\n[BEIGE] Use --force to override.");
    } else {
      console.error(`[BEIGE] Failed to install toolkit: ${result.error}`);
    }
    process.exit(1);
  }
  
  if (result.toolkit) {
    const action = result.updated ? "Updated" : "Installed";
    console.log(`[BEIGE] ${action} toolkit: ${result.toolkit.manifest.name} v${result.toolkit.manifest.version}`);
    console.log(`[BEIGE] Tools available:`);
    for (const tool of result.toolkit.tools) {
      console.log(`  - ${tool.name}: ${tool.manifest.description}`);
    }
    console.log(`\n[BEIGE] Add tools to your agent's config to enable them.`);
  }
}

function cmdToolkitList(): void {
  const toolkits = listInstalledToolkits();
  
  if (toolkits.length === 0) {
    console.log("[BEIGE] No toolkits installed.");
    console.log("\n[BEIGE] Install a toolkit with: beige install <source>");
    return;
  }
  
  console.log("[BEIGE] Installed toolkits:\n");
  
  for (const toolkit of toolkits) {
    const source = sourceToString(toolkit.source);
    console.log(`  ${toolkit.name} v${toolkit.version}`);
    console.log(`    Source: ${source}`);
    console.log(`    Tools: ${toolkit.tools.join(", ")}`);
    console.log(`    Installed: ${new Date(toolkit.installedAt).toLocaleDateString()}`);
    console.log();
  }
}

function cmdToolkitShow(name: string): void {
  const toolkit = getInstalledToolkit(name);
  
  if (!toolkit) {
    console.error(`[BEIGE] Toolkit '${name}' not found.`);
    console.error("[BEIGE] Run 'beige toolkit list' to see installed toolkits.");
    process.exit(1);
  }
  
  const source = sourceToString(toolkit.source);
  
  console.log(`Toolkit: ${toolkit.name}`);
  console.log(`Version: ${toolkit.version}`);
  console.log(`Source:  ${source}`);
  console.log(`Path:    ${toolkit.path}`);
  console.log(`Installed: ${new Date(toolkit.installedAt).toLocaleString()}`);
  console.log(`\nTools:`);
  for (const toolName of toolkit.tools) {
    console.log(`  - ${toolName}`);
  }
}

function cmdToolkitRemove(name: string): void {
  const result = removeToolkit(name);
  
  if (!result.success) {
    console.error(`[BEIGE] ${result.error}`);
    process.exit(1);
  }
  
  console.log(`[BEIGE] Removed toolkit: ${name}`);
}

async function cmdToolkitUpdate(): Promise<void> {
  const toolkits = listInstalledToolkits();
  
  if (toolkits.length === 0) {
    console.log("[BEIGE] No toolkits installed.");
    return;
  }
  
  console.log(`[BEIGE] Updating ${toolkits.length} toolkit(s)...\n`);
  
  let updated = 0;
  let failed = 0;
  
  for (const toolkit of toolkits) {
    const source = sourceToString(toolkit.source);
    console.log(`[BEIGE] Updating ${toolkit.name} from ${source}...`);
    
    const result = await installToolkit(source, { force: true });
    
    if (result.success) {
      console.log(`[BEIGE]   Updated to v${result.toolkit?.manifest.version}`);
      updated++;
    } else {
      console.error(`[BEIGE]   Failed: ${result.error}`);
      failed++;
    }
  }
  
  console.log(`\n[BEIGE] Update complete: ${updated} updated, ${failed} failed.`);
}
