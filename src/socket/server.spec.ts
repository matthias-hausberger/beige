import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentSocketServer } from "./server.js";
import { PolicyEngine } from "../gateway/policy.js";
import { ToolRunner } from "../tools/runner.js";
import { AuditLogger } from "../gateway/audit.js";
import { createFullConfig } from "../test/fixtures.js";
import { createConnection, Socket } from "net";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { encodeMessage, decodeMessage, type ToolRequest, type ToolResponse } from "./protocol.js";

describe("AgentSocketServer", () => {
  let tempDir: string;
  let socketPath: string;
  let server: AgentSocketServer;
  let policy: PolicyEngine;
  let toolRunner: ToolRunner;
  let auditLogger: AuditLogger;
  let auditLogPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `beige-socket-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    socketPath = join(tempDir, "test-agent.sock");
    auditLogPath = join(tempDir, "audit.jsonl");

    const config = createFullConfig();
    policy = new PolicyEngine(config);
    toolRunner = new ToolRunner();
    auditLogger = new AuditLogger(auditLogPath);

    server = new AgentSocketServer(
      "assistant",
      socketPath,
      auditLogger,
      policy,
      toolRunner
    );

    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper to send request and receive response
  const sendRequest = (request: ToolRequest): Promise<ToolResponse> => {
    return new Promise((resolve, reject) => {
      const client = createConnection(socketPath, () => {
        client.write(encodeMessage(request));
        client.end(); // Close connection after sending
      });

      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString();
      });

      client.on("close", () => {
        try {
          if (buffer.trim()) {
            const response = decodeMessage(buffer.trim()) as ToolResponse;
            resolve(response);
          } else {
            reject(new Error("No response received"));
          }
        } catch (err) {
          reject(err);
        }
      });

      client.on("error", reject);

      // Timeout after 5 seconds
      setTimeout(() => {
        client.destroy();
        reject(new Error("Connection timeout"));
      }, 5000);
    });
  };

  describe("connection handling", () => {
    it("accepts connections on the socket", async () => {
      const request: ToolRequest = {
        type: "tool_request",
        tool: "unknown",
        args: [],
      };

      // Should not throw - connection is accepted and response received
      const response = await sendRequest(request);
      expect(response).toBeDefined();
    });

    it("handles multiple sequential requests", async () => {
      const request: ToolRequest = {
        type: "tool_request",
        tool: "unknown",
        args: [],
      };

      const response1 = await sendRequest(request);
      const response2 = await sendRequest(request);

      expect(response1).toBeDefined();
      expect(response2).toBeDefined();
    });
  });

  describe("policy enforcement", () => {
    it("denies tool not in agent's allowed list", async () => {
      // "assistant" only has "git" tool, not "chrome"
      const request: ToolRequest = {
        type: "tool_request",
        tool: "chrome",
        args: ["navigate", "https://example.com"],
      };

      const response = await sendRequest(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain("Permission denied");
      expect(response.exitCode).toBe(1);
    });

    it("allows tool in agent's allowed list", async () => {
      // Register a handler for the "git" tool
      toolRunner.registerHandler("git", async () => ({
        output: "OK",
        exitCode: 0,
      }));

      const request: ToolRequest = {
        type: "tool_request",
        tool: "git",
        args: ["set", "key", "value"],
      };

      const response = await sendRequest(request);

      expect(response.success).toBe(true);
      expect(response.output).toBe("OK");
      expect(response.exitCode).toBe(0);
    });
  });

  describe("tool execution", () => {
    it("executes registered handler", async () => {
      toolRunner.registerHandler("git", async (args) => ({
        output: `Got args: ${args.join(", ")}`,
        exitCode: 0,
      }));

      const request: ToolRequest = {
        type: "tool_request",
        tool: "git",
        args: ["get", "mykey"],
      };

      const response = await sendRequest(request);

      expect(response.success).toBe(true);
      expect(response.output).toBe("Got args: get, mykey");
    });

    it("returns error for unknown tool (no handler)", async () => {
      // "git" is allowed but no handler registered
      const request: ToolRequest = {
        type: "tool_request",
        tool: "git",
        args: ["get", "key"],
      };

      const response = await sendRequest(request);

      // ToolRunner returns "Unknown tool" in output, not error
      // success is false because exitCode is 1
      expect(response.success).toBe(false);
      expect(response.exitCode).toBe(1);
      // The error message is in output field when tool returns non-zero exit
      expect(response.output ?? response.error).toBeDefined();
    });

    it("handles handler errors", async () => {
      toolRunner.registerHandler("git", async () => {
        throw new Error("Handler crashed");
      });

      const request: ToolRequest = {
        type: "tool_request",
        tool: "git",
        args: [],
      };

      const response = await sendRequest(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain("Handler crashed");
      expect(response.exitCode).toBe(1);
    });
  });

  describe("message protocol", () => {
    it("rejects unknown message types", async () => {
      const response = await new Promise<ToolResponse>((resolve, reject) => {
        const client = createConnection(socketPath, () => {
          client.write(Buffer.from(JSON.stringify({ type: "unknown" }) + "\n"));
          client.end();
        });

        let buffer = "";
        client.on("data", (data) => {
          buffer += data.toString();
        });

        client.on("close", () => {
          try {
            resolve(decodeMessage(buffer.trim()) as ToolResponse);
          } catch (err) {
            reject(err);
          }
        });

        client.on("error", reject);

        setTimeout(() => {
          client.destroy();
          reject(new Error("Timeout"));
        }, 5000);
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("Unknown message type");
    });

    it("handles malformed JSON", async () => {
      const response = await new Promise<ToolResponse>((resolve, reject) => {
        const client = createConnection(socketPath, () => {
          client.write(Buffer.from("not valid json\n"));
          client.end();
        });

        let buffer = "";
        client.on("data", (data) => {
          buffer += data.toString();
        });

        client.on("close", () => {
          try {
            resolve(decodeMessage(buffer.trim()) as ToolResponse);
          } catch (err) {
            reject(err);
          }
        });

        client.on("error", reject);

        setTimeout(() => {
          client.destroy();
          reject(new Error("Timeout"));
        }, 5000);
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("Invalid request");
    });

    it("handles multiple messages in single data chunk", async () => {
      toolRunner.registerHandler("git", async (args) => ({
        output: `args: ${args[0]}`,
        exitCode: 0,
      }));

      const responses = await new Promise<ToolResponse[]>((resolve, reject) => {
        const client = createConnection(socketPath, () => {
          // Send two messages at once
          const msg1: ToolRequest = { type: "tool_request", tool: "git", args: ["first"] };
          const msg2: ToolRequest = { type: "tool_request", tool: "git", args: ["second"] };
          client.write(encodeMessage(msg1));
          client.write(encodeMessage(msg2));
          client.end();
        });

        let buffer = "";
        client.on("data", (data) => {
          buffer += data.toString();
        });

        client.on("close", () => {
          try {
            const lines = buffer.trim().split("\n");
            const responses = lines.map((line) => decodeMessage(line.trim()) as ToolResponse);
            resolve(responses);
          } catch (err) {
            reject(err);
          }
        });

        client.on("error", reject);

        setTimeout(() => {
          client.destroy();
          reject(new Error("Timeout"));
        }, 5000);
      });

      expect(responses.length).toBe(2);
      expect(responses[0].output).toBe("args: first");
      expect(responses[1].output).toBe("args: second");
    });
  });

  describe("audit logging", () => {
    it("logs allowed tool calls", async () => {
      toolRunner.registerHandler("git", async () => ({
        output: "OK",
        exitCode: 0,
      }));

      await sendRequest({ type: "tool_request", tool: "git", args: ["test"] });

      const { readFileSync } = await import("fs");
      const log = readFileSync(auditLogPath, "utf-8");
      const lines = log.trim().split("\n");

      // Should have "started" and "finished" entries
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const finishedEntry = JSON.parse(lines[lines.length - 1]);
      expect(finishedEntry.tool).toBe("git");
      expect(finishedEntry.decision).toBe("allowed");
    });

    it("logs denied tool calls", async () => {
      // "chrome" is not allowed for "assistant"
      await sendRequest({ type: "tool_request", tool: "chrome", args: [] });

      const { readFileSync } = await import("fs");
      const log = readFileSync(auditLogPath, "utf-8");
      const lines = log.trim().split("\n");

      const entry = JSON.parse(lines[0]);
      expect(entry.tool).toBe("chrome");
      expect(entry.decision).toBe("denied");
    });
  });

  describe("server lifecycle", () => {
    it("removes socket file on stop", async () => {
      const { existsSync } = await import("fs");

      expect(existsSync(socketPath)).toBe(true);

      await server.stop();

      expect(existsSync(socketPath)).toBe(false);
    });

    it("cleans up stale socket file on start", async () => {
      const { writeFileSync, existsSync } = await import("fs");

      // Stop the first server
      await server.stop();

      // Create a stale socket file
      writeFileSync(socketPath, "stale");

      // Start a new server - should clean up the stale file
      const newServer = new AgentSocketServer(
        "assistant",
        socketPath,
        auditLogger,
        policy,
        toolRunner
      );

      await newServer.start();

      // Should be able to connect
      const request: ToolRequest = {
        type: "tool_request",
        tool: "unknown",
        args: [],
      };

      const response = await new Promise<ToolResponse>((resolve, reject) => {
        const client = createConnection(socketPath, () => {
          client.write(encodeMessage(request));
          client.end();
        });

        let buffer = "";
        client.on("data", (data) => {
          buffer += data.toString();
        });

        client.on("close", () => {
          resolve(decodeMessage(buffer.trim()) as ToolResponse);
        });

        client.on("error", reject);

        setTimeout(() => {
          client.destroy();
          reject(new Error("Timeout"));
        }, 5000);
      });

      expect(response).toBeDefined();

      await newServer.stop();
    });
  });
});
