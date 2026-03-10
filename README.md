# Beige

Secure, sandboxed agent system. Let agents write and execute code — safely.

**📚 [Documentation](https://beige.mintlify.app)** — Full docs at beige.mintlify.app

## What is Beige?

Beige is an open-source agent gateway that runs AI agents inside Docker sandboxes. Agents have 4 core tools (`read`, `write`, `patch`, `exec`) and can use additional tools exposed as executables. All tool calls route through the gateway for policy enforcement and audit logging.

**Key principles:**
- 🔒 **Sandboxed** — Every agent runs in its own Docker container. No access to host env vars, secrets, or files.
- 📋 **Audited** — Every tool call is logged with agent identity, args, timing, and permission decision.
- 🛡️ **Policy-enforced** — Deny by default. Agents can only use tools explicitly granted in config.
- 🔌 **Extensible** — Add tools as simple packages. They mount into sandboxes read-only.
- 🤖 **LLM-agnostic** — Uses [pi SDK](https://pi.dev) for LLM interaction. Supports Anthropic, OpenAI, ZAI, and more.

## Quick Start

Beige has two install modes. Pick the one that fits you.

### Option A — npm global (recommended for most users)

**Prerequisites:** Node.js 22+, Docker

```bash
npm install -g matthias-hausberger/beige
```

On first run, beige automatically creates `~/.beige/` with a default config and the bundled KV tool:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

# Shell 1 — start the gateway
beige gateway start

# Shell 2 — open the TUI
beige tui
```

You can also run setup explicitly:

```bash
beige setup
```

### Option B — Source install (contributors / power users)

**Prerequisites:** Node.js 22+, Docker

```bash
git clone https://github.com/matthias-hausberger/beige.git
cd beige
npm install
npm run build:sandbox       # build the sandbox Docker image
```

No files are written outside the repo. Configure manually:

```bash
cp examples/config.json5 ~/.beige/config.json5
# Edit ~/.beige/config.json5: set your API key and adjust tool paths
export ANTHROPIC_API_KEY="sk-ant-..."

# Shell 1
npx tsx src/cli.ts gateway start --foreground

# Shell 2
npx tsx src/cli.ts tui
```

See [docs/installation.md](docs/installation.md) for a full comparison of both modes.

### TUI Commands

Once inside the TUI, these slash commands are available:

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh conversation session |
| `/resume` | Pick a previous session to continue |
| `/sessions` | List saved sessions for the current agent |
| `/agent [name]` | Switch to a different beige agent (with tab-completion) |

## Architecture

```
Channels
  ├── TUI (pi interactive mode)
  └── Telegram bot
        │
        ▼
  Gateway (always running)
  ├── Agent Manager → LLM (via pi SDK) → Core Tools
  │                                            │
  │                                            ▼
  │                                      Docker Sandbox
  │                                      ├── /workspace (rw)
  │                                      ├── /tools/bin (ro)
  │                                      └── /tools/packages (ro)
  │
  └── Unix Socket ← Tool launchers call back to gateway
        │
        ▼
  Policy Engine → Audit Logger → Tool Runner
```

## Documentation

Full documentation is available at **[beige.mintlify.app](https://beige.mintlify.app)**:

| Section | Description |
|---------|-------------|
| [**Introduction**](https://beige.mintlify.app/introduction) | What Beige is, why we built it, and how it works |
| [**Getting Started**](https://beige.mintlify.app/getting-started) | Install and run your first agent |
| [**The Gateway**](https://beige.mintlify.app/gateway) | Deep dive into architecture and security |
| [**Agents**](https://beige.mintlify.app/agents) | Configure providers, models, tools, and skills |
| [**Channels & Tools**](https://beige.mintlify.app/channels-and-tools) | TUI, Telegram, HTTP API, and extensibility |

### Reference Documentation

- [Configuration Reference](docs/configuration.mdx) — Complete config file reference
- [Tools Reference](docs/tools.mdx) — Tool packages, launchers, socket protocol
- [Toolkits Reference](docs/toolkits.mdx) — Installing and creating toolkits
- [Skills Reference](docs/skills.mdx) — Creating knowledge packages
- [HTTP API Reference](docs/api.mdx) — Full REST API reference
- [Security Model](docs/security-model.mdx) — Threat model and defense in depth

### Design Documents

- [Vision](project/vision.md) — Original design goals
- [Use Cases](project/usecases.md) — Personal use cases that motivated the project

### External Resources

- [pi SDK](https://pi.dev) — The LLM SDK that powers Beige
- [OpenClaw](https://openclaw.ai) — Inspiration for personal agents
- ["What if you don't need MCP?"](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) — Why CLI tools beat MCP bloat
- ["Code Mode"](https://blog.cloudflare.com/code-mode/) — Why LLMs are better at writing code than calling tools

## Configuration

Config is a single JSON5 file (JSON with comments) at `~/.beige/config.json5`. See [examples/config.json5](examples/config.json5) for a template.

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
- [x] Interactive TUI (via pi SDK InteractiveMode)
- [x] LLM integration via pi SDK

## License

MIT
