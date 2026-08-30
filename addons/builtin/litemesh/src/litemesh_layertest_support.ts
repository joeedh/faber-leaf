/**
 * Integration-test support for sculpt layers (workstream F1 of
 * documentation/plans/displacementAndSubSurf.md). Exposes
 * `globalThis.__layerTest()`, driven by the NW.js headless harness via
 * `--eval` (see `tests/integration/sculptcore_layers.test.ts`); the result is
 * reflected into the `--dump` JSON as `layertest`.
 *
 * On the spherified `litemesh-cube` scene it adds a sculpt layer
 * (`Mesh.sculptLayerAdd`), runs one scripted LAYERDRAW stroke at the +Z pole
 * with the brush program's command 0 attr handle pointed at the layer's
 * vertex attr, and measures through the GPU position buffer (the
 * backend-agnostic bulk-data seam): displacement metrics, an FNV-1a checksum
 * of the post-stroke buffer (the wasm↔native bit-parity gate), and the
 * residual after one MeshLog undo (which must restore `co` and the layer
 * atomically).
 */

import {BrushFlags, DynTopoFlagsSC, SculptTools} from '../../../../scripts/brush/brush_base'
import {DefaultBrushes} from '../../../../scripts/brush/index'
import {FeatureFlags, getAppState, peekAppState} from '@framework/api'
import {SculptBrushes} from '@sculptcore/api/sculptcore/brush/SculptBrushes'
import {runSculptcoreStroke, SculptPaintOp} from './sculptcore_ops'
import {LiteMesh} from './litemesh'
import {livePoleExtent, readGpuBuffer} from './litemesh_brushtest_support'

interface LayerTestResult {
  ok: boolean
  error?: string
  /** Brush radius used (a quarter of the sphere's pole distance). */
  radius?: number
  /** Settings index returned by sculptLayerAdd (expected 0). */
  layerIndex?: number
  /** The layer's attr index in the VERTEX AttrGroup (must be >= 0). */
  layerAttrIndex?: number
  /** sculptLayerCount() after the add (expected 1). */
  layerCount?: number
  /** Render-vertices moved > 1e-6 by the LAYERDRAW stroke. */
  movedCount?: number
  /** Largest per-render-vertex displacement of the stroke. */
  maxDisp?: number
  /** FNV-1a (32-bit) over the post-stroke position buffer bytes. */
  postChecksum?: number
  /** Float count of the post-stroke position buffer. */
  postFloatCount?: number
  /** Max |undone - preStroke| after one MeshLog undo (expected 0). */
  undoResidual?: number
  /** Non-finite floats in the post-stroke position buffer (must be 0). */
  nonFiniteCount?: number
}

/** FNV-1a 32-bit hash over the raw bytes of a Float32Array. */
function fnv1a(buf: Float32Array): number {
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  let h = 0x811c9dc5
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Largest per-vertex displacement length between two position snapshots. */
function maxResidual(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity
  let max = 0
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.hypot(b[i] - a[i], b[i + 1] - a[i + 1], b[i + 2] - a[i + 2])
    if (d > max) max = d
  }
  return max
}

function layerTest(): LayerTestResult {
  const result: LayerTestResult = {ok: false}
  const g = globalThis as unknown as {
    __layerTestResult?: LayerTestResult
  }
  try {
    const mesh = peekAppState()?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')

    const brush = DefaultBrushes.slotMap[SculptTools.DRAW]
    if (!brush) throw new Error('no default DRAW brush')

    // Recover the sphere's +Z pole distance from the live verts (not the leaf
    // VBOs — their slack slots would inflate it and push the dabs off-surface).
    const pos0 = readGpuBuffer(mesh, 'position')
    if (!pos0) throw new Error('position buffer unreadable')
    const R = livePoleExtent(mesh, 2)
    const radius = R * 0.25
    result.radius = radius

    const saved = {tool: brush.tool, strength: brush.strength, flag: brush.flag, autosmooth: brush.autosmooth}
    try {
      brush.tool = SculptTools.DRAW
      brush.autosmooth = 0
      brush.flag &= ~BrushFlags.ACCUMULATE

      // The first stroke triggers a GPU re-batch (the buffer set changes
      // length), so settle the layout with a zero-strength warmup first.
      brush.strength = 0
      runSculptcoreStroke({mesh, brush, dabs: [{p: [0, 0, R], normal: [0, 0, 1]}], radius})
      brush.strength = 1

      const li = mesh.mesh.sculptLayerAdd()
      result.layerIndex = li
      result.layerAttrIndex = mesh.mesh.sculptLayerAttrIndex(li)
      result.layerCount = mesh.mesh.sculptLayerCount()
      if (result.layerAttrIndex < 0) throw new Error('sculptLayerAttrIndex returned ' + result.layerAttrIndex)

      const before = readGpuBuffer(mesh, 'position')
      if (!before) throw new Error('pre-stroke position buffer unreadable')

      // One LAYERDRAW dab at the +Z pole, its slayer handle (manifest attrIdx
      // 0) pointed at the fresh layer's vertex attr.
      runSculptcoreStroke({
        mesh,
        brush,
        dabs: [{p: [0, 0, R], normal: [0, 0, 1]}],
        radius,
        brushTypeOverride: SculptBrushes.LAYERDRAW,
        attrLayerOverride: {attrIdx: 0, layerIndex: result.layerAttrIndex},
      })

      const after = readGpuBuffer(mesh, 'position')
      if (after?.length !== before.length) {
        throw new Error('post-stroke position buffer unreadable/resized')
      }

      let moved = 0
      let maxDisp = 0
      let bad = 0
      for (let i = 0; i < after.length; i++) {
        if (!Number.isFinite(after[i])) bad++
      }
      for (let i = 0; i < after.length; i += 3) {
        const d = Math.hypot(after[i] - before[i], after[i + 1] - before[i + 1], after[i + 2] - before[i + 2])
        if (d > 1e-6) {
          moved++
          if (d > maxDisp) maxDisp = d
        }
      }
      result.movedCount = moved
      result.maxDisp = maxDisp
      result.nonFiniteCount = bad
      result.postChecksum = fnv1a(after)
      result.postFloatCount = after.length

      // One undo of the stroke's MeshLog step (the same path SculptPaintOp.undo
      // takes) must restore the pre-stroke positions exactly — `save vertex co,
      // no, slayer` records positions and the layer atomically.
      SculptPaintOp.meshLog!.undo(mesh.mesh, mesh.spatial)
      mesh.regenBounds()
      mesh.meshRevision++
      const undone = readGpuBuffer(mesh, 'position')
      if (!undone) throw new Error('post-undo position buffer unreadable')
      result.undoResidual = maxResidual(before, undone)
    } finally {
      brush.tool = saved.tool
      brush.strength = saved.strength
      brush.flag = saved.flag
      brush.autosmooth = saved.autosmooth
    }

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__layerTestResult = result
  return result
}

;(globalThis as {__layerTest?: typeof layerTest}).__layerTest = layerTest

interface LayerToolTestResult {
  ok: boolean
  error?: string
  radius?: number
  /** Settings index of the created layer (expected 0) + its v.attrs index. */
  layerIndex?: number
  layerAttrIndex?: number
  /** Live verts moved > 1e-6 by the LAYER_DRAW stroke (dumpVertCo diff). */
  movedCount?: number
  maxDisp?: number
  /** Max displacement after Mesh_layerSetWeight(0.5) — expected ≈ maxDisp/2. */
  halfWeightMaxDisp?: number
  /** Max |co - after| once the weight is restored to 1 (fp-rounding small). */
  weightRestoreResidual?: number
  /** Max |co - before| with the layer disabled (fp-rounding small). */
  disabledResidual?: number
  /** Max |co - after| once re-enabled (fp-rounding small). */
  enabledResidual?: number
  /** Max |co - before| after one MeshLog undo (exact snapshot restore). */
  undoResidual?: number
  /** FNV-1a over the post-stroke dumpVertCo floats (cross-backend parity). */
  postChecksum?: number
  postFloatCount?: number
}

/** Flatten dumpVertCo() into Float32Array xyz triples (live-vert order). */
function dumpCoFlat(mesh: LiteMesh): Float32Array {
  const {co} = mesh.dumpVertCo()
  const out = new Float32Array(co.length * 3)
  for (let i = 0; i < co.length; i++) {
    out[i * 3] = co[i][0]
    out[i * 3 + 1] = co[i][1]
    out[i * 3 + 2] = co[i][2]
  }
  return out
}

/**
 * V5 gate: one LAYER_DRAW stroke through the REAL tool mapping — brush.tool =
 * SculptTools.LAYER_DRAW routed via TOOL_TO_SCULPTBRUSH / resolveDabPolicy /
 * activeAttrLayerIndex (no brushTypeOverride / attrLayerOverride seams) — plus
 * a settings-mutator round-trip (weight halved + restored, layer disabled +
 * re-enabled) exercising the Mesh_layerSet* wraps on both backends, then one
 * MeshLog undo. Positions are read CPU-side (dumpVertCo), so no GPU-buffer
 * layout hazards from tree rebuilds.
 */
function layerToolTest(): LayerToolTestResult {
  const result: LayerToolTestResult = {ok: false}
  const g = globalThis as unknown as {
    __layerToolTestResult?: LayerToolTestResult
  }
  try {
    const mesh = peekAppState()?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const wasm = mesh.wasm

    const brush = DefaultBrushes.slotMap[SculptTools.LAYER_DRAW]
    if (!brush) throw new Error('no default LAYER_DRAW brush')

    const pos0 = dumpCoFlat(mesh)
    let R = 0
    for (let i = 2; i < pos0.length; i += 3) {
      if (pos0[i] > R) R = pos0[i]
    }
    const radius = R * 0.25
    result.radius = radius

    const saved = {strength: brush.strength, flag: brush.flag, autosmooth: brush.autosmooth}
    try {
      brush.autosmooth = 0
      brush.flag &= ~BrushFlags.ACCUMULATE

      // Create + activate the layer, then settle the GPU buffer layout with a
      // zero-strength warmup stroke (same first-stroke re-batch as __layerTest).
      const li = mesh.mesh.sculptLayerAdd()
      mesh.activeSculptLayer = li
      result.layerIndex = li
      result.layerAttrIndex = mesh.mesh.sculptLayerAttrIndex(li)
      if (result.layerAttrIndex < 0) throw new Error('sculptLayerAttrIndex returned ' + result.layerAttrIndex)

      brush.strength = 0
      runSculptcoreStroke({mesh, brush, dabs: [{p: [0, 0, R], normal: [0, 0, 1]}], radius})
      brush.strength = 1

      const before = dumpCoFlat(mesh)

      // The real tool path: no brushTypeOverride, no attrLayerOverride.
      runSculptcoreStroke({mesh, brush, dabs: [{p: [0, 0, R], normal: [0, 0, 1]}], radius})

      const after = dumpCoFlat(mesh)
      if (after.length !== before.length) throw new Error('vert count changed')
      let moved = 0
      let maxDisp = 0
      for (let i = 0; i < after.length; i += 3) {
        const d = Math.hypot(after[i] - before[i], after[i + 1] - before[i + 1], after[i + 2] - before[i + 2])
        if (d > 1e-6) {
          moved++
          if (d > maxDisp) maxDisp = d
        }
      }
      result.movedCount = moved
      result.maxDisp = maxDisp
      result.postChecksum = fnv1a(after)
      result.postFloatCount = after.length

      // Settings-mutator round-trips (the V5 N-API wraps / WASM exports).
      wasm.Mesh_layerSetWeight(mesh.mesh, li, 0.5)
      const half = dumpCoFlat(mesh)
      let halfMax = 0
      for (let i = 0; i < half.length; i += 3) {
        const d = Math.hypot(half[i] - before[i], half[i + 1] - before[i + 1], half[i + 2] - before[i + 2])
        if (d > halfMax) halfMax = d
      }
      result.halfWeightMaxDisp = halfMax
      wasm.Mesh_layerSetWeight(mesh.mesh, li, 1.0)
      result.weightRestoreResidual = maxResidual(after, dumpCoFlat(mesh))

      wasm.Mesh_layerSetEnabled(mesh.mesh, li, 0)
      result.disabledResidual = maxResidual(before, dumpCoFlat(mesh))
      wasm.Mesh_layerSetEnabled(mesh.mesh, li, 1)
      result.enabledResidual = maxResidual(after, dumpCoFlat(mesh))

      // One MeshLog undo restores co + the layer column atomically (absolute
      // snapshots, so this is exact regardless of the fp round-trips above).
      SculptPaintOp.meshLog!.undo(mesh.mesh, mesh.spatial)
      mesh.regenBounds()
      mesh.meshRevision++
      result.undoResidual = maxResidual(before, dumpCoFlat(mesh))
    } finally {
      brush.strength = saved.strength
      brush.flag = saved.flag
      brush.autosmooth = saved.autosmooth
    }

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__layerToolTestResult = result
  return result
}

;(globalThis as {__layerToolTest?: typeof layerToolTest}).__layerToolTest = layerToolTest

interface LayerTargetTestResult {
  ok: boolean
  error?: string
  radius?: number
  /** Phase A: settings index of the targeted layer + the engine target after
   * the litemesh.sculpt_layer_set_target op ran (must match). */
  layerIndex?: number
  targetAfterOp?: number
  /** Per-stroke moved-vert counts while targeted (real brush.tool mapping —
   * ordinary geometry brushes, no layer-aware kernel involved). */
  drawMoved?: number
  smoothMoved?: number
  grabMoved?: number
  /** FNV-1a over post-stroke co (cross-backend parity; dyntopo off here). */
  postChecksum?: number
  postFloatCount?: number
  /** Fold + weight 0: residual vs the surface at target time (the rest). */
  weightZeroResidual?: number
  /** Weight back to 1: residual vs the post-stroke surface. */
  weightRestoreResidual?: number
  /** Engine target after toolstack-undoing the clear-target op (== layer),
   * then after redoing it (-1 again). */
  opUndoTarget?: number
  opRedoTarget?: number
  /** MeshLog stroke undo: residual vs the pre-stroke co. */
  strokeUndoResidual?: number
  /** After the stroke undo: fold + clear + weight 0 vs the rest — co and the
   * DERIVED delta stay consistent at every undo cursor. */
  undoFoldWeightZeroResidual?: number
  /** Phase B: dyntopo stroke under an edit target (rest interpolates). */
  dynVertCountChanged?: boolean
  dynNonFinite?: number
  /** Weight 1→0→1 round trip after folding the dyntopo stroke. */
  dynRoundTripResidual?: number
  /** Phase C: kelvinlet stroke under an edit target; gpuRan reports whether
   * the GPU dispatch path engaged (CPU fallback is still a valid recording). */
  gpuRan?: boolean
  gpuWeightZeroResidual?: number
}

/**
 * sculptLayersV2 gate: the ACTIVE layer is live geometry. Targets a layer
 * through the real litemesh.sculpt_layer_set_target ToolOp, then sculpts with
 * ordinary geometry brushes (DRAW/SMOOTH/GRAB — no layer-aware kernel), folds,
 * and proves weight-0 returns the surface to its at-target state; exercises
 * toolstack undo/redo of the target op, MeshLog stroke undo consistency of the
 * derived delta, dyntopo-under-edit (the rest snapshot interpolates), and a
 * kelvinlet stroke (GPU when available — co syncs before endStep, so the fold
 * sees final positions).
 */
async function layerTargetTest(): Promise<LayerTargetTestResult> {
  const result: LayerTargetTestResult = {ok: false}
  const g = globalThis as unknown as {
    __layerTargetTestResult?: LayerTargetTestResult
  }
  try {
    const ctx = getAppState().ctx
    const mesh = ctx.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const wasm = mesh.wasm

    // The litemesh.sculpt_layer_* ops are gated on this flag (default off);
    // the headless boot uses a throwaway profile, so force it for the run.
    FeatureFlags.set('sculptcore.sculpt_layers', true)

    const need = (tool: SculptTools) => {
      const b = DefaultBrushes.slotMap[tool]
      if (!b) throw new Error(`no default brush for tool ${tool}`)
      return b
    }
    const draw = need(SculptTools.DRAW)

    const pos0 = dumpCoFlat(mesh)
    let R = 0
    for (let i = 2; i < pos0.length; i += 3) {
      if (pos0[i] > R) R = pos0[i]
    }
    const radius = R * 0.25
    result.radius = radius

    const movedFrom = (a: Float32Array, b: Float32Array) => {
      let moved = 0
      for (let i = 0; i < Math.min(a.length, b.length); i += 3) {
        const d = Math.hypot(b[i] - a[i], b[i + 1] - a[i + 1], b[i + 2] - a[i + 2])
        if (d > 1e-6) moved++
      }
      return moved
    }
    const poleDab = {p: [0, 0, R], normal: [0, 0, 1]}
    const step = radius * 0.3
    const marchDabs = [
      {p: [0, 0, R], normal: [0, 0, 1]},
      {p: [step, 0, R], normal: [0, 0, 1]},
      {p: [step * 2, 0, R], normal: [0, 0, 1]},
    ]

    const savedDraw = {
      tool      : draw.tool,
      strength  : draw.strength,
      flag      : draw.flag,
      autosmooth: draw.autosmooth,
      dtFlag    : draw.dynTopoSC.flag,
    }
    try {
      draw.tool = SculptTools.DRAW
      draw.autosmooth = 0
      draw.flag &= ~BrushFlags.ACCUMULATE
      draw.dynTopoSC.flag &= ~DynTopoFlagsSC.ENABLED

      // Settle the GPU buffer layout (first stroke re-batches).
      draw.strength = 0
      runSculptcoreStroke({mesh, brush: draw, dabs: [poleDab], radius})
      draw.strength = 1

      // ---- Phase A: target via the real op, sculpt, fold, weight round-trip ----
      const li = mesh.mesh.sculptLayerAdd()
      mesh.activeSculptLayer = li
      result.layerIndex = li
      ctx.api.execTool(ctx, `litemesh.sculpt_layer_set_target(layer=${li})`)
      result.targetAfterOp = mesh.mesh.sculptLayerEditTarget()

      const preTarget = dumpCoFlat(mesh)

      runSculptcoreStroke({mesh, brush: draw, dabs: [poleDab], radius})
      const afterDraw = dumpCoFlat(mesh)
      result.drawMoved = movedFrom(preTarget, afterDraw)

      const smooth = need(SculptTools.SMOOTH)
      const savedSmooth = {strength: smooth.strength, autosmooth: smooth.autosmooth, dtFlag: smooth.dynTopoSC.flag}
      smooth.strength = 1
      smooth.autosmooth = 0
      smooth.dynTopoSC.flag &= ~DynTopoFlagsSC.ENABLED
      runSculptcoreStroke({mesh, brush: smooth, dabs: [poleDab, poleDab], radius})
      smooth.strength = savedSmooth.strength
      smooth.autosmooth = savedSmooth.autosmooth
      smooth.dynTopoSC.flag = savedSmooth.dtFlag
      const afterSmooth = dumpCoFlat(mesh)
      result.smoothMoved = movedFrom(afterDraw, afterSmooth)

      const grab = need(SculptTools.GRAB)
      const savedGrab = {strength: grab.strength, autosmooth: grab.autosmooth, dtFlag: grab.dynTopoSC.flag}
      grab.strength = 1
      grab.autosmooth = 0
      grab.dynTopoSC.flag &= ~DynTopoFlagsSC.ENABLED
      runSculptcoreStroke({mesh, brush: grab, dabs: marchDabs, radius})
      grab.strength = savedGrab.strength
      grab.autosmooth = savedGrab.autosmooth
      grab.dynTopoSC.flag = savedGrab.dtFlag
      const after = dumpCoFlat(mesh)
      result.grabMoved = movedFrom(afterSmooth, after)

      result.postChecksum = fnv1a(after)
      result.postFloatCount = after.length

      // Fold (explicit C export; the clear-target op below folds again —
      // idempotent), clear the target, and round-trip the weight.
      wasm.Mesh_layerFold(mesh.mesh)
      ctx.api.execTool(ctx, 'litemesh.sculpt_layer_set_target(layer=-1)')
      wasm.Mesh_layerSetWeight(mesh.mesh, li, 0)
      result.weightZeroResidual = maxResidual(preTarget, dumpCoFlat(mesh))
      wasm.Mesh_layerSetWeight(mesh.mesh, li, 1)
      result.weightRestoreResidual = maxResidual(after, dumpCoFlat(mesh))

      // Toolstack undo of the clear-target op re-targets the layer; redo
      // clears it again (folds are undo-transparent, no column snapshots).
      getAppState().toolstack.undo()
      result.opUndoTarget = mesh.mesh.sculptLayerEditTarget()
      getAppState().toolstack.redo()
      result.opRedoTarget = mesh.mesh.sculptLayerEditTarget()

      // ---- MeshLog stroke undo keeps co + the derived delta consistent ----
      wasm.Mesh_setActiveEditLayer(mesh.mesh, li)
      const preStroke2 = dumpCoFlat(mesh)
      runSculptcoreStroke({mesh, brush: draw, dabs: [poleDab], radius})
      SculptPaintOp.meshLog!.undo(mesh.mesh, mesh.spatial)
      mesh.regenBounds()
      mesh.meshRevision++
      result.strokeUndoResidual = maxResidual(preStroke2, dumpCoFlat(mesh))

      wasm.Mesh_setActiveEditLayer(mesh.mesh, -1)
      wasm.Mesh_layerSetWeight(mesh.mesh, li, 0)
      result.undoFoldWeightZeroResidual = maxResidual(preTarget, dumpCoFlat(mesh))
      wasm.Mesh_layerSetWeight(mesh.mesh, li, 1)

      // ---- Phase B: dyntopo under an edit target (rest interpolates) ----
      const lb = mesh.mesh.sculptLayerAdd()
      wasm.Mesh_setActiveEditLayer(mesh.mesh, lb)
      const preDyn = dumpCoFlat(mesh)
      draw.dynTopoSC.flag |= DynTopoFlagsSC.ENABLED
      draw.flag |= BrushFlags.ACCUMULATE
      runSculptcoreStroke({mesh, brush: draw, dabs: [poleDab, poleDab, poleDab, poleDab], radius})
      draw.flag &= ~BrushFlags.ACCUMULATE
      draw.dynTopoSC.flag &= ~DynTopoFlagsSC.ENABLED
      const postDyn = dumpCoFlat(mesh)
      result.dynVertCountChanged = postDyn.length !== preDyn.length
      let bad = 0
      for (let i = 0; i < postDyn.length; i++) {
        if (!Number.isFinite(postDyn[i])) bad++
      }
      result.dynNonFinite = bad

      wasm.Mesh_layerFold(mesh.mesh)
      wasm.Mesh_setActiveEditLayer(mesh.mesh, -1)
      wasm.Mesh_layerSetWeight(mesh.mesh, lb, 0)
      wasm.Mesh_layerSetWeight(mesh.mesh, lb, 1)
      result.dynRoundTripResidual = maxResidual(postDyn, dumpCoFlat(mesh))

      // ---- Phase C: kelvinlet under an edit target (GPU when available) ----
      const lc = mesh.mesh.sculptLayerAdd()
      wasm.Mesh_setActiveEditLayer(mesh.mesh, lc)
      const kelvin = need(SculptTools.KELVINLET)
      const savedK = {strength: kelvin.strength, autosmooth: kelvin.autosmooth, dtFlag: kelvin.dynTopoSC.flag}
      kelvin.strength = 1
      kelvin.autosmooth = 0
      kelvin.dynTopoSC.flag &= ~DynTopoFlagsSC.ENABLED
      const preGpu = dumpCoFlat(mesh)
      const run = runSculptcoreStroke({mesh, brush: kelvin, dabs: marchDabs, radius})
      result.gpuRan = !!run.completion
      if (run.completion) {
        await run.completion
      }
      kelvin.strength = savedK.strength
      kelvin.autosmooth = savedK.autosmooth
      kelvin.dynTopoSC.flag = savedK.dtFlag

      wasm.Mesh_layerFold(mesh.mesh)
      wasm.Mesh_setActiveEditLayer(mesh.mesh, -1)
      wasm.Mesh_layerSetWeight(mesh.mesh, lc, 0)
      result.gpuWeightZeroResidual = maxResidual(preGpu, dumpCoFlat(mesh))
      wasm.Mesh_layerSetWeight(mesh.mesh, lc, 1)
    } finally {
      draw.tool = savedDraw.tool
      draw.strength = savedDraw.strength
      draw.flag = savedDraw.flag
      draw.autosmooth = savedDraw.autosmooth
      draw.dynTopoSC.flag = savedDraw.dtFlag
    }

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__layerTargetTestResult = result
  return result
}

;(globalThis as {__layerTargetTest?: typeof layerTargetTest}).__layerTargetTest = layerTargetTest

export {layerTest, layerToolTest, layerTargetTest}
