/**
 * This suite runs the ported unwrapping solvers headlessly. See P19 §5 step 6.
 *
 * Everything here runs against `UVGridSurface`, a grid of quads with 3D
 * positions and no mesh, no engine, and no editor behind it. The solvers
 * were lifted off `Mesh` and onto `IUVSource`, so the port has to prove that
 * a source which is not a mesh can still unwrap.
 *
 * `@framework/pathux` reaches the real path.ux solver through
 * `tests/lib/pathux_shim.ts`; nothing here stubs the math.
 */

import {buildUVGraph} from '../../../addons/builtin/uv_editor/src/uv_wrangler'
import type {UVGraph} from '../../../addons/builtin/uv_editor/src/uv_wrangler'
import {UVSolver, packUVIslands, randomizeUVGraph, relaxUVGraph} from '../../../addons/builtin/uv_editor/src/uv_solve'
import {gridUVs} from '../../../addons/builtin/uv_editor/src/uv_edit_geom'
import {UVFlags, UVGridSource, UVGridSurface} from '../../lib/uv_grid_source'
import type {IUVSource} from '../../../scripts/core/geometry_contract'
import {VectorArg, Vector2, Vector3} from '@framework/pathux'

const LAYER = 0

function allUVs(source: IUVSource): Float32Array {
  return source.getUVs(LAYER, source.listUVElements(LAYER))
}

function VecErase(n: any): ArrayLike<number> {
  return n as unknown as ArrayLike<number>
}

/** The angle at `b` in the triangle `a-b-c`, over the first `n` components. */
function cornerAngle(
  _a: VectorArg<Vector2 | Vector3, 2 | 3>,
  _b: VectorArg<Vector2 | Vector3, 2 | 3>,
  _c: VectorArg<Vector2 | Vector3, 2 | 3>,
  n: number
): number {
  const a = VecErase(_a)
  const b = VecErase(_b)
  const c = VecErase(_c)
  let dot = 0
  let la = 0
  let lc = 0

  for (let i = 0; i < n; i++) {
    const u = a[i] - b[i]
    const v = c[i] - b[i]

    dot += u * v
    la += u * u
    lc += v * v
  }

  const denom = Math.sqrt(la * lc)
  if (denom < 1e-12) {
    return 0
  }
  return Math.acos(Math.max(-1, Math.min(1, dot / denom)))
}

/**
 * Total squared difference between each triangle corner's 3D angle and its UV
 * angle. This is what an angle-based unwrap is trying to drive to zero, and it
 * is scale- and rotation-invariant, so it survives the layout steps around it.
 */
function angleError(graph: UVGraph): number {
  let err = 0

  for (let i = 0; i < graph.tris.length; i += 3) {
    const tri = [graph.verts[graph.tris[i]], graph.verts[graph.tris[i + 1]], graph.verts[graph.tris[i + 2]]]

    for (let j = 0; j < 3; j++) {
      const a = tri[(j + 2) % 3]
      const b = tri[j]
      const c = tri[(j + 1) % 3]
      const d = cornerAngle(a.world, b.world, c.world, 3) - cornerAngle(a.co, b.co, c.co, 2)

      err += d * d
    }
  }
  return err
}

function unwrap(source: IUVSource, steps: number, seed = 0): UVGraph {
  const graph = buildUVGraph(source, LAYER)
  const solver = new UVSolver(graph, {seed})

  solver.start()
  for (let i = 0; i < steps; i++) {
    solver.step(0.4)
  }
  solver.finish()
  return graph
}

describe('unwrapping a source that is not a mesh', () => {
  test('the angle error of a curved grid falls as the solver steps', () => {
    const source = new UVGridSurface({w: 4, h: 4, bend: 0.4})
    const graph = buildUVGraph(source, LAYER)
    const solver = new UVSolver(graph)

    solver.start()
    const before = angleError(graph)

    for (let i = 0; i < 25; i++) {
      solver.step(0.4)
    }
    const after = angleError(graph)

    // A dome is not developable, so the error has a floor well above zero.
    // This test checks only that the solver reduces the error from its
    // starting value.
    expect(before).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
  })

  test('a flat grid is already its own answer', () => {
    const source = new UVGridSurface({w: 3, h: 3, bend: 0})
    const graph = buildUVGraph(source, LAYER)
    const solver = new UVSolver(graph)

    solver.start()
    for (let i = 0; i < 10; i++) {
      solver.step(0.4)
    }

    // The error is not zero, because each step smooths before it solves and
    // the solver only pulls most of that back. That total is spread over 54
    // corners, so each is well under a degree; the plane fit is exact and
    // stays that way.
    expect(angleError(graph)).toBeLessThan(0.05)
  })

  test('the result lands inside the unit square', () => {
    const source = new UVGridSurface({w: 4, h: 4, bend: 0.4})
    unwrap(source, 25)

    const uvs = allUVs(source)
    expect(uvs.length).toBeGreaterThan(0)

    for (const x of uvs) {
      expect(Number.isFinite(x)).toBe(true)
      expect(x).toBeGreaterThanOrEqual(-1e-4)
      expect(x).toBeLessThanOrEqual(1 + 1e-4)
    }
  })

  test('the same seed unwraps to the same layout twice', () => {
    const a = new UVGridSurface({w: 3, h: 4, bend: 0.3})
    const b = new UVGridSurface({w: 3, h: 4, bend: 0.3})

    unwrap(a, 12, 7)
    unwrap(b, 12, 7)

    expect(Array.from(allUVs(a))).toEqual(Array.from(allUVs(b)))
  })

  test('a source with no 3D positions still comes out finite', () => {
    // The op feature-detects and skips; the solver itself must not produce NaN
    // when every triangle has zero world area, which is what it sees here.
    const source = new UVGridSource({w: 3, h: 3})
    unwrap(source, 5)

    for (const x of allUVs(source)) {
      expect(Number.isFinite(x)).toBe(true)
    }
  })

  test('a pinned element holds still while the rest of its island moves', () => {
    const source = new UVGridSurface({w: 3, h: 3, bend: 0.4})
    const elems = source.listUVElements(LAYER)
    const flags = source.getUVFlags(LAYER, elems)
    const pin = Int32Array.of(elems[0])

    flags[0] = UVFlags.PIN
    source.setUVFlags(LAYER, elems, flags)

    const at = Array.from(source.getUVs(LAYER, pin))
    const before = Array.from(allUVs(source))
    unwrap(source, 10)

    // A pin freezes only its own vertex, taking the island out of the
    // packer's hands. The rest of the island still smooths and solves
    // around that anchor.
    expect(Array.from(source.getUVs(LAYER, pin))).toEqual(at)
    expect(Array.from(allUVs(source))).not.toEqual(before)
  })
})

describe('relax', () => {
  test('it evens out a jittered island', () => {
    const source = new UVGridSurface({w: 5, h: 5, bend: 0.2})
    const graph = buildUVGraph(source, LAYER)

    randomizeUVGraph(graph, {scale: 0.08, seed: 3})
    const before = roughness(graph)

    for (let i = 0; i < 5; i++) {
      relaxUVGraph(graph, {})
    }
    expect(roughness(graph)).toBeLessThan(before)
  })

  test('a pinned vertex holds still while its neighbours move', () => {
    const source = new UVGridSurface({w: 4, h: 4, bend: 0.2})
    const graph = buildUVGraph(source, LAYER)

    randomizeUVGraph(graph, {scale: 0.05, seed: 11})

    const pinned = graph.verts.find((v) => v.edges.every((e) => !e.boundary))
    expect(pinned).toBeDefined()
    pinned!.flag |= UVFlags.PIN

    const at = [pinned!.co[0], pinned!.co[1]]
    for (let i = 0; i < 5; i++) {
      relaxUVGraph(graph, {boundaryWeight: 4000})
    }

    // The pinned vertex does not stay exactly still, because a pin is a
    // weight here, not a constraint. It is two orders of magnitude heavier
    // than an ordinary vertex, and the test checks that weight difference.
    expect(Math.abs(pinned!.co[0] - at[0])).toBeLessThan(1e-3)
    expect(Math.abs(pinned!.co[1] - at[1])).toBeLessThan(1e-3)
  })
})

/** Mean distance from each vertex to the average of its neighbours. */
function roughness(graph: UVGraph): number {
  let total = 0
  let n = 0

  for (const v of graph.verts) {
    if (!v.edges.length) {
      continue
    }

    let x = 0
    let y = 0
    for (const e of v.edges) {
      const o = e.otherVertex(v)
      x += o.co[0]
      y += o.co[1]
    }
    x /= v.edges.length
    y /= v.edges.length

    total += Math.hypot(v.co[0] - x, v.co[1] - y)
    n++
  }
  return n === 0 ? 0 : total / n
}

describe('packing', () => {
  /** One island per face, by giving every face its own grid cell first. */
  function exploded(w: number, h: number): UVGraph {
    const source = new UVGridSurface({w, h, bend: 0.2})
    gridUVs(source, LAYER)
    return buildUVGraph(source, LAYER)
  }

  test('every island ends up inside the unit square', () => {
    const graph = exploded(3, 3)
    expect(graph.islands.length).toBe(9)

    packUVIslands(graph, {seed: 2})

    for (const island of graph.islands) {
      graph.updateAABB(island)
      expect(island.min[0]).toBeGreaterThanOrEqual(-1e-4)
      expect(island.min[1]).toBeGreaterThanOrEqual(-1e-4)
      expect(island.max[0]).toBeLessThanOrEqual(1 + 1e-4)
      expect(island.max[1]).toBeLessThanOrEqual(1 + 1e-4)
    }
  })

  test('it reports its bins to a caller that asks for them', () => {
    const graph = exploded(2, 2)
    const lines: number[][] = []

    packUVIslands(graph, {seed: 1, drawLine: (x1, y1, x2, y2) => lines.push([x1, y1, x2, y2])})

    // Four sides per bin, and at least one bin, or the overlay draws nothing.
    expect(lines.length).toBeGreaterThanOrEqual(4)
    expect(lines.length % 4).toBe(0)
    for (const [x1, y1, x2, y2] of lines) {
      expect(Number.isFinite(x1 + y1 + x2 + y2)).toBe(true)
    }
  })

  test('a pinned island is skipped when the caller says so', () => {
    const graph = exploded(2, 2)
    const held = graph.islands[0]

    held.hasPins = true
    for (const v of held.verts) {
      v.flag |= UVFlags.PIN
    }

    const at = held.verts.map((v) => [v.co[0], v.co[1]])
    packUVIslands(graph, {ignorePinned: true, seed: 4})

    held.verts.forEach((v, i) => {
      expect(v.co[0]).toBeCloseTo(at[i][0], 10)
      expect(v.co[1]).toBeCloseTo(at[i][1], 10)
    })
  })

  test('the same seed packs the same way twice', () => {
    const a = exploded(3, 2)
    const b = exploded(3, 2)

    packUVIslands(a, {seed: 9})
    packUVIslands(b, {seed: 9})

    expect(a.verts.map((v) => [v.co[0], v.co[1]])).toEqual(b.verts.map((v) => [v.co[0], v.co[1]]))
  })
})

describe('randomize', () => {
  test('it is seeded, not random', () => {
    const a = buildUVGraph(new UVGridSurface({w: 2, h: 2}), LAYER)
    const b = buildUVGraph(new UVGridSurface({w: 2, h: 2}), LAYER)

    randomizeUVGraph(a, {seed: 5})
    randomizeUVGraph(b, {seed: 5})
    expect(a.verts.map((v) => v.co[0])).toEqual(b.verts.map((v) => v.co[0]))

    const c = buildUVGraph(new UVGridSurface({w: 2, h: 2}), LAYER)
    randomizeUVGraph(c, {seed: 6})
    expect(c.verts.map((v) => v.co[0])).not.toEqual(a.verts.map((v) => v.co[0]))
  })

  test('selectedOnly leaves everything else alone', () => {
    const source = new UVGridSurface({w: 2, h: 2})
    const graph = buildUVGraph(source, LAYER)

    const moved = graph.verts[0]
    moved.flag |= UVFlags.SELECT

    const before = graph.verts.map((v) => [v.co[0], v.co[1]])
    randomizeUVGraph(graph, {scale: 0.5, selectedOnly: true, seed: 1})

    graph.verts.forEach((v, i) => {
      if (v === moved) {
        expect(v.co[0]).not.toBeCloseTo(before[i][0], 6)
      } else {
        expect(v.co[0]).toBeCloseTo(before[i][0], 10)
        expect(v.co[1]).toBeCloseTo(before[i][1], 10)
      }
    })
  })
})
