/**
 * LeafMesh subdivide and loop cut — P12 §4, step 6. Pure, like `bevel.ts`:
 * `topo.ts`'s `splitEdge` inserts the vertices, so everything here is about
 * which edges get split and which chords get drawn afterwards.
 *
 * §5's rule for holes decides the shape of both, in opposite ways. A
 * subdivision is per ring, so a face with holes subdivides exactly as its rings
 * do and needs no case of its own. A chord is the other thing: it only means
 * anything across a single ring, so a loop cut stops at any face that is not a
 * hole-free quad rather than drawing a line that would cross a hole, and
 * reports the faces it stopped at.
 *
 * Winding is derived here too. A chord splits a ring at two of its vertices
 * into the two spans between them, and each span is walked in the ring's own
 * direction; a quad split walks `mid → corner → mid` the same way before
 * closing on the centre. Neither reads a normal.
 */

import {Domain} from './attrs.js'
import {ELEM_NONE} from './elem_array.js'
import {faceHoleCount} from './select_geom.js'
import {LeafMesh} from './topo.js'

/** How many vertices each selected edge gains. */
export interface SubdivideOptions {
  cuts?: number
}

export interface SubdivideResult {
  /** The vertices the subdivision created, cut points and face centres alike. */
  verts: number[]
  /** The faces it created; empty unless a face was quad-split. */
  faces: number[]
  /** The faces it refused to quad-split, which subdivide by ring instead. */
  skipped: number[]
}

/** Where along each ring edge the cut lands, as a fraction of the edge. */
export interface LoopCutOptions {
  t?: number
}

export interface LoopCutResult {
  /** The cut points, one per ring edge, in ring order. */
  verts: number[]
  /** The ring the cut ran through, in walk order. */
  edges: number[]
  /** The faces the chords built, two per crossed face. */
  faces: number[]
  /** The faces that ended the walk: anything that is not a hole-free quad. */
  stopped: number[]
}

/** A ring of edges and the faces a cut crosses between them. */
export interface EdgeRing {
  edges: number[]
  /** `faces[i]` lies between `edges[i]` and `edges[i + 1]`, wrapping if closed. */
  faces: number[]
  closed: boolean
  /** Where the walk stopped, when it did not close. */
  stopped: number[]
}

/** The faces on an edge, without the duplicate a face touching it twice gives. */
function edgeFaces(mesh: LeafMesh, e: number): number[] {
  const out: number[] = []

  for (const c of mesh.edgeCorners(e)) {
    const f = mesh.cornerFace(c)
    if (f !== ELEM_NONE && !out.includes(f)) {
      out.push(f)
    }
  }
  return out
}

/** A face's outer ring, when it has no holes and at least three vertices. */
function outerRing(mesh: LeafMesh, f: number): number[] | undefined {
  const l = mesh.f.l[f]
  if (l === ELEM_NONE || faceHoleCount(mesh, f) !== 0) {
    return undefined
  }

  const ring = mesh.loopVerts(l)
  return ring.length < 3 ? undefined : ring
}

/** The edges of a ring, in the order the ring walks them. */
function ringEdges(mesh: LeafMesh, ring: readonly number[]): number[] | undefined {
  const out: number[] = []

  for (let i = 0; i < ring.length; i++) {
    const e = mesh.findEdge(ring[i], ring[(i + 1) % ring.length])
    if (e === ELEM_NONE) {
      return undefined
    }
    out.push(e)
  }
  return out
}

/** The edge a cut leaves `f` by, having entered it across `e`. */
function acrossFace(mesh: LeafMesh, f: number, e: number): number | undefined {
  const ring = outerRing(mesh, f)
  if (ring === undefined || ring.length !== 4) {
    return undefined
  }

  const edges = ringEdges(mesh, ring)
  if (edges === undefined) {
    return undefined
  }

  const i = edges.indexOf(e)
  return i < 0 ? undefined : edges[(i + 2) % 4]
}

interface Walk {
  edges: number[]
  faces: number[]
  closed: boolean
  stopped: number[]
}

/** Follow opposite edges away from `start` through `face`, until it cannot. */
function walkRing(mesh: LeafMesh, start: number, face: number): Walk {
  const out: Walk = {edges: [], faces: [], closed: false, stopped: []}
  let cur = start
  let from = face

  for (;;) {
    const next = acrossFace(mesh, from, cur)
    if (next === undefined) {
      out.stopped.push(from)
      return out
    }

    out.faces.push(from)
    if (next === start) {
      out.closed = true
      return out
    }

    out.edges.push(next)
    cur = next

    const onward = edgeFaces(mesh, cur).filter((f) => f !== from)
    if (onward.length !== 1) {
      return out
    }
    from = onward[0]
  }
}

/**
 * The ring of edges a loop cut through `e` would follow: `undefined` when `e`
 * is not on a manifold surface at all, otherwise the walk both ways with a
 * record of where it stopped.
 */
export function edgeRing(mesh: LeafMesh, e: number): EdgeRing | undefined {
  if (!mesh.e.has(e)) {
    return undefined
  }

  const faces = edgeFaces(mesh, e)
  if (faces.length === 0 || faces.length > 2) {
    return undefined
  }

  const fwd = walkRing(mesh, e, faces[0])
  if (fwd.closed) {
    return {edges: [e, ...fwd.edges], faces: fwd.faces, closed: true, stopped: []}
  }

  const empty: Walk = {edges: [], faces: [], closed: false, stopped: []}
  const back = faces.length === 2 ? walkRing(mesh, e, faces[1]) : empty

  return {
    edges  : [...back.edges.reverse(), e, ...fwd.edges],
    faces  : [...back.faces.reverse(), ...fwd.faces],
    closed : false,
    stopped: [...back.stopped, ...fwd.stopped],
  }
}

/** One ring span, from `i` round to `j`, both ends included. */
function ringSpan(ring: readonly number[], i: number, j: number): number[] {
  const out: number[] = []

  for (let k = i; ; k = (k + 1) % ring.length) {
    out.push(ring[k])
    if (k === j) {
      return out
    }
  }
}

/**
 * Cut `f` in two along the chord from `a` to `b`. Both spans walk the ring in
 * its own direction, so both agree with the face they came from.
 */
function chordSplit(mesh: LeafMesh, f: number, a: number, b: number): number[] {
  const l = mesh.f.l[f]
  if (l === ELEM_NONE) {
    return []
  }

  const ring = mesh.loopVerts(l)
  const ia = ring.indexOf(a)
  const ib = ring.indexOf(b)
  if (ia < 0 || ib < 0) {
    return []
  }

  const spans = [ringSpan(ring, ia, ib), ringSpan(ring, ib, ia)]
  if (spans[0].length < 3 || spans[1].length < 3) {
    return []
  }

  const faceAttrs = mesh.attrs.snapshotRow(Domain.FACE, f)
  const cornerAttrs = new Map<number, Float64Array>()
  for (const c of mesh.loopCorners(l)) {
    cornerAttrs.set(mesh.c.v[c], mesh.attrs.snapshotRow(Domain.CORNER, c))
  }

  mesh.killFace(f)

  const made: number[] = []
  for (const span of spans) {
    const nf = mesh.makeFace([span])
    if (nf === ELEM_NONE) {
      continue
    }

    mesh.attrs.restoreRow(Domain.FACE, nf, faceAttrs)
    for (const c of mesh.loopCorners(mesh.f.l[nf])) {
      const row = cornerAttrs.get(mesh.c.v[c])
      if (row !== undefined) {
        mesh.attrs.restoreRow(Domain.CORNER, c, row)
      }
    }
    made.push(nf)
  }
  return made
}

/** Split `e` into `cuts + 1` even pieces, returning the new vertices in order. */
function cutEdge(mesh: LeafMesh, e: number, cuts: number): number[] {
  const out: number[] = []
  let rest = e

  for (let k = 1; k <= cuts; k++) {
    const split = mesh.splitEdge(rest, 1 / (cuts + 2 - k))
    if (split === null) {
      return out
    }

    out.push(split.vert)
    rest = split.edge
  }
  return out
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
 * Insert `cuts` vertices into every selected edge. Faces keep their identity
 * and simply grow, so a face with holes subdivides by its rings, which is all
 * this is.
 */
export function subdivideEdges(mesh: LeafMesh, edges: Iterable<number>, opts: SubdivideOptions = {}): SubdivideResult {
  const cuts = Math.max(1, Math.round(opts.cuts ?? 1))
  const out: SubdivideResult = {verts: [], faces: [], skipped: []}

  for (const e of liveUnique((i) => mesh.e.has(i), edges)) {
    out.verts.push(...cutEdge(mesh, e, cuts))
  }
  return out
}

/**
 * Rebuild an already-cut face as one quad per original corner. The ring now
 * alternates corner and cut point, so each quad is `mid → corner → mid → centre`.
 */
function quadSplit(mesh: LeafMesh, f: number, mids: ReadonlySet<number>, out: SubdivideResult): number[] {
  const l = mesh.f.l[f]
  if (l === ELEM_NONE) {
    return []
  }

  const ring = mesh.loopVerts(l)
  const corners = ring.filter((v) => !mids.has(v))
  if (ring.length !== corners.length * 2 || corners.length < 3) {
    return []
  }

  const co: [number, number, number] = [0, 0, 0]
  for (const v of corners) {
    co[0] += mesh.v.co[v * 3] / corners.length
    co[1] += mesh.v.co[v * 3 + 1] / corners.length
    co[2] += mesh.v.co[v * 3 + 2] / corners.length
  }

  const centre = mesh.makeVert(co)
  mesh.attrs.interp(
    Domain.VERT,
    centre,
    corners,
    corners.map(() => 1 / corners.length)
  )
  out.verts.push(centre)

  const faceAttrs = mesh.attrs.snapshotRow(Domain.FACE, f)
  const cornerAttrs = new Map<number, Float64Array>()
  for (const c of mesh.loopCorners(l)) {
    cornerAttrs.set(mesh.c.v[c], mesh.attrs.snapshotRow(Domain.CORNER, c))
  }

  mesh.killFace(f)

  const made: number[] = []
  for (let i = 0; i < ring.length; i++) {
    if (mids.has(ring[i])) {
      continue
    }

    const quad = [ring[(i + ring.length - 1) % ring.length], ring[i], ring[(i + 1) % ring.length], centre]
    const nf = mesh.makeFace([quad])
    if (nf === ELEM_NONE) {
      continue
    }

    mesh.attrs.restoreRow(Domain.FACE, nf, faceAttrs)

    // The centre is the one corner nothing was snapshotted for.
    const known: number[] = []
    let middle = ELEM_NONE
    for (const c of mesh.loopCorners(mesh.f.l[nf])) {
      const row = cornerAttrs.get(mesh.c.v[c])
      if (row === undefined) {
        middle = c
      } else {
        mesh.attrs.restoreRow(Domain.CORNER, c, row)
        known.push(c)
      }
    }

    if (middle !== ELEM_NONE && known.length > 0) {
      mesh.attrs.interpCorner(
        middle,
        known,
        known.map(() => 1 / known.length)
      )
    }
    made.push(nf)
  }
  return made
}

/**
 * Split each face into one quad per corner, around a new centre vertex. A face
 * with a hole is refused — its centre would have to be somewhere the face is
 * not — and comes back in `skipped` for the caller to subdivide by ring.
 */
export function subdivideFaces(mesh: LeafMesh, faces: Iterable<number>): SubdivideResult {
  const out: SubdivideResult = {verts: [], faces: [], skipped: []}
  const accepted: number[] = []
  const edges: number[] = []

  for (const f of liveUnique((i) => mesh.f.has(i), faces)) {
    const ring = outerRing(mesh, f)
    const own = ring === undefined ? undefined : ringEdges(mesh, ring)
    if (own === undefined) {
      out.skipped.push(f)
      continue
    }

    accepted.push(f)
    for (const e of own) {
      if (!edges.includes(e)) {
        edges.push(e)
      }
    }
  }

  // Cut each ring edge once, so an edge two selected faces share is not cut twice.
  const mids = new Set<number>()
  for (const e of edges) {
    for (const v of cutEdge(mesh, e, 1)) {
      mids.add(v)
      out.verts.push(v)
    }
  }

  for (const f of accepted) {
    out.faces.push(...quadSplit(mesh, f, mids, out))
  }
  return out
}

/**
 * Subdivide a selection the way a modelling tool means it: a face whose every
 * edge is selected is quad-split, and any selected edge left over is cut on its
 * own. A quad split is a single cut by construction, so `cuts` above one
 * subdivides by ring throughout.
 */
export function subdivideSelection(
  mesh: LeafMesh,
  faces: Iterable<number>,
  edges: Iterable<number>,
  opts: SubdivideOptions = {}
): SubdivideResult {
  const cuts = Math.max(1, Math.round(opts.cuts ?? 1))
  const selected = new Set(liveUnique((i) => mesh.e.has(i), edges))
  const whole: number[] = []

  if (cuts === 1) {
    for (const f of liveUnique((i) => mesh.f.has(i), faces)) {
      const ring = outerRing(mesh, f)
      const own = ring === undefined ? undefined : ringEdges(mesh, ring)
      if (own === undefined || !own.every((e) => selected.has(e))) {
        continue
      }

      whole.push(f)
      for (const e of own) {
        selected.delete(e)
      }
    }
  }

  const out = subdivideFaces(mesh, whole)
  out.verts.push(...subdivideEdges(mesh, selected, {cuts}).verts)
  return out
}

/**
 * Run a cut all the way round the edge ring through `e`, splitting every face
 * it crosses in two. Faces that are not hole-free quads end the ring and come
 * back in `stopped`; no chord is drawn through them.
 */
export function loopCut(mesh: LeafMesh, e: number, opts: LoopCutOptions = {}): LoopCutResult {
  const t = Math.min(0.99, Math.max(0.01, opts.t ?? 0.5))
  const out: LoopCutResult = {verts: [], edges: [], faces: [], stopped: []}

  const ring = edgeRing(mesh, e)
  if (ring === undefined) {
    return out
  }

  out.edges = ring.edges
  out.stopped = ring.stopped

  const mids = new Map<number, number>()
  for (const re of ring.edges) {
    const split = mesh.splitEdge(re, t)
    if (split === null) {
      return out
    }

    mids.set(re, split.vert)
    out.verts.push(split.vert)
  }

  for (let i = 0; i < ring.faces.length; i++) {
    const a = mids.get(ring.edges[i])
    const b = mids.get(ring.edges[(i + 1) % ring.edges.length])
    if (a !== undefined && b !== undefined) {
      out.faces.push(...chordSplit(mesh, ring.faces[i], a, b))
    }
  }
  return out
}

/**
 * Cut the ring through each selected edge, skipping edges an earlier ring
 * already ran through, so that selecting a whole loop cuts once rather than
 * once per edge.
 */
export function loopCutEdges(mesh: LeafMesh, edges: Iterable<number>, opts: LoopCutOptions = {}): LoopCutResult {
  const out: LoopCutResult = {verts: [], edges: [], faces: [], stopped: []}
  const done = new Set<number>()

  for (const e of liveUnique((i) => mesh.e.has(i), edges)) {
    if (done.has(e)) {
      continue
    }

    const cut = loopCut(mesh, e, opts)
    for (const re of cut.edges) {
      done.add(re)
    }
    out.verts.push(...cut.verts)
    out.edges.push(...cut.edges)
    out.faces.push(...cut.faces)
    out.stopped.push(...cut.stopped)
  }
  return out
}
