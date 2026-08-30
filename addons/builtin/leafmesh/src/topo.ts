/**
 * LeafMesh topology: the five domains, the Euler operators, and the
 * derived-state rebuild.
 *
 * The element model is sculptcore's, not BREP's. Five domains — vert, edge,
 * corner, loop, face. A **corner** is one vertex-in-one-loop incidence (what
 * BREP calls a "Loop"); a **loop** is the closed ring a face is bounded by. A
 * face owns a list of loops, so **faces have holes** at the storage level.
 * That support is not a decoration bolted on later; every op below is written
 * knowing a face may have more than one ring.
 *
 * Authoritative state, the part that is serialized: `v.co`, `e.v1/v2`, `c.v`,
 * `c.next`, `l.c`, `l.next`, `f.l`, and the attribute layers. Everything else
 * — disk cycles, radial cycles, `c.e`, `c.prev`, `c.l`, `l.size`, `l.f`,
 * `f.listCount` — is derived, and `rebuildDerivedTopo()` regenerates all of it
 * from the authoritative half.
 *
 * Cycles are kept in **canonical ascending index order**: a vertex's disk runs
 * over its edges sorted by edge index, an edge's radial over its corners
 * sorted by corner index, and the head is the smallest. Keeping cycles in this
 * canonical order makes `rebuildDerivedTopo()` a genuine no-op on a healthy
 * mesh: the live links do not depend on the order the ops ran, only on which
 * elements exist. Insertion
 * is O(valence), which is a rounding error at real valences.
 *
 * Non-manifold is legal. A radial cycle is a list, not a pair; an edge may
 * carry zero, one, two, or many faces, and no op below assumes otherwise.
 *
 * Winding: the outer ring is CCW about the face normal and every hole is CW.
 * The face normal is Newell's over the outer ring, so the outer ring is CCW by
 * construction and is never reordered — construction *may* reorder a hole's
 * corners. `fixWinding()` re-imposes the rule on a face built elsewhere.
 *
 * This class is the geometry core only. The `DataBlock` / `SceneObjectData`
 * that wrap it, the draw path and picking all arrive later and live elsewhere;
 * nothing in this file imports from `scripts/`.
 */

import {ELEM_NONE, ElemArray, type Column} from './elem_array.js'
import {AttrSet, DOMAIN_COUNT, Domain} from './attrs.js'

export {ELEM_NONE}

export type Vec3 = [number, number, number]

class VertDomain {
  readonly array = new ElemArray()
  private readonly _co: Column
  private readonly _no: Column
  private readonly _e: Column

  constructor() {
    this._co = this.array.addColumn('co', Float32Array, 3, 0)
    this._no = this.array.addColumn('no', Float32Array, 3, 0)
    this._e = this.array.addColumn('e', Int32Array, 1, ELEM_NONE)
  }

  /** Position, 3 floats per vertex. */
  get co(): Float32Array {
    return this._co.data as Float32Array
  }

  /** Normal, 3 floats per vertex. Derived. */
  get no(): Float32Array {
    return this._no.data as Float32Array
  }

  /** Head of the disk cycle: the lowest-indexed edge using this vertex. */
  get e(): Int32Array {
    return this._e.data as Int32Array
  }

  get count(): number {
    return this.array.count
  }

  get used(): number {
    return this.array.used
  }

  has(i: number): boolean {
    return this.array.has(i)
  }

  [Symbol.iterator](): Generator<number> {
    return this.array[Symbol.iterator]()
  }
}

class EdgeDomain {
  readonly array = new ElemArray()
  private readonly _v1: Column
  private readonly _v2: Column
  private readonly _c: Column
  private readonly _d1n: Column
  private readonly _d1p: Column
  private readonly _d2n: Column
  private readonly _d2p: Column

  constructor() {
    this._v1 = this.array.addColumn('v1', Int32Array, 1, ELEM_NONE)
    this._v2 = this.array.addColumn('v2', Int32Array, 1, ELEM_NONE)
    this._c = this.array.addColumn('c', Int32Array, 1, ELEM_NONE)
    this._d1n = this.array.addColumn('d1n', Int32Array, 1, ELEM_NONE)
    this._d1p = this.array.addColumn('d1p', Int32Array, 1, ELEM_NONE)
    this._d2n = this.array.addColumn('d2n', Int32Array, 1, ELEM_NONE)
    this._d2p = this.array.addColumn('d2p', Int32Array, 1, ELEM_NONE)
  }

  get v1(): Int32Array {
    return this._v1.data as Int32Array
  }

  get v2(): Int32Array {
    return this._v2.data as Int32Array
  }

  /** Head of the radial cycle: the lowest-indexed corner using this edge. */
  get c(): Int32Array {
    return this._c.data as Int32Array
  }

  get d1n(): Int32Array {
    return this._d1n.data as Int32Array
  }

  get d1p(): Int32Array {
    return this._d1p.data as Int32Array
  }

  get d2n(): Int32Array {
    return this._d2n.data as Int32Array
  }

  get d2p(): Int32Array {
    return this._d2p.data as Int32Array
  }

  get count(): number {
    return this.array.count
  }

  get used(): number {
    return this.array.used
  }

  has(i: number): boolean {
    return this.array.has(i)
  }

  [Symbol.iterator](): Generator<number> {
    return this.array[Symbol.iterator]()
  }
}

class CornerDomain {
  readonly array = new ElemArray()
  private readonly _v: Column
  private readonly _next: Column
  private readonly _prev: Column
  private readonly _e: Column
  private readonly _l: Column
  private readonly _radialNext: Column
  private readonly _radialPrev: Column

  constructor() {
    this._v = this.array.addColumn('v', Int32Array, 1, ELEM_NONE)
    this._next = this.array.addColumn('next', Int32Array, 1, ELEM_NONE)
    this._prev = this.array.addColumn('prev', Int32Array, 1, ELEM_NONE)
    this._e = this.array.addColumn('e', Int32Array, 1, ELEM_NONE)
    this._l = this.array.addColumn('l', Int32Array, 1, ELEM_NONE)
    this._radialNext = this.array.addColumn('radialNext', Int32Array, 1, ELEM_NONE)
    this._radialPrev = this.array.addColumn('radialPrev', Int32Array, 1, ELEM_NONE)
  }

  get v(): Int32Array {
    return this._v.data as Int32Array
  }

  get next(): Int32Array {
    return this._next.data as Int32Array
  }

  get prev(): Int32Array {
    return this._prev.data as Int32Array
  }

  /** Edge from this corner's vertex to the next corner's vertex. */
  get e(): Int32Array {
    return this._e.data as Int32Array
  }

  get l(): Int32Array {
    return this._l.data as Int32Array
  }

  get radialNext(): Int32Array {
    return this._radialNext.data as Int32Array
  }

  get radialPrev(): Int32Array {
    return this._radialPrev.data as Int32Array
  }

  get count(): number {
    return this.array.count
  }

  get used(): number {
    return this.array.used
  }

  has(i: number): boolean {
    return this.array.has(i)
  }

  [Symbol.iterator](): Generator<number> {
    return this.array[Symbol.iterator]()
  }
}

class LoopDomain {
  readonly array = new ElemArray()
  private readonly _c: Column
  private readonly _next: Column
  private readonly _size: Column
  private readonly _f: Column

  constructor() {
    this._c = this.array.addColumn('c', Int32Array, 1, ELEM_NONE)
    this._next = this.array.addColumn('next', Int32Array, 1, ELEM_NONE)
    this._size = this.array.addColumn('size', Int32Array, 1, 0)
    this._f = this.array.addColumn('f', Int32Array, 1, ELEM_NONE)
  }

  /** First corner of the ring. */
  get c(): Int32Array {
    return this._c.data as Int32Array
  }

  /** Next loop of the owning face, `ELEM_NONE` at the end of the list. */
  get next(): Int32Array {
    return this._next.data as Int32Array
  }

  get size(): Int32Array {
    return this._size.data as Int32Array
  }

  get f(): Int32Array {
    return this._f.data as Int32Array
  }

  get count(): number {
    return this.array.count
  }

  get used(): number {
    return this.array.used
  }

  has(i: number): boolean {
    return this.array.has(i)
  }

  [Symbol.iterator](): Generator<number> {
    return this.array[Symbol.iterator]()
  }
}

class FaceDomain {
  readonly array = new ElemArray()
  private readonly _l: Column
  private readonly _listCount: Column

  constructor() {
    this._l = this.array.addColumn('l', Int32Array, 1, ELEM_NONE)
    this._listCount = this.array.addColumn('listCount', Int32Array, 1, 0)
  }

  /** First loop; loop 0 is the outer ring, the rest are holes. */
  get l(): Int32Array {
    return this._l.data as Int32Array
  }

  get listCount(): Int32Array {
    return this._listCount.data as Int32Array
  }

  get count(): number {
    return this.array.count
  }

  get used(): number {
    return this.array.used
  }

  has(i: number): boolean {
    return this.array.has(i)
  }

  [Symbol.iterator](): Generator<number> {
    return this.array[Symbol.iterator]()
  }
}

export interface SplitEdgeResult {
  /** The vertex inserted at the split parameter. */
  vert: number
  /** The new edge, running from the new vertex to the original `v2`. */
  edge: number
}

/** Guards every cycle walk, so a corrupt mesh reports instead of hanging. */
const WALK_LIMIT = 1 << 22

export class LeafMesh {
  readonly v = new VertDomain()
  readonly e = new EdgeDomain()
  readonly c = new CornerDomain()
  readonly l = new LoopDomain()
  readonly f = new FaceDomain()
  readonly attrs: AttrSet

  /**
   * Bumped by every topology mutation. Normals, triangulation and spatial
   * caches key on it; nothing may cache mesh-derived data without storing the
   * stamp it was computed at.
   */
  topoStamp = 0

  /** Filled by `validateAndRepair()`. */
  readonly repairLog: string[] = []

  constructor() {
    this.attrs = new AttrSet([this.v.array, this.e.array, this.c.array, this.l.array, this.f.array])
  }

  /** Every domain's storage, indexed by `Domain`. */
  get arrays(): readonly ElemArray[] {
    return [this.v.array, this.e.array, this.c.array, this.l.array, this.f.array]
  }

  /**
   * A deep copy: same handles, same columns, same attribute layers. Handles are
   * preserved rather than compacted because callers hold them — an undo
   * snapshot that renumbered everything would be useless.
   */
  copy(): LeafMesh {
    const out = new LeafMesh()
    const src = this.arrays
    const dst = out.arrays

    for (let domain = 0; domain < DOMAIN_COUNT; domain++) {
      // Declare first: copyFrom matches columns by name, so a layer that does
      // not exist on the destination yet would be dropped silently.
      for (const layer of this.attrs.layers(domain)) {
        out.attrs.add(domain, layer.name, layer.type, layer.flags, layer.column.fill)
      }
      dst[domain].copyFrom(src[domain])
    }

    out.topoStamp = this.topoStamp
    out.repairLog.length = 0
    out.repairLog.push(...this.repairLog)
    return out
  }

  // ---------------------------------------------------------------- queries

  /** The edge joining `v1` and `v2`, or `ELEM_NONE`. Walks the shorter disk. */
  findEdge(v1: number, v2: number): number {
    const head = this.v.e[v1]
    if (head === ELEM_NONE) {
      return ELEM_NONE
    }

    let e = head
    for (let i = 0; i < WALK_LIMIT; i++) {
      if (this.edgeOther(e, v1) === v2) {
        return e
      }
      e = this.diskNext(e, v1)
      if (e === head) {
        break
      }
    }
    return ELEM_NONE
  }

  edgeOther(e: number, v: number): number {
    return this.e.v1[e] === v ? this.e.v2[e] : this.e.v1[e]
  }

  /** The face owning a corner. */
  cornerFace(c: number): number {
    const l = this.c.l[c]
    return l === ELEM_NONE ? ELEM_NONE : this.l.f[l]
  }

  *vertEdges(v: number): Generator<number> {
    const head = this.v.e[v]
    if (head === ELEM_NONE) {
      return
    }
    let e = head
    for (let i = 0; i < WALK_LIMIT; i++) {
      yield e
      e = this.diskNext(e, v)
      if (e === head || e === ELEM_NONE) {
        return
      }
    }
  }

  *edgeCorners(e: number): Generator<number> {
    const head = this.e.c[e]
    if (head === ELEM_NONE) {
      return
    }
    let c = head
    for (let i = 0; i < WALK_LIMIT; i++) {
      yield c
      c = this.c.radialNext[c]
      if (c === head || c === ELEM_NONE) {
        return
      }
    }
  }

  *faceLoops(f: number): Generator<number> {
    for (let l = this.f.l[f]; l !== ELEM_NONE; l = this.l.next[l]) {
      yield l
    }
  }

  *loopCorners(l: number): Generator<number> {
    const head = this.l.c[l]
    if (head === ELEM_NONE) {
      return
    }
    let c = head
    for (let i = 0; i < WALK_LIMIT; i++) {
      yield c
      c = this.c.next[c]
      if (c === head || c === ELEM_NONE) {
        return
      }
    }
  }

  /** Vertices of one ring, in order. */
  loopVerts(l: number): number[] {
    const out: number[] = []
    for (const c of this.loopCorners(l)) {
      out.push(this.c.v[c])
    }
    return out
  }

  /** Number of faces on an edge: 0 wire, 1 boundary, 2 manifold, more legal. */
  edgeFaceCount(e: number): number {
    const head = this.e.c[e]
    if (head === ELEM_NONE) {
      return 0
    }

    let n = 0
    let c = head
    for (let i = 0; i < WALK_LIMIT; i++) {
      n++
      c = this.c.radialNext[c]
      if (c === head || c === ELEM_NONE) {
        break
      }
    }
    return n
  }

  // ------------------------------------------------------------- Euler ops

  makeVert(co: Readonly<Vec3>, hint = ELEM_NONE): number {
    const v = this.v.array.alloc(hint)
    const dst = this.v.co
    dst[v * 3] = co[0]
    dst[v * 3 + 1] = co[1]
    dst[v * 3 + 2] = co[2]
    this.v.e[v] = ELEM_NONE
    this.topoStamp++
    return v
  }

  /** Kills every edge in the vertex's disk — and so every face touching it. */
  killVert(v: number): void {
    if (!this.v.has(v)) {
      return
    }
    for (let i = 0; i < WALK_LIMIT; i++) {
      const e = this.v.e[v]
      if (e === ELEM_NONE) {
        break
      }
      this.killEdge(e)
    }
    this.v.array.free(v)
    this.topoStamp++
  }

  /**
   * Returns the edge between `v1` and `v2`, creating it if it does not exist.
   * Reuse happens by default because face construction must share perimeter
   * edges: two faces meeting along an edge have to agree on which edge that
   * is, or seam and sharp flags land on a duplicate that nothing reads.
   */
  makeEdge(v1: number, v2: number, hint = ELEM_NONE): number {
    if (v1 === v2 || !this.v.has(v1) || !this.v.has(v2)) {
      return ELEM_NONE
    }

    const existing = this.findEdge(v1, v2)
    if (existing !== ELEM_NONE) {
      return existing
    }

    const e = this.e.array.alloc(hint)
    this.e.v1[e] = v1
    this.e.v2[e] = v2
    this.e.c[e] = ELEM_NONE
    this.diskInsert(v1, e)
    this.diskInsert(v2, e)
    this.topoStamp++
    return e
  }

  /** Kills every face in the edge's radial cycle. Leaves the vertices. */
  killEdge(e: number): void {
    if (!this.e.has(e)) {
      return
    }

    for (let i = 0; i < WALK_LIMIT; i++) {
      const c = this.e.c[e]
      if (c === ELEM_NONE) {
        break
      }
      const f = this.cornerFace(c)
      if (f === ELEM_NONE) {
        // Orphan corner: unlink it rather than spin.
        this.radialRemove(e, c)
        continue
      }
      this.killFace(f)
    }

    this.diskRemove(this.e.v1[e], e)
    this.diskRemove(this.e.v2[e], e)
    this.e.array.free(e)
    this.topoStamp++
  }

  /**
   * Build a face. `loops[0]` is the outer ring and every later entry is a
   * hole; hole rings are reversed as needed to come out clockwise about the
   * face normal, so the corner order of a hole may differ from what was
   * passed in. Returns `ELEM_NONE` if any ring is shorter than three
   * vertices, repeats a vertex, or names a dead one.
   */
  makeFace(loops: readonly (readonly number[])[], hint = ELEM_NONE): number {
    const rings = this.prepareRings(loops)
    if (rings === null) {
      return ELEM_NONE
    }

    const f = this.f.array.alloc(hint)
    this.f.l[f] = ELEM_NONE
    this.f.listCount[f] = 0

    let prevLoop = ELEM_NONE
    for (const ring of rings) {
      const l = this.buildLoop(f, ring)
      if (prevLoop === ELEM_NONE) {
        this.f.l[f] = l
      } else {
        this.l.next[prevLoop] = l
      }
      prevLoop = l
      this.f.listCount[f]++
    }

    this.topoStamp++
    return f
  }

  killFace(f: number): void {
    if (!this.f.has(f)) {
      return
    }

    let l = this.f.l[f]
    while (l !== ELEM_NONE) {
      const nextLoop = this.l.next[l]
      this.freeLoop(l)
      l = nextLoop
    }

    this.f.array.free(f)
    this.topoStamp++
  }

  /**
   * Add a hole to an existing face. The ring is wound clockwise about the
   * face's existing normal, reversing the input if needed.
   */
  addFaceLoop(f: number, verts: readonly number[]): number {
    if (!this.f.has(f) || this.f.l[f] === ELEM_NONE) {
      return ELEM_NONE
    }
    if (!this.ringIsUsable(verts)) {
      return ELEM_NONE
    }

    const normal = this.faceNormal(f)
    const ring = verts.slice()
    if (this.ringSignedArea(ring, normal) > 0) {
      ring.reverse()
    }

    const l = this.buildLoop(f, ring)
    let last = this.f.l[f]
    while (this.l.next[last] !== ELEM_NONE) {
      last = this.l.next[last]
    }
    this.l.next[last] = l
    this.f.listCount[f]++
    this.topoStamp++
    return l
  }

  /** Remove a hole. The outer ring cannot be removed — kill the face instead. */
  removeFaceLoop(f: number, l: number): boolean {
    if (!this.f.has(f) || !this.l.has(l) || this.f.l[f] === l) {
      return false
    }

    let prev = this.f.l[f]
    while (prev !== ELEM_NONE && this.l.next[prev] !== l) {
      prev = this.l.next[prev]
    }
    if (prev === ELEM_NONE) {
      return false
    }

    this.l.next[prev] = this.l.next[l]
    this.freeLoop(l)
    this.f.listCount[f]--
    this.topoStamp++
    return true
  }

  /**
   * Split `e` at parameter `t` along `v1 → v2`, inserting a vertex and a
   * corner in every face on the edge. Vertex and corner attributes are
   * interpolated; `e` keeps the `v1` side.
   */
  splitEdge(e: number, t: number): SplitEdgeResult | null {
    if (!this.e.has(e)) {
      return null
    }

    const v1 = this.e.v1[e]
    const v2 = this.e.v2[e]
    const co = this.v.co
    const nv = this.makeVert([
      co[v1 * 3] + (co[v2 * 3] - co[v1 * 3]) * t,
      co[v1 * 3 + 1] + (co[v2 * 3 + 1] - co[v1 * 3 + 1]) * t,
      co[v1 * 3 + 2] + (co[v2 * 3 + 2] - co[v1 * 3 + 2]) * t,
    ])
    this.attrs.interp(Domain.VERT, nv, [v1, v2], [1 - t, t])

    // Snapshot the radial before touching it; every corner on it moves.
    const corners: number[] = []
    for (const c of this.edgeCorners(e)) {
      corners.push(c)
    }
    for (const c of corners) {
      this.radialRemove(e, c)
    }

    this.diskRemove(v2, e)
    if (this.e.v1[e] === v2) {
      this.e.v1[e] = nv
    } else {
      this.e.v2[e] = nv
    }
    this.diskInsert(nv, e)

    const e2 = this.e.array.alloc(e)
    this.e.v1[e2] = nv
    this.e.v2[e2] = v2
    this.e.c[e2] = ELEM_NONE
    this.diskInsert(nv, e2)
    this.diskInsert(v2, e2)

    for (const c of corners) {
      const cnext = this.c.next[c]
      const nc = this.c.array.alloc(c)

      this.c.v[nc] = nv
      this.c.next[nc] = cnext
      this.c.prev[nc] = c
      this.c.next[c] = nc
      this.c.prev[cnext] = nc
      this.c.l[nc] = this.c.l[c]

      // The corner runs v1 → v2 or v2 → v1; the new corner takes the far half.
      if (this.c.v[c] === v1) {
        this.c.e[c] = e
        this.c.e[nc] = e2
        this.attrs.interpCorner(nc, [c, cnext], [1 - t, t])
      } else {
        this.c.e[c] = e2
        this.c.e[nc] = e
        this.attrs.interpCorner(nc, [c, cnext], [t, 1 - t])
      }

      this.radialInsert(this.c.e[c], c)
      this.radialInsert(this.c.e[nc], nc)
      this.l.size[this.c.l[nc]]++
    }

    this.topoStamp++
    return {vert: nv, edge: e2}
  }

  /**
   * Merge the two faces sharing `e` into one, dropping the shared edge. Both
   * faces' holes carry over, and the shared edge may lie on one face's hole
   * ring — that merges the hole with the other face's outer ring, which is how
   * a face beside a hole is dissolved into it. Returns `ELEM_NONE` unless `e`
   * has exactly two corners, on two different faces, at most one of them on a
   * hole ring, traversing the edge in opposite directions.
   */
  joinFaces(f1: number, f2: number, e: number): number {
    if (f1 === f2 || !this.f.has(f1) || !this.f.has(f2) || !this.e.has(e)) {
      return ELEM_NONE
    }

    const corners: number[] = []
    for (const c of this.edgeCorners(e)) {
      corners.push(c)
    }
    if (corners.length !== 2) {
      return ELEM_NONE
    }

    let c1 = ELEM_NONE
    let c2 = ELEM_NONE
    for (const c of corners) {
      const l = this.c.l[c]
      if (this.l.f[l] === f1) {
        c1 = c
      } else if (this.l.f[l] === f2) {
        c2 = c
      }
    }
    if (c1 === ELEM_NONE || c2 === ELEM_NONE) {
      return ELEM_NONE
    }
    // Same direction means the faces disagree about which way is out.
    if (this.c.v[c1] === this.c.v[c2]) {
      return ELEM_NONE
    }

    // A hole ring merges with the other face's outer ring, and that face's
    // outer ring then leads. Two hole rings would leave the result with none.
    const hole1 = this.c.l[c1] !== this.f.l[f1]
    const hole2 = this.c.l[c2] !== this.f.l[f2]
    if (hole1 && hole2) {
      return ELEM_NONE
    }
    const lead = hole1 ? f1 : hole2 ? f2 : ELEM_NONE

    const merged: number[] = []
    const sources: number[] = []
    const walk = (from: number, until: number): void => {
      let c = from
      for (let i = 0; i < WALK_LIMIT && c !== until; i++) {
        merged.push(this.c.v[c])
        sources.push(c)
        c = this.c.next[c]
      }
    }
    // b … a from f1, then f2's ring minus the duplicated a and b.
    walk(this.c.next[c1], c1)
    merged.push(this.c.v[c1])
    sources.push(c1)
    walk(this.c.next[this.c.next[c2]], c2)

    // Two faces sharing more than one edge would merge into a ring that
    // repeats a vertex. Bail before killing anything.
    if (!this.ringIsUsable(merged)) {
      return ELEM_NONE
    }

    const rings: number[][] = []
    const ringSources: number[][] = []
    const taken = new Set<number>([this.c.l[c1], this.c.l[c2]])
    const takeLoop = (l: number): void => {
      const cs: number[] = []
      for (const c of this.loopCorners(l)) {
        cs.push(c)
      }
      rings.push(cs.map((c) => this.c.v[c]))
      ringSources.push(cs)
      taken.add(l)
    }

    if (lead !== ELEM_NONE) {
      takeLoop(this.f.l[lead])
    }
    rings.push(merged)
    ringSources.push(sources)
    for (const f of [f1, f2]) {
      for (const l of this.faceLoops(f)) {
        if (!taken.has(l)) {
          takeLoop(l)
        }
      }
    }

    const faceAttrs = this.attrs.snapshotRow(Domain.FACE, f1)
    // Keyed by vertex rather than by corner: the kills below free these corner
    // indices and `makeFace` hands the same ones straight back out, so a corner
    // index means something different on the far side. A hole ring may also
    // come back reversed, and the vertex is what survives both.
    const ringAttrs = ringSources.map((cs) => {
      const byVert = new Map<number, Float64Array>()
      for (const c of cs) {
        byVert.set(this.c.v[c], this.attrs.snapshotRow(Domain.CORNER, c))
      }
      return byVert
    })

    this.killFace(f1)
    this.killFace(f2)

    const nf = this.makeFace(rings, f1)
    if (nf === ELEM_NONE) {
      return ELEM_NONE
    }

    this.attrs.restoreRow(Domain.FACE, nf, faceAttrs)
    let ri = 0
    for (const l of this.faceLoops(nf)) {
      const byVert = ringAttrs[ri++]
      for (const c of this.loopCorners(l)) {
        const snap = byVert.get(this.c.v[c])
        if (snap !== undefined) {
          this.attrs.restoreRow(Domain.CORNER, c, snap)
        }
      }
    }

    if (this.e.has(e) && this.e.c[e] === ELEM_NONE) {
      this.killEdge(e)
    }

    this.topoStamp++
    return nf
  }

  // -------------------------------------------------------------- geometry

  /** Newell's normal over the outer ring. Falls back to +Z when degenerate. */
  faceNormal(f: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const l = this.f.l[f]
    if (l === ELEM_NONE) {
      out[0] = 0
      out[1] = 0
      out[2] = 1
      return out
    }
    return this.ringNormal(this.loopVerts(l), out)
  }

  /** Newell's normal over an explicit vertex ring. */
  ringNormal(ring: readonly number[], out: Vec3 = [0, 0, 0]): Vec3 {
    const co = this.v.co
    let nx = 0
    let ny = 0
    let nz = 0

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] * 3
      const b = ring[(i + 1) % ring.length] * 3
      nx += (co[a + 1] - co[b + 1]) * (co[a + 2] + co[b + 2])
      ny += (co[a + 2] - co[b + 2]) * (co[a] + co[b])
      nz += (co[a] - co[b]) * (co[a + 1] + co[b + 1])
    }

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len < 1e-20) {
      out[0] = 0
      out[1] = 0
      out[2] = 1
      return out
    }

    out[0] = nx / len
    out[1] = ny / len
    out[2] = nz / len
    return out
  }

  /**
   * Re-impose the winding rule on a face built by an importer. The outer ring
   * defines the normal and is never touched; holes that came in counter-
   * clockwise are reversed in place, keeping their corners and attributes.
   */
  fixWinding(f: number): number {
    if (!this.f.has(f)) {
      return 0
    }

    const normal = this.faceNormal(f)
    let fixed = 0
    let l = this.l.next[this.f.l[f]]
    while (l !== ELEM_NONE) {
      if (this.ringSignedArea(this.loopVerts(l), normal) > 0) {
        this.reverseLoop(l)
        fixed++
      }
      l = this.l.next[l]
    }

    if (fixed > 0) {
      this.topoStamp++
    }
    return fixed
  }

  /** Signed area of a vertex ring in the plane basis of `normal`. */
  ringSignedArea(ring: readonly number[], normal: Readonly<Vec3>): number {
    const [u, v] = planeBasis(normal)
    const co = this.v.co
    let area = 0

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] * 3
      const b = ring[(i + 1) % ring.length] * 3
      const ax = co[a] * u[0] + co[a + 1] * u[1] + co[a + 2] * u[2]
      const ay = co[a] * v[0] + co[a + 1] * v[1] + co[a + 2] * v[2]
      const bx = co[b] * u[0] + co[b + 1] * u[1] + co[b + 2] * u[2]
      const by = co[b] * v[0] + co[b + 1] * v[1] + co[b + 2] * v[2]
      area += ax * by - bx * ay
    }
    return area * 0.5
  }

  // ------------------------------------------------------- derived rebuild

  /**
   * Regenerate every derived link from the authoritative half. Safe to call at
   * any time on a healthy mesh, where it changes nothing — the cycles are
   * canonically ordered, so they are a function of the element set alone.
   *
   * A face ring naming a pair of vertices with no edge between them is the one
   * case where this touches authoritative state: the edge is created, since
   * the alternative is discarding the face. It is counted in the return value.
   */
  rebuildDerivedTopo(skipFaces?: ReadonlySet<number>): number {
    for (const v of this.v) {
      this.v.e[v] = ELEM_NONE
    }
    for (const e of this.e) {
      this.e.c[e] = ELEM_NONE
      this.e.d1n[e] = ELEM_NONE
      this.e.d1p[e] = ELEM_NONE
      this.e.d2n[e] = ELEM_NONE
      this.e.d2p[e] = ELEM_NONE
    }
    for (const c of this.c) {
      this.c.e[c] = ELEM_NONE
      this.c.l[c] = ELEM_NONE
      this.c.prev[c] = ELEM_NONE
      this.c.radialNext[c] = ELEM_NONE
      this.c.radialPrev[c] = ELEM_NONE
    }

    for (const e of this.e) {
      const v1 = this.e.v1[e]
      const v2 = this.e.v2[e]
      if (!this.v.has(v1) || !this.v.has(v2) || v1 === v2) {
        continue
      }
      this.diskInsert(v1, e)
      this.diskInsert(v2, e)
    }

    let created = 0
    for (const f of this.f) {
      if (skipFaces?.has(f)) {
        continue
      }

      let loops = 0
      for (let l = this.f.l[f]; l !== ELEM_NONE; l = this.l.next[l]) {
        loops++
        this.l.f[l] = f

        let size = 0
        for (const c of this.loopCorners(l)) {
          const next = this.c.next[c]
          this.c.l[c] = l
          this.c.prev[next] = c
          size++

          let e = this.findEdge(this.c.v[c], this.c.v[next])
          if (e === ELEM_NONE) {
            e = this.makeEdge(this.c.v[c], this.c.v[next])
            created++
          }
          this.c.e[c] = e
          this.radialInsert(e, c)
        }
        this.l.size[l] = size
      }
      this.f.listCount[f] = loops
    }

    this.topoStamp++
    return created
  }

  /**
   * Check every structural invariant, repair what is repairable, and report
   * the rest into `repairLog`. Faces whose rings are broken are reported and
   * skipped, never deleted: losing a face silently is worse than carrying a
   * bad one that a human can see.
   *
   * Returns the number of problems found.
   */
  validateAndRepair(): number {
    this.repairLog.length = 0

    for (const e of this.e) {
      const v1 = this.e.v1[e]
      const v2 = this.e.v2[e]
      if (!this.v.has(v1) || !this.v.has(v2)) {
        this.repairLog.push(`edge ${e} references a dead vertex`)
      } else if (v1 === v2) {
        this.repairLog.push(`edge ${e} is a self-loop`)
      }
    }

    const broken = new Set<number>()
    for (const f of this.f) {
      const problem = this.checkFace(f)
      if (problem !== null) {
        this.repairLog.push(problem)
        broken.add(f)
      }
    }

    const created = this.rebuildDerivedTopo(broken)
    if (created > 0) {
      this.repairLog.push(`created ${created} missing edge(s) implied by face rings`)
    }

    return this.repairLog.length
  }

  // ---------------------------------------------------------------- private

  private checkFace(f: number): string | null {
    const first = this.f.l[f]
    if (first === ELEM_NONE) {
      return `face ${f} has no loops`
    }

    let loops = 0
    for (let l = first; l !== ELEM_NONE; l = this.l.next[l]) {
      if (++loops > WALK_LIMIT) {
        return `face ${f} has a cyclic loop list`
      }
      if (!this.l.has(l)) {
        return `face ${f} references dead loop ${l}`
      }

      const head = this.l.c[l]
      if (head === ELEM_NONE || !this.c.has(head)) {
        return `loop ${l} of face ${f} has no valid first corner`
      }

      let c = head
      let size = 0
      const seen = new Set<number>()
      for (;;) {
        if (!this.c.has(c)) {
          return `loop ${l} of face ${f} walks into dead corner ${c}`
        }
        if (!this.v.has(this.c.v[c])) {
          return `corner ${c} of face ${f} references a dead vertex`
        }
        if (seen.has(this.c.v[c])) {
          return `loop ${l} of face ${f} repeats vertex ${this.c.v[c]}`
        }
        seen.add(this.c.v[c])
        size++

        c = this.c.next[c]
        if (c === head) {
          break
        }
        if (c === ELEM_NONE || size > WALK_LIMIT) {
          return `loop ${l} of face ${f} does not close`
        }
      }

      if (size < 3) {
        return `loop ${l} of face ${f} has only ${size} corner(s)`
      }
    }

    return null
  }

  /** Validate the input rings and orient the holes. Returns null on bad input. */
  private prepareRings(loops: readonly (readonly number[])[]): number[][] | null {
    if (loops.length === 0) {
      return null
    }
    for (const ring of loops) {
      if (!this.ringIsUsable(ring)) {
        return null
      }
    }

    const rings = loops.map((ring) => ring.slice())
    // Newell over ring 0 defines the normal, so ring 0 is CCW by definition.
    const normal = this.ringNormal(rings[0])
    for (let i = 1; i < rings.length; i++) {
      if (this.ringSignedArea(rings[i], normal) > 0) {
        rings[i].reverse()
      }
    }
    return rings
  }

  private ringIsUsable(ring: readonly number[]): boolean {
    if (ring.length < 3) {
      return false
    }
    const seen = new Set<number>()
    for (const v of ring) {
      if (!this.v.has(v) || seen.has(v)) {
        return false
      }
      seen.add(v)
    }
    return true
  }

  /** Allocate a loop and its corners for one ring, wiring edges and radials. */
  private buildLoop(f: number, ring: readonly number[]): number {
    const n = ring.length
    const l = this.l.array.alloc(f)
    const corners: number[] = []

    let hint = ELEM_NONE
    for (let i = 0; i < n; i++) {
      const c = this.c.array.alloc(hint)
      this.c.v[c] = ring[i]
      this.c.l[c] = l
      corners.push(c)
      hint = c
    }

    for (let i = 0; i < n; i++) {
      const c = corners[i]
      const next = corners[(i + 1) % n]
      this.c.next[c] = next
      this.c.prev[next] = c
    }

    for (let i = 0; i < n; i++) {
      const c = corners[i]
      const e = this.makeEdge(ring[i], ring[(i + 1) % n])
      this.c.e[c] = e
      this.radialInsert(e, c)
    }

    this.l.c[l] = corners[0]
    this.l.next[l] = ELEM_NONE
    this.l.size[l] = n
    this.l.f[l] = f
    return l
  }

  /** Free a loop and its corners. Perimeter edges survive as wire edges. */
  private freeLoop(l: number): void {
    const corners: number[] = []
    for (const c of this.loopCorners(l)) {
      corners.push(c)
    }
    for (const c of corners) {
      const e = this.c.e[c]
      if (e !== ELEM_NONE) {
        this.radialRemove(e, c)
      }
      this.c.array.free(c)
    }
    this.l.array.free(l)
  }

  /** Reverse a ring in place, keeping every corner with its own vertex. */
  private reverseLoop(l: number): void {
    const corners: number[] = []
    for (const c of this.loopCorners(l)) {
      corners.push(c)
    }

    const n = corners.length
    for (const c of corners) {
      this.radialRemove(this.c.e[c], c)
    }
    for (let i = 0; i < n; i++) {
      const c = corners[i]
      const next = corners[(i - 1 + n) % n]
      this.c.next[c] = next
      this.c.prev[next] = c
    }
    for (const c of corners) {
      const e = this.findEdge(this.c.v[c], this.c.v[this.c.next[c]])
      this.c.e[c] = e
      this.radialInsert(e, c)
    }
  }

  // Disk cycle. `d1*` belongs to `v1`, `d2*` to `v2`, hence the indirection.

  private diskNext(e: number, v: number): number {
    return this.e.v1[e] === v ? this.e.d1n[e] : this.e.d2n[e]
  }

  private diskPrev(e: number, v: number): number {
    return this.e.v1[e] === v ? this.e.d1p[e] : this.e.d2p[e]
  }

  private diskSetNext(e: number, v: number, x: number): void {
    if (this.e.v1[e] === v) {
      this.e.d1n[e] = x
    } else {
      this.e.d2n[e] = x
    }
  }

  private diskSetPrev(e: number, v: number, x: number): void {
    if (this.e.v1[e] === v) {
      this.e.d1p[e] = x
    } else {
      this.e.d2p[e] = x
    }
  }

  private diskInsert(v: number, e: number): void {
    const head = this.v.e[v]
    if (head === ELEM_NONE) {
      this.v.e[v] = e
      this.diskSetNext(e, v, e)
      this.diskSetPrev(e, v, e)
      return
    }

    if (e < head) {
      this.diskLink(v, this.diskPrev(head, v), e, head)
      this.v.e[v] = e
      return
    }

    let c = head
    for (let i = 0; i < WALK_LIMIT; i++) {
      const n = this.diskNext(c, v)
      if (n === head || n > e) {
        this.diskLink(v, c, e, n)
        return
      }
      c = n
    }
  }

  private diskLink(v: number, before: number, e: number, after: number): void {
    this.diskSetNext(before, v, e)
    this.diskSetPrev(after, v, e)
    this.diskSetNext(e, v, after)
    this.diskSetPrev(e, v, before)
  }

  private diskRemove(v: number, e: number): void {
    const next = this.diskNext(e, v)
    const prev = this.diskPrev(e, v)

    if (next === e || next === ELEM_NONE) {
      this.v.e[v] = ELEM_NONE
    } else {
      this.diskSetNext(prev, v, next)
      this.diskSetPrev(next, v, prev)
      if (this.v.e[v] === e) {
        this.v.e[v] = next
      }
    }

    this.diskSetNext(e, v, ELEM_NONE)
    this.diskSetPrev(e, v, ELEM_NONE)
  }

  // Radial cycle, same canonical ordering over corner indices.

  private radialInsert(e: number, c: number): void {
    if (e === ELEM_NONE) {
      return
    }

    const head = this.e.c[e]
    if (head === ELEM_NONE) {
      this.e.c[e] = c
      this.c.radialNext[c] = c
      this.c.radialPrev[c] = c
      return
    }

    if (c < head) {
      this.radialLink(this.c.radialPrev[head], c, head)
      this.e.c[e] = c
      return
    }

    let cur = head
    for (let i = 0; i < WALK_LIMIT; i++) {
      const n = this.c.radialNext[cur]
      if (n === head || n > c) {
        this.radialLink(cur, c, n)
        return
      }
      cur = n
    }
  }

  private radialLink(before: number, c: number, after: number): void {
    this.c.radialNext[before] = c
    this.c.radialPrev[after] = c
    this.c.radialNext[c] = after
    this.c.radialPrev[c] = before
  }

  private radialRemove(e: number, c: number): void {
    if (e === ELEM_NONE) {
      return
    }

    const next = this.c.radialNext[c]
    const prev = this.c.radialPrev[c]

    if (next === c || next === ELEM_NONE) {
      this.e.c[e] = ELEM_NONE
    } else {
      this.c.radialNext[prev] = next
      this.c.radialPrev[next] = prev
      if (this.e.c[e] === c) {
        this.e.c[e] = next
      }
    }

    this.c.radialNext[c] = ELEM_NONE
    this.c.radialPrev[c] = ELEM_NONE
  }
}

/**
 * A right-handed `(u, v)` pair spanning the plane of `n`, with `u × v = n`, so
 * a ring wound counter-clockwise about `n` has positive signed area in it.
 */
export function planeBasis(n: Readonly<Vec3>): [Vec3, Vec3] {
  const ax = Math.abs(n[0])
  const ay = Math.abs(n[1])
  const az = Math.abs(n[2])
  const ref: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]

  let ux = ref[1] * n[2] - ref[2] * n[1]
  let uy = ref[2] * n[0] - ref[0] * n[2]
  let uz = ref[0] * n[1] - ref[1] * n[0]

  const len = Math.sqrt(ux * ux + uy * uy + uz * uz)
  if (len < 1e-20) {
    return [
      [1, 0, 0],
      [0, 1, 0],
    ]
  }
  ux /= len
  uy /= len
  uz /= len

  return [
    [ux, uy, uz],
    [n[1] * uz - n[2] * uy, n[2] * ux - n[0] * uz, n[0] * uy - n[1] * ux],
  ]
}
