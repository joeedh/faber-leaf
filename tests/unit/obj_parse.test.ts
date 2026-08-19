/**
 * The widget-shape OBJ reader — P13 §10.9.
 *
 * `loadShapes()` used to be late-bound to the BREP mesh addon's OBJ reader, so
 * deleting that addon left the host throwing on startup before anything else
 * ran. The host owns the parser now; what is pinned here is that it reads every
 * shipped shape and triangulates the way the BREP path did. The wiring into a
 * `SimpleMesh` is covered by the NW.js integration suites, which cannot run in
 * this environment because they boot the real app.
 */

import {parseOBJTris} from '../../scripts/webgl/obj_parse'
import {ShapeOBJs} from '../../scripts/webgl/shape_data'

describe.each(Object.entries(ShapeOBJs))('the built-in %s widget shape', (_key, b64) => {
  const {positions, normals} = parseOBJTris(atob(b64))

  test('parses to whole triangles with finite coordinates', () => {
    expect(positions.length).toBeGreaterThan(0)
    expect(positions.length % 9).toBe(0)
    expect(normals.length).toBe(positions.length)
    expect(positions.every((x) => Number.isFinite(x))).toBe(true)
  })

  test('carries a unit normal at every corner', () => {
    for (let i = 0; i < normals.length; i += 3) {
      expect(Math.hypot(normals[i], normals[i + 1], normals[i + 2])).toBeCloseTo(1, 5)
    }
  })
})

describe('parseOBJTris', () => {
  test('fan-triangulates an n-gon rather than dropping it', () => {
    const {positions} = parseOBJTris(['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3 4'].join('\n'))

    expect(positions).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0])
  })

  test('flat-shades each face from its own winding', () => {
    const {normals} = parseOBJTris(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n'))

    expect(normals).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1])
  })

  test('resolves negative and slash-qualified face references', () => {
    const {positions} = parseOBJTris(
      ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vt 0 0', 'vn 0 0 1', 'f -3/1/1 -2/1/1 -1/1/1'].join('\n')
    )

    expect(positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
  })

  test('drops faces left with fewer than three distinct verts', () => {
    const {positions} = parseOBJTris(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 2', 'f 1 2 3'].join('\n'))

    expect(positions.length).toBe(9)
  })

  test('ignores comments, object groups and material lines', () => {
    const {positions} = parseOBJTris(
      [
        '# comment',
        'mtllib arrow.mtl',
        'o Cylinder.002',
        'usemtl None',
        's off',
        'v 0 0 0',
        'v 1 0 0',
        'v 0 1 0',
        'f 1 2 3',
      ].join('\r\n')
    )

    expect(positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
  })
})
