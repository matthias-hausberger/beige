import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadSkillManifest,
  loadSkills,
  buildSkillContext,
  validateSkillDeps,
  type LoadedSkill,
} from "./registry.js";
import type { BeigeConfig } from "../config/schema.js";

describe("skills/registry", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `beige-skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("loadSkillManifest", () => {
    it("loads a valid skill manifest", () => {
      const skillDir = join(tempDir, "test-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
        name: "test-skill",
        description: "A test skill",
      }));

      const manifest = loadSkillManifest(skillDir);
      expect(manifest.name).toBe("test-skill");
      expect(manifest.description).toBe("A test skill");
    });

    it("loads manifest with optional fields", () => {
      const skillDir = join(tempDir, "test-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
        name: "test-skill",
        description: "A test skill",
        contextFile: "GUIDE.md",
        requires: {
          tools: ["git"],
          skills: ["basics"],
        },
      }));

      const manifest = loadSkillManifest(skillDir);
      expect(manifest.contextFile).toBe("GUIDE.md");
      expect(manifest.requires?.tools).toEqual(["git"]);
      expect(manifest.requires?.skills).toEqual(["basics"]);
    });

    it("throws when skill.json is missing", () => {
      const skillDir = join(tempDir, "missing-manifest");
      mkdirSync(skillDir);

      expect(() => loadSkillManifest(skillDir)).toThrow("Skill manifest not found");
    });

    it("throws when skill.json has invalid JSON", () => {
      const skillDir = join(tempDir, "invalid-json");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.json"), "not valid json {");

      expect(() => loadSkillManifest(skillDir)).toThrow("Invalid JSON in skill manifest");
    });

    it("throws when name is missing", () => {
      const skillDir = join(tempDir, "missing-name");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
        description: "A test skill",
      }));

      expect(() => loadSkillManifest(skillDir)).toThrow("requires 'name' and 'description'");
    });

    it("throws when description is missing", () => {
      const skillDir = join(tempDir, "missing-desc");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
        name: "test-skill",
      }));

      expect(() => loadSkillManifest(skillDir)).toThrow("requires 'name' and 'description'");
    });
  });

  describe("loadSkills", () => {
    it("returns empty map when no skills in config", async () => {
      const config: BeigeConfig = {
        llm: { providers: {} },
        tools: {},
        agents: {},
        channels: {},
      };

      const skills = await loadSkills(config);
      expect(skills.size).toBe(0);
    });

    it("loads multiple skills from config", async () => {
      // Create skill directories
      const skill1Dir = join(tempDir, "skill1");
      const skill2Dir = join(tempDir, "skill2");
      mkdirSync(skill1Dir);
      mkdirSync(skill2Dir);

      writeFileSync(join(skill1Dir, "skill.json"), JSON.stringify({
        name: "skill1",
        description: "First skill",
      }));
      writeFileSync(join(skill2Dir, "skill.json"), JSON.stringify({
        name: "skill2",
        description: "Second skill",
        requires: { tools: ["git"] },
      }));

      const config: BeigeConfig = {
        llm: { providers: {} },
        tools: {},
        agents: {},
        channels: {},
        skills: {
          "my-skill1": { path: skill1Dir },
          "my-skill2": { path: skill2Dir },
        },
      };

      const skills = await loadSkills(config);
      expect(skills.size).toBe(2);
      expect(skills.get("my-skill1")?.manifest.description).toBe("First skill");
      expect(skills.get("my-skill2")?.manifest.requires?.tools).toEqual(["git"]);
    });
  });

  describe("buildSkillContext", () => {
    function createLoadedSkill(name: string, description: string): LoadedSkill {
      return {
        name,
        path: `/skills/${name}`,
        manifest: {
          name,
          description,
        },
      };
    }

    it("returns empty string for empty skill list", () => {
      const context = buildSkillContext([], new Map());
      expect(context).toBe("");
    });

    it("builds context for single skill", () => {
      const skills = new Map([
        ["review", createLoadedSkill("review", "Code review guidelines")],
      ]);

      const context = buildSkillContext(["review"], skills);
      expect(context).toContain("## Available Skills");
      expect(context).toContain("### review");
      expect(context).toContain("Code review guidelines");
      expect(context).toContain("/skills/review/");
    });

    it("builds context for multiple skills", () => {
      const skills = new Map([
        ["review", createLoadedSkill("review", "Code review guidelines")],
        ["testing", createLoadedSkill("testing", "Testing best practices")],
      ]);

      const context = buildSkillContext(["review", "testing"], skills);
      expect(context).toContain("### review");
      expect(context).toContain("### testing");
      expect(context).toContain("Code review guidelines");
      expect(context).toContain("Testing best practices");
    });

    it("skips skills not in loaded map", () => {
      const skills = new Map([
        ["review", createLoadedSkill("review", "Code review guidelines")],
      ]);

      const context = buildSkillContext(["review", "missing"], skills);
      expect(context).toContain("### review");
      expect(context).not.toContain("### missing");
    });
  });

  describe("validateSkillDeps", () => {
    function createSkillWithDeps(
      name: string,
      requires?: { tools?: string[]; skills?: string[] }
    ): LoadedSkill {
      return {
        name,
        path: `/skills/${name}`,
        manifest: {
          name,
          description: `${name} skill`,
          requires,
        },
      };
    }

    it("passes when no dependencies required", () => {
      const skills = new Map([
        ["skill1", createSkillWithDeps("skill1")],
      ]);

      expect(() => validateSkillDeps(["skill1"], [], skills)).not.toThrow();
    });

    it("passes when tool dependencies are satisfied", () => {
      const skills = new Map([
        ["skill1", createSkillWithDeps("skill1", { tools: ["git", "exec"] })],
      ]);

      expect(() => validateSkillDeps(["skill1"], ["git", "exec"], skills)).not.toThrow();
    });

    it("passes when skill dependencies are satisfied", () => {
      const skills = new Map([
        ["basics", createSkillWithDeps("basics")],
        ["advanced", createSkillWithDeps("advanced", { skills: ["basics"] })],
      ]);

      expect(() => validateSkillDeps(["basics", "advanced"], [], skills)).not.toThrow();
    });

    it("throws when required tool is missing", () => {
      const skills = new Map([
        ["skill1", createSkillWithDeps("skill1", { tools: ["git"] })],
      ]);

      expect(() => validateSkillDeps(["skill1"], [], skills)).toThrow(
        "Skill 'skill1' requires tool 'git' but it's not available to this agent"
      );
    });

    it("throws when required skill is missing", () => {
      const skills = new Map([
        ["advanced", createSkillWithDeps("advanced", { skills: ["basics"] })],
      ]);

      expect(() => validateSkillDeps(["advanced"], [], skills)).toThrow(
        "Skill 'advanced' requires skill 'basics' but it's not available to this agent"
      );
    });

    it("validates multiple dependencies", () => {
      const skills = new Map([
        ["skill1", createSkillWithDeps("skill1", {
          tools: ["git", "kv"],
          skills: ["basics"],
        })],
        ["basics", createSkillWithDeps("basics")],
      ]);

      // Missing 'kv' tool
      expect(() => validateSkillDeps(["skill1", "basics"], ["git"], skills)).toThrow(
        "Skill 'skill1' requires tool 'kv' but it's not available to this agent"
      );
    });
  });
});
