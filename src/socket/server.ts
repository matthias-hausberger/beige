import { createServer, type Server, type Socket } from "net";
import { mkdirSync, unlinkSync, existsSync } from "fs";
import { dirname } from "path";
import {
  type ToolRequest,
  type ToolResponse,
  encodeMessage,
  decodeMessage,
} from "./protocol.js";
import type { AuditLogger } from "../gateway/audit.js";
import type { PolicyEngine } from "../gateway/policy.js";
import type { ToolRunner } from "../tools/runner.js";
import type { SessionContext } from "../types/session.js";
import type { AgentManager } from "../gateway/agent-manager.js";

/**
 * Unix domain socket server for a single agent.
 * Listens on a socket file, handles tool requests from sandbox launchers.
 */
export class AgentSocketServer {
  private server: Server | null = null;

  constructor(
    private agentName: string,
    private socketPath: string,
    private audit: AuditLogger,
    private policy: PolicyEngine,
    private toolRunner: ToolRunner,
    private agentDir: string,
    private workspaceDir: string,
    private agentManager: AgentManager
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up stale socket file
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }
      mkdirSync(dirname(this.socketPath), { recursive: true });

      this.server = createServer((socket: Socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => {
        console.log(`[SOCKET] Agent '${this.agentName}' listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          if (existsSync(this.socketPath)) {
            unlinkSync(this.socketPath);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";

    socket.on("data", async (data: Buffer) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited)
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = decodeMessage(line) as ToolRequest;
          if (msg.type !== "tool_request") {
            socket.write(
              encodeMessage({
                type: "tool_response",
                success: false,
                error: `Unknown message type: ${(msg as any).type}`,
                exitCode: 1,
              })
            );
            continue;
          }

          const response = await this.handleToolRequest(msg);
          socket.write(encodeMessage(response));
        } catch (err) {
          socket.write(
            encodeMessage({
              type: "tool_response",
              success: false,
              error: `Invalid request: ${err instanceof Error ? err.message : String(err)}`,
              exitCode: 1,
            })
          );
        }
      }
    });

    socket.on("error", (err) => {
      console.error(`[SOCKET] Connection error for agent '${this.agentName}':`, err.message);
    });
  }

  private async handleToolRequest(req: ToolRequest): Promise<ToolResponse> {
    const { tool, args } = req;

    // Check policy
    if (!this.policy.isToolAllowed(this.agentName, tool)) {
      const timer = this.audit.start(this.agentName, "tool", tool, args, "denied", undefined, {
        session: req.sessionContext?.sessionKey,
        channel: req.sessionContext?.channel,
      });
      timer.finish({ exitCode: 1, error: "Permission denied" });
      return {
        type: "tool_response",
        success: false,
        error: `Permission denied: tool '${tool}' is not allowed for agent '${this.agentName}'`,
        exitCode: 1,
      };
    }

    // Enrich session context with agent identity and paths
    // The request may have partial context from the sandbox launcher
    const sessionContext: SessionContext = {
      sessionKey: req.sessionContext?.sessionKey ?? `socket:${this.agentName}`,
      channel: req.sessionContext?.channel ?? "socket",
      ...req.sessionContext,
      agentName: this.agentName,
      agentDir: this.agentDir,
      workspaceDir: this.workspaceDir,
      cwd: req.cwd,  // Pass through relative cwd from sandbox
      onToolStart: this.agentManager.getOnToolStartCallback(req.sessionContext?.sessionKey ?? `socket:${this.agentName}`),
    };

    // Execute tool
    const timer = this.audit.start(
      this.agentName,
      "tool",
      tool,
      args,
      "allowed",
      this.policy.getToolTarget(tool),
      {
        session: sessionContext.sessionKey,
        channel: sessionContext.channel,
      }
    );

    try {
      const result = await this.toolRunner.run(tool, args, sessionContext);
      timer.finish({
        exitCode: result.exitCode,
        outputBytes: Buffer.byteLength(result.output ?? ""),
      });
      // On failure, populate both output and error with the tool's message so
      // the sandbox tool-client (which only prints parsed.error on non-success)
      // surfaces the diagnostic text to the agent.
      return {
        type: "tool_response",
        success: result.exitCode === 0,
        output: result.output,
        error: result.exitCode !== 0 ? result.output : undefined,
        exitCode: result.exitCode,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      timer.finish({ exitCode: 1, error: errorMsg });
      return {
        type: "tool_response",
        success: false,
        error: errorMsg,
        exitCode: 1,
      };
    }
  }
}
