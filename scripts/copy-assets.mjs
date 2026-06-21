// copy-assets.mjs — copy static assets from src/ into build/ after the TypeScript
// compile. tsc only emits the compiled .js; the manifest, HTML/CSS, and icons are
// plain files that must be mirrored into the loadable extension directory.
//
// Layout preserved: src/<file> -> build/<file>, and src/icons -> build/icons.

import { mkdirSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve repository paths relative to this script (scripts/ lives at the root).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, "..");
const SRC_DIR = join(ROOT_DIR, "src");
const BUILD_DIR = join(ROOT_DIR, "build");

// Ensure the output directory exists.
mkdirSync(BUILD_DIR, { recursive: true });

// Individual static files copied to the build root.
const files = ["manifest.json", "editor.html", "editor.css", "options.html"];
for (const file of files) {
  cpSync(join(SRC_DIR, file), join(BUILD_DIR, file), { recursive: true });
}

// Icons directory copied recursively, preserving structure.
cpSync(join(SRC_DIR, "icons"), join(BUILD_DIR, "icons"), { recursive: true });
