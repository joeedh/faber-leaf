/**
 * `LeafMeshTransType` — the LeafMesh transform bridge (P12 §6, step 3).
 *
 * Implementor #2 of `ITransDataType`, and the one that keeps the interface
 * honest once P13 deletes `MeshTransType` with the BREP. Registered from the
 * addon's `register(api)` hook through `api.registerTransType`, never at module
 * scope — a module-scope registration works exactly once and cannot be undone.
 *
 * Proportional edit runs on the geometry contract's `closestElements` (§6): the
 * query, never the structure. P11 answers it by brute force, which is a LeafMesh
 * problem to fix inside this addon if it ever becomes one.
 */

import type {ITransDataType, SceneObject, ToolContext} from '@framework/api'
import {
  ElementDomain,
  InvalidationKind,
  Matrix4,
  SelMask,
  TransDataElem,
  TransDataList,
  TransDataType,
  Vector3,
} from '@framework/api'

import {LeafMeshData} from './leafmesh.js'
import {aabbOf, centroidOf, gatherMovableVerts, propagationDistances, snapshotBytes} from './transform_geom.js'
import type {Vec3} from './topo.js'

/** Resolve the active LeafMesh object; the type is gated to it through `isValid`. */
function activeLeafMesh(ctx: ToolContext): {ob: SceneObject; data: LeafMeshData} | undefined {
  const ob = ctx.scene?.objects?.active
  const data = ob?.data
  return data instanceof LeafMeshData ? {ob: ob as SceneObject, data} : undefined
}

export class LeafMeshTransElem extends TransDataElem<number, Vector3> {
  data?: LeafMeshData
}

export class LeafMeshTransList extends TransDataList<number, Vector3> {
  data?: LeafMeshData
  /** Every vertex this transform touches, for one invalidation per step. */
  handles = new Int32Array(0)
}

interface LeafMeshUndoData {
  data?: LeafMeshData
  verts: Int32Array
  co: Float64Array
}

const applytemp = new Vector3()
const applytemp2 = new Vector3()

/** Adapt the contract's `closestElements` to the pure module's query shape. */
function nearVerts(data: LeafMeshData): (co: Readonly<Vec3>, radius: number) => ArrayLike<number> {
  const q = new Vector3()
  return (co, radius) => {
    q[0] = co[0]
    q[1] = co[1]
    q[2] = co[2]
    return data.closestElements(q, radius, ElementDomain.VERT)
  }
}

function pushElem(list: LeafMeshTransList, data: LeafMeshData, v: number, x: number, y: number, z: number, w: number) {
  const td = new LeafMeshTransElem()
  td.data = data
  td.data1 = v
  td.data2 = new Vector3([x, y, z])
  td.index = list.length
  td.w = w
  list.push(td)
  return td
}

export const LeafMeshTransType: ITransDataType<number, Vector3, LeafMeshTransElem, LeafMeshUndoData> = {
  transformDefine() {
    return {name: 'leafmesh', uiname: 'Leaf Mesh', flag: 0, icon: -1}
  },

  isValid(ctx: ToolContext): boolean {
    return activeLeafMesh(ctx) !== undefined
  },

  buildTypesProp: TransDataType.buildTypesProp,

  genData(ctx, selectmode, propmode, propradius) {
    const active = activeLeafMesh(ctx)
    if (active === undefined || !(selectmode & SelMask.GEOM)) {
      return undefined
    }

    const {data} = active
    const {verts, co} = gatherMovableVerts(data.mesh)
    if (verts.length === 0) {
      return undefined
    }

    const list = new LeafMeshTransList(this)
    list.data = data

    for (let i = 0; i < verts.length; i++) {
      pushElem(list, data, verts[i], co[i * 3], co[i * 3 + 1], co[i * 3 + 2], 1.0)
    }

    if (propmode !== undefined) {
      const mco = data.mesh.v.co
      const dists = propagationDistances(data.mesh, verts, propradius, nearVerts(data))

      for (const [v, dis] of dists) {
        const w = TransDataType.calcPropCurve(dis, propmode, propradius)
        if (w > 0) {
          pushElem(list, data, v, mco[v * 3], mco[v * 3 + 1], mco[v * 3 + 2], w)
        }
      }
    }

    list.handles = Int32Array.from(list, (td) => td.data1)
    return list
  },

  applyTransform(ctx, elem, do_prop, matrix: Matrix4) {
    const td = elem
    // multVecMatrix mutates applytemp in place (its return is the perspective w),
    // and interp by td.w is what makes the proportional falloff show up.
    applytemp.load(td.data2).multVecMatrix(matrix)
    applytemp2.load(td.data2).interp(applytemp, td.w)

    // Written straight into the column: the invalidation this needs is one per
    // step, not one per vertex, and `update` below issues it.
    const co = td.data!.mesh.v.co
    co[td.data1 * 3] = applytemp2[0]
    co[td.data1 * 3 + 1] = applytemp2[1]
    co[td.data1 * 3 + 2] = applytemp2[2]
  },

  calcUndoMem(ctx, undodata: LeafMeshUndoData | undefined) {
    return undodata === undefined ? 0 : snapshotBytes(undodata.verts.length)
  },

  undoPre(ctx, elemlist) {
    const list = elemlist as LeafMeshTransList
    const verts = new Int32Array(list.length)
    const co = new Float64Array(list.length * 3)

    for (let i = 0; i < list.length; i++) {
      const td = list[i] as LeafMeshTransElem
      verts[i] = td.data1
      co[i * 3] = td.data2[0]
      co[i * 3 + 1] = td.data2[1]
      co[i * 3 + 2] = td.data2[2]
    }

    return {data: list.data, verts, co}
  },

  undo(ctx, undodata) {
    const {data, verts, co} = undodata
    if (data === undefined) {
      return
    }

    data.setPositions(ElementDomain.VERT, verts, co)
    window.redraw_viewport()
  },

  getCenter(ctx, list, selmask) {
    const active = activeLeafMesh(ctx)
    if (active === undefined || !(selmask & SelMask.GEOM)) {
      return undefined
    }

    const c = centroidOf(active.data.mesh, gatherMovableVerts(active.data.mesh).verts)
    return c === undefined ? undefined : new Vector3(c)
  },

  calcAABB(ctx, selmask) {
    const active = activeLeafMesh(ctx)
    if (active === undefined || !(selmask & SelMask.GEOM)) {
      return undefined
    }

    const box = aabbOf(active.data.mesh, gatherMovableVerts(active.data.mesh).verts)
    return box === undefined ? undefined : [new Vector3(box[0]), new Vector3(box[1])]
  },

  getOriginMatrix() {
    return undefined
  },

  update(ctx, elemlist) {
    const list = elemlist as LeafMeshTransList
    if (list.data === undefined) {
      return
    }

    // Normals and the draw buffers are rebuilt off this; the range is the hint
    // that keeps it from being a whole-mesh invalidation.
    list.data.invalidate(InvalidationKind.POSITIONS, ElementDomain.VERT, list.handles)
    window.redraw_viewport()
  },
}
