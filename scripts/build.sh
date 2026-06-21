#!/usr/bin/env bash
# build.sh — compile the TypeScript extension and package build/ into a release zip.
#
# This is the full build for the MV3 extension: TypeScript in src/ is compiled to
# build/ (tsc), static assets are copied alongside the emitted JS, the manifest is
# validated, and the loadable extension is archived for the Chrome Web Store.
#
# Runs locally or inside the Dockerfile (CI uses the Docker path).
# Requires: bash, node/npm, zip, jq.

set -euo pipefail

# Locate the repository root (this script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
DIST_DIR="$ROOT_DIR/dist"
PKG="shot2issue"

echo "==> Repository root: $ROOT_DIR"
cd "$ROOT_DIR"

# --- 1) Install and build ---
# Reproducible install from the committed package-lock.json.
npm ci
# Compile TypeScript (tsc) and copy static assets into build/.
npm run build

# --- 2) Validate the manifest and read the version ---
MANIFEST="$BUILD_DIR/manifest.json"
jq empty "$MANIFEST" || { echo "ERROR: manifest.json is not valid JSON" >&2; exit 1; }
MV="$(jq -r '.manifest_version' "$MANIFEST")"
[ "$MV" = "3" ] || { echo "ERROR: manifest_version must be 3 (got: $MV)" >&2; exit 1; }
VERSION="$(jq -r '.version' "$MANIFEST")"
NAME="$(jq -r '.name' "$MANIFEST")"
echo "==> Manifest OK: $NAME (v$VERSION)"

# --- 3) Verify required build outputs ---
required=(
  "manifest.json"
  "background.js"
  "editor.html" "editor.js" "editor.css"
  "options.html" "options.js"
  "popup.html" "popup.js"
  "offscreen.html" "offscreen.js"
  "lib/storage.js" "lib/i18n.js" "lib/github-attach.js" "lib/page-upload.js" "lib/youtrack.js"
  "lib/providers/index.js" "lib/providers/github.js" "lib/providers/youtrack.js"
  "icons/icon16.png" "icons/icon48.png" "icons/icon128.png"
)
missing=0
for f in "${required[@]}"; do
  if [ ! -f "$BUILD_DIR/$f" ]; then
    echo "ERROR: missing file build/$f" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || { echo "Build aborted: files are missing." >&2; exit 1; }

# --- 4) Package ---
ZIP_NAME="${PKG}-${VERSION}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Zip from inside build/ so manifest.json sits at the archive root (required by
# the Chrome Web Store).
( cd "$BUILD_DIR" && zip -r -q "$ZIP_PATH" . -x '*.DS_Store' )

# --- 5) Summary ---
SIZE="$(du -h "$ZIP_PATH" | cut -f1)"
echo "==> Created: dist/$ZIP_NAME ($SIZE)"
echo "Build complete."
