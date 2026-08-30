#!/usr/bin/env node
/* eslint-disable no-console */
// Build + register the cross-worktree sccache launcher (see sccache_launcher.cc
// and the create-worktree skill). Idempotent and cheap; safe to run on every
// `make.mjs configure native`.
//
//   node tools/sccache-wrapper/setup.mjs [--root <worktree>]
//
//   --root <path>   the worktree to register (default: auto-detected — the
//                   superproject working tree, or this repo if not a submodule).
//                   new-worktree.mjs passes the freshly-created worktree here.
//
// What it does, all into the shared sibling dir C:/dev/sccache-worktrees:
//   1. ensures the shared dir exists;
//   2. (re)compiles sccache-launcher(.exe) from sccache_launcher.cc with the
//      project's clang++ when the binary is missing or older than the source;
//   3. writes "<basename>.<hash>.txt" = the worktree's absolute root, so the
//      launcher unions it into SCCACHE_BASEDIRS.
//
// A no-op (exit 0) when not in a git repo or the source file is absent (e.g.
// sculptcore built standalone), so callers can invoke it unconditionally.

import fs from 'fs'
import Path from 'path'
import crypto from 'crypto'
import child_process from 'child_process'

const isWin = process.platform === 'win32'

function run(cmd, args, opts = {}) {
  const r = child_process.spawnSync(cmd, args, {encoding: 'utf8', ...opts})
  return {status: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '')}
}

function fwd(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

// --- parse args ---
let root = null
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') root = argv[++i]
  else {
    process.stderr.write(`sccache-setup: unknown arg ${argv[i]}\n`)
    process.exit(2)
  }
}

// --- resolve the worktree root to register ---
if (!root) {
  // In a submodule, --show-superproject-working-tree gives the outer worktree;
  // empty when we're already in the top-level repo.
  const sup = run('git', ['rev-parse', '--show-superproject-working-tree'])
  const top = run('git', ['rev-parse', '--show-toplevel'])
  const r = (sup.status === 0 && sup.out.trim()) || (top.status === 0 && top.out.trim())
  if (!r) {
    process.stderr.write('sccache-setup: not a git repo; skipping\n')
    process.exit(0)
  }
  root = r
}
root = fwd(Path.resolve(root))

// --- locate source + shared dir ---
const src = `${root}/tools/sccache-wrapper/sccache_launcher.cc`
if (!fs.existsSync(src)) {
  process.stderr.write(`sccache-setup: launcher source not found (${src}); skipping\n`)
  process.exit(0)
}

// Shared dir sits beside the worktrees: C:/dev/<worktree> -> C:/dev/sccache-worktrees
const sharedDir = `${fwd(Path.dirname(root))}/sccache-worktrees`
fs.mkdirSync(sharedDir, {recursive: true})

const exe = `${sharedDir}/sccache-launcher${isWin ? '.exe' : ''}`

// --- (re)build the launcher when stale ---
function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return -1
  }
}
if (mtime(exe) < mtime(src)) {
  console.log(`sccache-setup: building launcher -> ${exe}`)
  const compile = ['clang++', '-std=c++17', '-O2', '-o', exe, src]
  let r
  if (isWin) {
    // clang++ needs the MSVC environment (STL headers, linker) — run it through
    // the same configureEnv.mjs the native build uses. It execs args.join(' ').
    // configureEnv.mjs runs `args.join(' ')` under a shell, so pre-quote any
    // token with spaces and hand them over as separate args (it re-joins them).
    const configureEnv = `${root}/sculptcore/configureEnv.mjs`
    const tokens = compile.map((a) => (a.includes(' ') ? `"${a}"` : a))
    r = run('node', [configureEnv, ...tokens], {stdio: 'pipe'})
  } else {
    r = run(compile[0], compile.slice(1))
  }
  if (r.status !== 0 || !fs.existsSync(exe)) {
    process.stderr.write(r.out)
    process.stderr.write('sccache-setup: launcher build failed; builds fall back to plain sccache\n')
    process.exit(0) // non-fatal: cmake falls back to find_program(sccache)
  }
}

// --- register this worktree ---
const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8)
const regFile = `${sharedDir}/${Path.basename(root)}.${hash}.txt`
const prev = fs.existsSync(regFile) ? fwd(fs.readFileSync(regFile, 'utf8').trim()) : null
if (prev !== root) {
  fs.writeFileSync(regFile, root + '\n')
  console.log(`sccache-setup: registered ${root}`)
}
console.log(`sccache-setup: launcher ${exe}`)
