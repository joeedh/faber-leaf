/**
 * Runs the ported unwrapping stack against every registered `IUVSource`
 * fixture, inside the running app — P19 §5 step 7, §6.
 *
 * The solvers are unit-tested against an in-memory grid
 * (`tests/unit/uv_editor/uv_solve.test.ts`); that is where convergence and
 * pinning are checked. What cannot be checked there is that a *real* source
 * feeds them the same way a made-up one does, because both real providers are
 * addon modules and jest resolves no `@framework/api`. So this exposes
 * `globalThis.__uvUnwrapAll()`, driven from the NW.js harness's `--eval` and
 * reported through `--dump` (see `tests/integration/uv_unwrap_parity.test.ts`).
 *
 * Nothing here reaches for a geometry addon: the fixtures arrive through the
 * host registry in `scripts/core/uv_source_fixtures.ts`, which is the only way
 * a mesh-agnostic editor is allowed to get hold of a mesh.
 *
 * Pulled in as a side-effect import from `main.ts`.
 */

import {uvSourceFixtureNames, withUVSourceFixture} from '@framework/api'
import type {IUVSource} from '@framework/api'

import {buildUVGraph} from './uv_wrangler.js'
import type {UVGraph} from './uv_wrangler.js'
import {UVSolver, packUVIslands, relaxUVGraph} from './uv_solve.js'

/** One fixture's run, or why it did not run. */
export interface UVUnwrapReport {
  ok: boolean
  error?: string

  /** Graph size, so parity fails loudly when the two inputs are not the same. */
  elements?: number
  verts?: number
  tris?: number
  islands?: number

  /** Sum of squared 3D-vs-UV corner-angle error, before and after the solve. */
  angleBefore?: number
  angleAfter?: number

  /** Whether the source has 3D positions at all — without them there is no solve. */
  positioned?: boolean

  finite?: boolean
  inUnitSquare?: boolean

  /** How many bin edges the packer reported, four per bin. */
  bins?: number

  /** Final UVs, read back off the source, in face-ring order. */
  uvs?: number[]
}

/** How the drivers all run: fixed counts and a fixed seed, so a rerun matches. */
const STEPS = 12
const RELAX_ROUNDS = 2
const SEED = 0
const WEIGHT = 0.4

/** What a `Vector2`/`Vector3` looks like to a reader: both index as maybe-undefined. */
type Coords = {readonly length: number; readonly [i: number]: number | undefined}

/** The angle at `b` in `a-b-c`, over the first `n` components. */
function cornerAngle(a: Coords, b: Coords, c: Coords, n: number): number {
  let dot = 0
  let la = 0
  let lc = 0

  for (let i = 0; i < n; i++) {
    const u = a[i]! - b[i]!
    const v = c[i]! - b[i]!

    dot += u * v
    la += u * u
    lc += v * v
  }

  const denom = Math.sqrt(la * lc)
  if (denom < 1e-12) {
    return 0
  }
  return Math.acos(Math.max(-1, Math.min(1, dot / denom)))
}

/**
 * Every UV in face-ring order. Two sources describing the same topology agree
 * on that order and on nothing else — element handles are each provider's own
 * numbering — so it is the only ordering a parity check can compare in.
 */
function ringUVs(source: IUVSource, layer: number): Float32Array {
  const rings = source.getUVFaceRings(layer, source.listUVFaces(layer))
  return source.getUVs(layer, rings.values)
}

/** What an angle-based unwrap is driving to zero; scale- and rotation-free. */
function angleError(graph: UVGraph): number {
  let err = 0

  for (let i = 0; i < graph.tris.length; i += 3) {
    const tri = [graph.verts[graph.tris[i]], graph.verts[graph.tris[i + 1]], graph.verts[graph.tris[i + 2]]]

    for (let j = 0; j < 3; j++) {
      const d =
        cornerAngle(tri[(j + 2) % 3].world, tri[j].world, tri[(j + 1) % 3].world, 3) -
        cornerAngle(tri[(j + 2) % 3].co, tri[j].co, tri[(j + 1) % 3].co, 2)

      err += d * d
    }
  }
  return err
}

/**
 * Unwrap, relax, then pack — the three ops in the order a user runs them,
 * called as a library rather than through `ToolOp` so this stays usable in a
 * boot with no UV editor open. What the ops add on top (undo, the tool inputs,
 * the `ImageBus` overlay) is checked separately, on the op path.
 */
export function runUVUnwrap(source: IUVSource, layer = source.activeUVLayer): UVUnwrapReport {
  if (layer < 0) {
    return {ok: false, error: 'the source carries no UV layer'}
  }

  const graph = buildUVGraph(source, layer)
  const positioned = source.getUVElementPositions !== undefined
  const solver = new UVSolver(graph, {seed: SEED})

  solver.start()
  const angleBefore = angleError(graph)

  for (let i = 0; i < STEPS; i++) {
    solver.step(WEIGHT)
  }
  const angleAfter = angleError(graph)

  for (let i = 0; i < RELAX_ROUNDS; i++) {
    relaxUVGraph(graph, {})
  }

  let bins = 0
  packUVIslands(graph, {seed: SEED, drawLine: () => bins++})
  graph.write()

  const uvs = Array.from(ringUVs(source, layer))
  let finite = true
  let inUnitSquare = true

  for (const x of uvs) {
    finite = finite && Number.isFinite(x)
    inUnitSquare = inUnitSquare && x >= -1e-4 && x <= 1 + 1e-4
  }

  return {
    ok      : true,
    elements: uvs.length / 2,
    verts   : graph.verts.length,
    tris    : graph.tris.length / 3,
    islands : graph.islands.length,
    angleBefore,
    angleAfter,
    positioned,
    finite,
    inUnitSquare,
    bins,
    uvs,
  }
}

/**
 * Run every registered fixture. A fixture that throws is reported, not
 * rethrown: in a build without sculptcore the LiteMesh one is absent by
 * design, and the LeafMesh legs still have to run.
 */
function runUVUnwrapAll(): {[name: string]: UVUnwrapReport} {
  const out: {[name: string]: UVUnwrapReport} = {}

  for (const name of uvSourceFixtureNames()) {
    try {
      out[name] = withUVSourceFixture(name, (source) => runUVUnwrap(source))
    } catch (e) {
      out[name] = {ok: false, error: e instanceof Error ? e.message : String(e)}
    }
  }
  return out
}

;(globalThis as {__uvUnwrapAll?: typeof runUVUnwrapAll}).__uvUnwrapAll = runUVUnwrapAll

export {runUVUnwrapAll}
