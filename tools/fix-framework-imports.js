#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Converts default-style and namespace-style imports of `@framework/api`
 * into named imports, since the alias re-export hub uses named exports.
 *
 *   import addonManager from '@framework/api'  →  import {addonManager} from '@framework/api'
 *   import * as util from '@framework/api'     →  import {util} from '@framework/api'
 *
 * The `import * as foo` form previously meant "the foo subsystem"; the
 * framework_api hub exposes those subsystems as named namespace re-exports
 * (`export * as util from './util/util.js'`), so a destructured named
 * import gets the same shape.
 */

import fs from 'fs'
import Path from 'path'
import {fileURLToPath} from 'url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '..')
const ROOT = Path.join(REPO_ROOT, 'addons', 'builtin')

const RE_STAR = /import\s+\*\s+as\s+(\w+)\s+from\s+'@framework\/api'/g
const RE_DEFAULT = /import\s+(\w+)\s+from\s+'@framework\/api'/g

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = Path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      walk(p, out)
    } else if (/\.(ts|js)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

let touched = 0
let count = 0
for (const file of walk(ROOT, [])) {
  let src = fs.readFileSync(file, 'utf-8')
  let n = 0
  src = src.replace(RE_STAR, (_m, name) => {
    n++
    return `import {${name}} from '@framework/api'`
  })
  src = src.replace(RE_DEFAULT, (_m, name) => {
    n++
    return `import {${name}} from '@framework/api'`
  })
  if (n > 0) {
    fs.writeFileSync(file, src)
    touched++
    count += n
    console.log(`  ${Path.relative(REPO_ROOT, file)}: ${n} fix(es)`)
  }
}
console.log(`\nfixed ${count} import(s) across ${touched} file(s)`)
