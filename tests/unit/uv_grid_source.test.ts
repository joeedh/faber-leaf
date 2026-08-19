/**
 * The in-memory `IUVSource` double (P18 §5 step 2, implementor #3): the shared
 * conformance suite, plus the two things only this implementor can prove —
 * that a source needs no geometry object behind it, and that owners are not
 * required to be the elements themselves.
 */

import {runUVSourceConformance, csrRow} from '../lib/uv_source_conformance'
import {UVGridSource} from '../lib/uv_grid_source'
import {ElementDomain, UVFlags} from '../../scripts/core/geometry_contract'

runUVSourceConformance('UVGridSource', {
  make: () => new UVGridSource({w: 3, h: 2, layers: ['UVMap', 'UVMap.001']}),
})

describe('UVGridSource', () => {
  test('addresses UVs by corner while owning them by vertex', () => {
    const grid = new UVGridSource({w: 2, h: 2})
    expect(grid.uvDomain).toBe(ElementDomain.CORNER)

    const elems = grid.listUVElements(0)
    expect(elems.length).toBe(2 * 2 * 4)

    // The interior vertex of a 2×2 grid is shared by all four quads, so its
    // owner appears four times — the many-to-one case LeafMesh cannot show.
    const owners = Array.from(grid.getUVOwners(0, elems))
    const counts = new Map<number, number>()
    for (const o of owners) {
      counts.set(o, (counts.get(o) ?? 0) + 1)
    }
    expect(Math.max(...counts.values())).toBe(4)
    expect(new Set(owners).size).toBe(9)
  })

  test('a shared vertex is one fan until its corners are moved apart', () => {
    const grid = new UVGridSource({w: 2, h: 2})
    const elems = grid.listUVElements(0)
    const owners = grid.getUVOwners(0, elems)

    const centre = 1 * 3 + 1
    const atCentre = Array.from(elems).filter((_, i) => owners[i] === centre)
    expect(atCentre.length).toBe(4)

    expect(csrRow(grid.getUVFans(0, Int32Array.from([atCentre[0]])), 0).sort()).toEqual([...atCentre].sort())

    // Cutting a seam is a UV write, not a topology edit: the fan splits and no
    // handle goes stale.
    grid.setUVs(0, Int32Array.from([atCentre[0]]), Float32Array.from([0.9, 0.9]))
    expect(csrRow(grid.getUVFans(0, Int32Array.from([atCentre[0]])), 0)).toEqual([atCentre[0]])
    expect(csrRow(grid.getUVFans(0, Int32Array.from([atCentre[1]])), 0).sort()).toEqual(atCentre.slice(1).sort())
  })

  test('layers hold independent coordinates and flags', () => {
    const grid = new UVGridSource({w: 1, h: 1, layers: ['a', 'b']})
    expect(grid.listUVLayers()).toEqual(['a', 'b'])

    const elems = grid.listUVElements(0)
    grid.setUVs(0, elems.subarray(0, 1), Float32Array.from([5, 6]))
    grid.setUVFlags(0, elems.subarray(0, 1), Uint8Array.from([UVFlags.PIN]))

    expect(Array.from(grid.getUVs(1, elems.subarray(0, 1)))).not.toEqual([5, 6])
    expect(grid.getUVFlags(1, elems.subarray(0, 1))[0]).toBe(0)

    grid.setActiveUVLayer(1)
    expect(grid.activeUVLayer).toBe(1)
  })

  test('selectedFacesOnly is answered by the source, not by the caller', () => {
    const grid = new UVGridSource({w: 3, h: 3})
    expect(grid.listUVFaces(0, false).length).toBe(9)
    expect(grid.listUVFaces(0, true).length).toBe(0)

    grid.setSelectedFaces([0, 4, 8])
    expect(Array.from(grid.listUVFaces(0, true))).toEqual([0, 4, 8])
    expect(grid.listUVFaces(0, false).length).toBe(9)
  })

  test('topoStamp only moves when the source says topology did', () => {
    const grid = new UVGridSource({w: 1, h: 1})
    const before = grid.topoStamp

    grid.setUVs(0, grid.listUVElements(0).subarray(0, 1), Float32Array.from([0, 0]))
    expect(grid.topoStamp).toBe(before)

    grid.bumpTopoStamp()
    expect(grid.topoStamp).toBeGreaterThan(before)
  })
})
