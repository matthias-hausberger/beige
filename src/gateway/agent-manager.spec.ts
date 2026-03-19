import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readWorkspaceAgentsMd } from "./agent-manager.js";

describe("readWorkspaceAgentsMd", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `beige-agents-md-test-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("reads AGENTS.md when it exists", () => {
    const content = "# My Agent\n\nSome instructions.";
    writeFileSync(join(workspaceDir, "AGENTS.md"), content);

    const result = readWorkspaceAgentsMd(workspaceDir);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/workspace/AGENTS.md");
    expect(result[0].content).toBe(content);
  });

  it("returns empty array when AGENTS.md does not exist", () => {
    const result = readWorkspaceAgentsMd(workspaceDir);
    expect(result).toEqual([]);
  });

  it("returns empty array when workspace dir does not exist", () => {
    const result = readWorkspaceAgentsMd(join(workspaceDir, "nonexistent"));
    expect(result).toEqual([]);
  });
});
