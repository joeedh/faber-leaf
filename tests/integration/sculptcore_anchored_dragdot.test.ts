/**
 * Regression test for the Anchored / Drag Dot stroke methods
 * (`addons/builtin/litemesh/src/stroke_driver.ts`, `StrokeMethod.ANCHORED` /
 * `.DRAG_DOT`). Both methods keep re-applying a live-preview dab as the
 * pointer moves, rolling back the previous preview before the next lands
 * (`beginPreviewDab`/`rollbackPreviewDab`, `sculptcore_ops.ts` `applyDabOne`) so
 * only the *current* live state is ever visible — never the sum of every
 * intermediate dab. This test proves that: a stroke that wanders through
 * several intermediate positions before settling on a final one must leave the
 * mesh in the *same* state as a stroke that goes straight to that final
 * position — if rollback were broken, the wandering stroke would compound and
 * end up measurably more displaced.
 *
 * Uses `window._sculptcoreStrokeTester` (the real `SculptPaintOp` +
 * `BrushStrokeDriver` op path) via `--eval`, same harness as
 * `sculptcore_stroke_tester.test.ts`. Grab (`SculptTools.GRAB` = 9) exercises
 * Anchored (its default `strokeMethod`, radius-live mode, straight vertex
 * translation by `ps.anchorVec` — a very direct compounding signal); Clay
 * (`SculptTools.CLAY` = 0) with an explicit `strokeMethod: DRAG_DOT` (=2)
 * exercises Drag Dot the same way.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app
 * bundle (`pnpm build`). The native leg additionally needs the N-API addon
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

/** One stroke's before/after/after-undo vertex-position checksums (sum of
 * squared position magnitudes across every live vert). */
interface StrokeSample {
  before: number
  after: number
  undone: number
}

interface AnchoredDragDotResult {
  ok: boolean
  error?: string
  anchoredDirect?: StrokeSample
  anchoredWander?: StrokeSample
  dragDotDirect?: StrokeSample
  dragDotWander?: StrokeSample
}

// GRAB: anchor at center, drag straight to one final offset point vs. via
// three unrelated intermediate points before landing on that SAME point --
// both must leave the mesh identically displaced.
const ANCHOR_DIRECT = [
  [0.5, 0.5],
  [0.62, 0.42],
]
const ANCHOR_WANDER = [
  [0.5, 0.5],
  [0.58, 0.3],
  [0.3, 0.6],
  [0.66, 0.34],
  [0.62, 0.42],
]

// Drag Dot: a stamp positioned straight at its final point vs. dragged there
// through unrelated intermediate positions -- same requirement.
const DOT_DIRECT = [
  [0.5, 0.5],
  [0.6, 0.45],
]
const DOT_WANDER = [
  [0.5, 0.5],
  [0.42, 0.62],
  [0.66, 0.34],
  [0.55, 0.58],
  [0.6, 0.45],
]

const DRIVER = `(function () {
  var r = {ok: false}
  try {
    var ctx = _appstate.ctx
    ctx.scene.switchToolMode('sculptcore')
    var t = window._sculptcoreStrokeTester
    var mesh = t.mesh
    if (!mesh) throw new Error('active object is not a LiteMesh')
    t.frameMeshInCamera()

    // Sum of squared vertex-position magnitudes across every live vert --
    // unlike a bounding-box diagonal, this is sensitive to a LOCAL interior
    // deformation (a dab near the center of a cube face never moves the
    // corner verts that define the bbox extents, so a bbox-based metric
    // reads ~0 even when the mesh genuinely deformed).
    var checksum = function () {
      var co = mesh.dumpVertCo().co
      var sum = 0
      for (var i = 0; i < co.length; i++) {
        var c = co[i]
        sum += c[0] * c[0] + c[1] * c[1] + c[2] * c[2]
      }
      return sum
    }

    var runOne = function (points, opts) {
      var before = checksum()
      t.runStroke(Object.assign({points: points, radius: 100}, opts))
      var after = checksum()
      t.undo()
      var undone = checksum()
      return {before: before, after: after, undone: undone}
    }

    r.anchoredDirect = runOne(${JSON.stringify(ANCHOR_DIRECT)}, {sculptTool: 9})
    r.anchoredWander = runOne(${JSON.stringify(ANCHOR_WANDER)}, {sculptTool: 9})

    var dotOpts = {sculptTool: 0, brushSettings: {strokeMethod: 2, strength: 1.0}}
    r.dragDotDirect = runOne(${JSON.stringify(DOT_DIRECT)}, dotOpts)
    r.dragDotWander = runOne(${JSON.stringify(DOT_WANDER)}, dotOpts)

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
function runAnchoredDragDot(nwExe: string, backend: 'wasm' | 'native'): AnchoredDragDotResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scanchor-')), `${backend}.json`)
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
    {cwd: REPO_ROOT, env: {...process.env}, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: AnchoredDragDotResult}
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
  console.warn(`[sculptcore-anchored-dragdot] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-anchored-dragdot] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('Anchored / Drag Dot no-compounding (%s)', (backend) => {
  let r: AnchoredDragDotResult

  beforeAll(() => {
    r = runAnchoredDragDot(nwExe!, backend)
  }, 180000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-anchored-dragdot] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
  })

  test('Anchored (Grab) direct drag measurably displaces the mesh', () => {
    const s = r.anchoredDirect!
    expect(Math.abs(s.after - s.before)).toBeGreaterThan(1e-4)
  })

  test('Anchored (Grab): wandering to the same final point matches the direct drag', () => {
    const direct = r.anchoredDirect!
    const wander = r.anchoredWander!
    const directDelta = Math.abs(direct.after - direct.before)
    // If preview rollback were broken, the four extra intermediate dabs (each
    // pointing a different direction) would compound instead of cancelling,
    // making the wander stroke's final displacement much larger than direct's.
    expect(Math.abs(wander.after - direct.after)).toBeLessThan(directDelta * 0.1)
  })

  test('Anchored (Grab): undo restores bounds for both paths', () => {
    expect(Math.abs(r.anchoredDirect!.undone - r.anchoredDirect!.before)).toBeLessThan(1e-4)
    expect(Math.abs(r.anchoredWander!.undone - r.anchoredWander!.before)).toBeLessThan(1e-4)
  })

  test('Drag Dot (Clay) direct stamp measurably displaces the mesh', () => {
    const s = r.dragDotDirect!
    expect(Math.abs(s.after - s.before)).toBeGreaterThan(1e-4)
  })

  test('Drag Dot (Clay): wandering to the same final point matches the direct stamp', () => {
    const direct = r.dragDotDirect!
    const wander = r.dragDotWander!
    const directDelta = Math.abs(direct.after - direct.before)
    expect(Math.abs(wander.after - direct.after)).toBeLessThan(directDelta * 0.1)
  })

  test('Drag Dot (Clay): undo restores bounds for both paths', () => {
    expect(Math.abs(r.dragDotDirect!.undone - r.dragDotDirect!.before)).toBeLessThan(1e-4)
    expect(Math.abs(r.dragDotWander!.undone - r.dragDotWander!.before)).toBeLessThan(1e-4)
  })
})
