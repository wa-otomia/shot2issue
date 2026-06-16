#!/usr/bin/env bash
# build.sh — validate the manifest and package extension/ into a distributable zip.
#
# This is the "build" for a no-bundler MV3 extension: development uses "load unpacked"
# and needs no build at all. The build only produces a clean release archive that
# contains the extension files and none of the repository metadata.
#
# Runs locally or inside the Dockerfile (CI uses the Docker path).
# Requires: bash, zip. jq is optional (used for strict JSON validation; without it the
# script falls back to grep for the version number).

set -euo pipefail

# Locate the repository root (this script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
DIST_DIR="$ROOT_DIR/dist"
PKG="shot2issue"

echo "==> Repository root: $ROOT_DIR"

# --- 1) Required files ---
required=(
  "manifest.json"
  "background.js"
  "editor.html" "editor.js" "editor.css"
  "options.html" "options.js"
  "lib/storage.js" "lib/i18n.js" "lib/github-attach.js" "lib/page-upload.js"
  "icons/icon16.png" "icons/icon48.png" "icons/icon128.png"
)
missing=0
for f in "${required[@]}"; do
  if [ ! -f "$EXT_DIR/$f" ]; then
    echo "ERROR: missing file extension/$f" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || { echo "Build aborted: files are missing." >&2; exit 1; }

MANIFEST="$EXT_DIR/manifest.json"

# --- 2) Validate the manifest and read the version ---
if command -v jq >/dev/null 2>&1; then
  jq empty "$MANIFEST" || { echo "ERROR: manifest.json is not valid JSON" >&2; exit 1; }
  MV="$(jq -r '.manifest_version' "$MANIFEST")"
  [ "$MV" = "3" ] || { echo "ERROR: manifest_version must be 3 (got: $MV)" >&2; exit 1; }
  VERSION="$(jq -r '.version' "$MANIFEST")"
  NAME="$(jq -r '.name' "$MANIFEST")"
  echo "==> Manifest OK: $NAME (v$VERSION)"
else
  echo "WARN: jq not found; skipping strict JSON validation (reading version only)." >&2
  VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$MANIFEST" | head -1 | grep -oE '[0-9]+(\.[0-9]+)*')"
fi
[ -n "${VERSION:-}" ] || { echo "ERROR: could not parse the version" >&2; exit 1; }

# --- 3) Package ---
ZIP_NAME="${PKG}-${VERSION}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Zip from inside extension/ so manifest.json sits at the archive root (required by
# the Chrome Web Store).
( cd "$EXT_DIR" && zip -r -q "$ZIP_PATH" . -x '*.DS_Store' -x '__MACOSX/*' )

echo "==> Created: dist/$ZIP_NAME"
if command -v unzip >/dev/null 2>&1; then
  echo "==> Archive contents:"
  unzip -l "$ZIP_PATH" | sed 's/^/    /'
fi
SIZE="$(du -h "$ZIP_PATH" | cut -f1)"
echo "==> Size: $SIZE"
echo "Build complete."
