/**
 * The selection overlay's geometry (P12 §4, step 2). `overlay_geom.ts` decides
 * what the viewport shows without touching `scripts/`, so the whole decision —
 * which primitives, which colours, how far off the surface — is checked here
 * rather than by eye.
 */

import {Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {
  DEFAULT_OVERLAY_THEME,
  OVERLAY_LIFT,
  buildSelectionOverlay,
  meshDiagonal,
  overlayCacheKey,
  overlayVertexNormals,
} from '../../../addons/builtin/leafmesh/src/overlay_geom'
import type {OverlayRequest, Rgba} from '../../../addons/builtin/leafmesh/src/overlay_geom'
import {makeCube, makeGrid} from '../../../addons/builtin/leafmesh/src/primitives'
import {applySelection, ensureSelectFlags} from '../../../addons/builtin/leafmesh/src/select_geom'
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

function request(over: Partial<OverlayRequest> = {}): OverlayRequest {
  return {
    domains      : [Domain.VERT, Domain.EDGE, Domain.FACE],
    drawSelection: true,
    drawWireframe: true,
    drawPoints   : true,
    ...over,
  }
}

/** The RGBA at emitted vertex `i`, to f32 tolerance. */
function expectColorAt(color: Float32Array, i: number, want: Rgba): void {
  for (let k = 0; k < 4; k++) {
    expect(color[i * 4 + k]).toBeCloseTo(want[k], 6)
  }
}

/** How far emitted vertex `i` sits from the nearest vertex of `mesh`. */
function liftOf(mesh: LeafMesh, co: Float32Array, i: number): number {
  let best = Infinity
  for (const v of mesh.v) {
    const d = Math.hypot(
      co[i * 3] - mesh.v.co[v * 3],
      co[i * 3 + 1] - mesh.v.co[v * 3 + 1],
      co[i * 3 + 2] - mesh.v.co[v * 3 + 2]
    )
    if (d < best) {
      best = d
    }
  }
  return best
}

function countLive(mesh: LeafMesh, domain: Domain): number {
  let n = 0
  const iter = domain === Domain.VERT ? mesh.v : domain === Domain.EDGE ? mesh.e : mesh.f
  for (const _ of iter) {
    n++
  }
  return n
}

describe('what the overlay emits', () => {
  test('a point per vertex and a line per edge, with nothing selected', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)

    const geom = buildSelectionOverlay(mesh, request())

    expect(geom.points.count).toBe(countLive(mesh, Domain.VERT))
    expect(geom.lines.count).toBe(countLive(mesh, Domain.EDGE) * 2)
    expect(geom.tris.count).toBe(0)
  })

  test('the toggles turn their own batch off and nothing else', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)

    expect(buildSelectionOverlay(mesh, request({drawPoints: false})).points.count).toBe(0)
    expect(buildSelectionOverlay(mesh, request({drawPoints: false})).lines.count).toBeGreaterThan(0)
    expect(buildSelectionOverlay(mesh, request({drawWireframe: false})).lines.count).toBe(0)
    expect(buildSelectionOverlay(mesh, request({drawWireframe: false})).points.count).toBeGreaterThan(0)
  })

  test('a domain missing from the sel-mode draws no selection for it', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    applySelection(mesh, Domain.FACE, [0], 'add')

    const off = buildSelectionOverlay(mesh, request({domains: [Domain.VERT, Domain.EDGE]}))
    expect(off.tris.count).toBe(0)

    const on = buildSelectionOverlay(mesh, request({domains: [Domain.FACE]}))
    expect(on.tris.count).toBeGreaterThan(0)
  })

  test('with the wireframe off, only selected edges draw', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    applySelection(mesh, Domain.EDGE, [3, 5], 'add')

    const geom = buildSelectionOverlay(mesh, request({drawWireframe: false}))
    expect(geom.lines.count).toBe(4)
  })

  test('a selected face is triangulated, holes excluded', () => {
    const {mesh, face} = holedQuad()
    applySelection(mesh, Domain.FACE, [face], 'add')

    const geom = buildSelectionOverlay(mesh, request({domains: [Domain.FACE]}))

    // Eight boundary vertices around an annulus triangulate to eight tris.
    expect(geom.tris.count).toBe(8 * 3)
  })

  test('an empty mesh emits nothing rather than NaNs', () => {
    const geom = buildSelectionOverlay(new LeafMesh(), request())

    expect(geom.points.count).toBe(0)
    expect(geom.lines.count).toBe(0)
    expect(geom.tris.count).toBe(0)
    expect(meshDiagonal(new LeafMesh())).toBe(0)
  })
})

describe('colours', () => {
  test('selection, active and highlight each win in turn', () => {
    const mesh = new LeafMesh()
    makeGrid(mesh, 2, 2)
    ensureSelectFlags(mesh, Domain.VERT)
    applySelection(mesh, Domain.VERT, [0, 1], 'add')

    const geom = buildSelectionOverlay(
      mesh,
      request({drawWireframe: false, active: {[Domain.VERT]: 1}, highlight: {[Domain.VERT]: 0}})
    )

    const verts = [...mesh.v]
    expectColorAt(geom.points.color, verts.indexOf(0), DEFAULT_OVERLAY_THEME.highlight)
    expectColorAt(geom.points.color, verts.indexOf(1), DEFAULT_OVERLAY_THEME.active)
    expectColorAt(geom.points.color, verts.indexOf(2), DEFAULT_OVERLAY_THEME.vert)
  })

  test('a face fill keeps the theme alpha whatever tint it takes', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const face = [...mesh.f][0]

    const geom = buildSelectionOverlay(mesh, request({domains: [Domain.FACE], highlight: {[Domain.FACE]: face}}))

    expect(geom.tris.count).toBeGreaterThan(0)
    const hl = DEFAULT_OVERLAY_THEME.highlight
    expectColorAt(geom.tris.color, 0, [hl[0], hl[1], hl[2], DEFAULT_OVERLAY_THEME.face[3]])
  })

  test('a theme override reaches the emitted colours', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const theme = {...DEFAULT_OVERLAY_THEME, vert: [0.25, 0.5, 0.75, 1] as Rgba}

    const geom = buildSelectionOverlay(mesh, request({drawWireframe: false, theme}))
    expectColorAt(geom.points.color, 0, theme.vert)
  })
})

describe('lifting the overlay off the surface', () => {
  test('every emitted point sits outside the surface, by a scale-relative amount', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)

    const geom = buildSelectionOverlay(mesh, request({drawWireframe: false}))
    const no = overlayVertexNormals(mesh)
    const lift = meshDiagonal(mesh) * OVERLAY_LIFT

    expect(lift).toBeGreaterThan(0)

    const verts = [...mesh.v]
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i]
      for (let k = 0; k < 3; k++) {
        expect(geom.points.co[i * 3 + k]).toBeCloseTo(mesh.v.co[v * 3 + k] + no[v * 3 + k] * lift, 6)
      }
    }
  })

  test('a face fill is lifted less than the wires over it', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const face = [...mesh.f][0]
    applySelection(mesh, Domain.FACE, [face], 'add')

    const geom = buildSelectionOverlay(mesh, request())
    const lift = meshDiagonal(mesh) * OVERLAY_LIFT

    expect(geom.tris.count).toBeGreaterThan(0)
    for (let i = 0; i < geom.tris.count; i++) {
      expect(liftOf(mesh, geom.tris.co, i)).toBeCloseTo(lift * 0.5, 6)
    }
    for (let i = 0; i < geom.points.count; i++) {
      expect(liftOf(mesh, geom.points.co, i)).toBeCloseTo(lift, 6)
    }
  })

  test('vertex normals are unit length and do not touch the mesh normal column', () => {
    const mesh = new LeafMesh()
    makeCube(mesh)
    const before = Float32Array.from(mesh.v.no)

    const no = overlayVertexNormals(mesh)
    for (const v of mesh.v) {
      expect(Math.hypot(no[v * 3], no[v * 3 + 1], no[v * 3 + 2])).toBeCloseTo(1, 6)
    }

    expect(Array.from(mesh.v.no)).toEqual(Array.from(before))
  })
})

describe('the cache key', () => {
  test('changes with the generation, the toggles and the marks', () => {
    const base = request()
    const key = overlayCacheKey(1, base)

    expect(overlayCacheKey(1, base)).toBe(key)
    expect(overlayCacheKey(2, base)).not.toBe(key)
    expect(overlayCacheKey(1, {...base, drawPoints: false})).not.toBe(key)
    expect(overlayCacheKey(1, {...base, domains: [Domain.VERT]})).not.toBe(key)
    expect(overlayCacheKey(1, {...base, active: {[Domain.EDGE]: 3}})).not.toBe(key)
    expect(overlayCacheKey(1, {...base, highlight: {[Domain.FACE]: 0}})).not.toBe(key)
  })

  test('domain order is not part of the key', () => {
    expect(overlayCacheKey(1, request({domains: [Domain.FACE, Domain.VERT]}))).toBe(
      overlayCacheKey(1, request({domains: [Domain.VERT, Domain.FACE]}))
    )
  })
})
