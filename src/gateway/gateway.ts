import { resolve } from "path";
import { homedir } from "os";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { BeigeConfig } from "../config/schema.js";
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

  constructor(config: BeigeConfig) {
    this.config = config;
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

    // 5. Start sandboxes and socket servers for each agent
    for (const agentName of Object.keys(this.config.agents)) {
      await this.startAgentInfra(agentName);
    }

    // 6. Start HTTP API (for TUI and other external channels)
    const host = this.config.server?.host ?? "127.0.0.1";
    const port = this.config.server?.port ?? 7433;

    this.api = new GatewayAPI({
      config: this.config,
      agentManager: this.agentManager,
      sessionStore: this.sessionStore,
      sandbox: this.sandboxManager,
      audit: this.audit,
      host,
      port,
    });
    await this.api.start();

    // 7. Start Telegram channel (non-blocking)
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

    if (this.telegramChannel) {
      await this.telegramChannel.stop();
    }

    await this.api?.stop();

    for (const [, server] of this.socketServers) {
      await server.stop();
    }

    await this.agentManager?.shutdown();
    await this.sandboxManager?.shutdown();

    console.log("[GATEWAY] Shutdown complete");
  }

  private async startAgentInfra(agentName: string): Promise<void> {
    await this.sandboxManager.createSandbox(agentName);

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
