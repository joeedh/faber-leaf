/**
 * An `IUVSource` with no geometry behind it — P18 §5 step 2, implementor #3.
 *
 * A W×H grid of quads whose UV elements are corners and whose owners are grid
 * *vertices*, so `getUVOwners` is many-to-one here and the identity on LeafMesh.
 * That difference is the point: the double exists to catch an interface that
 * has quietly assumed one mesh's storage. It also carries no `IElementSource`,
 * no draw path and no engine, which is what lets the UV editor be driven
 * headlessly (§6 criterion 3).
 *
 * Not a mesh: there is no topology to edit, and `bumpTopoStamp` is the only way
 * handles ever go stale. Anything a test needs beyond a fixed grid belongs in a
 * real source, not here.
 */

import {ElementDomain, UVFlags} from '../../scripts/core/geometry_contract'
import type {ElementHandles, IUVSource} from '../../scripts/core/geometry_contract'

export interface UVGridOptions {
  /** Quads across and down; the grid has `(w + 1) * (h + 1)` vertices. */
  w?: number
  h?: number
  layers?: string[]
}

interface Layer {
  name: string
  uv: Float32Array
  flags: Uint8Array
}

function sized<T extends Int32Array | Float32Array | Uint8Array>(out: T | undefined, n: number, make: () => T): T {
  return out !== undefined && out.length >= n ? (out.subarray(0, n) as T) : make()
}

export class UVGridSource implements IUVSource {
  readonly w: number
  readonly h: number

  /** Corner → grid vertex. The many-to-one map a corner-domain source owes. */
  private readonly owners: Int32Array

  private readonly layers: Layer[] = []
  private readonly selectedFaces = new Set<number>()
  private _topoStamp = 1
  private _active = 0

  constructor(opts: UVGridOptions = {}) {
    this.w = opts.w ?? 2
    this.h = opts.h ?? 2

    const faces = this.w * this.h
    this.owners = new Int32Array(faces * 4)

    for (let fy = 0; fy < this.h; fy++) {
      for (let fx = 0; fx < this.w; fx++) {
        const f = fy * this.w + fx
        // Counter-clockwise, matching what a face ring means everywhere else.
        const corners = [
          [fx, fy],
          [fx + 1, fy],
          [fx + 1, fy + 1],
          [fx, fy + 1],
        ]
        for (let i = 0; i < 4; i++) {
          this.owners[f * 4 + i] = corners[i][1] * (this.w + 1) + corners[i][0]
        }
      }
    }

    for (const name of opts.layers ?? ['UVMap']) {
      this.addLayer(name)
    }
  }

  /** A fresh layer laid out flat over the unit square, unselected and unpinned. */
  addLayer(name: string): number {
    const n = this.owners.length
    const uv = new Float32Array(n * 2)

    for (let c = 0; c < n; c++) {
      const v = this.owners[c]
      uv[c * 2] = (v % (this.w + 1)) / this.w
      uv[c * 2 + 1] = Math.floor(v / (this.w + 1)) / this.h
    }

    this.layers.push({name, uv, flags: new Uint8Array(n)})
    return this.layers.length - 1
  }

  setActiveUVLayer(layer: number): void {
    this._active = layer
  }

  setSelectedFaces(faces: Iterable<number>): void {
    this.selectedFaces.clear()
    for (const f of faces) {
      this.selectedFaces.add(f)
    }
  }

  /** Stand-in for a topology edit: every handle a caller is holding goes stale. */
  bumpTopoStamp(): void {
    this._topoStamp++
  }

  get topoStamp(): number {
    return this._topoStamp
  }

  get uvDomain(): ElementDomain {
    return ElementDomain.CORNER
  }

  listUVLayers(): readonly string[] {
    return this.layers.map((l) => l.name)
  }

  get activeUVLayer(): number {
    return this.layers.length === 0 ? -1 : this._active
  }

  private layerAt(layer: number): Layer | undefined {
    return this.layers[layer]
  }

  listUVElements(layer: number, owners?: ElementHandles): Int32Array {
    if (this.layerAt(layer) === undefined) {
      return new Int32Array(0)
    }

    if (owners === undefined) {
      const all = new Int32Array(this.owners.length)
      for (let c = 0; c < all.length; c++) {
        all[c] = c
      }
      return all
    }

    const wanted = new Set<number>()
    for (const v of owners) {
      wanted.add(v)
    }

    const hits: number[] = []
    for (let c = 0; c < this.owners.length; c++) {
      if (wanted.has(this.owners[c])) {
        hits.push(c)
      }
    }
    return Int32Array.from(hits)
  }

  getUVOwners(_layer: number, handles: ElementHandles, out?: Int32Array): Int32Array {
    const ret = sized(out, handles.length, () => new Int32Array(handles.length))
    for (let i = 0; i < handles.length; i++) {
      ret[i] = this.owners[handles[i]]
    }
    return ret
  }

  getUVs(layer: number, handles: ElementHandles, out?: Float32Array): Float32Array {
    const ret = sized(out, handles.length * 2, () => new Float32Array(handles.length * 2))
    const l = this.layerAt(layer)

    if (l === undefined) {
      ret.fill(0)
      return ret
    }

    for (let i = 0; i < handles.length; i++) {
      ret[i * 2] = l.uv[handles[i] * 2]
      ret[i * 2 + 1] = l.uv[handles[i] * 2 + 1]
    }
    return ret
  }

  setUVs(layer: number, handles: ElementHandles, uv: Float32Array): void {
    const l = this.layerAt(layer)
    if (l === undefined) {
      return
    }

    for (let i = 0; i < handles.length; i++) {
      l.uv[handles[i] * 2] = uv[i * 2]
      l.uv[handles[i] * 2 + 1] = uv[i * 2 + 1]
    }
  }

  getUVFlags(layer: number, handles: ElementHandles, out?: Uint8Array): Uint8Array {
    const ret = sized(out, handles.length, () => new Uint8Array(handles.length))
    const l = this.layerAt(layer)

    if (l === undefined) {
      ret.fill(0)
      return ret
    }

    for (let i = 0; i < handles.length; i++) {
      ret[i] = l.flags[handles[i]]
    }
    return ret
  }

  setUVFlags(layer: number, handles: ElementHandles, flags: Uint8Array): void {
    const l = this.layerAt(layer)
    if (l === undefined) {
      return
    }

    for (let i = 0; i < handles.length; i++) {
      l.flags[handles[i]] = flags[i]
    }
  }

  getUVFans(layer: number, handles: ElementHandles): {offsets: Int32Array; values: Int32Array} {
    const l = this.layerAt(layer)
    const rows: number[][] = []

    for (const c of handles) {
      if (l === undefined) {
        rows.push([])
        continue
      }

      const u = l.uv[c * 2]
      const v = l.uv[c * 2 + 1]
      const owner = this.owners[c]
      const row: number[] = []

      for (let other = 0; other < this.owners.length; other++) {
        if (this.owners[other] === owner && l.uv[other * 2] === u && l.uv[other * 2 + 1] === v) {
          row.push(other)
        }
      }
      rows.push(row)
    }
    return toCSR(rows)
  }

  listUVFaces(layer: number, selectedOnly = false): Int32Array {
    if (this.layerAt(layer) === undefined) {
      return new Int32Array(0)
    }

    const faces = this.w * this.h
    if (!selectedOnly) {
      const all = new Int32Array(faces)
      for (let f = 0; f < faces; f++) {
        all[f] = f
      }
      return all
    }

    const hits: number[] = []
    for (let f = 0; f < faces; f++) {
      if (this.selectedFaces.has(f)) {
        hits.push(f)
      }
    }
    return Int32Array.from(hits)
  }

  getUVFaceRings(layer: number, faces: ElementHandles): {offsets: Int32Array; values: Int32Array} {
    const l = this.layerAt(layer)
    const rows: number[][] = []

    for (const f of faces) {
      if (l === undefined || f < 0 || f >= this.w * this.h) {
        rows.push([])
        continue
      }
      rows.push([f * 4, f * 4 + 1, f * 4 + 2, f * 4 + 3])
    }
    return toCSR(rows)
  }
}

function toCSR(rows: number[][]): {offsets: Int32Array; values: Int32Array} {
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

/** Re-exported so a suite driving the double never reaches into the host. */
export {UVFlags}
