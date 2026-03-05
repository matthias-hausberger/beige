import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import JSON5 from "json5";
import { type BeigeConfig, validateConfig } from "./schema.js";

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

  return config;
}
