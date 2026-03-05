import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { ToolHandler } from "../../src/tools/runner.js";

/**
 * KV Tool — Simple key-value store that persists to disk.
 * Executes on the gateway host.
 *
 * Commands:
 *   set <key> <value>  — Store a value
 *   get <key>          — Retrieve a value
 *   del <key>          — Delete a key
 *   list               — List all keys
 */
export function createHandler(_config: Record<string, unknown>): ToolHandler {
  const storePath = resolve(homedir(), ".beige", "data", "kv.json");
  mkdirSync(resolve(homedir(), ".beige", "data"), { recursive: true });

  function loadStore(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(storePath, "utf-8"));
    } catch {
      return {};
    }
  }

  function saveStore(store: Record<string, string>): void {
    writeFileSync(storePath, JSON.stringify(store, null, 2));
  }

  return async (args: string[]) => {
    const command = args[0];

    switch (command) {
      case "set": {
        const key = args[1];
        const value = args.slice(2).join(" ");
        if (!key || !value) {
          return { output: "Usage: kv set <key> <value>", exitCode: 1 };
        }
        const store = loadStore();
        store[key] = value;
        saveStore(store);
        return { output: `OK: ${key} = ${value}`, exitCode: 0 };
      }

      case "get": {
        const key = args[1];
        if (!key) {
          return { output: "Usage: kv get <key>", exitCode: 1 };
        }
        const store = loadStore();
        if (key in store) {
          return { output: store[key], exitCode: 0 };
        }
        return { output: `Key not found: ${key}`, exitCode: 1 };
      }

      case "del": {
        const key = args[1];
        if (!key) {
          return { output: "Usage: kv del <key>", exitCode: 1 };
        }
        const store = loadStore();
        if (key in store) {
          delete store[key];
          saveStore(store);
          return { output: `Deleted: ${key}`, exitCode: 0 };
        }
        return { output: `Key not found: ${key}`, exitCode: 1 };
      }

      case "list": {
        const store = loadStore();
        const keys = Object.keys(store);
        if (keys.length === 0) {
          return { output: "(empty)", exitCode: 0 };
        }
        return {
          output: keys.map((k) => `${k} = ${store[k]}`).join("\n"),
          exitCode: 0,
        };
      }

      default:
        return {
          output: `Unknown command: ${command}\nUsage: kv <set|get|del|list> [args...]`,
          exitCode: 1,
        };
    }
  };
}
