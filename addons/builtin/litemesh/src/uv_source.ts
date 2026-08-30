/**
 * LiteMesh as an `IUVSource` — P18 §5 step 2, implementor #2.
 *
 * Every read and write crosses into sculptcore, where attribute values are
 * paged behind `AttrData<T>` and unreachable one element at a time without a
 * round trip each. So this file is written against the bulk bound methods P18
 * added to the engine's `Mesh` (`uvGather`/`uvScatter`, the two CSR walks, and
 * the `.uvflags:<layer>` sidecar) — a whole call per query, never per element.
 *
 * A UV element here is a *corner* and its owner is the corner's *vertex*, so
 * `getUVOwners` is many-to-one, as on the grid double and unlike LeafMesh. A
 * seam is two corners of one vertex disagreeing about their UV, which is also
 * exactly what makes a fan smaller than the vertex's corner set.
 *
 * The layer numbering the interface uses is an index into `listUVLayers()`,
 * which is *not* the engine's `c.attrs` index: only FLOAT2 non-builtin corner
 * layers are UV layers. `layers()` carries both, and everything here goes
 * through it rather than assuming they coincide.
 */

import {ElementDomain, InvalidationKind} from '@framework/api'
import type {AssertExtends, ElementHandles, GeometryDataRef, IUVSource, IUVSourceProvider} from '@framework/api'

import {AttrUseFlags, LiteMesh} from './litemesh.js'
import {AttrType} from './litemesh_base.js'

/**
 * Domain codes for `selectedElems`/`liveElems`, which predate `AttrDomain` and
 * are dense (0 vert / 1 edge / 2 face / 3 corner) rather than bit flags.
 */
const SC_FACE = 2
const SC_CORNER = 3

/** UVs closer than this are one fan. Matches the welding tolerance elsewhere. */
const FAN_EPS = 1e-6

/**
 * The bound methods this adapter uses, declared here rather than taken off the
 * generated `WasmMesh`: the generator prints bound `Vector<T>` out-params as
 * `int32[]`/`float[]`, which they are not — they are opaque handles.
 */
interface MeshUVMethods {
  topoStamp(): number
  liveElems(domain: number, out: never): void
  selectedElems(domain: number, out: never): void
  uvCornerVerts(corners: never, out: never): void
  uvCornersOfVerts(verts: never, outOffsets: never, outValues: never): void
  uvFaceRings(faces: never, outOffsets: never, outValues: never): void
  uvGather(uvIndex: number, corners: never, out: never): void
  uvScatter(uvIndex: number, corners: never, uvs: never): void
  uvFlagsGather(uvIndex: number, corners: never, out: never): void
  uvFlagsScatter(uvIndex: number, corners: never, flags: never): void
}

/** `listUVLayers()` order alongside each layer's engine-side `c.attrs` index. */
interface UVLayers {
  names: string[]
  indices: number[]
}

function sizedI32(out: Int32Array | undefined, n: number): Int32Array {
  return out !== undefined && out.length >= n ? out.subarray(0, n) : new Int32Array(n)
}

function sizedF32(out: Float32Array | undefined, n: number): Float32Array {
  return out !== undefined && out.length >= n ? out.subarray(0, n) : new Float32Array(n)
}

function sizedU8(out: Uint8Array | undefined, n: number): Uint8Array {
  return out !== undefined && out.length >= n ? out.subarray(0, n) : new Uint8Array(n)
}

/** One row per handle, all empty — what an absent layer answers. */
function emptyCSR(rows: number): {offsets: Int32Array; values: Int32Array} {
  return {offsets: new Int32Array(rows + 1), values: new Int32Array(0)}
}

function toCSR(rows: number[][]): {offsets: Int32Array; values: Int32Array} {
  const offsets = new Int32Array(rows.length + 1)
  let total = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = total
    total += rows[i].length
  }
  offsets[rows.length] = total

  const values = new Int32Array(total)
  let n = 0
  for (const row of rows) {
    for (const v of row) {
      values[n++] = v
    }
  }
  return {offsets, values}
}

export class LiteMeshUVSource implements IUVSource {
  constructor(private readonly data: LiteMesh) {}

  private get mesh(): MeshUVMethods {
    return this.data.mesh as unknown as MeshUVMethods
  }

  /** A bound `Vector<int>` pre-filled with `data` — the JS→C++ direction. */
  private intVecIn(data: ArrayLike<number>) {
    const v = this.data._intVecOut()
    this.data.wasm.setBoundIntVector(v.vec as never, data)
    return v
  }

  /** The FLOAT2, non-builtin corner layers, in engine order. */
  private layers(): UVLayers {
    const out: UVLayers = {names: [], indices: []}
    const grp = (this.data.mesh as unknown as {c?: {attrs?: {attrs: unknown}}}).c?.attrs
    const cls = (
      this.data.wasm.manager as {findVectorClass(n: string): {buildFullName(): string} | undefined}
    ).findVectorClass('sculptcore::mesh::AttrRef')

    if (!grp || !cls) {
      return out
    }

    const arr = this.data.wasm.getBoundVector(cls.buildFullName(), grp.attrs as never) as ArrayLike<{
      name: string
      type: number
    }>
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].type === AttrType.Float2 && !LiteMesh.isBuiltinAttr(arr[i].name)) {
        out.names.push(arr[i].name)
        out.indices.push(i)
      }
    }
    return out
  }

  /** The engine-side `c.attrs` index a contract layer number means, or -1. */
  private columnOf(layer: number): number {
    const idx = this.layers().indices[layer]
    return idx === undefined ? -1 : idx
  }

  get topoStamp(): number {
    return this.mesh.topoStamp()
  }

  get uvDomain(): ElementDomain {
    return ElementDomain.CORNER
  }

  listUVLayers(): readonly string[] {
    return this.layers().names
  }

  /**
   * The active UV attr when there is one, else the first layer — a mesh with
   * UVs always has a layer the editor can open.
   */
  get activeUVLayer(): number {
    const {indices} = this.layers()
    if (indices.length === 0) {
      return -1
    }
    const i = indices.indexOf(this.data.activeAttrLayerIndex(AttrUseFlags.UV))
    return i < 0 ? 0 : i
  }

  listUVElements(layer: number, owners?: ElementHandles): Int32Array {
    if (this.columnOf(layer) < 0) {
      return new Int32Array(0)
    }

    if (owners !== undefined) {
      return this.cornersOfVerts(owners).values
    }

    const out = this.data._intVecOut()
    this.mesh.liveElems(SC_CORNER, out.vec as never)
    return Int32Array.from(out.read())
  }

  getUVOwners(_layer: number, handles: ElementHandles, out?: Int32Array): Int32Array {
    const ret = sizedI32(out, handles.length)
    const dst = this.data._intVecOut()
    this.mesh.uvCornerVerts(this.intVecIn(handles).vec as never, dst.vec as never)

    const src = dst.read()
    for (let i = 0; i < handles.length; i++) {
      ret[i] = src[i]
    }
    return ret
  }

  /**
   * Owner-vertex positions, object-local. Two engine calls, not one per element:
   * corners to their verts, then the verts' coordinates.
   */
  getUVElementPositions(_layer: number, handles: ElementHandles, out?: Float32Array): Float32Array {
    const ret = sizedF32(out, handles.length * 3)
    const verts = this.data._intVecOut()
    this.mesh.uvCornerVerts(this.intVecIn(handles).vec as never, verts.vec as never)

    const dst = this.data._floatVecOut()
    ;(this.data.mesh as unknown as {gatherVertCos(i: never, o: never): void}).gatherVertCos(
      verts.vec as never,
      dst.vec as never
    )

    const src = dst.read()
    for (let i = 0; i < ret.length; i++) {
      ret[i] = src[i]
    }
    return ret
  }

  getUVs(layer: number, handles: ElementHandles, out?: Float32Array): Float32Array {
    const ret = sizedF32(out, handles.length * 2)
    const col = this.columnOf(layer)
    if (col < 0) {
      ret.fill(0)
      return ret
    }

    const dst = this.data._floatVecOut()
    this.mesh.uvGather(col, this.intVecIn(handles).vec as never, dst.vec as never)

    const src = dst.read()
    for (let i = 0; i < handles.length * 2; i++) {
      ret[i] = src[i]
    }
    return ret
  }

  setUVs(layer: number, handles: ElementHandles, uv: Float32Array): void {
    const col = this.columnOf(layer)
    if (col < 0) {
      return
    }

    const uvs = this.data._floatVecOut()
    this.data.wasm.setBoundFloatVector(uvs.vec as never, uv)
    this.mesh.uvScatter(col, this.intVecIn(handles).vec as never, uvs.vec as never)
    this.data.invalidate(InvalidationKind.ATTRIBUTES)
  }

  getUVFlags(layer: number, handles: ElementHandles, out?: Uint8Array): Uint8Array {
    const ret = sizedU8(out, handles.length)
    const col = this.columnOf(layer)
    if (col < 0) {
      ret.fill(0)
      return ret
    }

    const dst = this.data._intVecOut()
    this.mesh.uvFlagsGather(col, this.intVecIn(handles).vec as never, dst.vec as never)

    const src = dst.read()
    for (let i = 0; i < handles.length; i++) {
      ret[i] = src[i]
    }
    return ret
  }

  setUVFlags(layer: number, handles: ElementHandles, flags: Uint8Array): void {
    const col = this.columnOf(layer)
    if (col < 0) {
      return
    }

    this.mesh.uvFlagsScatter(col, this.intVecIn(handles).vec as never, this.intVecIn(flags).vec as never)
    this.data.invalidate(InvalidationKind.SELECTION)
  }

  /** The corners of each of `verts`, CSR-style and row-aligned with the query. */
  private cornersOfVerts(verts: ElementHandles | {vec: unknown}): {offsets: Int32Array; values: Int32Array} {
    const src = 'vec' in verts ? verts : this.intVecIn(verts)
    const offsets = this.data._intVecOut()
    const values = this.data._intVecOut()
    this.mesh.uvCornersOfVerts(src.vec as never, offsets.vec as never, values.vec as never)
    return {offsets: Int32Array.from(offsets.read()), values: Int32Array.from(values.read())}
  }

  /**
   * A corner's fan is every corner of the same vertex carrying the same UV —
   * the welding rule, kept here rather than in C++ so `FAN_EPS` stays a host
   * policy the editor can reason about.
   */
  getUVFans(layer: number, handles: ElementHandles): {offsets: Int32Array; values: Int32Array} {
    const col = this.columnOf(layer)
    if (col < 0) {
      return emptyCSR(handles.length)
    }

    // The vert vector feeds straight back in as the CSR query, so the corner
    // indices never round-trip through JS.
    const verts = this.data._intVecOut()
    this.mesh.uvCornerVerts(this.intVecIn(handles).vec as never, verts.vec as never)
    const csr = this.cornersOfVerts(verts)

    const mine = this.getUVs(layer, handles)
    const theirs = this.getUVs(layer, csr.values)

    const rows: number[][] = []
    for (let i = 0; i < handles.length; i++) {
      const row: number[] = []
      for (let k = csr.offsets[i]; k < csr.offsets[i + 1]; k++) {
        const du = Math.abs(theirs[k * 2] - mine[i * 2])
        const dv = Math.abs(theirs[k * 2 + 1] - mine[i * 2 + 1])
        if (du <= FAN_EPS && dv <= FAN_EPS) {
          row.push(csr.values[k])
        }
      }
      rows.push(row)
    }
    return toCSR(rows)
  }

  listUVFaces(layer: number, selectedOnly = false): Int32Array {
    if (this.columnOf(layer) < 0) {
      return new Int32Array(0)
    }

    const out = this.data._intVecOut()
    if (selectedOnly) {
      this.mesh.selectedElems(SC_FACE, out.vec as never)
    } else {
      this.mesh.liveElems(SC_FACE, out.vec as never)
    }
    return Int32Array.from(out.read())
  }

  getUVFaceRings(layer: number, faces: ElementHandles): {offsets: Int32Array; values: Int32Array} {
    if (this.columnOf(layer) < 0) {
      return emptyCSR(faces.length)
    }

    const offsets = this.data._intVecOut()
    const values = this.data._intVecOut()
    this.mesh.uvFaceRings(this.intVecIn(faces).vec as never, offsets.vec as never, values.vec as never)
    return {offsets: Int32Array.from(offsets.read()), values: Int32Array.from(values.read())}
  }
}

/**
 * One adapter per data block, so the editor holding a source across a redraw
 * does not churn allocations. The mesh is read through the block on every call,
 * so a cached adapter never goes stale.
 */
const _sources = new WeakMap<LiteMesh, LiteMeshUVSource>()

export const LITEMESH_UV_PROVIDER: IUVSourceProvider = {
  kindId: 'litemesh',
  uiName: 'Lite Mesh',

  resolve(data: GeometryDataRef): IUVSource | undefined {
    if (!(data instanceof LiteMesh)) {
      return undefined
    }

    let source = _sources.get(data)
    if (source === undefined) {
      source = new LiteMeshUVSource(data)
      _sources.set(data, source)
    }
    return source
  },
}

export type _LiteMeshUVSourceIsUVSource = AssertExtends<LiteMeshUVSource, IUVSource>
