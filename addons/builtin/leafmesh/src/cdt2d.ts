/**
 * Constrained Delaunay triangulation in 2D — a direct port of sculptcore's
 * `constrainedDelaunay2D` (`source/mesh/utils/delaunay.h`).
 *
 * It is a port rather than a reuse of an existing JS triangulator for one
 * reason: **backend parity**. The same face has to come out as the same
 * triangles whether it was triangulated here or in the engine, or a mesh
 * changes shape when it crosses the seam. The C++ function names are kept as
 * the TS names so the two files stay diffable line by line.
 *
 * Holes are not a special case. Every ring — outer and hole alike — goes in as
 * a closed run of constraint edges, and interior classification is a parity
 * flood fill seeded from outside the super-triangle: crossing a constraint
 * toggles inside/outside. That single mechanism is the entire hole support.
 *
 * Known limits, carried over deliberately:
 *  - **No Steiner points.** A constraint that cannot be recovered by flipping
 *    (typically a vertex lying exactly on it) gives up and returns empty, so
 *    the caller can fall back to a fan rather than get a wrong result.
 *  - **Quadratic inner scans.** `cdtFindEdgeTri` / `cdtOtherTri` walk the whole
 *    triangle array. Fine for a face; wrong tool for a point cloud, which is
 *    what `maxTris` and the dev warning are there to make obvious.
 *  - **Not exact predicates.** `inCircumcircle` is an orientation-corrected
 *    determinant in doubles. Robust enough for real geometry, not a guarantee.
 */

export interface Cdt2dOptions {
  /** Lawson flips after constraint recovery. On by default. */
  restoreDelaunay?: boolean
  /** Abort rather than grind if the triangle soup runs away. */
  maxTris?: number
}

export interface Cdt2dResult {
  /** Triangle vertex indices, three per triangle, into the input points. */
  tris: Int32Array
  /**
   * False only when the input is rejected outright — a self-intersecting
   * boundary, or the `maxTris` guard tripping. Degenerate-but-legal input
   * (fewer than three unique points, all-collinear, an unrecoverable
   * constraint) returns empty with `ok: true`, because a caller with a fan
   * fallback wants to take it quietly.
   */
  ok: boolean
}

const DUP_EPS = 1e-7
const COLLINEAR_EPS = 1e-6
const DEFAULT_MAX_TRIS = 1 << 16

/** Edge keys pack two indices into one number; this is the ceiling on both. */
const KEY_STRIDE = 1 << 26

/** Points above this make the quadratic scans the dominant cost. */
const WARN_POINTS = 512

let warned = false

function cross2(ux: number, uy: number, vx: number, vy: number): number {
  return ux * vy - uy * vx
}

/** True if p is strictly inside the circumcircle of (a, b, c). */
function inCircumcircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number
): boolean {
  const orient = cross2(bx - ax, by - ay, cx - ax, cy - ay)
  if (orient === 0) {
    return false
  }

  const dax = ax - px
  const day = ay - py
  const dbx = bx - px
  const dby = by - py
  const dcx = cx - px
  const dcy = cy - py

  let det =
    (dax * dax + day * day) * (dbx * dcy - dcx * dby) -
    (dbx * dbx + dby * dby) * (dax * dcy - dcx * day) +
    (dcx * dcx + dcy * dcy) * (dax * dby - dbx * day)

  if (orient < 0) {
    det = -det
  }
  return det > 0
}

function cdtEdgeKey(a: number, b: number): number {
  return a < b ? a * KEY_STRIDE + b : b * KEY_STRIDE + a
}

/**
 * Proper crossing of the open segments a-b and c-d. A shared endpoint or a
 * collinear touch is not a crossing.
 */
function cdtSegCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): boolean {
  const d1 = cross2(bx - ax, by - ay, cx - ax, cy - ay)
  const d2 = cross2(bx - ax, by - ay, dx - ax, dy - ay)
  const d3 = cross2(dx - cx, dy - cy, ax - cx, ay - cy)
  const d4 = cross2(dx - cx, dy - cy, bx - cx, by - cy)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** The working triangle soup: three vertex indices per slot, plus a liveness bit. */
class TriSoup {
  v: number[] = []
  alive: boolean[] = []

  get length(): number {
    return this.alive.length
  }

  add(a: number, b: number, c: number): number {
    const t = this.alive.length
    this.v.push(a, b, c)
    this.alive.push(true)
    return t
  }

  vert(t: number, s: number): number {
    return this.v[t * 3 + s]
  }
}

/** Index of a live triangle containing both a and b, else -1. */
function cdtFindEdgeTri(tris: TriSoup, a: number, b: number): number {
  for (let t = 0; t < tris.length; t++) {
    if (!tris.alive[t]) {
      continue
    }
    const i = t * 3
    const v0 = tris.v[i]
    const v1 = tris.v[i + 1]
    const v2 = tris.v[i + 2]
    const ha = v0 === a || v1 === a || v2 === a
    const hb = v0 === b || v1 === b || v2 === b
    if (ha && hb) {
      return t
    }
  }
  return -1
}

/** The vertex of triangle t other than a and b. */
function cdtApex(tris: TriSoup, t: number, a: number, b: number): number {
  for (let s = 0; s < 3; s++) {
    const v = tris.v[t * 3 + s]
    if (v !== a && v !== b) {
      return v
    }
  }
  return -1
}

/** The other live triangle sharing edge (a, b), excluding `exclude`, else -1. */
function cdtOtherTri(tris: TriSoup, a: number, b: number, exclude: number): number {
  for (let t = 0; t < tris.length; t++) {
    if (t === exclude || !tris.alive[t]) {
      continue
    }
    const i = t * 3
    const v0 = tris.v[i]
    const v1 = tris.v[i + 1]
    const v2 = tris.v[i + 2]
    const ha = v0 === a || v1 === a || v2 === a
    const hb = v0 === b || v1 === b || v2 === b
    if (ha && hb) {
      return t
    }
  }
  return -1
}

/** Flip the diagonal shared by t1, t2 from (c, d) to (e, g). */
function cdtFlip(tris: TriSoup, t1: number, t2: number, c: number, d: number, e: number, g: number): void {
  tris.v[t1 * 3] = e
  tris.v[t1 * 3 + 1] = g
  tris.v[t1 * 3 + 2] = c
  tris.v[t2 * 3] = e
  tris.v[t2 * 3 + 1] = g
  tris.v[t2 * 3 + 2] = d
}

/**
 * Recover constraint edge (ca, cb) by flipping the crossing, non-constraint,
 * convex-quad edges. Returns false if it stalls — a vertex sitting on the
 * segment, or the cap running out — so the caller can fall back.
 */
function cdtRecoverEdge(
  tris: TriSoup,
  px: number[],
  py: number[],
  constraintKeys: Set<number>,
  ca: number,
  cb: number
): boolean {
  let cap = 4 * tris.length + 64

  while (cdtFindEdgeTri(tris, ca, cb) < 0) {
    if (--cap < 0) {
      return false
    }

    let flipped = false
    for (let t = 0; t < tris.length && !flipped; t++) {
      if (!tris.alive[t]) {
        continue
      }
      for (let s = 0; s < 3; s++) {
        const c = tris.v[t * 3 + s]
        const d = tris.v[t * 3 + ((s + 1) % 3)]
        if (c === ca || c === cb || d === ca || d === cb) {
          continue
        }
        if (constraintKeys.has(cdtEdgeKey(c, d))) {
          continue
        }
        if (!cdtSegCross(px[ca], py[ca], px[cb], py[cb], px[c], py[c], px[d], py[d])) {
          continue
        }
        const t2 = cdtOtherTri(tris, c, d, t)
        if (t2 < 0) {
          continue
        }
        const e = cdtApex(tris, t, c, d)
        const g = cdtApex(tris, t2, c, d)
        if (e < 0 || g < 0 || e === g) {
          continue
        }
        // A non-crossing diagonal means the quad is not convex.
        if (!cdtSegCross(px[c], py[c], px[d], py[d], px[e], py[e], px[g], py[g])) {
          continue
        }
        cdtFlip(tris, t, t2, c, d, e, g)
        flipped = true
        break
      }
    }

    if (!flipped) {
      return false
    }
  }
  return true
}

/**
 * Lawson flips on non-constraint edges, restoring the empty-circumcircle
 * property. Capped against floating-point-driven cycling.
 */
function cdtLawsonRestore(tris: TriSoup, px: number[], py: number[], constraintKeys: Set<number>): void {
  let cap = 8 * tris.length + 64
  let changed = true

  while (changed && --cap > 0) {
    changed = false
    for (let t = 0; t < tris.length && !changed; t++) {
      if (!tris.alive[t]) {
        continue
      }
      for (let s = 0; s < 3; s++) {
        const c = tris.v[t * 3 + s]
        const d = tris.v[t * 3 + ((s + 1) % 3)]
        if (constraintKeys.has(cdtEdgeKey(c, d))) {
          continue
        }
        const t2 = cdtOtherTri(tris, c, d, t)
        if (t2 < 0) {
          continue
        }
        const e = cdtApex(tris, t, c, d)
        const g = cdtApex(tris, t2, c, d)
        if (e < 0 || g < 0) {
          continue
        }
        if (!cdtSegCross(px[c], py[c], px[d], py[d], px[e], py[e], px[g], py[g])) {
          continue
        }
        if (inCircumcircle(px[c], py[c], px[d], py[d], px[e], py[e], px[g], py[g])) {
          cdtFlip(tris, t, t2, c, d, e, g)
          changed = true
          break
        }
      }
    }
  }
}

/** nbr[t * 3 + s] is the triangle across edge (v[s], v[s + 1]) of t, or -1. */
function cdtBuildAdjacency(tris: TriSoup): Int32Array {
  const nbr = new Int32Array(tris.length * 3)
  nbr.fill(-1)

  for (let t = 0; t < tris.length; t++) {
    if (!tris.alive[t]) {
      continue
    }
    for (let s = 0; s < 3; s++) {
      nbr[t * 3 + s] = cdtOtherTri(tris, tris.v[t * 3 + s], tris.v[t * 3 + ((s + 1) % 3)], t)
    }
  }
  return nbr
}

/**
 * Parity flood fill seeded from the super-triangle, which is outside by
 * definition: crossing a constraint edge toggles inside/outside. `n` is the
 * real point count, so a super vertex is any index at or above it.
 */
function cdtFloodInterior(tris: TriSoup, nbr: Int32Array, constraintKeys: Set<number>, n: number): Int8Array {
  const inside = new Int8Array(tris.length)
  inside.fill(-1)

  const stack: number[] = []
  for (let t = 0; t < tris.length; t++) {
    if (!tris.alive[t]) {
      continue
    }
    const v0 = tris.v[t * 3]
    const v1 = tris.v[t * 3 + 1]
    const v2 = tris.v[t * 3 + 2]
    if ((v0 >= n || v1 >= n || v2 >= n) && inside[t] === -1) {
      inside[t] = 0
      stack.push(t)
    }
  }

  while (stack.length > 0) {
    const t = stack.pop() as number
    for (let s = 0; s < 3; s++) {
      const nb = nbr[t * 3 + s]
      if (nb < 0 || inside[nb] !== -1) {
        continue
      }
      const cross = constraintKeys.has(cdtEdgeKey(tris.v[t * 3 + s], tris.v[t * 3 + ((s + 1) % 3)]))
      inside[nb] = cross ? inside[t] ^ 1 : inside[t]
      stack.push(nb)
    }
  }

  for (let t = 0; t < tris.length; t++) {
    if (tris.alive[t] && inside[t] === -1) {
      inside[t] = 1
    }
  }
  return inside
}

/** True if any two constraint segments cross other than at a shared endpoint. */
function constraintsSelfIntersect(px: number[], py: number[], edges: number[]): boolean {
  const count = edges.length / 2
  for (let i = 0; i < count; i++) {
    const a = edges[i * 2]
    const b = edges[i * 2 + 1]
    for (let j = i + 1; j < count; j++) {
      const c = edges[j * 2]
      const d = edges[j * 2 + 1]
      if (cdtSegCross(px[a], py[a], px[b], py[b], px[c], py[c], px[d], py[d])) {
        return true
      }
    }
  }
  return false
}

/**
 * Triangulate a 2D point set, honouring `constraints` as required edges and
 * keeping only the interior.
 *
 * `points` is xy pairs; `constraints` is index pairs, and every ring — the
 * outer boundary and each hole — must be closed. With no constraints the
 * result is empty, because "interior" is then undefined.
 */
export function cdt2d(points: Float64Array, constraints: Int32Array, opts: Cdt2dOptions = {}): Cdt2dResult {
  const restoreDelaunay = opts.restoreDelaunay ?? true
  const maxTris = opts.maxTris ?? DEFAULT_MAX_TRIS
  const empty = new Int32Array(0)

  const rawN = points.length >> 1
  if (rawN < 3) {
    return {tris: empty, ok: true}
  }
  if (rawN >= KEY_STRIDE) {
    return {tris: empty, ok: false}
  }
  if (rawN > WARN_POINTS && !warned) {
    warned = true
    console.warn(
      `cdt2d: ${rawN} points — the constraint-recovery scans are quadratic, ` +
        'this is a face triangulator, not a point-cloud triangulator.'
    )
  }

  // Dedup near-duplicate points; map raw -> unique and unique -> first raw.
  const px: number[] = []
  const py: number[] = []
  const rawToUniq = new Int32Array(rawN)
  const uniqToRaw: number[] = []

  for (let i = 0; i < rawN; i++) {
    const x = points[i * 2]
    const y = points[i * 2 + 1]
    let found = -1
    for (let j = 0; j < px.length; j++) {
      if (Math.abs(x - px[j]) < DUP_EPS && Math.abs(y - py[j]) < DUP_EPS) {
        found = j
        break
      }
    }
    if (found < 0) {
      found = px.length
      px.push(x)
      py.push(y)
      uniqToRaw.push(i)
    }
    rawToUniq[i] = found
  }

  const n = px.length
  if (n < 3) {
    return {tris: empty, ok: true}
  }

  const constraintKeys = new Set<number>()
  const constraintEdges: number[] = []
  for (let i = 0; i + 1 < constraints.length; i += 2) {
    const ra = constraints[i]
    const rb = constraints[i + 1]
    if (ra < 0 || rb < 0 || ra >= rawN || rb >= rawN) {
      continue
    }
    const a = rawToUniq[ra]
    const b = rawToUniq[rb]
    if (a === b) {
      continue
    }
    const key = cdtEdgeKey(a, b)
    if (!constraintKeys.has(key)) {
      constraintKeys.add(key)
      constraintEdges.push(a, b)
    }
  }

  if (constraintsSelfIntersect(px, py, constraintEdges)) {
    return {tris: empty, ok: false}
  }

  {
    let collinear = true
    const dx = px[1] - px[0]
    const dy = py[1] - py[0]
    for (let i = 2; i < n; i++) {
      if (Math.abs(cross2(dx, dy, px[i] - px[0], py[i] - py[0])) > COLLINEAR_EPS) {
        collinear = false
        break
      }
    }
    if (collinear) {
      return {tris: empty, ok: true}
    }
  }

  let mnx = px[0]
  let mny = py[0]
  let mxx = px[0]
  let mxy = py[0]
  for (let i = 1; i < n; i++) {
    mnx = Math.min(mnx, px[i])
    mny = Math.min(mny, py[i])
    mxx = Math.max(mxx, px[i])
    mxy = Math.max(mxy, py[i])
  }

  const cenx = (mnx + mxx) * 0.5
  const ceny = (mny + mxy) * 0.5
  let r = Math.max(mxx - mnx, mxy - mny)
  if (r < 1) {
    r = 1
  }
  r *= 64

  px.push(cenx - 2 * r, cenx + 2 * r, cenx)
  py.push(ceny - r, ceny - r, ceny + 2 * r)

  // Bowyer-Watson over the real points. The super-triangle stays alive: it is
  // what seeds the interior flood fill.
  const tris = new TriSoup()
  tris.add(n, n + 1, n + 2)

  const boundary: number[] = []
  for (let pi = 0; pi < n; pi++) {
    boundary.length = 0
    const ppx = px[pi]
    const ppy = py[pi]

    for (let t = 0; t < tris.length; t++) {
      if (!tris.alive[t]) {
        continue
      }
      const a = tris.v[t * 3]
      const b = tris.v[t * 3 + 1]
      const c = tris.v[t * 3 + 2]
      if (!inCircumcircle(px[a], py[a], px[b], py[b], px[c], py[c], ppx, ppy)) {
        continue
      }

      const edges = [a, b, b, c, c, a]
      for (let ei = 0; ei < 6; ei += 2) {
        const ea = edges[ei]
        const eb = edges[ei + 1]
        let found = false
        for (let k = 0; k < boundary.length; k += 2) {
          if ((boundary[k] === ea && boundary[k + 1] === eb) || (boundary[k] === eb && boundary[k + 1] === ea)) {
            boundary.splice(k, 2)
            found = true
            break
          }
        }
        if (!found) {
          boundary.push(ea, eb)
        }
      }
      tris.alive[t] = false
    }

    if (tris.length + boundary.length / 2 > maxTris) {
      return {tris: empty, ok: false}
    }
    for (let k = 0; k < boundary.length; k += 2) {
      tris.add(boundary[k], boundary[k + 1], pi)
    }
  }

  for (let i = 0; i + 1 < constraintEdges.length; i += 2) {
    if (!cdtRecoverEdge(tris, px, py, constraintKeys, constraintEdges[i], constraintEdges[i + 1])) {
      return {tris: empty, ok: true}
    }
  }

  if (restoreDelaunay) {
    cdtLawsonRestore(tris, px, py, constraintKeys)
  }

  const nbr = cdtBuildAdjacency(tris)
  const inside = cdtFloodInterior(tris, nbr, constraintKeys, n)

  const out: number[] = []
  for (let t = 0; t < tris.length; t++) {
    if (!tris.alive[t] || inside[t] !== 1) {
      continue
    }
    const a = tris.v[t * 3]
    let b = tris.v[t * 3 + 1]
    let c = tris.v[t * 3 + 2]
    if (a >= n || b >= n || c >= n) {
      continue
    }
    if (cross2(px[b] - px[a], py[b] - py[a], px[c] - px[a], py[c] - py[a]) < 0) {
      const tmp = b
      b = c
      c = tmp
    }
    out.push(uniqToRaw[a], uniqToRaw[b], uniqToRaw[c])
  }

  return {tris: Int32Array.from(out), ok: true}
}
