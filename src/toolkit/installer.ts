/**
 * Toolkit installer.
 * 
 * Handles installing toolkits from various sources:
 * - npm packages (@scope/name or name)
 * - GitHub repositories (github:owner/repo)
 * - Local paths (./path or /absolute/path)
 * - URLs (https://...)
 */

import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, symlinkSync, lstatSync, readdirSync } from "fs";
import { resolve, basename, join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { extract } from "tar";
import {
  type ToolkitSource,
  type ValidatedToolkit,
  parseToolkitSource,
  validateToolkit,
} from "./schema.js";
import {
  getToolkitInstallPath,
  registerToolkit,
  unregisterToolkit,
  deleteToolkitFiles,
  getInstalledToolkit,
  getAllToolNames,
  sourceToString,
  listInstalledToolkits,
} from "./registry.js";

const BEIGE_DIR = resolve(homedir(), ".beige");
const TEMP_DIR = resolve(BEIGE_DIR, "temp");

export interface InstallResult {
  success: boolean;
  toolkit?: ValidatedToolkit;
  installed?: boolean;
  updated?: boolean;
  error?: string;
  conflicts?: string[];
}

function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function cleanTempDir(): void {
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

function checkConflicts(toolkit: ValidatedToolkit, existingToolkitName?: string): string[] {
  const conflicts: string[] = [];
  const existingTools = getAllToolNames();
  
  for (const tool of toolkit.tools) {
    if (existingTools.has(tool.name)) {
      const owner = findToolOwner(tool.name);
      if (owner && owner !== existingToolkitName) {
        conflicts.push(`Tool '${tool.name}' already exists from toolkit '${owner}'`);
      }
    }
  }
  
  return conflicts;
}

function findToolOwner(toolName: string): string | undefined {
  const toolkits = listInstalledToolkits();
  for (const tk of toolkits) {
    if (tk.tools.includes(toolName)) {
      return tk.name;
    }
  }
  return undefined;
}

export async function installToolkit(sourceStr: string, options: { force?: boolean } = {}): Promise<InstallResult> {
  let source: ToolkitSource;
  try {
    source = parseToolkitSource(sourceStr);
  } catch (err) {
    return { success: false, error: String(err) };
  }
  
  ensureTempDir();
  
  let tempPath: string;
  try {
    switch (source.type) {
      case "npm":
        tempPath = await fetchFromNpm(source.package);
        break;
      case "github":
        tempPath = await fetchFromGitHub(source.owner, source.repo, source.ref);
        break;
      case "local":
        tempPath = resolve(source.path);
        if (!existsSync(tempPath)) {
          return { success: false, error: `Local path does not exist: ${tempPath}` };
        }
        break;
      case "url":
        tempPath = await fetchFromUrl(source.url);
        break;
      default:
        return { success: false, error: `Unknown source type` };
    }
  } catch (err) {
    cleanTempDir();
    return { success: false, error: `Failed to fetch toolkit: ${err}` };
  }
  
  let toolkit: ValidatedToolkit;
  try {
    toolkit = validateToolkit(tempPath);
  } catch (err) {
    cleanTempDir();
    return { success: false, error: `Invalid toolkit: ${err}` };
  }
  
  const toolkitName = toolkit.manifest.name;
  const installPath = getToolkitInstallPath(toolkitName);
  const existing = getInstalledToolkit(toolkitName);
  
  const conflicts = checkConflicts(toolkit, toolkitName);
  if (conflicts.length > 0 && !options.force) {
    cleanTempDir();
    return { success: false, conflicts, error: `Tool name conflicts detected. Use --force to override.` };
  }
  
  if (existsSync(installPath)) {
    rmSync(installPath, { recursive: true, force: true });
  }
  mkdirSync(installPath, { recursive: true });
  
  if (source.type === "local") {
    try {
      symlinkSync(tempPath, installPath, "junction");
    } catch {
      cpSync(tempPath, installPath, { recursive: true });
    }
  } else {
    cpSync(tempPath, installPath, { recursive: true });
  }
  
  registerToolkit(
    toolkitName,
    source,
    toolkit.manifest.version,
    installPath,
    toolkit.tools.map(t => t.name)
  );
  
  cleanTempDir();
  
  return {
    success: true,
    toolkit,
    installed: !existing,
    updated: !!existing,
  };
}

async function fetchFromNpm(packageName: string): Promise<string> {
  ensureTempDir();
  
  const tempPackDir = join(TEMP_DIR, `npm-${Date.now()}`);
  mkdirSync(tempPackDir, { recursive: true });
  
  const isInstalled = checkNpmPackageInstalled(packageName);
  
  if (isInstalled) {
    const globalPath = getNpmGlobalPath(packageName);
    if (globalPath && existsSync(join(globalPath, "toolkit.json"))) {
      return globalPath;
    }
  }
  
  try {
    execSync(`npm pack ${packageName} --pack-destination="${tempPackDir}"`, {
      stdio: "pipe",
      cwd: tempPackDir,
    });
  } catch (err) {
    throw new Error(`Failed to npm pack ${packageName}. Make sure the package exists on npm.`);
  }
  
  const files = readdirSync(tempPackDir);
  const tgzFile = files.find((f: string) => f.endsWith(".tgz"));
  if (!tgzFile) {
    throw new Error("npm pack did not produce a .tgz file");
  }
  
  const extractDir = join(TEMP_DIR, `npm-extract-${Date.now()}`);
  await extractTarball(join(tempPackDir, tgzFile), extractDir);
  
  const extractedContents = readdirSync(extractDir);
  if (extractedContents.length === 1 && extractedContents[0] === "package") {
    return join(extractDir, "package");
  }
  
  return extractDir;
}

function checkNpmPackageInstalled(packageName: string): boolean {
  try {
    execSync(`npm list -g ${packageName} --depth=0`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getNpmGlobalPath(packageName: string): string | null {
  try {
    const output = execSync(`npm root -g`, { encoding: "utf-8" }).trim();
    const scopedMatch = packageName.match(/^@([^/]+)\/(.+)$/);
    if (scopedMatch) {
      return join(output, `@${scopedMatch[1]}`, scopedMatch[2]);
    }
    return join(output, packageName);
  } catch {
    return null;
  }
}

async function fetchFromGitHub(owner: string, repo: string, ref?: string): Promise<string> {
  ensureTempDir();
  
  const tarballUrl = ref
    ? `https://github.com/${owner}/${repo}/archive/${ref}.tar.gz`
    : `https://github.com/${owner}/${repo}/tarball/main`;
  
  const extractDir = join(TEMP_DIR, `github-${owner}-${repo}-${Date.now()}`);
  
  try {
    await downloadAndExtractTarball(tarballUrl, extractDir);
  } catch {
    const fallbackUrl = `https://github.com/${owner}/${repo}/tarball/master`;
    await downloadAndExtractTarball(fallbackUrl, extractDir);
  }
  
  const contents = readdirSync(extractDir);
  if (contents.length === 1) {
    const subDir = join(extractDir, contents[0]);
    if (lstatSync(subDir).isDirectory()) {
      return subDir;
    }
  }
  
  return extractDir;
}

async function fetchFromUrl(url: string): Promise<string> {
  ensureTempDir();
  
  if (!url.endsWith(".tar.gz") && !url.endsWith(".tgz")) {
    throw new Error("URL must point to a .tar.gz or .tgz file");
  }
  
  const extractDir = join(TEMP_DIR, `url-${Date.now()}`);
  await downloadAndExtractTarball(url, extractDir);
  
  const contents = readdirSync(extractDir);
  if (contents.length === 1) {
    const subDir = join(extractDir, contents[0]);
    if (lstatSync(subDir).isDirectory()) {
      return subDir;
    }
  }
  
  return extractDir;
}

async function downloadAndExtractTarball(url: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download from ${url}: ${response.status} ${response.statusText}`);
  }
  
  const tempFile = join(TEMP_DIR, `download-${Date.now()}.tar.gz`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(tempFile, buffer);
  
  await extractTarball(tempFile, destDir);
  
  rmSync(tempFile, { force: true });
}

async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  
  await extract({
    file: tarballPath,
    cwd: destDir,
  });
}

export function removeToolkit(name: string): { success: boolean; error?: string } {
  const existing = getInstalledToolkit(name);
  if (!existing) {
    return { success: false, error: `Toolkit '${name}' is not installed` };
  }
  
  unregisterToolkit(name);
  deleteToolkitFiles(name);
  
  return { success: true };
}
