import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuditLogger, AuditTimer } from "./audit.js";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("AuditLogger", () => {
  let tempDir: string;
  let logPath: string;
  let logger: AuditLogger;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-audit-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    logPath = join(tempDir, "audit.jsonl");
    logger = new AuditLogger(logPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("log", () => {
    it("writes JSONL entry to file", () => {
      logger.log({
        ts: "2026-03-08T00:00:00.000Z",
        agent: "assistant",
        phase: "finished",
        type: "core_tool",
        tool: "exec",
        args: ["ls"],
        decision: "allowed",
        exitCode: 0,
        outputBytes: 100,
      });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).tool).toBe("exec");
    });

    it("appends multiple entries", () => {
      logger.log({
        ts: "2026-03-08T00:00:00.000Z",
        agent: "assistant",
        phase: "finished",
        type: "core_tool",
        tool: "read",
        args: ["/test.txt"],
        decision: "allowed",
      });

      logger.log({
        ts: "2026-03-08T00:00:01.000Z",
        agent: "assistant",
        phase: "finished",
        type: "core_tool",
        tool: "write",
        args: ["/test.txt"],
        decision: "allowed",
      });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);
    });

    it("includes all required fields", () => {
      logger.log({
        ts: "2026-03-08T00:00:00.000Z",
        agent: "assistant",
        phase: "finished",
        type: "core_tool",
        tool: "exec",
        args: ["ls", "-la"],
        decision: "allowed",
        durationMs: 123,
        exitCode: 0,
        outputBytes: 500,
      });

      const content = readFileSync(logPath, "utf-8");
      const entry = JSON.parse(content);

      expect(entry.ts).toBe("2026-03-08T00:00:00.000Z");
      expect(entry.agent).toBe("assistant");
      expect(entry.phase).toBe("finished");
      expect(entry.type).toBe("core_tool");
      expect(entry.tool).toBe("exec");
      expect(entry.args).toEqual(["ls", "-la"]);
      expect(entry.decision).toBe("allowed");
      expect(entry.durationMs).toBe(123);
      expect(entry.exitCode).toBe(0);
      expect(entry.outputBytes).toBe(500);
    });

    it("logs denied decisions", () => {
      logger.log({
        ts: "2026-03-08T00:00:00.000Z",
        agent: "assistant",
        phase: "finished",
        type: "tool",
        tool: "git",
        args: ["set", "key", "value"],
        decision: "denied",
        error: "Permission denied",
      });

      const content = readFileSync(logPath, "utf-8");
      const entry = JSON.parse(content);

      expect(entry.decision).toBe("denied");
      expect(entry.error).toBe("Permission denied");
    });

    it("logs with target field for tool calls", () => {
      logger.log({
        ts: "2026-03-08T00:00:00.000Z",
        agent: "assistant",
        phase: "finished",
        type: "tool",
        tool: "git",
        args: ["get", "key"],
        decision: "allowed",
        target: "gateway",
      });

      const content = readFileSync(logPath, "utf-8");
      const entry = JSON.parse(content);

      expect(entry.target).toBe("gateway");
    });
  });

  describe("start/finish pattern", () => {
    it("creates a timer for allowed decisions", () => {
      const timer = logger.start(
        "assistant",
        "core_tool",
        "exec",
        ["ls"],
        "allowed"
      );

      expect(timer).toBeInstanceOf(AuditTimer);
    });

    it("logs immediately for denied decisions", () => {
      logger.start(
        "assistant",
        "tool",
        "git",
        ["set", "key"],
        "denied"
      );

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      // Denied decisions log immediately as "finished"
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.phase).toBe("finished");
      expect(entry.decision).toBe("denied");
    });

    it("logs 'started' phase for allowed decisions", () => {
      logger.start(
        "assistant",
        "core_tool",
        "exec",
        ["ls"],
        "allowed"
      );

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.phase).toBe("started");
    });

    it("logs 'finished' phase when timer.finish() is called", () => {
      const timer = logger.start(
        "assistant",
        "core_tool",
        "exec",
        ["ls"],
        "allowed"
      );

      timer.finish({ exitCode: 0, outputBytes: 100 });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);

      const startedEntry = JSON.parse(lines[0]);
      const finishedEntry = JSON.parse(lines[1]);

      expect(startedEntry.phase).toBe("started");
      expect(finishedEntry.phase).toBe("finished");
    });

    it("tracks duration between start and finish", async () => {
      const timer = logger.start(
        "assistant",
        "core_tool",
        "exec",
        ["ls"],
        "allowed"
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      timer.finish({ exitCode: 0 });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      const finishedEntry = JSON.parse(lines[1]);

      expect(finishedEntry.durationMs).toBeGreaterThanOrEqual(40);
    });

    it("finish() does nothing for denied decisions", () => {
      const timer = logger.start(
        "assistant",
        "tool",
        "git",
        ["get"],
        "denied"
      );

      timer.finish({ exitCode: 1, error: "Denied" });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      // Only one line (the immediate "finished" log)
      expect(lines.length).toBe(1);
    });

    it("includes error in finish result", () => {
      const timer = logger.start(
        "assistant",
        "core_tool",
        "exec",
        ["fail"],
        "allowed"
      );

      timer.finish({ exitCode: 1, error: "Command failed" });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      const finishedEntry = JSON.parse(lines[1]);

      expect(finishedEntry.error).toBe("Command failed");
    });
  });

  describe("concurrent writes", () => {
    it("handles multiple concurrent log calls", async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(
          logger.log({
            ts: new Date().toISOString(),
            agent: "assistant",
            phase: "finished",
            type: "core_tool",
            tool: "exec",
            args: [`cmd${i}`],
            decision: "allowed",
          })
        )
      );

      await Promise.all(promises);

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(10);
    });
  });

  describe("directory creation", () => {
    it("creates parent directories if they don't exist", () => {
      const nestedPath = join(tempDir, "deeply", "nested", "audit.jsonl");
      const nestedLogger = new AuditLogger(nestedPath);

      nestedLogger.log({
        ts: "2026-03-08T00:00:00.000Z",
        agent: "assistant",
        phase: "finished",
        type: "core_tool",
        tool: "exec",
        args: [],
        decision: "allowed",
      });

      expect(existsSync(nestedPath)).toBe(true);
    });
  });
});
