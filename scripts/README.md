# Scripts

This directory contains utility scripts for the Beige project.

## Packaging

The project uses npm/pnpm's built-in packaging commands. No custom packaging scripts are needed.

### Available npm scripts:

- `pnpm run pack` - Install dependencies, build, and create TGZ package
- `pnpm run pack:local` - Same as above (alias)
- `pnpm run test:install` - Test global installation of the latest TGZ

### Simple packaging workflow:

```bash
# Build and package
pnpm run pack

# Test local installation  
pnpm run test:install

# Or manually:
npm install -g ./*.tgz
```

### Version management:

Versions are managed in `package.json` directly. No automation scripts needed.

```bash
# Update version (npm way)
npm version patch  # or minor, major

# Or edit package.json manually
# Then build and pack
pnpm run pack
```

This follows the same simple approach as Keyflare - using the npm CLI's built-in packaging capabilities without additional complexity.