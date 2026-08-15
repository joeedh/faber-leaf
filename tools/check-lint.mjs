#!/usr/bin/env node
/**
 * Lint ratchet: runs ESLint over the repo, prints a per-rule table, and fails
 * when any rule's count exceeds its budget in tools/lint-baseline.json.
 *
 * NOT WIRED INTO CI. The repo carries a large untriaged violation backlog, and
 * ratcheting a backlog nobody has looked at just declares it acceptable — at
 * tens of minutes of wall-clock per run, since the config is type-aware. This
 * runs by hand until P9 triages it; see the §5 step 4 correction in
 * documentation/plans/2026-08-15-0300-ci-and-layer-gate-repair.md.
 *
 * Mechanism, for when it is adopted: same as tools/check-layers.js. A rule with
 * no budget entry has a budget of 0, so a newly-triggered rule fails rather
 * than slipping in unnoticed. Budgets only ever move down — lower them
 * (`--update-baseline`) in the same PR that fixes the violations.
 */

import {ESLint} from 'eslint'
import {readFileSync, writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

const BASELINE = path.join(__dirname, 'lint-baseline.json')
const LINT_ROOTS = ['.']

/**
 * Type-aware linting of the whole tree exceeds node's default ~4 GB old-space
 * and dies with "Ineffective mark-compacts near heap limit". Re-exec once with
 * a bigger heap so callers (and CI) don't have to know.
 */
const HEAP_MB = 8192

function reexecWithHeap() {
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, __filename, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env  : {...process.env, CHECK_LINT_CHILD: '1'},
    }
  )
  return result.status ?? 1
}

function parseArgv(argv) {
  const opts = {
    baselineFile  : BASELINE,
    updateBaseline: false,
    list          : null,
    // Off by default: ESLint rewrites .eslintcache as it goes, and on Windows
    // that write amplification (plus a virus scanner on every rewrite) costs
    // more than the cache saves on a cold run.
    cache         : false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    switch (arg) {
      case '--baseline':
        opts.baselineFile = path.resolve(repoRoot, argv[++i])
        break
      case '--update-baseline':
        opts.updateBaseline = true
        break
      case '--cache':
        opts.cache = true
        break
      case '--list':
        // Bare --list means every rule over budget; --list <rule> narrows it.
        opts.list = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '*'
        break
      case '--help':
      case '-h':
        usage()
        process.exit(0)
      // eslint-disable-next-line no-fallthrough -- process.exit above never returns
      default:
        console.error(`check-lint: unknown argument ${arg}`)
        usage()
        process.exit(2)
    }
  }

  return opts
}

function usage() {
  console.log(`usage: node tools/check-lint.mjs [options]

  --baseline <file>    baseline JSON to compare against (default: tools/lint-baseline.json)
  --update-baseline    rewrite the baseline from this run's counts
  --cache              use .eslintcache (helps on re-runs, a slowdown when cold)
  --list [rule]        print the individual messages (over-budget rules, or just one)
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

/** rule id -> {count, errors, warnings, messages}. Fatal parse errors carry no
 *  ruleId, so they are bucketed under a synthetic name rather than dropped. */
function tally(results) {
  const rules = new Map()
  let errors = 0
  let warnings = 0

  for (const result of results) {
    for (const message of result.messages) {
      const name = message.ruleId ?? '(parse-error)'
      if (!rules.has(name)) {
        rules.set(name, {count: 0, errors: 0, warnings: 0, messages: []})
      }
      const entry = rules.get(name)
      entry.count++
      if (message.severity === 2) {
        entry.errors++
        errors++
      } else {
        entry.warnings++
        warnings++
      }
      entry.messages.push({file: path.relative(repoRoot, result.filePath), line: message.line, text: message.message})
    }
  }

  return {rules: new Map([...rules].sort((a, b) => b[1].count - a[1].count)), errors, warnings}
}

function printTable(rules, budgets) {
  const nameWidth = Math.max(4, ...[...rules.keys()].map((n) => n.length))
  const pad = (s, n) => String(s).padEnd(n)
  const padStart = (s, n) => String(s).padStart(n)

  console.log('')
  console.log(`  ${pad('rule', nameWidth)}  ${padStart('count', 7)}  ${padStart('budget', 7)}  delta`)
  console.log(`  ${'-'.repeat(nameWidth)}  ${'-'.repeat(7)}  ${'-'.repeat(7)}  -----`)

  for (const [name, entry] of rules) {
    const budget = budgets?.[name] ?? 0
    const delta = entry.count - budget
    const marker = delta > 0 ? '  <-- over budget' : ''
    console.log(
      `  ${pad(name, nameWidth)}  ${padStart(entry.count, 7)}  ${padStart(budget, 7)}  ` +
        `${padStart(delta > 0 ? `+${delta}` : delta, 5)}${marker}`
    )
  }
  console.log('')
}

function printMessages(rules, filter, budgets) {
  for (const [name, entry] of rules) {
    const overBudget = entry.count > (budgets?.[name] ?? 0)
    if (filter === '*' ? !overBudget : filter !== name) {
      continue
    }
    console.log(`\n== ${name} (${entry.count})`)
    for (const message of entry.messages) {
      console.log(`   ${message.file}:${message.line}  ${message.text}`)
    }
  }
  console.log('')
}

async function main() {
  const opts = parseArgv(process.argv.slice(2))

  console.log(`check-lint: linting ${LINT_ROOTS.join(' + ')}`)

  // overrideConfigFile pins every file to the repo-root config. ESLint 10
  // resolves config from each linted file's directory upward by default, which
  // hands scripts/path.ux/ and scripts/mathl/ to their own submodule configs —
  // defeating this repo's globalIgnores and linting two submodules the parent
  // repo cannot land a fix in.
  const eslint = new ESLint({
    cwd               : repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.config.js'),
    cache             : opts.cache,
    cacheLocation     : path.join(repoRoot, '.eslintcache'),
  })
  const results = await eslint.lintFiles(LINT_ROOTS)
  const {rules, errors, warnings} = tally(results)

  console.log(`check-lint: ${results.length} files, ${errors} error / ${warnings} warn`)

  const baseline = readBaseline(opts.baselineFile)
  if (!baseline) {
    console.log(`check-lint: no baseline at ${path.relative(repoRoot, opts.baselineFile)}`)
  }

  printTable(rules, baseline?.rules)

  if (opts.list) {
    printMessages(rules, opts.list, baseline?.rules)
  }

  if (opts.updateBaseline) {
    const next = {
      $comment: baseline?.$comment ?? 'Ratchet baseline for tools/check-lint.mjs. Only ever lower these.',
      measured: new Date().toISOString().slice(0, 10),
      roots   : LINT_ROOTS,
      errors,
      warnings,
      rules: Object.fromEntries([...rules].map(([name, entry]) => [name, entry.count])),
    }
    writeFileSync(opts.baselineFile, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`check-lint: wrote baseline ${path.relative(repoRoot, opts.baselineFile)}`)
    return 0
  }

  const failures = []
  for (const [name, entry] of rules) {
    const budget = baseline?.rules?.[name] ?? 0
    if (entry.count > budget) {
      failures.push(`${name}: ${entry.count} > budget ${budget} (+${entry.count - budget})`)
    }
  }

  if (failures.length > 0) {
    console.error('check-lint: FAILED')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    console.error('')
    console.error('  Re-run with --list to see the offending lines. The budget only moves down:')
    console.error('  fix the new violations rather than raising it.')
    return 1
  }

  console.log('check-lint: OK (no rule over budget)')
  return 0
}

process.exitCode = process.env.CHECK_LINT_CHILD ? await main() : reexecWithHeap()
