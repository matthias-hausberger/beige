import { resolve } from "path";
import { beigeDir } from "../paths.js";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { BeigeConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { AuditLogger } from "./audit.js";
import { PolicyEngine } from "./policy.js";
import { AgentManager } from "./agent-manager.js";
import { BeigeSessionStore } from "./sessions.js";
import { SessionSettingsStore } from "./session-settings.js";
import { GatewayAPI } from "./api.js";
import { SandboxManager } from "../sandbox/manager.js";
import { AgentSocketServer } from "../socket/server.js";
import { ToolRunner } from "../tools/runner.js";
import { loadTools, type LoadedTool } from "../tools/registry.js";
import { loadSkills, type LoadedSkill } from "../skills/registry.js";
import { TelegramChannel } from "../channels/telegram.js";
import { ChannelRegistry } from "../channels/registry.js";

export class Gateway {
  private config: BeigeConfig;
  private configPath: string;
  private audit: AuditLogger;
  private policy: PolicyEngine;
  private toolRunner: ToolRunner;
  private sessionStore: BeigeSessionStore;
  private settingsStore: SessionSettingsStore;
  private sandboxManager!: SandboxManager;
  private agentManager!: AgentManager;
  private api!: GatewayAPI;
  private socketServers = new Map<string, AgentSocketServer>();
  private telegramChannel?: TelegramChannel;
  private loadedTools!: Map<string, LoadedTool>;
  private loadedSkills!: Map<string, LoadedSkill>;
  private channelRegistry!: ChannelRegistry;
  private restarting = false;

  constructor(config: BeigeConfig, configPath: string) {
    this.config = config;
    this.configPath = resolve(configPath);
    this.audit = new AuditLogger(
      resolve(beigeDir(), "logs", "audit.jsonl")
    );
    this.policy = new PolicyEngine(config);
    this.toolRunner = new ToolRunner();
    this.sessionStore = new BeigeSessionStore();
    this.settingsStore = new SessionSettingsStore();
  }

  async start(): Promise<void> {
    console.log("[GATEWAY] Starting Beige gateway...");

    // 1. Create channel registry
    this.channelRegistry = new ChannelRegistry();

    // 2. Load tool packages and register handlers
    this.loadedTools = await loadTools(this.config, this.toolRunner, this.channelRegistry);
    console.log(`[GATEWAY] Loaded ${this.loadedTools.size} tool(s)`);

    // 3. Load skill packages
    this.loadedSkills = await loadSkills(this.config);
    console.log(`[GATEWAY] Loaded ${this.loadedSkills.size} skill(s)`);

    // 4. Set up auth and model registry for pi SDK
    const authStorage = this.setupAuth();
    const modelRegistry = new ModelRegistry(authStorage);

    // 5. Create sandbox manager
    this.sandboxManager = new SandboxManager(this.config, this.loadedTools, this.loadedSkills);

    // 6. Create agent manager
    this.agentManager = new AgentManager(
      this.config,
      this.sandboxManager,
      this.audit,
      this.loadedTools,
      this.loadedSkills,
      authStorage,
      modelRegistry,
      this.sessionStore
    );

    // 7. Build beige-sandbox image if any agent needs it (no-op otherwise)
    await this.sandboxManager.ensureSandboxImage();

    // 8. Start sandboxes and socket servers for each agent
    for (const agentName of Object.keys(this.config.agents)) {
      await this.startAgentInfra(agentName);
    }

    // 9. Start HTTP API (for TUI and other external channels)
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

    // 10. Start Telegram channel (non-blocking)
    if (this.config.channels?.telegram?.enabled) {
      this.telegramChannel = new TelegramChannel(
        this.config.channels.telegram,
        this.agentManager,
        this.sessionStore,
        this.settingsStore,
        this.channelRegistry
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

  async restart(): Promise<void> {
    if (this.restarting) {
      console.log("[GATEWAY] Restart already in progress — ignoring duplicate request");
      return;
    }
    this.restarting = true;

    try {
      console.log("[GATEWAY] ── Restart requested ──────────────────────────────");

      console.log("[GATEWAY] Phase 1/3: Draining in-flight calls...");
      await this.agentManager?.drainAll();

      console.log("[GATEWAY] Phase 2/3: Tearing down infrastructure...");
      await this.teardown({ drain: false });

      console.log(`[GATEWAY] Phase 3/3: Reloading config from ${this.configPath}...`);
      try {
        this.config = loadConfig(this.configPath);
      } catch (err) {
        console.error("[GATEWAY] Failed to reload config — aborting restart:", err);
        console.error("[GATEWAY] Gateway is now stopped. Fix the config and run 'beige gateway start'.");
        return;
      }

      this.policy = new PolicyEngine(this.config);
      this.toolRunner = new ToolRunner();

      await this.start();
      console.log("[GATEWAY] ── Restart complete ───────────────────────────────");
    } finally {
      this.restarting = false;
    }
  }

  private async teardown(opts: { drain: boolean }): Promise<void> {
    if (opts.drain) {
      await this.agentManager?.drainAll();
    }

    if (this.telegramChannel) {
      await this.telegramChannel.stop();
      this.telegramChannel = undefined;
    }

    await this.api?.stop();

    for (const [, server] of this.socketServers) {
      await server.stop();
    }
    this.socketServers.clear();

    await this.agentManager?.shutdown();

    await this.sandboxManager?.shutdown();
  }

  private async startAgentInfra(agentName: string): Promise<void> {
    const socketPath = resolve(beigeDir(), "sockets", `${agentName}.sock`);
    const socketServer = new AgentSocketServer(
      agentName,
      socketPath,
      this.audit,
      this.policy,
      this.toolRunner
    );
    await socketServer.start();
    this.socketServers.set(agentName, socketServer);

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
