export enum CursorModes {
  TRANSFORM_CENTER = 0,
  DEPTH_TEST = 1,
  LOCKED = 2,
}

export enum OrbitTargetModes {
  FIXED = 0,
  CURSOR = 1,
}

import * as util from '../../util/util.js'
import {IVectorOrHigher, Matrix4, Number3, Vector2, Vector3, Vector4} from '../../util/vectormath.js'
import type {View3D} from './view3d'

export type BoundingBox = [IVectorOrHigher<3, Vector3>, IVectorOrHigher<3, Vector3>]

const thehash = new util.HashDigest()

const proj_temps = util.cachering.fromConstructor(Vector4, 128)

//viewSize is a copy of view3d.size, not .glSize
export function project(co: IVectorOrHigher<2, Vector2>, rendermat: Matrix4, viewSize: Vector2) {
  const tmp = proj_temps.next().zero()

  tmp[0] = co[0]
  tmp[1] = co[1]

  if (co.length > 2) {
    tmp[2] = co[2]!
  }

  tmp[3] = 1.0
  tmp.multVecMatrix(rendermat)

  if (tmp[3] !== 0.0) {
    tmp[0] /= tmp[3]
    tmp[1] /= tmp[3]
    tmp[2] /= tmp[3]
  }

  const w = tmp[3]

  tmp[0] = (tmp[0] * 0.5 + 0.5) * viewSize[0]
  tmp[1] = (1.0 - (tmp[1] * 0.5 + 0.5)) * viewSize[1]

  for (let i = 0; i < co.length; i++) {
    co[i as Number3] = tmp[i]!
  }

  return w
}

export function calcUpdateHash(view3d: View3D, do_objects = true) {
  thehash.reset()

  if (do_objects) {
    for (const ob of view3d.sortedObjects) {
      thehash.add(ob.lib_id)

      if (ob.updateGen !== undefined) {
        thehash.add(ob.updateGen)
      }

      //console.log("UPDATEGEN:", ob.updateGen, ob.data.updateGen);

      if (ob.data.updateGen !== undefined) {
        thehash.add(ob.data.updateGen)
      }
    }
  }

  for (let _i = 0; _i < 3; _i++) {
    let i = _i as Number3
    thehash.add(view3d.camera.pos[i])
    thehash.add(view3d.camera.target[i])
    thehash.add(view3d.camera.up[i])
    thehash.add(view3d.camera.near)
    thehash.add(view3d.camera.far)
    thehash.add(view3d.camera.fovy)
    thehash.add(view3d.camera.aspect)
  }

  thehash.add(view3d.drawHash)

  //console.log("HASH", thehash.get());

  return thehash.get()
}
