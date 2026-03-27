import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { BeigeConfig } from "../config/schema.js";
import type { AgentManager } from "./agent-manager.js";
import type { BeigeSessionStore } from "./sessions.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { AuditLogger } from "./audit.js";
import type { Gateway } from "./gateway.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { buildSkillContext, type LoadedSkill } from "../skills/registry.js";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Context, SimpleStreamOptions } from "@mariozechner/pi-ai";

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
      // ── GET /api/health ───────────────────────────────────
      if (method === "GET" && path === "/api/health") {
        return this.json(res, 200, { status: "ok" });
      }

      // ── GET /api/agents ───────────────────────────────────
      if (method === "GET" && path === "/api/agents") {
        const agents = Object.entries(this.opts.config.agents).map(([name, config]) => ({
          name,
          model: config.model,
          fallbackModels: config.fallbackModels ?? [],
          tools: config.tools,
          skills: config.skills ?? [],
          toolContext: buildPluginToolContext(config.tools, this.opts.pluginRegistry),
          skillContext: buildSkillContext(config.skills ?? [], this.opts.loadedSkills),
        }));
        return this.json(res, 200, { agents });
      }

      // ── POST /api/agents/:name/exec ───────────────────────
      const execMatch = path.match(/^\/api\/agents\/([^/]+)\/exec$/);
      if (method === "POST" && execMatch) {
        const agentName = decodeURIComponent(execMatch[1]);
        if (!this.opts.config.agents[agentName]) {
          return this.json(res, 404, { error: `Unknown agent: ${agentName}` });
        }

        const body = await readBody(req);
        const { tool, params } = JSON.parse(body);

        if (!tool || !params) {
          return this.json(res, 400, { error: "Missing tool or params" });
        }

        const result = await this.executeTool(agentName, tool, params);
        return this.json(res, 200, result);
      }

      // ── POST /api/agents/:name/prompt ────────────────────
      const promptMatch = path.match(/^\/api\/agents\/([^/]+)\/prompt$/);
      if (method === "POST" && promptMatch) {
        const agentName = decodeURIComponent(promptMatch[1]);
        if (!this.opts.config.agents[agentName]) {
          return this.json(res, 404, { error: `Unknown agent: ${agentName}` });
        }

        const body = await readBody(req);
        const { message, sessionKey } = JSON.parse(body);

        if (!message) {
          return this.json(res, 400, { error: "Missing message" });
        }

        const key = sessionKey ?? `api:${agentName}:default`;
        console.log(`[API] Prompt to agent '${agentName}' (session: ${key}): ${message.slice(0, 80)}...`);

        const response = await this.opts.agentManager.prompt(key, agentName, message);
        return this.json(res, 200, { response });
      }

      // ── GET /api/agents/:name/sessions ────────────────────
      const sessionsMatch = path.match(/^\/api\/agents\/([^/]+)\/sessions$/);
      if (method === "GET" && sessionsMatch) {
        const agentName = decodeURIComponent(sessionsMatch[1]);
        const sessions = this.opts.sessionStore.listSessions(agentName);
        return this.json(res, 200, { sessions });
      }

      // ── POST /api/gateway/restart ─────────────────────────
      // Triggers a graceful in-place restart: drain → teardown → reload config → start.
      // Returns 202 immediately; the restart happens asynchronously in the gateway process.
      if (method === "POST" && path === "/api/gateway/restart") {
        console.log("[API] Restart requested via HTTP API");
        // Fire and forget — restart() is idempotent if already in progress
        this.opts.gateway.restart().catch((err) => {
          console.error("[API] Restart error:", err);
        });
        return this.json(res, 202, {
          status: "restarting",
          message: "Graceful restart initiated. Follow progress with: beige gateway logs -f",
        });
      }

      // ── GET /api/config ───────────────────────────────────
      // Returns agent configs + provider metadata (NOT api keys)
      if (method === "GET" && path === "/api/config") {
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

        return this.json(res, 200, {
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

      // ── GET /api/agents/:name/models ──────────────────────
      // Returns model metadata for the agent's allowed models (primary + fallbacks).
      // The TUI uses this to create proxy models without needing API keys.
      const modelsMatch = path.match(/^\/api\/agents\/([^/]+)\/models$/);
      if (method === "GET" && modelsMatch) {
        const agentName = decodeURIComponent(modelsMatch[1]);
        const agentConfig = this.opts.config.agents[agentName];
        if (!agentConfig) {
          return this.json(res, 404, { error: `Unknown agent: ${agentName}` });
        }

        const modelRegistry = this.opts.agentManager.getModelRegistry();
        const models: Array<Record<string, unknown>> = [];

        const addModel = (modelRef: { provider: string; model: string; thinkingLevel?: string }) => {
          const m = modelRegistry.find(modelRef.provider, modelRef.model);
          if (m) {
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
          }
        };

        addModel(agentConfig.model);
        for (const fb of agentConfig.fallbackModels ?? []) {
          addModel(fb);
        }

        return this.json(res, 200, { models });
      }

      // ── POST /api/chat/stream ────────────────────────────
      // LLM proxy: accepts a chat request, resolves auth server-side,
      // forwards to the real LLM provider, and streams events back.
      // This allows the TUI to make LLM calls without having API keys.
      if (method === "POST" && path === "/api/chat/stream") {
        return this.handleChatStream(req, res);
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

  /**
   * Execute a core tool in the agent's sandbox.
   */
  private async executeTool(
    agentName: string,
    tool: string,
    params: Record<string, any>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const sandbox = this.opts.sandbox;
    const audit = this.opts.audit;

    switch (tool) {
      case "read": {
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
        // can identify the calling agent. agentName is always known from the route.
        // BEIGE_CHANNEL is "tui" since the HTTP exec endpoint is only used by the TUI.
        // BEIGE_SESSION_KEY uses the standard TUI key format so the session store
        // lookup works for depth metadata retrieval.
        const env: Record<string, string> = {
          BEIGE_AGENT_NAME: agentName,
          BEIGE_CHANNEL: "tui",
          BEIGE_SESSION_KEY: `tui:${agentName}:default`,
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
   * LLM proxy endpoint: resolves auth server-side, forwards to the real
   * LLM provider, and streams AssistantMessageEvent objects back as
   * newline-delimited JSON.
   */
  private async handleChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let reqData: { provider: string; modelId: string; context: Context; options?: SimpleStreamOptions };
    try {
      reqData = JSON.parse(body);
    } catch {
      return this.json(res, 400, { error: "Invalid JSON" });
    }

    const { provider, modelId, context, options } = reqData;
    if (!provider || !modelId || !context) {
      return this.json(res, 400, { error: "Missing provider, modelId, or context" });
    }

    const modelRegistry = this.opts.agentManager.getModelRegistry();
    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      return this.json(res, 404, { error: `Model not found: ${provider}/${modelId}` });
    }

    // Resolve API key server-side
    const apiKey = await modelRegistry.getApiKey(model);
    if (!apiKey) {
      return this.json(res, 401, { error: `No API key configured for ${provider}/${modelId}` });
    }

    // Stream response — newline-delimited JSON
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    });

    // Detect client disconnect to abort the LLM call
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

    try {
      const stream = streamSimple(model, context, {
        ...options,
        apiKey,
        signal: abortController.signal,
      });

      for await (const event of stream) {
        if (closed) break;
        res.write(JSON.stringify(event) + "\n");
      }
    } catch (err) {
      if (!closed) {
        const isAborted = (err as any).name === "AbortError";
        const errorEvent = {
          type: "error",
          reason: isAborted ? "aborted" : "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: isAborted ? "aborted" : "error",
            errorMessage: isAborted ? undefined : (err instanceof Error ? err.message : String(err)),
            timestamp: Date.now(),
          },
        };
        res.write(JSON.stringify(errorEvent) + "\n");
      }
    }

    res.end();
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
 * Build tool context string for the system prompt from the plugin registry.
 */
function buildPluginToolContext(
  agentTools: string[],
  registry: PluginRegistry
): string {
  if (agentTools.length === 0) return "";

  const lines: string[] = ["## Available Tools", ""];

  for (const toolName of agentTools) {
    const tool = registry.getTool(toolName);
    if (!tool) continue;

    lines.push(`### ${toolName}`);
    lines.push(`${tool.description}`);
    if (tool.commands?.length) {
      lines.push("Commands:");
      for (const cmd of tool.commands) {
        lines.push(`  ${toolName} ${cmd}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
