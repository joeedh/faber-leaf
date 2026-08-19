/**
 * LeafMesh subdivide and loop cut (P12 §4, step 6). `subdivide.ts` is pure, so
 * the tests are element counts and ring shapes. The cases that matter are the
 * ones §5 names: a subdivision runs per ring and so is indifferent to holes,
 * while a loop cut stops at a face with a hole rather than drawing a chord
 * across it.
 */

import {makeCube, makeGrid, makePlane, makeTube} from '../../../addons/builtin/leafmesh/src/primitives'
import {faceHoleCount, faceVerts} from '../../../addons/builtin/leafmesh/src/select_geom'
import {
  edgeRing,
  loopCut,
  loopCutEdges,
  subdivideEdges,
  subdivideFaces,
  subdivideSelection,
} from '../../../addons/builtin/leafmesh/src/subdivide'
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

function edgeAt(mesh: LeafMesh, a: Vec3, b: Vec3): number {
  return mesh.findEdge(vertAt(mesh, a), vertAt(mesh, b))
}

/** The ring of a face, in order, which is what names its own edges. */
function faceRingEdges(mesh: LeafMesh, f: number): number[] {
  const ring = mesh.loopVerts(mesh.f.l[f])
  return ring.map((v, i) => mesh.findEdge(v, ring[(i + 1) % ring.length]))
}

function holedFaces(mesh: LeafMesh): number[] {
  return [...mesh.f].filter((f) => faceHoleCount(mesh, f) === 1)
}

/** An edge of the tube's outer top ring: radius one, at the top. */
function outerTopEdge(mesh: LeafMesh): number {
  const on = (v: number): boolean =>
    Math.abs(Math.hypot(mesh.v.co[v * 3], mesh.v.co[v * 3 + 1]) - 1) < 1e-6 &&
    Math.abs(mesh.v.co[v * 3 + 2] - 0.5) < 1e-6

  return [...mesh.e].find((e) => on(mesh.e.v1[e]) && on(mesh.e.v2[e])) as number
}

describe('subdivide edges', () => {
  test('one edge gains one vertex and the faces on it grow', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)

    const out = subdivideEdges(mesh, [edgeAt(mesh, [1, 1, 1], [-1, 1, 1])])

    expect(out.verts.length).toBe(1)
    expect(counts(mesh)).toEqual({verts: before.verts + 1, edges: before.edges + 1, faces: before.faces})

    const sizes = [...mesh.f].map((f) => faceVerts(mesh, f).length)
    expect(sizes.filter((n) => n === 5).length).toBe(2)
    expect(sizes.filter((n) => n === 4).length).toBe(4)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('three cuts land evenly along the edge', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const out = subdivideEdges(mesh, [edgeAt(mesh, [1, 1, 1], [-1, 1, 1])], {cuts: 3})
    const xs = out.verts.map((v) => mesh.v.co[v * 3]).sort((a, b) => a - b)

    expect(xs.length).toBe(3)
    expect(xs[0]).toBeCloseTo(-0.5, 12)
    expect(xs[1]).toBeCloseTo(0, 12)
    expect(xs[2]).toBeCloseTo(0.5, 12)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('an edge of a hole ring subdivides like any other', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    const inner = (v: number): boolean =>
      Math.abs(Math.hypot(mesh.v.co[v * 3], mesh.v.co[v * 3 + 1]) - 0.5) < 1e-6 &&
      Math.abs(mesh.v.co[v * 3 + 2] - 0.5) < 1e-6
    const e = [...mesh.e].find((i) => inner(mesh.e.v1[i]) && inner(mesh.e.v2[i])) as number
    const before = holedFaces(mesh).map((f) => faceVerts(mesh, f).length)

    subdivideEdges(mesh, [e])

    const after = holedFaces(mesh).map((f) => faceVerts(mesh, f).length)
    expect(after.length).toBe(2)
    expect(after.reduce((a, b) => a + b, 0)).toBe(before.reduce((a, b) => a + b, 0) + 1)
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('subdivide faces', () => {
  test('a quad becomes four quads around a new centre', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)

    const out = subdivideFaces(mesh, [[...mesh.f][0]])

    expect(out.skipped).toEqual([])
    expect(out.faces.length).toBe(4)
    expect(out.faces.map((f) => faceVerts(mesh, f).length)).toEqual([4, 4, 4, 4])
    expect(counts(mesh)).toEqual({verts: before.verts + 5, edges: before.edges + 8, faces: before.faces + 3})
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('two faces sharing an edge cut it once between them', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)
    const e = edgeAt(mesh, [1, 1, 1], [-1, 1, 1])
    const both = [...mesh.edgeCorners(e)].map((c) => mesh.cornerFace(c))

    const out = subdivideFaces(mesh, both)

    expect(out.faces.length).toBe(8)
    expect(counts(mesh)).toEqual({verts: before.verts + 9, edges: before.edges + 15, faces: before.faces + 6})
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('the centre of a face with a hole would be outside it, so it is refused', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    const before = counts(mesh)
    const cap = holedFaces(mesh)[0]

    const out = subdivideFaces(mesh, [cap])

    expect(out.skipped).toEqual([cap])
    expect(out.faces).toEqual([])
    expect(counts(mesh)).toEqual(before)
  })

  test('a fully selected face is quad-split and a lone edge is only cut', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)
    const f = [...mesh.f][0]
    const own = faceRingEdges(mesh, f)
    const other = [...mesh.e].find((e) => !own.includes(e)) as number

    const out = subdivideSelection(mesh, [f], [...own, other])

    expect(out.faces.length).toBe(4)
    expect(counts(mesh)).toEqual({verts: before.verts + 6, edges: before.edges + 9, faces: before.faces + 3})
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('loop cut', () => {
  test('a cube ring closes and splits every face it crosses', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)
    const e = edgeAt(mesh, [1, 1, 1], [-1, 1, 1])

    expect(edgeRing(mesh, e)?.closed).toBe(true)
    const out = loopCut(mesh, e)

    expect(out.stopped).toEqual([])
    expect(out.edges.length).toBe(4)
    expect(out.verts.length).toBe(4)
    expect(out.faces.length).toBe(8)
    expect(counts(mesh)).toEqual({verts: before.verts + 4, edges: before.edges + 8, faces: before.faces + 4})
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a ring that runs off the mesh ends at the boundary', () => {
    const mesh = new LeafMesh()
    makeGrid(mesh, 3, 1)
    const before = counts(mesh)
    const e = edgeAt(mesh, [-0.5, -0.5, 0], [-0.5, 0.5, 0])

    const ring = edgeRing(mesh, e)
    expect(ring?.closed).toBe(false)
    expect(ring?.stopped).toEqual([])

    const out = loopCut(mesh, e)

    expect(out.edges.length).toBe(4)
    expect(out.faces.length).toBe(6)
    expect(counts(mesh)).toEqual({verts: before.verts + 4, edges: before.edges + 7, faces: before.faces + 3})
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a plane is cut in two', () => {
    const mesh = new LeafMesh()
    makePlane(mesh)

    const out = loopCut(mesh, [...mesh.e][0])

    expect(out.faces.length).toBe(2)
    expect(counts(mesh)).toEqual({verts: 6, edges: 7, faces: 2})
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('the ring stops at a face with a hole instead of cutting across it', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    const e = outerTopEdge(mesh)

    const out = loopCut(mesh, e)

    expect(out.stopped.length).toBe(2)
    for (const f of out.stopped) {
      expect(faceHoleCount(mesh, f)).toBe(1)
    }
    // One wall quad crossed, so one chord; the caps keep their holes.
    expect(out.edges.length).toBe(2)
    expect(out.faces.length).toBe(2)
    expect(holedFaces(mesh).length).toBe(2)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('selecting a whole ring cuts it once, not once per edge', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)
    const ring = edgeRing(mesh, edgeAt(mesh, [1, 1, 1], [-1, 1, 1])) as {edges: number[]}

    const out = loopCutEdges(mesh, ring.edges)

    expect(out.verts.length).toBe(4)
    expect(out.faces.length).toBe(8)
    expect(counts(mesh)).toEqual({verts: before.verts + 4, edges: before.edges + 8, faces: before.faces + 4})
    expect(mesh.validateAndRepair()).toBe(0)
  })
})
