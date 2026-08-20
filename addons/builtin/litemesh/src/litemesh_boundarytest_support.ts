/**
 * Integration-test support for the boundary constraint system. Exposes
 * `globalThis.__boundaryTest()`, which the NW.js headless harness drives
 * from `--eval` (see `tests/integration/sculptcore_boundary.test.ts`); the
 * result is reflected into the `--dump` JSON as `boundarytest`.
 *
 * Marks three seam paths converging on the +Z pole of the spherified
 * `litemesh-cube` scene (via the real `litemesh.mark_seam` ToolOp, so the
 * marking itself is undoable), then observes the constraint network through
 * `LiteMesh.boundaryGraphStats()` — the connected polyline graph of all
 * boundary-flagged edges. Non-2-valence vertex count and connected-component
 * count are invariant under feature-preserving remeshing (splits/collapses
 * along a feature curve only add/remove 2-valence chain verts), so they detect
 * constraint-network damage from brush strokes with and without dyntopo.
 * Stroke undo/redo goes through the sculpt MeshLog, mark undo/redo through the
 * app toolstack.
 */

import {getAppState} from '@framework/api'
import {Vector3} from '../../../../scripts/path.ux/scripts/pathux.js'
import {DynTopoFlagsSC, SculptTools} from '../../../../scripts/brush/brush_base'
import {SculptBrush, DefaultBrushes} from '../../../../scripts/brush/index'
import {runSculptcoreStroke, SculptPaintOp} from './sculptcore_ops'
import {LiteMesh} from './litemesh'

type GraphStats = {flaggedEdges: number; graphVerts: number; non2ValenceVerts: number; components: number}

interface BoundaryTestResult {
  ok: boolean
  error?: string
  /** Stats before any marking — expected all-zero on a fresh scene. */
  baseline0?: GraphStats
  /** After marking 3 seam paths into the +Z pole (junction → non2 > 0). */
  marked?: GraphStats
  /** After toolstack-undoing the 3 mark ops — must equal baseline0. */
  markUndo?: GraphStats
  /** After toolstack-redoing them — must equal marked. */
  markRedo?: GraphStats
  /** After a DRAW stroke over the junction with dyntopo OFF — must equal marked. */
  strokeNoDyntopo?: GraphStats
  /** After a DRAW stroke with dyntopo ON (preserve-features default):
   * non2ValenceVerts/components must equal marked's, while flaggedEdges
   * growing past marked's proves the remesher actually split seam edges. */
  strokeDyntopo?: GraphStats
  /** After MeshLog-undoing both strokes — must equal marked. */
  strokeUndo?: GraphStats
  /** After MeshLog-redoing them — must equal strokeDyntopo. */
  strokeRedo?: GraphStats
  /** After a SMOOTH-tool stroke (now the boundary-aware bsmooth kernel) over the
   * seam junction with dyntopo OFF — frozen topology, so must equal strokeRedo. */
  strokeSmooth?: GraphStats
  /** Sharp-edge marking (the sharp tool's engine path, kind=1). Edge count the
   * markEdgePath(kind=1) call flagged, and the kind=1/kind=0 bits read back on
   * the first edge of that path (must be 1 / 0 — sharp set, seam untouched). */
  sharpPathEdges?: number
  sharpEdgeFlagSharp?: number
  sharpEdgeFlagSeam?: number
  /** featureVerts(kind) sizes after the sharp mark: the seam set is unchanged by
   * the sharp mark, the sharp set is non-empty, and the two are distinct flags. */
  seamFeatureVerts?: number
  sharpFeatureVerts?: number
  seamVertsUnchanged?: boolean
  /** boundaryGraphStats (the union of all boundary flags) grew by the sharp
   * edges — proves the union graph counts sharp edges alongside seams. */
  unionGrewBy?: number
  /** The picked pole verts + per-path marked edge counts (diagnostics). */
  poleVerts?: number[]
  pathEdgeCounts?: number[]
  /** Dab placement + spatial-tree leaf counts around the dyntopo stroke
   * (diagnostics; leaves change iff remeshing restructured the tree). */
  junction?: number[]
  radius?: number
  leavesBeforeDyntopo?: number
  leavesAfterDyntopo?: number
}

/** Spatial-tree leaf count, backend-agnostically (mirrors the quad-remesh
 * support's topoSig read). */
function leafCount(mesh: LiteMesh): number {
  try {
    const wasm = mesh.wasm as unknown as {
      HEAPU8?: unknown
      getBoundVector(name: string, v: unknown): {length?: number}
    }
    const spatial = mesh.spatial as unknown as {leaves?: () => unknown} | undefined
    const leaves = spatial?.leaves?.()
    const lv = wasm.HEAPU8 !== undefined ? (leaves as {length?: number}) : wasm.getBoundVector('', leaves)
    return (lv?.length ?? 0) | 0
  } catch {
    return 0
  }
}

function boundaryTest(): BoundaryTestResult {
  const result: BoundaryTestResult = {ok: false}
  try {
    const app = getAppState()
    const ctx = app.ctx
    const mesh = ctx.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')

    let draw: SculptBrush | undefined
    for (const k in DefaultBrushes.brushes) {
      const b = DefaultBrushes.brushes[k]
      if (b && b.tool === SculptTools.DRAW) draw = b
    }
    if (!draw) throw new Error('no default DRAW brush')

    // Pole verts via ray-picks from outside along the axes (backend-agnostic).
    const R = 2.0 // litemesh-cube is unit-ish; rays from well outside always hit
    const pick = (dir: number[]): number => {
      const o = new Vector3([-dir[0] * R * 4, -dir[1] * R * 4, -dir[2] * R * 4])
      const d = new Vector3(dir)
      const v = mesh.pickVert(o, d)
      if (v < 0) throw new Error(`pickVert missed along ${dir}`)
      return v
    }
    const vZp = pick([0, 0, 1]) // ray travelling +Z hits the -Z side... see below
    const vZn = pick([0, 0, -1])
    const vXn = pick([1, 0, 0])
    const vYn = pick([0, 1, 0])
    // A ray fired along +dir from -dir*4R hits the NEAR face (the -dir pole),
    // so vZp above is really the -Z pole etc. Naming is irrelevant: we only
    // need four distinct, well-separated verts.
    const poles = [vZp, vZn, vXn, vYn]
    if (new Set(poles).size !== 4) throw new Error(`pole picks collided: ${poles}`)
    result.poleVerts = poles

    result.baseline0 = mesh.boundaryGraphStats()

    // Mark 3 seam paths: two meridians out of pole A plus an equator arc C→D.
    // The A→B meridian passes through pole D, so D becomes a valence-3
    // junction; B stays a valence-1 endpoint (and if A→B were ever rerouted
    // off D, D itself becomes the endpoint) — either way non2 = 2 in one
    // component, and no path rides an already-flagged edge.
    result.pathEdgeCounts = []
    for (const [a, b] of [
      [vZp, vZn],
      [vZp, vXn],
      [vXn, vYn],
    ]) {
      const before = mesh.boundaryGraphStats().flaggedEdges
      // Toolpath args are space-separated `k=v` pairs (no commas — see
      // path.ux toolpath.ts p_Start).
      ctx.api?.execTool(ctx, `litemesh.mark_seam(vStart=${a} vEnd=${b})`)
      result.pathEdgeCounts.push(mesh.boundaryGraphStats().flaggedEdges - before)
    }
    result.marked = mesh.boundaryGraphStats()

    // Mark undo/redo through the real toolstack.
    app.toolstack.undo()
    app.toolstack.undo()
    app.toolstack.undo()
    result.markUndo = mesh.boundaryGraphStats()
    app.toolstack.redo()
    app.toolstack.redo()
    app.toolstack.redo()
    result.markRedo = mesh.boundaryGraphStats()

    // Stroke setup: dab centered on pole A (a vert on the seam network),
    // radius covering the surrounding seam edges. edgePathCoords' first 3
    // floats are A's position (works on both backends).
    const co = mesh.edgePathCoords(poles[0], vZn)
    if (co.length < 3) throw new Error('edgePathCoords gave no junction position')
    const junction = [co[0], co[1], co[2]]
    const jl = Math.hypot(junction[0], junction[1], junction[2]) || 1
    const normal = [junction[0] / jl, junction[1] / jl, junction[2] / jl]
    const radius = jl * 0.4
    const dabs = Array.from({length: 4}, () => ({p: junction, normal}))
    result.junction = junction
    result.radius = radius

    const saved = {tool: draw.tool, strength: draw.strength, dtFlag: draw.dynTopoSC.flag}
    try {
      draw.tool = SculptTools.DRAW
      draw.strength = 0.5

      // Stroke 1: dyntopo off — frozen topology, so the graph must be identical.
      draw.dynTopoSC.flag &= ~DynTopoFlagsSC.ENABLED
      runSculptcoreStroke({mesh, brush: draw, dabs, radius})
      result.strokeNoDyntopo = mesh.boundaryGraphStats()

      // Stroke 2: dyntopo on (PRESERVE_FEATURES is a default flag) — topology
      // changes, but the polyline graph's junctions/endpoints/components must
      // survive. flaggedEdges growth is the "remeshing ran" signal: splits on
      // seam edges add flagged chain edges.
      result.leavesBeforeDyntopo = leafCount(mesh)
      draw.dynTopoSC.flag |= DynTopoFlagsSC.ENABLED
      runSculptcoreStroke({mesh, brush: draw, dabs, radius})
      result.leavesAfterDyntopo = leafCount(mesh)
      result.strokeDyntopo = mesh.boundaryGraphStats()
    } finally {
      draw.tool = saved.tool
      draw.strength = saved.strength
      draw.dynTopoSC.flag = saved.dtFlag
    }

    // Stroke undo/redo through the sculpt MeshLog (each runSculptcoreStroke
    // call is one begin/endStep).
    const log = SculptPaintOp.meshLog
    if (!log) throw new Error('no MeshLog after strokes')
    log.undo(mesh.mesh, mesh.spatial)
    log.undo(mesh.mesh, mesh.spatial)
    result.strokeUndo = mesh.boundaryGraphStats()
    log.redo(mesh.mesh, mesh.spatial)
    log.redo(mesh.mesh, mesh.spatial)
    result.strokeRedo = mesh.boundaryGraphStats()
    mesh.regenTreeBatch()

    // A SMOOTH-tool stroke now routes through the boundary-aware bsmooth kernel
    // (TOOL_TO_SCULPTBRUSH maps SMOOTH → BSMOOTH). With dyntopo OFF the topology
    // is frozen, so the boundary constraint graph must be byte-for-byte
    // unchanged: bsmooth projects boundary-vert displacement into the tangent
    // plane and never flags/clears edges.
    const savedSmooth = {tool: draw.tool, strength: draw.strength, dtFlag: draw.dynTopoSC.flag}
    try {
      draw.tool = SculptTools.SMOOTH
      draw.strength = 0.5
      draw.dynTopoSC.flag &= ~DynTopoFlagsSC.ENABLED
      runSculptcoreStroke({mesh, brush: draw, dabs, radius})
      result.strokeSmooth = mesh.boundaryGraphStats()
    } finally {
      draw.tool = savedSmooth.tool
      draw.strength = savedSmooth.strength
      draw.dynTopoSC.flag = savedSmooth.dtFlag
    }
    mesh.regenTreeBatch()

    // Sharp-edge marking — the engine path the interactive sharp tool drives
    // (kind=1). EDGE_SHARP is a separate attribute from EDGE_SEAM, so marking
    // sharp must leave the seam set untouched, featureVerts(kind) must return
    // per-kind vertex sets, and the union graph must grow by the sharp edges.
    // Re-pick verts on the current (post-stroke) topology; the original pole
    // indices may be stale after the dyntopo stroke restructured the mesh.
    const seamVertsBefore = mesh.featureVerts(0).idx.length
    const unionBefore = mesh.boundaryGraphStats().flaggedEdges
    const sVa = pick([0, 1, 0])
    const sVb = pick([0, 0, -1])
    result.sharpPathEdges = mesh.markEdgePath(sVa, sVb, 1, 1)
    const sharpPathEdgeIdx = mesh.edgePathEdges(sVa, sVb)
    result.sharpEdgeFlagSharp = sharpPathEdgeIdx.length ? mesh.edgeFlagKind(sharpPathEdgeIdx[0], 1) : -1
    result.sharpEdgeFlagSeam = sharpPathEdgeIdx.length ? mesh.edgeFlagKind(sharpPathEdgeIdx[0], 0) : -1
    result.seamFeatureVerts = mesh.featureVerts(0).idx.length
    result.sharpFeatureVerts = mesh.featureVerts(1).idx.length
    result.seamVertsUnchanged = mesh.featureVerts(0).idx.length === seamVertsBefore
    result.unionGrewBy = mesh.boundaryGraphStats().flaggedEdges - unionBefore
    mesh.regenTreeBatch()

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  ;(globalThis as {__boundaryTestResult?: BoundaryTestResult}).__boundaryTestResult = result
  return result
}

;(globalThis as {__boundaryTest?: typeof boundaryTest}).__boundaryTest = boundaryTest

export {boundaryTest}
