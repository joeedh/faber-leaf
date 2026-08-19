/**
 * LeafMesh modeling operations — P12 §4, step 4: extrude (region and
 * individual) and split-off. Pure: `topo.ts`'s Euler surface is the only thing
 * these call, so what a tool does to the topology is decided and unit-tested
 * here rather than inside a ToolOp. `modeling_ops.ts` supplies the selection,
 * the undo snapshot and the follow-up transform.
 *
 * Modeling ops live in the toolmode, not in `topo.ts` (design §7, §10). A tool
 * that needs a new primitive gets it added to `topo.ts` deliberately, one at a
 * time, with a test — it does not grow one here.
 *
 * All three tools are the same rewrite: snapshot the region, duplicate the
 * vertices that have to come apart, rebuild the faces on the result, and — for
 * an extrude — raise a wall along the rim. What differs is only *which*
 * vertices are duplicated and whether walls go up.
 */

import {Domain} from './attrs.js'
import {ELEM_NONE} from './elem_array.js'
import {vertFaces} from './select_geom.js'
import {LeafMesh} from './topo.js'
import type {Vec3} from './topo.js'

/** What an extrude or a split-off produced. */
export interface RegionResult {
  /** The new region's vertices — what the follow-up transform moves. */
  verts: number[]
  /** The region's faces, rebuilt on `verts`. */
  faces: number[]
  /** Walls raised along the region's rim; empty for a split-off. */
  walls: number[]
  /**
   * The region's averaged face normal — the axis an interactive extrude
   * constrains its follow-up grab to. `[0, 0, 1]` when the region was empty.
   */
  normal: Vec3
}

export interface ExtrudeOptions {
  /**
   * How far to move the new vertices along the region's averaged face normal.
   * Zero — the default — leaves them coincident for a transform to move, which
   * is what the interactive tool does; a non-zero offset is what makes the
   * scripted, headless sequences of §8 possible.
   */
  offset?: number
}

/** One region face, captured before the rewrite frees it. */
interface FaceSnap {
  face: number
  /** Vertices per ring, ring 0 outer, in corner order. */
  rings: number[][]
  /** Corner attributes per ring, keyed by the corner's vertex. */
  cornerAttrs: Map<number, Float64Array>[]
  attrs: Float64Array
  normal: Vec3
}

interface RegionSnapshot {
  faces: FaceSnap[]
  /** Every edge the region's faces use. */
  edges: Set<number>
  /** Every vertex the region's faces use. */
  verts: Set<number>
  /** Rim edge to the single directed use (a to b) in a region face's ring. */
  boundary: Map<number, [number, number]>
}

interface RewriteOptions {
  offset: number
  walls: boolean
}

/** The live faces of `faces`, as a set the boundary test can ask about. */
function asRegion(mesh: LeafMesh, faces: Iterable<number>): Set<number> {
  const out = new Set<number>()
  for (const f of faces) {
    if (mesh.f.has(f)) {
      out.add(f)
    }
  }
  return out
}

/**
 * Capture everything the rewrite needs before it starts freeing elements —
 * corner and face attributes especially, since a freed row's storage is handed
 * straight back out to the faces being rebuilt.
 */
function snapshotRegion(mesh: LeafMesh, region: ReadonlySet<number>): RegionSnapshot {
  const snap: RegionSnapshot = {faces: [], edges: new Set(), verts: new Set(), boundary: new Map()}
  const uses = new Map<number, number>()
  const dirs = new Map<number, [number, number]>()

  for (const f of region) {
    const rings: number[][] = []
    const cornerAttrs: Map<number, Float64Array>[] = []

    for (const l of mesh.faceLoops(f)) {
      const ring: number[] = []
      const attrs = new Map<number, Float64Array>()

      for (const c of mesh.loopCorners(l)) {
        const v = mesh.c.v[c]
        ring.push(v)
        attrs.set(v, mesh.attrs.snapshotRow(Domain.CORNER, c))
        snap.verts.add(v)
      }

      rings.push(ring)
      cornerAttrs.push(attrs)

      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        const e = mesh.findEdge(a, b)
        if (e === ELEM_NONE) {
          continue
        }

        snap.edges.add(e)
        uses.set(e, (uses.get(e) ?? 0) + 1)
        if (!dirs.has(e)) {
          dirs.set(e, [a, b])
        }
      }
    }

    snap.faces.push({
      face: f,
      rings,
      cornerAttrs,
      attrs : mesh.attrs.snapshotRow(Domain.FACE, f),
      normal: mesh.faceNormal(f),
    })
  }

  for (const [e, n] of uses) {
    if (n === 1) {
      snap.boundary.set(e, dirs.get(e) as [number, number])
    }
  }
  return snap
}

/**
 * The region's rim: edges with exactly one adjacent region face. An edge with
 * two is interior even when a third, unselected face also uses it, which is
 * what makes an extrude of two adjacent faces raise one wall rather than three.
 */
export function regionBoundaryEdges(mesh: LeafMesh, faces: Iterable<number>): number[] {
  return [...snapshotRegion(mesh, asRegion(mesh, faces)).boundary.keys()]
}

/** Move each new vertex along the summed normal of the region faces it came from. */
function offsetRegion(mesh: LeafMesh, snap: RegionSnapshot, at: (v: number) => number, offset: number): void {
  const dirs = new Map<number, Vec3>()

  for (const fs of snap.faces) {
    for (const ring of fs.rings) {
      for (const v of ring) {
        const d = dirs.get(v)
        if (d === undefined) {
          dirs.set(v, [fs.normal[0], fs.normal[1], fs.normal[2]])
        } else {
          d[0] += fs.normal[0]
          d[1] += fs.normal[1]
          d[2] += fs.normal[2]
        }
      }
    }
  }

  const co = mesh.v.co
  for (const [v, d] of dirs) {
    const len = Math.hypot(d[0], d[1], d[2])
    if (len === 0) {
      continue
    }

    const nv = at(v)
    for (let k = 0; k < 3; k++) {
      co[nv * 3 + k] += (offset / len) * d[k]
    }
  }
}

/** Put a rebuilt face's corner attributes back, matching by original vertex. */
function restoreCorners(mesh: LeafMesh, f: number, fs: FaceSnap, origin: ReadonlyMap<number, number>): void {
  let ring = 0

  for (const l of mesh.faceLoops(f)) {
    const attrs = fs.cornerAttrs[ring++]
    if (attrs === undefined) {
      break
    }

    for (const c of mesh.loopCorners(l)) {
      const v = mesh.c.v[c]
      // Matched by vertex rather than by position, because `makeFace` may
      // rewind a hole ring and hand the corners back in the other order.
      const row = attrs.get(origin.get(v) ?? v)
      if (row !== undefined) {
        mesh.attrs.restoreRow(Domain.CORNER, c, row)
      }
    }
  }
}

/**
 * Duplicate `dup`, rebuild the region's faces on the result, optionally raise
 * walls along the rim, and clean up the edges the rewrite orphaned.
 */
function rewriteRegion(
  mesh: LeafMesh,
  snap: RegionSnapshot,
  dup: ReadonlySet<number>,
  opts: RewriteOptions
): RegionResult {
  const copies = new Map<number, number>()
  const origin = new Map<number, number>()

  for (const v of dup) {
    const co = mesh.v.co
    const nv = mesh.makeVert([co[v * 3], co[v * 3 + 1], co[v * 3 + 2]], v)
    mesh.attrs.copy(Domain.VERT, nv, v)
    copies.set(v, nv)
    origin.set(nv, v)
  }

  const at = (v: number): number => copies.get(v) ?? v

  if (opts.offset !== 0) {
    offsetRegion(mesh, snap, at, opts.offset)
  }

  for (const fs of snap.faces) {
    mesh.killFace(fs.face)
  }

  const faces: number[] = []
  for (const fs of snap.faces) {
    const f = mesh.makeFace(fs.rings.map((ring) => ring.map(at)))
    if (f === ELEM_NONE) {
      continue
    }

    mesh.attrs.restoreRow(Domain.FACE, f, fs.attrs)
    restoreCorners(mesh, f, fs, origin)
    faces.push(f)
  }

  const walls: number[] = []
  if (opts.walls) {
    for (const [a, b] of snap.boundary.values()) {
      // `[a, b, b', a']` for the edge as the region face walks it: its Newell
      // normal then points out of the solid, for a hole ring as well as an
      // outer one, because a hole ring is wound the other way to begin with.
      const w = mesh.makeFace([[a, b, at(b), at(a)]])
      if (w !== ELEM_NONE) {
        walls.push(w)
      }
    }
  }

  for (const e of snap.edges) {
    if (mesh.e.has(e) && mesh.edgeFaceCount(e) === 0) {
      mesh.killEdge(e)
    }
  }

  const verts: number[] = []
  const seen = new Set<number>()
  for (const fs of snap.faces) {
    for (const ring of fs.rings) {
      for (const v of ring) {
        const nv = at(v)
        if (!seen.has(nv)) {
          seen.add(nv)
          verts.push(nv)
        }
      }
    }
  }

  return {verts, faces, walls, normal: averageNormal(snap.faces)}
}

/** The summed, renormalized face normal of a region; `+Z` when there is none. */
function averageNormal(faces: readonly {normal: Vec3}[]): Vec3 {
  const n: Vec3 = [0, 0, 0]

  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      n[k] += f.normal[k]
    }
  }

  const len = Math.hypot(n[0], n[1], n[2])
  if (len === 0) {
    return [0, 0, 1]
  }

  for (let k = 0; k < 3; k++) {
    n[k] /= len
  }
  return n
}

/**
 * Extrude `faces` as one region: the rim becomes walls, the faces are rebuilt
 * on fresh vertices, and the interior of the region comes along unduplicated.
 * A region with no rim — a closed surface with every face selected — moves
 * without gaining geometry, which is the answer the BREP toolmode gives too.
 */
export function extrudeFaceRegion(mesh: LeafMesh, faces: Iterable<number>, opts: ExtrudeOptions = {}): RegionResult {
  const snap = snapshotRegion(mesh, asRegion(mesh, faces))
  const dup = new Set<number>()

  for (const e of snap.boundary.keys()) {
    dup.add(mesh.e.v1[e])
    dup.add(mesh.e.v2[e])
  }

  return rewriteRegion(mesh, snap, dup, {offset: opts.offset ?? 0, walls: true})
}

/** Extrude each face on its own, so neighbours come apart rather than moving together. */
export function extrudeFacesIndividual(
  mesh: LeafMesh,
  faces: Iterable<number>,
  opts: ExtrudeOptions = {}
): RegionResult {
  const out: RegionResult = {verts: [], faces: [], walls: [], normal: [0, 0, 0]}

  for (const f of asRegion(mesh, faces)) {
    const one = extrudeFaceRegion(mesh, [f], opts)
    out.verts.push(...one.verts)
    out.faces.push(...one.faces)
    out.walls.push(...one.walls)
    for (let k = 0; k < 3; k++) {
      out.normal[k] += one.normal[k]
    }
  }

  out.normal = averageNormal([{normal: out.normal}])
  return out
}

/**
 * Detach `faces` from the rest of the mesh. Only the vertices shared with a
 * face outside the region are duplicated, so a region that touches nothing else
 * is left exactly as it was.
 */
export function splitOffFaces(mesh: LeafMesh, faces: Iterable<number>): RegionResult {
  const region = asRegion(mesh, faces)
  const snap = snapshotRegion(mesh, region)
  const dup = new Set<number>()

  for (const v of snap.verts) {
    for (const f of vertFaces(mesh, v)) {
      if (!region.has(f)) {
        dup.add(v)
        break
      }
    }
  }

  return rewriteRegion(mesh, snap, dup, {offset: 0, walls: false})
}

/**
 * What a whole-mesh undo snapshot (`LeafMesh.copy()`) costs: every column of
 * every domain plus the tombstone maps. A topology-changing op cannot snapshot
 * a vertex list the way a transform does, so this is what `calcUndoMem`
 * reports (§7) instead of zero.
 */
export function meshSnapshotBytes(mesh: LeafMesh): number {
  let bytes = 0

  for (const array of mesh.arrays) {
    bytes += array.freemap.byteLength
    for (const col of array.cols.values()) {
      bytes += col.data.byteLength
    }
  }

  return bytes
}
