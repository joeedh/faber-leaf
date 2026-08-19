/**
 * Which distribution this build is for, and what that implies for the tools.
 *
 * A distribution (`distributions/<id>/index.ts`) declares the app's addon set,
 * startup scene and title — see scripts/addon/distribution.ts. The build needs
 * two facts out of it before esbuild runs, so they are read from the entry
 * file's source rather than by evaluating it:
 *
 *   - which module `@distribution` resolves to;
 *   - which builtins ship *in* the main bundle, i.e. which `@builtin/<id>`
 *     specifiers the entry imports. That is the same specifier esbuild
 *     resolves, not a guess about intent: an addon reaches the bundle by being
 *     imported that way and no other. It decides which addons contribute build
 *     assets (litemesh's WASM) and which are left to build-addons.js.
 *
 * `--distribution <name>` / `--distribution=<name>` selects it; the default is
 * `faber-leaf`.
 */

import fs from 'fs'
import Path from 'path'
import {fileURLToPath} from 'url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '..')
const DIST_DIR = Path.join(REPO_ROOT, 'distributions')

export const DEFAULT_DISTRIBUTION = 'faber-leaf'

/** Every distribution on disk, for error messages and `--help`. */
export function listDistributions() {
  if (!fs.existsSync(DIST_DIR)) {
    return []
  }
  return fs
    .readdirSync(DIST_DIR, {withFileTypes: true})
    .filter((e) => e.isDirectory() && fs.existsSync(Path.join(DIST_DIR, e.name, 'index.ts')))
    .map((e) => e.name)
}

/** Reads `--distribution <name>` out of an argv array. */
export function resolveDistributionName(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--distribution') {
      return argv[i + 1] ?? DEFAULT_DISTRIBUTION
    }
    if (arg.startsWith('--distribution=')) {
      return arg.slice('--distribution='.length)
    }
  }
  return DEFAULT_DISTRIBUTION
}

/** Absolute path to a distribution's entry module. Throws if it is not there. */
export function distributionEntry(name = DEFAULT_DISTRIBUTION) {
  const entry = Path.join(DIST_DIR, name, 'index.ts')
  if (!fs.existsSync(entry)) {
    throw new Error(`unknown distribution "${name}" — have: ${listDistributions().join(', ') || '(none)'}`)
  }
  return entry
}

/** The `@builtin/<id>` specifiers this distribution's entry imports. */
export function inBundleBuiltinIds(name = DEFAULT_DISTRIBUTION) {
  const src = fs.readFileSync(distributionEntry(name), 'utf-8')
  const ids = new Set()
  for (const m of src.matchAll(/from\s+['"]@builtin\/([\w.-]+)['"]/g)) {
    ids.add(m[1])
  }
  return ids
}
