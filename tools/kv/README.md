# KV Tool

Simple key-value store. Data persists on the gateway host across sessions.

## Usage

```sh
/tools/bin/kv set <key> <value>   # Store a value
/tools/bin/kv get <key>           # Retrieve a value
/tools/bin/kv del <key>           # Delete a key
/tools/bin/kv list                # List all keys
```

## Examples

```sh
# Store a travel note
/tools/bin/kv set trip:paris "Flying March 15, Hotel Lumiere"

# Retrieve it
/tools/bin/kv get trip:paris
# → Flying March 15, Hotel Lumiere

# List all stored keys
/tools/bin/kv list
# → trip:paris = Flying March 15, Hotel Lumiere

# Delete
/tools/bin/kv del trip:paris
```

## Access Control

The commands available to an agent are controlled via the tool's `config` block in `config.json5`.
Two optional fields let you allowlist and/or denylist specific commands:

| Config field | Type | Default | Description |
|---|---|---|---|
| `allowCommands` | `string \| string[]` | all commands | Only these commands are permitted. |
| `denyCommands` | `string \| string[]` | *(none)* | These commands are always blocked. Deny beats allow. |

**Example — read-only agent** (can only `get` and `list`):

```json5
tools: {
  "kv-readonly": {
    path: "./tools/kv",
    target: "gateway",
    config: {
      allowCommands: ["get", "list"],
    },
  },
},
agents: {
  reader: { tools: ["kv-readonly"] },
},
```

**Example — write-only agent** (can `set` and `del`, cannot read):

```json5
tools: {
  "kv-writeonly": {
    path: "./tools/kv",
    target: "gateway",
    config: {
      allowCommands: ["set", "del"],
    },
  },
},
```

**Example — deny a single command on an otherwise full-access tool** (no `del`):

```json5
tools: {
  "kv-nodelete": {
    path: "./tools/kv",
    target: "gateway",
    config: {
      denyCommands: ["del"],
    },
  },
},
```

When a denied command is called, the tool exits with code `1` and prints a clear error:

```
Permission denied: command 'del' is not allowed for this agent.
Permitted commands: set, get, list
```

## Notes

- Keys and values are strings.
- Values with spaces must be passed as a single argument (the tool joins all args after the key).
- Data is stored as JSON on the gateway host. Agents cannot access the raw storage file.
- The same physical KV store is shared across all agents. Use `allowCommands` / `denyCommands` to
  restrict which operations each agent can perform, not which keys it can see.
