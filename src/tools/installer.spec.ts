import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSource,
  discoverTools,
  installTools,
  removeTool,
  listInstalledTools,
  readMetaFile,
} from "./installer.js";

describe("parseSource", () => {
  it("parses npm source without version", () => {
    const result = parseSource("npm:my-package");
    expect(result).toEqual({ type: "npm", package: "my-package" });
  });

  it("parses npm source with version", () => {
    const result = parseSource("npm:my-package@1.2.3");
    expect(result).toEqual({ type: "npm", package: "my-package", version: "1.2.3" });
  });

  it("parses scoped npm source without version", () => {
    const result = parseSource("npm:@scope/package");
    expect(result).toEqual({ type: "npm", package: "@scope/package" });
  });

  it("parses scoped npm source with version", () => {
    const result = parseSource("npm:@scope/package@1.2.3-beta.1");
    expect(result).toEqual({ type: "npm", package: "@scope/package", version: "1.2.3-beta.1" });
  });

  it("parses github source (owner/repo)", () => {
    const result = parseSource("github:owner/repo");
    expect(result).toEqual({ type: "github", owner: "owner", repo: "repo" });
  });

  it("parses github source with subfolder", () => {
    const result = parseSource("github:owner/repo/tools/github");
    expect(result).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo",
      path: "tools/github",
    });
  });

  it("parses github source with ref", () => {
    const result = parseSource("github:owner/repo#v1.0.0");
    expect(result).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo",
      ref: "v1.0.0",
    });
  });

  it("parses github source with subfolder and ref", () => {
    const result = parseSource("github:owner/repo/tools/chrome#main");
    expect(result).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo",
      path: "tools/chrome",
      ref: "main",
    });
  });

  it("parses local path (relative)", () => {
    const result = parseSource("./my-tool");
    expect(result.type).toBe("local");
    expect((result as any).path).toContain("my-tool");
  });

  it("parses local path (absolute)", () => {
    const result = parseSource("/absolute/path/to/tool");
    expect(result).toEqual({ type: "local", path: "/absolute/path/to/tool" });
  });

  it("defaults to npm for unrecognized source", () => {
    const result = parseSource("some-package");
    expect(result).toEqual({ type: "npm", package: "some-package" });
  });

  it("throws for invalid github source", () => {
    expect(() => parseSource("github:onlyone")).toThrow("Expected format");
  });
});

describe("discoverTools", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-discover-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createToolDir(relPath: string, name: string, target: string = "gateway"): void {
    const dir = join(tempDir, relPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tool.json"),
      JSON.stringify({ name, description: `Test ${name}`, target })
    );
    writeFileSync(join(dir, "index.ts"), `export function createHandler() { return async () => ({ output: "ok", exitCode: 0 }); }`);
  }

  it("discovers a single tool at root", () => {
    createToolDir("", "my-tool");
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("my-tool");
  });

  it("discovers multiple tools in subdirectories", () => {
    createToolDir("tools/github", "github");
    createToolDir("tools/chrome", "chrome");
    createToolDir("tools/slack", "slack");
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["chrome", "github", "slack"]);
  });

  it("skips node_modules", () => {
    createToolDir("node_modules/some-dep", "hidden");
    createToolDir("tools/visible", "visible");
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("visible");
  });

  it("skips __tests__ and test directories", () => {
    createToolDir("__tests__/mock-tool", "mock");
    createToolDir("tests/fixture-tool", "fixture");
    createToolDir("tools/real", "real");
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("real");
  });

  it("does not recurse into tool directories", () => {
    // Create a tool at tools/chrome which also has a subfolder with another tool.json
    createToolDir("tools/chrome", "chrome");
    const nestedDir = join(tempDir, "tools/chrome/sub");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(nestedDir, "tool.json"),
      JSON.stringify({ name: "nested", description: "Should not be found", target: "gateway" })
    );
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("chrome");
  });

  it("warns on duplicate tool names", () => {
    createToolDir("a/tool-a", "dupe");
    createToolDir("b/tool-b", "dupe");
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(1);
  });

  it("returns empty for directory with no tools", () => {
    mkdirSync(join(tempDir, "empty"), { recursive: true });
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(0);
  });

  it("skips invalid tool.json files", () => {
    const dir = join(tempDir, "bad-tool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool.json"), "not json");
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(0);
  });

  it("skips tool.json without name or target", () => {
    const dir = join(tempDir, "incomplete");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool.json"), JSON.stringify({ description: "no name" }));
    const tools = discoverTools(tempDir);
    expect(tools).toHaveLength(0);
  });
});

describe("installTools (local)", () => {
  let tempDir: string;
  let beigeHome: string;
  let originalBeigeHome: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-install-test-${Date.now()}`);
    beigeHome = join(tempDir, "beige-home");
    mkdirSync(beigeHome, { recursive: true });
    originalBeigeHome = process.env.BEIGE_HOME;
    process.env.BEIGE_HOME = beigeHome;
  });

  afterEach(() => {
    if (originalBeigeHome !== undefined) {
      process.env.BEIGE_HOME = originalBeigeHome;
    } else {
      delete process.env.BEIGE_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createLocalTool(name: string, dir?: string): string {
    const toolDir = dir ?? join(tempDir, `source-${name}`);
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      join(toolDir, "tool.json"),
      JSON.stringify({ name, description: `Tool ${name}`, target: "gateway" })
    );
    writeFileSync(
      join(toolDir, "index.ts"),
      `export function createHandler() { return async () => ({ output: "ok", exitCode: 0 }); }`
    );
    return toolDir;
  }

  function createLocalMultiToolRepo(): string {
    const repoDir = join(tempDir, "multi-repo");
    mkdirSync(repoDir, { recursive: true });
    createLocalTool("tool-a", join(repoDir, "tools/tool-a"));
    createLocalTool("tool-b", join(repoDir, "tools/tool-b"));
    return repoDir;
  }

  it("installs a single local tool", async () => {
    const toolDir = createLocalTool("my-tool");
    const result = await installTools(toolDir);

    expect(result.success).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].name).toBe("my-tool");

    // Verify it's on disk
    const installed = join(beigeHome, "tools", "my-tool", "tool.json");
    expect(existsSync(installed)).toBe(true);

    // Verify meta file
    const meta = readMetaFile("my-tool");
    expect(meta).not.toBeNull();
    expect(meta!.source).toBe(toolDir);
    expect(meta!.package).toBeUndefined();
  });

  it("installs multi-tool local repo with symlinks", async () => {
    const repoDir = createLocalMultiToolRepo();
    const result = await installTools(repoDir);

    expect(result.success).toBe(true);
    expect(result.tools).toHaveLength(2);

    const names = result.tools!.map((t) => t.name).sort();
    expect(names).toEqual(["tool-a", "tool-b"]);

    // Verify both tools are accessible
    expect(existsSync(join(beigeHome, "tools", "tool-a", "tool.json"))).toBe(true);
    expect(existsSync(join(beigeHome, "tools", "tool-b", "tool.json"))).toBe(true);

    // Verify package directory exists
    expect(existsSync(join(beigeHome, "packages"))).toBe(true);

    // Verify meta files reference the package
    const metaA = readMetaFile("tool-a");
    expect(metaA?.package).toBeDefined();
    const metaB = readMetaFile("tool-b");
    expect(metaB?.package).toBe(metaA?.package);
  });

  it("detects conflicts on re-install without force", async () => {
    const toolDir = createLocalTool("conflict-tool");
    await installTools(toolDir);

    // Second install should fail
    const result = await installTools(toolDir);
    expect(result.success).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts![0]).toContain("conflict-tool");
  });

  it("allows re-install with force", async () => {
    const toolDir = createLocalTool("force-tool");
    await installTools(toolDir);

    const result = await installTools(toolDir, { force: true });
    expect(result.success).toBe(true);
  });

  it("lists installed tools", async () => {
    const toolDir = createLocalTool("list-tool");
    await installTools(toolDir);

    const tools = listInstalledTools();
    const found = tools.find((t) => t.name === "list-tool");
    expect(found).toBeDefined();
    expect(found!.manifest.description).toBe("Tool list-tool");
  });

  it("removes a standalone tool", async () => {
    const toolDir = createLocalTool("remove-me");
    await installTools(toolDir);

    expect(existsSync(join(beigeHome, "tools", "remove-me"))).toBe(true);

    const result = removeTool("remove-me");
    expect(result.success).toBe(true);

    expect(existsSync(join(beigeHome, "tools", "remove-me"))).toBe(false);
    expect(readMetaFile("remove-me")).toBeNull();
  });

  it("removes a tool from a multi-tool package and cleans up when last", async () => {
    const repoDir = createLocalMultiToolRepo();
    await installTools(repoDir);

    const metaA = readMetaFile("tool-a");
    const packageDir = join(beigeHome, "packages", metaA!.package!);
    expect(existsSync(packageDir)).toBe(true);

    // Remove first tool — package should still exist
    removeTool("tool-a");
    expect(existsSync(packageDir)).toBe(true);

    // Remove second tool — package should be cleaned up
    removeTool("tool-b");
    expect(existsSync(packageDir)).toBe(false);
  });

  it("returns error when removing non-existent tool", () => {
    const result = removeTool("nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });

  it("returns error for empty directory (no tools)", async () => {
    const emptyDir = join(tempDir, "empty");
    mkdirSync(emptyDir, { recursive: true });

    const result = await installTools(emptyDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No tools found");
  });

  it("returns error for non-existent local path", async () => {
    const result = await installTools("/nonexistent/path");
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
  });
});
