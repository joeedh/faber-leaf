/**
 * What every `IUVSource` owes, written once and run against each implementor —
 * P18 §6. The suite may only use the contract: if a case here needs to know
 * which source it is driving, the contract is under-specified and the fix is in
 * `scripts/core/geometry_contract.ts`, not in a branch here.
 *
 * `makeSource` returns a fresh source per case, because half of these write.
 */

import type {ElementHandles, IUVSource} from '../../scripts/core/geometry_contract'
import {UVFlags} from '../../scripts/core/geometry_contract'

export interface UVConformanceCase {
  /** A source with at least one UV layer and at least one face. */
  make(): IUVSource
}

/** CSR row `i` as a plain array. */
export function csrRow(csr: {offsets: Int32Array; values: Int32Array}, i: number): number[] {
  return Array.from(csr.values.subarray(csr.offsets[i], csr.offsets[i + 1]))
}

function handles(source: IUVSource, layer: number): Int32Array {
  return source.listUVElements(layer)
}

export function runUVSourceConformance(name: string, testCase: UVConformanceCase): void {
  describe(`IUVSource conformance: ${name}`, () => {
    let source: IUVSource
    let layer: number

    beforeEach(() => {
      source = testCase.make()
      layer = source.activeUVLayer
    })

    test('reports a layer set the active index indexes into', () => {
      const layers = source.listUVLayers()
      expect(layers.length).toBeGreaterThan(0)
      expect(layer).toBeGreaterThanOrEqual(0)
      expect(layer).toBeLessThan(layers.length)
      expect(typeof layers[layer]).toBe('string')
    })

    test('an out-of-range layer answers empty rather than throwing', () => {
      const bad = source.listUVLayers().length + 4
      expect(source.listUVElements(bad).length).toBe(0)
      expect(source.listUVFaces(bad).length).toBe(0)
      expect(source.getUVFaceRings(bad, Int32Array.from([0])).offsets.length).toBe(2)
      expect(source.getUVFans(bad, Int32Array.from([0])).offsets.length).toBe(2)
    })

    test('elements are distinct and owners are defined for every one', () => {
      const elems = handles(source, layer)
      expect(elems.length).toBeGreaterThan(0)
      expect(new Set(elems).size).toBe(elems.length)

      const owners = source.getUVOwners(layer, elems)
      expect(owners.length).toBe(elems.length)
      for (const o of owners) {
        expect(Number.isInteger(o)).toBe(true)
        expect(o).toBeGreaterThanOrEqual(0)
      }
    })

    test('getUVs is two floats per handle and honours a supplied buffer', () => {
      const elems = handles(source, layer)
      const uv = source.getUVs(layer, elems)
      expect(uv.length).toBe(elems.length * 2)

      // A provider may hand back a view onto `out`, so compare buffers.
      const out = new Float32Array(elems.length * 2)
      const same = source.getUVs(layer, elems, out)
      expect(same.buffer).toBe(out.buffer)
      expect(Array.from(same)).toEqual(Array.from(uv))
      expect(Array.from(out)).toEqual(Array.from(uv))
    })

    test('setUVs round-trips through getUVs', () => {
      const elems = handles(source, layer).subarray(0, 3)
      const want = new Float32Array(elems.length * 2)
      for (let i = 0; i < elems.length; i++) {
        want[i * 2] = 0.25 + i
        want[i * 2 + 1] = 0.75 - i
      }

      source.setUVs(layer, elems, want)
      expect(Array.from(source.getUVs(layer, elems))).toEqual(Array.from(want))
    })

    test('a write touches only the handles it was given', () => {
      const elems = handles(source, layer)
      const before = source.getUVs(layer, elems)

      const one = elems.subarray(0, 1)
      source.setUVs(layer, one, Float32Array.from([9, 9]))

      const after = source.getUVs(layer, elems)
      expect(after[0]).toBe(9)
      expect(after[1]).toBe(9)
      for (let i = 1; i < elems.length; i++) {
        expect(after[i * 2]).toBe(before[i * 2])
        expect(after[i * 2 + 1]).toBe(before[i * 2 + 1])
      }
    })

    test('flags round-trip and default to clear', () => {
      const elems = handles(source, layer)
      expect(Array.from(source.getUVFlags(layer, elems))).toEqual(new Array(elems.length).fill(0))

      const two = elems.subarray(0, 2)
      source.setUVFlags(layer, two, Uint8Array.from([UVFlags.SELECT, UVFlags.SELECT | UVFlags.PIN]))
      expect(Array.from(source.getUVFlags(layer, two))).toEqual([UVFlags.SELECT, UVFlags.SELECT | UVFlags.PIN])
    })

    test('faces have rings of at least three elements, all of them real', () => {
      const faces = source.listUVFaces(layer)
      expect(faces.length).toBeGreaterThan(0)

      const rings = source.getUVFaceRings(layer, faces)
      expect(rings.offsets.length).toBe(faces.length + 1)
      expect(rings.offsets[0]).toBe(0)
      expect(rings.offsets[faces.length]).toBe(rings.values.length)

      const known = new Set(handles(source, layer))
      for (let i = 0; i < faces.length; i++) {
        const ring = csrRow(rings, i)
        expect(ring.length).toBeGreaterThanOrEqual(3)
        for (const c of ring) {
          expect(known.has(c)).toBe(true)
        }
      }
    })

    test('selectedOnly is a subset, and is empty when nothing is selected', () => {
      const all = new Set(source.listUVFaces(layer, false))
      for (const f of source.listUVFaces(layer, true)) {
        expect(all.has(f)).toBe(true)
      }
    })

    test('a fan contains its own handle and every member shares its UV', () => {
      const elems = handles(source, layer)
      const fans = source.getUVFans(layer, elems)
      expect(fans.offsets.length).toBe(elems.length + 1)

      const uv = source.getUVs(layer, elems)
      const at = new Map<number, number>()
      for (let i = 0; i < elems.length; i++) {
        at.set(elems[i], i)
      }

      for (let i = 0; i < elems.length; i++) {
        const fan = csrRow(fans, i)
        expect(fan).toContain(elems[i])

        for (const c of fan) {
          const j = at.get(c)
          expect(j).toBeDefined()
          expect(uv[j! * 2]).toBeCloseTo(uv[i * 2], 5)
          expect(uv[j! * 2 + 1]).toBeCloseTo(uv[i * 2 + 1], 5)
        }
      }
    })

    test('a fan is symmetric: everything it names names it back', () => {
      const elems = handles(source, layer)
      const fans = source.getUVFans(layer, elems)

      for (let i = 0; i < elems.length; i++) {
        for (const c of csrRow(fans, i)) {
          const back = csrRow(source.getUVFans(layer, Int32Array.from([c])), 0)
          expect(back).toContain(elems[i])
        }
      }
    })

    test('listUVElements filtered by owners is a subset of the unfiltered set', () => {
      const elems = handles(source, layer)
      const owners = source.getUVOwners(layer, elems)
      const some: ElementHandles = Int32Array.from([owners[0]])

      const filtered = source.listUVElements(layer, some)
      expect(filtered.length).toBeGreaterThan(0)

      const all = new Set(elems)
      for (const c of filtered) {
        expect(all.has(c)).toBe(true)
      }

      // Every element it returns is owned by an owner that was asked for.
      for (const o of source.getUVOwners(layer, filtered)) {
        expect(o).toBe(owners[0])
      }
    })

    test('topoStamp is a number and is stable across pure reads', () => {
      const stamp = source.topoStamp
      expect(typeof stamp).toBe('number')
      source.listUVElements(layer)
      source.getUVs(layer, handles(source, layer))
      expect(source.topoStamp).toBe(stamp)
    })
  })
}
