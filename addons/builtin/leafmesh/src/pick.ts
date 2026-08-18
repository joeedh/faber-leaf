/**
 * The host-facing half of picking — P11 §8. Four `SceneObjectData` overrides,
 * geometric and addon-owned, per documentation/picking.md: there is no GPU
 * id-buffer to fall back on.
 *
 * Everything here is unprojection and result packing; the geometry itself lives
 * in `pick_geom.ts`, which imports nothing from `scripts/` and is unit-tested
 * directly. LeafMeshData delegates its four methods to the functions below.
 */

import type {FindNearestRet as FindNearestRetType, ScreenPickResult, SceneObject, View3D} from '@framework/api'
import {FindNearestRet, Matrix4, SelMask, Vector2, Vector3, Vector4} from '@framework/api'

import type {LeafMeshPickElem, PickCandidate, PickDomainName, Projector} from './pick_geom.js'
import {nearestByDomain, pickScreenCircle, pickScreenRect, rayCastMesh} from './pick_geom.js'
import type {LeafMesh} from './topo.js'
import type {TriangulationCache} from './triangulate.js'

/**
 * What the four entry points need from a LeafMeshData. Structural rather than a
 * class import, so `leafmesh.ts` can depend on this file without this file
 * depending back on it.
 */
export interface PickTarget {
  readonly lib_id: number
  readonly mesh: LeafMesh
  readonly triCache: TriangulationCache
  _ownSelectMask(): number
}

/** How near the clip planes the ray endpoints are unprojected from. */
const CLIP_D = 0.9999

function emptyResult(): ScreenPickResult {
  return {elements: [], elementObjects: [], elementDists: []}
}

/**
 * clip ← local. path.ux's `multiply` applies its argument first, so composing as
 * `load(rendermat).multiply(obmat)` is the object-then-camera order.
 */
function clipFromLocal(view3d: View3D, object: SceneObject): Matrix4 {
  const mat = new Matrix4(view3d.activeCamera.rendermat)
  mat.multiply(object.outputs.matrix.getValue())
  return mat
}

/**
 * Project object-local points straight to screen, skipping world space. `depth`
 * is NDC z, which orders hits under an orthographic camera too — `w` only does
 * so under perspective, and is used here purely to reject what sits behind the
 * eye.
 */
function localProjector(view3d: View3D, object: SceneObject): Projector {
  const mat = clipFromLocal(view3d, object)
  const tmp = new Vector3()

  return (x, y, z) => {
    tmp[0] = x
    tmp[1] = y
    tmp[2] = z
    const w = view3d.project(tmp, mat)
    return w > 0 ? {x: tmp[0], y: tmp[1], depth: tmp[2]} : undefined
  }
}

/** The near→far segment through `mpos`, in object-local space. */
function localRay(view3d: View3D, object: SceneObject, mpos: Vector2): {origin: Vector3; dir: Vector3} {
  const imat = clipFromLocal(view3d, object)
  imat.invert()

  const near = new Vector4([mpos[0], mpos[1], -CLIP_D, 1.0])
  view3d.unproject(near, imat)
  const origin = new Vector3(near)

  const far = new Vector4([mpos[0], mpos[1], CLIP_D, 1.0])
  view3d.unproject(far, imat)

  return {origin, dir: new Vector3(far).sub(origin)}
}

/**
 * Which domains a mask asks for. Vertices when it names none, matching
 * LiteMesh: brush and box select are vertex-centric everywhere else too.
 */
function wantedDomains(selectMask: number): PickDomainName[] {
  const out: PickDomainName[] = []

  if (selectMask & SelMask.VERTEX) {
    out.push('vert')
  }
  if (selectMask & SelMask.EDGE) {
    out.push('edge')
  }
  if (selectMask & SelMask.FACE) {
    out.push('face')
  }

  return out.length > 0 ? out : ['vert']
}

/** Does this mask address LeafMesh at all — as geometry, or as an object? */
function addressesUs(target: PickTarget, selectMask: number): boolean {
  return (selectMask & (SelMask.GEOM | target._ownSelectMask())) !== 0
}

function packResult(object: SceneObject, cands: readonly PickCandidate[]): ScreenPickResult {
  const elements: LeafMeshPickElem[] = []
  const elementObjects: SceneObject[] = []
  const elementDists: number[] = []

  for (const cand of cands) {
    elements.push({type: cand.type, index: cand.index})
    elementObjects.push(object)
    elementDists.push(cand.dis)
  }

  return {elements, elementObjects, elementDists}
}

/**
 * Object-level surface raycast (3D-cursor placement, transform snap): nearest
 * triangle hit, returned world-space with the camera distance in `dis`.
 */
export function castViewRay(
  target: PickTarget,
  view3d: View3D,
  object: SceneObject,
  selectMask: number,
  mpos: Vector2
): FindNearestRetType[] | undefined {
  if (!addressesUs(target, selectMask)) {
    return undefined
  }

  const {origin, dir} = localRay(view3d, object, mpos)
  const hit = rayCastMesh(target.mesh, target.triCache, origin, dir)
  if (hit === undefined) {
    return undefined
  }

  const world = new Vector3(hit.co)
  world.multVecMatrix(object.outputs.matrix.getValue())

  const ret = new FindNearestRet()
  ret.object = object
  ret._mesh = target.lib_id
  ret.p3d.load(world)

  const p2 = new Vector3(world)
  view3d.project(p2)
  ret.p2d.loadXY(p2[0], p2[1])

  const viewVec = new Vector3(view3d.getViewVec(mpos[0], mpos[1]))
  ret.dis = new Vector3(world).sub(view3d.activeCamera.pos).dot(viewVec)

  return [ret]
}

/**
 * Nearest element per requested domain, plus the object itself when the mask
 * asks for objects. Screen distances come from the same circle query
 * `castScreenCircle` answers, so click-select and brush-select agree.
 */
export function findNearest(
  target: PickTarget,
  view3d: View3D,
  object: SceneObject,
  selectMask: number,
  mpos: Vector2,
  limit = 25
): FindNearestRetType[] | undefined {
  if (!addressesUs(target, selectMask)) {
    return undefined
  }

  const cands = pickScreenCircle(
    target.mesh,
    localProjector(view3d, object),
    wantedDomains(selectMask),
    mpos[0],
    mpos[1],
    limit
  )
  if (cands.length === 0) {
    return undefined
  }

  const obmatrix = object.outputs.matrix.getValue()
  const rets: FindNearestRetType[] = []

  if (selectMask & SelMask.GEOM) {
    for (const cand of nearestByDomain(cands).values()) {
      const ret = new FindNearestRet<LeafMeshPickElem>()
      ret.object = object
      ret._mesh = target.lib_id
      ret.data = {type: cand.type, index: cand.index}
      ret.p3d.load(cand.co).multVecMatrix(obmatrix)
      ret.p2d.load(ret.p3d)
      view3d.project(ret.p2d)
      ret.dis = cand.dis
      rets.push(ret)
    }
  }

  if (selectMask & target._ownSelectMask()) {
    const ret = new FindNearestRet<SceneObject>()
    ret.object = object
    ret._mesh = target.lib_id
    ret.data = object
    ret.p3d.zero().multVecMatrix(obmatrix)
    ret.p2d.load(ret.p3d)
    view3d.project(ret.p2d)
    ret.dis = cands[0].dis
    rets.push(ret)
  }

  return rets.length > 0 ? rets : undefined
}

/** Brush/circle select: every element whose representative point lands inside. */
export function castScreenCircle(
  target: PickTarget,
  view3d: View3D,
  object: SceneObject,
  selectMask: number,
  mpos: Vector2,
  radius: number
): ScreenPickResult {
  if (!addressesUs(target, selectMask)) {
    return emptyResult()
  }

  return packResult(
    object,
    pickScreenCircle(
      target.mesh,
      localProjector(view3d, object),
      wantedDomains(selectMask),
      mpos[0],
      mpos[1],
      radius
    )
  )
}

/** Box select, ordered by distance from the rect's centre. */
export function castScreenRect(
  target: PickTarget,
  view3d: View3D,
  object: SceneObject,
  selectMask: number,
  min: Vector2,
  max: Vector2
): ScreenPickResult {
  if (!addressesUs(target, selectMask)) {
    return emptyResult()
  }

  return packResult(
    object,
    pickScreenRect(
      target.mesh,
      localProjector(view3d, object),
      wantedDomains(selectMask),
      min[0],
      min[1],
      max[0],
      max[1]
    )
  )
}
