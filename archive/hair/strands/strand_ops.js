import {
  ToolOp,
  BoolProperty,
  FloatProperty,
  EnumProperty,
  FlagProperty,
  IntProperty,
} from '../path.ux/scripts/pathux.js'
import {DataRefProperty} from '../core/lib_api.js'
import {SceneObject} from '../sceneobject/sceneobject.js'
import {Mesh} from '../../addons/builtin/mesh/src/mesh.js'
import {StrandSet} from './strand.js'

export class MakeStrandSetOp extends ToolOp {
  static tooldef() {
    return {
      uiname  : 'Make Strands',
      toolpath: 'strand.create',
      inputs: {
        target   : new DataRefProperty(SceneObject),
        setActive: new BoolProperty(false),
      },
      outputs: {
        newObject: new DataRefProperty(SceneObject),
      },
    }
  }

  static invoke(ctx, args) {
    let tool = super.invoke(ctx, args)

    if (!('target' in args)) {
      let ob = ctx.object

      if (ob && ob.data instanceof Mesh) {
        this.inputs.target.setValue(ob.data)
      }
    }

    return tool
  }

  exec(ctx) {
    let strandset = new StrandSet()
    ctx.datalib.add(strandset)

    let ob = new SceneObject()
    ctx.datalib.add(ob)

    strandset.lib_addUser(ob)
    ob.data = strandset

    let target = ctx.datalib.get(this.inputs.target.getValue())
    let scene = ctx.scene

    strandset.target = target

    scene.add(ob)
    scene.objects.setSelect(ob, true)

    if (this.inputs.setActive.getValue()) {
      scene.objects.setActive(ob)
    }

    window.redraw_viewport()
    window.updateDataGraph(true)
  }
}
ToolOp.register(MakeStrandSetOp)
