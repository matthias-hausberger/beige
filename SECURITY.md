# Security Policy

## Reporting a Vulnerability

We take the security of Beige seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of the following methods:

1. **GitHub Security Advisory** (preferred): Use the [Security Advisories page](https://github.com/matthias-hausberger/beige/security/advisories) to privately report a vulnerability.

2. **Email**: Send details to security@matthiashausberger.com

### What to Include

Please include the following information:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any possible mitigations (if known)

### Response Timeline

- **Initial Response**: Within 48 hours
- **Vulnerability Assessment**: Within 7 days
- **Fix Development**: Depends on severity and complexity
- **Disclosure**: After fix is released and users have had time to update

## Security Best Practices

When using Beige:

1. **Never expose the gateway HTTP API** (port 7433) to the public internet. It's designed for local/ trusted network use only.

2. **Review agent permissions** - Use the policy engine to grant minimal tool access per agent.

3. **Audit logs** - Regularly review audit logs at `~/.beige/logs/audit/` for suspicious activity.

4. **Keep Docker updated** - Ensure your Docker installation is current to benefit from container security patches.

5. **Secrets management** - Never commit `~/.beige/config.json5` to version control. Use environment variables for API keys.

6. **Sandbox images** - Only use trusted Docker images for agent sandboxes.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅ Yes    |

## Security Architecture

Beige implements defense in depth:

- **Sandbox isolation**: Agents run in Docker containers with no host access
- **Read-only mounts**: Tool code cannot be modified by agents
- **Socket identity**: Agent identity verified via Unix socket (not payload)
- **Policy engine**: Deny-by-default permissions
- **Audit logging**: All tool invocations logged with full context

See [Security Model documentation](docs/security-model.mdx) for detailed threat analysis and defenses.

## Disclosure Policy

We follow responsible disclosure:

1. Security issues are fixed privately
2. A new release is issued with the fix
3. Users are notified via GitHub Security Advisory
4. Detailed vulnerability information is disclosed after users have had reasonable time to update (typically 30 days)

## Comments on Security

If you have suggestions for improving Beige's security posture (non-critical), feel free to open a GitHub issue with the "security" label for discussion.
