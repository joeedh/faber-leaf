/**
 * The `--no-sculptcore` lane's runtime half: boot the real app in a build where
 * the sculptcore submodule is absent, and prove something can still be modelled
 * and round-tripped through a .wproj.
 *
 * Static checks (typecheck, build, the addon-availability predicate) all pass
 * on a tree that boots to a blank error screen, which is why this exists as a
 * separate step rather than being folded into them.
 *
 * Usage: node tools/no-sculptcore-smoke.mjs [--allow-sculptcore]
 *
 * Refuses to run when litemesh IS available, because then it would be testing
 * the ordinary configuration and reporting green for the wrong reason. Pass
 * `--allow-sculptcore` to run it anyway (useful when developing the script).
 */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'

import {REPO_ROOT, describeUnavailable, discoverBuiltins} from './builtin_addons.js'

/**
 * Runs inside the renderer. Assigning the promise to a global is what makes the
 * harness await it — `await (0, eval)(expr)` awaits the expression's value, and
 * an eval'd script cannot use top-level await itself.
 */
const EVAL = `globalThis.__noScSmoke = (async () => {
  const out = {}
  try {
    const mgr = window._addons
    const ctx = _appstate.ctx

    out.unloaded = [...(mgr.unloaded ?? [])].map(([k, v]) => k + ':' + (v && v.reason))
    // Flags are addon-owned (P16 step 5); with no addon registering any, the
    // Settings tab is empty rather than listing knobs that control nothing.
    out.flagDefs = window.FeatureFlags.definitions.length

    // leafmesh is default-off, so the lane has to turn it on — which is also
    // the check that an out-of-bundle addon loads with no engine present.
    const res = mgr.enable('leafmesh')
    out.enable = res && res.ok
    if (!res || !res.ok) { out.enableDetail = JSON.stringify(res); return finish(out) }

    const ns = mgr.getAddonAPI('leafmesh')?.exports?.leafmesh
    out.hasNamespace = !!ns
    if (!ns) { return finish(out) }

    // Cube + tube, modelled by the real ToolOps with undo/redo checked at every
    // step. This is the "model something" half of the smoke test.
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

    const fingerprint = () => [..._appstate.ctx.scene.objects]
      .filter((o) => o.data && o.data.mesh && o.data.mesh.v)
      .map((o) => {
        const m = o.data.mesh
        let h = 0x811c9dc5
        for (const v of m.v) {
          for (let k = 0; k < 3; k++) {
            h = ((h ^ (Math.round(m.v.co[v * 3 + k] * 4096) | 0)) * 16777619) >>> 0
          }
        }
        return {name: o.name, verts: m.v.array.count, edges: m.e.array.count, faces: m.f.array.count, hash: h}
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1))

    out.before = fingerprint()
    const buf = _appstate.createFile({save_screen: false, save_settings: false, save_library: true})
    out.blobBytes = buf.byteLength
    _appstate.loadFile(buf, {reset_toolstack: true, load_screen: false, load_settings: false})
    out.after = fingerprint()
    out.roundTrip = JSON.stringify(out.before) === JSON.stringify(out.after)
  } catch (e) {
    out.fatal = String(e && e.stack ? e.stack : e)
  }
  return finish(out)

  function finish(o) {
    globalThis.__evalTestResult = o
    return o
  }
})()`

const allow = process.argv.includes('--allow-sculptcore')
const builtins = discoverBuiltins()

if (builtins.find((b) => b.id === 'litemesh')?.available && !allow) {
  console.error('no-sculptcore-smoke: litemesh IS in this build — nothing to test.')
  console.error('  Deinit the sculptcore submodule first, or pass --allow-sculptcore.')
  process.exit(2)
}
const absent = describeUnavailable(builtins)
console.log(`no-sculptcore-smoke: ${absent.length ? absent.join('; ') : 'every builtin is available'}`)

const nwExe = execFileSync(
  'node',
  ['-e', "require('nw').findpath().then(p=>process.stdout.write(p),()=>process.exit(1))"],
  {cwd: REPO_ROOT, encoding: 'utf-8'}
).trim()

const profile = fs.mkdtempSync(Path.join(os.tmpdir(), 'nosc-prof-'))
const storage = fs.mkdtempSync(Path.join(os.tmpdir(), 'nosc-store-'))
const dump = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'nosc-dump-')), 'dump.json')

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
  console.error(`no-sculptcore-smoke: launcher exited ${e.status}`)
  console.error(String(e.stderr ?? '').slice(-2000))
} finally {
  fs.rmSync(profile, {recursive: true, force: true})
  fs.rmSync(storage, {recursive: true, force: true})
}

if (!fs.existsSync(dump)) {
  console.error('no-sculptcore-smoke: FAIL — no --dump written; the app did not reach the harness')
  process.exit(1)
}

const r = JSON.parse(fs.readFileSync(dump, 'utf-8')).evalResult
console.log(JSON.stringify(r, undefined, 2))

const problems = []
const want = (cond, msg) => {
  if (!cond) {
    problems.push(msg)
  }
}

want(r, 'the eval produced no result')
if (r) {
  want(!r.fatal, `eval threw: ${r.fatal}`)
  want(r.unloaded?.includes('litemesh:not-in-build') || allow, 'litemesh was not recorded as not-in-build')
  want(r.flagDefs === 0 || allow, `expected 0 feature-flag definitions, got ${r.flagDefs}`)
  want(r.enable, `enabling leafmesh failed: ${r.enableDetail ?? ''}`)
  want(r.hasNamespace, 'the leafmesh addon namespace is missing')
  want(r.demo?.ok, `the leafmesh modelling demo failed: ${r.demo?.error ?? 'no report'}`)
  want(r.demo?.shapes?.length === 2, `expected 2 demo shapes, got ${r.demo?.shapes?.length}`)
  want(r.before?.length === 2, `expected 2 meshes in the scene, got ${r.before?.length}`)
  want(r.blobBytes > 0, 'createFile produced an empty blob')
  want(r.roundTrip, 'the save/load round-trip changed the geometry')
}

if (problems.length) {
  console.error(`\nno-sculptcore-smoke: FAIL\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}
console.log('\nno-sculptcore-smoke: OK — modelled, saved and reloaded a LeafMesh with no engine present')
