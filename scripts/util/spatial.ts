/**
 * Mesh-agnostic spatial-query interfaces.
 *
 * This module is the boundary between core / scene / sceneobject code and the
 * concrete BVH living inside the mesh subsystem (today scripts/util/bvh.ts, soon
 * the BREP's own bvh.ts, deleted in P13 — see plan §3). Anything that needs to ray-cast
 * against a surface or talk about BVH vertices should depend on these interfaces,
 * not on the BVH class.
 *
 * The concrete `BVH` class still imports from this module; the existing
 * `IGenericIsect` / `ISurfaceSampler` / `IBVHCreateArgs` / `IBVHVertex` types
 * previously declared in scripts/util/bvh.ts are re-exported here for source
 * compatibility while the mesh body is being moved into an addon.
 *
 * The vector primitives and AABB/ray helpers used to build a BVH live next door:
 *   - vector types: pathux
 *   - AABB/ray/triangle tests: ./isect
 *   - generic math helpers: ./math
 *
 * Those are re-exported below so consumers can import everything spatial-related
 * from one place.
 */

import {Vector2, Vector3} from '../path.ux/scripts/pathux.js'

// ----------------------------------------------------------------------------
// Surface-cast result
// ----------------------------------------------------------------------------

/** Result of a ray-cast / closest-point query against any surface. */
export interface IGenericIsect {
  p: Vector3
  origp: Vector3
  uv: Vector2
  dis: number
  normal: Vector3
  vertex: number
  tri: number
  face: number
  copy: () => this
}

/** Concrete pooled-friendly implementation of IGenericIsect. */
export class GenericIsect implements IGenericIsect {
  dis = -1
  normal = new Vector3()
  vertex = -1
  tri = -1
  face = -1
  p = new Vector3()
  origp = new Vector3()
  uv = new Vector2()

  copy(): this {
    const ret = new GenericIsect() as this
    ret.dis = this.dis
    ret.normal = this.normal
    ret.tri = this.tri
    ret.vertex = this.vertex
    ret.face = this.face
    ret.p = this.p
    ret.uv = this.uv
    return ret
  }
}

// ----------------------------------------------------------------------------
// Anything that can be ray-cast against
// ----------------------------------------------------------------------------

/**
 * Mesh-agnostic sampler. The mesh subsystem implements this on top of the BVH,
 * but other surfaces (implicit, voxel, brep, ...) can plug in here too.
 */
export interface ISurfaceSampler {
  rayCast(origin: Vector3, direction: Vector3): IGenericIsect | undefined
}

// ----------------------------------------------------------------------------
// BVH construction args
// ----------------------------------------------------------------------------

/**
 * Construction options for a BVH-like spatial index.
 *
 * `TriT` and `BVHT` are parametric because the freelist (used to recycle
 * per-triangle records when a BVH is rebuilt) and the `onCreate` callback are
 * necessarily implementation-specific. The concrete BVH uses `BVHTri` and
 * `BVH` respectively; mesh-agnostic callers can leave them `unknown`.
 */
export interface IBVHCreateArgs<TriT = unknown, BVHT = unknown> {
  storeVerts?: boolean
  leafLimit?: number
  depthLimit?: number
  addWireVerts?: boolean
  deformMode?: boolean
  useGrids?: boolean
  freelist?: TriT[]
  onCreate?: (bvh: BVHT) => void
}

// ----------------------------------------------------------------------------
// BVH vertex (structural, mesh-agnostic)
// ----------------------------------------------------------------------------

/**
 * Vertex shape used by BVH queries. Mesh-agnostic: a "vertex" here is anything
 * that has a position, normal, neighbor iterator, and custom-data container.
 *
 * `CDArray` is parametric so mesh code can pin the concrete `CDElemArray`
 * type — getting indexed access (`v.customData[i]`) and typed `get<T>()` —
 * without forcing util/scene/etc. to import the mesh-side type. Mesh-agnostic
 * callers leave it `unknown`.
 */
export interface IBVHVertex<CDArray = unknown> {
  eid: number
  flag: number
  index: number
  co: Vector3
  no: Vector3
  neighbors: Iterable<IBVHVertex<CDArray>>
  customData: CDArray
  // present on grid-vertex variants
  loopEid?: number
  readonly valence?: number
}

// ----------------------------------------------------------------------------
// AABB / ray / triangle helpers (re-exported for one-stop import)
// ----------------------------------------------------------------------------

export {
  aabb_cone_isect,
  aabb_ray_isect,
  planeBoxOverlap,
  ray_tri_isect,
  tri_aabb_isect,
  triBoxOverlap,
  tri_cone_isect,
} from './isect.js'

export {aabb_sphere_dist, closest_point_on_tri} from './math.js'
