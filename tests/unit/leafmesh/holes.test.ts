/**
 * The hole cases §5 of the plan names, one named test each (P12 §4, step 7),
 * plus the two properties the step asks for: the Euler–Poincaré count after
 * every op, and a model → save → load → model round trip.
 *
 * `V − E + F − H = 2(S − G)`, with `H` counting inner rings, holds for a closed
 * surface — so the cube's term is 2 and the tube's, being genus one, is 0. Only
 * the closed fixtures are held to it; a plane's boundary is not in the formula,
 * and split-off is the one op that opens a surface, so it is left out.
 */

import {bevelEdges, bevelVerts} from '../../../addons/builtin/leafmesh/src/bevel'
import {ELEM_NONE} from '../../../addons/builtin/leafmesh/src/elem_array'
import {extrudeFaceRegion, insetFaceRegion} from '../../../addons/builtin/leafmesh/src/modeling'
import {makeCube, makeTube} from '../../../addons/builtin/leafmesh/src/primitives'
import {faceHoleCount, faceVerts} from '../../../addons/builtin/leafmesh/src/select_geom'
import {deserializeLeafMesh, serializeLeafMesh} from '../../../addons/builtin/leafmesh/src/serialize'
import {loopCut, subdivideEdges, subdivideFaces} from '../../../addons/builtin/leafmesh/src/subdivide'
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

/** Every inner ring in the mesh — the `H` of the Euler–Poincaré count. */
function holeRings(mesh: LeafMesh): number {
  let n = 0
  for (const f of mesh.f) {
    n += faceHoleCount(mesh, f)
  }
  return n
}

function eulerTerm(mesh: LeafMesh): number {
  return mesh.v.array.count - mesh.e.array.count + mesh.f.array.count - holeRings(mesh)
}

function radius(mesh: LeafMesh, v: number): number {
  return Math.hypot(mesh.v.co[v * 3], mesh.v.co[v * 3 + 1])
}

/** The tube's upward-facing annular cap. */
function topCap(mesh: LeafMesh): number {
  return [...mesh.f].find((f) => faceHoleCount(mesh, f) === 1 && mesh.faceNormal(f)[2] > 0.9) as number
}

/** An edge of the tube's inner top ring — shared by the cap's hole and a wall. */
function innerTopEdge(mesh: LeafMesh): number {
  const on = (v: number): boolean =>
    Math.abs(radius(mesh, v) - 0.5) < 1e-6 && Math.abs(mesh.v.co[v * 3 + 2] - 0.5) < 1e-6

  return [...mesh.e].find((e) => on(mesh.e.v1[e]) && on(mesh.e.v2[e])) as number
}

function ringVerts(mesh: LeafMesh, f: number, which: number): number[] {
  const loops = [...mesh.faceLoops(f)]
  return mesh.loopVerts(loops[which])
}

/** A square ring in the z = 0 plane, counter-clockwise about +Z. */
function square(mesh: LeafMesh, r: number): number[] {
  const co: Vec3[] = [
    [-r, -r, 0],
    [r, -r, 0],
    [r, r, 0],
    [-r, r, 0],
  ]
  return co.map((p) => mesh.makeVert(p))
}

describe('§5 inset and extrude on a face with holes', () => {
  test('an extrude carries the hole ring up with the cap', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    const term = eulerTerm(mesh)

    const out = extrudeFaceRegion(mesh, [topCap(mesh)], {offset: 1})
    const cap = out.faces[0]

    expect(faceHoleCount(mesh, cap)).toBe(1)
    for (const v of faceVerts(mesh, cap)) {
      expect(mesh.v.co[v * 3 + 2]).toBeCloseTo(1.5, 12)
    }
    // The rim rose as one band, so the surface is still closed and genus one.
    expect(eulerTerm(mesh)).toBe(term)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('an inset moves the outer ring in and the hole ring out', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 16, 1, 0.5)
    const term = eulerTerm(mesh)

    const out = insetFaceRegion(mesh, [topCap(mesh)], {amount: 0.1})
    const cap = out.faces[0]

    expect(faceHoleCount(mesh, cap)).toBe(1)
    for (const v of ringVerts(mesh, cap, 0)) {
      expect(radius(mesh, v)).toBeLessThan(0.95)
    }
    for (const v of ringVerts(mesh, cap, 1)) {
      expect(radius(mesh, v)).toBeGreaterThan(0.55)
    }
    expect(eulerTerm(mesh)).toBe(term)
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('§5 face deletion adjacent to a hole', () => {
  test('a face beside a hole is dissolved into the hole ring', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    const before = counts(mesh)
    const term = eulerTerm(mesh)
    const e = innerTopEdge(mesh)
    const cap = topCap(mesh)
    const wall = [...mesh.edgeCorners(e)].map((c) => mesh.cornerFace(c)).find((f) => f !== cap) as number

    const nf = mesh.joinFaces(cap, wall, e)

    expect(nf).not.toBe(ELEM_NONE)
    // The hole absorbed the wall quad: eight ring vertices plus four, less the
    // two the dropped edge held in common.
    expect(faceHoleCount(mesh, nf)).toBe(1)
    expect(ringVerts(mesh, nf, 0).length).toBe(8)
    expect(ringVerts(mesh, nf, 1).length).toBe(10)
    expect(counts(mesh)).toEqual({verts: before.verts, edges: before.edges - 1, faces: before.faces - 1})
    expect(eulerTerm(mesh)).toBe(term)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a face that fills its hole shares more than one edge and is refused', () => {
    const mesh = new LeafMesh()
    const outer = square(mesh, 3)
    const hole = square(mesh, 1)
    const plate = mesh.makeFace([outer, hole])
    // Ring zero is counter-clockwise by definition, so the same order that came
    // back wound clockwise as a hole traverses the shared edges the other way.
    const filler = mesh.makeFace([hole])
    const before = counts(mesh)
    const e = mesh.findEdge(hole[0], hole[1])

    expect(mesh.joinFaces(plate, filler, e)).toBe(ELEM_NONE)
    expect(counts(mesh)).toEqual(before)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('two hole rings do not merge, because the result would have no outer ring', () => {
    // Only the rings matter here, so the two faces are allowed to overlap.
    const mesh = new LeafMesh()
    const hole = square(mesh, 1)
    const a = mesh.makeFace([square(mesh, 3), hole])
    const below = [mesh.makeVert([-1, -2, 0]), mesh.makeVert([1, -2, 0])]
    const b = mesh.makeFace([square(mesh, 6), [hole[0], hole[1], below[1], below[0]]])
    const before = counts(mesh)
    const e = mesh.findEdge(hole[0], hole[1])

    expect(faceHoleCount(mesh, a)).toBe(1)
    expect(faceHoleCount(mesh, b)).toBe(1)
    expect(mesh.joinFaces(a, b, e)).toBe(ELEM_NONE)
    expect(counts(mesh)).toEqual(before)
  })
})

describe('§5 loop cut across a hole', () => {
  test('the cut stops at the face with the hole and names it', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    const term = eulerTerm(mesh)
    const outerTop = (v: number): boolean =>
      Math.abs(radius(mesh, v) - 1) < 1e-6 && Math.abs(mesh.v.co[v * 3 + 2] - 0.5) < 1e-6
    const e = [...mesh.e].find((i) => outerTop(mesh.e.v1[i]) && outerTop(mesh.e.v2[i])) as number

    const out = loopCut(mesh, e)

    expect(out.stopped.length).toBe(2)
    for (const f of out.stopped) {
      expect(faceHoleCount(mesh, f)).toBe(1)
    }
    expect(eulerTerm(mesh)).toBe(term)
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('§5 subdivide runs per ring', () => {
  test('a hole ring subdivides exactly as the outer ring does', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    const term = eulerTerm(mesh)
    const cap = topCap(mesh)
    const outerRing = ringVerts(mesh, cap, 0).length
    const holeRing = ringVerts(mesh, cap, 1).length

    subdivideEdges(mesh, [innerTopEdge(mesh)])

    expect(faceHoleCount(mesh, cap)).toBe(1)
    expect(ringVerts(mesh, cap, 0).length).toBe(outerRing)
    expect(ringVerts(mesh, cap, 1).length).toBe(holeRing + 1)
    expect(eulerTerm(mesh)).toBe(term)
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('the Euler count survives every op', () => {
  test('a cube stays at two', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    expect(eulerTerm(mesh)).toBe(2)

    subdivideFaces(mesh, [[...mesh.f][0]])
    expect(eulerTerm(mesh)).toBe(2)

    loopCut(mesh, [...mesh.e][0])
    expect(eulerTerm(mesh)).toBe(2)

    bevelVerts(mesh, [[...mesh.v][0]], {amount: 0.1})
    expect(eulerTerm(mesh)).toBe(2)

    const flat = [...mesh.f].find((f) => faceVerts(mesh, f).length === 4) as number
    insetFaceRegion(mesh, [flat], {amount: 0.1})
    expect(eulerTerm(mesh)).toBe(2)

    extrudeFaceRegion(mesh, [[...mesh.f][1]], {offset: 0.5})
    expect(eulerTerm(mesh)).toBe(2)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a tube stays at zero, because it is genus one', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 8, 1, 0.5)
    expect(eulerTerm(mesh)).toBe(0)

    subdivideEdges(mesh, [innerTopEdge(mesh)])
    expect(eulerTerm(mesh)).toBe(0)

    const vertical = (i: number): boolean =>
      Math.abs(radius(mesh, mesh.e.v1[i]) - 1) < 1e-6 &&
      Math.abs(radius(mesh, mesh.e.v2[i]) - 1) < 1e-6 &&
      mesh.v.co[mesh.e.v1[i] * 3 + 2] !== mesh.v.co[mesh.e.v2[i] * 3 + 2]

    expect(bevelEdges(mesh, [[...mesh.e].find(vertical) as number], {amount: 0.05}).skipped).toEqual([])
    expect(eulerTerm(mesh)).toBe(0)

    extrudeFaceRegion(mesh, [topCap(mesh)], {offset: 0.5})
    expect(eulerTerm(mesh)).toBe(0)
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('model, save, load, model', () => {
  /** The same sequence of edits, so two meshes can be run through it apart. */
  function model(mesh: LeafMesh): void {
    extrudeFaceRegion(mesh, [[...mesh.f][0]], {offset: 0.5})
    subdivideFaces(mesh, [[...mesh.f][1]])
    loopCut(mesh, [...mesh.e][0])
  }

  test('a modelled mesh survives a round trip and goes on being modelled', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    model(mesh)

    const loaded = deserializeLeafMesh(serializeLeafMesh(mesh))

    expect(counts(loaded)).toEqual(counts(mesh))
    expect(eulerTerm(loaded)).toBe(eulerTerm(mesh))
    expect([...loaded.v.co.slice(0, loaded.v.array.count * 3)]).toEqual([...mesh.v.co.slice(0, mesh.v.array.count * 3)])
    expect(loaded.validateAndRepair()).toBe(0)

    const face = [...loaded.f].find((f) => faceVerts(loaded, f).length === 4) as number
    const same = [...mesh.f].find((f) => faceVerts(mesh, f).length === 4) as number
    insetFaceRegion(loaded, [face], {amount: 0.1})
    insetFaceRegion(mesh, [same], {amount: 0.1})

    expect(counts(loaded)).toEqual(counts(mesh))
    expect(loaded.validateAndRepair()).toBe(0)
  })
})
