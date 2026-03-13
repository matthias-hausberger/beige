/**
 * Toolkit registry management.
 * 
 * The registry tracks installed toolkits in ~/.beige/toolkit-registry.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve, join } from "path";
import { beigeDir } from "../paths.js";
import {
  type ToolkitRegistry,
  type InstalledToolkit,
  type ToolkitSource,
  TOOLKIT_REGISTRY_VERSION,
  normalizeToolkitName,
} from "./schema.js";

function getBeigeDirPaths() {
  const dir = beigeDir();
  return {
    beigeDir: dir,
    toolkitsDir: resolve(dir, "toolkits"),
    registryPath: resolve(dir, "toolkit-registry.json"),
  };
}

function ensureDirs(): void {
  const { beigeDir: dir, toolkitsDir } = getBeigeDirPaths();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(toolkitsDir)) {
    mkdirSync(toolkitsDir, { recursive: true });
  }
}

export function getToolkitsDir(): string {
  return getBeigeDirPaths().toolkitsDir;
}

export function loadRegistry(): ToolkitRegistry {
  const { registryPath } = getBeigeDirPaths();
  if (!existsSync(registryPath)) {
    return { version: TOOLKIT_REGISTRY_VERSION, toolkits: {} };
  }
  
  try {
    const content = readFileSync(registryPath, "utf-8");
    const data = JSON.parse(content);
    
    if (typeof data.version !== "number") {
      data.version = TOOLKIT_REGISTRY_VERSION;
    }
    if (!data.toolkits || typeof data.toolkits !== "object") {
      data.toolkits = {};
    }
    
    return data as ToolkitRegistry;
  } catch {
    return { version: TOOLKIT_REGISTRY_VERSION, toolkits: {} };
  }
}

export function saveRegistry(registry: ToolkitRegistry): void {
  ensureDirs();
  writeFileSync(getBeigeDirPaths().registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

export function getInstalledToolkit(name: string): InstalledToolkit | undefined {
  const registry = loadRegistry();
  return registry.toolkits[name];
}

export function listInstalledToolkits(): InstalledToolkit[] {
  const registry = loadRegistry();
  return Object.values(registry.toolkits);
}

export function registerToolkit(
  name: string,
  source: ToolkitSource,
  version: string,
  toolkitPath: string,
  tools: string[]
): InstalledToolkit {
  const registry = loadRegistry();
  
  const installed: InstalledToolkit = {
    name,
    source,
    version,
    installedAt: new Date().toISOString(),
    path: toolkitPath,
    tools,
  };
  
  registry.toolkits[name] = installed;
  saveRegistry(registry);
  
  return installed;
}

export function unregisterToolkit(name: string): boolean {
  const registry = loadRegistry();
  
  if (!registry.toolkits[name]) {
    return false;
  }
  
  delete registry.toolkits[name];
  saveRegistry(registry);
  return true;
}

export function getToolkitInstallPath(name: string): string {
  const normalizedName = normalizeToolkitName(name);
  return resolve(getBeigeDirPaths().toolkitsDir, normalizedName);
}

export function sourceToString(source: ToolkitSource): string {
  switch (source.type) {
    case "npm":
      return source.package;
    case "github":
      return `github:${source.owner}/${source.repo}${source.ref ? `#${source.ref}` : ""}`;
    case "local":
      return source.path;
    case "url":
      return source.url;
  }
}

export function deleteToolkitFiles(name: string): void {
  const installPath = getToolkitInstallPath(name);
  if (existsSync(installPath)) {
    rmSync(installPath, { recursive: true, force: true });
  }
}

export function getAllToolNames(): Set<string> {
  const registry = loadRegistry();
  const names = new Set<string>();
  
  for (const toolkit of Object.values(registry.toolkits)) {
    for (const tool of toolkit.tools) {
      names.add(tool);
    }
  }
  
  return names;
}

export function findToolkitForTool(toolName: string): string | undefined {
  const registry = loadRegistry();
  
  for (const [toolkitName, toolkit] of Object.entries(registry.toolkits)) {
    if (toolkit.tools.includes(toolName)) {
      return toolkitName;
    }
  }
  
  return undefined;
}
