# Beige — Agent Context

## Project Overview

Beige is a secure, open-source, sandboxed agent system. AI agents write and execute code inside Docker containers. The gateway orchestrates LLM calls, enforces policies, audit-logs every tool invocation, and routes tool execution.

- **Stack**: TypeScript + Node.js (gateway), Deno (inside sandbox containers)
- **LLM layer**: pi SDK (`@mariozechner/pi-coding-agent`) — handles providers, streaming, sessions
- **Config format**: JSON5 at `~/.beige/config.json5`
- **Branch**: `dev`

## Guidelines

Before making changes, review:
- **`CONTRIBUTING.md`** — Development setup, code style, PR process
- **`docs/architecture.md`** — System design and directory layout
- **`docs/tools.md`** — How to write tool packages
- **`docs/skills.md`** — How to write skill packages

### Code Style
- TypeScript strict mode
- ES modules (ESNext)
- Prefer `async/await` over raw promises
- Meaningful variable names
- Keep commits focused (one logical change per commit)

### Testing
- **Always add tests** for new functionality
- Place tests alongside source files: `src/module/foo.spec.ts` tests `src/module/foo.ts`
- Use the existing test framework patterns in the codebase
- Run tests with `pnpm test` or `pnpm run test`

## Architecture (two-process model)

```
Shell 1: beige              ← Gateway: sandboxes, sockets, tools, audit, HTTP API (:7433), Telegram
Shell 2: beige tui [agent]  ← TUI: pi InteractiveMode (LLM local), tools proxied via gateway HTTP API
```

The gateway always runs. Channels connect to it:
- **Telegram** — in-process channel (GrammY)
- **TUI** — separate process, connects via HTTP API, runs pi InteractiveMode locally

Core tools (read, write, patch, exec) execute in Docker sandboxes via the gateway. The TUI proxies tool calls through `POST /api/agents/:name/exec`.

## Key Directories

```
src/
├── gateway/          # Gateway core (gateway.ts, api.ts, agent-manager.ts, sessions.ts, audit.ts, policy.ts)
├── channels/         # Channel adapters (telegram.ts, tui.ts)
├── config/           # Config loading + schema (loader.ts, schema.ts)
├── sandbox/          # Docker container lifecycle (manager.ts)
├── skills/           # Skill loading and context building (registry.ts)
├── socket/           # Unix socket server + protocol (server.ts, protocol.ts)
├── tools/            # Tool registry, runner, core tools (registry.ts, runner.ts, core.ts)
├── toolkit/          # Toolkit system (schema.ts, registry.ts, installer.ts)
├── cli.ts            # CLI entry point
└── index.ts          # Programmatic exports
sandbox/              # Dockerfile + tool-client for sandbox containers
tools/kv/             # Example gateway-targeted tool (key-value store)
skills/               # Example skills (code-review)
docs/                 # Full documentation suite (architecture, flows, security, config, tools)
examples/             # Example config
project/              # Vision + use cases
~/.beige/             # Runtime data (config, sessions, sockets, logs, agent workspaces)
```

## Docs

- `docs/architecture.md` — component design, directory layout, data flow
- `docs/system-overview.md` — diagrams, channel model, startup sequence
- `docs/request-flows.md` — 10 sequence diagrams covering all flows
- `docs/security-model.md` — threat model, defense layers
- `docs/configuration.md` — full config reference, directory layout
- `docs/tools.md` — writing tools, protocol, mounting
- `docs/skills.md` — writing skills, dependencies, mounting
- `docs/toolkits.md` — creating, publishing, and installing toolkits
- `docs/api.md` — HTTP API reference for gateway endpoints
- `project/vision.md` — project vision and goals
- `project/usecases.md` — use cases

## Key Decisions

- **4 core tools only** (read, write, patch, exec) — everything else composes through exec
- **Unix domain sockets** — one per agent, identity from connection not payload
- **JSON5 config** — comments, env var interpolation via `${VAR}`
- **pi SDK for LLM** — no custom provider implementation, uses `AuthStorage.setRuntimeApiKey()`
- **Gateway HTTP API** on port 7433 — TUI and future channels connect here
- **Sessions persist** to `~/.beige/sessions/<agent>/` as `.jsonl` files
- **Skills** — read-only knowledge packages mounted at `/skills/<name>/`, referenced in system prompt
- **Toolkits** — distributable collections of tools, installable from npm, GitHub, or local paths

## Current State

Code compiles and runs. The system is functional:
- Gateway starts and manages Docker sandboxes
- TUI connects via HTTP API
- Telegram bot works with streaming responses
- KV tool is operational

### Development Commands

```bash
pnpm install           # Install dependencies
pnpm run build         # Compile TypeScript
pnpm run beige         # Run CLI via tsx (dev mode)
pnpm run start         # Run compiled CLI

# Development workflow
pnpm run beige gateway start --foreground   # Start gateway
pnpm run beige tui assistant                # Start TUI
```

---

## Background Jobs with `gob`

Use `gob` for servers, long-running commands, and builds.

### When to Use gob

Use `gob` for:
- **Servers**: `gob add npm run dev`
- **Long-running processes**: `gob add npm run watch`
- **Builds**: `gob run make build`
- **Parallel build steps**: Run multiple builds concurrently

Do NOT use `gob` for:
- Quick commands: `git status`, `ls`, `cat`
- CLI tools: `jira`, `kubectl`, `todoist`
- File operations: `mv`, `cp`, `rm`

### gob Commands

- `gob add <cmd>` - Start command in background, returns job ID
- `gob add --description "context" <cmd>` - Start with description for context
- `gob run <cmd>` - Run and wait for completion (equivalent to `gob add` + `gob await`)
- `gob run --description "context" <cmd>` - Run with description for context
- `gob await <job_id>` - Wait for job to finish, stream output
- `gob list` - List jobs with IDs, status, and descriptions
- `gob logs <job_id>` - View stdout and stderr (stdout→stdout, stderr→stderr)
- `gob stdout <job_id>` - View current stdout (useful if job may be stuck)
- `gob stop <job_id>` - Graceful stop
- `gob restart <job_id>` - Stop + start

### Stuck Detection

`gob run` and `gob await` automatically detect potentially stuck jobs:
- Timeout: avg duration + 1 min (or 5 min if no history), triggers if no output for 1 min
- Job continues running in background
- Use `gob logs <id>` or `gob stdout <id>` to check output, `gob await <id>` to continue waiting

### Examples

Servers and long-running:
```
gob add npm run dev                              # Start dev server
gob add --description "File watcher" npm run watch  # With description
```

Builds:
```
gob run make build                           # Run build, wait for completion
gob run npm run test                         # Run tests, wait for completion
gob run --description "Type check" npm run typecheck  # With description
```

Regular commands (no gob):
```
git status
kubectl get pods
jira issue list
```