import {Vector3, Matrix4} from '../../../util/vectormath.js'
import {SelMask} from '../../../core/select_types.js'
import {SceneObject, ObjectFlags} from '../../../sceneobject/sceneobject.js'
import {TransDataType, TransDataElem, TransDataList, ITransDataType} from './transform_base.js'
import {aabb_union} from '../../../util/math.js'
import {ToolContext} from '../../../core/context.js'
import type {TransformOp} from './transform_ops.js'

export class ObjectTransform {
  invmatrix: Matrix4
  tempmat: Matrix4
  matrix: Matrix4
  loc: Vector3
  rot: Vector3
  scale: Vector3
  ob: SceneObject | undefined

  constructor(ob: SceneObject) {
    this.invmatrix = new Matrix4()
    this.tempmat = new Matrix4()
    this.matrix = new Matrix4(ob.outputs.matrix.getValue())
    this.loc = new Vector3(ob.inputs.loc.getValue())
    this.rot = new Vector3(ob.inputs.rot.getValue())
    this.scale = new Vector3(ob.inputs.scale.getValue())
    this.ob = ob

    this.invmatrix.load(this.matrix).invert()
  }

  copy(): ObjectTransform {
    const ret = new ObjectTransform(this.ob!)
    return ret
  }
}

interface ObjectUndoData {
  [lib_id: string]: ObjectTransform
}

export const ObjectTransType: ITransDataType<
  SceneObject,
  ObjectTransform,
  TransDataElem<SceneObject, ObjectTransform>,
  ObjectUndoData
> = {
  transformDefine() {
    return {
      name  : 'object',
      uiname: 'Object',
      flag  : 0,
      icon  : -1,
    }
  },

  isValid       : TransDataType.isValid,
  buildTypesProp: TransDataType.buildTypesProp,

  genData(
    ctx: ToolContext,
    selectmode: number,
    propmode: number,
    propradius: number,
    toolop: TransformOp
  ): TransDataList<SceneObject, ObjectTransform> | undefined {
    if (!(selectmode & SelMask.OBJECT)) {
      return undefined
    }

    const tdata = new TransDataList<SceneObject, ObjectTransform>(this)

    function get_transform_parent(ob: SceneObject): SceneObject {
      if (ob.inputs.matrix.edges.length > 0) {
        const parent = ob.inputs.matrix.edges[0].node

        if (parent instanceof SceneObject) {
          if (parent.flag & ObjectFlags.SELECT && !(parent.flag & (ObjectFlags.HIDE | ObjectFlags.LOCKED))) {
            return parent
          } else {
            return get_transform_parent(parent)
          }
        }
      }

      return ob
    }

    for (const ob of ctx.selectedObjects) {
      // TODO: in an element mode this used to skip the object being edited, but
      // only for the BREP -- LiteMesh box modeling was never covered. If that
      // double-transform shows up, gate on a capability, not on a lib_type.
      const ok = get_transform_parent(ob) === ob

      if (!ok) {
        continue
      }

      // eslint-disable-next-line no-console
      console.warn('processing transform sceneobject', ob.name, ob)

      const td = new TransDataElem<SceneObject, ObjectTransform>()

      td.data1 = ob
      td.data2 = new ObjectTransform(ob)
      tdata.push(td)
    }

    return tdata
  },

  applyTransform(
    ctx: ToolContext,
    elem: TransDataElem<SceneObject, ObjectTransform>,
    do_prop: boolean,
    matrix: Matrix4,
    toolop: TransformOp
  ): void {
    const mat = elem.data2.tempmat

    mat.load(elem.data2.matrix)

    mat.preMultiply(matrix)

    const ob = elem.data1

    const order = ob.inputs.rotOrder.getValue()

    const r = ob.inputs.rot.getValue()
    const s = ob.inputs.scale.getValue()

    mat.decompose(ob.inputs.loc.getValue(), r, s, undefined, undefined, order)

    ob.graphUpdate()
  },

  calcUndoMem(ctx: ToolContext, undodata: ObjectUndoData): number {
    let tot = 0

    for (const _unusedK in undodata) {
      tot += 16 * 8 + 32 //matrix4
    }

    return tot
  },

  undoPre(ctx: ToolContext, elemlist: TransDataList<SceneObject, ObjectTransform>): ObjectUndoData {
    const undo: ObjectUndoData = {}

    for (const td of elemlist) {
      const transform = td.data2.copy()
      transform.ob = undefined //kill unwanted reference
      undo[td.data1.lib_id] = transform
    }

    return undo
  },

  undo(ctx: ToolContext, undodata: {[lib_id: string]: ObjectTransform}): void {
    for (const k in undodata) {
      const numK = parseInt(k)

      const ob = ctx.datalib.get<SceneObject>(numK)
      const transform = undodata[k]!

      if (ob === undefined) {
        // eslint-disable-next-line no-console
        console.warn('error in transform', numK, typeof numK)
        continue
      }

      ob.inputs.loc.setValue(transform.loc)
      ob.inputs.rot.setValue(transform.rot)
      ob.inputs.scale.setValue(transform.scale)
      ob.outputs.matrix.setValue(transform.matrix)

      ob.graphUpdate()
    }

    window.updateDataGraph()
  },

  getOriginMatrix(
    ctx: ToolContext,
    list: TransDataList<SceneObject, ObjectTransform> | TransDataElem<SceneObject, ObjectTransform>[],
    selmask: number,
    spacemode: number,
    space_matrix_out?: Matrix4
  ): Matrix4 | undefined {
    const cent = this.getCenter(ctx, list, selmask, spacemode, space_matrix_out)

    if (cent !== undefined) {
      const tmat = new Matrix4()
      const ob = ctx.object

      if (ob) {
        tmat.load(ob.outputs.matrix.getValue())
        tmat.makeRotationOnly()
        tmat.invert()
      }

      return tmat
    }
  },

  getCenter(
    ctx: ToolContext,
    list: TransDataList<SceneObject, ObjectTransform> | TransDataElem<SceneObject, ObjectTransform>[],
    selmask: number,
    spacemode?: number,
    space_matrix_out?: Matrix4
  ): Vector3 | undefined {
    if (!(selmask & SelMask.OBJECT)) {
      return undefined
    }

    if (space_matrix_out !== undefined) {
      space_matrix_out.makeIdentity()
    }

    const cent = new Vector3()
    let tot = 0.0

    for (const ob of ctx.selectedObjects) {
      const bbox = ob.getBoundingBox()

      const co = new Vector3(bbox[0]).interp(bbox[1], 0.5)
      cent.add(co)

      tot++
    }

    if (tot > 0) {
      cent.mulScalar(1.0 / tot)
    }

    return cent
  },

  calcAABB(ctx: ToolContext, selmask: number): [Vector3, Vector3] | undefined {
    let ret: [Vector3, Vector3] | undefined = undefined

    if (!(selmask & SelMask.OBJECT)) {
      return undefined
    }

    for (const ob of ctx.selectedObjects) {
      const aabb = ob.getBoundingBox()

      if (ret === undefined) {
        ret = [aabb[0].copy(), aabb[1].copy()]
      } else {
        aabb_union(ret, aabb)
      }
    }

    return ret
  },

  update(ctx: ToolContext, elemlist: TransDataList<SceneObject, ObjectTransform>): void {
    for (const td of elemlist) {
      td.data1.graphUpdate()
    }

    window.updateDataGraph()
    window.redraw_viewport()
  },
}

// Host-owned and unconditional: SceneObject is core, not addon geometry, so
// there is no `register(api)` hook to move this to (§8).
TransDataType.register(ObjectTransType)
