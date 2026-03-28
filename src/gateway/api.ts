import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { BeigeConfig } from "../config/schema.js";
import { type AgentManager } from "./agent-manager.js";
import { buildPluginToolContext } from "./agent-manager.js";
import type { BeigeSessionStore } from "./sessions.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { AuditLogger } from "./audit.js";
import type { Gateway } from "./gateway.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { buildSkillContext, type LoadedSkill } from "../skills/registry.js";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Context, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { extractRateLimitInfo } from "./provider-health.js";
import { parseSessionKey } from "../types/session.js";
import { imageExtension, buildVisionUnsupportedError } from "../tools/image.js";

export interface GatewayAPIOptions {
  config: BeigeConfig;
  gateway: Gateway;
  agentManager: AgentManager;
  sessionStore: BeigeSessionStore;
  sandbox: SandboxManager;
  audit: AuditLogger;
  pluginRegistry: PluginRegistry;
  loadedSkills: Map<string, LoadedSkill>;
  port: number;
  host: string;
}

/**
 * HTTP API for the gateway.
 *
 * Endpoints:
 *   GET  /api/health                          — health check
 *   GET  /api/agents                          — list agents + their tool context
 *   POST /api/agents/:name/exec               — execute core tool (read/write/patch/exec)
 *   POST /api/agents/:name/sessions/new       — start a new session (returns session key)
 *   GET  /api/agents/:name/sessions           — list sessions for agent
 *   PATCH /api/agents/:name/sessions/:key/model — persist the active model for a session
 *
 * The TUI process connects here to proxy tool execution through the gateway,
 * which owns the sandboxes, audit logging, and policy enforcement.
 */
export class GatewayAPI {
  private server: Server;
  private opts: GatewayAPIOptions;

  constructor(opts: GatewayAPIOptions) {
    this.opts = opts;
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${this.opts.port} is already in use — is the gateway already running?\n` +
              `  Check: beige gateway status\n` +
              `  Stop:  beige gateway stop`
            )
          );
        } else {
          reject(err);
        }
      });
      this.server.listen(this.opts.port, this.opts.host, () => {
        console.log(`[API] Listening on http://${this.opts.host}:${this.opts.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // ── Static routes ─────────────────────────────────────
      if (method === "GET" && path === "/api/health") {
        return this.json(res, 200, { status: "ok" });
      }
      if (method === "GET" && path === "/api/agents") {
        return this.handleListAgents(res);
      }
      if (method === "GET" && path === "/api/config") {
        return this.handleGetConfig(res);
      }
      if (method === "POST" && path === "/api/gateway/restart") {
        return this.handleRestart(res);
      }
      if (method === "POST" && path === "/api/chat/stream") {
        return await this.handleChatStream(req, res);
      }

      // ── Parameterised agent routes ────────────────────────
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)\/(.+)$/);
      if (agentMatch) {
        const agentName = decodeURIComponent(agentMatch[1]);
        const subPath = agentMatch[2];

        if (!this.opts.config.agents[agentName]) {
          return this.json(res, 404, { error: `Unknown agent: ${agentName}` });
        }

        if (method === "POST" && subPath === "exec") {
          return await this.handleExec(req, res, agentName);
        }
        if (method === "POST" && subPath === "prompt") {
          return await this.handlePrompt(req, res, agentName);
        }
        if (method === "GET" && subPath === "sessions") {
          return this.handleListSessions(res, agentName);
        }
        if (method === "GET" && subPath === "models") {
          return this.handleListModels(res, agentName);
        }
        if (method === "POST" && subPath === "hooks/pre-prompt") {
          return await this.handleHookPrePrompt(req, res, agentName);
        }
        if (method === "POST" && subPath === "hooks/post-response") {
          return await this.handleHookPostResponse(req, res, agentName);
        }
        if (method === "POST" && subPath === "hooks/session-created") {
          return await this.handleHookSessionCreated(req, res, agentName);
        }
        if (method === "POST" && subPath === "hooks/session-disposed") {
          return await this.handleHookSessionDisposed(req, res, agentName);
        }

        // PATCH /api/agents/:name/sessions/:key/model
        // Persists the user's active model choice for a session so it survives
        // restarts and is honoured by all channels.
        const sessionModelMatch = subPath.match(/^sessions\/(.+)\/model$/);
        if (method === "PATCH" && sessionModelMatch) {
          const sessionKey = decodeURIComponent(sessionModelMatch[1]);
          return await this.handlePersistSessionModel(req, res, agentName, sessionKey);
        }
      }

      // ── 404 ───────────────────────────────────────────────
      return this.json(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("[API] Error:", err);
      return this.json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Route handlers ─────────────────────────────────────────────────

  private handleListAgents(res: ServerResponse): void {
    const agents = Object.entries(this.opts.config.agents).map(([name, config]) => ({
      name,
      model: config.model,
      fallbackModels: config.fallbackModels ?? [],
      tools: config.tools,
      skills: config.skills ?? [],
      workspaceDir: config.workspaceDir,
      toolContext: buildPluginToolContext(config.tools, this.opts.pluginRegistry),
      skillContext: buildSkillContext(config.skills ?? [], this.opts.loadedSkills),
    }));
    this.json(res, 200, { agents });
  }

  private handleGetConfig(res: ServerResponse): void {
    const agents: Record<string, any> = {};
    for (const [name, agentConfig] of Object.entries(this.opts.config.agents)) {
      agents[name] = {
        model: agentConfig.model,
        fallbackModels: agentConfig.fallbackModels ?? [],
        tools: agentConfig.tools,
        skills: agentConfig.skills ?? [],
        workspaceDir: agentConfig.workspaceDir,
      };
    }

    this.json(res, 200, {
      agents,
      llm: {
        providers: Object.fromEntries(
          Object.entries(this.opts.config.llm.providers).map(([name, p]) => [
            name,
            { baseUrl: p.baseUrl, api: p.api },
          ])
        ),
      },
    });
  }

  private handleRestart(res: ServerResponse): void {
    console.log("[API] Restart requested via HTTP API");
    this.opts.gateway.restart().catch((err) => {
      console.error("[API] Restart error:", err);
    });
    this.json(res, 202, {
      status: "restarting",
      message: "Graceful restart initiated. Follow progress with: beige gateway logs -f",
    });
  }

  private async handleExec(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
    const body = await readBody(req);
    const { tool, params, sessionKey, activeModel } = JSON.parse(body);

    if (!tool || !params) {
      return this.json(res, 400, { error: "Missing tool or params" });
    }

    const result = await this.executeTool(agentName, tool, params, sessionKey, activeModel);
    this.json(res, 200, result);
  }

  private async handlePrompt(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
    const body = await readBody(req);
    const { message, sessionKey } = JSON.parse(body);

    if (!message) {
      return this.json(res, 400, { error: "Missing message" });
    }

    const key = sessionKey ?? `api:${agentName}:default`;
    console.log(`[API] Prompt to agent '${agentName}' (session: ${key}): ${message.slice(0, 80)}...`);

    const response = await this.opts.agentManager.prompt(key, agentName, message);
    this.json(res, 200, { response });
  }

  private handleListSessions(res: ServerResponse, agentName: string): void {
    const sessions = this.opts.sessionStore.listSessions(agentName);
    this.json(res, 200, { sessions });
  }

  private handleListModels(res: ServerResponse, agentName: string): void {
    const agentConfig = this.opts.config.agents[agentName];
    const modelRegistry = this.opts.agentManager.getModelRegistry();
    const models: Array<Record<string, unknown>> = [];

    const addModel = (modelRef: { provider: string; model: string; thinkingLevel?: string }) => {
      const m = modelRegistry.find(modelRef.provider, modelRef.model);
      if (!m) {
        // A model in the agent config wasn't found in the registry.
        // This is usually a misconfigured model ID (e.g. dots instead of hyphens).
        // Warn loudly so it shows up in gateway logs and is easy to diagnose.
        console.warn(
          `[API] handleListModels: model '${modelRef.provider}/${modelRef.model}' ` +
          `configured for agent '${agentName}' was not found in the model registry. ` +
          `It will be unavailable in the TUI and channel plugins. ` +
          `Check the model ID — common mistake: dots vs hyphens (e.g. "claude-sonnet-4.6" should be "claude-sonnet-4-6").`
        );
        return;
      }
      models.push({
        id: m.id,
        name: m.name,
        provider: m.provider,
        api: m.api,
        baseUrl: m.baseUrl,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        headers: m.headers,
        compat: m.compat,
        thinkingLevel: modelRef.thinkingLevel ?? "off",
      });
    };

    addModel(agentConfig.model);
    for (const fb of agentConfig.fallbackModels ?? []) {
      addModel(fb);
    }

    this.json(res, 200, { models });
  }

  private async handleHookPrePrompt(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
    const body = await readBody(req);
    const { message, sessionKey, channel } = JSON.parse(body);
    const result = await this.opts.pluginRegistry.executePrePrompt({
      message,
      sessionKey: sessionKey ?? `tui:${agentName}:default`,
      agentName,
      channel: channel ?? "tui",
    });
    this.json(res, 200, result);
  }

  private async handleHookPostResponse(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
    const body = await readBody(req);
    const { response, sessionKey, channel } = JSON.parse(body);
    const result = await this.opts.pluginRegistry.executePostResponse({
      response,
      sessionKey: sessionKey ?? `tui:${agentName}:default`,
      agentName,
      channel: channel ?? "tui",
    });
    this.json(res, 200, result);
  }

  private async handleHookSessionCreated(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
    const body = await readBody(req);
    const { sessionKey, channel } = JSON.parse(body);
    await this.opts.pluginRegistry.executeSessionCreated({
      sessionKey: sessionKey ?? `tui:${agentName}:default`,
      agentName,
      channel: channel ?? "tui",
    });
    this.json(res, 200, { ok: true });
  }

  private async handleHookSessionDisposed(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
    const body = await readBody(req);
    const { sessionKey, channel } = JSON.parse(body);
    await this.opts.pluginRegistry.executeSessionDisposed({
      sessionKey: sessionKey ?? `tui:${agentName}:default`,
      agentName,
      channel: channel ?? "tui",
    });
    this.json(res, 200, { ok: true });
  }

  /**
   * Persist the user's active model choice for a session.
   *
   * Called by the TUI (and channel plugins) whenever the user explicitly
   * switches models.  Stores { provider, modelId } in the session's beige
   * metadata so it can be restored on the next session open — across TUI
   * restarts, gateway restarts, and channel switches.
   *
   * The model is validated against the agent's allowed models (primary +
   * fallbacks) before being stored.  Unknown session keys are silently
   * ignored (the session may have been created by a different instance).
   */
  private async handlePersistSessionModel(
    req: IncomingMessage,
    res: ServerResponse,
    agentName: string,
    sessionKey: string
  ): Promise<void> {
    const body = await readBody(req);
    const { provider, modelId } = JSON.parse(body) as { provider?: string; modelId?: string };

    if (!provider || !modelId) {
      return this.json(res, 400, { error: "Missing provider or modelId" });
    }

    // Validate the model is in the agent's allowed list
    const agentConfig = this.opts.config.agents[agentName];
    const allowedProviders = [
      agentConfig.model,
      ...(agentConfig.fallbackModels ?? []),
    ];
    const isAllowed = allowedProviders.some(
      (m) => m.provider === provider && m.model === modelId
    );
    if (!isAllowed) {
      return this.json(res, 403, {
        error: `Model ${provider}/${modelId} is not in the allowed list for agent '${agentName}'`,
      });
    }

    this.opts.sessionStore.updateMetadata(sessionKey, { activeModel: { provider, modelId } });
    console.log(`[API] Persisted model ${provider}/${modelId} for session '${sessionKey}'`);
    this.json(res, 200, { ok: true });
  }

  /**
   * Execute a core tool in the agent's sandbox.
   */
  private async executeTool(
    agentName: string,
    tool: string,
    params: Record<string, any>,
    sessionKey?: string,
    activeModel?: { provider: string; modelId: string }
  ): Promise<{ content: Array<{ type: string; [key: string]: unknown }>; isError?: boolean }> {
    const sandbox = this.opts.sandbox;
    const audit = this.opts.audit;

    switch (tool) {
      case "read": {
        // ── Image detection ───────────────────────────────────────────────
        const mimeType = imageExtension(params.path);

        if (mimeType) {
          // Resolve the current model to check vision capability.
          // Prefer the caller-supplied activeModel (the model the TUI/channel
          // actually has selected) over the agent's primary configured model —
          // they differ whenever the user has switched models mid-session.
          const modelRegistry = this.opts.agentManager.getModelRegistry();
          const agentConfig = this.opts.config.agents[agentName];
          const modelLookup = activeModel
            ? { provider: activeModel.provider, model: activeModel.modelId }
            : agentConfig?.model;
          const resolvedModel = modelLookup
            ? modelRegistry.find(modelLookup.provider, modelLookup.model)
            : undefined;
          const modelInput: string[] = (resolvedModel?.input as string[] | undefined) ?? [];

          if (!modelInput.includes("image")) {
            const modelLabel = resolvedModel
              ? `${resolvedModel.provider}/${resolvedModel.id}`
              : "the current model";
            return {
              content: [{ type: "text", text: buildVisionUnsupportedError(params.path, modelLabel) }],
              isError: true,
            };
          }

          // Encode inside the container — avoids binary corruption through the
          // HTTP transport layer (which is not binary-safe for raw bytes).
          const timer = audit.start(agentName, "core_tool", "read", [params.path], "allowed");
          const result = await sandbox.exec(agentName, ["base64", params.path]);
          timer.finish({ exitCode: result.exitCode, outputBytes: result.stdout.length });

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: result.stderr || `Failed to read image: ${params.path}` }],
              isError: true,
            };
          }

          return {
            content: [{
              type: "image",
              data: result.stdout.replace(/\s/g, ""),
              mimeType,
            }],
          };
        }

        // ── Text files (original behaviour) ──────────────────────────────
        const args = [];
        if (params.offset || params.limit) {
          const start = params.offset ?? 1;
          const end = params.limit ? start + params.limit - 1 : "$";
          args.push("sed", "-n", `${start},${end}p`, params.path);
        } else {
          args.push("cat", params.path);
        }

        const timer = audit.start(agentName, "core_tool", "read", [params.path], "allowed");
        const result = await sandbox.exec(agentName, args);
        timer.finish({ exitCode: result.exitCode, outputBytes: Buffer.byteLength(result.stdout) });

        if (result.exitCode !== 0) {
          return {
            content: [{ type: "text", text: result.stderr || `Failed to read: ${params.path}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: result.stdout }] };
      }

      case "write": {
        const timer = audit.start(
          agentName,
          "core_tool",
          "write",
          [params.path, `(${Buffer.byteLength(params.content)} bytes)`],
          "allowed"
        );
        const script = `mkdir -p "$(dirname '${params.path}')" && cat > '${params.path}'`;
        const result = await sandbox.exec(agentName, ["sh", "-c", script], params.content);
        timer.finish({ exitCode: result.exitCode, outputBytes: Buffer.byteLength(params.content) });

        if (result.exitCode !== 0) {
          return {
            content: [{ type: "text", text: result.stderr || `Failed to write: ${params.path}` }],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text", text: `Successfully wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}` },
          ],
        };
      }

      case "patch": {
        const timer = audit.start(agentName, "core_tool", "patch", [params.path], "allowed");

        const readResult = await sandbox.exec(agentName, ["cat", params.path]);
        if (readResult.exitCode !== 0) {
          timer.finish({ exitCode: 1, error: `File not found: ${params.path}` });
          return {
            content: [{ type: "text", text: `File not found: ${params.path}` }],
            isError: true,
          };
        }

        const content = readResult.stdout;
        if (!content.includes(params.oldText)) {
          timer.finish({ exitCode: 1, error: "oldText not found in file" });
          return {
            content: [
              { type: "text", text: `The specified oldText was not found in ${params.path}. Make sure it matches exactly.` },
            ],
            isError: true,
          };
        }

        const newContent = content.replace(params.oldText, params.newText);
        const writeResult = await sandbox.exec(agentName, ["sh", "-c", `cat > '${params.path}'`], newContent);
        timer.finish({ exitCode: writeResult.exitCode, outputBytes: Buffer.byteLength(newContent) });

        if (writeResult.exitCode !== 0) {
          return {
            content: [{ type: "text", text: writeResult.stderr || "Failed to write patched file" }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Successfully patched ${params.path}` }] };
      }

      case "exec": {
        const timer = audit.start(agentName, "core_tool", "exec", [params.command], "allowed");
        const timeout = (params.timeout ?? 120) * 1000;
        // Inject session context env vars so gateway tools (e.g. agent-to-agent)
        // can identify the calling agent. Derive channel and session key from the
        // caller-provided sessionKey (falls back to tui defaults for backward compat).
        const resolvedSessionKey = sessionKey ?? `tui:${agentName}:default`;
        const resolvedChannel = parseSessionKey(resolvedSessionKey).channel;
        const env: Record<string, string> = {
          BEIGE_AGENT_NAME: agentName,
          BEIGE_CHANNEL: resolvedChannel,
          BEIGE_SESSION_KEY: resolvedSessionKey,
        };
        const result = await sandbox.exec(agentName, ["sh", "-c", params.command], undefined, timeout, env);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        timer.finish({ exitCode: result.exitCode, outputBytes: Buffer.byteLength(output) });

        return {
          content: [{ type: "text", text: `Exit code: ${result.exitCode}\n${output}` }],
          isError: result.exitCode !== 0,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${tool}` }],
          isError: true,
        };
    }
  }

  /**
   * LLM proxy endpoint: resolves auth server-side, executes pre/post hooks,
   * applies the agent's fallback model chain on rate-limit errors, audit-logs
   * every attempt, and streams AssistantMessageEvent objects back as
   * newline-delimited JSON.
   *
   * The TUI process has no API keys and no fallback logic — both now live here.
   *
   * Special stream events emitted beyond the pi AssistantMessageEvent set:
   *   { type: "blocked",        reason: string }  — prePrompt hook blocked the message
   *   { type: "model_fallback", provider, modelId } — gateway switched to a fallback model
   */
  private async handleChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let reqData: {
      provider: string;
      modelId: string;
      context: Context;
      options?: SimpleStreamOptions;
      agentName?: string;
      sessionKey?: string;
    };
    try {
      reqData = JSON.parse(body);
    } catch {
      return this.json(res, 400, { error: "Invalid JSON" });
    }

    const { provider, modelId, context, options, agentName, sessionKey } = reqData;
    if (!provider || !modelId || !context) {
      return this.json(res, 400, { error: "Missing provider, modelId, or context" });
    }

    const modelRegistry = this.opts.agentManager.getModelRegistry();

    // ── Execute prePrompt hooks server-side ──────────────────────────
    // Hooks can transform or block messages before the LLM sees them.
    // This replaces the TUI's explicit HTTP call to /hooks/pre-prompt and
    // ensures all channels — TUI and plugin channels alike — go through the
    // same hook chain without an extra network round-trip.
    if (agentName && this.opts.config.agents[agentName]) {
      const resolvedSessionKey = sessionKey ?? `tui:${agentName}:default`;
      const channel = parseSessionKey(resolvedSessionKey).channel;
      const userMessage = extractLastUserMessage(context);

      const preResult = await this.opts.pluginRegistry.executePrePrompt({
        message: userMessage,
        sessionKey: resolvedSessionKey,
        agentName,
        channel,
      });

      if (preResult.block) {
        // Signal the TUI to stop the agent loop cleanly (treated as abort)
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Transfer-Encoding": "chunked",
          "Cache-Control": "no-cache",
        });
        res.write(JSON.stringify({
          type: "blocked",
          reason: preResult.reason ?? "Message blocked by plugin hook.",
        }) + "\n");
        res.end();
        return;
      }
    }

    // ── Build fallback model list ─────────────────────────────────────
    // Start from the model the TUI requested, then continue with the
    // agent's configured fallback models.  This mirrors the logic in
    // AgentManager.prompt() / promptStreaming() so rate-limit handling is
    // consistent regardless of which path triggered the LLM call.
    const modelsToTry = agentName
      ? this.opts.agentManager.getModelsToTryForStream(agentName, provider, modelId)
      : [{ provider, model: modelId }];

    // ── Detect client disconnect ──────────────────────────────────────
    const abortController = new AbortController();
    let closed = false;
    const onClose = () => {
      if (!closed) {
        closed = true;
        abortController.abort();
      }
    };
    req.on("close", onClose);
    res.on("close", onClose);

    // Track this stream so drainAll() waits for it during a gateway restart.
    this.opts.agentManager.incrementActiveStream();

    // Headers are written on the first model attempt that doesn't immediately
    // throw — this lets us try the next model before committing to a response.
    let headersWritten = false;
    let fullResponseText = "";

    const writeHeaders = () => {
      if (!headersWritten) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Transfer-Encoding": "chunked",
          "Cache-Control": "no-cache",
        });
        headersWritten = true;
      }
    };

    try {
      for (const modelRef of modelsToTry) {
        if (closed) break;

        if (this.opts.agentManager.isModelCoolingDown(modelRef.provider, modelRef.model)) {
          console.log(`[API] Skipping ${modelRef.provider}/${modelRef.model} — in cooldown`);
          continue;
        }

        const model = modelRegistry.find(modelRef.provider, modelRef.model);
        if (!model) {
          console.warn(`[API] Model not found in registry: ${modelRef.provider}/${modelRef.model} — skipping`);
          continue;
        }

        const apiKey = await modelRegistry.getApiKey(model);
        if (!apiKey) {
          console.warn(`[API] No API key for ${modelRef.provider}/${modelRef.model} — skipping`);
          continue;
        }

        // Audit: log each attempt individually so we can trace which model
        // actually served the response.
        const auditTimer = this.opts.audit.start(
          agentName ?? "unknown",
          "core_tool",
          `llm:${modelRef.provider}/${modelRef.model}`,
          sessionKey ? [sessionKey] : [],
          "allowed",
          "gateway"
        );

        // If this is a fallback attempt (headers already written), notify
        // the client so it can update its model display if desired.
        if (headersWritten) {
          res.write(JSON.stringify({
            type: "model_fallback",
            provider: modelRef.provider,
            modelId: modelRef.model,
          }) + "\n");
        }

        try {
          const stream = streamSimple(model, context, {
            ...options,
            apiKey,
            signal: abortController.signal,
          });

          // Write headers before the first event arrives so the client can
          // start processing immediately.
          writeHeaders();

          let totalOutputTokens = 0;
          fullResponseText = "";

          for await (const event of stream) {
            if (closed) break;

            // Accumulate full text for postResponse hooks (fired after stream ends)
            if (
              (event as any).type === "text_delta" &&
              typeof (event as any).delta === "string"
            ) {
              fullResponseText += (event as any).delta;
            }

            // Track output tokens for the audit log
            if ((event as any).type === "done" && (event as any).message?.usage) {
              totalOutputTokens = (event as any).message.usage.output ?? 0;
            }

            res.write(JSON.stringify(event) + "\n");
          }

          this.opts.agentManager.markModelHealthy(modelRef.provider, modelRef.model);
          auditTimer.finish({ exitCode: 0, outputBytes: totalOutputTokens });
          break; // Stream succeeded — stop trying fallbacks

        } catch (err) {
          if (closed) {
            auditTimer.finish({ exitCode: 0 });
            break;
          }

          const isAborted = (err as any)?.name === "AbortError";
          if (isAborted) {
            auditTimer.finish({ exitCode: 0 });
            break;
          }

          const errorMsg = err instanceof Error ? err.message : String(err);
          const rateLimitInfo = extractRateLimitInfo(err);

          if (rateLimitInfo.isRateLimit) {
            // Rate-limited — record it and try the next fallback model
            this.opts.agentManager.markModelRateLimited(
              modelRef.provider, modelRef.model, rateLimitInfo.retryAfterMs, errorMsg
            );
            auditTimer.finish({ exitCode: 1, error: "rate limited" });
            console.log(`[API] ${modelRef.provider}/${modelRef.model} rate limited — trying next fallback model`);
            continue;
          }

          // Non-rate-limit error — record it, write an error event, and stop
          this.opts.agentManager.markModelFailed(modelRef.provider, modelRef.model, errorMsg);
          auditTimer.finish({ exitCode: 1, error: errorMsg });
          console.error(`[API] ${modelRef.provider}/${modelRef.model} stream error: ${errorMsg}`);

          writeHeaders();
          res.write(JSON.stringify(buildStreamErrorEvent(model, errorMsg)) + "\n");
          break;
        }
      }

      // All models were skipped (all cooling down) and nothing was written
      if (!headersWritten) {
        writeHeaders();
        res.write(JSON.stringify(buildStreamErrorEvent(
          { api: "unknown", provider, id: modelId },
          "All models are currently rate-limited. Please try again later."
        )) + "\n");
      }

    } finally {
      // ── Execute postResponse hooks server-side ─────────────────────
      // Fire-and-forget: the response is already streamed so a `block` result
      // can't suppress it, but hooks can still do logging, forwarding, etc.
      if (agentName && fullResponseText) {
        const resolvedSessionKey = sessionKey ?? `tui:${agentName}:default`;
        const channel = parseSessionKey(resolvedSessionKey).channel;
        this.opts.pluginRegistry.executePostResponse({
          response: fullResponseText,
          sessionKey: resolvedSessionKey,
          agentName,
          channel,
        }).catch((err) => console.error("[API] postResponse hook error:", err));
      }

      this.opts.agentManager.decrementActiveStream();
      res.end();
    }
  }

  private json(res: ServerResponse, status: number, data: any): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/**
 * Build a minimal AssistantMessage error event for the ndjson stream.
 */
function buildStreamErrorEvent(
  model: { api: unknown; provider: string; id: string },
  errorMessage: string
) {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error" as const,
      errorMessage,
      timestamp: Date.now(),
    },
  };
}

/**
 * Extract the text of the last user message from a conversation Context.
 * Used to pass the triggering message to prePrompt hooks.
 */
function extractLastUserMessage(context: Context): string {
  const messages: Array<{ role: string; content: unknown }> =
    (context as any).messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return (msg.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
      }
    }
  }
  return "";
}

