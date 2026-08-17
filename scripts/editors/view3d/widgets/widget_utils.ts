// @ts-nocheck
// TODO: this module is imported by nothing in the repo (verified 2026-08-15) and
// does not typecheck (93 errors). It was excluded from the old narrow tsconfig
// `files` list, so widening the program to `scripts/**/*.ts` surfaced it. Either
// port it or delete it; the exemption is here rather than in tsconfig.exclude so
// it stays visible in the file.
import {Vector2, Vector3, Vector4, Quat, Matrix4} from '../../../util/vectormath.js'
import {SimpleMesh, LayerTypes} from '../../../webgl/simplemesh.ts'
import {
  IntProperty,
  BoolProperty,
  FloatProperty,
  EnumProperty,
  FlagProperty,
  ToolProperty,
  Vec3Property,
  ListProperty,
  PropFlags,
  PropTypes,
  PropSubTypes,
  StringSetProperty,
  ToolMacro,
  ToolOp,
  ToolFlags,
  UndoFlags,
  DataPathError,
} from '../../../path.ux/scripts/pathux.js'
import {Shaders} from '../../../shaders/shaders.js'
import {dist_to_line_2d} from '../../../path.ux/scripts/util/math.js'
import {CallbackNode, NodeFlags} from '../../../core/graph.js'
import {DependSocket} from '../../../core/graphsockets.js'
import * as util from '../../../util/util.js'
import {SelMask} from '../../../core/select_types.js'
import {Colors} from '../../../sceneobject/sceneobject.js'
import {ObjectFlags} from '../../../sceneobject/sceneobject.js'

import {View3DFlags} from '../view3d_base.js'
import {WidgetBase, WidgetSphere, WidgetArrow, WidgetFlags} from './widgets.js'
import {TranslateOp, ScaleOp, SnapModes} from '../transform/transform_ops.js'
import {calcTransCenter} from '../transform/transform_query.js'
import {Icons} from '../../icon_enum.js'
import {PropModes, TransDataType, TransDataElem, TransDataMap, TransDataTypes} from '../transform/transform_base.js'
import {ConstraintSpaces} from '../transform/transform_base.js'
import {aabb_union} from '../../../util/math.js'
import {TransformOp} from '../transform/transform_ops.js'

export class TransMovWidget extends TransDataType {
  static transformDefine() {
    return {
      name  : 'movable_widget',
      uiname: 'Movable Widget',
      flag  : 0,
      icon  : -1,
    }
  }

  static isValid(ctx, toolop) {
    return toolop !== undefined && toolop.inputs.datapaths !== undefined
  }

  static genData(ctx, selectMask, propmode, propradius, toolop) {
    if (ctx.scene === undefined) {
      return []
    }

    let manager = ctx.scene.widgets

    let ret = []
    let api = ctx.api

    for (let path of toolop.inputs.datapaths) {
      let td = new TransDataElem()
      td.data1 = path
      td.data2 = new Vector3(api.getValue(ctx, path))

      console.log(path)
      ret.push(td)
    }

    return ret
  }

  static applyTransform(ctx, elem, do_prop, matrix, toolop) {
    let co = new Vector3()

    co.load(elem.data2).multVecMatrix(matrix)
    ctx.api.getValue(ctx, elem.data1).load(co)

    if (ctx.scene) {
      ctx.scene.widgets.update()
    }
  }

  static undoPre(ctx, elemlist) {
    let ret = {
      paths: [],
      cos  : [],
    }

    for (let td of elemlist) {
      ret.paths.push(td.data1)
      ret.cos.push(td.data2.copy())
    }

    return ret
  }

  static undo(ctx, udata) {
    let paths = udata.paths
    let cos = udata.cos

    for (let i = 0; i < paths.length; i++) {
      let path = paths[i],
        co = cos[i]
      ctx.api.getValue(ctx, path).load(co)
    }

    if (ctx.scene !== undefined) {
      ctx.scene.widgets.update()
    }
    window.redraw_viewport()
  }

  /**
   * @param ctx                : instance of ToolContext or a derived class
   * @param selmask            : SelMask
   * @param spacemode          : ConstraintSpaces
   * @param space_matrix_out   : Matrix4, optional, matrix to put constraint space in
   */
  static getCenter(ctx, list, selmask, spacemode, space_matrix_out, toolop) {
    let center = new Vector3()
    let tot = 0.0

    for (let td of list) {
      let co = ctx.api.getValue(ctx, td.data1)

      center.add(co)
      tot++
    }

    if (!tot) {
      return undefined
    }

    center.mulScalar(1.0 / tot)

    return center
  }

  static calcAABB(ctx, toolop) {}

  static update(ctx, elemlist) {}
}
// Host-owned: this is the widget-drag pseudo-type, not a geometry kind, and
// `isValid` keeps it out of ordinary transform ops (§8).
TransDataType.register(TransMovWidget)

export class MovWidgetTranslateOp extends TranslateOp {
  static tooldef() {
    return {
      name    : 'translate',
      uiname  : 'Translate',
      toolpath: 'movable_widget.translate',
      is_modal: true,
      inputs: ToolOp.inherit({
        types    : TransDataType.buildTypesProp('movable_widget'),
        datapaths: new ListProperty(PropTypes.STRING),
      }),

      outputs: ToolOp.inherit({}),
    }
  }
}
ToolOp.register(MovWidgetTranslateOp)

export class MovableWidget extends WidgetBase {
  constructor(manager, datapath, snapmode = SnapModes.NONE) {
    super(manager)

    this.datapath = datapath
    this.shapeid = 'SPHERE'
    this.snapMode = snapmode

    this.shape = undefined
    this.bad = false

    this.onupdate = undefined
    this.flag |= WidgetFlags.CAN_SELECT
    this.tools = {}
  }

  //selectOne, toggleSelectAll should be toolpath strings
  addTools(selectOne, toggleSelectAll) {
    if (selectOne) this.tools.selectOne = selectOne
    if (toggleSelectAll) this.tools.toggleSelectAll = toggleSelectAll
    return this
  }

  get iterWidgets() {
    let this2 = this

    return (function* () {
      for (let w of this2.manager.widgets) {
        if (w instanceof MovableWidget) {
          yield w
        }
      }
    })()
  }

  on_mousedown(e, localX, localY, was_touch) {
    let ctx = this.ctx

    console.log('Movable widget mouse down!')

    let tools = []

    if (this.tools.selectOne) {
      let path = this.tools.selectOne
      let p = this.getValue()

      let mode
      if (e.shiftKey) {
        mode = p.select ? 'SUB' : 'ADD'
      } else {
        mode = 'UNIQUE'
      }

      path = `${path}(mode='${mode}' path='${this.datapath}')`

      let toolop = ctx.api.createTool(ctx, path)
      tools.push(toolop)
    }

    if (e.button == 0 || was_touch) {
      let toolop = new MovWidgetTranslateOp()

      for (let w of this.iterWidgets) {
        if (w.getSelect()) {
          toolop.inputs.datapaths.push(w.datapath)
        }
      }

      toolop.inputs.snapMode.setValue(this.snapMode)
      tools.push(toolop)
    }

    if (tools.length > 1) {
      let macro = new ToolMacro()

      for (let tool of tools) {
        macro.add(tool)
      }

      macro.connect(tools[0], tools[1], (tool1, tool2) => {
        tool2.inputs.datapaths.clear()

        for (let path of tool1.outputs.selectPaths) {
          tool2.inputs.datapaths.push(path)
        }
      })
      ctx.toolstack.execTool(ctx, macro)
    } else if (tools.length === 1) {
      ctx.toolstack.execTool(ctx, tools[0])
    }
  }

  static canCall(ctx) {
    return true
  }

  getSelect() {
    try {
      return this.getValue().select
    } catch (error) {
      util.print_stack(error)
      console.warn('corrupted MovableWidget with datapath: ' + this.datapath)

      return false
    }
  }

  getValue() {
    return this.ctx.api.getValue(this.ctx, this.datapath)
  }

  setValue(val) {
    this.ctx.api.setValue(this.ctx, this.datapath, val)
    this.update(this.manager)
    window.redraw_viewport()
  }

  update(manager) {
    super.update()

    if (this.bad) {
      return
    }

    if (this.shape === undefined) {
      this.shape = new WidgetSphere(manager)
    }

    let scale = 0.25

    this.matrix.makeIdentity()
    let co

    try {
      co = this.ctx.api.getValue(this.ctx, this.datapath)
    } catch (error) {
      this.bad = true

      if (!(error instanceof DataPathError)) {
        throw error
      }

      console.log('MovableWidget: invalid data path', this.datapath)
      return
    }

    if (co === undefined) {
      this.bad = true
      return
    }

    let sel = co.select
    let mask = sel ? ObjectFlags.SELECT : 0
    let hmask = ObjectFlags.HIGHLIGHT | mask

    let color = Colors[mask]
    let hcolor = Colors[hmask]

    this.shape.color.load(color)
    this.shape.hcolor.load(hcolor)

    this.matrix.translate(co[0], co[1], co[2])
    this.matrix.scale(scale, scale, scale)
  }
}
