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

## Notes

- Keys and values are strings.
- Values with spaces must be passed as a single argument (the tool joins all args after the key).
- Data is stored as JSON on the gateway host. Agents cannot access the raw storage file.
