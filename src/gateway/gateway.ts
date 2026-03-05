import { resolve } from "path";
import { homedir } from "os";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { BeigeConfig } from "../config/schema.js";
import { AuditLogger } from "./audit.js";
import { PolicyEngine } from "./policy.js";
import { AgentManager } from "./agent-manager.js";
import { BeigeSessionStore } from "./sessions.js";
import { SandboxManager } from "../sandbox/manager.js";
import { AgentSocketServer } from "../socket/server.js";
import { ToolRunner } from "../tools/runner.js";
import { loadTools, type LoadedTool } from "../tools/registry.js";
import { TelegramChannel } from "../channels/telegram.js";
import { TUIChannel } from "../channels/tui.js";

/**
 * Main gateway. Wires everything together.
 *
 * The gateway is always the single orchestrator. Channels (Telegram, TUI, etc.)
 * are interfaces that plug into the gateway to talk to agents.
 */
export class Gateway {
  private config: BeigeConfig;
  private audit: AuditLogger;
  private policy: PolicyEngine;
  private toolRunner: ToolRunner;
  private sessionStore: BeigeSessionStore;
  private sandboxManager!: SandboxManager;
  private agentManager!: AgentManager;
  private socketServers = new Map<string, AgentSocketServer>();
  private telegramChannel?: TelegramChannel;
  private tuiChannel?: TUIChannel;
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

  /**
   * Start the gateway.
   *
   * @param opts.tui  If set, also launch a TUI channel for the given agent
   * @param opts.tuiResumeFile  Resume a specific session file in TUI
   */
  async start(opts?: {
    tui?: string;
    tuiResumeFile?: string;
  }): Promise<void> {
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

    // 6. Start channel adapters

    // Telegram (non-blocking — runs in background)
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

    // TUI (blocking — takes over the terminal)
    // Launched LAST because InteractiveMode blocks until exit.
    // Other channels (Telegram) continue running in the background.
    if (opts?.tui) {
      const agentName = opts.tui;
      if (!this.config.agents[agentName]) {
        throw new Error(
          `Unknown agent '${agentName}'. Available: ${Object.keys(this.config.agents).join(", ")}`
        );
      }

      this.tuiChannel = new TUIChannel(
        this.config,
        this.agentManager,
        this.sessionStore
      );
      await this.tuiChannel.run(agentName, opts.tuiResumeFile);

      // TUI exited — shut down the gateway
      await this.stop();
    }
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
