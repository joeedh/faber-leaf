/**
 * Primitive builders. These exist as much to exercise the topology layer as to
 * be useful — between them they cover quads, fans, poles, and (in the tube) a
 * face with a hole, which is the case a mesh library usually gets wrong.
 *
 * Everything is built Z-up and wound so face normals point out of the solid.
 */

import {LeafMesh, type Vec3} from './topo.js'

export interface PrimitiveResult {
  verts: number[]
  faces: number[]
}

/** A single quad in the XY plane, normal +Z. */
export function makePlane(mesh: LeafMesh, size = 1): PrimitiveResult {
  return makeGrid(mesh, 1, 1, size)
}

/** An `nx` by `ny` quad grid in the XY plane, normal +Z. */
export function makeGrid(mesh: LeafMesh, nx: number, ny: number, size = 1): PrimitiveResult {
  const verts: number[] = []
  const faces: number[] = []
  const half = size * 0.5

  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      verts.push(mesh.makeVert([-half + (size * i) / nx, -half + (size * j) / ny, 0]))
    }
  }

  const at = (i: number, j: number): number => verts[j * (nx + 1) + i]
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      faces.push(mesh.makeFace([[at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]]))
    }
  }

  return {verts, faces}
}

/** An axis-aligned cube of six quads, centred on the origin. */
export function makeCube(mesh: LeafMesh, size = 1): PrimitiveResult {
  const h = size * 0.5
  const corners: Vec3[] = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ]

  const verts = corners.map((co) => mesh.makeVert(co))
  const rings = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
  ]

  const faces = rings.map((ring) => mesh.makeFace([ring.map((i) => verts[i])]))
  return {verts, faces}
}

/** A UV sphere: quad bands between two triangle-fan poles, on the Z axis. */
export function makeUVSphere(mesh: LeafMesh, segments = 16, rings = 8, radius = 1): PrimitiveResult {
  const verts: number[] = []
  const faces: number[] = []

  const north = mesh.makeVert([0, 0, radius])
  verts.push(north)

  const band: number[][] = []
  for (let j = 1; j < rings; j++) {
    const theta = (Math.PI * j) / rings
    const z = radius * Math.cos(theta)
    const s = radius * Math.sin(theta)
    const row: number[] = []
    for (let i = 0; i < segments; i++) {
      const phi = (2 * Math.PI * i) / segments
      const v = mesh.makeVert([s * Math.cos(phi), s * Math.sin(phi), z])
      row.push(v)
      verts.push(v)
    }
    band.push(row)
  }

  const south = mesh.makeVert([0, 0, -radius])
  verts.push(south)

  const top = band[0]
  const bottom = band[band.length - 1]
  for (let i = 0; i < segments; i++) {
    const k = (i + 1) % segments
    faces.push(mesh.makeFace([[north, top[i], top[k]]]))
    faces.push(mesh.makeFace([[south, bottom[k], bottom[i]]]))
  }

  for (let j = 0; j + 1 < band.length; j++) {
    const a = band[j]
    const b = band[j + 1]
    for (let i = 0; i < segments; i++) {
      const k = (i + 1) % segments
      faces.push(mesh.makeFace([[a[i], b[i], b[k], a[k]]]))
    }
  }

  return {verts, faces}
}

/**
 * A tube: an outer and an inner cylinder wall closed by two annular caps. The
 * caps are the point — each is a single face with a hole, so this is the
 * primitive that exercises the multi-loop path end to end.
 */
export function makeTube(mesh: LeafMesh, segments = 16, radius = 1, innerRadius = 0.5, height = 1): PrimitiveResult {
  const verts: number[] = []
  const faces: number[] = []
  const h = height * 0.5

  const ring = (r: number, z: number): number[] => {
    const out: number[] = []
    for (let i = 0; i < segments; i++) {
      const phi = (2 * Math.PI * i) / segments
      const v = mesh.makeVert([r * Math.cos(phi), r * Math.sin(phi), z])
      out.push(v)
      verts.push(v)
    }
    return out
  }

  const outerBot = ring(radius, -h)
  const outerTop = ring(radius, h)
  const innerBot = ring(innerRadius, -h)
  const innerTop = ring(innerRadius, h)

  for (let i = 0; i < segments; i++) {
    const k = (i + 1) % segments
    faces.push(mesh.makeFace([[outerBot[i], outerBot[k], outerTop[k], outerTop[i]]]))
    faces.push(mesh.makeFace([[innerBot[i], innerTop[i], innerTop[k], innerBot[k]]]))
  }

  faces.push(mesh.makeFace([outerTop, innerTop]))
  faces.push(mesh.makeFace([outerBot.slice().reverse(), innerBot]))

  return {verts, faces}
}
