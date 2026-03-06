import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// ToolHandler type is defined here inline so this file is self-contained.
// It can be installed anywhere (e.g. ~/.beige/tools/kv/) without needing the
// beige source tree.
type ToolHandler = (args: string[], config?: Record<string, unknown>) => Promise<{ output: string; exitCode: number }>;

/** All commands the KV tool exposes. */
const ALL_COMMANDS = ["set", "get", "del", "list"] as const;
type KVCommand = (typeof ALL_COMMANDS)[number];

/**
 * Resolve which commands are permitted given the tool config.
 *
 * Config fields (both optional, strings or arrays of strings):
 *   allowCommands  — whitelist; only these commands are permitted.
 *                    Defaults to all commands when absent.
 *   denyCommands   — blacklist; these commands are always blocked,
 *                    even if present in allowCommands.
 *
 * Precedence: deny beats allow.
 */
function resolveAllowedCommands(config: Record<string, unknown>): Set<KVCommand> {
  const toArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string") return [value];
    return [];
  };

  const allowed = new Set<KVCommand>(
    config.allowCommands !== undefined
      ? (toArray(config.allowCommands).filter((c) =>
          (ALL_COMMANDS as readonly string[]).includes(c)
        ) as KVCommand[])
      : ALL_COMMANDS
  );

  for (const cmd of toArray(config.denyCommands)) {
    allowed.delete(cmd as KVCommand);
  }

  return allowed;
}

/**
 * KV Tool — Simple key-value store that persists to disk.
 * Executes on the gateway host.
 *
 * Commands:
 *   set <key> <value>  — Store a value
 *   get <key>          — Retrieve a value
 *   del <key>          — Delete a key
 *   list               — List all keys
 *
 * Config:
 *   allowCommands  — only permit these commands (default: all)
 *   denyCommands   — always block these commands (deny beats allow)
 */
export function createHandler(config: Record<string, unknown>): ToolHandler {
  const storePath = resolve(homedir(), ".beige", "data", "kv.json");
  mkdirSync(resolve(homedir(), ".beige", "data"), { recursive: true });

  const allowedCommands = resolveAllowedCommands(config);

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

    // Access-control check — runs before any business logic.
    if (command && !allowedCommands.has(command as KVCommand)) {
      const permitted = [...allowedCommands].join(", ") || "(none)";
      return {
        output: `Permission denied: command '${command}' is not allowed for this agent.\nPermitted commands: ${permitted}`,
        exitCode: 1,
      };
    }

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
