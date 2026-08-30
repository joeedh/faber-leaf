'use strict'

import {math} from '../path.ux/scripts/pathux'
import {Vector3, Vector3Like, Number3} from './vectormath.js'
import {point_in_aabb} from './math.js'

type Vec3Arg = Vector3Like

export const license_attribe = `
********************************************************
* AABB-triangle overlap test code *
* by Tomas Akenine-Möller *
* Function: int triBoxOverlap(float boxcenter[3], *
* float boxhalfsize[3],float triverts[3][3]); *
* History: *
* 2001-03-05: released the code in its first version *
* 2001-06-18: changed the order of the tests, faster *
* *
* Acknowledgement: Many thanks to Pierre Terdiman for *
* suggestions and discussions on how to optimize code. *
* Thanks to David Hunt for finding a ">="-bug! *
********************************************************
`

function CROSS(dest: Vec3Arg, v1: Vec3Arg, v2: Vec3Arg) {
  dest[0] = v1[1] * v2[2] - v1[2] * v2[1]
  dest[1] = v1[2] * v2[0] - v1[0] * v2[2]
  dest[2] = v1[0] * v2[1] - v1[1] * v2[0]
}

function DOT(v1: Vec3Arg, v2: Vec3Arg) {
  return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]
}

function SUB(dest: Vec3Arg, v1: Vec3Arg, v2: Vec3Arg) {
  dest[0] = v1[0] - v2[0]
  dest[1] = v1[1] - v2[1]
  dest[2] = v1[2] - v2[2]
}

const _vmin = new Vector3()
const _vmax = new Vector3()

export function planeBoxOverlap(normal: Vec3Arg, vert: Vec3Arg, maxbox: Vec3Arg) {
  const vmin = _vmin
  const vmax = _vmax

  for (let _q = 0; _q <= 3; _q++) {
    const q = _q as Number3

    const v = vert[q] // -NJMP-
    if (normal[q] > 0.0) {
      vmin[q] = -maxbox[q] - v // -NJMP-
      vmax[q] = maxbox[q] - v // -NJMP-
    } else {
      vmin[q] = maxbox[q] - v // -NJMP-
      vmax[q] = -maxbox[q] - v // -NJMP-
    }
  }

  if (DOT(normal, vmin) > 0.0) return 0 // -NJMP-
  if (DOT(normal, vmax) >= 0.0) return 1 // -NJMP-

  return 0
}

const tempv0 = new Vector3()
const tempv1 = new Vector3()
const tempv2 = new Vector3()
const normal = new Vector3()
const tempe0 = new Vector3()
const tempe1 = new Vector3()
const tempe2 = new Vector3()

//boxcenter[3], boxhalfsize[3], triverts[3][3]
export function triBoxOverlap(boxcenter: Vec3Arg, boxhalfsize: Vec3Arg, triverts: Vec3Arg[]) {
  /*    use separating axis theorem to test overlap between triangle and box */
  /*    need to test for overlap in these directions: */
  /*    1) the {x,y,z}-directions (actually, since we use the AABB of the triangle */
  /*       we do not even need to test these) */
  /*    2) normal of the triangle */
  /*    3) crossproduct(edge from tri, {x,y,z}-directin) */
  /*       this gives 3x3=9 more tests */

  let min
  let max
  let p0
  let p1
  let p2
  let rad
  let fex
  let fey
  let fez // -NJMP- "d" local variable removed

  /* This is the fastest branch on Sun */
  /* move everything so that the boxcenter is in (0,0,0) */

  SUB(tempv0, triverts[0], boxcenter)
  SUB(tempv1, triverts[1], boxcenter)
  SUB(tempv2, triverts[2], boxcenter)

  /* compute triangle edges */

  SUB(tempe0, tempv1, tempv0) /* tri edge 0 */
  SUB(tempe1, tempv2, tempv1) /* tri edge 1 */

  SUB(tempe2, tempv0, tempv2) /* tri edge 2 */

  /* Bullet 3:  */
  /*  test the 9 tests first (this was faster) */

  fex = Math.abs(tempe0[0])
  fey = Math.abs(tempe0[1])
  fez = Math.abs(tempe0[2])

  p0 = tempe0[2] * tempv0[1] - tempe0[1] * tempv0[2]
  p2 = tempe0[2] * tempv2[1] - tempe0[1] * tempv2[2]
  if (p0 < p2) {
    min = p0
    max = p2
  } else {
    min = p2
    max = p0
  }
  rad = fez * boxhalfsize[1] + fey * boxhalfsize[2]
  if (min > rad || max < -rad) return 0
  p0 = -tempe0[2] * tempv0[0] + tempe0[0] * tempv0[2]
  p2 = -tempe0[2] * tempv2[0] + tempe0[0] * tempv2[2]
  if (p0 < p2) {
    min = p0
    max = p2
  } else {
    min = p2
    max = p0
  }
  rad = fez * boxhalfsize[0] + fex * boxhalfsize[2]
  if (min > rad || max < -rad) return 0
  p1 = tempe0[1] * tempv1[0] - tempe0[0] * tempv1[1]
  p2 = tempe0[1] * tempv2[0] - tempe0[0] * tempv2[1]
  if (p2 < p1) {
    min = p2
    max = p1
  } else {
    min = p1
    max = p2
  }
  rad = fey * boxhalfsize[0] + fex * boxhalfsize[1]
  if (min > rad || max < -rad) return 0

  fex = Math.abs(tempe1[0])
  fey = Math.abs(tempe1[1])
  fez = Math.abs(tempe1[2])

  p0 = tempe1[2] * tempv0[1] - tempe1[1] * tempv0[2]
  p2 = tempe1[2] * tempv2[1] - tempe1[1] * tempv2[2]
  if (p0 < p2) {
    min = p0
    max = p2
  } else {
    min = p2
    max = p0
  }
  rad = fez * boxhalfsize[1] + fey * boxhalfsize[2]
  if (min > rad || max < -rad) return 0
  p0 = -tempe1[2] * tempv0[0] + tempe1[0] * tempv0[2]
  p2 = -tempe1[2] * tempv2[0] + tempe1[0] * tempv2[2]
  if (p0 < p2) {
    min = p0
    max = p2
  } else {
    min = p2
    max = p0
  }
  rad = fez * boxhalfsize[0] + fex * boxhalfsize[2]
  if (min > rad || max < -rad) return 0
  p0 = tempe1[1] * tempv0[0] - tempe1[0] * tempv0[1]
  p1 = tempe1[1] * tempv1[0] - tempe1[0] * tempv1[1]
  if (p0 < p1) {
    min = p0
    max = p1
  } else {
    min = p1
    max = p0
  }
  rad = fey * boxhalfsize[0] + fex * boxhalfsize[1]
  if (min > rad || max < -rad) return 0

  fex = Math.abs(tempe2[0])
  fey = Math.abs(tempe2[1])
  fez = Math.abs(tempe2[2])

  p0 = tempe2[2] * tempv0[1] - tempe2[1] * tempv0[2]
  p1 = tempe2[2] * tempv1[1] - tempe2[1] * tempv1[2]
  if (p0 < p1) {
    min = p0
    max = p1
  } else {
    min = p1
    max = p0
  }
  rad = fez * boxhalfsize[1] + fey * boxhalfsize[2]
  if (min > rad || max < -rad) return 0
  p0 = -tempe2[2] * tempv0[0] + tempe2[0] * tempv0[2]
  p1 = -tempe2[2] * tempv1[0] + tempe2[0] * tempv1[2]
  if (p0 < p1) {
    min = p0
    max = p1
  } else {
    min = p1
    max = p0
  }
  rad = fez * boxhalfsize[0] + fex * boxhalfsize[2]
  if (min > rad || max < -rad) return 0
  p1 = tempe2[1] * tempv1[0] - tempe2[0] * tempv1[1]
  p2 = tempe2[1] * tempv2[0] - tempe2[0] * tempv2[1]
  if (p2 < p1) {
    min = p2
    max = p1
  } else {
    min = p1
    max = p2
  }
  rad = fey * boxhalfsize[0] + fex * boxhalfsize[1]
  if (min > rad || max < -rad) return 0

  /* Bullet 1: */
  /*  first test overlap in the {x,y,z}-directions */
  /*  find min, max of the triangle each direction, and test for overlap in */
  /*  that direction -- this is equivalent to testing a minimal AABB around */
  /*  the triangle against the AABB */

  /* test in X-direction */

  min = max = tempv0[0]
  if (tempv1[0] < min) min = tempv1[0]
  if (tempv1[0] > max) max = tempv1[0]
  if (tempv2[0] < min) min = tempv2[0]
  if (tempv2[0] > max) max = tempv2[0]

  if (min > boxhalfsize[0] || max < -boxhalfsize[0]) return 0

  /* test in Y-direction */

  min = max = tempv0[1]
  if (tempv1[1] < min) min = tempv1[1]
  if (tempv1[1] > max) max = tempv1[1]
  if (tempv2[1] < min) min = tempv2[1]
  if (tempv2[1] > max) max = tempv2[1]

  if (min > boxhalfsize[1] || max < -boxhalfsize[1]) return 0

  /* test in Z-direction */

  min = max = tempv0[2]
  if (tempv1[2] < min) min = tempv1[2]
  if (tempv1[2] > max) max = tempv1[2]
  if (tempv2[2] < min) min = tempv2[2]
  if (tempv2[2] > max) max = tempv2[2]

  if (min > boxhalfsize[2] || max < -boxhalfsize[2]) return 0

  /* Bullet 2: */
  /*  test if the box intersects the plane of the triangle */
  /*  compute plane equation of triangle: normal*x+d=0 */

  CROSS(normal, tempe0, tempe1)

  // -NJMP- (line removed here)

  if (!planeBoxOverlap(normal, tempv0, boxhalfsize)) return 0 // -NJMP-

  return 1 /* box and triangle overlaps */
}

const tsize = new Vector3()
const tcent = new Vector3()
const triverts = new Array<Vec3Arg>(3)

export function tri_aabb_isect(v1: Vec3Arg, v2: Vec3Arg, v3: Vec3Arg, min: Vec3Arg, max: Vec3Arg) {
  const cent = tcent
  const size = tsize

  triverts[0] = v1
  triverts[1] = v2
  triverts[2] = v3

  cent.load(max).add(min).mulScalar(0.5)
  size.load(max).sub(min).mulScalar(0.5)

  return triBoxOverlap(cent, size, triverts)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ray_tri_attrib = `
* Ray-Triangle Intersection Test Routines *
* Different optimizations of my and Ben Trumbore's *
* code from journals of graphics tools (JGT) *
* http://www.acm.org/jgt/                          *
* by Tomas Moller, May 2000 *
`

const edge1 = new Vector3()
const edge2 = new Vector3()
const tvec = new Vector3()
const qvec = new Vector3()
const pvec = new Vector3()
const rti_ret = new Vector3()

/* the original jgt code */
export function ray_tri_isect(orig: Vec3Arg, dir: Vec3Arg, vert0: Vec3Arg, vert1: Vec3Arg, vert2: Vec3Arg) {
  /* find vectors for two edges sharing vert0 */
  SUB(edge1, vert1, vert0)
  SUB(edge2, vert2, vert0)

  /* begin calculating determinant - also used to calculate U parameter */
  CROSS(pvec, dir, edge2)

  /* if determinant is near zero, ray lies in plane of triangle */
  const det = DOT(edge1, pvec)

  if (det > -0.000001 && det < 0.000001) return undefined
  const inv_det = 1.0 / det

  /* calculate distance from vert0 to ray origin */
  SUB(tvec, orig, vert0)

  /* calculate U parameter and test bounds */
  const u = DOT(tvec, pvec) * inv_det
  if (u < 0.0 || u > 1.0) return undefined

  /* prepare to test V parameter */
  CROSS(qvec, tvec, edge1)

  /* calculate V parameter and test bounds */
  const v = DOT(dir, qvec) * inv_det
  if (v < 0.0 || u + v > 1.0) return undefined

  /* calculate t, ray intersects triangle */
  const t = DOT(edge2, qvec) * inv_det

  const ret = rti_ret

  ret[0] = 1.0 - u - v
  ret[1] = u
  ret[2] = t

  return ret
}

const tmp1 = new Vector3()

export function tri_cone_isect(
  p1: Vec3Arg,
  p2: Vec3Arg,
  radius1: number,
  radius2: number,
  v1: Vec3Arg,
  v2: Vec3Arg,
  v3: Vec3Arg,
  clip = false
) {
  const ret = math.closest_point_on_tri(p1, v1, v2, v3)

  if (!ret) {
    //bad tri!
    return false
  }

  const d = math.closest_point_on_line(ret.co, p1, p2, clip)
  if (d === undefined) {
    return true
  }

  const co = d[0]
  const t = d[1] / p1.vectorDistance(p2)

  const r = radius1 + (radius2 - radius1) * t
  //console.log(d, "DIS", ret.co.vectorDistance(co), "R", r, t, radius1, radius2);

  return ret.co.vectorDistance(co) <= r
}

const conetmp1 = new Vector3()
export function aabb_cone_isect(
  co: Vec3Arg,
  vector: Vec3Arg,
  radius1: number,
  radius2: number,
  min: Vec3Arg,
  max: Vec3Arg
) {
  if (point_in_aabb(co, min, max)) {
    return true
  }

  const rlen = vector.vectorLength()
  const ray = conetmp1.load(vector)

  if (rlen > 0.00001) {
    ray.mulScalar(1.0 / rlen)
    radius2 /= rlen
  }

  for (let _axis = 0; _axis < 3; _axis++) {
    const axis = _axis as Number3
    let p: Vector3
    let t1: number
    let t2: number

    const a1 = ((axis + 1) % 3) as Number3
    const a2 = ((axis + 2) % 3) as Number3

    const amin = min[axis]
    const amax = max[axis]
    let r: number

    if (Math.abs(ray[axis]) > 0.0001) {
      t1 = (amin - co[axis]) / ray[axis]
      t2 = (amax - co[axis]) / ray[axis]

      p = tmp1.load(co).addFac(ray, t1)

      r = radius1 + (radius2 - radius1) * t1
    } else {
      continue
    }

    if (
      t1 > 0.0 &&
      t1 < rlen &&
      p[a1] >= min[a1] - r &&
      p[a1] <= max[a1] + r &&
      p[a2] >= min[a2] - r &&
      p[a2] <= max[a2] + r
    ) {
      return true
    }

    p.load(co).addFac(ray, t2)

    if (t2 > 0.0 && t2 < rlen && p[a1] >= min[a1] && p[a1] <= max[a1] && p[a2] >= min[a2] && p[a2] <= max[a2]) {
      return true
    }
  }

  return false
}

export function aabb_ray_isect(co: Vec3Arg, indir: Vec3Arg, min: Vec3Arg, max: Vec3Arg) {
  if (point_in_aabb(co, min, max)) {
    return true
  }

  for (let _axis = 0; _axis < 3; _axis++) {
    const axis = _axis as Number3
    let p: Vector3
    let t1: number
    let t2: number

    const a1 = ((axis + 1) % 3) as Number3
    const a2 = ((axis + 2) % 3) as Number3

    const amin = min[axis]
    const amax = max[axis]

    if (Math.abs(indir[axis]) > 0.0001) {
      t1 = (amin - co[axis]) / indir[axis]
      t2 = (amax - co[axis]) / indir[axis]

      p = tmp1.load(co).addFac(indir, t1)
    } else {
      continue
    }

    if (p[a1] >= min[a1] && p[a1] <= max[a1] && p[a2] >= min[a2] && p[a2] <= max[a2]) {
      return true
    }

    p.load(co).addFac(indir, t2)

    if (p[a1] >= min[a1] && p[a1] <= max[a1] && p[a2] >= min[a2] && p[a2] <= max[a2]) {
      return true
    }
  }

  return false
}

/* Frustum predicates live in their own dependency-free module so they remain
 * unit-testable in isolation (see frustum.ts). Re-exported here so existing
 * `@framework/api` / isect.js consumers keep one import surface. */
export {point_in_frustum, aabb_frustum_isect, tri_frustum_isect} from './frustum.js'
