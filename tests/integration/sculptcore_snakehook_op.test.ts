/**
 * Regression test for the Snake Hook brush driven through the *interactive* op
 * path (`SculptPaintOp` + `BrushStrokeDriver` via
 * `window._sculptcoreStrokeTester`), with dyntopo on as the SNAKE preset ships
 * it. Every other snakehook test in the tree goes through the low-level
 * `runSculptcoreStroke` or the C++ `test_snakehook`, so the op's own grab-family
 * branch (`sculptcore_ops.ts` `applyGrabDabState` / the filter-radius latch) had
 * no coverage at all — which is how two snakehook regressions shipped:
 *
 *  1. The `maxFilterRadius` high-water latch (a from-orig-grab guard) also
 *     applied to snakehook, whose `filterRadius` doubles as the dyntopo dab
 *     radius. Later dabs land on already-hooked geometry, which sits closer to
 *     the camera, so the screen-mode world radius *shrinks* mid-stroke while the
 *     latch pinned the region at the stroke maximum -- running COLLAPSE well
 *     outside the dab.
 *  2. Snakehook run non-accumulate compounded, because `grabTo` is a per-dab
 *     delta with no stroke-start base (fixed engine-side by `@incremental`).
 *
 * Both failure modes are geometric, so the metrics here are radial and immune to
 * dyntopo changing the vertex count: the min / max vertex distance from the mesh
 * center. A collapse pulls verts inward (min radius falls), a compounding blow-up
 * throws them outward (max radius climbs), and a healthy hook does neither by
 * more than the brush radius.
 *
 * Scope, measured rather than assumed: reinstating (1) shifts these metrics by
 * only ~0.3% here, because the headless camera sits ~7 mesh-radii out so the hook
 * barely changes the raycast depth the screen-mode radius is derived from. So this
 * suite gates (2) and gross snakehook breakage on the op path; it does NOT gate
 * the latch. Reproducing that needs a close camera where the hook is a large
 * fraction of the view distance.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app bundle
 * (`pnpm build`). The native leg additionally needs the N-API addon
 * (`make.mjs build node`); without it only the WASM leg runs.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfileArgs} from './nwjs_boot'
import {backendTable, selectedBackends} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

/** Radial vertex-distance stats about the mesh center, plus the live vert count. */
interface RadialStats {
  min: number
  max: number
  mean: number
  count: number
}

interface SnakehookResult {
  ok: boolean
  error?: string
  before?: RadialStats
  after?: RadialStats
  undone?: RadialStats
  /** Largest per-vert move over the stroke, in world units (nearest-vert match). */
  maxMove?: number
  dabs?: number
}

// A long stroke across the front face. Snakehook pulls geometry toward the
// camera as it goes, so the later dabs raycast onto hooked geometry -- that is
// what makes the per-dab screen-mode world radius shrink mid-stroke, which is
// the condition the filter-radius latch got wrong.
const HOOK_POINTS = [
  [0.38, 0.5],
  [0.43, 0.5],
  [0.48, 0.5],
  [0.53, 0.5],
  [0.58, 0.5],
  [0.63, 0.5],
]

const DRIVER = `(async function () {
  var r = {ok: false}
  try {
    var ctx = _appstate.ctx
    ctx.scene.switchToolMode('sculptcore')
    var t = window._sculptcoreStrokeTester
    var mesh = t.mesh
    if (!mesh) throw new Error('active object is not a LiteMesh')
    t.frameMeshInCamera()

    // Radial stats about the mesh center. Count-independent on purpose: dyntopo
    // adds and removes verts mid-stroke, so any index- or count-based comparison
    // is meaningless here.
    var stats = function () {
      var co = mesh.dumpVertCo().co
      var cx = 0, cy = 0, cz = 0
      for (var i = 0; i < co.length; i++) { cx += co[i][0]; cy += co[i][1]; cz += co[i][2] }
      cx /= co.length; cy /= co.length; cz /= co.length
      var min = Infinity, max = 0, sum = 0
      for (var j = 0; j < co.length; j++) {
        var dx = co[j][0] - cx, dy = co[j][1] - cy, dz = co[j][2] - cz
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < min) min = d
        if (d > max) max = d
        sum += d
      }
      return {min: min, max: max, mean: sum / co.length, count: co.length}
    }

    r.before = stats()
    var res = await t.runStroke({
      points: ${JSON.stringify(HOOK_POINTS)},
      radius: 120,
      // SculptTools.SNAKE. The enum is not a global in --eval, so inline it.
      sculptTool: 7,
      dyntopo: true,
      brushSettings: {strength: 1.0},
    })
    r.dabs = res.dabs
    r.after = stats()
    r.maxMove = r.after.max - r.before.max

    await t.undo()
    r.undone = stats()

    r.ok = true
  } catch (e) {
    r.error = String((e && e.stack) || e)
  }
  globalThis.__evalTestResult = r
})()`

function resolveNwjsExe(): string | undefined {
  try {
    const exe = execFileSync(
      'node',
      ['-e', "require('nw').findpath().then(p=>process.stdout.write(p),()=>process.exit(1))"],
      {
        cwd     : REPO_ROOT,
        encoding: 'utf-8',
      }
    ).trim()
    return exe && fs.existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}

/** Boot headlessly under `backend`, run the driver, return its result. */
function runSnakehook(nwExe: string, backend: 'wasm' | 'native'): SnakehookResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scsnake-')), `${backend}.json`)
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      '--scene-arg',
      'subdiv=48',
      '--eval',
      DRIVER,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env: {...process.env}, encoding: 'utf-8', stdio: 'pipe', timeout: 180000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: SnakehookResult}
  if (!dump.evalResult) throw new Error(`${backend} dump has no evalResult`)
  return dump.evalResult
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveNative = fs.existsSync(NATIVE_ADDON)
const backends = selectedBackends(haveNative)
const canRun = !!nwExe && haveBundle && backends.length > 0

if (!canRun) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[sculptcore-snakehook-op] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-snakehook-op] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('Snake Hook through SculptPaintOp (%s)', (backend) => {
  let r: SnakehookResult

  beforeAll(() => {
    r = runSnakehook(nwExe!, backend)
  }, 240000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-snakehook-op] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.dabs!).toBeGreaterThan(0)
  })

  test('the stroke hooks the surface outward', () => {
    expect(r.after!.max).toBeGreaterThan(r.before!.max * 1.02)
  })

  test('no vert collapses toward the mesh center', () => {
    // The regression signature the user reported ("verts appear to collapse to
    // zero"): an over-wide dyntopo COLLAPSE pulling geometry inward far outside
    // the dab. A dab can legitimately dent the surface it covers, so this only
    // requires that nothing caves in by more than a brush radius' worth.
    expect(r.after!.min).toBeGreaterThan(r.before!.min * 0.6)
  })

  test('the hook stays bounded (no compounding blow-up)', () => {
    // Non-accumulate snakehook used to compound per dab, reaching many times the
    // brush radius. Anything beyond a modest fraction of the mesh extent is that.
    expect(r.after!.max).toBeLessThan(r.before!.max * 2.0)
  })

  test('undo restores the radial extents', () => {
    expect(Math.abs(r.undone!.max - r.before!.max)).toBeLessThan(1e-3)
    expect(Math.abs(r.undone!.min - r.before!.min)).toBeLessThan(1e-3)
  })
})
