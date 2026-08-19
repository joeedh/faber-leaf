/**
 * LeafMesh bevel — P12 §4, step 5. Pure, like `modeling.ts`: `topo.ts`'s Euler
 * surface is all these call, so the winding rules below are decided and tested
 * here rather than inside a ToolOp.
 *
 * Vertex bevel and edge bevel are one construction seen twice. Around a vertex
 * the incident edges form a cyclic fan; the bevel replaces the vertex by one
 * point per fan edge, each incident face taking the two points of the edges it
 * sits between, and closes the hole that leaves with a cap. Beveling an edge is
 * the same thing at each of its two ends with that edge's own point left out —
 * the fan becomes an arc, and the gap the arc leaves is filled by the bevel
 * quad instead of by a cap.
 *
 * Winding falls out of that and needs no normal test. A fan face between
 * `edges[i]` and `edges[i + 1]` walks its ring as `other(edges[i]) → v →
 * other(edges[i + 1])`, so it uses the directed edge `p_i → p_(i+1)`; a cap
 * therefore walks the fan backwards, and every new face is manifold-consistent
 * with the faces it was cut from.
 */

import {Domain} from './attrs.js'
import {ELEM_NONE} from './elem_array.js'
import {vertFaces} from './select_geom.js'
import {LeafMesh} from './topo.js'

/** How far a bevel slides along each edge away from the element it replaces. */
export interface BevelOptions {
  amount?: number
}

export interface BevelResult {
  /** The points the bevel created. */
  verts: number[]
  /** The faces it created: caps, and one quad per beveled edge. */
  faces: number[]
  /** The elements it refused, in the domain that was passed in. */
  skipped: number[]
}

/** A vertex's incident edges in cyclic order, with the face between each pair. */
interface Fan {
  edges: number[]
  /** `faces[i]` sits between `edges[i]` and `edges[i + 1]`. */
  faces: number[]
}

/** One face captured before the rewrite frees it. */
interface FaceSnap {
  face: number
  rings: number[][]
  cornerAttrs: Map<number, Float64Array>[]
  attrs: Float64Array
}

/** Per-face replacement lists: face → vertex → what stands in for it. */
type Plan = Map<number, Map<number, number[]>>

/**
 * The closed fan around `v`, or `undefined` when there is not one: a boundary
 * vertex, a wire edge, a face meeting `v` twice, or a non-manifold disk. A
 * bevel refuses those rather than guessing at a cap for them.
 */
function vertFan(mesh: LeafMesh, v: number): Fan | undefined {
  const link = new Map<number, {edge: number; face: number}>()

  for (const f of vertFaces(mesh, v)) {
    let found = 0

    for (const l of mesh.faceLoops(f)) {
      const ring = mesh.loopVerts(l)
      for (let i = 0; i < ring.length; i++) {
        if (ring[i] !== v) {
          continue
        }

        found++
        const prev = mesh.findEdge(ring[(i + ring.length - 1) % ring.length], v)
        const next = mesh.findEdge(v, ring[(i + 1) % ring.length])
        if (prev === ELEM_NONE || next === ELEM_NONE || link.has(prev)) {
          return undefined
        }
        link.set(prev, {edge: next, face: f})
      }
    }

    if (found !== 1) {
      return undefined
    }
  }

  const incident = [...mesh.vertEdges(v)]
  if (incident.length < 3 || incident.length !== link.size) {
    return undefined
  }

  const fan: Fan = {edges: [], faces: []}
  let e = incident[0]
  do {
    const step = link.get(e)
    if (step === undefined) {
      return undefined
    }

    fan.edges.push(e)
    fan.faces.push(step.face)
    e = step.edge
  } while (e !== incident[0] && fan.edges.length <= incident.length)

  return fan.edges.length === incident.length ? fan : undefined
}

/**
 * One point per fan edge except those in `skip`, `amount` along the edge from
 * `v` and never past its midpoint, carrying `v`'s vertex attributes.
 */
function fanPoints(
  mesh: LeafMesh,
  v: number,
  fan: Fan,
  skip: ReadonlySet<number>,
  amount: number
): Map<number, number> {
  const co = mesh.v.co
  const points = new Map<number, number>()

  for (const e of fan.edges) {
    if (skip.has(e)) {
      continue
    }

    const u = mesh.edgeOther(e, v)
    const d = [co[u * 3] - co[v * 3], co[u * 3 + 1] - co[v * 3 + 1], co[u * 3 + 2] - co[v * 3 + 2]]
    const len = Math.hypot(d[0], d[1], d[2])
    const t = len > 0 ? Math.min(amount / len, 0.5) : 0

    const p = mesh.makeVert([co[v * 3] + t * d[0], co[v * 3 + 1] + t * d[1], co[v * 3 + 2] + t * d[2]])
    mesh.attrs.copy(Domain.VERT, p, v)
    points.set(e, p)
  }
  return points
}

/** Record what each fan face puts in place of `v`: the points either side of it. */
function planFan(v: number, fan: Fan, points: ReadonlyMap<number, number>, plan: Plan): void {
  const n = fan.edges.length

  for (let i = 0; i < n; i++) {
    const rep: number[] = []
    const into = points.get(fan.edges[i])
    const outOf = points.get(fan.edges[(i + 1) % n])
    if (into !== undefined) {
      rep.push(into)
    }
    if (outOf !== undefined) {
      rep.push(outOf)
    }

    let byVert = plan.get(fan.faces[i])
    if (byVert === undefined) {
      byVert = new Map()
      plan.set(fan.faces[i], byVert)
    }
    byVert.set(v, rep)
  }
}

/** Capture a face's rings and attributes before the rewrite frees its storage. */
function snapFace(mesh: LeafMesh, f: number): FaceSnap {
  const rings: number[][] = []
  const cornerAttrs: Map<number, Float64Array>[] = []

  for (const l of mesh.faceLoops(f)) {
    const ring: number[] = []
    const attrs = new Map<number, Float64Array>()

    for (const c of mesh.loopCorners(l)) {
      ring.push(mesh.c.v[c])
      attrs.set(mesh.c.v[c], mesh.attrs.snapshotRow(Domain.CORNER, c))
    }

    rings.push(ring)
    cornerAttrs.push(attrs)
  }

  return {face: f, rings, cornerAttrs, attrs: mesh.attrs.snapshotRow(Domain.FACE, f)}
}

/**
 * Rebuild every planned face with its vertices substituted. All of them are
 * snapshotted before any is killed: a freed row's storage goes straight back
 * out to the faces being rebuilt.
 */
function applyPlan(mesh: LeafMesh, plan: Plan, origin: ReadonlyMap<number, number>): void {
  const snaps: {snap: FaceSnap; byVert: Map<number, number[]>}[] = []

  for (const [f, byVert] of plan) {
    if (mesh.f.has(f)) {
      snaps.push({snap: snapFace(mesh, f), byVert})
    }
  }

  for (const {snap} of snaps) {
    mesh.killFace(snap.face)
  }

  for (const {snap, byVert} of snaps) {
    const rings = snap.rings.map((ring) => ring.flatMap((v) => byVert.get(v) ?? [v]))
    const f = mesh.makeFace(rings)
    if (f === ELEM_NONE) {
      continue
    }

    mesh.attrs.restoreRow(Domain.FACE, f, snap.attrs)

    let ring = 0
    for (const l of mesh.faceLoops(f)) {
      const attrs = snap.cornerAttrs[ring++]
      if (attrs === undefined) {
        break
      }

      for (const c of mesh.loopCorners(l)) {
        const row = attrs.get(origin.get(mesh.c.v[c]) ?? mesh.c.v[c])
        if (row !== undefined) {
          mesh.attrs.restoreRow(Domain.CORNER, c, row)
        }
      }
    }
  }
}

/** The live members of `items`, deduplicated, in the order they were given. */
function liveUnique(has: (i: number) => boolean, items: Iterable<number>): number[] {
  const out: number[] = []
  const seen = new Set<number>()

  for (const i of items) {
    if (has(i) && !seen.has(i)) {
      seen.add(i)
      out.push(i)
    }
  }
  return out
}

/**
 * Replace each selected vertex by a face — one point per incident edge, the
 * cap walking the fan backwards so it agrees with the faces it was cut from.
 * Vertices without a closed fan are refused and reported in `skipped`.
 */
export function bevelVerts(mesh: LeafMesh, verts: Iterable<number>, opts: BevelOptions = {}): BevelResult {
  const amount = opts.amount ?? 0
  const out: BevelResult = {verts: [], faces: [], skipped: []}

  for (const v of liveUnique((i) => mesh.v.has(i), verts)) {
    const fan = vertFan(mesh, v)
    if (fan === undefined) {
      out.skipped.push(v)
      continue
    }

    const points = fanPoints(mesh, v, fan, new Set(), amount)
    const origin = new Map<number, number>()
    for (const p of points.values()) {
      origin.set(p, v)
      out.verts.push(p)
    }

    const plan: Plan = new Map()
    planFan(v, fan, points, plan)
    applyPlan(mesh, plan, origin)

    const ring = fan.edges.map((e) => points.get(e) as number).reverse()
    const cap = mesh.makeFace([ring])
    if (cap !== ELEM_NONE) {
      out.faces.push(cap)
    }

    mesh.killVert(v)
  }

  return out
}

/**
 * Whether `e` can be beveled on its own: two faces, both ends a closed fan,
 * and no other selected edge sharing a vertex with it. A chain of selected
 * edges needs a shared offset point at the vertex they meet in, which is a
 * vertex bevel's job — this refuses them rather than folding the surface.
 */
function edgeIsBevelable(mesh: LeafMesh, e: number, selected: ReadonlySet<number>): boolean {
  if (mesh.edgeFaceCount(e) !== 2) {
    return false
  }

  for (const v of [mesh.e.v1[e], mesh.e.v2[e]]) {
    if (vertFan(mesh, v) === undefined) {
      return false
    }

    for (const other of mesh.vertEdges(v)) {
      if (other !== e && selected.has(other)) {
        return false
      }
    }
  }
  return true
}

/**
 * Replace each selected edge by a quad. Only edges that meet
 * `edgeIsBevelable` are cut; the rest come back in `skipped`.
 */
export function bevelEdges(mesh: LeafMesh, edges: Iterable<number>, opts: BevelOptions = {}): BevelResult {
  const amount = opts.amount ?? 0
  const out: BevelResult = {verts: [], faces: [], skipped: []}
  const wanted = liveUnique((i) => mesh.e.has(i), edges)
  const selected = new Set(wanted)

  for (const e of wanted) {
    if (!mesh.e.has(e) || !edgeIsBevelable(mesh, e, selected)) {
      out.skipped.push(e)
      continue
    }

    const ends = [mesh.e.v1[e], mesh.e.v2[e]]
    const skip = new Set([e])
    const plan: Plan = new Map()
    const origin = new Map<number, number>()
    // `arc[i]` is the run of points left at `ends[i]` once `e` is left out, in
    // fan order: the face just after `e` is at its head and the face just
    // before it at its tail, and those two ends are what the quad joins.
    const arc: number[][] = []

    for (const v of ends) {
      const fan = vertFan(mesh, v) as Fan
      const points = fanPoints(mesh, v, fan, skip, amount)
      for (const p of points.values()) {
        origin.set(p, v)
        out.verts.push(p)
      }

      planFan(v, fan, points, plan)

      const n = fan.edges.length
      const start = fan.edges.indexOf(e)
      const run: number[] = []
      for (let k = 1; k < n; k++) {
        run.push(points.get(fan.edges[(start + k) % n]) as number)
      }
      arc.push(run)
    }

    applyPlan(mesh, plan, origin)

    const [a1, b1] = [arc[0][0], arc[0][arc[0].length - 1]]
    const [a2, b2] = [arc[1][0], arc[1][arc[1].length - 1]]

    // The face after `e` at one end is the face before it at the other, so the
    // quad crosses head-to-tail: `a2 → b1` and `a1 → b2` are the two directions
    // its neighbours left free.
    const quad = mesh.makeFace([[a2, b1, a1, b2]])
    if (quad !== ELEM_NONE) {
      out.faces.push(quad)
    }

    for (const run of arc) {
      // Two points need no cap: the one face between them already spans them.
      if (run.length < 3) {
        continue
      }

      const cap = mesh.makeFace([[...run].reverse()])
      if (cap !== ELEM_NONE) {
        out.faces.push(cap)
      }
    }

    for (const v of ends) {
      mesh.killVert(v)
    }
  }

  return out
}
