/**
 * Selection state and the topological selection queries (P12 §4, step 1).
 * `select_geom.ts` imports nothing from `scripts/`, so it is exercised straight
 * from jest — the ToolOps over it are thin by design and tested through the app.
 */

import {Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {ELEM_NONE} from '../../../addons/builtin/leafmesh/src/elem_array'
import {makeCube, makeGrid} from '../../../addons/builtin/leafmesh/src/primitives'
import {
  applySelection,
  countSelected,
  ensureSelectFlags,
  faceArea,
  faceEdges,
  faceHoleCount,
  faceSides,
  faceVerts,
  flushSelection,
  isSelected,
  linkedFrom,
  listSelected,
  restoreSelection,
  selectAll,
  selectFlags,
  similarTo,
  snapshotSelection,
  vertFaces,
} from '../../../addons/builtin/leafmesh/src/select_geom'
import {LeafMesh} from '../../../addons/builtin/leafmesh/src/topo'

/** A 4x4 square with a 1x1 square hole through its middle, in the XY plane. */
function holedQuad(): {mesh: LeafMesh; face: number; outer: number[]; hole: number[]} {
  const mesh = new LeafMesh()
  const outer = [
    mesh.makeVert([-2, -2, 0]),
    mesh.makeVert([2, -2, 0]),
    mesh.makeVert([2, 2, 0]),
    mesh.makeVert([-2, 2, 0]),
  ]
  const hole = [
    mesh.makeVert([-0.5, -0.5, 0]),
    mesh.makeVert([0.5, -0.5, 0]),
    mesh.makeVert([0.5, 0.5, 0]),
    mesh.makeVert([-0.5, 0.5, 0]),
  ]

  return {mesh, face: mesh.makeFace([outer, hole]), outer, hole}
}

/** Two quads meeting at exactly one vertex — connected visually, not topologically. */
function bowtie(): {mesh: LeafMesh; a: number; b: number; pivot: number} {
  const mesh = new LeafMesh()
  const pivot = mesh.makeVert([0, 0, 0])

  const a = mesh.makeFace([[mesh.makeVert([-1, -1, 0]), mesh.makeVert([-1, 1, 0]), mesh.makeVert([0, 1, 0]), pivot]])
  const b = mesh.makeFace([[pivot, mesh.makeVert([1, 0, 0]), mesh.makeVert([1, -1, 0]), mesh.makeVert([0, -1, 0])]])

  return {mesh, a, b, pivot}
}

describe('selection state', () => {
  test('the layer does not exist until something is selected', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)

    expect(selectFlags(mesh, Domain.VERT)).toBeUndefined()
    expect(countSelected(mesh, Domain.VERT)).toBe(0)
    expect(listSelected(mesh, Domain.FACE)).toEqual([])
    expect(isSelected(mesh, Domain.VERT, 0)).toBe(false)

    expect(ensureSelectFlags(mesh, Domain.VERT).length).toBeGreaterThanOrEqual(8)
    expect(selectFlags(mesh, Domain.VERT)).toBeDefined()
  })

  test('selectAll covers every live element and clears again', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)

    expect(selectAll(mesh, Domain.VERT, true)).toBe(8)
    expect(countSelected(mesh, Domain.VERT)).toBe(8)
    expect(listSelected(mesh, Domain.VERT)).toHaveLength(8)

    expect(selectAll(mesh, Domain.VERT, false)).toBe(0)
    expect(countSelected(mesh, Domain.VERT)).toBe(0)
  })

  test('a killed element drops out of the count without being deselected', () => {
    const mesh = new LeafMesh()
    const {faces} = makeCube(mesh)

    selectAll(mesh, Domain.FACE, true)
    mesh.killFace(faces[0])

    expect(countSelected(mesh, Domain.FACE)).toBe(5)
    expect(listSelected(mesh, Domain.FACE)).not.toContain(faces[0])
  })
})

describe('applySelection', () => {
  test('replace clears the domain first', () => {
    const mesh = new LeafMesh()
    const {verts} = makeCube(mesh)

    selectAll(mesh, Domain.VERT, true)
    applySelection(mesh, Domain.VERT, [verts[0], verts[1]], 'replace')

    expect(listSelected(mesh, Domain.VERT)).toEqual([verts[0], verts[1]].sort((a, b) => a - b))
  })

  test('add, sub and toggle leave untouched elements alone', () => {
    const mesh = new LeafMesh()
    const {verts} = makeCube(mesh)

    expect(applySelection(mesh, Domain.VERT, [verts[0], verts[1]], 'add')).toBe(2)
    expect(applySelection(mesh, Domain.VERT, [verts[1], verts[2]], 'add')).toBe(1)
    expect(countSelected(mesh, Domain.VERT)).toBe(3)

    expect(applySelection(mesh, Domain.VERT, [verts[2], verts[7]], 'sub')).toBe(1)
    expect(countSelected(mesh, Domain.VERT)).toBe(2)

    expect(applySelection(mesh, Domain.VERT, [verts[0], verts[3]], 'toggle')).toBe(2)
    expect(isSelected(mesh, Domain.VERT, verts[0])).toBe(false)
    expect(isSelected(mesh, Domain.VERT, verts[3])).toBe(true)
  })

  test('dead and ELEM_NONE handles are ignored', () => {
    const mesh = new LeafMesh()
    const {verts, faces} = makeCube(mesh)

    mesh.killFace(faces[0])
    expect(applySelection(mesh, Domain.FACE, [faces[0], ELEM_NONE], 'add')).toBe(0)
    expect(applySelection(mesh, Domain.VERT, [verts[0], ELEM_NONE, 9999], 'add')).toBe(1)
  })
})

describe('flushSelection', () => {
  test('upward: an element is selected only when all of its vertices are', () => {
    const mesh = new LeafMesh()
    const {faces} = makeCube(mesh)
    const ring = mesh.loopVerts(mesh.f.l[faces[0]])

    applySelection(mesh, Domain.VERT, ring, 'replace')
    flushSelection(mesh, Domain.VERT)

    expect(listSelected(mesh, Domain.FACE)).toEqual([faces[0]])
    expect(countSelected(mesh, Domain.EDGE)).toBe(4)

    // Drop one vertex and the face goes with it; so do the two edges that no
    // longer have both endpoints, leaving the far pair of the ring.
    applySelection(mesh, Domain.VERT, [ring[0]], 'sub')
    flushSelection(mesh, Domain.VERT)

    expect(countSelected(mesh, Domain.FACE)).toBe(0)
    expect(countSelected(mesh, Domain.EDGE)).toBe(2)
  })

  test('downward from a face selects its vertices and edges', () => {
    const mesh = new LeafMesh()
    const {faces} = makeCube(mesh)

    applySelection(mesh, Domain.FACE, [faces[0]], 'replace')
    flushSelection(mesh, Domain.FACE)

    expect(countSelected(mesh, Domain.VERT)).toBe(4)
    expect(countSelected(mesh, Domain.EDGE)).toBe(4)
    expect(listSelected(mesh, Domain.FACE)).toEqual([faces[0]])
  })

  test('from an edge, the face follows only when the whole face does', () => {
    const mesh = new LeafMesh()
    const {faces} = makeCube(mesh)
    const edges = faceEdges(mesh, faces[0])

    applySelection(mesh, Domain.EDGE, [edges[0]], 'replace')
    flushSelection(mesh, Domain.EDGE)

    expect(countSelected(mesh, Domain.VERT)).toBe(2)
    expect(countSelected(mesh, Domain.FACE)).toBe(0)

    applySelection(mesh, Domain.EDGE, edges, 'replace')
    flushSelection(mesh, Domain.EDGE)

    expect(listSelected(mesh, Domain.FACE)).toEqual([faces[0]])
  })

  test('a holed face flushes down into its hole ring as well', () => {
    const {mesh, face, hole} = holedQuad()

    applySelection(mesh, Domain.FACE, [face], 'replace')
    flushSelection(mesh, Domain.FACE)

    expect(countSelected(mesh, Domain.VERT)).toBe(8)
    expect(countSelected(mesh, Domain.EDGE)).toBe(8)
    for (const v of hole) {
      expect(isSelected(mesh, Domain.VERT, v)).toBe(true)
    }
  })

  test('a holed face is not selected upward from its outer ring alone', () => {
    const {mesh, face, outer} = holedQuad()

    applySelection(mesh, Domain.VERT, outer, 'replace')
    flushSelection(mesh, Domain.VERT)

    expect(isSelected(mesh, Domain.FACE, face)).toBe(false)
  })
})

describe('linkedFrom', () => {
  test('faces flood across shared edges and stop at the shell boundary', () => {
    const mesh = new LeafMesh()
    const a = makeCube(mesh)
    const b = makeCube(mesh)

    expect(linkedFrom(mesh, Domain.FACE, [a.faces[0]]).sort((x, y) => x - y)).toEqual(
      [...a.faces].sort((x, y) => x - y)
    )
    expect(linkedFrom(mesh, Domain.FACE, [b.faces[3]])).toHaveLength(6)
  })

  test('vertices and edges flood across the same shells', () => {
    const mesh = new LeafMesh()
    const a = makeCube(mesh)
    makeCube(mesh)

    expect(linkedFrom(mesh, Domain.VERT, [a.verts[0]])).toHaveLength(8)
    expect(linkedFrom(mesh, Domain.EDGE, [faceEdges(mesh, a.faces[0])[0]])).toHaveLength(12)
  })

  test('sharing only a vertex is not face connectivity', () => {
    const {mesh, a, b, pivot} = bowtie()

    expect(linkedFrom(mesh, Domain.FACE, [a])).toEqual([a])
    expect(linkedFrom(mesh, Domain.FACE, [b])).toEqual([b])
    // The vertex domain does see them as one island — that is the correct
    // difference, not an inconsistency.
    expect(linkedFrom(mesh, Domain.VERT, [pivot])).toHaveLength(7)
  })

  test('seeds that are dead or ELEM_NONE contribute nothing', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)

    expect(linkedFrom(mesh, Domain.FACE, [ELEM_NONE, 9999])).toEqual([])
  })

  test('a hole ring is its own island in the edge graph', () => {
    const {mesh, face, hole, outer} = holedQuad()

    // No edge joins the two rings, so vertex flooding does not cross between
    // them even though they belong to one face — which is why hole-aware tools
    // work in the face domain rather than by flooding vertices.
    expect(linkedFrom(mesh, Domain.VERT, [hole[0]]).sort((a, b) => a - b)).toEqual([...hole].sort((a, b) => a - b))
    expect(linkedFrom(mesh, Domain.VERT, [outer[0]])).toHaveLength(4)
    expect(linkedFrom(mesh, Domain.FACE, [face])).toEqual([face])
  })
})

describe('face measurements', () => {
  test('sides count the outer ring, holes count the rest', () => {
    const {mesh, face} = holedQuad()

    expect(faceSides(mesh, face)).toBe(4)
    expect(faceHoleCount(mesh, face)).toBe(1)
    expect(faceVerts(mesh, face)).toHaveLength(8)
    expect(faceEdges(mesh, face)).toHaveLength(8)
  })

  test('area subtracts the hole', () => {
    const {mesh, face} = holedQuad()

    expect(faceArea(mesh, face)).toBeCloseTo(16 - 1, 5)
  })

  test('vertFaces walks the disk', () => {
    const mesh = new LeafMesh()
    const {verts} = makeCube(mesh)

    expect(vertFaces(mesh, verts[0])).toHaveLength(3)
  })
})

describe('similarTo', () => {
  test('FACE_SIDES separates a triangle from the quads around it', () => {
    const mesh = new LeafMesh()
    const {faces} = makeGrid(mesh, 2, 1)
    const tri = mesh.makeFace([[mesh.makeVert([0, 2, 0]), mesh.makeVert([1, 2, 0]), mesh.makeVert([0, 3, 0])]])

    expect(similarTo(mesh, Domain.FACE, faces[0], 'FACE_SIDES').sort((a, b) => a - b)).toEqual(
      [...faces].sort((a, b) => a - b)
    )
    expect(similarTo(mesh, Domain.FACE, tri, 'FACE_SIDES')).toEqual([tri])
  })

  test('FACE_NORMAL picks one face of a cube, FACE_AREA picks all six', () => {
    const mesh = new LeafMesh()
    const {faces} = makeCube(mesh)

    expect(similarTo(mesh, Domain.FACE, faces[0], 'FACE_NORMAL')).toEqual([faces[0]])
    expect(similarTo(mesh, Domain.FACE, faces[0], 'FACE_AREA')).toHaveLength(6)
  })

  test('FACE_COPLANAR keeps the opposite face out', () => {
    const mesh = new LeafMesh()
    const {faces} = makeGrid(mesh, 2, 2)
    const seed = faces[0]

    expect(similarTo(mesh, Domain.FACE, seed, 'FACE_COPLANAR')).toHaveLength(4)

    const cube = new LeafMesh()
    const cf = makeCube(cube).faces
    for (const f of similarTo(cube, Domain.FACE, cf[0], 'FACE_COPLANAR')) {
      expect(f).toBe(cf[0])
    }
  })

  test('FACE_HOLES tells a holed face from a plain one', () => {
    const {mesh, face} = holedQuad()
    const plain = mesh.makeFace([
      [mesh.makeVert([5, 0, 0]), mesh.makeVert([6, 0, 0]), mesh.makeVert([6, 1, 0]), mesh.makeVert([5, 1, 0])],
    ])

    expect(similarTo(mesh, Domain.FACE, face, 'FACE_HOLES')).toEqual([face])
    expect(similarTo(mesh, Domain.FACE, plain, 'FACE_HOLES')).toEqual([plain])
  })

  test('EDGE_LENGTH and EDGE_FACES split a grid the way the topology does', () => {
    const mesh = new LeafMesh()
    const {faces} = makeGrid(mesh, 2, 1)
    const edges = faceEdges(mesh, faces[0])
    const interior = edges.find((e) => mesh.edgeFaceCount(e) === 2) as number
    const boundary = edges.find((e) => mesh.edgeFaceCount(e) === 1) as number

    expect(similarTo(mesh, Domain.EDGE, interior, 'EDGE_FACES')).toEqual([interior])
    expect(similarTo(mesh, Domain.EDGE, boundary, 'EDGE_FACES')).toHaveLength(6)
    // A 2x1 grid of a unit square is 0.5 wide by 1 tall: four short edges,
    // three long ones.
    expect(similarTo(mesh, Domain.EDGE, edges[0], 'EDGE_LENGTH')).toHaveLength(4)
  })

  test('EDGE_DIRECTION is orientation-blind', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const seed = [...mesh.e][0]

    // A cube has twelve edges in three axis-aligned bundles of four.
    expect(similarTo(mesh, Domain.EDGE, seed, 'EDGE_DIRECTION')).toHaveLength(4)
  })

  test('VERT_EDGES and VERT_FACES count the disk', () => {
    const mesh = new LeafMesh()
    const {verts} = makeCube(mesh)

    expect(similarTo(mesh, Domain.VERT, verts[0], 'VERT_EDGES')).toHaveLength(8)
    expect(similarTo(mesh, Domain.VERT, verts[0], 'VERT_FACES')).toHaveLength(8)
  })

  test('a dead seed matches nothing', () => {
    const mesh = new LeafMesh()
    const {faces} = makeCube(mesh)

    mesh.killFace(faces[0])
    expect(similarTo(mesh, Domain.FACE, faces[0], 'FACE_SIDES')).toEqual([])
    expect(similarTo(mesh, Domain.FACE, ELEM_NONE, 'FACE_SIDES')).toEqual([])
  })
})

describe('selection snapshots', () => {
  test('a snapshot restores every domain and reports its own size', () => {
    const mesh = new LeafMesh()
    const {verts, faces} = makeCube(mesh)

    applySelection(mesh, Domain.VERT, [verts[0], verts[1]], 'add')
    applySelection(mesh, Domain.FACE, [faces[0]], 'add')
    flushSelection(mesh, Domain.FACE)

    const snap = snapshotSelection(mesh)
    const before = [Domain.VERT, Domain.EDGE, Domain.FACE].map((d) => countSelected(mesh, d))

    // The three byte columns and nothing else — what calcUndoMem reports.
    expect(snap.bytes).toBe(snap.vert.length + snap.edge.length + snap.face.length)
    expect(snap.bytes).toBeGreaterThan(0)

    selectAll(mesh, Domain.VERT, true)
    selectAll(mesh, Domain.EDGE, true)
    selectAll(mesh, Domain.FACE, false)
    restoreSelection(mesh, snap)

    expect([Domain.VERT, Domain.EDGE, Domain.FACE].map((d) => countSelected(mesh, d))).toEqual(before)
  })

  test('a snapshot taken before new geometry leaves the new elements unselected', () => {
    const mesh = new LeafMesh()
    const {verts} = makeCube(mesh)

    selectAll(mesh, Domain.VERT, true)
    const snap = snapshotSelection(mesh)

    const fresh = mesh.makeVert([5, 5, 5])
    applySelection(mesh, Domain.VERT, [fresh], 'add')
    restoreSelection(mesh, snap)

    expect(countSelected(mesh, Domain.VERT)).toBe(verts.length)
    expect(isSelected(mesh, Domain.VERT, fresh)).toBe(false)
  })

  test('restoring onto a mesh with no selection layer creates one', () => {
    const source = new LeafMesh()
    const {verts} = makeCube(source)
    applySelection(source, Domain.VERT, [verts[0]], 'add')
    const snap = snapshotSelection(source)

    const target = new LeafMesh()
    makeCube(target)

    expect(selectFlags(target, Domain.VERT)).toBeUndefined()
    restoreSelection(target, snap)
    expect(countSelected(target, Domain.VERT)).toBe(1)
  })
})
