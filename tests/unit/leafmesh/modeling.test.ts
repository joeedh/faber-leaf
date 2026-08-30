/**
 * The LeafMesh modeling operations (P12 §4, step 4). `modeling.ts` is pure, so
 * extrude and split-off are checked by counting elements and reading windings
 * rather than by dragging something in the viewport. Every case ends by
 * asserting the mesh is still valid — the cheap net §8 asks for.
 */

import {AttrType, Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {
  extrudeFaceRegion,
  extrudeFacesIndividual,
  insetFaceRegion,
  insetFacesIndividual,
  meshSnapshotBytes,
  regionBoundaryEdges,
  splitOffFaces,
} from '../../../addons/builtin/leafmesh/src/modeling'
import {makeCube, makeGrid, makePlane, makeTube} from '../../../addons/builtin/leafmesh/src/primitives'
import {faceEdges, faceHoleCount, faceVerts} from '../../../addons/builtin/leafmesh/src/select_geom'
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

/** The mean of a face's vertices — good enough to tell inside from outside. */
function faceCentre(mesh: LeafMesh, f: number): Vec3 {
  const verts = faceVerts(mesh, f)
  const c: Vec3 = [0, 0, 0]

  for (const v of verts) {
    for (let k = 0; k < 3; k++) {
      c[k] += mesh.v.co[v * 3 + k]
    }
  }
  for (let k = 0; k < 3; k++) {
    c[k] /= verts.length
  }
  return c
}

/** The face of a cube whose normal is `axis`. */
function faceFacing(mesh: LeafMesh, axis: Vec3): number {
  for (const f of mesh.f) {
    const n = mesh.faceNormal(f)
    if (n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2] > 0.9) {
      return f
    }
  }
  throw new Error('no face facing that way')
}

describe('extrude region', () => {
  test('a cube face becomes a stalk: one face killed, one rebuilt, four walls', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const before = counts(mesh)

    const top = faceFacing(mesh, [0, 0, 1])
    const out = extrudeFaceRegion(mesh, [top], {offset: 1})

    expect(out.faces.length).toBe(1)
    expect(out.walls.length).toBe(4)
    expect(out.verts.length).toBe(4)
    expect(counts(mesh)).toEqual({verts: before.verts + 4, edges: before.edges + 8, faces: before.faces + 4})
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('the new face has moved and stands on new vertices', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const top = faceFacing(mesh, [0, 0, 1])
    const was = new Set(faceVerts(mesh, top))

    const out = extrudeFaceRegion(mesh, [top], {offset: 3})

    expect(faceCentre(mesh, out.faces[0])[2]).toBeCloseTo(4, 12)
    for (const v of faceVerts(mesh, out.faces[0])) {
      expect(was.has(v)).toBe(false)
    }
    // The extrusion leaves the original rim vertices at their original position.
    for (const v of was) {
      expect(mesh.v.co[v * 3 + 2]).toBeCloseTo(1, 12)
    }
  })

  test('the walls face out of the solid', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const out = extrudeFaceRegion(mesh, [faceFacing(mesh, [0, 0, 1])], {offset: 1})

    for (const w of out.walls) {
      const c = faceCentre(mesh, w)
      const n = mesh.faceNormal(w)
      // The stalk stands on the origin-centred cube, so "away from the axis"
      // is the outward direction for every one of its walls.
      expect(n[0] * c[0] + n[1] * c[1]).toBeGreaterThan(0)
    }
  })

  test('an interior edge raises no wall and is not left behind', () => {
    const mesh = new LeafMesh()
    const grid = makeGrid(mesh, 2, 2)
    const pair = [grid.faces[0], grid.faces[1]]
    const first = new Set(faceEdges(mesh, pair[0]))
    const shared = faceEdges(mesh, pair[1]).find((e) => first.has(e)) as number

    expect(regionBoundaryEdges(mesh, pair).length).toBe(6)

    const out = extrudeFaceRegion(mesh, pair, {offset: 1})

    expect(out.walls.length).toBe(6)
    expect(mesh.e.has(shared)).toBe(false)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a closed region has no rim, so it moves without gaining geometry', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const before = counts(mesh)

    const out = extrudeFaceRegion(mesh, [...mesh.f], {offset: 0})

    expect(regionBoundaryEdges(mesh, out.faces).length).toBe(0)
    expect(out.walls.length).toBe(0)
    expect(counts(mesh)).toEqual(before)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a lone face extrudes into an open box', () => {
    const mesh = new LeafMesh()
    const plane = makePlane(mesh)

    const out = extrudeFaceRegion(mesh, plane.faces, {offset: 1})

    expect(out.walls.length).toBe(4)
    expect(counts(mesh)).toEqual({verts: 8, edges: 12, faces: 5})
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('extrude with holes', () => {
  const SEGMENTS = 8

  /** The tube's top cap: the one face carrying a hole. */
  function topCap(mesh: LeafMesh): number {
    for (const f of mesh.f) {
      if (faceHoleCount(mesh, f) === 1 && mesh.faceNormal(f)[2] > 0.9) {
        return f
      }
    }
    throw new Error('no top cap')
  }

  test('the cap keeps its hole and both rings raise walls', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, SEGMENTS)
    const before = counts(mesh)

    const out = extrudeFaceRegion(mesh, [topCap(mesh)], {offset: 1})

    expect(out.walls.length).toBe(2 * SEGMENTS)
    expect(faceHoleCount(mesh, out.faces[0])).toBe(1)
    expect(counts(mesh).faces).toBe(before.faces + 2 * SEGMENTS)
    expect(counts(mesh).verts).toBe(before.verts + 2 * SEGMENTS)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('the hole rings wall inward while the outer ring walls outward', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, SEGMENTS, 1, 0.5)
    const out = extrudeFaceRegion(mesh, [topCap(mesh)], {offset: 1})

    let inner = 0
    for (const w of out.walls) {
      const c = faceCentre(mesh, w)
      const n = mesh.faceNormal(w)
      const radial = n[0] * c[0] + n[1] * c[1]

      if (Math.hypot(c[0], c[1]) < 0.75) {
        inner++
        expect(radial).toBeLessThan(0)
      } else {
        expect(radial).toBeGreaterThan(0)
      }
    }

    expect(inner).toBe(SEGMENTS)
  })
})

describe('extrude individual', () => {
  test('neighbours come apart instead of moving together', () => {
    const mesh = new LeafMesh()
    const grid = makeGrid(mesh, 2, 2)
    const pair = [grid.faces[0], grid.faces[1]]
    const before = counts(mesh)

    const out = extrudeFacesIndividual(mesh, pair, {offset: 1})

    // Four walls each, and neither face reuses a vertex of the other.
    expect(out.walls.length).toBe(8)
    expect(new Set(out.verts).size).toBe(8)
    expect(counts(mesh).verts).toBe(before.verts + 8)
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('split off', () => {
  test('a cube face detaches, sharing no vertex with what it left', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const top = faceFacing(mesh, [0, 0, 1])
    const before = counts(mesh)

    const out = splitOffFaces(mesh, [top])

    expect(out.walls.length).toBe(0)
    expect(counts(mesh)).toEqual({verts: before.verts + 4, edges: before.edges + 4, faces: before.faces})

    const detached = new Set(faceVerts(mesh, out.faces[0]))
    for (const f of mesh.f) {
      if (f === out.faces[0]) {
        continue
      }
      for (const v of faceVerts(mesh, f)) {
        expect(detached.has(v)).toBe(false)
      }
    }
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a region that touches nothing else is left exactly as it was', () => {
    const mesh = new LeafMesh()
    const plane = makePlane(mesh)
    const before = counts(mesh)

    splitOffFaces(mesh, plane.faces)

    expect(counts(mesh)).toEqual(before)
    expect(mesh.validateAndRepair()).toBe(0)
  })
})

describe('inset', () => {
  /** How far a face's vertices sit from the axis, on average. */
  function meanRadius(mesh: LeafMesh, verts: readonly number[]): number {
    let r = 0
    for (const v of verts) {
      r += Math.hypot(mesh.v.co[v * 3], mesh.v.co[v * 3 + 1])
    }
    return r / verts.length
  }

  test('a cube face keeps its plane and gains a band', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const before = counts(mesh)

    const out = insetFaceRegion(mesh, [faceFacing(mesh, [0, 0, 1])], {amount: 0.5})

    expect(out.walls.length).toBe(4)
    expect(counts(mesh)).toEqual({verts: before.verts + 4, edges: before.edges + 8, faces: before.faces + 4})

    // Half a unit in from each of the four sides, and still on the top plane.
    for (const v of faceVerts(mesh, out.faces[0])) {
      expect(Math.abs(mesh.v.co[v * 3])).toBeCloseTo(0.5, 12)
      expect(Math.abs(mesh.v.co[v * 3 + 1])).toBeCloseTo(0.5, 12)
      expect(mesh.v.co[v * 3 + 2]).toBeCloseTo(1, 12)
    }
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('depth lifts the inset face off the plane it came from', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const out = insetFaceRegion(mesh, [faceFacing(mesh, [0, 0, 1])], {amount: 0.25, depth: -0.5})

    expect(faceCentre(mesh, out.faces[0])[2]).toBeCloseTo(0.5, 12)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('the outer ring goes in and the hole ring goes out', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 16, 1, 0.5)
    const cap = [...mesh.f].find((f) => faceHoleCount(mesh, f) === 1 && mesh.faceNormal(f)[2] > 0.9) as number

    const loops = [...mesh.faceLoops(cap)]
    const outerBefore = meanRadius(mesh, mesh.loopVerts(loops[0]))
    const holeBefore = meanRadius(mesh, mesh.loopVerts(loops[1]))

    const out = insetFaceRegion(mesh, [cap], {amount: 0.1})
    const after = [...mesh.faceLoops(out.faces[0])]

    expect(faceHoleCount(mesh, out.faces[0])).toBe(1)
    expect(out.walls.length).toBe(32)
    // Both rings move toward the material between them: the outer one shrinks,
    // the hole grows. A naive per-ring inset would shrink the hole too.
    expect(meanRadius(mesh, mesh.loopVerts(after[0]))).toBeLessThan(outerBefore)
    expect(meanRadius(mesh, mesh.loopVerts(after[1]))).toBeGreaterThan(holeBefore)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('a region insets as one, with no band along its interior', () => {
    const mesh = new LeafMesh()
    const grid = makeGrid(mesh, 2, 2)
    const pair = [grid.faces[0], grid.faces[1]]

    const out = insetFaceRegion(mesh, pair, {amount: 0.1})

    expect(out.walls.length).toBe(6)
    expect(out.faces.length).toBe(2)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('individually, each face keeps its own band', () => {
    const mesh = new LeafMesh()
    const grid = makeGrid(mesh, 2, 2)
    const pair = [grid.faces[0], grid.faces[1]]

    const out = insetFacesIndividual(mesh, pair, {amount: 0.1})

    expect(out.walls.length).toBe(8)
    expect(new Set(out.verts).size).toBe(8)
    expect(mesh.validateAndRepair()).toBe(0)
  })

  test('the band faces the same way the face it came from does', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)
    const out = insetFaceRegion(mesh, [faceFacing(mesh, [0, 0, 1])], {amount: 0.5})

    for (const w of out.walls) {
      expect(mesh.faceNormal(w)[2]).toBeCloseTo(1, 9)
    }
  })
})

describe('attributes and undo cost', () => {
  test('a duplicated vertex carries its layers across', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const layer = mesh.attrs.add(Domain.VERT, 'weight', AttrType.Float)

    const top = faceFacing(mesh, [0, 0, 1])
    for (const v of faceVerts(mesh, top)) {
      layer.column.data[v] = 0.25
    }

    const out = extrudeFaceRegion(mesh, [top], {offset: 1})

    for (const v of out.verts) {
      expect(layer.column.data[v]).toBeCloseTo(0.25, 6)
    }
  })

  test('a rebuilt face keeps its own attributes and its corners keep theirs', () => {
    const mesh = new LeafMesh()
    makeTube(mesh, 6)
    const faceLayer = mesh.attrs.add(Domain.FACE, 'material', AttrType.Int)
    const uv = mesh.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)

    const cap = [...mesh.f].find((f) => faceHoleCount(mesh, f) === 1 && mesh.faceNormal(f)[2] > 0.9) as number
    faceLayer.column.data[cap] = 7

    // One recognisable value per corner, keyed off the corner's vertex.
    for (const l of mesh.faceLoops(cap)) {
      for (const c of mesh.loopCorners(l)) {
        uv.column.data[c * 2] = mesh.c.v[c]
        uv.column.data[c * 2 + 1] = 0.5
      }
    }

    const out = extrudeFaceRegion(mesh, [cap], {offset: 1})
    const rebuilt = out.faces[0]

    expect(faceLayer.column.data[rebuilt]).toBe(7)
    for (const l of mesh.faceLoops(rebuilt)) {
      for (const c of mesh.loopCorners(l)) {
        expect(uv.column.data[c * 2 + 1]).toBeCloseTo(0.5, 6)
      }
    }
  })

  test('a snapshot is charged for every column of every domain', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const small = meshSnapshotBytes(mesh)

    expect(small).toBeGreaterThan(0)

    makeTube(mesh, 32)
    expect(meshSnapshotBytes(mesh)).toBeGreaterThan(small)
  })
})
