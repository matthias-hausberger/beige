## Goal

Design a secure, local-first agent system where:

* **pi-coding-agent** is the core orchestrator (“gateway” + agent manager).
* **All agent operations run inside a per-agent sandbox**.
* Tools are exposed to the agent as **read-only executables** inside the sandbox.
* Tool execution always routes through the **gateway** over a socket so the gateway can:

  * authenticate the caller (sandbox/container identity),
  * enforce permissions,
  * log every invocation,
  * route execution (gateway host vs sandbox vs future external nodes).

Initially implement only the “core” plus a single “hello world”-level gateway tool:

* **`kv.set` / `kv.get`** (set value / get value), executed on the **gateway host**, to validate the routing/auth/policy/logging model.

Input channel is **Telegram**. The gateway allows to enable certain services at startup, and we implement telegram via GrammY.

The agent can run TypeScript scripts via `exec` **inside its sandbox**; those scripts can call tool executables to form toolchains.

---

## Tool Terminology
- "Core Tools" are the _actual_ tools that are exposed to the LLM. The LLM can call these tools directly. The ONLY core tools are
    - `read`(read file)
    - `write` (write file)
    - `patch` (patch file (if that is something we can provide easily))
    - `exec` (execute)
- "Tools" are _bin_ exectuables that are exposed in the sandbox in `/tools` (by the gateway / config). The LLM can call these by using the `exec` core tool.

---

## Core Constraints

1. **Sandboxing**

* Every agent runs in its own sandbox. (the actual AI calls are made by the gateway, but ALL tool calls are started within the sandbox)
* The agent’s `exec` (and other core tools) runs inside the sandbox only.
* Sandboxes:

  * can run and execute code inside the sandbox, run crons and anything they need / want to.
  * have read-only mounts for tools and tool executables.

2. **Single Tool Routing Path**

* Even when a tool “runs in the sandbox,” its invocation must still be:

  * routed through gateway (for logging + policy decisions), and then
  * executed in the correct location (sandbox/gateway node).
* Avoid “hidden” bypass paths.

3. **Gateway as Policy + Logging Authority**

* Only the gateway owns/uses:

  * agent configs,
  * tool permissions,
  * tool parameter/config injection (e.g. allowlists, per-tool defaults),
  * LLM Provider API Keys
  * audit logs.

4. **Tool Exposure Model**

* Tools appear inside sandbox as read-only executables (launchers).
* The agent chooses which executable to run.
* Where it runs (gateway vs sandbox vs node) is encoded in executable identity (e.g. `tool@target`), but the gateway must still enforce permissions.

5. **Config Model**

* Per agent: allow a tool to be exposed multiple ways (same source, different target/config).
* Example concept:

  * `slack@gateway` and `slack@sandbox` can both exist as separate executables.
* Tool configuration parameters (e.g. allowlist for future net tool) are stored only in gateway, injected/checked at runtime.

---

### A) System Architecture (high-level)

Define the components and their responsibilities:

1. **Telegram Adapter**

   * Receives messages
   * routes to correct agent session
   * sends agent outputs back

2. **pi-coding-agent Gateway Core**

   * agent registry
   * tool registry
   * policy engine
   * sandbox manager
   * routing layer (gateway vs sandbox vs future node)
   * logging/audit layer

3. **Sandbox Runtime (per agent)**

   * executes TypeScript via `exec`
   * mounts:

     * `/workspace` (writable)
     * `/tools/packages` (read-only) - this includes the whole tool package, including READMEs, Skills, logic etc. for better context if necessary
     * `/tools/bin` (read-only) - this includes the executable tools
   * has a single gateway socket available for tool routing

4. **Tool Execution Targets**

   * `gateway host` target (initially used by kv tool)
   * `sandbox` target (future tools - NOT NEEDED YET)
   * `external nodes` target (future - NOT NEEDED YET)

5. **Tool Packaging + Projection**

   * tools are stored in repo as single folders (“tool packages”)
   * gateway projects tools into sandboxes via mounts
   * gateway generates per-agent executable wrappers based on config

Deliverable: a clear diagram/description of data flows:
Telegram → Gateway -> LLM -> exec TOOL call → Sandbox exec → Tool launcher → Gateway socket → Tool runner → result → back.

---

### B) Identity + Auth Model for Tool Calls (high-level)

Define how the gateway knows a tool request truly came from a specific sandbox/container:

* gateway ↔ sandbox connected via **socket**
* gateway derives sandbox identity from the connection itself (not payload metadata)
* map sandbox identity → agent identity → agent tool policy

Include:

* threat model for spoofing agent_id in payload
* rules: gateway injects agent identity, ignores any self-claimed identity

---

### C) Tool Configuration + Permissions Model

Specify:

* agent config format (conceptual)
* how a tool can be exposed multiple times with different targets/configs
* permission checks happen in gateway

Must support:

* target selection: gateway / sandbox
* per-tool config: allowlists, defaults, rate limits, etc.
* “deny by default” policy

---

### D) Tool Invocation Protocol (conceptual)

* request contains:

  * executable/tool name (or tool id)
  * args
  * working directory context (optional)
* response contains:

  * exit code
  * stdout/stderr
  * structured JSON output (recommended)
* gateway logs:

  * agent id
  * tool id
  * target
  * args (redacted rules later)
  * timestamps + duration
  * decision (allowed/denied)

No implementation details needed—just what must exist.

---

### E) Minimal “KV Tool” (MVP)

Define the MVP tool as the validation harness:

* Provide two commands:

  * `kv.set <key> <value>`
  * `kv.get <key>`
* It **executes on gateway host**
* It’s exposed into the sandbox as an executable (e.g. `kv`)
* Demonstrate expected workflow:

  * Telegram user asks agent to store something
  * agent writes a small TypeScript script and calls `kv.set`
  * agent retrieves it with `kv.get`
  * gateway enforces permission and logs both calls

This MVP should confirm:

* socket routing works
* identity binding works
* permission checks work
* logging works
* read-only mounts work

---

### F) Read-only Mount Strategy

* Tool packages mounted read-only into sandbox
* Generated executables mounted read-only into sandbox
* Only `/workspace` is writable
* Explain why:

  * prevents agent from modifying tool code
  * enables on-demand reading of docs/source

---

### G) Script Toolchains (TypeScript in sandbox)

* agent can write `.ts` files (or any other language) into `/workspace`
* agent can execute them via `exec`
* scripts can invoke tool executables (which route through gateway)
* goal: allow tool chaining for better automation

---

### H) Extension Points

3. **Additional channels**

   * CLI - if possible somehow, we could either a) create our own small CLI tool or b) use the pi-mono CLI to talk to our agent.

---

## Success Criteria for Phase 1

By the end of “core + kv tool”:

* You can talk to the agent via Telegram.
* The agent runs all computation in its sandbox.
* The agent can execute TypeScript scripts in sandbox.
* The agent can call `kv.set` and `kv.get` from sandbox.
* Tool calls route through the gateway socket.
* Gateway logs every tool call.
* Gateway enforces per-agent permission for the tool.
* Tool code + executables are mounted read-only.

---

### I) Gateway config

The gateway config determines the setup. There are no defaults, we set things up per agent or tool or LLM.
Config includes:
* LLM providers - including the different providers, API keys etc.
* Tool registry object like
```
tools: {
    "slack": {
        path: "./packages/slack", // this is a package folder of the slack tool. It will have one index.ts file that is used as the executable, the rest is context.
        host: "gateway",
        config: {...}, // whatever config can be made for this
    },
    "slack@sandbox": {
        path: "./packages/slack",
        host: "sandbox",
        config: {...}, // whatever other config can be made for this
    },
    "browser":....
}
```
* Agent config object with different agents, which includes:
    * Primary LLM Provider with fallbacks
    * List of tools (from tools registry) that agent is allowed to mount
    * sandbox config (extra bindings, different docker image)

(Maybe something else is missing here - to be validated)


### J) Gateway core logic

1. Config starts up which:
    1. Sets up the docker containers with the respective bindings to the tools that they have access to
1. Start up any channel service that listens to incoming requests (GrammY).
1. Start up gateway socket to receive incoming tool requests, routing etc.


### K) Tool package

Tool packages include some .json that includes things like the title, and a description. This can later be used as fixed context for the system prompt for the LLM. It also includes a single executable file that is mounted to /tools/x, and the package as a whole is mounted to /tools/package.


### L) System prompt and Agents file

The system prompt is the one defined by the gateway. The Agents.md file is defined per-agent.
* System prompt should include a super-short intro about the gateway, and that tool details can found in the respective directories in the sandbox.
* Agents.md file lives in /workspace. The Agent needs to be able to access and even modify it.
No other files are needed for agent definition.
