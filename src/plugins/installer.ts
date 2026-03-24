/**
 * Plugin installer.
 *
 * Installs plugins from various sources into ~/.beige/plugins/.
 * Each plugin is a directory with a plugin.json (or tool.json) manifest and an index.ts entry point.
 *
 * Sources:
 *   npm:@scope/package@version      — npm package (single plugin or multi-plugin)
 *   github:owner/repo               — GitHub repo (all plugins)
 *   github:owner/repo/path/to/plugin — single plugin from a GitHub repo subfolder
 *   github:owner/repo#ref           — GitHub repo at a specific tag/branch
 *   ./local/path                    — local directory
 *
 * On disk:
 *   ~/.beige/plugins/<name>/           — individual plugin dirs (real or symlink)
 *   ~/.beige/plugins/<name>.meta.json  — install metadata (source, timestamp)
 *   ~/.beige/packages/<pkg>/           — intact npm/multi-plugin packages
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  statSync,
} from "fs";
import { resolve, join, relative, basename } from "path";
import { execSync } from "child_process";
import { extract } from "tar";
import { beigeDir } from "../paths.js";
import type { PluginManifest } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PluginInstallMeta {
  source: string;
  package?: string;
  installedAt: string;
}

export interface DiscoveredPlugin {
  name: string;
  path: string;
  manifest: PluginManifest;
}

export interface InstallResult {
  success: boolean;
  plugins?: DiscoveredPlugin[];
  error?: string;
  conflicts?: string[];
}

export type ParsedSource =
  | { type: "npm"; package: string; version?: string }
  | { type: "github"; owner: string; repo: string; path?: string; ref?: string }
  | { type: "local"; path: string };

// ── Paths ────────────────────────────────────────────────────────────────────

function getPluginsDir(): string {
  return resolve(beigeDir(), "plugins");
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
  if (source.startsWith("npm:")) {
    const rest = source.slice(4);
    let packageName: string;
    let version: string | undefined;

    if (rest.startsWith("@")) {
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

  if (source.startsWith("github:")) {
    const rest = source.slice(7);
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

  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) {
    return { type: "local", path: resolve(source) };
  }

  return parseSource(`npm:${source}`);
}

// ── Plugin discovery ─────────────────────────────────────────────────────────

/**
 * Recursively scan a directory for plugin.json or tool.json files.
 * Returns discovered plugins with their paths and parsed manifests.
 */
export function discoverPlugins(rootPath: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];
  const seen = new Set<string>();

  function scan(dir: string): void {
    const pluginJsonPath = join(dir, "plugin.json");
    const toolJsonPath = join(dir, "tool.json");

    let manifest: PluginManifest | null = null;

    if (existsSync(pluginJsonPath)) {
      try {
        const raw = readFileSync(pluginJsonPath, "utf-8");
        manifest = JSON.parse(raw) as PluginManifest;
      } catch {
        console.warn(`[PLUGINS] Failed to parse plugin.json at ${dir}, skipping`);
      }
    } else if (existsSync(toolJsonPath)) {
      // Legacy tool.json support
      try {
        const raw = readFileSync(toolJsonPath, "utf-8");
        const toolManifest = JSON.parse(raw) as {
          name: string;
          description: string;
          commands?: string[];
          target: string;
        };
        manifest = {
          name: toolManifest.name,
          description: toolManifest.description,
          commands: toolManifest.commands,
          provides: { tools: [toolManifest.name] },
        };
      } catch {
        console.warn(`[PLUGINS] Failed to parse tool.json at ${dir}, skipping`);
      }
    }

    if (manifest && manifest.name) {
      if (seen.has(manifest.name)) {
        console.warn(`[PLUGINS] Duplicate plugin name '${manifest.name}' found, skipping ${dir}`);
      } else {
        seen.add(manifest.name);
        plugins.push({ name: manifest.name, path: dir, manifest });
      }
      return; // Don't recurse into plugin directories
    }

    // Recurse into subdirectories
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const skipDirs = new Set([
      "node_modules", ".git", "__tests__", "test", "tests",
      ".github", "scripts", "dist",
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
  return plugins;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchFromNpm(packageName: string, version?: string): Promise<string> {
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

  const packageDir = join(extractDir, "package");
  if (existsSync(packageDir) && statSync(packageDir).isDirectory()) {
    return packageDir;
  }

  const contents = readdirSync(extractDir);
  if (contents.length === 1) {
    const single = join(extractDir, contents[0]);
    if (statSync(single).isDirectory()) {
      return single;
    }
  }

  return extractDir;
}

async function fetchFromGitHub(owner: string, repo: string, ref?: string): Promise<string> {
  ensureDir(getTempDir());

  const extractDir = join(getTempDir(), `github-${owner}-${repo}-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });

  const tarballUrl = ref
    ? `https://github.com/${owner}/${repo}/archive/${ref}.tar.gz`
    : `https://github.com/${owner}/${repo}/tarball/main`;

  try {
    await downloadAndExtractTarball(tarballUrl, extractDir);
  } catch {
    const fallbackUrl = `https://github.com/${owner}/${repo}/tarball/master`;
    await downloadAndExtractTarball(fallbackUrl, extractDir);
  }

  const contents = readdirSync(extractDir);
  if (contents.length === 1) {
    const single = join(extractDir, contents[0]);
    if (statSync(single).isDirectory()) {
      return single;
    }
  }

  return extractDir;
}

async function downloadAndExtractTarball(url: string, destDir: string): Promise<void> {
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

function installPluginDependencies(pluginPath: string): void {
  const pkgJsonPath = join(pluginPath, "package.json");
  if (!existsSync(pkgJsonPath)) return;

  try {
    const raw = readFileSync(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(raw);
    if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) return;
  } catch {
    return;
  }

  console.log(`[PLUGINS] Installing dependencies in ${basename(pluginPath)}...`);
  try {
    execSync("npm install --production --no-package-lock", {
      cwd: pluginPath,
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(
      `Failed to install dependencies for plugin at ${pluginPath}: ${err}`
    );
  }
}

// ── Meta file management ─────────────────────────────────────────────────────

function writeMetaFile(pluginName: string, meta: PluginInstallMeta): void {
  const metaPath = join(getPluginsDir(), `${pluginName}.meta.json`);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

export function readMetaFile(pluginName: string): PluginInstallMeta | null {
  const metaPath = join(getPluginsDir(), `${pluginName}.meta.json`);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

function removeMetaFile(pluginName: string): void {
  const metaPath = join(getPluginsDir(), `${pluginName}.meta.json`);
  if (existsSync(metaPath)) {
    rmSync(metaPath, { force: true });
  }
}

// ── Conflict checking ────────────────────────────────────────────────────────

function checkConflicts(plugins: DiscoveredPlugin[], force: boolean): string[] {
  const pluginsDir = getPluginsDir();
  const conflicts: string[] = [];

  for (const plugin of plugins) {
    const targetPath = join(pluginsDir, plugin.name);
    if (existsSync(targetPath)) {
      const meta = readMetaFile(plugin.name);
      const from = meta?.source ?? "unknown source";
      conflicts.push(`Plugin '${plugin.name}' already installed (from ${from})`);
    }
  }

  return force ? [] : conflicts;
}

// ── Install: single plugin ───────────────────────────────────────────────────

function installSinglePlugin(
  plugin: DiscoveredPlugin,
  source: string,
  force: boolean
): InstallResult {
  const pluginsDir = getPluginsDir();
  ensureDir(pluginsDir);

  const conflicts = checkConflicts([plugin], force);
  if (conflicts.length > 0) {
    return { success: false, conflicts, error: "Plugin name conflicts detected. Use --force to override." };
  }

  const targetPath = join(pluginsDir, plugin.name);

  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
    removeMetaFile(plugin.name);
  }

  cpSync(plugin.path, targetPath, { recursive: true });
  installPluginDependencies(targetPath);

  writeMetaFile(plugin.name, {
    source,
    installedAt: new Date().toISOString(),
  });

  return {
    success: true,
    plugins: [{ ...plugin, path: targetPath }],
  };
}

// ── Install: multi-plugin package ────────────────────────────────────────────

function installMultiPluginPackage(
  plugins: DiscoveredPlugin[],
  packagePath: string,
  source: string,
  packageDirName: string,
  force: boolean
): InstallResult {
  const pluginsDir = getPluginsDir();
  const packagesDir = getPackagesDir();
  ensureDir(pluginsDir);
  ensureDir(packagesDir);

  const conflicts = checkConflicts(plugins, force);
  if (conflicts.length > 0) {
    return { success: false, conflicts, error: "Plugin name conflicts detected. Use --force to override." };
  }

  const targetPackageDir = join(packagesDir, packageDirName);

  if (existsSync(targetPackageDir)) {
    for (const plugin of plugins) {
      const symlinkPath = join(pluginsDir, plugin.name);
      if (existsSync(symlinkPath)) {
        rmSync(symlinkPath, { recursive: true, force: true });
      }
      removeMetaFile(plugin.name);
    }
    rmSync(targetPackageDir, { recursive: true, force: true });
  }

  if (force) {
    for (const plugin of plugins) {
      const existing = join(pluginsDir, plugin.name);
      if (existsSync(existing)) {
        rmSync(existing, { recursive: true, force: true });
        removeMetaFile(plugin.name);
      }
    }
  }

  cpSync(packagePath, targetPackageDir, { recursive: true });

  const installedPlugins: DiscoveredPlugin[] = [];
  for (const plugin of plugins) {
    const relPath = relative(packagePath, plugin.path);
    const pluginInPackage = join(targetPackageDir, relPath);

    installPluginDependencies(pluginInPackage);

    const symlinkPath = join(pluginsDir, plugin.name);
    try {
      symlinkSync(pluginInPackage, symlinkPath);
    } catch {
      cpSync(pluginInPackage, symlinkPath, { recursive: true });
    }

    writeMetaFile(plugin.name, {
      source,
      package: packageDirName,
      installedAt: new Date().toISOString(),
    });

    installedPlugins.push({
      name: plugin.name,
      path: symlinkPath,
      manifest: plugin.manifest,
    });
  }

  return { success: true, plugins: installedPlugins };
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

export async function installPlugins(
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

  const plugins = discoverPlugins(fetchedPath);
  if (plugins.length === 0) {
    cleanTempDir();
    return { success: false, error: `No plugins found (no plugin.json or tool.json) at ${sourceStr}` };
  }

  let result: InstallResult;

  if (plugins.length === 1 && (existsSync(join(fetchedPath, "plugin.json")) || existsSync(join(fetchedPath, "tool.json")))) {
    result = installSinglePlugin(plugins[0], sourceStr, force);
  } else {
    const packageDirName = normalizePackageName(source);
    result = installMultiPluginPackage(plugins, fetchedPath, sourceStr, packageDirName, force);
  }

  cleanTempDir();
  return result;
}

export function removePlugin(pluginName: string): { success: boolean; error?: string } {
  const pluginsDir = getPluginsDir();
  const pluginPath = join(pluginsDir, pluginName);

  if (!existsSync(pluginPath)) {
    return { success: false, error: `Plugin '${pluginName}' is not installed` };
  }

  const meta = readMetaFile(pluginName);

  rmSync(pluginPath, { recursive: true, force: true });
  removeMetaFile(pluginName);

  if (meta?.package) {
    const packagesDir = getPackagesDir();
    const packageDir = join(packagesDir, meta.package);

    if (existsSync(packageDir)) {
      const otherPluginsUsingPackage = listInstalledPlugins().filter(
        (p) => {
          const m = readMetaFile(p.name);
          return m?.package === meta.package;
        }
      );

      if (otherPluginsUsingPackage.length === 0) {
        rmSync(packageDir, { recursive: true, force: true });
      }
    }
  }

  return { success: true };
}

export async function updatePlugin(pluginName: string): Promise<InstallResult> {
  const meta = readMetaFile(pluginName);
  if (!meta) {
    return { success: false, error: `Plugin '${pluginName}' has no install metadata — cannot update` };
  }
  return installPlugins(meta.source, { force: true });
}

export async function updateAllPlugins(): Promise<{
  updated: string[];
  failed: Array<{ source: string; error: string }>;
}> {
  const plugins = listInstalledPlugins();
  const updated: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];

  const sourceGroups = new Map<string, string[]>();
  for (const plugin of plugins) {
    const meta = readMetaFile(plugin.name);
    if (!meta) continue;
    const group = sourceGroups.get(meta.source) ?? [];
    group.push(plugin.name);
    sourceGroups.set(meta.source, group);
  }

  for (const [source, pluginNames] of sourceGroups) {
    console.log(`[PLUGINS] Updating from ${source}...`);
    const result = await installPlugins(source, { force: true });
    if (result.success) {
      updated.push(...pluginNames);
    } else {
      failed.push({ source, error: result.error ?? "Unknown error" });
    }
  }

  return { updated, failed };
}

/**
 * List all installed plugins by scanning ~/.beige/plugins/.
 */
export function listInstalledPlugins(): DiscoveredPlugin[] {
  const pluginsDir = getPluginsDir();
  if (!existsSync(pluginsDir)) return [];

  const plugins: DiscoveredPlugin[] = [];
  const entries = readdirSync(pluginsDir);

  for (const entry of entries) {
    if (entry.endsWith(".meta.json")) continue;

    const pluginPath = join(pluginsDir, entry);
    const pluginJsonPath = join(pluginPath, "plugin.json");
    const toolJsonPath = join(pluginPath, "tool.json");

    try {
      if (!statSync(pluginPath).isDirectory()) continue;
    } catch {
      continue;
    }

    let manifest: PluginManifest | null = null;

    if (existsSync(pluginJsonPath)) {
      try {
        const raw = readFileSync(pluginJsonPath, "utf-8");
        manifest = JSON.parse(raw) as PluginManifest;
      } catch {
        console.warn(`[PLUGINS] Failed to read plugin.json for '${entry}', skipping`);
        continue;
      }
    } else if (existsSync(toolJsonPath)) {
      try {
        const raw = readFileSync(toolJsonPath, "utf-8");
        const toolManifest = JSON.parse(raw) as {
          name: string;
          description: string;
          commands?: string[];
          target: string;
        };
        manifest = {
          name: toolManifest.name,
          description: toolManifest.description,
          commands: toolManifest.commands,
          provides: { tools: [toolManifest.name] },
        };
      } catch {
        console.warn(`[PLUGINS] Failed to read tool.json for '${entry}', skipping`);
        continue;
      }
    }

    if (manifest) {
      plugins.push({ name: manifest.name, path: pluginPath, manifest });
    }
  }

  return plugins;
}
