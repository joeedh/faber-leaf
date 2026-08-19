import {
  IntProperty,
  FloatProperty,
  StringProperty,
  ListProperty,
  BoolProperty,
  EnumProperty,
  FlagProperty,
  ToolProperty,
  math,
  util,
  nstructjs,
  ToolOp,
} from '../../path.ux/scripts/pathux.js'
import {MeshTypes, MeshFlags} from '../../../addons/builtin/mesh/src/mesh_base.js'
import {SelOneToolModes, SelToolModes} from '../../../core/select_types.js'
import {Icons} from '../icon_enum.js'
import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../../util/vectormath.js'
//import {FindNearest} from '../view3d/findnearest.js';
import {UVWrangler} from '../../../addons/builtin/mesh/src/unwrapping.js'
import {UVOpBase} from '../../../addons/builtin/mesh/src/mesh_uvops_base.js'

export const UVSelMask = {
  VERTEX: 1,
  EDGE  : 2,
  FACE  : 8,
}

export class SelectOpBaseUV extends UVOpBase {
  constructor() {
    super()
  }

  static canRun(ctx) {
    return ctx.mesh && ctx.mesh.loops.customData.hasLayer('uv')
  }

  static tooldef() {
    return {
      inputs: ToolOp.inherit({
        mode      : new EnumProperty(0, SelToolModes),
        selectMask: new FlagProperty(1, UVSelMask),
      }),
    }
  }

  calcUndoMem(ctx) {
    return this._undo.list.length * 8
  }

  undoPre(ctx) {
    let mesh = ctx.mesh
    let cd_uv = mesh.loops.customData.getLayerIndex('uv')

    let ud = []
    let highlight = mesh.loops.highlight
    let active = mesh.loops.active

    highlight = highlight !== undefined ? highlight.eid : -1
    active = active !== undefined ? active.eid : -1

    this._undo = {
      list     : ud,
      active   : active,
      highlight: highlight,
    }

    let flag = MeshFlags.SELECT | MeshFlags.HIDE

    for (let l of mesh.loops) {
      ud.push(l.eid)
      ud.push(l.flag & flag)
    }
  }

  undo(ctx) {
    let mesh = ctx.mesh
    let cd_uv = mesh.loops.customData.getLayerIndex('uv')

    let undo = this._undo

    mesh.loops.active = mesh.eidMap.get(undo.active)
    mesh.loops.highlight = mesh.eidMap.get(undo.highlight)

    let list = undo.list

    for (let i = 0; i < list.length; i += 2) {
      let eid = list[i],
        flag = list[i + 1]

      let l = mesh.eidMap.get(eid)
      if (!l || l.type !== MeshTypes.LOOP) {
        console.warn('Missing loop at eid', eid)
        continue
      }

      if ((flag & MeshFlags.SELECT) !== (l.flag & MeshFlags.SELECT)) {
        mesh.loops.setSelect(l, flag & MeshFlags.SELECT)
      }
    }

    mesh.regenUVEditor()
    window.redraw_uveditors(false)
  }

  execPost(ctx) {
    window.redraw_uveditors(false)
  }
}

export class ToggleSelectAllUVs extends SelectOpBaseUV {
  static tooldef() {
    return {
      uiname  : 'Toggle Select All (UV)',
      icon    : Icons.TOGGLE_SEL_ALL,
      toolpath: 'uveditor.toggle_select_all',
      inputs  : ToolOp.inherit({}),
    }
  }

  static invoke(ctx, args) {
    let tool = super.invoke(ctx, args)

    if (!('mode' in args)) {
      tool.inputs.mode.setValue(SelToolModes.AUTO)
    }

    return tool
  }

  exec(ctx) {
    let mesh = ctx.mesh

    let mode = this.inputs.mode.getValue()
    let selmask = this.inputs.selectMask.getValue()

    let loops = this.getLoops(ctx, false)

    if (mode === SelToolModes.AUTO) {
      mode = SelToolModes.ADD

      for (let l of loops) {
        if (l.flag & MeshFlags.SELECT) {
          mode = SelToolModes.SUB
          break
        }
      }
    }

    console.log('mode', mode)
    mode = mode === SelToolModes.ADD

    console.log('mode', mode)
    for (let l of loops) {
      if (mode && !mesh.loops.active) {
        mesh.loops.setActive(l)
      }

      mesh.setSelect(l, mode)
    }

    mesh.regenUVEditor()
  }
}

ToolOp.register(ToggleSelectAllUVs)

export class SelectLinkedOpPick extends SelectOpBaseUV {
  constructor() {
    super()

    this.start_mpos = new Vector2()
    this.last_mpos = new Vector2()
    //this.mpos = new Vector2();
    this.first = true
  }

  static tooldef() {
    return {
      uiname  : 'Select Linked (Pick)',
      toolpath: 'uveditor.pick_select_linked',
      is_modal: true,
      inputs: ToolOp.inherit({
        loopEid      : new IntProperty(),
        cdUV         : new IntProperty(-1),
        immediateMode: new BoolProperty(false),
      }),
    }
  }

  modalStart(ctx) {
    super.modalStart(ctx)
    this.first = true

    if (this.inputs.immediateMode.getValue()) {
      let uveditor = ctx.editors.imageEditor
      if (uveditor) {
        uveditor = uveditor.uvEditor

        this.pick(uveditor.mpos[0], uveditor.mpos[1])
      }
    }
  }

  on_mouseup(e) {
    this.pick(e.x, e.y)
  }

  pick(x, y) {
    let ctx = this.modal_ctx
    let uveditor = ctx.editors.imageEditor
    let found = false

    if (!uveditor) {
      ctx.error('No image editor found')
      return
    }

    uveditor = uveditor.uvEditor

    console.log('mouse up!')

    let mode = this.inputs.mode.getValue()

    console.log('MODE', mode)
    mode = mode === SelToolModes.ADD

    let mpos = uveditor.getLocalMouse(x, y)
    let ret = uveditor.findnearest(mpos[0], mpos[1])

    let mesh = ctx.mesh

    let iter

    let selFsOnly = this.inputs.selectedFacesOnly.getValue()
    iter = selFsOnly ? mesh.faces.selected.editable : mesh.faces.editable

    if (ret) {
      let l = ret[0].l
      let uvw = new UVWrangler(mesh, iter)
      uvw.buildIslands(true)

      let island = uvw.islandLoopMap.get(l)

      for (let v of island) {
        let loops = uvw.vertMap.get(v)

        for (let l2 of loops) {
          let bad = (l2.f.flag | l2.flag) & MeshFlags.HIDE
          bad = bad || (selFsOnly && !(l2.f.flag & MeshFlags.SELECT))

          if (!bad) {
            mesh.loops.setSelect(l2, mode)
          }
        }
      }
    }

    mesh.regenUVEditor()
    this.modalEnd(!found)
  }

  exec(ctx) {
    let l = this.inputs.loopEid.getValue()
    let cd_uv = this.inputs.cdUV.getValue()
    let mesh = ctx.mesh

    if (cd_uv === -1) {
      cd_uv = mesh.loops.customData.getLayerIndex('uv')
    }

    l = mesh.eidMap.get(l)

    if (cd_uv < 0) {
      ctx.error('No UV layers')
      return
    }

    if (!l) {
      ctx.error('Missing face corner')
      return
    }

    console.log(cd_uv, l)
  }
}

ToolOp.register(SelectLinkedOpPick)

export class SelectOneUVOp extends SelectOpBaseUV {
  static tooldef() {
    return {
      uiname  : 'Select UV',
      icon    : -1,
      toolpath: 'uveditor.select_one',
      inputs: ToolOp.inherit({
        loopEids: new ListProperty(IntProperty),
        mode    : new EnumProperty('UNIQUE', SelOneToolModes),
      }),
    }
  }

  exec(ctx) {
    let mesh = ctx.mesh

    let mode = this.inputs.mode.getValue()
    let selmask = this.inputs.selectMask.getValue()

    if (mode === SelOneToolModes.UNIQUE) {
      for (let l of this.getLoops(ctx)) {
        mesh.loops.setSelect(l, false)
      }
    }

    mode = mode === SelOneToolModes.UNIQUE || mode === SelOneToolModes.ADD

    for (let eid of this.inputs.loopEids) {
      let l = mesh.eidMap.get(eid)
      if (!l) {
        console.error('Missing loop ' + eid)
        continue
      }

      mesh.loops.setSelect(l, mode)

      if (mode !== SelOneToolModes.SUB) {
        mesh.loops.setActive(l)
      }
    }

    mesh.regenUVEditor()
  }
}

ToolOp.register(SelectOneUVOp)
