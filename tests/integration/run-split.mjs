/* eslint-disable no-console */
/**
 * Runs the integration suites as two sequential jest invocations, one per
 * sculptcore backend: `SC_TEST_BACKEND=wasm`, then `SC_TEST_BACKEND=native`.
 *
 * Why split at all: every NW.js suite that has both backends runs them as two
 * `describe.each` legs inside one worker, so a single invocation serializes
 * wasm+native app boots per suite while jest's other workers idle. Splitting
 * halves the per-worker work and keeps the (large, short-lived) NW.js profile
 * directories from piling up across both backends at once.
 *
 * `./split.ts` decides which pass a suite belongs to; with SC_TEST_BACKEND
 * unset (a plain `jest` invocation) every suite runs everything, as before.
 *
 * The native pass is skipped outright when the N-API addon isn't built — in
 * that case ./split routes the cross-backend suites into the wasm pass, so
 * nothing is lost.
 *
 * `--slow` flips both passes to the wall-clock-dominating suites in ./slow.mjs,
 * which the default run excludes (`pnpm test:slow`).
 *
 * Any other argv is forwarded to both passes: `pnpm test -- -t 'undo'`.
 */

import {spawn} from 'node:child_process'
import fs from 'node:fs'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'

import {SLOW_SUITES} from './slow.mjs'

const HERE = Path.dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = Path.resolve(HERE, '..')
const REPO_ROOT = Path.resolve(TESTS_DIR, '..')

const JEST_BIN = Path.join(TESTS_DIR, 'node_modules/jest/bin/jest.js')
const CONFIG = Path.join(HERE, 'jest.config.mjs')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore/build/native-node/sculptcore_node.node')

const argv = process.argv.slice(2)
const slow = argv.includes('--slow')
const extraArgs = argv.filter((a) => a !== '--slow')

function runPass(backend) {
  return new Promise((resolve) => {
    const args = ['--experimental-vm-modules', JEST_BIN, '--config', CONFIG, ...extraArgs]
    const child = spawn(process.execPath, args, {
      cwd  : HERE,
      stdio: 'inherit',
      env  : {...process.env, SC_TEST_BACKEND: backend, SC_TEST_SLOW: slow ? '1' : ''},
    })
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
    child.on('error', (err) => {
      console.error(`[integration:${backend}] failed to spawn jest:`, err)
      resolve(1)
    })
  })
}

const passes = ['wasm']
if (fs.existsSync(NATIVE_ADDON)) {
  passes.push('native')
} else {
  console.log('[integration] native addon not built — running the wasm pass only')
}

if (slow) {
  console.log(`[integration] slow-suite run: ${SLOW_SUITES.join(', ')}`)
}

let failed = 0
for (const backend of passes) {
  console.log(`\n=== integration tests: ${backend} backend${slow ? ' (slow suites)' : ''} ===\n`)
  const code = await runPass(backend)
  if (code !== 0) {
    failed = code
    console.error(`\n=== integration tests: ${backend} backend FAILED (exit ${code}) ===\n`)
  }
}

process.exit(failed)
