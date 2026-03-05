# Beige

Secure, sandboxed agent system. Let agents write and execute code — safely.

## What is Beige?

Beige is an open-source agent gateway that runs AI agents inside Docker sandboxes. Agents have 4 core tools (`read`, `write`, `patch`, `exec`) and can use additional tools exposed as executables. All tool calls route through the gateway for policy enforcement and audit logging.

**Key principles:**
- 🔒 **Sandboxed** — Every agent runs in its own Docker container. No access to host env vars, secrets, or files.
- 📋 **Audited** — Every tool call is logged with agent identity, args, timing, and permission decision.
- 🛡️ **Policy-enforced** — Deny by default. Agents can only use tools explicitly granted in config.
- 🔌 **Extensible** — Add tools as simple packages. They mount into sandboxes read-only.
- 🤖 **LLM-agnostic** — Uses [pi SDK](https://pi.dev) for LLM interaction. Supports Anthropic, OpenAI, ZAI, and more.

## Quick Start

### 1. Prerequisites

- Node.js 22+
- Docker

### 2. Install

```bash
git clone https://github.com/matthias-hausberger/beige.git
cd beige
npm install
```

### 3. Build sandbox image

```bash
npm run build:sandbox
```

### 4. Configure

```bash
cp examples/config.json5 config.json5
# Edit config.json5 with your API keys and settings
```

### 5. Run

```bash
# Set required env vars (or put them in config directly)
export ANTHROPIC_API_KEY="sk-..."
export TELEGRAM_BOT_TOKEN="123:ABC..."

npm run dev
```

## Architecture

```
User (Telegram/CLI)
  │
  ▼
Gateway (Node.js)
  ├── LLM (via pi SDK) → Core Tools: read, write, patch, exec
  │                              │
  │                              ▼
  │                        Docker Sandbox
  │                        ├── /workspace (writable)
  │                        ├── /tools/bin (read-only launchers)
  │                        └── /tools/packages (read-only docs)
  │
  └── Unix Socket ← Tool launchers call back for gateway-hosted tools
        │
        ▼
  Policy Engine → Audit Logger → Tool Runner
```

See [docs/](docs/) for full documentation:
- [System Overview](docs/system-overview.md) — architecture diagrams
- [Request Flows](docs/request-flows.md) — sequence diagrams for every request type
- [Security Model](docs/security-model.md) — sandboxing, identity, threat model
- [Tools](docs/tools.md) — how to write and use tools
- [Configuration](docs/configuration.md) — full config reference

## Configuration

Config is a single JSON5 file (JSON with comments). See [examples/config.json5](examples/config.json5).

```json5
{
  llm: {
    providers: {
      anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
    },
  },
  tools: {
    kv: { path: "./tools/kv", target: "gateway" },
  },
  agents: {
    assistant: {
      model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      tools: ["kv"],
    },
  },
  channels: {
    telegram: {
      enabled: true,
      token: "${TELEGRAM_BOT_TOKEN}",
      allowedUsers: [123456789],
      agentMapping: { default: "assistant" },
    },
  },
}
```

## Tools

Tools are simple packages:

```
tools/my-tool/
├── tool.json     # Name, description, commands
├── index.ts      # Handler (gateway-targeted) or logic (sandbox-targeted)
└── README.md     # Documentation (mounted into sandbox for agent context)
```

The agent calls tools via `exec /tools/bin/my-tool <args>`. The launcher routes through the gateway socket for policy checks and execution.

## Security Model

1. **Sandbox isolation**: Agents run in Docker containers with no host env access
2. **Read-only mounts**: Tool code and launchers are mounted read-only
3. **Socket identity**: Agent identity derived from Unix socket (not payload)
4. **Policy engine**: Deny by default, explicit allow per agent per tool
5. **Audit log**: Every tool invocation logged as JSONL

## Project Status

**Phase 1 (current):** Core gateway + KV tool MVP
- [x] Config system
- [x] Docker sandbox manager
- [x] Core tools (read, write, patch, exec)
- [x] Unix socket server for tool routing
- [x] Policy engine
- [x] Audit logging
- [x] KV tool (gateway-hosted)
- [x] Telegram channel (GrammY)
- [x] LLM integration via pi SDK

## License

MIT
