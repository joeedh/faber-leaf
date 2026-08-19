/**
 * The UV editor, driven headlessly — P18 §6 criterion 3.
 *
 * The source under the editor is `UVGridSource`: a grid of quads with no
 * geometry object, no engine and no draw path. Everything the editor does has
 * to work against that, which is what proves the behaviour lives in the
 * contract rather than in one mesh's storage. This suite is also the reason
 * the core takes only a type import from the host — jest resolves no
 * `@framework/api`, and a value import here would end the whole arrangement.
 */

import {
  UV_PIN,
  UV_SELECT,
  applyUVFlag,
  applyUVRotate,
  applyUVScale,
  applyUVTranslate,
  buildUVDrawGeometry,
  gatherUVTransData,
  listSelectedUVs,
  pickNearestUV,
  restoreUVCoords,
  restoreUVFlags,
  restoreUVTransData,
  ringElements,
  readUVRings,
  selectAllUVs,
  selectLinkedUV,
  selectOneUV,
  snapshotUVCoords,
  snapshotUVFlags,
  uvIslandOf,
  uvIslands,
} from '../../../addons/builtin/uv_editor/src/uv_edit_geom'
import {UVFlags, UVGridSource} from '../../lib/uv_grid_source'

/** A 2×2 grid: 4 faces, 16 corners, 9 owning vertices. */
function grid(w = 2, h = 2): UVGridSource {
  return new UVGridSource({w, h})
}

function uvOf(source: UVGridSource, handle: number): [number, number] {
  const uv = source.getUVs(0, Int32Array.from([handle]))
  return [uv[0], uv[1]]
}

describe('the contract constants', () => {
  // The core cannot import UVFlags — it is a value, and a value import would
  // make the whole editor unrunnable here. So it restates the bits, and this
  // is what stops the two copies drifting.
  test('mirror the host enum exactly', () => {
    expect(UV_SELECT).toBe(UVFlags.SELECT)
    expect(UV_PIN).toBe(UVFlags.PIN)
  })
})

describe('draw geometry', () => {
  test('covers every face ring, with one point per distinct element', () => {
    const source = grid()
    const geom = buildUVDrawGeometry(source, 0)

    // 4 faces × 4 corners, each corner its own element on this source.
    expect(geom.handles.length).toBe(16)
    expect(geom.points.length).toBe(32)
    expect(geom.flags.length).toBe(16)

    // A closed ring of n corners is n segments, 4 floats each.
    expect(geom.edges.length).toBe(4 * 4 * 4)
    expect(geom.topoStamp).toBe(source.topoStamp)
  })

  test('every point is the UV the source reports for its handle', () => {
    const source = grid()
    const geom = buildUVDrawGeometry(source, 0)
    const uv = source.getUVs(0, geom.handles)

    expect(Array.from(geom.points)).toEqual(Array.from(uv))
  })

  test('each segment ends where the next begins, so the ring is closed', () => {
    const source = grid(1, 1)
    const geom = buildUVDrawGeometry(source, 0)

    for (let s = 0; s < 4; s++) {
      const next = (s + 1) % 4
      expect(geom.edges[s * 4 + 2]).toBe(geom.edges[next * 4])
      expect(geom.edges[s * 4 + 3]).toBe(geom.edges[next * 4 + 1])
    }
  })

  test('selectedFacesOnly narrows what is drawn', () => {
    const source = grid()
    source.setSelectedFaces([0])

    const all = buildUVDrawGeometry(source, 0)
    const some = buildUVDrawGeometry(source, 0, {selectedFacesOnly: true})

    expect(all.handles.length).toBe(16)
    expect(some.handles.length).toBe(4)
  })

  test('reports flags alongside the points, so pins can be drawn', () => {
    const source = grid()
    const rings = readUVRings(source, 0)
    const one = ringElements(rings).subarray(0, 1)

    applyUVFlag(source, 0, one, UV_PIN, 'set')

    const geom = buildUVDrawGeometry(source, 0)
    const at = geom.handles.indexOf(one[0])

    expect(geom.flags[at] & UV_PIN).toBe(UV_PIN)
  })
})

describe('picking', () => {
  test('returns nothing when the cursor is outside the limit', () => {
    expect(pickNearestUV(grid(), 0, 5, 5, {limit: 0.1})).toEqual([])
  })

  test('nearest first', () => {
    const source = grid()
    const hits = pickNearestUV(source, 0, 0.02, 0.02)

    expect(hits.length).toBeGreaterThan(0)
    expect(uvOf(source, hits[0].handle)).toEqual([0, 0])

    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].dist).toBeGreaterThanOrEqual(hits[0].dist)
    }
  })

  test('coincident elements come back top-most first', () => {
    const source = grid()

    // The grid's interior vertex is shared by four faces, so four corners sit
    // on one UV — the stack picking has to be able to walk.
    const hits = pickNearestUV(source, 0, 0.5, 0.5, {limit: 0.05})
    expect(hits.length).toBe(4)

    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].z).toBeLessThan(hits[i - 1].z)
    }
  })

  test('a near-tie prefers the unselected element, so a stack can be worked through', () => {
    const source = grid()
    const stacked = pickNearestUV(source, 0, 0.5, 0.5, {limit: 0.05}).map((h) => h.handle)

    // Move one of the four apart by more than the snap limit but keep it the
    // same distance from the cursor, so only the selection rule can order them.
    source.setUVs(0, Int32Array.from([stacked[0]]), Float32Array.from([0.5 + 0.01, 0.5]))
    source.setUVs(0, Int32Array.from([stacked[1]]), Float32Array.from([0.5 - 0.01, 0.5]))
    applyUVFlag(source, 0, Int32Array.from([stacked[0]]), UV_SELECT, 'set')

    const hits = pickNearestUV(source, 0, 0.5, 0.5, {limit: 0.05})
    const a = hits.findIndex((h) => h.handle === stacked[0])
    const b = hits.findIndex((h) => h.handle === stacked[1])

    expect(b).toBeLessThan(a)
  })

  test('honours selectedFacesOnly', () => {
    const source = grid()
    source.setSelectedFaces([3])

    expect(pickNearestUV(source, 0, 0, 0, {limit: 0.05, selectedFacesOnly: true})).toEqual([])
    expect(pickNearestUV(source, 0, 0, 0, {limit: 0.05}).length).toBe(1)
  })
})

describe('flags', () => {
  test('set, clear and toggle', () => {
    const source = grid()
    const two = ringElements(readUVRings(source, 0)).subarray(0, 2)

    applyUVFlag(source, 0, two, UV_PIN, 'set')
    expect(Array.from(source.getUVFlags(0, two))).toEqual([UV_PIN, UV_PIN])

    applyUVFlag(source, 0, two, UV_PIN, 'toggle')
    expect(Array.from(source.getUVFlags(0, two))).toEqual([0, 0])

    applyUVFlag(source, 0, two, UV_SELECT | UV_PIN, 'set')
    applyUVFlag(source, 0, two, UV_PIN, 'clear')
    expect(Array.from(source.getUVFlags(0, two))).toEqual([UV_SELECT, UV_SELECT])
  })

  test('a zero flag is a no-op rather than a wipe', () => {
    const source = grid()
    const two = ringElements(readUVRings(source, 0)).subarray(0, 2)

    applyUVFlag(source, 0, two, UV_PIN, 'set')
    applyUVFlag(source, 0, two, 0, 'set')

    expect(Array.from(source.getUVFlags(0, two))).toEqual([UV_PIN, UV_PIN])
  })

  test('a snapshot restores exactly what was there', () => {
    const source = grid()
    const snap = snapshotUVFlags(source, 0)

    selectAllUVs(source, 0, 'add')
    expect(listSelectedUVs(source, 0).length).toBe(16)

    expect(restoreUVFlags(source, 0, snap)).toBe(true)
    expect(listSelectedUVs(source, 0).length).toBe(0)
  })

  test('a stale snapshot is refused, not written through', () => {
    const source = grid()
    const snap = snapshotUVFlags(source, 0)

    selectAllUVs(source, 0, 'add')
    source.bumpTopoStamp()

    expect(restoreUVFlags(source, 0, snap)).toBe(false)
    expect(listSelectedUVs(source, 0).length).toBe(16)
  })
})

describe('selection', () => {
  test('auto selects everything when nothing is selected, and clears otherwise', () => {
    const source = grid()

    selectAllUVs(source, 0, 'auto')
    expect(listSelectedUVs(source, 0).length).toBe(16)

    selectAllUVs(source, 0, 'auto')
    expect(listSelectedUVs(source, 0).length).toBe(0)
  })

  test('sub clears even from a mixed selection, where auto would too', () => {
    const source = grid()
    const one = ringElements(readUVRings(source, 0)).subarray(0, 1)

    selectOneUV(source, 0, one, 'add')
    selectAllUVs(source, 0, 'sub')

    expect(listSelectedUVs(source, 0).length).toBe(0)
  })

  test('unique replaces the selection; add and sub do not', () => {
    const source = grid()
    const elems = ringElements(readUVRings(source, 0))
    const a = elems.subarray(0, 1)
    const b = elems.subarray(1, 2)

    selectOneUV(source, 0, a, 'unique')
    expect(Array.from(listSelectedUVs(source, 0))).toEqual([a[0]])

    selectOneUV(source, 0, b, 'unique')
    expect(Array.from(listSelectedUVs(source, 0))).toEqual([b[0]])

    selectOneUV(source, 0, a, 'add')
    expect(listSelectedUVs(source, 0).length).toBe(2)

    selectOneUV(source, 0, a, 'sub')
    expect(Array.from(listSelectedUVs(source, 0))).toEqual([b[0]])
  })

  test('unique clears only within scope', () => {
    const source = grid()
    source.setSelectedFaces([0])

    selectAllUVs(source, 0, 'add')

    const inFace0 = source.getUVFaceRings(0, Int32Array.from([0])).values.subarray(0, 1)
    selectOneUV(source, 0, inFace0, 'unique', {selectedFacesOnly: true})

    // Face 0's four corners were cleared and one re-selected; the twelve
    // outside the scope were never touched.
    expect(listSelectedUVs(source, 0).length).toBe(13)
  })
})

describe('islands', () => {
  test('a flat grid is one island, because its corners are welded', () => {
    const islands = uvIslands(grid(), 0)
    expect(islands.offsets.length - 1).toBe(1)
    expect(islands.values.length).toBe(16)
  })

  test('pulling a face off its neighbours splits the island in two', () => {
    const source = grid()
    const ring = source.getUVFaceRings(0, Int32Array.from([0]))
    const corners = ring.values.subarray(0, 4)

    const moved = new Float32Array(8)
    for (let i = 0; i < 4; i++) {
      moved[i * 2] = 5 + i * 0.1
      moved[i * 2 + 1] = 5
    }
    source.setUVs(0, corners, moved)

    const islands = uvIslands(source, 0)
    expect(islands.offsets.length - 1).toBe(2)
    expect(uvIslandOf(source, 0, corners[0], {}).length).toBe(4)
  })

  test('select linked takes the whole island and nothing else', () => {
    const source = grid()
    const corners = source.getUVFaceRings(0, Int32Array.from([0])).values.subarray(0, 4)

    const moved = new Float32Array(8)
    for (let i = 0; i < 4; i++) {
      moved[i * 2] = 5 + i * 0.1
      moved[i * 2 + 1] = 5
    }
    source.setUVs(0, corners, moved)

    const got = selectLinkedUV(source, 0, corners[0])
    expect(got.length).toBe(4)
    expect(listSelectedUVs(source, 0).length).toBe(4)

    selectLinkedUV(source, 0, corners[0], 'sub')
    expect(listSelectedUVs(source, 0).length).toBe(0)
  })

  test('an out-of-scope seed yields no island rather than throwing', () => {
    const source = grid()
    source.setSelectedFaces([0])

    const far = source.getUVFaceRings(0, Int32Array.from([3])).values[0]
    expect(uvIslandOf(source, 0, far, {selectedFacesOnly: true}).length).toBe(0)
  })
})

describe('transform', () => {
  test('gathers only the selection, at full weight, with the bounds midpoint as pivot', () => {
    const source = grid()
    const corners = source.getUVFaceRings(0, Int32Array.from([0])).values.subarray(0, 4)

    selectOneUV(source, 0, corners, 'unique')

    const td = gatherUVTransData(source, 0)
    expect(td.handles.length).toBe(4)
    expect(Array.from(td.weights)).toEqual([1, 1, 1, 1])

    // Face 0 spans [0,0]..[0.5,0.5] on a 2×2 grid.
    expect(td.center[0]).toBeCloseTo(0.25)
    expect(td.center[1]).toBeCloseTo(0.25)
  })

  test('translate moves the selection and leaves the rest alone', () => {
    const source = grid()
    const corners = source.getUVFaceRings(0, Int32Array.from([0])).values.subarray(0, 4)
    const outside = source.getUVFaceRings(0, Int32Array.from([3])).values[0]
    const before = uvOf(source, outside)

    selectOneUV(source, 0, corners, 'unique')
    const td = gatherUVTransData(source, 0)

    expect(applyUVTranslate(source, 0, td, 0.25, -0.5)).toBe(true)

    const moved = source.getUVs(0, td.handles)
    for (let i = 0; i < td.handles.length; i++) {
      expect(moved[i * 2]).toBeCloseTo(td.start[i * 2] + 0.25)
      expect(moved[i * 2 + 1]).toBeCloseTo(td.start[i * 2 + 1] - 0.5)
    }
    expect(uvOf(source, outside)).toEqual(before)
  })

  test('a drag re-applies from the start, so it does not accumulate', () => {
    const source = grid()
    selectAllUVs(source, 0, 'add')

    const td = gatherUVTransData(source, 0)
    applyUVTranslate(source, 0, td, 0.1, 0.1)
    applyUVTranslate(source, 0, td, 0.3, 0.3)

    const uv = source.getUVs(0, td.handles)
    expect(uv[0]).toBeCloseTo(td.start[0] + 0.3)
    expect(uv[1]).toBeCloseTo(td.start[1] + 0.3)
  })

  test('scale is about the pivot, so the pivot itself does not move', () => {
    const source = grid()
    selectAllUVs(source, 0, 'add')

    const td = gatherUVTransData(source, 0)
    expect(applyUVScale(source, 0, td, 2, 2)).toBe(true)

    const uv = source.getUVs(0, td.handles)
    for (let i = 0; i < td.handles.length; i++) {
      expect(uv[i * 2]).toBeCloseTo((td.start[i * 2] - 0.5) * 2 + 0.5)
      expect(uv[i * 2 + 1]).toBeCloseTo((td.start[i * 2 + 1] - 0.5) * 2 + 0.5)
    }
  })

  test('a quarter turn takes the corner at the origin to the opposite one', () => {
    const source = grid()
    selectAllUVs(source, 0, 'add')

    const td = gatherUVTransData(source, 0)
    const at = td.handles.indexOf(pickNearestUV(source, 0, 0, 0, {limit: 0.01})[0].handle)

    expect(applyUVRotate(source, 0, td, Math.PI / 2)).toBe(true)

    const uv = source.getUVs(0, td.handles)
    expect(uv[at * 2]).toBeCloseTo(1)
    expect(uv[at * 2 + 1]).toBeCloseTo(0)
  })

  test('restore puts the gathered UVs back', () => {
    const source = grid()
    selectAllUVs(source, 0, 'add')

    const td = gatherUVTransData(source, 0)
    applyUVTranslate(source, 0, td, 3, 3)
    expect(restoreUVTransData(source, 0, td)).toBe(true)

    expect(Array.from(source.getUVs(0, td.handles))).toEqual(Array.from(td.start))
  })

  test('a coordinate snapshot restores only the handles it holds', () => {
    const source = grid()
    const moved = Int32Array.from([0, 1])
    const before = Array.from(source.getUVs(0, moved))

    const snap = snapshotUVCoords(source, 0, moved)

    selectAllUVs(source, 0, 'add')
    applyUVTranslate(source, 0, gatherUVTransData(source, 0), 0.5, 0.5)

    const untouched = Int32Array.from([2])
    const shifted = Array.from(source.getUVs(0, untouched))

    expect(restoreUVCoords(source, 0, snap)).toBe(true)
    expect(Array.from(source.getUVs(0, moved))).toEqual(before)
    expect(Array.from(source.getUVs(0, untouched))).toEqual(shifted)
  })

  test('a stale coordinate snapshot is refused, not written through', () => {
    const source = grid()
    const handles = Int32Array.from([0, 1])
    const snap = snapshotUVCoords(source, 0, handles)

    applyUVTranslate(source, 0, gatherUVTransData(source, 0, {}), 0, 0)
    source.setUVs(0, handles, Float32Array.from([9, 9, 9, 9]))
    source.bumpTopoStamp()

    expect(restoreUVCoords(source, 0, snap)).toBe(false)
    expect(Array.from(source.getUVs(0, handles))).toEqual([9, 9, 9, 9])
  })

  test('a transform whose handles went stale is refused', () => {
    const source = grid()
    selectAllUVs(source, 0, 'add')

    const td = gatherUVTransData(source, 0)
    source.bumpTopoStamp()

    expect(applyUVTranslate(source, 0, td, 1, 1)).toBe(false)
    expect(Array.from(source.getUVs(0, td.handles))).toEqual(Array.from(td.start))
  })

  test('proportional editing drags unselected neighbours by a falling weight', () => {
    const source = grid(4, 4)
    const corner = pickNearestUV(source, 0, 0, 0, {limit: 0.01})[0].handle

    selectOneUV(source, 0, Int32Array.from([corner]), 'unique')

    const plain = gatherUVTransData(source, 0)
    expect(plain.handles.length).toBe(1)

    const td = gatherUVTransData(source, 0, {
      prop: {enabled: true, radius: 0.6, falloff: (t) => t},
    })

    expect(td.handles.length).toBeGreaterThan(1)
    expect(td.weights[0]).toBe(1)

    // Weight falls off with distance from the one selected element.
    const uv = source.getUVs(0, td.handles)
    for (let i = 1; i < td.handles.length; i++) {
      const d = Math.hypot(uv[i * 2], uv[i * 2 + 1])
      expect(td.weights[i]).toBeCloseTo(1 - d / 0.6)
    }
  })

  test('proportional weights scale the move, so an outer element lags', () => {
    const source = grid(4, 4)
    const corner = pickNearestUV(source, 0, 0, 0, {limit: 0.01})[0].handle

    selectOneUV(source, 0, Int32Array.from([corner]), 'unique')
    const td = gatherUVTransData(source, 0, {prop: {enabled: true, radius: 0.6, falloff: (t) => t}})

    applyUVTranslate(source, 0, td, 1, 0)
    const uv = source.getUVs(0, td.handles)

    for (let i = 0; i < td.handles.length; i++) {
      expect(uv[i * 2]).toBeCloseTo(td.start[i * 2] + td.weights[i])
    }
  })

  test('island-only falloff does not reach across a seam', () => {
    const source = grid()
    const corners = source.getUVFaceRings(0, Int32Array.from([0])).values.subarray(0, 4)

    // Park face 0 next to the rest but unwelded from it, so distance alone
    // would pull its corners in and only the island rule can hold them back.
    const moved = new Float32Array(8)
    for (let i = 0; i < 4; i++) {
      moved[i * 2] = 0.02 * i
      moved[i * 2 + 1] = 0.02
    }
    source.setUVs(0, corners, moved)

    const outside = source.getUVFaceRings(0, Int32Array.from([3])).values
    selectOneUV(source, 0, outside, 'unique')

    const loose = gatherUVTransData(source, 0, {prop: {enabled: true, radius: 2}})
    const tight = gatherUVTransData(source, 0, {prop: {enabled: true, radius: 2, islandOnly: true}})

    expect(Array.from(loose.handles)).toEqual(expect.arrayContaining([corners[0]]))
    expect(Array.from(tight.handles)).not.toEqual(expect.arrayContaining([corners[0]]))
  })
})

describe('the selectedFacesOnly scope', () => {
  // Step 6's point: the flag is an op input, so every entry point has to honour
  // it, not just the one that draws. A partial selection is what tells a scope
  // that works from one that is quietly a no-op.
  const partial = (): UVGridSource => {
    const source = grid()
    source.setSelectedFaces([0, 3])
    return source
  }

  test('select-all writes inside the scope and nowhere else', () => {
    const source = partial()
    const wrote = selectAllUVs(source, 0, 'add', {selectedFacesOnly: true})

    expect(wrote.length).toBe(8)
    expect(listSelectedUVs(source, 0).length).toBe(8)

    // Unscoped, the same call reaches the whole layer — the two differ, which
    // is the regression the archived hardcoded filter made untestable.
    selectAllUVs(source, 0, 'add')
    expect(listSelectedUVs(source, 0).length).toBe(16)
  })

  test('auto toggles on what is in scope, ignoring a selection outside it', () => {
    const source = partial()

    selectAllUVs(source, 0, 'add')
    selectAllUVs(source, 0, 'sub', {selectedFacesOnly: true})
    expect(listSelectedUVs(source, 0).length).toBe(8)

    // Eight elements are still selected, all of them out of scope. Auto has to
    // read that as "nothing selected here" and select, not deselect.
    selectAllUVs(source, 0, 'auto', {selectedFacesOnly: true})
    expect(listSelectedUVs(source, 0).length).toBe(16)
  })

  test('a scoped flag snapshot restores its own faces and leaves the rest alone', () => {
    const source = partial()
    const snap = snapshotUVFlags(source, 0, {selectedFacesOnly: true})

    expect(snap.handles.length).toBe(8)

    selectAllUVs(source, 0, 'add')
    expect(restoreUVFlags(source, 0, snap)).toBe(true)

    // The eight it captured came back unselected; the eight it never saw kept
    // the selection made after the snapshot.
    expect(listSelectedUVs(source, 0).length).toBe(8)
    expect(listSelectedUVs(source, 0, {selectedFacesOnly: true}).length).toBe(0)
  })

  test('a transform gathers only the selected elements that are in scope', () => {
    const source = partial()
    selectAllUVs(source, 0, 'add')

    expect(gatherUVTransData(source, 0).handles.length).toBe(16)
    expect(gatherUVTransData(source, 0, {selectedFacesOnly: true}).handles.length).toBe(8)
  })

  test('with no face selected at all, a scoped op is a no-op', () => {
    const source = grid()
    source.setSelectedFaces([])

    expect(selectAllUVs(source, 0, 'add', {selectedFacesOnly: true}).length).toBe(0)
    expect(listSelectedUVs(source, 0).length).toBe(0)
    expect(snapshotUVFlags(source, 0, {selectedFacesOnly: true}).handles.length).toBe(0)
    expect(gatherUVTransData(source, 0, {selectedFacesOnly: true}).handles.length).toBe(0)
  })
})

describe('an empty or absent layer', () => {
  test('draws nothing rather than throwing', () => {
    const geom = buildUVDrawGeometry(grid(), 99)

    expect(geom.handles.length).toBe(0)
    expect(geom.edges.length).toBe(0)
  })

  test('answers every query with an empty result', () => {
    const source = grid()

    expect(pickNearestUV(source, 99, 0, 0)).toEqual([])
    expect(selectAllUVs(source, 99).length).toBe(0)
    expect(listSelectedUVs(source, 99).length).toBe(0)
    expect(uvIslands(source, 99).values.length).toBe(0)
    expect(gatherUVTransData(source, 99).handles.length).toBe(0)
  })
})
