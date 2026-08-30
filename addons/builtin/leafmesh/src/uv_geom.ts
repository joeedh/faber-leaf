/**
 * UV data on a LeafMesh — P18 §5 step 2. Pure: imports nothing from `scripts/`,
 * so the traversals are unit-tested directly and `uv_source.ts` stays a shell
 * that only converts vocabulary.
 *
 * UVs live on the corner domain (see `attrs.ts`), so a UV element handle *is* a
 * corner handle and a seam is two corners of one vertex disagreeing. A UV layer
 * is any `Float2` corner layer whose name is not internal; per-element select
 * and pin flags live in a sibling `Byte` layer, created on first write, so that
 * they persist and interpolate with everything else.
 */

import {AttrFlags, AttrType, Domain} from './attrs.js'
import {ELEM_NONE} from './elem_array.js'
import {selectFlags} from './select_geom.js'
import {LeafMesh} from './topo.js'

/** Matches the host contract's `UVFlags`. */
export const UV_SELECT = 1
export const UV_PIN = 2

/** Layers whose name starts with this are storage, not user-visible UV maps. */
const INTERNAL_PREFIX = '.'

/** The sibling flags layer for a UV layer. */
export function uvFlagsLayerName(uvName: string): string {
  return `${INTERNAL_PREFIX}uvflags:${uvName}`
}

/** User UV maps, in layer-declaration order. An index into this is a `layer`. */
export function uvLayerNames(mesh: LeafMesh): string[] {
  const out: string[] = []
  for (const layer of mesh.attrs.layers(Domain.CORNER)) {
    if (layer.type === AttrType.Float2 && !layer.name.startsWith(INTERNAL_PREFIX)) {
      out.push(layer.name)
    }
  }
  return out
}

/**
 * The UV column, or `undefined` when there is no such layer. Never cached by
 * callers: `ElemArray` reallocates a column's storage as the mesh grows.
 */
export function uvCoords(mesh: LeafMesh, uvName: string): Float32Array | undefined {
  const layer = mesh.attrs.get(Domain.CORNER, uvName)
  return layer === undefined ? undefined : (layer.column.data as Float32Array)
}

/** Declare a UV layer, or return the existing one's column. */
export function ensureUVCoords(mesh: LeafMesh, uvName: string): Float32Array {
  return mesh.attrs.add(Domain.CORNER, uvName, AttrType.Float2).column.data as Float32Array
}

export function uvFlags(mesh: LeafMesh, uvName: string): Uint8Array | undefined {
  const layer = mesh.attrs.get(Domain.CORNER, uvFlagsLayerName(uvName))
  return layer === undefined ? undefined : (layer.column.data as Uint8Array)
}

/** The flags column, created on first write so an untouched mesh carries none. */
export function ensureUVFlags(mesh: LeafMesh, uvName: string): Uint8Array {
  return mesh.attrs.add(Domain.CORNER, uvFlagsLayerName(uvName), AttrType.Byte, AttrFlags.NONE, 0).column
    .data as Uint8Array
}

/** Every live corner, or only those of `owners` that are live. */
export function uvElements(mesh: LeafMesh, owners?: Iterable<number>): Int32Array {
  if (owners === undefined) {
    const out = new Int32Array(mesh.c.count)
    let n = 0
    for (const c of mesh.c) {
      out[n++] = c
    }
    return out
  }

  const hits: number[] = []
  for (const c of owners) {
    if (mesh.c.has(c)) {
      hits.push(c)
    }
  }
  return Int32Array.from(hits)
}

/** Live faces, or only the selected ones when `selectedOnly`. */
export function uvFaces(mesh: LeafMesh, selectedOnly = false): Int32Array {
  const flags = selectedOnly ? selectFlags(mesh, Domain.FACE) : undefined
  if (selectedOnly && flags === undefined) {
    return new Int32Array(0)
  }

  const hits: number[] = []
  for (const f of mesh.f) {
    if (flags?.[f] !== 0) {
      hits.push(f)
    }
  }
  return Int32Array.from(hits)
}

/** CSR arrays: `offsets` has `n + 1` entries and indexes `values`. */
export interface CSR {
  offsets: Int32Array
  values: Int32Array
}

function toCSR(rows: number[][]): CSR {
  const offsets = new Int32Array(rows.length + 1)
  let total = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = total
    total += rows[i].length
  }
  offsets[rows.length] = total

  const values = new Int32Array(total)
  let n = 0
  for (const row of rows) {
    for (const v of row) {
      values[n++] = v
    }
  }
  return {offsets, values}
}

/**
 * Each face's corners in winding order.
 *
 * TODO: only the outer ring is emitted — a face's hole loops have corners with
 * UVs too, but one CSR row per face cannot express two disjoint rings, so
 * editing them needs a row-per-loop shape settled with the editor's draw path.
 */
export function faceCornerRings(mesh: LeafMesh, faces: Iterable<number>): CSR {
  const rows: number[][] = []
  for (const f of faces) {
    const row: number[] = []
    if (mesh.f.has(f)) {
      const l = mesh.f.l[f]
      if (l !== ELEM_NONE) {
        for (const c of mesh.loopCorners(l)) {
          row.push(c)
        }
      }
    }
    rows.push(row)
  }
  return toCSR(rows)
}

/** Corners meeting at `v`, each once. Empty for a wire or loose vertex. */
export function vertCorners(mesh: LeafMesh, v: number): number[] {
  const out: number[] = []
  if (!mesh.v.has(v)) {
    return out
  }
  for (const e of mesh.vertEdges(v)) {
    for (const c of mesh.edgeCorners(e)) {
      if (mesh.c.v[c] === v) {
        out.push(c)
      }
    }
  }
  return out
}

/**
 * The corners welded to each of `corners`: same vertex, same UV. That is what a
 * move must carry as one, and the step "select linked" walks. Each fan contains
 * its own handle.
 */
export function uvFans(mesh: LeafMesh, uvName: string, corners: Iterable<number>, eps = 1e-6): CSR {
  const uv = uvCoords(mesh, uvName)
  const rows: number[][] = []

  for (const c of corners) {
    if (uv === undefined || !mesh.c.has(c)) {
      rows.push(mesh.c.has(c) ? [c] : [])
      continue
    }

    const u0 = uv[c * 2]
    const v0 = uv[c * 2 + 1]
    const row: number[] = []
    for (const other of vertCorners(mesh, mesh.c.v[c])) {
      if (Math.abs(uv[other * 2] - u0) <= eps && Math.abs(uv[other * 2 + 1] - v0) <= eps) {
        row.push(other)
      }
    }
    rows.push(row.length === 0 ? [c] : row)
  }
  return toCSR(rows)
}
