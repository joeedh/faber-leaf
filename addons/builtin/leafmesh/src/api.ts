/**
 * Public API surface for the `leafmesh` builtin addon (P11 §3).
 *
 * Reached by peer addons as `@addon/leafmesh/api`. Keep in sync with the
 * `exportNamespace('leafmesh', ...)` call in main.ts — this file is the
 * compile-time half of that runtime namespace, and the two disagreeing is a
 * silent `undefined` at the consumer.
 *
 * It is deliberately the same list as `index.ts`: the headless core is the
 * public surface, and the addon shell adds nothing a peer should reach for.
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
