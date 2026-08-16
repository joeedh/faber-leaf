/**
 * ElemArray: tombstoned deletion, index stability, hinted allocation, and the
 * one operation that is allowed to move an element.
 */

import {ELEM_NONE, ElemArray} from '../../../addons/builtin/leafmesh/src/elem_array'

function live(array: ElemArray): number[] {
  return [...array]
}

describe('ElemArray', () => {
  test('allocates ascending and tracks counts', () => {
    const array = new ElemArray()
    const col = array.addColumn('x', Float32Array, 1, 0)

    expect(array.alloc()).toBe(0)
    expect(array.alloc()).toBe(1)
    expect(array.alloc()).toBe(2)
    expect(array.count).toBe(3)
    expect(array.used).toBe(3)
    expect(col.data.length).toBeGreaterThanOrEqual(3)
  })

  test('keeps indices stable across deletion', () => {
    const array = new ElemArray()
    const col = array.addColumn('x', Int32Array, 1, 0)

    const a = array.alloc()
    const b = array.alloc()
    const c = array.alloc()
    col.data[a] = 10
    col.data[b] = 20
    col.data[c] = 30

    array.free(b)

    expect(array.has(b)).toBe(false)
    expect(array.count).toBe(2)
    expect(live(array)).toEqual([a, c])
    // The survivors did not move.
    expect(col.data[a]).toBe(10)
    expect(col.data[c]).toBe(30)
  })

  test('reuses a freed slot and clears it first', () => {
    const array = new ElemArray()
    const col = array.addColumn('x', Int32Array, 1, 7)

    const a = array.alloc()
    col.data[a] = 99
    array.free(a)

    const b = array.alloc()
    expect(b).toBe(a)
    expect(col.data[b]).toBe(7)
  })

  test('grows without losing data or free state', () => {
    const array = new ElemArray()
    const col = array.addColumn('x', Int32Array, 1, -1)

    const indices: number[] = []
    for (let i = 0; i < 100; i++) {
      const e = array.alloc()
      col.data[e] = i
      indices.push(e)
    }

    expect(array.capacity).toBeGreaterThanOrEqual(100)
    for (let i = 0; i < 100; i++) {
      expect(col.data[indices[i]]).toBe(i)
    }
    // The tail past the high-water mark still reads as the fill value.
    expect(col.data[array.capacity - 1]).toBe(-1)
  })

  test('multi-component columns round-trip', () => {
    const array = new ElemArray()
    const col = array.addColumn('co', Float32Array, 3, 0)

    const a = array.alloc()
    col.data[a * 3] = 1
    col.data[a * 3 + 1] = 2
    col.data[a * 3 + 2] = 3

    const b = array.alloc()
    expect(col.data[b * 3]).toBe(0)
    expect(col.data[a * 3 + 1]).toBe(2)
  })

  test('a hint allocates within the hint page', () => {
    const array = new ElemArray()
    array.addColumn('x', Int32Array, 1, 0)

    for (let i = 0; i < 600; i++) {
      array.alloc()
    }
    array.free(5)
    array.free(520)

    // 520 is in the second page; the hint must reach it over the older 5.
    expect(array.alloc(519)).toBe(520)
    expect(array.alloc(0)).toBe(5)
  })

  test('a new column backfills existing elements', () => {
    const array = new ElemArray()
    const a = array.alloc()
    const b = array.alloc()

    const col = array.addColumn('late', Int32Array, 1, 4)
    expect(col.data[a]).toBe(4)
    expect(col.data[b]).toBe(4)
  })

  test('re-adding a column with a different layout throws', () => {
    const array = new ElemArray()
    array.addColumn('x', Int32Array, 1, 0)

    expect(array.addColumn('x', Int32Array, 1, 0)).toBe(array.column('x'))
    expect(() => array.addColumn('x', Float32Array, 1, 0)).toThrow()
    expect(() => array.column('nope')).toThrow()
  })

  test('compact squeezes out tombstones and reports the remap', () => {
    const array = new ElemArray()
    const col = array.addColumn('x', Int32Array, 1, -1)

    const indices: number[] = []
    for (let i = 0; i < 6; i++) {
      const e = array.alloc()
      col.data[e] = i * 10
      indices.push(e)
    }
    array.free(indices[1])
    array.free(indices[4])

    const remap = array.compact()

    expect(remap[indices[1]]).toBe(ELEM_NONE)
    expect(remap[indices[4]]).toBe(ELEM_NONE)
    expect(remap[indices[0]]).toBe(0)
    expect(remap[indices[2]]).toBe(1)
    expect(remap[indices[3]]).toBe(2)
    expect(remap[indices[5]]).toBe(3)

    expect(array.count).toBe(4)
    expect(array.used).toBe(4)
    expect(live(array)).toEqual([0, 1, 2, 3])
    expect([...col.data.slice(0, 4)]).toEqual([0, 20, 30, 50])
  })

  test('compact leaves a dense array untouched', () => {
    const array = new ElemArray()
    const col = array.addColumn('x', Int32Array, 1, 0)
    for (let i = 0; i < 4; i++) {
      col.data[array.alloc()] = i
    }

    const remap = array.compact()
    for (let i = 0; i < 4; i++) {
      expect(remap[i]).toBe(i)
      expect(col.data[i]).toBe(i)
    }
  })

  test('copyRow copies every column', () => {
    const array = new ElemArray()
    const x = array.addColumn('x', Int32Array, 1, 0)
    const co = array.addColumn('co', Float32Array, 3, 0)

    const a = array.alloc()
    const b = array.alloc()
    x.data[a] = 5
    co.data[a * 3 + 1] = 2.5

    array.copyRow(b, a)
    expect(x.data[b]).toBe(5)
    expect(co.data[b * 3 + 1]).toBe(2.5)
  })

  test('freeing twice is a no-op', () => {
    const array = new ElemArray()
    const a = array.alloc()
    array.free(a)
    array.free(a)
    expect(array.count).toBe(0)
    expect(array.alloc()).toBe(a)
  })
})
