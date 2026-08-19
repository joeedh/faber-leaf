import {
  Container,
  DataAPI,
  DataStruct,
  Matrix4,
  nstructjs,
  Vector2,
  Vector3,
  Vector4,
} from '../../../../scripts/path.ux/pathux'
import type {ListBoxChangeEvent} from '../../../../scripts/path.ux/pathux'
import type {ScreenPickResult} from '../../../../scripts/editors/view3d/findnearest'
import {FindNearestRet} from '../../../../scripts/editors/view3d/findnearest'
import type {ViewContext} from '../../../../scripts/core/context'
import {AttrSet} from './litemesh_attrSet'
import {AttrType} from './litemesh_base'
import {
  BoolAttribute,
  Float3Attribute,
  Int2Attribute,
  Int4Attribute,
  IntAttribute,
  ShortAttribute,
} from './litemesh_types'
import {SceneObjectData} from '../../../../scripts/sceneobject/sceneobject_base'
import {BlockLoader, BlockLoaderAddUser, DataBlock} from '../../../../scripts/core/lib_api'
import {SelMask} from '../../../../scripts/core/select_types'
import {NodeFlags} from '../../../../scripts/core/graph'
import {DrawBatch, MeshLog, SpatialTree, Mesh as WasmMesh} from '@sculptcore/api'
import type {Multires, VdmStore} from '@sculptcore/api'
import {getWasmImmediate, IWasmInterface} from '@sculptcore/api/api'
import type {RequestedAttrBridge} from '@sculptcore/api/api'
import type {RequestedAttrDesc} from '../../../../scripts/shadernodes/shader_nodes_wgsl'
import {LightGenWgsl, type IRenderLights} from '../../../../scripts/shadernodes/shader_lib_wgsl'
import type {IUniformsBlock} from '@framework/api'
import {WebGLBatchExecutor} from './gl_batch'
import type {View3D} from '../../../../scripts/editors/all'
import {SceneObject, ObjectFlags} from '../../../../scripts/sceneobject/index'
import {DrawModes, DrawFlags} from '../../../../scripts/sceneobject/drawmode'
import {Shaders} from '../../../../scripts/shaders/shaders'
import {GenericIsect} from '../../../../scripts/util/spatial'
import type {SculptCorePaintMode} from './sculptcore'
import type {DrawQueue, FrameContext} from '../../../../scripts/render/queue'
import {isWebGPU} from '../../../../scripts/core/renderer_flag'
import type {AssertExtends, IInvalidatable} from '../../../../scripts/core/geometry_contract'
import {GeometryCapability, InvalidationKind} from '../../../../scripts/core/geometry_contract'
import type {IDataKindDescriptor} from '../../../../scripts/core/data_kinds'
import {MATERIAL_BASE_VERTEX_ATTRS} from '../../../../scripts/core/vertex_layout'
import type {IGeometrySource} from '../../../../scripts/sceneobject/sceneobject_base'
import {
  getSerializeCacheMode,
  getDeferredBlobCollector,
  getDeferredBlobResolver,
} from '../../../../scripts/core/serialize_cache'
import {FeatureFlags} from '@framework/api'
import {makeBlobPlaceholder, readBlobPlaceholder} from '../../../../scripts/core/autosave_format'
import {getActiveWebGpuContext} from '../../../../scripts/render/queue_factory'
import {WebGPUBatchExecutor, type CommandBindGroup} from './gpu_batch'
import {UniformBindings} from '../../../../scripts/webgpu/uniform_bindings'
import {GpuTexture} from '../../../../scripts/webgpu/texture'
import {BufferUsage, TextureUsage} from '../../../../scripts/webgpu/flags'
import {
  stencilAmplify,
  tessFinalize,
  type StencilLevel,
  type TessTopoInputs,
  type TessVdmInputs,
} from '../../../../scripts/webgpu/stencil_compute'
import type {Pipeline} from '../../../../scripts/webgpu/pipeline'
import {wgslForSpatialShader} from './litemesh_wgsl'

/**
 * Which per-element attributes the LiteMesh surface is colored by in the
 * viewport. A bitmask — both can be active at once (the C++ side composites
 * the painted color modulated by the group color). Drives
 * `SpatialTree.setColorDisplayMode` (the C++ render color stream). View state
 * only — not serialized. Values mirror the C++ `displayColorMode` bitmask in
 * `spatial_gpu.cc`.
 */
export const LiteMeshDisplayMode = {
  VERTEX_COLOR: 1,
  POLY_GROUP  : 2,
} as const

/** Element domains (mirror the C++ `ElemType`, which isn't bound to TS). */
export const AttrDomain = {VERTEX: 1, EDGE: 2, CORNER: 4, LIST: 8, FACE: 16} as const
/** Default GPU-owner aggregation target (tris per draw command). 32k won the
 * 2026-07-15 empirical sweep on a 1.5M-vert mesh (2k..128k): lowest GPU frame
 * time framed AND zoomed, flat main-thread cost (dispatch is cached/bundled),
 * mid-pack dab + dirty-frame cost; 128k regressed uploads, 2k regressed
 * draw-call overhead. */
const DEFAULT_GPU_TRI_TARGET = 1 << 15

const ATTR_DOMAIN_LABEL: Record<number, string> = {1: 'vert', 2: 'edge', 4: 'corner', 8: 'list', 16: 'face'}
/** Bound `AttrType` integer values are the C++ bitflags (FLOAT=1, FLOAT4=8, …). */
const ATTR_TYPE_LABEL: Record<number, string> = {
  1   : 'Float',
  2   : 'Float2',
  4   : 'Float3',
  8   : 'Float4',
  16  : 'Bool',
  32  : 'Int',
  64  : 'Int2',
  128 : 'Int3',
  256 : 'Int4',
  512 : 'Byte',
  1024: 'Short',
}
/** `AttrUse` bitflags = the attribute's category/role (mirror of C++ AttrUse). */
export const AttrUseFlags = {NONE: 0, UNIT: 1, COLOR: 2, UV: 4, POLYGROUP: 8, SCULPT_LAYER: 32} as const

/** User-selectable attribute categories for the ObData dropdown (the brushable
 * subset of AttrUse + None). Values match AttrUseFlags so they pass straight to
 * the C++ `setAttrUse`. */
export const LiteMeshAttrCategory = {NONE: 0, COLOR: 2, UV: 4, POLYGROUP: 8} as const

/**
 * One mesh attribute, surfaced in the ObData attribute ListBox. `name` is the
 * composite row label (the ListBox labels by `.name`); `attrName`/`domain`/
 * `attrType`/`use` are the underlying fields the data-API + logic use.
 */
/**
 * Categories (AttrUse roles) a layer of the given type/domain may take, plus
 * NONE. Mirrors the Wave 2b valid-categories table; the ObData category
 * dropdown offers exactly this set, and `setAttrCategory` rejects anything
 * outside it. `type`/`domain` are the bound AttrType / LiteMesh AttrDomain ints.
 */
export function validCategories(type: number, domain: number): number[] {
  const out: number[] = [AttrUseFlags.NONE]
  if (domain === AttrDomain.VERTEX && type === AttrType.Float4) out.push(AttrUseFlags.COLOR)
  if (type === AttrType.Float2) out.push(AttrUseFlags.UV) // vertex now, corner later
  if (domain === AttrDomain.FACE && type === AttrType.Int) out.push(AttrUseFlags.POLYGROUP)
  return out
}

/** A LiteMesh area-pick hit (`ScreenPickResult.elements` entry): a mesh element
 * index tagged with the domain it indexes, so consumers can tell faces from
 * verts. */
export interface LiteMeshPickElem {
  type: 'vert' | 'face'
  index: number
}

export class LiteMeshAttrItem {
  constructor(
    public attrName: string,
    public domain: number,
    public attrType: number,
    public use: number,
    /** Index of this layer in its domain's full AttrGroup.attrs (the index
     * space the C++ setAttrUse / brush override consume). */
    public layerIndex: number = -1
  ) {}

  equals(b: this) {
    return (
      this.attrName === b.attrName &&
      this.domain === b.domain &&
      this.attrType === b.attrType &&
      this.use === b.use &&
      this.layerIndex === b.layerIndex
    )
  }

  get name(): string {
    const dom = ATTR_DOMAIN_LABEL[this.domain] ?? '?'
    const ty = ATTR_TYPE_LABEL[this.attrType] ?? '?'
    const cats: string[] = []
    if (this.use & AttrUseFlags.COLOR) cats.push('Color')
    if (this.use & AttrUseFlags.UV) cats.push('UV')
    if (this.use & AttrUseFlags.POLYGROUP) cats.push('PolyGroup')
    const cat = cats.length ? `   ·   ${cats.join('+')}` : ''
    return `${this.attrName}   ·   ${dom} ${ty}${cat}`
  }
}

/**
 * One sculpt layer, surfaced in the Sculpt Layers ListBox (V5 app wiring).
 * `index` is the engine settings index (== stack position); `name` is the
 * composite row label the ListBox displays.
 */
export class LiteMeshSculptLayerItem {
  constructor(
    public attrName: string,
    public index: number,
    public weight: number,
    public enabled: boolean,
    public frozen: boolean,
    /** Owning mesh backref so the DataList's getActive can reach
     * activeSculptLayer (callbacks only receive the raw item array). */
    public mesh?: LiteMesh
  ) {}

  equals(b: this) {
    return (
      this.attrName === b.attrName &&
      this.index === b.index &&
      this.weight === b.weight &&
      this.enabled === b.enabled &&
      this.frozen === b.frozen
    )
  }

  get name(): string {
    const state = `${this.enabled ? '' : '   ·   off'}${this.frozen ? '   ·   frozen' : ''}`
    return `${this.attrName}   ·   w ${this.weight.toFixed(2)}${state}`
  }
}

export class VertexData extends AttrSet {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.VertexData {}')

  constructor() {
    super()
  }

  get positions() {
    return this.attrs.get('positions') as Float3Attribute
  }
  get normals() {
    return this.attrs.get('normals') as Float3Attribute
  }
  get select() {
    return this.attrs.get('select') as BoolAttribute
  }
}

export class EdgeData extends AttrSet {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.EdgeData {}')

  constructor() {
    super()
  }

  get vs() {
    return this.attrs.get('.edge.vs') as Int2Attribute
  }
  get disk() {
    return this.attrs.get('.edge.vs.disk') as Int4Attribute
  }
  get select() {
    return this.attrs.get('.edge.select') as BoolAttribute
  }
  get c() {
    return this.attrs.get('.edge.c') as IntAttribute
  }
}

export class CornerData extends AttrSet {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.CornerData {}')
  constructor() {
    super()
    this.ensureAttr(AttrType.Int, '.corner.v')
    this.ensureAttr(AttrType.Int, '.corner.e')
    this.ensureAttr(AttrType.Int, '.corner.l')
    this.ensureAttr(AttrType.Int, '.corner.next')
    this.ensureAttr(AttrType.Int, '.corner.prev')
    this.ensureAttr(AttrType.Int, '.corner.radial_next')
    this.ensureAttr(AttrType.Int, '.corner.radial_prev')
  }
  get v() {
    return this.attrs.get('.corner.v') as IntAttribute
  }
  get e() {
    return this.attrs.get('.corner.e') as IntAttribute
  }
  get l() {
    return this.attrs.get('.corner.l') as IntAttribute
  }
  get next() {
    return this.attrs.get('.corner.next') as IntAttribute
  }
  get prev() {
    return this.attrs.get('.corner.prev') as IntAttribute
  }
  get radial_next() {
    return this.attrs.get('.corner.radial_next') as IntAttribute
  }
  get radial_prev() {
    return this.attrs.get('.corner.radial_prev') as IntAttribute
  }
}

/** Face boundary/hole list. */
export class ListData extends AttrSet {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.ListData {}')
  constructor() {
    super()
    this.ensureAttr(AttrType.Int, '.list.c')
    this.ensureAttr(AttrType.Int, '.list.f')
    this.ensureAttr(AttrType.Int, '.list.next')
    this.ensureAttr(AttrType.Int, '.list.size')
  }
  get c() {
    return this.attrs.get('.list.c') as IntAttribute
  }
  get f() {
    return this.attrs.get('.list.f') as IntAttribute
  }
  get next() {
    return this.attrs.get('.list.next') as IntAttribute
  }
  get size() {
    return this.attrs.get('.list.size') as IntAttribute
  }
}

export class FaceData extends AttrSet {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.FaceData {}')
  constructor() {
    super()
    this.ensureAttr(AttrType.Short, '.face.list_count')
    this.ensureAttr(AttrType.Int, '.face.list')
    this.ensureAttr(AttrType.Float3, '.face.normal')
  }
  get list_count() {
    return this.attrs.get('.face.list_count') as ShortAttribute
  }
  get list() {
    return this.attrs.get('.face.list') as IntAttribute
  }
  get normal() {
    return this.attrs.get('.face.normal') as Float3Attribute
  }
}

/**
 * Knobs for {@link LiteMesh.quadRemesh}. Every field is optional — omitted ones
 * keep the C++ `RemeshParams` defaults (the bound struct is default-constructed
 * first, so C++ stays the single source of truth). Field names mirror the C++
 * struct (camelCase here → snake_case there).
 */
export interface QuadRemeshOptions {
  /** Target output quad count; the edge length is derived from it (count mode,
   * best-effort). Ignored when targetEdgeLength > 0. */
  targetQuadCount?: number
  /** Explicit quad edge length (world units); 0 = derive from targetQuadCount. */
  targetEdgeLength?: number
  /** Align the cross field to principal-curvature directions. */
  useCurvature?: boolean
  /** Pin the field to sharp edges + open boundaries (creases stay on loops). */
  useSharpFeatures?: boolean
  /** Dihedral threshold (radians) above which an edge is tagged sharp. */
  sharpAngle?: number
  /** Scale quad spacing by 1/`.remesh.v.density` (host must paint the layer). */
  useDensity?: boolean
  /** Snap each output vertex back onto the input surface (off = debug). */
  reproject?: boolean
  /** Laplacian-smoothing passes interleaved with reprojection. */
  smoothIterations?: number
  /** Per-iteration smoothing step (0..1). */
  smoothStrength?: number
  /** Determinism seed (fixed input + seed → byte-identical output). */
  seed?: number
  /** Run input triage before the solve (weld near-coincident verts, drop
   * degenerate faces / tiny components, detect non-manifold). No-op on clean
   * input; defaults on. */
  triage?: boolean
  /** Triage weld tolerance as a fraction of the mesh bbox diagonal. */
  triageWeldRel?: number
  /** Triage: drop disconnected components below this fraction of total verts
   * (0 = keep all). */
  triageMinComponentFrac?: number
  /** Tier 2a: Jacobi-diffuse the per-vertex curvature tensor over the one-ring
   * before eigendecomposition, denoising the field without touching geometry.
   * 0 = today's raw 1-ring estimate (no smoothing). */
  curvatureSmoothIters?: number
  /** Tier 2a: per-sweep blend in [0,1] for the curvature tensor diffusion. */
  curvatureSmoothLambda?: number
  /** Tier 4: per-edge smoothness weight of the cross-field solve. Higher =
   * smoother field, fewer noise-born singularities, weaker curvature tracking. */
  fieldSmoothness?: number
  /** Tier 4: soft curvature-alignment scale (× local anisotropy) — the other
   * half of the smoothness/alignment tradeoff. */
  curvatureWeight?: number
  /** Tier 5: cancel +1/−1 singularity pairs closer than the gate by flipping
   * edge periods along the geodesic path between them, then re-solving. */
  singularityCancel?: boolean
  /** Tier 5: pair-separation gate in quad-edge-length units. */
  singularityCancelMaxSep?: number
  /** Tier 3a: generate the per-vertex sizing field from curvature (small quads at
   * high curvature). Implies density consumption. false = no auto field. */
  autoDensity?: boolean
  /** Tier 3a: clamp on the generated density (size range). */
  densityMin?: number
  densityMax?: number
  /** Tier 3b: bound the size-field growth rate so quads don't shear across a
   * steep density step. 0 = off. Typical 0.3–1.0. */
  densityGradation?: number
  /** Tier 3b: gradation-limiter relaxation sweep cap. */
  densityGradationIters?: number
  /** Tier 9d: field-aligned input pre-remesh — clean the working triangulation's
   * flow before the field solve. Geometry only; reprojection still targets the
   * full-res original. false = pipeline unchanged. */
  preRemesh?: boolean
  /** Pre-pass edge length. 0 = auto (from the resolved quad edge length). */
  preRemeshTarget?: number
  /** Outer convergence iterations. 0 = auto from the measured input. */
  preRemeshIters?: number
  /** Drive the pre-pass band from the curvature size field (regenerating it
   * overwrites a painted density map on the working copy). */
  preRemeshDensity?: boolean
  /** Growth cap on the pre-pass size field; 0 = off. */
  preRemeshGradation?: number
  preRemeshGradationIters?: number
  /** Pre-pass smooth blend: 0 isotropic ↔ 1 field-aligned. */
  preRemeshAlign?: number
  /** Recompute the rough cross field every N outer iters. */
  preRemeshFieldCadence?: number
  /** Isotropic denoise sweeps before the field is trusted; -1 = auto from input
   * noise, 0 = none. */
  preRemeshBootstrapIters?: number
  /** Inner field-aligned smooth sweeps per outer iter + relaxation factor. */
  preRemeshSmoothIters?: number
  preRemeshSmoothLambda?: number
  /** Early-out once an outer iter moves every vertex < eps·target; 0 = off. */
  preRemeshConvergeEps?: number
  /** Pin boundary loops + dihedral-sharp creases through the pre-pass. */
  preRemeshPreserveFeatures?: boolean
  preRemeshSharpAngle?: number
}

/** The box-modeling selection surface of the shared C++ MeshLog (bound methods
 * added to `sculptcore::meshlog::MeshLog`). Declared here because the generated
 * `@sculptcore/api` MeshLog handle type isn't regenerated until `genTS` runs;
 * the selection ops and LiteMesh.select* cast the shared meshLog to this. The
 * `m`/`tree`/`co`/`ray` args are opaque bound handles (Mesh / SpatialTree /
 * float3). `domain` is 0 = vertex, 1 = edge, 2 = face. */
export interface IMeshLogSelect {
  selectionBeginStep(): void
  selectionEndStep(): void
  selectOne(m: unknown, domain: number, idx: number, state: boolean): void
  /** `indices` is a bound Vector<int> handle, NOT a JS array — the generated
   * signature says `int32[]` but the binding runtime rejects a plain array
   * ("missing litestl::util::Vector binding"). Build one via _intVecOut(). */
  selectIndices(m: unknown, domain: number, indices: unknown, state: number): void
  selectAllElems(m: unknown, domain: number, state: number): void
  selectShortestPath(m: unknown, vEnd: number, state: number): number
  /** kind 0 = edge loop, 1 = edge ring, 2 = face loop; seeded at an edge. A
   * fully-selected loop toggles off; returns the negated count when it did. */
  selectLoop(m: unknown, seedEdge: number, kind: number, state: number): number
  selectScreenCircle(
    m: unknown,
    tree: unknown,
    co: unknown,
    ray: unknown,
    r1: number,
    r2: number,
    domain: number,
    state: number
  ): void
  selectScreenRect(
    m: unknown,
    tree: unknown,
    near0: unknown,
    near1: unknown,
    near2: unknown,
    near3: unknown,
    far0: unknown,
    far1: unknown,
    far2: unknown,
    far3: unknown,
    domain: number,
    state: number
  ): void
  setActiveElem(domain: number, idx: number): void
  activeVert(): number
  activeEdge(): number
  activeFace(): number
  lastStepId(): number
  /** Mirrors the sculptcore.select_flush_prefer_op_domain feature flag into the
   * C++ macro-ops (selection-domain derivation; see selectFlush plan). */
  selectFlushPreferOpDomain: boolean
}

export class LiteMesh extends SceneObjectData {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.LiteMesh {
      _data             : arraybuffer(byte) | this.serialize();
      repairLog         : array(string);
      _displayColorMode : int;
      _vdmData          : arraybuffer(byte) | this.serializeVdm();
      _mrData           : arraybuffer(byte) | this.serializeMultires();
      _mrLevels         : int | this.multiresLevels;
      _mrActiveLevel    : int | this.multiresLevel;
      saveTempAttrs     : bool;
    }
    `
  )

  static nodedef() {
    return {
      name   : 'litemesh',
      uiname : 'LiteMesh',
      flag   : NodeFlags.SAVE_PROXY,
      inputs : {...super.nodedef().inputs},
      outputs: {...super.nodedef().outputs},
    }
  }

  static blockDefine() {
    return {
      typeName   : 'litemesh',
      defaultName: 'LiteMesh',
      uiName     : 'LiteMesh',
      flag       : 0,
      icon       : -1,
    }
  }

  static dataDefine() {
    return {
      name          : 'LiteMesh',
      selectMask    : SelMask.MESH,
      selectTypeName: 'MESH',
      tools         : undefined,
      dataKind      : 'litemesh',
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const mstruct = SceneObjectData.defineAPI(api, struct ?? api.mapStruct(this, true)) as DataStruct<
      ViewContext,
      LiteMesh
    >

    const def = mstruct
      .flags(
        'displayColorMode',
        'displayColorMode',
        LiteMeshDisplayMode,
        'Display',
        'Attributes shown on the LiteMesh surface (combinable)'
      )
      .uiNames({
        VERTEX_COLOR: 'Vertex Color',
        POLY_GROUP  : 'Poly Groups',
      })
    def.on('change', function () {
      window.redraw_viewport()
    })

    mstruct
      .string('', 'faceCount', 'Face Count', '')
      .readOnly()
      .customGet(function () {
        const count = '' + this.dataref.mesh.f.count
        let s = ''
        for (let i = 0; i < count.length; i++) {
          const i2 = count.length - i
          if (i2 % 3 === 0 && i2 > 0) s += ','
          s += count[i]
        }
        return s.trim()
      })

    // ObData attribute manager (Wave 2b). The attribute ListBox binds to this
    // `attrs` DataList; `showBuiltinAttrs` toggles the builtin filter.
    mstruct.bool('showBuiltinAttrs', 'showBuiltinAttrs', 'Show builtin attributes').on('change', function () {
      window.redraw_all?.()
    })

    mstruct.bool(
      'saveTempAttrs',
      'saveTempAttrs',
      'Save Temp Attributes',
      'Debug: saved files include ALL attribute layers, even the transient (TEMP) ones normally dropped'
    )

    // Category (AttrUse) of the attr selected in the ListBox. The setter rejects
    // roles invalid for the attr's type/domain (validCategories), so offering the
    // full set here is safe; setting a role also activates the layer.
    mstruct
      .enum(
        'selectedAttrCategory',
        'selectedAttrCategory',
        LiteMeshAttrCategory,
        'Category',
        'Attribute category / role'
      )
      .uiNames({NONE: 'None', COLOR: 'Color', UV: 'UV', POLYGROUP: 'Poly Group'})
      .on('change', function () {
        window.redraw_all?.()
      })

    const astruct = api.mapStruct(LiteMeshAttrItem, true)
    astruct.string('attrName', 'attrName', 'Name').readOnly()

    // list(valueProp, apiPathSegment, funcs): value read from mesh.attrItems,
    // addressed in the data API as `object.data.attrs`.
    mstruct.list('attrItems', 'attrs', {
      getIter(api: DataAPI, list: LiteMeshAttrItem[]) {
        return list
      },
      getLength(api: DataAPI, list: LiteMeshAttrItem[]) {
        return list.length
      },
      get(api: DataAPI, list: LiteMeshAttrItem[], key: number) {
        return list[key]
      },
      getKey(api: DataAPI, list: LiteMeshAttrItem[], obj: LiteMeshAttrItem) {
        return list.indexOf(obj)
      },
      getStruct(api: DataAPI, list: LiteMeshAttrItem[], key: number) {
        return api.mapStruct(LiteMeshAttrItem)
      },
    })

    // Sculpt-layer stack (displacementAndSubSurf.md V5). The panel's ListBox
    // binds to `sculptLayers`; the weight/enabled/frozen props proxy the ACTIVE
    // layer and commit through the undoable litemesh.sculpt_layer_* ToolOps.
    const lstruct = api.mapStruct(LiteMeshSculptLayerItem, true)
    lstruct.string('attrName', 'attrName', 'Name').readOnly()

    mstruct.list('sculptLayerItems', 'sculptLayers', {
      getIter(api: DataAPI, list: LiteMeshSculptLayerItem[]) {
        return list
      },
      getLength(api: DataAPI, list: LiteMeshSculptLayerItem[]) {
        return list.length
      },
      get(api: DataAPI, list: LiteMeshSculptLayerItem[], key: number) {
        return list[key]
      },
      getKey(api: DataAPI, list: LiteMeshSculptLayerItem[], obj: LiteMeshSculptLayerItem) {
        return list.indexOf(obj)
      },
      getStruct(api: DataAPI, list: LiteMeshSculptLayerItem[], key: number) {
        return api.mapStruct(LiteMeshSculptLayerItem)
      },
      // Read-only active mirror: the layer ListBox highlights the layer the
      // sculpt_layer_* ops select (write side stays the panel's click handler).
      getActive(api: DataAPI, list: LiteMeshSculptLayerItem[]) {
        const mesh = list.length > 0 ? list[0].mesh : undefined
        const li = mesh?.activeSculptLayer ?? -1
        return li >= 0 && li < list.length ? list[li] : undefined
      },
    })

    /* Commit an active-layer mutation as a ToolOp. Weight drags arrive as a
     * setter call per slider tick; merging same-op-same-layer heads through
     * execOrRedo collapses a drag to a single undo entry. */
    const execLayerTool = (ctx: ViewContext, path: string, inputs: Record<string, unknown>, merge: boolean) => {
      const tool = ctx.api.createTool(ctx, `${path}()`, inputs)
      const head = ctx.toolstack.head
      const headPath = head ? (head.constructor as unknown as {tooldef(): {toolpath: string}}).tooldef().toolpath : ''
      const sameTarget = merge && headPath === path && (head!.getInputs() as {layer?: number}).layer === inputs.layer
      if (sameTarget) {
        ctx.toolstack.execOrRedo(ctx, tool)
      } else {
        ctx.toolstack.execTool(ctx, tool)
      }
    }

    mstruct
      .float('', 'activeSculptLayerWeight', 'Weight', 'Active sculpt layer weight')
      .noUnits()
      .range(-2, 2)
      .decimalPlaces(2)
      .customGetSet<LiteMesh>(
        function () {
          const mesh = this.dataref
          const li = mesh.activeSculptLayer
          return li < 0 ? 1.0 : mesh.layerWeight(li)
        },
        function (value: number) {
          const mesh = this.dataref
          const li = mesh.activeSculptLayer
          // `this.ctx` is the root context path.ux binds onto the accessor;
          // its static type is bare, so narrow it here.
          const ctx = this.ctx as unknown as ViewContext
          if (li < 0 || !ctx) return
          // The edit target's weight is pinned to 1 (sculptLayersV2) — the
          // slider is read-only while the layer is targeted.
          if (mesh.layerEditTarget() === li) return
          execLayerTool(ctx, 'litemesh.sculpt_layer_set_weight', {layer: li, weight: value}, true)
        }
      )

    // V2 edit-target toggle: while checked, sculpting records into this layer
    // (weight pinned 1; the weight/enabled/frozen controls are inert on it).
    mstruct
      .bool('', 'activeSculptLayerEditTarget', 'Edit Target', 'Record sculpting into the active sculpt layer')
      .customGetSet<LiteMesh>(
        function () {
          const mesh = this.dataref
          const li = mesh.activeSculptLayer
          return li >= 0 && mesh.layerEditTarget() === li
        },
        function (value: boolean) {
          const mesh = this.dataref
          const li = mesh.activeSculptLayer
          const ctx = this.ctx as unknown as ViewContext
          if (li < 0 || !ctx) return
          const target = mesh.layerEditTarget()
          if (value === (target === li)) return
          // A frozen layer cannot be the edit target (engine refuses it too).
          if (value && mesh.layerFrozen(li)) return
          execLayerTool(ctx, 'litemesh.sculpt_layer_set_target', {layer: value ? li : -1}, false)
        }
      )

    const flagProp = (apiname: string, uiname: string, kind: number, read: (mesh: LiteMesh, li: number) => number) => {
      mstruct.bool('', apiname, uiname, `Active sculpt layer ${uiname.toLowerCase()}`).customGetSet<LiteMesh>(
        function () {
          const mesh = this.dataref
          const li = mesh.activeSculptLayer
          return li >= 0 && read(mesh, li) !== 0
        },
        function (value: boolean) {
          const mesh = this.dataref
          const li = mesh.activeSculptLayer
          const ctx = this.ctx as unknown as ViewContext
          if (li < 0 || !ctx) return
          // Inert on the edit target (disabling/freezing it would silently end
          // the edit engine-side): clear the target first.
          if (mesh.layerEditTarget() === li) return
          execLayerTool(ctx, 'litemesh.sculpt_layer_set_flag', {layer: li, kind, value}, false)
        }
      )
    }
    flagProp('activeSculptLayerEnabled', 'Enabled', 0, (mesh, li) => (mesh.layerEnabled(li) ? 1 : 0))
    flagProp('activeSculptLayerFrozen', 'Frozen', 1, (mesh, li) => (mesh.layerFrozen(li) ? 1 : 0))

    // Multires (displacementAndSubSurf S): the level slider commits through the
    // undoable litemesh.multires_set_level op; drags merge to one undo entry.
    mstruct
      .int('', 'multiresLevel', 'Level', 'Active multires edit level (0 = no stack)')
      .noUnits()
      .range(1, 16)
      .customGetSet<LiteMesh>(
        function () {
          return this.dataref.multiresLevel
        },
        function (value: number) {
          const mesh = this.dataref
          const ctx = this.ctx as unknown as ViewContext
          if (!mesh.multiresActive || !ctx) return
          const level = Math.min(Math.max(Math.round(value), 1), mesh.multiresLevels)
          if (level === mesh.multiresLevel) return
          execLayerTool(ctx, 'litemesh.multires_set_level', {level}, true)
        }
      )
    mstruct
      .int('multiresLevels', 'multiresLevels', 'Levels', 'Multires stack depth (0 = no stack)')
      .noUnits()
      .readOnly()
    // X3 tessellated tier: draw the render level GPU-amplified (+ VDM applied
    // at the verts) while editing a coarser one. Pure view state - no undo.
    mstruct.bool(
      'tessellatedDisplay',
      'tessellatedDisplay',
      'Displaced Preview',
      'Draw the finest multires level (with VDM displacement) while editing a coarser one'
    )

    return mstruct
  }

  /**
   * Object Data ("ObData") properties tab — LiteMesh settings reachable
   * outside the sculptcore toolmode. Currently the surface display mode
   * (vertex color vs poly groups); attribute info + add/remove controls will
   * live here too. Bound through the data-API struct in
   * `api_define_litemesh` (see the note there re: future static defineAPI).
   */
  static buildPropertiesTab(container: Container<ViewContext>) {
    container.label('LiteMesh')

    const display = container.panel('Display')
    display.prop('object.data.displayColorMode')

    const attrs = container.panel('Attributes')
    attrs.prop('object.data.showBuiltinAttrs')
    // pathux ListBox bound to the attribute DataList (api_define_litemesh).
    const listbox = document.createElement('listbox-x')
    listbox.setAttribute('datapath', 'object.data.attrs')
    // Clicking a categorized row makes that attr the active layer for its
    // category (color/poly-group/UV) — the sculptcore bridge then points the
    // matching brush at it. The ListBox fires a `ListBoxChangeEvent` whose
    // `selection.id` is the data-list key (here `attrItems.indexOf(row)`, see
    // the `attrs` list in api_define.js) and whose `selection.item` is the
    // ListItem *widget*, not our row — so resolve the id against attrItems.
    listbox.addEventListener('change', (e: Event) => {
      const id = (e as ListBoxChangeEvent).selection?.id
      const mesh = container.ctx?.object?.data
      if (typeof id === 'number' && mesh instanceof LiteMesh) {
        const item = mesh.attrItems[id]
        if (item) {
          mesh.setSelectedAttrFromItem(item)
          mesh.setActiveAttrFromItem(item)
          window.redraw_all?.()
        }
      }
    })
    attrs.add(listbox as unknown as Container<ViewContext>)

    // Category dropdown for the selected attr (Wave 2b). The enum offers all
    // roles; selectedAttrCategory's setter rejects any not valid for the attr's
    // type/domain (validCategories). Setting a role also activates the layer.
    attrs.prop('object.data.selectedAttrCategory')

    // Add / Remove (Wave 2b) run through ToolOps (litemesh.add_attr /
    // remove_attr) so they're undoable. Add picks a (domain, type, category)
    // per the valid-categories table and lets C++ assign a unique name; Remove
    // deletes the selected layer (C++ refuses builtins). Args are the AttrDomain
    // / AttrType / AttrUseFlags ints.
    const C = AttrDomain.VERTEX
    const F = AttrDomain.FACE
    attrs.tool(`litemesh.add_attr(domain=${C} type=${AttrType.Float4} use=${AttrUseFlags.COLOR})`, {label: 'Add Color'})
    attrs.tool(`litemesh.add_attr(domain=${C} type=${AttrType.Float2} use=${AttrUseFlags.UV})`, {label: 'Add UV'})
    attrs.tool(`litemesh.add_attr(domain=${F} type=${AttrType.Int} use=${AttrUseFlags.POLYGROUP})`, {
      label: 'Add Poly Group',
    })
    attrs.tool('litemesh.remove_attr()', {label: 'Remove Selected'})

    // Sculpt-layer stack (sculptLayersV2), feature-flagged (takes effect on
    // restart). Clicking a row selects it; "Edit Target" makes it the layer
    // sculpting records into (litemesh.sculpt_layer_set_target — any brush,
    // dyntopo, GPU strokes). Weight/enabled/frozen commit through the
    // litemesh.sculpt_layer_* ops and are inert while the layer is targeted.
    if (FeatureFlags.get('sculptcore.sculpt_layers')) {
      const layers = container.panel('Sculpt Layers')
      const layerBox = document.createElement('listbox-x')
      layerBox.setAttribute('datapath', 'object.data.sculptLayers')
      layerBox.addEventListener('change', (e: Event) => {
        const id = (e as ListBoxChangeEvent).selection?.id
        const mesh = container.ctx?.object?.data
        if (typeof id === 'number' && mesh instanceof LiteMesh) {
          mesh.activeSculptLayer = id
          window.redraw_all?.()
        }
      })
      layers.add(layerBox as unknown as Container<ViewContext>)

      layers.prop('object.data.activeSculptLayerEditTarget')
      const weightWidget = layers.prop('object.data.activeSculptLayerWeight')
      const row = layers.row()
      const enabledWidget = row.prop('object.data.activeSculptLayerEnabled')
      const frozenWidget = row.prop('object.data.activeSculptLayerFrozen')

      // The weight/enabled/frozen setters are inert while the active layer is
      // the edit target — gray the widgets out so that state is visible.
      const activeIsEditTarget = (): boolean => {
        const mesh = container.ctx?.object?.data
        if (!(mesh instanceof LiteMesh)) {
          return false
        }
        const li = mesh.activeSculptLayer
        return li >= 0 && mesh.layerEditTarget() === li
      }
      for (const w of [weightWidget, enabledWidget, frozenWidget]) {
        const widget = w as unknown as {disabled: boolean; updateAfter(cb: () => void): void} | undefined
        widget?.updateAfter(() => {
          const disable = activeIsEditTarget()
          if (widget.disabled !== disable) {
            widget.disabled = disable
          }
        })
      }
      layers.tool('litemesh.sculpt_layer_add()', {label: 'Add Layer'})
      layers.tool('litemesh.sculpt_layer_remove()', {label: 'Remove Active'})
    }

    // Multires stack (displacementAndSubSurf S), feature-flagged (takes effect
    // on restart). Level drags commit through litemesh.multires_set_level (one
    // undo entry per drag); the buttons run the undoable multires_* ops and
    // no-op when the stack state doesn't match (enable ↔ already enabled, etc).
    if (FeatureFlags.get('sculptcore.multires')) {
      const multires = container.panel('Multires')
      multires.prop('object.data.multiresLevel')
      multires.prop('object.data.multiresLevels')
      multires.prop('object.data.tessellatedDisplay')
      multires.tool('litemesh.multires_enable()', {label: 'Enable (2 levels)'})
      multires.tool('litemesh.multires_enable(levels=4)', {label: 'Enable (4 levels)'})
      multires.tool('litemesh.multires_down_refit()', {label: 'Refit Level Below'})
      multires.tool('litemesh.multires_delete()', {label: 'Delete Stack'})
    }

    // VDM displacement sculpting (displacementAndSubSurf X3 stage 4),
    // feature-flagged (takes effect on restart). Enable/Delete run the
    // undoable litemesh.vdm_* ops; with a store attached, Draw dabs splat
    // texels instead of moving vertices.
    if (FeatureFlags.get('sculptcore.vdm_sculpt')) {
      const vdm = container.panel('VDM Displacement')
      vdm.tool('litemesh.vdm_enable()', {label: 'Enable VDM'})
      vdm.tool('litemesh.vdm_apply()', {label: 'Apply to Mesh'})
      vdm.tool('litemesh.vdm_capture()', {label: 'Capture to VDM'})
      vdm.tool('litemesh.vdm_delete()', {label: 'Delete VDM'})
    }

    // Reorder the mesh's element arrays into BVH depth-first order so sculpting
    // and dyntopo touch cache-coherent memory. Undoable via the shared MeshLog.
    const layout = container.panel('Layout')
    layout.tool('litemesh.reorder_locality()', {label: 'Optimize Mesh Layout'})
    layout.tool('litemesh.rebuild_spatial_tree()', {label: 'Rebuild Spatial Tree'})
  }

  afterSTRUCT(): void {
    super.afterSTRUCT()
  }

  dataLink(getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    return super.dataLink(getblock, getblock_addUser)
  }

  loadSTRUCT(reader: nstructjs.StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)

    if (this._data instanceof ArrayBuffer || this._data?.length) {
      let data: Uint8Array = new Uint8Array(this._data)
      // M3 autosave split files embed an 8-byte placeholder; resolve it to the
      // SCULPT00 blob held in the container's blob table (see autosave_format.ts).
      const blobId = readBlobPlaceholder(data)
      if (blobId >= 0) {
        const resolved = getDeferredBlobResolver()?.(blobId)
        if (!resolved) {
          console.warn('litemesh: autosave blob', blobId, 'missing; loading default cube')
          this.mesh = this.wasm.Mesh_createCube(120, 1.0, 1.0)
          this._initSpatial()
          this._data = undefined
          return
        }
        data = resolved
      }
      this.mesh = this.wasm.Mesh_deserialize(data)
      // A saveTempAttrs file carries stroke-transient stamps whose generation
      // counters reset with the session — stale stamps would alias fresh
      // strokes (reused mask factors / orig positions / meshlog capture
      // elision). The file keeps them for offline analysis; the live session
      // must not consume them.
      const nTemp = (this.mesh as unknown as {dropTempAttrs(): number}).dropTempAttrs()
      if (nTemp > 0) {
        console.log(`litemesh: dropped ${nTemp} loaded TEMP attribute layer(s)`)
      }
      // Repair any structural corruption baked into the saved file before the
      // spatial tree is built or any op runs on it (#37). Cheap (returns 0
      // without rebuilding) on a healthy mesh.
      const nErr = (this.mesh as unknown as {repairMesh(): number}).repairMesh()
      if (nErr > 0) {
        this.repairLog.push(`[load] repaired ${nErr} mesh-structure error(s) (details in console)`)
        ;(this.mesh as unknown as {clearRepairLog(): void}).clearRepairLog()
      }
    } else {
      // Legacy / empty block (saved before mesh serialization was wired): fall
      // back to a default cube so the file still loads with geometry.
      this.mesh = this.wasm.Mesh_createCube(120, 1.0, 1.0)
    }
    this._initSpatial()
    this._data = undefined

    // Multires stack (X4 stage 3): rebuild the refinement from the cage —
    // topology-compatible by construction — then restore the saved grids
    // store + re-attach the saved level (the delete-op undo pattern).
    const mrLevels = (this._mrLevels as number | undefined) ?? 0
    const mrBytes = this._mrData ? new Uint8Array(this._mrData) : undefined
    if (mrLevels > 0 && mrBytes?.length && this.multiresEnable(mrLevels)) {
      const level = Math.min(Math.max((this._mrActiveLevel as number | undefined) ?? mrLevels, 1), mrLevels)
      this.multiresRestoreStoreBlob(mrBytes, level)
    }
    this._mrData = undefined

    // VDM store: params + Ptex tables ride the blob, so deserialize +
    // re-attach (carrier tags + frames) is the whole restore.
    const vdmBytes = this._vdmData ? new Uint8Array(this._vdmData) : undefined
    if (vdmBytes?.length) {
      const store = this.wasm.VdmStore_deserializeBlob(vdmBytes)
      if (store) this.vdmReattach(store)
    }
    this._vdmData = undefined
  }

  private needsBoundsUpdate = true
  private cachedBounds = [new Vector3(), new Vector3()]

  // Assigned in the constructor, or (deferInit path) in loadSTRUCT.
  mesh!: WasmMesh
  spatial!: SpatialTree
  wasm: IWasmInterface
  drawBatch?: DrawBatch
  treeBatch?: DrawBatch
  /** Persistent seam-edge overlay (EDGE_SEAM) line batch + its rebuild flag.
   * Rebuilt only when the seam set or geometry changes (see markSeamsDirty). */
  seamBatch?: DrawBatch
  /** Box-modeling selection overlay batch (selected verts/edges/faces + active)
   * + its rebuild flag and cached active-element indices. Rebuilt only when the
   * selection or active element changes (see markSelectionDirty). */
  selectionBatch?: DrawBatch
  _selectionDirty = true
  private _selActive: [number, number, number] = [-1, -1, -1]
  private _selHover: [number, number, number] = [-1, -1, -1]
  private lastAttrItems: LiteMeshAttrItem[] = []
  _seamsDirty = true
  /** Box-modeling wireframe overlay batch (every edge as a dim line). Rebuilt
   * when the mesh geometry/topology revision advances (see `_wireframeRev`). */
  wireframeBatch?: DrawBatch
  private _wireframeRev = -1
  /** Box-modeling billboard vertex-point overlay batch. Rebuilt on revision
   * change, like the wireframe. */
  pointsBatch?: DrawBatch
  private _pointsRev = -1
  /** Object-AABB 12-edge line box (BOUNDS draw mode + object-mode selection
   * overlay; tinted via uColor). Rebuilt on geometry-revision change. */
  boundsBatch?: DrawBatch
  private _boundsRev = -1
  drawBatchExecutor?: WebGLBatchExecutor
  drawBatchExecutorGPU?: WebGPUBatchExecutor
  /** Separate GPU executor for the box-modeling overlays (selection / wireframe /
   * points) so they can honor the toolmode xray toggle independently of the tree
   * surface: depthCompare 'always' (see-through) vs 'less-equal'. Rebuilt when the
   * xray state flips (`_overlayXray`). */
  private overlayExecutorGPU?: WebGPUBatchExecutor
  private _overlayXray = false
  /** cullMode baked into the surface executor's pipelines; a
   * `sculptcore.backface_cull` flag flip rebuilds the executor. */
  private _surfaceBackfaceCull = false
  private gpuUniforms?: IUniformsBlock
  /** Per-pipeline reflected uniform bindings for the GPU draw path. Kept on the
   * instance (not a closure WeakMap) so `setDrawShader` can dispose them when a
   * material-graph edit swaps in new WGSL — the pipeline cache is keyed on the
   * (stable) ShaderDef pointer, so without explicit invalidation the executor
   * would keep the stale pipeline/bindings. */
  private gpuBindingsCache = new Map<Pipeline, UniformBindings>()
  /** True once `setDrawShader` installed a real material WGSL on the spatial
   * tree (M6). The viewport draw then provides the material's full uniform set
   * (frame/object/lights across @group 0/1/2) instead of the basic-shader
   * single @group(0) block — see `drawQ` / `drawQGPU`. */
  private _hasMaterialDrawShader = false
  /** Texture view/sampler for the solid-mode textured draw shader, seeded per
   * frame by the non-render pass (view3d_draw_webgpu). Merged into the draw
   * uniforms so UniformBindings can bind `solidtex_tex`/`solidtex_smp`. */
  solidTexUniforms?: Record<string, unknown>
  /** VDM fragment-render state (displacementAndSubSurf V3): the attached (and
   * owned) sculptcore VdmStore plus its GPU residency — the rgba32float tile
   * atlas, the r32sint page table, and the last-uploaded layout ints. Synced
   * per frame in `_syncVdmGpu` via the store's dirty-slot drain. */
  private _vdmStore?: VdmStore
  private _vdmAtlasTex?: GpuTexture
  private _vdmPageTex?: GpuTexture
  private _vdmLayout?: number[]
  private _vdmWarnedSync = false
  /** Multires stack (displacementAndSubSurf S): when set, `mesh`/`spatial` are
   * NON-owning views of the active level's slot (the C++ stack owns them) and
   * the original mesh is parked as `_multiresCage`. Not serialized — saving
   * while active captures the flattened active level. */
  _multires?: Multires
  _multiresCage?: WasmMesh
  /** Save-stream carriers (X4 stage 3); consumed + cleared by loadSTRUCT. */
  _vdmData?: ArrayBuffer | Uint8Array
  _mrData?: ArrayBuffer | Uint8Array
  _mrLevels?: number
  _mrActiveLevel?: number
  /** Serialized mesh blob, populated only during `loadSTRUCT` (a plain byte
   * array from nstructjs); cleared once the mesh is rebuilt. */
  _data?: number[] | Uint8Array | ArrayBuffer
  /** Coarse "mesh changed" counter for the autosave blob cache (M2). Bumped
   * whenever the spatial tree flushed pending geometry/attribute changes, plus
   * at the topology-replacing entry points. A missed bump only stales an
   * autosave backup (app.save bypasses the cache), and a spurious bump only
   * costs one recompress — so coarse is safe. */
  meshRevision = 0
  /** Last serialize() result keyed by meshRevision; reused in cache mode. */
  private _blobCache?: {revision: number; blob: Uint8Array}
  /** Viewport surface color source (see LiteMeshDisplayMode). View state only,
   * not serialized — defaults to VERTEX_COLOR on load. Mirrors the C++
   * SpatialTree.displayColorMode (which TS can't read back). */
  _displayColorMode: number = LiteMeshDisplayMode.VERTEX_COLOR

  /** Serialized log of mesh-structure repairs (validateAndRepair on a detected
   * dyntopo fault, #37). Each entry is prefixed with the brush context by the
   * sculpt op; the detailed per-error lines go to the console. Capped to keep
   * the file small. */
  repairLog: string[] = []

  /** Debug/repro saves: serialize the engine mesh with ALL attribute layers,
   * including the TEMP ones a normal save drops (brush orig/automask stamps,
   * spatial ownership, boundary overlays). Bypasses the blob caches — TEMP
   * layers change without bumping meshRevision. */
  saveTempAttrs = false

  // Renderable through the material pipeline: in SHOW_RENDER mode the
  // RealtimeEngine BasePass only pushes setRequestedAttrs/setDrawShader to
  // objects whose usesMaterial is set, and drawObjects() only defers to the
  // engine for them. Without this the LiteMesh renders with the basic shader.
  usesMaterial = true

  constructor(wasmMesh?: WasmMesh, deferInit = false) {
    super()

    // this code cannot run before wasm loads
    this.wasm = getWasmImmediate()!

    // `deferInit` is set by `newSTRUCT` when nstructjs is about to deserialize:
    // skip building the throwaway default cube — `loadSTRUCT` reconstructs the
    // real mesh from the blob.
    if (deferInit) {
      return
    }

    this.mesh = wasmMesh ?? this.wasm.Mesh_createCube(2, 1.0, 1.0)
    this._initSpatial()
  }

  /** nstructjs instance factory — bypass the default-cube build (see ctor). */
  static newSTRUCT(): LiteMesh {
    return new LiteMesh(undefined, /*deferInit=*/ true)
  }

  /** Build the spatial tree + draw batches over `this.mesh`. Shared by the
   * constructor and the deserialization path. */
  private _initSpatial(): void {
    // Aggregation target (tris) per GPU owner node — the draw-command count is
    // ~totalTris/target. Overridable for perf experiments via the global
    // (rebuildSpatialFromEdit() applies it to a live mesh).
    const gpuTriTarget =
      (globalThis as unknown as {__SC_GPU_TRI_TARGET?: number}).__SC_GPU_TRI_TARGET ?? DEFAULT_GPU_TRI_TARGET
    this.spatial = this.wasm.Mesh_buildSpatialTree(this.mesh, 1024, 32, gpuTriTarget)
    this.spatial.update(this.wasm.gpu)
    this.spatial.setColorDisplayMode(this._displayColorMode)
    this.drawBatch = this.spatial.getDrawBatch()
    this.treeBatch = this.spatial.buildLeafBoundsBatch(this.wasm.gpu)
  }

  /** True once the mesh has at least one n-gon (>3-sided) face — the triangulate
   * button uses it to gate itself, and the viewport tip overlay to decide whether
   * to suggest triangulating a large mesh. Routes through the backend-agnostic
   * `Mesh_ngonFaceCount` helper (an exact live counter; 0 == all-triangles) so it
   * works on WASM, whose `.ptr` handle exposes no struct methods. */
  hasNgons(): boolean {
    return this.wasm.Mesh_ngonFaceCount(this.mesh) > 0
  }

  /** Fan-triangulate every n-gon in place and rebuild the spatial tree cleanly.
   * Returns false (nothing to do) when the mesh is already all-triangles. The
   * clean rebuild matters: incrementally triangulating leaves the quad-built BVH
   * unbalanced, which is what made dyntopo slow on quad meshes. */
  triangulate(): boolean {
    this.wasm.Mesh_triangulate(this.mesh)
    this._rebuildSpatial()
    return true
  }

  /** Reorder mesh elements for cache locality, recording an undoable reorder step
   * on the shared `meshLog`. C++ rebuilds the tree in place, so this only refreshes
   * the tree-derived GPU state afterwards (see refreshAfterReorder). */
  reorderForLocality(meshLog: MeshLog): void {
    meshLog.reorderForLocality(this.spatial)
    this.refreshAfterReorder()
  }

  /** Refresh tree-derived GPU state after the C++ SpatialTree rebuilt in place
   * (reorder exec/undo/redo). Unlike _rebuildSpatial the tree handle is unchanged
   * — C++ already rebuilt its nodes + drawBatch — so we only re-fetch the batches
   * and invalidate the pipeline/binding caches keyed on the old drawBatch pointer. */
  refreshAfterReorder(): void {
    if (this.treeBatch) {
      this.wasm.gpu.destroyBatch(this.treeBatch, true, true)
      this.treeBatch = undefined
    }
    if (this.seamBatch) {
      this.wasm.gpu.destroyBatch(this.seamBatch, true, true)
      this.seamBatch = undefined
    }
    if (this.selectionBatch) {
      this.wasm.gpu.destroyBatch(this.selectionBatch, true, true)
      this.selectionBatch = undefined
      this._selectionDirty = true
    }
    if (this.wireframeBatch) {
      this.wasm.gpu.destroyBatch(this.wireframeBatch, true, true)
      this.wireframeBatch = undefined
      this._wireframeRev = -1
    }
    if (this.pointsBatch) {
      this.wasm.gpu.destroyBatch(this.pointsBatch, true, true)
      this.pointsBatch = undefined
      this._pointsRev = -1
    }
    if (this.boundsBatch) {
      this.wasm.gpu.destroyBatch(this.boundsBatch, true, true)
      this.boundsBatch = undefined
      this._boundsRev = -1
    }
    this.spatial.update(this.wasm.gpu)
    this.drawBatch = this.spatial.getDrawBatch()
    this.treeBatch = this.spatial.buildLeafBoundsBatch(this.wasm.gpu)

    this.drawBatchExecutorGPU?.invalidatePipelines()
    for (const bindings of this.gpuBindingsCache.values()) bindings.destroy()
    this.gpuBindingsCache.clear()
    this._hasMaterialDrawShader = false
    const eng = this as unknown as {_engineDrawShaderHash?: number; _engineAttrLayersSig?: number}
    eng._engineDrawShaderHash = undefined
    eng._engineAttrLayersSig = undefined
    this.markSeamsDirty()
  }

  /** Feature-aligned global quad remesh (cross-field → seamless param → integer
   * quantization → quad extraction → reprojection). Builds a fresh all-quad mesh
   * and swaps it in; the input is deep-copied in C++ so it is never mutated here.
   * `opts` overrides only the fields it sets — the rest keep the C++ defaults.
   * Returns false on a clean failure (Gauss-Bonnet-infeasible field / too many
   * folded faces), leaving the mesh untouched. */
  quadRemesh(opts: QuadRemeshOptions = {}): boolean {
    const params = this.wasm.manager.construct('sculptcore::remesh::RemeshParams')
    try {
      if (opts.targetQuadCount !== undefined) params.target_quad_count = opts.targetQuadCount
      if (opts.targetEdgeLength !== undefined) params.target_edge_length = opts.targetEdgeLength
      if (opts.useCurvature !== undefined) params.use_curvature = opts.useCurvature
      if (opts.useSharpFeatures !== undefined) params.use_sharp_features = opts.useSharpFeatures
      if (opts.sharpAngle !== undefined) params.sharp_angle = opts.sharpAngle
      if (opts.useDensity !== undefined) params.use_density = opts.useDensity
      if (opts.reproject !== undefined) params.reproject = opts.reproject
      if (opts.smoothIterations !== undefined) params.smooth_iterations = opts.smoothIterations
      if (opts.smoothStrength !== undefined) params.smooth_strength = opts.smoothStrength
      if (opts.seed !== undefined) params.seed = opts.seed
      if (opts.triage !== undefined) params.triage = opts.triage
      if (opts.triageWeldRel !== undefined) params.triage_weld_rel = opts.triageWeldRel
      if (opts.triageMinComponentFrac !== undefined) params.triage_min_component_frac = opts.triageMinComponentFrac
      if (opts.curvatureSmoothIters !== undefined) params.curvature_smooth_iters = opts.curvatureSmoothIters
      if (opts.curvatureSmoothLambda !== undefined) params.curvature_smooth_lambda = opts.curvatureSmoothLambda
      if (opts.fieldSmoothness !== undefined) params.field_smoothness = opts.fieldSmoothness
      if (opts.curvatureWeight !== undefined) params.curvature_weight = opts.curvatureWeight
      if (opts.singularityCancel !== undefined) params.singularity_cancel = opts.singularityCancel
      if (opts.singularityCancelMaxSep !== undefined) params.singularity_cancel_max_sep = opts.singularityCancelMaxSep
      if (opts.autoDensity !== undefined) params.auto_density = opts.autoDensity
      if (opts.densityMin !== undefined) params.density_min = opts.densityMin
      if (opts.densityMax !== undefined) params.density_max = opts.densityMax
      if (opts.densityGradation !== undefined) params.density_gradation = opts.densityGradation
      if (opts.densityGradationIters !== undefined) params.density_gradation_iters = opts.densityGradationIters
      if (opts.preRemesh !== undefined) params.pre_remesh = opts.preRemesh
      if (opts.preRemeshTarget !== undefined) params.pre_remesh_target = opts.preRemeshTarget
      if (opts.preRemeshIters !== undefined) params.pre_remesh_iters = opts.preRemeshIters
      if (opts.preRemeshDensity !== undefined) params.pre_remesh_density = opts.preRemeshDensity
      if (opts.preRemeshGradation !== undefined) params.pre_remesh_gradation = opts.preRemeshGradation
      if (opts.preRemeshGradationIters !== undefined) params.pre_remesh_gradation_iters = opts.preRemeshGradationIters
      if (opts.preRemeshAlign !== undefined) params.pre_remesh_align = opts.preRemeshAlign
      if (opts.preRemeshFieldCadence !== undefined) params.pre_remesh_field_cadence = opts.preRemeshFieldCadence
      if (opts.preRemeshBootstrapIters !== undefined) params.pre_remesh_bootstrap_iters = opts.preRemeshBootstrapIters
      if (opts.preRemeshSmoothIters !== undefined) params.pre_remesh_smooth_iters = opts.preRemeshSmoothIters
      if (opts.preRemeshSmoothLambda !== undefined) params.pre_remesh_smooth_lambda = opts.preRemeshSmoothLambda
      if (opts.preRemeshConvergeEps !== undefined) params.pre_remesh_converge_eps = opts.preRemeshConvergeEps
      if (opts.preRemeshPreserveFeatures !== undefined)
        params.pre_remesh_preserve_features = opts.preRemeshPreserveFeatures
      if (opts.preRemeshSharpAngle !== undefined) params.pre_remesh_sharp_angle = opts.preRemeshSharpAngle
      const out = this.wasm.Mesh_quadRemesh(this.mesh, params)
      if (!out) {
        return false // clean failure: infeasible field / too many folds
      }
      this._replaceMesh(out)
      return true
    } finally {
      // WASM exposes an explicit disposer; native GC-finalizes the wrapper.
      ;(params as unknown as {[Symbol.dispose]?: () => void})[Symbol.dispose]?.()
    }
  }

  /** Destroy every tree-derived GPU batch and drop the tree reference; when
   * `freeTree`, the tree itself is freed (skip for multires slot trees — the
   * C++ stack owns those). */
  private _teardownTreeState(freeTree: boolean): void {
    if (this.treeBatch) {
      this.wasm.gpu.destroyBatch(this.treeBatch, true, true)
      this.treeBatch = undefined
    }
    if (this.seamBatch) {
      this.wasm.gpu.destroyBatch(this.seamBatch, true, true)
      this.seamBatch = undefined
    }
    if (this.selectionBatch) {
      this.wasm.gpu.destroyBatch(this.selectionBatch, true, true)
      this.selectionBatch = undefined
      this._selectionDirty = true
    }
    if (this.wireframeBatch) {
      this.wasm.gpu.destroyBatch(this.wireframeBatch, true, true)
      this.wireframeBatch = undefined
      this._wireframeRev = -1
    }
    if (this.pointsBatch) {
      this.wasm.gpu.destroyBatch(this.pointsBatch, true, true)
      this.pointsBatch = undefined
      this._pointsRev = -1
    }
    // drawBatch is owned by the spatial tree; freeing the tree releases it.
    this.drawBatch = undefined
    if (this.spatial) {
      if (freeTree) {
        this.wasm.SpatialTree_free(this.spatial)
      }
      this.spatial = undefined as unknown as SpatialTree
    }
  }

  /** Drop the GPU pipeline/binding caches after a tree swap: the new tree has a
   * fresh drawShader ShaderDef, and the allocator may hand back the old address,
   * so a pipeline cached on the stale pointer would be wrong. Then clear the
   * engine push-cache so the BasePass re-pushes setRequestedAttrs/setDrawShader. */
  private _invalidateGpuCaches(): void {
    this.drawBatchExecutorGPU?.invalidatePipelines()
    for (const bindings of this.gpuBindingsCache.values()) bindings.destroy()
    this.gpuBindingsCache.clear()
    this._hasMaterialDrawShader = false
    const eng = this as unknown as {_engineDrawShaderHash?: number; _engineAttrLayersSig?: number}
    eng._engineDrawShaderHash = undefined
    eng._engineAttrLayersSig = undefined
    this.markSeamsDirty()
    // Wholesale topology swap (triangulate / quadRemesh / undo restore) → the
    // serialized form changed; invalidate the autosave blob cache (M2).
    this.meshRevision++
  }

  /** Tear down the spatial tree + tree-derived GPU batches and rebuild cleanly
   * over the current `this.mesh` (after a wholesale topology change). Keeps the
   * mesh + batch executors; forces the renderengine to re-push the material draw
   * shader so the rebuilt tree renders with the material, not the fallback. */
  private _rebuildSpatial(): void {
    if (this._multires) {
      // The level tree is stack-owned; a clean app-side rebuild isn't possible —
      // re-attach the active slot instead (spatial.update refreshes buffers).
      this._attachMultiresLevel()
      return
    }
    this._teardownTreeState(true)
    this._initSpatial()
    this._invalidateGpuCaches()
  }

  /** Swap in a different mesh handle (undo restoring a pre-triangulate snapshot):
   * adopt `newMesh`, rebuild the tree over it, then free the old mesh. A live
   * multires stack is flattened away first (the incoming mesh supersedes it). */
  _replaceMesh(newMesh: WasmMesh): void {
    if (this._multires) {
      // The active level's mesh/tree are stack-owned views — they die with the
      // stack; the parked cage is superseded by the incoming mesh.
      this._teardownTreeState(false)
      this.wasm.Multires_free(this._multires)
      this._multires = undefined
      if (this._multiresCage) {
        this.wasm.Mesh_free(this._multiresCage)
        this._multiresCage = undefined
      }
      this.mesh = newMesh
      this._rebuildSpatial()
      return
    }
    const old = this.mesh
    this.mesh = newMesh
    this._rebuildSpatial()
    if (old) {
      this.wasm.Mesh_free(old)
    }
  }

  // --- Multires (displacementAndSubSurf S app-wiring pass) ------------------

  get multiresActive(): boolean {
    return this._multires !== undefined
  }

  /** Active edit level (1-based); 0 when no stack is attached. */
  get multiresLevel(): number {
    return this._multires ? this._multires.activeLevel() : 0
  }

  get multiresLevels(): number {
    return this._multires ? this._multires.maxLevel() : 0
  }

  /** Enable multires: refine the current mesh into a `levels`-deep stack (the
   * mesh becomes the parked cage) and attach `level` (default: finest). */
  multiresEnable(levels: number, level = levels): boolean {
    if (this._multires || levels < 1) {
      return false
    }
    // V2 flatten: vertex-column layers don't convert to level channels — bake
    // the evaluated surface (co already IS the composite) and drop the stack.
    // The enable op snapshots a serialize blob for undo when layers exist.
    if (this.mesh.sculptLayerCount() > 0) {
      this.mesh.sculptLayerFlattenAll()
    }
    const mr = this.wasm.Multires_new(this.mesh, levels, 1024, 32, 1 << 13)
    if (!mr) {
      return false
    }
    this._multires = mr
    this._multiresCage = this.mesh
    // The cage's app-owned tree dies here; level trees are stack-owned views.
    this._teardownTreeState(true)
    this.wasm.Multires_setActiveLevel(mr, level)
    this._attachMultiresLevel()
    return true
  }

  /** Switch the edited level (writes back the outgoing one — lossless, S3
   * gate). Returns the clamped level actually attached. */
  multiresSetLevel(level: number): number {
    if (!this._multires) {
      return 0
    }
    const lv = this.wasm.Multires_setActiveLevel(this._multires, level)
    this._attachMultiresLevel()
    return lv
  }

  /** Fold the active level's edits into the grids store. Call at stroke end and
   * after a meshlog undo/redo; no-op without a stack. */
  multiresWriteback(): void {
    if (this._multires) {
      this.wasm.Multires_writeback(this._multires, this._multires.activeLevel())
    }
  }

  /** Least-squares-refit the level below the active one to the active surface
   * (the active surface is preserved). Returns changed coarse verts. */
  multiresDownRefit(): number {
    if (!this._multires) {
      return 0
    }
    const changed = this.wasm.Multires_downRefit(this._multires, this._multires.activeLevel())
    // The active slot survives a refit, but re-attach defensively — a refreshed
    // coarse resident may have reallocated slot storage.
    this._attachMultiresLevel()
    return changed
  }

  /** Append one finer multires level (a smooth subdivision of the current
   * finest surface, zero displacement), preserving all existing detail, and
   * attach it as the active level. Returns the new depth (unchanged at the
   * level cap or without a stack). */
  multiresAddLevel(): number {
    if (!this._multires) {
      return 0
    }
    const n = this._multires.addLevel()
    this._attachMultiresLevel()
    return n
  }

  /** Pop the finest multires level — the undo/redo helper for multiresAddLevel.
   * Returns the new depth. */
  multiresRemoveTopLevel(): number {
    if (!this._multires) {
      return 0
    }
    const n = this._multires.removeTopLevel()
    this._attachMultiresLevel()
    return n
  }

  /** Tear down the stack and re-adopt the parked cage as a plain mesh. The
   * stack's levels are discarded (the caller snapshots for undo). */
  multiresDelete(): boolean {
    if (!this._multires) {
      return false
    }
    this._teardownTreeState(false) // the active level's mesh/tree are stack-owned
    this.wasm.Multires_free(this._multires)
    this._multires = undefined
    this.mesh = this._multiresCage!
    this._multiresCage = undefined
    // Channel-backed layer rows lose their channels with the stack — drop
    // them so the panel doesn't show ghost layers (V2: level layers are lost
    // on stack delete; the delete op's store blob is the undo).
    this.mesh.sculptLayerPruneSettingsOnly()
    this._initSpatial()
    this._invalidateGpuCaches()
    return true
  }

  /** Grids-store blob — the undo seam for down-refit / stack delete. */
  multiresStoreBlob(): Uint8Array | undefined {
    return this._multires ? this.wasm.Multires_storeBlob(this._multires) : undefined
  }

  /** Restore a `multiresStoreBlob` snapshot and re-attach `level`. */
  multiresRestoreStoreBlob(bytes: Uint8Array, level: number): boolean {
    if (!this._multires || !this.wasm.Multires_restoreStoreBlob(this._multires, bytes)) {
      return false
    }
    this.wasm.Multires_setActiveLevel(this._multires, level)
    this._attachMultiresLevel()
    return true
  }

  // --- Sculpt-layer routing (sculptLayersV2 M3) ------------------------------
  // Plain meshes store layers as vertex delta columns on this.mesh; with a
  // multires stack the layers are grids-store CHANNELS keyed by settings rows
  // on the parked cage, reached through the bound Multires surface. Mutations
  // there rematerialize the active level (slot pointers change), so the
  // multires branches re-attach the level views afterwards.

  layerCount(): number {
    return this._multires ? this._multires.layerCount() : this.mesh.sculptLayerCount()
  }
  layerWeight(li: number): number {
    return this._multires ? this._multires.layerWeight(li) : this.mesh.sculptLayerWeight(li)
  }
  layerEnabled(li: number): boolean {
    return (this._multires ? this._multires.layerEnabled(li) : this.mesh.sculptLayerEnabled(li)) !== 0
  }
  layerFrozen(li: number): boolean {
    return (this._multires ? this._multires.layerFrozen(li) : this.mesh.sculptLayerFrozen(li)) !== 0
  }
  layerEditTarget(): number {
    return this._multires ? this._multires.editTarget() : this.mesh.sculptLayerEditTarget()
  }
  /** Add a layer (returns the settings index). A fresh zero layer changes no
   * positions on either path, so no view refresh is needed. */
  layerAdd(): number {
    return this._multires ? this._multires.layerAdd() : this.mesh.sculptLayerAdd()
  }
  layerRemove(li: number): void {
    if (this._multires) {
      this._multires.layerRemove(li)
      this._attachMultiresLevel()
    } else {
      this.wasm.Mesh_layerRemove(this.mesh, li)
    }
  }
  layerSetWeight(li: number, weight: number): void {
    if (this._multires) {
      this._multires.layerSetWeight(li, weight)
      this._attachMultiresLevel()
    } else {
      this.wasm.Mesh_layerSetWeight(this.mesh, li, weight)
    }
  }
  layerSetEnabled(li: number, enabled: boolean): void {
    if (this._multires) {
      this._multires.layerSetEnabled(li, enabled ? 1 : 0)
      this._attachMultiresLevel()
    } else {
      this.wasm.Mesh_layerSetEnabled(this.mesh, li, enabled ? 1 : 0)
    }
  }
  layerSetFrozen(li: number, frozen: boolean): void {
    if (this._multires) {
      this._multires.layerSetFrozen(li, frozen ? 1 : 0)
      // Freezing composites nothing (it only gates targeting) — but freezing
      // the TARGET clears it engine-side, which may leave a fold behind.
      this._attachMultiresLevel()
    } else {
      this.wasm.Mesh_layerSetFrozen(this.mesh, li, frozen ? 1 : 0)
    }
  }
  /** Make layer `li` the edit target (-1 clears); returns the result. */
  layerSetTarget(li: number): number {
    if (this._multires) {
      const r = this._multires.setEditTarget(li)
      this._attachMultiresLevel()
      return r
    }
    return this.wasm.Mesh_setActiveEditLayer(this.mesh, li)
  }
  /** Fold the edit target's derived delta: plain meshes fold the vertex
   * column; level meshes write back into the target's channel. */
  layerFold(): void {
    if (this._multires) {
      this.multiresWriteback()
    } else {
      this.wasm.Mesh_layerFold(this.mesh)
    }
  }

  /** Snapshot the multires layer table ({weight,enabled,frozen} per row) as a
   * retained bound Vector<float> — pair with multiresStoreBlob for the
   * layer-remove undo seam. */
  multiresLayerTableCapture(): unknown {
    if (!this._multires) return undefined
    const holder = this._vecOutBulk('float')
    this._multires.layerTableOut(holder.vec as never)
    return holder.vec
  }
  /** Rebuild the layer rows from a multiresLayerTableCapture snapshot (call
   * after multiresRestoreStoreBlob so the channels exist). */
  multiresLayerTableRestore(tableVec: unknown): void {
    if (!this._multires || !tableVec) return
    this._multires.layerTableRestore(tableVec as never)
    this._attachMultiresLevel()
  }

  /** True once the async tessellated-display state is resident (drivers/
   * tests poll this before screenshotting; draws fall back to the batch
   * until then). */
  get tessReady(): boolean {
    return this._tessState !== undefined
  }

  /** The renderengine's TESS_TIER material variant (position-only vertex
   * input + derivative flat normal); replaces cached tess pipelines/bindings
   * when the WGSL changes. */
  setTessDrawWgsl(wgsl: string): void {
    if (this._tessWgsl === wgsl) return
    this._tessWgsl = wgsl
    this._tessPipelines.clear()
    this._tessBindings = undefined
  }

  /** Free the tessellated-display GPU state (buffers + caches). */
  private _dropTessState(): void {
    if (this._tessState) {
      this._tessState.vertexBuf.destroy()
      this._tessState.normalBuf.destroy()
      this._tessState.indexBuf.destroy()
      this._tessState = undefined
    }
    this._tessPipelines.clear()
    this._tessBindings = undefined
  }

  /** Kick (or refresh) the async render-level amplification: marshal the CSR
   * chain (activeLevel, maxLevel], SpMV it on the renderer device
   * (stencil_compute.ts), and land the result as an on-device vertex buffer +
   * the static render-level index buffer. Draws fall back to the normal batch
   * until the state exists; a stale state keeps drawing while the refresh
   * builds (meshRev-keyed). */
  private _ensureTessBuild(device: GPUDevice): void {
    if (this._tessBuilding || !this._multires) return
    const renderLevel = this.multiresLevels
    const active = this.multiresLevel
    if (active >= renderLevel) return
    const st = this._tessState
    const storeRev = this._tessStoreRev()
    if (st && st.meshRev === this.meshRevision && st.level === renderLevel) {
      // Geometry clean. If only texels changed (interactive VDM splats /
      // their undo), re-run just the finalize over the kept amplified
      // channels — the SpMV chain result is still current.
      if (st.storeRev !== storeRev) this._refinalizeTess(device, storeRev)
      return
    }

    const meshRev = this.meshRevision
    this._tessBuilding = true
    void (async () => {
      try {
        const mr = this._multires! as unknown as {
          stencilMetaOut(l: number, out: never): void
          stencilOffsetsOut(l: number, out: never): void
          stencilIndicesOut(l: number, out: never): void
          stencilWeightsOut(l: number, out: never): void
          levelTriIndicesOut(l: number, out: never): void
          levelVertGridCoordsOut(l: number, out: never): void
          levelGridVertsOut(l: number, out: never): void
        }
        const intV = this._vecOutBulk('int32')
        const fltV = this._vecOutBulk('float')
        const levels: StencilLevel[] = []
        for (let l = active + 1; l <= renderLevel; l++) {
          mr.stencilMetaOut(l, intV.vec as never)
          const meta = Array.from(intV.read() as ArrayLike<number>)
          mr.stencilOffsetsOut(l, intV.vec as never)
          const offsets = Uint32Array.from(intV.read() as ArrayLike<number>)
          mr.stencilIndicesOut(l, intV.vec as never)
          const indices = Uint32Array.from(intV.read() as ArrayLike<number>)
          mr.stencilWeightsOut(l, fltV.vec as never)
          const weights = Float32Array.from(fltV.read() as ArrayLike<number>)
          levels.push({coarseCount: meta[0] | 0, fineCount: meta[1] | 0, offsets, indices, weights})
        }
        const {co} = this.dumpVertCo()
        const src = new Float32Array(co.length * 3)
        for (let i = 0; i < co.length; i++) {
          src[i * 3] = co[i][0]
          src[i * 3 + 1] = co[i][1]
          src[i * 3 + 2] = co[i][2]
        }
        // Frame sources at the edit level; amplified through the same chain
        // they subdivide smoothly (stage 3 — the finalize pass normalizes).
        this.wasm.Mesh_updateFrames(this.mesh)
        const frameMesh = this.mesh as unknown as {
          dumpFrameNormals(out: never): void
          dumpFrameTangents(out: never): void
        }
        frameMesh.dumpFrameNormals(fltV.vec as never)
        const nSrc = Float32Array.from(fltV.read() as ArrayLike<number>)
        frameMesh.dumpFrameTangents(fltV.vec as never)
        const tSrc = Float32Array.from(fltV.read() as ArrayLike<number>)
        if (nSrc.length !== src.length || tSrc.length !== src.length) {
          throw new Error('frame attrs missing on the edit level')
        }

        const pos = await stencilAmplify(device, levels, src, {keepResult: true})
        const nor = await stencilAmplify(device, levels, nSrc, {keepResult: true})
        const tan = await stencilAmplify(device, levels, tSrc, {keepResult: true})
        if (!pos.result || !nor.result || !tan.result) {
          throw new Error('amplify returned no device buffer')
        }

        // Level topology for the geometric-normals pass (always needed).
        mr.levelVertGridCoordsOut(renderLevel, intV.vec as never)
        const vertCoords = Int32Array.from(intV.read() as ArrayLike<number>)
        mr.levelGridVertsOut(renderLevel, intV.vec as never)
        const gridVerts = Int32Array.from(intV.read() as ArrayLike<number>)
        const gridSide = 1 << (renderLevel - 1)
        const topo: TessTopoInputs = {
          gridVerts,
          vertCoords,
          gridCount: (gridVerts.length / ((gridSide + 1) * (gridSide + 1))) | 0,
          latticeW : gridSide + 1,
        }

        // Ptex VDM inputs for the finalize kernel (true displaced verts).
        const vdm = this._marshalTessVdm(vertCoords, gridSide)

        const fineCount = levels[levels.length - 1].fineCount
        const {posOut, norOut} = await tessFinalize(device, fineCount, pos.result, nor.result, tan.result, topo, vdm)

        mr.levelTriIndicesOut(renderLevel, intV.vec as never)
        const tris = Uint32Array.from(intV.read() as ArrayLike<number>)
        const indexBuf = device.createBuffer({
          label: 'litemesh.tessIndices',
          size : Math.max(16, (tris.byteLength + 3) & ~3),
          usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(indexBuf, 0, tris.buffer as ArrayBuffer, tris.byteOffset, tris.byteLength)

        this._dropTessStateBuffers()
        this._tessState = {
          level: renderLevel,
          meshRev,
          storeRev,
          posAmp: pos.result,
          norAmp: nor.result,
          tanAmp: tan.result,
          topo,
          fineCount,
          vertexBuf: posOut,
          normalBuf: norOut,
          indexBuf,
          indexCount: tris.length,
        }
        window.redraw_viewport?.()
      } catch (err) {
        this._tessLastError = String(err instanceof Error ? err.stack ?? err.message : err)
        if (!this._tessWarned) {
          this._tessWarned = true
          console.error('litemesh: tessellated-display build failed', err)
        }
      } finally {
        this._tessBuilding = false
      }
    })()
  }

  /** Buffers only (keep pipelines/bindings — the WGSL didn't change). */
  private _dropTessStateBuffers(): void {
    if (this._tessState) {
      this._tessState.vertexBuf.destroy()
      this._tessState.normalBuf.destroy()
      this._tessState.indexBuf.destroy()
      this._tessState.posAmp.destroy()
      this._tessState.norAmp.destroy()
      this._tessState.tanAmp.destroy()
      this._tessState = undefined
    }
  }

  /** The attached store's texel-content revision (-1 = no Ptex store). */
  private _tessStoreRev(): number {
    return this._vdmStore && this._vdmIsPtex ? (this._vdmStore as unknown as {contentRev(): number}).contentRev() : -1
  }

  /** Marshal the finalize kernel's Ptex inputs (undefined = no store: the
   * finalize still runs for frames/normals, skipping the displacement). */
  private _marshalTessVdm(vertCoords: Int32Array, gridSide: number): TessVdmInputs | undefined {
    if (!this._vdmStore || !this._vdmIsPtex) return undefined
    const intV = this._vecOutBulk('int32')
    const fltV = this._vecOutBulk('float')
    const store = this._vdmStore as unknown as {
      gpuLayoutOut(o: never): number
      gpuPtexTableOut(o: never): void
      gpuAtlasPixelsOut(o: never): void
    }
    store.gpuLayoutOut(intV.vec as never)
    const lay = Array.from(intV.read() as ArrayLike<number>)
    store.gpuPtexTableOut(intV.vec as never)
    const table = Int32Array.from(intV.read() as ArrayLike<number>)
    store.gpuAtlasPixelsOut(fltV.vec as never)
    const atlasPixels = Float32Array.from(fltV.read() as ArrayLike<number>)
    return {
      table,
      atlasPixels,
      vertCoords,
      gridSide,
      tileSize   : lay[0] | 0,
      atlasTilesX: Math.max(lay[4] | 0, 1),
      atlasW     : Math.max(lay[6] | 0, 1),
    }
  }

  /** Texel-only refresh: re-run the finalize kernels over the kept amplified
   * channels (no SpMV re-dispatch, no index rebuild) and swap the vertex
   * streams. Async like the full build; the stale streams draw until it
   * lands. */
  private _refinalizeTess(device: GPUDevice, storeRev: number): void {
    const st = this._tessState
    if (!st || this._tessBuilding) return
    this._tessBuilding = true
    void (async () => {
      try {
        const gridSide = 1 << (st.level - 1)
        const vdm = this._marshalTessVdm(st.topo.vertCoords as Int32Array, gridSide)
        const {posOut, norOut} = await tessFinalize(device, st.fineCount, st.posAmp, st.norAmp, st.tanAmp, st.topo, vdm)
        st.vertexBuf.destroy()
        st.normalBuf.destroy()
        st.vertexBuf = posOut
        st.normalBuf = norOut
        st.storeRev = storeRev
        window.redraw_viewport?.()
      } catch (err) {
        this._tessLastError = String(err instanceof Error ? err.stack ?? err.message : err)
        if (!this._tessWarned) {
          this._tessWarned = true
          console.error('litemesh: tessellated re-finalize failed', err)
        }
      } finally {
        this._tessBuilding = false
      }
    })()
  }

  /** The tessellated-tier draw (X3 stage 2): bind the amplified positions +
   * static index buffer under the TESS_TIER material pipeline. Returns false
   * (caller draws the normal batch) until the async state exists; never
   * throws on the render seam. */
  private _drawTessellated(
    ctx: NonNullable<ReturnType<typeof getActiveWebGpuContext>>,
    pass: GPURenderPassEncoder,
    fmts: GPUTextureFormat[]
  ): boolean {
    if (!this.tessellatedDisplay || !this._multires || !this._tessWgsl) return false
    if (this.multiresLevel >= this.multiresLevels) return false
    if (fmts.length > 1) return false // SSS MRT tess variant rides stage 3
    try {
      this._ensureTessBuild(ctx.device)
      const st = this._tessState
      if (!st) return false

      const key = fmts.join('+')
      let pipeline = this._tessPipelines.get(key)
      if (!pipeline) {
        pipeline = ctx.pipelineCache.get({
          label        : 'litemesh.tess',
          wgsl         : this._tessWgsl,
          vertexBuffers: [
            {arrayStride: 12, attributes: [{shaderLocation: 0, offset: 0, format: 'float32x3'}]},
            {arrayStride: 12, attributes: [{shaderLocation: 1, offset: 0, format: 'float32x3'}]},
          ],
          colorTargets: fmts.map((format) => ({
            format,
            blend: {
              color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add'},
              alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
            },
          })),
          depthStencil : {format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal'},
          primitive    : {topology: 'triangle-list', cullMode: 'none'},
        })
        this._tessPipelines.set(key, pipeline)
      }
      if (!this._tessBindings) {
        this._tessBindings = new UniformBindings(ctx.device, this._tessWgsl, 'litemesh.tess')
      }
      const groups = this._tessBindings.bindGroupList(pipeline.handle, this.gpuUniforms!)
      pass.setPipeline(pipeline.handle)
      for (const e of groups) pass.setBindGroup(e.group, e.bindGroup)
      pass.setVertexBuffer(0, st.vertexBuf)
      pass.setVertexBuffer(1, st.normalBuf)
      pass.setIndexBuffer(st.indexBuf, 'uint32')
      pass.drawIndexed(st.indexCount, 1, 0, 0, 0)
      return true
    } catch (err) {
      if (!this._tessWarned) {
        this._tessWarned = true
        console.error('litemesh: tessellated draw failed', err)
      }
      return false
    }
  }

  /** Point `mesh`/`spatial` at the stack's active-level slot and rebuild the
   * tree-derived GPU state (batches, pipeline/binding caches). */
  private _attachMultiresLevel(): void {
    const mesh = this.wasm.Multires_activeMesh(this._multires!)
    const tree = this.wasm.Multires_activeTree(this._multires!)
    if (!mesh || !tree) {
      throw new Error('litemesh: multires stack has no active level')
    }
    this._teardownTreeState(false)
    this.mesh = mesh
    this.spatial = tree
    this.spatial.update(this.wasm.gpu)
    this.spatial.setColorDisplayMode(this._displayColorMode)
    this.drawBatch = this.spatial.getDrawBatch()
    this.treeBatch = this.spatial.buildLeafBoundsBatch(this.wasm.gpu)
    // Keep an attached VDM renderable on the new level (X1): fresh F3 frames +
    // carrier tags — the grid-chart UVs are level-consistent, so finest-level
    // texels sample correctly from any level's parameterization.
    if (this._vdmStore) {
      this.wasm.Mesh_updateFrames(this.mesh)
      this.wasm.SpatialTree_fillDetailCarrier(this.spatial, 1)
    }
    this._invalidateGpuCaches()
    this.regenBounds()
  }

  /** Bump meshRevision if the spatial tree had pending changes to flush. Called
   * from the draw path (cheap when clean) and before a cache-mode serialize so
   * the revision reflects the latest committed geometry even if no frame drew
   * since the edit. */
  private _flushRevision(): void {
    if (this.spatial.update(this.wasm.gpu)) {
      this.meshRevision++
    }
  }

  /** Serialize the mesh to a versioned, compressed blob for the STRUCT getter.
   * In autosave cache mode (getSerializeCacheMode) an unchanged mesh reuses its
   * previous blob instead of recompressing; app.save leaves cache mode off so
   * the canonical file is always freshly serialized. */
  serialize(): Uint8Array {
    // On a multires stack the persistent mesh is the parked CAGE — the level
    // views are derived (stack topology + grids store, saved via _mrData).
    // Serializing the level view here is exactly the old flatten-on-save bug.
    const persistMesh = this._multiresCage ?? this.mesh
    persistMesh.serialize_temp = this.saveTempAttrs
    if (this.saveTempAttrs) {
      // Debug/repro path: TEMP layers change without bumping meshRevision, so
      // neither blob cache nor the deferred collector can be trusted here.
      return this.wasm.Mesh_serialize(persistMesh)
    }
    // M3 split path: hand the collector either a cached compressed blob or a
    // fresh uncompressed raw payload (the worker lz4-frames it off-thread), and
    // embed only an 8-byte placeholder inline. See autosave_serialize.ts.
    const collector = getDeferredBlobCollector()
    if (collector) {
      this._flushRevision()
      if (this._blobCache?.revision === this.meshRevision) {
        return makeBlobPlaceholder(collector.add({state: 'compressed', bytes: this._blobCache.blob}))
      }
      const revision = this.meshRevision
      const raw = this.wasm.Mesh_serializeRaw(persistMesh)
      const blobId = collector.add({
        state       : 'raw',
        bytes       : raw,
        onCompressed: (compressed) => {
          this._blobCache = {revision, blob: compressed}
        },
      })
      return makeBlobPlaceholder(blobId)
    }

    if (getSerializeCacheMode()) {
      this._flushRevision()
      if (this._blobCache?.revision === this.meshRevision) {
        return this._blobCache.blob
      }
    }
    const blob = this.wasm.Mesh_serialize(persistMesh)
    this._blobCache = {revision: this.meshRevision, blob}
    return blob
  }

  /** VDM store blob for the save stream (empty = no store attached). The v2
   * container carries backend/params/Ptex tables, so load just deserializes
   * and re-attaches. */
  serializeVdm(): Uint8Array {
    return this._vdmStore ? this.wasm.VdmStore_serializeBlob(this._vdmStore) : new Uint8Array()
  }

  /** Grids-store blob for the save stream (empty = no stack). Folds the
   * active level's resident edits in first so the blob is current. */
  serializeMultires(): Uint8Array {
    if (!this._multires) return new Uint8Array()
    this.multiresWriteback()
    return this.wasm.Multires_storeBlob(this._multires)
  }

  rayCast(origin: Vector3, dir: Vector3): GenericIsect | undefined {
    const isectOut = this.wasm.manager.construct('sculptcore::spatial::CastRayIsect')
    try {
      // Backend-agnostic: pass the ray endpoints as bound float3s (the wasm/native
      // ring helper) rather than poking raw heap pointers — castRay takes them by
      // reference, so both backends marshal the wrapper's address. (Native keeps
      // the pointer in C++; there is no HEAPF32 to write through.)
      const originF3 = this.wasm.float3([origin[0], origin[1], origin[2]])
      const dirF3 = this.wasm.float3([dir[0], dir[1], dir[2]])

      const result = this.spatial.castRay(originF3, dirF3, isectOut)
      if (!result) {
        return undefined
      }

      const isect = new GenericIsect()
      for (let i = 0; i < 3; i++) {
        isect.p[i] = isectOut.p.vec[i]
        isect.normal[i] = isectOut.normal.vec[i]
      }
      isect.tri = isectOut.triIndex
      isect.face = isectOut.faceIndex
      isect.dis = isectOut.t
      isect.uv[0] = isectOut.uv.vec[0]
      isect.uv[1] = isectOut.uv.vec[1]
      return isect
    } finally {
      // WASM exposes an explicit disposer; the native backend GC-finalizes the
      // owning wrapper, so the disposer is absent there.
      ;(isectOut as unknown as {[Symbol.dispose]?: () => void})[Symbol.dispose]?.()
    }
  }

  /** Object-level surface raycast for the core `castViewRay` dispatcher
   * (3D-cursor placement, transform snap): spatial.castRay in object space,
   * hit returned world-space with camera distance in `dis`. */
  castViewRay(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2
  ): FindNearestRet[] | undefined {
    if (!(selectMask & this._ownSelectMask())) {
      return undefined
    }

    const obmatrix = object.outputs.matrix.getValue()
    // clip→local = (rendermat∘obmat)^-1 (multiply applies its argument first).
    const imat = new Matrix4(view3d.activeCamera.rendermat)
    imat.multiply(obmatrix)
    imat.invert()
    const d = 0.9999
    const p1 = new Vector4([mpos[0], mpos[1], -d, 1.0])
    view3d.unproject(p1, imat)
    const origin = new Vector3(p1)
    const p2 = new Vector4([mpos[0], mpos[1], d, 1.0])
    view3d.unproject(p2, imat)
    const dir = new Vector3(p2).sub(origin)

    const isect = this.rayCast(origin, dir)
    if (!isect) {
      return undefined
    }

    const ret = new FindNearestRet()
    ret.object = object
    ret.p3d.load(isect.p).multVecMatrix(obmatrix)

    const sp = new Vector3(ret.p3d)
    view3d.project(sp)
    ret.p2d.loadXY(sp[0], sp[1])
    ret.dis = new Vector3(ret.p3d).sub(view3d.activeCamera.pos).vectorLength()
    return [ret]
  }

  /** Resolve a ray to the mesh vertex nearest the hit point (the hit triangle's
   * highest-barycentric-weight corner, computed in C++). -1 if the ray misses.
   * Used by the seam-marking modal to turn a click into a path endpoint. */
  pickVert(origin: Vector3, dir: Vector3): number {
    const isectOut = this.wasm.manager.construct('sculptcore::spatial::CastRayIsect')
    try {
      const originF3 = this.wasm.float3([origin[0], origin[1], origin[2]])
      const dirF3 = this.wasm.float3([dir[0], dir[1], dir[2]])
      const hit = this.spatial.castRay(originF3, dirF3, isectOut)
      return hit ? (isectOut as unknown as {nearestVert: number}).nearestVert : -1
    } finally {
      ;(isectOut as unknown as {[Symbol.dispose]?: () => void})[Symbol.dispose]?.()
    }
  }

  /* ----- Wave 5: seam/boundary marking ----- */

  /** Mark (state=1) or clear (state=0) the shortest edge-path between two verts
   * as a seam (EDGE_SEAM). Returns the edge count, or -1 if no path. */
  markSeamPath(vStart: number, vEnd: number, state: number): number {
    return this.markEdgePath(vStart, vEnd, 0, state)
  }

  /** Mark/clear the shortest edge-path as a feature of `kind` (0 = seam, 1 =
   * sharp). The seam tool and the sharp tool share this path; markSeamPath is the
   * kind=0 alias. Returns the edge count, or -1 if no path. */
  markEdgePath(vStart: number, vEnd: number, kind: number, state: number): number {
    const n = (this.mesh as unknown as {markEdgePath(a: number, b: number, k: number, s: number): number}).markEdgePath(
      vStart,
      vEnd,
      kind,
      state
    )
    this._seamsDirty = true // the persistent overlay rebuilds on next draw
    // Edge-flag attribute edits are serialized but don't move geometry, so the
    // spatial-tree draw flush may not see them — bump explicitly (M2).
    this.meshRevision++
    return n
  }

  /** Flag the seam overlay for rebuild (e.g. after a topology/seam change). */
  markSeamsDirty(): void {
    this._seamsDirty = true
  }

  /** Flag the box-modeling selection overlay for rebuild and update the cached
   * active-element indices (per domain, -1 = none). Called by the selection /
   * modeling ops after any select or active-element change (and on undo/redo). */
  markSelectionDirty(activeVert = -1, activeEdge = -1, activeFace = -1): void {
    this._selectionDirty = true
    this._selActive = [activeVert, activeEdge, activeFace]
    this.meshRevision++
  }

  /** Update the hover-highlight element (per domain, -1 = none; the box-modeling
   * toolmode's mousemove pick). Cheap when unchanged — only a real change flags
   * the selection overlay for rebuild. */
  setHover(vert = -1, edge = -1, face = -1): void {
    const h = this._selHover
    if (h[0] === vert && h[1] === edge && h[2] === face) {
      return
    }
    this._selHover = [vert, edge, face]
    this._selectionDirty = true
    window.redraw_viewport()
  }

  /** Rebuild the selection overlay batch if the selection / active element
   * changed. Returns undefined (no batch) when nothing is selected. */
  private _ensureSelectionBatch(): void {
    if (!this._selectionDirty) {
      return
    }
    this._selectionDirty = false
    if (this.selectionBatch) {
      this.wasm.gpu.destroyBatch(this.selectionBatch, true, true)
      this.selectionBatch = undefined
    }
    this.selectionBatch =
      (
        this.spatial as unknown as {
          buildSelectionBatch(
            g: unknown,
            av: number,
            ae: number,
            af: number,
            hv: number,
            he: number,
            hf: number
          ): DrawBatch | undefined
        }
      ).buildSelectionBatch(
        this.wasm.gpu,
        this._selActive[0],
        this._selActive[1],
        this._selActive[2],
        this._selHover[0],
        this._selHover[1],
        this._selHover[2]
      ) ?? undefined
  }

  /** Rebuild the wireframe batch when the geometry/topology revision changed
   * (box modeling isn't the sculpt hot loop, so an all-edges rebuild on edit is
   * fine). Tracks `meshRevision` so it follows every topology op. */
  private _ensureWireframeBatch(): void {
    if (this._wireframeRev === this.meshRevision && this.wireframeBatch) {
      return
    }
    this._wireframeRev = this.meshRevision
    if (this.wireframeBatch) {
      this.wasm.gpu.destroyBatch(this.wireframeBatch, true, true)
      this.wireframeBatch = undefined
    }
    this.wireframeBatch =
      (this.spatial as unknown as {buildWireframeBatch(g: unknown): DrawBatch | undefined}).buildWireframeBatch(
        this.wasm.gpu
      ) ?? undefined
  }

  /** Rebuild the object-AABB bounds box batch on geometry-revision change. */
  private _ensureBoundsBatch(): void {
    if (this._boundsRev === this.meshRevision && this.boundsBatch) {
      return
    }
    this._boundsRev = this.meshRevision
    if (this.boundsBatch) {
      this.wasm.gpu.destroyBatch(this.boundsBatch, true, true)
      this.boundsBatch = undefined
    }
    this.boundsBatch =
      (this.spatial as unknown as {buildBoundsBatch(g: unknown): DrawBatch | undefined}).buildBoundsBatch(
        this.wasm.gpu
      ) ?? undefined
  }

  /** Rebuild the billboard vertex-point batch on geometry-revision change. */
  private _ensurePointsBatch(): void {
    if (this._pointsRev === this.meshRevision && this.pointsBatch) {
      return
    }
    this._pointsRev = this.meshRevision
    if (this.pointsBatch) {
      this.wasm.gpu.destroyBatch(this.pointsBatch, true, true)
      this.pointsBatch = undefined
    }
    this.pointsBatch =
      (this.spatial as unknown as {buildPointsBatch(g: unknown): DrawBatch | undefined}).buildPointsBatch(
        this.wasm.gpu
      ) ?? undefined
  }

  /** Last `includePolyGroup` the seam batch was built with, so toggling the
   * poly-group-edges option rebuilds it even when the seam set is unchanged. */
  private _seamBatchPolyGroup = false

  /** Rebuild the seam-edge overlay batch if the seam set/geometry changed, or if
   * the poly-group-edges toggle (`includePolyGroup`) flipped. */
  private _ensureSeamBatch(includePolyGroup = false): void {
    if (!this._seamsDirty && includePolyGroup === this._seamBatchPolyGroup) {
      return
    }
    this._seamsDirty = false
    this._seamBatchPolyGroup = includePolyGroup
    if (this.seamBatch) {
      this.wasm.gpu.destroyBatch(this.seamBatch, true, true)
      this.seamBatch = undefined
    }
    this.seamBatch =
      (this.spatial as unknown as {buildSeamBatch(g: unknown, p: boolean): DrawBatch | undefined}).buildSeamBatch(
        this.wasm.gpu,
        includePolyGroup
      ) ?? undefined
  }

  regenBounds(): void {
    this.needsBoundsUpdate = true
  }

  getBoundingBox(): [Vector3, Vector3] {
    if (this.needsBoundsUpdate) {
      this.needsBoundsUpdate = false
      const min = this.wasm.float3([0, 0, 0])
      const max = this.wasm.float3([0, 0, 0])
      this.mesh.calcAABB(min, max)

      const [vmin, vmax] = this.cachedBounds
      for (let i = 0; i < 3; i++) {
        vmin[i] = min.vec[i]
        vmax[i] = max.vec[i]
      }
    }
    return this.cachedBounds as [Vector3, Vector3]
  }

  /** The shortest edge-path's vertex positions as flat xyz triples (for drawing
   * the candidate/marked seam). Reads the bound Vector<float> out-param. */
  edgePathCoords(vStart: number, vEnd: number): number[] {
    const cls = (
      this.wasm.manager as {
        findVectorClass(n: string): {buildFullName(): string; findDefaultConstructor(): unknown} | undefined
      }
    ).findVectorClass('float')
    if (!cls) return []
    const ctor = cls.findDefaultConstructor()
    const vec = (this.wasm.manager as {constructWith(c: unknown): unknown}).constructWith(ctor)
    ;(this.mesh as unknown as {edgePathCoords(a: number, b: number, out: never): void}).edgePathCoords(
      vStart,
      vEnd,
      vec as never
    )
    const arr = this.wasm.getBoundVector(cls.buildFullName(), vec as never) as ArrayLike<number>
    const out: number[] = []
    for (let i = 0; i < arr.length; i++) out.push(arr[i])
    return out
  }

  /** Edge indices along the shortest vStart→vEnd path (the edges markSeamPath
   * would flag), so a ToolOp can snapshot their prior seam state for undo. */
  edgePathEdges(vStart: number, vEnd: number): number[] {
    const out = this._intVecOut()
    ;(this.mesh as unknown as {edgePathEdges(a: number, b: number, o: never): void}).edgePathEdges(
      vStart,
      vEnd,
      out.vec as never
    )
    const arr = out.read()
    const res: number[] = []
    for (let i = 0; i < arr.length; i++) res.push(arr[i])
    return res
  }

  /** Poly-group id of a face (0 = unassigned; the polygroup brush paints these). */
  faceGroup(face: number): number {
    return (this.mesh as unknown as {faceGroup(f: number): number}).faceGroup(face)
  }

  /**
   * Select every face in poly-group `group`, returning how many were selected.
   * The gathered index Vector is handed straight back to selectIndices, so the
   * indices never cross into JS — a group can cover most of the mesh, and a
   * per-face selectOne loop would be one binding round trip each.
   * Caller owns the surrounding selectionBeginStep/EndStep.
   */
  selectPolyGroup(log: IMeshLogSelect, group: number): number {
    const out = this._intVecOut()
    ;(this.mesh as unknown as {facesInGroup(g: number, o: never): void}).facesInGroup(group, out.vec as never)

    const n = out.read().length
    if (n === 0) {
      return 0
    }

    log.selectIndices(this.mesh, 2, out.vec, 1)
    return n
  }

  /**
   * Select every element similar to `seed` under `criterion`
   * (Mesh::SimilarCriterion; the criterion implies the domain). The gathered
   * index Vector is handed straight to selectIndices, so indices never cross
   * into JS. `domain` (0 vert / 1 edge / 2 face) must match the criterion's
   * domain. Caller owns selectionBeginStep/EndStep. Returns the count.
   */
  selectSimilar(log: IMeshLogSelect, criterion: number, seed: number, threshold: number, domain: number): number {
    const out = this._intVecOut()
    ;(this.mesh as unknown as {selectSimilar(c: number, s: number, t: number, o: never): void}).selectSimilar(
      criterion,
      seed,
      threshold,
      out.vec as never
    )

    const n = out.read().length
    if (n === 0) {
      return 0
    }
    log.selectIndices(this.mesh, domain, out.vec, 1)
    return n
  }

  /** Material slot of a face — an index into SceneObjectData.materials, not a
   * datablock id. 0 (and an absent attr) = the object's first material. */
  faceMaterial(face: number): number {
    return (this.mesh as unknown as {faceMaterial(f: number): number}).faceMaterial(face)
  }

  /** Highest material slot any face references (0 = mesh is single-material). */
  maxFaceMaterial(): number {
    return (this.mesh as unknown as {maxFaceMaterial(): number}).maxFaceMaterial()
  }

  /**
   * How far material assignment cuts across the spatial tree: one entry per GPU
   * node (in drawBatch command order) or per leaf, each carrying the count and
   * bitmask of distinct slots it touches. Diagnostic for the draw-splitting
   * design — summing `distinct` over GPU nodes gives the draw-command count
   * that splitting by material would cost.
   */
  materialStats(perLeaf: boolean): {id: number; distinct: number; mask: number}[] {
    const out = this._intVecOut()
    ;(this.spatial as unknown as {materialStats(p: boolean, o: never): void}).materialStats(perLeaf, out.vec as never)

    const arr = out.read()
    const res: {id: number; distinct: number; mask: number}[] = []
    for (let i = 0; i + 2 < arr.length; i += 3) {
      res.push({id: arr[i], distinct: arr[i + 1], mask: arr[i + 2]})
    }
    return res
  }

  /** A material assignment's before-state: the faces touched and the slot each
   * one had. Small (only the assigned faces) and enough to undo exactly. */
  private _materialSnapshot(vec: unknown): {faces: number[]; prior: number[]} {
    const prev = this._intVecOut()
    ;(this.mesh as unknown as {facesMaterialSlots(f: never, o: never): void}).facesMaterialSlots(
      vec as never,
      prev.vec as never
    )

    const fsrc = this.wasm.getBoundVector(
      (this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string}})
        .findVectorClass('int32')
        .buildFullName(),
      vec as never
    ) as ArrayLike<number>
    const psrc = prev.read()

    const faces: number[] = []
    const prior: number[] = []
    for (let i = 0; i < fsrc.length; i++) {
      faces.push(fsrc[i])
      prior.push(psrc[i])
    }
    return {faces, prior}
  }

  /** Assign `faces` (a bound Vector) to `slot`, returning the undo snapshot. */
  private _assignMaterial(vec: unknown, slot: number): {faces: number[]; prior: number[]} {
    const snap = this._materialSnapshot(vec)
    if (snap.faces.length > 0) {
      ;(this.mesh as unknown as {setFacesMaterial(f: never, s: number): void}).setFacesMaterial(vec as never, slot)
    }
    return snap
  }

  /**
   * Put every currently-selected face on material slot `slot`. The selection is
   * gathered and handed back to C++ as the same bound Vector, so the indices
   * never cross into JS. Returns the before-state for undo.
   */
  assignMaterialToSelected(slot: number): {faces: number[]; prior: number[]} {
    const out = this._intVecOut()
    ;(this.mesh as unknown as {selectedElems(d: number, o: never): void}).selectedElems(2, out.vec as never)
    return this._assignMaterial(out.vec, slot)
  }

  /**
   * Put a material assignment's before-state back (undo). Groups the faces by
   * their prior slot so it's one bulk call per distinct slot rather than per
   * face — which is only possible because `setBoundIntVector` can hand C++ a
   * JS-computed index set. One scratch Vector is reused across the slots.
   */
  restoreMaterialSnapshot(snap: {faces: number[]; prior: number[]}): void {
    const bySlot = new Map<number, number[]>()
    for (let i = 0; i < snap.faces.length; i++) {
      const slot = snap.prior[i]
      let list = bySlot.get(slot)
      if (!list) {
        bySlot.set(slot, (list = []))
      }
      list.push(snap.faces[i])
    }

    const out = this._intVecOut()
    for (const [slot, faces] of bySlot) {
      this.wasm.setBoundIntVector(out.vec as never, faces)
      ;(this.mesh as unknown as {setFacesMaterial(f: never, s: number): void}).setFacesMaterial(out.vec as never, slot)
    }
  }

  /** Put an explicit face list on material slot `slot`; returns the before-state.
   * The index set comes from the app, so this needs the JS->C++ Vector fill. */
  assignMaterialToFaces(faces: number[], slot: number): {faces: number[]; prior: number[]} {
    const out = this._intVecOut()
    this.wasm.setBoundIntVector(out.vec as never, faces)
    return this._assignMaterial(out.vec, slot)
  }

  /** Put every face in poly-group `group` on material slot `slot`. */
  assignMaterialToPolyGroup(group: number, slot: number): {faces: number[]; prior: number[]} {
    const out = this._intVecOut()
    ;(this.mesh as unknown as {facesInGroup(g: number, o: never): void}).facesInGroup(group, out.vec as never)
    return this._assignMaterial(out.vec, group === 0 ? 0 : slot)
  }

  /** Read a single edge's EDGE_SEAM bit (0/1). */
  edgeSeam(e: number): number {
    return (this.mesh as unknown as {edgeSeam(e: number): number}).edgeSeam(e)
  }

  /** Read a single edge's feature bit of `kind` (0 = seam, 1 = sharp). */
  edgeFlagKind(e: number, kind: number): number {
    return (this.mesh as unknown as {edgeFlagKind(e: number, k: number): number}).edgeFlagKind(e, kind)
  }

  /** Mark EDGE_SHARP on every manifold edge whose dihedral angle exceeds
   * `angleRadians` (additive). Returns the number of edges changed. */
  markSharpByAngle(angleRadians: number, state = 1): number {
    const n = (this.mesh as unknown as {markSharpByAngle(a: number, s: number): number}).markSharpByAngle(
      angleRadians,
      state
    )
    this.markSeamsDirty()
    return n
  }

  /** Indices + xyz (object-local) of every vertex incident to a `kind`-flagged
   * edge (0 = seam, 1 = sharp), index-aligned. The marking tool projects these
   * to screen to snap the path endpoint onto an existing feature vertex. */
  featureVerts(kind: number): {idx: number[]; co: number[]} {
    const idxOut = this._intVecOut()
    const cls = (
      this.wasm.manager as {
        findVectorClass(n: string): {buildFullName(): string; findDefaultConstructor(): unknown} | undefined
      }
    ).findVectorClass('float')
    if (!cls) return {idx: [], co: []}
    const ctor = cls.findDefaultConstructor()
    const coVec = (this.wasm.manager as {constructWith(c: unknown): unknown}).constructWith(ctor)
    ;(this.mesh as unknown as {featureVerts(k: number, oi: never, oc: never): void}).featureVerts(
      kind,
      idxOut.vec as never,
      coVec as never
    )
    const idxArr = idxOut.read()
    const coArr = this.wasm.getBoundVector(cls.buildFullName(), coVec as never) as ArrayLike<number>
    const idx: number[] = []
    const co: number[] = []
    for (let i = 0; i < idxArr.length; i++) idx.push(idxArr[i])
    for (let i = 0; i < coArr.length; i++) co.push(coArr[i])
    return {idx, co}
  }

  /** Boundary polyline-graph stats over the union of all boundary edge flags.
   * non2ValenceVerts/components are invariant under feature-preserving
   * remeshing, so they detect constraint-network damage (integration tests). */
  boundaryGraphStats(): {flaggedEdges: number; graphVerts: number; non2ValenceVerts: number; components: number} {
    const out = this._intVecOut()
    ;(this.mesh as unknown as {boundaryGraphStats(o: never): void}).boundaryGraphStats(out.vec as never)
    const arr = out.read()
    return {
      flaggedEdges    : (arr[0] as number) | 0,
      graphVerts      : (arr[1] as number) | 0,
      non2ValenceVerts: (arr[2] as number) | 0,
      components      : (arr[3] as number) | 0,
    }
  }

  /** Restore a batch of edge seam bits (parallel arrays) then recompute derived
   * boundary state once — the true inverse used by seam-marking undo, instead of
   * blanket-clearing the path (which would unset pre-existing overlapping seams). */
  restoreSeamEdges(edges: number[], states: number[]): void {
    this.restoreEdgeFlags(edges, states, 0)
  }

  /** restoreSeamEdges generalized to a feature `kind` (0 = seam, 1 = sharp): the
   * true inverse used by the marking tool's undo for either flag. */
  restoreEdgeFlags(edges: number[], states: number[], kind: number): void {
    const m = this.mesh as unknown as {
      setEdgeFlagKind(e: number, k: number, s: number): void
      recomputeBoundary(): void
    }
    for (let i = 0; i < edges.length; i++) m.setEdgeFlagKind(edges[i], kind, states[i])
    m.recomputeBoundary()
    this._seamsDirty = true
  }

  /** Read every live vertex's index + object-local position as flat (idx,x,y,z)
   * quadruples (the C++ `dumpVertCo` out-param). Backend-agnostic; pairs with
   * `setVertCo` for the symmetrize op's read→mirror→write pass. */
  dumpVertCo(): {idx: number[]; co: number[][]} {
    const cls = (
      this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string; findDefaultConstructor(): unknown}}
    ).findVectorClass('float')
    const ctor = cls.findDefaultConstructor()
    const vec = (this.wasm.manager as {constructWith(c: unknown): unknown}).constructWith(ctor)
    ;(this.mesh as unknown as {dumpVertCo(o: never): void}).dumpVertCo(vec as never)
    const arr = this.wasm.getBoundVector(cls.buildFullName(), vec as never) as ArrayLike<number>
    const idx: number[] = []
    const co: number[][] = []
    for (let i = 0; i + 3 < arr.length; i += 4) {
      idx.push(arr[i] | 0)
      co.push([arr[i + 1], arr[i + 2], arr[i + 3]])
    }
    return {idx, co}
  }

  /** Write the position of live vertex `idx` (a per-vertex scalar setter — the
   * only marshal-safe vertex-write seam). Caller refreshes the spatial tree. */
  setVertCo(idx: number, x: number, y: number, z: number): void {
    ;(this.mesh as unknown as {setVertCo(i: number, x: number, y: number, z: number): void}).setVertCo(idx, x, y, z)
  }

  /** Rebuild the spatial tree after a direct positional edit (e.g. the symmetrize
   * op's setVertCo pass). Unlike a brush deform, those writes don't flag spatial
   * nodes, so node bounds and the GPU vertex buffers both go stale until the tree
   * is rebuilt; `regenTreeBatch` alone only drops the overlay batch. */
  rebuildSpatialFromEdit(): void {
    this._rebuildSpatial()
  }

  /** Destructive symmetrize across the `axis` (0=x,1=y,2=z) plane: bisect the
   * mesh, keep the `sign` half (+1 positive / -1 negative), mirror it, weld the
   * seam watertight (native `Mesh::symmetrize`). Topology changes wholesale, so
   * normals + the spatial tree are recomputed. Backend-agnostic. */
  symmetrizeDestructive(axis: number, sign: number, threshold: number): void {
    ;(this.mesh as unknown as {symmetrize(a: number, s: number, t: number): void}).symmetrize(axis, sign, threshold)
    this.recalcNormals()
    this._rebuildSpatial()
  }

  /* ----- Wave 7: UV generation from seams ----- */

  /** Corner-domain layer names (to diff what generateUVFromSeams just created). */
  private _cornerLayerNames(): string[] {
    const grp = this._domainGroup(AttrDomain.CORNER)
    if (!grp?.attrs) return []
    const cls = (
      this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string} | undefined}
    ).findVectorClass('sculptcore::mesh::AttrRef')
    if (!cls) return []
    const arr = this.wasm.getBoundVector(cls.buildFullName(), grp.attrs as never) as ArrayLike<{name: string}>
    const out: string[] = []
    for (let i = 0; i < arr.length; i++) out.push(arr[i].name)
    return out
  }

  /** Generate a per-corner UV map from EDGE_SEAM-bounded charts (the unwrapper).
   * `margin` is the [0,1] shelf-pack margin. Creates a FLOAT2 corner layer
   * (tagged UV) and returns {charts, name} — the new layer's name lets the tool
   * undo by detaching it. */
  generateUVFromSeams(margin = 0.01): {charts: number; name: string} {
    const before = new Set(this._cornerLayerNames())
    const charts = (this.mesh as unknown as {generateUVFromSeams(m: number): number}).generateUVFromSeams(
      Math.round(margin * 1000)
    )
    const name = this._cornerLayerNames().find((n) => !before.has(n)) ?? ''
    return {charts, name}
  }

  /** Seam every edge (so generateUVFromSeams produces a per-face cuboid map).
   * Test/demo helper; flags the seam overlay for rebuild. */
  markAllSeams(): void {
    ;(this.mesh as unknown as {markAllSeams(): void}).markAllSeams()
    this._seamsDirty = true
  }

  /** Fill the first vertex FLOAT4 COLOR layer with a deterministic position->rgb
   * gradient. Test/demo helper (no brush stroke needed). */
  fillVertexColorFromPosition(): void {
    ;(this.mesh as unknown as {fillVertexColorFromPosition(): void}).fillVertexColorFromPosition()
  }

  /* ----- Viewport area picking (overrides SceneObjectData defaults) -----
   * Backed by the sculptcore SpatialTree's cone (circle) / frustum (rect)
   * queries. Backend-agnostic: ray endpoints and rect corners are marshaled as
   * bound float3s, and the face/vert index out-params as bound Vector<int>s
   * (WASM via the binding runtime; native via the N-API makeIntVector helper).
   * Elements are mesh face/vertex indices, so `ScreenPickResult.elements` holds
   * numbers (consistent with the `unknown[]` contract). */

  /** Construct two empty bound Vector<int> out-params + an array-like reader.
   * 'int32' is the WASM manager's registry key for int (native accepts both). */
  private _intVecOut() {
    const cls = (
      this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string; findDefaultConstructor(): unknown}}
    ).findVectorClass('int32')
    const ctor = cls.findDefaultConstructor()
    const vec = (this.wasm.manager as {constructWith(c: unknown): unknown}).constructWith(ctor)
    const read = () => this.wasm.getBoundVector(cls.buildFullName(), vec as never) as ArrayLike<number>
    return {vec, read}
  }

  /** Float sibling of _intVecOut ('float' is the manager's registry key). */
  private _floatVecOut() {
    const cls = (
      this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string; findDefaultConstructor(): unknown}}
    ).findVectorClass('float')
    const ctor = cls.findDefaultConstructor()
    const vec = (this.wasm.manager as {constructWith(c: unknown): unknown}).constructWith(ctor)
    const read = () => this.wasm.getBoundVector(cls.buildFullName(), vec as never) as ArrayLike<number>
    return {vec, read}
  }

  /** Gather the box-modeling "movable" vert set (every vertex touched by any
   * selected element) plus their object-local positions — the transform bridge's
   * read at grab start. Returns the bound index vector (reused by
   * markVertsMovedGPU each modal step) alongside JS copies. */
  gatherMovableVerts(): {idxVec: unknown; idx: number[]; co: number[]} {
    const idxOut = this._intVecOut()
    ;(this.mesh as unknown as {movableVerts(o: never): void}).movableVerts(idxOut.vec as never)
    const idx = Array.from(idxOut.read())
    const coOut = this._floatVecOut()
    ;(this.mesh as unknown as {gatherVertCos(i: never, o: never): void}).gatherVertCos(
      idxOut.vec as never,
      coOut.vec as never
    )
    const co = Array.from(coOut.read())
    return {idxVec: idxOut.vec, idx, co}
  }

  /** Flag the spatial leaves of the given verts (the bound vec from
   * gatherMovableVerts) for GPU regen after a direct setVertCo edit, so the next
   * draw reflects the move without a full spatial rebuild (the transform bridge's
   * per-step GPU update). */
  markVertsMovedGPU(idxVec: unknown): void {
    ;(this.spatial as unknown as {markVertsMoved(v: never): void}).markVertsMoved(idxVec as never)
  }

  /** Extrude the selected face region (creates the cap + bridge side-quads in the
   * given MeshLog step, leaves the new region selected). Returns the averaged,
   * object-local face normal for the chained transform's constraint axis. Caller
   * rebuilds the spatial tree afterward (topology changed wholesale). */
  extrudeRegion(log: unknown): number[] {
    const out = this._floatVecOut()
    ;(log as {extrudeRegion(m: unknown, o: unknown): void}).extrudeRegion(this.mesh, out.vec)
    return Array.from(out.read())
  }

  /** Extrude each selected face individually (no boundary merge — adjacent faces
   * split apart). Returns the averaged face normal. */
  extrudeIndividual(log: unknown): number[] {
    const out = this._floatVecOut()
    ;(log as {extrudeIndividual(m: unknown, o: unknown): void}).extrudeIndividual(this.mesh, out.vec)
    return Array.from(out.read())
  }

  /** Extrude selected verts as wires (duplicate + edge to original; the duplicate
   * is the movable selection). Returns a placeholder normal. */
  extrudeWireVerts(log: unknown): number[] {
    const out = this._floatVecOut()
    ;(log as {extrudeWireVerts(m: unknown, o: unknown): void}).extrudeWireVerts(this.mesh, out.vec)
    return Array.from(out.read())
  }

  /** Detach the selected face region (duplicate its boundary so it disconnects;
   * the whole region is left selected for a translate). Returns the averaged
   * face normal. Caller rebuilds the spatial tree. */
  splitFacesOff(log: unknown): number[] {
    const out = this._floatVecOut()
    ;(log as {splitFacesOff(m: unknown, o: unknown): void}).splitFacesOff(this.mesh, out.vec)
    return Array.from(out.read())
  }

  /** Subdivide the selected edges (or, if none, the selected faces' edges) with
   * `numCuts` cuts each (Blender-style: numCuts+1 segments). Fully-cut quads
   * become an (numCuts+1)² grid, two-opposite-cut quads a strip; partially-cut
   * neighbors keep one face with the cut verts inserted (no T-junction). Returns
   * the new cut verts (left selected). Caller rebuilds the tree. */
  subdivideEdges(log: unknown, numCuts: number): number[] {
    const out = this._intVecOut()
    ;(log as {subdivideEdges(m: unknown, n: number, o: unknown): void}).subdivideEdges(this.mesh, numCuts, out.vec)
    return Array.from(out.read())
  }

  /** Loop-cut the quad strip under the cursor ray (object-local origin/dir): the
   * C++ side casts against the spatial tree, seeds from the hit face's nearest
   * edge, and cuts the whole ring at its midpoint. Returns the new loop's vert
   * indices (empty if the ray missed); the loop is left selected. */
  loopCutAtRay(log: unknown, origin: Vector3, dir: Vector3): number[] {
    const out = this._intVecOut()
    const o3 = this.wasm.float3([origin[0], origin[1], origin[2]])
    const d3 = this.wasm.float3([dir[0], dir[1], dir[2]])
    ;(log as {loopCutAtRay(m: unknown, t: unknown, o: unknown, d: unknown, v: unknown): void}).loopCutAtRay(
      this.mesh,
      this.spatial,
      o3,
      d3,
      out.vec
    )
    return Array.from(out.read())
  }

  /** Build the inset ring for the selected face region in the CURRENTLY OPEN
   * MeshLog step (the parametric modal op brackets it). Returns the inset vert
   * indices (also a reusable bound vec for markVertsMoved), their base/boundary
   * positions, and per-vert inward tangents (flat xyz). The modal then drives
   * `co = base + width·tangent`. */
  insetRegion(log: unknown): {idxVec: unknown; idx: number[]; base: number[]; tangent: number[]} {
    const idxV = this._intVecOut()
    const baseV = this._floatVecOut()
    const tanV = this._floatVecOut()
    ;(log as {insetRegion(m: unknown, i: unknown, b: unknown, t: unknown): void}).insetRegion(
      this.mesh,
      idxV.vec,
      baseV.vec,
      tanV.vec
    )
    return {
      idxVec : idxV.vec,
      idx    : Array.from(idxV.read()),
      base   : Array.from(baseV.read()),
      tangent: Array.from(tanV.read()),
    }
  }

  /** Bevel the selected verts in the CURRENTLY OPEN MeshLog step (the parametric
   * modal brackets it, like insetRegion). Each selected interior-manifold vert is
   * replaced by an offset vert per incident edge plus a cap n-gon; the offset
   * verts are returned with base coords + per-vert edge tangents, and the modal
   * drives `co = base + width·tangent`. */
  bevelVerts(log: unknown): {idxVec: unknown; idx: number[]; base: number[]; tangent: number[]} {
    const idxV = this._intVecOut()
    const baseV = this._floatVecOut()
    const tanV = this._floatVecOut()
    ;(log as {bevelVerts(m: unknown, i: unknown, b: unknown, t: unknown): void}).bevelVerts(
      this.mesh,
      idxV.vec,
      baseV.vec,
      tanV.vec
    )
    return {
      idxVec : idxV.vec,
      idx    : Array.from(idxV.read()),
      base   : Array.from(baseV.read()),
      tangent: Array.from(tanV.read()),
    }
  }

  /** Unproject the view cone (near→far through the cursor, in object-local
   * space) for a circle/brush query, exactly as the WebGL BVH brush path does.
   * Shared by castScreenCircle (picking) and selectCircle (box-modeling). */
  private _coneParams(
    view3d: View3D,
    object: SceneObject,
    mpos: Vector2,
    radius: number
  ): {origin: Vector3; ray: Vector3; radius1: number; radius2: number} {
    const obmatrix = object.outputs.matrix.getValue()
    // clip→local = (rendermat∘obmat)^-1 — path.ux multiply applies its ARGUMENT
    // first, so compose as load(rendermat).multiply(obmat) before inverting.
    const imat = new Matrix4(view3d.activeCamera.rendermat)
    imat.multiply(obmatrix)
    imat.invert()

    const x = ~~mpos[0]
    const y = ~~mpos[1]
    const d = 0.9999

    const p1 = new Vector4()
    const p2 = new Vector4()

    p1[0] = x
    p1[1] = y
    p1[2] = -d
    p1[3] = 1.0
    view3d.unproject(p1, imat)
    const origin = new Vector3(p1)

    p2[0] = x + 1.0
    p2[1] = y + 1.0
    p2[2] = -d
    p2[3] = 1.0
    view3d.unproject(p2, imat)
    const radius1 = (new Vector3(p2).vectorDistance(origin) * radius) / Math.sqrt(2)

    p1[0] = x
    p1[1] = y
    p1[2] = d
    p1[3] = 1.0
    view3d.unproject(p1, imat)
    const dest = new Vector3(p1)
    const ray = new Vector3(dest).sub(origin)

    p2[0] = x + 1.0
    p2[1] = y + 1.0
    p2[2] = d
    p2[3] = 1.0
    view3d.unproject(p2, imat)
    const radius2 = (new Vector3(p2).vectorDistance(dest) * radius) / Math.sqrt(2)

    return {origin, ray, radius1, radius2}
  }

  castScreenCircle(
    _ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selmask: number,
    mpos: Vector2,
    radius: number
  ): ScreenPickResult {
    const {origin, ray, radius1, radius2} = this._coneParams(view3d, object, mpos, radius)

    const faces = this._intVecOut()
    const verts = this._intVecOut()

    this.spatial.castScreenCircle(
      this.wasm.float3([origin[0], origin[1], origin[2]]) as never,
      this.wasm.float3([ray[0], ray[1], ray[2]]) as never,
      radius1,
      radius2,
      faces.vec as never,
      verts.vec as never
    )

    return this._buildPickResult(object, faces.read(), verts.read(), selmask)
  }

  /** Unproject the 4 screen-rect corners at the near + far clip planes → 8
   * object-local corners (the SpatialTree builds + orients the frustum planes).
   * Shared by castScreenRect (picking) and selectRect (box-modeling). */
  private _rectCorners(view3d: View3D, object: SceneObject, min: Vector2, max: Vector2): Vector3[] {
    const obmatrix = object.outputs.matrix.getValue()
    // clip→local = (rendermat∘obmat)^-1 — path.ux multiply applies its ARGUMENT
    // first, so compose as load(rendermat).multiply(obmat) before inverting.
    const imat = new Matrix4(view3d.activeCamera.rendermat)
    imat.multiply(obmatrix)
    imat.invert()

    const corners2d = [
      [min[0], min[1]],
      [max[0], min[1]],
      [max[0], max[1]],
      [min[0], max[1]],
    ]
    const d = 0.9999
    const local: Vector3[] = []

    for (const [px, py] of corners2d) {
      const pn = new Vector4([px, py, -d, 1.0])
      view3d.unproject(pn, imat)
      local.push(new Vector3(pn))
    }
    for (const [px, py] of corners2d) {
      const pf = new Vector4([px, py, d, 1.0])
      view3d.unproject(pf, imat)
      local.push(new Vector3(pf))
    }
    return local
  }

  castScreenRect(
    _ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selmask: number,
    min: Vector2,
    max: Vector2
  ): ScreenPickResult {
    const local = this._rectCorners(view3d, object, min, max)
    const f3 = (v: Vector3) => this.wasm.float3([v[0], v[1], v[2]]) as never

    const faces = this._intVecOut()
    const verts = this._intVecOut()

    this.spatial.castScreenRect(
      f3(local[0]),
      f3(local[1]),
      f3(local[2]),
      f3(local[3]),
      f3(local[4]),
      f3(local[5]),
      f3(local[6]),
      f3(local[7]),
      faces.vec as never,
      verts.vec as never
    )

    return this._buildPickResult(object, faces.read(), verts.read(), selmask)
  }

  /**
   * Pack face + vert index arrays into a ScreenPickResult. `selmask` selects
   * which domain(s) are returned (VERTEX and/or FACE; defaulting to vertices
   * when neither bit is set, since brush/box select is vertex-centric). Each
   * element is a `LiteMeshPickElem` tagging its domain, so a consumer narrowing
   * the `unknown[]` can tell a face index from a vert index (the C++ query
   * always fills both vectors; the mask just filters what we surface).
   */
  private _buildPickResult(
    object: SceneObject,
    faces: ArrayLike<number>,
    verts: ArrayLike<number>,
    selmask: number
  ): ScreenPickResult {
    const elements: LiteMeshPickElem[] = []
    const elementObjects: SceneObject[] = []
    const elementDists: number[] = []

    const wantFaces = !!(selmask & SelMask.FACE)
    const wantVerts = !!(selmask & SelMask.VERTEX) || !wantFaces

    if (wantFaces) {
      for (let i = 0; i < faces.length; i++) {
        elements.push({type: 'face', index: faces[i]})
        elementObjects.push(object)
        elementDists.push(0)
      }
    }
    if (wantVerts) {
      for (let i = 0; i < verts.length; i++) {
        elements.push({type: 'vert', index: verts[i]})
        elementObjects.push(object)
        elementDists.push(0)
      }
    }

    return {elements, elementObjects, elementDists}
  }

  /* ----- Box-modeling selection (overrides write the `select` attr through the
   * shared C++ MeshLog so they ride undo). The caller (a modeling ToolOp)
   * brackets the MeshLog step via `log.selectionBeginStep/EndStep`; these just
   * issue the pick + select. `domain` is 0 = vertex, 1 = edge, 2 = face. ----- */

  /** Resolve a ray to the mesh face it hits (-1 on a miss). Vertex sibling of
   * pickVert; used by face-mode nearest pick. */
  pickFace(origin: Vector3, dir: Vector3): number {
    const isectOut = this.wasm.manager.construct('sculptcore::spatial::CastRayIsect')
    try {
      const originF3 = this.wasm.float3([origin[0], origin[1], origin[2]])
      const dirF3 = this.wasm.float3([dir[0], dir[1], dir[2]])
      const hit = this.spatial.castRay(originF3, dirF3, isectOut)
      return hit ? (isectOut as unknown as {faceIndex: number}).faceIndex : -1
    } finally {
      ;(isectOut as unknown as {[Symbol.dispose]?: () => void})[Symbol.dispose]?.()
    }
  }

  /** Resolve a cursor position to the mesh edge nearest it in SCREEN space
   * (-1 on a miss): castRay to a face, then project that face's edges to pixels
   * and take the closest segment to the cursor. A 3D nearest-to-hit-point test
   * systematically mis-picks on foreshortened (view-tilted) surfaces — 1px of
   * screen distance maps to very different 3D distances along vs across the
   * tilt. The edge-mode click pick and the loop-select seed. */
  pickEdge(view3d: View3D, object: SceneObject, mx: number, my: number): number {
    // Object-local cursor ray (same construction as _coneParams).
    const obmatrix = object.outputs.matrix.getValue()
    // clip→local = (rendermat∘obmat)^-1 — path.ux multiply applies its ARGUMENT
    // first, so compose as load(rendermat).multiply(obmat) before inverting.
    const imat = new Matrix4(view3d.activeCamera.rendermat)
    imat.multiply(obmatrix)
    imat.invert()
    const d = 0.9999
    const p1 = new Vector4([mx, my, -d, 1.0])
    view3d.unproject(p1, imat)
    const origin = new Vector3(p1)
    const p2 = new Vector4([mx, my, d, 1.0])
    view3d.unproject(p2, imat)
    const dir = new Vector3(p2).sub(origin)

    const isectOut = this.wasm.manager.construct('sculptcore::spatial::CastRayIsect')
    let face = -1
    try {
      const originF3 = this.wasm.float3([origin[0], origin[1], origin[2]])
      const dirF3 = this.wasm.float3([dir[0], dir[1], dir[2]])
      const hit = this.spatial.castRay(originF3, dirF3, isectOut)
      face = hit ? (isectOut as unknown as {faceIndex: number}).faceIndex : -1
    } finally {
      ;(isectOut as unknown as {[Symbol.dispose]?: () => void})[Symbol.dispose]?.()
    }
    if (face < 0) {
      return -1
    }

    const edgesOut = this._intVecOut()
    const coordsOut = this._floatVecOut()
    ;(this.mesh as unknown as {faceEdgeList(f: number, e: unknown, c: unknown): void}).faceEdgeList(
      face,
      edgesOut.vec,
      coordsOut.vec
    )
    const edges = edgesOut.read()
    const co = coordsOut.read()

    // Nearest projected segment to the cursor, in pixels.
    const a = new Vector3()
    const b = new Vector3()
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < edges.length; i++) {
      a[0] = co[i * 6]
      a[1] = co[i * 6 + 1]
      a[2] = co[i * 6 + 2]
      b[0] = co[i * 6 + 3]
      b[1] = co[i * 6 + 4]
      b[2] = co[i * 6 + 5]
      a.multVecMatrix(obmatrix)
      b.multVecMatrix(obmatrix)
      if (view3d.project(a) <= 0 || view3d.project(b) <= 0) {
        continue // behind the camera
      }
      const abx = b[0] - a[0]
      const aby = b[1] - a[1]
      const len2 = abx * abx + aby * aby
      let t = len2 > 1e-12 ? ((mx - a[0]) * abx + (my - a[1]) * aby) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const dx = mx - (a[0] + abx * t)
      const dy = my - (a[1] + aby * t)
      const dist = dx * dx + dy * dy
      if (dist < bestD) {
        bestD = dist
        best = edges[i]
      }
    }
    return best
  }

  /** Resolve a cursor position to the mesh vert nearest it in SCREEN space
   * (-1 on a miss): castRay to a face, project that face's verts to pixels and
   * take the closest to the cursor. The 3D highest-barycentric `pickVert`
   * systematically mis-picks on coarse meshes — a dimen=2 cube face is one
   * huge quad, so the hit triangle's max-weight corner is usually not the
   * vertex under the cursor. The vertex-mode click pick and hover. */
  pickVertScreen(view3d: View3D, object: SceneObject, mx: number, my: number): number {
    const obmatrix = object.outputs.matrix.getValue()
    // clip→local = (rendermat∘obmat)^-1 — path.ux multiply applies its ARGUMENT
    // first, so compose as load(rendermat).multiply(obmat) before inverting.
    const imat = new Matrix4(view3d.activeCamera.rendermat)
    imat.multiply(obmatrix)
    imat.invert()
    const d = 0.9999
    const p1 = new Vector4([mx, my, -d, 1.0])
    view3d.unproject(p1, imat)
    const origin = new Vector3(p1)
    const p2 = new Vector4([mx, my, d, 1.0])
    view3d.unproject(p2, imat)
    const dir = new Vector3(p2).sub(origin)

    const isectOut = this.wasm.manager.construct('sculptcore::spatial::CastRayIsect')
    let face = -1
    try {
      const originF3 = this.wasm.float3([origin[0], origin[1], origin[2]])
      const dirF3 = this.wasm.float3([dir[0], dir[1], dir[2]])
      const hit = this.spatial.castRay(originF3, dirF3, isectOut)
      face = hit ? (isectOut as unknown as {faceIndex: number}).faceIndex : -1
    } finally {
      ;(isectOut as unknown as {[Symbol.dispose]?: () => void})[Symbol.dispose]?.()
    }
    if (face < 0) {
      return -1
    }

    const vertsOut = this._intVecOut()
    const coordsOut = this._floatVecOut()
    ;(this.mesh as unknown as {faceVertList(f: number, v: unknown, c: unknown): void}).faceVertList(
      face,
      vertsOut.vec,
      coordsOut.vec
    )
    const verts = vertsOut.read()
    const co = coordsOut.read()

    const a = new Vector3()
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < verts.length; i++) {
      a[0] = co[i * 3]
      a[1] = co[i * 3 + 1]
      a[2] = co[i * 3 + 2]
      a.multVecMatrix(obmatrix)
      if (view3d.project(a) <= 0) {
        continue // behind the camera
      }
      const dx = mx - a[0]
      const dy = my - a[1]
      const dist = dx * dx + dy * dy
      if (dist < bestD) {
        bestD = dist
        best = verts[i]
      }
    }
    return best
  }

  /** Loop-cut preview segments for the ring through `seedEdge`: flat xyz pairs
   * (6 floats per face-loop quad), object-local — the polyline the cut will
   * create. Empty when the seed isn't on a quad strip. */
  loopCutPreviewCoords(seedEdge: number): number[] {
    const out = this._floatVecOut()
    ;(this.mesh as unknown as {loopCutPreviewCoords(e: number, o: unknown): void}).loopCutPreviewCoords(
      seedEdge,
      out.vec
    )
    return Array.from(out.read())
  }

  /** Cone (circle/brush) select through the cursor: pick + select happen in C++
   * (no index array crosses the binding). The op brackets the step. */
  selectCircle(
    view3d: View3D,
    object: SceneObject,
    mpos: Vector2,
    radius: number,
    domain: number,
    state: number,
    log: IMeshLogSelect
  ): void {
    const {origin, ray, radius1, radius2} = this._coneParams(view3d, object, mpos, radius)
    log.selectScreenCircle(
      this.mesh,
      this.spatial,
      this.wasm.float3([origin[0], origin[1], origin[2]]),
      this.wasm.float3([ray[0], ray[1], ray[2]]),
      radius1,
      radius2,
      domain,
      state
    )
  }

  /** Box (frustum) select over a screen rectangle: pick + select in C++. */
  selectRect(
    view3d: View3D,
    object: SceneObject,
    min: Vector2,
    max: Vector2,
    domain: number,
    state: number,
    log: IMeshLogSelect
  ): void {
    const local = this._rectCorners(view3d, object, min, max)
    const f3 = (v: Vector3) => this.wasm.float3([v[0], v[1], v[2]])
    log.selectScreenRect(
      this.mesh,
      this.spatial,
      f3(local[0]),
      f3(local[1]),
      f3(local[2]),
      f3(local[3]),
      f3(local[4]),
      f3(local[5]),
      f3(local[6]),
      f3(local[7]),
      domain,
      state
    )
  }

  regenTreeBatch() {
    if (this.treeBatch) {
      this.wasm.gpu.destroyBatch(this.treeBatch, true, true)
      this.treeBatch = undefined
    }
    return this
  }

  /** Recompute vertex normals from the current positions (bound C++
   * recalc_normals). Needed after a direct positional edit — e.g. symmetrize —
   * that bypasses the brush-deform path's own normal updates. */
  recalcNormals(): void {
    ;(this.mesh as unknown as {recalc_normals(): void}).recalc_normals()
  }

  /** Surface color source; see LiteMeshDisplayMode. Setting it flags every GPU
   * node (via the C++ setColorDisplayMode) so the next update re-fills the color
   * stream from the new source. The draw batch isn't cached on the TS side
   * (getDrawBatch is re-fetched each frame), so nothing to drop here. */
  get displayColorMode(): number {
    return this._displayColorMode
  }
  set displayColorMode(mode: number) {
    this._displayColorMode = mode
    this.spatial?.setColorDisplayMode(mode)
  }

  /** ObData attribute list: when false (default) builtin attributes (geometry
   * + `.`-prefixed internal layers) are hidden, leaving the user/paint attrs. */
  _showBuiltinAttrs = false

  get showBuiltinAttrs(): boolean {
    return this._showBuiltinAttrs
  }
  set showBuiltinAttrs(v: boolean) {
    this._showBuiltinAttrs = v
  }

  /**
   * Active attribute *name* per category (Wave 2b brush bridge). Clicking a
   * categorized attr in the ObData ListBox sets the entry for that category;
   * the sculptcore bridge resolves it to a layer index per stroke and points
   * the matching brush handle at it (replacing the hardcoded `color`/`group`).
   * View/paint state — not serialized (the layer it names lives on the mesh).
   * Keyed by AttrUseFlags (COLOR/POLYGROUP/UV).
   */
  _activeAttr: {color?: string; polygroup?: string; uv?: string} = {}

  /** Active sculpt layer's engine settings index (see activeSculptLayer). */
  _activeSculptLayer = 0

  /**
   * Active sculpt layer (settings index) for the layer panel + the edit-target
   * routing (litemesh.sculpt_layer_set_target). Clamped to the live stack: -1
   * when the mesh has no layers, so a stale selection after removals falls
   * back to a valid layer instead of pointing past the end. View state — not
   * serialized.
   */
  get activeSculptLayer(): number {
    const count = this.layerCount()
    if (count <= 0) return -1
    return Math.max(0, Math.min(this._activeSculptLayer, count - 1))
  }
  set activeSculptLayer(li: number) {
    this._activeSculptLayer = li
  }

  /** Layer `li`'s attribute name, via the v.attrs AttrRef proxy at
   * sculptLayerAttrIndex (the settings sidecar isn't a bound member). Level
   * layers are channels with no vertex column — display a positional name. */
  sculptLayerName(li: number): string {
    if (this._multires) return `Layer ${li + 1}`
    const attrIdx = this.mesh.sculptLayerAttrIndex(li)
    if (attrIdx < 0) return ''
    const grp = this._domainGroup(AttrDomain.VERTEX)
    if (!grp?.attrs) return ''
    const cls = (
      this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string} | undefined}
    ).findVectorClass('sculptcore::mesh::AttrRef')
    if (!cls) return ''
    const arr = this.wasm.getBoundVector(cls.buildFullName(), grp.attrs as never) as ArrayLike<{name: string}>
    return attrIdx < arr.length ? arr[attrIdx].name : ''
  }

  private lastSculptLayerItems: LiteMeshSculptLayerItem[] = []

  /** Sculpt-layer rows for the layer-stack ListBox, in stack order. Reads the
   * bound per-layer methods; identity-cached like attrItems so path.ux doesn't
   * rebuild the list every draw. */
  get sculptLayerItems(): LiteMeshSculptLayerItem[] {
    const items: LiteMeshSculptLayerItem[] = []
    const count = this.layerCount()
    for (let li = 0; li < count; li++) {
      items.push(
        new LiteMeshSculptLayerItem(
          this.sculptLayerName(li),
          li,
          this.layerWeight(li),
          this.layerEnabled(li),
          this.layerFrozen(li),
          this
        )
      )
    }
    const last = this.lastSculptLayerItems
    if (last.length === items.length && items.every((it, i) => it.equals(last[i]))) {
      return last
    }
    this.lastSculptLayerItems = items
    return items
  }

  /** Domain that a given category's layers live on (mirrors the W2b table). */
  static categoryDomain(category: number): number {
    if (category & AttrUseFlags.COLOR) return AttrDomain.VERTEX
    if (category & AttrUseFlags.POLYGROUP) return AttrDomain.FACE
    if (category & AttrUseFlags.UV) return AttrDomain.VERTEX // corner later
    if (category & AttrUseFlags.SCULPT_LAYER) return AttrDomain.VERTEX
    return 0
  }

  /** Set the active attr for `item`'s category from a clicked ListBox row. */
  setActiveAttrFromItem(item: LiteMeshAttrItem): void {
    if (item.use & AttrUseFlags.COLOR) this._activeAttr.color = item.attrName
    else if (item.use & AttrUseFlags.POLYGROUP) this._activeAttr.polygroup = item.attrName
    else if (item.use & AttrUseFlags.UV) this._activeAttr.uv = item.attrName
    this._syncDisplayAttrs()
  }

  /** Point the C++ display sources at the active color/poly-group layers so the
   * viewport shows the active attr, not the layer literally named color/group.
   * -1 (no active layer) falls back to the by-name default in fill_leaf_slice. */
  _syncDisplayAttrs(): void {
    if (!this.spatial) return
    this.spatial.setDisplayColorAttr(this.activeAttrLayerIndex(AttrUseFlags.COLOR))
    this.spatial.setDisplayGroupAttr(this.activeAttrLayerIndex(AttrUseFlags.POLYGROUP))
  }

  /** The ObData ListBox's selected attribute (Wave 2b category dropdown acts on
   * it). Stored by its stable fields, not object identity (attrItems rebuilds
   * its LiteMeshAttrItems each enumeration). */
  _selectedAttr?: {domain: number; layerIndex: number; attrName: string; attrType: number}

  setSelectedAttrFromItem(item: LiteMeshAttrItem): void {
    this._selectedAttr = {
      domain    : item.domain,
      layerIndex: item.layerIndex,
      attrName  : item.attrName,
      attrType  : item.attrType,
    }
  }

  /** Live AttrUse (category) of the layer at (domain, layerIndex), via the bound
   * AttrGroup.attrs proxy. 0 (NONE) when out of range. */
  private _attrUseAt(domain: number, layerIndex: number): number {
    const grp = this._domainGroup(domain)
    if (!grp?.attrs || layerIndex < 0) return 0
    const cls = (
      this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string} | undefined}
    ).findVectorClass('sculptcore::mesh::AttrRef')
    if (!cls) return 0
    const arr = this.wasm.getBoundVector(cls.buildFullName(), grp.attrs as never) as ArrayLike<{use: number}>
    return layerIndex < arr.length ? arr[layerIndex].use : 0
  }

  /**
   * Write a layer's category (AttrUse) through the C++ `setAttrUse` primitive
   * (`AttrRef.use` is read-only via the native proxy; the layer is addressed by
   * index, since names don't marshal). Setting a real category also makes the
   * layer the active attr for it (so the matching brush targets it).
   */
  setAttrCategory(domain: number, layerIndex: number, attrName: string, use: number): void {
    ;(this.mesh as unknown as {setAttrUse(d: number, i: number, u: number): void}).setAttrUse(domain, layerIndex, use)
    if (use & AttrUseFlags.COLOR) this._activeAttr.color = attrName
    else if (use & AttrUseFlags.POLYGROUP) this._activeAttr.polygroup = attrName
    else if (use & AttrUseFlags.UV) this._activeAttr.uv = attrName
    this._syncDisplayAttrs()
  }

  /**
   * Add a new attribute layer (Wave 2b). C++ owns the unique name (names don't
   * marshal) and returns the new index; we read the name back, select it, and
   * activate it for its category. `type` is an AttrType int, `use` an
   * AttrUseFlags int.
   */
  addAttr(domain: number, type: number, use: number): number {
    const idx = (this.mesh as unknown as {addAttr(d: number, t: number, u: number): number}).addAttr(domain, type, use)
    if (idx >= 0) {
      const grp = this._domainGroup(domain)
      const cls = (
        this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string} | undefined}
      ).findVectorClass('sculptcore::mesh::AttrRef')
      let name = ''
      if (grp?.attrs && cls) {
        const arr = this.wasm.getBoundVector(cls.buildFullName(), grp.attrs as never) as ArrayLike<{name: string}>
        if (idx < arr.length) name = arr[idx].name
      }
      this._selectedAttr = {domain, layerIndex: idx, attrName: name, attrType: type}
      if (use & AttrUseFlags.COLOR) this._activeAttr.color = name
      else if (use & AttrUseFlags.POLYGROUP) this._activeAttr.polygroup = name
      else if (use & AttrUseFlags.UV) this._activeAttr.uv = name
      this._syncDisplayAttrs()
    }
    return idx
  }

  /** Remove the selected attribute layer (refused for builtins in C++). Clears
   * the selection and any active-attr entry that named it. */
  removeSelectedAttr(): void {
    const s = this._selectedAttr
    if (!s) return
    ;(this.mesh as unknown as {removeAttr(d: number, i: number): void}).removeAttr(s.domain, s.layerIndex)
    if (this._activeAttr.color === s.attrName) this._activeAttr.color = undefined
    if (this._activeAttr.polygroup === s.attrName) this._activeAttr.polygroup = undefined
    if (this._activeAttr.uv === s.attrName) this._activeAttr.uv = undefined
    this._selectedAttr = undefined
    this._syncDisplayAttrs()
  }

  /** Category enum for the selected attr (ObData dropdown). Reads/writes the
   * live AttrUse; the setter ignores categories invalid for the attr's type. */
  get selectedAttrCategory(): number {
    const s = this._selectedAttr
    // Mask to the dropdown's roles: other AttrUse bits (SELECT, SCULPT_LAYER)
    // aren't user-assignable categories and would confuse the enum widget.
    const mask = AttrUseFlags.COLOR | AttrUseFlags.UV | AttrUseFlags.POLYGROUP
    return s ? this._attrUseAt(s.domain, s.layerIndex) & mask : AttrUseFlags.NONE
  }
  set selectedAttrCategory(use: number) {
    const s = this._selectedAttr
    if (!s) return
    if (!validCategories(s.attrType, s.domain).includes(use)) return
    this.setAttrCategory(s.domain, s.layerIndex, s.attrName, use)
  }

  /** Bound `AttrGroup` for a domain (the same object attrItems enumerates). */
  private _domainGroup(domain: number) {
    const m = this.mesh
    if (domain === AttrDomain.VERTEX) return m.v?.attrs
    if (domain === AttrDomain.CORNER) return m.c?.attrs
    if (domain === AttrDomain.FACE) return m.f?.attrs
    return undefined
  }

  /**
   * Index of the active attr for `category` within its domain's full
   * `AttrGroup.attrs` vector (the same index space the C++ override consumes),
   * or -1 when none is set / it no longer exists. Enumerates the *unfiltered*
   * bound vector so the index matches `grp->attrs[layerIndex]` in C++.
   */
  activeAttrLayerIndex(category: number): number {
    // Sculpt layers are keyed by settings index, not attr name: the engine's
    // sidecar (Mesh.sculptLayers) owns the stack, so resolve through it.
    if (category & AttrUseFlags.SCULPT_LAYER) {
      const li = this.activeSculptLayer
      return li < 0 ? -1 : this.mesh.sculptLayerAttrIndex(li)
    }
    let name: string | undefined
    if (category & AttrUseFlags.COLOR) name = this._activeAttr.color
    else if (category & AttrUseFlags.POLYGROUP) name = this._activeAttr.polygroup
    else if (category & AttrUseFlags.UV) name = this._activeAttr.uv
    if (!name) return -1
    return this.layerIndexByName(LiteMesh.categoryDomain(category), name)
  }

  /** Index of layer `name` within `domain`'s full (unfiltered) AttrGroup.attrs —
   * the index space the C++ override / setAttrUse / detachAttr consume. -1 if
   * absent. */
  layerIndexByName(domain: number, name: string): number {
    const grp = this._domainGroup(domain)
    if (!grp?.attrs) return -1
    const cls = (
      this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string} | undefined}
    ).findVectorClass('sculptcore::mesh::AttrRef')
    if (!cls) return -1
    const arr = this.wasm.getBoundVector(cls.buildFullName(), grp.attrs as never) as ArrayLike<{name: string}>
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].name === name) return i
    }
    return -1
  }

  /**
   * Detach a layer (by name) into the C++ stash for undoable removal — preserves
   * its data (no serialize, no free), clears any active-attr/selection naming it,
   * and returns the stash id (or -1). The RemoveAttr ToolOp owns this; undo is
   * `reattachAttrLayer`.
   */
  detachAttrLayer(domain: number, name: string): number {
    const idx = this.layerIndexByName(domain, name)
    if (idx < 0) return -1
    const stashId = (this.mesh as unknown as {detachAttr(d: number, i: number): number}).detachAttr(domain, idx)
    if (this._activeAttr.color === name) this._activeAttr.color = undefined
    if (this._activeAttr.polygroup === name) this._activeAttr.polygroup = undefined
    if (this._activeAttr.uv === name) this._activeAttr.uv = undefined
    if (this._selectedAttr?.attrName === name) this._selectedAttr = undefined
    this._syncDisplayAttrs()
    return stashId
  }

  /** Reattach a stashed layer (undo of detachAttrLayer). */
  reattachAttrLayer(stashId: number): void {
    ;(this.mesh as unknown as {reattachAttr(id: number): number}).reattachAttr(stashId)
    this._syncDisplayAttrs()
  }

  /** Remove the named layer outright (frees it; no undo data). Used by AddAttr
   * undo, where the layer is newly created and has nothing to preserve. */
  removeAttrByName(domain: number, name: string): void {
    const idx = this.layerIndexByName(domain, name)
    if (idx < 0) return
    ;(this.mesh as unknown as {removeAttr(d: number, i: number): void}).removeAttr(domain, idx)
    if (this._activeAttr.color === name) this._activeAttr.color = undefined
    if (this._activeAttr.polygroup === name) this._activeAttr.polygroup = undefined
    if (this._activeAttr.uv === name) this._activeAttr.uv = undefined
    if (this._selectedAttr?.attrName === name) this._selectedAttr = undefined
    this._syncDisplayAttrs()
  }

  /** True for geometry/internal attributes hidden by default in the ObData list. */
  static isBuiltinAttr(name: string): boolean {
    return name.startsWith('.') || name === 'positions' || name === 'normals' || name === 'select'
  }

  /**
   * Enumerate the C++ mesh's attributes (vertex + face for now) as descriptors
   * for the ObData ListBox. Reads the bound `AttrGroup.attrs` Vector<AttrRef>
   * through `getBoundVector` (the cross-backend way — direct `.attrs[i]` doesn't
   * materialize on the native backend). Builtins filtered unless
   * `showBuiltinAttrs`.
   */
  get attrItems(): LiteMeshAttrItem[] {
    const items: LiteMeshAttrItem[] = []
    const m = this.mesh as unknown as {
      v?: {attrs?: {attrs: unknown}}
      c?: {attrs?: {attrs: unknown}}
      f?: {attrs?: {attrs: unknown}}
    }
    const cls = (
      this.wasm.manager as {findVectorClass(n: string): {buildFullName(): string} | undefined}
    ).findVectorClass('sculptcore::mesh::AttrRef')
    if (!cls) {
      return items
    }
    const groups: [number, {attrs?: {attrs: unknown}} | undefined][] = [
      [AttrDomain.VERTEX, m.v],
      [AttrDomain.CORNER, m.c],
      [AttrDomain.FACE, m.f],
    ]
    for (const [domain, grp] of groups) {
      if (!grp?.attrs) {
        continue
      }
      const arr = this.wasm.getBoundVector(cls.buildFullName(), grp.attrs.attrs as never) as ArrayLike<{
        name: string
        type: number
        use: number
      }>
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i]
        if (!this._showBuiltinAttrs && LiteMesh.isBuiltinAttr(a.name)) {
          continue
        }
        // `i` is the index in the *unfiltered* group vector — the index space
        // the C++ setAttrUse / brush override consume.
        items.push(new LiteMeshAttrItem(a.name, domain, a.type, a.use, i))
      }
    }
    const last = this.lastAttrItems
    if (last.length !== items.length) {
      this.lastAttrItems = items
      return items
    }
    for (let i = 0; i < items.length; i++) {
      if (!items[i].equals(last[i])) {
        this.lastAttrItems = items
        return items
      }
    }
    return last
  }

  /**
   * Install the material's requested geometry-attribute set on this mesh's
   * spatial tree (M6). The shader-graph only knows each attribute's *category*
   * (UV/Color/Generic); the true element *domain* (UVs corner-domain, vertex
   * color vertex-domain) is resolved here against the live mesh layers
   * (`attrItems`), falling back to a category default when the layer is absent
   * (it gets default-filled in C++). sculptcore then builds one vertex buffer
   * per entry, by name, in slot order. Never throws — an empty set restores the
   * legacy single-color draw path.
   */
  setRequestedAttrs(reqs: RequestedAttrDesc[]): void {
    if (!this.spatial) {
      return
    }
    // Index the live layers by name so each request resolves to its real domain.
    const byName = new Map<string, LiteMeshAttrItem>()
    for (const item of this.attrItems) {
      byName.set(item.attrName, item)
    }
    const bridges: RequestedAttrBridge[] = reqs.map((r) => {
      const item = byName.get(r.name)
      const domain = item ? item.domain : LiteMesh._defaultDomainForCategory(r.category)
      // Missing color reads as white (the legacy default); everything else zero.
      const defaultKind = r.category === AttrUseFlags.COLOR ? 1 : 0
      return {name: r.name, srcType: r.gpuType, elemSize: r.elemSize, slot: r.slot, domain, defaultKind}
    })
    this.wasm.SpatialTree_setRequestedAttrs(this.spatial, bridges)
  }

  /** Default element domain to assume for an absent requested layer, by category
   * (UV → corner, matching box-unwrap; everything else vertex). Only used for
   * the missing-layer (default-filled) case — present layers use their real
   * domain. */
  private static _defaultDomainForCategory(category: number): number {
    return category === AttrUseFlags.UV ? AttrDomain.CORNER : AttrDomain.VERTEX
  }

  /**
   * Set the material WGSL the spatial tree's draw batches render with (M6).
   * C++ stores it on the tree's `drawShader` ShaderDef (`wgslSource`) and flags
   * leaves for a GPU regen; `wgslForSpatialShader` reads it straight back off
   * the bound ShaderDef. Call after `setRequestedAttrs`.
   */
  setDrawShader(wgsl: string): void {
    if (!this.spatial) {
      return
    }
    this.wasm.SpatialTree_setDrawShader(this.spatial, wgsl)
    this._hasMaterialDrawShader = !!wgsl && wgsl.length > 0

    // The C++ ShaderDef is rebuilt in place (same `&drawShader` pointer), so the
    // executor's pipeline cache — keyed on that stable pointer — would keep the
    // pipeline compiled from the old WGSL. Drop both cache layers so the next
    // dispatch rebuilds the pipeline (and its reflected bindings) from the new
    // source. Material edits are rare, so the rebuild cost is irrelevant.
    this.drawBatchExecutorGPU?.invalidatePipelines()
    for (const bindings of this.gpuBindingsCache.values()) bindings.destroy()
    this.gpuBindingsCache.clear()
  }

  /**
   * The advisory list of requested slots with no matching mesh layer (rendered
   * with defaults). Read once after a material change to warn the user. Never
   * throws.
   */
  getMissingAttrSlots(): number[] {
    if (!this.spatial) {
      return []
    }
    return this.wasm.SpatialTree_getMissingAttrSlots(this.spatial)
  }

  /**
   * A cheap order-sensitive hash of the mesh's attribute layers (name + type +
   * domain + use, across every domain). The renderengine compares it frame to
   * frame: when it changes but the material hash hasn't, only the *layers* moved
   * (e.g. a color attribute was added/removed), and it calls
   * `refreshRequestedAttrs()` to re-gather the per-attribute buffers without
   * relinking the shader. Built from the same `attrItems` `setRequestedAttrs`
   * resolves domains against, so the two always agree.
   */
  attrLayersSignature(): number {
    let h = 0x811c9dc5 | 0 // FNV-1a basis
    const mix = (v: number) => {
      h ^= v | 0
      h = Math.imul(h, 0x01000193)
    }
    for (const item of this.attrItems) {
      const name = item.attrName
      for (let i = 0; i < name.length; i++) {
        mix(name.charCodeAt(i))
      }
      mix(item.attrType)
      mix(item.domain)
      mix(item.use)
    }
    return h | 0
  }

  /**
   * Force the spatial tree to re-gather its per-attribute vertex buffers against
   * the *current* mesh layers, even when the requested descriptor set is
   * byte-identical (a layer added/removed whose domain matches the category
   * default leaves the descriptors unchanged but flips a buffer between
   * default-fill and real data). Cheaper than `setDrawShader` — no ShaderDef
   * relink. The renderengine calls this when `attrLayersSignature` changed but
   * the material hash didn't. Never throws.
   */
  refreshRequestedAttrs(): void {
    if (!this.spatial) {
      return
    }
    this.wasm.SpatialTree_refreshRequestedAttrs(this.spatial)
  }

  /**
   * Attach (and take ownership of) a sculptcore `VdmStore` — the mesh then
   * renders its VDM texels through the fragment path (V3): the renderengine
   * sees `hasVdm` and regenerates the material WGSL with `VDM_MODE`, and
   * `drawQGPU` keeps the GPU tile atlas/page table current per frame. The
   * store is freed on `detachVdmStore()` / `destroy()`.
   */
  attachVdmStore(store: VdmStore): void {
    if (this._vdmStore && this._vdmStore !== store) {
      this.detachVdmStore()
    }
    this._vdmStore = store
    this._vdmWarnedSync = false
    // Detect the store backend once (layout[8]); the renderengine folds
    // VDM_PTEX into the material hash off this flag.
    const intOut = (this._vdmIntVec ??= this._vecOutBulk('int32'))
    ;(store as unknown as {gpuLayoutOut(out: never): number}).gpuLayoutOut(intOut.vec as never)
    const lay = intOut.read()
    this._vdmIsPtex = ((lay[8] as number) | 0) === 1
  }

  /** True when the attached store runs the PTEX backend. */
  get vdmIsPtex(): boolean {
    return this._vdmIsPtex
  }

  /** Drop the attached VdmStore (freeing it) + its GPU residency. */
  detachVdmStore(): void {
    this._vdmAtlasTex?.destroy()
    this._vdmAtlasTex = undefined
    this._vdmPageTex?.destroy()
    this._vdmPageTex = undefined
    this._vdmLayout = undefined
    if (this._vdmStore) {
      this.wasm.VdmStore_free(this._vdmStore)
      this._vdmStore = undefined
    }
  }

  /** True when a VdmStore is attached — the renderengine folds this into the
   * material hash and passes `VDM_MODE` to the WGSL codegen. */
  get hasVdm(): boolean {
    return this._vdmStore !== undefined
  }

  /** The attached store handle (driver/test surface; undefined when none). */
  get vdmStore(): VdmStore | undefined {
    return this._vdmStore
  }

  /** Detach the store WITHOUT freeing it. The interactive lifecycle ops hold
   * the instance across undo/redo — MeshLog VdmLogChunks keep non-owning
   * store pointers, so freeing + reallocating would leave stroke history
   * dangling. */
  releaseVdmStore(): VdmStore | undefined {
    const store = this._vdmStore
    this._vdmAtlasTex?.destroy()
    this._vdmAtlasTex = undefined
    this._vdmPageTex?.destroy()
    this._vdmPageTex = undefined
    this._vdmLayout = undefined
    this._vdmStore = undefined
    return store
  }

  /** Create + attach a VDM store for interactive sculpting (X3 stage 4):
   * Ptex-configured from the multires stack when one is attached, else the
   * UV-atlas backend (requires an existing UV unwrap). Tags the whole mesh
   * as VDM carrier and refreshes frames. Returns false (mesh untouched)
   * when neither parameterization is available. */
  vdmEnable(): boolean {
    if (this._vdmStore) return true
    const wasm = this.wasm
    let store: VdmStore
    if (this.multiresActive && this._multires) {
      store = wasm.VdmStore_new(64, 16)
      const links = this._vecOutBulk('int32')
      ;(this._multires as unknown as {vdmAdjacencyOut(out: never): void}).vdmAdjacencyOut(links.vec as never)
      const linkArr = links.read()
      const gridCount = (linkArr.length / 8) | 0
      if (gridCount <= 0) {
        wasm.VdmStore_free(store)
        return false
      }
      ;(store as unknown as {configurePtex(g: number, r: number, l: never): void}).configurePtex(
        gridCount,
        0,
        links.vec as never
      )
    } else if (this.activeAttrLayerIndex(AttrUseFlags.UV) >= 0) {
      store = wasm.VdmStore_new(1024, 32)
    } else {
      return false
    }
    this.vdmReattach(store)
    return true
  }

  /** (Re-)attach a store: carrier tags + frames + GPU hookup. Used by
   * `vdmEnable` and by the lifecycle ops' undo/redo with a released store. */
  vdmReattach(store: VdmStore): void {
    this.wasm.SpatialTree_fillDetailCarrier(this.spatial, 1)
    this.wasm.Mesh_updateFrames(this.mesh)
    this.attachVdmStore(store)
  }

  /** Cached bulk-read out-params for the per-frame VDM drain (the bound
   * Vectors self-clear C++-side, so reuse avoids a per-frame allocation). */
  private _vdmIntVec?: {vec: unknown; read: () => ArrayLike<number>}
  private _vdmFloatVec?: {vec: unknown; read: () => ArrayLike<number>}
  private _vdmIsPtex = false
  /** X3 tessellated display (view state, not serialized): draw the multires
   * render level from GPU-amplified positions instead of the active-level
   * batch. Effective only in SHOW_RENDER with a stack attached and the edit
   * level below the finest. */
  tessellatedDisplay = false
  private _tessWgsl?: string
  private _tessState?: {
    level: number
    meshRev: number
    /** VdmStore.contentRev() folded into the finalize outputs (-1 = no store). */
    storeRev: number
    /** Amplified (pre-VDM) position/frame channels — kept so a texel-only
     * change re-runs just the finalize, not the SpMV chain. */
    posAmp: GPUBuffer
    norAmp: GPUBuffer
    tanAmp: GPUBuffer
    topo: TessTopoInputs
    fineCount: number
    vertexBuf: GPUBuffer
    normalBuf: GPUBuffer
    indexBuf: GPUBuffer
    indexCount: number
  }
  private _tessBuilding = false
  private _tessPipelines = new Map<string, Pipeline>()
  private _tessBindings?: UniformBindings
  private _tessWarned = false
  /** Last async tess-build failure (driver/test diagnostics). */
  _tessLastError?: string

  /** Bound Vector out-param + bulk reader (native `vectorView` fast path, one
   * copy instead of a napi call per element; WASM falls back to the heap view). */
  private _vecOutBulk(elem: 'int32' | 'float'): {vec: unknown; read: () => ArrayLike<number>} {
    const manager = this.wasm.manager as unknown as {
      findVectorClass(n: string): {buildFullName(): string; findDefaultConstructor(): unknown}
      constructWith(c: unknown): unknown
      addon?: {vectorView(vec: unknown): ArrayBufferView | undefined}
    }
    const cls = manager.findVectorClass(elem)
    const vec = manager.constructWith(cls.findDefaultConstructor())
    const read = (): ArrayLike<number> => {
      const view = manager.addon?.vectorView(vec)
      if (view) return view as unknown as ArrayLike<number>
      return this.wasm.getBoundVector(cls.buildFullName(), vec as never) as ArrayLike<number>
    }
    return {vec, read}
  }

  /**
   * Per-frame VDM GPU sync (V3's "no regen_gpu_node on VDM-only dabs" upload
   * path): drain the store's dirty-slot list — a topo-dirty drain (tiles
   * created/removed, or the first sync) re-reads the layout, (re)creates the
   * atlas/page textures on a dims change, and re-uploads page table + full
   * atlas; a plain drain writes only the dirty slots' tiles at their atlas
   * cells. Always seeds the texture views + layout uniforms into `uniforms`
   * under the names the `VDM_MODE` WGSL declares.
   */
  private _syncVdmGpu(device: GPUDevice, uniforms: Record<string, unknown>): void {
    const store = this._vdmStore as unknown as {
      gpuLayoutOut(out: never): number
      gpuPageTableOut(out: never): void
      gpuPtexTableOut(out: never): void
      gpuAtlasPixelsOut(out: never): void
      gpuTilePixelsOut(slot: number, out: never): number
      gpuTakeDirtyOut(outSlots: never): number
    }
    const intOut = (this._vdmIntVec ??= this._vecOutBulk('int32'))
    const floatOut = (this._vdmFloatVec ??= this._vecOutBulk('float'))

    const topoDirty = (store.gpuTakeDirtyOut(intOut.vec as never) | 0) !== 0
    // Copy the drained slots before the next out-param call reuses the vector.
    const dirtySlots = topoDirty ? [] : Array.from(intOut.read() as ArrayLike<number>)

    if (topoDirty || !this._vdmAtlasTex || !this._vdmPageTex || !this._vdmLayout) {
      store.gpuLayoutOut(intOut.vec as never)
      const lay = intOut.read()
      const layout = Array.from({length: 10}, (_, i) => (lay[i] as number) | 0)
      const [tileSize, , grid, , , , atlasW, atlasH, backend] = layout
      // An empty store still binds valid textures (all-empty page table → the
      // shader samples zero), so the bind group never fails on the draw seam.
      const texW = Math.max(atlasW, tileSize, 1)
      const texH = Math.max(atlasH, tileSize, 1)

      if (!this._vdmAtlasTex || this._vdmAtlasTex.width !== texW || this._vdmAtlasTex.height !== texH) {
        this._vdmAtlasTex?.destroy()
        this._vdmAtlasTex = new GpuTexture(device, {
          label : 'litemesh.vdmAtlas',
          width : texW,
          height: texH,
          format: 'rgba32float',
          usage : TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
        })
      }

      if (backend === 1) {
        // PTEX: the flat per-grid offset table rides the page-table binding,
        // linearly indexed by the VDM_PTEX sampler (gpuPtexTable layout).
        store.gpuPtexTableOut(intOut.vec as never)
        const arr = intOut.read()
        const flat = arr instanceof Int32Array ? arr : Int32Array.from(arr as ArrayLike<number>)
        const tw = 1024
        const th = Math.max(1, Math.ceil(flat.length / tw))
        if (!this._vdmPageTex || this._vdmPageTex.width !== tw || this._vdmPageTex.height !== th) {
          this._vdmPageTex?.destroy()
          this._vdmPageTex = new GpuTexture(device, {
            label : 'litemesh.vdmPtexTable',
            width : tw,
            height: th,
            format: 'r32sint',
            usage : TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
          })
        }
        const padded = new Int32Array(tw * th)
        padded.set(flat.subarray(0, Math.min(flat.length, padded.length)))
        device.queue.writeTexture(
          {texture: this._vdmPageTex.handle},
          padded,
          {bytesPerRow: tw * 4, rowsPerImage: th},
          {width: tw, height: th, depthOrArrayLayers: 1}
        )
      } else {
        const gridTex = Math.max(grid, 1)
        if (!this._vdmPageTex || this._vdmPageTex.width !== gridTex || this._vdmPageTex.height !== gridTex) {
          this._vdmPageTex?.destroy()
          this._vdmPageTex = new GpuTexture(device, {
            label : 'litemesh.vdmPage',
            width : gridTex,
            height: gridTex,
            format: 'r32sint',
            usage : TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
          })
        }

        store.gpuPageTableOut(intOut.vec as never)
        const pageArr = intOut.read()
        const page = pageArr instanceof Int32Array ? pageArr : Int32Array.from(pageArr as ArrayLike<number>)
        if (grid > 0 && page.length >= grid * grid) {
          device.queue.writeTexture(
            {texture: this._vdmPageTex.handle},
            page,
            {bytesPerRow: grid * 4, rowsPerImage: grid},
            {width: grid, height: grid, depthOrArrayLayers: 1}
          )
        }
      }

      if (atlasW > 0 && atlasH > 0) {
        store.gpuAtlasPixelsOut(floatOut.vec as never)
        const raw = floatOut.read()
        const atlas = raw instanceof Float32Array ? raw : Float32Array.from(raw as ArrayLike<number>)
        if (atlas.length >= atlasW * atlasH * 4) {
          device.queue.writeTexture(
            {texture: this._vdmAtlasTex.handle},
            atlas,
            {bytesPerRow: atlasW * 16, rowsPerImage: atlasH},
            {width: atlasW, height: atlasH, depthOrArrayLayers: 1}
          )
        }
      }
      this._vdmLayout = layout
    } else if (dirtySlots.length > 0) {
      const [tileSize, , , , tilesX] = this._vdmLayout
      for (const s of dirtySlots) {
        const slot = s | 0
        if (!store.gpuTilePixelsOut(slot, floatOut.vec as never)) continue
        const raw = floatOut.read()
        const tile = raw instanceof Float32Array ? raw : Float32Array.from(raw as ArrayLike<number>)
        if (tile.length < tileSize * tileSize * 4) continue
        device.queue.writeTexture(
          {
            texture: this._vdmAtlasTex.handle,
            origin : {x: (slot % tilesX) * tileSize, y: Math.floor(slot / tilesX) * tileSize},
          },
          tile,
          {bytesPerRow: tileSize * 16, rowsPerImage: tileSize},
          {width: tileSize, height: tileSize, depthOrArrayLayers: 1}
        )
      }
    }

    const layout = this._vdmLayout!
    uniforms.vdm_atlas = this._vdmAtlasTex!.view
    uniforms.vdm_page = this._vdmPageTex!.view
    uniforms.vdmTileSize = layout[0]
    if ((layout[8] | 0) === 1) {
      // PTEX: vdmGridSize carries cpr (the X1 chart layout), and
      // vdmResolution the effective texels-per-packed-uv (R/span, span =
      // (1/cpr)·(15/16)) for the preamble's derivative epsilon.
      const cpr = Math.max(1, Math.ceil(Math.sqrt(Math.max(layout[9], 1))))
      uniforms.vdmGridSize = cpr
      uniforms.vdmResolution = (layout[1] * cpr * 16) / 15
    } else {
      uniforms.vdmResolution = layout[1]
      uniforms.vdmGridSize = layout[2]
    }
    uniforms.vdmAtlasTilesX = Math.max(layout[4], 1)
  }

  /**
   * DataBlock teardown — called by the library when the block is removed
   * (including the scene-clear that precedes a file load). Releases the C++
   * mesh + spatial tree (allocator-correct `Mesh_free`/`SpatialTree_free`, NOT
   * `[Symbol.dispose]`) and the GPU batches/executors this LiteMesh owns. Nulls
   * each handle so a double-remove can't double-free.
   */
  destroy(): void {
    this.drawBatchExecutor?.dispose()
    this.drawBatchExecutor = undefined
    this.drawBatchExecutorGPU?.dispose()
    this.drawBatchExecutorGPU = undefined
    for (const bindings of this.gpuBindingsCache.values()) bindings.destroy()
    this.gpuBindingsCache.clear()

    if (this.treeBatch) {
      this.wasm.gpu.destroyBatch(this.treeBatch, true, true)
      this.treeBatch = undefined
    }
    if (this.seamBatch) {
      this.wasm.gpu.destroyBatch(this.seamBatch, true, true)
      this.seamBatch = undefined
    }
    if (this.selectionBatch) {
      this.wasm.gpu.destroyBatch(this.selectionBatch, true, true)
      this.selectionBatch = undefined
      this._selectionDirty = true
    }
    if (this.wireframeBatch) {
      this.wasm.gpu.destroyBatch(this.wireframeBatch, true, true)
      this.wireframeBatch = undefined
      this._wireframeRev = -1
    }
    if (this.pointsBatch) {
      this.wasm.gpu.destroyBatch(this.pointsBatch, true, true)
      this.pointsBatch = undefined
      this._pointsRev = -1
    }
    // drawBatch is owned by the spatial tree; freeing the tree releases it.
    this.drawBatch = undefined

    // VDM residency + the owned store (frees the C++ VdmStore).
    this.detachVdmStore()
    this._dropTessState()

    // A live multires stack owns mesh/spatial (views) — free the stack and
    // fall through to freeing the re-adopted cage.
    if (this._multires) {
      this.spatial = undefined as unknown as SpatialTree
      this.mesh = this._multiresCage as WasmMesh
      this._multiresCage = undefined
      this.wasm.Multires_free(this._multires)
      this._multires = undefined
    }

    if (this.spatial) {
      this.wasm.SpatialTree_free(this.spatial)
      this.spatial = undefined as unknown as SpatialTree
    }
    if (this.mesh) {
      this.wasm.Mesh_free(this.mesh)
      this.mesh = undefined as unknown as WasmMesh
    }

    super.destroy()
  }

  drawQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, _object: SceneObject) {
    const toolmode = view3d.ctx?.scene?.toolmode as SculptCorePaintMode
    const drawBVH = toolmode?.drawBVH
    // Default on: only an explicit `drawFeatureOverlay === false` hides it (other
    // tool modes have no such field and should still show seams).
    const drawFeatures = toolmode?.drawFeatureOverlay
    // Poly-group boundary edges are a separate, opt-in overlay (#28).
    const drawPolyGroupEdges = !!(toolmode as unknown as {drawPolyGroupEdges?: boolean})?.drawPolyGroupEdges
    // Box-modeling selection overlay (only the boxmodel toolmode carries this
    // field; other modes leave it undefined → off).
    const drawSelection = !!(toolmode as unknown as {drawSelectionOverlay?: boolean})?.drawSelectionOverlay
    // Wireframe / points overlays + xray (box-modeling toolmode only; undefined
    // elsewhere).
    const drawWireframe = !!(toolmode as unknown as {drawWireframe?: boolean})?.drawWireframe
    // Vertex points only make sense while vertex selection mode is on
    // (SelMask.VERTEX = 1 in boxModelSelMode).
    const tmSel = (toolmode as unknown as {boxModelSelMode?: number})?.boxModelSelMode ?? 0
    const drawPoints = !!(toolmode as unknown as {drawPoints?: boolean})?.drawPoints && (tmSel & 1) !== 0
    const xray = !!(toolmode as unknown as {xray?: boolean})?.xray
    // Sculpt-mask darkening overlay (#20): default on; the C++ side no-ops when
    // unchanged, so pushing every frame is cheap.
    const drawMask = (toolmode as unknown as {drawMask?: boolean})?.drawMask !== false
    // Per-object draw mode/flags (SceneObject.drawMode/.drawFlag): BOUNDS draws
    // only the AABB box, WIRE only the wireframe, SOLID/TEXTURED the surface.
    const objDrawMode = _object?.drawMode ?? DrawModes.TEXTURED
    const objDrawFlag = _object?.drawFlag ?? DrawFlags.NONE
    const drawSurface = (objDrawMode & (DrawModes.SOLID | DrawModes.TEXTURED)) !== 0
    const drawBounds = objDrawMode === DrawModes.BOUNDS
    const wireOverlay = drawWireframe || objDrawMode === DrawModes.WIRE || (objDrawFlag & DrawFlags.WIREFRAME) !== 0
    const xrayAll = xray || (objDrawFlag & DrawFlags.FORCE_XRAY) !== 0
    ;(this.spatial as unknown as {setDisplayMask?: (on: boolean) => void}).setDisplayMask?.(drawMask)
    const spatialFlushed = this.spatial.update(this.wasm.gpu)
    if (spatialFlushed) {
      // The tree flushed pending geometry/attribute edits → the serialized form
      // changed; invalidate the autosave blob cache (M2).
      this.meshRevision++
      if (this.treeBatch) {
        // Null before the conditional rebuild: with drawBVH off a stale handle
        // here double-frees on the next _rebuildSpatial (native crash).
        this.wasm.gpu.destroyBatch(this.treeBatch, true, true)
        this.treeBatch = undefined
        if (drawBVH) {
          this.treeBatch = this.spatial.buildLeafBoundsBatch(this.wasm.gpu)
        }
      }
    }
    this.drawBatch = this.spatial.getDrawBatch()
    // Push-model buffer refresh: geometry/attrs changed this frame, so
    // re-upload the cached batch's dirty buffers now (dispatch no longer polls
    // update_buffer per buffer per frame).
    if (spatialFlushed && this.drawBatch && this.drawBatchExecutorGPU) {
      this.drawBatchExecutorGPU.flushBatchBuffers(this.drawBatch)
    }
    // Rebuild only when the seam *set* changes (markSeamsDirty), not on every
    // geometry update: `.edge.vs` is freed under frozen topology, so a per-dab
    // rebuild would thaw in the sculpt hot path. The overlay therefore tracks
    // seam *topology*, not live vert motion mid-stroke (refreshed on next seam
    // edit) — an acceptable trade for not thawing every frame.
    this._ensureSeamBatch(drawPolyGroupEdges)
    if (drawSelection) {
      this._ensureSelectionBatch()
    }
    if (wireOverlay) {
      this._ensureWireframeBatch()
    }
    if (drawPoints) {
      this._ensurePointsBatch()
    }
    if (drawBounds) {
      this._ensureBoundsBatch()
    }

    if (drawBVH && !this.treeBatch) {
      this.treeBatch = this.spatial.buildLeafBoundsBatch(this.wasm.gpu)
    }

    const uniforms = frame.uniforms
    const drawMatrix = new Matrix4(uniforms.projectionMatrix)
    if (uniforms.objectMatrix instanceof Matrix4) {
      drawMatrix.multiply(uniforms.objectMatrix)
    }

    const normalMatrix = drawMatrix.copy().makeRotationOnly()

    const uniforms2 = {
      uColor: [1, 1, 1, 1],
      ...uniforms,
      drawMatrix,
      normalMatrix,
    } as IUniformsBlock & Record<string, unknown>

    // The point-sprite overlay sizes billboards in constant pixels, so it needs
    // the framebuffer size (xy of a vec4 for std140 alignment).
    if (uniforms2.viewportSize === undefined) {
      uniforms2.viewportSize = [view3d.glSize[0], view3d.glSize[1], 0, 0]
    }

    // BOUNDS mode: tint the box with the object's editor color so selection
    // state stays visible (the box is the only thing drawn).
    if (drawBounds && _object) {
      const selMask = ObjectFlags.SELECT | ObjectFlags.HIGHLIGHT | ObjectFlags.ACTIVE
      if ((_object.flag & selMask) !== 0) {
        const clr = _object.getEditorColor()
        if (clr) {
          uniforms2.uColor = clr
        }
      }
    }

    // When a material WGSL is the draw shader, the spatial mesh batch needs the
    // renderengine's full uniform schema (FrameUniforms @group0, lights @group1,
    // ObjectUniforms @group2) rather than the basic shader's single packed
    // @group(0) block. Provide it here so the LiteMesh renders the material on
    // both the offscreen BasePass and the viewport canvas pass (the C++ tree
    // ShaderDef is shared between them). The basic line/bounds overlays still
    // read `drawMatrix`/`uColor` from the same block — UniformBindings ignores
    // fields a given shader doesn't declare.
    if (this._hasMaterialDrawShader) {
      const scene = view3d.ctx?.scene as unknown as
        | {lights?: Iterable<unknown>; envlight?: {color?: unknown; power?: number}}
        | undefined
      // The material's per-node uniforms (diffuse color, roughness — the
      // MaterialUniforms @group(1) block) are set by the engine onto
      // `frame.program.uniforms`, not the frame-wide block. Merge them in so
      // UniformBindings can write them; without this the material renders with
      // a default-filled (wrong) color.
      const matUniforms = (frame.program as {uniforms?: Record<string, unknown>} | undefined)?.uniforms
      if (matUniforms) Object.assign(uniforms2, matUniforms)
      // ObjectUniforms.normalMatrix is the object's world rotation (the material
      // lights in world space) — NOT the proj*object rotation the basic shader
      // wants. Overwrite the basic value computed above.
      if (uniforms.objectMatrix instanceof Matrix4) {
        uniforms2.normalMatrix = uniforms.objectMatrix.copy().makeRotationOnly()
      } else {
        uniforms2.normalMatrix = new Matrix4()
      }
      if (uniforms2.ambientColor === undefined && scene?.envlight?.color !== undefined) {
        uniforms2.ambientColor = scene.envlight.color
      }
      if (uniforms2.ambientPower === undefined) {
        uniforms2.ambientPower = scene?.envlight?.power ?? 1.0
      }
      if (uniforms2.viewportSize === undefined) uniforms2.viewportSize = view3d.glSize
      if (uniforms2.uSample === undefined) uniforms2.uSample = 1
      if (uniforms2.alpha === undefined) uniforms2.alpha = 1.0
      // Per-light uniforms (POINTLIGHTS[i].co/.power/...) — the same
      // RenderLight-fed machinery the renderengine BasePass uses. Build a
      // minimal IRenderLights from the scene lights (only `.light` is read).
      const rlights: IRenderLights = {}
      let lid = 0
      if (scene?.lights) {
        for (const light of scene.lights) {
          ;(rlights as Record<string, unknown>)[lid++] = {light}
        }
      }
      LightGenWgsl.setUniforms(uniforms2 as unknown as Record<string, unknown>, scene, rlights)

      // Solid-mode textured draw: texture view/sampler seeded per frame by the
      // non-render pass (updateSolidTexturedDrawShader). Merged last so the
      // resource vars survive the engine-uniform merges above.
      if (this.solidTexUniforms) {
        Object.assign(uniforms2, this.solidTexUniforms)
      }
    }

    if (isWebGPU()) {
      this.drawQGPU(
        uniforms2,
        drawBVH,
        drawFeatures,
        drawSelection,
        wireOverlay,
        drawPoints,
        xrayAll,
        drawSurface,
        drawBounds
      )
      return
    }

    queue.scheduleRawGLPass((gl: WebGL2RenderingContext) => {
      let exec = this.drawBatchExecutor
      if (exec === undefined) {
        exec = new WebGLBatchExecutor(gl, this.wasm, Shaders.BasicLineShader2)
        this.drawBatchExecutor = exec
      }
      if (this.drawBatch && drawSurface) {
        exec.dispatch(this.drawBatch, uniforms2)
      }
      if (drawBVH && this.treeBatch) {
        exec.dispatch(this.treeBatch, uniforms2)
      }
      if (this.seamBatch && drawFeatures) {
        exec.dispatch(this.seamBatch, uniforms2)
      }
      if (this.wireframeBatch && wireOverlay) {
        exec.dispatch(this.wireframeBatch, uniforms2)
      }
      if (this.pointsBatch && drawPoints) {
        exec.dispatch(this.pointsBatch, uniforms2)
      }
      if (this.selectionBatch && drawSelection) {
        exec.dispatch(this.selectionBatch, uniforms2)
      }
      if (this.boundsBatch && drawBounds) {
        exec.dispatch(this.boundsBatch, uniforms2)
      }
    })
  }

  /* Object-mode selection is shown by the editor-color surface tint (drawQ
   * spreads ObjectEditor's uColor into the surface uniforms) — deliberately no
   * drawOutlineQ override: the AABB box is reserved for the BOUNDS draw mode,
   * and an all-edges outline is too heavy for sculpt-scale meshes. */

  /**
   * WebGPU sibling of the `scheduleRawGLPass` body above. Runs against
   * the active `WebGpuRenderContext`'s currently-open render pass,
   * routing sculptcore `DrawBatch`es through `WebGPUBatchExecutor`.
   * `bindGroupForCommand` lazily reflects each pipeline's WGSL via
   * `UniformBindings` and returns the `@group(0)` bind group with
   * `drawMatrix`/`normalMatrix`/`uColor` already written.
   */
  private drawQGPU(
    uniforms: IUniformsBlock,
    drawBVH: boolean,
    drawFeatures = true,
    drawSelection = false,
    drawWireframe = false,
    drawPoints = false,
    xray = false,
    drawSurface = true,
    drawBounds = false
  ): void {
    const ctx = getActiveWebGpuContext()
    if (!ctx?.currentPass) return
    const pass = ctx.currentPass
    const surfaceFormat = navigator.gpu.getPreferredCanvasFormat()

    // The bindGroupForCommand callback runs inside `exec.dispatch()` —
    // route the per-frame uniforms through an instance field so the
    // closure (built once on first dispatch) always reads the active
    // frame's values.
    this.gpuUniforms = uniforms

    // VDM residency: drain dirty tiles into the atlas/page textures and seed
    // the @group(3) views + layout uniforms. Never throws on the render seam.
    if (this._vdmStore) {
      try {
        this._syncVdmGpu(ctx.device, uniforms as unknown as Record<string, unknown>)
      } catch (err) {
        if (!this._vdmWarnedSync) {
          this._vdmWarnedSync = true
          console.error('litemesh: VDM GPU sync failed', err)
        }
      }
    }

    // The tree surface writes depth and tests less-equal. Backface culling is
    // opt-in (flag `sculptcore.backface_cull`); cullMode is baked into the
    // executor's pipelines, so a flag flip rebuilds the executor (same pattern
    // as the xray-driven overlay executor rebuild below).
    const backfaceCull = FeatureFlags.get('sculptcore.backface_cull') === true
    if (this.drawBatchExecutorGPU === undefined || this._surfaceBackfaceCull !== backfaceCull) {
      this.drawBatchExecutorGPU = this._makeGPUExecutor(
        ctx,
        surfaceFormat,
        true,
        'less-equal',
        backfaceCull ? 'back' : 'none'
      )
      this._surfaceBackfaceCull = backfaceCull
    }
    // The box-modeling overlays ride above the surface (no depth write) and honor
    // xray by switching the depth test to 'always'. Rebuild when xray flips, since
    // depthCompare is baked into each executor's pipelines.
    if (this.overlayExecutorGPU === undefined || this._overlayXray !== xray) {
      this.overlayExecutorGPU = this._makeGPUExecutor(ctx, surfaceFormat, false, xray ? 'always' : 'less-equal')
      this._overlayXray = xray
    }
    const main = this.drawBatchExecutorGPU
    const overlay = this.overlayExecutorGPU

    // Match the active pass's color attachment format — in SHOW_RENDER the
    // engine draws us into the offscreen rgba16float Normal/Base passes, in
    // solid mode into the bgra8unorm canvas pass.
    const fmts = ctx.currentColorFormats ?? [surfaceFormat]
    main.setColorFormats(fmts)
    overlay.setColorFormats(fmts)

    // X3 tessellated tier: substitute the amplified render-level draw for the
    // batch when its async state is ready; fall back to the batch otherwise.
    const tessDrawn = drawSurface && this._drawTessellated(ctx, pass, fmts)
    if (!tessDrawn && this.drawBatch && drawSurface) {
      // Frustum-cull the surface's GPU nodes against the current view (the
      // engine keeps per-command AABBs on the batch).
      const cullMatrix = (uniforms.drawMatrix as Matrix4 | undefined)?.getAsArray?.()
      main.dispatch(this.drawBatch, pass, cullMatrix ? {cullMatrix} : undefined)
    }
    if (drawBVH && this.treeBatch) main.dispatch(this.treeBatch, pass)
    if (this.seamBatch && drawFeatures) main.dispatch(this.seamBatch, pass)
    if (this.wireframeBatch && drawWireframe) overlay.dispatch(this.wireframeBatch, pass)
    if (this.pointsBatch && drawPoints) overlay.dispatch(this.pointsBatch, pass)
    if (this.selectionBatch && drawSelection) overlay.dispatch(this.selectionBatch, pass)
    if (this.boundsBatch && drawBounds) overlay.dispatch(this.boundsBatch, pass)
  }

  /** Build a WebGPU batch executor for the spatial overlays with the given depth
   * config (shared bind-group/uniform plumbing; only depth differs between the
   * tree-surface executor and the xray-aware overlay executor). */
  private _makeGPUExecutor(
    ctx: NonNullable<ReturnType<typeof getActiveWebGpuContext>>,
    surfaceFormat: GPUTextureFormat,
    depthWriteEnabled: boolean,
    depthCompare: GPUCompareFunction,
    cullMode: GPUCullMode = 'none'
  ): WebGPUBatchExecutor {
    const bindingsCache = this.gpuBindingsCache
    const self: LiteMesh = this
    return new WebGPUBatchExecutor({
      device       : ctx.device,
      wasm         : this.wasm,
      pipelineCache: ctx.pipelineCache,
      wgslForShader: wgslForSpatialShader,
      cullMode,
      // Node VBOs double as compute-scatter targets during a GPU brush stroke
      // (gpuGlobalBrushes.md M3/D4); copy-src serves the §9.6 scatter
      // self-check + buffer-signature debug reads.
      bufferUsage        : ['vertex', 'storage', 'copy-src'],
      colorTargets: [
        {
          format: surfaceFormat,
          blend: {
            color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add'},
            alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
          },
        },
      ],
      depthStencil       : {format: 'depth24plus', depthWriteEnabled, depthCompare},
      bindGroupForCommand: (_cmd, pipeline) => {
        let bindings = bindingsCache.get(pipeline)
        if (!bindings) {
          bindings = new UniformBindings(ctx.device, pipeline.descriptor.wgsl, pipeline.descriptor.label)
          bindingsCache.set(pipeline, bindings)
        }
        const uniforms = self.gpuUniforms!
        // Bind every @group the shader declares — basic spatial shaders use only
        // @group(0), a material draw shader spans @group 0/1/2 (frame / lights /
        // object). bindGroupList fills empty fillers for any gap index the shader
        // skips (WebGPU requires a contiguous 0..max range; strict Dawn backends
        // reject a missing intermediate group).
        const groups: CommandBindGroup[] = bindings.bindGroupList(pipeline.handle, uniforms)
        if (groups.length === 0) {
          console.error('litemesh: spatial pipeline declares no uniform bind groups')
          return null
        }
        return groups
      },
    })
  }

  /**
   * The invalidation protocol — documentation/geometry-contract.md §5. Almost
   * everything a LiteMesh draws is derived lazily inside the engine, so only
   * the bounds cache needs flagging; the empty `regen*` methods below are kept
   * so the mapping stays visible rather than becoming an unexplained gap.
   *
   * `range` is deliberately not taken: the engine's per-vertex GPU flagging
   * (`markVertsMovedGPU`) consumes a bound handle vector, and rebuilding one
   * from an `Int32Array` on every call would cost more than it saves.
   */
  invalidate(what: InvalidationKind): void {
    if (what & (InvalidationKind.TOPOLOGY | InvalidationKind.POSITIONS)) {
      this.regenBounds()
    }

    if (what & InvalidationKind.TOPOLOGY) {
      this.regenTessellation()
    }

    const redraws =
      InvalidationKind.TOPOLOGY | InvalidationKind.POSITIONS | InvalidationKind.ATTRIBUTES | InvalidationKind.MATERIALS
    if (what & redraws) {
      this.regenRender()
    }

    if (what & InvalidationKind.SELECTION) {
      this.regenElementsDraw()
    }
  }

  regenRender() {
    //
  }
  regenTessellation() {
    //
  }
  regenElementsDraw() {}
}

/** The geometry-kind descriptor; the addon's `register(api)` hook installs it. */
export const LITEMESH_DATA_KIND: IDataKindDescriptor = {
  id          : 'litemesh',
  uiName      : 'Lite Mesh',
  usesMaterial: true,
  // TODO: no TRIANGLES, so STL export silently skips a LiteMesh -- which is
  // the mesh users would most want to export. It threw outright before P13
  // re-pointed the exporter at ITriangleSource; implementing extractTriangles
  // over the sculptcore tessellation is the fix.
  capabilities: [GeometryCapability.INVALIDATION],
  // The always-present set. Everything a material asks for beyond this is
  // built per-material by `setRequestedAttrs`, at the slot the generator
  // assigned — see documentation/geometry-contract.md §10.
  vertexAttrs : MATERIAL_BASE_VERTEX_ATTRS,
}

/** Conformance to the host geometry contract; see documentation/geometry-contract.md §2. */
export type _LiteMeshIsGeometrySource = AssertExtends<LiteMesh, IGeometrySource>
export type _LiteMeshIsInvalidatable = AssertExtends<LiteMesh, IInvalidatable>
