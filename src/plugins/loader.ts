/**
 * Plugin loader.
 *
 * Resolves plugin paths, reads manifests, validates config, imports entry
 * points, and calls createPlugin() to get PluginInstances.
 */

import { resolve, join } from "path";
import { readFileSync, existsSync } from "fs";
import type { BeigeConfig } from "../config/schema.js";
import type {
  PluginManifest,
  PluginInstance,
  PluginContext,
  CreatePluginFn,
} from "./types.js";
import type { PluginRegistry } from "./registry.js";
import { createLogger } from "./context.js";

export interface LoadedPlugin {
  name: string;
  manifest: PluginManifest;
  instance: PluginInstance;
  path: string;
}

/**
 * Load all plugins defined in config.plugins.
 *
 * For each plugin:
 * 1. Resolve path
 * 2. Read + validate plugin.json manifest
 * 3. Import entry point (index.ts)
 * 4. Call createPlugin(config, ctx) to get the instance
 * 5. Call instance.register(registrar) to register tools/channels/hooks/skills
 *
 * Returns loaded plugins in config order (important for hook execution).
 */
export async function loadPlugins(
  config: BeigeConfig,
  registry: PluginRegistry,
  ctx: PluginContext
): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];

  if (!config.plugins) {
    return plugins;
  }

  for (const [pluginName, pluginConfig] of Object.entries(config.plugins)) {
    if (!pluginConfig.path) {
      throw new Error(
        `Plugin '${pluginName}' has no path. ` +
        `Install it with 'beige plugins install <source>' or specify a path in config.`
      );
    }

    // 1. Read manifest
    const manifest = loadPluginManifest(pluginConfig.path, pluginName);

    // 2. Import entry point
    const handlerPath = resolve(pluginConfig.path, "index.ts");
    if (!existsSync(handlerPath)) {
      throw new Error(
        `Plugin '${pluginName}' has no index.ts at ${pluginConfig.path}`
      );
    }

    let mod: Record<string, unknown>;
    try {
      mod = await import(handlerPath) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Failed to import plugin '${pluginName}' from ${handlerPath}: ${err}`
      );
    }

    // 3. Get createPlugin function
    const createPlugin = mod.createPlugin as CreatePluginFn | undefined;
    if (typeof createPlugin !== "function") {
      throw new Error(
        `Plugin '${pluginName}' at ${handlerPath} does not export a 'createPlugin' function`
      );
    }

    // 4. Create per-plugin context with a namespaced logger
    const pluginCtx: PluginContext = Object.create(ctx, {
      log: { value: createLogger(pluginName), enumerable: true },
    });

    // 5. Create plugin instance
    let instance: PluginInstance;
    try {
      instance = createPlugin(pluginConfig.config ?? {}, pluginCtx);
    } catch (err) {
      throw new Error(
        `Plugin '${pluginName}' createPlugin() failed: ${err}`
      );
    }

    // 6. Register tools/channels/hooks/skills
    const registrar = registry.createRegistrar(pluginName);
    try {
      instance.register(registrar);
    } catch (err) {
      throw new Error(
        `Plugin '${pluginName}' register() failed: ${err}`
      );
    }

    plugins.push({
      name: pluginName,
      manifest,
      instance,
      path: pluginConfig.path,
    });

    console.log(`[PLUGINS] Loaded plugin '${pluginName}' from ${pluginConfig.path}`);
  }

  return plugins;
}

/**
 * Load and validate a plugin manifest (plugin.json) from a plugin directory.
 */
export function loadPluginManifest(pluginPath: string, pluginName: string): PluginManifest {
  const pluginJsonPath = join(pluginPath, "plugin.json");

  if (existsSync(pluginJsonPath)) {
    const raw = readFileSync(pluginJsonPath, "utf-8");
    const manifest = JSON.parse(raw) as PluginManifest;

    if (!manifest.name) {
      throw new Error(`plugin.json at ${pluginPath} is missing 'name' field`);
    }

    return manifest;
  }

  // No manifest found — create a minimal one from the plugin name
  return {
    name: pluginName,
    description: `Plugin: ${pluginName}`,
  };
}

/**
 * Start all loaded plugins (call plugin.start() in config order).
 */
export async function startPlugins(plugins: LoadedPlugin[]): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.instance.start) {
      try {
        await plugin.instance.start();
        console.log(`[PLUGINS] Started plugin '${plugin.name}'`);
      } catch (err) {
        console.error(`[PLUGINS] Failed to start plugin '${plugin.name}':`, err);
        throw err;
      }
    }
  }
}

/**
 * Stop all loaded plugins (call plugin.stop() in reverse config order).
 */
export async function stopPlugins(plugins: LoadedPlugin[]): Promise<void> {
  // Reverse order for shutdown
  for (let i = plugins.length - 1; i >= 0; i--) {
    const plugin = plugins[i];
    if (plugin.instance.stop) {
      try {
        await plugin.instance.stop();
        console.log(`[PLUGINS] Stopped plugin '${plugin.name}'`);
      } catch (err) {
        console.error(`[PLUGINS] Failed to stop plugin '${plugin.name}':`, err);
        // Continue stopping other plugins even if one fails
      }
    }
  }
}
