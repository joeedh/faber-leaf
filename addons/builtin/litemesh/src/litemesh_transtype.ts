/**
 * LiteMeshTransType — the box-modeling transform bridge (Milestone 1 of
 * documentation/plans/boxModelingTools.md, §3a).
 *
 * A single TS substrate that plugs a sculptcore LiteMesh into the existing
 * view3d transform system (`scripts/editors/view3d/transform/`), so a grab of
 * the current selection — and every "T" modeling tool that hands off to
 * `view3d.translate` — reuses its modal loop, constraints, numeric entry, header
 * readout and snapping with no new transform math.
 *
 * Mirrors `MeshTransType`: it works in the object's local space (genData reads
 * the movable verts' local positions as backups; applyTransform writes
 * `co = backup·matrix` back). The verts are C++ indices (not JS objects), so the
 * apply path is the bound `setVertCo`, and the per-step GPU refresh is the
 * incremental `markVertsMoved` (no full spatial rebuild). Undo is the transform's
 * own position snapshot — the MeshLog-bracketed single-step undo for "T" tools
 * comes from the *modeling op* holding its step open across the modal (§3d).
 */
import {Vector3, Matrix4} from '../../../../scripts/path.ux/scripts/pathux'
import {
  ITransDataType,
  TransDataType,
  TransDataElem,
  TransDataList,
} from '../../../../scripts/editors/view3d/transform/transform_base'
import {SelMask} from '../../../../scripts/core/select_types'
import {LiteMesh} from './litemesh'
import type {ToolContext} from '../../../../scripts/core/context'
import type {SceneObject} from '../../../../scripts/sceneobject/sceneobject'
import type {TransformOp} from '../../../../scripts/editors/view3d/transform/transform_ops'

/** Resolve the active LiteMesh object (the type is gated to it via isValid). */
function activeLiteMesh(ctx: ToolContext): {ob: SceneObject; mesh: LiteMesh} | undefined {
  const ob = (ctx as unknown as {scene?: {objects?: {active?: SceneObject}}}).scene?.objects?.active
  const data = ob?.data
  if (data instanceof LiteMesh) {
    return {ob: ob as SceneObject, mesh: data}
  }
  return undefined
}

export class LiteMeshTransElem extends TransDataElem<number, Vector3> {
  mesh?: LiteMesh
}

export class LiteMeshTransList extends TransDataList<number, Vector3> {
  mesh?: LiteMesh
  /** Bound Vector<int> of the movable indices, reused for the per-step GPU mark. */
  idxVec?: unknown
  idxArr: number[] = []
}

interface LiteMeshUndoData {
  mesh?: LiteMesh
  idx: number[]
  cos: number[]
  idxVec?: unknown
}

const applytemp = new Vector3()
const applytemp2 = new Vector3()

export const LiteMeshTransType: ITransDataType<number, Vector3, LiteMeshTransElem, LiteMeshUndoData> = {
  transformDefine() {
    return {name: 'litemesh', uiname: 'LiteMesh', flag: 0, icon: -1}
  },

  isValid(ctx: ToolContext): boolean {
    return activeLiteMesh(ctx) !== undefined
  },

  buildTypesProp: TransDataType.buildTypesProp,

  genData(ctx, selectmode, propmode, propradius, toolop) {
    const lm = activeLiteMesh(ctx)
    if (!lm || !(selectmode & SelMask.GEOM)) {
      return undefined
    }
    const list = new LiteMeshTransList(this)
    list.mesh = lm.mesh

    const {idxVec, idx, co} = lm.mesh.gatherMovableVerts()
    list.idxVec = idxVec
    list.idxArr = idx

    for (let i = 0; i < idx.length; i++) {
      const td = new LiteMeshTransElem()
      td.mesh = lm.mesh
      td.data1 = idx[i]
      td.data2 = new Vector3([co[i * 3], co[i * 3 + 1], co[i * 3 + 2]])
      td.index = i
      td.w = 1.0
      list.push(td)
    }
    return list.length ? list : undefined
  },

  applyTransform(ctx, elem, do_prop, matrix, toolop) {
    const td = elem as LiteMeshTransElem
    // multVecMatrix mutates applytemp in place (its return is the perspective w).
    applytemp.load(td.data2).multVecMatrix(matrix)
    // interp by w supports proportional-edit falloff (w === 1 for a plain grab).
    applytemp2.load(td.data2).interp(applytemp, td.w)
    td.mesh!.setVertCo(td.data1, applytemp2[0], applytemp2[1], applytemp2[2])
  },

  calcUndoMem(ctx, undodata) {
    return undodata ? undodata.idx.length * 3 * 8 : 0
  },

  undoPre(ctx, elemlist) {
    const list = elemlist as LiteMeshTransList
    const idx: number[] = []
    const cos: number[] = []
    for (const td of list) {
      idx.push(td.data1)
      cos.push(td.data2[0], td.data2[1], td.data2[2])
    }
    return {mesh: list.mesh, idx, cos, idxVec: list.idxVec}
  },

  undo(ctx, undodata) {
    const {mesh, idx, cos, idxVec} = undodata
    if (!mesh) {
      return
    }
    for (let i = 0; i < idx.length; i++) {
      mesh.setVertCo(idx[i], cos[i * 3], cos[i * 3 + 1], cos[i * 3 + 2])
    }
    mesh.recalcNormals()
    if (idxVec) {
      mesh.markVertsMovedGPU(idxVec)
    }
    mesh.regenBounds()
    window.redraw_viewport()
  },

  getCenter(ctx, list, selmask, spacemode, space_matrix_out) {
    const lm = activeLiteMesh(ctx)
    if (!lm || !(selmask & SelMask.GEOM)) {
      return undefined
    }
    const {co} = lm.mesh.gatherMovableVerts()
    if (co.length === 0) {
      return undefined
    }
    const c = new Vector3()
    const n = co.length / 3
    for (let i = 0; i < co.length; i += 3) {
      c[0] += co[i]
      c[1] += co[i + 1]
      c[2] += co[i + 2]
    }
    c.mulScalar(1.0 / n)
    if (space_matrix_out) {
      space_matrix_out.makeIdentity()
    }
    return c
  },

  calcAABB(ctx, selmask) {
    const lm = activeLiteMesh(ctx)
    if (!lm || !(selmask & SelMask.GEOM)) {
      return undefined
    }
    const {co} = lm.mesh.gatherMovableVerts()
    const min = new Vector3([1e17, 1e17, 1e17])
    const max = new Vector3([-1e17, -1e17, -1e17])
    if (co.length === 0) {
      min.zero()
      max.zero()
      return [min, max]
    }
    const v = new Vector3()
    for (let i = 0; i < co.length; i += 3) {
      v[0] = co[i] ?? 0
      v[1] = co[i + 1] ?? 0
      v[2] = co[i + 2] ?? 0
      min.min(v)
      max.max(v)
    }
    return [min, max]
  },

  getOriginMatrix(ctx, list, selmask, spacemode, space_matrix_out) {
    return undefined
  },

  update(ctx, elemlist) {
    const list = elemlist as LiteMeshTransList
    const mesh = list.mesh
    if (!mesh) {
      return
    }
    // Per-frame: recompute normals + flag the moved verts' spatial leaves for GPU
    // regen (incremental, no full rebuild). recalcNormals is O(mesh) — fine for
    // box-model meshes; a targeted recompute is a perf follow-up.
    mesh.recalcNormals()
    if (list.idxVec) {
      mesh.markVertsMovedGPU(list.idxVec)
    }
    mesh.regenBounds()
    window.redraw_viewport()
  },
}
