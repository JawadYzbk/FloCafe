#!/usr/bin/env node
/*
 * Cross-platform wrapper mirroring tests/run-test.sh.
 *
 * Runs the given command and treats exit code 77 (ABI-mismatch skip, GNU
 * convention) as success (exit 0). This lets `npm test` run on Windows — the
 * project's primary dev platform — without requiring Git-Bash or WSL on PATH,
 * which the `bash tests/run-test.sh …` form silently depends on.
 *
 * Usage: node tests/run-test.cjs npm run test:<name>
 */
'use strict';

const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node tests/run-test.cjs <command> [args...]');
  process.exit(2);
}

// shell:true so `npm`/`npx` resolve to their platform launcher (npm.cmd on
// Windows). The args are simple, space-safe suite invocations (npm run test:x).
const result = spawnSync(args.join(' '), { stdio: 'inherit', shell: true });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

const exitCode = result.status;

if (exitCode === 77) {
  console.log('  ⏭ Skipped (ABI mismatch)');
  process.exit(0);
}

// A signal-terminated child reports status === null.
process.exit(exitCode === null ? 1 : exitCode);
