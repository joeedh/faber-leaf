import {
  IVector4,
  Matrix4,
  Vector2,
  Vector2Like,
  Vector3,
  Vector3Like,
  Vector4,
  Vector4Like,
} from '../../util/vectormath'
import {util} from '../../path.ux/scripts/pathux'

/** A screen-space label the viewport draws this frame and forgets the next. */
export interface ITempText {
  co: Vector3
  text: string
  color: Vector4
  size: number
}

const proj_temps = util.cachering.fromConstructor(Vector4, 32)
const unproj_temps = util.cachering.fromConstructor(Vector4, 32)

export function view3dProject(co: Vector2Like | Vector3Like | Vector4Like, size: Vector2Like, rendermat: Matrix4) {
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

  tmp[0] = (tmp[0] * 0.5 + 0.5) * size![0]
  tmp[1] = (1.0 - (tmp[1] * 0.5 + 0.5)) * size![1]

  for (let i = 0; i < co.length; i++) {
    co[i] = tmp[i]
  }

  return w
}

export function view3dUnproject(co: Vector2Like | Vector3Like | Vector4Like, size: Vector2Like, irendermat: Matrix4) {
  const tmp = unproj_temps.next().zero()

  tmp[0] = (co[0] / size![0]) * 2.0 - 1.0
  tmp[1] = (1.0 - co[1] / size![1]) * 2.0 - 1.0

  if (co.length > 2) {
    tmp[2] = co[2]!
  }

  if (co.length > 3) {
    tmp[3] = co[3]!
  } else {
    tmp[3] = 1.0
  }

  tmp.multVecMatrix(irendermat)

  const w = tmp[3]

  if (tmp[3] !== 0.0) {
    tmp[0] /= tmp[3]
    tmp[1] /= tmp[3]
    tmp[2] /= tmp[3]
  }

  for (let i = 0; i < co.length; i++) {
    co[i] = tmp[i]
  }

  return w
}

export class DrawQuad {
  v1: Vector3
  v2: Vector3
  v3: Vector3
  v4: Vector3
  color: Vector4
  useZ: boolean

  constructor(
    v1: Vector3 | number[],
    v2: Vector3 | number[],
    v3: Vector3 | number[],
    v4: Vector3 | number[],
    color: Vector4 | number[],
    useZ?: boolean
  ) {
    this.v1 = new Vector3(v1)
    this.v2 = new Vector3(v2)
    this.v3 = new Vector3(v3)
    this.v4 = new Vector3(v4)
    this.color = new Vector4(color)
    this.useZ = !!useZ

    const a = color.length > 3 ? color[3] : 1.0
    this.color[3] = a
  }
}

export class DrawLine {
  v1: Vector3
  v2: Vector3
  color: Vector4
  useZ: boolean

  constructor(
    v1: Vector3 | number[],
    v2: Vector3 | number[],
    color: IVector4 | number[] = [0, 0, 0, 1],
    useZ?: boolean
  ) {
    const a = color.length > 3 ? color[3] : 1.0

    this.color = new Vector4(color)
    this.color[3] = a

    this.useZ = !!useZ

    this.v1 = new Vector3(v1)
    this.v2 = new Vector3(v2)
  }
}

export const View3DFlags = {
  SHOW_CURSOR     : 1,
  SHOW_RENDER     : 2,
  ONLY_RENDER     : 4,
  LOCAL_CURSOR    : 8,
  SHOW_GRID       : 16,
  SHOW_CAMERA_VIEW: 32,
  USE_CTX_CAMERA  : 64,
}

export const CameraModes = {
  PERSPECTIVE : 0,
  ORTHOGRAPHIC: 1,
}
