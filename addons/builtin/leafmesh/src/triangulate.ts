/**
 * Face triangulation: the bridge from LeafMesh's n-gons-with-holes to the
 * triangles every consumer downstream actually wants.
 *
 * A face is *complex* if it has holes or is a non-convex n-gon; those go
 * through `cdt2d`. Triangles and convex n-gons take a fan, which is exact and
 * far cheaper. A complex face whose CDT fails falls back to a fan too, and is
 * recorded in the cache's `failedFaces` — a fan across a concave polygon is
 * visibly wrong, which is the point: it should be noticed, not swallowed.
 *
 * One deliberate divergence from the C++ (`triangulate.h`): the projection
 * plane comes from Newell's normal over the outer ring rather than
 * `fitPlaneNormal`. Newell's follows the author's winding, so the triangles
 * come out wound consistently with the face; `fitPlaneNormal`'s sign is a
 * property of the point set alone and can mirror the projection. For a planar
 * face the plane is the same either way and the Delaunay result is unchanged
 * by the in-plane rotation between the two bases.
 */

import {cdt2d} from './cdt2d.js'
import {ELEM_NONE, LeafMesh, planeBasis, type Vec3} from './topo.js'

export interface Tri {
  /** Vertex indices. */
  v: [number, number, number]
  /** The corners those vertices came from, so per-corner attrs follow. */
  c: [number, number, number]
  f: number
}

/**
 * Convex in the plane `(u, v)`? Near-collinear corners are skipped; a sign
 * flip between consecutive edge crosses marks a reflex corner. Winding-
 * agnostic — a convex polygon's non-zero crosses all share one sign.
 */
function loopIsConvex2D(mesh: LeafMesh, l: number, u: Readonly<Vec3>, v: Readonly<Vec3>): boolean {
  const co = mesh.v.co
  const projX = (vi: number): number => co[vi * 3] * u[0] + co[vi * 3 + 1] * u[1] + co[vi * 3 + 2] * u[2]
  const projY = (vi: number): number => co[vi * 3] * v[0] + co[vi * 3 + 1] * v[1] + co[vi * 3 + 2] * v[2]

  let haveSign = false
  let sign = false

  for (const c of mesh.loopCorners(l)) {
    const vc = mesh.c.v[c]
    const vp = mesh.c.v[mesh.c.prev[c]]
    const vn = mesh.c.v[mesh.c.next[c]]

    const e0x = projX(vc) - projX(vp)
    const e0y = projY(vc) - projY(vp)
    const e1x = projX(vn) - projX(vc)
    const e1y = projY(vn) - projY(vc)

    const cr = e0x * e1y - e0y * e1x
    const scale = Math.sqrt(e0x * e0x + e0y * e0y) * Math.sqrt(e1x * e1x + e1y * e1y)
    if (Math.abs(cr) > 1e-6 * scale) {
      const s = cr > 0
      if (!haveSign) {
        sign = s
        haveSign = true
      } else if (s !== sign) {
        return false
      }
    }
  }
  return true
}

/**
 * CDT a complex face. Every loop becomes a run of 2D points plus a closed
 * constraint ring; each output index triple maps back to its source corner.
 */
function cdtTriangulateFace(mesh: LeafMesh, f: number, u: Readonly<Vec3>, v: Readonly<Vec3>, out: Tri[]): boolean {
  const co = mesh.v.co
  const pts: number[] = []
  const segs: number[] = []
  const cornerOf: number[] = []
  const vertOf: number[] = []

  for (const l of mesh.faceLoops(f)) {
    const base = cornerOf.length
    let k = 0
    for (const c of mesh.loopCorners(l)) {
      const vi = mesh.c.v[c]
      pts.push(
        co[vi * 3] * u[0] + co[vi * 3 + 1] * u[1] + co[vi * 3 + 2] * u[2],
        co[vi * 3] * v[0] + co[vi * 3 + 1] * v[1] + co[vi * 3 + 2] * v[2]
      )
      cornerOf.push(c)
      vertOf.push(vi)
      k++
    }
    for (let i = 0; i < k; i++) {
      segs.push(base + i, base + ((i + 1) % k))
    }
  }

  const result = cdt2d(Float64Array.from(pts), Int32Array.from(segs), {restoreDelaunay: true})
  if (!result.ok || result.tris.length < 3) {
    return false
  }

  for (let i = 0; i + 2 < result.tris.length; i += 3) {
    const a = result.tris[i]
    const b = result.tris[i + 1]
    const c = result.tris[i + 2]
    out.push({
      v: [vertOf[a], vertOf[b], vertOf[c]],
      c: [cornerOf[a], cornerOf[b], cornerOf[c]],
      f,
    })
  }
  return true
}

/** Fan from the first corner. Exact for triangles and convex n-gons. */
function fanTriangulateFace(mesh: LeafMesh, f: number, out: Tri[]): void {
  const l = mesh.f.l[f]
  const first = mesh.l.c[l]
  const last = mesh.c.prev[first]
  const vfirst = mesh.c.v[first]

  let ci = mesh.c.next[first]
  while (ci !== last && ci !== ELEM_NONE) {
    const next = mesh.c.next[ci]
    out.push({
      v: [vfirst, mesh.c.v[ci], mesh.c.v[next]],
      c: [first, ci, next],
      f,
    })
    ci = next
  }
}

/**
 * Append the triangles of one face to `out`. Returns false when a complex face
 * had to fall back to a fan, which means the result is geometrically wrong and
 * the caller should say so.
 */
export function triangulateFace(mesh: LeafMesh, f: number, out: Tri[]): boolean {
  const l = mesh.f.l[f]
  if (l === ELEM_NONE) {
    return true
  }

  let basis: [Vec3, Vec3] | null = null
  const ensurePlane = (): [Vec3, Vec3] => {
    if (basis === null) {
      basis = planeBasis(mesh.faceNormal(f))
    }
    return basis
  }

  let complex: boolean
  if (mesh.f.listCount[f] !== 1) {
    complex = true
  } else if (mesh.l.size[l] <= 3) {
    complex = false
  } else {
    const [u, v] = ensurePlane()
    complex = !loopIsConvex2D(mesh, l, u, v)
  }

  if (complex) {
    const [u, v] = ensurePlane()
    const before = out.length
    if (cdtTriangulateFace(mesh, f, u, v, out) && out.length > before) {
      return true
    }
    out.length = before
    fanTriangulateFace(mesh, f, out)
    return false
  }

  fanTriangulateFace(mesh, f, out)
  return true
}

/**
 * Per-face triangle memo, invalidated wholesale when `topoStamp` moves.
 *
 * Positions are **not** part of the stamp, so a deform that leaves topology
 * alone must call `invalidate()` — a concave face can change which
 * triangulation is correct without a single element being created or killed.
 */
export class TriangulationCache {
  private stamp = -1
  private readonly byFace = new Map<number, Tri[]>()

  /** Faces whose CDT failed and that are drawing a fan instead. */
  readonly failedFaces = new Set<number>()

  invalidate(): void {
    this.stamp = -1
    this.byFace.clear()
    this.failedFaces.clear()
  }

  get(mesh: LeafMesh, f: number): readonly Tri[] {
    if (this.stamp !== mesh.topoStamp) {
      this.byFace.clear()
      this.failedFaces.clear()
      this.stamp = mesh.topoStamp
    }

    const cached = this.byFace.get(f)
    if (cached !== undefined) {
      return cached
    }

    const tris: Tri[] = []
    if (!triangulateFace(mesh, f, tris)) {
      this.failedFaces.add(f)
    }
    this.byFace.set(f, tris)
    return tris
  }
}

/** Triangulate every live face. Convenience over `triangulateFace`. */
export function triangulateMesh(mesh: LeafMesh): Tri[] {
  const out: Tri[] = []
  for (const f of mesh.f) {
    triangulateFace(mesh, f, out)
  }
  return out
}
