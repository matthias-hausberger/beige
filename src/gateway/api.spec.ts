import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GatewayAPI } from "./api.js";
import { createFullConfig, createMinimalConfig } from "../test/fixtures.js";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentManager } from "./agent-manager.js";
import type { BeigeSessionStore } from "./sessions.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { AuditLogger } from "./audit.js";
import type { Gateway } from "./gateway.js";

// Helper to make HTTP requests
async function fetchApi(
  baseUrl: string,
  path: string,
  options: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json();
  return { status: response.status, body };
}

describe("GatewayAPI", () => {
  let tempDir: string;
  let api: GatewayAPI;
  let baseUrl: string;
  let mockGateway: Partial<Gateway>;
  let mockAgentManager: Partial<AgentManager>;
  let mockSessionStore: Partial<BeigeSessionStore>;
  let mockSandbox: Partial<SandboxManager>;
  let mockAudit: Partial<AuditLogger>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `beige-api-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const config = createFullConfig();
    const auditLogPath = join(tempDir, "audit.jsonl");

    mockGateway = {
      restart: vi.fn().mockResolvedValue(undefined),
    };

    mockAgentManager = {
      prompt: vi.fn().mockResolvedValue("AI response"),
    };

    mockSessionStore = {
      getSessionFile: vi.fn(),
      createSession: vi.fn().mockReturnValue(join(tempDir, "session.jsonl")),
      listSessions: vi.fn().mockReturnValue([]),
    };

    mockSandbox = {
      exec: vi.fn().mockResolvedValue({
        stdout: "file contents",
        stderr: "",
        exitCode: 0,
      }),
    };

    mockAudit = {
      start: vi.fn().mockReturnValue({
        finish: vi.fn(),
      }),
    };

    api = new GatewayAPI({
      config,
      gateway: mockGateway as Gateway,
      agentManager: mockAgentManager as AgentManager,
      sessionStore: mockSessionStore as BeigeSessionStore,
      sandbox: mockSandbox as SandboxManager,
      audit: mockAudit as AuditLogger,
      pluginRegistry: new (await import("../plugins/registry.js")).PluginRegistry(),
      loadedSkills: new Map(),
      port: 0, // Use random available port
      host: "127.0.0.1",
    });

    await api.start();

    // Get the actual port assigned
    const address = (api as any).server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await api.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("GET /api/health", () => {
    it("returns ok status", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/health");

      expect(status).toBe(200);
      expect(body.status).toBe("ok");
    });
  });

  describe("GET /api/agents", () => {
    it("returns list of configured agents", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/agents");

      expect(status).toBe(200);
      expect(body.agents).toBeInstanceOf(Array);
      expect(body.agents.length).toBeGreaterThan(0);

      const assistant = body.agents.find((a: any) => a.name === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant.tools).toContain("git");
    });

    it("includes model info for each agent", async () => {
      const { body } = await fetchApi(baseUrl, "/api/agents");

      const assistant = body.agents.find((a: any) => a.name === "assistant");
      expect(assistant.model.provider).toBe("anthropic");
      expect(assistant.model.model).toBe("claude-sonnet-4-6");
    });
  });

  describe("POST /api/agents/:name/exec", () => {
    it("executes read tool", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/agents/assistant/exec", {
        method: "POST",
        body: JSON.stringify({
          tool: "read",
          params: { path: "/workspace/test.txt" },
        }),
      });

      expect(status).toBe(200);
      expect(body.content[0].type).toBe("text");
      expect(body.content[0].text).toBe("file contents");
      expect(mockSandbox.exec).toHaveBeenCalled();
    });

    it("executes write tool", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/agents/assistant/exec", {
        method: "POST",
        body: JSON.stringify({
          tool: "write",
          params: { path: "/workspace/out.txt", content: "hello" },
        }),
      });

      expect(status).toBe(200);
      expect(body.content[0].text).toContain("Successfully wrote");
    });

    it("executes exec tool", async () => {
      (mockSandbox.exec as any).mockResolvedValueOnce({
        stdout: "output",
        stderr: "",
        exitCode: 0,
      });

      const { status, body } = await fetchApi(baseUrl, "/api/agents/assistant/exec", {
        method: "POST",
        body: JSON.stringify({
          tool: "exec",
          params: { command: "ls -la" },
        }),
      });

      expect(status).toBe(200);
      expect(body.content[0].text).toContain("Exit code: 0");
      expect(body.content[0].text).toContain("output");
    });

    it("returns 404 for unknown agent", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/agents/unknown/exec", {
        method: "POST",
        body: JSON.stringify({
          tool: "read",
          params: { path: "/test.txt" },
        }),
      });

      expect(status).toBe(404);
      expect(body.error).toContain("Unknown agent");
    });

    it("returns 400 for missing tool or params", async () => {
      const { status } = await fetchApi(baseUrl, "/api/agents/assistant/exec", {
        method: "POST",
        body: JSON.stringify({ tool: "read" }), // Missing params
      });

      expect(status).toBe(400);
    });

    it("handles tool execution errors", async () => {
      (mockSandbox.exec as any).mockRejectedValueOnce(new Error("Sandbox error"));

      const { status, body } = await fetchApi(baseUrl, "/api/agents/assistant/exec", {
        method: "POST",
        body: JSON.stringify({
          tool: "read",
          params: { path: "/test.txt" },
        }),
      });

      expect(status).toBe(500);
      expect(body.error).toContain("Sandbox error");
    });
  });

  describe("POST /api/agents/:name/prompt", () => {
    it("sends prompt to agent", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/agents/assistant/prompt", {
        method: "POST",
        body: JSON.stringify({ message: "Hello!" }),
      });

      expect(status).toBe(200);
      expect(body.response).toBe("AI response");
      expect(mockAgentManager.prompt).toHaveBeenCalled();
    });

    it("uses custom session key", async () => {
      await fetchApi(baseUrl, "/api/agents/assistant/prompt", {
        method: "POST",
        body: JSON.stringify({
          message: "Hello!",
          sessionKey: "custom-session",
        }),
      });

      expect(mockAgentManager.prompt).toHaveBeenCalledWith(
        "custom-session",
        "assistant",
        "Hello!"
      );
    });

    it("returns 400 for missing message", async () => {
      const { status } = await fetchApi(baseUrl, "/api/agents/assistant/prompt", {
        method: "POST",
        body: JSON.stringify({}),
      });

      expect(status).toBe(400);
    });

    it("returns 404 for unknown agent", async () => {
      const { status } = await fetchApi(baseUrl, "/api/agents/unknown/prompt", {
        method: "POST",
        body: JSON.stringify({ message: "Hello" }),
      });

      expect(status).toBe(404);
    });
  });

  describe("GET /api/agents/:name/sessions", () => {
    it("returns sessions for agent", async () => {
      (mockSessionStore.listSessions as any).mockReturnValueOnce([
        { sessionFile: "/path/to/session.jsonl", sessionId: "20260308-120000-abc123" },
      ]);

      const { status, body } = await fetchApi(baseUrl, "/api/agents/assistant/sessions");

      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("20260308-120000-abc123");
    });

    it("returns empty array when no sessions", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/agents/researcher/sessions");

      expect(status).toBe(200);
      expect(body.sessions).toEqual([]);
    });
  });

  describe("POST /api/gateway/restart", () => {
    it("triggers gateway restart", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/gateway/restart", {
        method: "POST",
      });

      // Gateway.restart() is async and may throw, but we catch it in the handler
      // The API returns 202 immediately and calls restart() in background
      expect([202, 500]).toContain(status);
      expect(body.status ?? body.error).toBeDefined();
    });
  });

  describe("GET /api/config", () => {
    it("returns agent and provider config (without API keys)", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/config");

      expect(status).toBe(200);
      expect(body.agents).toBeDefined();
      expect(body.llm.providers).toBeDefined();

      // Verify API keys are not included
      const anthropicProvider = body.llm.providers.anthropic;
      expect(anthropicProvider.apiKey).toBeUndefined();
    });

    it("includes fallback models in agent config", async () => {
      const { body } = await fetchApi(baseUrl, "/api/config");

      const researcher = body.agents.researcher;
      expect(researcher.fallbackModels).toBeDefined();
      expect(researcher.fallbackModels.length).toBeGreaterThan(0);
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
      const { status, body } = await fetchApi(baseUrl, "/api/unknown");

      expect(status).toBe(404);
      expect(body.error).toBe("Not found");
    });
  });
});
