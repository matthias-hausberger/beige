# System Overview

## High-Level Architecture

```mermaid
graph TB
    subgraph Channels
        TG[Telegram Bot]
        CLI[CLI / Future]
    end

    subgraph Gateway["Gateway (Node.js)"]
        CM[Channel Manager]
        AM[Agent Manager]
        PI[pi SDK — LLM Layer]
        PE[Policy Engine]
        AL[Audit Logger]
        TR[Tool Runner]
        SS[Socket Servers]
        SM[Sandbox Manager]

        CM --> AM
        AM --> PI
        PI -->|core tool calls| PE
        PE -->|allowed| SM
        PE -->|denied| AL
        SM -->|docker exec| SB1
        SS -->|tool requests| PE
        PE -->|allowed| TR
        TR --> AL
    end

    subgraph Sandboxes
        SB1[/"Agent Sandbox (Docker)"\]
        SB2[/"Agent Sandbox (Docker)"\]
    end

    TG --> CM
    CLI --> CM
    SB1 -->|Unix Socket| SS
    SB2 -->|Unix Socket| SS

    style Gateway fill:#f5f0e0,stroke:#c9b97a
    style Sandboxes fill:#e0e8f0,stroke:#7a9cc9
    style Channels fill:#e8f0e0,stroke:#7ac97a
```

## Component Responsibilities

### Gateway Process

The gateway is the single host process. It never runs untrusted code — all agent computation happens inside sandboxes.

| Component | Responsibility |
|-----------|---------------|
| **Channel Manager** | Receives user messages from Telegram (or future CLI), routes to the correct agent |
| **Agent Manager** | Manages pi SDK `AgentSession` instances. One session per agent, lazily initialized |
| **pi SDK (LLM Layer)** | Makes LLM API calls (Anthropic, OpenAI/ZAI, etc). Owns the 4 core tool definitions |
| **Policy Engine** | Deny-by-default permission checks. Validates agent→tool access before every execution |
| **Audit Logger** | Appends JSONL entries for every tool invocation (core and custom) |
| **Sandbox Manager** | Creates/destroys Docker containers, generates tool launchers, runs `docker exec` |
| **Socket Servers** | One Unix domain socket per agent. Receives tool requests from sandbox launchers |
| **Tool Runner** | Executes gateway-hosted tool handlers (e.g. KV store) |

### Sandbox (per agent)

Each agent gets its own Docker container. The container is long-lived (`sleep infinity`) and commands are executed via `docker exec`.

```mermaid
graph LR
    subgraph Container["Docker Container: beige-<agent>"]
        WS["/workspace (rw)"]
        TB["/tools/bin (ro)"]
        TP["/tools/packages (ro)"]
        TC["/beige/tool-client (ro)"]
        GS["/beige/gateway.sock"]
    end

    HOST_WS["~/.beige/agents/<agent>/workspace"] ---|bind mount| WS
    HOST_L["generated launchers"] ---|bind mount ro| TB
    HOST_T["tool package dirs"] ---|bind mount ro| TP
    HOST_S["~/.beige/sockets/<agent>.sock"] ---|bind mount| GS

    style Container fill:#e0e8f0,stroke:#7a9cc9
```

### What Lives Where

```mermaid
graph TB
    subgraph Host["Gateway Host"]
        CONF[Config + Secrets]
        LOGS[Audit Logs]
        KEYS[API Keys]
        KV_DATA[Tool Data — e.g. kv.json]
        DOCKER[Docker Daemon]
    end

    subgraph Sandbox["Agent Sandbox"]
        CODE[Agent scripts + workspace files]
        TOOLS[Tool launchers — read-only]
        DOCS[Tool docs — read-only]
        DENO[Deno runtime]
    end

    CONF -.-x Sandbox
    KEYS -.-x Sandbox
    LOGS -.-x Sandbox

    style Host fill:#f5f0e0,stroke:#c9b97a
    style Sandbox fill:#e0e8f0,stroke:#7a9cc9
```

> ❌ Dashed-X lines = **no access**. Secrets, config, and logs never enter the sandbox.

## Startup Sequence

```mermaid
sequenceDiagram
    participant Main as index.ts
    participant GW as Gateway
    participant Tools as Tool Registry
    participant SM as Sandbox Manager
    participant SS as Socket Servers
    participant TG as Telegram Bot

    Main->>GW: new Gateway(config)
    GW->>Tools: loadTools(config)
    Tools-->>GW: loaded tools + handlers

    loop For each agent in config
        GW->>SM: createSandbox(agentName)
        SM->>SM: generate launchers
        SM->>SM: docker create + start
        GW->>SS: start socket server
        SS-->>GW: listening on ~/.beige/sockets/<agent>.sock
    end

    GW->>TG: new TelegramChannel(config)
    TG->>TG: bot.start()
    TG-->>GW: bot online

    Note over GW: Gateway ready ✓
```

## Multi-Agent Setup

Multiple agents can run simultaneously, each with their own sandbox, socket, tools, and LLM model.

```mermaid
graph TB
    TG[Telegram Bot] --> CM[Channel Manager]

    CM -->|user A| AM1[Agent: travel]
    CM -->|user B| AM2[Agent: dev]

    AM1 --> PI1[pi SDK — Claude Sonnet]
    AM2 --> PI2[pi SDK — Claude Opus]

    PI1 --> SB1[Sandbox: travel<br/>tools: kv, browser]
    PI2 --> SB2[Sandbox: dev<br/>tools: kv, git]

    SB1 -->|socket| SS1[Socket: travel.sock]
    SB2 -->|socket| SS2[Socket: dev.sock]

    SS1 --> PE[Policy Engine]
    SS2 --> PE

    style SB1 fill:#e0e8f0,stroke:#7a9cc9
    style SB2 fill:#e0e8f0,stroke:#7a9cc9
```

Each agent is fully isolated — different container, different socket, different tool permissions, potentially different LLM provider/model.
