/**
 * The CDT vectors ported from sculptcore's tests/test_constrained_delaunay.cc.
 * These are the parity anchor: if the TS port ever drifts from the C++, a face
 * changes shape when it crosses the backend seam, and these cases are what
 * catches it.
 */

import {cdt2d} from '../../../addons/builtin/leafmesh/src/cdt2d'

type Pt = [number, number]

function shoelace(poly: readonly Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a * 0.5
}

function triArea2(a: Pt, b: Pt, c: Pt): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5
}

/** Even-odd ray cast against every ring, so a point in a hole reads outside. */
function pointInPolys(rings: readonly (readonly Pt[])[], p: Pt): boolean {
  let inside = false
  for (const poly of rings) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]
      const b = poly[j]
      if (a[1] > p[1] !== b[1] > p[1]) {
        const x = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
        if (p[0] < x) {
          inside = !inside
        }
      }
    }
  }
  return inside
}

/** Flatten rings into the (points, closed constraint rings) cdt2d takes. */
function build(rings: readonly (readonly Pt[])[]): {points: Float64Array; constraints: Int32Array} {
  const points: number[] = []
  const constraints: number[] = []

  for (const ring of rings) {
    const base = points.length / 2
    for (const p of ring) {
      points.push(p[0], p[1])
    }
    for (let i = 0; i < ring.length; i++) {
      constraints.push(base + i, base + ((i + 1) % ring.length))
    }
  }
  return {points: Float64Array.from(points), constraints: Int32Array.from(constraints)}
}

/** Assert the triangulation tiles the rings exactly and lies inside them. */
function expectTiles(rings: readonly (readonly Pt[])[], expectedTris: number): void {
  const {points, constraints} = build(rings)
  const {tris, ok} = cdt2d(points, constraints)

  expect(ok).toBe(true)
  expect(tris.length).toBe(expectedTris * 3)

  const flat = rings.flat()
  let polyArea = Math.abs(shoelace(rings[0]))
  for (let i = 1; i < rings.length; i++) {
    polyArea -= Math.abs(shoelace(rings[i]))
  }

  let area = 0
  for (let i = 0; i < tris.length; i += 3) {
    const a = flat[tris[i]]
    const b = flat[tris[i + 1]]
    const c = flat[tris[i + 2]]

    // Every emitted triangle is counter-clockwise.
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
    expect(cross).toBeGreaterThan(0)

    area += triArea2(a, b, c)

    const centroid: Pt = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]
    expect(pointInPolys(rings, centroid)).toBe(true)
  }

  expect(area).toBeCloseTo(polyArea, 4)
}

describe('cdt2d', () => {
  test('triangulates a convex square', () => {
    expectTiles(
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
      2
    )
  })

  test('triangulates a convex hexagon', () => {
    const hex: Pt[] = []
    for (let i = 0; i < 6; i++) {
      const a = (2 * Math.PI * i) / 6
      hex.push([Math.cos(a), Math.sin(a)])
    }
    expectTiles([hex], 4)
  })

  test('triangulates a concave U without escaping the notch', () => {
    const u: Pt[] = [
      [0, 0],
      [3, 0],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ]
    expectTiles([u], 6)
  })

  test('triangulates a five-point star', () => {
    const star: Pt[] = []
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 2.0 : 0.8
      const a = -1.5707963 + (2 * Math.PI * i) / 10
      star.push([r * Math.cos(a), r * Math.sin(a)])
    }
    expectTiles([star], 8)
  })

  // The hole ring's winding must not matter: the parity flood fill only cares
  // that a constraint was crossed.
  for (const reverseHole of [false, true]) {
    const label = reverseHole ? 'clockwise' : 'counter-clockwise'

    test(`triangulates a square with a ${label} square hole`, () => {
      const outer: Pt[] = [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ]
      const hole: Pt[] = [
        [1, 1],
        [3, 1],
        [3, 3],
        [1, 3],
      ]
      if (reverseHole) {
        hole.reverse()
      }

      expectTiles([outer, hole], 8)

      const {points, constraints} = build([outer, hole])
      const {tris} = cdt2d(points, constraints)
      const flat = [...outer, ...hole]
      let area = 0
      for (let i = 0; i < tris.length; i += 3) {
        area += triArea2(flat[tris[i]], flat[tris[i + 1]], flat[tris[i + 2]])
      }
      expect(area).toBeCloseTo(12, 4)
    })
  }

  test('returns empty and succeeds on fewer than three points', () => {
    const result = cdt2d(Float64Array.from([0, 0, 1, 0]), Int32Array.from([0, 1, 1, 0]))
    expect(result.ok).toBe(true)
    expect(result.tris.length).toBe(0)
  })

  test('returns empty and succeeds on collinear points', () => {
    const points: number[] = []
    const constraints: number[] = []
    for (let i = 0; i < 5; i++) {
      points.push(i, 0)
      constraints.push(i, (i + 1) % 5)
    }
    const result = cdt2d(Float64Array.from(points), Int32Array.from(constraints))
    expect(result.ok).toBe(true)
    expect(result.tris.length).toBe(0)
  })

  test('rejects a self-intersecting boundary instead of throwing', () => {
    const bowtie: Pt[] = [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ]
    const {points, constraints} = build([bowtie])
    const result = cdt2d(points, constraints)
    expect(result.ok).toBe(false)
    expect(result.tris.length).toBe(0)
  })

  test('returns empty with no constraints, since interior is undefined', () => {
    const points = Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1])
    const result = cdt2d(points, new Int32Array(0))
    expect(result.ok).toBe(true)
    expect(result.tris.length).toBe(0)
  })

  test('deduplicates coincident input points', () => {
    const square: Pt[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    const {constraints} = build([square])
    // A fifth point sitting on top of the first must not create a sliver.
    const points = Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1, 1e-12, 1e-12])
    const result = cdt2d(points, constraints)
    expect(result.ok).toBe(true)
    expect(result.tris.length).toBe(6)
  })
})
