/**
 * Integration-test support for sculpt undo memory accounting. Exposes
 * `globalThis.__undoMemTest()`, which the NW.js headless harness drives
 * from `--eval` (see `tests/integration/sculptcore_undomem.test.ts`); the
 * result is reflected into the `--dump` JSON as `undomemtest`.
 *
 * Covers the whole undo-memory seam end to end:
 *  - per-step MeshLog memory accounting (`stepMemSize`/`totalMemSize`, with a
 *    dyntopo stroke so topo chunks are measured, not just attr-swap chunks);
 *  - `SculptPaintOp.calcUndoMem` parity with the C++ step size;
 *  - redo-branch truncation (a new stroke after undos frees the redo steps);
 *  - the real `AppToolStack.limitMemory` trim path — dropped sculpt ops must
 *    free their MeshLog steps via `onUndoDestroy` → `freeStep`;
 *  - `freeStep` guards (already-freed id, pending-redo step) and post-trim
 *    undo/redo alignment of the surviving steps.
 */

import {getAppState} from '@framework/api'
import {DynTopoFlagsSC, SculptTools} from '../../../../scripts/brush/brush_base'
import {DefaultBrushes, type SculptBrush} from '../../../../scripts/brush/index'
import {runSculptcoreStroke, SculptPaintOp} from './sculptcore_ops'
import {Vector3} from '../../../../scripts/path.ux/scripts/pathux.js'
import {LiteMesh} from './litemesh'

interface UndoMemTestResult {
  ok: boolean
  error?: string
  /** Per-stroke step ids and byte sizes for the first five strokes. */
  stepIds?: number[]
  stepSizes?: number[]
  /** totalMemSize after the five strokes; must equal the sum of stepSizes. */
  totalAfterStrokes?: number
  entriesAfterStrokes?: number
  /** SculptPaintOp.calcUndoMem on a step-keyed op === stepMemSize. */
  calcUndoMemMatches?: boolean
  /** Op with no step reports zero. */
  calcUndoMemNoStep?: number
  /** After undo ×2 + a 6th stroke: entry count and the truncated steps' sizes. */
  entriesAfterTruncate?: number
  truncatedSizes?: number[]
  /** AppToolStack.limitMemory trim: dropped/kept op step ids + entry count. */
  entriesAfterTrim?: number
  droppedStepIds?: number[]
  keptStepIds?: number[]
  /** _syncSettings wiring: memLimit picked up from settings.undoMemLimit MB. */
  syncedMemLimit?: number
  syncedEnforce?: boolean
  /** freeStep guards: re-free of a dropped id, free of a pending-redo step. */
  refreeDropped?: number
  freePendingRedo?: number
  /** Post-trim undo/redo of the surviving steps (alignment / no-crash). */
  entriesAfterUndoRedo?: number
  totalAfterUndoRedo?: number
}

function undoMemTest(): UndoMemTestResult {
  const result: UndoMemTestResult = {ok: false}
  try {
    const app = getAppState()
    const ctx = app.ctx
    const mesh = ctx.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')

    let draw: SculptBrush | undefined
    for (const k in DefaultBrushes.brushes) {
      const b = DefaultBrushes.brushes[k]
      if (b?.tool === SculptTools.DRAW) draw = b
    }
    if (!draw) throw new Error('no default DRAW brush')

    // Dab on the actual surface (ray-picked pole vert), not a guessed point: an
    // off-surface dab makes dyntopo log a pathologically large, slow-to-undo
    // step. Same approach as litemesh_boundarytest_support.
    const pick = (dir: number[]): number => {
      const o = new Vector3([-dir[0] * 8, -dir[1] * 8, -dir[2] * 8])
      const v = mesh.pickVert(o, new Vector3(dir))
      if (v < 0) throw new Error(`pickVert missed along ${dir}`)
      return v
    }
    const vA = pick([0, 0, 1])
    const vB = pick([0, 0, -1])
    if (vA === vB) throw new Error('pole picks collided')
    const co = mesh.edgePathCoords(vA, vB)
    if (co.length < 3) throw new Error('edgePathCoords gave no pole position')
    const p = [co[0], co[1], co[2]]
    const pl = Math.hypot(p[0], p[1], p[2]) || 1
    const normal = [p[0] / pl, p[1] / pl, p[2] / pl]
    const radius = pl * 0.4
    const dab = {p, normal}

    const stepIds: number[] = []
    const stepSizes: number[] = []
    const saved = {strength: draw.strength, dtFlag: draw.dynTopoSC.flag}
    try {
      draw.strength = 0.3
      for (let i = 0; i < 5; i++) {
        // Stroke 2 runs with dyntopo so its step holds topo chunks too.
        if (i === 1) draw.dynTopoSC.flag |= DynTopoFlagsSC.ENABLED
        else draw.dynTopoSC.flag &= ~DynTopoFlagsSC.ENABLED
        runSculptcoreStroke({mesh, brush: draw, dabs: [dab, dab], radius})
        const log = SculptPaintOp.meshLog!
        const id = log.lastStepId()
        stepIds.push(id)
        stepSizes.push(log.stepMemSize(id))
      }
    } finally {
      draw.strength = saved.strength
      draw.dynTopoSC.flag = saved.dtFlag
    }
    const log = SculptPaintOp.meshLog
    if (!log) throw new Error('no MeshLog after strokes')

    result.stepIds = stepIds
    result.stepSizes = stepSizes
    result.totalAfterStrokes = log.totalMemSize()
    result.entriesAfterStrokes = log.entryCount()

    // calcUndoMem parity against the C++ step size, on real op instances.
    const mkOp = (stepId: number): SculptPaintOp => {
      const op = new SculptPaintOp()
      op.logStepId = stepId
      return op
    }
    const probeOp = mkOp(stepIds[4])
    result.calcUndoMemMatches = probeOp.calcUndoMem(undefined as never) === stepSizes[4]
    result.calcUndoMemNoStep = mkOp(-1).calcUndoMem(undefined as never)

    // Redo-branch truncation: undo the last two steps, then a new stroke's
    // beginStep must free them (their stepMemSize drops to 0).
    log.undo(mesh.mesh, mesh.spatial)
    log.undo(mesh.mesh, mesh.spatial)
    runSculptcoreStroke({mesh, brush: draw, dabs: [dab], radius})
    const id6 = log.lastStepId()
    result.entriesAfterTruncate = log.entryCount()
    result.truncatedSizes = [log.stepMemSize(stepIds[3]), log.stepMemSize(stepIds[4])]

    // Live steps now: stepIds[0..2] + id6. Push matching completed sculpt ops
    // onto the real toolstack and trim with a tiny limit: limitMemory always
    // keeps the newest three ops (`start < cur - 2`), so with our 4 ops at the
    // tail the oldest one is dropped and must free its MeshLog step through
    // onUndoDestroy.
    const stack = app.toolstack
    const liveIds = [stepIds[0], stepIds[1], stepIds[2], id6]
    const ops = liveIds.map(mkOp)
    for (const op of ops) {
      stack.push(op)
      stack.cur++
    }
    stack.limitMemory(1024, ctx)
    result.entriesAfterTrim = log.entryCount()
    result.droppedStepIds = ops.map((op, i) => (op.logStepId < 0 ? liveIds[i] : -1)).filter((id) => id >= 0)
    result.keptStepIds = ops.filter((op) => op.logStepId >= 0).map((op) => op.logStepId)

    // Settings → stack wiring (the path execTool/undo/redo run before
    // enforcing): memLimit must track settings.undoMemLimit (MB → bytes).
    const savedSettings = {limit: ctx.settings.undoMemLimit, enforce: ctx.settings.limitUndoMem}
    try {
      ctx.settings.undoMemLimit = 7
      ctx.settings.limitUndoMem = true
      stack._syncSettings(ctx)
      result.syncedMemLimit = stack.memLimit
      result.syncedEnforce = stack.enforceMemLimit
    } finally {
      ctx.settings.undoMemLimit = savedSettings.limit
      ctx.settings.limitUndoMem = savedSettings.enforce
      stack._syncSettings(ctx)
    }

    // freeStep guards: a dropped id is gone (0), and a pending-redo step
    // (after undoing back past it) refuses to free (0).
    result.refreeDropped = log.freeStep(stepIds[0])
    log.undo(mesh.mesh, mesh.spatial)
    log.undo(mesh.mesh, mesh.spatial)
    result.freePendingRedo = log.freeStep(stepIds[2])
    log.redo(mesh.mesh, mesh.spatial)
    log.redo(mesh.mesh, mesh.spatial)

    // Surviving steps stay aligned: undo/redo cycles cleanly (the extra undo
    // past the trimmed history must be a no-op) and accounting is unchanged.
    log.undo(mesh.mesh, mesh.spatial)
    log.undo(mesh.mesh, mesh.spatial)
    log.undo(mesh.mesh, mesh.spatial)
    log.undo(mesh.mesh, mesh.spatial) // past trimmed history — must no-op
    log.redo(mesh.mesh, mesh.spatial)
    log.redo(mesh.mesh, mesh.spatial)
    log.redo(mesh.mesh, mesh.spatial)
    result.entriesAfterUndoRedo = log.entryCount()
    result.totalAfterUndoRedo = log.totalMemSize()
    mesh.regenTreeBatch()

    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  ;(globalThis as {__undoMemTestResult?: UndoMemTestResult}).__undoMemTestResult = result
  return result
}

;(globalThis as {__undoMemTest?: typeof undoMemTest}).__undoMemTest = undoMemTest

export {undoMemTest}
