// Build the core to build/, then run the unit tests against the compiled JS.
//   node tests/run.mjs    (or: npm test)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1) Compile src/ -> build/ (NodeNext emit, so the .js imports resolve under Node ESM).
run('npx', ['tsc', '-p', 'tsconfig.build.json']);

// 2) Run the unit suite against the compiled output.
run('node', ['tests/core-unit.mjs']);
