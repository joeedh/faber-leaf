/**
 * `@framework/api` — the single import surface that builtin addons reach
 * for framework primitives. Adding here is preferred over reaching into
 * `scripts/...` by relative path; addons must not write
 * `../../../../scripts/foo` any more.
 *
 * Layout: groups roughly mirror the `scripts/` subsystem layout. If you
 * find yourself wanting a symbol that isn't re-exported here, add it —
 * don't relapse to a relative path.
 *
 * pathux is re-exported wholesale because addons import a wide and
 * varying subset (nstructjs, util, math, ToolOp + every Property class,
 * Vector2/3/4, Matrix4, Quat, KeyMap, HotKey, DataAPI, DataStruct,
 * UIBase, …). Doing `export *` keeps maintenance to zero.
 */

// pathux: value-level surface is reached through `@framework/pathux` (see
// scripts/_framework_runtime.ts + tools/framework_api_plugin.js). We keep a
// type-only re-export here so that addon files which still write
// `import {SomeTypeOnlyName} from '@framework/api'` continue to typecheck —
// the type system follows `export type *`, runtime sees nothing.
//
// Type-only names that ride this surface: Vector3Like, ToolDef, PropertySlots,
// ContextLike, IVector2, etc. New code should prefer `@framework/pathux`
// directly.
export type * from './path.ux/scripts/pathux.js'

// nstructjs internals
export type {StructReader} from 'nstructjs'

// pathux ui plumbing not surfaced by the top-level pathux re-export
export {PackFlags} from './path.ux/scripts/core/ui_base.js'
export {clearAspectCallbacks, initAspectClass, _setUIBase} from './path.ux/scripts/core/aspect.js'
export {css2matrix} from './path.ux/scripts/path-controller/util/cssutils.js'
export {dist_to_line_2d} from './path.ux/scripts/util/math.js'

// util/* — vectormath types not surfaced via pathux
export type {IVector4, Number2, Number3, Number4} from './util/vectormath.js'
export {Vector2, Vector3, Vector4, Quat, Matrix4} from './util/vectormath.js'
export * as vectormath from './util/vectormath.js'
export * as util from './util/util.js'
export * as math from './util/math.js'
export * as parseutil from './util/parseutil.js'
export {aabb_sphere_dist, closest_point_on_tri} from './util/math.js'
export {
  aabb_ray_isect,
  ray_tri_isect,
  aabb_cone_isect,
  tri_cone_isect,
  point_in_frustum,
  aabb_frustum_isect,
  tri_frustum_isect,
} from './util/isect.js'
export {GenericIsect} from './util/spatial.js'
export type {IGenericIsect, ISurfaceSampler, IBVHCreateArgs, IBVHVertex} from './util/spatial.js'
export * as spatial from './util/spatial.js'
export type {BoolOr, OptionalIf, OptionalIfNot} from './util/optionalIf.js'
export {BinaryReader} from './util/binarylib.js'
export {BinomialTable} from './util/binomial_table.js'
export {half2float} from './util/floathalf.js'
export {default as Delaunay} from './util/delaunay.js'
export type {INumberList} from './util/polyfill.d'

// core/*
export {DataBlock, DataRef, DataRefProperty, DataRefListProperty} from './core/lib_api.js'
export type {Library, IDataBlockConstructor, BlockLoader, BlockLoaderAddUser} from './core/lib_api.js'

// The host geometry contract (documentation/geometry-contract.md). Enums are
// runtime values; everything else is types. Providers assert conformance with
// `AssertExtends` next to their class declaration.
export {
  AttrType,
  ELEMENT_DOMAIN_COUNT,
  ElementDomain,
  GeometryCapability,
  InvalidationKind,
  hasCapability,
} from './core/geometry_contract.js'
export type {
  AssertExtends,
  ElementHandle,
  ElementHandles,
  GeometryDataRef,
  IActiveElementSource,
  IAttributeLayerInfo,
  IAttributeSource,
  IDeclaredAttribute,
  IElementSource,
  IGeometryKindCapabilities,
  IInvalidatable,
  ISpatialQueryable,
  ISymmetryAware,
  ITriangleSource,
} from './core/geometry_contract.js'
// The vertex-layout half of the same contract (§10).
export {
  MATERIAL_BASE_VERTEX_ATTRS,
  VertexScalarType,
  buildVertexBufferLayout,
  vertexFormatFor,
  vertexShapeForAttrType,
  vertexStrideFor,
} from './core/vertex_layout.js'
export type {VertexAttrDesc, VertexAttrShape} from './core/vertex_layout.js'
// Properties-editor panel contributions (§9). A leaf like the two above.
export {ANY_DATA_KIND} from './core/props_panels.js'
export type {IPropsPanel} from './core/props_panels.js'
// `core/data_kinds.ts` is deliberately NOT re-exported here: it reaches
// `core/context.ts`, and the hub is on context's own import path, so a re-export
// closes a cycle. Addons register a kind through `AddonAPI.registerDataKind`.

// sceneobject/* and View3DOp — MUST be re-exported BEFORE context.ts.
// context.ts pulls in editors/all → editors/view3d → tools/tools.ts →
// the toolmode modules → mesh.ts (and PropsEditor → mesh_ops_base.ts). Any
// `class X extends SceneObjectData` (mesh.ts:310) or `class MeshOp extends
// View3DOp` (mesh_ops_base.ts:105) will TDZ if those base classes aren't bound
// by the time the context-triggered chain re-enters the mesh addon. Keep these
// re-exports above `ViewContext` to dodge that race.
export {SceneObject, ObjectFlags, Colors, composeObjectMatrix} from './sceneobject/sceneobject.js'
export {DrawModes, DrawFlags} from './sceneobject/drawmode.js'
export {SceneObjectData} from './sceneobject/sceneobject_base.js'
export type {
  IDataDefine,
  IGeometryGraphNode,
  IGeometryInstance,
  IGeometryLifecycle,
  IGeometrySource,
  IGeometrySourceConstructor,
  IGeometrySourceStatics,
} from './sceneobject/sceneobject_base.js'
export {StandardTools} from './sceneobject/stdtools.js'
export {View3DOp} from './editors/view3d/view3d_ops.js'

// tet — TetMesh DataBlock + the geometry helpers the tetmesh addon's ops
// reach for. TetMesh extends SceneObjectData (above) and is referenced by
// core/context.ts, so it must stay a single class in the main bundle; the
// addon imports it through here rather
// than inlining scripts/tet/tetgen.js (which would re-run its module-scope
// nstructjs/DataBlock/SceneObjectData.register and throw a duplicate-struct
// error). Placed after SceneObjectData to avoid TDZ.
export {TetMesh} from './tet/tetgen.js'
export {TetTypes, TetFlags, TetRecalcFlags} from './tet/tetgen_base.js'
export {meshToTetMesh, vertexSmooth, tetMeshToMesh, tetrahedralizeMesh} from './tet/tetgen_utils.js'
export {tetSolve} from './tet/tet_deform.js'

export {ViewContext} from './core/context.js'
export type {ToolContext} from './core/context.js'
export {Node, NodeFlags, CallbackNode} from './core/graph.js'
export {DependSocket} from './core/graphsockets.js'
export {Material, DefaultMat, makeDefaultMaterial} from './core/material.js'
export {default as bus} from './core/bus.js'
export {EDGE_LINKED_LISTS} from './core/const.js'
export {registerOpaqueCustomDataElem} from './core/missing_addon.js'
export {registerFileMigrator} from './core/file_migrations.js'
export type {IFileMigrationContext, IFileMigrator} from './core/file_migrations.js'
export {setDefaultSceneBuilder} from './core/default_file.js'
export * as platform from './core/platform.js'

// webgl/*
export {ChunkedSimpleMesh, LayerTypes, PrimitiveTypes, SimpleMesh} from './webgl/simplemesh.js'
export * as simplemesh from './webgl/simplemesh.js'
export {Texture} from './webgl/webgl.js'
export type {IUniformsBlock, ShaderProgram} from './webgl/webgl.js'
export * as webgl from './webgl/webgl.js'
export {Shapes, setShapesObjLoader} from './webgl/simplemesh_shapes.js'

// render/* — backend-agnostic DrawQueue dispatch
export {WebGLDrawQueueAdapter} from './render/queue.js'
export type {DrawQueue, FrameContext, Submission, Drawable} from './render/queue.js'

// shaders/*
export {Shaders, BasicLineShader, MeshIDShader} from './shaders/shaders.js'

// editors/*
export {ToolMode} from './editors/view3d/view3d_toolmode.js'
// The stroke-toolmode base every sculpt/paint toolmode derives from. Addons
// that need to ask "is a paint toolmode active?" test against this rather than
// a concrete toolmode class.
export {PaintToolModeBase} from './editors/view3d/tools/stroke_base.js'
export {SelMask, SelOneToolModes, SelToolModes} from './core/select_types.js'
export {FindNearest, FindNearestRet, castViewRay, CastModes} from './editors/view3d/findnearest.js'
export type {ScreenPickResult} from './editors/view3d/findnearest.js'
// MeshTransType rides transform_ops.js rather than transform_types.js: the hub
// already depends on the former, and a direct edge to the latter closes four
// more cycles through the mesh addon it imports. The type is the BREP mesh's
// transform bridge — its own addon registers it (§8), and P11 moves the class.
export {InflateOp, MeshTransType, TranslateOp, TransformOp} from './editors/view3d/transform/transform_ops.js'
export {
  InflateWidget,
  RotateWidget,
  ScaleWidget,
  TranslateWidget,
  setInsetHoleOp,
} from './editors/view3d/widgets/widget_tools.js'
// View3DOp is re-exported above (before ViewContext) to avoid TDZ in
// addons/builtin/mesh/src/mesh_ops_base.ts:105.
export {Icons} from './editors/icon_enum.js'
export {ImageBus} from './editors/image/ImageBus.js'
export type {BoundingBox} from './editors/view3d/view3d_utils.js'
export type {View3D} from './editors/view3d/view3d.js'
export type {ImageEditor} from './editors/all.js'
export type {Scene} from './scene/scene.js'

// light, nullobject
export {Light} from './light/light.js'
export {NullObject} from './nullobject/nullobject.js'

// extern — jszip is loaded by side effect; no value-level exports.

// addon
export {default as addonManager} from './addon/addon.js'
export type {AddonAPI, IAddon, IAddonDefine} from './addon/addon_base.js'

// mathl
export {sym, binop, checksym, unaryop, call} from './mathl/transform/sym.js'

// lite-mesh
export {LiteMesh} from './lite-mesh/index.js'
