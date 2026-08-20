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

import {recordUVConformance, registerUVSourceFixture, weldFirstOwner, withUVSourceFixture} from '@framework/api'
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

  chartPerFace(source, source.activeUVLayer)
  weldFirstOwner(source, source.activeUVLayer)
  return source
}

/**
 * Give every face UVs of its own, so no two faces weld. What the coordinates
 * are does not matter — an unwrap overwrites them from the geometry — but which
 * corners share one decides the islands, and one island per face is what
 * LiteMesh's `markAllSeams` + `generateUVFromSeams` produces.
 */
function chartPerFace(source: IUVSource, layer: number): void {
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
}

/** Run the suite; the result also lands on `globalThis.__uvsourceResult`. */
function runLeafMeshUVConformance(): UVConformanceResult {
  return recordUVConformance('leafmesh', makeSource)
}

/** A fresh quad cube with per-face charts, for the unwrap check — P19 §5 step 7. */
function makeCubeSource(): IUVSource {
  const data = new LeafMeshData()
  makeCube(data.mesh)
  ensureUVCoords(data.mesh, 'uv')

  const source = LEAFMESH_UV_PROVIDER.resolve(data)
  if (!source) {
    throw new Error('LEAFMESH_UV_PROVIDER did not resolve a LeafMeshData')
  }

  chartPerFace(source, source.activeUVLayer)
  return source
}

/**
 * Rebuild `from` as a LeafMesh: same faces, same rings, same positions, same
 * UVs. That is what lets the parity check compare two providers' unwraps
 * directly — LiteMesh is triangles-only and LeafMesh is not, so the only way to
 * hand both the same topology is to copy one into the other.
 *
 * Everything is read through `IUVSource`, so this stays a mirror of the
 * contract rather than of sculptcore.
 */
function mirrorSource(from: IUVSource): IUVSource {
  const layer = from.activeUVLayer
  const positions = from.getUVElementPositions
  if (layer < 0 || positions === undefined) {
    throw new Error('the source to mirror has no UV layer or no positions')
  }

  const faces = from.listUVFaces(layer)
  const rings = from.getUVFaceRings(layer, faces)
  const data = new LeafMeshData()
  const verts = new Map<number, number>()

  for (let i = 0; i < faces.length; i++) {
    const ring = rings.values.subarray(rings.offsets[i], rings.offsets[i + 1])
    const owners = from.getUVOwners(layer, ring)
    const co = positions.call(from, layer, ring)
    const loop: number[] = []

    for (let k = 0; k < ring.length; k++) {
      let v = verts.get(owners[k])
      if (v === undefined) {
        v = data.mesh.makeVert([co[k * 3], co[k * 3 + 1], co[k * 3 + 2]])
        verts.set(owners[k], v)
      }
      loop.push(v)
    }
    data.mesh.makeFace([loop])
  }

  ensureUVCoords(data.mesh, 'uv')

  const source = LEAFMESH_UV_PROVIDER.resolve(data)
  if (!source) {
    throw new Error('LEAFMESH_UV_PROVIDER did not resolve a LeafMeshData')
  }

  copyRings(from, layer, source, source.activeUVLayer)
  return source
}

/**
 * Copy UVs ring by ring, checking as it goes that the two sources really are
 * describing the same corners. Faces come back in creation order today; if that
 * ever stops being true the positions stop lining up, and a parity check built
 * on a silent misalignment would be worse than no check at all.
 */
function copyRings(from: IUVSource, fromLayer: number, to: IUVSource, toLayer: number): void {
  const src = from.getUVFaceRings(fromLayer, from.listUVFaces(fromLayer))
  const dst = to.getUVFaceRings(toLayer, to.listUVFaces(toLayer))

  if (src.values.length !== dst.values.length || src.offsets.length !== dst.offsets.length) {
    throw new Error(`mirror has ${dst.values.length} corners, source has ${src.values.length}`)
  }

  const a = from.getUVElementPositions!.call(from, fromLayer, src.values)
  const b = to.getUVElementPositions!.call(to, toLayer, dst.values)

  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-5) {
      throw new Error(`mirror corner ${(i / 3) | 0} sits elsewhere than its source`)
    }
  }

  to.setUVs(toLayer, dst.values, from.getUVs(fromLayer, src.values))
}

/**
 * A grid lifted onto a dome, welded into one chart — P19 §5 step 7.
 *
 * The cube fixtures give a chart per face, and a face is planar, so their
 * unwrap is already exact before the solver takes a step. This one is not
 * developable, so flattening it costs angle error the solver then has to work
 * down: it is the fixture that makes the solve do something, through a real
 * provider rather than the unit suite's in-memory double.
 *
 * A fresh UV layer reads all zeroes, and `uvFans` welds by UV equality, so the
 * whole grid arrives as a single island without anything being written first.
 */
function makeDomeSource(): IUVSource {
  const n = 4
  const data = new LeafMeshData()
  const grid: number[] = []

  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const u = x / n
      const v = y / n
      grid.push(data.mesh.makeVert([u, v, 0.4 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI)]))
    }
  }

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * (n + 1) + x
      data.mesh.makeFace([[grid[i], grid[i + 1], grid[i + n + 2], grid[i + n + 1]]])
    }
  }

  ensureUVCoords(data.mesh, 'uv')

  const source = LEAFMESH_UV_PROVIDER.resolve(data)
  if (!source) {
    throw new Error('LEAFMESH_UV_PROVIDER did not resolve a LeafMeshData')
  }
  return source
}

registerUVSourceFixture('leafmesh', () => ({source: makeCubeSource()}))
registerUVSourceFixture('leafmesh-dome', () => ({source: makeDomeSource()}))

// Built from whatever LiteMesh registered, so it is absent exactly when that is
// — which is what a build with no sculptcore looks like.
registerUVSourceFixture('leafmesh-mirror', () => ({
  source: withUVSourceFixture('litemesh', mirrorSource),
}))

;(globalThis as {__uvsourceLeafMesh?: typeof runLeafMeshUVConformance}).__uvsourceLeafMesh =
  runLeafMeshUVConformance

export {runLeafMeshUVConformance}
