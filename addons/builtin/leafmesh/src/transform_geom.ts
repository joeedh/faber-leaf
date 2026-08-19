/**
 * The geometry half of the LeafMesh transform bridge — P12 §6, step 3. Pure:
 * imports nothing from `scripts/`, so which vertices move, how far each one
 * follows, and how many bytes a transform snapshot costs are all decided and
 * unit-tested here. `transtype.ts` supplies the falloff curve and the matrix.
 */

import {Domain} from './attrs.js'
import {listSelected, selectFlags} from './select_geom.js'
import {LeafMesh} from './topo.js'
import type {Vec3} from './topo.js'

/** A selection's vertices with the positions a transform interpolates from. */
export interface MovableVerts {
  verts: Int32Array
  /** Three doubles per vertex, in `verts` order. */
  co: Float64Array
}

/**
 * A radius query over vertices, nearest first. Production passes the geometry
 * contract's `closestElements`; taking it as a parameter is what keeps this
 * module free of `scripts/` and lets the tests drive it with their own.
 */
export type NearVertQuery = (co: Readonly<Vec3>, radius: number) => ArrayLike<number>

/**
 * The selected vertices. Selection is flushed across domains, so an edge- or
 * face-mode selection has already reached the vertex layer and this is the one
 * query the transform needs.
 */
export function gatherMovableVerts(mesh: LeafMesh): MovableVerts {
  const handles = listSelected(mesh, Domain.VERT)
  const verts = Int32Array.from(handles)
  const co = new Float64Array(verts.length * 3)
  const src = mesh.v.co

  for (let i = 0; i < verts.length; i++) {
    co[i * 3] = src[verts[i] * 3]
    co[i * 3 + 1] = src[verts[i] * 3 + 1]
    co[i * 3 + 2] = src[verts[i] * 3 + 2]
  }

  return {verts, co}
}

/**
 * For every *unselected* vertex within `radius` of the moving set, its distance
 * to the nearest moving vertex — the input to a proportional-edit falloff. The
 * moving vertices themselves are absent: they follow at full weight already.
 */
export function propagationDistances(
  mesh: LeafMesh,
  seeds: ArrayLike<number>,
  radius: number,
  near: NearVertQuery
): Map<number, number> {
  const out = new Map<number, number>()
  if (radius <= 0) {
    return out
  }

  const co = mesh.v.co
  const flags = selectFlags(mesh, Domain.VERT)
  const seed: Vec3 = [0, 0, 0]

  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]
    seed[0] = co[s * 3]
    seed[1] = co[s * 3 + 1]
    seed[2] = co[s * 3 + 2]

    const hits = near(seed, radius)
    for (let j = 0; j < hits.length; j++) {
      const v = hits[j]
      if (v === s || (flags !== undefined && flags[v] !== 0)) {
        continue
      }

      const d = Math.hypot(co[v * 3] - seed[0], co[v * 3 + 1] - seed[1], co[v * 3 + 2] - seed[2])
      if (d > radius) {
        continue
      }

      const prev = out.get(v)
      if (prev === undefined || d < prev) {
        out.set(v, d)
      }
    }
  }

  return out
}

/** Mean of `verts`' positions, or `undefined` when there are none. */
export function centroidOf(mesh: LeafMesh, verts: ArrayLike<number>): Vec3 | undefined {
  if (verts.length === 0) {
    return undefined
  }

  const co = mesh.v.co
  const c: Vec3 = [0, 0, 0]
  for (let i = 0; i < verts.length; i++) {
    c[0] += co[verts[i] * 3]
    c[1] += co[verts[i] * 3 + 1]
    c[2] += co[verts[i] * 3 + 2]
  }

  for (let k = 0; k < 3; k++) {
    c[k] /= verts.length
  }
  return c
}

/** Axis-aligned bounds over `verts`, or `undefined` when there are none. */
export function aabbOf(mesh: LeafMesh, verts: ArrayLike<number>): [Vec3, Vec3] | undefined {
  if (verts.length === 0) {
    return undefined
  }

  const co = mesh.v.co
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]

  for (let i = 0; i < verts.length; i++) {
    for (let k = 0; k < 3; k++) {
      const x = co[verts[i] * 3 + k]
      if (x < lo[k]) {
        lo[k] = x
      }
      if (x > hi[k]) {
        hi[k] = x
      }
    }
  }

  return [lo, hi]
}

/**
 * What one transform snapshot of `nverts` vertices actually costs: an `int32`
 * handle plus three `float64` per vertex. `calcUndoMem` reports this rather
 * than zero, so large-mesh undo budgets against the real figure (§7).
 */
export function snapshotBytes(nverts: number): number {
  return nverts * (Int32Array.BYTES_PER_ELEMENT + 3 * Float64Array.BYTES_PER_ELEMENT)
}
