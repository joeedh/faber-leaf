import {BlockLoader, BlockLoaderAddUser, DataBlock, IDataBlockConstructor} from '../core/lib_api'
import {Vector2, Vector3, Matrix4, nstructjs, Container, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'

import {StandardTools} from './stdtools.js'
import {INodeSocketSet, Node, NodeFlags, NodeInheritFlag} from '../core/graph'
import {DependSocket} from '../core/graphsockets'
import type {Material} from '../core/material'
import {aabb_ray_isect} from '../util/isect.js'
import {registerSelectType} from '../core/select_types.js'
import {FindNearestRet} from '../editors/view3d/findnearest.js'
import type {ScreenPickResult} from '../editors/view3d/findnearest.js'
import type {ToolContext, ViewContext} from '../core/context'
import type {SceneObject} from './sceneobject'
import type {View3D} from '../editors/all'
import type {DrawQueue, FrameContext} from '../render/queue'
import {resolveKindId} from '../core/geometry_contract'
import type {AssertExtends} from '../core/geometry_contract'

/** Empty area-pick result (no elements). */
function emptyPickResult(): ScreenPickResult {
  return {elements: [], elementObjects: [], elementDists: []}
}

/**
 * `Material` is a type-only import: a runtime import here forms a `core/material`
 * cycle that TDZ-crashes `class Light extends SceneObjectData` at bundle load.
 * `SceneObjectData.defineAPI` still needs the class to map its `materials` list, so
 * `api_define` injects it via {@link setSceneObjectMaterialClass} at module load.
 */
let _MaterialClass: (abstract new (...args: any[]) => Material) | undefined
export function setSceneObjectMaterialClass(cls: abstract new (...args: any[]) => Material): void {
  _MaterialClass = cls
}

export interface IDataDefine {
  name: string
  selectMask?: number
  /**
   * Name of this type's `SelMask` bit. Declaring one enrolls the type in the
   * select-type registry (`core/select_types.ts`), which hands out the bit and
   * folds it into `SelMask.OBJECT`; read it back as `SelMask[selectTypeName]`.
   * A new type therefore never picks a number — masks persist as names, so the
   * number is in-memory only. The builtin types declare the name they already
   * hold, and registration checks the two agree.
   */
  selectTypeName?: string
  tools: any
  /**
   * Stable data-kind id used by core/context queries and the data_kinds
   * registry. Subclasses that participate in core's kind-driven dispatch
   * (mesh, curve, light, camera, ...) should set this. Defaults to `name`
   * lowercased if omitted. See plan §3.
   */
  dataKind?: string
}

export interface IObjectDataConstructor {
  dataDefine(): IDataDefine
}

export const ObjectDataTypes = [] as IObjectDataConstructor[]

/** TODO: make SceneObjectData a composition pattern instead of a superclass. */
export class SceneObjectData<
  InputSet extends INodeSocketSet = {},
  OutputSet extends INodeSocketSet = {},
> extends DataBlock<InputSet & {depend: DependSocket}, OutputSet & {depend: DependSocket}> {
  material?: Material = undefined
  materials: (Material | undefined)[] & {active?: Material} = []
  usesMaterial = false

  // update generation
  updateGen?: number

  constructor() {
    super()
  }

  applyMatrix(matrix = new Matrix4()) {
    // eslint-disable-next-line no-console
    console.error('applyMatrix: Implement me!')
    return this
  }

  static dataDefine(): IDataDefine {
    return {
      name      : '',
      selectMask: 0, //valid selection modes for StandardTools, see SelMask
      tools     : StandardTools,
    }
  }

  static nodedef() {
    return {
      name   : '',
      inputs: {
        depend: new DependSocket(),
      },
      outputs: {
        depend: new DependSocket(),
      },
      flag   : Node.inheritFlag(NodeFlags.SAVE_PROXY) as NodeInheritFlag | number,
    }
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
SceneObjectData {
  materials : array(e, DataRef) | DataRef.fromBlock(e); 
}`
  )

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const mstruct = super.defineAPI(api, struct ?? api.mapStruct(this, true))
    mstruct.list<(Material | undefined)[], number, Material>('materials', 'materials', [
      function getIter(_api: DataAPI, list: (Material | undefined)[]) {
        return list
      },
      function getLength(_api: DataAPI, list: (Material | undefined)[]) {
        return list.length
      },
      function get(_api: DataAPI, list: (Material | undefined)[], key: number) {
        return list[key]
      },
      function getKey(_api: DataAPI, list: (Material | undefined)[], obj: Material) {
        return list.indexOf(obj)
      },
      function getStruct(dapi: DataAPI, list: (Material | undefined)[], key: number) {
        return dapi.mapStruct(_MaterialClass!)
      },
    ])
    mstruct.bool('usesMaterial', 'usesMaterial', 'Uses Material').readOnly()
    return mstruct
  }

  exec(ctx: ToolContext) {
    this.outputs.depend.graphUpdate()
  }

  static getTools() {
    const def = this.dataDefine()

    if (def.tools) return def.tools

    return StandardTools
  }

  getOwningObject() {
    for (const sock of this.inputs.depend.edges) {
      // XXX fixme: cannot use instanceof here because of circular dependency
      // but this is still a hack

      if ((sock.node as any).constructor.name === 'SceneObject' && (sock.node as unknown as any).data === this) {
        return sock.node as SceneObject
      }
    }

    // eslint-disable-next-line no-console
    console.warn('Orphaned sceneobjectdata!')
  }

  copyAddUsers() {
    return this.copy()
  }

  getBoundingBox(): [Vector3, Vector3] {
    const d = 5

    // eslint-disable-next-line no-console
    console.warn('getBoundingBox: implement me!')

    return [new Vector3([d, d, d]), new Vector3([d, d, d])]
  }

  /**
   * Geometric viewport picking API. These replace the old framebuffer-based
   * `castViewRay`/`findnearest` dispatch (the WebGL-only GPUSelectBuffer is
   * gone; the renderer is WebGPU-only). Core's `findnearest.ts` walks the
   * visible scene objects, filters by `dataDefine().selectMask`, and dispatches
   * to these methods on each object's data.
   *
   * `mpos`/`min`/`max` are view-local screen coordinates (see
   * `View3D.getLocalMouse`). The base implementations provide object-level
   * picking from `getBoundingBox()` + the projected origin, so any data type
   * with a sane bounding box is pickable without bespoke code. Mesh-like data
   * overrides these to return per-element (vertex/edge/face) hits.
   *
   * `castViewRay`/`findNearest` return `FindNearestRet[]` (or undefined for a
   * miss). `dis` is the distance from the camera along the ray for
   * `castViewRay`, and the screen-space pixel distance for `findNearest` — the
   * dispatcher aggregates across objects using those metrics.
   */

  /** This data type's own selection bit (from `dataDefine().selectMask`). */
  _ownSelectMask(): number {
    const ctor = this.constructor as unknown as {dataDefine?: () => IDataDefine}
    return ctor.dataDefine?.().selectMask ?? 0
  }

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

    const origin = new Vector3(view3d.activeCamera.pos)
    const dir = new Vector3(view3d.getViewVec(mpos[0], mpos[1]))

    const [min, max] = object.getBoundingBox()
    if (!aabb_ray_isect(origin, dir, min, max)) {
      return undefined
    }

    const center = new Vector3(min).interp(max, 0.5)
    const dis = Math.max(new Vector3(center).sub(origin).dot(dir), 0.0)

    const ret = new FindNearestRet()
    ret.object = object
    ret.p3d.load(center)

    const p2 = new Vector3(center)
    view3d.project(p2)
    ret.p2d.load(p2)
    ret.dis = dis

    return [ret]
  }

  findNearest(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2,
    limit = 25
  ): FindNearestRet[] | undefined {
    if (!(selectMask & this._ownSelectMask())) {
      return undefined
    }

    const matrix = object.outputs.matrix.getValue()
    // getBoundingBox() is already world-space; origin is the matrix translation.
    const [min, max] = object.getBoundingBox()

    const origin = new Vector3()
    origin.multVecMatrix(matrix)
    const cands: Vector3[] = [origin]
    for (let i = 0; i < 8; i++) {
      cands.push(new Vector3([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]))
    }

    let bestDis = Number.MAX_VALUE
    let bestWorld: Vector3 | undefined
    const p2 = new Vector3()

    for (const co of cands) {
      p2.load(co)
      view3d.project(p2)
      const dx = p2[0] - mpos[0]
      const dy = p2[1] - mpos[1]
      const dis = Math.sqrt(dx * dx + dy * dy)
      if (dis < bestDis) {
        bestDis = dis
        bestWorld = co
      }
    }

    if (bestWorld === undefined || bestDis > limit) {
      return undefined
    }

    const ret = new FindNearestRet()
    ret.object = object
    ret.p3d.load(bestWorld)
    p2.load(bestWorld)
    view3d.project(p2)
    ret.p2d.load(p2)
    ret.dis = bestDis

    return [ret]
  }

  castScreenCircle(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2,
    radius: number
  ): ScreenPickResult {
    const result = emptyPickResult()

    if (!(selectMask & this._ownSelectMask())) {
      return result
    }

    const co = new Vector3()
    co.multVecMatrix(object.outputs.matrix.getValue())
    view3d.project(co)

    const dx = co[0] - mpos[0]
    const dy = co[1] - mpos[1]
    const dis = Math.sqrt(dx * dx + dy * dy)

    if (dis <= radius) {
      result.elements.push(object)
      result.elementObjects.push(object)
      result.elementDists.push(dis)
    }

    return result
  }

  castScreenRect(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    min: Vector2,
    max: Vector2
  ): ScreenPickResult {
    const result = emptyPickResult()

    if (!(selectMask & this._ownSelectMask())) {
      return result
    }

    const co = new Vector3()
    co.multVecMatrix(object.outputs.matrix.getValue())
    view3d.project(co)

    if (co[0] >= min[0] && co[0] <= max[0] && co[1] >= min[1] && co[1] <= max[1]) {
      result.elements.push(object)
      result.elementObjects.push(object)
      result.elementDists.push(0)
    }

    return result
  }

  /**
   * Queue-mediated draw API. All scene-object draws go through this — the
   * adapter (WebGL or WebGPU) is selected by the active renderer.
   *
   * `drawQ` is the main draw entry point. `drawIdsQ` paints the object's
   * sub-element IDs into a float framebuffer for picking — red is
   * sceneobject id + 1, green is any sub-id (also + 1, e.g. vertex eids on
   * a mesh). `drawWireframeQ` / `drawOutlineQ` are the wireframe overlay
   * and selection outline.
   *
   * SceneObject.draw / drawWireframe / drawOutline / drawIds build a
   * transient FrameContext + WebGLDrawQueueAdapter and dispatch through
   * these methods.
   */
  drawIdsQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, selectMask: number, object: SceneObject) {}

  drawQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject) {
    throw new Error('implement me')
  }

  drawWireframeQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject) {}

  drawOutlineQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject) {
    this.drawWireframeQ(view3d, queue, frame, object)
  }

  onContextLost(e: Event) {}

  dataLink(getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    super.dataLink(getblock, getblock_addUser)

    // Slot positions are load-bearing: per-face material indices reference them,
    // so an unresolvable material must leave a hole rather than shift every
    // later slot down onto the wrong faces.
    const mats = [] as (Material | undefined)[]

    //non-datablock materials are allowed

    for (let i = 0; i < this.materials.length; i++) {
      mats.push(getblock_addUser<Material>(this.materials[i] as unknown as number, this))
    }

    this.materials = mats
  }

  static unregister(cls: IDataBlockConstructor<any, {}, {}>) {
    ObjectDataTypes.remove(cls as unknown as IObjectDataConstructor)
  }

  // TS doesn't like us overriding static properties from
  // parent classes with unrelated behavior
  // XXX: temporary hack, TODO: rename this to objectDataRegister
  static register(cls: IDataBlockConstructor<any, {}, {}>) {
    if (!Object.prototype.hasOwnProperty.call(cls, 'dataDefine')) {
      throw new Error('missing .dataDefine static method')
    }

    const def = (cls as unknown as IObjectDataConstructor).dataDefine()

    if (!Object.prototype.hasOwnProperty.call(def, 'selectMask')) {
      throw new Error('dataDefine() is missing selectMask field')
    }

    if (def.selectTypeName) {
      // The first dataDefine() of a brand-new type sees SelMask[name] undefined
      // (hence 0) — that is the allocation call, so only a mismatching non-zero
      // mask is an error.
      const bit = registerSelectType(def.selectTypeName)

      if (def.selectMask && def.selectMask !== bit) {
        throw new Error(
          `${def.name || cls.name}: dataDefine().selectMask should be SelMask.${def.selectTypeName} (${bit}), got ${def.selectMask}`
        )
      }
    }

    ObjectDataTypes.push(cls as unknown as IObjectDataConstructor)
  }

  /**
   * Resolve the data-kind tag for a scene-object data instance. Reads
   * `dataDefine().dataKind` (falling back to a lowercased `dataDefine().name`)
   * and caches the lookup on the constructor. Used by context queries instead
   * of `instanceof Mesh`/`instanceof Light`/... so core stays decoupled from
   * the concrete data classes that live in mesh/light/etc. addons.
   */
  static dataKindOf(data: SceneObjectData | undefined): string | undefined {
    return resolveKindId(data)
  }

  static buildPropertiesTab(container: Container<ViewContext>) {
    container.label('Object Data Properties')
  }
}

// ---------------------------------------------------------------------------
// The host geometry contract, required surface (documentation/geometry-contract.md §2)
//
// These interfaces live here rather than in `core/geometry_contract.ts` because
// they are the only half of the contract that must name host types — a viewport,
// a draw queue, a pick result. That file imports nothing, deliberately; this one
// already imports all of it to declare the class below.
// ---------------------------------------------------------------------------

/**
 * The per-instance surface the host calls every frame and every edit (§2.2).
 *
 * Undo is deliberately absent: a provider does not manage history. The host's
 * undo runs through `ITransDataType` and through editor-owned snapshots.
 */
export interface IGeometryInstance {
  /** World-space AABB. A conservative box is acceptable; a wrong one is not. */
  getBoundingBox(): [Vector3, Vector3]

  /** Bake a matrix into the provider's own coordinates. */
  applyMatrix(matrix?: Matrix4): unknown

  /** This instance's own `SelMask` bits (see `core/select_types.ts`). */
  _ownSelectMask(): number

  drawQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject): void
  drawWireframeQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject): void
  drawOutlineQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject): void
  drawIdsQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, selectMask: number, object: SceneObject): void

  castViewRay(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2
  ): FindNearestRet[] | undefined

  findNearest(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2,
    limit?: number
  ): FindNearestRet[] | undefined

  castScreenCircle(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    mpos: Vector2,
    radius: number
  ): ScreenPickResult

  castScreenRect(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    selectMask: number,
    min: Vector2,
    max: Vector2
  ): ScreenPickResult
}

/**
 * Datablock lifecycle (§2.3). Mostly inherited; a provider overrides only where
 * it holds resources the base class cannot see. `onContextLost` is the one whose
 * absence stays invisible until a device reset.
 */
export interface IGeometryLifecycle {
  copy(addLibUsers?: boolean): unknown
  copyAddUsers(): unknown
  dataLink(getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser): void
  onContextLost(e: Event): void
}

/** Graph participation (§2.4). `graphUpdate` is separate from invalidation. */
export interface IGeometryGraphNode {
  exec(ctx: ToolContext): void
}

/**
 * The required instance surface: what a provider must implement to be a
 * first-class scene citizen. Everything beyond this is opt-in.
 */
export type IGeometrySource = IGeometryInstance & IGeometryLifecycle & IGeometryGraphNode

/**
 * Self-description (§2.5) — how a provider contributes UI and data-API paths
 * without the host knowing it exists. These are statics, so they live on the
 * constructor rather than the instance.
 */
export interface IGeometrySourceStatics {
  defineAPI(api: DataAPI, struct?: DataStruct): DataStruct
  getTools(): unknown
  buildPropertiesTab(container: Container<ViewContext>): void
}

/** {@link IGeometrySourceStatics} plus constructibility, for a concrete kind. */
export interface IGeometrySourceConstructor extends IGeometrySourceStatics {
  new (): IGeometrySource
}

// The required surface was derived from the class above, so every subclass
// conforms for free. These assertions catch drift in either direction — a base
// method that changes shape, or a contract clause no provider supplies.
export type _SceneObjectDataIsGeometrySource = AssertExtends<SceneObjectData, IGeometrySource>
export type _SceneObjectDataStatics = AssertExtends<typeof SceneObjectData, IGeometrySourceStatics>
