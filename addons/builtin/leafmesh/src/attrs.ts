/**
 * Defines typed, named attribute layers over the five LeafMesh domains.
 *
 * A layer packages one `ElemArray` column with the metadata needed to
 * serialize it and to interpolate it when geometry is created. The vocabulary
 * deliberately matches sculptcore's, so a layer round-trips to the engine as
 * a column copy rather than a conversion.
 *
 * Two conventions are worth knowing before adding a layer. UVs live on the
 * **corner** domain, not the vertex domain: a seam occurs where two corners
 * of one vertex disagree, the only representation that does not force a
 * vertex split. And `select` and `hide` are ordinary `Bool` layers, not
 * bitfields on the element, so no code may add a sixth flag bit and quietly
 * break undo.
 */

import type {Column, ElemArray, TypedArrayCtor} from './elem_array.js'

export enum Domain {
  VERT = 0,
  EDGE = 1,
  CORNER = 2,
  LOOP = 3,
  FACE = 4,
}

export const DOMAIN_COUNT = 5

export enum AttrType {
  Float = 0,
  Float2 = 1,
  Float3 = 2,
  Float4 = 3,
  Int = 4,
  Int2 = 5,
  Int3 = 6,
  Int4 = 7,
  Short = 8,
  Byte = 9,
  Bool = 10,
}

export enum AttrFlags {
  NONE = 0,
  /** Rebuilt or discarded on load; never written to a `.wproj`. */
  TEMP = 1,
  /** Computed from other state; `rebuildDerivedTopo()` may clobber it. */
  DERIVED = 2,
}

interface TypeInfo {
  ctor: TypedArrayCtor
  size: number
  /** Integer-like layers take the nearest source instead of a weighted mean. */
  discrete: boolean
}

const TYPE_INFO: Record<AttrType, TypeInfo> = {
  [AttrType.Float] : {ctor: Float32Array, size: 1, discrete: false},
  [AttrType.Float2]: {ctor: Float32Array, size: 2, discrete: false},
  [AttrType.Float3]: {ctor: Float32Array, size: 3, discrete: false},
  [AttrType.Float4]: {ctor: Float32Array, size: 4, discrete: false},
  [AttrType.Int]   : {ctor: Int32Array, size: 1, discrete: true},
  [AttrType.Int2]  : {ctor: Int32Array, size: 2, discrete: true},
  [AttrType.Int3]  : {ctor: Int32Array, size: 3, discrete: true},
  [AttrType.Int4]  : {ctor: Int32Array, size: 4, discrete: true},
  [AttrType.Short] : {ctor: Int16Array, size: 1, discrete: true},
  [AttrType.Byte]  : {ctor: Uint8Array, size: 1, discrete: true},
  [AttrType.Bool]  : {ctor: Uint8Array, size: 1, discrete: true},
}

export function attrTypeSize(type: AttrType): number {
  return TYPE_INFO[type].size
}

export function attrTypeIsDiscrete(type: AttrType): boolean {
  return TYPE_INFO[type].discrete
}

export interface AttrLayer {
  readonly domain: Domain
  readonly name: string
  readonly type: AttrType
  flags: AttrFlags
  readonly column: Column
}

function layerKey(domain: Domain, name: string): string {
  return `${domain}:${name}`
}

/**
 * The attribute layers of one mesh. Owns nothing but metadata — the storage
 * belongs to the `ElemArray` of each domain, handed in at construction.
 */
export class AttrSet {
  private readonly arrays: ElemArray[]
  private readonly byKey = new Map<string, AttrLayer>()
  private readonly byDomain: AttrLayer[][] = [[], [], [], [], []]

  constructor(arrays: ElemArray[]) {
    if (arrays.length !== DOMAIN_COUNT) {
      throw new Error(`AttrSet needs ${DOMAIN_COUNT} element arrays`)
    }
    this.arrays = arrays
  }

  /**
   * Declare a layer. Re-declaring a name on the same domain returns the
   * existing layer if the type matches and throws if it does not, so two
   * addons cannot silently reinterpret each other's data.
   */
  add(domain: Domain, name: string, type: AttrType, flags = AttrFlags.NONE, fill = 0): AttrLayer {
    const key = layerKey(domain, name)
    const existing = this.byKey.get(key)
    if (existing !== undefined) {
      if (existing.type !== type) {
        throw new Error(`attribute "${name}" already exists on this domain with a different type`)
      }
      return existing
    }

    const info = TYPE_INFO[type]
    const column = this.arrays[domain].addColumn(`attr:${name}`, info.ctor, info.size, fill)
    const layer: AttrLayer = {domain, name, type, flags, column}
    this.byKey.set(key, layer)
    this.byDomain[domain].push(layer)
    return layer
  }

  get(domain: Domain, name: string): AttrLayer | undefined {
    return this.byKey.get(layerKey(domain, name))
  }

  has(domain: Domain, name: string): boolean {
    return this.byKey.has(layerKey(domain, name))
  }

  remove(domain: Domain, name: string): boolean {
    const key = layerKey(domain, name)
    const layer = this.byKey.get(key)
    if (layer === undefined) {
      return false
    }
    this.byKey.delete(key)
    const list = this.byDomain[domain]
    list.splice(list.indexOf(layer), 1)
    this.arrays[domain].removeColumn(layer.column.name)
    return true
  }

  /** Layers of one domain, in declaration order. */
  layers(domain: Domain): readonly AttrLayer[] {
    return this.byDomain[domain]
  }

  /** Layers that survive serialization, in declaration order. */
  persistentLayers(domain: Domain): AttrLayer[] {
    return this.byDomain[domain].filter((l) => (l.flags & AttrFlags.TEMP) === 0)
  }

  copy(domain: Domain, dst: number, src: number): void {
    for (const layer of this.byDomain[domain]) {
      const {data, size} = layer.column
      const d = dst * size
      const s = src * size
      for (let k = 0; k < size; k++) {
        data[d + k] = data[s + k]
      }
    }
  }

  /**
   * Weighted interpolation of every layer of `domain` from `srcs` into `dst`.
   * Continuous layers take the weighted mean; discrete ones take the value of
   * the highest-weighted source, because averaging a material index or a face
   * group produces a value that means nothing.
   *
   * `dst` may be one of `srcs`; sources are read before anything is written.
   */
  interp(domain: Domain, dst: number, srcs: readonly number[], weights: readonly number[]): void {
    if (srcs.length === 0) {
      return
    }
    if (srcs.length !== weights.length) {
      throw new Error('interp needs one weight per source')
    }

    let best = 0
    for (let i = 1; i < weights.length; i++) {
      if (weights[i] > weights[best]) {
        best = i
      }
    }

    for (const layer of this.byDomain[domain]) {
      const {data, size} = layer.column
      const d = dst * size

      if (TYPE_INFO[layer.type].discrete) {
        const s = srcs[best] * size
        for (let k = 0; k < size; k++) {
          this.scratch[k] = data[s + k]
        }
      } else {
        for (let k = 0; k < size; k++) {
          this.scratch[k] = 0
        }
        for (let i = 0; i < srcs.length; i++) {
          const s = srcs[i] * size
          const w = weights[i]
          for (let k = 0; k < size; k++) {
            this.scratch[k] += data[s + k] * w
          }
        }
      }

      for (let k = 0; k < size; k++) {
        data[d + k] = this.scratch[k]
      }
    }
  }

  /**
   * The hook every op that creates a corner routes through. Named separately
   * from `interp` because the corner domain is the one that carries UVs and
   * vertex colours, and it is the one that is easy to forget.
   */
  interpCorner(dst: number, srcs: readonly number[], weights: readonly number[]): void {
    this.interp(Domain.CORNER, dst, srcs, weights)
  }

  /** Flatten every layer of one element, for save/restore across a rebuild. */
  snapshotRow(domain: Domain, index: number): Float64Array {
    const layers = this.byDomain[domain]
    let total = 0
    for (const layer of layers) {
      total += layer.column.size
    }

    const out = new Float64Array(total)
    let at = 0
    for (const layer of layers) {
      const {data, size} = layer.column
      const s = index * size
      for (let k = 0; k < size; k++) {
        out[at++] = data[s + k]
      }
    }
    return out
  }

  restoreRow(domain: Domain, index: number, snapshot: Float64Array): void {
    let at = 0
    for (const layer of this.byDomain[domain]) {
      const {data, size} = layer.column
      const d = index * size
      for (let k = 0; k < size; k++) {
        data[d + k] = snapshot[at++]
      }
    }
  }

  private readonly scratch = new Float64Array(4)
}
