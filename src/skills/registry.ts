import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import type { BeigeConfig, SkillManifest } from "../config/schema.js";

export interface LoadedSkill {
  name: string;
  manifest: SkillManifest;
  path: string;
}

const DEFAULT_CONTEXT_FILE = "README.md";

export function loadSkillManifest(skillPath: string): SkillManifest {
  const manifestPath = join(skillPath, "skill.json");
  
  if (!existsSync(manifestPath)) {
    throw new Error(`Skill manifest not found: ${manifestPath}`);
  }
  
  try {
    const content = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(content) as SkillManifest;
    
    if (!manifest.name || !manifest.description) {
      throw new Error(`Skill manifest at ${manifestPath} requires 'name' and 'description'`);
    }
    
    return manifest;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in skill manifest: ${manifestPath}`);
    }
    throw err;
  }
}

export async function loadSkills(config: BeigeConfig): Promise<Map<string, LoadedSkill>> {
  const skills = new Map<string, LoadedSkill>();
  
  if (!config.skills) {
    return skills;
  }
  
  for (const [name, skillConfig] of Object.entries(config.skills)) {
    const manifest = loadSkillManifest(skillConfig.path);
    const loaded: LoadedSkill = {
      name,
      manifest,
      path: skillConfig.path,
    };
    skills.set(name, loaded);
  }
  
  return skills;
}

export function buildSkillContext(
  agentSkills: string[],
  loadedSkills: Map<string, LoadedSkill>
): string {
  if (agentSkills.length === 0) {
    return "";
  }
  
  const lines: string[] = [
    "## Available Skills",
    "",
    "Skills provide specialized knowledge. Read their documentation in `/skills/<name>/`.",
    "",
  ];
  
  for (const skillName of agentSkills) {
    const skill = loadedSkills.get(skillName);
    if (!skill) continue;
    
    lines.push(`### ${skillName}`);
    lines.push(`${skill.manifest.description} — see /skills/${skillName}/`);
    lines.push("");
  }
  
  return lines.join("\n");
}

export function validateSkillDeps(
  agentSkills: string[],
  agentTools: string[],
  loadedSkills: Map<string, LoadedSkill>
): void {
  for (const skillName of agentSkills) {
    const skill = loadedSkills.get(skillName);
    if (!skill) continue;
    
    const requires = skill.manifest.requires;
    if (!requires) continue;
    
    // Check tool dependencies
    if (requires.tools) {
      for (const requiredTool of requires.tools) {
        if (!agentTools.includes(requiredTool)) {
          throw new Error(
            `Skill '${skillName}' requires tool '${requiredTool}' but it's not available to this agent`
          );
        }
      }
    }
    
    // Check skill dependencies
    if (requires.skills) {
      for (const requiredSkill of requires.skills) {
        if (!agentSkills.includes(requiredSkill)) {
          throw new Error(
            `Skill '${skillName}' requires skill '${requiredSkill}' but it's not available to this agent`
          );
        }
      }
    }
  }
}
