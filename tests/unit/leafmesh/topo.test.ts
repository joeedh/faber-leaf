/**
 * LeafMesh topology: the Euler operators, canonical cycle ordering, holes and
 * winding, and the invariant that makes the derived half throwaway — after any
 * sequence of ops, `rebuildDerivedTopo()` must change nothing.
 */

import {AttrType, Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {ELEM_NONE, LeafMesh, type Vec3} from '../../../addons/builtin/leafmesh/src/topo'
import {makeCube, makeGrid, makePlane, makeTube, makeUVSphere} from '../../../addons/builtin/leafmesh/src/primitives'

function co(mesh: LeafMesh, v: number): Vec3 {
  return [mesh.v.co[v * 3], mesh.v.co[v * 3 + 1], mesh.v.co[v * 3 + 2]]
}

function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** Every disk and radial cycle runs ascending from its smallest member. */
function expectCanonicalCycles(mesh: LeafMesh): void {
  for (const v of mesh.v) {
    const edges = [...mesh.vertEdges(v)]
    expect(edges).toEqual([...edges].sort((a, b) => a - b))
    if (edges.length > 0) {
      expect(mesh.v.e[v]).toBe(edges[0])
    } else {
      expect(mesh.v.e[v]).toBe(ELEM_NONE)
    }
  }

  for (const e of mesh.e) {
    const corners = [...mesh.edgeCorners(e)]
    expect(corners).toEqual([...corners].sort((a, b) => a - b))
    if (corners.length > 0) {
      expect(mesh.e.c[e]).toBe(corners[0])
    } else {
      expect(mesh.e.c[e]).toBe(ELEM_NONE)
    }
  }
}

/** Everything `rebuildDerivedTopo()` is allowed to regenerate, flattened. */
function derivedSnapshot(mesh: LeafMesh): number[] {
  const out: number[] = []
  for (const v of mesh.v) {
    out.push(v, mesh.v.e[v])
  }
  for (const e of mesh.e) {
    out.push(e, mesh.e.c[e], mesh.e.d1n[e], mesh.e.d1p[e], mesh.e.d2n[e], mesh.e.d2p[e])
  }
  for (const c of mesh.c) {
    out.push(c, mesh.c.e[c], mesh.c.l[c], mesh.c.prev[c], mesh.c.radialNext[c], mesh.c.radialPrev[c])
  }
  for (const l of mesh.l) {
    out.push(l, mesh.l.size[l], mesh.l.f[l])
  }
  for (const f of mesh.f) {
    out.push(f, mesh.f.listCount[f])
  }
  return out
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** A deliberately messy mesh: creation, splitting and deletion interleaved. */
function randomMesh(seed: number, steps: number): LeafMesh {
  const mesh = new LeafMesh()
  const rng = makeRng(seed)
  const pick = (arr: number[]): number => arr[Math.floor(rng() * arr.length)]

  for (let i = 0; i < 10; i++) {
    mesh.makeVert([rng() * 4 - 2, rng() * 4 - 2, rng() * 4 - 2])
  }

  for (let step = 0; step < steps; step++) {
    const verts = [...mesh.v]
    const edges = [...mesh.e]
    const faces = [...mesh.f]
    const op = Math.floor(rng() * 12)

    if (op === 0 || verts.length < 6) {
      mesh.makeVert([rng() * 4 - 2, rng() * 4 - 2, rng() * 4 - 2])
    } else if (op <= 2) {
      mesh.makeEdge(pick(verts), pick(verts))
    } else if (op <= 6) {
      const pool = verts.slice()
      const ring: number[] = []
      const n = 3 + Math.floor(rng() * 3)
      while (ring.length < n && pool.length > 0) {
        ring.push(pool.splice(Math.floor(rng() * pool.length), 1)[0])
      }
      mesh.makeFace([ring])
    } else if (op === 7 && edges.length > 0) {
      mesh.splitEdge(pick(edges), 0.1 + rng() * 0.8)
    } else if (op === 8 && faces.length > 0) {
      mesh.killFace(pick(faces))
    } else if (op === 9 && edges.length > 0) {
      mesh.killEdge(pick(edges))
    } else if (op === 10) {
      mesh.killVert(pick(verts))
    } else if (edges.length > 0) {
      mesh.splitEdge(pick(edges), 0.5)
    }
  }

  return mesh
}

describe('LeafMesh Euler operators', () => {
  test('makeVert stores the position and bumps the stamp', () => {
    const mesh = new LeafMesh()
    const before = mesh.topoStamp
    const v = mesh.makeVert([1, 2, 3])

    expect(mesh.v.count).toBe(1)
    expect(co(mesh, v)).toEqual([1, 2, 3])
    expect(mesh.v.e[v]).toBe(ELEM_NONE)
    expect(mesh.topoStamp).toBeGreaterThan(before)
  })

  test('makeEdge reuses an existing edge instead of duplicating it', () => {
    const mesh = new LeafMesh()
    const a = mesh.makeVert([0, 0, 0])
    const b = mesh.makeVert([1, 0, 0])

    const e = mesh.makeEdge(a, b)
    expect(mesh.makeEdge(a, b)).toBe(e)
    expect(mesh.makeEdge(b, a)).toBe(e)
    expect(mesh.e.count).toBe(1)
    expect(mesh.findEdge(a, b)).toBe(e)
    expect(mesh.edgeOther(e, a)).toBe(b)
    expect(mesh.edgeFaceCount(e)).toBe(0)
  })

  test('makeEdge refuses self-loops and dead vertices', () => {
    const mesh = new LeafMesh()
    const a = mesh.makeVert([0, 0, 0])
    const b = mesh.makeVert([1, 0, 0])
    mesh.killVert(b)

    expect(mesh.makeEdge(a, a)).toBe(ELEM_NONE)
    expect(mesh.makeEdge(a, b)).toBe(ELEM_NONE)
    expect(mesh.e.count).toBe(0)
  })

  test('makeFace rejects rings that are too short, repeat, or are dead', () => {
    const mesh = new LeafMesh()
    const v = [0, 1, 2, 3].map((i) => mesh.makeVert([i, 0, 0]))

    expect(mesh.makeFace([])).toBe(ELEM_NONE)
    expect(mesh.makeFace([[v[0], v[1]]])).toBe(ELEM_NONE)
    expect(mesh.makeFace([[v[0], v[1], v[0]]])).toBe(ELEM_NONE)
    expect(mesh.makeFace([[v[0], v[1], 999]])).toBe(ELEM_NONE)
    expect(mesh.f.count).toBe(0)
    expect(mesh.l.count).toBe(0)
    expect(mesh.c.count).toBe(0)
  })

  test('a quad wires up loops, corners, edges and radials', () => {
    const mesh = new LeafMesh()
    const {faces} = makePlane(mesh, 2)
    const f = faces[0]

    expect(mesh.v.count).toBe(4)
    expect(mesh.e.count).toBe(4)
    expect(mesh.c.count).toBe(4)
    expect(mesh.l.count).toBe(1)
    expect(mesh.f.listCount[f]).toBe(1)

    const l = mesh.f.l[f]
    expect(mesh.l.size[l]).toBe(4)
    expect(mesh.l.f[l]).toBe(f)
    expect(mesh.l.next[l]).toBe(ELEM_NONE)

    for (const c of mesh.loopCorners(l)) {
      expect(mesh.c.l[c]).toBe(l)
      expect(mesh.cornerFace(c)).toBe(f)
      expect(mesh.c.prev[mesh.c.next[c]]).toBe(c)
      const e = mesh.c.e[c]
      expect(mesh.findEdge(mesh.c.v[c], mesh.c.v[mesh.c.next[c]])).toBe(e)
      expect(mesh.edgeFaceCount(e)).toBe(1)
    }
    expectCanonicalCycles(mesh)
  })

  test('a cube closes: 8/12/6, every edge manifold, every normal outward', () => {
    const mesh = new LeafMesh()
    const {faces} = makeCube(mesh, 2)

    expect(mesh.v.count).toBe(8)
    expect(mesh.e.count).toBe(12)
    expect(mesh.f.count).toBe(6)
    expect(mesh.c.count).toBe(24)
    expect(mesh.l.count).toBe(6)

    for (const e of mesh.e) {
      expect(mesh.edgeFaceCount(e)).toBe(2)
    }

    for (const f of faces) {
      const normal = mesh.faceNormal(f)
      const ring = mesh.loopVerts(mesh.f.l[f])
      const centroid: Vec3 = [0, 0, 0]
      for (const v of ring) {
        const p = co(mesh, v)
        centroid[0] += p[0] / ring.length
        centroid[1] += p[1] / ring.length
        centroid[2] += p[2] / ring.length
      }
      // Centred on the origin, so outward means the normal agrees with the centroid.
      expect(dot(normal, centroid)).toBeGreaterThan(0)
      expect(mesh.ringSignedArea(ring, normal)).toBeGreaterThan(0)
    }
    expectCanonicalCycles(mesh)
  })

  test('a grid distinguishes boundary edges from interior ones', () => {
    const mesh = new LeafMesh()
    makeGrid(mesh, 2, 2, 2)

    expect(mesh.f.count).toBe(4)
    expect(mesh.v.count).toBe(9)
    expect(mesh.e.count).toBe(12)

    let boundary = 0
    let interior = 0
    for (const e of mesh.e) {
      const n = mesh.edgeFaceCount(e)
      expect(n === 1 || n === 2).toBe(true)
      if (n === 1) {
        boundary++
      } else {
        interior++
      }
    }
    expect(boundary).toBe(8)
    expect(interior).toBe(4)
    expectCanonicalCycles(mesh)
  })

  test('a UV sphere is closed and manifold', () => {
    const mesh = new LeafMesh()
    makeUVSphere(mesh, 8, 4, 1)

    for (const e of mesh.e) {
      expect(mesh.edgeFaceCount(e)).toBe(2)
    }
    expect(mesh.validateAndRepair()).toBe(0)
    expectCanonicalCycles(mesh)
  })

  test('non-manifold is legal: three faces on one edge', () => {
    const mesh = new LeafMesh()
    const a = mesh.makeVert([0, 0, 0])
    const b = mesh.makeVert([1, 0, 0])
    const fan = [mesh.makeVert([0.5, 1, 0]), mesh.makeVert([0.5, -1, 0]), mesh.makeVert([0.5, 0, 1])]

    for (const t of fan) {
      mesh.makeFace([[a, b, t]])
    }

    const e = mesh.findEdge(a, b)
    expect(e).not.toBe(ELEM_NONE)
    expect(mesh.edgeFaceCount(e)).toBe(3)
    expect(mesh.f.count).toBe(3)
    expect(mesh.validateAndRepair()).toBe(0)
    expectCanonicalCycles(mesh)
  })
})

describe('LeafMesh holes and winding', () => {
  function squareWithHole(mesh: LeafMesh, reverseHole: boolean): {f: number; outer: number[]; hole: number[]} {
    const outer = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ].map(([x, y]) => mesh.makeVert([x, y, 0]))
    const hole = [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ].map(([x, y]) => mesh.makeVert([x, y, 0]))
    if (reverseHole) {
      hole.reverse()
    }
    return {f: mesh.makeFace([outer, hole]), outer, hole}
  }

  test('a hole becomes its own loop, wound against the face normal', () => {
    for (const reverseHole of [false, true]) {
      const mesh = new LeafMesh()
      const {f, outer} = squareWithHole(mesh, reverseHole)

      expect(f).not.toBe(ELEM_NONE)
      expect(mesh.f.listCount[f]).toBe(2)
      expect([...mesh.faceLoops(f)].length).toBe(2)

      const normal = mesh.faceNormal(f)
      expect(normal[2]).toBeCloseTo(1)

      const [outerLoop, holeLoop] = [...mesh.faceLoops(f)]
      // The outer ring is CCW by definition — Newell over it *is* the normal.
      expect(mesh.loopVerts(outerLoop)).toEqual(outer)
      expect(mesh.ringSignedArea(mesh.loopVerts(outerLoop), normal)).toBeGreaterThan(0)
      expect(mesh.ringSignedArea(mesh.loopVerts(holeLoop), normal)).toBeLessThan(0)
    }
  })

  test('addFaceLoop appends a hole and removeFaceLoop takes it back', () => {
    const mesh = new LeafMesh()
    const outer = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ].map(([x, y]) => mesh.makeVert([x, y, 0]))
    const f = mesh.makeFace([outer])
    const hole = [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ].map(([x, y]) => mesh.makeVert([x, y, 0]))

    const l = mesh.addFaceLoop(f, hole)
    expect(l).not.toBe(ELEM_NONE)
    expect(mesh.f.listCount[f]).toBe(2)
    expect(mesh.ringSignedArea(mesh.loopVerts(l), mesh.faceNormal(f))).toBeLessThan(0)

    // The outer ring is not removable; kill the face for that.
    expect(mesh.removeFaceLoop(f, mesh.f.l[f])).toBe(false)
    expect(mesh.removeFaceLoop(f, l)).toBe(true)
    expect(mesh.f.listCount[f]).toBe(1)
    expect([...mesh.faceLoops(f)].length).toBe(1)
    expect(mesh.c.count).toBe(4)
  })

  test('fixWinding leaves a correctly built face alone', () => {
    const mesh = new LeafMesh()
    const {f} = squareWithHole(mesh, false)
    const stamp = mesh.topoStamp

    expect(mesh.fixWinding(f)).toBe(0)
    expect(mesh.topoStamp).toBe(stamp)
  })

  test('fixWinding reverses a hole whose face normal flipped under it', () => {
    const mesh = new LeafMesh()
    const {f, outer} = squareWithHole(mesh, false)
    const holeLoop = mesh.l.next[mesh.f.l[f]]
    const before = mesh.loopVerts(holeLoop)

    // Mirror the outer ring only. Nothing topological changed, but the face
    // normal is now -Z and the stored hole reads counter-clockwise about it —
    // the state an importer or a mirroring modifier leaves behind.
    for (const v of outer) {
      mesh.v.co[v * 3 + 1] = -mesh.v.co[v * 3 + 1]
    }
    expect(mesh.faceNormal(f)[2]).toBeCloseTo(-1)

    expect(mesh.fixWinding(f)).toBe(1)
    const after = mesh.loopVerts(holeLoop)
    expect(after).toEqual([before[0], ...before.slice(1).reverse()])
    expect(mesh.ringSignedArea(after, mesh.faceNormal(f))).toBeLessThan(0)
    // The outer ring was never touched.
    expect(mesh.loopVerts(mesh.f.l[f])).toEqual(outer)
    expectCanonicalCycles(mesh)
  })

  test('a tube cap is a real face with a hole', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5, 1)

    const caps = [...mesh.f].filter((f) => mesh.f.listCount[f] === 2)
    expect(caps.length).toBe(2)
    for (const f of caps) {
      const normal = mesh.faceNormal(f)
      const [outerLoop, holeLoop] = [...mesh.faceLoops(f)]
      expect(mesh.ringSignedArea(mesh.loopVerts(outerLoop), normal)).toBeGreaterThan(0)
      expect(mesh.ringSignedArea(mesh.loopVerts(holeLoop), normal)).toBeLessThan(0)
    }
    expect(mesh.validateAndRepair()).toBe(0)
    expectCanonicalCycles(mesh)
  })
})

describe('LeafMesh splitEdge', () => {
  test('inserts a vertex and a corner in every face on the edge', () => {
    const mesh = new LeafMesh()
    const {faces} = makeGrid(mesh, 2, 1, 2)
    const shared = [...mesh.e].find((e) => mesh.edgeFaceCount(e) === 2) as number

    const result = mesh.splitEdge(shared, 0.5)
    expect(result).not.toBeNull()
    const {vert, edge} = result as {vert: number; edge: number}

    expect(mesh.v.count).toBe(7)
    expect(mesh.e.count).toBe(8)
    expect(mesh.c.count).toBe(10)
    expect(mesh.edgeFaceCount(shared)).toBe(2)
    expect(mesh.edgeFaceCount(edge)).toBe(2)
    expect([...mesh.vertEdges(vert)].length).toBe(2)

    for (const f of faces) {
      expect(mesh.l.size[mesh.f.l[f]]).toBe(5)
      expect([...mesh.loopCorners(mesh.f.l[f])].length).toBe(5)
    }
    expect(mesh.validateAndRepair()).toBe(0)
    expectCanonicalCycles(mesh)
  })

  test('places the new vertex at the split parameter', () => {
    const mesh = new LeafMesh()
    const a = mesh.makeVert([0, 0, 0])
    const b = mesh.makeVert([10, 0, 0])
    const e = mesh.makeEdge(a, b)

    const {vert} = mesh.splitEdge(e, 0.25) as {vert: number}
    expect(co(mesh, vert)[0]).toBeCloseTo(2.5)
    expect(mesh.e.count).toBe(2)
    expect(mesh.findEdge(a, vert)).toBe(e)
  })

  test('interpolates vertex and corner attributes', () => {
    const mesh = new LeafMesh()
    const weight = mesh.attrs.add(Domain.VERT, 'weight', AttrType.Float)
    const uv = mesh.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)

    const {faces} = makePlane(mesh, 2)
    const f = faces[0]
    const l = mesh.f.l[f]
    const corners = [...mesh.loopCorners(l)]
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i]
      weight.column.data[mesh.c.v[c]] = i
      uv.column.data[c * 2] = i
      uv.column.data[c * 2 + 1] = i * 2
    }

    const c0 = corners[0]
    const e = mesh.c.e[c0]
    const {vert} = mesh.splitEdge(e, 0.5) as {vert: number}

    expect(weight.column.data[vert]).toBeCloseTo(0.5)

    const nc = [...mesh.loopCorners(l)].find((c) => mesh.c.v[c] === vert) as number
    expect(nc).not.toBeUndefined()
    expect(uv.column.data[nc * 2]).toBeCloseTo(0.5)
    expect(uv.column.data[nc * 2 + 1]).toBeCloseTo(1)
  })

  test('refuses a dead edge', () => {
    const mesh = new LeafMesh()
    expect(mesh.splitEdge(0, 0.5)).toBeNull()
  })
})

describe('LeafMesh joinFaces', () => {
  test('merges two quads into a hexagon and drops the shared edge', () => {
    const mesh = new LeafMesh()
    const {faces} = makeGrid(mesh, 2, 1, 2)
    const shared = [...mesh.e].find((e) => mesh.edgeFaceCount(e) === 2) as number

    const nf = mesh.joinFaces(faces[0], faces[1], shared)
    expect(nf).not.toBe(ELEM_NONE)
    expect(mesh.f.count).toBe(1)
    expect(mesh.l.count).toBe(1)
    expect(mesh.c.count).toBe(6)
    expect(mesh.e.count).toBe(6)
    expect(mesh.e.has(shared)).toBe(false)
    expect(mesh.l.size[mesh.f.l[nf]]).toBe(6)

    for (const e of mesh.e) {
      expect(mesh.edgeFaceCount(e)).toBe(1)
    }
    expect(mesh.validateAndRepair()).toBe(0)
    expectCanonicalCycles(mesh)
  })

  test('carries face and corner attributes across the merge', () => {
    const mesh = new LeafMesh()
    const material = mesh.attrs.add(Domain.FACE, 'material', AttrType.Int)
    const uv = mesh.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)

    const {faces} = makeGrid(mesh, 2, 1, 2)
    material.column.data[faces[0]] = 5
    const wanted = new Map<number, number>()
    for (const f of faces) {
      for (const c of mesh.loopCorners(mesh.f.l[f])) {
        const x = mesh.v.co[mesh.c.v[c] * 3]
        uv.column.data[c * 2] = x
        wanted.set(mesh.c.v[c], x)
      }
    }

    const shared = [...mesh.e].find((e) => mesh.edgeFaceCount(e) === 2) as number
    const nf = mesh.joinFaces(faces[0], faces[1], shared)

    expect(material.column.data[nf]).toBe(5)
    for (const c of mesh.loopCorners(mesh.f.l[nf])) {
      expect(uv.column.data[c * 2]).toBeCloseTo(wanted.get(mesh.c.v[c]) as number)
    }
  })

  test('refuses faces that do not both border the edge', () => {
    const mesh = new LeafMesh()
    const {faces} = makeGrid(mesh, 3, 1, 3)
    const shared = [...mesh.e].find((e) => mesh.edgeFaceCount(e) === 2) as number

    expect(mesh.joinFaces(faces[0], faces[0], shared)).toBe(ELEM_NONE)
    expect(mesh.joinFaces(faces[0], faces[2], shared)).toBe(ELEM_NONE)
    // A boundary edge has one corner, not two.
    const boundary = [...mesh.e].find((e) => mesh.edgeFaceCount(e) === 1) as number
    expect(mesh.joinFaces(faces[0], faces[1], boundary)).toBe(ELEM_NONE)
    expect(mesh.f.count).toBe(3)
  })
})

describe('LeafMesh deletion', () => {
  test('killFace leaves its perimeter as wire edges', () => {
    const mesh = new LeafMesh()
    const {faces} = makePlane(mesh, 2)

    mesh.killFace(faces[0])
    expect(mesh.f.count).toBe(0)
    expect(mesh.l.count).toBe(0)
    expect(mesh.c.count).toBe(0)
    expect(mesh.e.count).toBe(4)
    expect(mesh.v.count).toBe(4)
    for (const e of mesh.e) {
      expect(mesh.edgeFaceCount(e)).toBe(0)
    }
  })

  test('killEdge takes every face on it', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const e = [...mesh.e][0]

    mesh.killEdge(e)
    expect(mesh.f.count).toBe(4)
    expect(mesh.e.count).toBe(11)
    expect(mesh.v.count).toBe(8)
    expect(mesh.c.count).toBe(16)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('killVert takes its whole disk', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const v = [...mesh.v][0]

    mesh.killVert(v)
    expect(mesh.v.count).toBe(7)
    expect(mesh.e.count).toBe(9)
    expect(mesh.f.count).toBe(3)
    expect(mesh.validateAndRepair()).toBe(0)
    expectCanonicalCycles(mesh)
  })

  test('killing is idempotent', () => {
    const mesh = new LeafMesh()
    const {faces} = makePlane(mesh, 2)

    mesh.killFace(faces[0])
    mesh.killFace(faces[0])
    expect(mesh.f.count).toBe(0)
    mesh.killVert(9999)
    mesh.killEdge(9999)
  })
})

describe('LeafMesh validateAndRepair', () => {
  test('reports nothing on a healthy mesh', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    expect(mesh.validateAndRepair()).toBe(0)
    expect(mesh.repairLog).toEqual([])
  })

  test('recreates an edge a face ring implies but that went missing', () => {
    const mesh = new LeafMesh()
    const {faces} = makePlane(mesh, 2)
    const e = mesh.c.e[mesh.l.c[mesh.f.l[faces[0]]]]

    // Drop the edge behind the mesh's back, as a corrupt file would.
    mesh.e.array.free(e)
    expect(mesh.e.count).toBe(3)

    expect(mesh.validateAndRepair()).toBe(1)
    expect(mesh.repairLog[0]).toMatch(/created 1 missing edge/)
    expect(mesh.e.count).toBe(4)
    expect(mesh.f.count).toBe(1)
    expectCanonicalCycles(mesh)
  })

  test('reports a broken face and keeps it rather than deleting it', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const f = [...mesh.f][0]
    mesh.c.next[mesh.l.c[mesh.f.l[f]]] = ELEM_NONE

    expect(mesh.validateAndRepair()).toBe(1)
    expect(mesh.repairLog[0]).toMatch(new RegExp(`face ${f}`))
    expect(mesh.f.count).toBe(6)
    expect(mesh.f.has(f)).toBe(true)
  })

  test('reports an edge left pointing at a dead vertex', () => {
    const mesh = new LeafMesh()
    const a = mesh.makeVert([0, 0, 0])
    const b = mesh.makeVert([1, 0, 0])
    mesh.makeEdge(a, b)
    mesh.v.array.free(b)

    expect(mesh.validateAndRepair()).toBe(1)
    expect(mesh.repairLog[0]).toMatch(/dead vertex/)
  })
})

describe('LeafMesh derived-state invariant', () => {
  test('rebuildDerivedTopo is a no-op on a primitive', () => {
    const builders: [(mesh: LeafMesh) => void][] = [
      (mesh) => makeCube(mesh, 2),
      (mesh) => makeUVSphere(mesh, 8, 4, 1),
      (mesh) => makeTube(mesh, 8, 1, 0.5, 1),
      (mesh) => makeGrid(mesh, 3, 3, 3),
    ]

    for (const build of builders) {
      const mesh = new LeafMesh()
      build(mesh)

      const before = derivedSnapshot(mesh)
      expect(mesh.rebuildDerivedTopo()).toBe(0)
      expect(derivedSnapshot(mesh)).toEqual(before)
    }
  })

  test('rebuildDerivedTopo is a no-op after a random op sequence', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const mesh = randomMesh(seed, 160)

      // The sequence has to actually build something, or this proves nothing.
      expect(mesh.f.count).toBeGreaterThan(0)
      expectCanonicalCycles(mesh)

      const before = derivedSnapshot(mesh)
      expect(mesh.rebuildDerivedTopo()).toBe(0)
      expect(derivedSnapshot(mesh)).toEqual(before)
      expect(mesh.validateAndRepair()).toBe(0)
    }
  })

  test('a rebuild after wiping the derived half restores it exactly', () => {
    const mesh = randomMesh(7, 120)
    const before = derivedSnapshot(mesh)

    for (const v of mesh.v) {
      mesh.v.e[v] = ELEM_NONE
    }
    for (const c of mesh.c) {
      mesh.c.radialNext[c] = ELEM_NONE
      mesh.c.radialPrev[c] = ELEM_NONE
      mesh.c.prev[c] = ELEM_NONE
      mesh.c.e[c] = ELEM_NONE
    }
    for (const l of mesh.l) {
      mesh.l.size[l] = 0
      mesh.l.f[l] = ELEM_NONE
    }

    expect(mesh.rebuildDerivedTopo()).toBe(0)
    expect(derivedSnapshot(mesh)).toEqual(before)
  })
})
