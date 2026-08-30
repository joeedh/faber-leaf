#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Migrates addon imports of pathux-sourced symbols from `@framework/api`
 * to `@framework/pathux`. Run AFTER the runtime resolver + pathux runtime
 * exposure are in place; immediately before dropping the `export * from
 * './path.ux/scripts/pathux.js'` line from `scripts/framework_api.ts`.
 *
 * Behavior:
 *   - Walks `addons/builtin/**\/*.{ts,tsx,js,mjs}`.
 *   - For each ES import statement targeting `@framework/api`, splits the
 *     named bindings into "framework" (explicit non-pathux exports of
 *     framework_api.ts) and "pathux" (everything else, i.e. anything that
 *     resolves to a pathux symbol today via the star re-export).
 *   - Rewrites the file in place: leaves the framework names on the
 *     original import, and emits a second `import {...} from
 *     '@framework/pathux'` line directly after.
 *   - Skips type-only imports (`import type {...}`) — those keep working
 *     through tsconfig paths.
 *   - Idempotent: if everything is already pathux-only, the original line
 *     is removed instead of being left as an empty import.
 *
 * Pass --dry-run to preview without writing.
 */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {parseExportNames} from './addon_api_plugin.js'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '..')
const DRY = process.argv.includes('--dry-run')

function stripComments(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '')
  s = s.replace(/(^|[^:\/])\/\/[^\n]*/g, '$1')
  return s
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  const cands = []
  const ext = path.extname(base)
  if (ext) {
    cands.push(base)
    if (ext === '.js') {
      const stem = base.slice(0, -3)
      cands.push(stem + '.ts', stem + '.tsx')
    }
  } else {
    cands.push(base + '.ts', base + '.tsx', base + '.js', base + '.mjs')
    cands.push(path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.js'))
  }
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  return null
}

function collectExports(file, visited = new Set()) {
  if (visited.has(file)) return new Set()
  visited.add(file)
  const src = fs.readFileSync(file, 'utf-8')
  const names = new Set(parseExportNames(src))
  const cleaned = stripComments(src)
  for (const m of cleaned.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
    const r = resolveSpec(file, m[1])
    if (!r) continue
    for (const n of collectExports(r, visited)) names.add(n)
  }
  return names
}

const FAPI = path.join(REPO_ROOT, 'scripts', 'framework_api.ts')
const PATHUX = path.join(REPO_ROOT, 'scripts', 'path.ux', 'scripts', 'pathux.ts')

// Symbols explicitly re-exported by framework_api.ts (excludes pathux star).
const fapiExplicit = new Set(parseExportNames(fs.readFileSync(FAPI, 'utf-8')))

// Also collect type-only re-exports from framework_api.ts so the codemod
// doesn't warn on them. They're erased at runtime but at the import site
// they live on @framework/api.
const fapiSrcRaw = fs.readFileSync(FAPI, 'utf-8')
const fapiTypeOnly = new Set()
for (const m of fapiSrcRaw.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
  for (const raw of m[1].split(',')) {
    const t = raw.trim()
    if (!t) continue
    const name = t
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)[0]
      .trim()
    if (name) fapiTypeOnly.add(name)
  }
}
for (const n of fapiTypeOnly) fapiExplicit.add(n)

const pathuxNames = collectExports(PATHUX)

// Decision rule per imported name:
//   - if explicitly re-exported by framework_api.ts: stay on @framework/api
//   - else: move to @framework/pathux
//
// Unknown names (not in either set) we keep on @framework/api and warn — this
// catches typos and surfaces stale imports.
function classify(name) {
  if (fapiExplicit.has(name)) return 'framework'
  if (pathuxNames.has(name)) return 'pathux'
  return 'unknown'
}

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'build') continue
      yield* walk(p)
    } else if (/\.(ts|tsx|js|mjs)$/.test(ent.name)) {
      yield p
    }
  }
}

// Match: import [type] { ... } from '@framework/api'
// Captures: 1=type keyword (or undef), 2=bindings inside braces, 3=quote
const importRe = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+(['"])@framework\/api\3/g

function rewriteFile(file) {
  const orig = fs.readFileSync(file, 'utf-8')
  let changed = false
  const unknowns = []

  const out = orig.replace(importRe, (full, typeKw, bindings, quote) => {
    if (typeKw) return full // type-only: leave alone

    // Parse bindings. Each item: `Name` or `Name as Alias`. Whitespace/comments noted but rare.
    const items = bindings
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const frameworkItems = []
    const pathuxItems = []

    for (const item of items) {
      // Skip embedded `type` markers on individual names
      const m = item.match(/^(type\s+)?([A-Za-z_$][\w$]*)(\s+as\s+[A-Za-z_$][\w$]*)?$/)
      if (!m) {
        // Couldn't parse — bail conservatively, keep on framework
        frameworkItems.push(item)
        continue
      }
      const isType = !!m[1]
      const name = m[2]
      if (isType) {
        // type-only individual: classification doesn't matter for runtime
        // but framework_api.ts has type-only exports too. Keep it where it
        // currently resolves at type level — if pathux has the name, prefer
        // pathux to mirror the runtime split; else framework.
        if (pathuxNames.has(name) && !fapiExplicit.has(name)) pathuxItems.push(item)
        else frameworkItems.push(item)
        continue
      }
      const cls = classify(name)
      if (cls === 'pathux') pathuxItems.push(item)
      else if (cls === 'framework') frameworkItems.push(item)
      else {
        unknowns.push(name)
        frameworkItems.push(item)
      }
    }

    if (pathuxItems.length === 0) return full
    changed = true

    const fw = frameworkItems.length ? `import {${frameworkItems.join(', ')}} from ${quote}@framework/api${quote}` : ''
    const px = `import {${pathuxItems.join(', ')}} from ${quote}@framework/pathux${quote}`

    if (fw) return `${fw}\n${px}`
    return px
  })

  if (unknowns.length) {
    console.warn(`  ${path.relative(REPO_ROOT, file)}: unknown names kept on @framework/api: ${unknowns.join(', ')}`)
  }

  if (changed && !DRY) {
    fs.writeFileSync(file, out)
  }
  return changed
}

const ADDONS_DIR = path.join(REPO_ROOT, 'addons', 'builtin')
let n = 0
for (const f of walk(ADDONS_DIR)) {
  if (rewriteFile(f)) {
    n++
    console.log(`${DRY ? '[dry] ' : ''}rewrote ${path.relative(REPO_ROOT, f)}`)
  }
}
console.log(`${DRY ? '[dry-run] would rewrite' : 'rewrote'} ${n} file(s).`)
