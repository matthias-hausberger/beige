![Cover](https://github.com/matthias-hausberger/beige/blob/main/docs/assets/beige_landscape.png?raw=true)

[![NPM](https://nodei.co/npm/@matthias-hausberger/beige.svg?style=compact&color=yellow)](https://nodei.co/npm/@matthias-hausberger/beige/)
[![CI](https://github.com/matthias-hausberger/beige/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/matthias-hausberger/beige/actions/workflows/ci.yml)

Beige is a secure, open-source, sandboxed agent system where AI agents write and execute code inside Docker containers. The gateway orchestrates LLM calls, enforces policies, audit-logs every tool invocation, and routes tool execution.

**[Documentation](https://beige.mintlify.app)** — Full docs at beige.mintlify.app

---

## Key Features

### What's common to tools like [OpenClaw](https://openclaw.ai/)

- **Channels** — Interact via TUI, Telegram, HTTP API, or custom channels
- **Skills** — Read-only knowledge packages for agent context
- **Tools** — Extensible tool system for agent capabilities
- **Policy Enforcement** — Fine-grained control over what agents can do
- **Audit Logging** — Every tool invocation is logged for accountability

### What's _different_

- **[Tools become CLI executables](#true-autonomy)** — Agents write scripts that call tools directly, eliminating round-trips through the LLM
- **Docker Sandboxing — always** — All code execution happens in isolated containers with no escape hatch. Communication to the gateway via sockets.
- **Nothing out-of-the-box** — You configure agents the way YOU want

---

## Why Beige? {#why-beige}

### True Autonomy {#true-autonomy}

Traditional tool-calling requires the LLM to invoke tools one at a time. Each result goes back through the model, wasting tokens and time. Complex workflows require dozens of individual tool calls.

**Beige agents can write and run code.** Instead of calling a tool 20 times, the agent writes a script that does it in a loop. The LLM only sees the final result.


| Beige                                                              | Traditional LLM                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| **1 round-trip** — agent writes a script, runs it, gets one result | **20 round-trips** — each tool call goes through the model |
| 20 KV lookups happen inside the sandbox                            | 20× the latency, 20× the token overhead                    |


### Beige — write then exec

The agent writes a TypeScript file, then executes it. One round-trip to the LLM.

```typescript fetch-users.ts
const users = [];
for (let i = 1; i <= 20; i++) {
  const result = await exec(`/tools/bin/kv get user:${i}`);
  users.push(JSON.parse(result));
}
console.log(JSON.stringify(users));
```

```bash
write /workspace/fetch-users.ts
exec deno run /workspace/fetch-users.ts
```

**Result returned to LLM:** one JSON array — done.

**Every tool call — including the ones called by a script — is routed through the gateway.** The gateway checks permissions, enforces policy, and ensures secrets never reach the sandbox.

### Traditional LLM

Without a code runtime the LLM must call the tool once per item. Slow, unsafe, error-prone, not easily reproducible:

```
→ tool_call: kv get user:1
← result: {"id":1,"name":"Alice"}
→ tool_call: kv get user:2
← result: {"id":2,"name":"Bob"}
... 18 more calls ...
```

---

## Quick Start

**Prerequisites:** Node.js 22+, Docker

Install Beige globally:

```bash
npm install -g @matthias-hausberger/beige
```

Set your Anthropic API key (you can also set this in your `~/.beige/config.json5` config after you started the gateway for the first time):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Start the gateway:

```bash
beige gateway start
```

Open the TUI. Alternatively you can also use [Telegram](https://beige.mintlify.app/channels/telegram) or add your own channel plugin:

```bash
beige tui
```

On first run, Beige creates `~/.beige/` with a default config and the bundled KV tool.

You can also use **[any other LLM Provider](https://beige.mintlify.app/agents/providers)**.

See the [installation guide](https://beige.mintlify.app/installation) for details.

---

## Documentation

Full documentation at **[beige.mintlify.app](https://beige.mintlify.app)**:


| Section                                                             | Description                                 |
| ------------------------------------------------------------------- | ------------------------------------------- |
| [Getting Started](https://beige.mintlify.app/installation)          | Install and run your first agent            |
| [Gateway](https://beige.mintlify.app/gateway)                       | Core concepts, tool calls, operations       |
| [Agents](https://beige.mintlify.app/agents)                         | Configure providers, models, tools, skills  |
| [Channels](https://beige.mintlify.app/channels)                     | TUI, Telegram, HTTP API                     |
| [Tools](https://beige.mintlify.app/tools)                           | Core tools, building custom tools, toolkits |
| [Config Reference](https://beige.mintlify.app/agents/configuration) | Complete config file reference              |
| [CLI Reference](https://beige.mintlify.app/cli)                     | All CLI commands and flags                  |


---

## Contributing

All contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

For source installs, Beige runs entirely inside the repo — no files are written to your home directory.

Clone and install:

```bash
git clone https://github.com/matthias-hausberger/beige.git
cd beige
pnpm install
```

Run setup:

```bash
pnpm run beige setup
```

This sets `BEIGE_HOME=./.beige` automatically, so the repo is self-contained.

---

## License

MIT