import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import JSON5 from "json5";
import { type BeigeConfig, type ToolConfig, type SkillConfig, validateConfig } from "./schema.js";
import { listInstalledToolkits, getToolkitsDir } from "../toolkit/registry.js";

const TOOLKIT_MARK = "_toolkit";

interface ToolkitRegistry {
  version: number;
  toolkits: Record<string, {
    name: string;
    path: string;
    tools: string[];
  }>;
}

function loadToolkitRegistry(): ToolkitRegistry | null {
  const registryPath = resolve(homedir(), ".beige", "toolkit-registry.json");
  if (!existsSync(registryPath)) {
    return null;
  }
  try {
    const content = readFileSync(registryPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function mergeToolkitTools(config: BeigeConfig, configDir: string): void {
  const registry = loadToolkitRegistry();
  if (!registry) {
    return;
  }

  for (const [toolkitName, toolkit] of Object.entries(registry.toolkits)) {
    for (const toolName of toolkit.tools) {
      if (config.tools[toolName]) {
        continue;
      }
      
      const toolPath = resolve(toolkit.path, "tools", toolName);
      
      const toolConfig: ToolConfig & { [TOOLKIT_MARK]?: string } = {
        path: toolPath,
        target: "gateway",
        [TOOLKIT_MARK]: toolkitName,
      };
      
      config.tools[toolName] = toolConfig;
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
 * Load and validate a beige config file (JSON5 format).
 */
export function loadConfig(configPath: string): BeigeConfig {
  const absolutePath = resolve(configPath);
  const configDir = dirname(absolutePath);

  const raw = readFileSync(absolutePath, "utf-8");
  const parsed = JSON5.parse(raw);
  const resolved = resolveEnvVars(parsed) as BeigeConfig;

  const config = validateConfig(resolved);
  resolveToolPaths(config, configDir);
  resolveSkillPaths(config, configDir);
  mergeToolkitTools(config, configDir);

  return config;
}
