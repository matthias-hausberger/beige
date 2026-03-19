import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { beigeDir } from "../paths.js";
import JSON5 from "json5";
import { type BeigeConfig, type ToolConfig, type SkillConfig, validateConfig } from "./schema.js";
import { listInstalledTools } from "../tools/installer.js";

/**
 * Merge installed tools (from ~/.beige/tools/) into the config.
 *
 * For each installed tool:
 * - If the tool is already in config.tools with path+target: skip (user override)
 * - If the tool is in config.tools without path/target: enrich with installed path+target
 * - If the tool is not in config.tools: add it with path+target from disk
 */
function mergeInstalledTools(config: BeigeConfig): void {
  const installed = listInstalledTools();

  for (const tool of installed) {
    const existing = config.tools[tool.name];

    if (existing && existing.path && existing.target) {
      // User has fully specified this tool — skip
      continue;
    }

    if (existing) {
      // User defined the tool (likely for config overrides) but without path/target.
      // Enrich from the installed tool.
      if (!existing.path) {
        existing.path = tool.path;
      }
      if (!existing.target) {
        existing.target = tool.manifest.target;
      }
    } else {
      // Tool not in config at all — auto-add from installed tools.
      config.tools[tool.name] = {
        path: tool.path,
        target: tool.manifest.target,
      };
    }
  }
}

/**
 * Resolve environment variable references in strings.
 * Supports ${VAR_NAME} syntax. Throws if a referenced var is not set.
 */
function resolveEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        throw new Error(`Environment variable '${varName}' is not set (referenced in config)`);
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

/**
 * Resolve relative tool paths against the config file directory.
 */
function resolveToolPaths(config: BeigeConfig, configDir: string): void {
  for (const tool of Object.values(config.tools)) {
    if (tool.path && !tool.path.startsWith("/")) {
      tool.path = resolve(configDir, tool.path);
    }
  }
}

/**
 * Resolve relative skill paths against the config file directory.
 */
function resolveSkillPaths(config: BeigeConfig, configDir: string): void {
  if (!config.skills) return;
  
  for (const skill of Object.values(config.skills)) {
    if (skill.path && !skill.path.startsWith("/")) {
      skill.path = resolve(configDir, skill.path);
    }
  }
}

/**
 * Resolve relative workspace paths against the config file directory.
 */
function resolveWorkspacePaths(config: BeigeConfig, configDir: string): void {
  for (const agent of Object.values(config.agents)) {
    if (agent.workspaceDir && !agent.workspaceDir.startsWith("/")) {
      agent.workspaceDir = resolve(configDir, agent.workspaceDir);
    }
  }
}

/**
 * Load and validate a beige config file (JSON5 format).
 */
export function loadConfig(configPath: string): BeigeConfig {
  const absolutePath = resolve(configPath);
  const configDir = dirname(absolutePath);

  const raw = readFileSync(absolutePath, "utf-8");
  const parsed = JSON5.parse(raw);
  const resolved = resolveEnvVars(parsed) as BeigeConfig;

  // Resolve relative tool paths BEFORE merging installed tools.
  // This ensures user-specified relative paths are resolved first,
  // then mergeInstalledTools can fill in missing paths from disk.
  resolveToolPaths(resolved, configDir);

  // Installed tools must be merged before validateConfig runs its cross-reference
  // checks — otherwise agent tool references that come from installed tools
  // are rejected as unknown.
  mergeInstalledTools(resolved);

  const config = validateConfig(resolved);
  resolveSkillPaths(config, configDir);
  resolveWorkspacePaths(config, configDir);

  return config;
}
