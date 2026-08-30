import {BlockLoader, BlockLoaderAddUser, DataBlock} from './lib_api'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import {nstructjs, ToolOp, IntProperty, StringProperty, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'

import {Icons} from '../editors/icon_enum.js'
import {ShaderNetwork} from '../shadernodes/shadernetwork.js'
import {DiffuseNode, GeometryNode, OutputNode} from '../shadernodes/shader_nodes.js'
import type {ToolContext} from './context'
import type {StructReader} from '../path.ux/scripts/util/nstructjs'

export function makeDefaultMaterial() {
  const mat = new Material()

  const diff = new DiffuseNode()
  const output = new OutputNode()
  const geom = new GeometryNode()

  mat.graph.add(geom)
  mat.graph.add(diff)
  mat.graph.add(output)

  geom.graph_ui_pos[0] = -geom.graph_ui_size[0] * 2 - 5
  output.graph_ui_pos[0] = diff.graph_ui_size[0] * 2 + 5

  geom.outputs.normal.connect(diff.inputs.normal)
  diff.outputs.surface.connect(output.inputs.surface)

  return mat
}

export class MakeMaterialOp extends ToolOp<
  {dataPathToSet: StringProperty; name: StringProperty},
  {materialID: IntProperty},
  ToolContext
> {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname     : 'Make Material',
      toolpath   : 'material.new',
      icon       : Icons.SMALL_PLUS,
      description: 'Create a new material',
      inputs: {
        dataPathToSet: new StringProperty(),
        name         : new StringProperty(''),
      },
      outputs: {
        materialID: new IntProperty(),
      },
    }
  }

  exec(ctx: ToolContext) {
    const mat = makeDefaultMaterial()
    const name = this.inputs.name.getValue()

    mat.name = name && name !== '' ? name : mat.name
    ctx.datalib.add(mat)

    const path = this.inputs.dataPathToSet.getValue()
    if (path) {
      const val = ctx.api.getValue<Material>(ctx, path)

      if (val !== undefined) {
        const meta = ctx.api.resolvePath(ctx, path)!
        val.lib_remUser(meta.obj as DataBlock)
      }

      ctx.api.setValue(ctx, path, mat)

      const meta = ctx.api.resolvePath(ctx, path)!
      mat.lib_addUser(meta.obj as DataBlock)
    }

    this.outputs.materialID.setValue(mat.lib_id)
  }
}

ToolOp.register(MakeMaterialOp)

export class UnlinkMaterialOp extends ToolOp<{dataPathToUnset: StringProperty}, {}, ToolContext> {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname     : 'Make Material',
      toolpath   : 'material.unlink',
      icon       : Icons.DELETE,
      description: 'Create a new material',
      inputs: {
        dataPathToUnset: new StringProperty(),
      },
    }
  }

  exec(ctx: ToolContext) {
    const meta = ctx.api.resolvePath(ctx, this.inputs.dataPathToUnset.getValue())
    const val = ctx.api.getValue<Material>(ctx, this.inputs.dataPathToUnset.getValue())

    if (val !== undefined) {
      val.lib_remUser(meta!.obj as DataBlock)
    }

    ctx.api.setValue(ctx, this.inputs.dataPathToUnset.getValue(), undefined)
  }
}

ToolOp.register(UnlinkMaterialOp)

export class MaterialFlags {}

export let DefaultMat: Material // eslint-disable-line prefer-const -- assigned once class Material is defined, below

export class Material extends ShaderNetwork {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
Material {
}
  `
  )

  constructor() {
    super()

    this.flag = 0
  }

  calcSettingsHash() {
    throw new Error('implement me')
  }

  /**
   * Checks if a material name "Default" exists in ctx.datalib and returns it,
   * otherwise it returns a frozen Material instance.
   * @param ctx : Context
   * @returns Material
   * */
  static getDefaultMaterial(ctx: ToolContext): Material {
    //look for material named Default
    const mat = ctx.datalib.getLibrary<Material>('material').get('Default')

    if (mat === undefined) {
      return DefaultMat
    }

    return mat
  }

  static blockDefine() {
    return {
      typeName   : 'material',
      defaultName: 'Material',
      uiName     : 'Material',
      flag       : 0,
      icon       : -1,
    }
  }

  static nodedef() {
    const superdef = super.nodedef()
    return {
      name   : 'material',
      uiname : 'Material',
      inputs : {...superdef.inputs},
      outputs: {...superdef.outputs},
    }
  }

  dataLink(getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    super.dataLink(getblock, getblock_addUser)
  }

  loadSTRUCT(reader: StructReader<this>) {
    super.loadSTRUCT(reader)
    reader(this)
  }

  // Chains super (ShaderNetwork.defineAPI) onto our own struct, declaring its
  // members directly here, so there's no dependency on ShaderNetwork being defined
  // first.
  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = super.defineAPI(api, struct ?? api.mapStruct(this, true))

    function getShaderNode(mat: any) {
      const graph = mat.graph
      let out

      for (const node of graph.nodes) {
        if (node instanceof OutputNode) {
          out = node
          break
        }
      }

      if (!out) {
        return undefined
      }

      for (const e of out.inputs.surface.edges) {
        return e.node
      }
    }

    const def = st.bool('', 'has_shader', 'Has Shader', 'Has Shader')

    def.customGetSet(function (this: {dataref: any}) {
      return getShaderNode(this.dataref) !== undefined
    }, undefined)

    st.dynamicStruct('', 'shader', 'Shading Node')
    //dynamicStruct return a struct, not the owning datapath

    // XXX properly type this
    const shaderDef = st.pathmap.shader
    shaderDef.customGetSet(function (this: {dataref: any}) {
      return getShaderNode(this.dataref)
    }, undefined)

    return st
  }
}

DataBlock.register(Material)
registerDataAPI(Material)

DefaultMat = Object.freeze(new Material())
