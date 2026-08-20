/**
 * Integration-test support for Select Similar (litemesh.select_similar +
 * Mesh::selectSimilar). Exposes `globalThis.__selectSimilarTest()`; the NW.js
 * headless harness drives it from `--eval` and stores the result on
 * `__evalTestResult`.
 *
 * Exercises the full chain end to end on the `litemesh-cube` scene, boxmodel
 * toolmode: assign / active-seed / the C++ gather / selectIndices / undo.
 * FACE_MATERIAL is the decisive check — the expected match count is computed
 * independently from faceMaterial(), so a wrong C++ gather fails loudly rather
 * than looking plausible.
 */

import {getAppState} from '@framework/api'
import {LiteMesh, type IMeshLogSelect} from './litemesh'
import type {ViewContext} from '../../../../scripts/core/context'
import type {View3D} from '../../../../scripts/editors/view3d/view3d'
import {SculptPaintOp} from './sculptcore_ops'

interface SimCase {
  selected: number
  expected: number
  worked: boolean
}

export interface SelectSimilarTestResult {
  ok: boolean
  error?: string
  nFaces?: number
  nVerts?: number
  faceMaterial?: SimCase
  faceMaterialNegative?: {slot0FaceSelected: boolean; worked: boolean}
  faceSides?: SimCase
  vertEdges?: SimCase & {allVerts: number}
  undoRestores?: {after: number; restored: number; worked: boolean}
}

async function selectSimilarTest(): Promise<SelectSimilarTestResult> {
  const r: SelectSimilarTestResult = {ok: false}
  try {
    const ctx = getAppState().ctx
    const exec = (t: string) => ctx.api.execTool(ctx, t)
    const undo = () => ctx.toolstack.undo()

    ctx.scene.switchToolMode('boxmodel')
    const tm = ctx.scene.toolmode as unknown as {boxModelSelMode: number}
    const mesh = ctx.scene.objects.active!.data as LiteMesh
    void (ctx.view3d as View3D)
    const m = mesh.mesh as unknown as {
      f: {count: number}
      v: {count: number}
      selectedCount(d: number): number
      elemSelected(d: number, i: number): number
    }
    const nFaces = m.f.count
    const nVerts = m.v.count
    r.nFaces = nFaces
    r.nVerts = nVerts

    exec('litemesh.select_all(mode=NONE)') // forces ensureMeshLog()
    const log = SculptPaintOp.meshLog as unknown as IMeshLogSelect

    const setActive = (domain: number, idx: number) => {
      log.selectionBeginStep()
      log.setActiveElem(domain, idx)
      log.selectionEndStep()
    }

    // --- FACE_MATERIAL: assign slot 1 to the first third, seed a slot-1 face ---
    tm.boxModelSelMode = 4 // face
    const k = Math.max(1, Math.floor(nFaces / 3))
    const matFaces: number[] = []
    for (let i = 0; i < k; i++) {
      matFaces.push(i)
    }
    mesh.assignMaterialToFaces(matFaces, 1)

    let expectMat = 0
    for (let i = 0; i < nFaces; i++) {
      if (mesh.faceMaterial(i) === 1) {
        expectMat++
      }
    }

    // The menu emits the single-arg form; clear first so the default extend=true
    // yields exactly the material matches. Seed = face 0 (slot 1).
    exec('litemesh.select_all(mode=NONE)')
    setActive(2, 0)
    exec('litemesh.select_similar(type=FACE_MATERIAL)')
    const selMat = m.selectedCount(2)
    r.faceMaterial = {selected: selMat, expected: expectMat, worked: selMat === expectMat && expectMat > 0}

    // A slot-0 face (the last one) must NOT be selected by a slot-1 seed.
    const slot0Face = nFaces - 1
    const slot0Sel = m.elemSelected(2, slot0Face) !== 0
    r.faceMaterialNegative = {slot0FaceSelected: slot0Sel, worked: !slot0Sel && mesh.faceMaterial(slot0Face) === 0}

    // Undo the material select-similar: selection returns to empty.
    undo()
    r.undoRestores = {after: selMat, restored: m.selectedCount(2), worked: m.selectedCount(2) === 0}

    // --- FACE_SIDES: a cube is all quads, so every face matches ---
    exec('litemesh.select_all(mode=NONE)')
    setActive(2, 0)
    exec('litemesh.select_similar(type=FACE_SIDES)')
    const selSides = m.selectedCount(2)
    r.faceSides = {selected: selSides, expected: nFaces, worked: selSides === nFaces}

    // --- VERT_EDGES (valence): seed vert 0; must select >0 verts, not all ---
    tm.boxModelSelMode = 1 // vert
    exec('litemesh.select_all(mode=NONE)')
    setActive(0, 0)
    exec('litemesh.select_similar(type=VERT_EDGES)')
    const selVal = m.selectedCount(0)
    r.vertEdges = {selected: selVal, expected: -1, worked: selVal > 0 && selVal <= nVerts, allVerts: nVerts}

    r.ok =
      !!r.faceMaterial?.worked &&
      !!r.faceMaterialNegative?.worked &&
      !!r.faceSides?.worked &&
      !!r.vertEdges?.worked &&
      !!r.undoRestores?.worked
  } catch (e) {
    r.error = `${e}\n${e instanceof Error ? e.stack : ''}`
  }
  return r
}

declare global {
  interface Window {
    __selectSimilarTest: typeof selectSimilarTest
  }
}

window.__selectSimilarTest = selectSimilarTest
