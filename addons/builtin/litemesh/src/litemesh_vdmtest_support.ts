/**
 * Integration-test support for the VDM (vector-displacement-map) engine
 * (workstream V3 of documentation/plans/displacementAndSubSurf.md). Exposes
 * `globalThis.__vdmTest()`, driven by the NW.js headless harness via `--eval`
 * (see `tests/integration/sculptcore_vdm.test.ts`); the result is reflected
 * into the `--dump` JSON as `vdmtest`.
 *
 * On the spherified `litemesh-cube` scene it gives every face a UV chart
 * (`markAllSeams` + `generateUVFromSeams`), recomputes normals + F3 frames,
 * tags the whole mesh VDM-carried, creates a `VdmStore`, and splats one dab at
 * the +Z pole. Metrics: texels touched, tile count, an FNV-1a checksum over
 * the packed GPU atlas (the wasm↔native bit-parity gate), the 8 layout ints,
 * page-table occupancy, and the GPU position buffer before vs after the splat
 * — which must be UNCHANGED, since a VDM splat writes texels, not geometry.
 */

import {peekAppState} from '@framework/api'
import {LiteMesh} from './litemesh'
import {livePoleExtent, readGpuBuffer} from './litemesh_brushtest_support'

interface VdmTestResult {
  ok: boolean
  error?: string
  /** UV charts generateUVFromSeams produced (per-face unwrap; must be > 0). */
  charts?: number
  /** Sphere pole distance recovered from the position buffer. */
  poleZ?: number
  /** Dab radius used (0.35 x the pole distance). */
  radius?: number
  /** Texels the splat wrote (Mesh_vdmSplatDab return; must be > 0). */
  texelsTouched?: number
  /** VdmStore.tileCount() after the splat (must be > 0). */
  tileCount?: number
  /** The 8 gpuLayoutOut ints: [tile_size, resolution, grid, slots, atlas_tiles_x, atlas_tiles_y, atlas_w, atlas_h]. */
  layout?: number[]
  /** gpuLayoutOut's return value (slots; must equal layout[3]). */
  layoutSlots?: number
  /** Occupied (slot >= 0) entries in the gpuPageTableOut table (-1 = empty). */
  pageTableOccupied?: number
  /** Total page-table entry count. */
  pageTableSize?: number
  /** FNV-1a (32-bit) over the gpuAtlasPixelsOut float bytes (bit-stable). */
  atlasChecksum?: number
  /** Float count of the packed atlas. */
  atlasFloatCount?: number
  /** FNV-1a over the position buffer before the splat. */
  posChecksumBefore?: number
  /** FNV-1a over the position buffer after the splat (must equal before). */
  posChecksumAfter?: number
  /** Max |after - before| over render-vertex positions (must be 0). */
  posMaxResidual?: number
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

/** Minimal manager view for the bound-Vector out-param plumbing (mirrors
 * LiteMesh._intVecOut; the native manager additionally exposes the addon's
 * bulk vectorView, the O(1)-calls read path). */
interface VecManager {
  findVectorClass(n: string): {buildFullName(): string; findDefaultConstructor(): unknown}
  constructWith(c: unknown): unknown
  addon?: {vectorView(vec: unknown): ArrayBufferView | undefined}
}

/** Construct an empty bound Vector<elem> out-param + a numeric array reader. */
function numVecOut(mesh: LiteMesh, elem: 'int32' | 'float') {
  const wasm = mesh.wasm as unknown as {
    manager: VecManager
    getBoundVector(name: string, vec: never): ArrayLike<number>
  }
  const cls = wasm.manager.findVectorClass(elem)
  const vec = wasm.manager.constructWith(cls.findDefaultConstructor())
  const read = (): ArrayLike<number> => {
    // Native fast path: one bulk copy instead of a napi call per element.
    const view = wasm.manager.addon?.vectorView(vec)
    if (view) return view as unknown as ArrayLike<number>
    return wasm.getBoundVector(cls.buildFullName(), vec as never)
  }
  return {vec, read}
}

/** Structural view of the bound VdmStore's GPU-packing surface. */
interface VdmStoreBound {
  tileCount(): number
  gpuLayoutOut(out: never): number
  gpuPageTableOut(out: never): void
  gpuAtlasPixelsOut(out: never): void
}

function vdmTest(): VdmTestResult {
  const result: VdmTestResult = {ok: false}
  const g = globalThis as unknown as {
    __vdmTestResult?: VdmTestResult
  }
  try {
    const mesh = peekAppState()?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const wasm = mesh.wasm

    // Give every face a UV chart (the atlas parameterization the splat keys
    // on), then satisfy the splatter's frame + carrier prerequisites.
    ;(mesh.mesh as unknown as {markAllSeams(): void}).markAllSeams()
    result.charts = (mesh.mesh as unknown as {generateUVFromSeams(m: number): number}).generateUVFromSeams(20)
    wasm.Mesh_updateFrames(mesh.mesh)
    wasm.SpatialTree_fillDetailCarrier(mesh.spatial, 1)

    // Read positions only after all setup, so the UV layer's GPU re-batch
    // can't alias into the before/after diff.
    const before = readGpuBuffer(mesh, 'position')
    if (!before) throw new Error('pre-splat position buffer unreadable')
    // Live verts, not `before`: the leaf VBOs' slack slots carry stale
    // coordinates outside the mesh, which would put the splat dab off-surface.
    const R = livePoleExtent(mesh, 2)
    result.poleZ = R
    const radius = R * 0.35
    result.radius = radius
    result.posChecksumBefore = fnv1a(before)

    const store = wasm.VdmStore_new(512, 32)
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
      const sb = store as unknown as VdmStoreBound
      result.tileCount = sb.tileCount()

      const layoutOut = numVecOut(mesh, 'int32')
      result.layoutSlots = sb.gpuLayoutOut(layoutOut.vec as never)
      const lay = layoutOut.read()
      result.layout = Array.from({length: 8}, (_, i) => lay[i] | 0)

      const pageOut = numVecOut(mesh, 'int32')
      sb.gpuPageTableOut(pageOut.vec as never)
      const page = pageOut.read()
      result.pageTableSize = page.length
      let occupied = 0
      for (let i = 0; i < page.length; i++) {
        if (page[i] >= 0) occupied++
      }
      result.pageTableOccupied = occupied

      const atlasOut = numVecOut(mesh, 'float')
      sb.gpuAtlasPixelsOut(atlasOut.vec as never)
      const atlas = atlasOut.read()
      const f32 = atlas instanceof Float32Array ? atlas : Float32Array.from(atlas as ArrayLike<number>)
      result.atlasFloatCount = f32.length
      result.atlasChecksum = fnv1a(f32)

      const after = readGpuBuffer(mesh, 'position')
      if (!after) throw new Error('post-splat position buffer unreadable')
      result.posChecksumAfter = fnv1a(after)
      result.posMaxResidual = maxResidual(before, after)
    } finally {
      wasm.VdmStore_free(store)
    }

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__vdmTestResult = result
  return result
}

;(globalThis as {__vdmTest?: typeof vdmTest}).__vdmTest = vdmTest

export {vdmTest, numVecOut}
export type {VdmStoreBound}
