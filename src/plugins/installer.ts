/**
 * Plugin installer.
 *
 * Installs plugins from various sources into ~/.beige/plugins/ and adds them
 * to config.json5. The config file is the single source of truth for which
 * plugins are installed and how they're configured.
 *
 * Sources:
 *   npm:@scope/package@version      — npm package (single plugin or multi-plugin)
 *   github:owner/repo               — GitHub repo (all plugins)
 *   github:owner/repo/path/to/plugin — single plugin from a GitHub repo subfolder
 *   github:owner/repo#ref           — GitHub repo at a specific tag/branch
 *   ./local/path                    — local directory (symlinked, not copied)
 *
 * On disk:
 *   ~/.beige/plugins/<name>/           — individual plugin dirs (real or symlink)
 *   ~/.beige/packages/<pkg>/           — intact npm/multi-plugin packages
 *
 * In config.json5:
 *   plugins.<name>.path     — absolute path to the plugin directory
 *   plugins.<name>.config   — default config from plugin manifest (editable)
 *   plugins.<name>._source  — install source for updates (do not edit)
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
import JSON5 from "json5";
import { beigeDir } from "../paths.js";
import type { PluginManifest } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

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

function getConfigPath(): string {
  return resolve(beigeDir(), "config.json5");
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

// ── Config file operations ───────────────────────────────────────────────────

interface ConfigFile {
  [key: string]: unknown;
  plugins?: Record<string, {
    path?: string;
    config?: Record<string, unknown>;
    _source?: string;
  }>;
}

function readConfig(): { raw: string; parsed: ConfigFile } {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}. Run 'beige setup' first.`);
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON5.parse(raw) as ConfigFile;
  return { raw, parsed };
}

/**
 * Add or update plugin entries in config.json5.
 *
 * Strategy: parse with JSON5, modify the object, serialize back.
 * This loses comments but is reliable. We add a header comment back.
 *
 * Safety rule: if a plugin entry already exists in config, only `path` and
 * `_source` are ever updated. The user's `config` block (API keys, tokens,
 * any other settings) is never touched. Default config from the manifest is
 * only written when creating a brand-new entry.
 */
function addPluginsToConfig(
  plugins: DiscoveredPlugin[],
  source: string,
  force: boolean
): string[] {
  const { parsed } = readConfig();
  const conflicts: string[] = [];

  if (!parsed.plugins) {
    parsed.plugins = {};
  }

  for (const plugin of plugins) {
    const existing = parsed.plugins[plugin.name];

    if (existing) {
      if (!force) {
        conflicts.push(
          `Plugin '${plugin.name}' already in config. Use --force to override.`
        );
        continue;
      }

      // Plugin already exists — only update path and _source.
      // Never overwrite config: the user may have filled in API keys, tokens,
      // or other settings that would be silently destroyed otherwise.
      existing.path = plugin.path;
      existing._source = source;
    } else {
      // Brand-new entry — write path, _source, and default config from manifest.
      const entry: Record<string, unknown> = {
        path: plugin.path,
        _source: source,
      };

      if (plugin.manifest.defaultConfig && Object.keys(plugin.manifest.defaultConfig).length > 0) {
        entry.config = plugin.manifest.defaultConfig;
      }

      parsed.plugins[plugin.name] = entry;
    }
  }

  if (conflicts.length > 0 && !force) {
    return conflicts;
  }

  writeConfig(parsed);
  return [];
}

function removePluginFromConfig(pluginName: string): void {
  const { parsed } = readConfig();
  if (parsed.plugins) {
    delete parsed.plugins[pluginName];
    writeConfig(parsed);
  }
}

function getPluginSource(pluginName: string): string | undefined {
  const { parsed } = readConfig();
  return parsed.plugins?.[pluginName]?._source as string | undefined;
}

function writeConfig(config: ConfigFile): void {
  const configPath = getConfigPath();
  // JSON5.stringify doesn't exist as a pretty-printer with comments,
  // so we use JSON with some post-processing for readability
  const json = JSON.stringify(config, null, 2);
  writeFileSync(configPath, json, "utf-8");
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
 * Recursively scan a directory for plugin.json files.
 * Returns discovered plugins with their paths and parsed manifests.
 */
export function discoverPlugins(rootPath: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];
  const seen = new Set<string>();

  function scan(dir: string): void {
    const pluginJsonPath = join(dir, "plugin.json");

    let manifest: PluginManifest | null = null;

    if (existsSync(pluginJsonPath)) {
      try {
        const raw = readFileSync(pluginJsonPath, "utf-8");
        manifest = JSON.parse(raw) as PluginManifest;
      } catch {
        console.warn(`[PLUGINS] Failed to parse plugin.json at ${dir}, skipping`);
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

// ── Install: place files on disk ─────────────────────────────────────────────

function installSinglePluginToDisk(
  plugin: DiscoveredPlugin,
  force: boolean
): string {
  const pluginsDir = getPluginsDir();
  ensureDir(pluginsDir);

  const targetPath = join(pluginsDir, plugin.name);

  if (existsSync(targetPath)) {
    if (!force) {
      throw new Error(`Plugin directory '${plugin.name}' already exists. Use --force to override.`);
    }
    rmSync(targetPath, { recursive: true, force: true });
  }

  cpSync(plugin.path, targetPath, { recursive: true });
  installPluginDependencies(targetPath);

  return targetPath;
}

function installMultiPluginPackageToDisk(
  plugins: DiscoveredPlugin[],
  packagePath: string,
  packageDirName: string,
  force: boolean
): Map<string, string> {
  const pluginsDir = getPluginsDir();
  const packagesDir = getPackagesDir();
  ensureDir(pluginsDir);
  ensureDir(packagesDir);

  const targetPackageDir = join(packagesDir, packageDirName);

  // Clean up existing package if force
  if (existsSync(targetPackageDir)) {
    if (!force) {
      throw new Error(`Package '${packageDirName}' already exists. Use --force to override.`);
    }
    for (const plugin of plugins) {
      const symlinkPath = join(pluginsDir, plugin.name);
      if (existsSync(symlinkPath)) {
        rmSync(symlinkPath, { recursive: true, force: true });
      }
    }
    rmSync(targetPackageDir, { recursive: true, force: true });
  }

  if (force) {
    for (const plugin of plugins) {
      const existing = join(pluginsDir, plugin.name);
      if (existsSync(existing)) {
        rmSync(existing, { recursive: true, force: true });
      }
    }
  }

  cpSync(packagePath, targetPackageDir, { recursive: true });

  const result = new Map<string, string>();
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

    result.set(plugin.name, symlinkPath);
  }

  return result;
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

  // Discover plugins in fetched source
  const plugins = discoverPlugins(fetchedPath);
  if (plugins.length === 0) {
    cleanTempDir();
    return { success: false, error: `No plugins found (no plugin.json) at ${sourceStr}` };
  }

  // Install files to disk
  try {
    if (source.type === "local") {
      // Local sources: just use the path directly, don't copy
      // The config entry will point to the local path
    } else if (
      plugins.length === 1 &&
      existsSync(join(fetchedPath, "plugin.json"))
    ) {
      // Single plugin at root of fetched dir
      const installedPath = installSinglePluginToDisk(plugins[0], force);
      plugins[0].path = installedPath;
    } else {
      // Multi-plugin package
      const packageDirName = normalizePackageName(source);
      const pathMap = installMultiPluginPackageToDisk(plugins, fetchedPath, packageDirName, force);
      for (const plugin of plugins) {
        const newPath = pathMap.get(plugin.name);
        if (newPath) plugin.path = newPath;
      }
    }
  } catch (err) {
    cleanTempDir();
    return { success: false, error: String(err) };
  }

  // Add to config.json5
  const conflicts = addPluginsToConfig(plugins, sourceStr, force);
  if (conflicts.length > 0) {
    cleanTempDir();
    return { success: false, conflicts, error: "Plugin conflicts detected. Use --force to override." };
  }

  cleanTempDir();
  return { success: true, plugins };
}

export function removePlugin(pluginName: string): { success: boolean; error?: string } {
  const pluginsDir = getPluginsDir();
  const pluginPath = join(pluginsDir, pluginName);

  // Remove from config first
  removePluginFromConfig(pluginName);

  // Remove from disk if it exists in the managed plugins dir
  if (existsSync(pluginPath)) {
    rmSync(pluginPath, { recursive: true, force: true });
  }

  return { success: true };
}

export async function updatePlugin(pluginName: string): Promise<InstallResult> {
  const source = getPluginSource(pluginName);
  if (!source) {
    return { success: false, error: `Plugin '${pluginName}' has no _source in config — cannot update` };
  }
  return installPlugins(source, { force: true });
}

export async function updateAllPlugins(): Promise<{
  updated: string[];
  failed: Array<{ source: string; error: string }>;
}> {
  const { parsed } = readConfig();
  const updated: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];

  if (!parsed.plugins) return { updated, failed };

  // Group plugins by source to avoid re-downloading the same package
  const sourceGroups = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(parsed.plugins)) {
    const source = entry._source;
    if (!source) continue;
    const group = sourceGroups.get(source) ?? [];
    group.push(name);
    sourceGroups.set(source, group);
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
 * Ensure all plugins defined in config are installed on disk.
 *
 * For each plugin entry that has a `_source` but whose `path` is missing or
 * points to a directory that doesn't exist, the plugin is automatically
 * fetched and installed (equivalent to running `beige plugins install`).
 *
 * After installation the installer writes the resolved `path` back to
 * config.json5, so the caller should reload the config from disk to pick up
 * the updated paths.
 *
 * Plugins that have neither a valid `path` nor a `_source` are reported as
 * failures — the gateway cannot start without them.
 */
export async function ensurePluginsInstalled(
  config: import("../config/schema.js").BeigeConfig,
  options: { force?: boolean } = {}
): Promise<{
  installed: string[];
  failed: Array<{ name: string; error: string }>;
}> {
  const installed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  if (!config.plugins) return { installed, failed };

  for (const [pluginName, pluginConfig] of Object.entries(config.plugins)) {
    const pathMissing = !pluginConfig.path || !existsSync(pluginConfig.path);
    if (!pathMissing) continue; // already on disk — nothing to do

    if (!pluginConfig._source) {
      failed.push({
        name: pluginName,
        error:
          `Plugin '${pluginName}' has no 'path' on disk and no '_source' to install from. ` +
          `Specify a 'path' or install it with 'beige plugins install <source>'.`,
      });
      continue;
    }

    console.log(
      `[PLUGINS] Auto-installing '${pluginName}' from ${pluginConfig._source}...`
    );

    const result = await installPlugins(pluginConfig._source, { force: options.force ?? true });

    if (result.success) {
      installed.push(pluginName);
      console.log(`[PLUGINS] Auto-installed '${pluginName}' ✓`);
    } else {
      const msg = result.error ?? "Unknown error";
      failed.push({ name: pluginName, error: msg });
      console.error(`[PLUGINS] Failed to auto-install '${pluginName}': ${msg}`);
    }
  }

  return { installed, failed };
}

/**
 * List plugins from config.json5.
 */
export function listPluginsFromConfig(): Array<{
  name: string;
  path?: string;
  source?: string;
  hasConfig: boolean;
}> {
  try {
    const { parsed } = readConfig();
    if (!parsed.plugins) return [];

    return Object.entries(parsed.plugins).map(([name, entry]) => ({
      name,
      path: entry.path,
      source: entry._source,
      hasConfig: !!entry.config && Object.keys(entry.config).length > 0,
    }));
  } catch {
    return [];
  }
}
