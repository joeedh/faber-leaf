/**
 * Per-worktree Chromium profile location for the NW.js shell.
 *
 * The Chromium `--user-data-dir` holds ONLY Chromium internals (single-instance
 * lock, GPU cache, Crashpad) — no app state (that lives in `<cwd>/.sculptcore`).
 * Keying it on the manifest `name` (NW.js's default) makes every git worktree
 * share one profile, so two worktrees can't run NW.js at once and their crash
 * dumps collide. We instead derive it from the worktree root, giving each
 * checkout its own profile, with a per-instance subdir for concurrent windows.
 *
 * This module is dependency-free ESM so both `launch.mjs` and the crash toolkit
 * (`sculptcore/crash/dump.mjs`) can compute the same paths.
 */
import {createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {basename, join, resolve} from 'node:path'

/** OS-appropriate base for app-scoped cache/profile data. The app name here is
 * a literal on purpose — this module is dependency-free and never reads the
 * manifest — so a `package.json` rename does NOT move it. Keep the two in sync. */
function localAppBase() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'faber-leaf')
  }
  return join(homedir(), '.cache', 'faber-leaf')
}

/** Stable, readable per-worktree token: `<dir-basename>-<hash8>`. The hash is
 * over the case-folded absolute root so Windows path casing doesn't fork it. */
export function worktreeToken(root) {
  const abs = resolve(root)
  const hash = createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8)
  return `${basename(abs)}-${hash}`
}

/** Directory holding all Chromium profiles for the worktree rooted at @p root. */
export function profileBaseForRoot(root) {
  return join(localAppBase(), 'worktrees', worktreeToken(root))
}

/**
 * The concrete `--user-data-dir` for a launch.
 * @param instance  undefined → the shared `default` profile; a name → `inst-<name>`.
 */
export function profileDirForRoot(root, instance) {
  const base = profileBaseForRoot(root)
  return instance ? join(base, `inst-${instance}`) : join(base, 'default')
}

/** Where Crashpad writes minidumps under a given `--user-data-dir`. */
export function crashReportsDir(userDataDir) {
  return join(userDataDir, 'Crashpad', 'reports')
}
