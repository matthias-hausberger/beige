import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import {
  validateToolkitManifest,
  loadToolkitManifest,
  validateToolkit,
  parseToolkitSource,
  normalizeToolkitName,
  type ToolkitManifest,
} from "./schema.js";

const TEMP_DIR = resolve(homedir(), ".beige", "temp-test-schema");

function createTempToolkit(structure: {
  toolkitJson: Partial<ToolkitManifest>;
  tools?: Record<string, { toolJson: Record<string, unknown>; indexTs?: string }>;
}): string {
  const toolkitDir = join(TEMP_DIR, `toolkit-${Date.now()}`);
  mkdirSync(toolkitDir, { recursive: true });

  const tools = structure.tools ?? {
    _dummy: { toolJson: { description: "Dummy tool for testing" } },
  };

  const toolsDir = join(toolkitDir, "tools");
  mkdirSync(toolsDir, { recursive: true });

  for (const [toolName, toolConfig] of Object.entries(tools)) {
    const toolDir = join(toolsDir, toolName);
    mkdirSync(toolDir, { recursive: true });

    writeFileSync(
      join(toolDir, "tool.json"),
      JSON.stringify({
        name: toolName,
        description: `Test tool: ${toolName}`,
        target: "gateway",
        ...toolConfig.toolJson,
      })
    );

    if (toolConfig.indexTs) {
      writeFileSync(join(toolDir, "index.ts"), toolConfig.indexTs);
    }
  }

  const manifest: ToolkitManifest = {
    name: "test-toolkit",
    version: "1.0.0",
    tools: Object.keys(tools).map((n) => `./tools/${n}`),
    ...structure.toolkitJson,
  };

  writeFileSync(
    join(toolkitDir, "toolkit.json"),
    JSON.stringify(manifest, null, 2)
  );

  return toolkitDir;
}

describe("toolkit/schema", () => {
  beforeEach(() => {
    if (existsSync(TEMP_DIR)) {
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEMP_DIR)) {
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  describe("validateToolkitManifest", () => {
    it("validates a correct manifest", () => {
      const manifest = validateToolkitManifest({
        name: "my-toolkit",
        version: "1.0.0",
        tools: ["./tools/tool1"],
      });

      expect(manifest.name).toBe("my-toolkit");
      expect(manifest.version).toBe("1.0.0");
      expect(manifest.tools).toEqual(["./tools/tool1"]);
    });

    it("throws when name is missing", () => {
      expect(() =>
        validateToolkitManifest({ version: "1.0.0", tools: [] })
      ).toThrow("'name' is required");
    });

    it("throws when version is missing", () => {
      expect(() =>
        validateToolkitManifest({ name: "test", tools: [] })
      ).toThrow("'version' is required");
    });

    it("throws when tools is missing", () => {
      expect(() =>
        validateToolkitManifest({ name: "test", version: "1.0.0" })
      ).toThrow("'tools' is required");
    });

    it("throws when tools is empty", () => {
      expect(() =>
        validateToolkitManifest({ name: "test", version: "1.0.0", tools: [] })
      ).toThrow("'tools' is required and must be a non-empty array");
    });

    it("accepts optional fields", () => {
      const manifest = validateToolkitManifest({
        name: "test",
        version: "1.0.0",
        tools: ["./tools/a"],
        description: "A toolkit",
        repository: "github:user/repo",
        author: "Author",
        license: "MIT",
      });

      expect(manifest.description).toBe("A toolkit");
      expect(manifest.repository).toBe("github:user/repo");
      expect(manifest.author).toBe("Author");
      expect(manifest.license).toBe("MIT");
    });
  });

  describe("loadToolkitManifest", () => {
    it("loads a valid toolkit.json", () => {
      const toolkitDir = createTempToolkit({
        toolkitJson: { name: "loaded-toolkit", version: "2.0.0" },
      });

      const manifest = loadToolkitManifest(toolkitDir);
      expect(manifest.name).toBe("loaded-toolkit");
      expect(manifest.version).toBe("2.0.0");
    });

    it("throws when toolkit.json is missing", () => {
      expect(() => loadToolkitManifest(TEMP_DIR)).toThrow(
        "Toolkit manifest not found"
      );
    });

    it("throws when toolkit.json is invalid JSON", () => {
      writeFileSync(join(TEMP_DIR, "toolkit.json"), "not json");
      expect(() => loadToolkitManifest(TEMP_DIR)).toThrow(
        "Failed to parse toolkit.json"
      );
    });
  });

  describe("validateToolkit", () => {
    it("validates a complete toolkit", () => {
      const toolkitDir = createTempToolkit({
        toolkitJson: { name: "complete", version: "1.0.0" },
        tools: {
          tool1: {
            toolJson: { description: "First tool" },
          },
          tool2: {
            toolJson: { description: "Second tool" },
          },
        },
      });

      const result = validateToolkit(toolkitDir);

      expect(result.manifest.name).toBe("complete");
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe("tool1");
      expect(result.tools[1].name).toBe("tool2");
    });

    it("throws when tool directory is missing", () => {
      const toolkitDir = createTempToolkit({
        toolkitJson: { name: "missing-tool", version: "1.0.0", tools: ["./tools/nonexistent"] },
      });

      expect(() => validateToolkit(toolkitDir)).toThrow("Tool manifest not found");
    });

    it("throws on duplicate tool names", () => {
      const toolkitDir = createTempToolkit({
        toolkitJson: { name: "dup-toolkit", version: "1.0.0" },
        tools: {
          tool1: { toolJson: { name: "same-name" } },
          tool2: { toolJson: { name: "same-name" } },
        },
      });

      expect(() => validateToolkit(toolkitDir)).toThrow("Duplicate tool name 'same-name'");
    });
  });

  describe("parseToolkitSource", () => {
    it("parses npm package names", () => {
      const source = parseToolkitSource("my-toolkit");
      expect(source.type).toBe("npm");
      if (source.type === "npm") {
        expect(source.package).toBe("my-toolkit");
      }
    });

    it("parses scoped npm packages", () => {
      const source = parseToolkitSource("@scope/toolkit-name");
      expect(source.type).toBe("npm");
      if (source.type === "npm") {
        expect(source.package).toBe("@scope/toolkit-name");
      }
    });

    it("parses github shorthand", () => {
      const source = parseToolkitSource("github:owner/repo");
      expect(source.type).toBe("github");
      if (source.type === "github") {
        expect(source.owner).toBe("owner");
        expect(source.repo).toBe("repo");
        expect(source.ref).toBeUndefined();
      }
    });

    it("parses github with ref", () => {
      const source = parseToolkitSource("github:owner/repo#v1.2.0");
      expect(source.type).toBe("github");
      if (source.type === "github") {
        expect(source.owner).toBe("owner");
        expect(source.repo).toBe("repo");
        expect(source.ref).toBe("v1.2.0");
      }
    });

    it("parses local paths", () => {
      expect(parseToolkitSource("./path/to/toolkit").type).toBe("local");
      expect(parseToolkitSource("../toolkit").type).toBe("local");
      expect(parseToolkitSource("/absolute/path").type).toBe("local");
    });

    it("parses URLs", () => {
      const source = parseToolkitSource("https://example.com/toolkit.tar.gz");
      expect(source.type).toBe("url");
      if (source.type === "url") {
        expect(source.url).toBe("https://example.com/toolkit.tar.gz");
      }
    });

    it("throws on invalid github format", () => {
      expect(() => parseToolkitSource("github:invalid")).toThrow(
        "Invalid GitHub source"
      );
    });
  });

  describe("normalizeToolkitName", () => {
    it("removes @ prefix", () => {
      expect(normalizeToolkitName("@scope/name")).toBe("scope-name");
    });

    it("replaces / with -", () => {
      expect(normalizeToolkitName("scope/name")).toBe("scope-name");
    });

    it("leaves simple names unchanged", () => {
      expect(normalizeToolkitName("simple")).toBe("simple");
    });
  });
});
