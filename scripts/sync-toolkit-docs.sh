#!/usr/bin/env bash
#
# sync-toolkit-docs.sh
#
# Syncs documentation from @matthias-hausberger/beige-toolkit into docs/tools/beige-toolkit/.
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
DEST_DIR="$REPO_ROOT/docs/tools/beige-toolkit"
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
if [ ! -d "$TOOLKIT_SRC/tools" ]; then
  echo "Error: $TOOLKIT_SRC does not contain a tools/ directory" >&2
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

# --- 2. Discover tools by scanning for tool.json files ---
TOOLS=()
for tool_json in "$TOOLKIT_SRC"/tools/*/tool.json; do
  tool_dir="$(dirname "$tool_json")"
  tool="$(basename "$tool_dir")"
  TOOLS+=("$tool")
done

TOOL_PAGES=()

for tool in "${TOOLS[@]}"; do
  TOOL_README="$TOOLKIT_SRC/tools/$tool/README.md"
  if [ ! -f "$TOOL_README" ]; then
    echo "Warning: $tool has no README.md, skipping."
    continue
  fi

  echo "Syncing $tool..."

  # Extract title from first H1 in README
  TOOL_TITLE="$(head -5 "$TOOL_README" | grep -m1 '^# ' | sed 's/^# //')"
  if [ -z "$TOOL_TITLE" ]; then
    TOOL_TITLE="$tool"
  fi

  convert_md_to_mdx \
    "$TOOL_README" \
    "$DEST_DIR/$tool.mdx" \
    "$TOOL_TITLE"

  TOOL_PAGES+=("tools/beige-toolkit/$tool")
done

# --- 3. Update docs.json navigation ---
echo "Updating docs.json navigation..."

python3 << PYEOF
import json

docs_json_path = "$DOCS_JSON"

with open(docs_json_path) as f:
    docs = json.load(f)

# Build the toolkit group with root page
tool_pages = """${TOOL_PAGES[*]}""".split()

toolkit_entry = {
    "group": "@matthias-hausberger/beige-toolkit",
    "root": "tools/beige-toolkit/index",
    "pages": tool_pages
}

toolkits_group = {
    "group": "Toolkits",
    "pages": [toolkit_entry]
}

# Find the Tools tab
for tab in docs["navigation"]["tabs"]:
    if isinstance(tab, dict) and tab.get("tab") == "Tools":
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

print(f"  Updated Tools tab with {len(tool_pages)} tool pages + root in Toolkits group")
PYEOF

echo ""
echo "✅ Synced ${#TOOL_PAGES[@]} tool docs + index to $DEST_DIR"

# Cleanup temp clone if we made one
if [ -n "$CLEANUP_TMP" ]; then
  rm -rf "$CLEANUP_TMP"
fi
