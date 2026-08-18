/**
 * LeafMesh — the built-in geometry type. Storage, attributes, topology and
 * triangulation, with no dependency on sculptcore and none on `scripts/`.
 *
 * The addon shell (manifest, registration, the `DataBlock` and
 * `SceneObjectData` that make one of these a scene object) is not here yet;
 * this module is a library with a unit suite.
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

export {buildDrawGeometry, drawAttrNames, gatherDrawAttr, recalcVertexNormals, resolveDrawAttr} from './draw_buffers.js'
export type {DrawGeometry} from './draw_buffers.js'
