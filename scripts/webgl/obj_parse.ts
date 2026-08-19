/**
 * Wavefront OBJ → flat triangle soup. Pure: imports nothing, so it is unit
 * tested directly and {@link ./simplemesh_obj} only has to pour the
 * result into a `SimpleMesh`.
 *
 * This is deliberately just enough of the format for `shape_data.ts`'s embedded
 * widget gizmos. The BREP mesh addon used to parse them into a full `Mesh` and
 * call `genRender`; P13 deleted it, so the host owns the little it needed.
 * Authored `vn`/`vt` are skipped, as they were before: the BREP path discarded
 * them and flat-shaded every face.
 */

/** Triangle corners, 9 floats per triangle, with each face's normal repeated at all three. */
export interface ObjTris {
  positions: number[]
  normals: number[]
}

/** Resolve one `f` reference (`v`, `v/vt`, `v//vn`, `v/vt/vn`); OBJ indices are 1-based, negatives relative. */
function vertIndex(ref: string, total: number): number {
  const i = parseInt(ref.split('/')[0])
  return i > 0 ? i - 1 : total + i
}

/** Newell's method — correct for the n-gons the shape files contain, not just for triangles. */
function faceNormal(ring: number[][]): number[] {
  const no = [0, 0, 0]

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]

    no[0] += (a[1] - b[1]) * (a[2] + b[2])
    no[1] += (a[2] - b[2]) * (a[0] + b[0])
    no[2] += (a[0] - b[0]) * (a[1] + b[1])
  }

  const len = Math.sqrt(no[0] * no[0] + no[1] * no[1] + no[2] * no[2])

  return len > 0 ? [no[0] / len, no[1] / len, no[2] / len] : [0, 0, 1]
}

export function parseOBJTris(buf: string): ObjTris {
  const positions: number[] = []
  const normals: number[] = []
  const verts: number[][] = []
  const ring: number[][] = []

  for (const line of buf.split('\n')) {
    const parts = line.trim().split(/\s+/)

    if (parts[0] === 'v') {
      verts.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])])
    } else if (parts[0] === 'f') {
      ring.length = 0

      for (let i = 1; i < parts.length; i++) {
        const v = verts[vertIndex(parts[i], verts.length)]
        // A ring naming the same vertex twice is a malformed face, not a slit:
        // drop the repeat rather than emit a degenerate triangle for it.
        if (v !== undefined && !ring.includes(v)) {
          ring.push(v)
        }
      }

      if (ring.length < 3) {
        continue
      }

      const no = faceNormal(ring)

      for (let i = 1; i < ring.length - 1; i++) {
        for (const v of [ring[0], ring[i], ring[i + 1]]) {
          positions.push(v[0], v[1], v[2])
          normals.push(no[0], no[1], no[2])
        }
      }
    }
  }

  return {positions, normals}
}
