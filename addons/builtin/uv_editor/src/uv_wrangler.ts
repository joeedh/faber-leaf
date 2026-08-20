/**
 * The welded UV graph the unwrapping solvers run on — P19 §4.
 *
 * This is the port of the archived `UVWrangler`, which built a second BREP
 * `Mesh` in UV space and kept `Map<Loop, Vertex>` both ways. That mesh class no
 * longer exists, so what is rebuilt here is the *structure* it provided rather
 * than the code that provided it: welded vertices, the edges between them,
 * triangles, and connected components.
 *
 * The welding rule is the contract's, not a spatial hash. `getUVFans` already
 * answers "which UV elements are coincident on one owner", which is exactly
 * what the archived seam walk computed the long way round — a seam is where
 * that relation is absent. So no seam attribute is read here, and a source with
 * no topology behind it still builds a graph.
 *
 * Vertices are objects with a `co` rather than an index into a `Float32Array`
 * because the solver ported alongside is 1,400 lines of `v.co.sub(...)`, and
 * flattening it would have turned a port into a rewrite (the plan's §7 risk).
 * Scratch state the *solver* needs stays in the solver, keyed by `UVVert.index`
 * — the archived code kept it in a `CustomDataElem` layer, which is the class
 * that died with the BREP mesh.
 */

import type {IUVSource} from '@framework/api'
import {Vector2, Vector3} from '@framework/pathux'
import {readUVRings, ringElements, UV_PIN, UV_SELECT} from './uv_edit_geom.js'
import type {UVScope} from './uv_edit_geom.js'

/** Floor on an island's box, so callers that divide by it stay finite. */
const MIN_BOX = 0.00001

/** One welded UV vertex: every UV element coincident on one owner. */
export class UVVert {
  index: number

  /** UV position. `z` is held at 0 so 3D vector math can be used on it. */
  co = new Vector3()

  /** The owners' averaged 3D position — what the solver measures against. */
  world = new Vector3()

  /** UV element handles welded here; `write()` pushes `co` back to all of them. */
  elems: number[] = []

  edges: UVEdge[] = []

  /** `UV_SELECT` / `UV_PIN`, or-ed over the welded elements. */
  flag = 0

  /** On an island boundary — the archived `CVElem.corner`. */
  corner = false

  /** Boundary tangent, meaningful only when `corner` is set. */
  bTangent = new Vector3()

  island: UVIsland | undefined = undefined

  constructor(index: number) {
    this.index = index
  }

  get hasPins(): boolean {
    return (this.flag & UV_PIN) !== 0
  }
}

export class UVEdge {
  index: number
  v1: UVVert
  v2: UVVert

  /** Face rings using this edge. One means an island boundary. */
  faceCount = 0

  constructor(index: number, v1: UVVert, v2: UVVert) {
    this.index = index
    this.v1 = v1
    this.v2 = v2
  }

  otherVertex(v: UVVert): UVVert {
    return v === this.v1 ? this.v2 : this.v1
  }

  get boundary(): boolean {
    return this.faceCount < 2
  }
}

/** One face ring, welded. `verts` is in winding order and may repeat nothing. */
export class UVFace {
  index: number
  verts: UVVert[]

  /** Geometric normal from the owners' 3D positions, Newell. */
  no = new Vector3()

  constructor(index: number, verts: UVVert[]) {
    this.index = index
    this.verts = verts
  }
}

/** A connected component of the welded graph — the archived `UVIsland`. */
export class UVIsland {
  verts: UVVert[] = []
  faces: UVFace[] = []
  hasPins = false
  hasSel = false

  min = new Vector2()
  max = new Vector2()
  boxcenter = new Vector2()
  boxsize = new Vector2()
  area = 0
}

export class UVGraph {
  source: IUVSource
  layer: number

  /** `IUVSource.topoStamp` when the graph was built; handles die with it. */
  topoStamp: number

  verts: UVVert[] = []
  edges: UVEdge[] = []
  faces: UVFace[] = []
  islands: UVIsland[] = []

  /** Triangles as vertex indices, three per triangle, fan-cut from the rings. */
  tris: Int32Array = new Int32Array(0)

  /** Which face each triangle came from, indexing `faces`. */
  triFaces: Int32Array = new Int32Array(0)

  private _edgeMap = new Map<number, UVEdge>()

  constructor(source: IUVSource, layer: number) {
    this.source = source
    this.layer = layer
    this.topoStamp = source.topoStamp
  }

  getEdge(a: UVVert, b: UVVert): UVEdge | undefined {
    return this._edgeMap.get(edgeKey(a.index, b.index))
  }

  ensureEdge(a: UVVert, b: UVVert): UVEdge {
    const key = edgeKey(a.index, b.index)
    let e = this._edgeMap.get(key)

    if (!e) {
      e = new UVEdge(this.edges.length, a, b)
      this.edges.push(e)
      this._edgeMap.set(key, e)
      a.edges.push(e)
      b.edges.push(e)
    }
    return e
  }

  /** Push every welded vertex's `co` back to the UV elements it stands for. */
  write(): void {
    const handles: number[] = []
    const uvs: number[] = []

    for (const v of this.verts) {
      for (const h of v.elems) {
        handles.push(h)
        uvs.push(v.co[0], v.co[1])
      }
    }
    this.source.setUVs(this.layer, Int32Array.from(handles), Float32Array.from(uvs))
  }

  /** Recompute one island's bounds from its vertices' current positions. */
  updateAABB(island: UVIsland): void {
    island.min[0] = island.min[1] = 1e17
    island.max[0] = island.max[1] = -1e17

    for (const v of island.verts) {
      island.min[0] = Math.min(island.min[0], v.co[0])
      island.min[1] = Math.min(island.min[1], v.co[1])
      island.max[0] = Math.max(island.max[0], v.co[0])
      island.max[1] = Math.max(island.max[1], v.co[1])
    }

    if (!island.verts.length) {
      island.min.zero()
      island.max.zero()
    }

    island.boxcenter.load(island.min).interp(island.max, 0.5)
    island.boxsize.load(island.max).sub(island.min)

    // Floored, because every consumer divides by it: a single-vertex island or
    // one collapsed onto an axis would otherwise scale to infinity.
    island.boxsize[0] = Math.max(island.boxsize[0], MIN_BOX)
    island.boxsize[1] = Math.max(island.boxsize[1], MIN_BOX)
    island.area = island.boxsize[0] * island.boxsize[1]
  }
}

/** Order-independent key for an unordered vertex pair. */
function edgeKey(a: number, b: number): number {
  const lo = a < b ? a : b
  const hi = a < b ? b : a

  // Vertex counts here are UV elements of one mesh, so 2^26 apiece is ample and
  // the product stays inside a double's exact integer range.
  return lo * 67108864 + hi
}

/**
 * Build the welded graph for `layer`.
 *
 * Everything comes from bulk reads: rings decide adjacency, `getUVFans` decides
 * welding, and `getUVElementPositions` — optional on the contract — decides
 * whether 3D-aware solving is possible at all. Callers that need it check
 * {@link UVGraph.verts}'s `world` against a source that provides positions;
 * without them the graph is still well-formed, just flat.
 */
export function buildUVGraph(source: IUVSource, layer: number, scope: UVScope = {}): UVGraph {
  const graph = new UVGraph(source, layer)
  const rings = readUVRings(source, layer, scope)
  const handles = ringElements(rings)

  if (!handles.length) {
    return graph
  }

  const uvs = source.getUVs(layer, handles, new Float32Array(handles.length * 2))
  const flags = source.getUVFlags(layer, handles, new Uint8Array(handles.length))
  const world = source.getUVElementPositions?.(layer, handles, new Float32Array(handles.length * 3))

  const at = new Map<number, number>()
  for (let i = 0; i < handles.length; i++) {
    at.set(handles[i], i)
  }

  // Weld: fans only. Ring membership is adjacency, not identity -- unioning it
  // here would collapse every face to a point.
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

  const fans = source.getUVFans(layer, handles)
  for (let i = 0; i < handles.length; i++) {
    for (let k = fans.offsets[i]; k < fans.offsets[i + 1]; k++) {
      const j = at.get(fans.values[k])
      if (j === undefined) {
        continue
      }
      const ra = find(i)
      const rb = find(j)
      if (ra !== rb) {
        parent[rb] = ra
      }
    }
  }

  const vertOf = new Int32Array(handles.length).fill(-1)
  const counts: number[] = []

  for (let i = 0; i < handles.length; i++) {
    const r = find(i)
    let vi = vertOf[r]

    if (vi < 0) {
      vi = graph.verts.length
      vertOf[r] = vi
      graph.verts.push(new UVVert(vi))
      counts.push(0)
    }

    const v = graph.verts[vi]
    vertOf[i] = vi
    v.elems.push(handles[i])
    v.flag |= flags[i]

    // The welded position is the average of its elements. They are coincident
    // to within the source's own epsilon, so this only smooths that epsilon.
    v.co[0] += uvs[i * 2]
    v.co[1] += uvs[i * 2 + 1]

    if (world) {
      v.world[0] += world[i * 3]
      v.world[1] += world[i * 3 + 1]
      v.world[2] += world[i * 3 + 2]
    }
    counts[vi]++
  }

  for (const v of graph.verts) {
    const mul = 1.0 / counts[v.index]
    v.co.mulScalar(mul)
    v.co[2] = 0.0
    v.world.mulScalar(mul)
  }

  buildFaces(graph, rings, at, vertOf)
  buildIslands(graph)
  buildCornerTags(graph)
  buildBoundaryTangents(graph)

  return graph
}

function buildFaces(
  graph: UVGraph,
  rings: {faces: Int32Array; rings: {offsets: Int32Array; values: Int32Array}},
  at: Map<number, number>,
  vertOf: Int32Array
): void {
  const tris: number[] = []
  const triFaces: number[] = []

  for (let f = 0; f < rings.faces.length; f++) {
    const start = rings.rings.offsets[f]
    const end = rings.rings.offsets[f + 1]
    const verts: UVVert[] = []

    for (let k = start; k < end; k++) {
      const i = at.get(rings.rings.values[k])
      if (i === undefined) {
        continue
      }
      const v = graph.verts[vertOf[i]]
      // A ring that welds two of its own corners together is degenerate in UV
      // space; keeping the repeat would make a zero-area triangle.
      if (!verts.includes(v)) {
        verts.push(v)
      }
    }

    if (verts.length < 3) {
      continue
    }

    const face = new UVFace(graph.faces.length, verts)
    graph.faces.push(face)

    for (let i = 0; i < verts.length; i++) {
      graph.ensureEdge(verts[i], verts[(i + 1) % verts.length]).faceCount++
    }

    newellNormal(verts, face.no)

    for (let i = 1; i + 1 < verts.length; i++) {
      tris.push(verts[0].index, verts[i].index, verts[i + 1].index)
      triFaces.push(face.index)
    }
  }

  graph.tris = Int32Array.from(tris)
  graph.triFaces = Int32Array.from(triFaces)
}

function newellNormal(verts: UVVert[], out: Vector3): void {
  out.zero()

  for (let i = 0; i < verts.length; i++) {
    const a = verts[i].world
    const b = verts[(i + 1) % verts.length].world

    out[0] += (a[1] - b[1]) * (a[2] + b[2])
    out[1] += (a[2] - b[2]) * (a[0] + b[0])
    out[2] += (a[0] - b[0]) * (a[1] + b[1])
  }

  if (out.dot(out) > 0.0) {
    out.normalize()
  }
}

function buildIslands(graph: UVGraph): void {
  graph.islands = []
  const seen = new Set<UVVert>()

  for (const start of graph.verts) {
    if (seen.has(start)) {
      continue
    }

    const island = new UVIsland()
    const stack = [start]
    seen.add(start)

    while (stack.length) {
      const v = stack.pop()!

      v.island = island
      island.verts.push(v)
      island.hasPins = island.hasPins || (v.flag & UV_PIN) !== 0
      island.hasSel = island.hasSel || (v.flag & UV_SELECT) !== 0

      for (const e of v.edges) {
        const other = e.otherVertex(v)
        if (!seen.has(other)) {
          seen.add(other)
          stack.push(other)
        }
      }
    }

    graph.islands.push(island)
    graph.updateAABB(island)
  }

  // A face's vertices are edge-connected by construction, so its first one
  // names the island the whole ring belongs to.
  for (const f of graph.faces) {
    f.verts[0].island?.faces.push(f)
  }
}

/**
 * Mark the vertices on an island boundary. The archived code asked the base
 * mesh whether the two faces across a loop's edge landed in different islands;
 * on the welded graph that is the same question as "how many rings used this
 * edge", which needs nothing outside the graph.
 */
function buildCornerTags(graph: UVGraph): void {
  for (const e of graph.edges) {
    if (e.boundary) {
      e.v1.corner = true
      e.v2.corner = true
    }
  }
}

const _bt1 = new Vector3()
const _bt2 = new Vector3()
const _bt3 = new Vector3()

/**
 * The inward normal of the boundary at each corner vertex, scaled so that a
 * uniform offset along it keeps a shell's width constant through the angle
 * (the archived `buildBoundaryTangents`, minus its base-mesh fallback: on the
 * welded graph an interior neighbour always exists unless the island is a
 * single edge, which the `vcent` guard below covers).
 */
function buildBoundaryTangents(graph: UVGraph): void {
  for (const v of graph.verts) {
    if (!v.corner) {
      continue
    }

    let v1: UVVert | undefined
    let v2: UVVert | undefined
    let vcent: UVVert | undefined

    for (const e of v.edges) {
      const other = e.otherVertex(v)

      if (!e.boundary) {
        vcent = other
        continue
      }
      if (!v1) {
        v1 = other
      } else if (!v2) {
        v2 = other
      }
    }

    if (!v1 || !v2) {
      continue
    }

    _bt1.load(v1.co).sub(v.co).normalize()
    _bt2.load(v2.co).sub(v.co).normalize().negate()
    _bt3.load(_bt1).add(_bt2).normalize()

    const th = Math.acos(Math.min(Math.max(_bt1.dot(_bt3), -1.0), 1.0))
    const shellth = th < 0.0001 ? 1.0 : 1.0 / Math.abs(Math.cos(th))

    _bt1.interp(_bt2, 0.5).normalize().mulScalar(shellth)

    if (isNaN(_bt1.dot(_bt1))) {
      continue
    }

    const tmp = _bt1[0]
    _bt1[0] = -_bt1[1]
    _bt1[1] = tmp

    if (vcent) {
      _bt2.load(v.co).sub(vcent.co)
      if (_bt1.dot(_bt2) < 0.0) {
        _bt1.negate()
      }
    }

    v.bTangent[0] = _bt1[0]
    v.bTangent[1] = _bt1[1]
    v.bTangent[2] = 0.0
  }
}
