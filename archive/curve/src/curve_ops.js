import {MeshOp} from '../../mesh/src/mesh_ops_base.js'
import {ToolOp} from '@framework/pathux'

export class CurveOp extends MeshOp {
  static tooldef() {
    return {
      inputs : ToolOp.inherit({}),
      outputs: ToolOp.inherit({}),
    }
  }
}
