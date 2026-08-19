import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as math from '../util/math.js'
import {
  nstructjs,
  ToolOp,
  FloatProperty,
  IntProperty,
  BoolProperty,
  EnumProperty,
  FlagProperty,
} from '../path.ux/scripts/pathux.js'
import {ImplicitWireGen} from './wiregen.js'
import {TetMesh} from './tetgen.js'

export class SolidWireOp extends ToolOp {
  static tooldef() {
    return {
      uiname  : 'Wireframe Solidify',
      toolpath: 'tet.solidify_wireframe',
      inputs: {
        size    : new FloatProperty(0.3).saveLastValue(),
        maxDepth: new IntProperty(5),
        minDepth: new IntProperty(3),
        project : new BoolProperty(false),
      },
    }
  }

  static canRun(ctx) {
    let ok = ctx.object
    ok = ok && ctx.object.data instanceof Mesh

    return ok
  }

  exec(ctx) {
    console.log('Wireframe Solidify')

    let ob = ctx.object
    let mesh = ob.data

    let size = this.inputs.size.getValue()
    let minDepth = this.inputs.maxDepth.getValue()
    let maxDepth = this.inputs.minDepth.getValue()
    let project = this.inputs.project.getValue()

    let tm = new TetMesh()
    ctx.datalib.add(tm)

    let gen = new ImplicitWireGen(mesh, size, mesh.edges, minDepth, maxDepth)
    gen.projectVerts = project
    gen.generate(tm)

    if (0) {
      let d = 1
      let v1 = new Vector3([-d, -d, 0])
      let v2 = new Vector3([-d, d, 0])
      let v3 = new Vector3([d, d, 0])
      let v4 = new Vector3([0, 0, d])

      v1 = tm.makeVertex(v1)
      v2 = tm.makeVertex(v2)
      v3 = tm.makeVertex(v3)
      v4 = tm.makeVertex(v4)

      tm.makeTet(v1, v2, v3, v4)
      tm.recalcNormals()
      tm.flagSurfaceFaces()
    }
    mesh.lib_remUser(ob)
    tm.lib_addUser(ob)

    ob.data = tm
    ob.graphUpdate()
    tm.graphUpdate()

    window.updateDataGraph(true)
    window.redraw_viewport()
  }
}

ToolOp.register(SolidWireOp)
