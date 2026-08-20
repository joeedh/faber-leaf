/* view picking functionality
 *
 * Picking is geometric and lives on the object data: each SceneObjectData
 * subclass implements `findNearest` / `castViewRay` / `castScreenCircle` /
 * `castScreenRect` (the base class provides bounding-box object-level defaults;
 * the mesh addon overrides them with BVH-backed element picking). The functions
 * here are thin dispatchers that walk the visible scene objects and aggregate
 * the per-object results. The old framebuffer GPUSelectBuffer + FindnearestClass
 * registry are gone (the renderer is WebGPU-only).
 */

import type {ViewContext} from '../../core/context.js'
import {getAppState} from '../../core/app_instance.js'
import {Vector2, Vector3} from '../../util/vectormath.js'
import type {SceneObject} from '../../sceneobject/sceneobject.js'
import type {View3D} from './view3d.js'

export const CastModes = {
  FRAMEBUFFER: 0, // legacy: castViewRay p is in screen space (kept for call-site compat; geometric now)
  GEOMETRIC  : 1,
}

/**
 * Result of a screen-space area pick (`castScreenCircle` / `castScreenRect`).
 *
 * `elements` is intentionally `unknown[]` so core never depends on the concrete
 * element type owned by an addon: the mesh addon stores `Element`s, LiteMesh
 * stores integer indices, and the SceneObjectData base default stores the
 * `SceneObject` itself. Consumers narrow `elements` locally.
 *
 * The three arrays are parallel: `elements[i]` belongs to `elementObjects[i]`
 * and was picked at screen distance `elementDists[i]`.
 */
export interface ScreenPickResult {
  elements: unknown[]
  elementObjects: SceneObject[]
  elementDists: number[]
}

export class FindNearestRet<D = unknown> {
  data?: D
  _object: number
  _mesh: number
  p2d: Vector2
  p3d: Vector3
  dis?: number

  constructor() {
    this.data = undefined
    this._object = -1
    this._mesh = -1

    this.p2d = new Vector2()
    this.p3d = new Vector3()
    this.dis = undefined
  }

  //avoid reference leaks in cacherings
  get object() {
    return getAppState().datalib.get(this._object)
  }

  set object(ob) {
    if (!ob) {
      this._object = -1
      return
    }

    this._object = ob.lib_id
  }

  get mesh() {
    return getAppState().datalib.get(this._mesh)
  }

  set mesh(ob) {
    if (!ob) {
      this._mesh = -1
      return
    }

    this._mesh = ob.lib_id
  }

  reset() {
    this.p2d.zero()
    this.p3d.zero()
    this.dis = undefined
    this.object = undefined
    this.data = undefined

    return this
  }
}

/**
 * Find geometry near (screen-space) `mpos`. Walks the visible scene objects and
 * dispatches to each object data's `findNearest`; results are concatenated and
 * sorted by screen distance so `[0]` is the nearest hit across all objects.
 *
 * `mpos` is assumed to already be view-local (see `View3D.getLocalMouse`).
 * `selectMask` (see SelMask) selects which element/object kinds to consider —
 * each data method gates on it.
 */
export function FindNearest(
  ctx: ViewContext,
  selectMask: number,
  mpos: Vector2 | Vector3,
  view3d?: View3D,
  limit = 25
): FindNearestRet[] {
  view3d = view3d === undefined ? ctx.view3d : view3d

  const mp = new Vector2()
  mp[0] = mpos[0]
  mp[1] = mpos[1]

  let ret: FindNearestRet[] = []

  for (const ob of view3d.sortedObjects) {
    const data = ob.data
    if (!data) {
      continue
    }

    const ret2 = data.findNearest(ctx, view3d, ob, selectMask, mp, limit)
    if (ret2 !== undefined && ret2.length > 0) {
      ret = ret.concat(ret2)
    }
  }

  ret.sort((a, b) => (a.dis ?? Number.MAX_VALUE) - (b.dis ?? Number.MAX_VALUE))

  return ret
}

/**
 * Cast a ray from the camera through the screen point `mpos` and return the
 * single closest surface hit across all visible objects. `mode` is retained for
 * call-site compatibility but picking is always geometric now.
 */
export function castViewRay(
  ctx: ViewContext,
  selectMask: number,
  mpos: Vector2 | Vector3,
  view3d?: View3D,
  mode = CastModes.FRAMEBUFFER
): FindNearestRet[] {
  view3d = view3d === undefined ? ctx.view3d : view3d

  const mp = new Vector2()
  mp[0] = mpos[0]
  mp[1] = mpos[1]

  let ret: FindNearestRet[] = []

  for (const ob of view3d.sortedObjects) {
    const data = ob.data
    if (!data) {
      continue
    }

    const ret2 = data.castViewRay(ctx, view3d, ob, selectMask, mp)
    if (ret2 !== undefined) {
      ret = ret.concat(ret2)
    }
  }

  // Return the closest item in FRONT of the camera. (A behind-camera hit used
  // to be able to claim `best` first and then shadow every valid hit, because
  // the dis>0 guard was only applied to later items.)
  let mindis = 1e17
  let best: FindNearestRet | undefined = undefined

  for (const item of ret) {
    if (item.dis === undefined || item.dis <= 0) {
      continue
    }
    if (best === undefined || item.dis < mindis) {
      mindis = item.dis
      best = item
    }
  }

  return best ? [best] : []
}
