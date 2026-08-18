/**
 * The `.wproj` blob: authoritative columns out, derived topology rebuilt on the
 * way back in (P11 §5). Only the pure half is exercised here — the nstructjs
 * hook that carries the blob into a file lives in `leafmesh.ts`, which jest
 * cannot import (no `@framework/*` alias).
 */

import {AttrFlags, AttrType, Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {ELEM_NONE} from '../../../addons/builtin/leafmesh/src/elem_array'
import {makeCube, makeGrid} from '../../../addons/builtin/leafmesh/src/primitives'
import {
  LEAFMESH_BLOB_VERSION,
  deserializeLeafMesh,
  serializeLeafMesh,
} from '../../../addons/builtin/leafmesh/src/serialize'
import {LeafMesh} from '../../../addons/builtin/leafmesh/src/topo'

/** A face with a hole: a big quad whose ring encloses a small reversed one. */
function quadWithHole(mesh: LeafMesh): number {
  const outer = [
    mesh.makeVert([-2, -2, 0]),
    mesh.makeVert([2, -2, 0]),
    mesh.makeVert([2, 2, 0]),
    mesh.makeVert([-2, 2, 0]),
  ]
  const inner = [
    mesh.makeVert([-1, -1, 0]),
    mesh.makeVert([-1, 1, 0]),
    mesh.makeVert([1, 1, 0]),
    mesh.makeVert([1, -1, 0]),
  ]
  return mesh.makeFace([outer, inner])
}

/** Everything a caller can observe about the topology, order-independent. */
function shape(mesh: LeafMesh) {
  const faces = []
  for (const f of mesh.f) {
    const rings = []
    for (const l of mesh.faceLoops(f)) {
      rings.push(mesh.loopVerts(l).map(v => [...mesh.v.co.subarray(v * 3, v * 3 + 3)]))
    }
    faces.push(rings)
  }
  return {
    counts: [mesh.v.count, mesh.e.count, mesh.c.count, mesh.l.count, mesh.f.count],
    faces,
  }
}

describe('leafmesh serialization', () => {
  test('a cube round-trips', () => {
    const src = new LeafMesh()
    makeCube(src, 2)

    const out = deserializeLeafMesh(serializeLeafMesh(src))

    expect(shape(out)).toEqual(shape(src))
    expect(out.validateAndRepair()).toBe(0)
  })

  test('a hole-bearing face keeps its rings, in order', () => {
    const src = new LeafMesh()
    const f = quadWithHole(src)

    const out = deserializeLeafMesh(serializeLeafMesh(src))
    const loops = [...out.faceLoops(0)]

    expect(src.f.listCount[f]).toBe(2)
    expect(out.f.listCount[0]).toBe(2)
    expect(loops.length).toBe(2)
    // Ring 0 is the outer one on both sides: hole order is authoritative.
    expect(out.loopVerts(loops[0]).length).toBe(4)
    expect(shape(out)).toEqual(shape(src))
    expect(out.validateAndRepair()).toBe(0)
  })

  test('tombstones do not reach the file', () => {
    const src = new LeafMesh()
    makeGrid(src, 3, 3, 3)
    const doomed = [...src.f][4]
    src.killFace(doomed)

    expect(src.f.used).toBeGreaterThan(src.f.count)

    const bytes = serializeLeafMesh(src)
    const out = deserializeLeafMesh(bytes)

    expect(out.f.used).toBe(out.f.count)
    expect(out.f.count).toBe(src.f.count)
    for (const f of out.f) {
      expect(out.f.l[f]).not.toBe(ELEM_NONE)
    }
    expect(out.validateAndRepair()).toBe(0)
  })

  test('attribute layers survive, TEMP ones do not', () => {
    const src = new LeafMesh()
    makeCube(src, 1)

    const uv = src.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)
    const mat = src.attrs.add(Domain.FACE, 'material_index', AttrType.Int, AttrFlags.NONE, -1)
    const sel = src.attrs.add(Domain.VERT, '.select', AttrType.Byte)
    src.attrs.add(Domain.VERT, 'stroke_orig', AttrType.Float3, AttrFlags.TEMP)

    for (const c of src.c) {
      uv.column.data[c * 2] = c * 0.25
      uv.column.data[c * 2 + 1] = 1 - c * 0.25
    }
    for (const f of src.f) {
      mat.column.data[f] = f % 3
    }
    for (const v of src.v) {
      sel.column.data[v] = v % 2
    }

    const out = deserializeLeafMesh(serializeLeafMesh(src))

    expect(out.attrs.has(Domain.VERT, 'stroke_orig')).toBe(false)
    expect(out.attrs.layers(Domain.VERT).map(l => l.name)).toEqual(['.select'])

    const outUv = out.attrs.get(Domain.CORNER, 'uv')!
    const outMat = out.attrs.get(Domain.FACE, 'material_index')!
    const outSel = out.attrs.get(Domain.VERT, '.select')!

    expect(outMat.column.fill).toBe(-1)
    expect([...outUv.column.data.subarray(0, src.c.count * 2)]).toEqual([
      ...uv.column.data.subarray(0, src.c.count * 2),
    ])
    expect([...outMat.column.data.subarray(0, src.f.count)]).toEqual([...mat.column.data.subarray(0, src.f.count)])
    expect([...outSel.column.data.subarray(0, src.v.count)]).toEqual([...sel.column.data.subarray(0, src.v.count)])
  })

  test('a float fill survives the header', () => {
    const src = new LeafMesh()
    makeCube(src, 1)
    src.attrs.add(Domain.VERT, 'mask', AttrType.Float, AttrFlags.NONE, 0.5)

    const out = deserializeLeafMesh(serializeLeafMesh(src))

    expect(out.attrs.get(Domain.VERT, 'mask')!.column.fill).toBeCloseTo(0.5, 12)
  })

  test('an empty mesh round-trips', () => {
    const out = deserializeLeafMesh(serializeLeafMesh(new LeafMesh()))

    expect([out.v.count, out.e.count, out.f.count]).toEqual([0, 0, 0])
  })

  test('a foreign or future blob is refused', () => {
    expect(() => deserializeLeafMesh(new Uint8Array(64))).toThrow(/not a LeafMesh blob/)

    const bytes = serializeLeafMesh(new LeafMesh())
    new Uint32Array(bytes.buffer, bytes.byteOffset, 4)[2] = LEAFMESH_BLOB_VERSION + 1

    expect(() => deserializeLeafMesh(bytes)).toThrow(/newer than/)
  })
})
