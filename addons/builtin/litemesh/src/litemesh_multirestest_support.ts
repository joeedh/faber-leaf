/**
 * Integration-test support for multires subsurf (workstream S of
 * documentation/plans/displacementAndSubSurf.md, app-wiring pass). Exposes
 * `globalThis.__multiresTest()`, driven by the NW.js headless harness via
 * `--eval` (see `tests/integration/sculptcore_multires.test.ts`); the result
 * rides the generic `__evalTestResult` dump seam.
 *
 * On the spherified `litemesh-cube` scene it enables a 3-level multires stack
 * (the cube parks as the cage), proves the S3 losslessness gate (a level
 * round-trip is bit-stable), runs one real DRAW stroke on the finest level
 * (stroke-end writeback folds it into the grids store; dyntopo is force-gated
 * off), round-trips the stroke through MeshLog undo/redo (+ writeback resync),
 * down-refits the stroke into level 2 (fine surface preserved, coarse surface
 * moved), and deletes the stack (cage restored). Positions are read CPU-side
 * (dumpVertCo), and FNV-1a checksums are the wasm↔native bit-parity gate.
 */

import {BrushFlags, SculptTools} from '../../../../scripts/brush/brush_base'
import {DefaultBrushes, type SculptBrush} from '../../../../scripts/brush/index'
import {FeatureFlags} from '../../../../scripts/core/feature-flag'
import {nstructjs} from '../../../../scripts/path.ux/scripts/pathux'
import {runSculptcoreStroke, SculptPaintOp} from './sculptcore_ops'
import {LiteMesh} from './litemesh'
import {numVecOut} from './litemesh_vdmtest_support'
import type {VdmStoreBound} from './litemesh_vdmtest_support'
import {stencilAmplify, type StencilLevel} from '../../../../scripts/webgpu/stencil_compute'
import {getActiveWebGpuContext} from '../../../../scripts/render/queue_factory'

export interface MultiresTestResult {
  ok: boolean
  error?: string
  /** Brush radius used (a quarter of the sphere's pole distance). */
  radius?: number
  /** Cage (pre-enable) live vert / face counts. */
  cageVerts?: number
  cageFaces?: number
  /** Stack depth + the finest level's mesh counts after enable. */
  levels?: number
  levelVerts?: number
  levelFaces?: number
  /** Level round-trip 3→1→3 reproduces positions bit-exactly (S3 gate). */
  roundTripOk?: boolean
  /** FNV-1a over the pre-stroke finest-level positions. */
  baseChecksum?: number
  baseFloatCount?: number
  /** Live verts moved > 1e-6 by the DRAW stroke + the largest displacement. */
  movedCount?: number
  maxDisp?: number
  /** FNV-1a over the post-stroke finest-level positions (bit-parity gate). */
  postChecksum?: number
  postFloatCount?: number
  /** Max |co - preStroke| after MeshLog undo + writeback (expected 0). */
  undoResidual?: number
  /** Max |co - postStroke| after MeshLog redo + writeback (expected 0). */
  redoResidual?: number
  /** Level-2 checksums before/after the down-refit (must differ). */
  level2PreChecksum?: number
  level2PostChecksum?: number
  level2FloatCount?: number
  /** Coarse verts the down-refit moved (> 0). */
  refitChanged?: number
  /** Max |level-3 co - postStroke| across the refit (surface preserved). */
  refitFineResidual?: number
  /** Vert count matches the cage again after multiresDelete. */
  cageRestored?: boolean
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

function multiresTest(): MultiresTestResult {
  const result: MultiresTestResult = {ok: false}
  const g = globalThis as unknown as {
    _appstate?: {ctx?: {object?: {data?: unknown}}}
    __multiresTestResult?: MultiresTestResult
  }
  try {
    const mesh = g._appstate?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')

    const brush = DefaultBrushes.slotMap[SculptTools.DRAW]
    if (!brush) throw new Error('no default DRAW brush')

    const cage = dumpCoFlat(mesh)
    result.cageVerts = cage.length / 3
    result.cageFaces = mesh.mesh.f.count

    const LEVELS = 3
    if (!mesh.multiresEnable(LEVELS)) throw new Error('multiresEnable failed')
    try {
      result.levels = mesh.multiresLevels
      if (mesh.multiresLevel !== LEVELS) throw new Error('finest level not active after enable')
      result.levelVerts = mesh.mesh.v.count
      result.levelFaces = mesh.mesh.f.count

      const base = dumpCoFlat(mesh)
      result.baseChecksum = fnv1a(base)
      result.baseFloatCount = base.length

      // S3 losslessness: an edit-free switch round-trip is bit-stable.
      mesh.multiresSetLevel(1)
      mesh.multiresSetLevel(LEVELS)
      result.roundTripOk = fnv1a(dumpCoFlat(mesh)) === result.baseChecksum

      let R = 0
      for (let i = 2; i < base.length; i += 3) {
        if (base[i] > R) R = base[i]
      }
      const radius = R * 0.25
      result.radius = radius

      const saved = {strength: brush.strength, flag: brush.flag, autosmooth: brush.autosmooth}
      try {
        brush.autosmooth = 0
        brush.flag &= ~BrushFlags.ACCUMULATE
        brush.strength = 1

        // One DRAW dab at the +Z pole; runSculptcoreStroke ends with
        // multiresWriteback (the stroke-end fold) and force-gates dyntopo off.
        runSculptcoreStroke({mesh, brush, dabs: [{p: [0, 0, R], normal: [0, 0, 1]}], radius})

        const after = dumpCoFlat(mesh)
        if (after.length !== base.length) throw new Error('vert count changed by the stroke')
        let moved = 0
        let maxDisp = 0
        for (let i = 0; i < after.length; i += 3) {
          const d = Math.hypot(after[i] - base[i], after[i + 1] - base[i + 1], after[i + 2] - base[i + 2])
          if (d > 1e-6) {
            moved++
            if (d > maxDisp) maxDisp = d
          }
        }
        result.movedCount = moved
        result.maxDisp = maxDisp
        result.postChecksum = fnv1a(after)
        result.postFloatCount = after.length

        // MeshLog undo/redo round-trip, each followed by the store resync the
        // interactive op performs (SculptPaintOp.undo/redo).
        SculptPaintOp.meshLog!.undo(mesh.mesh, mesh.spatial)
        mesh.multiresWriteback()
        result.undoResidual = maxResidual(base, dumpCoFlat(mesh))
        SculptPaintOp.meshLog!.redo(mesh.mesh, mesh.spatial)
        mesh.multiresWriteback()
        result.redoResidual = maxResidual(after, dumpCoFlat(mesh))

        // Down-refit: the stroke (stored at level 3) is least-squares-absorbed
        // into level 2; the level-3 surface must be preserved.
        mesh.multiresSetLevel(2)
        const l2Pre = dumpCoFlat(mesh)
        result.level2PreChecksum = fnv1a(l2Pre)
        result.level2FloatCount = l2Pre.length
        mesh.multiresSetLevel(LEVELS)

        result.refitChanged = mesh.multiresDownRefit()
        result.refitFineResidual = maxResidual(after, dumpCoFlat(mesh))

        mesh.multiresSetLevel(2)
        result.level2PostChecksum = fnv1a(dumpCoFlat(mesh))
        mesh.multiresSetLevel(LEVELS)
      } finally {
        brush.strength = saved.strength
        brush.flag = saved.flag
        brush.autosmooth = saved.autosmooth
      }
    } finally {
      mesh.multiresDelete()
    }
    result.cageRestored = dumpCoFlat(mesh).length === cage.length && mesh.mesh.f.count === result.cageFaces

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__multiresTestResult = result
  return result
}

;(globalThis as {__multiresTest?: typeof multiresTest}).__multiresTest = multiresTest

export interface MultiresVdmTestResult {
  ok: boolean
  error?: string
  radius?: number
  levels?: number
  /** Texels the default-α pole splat touched (> 0 proves the synthesized
   * grid-chart UVs drive the splatter on the level mesh). */
  texelsTouched?: number
  /** Vdm_lastSplatClamped after the default-α splat (recorded, not asserted). */
  clampedDefault?: number
  /** Vdm_lastSplatClamped after a near-zero-α splat — the add-a-level prompt
   * signal; must saturate most of the footprint (clamp is a true ceiling). */
  promptSignal?: number
  /** Store shape + the atlas bit-parity gate. */
  tileCount?: number
  atlasFloatCount?: number
  atlasChecksum?: number
  /** FNV over round(texel·1e3) — absorbs ulp-level backend noise (the raw
   * checksum diverges on curved bases; see the plan's F3-parity follow-up). */
  atlasQuantChecksum?: number
  /** Max |texel| (recorded for the quantization scale sanity). */
  atlasMaxAbs?: number
  /** A VDM splat moves no vertices. */
  posChecksumBefore?: number
  posChecksumAfter?: number
  /** hasVdm still true after a level switch (render attach survives). */
  hasVdmAfterSwitch?: boolean
  /** Atlas bytes identical after a 2→1→2 level round-trip (the store is
   * level-independent; grid charts are level-consistent). */
  atlasStableAcrossSwitch?: boolean
}

/**
 * X1 gate: a VDM layer on the finest multires level. Enables a 2-level stack,
 * splats through the level mesh's synthesized grid-chart UVs, proves the splat
 * moves no verts, reads the clamp (add-a-level prompt) signal through the
 * backend seam, and round-trips a level switch with the store attached.
 */
function multiresVdmTest(): MultiresVdmTestResult {
  const result: MultiresVdmTestResult = {ok: false}
  const g = globalThis as unknown as {
    _appstate?: {ctx?: {object?: {data?: unknown}}}
    __multiresVdmTestResult?: MultiresVdmTestResult
  }
  try {
    const mesh = g._appstate?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const wasm = mesh.wasm

    if (!mesh.multiresEnable(2)) throw new Error('multiresEnable failed')
    try {
      result.levels = mesh.multiresLevels

      // The engine synthesized the grid-chart UVs at materialization; satisfy
      // the splatter's frame + carrier prerequisites (the harness fill).
      wasm.Mesh_updateFrames(mesh.mesh)
      wasm.SpatialTree_fillDetailCarrier(mesh.spatial, 1)

      const before = dumpCoFlat(mesh)
      result.posChecksumBefore = fnv1a(before)
      let R = 0
      for (let i = 2; i < before.length; i += 3) {
        if (before[i] > R) R = before[i]
      }
      const radius = R * 0.35
      result.radius = radius

      const store = wasm.VdmStore_new(1024, 32)
      mesh.attachVdmStore(store) // LiteMesh owns it now (freed on detach)
      try {
        result.texelsTouched = wasm.Mesh_vdmSplatDab(
          mesh.mesh,
          mesh.spatial,
          store,
          0,
          0,
          R,
          0,
          0,
          1,
          radius,
          1.0,
          0.5,
          0
        )
        result.clampedDefault = wasm.Vdm_lastSplatClamped()

        // Near-zero α → the fold ceiling collapses; the clamp count is the
        // add-a-level prompt signal (no promotion exists on this base).
        wasm.Mesh_vdmSplatDab(mesh.mesh, mesh.spatial, store, 0, 0, R, 0, 0, 1, radius, 1.0, 1e-8, 0)
        result.promptSignal = wasm.Vdm_lastSplatClamped()

        result.posChecksumAfter = fnv1a(dumpCoFlat(mesh))

        const sb = store as unknown as VdmStoreBound
        result.tileCount = sb.tileCount()
        const atlasOut = numVecOut(mesh, 'float')
        sb.gpuAtlasPixelsOut(atlasOut.vec as never)
        const atlas = atlasOut.read()
        const f32 = atlas instanceof Float32Array ? atlas : Float32Array.from(atlas as ArrayLike<number>)
        result.atlasFloatCount = f32.length
        result.atlasChecksum = fnv1a(f32)
        const quant = new Int32Array(f32.length)
        let maxAbs = 0
        for (let i = 0; i < f32.length; i++) {
          quant[i] = Math.round(f32[i] * 1000)
          const a = Math.abs(f32[i])
          if (a > maxAbs) maxAbs = a
        }
        result.atlasMaxAbs = maxAbs
        result.atlasQuantChecksum = fnv1a(new Float32Array(quant.buffer))

        // Level round-trip with the store attached: the attach hook re-frames
        // + re-tags the new level; the store itself must be untouched.
        mesh.multiresSetLevel(1)
        result.hasVdmAfterSwitch = mesh.hasVdm
        mesh.multiresSetLevel(2)
        const atlasOut2 = numVecOut(mesh, 'float')
        sb.gpuAtlasPixelsOut(atlasOut2.vec as never)
        const again = atlasOut2.read()
        const f32b = again instanceof Float32Array ? again : Float32Array.from(again as ArrayLike<number>)
        result.atlasStableAcrossSwitch = fnv1a(f32b) === result.atlasChecksum
      } finally {
        mesh.detachVdmStore()
      }
    } finally {
      mesh.multiresDelete()
    }

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__multiresVdmTestResult = result
  return result
}

;(globalThis as {__multiresVdmTest?: typeof multiresVdmTest}).__multiresVdmTest = multiresVdmTest

export interface StencilAmplifyTestResult {
  ok: boolean
  error?: string
  editLevel?: number
  renderLevel?: number
  fineCount?: number
  nnz?: number
  /** GPU SpMV vs the CPU-materialized level: mismatch count + max |Δ|.
   * Bit-exact on native wgpu (Vulkan honours fma; the S5 gate); Dawn's D3D12
   * path lowers WGSL fma unfused → 1-ulp-class noise, gated by maxAbsErr
   * (display-only verts). Cross-backend GPU checksums stay exact. */
  diffs?: number
  maxAbsErr?: number
  /** JS fma-exact eval of the marshalled CSR vs CPU/GPU: jsVsCpu == 0 is the
   * bit-parity gate for the export seam (tables, row order, src). */
  jsVsCpu?: number
  jsVsGpu?: number
  samples?: number[][]
  gpuChecksum?: number
  cpuChecksum?: number
  /** levelTriIndicesOut sanity: index count + all indices < fineCount. */
  triIndexCount?: number
  triIndexOk?: boolean
}

/**
 * X3 stage-1 gate: the TS-device stencil SpMV reproduces the CPU chain
 * bit-for-bit. Enables a 3-level stack, edits at level 2, marshals level 3's
 * CSR stencil through the new Multires bound methods, dispatches the ported
 * kernel on the renderer's device, and compares against the engine-
 * materialized level 3 (Float32-exact — the S5 fma contract, now across the
 * app seam too). Also sanity-checks the render-level index-buffer emitter.
 */
async function stencilAmplifyTest(): Promise<StencilAmplifyTestResult> {
  const result: StencilAmplifyTestResult = {ok: false}
  const g = globalThis as unknown as {
    _appstate?: {ctx?: {object?: {data?: unknown}}}
    __stencilAmplifyTestResult?: StencilAmplifyTestResult
  }
  try {
    const mesh = g._appstate?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    // The render context registers asynchronously after boot (GpuContext
    // .create); this driver runs from a harness --eval that may precede the
    // first frame, so poll for it.
    let device: GPUDevice | undefined
    const t0 = Date.now()
    while (!(device = getActiveWebGpuContext()?.device)) {
      if (Date.now() - t0 > 20000) throw new Error('no WebGPU device (timeout)')
      await new Promise((r) => setTimeout(r, 50))
    }

    if (!mesh.multiresEnable(3)) throw new Error('multiresEnable failed')
    try {
      mesh.multiresSetLevel(2)
      result.editLevel = 2
      result.renderLevel = 3
      const src = dumpCoFlat(mesh)

      const mr = mesh._multires! as unknown as {
        stencilMetaOut(l: number, out: never): void
        stencilOffsetsOut(l: number, out: never): void
        stencilIndicesOut(l: number, out: never): void
        stencilWeightsOut(l: number, out: never): void
        levelTriIndicesOut(l: number, out: never): void
      }
      const metaV = numVecOut(mesh, 'int32')
      mr.stencilMetaOut(3, metaV.vec as never)
      const meta = Array.from(metaV.read() as ArrayLike<number>)
      if (meta.length < 3) throw new Error('stencilMetaOut empty')
      const offV = numVecOut(mesh, 'int32')
      mr.stencilOffsetsOut(3, offV.vec as never)
      const idxV = numVecOut(mesh, 'int32')
      mr.stencilIndicesOut(3, idxV.vec as never)
      const wgtV = numVecOut(mesh, 'float')
      mr.stencilWeightsOut(3, wgtV.vec as never)
      const level: StencilLevel = {
        coarseCount: meta[0] | 0,
        fineCount  : meta[1] | 0,
        offsets    : Uint32Array.from(offV.read() as ArrayLike<number>),
        indices    : Uint32Array.from(idxV.read() as ArrayLike<number>),
        weights    : Float32Array.from(wgtV.read() as ArrayLike<number>),
      }
      result.fineCount = level.fineCount
      result.nnz = meta[2] | 0

      const {positions} = await stencilAmplify(device, [level], src)
      result.gpuChecksum = fnv1a(positions)

      mesh.multiresSetLevel(3)
      const cpu = dumpCoFlat(mesh)
      mesh.multiresSetLevel(2)
      result.cpuChecksum = fnv1a(cpu)
      let diffs = positions.length === cpu.length ? 0 : Infinity
      let maxAbsErr = positions.length === cpu.length ? 0 : Infinity
      if (diffs === 0) {
        for (let i = 0; i < positions.length; i++) {
          if (positions[i] === cpu[i]) continue
          diffs++
          const d = Math.abs(positions[i] - cpu[i])
          if (d > maxAbsErr) maxAbsErr = d
        }
      }
      result.diffs = diffs
      result.maxAbsErr = maxAbsErr

      // The bit-parity gate for the EXPORT SEAM: evaluate the same marshalled
      // CSR in JS (f64 mul+add + one fround = exact f32 fma at these
      // magnitudes) — jsVsCpu == 0 proves tables/order/src cross bit-perfect.
      // The GPU itself gets a display-tier tolerance instead: Dawn's D3D12
      // path lowers WGSL fma unfused (1-ulp-class noise; native wgpu is
      // bit-exact per the S5 gate), and amplified verts never enter the mesh.
      const js = new Float32Array(level.fineCount * 3)
      for (let i = 0; i < level.fineCount; i++) {
        let px = 0,
          py = 0,
          pz = 0
        const e = level.offsets[i + 1]
        for (let k = level.offsets[i]; k < e; k++) {
          const s = level.indices[k] * 3
          const w = level.weights[k]
          px = Math.fround(src[s] * w + px)
          py = Math.fround(src[s + 1] * w + py)
          pz = Math.fround(src[s + 2] * w + pz)
        }
        js[i * 3] = px
        js[i * 3 + 1] = py
        js[i * 3 + 2] = pz
      }
      let jsVsCpu = 0
      let jsVsGpu = 0
      for (let i = 0; i < js.length; i++) {
        if (js[i] !== cpu[i]) jsVsCpu++
        if (js[i] !== positions[i]) jsVsGpu++
      }
      result.jsVsCpu = jsVsCpu
      result.jsVsGpu = jsVsGpu
      const samples: number[][] = []
      for (let i = 0; i < cpu.length && samples.length < 3; i++) {
        if (positions[i] !== cpu[i]) samples.push([i, positions[i], cpu[i], js[i]])
      }
      result.samples = samples

      const triV = numVecOut(mesh, 'int32')
      mr.levelTriIndicesOut(3, triV.vec as never)
      const tris = triV.read()
      result.triIndexCount = tris.length
      let triOk = tris.length > 0 && tris.length % 3 === 0
      for (let i = 0; triOk && i < tris.length; i++) {
        if ((tris[i] as number) < 0 || (tris[i] as number) >= level.fineCount) triOk = false
      }
      result.triIndexOk = triOk
    } finally {
      mesh.multiresDelete()
    }

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__stencilAmplifyTestResult = result
  return result
}

;(globalThis as {__stencilAmplifyTest?: typeof stencilAmplifyTest}).__stencilAmplifyTest = stencilAmplifyTest

/** `__vdmSculptTest()` result — the X3 stage-4 interactive-VDM gate. */
interface VdmSculptResult {
  ok: boolean
  error?: string
  /** Multires stack depth after litemesh.multires_enable (expect 2). */
  levels?: number
  /** Store backend after litemesh.vdm_enable (expect true = Ptex). */
  isPtex?: boolean
  /** Live tiles after one routed DRAW stroke (expect > 0). */
  tilesAfterStroke?: number
  /** Max |co| drift over the stroke (expect 0 — splats move no vertices). */
  vertResidual?: number
  blobLenAfterStroke?: number
  /** FNV-1a of the store blob — cross-backend comparable. */
  blobChecksumAfterStroke?: number
  /** Tiles after MeshLog undo of the stroke step (expect 0). */
  tilesAfterUndo?: number
  tilesAfterRedo?: number
  /** Blob checksum after redo (expect === blobChecksumAfterStroke). */
  blobChecksumAfterRedo?: number
  /** hasVdm after litemesh.vdm_delete (expect false). */
  vdmAfterDeleteOp?: boolean
  /** hasVdm after toolstack undo of the delete (expect true). */
  vdmAfterDeleteUndo?: boolean
  /** Blob checksum after the delete undo (expect === blobChecksumAfterStroke:
   * the SAME store instance comes back, texels intact). */
  blobChecksumAfterDeleteUndo?: number
  /** X4 apply: verts moved by litemesh.vdm_apply (expect > 0). */
  applyMoved?: number
  /** Position checksum before / after the apply (must differ). */
  posBeforeApply?: number
  posAfterApply?: number
  /** Tiles after the apply (expect 0 — the store was cleared). */
  tilesAfterApply?: number
  /** After toolstack undo of the apply: positions + store restored exactly. */
  posAfterApplyUndo?: number
  tilesAfterApplyUndo?: number
  blobChecksumAfterApplyUndo?: number
  /** X4 capture: texels after litemesh.vdm_capture on the re-applied detail
   * (expect > 0) and positions dropped EXACTLY back onto the smooth base. */
  tilesAfterCapture?: number
  posAfterCapture?: number
  /** Max |co| between the first apply and re-applying the captured texels —
   * the capture/apply round-trip residual (bilinear x2; small vs maxDisp). */
  captureRoundTripResidual?: number
  captureMaxDisp?: number
  /** After toolstack undo of the capture: max |co| vs the applied state.
   * Residual, not checksum — the undo rematerializes positions through the
   * disp encoding (frameT then frame = two fp rounding passes). */
  captureUndoResidual?: number
  tilesAfterCaptureUndo?: number
}

function fnv1aBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** X3 stage-4 interactive VDM sculpting gate: feature-flagged lifecycle ops
 * (enable/delete + undo through the real toolstack), Draw-dab carrier routing
 * through `runSculptcoreStroke` (texels splat, vertices hold still), and the
 * stroke's VdmLogChunk undo/redo through the shared MeshLog. */
function vdmSculptTest(): VdmSculptResult {
  const result: VdmSculptResult = {ok: false}
  const g = globalThis as unknown as {
    _appstate?: {
      ctx: {
        object?: {data?: unknown}
        api?: {execTool: (ctx: unknown, p: string) => void}
      }
      toolstack: {undo: () => void; redo: () => void}
    }
    __evalTestResult?: unknown
  }
  try {
    const app = g._appstate
    if (!app) throw new Error('no _appstate')
    const ctx = app.ctx
    const mesh = ctx.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const wasm = mesh.wasm

    FeatureFlags.set('sculptcore.multires', true)
    FeatureFlags.set('sculptcore.vdm_sculpt', true)

    const {co} = mesh.dumpVertCo()
    let R = 0
    for (const pt of co) {
      const l = Math.hypot(pt[0], pt[1], pt[2])
      if (l > R) R = l
    }

    ctx.api?.execTool(ctx, 'litemesh.multires_enable()')
    result.levels = mesh.multiresLevels
    if (!mesh.multiresActive) throw new Error('multires_enable did not attach a stack')

    ctx.api?.execTool(ctx, 'litemesh.vdm_enable()')
    if (!mesh.hasVdm) throw new Error('vdm_enable did not attach a store')
    result.isPtex = mesh.vdmIsPtex
    const store = mesh.vdmStore as unknown as {tileCount(): number}

    let draw: SculptBrush | undefined
    for (const k in DefaultBrushes.brushes) {
      const b = DefaultBrushes.brushes[k]
      if (b && b.tool === SculptTools.DRAW) draw = b
    }
    if (!draw) throw new Error('no default DRAW brush')

    const pre = dumpCoFlat(mesh)
    runSculptcoreStroke({
      mesh,
      brush : draw,
      dabs  : [{p: [0, 0, R], normal: [0, 0, 1]}],
      radius: R * 0.5,
    })
    result.tilesAfterStroke = store.tileCount()
    result.vertResidual = maxResidual(pre, dumpCoFlat(mesh))
    const blob1 = wasm.VdmStore_serializeBlob(mesh.vdmStore!)
    result.blobLenAfterStroke = blob1.length
    result.blobChecksumAfterStroke = fnv1aBytes(blob1)

    // The stroke's texel delta rides its MeshLog step (VdmLogChunk).
    SculptPaintOp.meshLog!.undo(mesh.mesh, mesh.spatial)
    result.tilesAfterUndo = store.tileCount()
    SculptPaintOp.meshLog!.redo(mesh.mesh, mesh.spatial)
    result.tilesAfterRedo = store.tileCount()
    result.blobChecksumAfterRedo = fnv1aBytes(wasm.VdmStore_serializeBlob(mesh.vdmStore!))

    // Lifecycle undo through the real toolstack: delete releases (not frees)
    // the instance, so its undo brings every texel back.
    ctx.api?.execTool(ctx, 'litemesh.vdm_delete()')
    result.vdmAfterDeleteOp = mesh.hasVdm
    app.toolstack.undo()
    result.vdmAfterDeleteUndo = mesh.hasVdm
    if (mesh.hasVdm) {
      result.blobChecksumAfterDeleteUndo = fnv1aBytes(wasm.VdmStore_serializeBlob(mesh.vdmStore!))
    }

    // X4 apply: bake the texels into the vertices (folds into the grids
    // store on this multires mesh), store cleared; toolstack undo restores
    // both sides exactly.
    result.posBeforeApply = fnv1a(dumpCoFlat(mesh))
    ctx.api?.execTool(ctx, 'litemesh.vdm_apply()')
    result.posAfterApply = fnv1a(dumpCoFlat(mesh))
    result.tilesAfterApply = store.tileCount()
    let applyMoved = 0
    {
      const {co} = mesh.dumpVertCo()
      void co
      applyMoved = result.posAfterApply === result.posBeforeApply ? 0 : 1
    }
    result.applyMoved = applyMoved
    app.toolstack.undo()
    result.posAfterApplyUndo = fnv1a(dumpCoFlat(mesh))
    result.tilesAfterApplyUndo = store.tileCount()
    result.blobChecksumAfterApplyUndo = mesh.hasVdm ? fnv1aBytes(wasm.VdmStore_serializeBlob(mesh.vdmStore!)) : -1

    // X4 capture round-trip: redo the apply (detail -> geometry, store
    // empty), capture it back (geometry -> texels, surface drops EXACTLY
    // onto the smooth base = the pre-apply positions), then re-apply and
    // measure the double-bilinear residual against the first apply.
    app.toolstack.redo()
    const applied1 = dumpCoFlat(mesh)
    let maxDisp = 0
    ctx.api?.execTool(ctx, 'litemesh.vdm_capture()')
    result.tilesAfterCapture = store.tileCount()
    result.posAfterCapture = fnv1a(dumpCoFlat(mesh))
    {
      const base = dumpCoFlat(mesh)
      for (let i = 0; i < base.length; i += 3) {
        const d = Math.hypot(applied1[i] - base[i], applied1[i + 1] - base[i + 1], applied1[i + 2] - base[i + 2])
        if (d > maxDisp) maxDisp = d
      }
    }
    result.captureMaxDisp = maxDisp
    ctx.api?.execTool(ctx, 'litemesh.vdm_apply()')
    result.captureRoundTripResidual = maxResidual(applied1, dumpCoFlat(mesh))
    app.toolstack.undo() // un-apply
    app.toolstack.undo() // un-capture -> back to the applied state
    result.captureUndoResidual = maxResidual(applied1, dumpCoFlat(mesh))
    result.tilesAfterCaptureUndo = store.tileCount()

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__evalTestResult = result
  return result
}

;(globalThis as {__vdmSculptTest?: typeof vdmSculptTest}).__vdmSculptTest = vdmSculptTest

/** `__vdmPersistTest()` result — the X4 stage-3 .wproj round-trip gate. */
interface VdmPersistResult {
  ok: boolean
  error?: string
  levels?: number
  activeLevel?: number
  tiles?: number
  vdmChecksum?: number
  posChecksum?: number
  cageChecksum?: number
  /** The nstructjs stream length (sanity: nonzero). */
  streamBytes?: number
  loadedLevels?: number
  loadedActiveLevel?: number
  loadedHasVdm?: boolean
  loadedIsPtex?: boolean
  loadedTiles?: number
  loadedVdmChecksum?: number
  loadedPosChecksum?: number
  loadedCageChecksum?: number
  /** Max |co| between saved and loaded active-level positions. Residual, not
   * checksum: the load rematerializes through the disp encoding (frameT then
   * frame = two fp rounding passes over the writeback fold). */
  posResidual?: number
}

/** In-process nstructjs round-trip of a LiteMesh carrying a multires stack +
 * a Ptex VDM store (X4 stage 3): serialize -> readObject -> compare stack
 * depth/level, VDM blob checksum, and the active-level position checksum.
 * Before stage 3 this flattened: the level VIEW was saved as the mesh and
 * the stack + store were dropped. */
function vdmPersistTest(): VdmPersistResult {
  const result: VdmPersistResult = {ok: false}
  const g = globalThis as unknown as {
    _appstate?: {ctx: {object?: {data?: unknown}}}
    __evalTestResult?: unknown
  }
  try {
    const app = g._appstate
    if (!app) throw new Error('no _appstate')
    const mesh = app.ctx.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const wasm = mesh.wasm

    const {co} = mesh.dumpVertCo()
    let R = 0
    for (const pt of co) {
      const l = Math.hypot(pt[0], pt[1], pt[2])
      if (l > R) R = l
    }

    if (!mesh.multiresEnable(2)) throw new Error('multiresEnable failed')
    if (!mesh.vdmEnable()) throw new Error('vdmEnable failed')
    wasm.Mesh_vdmSplatDab(mesh.mesh, mesh.spatial, mesh.vdmStore!, 0, 0, R, 0, 0, 1, R * 0.5, 1.0, 0.5, 0)
    // A real level edit too, so the grids-store blob carries nonzero disp.
    let draw: SculptBrush | undefined
    for (const k in DefaultBrushes.brushes) {
      const b = DefaultBrushes.brushes[k]
      if (b && b.tool === SculptTools.SMOOTH) draw = b
    }
    // SMOOTH is not VDM-routed, so it deforms the level vertices directly.
    if (draw) {
      runSculptcoreStroke({mesh, brush: draw, dabs: [{p: [R, 0, 0], normal: [1, 0, 0]}], radius: R * 0.4})
    }

    const store = mesh.vdmStore as unknown as {tileCount(): number}
    result.levels = mesh.multiresLevels
    result.activeLevel = mesh.multiresLevel
    result.tiles = store.tileCount()
    result.vdmChecksum = fnv1aBytes(wasm.VdmStore_serializeBlob(mesh.vdmStore!))
    result.posChecksum = fnv1a(dumpCoFlat(mesh))
    result.cageChecksum = fnv1aBytes(wasm.Mesh_serialize(mesh._multiresCage!))

    const data: number[] = []
    nstructjs.manager.write_object(data, mesh)
    result.streamBytes = data.length
    const loaded = nstructjs.readObject(new Uint8Array(data), LiteMesh) as LiteMesh

    try {
      result.loadedLevels = loaded.multiresLevels
      result.loadedActiveLevel = loaded.multiresLevel
      result.loadedHasVdm = loaded.hasVdm
      result.loadedIsPtex = loaded.vdmIsPtex
      const lstore = loaded.vdmStore as unknown as {tileCount(): number} | undefined
      result.loadedTiles = lstore ? lstore.tileCount() : -1
      result.loadedVdmChecksum = loaded.hasVdm ? fnv1aBytes(wasm.VdmStore_serializeBlob(loaded.vdmStore!)) : -1
      const savedCo = dumpCoFlat(mesh)
      const loadedCo = dumpCoFlat(loaded)
      result.loadedPosChecksum = fnv1a(loadedCo)
      result.posResidual = maxResidual(savedCo, loadedCo)
      result.loadedCageChecksum = loaded._multiresCage ? fnv1aBytes(wasm.Mesh_serialize(loaded._multiresCage)) : -1
    } finally {
      loaded.destroy()
    }

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__evalTestResult = result
  return result
}

;(globalThis as {__vdmPersistTest?: typeof vdmPersistTest}).__vdmPersistTest = vdmPersistTest

/** `__multiresLayerTest()` result — the sculptLayersV2 M3 channel gate. */
export interface MultiresLayerTestResult {
  ok: boolean
  error?: string
  radius?: number
  /** Settings index from the routed layerAdd (expected 0) + target confirm. */
  layerIndex?: number
  targetSet?: boolean
  /** Stroke displacement on the finest level while targeted. */
  movedCount?: number
  maxDisp?: number
  /** FNV-1a over the post-stroke level positions (wasm↔native parity). */
  postChecksum?: number
  postFloatCount?: number
  /** Weight 0 (target cleared) restores the pre-stroke level surface. */
  weightZeroResidual?: number
  /** Weight back to 1: the stroke returns through the frame re-encode. */
  weightRestoreResidual?: number
  /** Level switch round-trip stays bit-stable with the layer composited. */
  roundTripOk?: boolean
  /** Store-blob + layer-table round-trip preserves the layer. */
  blobRestoreResidual?: number
  layerCountAfterRestore?: number
}

/**
 * sculptLayersV2 M3 gate: a sculpt layer on a multires level is a grids-store
 * CHANNEL. Adds + targets a layer through the LiteMesh routing helpers, runs a
 * real DRAW stroke on the finest level (stroke-end writeback lands in the
 * layer's channel), and proves the weight-0 restore, level-switch
 * bit-stability, and the store-blob + layer-table undo seam.
 */
function multiresLayerTest(): MultiresLayerTestResult {
  const result: MultiresLayerTestResult = {ok: false}
  const g = globalThis as unknown as {
    _appstate?: {ctx?: {object?: {data?: unknown}}}
  }
  try {
    const mesh = g._appstate?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const brush = DefaultBrushes.slotMap[SculptTools.DRAW]
    if (!brush) throw new Error('no default DRAW brush')

    if (!mesh.multiresEnable(3)) throw new Error('multiresEnable failed')
    try {
      const base = dumpCoFlat(mesh)
      let R = 0
      for (let i = 2; i < base.length; i += 3) {
        if (base[i] > R) R = base[i]
      }
      const radius = R * 0.25
      result.radius = radius

      const li = mesh.layerAdd()
      result.layerIndex = li
      result.targetSet = mesh.layerSetTarget(li) === li && mesh.layerEditTarget() === li

      const saved = {strength: brush.strength, flag: brush.flag, autosmooth: brush.autosmooth}
      try {
        brush.autosmooth = 0
        brush.flag &= ~BrushFlags.ACCUMULATE
        brush.strength = 1
        runSculptcoreStroke({mesh, brush, dabs: [{p: [0, 0, R], normal: [0, 0, 1]}], radius})
      } finally {
        brush.strength = saved.strength
        brush.flag = saved.flag
        brush.autosmooth = saved.autosmooth
      }

      const after = dumpCoFlat(mesh)
      let moved = 0
      let maxDisp = 0
      for (let i = 0; i < after.length; i += 3) {
        const d = Math.hypot(after[i] - base[i], after[i + 1] - base[i + 1], after[i + 2] - base[i + 2])
        if (d > 1e-6) {
          moved++
          if (d > maxDisp) maxDisp = d
        }
      }
      result.movedCount = moved
      result.maxDisp = maxDisp
      result.postChecksum = fnv1a(after)
      result.postFloatCount = after.length

      // Weight round-trip: the whole stroke lives in the layer's channel.
      mesh.layerSetTarget(-1)
      mesh.layerSetWeight(li, 0)
      result.weightZeroResidual = maxResidual(base, dumpCoFlat(mesh))
      mesh.layerSetWeight(li, 1)
      result.weightRestoreResidual = maxResidual(after, dumpCoFlat(mesh))

      // Level-switch round-trip with the layer composited.
      const chk = fnv1a(dumpCoFlat(mesh))
      mesh.multiresSetLevel(1)
      mesh.multiresSetLevel(3)
      result.roundTripOk = fnv1a(dumpCoFlat(mesh)) === chk

      // Store blob + layer table = the remove-undo/persistence seam.
      const restoreTo = dumpCoFlat(mesh)
      const blob = mesh.multiresStoreBlob()!
      const table = mesh.multiresLayerTableCapture()
      mesh.layerRemove(li)
      mesh.multiresRestoreStoreBlob(blob, 3)
      mesh.multiresLayerTableRestore(table)
      result.blobRestoreResidual = maxResidual(restoreTo, dumpCoFlat(mesh))
      result.layerCountAfterRestore = mesh.layerCount()
    } finally {
      mesh.multiresDelete()
    }
    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  return result
}

;(globalThis as {__multiresLayerTest?: typeof multiresLayerTest}).__multiresLayerTest = multiresLayerTest

/** `__multiresAddLevelTest()` result — the litemesh.multires_add_level gate. */
export interface MultiresAddLevelTestResult {
  ok: boolean
  error?: string
  /** Stack depth + finest face count before the grow. */
  levelsBefore?: number
  facesBefore?: number
  /** After the grow: depth (+1), active level (the new finest), face count. */
  levelsAfter?: number
  activeAfter?: number
  facesAfter?: number
  /** FNV-1a over the new finest-level positions (wasm↔native parity). */
  postChecksum?: number
  postFloatCount?: number
  /** The pre-grow finest surface, and whether it survives the grow bit-exactly. */
  preservedChecksum?: number
  preservedMatches?: boolean
  /** Toolstack undo of the op: restored depth + finest-surface checksum match. */
  levelsAfterUndo?: number
  undoChecksum?: number
  undoMatches?: boolean
  /** Toolstack redo re-grows; the finest surface reproduces the grow exactly. */
  levelsAfterRedo?: number
  redoChecksum?: number
}

/**
 * Add-level gate: on a 3-level stack with a real DRAW dab folded into the
 * finest level, growing one level through the `litemesh.multires_add_level`
 * ToolOp (a) increments the depth and quadruples the finest face count,
 * (b) preserves the pre-grow finest surface bit-exactly (lossless grow), and
 * (c) round-trips through the real toolstack undo/redo. Checksums are the
 * wasm↔native bit-parity gate.
 */
function multiresAddLevelTest(): MultiresAddLevelTestResult {
  const result: MultiresAddLevelTestResult = {ok: false}
  const g = globalThis as unknown as {
    _appstate?: {
      ctx: {object?: {data?: unknown}; api?: {execTool: (ctx: unknown, p: string) => void}}
      toolstack: {undo: () => void; redo: () => void}
    }
  }
  try {
    const app = g._appstate
    if (!app) throw new Error('no _appstate')
    const ctx = app.ctx
    const mesh = ctx.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')

    FeatureFlags.set('sculptcore.multires', true)
    if (!mesh.multiresEnable(3)) throw new Error('multiresEnable failed')

    // A real DRAW dab on the finest level so the preserved detail is nonzero.
    const brush = DefaultBrushes.slotMap[SculptTools.DRAW]
    if (!brush) throw new Error('no default DRAW brush')
    const base = dumpCoFlat(mesh)
    let R = 0
    for (let i = 2; i < base.length; i += 3) {
      if (base[i] > R) R = base[i]
    }
    const saved = {strength: brush.strength, flag: brush.flag, autosmooth: brush.autosmooth}
    try {
      brush.autosmooth = 0
      brush.flag &= ~BrushFlags.ACCUMULATE
      brush.strength = 1
      runSculptcoreStroke({mesh, brush, dabs: [{p: [0, 0, R], normal: [0, 0, 1]}], radius: R * 0.25})
    } finally {
      brush.strength = saved.strength
      brush.flag = saved.flag
      brush.autosmooth = saved.autosmooth
    }

    const preservedLevel = mesh.multiresLevel
    result.preservedChecksum = fnv1a(dumpCoFlat(mesh))
    result.levelsBefore = mesh.multiresLevels
    result.facesBefore = mesh.mesh.f.count

    // Grow one level through the real ToolOp.
    ctx.api?.execTool(ctx, 'litemesh.multires_add_level()')
    result.levelsAfter = mesh.multiresLevels
    result.activeAfter = mesh.multiresLevel
    result.facesAfter = mesh.mesh.f.count
    const post = dumpCoFlat(mesh)
    result.postChecksum = fnv1a(post)
    result.postFloatCount = post.length

    // The pre-grow finest level survives the grow bit-exactly.
    mesh.multiresSetLevel(preservedLevel)
    result.preservedMatches = fnv1a(dumpCoFlat(mesh)) === result.preservedChecksum
    mesh.multiresSetLevel(mesh.multiresLevels)

    // Toolstack undo/redo of the add-level op.
    app.toolstack.undo()
    result.levelsAfterUndo = mesh.multiresLevels
    mesh.multiresSetLevel(preservedLevel)
    result.undoChecksum = fnv1a(dumpCoFlat(mesh))
    result.undoMatches = result.undoChecksum === result.preservedChecksum

    app.toolstack.redo()
    result.levelsAfterRedo = mesh.multiresLevels
    result.redoChecksum = fnv1a(dumpCoFlat(mesh))

    mesh.multiresDelete()
    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  return result
}

;(globalThis as {__multiresAddLevelTest?: typeof multiresAddLevelTest}).__multiresAddLevelTest = multiresAddLevelTest

export {
  multiresTest,
  multiresVdmTest,
  stencilAmplifyTest,
  vdmSculptTest,
  vdmPersistTest,
  multiresLayerTest,
  multiresAddLevelTest,
}
