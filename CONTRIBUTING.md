# Contributing to Beige

Thank you for your interest in contributing to Beige! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- Node.js 22+
- Docker (for sandbox execution)
- pnpm (recommended) or npm

### Clone and Install

```bash
git clone https://github.com/matthias-hausberger/beige.git
cd beige
pnpm install  # or: npm install
```

### Run in Development Mode

```bash
# Copy example config
cp examples/config.json5 ~/.beige/config.json5

# Edit config with your API keys
# Then start the gateway
pnpm run beige gateway start --foreground

# In another terminal, start the TUI
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
2. Gateway starts: `pnpm run beige gateway start --foreground`
3. TUI connects: `pnpm run beige tui`

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

See [docs/tools.md](docs/tools.md) for the complete guide on writing tool packages.

Quick overview:

1. Create `tools/my-tool/` with `tool.json`, `index.ts`, and `README.md`
2. Export `createHandler(config)` from `index.ts`
3. Register in `config.json5` under `tools`
4. Add to agent's `tools` array

## Reporting Issues

When reporting issues, please include:

- Beige version (`beige --version` or git commit)
- Node.js version (`node --version`)
- Docker version (`docker --version`)
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs (redact any secrets!)

## Questions?

Feel free to open an issue for questions or discussions.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
