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
 *   beige tools <command>              Manage tools (install, list, update, remove)
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
  unlinkSync,
} from "fs";
import { spawn } from "child_process";
import { watch } from "fs";

import { runSetup } from "./install.js";
import { beigeDir } from "./paths.js";
import {
  installTools,
  removeTool,
  updateTool,
  updateAllTools,
  listInstalledTools,
  readMetaFile,
} from "./tools/installer.js";

// ── Timestamp helpers ────────────────────────────────────────────────

/** Returns a local-time HH:MM:SS prefix, e.g. "14:03:07". */
function timestampPrefix(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Wraps process.stdout.write / process.stderr.write so that every line
 * written by the gateway process is prefixed with an HH:MM:SS timestamp.
 *
 * Call once at the very start of the foreground gateway path. When the
 * process is spawned as a daemon its stdout/stderr are already redirected
 * to gateway.log, so timestamps land directly in the file.
 */
function installTimestampInjector(): void {
  function wrapWrite(
    original: typeof process.stdout.write
  ): typeof process.stdout.write {
    let partial = ""; // incomplete line fragment waiting for a newline

    const wrapped = function (
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void
    ): boolean {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const lines = (partial + text).split("\n");
      // The last element may be an incomplete line (no trailing newline yet)
      partial = lines.pop() ?? "";

      let out = "";
      for (const line of lines) {
        out += `${timestampPrefix()} ${line}\n`;
      }

      if (out.length === 0) return true;

      if (typeof encodingOrCb === "function") {
        return (original as (c: string, cb: (err?: Error | null) => void) => boolean)(out, encodingOrCb);
      } else if (typeof cb === "function") {
        return (original as (c: string, e: BufferEncoding, cb: (err?: Error | null) => void) => boolean)(out, encodingOrCb as BufferEncoding, cb);
      }
      return (original as (c: string) => boolean)(out);
    };

    return wrapped as typeof process.stdout.write;
  }

  process.stdout.write = wrapWrite(process.stdout.write.bind(process.stdout));
  process.stderr.write = wrapWrite(process.stderr.write.bind(process.stderr));
}

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

/** Check if Docker is running and accessible. */
async function checkDockerAvailable(): Promise<void> {
  const Docker = (await import("dockerode")).default;
  const docker = new Docker();
  try {
    await docker.ping();
  } catch {
    throw new Error(
      "Docker is not running or not accessible.\n" +
      "  Please start Docker and try again."
    );
  }
}

/**
 * Wait for the gateway to become ready by:
 * 1. Streaming log file content to stdout
 * 2. Polling the health endpoint
 * 3. Watching for child process exit
 *
 * Returns true if gateway started successfully, false on error/timeout.
 */
async function waitForGatewayReady(
  childPid: number,
  logFile: string,
  port: number,
  host: string = "127.0.0.1",
  timeoutMs: number = 60000
): Promise<boolean> {
  const startTime = Date.now();
  const indefinite = timeoutMs === 0;
  const healthUrl = `http://${host}:${port}/api/health`;
  const pollIntervalMs = 500;

  let lastLogPosition = 0;
  let childExited = false;

  const flushLogs = () => {
    try {
      const buf = readFileSync(logFile);
      if (buf.length > lastLogPosition) {
        process.stdout.write(buf.subarray(lastLogPosition));
        lastLogPosition = buf.length;
      }
    } catch {
      // File not ready yet
    }
  };

  const checkHealth = async (): Promise<boolean> => {
    try {
      const res = await fetch(healthUrl, { method: "GET", signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };

  // Set up Ctrl+C handler to kill child on abort
  let aborted = false;
  const onSigint = () => {
    aborted = true;
    console.log("\n[BEIGE] Startup aborted, stopping gateway...");
    try {
      if (isRunning(childPid)) {
        process.kill(childPid, "SIGTERM");
      }
      const pidFile = getPidFile();
      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
      }
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  };
  process.on("SIGINT", onSigint);

  try {
    while (indefinite || Date.now() - startTime < timeoutMs) {
      // Check if child process exited
      if (!isRunning(childPid)) {
        childExited = true;
        break;
      }

      // Flush any new log content
      flushLogs();

      // Check if gateway is healthy
      if (await checkHealth()) {
        flushLogs(); // Final flush
        return true;
      }

      // Wait before next poll
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Final log flush
    flushLogs();

    if (childExited) {
      console.error("\n[BEIGE] Gateway process exited unexpectedly.");
      return false;
    }

    console.error(`\n[BEIGE] Gateway startup timed out after ${timeoutMs / 1000}s.`);
    console.error(`[BEIGE] Check logs for details: ${logFile}`);
    return false;
  } finally {
    process.off("SIGINT", onSigint);
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

async function cmdGatewayStart(configPath: string, foreground: boolean, timeoutMs: number): Promise<void> {
  if (!foreground) {
    const existingPid = readPid();
    if (existingPid !== null && isRunning(existingPid)) {
      console.log(`[BEIGE] Gateway is already running (PID ${existingPid})`);
      process.exit(0);
    }

    console.log("[BEIGE] Checking Docker...");
    try {
      await checkDockerAvailable();
    } catch (err) {
      console.error(`[BEIGE] ${(err as Error).message}`);
      process.exit(1);
    }

    const { loadConfig } = await import("./config/loader.js");
    const config = loadConfig(configPath);
    const port = config.gateway?.port ?? 7433;
    const host = config.gateway?.host ?? "127.0.0.1";

    ensureDirs();

    const logFile = getLogFile();
    const logFd = openSync(logFile, "a");

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

    if (!child.pid) {
      console.error("[BEIGE] Failed to spawn gateway process");
      process.exit(1);
    }

    writeFileSync(getPidFile(), String(child.pid), "utf-8");

    console.log("[BEIGE] Starting gateway...\n");
    const success = await waitForGatewayReady(child.pid, logFile, port, host, timeoutMs);

    if (success) {
      console.log(`\n[BEIGE] Gateway daemon started (PID ${child.pid})`);
      console.log(`[BEIGE] Logs: ${logFile}`);
      console.log(`[BEIGE] Run 'beige gateway logs -f' to follow`);
    } else {
      try {
        if (isRunning(child.pid)) {
          process.kill(child.pid, "SIGTERM");
        }
        unlinkSync(getPidFile());
      } catch {
        // Ignore cleanup errors
      }
      process.exit(1);
    }
    return;
  }

  // ── Foreground path (used directly or spawned by the daemon launcher) ──

  // Inject timestamps into every log line written by this process.
  // When spawned as a daemon the stdout/stderr are redirected to gateway.log,
  // so timestamps land directly in the file.
  installTimestampInjector();

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
  | { kind: "gateway-start"; foreground: boolean; timeoutMs: number }
  | { kind: "gateway-stop" }
  | { kind: "gateway-restart" }
  | { kind: "gateway-status" }
  | { kind: "gateway-logs"; follow: boolean }
  | { kind: "tui"; agentName?: string }
  | { kind: "setup"; force: boolean }
  | { kind: "install"; source: string; force: boolean }
  | { kind: "tools-list" }
  | { kind: "tools-remove"; name: string }
  | { kind: "tools-update"; name?: string };

function printHelp() {
  console.log(`
Beige — Secure sandboxed agent system

Usage:
  beige setup                            First-time setup (copies tools, writes default config)
  beige gateway <command>                Manage the gateway daemon
  beige tui [agent]                      Connect TUI to running gateway
  beige tools <command>                  Manage tools (install, list, update, remove)

Options:
  -c, --config <path>        Config file (default: ~/.beige/config.json5)
  -g, --gateway <url>        Gateway URL for TUI (default: http://127.0.0.1:7433)
  -v, --version              Show version
  -h, --help                 Show this help

Run 'beige gateway' for gateway-specific commands.
Run 'beige tools' for tool management commands.
`);
}

function printToolsHelp() {
  console.log(`
Beige — Tool commands

Usage:
  beige tools install <source>           Install tools from a source
  beige tools list                       List installed tools
  beige tools remove <name>              Remove an installed tool
  beige tools update [name]              Update a tool (or all tools)

Install sources:
  npm:@scope/package                     NPM package (latest)
  npm:@scope/package@1.2.3              NPM package (specific version)
  github:owner/repo                      GitHub repository (all tools)
  github:owner/repo/path/to/tool        Single tool from a GitHub subfolder
  github:owner/repo#tag                  GitHub repository at a tag/branch
  ./path/to/tool                         Local directory

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
  --timeout <seconds>        Startup wait timeout in seconds (default: 60, 0 = indefinite)
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
      let timeoutMs = 60000;
      const timeoutIdx = rest.findIndex((a) => a.startsWith("--timeout"));
      if (timeoutIdx !== -1) {
        const arg = rest[timeoutIdx];
        const raw = arg.includes("=") ? arg.split("=")[1] : rest[timeoutIdx + 1];
        const parsed = Number(raw);
        if (isNaN(parsed) || parsed < 0) {
          console.error(`[BEIGE] Invalid --timeout value: ${raw}. Must be a non-negative number (0 = indefinite).`);
          process.exit(1);
        }
        timeoutMs = parsed * 1000;
      }
      return { kind: "gateway-start", foreground, timeoutMs };
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

  if (cmd === "tools") {
    if (!sub || sub === "--help" || sub === "-h") {
      printToolsHelp();
      process.exit(0);
    }
    if (sub === "install") {
      const source = rest[0];
      if (!source || source === "--help" || source === "-h") {
        printToolsHelp();
        process.exit(source === "--help" || source === "-h" ? 0 : 1);
      }
      const force = rest.includes("--force") || rest.includes("-f");
      return { kind: "install", source, force };
    }
    if (sub === "list") {
      return { kind: "tools-list" };
    }
    if (sub === "remove") {
      const name = rest[0];
      if (!name) {
        console.error("[BEIGE] Missing tool name. Usage: beige tools remove <name>");
        process.exit(1);
      }
      return { kind: "tools-remove", name };
    }
    if (sub === "update") {
      const name = rest[0]; // optional — if omitted, update all
      return { kind: "tools-update", name };
    }
    console.error(`[BEIGE] Unknown tools subcommand: ${sub}`);
    printToolsHelp();
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
  await cmdGatewayStart(configPath, mode.foreground, mode.timeoutMs);
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
} else if (mode.kind === "tools-list") {
  cmdToolsList();
} else if (mode.kind === "tools-remove") {
  cmdToolsRemove(mode.name);
} else if (mode.kind === "tools-update") {
  await cmdToolsUpdate(mode.name);
}

async function cmdInstall(source: string, force: boolean): Promise<void> {
  console.log(`[BEIGE] Installing from: ${source}`);
  
  const result = await installTools(source, { force });
  
  if (!result.success) {
    if (result.conflicts && result.conflicts.length > 0) {
      console.error("[BEIGE] Tool name conflicts detected:");
      for (const conflict of result.conflicts) {
        console.error(`  - ${conflict}`);
      }
      console.error("\n[BEIGE] Use --force to override.");
    } else {
      console.error(`[BEIGE] Failed to install: ${result.error}`);
    }
    process.exit(1);
  }
  
  if (result.tools && result.tools.length > 0) {
    console.log(`[BEIGE] Installed ${result.tools.length} tool(s):`);
    for (const tool of result.tools) {
      console.log(`  - ${tool.name}: ${tool.manifest.description}`);
    }
    console.log(`\n[BEIGE] Add tools to your agent's 'tools' array to enable them.`);
  }
}

function cmdToolsList(): void {
  const tools = listInstalledTools();
  
  if (tools.length === 0) {
    console.log("[BEIGE] No tools installed.");
    console.log("\n[BEIGE] Install tools with: beige tools install <source>");
    return;
  }
  
  console.log("[BEIGE] Installed tools:\n");
  
  for (const tool of tools) {
    const meta = readMetaFile(tool.name);
    const source = meta?.source ?? "unknown";
    console.log(`  ${tool.name}`);
    console.log(`    ${tool.manifest.description}`);
    console.log(`    Source: ${source}`);
    if (meta?.package) {
      console.log(`    Package: ${meta.package}`);
    }
    console.log();
  }
}

function cmdToolsRemove(name: string): void {
  const result = removeTool(name);
  
  if (!result.success) {
    console.error(`[BEIGE] ${result.error}`);
    process.exit(1);
  }
  
  console.log(`[BEIGE] Removed tool: ${name}`);
}

async function cmdToolsUpdate(name?: string): Promise<void> {
  if (name) {
    console.log(`[BEIGE] Updating tool: ${name}`);
    const result = await updateTool(name);
    if (result.success) {
      console.log(`[BEIGE] Updated ${result.tools?.length ?? 0} tool(s) from same source.`);
    } else {
      console.error(`[BEIGE] Failed to update: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  // Update all
  const tools = listInstalledTools();
  if (tools.length === 0) {
    console.log("[BEIGE] No tools installed.");
    return;
  }
  
  console.log(`[BEIGE] Updating all installed tools...\n`);
  const result = await updateAllTools();
  
  console.log(`\n[BEIGE] Update complete: ${result.updated.length} updated, ${result.failed.length} failed.`);
  for (const f of result.failed) {
    console.error(`  Failed: ${f.source} — ${f.error}`);
  }
}
