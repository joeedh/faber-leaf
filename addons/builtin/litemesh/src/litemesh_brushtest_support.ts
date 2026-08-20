/**
 * Integration-test support for sculptcore brush behavior. Exposes
 * `globalThis.__brushTest()`, which the NW.js headless harness drives from
 * `--eval` (see `tests/integration/sculptcore_brushes.test.ts`); the result is
 * reflected into the `--dump` JSON as `brushtest`.
 *
 * Runs scripted strokes (via `runSculptcoreStroke`) at the six axis poles of
 * the spherified `litemesh-cube` scene — the octahedral symmetry makes the
 * poles statistically equivalent, so displacement magnitudes are comparable
 * across scenarios. Geometry is observed through the GPU vertex buffers (the
 * backend-agnostic bulk-data seam; raw vertex `co` isn't JS-readable on
 * native), diffing the `position` buffer before/after each stroke and reading
 * the legacy `color` stream for paint.
 *
 * Covered behaviors (ImmediateTODOs): brush invert (forward vs inverted DRAW
 * displacement direction), draw-sharp boundedness, mask painting gating a
 * subsequent DRAW, inverted mask strokes erasing mask, `brush.color` reaching
 * the color kernel, and the accumulate-by-default brush flags.
 */

import {getAppState, peekAppState} from '@framework/api'
import {Vector4} from '../../../../scripts/path.ux/scripts/pathux.js'
import {BrushFlags, SculptTools} from '../../../../scripts/brush/brush_base'
import {DefaultBrushes, type SculptBrush} from '../../../../scripts/brush/index'
import {runSculptcoreStroke} from './sculptcore_ops'
import {AttrDomain, AttrUseFlags, LiteMesh} from './litemesh'
import {AttrType} from './litemesh_base'
import {SymmetrizeLiteMeshOp} from './litemesh_ops'

/** Displacement metrics for one stroke, from the position-buffer diff. */
interface StrokeMetrics {
  /** Largest per-render-vertex displacement length. */
  maxDisp: number
  /** Render-vertices that moved more than 1e-6. */
  movedCount: number
  /** Mean displacement component along the dab normal, over moved verts. */
  meanAlongNormal: number
  /** Mean displacement magnitude perpendicular to the dab normal, over moved
   * verts. ~0 for a pure along-normal brush (DRAW); a chained SMOOTH command
   * (autosmooth) moves verts toward neighbor averages and drives it positive. */
  meanPerp: number
  /** Buffer length mismatch / missing buffer — metrics invalid. */
  invalid?: string
}

interface BrushTestResult {
  ok: boolean
  error?: string
  /** Forward DRAW at +Z: meanAlongNormal must be > 0. */
  drawForward?: StrokeMetrics
  /** Inverted DRAW at -Z: meanAlongNormal must be < 0 (digs inward). */
  drawInverted?: StrokeMetrics
  /** SHARP at +X: maxDisp must stay well under the brush radius. */
  sharp?: StrokeMetrics
  /** DRAW at -X after saturating mask there: movedCount/maxDisp ≈ 0. */
  drawMasked?: StrokeMetrics
  /** DRAW at +Y after mask paint + inverted mask erase: ≈ drawForward. */
  drawMaskErased?: StrokeMetrics
  /** Inverted SMOOTH at -Y: invert is ignored, must stay bounded. */
  smoothInverted?: StrokeMetrics
  /** KELVINLET grab at +Z with dabs moving +X: pulls verts along +X, bounded. */
  kelvinlet?: StrokeMetrics
  /** GRAB at +Z with dabs moving +X: drags verts along +X, bounded. */
  grab?: StrokeMetrics
  /** SNAKEHOOK at +Z with dabs moving +X: drags + gathers along +X, bounded. */
  snakehook?: StrokeMetrics
  /** Accumulating DRAW at an octant with autosmooth=0 — the un-smoothed bump. */
  autosmoothOff?: StrokeMetrics
  /** Same DRAW at the opposite octant with high autosmooth — flatter peak. */
  autosmoothOn?: StrokeMetrics
  /** Color paint at +Z (after the draw): per-channel means over painted verts. */
  color?: {paintedCount: number; meanR: number; meanG: number; meanB: number; invalid?: string}
  /** Two COLOR layers, second active: only the active layer may change
   * (changedB > 0, changedA === 0). -1 means the layer was unreadable. */
  colorLayerTarget?: {layerA: number; layerB: number; activeIdx: number; changedA: number; changedB: number}
  /** ACCUMULATE default flag per tool (smooth/bsmooth/paint-smooth/inflate/clay). */
  accumulateDefaults?: Record<string, boolean>
  /** Symmetric X DRAW dab off-center: both X-sides move, roughly balanced. */
  symMirrorX?: {movedPos: number; movedNeg: number; maxDisp: number; invalid?: string}
  /** Symmetric X+Y+Z DRAW dab from one octant: moved verts cover all 8 octants. */
  symOctants?: {octantsCovered: number; movedCount: number; invalid?: string}
  /** Plain (no symmetry) off-center DRAW dab: only the dab's own X-side moves. */
  symPlainX?: {movedPos: number; movedNeg: number; maxDisp: number; invalid?: string}
  /** Symmetrize op about X: position-mirror miss-fraction before vs after (after ≈ 0). */
  symmetrize?: {
    /** Pristine-scene control: the live vertex set must already be
     * mirror-symmetric at the cell size, or the metric premise is void. */
    missPristine: number
    missBefore: number
    missAfter: number
  }
  /** Non-finite floats in the final position buffer (must be 0). */
  nonFiniteCount?: number
  radius?: number
}

/** Minimal structural view of the IWasmInterface bits the buffer reads need
 * (mirrors test_harness.ts's DumpWasm; HEAPU8 present ⇒ WASM, absent ⇒ native). */
interface BufWasm {
  HEAPU8?: {buffer: ArrayBufferLike}
  gpu: Record<string, unknown>
  getBoundVector(name: string, vec: unknown): ArrayLike<unknown>
  pointerBytes?(bound: unknown, member: string, byteLen: number): Uint8Array | undefined
}
interface BufDesc {
  size: number
  elemsize: number
  name?: string
  data?: number
}

/**
 * Concatenate every GPU vertex buffer named `name` (after refreshing via
 * spatial.update). The GPU stream is split into per-batch buffers that share a
 * name, so reading just the first would cover only part of the mesh; vector
 * order is deterministic, so the concatenation diffs stably across strokes.
 */
function readGpuBuffer(lm: LiteMesh, name: string): Float32Array | undefined {
  const wasm = lm.wasm as unknown as BufWasm
  const spatial = lm.spatial as unknown as {update?: (gpu: unknown) => void}
  spatial.update?.(wasm.gpu)
  const buffersVec = (wasm.gpu as {buffers?: unknown}).buffers
  const buffers =
    wasm.HEAPU8 !== undefined
      ? (buffersVec as ArrayLike<BufDesc>)
      : (wasm.getBoundVector('', buffersVec) as ArrayLike<BufDesc>)
  const parts: Float32Array[] = []
  let total = 0
  for (let i = 0; i < (buffers.length | 0); i++) {
    const buf = buffers[i]
    if (!buf || buf.name !== name || !(buf.size | 0) || !(buf.elemsize | 0)) continue
    const floatCount = (buf.size | 0) * (buf.elemsize | 0)
    const bytes = floatCount * 4
    let u8: Uint8Array | undefined
    if (wasm.HEAPU8 !== undefined) {
      u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data as number, bytes)
    } else {
      u8 = wasm.pointerBytes?.(buf, 'data', bytes)
    }
    if (!u8 || u8.length < bytes) return undefined
    // Copy — the underlying buffers are reused/rebuilt across strokes.
    parts.push(new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + bytes)))
    total += floatCount
  }
  if (!parts.length) return undefined
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function diffMetrics(before: Float32Array | undefined, after: Float32Array | undefined, n: number[]): StrokeMetrics {
  const m: StrokeMetrics = {maxDisp: 0, movedCount: 0, meanAlongNormal: 0, meanPerp: 0}
  if (!before || !after) {
    m.invalid = 'position buffer unreadable'
    return m
  }
  if (before.length !== after.length) {
    m.invalid = `length changed ${before.length} -> ${after.length}`
    return m
  }
  const nl = Math.hypot(n[0], n[1], n[2]) || 1
  const nx = n[0] / nl
  const ny = n[1] / nl
  const nz = n[2] / nl
  let alongSum = 0
  let perpSum = 0
  for (let i = 0; i < before.length; i += 3) {
    const dx = after[i] - before[i]
    const dy = after[i + 1] - before[i + 1]
    const dz = after[i + 2] - before[i + 2]
    const d = Math.hypot(dx, dy, dz)
    if (d > 1e-6) {
      m.movedCount++
      const along = dx * nx + dy * ny + dz * nz
      alongSum += along
      perpSum += Math.hypot(dx - along * nx, dy - along * ny, dz - along * nz)
      if (d > m.maxDisp) m.maxDisp = d
    }
  }
  m.meanAlongNormal = m.movedCount > 0 ? alongSum / m.movedCount : 0
  m.meanPerp = m.movedCount > 0 ? perpSum / m.movedCount : 0
  return m
}

/**
 * Side-balance of a stroke about the plane `axis = 0`: counts moved
 * render-vertices on the positive and negative side of the plane (classified by
 * the *before* position), with the largest displacement. A symmetric stroke
 * moves both sides (≈ balanced counts); a plain stroke moves only the dab's own
 * side. `eps` is the on-plane dead-zone (verts with |coord| ≤ eps are ignored).
 */
function mirrorBalance(
  before: Float32Array | undefined,
  after: Float32Array | undefined,
  axis: number,
  eps: number
): {movedPos: number; movedNeg: number; maxDisp: number; invalid?: string} {
  const out = {movedPos: 0, movedNeg: 0, maxDisp: 0}
  if (!before || !after || before.length !== after.length) {
    return {...out, invalid: 'position buffer unreadable/resized'}
  }
  for (let i = 0; i < before.length; i += 3) {
    const dx = after[i] - before[i]
    const dy = after[i + 1] - before[i + 1]
    const dz = after[i + 2] - before[i + 2]
    const d = Math.hypot(dx, dy, dz)
    if (d <= 1e-6) continue
    const s = before[i + axis]
    if (s > eps) out.movedPos++
    else if (s < -eps) out.movedNeg++
    if (d > out.maxDisp) out.maxDisp = d
  }
  return out
}

/**
 * Octant coverage of a stroke: how many of the 8 sign-octants contain at least
 * one moved render-vertex (classified by the *before* position). A symmetric
 * X+Y+Z stroke from one octant mirrors into all 8. Verts on a plane (within
 * `eps`) have an ambiguous octant and are skipped.
 */
function octantCoverage(
  before: Float32Array | undefined,
  after: Float32Array | undefined,
  eps: number
): {octantsCovered: number; movedCount: number; invalid?: string} {
  if (!before || !after || before.length !== after.length) {
    return {octantsCovered: 0, movedCount: 0, invalid: 'position buffer unreadable/resized'}
  }
  const seen = new Set<number>()
  let moved = 0
  for (let i = 0; i < before.length; i += 3) {
    const dx = after[i] - before[i]
    const dy = after[i + 1] - before[i + 1]
    const dz = after[i + 2] - before[i + 2]
    if (Math.hypot(dx, dy, dz) <= 1e-6) continue
    moved++
    const ox = before[i] > eps ? 1 : before[i] < -eps ? 0 : -1
    const oy = before[i + 1] > eps ? 1 : before[i + 1] < -eps ? 0 : -1
    const oz = before[i + 2] > eps ? 1 : before[i + 2] < -eps ? 0 : -1
    if (ox < 0 || oy < 0 || oz < 0) continue
    seen.add((ox << 2) | (oy << 1) | oz)
  }
  return {octantsCovered: seen.size, movedCount: moved}
}

/**
 * Fraction of render-vertices whose mirror image about the plane `axis = 0` is
 * absent from the quantized position set — ~0 for a mesh symmetric across that
 * plane, positive when one side has been deformed independently. `cell` is the
 * quantization tolerance.
 */
function posMissFrac(pos: Float32Array | undefined, axis: number, cell: number): number {
  if (!pos || pos.length === 0) return 1
  const q = (v: number) => Math.round(v / cell)
  // Fractions over UNIQUE quantized cells, not raw render vertices: the GPU
  // position buffer duplicates verts per spatial leaf, so a raw-vertex ratio
  // shifts with leaf layout (defrag, tree params) with zero deform change.
  const set = new Set<string>()
  for (let i = 0; i < pos.length; i += 3) {
    set.add(`${q(pos[i])},${q(pos[i + 1])},${q(pos[i + 2])}`)
  }
  let miss = 0
  for (const key of set) {
    const c = key.split(',').map(Number)
    c[axis] = -c[axis]
    if (!set.has(`${c[0]},${c[1]},${c[2]}`)) miss++
  }
  return set.size ? miss / set.size : 1
}

/** Flat xyz of the LIVE mesh vertices (`dumpVertCo`) — the symmetry metric
 * must NOT read the raw leaf VBOs: those duplicate verts per leaf and carry
 * dead slack slots with stale positions, which both skew the miss fraction
 * (layout-dependently) and add a phantom always-miss population. */
function dumpLiveCo(lm: LiteMesh): Float32Array {
  const {co} = lm.dumpVertCo()
  const out = new Float32Array(co.length * 3)
  for (let i = 0; i < co.length; i++) {
    out[i * 3] = co[i][0]
    out[i * 3 + 1] = co[i][1]
    out[i * 3 + 2] = co[i][2]
  }
  return out
}

/**
 * Largest live-vertex coordinate along `axis` — the scene's pole distance, used
 * to place scripted dabs on the surface. Reads the live verts, never the leaf
 * VBOs: their slack slots hold stale coordinates far outside the mesh, and a
 * pole distance taken from those puts every dab off the surface (silently
 * measuring "no displacement" for brushes that work fine).
 */
export function livePoleExtent(lm: LiteMesh, axis = 2): number {
  const co = dumpLiveCo(lm)
  let r = 0
  for (let i = axis; i < co.length; i += 3) {
    if (co[i] > r) r = co[i]
  }
  return r
}

/**
 * Run a single off-center DRAW dab (optionally mirrored by `symmetryAxes`,
 * forwarded to `runSculptcoreStroke`) and return the position buffers before and
 * after. Non-accumulating, full strength; restores the brush afterward.
 */
function runSymDraw(
  mesh: LiteMesh,
  draw: SculptBrush,
  p: number[],
  normal: number[],
  radius: number,
  symmetryAxes: number
): {before: Float32Array | undefined; after: Float32Array | undefined} {
  const saved = {tool: draw.tool, strength: draw.strength, flag: draw.flag}
  draw.tool = SculptTools.DRAW
  draw.strength = 1
  draw.flag &= ~BrushFlags.ACCUMULATE
  const before = readGpuBuffer(mesh, 'position')
  runSculptcoreStroke({mesh, brush: draw, dabs: [{p, normal}], radius, symmetryAxes})
  const after = readGpuBuffer(mesh, 'position')
  draw.tool = saved.tool
  draw.strength = saved.strength
  draw.flag = saved.flag
  return {before, after}
}

/** Run one stroke and return the position-buffer displacement metrics. */
function strokeAndMeasure(
  mesh: LiteMesh,
  brush: SculptBrush,
  tool: SculptTools,
  p: number[],
  normal: number[],
  radius: number,
  opts: {dabs?: number; invert?: boolean; strength?: number} = {}
): StrokeMetrics {
  const saved = {tool: brush.tool, strength: brush.strength}
  brush.tool = tool
  if (opts.strength !== undefined) brush.strength = opts.strength
  const before = readGpuBuffer(mesh, 'position')
  const dabs = Array.from({length: opts.dabs ?? 1}, () => ({p, normal}))
  runSculptcoreStroke({mesh, brush, dabs, radius, invert: opts.invert ?? false})
  const after = readGpuBuffer(mesh, 'position')
  brush.tool = saved.tool
  brush.strength = saved.strength
  return diffMetrics(before, after, normal)
}

/**
 * Run a *moving* grab-style stroke (kelvinlet/grab/snakehook) and return the
 * displacement metrics projected onto +X. Grab brushes need moving dabs —
 * `grabTo` is the per-dab displacement, zero until the brush moves — so this
 * marches `dabCount` dabs along +X near the +Z pole and measures how far the
 * surface follows. `axis = [1,0,0]` makes `meanAlongNormal` the mean pull in
 * the stroke direction.
 */
function grabStrokeAndMeasure(
  mesh: LiteMesh,
  brush: SculptBrush,
  tool: SculptTools,
  R: number,
  radius: number
): StrokeMetrics {
  const step = radius * 0.3
  const dabs = [
    {p: [0, 0, R], normal: [0, 0, 1]},
    {p: [step, 0, R], normal: [0, 0, 1]},
    {p: [step * 2, 0, R], normal: [0, 0, 1]},
  ]
  const saved = {tool: brush.tool, strength: brush.strength}
  brush.tool = tool
  brush.strength = 1
  const before = readGpuBuffer(mesh, 'position')
  runSculptcoreStroke({mesh, brush, dabs, radius})
  const after = readGpuBuffer(mesh, 'position')
  brush.tool = saved.tool
  brush.strength = saved.strength
  return diffMetrics(before, after, [1, 0, 0])
}

/**
 * Build a tall accumulating DRAW bump with a fixed `autosmooth` value and return
 * its displacement metrics. Verifies the autosmooth pipeline: `buildBrushProgram`
 * chains a SMOOTH command after the main DRAW when `brush.autosmooth > 0`, and
 * the executor re-snapshots `co_prev` so SMOOTH flattens the just-deformed
 * surface. ACCUMULATE + multiple dabs grow a sharp bump so the smoothing effect
 * (lower peak) is unambiguous across both backends.
 */
function drawAutosmoothAndMeasure(
  mesh: LiteMesh,
  draw: SculptBrush,
  p: number[],
  normal: number[],
  radius: number,
  autosmooth: number
): StrokeMetrics {
  const saved = {tool: draw.tool, strength: draw.strength, autosmooth: draw.autosmooth, flag: draw.flag}
  draw.tool = SculptTools.DRAW
  draw.strength = 0.5
  draw.autosmooth = autosmooth
  draw.flag |= BrushFlags.ACCUMULATE // pile dabs into a tall bump for a clear signal
  const before = readGpuBuffer(mesh, 'position')
  const dabs = Array.from({length: 6}, () => ({p, normal}))
  runSculptcoreStroke({mesh, brush: draw, dabs, radius})
  const after = readGpuBuffer(mesh, 'position')
  draw.tool = saved.tool
  draw.strength = saved.strength
  draw.autosmooth = saved.autosmooth
  draw.flag = saved.flag
  return diffMetrics(before, after, normal)
}

function brushTest(): BrushTestResult {
  const result: BrushTestResult = {ok: false}
  try {
    const mesh = peekAppState()?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const slotMap = DefaultBrushes.slotMap
    const need = (tool: number): SculptBrush => {
      if (slotMap[tool]) {
        return slotMap[tool]
      }
      throw new Error(`no default brush for tool ${tool}`)
    }

    // The litemesh-cube scene is a spherified cube of half-extent `size` —
    // recover the actual pole distance from the LIVE vertices. The GPU position
    // buffer must not be used: its per-leaf slack slots hold stale coordinates
    // well outside the mesh, which inflates the pole distance and pushes every
    // scripted dab off the surface (same reason posMissFrac reads dumpVertCo).
    const pos0 = readGpuBuffer(mesh, 'position')
    if (!pos0) throw new Error('position buffer unreadable')
    const R = livePoleExtent(mesh, 2)
    const radius = R * 0.25
    result.radius = radius

    // Pristine (symmetric) snapshot, captured before any stroke deforms the mesh.
    // The symmetrize sub-test (Part B) restores this and applies a clean one-sided
    // deformation, so nearest-source mirroring can reproduce it near-exactly.
    const pristine = mesh.serialize()

    // ACCUMULATE defaults (pure flag check, no strokes).
    result.accumulateDefaults = {
      smooth     : !!(need(SculptTools.SMOOTH).flag & BrushFlags.ACCUMULATE),
      bsmooth    : !!(need(SculptTools.BSMOOTH).flag & BrushFlags.ACCUMULATE),
      paintSmooth: !!(need(SculptTools.PAINT_SMOOTH).flag & BrushFlags.ACCUMULATE),
      inflate    : !!(need(SculptTools.INFLATE).flag & BrushFlags.ACCUMULATE),
      clay       : !!(need(SculptTools.CLAY).flag & BrushFlags.ACCUMULATE),
    }

    const draw = need(SculptTools.DRAW)

    // The first stroke triggers a GPU re-batch (the buffer set changes length),
    // so run a zero-strength warmup to settle the layout before measuring.
    strokeAndMeasure(mesh, draw, SculptTools.DRAW, [0, 0, R], [0, 0, 1], radius, {strength: 0})

    // Forward DRAW at the +Z pole — verts move outward along the dab normal.
    result.drawForward = strokeAndMeasure(mesh, draw, SculptTools.DRAW, [0, 0, R], [0, 0, 1], radius, {strength: 1})

    // Inverted DRAW at the -Z pole — must dig inward (negative along normal).
    result.drawInverted = strokeAndMeasure(mesh, draw, SculptTools.DRAW, [0, 0, -R], [0, 0, -1], radius, {
      strength: 1,
      invert  : true,
    })

    // SHARP at +X — regression for the absolute-step explosion: displacement
    // must stay well under the brush radius.
    result.sharp = strokeAndMeasure(mesh, need(SculptTools.SHARP), SculptTools.SHARP, [R, 0, 0], [1, 0, 0], radius, {
      strength: 1,
      dabs    : 3,
    })

    // Mask gate at -X: saturate the mask, then DRAW inside the masked disk —
    // displacement must collapse vs drawForward.
    const maskBrush = need(SculptTools.MASK_PAINT)
    strokeAndMeasure(mesh, maskBrush, SculptTools.MASK_PAINT, [-R, 0, 0], [-1, 0, 0], radius, {strength: 1, dabs: 5})
    result.drawMasked = strokeAndMeasure(mesh, draw, SculptTools.DRAW, [-R, 0, 0], [-1, 0, 0], radius * 0.6, {
      strength: 1,
    })

    // Mask erase at +Y: paint mask, erase it with an inverted mask stroke,
    // then DRAW — displacement must come back (≈ drawForward).
    strokeAndMeasure(mesh, maskBrush, SculptTools.MASK_PAINT, [0, R, 0], [0, 1, 0], radius, {strength: 1, dabs: 5})
    strokeAndMeasure(mesh, maskBrush, SculptTools.MASK_PAINT, [0, R, 0], [0, 1, 0], radius, {
      strength: 1,
      dabs    : 7,
      invert  : true,
    })
    result.drawMaskErased = strokeAndMeasure(mesh, draw, SculptTools.DRAW, [0, R, 0], [0, 1, 0], radius * 0.6, {
      strength: 1,
    })

    // Inverted SMOOTH at -Y: smooth ignores invert; must stay bounded (no
    // divergent anti-Laplacian blow-up).
    result.smoothInverted = strokeAndMeasure(
      mesh,
      need(SculptTools.SMOOTH),
      SculptTools.SMOOTH,
      [0, -R, 0],
      [0, -1, 0],
      radius,
      {strength: 1, dabs: 3, invert: true}
    )

    // Grab-style brushes need *moving* dabs (see grabStrokeAndMeasure). Each
    // marches along +X near the +Z pole and must pull the surface along +X
    // while staying bounded (no elastic/pinch blow-up).
    result.kelvinlet = grabStrokeAndMeasure(mesh, need(SculptTools.KELVINLET), SculptTools.KELVINLET, R, radius)
    result.grab = grabStrokeAndMeasure(mesh, need(SculptTools.GRAB), SculptTools.GRAB, R, radius)
    result.snakehook = grabStrokeAndMeasure(mesh, need(SculptTools.SNAKE), SculptTools.SNAKE, R, radius)

    // Autosmooth pipeline: the same accumulating DRAW at two symmetric octant
    // centers (well clear of the six axis poles used above), once with
    // autosmooth off and once high. The chained SMOOTH command must flatten the
    // bump, so the high-autosmooth peak displacement is measurably lower.
    const oct = R / Math.sqrt(3)
    const s3 = 1 / Math.sqrt(3)
    result.autosmoothOff = drawAutosmoothAndMeasure(mesh, draw, [oct, oct, oct], [s3, s3, s3], radius, 0)
    result.autosmoothOn = drawAutosmoothAndMeasure(mesh, draw, [-oct, -oct, -oct], [-s3, -s3, -s3], radius, 0.9)

    // Color paint back at +Z (deform-independent): paint a green-dominant color
    // and read the legacy composited `color` stream. The old kernel hardcoded
    // red, so meanG > meanR is the brush.color-piping regression signal.
    const colorBrush = need(SculptTools.COLOR)
    if (mesh.activeAttrLayerIndex(AttrUseFlags.COLOR) < 0) {
      mesh.addAttr(AttrDomain.VERTEX, AttrType.Float4, AttrUseFlags.COLOR)
    }
    const savedColor = new Vector4(colorBrush.color)
    colorBrush.color.loadXYZW(0.1, 0.9, 0.3, 1.0)
    const colBefore = readGpuBuffer(mesh, 'color')
    strokeAndMeasure(mesh, colorBrush, SculptTools.COLOR, [0, 0, R], [0, 0, 1], radius, {strength: 1, dabs: 3})
    const colAfter = readGpuBuffer(mesh, 'color')
    colorBrush.color.load(savedColor)
    if (!colBefore || !colAfter || colBefore.length !== colAfter.length) {
      result.color = {paintedCount: 0, meanR: 0, meanG: 0, meanB: 0, invalid: 'color buffer unreadable/resized'}
    } else {
      let painted = 0
      let sr = 0
      let sg = 0
      let sb = 0
      for (let i = 0; i < colAfter.length; i += 4) {
        const dr = Math.abs(colAfter[i] - colBefore[i])
        const dg = Math.abs(colAfter[i + 1] - colBefore[i + 1])
        const db = Math.abs(colAfter[i + 2] - colBefore[i + 2])
        if (dr + dg + db > 0.05) {
          painted++
          sr += colAfter[i]
          sg += colAfter[i + 1]
          sb += colAfter[i + 2]
        }
      }
      result.color = {
        paintedCount: painted,
        meanR       : painted ? sr / painted : 0,
        meanG       : painted ? sg / painted : 0,
        meanB       : painted ? sb / painted : 0,
      }
    }

    // Attr retargeting: with two COLOR layers, a paint stroke must land on the
    // ACTIVE one only. The kernel's `color` handle is `@use(color)`, so the
    // bridge resolves it through resolveDabPolicy(...).attrs ->
    // activeAttrLayerIndex(COLOR) — never a hardcoded layer 0.
    {
      const layerA = mesh.addAttr(AttrDomain.VERTEX, AttrType.Float4, AttrUseFlags.COLOR)
      const layerB = mesh.addAttr(AttrDomain.VERTEX, AttrType.Float4, AttrUseFlags.COLOR)
      // addAttr activates each layer as it lands, so B is the active target.
      const activeIdx = mesh.activeAttrLayerIndex(AttrUseFlags.COLOR)
      // The GPU color stream is filled from the display attr; point it at one
      // layer at a time to read them independently (setDisplayColorAttr flags
      // every leaf, and readGpuBuffer's spatial.update refills them).
      const readLayer = (idx: number): Float32Array | undefined => {
        mesh.spatial.setDisplayColorAttr(idx)
        return readGpuBuffer(mesh, 'color')
      }
      const aBefore = readLayer(layerA)
      const bBefore = readLayer(layerB)

      const savedTargetColor = new Vector4(colorBrush.color)
      colorBrush.color.loadXYZW(0.9, 0.2, 0.2, 1.0)
      mesh.spatial.setDisplayColorAttr(activeIdx)
      strokeAndMeasure(mesh, colorBrush, SculptTools.COLOR, [0, -R, 0], [0, -1, 0], radius, {
        strength: 1,
        dabs    : 3,
      })
      colorBrush.color.load(savedTargetColor)

      const aAfter = readLayer(layerA)
      const bAfter = readLayer(layerB)
      mesh.spatial.setDisplayColorAttr(activeIdx)

      const changedCount = (before: Float32Array | undefined, after: Float32Array | undefined): number => {
        if (!before || !after || before.length !== after.length) return -1
        let n = 0
        for (let i = 0; i < after.length; i += 4) {
          const d =
            Math.abs(after[i] - before[i]) +
            Math.abs(after[i + 1] - before[i + 1]) +
            Math.abs(after[i + 2] - before[i + 2])
          if (d > 0.05) n++
        }
        return n
      }

      result.colorLayerTarget = {
        layerA,
        layerB,
        activeIdx,
        changedA: changedCount(aBefore, aAfter),
        changedB: changedCount(bBefore, bAfter),
      }
    }

    // Symmetry (Part A of the mirror plan): a stroke driven with `symmetryAxes`
    // is replayed at its SymAxisMap mirror images. Run at end-of-test so these
    // off-pole strokes never perturb the differential measurements above.
    const eps = R * 0.02
    const sd = (() => {
      const v = [0.62, 0.31, 0.72]
      const l = Math.hypot(v[0], v[1], v[2])
      return [v[0] / l, v[1] / l, v[2] / l]
    })()
    const sp = [sd[0] * R, sd[1] * R, sd[2] * R]
    // Symmetric X: the off-center dab and its X-mirror move both X-halves.
    {
      const {before, after} = runSymDraw(mesh, draw, sp, sd, radius, 1)
      result.symMirrorX = mirrorBalance(before, after, 0, eps)
    }
    // Symmetric X+Y+Z: the +++ octant dab mirrors into all 8 octants.
    {
      const {before, after} = runSymDraw(mesh, draw, sp, sd, radius, 7)
      result.symOctants = octantCoverage(before, after, eps)
    }
    // Plain (no symmetry): the same-sided dab moves only its own X-half.
    {
      const sp2 = [sd[0] * R, -sd[1] * R, sd[2] * R]
      const {before, after} = runSymDraw(mesh, draw, sp2, [sd[0], -sd[1], sd[2]], radius, 0)
      result.symPlainX = mirrorBalance(before, after, 0, eps)
    }

    // Symmetrize op (Part B): restore the pristine symmetric sphere, deform ONLY
    // the +X half with a clean DRAW (so -X stays pristine), then run the real
    // (destructive) `litemesh.symmetrize` op (keep +X, bisect, mirror onto -X,
    // weld the seam) through the toolstack. It bisects/deletes/mirrors topology,
    // so the result is exactly symmetric: the position-mirror miss-fraction must
    // drop from clearly nonzero to ~0.
    mesh._replaceMesh(mesh.wasm.Mesh_deserialize(pristine))
    // Settle the GPU buffer layout after swapping in the fresh mesh handle.
    strokeAndMeasure(mesh, draw, SculptTools.DRAW, [R, 0, 0], [1, 0, 0], radius, {strength: 0})
    // Gentle one-sided deform: clears the quantization cell so missBefore is
    // clearly nonzero; the destructive op then mirrors +X exactly onto -X.
    // All three metrics run on the LIVE vertex set (dumpLiveCo), with the
    // pristine control validating the premise (scene symmetric at this cell).
    const cell = R * 5e-3
    const missPristine = posMissFrac(dumpLiveCo(mesh), 0, cell)
    strokeAndMeasure(mesh, draw, SculptTools.DRAW, [R, 0, 0], [1, 0, 0], radius, {strength: 0.3})
    const missBefore = posMissFrac(dumpLiveCo(mesh), 0, cell)
    const symOp = new SymmetrizeLiteMeshOp()
    symOp.inputs.axes.setValue(1) // X
    symOp.inputs.direction.setValue(1) // POSITIVE: keep +X, mirror onto -X
    const app = getAppState()
    app.toolstack.execTool(app.ctx, symOp)
    const missAfter = posMissFrac(dumpLiveCo(mesh), 0, cell)
    result.symmetrize = {missPristine, missBefore, missAfter}

    // Final sanity: no NaN/Inf anywhere in the position buffer.
    const posEnd = readGpuBuffer(mesh, 'position')
    let bad = 0
    if (posEnd) {
      for (let i = 0; i < posEnd.length; i++) {
        if (!Number.isFinite(posEnd[i])) bad++
      }
    }
    result.nonFiniteCount = bad
    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  ;(globalThis as {__brushTestResult?: BrushTestResult}).__brushTestResult = result
  return result
}

;(globalThis as {__brushTest?: typeof brushTest}).__brushTest = brushTest

export {brushTest, readGpuBuffer}
