/**
 * Headless GPU-brush parity driver (plans/gpuGlobalBrushes.md §8.2–8.4),
 * registered as `globalThis.__gpuBrushTest()` for the NW.js/browser harness
 * (`--eval "return __gpuBrushTest(...)"`, see documentation/debugStrokeGuide.md).
 *
 * Runs the SAME deterministic kelvinlet stroke twice through the real
 * SculptPaintOp (via `window._sculptcoreStrokeTester`): once with
 * `sculptcore.gpu_brush` off (the CPU reference) and once on (the GPU
 * dispatcher), undoing between runs, and reports position-buffer fingerprints
 * plus undo/redo fidelity for both passes. Macrotask-free except for the GPU
 * stroke's own mapAsync completions (awaited via __gpuBrushCompletion — a
 * microtask chain, no screen-tick).
 */

import {FeatureFlags, peekAppState} from '@framework/api'
import {getActiveWebGpuContext} from '../../../../scripts/render/queue_factory'
import {ensureGpuBrushDebug} from './sculptcore_gpu_stroke'
import {LiteMesh} from './litemesh'
import {readGpuBuffer} from './litemesh_brushtest_support'
import {SculptTools} from '../../../../scripts/brush/brush_enums'
import {runSculptcoreStroke} from './sculptcore_ops'
import type {SculptBrush} from '../../../../scripts/brush/brush'

interface Fingerprint {
  n: number
  sum: number
  sqsum: number
  min: number
  max: number
  finite: boolean
}

function fingerprint(data: Float32Array | undefined): Fingerprint | undefined {
  if (!data) {
    return undefined
  }
  let sum = 0
  let sqsum = 0
  let min = Infinity
  let max = -Infinity
  let finite = true
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (!Number.isFinite(v)) {
      finite = false
      continue
    }
    sum += v
    sqsum += v * v
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  return {n: data.length, sum, sqsum, min, max, finite}
}

function maxAbsDiff(a: Float32Array | undefined, b: Float32Array | undefined): number {
  if (!a || !b || a.length !== b.length) {
    return Infinity
  }
  let m = 0
  for (let i = 0; i < a.length; i++) {
    m = Math.max(m, Math.abs(a[i] - b[i]))
  }
  return m
}

export interface GpuBrushTestResult {
  backend: string
  skipped?: string
  error?: string
  /** max |Δ| between the CPU and GPU passes' position buffers. */
  parityMaxDiff?: number
  /** The CPU pass actually moved geometry (a no-op stroke proves nothing). */
  cpuMoved?: boolean
  cpu?: Fingerprint
  gpu?: Fingerprint
  /** GPU pass undo restored the pre-stroke buffer exactly. */
  undoMaxDiff?: number
  /** GPU pass redo reapplied the stroke exactly. */
  redoMaxDiff?: number
  /** Shadow-verify divergence count (0 = clean) when runShadow was set. */
  shadowDivergences?: number
  stats?: object
  /** [before, cpu, gpu, undo, redo] position-buffer float counts (diagnostics). */
  lens?: number[]
  /** §8.2 strict gate: max |Δ| between CPU and GPU passes of the same
   * WORLD-SPACE dab sequence (runSculptcoreStroke — no per-dab raycast, so
   * both paths marshal identical inputs and must agree within fp tolerance;
   * the screen-space parityMaxDiff above includes legitimate raycast-
   * staleness drift, plan D4). */
  worldParityMaxDiff?: number
  worldMoved?: boolean
  worldUndoMaxDiff?: number
  /** The captured replay fixture (opts.capture). */
  fixture?: object
  /** M3: the GPU pass rendered via the scatter path (no per-dab readback). */
  gpuResident?: boolean
  scatterDispatches?: number
  /** §9.6 scatter-map self-check, run at the world-space GPU stroke's finish. */
  selfCheck?: object
  /** M4: the same strict world-space gates for GRAB (§8.2-8.4). */
  grabWorldParityMaxDiff?: number
  grabWorldMoved?: boolean
  grabWorldUndoMaxDiff?: number
  /** M4: grab shadow-verify divergences (screen-space stroke, §9.3). */
  grabShadowDivergences?: number
}

interface TestOpts {
  /** Capture the GPU pass as a tests/webgpu/replay.mjs fixture and include it
   * in the result (§9.2 bit-exact replay gate). */
  capture?: boolean
  /** {X:1,Y:2,Z:4} symmetry bitflag (§8.4). */
  symmetryAxes?: number
  /** Also run a third, shadow-verify pass and report divergences (§9.3). */
  runShadow?: boolean
  points?: number[][]
  radius?: number
}

async function gpuBrushTest(opts: TestOpts = {}): Promise<GpuBrushTestResult> {
  const g = globalThis as unknown as {
    _sculptcoreStrokeTester?: {
      frameMeshInCamera(): void
      runStroke(o: object): {redrawPromise: Promise<unknown>}
      undo(): void
      redo(): void
    }
    __gpuBrushCompletion?: Promise<void>
    DEBUG?: {
      gpuBrush?: {
        allowNonModal: boolean
        shadowDivergences: number
        lastStats?: object
        lastFixture?: object
      }
    }
  }
  const backend = (globalThis as unknown as {__SCULPTCORE_BACKEND?: string}).__SCULPTCORE_BACKEND ?? 'wasm'

  const mesh = peekAppState()?.ctx?.object?.data
  if (!(mesh instanceof LiteMesh)) {
    return {backend, error: 'active object is not a LiteMesh'}
  }
  const tester = g._sculptcoreStrokeTester
  if (!tester) {
    return {backend, error: 'no _sculptcoreStrokeTester'}
  }
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return {backend, skipped: 'no WebGPU'}
  }
  // The renderer's device init is async and the harness --eval fires right
  // after scene build — without this wait the GPU path silently falls back to
  // CPU and every parity gate passes vacuously (CPU vs CPU).
  const deadline = performance.now() + 15000
  while (!getActiveWebGpuContext()?.device) {
    if (performance.now() > deadline) {
      return {backend, skipped: 'WebGPU device never initialized'}
    }
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  }

  const points = opts.points ?? [
    [0.5, 0.5],
    [0.54, 0.48],
    [0.58, 0.46],
    [0.62, 0.44],
  ]
  const strokeOpts = {
    points,
    radius       : opts.radius ?? 60,
    sculptTool   : SculptTools.KELVINLET,
    symmetryAxes : opts.symmetryAxes ?? 0,
    brushSettings: {strength: 0.6},
  }

  tester.frameMeshInCamera()

  const flagWas = FeatureFlags.get('sculptcore.gpu_brush')
  const grabWas = FeatureFlags.get('sculptcore.gpu_brush_grab')
  const verifyWas = FeatureFlags.get('sculptcore.gpu_brush_verify')
  FeatureFlags.set('sculptcore.gpu_brush_grab', true)
  try {
    // --- CPU reference pass -------------------------------------------------
    FeatureFlags.set('sculptcore.gpu_brush', false)
    FeatureFlags.set('sculptcore.gpu_brush_verify', false)
    await tester.runStroke(strokeOpts).redrawPromise
    const cpuCo = readGpuBuffer(mesh, 'position')
    tester.undo()
    await (window as Window).redraw_viewport_p(true)
    // Pre-stroke baseline, captured AFTER the first stroke+undo: the first
    // regenTreeBatch drops the leaf-bounds overlay's 'position' buffer, so a
    // pre-any-stroke capture has a different buffer set and can't be diffed.
    const before = readGpuBuffer(mesh, 'position')

    // --- GPU pass ------------------------------------------------------------
    FeatureFlags.set('sculptcore.gpu_brush', true)
    // The tester runs the op non-modally; opt the GPU path in for it.
    const dbgSurface = ensureGpuBrushDebug()
    dbgSurface.allowNonModal = true
    if (opts.capture) {
      dbgSurface.capture(1)
    }
    await tester.runStroke(strokeOpts).redrawPromise
    // Wait for the async finalization (final readback + endStep).
    await g.__gpuBrushCompletion
    const gpuCo = readGpuBuffer(mesh, 'position')

    // --- undo/redo fidelity on the GPU stroke (§8.3) -------------------------
    tester.undo()
    await (window as Window).redraw_viewport_p(true)
    const undoCo = readGpuBuffer(mesh, 'position')
    tester.redo()
    await (window as Window).redraw_viewport_p(true)
    const redoCo = readGpuBuffer(mesh, 'position')

    const result: GpuBrushTestResult = {
      backend,
      parityMaxDiff: maxAbsDiff(cpuCo, gpuCo),
      cpuMoved     : maxAbsDiff(before, cpuCo) > 1e-6,
      cpu          : fingerprint(cpuCo),
      gpu          : fingerprint(gpuCo),
      undoMaxDiff  : maxAbsDiff(before, undoCo),
      redoMaxDiff  : maxAbsDiff(gpuCo, redoCo),
      stats        : g.DEBUG?.gpuBrush?.lastStats,
      fixture      : opts.capture ? g.DEBUG?.gpuBrush?.lastFixture : undefined,
      lens: [
        before?.length ?? -1,
        cpuCo?.length ?? -1,
        gpuCo?.length ?? -1,
        undoCo?.length ?? -1,
        redoCo?.length ?? -1,
      ],
    }

    // --- optional shadow-verify pass (§9.3) ----------------------------------
    if (opts.runShadow) {
      tester.undo()
      await (window as Window).redraw_viewport_p(true)
      const divBefore = g.DEBUG?.gpuBrush?.shadowDivergences ?? 0
      FeatureFlags.set('sculptcore.gpu_brush', false)
      FeatureFlags.set('sculptcore.gpu_brush_verify', true)
      await tester.runStroke(strokeOpts).redrawPromise
      await g.__gpuBrushCompletion
      result.shadowDivergences = (g.DEBUG?.gpuBrush?.shadowDivergences ?? 0) - divBefore
      tester.undo()
      await (window as Window).redraw_viewport_p(true)
    }

    // --- deterministic world-space passes (§8.2 strict gate), per tool --------
    for (const tool of [SculptTools.KELVINLET, SculptTools.GRAB]) {
      const tester2 = tester as unknown as {
        getBrush(o: object): SculptBrush
        meshLog?: {undo(m: unknown, t: unknown): void}
      }
      const brush = tester2.getBrush({
        sculptTool   : tool,
        brushSettings: {strength: 0.6},
      })
      const dabs = [
        {p: [0, 0, 3], normal: [0, 0, 1]},
        {p: [0, 0.2, 3], normal: [0, 0, 1]},
        {p: [0, 0.4, 3], normal: [0, 0, 1]},
        {p: [0, 0.6, 3], normal: [0, 0, 1]},
      ]
      const radius = 0.8
      const meshLog = tester2.meshLog!
      const baseline2 = readGpuBuffer(mesh, 'position')

      FeatureFlags.set('sculptcore.gpu_brush', false)
      FeatureFlags.set('sculptcore.gpu_brush_verify', false)
      runSculptcoreStroke({mesh, brush, dabs, radius, symmetryAxes: 1})
      const cpu2 = readGpuBuffer(mesh, 'position')
      meshLog.undo(mesh.mesh, mesh.spatial)

      FeatureFlags.set('sculptcore.gpu_brush', true)
      if (tool === SculptTools.KELVINLET) {
        ensureGpuBrushDebug().selfCheckNext = true
      }
      const run = runSculptcoreStroke({mesh, brush, dabs, radius, symmetryAxes: 1})
      await run.completion
      const gpu2 = readGpuBuffer(mesh, 'position')
      meshLog.undo(mesh.mesh, mesh.spatial)
      const undone2 = readGpuBuffer(mesh, 'position')

      if (tool === SculptTools.KELVINLET) {
        const dbg2 = ensureGpuBrushDebug()
        result.selfCheck = dbg2.lastSelfCheck
        const worldStats = dbg2.lastStats as unknown as {gpuResident?: boolean; scatterDispatches?: number} | undefined
        result.gpuResident = worldStats?.gpuResident
        result.scatterDispatches = worldStats?.scatterDispatches
        result.worldParityMaxDiff = maxAbsDiff(cpu2, gpu2)
        result.worldMoved = maxAbsDiff(baseline2, cpu2) > 1e-6
        result.worldUndoMaxDiff = maxAbsDiff(baseline2, undone2)
      } else {
        result.grabWorldParityMaxDiff = maxAbsDiff(cpu2, gpu2)
        result.grabWorldMoved = maxAbsDiff(baseline2, cpu2) > 1e-6
        result.grabWorldUndoMaxDiff = maxAbsDiff(baseline2, undone2)
      }
    }

    // --- M4: grab shadow-verify (screen-space, §9.3) ---------------------------
    if (opts.runShadow) {
      const divBefore = g.DEBUG?.gpuBrush?.shadowDivergences ?? 0
      FeatureFlags.set('sculptcore.gpu_brush', false)
      FeatureFlags.set('sculptcore.gpu_brush_verify', true)
      await tester.runStroke({...strokeOpts, sculptTool: SculptTools.GRAB}).redrawPromise
      await g.__gpuBrushCompletion
      result.grabShadowDivergences = (g.DEBUG?.gpuBrush?.shadowDivergences ?? 0) - divBefore
      FeatureFlags.set('sculptcore.gpu_brush_verify', false)
      tester.undo()
      await (window as Window).redraw_viewport_p(true)
    }

    return result
  } catch (e) {
    return {backend, error: String((e as Error)?.stack ?? e)}
  } finally {
    FeatureFlags.set('sculptcore.gpu_brush', flagWas as boolean)
    FeatureFlags.set('sculptcore.gpu_brush_grab', grabWas as boolean)
    FeatureFlags.set('sculptcore.gpu_brush_verify', verifyWas as boolean)
    if (g.DEBUG?.gpuBrush) {
      g.DEBUG.gpuBrush.allowNonModal = false
    }
  }
}

/** Harness entry: runs the driver and stores the result where the --dump
 * reflector picks it up (gpubrushtest key in test_harness.ts). */
async function gpuBrushTestAndStore(opts: TestOpts = {}): Promise<GpuBrushTestResult> {
  const result = await gpuBrushTest(opts)
  ;(globalThis as {__gpuBrushTestResult?: GpuBrushTestResult}).__gpuBrushTestResult = result
  return result
}

;(globalThis as {__gpuBrushTest?: typeof gpuBrushTestAndStore}).__gpuBrushTest = gpuBrushTestAndStore

export {gpuBrushTest}
