#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Layer-boundary check: cruises scripts/ + addons/ with .dependency-cruiser.cjs,
 * prints a per-rule table, and ratchets the violation count.
 *
 * The gate fails when any of these hold:
 *   - a rule of severity `error` (or `info`-as-error, see EXIT_SEVERITIES) is hit;
 *   - the total warning count exceeds the budget (--max-warnings / baseline total);
 *   - any single rule exceeds its per-rule budget in tools/layer-baseline.json.
 *
 * P9 flipped every rule that reads zero to `error`. The rest are held monotone by
 * their per-rule budget, so lowering a number means lowering it here too
 * (`--update-baseline`) in the same PR. The decision half lives in layer-gate.mjs
 * so it can be unit-tested against canned cruise JSON.
 *
 * dependency-cruiser is driven through its programmatic API rather than the CLI:
 * `execFile('npx.cmd', ...)` without a shell is a `spawn EINVAL` on Windows, and
 * spawning through a shell would put config paths through cmd.exe quoting.
 *
 * See documentation/plans/2026-08-15-0300-ci-and-layer-gate-repair.md §5 step 2.
 */

import {cruise} from 'dependency-cruiser'
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config'
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config'
import {readFileSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {evaluate, tally} from './layer-gate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const CONFIG = '.dependency-cruiser.cjs'
// distributions/ is a root so the graph is complete from the composition
// root down: a distribution manifest that grew product logic would show up
// here as an edge, rather than sitting outside every rule's reach.
const CRUISE_ROOTS = ['scripts', 'addons', 'distributions']
const BASELINE = path.join(__dirname, 'layer-baseline.json')

function parseArgv(argv) {
  const opts = {
    maxWarnings   : null,
    baselineFile  : BASELINE,
    updateBaseline: false,
    jsonOut       : null,
    list          : null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    switch (arg) {
      case '--max-warnings':
        opts.maxWarnings = Number(argv[++i])
        break
      case '--baseline':
        opts.baselineFile = path.resolve(repoRoot, argv[++i])
        break
      case '--update-baseline':
        opts.updateBaseline = true
        break
      case '--json':
        opts.jsonOut = path.resolve(repoRoot, argv[++i])
        break
      case '--list':
        // Bare --list means every rule; --list <rule> narrows it.
        opts.list = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '*'
        break
      case '--help':
      case '-h':
        usage()
        process.exit(0)
      // eslint-disable-next-line no-fallthrough -- process.exit above never returns
      default:
        console.error(`check-layers: unknown argument ${arg}`)
        usage()
        process.exit(2)
    }
  }

  return opts
}

function usage() {
  console.log(`usage: node tools/check-layers.js [options]

  --max-warnings <n>   fail if total warnings exceed n (default: baseline total)
  --baseline <file>    baseline JSON to compare against (default: tools/layer-baseline.json)
  --update-baseline    rewrite the baseline from this run's counts
  --json <file>        dump the full cruise result for offline analysis
  --list [rule]        print the individual violations (all rules, or just one)
  -h, --help           this text`)
}

function readBaseline(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

async function runCruise() {
  const ruleSet = await extractDepcruiseConfig(path.join(repoRoot, CONFIG))
  const tsConfigFile = ruleSet.options?.tsConfig?.fileName
  const tsConfig = tsConfigFile ? extractTSConfig(path.join(repoRoot, tsConfigFile)) : {}

  const result = await cruise(CRUISE_ROOTS, {ruleSet, outputType: 'json', validate: true}, {}, {tsConfig})

  return typeof result.output === 'string' ? JSON.parse(result.output) : result.output
}

function printTable(rules, budgets) {
  const nameWidth = Math.max(4, ...[...rules.keys()].map((n) => n.length))
  const pad = (s, n) => String(s).padEnd(n)
  const padStart = (s, n) => String(s).padStart(n)

  console.log('')
  console.log(`  ${pad('rule', nameWidth)}  ${padStart('count', 7)}  ${padStart('budget', 7)}  delta`)
  console.log(`  ${'-'.repeat(nameWidth)}  ${'-'.repeat(7)}  ${'-'.repeat(7)}  -----`)

  for (const [name, entry] of rules) {
    const budget = budgets?.[name]
    const delta = budget === undefined ? '' : entry.count - budget
    const marker = budget !== undefined && entry.count > budget ? '  <-- over budget' : ''
    console.log(
      `  ${pad(name, nameWidth)}  ${padStart(entry.count, 7)}  ` +
        `${padStart(budget ?? '-', 7)}  ${padStart(delta === '' ? '-' : delta > 0 ? `+${delta}` : delta, 5)}${marker}`
    )
  }
  console.log('')
}

function printViolations(rules, filter) {
  for (const [name, entry] of rules) {
    if (entry.count === 0 || (filter !== '*' && filter !== name)) {
      continue
    }
    console.log(`\n== ${name} (${entry.count})`)
    for (const violation of entry.violations) {
      // Reachability violations carry the offending path in `cycle`/`via`; the
      // from -> to pair is the reviewable part either way.
      console.log(`   ${violation.from} -> ${violation.to}`)
    }
  }
  console.log('')
}

async function main() {
  const opts = parseArgv(process.argv.slice(2))

  console.log(`check-layers: cruising ${CRUISE_ROOTS.join(' + ')} with ${CONFIG}`)

  const cruiseResult = await runCruise()
  const {forbidden} = await extractDepcruiseConfig(path.join(repoRoot, CONFIG))
  const ruleNames = forbidden.map((r) => r.name)
  const ruleSeverities = Object.fromEntries(forbidden.map((r) => [r.name, r.severity]))
  const rules = tally(cruiseResult, ruleNames, ruleSeverities)

  const {error, warn, info, totalCruised} = cruiseResult.summary
  console.log(`check-layers: ${totalCruised} modules, ${error} error / ${warn} warn / ${info} info`)

  const baseline = readBaseline(opts.baselineFile)
  if (!baseline) {
    console.log(`check-layers: no baseline at ${path.relative(repoRoot, opts.baselineFile)}`)
  }

  printTable(rules, baseline?.rules)

  if (opts.list) {
    printViolations(rules, opts.list)
  }

  if (opts.jsonOut) {
    writeFileSync(opts.jsonOut, JSON.stringify(cruiseResult, null, 1))
    console.log(`check-layers: wrote ${path.relative(repoRoot, opts.jsonOut)}`)
  }

  if (opts.updateBaseline) {
    const next = {
      $comment: baseline?.$comment ?? 'Ratchet baseline for tools/check-layers.js. Only ever lower these.',
      // Carried over rather than regenerated: $note is the hand-written audit trail
      // for every sanctioned movement, and losing it silently defeats the ratchet.
      $note   : baseline?.$note,
      measured: new Date().toISOString().slice(0, 10),
      config  : CONFIG,
      roots   : CRUISE_ROOTS,
      total   : warn,
      rules   : Object.fromEntries([...rules].map(([name, entry]) => [name, entry.count])),
    }
    writeFileSync(opts.baselineFile, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`check-layers: wrote baseline ${path.relative(repoRoot, opts.baselineFile)}`)
    return 0
  }

  const failures = evaluate(rules, {baseline, maxWarnings: opts.maxWarnings, warnCount: warn})

  if (failures.length > 0) {
    console.error('check-layers: FAILED')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    console.error('')
    console.error('  Re-run with --list <rule> to see the offending edges. If the increase is')
    console.error('  intentional, it is not: the budget only moves down. Sever the dependency.')
    return 1
  }

  console.log('check-layers: OK (no error-severity violations, no budget overruns)')
  return 0
}

process.exitCode = await main()
