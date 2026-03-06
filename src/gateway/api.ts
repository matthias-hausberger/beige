import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { BeigeConfig } from "../config/schema.js";
import type { AgentManager } from "./agent-manager.js";
import type { BeigeSessionStore } from "./sessions.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { AuditLogger } from "./audit.js";

export interface GatewayAPIOptions {
  config: BeigeConfig;
  agentManager: AgentManager;
  sessionStore: BeigeSessionStore;
  sandbox: SandboxManager;
  audit: AuditLogger;
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
          tools: config.tools,
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

      // ── GET /api/config ───────────────────────────────────
      // Returns agent configs + provider metadata (NOT api keys)
      if (method === "GET" && path === "/api/config") {
        const agents: Record<string, any> = {};
        for (const [name, agentConfig] of Object.entries(this.opts.config.agents)) {
          agents[name] = {
            model: agentConfig.model,
            fallbackModels: agentConfig.fallbackModels,
            tools: agentConfig.tools,
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
        const result = await sandbox.exec(agentName, ["sh", "-c", params.command], undefined, timeout);
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
