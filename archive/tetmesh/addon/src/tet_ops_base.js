import {Vector2, Vector3, Vector4, Matrix4, Quat} from '@framework/api'
import {util} from '@framework/api'
import {
  nstructjs,
  ToolOp,
  BoolProperty,
  IntProperty,
  EnumProperty,
  FlagProperty,
  FloatProperty,
  Vec3Property,
  Vec2Property,
  StringProperty,
} from '@framework/pathux'
import {TetTypes, TetFlags, TetRecalcFlags, TetMesh} from '@framework/api'

export function saveUndoTetMesh(mesh) {
  let data = []

  nstructjs.manager.write_object(data, mesh)

  return {
    dview: new DataView(new Uint8Array(data).buffer),
  }
}

export function loadUndoTetMesh(ctx, data) {
  let datalib = ctx.datalib

  let mesh = nstructjs.manager.read_object(data.dview, TetMesh)

  //XXX hackish! getblock[_us] copy/pasted code!
  let getblock = (ref) => {
    return datalib.get(ref)
  }

  let getblock_us = (ref) => {
    let ret = datalib.get(ref)

    if (ret !== undefined) {
      ret.lib_addUser(mesh)
    }

    return ret
  }

  mesh.dataLink(getblock, getblock_us)
  return mesh
}

export class TetMeshOp extends ToolOp {
  constructor() {
    super()
  }

  getMeshes(ctx) {
    let ob = ctx.object

    if (!ob || !(ob.data instanceof TetMesh)) {
      return []
    }

    return [ob.data]
  }

  calcUndoMem(ctx) {
    if (!this._undo) {
      return 0
    }

    let tot = 0

    for (let id in this._undo) {
      let data = this._undo[id]

      tot += data.dview.buffer.byteLength
    }

    return tot
  }

  undoPre(ctx) {
    let undo = (this._undo = {})

    for (let tm of this.getMeshes(ctx)) {
      undo[tm.lib_id] = saveUndoTetMesh(tm)
    }

    window.redraw_viewport(true)
  }

  undo(ctx) {
    for (let k in this._undo) {
      let tm = ctx.datalib.get(parseInt(k))
      if (!tm) {
        console.warn('Failed to load tet mesh ' + k)
        continue
      }

      let tm2 = loadUndoTetMesh(ctx, this._undo[k])

      tm.swapDataBlockContents(tm2)
      tm.regenAll()
      tm.graphUpdate()
    }

    window.redraw_viewport(true)
  }
}

let VEID = 0,
  VX = 1,
  VY = 2,
  VZ = 3,
  VNX = 4,
  VNY = 5,
  VNZ = 6,
  VFLAG = 7,
  VTOT = 8
let FEID = 0,
  FX = 1,
  FY = 2,
  FZ = 3,
  FNX = 4,
  FNY = 5,
  NFNZ = 6,
  FFLAG = 7,
  FTOT = 8

export class TetDeformOp extends ToolOp {
  getMeshes(ctx) {
    let ob = ctx.object
    if (!ob || !(ob.data instanceof TetMesh)) {
      return []
    }

    return [ob.data]
  }

  undoPre(ctx) {
    let undo = (this._undo = [])

    for (let mesh of this.getMeshes(ctx)) {
      let ud = {
        mesh : mesh.lib_id,
        verts: [],
        faces: [],
      }
      undo.push(ud)

      let vs = ud.verts
      let fs = ud.faces

      for (let v of mesh.verts) {
        vs.push(v.eid)

        for (let i = 0; i < 3; i++) {
          vs.push(v[i])
        }
        for (let i = 0; i < 3; i++) {
          vs.push(v.no[i])
        }

        vs.push(v.flag)
      }
    }
  }

  undo(ctx) {
    let undo = this._undo
    for (let ud of undo) {
      let mesh = ctx.datalib.get(ud.mesh)
      if (!mesh) {
        console.warn('failed to lookup tet mesh ' + ud.mesh)
        continue
      }

      let vs = ud.verts
      for (let i = 0; i < vs.length; i += VTOT) {
        let eid = vs[i],
          flag = vs[i + VFLAG]

        let v = mesh.eidMap.get(eid)

        if (!v || v.type !== TetTypes.VERTEX) {
          console.warn('Failed to lookup vertex ' + eid, v)
          continue
        }

        v[0] = vs[i + 1]
        v[1] = vs[i + 2]
        v[2] = vs[i + 3]
        v.no[0] = vs[i + 4]
        v.no[1] = vs[i + 5]
        v.no[2] = vs[i + 6]

        mesh.verts.setSelect(v, v.flag & TetFlags.SELECT)

        v.flag = flag | TetFlags.UPDATE

        mesh.regenRender()
        mesh.graphUpdate()
      }
    }

    window.redraw_viewport(true)
  }
}
