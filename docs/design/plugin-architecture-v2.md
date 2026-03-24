# Beige v2 — Plugin Architecture

> Design document for re-architecting Beige around a unified plugin system.
> Status: **Draft**

---

## 1. Problem Statement

Beige v1 has several first-class concepts that are structurally similar but treated differently:

| Concept | How it works today | Limitation |
|---|---|---|
| **Channels** (Telegram, TUI) | Hardcoded in gateway startup; Telegram is a class in `src/channels/`, TUI is a separate process | Adding a new channel requires modifying gateway code |
| **Tools** | Loaded via `tool.json` manifest + `createHandler()` | Tools can't hook into session lifecycle, can't run background processes, can't intercept messages |
| **Skills** | Read-only knowledge packages mounted into sandboxes | No runtime behaviour, purely static context |

All of these share a common need: **they want to extend gateway behaviour** — by adding tools, running background processes, intercepting messages, creating sessions, or exposing new channels. Today each is a separate mechanism with separate config, separate loading, and separate lifecycle.

### What we want to enable (that we can't today)

1. **Telegram as a plugin** — registers a channel, registers bot-specific tools, runs a background polling process. Moves out of beige core into beige-toolkit.
2. **Cron/scheduler plugin** — runs a background timer, creates sessions and sends prompts on schedule (future)
3. **File watcher plugin** — monitors file changes, triggers agent sessions (future)
4. **Message filter/guardrail plugin** — intercepts messages before/after LLM, blocks or transforms content (future)
5. **Custom channel plugins** — Discord, Slack, webhook, email — without modifying gateway code (future)
6. **Observability plugins** — trace every LLM call, log token usage, export metrics (future)

### Tool binding confusion in sandboxes

Today, tools are exposed in the sandbox as executables at `/tools/bin/<name>`. The agent calls them via `exec: /tools/bin/git clone ...`. This causes confusion:

- Agents see a tool called `git` and assume they should use the system `git` CLI directly
- The `/tools/bin/` path is unfamiliar and agents sometimes forget it
- For tools that wrap CLIs (git, gh, wrangler), the agent doesn't understand that `/tools/bin/git` is different from just `git`

---

## 2. Core Insight: Plugins Subsume Channels and Tools

A **plugin** is the single unit of extension. It can:

- **Register tools** available to agents (what "tools" do today)
- **Register a channel** (what Telegram does today)
- **Register hooks** into the session lifecycle (new capability)
- **Register skills** that are mounted into sandboxes (new capability)
- **Start background processes** tied to the gateway lifecycle (new capability)
- **Provide config schema** that is validated at startup (new capability)

**Channels become a role a plugin can fill**, not a separate top-level concept.

**Tools become something a plugin registers**, alongside hooks and background processes.

**Skills can be provided by plugins** in addition to standalone skill packages.

---

## 3. Why We Still Need the "Channel" Concept

Even though channels are implemented by plugins, the gateway still needs a **channel abstraction** because:

1. **Response routing**: When an agent finishes a prompt, the response must be routed back to whoever asked. A session needs a `replyTo` that knows how to deliver the response.
2. **Session creation**: Channels are the things that *initiate* sessions. The gateway doesn't poll for work — channels push messages in.
3. **Session settings**: Channels can set and modify session configuration (model, thinking level, verbose, streaming, etc.)
4. **Mid-session control**: Channels need to change session settings mid-conversation (e.g. `/model`, `/verbose on`).

The architecture:

```
Plugin
  ├── registers tools (optional)         → into PluginRegistry
  ├── registers hooks (optional)         → into PluginRegistry
  ├── registers skills (optional)        → into PluginRegistry
  ├── registers a channel adapter (opt.) → into PluginRegistry
  └── starts background processes (opt.) → via start()/stop()
```

The gateway knows about "channel adapters" as an interface. Plugins provide implementations. **TUI is the only built-in channel** — it runs as a separate process and connects via HTTP API. Everything else (Telegram, Discord, Slack, webhooks) is a plugin.

---

## 4. Plugin Registry: Everything Gets Registered

In the v2 draft, channels were registered into a registry but tools and hooks were just returned from `createPlugin()`. This is inconsistent. **Everything should be registered through the PluginRegistry.**

This enables:
- **Cross-plugin interaction**: A scheduler plugin can invoke a tool registered by another plugin
- **Introspection**: The gateway can list all registered tools, hooks, channels, skills
- **Ordering control**: Hook execution order is explicit
- **Namespacing**: Tools are namespaced by plugin, conflicts detected at registration time

### 4.1 PluginRegistry

```typescript
interface PluginRegistry {
  // ── Tools ──────────────────────────────────────────────
  registerTool(pluginName: string, tool: PluginTool): void;
  getTool(name: string): PluginTool | undefined;
  getAllTools(): Map<string, PluginTool>;

  // ── Channels ───────────────────────────────────────────
  registerChannel(name: string, adapter: ChannelAdapter): void;
  getChannel(name: string): ChannelAdapter | undefined;

  // ── Hooks ──────────────────────────────────────────────
  registerHook(pluginName: string, hookName: string, handler: HookHandler): void;

  // ── Skills ─────────────────────────────────────────────
  registerSkill(pluginName: string, skill: PluginSkill): void;
  getSkill(name: string): PluginSkill | undefined;
  getAllSkills(): Map<string, PluginSkill>;
}
```

### 4.2 Tool Naming

All tools registered by a plugin **must** start with the plugin name. A single-tool plugin registers a tool with exactly the plugin name. Multi-tool plugins use `pluginName.toolName`:

| Plugin | Tool registration | Agent references as |
|---|---|---|
| `wrangler` (single tool) | `wrangler` | `wrangler` |
| `git` (single tool) | `git` | `git` |
| `telegram` (multi-tool) | `telegram.send_message`, `telegram.get_chat_info` | `telegram.send_message` |

This is **enforced at registration time** — `PluginRegistrar.tool()` rejects any tool name that doesn't equal or start with `pluginName.`. Combined with unique plugin names (enforced by config validation), this guarantees no tool name collisions across plugins.

---

## 5. Fixing Tool Binding in Sandboxes

### 5.1 The Problem

Currently tools are at `/tools/bin/<name>` and agents call them via `exec: /tools/bin/git clone ...`. Agents often:
- Try `exec: git clone ...` (system git, which may not exist or lacks auth)
- Forget the `/tools/bin/` prefix
- Don't understand why `/tools/bin/git` exists alongside system `git`

### 5.2 The Solution: Tools on PATH + Shadowing

**Put `/tools/bin` first on the PATH inside the sandbox.** This way:

```bash
# Agent writes:
exec: git clone https://github.com/...

# This actually runs /tools/bin/git, which is the beige tool wrapper
# No confusion, no special paths to remember
```

The launcher scripts in `/tools/bin/` already exist and work — they call the tool-client which routes to the gateway. We just need to ensure `/tools/bin` is prepended to `$PATH` in the container.

This means:
- `exec: git status` → runs the beige git tool (auth, sandboxing, policy)
- `exec: wrangler deploy` → runs the beige wrangler tool (auth, sandboxing, policy)
- Tools that wrap CLIs feel natural — agents use them exactly as they'd use the real CLI

### 5.3 System Prompt Update

The system prompt changes from:

```
Additional tools are available as executables in `/tools/bin/`. Run them with `exec`.
```

To:

```
Additional tools are installed and available on your PATH. Use them naturally with `exec`:
  exec: git status
  exec: wrangler deploy
Tool documentation is at /tools/packages/<name>/SKILL.md — read this before first use.
```

### 5.4 Container Changes

In the Dockerfile or container creation:

```dockerfile
ENV PATH="/tools/bin:$PATH"
```

Or in `SandboxManager.createSandbox()`:

```typescript
Env: [
  "PATH=/tools/bin:/usr/local/bin:/usr/bin:/bin",
  ...Object.entries(agentConfig.sandbox?.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
],
```

---

## 6. Session Model

### 6.1 Mutable Session State

A session stores the following state, all of which can be read and modified by channels mid-session:

| Field | Type | Set by | Mutable? | Description |
|---|---|---|---|---|
| `agentName` | `string` | channel at creation | No | Which agent owns this session |
| `model` | `ModelRef` | channel / config default | Yes | Current LLM model |
| `thinkingLevel` | `ThinkingLevel` | channel / config default | Yes | Extended thinking budget |
| `replyTo` | `ReplyTarget` | channel | Yes | Where to route responses (channel-specific) |
| `verbose` | `boolean` | channel / config default | Yes | Show tool-call notifications |
| `streaming` | `boolean` | channel / config default | Yes | Stream responses in real-time |
| `channel` | `string` | channel at creation | No | Which channel created this session |
| `metadata` | `Record<string, unknown>` | plugins | Yes | Plugin-attached arbitrary metadata |

### 6.2 ReplyTarget

```typescript
interface ReplyTarget {
  /** Which channel to route the response to */
  channel: string;
  /** Channel-specific addressing (chat ID, thread ID, webhook URL, etc.) */
  address: Record<string, string>;
}
```

### 6.3 Session Settings API

Channels and plugins can modify session state via `PluginContext`:

```typescript
interface PluginContext {
  // ... other methods ...

  /** Get a session's current settings */
  getSessionSettings(sessionKey: string): SessionSettings;

  /** Update session settings (partial update, deep-merged) */
  updateSessionSettings(sessionKey: string, update: Partial<SessionSettings>): void;

  /** Attach/update plugin metadata on a session */
  setSessionMetadata(sessionKey: string, key: string, value: unknown): void;
  getSessionMetadata(sessionKey: string, key: string): unknown;
}
```

This replaces the current `SessionSettingsStore` with a unified API that any plugin can use, not just channels.

---

## 7. Plugin Interface

### 7.1 Plugin Manifest (`plugin.json`)

```json5
{
  "name": "telegram",
  "version": "1.0.0",
  "description": "Telegram bot channel for Beige",

  // What this plugin provides (declarative, for validation + introspection)
  "provides": {
    "channel": true,
    "tools": ["telegram.send_message", "telegram.get_chat_info"],
    "hooks": ["sessionCreated"],
    "skills": []
  },

  // Config schema (JSON Schema) — validated against plugin config in beige config
  "configSchema": {
    "type": "object",
    "required": ["token", "allowedUsers"],
    "properties": {
      "token": { "type": "string" },
      "allowedUsers": { "type": "array", "items": { "type": "number" } },
      "agentMapping": {
        "type": "object",
        "properties": { "default": { "type": "string" } }
      }
    }
  }
}
```

### 7.2 Plugin Entry Point (`index.ts`)

```typescript
import type { PluginContext, PluginRegistrar } from "beige";

export function createPlugin(config: TelegramConfig, ctx: PluginContext): PluginInstance {
  const bot = new TelegramBot(config.token);

  return {
    // Called during plugin loading — register everything here
    register(reg: PluginRegistrar): void {
      // Register channel
      reg.channel({
        name: "telegram",
        sendMessage: async (chatId, threadId, text, opts) => { ... },
      });

      // Register tools
      reg.tool({
        name: "telegram.send_message",
        description: "Send a proactive message to a Telegram chat",
        handler: async (args, sessionContext) => { ... },
      });

      // Register hooks
      reg.hook("sessionCreated", async (event) => { ... });

      // Register skills (read-only knowledge mounted into sandbox)
      reg.skill({
        name: "telegram-guide",
        path: "/path/to/skill/dir",
        description: "How to use Telegram tools effectively",
      });
    },

    // Called after all plugins are registered and gateway infra is ready
    async start(): Promise<void> {
      // Start Telegram polling
      bot.on("message:text", async (botCtx) => {
        const sessionKey = `telegram:${botCtx.chat.id}`;
        const agentName = config.agentMapping.default;
        const response = await ctx.prompt(sessionKey, agentName, botCtx.message.text, {
          channel: "telegram",
          replyTo: { channel: "telegram", address: { chatId: String(botCtx.chat.id) } },
        });
      });
      await bot.start();
    },

    // Called on gateway shutdown (reverse order of start)
    async stop(): Promise<void> {
      await bot.stop();
    },
  };
}
```

### 7.3 PluginContext (provided by the gateway to plugins)

```typescript
interface PluginContext {
  // ── Session operations ─────────────────────────────────
  prompt(sessionKey: string, agentName: string, message: string, opts?: PromptOpts): Promise<string>;
  promptStreaming(sessionKey: string, agentName: string, message: string,
                  onDelta: (d: string) => void, opts?: PromptOpts): Promise<string>;
  newSession(sessionKey: string, agentName: string): Promise<void>;

  // ── Session settings ───────────────────────────────────
  getSessionSettings(sessionKey: string): SessionSettings;
  updateSessionSettings(sessionKey: string, update: Partial<SessionSettings>): void;
  setSessionMetadata(sessionKey: string, key: string, value: unknown): void;
  getSessionMetadata(sessionKey: string, key: string): unknown;

  // ── Cross-plugin tool invocation ───────────────────────
  /** Invoke a registered tool by name (from any plugin) */
  invokeTool(toolName: string, args: string[], sessionContext?: SessionContext): Promise<ToolResult>;

  // ── Config & info ──────────────────────────────────────
  config: Readonly<BeigeConfig>;
  agentNames: string[];

  // ── Plugin registry (read-only view) ───────────────────
  getChannel(name: string): ChannelAdapter | undefined;
  getRegisteredTools(): string[];

  // ── Logging ────────────────────────────────────────────
  log: Logger;
}

interface PromptOpts {
  channel?: string;
  replyTo?: ReplyTarget;
  onToolStart?: (toolName: string, params: Record<string, unknown>) => void;
}
```

Note `invokeTool()` — this is how plugins interact with each other. A scheduler plugin can call `ctx.invokeTool("wrangler", ["deploy"])` or `ctx.invokeTool("exec", ["ls", "-la"])`. The gateway routes to the registered handler regardless of which plugin provided it.

---

## 8. Config

### 8.1 v2 Config Structure

```json5
{
  llm: { providers: { ... } },

  // Plugins replace both `tools` and `channels`
  plugins: {
    // A tool-only plugin (single tool, name matches plugin name)
    kv: {
      path: "./tools/kv",
      config: { storagePath: "/tmp/kv" },
    },

    // CLI-wrapping tools
    git: {
      path: "@matthias-hausberger/beige-toolkit/plugins/git",
      config: { allowForcePush: false },
    },

    wrangler: {
      path: "@matthias-hausberger/beige-toolkit/plugins/wrangler",
      config: { apiToken: "${CLOUDFLARE_API_TOKEN}" },
    },

    // Telegram: channel + tools + background process
    telegram: {
      path: "@matthias-hausberger/beige-toolkit/plugins/telegram",
      config: {
        token: "${TELEGRAM_BOT_TOKEN}",
        allowedUsers: [12345],
        agentMapping: { default: "assistant" },
        defaults: { verbose: false, streaming: true },
      },
    },

    // spawn: uses PluginContext to interact with agent manager
    spawn: {
      path: "@matthias-hausberger/beige-toolkit/plugins/spawn",
      config: {
        maxDepth: 2,
        targets: { assistant: {}, "SELF": {} },
      },
    },
  },

  // Skills stay as standalone packages (plugins can also register skills)
  skills: {
    "code-review": { path: "./skills/code-review" },
  },

  agents: {
    assistant: {
      model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      // Tools reference plugin-registered tool names
      tools: ["git", "wrangler", "telegram.send_message", "spawn"],
      skills: ["code-review"],
      // Per-agent plugin config overrides (deep-merged with plugin base config)
      pluginConfigs: {
        git: { allowForcePush: true },
      },
    },
  },

  gateway: { host: "127.0.0.1", port: 7433 },
}
```

### 8.2 Breaking Changes from v1

This is a major version. No backward compatibility aliases:

- `tools` config key → `plugins`
- `channels` config key → removed (Telegram is a plugin)
- `agent.toolConfigs` → `agent.pluginConfigs`
- `tool.json` manifest → `plugin.json` manifest
- `createHandler()` export → `createPlugin()` export
- `channels.telegram` → `plugins.telegram`

### 8.3 Config Validation

- Plugin names must be unique
- Tool names must be unique across all plugins
- Agent tool references must resolve to registered tools
- Plugin config is validated against the plugin's `configSchema`
- `pluginConfigs` keys must reference plugins the agent actually uses (via tools)

---

## 9. Hook System

Hooks execute in plugin registration order (= config order). Async, awaited sequentially.

### 9.1 Available Hooks

| Hook | When | Can modify/block? | Use cases |
|---|---|---|---|
| `prePrompt` | Before user message → LLM | Transform message, block it | Content filtering, prompt injection detection |
| `postResponse` | After LLM response, before delivery | Transform response, block it | Content filtering, post-processing |
| `preToolExec` | Before a tool executes | Allow/deny | Policy enforcement, audit |
| `postToolExec` | After a tool executes | Transform result | Audit, caching |
| `sessionCreated` | New session created | Observe only | Analytics, welcome messages |
| `sessionDisposed` | Session cleaned up | Observe only | Cleanup |
| `gatewayStarted` | After all plugins loaded + started | Observe only | Health checks |
| `gatewayShutdown` | Before gateway shuts down | Observe only | Cleanup |

### 9.2 Hook Execution Model

```
User message arrives (via channel plugin or TUI API)
  │
  ▼
prePrompt hooks (sequential, can transform/block)
  │
  ▼
AgentManager.prompt() — LLM call with tool loop
  │ (for each tool call)
  ├── preToolExec hooks
  ├── tool execution
  └── postToolExec hooks
  │
  ▼
postResponse hooks (sequential, can transform/block)
  │
  ▼
Response delivered back to channel
```

---

## 10. Plugin Loading & Lifecycle

```
Gateway.start()
  │
  ├── 1. Load config
  ├── 2. Resolve plugin paths (npm, GitHub, local — same as current tool installer)
  ├── 3. Validate plugin manifests + config schemas
  ├── 4. Create PluginContext + PluginRegistry
  ├── 5. For each plugin (in config order):
  │      ├── import plugin entry point
  │      ├── call createPlugin(config, ctx) → get PluginInstance
  │      └── call plugin.register(registry) → tools, hooks, channels, skills registered
  ├── 6. Validate: all agent tool references resolve, no name conflicts
  ├── 7. Set up sandboxes (PATH includes /tools/bin), agent manager, etc.
  ├── 8. For each plugin: call plugin.start() (background processes)
  ├── 9. Start HTTP API
  ├── 10. Fire "gatewayStarted" hooks
  │
  ▼ On shutdown:
  ├── Fire "gatewayShutdown" hooks
  ├── For each plugin (reverse order): call plugin.stop()
  └── Tear down sandboxes, API, etc.
```

---

## 11. How Existing Features Map to Plugins

### 11.1 Telegram → Plugin in beige-toolkit

Today: `src/channels/telegram.ts` — ~400 lines hardcoded in gateway.

As a plugin in `beige-toolkit/plugins/telegram/`:
- **Channel**: registers `telegram` channel adapter
- **Background process**: `start()` begins GrammY polling
- **Tools**: `telegram.send_message`, `telegram.get_chat_info`
- **Config**: same as today's `channels.telegram`, under `plugins.telegram.config`

Telegram is **removed from beige core**. The gateway has zero knowledge of Telegram.

### 11.2 TUI → Stays as built-in client

TUI is the **only built-in channel**. It runs as a separate process (`beige tui agent`), connects via HTTP API. Not a plugin — it's a client of the gateway.

### 11.3 Existing toolkit tools → Plugin format

Each tool in `beige-toolkit/tools/` becomes a plugin in `beige-toolkit/plugins/`. The migration is mechanical:

```typescript
// v1: tools/git/index.ts
export function createHandler(config, ctx) {
  return async (args, _, sessionContext) => { ... };
}

// v2: plugins/git/index.ts
export function createPlugin(config, ctx) {
  return {
    register(reg) {
      reg.tool({
        name: "git",
        description: "...",
        commands: [...],
        handler: async (args, sessionContext) => { ... },
      });
    },
    async start() {},
    async stop() {},
  };
}
```

### 11.4 `spawn` tool → Plugin with PluginContext

The `spawn` tool currently uses `ToolHandlerContext` to access `agentManagerRef`, `sessionStore`, and `beigeConfig`. In v2, these are accessed through `PluginContext` — cleaner:

```typescript
export function createPlugin(config, ctx: PluginContext) {
  return {
    register(reg) {
      reg.tool({
        name: "spawn",
        handler: async (args, sessionContext) => {
          // ctx.prompt() replaces agentManagerRef.current.prompt()
          const response = await ctx.prompt(sessionKey, targetAgent, message);
          return { output: response, exitCode: 0 };
        },
      });
    },
  };
}
```

---

## 12. Plugin-Provided Skills

Plugins can register skills that get mounted into sandboxes alongside standalone skills:

```typescript
register(reg) {
  reg.skill({
    name: "telegram-guide",
    path: resolve(__dirname, "skill"),  // directory containing SKILL.md, README.md
    description: "Guide for using Telegram tools",
  });
}
```

These are mounted at `/skills/<name>/` in the sandbox, same as standalone skills. The agent config references them the same way:

```json5
agents: {
  assistant: {
    skills: ["code-review", "telegram-guide"],
  },
}
```

The difference is just where the skill comes from — standalone `skills` config or a plugin registration.

---

## 13. Decisions

| Question | Decision |
|---|---|
| Plugin isolation | In-process. Worker threads are a future option. |
| Plugin ordering | Config order. No priority field. |
| Hot reload | No. Use `beige gateway restart`. |
| Plugin discovery | Same as current tool installer (npm, GitHub, local path). CLI updated accordingly. |
| Backward compatibility | None. Breaking v2 release. |
| Plugin SDK package | No separate package. Export plugin interfaces from beige itself. beige-toolkit already depends on beige. Third-party authors add beige as a dev dependency. Extract into separate package later if needed. |
| Tool naming | Tools must start with plugin name (`git` or `telegram.send_message`). Enforced at registration time. |
| New plugins (scheduler, etc.) | Not in scope for this effort. Infrastructure only + migration of existing tools/Telegram. |

---

## 14. Implementation Plan

### Phase 1: Plugin interfaces (in beige)
- [ ] Define and export from beige: `PluginInstance`, `PluginContext`, `PluginRegistrar`, `PluginManifest`
- [ ] Define and export: `PluginTool`, `ChannelAdapter`, `HookHandler`, `PluginSkill`
- [ ] Define and export: `SessionSettings`, `ReplyTarget`, hook event types

### Phase 2: Plugin infrastructure in gateway
- [ ] Create `PluginRegistry` (tools, channels, hooks, skills)
- [ ] Create plugin loader (resolve paths, import, validate manifests, validate config schemas)
- [ ] Create hook execution pipeline (pre/post prompt, pre/post tool exec, session lifecycle, gateway lifecycle)
- [ ] Implement `PluginContext` (wraps AgentManager, SessionStore, ToolRunner, config)
- [ ] Update `SessionSettings` / `SessionSettingsStore` to support full mutable session state (model, thinkingLevel, replyTo, verbose, streaming, channel, metadata)
- [ ] Refactor `Gateway.start()` to: load plugins → register → set up infra → start plugins
- [ ] Update config schema: `plugins` replaces `tools` + `channels`, `pluginConfigs` replaces `toolConfigs`
- [ ] Update config validation for new schema

### Phase 3: Fix tool binding in sandboxes
- [ ] Prepend `/tools/bin` to `$PATH` in sandbox containers (Dockerfile + SandboxManager)
- [ ] Update system prompt template to instruct agents to use tools naturally (`exec: git status` not `exec: /tools/bin/git status`)
- [ ] Update SKILL.md templates in toolkit tools to reflect new usage
- [ ] Test that PATH shadowing works correctly (tool launcher > system binary)

### Phase 4: Migrate Telegram to beige-toolkit plugin
- [ ] Create `beige-toolkit/plugins/telegram/` with `plugin.json` + `index.ts`
- [ ] Plugin registers channel, tools (`telegram.send_message`), starts GrammY polling
- [ ] Move all Telegram-specific code from `beige/src/channels/telegram.ts`
- [ ] Remove `channels` from beige config schema
- [ ] Remove `src/channels/telegram.ts` and `TelegramChannelConfig` from beige core
- [ ] Keep `ChannelAdapter` interface in beige (or plugin SDK) — it's the contract plugins implement
- [ ] Update beige-toolkit CI/CD

### Phase 5: Migrate existing toolkit tools to plugin format
- [ ] Convert `tool.json` → `plugin.json` for each tool
- [ ] Convert `createHandler()` → `createPlugin()` for each tool
- [ ] Update tool installer CLI: `beige plugins install` (replaces `beige tools install`)
- [ ] Update beige-toolkit repo structure: `tools/` → `plugins/`
- [ ] Update all tests

### Phase 6: Documentation + Examples
- [ ] Plugin development guide (how to write a plugin)
- [ ] Migration guide (v1 → v2 for existing tool authors)
- [ ] Update architecture docs
- [ ] Update config reference docs
- [ ] Example: minimal tool-only plugin
- [ ] Example: channel plugin with background process
- [ ] Update AGENTS.md template

---

## 15. Summary

The key architectural change is **unifying tools, channels, and new extension points under a single plugin abstraction**:

- **Plugins** are the single unit of extension — they register tools, channels, hooks, and skills
- **Everything gets registered** through `PluginRegistrar`, enabling cross-plugin interaction and introspection
- **Telegram moves to beige-toolkit** — TUI is the only built-in channel
- **Tools go on PATH** — agents call `exec: git status` not `exec: /tools/bin/git status`
- **Sessions have rich mutable state** — model, thinkingLevel, verbose, streaming, replyTo, metadata — all changeable mid-session by channels and plugins
- **Hooks** enable message interception, policy enforcement, and observability
- **Plugin interfaces** are exported from beige itself — no separate SDK package needed
- **No new plugins** in this effort — infrastructure + migration only
