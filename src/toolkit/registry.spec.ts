import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import {
  loadRegistry,
  saveRegistry,
  getInstalledToolkit,
  listInstalledToolkits,
  registerToolkit,
  unregisterToolkit,
  getToolkitInstallPath,
  sourceToString,
  getAllToolNames,
  findToolkitForTool,
  deleteToolkitFiles,
} from "./registry.js";
import { TOOLKIT_REGISTRY_VERSION, type ToolkitRegistry } from "./schema.js";

const BEIGE_DIR = resolve(homedir(), ".beige");
const REGISTRY_PATH = join(BEIGE_DIR, "toolkit-registry.json");
const TOOLKITS_DIR = join(BEIGE_DIR, "toolkits");

function createTestRegistry(data: Partial<ToolkitRegistry> = {}): ToolkitRegistry {
  return {
    version: TOOLKIT_REGISTRY_VERSION,
    toolkits: {},
    ...data,
  };
}

describe("toolkit/registry", () => {
  let originalRegistry: string | null = null;

  beforeEach(() => {
    if (existsSync(REGISTRY_PATH)) {
      originalRegistry = readFileSync(REGISTRY_PATH, "utf-8");
    } else {
      originalRegistry = null;
    }
    
    if (!existsSync(BEIGE_DIR)) {
      mkdirSync(BEIGE_DIR, { recursive: true });
    }
    if (!existsSync(TOOLKITS_DIR)) {
      mkdirSync(TOOLKITS_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (originalRegistry !== null) {
      writeFileSync(REGISTRY_PATH, originalRegistry, "utf-8");
    } else if (existsSync(REGISTRY_PATH)) {
      rmSync(REGISTRY_PATH, { force: true });
    }
  });

  describe("loadRegistry", () => {
    it("returns empty registry when file does not exist", () => {
      const registry = loadRegistry();
      expect(registry.version).toBe(TOOLKIT_REGISTRY_VERSION);
      expect(registry.toolkits).toEqual({});
    });

    it("loads an existing registry", () => {
      const data = createTestRegistry({
        toolkits: {
          "test-toolkit": {
            name: "test-toolkit",
            source: { type: "npm", package: "test-toolkit" },
            version: "1.0.0",
            installedAt: "2024-01-01T00:00:00Z",
            path: "/path/to/toolkit",
            tools: ["tool1", "tool2"],
          },
        },
      });
      writeFileSync(REGISTRY_PATH, JSON.stringify(data));

      const registry = loadRegistry();
      expect(registry.toolkits["test-toolkit"]).toBeDefined();
      expect(registry.toolkits["test-toolkit"].version).toBe("1.0.0");
    });

    it("handles corrupted registry file", () => {
      writeFileSync(REGISTRY_PATH, "not json");
      const registry = loadRegistry();
      expect(registry.toolkits).toEqual({});
    });
  });

  describe("saveRegistry and loadRegistry round-trip", () => {
    it("persists and loads registry correctly", () => {
      const registry = createTestRegistry();
      registry.toolkits["saved-toolkit"] = {
        name: "saved-toolkit",
        source: { type: "github", owner: "user", repo: "repo" },
        version: "2.0.0",
        installedAt: "2024-06-01T00:00:00Z",
        path: "/saved/path",
        tools: ["saved-tool"],
      };

      saveRegistry(registry);

      const loaded = loadRegistry();
      expect(loaded.toolkits["saved-toolkit"]).toEqual(
        registry.toolkits["saved-toolkit"]
      );
    });
  });

  describe("registerToolkit", () => {
    it("registers a new toolkit", () => {
      const installed = registerToolkit(
        "new-toolkit",
        { type: "npm", package: "new-toolkit" },
        "1.0.0",
        "/path/to/new-toolkit",
        ["tool-a", "tool-b"]
      );

      expect(installed.name).toBe("new-toolkit");
      expect(installed.version).toBe("1.0.0");
      expect(installed.tools).toEqual(["tool-a", "tool-b"]);
      expect(installed.installedAt).toBeDefined();

      const registry = loadRegistry();
      expect(registry.toolkits["new-toolkit"]).toBeDefined();
    });

    it("updates an existing toolkit", () => {
      registerToolkit(
        "update-test",
        { type: "npm", package: "update-test" },
        "1.0.0",
        "/path/v1",
        ["tool1"]
      );

      registerToolkit(
        "update-test",
        { type: "npm", package: "update-test" },
        "2.0.0",
        "/path/v2",
        ["tool1", "tool2"]
      );

      const toolkit = getInstalledToolkit("update-test");
      expect(toolkit?.version).toBe("2.0.0");
      expect(toolkit?.tools).toEqual(["tool1", "tool2"]);
    });
  });

  describe("unregisterToolkit", () => {
    it("removes a toolkit from registry", () => {
      registerToolkit(
        "to-remove",
        { type: "npm", package: "to-remove" },
        "1.0.0",
        "/path",
        ["tool"]
      );

      expect(getInstalledToolkit("to-remove")).toBeDefined();

      const result = unregisterToolkit("to-remove");
      expect(result).toBe(true);
      expect(getInstalledToolkit("to-remove")).toBeUndefined();
    });

    it("returns false if toolkit not found", () => {
      const result = unregisterToolkit("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("listInstalledToolkits", () => {
    it("returns empty array when no toolkits installed", () => {
      expect(listInstalledToolkits()).toEqual([]);
    });

    it("returns all installed toolkits", () => {
      registerToolkit("tk1", { type: "npm", package: "tk1" }, "1.0.0", "/p1", []);
      registerToolkit("tk2", { type: "npm", package: "tk2" }, "2.0.0", "/p2", []);

      const list = listInstalledToolkits();
      expect(list).toHaveLength(2);
      expect(list.map((t) => t.name).sort()).toEqual(["tk1", "tk2"]);
    });
  });

  describe("getAllToolNames", () => {
    it("returns empty set when no toolkits", () => {
      expect(getAllToolNames().size).toBe(0);
    });

    it("collects all tool names from all toolkits", () => {
      registerToolkit("tk1", { type: "npm", package: "tk1" }, "1.0.0", "/p1", ["a", "b"]);
      registerToolkit("tk2", { type: "npm", package: "tk2" }, "1.0.0", "/p2", ["c", "d"]);

      const names = getAllToolNames();
      expect(names).toEqual(new Set(["a", "b", "c", "d"]));
    });
  });

  describe("findToolkitForTool", () => {
    it("finds the toolkit that owns a tool", () => {
      registerToolkit("owner1", { type: "npm", package: "o1" }, "1.0.0", "/p1", ["tool-x"]);
      registerToolkit("owner2", { type: "npm", package: "o2" }, "1.0.0", "/p2", ["tool-y"]);

      expect(findToolkitForTool("tool-x")).toBe("owner1");
      expect(findToolkitForTool("tool-y")).toBe("owner2");
    });

    it("returns undefined for unknown tool", () => {
      expect(findToolkitForTool("unknown")).toBeUndefined();
    });
  });

  describe("sourceToString", () => {
    it("formats npm source", () => {
      expect(sourceToString({ type: "npm", package: "my-toolkit" })).toBe("my-toolkit");
    });

    it("formats github source without ref", () => {
      expect(
        sourceToString({ type: "github", owner: "user", repo: "repo" })
      ).toBe("github:user/repo");
    });

    it("formats github source with ref", () => {
      expect(
        sourceToString({ type: "github", owner: "user", repo: "repo", ref: "v1.0.0" })
      ).toBe("github:user/repo#v1.0.0");
    });

    it("formats local source", () => {
      expect(sourceToString({ type: "local", path: "./toolkit" })).toBe("./toolkit");
    });

    it("formats url source", () => {
      expect(
        sourceToString({ type: "url", url: "https://example.com/tk.tar.gz" })
      ).toBe("https://example.com/tk.tar.gz");
    });
  });

  describe("getToolkitInstallPath", () => {
    it("returns path for simple names", () => {
      const path = getToolkitInstallPath("simple-name");
      expect(path).toContain("toolkits");
      expect(path).toContain("simple-name");
    });

    it("normalizes scoped names", () => {
      const path = getToolkitInstallPath("@scope/name");
      expect(path).toContain("scope-name");
    });
  });

  describe("deleteToolkitFiles", () => {
    it("removes toolkit directory", () => {
      const toolkitPath = join(TOOLKITS_DIR, "to-delete");
      mkdirSync(toolkitPath, { recursive: true });
      writeFileSync(join(toolkitPath, "toolkit.json"), "{}");

      expect(existsSync(toolkitPath)).toBe(true);

      deleteToolkitFiles("to-delete");

      expect(existsSync(toolkitPath)).toBe(false);
    });

    it("handles missing directory gracefully", () => {
      expect(() => deleteToolkitFiles("nonexistent")).not.toThrow();
    });
  });
});
