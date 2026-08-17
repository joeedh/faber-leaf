import {Vector2, Vector3, Vector4, Quat, Matrix4} from '../util/vectormath.js'
import {SimpleMesh, LayerTypes} from '../webgl/simplemesh.ts'
import {
  IntProperty,
  BoolProperty,
  FloatProperty,
  EnumProperty,
  FlagProperty,
  ToolProperty,
  Vec3Property,
  Mat4Property,
  PropFlags,
  PropTypes,
  PropSubTypes,
  ToolOp,
  ToolFlags,
  UndoFlags,
} from '../path.ux/scripts/pathux.js'
import {dist_to_line_2d} from '../path.ux/scripts/util/math.js'
import {CallbackNode, Node, NodeFlags} from '../core/graph.js'
import {DependSocket, Vec3Socket} from '../core/graphsockets.js'
import * as util from '../util/util.js'
import {SelMask} from '../core/select_types.js'
import {Icons} from '../editors/icon_enum.js'
import {SceneObject} from '../sceneobject/sceneobject.js'

import {Light, LightTypes, LightFlags} from './light.js'

export class AddLightOp extends ToolOp {
  constructor() {
    super()
  }

  static invoke(ctx, args) {
    let tool = new this()

    if (args.position === 'cursor') {
      let co = new Vector3()
      co.multVecMatrix(ctx.view3d.cursor3D)

      tool.inputs.position.setValue(co)
    }

    if ('type' in args) {
      tool.inputs.type.setValue(args.type)
    }

    return tool
  }

  static tooldef() {
    return {
      uiname     : 'Add Light',
      description: 'Add a new light',
      toolpath   : 'light.new',
      icon       : Icons.LIGHT,
      inputs: {
        position: new Vec3Property(),
        type    : new EnumProperty('POINT', LightTypes),
      },
    }
  }

  exec(ctx) {
    let light = new Light()
    light.type = this.inputs.type.getValue()

    ctx.datalib.add(light)

    let ob = new SceneObject()
    ob.data = light

    // Default placement is the scene 3D cursor; an explicit position input
    // (invoke args) still wins.
    let co = this.inputs.position.getValue()
    if (!this.inputs.position.wasSet && ctx.scene) {
      co = new Vector3()
      co.multVecMatrix(ctx.scene.cursor3D)
    }
    ob.inputs.loc.setValue(co)

    ctx.datalib.add(ob)

    let scene = ctx.scene
    scene.add(ob)

    scene.objects.clearSelection()
    scene.objects.setSelect(ob, true)
    ctx.scene.objects.setActive(ob)
  }
}

ToolOp.register(AddLightOp)
