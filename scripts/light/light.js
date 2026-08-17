import {DataBlock, DataRef} from '../core/lib_api.js'
import {nstructjs} from '../path.ux/pathux.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'

let STRUCT = nstructjs.STRUCT
import {Graph, Node, NodeFlags, SocketFlags} from '../core/graph.js'
import {Matrix4, Vector3, Vector4, Quat} from '../util/vectormath.js'
import {
  Vec3Socket,
  FloatSocket,
  DependSocket,
  Matrix4Socket,
  Vec4Socket,
  RGBASocket,
  RGBSocket,
} from '../core/graphsockets.js'
import {Shapes} from '../webgl/simplemesh_shapes.js'
import {Shaders} from '../shaders/shaders.js'
import {SceneObjectData} from '../sceneobject/sceneobject_base.js'
import {SelMask} from '../core/select_types.js'

export const LightFlags = {
  SELECT: 1,
  HIDE  : 2,
  LOCKED: 4,
}

export const LightTypes = {
  POINT    : 1,
  SUN      : 2,
  AREA_DISK: 4,
  AREA_RECT: 8,
  //SPOT      : 16
}

export class Light extends SceneObjectData {
  /** @type { number} */

  type
  constructor() {
    super()

    this.type = LightTypes.POINT
  }

  static blockDefine() {
    return {
      typeName   : 'light',
      defaultName: 'Light',
      uiName     : 'Light',
      flag       : 0,
      icon       : -1,
    }
  }

  static defineAPI(api, struct) {
    // Light layers its API at the DataBlock level (not SceneObjectData).
    return DataBlock.defineAPI(api, struct ?? api.mapStruct(this, true))
  }

  static nodedef() {
    return {
      name   : 'light',
      flag   : NodeFlags.SAVE_PROXY,
      inputs: {
        ...super.nodedef().inputs,
        color   : new RGBSocket('color', undefined, [1, 1, 1]),
        power   : new FloatSocket('power', undefined, 1.0),
        radius  : new FloatSocket('radius', undefined, 0.5),
        distance: new FloatSocket('distance', undefined, 50.0),
        depend  : new DependSocket(),
      },
      outputs: {...super.nodedef().outputs},
    }
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
Light {
  type     : int;
}
  `
  )

  /** @returns {[Vector3, Vector3]} */
  getBoundingBox() {
    let r = this.inputs.radius.getValue()
    r = Math.max(r, 0.1)

    return [new Vector3().addScalar(-r), new Vector3().addScalar(r)]
  }

  drawQ(view3d, queue, frame, object) {
    let program = frame.program
    if (program !== Shaders.MeshIDShader) {
      program = Shaders.WidgetMeshShader
      program.uniforms.color = object.getEditorColor()
    }

    program.uniforms.objectMatrix = object.outputs.matrix.getValue()
    frame.uniforms.objectMatrix = object.outputs.matrix.getValue()

    queue.submit({pipeline: program, mesh: Shapes.LIGHT})
  }

  drawIdsQ(view3d, queue, frame, selectMask, object) {
    this.drawQ(view3d, queue, frame, object)
  }

  copy() {
    let ret = new Light()
    this.copyTo(ret)

    ret.type = this.type

    return ret
  }

  copyAddUsers() {
    return this.copy()
  }

  static dataDefine() {
    return {
      name          : 'Light',
      selectMask    : SelMask.LIGHT,
      selectTypeName: 'LIGHT',
      dataKind      : 'light',
      //tools      :
    }
  }
}

DataBlock.register(Light)
SceneObjectData.register(Light)
registerDataAPI(Light)
