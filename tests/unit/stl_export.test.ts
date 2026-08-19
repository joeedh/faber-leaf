/**
 * Binary STL export — P13 §10.11.
 *
 * The exporter used to walk a BREP `loopTris` array of loop objects, so the
 * delete left it addressing a shape no surviving mesh type has. It reads
 * `ITriangleSource` now, gated on the declared TRIANGLES capability. Pinned
 * here: the container framing, the facet normal (geometric, not per-vertex),
 * and that a data block without the capability is skipped rather than thrown on.
 */

import {_resetDataKindsForTests, registerDataKind} from '../../scripts/core/data_kinds'
import {GeometryCapability} from '../../scripts/core/geometry_contract'
import {exportSTLMesh} from '../../scripts/util/stlformat.js'

/** One CCW triangle in the z=0 plane, so its facet normal is exactly +Z. */
class FlatTri {
  static dataDefine() {
    return {dataKind: 'test-tri'}
  }

  extractTriangles() {
    return {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices  : new Int32Array([0, 1, 2]),
      // Deliberately wrong, to prove the facet normal is not read from here.
      normals  : new Float64Array([0, 0, -1, 0, 0, -1, 0, 0, -1]),
    }
  }
}

class NotGeometry {
  static dataDefine() {
    return {dataKind: 'test-opaque'}
  }
}

beforeEach(() => {
  _resetDataKindsForTests()
  registerDataKind({id: 'test-tri', capabilities: [GeometryCapability.TRIANGLES]})
  registerDataKind({id: 'test-opaque', capabilities: []})
})

afterAll(() => {
  _resetDataKindsForTests()
})

/** @returns the header, triangle count and per-facet floats of a binary STL. */
function readSTL(buf: ArrayBuffer) {
  const view = new DataView(buf)
  const count = view.getInt32(80, true)
  const facets: number[][] = []

  for (let i = 0; i < count; i++) {
    const at = 84 + i * 50
    const f: number[] = []
    for (let j = 0; j < 12; j++) {
      f.push(view.getFloat32(at + j * 4, true))
    }
    facets.push(f)
  }

  return {byteLength: buf.byteLength, count, facets, attr: count ? view.getUint16(84 + 48, true) : 0}
}

test('one triangle produces a well-formed 134-byte file', () => {
  const stl = readSTL(exportSTLMesh([new FlatTri()]))

  expect(stl.byteLength).toBe(84 + 50)
  expect(stl.count).toBe(1)
  expect(stl.attr).toBe(0)
})

test('the header is 80 zero bytes', () => {
  const head = new Uint8Array(exportSTLMesh([new FlatTri()]), 0, 80)
  expect(head.every((b) => b === 0)).toBe(true)
})

test('the facet normal is geometric, not the supplied per-vertex one', () => {
  const [f] = readSTL(exportSTLMesh([new FlatTri()])).facets

  expect(f.slice(0, 3)).toEqual([0, 0, 1])
  expect(f.slice(3)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
})

test('several blocks concatenate into one triangle run', () => {
  const stl = readSTL(exportSTLMesh([new FlatTri(), new FlatTri(), new FlatTri()]))

  expect(stl.count).toBe(3)
  expect(stl.byteLength).toBe(84 + 3 * 50)
})

test('a block that does not declare TRIANGLES is skipped, not thrown on', () => {
  const stl = readSTL(exportSTLMesh([new NotGeometry(), new FlatTri()]))

  expect(stl.count).toBe(1)
})

test('an empty selection still writes a valid empty container', () => {
  const stl = readSTL(exportSTLMesh([]))

  expect(stl.byteLength).toBe(84)
  expect(stl.count).toBe(0)
})
