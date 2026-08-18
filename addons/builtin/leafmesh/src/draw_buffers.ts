/**
 * The CPU half of LeafMesh drawing: n-gons-with-holes flattened into the
 * unshared triangle-corner arrays a vertex pipeline wants.
 *
 * Unshared corners, not indexed vertices, because an attribute layer may live
 * on any domain — a UV on a corner, a material index on a face — and a shared
 * vertex cannot carry two different values of one. Three vertices per triangle
 * costs memory and buys one gather routine that works for every domain.
 *
 * This module imports nothing from `scripts/`, which is what keeps it testable
 * in plain jest; `draw.ts` is the half that knows about the host.
 */

import {AttrType, Domain, attrTypeSize} from './attrs.js'
import type {AttrLayer} from './attrs.js'
import {LeafMesh} from './topo.js'
import type {Tri} from './triangulate.js'

/** Position and normal for one mesh, three vertices per triangle. */
export interface DrawGeometry {
  triCount: number
  /** `triCount * 9` floats. */
  position: Float32Array
  /** `triCount * 9` floats. */
  normal: Float32Array
}

/**
 * Area-weighted smooth vertex normals, written into the mesh's derived `no`
 * column. Area weighting comes from leaving the triangle cross products
 * un-normalized until the final pass.
 */
export function recalcVertexNormals(mesh: LeafMesh, tris: readonly Tri[]): Float32Array {
  const co = mesh.v.co
  const no = mesh.v.no
  no.fill(0)

  for (const tri of tris) {
    const a = tri.v[0] * 3
    const b = tri.v[1] * 3
    const c = tri.v[2] * 3

    const ux = co[b] - co[a]
    const uy = co[b + 1] - co[a + 1]
    const uz = co[b + 2] - co[a + 2]
    const vx = co[c] - co[a]
    const vy = co[c + 1] - co[a + 1]
    const vz = co[c + 2] - co[a + 2]

    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx

    for (const i of [a, b, c]) {
      no[i] += nx
      no[i + 1] += ny
      no[i + 2] += nz
    }
  }

  for (const v of mesh.v) {
    const i = v * 3
    const len = Math.sqrt(no[i] * no[i] + no[i + 1] * no[i + 1] + no[i + 2] * no[i + 2])
    if (len > 0) {
      no[i] /= len
      no[i + 1] /= len
      no[i + 2] /= len
    }
  }

  return no
}

/** Expand `tris` into the position/normal pair a pipeline binds at slots 0/1. */
export function buildDrawGeometry(mesh: LeafMesh, tris: readonly Tri[]): DrawGeometry {
  const co = mesh.v.co
  const no = recalcVertexNormals(mesh, tris)
  const position = new Float32Array(tris.length * 9)
  const normal = new Float32Array(tris.length * 9)

  for (let t = 0; t < tris.length; t++) {
    for (let k = 0; k < 3; k++) {
      const src = tris[t].v[k] * 3
      const dst = t * 9 + k * 3
      for (let j = 0; j < 3; j++) {
        position[dst + j] = co[src + j]
        normal[dst + j] = no[src + j]
      }
    }
  }

  return {triCount: tris.length, position, normal}
}

/**
 * The domains a draw-time attribute lookup searches, in order. Corner first
 * because that is where a UV lives, and a vertex-domain layer of the same name
 * is the coarser answer. Edges are absent: an edge value has no one triangle
 * corner it belongs to.
 */
const LOOKUP_DOMAINS: readonly Domain[] = [Domain.CORNER, Domain.VERT, Domain.FACE, Domain.LOOP]

/** The layer a material's attribute read by this name resolves to, if any. */
export function resolveDrawAttr(mesh: LeafMesh, name: string): AttrLayer | undefined {
  for (const domain of LOOKUP_DOMAINS) {
    const layer = mesh.attrs.get(domain, name)
    if (layer !== undefined) {
      return layer
    }
  }
  return undefined
}

/** The element of `domain` a given triangle corner reads its value from. */
function elemForCorner(mesh: LeafMesh, tri: Tri, k: number, domain: Domain): number {
  switch (domain) {
    case Domain.CORNER:
      return tri.c[k]
    case Domain.VERT:
      return tri.v[k]
    case Domain.FACE:
      return tri.f
    case Domain.LOOP:
      return mesh.c.l[tri.c[k]]
    default:
      return -1
  }
}

/**
 * Gather one named attribute into a float buffer of `elemSize` components per
 * triangle corner — the shape `buildMaterialVertexLayout` declares for an
 * `AttributeNode` read.
 *
 * Values are copied numerically, not rescaled: a `Byte` layer holding 255 comes
 * out as 255.0, because the caller asked for a float slot and not for the
 * UNORM8 vertex fetch that would have normalized it. A layer narrower than the
 * request zero-fills the tail, except that a 4-component request gets w = 1 —
 * the same default-fill WebGPU applies to a narrow vertex format.
 */
export function gatherDrawAttr(
  mesh: LeafMesh,
  tris: readonly Tri[],
  name: string,
  elemSize: number
): Float32Array | undefined {
  const layer = resolveDrawAttr(mesh, name)
  if (layer === undefined) {
    return undefined
  }

  const src = layer.column.data
  const srcSize = attrTypeSize(layer.type)
  const n = Math.min(srcSize, elemSize)
  const out = new Float32Array(tris.length * 3 * elemSize)
  if (elemSize === 4 && srcSize < 4) {
    for (let i = 3; i < out.length; i += 4) {
      out[i] = 1
    }
  }

  for (let t = 0; t < tris.length; t++) {
    for (let k = 0; k < 3; k++) {
      const elem = elemForCorner(mesh, tris[t], k, layer.domain)
      if (elem < 0) {
        continue
      }
      const s = elem * srcSize
      const d = (t * 3 + k) * elemSize
      for (let j = 0; j < n; j++) {
        out[d + j] = src[s + j]
      }
    }
  }

  return out
}

/** Every layer name a material could read, deduplicated across domains. */
export function drawAttrNames(mesh: LeafMesh): string[] {
  const names: string[] = []
  const seen = new Set<string>()

  for (const domain of LOOKUP_DOMAINS) {
    for (const layer of mesh.attrs.layers(domain)) {
      // Dot-prefixed layers are host bookkeeping (`.select`), never material
      // inputs, and `Bool` has no vertex format to fetch it with.
      if (layer.name.startsWith('.') || layer.type === AttrType.Bool || seen.has(layer.name)) {
        continue
      }
      seen.add(layer.name)
      names.push(layer.name)
    }
  }

  return names
}
