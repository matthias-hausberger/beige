import { resolve } from "path";
import { homedir } from "os";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { BeigeConfig } from "../config/schema.js";
import { AuditLogger } from "./audit.js";
import { PolicyEngine } from "./policy.js";
import { AgentManager } from "./agent-manager.js";
import { SandboxManager } from "../sandbox/manager.js";
import { AgentSocketServer } from "../socket/server.js";
import { ToolRunner } from "../tools/runner.js";
import { loadTools, type LoadedTool } from "../tools/registry.js";
import { TelegramChannel } from "../channels/telegram.js";

/**
 * Main gateway. Wires everything together.
 */
export class Gateway {
  private config: BeigeConfig;
  private audit: AuditLogger;
  private policy: PolicyEngine;
  private toolRunner: ToolRunner;
  private sandboxManager!: SandboxManager;
  private agentManager!: AgentManager;
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
      modelRegistry
    );

    // 5. Start sandboxes and socket servers for each agent
    for (const agentName of Object.keys(this.config.agents)) {
      await this.startAgentInfra(agentName);
    }

    // 6. Start channel adapters
    if (this.config.channels?.telegram?.enabled) {
      this.telegramChannel = new TelegramChannel(
        this.config.channels.telegram,
        this.agentManager
      );
      // Don't await — bot.start() blocks
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

    for (const [, server] of this.socketServers) {
      await server.stop();
    }

    await this.agentManager?.shutdown();
    await this.sandboxManager?.shutdown();

    console.log("[GATEWAY] Shutdown complete");
  }

  private async startAgentInfra(agentName: string): Promise<void> {
    // Create sandbox container
    await this.sandboxManager.createSandbox(agentName);

    // Start socket server for tool routing
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

  /**
   * Set up API key auth from config providers.
   * Keys are injected as runtime API keys so they never touch env vars.
   */
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
