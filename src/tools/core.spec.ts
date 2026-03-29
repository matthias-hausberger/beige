import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCoreTools, type ToolStartHandlerRef } from "./core.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { AuditLogger } from "../gateway/audit.js";
import type { SessionContext } from "../types/session.js";

// Mock types
type MockSandbox = {
  exec: ReturnType<typeof vi.fn>;
};

type MockAudit = {
  start: ReturnType<typeof vi.fn>;
};

describe("createCoreTools", () => {
  let mockSandbox: MockSandbox;
  let mockAudit: MockAudit;
  let mockAuditTimer: { finish: ReturnType<typeof vi.fn> };
  let tools: ReturnType<typeof createCoreTools>;
  let handlerRef: ToolStartHandlerRef;

  beforeEach(() => {
    mockAuditTimer = {
      finish: vi.fn(),
    };

    mockSandbox = {
      exec: vi.fn(),
    };

    mockAudit = {
      start: vi.fn().mockReturnValue(mockAuditTimer),
    };

    handlerRef = { fn: undefined };

    tools = createCoreTools(
      "test-agent",
      mockSandbox as unknown as SandboxManager,
      mockAudit as unknown as AuditLogger,
      handlerRef,
      undefined
    );
  });

  // Helper to find a tool by name
  const getTool = (name: string) => tools.find((t) => t.name === name)!;

  describe("tool definitions", () => {
    it("creates 4 tools", () => {
      expect(tools.length).toBe(4);
      expect(tools.map((t) => t.name)).toEqual(["read", "write", "patch", "exec"]);
    });

    it("each tool has name, label, description, and parameters", () => {
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.label).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toBeDefined();
      }
    });
  });

  describe("read tool", () => {
    it("returns file contents on success", async () => {
      mockSandbox.exec.mockResolvedValue({
        stdout: "file contents here",
        stderr: "",
        exitCode: 0,
      });

      const result = await getTool("read").execute("id-1", { path: "/workspace/test.txt" });

      expect(result.isError).toBeUndefined();
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "file contents here",
      });
    });

    it("returns error on failure", async () => {
      mockSandbox.exec.mockResolvedValue({
        stdout: "",
        stderr: "No such file or directory",
        exitCode: 1,
      });

      const result = await getTool("read").execute("id-2", { path: "/nonexistent.txt" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No such file or directory");
    });

    it("uses cat for simple reads", async () => {
      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await getTool("read").execute("id-3", { path: "/test.txt" });

      expect(mockSandbox.exec).toHaveBeenCalledWith("test-agent", ["cat", "/test.txt"]);
    });

    it("uses sed for offset/limit reads", async () => {
      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await getTool("read").execute("id-4", { path: "/test.txt", offset: 10, limit: 5 });

      expect(mockSandbox.exec).toHaveBeenCalledWith("test-agent", [
        "sed",
        "-n",
        "10,14p",
        "/test.txt",
      ]);
    });

    it("uses sed with only offset", async () => {
      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await getTool("read").execute("id-5", { path: "/test.txt", offset: 20 });

      expect(mockSandbox.exec).toHaveBeenCalledWith("test-agent", [
        "sed",
        "-n",
        "20,$p",
        "/test.txt",
      ]);
    });

    it("logs to audit", async () => {
      mockSandbox.exec.mockResolvedValue({ stdout: "content", stderr: "", exitCode: 0 });

      await getTool("read").execute("id-6", { path: "/test.txt" });

      expect(mockAudit.start).toHaveBeenCalledWith(
        "test-agent",
        "core_tool",
        "read",
        ["/test.txt"],
        "allowed",
        undefined,
        { session: undefined, channel: undefined, model: undefined }
      );
      expect(mockAuditTimer.finish).toHaveBeenCalled();
    });

    it("calls onToolStart handler", async () => {
      const onToolStart = vi.fn();
      handlerRef.fn = onToolStart;

      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await getTool("read").execute("id-7", { path: "/test.txt" });

      expect(onToolStart).toHaveBeenCalledWith("read", { path: "/test.txt" });
    });
  });

  describe("write tool", () => {
    it("writes content to file", async () => {
      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      const result = await getTool("write").execute("id-1", {
        path: "/workspace/output.txt",
        content: "Hello, world!",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Successfully wrote");
    });

    it("creates parent directories", async () => {
      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await getTool("write").execute("id-2", {
        path: "/workspace/sub/dir/file.txt",
        content: "test",
      });

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        "test-agent",
        ["sh", "-c", expect.stringContaining("mkdir -p")],
        "test"
      );
    });

    it("returns bytes written", async () => {
      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      const result = await getTool("write").execute("id-3", {
        path: "/test.txt",
        content: "1234567890", // 10 bytes
      });

      expect(result.content[0].text).toContain("10 bytes");
    });

    it("handles write errors", async () => {
      mockSandbox.exec.mockResolvedValue({
        stdout: "",
        stderr: "Permission denied",
        exitCode: 1,
      });

      const result = await getTool("write").execute("id-4", {
        path: "/readonly.txt",
        content: "test",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Permission denied");
    });

    it("calls onToolStart handler with bytes", async () => {
      const onToolStart = vi.fn();
      handlerRef.fn = onToolStart;

      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await getTool("write").execute("id-5", {
        path: "/test.txt",
        content: "test content",
      });

      expect(onToolStart).toHaveBeenCalledWith("write", {
        path: "/test.txt",
        bytes: 12, // "test content".length
      });
    });
  });

  describe("patch tool", () => {
    it("patches file when oldText found", async () => {
      mockSandbox.exec
        .mockResolvedValueOnce({
          stdout: "Hello world",
          stderr: "",
          exitCode: 0,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          exitCode: 0,
        });

      const result = await getTool("patch").execute("id-1", {
        path: "/test.txt",
        oldText: "world",
        newText: "Beige",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Successfully patched");
    });

    it("errors when oldText not found", async () => {
      mockSandbox.exec.mockResolvedValueOnce({
        stdout: "Hello world",
        stderr: "",
        exitCode: 0,
      });

      const result = await getTool("patch").execute("id-2", {
        path: "/test.txt",
        oldText: "nonexistent",
        newText: "replacement",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("errors when file not found", async () => {
      mockSandbox.exec.mockResolvedValueOnce({
        stdout: "",
        stderr: "No such file",
        exitCode: 1,
      });

      const result = await getTool("patch").execute("id-3", {
        path: "/nonexistent.txt",
        oldText: "old",
        newText: "new",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("only replaces first occurrence", async () => {
      mockSandbox.exec
        .mockResolvedValueOnce({
          stdout: "foo foo foo",
          stderr: "",
          exitCode: 0,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          exitCode: 0,
        });

      await getTool("patch").execute("id-4", {
        path: "/test.txt",
        oldText: "foo",
        newText: "bar",
      });

      // Verify the second call (write) received patched content
      const writeCall = mockSandbox.exec.mock.calls[1];
      expect(writeCall[2]).toBe("bar foo foo");
    });

    it("calls onToolStart handler", async () => {
      const onToolStart = vi.fn();
      handlerRef.fn = onToolStart;

      mockSandbox.exec.mockResolvedValue({ stdout: "content", stderr: "", exitCode: 0 });

      await getTool("patch").execute("id-5", {
        path: "/test.txt",
        oldText: "old",
        newText: "new",
      });

      expect(onToolStart).toHaveBeenCalledWith("patch", { path: "/test.txt" });
    });
  });

  describe("exec tool", () => {
    it("executes command via sh -c", async () => {
      mockSandbox.exec.mockResolvedValue({
        stdout: "file1\nfile2",
        stderr: "",
        exitCode: 0,
      });

      await getTool("exec").execute("id-1", { command: "ls -la" });

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        "test-agent",
        ["sh", "-c", "ls -la"],
        undefined,
        900_000,
        undefined
      );
    });

    it("returns exit code and output", async () => {
      mockSandbox.exec.mockResolvedValue({
        stdout: "stdout content",
        stderr: "stderr content",
        exitCode: 0,
      });

      const result = await getTool("exec").execute("id-2", { command: "echo test" });

      expect(result.content[0].text).toContain("Exit code: 0");
      expect(result.content[0].text).toContain("stdout content");
      expect(result.content[0].text).toContain("stderr content");
    });

    it("marks isError for non-zero exit", async () => {
      mockSandbox.exec.mockResolvedValue({
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
      });

      const result = await getTool("exec").execute("id-3", { command: "nonexistent" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Exit code: 127");
    });

    it("uses custom timeout", async () => {
      mockSandbox.exec.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      await getTool("exec").execute("id-4", { command: "long-task", timeout: 300 });

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        "test-agent",
        ["sh", "-c", "long-task"],
        undefined,
        300_000,
        undefined
      );
    });

    it("handles execution errors", async () => {
      mockSandbox.exec.mockRejectedValue(new Error("Execution failed"));

      const result = await getTool("exec").execute("id-5", { command: "fail" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Execution failed");
    });

    it("calls onToolStart handler with command", async () => {
      const onToolStart = vi.fn();
      handlerRef.fn = onToolStart;

      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await getTool("exec").execute("id-6", { command: "ls -la" });

      expect(onToolStart).toHaveBeenCalledWith("exec", { command: "ls -la" });
    });
  });

  describe("handlerRef", () => {
    it("works without handlerRef (uses internal no-op)", async () => {
      const toolsWithoutRef = createCoreTools(
        "test-agent",
        mockSandbox as unknown as SandboxManager,
        mockAudit as unknown as AuditLogger
        // No handlerRef
      );

      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      const readTool = toolsWithoutRef.find((t) => t.name === "read")!;
      const result = await readTool.execute("id-1", { path: "/test.txt" });

      expect(result.isError).toBeUndefined();
    });

    it("handler can be updated at runtime", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      handlerRef.fn = handler1;
      mockSandbox.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await getTool("read").execute("id-1", { path: "/test1.txt" });
      expect(handler1).toHaveBeenCalledTimes(1);

      // Switch handler
      handlerRef.fn = handler2;

      await getTool("read").execute("id-2", { path: "/test2.txt" });
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledTimes(1); // Not called again
    });
  });
});
