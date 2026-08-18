import {SceneObjectData} from '../sceneobject/sceneobject_base.js'
import '../path.ux/scripts/util/struct.js'
import {DataBlock} from '../core/lib_api.js'
import {NodeFlags} from '../core/graph.js'
import {SelMask} from '../core/select_types.js'
import {Shaders} from '../shaders/shaders.js'
import {Shapes} from '../webgl/simplemesh_shapes.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'

export class NullObject extends SceneObjectData {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  nullobject.NullObject {
}
`
  )
  constructor() {
    super()
  }

  drawQ(view3d, queue, frame, object) {
    let program = frame.program
    if (program !== Shaders.MeshIDShader) {
      program = Shaders.WidgetMeshShader
      program.uniforms.color = object.getEditorColor()
    }

    program.uniforms.objectMatrix = object.outputs.matrix.getValue()
    frame.uniforms.objectMatrix = object.outputs.matrix.getValue()

    queue.submit({pipeline: program, mesh: Shapes.SPHERE})
  }

  drawIdsQ(view3d, queue, frame, selectMask, object) {
    this.drawQ(view3d, queue, frame, object)
  }

  static blockDefine() {
    return {
      typeName   : 'nullobject',
      defaultName: 'Null Object',
      uiName     : 'Null Object',
      icon       : -1,
      flag       : 0,
    }
  }

  static nodedef() {
    return {
      name   : 'NullObject',
      flag   : NodeFlags.SAVE_PROXY,
      inputs : {...super.nodedef().inputs},
      outputs: {...super.nodedef().outputs},
    }
  }

  static dataDefine() {
    return {
      name          : 'NullObject',
      selectMask    : SelMask.NULLOBJECT,
      selectTypeName: 'NULLOBJECT',
      tools         : undefined,
    }
  }
}

DataBlock.register(NullObject)
SceneObjectData.register(NullObject)
