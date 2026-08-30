/**
 * AttrSet: layer declaration, the continuous/discrete interpolation split, and
 * the snapshot/restore pair the topology ops lean on.
 */

import {ElemArray} from '../../../addons/builtin/leafmesh/src/elem_array'
import {
  AttrFlags,
  AttrSet,
  AttrType,
  DOMAIN_COUNT,
  Domain,
  attrTypeIsDiscrete,
  attrTypeSize,
} from '../../../addons/builtin/leafmesh/src/attrs'

function makeSet(): {attrs: AttrSet; arrays: ElemArray[]} {
  const arrays: ElemArray[] = []
  for (let i = 0; i < DOMAIN_COUNT; i++) {
    arrays.push(new ElemArray())
  }
  return {attrs: new AttrSet(arrays), arrays}
}

describe('AttrSet', () => {
  test('type table agrees with itself', () => {
    expect(attrTypeSize(AttrType.Float3)).toBe(3)
    expect(attrTypeSize(AttrType.Byte)).toBe(1)
    expect(attrTypeIsDiscrete(AttrType.Float2)).toBe(false)
    expect(attrTypeIsDiscrete(AttrType.Int)).toBe(true)
    expect(attrTypeIsDiscrete(AttrType.Bool)).toBe(true)
  })

  test('rejects the wrong number of domains', () => {
    expect(() => new AttrSet([new ElemArray()])).toThrow()
  })

  test('declares a layer as a column on the right domain', () => {
    const {attrs, arrays} = makeSet()
    const uv = attrs.add(Domain.CORNER, 'uv', AttrType.Float2)

    expect(uv.column.size).toBe(2)
    expect(arrays[Domain.CORNER].hasColumn('attr:uv')).toBe(true)
    expect(arrays[Domain.VERT].hasColumn('attr:uv')).toBe(false)
    expect(attrs.has(Domain.CORNER, 'uv')).toBe(true)
    expect(attrs.has(Domain.VERT, 'uv')).toBe(false)
    expect(attrs.get(Domain.CORNER, 'uv')).toBe(uv)
  })

  test('re-declaring returns the same layer, and a type clash throws', () => {
    const {attrs} = makeSet()
    const a = attrs.add(Domain.VERT, 'mask', AttrType.Float)

    expect(attrs.add(Domain.VERT, 'mask', AttrType.Float)).toBe(a)
    expect(() => attrs.add(Domain.VERT, 'mask', AttrType.Float3)).toThrow()
    // The same name on another domain is a different layer.
    expect(attrs.add(Domain.FACE, 'mask', AttrType.Int)).not.toBe(a)
  })

  test('removes a layer and its column', () => {
    const {attrs, arrays} = makeSet()
    attrs.add(Domain.EDGE, 'crease', AttrType.Float)

    expect(attrs.remove(Domain.EDGE, 'crease')).toBe(true)
    expect(attrs.has(Domain.EDGE, 'crease')).toBe(false)
    expect(arrays[Domain.EDGE].hasColumn('attr:crease')).toBe(false)
    expect(attrs.remove(Domain.EDGE, 'crease')).toBe(false)
    expect(attrs.layers(Domain.EDGE).length).toBe(0)
  })

  test('lists persistent layers, skipping TEMP ones', () => {
    const {attrs} = makeSet()
    attrs.add(Domain.VERT, 'keep', AttrType.Float)
    attrs.add(Domain.VERT, 'scratch', AttrType.Float, AttrFlags.TEMP)
    attrs.add(Domain.VERT, 'also', AttrType.Int)

    expect(attrs.layers(Domain.VERT).map((l) => l.name)).toEqual(['keep', 'scratch', 'also'])
    expect(attrs.persistentLayers(Domain.VERT).map((l) => l.name)).toEqual(['keep', 'also'])
  })

  test('fill backfills the column', () => {
    const {attrs, arrays} = makeSet()
    const a = arrays[Domain.VERT].alloc()
    const layer = attrs.add(Domain.VERT, 'weight', AttrType.Float, AttrFlags.NONE, 1)

    expect(layer.column.data[a]).toBe(1)
    // And a later element still allocates to the fill, not zero.
    const b = arrays[Domain.VERT].alloc()
    expect(layer.column.data[b]).toBe(1)
  })

  test('copies every layer of one element', () => {
    const {attrs, arrays} = makeSet()
    const uv = attrs.add(Domain.CORNER, 'uv', AttrType.Float2)
    const mat = attrs.add(Domain.CORNER, 'mat', AttrType.Int)

    const src = arrays[Domain.CORNER].alloc()
    const dst = arrays[Domain.CORNER].alloc()
    uv.column.data[src * 2] = 0.25
    uv.column.data[src * 2 + 1] = 0.75
    mat.column.data[src] = 3

    attrs.copy(Domain.CORNER, dst, src)
    expect(uv.column.data[dst * 2]).toBeCloseTo(0.25)
    expect(uv.column.data[dst * 2 + 1]).toBeCloseTo(0.75)
    expect(mat.column.data[dst]).toBe(3)
  })

  test('continuous layers take the weighted mean', () => {
    const {attrs, arrays} = makeSet()
    const co = attrs.add(Domain.VERT, 'orig', AttrType.Float3)

    const a = arrays[Domain.VERT].alloc()
    const b = arrays[Domain.VERT].alloc()
    const dst = arrays[Domain.VERT].alloc()
    co.column.data.set([0, 0, 0], a * 3)
    co.column.data.set([4, 8, 12], b * 3)

    attrs.interp(Domain.VERT, dst, [a, b], [0.75, 0.25])
    expect(co.column.data[dst * 3]).toBeCloseTo(1)
    expect(co.column.data[dst * 3 + 1]).toBeCloseTo(2)
    expect(co.column.data[dst * 3 + 2]).toBeCloseTo(3)
  })

  test('discrete layers take the highest-weighted source, never an average', () => {
    const {attrs, arrays} = makeSet()
    const mat = attrs.add(Domain.FACE, 'material', AttrType.Int)

    const a = arrays[Domain.FACE].alloc()
    const b = arrays[Domain.FACE].alloc()
    const dst = arrays[Domain.FACE].alloc()
    mat.column.data[a] = 2
    mat.column.data[b] = 9

    attrs.interp(Domain.FACE, dst, [a, b], [0.6, 0.4])
    expect(mat.column.data[dst]).toBe(2)

    attrs.interp(Domain.FACE, dst, [a, b], [0.4, 0.6])
    expect(mat.column.data[dst]).toBe(9)
  })

  test('interpolating into a source reads before it writes', () => {
    const {attrs, arrays} = makeSet()
    const w = attrs.add(Domain.VERT, 'w', AttrType.Float)

    const a = arrays[Domain.VERT].alloc()
    const b = arrays[Domain.VERT].alloc()
    w.column.data[a] = 10
    w.column.data[b] = 20

    attrs.interp(Domain.VERT, a, [a, b], [0.5, 0.5])
    expect(w.column.data[a]).toBeCloseTo(15)
    expect(w.column.data[b]).toBe(20)
  })

  test('interp validates its weights and tolerates no sources', () => {
    const {attrs, arrays} = makeSet()
    attrs.add(Domain.VERT, 'w', AttrType.Float)
    const a = arrays[Domain.VERT].alloc()

    expect(() => attrs.interp(Domain.VERT, a, [a], [0.5, 0.5])).toThrow()
    expect(() => attrs.interp(Domain.VERT, a, [], [])).not.toThrow()
  })

  test('interpCorner is interp on the corner domain', () => {
    const {attrs, arrays} = makeSet()
    const uv = attrs.add(Domain.CORNER, 'uv', AttrType.Float2)
    const vertUv = attrs.add(Domain.VERT, 'uv', AttrType.Float2)

    const vert = arrays[Domain.VERT].alloc()
    const a = arrays[Domain.CORNER].alloc()
    const b = arrays[Domain.CORNER].alloc()
    const dst = arrays[Domain.CORNER].alloc()
    uv.column.data.set([0, 0], a * 2)
    uv.column.data.set([1, 1], b * 2)

    attrs.interpCorner(dst, [a, b], [0.5, 0.5])
    expect(uv.column.data[dst * 2]).toBeCloseTo(0.5)
    expect(uv.column.data[dst * 2 + 1]).toBeCloseTo(0.5)
    // interpCorner does not touch the vertex 'uv' layer, even though it shares the name with the corner layer.
    expect(vertUv.column.data[vert * 2]).toBe(0)
  })

  test('snapshot and restore round-trip every layer of an element', () => {
    const {attrs, arrays} = makeSet()
    const uv = attrs.add(Domain.CORNER, 'uv', AttrType.Float2)
    const mat = attrs.add(Domain.CORNER, 'mat', AttrType.Int)
    const flag = attrs.add(Domain.CORNER, 'flag', AttrType.Bool)

    const a = arrays[Domain.CORNER].alloc()
    uv.column.data.set([0.125, 0.375], a * 2)
    mat.column.data[a] = 7
    flag.column.data[a] = 1

    const snap = attrs.snapshotRow(Domain.CORNER, a)
    expect(snap.length).toBe(4)

    arrays[Domain.CORNER].clearRow(a)
    expect(mat.column.data[a]).toBe(0)

    attrs.restoreRow(Domain.CORNER, a, snap)
    expect(uv.column.data[a * 2]).toBeCloseTo(0.125)
    expect(uv.column.data[a * 2 + 1]).toBeCloseTo(0.375)
    expect(mat.column.data[a]).toBe(7)
    expect(flag.column.data[a]).toBe(1)
  })

  test('a snapshot restores onto a different element', () => {
    const {attrs, arrays} = makeSet()
    const w = attrs.add(Domain.FACE, 'w', AttrType.Float)

    const a = arrays[Domain.FACE].alloc()
    const b = arrays[Domain.FACE].alloc()
    w.column.data[a] = 4.5

    attrs.restoreRow(Domain.FACE, b, attrs.snapshotRow(Domain.FACE, a))
    expect(w.column.data[b]).toBeCloseTo(4.5)
  })
})
