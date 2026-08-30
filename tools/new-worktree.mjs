#!/usr/bin/env node
/* eslint-disable no-console */
// Create a sibling git worktree with the submodules synced and the sccache
// environment ready, so a fresh worktree builds at compiler-cache speed instead
// of recompiling the C++ tree from scratch. See the `create-worktree` skill
// (.claude/skills/create-worktree/SKILL.md) for the why and the workflow.
//
// Usage (from any worktree of this repo):
//   node tools/new-worktree.mjs <name> [--base <ref>] [--branch <branch>]
//                                       [--submodules require-pushed|remote-master]
//                                       [--build-jobs <n>] [--no-emsdk]
//
//   <name>               worktree is created at <main-worktree>-<name>
//   --base <ref>         branch point for the new branch (default: master)
//   --branch <name>      new branch name (default: <name>)
//   --submodules <mode>  how to populate submodules (default: require-pushed):
//                          require-pushed  check out the superproject's pinned
//                                          commits; FAIL if any isn't on its
//                                          remote (no local-fetch recovery).
//                          remote-master   ignore the pinned commits and put each
//                                          submodule on a new branch at its remote
//                                          master tip.
//   --build-jobs <n>     cap sculptcore builds in the new worktree to n CPU cores:
//                        writes BUILD_JOBS=n into its sculptcore/local-build-options.mjs
//                        (seeded from this worktree's options file, else the example)
//   --no-emsdk           don't point WASM builds at the main worktree's emsdk (default: do)
//
// It does NOT build anything and never touches the persistent -agent worktree.

import fs from 'fs'
import Path from 'path'
import child_process from 'child_process'

function die(msg) {
  process.stderr.write(`new-worktree: ${msg}\n`)
  process.exit(1)
}

// Run a command, returning {status, out} with stdout+stderr merged. Never throws.
function run(cmd, args, opts = {}) {
  const r = child_process.spawnSync(cmd, args, {encoding: 'utf8', ...opts})
  return {status: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '')}
}

// Run a command and die on non-zero exit, echoing output.
function runOrDie(cmd, args, opts = {}) {
  const r = run(cmd, args, opts)
  if (r.status !== 0) {
    process.stderr.write(r.out)
    die(`command failed (${r.status}): ${cmd} ${args.join(' ')}`)
  }
  return r.out
}

function fwd(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

// --- parse args ---
const argv = process.argv.slice(2)
let name = null
let base = 'master'
let branch = null
let noEmsdk = false
let submodMode = 'require-pushed'
let buildJobs = 0
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--base') base = argv[++i]
  else if (a === '--branch') branch = argv[++i]
  else if (a === '--submodules') submodMode = argv[++i]
  else if (a === '--build-jobs') buildJobs = Number(argv[++i])
  else if (a === '--no-emsdk') noEmsdk = true
  else if (a.startsWith('--')) die(`unknown flag ${a}`)
  else if (name === null) name = a
  else die(`unexpected argument ${a}`)
}
if (!name)
  die(
    'usage: node tools/new-worktree.mjs <name> [--base <ref>] [--branch <branch>] [--submodules require-pushed|remote-master] [--build-jobs <n>] [--no-emsdk]'
  )
if (submodMode !== 'require-pushed' && submodMode !== 'remote-master') {
  die(`--submodules must be 'require-pushed' or 'remote-master', got '${submodMode}'`)
}
if (buildJobs && (!Number.isInteger(buildJobs) || buildJobs < 1)) {
  die(`--build-jobs must be a positive integer, got '${buildJobs}'`)
}
branch = branch || name

// --- resolve the MAIN worktree root (parent of the shared .git common dir) ---
const commonDir = runOrDie('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
const MAIN = fwd(Path.dirname(commonDir))
const DEST = `${MAIN}-${name}`

if (fs.existsSync(DEST)) die(`destination already exists: ${DEST}`)

console.log(`main worktree : ${MAIN}`)
console.log(`new worktree  : ${DEST}`)
console.log(`branch        : ${branch}  (base ${base})`)

// --- create the worktree ---
runOrDie('git', ['-C', MAIN, 'worktree', 'add', '-b', branch, DEST, base])

// --- populate submodules ---
// Two policies, both relying ONLY on the submodules' own remotes (no local-fetch
// of unpushed pinned commits — that recovery path was removed deliberately):
//   require-pushed  check out the superproject's pinned commits, failing loudly
//                   if any isn't reachable from its remote.
//   remote-master   ignore the pinned commits; branch each submodule from its
//                   remote master tip.
if (submodMode === 'remote-master') branchSubmodulesFromRemoteMaster()
else syncSubmodulesRequirePushed()

function syncSubmodulesRequirePushed() {
  const r = run('git', ['-C', DEST, 'submodule', 'update', '--init', '--recursive'])
  if (r.status === 0) {
    console.log('submodules: synced to pinned commits')
    // verify clean (every line at its pinned commit -> leading space)
    const status = runOrDie('git', ['-C', DEST, 'submodule', 'status', '--recursive'])
    const dirty = status.split('\n').filter((l) => l && !l.startsWith(' '))
    if (dirty.length) {
      process.stderr.write(dirty.join('\n') + '\n')
      die('submodules not at pinned commits after sync')
    }
    return
  }
  process.stderr.write(r.out)
  const m = r.out.match(/submodule path '([^']+)'.*?([0-9a-f]{40})/s)
  const which = m
    ? `submodule '${m[1]}' is pinned to ${m[2].slice(0, 10)}, which isn't on its remote`
    : 'a submodule pinned commit could not be fetched from its remote'
  die(
    `${which}.\n` +
      `Push the missing submodule commit(s) to their remotes, then retry; or re-run with\n` +
      `  --submodules remote-master\n` +
      `to branch each submodule from its remote master instead of the pinned commit.`
  )
}

function branchSubmodulesFromRemoteMaster() {
  console.log(`submodules: branching each from its remote master (ignoring pinned commits) onto '${branch}'`)
  // --remote fetches and checks out each submodule's configured/default remote
  // branch tip instead of the recorded (possibly unpushed) SHA.
  runOrDie('git', ['-C', DEST, 'submodule', 'update', '--init', '--recursive', '--remote'])
  // Turn the detached remote-tip checkout into a working branch in each submodule.
  runOrDie('git', [
    '-C',
    DEST,
    'submodule',
    'foreach',
    '--recursive',
    `git switch -c ${branch} 2>/dev/null || git switch ${branch}`,
  ])
  console.log(`submodules: each on new branch '${branch}' at its remote master tip`)
}

// --- copy the local eslint cache (content-addressed; safe to share) ---
// tools/eslint.mts keys its result/config cache entries by (config hash, eslint
// version, CLI args, path relative to the repo root, file-content hash) — none
// of which are worktree-specific — so copying the whole directory verbatim
// gives the new worktree a warm cache instead of relinting the tree cold.
{
  const srcCache = Path.join(MAIN, '.eslintcache')
  if (fs.existsSync(srcCache)) {
    fs.cpSync(srcCache, Path.join(DEST, '.eslintcache'), {recursive: true})
    console.log('eslint cache  : copied from main worktree (warm lint cache)')
  }
}

// --- cap build parallelism via sculptcore's local-build-options.mjs ---
// BUILD_JOBS feeds every make.mjs build mode (wasm/native/node, debug/sbrush
// targets, deps builds). Seed the new worktree's (gitignored) options file from
// this worktree's, else from the tracked example, so the user's other knobs
// carry over; then set/override BUILD_JOBS.
if (buildJobs > 0) {
  const destOpts = Path.join(DEST, 'sculptcore', 'local-build-options.mjs')
  const seeds = [
    Path.join(MAIN, 'sculptcore', 'local-build-options.mjs'),
    Path.join(DEST, 'sculptcore', 'local-build-options.mjs.example'),
  ]
  const seed = seeds.find((p) => fs.existsSync(p))
  let text = seed ? fs.readFileSync(seed, 'utf8') : 'export default {\n}\n'
  if (/^\s*BUILD_JOBS\s*:/m.test(text)) {
    text = text.replace(/^(\s*BUILD_JOBS\s*:\s*)\d+/m, `$1${buildJobs}`)
  } else {
    text = text.replace(
      /\n}\s*$/,
      `\n\n  /** Max parallel compile jobs, all build modes (0 = all cores). */\n  BUILD_JOBS: ${buildJobs},\n}\n`
    )
  }
  if (!/^\s*BUILD_JOBS\s*:/m.test(text)) {
    die(`could not set BUILD_JOBS in ${seed ?? '(builtin template)'} — unexpected file shape`)
  }
  fs.writeFileSync(destOpts, text)
  console.log(`build jobs    : capped at ${buildJobs} (BUILD_JOBS in sculptcore/local-build-options.mjs)`)
}

// --- resolve a shared emsdk to borrow (avoid the 2.4 GB reinstall) ---
// Rather than junction emsdk into the new worktree (a reparse point that a later
// `rm -rf` of the worktree would follow and destroy), we point the build at the
// main worktree's emsdk via SCULPTCORE_EMSDK_DIR (honored by configureEnv.mjs).
// Nothing is placed inside the new worktree, so teardown can never touch the
// shared install. Disable with --no-emsdk.
const mainEmsdk = `${MAIN}/sculptcore/emsdk`
let emsdkRedirect = ''
if (!noEmsdk) {
  if (fs.existsSync(Path.join(mainEmsdk.replace(/\//g, Path.sep), 'upstream'))) {
    emsdkRedirect = mainEmsdk
    console.log(`emsdk: WASM builds will borrow ${mainEmsdk} via SCULPTCORE_EMSDK_DIR (no reinstall)`)
  } else {
    console.log('emsdk: main worktree has no install; WASM builds here need `node make.mjs install-emsdk`')
  }
}

// --- emit per-worktree sccache env scripts ---
// SCCACHE_BASEDIRS = this worktree's own root, so the absolute paths that leak
// into preprocessed output (line markers, __FILE__) are normalized away and
// compiles cross-hit the shared cache from any worktree. SCCACHE_DIR is the
// single shared cache (sccache's own default location).
// SCCACHE_BASEDIRS is no longer set here — the cross-worktree launcher
// (tools/sccache-wrapper) manages it from the registry, unioning every live
// worktree's root so one server caches for all of them. We still pin SCCACHE_DIR
// to the shared default cache (and the emsdk redirect) for convenience.
const localAppData = process.env.LOCALAPPDATA ? fwd(process.env.LOCALAPPDATA) : ''
const sccacheDirSh = localAppData ? `${localAppData}/sccache` : '$HOME/.cache/sccache'

const ps1Emsdk = emsdkRedirect ? `$env:SCULPTCORE_EMSDK_DIR = "${emsdkRedirect}"\n` : ''
const shEmsdk = emsdkRedirect ? `export SCULPTCORE_EMSDK_DIR="${emsdkRedirect}"\n` : ''

const ps1 = `# Auto-generated by tools/new-worktree.mjs. Dot-source before building:
#   . .\\worktree-env.ps1
# SCCACHE_BASEDIRS is set per-compile by the sccache cross-worktree launcher.
$env:SCCACHE_DIR = "$env:LOCALAPPDATA\\sccache"
${ps1Emsdk}Write-Host "sccache env: DIR=$env:SCCACHE_DIR (BASEDIRS launcher-managed)"
# SCCACHE_SERVER_PIPE selects the named-pipe server (set globally, e.g.
# 'sccache-<user>'); the cross-worktree launcher inherits and forwards it to the
# (re)started server. Without it sccache falls back to the TCP-port server, whose
# port can stick after a kill -- the bug the named-pipe mode fixes.
if ($env:SCCACHE_SERVER_PIPE) {
  Write-Host "sccache env: SERVER_PIPE=$env:SCCACHE_SERVER_PIPE"
} else {
  Write-Warning "SCCACHE_SERVER_PIPE is not set in the global environment; sccache will use the TCP-port server. Set it once with: setx SCCACHE_SERVER_PIPE sccache-$env:USERNAME"
}
if (-not (Get-Command sccache -ErrorAction SilentlyContinue)) {
  Write-Warning "sccache not found on PATH; builds will run without the compiler cache"
}
`

const sh = `#!/usr/bin/env bash
# Auto-generated by tools/new-worktree.mjs. Source before building:
#   source worktree-env.sh
# SCCACHE_BASEDIRS is set per-compile by the sccache cross-worktree launcher.
export SCCACHE_DIR="${sccacheDirSh}"
${shEmsdk}echo "sccache env: DIR=$SCCACHE_DIR (BASEDIRS launcher-managed)"
# SCCACHE_SERVER_PIPE selects the Windows named-pipe server (set globally, e.g.
# 'sccache-<user>') and is inherited/forwarded by the cross-worktree launcher.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ -n "\${SCCACHE_SERVER_PIPE:-}" ]; then
      echo "sccache env: SERVER_PIPE=$SCCACHE_SERVER_PIPE"
    else
      echo "warning: SCCACHE_SERVER_PIPE not set; sccache will use the TCP-port server"
    fi
    ;;
esac
command -v sccache >/dev/null 2>&1 || echo "warning: sccache not found on PATH"
`

fs.writeFileSync(Path.join(DEST, 'worktree-env.ps1'), ps1)
fs.writeFileSync(Path.join(DEST, 'worktree-env.sh'), sh)

// Build the cross-worktree sccache launcher (if needed) and register this new
// worktree into the shared registry, so its first build is a cache hit and the
// server already knows about it (no mid-build restart). Best-effort.
{
  const setup = `${MAIN}/tools/sccache-wrapper/setup.mjs`
  if (fs.existsSync(setup)) {
    const r = run('node', [setup, '--root', DEST])
    process.stdout.write(r.out)
    if (r.status !== 0) console.log('note: sccache launcher setup failed; builds fall back to plain sccache')
  }
}

console.log('\nworktree ready. next steps:')
console.log(`  cd ${DEST}`)
console.log('  . .\\worktree-env.ps1            # PowerShell  (or: source worktree-env.sh)')
console.log('  cd sculptcore')
console.log('  pnpm i                                  # make.mjs deps (yargs, cmake-js, ...)')
console.log('  node extern/wgpu_native/fetch.mjs       # wgpu-native headers/lib')
console.log('  node make.mjs fetch-wgpu-native         # native-only prebuilt (not checked in)')
console.log('  node make.mjs configure native   # prints "sccache cross-worktree launcher enabled"')
console.log('  node make.mjs build native')
console.log('\nnote: the cross-worktree launcher manages SCCACHE_BASEDIRS and restarts')
console.log('the server automatically when a new worktree joins — no manual')
console.log('`sccache --stop-server` needed when switching worktrees.')
console.log('\nteardown when done (safe — nothing is junctioned into the worktree):')
console.log(`  git -C ${MAIN} worktree remove --force ${DEST}`)
