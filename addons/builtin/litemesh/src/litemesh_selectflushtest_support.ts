/**
 * Integration-test support for on-demand selection-domain flushing
 * (documentation/plans/selectFlush.md M4). Exposes `globalThis.__selectFlushTest()`;
 * the NW.js headless harness drives it from `--eval` and the caller stores the
 * result on `__evalTestResult` (the generic eval report-back seam).
 *
 * Scenarios (on the `litemesh-cube` scene, boxmodel toolmode):
 *  - vert-only region selection drives extrude_region (face-domain op),
 *  - vert-only region selection drives subdivide (edge-domain op),
 *  - an explicit face selection wins outright with the flag on,
 *  - with the flag off, explicit + derived merge (union).
 */

import {Vector2} from '../../../../scripts/path.ux/scripts/pathux.js'
import {FeatureFlags} from '@framework/api'
import {LiteMesh, type IMeshLogSelect} from './litemesh'
import type {ViewContext} from '../../../../scripts/core/context'
import type {View3D} from '../../../../scripts/editors/view3d/view3d'
import type {SceneObject} from '../../../../scripts/sceneobject/sceneobject'
import {SculptPaintOp} from './sculptcore_ops'

interface SelCounts {
  v: number
  e: number
  f: number
}

export interface SelectFlushTestResult {
  ok: boolean
  error?: string
  extrudeFromVerts?: {before: SelCounts; after: SelCounts; worked: boolean}
  subdivideFromVerts?: {before: SelCounts; after: SelCounts; worked: boolean}
  preferExplicit?: {explicit: number; capAfter: number; worked: boolean}
  union?: {explicit: number; capAfter: number; worked: boolean}
}

const FLAG = 'sculptcore.select_flush_prefer_op_domain'

async function selectFlushTest(): Promise<SelectFlushTestResult> {
  const r: SelectFlushTestResult = {ok: false}
  try {
    const ctx = _appstate.ctx as ViewContext
    const exec = (t: string) => ctx.api.execTool(ctx, t)
    const undo = () => ctx.toolstack.undo()

    ctx.scene.switchToolMode('sculptcore')
    window._sculptcoreStrokeTester.frameMeshInCamera()
    ctx.scene.switchToolMode('boxmodel')
    const tm = ctx.scene.toolmode as unknown as {boxModelSelMode: number}
    const mesh = ctx.scene.objects.active!.data as LiteMesh
    const view3d = ctx.view3d as View3D
    const objd = ctx.scene.objects.active as SceneObject
    exec('litemesh.select_all(mode=NONE)') // forces ensureMeshLog()
    const meshlog = SculptPaintOp.meshLog as unknown as IMeshLogSelect
    const size = view3d.size!

    const m = mesh.mesh as unknown as {selectedCount(d: number): number}
    const counts = (): SelCounts => ({
      v: m.selectedCount(0),
      e: m.selectedCount(1),
      f: m.selectedCount(2),
    })
    const selRect = (domain: number, fx0: number, fy0: number, fx1: number, fy1: number) => {
      const min = new Vector2([size[0] * fx0, size[1] * fy0])
      const max = new Vector2([size[0] * fx1, size[1] * fy1])
      meshlog.selectionBeginStep()
      mesh.selectRect(view3d, objd, min, max, domain, 1, meshlog)
      meshlog.selectionEndStep()
    }
    const clearAll = () => {
      tm.boxModelSelMode = 7
      exec('litemesh.select_all(mode=NONE)')
    }

    // vert-only selection drives extrude region (face-domain op)
    clearAll()
    tm.boxModelSelMode = 1
    selRect(0, 0.4, 0.4, 0.6, 0.6)
    const b1 = counts()
    exec('litemesh.extrude_region()')
    const a1 = counts()
    r.extrudeFromVerts = {before: b1, after: a1, worked: b1.v > 0 && a1.f > 0}
    undo()

    // vert-only selection drives subdivide (edge-domain op); the new cut verts
    // are left selected, so the selected-vert count must grow
    clearAll()
    tm.boxModelSelMode = 1
    selRect(0, 0.4, 0.4, 0.6, 0.6)
    const b2 = counts()
    exec('litemesh.subdivide(numCuts=1)')
    const a2 = counts()
    r.subdivideFromVerts = {before: b2, after: a2, worked: a2.v > b2.v}
    undo()

    // explicit face selection wins outright with the flag on: the extruded cap
    // face count equals the explicit selection, ignoring the vert selection
    clearAll()
    tm.boxModelSelMode = 4
    selRect(2, 0.45, 0.45, 0.55, 0.55)
    const fExplicit = counts().f
    tm.boxModelSelMode = 1
    selRect(0, 0.2, 0.2, 0.8, 0.8)
    exec('litemesh.extrude_region()')
    const capPrefer = counts().f
    r.preferExplicit = {explicit: fExplicit, capAfter: capPrefer, worked: fExplicit > 0 && capPrefer === fExplicit}
    undo()

    // flag off: explicit + derived union -> more caps than the explicit set
    FeatureFlags.set(FLAG, false)
    try {
      clearAll()
      tm.boxModelSelMode = 4
      selRect(2, 0.45, 0.45, 0.55, 0.55)
      const fExplicit2 = counts().f
      tm.boxModelSelMode = 1
      selRect(0, 0.3, 0.3, 0.7, 0.7)
      exec('litemesh.extrude_region()')
      const capUnion = counts().f
      r.union = {explicit: fExplicit2, capAfter: capUnion, worked: capUnion > fExplicit2}
      undo()
    } finally {
      FeatureFlags.set(FLAG, true)
    }

    r.ok =
      !!r.extrudeFromVerts?.worked && !!r.subdivideFromVerts?.worked && !!r.preferExplicit?.worked && !!r.union?.worked
  } catch (e) {
    r.error = `${e}\n${e instanceof Error ? e.stack : ''}`
  }
  return r
}

declare global {
  interface Window {
    __selectFlushTest: typeof selectFlushTest
  }
}

window.__selectFlushTest = selectFlushTest
