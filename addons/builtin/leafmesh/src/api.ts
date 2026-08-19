/**
 * Public API surface for the `leafmesh` builtin addon (P11 §3).
 *
 * Reached by peer addons as `@addon/leafmesh/api`. Keep in sync with the
 * `exportNamespace('leafmesh', ...)` call in main.ts — this file is the
 * compile-time half of that runtime namespace, and the two disagreeing is a
 * silent `undefined` at the consumer.
 *
 * It is `index.ts` plus the host-facing data class. `index.ts` itself stays
 * free of every `scripts/` import so the core remains unit-testable in plain
 * jest, so the two lists are no longer identical and this is the only one that
 * pulls in `leafmesh.ts`.
 */

export {ELEM_NONE, ElemArray} from './elem_array.js'
export type {Column, TypedArray, TypedArrayCtor} from './elem_array.js'

export {AttrFlags, AttrSet, AttrType, Domain, attrTypeIsDiscrete, attrTypeSize} from './attrs.js'
export type {AttrLayer} from './attrs.js'

export {LeafMesh, planeBasis} from './topo.js'
export type {SplitEdgeResult, Vec3} from './topo.js'

export {cdt2d} from './cdt2d.js'
export type {Cdt2dOptions, Cdt2dResult} from './cdt2d.js'

export {TriangulationCache, triangulateFace, triangulateMesh} from './triangulate.js'
export type {Tri} from './triangulate.js'

export {makeCube, makeGrid, makePlane, makeTube, makeUVSphere} from './primitives.js'
export type {PrimitiveResult} from './primitives.js'

export {LEAFMESH_BLOB_VERSION, deserializeLeafMesh, serializeLeafMesh} from './serialize.js'

export {LEAFMESH_CAPABILITIES, LeafMeshData, LeafMeshSymmetry} from './leafmesh.js'

export {LEAFMESH_VERTEX_ATTRS, LeafMeshDrawable} from './draw.js'

export {LeafMeshTransElem, LeafMeshTransList, LeafMeshTransType} from './transtype.js'

export {
  extrudeFaceRegion,
  extrudeFacesIndividual,
  meshSnapshotBytes,
  regionBoundaryEdges,
  splitOffFaces,
} from './modeling.js'
export type {ExtrudeOptions, RegionResult} from './modeling.js'

export {
  LEAFMESH_MODELING_OPS,
  LeafMeshExtrudeIndividualOp,
  LeafMeshExtrudeRegionOp,
  LeafMeshSplitOffOp,
  LeafMeshTopoOpBase,
} from './modeling_ops.js'
