/**
 * Selection-overlay geometry — P12 step 2. Pure: imports nothing from
 * `scripts/`, so *what* the viewport shows is decided here and unit-tested,
 * and `overlay.ts` only turns these arrays into `SimpleMesh` batches.
 *
 * LiteMesh gets its overlay batches from sculptcore. LeafMesh has no C++ to
 * ask, so it builds its own — without which the modeling mode is unusable and
 * every later step of P12 is untestable by eye.
 */

import {Domain} from './attrs.js'
import {ELEM_NONE} from './elem_array.js'
import {faceVerts, selectFlags} from './select_geom.js'
import type {SelectDomain} from './select_geom.js'
import {LeafMesh} from './topo.js'
import type {Vec3} from './topo.js'
import {TriangulationCache, triangulateFace} from './triangulate.js'
import type {Tri} from './triangulate.js'

export type Rgba = readonly [number, number, number, number]

/** Every colour the overlay can paint. Replaceable so a theme can drive it. */
export interface OverlayTheme {
  vert: Rgba
  vertSelect: Rgba
  /** Every edge, when the wireframe overlay is on. */
  edge: Rgba
  edgeSelect: Rgba
  /** Fill tint over a selected face. */
  face: Rgba
  active: Rgba
  highlight: Rgba
}

export const DEFAULT_OVERLAY_THEME: OverlayTheme = {
  vert: [0.0, 0.0, 0.0, 1.0],
  vertSelect: [1.0, 0.55, 0.1, 1.0],
  edge: [0.1, 0.1, 0.1, 0.6],
  edgeSelect: [1.0, 0.65, 0.25, 1.0],
  face: [1.0, 0.6, 0.15, 0.28],
  active: [1.0, 1.0, 1.0, 1.0],
  highlight: [0.4, 0.9, 1.0, 1.0],
}

/** One element per domain, or `ELEM_NONE`. */
export type DomainMarks = Readonly<Partial<Record<SelectDomain, number>>>

export interface OverlayRequest {
  /** The sel-mode's enabled domains — what selection is *shown* for. */
  domains: readonly SelectDomain[]
  drawSelection: boolean
  drawWireframe: boolean
  drawPoints: boolean
  active?: DomainMarks
  highlight?: DomainMarks
  theme?: OverlayTheme
}

/** Position/colour pairs, one entry per emitted vertex. */
export interface OverlayBatch {
  co: Float32Array
  color: Float32Array
  /** Emitted vertices — triangles are `count / 3`, lines `count / 2`. */
  count: number
}

export interface OverlayGeometry {
  points: OverlayBatch
  lines: OverlayBatch
  tris: OverlayBatch
}

/**
 * How far off the surface the overlay floats, as a fraction of the mesh's
 * bounding diagonal. The WGSL port of `MeshEditShader` dropped the GLSL
 * polygon offset, so without a lift every wire z-fights with the face it
 * runs along.
 */
export const OVERLAY_LIFT = 0.0015

/** Bounding-box diagonal over live vertices; `0` for an empty mesh. */
export function meshDiagonal(mesh: LeafMesh): number {
  const co = mesh.v.co
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let any = false

  for (const v of mesh.v) {
    any = true
    for (let k = 0; k < 3; k++) {
      const x = co[v * 3 + k]
      if (x < lo[k]) {
        lo[k] = x
      }
      if (x > hi[k]) {
        hi[k] = x
      }
    }
  }

  return any ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0
}

/**
 * Accumulated face normals per vertex, in a fresh array. Deliberately not
 * `mesh.v.no` — that column belongs to the surface draw and is only current
 * after a rebuild, whereas the overlay runs every frame.
 */
export function overlayVertexNormals(mesh: LeafMesh): Float32Array {
  const no = new Float32Array(mesh.v.co.length)
  const fn: Vec3 = [0, 0, 0]

  for (const f of mesh.f) {
    mesh.faceNormal(f, fn)
    for (const v of faceVerts(mesh, f)) {
      no[v * 3] += fn[0]
      no[v * 3 + 1] += fn[1]
      no[v * 3 + 2] += fn[2]
    }
  }

  for (const v of mesh.v) {
    const i = v * 3
    const len = Math.hypot(no[i], no[i + 1], no[i + 2])
    if (len > 0) {
      no[i] /= len
      no[i + 1] /= len
      no[i + 2] /= len
    }
  }

  return no
}

/** Growable position+colour pair, flushed into an {@link OverlayBatch}. */
class BatchBuilder {
  private readonly co: number[] = []
  private readonly color: number[] = []

  push(x: number, y: number, z: number, c: Rgba): void {
    this.co.push(x, y, z)
    this.color.push(c[0], c[1], c[2], c[3])
  }

  finish(): OverlayBatch {
    return {
      co: Float32Array.from(this.co),
      color: Float32Array.from(this.color),
      count: this.co.length / 3,
    }
  }
}

function markOf(marks: DomainMarks | undefined, domain: SelectDomain): number {
  const h = marks?.[domain]
  return h === undefined ? ELEM_NONE : h
}

/**
 * Build every batch the overlay draws. Positions are lifted along the vertex
 * normal (see {@link OVERLAY_LIFT}); a face tint is lifted by half that, so
 * the wires stay on top of their own fill.
 */
export function buildSelectionOverlay(
  mesh: LeafMesh,
  req: OverlayRequest,
  cache?: TriangulationCache
): OverlayGeometry {
  const theme = req.theme ?? DEFAULT_OVERLAY_THEME
  const onVert = req.domains.includes(Domain.VERT)
  const onEdge = req.domains.includes(Domain.EDGE)
  const onFace = req.domains.includes(Domain.FACE)

  const points = new BatchBuilder()
  const lines = new BatchBuilder()
  const tris = new BatchBuilder()

  const co = mesh.v.co
  const no = overlayVertexNormals(mesh)
  const lift = meshDiagonal(mesh) * OVERLAY_LIFT

  const emit = (b: BatchBuilder, v: number, c: Rgba, scale: number): void => {
    const i = v * 3
    const d = lift * scale
    b.push(co[i] + no[i] * d, co[i + 1] + no[i + 1] * d, co[i + 2] + no[i + 2] * d, c)
  }

  if (req.drawPoints && onVert) {
    const flags = req.drawSelection ? selectFlags(mesh, Domain.VERT) : undefined
    const active = markOf(req.active, Domain.VERT)
    const highlight = markOf(req.highlight, Domain.VERT)

    for (const v of mesh.v) {
      let c = theme.vert
      if (v === highlight) {
        c = theme.highlight
      } else if (v === active) {
        c = theme.active
      } else if (flags !== undefined && flags[v] !== 0) {
        c = theme.vertSelect
      }
      emit(points, v, c, 1)
    }
  }

  // The wireframe draws every edge; with it off, only the selected ones show.
  const showSelEdges = req.drawSelection && onEdge
  if (req.drawWireframe || showSelEdges) {
    const flags = showSelEdges ? selectFlags(mesh, Domain.EDGE) : undefined
    const active = showSelEdges ? markOf(req.active, Domain.EDGE) : ELEM_NONE
    const highlight = showSelEdges ? markOf(req.highlight, Domain.EDGE) : ELEM_NONE

    for (const e of mesh.e) {
      const selected = flags !== undefined && flags[e] !== 0
      if (!req.drawWireframe && !selected && e !== active && e !== highlight) {
        continue
      }

      let c = theme.edge
      if (e === highlight) {
        c = theme.highlight
      } else if (e === active) {
        c = theme.active
      } else if (selected) {
        c = theme.edgeSelect
      }

      emit(lines, mesh.e.v1[e], c, 1)
      emit(lines, mesh.e.v2[e], c, 1)
    }
  }

  if (req.drawSelection && onFace) {
    const flags = selectFlags(mesh, Domain.FACE)
    const active = markOf(req.active, Domain.FACE)
    const highlight = markOf(req.highlight, Domain.FACE)
    const scratch: Tri[] = []

    for (const f of mesh.f) {
      const selected = flags !== undefined && flags[f] !== 0
      if (!selected && f !== active && f !== highlight) {
        continue
      }

      let c = theme.face
      if (f === highlight) {
        c = theme.highlight
      } else if (f === active) {
        c = theme.active
      }

      // A fill always keeps the theme's fill alpha, whatever tint it takes.
      const tint: Rgba = [c[0], c[1], c[2], theme.face[3]]

      let faceTris: readonly Tri[]
      if (cache !== undefined) {
        faceTris = cache.get(mesh, f)
      } else {
        scratch.length = 0
        triangulateFace(mesh, f, scratch)
        faceTris = scratch
      }

      for (const t of faceTris) {
        emit(tris, t.v[0], tint, 0.5)
        emit(tris, t.v[1], tint, 0.5)
        emit(tris, t.v[2], tint, 0.5)
      }
    }
  }

  return {points: points.finish(), lines: lines.finish(), tris: tris.finish()}
}

/**
 * A key that changes exactly when {@link buildSelectionOverlay} would produce
 * different geometry — `updateGen` covers topology, positions and selection;
 * the rest is the request itself.
 */
export function overlayCacheKey(updateGen: number, req: OverlayRequest): string {
  const marks = (m: DomainMarks | undefined): string =>
    `${markOf(m, Domain.VERT)},${markOf(m, Domain.EDGE)},${markOf(m, Domain.FACE)}`

  return [
    updateGen,
    [...req.domains].sort((a, b) => a - b).join('|'),
    req.drawSelection ? 1 : 0,
    req.drawWireframe ? 1 : 0,
    req.drawPoints ? 1 : 0,
    marks(req.active),
    marks(req.highlight),
  ].join(':')
}
