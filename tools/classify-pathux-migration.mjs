/* eslint-disable no-console */
#!/usr/bin/env node
/**
 * Computes the set of symbols that an addon importing from `@framework/api`
 * is *actually* getting from pathux (via the `export * from
 * './path.ux/scripts/pathux.js'` line in `scripts/framework_api.ts`), so we
 * can mechanically rewrite those imports to `@framework/pathux` and then
 * drop the star re-export.
 *
 * Output:
 *   - pathux-only:  in pathux's recursive export graph AND not explicitly
 *                   re-exported by framework_api.ts via a non-star line.
 *   - framework:    explicitly re-exported by framework_api.ts (these stay
 *                   on @framework/api).
 *   - both:         appear in both sets (these can stay on @framework/api;
 *                   safe to leave them).
 *
 * Usage: node tools/classify-pathux-migration.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {parseExportNames} from './addon_api_plugin.js'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '..')
const FAPI = path.join(REPO_ROOT, 'scripts', 'framework_api.ts')
const PATHUX = path.join(REPO_ROOT, 'scripts', 'path.ux', 'scripts', 'pathux.ts')

function stripComments(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '')
  s = s.replace(/(^|[^:\/])\/\/[^\n]*/g, '$1')
  return s
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = []
  const ext = path.extname(base)
  if (ext) {
    candidates.push(base)
    if (ext === '.js') {
      const stem = base.slice(0, -3)
      candidates.push(stem + '.ts', stem + '.tsx')
    }
  } else {
    candidates.push(base + '.ts', base + '.tsx', base + '.js', base + '.mjs')
    candidates.push(path.join(base, 'index.ts'))
    candidates.push(path.join(base, 'index.tsx'))
    candidates.push(path.join(base, 'index.js'))
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

function collectExports(file, visited = new Set()) {
  if (visited.has(file)) return new Set()
  visited.add(file)
  const src = fs.readFileSync(file, 'utf-8')
  const names = new Set(parseExportNames(src))
  const cleaned = stripComments(src)
  const starRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g
  for (const m of cleaned.matchAll(starRe)) {
    const resolved = resolveSpec(file, m[1])
    if (!resolved) continue
    for (const n of collectExports(resolved, visited)) names.add(n)
  }
  return names
}

// 1. All pathux value exports (recursive)
const pathuxNames = collectExports(PATHUX)

// 2. framework_api.ts explicit exports (parseExportNames already skips
//    `export *` and `export type`)
const fapiSrc = fs.readFileSync(FAPI, 'utf-8')
const fapiExplicit = new Set(parseExportNames(fapiSrc))

// 3. Classification
const pathuxOnly = []
const both = []
for (const n of [...pathuxNames].sort()) {
  if (fapiExplicit.has(n)) both.push(n)
  else pathuxOnly.push(n)
}
const fapiOnly = [...fapiExplicit].filter((n) => !pathuxNames.has(n)).sort()

console.log(`# pathux-only (${pathuxOnly.length}) — migrate these from @framework/api to @framework/pathux`)
for (const n of pathuxOnly) console.log(n)
console.log()
console.log(`# both (${both.length}) — already explicit in framework_api.ts; stay on @framework/api`)
for (const n of both) console.log(n)
console.log()
console.log(`# framework-only (${fapiOnly.length}) — stay on @framework/api`)
for (const n of fapiOnly) console.log(n)
