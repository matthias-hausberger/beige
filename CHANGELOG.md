# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-03-06

### Added

- **Core gateway** — Orchestrates LLM calls, policy enforcement, audit logging, and sandbox lifecycle
- **Docker sandbox** — Each agent runs in its own container with isolated workspace
- **4 core tools** — `read`, `write`, `patch`, `exec` exposed to the LLM
- **Tool packages** — Extensible tool system with gateway-targeted execution
- **KV tool** — First tool package: persistent key-value store with command-level access control
- **Unix socket protocol** — Tool launchers communicate with gateway over Unix domain sockets
- **Policy engine** — Deny-by-default permissions per agent per tool
- **Audit logging** — JSONL audit trail for all tool invocations
- **Telegram channel** — GrammY-based bot with streaming responses and session persistence
- **TUI channel** — Full pi InteractiveMode experience with proxied tool execution
- **HTTP API** — Gateway API for external channels (port 7433)
- **Session management** — Persistent conversation sessions per channel/chat
- **Session settings** — Per-session setting overrides (verbose mode, etc.)
- **Graceful restart** — SIGHUP triggers drain → teardown → reload config → restart
- **Auto-setup** — First run bootstraps `~/.beige` with default config and bundled tools
- **Source-install detection** — Skips auto-setup when running from git clone
- **Auto sandbox image build** — Gateway builds Docker image on first start if needed

### Documentation

- Architecture overview with data flow diagrams
- Installation guide (npm global vs source)
- System overview with component responsibilities
- Request flow sequence diagrams
- Security model and threat analysis
- Tool package development guide
- Configuration reference
- Telegram channel guide
- TUI channel guide
