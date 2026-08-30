/**
 * Implements the Wavefront OBJ reader — P11 §6. Pure: imports nothing from
 * `scripts/`, so the parser is unit-tested directly and the addon's
 * framework-facing half (`obj.ts`) only has to wire the result into a scene.
 *
 * An `f` line maps directly to a loop list: an n-gon imports as one face
 * instead of the fan the BREP reader produced. That is the cheapest
 * demonstration that representing faces as loop lists was the right call.
 */

import {AttrType, Domain} from './attrs.js'
import {ELEM_NONE} from './elem_array.js'
import {LeafMesh} from './topo.js'

/** The corner-domain layer `vt` references land in, per P3's convention. */
export const OBJ_UV_LAYER = 'uv'

/** How many complaints {@link readOBJ} keeps before it stops recording them. */
export const OBJ_MAX_WARNINGS = 32

export interface ObjReadStats {
  verts: number
  faces: number
  /** `f` lines dropped for having fewer than three distinct vertices. */
  degenerate: number
  /** Faces whose ring named the same vertex twice; the repeat was dropped. */
  repaired: number
  /** Did any `f` reference a `vt`, i.e. was a UV layer created? */
  uvs: boolean
  /** `vn` lines read and discarded — normals are derived, never authored. */
  normalsIgnored: number
  /** Non-fatal complaints, capped at {@link OBJ_MAX_WARNINGS}. */
  warnings: string[]
}

export interface ObjReadResult {
  mesh: LeafMesh
  stats: ObjReadStats
}

/**
 * OBJ indices are 1-based, and negative means "counting back from the last one
 * defined so far" — relative to the table, not to the face being built.
 */
function resolveIndex(token: string, count: number): number {
  const n = parseInt(token, 10)
  if (!Number.isFinite(n) || n === 0) {
    return -1
  }
  const i = n > 0 ? n - 1 : count + n
  return i >= 0 && i < count ? i : -1
}

/** Drop repeats, which `makeFace` rejects outright, keeping first occurrences. */
function dedupeRing(verts: number[], corners: number[]): number {
  const seen = new Set<number>()
  let n = 0

  for (let i = 0; i < verts.length; i++) {
    if (seen.has(verts[i])) {
      continue
    }
    seen.add(verts[i])
    verts[n] = verts[i]
    corners[n] = corners[i]
    n++
  }

  verts.length = n
  corners.length = n
  return n
}

/**
 * Read OBJ text into `mesh`. Unknown keywords (`usemtl`, `g`, `s`, …) are
 * skipped in silence: an importer that refuses a file over material groups it
 * does not model is worse than one that imports the geometry.
 */
export function readOBJ(text: string, mesh = new LeafMesh()): ObjReadResult {
  const stats: ObjReadStats = {
    verts         : 0,
    faces         : 0,
    degenerate    : 0,
    repaired      : 0,
    uvs           : false,
    normalsIgnored: 0,
    warnings      : [],
  }

  const warn = (msg: string): void => {
    if (stats.warnings.length < OBJ_MAX_WARNINGS) {
      stats.warnings.push(msg)
    }
  }

  /** Vertex handles in file order — OBJ indices address this, not the mesh. */
  const verts: number[] = []
  const uvTable: number[] = []
  // Corner → uv-table index, filled while faces are built and applied after,
  // because a growing corner column reallocates the array underneath us.
  const cornerUV: number[] = []
  const uvCorners: number[] = []

  const lines = text.split('\n')

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }

    const tok = line.split(/\s+/)
    const key = tok[0].toLowerCase()

    if (key === 'v') {
      if (tok.length < 4) {
        warn(`line ${ln + 1}: "v" needs three coordinates`)
        continue
      }
      verts.push(mesh.makeVert([parseFloat(tok[1]), parseFloat(tok[2]), parseFloat(tok[3])]))
      stats.verts++
    } else if (key === 'vt') {
      uvTable.push(tok.length > 1 ? parseFloat(tok[1]) : 0, tok.length > 2 ? parseFloat(tok[2]) : 0)
    } else if (key === 'vn') {
      // Vertex normals are derived from the topology on draw, so authored ones
      // would only ever disagree with what is rendered.
      stats.normalsIgnored++
    } else if (key === 'f') {
      const ring: number[] = []
      const ringUV: number[] = []

      for (let i = 1; i < tok.length; i++) {
        const parts = tok[i].split('/')
        const v = resolveIndex(parts[0], verts.length)
        if (v < 0) {
          warn(`line ${ln + 1}: vertex reference "${tok[i]}" is out of range`)
          continue
        }
        ring.push(verts[v])
        ringUV.push(parts.length > 1 && parts[1].length > 0 ? resolveIndex(parts[1], uvTable.length >> 1) : -1)
      }

      const before = ring.length
      if (dedupeRing(ring, ringUV) !== before) {
        stats.repaired++
      }

      if (ring.length < 3) {
        stats.degenerate++
        warn(`line ${ln + 1}: face has fewer than three distinct vertices`)
        continue
      }

      const f = mesh.makeFace([ring])
      if (f === ELEM_NONE) {
        stats.degenerate++
        warn(`line ${ln + 1}: face was rejected by the topology`)
        continue
      }
      stats.faces++

      // OBJ cannot express a hole ring, so this face has exactly one loop and
      // its corners come back in the order the ring went in.
      let i = 0
      for (const c of mesh.loopCorners(mesh.f.l[f])) {
        if (i < ringUV.length && ringUV[i] >= 0) {
          uvCorners.push(c)
          cornerUV.push(ringUV[i])
        }
        i++
      }
    }
  }

  if (uvCorners.length > 0) {
    stats.uvs = true
    const layer = mesh.attrs.add(Domain.CORNER, OBJ_UV_LAYER, AttrType.Float2)
    const data = layer.column.data
    for (let i = 0; i < uvCorners.length; i++) {
      data[uvCorners[i] * 2] = uvTable[cornerUV[i] * 2]
      data[uvCorners[i] * 2 + 1] = uvTable[cornerUV[i] * 2 + 1]
    }
  }

  return {mesh, stats}
}
