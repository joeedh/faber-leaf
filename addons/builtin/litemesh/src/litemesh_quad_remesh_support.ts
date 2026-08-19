/**
 * Integration-test support for the host-side quad-remesh path
 * (`sculptcore/documentation/plans/quad-remeshing.md`, M6h). Exposes
 * `globalThis.__quadRemeshTest()`, which the NW.js headless harness drives
 * from `--eval` (see `tests/integration/litemesh_quad_remesh.test.ts`).
 *
 * It runs the *real* `litemesh.quad_remesh` ToolOp through the toolstack on the
 * scene's active `LiteMesh`, then exercises undo + redo — capturing a tiny
 * backend-agnostic topology signature (`{ngon, leaf}`) at each stage so the test
 * can assert, on BOTH backends: the remesh changed the mesh (success), undo
 * restored it exactly, and redo reapplied it. The subsequent `--dump` snapshots
 * the redone (remeshed) GPU buffers, so the parity test also gets native↔WASM
 * geometry byte-equality of the remesh *output* for free. Strict all-quad
 * topology is gated upstream in the C++ synthetic suite (`test_remesh_extract`),
 * not re-proven here. Never throws — failures land in the result, since the
 * harness eval seam must stay alive.
 *
 * Lives in the lite-mesh layer (it drives a `LiteMesh` ToolOp) and is pulled in
 * as a side-effect import from `litemesh_test_scene.ts`.
 */

import {LiteMesh} from './litemesh'

/** A backend-agnostic topology fingerprint of a LiteMesh (both signals exist on
 * WASM and native; `vertexCount` is a WASM-only extra, absent natively). */
interface TopoSig {
  /** Faces with >3 sides — exact, via the `Mesh_ngonFaceCount` C-API helper. */
  ngon: number
  /** Spatial-tree leaf count (a topology signal independent of geometry). */
  leaf: number
  /** Live vertex count when the backend exposes it numerically (WASM). */
  vertexCount?: number
}

interface QuadRemeshTestResult {
  ok: boolean
  error?: string
  backend: string
  /** True iff the op changed the mesh (ngon or leaf differs from `before`). A
   * clean failure (infeasible field) leaves the mesh untouched → false. */
  success: boolean
  before: TopoSig
  after: TopoSig
  undone: TopoSig
  redone: TopoSig
}

/** Read a LiteMesh's topology fingerprint without assuming a backend (mirrors
 * `test_harness.dumpScene`'s leaf-count read: WASM iterates the heap-backed
 * vector directly, native goes through `getBoundVector`). */
function topoSig(lite: LiteMesh): TopoSig {
  const wasm = lite.wasm as unknown as {
    Mesh_ngonFaceCount(m: unknown): number
    HEAPU8?: unknown
    getBoundVector(name: string, v: unknown): {length?: number}
  }
  const ngon = wasm.Mesh_ngonFaceCount(lite.mesh)

  let leaf = 0
  try {
    const spatial = lite.spatial as unknown as {leaves?: () => unknown} | undefined
    const leaves = spatial?.leaves?.()
    const lv = wasm.HEAPU8 !== undefined ? (leaves as {length?: number}) : wasm.getBoundVector('', leaves)
    leaf = (lv?.length ?? 0) | 0
  } catch {
    /* leaves() not available on this backend */
  }

  const sig: TopoSig = {ngon, leaf}
  const v = (lite.mesh as unknown as Record<string, unknown>).vertexCount
  if (typeof v === 'number') sig.vertexCount = v
  return sig
}

/**
 * Run `litemesh.quad_remesh(targetEdgeLength=0.1)` — matching the C++ synthetic
 * suite's known-good `makeUVSphere` + explicit-0.1 case (the default is now
 * count mode) — on the active LiteMesh, then undo and redo, recording the
 * topology fingerprint at each stage.
 */
function runQuadRemeshTest(): QuadRemeshTestResult {
  const backend = (globalThis as {__SCULPTCORE_BACKEND?: string}).__SCULPTCORE_BACKEND ?? 'wasm'
  const result: QuadRemeshTestResult = {
    ok: false,
    backend,
    success: false,
    before : {ngon: 0, leaf: 0},
    after  : {ngon: 0, leaf: 0},
    undone : {ngon: 0, leaf: 0},
    redone : {ngon: 0, leaf: 0},
  }
  try {
    const app = (
      globalThis as {
        _appstate?: {
          ctx: {scene?: {objects?: {active?: {data?: unknown}}}; api?: {execTool: (ctx: unknown, p: string) => void}}
          toolstack: {undo: () => void; redo: () => void}
        }
      }
    )._appstate
    if (!app) throw new Error('no _appstate')
    const ctx = app.ctx

    const lite = ctx.scene?.objects?.active?.data
    if (!(lite instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')

    result.before = topoSig(lite)

    // The real user path: a registered, undoable ToolOp driven by data-API tool
    // path. Explicit 0.1 pins the validated parity band (default = count mode).
    ctx.api?.execTool(ctx, 'litemesh.quad_remesh(targetEdgeLength=0.1)')
    result.after = topoSig(lite)
    result.success = result.after.ngon !== result.before.ngon || result.after.leaf !== result.before.leaf

    app.toolstack.undo()
    result.undone = topoSig(lite)

    app.toolstack.redo()
    result.redone = topoSig(lite)

    result.ok = true
  } catch (err) {
    result.error = String(err)
  }
  ;(globalThis as {__quadRemeshResult?: QuadRemeshTestResult}).__quadRemeshResult = result
  return result
}

;(globalThis as {__quadRemeshTest?: typeof runQuadRemeshTest}).__quadRemeshTest = runQuadRemeshTest

export {runQuadRemeshTest}
