import {Vector2, Vector3, Vector4, Matrix4, Quat} from '@framework/api'
import {util} from '@framework/api'
import {math} from '@framework/api'
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
import {meshToTetMesh, vertexSmooth, tetMeshToMesh, tetrahedralizeMesh, tetSolve} from '@framework/api'
import {Mesh, saveUndoMesh, loadUndoMesh} from '@addon/mesh/api'
import {saveUndoTetMesh, loadUndoTetMesh, TetDeformOp, TetMeshOp} from './tet_ops_base.js'

function makeCube(tm = new TetMesh()) {
  let d = 0.5
  let vs = [
    [-d, -d, -d],
    [-d, d, -d],
    [d, d, -d],
    [d, -d, -d],

    [-d, -d, d],
    [-d, d, d],
    [d, d, d],
    [d, -d, d],
  ]

  for (let i = 0; i < vs.length; i++) {
    vs[i] = tm.makeVertex(vs[i])
  }

  tm.makeHex.apply(tm, vs)

  return tm
}

export class MakeTetMesh extends ToolOp {
  static tooldef() {
    return {
      uiname  : 'Convert Mesh to Tet Mesh',
      toolpath: 'tet.from_mesh',
      inputs: {
        maxDepth : new IntProperty(5).setRange(0, 10),
        leafLimit: new IntProperty(32).setRange(1, 1024),
      },
      outputs : {},
    }
  }

  static canRun(ctx) {
    return ctx.object && ctx.object.data instanceof Mesh
  }

  calcUndoMem(ctx) {
    return 0
  }

  undoPre(ctx) {
    let ob = ctx.object

    this._undo = {
      mesh: saveUndoMesh(ob.data),
      ob  : ob.lib_id,
    }
  }

  undo(ctx) {
    let ud = this._undo

    let mesh2 = loadUndoMesh(ctx, ud.mesh)

    let mesh = ctx.datalib.get(mesh2.lib_id)

    if (mesh) {
      mesh.swapDataBlockContents(mesh2)
    } else {
      mesh = mesh2.copy()

      mesh.lib_id = -1
      ctx.datalib.add(mesh)
    }

    let ob = ctx.datalib.get(ud.ob)

    ob.lib_remUser(ob.data)
    ctx.datalib.remove(ob.data)

    ob.data = mesh
    mesh.lib_addUser(ob)

    mesh.regenTessellation()
    mesh.regenAll()
    mesh.graphUpdate()

    ob.graphUpdate()

    window.updateDataGraph()
    window.redraw_viewport(true)
  }

  exec(ctx) {
    let ob = ctx.object

    ob.lib_remUser(ob.data)
    let tm = new TetMesh()

    let found = false
    for (let ob2 of ctx.scene.objects) {
      if (ob !== ob && ob2.data === ob.data) {
        found = true
      }
    }

    if (!found) {
      console.log('destroying temporary data for old mesh')
      ob.data.destroy()
    }

    meshToTetMesh(ob.data, tm, this.inputs.maxDepth.getValue(), this.inputs.leafLimit.getValue())

    ctx.datalib.add(tm)
    tm.lib_addUser(ob)
    ob.data = tm

    ob.graphUpdate()
    tm.graphUpdate()
    tm.regenAll()
    window.updateDataGraph()
    window.redraw_viewport(true)
  }
}

export class TetSmoothVerts extends TetDeformOp {
  static tooldef() {
    return {
      uiname  : 'Vertex Smooth (Tet Mesh)',
      toolpath: 'tet.vertex_smooth',
      inputs: {
        factor: new FloatProperty(0.5),
      },
      outputs : {},
    }
  }

  exec(ctx) {
    let fac = this.inputs.factor.getValue()

    for (let mesh of this.getMeshes(ctx)) {
      vertexSmooth(mesh, mesh.verts, fac)

      mesh.recalcStartLengths()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class TetToMesh extends ToolOp {
  static tooldef() {
    return {
      uiname  : 'Convert Tet Mesh to Mesh',
      toolpath: 'tet.to_mesh',
      inputs  : {},
      outputs : {},
    }
  }

  static canRun(ctx) {
    return ctx.object && ctx.object.data instanceof TetMesh
  }

  calcUndoMem(ctx) {
    return 0
  }

  undoPre(ctx) {
    let ob = ctx.object

    this._undo = {
      mesh: saveUndoTetMesh(ob.data),
      ob  : ob.lib_id,
    }
  }

  undo(ctx) {
    let ud = this._undo

    let mesh2 = loadUndoTetMesh(ctx, ud.mesh)

    let mesh = ctx.datalib.get(mesh2.lib_id)

    if (mesh) {
      mesh.swapDataBlockContents(mesh2)
    } else {
      mesh = mesh2 //.copy();

      mesh.lib_id = -1
      ctx.datalib.add(mesh)
    }

    let ob = ctx.datalib.get(ud.ob)

    ob.lib_remUser(ob.data)
    ctx.datalib.remove(ob.data)

    ob.data = mesh
    mesh.lib_addUser(ob)

    mesh.regenAll()
    mesh.graphUpdate()

    ob.graphUpdate()

    window.updateDataGraph()
    window.redraw_viewport(true)
  }

  exec(ctx) {
    let ob = ctx.object

    ob.lib_remUser(ob.data)

    let mesh = new Mesh()

    //let tm = new TetMesh();
    tetMeshToMesh(ob.data, mesh)
    //meshToTetMesh(ob.data, tm, this.inputs.maxDepth.getValue(), this.inputs.leafLimit.getValue());

    ctx.datalib.add(mesh)
    mesh.lib_addUser(ob)
    ob.data = mesh

    ob.graphUpdate()
    mesh.graphUpdate()
    mesh.regenAll()
    window.updateDataGraph()
    window.redraw_viewport(true)
  }
}

export class Tetrahedralize extends TetMeshOp {
  static tooldef() {
    return {
      uiname  : 'Tetrahedralize',
      toolpath: 'tet.hexes_to_tets',
      inputs  : ToolOp.inherit(),
    }
  }

  exec(ctx) {
    for (let tm of this.getMeshes(ctx)) {
      tetrahedralizeMesh(tm)

      tm.regenAll()
      tm.graphUpdate()
      tm.recalcNormals()

      window.updateDataGraph()
      window.redraw_viewport(true)
    }
  }
}

export class TetTest extends TetDeformOp {
  static tooldef() {
    return {
      uiname  : 'Tet Test',
      toolpath: 'tet.test',
      inputs  : ToolOp.inherit(),
    }
  }

  exec(ctx) {
    for (let tm of this.getMeshes(ctx)) {
      for (let v of tm.verts) {
        v.w = 1.0
      }

      tetSolve(tm)

      tm.regenAll()
      //tm.regenNormals();
      tm.graphUpdate()

      window.updateDataGraph()
      window.redraw_viewport(true)
    }
  }
}

function fixNormals(tm) {
  let cent = new Vector3()
  let n = new Vector3()

  for (let c of tm.cells) {
    cent.zero()
    let tot = 0

    for (let v of c.verts) {
      cent.add(v)
      tot++
    }

    cent.mulScalar(1.0 / tot)

    for (let f of c.faces) {
      n.load(f.cent).sub(cent)

      if (f.no.dot(n) < 0) {
        tm.reverseFaceWinding(f)
      }
    }
  }
}

export class TetFixNormalsOp extends TetMeshOp {
  static tooldef() {
    return {
      uiname  : 'Fix Normals (Tet Mesh)',
      toolpath: 'tet.fix_normals',
    }
  }

  exec(ctx) {
    for (let tm of this.getMeshes(ctx)) {
      fixNormals(tm)

      tm.regenAll()
      tm.recalcNormals()
      tm.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}
