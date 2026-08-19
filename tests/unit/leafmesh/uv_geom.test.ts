/**
 * The LeafMesh UV traversals (P18 §5 step 2, implementor #1). `uv_geom.ts`
 * imports nothing from `scripts/`, so it runs straight from jest; `uv_source.ts`
 * over it is a vocabulary shell and is covered by the conformance suite.
 */

import {AttrType, Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {makeCube, makeGrid} from '../../../addons/builtin/leafmesh/src/primitives'
import {ensureSelectFlags, flushSelection} from '../../../addons/builtin/leafmesh/src/select_geom'
import {LeafMesh} from '../../../addons/builtin/leafmesh/src/topo'
import {
  UV_PIN,
  UV_SELECT,
  ensureUVCoords,
  ensureUVFlags,
  faceCornerRings,
  uvCoords,
  uvElements,
  uvFaces,
  uvFans,
  uvFlags,
  uvFlagsLayerName,
  uvLayerNames,
  vertCorners,
} from '../../../addons/builtin/leafmesh/src/uv_geom'

/** A 2x2 grid with one flat UV layer laid out over the unit square. */
function unwrappedGrid(name = 'UVMap'): LeafMesh {
  const mesh = new LeafMesh()
  makeGrid(mesh, 2, 2)

  const uv = ensureUVCoords(mesh, name)
  for (const c of mesh.c) {
    const v = mesh.c.v[c]
    uv[c * 2] = mesh.v.co[v * 3] + 0.5
    uv[c * 2 + 1] = mesh.v.co[v * 3 + 1] + 0.5
  }
  return mesh
}

describe('uv layer discovery', () => {
  test('a mesh with no UVs has no layers', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    expect(uvLayerNames(mesh)).toEqual([])
    expect(uvCoords(mesh, 'UVMap')).toBeUndefined()
    expect(uvFlags(mesh, 'UVMap')).toBeUndefined()
  })

  test('only non-internal Float2 corner layers count as UV maps', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)

    ensureUVCoords(mesh, 'UVMap')
    ensureUVCoords(mesh, 'second')
    // A Float2 layer on another domain, and an internal one on this domain,
    // are storage — neither is a UV map the editor may open.
    mesh.attrs.add(Domain.VERT, 'notUV', AttrType.Float2)
    mesh.attrs.add(Domain.CORNER, '.hidden', AttrType.Float2)
    mesh.attrs.add(Domain.CORNER, 'weight', AttrType.Float)

    expect(uvLayerNames(mesh)).toEqual(['UVMap', 'second'])
  })

  test('the flags layer is internal, so it is never itself a UV map', () => {
    const mesh = unwrappedGrid()
    ensureUVFlags(mesh, 'UVMap')

    expect(uvFlagsLayerName('UVMap')).toBe('.uvflags:UVMap')
    expect(uvLayerNames(mesh)).toEqual(['UVMap'])
    expect(uvFlags(mesh, 'UVMap')).toBeDefined()
  })

  test('flags start clear and round-trip', () => {
    const mesh = unwrappedGrid()
    const flags = ensureUVFlags(mesh, 'UVMap')
    expect(Array.from(flags).every((f) => f === 0)).toBe(true)

    flags[0] = UV_SELECT | UV_PIN
    expect(uvFlags(mesh, 'UVMap')![0]).toBe(UV_SELECT | UV_PIN)
  })

  test('ensureUVCoords is idempotent and keeps what is already there', () => {
    const mesh = unwrappedGrid()
    const first = uvCoords(mesh, 'UVMap')!
    first[0] = 0.125

    expect(ensureUVCoords(mesh, 'UVMap')[0]).toBe(0.125)
    expect(uvLayerNames(mesh)).toEqual(['UVMap'])
  })
})

describe('uv elements and faces', () => {
  test('every live corner is a UV element', () => {
    const mesh = unwrappedGrid()
    const elems = uvElements(mesh)
    expect(elems.length).toBe(mesh.c.count)
    expect(elems.length).toBe(4 * 4)
    expect(new Set(elems).size).toBe(elems.length)
  })

  test('filtering by owners keeps only live handles', () => {
    const mesh = unwrappedGrid()
    const elems = uvElements(mesh)
    const some = [elems[0], elems[3], 9999, -1]

    expect(Array.from(uvElements(mesh, some))).toEqual([elems[0], elems[3]])
  })

  test('selectedOnly filters faces, and is empty before anything is selected', () => {
    const mesh = unwrappedGrid()
    expect(uvFaces(mesh).length).toBe(4)
    expect(uvFaces(mesh, true).length).toBe(0)

    const flags = ensureSelectFlags(mesh, Domain.FACE)
    const faces = Array.from(mesh.f)
    flags[faces[0]] = 1
    flags[faces[2]] = 1
    flushSelection(mesh, Domain.FACE)

    expect(Array.from(uvFaces(mesh, true))).toEqual([faces[0], faces[2]])
    expect(uvFaces(mesh).length).toBe(4)
  })
})

describe('face rings', () => {
  test('a quad ring is its four corners in winding order', () => {
    const mesh = unwrappedGrid()
    const faces = uvFaces(mesh)
    const rings = faceCornerRings(mesh, faces)

    expect(rings.offsets.length).toBe(faces.length + 1)
    expect(rings.values.length).toBe(faces.length * 4)

    for (let i = 0; i < faces.length; i++) {
      const ring = Array.from(rings.values.subarray(rings.offsets[i], rings.offsets[i + 1]))
      expect(ring.length).toBe(4)
      expect(new Set(ring).size).toBe(4)
      // The ring's corners belong to the face it was asked about.
      for (const c of ring) {
        expect(mesh.cornerFace(c)).toBe(faces[i])
      }
    }
  })

  test('a dead face contributes an empty row, not a missing one', () => {
    const mesh = unwrappedGrid()
    const rings = faceCornerRings(mesh, [uvFaces(mesh)[0], 9999])

    expect(rings.offsets.length).toBe(3)
    expect(rings.offsets[1] - rings.offsets[0]).toBe(4)
    expect(rings.offsets[2] - rings.offsets[1]).toBe(0)
  })
})

describe('vertCorners and fans', () => {
  test('an interior grid vertex carries one corner per touching face', () => {
    const mesh = unwrappedGrid()
    const counts = Array.from(mesh.v).map((v) => vertCorners(mesh, v).length)

    // 2x2 grid: one interior vertex (4), four edge midpoints (2), four
    // corners (1).
    expect(counts.filter((n) => n === 4).length).toBe(1)
    expect(counts.filter((n) => n === 2).length).toBe(4)
    expect(counts.filter((n) => n === 1).length).toBe(4)
  })

  test('a dead vertex has no corners', () => {
    const mesh = unwrappedGrid()
    expect(vertCorners(mesh, 9999)).toEqual([])
  })

  test('corners agreeing on a UV are one fan; splitting a seam breaks it', () => {
    const mesh = unwrappedGrid()
    const interior = Array.from(mesh.v).find((v) => vertCorners(mesh, v).length === 4)!
    const around = vertCorners(mesh, interior).sort((a, b) => a - b)

    const fan = uvFans(mesh, 'UVMap', [around[0]])
    expect(Array.from(fan.values).sort((a, b) => a - b)).toEqual(around)

    // A seam is one corner disagreeing — no topology changes.
    const uv = uvCoords(mesh, 'UVMap')!
    uv[around[0] * 2] += 0.25

    expect(Array.from(uvFans(mesh, 'UVMap', [around[0]]).values)).toEqual([around[0]])
    expect(Array.from(uvFans(mesh, 'UVMap', [around[1]]).values).sort((a, b) => a - b)).toEqual(around.slice(1))
  })

  test('a fan is at worst the handle itself, even with no UV layer', () => {
    const mesh = new LeafMesh()
    makeGrid(mesh, 1, 1)
    const c = uvElements(mesh)[0]

    expect(Array.from(uvFans(mesh, 'missing', [c]).values)).toEqual([c])
    expect(Array.from(uvFans(mesh, 'missing', [9999]).values)).toEqual([])
  })

  test('eps decides how close counts as welded', () => {
    const mesh = unwrappedGrid()
    const interior = Array.from(mesh.v).find((v) => vertCorners(mesh, v).length === 4)!
    const around = vertCorners(mesh, interior)

    const uv = uvCoords(mesh, 'UVMap')!
    uv[around[0] * 2] += 1e-4

    expect(uvFans(mesh, 'UVMap', [around[0]]).values.length).toBe(1)
    expect(uvFans(mesh, 'UVMap', [around[0]], 1e-3).values.length).toBe(4)
  })
})
