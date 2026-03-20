/**
 * Tool installer.
 *
 * Installs tools from various sources into ~/.beige/tools/.
 * Each tool is a directory with a tool.json manifest and an index.ts handler.
 *
 * Sources:
 *   npm:@scope/package@version      — npm package (single tool or multi-tool)
 *   github:owner/repo               — GitHub repo (all tools)
 *   github:owner/repo/path/to/tool  — single tool from a GitHub repo subfolder
 *   github:owner/repo#ref           — GitHub repo at a specific tag/branch
 *   ./local/path                    — local directory
 *
 * On disk:
 *   ~/.beige/tools/<name>/           — individual tool dirs (real or symlink)
 *   ~/.beige/tools/<name>.meta.json  — install metadata (source, timestamp)
 *   ~/.beige/packages/<pkg>/         — intact npm/multi-tool packages
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  statSync,
} from "fs";
import { resolve, join, relative, basename } from "path";
import { execSync } from "child_process";
import { extract } from "tar";
import { beigeDir } from "../paths.js";
import type { ToolManifest } from "../config/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolInstallMeta {
  /** Original source string used to install this tool. */
  source: string;
  /** For tools from a multi-tool package, the package directory name. */
  package?: string;
  /** ISO timestamp of when the tool was installed. */
  installedAt: string;
}

export interface DiscoveredTool {
  name: string;
  path: string;
  manifest: ToolManifest;
}

export interface InstallResult {
  success: boolean;
  tools?: DiscoveredTool[];
  error?: string;
  conflicts?: string[];
}

export type ParsedSource =
  | { type: "npm"; package: string; version?: string }
  | { type: "github"; owner: string; repo: string; path?: string; ref?: string }
  | { type: "local"; path: string };

// ── Paths ────────────────────────────────────────────────────────────────────

function getToolsDir(): string {
  return resolve(beigeDir(), "tools");
}

function getPackagesDir(): string {
  return resolve(beigeDir(), "packages");
}

function getTempDir(): string {
  return resolve(beigeDir(), "temp");
}

function ensureDir(p: string): void {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
  }
}

function cleanTempDir(): void {
  const tempDir = getTempDir();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Source parsing ───────────────────────────────────────────────────────────

export function parseSource(source: string): ParsedSource {
  // npm:@scope/package@version or npm:package@version
  if (source.startsWith("npm:")) {
    const rest = source.slice(4);
    // Handle scoped packages: @scope/name@version
    let packageName: string;
    let version: string | undefined;

    if (rest.startsWith("@")) {
      // Scoped: @scope/name or @scope/name@version
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1) {
        throw new Error(`Invalid npm source: ${source}. Scoped packages need @scope/name format.`);
      }
      const afterSlash = rest.slice(slashIdx + 1);
      const atIdx = afterSlash.indexOf("@");
      if (atIdx === -1) {
        packageName = rest;
      } else {
        packageName = rest.slice(0, slashIdx + 1 + atIdx);
        version = afterSlash.slice(atIdx + 1);
      }
    } else {
      // Unscoped: name or name@version
      const atIdx = rest.indexOf("@");
      if (atIdx === -1) {
        packageName = rest;
      } else {
        packageName = rest.slice(0, atIdx);
        version = rest.slice(atIdx + 1);
      }
    }

    if (!packageName) {
      throw new Error(`Invalid npm source: ${source}`);
    }

    return { type: "npm", package: packageName, version };
  }

  // github:owner/repo/path/to/tool or github:owner/repo#ref
  if (source.startsWith("github:")) {
    const rest = source.slice(7);

    // Split ref first (if present): owner/repo/path#ref
    const hashIdx = rest.indexOf("#");
    let ref: string | undefined;
    let pathPart: string;
    if (hashIdx !== -1) {
      ref = rest.slice(hashIdx + 1);
      pathPart = rest.slice(0, hashIdx);
    } else {
      pathPart = rest;
    }

    const segments = pathPart.split("/");
    if (segments.length < 2) {
      throw new Error(
        `Invalid GitHub source: ${source}. Expected format: github:owner/repo[/path][#ref]`
      );
    }

    const owner = segments[0];
    const repo = segments[1];
    const subPath = segments.length > 2 ? segments.slice(2).join("/") : undefined;

    return { type: "github", owner, repo, path: subPath, ref };
  }

  // Local path: starts with . or /
  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) {
    return { type: "local", path: resolve(source) };
  }

  // Default: assume npm package
  return parseSource(`npm:${source}`);
}

// ── Tool discovery ───────────────────────────────────────────────────────────

/**
 * Recursively scan a directory for tool.json files.
 * Returns discovered tools with their paths and parsed manifests.
 * Skips node_modules, .git, __tests__, and test directories.
 */
export function discoverTools(rootPath: string): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];
  const seen = new Set<string>();

  function scan(dir: string): void {
    const toolJsonPath = join(dir, "tool.json");
    if (existsSync(toolJsonPath)) {
      try {
        const raw = readFileSync(toolJsonPath, "utf-8");
        const manifest = JSON.parse(raw) as ToolManifest;
        if (manifest.name && manifest.target) {
          if (seen.has(manifest.name)) {
            console.warn(`[TOOLS] Duplicate tool name '${manifest.name}' found, skipping ${dir}`);
          } else {
            seen.add(manifest.name);
            tools.push({ name: manifest.name, path: dir, manifest });
          }
        }
      } catch {
        console.warn(`[TOOLS] Failed to parse tool.json at ${dir}, skipping`);
      }
      // Don't recurse into tool directories — a tool.json marks a leaf
      return;
    }

    // Recurse into subdirectories
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const skipDirs = new Set([
      "node_modules",
      ".git",
      "__tests__",
      "test",
      "tests",
      ".github",
      "scripts",
      "dist",
    ]);
    for (const entry of entries) {
      if (skipDirs.has(entry) || entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          scan(fullPath);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  scan(rootPath);
  return tools;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchFromNpm(
  packageName: string,
  version?: string
): Promise<string> {
  ensureDir(getTempDir());
  const tempPackDir = join(getTempDir(), `npm-${Date.now()}`);
  mkdirSync(tempPackDir, { recursive: true });

  const spec = version ? `${packageName}@${version}` : packageName;

  try {
    execSync(`npm pack ${spec} --pack-destination="${tempPackDir}"`, {
      stdio: "pipe",
      cwd: tempPackDir,
    });
  } catch {
    throw new Error(
      `Failed to fetch npm package '${spec}'. Make sure the package exists on npm.`
    );
  }

  const files = readdirSync(tempPackDir);
  const tgzFile = files.find((f: string) => f.endsWith(".tgz"));
  if (!tgzFile) {
    throw new Error("npm pack did not produce a .tgz file");
  }

  const extractDir = join(getTempDir(), `npm-extract-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  await extract({ file: join(tempPackDir, tgzFile), cwd: extractDir });

  // npm pack always extracts into a "package/" subdirectory
  const packageDir = join(extractDir, "package");
  if (existsSync(packageDir) && statSync(packageDir).isDirectory()) {
    return packageDir;
  }

  // Fallback: if the tarball contained a single directory, use that
  const contents = readdirSync(extractDir);
  if (contents.length === 1) {
    const single = join(extractDir, contents[0]);
    if (statSync(single).isDirectory()) {
      return single;
    }
  }

  return extractDir;
}

async function fetchFromGitHub(
  owner: string,
  repo: string,
  ref?: string
): Promise<string> {
  ensureDir(getTempDir());

  const extractDir = join(getTempDir(), `github-${owner}-${repo}-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });

  const tarballUrl = ref
    ? `https://github.com/${owner}/${repo}/archive/${ref}.tar.gz`
    : `https://github.com/${owner}/${repo}/tarball/main`;

  try {
    await downloadAndExtractTarball(tarballUrl, extractDir);
  } catch {
    // Fallback to master branch
    const fallbackUrl = `https://github.com/${owner}/${repo}/tarball/master`;
    await downloadAndExtractTarball(fallbackUrl, extractDir);
  }

  // GitHub tarballs extract into a single directory like "owner-repo-sha/"
  const contents = readdirSync(extractDir);
  if (contents.length === 1) {
    const single = join(extractDir, contents[0]);
    if (statSync(single).isDirectory()) {
      return single;
    }
  }

  return extractDir;
}

async function downloadAndExtractTarball(
  url: string,
  destDir: string
): Promise<void> {
  mkdirSync(destDir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const tempFile = join(getTempDir(), `download-${Date.now()}.tar.gz`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(tempFile, buffer);

  await extract({ file: tempFile, cwd: destDir });
  rmSync(tempFile, { force: true });
}

// ── Dependency installation ──────────────────────────────────────────────────

/**
 * Run `npm install --production` in a tool directory if it has a package.json
 * with non-empty dependencies.
 */
function installToolDependencies(toolPath: string): void {
  const pkgJsonPath = join(toolPath, "package.json");
  if (!existsSync(pkgJsonPath)) return;

  try {
    const raw = readFileSync(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(raw);
    if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) return;
  } catch {
    return;
  }

  console.log(`[TOOLS] Installing dependencies in ${basename(toolPath)}...`);
  try {
    execSync("npm install --production --no-package-lock", {
      cwd: toolPath,
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(
      `Failed to install dependencies for tool at ${toolPath}: ${err}`
    );
  }
}

// ── Meta file management ─────────────────────────────────────────────────────

function writeMetaFile(toolName: string, meta: ToolInstallMeta): void {
  const metaPath = join(getToolsDir(), `${toolName}.meta.json`);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

export function readMetaFile(toolName: string): ToolInstallMeta | null {
  const metaPath = join(getToolsDir(), `${toolName}.meta.json`);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

function removeMetaFile(toolName: string): void {
  const metaPath = join(getToolsDir(), `${toolName}.meta.json`);
  if (existsSync(metaPath)) {
    rmSync(metaPath, { force: true });
  }
}

// ── Conflict checking ────────────────────────────────────────────────────────

function checkConflicts(tools: DiscoveredTool[], force: boolean): string[] {
  const toolsDir = getToolsDir();
  const conflicts: string[] = [];

  for (const tool of tools) {
    const targetPath = join(toolsDir, tool.name);
    if (existsSync(targetPath)) {
      const meta = readMetaFile(tool.name);
      const from = meta?.source ?? "unknown source";
      conflicts.push(`Tool '${tool.name}' already installed (from ${from})`);
    }
  }

  return force ? [] : conflicts;
}

// ── Install: single tool (copy directly) ─────────────────────────────────────

function installSingleTool(
  tool: DiscoveredTool,
  source: string,
  force: boolean
): InstallResult {
  const toolsDir = getToolsDir();
  ensureDir(toolsDir);

  const conflicts = checkConflicts([tool], force);
  if (conflicts.length > 0) {
    return { success: false, conflicts, error: "Tool name conflicts detected. Use --force to override." };
  }

  const targetPath = join(toolsDir, tool.name);

  // Remove existing if force
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
    removeMetaFile(tool.name);
  }

  // Copy tool directory
  cpSync(tool.path, targetPath, { recursive: true });

  // Install dependencies
  installToolDependencies(targetPath);

  // Write meta
  writeMetaFile(tool.name, {
    source,
    installedAt: new Date().toISOString(),
  });

  return {
    success: true,
    tools: [{ ...tool, path: targetPath }],
  };
}

// ── Install: multi-tool package (symlinks) ───────────────────────────────────

function installMultiToolPackage(
  tools: DiscoveredTool[],
  packagePath: string,
  source: string,
  packageDirName: string,
  force: boolean
): InstallResult {
  const toolsDir = getToolsDir();
  const packagesDir = getPackagesDir();
  ensureDir(toolsDir);
  ensureDir(packagesDir);

  const conflicts = checkConflicts(tools, force);
  if (conflicts.length > 0) {
    return { success: false, conflicts, error: "Tool name conflicts detected. Use --force to override." };
  }

  const targetPackageDir = join(packagesDir, packageDirName);

  // Remove existing package if present (re-install / update)
  if (existsSync(targetPackageDir)) {
    // Remove old symlinks for tools from this package
    for (const tool of tools) {
      const symlinkPath = join(toolsDir, tool.name);
      if (existsSync(symlinkPath)) {
        rmSync(symlinkPath, { recursive: true, force: true });
      }
      removeMetaFile(tool.name);
    }
    rmSync(targetPackageDir, { recursive: true, force: true });
  }

  // Also remove any existing tools with same names (force case)
  if (force) {
    for (const tool of tools) {
      const existing = join(toolsDir, tool.name);
      if (existsSync(existing)) {
        rmSync(existing, { recursive: true, force: true });
        removeMetaFile(tool.name);
      }
    }
  }

  // Move package to permanent location
  cpSync(packagePath, targetPackageDir, { recursive: true });

  // Install dependencies per tool
  const installedTools: DiscoveredTool[] = [];
  for (const tool of tools) {
    // Compute the relative path of this tool within the original package
    const relPath = relative(packagePath, tool.path);
    const toolInPackage = join(targetPackageDir, relPath);

    installToolDependencies(toolInPackage);

    // Create symlink
    const symlinkPath = join(toolsDir, tool.name);
    try {
      symlinkSync(toolInPackage, symlinkPath);
    } catch {
      // Symlink failed (e.g. Windows without privileges), fall back to copy
      cpSync(toolInPackage, symlinkPath, { recursive: true });
    }

    // Write meta
    writeMetaFile(tool.name, {
      source,
      package: packageDirName,
      installedAt: new Date().toISOString(),
    });

    installedTools.push({
      name: tool.name,
      path: symlinkPath,
      manifest: tool.manifest,
    });
  }

  return { success: true, tools: installedTools };
}

// ── Package directory name normalization ─────────────────────────────────────

function normalizePackageName(source: ParsedSource): string {
  switch (source.type) {
    case "npm":
      return source.package.replace(/^@/, "").replace(/\//g, "-");
    case "github":
      return `${source.owner}-${source.repo}`;
    case "local":
      return basename(source.path);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Install tools from a source string.
 */
export async function installTools(
  sourceStr: string,
  options: { force?: boolean } = {}
): Promise<InstallResult> {
  const force = options.force ?? false;
  let source: ParsedSource;

  try {
    source = parseSource(sourceStr);
  } catch (err) {
    return { success: false, error: String(err) };
  }

  ensureDir(getTempDir());

  let fetchedPath: string;
  try {
    switch (source.type) {
      case "npm":
        fetchedPath = await fetchFromNpm(source.package, source.version);
        break;
      case "github":
        fetchedPath = await fetchFromGitHub(source.owner, source.repo, source.ref);
        // If a subfolder path is specified, navigate into it
        if (source.path) {
          fetchedPath = join(fetchedPath, source.path);
          if (!existsSync(fetchedPath)) {
            cleanTempDir();
            return {
              success: false,
              error: `Path '${source.path}' not found in repository ${source.owner}/${source.repo}`,
            };
          }
        }
        break;
      case "local":
        if (!existsSync(source.path)) {
          return { success: false, error: `Local path does not exist: ${source.path}` };
        }
        fetchedPath = source.path;
        break;
    }
  } catch (err) {
    cleanTempDir();
    return { success: false, error: `Failed to fetch: ${err}` };
  }

  // Discover tools
  const tools = discoverTools(fetchedPath);
  if (tools.length === 0) {
    cleanTempDir();
    return { success: false, error: `No tools found (no tool.json) at ${sourceStr}` };
  }

  let result: InstallResult;

  if (tools.length === 1 && existsSync(join(fetchedPath, "tool.json"))) {
    // Single tool at root of fetched path — direct copy
    result = installSingleTool(tools[0], sourceStr, force);
  } else {
    // Multi-tool package — use packages/ + symlinks
    const packageDirName = normalizePackageName(source);
    result = installMultiToolPackage(tools, fetchedPath, sourceStr, packageDirName, force);
  }

  cleanTempDir();
  return result;
}

/**
 * Remove an installed tool.
 */
export function removeTool(toolName: string): { success: boolean; error?: string } {
  const toolsDir = getToolsDir();
  const toolPath = join(toolsDir, toolName);

  if (!existsSync(toolPath)) {
    return { success: false, error: `Tool '${toolName}' is not installed` };
  }

  const meta = readMetaFile(toolName);

  // Remove the tool (symlink or directory)
  rmSync(toolPath, { recursive: true, force: true });
  removeMetaFile(toolName);

  // If it came from a package, check if any other tools still reference it
  if (meta?.package) {
    const packagesDir = getPackagesDir();
    const packageDir = join(packagesDir, meta.package);

    if (existsSync(packageDir)) {
      // Check if any other installed tools reference this package
      const otherToolsUsingPackage = listInstalledTools().filter(
        (t) => {
          const m = readMetaFile(t.name);
          return m?.package === meta.package;
        }
      );

      if (otherToolsUsingPackage.length === 0) {
        // No other tools reference this package — clean it up
        rmSync(packageDir, { recursive: true, force: true });
      }
    }
  }

  return { success: true };
}

/**
 * Update a tool (or all tools from the same package) by re-installing from
 * the original source.
 */
export async function updateTool(
  toolName: string
): Promise<InstallResult> {
  const meta = readMetaFile(toolName);
  if (!meta) {
    return { success: false, error: `Tool '${toolName}' has no install metadata — cannot update` };
  }

  return installTools(meta.source, { force: true });
}

/**
 * Update all installed tools.
 */
export async function updateAllTools(): Promise<{
  updated: string[];
  failed: Array<{ source: string; error: string }>;
}> {
  const tools = listInstalledTools();
  const updated: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];

  // Group by source to avoid re-installing the same package multiple times
  const sourceGroups = new Map<string, string[]>();
  for (const tool of tools) {
    const meta = readMetaFile(tool.name);
    if (!meta) continue;
    const group = sourceGroups.get(meta.source) ?? [];
    group.push(tool.name);
    sourceGroups.set(meta.source, group);
  }

  for (const [source, toolNames] of sourceGroups) {
    console.log(`[TOOLS] Updating from ${source}...`);
    const result = await installTools(source, { force: true });
    if (result.success) {
      updated.push(...toolNames);
    } else {
      failed.push({ source, error: result.error ?? "Unknown error" });
    }
  }

  return { updated, failed };
}

/**
 * List all installed tools by scanning ~/.beige/tools/.
 */
export function listInstalledTools(): DiscoveredTool[] {
  const toolsDir = getToolsDir();
  if (!existsSync(toolsDir)) return [];

  const tools: DiscoveredTool[] = [];
  const entries = readdirSync(toolsDir);

  for (const entry of entries) {
    // Skip meta files
    if (entry.endsWith(".meta.json")) continue;

    const toolPath = join(toolsDir, entry);
    const toolJsonPath = join(toolPath, "tool.json");

    // Must be a directory (or symlink to one) with a tool.json
    try {
      if (!statSync(toolPath).isDirectory()) continue;
      if (!existsSync(toolJsonPath)) continue;
    } catch {
      continue;
    }

    try {
      const raw = readFileSync(toolJsonPath, "utf-8");
      const manifest = JSON.parse(raw) as ToolManifest;
      tools.push({ name: manifest.name, path: toolPath, manifest });
    } catch {
      console.warn(`[TOOLS] Failed to read tool.json for '${entry}', skipping`);
    }
  }

  return tools;
}
