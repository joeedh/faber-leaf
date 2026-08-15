#!/usr/bin/env node
/**
 * `pnpm test` wrapper that holds the whole test run to 5 parallel jobs.
 *
 * TEMPORARY — for the duration of the Faber Leaf refactor only. The cap is
 * *global*, not per-tool: turbo runs one package at a time so that a package's
 * own worker pool is the only thing running, and each pool is capped at 5.
 * Building sculptcore concurrently with a test run breaks the cap, so don't.
 *
 * Revert when the refactor lands: `"test": "turbo test"` in package.json, delete
 * this file, restore `maxWorkers: 6` in both jest configs, and delete
 * sculptcore/local-build-options.mjs. See the §9.3 note in
 * documentation/plans/2026-08-15-0237-faber-leaf-refactor-strategy.md.
 *
 * CI is deliberately not capped — it gets its own runner.
 */

import {spawnSync} from 'node:child_process'

const JOBS = 5

const result = spawnSync('turbo', ['test', `--concurrency=1`, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    // path.ux runs vitest, which sizes its thread pool from the core count.
    // The two jest workspaces are capped in their own configs; mathl runs a
    // bare `npx jest` but only has two suites, so it cannot exceed the cap.
    VITEST_MAX_THREADS: String(JOBS),
    VITEST_MIN_THREADS: '1',
  },
})

process.exitCode = result.status ?? 1
