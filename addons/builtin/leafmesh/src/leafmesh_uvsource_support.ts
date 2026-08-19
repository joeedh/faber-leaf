/**
 * Runs the `IUVSource` conformance suite against the LeafMesh provider inside
 * the running app — P18 §5 step 2, implementor #1.
 *
 * The provider itself is pure TS and its traversals are unit-tested in
 * `uv_geom.ts`, but the *contract* it claims to satisfy is only checkable
 * through `@framework/api`, which jest does not resolve. So this exposes
 * `globalThis.__uvsourceLeafMesh()`, driven by the NW.js harness from `--eval`
 * and reported through `--dump` — the same route the LiteMesh source takes, so
 * both implementors are held to one suite (see
 * `tests/integration/uv_source_conformance.test.ts`).
 *
 * Pulled in as a side-effect import from `main.ts`.
 */

import {recordUVConformance, weldFirstOwner} from '@framework/api'
import type {IUVSource, UVConformanceResult} from '@framework/api'

import {LeafMeshData} from './leafmesh.js'
import {makeCube} from './primitives.js'
import {LEAFMESH_UV_PROVIDER} from './uv_source.js'
import {ensureUVCoords} from './uv_geom.js'

/**
 * A fresh cube with a `uv` layer. No unwrapper exists yet (§5 step 4's
 * `project_uvs` is still to come), so the charts are synthetic: a distinct UV
 * per corner, which `weldFirstOwner` then partly undoes so the fan cases see a
 * fan with more than one member.
 */
function makeSource(): IUVSource {
  const data = new LeafMeshData()
  makeCube(data.mesh)
  ensureUVCoords(data.mesh, 'uv')

  const source = LEAFMESH_UV_PROVIDER.resolve(data)
  if (!source) {
    throw new Error('LEAFMESH_UV_PROVIDER did not resolve a LeafMeshData')
  }

  const layer = source.activeUVLayer
  const faces = source.listUVFaces(layer)
  const rings = source.getUVFaceRings(layer, faces)

  for (let i = 0; i < faces.length; i++) {
    const ring = rings.values.subarray(rings.offsets[i], rings.offsets[i + 1])
    const uv = new Float32Array(ring.length * 2)
    for (let k = 0; k < ring.length; k++) {
      uv[k * 2] = i * 0.25 + k * 0.05
      uv[k * 2 + 1] = i * 0.125
    }
    source.setUVs(layer, ring, uv)
  }

  weldFirstOwner(source, layer)
  return source
}

/** Run the suite; the result also lands on `globalThis.__uvsourceResult`. */
function runLeafMeshUVConformance(): UVConformanceResult {
  return recordUVConformance('leafmesh', makeSource)
}

;(globalThis as {__uvsourceLeafMesh?: typeof runLeafMeshUVConformance}).__uvsourceLeafMesh =
  runLeafMeshUVConformance

export {runLeafMeshUVConformance}
