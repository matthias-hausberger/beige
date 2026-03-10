/**
 * Toolkit schema and validation.
 * 
 * A toolkit is a collection of tools distributed together.
 * It contains a toolkit.json manifest and one or more tool packages.
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import type { ToolManifest } from "../config/schema.js";

export interface ToolkitManifest {
  name: string;
  version: string;
  description?: string;
  repository?: string;
  author?: string;
  license?: string;
  tools: string[];
}

export interface InstalledToolkit {
  name: string;
  source: ToolkitSource;
  version: string;
  installedAt: string;
  path: string;
  tools: string[];
}

export type ToolkitSource =
  | { type: "npm"; package: string; version?: string }
  | { type: "github"; owner: string; repo: string; ref?: string }
  | { type: "local"; path: string }
  | { type: "url"; url: string };

export interface ToolkitRegistry {
  version: number;
  toolkits: Record<string, InstalledToolkit>;
}

export const TOOLKIT_REGISTRY_VERSION = 1;

export function validateToolkitManifest(data: unknown): ToolkitManifest {
  if (!data || typeof data !== "object") {
    throw new Error("toolkit.json must be an object");
  }
  
  const manifest = data as Record<string, unknown>;
  
  if (typeof manifest.name !== "string" || !manifest.name) {
    throw new Error("toolkit.json: 'name' is required and must be a non-empty string");
  }
  
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("toolkit.json: 'version' is required and must be a non-empty string");
  }
  
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    throw new Error("toolkit.json: 'tools' is required and must be a non-empty array");
  }
  
  for (const toolPath of manifest.tools) {
    if (typeof toolPath !== "string") {
      throw new Error("toolkit.json: 'tools' must contain only string paths");
    }
  }
  
  return {
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === "string" ? manifest.description : undefined,
    repository: typeof manifest.repository === "string" ? manifest.repository : undefined,
    author: typeof manifest.author === "string" ? manifest.author : undefined,
    license: typeof manifest.license === "string" ? manifest.license : undefined,
    tools: manifest.tools as string[],
  };
}

export function loadToolkitManifest(toolkitPath: string): ToolkitManifest {
  const manifestPath = resolve(toolkitPath, "toolkit.json");
  
  if (!existsSync(manifestPath)) {
    throw new Error(`Toolkit manifest not found: ${manifestPath}`);
  }
  
  let data: unknown;
  try {
    const content = readFileSync(manifestPath, "utf-8");
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse toolkit.json: ${err}`);
  }
  
  return validateToolkitManifest(data);
}

export interface ValidatedToolkit {
  manifest: ToolkitManifest;
  path: string;
  tools: ValidatedTool[];
}

export interface ValidatedTool {
  name: string;
  path: string;
  manifest: ToolManifest;
}

export function validateToolkit(toolkitPath: string): ValidatedToolkit {
  const manifest = loadToolkitManifest(toolkitPath);
  const tools: ValidatedTool[] = [];
  const toolNames = new Set<string>();
  
  for (const toolRelPath of manifest.tools) {
    const toolPath = resolve(toolkitPath, toolRelPath);
    const toolManifestPath = resolve(toolPath, "tool.json");
    
    if (!existsSync(toolManifestPath)) {
      throw new Error(`Tool manifest not found: ${toolManifestPath}`);
    }
    
    let toolData: unknown;
    try {
      const content = readFileSync(toolManifestPath, "utf-8");
      toolData = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse tool.json at ${toolPath}: ${err}`);
    }
    
    const toolManifest = toolData as ToolManifest;
    
    if (!toolManifest.name) {
      throw new Error(`Tool at ${toolPath} missing 'name' in tool.json`);
    }
    
    if (toolNames.has(toolManifest.name)) {
      throw new Error(`Duplicate tool name '${toolManifest.name}' in toolkit '${manifest.name}'`);
    }
    
    toolNames.add(toolManifest.name);
    tools.push({
      name: toolManifest.name,
      path: toolPath,
      manifest: toolManifest,
    });
  }
  
  return {
    manifest,
    path: toolkitPath,
    tools,
  };
}

export function normalizeToolkitName(name: string): string {
  return name.replace(/^@/, "").replace(/\//, "-");
}

export function parseToolkitSource(source: string): ToolkitSource {
  if (source.startsWith("github:")) {
    const rest = source.slice(7);
    const [ownerRepo, ref] = rest.split("#");
    const [owner, repo] = ownerRepo.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub source: ${source}. Expected format: github:owner/repo or github:owner/repo#ref`);
    }
    return { type: "github", owner, repo, ref };
  }
  
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return { type: "url", url: source };
  }
  
  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) {
    return { type: "local", path: source };
  }
  
  if (source.startsWith("@") || source.includes("/")) {
    return { type: "npm", package: source };
  }
  
  return { type: "npm", package: source };
}
