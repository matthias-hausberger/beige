import { resolve } from "path";
import { beigeDir } from "../paths.js";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { BeigeConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { validateAgentToolReferences } from "../config/schema.js";
import { AuditLogger } from "./audit.js";
import { PolicyEngine } from "./policy.js";
import { AgentManager } from "./agent-manager.js";
import { BeigeSessionStore } from "./sessions.js";
import { SessionSettingsStore } from "./session-settings.js";
import { GatewayAPI } from "./api.js";
import { SandboxManager } from "../sandbox/manager.js";
import { AgentSocketServer } from "../socket/server.js";
import { ToolRunner } from "../tools/runner.js";
import { loadSkills, type LoadedSkill } from "../skills/registry.js";
import {
  PluginRegistry,
  loadPlugins,
  startPlugins,
  stopPlugins,
  createPluginContext,
  type AgentManagerRef,
  type LoadedPlugin,
} from "../plugins/index.js";
import { logUnhandledRejection } from "./error-logger.js";

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
  private loadedSkills!: Map<string, LoadedSkill>;
  private pluginRegistry!: PluginRegistry;
  private loadedPlugins: LoadedPlugin[] = [];
  private restarting = false;
  /**
   * Stable mutable reference to the AgentManager passed to plugins at
   * load time. Plugins close over this object and dereference `.current` at
   * call time, so it must be the *same object* across restarts — only
   * `.current` is updated, not the ref itself.
   */
  private readonly agentManagerRef: AgentManagerRef = { current: null };

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

    // 0. Set up global error handlers so no error ever disappears silently.
    //    unhandledRejection catches async errors that weren't .catch()-ed.
    //    uncaughtException catches synchronous throws that escape all try/catch.
    const rejectionHandler = (reason: unknown, promise: Promise<unknown>) => {
      logUnhandledRejection(reason, promise);
    };
    process.on("unhandledRejection", rejectionHandler);

    const exceptionHandler = (err: Error) => {
      console.error("[GATEWAY] Uncaught exception:", err.message, err.stack ?? "");
      logUnhandledRejection(err, Promise.resolve());
    };
    process.on("uncaughtException", exceptionHandler);

    // 1. Wire config into tool runner for per-agent plugin config resolution
    this.toolRunner.setConfig(this.config);

    // 2. Create plugin registry and wire it to the tool runner
    this.pluginRegistry = new PluginRegistry();
    this.toolRunner.setPluginRegistry(this.pluginRegistry);

    // 3. Create plugin context (agentManagerRef is resolved later)
    this.agentManagerRef.current = null;
    const pluginCtx = createPluginContext({
      config: this.config,
      agentManagerRef: this.agentManagerRef,
      sessionStore: this.sessionStore,
      settingsStore: this.settingsStore,
      registry: this.pluginRegistry,
    });

    // 4. Load plugins — this calls createPlugin() and register() for each
    this.loadedPlugins = await loadPlugins(this.config, this.pluginRegistry, pluginCtx);
    console.log(`[GATEWAY] Loaded ${this.loadedPlugins.length} plugin(s)`);

    // 5. Register plugin tools with the ToolRunner (for sandbox tool calls)
    for (const [toolName, pluginTool] of this.pluginRegistry.getAllTools()) {
      this.toolRunner.registerHandler(toolName, pluginTool.handler);
    }

    // 6. Validate that all agent tool references resolve to registered tools
    const registeredToolNames = new Set(this.pluginRegistry.getRegisteredToolNames());
    validateAgentToolReferences(this.config, registeredToolNames);

    // 7. Load standalone skill packages
    this.loadedSkills = await loadSkills(this.config);
    console.log(`[GATEWAY] Loaded ${this.loadedSkills.size} standalone skill(s)`);

    // 8. Merge plugin-registered skills into loadedSkills
    for (const [name, pluginSkill] of this.pluginRegistry.getAllSkills()) {
      if (!this.loadedSkills.has(name)) {
        this.loadedSkills.set(name, {
          name,
          path: pluginSkill.path,
          manifest: { name, description: pluginSkill.description },
        });
      }
    }

    // 9. Set up auth and model registry for pi SDK
    const authStorage = this.setupAuth();
    const beigeModelsPath = resolve(beigeDir(), "models.json");
    const modelRegistry = new ModelRegistry(authStorage, beigeModelsPath);

    // 10. Create sandbox manager
    this.sandboxManager = new SandboxManager(
      this.config,
      this.pluginRegistry,
      this.loadedSkills
    );

    // 11. Create agent manager and resolve the ref so plugins can use it
    this.agentManager = new AgentManager(
      this.config,
      this.sandboxManager,
      this.audit,
      this.pluginRegistry,
      this.loadedSkills,
      authStorage,
      modelRegistry,
      this.sessionStore
    );
    this.agentManagerRef.current = this.agentManager;

    // 12. Build beige-sandbox image if any agent needs it
    await this.sandboxManager.ensureSandboxImage();

    // 13. Start sandboxes and socket servers for each agent
    for (const agentName of Object.keys(this.config.agents)) {
      await this.startAgentInfra(agentName);
    }

    // 14. Start HTTP API
    const host = this.config.gateway?.host ?? "127.0.0.1";
    const port = this.config.gateway?.port ?? 7433;

    this.api = new GatewayAPI({
      config: this.config,
      gateway: this,
      agentManager: this.agentManager,
      sessionStore: this.sessionStore,
      sandbox: this.sandboxManager,
      audit: this.audit,
      pluginRegistry: this.pluginRegistry,
      loadedSkills: this.loadedSkills,
      host,
      port,
    });
    await this.api.start();

    // 15. Start all plugins (background processes)
    await startPlugins(this.loadedPlugins);

    // 16. Fire gatewayStarted hooks
    await this.pluginRegistry.executeGatewayStarted();

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

    // Fire gatewayShutdown hooks
    if (this.pluginRegistry) {
      await this.pluginRegistry.executeGatewayShutdown();
    }

    // Stop plugins (reverse order)
    if (this.loadedPlugins.length > 0) {
      await stopPlugins(this.loadedPlugins);
      this.loadedPlugins = [];
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
    const agentConfig = this.config.agents[agentName];
    const socketPath = resolve(beigeDir(), "sockets", `${agentName}.sock`);
    const agentDir = resolve(beigeDir(), "agents", agentName);
    const workspaceDir = agentConfig.workspaceDir
      ?? resolve(agentDir, "workspace");
    const socketServer = new AgentSocketServer(
      agentName,
      socketPath,
      this.audit,
      this.policy,
      this.toolRunner,
      agentDir,
      workspaceDir,
      this.agentManager
    );
    await socketServer.start();
    this.socketServers.set(agentName, socketServer);

    await this.sandboxManager.createSandbox(agentName);
  }

  private setupAuth(): AuthStorage {
    const beigeAuthPath = resolve(beigeDir(), "auth.json");
    const authStorage = AuthStorage.create(beigeAuthPath);
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
