import {invalidatableOf, triangleSourceOf} from '../core/data_kinds.js'
import {GeometryDataRef, InvalidationKind} from '../core/geometry_contract.js'

const HEADER_BYTES = 80
const COUNT_BYTES = 4
const FACET_BYTES = 50

/**
 * Binary STL. Every facet is the same 50 bytes and the count is known before
 * any of them are written, so this sizes the buffer up front rather than
 * pushing through a writer.
 *
 * @param meshes geometry data blocks; one that does not declare the TRIANGLES
 *   capability is skipped.
 */
export function exportSTLMesh(meshes: Iterable<GeometryDataRef>): ArrayBuffer {
  const batches: {positions: Float64Array; indices: Int32Array}[] = []
  let tottri = 0

  for (const mesh of meshes) {
    const src = triangleSourceOf(mesh)
    if (!src) {
      continue
    }

    // Might be in sculpt mode, where the tesselation can lag the mesh.
    invalidatableOf(mesh)?.invalidate(InvalidationKind.TOPOLOGY)

    const tris = src.extractTriangles()
    batches.push(tris)
    tottri += (tris.indices.length / 3) | 0
  }

  const buf = new ArrayBuffer(HEADER_BYTES + COUNT_BYTES + tottri * FACET_BYTES)
  const view = new DataView(buf)

  view.setUint32(HEADER_BYTES, tottri, true)

  let at = HEADER_BYTES + COUNT_BYTES

  for (const {positions, indices} of batches) {
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3,
        b = indices[i + 1] * 3,
        c = indices[i + 2] * 3

      // STL stores a facet normal, so take the geometric one rather than
      // averaging whatever per-vertex normals the source happened to supply.
      const ux = positions[b] - positions[a],
        uy = positions[b + 1] - positions[a + 1],
        uz = positions[b + 2] - positions[a + 2]
      const vx = positions[c] - positions[a],
        vy = positions[c + 1] - positions[a + 1],
        vz = positions[c + 2] - positions[a + 2]

      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)

      if (len > 0.0) {
        nx /= len
        ny /= len
        nz /= len
      }

      view.setFloat32(at, nx, true)
      view.setFloat32(at + 4, ny, true)
      view.setFloat32(at + 8, nz, true)
      at += 12

      for (const off of [a, b, c]) {
        view.setFloat32(at, positions[off], true)
        view.setFloat32(at + 4, positions[off + 1], true)
        view.setFloat32(at + 8, positions[off + 2], true)
        at += 12
      }

      view.setUint16(at, 0, true)
      at += 2
    }
  }

  return buf
}
