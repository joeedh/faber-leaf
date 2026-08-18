/**
 * The CPU half of picking (P11 §8): raycast, representative points, and the
 * screen-space circle/rect queries. `pick.ts` itself is not reachable here — it
 * imports `@framework/api` — so the viewport arrives as a projector callback.
 */

import {
  DEPTH_TIEBREAK_PX,
  elementPoint,
  nearestByDomain,
  pickScreenCircle,
  pickScreenRect,
  rayCastMesh,
} from '../../../addons/builtin/leafmesh/src/pick_geom'
import type {PickCandidate, Projector} from '../../../addons/builtin/leafmesh/src/pick_geom'
import {makeCube, makePlane} from '../../../addons/builtin/leafmesh/src/primitives'
import {LeafMesh} from '../../../addons/builtin/leafmesh/src/topo'
import {TriangulationCache} from '../../../addons/builtin/leafmesh/src/triangulate'

/**
 * A camera at +z looking down -z: 100 px per unit, y flipped, and anything past
 * z = 10 counts as behind the eye. Depth grows with distance, as the real
 * projector's NDC z does.
 */
const project: Projector = (x, y, z) => (z > 10 ? undefined : {x: x * 100 + 250, y: -y * 100 + 250, depth: -z})

/** A square face with a square hole through the middle, in the z = 0 plane. */
function holedQuad(): LeafMesh {
  const mesh = new LeafMesh()
  const outer = [
    mesh.makeVert([-2, -2, 0]),
    mesh.makeVert([2, -2, 0]),
    mesh.makeVert([2, 2, 0]),
    mesh.makeVert([-2, 2, 0]),
  ]
  const hole = [
    mesh.makeVert([-1, -1, 0]),
    mesh.makeVert([-1, 1, 0]),
    mesh.makeVert([1, 1, 0]),
    mesh.makeVert([1, -1, 0]),
  ]
  mesh.makeFace([outer, hole])
  return mesh
}

describe('rayCastMesh', () => {
  test('a ray down -z hits a plane in the z = 0 plane', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    const hit = rayCastMesh(mesh, new TriangulationCache(), [0, 0, 5], [0, 0, -1])

    expect(hit).toBeDefined()
    expect(hit!.co[2]).toBeCloseTo(0, 6)
    expect(hit!.t).toBeCloseTo(5, 6)
  })

  test('a ray that misses the mesh entirely returns undefined', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    expect(rayCastMesh(mesh, new TriangulationCache(), [50, 50, 5], [0, 0, -1])).toBeUndefined()
  })

  test('a ray behind the origin is not reported (only positive t)', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    expect(rayCastMesh(mesh, new TriangulationCache(), [0, 0, 5], [0, 0, 1])).toBeUndefined()
  })

  test('the nearest of two candidate faces wins', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const hit = rayCastMesh(mesh, new TriangulationCache(), [0, 0, 10], [0, 0, -1])

    // The cube spans ±1; the far face at z = -1 must not shadow the near one.
    expect(hit).toBeDefined()
    expect(hit!.co[2]).toBeCloseTo(1, 6)
  })

  test('a ray through a hole misses, one through the material hits', () => {
    const mesh = holedQuad()
    const cache = new TriangulationCache()

    expect(rayCastMesh(mesh, cache, [0, 0, 5], [0, 0, -1])).toBeUndefined()

    const hit = rayCastMesh(mesh, cache, [1.5, 0, 5], [0, 0, -1])
    expect(hit).toBeDefined()
    expect(hit!.co[0]).toBeCloseTo(1.5, 6)
    expect(hit!.co[2]).toBeCloseTo(0, 6)
  })

  test('a non-unit direction still reports t in units of that direction', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    const hit = rayCastMesh(mesh, new TriangulationCache(), [0, 0, 4], [0, 0, -2])

    expect(hit!.t).toBeCloseTo(2, 6)
    expect(hit!.co[2]).toBeCloseTo(0, 6)
  })
})

describe('elementPoint', () => {
  test('a vertex reports its own position', () => {
    const mesh = new LeafMesh()
    const v = mesh.makeVert([1, 2, 3])
    const out: [number, number, number] = [0, 0, 0]

    expect(elementPoint(mesh, 'vert', v, out)).toBe(true)
    expect(out).toEqual([1, 2, 3])
  })

  test('an edge reports its midpoint', () => {
    const mesh = new LeafMesh()
    const a = mesh.makeVert([0, 0, 0])
    const b = mesh.makeVert([2, 4, 6])
    const e = mesh.makeEdge(a, b)
    const out: [number, number, number] = [0, 0, 0]

    expect(elementPoint(mesh, 'edge', e, out)).toBe(true)
    expect(out).toEqual([1, 2, 3])
  })

  test('a face reports its outer-ring centroid, ignoring the hole ring', () => {
    const mesh = holedQuad()
    const out: [number, number, number] = [0, 0, 0]

    // Both rings are centred on the origin, so shift the outer one and check
    // the answer follows it rather than averaging the two.
    for (const v of mesh.v) {
      mesh.v.co[v * 3] += 10
    }

    const f = [...mesh.f][0]
    expect(elementPoint(mesh, 'face', f, out)).toBe(true)
    expect(out[0]).toBeCloseTo(10, 6)
    expect(out[1]).toBeCloseTo(0, 6)
  })
})

describe('pickScreenCircle', () => {
  test('vertices inside the radius come back nearest first', () => {
    const mesh = new LeafMesh()
    mesh.makeVert([0, 0, 0])
    mesh.makeVert([0.1, 0, 0])
    mesh.makeVert([3, 0, 0])

    const hits = pickScreenCircle(mesh, project, ['vert'], 250, 250, 50)

    expect(hits.map((h) => h.index)).toEqual([0, 1])
    expect(hits[0].dis).toBeCloseTo(0, 6)
    expect(hits[1].dis).toBeCloseTo(10, 6)
  })

  test('faces are picked by centroid when the face domain is asked for', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    const faces = pickScreenCircle(mesh, project, ['face'], 250, 250, 5)
    expect(faces).toHaveLength(1)
    expect(faces[0].type).toBe('face')
  })

  test('several domains at once are all reported', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    const hits = pickScreenCircle(mesh, project, ['vert', 'edge', 'face'], 250, 250, 1000)
    const kinds = new Set(hits.map((h) => h.type))

    expect(kinds).toEqual(new Set(['vert', 'edge', 'face']))
  })

  test('candidates behind the eye are dropped, not mirrored', () => {
    const mesh = new LeafMesh()
    mesh.makeVert([0, 0, 0])
    mesh.makeVert([0, 0, 20])

    const hits = pickScreenCircle(mesh, project, ['vert'], 250, 250, 50)

    expect(hits).toHaveLength(1)
    expect(hits[0].index).toBe(0)
  })

  test('an empty mesh yields no candidates rather than throwing', () => {
    expect(pickScreenCircle(new LeafMesh(), project, ['vert', 'edge', 'face'], 0, 0, 100)).toEqual([])
  })
})

describe('pickScreenRect', () => {
  test('only elements inside the rect are returned, ordered from its centre', () => {
    const mesh = new LeafMesh()
    mesh.makeVert([0, 0, 0]) // screen (250, 250) — the rect centre
    mesh.makeVert([0.5, 0, 0]) // screen (300, 250) — inside
    mesh.makeVert([5, 0, 0]) // screen (750, 250) — outside

    const hits = pickScreenRect(mesh, project, ['vert'], 200, 200, 350, 300)

    expect(hits.map((h) => h.index)).toEqual([0, 1])
    expect(hits[0].dis).toBeCloseTo(25, 6)
    expect(hits[1].dis).toBeCloseTo(25, 6)
  })

  test('a rect that contains nothing is empty, not undefined', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    expect(pickScreenRect(mesh, project, ['vert'], 0, 0, 10, 10)).toEqual([])
  })

  test('a face with a hole is picked once, by its outer ring', () => {
    const mesh = holedQuad()

    const hits = pickScreenRect(mesh, project, ['face'], 0, 0, 500, 500)

    expect(hits).toHaveLength(1)
    expect(hits[0].type).toBe('face')
  })
})

describe('nearestByDomain', () => {
  const cand = (type: PickCandidate['type'], index: number, dis: number, depth: number): PickCandidate => ({
    type,
    index,
    dis,
    depth,
    co: [0, 0, 0],
  })

  test('one winner per domain', () => {
    const best = nearestByDomain([cand('vert', 1, 5, 0), cand('edge', 2, 7, 0), cand('face', 3, 9, 0)])

    expect(best.get('vert')!.index).toBe(1)
    expect(best.get('edge')!.index).toBe(2)
    expect(best.get('face')!.index).toBe(3)
  })

  test('inside the tiebreak band the nearer candidate wins', () => {
    // The back vertex is 1 px closer to the cursor but far behind the front one.
    const best = nearestByDomain([cand('vert', 1, 4, 9), cand('vert', 2, 5, 1)])

    expect(best.get('vert')!.index).toBe(2)
  })

  test('outside the band the closer-to-cursor candidate wins regardless of depth', () => {
    const far = DEPTH_TIEBREAK_PX + 5
    const best = nearestByDomain([cand('vert', 1, 1, 9), cand('vert', 2, 1 + far, 0)])

    expect(best.get('vert')!.index).toBe(1)
  })

  test('the answer does not depend on arrival order', () => {
    const cands = [cand('vert', 1, 4, 9), cand('vert', 2, 5, 1), cand('vert', 3, 30, 0)]
    const forward = nearestByDomain(cands)
    const backward = nearestByDomain([...cands].reverse())

    expect(forward.get('vert')!.index).toBe(backward.get('vert')!.index)
    expect(forward.get('vert')!.index).toBe(2)
  })

  test('no candidates means no winners', () => {
    expect(nearestByDomain([]).size).toBe(0)
  })
})
