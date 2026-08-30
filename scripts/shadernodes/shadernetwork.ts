import {DataBlock} from '../core/lib_api.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import type {BlockLoader, BlockLoaderAddUser} from '../core/lib_api.js'
import {Graph, INodeSocketSet} from '../core/graph.js'
import {nstructjs, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import type {StructReader} from '../path.ux/scripts/util/nstructjs.js'

import {DependSocket, Vec3Socket, Vec4Socket, FloatSocket, IntSocket, BoolSocket} from '../core/graphsockets.js'
import * as util from '../util/util.js'
import {OutputNode, DiffuseNode, type IRenderLights} from './shader_nodes.js'
import {WgslShaderGenerator, type RequestedAttrDesc} from './shader_nodes_wgsl.js'

/**
 * WebGPU-side compiled material shader. Holds the emitted WGSL source +
 * the generator (for re-running `setMaterialUniforms` per frame). The
 * actual `Pipeline` lifetime is owned by the WebGPU draw queue; this
 * struct just carries everything needed to build one.
 */
export interface IWgslShaderDef {
  wgsl: string
  generator: WgslShaderGenerator
  setUniforms: (graph: Graph<unknown>, uniforms: Record<string, unknown>) => void
  /** Geometry attributes this material reads, slot-ordered. The renderengine
   * hands this set to sculptcore (one vertex buffer per entry, by name). */
  requestedAttrs: RequestedAttrDesc[]
}

export {ShaderNetworkClass, ShaderNodeTypes} from './shader_nodes.js'

export const MaterialFlags = {
  SELECT: 1,
}

export const ShadowFlags = {
  NO_SHADOWS: 1,
}

export class ShadowSettings {
  bias: number
  flag: number
  static STRUCT: string

  constructor() {
    this.bias = 1.0
    this.flag = 0
  }

  copyTo(b: ShadowSettings) {
    b.bias = this.bias
    b.flag = this.flag
  }

  copy() {
    const ret = new ShadowSettings()

    this.copyTo(ret)

    return ret
  }
}

ShadowSettings.STRUCT = `
ShadowSettings {
  bias : float;
  flag : int;
}
`
nstructjs.register(ShadowSettings)

export class ShaderNetwork extends DataBlock {
  shadow: ShadowSettings
  flag: number
  graph: Graph<unknown>
  _regen: number | boolean
  _last_update_hash?: number
  // used by renderengine_realtime.ts
  _shadergen?: number
  usedNodes: Set<{graph_id: number; inputs: INodeSocketSet; outputs: INodeSocketSet}>
  updateHash: number

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
ShaderNetwork {
  graph    : graph.Graph;
  flag     : int;
  shadow   : ShadowSettings;
}
  `
  )

  constructor() {
    super()

    this.shadow = new ShadowSettings()
    this.flag = 0
    this.graph = new Graph()
    this.graph.onFlagResort = this._on_flag_resort.bind(this)
    this._regen = true

    this._last_update_hash = undefined //is set by RenderEngine code

    this.updateHash = 0
    this.usedNodes = new Set() //pruned list of nodes that contribute to shader code
  }

  copy(addLibUsers = false, owner?: DataBlock) {
    const ret = super.copy(addLibUsers, owner)

    ret.graph = this.graph.copy(addLibUsers)
    ret.shadow = this.shadow.copy()
    ret.flag = this.flag

    return ret
  }

  copyTo(b: this, arg?: boolean) {
    super.copyTo(b, arg)

    b.flag = this.flag
    this.shadow.copyTo(b.shadow)
  }

  getUsedNodes() {
    let out

    for (const node of this.graph.nodes) {
      if (node instanceof OutputNode) {
        out = node
        break
      }
    }

    type ShaderNetNode = {graph_id: number; inputs: INodeSocketSet; outputs: INodeSocketSet}
    const ret = new Set<ShaderNetNode>()

    const rec = (n: ShaderNetNode) => {
      if (ret.has(n)) {
        return
      }

      ret.add(n)

      for (const k in n.inputs) {
        const sock = n.inputs[k]

        for (const e of sock.edges) {
          rec(e.node)
        }
      }
    }

    if (out) {
      rec(out)
    }

    return ret
  }

  calcUpdateHash() {
    const hash = new util.HashDigest()
    for (const node of this.usedNodes) {
      hash.add(node.graph_id)

      for (let i = 0; i < 2; i++) {
        const socks = i ? node.outputs : node.inputs

        for (const k in socks) {
          const sock = socks[k]

          if (sock.edges.length === 0) {
            if (sock instanceof FloatSocket) {
              hash.add(sock.value)
            } else if (sock instanceof IntSocket) {
              hash.add(sock.value)
            } else if (sock instanceof BoolSocket) {
              hash.add(Number(sock.value) * i)
            } else if (sock instanceof Vec3Socket) {
              hash.add(sock.value[0] * 1000.0)
              hash.add(sock.value[1] * 1000.0)
              hash.add(sock.value[2] * 1000.0)
            } else if (sock instanceof Vec4Socket) {
              hash.add(sock.value[0] * 1000.0)
              hash.add(sock.value[1] * 1000.0)
              hash.add(sock.value[2] * 1000.0)
              hash.add(sock.value[3] * 1000.0)
            }
          } else {
            for (const e of sock.edges) {
              hash.add(e.graph_id)
            }
          }
        }
      }
    }

    return hash.get()
  }
  /*helpers for data api*/

  _on_flag_resort() {
    this.usedNodes = this.getUsedNodes()
    this._regen = 1
  }

  flagRegen() {
    this._regen = 1
  }

  dataLink(getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    super.dataLink(getblock, getblock_addUser)
    this.graph.dataLink(this, getblock, getblock_addUser)
  }

  /**
   * Emits a WGSL fragment shader from
   * the same shader-node graph for the WebGPU backend. Called from the
   * WebGPU draw path when this material is bound to a drawable.
   */
  generateWgsl(
    scene: unknown,
    rlights: IRenderLights,
    defines: Record<string, number | string | boolean> = {}
  ): IWgslShaderDef {
    if (scene === undefined) {
      throw new Error('scene cannot be undefined')
    }

    this._regen = false
    this.usedNodes = this.getUsedNodes()

    const gen = new WgslShaderGenerator(scene)
    gen.generate(this.graph, rlights, defines)

    return {
      wgsl          : gen.wgsl!,
      generator     : gen,
      setUniforms   : (graph, uniforms) => gen.setMaterialUniforms(graph, uniforms),
      requestedAttrs: gen.getRequestedAttrs(),
    }
  }

  static nodedef() {
    return {
      uiname : 'Shader Network',
      name   : 'shadernetwork',
      inputs : {},
      outputs: {
        onTopologyChange: new DependSocket('onTopologyChange'),
      },
    }
  }

  static blockDefine() {
    return {
      typeName   : 'shadernetwork',
      defaultName: 'Shader Network',
      uiName     : 'Shader Network',
      flag       : 0,
      icon       : -1,
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const mstruct = DataBlock.defineAPI(api, struct ?? api.mapStruct(this, true))

    mstruct.struct('graph', 'graph', 'Shader Graph', api.getStruct(Graph))

    return mstruct
  }

  loadSTRUCT(reader: StructReader) {
    super.loadSTRUCT(reader)
    reader(this)

    this.graph.onFlagResort = this._on_flag_resort.bind(this)
  }
}

DataBlock.register(ShaderNetwork)

export function makeDefaultShaderNetwork() {
  const sn = new ShaderNetwork()

  const out = new OutputNode()
  sn.graph.add(out)

  const shader = new DiffuseNode()
  sn.graph.add(shader)

  shader.outputs.surface.connect(out.inputs.surface)

  shader.graph_ui_pos[0] -= 100
  out.graph_ui_pos[0] += 300

  return sn
}

registerDataAPI(ShaderNetwork)
