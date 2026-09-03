/**
 * Unit tests for the frustum intersection predicates added for viewport box
 * select (`castScreenRect`). These test the pure math in scripts/util/frustum.ts
 * directly — it's dependency-free so it loads in the jsdom harness (isect.ts and
 * the BVH drag in vectormath/three/path.ux, which the harness can't transform).
 * The equivalent tree traversal that calls these is covered natively by the
 * sculptcore GTest (test_spatial_pick.cc).
 */
import {point_in_frustum, aabb_frustum_isect, tri_frustum_isect} from '../../scripts/util/frustum.js'
import {Vector3, Vector4} from '../lib/pathux_shim.js'

/** Inward-facing planes of the axis-aligned box [-1,1]^3 (`[nx,ny,nz,d]`). */
const BOX_FRUSTUM = [
  [1, 0, 0, 1], // x >= -1
  [-1, 0, 0, 1], // x <= 1
  [0, 1, 0, 1], // y >= -1
  [0, -1, 0, 1], // y <= 1
  [0, 0, 1, 1], // z >= -1
  [0, 0, -1, 1], // z <= 1
].map((v) => new Vector4(v))

const v4 = (arr: number[]) => new Vector4(arr)
const v3 = (arr: number[]) => new Vector3([...arr])

describe('point_in_frustum', () => {
  test('center is inside', () => {
    expect(point_in_frustum(BOX_FRUSTUM, v3([0, 0, 0]))).toBe(true)
  })

  test('points outside each face are rejected', () => {
    expect(point_in_frustum(BOX_FRUSTUM, v3([2, 0, 0]))).toBe(false)
    expect(point_in_frustum(BOX_FRUSTUM, v3([0, -2, 0]))).toBe(false)
    expect(point_in_frustum(BOX_FRUSTUM, v3([0, 0, 1.0001]))).toBe(false)
  })

  test('points exactly on a face are inside (>= 0)', () => {
    expect(point_in_frustum(BOX_FRUSTUM, v3([1, 0, 0]))).toBe(true)
    expect(point_in_frustum(BOX_FRUSTUM, v3([-1, 0, 0]))).toBe(true)
  })
})

describe('aabb_frustum_isect', () => {
  test('box fully inside', () => {
    expect(aabb_frustum_isect(BOX_FRUSTUM, v3([-0.5, -0.5, -0.5]), v3([0.5, 0.5, 0.5]))).toBe(true)
  })

  test('box fully outside one plane is rejected', () => {
    expect(aabb_frustum_isect(BOX_FRUSTUM, v3([2, 2, 2]), v3([3, 3, 3]))).toBe(false)
    expect(aabb_frustum_isect(BOX_FRUSTUM, v3([1.5, -0.5, -0.5]), v3([2.5, 0.5, 0.5]))).toBe(false)
  })

  test('box straddling a plane intersects', () => {
    expect(aabb_frustum_isect(BOX_FRUSTUM, v3([0.5, 0.5, 0.5]), v3([2, 2, 2]))).toBe(true)
  })

  test('box enclosing the whole frustum intersects', () => {
    expect(aabb_frustum_isect(BOX_FRUSTUM, v3([-5, -5, -5]), v3([5, 5, 5]))).toBe(true)
  })
})

describe('tri_frustum_isect', () => {
  test('triangle fully inside', () => {
    expect(tri_frustum_isect(BOX_FRUSTUM, v3([0, 0, 0]), v3([0.5, 0, 0]), v3([0, 0.5, 0]))).toBe(true)
  })

  test('triangle fully outside the same plane is rejected', () => {
    expect(tri_frustum_isect(BOX_FRUSTUM, v3([2, 0, 0]), v3([3, 1, 0]), v3([4, -1, 0]))).toBe(false)
  })

  test('triangle with one vertex inside intersects', () => {
    expect(tri_frustum_isect(BOX_FRUSTUM, v3([0, 0, 0]), v3([2, 2, 0]), v3([2, -2, 0]))).toBe(true)
  })

  test('large triangle wrapping the frustum (no vertex inside) is conservatively accepted', () => {
    // No vertex lies inside the box, but the triangle's plane passes through it;
    // the conservative test must not reject it.
    expect(tri_frustum_isect(BOX_FRUSTUM, v3([10, 0, 0]), v3([-10, 10, 0]), v3([-10, -10, 0]))).toBe(true)
  })
})
