## Goal

Design a secure, local-first agent system where:

* **pi-coding-agent** is the core orchestrator (“gateway” + agent manager).
* **All agent operations run inside a per-agent sandbox**.
* Sandboxes have **no network egress** (for now).
* Tools are exposed to the agent as **read-only executables** inside the sandbox.
* Tool execution always routes through the **gateway** over a socket so the gateway can:

  * authenticate the caller (sandbox/container identity),
  * enforce permissions,
  * log every invocation,
  * route execution (gateway host vs sandbox vs future external nodes).

Initially implement only the “core” plus a single “hello world”-level gateway tool:

* **`kv.set` / `kv.get`** (set value / get value), executed on the **gateway host**, to validate the routing/auth/policy/logging model.

Input channel is **Telegram**.

The agent can run TypeScript scripts via `exec` **inside its sandbox**; those scripts can call tool executables to form toolchains.

---

## Core Constraints

1. **Sandboxing**

* Every agent runs in its own sandbox.
* The agent’s `exec` runs inside the sandbox only.
* Sandboxes:

  * have **no outbound network** (egress blocked),
  * have restricted filesystem access (writable workspace only),
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

## What the other AI should produce

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
     * `/tools/packages` (read-only)
     * `/tools/bin` (read-only)
   * has a single gateway socket available for tool routing

4. **Tool Execution Targets**

   * `gateway host` target (initially used by kv tool)
   * `sandbox` target (future tools)
   * `external nodes` target (future)

5. **Tool Packaging + Projection**

   * tools are stored in repo as single folders (“tool packages”)
   * gateway projects tools into sandboxes via mounts
   * gateway generates per-agent executable wrappers based on config

Deliverable: a clear diagram/description of data flows:
Telegram → Gateway → Sandbox exec → Tool launcher → Gateway socket → Tool runner → result → back.

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

* target selection: gateway / sandbox / node
* per-tool config: allowlists, defaults, rate limits, etc.
* “deny by default” policy

---

### D) Tool Invocation Protocol (conceptual)

Describe a minimal request/response structure over the socket:

* request contains:

  * executable/tool name (or tool id)
  * args
  * working directory context (optional)
* response contains:

  * exit code
  * stdout/stderr
  * structured JSON output (recommended as future convention)
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
* It’s exposed into the sandbox as an executable (e.g. `kv@gateway`)
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

### F) Read-only Mount Strategy (conceptual)

Describe the mount approach:

* Tool packages mounted read-only into sandbox
* Generated executables mounted read-only into sandbox
* Only `/workspace` is writable
* Explain why:

  * prevents agent from modifying tool code
  * enables on-demand reading of docs/source

---

### G) Script Toolchains (TypeScript in sandbox)

Define how “AI writes scripts” fits:

* agent can write `.ts` files into `/workspace`
* agent can execute them via `exec`
* scripts can invoke tool executables (which route through gateway)
* goal: allow tool chaining without giving network access

---

### H) Future Extension Points (explicit but not implemented)

List planned extensions:

1. **Network tool** (later)

   * still no sandbox egress
   * network requests go through gateway tool
   * allowlist/blacklist per agent in gateway config

2. **External nodes** (later)

   * gateway routes tool calls to node runners
   * consistent logging/policy in gateway

3. **Additional channels** (later)

   * web, CLI, etc.

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

## Open Questions the other AI should explicitly decide (without implementation details)

* Naming convention for executables (`tool@target`, aliases, etc.)
* How agent configs are structured/validated
* What the minimal logging schema should be
* What the policy evaluation order is (global defaults → agent overrides → tool-specific)
* How to represent “tool parameters/configs” owned by gateway (e.g. allowlists)

---

If you want, I can rewrite this into a “prompt” you can paste directly into another AI as a single instruction block (same content, more directive).
