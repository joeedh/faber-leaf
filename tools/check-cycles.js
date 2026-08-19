#!/usr/bin/env node
/**
 * Import-cycle ratchet: runs tools/circular-ref-finder over the app's module
 * graph, splits the cycles it finds into host-owned and submodule-owned, and
 * fails when either count exceeds its budget in tools/cycle-baseline.json.
 *
 * Two counts rather than one because they are not equally actionable. A cycle
 * whose every member lives in scripts/path.ux or scripts/mathl belongs to a
 * submodule we vendor; a cycle with even one file outside them is ours, and
 * that budget is zero. A new host cycle routed through path.ux still counts as
 * host, which is the point of classifying by membership rather than by where
 * the cycle happens to start.
 *
 * Budgets only ever move down (--update-baseline, in the same PR that lowers
 * them). See documentation/plans/2026-08-15-0420-w5-distributions.md §4.
 */

import {execFileSync} from 'node:child_process'
import {readFileSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const FINDER = path.join(__dirname, 'circular-ref-finder', 'dist', 'index.js')
const BASELINE = path.join(__dirname, 'cycle-baseline.json')

// The walk starts at the app's root module and follows imports, so this is the
// real shipped graph rather than a directory sweep.
const ENTRY = 'scripts/core/appstate.ts'

/** Cycles entirely inside one of these are the vendor's to fix, not ours. */
const SUBMODULE_DIR = /[\\/](path\.ux|mathl)[\\/]/

function run() {
  try {
    return execFileSync(process.execPath, [FINDER, ENTRY], {
      cwd      : repoRoot,
      encoding : 'utf-8',
      stdio    : ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    // The finder exits 1 whenever it finds anything at all; that is this
    // script's input, not its verdict. A crash writes nothing to stdout.
    if (err.stdout) {
      return err.stdout
    }
    throw err
  }
}

/** Split the finder's report into one string[] of module paths per cycle. */
function parseCycles(out) {
  const cycles = []
  let current = null

  for (const line of out.split(/\r?\n/)) {
    if (/^Cycle \d+:/.test(line)) {
      current = []
      cycles.push(current)
      continue
    }
    if (!current) {
      continue
    }
    const m = line.match(/^\s+(\S.*?)\s*(?:→|->)?\s*(?:\(back to start\))?$/)
    if (m && m[1]) {
      current.push(m[1])
    } else if (line.trim() === '') {
      current = null
    }
  }

  return cycles
}

function classify(cycles) {
  const host = []
  const submodule = []

  for (const cycle of cycles) {
    ;(cycle.every((f) => SUBMODULE_DIR.test(f)) ? submodule : host).push(cycle)
  }

  return {host, submodule}
}

function main() {
  const argv = process.argv.slice(2)
  const update = argv.includes('--update-baseline')

  const out = run()
  const analyzed = out.match(/Analyzed (\d+) files/)?.[1] ?? '?'
  const {host, submodule} = classify(parseCycles(out))

  const counts = {host: host.length, submodule: submodule.length}
  const total = counts.host + counts.submodule

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'))

  console.log(`\ncheck-cycles: walked ${analyzed} modules from ${ENTRY}\n`)
  console.log('  owner        count   budget  delta')
  console.log('  ---------  -------  -------  -----')

  let failed = false
  for (const owner of ['host', 'submodule']) {
    const count = counts[owner]
    const budget = baseline.budgets[owner]
    const delta = count - budget
    console.log(
      `  ${owner.padEnd(9)}  ${String(count).padStart(7)}  ${String(budget).padStart(7)}  ${
        delta > 0 ? `+${delta}` : String(delta)
      }`
    )
    if (delta > 0) {
      failed = true
    }
  }

  if (host.length > 0) {
    console.log('\nhost cycles:')
    for (const cycle of host) {
      console.log(`  ${cycle.join(' -> ')}`)
    }
  }

  if (update) {
    baseline.budgets = counts
    baseline.total = total
    baseline.measured = new Date().toISOString().slice(0, 10)
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`\ncheck-cycles: baseline updated (host ${counts.host}, submodule ${counts.submodule})`)
    return
  }

  if (failed) {
    console.error('\ncheck-cycles: FAILED (a budget was exceeded; budgets only move down)')
    process.exit(1)
  }

  console.log('\ncheck-cycles: OK (no budget overruns)')
}

main()
