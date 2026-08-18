/**
 * The CPU half of picking (P11 §8): ray/triangle intersection and screen-space
 * element queries over a LeafMesh, with the viewport injected as a projector
 * callback so nothing here reaches into `scripts/`.
 *
 * Brute force throughout, which P11 §8 chose deliberately: LeafMesh declines
 * the spatial-acceleration capability rather than faking one, and the geometry
 * contract exposes queries and never structures — so every function here can
 * grow an acceleration tree later without a caller noticing.
 */

import {ELEM_NONE, LeafMesh} from './topo.js'
import type {TriangulationCache} from './triangulate.js'

/** The three pickable domains, tagged the way `ScreenPickResult` consumers narrow. */
export type PickDomainName = 'vert' | 'edge' | 'face'

/**
 * A LeafMesh area-pick hit (`ScreenPickResult.elements` entry). LeafMesh
 * elements are integer handles, so the domain has to travel with the index —
 * the same shape LiteMesh uses, for the same reason.
 */
export interface LeafMeshPickElem {
  type: PickDomainName
  index: number
}

/** A point projected into view-local screen space. */
export interface ProjectedPoint {
  x: number
  y: number
  /** Camera-space depth; larger is further away. */
  depth: number
}

/**
 * Object-local point → screen. Returns `undefined` for anything at or behind
 * the eye, which is the caller's cue to drop the candidate rather than pick a
 * mirrored ghost of it.
 */
export type Projector = (x: number, y: number, z: number) => ProjectedPoint | undefined

export interface PickCandidate extends LeafMeshPickElem {
  /** Screen-space pixels from the query point (for a rect, from its centre). */
  dis: number
  depth: number
  /** The object-local representative point that was projected. */
  co: [number, number, number]
}

/**
 * A read-only 3-component point. Deliberately not `ArrayLike<number>`: path.ux
 * vectors type indices past their length as `number | undefined`, so they do
 * not satisfy it, and every caller here is passing exactly three components.
 */
export type Point3 = Readonly<{0: number; 1: number; 2: number}>

/** A surface hit from {@link rayCastMesh}. */
export interface RayHit {
  /** Parametric distance along `dir`, which need not be unit length. */
  t: number
  f: number
  /** Object-local hit point. */
  co: [number, number, number]
}

/** Rays this close to parallel with a triangle's plane count as misses. */
const RAY_EPS = 1e-9

/**
 * Screen-distance slack, in pixels, inside which a nearer candidate wins over a
 * marginally closer-to-the-cursor one. Without it a cube's back-face vertex
 * routinely out-picks the front one it sits behind.
 */
export const DEPTH_TIEBREAK_PX = 6

/**
 * Möller–Trumbore against every triangle of every live face, nearest hit in
 * front of `origin` wins. Both `origin` and `dir` are object-local.
 */
export function rayCastMesh(
  mesh: LeafMesh,
  cache: TriangulationCache,
  origin: Point3,
  dir: Point3
): RayHit | undefined {
  const co = mesh.v.co
  let best: RayHit | undefined

  for (const f of mesh.f) {
    for (const tri of cache.get(mesh, f)) {
      const a = tri.v[0] * 3
      const b = tri.v[1] * 3
      const c = tri.v[2] * 3

      const e1x = co[b] - co[a]
      const e1y = co[b + 1] - co[a + 1]
      const e1z = co[b + 2] - co[a + 2]
      const e2x = co[c] - co[a]
      const e2y = co[c + 1] - co[a + 1]
      const e2z = co[c + 2] - co[a + 2]

      const px = dir[1] * e2z - dir[2] * e2y
      const py = dir[2] * e2x - dir[0] * e2z
      const pz = dir[0] * e2y - dir[1] * e2x

      const det = e1x * px + e1y * py + e1z * pz
      if (det > -RAY_EPS && det < RAY_EPS) {
        continue
      }

      const inv = 1.0 / det
      const tx = origin[0] - co[a]
      const ty = origin[1] - co[a + 1]
      const tz = origin[2] - co[a + 2]

      const u = (tx * px + ty * py + tz * pz) * inv
      if (u < 0 || u > 1) {
        continue
      }

      const qx = ty * e1z - tz * e1y
      const qy = tz * e1x - tx * e1z
      const qz = tx * e1y - ty * e1x

      const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv
      if (v < 0 || u + v > 1) {
        continue
      }

      const t = (e2x * qx + e2y * qy + e2z * qz) * inv
      if (t <= RAY_EPS || (best !== undefined && t >= best.t)) {
        continue
      }

      best = {
        t,
        f,
        co: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
      }
    }
  }

  return best
}

/**
 * The object-local point that stands in for an element when picking: the vertex
 * itself, an edge's midpoint, a face's outer-ring centroid. `false` means the
 * element carries no usable geometry (an empty face, a half-built edge).
 */
export function elementPoint(
  mesh: LeafMesh,
  domain: PickDomainName,
  index: number,
  out: [number, number, number]
): boolean {
  const co = mesh.v.co

  if (domain === 'vert') {
    out[0] = co[index * 3]
    out[1] = co[index * 3 + 1]
    out[2] = co[index * 3 + 2]
    return true
  }

  if (domain === 'edge') {
    const v1 = mesh.e.v1[index]
    const v2 = mesh.e.v2[index]
    if (v1 === ELEM_NONE || v2 === ELEM_NONE) {
      return false
    }
    out[0] = (co[v1 * 3] + co[v2 * 3]) * 0.5
    out[1] = (co[v1 * 3 + 1] + co[v2 * 3 + 1]) * 0.5
    out[2] = (co[v1 * 3 + 2] + co[v2 * 3 + 2]) * 0.5
    return true
  }

  // The outer ring alone: a face with a hole should answer with a point on the
  // material, not one dragged toward the middle of the hole.
  const l = mesh.f.l[index]
  if (l === ELEM_NONE) {
    return false
  }

  let n = 0
  out[0] = out[1] = out[2] = 0
  for (const c of mesh.loopCorners(l)) {
    const v = mesh.c.v[c]
    out[0] += co[v * 3]
    out[1] += co[v * 3 + 1]
    out[2] += co[v * 3 + 2]
    n++
  }
  if (n === 0) {
    return false
  }

  out[0] /= n
  out[1] /= n
  out[2] /= n
  return true
}

/** Live handles of one domain, in handle order. */
function* domainElements(mesh: LeafMesh, domain: PickDomainName): Generator<number> {
  if (domain === 'vert') {
    yield* mesh.v
  } else if (domain === 'edge') {
    yield* mesh.e
  } else {
    yield* mesh.f
  }
}

/** Project every live element of `domains` and hand each to `accept`. */
function forEachProjected(
  mesh: LeafMesh,
  project: Projector,
  domains: readonly PickDomainName[],
  accept: (domain: PickDomainName, index: number, p: ProjectedPoint, co: [number, number, number]) => void
): void {
  const co: [number, number, number] = [0, 0, 0]

  for (const domain of domains) {
    for (const index of domainElements(mesh, domain)) {
      if (!elementPoint(mesh, domain, index, co)) {
        continue
      }
      const p = project(co[0], co[1], co[2])
      if (p !== undefined) {
        accept(domain, index, p, co)
      }
    }
  }
}

/** Every element of `domains` within `radius` pixels of (`mx`, `my`), nearest first. */
export function pickScreenCircle(
  mesh: LeafMesh,
  project: Projector,
  domains: readonly PickDomainName[],
  mx: number,
  my: number,
  radius: number
): PickCandidate[] {
  const out: PickCandidate[] = []

  forEachProjected(mesh, project, domains, (type, index, p, co) => {
    const dx = p.x - mx
    const dy = p.y - my
    const dis = Math.sqrt(dx * dx + dy * dy)
    if (dis <= radius) {
      out.push({type, index, dis, depth: p.depth, co: [co[0], co[1], co[2]]})
    }
  })

  out.sort((a, b) => a.dis - b.dis)
  return out
}

/**
 * Every element of `domains` inside the screen rect, ordered by distance from
 * its centre — the same metric the BREP mesh addon reports for a rect pick.
 */
export function pickScreenRect(
  mesh: LeafMesh,
  project: Projector,
  domains: readonly PickDomainName[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): PickCandidate[] {
  const cx = (minX + maxX) * 0.5
  const cy = (minY + maxY) * 0.5
  const out: PickCandidate[] = []

  forEachProjected(mesh, project, domains, (type, index, p, co) => {
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) {
      return
    }
    const dx = p.x - cx
    const dy = p.y - cy
    out.push({type, index, dis: Math.sqrt(dx * dx + dy * dy), depth: p.depth, co: [co[0], co[1], co[2]]})
  })

  out.sort((a, b) => a.dis - b.dis)
  return out
}

/**
 * The winning candidate per domain: nearest to the cursor, except that anything
 * within {@link DEPTH_TIEBREAK_PX} of the leader may take it by being nearer the
 * camera. LeafMesh does no occlusion test, so this is what stops the far side of
 * a closed mesh from out-picking the side facing the viewer.
 */
export function nearestByDomain(
  cands: readonly PickCandidate[],
  band = DEPTH_TIEBREAK_PX
): Map<PickDomainName, PickCandidate> {
  // Two passes so the answer cannot depend on arrival order: the band is
  // measured against the true leader, never against a running pick that has
  // already drifted away from it.
  const leader = new Map<PickDomainName, number>()
  for (const cand of cands) {
    const cur = leader.get(cand.type)
    if (cur === undefined || cand.dis < cur) {
      leader.set(cand.type, cand.dis)
    }
  }

  const best = new Map<PickDomainName, PickCandidate>()
  for (const cand of cands) {
    if (cand.dis > leader.get(cand.type)! + band) {
      continue
    }
    const cur = best.get(cand.type)
    if (cur === undefined || cand.depth < cur.depth || (cand.depth === cur.depth && cand.dis < cur.dis)) {
      best.set(cand.type, cand)
    }
  }

  return best
}
