/**
 * Which builtin addons are part of *this* build, and what they contribute to it.
 *
 * A builtin addon is a workspace package (P14) and may declare its engine as an
 * `optionalDependencies` entry — the only `workspace:` field pnpm tolerates when
 * the package is absent. That declaration is the single availability predicate
 * this project uses: **an unmet optional workspace dependency means the addon is
 * not in this build.** `git submodule deinit sculptcore` removes
 * `@sculptcore/api`, so litemesh drops out of the typecheck program, out of the
 * in-bundle registry and out of the copied build assets, all from that one fact.
 *
 * Three consumers share it so they cannot disagree: gen-tsconfig-paths.mjs
 * (`exclude`), gen-builtin-registry.mjs (the static imports) and esbuilder.js
 * (entry points + externals). P16 W3b steps 2 and 3.
 */

import fs from 'fs'
import Path from 'path'
import {fileURLToPath} from 'url'

const __filename = fileURLToPath(import.meta.url)
export const REPO_ROOT = Path.resolve(Path.dirname(__filename), '..')
const BUILTIN_DIR = Path.join(REPO_ROOT, 'addons', 'builtin')

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

/** Names of `workspace:` optionalDependencies that did not install. */
function missingOptionalDeps(addonDir, pkg) {
  const optional = pkg?.optionalDependencies || {}
  const missing = []

  for (const [name, spec] of Object.entries(optional)) {
    if (!String(spec).startsWith('workspace:')) {
      continue
    }
    const local = Path.join(addonDir, 'node_modules', name)
    const hoisted = Path.join(REPO_ROOT, 'node_modules', name)
    if (!fs.existsSync(local) && !fs.existsSync(hoisted)) {
      missing.push(name)
    }
  }

  return missing
}

/**
 * Every `addons/builtin/<id>/manifest.json`, in directory order, annotated with
 * `available` and the `missing` dependency names that made it false.
 */
export function discoverBuiltins() {
  if (!fs.existsSync(BUILTIN_DIR)) {
    return []
  }

  const out = []
  for (const entry of fs.readdirSync(BUILTIN_DIR, {withFileTypes: true})) {
    if (!entry.isDirectory()) {
      continue
    }
    const addonDir = Path.join(BUILTIN_DIR, entry.name)
    const manifest = readJson(Path.join(addonDir, 'manifest.json'))
    if (manifest?.id !== entry.name) {
      continue
    }
    const missing = missingOptionalDeps(addonDir, readJson(Path.join(addonDir, 'package.json')))
    out.push({id: manifest.id, dir: entry.name, addonDir, manifest, available: missing.length === 0, missing})
  }

  return out
}

/**
 * The main bundle's contribution from every available builtin the distribution
 * actually ships: esbuild entry points (repo-root-relative `in` paths, verbatim
 * from `manifest.buildAssets`) and `external` patterns. An unavailable addon
 * contributes nothing, which is how a missing artifact stops being a build
 * error; an addon this distribution omits contributes nothing either, which is
 * how `faber-leaf-core` avoids copying sculptcore's WASM on a tree that has it.
 *
 * `inBundleIds` is tools/distributions.mjs's set; undefined means "no filter".
 */
export function collectBuildAssets(builtins = discoverBuiltins(), inBundleIds) {
  const entryPoints = []
  const external = []

  for (const b of builtins) {
    const assets = b.manifest.buildAssets
    if (!b.available || !assets) {
      continue
    }
    if (inBundleIds && !inBundleIds.has(b.id)) {
      continue
    }
    for (const ep of assets.entryPoints ?? []) {
      entryPoints.push({in: ep.in, out: ep.out})
    }
    external.push(...(assets.external ?? []))
  }

  return {entryPoints, external}
}

/**
 * `@builtin/<id>` -> the entry module esbuild should bundle: the addon's own
 * `main.ts`, or the unavailable-builtin stub when it is not in this build. Must
 * agree with the `paths` block tools/gen-tsconfig-paths.mjs writes, which is why
 * both derive it from discoverBuiltins().
 */
export function builtinEntryAliases(builtins = discoverBuiltins()) {
  const stub = Path.join(REPO_ROOT, 'scripts', 'addon', 'unavailable_builtin.ts')
  const alias = {}

  for (const b of builtins) {
    alias[`@builtin/${b.id}`] = b.available ? Path.join(b.addonDir, b.manifest.entry) : stub
  }

  return alias
}

/** One line per addon this build is dropping, for the build log. */
export function describeUnavailable(builtins = discoverBuiltins()) {
  return builtins.filter((b) => !b.available).map((b) => `${b.id}: not in this build (missing ${b.missing.join(', ')})`)
}
