/**
 * LeafMesh as an `IUVSource` — P18 §5 step 2, implementor #1.
 *
 * A shell over `uv_geom.ts`: everything with a traversal in it is pure and
 * unit-tested there, and this file only converts vocabulary and reports the
 * writes. That split is why the source can be trusted without booting the app.
 *
 * A UV element here *is* a corner, so {@link LeafMeshUVSource.getUVOwners} is
 * the identity. That is the honest answer for a mesh that stores UVs on the
 * domain it addresses them by, not a stub — a source that caches an unwrap
 * would answer differently, which is why the method exists at all.
 */

import {ElementDomain, InvalidationKind} from '@framework/api'
import type {AssertExtends, ElementHandles, GeometryDataRef, IUVSource, IUVSourceProvider} from '@framework/api'

import {LeafMeshData} from './leafmesh.js'
import type {LeafMesh} from './topo.js'
import {
  ensureUVCoords,
  ensureUVFlags,
  faceCornerRings,
  uvCoords,
  uvElements,
  uvFaces,
  uvFans,
  uvFlags,
  uvLayerNames,
} from './uv_geom.js'

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

export class LeafMeshUVSource implements IUVSource {
  constructor(private readonly data: LeafMeshData) {}

  private get mesh(): LeafMesh {
    return this.data.mesh
  }

  /** The layer name an index means, or `undefined` when it is out of range. */
  private layerName(layer: number): string | undefined {
    return uvLayerNames(this.mesh)[layer]
  }

  get topoStamp(): number {
    return this.data.topoStamp
  }

  get uvDomain(): ElementDomain {
    return ElementDomain.CORNER
  }

  listUVLayers(): readonly string[] {
    return uvLayerNames(this.mesh)
  }

  /**
   * The corner domain's active attribute when that is a UV layer, else the
   * first one — a mesh with UVs always has a layer the editor can open.
   */
  get activeUVLayer(): number {
    const names = uvLayerNames(this.mesh)
    if (names.length === 0) {
      return -1
    }

    const active = this.data.listAttributes(ElementDomain.CORNER).find((a) => a.active)
    const i = active === undefined ? -1 : names.indexOf(active.name)
    return i < 0 ? 0 : i
  }

  listUVElements(layer: number, owners?: ElementHandles): Int32Array {
    if (this.layerName(layer) === undefined) {
      return new Int32Array(0)
    }
    return uvElements(this.mesh, owners)
  }

  getUVOwners(_layer: number, handles: ElementHandles, out?: Int32Array): Int32Array {
    const ret = sizedI32(out, handles.length)
    for (let i = 0; i < handles.length; i++) {
      ret[i] = handles[i]
    }
    return ret
  }

  /**
   * Corner positions — which on a corner domain is the corner's vertex, so the
   * element source already answers this; only the precision differs.
   */
  getUVElementPositions(_layer: number, handles: ElementHandles, out?: Float32Array): Float32Array {
    const ret = sizedF32(out, handles.length * 3)
    const co = this.data.getPositions(ElementDomain.CORNER, handles)

    for (let i = 0; i < ret.length; i++) {
      ret[i] = co[i]
    }
    return ret
  }

  getUVs(layer: number, handles: ElementHandles, out?: Float32Array): Float32Array {
    const ret = sizedF32(out, handles.length * 2)
    const name = this.layerName(layer)
    const uv = name === undefined ? undefined : uvCoords(this.mesh, name)

    if (uv === undefined) {
      ret.fill(0)
      return ret
    }

    for (let i = 0; i < handles.length; i++) {
      ret[i * 2] = uv[handles[i] * 2]
      ret[i * 2 + 1] = uv[handles[i] * 2 + 1]
    }
    return ret
  }

  setUVs(layer: number, handles: ElementHandles, uv: Float32Array): void {
    const name = this.layerName(layer)
    if (name === undefined) {
      return
    }

    const col = ensureUVCoords(this.mesh, name)
    for (let i = 0; i < handles.length; i++) {
      col[handles[i] * 2] = uv[i * 2]
      col[handles[i] * 2 + 1] = uv[i * 2 + 1]
    }
    this.data.invalidate(InvalidationKind.ATTRIBUTES, ElementDomain.CORNER, handles)
  }

  getUVFlags(layer: number, handles: ElementHandles, out?: Uint8Array): Uint8Array {
    const ret = sizedU8(out, handles.length)
    const name = this.layerName(layer)
    const flags = name === undefined ? undefined : uvFlags(this.mesh, name)

    if (flags === undefined) {
      ret.fill(0)
      return ret
    }

    for (let i = 0; i < handles.length; i++) {
      ret[i] = flags[handles[i]]
    }
    return ret
  }

  setUVFlags(layer: number, handles: ElementHandles, flags: Uint8Array): void {
    const name = this.layerName(layer)
    if (name === undefined) {
      return
    }

    const col = ensureUVFlags(this.mesh, name)
    for (let i = 0; i < handles.length; i++) {
      col[handles[i]] = flags[i]
    }
    this.data.invalidate(InvalidationKind.SELECTION, ElementDomain.CORNER, handles)
  }

  getUVFans(layer: number, handles: ElementHandles): {offsets: Int32Array; values: Int32Array} {
    const name = this.layerName(layer)
    return name === undefined ? emptyCSR(handles.length) : uvFans(this.mesh, name, handles)
  }

  listUVFaces(layer: number, selectedOnly = false): Int32Array {
    if (this.layerName(layer) === undefined) {
      return new Int32Array(0)
    }
    return uvFaces(this.mesh, selectedOnly)
  }

  getUVFaceRings(layer: number, faces: ElementHandles): {offsets: Int32Array; values: Int32Array} {
    const name = this.layerName(layer)
    return name === undefined ? emptyCSR(faces.length) : faceCornerRings(this.mesh, faces)
  }
}

/**
 * One adapter per data block, so the editor holding a source across a redraw
 * does not churn allocations. The mesh is read through the block on every call,
 * so a cached adapter never goes stale.
 */
const _sources = new WeakMap<LeafMeshData, LeafMeshUVSource>()

export const LEAFMESH_UV_PROVIDER: IUVSourceProvider = {
  kindId: 'leafmesh',
  uiName: 'Leaf Mesh',

  resolve(data: GeometryDataRef): IUVSource | undefined {
    if (!(data instanceof LeafMeshData)) {
      return undefined
    }

    let source = _sources.get(data)
    if (source === undefined) {
      source = new LeafMeshUVSource(data)
      _sources.set(data, source)
    }
    return source
  },
}

export type _LeafMeshUVSourceIsUVSource = AssertExtends<LeafMeshUVSource, IUVSource>
