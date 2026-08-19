/**
 * The transform bridge's geometry (P12 §6, step 3). `transform_geom.ts` decides
 * which vertices a transform moves and how far each one follows, without
 * touching `scripts/`, so proportional edit is checked here rather than by
 * dragging something in the viewport.
 */

import {Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {makeCube} from '../../../addons/builtin/leafmesh/src/primitives'
import {applySelection, ensureSelectFlags, flushSelection} from '../../../addons/builtin/leafmesh/src/select_geom'
import {LeafMesh} from '../../../addons/builtin/leafmesh/src/topo'
import type {Vec3} from '../../../addons/builtin/leafmesh/src/topo'
import {
  aabbOf,
  centroidOf,
  gatherMovableVerts,
  propagationDistances,
  snapshotBytes,
} from '../../../addons/builtin/leafmesh/src/transform_geom'
import type {NearVertQuery} from '../../../addons/builtin/leafmesh/src/transform_geom'

/** Five vertices in a row on X, one unit apart. */
function vertRow(n = 5): LeafMesh {
  const mesh = new LeafMesh()
  for (let i = 0; i < n; i++) {
    mesh.makeVert([i, 0, 0])
  }
  ensureSelectFlags(mesh, Domain.VERT)
  return mesh
}

/** The brute-force stand-in for the contract's `closestElements`. */
function bruteForce(mesh: LeafMesh, calls?: number[]): NearVertQuery {
  return (co: Readonly<Vec3>, radius: number) => {
    calls?.push(radius)
    const hits: number[] = []
    for (const v of mesh.v) {
      const d = Math.hypot(mesh.v.co[v * 3] - co[0], mesh.v.co[v * 3 + 1] - co[1], mesh.v.co[v * 3 + 2] - co[2])
      if (d <= radius) {
        hits.push(v)
      }
    }
    return hits
  }
}

describe('which vertices move', () => {
  test('the movable set is the selected vertices, with their positions', () => {
    const mesh = vertRow()
    applySelection(mesh, Domain.VERT, [1, 3], 'add')

    const {verts, co} = gatherMovableVerts(mesh)

    expect(Array.from(verts)).toEqual([1, 3])
    expect(Array.from(co)).toEqual([1, 0, 0, 3, 0, 0])
  })

  test('a face-mode selection reaches the vertex layer once flushed', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const face = [...mesh.f][0]

    applySelection(mesh, Domain.FACE, [face], 'add')
    flushSelection(mesh, Domain.FACE)

    expect(gatherMovableVerts(mesh).verts.length).toBe(4)
  })

  test('nothing selected means nothing to transform', () => {
    expect(gatherMovableVerts(vertRow()).verts.length).toBe(0)
    expect(gatherMovableVerts(new LeafMesh()).verts.length).toBe(0)
  })
})

describe('proportional edit', () => {
  test('each unselected vertex reports its distance to the nearest moving one', () => {
    const mesh = vertRow()
    applySelection(mesh, Domain.VERT, [0], 'add')

    const dists = propagationDistances(mesh, [0], 2.5, bruteForce(mesh))

    expect([...dists.keys()].sort((a, b) => a - b)).toEqual([1, 2])
    expect(dists.get(1)).toBeCloseTo(1, 12)
    expect(dists.get(2)).toBeCloseTo(2, 12)
  })

  test('two seeds each keep the nearer of the two distances', () => {
    const mesh = vertRow()
    applySelection(mesh, Domain.VERT, [0, 4], 'add')

    const dists = propagationDistances(mesh, [0, 4], 3, bruteForce(mesh))

    // Vertex 3 is 3 away from seed 0 but only 1 from seed 4.
    expect(dists.get(3)).toBeCloseTo(1, 12)
    expect(dists.get(2)).toBeCloseTo(2, 12)
  })

  test('the moving vertices are absent — they follow at full weight already', () => {
    const mesh = vertRow()
    applySelection(mesh, Domain.VERT, [0, 1], 'add')

    const dists = propagationDistances(mesh, [0, 1], 10, bruteForce(mesh))

    expect(dists.has(0)).toBe(false)
    expect(dists.has(1)).toBe(false)
    expect(dists.has(2)).toBe(true)
  })

  test('the radius is a hard cut, whatever the query hands back', () => {
    const mesh = vertRow()
    applySelection(mesh, Domain.VERT, [0], 'add')

    // A query that ignores the radius must not widen the result.
    const everything: NearVertQuery = () => [...mesh.v]
    expect([...propagationDistances(mesh, [0], 1.5, everything).keys()]).toEqual([1])

    expect(propagationDistances(mesh, [0], 0, bruteForce(mesh)).size).toBe(0)
  })

  test('the query is what is consulted, once per seed, at the given radius', () => {
    const mesh = vertRow()
    applySelection(mesh, Domain.VERT, [0, 4], 'add')

    const calls: number[] = []
    propagationDistances(mesh, [0, 4], 2, bruteForce(mesh, calls))

    expect(calls).toEqual([2, 2])
  })
})

describe('centre, bounds and undo cost', () => {
  test('the centroid and the bounds cover exactly the given vertices', () => {
    const mesh = vertRow()

    expect(centroidOf(mesh, [0, 4])).toEqual([2, 0, 0])
    expect(aabbOf(mesh, [1, 3])).toEqual([
      [1, 0, 0],
      [3, 0, 0],
    ])
  })

  test('an empty set has neither', () => {
    const mesh = vertRow()

    expect(centroidOf(mesh, [])).toBeUndefined()
    expect(aabbOf(mesh, [])).toBeUndefined()
  })

  test('a snapshot costs a handle plus three doubles per vertex', () => {
    expect(snapshotBytes(0)).toBe(0)
    expect(snapshotBytes(1)).toBe(4 + 24)
    expect(snapshotBytes(1000)).toBe(28000)
  })
})
