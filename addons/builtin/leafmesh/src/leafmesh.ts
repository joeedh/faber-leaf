/**
 * The LeafMesh DataBlock — P11 step 2.
 *
 * `topo.ts` is the geometry; this file is everything the host is allowed to ask
 * of it. The split is load-bearing: `topo.ts` and its neighbours import nothing
 * from `scripts/`, so the headless library stays testable in plain jest, and
 * every host type is confined to this module and the ones after it.
 *
 * Conformance is asserted at the bottom of the file rather than described here.
 * `AssertExtends` against P7's interfaces is the point of the exercise — if a
 * capability listed in {@link LEAFMESH_CAPABILITIES} stops compiling against
 * its interface, the descriptor is lying to the host and the build says so.
 *
 * Two vocabularies meet here and are deliberately *not* converted between:
 * `ElementDomain`/`AttrType` (host) and `Domain`/`AttrType` (leafmesh) share
 * their numbering by design, so a layer round-trips as a column copy rather
 * than a translation. `tests/unit/leafmesh/contract_vocabulary.test.ts` pins
 * the agreement; the casts below are only safe because it does.
 */

import {
  ElementDomain,
  GeometryCapability,
  InvalidationKind,
  Matrix4,
  SceneObjectData,
  SelMask,
  Vector3,
} from '@framework/api'
import type {
  AssertExtends,
  AttrType as HostAttrType,
  DataBlock,
  ElementHandle,
  ElementHandles,
  IActiveElementSource,
  IAttributeLayerInfo,
  IAttributeSource,
  IDataDefine,
  IElementSource,
  IGeometrySource,
  IInvalidatable,
  IMaterialAttrConsumer,
  ISpatialQueryable,
  ISymmetryAware,
  ITriangleSource,
  MaterialAttrRequest,
  DrawQueue,
  FindNearestRet,
  FrameContext,
  SceneObject,
  ScreenPickResult,
  Vector2,
  View3D,
  ViewContext,
} from '@framework/api'
import {DataAPI, DataStruct, nstructjs} from '@framework/pathux'

import {AttrFlags, AttrType, DOMAIN_COUNT, Domain} from './attrs.js'
import {LeafMeshDrawable} from './draw.js'
import {ELEM_NONE} from './elem_array.js'
import * as pick from './pick.js'
import {deserializeLeafMesh, serializeLeafMesh} from './serialize.js'
/**
 * Selection lives in an ordinary attribute layer, one per domain, created the
 * first time it is written. That keeps it out of `topo.ts` — selection is a
 * host concept — and the layer persists with every other column.
 */
import {SELECT_ATTR} from './select_geom.js'
import {LeafMesh} from './topo.js'
import {TriangulationCache, triangulateMesh} from './triangulate.js'

/** Bit per axis, matching {@link ISymmetryAware.symmetryAxes}. */
export const LeafMeshSymmetry = {
  X: 1,
  Y: 2,
  Z: 4,
}

/** Same numbers, different nominal enum — see this file's header. */
function toDomain(domain: ElementDomain): Domain {
  return domain as unknown as Domain
}

function toHostDomain(domain: Domain): ElementDomain {
  return domain as unknown as ElementDomain
}

function toHostAttrType(type: AttrType): HostAttrType {
  return type as unknown as HostAttrType
}

function sizedI32(out: Int32Array | undefined, n: number): Int32Array {
  return out !== undefined && out.length >= n ? out.subarray(0, n) : new Int32Array(n)
}

export class LeafMeshData extends SceneObjectData implements IMaterialAttrConsumer {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
leafmesh.LeafMeshData {
  _data        : arraybuffer(byte) | this.serialize();
  symmetryAxes : int;
}`
  )

  /**
   * The geometry. Reassignable rather than `readonly` because both `copy()` and
   * the loader replace the whole mesh, and a per-element re-import would defeat
   * `LeafMesh.copy()`'s column-wise clone.
   */
  mesh = new LeafMesh()

  /** Per-face triangle memo; keyed on `mesh.topoStamp`, so it self-invalidates. */
  triCache = new TriangulationCache()

  /** Draw-side vertex buffers; created on the first frame, not on load. */
  private _drawable?: LeafMeshDrawable

  /** Renders authored materials, so the material compile sites must see it. */
  usesMaterial = true

  symmetryAxes = 0

  private _active = new Int32Array(DOMAIN_COUNT).fill(ELEM_NONE)
  private _highlight = new Int32Array(DOMAIN_COUNT).fill(ELEM_NONE)
  private _activeAttr: (string | undefined)[] = new Array(DOMAIN_COUNT).fill(undefined)

  /** Blob carrier: populated by nstructjs during load, consumed by loadSTRUCT. */
  _data?: number[] | Uint8Array | ArrayBuffer

  // ------------------------------------------------------------ registration

  static blockDefine() {
    return {
      typeName   : 'leafmesh',
      defaultName: 'LeafMesh',
      uiName     : 'Leaf Mesh',
      flag       : 0,
      icon       : -1,
    }
  }

  static dataDefine(): IDataDefine {
    return {
      name          : 'LeafMesh',
      // Allocated by registerSelectType('LEAFMESH') on first registration; the
      // `?? 0` is what makes that first call legal (P6).
      selectMask    : SelMask.LEAFMESH ?? 0,
      selectTypeName: 'LEAFMESH',
      tools         : undefined,
      dataKind      : 'leafmesh',
    }
  }

  static nodedef() {
    return {
      ...super.nodedef(),
      name  : 'leafmesh',
      uiname: 'LeafMesh',
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const mstruct = SceneObjectData.defineAPI(api, struct ?? api.mapStruct(this, true)) as DataStruct<
      ViewContext,
      LeafMeshData
    >

    mstruct
      .flags('symmetryAxes', 'symmetryAxes', LeafMeshSymmetry, 'Symmetry', 'Mirror axes honoured by transforms')
      .uiNames({X: 'X', Y: 'Y', Z: 'Z'})

    const counts: [string, Domain, string][] = [
      ['vertexCount', Domain.VERT, 'Vertices'],
      ['edgeCount', Domain.EDGE, 'Edges'],
      ['faceCount', Domain.FACE, 'Faces'],
    ]

    for (const [prop, domain, uiname] of counts) {
      mstruct
        .int('', prop, uiname, '')
        .readOnly()
        .customGet(function () {
          return this.dataref.mesh.arrays[domain].count
        })
    }

    return mstruct
  }

  // ----------------------------------------------------------- serialization

  /** The `_data` blob: authoritative columns only, see serialize.ts. */
  serialize(): Uint8Array {
    return serializeLeafMesh(this.mesh)
  }

  loadSTRUCT(reader: nstructjs.StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)

    // An older or truncated block loads as an empty mesh rather than throwing;
    // the file still opens, and the block is visibly empty rather than absent.
    if (this._data instanceof ArrayBuffer || this._data?.length) {
      this.mesh = deserializeLeafMesh(new Uint8Array(this._data as ArrayBuffer))
    }
    this._data = undefined

    // The loader renumbers, so a saved handle would name a different element.
    this._active.fill(ELEM_NONE)
    this._highlight.fill(ELEM_NONE)
    this.triCache.invalidate()
  }

  // --------------------------------------------------------------- lifecycle

  copy(addLibUsers = false, owner?: DataBlock): this {
    const out = new (this.constructor as unknown as new () => this)()

    out.name = this.name
    out.symmetryAxes = this.symmetryAxes
    out.usesMaterial = this.usesMaterial
    out.materials = this.materials.concat([])
    out.mesh = this.mesh.copy()
    out._active = this._active.slice()
    out._highlight = this._highlight.slice()
    out._activeAttr = this._activeAttr.slice()

    return out
  }

  applyMatrix(matrix = new Matrix4()): this {
    const co = this.mesh.v.co
    const tmp = new Vector3()

    for (const v of this.mesh.v) {
      tmp[0] = co[v * 3]
      tmp[1] = co[v * 3 + 1]
      tmp[2] = co[v * 3 + 2]
      tmp.multVecMatrix(matrix)
      co[v * 3] = tmp[0]
      co[v * 3 + 1] = tmp[1]
      co[v * 3 + 2] = tmp[2]
    }

    this.invalidate(InvalidationKind.POSITIONS, ElementDomain.VERT)
    return this
  }

  getBoundingBox(): [Vector3, Vector3] {
    const lo = [1e17, 1e17, 1e17]
    const hi = [-1e17, -1e17, -1e17]
    const co = this.mesh.v.co

    for (const v of this.mesh.v) {
      for (let k = 0; k < 3; k++) {
        const x = co[v * 3 + k]
        lo[k] = Math.min(lo[k], x)
        hi[k] = Math.max(hi[k], x)
      }
    }

    return [new Vector3(lo), new Vector3(hi)]
  }

  // ------------------------------------------------------------ invalidation

  invalidate(what: InvalidationKind, domain?: ElementDomain, range?: ElementHandles): void {
    if (what & (InvalidationKind.TOPOLOGY | InvalidationKind.POSITIONS)) {
      this.triCache.invalidate()
    }
    if (what & InvalidationKind.TOPOLOGY) {
      this.mesh.topoStamp++
    }
    if (what & (InvalidationKind.TOPOLOGY | InvalidationKind.POSITIONS | InvalidationKind.ATTRIBUTES)) {
      this._drawable?.invalidate()
    }

    this.updateGen = (this.updateGen ?? 0) + 1
    this.graphUpdate()
  }

  // ---------------------------------------------------------------- elements

  get topoStamp(): number {
    return this.mesh.topoStamp
  }

  hasDomain(domain: ElementDomain): boolean {
    return domain >= ElementDomain.VERT && domain <= ElementDomain.FACE
  }

  elementCount(domain: ElementDomain): number {
    return this.mesh.arrays[toDomain(domain)].count
  }

  listElements(domain: ElementDomain, out?: Int32Array): Int32Array {
    const array = this.mesh.arrays[toDomain(domain)]
    const ret = sizedI32(out, array.count)

    let n = 0
    for (const i of array) {
      ret[n++] = i
    }
    return ret
  }

  listSelected(domain: ElementDomain, out?: Int32Array): Int32Array {
    const layer = this.mesh.attrs.get(toDomain(domain), SELECT_ATTR)
    if (layer === undefined) {
      return sizedI32(out, 0)
    }

    const flags = layer.column.data
    const hits: number[] = []
    for (const i of this.mesh.arrays[toDomain(domain)]) {
      if (flags[i] !== 0) {
        hits.push(i)
      }
    }

    const ret = sizedI32(out, hits.length)
    ret.set(hits)
    return ret
  }

  getPositions(domain: ElementDomain, handles: ElementHandles, out?: Float64Array): Float64Array {
    const n = handles.length
    const ret = out !== undefined && out.length >= n * 3 ? out.subarray(0, n * 3) : new Float64Array(n * 3)
    const co = this.mesh.v.co

    for (let i = 0; i < n; i++) {
      const verts = this._elemVerts(domain, handles[i])
      let x = 0
      let y = 0
      let z = 0
      for (const v of verts) {
        x += co[v * 3]
        y += co[v * 3 + 1]
        z += co[v * 3 + 2]
      }
      const w = verts.length || 1
      ret[i * 3] = x / w
      ret[i * 3 + 1] = y / w
      ret[i * 3 + 2] = z / w
    }
    return ret
  }

  /**
   * On a non-vertex domain this translates the element's vertices by the delta
   * between its old centre and the requested one — the only reading of "move
   * this face" that does not also reshape it.
   */
  setPositions(domain: ElementDomain, handles: ElementHandles, co: Float64Array): void {
    const verts = this.mesh.v.co
    const centres = domain === ElementDomain.VERT ? undefined : this.getPositions(domain, handles)

    for (let i = 0; i < handles.length; i++) {
      if (centres === undefined) {
        const v = handles[i]
        if (!this.mesh.v.has(v)) {
          continue
        }
        verts[v * 3] = co[i * 3]
        verts[v * 3 + 1] = co[i * 3 + 1]
        verts[v * 3 + 2] = co[i * 3 + 2]
        continue
      }

      const dx = co[i * 3] - centres[i * 3]
      const dy = co[i * 3 + 1] - centres[i * 3 + 1]
      const dz = co[i * 3 + 2] - centres[i * 3 + 2]
      for (const v of this._elemVerts(domain, handles[i])) {
        verts[v * 3] += dx
        verts[v * 3 + 1] += dy
        verts[v * 3 + 2] += dz
      }
    }

    this.invalidate(InvalidationKind.POSITIONS, domain, handles)
  }

  getSelected(domain: ElementDomain, handles: ElementHandles, out?: Uint8Array): Uint8Array {
    const n = handles.length
    const ret = out !== undefined && out.length >= n ? out.subarray(0, n) : new Uint8Array(n)
    const layer = this.mesh.attrs.get(toDomain(domain), SELECT_ATTR)

    if (layer === undefined) {
      ret.fill(0)
      return ret
    }

    const flags = layer.column.data
    for (let i = 0; i < n; i++) {
      ret[i] = flags[handles[i]] !== 0 ? 1 : 0
    }
    return ret
  }

  setSelected(domain: ElementDomain, handles: ElementHandles, selected: Uint8Array): void {
    const flags = this._selectLayer(toDomain(domain))
    for (let i = 0; i < handles.length; i++) {
      flags[handles[i]] = selected[i] !== 0 ? 1 : 0
    }
    this.invalidate(InvalidationKind.SELECTION, domain, handles)
  }

  // ----------------------------------------------------------------- spatial

  /**
   * Brute force, which §6 explicitly permits: the contract exposes the query
   * and never the structure, so adding an acceleration tree later is invisible
   * to every caller. Nearest first.
   */
  closestElements(co: Vector3, radius: number, domain: ElementDomain, out?: Int32Array): Int32Array {
    const all = this.listElements(domain)
    const centres = this.getPositions(domain, all)
    const r2 = radius * radius

    const hits: {h: number; d: number}[] = []
    for (let i = 0; i < all.length; i++) {
      const dx = centres[i * 3] - co[0]
      const dy = centres[i * 3 + 1] - co[1]
      const dz = centres[i * 3 + 2] - co[2]
      const d = dx * dx + dy * dy + dz * dz
      if (d <= r2) {
        hits.push({h: all[i], d})
      }
    }
    hits.sort((a, b) => a.d - b.d)

    const ret = sizedI32(out, hits.length)
    for (let i = 0; i < hits.length; i++) {
      ret[i] = hits[i].h
    }
    return ret
  }

  // -------------------------------------------------------------- attributes

  listAttributes(domain?: ElementDomain): readonly IAttributeLayerInfo[] {
    const domains: Domain[] =
      domain === undefined ? [Domain.VERT, Domain.EDGE, Domain.CORNER, Domain.LOOP, Domain.FACE] : [toDomain(domain)]
    const ret: IAttributeLayerInfo[] = []

    for (const d of domains) {
      for (const layer of this.mesh.attrs.layers(d)) {
        ret.push({
          name  : layer.name,
          type  : toHostAttrType(layer.type),
          domain: toHostDomain(d),
          active: this._activeAttr[d] === layer.name,
        })
      }
    }
    return ret
  }

  getAttribute(domain: ElementDomain, name: string, handles: ElementHandles, out?: ArrayBufferView): ArrayBufferView {
    const layer = this._layer(domain, name)
    const {data, size} = layer.column
    const n = handles.length * size

    const ctor = data.constructor as {new (length: number): typeof data}
    const ret =
      out?.constructor === data.constructor && out.byteLength >= n * data.BYTES_PER_ELEMENT
        ? (out as typeof data)
        : new ctor(n)

    for (let i = 0; i < handles.length; i++) {
      const s = handles[i] * size
      const d = i * size
      for (let k = 0; k < size; k++) {
        ret[d + k] = data[s + k]
      }
    }
    return ret
  }

  setAttribute(domain: ElementDomain, name: string, handles: ElementHandles, values: ArrayBufferView): void {
    const layer = this._layer(domain, name)
    const {data, size} = layer.column
    const src = values as unknown as {[i: number]: number}

    for (let i = 0; i < handles.length; i++) {
      const d = handles[i] * size
      const s = i * size
      for (let k = 0; k < size; k++) {
        data[d + k] = src[s + k]
      }
    }
    this.invalidate(InvalidationKind.ATTRIBUTES, domain, handles)
  }

  setActiveAttribute(domain: ElementDomain, name: string): void {
    this._layer(domain, name)
    this._activeAttr[toDomain(domain)] = name
  }

  // --------------------------------------------------------------- triangles

  extractTriangles(): {positions: Float64Array; indices: Int32Array; normals?: Float64Array} {
    const mesh = this.mesh
    const verts = this.listElements(ElementDomain.VERT)
    const row = new Int32Array(mesh.v.array.used).fill(ELEM_NONE)
    const positions = new Float64Array(verts.length * 3)
    const co = mesh.v.co

    for (let i = 0; i < verts.length; i++) {
      row[verts[i]] = i
      positions[i * 3] = co[verts[i] * 3]
      positions[i * 3 + 1] = co[verts[i] * 3 + 1]
      positions[i * 3 + 2] = co[verts[i] * 3 + 2]
    }

    const tris = triangulateMesh(mesh)
    const indices = new Int32Array(tris.length * 3)
    for (let i = 0; i < tris.length; i++) {
      indices[i * 3] = row[tris[i].v[0]]
      indices[i * 3 + 1] = row[tris[i].v[1]]
      indices[i * 3 + 2] = row[tris[i].v[2]]
    }

    return {positions, indices, normals: accumulateNormals(positions, indices)}
  }

  // -------------------------------------------------------------------- draw

  /**
   * The vertex buffers this mesh draws from. Held rather than rebuilt per frame
   * so a static mesh uploads once; every mutation path reaches it through
   * {@link invalidate}.
   */
  get drawable(): LeafMeshDrawable {
    if (this._drawable === undefined) {
      this._drawable = new LeafMeshDrawable(this.mesh, this.triCache)
    }
    return this._drawable
  }

  /**
   * `IMaterialAttrConsumer` (geometry-contract §10.2): the host hands over what
   * the compiled material reads, and the drawable gathers a vertex buffer per
   * entry at the slot the shader generator assigned. A name with no layer
   * behind it is reported by {@link LeafMeshDrawable.missingAttrs}, not thrown.
   */
  setRequestedAttrs(reqs: readonly MaterialAttrRequest[]): void {
    this.drawable.setRequestedAttrs(reqs)
  }

  drawQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject): void {
    if (frame.program === undefined) {
      return
    }
    queue.submit({pipeline: frame.program, mesh: this.drawable})
  }

  onContextLost(e: Event): void {
    super.onContextLost(e)
    this._drawable?.dispose()
    this._drawable = undefined
  }

  destroy(): void {
    super.destroy()
    this._drawable?.dispose()
    this._drawable = undefined
  }

  // ----------------------------------------------------------------- picking

  /**
   * Geometric viewport picking (P11 §8), delegated to `pick.ts`. Brute force:
   * LeafMesh has no acceleration structure and declines to pretend otherwise,
   * which the geometry contract permits precisely because it exposes queries
   * rather than trees.
   */
  castViewRay(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2
  ): FindNearestRet[] | undefined {
    return pick.castViewRay(this, view3d, object, selectMask, mpos)
  }

  findNearest(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2,
    limit = 25
  ): FindNearestRet[] | undefined {
    return pick.findNearest(this, view3d, object, selectMask, mpos, limit)
  }

  castScreenCircle(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2,
    radius: number
  ): ScreenPickResult {
    return pick.castScreenCircle(this, view3d, object, selectMask, mpos, radius)
  }

  castScreenRect(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    min: Vector2,
    max: Vector2
  ): ScreenPickResult {
    return pick.castScreenRect(this, view3d, object, selectMask, min, max)
  }

  // ---------------------------------------------------------- active element

  getActiveElement(domain: ElementDomain): ElementHandle | undefined {
    const h = this._active[toDomain(domain)]
    return h === ELEM_NONE ? undefined : h
  }

  getHighlightElement(domain: ElementDomain): ElementHandle | undefined {
    const h = this._highlight[toDomain(domain)]
    return h === ELEM_NONE ? undefined : h
  }

  setActiveElement(domain: ElementDomain, handle: ElementHandle | undefined): void {
    this._active[toDomain(domain)] = handle ?? ELEM_NONE
  }

  setHighlightElement(domain: ElementDomain, handle: ElementHandle | undefined): void {
    this._highlight[toDomain(domain)] = handle ?? ELEM_NONE
  }

  // ----------------------------------------------------------------- private

  private _layer(domain: ElementDomain, name: string) {
    const layer = this.mesh.attrs.get(toDomain(domain), name)
    if (layer === undefined) {
      throw new Error(`leafmesh: no attribute "${name}" on domain ${ElementDomain[domain]}`)
    }
    return layer
  }

  private _selectLayer(domain: Domain) {
    return this.mesh.attrs.add(domain, SELECT_ATTR, AttrType.Byte, AttrFlags.NONE, 0).column.data
  }

  /** The vertices an element is made of, for centre and translate. */
  private _elemVerts(domain: ElementDomain, handle: number): readonly number[] {
    const mesh = this.mesh

    switch (domain) {
      case ElementDomain.VERT:
        return mesh.v.has(handle) ? [handle] : []
      case ElementDomain.EDGE:
        return mesh.e.has(handle) ? [mesh.e.v1[handle], mesh.e.v2[handle]] : []
      case ElementDomain.CORNER:
        return mesh.c.has(handle) ? [mesh.c.v[handle]] : []
      case ElementDomain.LOOP:
        return mesh.l.has(handle) ? mesh.loopVerts(handle) : []
      case ElementDomain.FACE: {
        if (!mesh.f.has(handle)) {
          return []
        }
        const seen = new Set<number>()
        for (const l of mesh.faceLoops(handle)) {
          for (const v of mesh.loopVerts(l)) {
            seen.add(v)
          }
        }
        return [...seen]
      }
      default:
        return []
    }
  }
}

/** Area-weighted vertex normals over an indexed triangle soup. */
function accumulateNormals(positions: Float64Array, indices: Int32Array): Float64Array {
  const no = new Float64Array(positions.length)

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3

    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]

    // Un-normalized cross product, so accumulation is area-weighted.
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx

    for (const i of [a, b, c]) {
      no[i] += nx
      no[i + 1] += ny
      no[i + 2] += nz
    }
  }

  for (let i = 0; i < no.length; i += 3) {
    const len = Math.sqrt(no[i] * no[i] + no[i + 1] * no[i + 1] + no[i + 2] * no[i + 2])
    if (len > 0) {
      no[i] /= len
      no[i + 1] /= len
      no[i + 2] /= len
    }
  }
  return no
}

/**
 * What the kind descriptor claims, and therefore what the host will narrow to.
 * Declared next to the class so that claiming a capability without implementing
 * it fails the assertions below.
 */
export const LEAFMESH_CAPABILITIES = [
  GeometryCapability.ELEMENTS,
  GeometryCapability.INVALIDATION,
  GeometryCapability.SPATIAL,
  GeometryCapability.ATTRIBUTES,
  GeometryCapability.TRIANGLES,
  GeometryCapability.SYMMETRY,
  GeometryCapability.ACTIVE_ELEMENT,
] as const

// The contract, checked by the compiler: one line per claimed capability, plus
// the required surface every SceneObjectData owes.
export type _LeafMeshIsGeometrySource = AssertExtends<LeafMeshData, IGeometrySource>
export type _LeafMeshIsElementSource = AssertExtends<LeafMeshData, IElementSource>
export type _LeafMeshIsInvalidatable = AssertExtends<LeafMeshData, IInvalidatable>
export type _LeafMeshIsSpatialQueryable = AssertExtends<LeafMeshData, ISpatialQueryable>
export type _LeafMeshIsAttributeSource = AssertExtends<LeafMeshData, IAttributeSource>
export type _LeafMeshIsTriangleSource = AssertExtends<LeafMeshData, ITriangleSource>
export type _LeafMeshIsSymmetryAware = AssertExtends<LeafMeshData, ISymmetryAware>
export type _LeafMeshIsActiveElementSource = AssertExtends<LeafMeshData, IActiveElementSource>
