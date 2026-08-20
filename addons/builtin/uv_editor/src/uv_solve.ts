/**
 * The unwrapping solvers, on the welded graph — P19 §5 step 2.
 *
 * A port of `unwrapping_solve.ts`, which was deleted with the rest of
 * `archive/unwrapping/` once this landed
 * (`git show 8d4ee0c4:archive/unwrapping/unwrapping_solve.ts`). Same
 * angle-constraint objective, same Gauss-Seidel iteration, same smoothing
 * schedule, same bin packer. What moved is where the data lives — `UVGraph`
 * (uv_wrangler.ts) instead of a second BREP mesh built alongside the first, and
 * typed scratch keyed by `UVVert.index` instead of a `CustomDataElem` layer.
 *
 * Three pieces of the archive are absent because they were already dead there:
 * the area constraint (built, evaluated, and never added to a solver), the
 * least-squares `solveIntern` (its only call site commented out, and it needed
 * a `window.numeric` global nothing ships), and `save`/`restore`, which parked
 * solver state in a `window` map keyed by `lib_id` so a second click continued
 * the first one's solve. Rebuilding per run costs one graph build and is what
 * makes the op replayable, which undo needs.
 *
 * Nothing here imports the host at runtime, the same property `uv_edit_geom.ts`
 * has and for the same reason: unwrapping is testable with no engine, no app
 * and no geometry behind the source. The one host coupling the archive did
 * have — the packer reporting its bins to `ImageBus` — is a callback here.
 */

import {Constraint, Matrix4, Solver, Vector2, Vector3, math} from '@framework/pathux'

import {UV_PIN, UV_SELECT} from './uv_edit_geom.js'
import type {UVGraph, UVIsland, UVVert} from './uv_wrangler.js'

/** Finite-difference step the angle constraint's gradients use. */
const CON_DF = 0.0001

/** `step()`'s schedule: three smoothing rounds at 0.75, then one solve. */
const SMOOTH_ROUNDS = 3
const SMOOTH_FAC = 0.75

/** Smoothing weights: a boundary vertex resists, a pinned neighbour dominates. */
const CORNER_WEIGHT = 10.0
const PIN_WEIGHT = 10000.0

/** How much of a solve step survives into the next one. */
const SOLVE_DAMP = 0.95

/** Relax leaves islands smaller than this alone; averaging just collapses them. */
const RELAX_MIN_VERTS = 5

/** Packing: how deep the recursive split may go, and the gap around a cell. */
const PACK_MAX_DEPTH = 10
const PACK_MARGIN = 0.001

/** Orientation search: a quarter turn in this many steps, smallest box wins. */
const PACK_ROT_STEPS = 16

/** Total island area after the pre-pack rescale, as a fraction of the UV square. */
const PACK_FILL = 0.75

/**
 * Deterministic by choice, not by accident: the archived packer called
 * `Math.random()`, so a ToolOp redo laid the islands out differently from the
 * run that was undone. Seeded per call, the layout is a function of its inputs.
 */
class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /** Mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0

    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// The angle constraint
// ---------------------------------------------------------------------------

/** `[v1, v2, v3, goal angle at v2]` — the archived parameter tuple. */
type AngleParams = readonly [UVVert, UVVert, UVVert, number]

const _a1 = new Vector3()
const _a2 = new Vector3()

/**
 * Squared error between the UV angle at `v2` and the 3D angle it should have.
 *
 * Taken from the 2D cross product rather than a dot product so that it keeps
 * its sign: a triangle that has flipped over reports a negative angle and gets
 * pulled back, where `acos` would report the same value either way.
 */
function angle_c(params: AngleParams): number {
  const v1 = params[0]
  const v2 = params[1]
  const v3 = params[2]
  const goalth = params[3]

  v1.co[2] = v2.co[2] = v3.co[2] = 0.0

  _a1.load(v1.co).sub(v2.co).normalize()
  _a2.load(v3.co).sub(v2.co).normalize()

  const th = Math.asin(-(_a1[1] * _a2[0] - _a1[0] * _a2[1]) * 0.99999)
  const ret = th - goalth

  return ret * ret
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/** One triangle of the welded graph, with the two areas the solver compares. */
export class SolveTri {
  v1: UVVert
  v2: UVVert
  v3: UVVert

  /** Area in UV space, refreshed whenever the solver is rebuilt. */
  area: number

  /** Area in 3D. Zero when the source has no positions, which disables it. */
  worldArea: number

  constructor(v1: UVVert, v2: UVVert, v3: UVVert) {
    this.v1 = v1
    this.v2 = v2
    this.v3 = v3

    this.area = math.tri_area(v1.co, v2.co, v3.co)
    this.worldArea = math.tri_area(v1.world, v2.world, v3.world)
  }
}

export interface UVSolveOptions {
  /** Leave islands where they are: no plane fit, no normalize, no packing. */
  preserveIslands?: boolean

  /** Only touch islands carrying a selected UV element. */
  selectedIslandsOnly?: boolean

  /** Seed for the packer; the same seed always gives the same layout. */
  seed?: number
}

/**
 * The archived `UnWrapSolver`. Usage is `start()`, then `step()` until the
 * caller's time budget runs out, then `finish()`.
 *
 * Only `finish()` writes UVs back, where the archive wrote them at the end of
 * every step. That was for a live preview the op no longer has — it now runs
 * inside one `ToolOp.exec`, so an intermediate write would only be undo state
 * nothing can reach.
 */
export class UVSolver {
  graph: UVGraph
  preserveIslands: boolean
  selectedIslandsOnly: boolean
  seed: number

  tris: SolveTri[] = []
  solvers: Solver[] = []
  tottri = 0

  /** Velocity and previous position per vertex, two components each. */
  private vel: Float64Array
  private oldco: Float64Array

  private vertTris: SolveTri[][]

  constructor(graph: UVGraph, opts: UVSolveOptions = {}) {
    this.graph = graph
    this.preserveIslands = opts.preserveIslands ?? false
    this.selectedIslandsOnly = opts.selectedIslandsOnly ?? false
    this.seed = opts.seed ?? 0

    const n = graph.verts.length

    this.vel = new Float64Array(n * 2)
    this.oldco = new Float64Array(n * 2)
    this.vertTris = graph.verts.map(() => [])
  }

  /** Whether this run may move `island` at all. */
  private _solvable(island: UVIsland): boolean {
    return !(this.selectedIslandsOnly && !island.hasSel)
  }

  /** Whether `island` gets a fresh layout, rather than only being refined. */
  private _reflowable(island: UVIsland): boolean {
    return this._solvable(island) && !island.hasPins && !this.preserveIslands
  }

  start(): void {
    for (const island of this.graph.islands) {
      if (this._reflowable(island)) {
        this._flatten(island)
      }
    }

    this.buildSolver()
  }

  /**
   * Drop an island onto its own average plane. This is the initial guess the
   * angle solver refines; without it an unwrap starts from whatever UVs were
   * there, which for fresh geometry is usually every corner at the origin.
   */
  private _flatten(island: UVIsland): void {
    const graph = this.graph
    const no = new Vector3()

    // One vote per corner, so an n-gon counts n times: what the archived walk
    // over every loop of every vertex added up to.
    for (const f of island.faces) {
      no.addFac(f.no, f.verts.length)
    }

    if (no.dot(no) < 0.00001) {
      return
    }
    no.normalize()

    const mat = new Matrix4()
    mat.makeNormalMatrix(no)
    mat.invert()

    const co = new Vector3()

    for (const v of island.verts) {
      co.load(v.world)
      co.multVecMatrix(mat)

      v.co[0] = co[0]
      v.co[1] = co[1]
      v.co[2] = 0.0
    }

    graph.updateAABB(island)

    for (const v of island.verts) {
      v.co[0] -= island.min[0]
      v.co[1] -= island.min[1]
    }

    graph.updateAABB(island)
  }

  /**
   * Build the per-island constraint sets from the graph's triangles. `start()`
   * calls this; call it again only if positions were replaced wholesale, since
   * the constraints hold references into `UVVert.co`.
   */
  buildSolver(): void {
    const graph = this.graph

    this.solvers = []
    this.tris = []
    this.tottri = 0

    for (const list of this.vertTris) {
      list.length = 0
    }

    for (let i = 0; i < graph.tris.length; i += 3) {
      const v1 = graph.verts[graph.tris[i]]
      const v2 = graph.verts[graph.tris[i + 1]]
      const v3 = graph.verts[graph.tris[i + 2]]

      // Welding can collapse a triangle to an edge or a point; it has no angles
      // left to constrain.
      if (v1 === v2 || v1 === v3 || v2 === v3) {
        continue
      }

      const tri = new SolveTri(v1, v2, v3)

      this.tris.push(tri)
      this.vertTris[v1.index].push(tri)
      this.vertTris[v2.index].push(tri)
      this.vertTris[v3.index].push(tri)
    }

    for (const v of graph.verts) {
      v.co[2] = 0.0
    }

    // Normalize into a unit box first: the angle error is scale-free but the
    // solver's step size is not, so islands of very different size would
    // otherwise converge at very different rates.
    for (const island of graph.islands) {
      if (!this._reflowable(island)) {
        continue
      }

      graph.updateAABB(island)

      for (const v of island.verts) {
        v.co[0] = (v.co[0] - island.min[0]) / island.boxsize[0]
        v.co[1] = (v.co[1] - island.min[1]) / island.boxsize[1]
        v.co[2] = 0.0
      }
    }

    const rng = new Rng(this.seed + 1)

    for (const island of graph.islands) {
      if (!this._solvable(island)) {
        continue
      }

      const tris = new Set<SolveTri>()
      for (const v of island.verts) {
        for (const tri of this.vertTris[v.index]) {
          tris.add(tri)
        }
      }
      if (tris.size === 0) {
        continue
      }

      let totarea = 0.0
      let totarea2 = 0.0

      for (const tri of tris) {
        this.tottri++
        totarea += tri.area
        totarea2 += tri.worldArea
      }

      // Degenerate or NaN UVs give the gradients nothing to descend, so the
      // island is scattered and re-measured before any constraint sees it.
      if (totarea === 0.0 || isNaN(totarea)) {
        for (const tri of tris) {
          for (const v of [tri.v1, tri.v2, tri.v3]) {
            v.co[0] = rng.next()
            v.co[1] = rng.next()
            v.co[2] = 0.0
          }
        }
      }

      // Nothing to aim at. A source without `getUVElementPositions` lands here
      // for every island: unwrapping is simply not defined for one.
      if (totarea2 === 0.0) {
        continue
      }

      for (const tri of tris) {
        tri.area = math.tri_area(tri.v1.co, tri.v2.co, tri.v3.co)
      }

      const solver = new Solver()
      solver.simple = false

      for (const tri of tris) {
        this._addAngleCon(solver, tri.v1, tri.v2, tri.v3)
        this._addAngleCon(solver, tri.v2, tri.v3, tri.v1)
        this._addAngleCon(solver, tri.v3, tri.v1, tri.v2)
      }

      if (solver.constraints.length > 0) {
        this.solvers.push(solver)
      }
    }
  }

  /** One angle goal, at `v2`, read off the 3D triangle. */
  private _addAngleCon(solver: Solver, v1: UVVert, v2: UVVert, v3: UVVert): void {
    const t1 = new Vector3()
    const t2 = new Vector3()

    t1.load(v1.world).sub(v2.world).normalize()
    t2.load(v3.world).sub(v2.world).normalize()
    t1.cross(t2)

    const goalth = Math.asin(t1.vectorLength() * 0.9999999)

    // A pinned vertex is not a free variable, and a triangle with all three
    // pinned has nothing left to solve for.
    const klst = [v1, v2, v3].filter((v) => !v.hasPins).map((v) => v.co)
    if (klst.length === 0) {
      return
    }

    const con = new Constraint<AngleParams>('angle_c', angle_c, klst, [v1, v2, v3, goalth])
    con.df = CON_DF

    solver.add(con)
  }

  /**
   * One Gauss-Seidel sweep, carried by a velocity term so successive sweeps
   * keep the direction the last one found instead of restarting from rest.
   */
  solve(gk = 1.0): void {
    const graph = this.graph

    for (const v of graph.verts) {
      const i = v.index * 2

      v.co[0] += this.vel[i] * SOLVE_DAMP
      v.co[1] += this.vel[i + 1] * SOLVE_DAMP
      v.co[2] = 0.0

      this.oldco[i] = v.co[0]
      this.oldco[i + 1] = v.co[1]
    }

    for (const slv of this.solvers) {
      slv.solve(1, gk)
      slv.solve(1, gk)
    }

    for (const v of graph.verts) {
      const i = v.index * 2

      this.vel[i] = v.co[0] - this.oldco[i]
      this.vel[i + 1] = v.co[1] - this.oldco[i + 1]
    }
  }

  /** Smooth, then solve. The caller repeats this until its budget is spent. */
  step(gk = 1.0): void {
    for (let i = 0; i < SMOOTH_ROUNDS; i++) {
      this._smooth(SMOOTH_FAC)
    }

    this.solve(gk)
  }

  /** Laplacian smoothing that a boundary resists and a pin overrules. */
  private _smooth(fac: number): void {
    const tmp = new Vector3()

    for (const island of this.graph.islands) {
      if (!this._solvable(island)) {
        continue
      }

      for (const v of island.verts) {
        if (v.hasPins) {
          continue
        }

        const w = v.corner ? CORNER_WEIGHT : 1.0

        tmp.zero()
        tmp.addFac(v.co, w)
        let tot = w

        for (const e of v.edges) {
          const v2 = e.otherVertex(v)
          const w2 = v2.hasPins ? PIN_WEIGHT : 1.0

          tmp.addFac(v2.co, w2)
          tot += w2
        }

        tmp.mulScalar(1.0 / tot)
        v.co.interp(tmp, fac)
        v.co[2] = 0.0
      }
    }
  }

  packIslands(drawLine?: UVPackDrawLine): void {
    packUVIslands(this.graph, {
      ignorePinned: true,
      selectedOnly: this.selectedIslandsOnly,
      seed        : this.seed,
      drawLine,
    })
  }

  /** Re-pack unless asked not to, then push the result back through the source. */
  finish(drawLine?: UVPackDrawLine): void {
    const graph = this.graph

    for (const island of graph.islands) {
      graph.updateAABB(island)
    }

    if (!this.preserveIslands) {
      this.packIslands(drawLine)
    }

    graph.write()
  }
}

// ---------------------------------------------------------------------------
// Relax
// ---------------------------------------------------------------------------

export interface UVRelaxOptions {
  /** How hard an island boundary or a pin resists being averaged away. */
  boundaryWeight?: number

  /** Only move selected UV elements; the rest act as anchors. */
  selectedOnly?: boolean
}

/**
 * Weighted Laplacian relax — the archived `relaxUVs`, minus its walk over the
 * base mesh's seam flags. On the welded graph a seam is already a boundary
 * edge, because corners across one do not weld, so `UVEdge.boundary` answers
 * the same question without reading a mesh attribute.
 */
export function relaxUVGraph(graph: UVGraph, opts: UVRelaxOptions = {}): void {
  const boundaryWeight = opts.boundaryWeight ?? 400.0
  const selectedOnly = opts.selectedOnly ?? false
  const avg = new Vector3()

  for (const island of graph.islands) {
    if (island.verts.length < RELAX_MIN_VERTS) {
      continue
    }

    for (const v of island.verts) {
      if (selectedOnly && (v.flag & UV_SELECT) === 0) {
        continue
      }

      let w = 1.0

      for (const e of v.edges) {
        if (e.boundary) {
          w = boundaryWeight
          break
        }
        // Per edge rather than once — the archive's arithmetic. Either way the
        // effect is that a pinned vertex does not move.
        if (v.hasPins) {
          w += boundaryWeight * 2.0
        }
      }

      avg.zero()
      avg.addFac(v.co, w)
      let tot = w

      for (const e of v.edges) {
        avg.add(e.otherVertex(v).co)
        tot += 1.0
      }

      avg.mulScalar(1.0 / tot)
      v.co.load(avg)
      v.co[2] = 0.0
    }

    graph.updateAABB(island)
  }
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/** Where the packer reports its bin rectangles, when a caller wants them drawn. */
export type UVPackDrawLine = (x1: number, y1: number, x2: number, y2: number) => void

export interface UVPackOptions {
  /** Leave an island containing a pinned element exactly where it is. */
  ignorePinned?: boolean

  /** Only pack islands carrying a selected UV element. */
  selectedOnly?: boolean

  seed?: number
  drawLine?: UVPackDrawLine
}

/**
 * Fit the islands into the unit square: orient each to its smallest box, scale
 * them all so their total area is `PACK_FILL`, then drop them largest-first
 * into a bin that halves itself whenever nothing fits.
 */
export function packUVIslands(graph: UVGraph, opts: UVPackOptions = {}): void {
  const ignorePinned = opts.ignorePinned ?? false
  const selectedOnly = opts.selectedOnly ?? false
  const drawLine = opts.drawLine
  const rng = new Rng(opts.seed ?? 0)

  const islands: UVIsland[] = []
  let totarea = 0.0

  for (const island of graph.islands) {
    if (ignorePinned && island.hasPins) {
      continue
    }
    if (selectedOnly && !island.hasSel) {
      continue
    }

    orientIsland(graph, island)
    islands.push(island)
    totarea += island.area
  }

  if (islands.length === 0 || totarea === 0.0 || isNaN(totarea)) {
    return
  }

  const ratio = PACK_FILL / Math.sqrt(totarea)

  for (const island of islands) {
    for (const v of island.verts) {
      v.co[0] = island.min[0] + (v.co[0] - island.min[0]) * ratio
      v.co[1] = island.min[1] + (v.co[1] - island.min[1]) * ratio
      v.co[2] = 0.0
    }

    graph.updateAABB(island)
  }

  islands.sort((a, b) => b.area - a.area)

  const box = (x1: number, y1: number, x2: number, y2: number): void => {
    if (!drawLine) {
      return
    }
    drawLine(x1, y1, x1, y2)
    drawLine(x1, y2, x2, y2)
    drawLine(x2, y2, x2, y1)
    drawLine(x2, y1, x1, y1)
  }

  const size = new Vector2()

  const rec = (uv1: Vector2, uv2: Vector2, axis: number, depth: number): void => {
    box(uv1[0], uv1[1], uv2[0], uv2[1])

    if (islands.length === 0 || depth > PACK_MAX_DEPTH) {
      return
    }

    size.load(uv2).sub(uv1)

    const area = size[0] * size[1]
    const axis2 = axis ^ 1

    // The best fit is the island closest in area that still fits. The random
    // skip keeps a run of equal-sized islands from always filling the same
    // corner first, which produced visible banding.
    let min = 1e17
    let island: UVIsland | undefined

    for (const island2 of islands) {
      graph.updateAABB(island2)

      if (rng.next() > 0.85) {
        continue
      }
      if (island2.area < area && Math.abs(area - island2.area) < min) {
        min = Math.abs(area - island2.area)
        island = island2
      }
    }

    if (island === undefined || (min > area * 0.5 && depth < PACK_MAX_DEPTH - 1)) {
      const uv3 = new Vector2(uv1)
      const uv4 = new Vector2(uv2)
      const lo = axis === 0 ? uv1[0] : uv1[1]
      const hi = axis === 0 ? uv2[0] : uv2[1]
      const t = lo + (hi - lo) * 0.5

      if (axis === 0) {
        uv3[0] = t
        uv4[0] = t
      } else {
        uv3[1] = t
        uv4[1] = t
      }

      rec(uv1, uv4, axis2, depth + 1)
      rec(uv3, uv2, axis2, depth + 1)
      return
    }

    // Stand the island's long side along the cell's, or it wastes the cell.
    if ((island.boxsize[1] > island.boxsize[0] ? 1 : 0) !== axis) {
      rotateIsland(graph, island, Math.PI * 0.5)
    }

    islands.splice(islands.indexOf(island), 1)

    const cellw = size[0] - PACK_MARGIN * 2.0
    const cellh = size[1] - PACK_MARGIN * 2.0

    // The island keeps its own proportions inside the cell: normalizing to the
    // cell alone would stretch it, and the angle solve's result with it.
    const fit = island.boxsize[0] / island.boxsize[1] / (cellw / cellh)

    for (const v of island.verts) {
      v.co[0] = ((v.co[0] - island.min[0]) / island.boxsize[0]) * cellw + PACK_MARGIN
      v.co[1] = ((v.co[1] - island.min[1]) / island.boxsize[1]) * cellh + PACK_MARGIN

      if (fit > 1.0) {
        v.co[1] /= fit
      } else {
        v.co[0] *= fit
      }

      v.co[0] += uv1[0]
      v.co[1] += uv1[1]
      v.co[2] = 0.0
    }

    graph.updateAABB(island)
  }

  rec(new Vector2([0, 0]), new Vector2([1, 1]), 0, 0)
}

/** Rotate an island about its own box centre, in UV space. */
function rotateIsland(graph: UVGraph, island: UVIsland, th: number): void {
  const cx = island.boxcenter[0]
  const cy = island.boxcenter[1]
  const c = Math.cos(th)
  const s = Math.sin(th)

  for (const v of island.verts) {
    const x = v.co[0] - cx
    const y = v.co[1] - cy

    v.co[0] = cx + x * c - y * s
    v.co[1] = cy + x * s + y * c
    v.co[2] = 0.0
  }

  graph.updateAABB(island)
}

/** Turn an island to whichever angle under a quarter turn boxes it tightest. */
function orientIsland(graph: UVGraph, island: UVIsland): void {
  graph.updateAABB(island)

  const cx = island.boxcenter[0]
  const cy = island.boxcenter[1]
  const orig = new Float64Array(island.verts.length * 2)

  for (let i = 0; i < island.verts.length; i++) {
    orig[i * 2] = island.verts[i].co[0]
    orig[i * 2 + 1] = island.verts[i].co[1]
  }

  const place = (th: number): void => {
    const c = Math.cos(th)
    const s = Math.sin(th)

    for (let i = 0; i < island.verts.length; i++) {
      const x = orig[i * 2] - cx
      const y = orig[i * 2 + 1] - cy
      const v = island.verts[i]

      v.co[0] = cx + x * c - y * s
      v.co[1] = cy + x * s + y * c
      v.co[2] = 0.0
    }

    graph.updateAABB(island)
  }

  const dth = (Math.PI * 0.5) / PACK_ROT_STEPS
  let best = 1e17
  let bestth = 0.0

  for (let i = 0; i < PACK_ROT_STEPS; i++) {
    place(i * dth)

    if (island.area < best) {
      best = island.area
      bestth = i * dth
    }
  }

  place(bestth)
}

// ---------------------------------------------------------------------------
// Randomize
// ---------------------------------------------------------------------------

export interface UVRandomizeOptions {
  /** How far a UV may move, in UV units. */
  scale?: number

  /** Only jitter selected UV elements. */
  selectedOnly?: boolean

  seed?: number
}

/**
 * Jitter every welded vertex. Diagnostic rather than a modelling tool: it is
 * how a degenerate layout gets knocked out of a local minimum before an
 * unwrap, which is what the archived `mesh.randomize_uvs` existed for.
 */
export function randomizeUVGraph(graph: UVGraph, opts: UVRandomizeOptions = {}): void {
  const scale = opts.scale ?? 0.1
  const selectedOnly = opts.selectedOnly ?? false
  const rng = new Rng(opts.seed ?? 0)

  for (const v of graph.verts) {
    if (selectedOnly && (v.flag & UV_SELECT) === 0) {
      continue
    }

    if (isNaN(v.co[0]) || isNaN(v.co[1])) {
      v.co[0] = rng.next()
      v.co[1] = rng.next()
    }

    v.co[0] += (rng.next() - 0.5) * scale
    v.co[1] += (rng.next() - 0.5) * scale
    v.co[2] = 0.0
  }

  for (const island of graph.islands) {
    graph.updateAABB(island)
  }
}

/** True when every welded vertex is pinned, i.e. nothing here can move. */
export function allPinned(graph: UVGraph): boolean {
  for (const v of graph.verts) {
    if ((v.flag & UV_PIN) === 0) {
      return false
    }
  }
  return graph.verts.length > 0
}
