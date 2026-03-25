#!/usr/bin/env bash
#
# sync-toolkit-docs.sh
#
# Syncs documentation from @matthias-hausberger/beige-toolkit into docs/extensibility/kits/beige-toolkit/.
# Converts each README.md to an .mdx page with Mintlify frontmatter (title only),
# and updates docs.json navigation automatically.
#
# Usage:
#   ./scripts/sync-toolkit-docs.sh [path-to-beige-toolkit]
#
# If no path is given, the script clones the repo into a temp directory (for CI).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$REPO_ROOT/docs/extensibility/kits/beige-toolkit"
DOCS_JSON="$REPO_ROOT/docs/docs.json"
TOOLKIT_SRC="${1:-}"

CLEANUP_TMP=""

if [ -z "$TOOLKIT_SRC" ]; then
  echo "No local path provided — cloning from GitHub..."
  TOOLKIT_SRC="$(mktemp -d)"
  CLEANUP_TMP="$TOOLKIT_SRC"
  git clone --depth 1 https://github.com/matthias-hausberger/beige-toolkit.git "$TOOLKIT_SRC"
fi

# Validate the source looks right
if [ ! -d "$TOOLKIT_SRC/plugins" ]; then
  echo "Error: $TOOLKIT_SRC does not contain a plugins/ directory" >&2
  exit 1
fi

# Clean destination and recreate
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"

# --- Helper: convert a markdown file to mdx with frontmatter ---
# Arguments: $1=source_md, $2=dest_mdx, $3=title
convert_md_to_mdx() {
  local src="$1"
  local dest="$2"
  local title="$3"

  {
    echo "---"
    echo "title: \"$title\""
    echo "---"
    echo ""
    echo "{/* Auto-generated from beige-toolkit — do not edit manually. */}"
    echo "{/* Run: pnpm run docs:sync-toolkit */}"
    echo ""
    # Strip the first H1 line (the README title) since Mintlify uses the frontmatter title
    sed '1{/^# /d;}' "$src"
  } > "$dest"
}

# --- 1. Main toolkit README → index.mdx ---
echo "Syncing toolkit README..."

convert_md_to_mdx \
  "$TOOLKIT_SRC/README.md" \
  "$DEST_DIR/index.mdx" \
  "@matthias-hausberger/beige-toolkit"

# --- 2. Discover plugins by scanning for plugin.json files ---
PLUGINS=()
for plugin_json in "$TOOLKIT_SRC"/plugins/*/plugin.json; do
  plugin_dir="$(dirname "$plugin_json")"
  plugin="$(basename "$plugin_dir")"
  PLUGINS+=("$plugin")
done

PLUGIN_PAGES=()

for plugin in "${PLUGINS[@]}"; do
  PLUGIN_README="$TOOLKIT_SRC/plugins/$plugin/README.md"
  if [ ! -f "$PLUGIN_README" ]; then
    echo "Warning: $plugin has no README.md, skipping."
    continue
  fi

  echo "Syncing $plugin..."

  # Extract title from first H1 in README
  PLUGIN_TITLE="$(head -5 "$PLUGIN_README" | grep -m1 '^# ' | sed 's/^# //')"
  if [ -z "$PLUGIN_TITLE" ]; then
    PLUGIN_TITLE="$plugin"
  fi

  convert_md_to_mdx \
    "$PLUGIN_README" \
    "$DEST_DIR/$plugin.mdx" \
    "$PLUGIN_TITLE"

  PLUGIN_PAGES+=("extensibility/kits/beige-toolkit/$plugin")
done

# --- 3. Update docs.json navigation ---
echo "Updating docs.json navigation..."

python3 << PYEOF
import json

docs_json_path = "$DOCS_JSON"

with open(docs_json_path) as f:
    docs = json.load(f)

# Build the toolkit group with root page
plugin_pages = """${PLUGIN_PAGES[*]}""".split()

toolkit_entry = {
    "group": "@matthias-hausberger/beige-toolkit",
    "root": "extensibility/kits/beige-toolkit/index",
    "pages": plugin_pages
}

toolkits_group = {
    "group": "Toolkits",
    "pages": [toolkit_entry]
}

# Find the Extensibility tab
for tab in docs["navigation"]["tabs"]:
    if isinstance(tab, dict) and tab.get("tab") == "Extensibility":
        # Remove any existing Toolkits group
        new_pages = []
        for page in tab["pages"]:
            if isinstance(page, dict) and page.get("group") == "Toolkits":
                continue
            new_pages.append(page)
        # Append the new Toolkits group
        new_pages.append(toolkits_group)
        tab["pages"] = new_pages
        break

with open(docs_json_path, "w") as f:
    json.dump(docs, f, indent=2)
    f.write("\n")

print(f"  Updated Tools tab with {len(plugin_pages)} plugin pages + root in Toolkits group")
PYEOF

echo ""
echo "✅ Synced ${#PLUGIN_PAGES[@]} plugin docs + index to $DEST_DIR"

# Cleanup temp clone if we made one
if [ -n "$CLEANUP_TMP" ]; then
  rm -rf "$CLEANUP_TMP"
fi
