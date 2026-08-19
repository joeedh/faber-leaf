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
export type {IMaterialAttrConsumer, MaterialAttrRequest, VertexAttrDesc, VertexAttrShape} from './core/vertex_layout.js'
// Properties-editor panel contributions (§9). A leaf like the two above.
export {ANY_DATA_KIND} from './core/props_panels.js'
export type {IPropsPanel} from './core/props_panels.js'
// `core/data_kinds.ts` is deliberately NOT re-exported here: a kind is
// registered, not imported, so it goes through `AddonAPI.registerDataKind`.

// sceneobject/* and View3DOp — the base classes an addon's geometry type and
// its viewport ops extend.
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

export {ViewContext} from './core/context.js'
export type {ToolContext} from './core/context.js'
export {Node, NodeFlags, CallbackNode} from './core/graph.js'
export {DependSocket} from './core/graphsockets.js'
export {Material, DefaultMat, makeDefaultMaterial} from './core/material.js'
export {default as bus} from './core/bus.js'
export {EDGE_LINKED_LISTS} from './core/const.js'
export {registerOpaqueCustomDataElem} from './core/missing_addon.js'
export {registerFileMigrator, unregisterFileMigrator} from './core/file_migrations.js'
export type {IFileMigrationContext, IFileMigrator} from './core/file_migrations.js'
// Import/export formats (§9). `core/file_formats.ts` imports nothing at all,
// so the type can ride the hub without closing a cycle the way data_kinds would;
// registration itself still goes through `AddonAPI.registerFileFormat`.
export type {IFileFormat} from './core/file_formats.js'
export {setDefaultSceneBuilder} from './core/default_file.js'
// The app's own CLI flags: an addon that takes one (sculptcore's --backend)
// has to read it from the same place the host does.
export {getAppArgv, getArg, getArgList, hasArg} from './core/app_argv.js'
// Feature flags: the host defines none, addons register their own through
// `AddonAPI.registerFeatureFlags`, and read them back through `FeatureFlags`.
export {
  FeatureFlags,
  FeatureFlagManager,
  defineFeatureFlagMember,
  featureFlagApiName,
  type FeatureFlag,
} from './core/feature-flag.js'
export * as platform from './core/platform.js'

// webgl/*
export {ChunkedSimpleMesh, LayerTypes, PrimitiveTypes, SimpleMesh} from './webgl/simplemesh.js'
export * as simplemesh from './webgl/simplemesh.js'
export {Texture} from './webgl/webgl.js'
export type {IUniformsBlock, ShaderProgram} from './webgl/webgl.js'
export * as webgl from './webgl/webgl.js'
export {Shapes} from './webgl/simplemesh_shapes.js'

// webgpu/* — a provider that brings its own Drawable creates its own vertex
// buffers, so it needs the usage flags the DOM lib declares as types only,
// plus the buffer wrapper and pipeline cache its batch executor draws through.
export {BufferUsage, MapMode, ShaderStage, TextureUsage} from './webgpu/flags.js'
export {GpuBuffer} from './webgpu/buffer.js'
export type {GpuBufferUsage} from './webgpu/buffer.js'
export {Pipeline, PipelineCache} from './webgpu/pipeline.js'
export type {PipelineDescriptor} from './webgpu/pipeline.js'

// render/* — backend-agnostic DrawQueue dispatch
export {WebGLDrawQueueAdapter} from './render/queue.js'
export type {DrawQueue, FrameContext, Submission, Drawable} from './render/queue.js'

// shaders/*
export {Shaders, BasicLineShader, MeshIDShader, loadShader} from './shaders/shaders.js'

// editors/*
export {ToolMode} from './editors/view3d/view3d_toolmode.js'
// Every addon-owned toolmode has to return one of these from
// `toolModeDefine()`, so the shape rides the hub with the class.
export type {IToolModeDefine} from './editors/view3d/view3d_toolmode.js'
export {
  SelMask,
  SelOneToolModes,
  SelToolModes,
  // A persisted mask arrives as either names or an integer; every toolmode
  // that stores one needs both halves of that conversion.
  normalizeSelMask,
  selMaskToNames,
} from './core/select_types.js'
export {FindNearest, FindNearestRet, castViewRay, CastModes} from './editors/view3d/findnearest.js'
export type {ScreenPickResult} from './editors/view3d/findnearest.js'
// Routed through transform_ops.js rather than transform_types.js: the hub
// already depends on the former, and a direct edge to the latter closed cycles
// back when transform_types.ts still imported the BREP mesh addon.
export {TranslateOp, TransformOp} from './editors/view3d/transform/transform_ops.js'
// The transform-data interface itself, so a geometry addon can contribute a
// type instead of the host naming one. `TransformDefine` is the return type of
// a method every implementor must write, and `TransDataElem` / `TransDataList`
// are the two classes it must subclass, so all four travel together. Routed
// through transform_ops.js for the same reason as the ops above.
export {TransDataElem, TransDataList, TransDataType} from './editors/view3d/transform/transform_ops.js'
export type {ITransDataType, TransformDefine} from './editors/view3d/transform/transform_ops.js'
export {RotateWidget, ScaleWidget, TranslateWidget} from './editors/view3d/widgets/widget_tools.js'
export {Icons} from './editors/icon_enum.js'
export {ImageBus} from './editors/image/ImageBus.js'
export type {BoundingBox} from './editors/view3d/view3d_utils.js'
export type {View3D} from './editors/view3d/view3d.js'
export type {ImageEditor} from './editors/all.js'
export type {Scene} from './scene/scene.js'

// light, nullobject
export {Light} from './light/light.js'
export {NullObject} from './nullobject/nullobject.js'

// extern — jszip is side-effect imported by core/appstate.ts; no value exports.

// addon
export {default as addonManager} from './addon/addon.js'
export type {AddonAPI, IAddon, IAddonDefine} from './addon/addon_base.js'

// mathl
export {sym, binop, checksym, unaryop, call} from './mathl/transform/sym.js'
