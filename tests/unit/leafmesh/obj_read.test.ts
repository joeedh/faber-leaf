/**
 * The OBJ reader (P11 §6). `obj.ts` is not reachable here — it imports
 * `@framework/api` — so what is under test is the parse, which is the half that
 * has to prove an n-gon stays one face instead of becoming a fan.
 */

import {AttrType, Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {OBJ_MAX_WARNINGS, OBJ_UV_LAYER, readOBJ} from '../../../addons/builtin/leafmesh/src/obj_read'
import {LeafMesh} from '../../../addons/builtin/leafmesh/src/topo'

/** Vertex counts of every live face, sorted, for asserting "one n-gon" claims. */
function faceSizes(mesh: LeafMesh): number[] {
  const out: number[] = []
  for (const f of mesh.f) {
    let n = 0
    for (const l of mesh.faceLoops(f)) {
      n += mesh.loopVerts(l).length
    }
    out.push(n)
  }
  return out.sort((a, b) => a - b)
}

/** One hexagon — the n-gon §10 asks for. */
const HEXAGON = `
# a six-sided face
v 1 0 0
v 0.5 0.866 0
v -0.5 0.866 0
v -1 0 0
v -0.5 -0.866 0
v 0.5 -0.866 0
f 1 2 3 4 5 6
`

/**
 * A quad with a square bite taken out of the middle of one edge, built from
 * five faces — a mesh with a boundary hole, which is what OBJ can actually
 * express (it has no syntax for a hole ring inside a face).
 */
const HOLED = `
v -2 -2 0
v 0 -2 0
v 2 -2 0
v -2 0 0
v 0 0 0
v 2 0 0
v -2 2 0
v 0 2 0
v 2 2 0
f 1 2 5 4
f 2 3 6 5
f 4 5 8 7
`

describe('readOBJ', () => {
  test('an n-gon imports as one face, not a fan', () => {
    const {mesh, stats} = readOBJ(HEXAGON)

    expect(stats.verts).toBe(6)
    expect(stats.faces).toBe(1)
    expect(mesh.f.count).toBe(1)
    expect(faceSizes(mesh)).toEqual([6])
  })

  test('a mesh with a boundary hole keeps its face count', () => {
    const {mesh, stats} = readOBJ(HOLED)

    expect(stats.verts).toBe(9)
    expect(stats.faces).toBe(3)
    expect(mesh.f.count).toBe(3)
    expect(faceSizes(mesh)).toEqual([4, 4, 4])
    // The centre vertex is used by all three, so the mesh is one connected
    // surface with a bite out of it, not three loose quads.
    expect(mesh.e.count).toBe(10)
  })

  test('reads positions in file order', () => {
    const {mesh} = readOBJ('v 1 2 3\nv -4 -5 -6\n')

    expect(Array.from(mesh.v.co.slice(0, 6))).toEqual([1, 2, 3, -4, -5, -6])
  })

  test('accepts \r\n line endings', () => {
    const {stats} = readOBJ(HEXAGON.replace(/\n/g, '\r\n'))

    expect(stats.faces).toBe(1)
    expect(stats.warnings).toEqual([])
  })

  test('skips comments, blank lines and keywords it does not model', () => {
    const {mesh, stats} = readOBJ(`
# comment
mtllib scene.mtl
o thing
g group
s off
usemtl red
${HEXAGON}
`)

    expect(stats.faces).toBe(1)
    expect(mesh.f.count).toBe(1)
    expect(stats.warnings).toEqual([])
  })

  test('resolves negative indices against the table so far', () => {
    const {mesh, stats} = readOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n')

    expect(stats.faces).toBe(1)
    expect(faceSizes(mesh)).toEqual([3])
  })

  test('drops a face that references a vertex out of range', () => {
    const {mesh, stats} = readOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n')

    expect(mesh.f.count).toBe(0)
    expect(stats.degenerate).toBe(1)
    expect(stats.warnings.length).toBe(2)
  })

  test('repairs a ring that names the same vertex twice', () => {
    const {mesh, stats} = readOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3 3\n')

    expect(stats.repaired).toBe(1)
    expect(stats.faces).toBe(1)
    expect(faceSizes(mesh)).toEqual([3])
  })

  test('drops a face left with fewer than three distinct vertices', () => {
    const {mesh, stats} = readOBJ('v 0 0 0\nv 1 0 0\nf 1 2 1\n')

    expect(mesh.f.count).toBe(0)
    expect(stats.degenerate).toBe(1)
    expect(stats.repaired).toBe(1)
  })

  test('counts and discards vn lines', () => {
    const {mesh, stats} = readOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//1\n')

    expect(stats.normalsIgnored).toBe(1)
    expect(stats.uvs).toBe(false)
    expect(stats.faces).toBe(1)
    expect(mesh.attrs.get(Domain.CORNER, OBJ_UV_LAYER)).toBeUndefined()
  })

  test('puts vt references on the corner domain', () => {
    const {mesh, stats} = readOBJ(`
v 0 0 0
v 1 0 0
v 1 1 0
vt 0 0
vt 1 0
vt 1 1
f 1/1 2/2 3/3
`)

    expect(stats.uvs).toBe(true)

    const layer = mesh.attrs.get(Domain.CORNER, OBJ_UV_LAYER)
    expect(layer).toBeDefined()
    expect(layer?.type).toBe(AttrType.Float2)

    const uv = layer!.column.data
    const corners = mesh.loopVerts(mesh.f.l[0]).length
    expect(corners).toBe(3)

    const got: number[][] = []
    for (const c of mesh.loopCorners(mesh.f.l[0])) {
      got.push([uv[c * 2], uv[c * 2 + 1]])
    }
    expect(got).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ])
  })

  test('a face mixing uv-bearing and bare references keeps the ones it has', () => {
    const {mesh, stats} = readOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nvt 0.25 0.75\nf 1/1 2 3\n')

    expect(stats.uvs).toBe(true)

    const uv = mesh.attrs.get(Domain.CORNER, OBJ_UV_LAYER)!.column.data
    const first = mesh.loopCorners(mesh.f.l[0]).next().value as number
    expect([uv[first * 2], uv[first * 2 + 1]]).toEqual([0.25, 0.75])
  })

  test('a v line with too few coordinates warns instead of making a NaN vertex', () => {
    const {mesh, stats} = readOBJ('v 0 0\nv 1 0 0\n')

    expect(mesh.v.count).toBe(1)
    expect(stats.verts).toBe(1)
    expect(stats.warnings.length).toBe(1)
  })

  test('caps the warning list', () => {
    let src = 'v 0 0 0\n'
    for (let i = 0; i < OBJ_MAX_WARNINGS + 10; i++) {
      src += 'v 0 0\n'
    }
    const {stats} = readOBJ(src)

    expect(stats.warnings.length).toBe(OBJ_MAX_WARNINGS)
  })

  test('appends into a mesh that already has geometry', () => {
    const mesh = new LeafMesh()
    const a = mesh.makeVert([0, 0, 0])
    const b = mesh.makeVert([1, 0, 0])
    const c = mesh.makeVert([0, 1, 0])
    mesh.makeFace([[a, b, c]])

    const {stats} = readOBJ(HEXAGON, mesh)

    expect(stats.faces).toBe(1)
    expect(mesh.f.count).toBe(2)
    expect(faceSizes(mesh)).toEqual([3, 6])
  })

  test('an empty file yields an empty mesh and no complaints', () => {
    const {mesh, stats} = readOBJ('')

    expect(mesh.v.count).toBe(0)
    expect(mesh.f.count).toBe(0)
    expect(stats.warnings).toEqual([])
  })
})
