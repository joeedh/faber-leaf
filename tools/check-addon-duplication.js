/**
 * Build-time duplication guard. Mechanically enforces the "no code
 * duplication" rule for addons that have been flipped to *external* (loaded as
 * their own `build/addons/<id>/` bundle and dynamic-imported at runtime).
 *
 * An external addon must NOT have any of its `addons/builtin/<id>/**` source
 * modules also compiled into the MAIN bundle — otherwise the code ships twice
 * (once in the main bundle, once in the addon bundle). We detect that by
 * diffing the two esbuild metafiles: if any input under an external addon's
 * source dir appears in BOTH the addon bundle's inputs and the main bundle's
 * inputs, that's a violation.
 *
 * In-bundle builtins (mesh, subsurf, curve, mesh_edit, sculptcore) are
 * intentionally compiled into the main bundle and are NOT in `EXTERNAL_IDS`,
 * so the guard never fires on them.
 *
 * Usage (from build-addons.js, after both builds have run):
 *   import {checkAddonDuplication, EXTERNAL_IDS} from './check-addon-duplication.js'
 *   const violations = checkAddonDuplication({mainMeta, addonMeta, externalIds: EXTERNAL_IDS})
 *   if (violations.length) process.exit(1)
 */

import fs from 'fs'

/**
 * Addons that are loaded as their own bundle (NOT compiled into the main
 * bundle). Add an id here only after its main-bundle static importers have
 * been severed (relative cross-addon imports converted to `@addon/<id>/api`).
 *
 * Phase 0/1: empty (no-op gate). Phase 2: ['tetmesh']. Faber Leaf P11 adds
 * 'leafmesh', which is external from birth — it has no host imports, so nothing
 * ever forced it in-bundle.
 *
 * @type {string[]}
 */
export const EXTERNAL_IDS = ['tetmesh', 'leafmesh']

/**
 * Builtin addons compiled INTO the main bundle (registered via
 * addons/builtin/builtin_registry.ts). build-addons.js skips these — they ship
 * in the main bundle and must not be separately compiled (the user's "builtins
 * wouldn't have to be compiled" rule). To extract one, remove it here, remove
 * its registerBuiltin() call from builtin_registry.ts, and add it to
 * EXTERNAL_IDS above.
 *
 * @type {Set<string>}
 */
export const IN_BUNDLE_BUILTIN_IDS = new Set(['mesh', 'subsurf', 'mesh_edit', 'curve', 'sculptcore'])

/** Normalize a metafile input key to forward slashes, repo-relative-ish. */
function normalize(p) {
  return p.replace(/\\/g, '/')
}

/**
 * @param {object} opts
 * @param {import('esbuild').Metafile} opts.mainMeta   metafile of the main bundle
 * @param {import('esbuild').Metafile} opts.addonMeta  metafile of the per-addon build
 * @param {string[]} opts.externalIds                  addon ids that must be external-only
 * @returns {{id: string, module: string}[]}           violations (empty = clean)
 */
export function checkAddonDuplication({mainMeta, addonMeta, externalIds = EXTERNAL_IDS}) {
  if (!mainMeta || !addonMeta || externalIds.length === 0) return []

  const mainInputs = new Set(Object.keys(mainMeta.inputs).map(normalize))
  const addonInputs = Object.keys(addonMeta.inputs).map(normalize)

  const violations = []
  for (const id of externalIds) {
    const dir = `addons/builtin/${id}/`
    for (const inp of addonInputs) {
      if (inp.includes(dir) && mainInputs.has(inp)) {
        violations.push({id, module: inp})
      }
    }
  }
  return violations
}

/** Reads two metafile JSON files from disk; returns null for a missing one. */
export function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Convenience: reads both metafiles from disk, runs the check, prints +
 * returns violations. Caller decides whether to exit.
 */
export function checkFromFiles(mainMetaPath, addonMetaPath, externalIds = EXTERNAL_IDS) {
  if (externalIds.length === 0) return []
  const mainMeta = readMeta(mainMetaPath)
  const addonMeta = readMeta(addonMetaPath)
  if (!mainMeta) {
    console.warn(`addon-duplication guard: main metafile missing at ${mainMetaPath}; skipping`)
    return []
  }
  if (!addonMeta) {
    console.warn(`addon-duplication guard: addon metafile missing at ${addonMetaPath}; skipping`)
    return []
  }
  const violations = checkAddonDuplication({mainMeta, addonMeta, externalIds})
  if (violations.length) {
    console.error('\n✗ addon-duplication guard FAILED — external addon source also in main bundle:')
    for (const v of violations) {
      console.error(`    [${v.id}] ${v.module}`)
    }
    console.error(
      '\nAn external addon must not have its source compiled into the main bundle.\n' +
        'Convert the offending main-bundle imports to `@addon/<id>/api` runtime lookups,\n' +
        'or remove the addon from EXTERNAL_IDS in tools/check-addon-duplication.js.\n'
    )
  } else {
    console.log(`addon-duplication guard: OK (${externalIds.length} external addon(s) checked)`)
  }
  return violations
}
