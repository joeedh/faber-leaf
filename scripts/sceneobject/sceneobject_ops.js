import {Vector3, Matrix4} from '../util/vectormath.js'
import {FlagProperty, ToolOp} from '../path.ux/scripts/pathux.js'
import {SelMask} from '../core/select_types.js'

import {StandardTools} from './stdtools.js'
import {SelToolModes, SelOneToolModes} from '../core/select_types.js'
import {ObjectSelectOneOp} from './selectops.js'
import {composeObjectMatrix, ObjectFlags, SceneObject} from './sceneobject.js'
import {ObjectDataTypes} from './sceneobject_base.js'

export class SceneObjectOp extends ToolOp {
  execPost(ctx) {
    super.execPost(ctx)
    window.redraw_viewport()
  }
}

export class DeleteObjectOp extends SceneObjectOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      toolpath   : 'object.delete_selected',
      name       : 'delete_selected',
      uiname     : 'Delete Selected',
      description: 'Delete all selected objects',
      inputs     : {},
      outputs    : {},
      icon       : -1,
    }
  }

  exec(ctx) {
    let scene = ctx.scene

    let list = []

    for (let ob of scene.objects.selected.editable) {
      list.push(ob)
    }

    for (let ob of list) {
      scene.remove(ob)

      if (ob.lib_users <= 0) {
        console.log('Nuking object')
        let data = ob.data

        ctx.datalib.remove(ob) //will call ob.destroy()

        if (data.lib_users <= 0) {
          console.log('Nuking object data too')
          ctx.datalib.remove(data)
        }
      }
    }
  }
}

ToolOp.register(DeleteObjectOp)

//
export class ObjectTools extends StandardTools {
  static ToggleSelectAll(ctx, mode = SelToolModes.AUTO) {
    ctx.api.execTool(ctx, `object.toggle_select_all(mode=${mode})`)
  }

  static BoxSelect(ctx) {
    ctx.api.execTool(ctx, 'object.select_box()')
  }

  static Delete(ctx) {
    ctx.api.execTool(ctx, 'object.delete_selected()')
    s
  }

  static SelectOne(ctx, unique = true) {
    let view3d = ctx.view3d
    let scene = ctx.scene

    if (ctx.scene.objects.highlight !== undefined) {
      let tool = new ObjectSelectOneOp()

      let ob = ctx.scene.objects.highlight
      tool.objectId = ob.lib_id

      if (unique) {
        tool.inputs.setActive.setValue(true)
        tool.inputs.objectId.setValue(ob.lib_id)
        tool.inputs.mode.setValue(SelOneToolModes.UNIQUE)
      } else {
        let sel = ob.flag & ObjectFlags.SELECT

        tool.inputs.setActive.setValue(!sel)
        tool.inputs.mode.setValue(sel ? SelOneToolModes.ADD : SelOneToolModes.SUB)
      }

      ctx.toolstack.execTool(ctx, tool)
    }
  }
}

export function getStdTools(ctx) {
  let selmask = ctx.selectMask

  // Whole-object mode is any mask spanning more than one object type. Not
  // `== SelMask.OBJECT`: that union grows as geometry types register, so an
  // equality test silently stops matching. A mask naming exactly one type
  // (e.g. SelMask.TETMESH) still falls through to that type's own tools.
  let objbits = selmask & SelMask.OBJECT
  if (objbits && (objbits & (objbits - 1)) !== 0) {
    return ObjectTools
  }

  for (let cls of ObjectDataTypes) {
    let def = cls.dataDefine()

    if (def.selectMask & selmask) {
      return def
    }
  }

  return ObjectTools
}

export const ApplyTransFlags = {
  LOC  : 1,
  ROT  : 2,
  SCALE: 4,
  ALL  : 1 | 2 | 4,
}

export class ApplyTransformOp extends ToolOp {
  static tooldef() {
    return {
      uiname  : 'Apply Tranform',
      toolpath: 'object.apply_transform',
      inputs: {
        mode: new FlagProperty(ApplyTransFlags.ALL, ApplyTransFlags),
      },
    }
  }

  _badObject(ob) {
    let scale = ob.inputs.scale.getValue()
    let d = scale.dot(scale)

    return d === 0.0 || isNaN(d) || !isFinite(d)
  }

  exec(ctx) {
    let obs = new Set(ctx.selectedObjects)

    window.updateDataGraph(true)

    let mode = this.inputs.mode.getValue()
    let undo = this._undo

    for (let ob of obs) {
      if (this._badObject(ob)) {
        continue
      }

      let matrix
      if (mode === ApplyTransFlags.ALL) {
        matrix = new Matrix4(ob.outputs.matrix.getValue())

        ob.data.applyMatrix(matrix)
      } else {
        let loc = new Vector3()
        let rot = new Vector3()
        let rotOrder = ob.inputs.rotOrder.getValue()
        let scale = new Vector3([1, 1, 1])

        if (mode & ApplyTransFlags.LOC) {
          loc.load(ob.inputs.loc.getValue())
        }
        if (mode & ApplyTransFlags.ROT) {
          rot.load(ob.inputs.rot.getValue())
        }
        if (mode & ApplyTransFlags.SCALE) {
          scale.load(ob.inputs.scale.getValue())
        }

        let mat = composeObjectMatrix(loc, rot, scale, rotOrder)
        matrix = new Matrix4(mat)

        ob.data.applyMatrix(mat)
      }

      undo[ob.lib_id].matrix.load(matrix)
      undo[ob.lib_id].matrixInv.load(matrix).invert()

      if (mode & ApplyTransFlags.LOC) {
        ob.inputs.loc.setValue(new Vector3())
        ob.inputs.loc.graphUpdate()
      }

      if (mode & ApplyTransFlags.SCALE) {
        ob.inputs.scale.setValue(new Vector3([1, 1, 1]))
        ob.inputs.scale.graphUpdate()
      }

      if (mode & ApplyTransFlags.ROT) {
        ob.inputs.rot.setValue(new Vector3())
        ob.inputs.rot.graphUpdate()
      }

      ob.data.graphUpdate()
      ob.graphUpdate()

      window.updateDataGraph(true)
      window.redraw_viewport(true)
    }
  }

  calcUndoMem(ctx) {
    return 1024 //not large enough to matter, just guess
  }

  undoPre(ctx) {
    let undo = (this._undo = {})
    for (let ob of ctx.selectedObjects) {
      if (this._badObject(ob)) {
        continue
      }

      undo[ob.lib_id] = {
        loc      : new Vector3(ob.inputs.loc.getValue()),
        rot      : new Vector3(ob.inputs.rot.getValue()),
        scale    : new Vector3(ob.inputs.scale.getValue()),
        rotOrder : ob.inputs.rotOrder.getValue(),
        matrix   : new Matrix4(),
        matrixInv: new Matrix4(),
      }
    }
  }

  undo(ctx) {
    for (let id in this._undo) {
      let ob = ctx.datalib.get(parseInt(id))
      if (!ob) {
        console.warn('Missing object in undo data ' + id)
        continue
      }

      let ud = this._undo[id]

      ob.data.applyMatrix(ud.matrixInv)

      ob.inputs.loc.setValue(ud.loc)
      ob.inputs.rot.setValue(ud.rot)
      ob.inputs.rotOrder.setValue(ud.rotOrder)
      ob.inputs.scale.setValue(ud.scale)

      ob.inputs.loc.graphUpdate()
      ob.inputs.rot.graphUpdate()
      ob.inputs.rotOrder.graphUpdate()
      ob.inputs.scale.graphUpdate()

      ob.graphUpdate()
      ob.data.graphUpdate()

      window.updateDataGraph()
      window.redraw_viewport(true)
    }
  }
}
ToolOp.register(ApplyTransformOp)

export class DuplicateObjectOp extends SceneObjectOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname     : 'Duplicate Objects',
      toolpath   : 'object.duplicate',
      description: 'Duplicate all selected objects',
      inputs     : {},
      outputs    : {},
      icon       : -1,
    }
  }

  exec(ctx) {
    let scene = ctx.scene

    let list = []

    for (let ob of scene.objects.selected.editable) {
      list.push(ob)
    }

    let newlist = []
    let act = undefined

    for (let ob of list) {
      let data = ob.data.copy()

      data.name = ob.data.name
      data.lib_id = -1

      ctx.datalib.add(data)

      let ob2 = new SceneObject()
      ob.copyTo(ob2, false)
      ob2.name = ob.name

      ctx.datalib.add(ob2)

      ob2.data = data
      data.lib_addUser(ob2)

      scene.add(ob2)
      newlist.push(ob2)

      if (ob === scene.objects.active) {
        act = ob2
      }

      ob2.graphUpdate()
    }

    scene.objects.clearSelection()
    for (let ob of newlist) {
      scene.objects.setSelect(ob, true)
    }

    if (act) {
      scene.objects.setActive(act)
    }

    window.redraw_viewport(true)
  }
}

ToolOp.register(DuplicateObjectOp)
