/**
 * Face triangulation: the fan path for convex rings, the CDT path for concave
 * ones and for faces with holes, the fan fallback when CDT gives up, and the
 * cache's dependence on `topoStamp`.
 */

import {ELEM_NONE, LeafMesh, type Vec3} from '../../../addons/builtin/leafmesh/src/topo'
import {
  TriangulationCache,
  type Tri,
  triangulateFace,
  triangulateMesh,
} from '../../../addons/builtin/leafmesh/src/triangulate'
import {makeCube, makeGrid, makeTube} from '../../../addons/builtin/leafmesh/src/primitives'

function co(mesh: LeafMesh, v: number): Vec3 {
  return [mesh.v.co[v * 3], mesh.v.co[v * 3 + 1], mesh.v.co[v * 3 + 2]]
}

function triArea(mesh: LeafMesh, t: Tri): number {
  const [a, b, c] = t.v.map((v) => co(mesh, v))
  const ux = b[0] - a[0]
  const uy = b[1] - a[1]
  const uz = b[2] - a[2]
  const vx = c[0] - a[0]
  const vy = c[1] - a[1]
  const vz = c[2] - a[2]
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  return Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5
}

function totalArea(mesh: LeafMesh, tris: readonly Tri[]): number {
  let a = 0
  for (const t of tris) {
    a += triArea(mesh, t)
  }
  return a
}

/** Outer ring area less its holes, from the mesh's own winding rule. */
function faceArea(mesh: LeafMesh, f: number): number {
  const normal = mesh.faceNormal(f)
  let area = 0
  for (const l of mesh.faceLoops(f)) {
    area += mesh.ringSignedArea(mesh.loopVerts(l), normal)
  }
  return area
}

/** Every triangle's corners belong to the face and name their own vertices. */
function expectConsistent(mesh: LeafMesh, f: number, tris: readonly Tri[]): void {
  const owned = new Set<number>()
  for (const l of mesh.faceLoops(f)) {
    for (const c of mesh.loopCorners(l)) {
      owned.add(c)
    }
  }

  for (const t of tris) {
    expect(t.f).toBe(f)
    for (let k = 0; k < 3; k++) {
      expect(owned.has(t.c[k])).toBe(true)
      expect(mesh.c.v[t.c[k]]).toBe(t.v[k])
    }
    expect(new Set(t.v).size).toBe(3)
  }
}

function ngon(mesh: LeafMesh, xy: ReadonlyArray<readonly [number, number]>): number {
  return mesh.makeFace([xy.map(([x, y]) => mesh.makeVert([x, y, 0]))])
}

const U_SHAPE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [3, 0],
  [3, 3],
  [2, 3],
  [2, 1],
  [1, 1],
  [1, 3],
  [0, 3],
]

describe('triangulateFace', () => {
  test('fans a quad', () => {
    const mesh = new LeafMesh()
    const f = ngon(mesh, [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ])

    const tris: Tri[] = []
    expect(triangulateFace(mesh, f, tris)).toBe(true)
    expect(tris.length).toBe(2)
    expect(totalArea(mesh, tris)).toBeCloseTo(4)
    expectConsistent(mesh, f, tris)
  })

  test('fans a convex n-gon', () => {
    const mesh = new LeafMesh()
    const xy: Array<[number, number]> = []
    for (let i = 0; i < 7; i++) {
      const a = (2 * Math.PI * i) / 7
      xy.push([Math.cos(a), Math.sin(a)])
    }
    const f = ngon(mesh, xy)

    const tris: Tri[] = []
    expect(triangulateFace(mesh, f, tris)).toBe(true)
    expect(tris.length).toBe(5)
    expect(totalArea(mesh, tris)).toBeCloseTo(faceArea(mesh, f), 6)
    expectConsistent(mesh, f, tris)
  })

  test('CDTs a concave n-gon instead of fanning across the notch', () => {
    const mesh = new LeafMesh()
    const f = ngon(mesh, U_SHAPE)

    const tris: Tri[] = []
    expect(triangulateFace(mesh, f, tris)).toBe(true)
    expect(tris.length).toBe(6)
    // A fan from corner 0 would have covered the notch; the area proves it did not.
    expect(totalArea(mesh, tris)).toBeCloseTo(7, 6)
    expectConsistent(mesh, f, tris)
  })

  test('triangulates a face with a hole and leaves the hole empty', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5, 1)
    const caps = [...mesh.f].filter((f) => mesh.f.listCount[f] === 2)
    expect(caps.length).toBe(2)

    for (const f of caps) {
      const tris: Tri[] = []
      expect(triangulateFace(mesh, f, tris)).toBe(true)
      expect(tris.length).toBeGreaterThan(0)
      expect(totalArea(mesh, tris)).toBeCloseTo(faceArea(mesh, f), 6)
      expectConsistent(mesh, f, tris)
    }
  })

  test('a face whose plane is not axis-aligned still triangulates', () => {
    const mesh = new LeafMesh()
    const f = mesh.makeFace([U_SHAPE.map(([x, y]) => mesh.makeVert([x, y * 0.6, y * 0.8]))])

    const tris: Tri[] = []
    expect(triangulateFace(mesh, f, tris)).toBe(true)
    expect(tris.length).toBe(6)
    expect(totalArea(mesh, tris)).toBeCloseTo(7, 6)
  })

  test('falls back to a fan and says so when the ring self-intersects', () => {
    const mesh = new LeafMesh()
    const f = ngon(mesh, [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ])

    const tris: Tri[] = []
    expect(triangulateFace(mesh, f, tris)).toBe(false)
    // The fan still emits something drawable, it is just geometrically wrong.
    expect(tris.length).toBe(2)
    expectConsistent(mesh, f, tris)
  })

  test('a face with no loops emits nothing', () => {
    const mesh = new LeafMesh()
    const f = mesh.f.array.alloc()
    mesh.f.l[f] = ELEM_NONE

    const tris: Tri[] = []
    expect(triangulateFace(mesh, f, tris)).toBe(true)
    expect(tris.length).toBe(0)
  })
})

describe('triangulateMesh', () => {
  test('covers every face of a cube', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const tris = triangulateMesh(mesh)
    expect(tris.length).toBe(12)
    expect(totalArea(mesh, tris)).toBeCloseTo(24)
    expect(new Set(tris.map((t) => t.f)).size).toBe(6)
  })

  test('covers every face of a grid', () => {
    const mesh = new LeafMesh()
    makeGrid(mesh, 4, 3, 4)

    const tris = triangulateMesh(mesh)
    expect(tris.length).toBe(24)
    expect(totalArea(mesh, tris)).toBeCloseTo(16)
  })
})

describe('TriangulationCache', () => {
  test('memoizes per face', () => {
    const mesh = new LeafMesh()
    const {faces} = makeGrid(mesh, 2, 1, 2)
    const cache = new TriangulationCache()

    const first = cache.get(mesh, faces[0])
    expect(cache.get(mesh, faces[0])).toBe(first)
    expect(cache.get(mesh, faces[1])).not.toBe(first)
    expect(first.length).toBe(2)
    expect(cache.failedFaces.size).toBe(0)
  })

  test('drops everything when the topology stamp moves', () => {
    const mesh = new LeafMesh()
    const {faces} = makeGrid(mesh, 2, 1, 2)
    const cache = new TriangulationCache()

    const first = cache.get(mesh, faces[0])
    expect(first.length).toBe(2)

    const shared = [...mesh.e].find((e) => mesh.edgeFaceCount(e) === 2) as number
    mesh.splitEdge(shared, 0.5)

    const second = cache.get(mesh, faces[0])
    expect(second).not.toBe(first)
    expect(second.length).toBe(3)
  })

  test('invalidate forces a recompute even at the same stamp', () => {
    const mesh = new LeafMesh()
    const f = ngon(mesh, U_SHAPE)
    const cache = new TriangulationCache()

    const first = cache.get(mesh, f)
    cache.invalidate()
    expect(cache.failedFaces.size).toBe(0)
    expect(cache.get(mesh, f)).not.toBe(first)
  })

  test('records the faces that fell back to a fan', () => {
    const mesh = new LeafMesh()
    const good = ngon(mesh, U_SHAPE)
    const bad = ngon(mesh, [
      [10, 0],
      [11, 1],
      [11, 0],
      [10, 1],
    ])
    const cache = new TriangulationCache()

    cache.get(mesh, good)
    cache.get(mesh, bad)
    expect([...cache.failedFaces]).toEqual([bad])
  })
})
