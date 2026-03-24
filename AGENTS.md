# Beige — AI Agent Context

> **Note:** This file provides context for AI assistants working on this codebase.

## Project Overview

Beige is a secure, open-source, sandboxed agent system built around a **plugin architecture**. AI agents write and execute code inside Docker containers. The gateway orchestrates LLM calls, enforces policies, audit-logs every tool invocation, and routes tool execution. Everything that extends the gateway — tools, channels, hooks, skills — is provided by plugins.

- **Stack**: TypeScript + Node.js (gateway), Deno (inside sandbox containers)
- **LLM layer**: pi SDK (`@mariozechner/pi-coding-agent`)
- **Config format**: JSON5 at `~/.beige/config.json5`

## Architecture

```
Shell 1: beige              ← Gateway: plugins, sandboxes, sockets, audit, HTTP API (:7433)
Shell 2: beige tui [agent]  ← TUI: pi InteractiveMode (LLM local), tools proxied via gateway HTTP API
```

The gateway loads plugins at startup. Plugins can register:
- **Tools** — executables on the agent's PATH inside sandboxes
- **Channels** — messaging adapters (Telegram, Discord, etc.)
- **Hooks** — intercept messages, tool calls, lifecycle events
- **Skills** — read-only knowledge packages mounted in sandboxes
- **Background processes** — polling, timers, watchers

**TUI is the only built-in channel.** Everything else (Telegram, etc.) is a plugin in beige-toolkit.

Core tools (read, write, patch, exec) are built into the gateway. Plugin tools are exposed via `/tools/bin/` on the sandbox PATH.

## Key Directories

```
src/
├── gateway/          # Gateway core (gateway.ts, api.ts, agent-manager.ts, sessions.ts, audit.ts, policy.ts)
├── plugins/          # Plugin system (types.ts, registry.ts, loader.ts, context.ts, installer.ts)
├── channels/         # TUI channel (tui.ts)
├── config/           # Config loading + schema (loader.ts, schema.ts)
├── sandbox/          # Docker container lifecycle (manager.ts)
├── skills/           # Standalone skill loading (registry.ts)
├── socket/           # Unix socket server + protocol (server.ts, protocol.ts)
├── tools/            # Core tools + tool runner (core.ts, runner.ts)
├── cli.ts            # CLI entry point
└── index.ts          # Programmatic exports (including plugin types for beige-toolkit)
sandbox/              # Dockerfile + tool-client for sandbox containers
docs/                 # Documentation (extensibility, gateway, agents, config)
~/.beige/             # Runtime data (config, sessions, sockets, logs, plugins, agent workspaces)
```

## Config Structure (v2)

```json5
{
  llm: { providers: { anthropic: { apiKey: "..." } } },
  plugins: {
    git: { path: "...", config: { ... } },
    telegram: { config: { token: "...", ... } },
  },
  skills: { "code-review": { path: "..." } },
  agents: {
    assistant: {
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      tools: ["git", "telegram.send_message"],
      skills: ["code-review"],
      pluginConfigs: { git: { allowForcePush: true } },
    },
  },
  gateway: { host: "127.0.0.1", port: 7433 },
}
```

## Key Decisions

- **Plugin architecture** — tools, channels, hooks, and skills are all provided by plugins
- **4 core tools only** (read, write, patch, exec) — everything else composes through exec
- **Tools on PATH** — `/tools/bin` is prepended to $PATH in sandboxes; agents call tools naturally
- **Tool naming** — tools must start with the plugin name (e.g. `git` or `telegram.send_message`)
- **TUI is the only built-in channel** — Telegram etc. are plugins in beige-toolkit
- **Hooks** — prePrompt, postResponse, preToolExec, postToolExec, session/gateway lifecycle
- **Plugin types exported from beige** — no separate SDK package; beige-toolkit depends on beige
- **Unix domain sockets** — one per agent, identity from connection not payload
- **JSON5 config** — comments, env var interpolation via `${VAR}`
- **Sessions persist** to `~/.beige/sessions/<agent>/` as `.jsonl` files

## Plugin Interface

```typescript
// Plugin entry point (index.ts)
export function createPlugin(config, ctx: PluginContext): PluginInstance {
  return {
    register(reg: PluginRegistrar) {
      reg.tool({ name: "myplugin", handler: ... });
      reg.channel({ sendMessage: ..., supportsMessaging: ... });
      reg.hook("prePrompt", async (event) => { ... });
      reg.skill({ name: "guide", path: "...", description: "..." });
    },
    async start() { /* background processes */ },
    async stop() { /* cleanup */ },
  };
}
```

## Development Commands

```bash
pnpm install           # Install dependencies
pnpm run build         # Compile TypeScript
pnpm test              # Run tests
pnpm run beige         # Run CLI via tsx (dev mode)

# Development workflow
pnpm run beige gateway start --foreground
pnpm run beige tui assistant
```
