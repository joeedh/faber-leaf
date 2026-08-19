/**
 * What every `IUVSource` owes, as a jest-free checker — P18 §6.
 *
 * It lives beside the contract rather than in `tests/` because two of the three
 * implementors cannot be reached from the unit test workspace: an addon imports
 * the framework through `@framework/api`, which jest does not resolve, so the
 * only way to exercise a real provider is inside the running app. A provider
 * that can only be checked where jest is absent needs a checker that does not
 * need jest.
 *
 * The rules are written once, here. `tests/lib/uv_source_conformance.ts` is a
 * thin jest wrapper over this, and the addon test-support modules call it
 * directly. If a case here needs to know which source it is driving, the
 * contract is under-specified and the fix is in `geometry_contract.ts`, not in
 * a branch below.
 *
 * `make` returns a fresh source per case, because half of these write.
 */

import {UVFlags} from './geometry_contract'
import type {ElementHandles, IUVSource} from './geometry_contract'

export interface UVConformanceResult {
  /** Case names that passed, in order. */
  passed: string[]
  /** `${case}: ${reason}` for each case that did not. Empty means conformant. */
  failures: string[]
}

/**
 * Cases that ask a question per element are capped at this many, because a real
 * mesh answers each one across the engine boundary. Every source small enough
 * to be a test fixture is under the cap, so nothing is skipped in practice.
 */
const PER_ELEMENT_SAMPLE = 64

class Failure extends Error {}

function fail(msg: string): never {
  throw new Failure(msg)
}

function ok(cond: boolean, msg: string): void {
  if (!cond) {
    fail(msg)
  }
}

function eq(got: unknown, want: unknown, what: string): void {
  if (got !== want) {
    fail(`${what}: expected ${String(want)}, got ${String(got)}`)
  }
}

function close(got: number, want: number, what: string): void {
  if (!(Math.abs(got - want) <= 1e-5)) {
    fail(`${what}: expected ~${want}, got ${got}`)
  }
}

/** CSR row `i` as a plain array. */
export function csrRow(csr: {offsets: Int32Array; values: Int32Array}, i: number): number[] {
  return Array.from(csr.values.subarray(csr.offsets[i], csr.offsets[i + 1]))
}

function elementsOf(source: IUVSource, layer: number): Int32Array {
  return source.listUVElements(layer)
}

type Case = (source: IUVSource, layer: number) => void

const CASES: [string, Case][] = [
  [
    'reports a layer set the active index indexes into',
    (source, layer) => {
      const layers = source.listUVLayers()
      ok(layers.length > 0, 'listUVLayers is empty')
      ok(layer >= 0 && layer < layers.length, `activeUVLayer ${layer} is not a layer index`)
      eq(typeof layers[layer], 'string', 'the active layer name')
    },
  ],

  [
    'an out-of-range layer answers empty rather than throwing',
    (source) => {
      const bad = source.listUVLayers().length + 4
      eq(source.listUVElements(bad).length, 0, 'listUVElements on a bad layer')
      eq(source.listUVFaces(bad).length, 0, 'listUVFaces on a bad layer')
      eq(source.getUVFaceRings(bad, Int32Array.from([0])).offsets.length, 2, 'getUVFaceRings offsets on a bad layer')
      eq(source.getUVFans(bad, Int32Array.from([0])).offsets.length, 2, 'getUVFans offsets on a bad layer')
    },
  ],

  [
    'elements are distinct and owners are defined for every one',
    (source, layer) => {
      const elems = elementsOf(source, layer)
      ok(elems.length > 0, 'listUVElements is empty')
      eq(new Set(elems).size, elems.length, 'element handles contain a duplicate')

      const owners = source.getUVOwners(layer, elems)
      eq(owners.length, elems.length, 'getUVOwners length')
      for (let i = 0; i < owners.length; i++) {
        ok(Number.isInteger(owners[i]) && owners[i] >= 0, `owner of element ${elems[i]} is ${owners[i]}`)
      }
    },
  ],

  [
    'getUVs is two floats per handle and honours a supplied buffer',
    (source, layer) => {
      const elems = elementsOf(source, layer)
      const uv = source.getUVs(layer, elems)
      eq(uv.length, elems.length * 2, 'getUVs length')

      // A provider may hand back a view onto `out`, so compare buffers.
      const out = new Float32Array(elems.length * 2)
      const same = source.getUVs(layer, elems, out)
      ok(same.buffer === out.buffer, 'getUVs ignored the supplied buffer')
      for (let i = 0; i < uv.length; i++) {
        eq(same[i], uv[i], `getUVs into a buffer differs at ${i}`)
        eq(out[i], uv[i], `the supplied buffer was not written at ${i}`)
      }
    },
  ],

  [
    'setUVs round-trips through getUVs',
    (source, layer) => {
      const elems = elementsOf(source, layer).subarray(0, 3)
      const want = new Float32Array(elems.length * 2)
      for (let i = 0; i < elems.length; i++) {
        want[i * 2] = 0.25 + i
        want[i * 2 + 1] = 0.75 - i
      }

      source.setUVs(layer, elems, want)
      const got = source.getUVs(layer, elems)
      for (let i = 0; i < want.length; i++) {
        close(got[i], want[i], `setUVs round-trip at ${i}`)
      }
    },
  ],

  [
    'a write touches only the handles it was given',
    (source, layer) => {
      const elems = elementsOf(source, layer)
      const before = Float32Array.from(source.getUVs(layer, elems))

      source.setUVs(layer, elems.subarray(0, 1), Float32Array.from([9, 9]))

      const after = source.getUVs(layer, elems)
      close(after[0], 9, 'the written u')
      close(after[1], 9, 'the written v')
      for (let i = 1; i < elems.length; i++) {
        eq(after[i * 2], before[i * 2], `element ${elems[i]} u changed`)
        eq(after[i * 2 + 1], before[i * 2 + 1], `element ${elems[i]} v changed`)
      }
    },
  ],

  [
    'flags round-trip and default to clear',
    (source, layer) => {
      const elems = elementsOf(source, layer)
      const initial = source.getUVFlags(layer, elems)
      for (let i = 0; i < elems.length; i++) {
        eq(initial[i], 0, `element ${elems[i]} starts with flags set`)
      }

      const two = elems.subarray(0, 2)
      source.setUVFlags(layer, two, Uint8Array.from([UVFlags.SELECT, UVFlags.SELECT | UVFlags.PIN]))

      const got = source.getUVFlags(layer, two)
      eq(got[0], UVFlags.SELECT, 'the first flag write')
      eq(got[1], UVFlags.SELECT | UVFlags.PIN, 'the second flag write')
    },
  ],

  [
    'faces have rings of at least three elements, all of them real',
    (source, layer) => {
      const faces = source.listUVFaces(layer)
      ok(faces.length > 0, 'listUVFaces is empty')

      const rings = source.getUVFaceRings(layer, faces)
      eq(rings.offsets.length, faces.length + 1, 'getUVFaceRings offsets length')
      eq(rings.offsets[0], 0, 'getUVFaceRings offsets[0]')
      eq(rings.offsets[faces.length], rings.values.length, 'getUVFaceRings final offset')

      const known = new Set(elementsOf(source, layer))
      for (let i = 0; i < faces.length; i++) {
        const ring = csrRow(rings, i)
        ok(ring.length >= 3, `face ${faces[i]} has a ring of ${ring.length}`)
        for (const c of ring) {
          ok(known.has(c), `face ${faces[i]} names element ${c}, which listUVElements does not`)
        }
      }
    },
  ],

  [
    'selectedOnly is a subset of the unfiltered faces',
    (source, layer) => {
      const all = new Set(source.listUVFaces(layer, false))
      for (const f of source.listUVFaces(layer, true)) {
        ok(all.has(f), `selected face ${f} is not in the unfiltered set`)
      }
    },
  ],

  [
    'a fan contains its own handle and every member shares its UV',
    (source, layer) => {
      const elems = elementsOf(source, layer)
      const fans = source.getUVFans(layer, elems)
      eq(fans.offsets.length, elems.length + 1, 'getUVFans offsets length')

      const uv = source.getUVs(layer, elems)
      const at = new Map<number, number>()
      for (let i = 0; i < elems.length; i++) {
        at.set(elems[i], i)
      }

      for (let i = 0; i < elems.length; i++) {
        const fan = csrRow(fans, i)
        ok(fan.includes(elems[i]), `the fan of ${elems[i]} does not contain it`)

        for (const c of fan) {
          const j = at.get(c)
          ok(j !== undefined, `the fan of ${elems[i]} names ${c}, which is not an element`)
          close(uv[j! * 2], uv[i * 2], `fan member ${c} u differs from ${elems[i]}`)
          close(uv[j! * 2 + 1], uv[i * 2 + 1], `fan member ${c} v differs from ${elems[i]}`)
        }
      }
    },
  ],

  [
    'a fan is symmetric: everything it names names it back',
    (source, layer) => {
      const elems = elementsOf(source, layer)
      const n = Math.min(elems.length, PER_ELEMENT_SAMPLE)
      const fans = source.getUVFans(layer, elems.subarray(0, n))

      for (let i = 0; i < n; i++) {
        for (const c of csrRow(fans, i)) {
          const back = csrRow(source.getUVFans(layer, Int32Array.from([c])), 0)
          ok(back.includes(elems[i]), `${c} is in the fan of ${elems[i]} but not the reverse`)
        }
      }
    },
  ],

  [
    'listUVElements filtered by owners is a subset of the unfiltered set',
    (source, layer) => {
      const elems = elementsOf(source, layer)
      const owners = source.getUVOwners(layer, elems)
      const some: ElementHandles = Int32Array.from([owners[0]])

      const filtered = source.listUVElements(layer, some)
      ok(filtered.length > 0, `no elements owned by ${owners[0]}`)

      const all = new Set(elems)
      for (const c of filtered) {
        ok(all.has(c), `filtered element ${c} is not in the unfiltered set`)
      }

      // Every element it returns is owned by an owner that was asked for.
      for (const o of source.getUVOwners(layer, filtered)) {
        eq(o, owners[0], 'a filtered element has an owner that was not asked for')
      }
    },
  ],

  [
    'topoStamp is a number and is stable across pure reads',
    (source, layer) => {
      const stamp = source.topoStamp
      eq(typeof stamp, 'number', 'topoStamp type')

      source.listUVElements(layer)
      source.getUVs(layer, elementsOf(source, layer))
      eq(source.topoStamp, stamp, 'topoStamp moved during a read')
    },
  ],
]

/** Every case's name, in run order — for a wrapper that wants one test each. */
export function uvConformanceCaseNames(): string[] {
  return CASES.map(([name]) => name)
}

/** Run one case by name against a fresh source; returns the failure, or null. */
export function checkUVSourceCase(name: string, make: () => IUVSource): string | null {
  const found = CASES.find(([n]) => n === name)
  if (!found) {
    return `${name}: no such conformance case`
  }

  try {
    const source = make()
    found[1](source, source.activeUVLayer)
    return null
  } catch (e) {
    return `${name}: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Run every case, each against its own fresh source. */
export function checkUVSource(make: () => IUVSource): UVConformanceResult {
  const result: UVConformanceResult = {passed: [], failures: []}

  for (const [name] of CASES) {
    const failure = checkUVSourceCase(name, make)
    if (failure === null) {
      result.passed.push(name)
    } else {
      result.failures.push(failure)
    }
  }
  return result
}

/** Where {@link recordUVConformance} leaves its results. */
export interface UVConformanceGlobal {
  __uvsourceResult?: {[source: string]: UVConformanceResult}
}

/**
 * Run the suite and record it under `source` on `globalThis.__uvsourceResult`,
 * which the headless harness's `--dump` reports as `uvsource`. The real
 * providers live in addons and can only run inside the app, so this is how a
 * result gets back out — one protocol, here, rather than one per addon.
 */
export function recordUVConformance(source: string, make: () => IUVSource): UVConformanceResult {
  const result = checkUVSource(make)
  const g = globalThis as UVConformanceGlobal
  if (!g.__uvsourceResult) {
    g.__uvsourceResult = {}
  }
  g.__uvsourceResult[source] = result
  return result
}

/**
 * Fixture shaping, not a rule: give one owner's elements a single shared UV so
 * the fan cases see a fan with more than one member. A per-face unwrap makes
 * every element its own island, and a suite in which every fan is a singleton
 * proves nothing about welding. Call it from a `make()`, not from a case.
 */
export function weldFirstOwner(source: IUVSource, layer: number): void {
  const elems = source.listUVElements(layer)
  if (elems.length === 0) {
    return
  }

  const owner = source.getUVOwners(layer, elems.subarray(0, 1))[0]
  const fan = source.listUVElements(layer, Int32Array.from([owner]))

  const uv = new Float32Array(fan.length * 2)
  for (let i = 0; i < fan.length; i++) {
    uv[i * 2] = 0.125
    uv[i * 2 + 1] = 0.375
  }
  source.setUVs(layer, fan, uv)
}
