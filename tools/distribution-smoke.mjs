/**
 * Boot the built bundle and prove the distribution it was built for is the one
 * that came up, that its startup file is on screen, and that something can
 * still be modelled and round-tripped through a .wproj.
 *
 * Static checks (typecheck, build, the addon-availability predicate) all pass
 * on a tree that boots to a blank error screen, which is why this exists as a
 * separate step rather than being folded into them.
 *
 * Usage: node tools/distribution-smoke.mjs [--distribution <name>]
 *
 * The expectations per distribution live in DISTRIBUTIONS below; the runtime
 * half is identical for both, which is the point — criterion 10 is that they
 * differ only in their manifest.
 */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'

import {REPO_ROOT, describeUnavailable, discoverBuiltins} from './builtin_addons.js'
import {resolveDistributionName} from './distributions.mjs'

/**
 * What each distribution must look like once booted. An `absent` id must not be
 * running: either the app never saw it (it ships only inside a bundle that this
 * distribution does not import) or it saw it and recorded why it was skipped.
 * `scene` is the object set the distribution's startup file lays out.
 */
const DISTRIBUTIONS = {
  'faber-leaf': {
    title   : 'FaberLeaf',
    present : ['litemesh'],
    absent  : [],
    // litemesh registers all eleven sculptcore flags; leafmesh registers none.
    flagDefs: 11,
    // The litemesh-sphere startup file: the sphere plus a light.
    scene   : ['LiteMesh', 'Light'],
  },
  'faber-leaf-core': {
    title   : 'FaberLeaf Core',
    present : ['leafmesh'],
    absent  : ['litemesh'],
    flagDefs: 0,
    // The leafmesh-cube startup file: the cube plus a light.
    scene   : ['LeafMeshData', 'Light'],
  },
}

/**
 * Runs inside the renderer. Assigning the promise to a global is what makes the
 * harness await it — `await (0, eval)(expr)` awaits the expression's value, and
 * an eval'd script cannot use top-level await itself.
 */
const EVAL = `globalThis.__distSmoke = (async () => {
  const out = {}
  try {
    const mgr = window._addons
    const ctx = _appstate.ctx

    out.distribution = mgr.distribution?.id ?? null
    out.title = document.title
    out.known = mgr.addons.map((a) => a.manifest?.id).filter(Boolean).sort()
    out.enabled = mgr.addons.filter((a) => a.enabled).map((a) => a.manifest.id).sort()
    out.unloaded = [...(mgr.unloaded ?? [])].map(([k, v]) => k + ':' + (v && v.reason))
    // Flags are addon-owned (P16 step 5); a distribution without the owning
    // addon lists no knobs rather than knobs that control nothing.
    out.flagDefs = window.FeatureFlags.definitions.length

    // Object name + data class for every scene object, plus a geometry hash for
    // the ones exposing a LeafMesh-shaped .mesh. Works for either distribution:
    // a LiteMesh sphere compares by identity (its geometry lives in the engine,
    // behind a different attribute API), a LeafMesh cube by its vertices.
    const isLeafShaped = (m) => !!m && !!m.v && typeof m.v[Symbol.iterator] === 'function' && !!m.v.co
    const fingerprint = () => [..._appstate.ctx.scene.objects]
      .map((o) => {
        const row = {name: o.name, type: o.data ? o.data.constructor.name : null}
        const m = o.data && o.data.mesh
        if (isLeafShaped(m)) {
          let h = 0x811c9dc5
          for (const v of m.v) {
            for (let k = 0; k < 3; k++) {
              h = ((h ^ (Math.round(m.v.co[v * 3 + k] * 4096) | 0)) * 16777619) >>> 0
            }
          }
          row.verts = m.v.array.count
          row.edges = m.e.array.count
          row.faces = m.f.array.count
          row.hash = h
        }
        return row
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1))

    // The startup file the distribution selected by name, already built.
    out.startupScene = fingerprint()
    out.startupTypes = out.startupScene.map((o) => o.type)

    const ns = mgr.getAddonAPI('leafmesh')?.exports?.leafmesh
    out.hasLeafMesh = !!ns
    if (ns) {
      // Cube + tube, modelled by the real ToolOps with undo/redo checked at
      // every step. This is the "model something" half of the smoke test.
      const report = ns.runLeafMeshHeadlessDemo(ctx)
      out.demo = {
        ok    : report.ok,
        error : report.error ?? null,
        shapes: report.shapes.map((s) => ({
          name              : s.name,
          steps             : s.steps.length,
          undoRestoresBase  : s.undoRestoresBase,
          replayMatchesFinal: s.replayMatchesFinal,
        })),
      }
    }

    out.before = fingerprint()
    const buf = _appstate.createFile({save_screen: false, save_settings: false, save_library: true})
    out.blobBytes = buf.byteLength
    _appstate.loadFile(buf, {reset_toolstack: true, load_screen: false, load_settings: false})
    out.after = fingerprint()
    out.roundTrip = JSON.stringify(out.before) === JSON.stringify(out.after)
  } catch (e) {
    out.fatal = String(e && e.stack ? e.stack : e)
  }
  globalThis.__evalTestResult = out
  return out
})()`

const name = resolveDistributionName(process.argv)
const want = DISTRIBUTIONS[name]
if (!want) {
  console.error(`distribution-smoke: no expectations for "${name}" — have: ${Object.keys(DISTRIBUTIONS).join(', ')}`)
  process.exit(2)
}

console.log(`distribution-smoke: expecting "${name}"`)
const absent = describeUnavailable(discoverBuiltins())
console.log(`distribution-smoke: ${absent.length ? absent.join('; ') : 'every builtin is available'}`)

const nwExe = execFileSync(
  'node',
  ['-e', "require('nw').findpath().then(p=>process.stdout.write(p),()=>process.exit(1))"],
  {cwd: REPO_ROOT, encoding: 'utf-8'}
).trim()

const profile = fs.mkdtempSync(Path.join(os.tmpdir(), 'dist-prof-'))
const storage = fs.mkdtempSync(Path.join(os.tmpdir(), 'dist-store-'))
const dump = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'dist-dump-')), 'dump.json')

try {
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      `--user-data-dir=${profile}`,
      '--apptest-headless',
      '--no-devtools',
      '--app-storage-dir',
      storage,
      `--eval=${EVAL}`,
      '--dump',
      dump,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 300000}
  )
} catch (e) {
  console.error(`distribution-smoke: launcher exited ${e.status}`)
  console.error(String(e.stderr ?? '').slice(-2000))
} finally {
  fs.rmSync(profile, {recursive: true, force: true})
  fs.rmSync(storage, {recursive: true, force: true})
}

if (!fs.existsSync(dump)) {
  console.error('distribution-smoke: FAIL — no --dump written; the app did not reach the harness')
  process.exit(1)
}

const r = JSON.parse(fs.readFileSync(dump, 'utf-8')).evalResult
console.log(JSON.stringify(r, undefined, 2))

const problems = []
const check = (cond, msg) => {
  if (!cond) {
    problems.push(msg)
  }
}

check(r, 'the eval produced no result')
if (r) {
  check(!r.fatal, `eval threw: ${r.fatal}`)
  check(r.distribution === name, `booted distribution "${r.distribution}", wanted "${name}"`)
  check(r.title === want.title, `document.title is "${r.title}", wanted "${want.title}"`)
  for (const id of want.present) {
    check(r.enabled?.includes(id), `"${id}" should be enabled; enabled = ${JSON.stringify(r.enabled)}`)
  }
  for (const id of want.absent) {
    check(!r.enabled?.includes(id), `"${id}" is enabled but this distribution omits it`)
    check(
      !r.known?.includes(id) || r.unloaded?.some((u) => u.startsWith(`${id}:`)),
      `"${id}" is a live source in a distribution that omits it`
    )
  }
  check(r.flagDefs === want.flagDefs, `expected ${want.flagDefs} feature-flag definitions, got ${r.flagDefs}`)
  check(
    JSON.stringify([...(r.startupTypes ?? [])].sort()) === JSON.stringify([...want.scene].sort()),
    `the startup file holds ${JSON.stringify(r.startupTypes)}, wanted ${JSON.stringify(want.scene)}`
  )
  if (r.hasLeafMesh) {
    check(r.demo?.ok, `the leafmesh modelling demo failed: ${r.demo?.error ?? 'no report'}`)
    check(r.demo?.shapes?.length === 2, `expected 2 demo shapes, got ${r.demo?.shapes?.length}`)
  }
  check(r.blobBytes > 0, 'createFile produced an empty blob')
  check(r.roundTrip, 'the save/load round-trip changed the geometry')
}

if (problems.length) {
  console.error(`\ndistribution-smoke: FAIL (${name})\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}
// leafmesh is only enabled where a distribution asks for it, so say what ran.
const modelled = r.hasLeafMesh ? 'modelled, ' : ''
console.log(`\ndistribution-smoke: OK — "${name}" booted, ${modelled}saved and reloaded`)
