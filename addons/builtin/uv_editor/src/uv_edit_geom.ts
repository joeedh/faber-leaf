/**
 * Implements the UV editor's geometry logic — P18 §5 step 3. It covers
 * drawing, picking, selection, flags, and transform, expressed entirely
 * against `IUVSource`.
 *
 * Two properties here are deliberate and load-bearing.
 *
 * This module names no geometry type. Everything here reaches its data
 * through the contract, which is exit criterion 11: the editor works on any
 * source, and a grep for a concrete type in this addon has to come back
 * empty.
 *
 * This module runs under jest. The only host import is `import type`,
 * which the transform erases, so nothing resolves `@framework/api` at
 * runtime. Because of that, the whole editor can be driven headlessly by
 * the in-memory double — `tests/lib/uv_grid_source.ts`, which has no
 * geometry behind it at all. Every rule that could hide in a UI callback
 * lives in this file for the same reason.
 *
 * Handles are valid only until {@link IUVSource.topoStamp} moves. Anything
 * here that hands handles back to a caller who will hold them — a
 * transform, a flag snapshot — carries the stamp it read them at.
 */

import type {ElementHandles, IUVSource} from '@framework/api'

/** Matches the host contract's `UVFlags`, which is a value and cannot be imported. */
export const UV_SELECT = 1
export const UV_PIN = 2

/** How far apart two UVs may be and still count as the same point. */
export const UV_SNAP_LIMIT = 0.00025

/** Controls which faces an operation reads; `false` reads the whole layer. */
export interface UVScope {
  selectedFacesOnly?: boolean
}

// ---------------------------------------------------------------------------
// Face rings
// ---------------------------------------------------------------------------

/** One CSR row as a view, not a copy. */
function row(csr: {offsets: Int32Array; values: Int32Array}, i: number): Int32Array {
  return csr.values.subarray(csr.offsets[i], csr.offsets[i + 1])
}

/**
 * The faces in scope and their rings, read together because every caller here
 * needs both and the source charges a round trip for each.
 */
export interface UVRings {
  faces: Int32Array
  rings: {offsets: Int32Array; values: Int32Array}
  topoStamp: number
}

export function readUVRings(source: IUVSource, layer: number, scope: UVScope = {}): UVRings {
  const faces = source.listUVFaces(layer, scope.selectedFacesOnly ?? false)
  return {faces, rings: source.getUVFaceRings(layer, faces), topoStamp: source.topoStamp}
}

/**
 * The distinct UV elements the rings cover, in first-seen order. Rings repeat
 * an element wherever two faces share it, and every consumer below wants each
 * one once.
 */
export function ringElements(rings: UVRings): Int32Array {
  const seen = new Set<number>()
  const out: number[] = []

  for (const h of rings.rings.values) {
    if (!seen.has(h)) {
      seen.add(h)
      out.push(h)
    }
  }
  return Int32Array.from(out)
}

// ---------------------------------------------------------------------------
// Draw geometry
// ---------------------------------------------------------------------------

/**
 * Everything the editor draws, as flat buffers. Nothing here is a UI type: the
 * caller turns these into whatever its renderer wants, and a headless test
 * asserts on them directly.
 */
export interface UVDrawGeometry {
  /** Ring edges, 4 floats per segment (u1, v1, u2, v2). */
  edges: Float32Array

  /** One vertex per distinct element, 2 floats each, parallel to `handles`. */
  points: Float32Array
  handles: Int32Array
  flags: Uint8Array

  topoStamp: number
}

export function buildUVDrawGeometry(source: IUVSource, layer: number, scope: UVScope = {}): UVDrawGeometry {
  const rings = readUVRings(source, layer, scope)
  const handles = ringElements(rings)
  const points = source.getUVs(layer, handles, new Float32Array(handles.length * 2))
  const flags = source.getUVFlags(layer, handles, new Uint8Array(handles.length))

  const at = new Map<number, number>()
  for (let i = 0; i < handles.length; i++) {
    at.set(handles[i], i)
  }

  let segments = 0
  for (let f = 0; f < rings.faces.length; f++) {
    const ring = row(rings.rings, f)
    if (ring.length >= 2) {
      segments += ring.length
    }
  }

  const edges = new Float32Array(segments * 4)
  let n = 0

  for (let f = 0; f < rings.faces.length; f++) {
    const ring = row(rings.rings, f)
    if (ring.length < 2) {
      continue
    }

    for (let i = 0; i < ring.length; i++) {
      const a = at.get(ring[i])!
      const b = at.get(ring[(i + 1) % ring.length])!

      edges[n++] = points[a * 2]
      edges[n++] = points[a * 2 + 1]
      edges[n++] = points[b * 2]
      edges[n++] = points[b * 2 + 1]
    }
  }

  return {edges, points, handles, flags, topoStamp: rings.topoStamp}
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export interface UVPickHit {
  handle: number
  u: number
  v: number
  dist: number

  /** Draw order. Higher was drawn later, so it is the one on top. */
  z: number
  selected: boolean
}

export interface UVPickOptions extends UVScope {
  /** Search radius in UV units. */
  limit?: number
  snapLimit?: number
}

/**
 * Elements within `limit` of (u, v), nearest first.
 *
 * The ordering is the old editor's, restated: distance decides, except that
 * coincident elements sort top-most-first so a stack can be picked apart, and
 * a near-tie prefers the *unselected* one so a second click reaches what is
 * underneath a selection. The old code expressed both by scaling the distance
 * by the candidate count; the tolerance below says the same thing in the units
 * the values actually have.
 */
export function pickNearestUV(
  source: IUVSource,
  layer: number,
  u: number,
  v: number,
  opts: UVPickOptions = {}
): UVPickHit[] {
  const limit = opts.limit ?? 0.2
  const snap = opts.snapLimit ?? UV_SNAP_LIMIT

  const rings = readUVRings(source, layer, opts)
  const hits: UVPickHit[] = []
  let z = 0

  for (let f = 0; f < rings.faces.length; f++) {
    const ring = row(rings.rings, f)
    if (ring.length === 0) {
      continue
    }

    const uv = source.getUVs(layer, ring)
    const flags = source.getUVFlags(layer, ring)

    for (let i = 0; i < ring.length; i++) {
      const du = uv[i * 2] - u
      const dv = uv[i * 2 + 1] - v
      const dist = Math.sqrt(du * du + dv * dv)

      if (dist < limit) {
        hits.push({
          handle: ring[i],
          u     : uv[i * 2],
          v     : uv[i * 2 + 1],
          dist,
          z,
          selected: (flags[i] & UV_SELECT) !== 0,
        })
      }
      z++
    }
  }

  hits.sort((a, b) => {
    const du = a.u - b.u
    const dv = a.v - b.v

    if (Math.sqrt(du * du + dv * dv) < snap) {
      return b.z - a.z
    }
    if (Math.abs(a.dist - b.dist) > snap) {
      return a.dist - b.dist
    }
    return (a.selected ? 1 : 0) - (b.selected ? 1 : 0)
  })

  return hits
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/** Every element's flags at one instant, which is all an undo step needs. */
export interface UVFlagSnapshot {
  handles: Int32Array
  flags: Uint8Array
  topoStamp: number
}

export function snapshotUVFlags(source: IUVSource, layer: number, scope: UVScope = {}): UVFlagSnapshot {
  const handles = ringElements(readUVRings(source, layer, scope))
  return {
    handles,
    flags    : source.getUVFlags(layer, handles, new Uint8Array(handles.length)),
    topoStamp: source.topoStamp,
  }
}

/**
 * Put a snapshot back. Refuses a stale one rather than writing through handles
 * that now mean something else — a silently wrong undo is worse than a lost one.
 */
export function restoreUVFlags(source: IUVSource, layer: number, snap: UVFlagSnapshot): boolean {
  if (snap.topoStamp !== source.topoStamp) {
    return false
  }

  source.setUVFlags(layer, snap.handles, snap.flags)
  return true
}

/** UVs of a specific handle set, for an op that has to put them back. */
export interface UVCoordSnapshot {
  handles: Int32Array
  uvs: Float32Array
  topoStamp: number
}

/**
 * Snapshots the UVs of `handles` only, not the whole scope, because a
 * transform undo has to be proportional to what moved rather than to the
 * layer.
 */
export function snapshotUVCoords(source: IUVSource, layer: number, handles: ElementHandles): UVCoordSnapshot {
  const copy = Int32Array.from(handles as ArrayLike<number>)

  return {
    handles  : copy,
    uvs      : source.getUVs(layer, copy, new Float32Array(copy.length * 2)),
    topoStamp: source.topoStamp,
  }
}

/** Put one back, refusing a stale one for {@link restoreUVFlags}'s reason. */
export function restoreUVCoords(source: IUVSource, layer: number, snap: UVCoordSnapshot): boolean {
  if (snap.topoStamp !== source.topoStamp) {
    return false
  }

  source.setUVs(layer, snap.handles, snap.uvs)
  return true
}

export type UVFlagAction = 'set' | 'clear' | 'toggle'

export function applyUVFlag(
  source: IUVSource,
  layer: number,
  handles: ElementHandles,
  flag: number,
  action: UVFlagAction
): void {
  const n = handles.length
  if (n === 0 || flag === 0) {
    return
  }

  const cur = source.getUVFlags(layer, handles, new Uint8Array(n))

  for (let i = 0; i < n; i++) {
    if (action === 'set') {
      cur[i] |= flag
    } else if (action === 'clear') {
      cur[i] &= ~flag
    } else {
      cur[i] ^= flag
    }
  }
  source.setUVFlags(layer, handles, cur)
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type UVSelectMode = 'add' | 'sub' | 'auto'
export type UVSelectOneMode = 'unique' | 'add' | 'sub'

export function listSelectedUVs(source: IUVSource, layer: number, scope: UVScope = {}): Int32Array {
  const handles = ringElements(readUVRings(source, layer, scope))
  const flags = source.getUVFlags(layer, handles, new Uint8Array(handles.length))

  const out: number[] = []
  for (let i = 0; i < handles.length; i++) {
    if (flags[i] & UV_SELECT) {
      out.push(handles[i])
    }
  }
  return Int32Array.from(out)
}

/**
 * Select or deselect everything in scope. `'auto'` deselects if anything is
 * selected and selects otherwise, which is what a single toggle key should do.
 * Returns the elements it wrote.
 */
export function selectAllUVs(
  source: IUVSource,
  layer: number,
  mode: UVSelectMode = 'auto',
  scope: UVScope = {}
): Int32Array {
  const handles = ringElements(readUVRings(source, layer, scope))
  if (handles.length === 0) {
    return handles
  }

  const flags = source.getUVFlags(layer, handles, new Uint8Array(handles.length))
  let select = mode === 'add'

  if (mode === 'auto') {
    select = true
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] & UV_SELECT) {
        select = false
        break
      }
    }
  }

  for (let i = 0; i < flags.length; i++) {
    flags[i] = select ? flags[i] | UV_SELECT : flags[i] & ~UV_SELECT
  }
  source.setUVFlags(layer, handles, flags)

  return handles
}

/**
 * Select specific elements. `'unique'` clears the scope first, which is the
 * plain-click behaviour; the other two modes leave the rest alone.
 */
export function selectOneUV(
  source: IUVSource,
  layer: number,
  handles: ElementHandles,
  mode: UVSelectOneMode = 'unique',
  scope: UVScope = {}
): void {
  if (mode === 'unique') {
    const all = ringElements(readUVRings(source, layer, scope))
    const cleared = source.getUVFlags(layer, all, new Uint8Array(all.length))

    for (let i = 0; i < cleared.length; i++) {
      cleared[i] &= ~UV_SELECT
    }
    source.setUVFlags(layer, all, cleared)
  }

  applyUVFlag(source, layer, handles, UV_SELECT, mode === 'sub' ? 'clear' : 'set')
}

// ---------------------------------------------------------------------------
// Islands
// ---------------------------------------------------------------------------

/**
 * Connected components of the UV layer. Two elements are linked when a face
 * ring holds both, or when they are coincident on one owner — which is exactly
 * what a seam is the absence of. `getUVFans` supplies the second relation, so
 * this needs no notion of an edge and works on a source with no topology.
 */
export function uvIslands(
  source: IUVSource,
  layer: number,
  scope: UVScope = {}
): {offsets: Int32Array; values: Int32Array} {
  const rings = readUVRings(source, layer, scope)
  const handles = ringElements(rings)

  const at = new Map<number, number>()
  for (let i = 0; i < handles.length; i++) {
    at.set(handles[i], i)
  }

  const parent = new Int32Array(handles.length)
  for (let i = 0; i < parent.length; i++) {
    parent[i] = i
  }

  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) {
      parent[rb] = ra
    }
  }

  for (let f = 0; f < rings.faces.length; f++) {
    const ring = row(rings.rings, f)
    for (let i = 1; i < ring.length; i++) {
      union(at.get(ring[0])!, at.get(ring[i])!)
    }
  }

  const fans = source.getUVFans(layer, handles)
  for (let i = 0; i < handles.length; i++) {
    for (const other of row(fans, i)) {
      const j = at.get(other)
      if (j !== undefined) {
        union(i, j)
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < handles.length; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g) {
      g.push(handles[i])
    } else {
      groups.set(r, [handles[i]])
    }
  }

  return toCSR(Array.from(groups.values()))
}

/** The island `seed` belongs to, or an empty array when it is out of scope. */
export function uvIslandOf(source: IUVSource, layer: number, seed: number, scope: UVScope = {}): Int32Array {
  const islands = uvIslands(source, layer, scope)

  for (let i = 0; i + 1 < islands.offsets.length; i++) {
    const island = row(islands, i)
    if (island.includes(seed)) {
      return Int32Array.from(island)
    }
  }
  return new Int32Array(0)
}

/** Select (or deselect) everything linked to `seed`. Returns what it wrote. */
export function selectLinkedUV(
  source: IUVSource,
  layer: number,
  seed: number,
  mode: 'add' | 'sub' = 'add',
  scope: UVScope = {}
): Int32Array {
  const island = uvIslandOf(source, layer, seed, scope)
  applyUVFlag(source, layer, island, UV_SELECT, mode === 'sub' ? 'clear' : 'set')
  return island
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

export interface UVPropOptions {
  /** Off means selected elements only, all at full weight. */
  enabled?: boolean
  radius?: number

  /** Restrict falloff to islands that already hold a selected element. */
  islandOnly?: boolean

  /**
   * Maps 0..1 distance to 0..1 weight. Defaults to smoothstep; the host passes
   * its own curve so the editor and the 3D viewport fall off alike, and so this
   * file needs nothing from the host to run.
   */
  falloff?: (t: number) => number
}

export interface UVTransOptions extends UVScope {
  prop?: UVPropOptions
}

/**
 * The elements a transform moves, their starting UVs, and their weights. Held
 * across a modal drag, so it carries the stamp it was gathered at.
 */
export interface UVTransData {
  handles: Int32Array
  start: Float32Array
  weights: Float32Array

  /** Midpoint of the full-weight elements' bounds — the pivot. */
  center: Float32Array
  topoStamp: number
}

function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

export function gatherUVTransData(source: IUVSource, layer: number, opts: UVTransOptions = {}): UVTransData {
  const prop = opts.prop ?? {}
  const handles = ringElements(readUVRings(source, layer, opts))
  const uv = source.getUVs(layer, handles, new Float32Array(handles.length * 2))
  const flags = source.getUVFlags(layer, handles, new Uint8Array(handles.length))

  const picked: number[] = []
  const weights: number[] = []

  if (!prop.enabled || !prop.radius) {
    for (let i = 0; i < handles.length; i++) {
      if (flags[i] & UV_SELECT) {
        picked.push(i)
        weights.push(1)
      }
    }
  } else {
    const radius = prop.radius
    const curve = prop.falloff ?? smoothstep
    const island = prop.islandOnly ? islandIndexOf(source, layer, handles, opts) : undefined

    const live = new Set<number>()
    if (island) {
      for (let i = 0; i < handles.length; i++) {
        if (flags[i] & UV_SELECT) {
          live.add(island[i])
        }
      }
    }

    for (let i = 0; i < handles.length; i++) {
      if (flags[i] & UV_SELECT) {
        picked.push(i)
        weights.push(1)
        continue
      }
      if (island && !live.has(island[i])) {
        continue
      }

      let nearest = Infinity
      for (let j = 0; j < handles.length; j++) {
        if (i === j || !(flags[j] & UV_SELECT)) {
          continue
        }
        if (island && island[i] !== island[j]) {
          continue
        }

        const du = uv[i * 2] - uv[j * 2]
        const dv = uv[i * 2 + 1] - uv[j * 2 + 1]
        const d = Math.sqrt(du * du + dv * dv)

        if (d < nearest) {
          nearest = d
        }
      }

      if (nearest < radius) {
        picked.push(i)
        weights.push(curve(1 - nearest / radius))
      }
    }
  }

  const out: UVTransData = {
    handles  : new Int32Array(picked.length),
    start    : new Float32Array(picked.length * 2),
    weights  : Float32Array.from(weights),
    center   : new Float32Array(2),
    topoStamp: source.topoStamp,
  }

  let minU = Infinity
  let minV = Infinity
  let maxU = -Infinity
  let maxV = -Infinity

  for (let k = 0; k < picked.length; k++) {
    const i = picked[k]
    out.handles[k] = handles[i]
    out.start[k * 2] = uv[i * 2]
    out.start[k * 2 + 1] = uv[i * 2 + 1]

    if (out.weights[k] > 0.9999) {
      minU = Math.min(minU, uv[i * 2])
      minV = Math.min(minV, uv[i * 2 + 1])
      maxU = Math.max(maxU, uv[i * 2])
      maxV = Math.max(maxV, uv[i * 2 + 1])
    }
  }

  if (minU <= maxU) {
    out.center[0] = (minU + maxU) * 0.5
    out.center[1] = (minV + maxV) * 0.5
  }
  return out
}

/** Island index per entry of `handles`, for the island-only falloff. */
function islandIndexOf(source: IUVSource, layer: number, handles: Int32Array, scope: UVScope): Int32Array {
  const islands = uvIslands(source, layer, scope)
  const byHandle = new Map<number, number>()

  for (let i = 0; i + 1 < islands.offsets.length; i++) {
    for (const h of row(islands, i)) {
      byHandle.set(h, i)
    }
  }

  const out = new Int32Array(handles.length)
  for (let i = 0; i < handles.length; i++) {
    out[i] = byHandle.get(handles[i]) ?? -1
  }
  return out
}

/**
 * Write `uv` back through `td`. Every transform below is "compute from
 * `start`, then blend by weight", so a modal drag re-applies from the same
 * origin instead of accumulating rounding.
 */
function writeTrans(source: IUVSource, layer: number, td: UVTransData, uv: Float32Array): boolean {
  if (td.topoStamp !== source.topoStamp) {
    return false
  }

  source.setUVs(layer, td.handles, uv)
  return true
}

export function applyUVTranslate(source: IUVSource, layer: number, td: UVTransData, du: number, dv: number): boolean {
  const uv = new Float32Array(td.start.length)

  for (let i = 0; i < td.handles.length; i++) {
    const w = td.weights[i]
    uv[i * 2] = td.start[i * 2] + du * w
    uv[i * 2 + 1] = td.start[i * 2 + 1] + dv * w
  }
  return writeTrans(source, layer, td, uv)
}

export function applyUVScale(source: IUVSource, layer: number, td: UVTransData, su: number, sv: number): boolean {
  const uv = new Float32Array(td.start.length)
  const cu = td.center[0]
  const cv = td.center[1]

  for (let i = 0; i < td.handles.length; i++) {
    const w = td.weights[i]
    const u = (td.start[i * 2] - cu) * su + cu
    const v = (td.start[i * 2 + 1] - cv) * sv + cv

    uv[i * 2] = td.start[i * 2] + (u - td.start[i * 2]) * w
    uv[i * 2 + 1] = td.start[i * 2 + 1] + (v - td.start[i * 2 + 1]) * w
  }
  return writeTrans(source, layer, td, uv)
}

export function applyUVRotate(source: IUVSource, layer: number, td: UVTransData, angle: number): boolean {
  const uv = new Float32Array(td.start.length)
  const cu = td.center[0]
  const cv = td.center[1]
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)

  for (let i = 0; i < td.handles.length; i++) {
    const w = td.weights[i]
    const du = td.start[i * 2] - cu
    const dv = td.start[i * 2 + 1] - cv
    const u = du * cos - dv * sin + cu
    const v = du * sin + dv * cos + cv

    uv[i * 2] = td.start[i * 2] + (u - td.start[i * 2]) * w
    uv[i * 2 + 1] = td.start[i * 2 + 1] + (v - td.start[i * 2 + 1]) * w
  }
  return writeTrans(source, layer, td, uv)
}

/** Put a gathered transform's starting UVs back — the undo half of a drag. */
export function restoreUVTransData(source: IUVSource, layer: number, td: UVTransData): boolean {
  return writeTrans(source, layer, td, td.start)
}

// ---------------------------------------------------------------------------
// Ring layouts
// ---------------------------------------------------------------------------

/**
 * Unwrap-free layouts. They only reposition each face's ring, so unlike the
 * solvers in `uv_solve.ts` they need no 3D positions behind the source and no
 * vector math — which is also why they live here rather than there.
 *
 * Both are tri/quad operations, faithfully: an n-gon gets its first three
 * corners placed and the rest left alone, exactly as the archived
 * `mesh.reset_uvs` / `mesh.grid_uvs` did.
 */

/** Stamp every face in scope with the same unit square. */
export function resetUVs(source: IUVSource, layer: number, scope: UVScope = {}): boolean {
  const rings = readUVRings(source, layer, scope)
  return writeRingBoxes(source, layer, rings, () => [0, 0, 1, 1])
}

/**
 * Lay the faces out side by side in a square grid, one cell each, so every
 * face gets a disjoint patch of the map. The grid is sized off the corner
 * count rather than the face count: `count * 0.25` is the quad-equivalent
 * number of faces, and its square root is the side of a grid that holds them.
 */
export function gridUVs(source: IUVSource, layer: number, scope: UVScope = {}): boolean {
  const rings = readUVRings(source, layer, scope)
  const corners = rings.rings.values.length

  if (corners === 0) {
    return false
  }

  const dimen = Math.max(1, Math.ceil(Math.sqrt(corners * 0.25)))
  const cell = 1.0 / dimen
  const pad = cell * 0.025

  return writeRingBoxes(source, layer, rings, (i) => {
    const x = (i % dimen) * cell
    const y = Math.floor(i / dimen) * cell

    // The far edge is inset by twice the pad, which is the archive's arithmetic
    // -- the cells end up slightly off-centre rather than evenly bordered.
    return [x + pad, y + pad, x + cell - pad * 2.0, y + cell - pad * 2.0]
  })
}

/** Place each ring's first three (or four) corners on a caller-chosen box. */
function writeRingBoxes(
  source: IUVSource,
  layer: number,
  rings: UVRings,
  boxOf: (face: number) => [number, number, number, number]
): boolean {
  const handles: number[] = []
  const uvs: number[] = []

  for (let i = 0; i < rings.faces.length; i++) {
    const ring = row(rings.rings, i)
    if (ring.length < 3) {
      continue
    }

    const [x1, y1, x2, y2] = boxOf(i)
    const corners = [x1, y1, x1, y2, x2, y2, x2, y1]
    const n = ring.length === 4 ? 4 : 3

    for (let j = 0; j < n; j++) {
      handles.push(ring[j])
      uvs.push(corners[j * 2], corners[j * 2 + 1])
    }
  }

  if (handles.length === 0) {
    return false
  }
  source.setUVs(layer, Int32Array.from(handles), Float32Array.from(uvs))
  return true
}

// ---------------------------------------------------------------------------

function toCSR(rows: readonly (readonly number[])[]): {offsets: Int32Array; values: Int32Array} {
  const offsets = new Int32Array(rows.length + 1)
  let total = 0

  for (let i = 0; i < rows.length; i++) {
    offsets[i] = total
    total += rows[i].length
  }
  offsets[rows.length] = total

  const values = new Int32Array(total)
  let n = 0
  for (const r of rows) {
    for (const v of r) {
      values[n++] = v
    }
  }
  return {offsets, values}
}
