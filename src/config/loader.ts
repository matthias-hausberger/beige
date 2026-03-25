import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { beigeDir } from "../paths.js";
import JSON5 from "json5";
import { type BeigeConfig, type PluginConfig, type SkillConfig, validateConfig } from "./schema.js";

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
 * Resolve relative plugin paths against the config file directory.
 */
function resolvePluginPaths(config: BeigeConfig, configDir: string): void {
  if (!config.plugins) return;
  for (const plugin of Object.values(config.plugins)) {
    if (plugin.path && !plugin.path.startsWith("/")) {
      plugin.path = resolve(configDir, plugin.path);
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
  const config = validateConfig(resolved);

  // Resolve relative paths against the config file directory
  resolvePluginPaths(config, configDir);
  resolveSkillPaths(config, configDir);
  resolveWorkspacePaths(config, configDir);

  return config;
}
