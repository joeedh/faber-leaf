/**
 * Runs the `IUVSource` conformance suite against the LiteMesh provider inside
 * the running app — P18 §5 step 2, implementor #2.
 *
 * It cannot be a jest test: the provider is an addon module, addon modules
 * import `@framework/api`, and jest resolves no such specifier. So the rules
 * live in `scripts/core/uv_source_conformance.ts` (jest-free) and this exposes
 * `globalThis.__uvsourceLiteMesh()`, which the NW.js harness drives from
 * `--eval` and reports through `--dump` (see
 * `tests/integration/uv_source_conformance.test.ts`).
 *
 * Each case gets a mesh of its own — half of them write — and every mesh is
 * freed afterwards, because a LiteMesh owns C++ allocations that no GC reaches.
 *
 * Pulled in as a side-effect import from `litemesh_test_scene.ts`.
 */

import {recordUVConformance, registerUVSourceFixture, weldFirstOwner} from '@framework/api'
import type {IUVSource, UVConformanceResult} from '@framework/api'
import {getWasmImmediate} from '@sculptcore/api/api'

import {LiteMesh} from './litemesh'
import {LITEMESH_UV_PROVIDER} from './uv_source.js'

/**
 * A fresh UV-carrying cube and its source. Seaming every edge gives a per-face
 * chart, which is the deterministic unwrap the attr-test scene already relies
 * on; `weldFirstOwner` then re-welds one vertex so the fan cases have a fan.
 */
function makeSource(built: LiteMesh[]): IUVSource {
  const wasm = getWasmImmediate()
  if (!wasm) {
    throw new Error('sculptcore is not loaded')
  }

  const lm = new LiteMesh(wasm.Mesh_createCube(2, 1.0, 0.0))
  built.push(lm)

  lm.markAllSeams()
  lm.generateUVFromSeams()

  const source = LITEMESH_UV_PROVIDER.resolve(lm)
  if (!source) {
    throw new Error('LITEMESH_UV_PROVIDER did not resolve a LiteMesh')
  }

  weldFirstOwner(source, source.activeUVLayer)
  return source
}

/** Run the suite; the result also lands on `globalThis.__uvsourceResult`. */
function runLiteMeshUVConformance(): UVConformanceResult {
  const built: LiteMesh[] = []
  try {
    return recordUVConformance('litemesh', () => makeSource(built))
  } finally {
    for (const lm of built) {
      try {
        lm.destroy()
      } catch {
        /* a fixture that failed to build may be half-constructed */
      }
    }
  }
}

/**
 * The same cube offered to the unwrap parity check — P19 §5 step 7. It is
 * `makeSource` without the fan weld: welding one vertex is a conformance
 * concern, and an unwrap wants the plain per-face chart, whose islands are what
 * the solver and the packer are handed.
 */
registerUVSourceFixture('litemesh', () => {
  const wasm = getWasmImmediate()
  if (!wasm) {
    throw new Error('sculptcore is not loaded')
  }

  const lm = new LiteMesh(wasm.Mesh_createCube(2, 1.0, 0.0))
  const dispose = () => lm.destroy()

  try {
    lm.markAllSeams()
    lm.generateUVFromSeams()

    const source = LITEMESH_UV_PROVIDER.resolve(lm)
    if (!source) {
      throw new Error('LITEMESH_UV_PROVIDER did not resolve a LiteMesh')
    }
    return {source, dispose}
  } catch (e) {
    dispose()
    throw e
  }
})

;(globalThis as {__uvsourceLiteMesh?: typeof runLiteMeshUVConformance}).__uvsourceLiteMesh =
  runLiteMeshUVConformance

export {runLiteMeshUVConformance}
