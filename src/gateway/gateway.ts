import { resolve } from "path";
import { homedir } from "os";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { BeigeConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { AuditLogger } from "./audit.js";
import { PolicyEngine } from "./policy.js";
import { AgentManager } from "./agent-manager.js";
import { BeigeSessionStore } from "./sessions.js";
import { GatewayAPI } from "./api.js";
import { SandboxManager } from "../sandbox/manager.js";
import { AgentSocketServer } from "../socket/server.js";
import { ToolRunner } from "../tools/runner.js";
import { loadTools, type LoadedTool } from "../tools/registry.js";
import { TelegramChannel } from "../channels/telegram.js";

/**
 * Main gateway. Wires everything together and exposes an HTTP API
 * that channels (TUI, future CLI, web UI, etc.) connect to.
 *
 * Usage:
 *   Shell 1: `beige`          → starts gateway (API + Telegram)
 *   Shell 2: `beige tui`      → TUI channel connects to gateway API
 */
export class Gateway {
  private config: BeigeConfig;
  /** Absolute path to the config file so restart() can reload it. */
  private configPath: string;
  private audit: AuditLogger;
  private policy: PolicyEngine;
  private toolRunner: ToolRunner;
  private sessionStore: BeigeSessionStore;
  private sandboxManager!: SandboxManager;
  private agentManager!: AgentManager;
  private api!: GatewayAPI;
  private socketServers = new Map<string, AgentSocketServer>();
  private telegramChannel?: TelegramChannel;
  private loadedTools!: Map<string, LoadedTool>;
  /** True while a restart is in progress — prevents overlapping restarts. */
  private restarting = false;

  constructor(config: BeigeConfig, configPath: string) {
    this.config = config;
    this.configPath = resolve(configPath);
    this.audit = new AuditLogger(
      resolve(homedir(), ".beige", "logs", "audit.jsonl")
    );
    this.policy = new PolicyEngine(config);
    this.toolRunner = new ToolRunner();
    this.sessionStore = new BeigeSessionStore();
  }

  async start(): Promise<void> {
    console.log("[GATEWAY] Starting Beige gateway...");

    // 1. Load tool packages and register handlers
    this.loadedTools = await loadTools(this.config, this.toolRunner);
    console.log(`[GATEWAY] Loaded ${this.loadedTools.size} tool(s)`);

    // 2. Set up auth and model registry for pi SDK
    const authStorage = this.setupAuth();
    const modelRegistry = new ModelRegistry(authStorage);

    // 3. Create sandbox manager
    this.sandboxManager = new SandboxManager(this.config, this.loadedTools);

    // 4. Create agent manager
    this.agentManager = new AgentManager(
      this.config,
      this.sandboxManager,
      this.audit,
      this.loadedTools,
      authStorage,
      modelRegistry,
      this.sessionStore
    );

    // 5. Build beige-sandbox image if any agent needs it (no-op otherwise)
    await this.sandboxManager.ensureSandboxImage();

    // 6. Start sandboxes and socket servers for each agent
    for (const agentName of Object.keys(this.config.agents)) {
      await this.startAgentInfra(agentName);
    }

    // 7. Start HTTP API (for TUI and other external channels)
    const host = this.config.gateway?.host ?? "127.0.0.1";
    const port = this.config.gateway?.port ?? 7433;

    this.api = new GatewayAPI({
      config: this.config,
      gateway: this,
      agentManager: this.agentManager,
      sessionStore: this.sessionStore,
      sandbox: this.sandboxManager,
      audit: this.audit,
      host,
      port,
    });
    await this.api.start();

    // 8. Start Telegram channel (non-blocking)
    if (this.config.channels?.telegram?.enabled) {
      this.telegramChannel = new TelegramChannel(
        this.config.channels.telegram,
        this.agentManager,
        this.sessionStore
      );
      this.telegramChannel.start().catch((err) => {
        console.error("[GATEWAY] Telegram bot error:", err);
      });
    }

    console.log("[GATEWAY] Beige gateway started ✓");
  }

  async stop(): Promise<void> {
    console.log("[GATEWAY] Shutting down...");
    await this.teardown({ drain: true });
    console.log("[GATEWAY] Shutdown complete");
  }

  /**
   * Gracefully restart the gateway in-place:
   *   1. Drain all in-flight LLM / tool calls (no hard kill).
   *   2. Tear down sandboxes, sockets, HTTP API, and Telegram.
   *   3. Re-read config from disk (picks up any edits).
   *   4. Bring everything back up fresh.
   *
   * If a restart is already in progress the call is a no-op.
   */
  async restart(): Promise<void> {
    if (this.restarting) {
      console.log("[GATEWAY] Restart already in progress — ignoring duplicate request");
      return;
    }
    this.restarting = true;

    try {
      console.log("[GATEWAY] ── Restart requested ──────────────────────────────");

      // ── Phase 1: Drain ────────────────────────────────────────────
      console.log("[GATEWAY] Phase 1/3: Draining in-flight calls...");
      await this.agentManager?.drainAll();

      // ── Phase 2: Tear down ────────────────────────────────────────
      console.log("[GATEWAY] Phase 2/3: Tearing down infrastructure...");
      await this.teardown({ drain: false }); // already drained

      // ── Phase 3: Reload config & start fresh ──────────────────────
      console.log(`[GATEWAY] Phase 3/3: Reloading config from ${this.configPath}...`);
      try {
        this.config = loadConfig(this.configPath);
      } catch (err) {
        console.error("[GATEWAY] Failed to reload config — aborting restart:", err);
        console.error("[GATEWAY] Gateway is now stopped. Fix the config and run 'beige gateway start'.");
        return;
      }

      // Re-create stateless helpers that depend on config
      this.policy = new PolicyEngine(this.config);
      this.toolRunner = new ToolRunner();
      // NOTE: AuditLogger and BeigeSessionStore are config-independent — reuse them.

      await this.start();
      console.log("[GATEWAY] ── Restart complete ───────────────────────────────");
    } finally {
      this.restarting = false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Tear down all live infrastructure.
   * @param drain  If true, call drainAll() first to wait for in-flight calls.
   */
  private async teardown(opts: { drain: boolean }): Promise<void> {
    if (opts.drain) {
      await this.agentManager?.drainAll();
    }

    // Stop Telegram first — no more inbound messages
    if (this.telegramChannel) {
      await this.telegramChannel.stop();
      this.telegramChannel = undefined;
    }

    // Stop HTTP API — reject new tool-exec / prompt requests from TUI
    await this.api?.stop();

    // Stop all Unix socket servers
    for (const [, server] of this.socketServers) {
      await server.stop();
    }
    this.socketServers.clear();

    // Dispose remaining sessions (already empty after drainAll, but safe)
    await this.agentManager?.shutdown();

    // Stop + remove all sandbox containers
    await this.sandboxManager?.shutdown();
  }

  private async startAgentInfra(agentName: string): Promise<void> {
    // Start socket server FIRST so the socket file exists before Docker mounts it
    const socketPath = resolve(
      homedir(),
      ".beige",
      "sockets",
      `${agentName}.sock`
    );
    const socketServer = new AgentSocketServer(
      agentName,
      socketPath,
      this.audit,
      this.policy,
      this.toolRunner
    );
    await socketServer.start();
    this.socketServers.set(agentName, socketServer);

    // Then create sandbox (which bind-mounts the now-existing socket file)
    await this.sandboxManager.createSandbox(agentName);
  }

  private setupAuth(): AuthStorage {
    const authStorage = AuthStorage.create();
    for (const [providerName, providerConfig] of Object.entries(
      this.config.llm.providers
    )) {
      if (providerConfig.apiKey) {
        authStorage.setRuntimeApiKey(providerName, providerConfig.apiKey);
      }
    }
    return authStorage;
  }
}
