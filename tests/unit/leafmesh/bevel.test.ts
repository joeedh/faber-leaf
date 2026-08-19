/**
 * The LeafMesh bevels (P12 §4, step 5). `bevel.ts` is pure, so what a bevel
 * does to the topology is checked by counting elements and reading windings.
 * Every case ends on `validateAndRepair`, which is what proves the derived
 * winding rule rather than a normal test inside the tool.
 */

import {bevelEdges, bevelVerts} from '../../../addons/builtin/leafmesh/src/bevel'
import {makeCube, makePlane, makeTube, makeUVSphere} from '../../../addons/builtin/leafmesh/src/primitives'
import {faceHoleCount, faceVerts} from '../../../addons/builtin/leafmesh/src/select_geom'
import {LeafMesh} from '../../../addons/builtin/leafmesh/src/topo'
import type {Vec3} from '../../../addons/builtin/leafmesh/src/topo'

interface Counts {
  verts: number
  edges: number
  faces: number
}

function counts(mesh: LeafMesh): Counts {
  return {verts: mesh.v.array.count, edges: mesh.e.array.count, faces: mesh.f.array.count}
}

/** The vertex nearest `co` — how a fixture names the corner it wants. */
function vertAt(mesh: LeafMesh, co: Vec3): number {
  let best = -1
  let bestDist = Infinity

  for (const v of mesh.v) {
    const d = Math.hypot(mesh.v.co[v * 3] - co[0], mesh.v.co[v * 3 + 1] - co[1], mesh.v.co[v * 3 + 2] - co[2])
    if (d < bestDist) {
      bestDist = d
      best = v
    }
  }
  return best
}

function dist(mesh: LeafMesh, a: number, co: Vec3): number {
  return Math.hypot(mesh.v.co[a * 3] - co[0], mesh.v.co[a * 3 + 1] - co[1], mesh.v.co[a * 3 + 2] - co[2])
}

describe('vertex bevel', () => {
  test('a cube corner becomes a triangle', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)

    const out = bevelVerts(mesh, [vertAt(mesh, [1, 1, 1])], {amount: 0.5})

    expect(out.skipped).toEqual([])
    expect(out.verts.length).toBe(3)
    expect(out.faces.length).toBe(1)
    expect(faceVerts(mesh, out.faces[0]).length).toBe(3)
    expect(counts(mesh)).toEqual({verts: before.verts + 2, edges: before.edges + 3, faces: before.faces + 1})
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('each point sits the given distance along its own edge', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const corner: Vec3 = [1, 1, 1]

    const out = bevelVerts(mesh, [vertAt(mesh, corner)], {amount: 0.5})

    for (const p of out.verts) {
      expect(dist(mesh, p, corner)).toBeCloseTo(0.5, 12)
    }
  })

  test('an oversized amount stops at the midpoint of each edge', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const corner: Vec3 = [1, 1, 1]

    const out = bevelVerts(mesh, [vertAt(mesh, corner)], {amount: 10})

    // The cube's edges are two long, so half of one is one.
    for (const p of out.verts) {
      expect(dist(mesh, p, corner)).toBeCloseTo(1, 12)
    }
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('the faces that met at the corner each gained a vertex', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const out = bevelVerts(mesh, [vertAt(mesh, [1, 1, 1])], {amount: 0.5})
    const cap = new Set(out.faces)
    const sizes = [...mesh.f].filter((f) => !cap.has(f)).map((f) => faceVerts(mesh, f).length)

    expect(sizes.filter((n) => n === 5).length).toBe(3)
    expect(sizes.filter((n) => n === 4).length).toBe(3)
  })

  test('the cap faces out of the solid, not into it', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const out = bevelVerts(mesh, [vertAt(mesh, [1, 1, 1])], {amount: 0.5})
    const n = mesh.faceNormal(out.faces[0])

    expect(n[0] + n[1] + n[2]).toBeGreaterThan(0)
  })

  test('a corner of a face with a hole keeps the hole', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    const rim = vertAt(mesh, [1, 0, 0.5])

    const out = bevelVerts(mesh, [rim], {amount: 0.1})

    expect(out.skipped).toEqual([])
    expect([...mesh.f].filter((f) => faceHoleCount(mesh, f) === 1).length).toBe(2)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a vertex without a closed fan is refused, and nothing moves', () => {
    const mesh = new LeafMesh()
    makePlane(mesh)
    const before = counts(mesh)

    const out = bevelVerts(mesh, [...mesh.v], {amount: 0.1})

    expect(out.skipped.length).toBe(4)
    expect(out.faces).toEqual([])
    expect(counts(mesh)).toEqual(before)
  })
})

describe('edge bevel', () => {
  test('a cube edge becomes a quad, and needs no cap at either end', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)
    const e = mesh.findEdge(vertAt(mesh, [1, 1, 1]), vertAt(mesh, [-1, 1, 1]))

    const out = bevelEdges(mesh, [e], {amount: 0.25})

    expect(out.skipped).toEqual([])
    expect(out.verts.length).toBe(4)
    // Valence three at each end leaves a two-point arc, which the one face
    // between those points already spans — so the quad is the only new face.
    expect(out.faces.length).toBe(1)
    expect(faceVerts(mesh, out.faces[0]).length).toBe(4)
    expect(counts(mesh)).toEqual({verts: before.verts + 2, edges: before.edges + 3, faces: before.faces + 1})
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('the two faces along the edge stay quads and the two beside it grow', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const e = mesh.findEdge(vertAt(mesh, [1, 1, 1]), vertAt(mesh, [-1, 1, 1]))

    const out = bevelEdges(mesh, [e], {amount: 0.25})
    const made = new Set(out.faces)
    const sizes = [...mesh.f].filter((f) => !made.has(f)).map((f) => faceVerts(mesh, f).length)

    expect(sizes.filter((n) => n === 5).length).toBe(2)
    expect(sizes.filter((n) => n === 4).length).toBe(4)
  })

  test('an end with more than three edges gets a cap', () => {
    const mesh = new LeafMesh()
    makeUVSphere(mesh, 8, 4)

    const valence = (v: number): number => [...mesh.vertEdges(v)].length
    const e = [...mesh.e].find((i) => valence(mesh.e.v1[i]) === 4 && valence(mesh.e.v2[i]) === 4) as number
    expect(e).toBeDefined()

    const out = bevelEdges(mesh, [e], {amount: 0.1})

    // The quad, plus a triangular cap over each three-point arc.
    expect(out.skipped).toEqual([])
    expect(out.faces.length).toBe(3)
    expect(out.faces.map((f) => faceVerts(mesh, f).length).sort()).toEqual([3, 3, 4])
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('two selected edges sharing a vertex are refused, not folded', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)
    const corner = vertAt(mesh, [1, 1, 1])
    const chain = [...mesh.vertEdges(corner)].slice(0, 2)

    const out = bevelEdges(mesh, chain, {amount: 0.25})

    expect(out.skipped.sort()).toEqual(chain.sort())
    expect(out.faces).toEqual([])
    expect(counts(mesh)).toEqual(before)
  })

  test('a boundary edge is refused', () => {
    const mesh = new LeafMesh()
    makePlane(mesh)
    const before = counts(mesh)

    const out = bevelEdges(mesh, [...mesh.e], {amount: 0.1})

    expect(out.skipped.length).toBe(4)
    expect(counts(mesh)).toEqual(before)
  })
})
