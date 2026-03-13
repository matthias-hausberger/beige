# Contributing to Beige

Thank you for your interest in contributing to Beige! This document provides guidelines and instructions for contributing. Don't take rules here too seariously, **any contribution is appreciated!**

## Development Setup

### Prerequisites

- Node.js 22+
- Docker (for sandbox execution)
- pnpm

### Clone and Install

```bash
git clone https://github.com/matthias-hausberger/beige.git
cd beige
pnpm install
```

### Run Setup

Source installs are self-contained — everything is stored in `./.beige/` inside the repo, not in your home directory:

```bash
pnpm run beige setup
```

This creates:

| Path | Purpose |
|------|---------|
| `.beige/config.json5` | Main configuration file |
| `.beige/tools/kv/` | Bundled KV tool |
| `.beige/workspaces/` | Agent workspaces |
| `.beige/sessions/` | Persisted conversation sessions |
| `.beige/logs/` | Gateway and audit logs |

### Configure API Keys

Edit `.beige/config.json5` and set your API key:

```json5
llm: {
  providers: {
    anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
  },
},
```

Then export the environment variable:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

For the full config schema and all available options, see the [Config Reference](https://beige.mintlify.app/agents/configuration).

### Run the Gateway

```bash
pnpm run beige gateway start --foreground
```

### Run the TUI

In another terminal:

```bash
pnpm run beige tui
```

## Project Structure

```
beige/
├── src/
│   ├── cli.ts              # CLI entry point
│   ├── install.ts          # First-time setup
│   ├── config/             # Config loading and validation
│   ├── gateway/            # Core gateway logic
│   ├── sandbox/            # Docker container management
│   ├── socket/             # Unix socket server
│   ├── tools/              # Core tools + registry
│   └── channels/           # Telegram and TUI adapters
├── sandbox/
│   ├── Dockerfile          # Sandbox image
│   └── tool-client.ts      # Socket client (Deno)
├── tools/
│   └── kv/                 # Example tool package
├── docs/                   # Documentation
├── examples/               # Example config
└── project/                # Vision and use cases
```

## Making Changes

### Code Style

- TypeScript with strict mode
- ES modules (ESNext)
- Prefer `async/await` over raw promises
- Use meaningful variable names

### Commits

- Write clear, descriptive commit messages
- Keep commits focused (one logical change per commit)
- Reference issues when applicable

### Building

```bash
pnpm run build
```

### Testing

Before submitting a PR, ensure:

1. Code compiles: `pnpm run build`
2. All tests pass: `pnpm test`
3. Gateway starts: `pnpm run beige gateway start --foreground`
4. TUI connects: `pnpm run beige tui`

For CLI commands and options, see the [CLI Reference](https://beige.mintlify.app/cli).

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test thoroughly
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request against the `dev` branch

### PR Guidelines

- Describe what changes and why
- Reference any related issues
- Update documentation if needed
- Keep changes focused and reviewable

## Adding New Tools

See the [Tools documentation](https://beige.mintlify.app/tools) for the complete guide on writing tool packages.

Quick overview:

1. Create `tools/my-tool/` with `tool.json`, `index.ts`, and `README.md`
2. Export `createHandler(config)` from `index.ts`
3. Register in `config.json5` under `tools`
4. Add to agent's `tools` array

## Reporting Issues

When reporting issues, please include:

- Beige version (git commit or `pnpm run beige --version`)
- Node.js version (`node --version`)
- Docker version (`docker --version`)
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs from `.beige/logs/` (redact any secrets!)

## Questions?

Feel free to open an issue for questions or discussions.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
