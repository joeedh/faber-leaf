/**
 * Brush-behavior integration test (ImmediateTODOs: invert handling, draw-sharp
 * boundedness, mask painting, brush.color piping, accumulate-by-default flags).
 *
 * Drives the real NW.js app headlessly per backend on the spherified
 * `litemesh-cube` scene, runs `__brushTest()` (addons/builtin/litemesh/src/
 * litemesh_brushtest_support.ts) via `--eval`, and asserts the structured
 * result reflected into the `--dump` JSON as `brushtest`. The driver runs
 * scripted strokes at the sphere's axis poles via `runSculptcoreStroke` and
 * measures displacement through the GPU position/color vertex buffers — the
 * backend-agnostic bulk-data seam.
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

interface StrokeMetrics {
  maxDisp: number
  movedCount: number
  meanAlongNormal: number
  meanPerp: number
  invalid?: string
}

interface BrushTestResult {
  ok: boolean
  error?: string
  drawForward?: StrokeMetrics
  drawInverted?: StrokeMetrics
  sharp?: StrokeMetrics
  drawMasked?: StrokeMetrics
  drawMaskErased?: StrokeMetrics
  smoothInverted?: StrokeMetrics
  kelvinlet?: StrokeMetrics
  grab?: StrokeMetrics
  snakehook?: StrokeMetrics
  autosmoothOff?: StrokeMetrics
  autosmoothOn?: StrokeMetrics
  color?: {paintedCount: number; meanR: number; meanG: number; meanB: number; invalid?: string}
  colorLayerTarget?: {layerA: number; layerB: number; activeIdx: number; changedA: number; changedB: number}
  accumulateDefaults?: Record<string, boolean>
  symMirrorX?: {movedPos: number; movedNeg: number; maxDisp: number; invalid?: string}
  symOctants?: {octantsCovered: number; movedCount: number; invalid?: string}
  symPlainX?: {movedPos: number; movedNeg: number; maxDisp: number; invalid?: string}
  symmetrize?: {missBefore: number; missAfter: number}
  nonFiniteCount?: number
  radius?: number
}

/** Resolve the NW.js executable via the nwjs/ workspace package. */
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

/** Boot headlessly under `backend`, run __brushTest(), return its result. */
function runBrushTest(nwExe: string, backend: 'wasm' | 'native'): BrushTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scbrush-')), `${backend}.json`)
  const env = {...process.env}
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
      // Moderate density: enough verts under a quarter-radius dab for stable
      // displacement statistics, still fast to build per backend.
      '--scene-arg',
      'subdiv=48',
      '--eval',
      '__brushTest()',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {brushtest?: BrushTestResult}
  if (!dump.brushtest) throw new Error(`${backend} dump has no brushtest result`)
  return dump.brushtest
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
  console.warn(`[sculptcore-brushes] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-brushes] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('sculptcore brush behavior (%s)', (backend) => {
  let r: BrushTestResult

  beforeAll(() => {
    r = runBrushTest(nwExe!, backend)
  }, 180000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-brushes] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.radius).toBeGreaterThan(0)
  })

  test('smoothing/inflate/clay brushes accumulate by default', () => {
    expect(r.accumulateDefaults).toEqual({
      smooth     : true,
      bsmooth    : true,
      paintSmooth: true,
      inflate    : true,
      clay       : true,
    })
  })

  test('forward DRAW raises geometry along the dab normal', () => {
    expect(r.drawForward?.invalid).toBeUndefined()
    expect(r.drawForward!.movedCount).toBeGreaterThan(0)
    expect(r.drawForward!.meanAlongNormal).toBeGreaterThan(0)
  })

  test('inverted DRAW digs inward (invert flag respected)', () => {
    expect(r.drawInverted?.invalid).toBeUndefined()
    expect(r.drawInverted!.movedCount).toBeGreaterThan(0)
    expect(r.drawInverted!.meanAlongNormal).toBeLessThan(0)
  })

  test('draw-sharp displacement stays bounded (no explosion)', () => {
    expect(r.sharp?.invalid).toBeUndefined()
    expect(r.sharp!.movedCount).toBeGreaterThan(0)
    // Regression for the absolute-step explosion: three dabs of tangential
    // pull must stay well inside the brush radius.
    expect(r.sharp!.maxDisp).toBeLessThan(r.radius!)
  })

  test('saturated mask gates a subsequent DRAW', () => {
    expect(r.drawMasked?.invalid).toBeUndefined()
    // Inside the masked disk displacement must collapse vs the unmasked draw.
    expect(r.drawMasked!.maxDisp).toBeLessThan(r.drawForward!.maxDisp * 0.2)
  })

  test('inverted mask stroke erases mask (draw comes back)', () => {
    expect(r.drawMaskErased?.invalid).toBeUndefined()
    expect(r.drawMaskErased!.movedCount).toBeGreaterThan(0)
    expect(r.drawMaskErased!.meanAlongNormal).toBeGreaterThan(0)
    expect(r.drawMaskErased!.maxDisp).toBeGreaterThan(r.drawMasked!.maxDisp * 2)
  })

  test('smooth ignores invert and stays bounded', () => {
    expect(r.smoothInverted?.invalid).toBeUndefined()
    expect(r.smoothInverted!.maxDisp).toBeLessThan(r.radius!)
  })

  test('kelvinlet grab pulls the surface in the stroke direction, bounded', () => {
    expect(r.kelvinlet?.invalid).toBeUndefined()
    expect(r.kelvinlet!.movedCount).toBeGreaterThan(0)
    // Verts follow the +X march (grab direction); elastic field stays bounded.
    expect(r.kelvinlet!.meanAlongNormal).toBeGreaterThan(0)
    expect(r.kelvinlet!.maxDisp).toBeLessThan(r.radius! * 2)
  })

  test('grab drags the surface in the stroke direction, bounded', () => {
    expect(r.grab?.invalid).toBeUndefined()
    expect(r.grab!.movedCount).toBeGreaterThan(0)
    expect(r.grab!.meanAlongNormal).toBeGreaterThan(0)
    expect(r.grab!.maxDisp).toBeLessThan(r.radius! * 2)
  })

  test('snakehook drags + gathers in the stroke direction, bounded', () => {
    expect(r.snakehook?.invalid).toBeUndefined()
    expect(r.snakehook!.movedCount).toBeGreaterThan(0)
    expect(r.snakehook!.meanAlongNormal).toBeGreaterThan(0)
    expect(r.snakehook!.maxDisp).toBeLessThan(r.radius! * 2)
  })

  test('autosmooth flattens the DRAW bump (autosmooth command pipeline)', () => {
    expect(r.autosmoothOff?.invalid).toBeUndefined()
    expect(r.autosmoothOn?.invalid).toBeUndefined()
    expect(r.autosmoothOff!.movedCount).toBeGreaterThan(0)
    expect(r.autosmoothOn!.movedCount).toBeGreaterThan(0)
    // Both are DRAW strokes — still push outward along the dab normal.
    expect(r.autosmoothOff!.meanAlongNormal).toBeGreaterThan(0)
    expect(r.autosmoothOn!.meanAlongNormal).toBeGreaterThan(0)
    // A pure DRAW moves verts only along the dab normal, so its perpendicular
    // displacement is ~0. The chained SMOOTH command (autosmooth) moves verts
    // toward neighbor averages, introducing a clear perpendicular component —
    // the decisive proof the autosmooth command ran through the pipeline.
    expect(r.autosmoothOn!.meanPerp).toBeGreaterThan(r.autosmoothOff!.meanPerp * 4)
    expect(r.autosmoothOn!.meanPerp).toBeGreaterThan(r.radius! * 1e-3)
  })

  test('brush.color reaches the color kernel', () => {
    expect(r.color?.invalid).toBeUndefined()
    expect(r.color!.paintedCount).toBeGreaterThan(0)
    // The old kernel hardcoded red; painting (0.1, 0.9, 0.3) must leave a
    // green-dominant mean over the painted verts.
    expect(r.color!.meanG).toBeGreaterThan(r.color!.meanR)
    expect(r.color!.meanG).toBeGreaterThan(r.color!.meanB)
  })

  // Regression gate for the attr-manifest bridge: the color kernel's `color`
  // handle is `@use(color)`, so the host resolves it to whichever layer is
  // active for that category. The pre-manifest bridge hardcoded attr slot 0 at
  // layer index 0, which silently painted the FIRST color layer instead.
  test('color paint targets the ACTIVE color layer, not layer 0', () => {
    const t = r.colorLayerTarget
    expect(t).toBeDefined()
    // Two distinct layers, and the later one is the active target.
    expect(t!.layerB).not.toBe(t!.layerA)
    expect(t!.activeIdx).toBe(t!.layerB)
    // -1 would mean a layer was unreadable, which would void the comparison.
    expect(t!.changedA).toBeGreaterThanOrEqual(0)
    expect(t!.changedB).toBeGreaterThan(0)
    expect(t!.changedA).toBe(0)
  })

  test('symmetric X stroke mirrors the dab across the X plane (Part A)', () => {
    expect(r.symMirrorX?.invalid).toBeUndefined()
    // The off-center dab and its X-mirror both move verts, on both X-halves...
    expect(r.symMirrorX!.movedPos).toBeGreaterThan(0)
    expect(r.symMirrorX!.movedNeg).toBeGreaterThan(0)
    // ...in roughly balanced counts (the mesh is near-symmetric there).
    const lo = Math.min(r.symMirrorX!.movedPos, r.symMirrorX!.movedNeg)
    const hi = Math.max(r.symMirrorX!.movedPos, r.symMirrorX!.movedNeg)
    expect(lo).toBeGreaterThan(hi * 0.3)
  })

  test('symmetric X+Y+Z stroke covers all 8 octants (Part A)', () => {
    expect(r.symOctants?.invalid).toBeUndefined()
    expect(r.symOctants!.octantsCovered).toBe(8)
  })

  test('plain off-center stroke moves only its own X-half (asymmetry baseline)', () => {
    expect(r.symPlainX?.invalid).toBeUndefined()
    expect(r.symPlainX!.movedPos).toBeGreaterThan(0)
    // No symmetry → the mirror half is untouched (only stray near-plane verts).
    expect(r.symPlainX!.movedNeg * 5).toBeLessThan(r.symPlainX!.movedPos)
  })

  test('symmetrize op makes the mesh X-symmetric (Part B)', () => {
    expect(r.symmetrize).toBeDefined()
    // Metric premise: the pristine live vertex set is mirror-symmetric at the
    // quantization cell (measured exactly 0 — the metric reads dumpVertCo,
    // never the leaf VBOs, whose slack slots used to poison this gate).
    expect(r.symmetrize!.missPristine).toBeLessThan(1e-3)
    // A clean one-sided +X deform leaves the mesh clearly X-asymmetric
    // (measured 0.015)...
    expect(r.symmetrize!.missBefore).toBeGreaterThan(0.01)
    // ...and symmetrize about X restores exact mirror symmetry (measured 0).
    expect(r.symmetrize!.missAfter).toBeLessThan(1e-3)
  })

  test('no NaN/Inf in the final position buffer', () => {
    expect(r.nonFiniteCount).toBe(0)
  })
})
