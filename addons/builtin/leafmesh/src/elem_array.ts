/**
 * Struct-of-arrays element storage for LeafMesh, mirroring sculptcore's
 * `ElemData` so a layer transfers between the two as a column copy.
 *
 * Elements are addressed by `int32` index, never by object reference, and
 * **deletion is tombstoned** — `freemap[i] = 1` and the index goes on a free
 * list. Indices therefore stay stable across edits, which is what lets tool
 * state, selection and undo hold raw indices safely. `compact()` is the only
 * thing that moves an element, it returns the remap tables, and nothing may
 * call it implicitly.
 *
 * Columns are reallocated on growth, so a `TypedArray` read out of a column is
 * only valid until the next `alloc()`. Hold the `Column` and read `.data`.
 */

export const ELEM_NONE = -1

export type TypedArray = Float32Array | Float64Array | Int32Array | Int16Array | Uint8Array

export type TypedArrayCtor =
  | Float32ArrayConstructor
  | Float64ArrayConstructor
  | Int32ArrayConstructor
  | Int16ArrayConstructor
  | Uint8ArrayConstructor

/** One named column of an `ElemArray`. `data` changes identity on growth. */
export interface Column {
  readonly name: string
  readonly ctor: TypedArrayCtor
  /** Components per element. */
  readonly size: number
  /** Value a fresh or compacted-away row is cleared to. */
  readonly fill: number
  data: TypedArray
}

/** Allocation page, in elements. A `hint` allocates within the hint's page. */
const PAGE_SHIFT = 9
const PAGE_SIZE = 1 << PAGE_SHIFT

const MIN_CAPACITY = 16

export class ElemArray {
  /** Allocated slots, live or not. */
  capacity = 0
  /** High-water mark; slots at or above this were never handed out. */
  used = 0
  /** Live element count. */
  count = 0
  freemap = new Uint8Array(0)
  freeList: number[] = []
  cols = new Map<string, Column>()

  constructor(reserve = 0) {
    if (reserve > 0) {
      this.reserve(reserve)
    }
  }

  hasColumn(name: string): boolean {
    return this.cols.has(name)
  }

  column(name: string): Column {
    const col = this.cols.get(name)
    if (col === undefined) {
      throw new Error(`no such column "${name}"`)
    }
    return col
  }

  /**
   * Add a column, backfilling `fill` for every element that already exists.
   * Re-adding an existing name with a matching layout returns it untouched.
   */
  addColumn(name: string, ctor: TypedArrayCtor, size = 1, fill = 0): Column {
    const existing = this.cols.get(name)
    if (existing !== undefined) {
      if (existing.ctor !== ctor || existing.size !== size) {
        throw new Error(`column "${name}" already exists with a different layout`)
      }
      return existing
    }

    const col: Column = {
      name,
      ctor,
      size,
      fill,
      data: new ctor(this.capacity * size),
    }
    if (fill !== 0) {
      col.data.fill(fill)
    }
    this.cols.set(name, col)
    return col
  }

  removeColumn(name: string): boolean {
    return this.cols.delete(name)
  }

  has(i: number): boolean {
    return i >= 0 && i < this.used && this.freemap[i] === 0
  }

  /** Grow to at least `cap` slots. Existing data and free state are preserved. */
  reserve(cap: number): void {
    if (cap <= this.capacity) {
      return
    }

    let newCap = Math.max(this.capacity * 2, MIN_CAPACITY)
    while (newCap < cap) {
      newCap *= 2
    }

    const freemap = new Uint8Array(newCap)
    freemap.fill(1)
    freemap.set(this.freemap)
    this.freemap = freemap

    for (const col of this.cols.values()) {
      const data = new col.ctor(newCap * col.size)
      if (col.fill !== 0) {
        data.fill(col.fill)
      }
      data.set(col.data)
      col.data = data
    }

    this.capacity = newCap
  }

  /**
   * Allocate one element. `hint` biases the result toward the hint's page, so
   * geometry created near existing geometry stays spatially local.
   */
  alloc(hint = ELEM_NONE): number {
    let i = ELEM_NONE

    if (hint >= 0 && hint < this.used) {
      i = this.findFreeNear(hint)
    }

    // Free-list entries are dropped lazily: a hint scan can claim a slot that
    // is still listed here.
    while (i < 0 && this.freeList.length > 0) {
      const j = this.freeList.pop() as number
      if (this.freemap[j] === 1) {
        i = j
      }
    }

    if (i < 0) {
      if (this.used === this.capacity) {
        this.reserve(this.capacity + 1)
      }
      i = this.used++
    }

    this.freemap[i] = 0
    this.count++
    this.clearRow(i)
    return i
  }

  free(i: number): void {
    if (!this.has(i)) {
      return
    }
    this.freemap[i] = 1
    this.freeList.push(i)
    this.count--
  }

  /** Reset every column of `i` to its fill value. */
  clearRow(i: number): void {
    for (const col of this.cols.values()) {
      const {data, size, fill} = col
      const base = i * size
      for (let k = 0; k < size; k++) {
        data[base + k] = fill
      }
    }
  }

  copyRow(dst: number, src: number): void {
    for (const col of this.cols.values()) {
      const {data, size} = col
      const d = dst * size
      const s = src * size
      for (let k = 0; k < size; k++) {
        data[d + k] = data[s + k]
      }
    }
  }

  /**
   * Squeeze the tombstones out, moving live elements down into index order.
   * Returns the old-index → new-index table (`ELEM_NONE` for dead slots); the
   * caller is responsible for remapping every stored index in the mesh.
   */
  compact(): Int32Array {
    const remap = new Int32Array(this.capacity)
    remap.fill(ELEM_NONE)

    let next = 0
    for (let i = 0; i < this.used; i++) {
      if (this.freemap[i] === 1) {
        continue
      }
      remap[i] = next++
    }

    // Ascending, and next <= i throughout, so the moves are safe in place.
    for (const col of this.cols.values()) {
      const {data, size} = col
      for (let i = 0; i < this.used; i++) {
        const to = remap[i]
        if (to < 0 || to === i) {
          continue
        }
        const d = to * size
        const s = i * size
        for (let k = 0; k < size; k++) {
          data[d + k] = data[s + k]
        }
      }
      for (let i = next * size; i < this.capacity * size; i++) {
        data[i] = col.fill
      }
    }

    this.freemap.fill(0, 0, next)
    this.freemap.fill(1, next, this.capacity)
    this.freeList.length = 0
    this.used = next
    this.count = next
    return remap
  }

  *[Symbol.iterator](): Generator<number> {
    for (let i = 0; i < this.used; i++) {
      if (this.freemap[i] === 0) {
        yield i
      }
    }
  }

  private findFreeNear(hint: number): number {
    const start = (hint >> PAGE_SHIFT) << PAGE_SHIFT
    const end = Math.min(start + PAGE_SIZE, this.used)
    for (let i = start; i < end; i++) {
      if (this.freemap[i] === 1) {
        return i
      }
    }
    return ELEM_NONE
  }
}
