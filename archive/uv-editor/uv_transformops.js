import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../../util/vectormath.js'
import {
  math,
  nstructjs,
  ToolOp,
  StringProperty,
  Vec3Property,
  Vec2Property,
  Vec4Property,
  EnumProperty,
  FlagProperty,
  FloatProperty,
  BoolProperty,
  IntProperty,
  eventWasTouch,
} from '../../path.ux/scripts/pathux.js'
import * as util from '../../util/util.js'
import {MeshTypes, MeshFlags} from '../../../addons/builtin/mesh/src/mesh_base.js'
import {PropModes, TransDataType} from '../view3d/transform/transform_base.js'
import {UVOpBase} from '../../../addons/builtin/mesh/src/mesh_uvops_base.js'
import {UVWrangler} from '../../../addons/builtin/mesh/src/unwrapping.js'

export class TransLoop {
  constructor(l, uv) {
    this.l = l
    this.startuv = new Vector2(uv)
    this.uv = uv
    this.w = 1.0
  }
}

export class UVTransformOp extends UVOpBase {
  constructor() {
    super()

    this.start_mpos = new Vector2()
    this.last_mpos = new Vector2()
    this.mpos = new Vector2()
    this.first = true
    this.tcenter = new Vector2()
  }

  static tooldef() {
    return {
      inputs: ToolOp.inherit({
        meshPath      : new StringProperty('mesh'),
        propMode      : new EnumProperty(0, PropModes),
        propRadius    : new FloatProperty(0.1),
        propIslandOnly: new BoolProperty(false),
        propEnabled   : new BoolProperty(false),
      }),
      is_modal: true,
    }
  }

  static invoke(ctx, args) {
    let tool = super.invoke(ctx, args)
    let scene = ctx.scene

    if (!scene) {
      return tool
    }

    if (!('propEnabled' in args)) {
      tool.inputs.propEnabled.setValue(scene.propEnabled)
    }

    if (!('propMode' in args)) {
      tool.inputs.propMode.setValue(scene.propMode)
    }

    if (!('propRadius' in args)) {
      tool.inputs.propRadius.setValue(scene.propRadius)
    }

    if (!('propIslandOnly' in args)) {
      tool.inputs.propIslandOnly.setValue(scene.propIslandOnly)
    }

    return tool
  }

  modalStart(ctx) {
    this.first = true
    return super.modalStart(ctx)
  }

  modalEnd(was_cancelled) {
    this.tdata = undefined //prevent reference leak in undo stack
    super.modalEnd(was_cancelled)
  }

  on_mousemove(e) {
    let ctx = this.modal_ctx
    let uveditor = ctx.editors.imageEditor

    if (!uveditor) {
      console.log('no UV editor')
      this.modalEnd(true)
    }

    uveditor = uveditor.uvEditor
    let mpos = uveditor.getLocalMouse(e.x, e.y)

    if (this.first) {
      this.first = false
      this.start_mpos.load(mpos)
      this.last_mpos.load(mpos)
      return
    }

    this.mpos.load(mpos)

    this.doMouseMove(this.mpos, this.start_mpos, this.last_mpos, uveditor)
    uveditor.flagRedraw()

    this.last_mpos.load(mpos)
  }

  doMouseMove(mpos, start_mpos, last_mpos, uveditor) {
    let ctx = this.modal_ctx
  }

  getMesh(ctx) {
    if (!ctx) {
      return
    }

    return ctx.api.getValue(ctx, this.inputs.meshPath.getValue())
  }

  on_mouseup(e) {
    let cancel = !eventWasTouch(e) && e.button === 2

    this.modalEnd(cancel)
  }

  on_keydown(e) {
    super.on_keydown(e)
  }

  getTransData(ctx) {
    if (!this.tdata) {
      this.genTransData(ctx)
    }

    return this.tdata
  }

  getTransCenter(ctx, tdata = this.tdata) {
    let cent = new Vector2()
    let tot = 0.0
    let min = new Vector2().addScalar(1e17)
    let max = new Vector2().addScalar(-1e17)

    for (let td of tdata) {
      if (td.w > 0.9999) {
        cent.add(td.uv)
        tot++

        min.min(td.uv)
        max.max(td.uv)
      }
    }

    if (tot > 0) {
      cent.mulScalar(1.0 / tot)
    }

    //return cent;
    return min.interp(max, 0.5)
  }

  genTransData(ctx) {
    let mesh = this.getMesh(ctx)
    this.tdata = []

    if (!mesh) {
      return
    }

    let cd_uv = mesh.loops.customData.getLayerIndex('uv')
    if (cd_uv < 0) {
      return
    }

    let propmode = this.inputs.propMode.getValue()
    let doprop = this.inputs.propEnabled.getValue()
    let propisland = this.inputs.propIslandOnly.getValue()
    let propradius = this.inputs.propRadius.getValue()

    console.log('UV TRANSFORM', propmode, doprop, propisland, propradius)

    if (doprop) {
      let islands, faces
      let wr

      if (propisland) {
        islands = new Set()
        faces = new Set()

        for (let l of this.getLoops(ctx, false)) {
          faces.add(l.f)
        }

        wr = new UVWrangler(mesh, faces)
        wr.buildIslands(false)

        for (let l of this.getLoops(ctx, true)) {
          let island = wr.islandLoopMap.get(l)
          islands.add(island)
        }
      }

      console.log('ISLANDS', islands)

      let ls = new Set()
      for (let f of mesh.faces.selected.editable) {
        for (let l of f.loops) {
          if (!(l.flag & MeshFlags.HIDE)) {
            ls.add(l)
          }
        }
      }

      for (let l1 of ls) {
        let uv1 = l1.customData[cd_uv].uv

        if (l1.flag & MeshFlags.SELECT) {
          let td = new TransLoop(l1, uv1)
          this.tdata.push(td)
          continue
        }

        if (propisland && !islands.has(wr.islandLoopMap.get(l1))) {
          continue
        }

        let mindis = undefined

        for (let l2 of ls) {
          if (propisland && !islands.has(wr.islandLoopMap.get(l2))) {
            continue
          }
          if (l1 === l2 || !(l2.flag & MeshFlags.SELECT)) {
            continue
          }

          let uv2 = l2.customData[cd_uv].uv
          let dis = uv1.vectorDistance(uv2)

          //console.log(dis);

          if (dis < propradius && (mindis === undefined || dis < mindis)) {
            mindis = dis
          }
        }

        if (mindis === undefined) {
          continue
        }

        let td = new TransLoop(l1, uv1)
        td.w = mindis / propradius
        td.w = TransDataType.calcPropCurve(td.w, propmode, propradius)
        this.tdata.push(td)

        //console.log("FOUND loop", l1, td.w);
      }
    } else {
      for (let l of this.getLoops(ctx, true)) {
        let uv = l.customData[cd_uv].uv

        this.tdata.push(new TransLoop(l, uv))
      }
    }

    this.tcenter = this.getTransCenter(ctx, this.tdata)
  }

  calcUndoMem(ctx) {
    let tot = 0
    let ud = this._undo

    return ud.list.length * 8
  }

  undoPre(ctx) {
    this.genTransData(ctx)

    this._undo = {}

    let mesh = this.getMesh(ctx)

    if (!mesh) {
      return
    }

    let cd_uv = mesh.loops.customData.getLayerIndex('uv')
    if (cd_uv < 0) {
      console.log('no uvs')
      return
    }

    let list = []

    this._undo.mesh = mesh.lib_id
    this._undo.cd_uv = cd_uv
    this._undo.list = list

    for (let td of this.tdata) {
      let l = td.l

      list.push(l.eid)
      list.push(td.startuv[0])
      list.push(td.startuv[1])
    }
  }

  undo(ctx) {
    if (!this._undo || !this._undo.mesh) {
      return
    }

    let mesh = ctx.datalib.get(this._undo.mesh)

    if (!mesh) {
      console.warn('failed to lookup mesh')
      return
    }

    let list = this._undo.list
    let cd_uv = this._undo.cd_uv

    for (let i = 0; i < list.length; i += 3) {
      let l = list[i],
        u = list[i + 1],
        v = list[i + 2]

      l = mesh.eidMap.get(l)
      if (!l || l.type !== MeshTypes.LOOP) {
        console.warn('Missing element ' + list[i])
        continue
      }

      let uv = l.customData[cd_uv].uv

      l.f.flag |= MeshFlags.UPDATE

      uv[0] = u
      uv[1] = v
    }

    mesh.regenRender()
    mesh.regenUVEditor()
    window.redraw_viewport(true)
  }

  updateMesh(mesh) {
    mesh.regenUVEditor()
    mesh.regenRender()

    for (let td of this.tdata) {
      td.l.f.flag |= MeshFlags.UPDATE
    }

    window.redraw_viewport(true)
  }

  execPost() {
    this.tdata = undefined //prevent reference leak in undo stack
  }
}

export class UVTranslateOp extends UVTransformOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname  : 'Translate',
      toolpath: 'uveditor.translate',
      inputs: ToolOp.inherit({
        offset: new Vec2Property(),
      }),
      is_modal: true,
    }
  }

  doMouseMove(mpos, start_mpos, last_mpos, uveditor) {
    let ctx = this.modal_ctx

    //console.log("mouse move!", mpos, start_mpos, last_mpos, uveditor);
    let off = new Vector2(mpos).sub(start_mpos)
    this.inputs.offset.setValue(off)

    this.exec(this.modal_ctx)
  }

  exec(ctx) {
    let mesh = this.getMesh(ctx)

    if (!mesh) {
      return
    }

    let tdata = this.getTransData(ctx)
    let offset = this.inputs.offset.getValue()

    for (let td of tdata) {
      td.uv[0] = td.startuv[0] + offset[0] * td.w
      td.uv[1] = td.startuv[1] + offset[1] * td.w
    }

    this.updateMesh(mesh)
  }
}
ToolOp.register(UVTranslateOp)

export class UVScaleOp extends UVTransformOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname  : 'Scale',
      toolpath: 'uveditor.scale',
      inputs: ToolOp.inherit({
        scale: new Vec2Property([1, 1]),
      }),
      is_modal: true,
    }
  }

  doMouseMove(mpos, start_mpos, last_mpos, uveditor) {
    let ctx = this.modal_ctx

    let l1 = start_mpos.vectorDistance(this.tcenter)
    let l2 = mpos.vectorDistance(this.tcenter)

    console.log('l1, l2', l1, l2)

    if (l1 === 0.0) {
      return
    }

    let ratio = l2 / l1
    this.inputs.scale.setValue([ratio, ratio])

    //console.log("mouse move!", mpos, start_mpos, last_mpos, uveditor);

    //this.inputs.scale.setValue(off);

    this.exec(this.modal_ctx)
  }

  exec(ctx) {
    let mesh = this.getMesh(ctx)

    if (!mesh) {
      return
    }

    let tdata = this.getTransData(ctx)
    let scale = this.inputs.scale.getValue()

    let cent = this.tcenter
    let uv = new Vector2()

    for (let td of tdata) {
      uv.load(td.startuv).sub(cent).mul(scale).add(cent)
      uv.interp(td.startuv, 1.0 - td.w)

      td.uv[0] = uv[0]
      td.uv[1] = uv[1]
    }

    this.updateMesh(mesh)
  }
}
ToolOp.register(UVScaleOp)

export class UVRotateOp extends UVTransformOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname  : 'Rotate',
      toolpath: 'uveditor.rotate',
      inputs: ToolOp.inherit({
        rotation: new FloatProperty(0.0),
      }),
      is_modal: true,
    }
  }

  doMouseMove(mpos, start_mpos, last_mpos, uveditor) {
    let ctx = this.modal_ctx

    let v1 = new Vector2(last_mpos).sub(this.tcenter)
    let v2 = new Vector2(mpos).sub(this.tcenter)

    let th1 = Math.atan2(v1[1], v1[0])
    let th2 = Math.atan2(v2[1], v2[0])

    let th = this.inputs.rotation.getValue()

    v1.normalize()
    v2.normalize()

    th += Math.asin((v1[0] * v2[1] - v1[1] * v2[0]) * 0.999999)
    //th += th2 - th1;
    this.inputs.rotation.setValue(th)

    console.log('th', th)

    this.exec(this.modal_ctx)
  }

  exec(ctx) {
    let mesh = this.getMesh(ctx)

    if (!mesh) {
      return
    }

    let tdata = this.getTransData(ctx)
    let th = this.inputs.rotation.getValue()

    let cent = this.tcenter
    let uv = new Vector2()

    let steps = Math.floor(Math.abs(th) / Math.PI)

    for (let td of tdata) {
      uv.load(td.startuv).sub(cent).rot2d(th).add(cent)
      uv.interp(td.startuv, 1.0 - td.w)

      td.uv[0] = uv[0]
      td.uv[1] = uv[1]
    }

    this.updateMesh(mesh)
  }
}
ToolOp.register(UVRotateOp)
