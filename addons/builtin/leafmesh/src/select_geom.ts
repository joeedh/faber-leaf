/**
 * Selection state and topological selection queries — P12 §4. Pure: imports
 * nothing from `scripts/`, so the traversals are unit-tested directly and the
 * ToolOps in `select_ops.ts` stay thin.
 *
 * Selection is an ordinary `Byte` attribute layer per domain, created on first
 * write; `leafmesh.ts` reads the same layer through P7's contract methods.
 */

import {AttrFlags, AttrType, Domain} from './attrs.js'
import {ELEM_NONE} from './elem_array.js'
import type {Vec3} from './topo.js'
import {LeafMesh} from './topo.js'

/** The per-domain selection layer's name. Shared with `leafmesh.ts`. */
export const SELECT_ATTR = '.select'

/** What a selection tool does with the elements it found. */
export type SelectAction = 'replace' | 'add' | 'sub' | 'toggle'

/** The domains a modeling selection can address. */
export type SelectDomain = Domain.VERT | Domain.EDGE | Domain.FACE

/** The layer's flags, or `undefined` when nothing has ever been selected. */
export function selectFlags(mesh: LeafMesh, domain: Domain): Uint8Array | undefined {
  const layer = mesh.attrs.get(domain, SELECT_ATTR)
  return layer === undefined ? undefined : (layer.column.data as Uint8Array)
}

/** The layer's flags, creating the layer if this is the first write. */
export function ensureSelectFlags(mesh: LeafMesh, domain: Domain): Uint8Array {
  return mesh.attrs.add(domain, SELECT_ATTR, AttrType.Byte, AttrFlags.NONE, 0).column.data as Uint8Array
}

export function isSelected(mesh: LeafMesh, domain: Domain, handle: number): boolean {
  const flags = selectFlags(mesh, domain)
  return flags !== undefined && handle !== ELEM_NONE && flags[handle] !== 0
}

/** Count of live selected elements on one domain. */
export function countSelected(mesh: LeafMesh, domain: Domain): number {
  const flags = selectFlags(mesh, domain)
  if (flags === undefined) {
    return 0
  }

  let n = 0
  for (const i of mesh.arrays[domain]) {
    if (flags[i] !== 0) {
      n++
    }
  }
  return n
}

/** Every live selected element on one domain, in handle order. */
export function listSelected(mesh: LeafMesh, domain: Domain): number[] {
  const flags = selectFlags(mesh, domain)
  const out: number[] = []
  if (flags === undefined) {
    return out
  }

  for (const i of mesh.arrays[domain]) {
    if (flags[i] !== 0) {
      out.push(i)
    }
  }
  return out
}

/** Select or deselect every live element on one domain. Returns the new count. */
export function selectAll(mesh: LeafMesh, domain: Domain, state: boolean): number {
  const flags = ensureSelectFlags(mesh, domain)
  let n = 0

  for (const i of mesh.arrays[domain]) {
    flags[i] = state ? 1 : 0
    n += state ? 1 : 0
  }
  return n
}

/**
 * Apply `action` to `handles` on one domain. `replace` clears the domain first,
 * which is what a plain click does; the other three leave untouched elements
 * alone. Returns how many elements changed state.
 */
export function applySelection(
  mesh: LeafMesh,
  domain: Domain,
  handles: Iterable<number>,
  action: SelectAction
): number {
  const flags = ensureSelectFlags(mesh, domain)
  const array = mesh.arrays[domain]
  let changed = 0

  if (action === 'replace') {
    for (const i of array) {
      if (flags[i] !== 0) {
        flags[i] = 0
        changed++
      }
    }
  }

  for (const h of handles) {
    if (h === ELEM_NONE || !array.has(h)) {
      continue
    }

    const was = flags[h] !== 0
    const now = action === 'sub' ? false : action === 'toggle' ? !was : true

    if (was !== now) {
      flags[h] = now ? 1 : 0
      changed++
    }
  }
  return changed
}

/** Faces touching a vertex, walked through its disk. */
export function vertFaces(mesh: LeafMesh, v: number): number[] {
  const out: number[] = []
  const seen = new Set<number>()

  for (const e of mesh.vertEdges(v)) {
    for (const c of mesh.edgeCorners(e)) {
      const f = mesh.cornerFace(c)
      if (f !== ELEM_NONE && !seen.has(f)) {
        seen.add(f)
        out.push(f)
      }
    }
  }
  return out
}

/** Every edge of a face, across all of its rings — holes included. */
export function faceEdges(mesh: LeafMesh, f: number): number[] {
  const out: number[] = []

  for (const l of mesh.faceLoops(f)) {
    const ring = mesh.loopVerts(l)
    for (let i = 0; i < ring.length; i++) {
      const e = mesh.findEdge(ring[i], ring[(i + 1) % ring.length])
      if (e !== ELEM_NONE) {
        out.push(e)
      }
    }
  }
  return out
}

/** Every vertex of a face, across all of its rings. */
export function faceVerts(mesh: LeafMesh, f: number): number[] {
  const out: number[] = []
  const seen = new Set<number>()

  for (const l of mesh.faceLoops(f)) {
    for (const v of mesh.loopVerts(l)) {
      if (!seen.has(v)) {
        seen.add(v)
        out.push(v)
      }
    }
  }
  return out
}

/**
 * Propagate selection out of `from` into the other two domains, on Blender's
 * rules: upward an element is selected only when *all* of its vertices are;
 * downward every vertex and edge of a selected face is.
 */
export function flushSelection(mesh: LeafMesh, from: SelectDomain): void {
  const vf = ensureSelectFlags(mesh, Domain.VERT)
  const ef = ensureSelectFlags(mesh, Domain.EDGE)
  const ff = ensureSelectFlags(mesh, Domain.FACE)

  if (from !== Domain.VERT) {
    for (const v of mesh.v) {
      vf[v] = 0
    }
  }
  if (from === Domain.FACE) {
    for (const e of mesh.e) {
      ef[e] = 0
    }
  }

  // Downward first, so the upward pass below reads a settled vertex layer.
  if (from === Domain.FACE) {
    for (const f of mesh.f) {
      if (ff[f] === 0) {
        continue
      }
      for (const v of faceVerts(mesh, f)) {
        vf[v] = 1
      }
    }
  } else if (from === Domain.EDGE) {
    for (const e of mesh.e) {
      if (ef[e] !== 0) {
        vf[mesh.e.v1[e]] = 1
        vf[mesh.e.v2[e]] = 1
      }
    }
  }

  if (from !== Domain.EDGE) {
    for (const e of mesh.e) {
      ef[e] = vf[mesh.e.v1[e]] !== 0 && vf[mesh.e.v2[e]] !== 0 ? 1 : 0
    }
  }

  if (from !== Domain.FACE) {
    for (const f of mesh.f) {
      let all = true
      for (const v of faceVerts(mesh, f)) {
        if (vf[v] === 0) {
          all = false
          break
        }
      }
      ff[f] = all ? 1 : 0
    }
  }
}

/**
 * Flood-fill from `seeds` across edge connectivity, in the seeds' own domain.
 * Faces are linked when they share an *edge* — sharing only a vertex is not
 * connectivity, which is what keeps two cones joined at a tip separate.
 */
export function linkedFrom(mesh: LeafMesh, domain: SelectDomain, seeds: Iterable<number>): number[] {
  const seen = new Set<number>()
  const stack: number[] = []
  const array = mesh.arrays[domain]

  const push = (h: number): void => {
    if (h !== ELEM_NONE && !seen.has(h) && array.has(h)) {
      seen.add(h)
      stack.push(h)
    }
  }

  for (const s of seeds) {
    push(s)
  }

  while (stack.length > 0) {
    const cur = stack.pop() as number

    if (domain === Domain.VERT) {
      for (const e of mesh.vertEdges(cur)) {
        push(mesh.edgeOther(e, cur))
      }
    } else if (domain === Domain.EDGE) {
      for (const v of [mesh.e.v1[cur], mesh.e.v2[cur]]) {
        for (const e of mesh.vertEdges(v)) {
          push(e)
        }
      }
    } else {
      for (const e of faceEdges(mesh, cur)) {
        for (const c of mesh.edgeCorners(e)) {
          push(mesh.cornerFace(c))
        }
      }
    }
  }

  return [...seen]
}

/** The criteria {@link similarTo} understands, one namespace per domain. */
export type SimilarCriterion =
  | 'FACE_SIDES'
  | 'FACE_AREA'
  | 'FACE_NORMAL'
  | 'FACE_COPLANAR'
  | 'FACE_HOLES'
  | 'EDGE_LENGTH'
  | 'EDGE_FACES'
  | 'EDGE_DIRECTION'
  | 'VERT_EDGES'
  | 'VERT_FACES'

/** Vertex count of a face's outer ring — its "sides". */
export function faceSides(mesh: LeafMesh, f: number): number {
  const l = mesh.f.l[f]
  return l === ELEM_NONE ? 0 : mesh.loopVerts(l).length
}

/** Ring count past the outer one. */
export function faceHoleCount(mesh: LeafMesh, f: number): number {
  let n = 0
  for (const _l of mesh.faceLoops(f)) {
    n++
  }
  return Math.max(0, n - 1)
}

/** Outer-ring area less every hole's, measured in the face's own plane. */
export function faceArea(mesh: LeafMesh, f: number): number {
  const normal = mesh.faceNormal(f)
  let area = 0
  let first = true

  for (const l of mesh.faceLoops(f)) {
    const signed = Math.abs(mesh.ringSignedArea(mesh.loopVerts(l), normal))
    area += first ? signed : -signed
    first = false
  }
  return Math.max(0, area)
}

export function edgeLength(mesh: LeafMesh, e: number): number {
  const co = mesh.v.co
  const a = mesh.e.v1[e] * 3
  const b = mesh.e.v2[e] * 3
  return Math.hypot(co[a] - co[b], co[a + 1] - co[b + 1], co[a + 2] - co[b + 2])
}

function edgeDir(mesh: LeafMesh, e: number): Vec3 {
  const co = mesh.v.co
  const a = mesh.e.v1[e] * 3
  const b = mesh.e.v2[e] * 3
  const d: Vec3 = [co[b] - co[a], co[b + 1] - co[a + 1], co[b + 2] - co[a + 2]]
  const len = Math.hypot(d[0], d[1], d[2])

  if (len > 0) {
    d[0] /= len
    d[1] /= len
    d[2] /= len
  }
  return d
}

function dot3(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/**
 * Every element of `seed`'s domain matching it under `criterion`. `threshold`
 * is a relative tolerance for the scalar criteria and one minus a cosine for
 * the directional ones; the seed itself always matches.
 */
export function similarTo(
  mesh: LeafMesh,
  domain: SelectDomain,
  seed: number,
  criterion: SimilarCriterion,
  threshold = 0.01
): number[] {
  const array = mesh.arrays[domain]
  if (seed === ELEM_NONE || !array.has(seed)) {
    return []
  }

  const near = (a: number, b: number): boolean => Math.abs(a - b) <= threshold * Math.max(1, Math.abs(b))
  const cos = 1 - threshold
  const out: number[] = []

  if (domain === Domain.FACE) {
    const seedNormal = mesh.faceNormal(seed)
    const seedVert = faceVerts(mesh, seed)[0]

    for (const f of mesh.f) {
      let hit = false

      switch (criterion) {
        case 'FACE_SIDES':
          hit = faceSides(mesh, f) === faceSides(mesh, seed)
          break
        case 'FACE_HOLES':
          hit = faceHoleCount(mesh, f) === faceHoleCount(mesh, seed)
          break
        case 'FACE_AREA':
          hit = near(faceArea(mesh, f), faceArea(mesh, seed))
          break
        case 'FACE_NORMAL':
          hit = dot3(mesh.faceNormal(f), seedNormal) >= cos
          break
        case 'FACE_COPLANAR': {
          const n = mesh.faceNormal(f)
          if (Math.abs(dot3(n, seedNormal)) >= cos) {
            // Same plane, not merely the same orientation: the seed's first
            // vertex has to lie in this face's plane as well.
            const co = mesh.v.co
            const a = faceVerts(mesh, f)[0] * 3
            const b = seedVert * 3
            const d: Vec3 = [co[b] - co[a], co[b + 1] - co[a + 1], co[b + 2] - co[a + 2]]
            hit = Math.abs(dot3(d, n)) <= threshold
          }
          break
        }
        default:
          break
      }

      if (hit) {
        out.push(f)
      }
    }
    return out
  }

  if (domain === Domain.EDGE) {
    const seedDir = edgeDir(mesh, seed)

    for (const e of mesh.e) {
      let hit = false

      switch (criterion) {
        case 'EDGE_LENGTH':
          hit = near(edgeLength(mesh, e), edgeLength(mesh, seed))
          break
        case 'EDGE_FACES':
          hit = mesh.edgeFaceCount(e) === mesh.edgeFaceCount(seed)
          break
        case 'EDGE_DIRECTION':
          hit = Math.abs(dot3(edgeDir(mesh, e), seedDir)) >= cos
          break
        default:
          break
      }

      if (hit) {
        out.push(e)
      }
    }
    return out
  }

  const seedEdges = [...mesh.vertEdges(seed)].length
  const seedFaces = vertFaces(mesh, seed).length

  for (const v of mesh.v) {
    let hit = false

    switch (criterion) {
      case 'VERT_EDGES':
        hit = [...mesh.vertEdges(v)].length === seedEdges
        break
      case 'VERT_FACES':
        hit = vertFaces(mesh, v).length === seedFaces
        break
      default:
        break
    }

    if (hit) {
      out.push(v)
    }
  }
  return out
}

/** Enough of the selection state to put it back (P12 §7). */
export interface SelectionSnapshot {
  vert: Uint8Array
  edge: Uint8Array
  face: Uint8Array
  /** What `calcUndoMem` reports — the three copies, nothing hidden. */
  bytes: number
}

/** Copy the three selection layers, creating any that a later restore will need. */
export function snapshotSelection(mesh: LeafMesh): SelectionSnapshot {
  const vert = ensureSelectFlags(mesh, Domain.VERT).slice()
  const edge = ensureSelectFlags(mesh, Domain.EDGE).slice()
  const face = ensureSelectFlags(mesh, Domain.FACE).slice()

  return {vert, edge, face, bytes: vert.length + edge.length + face.length}
}

/**
 * Put a snapshot back. Handles are stable under tombstoned deletion (P3), so a
 * column that has grown since keeps its extra rows cleared rather than being
 * misaligned.
 */
export function restoreSelection(mesh: LeafMesh, snap: SelectionSnapshot): void {
  const pairs: [Domain, Uint8Array][] = [
    [Domain.VERT, snap.vert],
    [Domain.EDGE, snap.edge],
    [Domain.FACE, snap.face],
  ]

  for (const [domain, saved] of pairs) {
    const flags = ensureSelectFlags(mesh, domain)
    const n = Math.min(flags.length, saved.length)

    flags.fill(0)
    flags.set(n === saved.length ? saved : saved.subarray(0, n), 0)
  }
}
