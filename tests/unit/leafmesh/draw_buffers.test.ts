/**
 * The CPU half of drawing (P11 §7): triangles flattened into unshared corners,
 * and an attribute layer gathered onto them from whichever domain holds it.
 * `draw.ts` itself is not reachable here — it imports `@framework/api`.
 */

import {AttrFlags, AttrType, Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {
  buildDrawGeometry,
  drawAttrNames,
  gatherDrawAttr,
  recalcVertexNormals,
  resolveDrawAttr,
} from '../../../addons/builtin/leafmesh/src/draw_buffers'
import {makeCube, makeGrid, makePlane} from '../../../addons/builtin/leafmesh/src/primitives'
import {LeafMesh} from '../../../addons/builtin/leafmesh/src/topo'
import {triangulateMesh} from '../../../addons/builtin/leafmesh/src/triangulate'

function tris(mesh: LeafMesh) {
  return triangulateMesh(mesh)
}

describe('buildDrawGeometry', () => {
  test('a quad flattens to unshared triangle corners', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    const t = tris(mesh)
    const geom = buildDrawGeometry(mesh, t)

    expect(geom.triCount).toBe(t.length)
    expect(geom.position.length).toBe(t.length * 9)
    expect(geom.normal.length).toBe(t.length * 9)
  })

  test('every corner position matches the vertex it came from', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const t = tris(mesh)
    const geom = buildDrawGeometry(mesh, t)

    for (let i = 0; i < t.length; i++) {
      for (let k = 0; k < 3; k++) {
        const src = t[i].v[k] * 3
        const dst = i * 9 + k * 3
        for (let j = 0; j < 3; j++) {
          expect(geom.position[dst + j]).toBeCloseTo(mesh.v.co[src + j], 6)
        }
      }
    }
  })

  test('an empty mesh yields empty buffers rather than throwing', () => {
    const mesh = new LeafMesh()
    const geom = buildDrawGeometry(mesh, [])

    expect(geom.triCount).toBe(0)
    expect(geom.position.length).toBe(0)
  })
})

describe('recalcVertexNormals', () => {
  test('a flat grid in z has unit +z normals everywhere', () => {
    const mesh = new LeafMesh()
    makeGrid(mesh, 4, 4, 2)

    const no = recalcVertexNormals(mesh, tris(mesh))

    for (const v of mesh.v) {
      const i = v * 3
      expect(Math.hypot(no[i], no[i + 1], no[i + 2])).toBeCloseTo(1, 5)
      expect(Math.abs(no[i + 2])).toBeCloseTo(1, 5)
    }
  })

  test('cube corner normals are unit length and point outward', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const no = recalcVertexNormals(mesh, tris(mesh))
    const co = mesh.v.co

    for (const v of mesh.v) {
      const i = v * 3
      expect(Math.hypot(no[i], no[i + 1], no[i + 2])).toBeCloseTo(1, 5)

      // A cube centred on the origin: an outward normal agrees in sign with
      // the corner's own position, so the dot product stays positive.
      expect(co[i] * no[i] + co[i + 1] * no[i + 1] + co[i + 2] * no[i + 2]).toBeGreaterThan(0)
    }
  })

  test('area weighting favours the larger triangle', () => {
    const mesh = new LeafMesh()
    const a = mesh.makeVert([0, 0, 0])
    const b = mesh.makeVert([4, 0, 0])
    const c = mesh.makeVert([0, 4, 0])
    const d = mesh.makeVert([0, 0, 1])
    mesh.makeFace([[a, b, c]])
    mesh.makeFace([[a, d, b]])

    const no = recalcVertexNormals(mesh, tris(mesh))

    // `a` sits on both faces; the 8-area z-facing one outweighs the 2-area
    // tilted one, so its normal keeps a positive z.
    expect(no[a * 3 + 2]).toBeGreaterThan(0)
  })
})

describe('resolveDrawAttr / gatherDrawAttr', () => {
  test('a corner layer beats a vertex layer of the same name', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    mesh.attrs.add(Domain.VERT, 'uv', AttrType.Float2)
    const corner = mesh.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)

    expect(resolveDrawAttr(mesh, 'uv')).toBe(corner)
  })

  test('a missing name resolves to undefined and gathers to undefined', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    expect(resolveDrawAttr(mesh, 'nope')).toBeUndefined()
    expect(gatherDrawAttr(mesh, tris(mesh), 'nope', 2)).toBeUndefined()
  })

  test('a vertex layer gathers per corner from that corner vertex', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const layer = mesh.attrs.add(Domain.VERT, 'weight', AttrType.Float)
    for (const v of mesh.v) {
      layer.column.data[v] = v + 1
    }

    const t = tris(mesh)
    const out = gatherDrawAttr(mesh, t, 'weight', 1)!

    expect(out.length).toBe(t.length * 3)
    for (let i = 0; i < t.length; i++) {
      for (let k = 0; k < 3; k++) {
        expect(out[i * 3 + k]).toBe(t[i].v[k] + 1)
      }
    }
  })

  test('a face layer repeats one value across all three corners', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const layer = mesh.attrs.add(Domain.FACE, 'shade', AttrType.Float)
    for (const f of mesh.f) {
      layer.column.data[f] = f * 10
    }

    const t = tris(mesh)
    const out = gatherDrawAttr(mesh, t, 'shade', 1)!

    for (let i = 0; i < t.length; i++) {
      const want = t[i].f * 10
      expect(out[i * 3]).toBe(want)
      expect(out[i * 3 + 1]).toBe(want)
      expect(out[i * 3 + 2]).toBe(want)
    }
  })

  test('a corner layer keeps per-corner values distinct on a shared vertex', () => {
    const mesh = new LeafMesh()
    makeCube(mesh, 2)

    const layer = mesh.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)
    for (const c of mesh.c) {
      layer.column.data[c * 2] = c
      layer.column.data[c * 2 + 1] = -c
    }

    const t = tris(mesh)
    const out = gatherDrawAttr(mesh, t, 'uv', 2)!

    expect(out.length).toBe(t.length * 3 * 2)
    for (let i = 0; i < t.length; i++) {
      for (let k = 0; k < 3; k++) {
        const d = (i * 3 + k) * 2
        expect(out[d]).toBe(t[i].c[k])
        expect(out[d + 1]).toBe(-t[i].c[k])
      }
    }
  })

  test('a narrow layer into a 4-wide request zero-fills and sets w = 1', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    const layer = mesh.attrs.add(Domain.VERT, 'tint', AttrType.Float2)
    for (const v of mesh.v) {
      layer.column.data[v * 2] = 0.25
      layer.column.data[v * 2 + 1] = 0.5
    }

    const out = gatherDrawAttr(mesh, tris(mesh), 'tint', 4)!

    for (let i = 0; i < out.length; i += 4) {
      expect(out[i]).toBeCloseTo(0.25, 6)
      expect(out[i + 1]).toBeCloseTo(0.5, 6)
      expect(out[i + 2]).toBe(0)
      expect(out[i + 3]).toBe(1)
    }
  })

  test('a wide layer into a narrow request truncates', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    const layer = mesh.attrs.add(Domain.VERT, 'rgb', AttrType.Float3)
    for (const v of mesh.v) {
      layer.column.data[v * 3] = 1
      layer.column.data[v * 3 + 1] = 2
      layer.column.data[v * 3 + 2] = 3
    }

    const out = gatherDrawAttr(mesh, tris(mesh), 'rgb', 2)!

    for (let i = 0; i < out.length; i += 2) {
      expect(out[i]).toBe(1)
      expect(out[i + 1]).toBe(2)
    }
  })

  test('a byte layer is copied numerically, not normalized', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    const layer = mesh.attrs.add(Domain.VERT, 'flags', AttrType.Byte)
    for (const v of mesh.v) {
      layer.column.data[v] = 255
    }

    const out = gatherDrawAttr(mesh, tris(mesh), 'flags', 1)!

    for (const x of out) {
      expect(x).toBe(255)
    }
  })
})

describe('drawAttrNames', () => {
  test('dot-prefixed and boolean layers are not material inputs', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    mesh.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)
    mesh.attrs.add(Domain.VERT, '.select', AttrType.Bool, AttrFlags.TEMP)
    mesh.attrs.add(Domain.VERT, 'pinned', AttrType.Bool)

    const names = drawAttrNames(mesh)

    expect(names).toContain('uv')
    expect(names).not.toContain('.select')
    expect(names).not.toContain('pinned')
  })

  test('one name shared across two domains is reported once', () => {
    const mesh = new LeafMesh()
    makePlane(mesh, 2)

    mesh.attrs.add(Domain.VERT, 'uv', AttrType.Float2)
    mesh.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)

    expect(drawAttrNames(mesh).filter((n) => n === 'uv')).toHaveLength(1)
  })
})
