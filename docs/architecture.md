# Beige — Architecture

## Overview

Beige is a secure, sandboxed agent system where:

- A **gateway** process orchestrates everything: LLM calls, policy enforcement, audit logging, sandbox lifecycle.
- Each **agent** runs inside its own Docker container (sandbox). All code execution happens there.
- The gateway exposes exactly **4 core tools** to the LLM: `read`, `write`, `patch`, `exec`.
- Additional **tools** (like `kv`, `browser`, `slack`) are mounted into sandboxes as executable launchers. Agents invoke them via `exec`.
- Tool launchers are thin clients that call back to the gateway over a **Unix domain socket** for actual execution.
- The gateway uses the **pi SDK** (`@mariozechner/pi-coding-agent`) for all LLM interaction, supporting Anthropic, OpenAI/ZAI, and any compatible provider.

## Data Flow

```
User (Telegram/CLI)
  │
  ▼
Gateway (Node.js)
  ├── Channel Adapter (GrammY / CLI)
  ├── Agent Manager (session per agent)
  ├── pi SDK (LLM calls)
  │     └── Core Tools: read, write, patch, exec
  │           │
  │           ▼
  │     Policy Engine (check permissions, log)
  │           │
  │           ▼
  │     Sandbox Router
  │           │
  │           ▼
  │     Docker Exec (run command in container)
  │
  ├── Socket Server (one Unix socket per agent)
  │     │
  │     ▼
  │   Tool Request from sandbox launcher
  │     │
  │     ▼
  │   Policy Engine (check permissions, log)
  │     │
  │     ▼
  │   Tool Runner (execute on gateway host or in sandbox)
  │     │
  │     ▼
  │   Response back through socket → sandbox → exec result → LLM
  │
  └── Audit Logger (every tool invocation)
```

## Core Tool Call Flow (e.g. `exec curl https://example.com`)

1. LLM calls `exec` with args `["curl", "https://example.com"]`
2. Gateway receives the tool call (it's a pi SDK custom tool)
3. Gateway logs: `{agent: "travel", tool: "exec", args: ["curl", "..."], decision: "allowed"}`
4. Gateway runs `docker exec <container> curl https://example.com`
5. Gateway captures stdout/stderr, returns to LLM

## Tool Launcher Call Flow (e.g. `exec /tools/bin/kv set mykey myvalue`)

1. LLM calls `exec` with args `["/tools/bin/kv", "set", "mykey", "myvalue"]`
2. Gateway receives the tool call, logs it as a core `exec` call
3. Gateway runs `docker exec <container> /tools/bin/kv set mykey myvalue`
4. Inside the container, `/tools/bin/kv` is a generated launcher script that:
   - Connects to `/beige/gateway.sock` (Unix socket mounted into container)
   - Sends: `{"tool": "kv", "args": ["set", "mykey", "myvalue"]}`
   - Waits for response
5. Gateway socket server receives the request:
   - Identifies agent from socket identity (each agent has its own socket)
   - Logs: `{agent: "travel", tool: "kv", args: ["set", "mykey", "myvalue"], decision: "allowed"}`
   - Checks policy (is "travel" agent allowed to use "kv"?)
   - Executes the kv tool handler on the gateway host
   - Returns result through socket
6. Launcher prints the result to stdout, exits
7. `docker exec` captures output, returns to gateway
8. Gateway returns exec result to LLM

## Components

### 1. Config (`config.json5`)

Single config file (JSON5 — JSON with comments) drives the entire system. No defaults — everything is explicit.

```json5
{
  llm: {
    providers: {
      anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
      // zai: {
      //   baseUrl: "https://api.zai.com/v1",
      //   apiKey: "${ZAI_API_KEY}",
      //   api: "openai-completions",
      // },
    },
  },

  tools: {
    kv: {
      path: "./tools/kv",
      target: "gateway",
    },
    // browser: {
    //   path: "./tools/browser",
    //   target: "gateway",
    //   config: { browserUrl: "ws://localhost:9222" },
    // },
  },

  agents: {
    travel: {
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        thinkingLevel: "medium",
      },
      fallbackModels: [
        { provider: "zai", model: "zai-model" },
      ],
      tools: ["kv"],
      sandbox: { image: "beige-sandbox:latest" },
    },
  },

  channels: {
    telegram: {
      enabled: true,
      token: "${TELEGRAM_BOT_TOKEN}",
      allowedUsers: [123456789],
      agentMapping: {
        default: "travel",
        // future: per-chat or per-command agent routing
      },
    },
  },
}
```

### 2. Gateway Core (`src/gateway/`)

- **Config loader**: Reads and validates `config.json5`, resolves env vars.
- **Agent manager**: Creates/destroys agent sessions. Maps agent name → pi SDK `AgentSession` + Docker container.
- **Sandbox manager**: Creates Docker containers with correct mounts, generates tool launchers, manages lifecycle.
- **Socket server**: One Unix domain socket per agent at `~/.beige/sockets/<agent>.sock`, mounted into container at `/beige/gateway.sock`.
- **Policy engine**: Checks if agent is allowed to use a tool. Deny by default.
- **Audit logger**: Logs every tool invocation with agent, tool, args, decision, timing, result summary.

### 3. Core Tools (`src/tools/core/`)

Implemented as pi SDK `ToolDefinition` objects:

- **`read`**: Read a file from the sandbox. Gateway runs `docker exec <container> cat <path>`.
- **`write`**: Write content to a file in the sandbox. Gateway pipes content via `docker exec`.
- **`patch`**: Apply a find-and-replace patch to a file in the sandbox. Gateway reads, patches, writes back.
- **`exec`**: Execute a command in the sandbox. Gateway runs `docker exec <container> <command>`.

All four: log first, check policy, then execute.

### 4. Tool Packages (`tools/`)

Each tool is a directory:

```
tools/kv/
├── tool.json          # metadata: name, description, target
├── index.ts           # tool handler (runs on target)
└── README.md          # documentation (mounted for agent context)
```

`tool.json`:
```json
{
  "name": "kv",
  "description": "Key-value store. Set and get values.",
  "commands": ["set <key> <value>", "get <key>"],
  "target": "gateway"
}
```

The gateway:
1. Reads tool packages from config
2. Generates a launcher script per tool per agent
3. Mounts launchers read-only into `/tools/bin/`
4. Mounts tool packages read-only into `/tools/packages/`
5. Registers tool handlers for gateway-targeted tools

### 5. Tool Launcher (generated, mounted into sandbox)

A small shell script that connects to the gateway socket:

```bash
#!/bin/sh
# Auto-generated by beige gateway. DO NOT EDIT.
# Tool: kv | Target: gateway
exec /beige/tool-client "$TOOL_NAME" "$@"
```

Where `/beige/tool-client` is a small binary/script (mounted read-only) that:
- Connects to `/beige/gateway.sock`
- Sends JSON request with tool name + args
- Reads JSON response
- Prints result to stdout
- Exits with appropriate code

### 6. Socket Protocol

Request (sandbox → gateway):
```json
{
  "type": "tool_request",
  "tool": "kv",
  "args": ["set", "mykey", "myvalue"]
}
```

Response (gateway → sandbox):
```json
{
  "type": "tool_response",
  "success": true,
  "output": "OK",
  "exitCode": 0
}
```

Error response:
```json
{
  "type": "tool_response",
  "success": false,
  "error": "Permission denied: tool 'kv' not allowed for agent 'travel'",
  "exitCode": 1
}
```

### 7. Channel Adapters (`src/channels/`)

Channels are interfaces plugged into the gateway. Multiple can be active simultaneously.

- **Telegram**: GrammY bot. Maps Telegram user/chat → agent. Persistent sessions per chat/thread.
- **TUI**: Interactive terminal powered by pi's `InteractiveMode`. Full editor, streaming, model switching. Talks to the gateway's agent-manager like any other channel.

### 8. Sandbox Docker Image

Minimal image with:
- Deno runtime (for TypeScript execution)
- Common utilities (curl, jq, etc.)
- No secrets, no env vars from host
- Mounts:
  - `/workspace` (read-write) → `~/.beige/agents/<name>/workspace/`
  - `/tools/bin` (read-only) → generated launchers
  - `/tools/packages` (read-only) → tool source packages
  - `/beige/gateway.sock` (Unix socket)
  - `/beige/tool-client` (read-only) → socket client binary

### 9. Identity & Auth Model

- Each agent has its own Unix socket file. Gateway creates socket, mounts it.
- Gateway identifies agent by which socket received the connection.
- No payload-based identity. Agent cannot claim to be another agent.
- Threat model: even if an agent somehow accesses another agent's socket file (impossible due to separate containers), the gateway still enforces per-socket identity.

### 10. Audit Log Format

JSONL file at `~/.beige/logs/audit.jsonl`:

```json
{
  "ts": "2026-03-05T00:00:00.000Z",
  "agent": "travel",
  "type": "core_tool",
  "tool": "exec",
  "args": ["curl", "https://example.com"],
  "decision": "allowed",
  "durationMs": 1234,
  "exitCode": 0,
  "outputBytes": 4567
}
```

```json
{
  "ts": "2026-03-05T00:00:01.000Z",
  "agent": "travel",
  "type": "tool",
  "tool": "kv",
  "args": ["set", "mykey", "myvalue"],
  "decision": "allowed",
  "target": "gateway",
  "durationMs": 12,
  "exitCode": 0,
  "outputBytes": 2
}
```

## Directory Layout

```
beige/
├── project/                    # Design history
│   ├── vision.md
│   └── usecases.md
├── docs/                       # Documentation
│   ├── README.md               # Doc index
│   ├── architecture.md         # This file
│   ├── system-overview.md      # Component diagrams
│   ├── request-flows.md        # Sequence diagrams
│   ├── security-model.md       # Threat model + defenses
│   ├── tools.md                # Tool packages + protocol
│   └── configuration.md        # Config reference
├── src/
│   ├── cli.ts                  # CLI entry point (starts gateway, optionally with TUI channel)
│   ├── index.ts                # Programmatic exports
│   ├── config/
│   │   ├── schema.ts           # Config types + validation
│   │   └── loader.ts           # JSON5 loader + env var resolution
│   ├── gateway/
│   │   ├── gateway.ts          # Main gateway orchestrator
│   │   ├── agent-manager.ts    # Agent session lifecycle
│   │   ├── sessions.ts         # Session store (persistence + mapping)
│   │   ├── policy.ts           # Permission checks
│   │   └── audit.ts            # Audit logging
│   ├── sandbox/
│   │   ├── manager.ts          # Docker container lifecycle
│   │   ├── docker.ts           # Docker API helpers
│   │   └── launcher.ts         # Generate tool launcher scripts
│   ├── socket/
│   │   ├── server.ts           # Unix socket server (gateway side)
│   │   └── protocol.ts         # Request/response types
│   ├── tools/
│   │   ├── core.ts             # read, write, patch, exec as pi ToolDefinitions
│   │   ├── registry.ts         # Load tool packages, register handlers
│   │   └── runner.ts           # Execute tool handlers
│   └── channels/
│       ├── telegram.ts         # GrammY adapter
│       └── tui.ts              # pi InteractiveMode adapter
├── tools/
│   └── kv/                     # MVP tool
│       ├── tool.json
│       ├── index.ts
│       └── README.md
├── sandbox/
│   ├── Dockerfile              # Sandbox base image
│   └── tool-client.ts          # Socket client (runs inside sandbox)
├── examples/
│   └── config.json5            # Example configuration
├── package.json
├── tsconfig.json
└── README.md
```

## Tech Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM layer | pi SDK (`@mariozechner/pi-coding-agent`) | Handles providers (Anthropic, OpenAI/ZAI, etc.), streaming, sessions, auth. No need to reimplement. |
| Gateway runtime | Node.js + TypeScript | pi SDK is Node-native. GrammY is Node-native. |
| Sandbox runtime | Deno (inside Docker) | Native TS execution, no build step, secure-by-default permissions. |
| Container runtime | Docker | Works on Docker Desktop (Mac) and Linux. |
| Socket | Unix domain socket | Peer identity from connection (not payload). Simple, fast, no TCP overhead. |
| Config format | JSON5 | JSON with comments. Human-readable, familiar syntax, env var interpolation. |
| Audit format | JSONL | Append-only, streamable, parseable. |
| Build tool | tsx (dev) / tsc (build) | Fast dev iteration with tsx, standard tsc for production. |
