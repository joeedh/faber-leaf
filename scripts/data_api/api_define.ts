import {
  util,
  nstructjs,
  Vector2,
  Vector3,
  Vector4,
  Quat,
  Matrix4,
  ToolPropertyCache,
  buildToolSysAPI,
  BoundConstructor,
  CallbackThis,
} from '../path.ux/scripts/pathux.js'

import * as editors from '../editors/all.js'

import '../image/image_ops.js'
import '../image/image.js'
import '../light/light.js'
import '../light/light_ops.js'

import {ResourceBrowser} from '../editors/resbrowser/resbrowser.js'
import {resourceManager} from '../core/resource.js'
import '../core/image.js'
// CameraData self-registers at module scope; this side-effect import pulls it into
// the bundle.
import '../camera/camera.js'

import {NodeSocketClasses} from '../core/graph.js'

let STRUCT = nstructjs.STRUCT
import '../editors/view3d/widgets/widget_tools.js' //ensure widget tools are all registered
import {WidgetFlags} from '../editors/view3d/widgets/widgets.js'
import {AddLightOp} from '../light/light_ops.js'
import {Light} from '../light/light.js'
import {DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import {DataBlock, DataRef, Library, onBlockRegister, defineLibrarySet} from '../core/lib_api.js'
import {View3D} from '../editors/view3d/view3d.js'
import {View3DFlags, CameraModes} from '../editors/view3d/view3d_base.js'
import {App, buildEditorsAPI} from '../editors/editor_base.js'
import {NodeEditorBase} from '../editors/node/NodeEditor.js'
import {NodeViewer} from '../editors/node/NodeViewer.js'
import {MenuBarEditor} from '../editors/menu/MainMenu.js'
import {RGBASocket, Vec4Socket, Vec2Socket, Vec3Socket, FloatSocket} from '../core/graphsockets.js'
import {VelPan, VelPanFlags} from '../editors/velpan.js'
import {SelMask} from '../core/select_types.js'
import {ToolContext} from '../core/context.js'
import type {ViewContext} from '../core/context.js'
import {ShaderNetwork} from '../shadernodes/shadernetwork.js'
import {Material} from '../core/material.js'
import '../shadernodes/allnodes.js'
import {ShaderNode} from '../shadernodes/shader_nodes.js'
import {Graph, Node, SocketFlags, NodeSocketType} from '../core/graph.js'
import {SceneObject} from '../sceneobject/sceneobject.js'
import {ObjectSelectOneOp} from '../sceneobject/selectops.js'
import {DeleteObjectOp} from '../sceneobject/sceneobject_ops.js'
import {Scene} from '../scene/scene.js'
import {api_define_graphclasses} from '../core/graph_class.js'
import {DisplayModes} from '../editors/debug/DebugEditor_base.js'
import {DebugEditor} from '../editors/debug/DebugEditor.js'

export type MyDataAPI = DataAPI<ViewContext>
const dataApi = new DataAPI() as MyDataAPI

import {Icons} from '../editors/icon_enum.js'
import {setSceneObjectMaterialClass} from '../sceneobject/sceneobject_base.js'
import {MaterialEditor} from '../editors/node/MaterialEditor.js'

import {buildProcTextureAPI} from '../texture/proceduralTex.js'
import {AppSettings} from '../core/settings.js'

// Registry primitives live in the dependency-free leaf `api_define_registry.ts` so
// core classes can self-register from their own modules without a
// `class → api_define → class` cycle. Imported here for local use and re-exported.
import {
  registerDataAPI,
  getContextStructs,
  getDataAPIBuilders,
  getDataAPIRegistry,
  isDataAPIDefined,
  markDataAPIDefined,
  type DefineAPIClass,
} from './api_define_registry.js'
export {registerDataAPI, getDataAPIRegistry, type DefineAPIClass}

// Inject Material into sceneobject_base so SceneObjectData.defineAPI can map its
// `materials` list without a sceneobject_base → core/material cycle. Runs at module
// load, before getDataAPI() walks the API. See setSceneObjectMaterialClass.
setSceneObjectMaterialClass(Material)

/**
 * A class constructor accepted by `api.mapStruct`. The definition helpers are
 * polymorphic over the concrete DataBlock / Node / element subclass they map, so
 * this is deliberately broad.
 */
type AnyClass = abstract new (...args: any[]) => any

/**
 * `this` inside a DataPath `.on(...)` change callback / `customGetSet` accessor.
 * path.ux binds the datapath's `ToolProperty` as `this`, augmented with `ctx` (root
 * context), `dataref` (the resolved object), and `datapath` (the path string).
 */
type ApiCallbackThis<Ref> = CallbackThis<Ref, ViewContext>

/**
 * Run a class's `defineAPI` once, returning its populated struct. The "already
 * defined" guard lives in the registry leaf so the addon dispatcher shares it — a
 * class defined by this build pass is never re-defined via `register(api)`, or vice-versa.
 */
function defineOnce<
  CLS extends BoundConstructor & {defineAPI: (api: MyDataAPI, st?: DataStruct<any, any>) => DataStruct},
>(api: MyDataAPI, cls: CLS): DataStruct {
  if (!isDataAPIDefined(cls)) {
    markDataAPIDefined(cls)
    cls.defineAPI(api)
  }
  return api.mapStruct(cls, false)
}

function api_define_socket(api: MyDataAPI, cls: AnyClass = NodeSocketType): DataStruct {
  let nstruct = api.mapStruct(cls, true)

  nstruct.flags('graph_flag', 'graph_flag', SocketFlags, 'Graph Flags', 'Flags')
  nstruct.int('graph_id', 'graph_id', 'Graph ID', 'Unique graph ID').readOnly()
  nstruct.string('name', 'name', 'Name', 'Name of socket')
  nstruct.string('uiname', 'uiname', 'UI Name', 'Name of socket')

  return nstruct
}

function api_define_node(api: MyDataAPI, cls: AnyClass = Node): DataStruct {
  return Node.defineAPI(api, api.mapStruct(cls, true))
}

function api_define_datablock(api: MyDataAPI, cls: AnyClass = DataBlock): DataStruct {
  return DataBlock.defineAPI(api, api.mapStruct(cls, true))
}

function api_define_shadernode(api: MyDataAPI, cls?: AnyClass): DataStruct {
  let nstruct = api_define_node(api, ShaderNode)

  return nstruct
}

function api_define_graph(api: MyDataAPI, cls: AnyClass = Graph): DataStruct {
  let gstruct = api.mapStruct(cls)

  gstruct.list('', 'nodes', [
    function getIter(api: MyDataAPI, list: any) {
      return list.nodes.values()
    },
    function getLength(api: MyDataAPI, list: any) {
      return list.nodes.length
    },
    function get(api: MyDataAPI, list: any, key: string) {
      return list.node_idmap.get(key)
    },
    function getKey(api: MyDataAPI, list: any, obj: any) {
      return '' + obj.graph_id
    },
    function getActive(api: MyDataAPI, list: any) {
      return list.nodes.active
    },
    function setActive(api: MyDataAPI, list: any, key: string) {
      list.nodes.active = list.node_idmap.get(key)
    },
    function getStruct(api: MyDataAPI, list: any, key: string) {
      let obj = list.node_idmap.get(key)

      if (obj === undefined) return api.getStruct(Node)

      let ret = api.getStruct(obj.constructor)
      return ret === undefined ? api.getStruct(Node) : ret
    },
  ])

  return gstruct
}

function api_define_nodesockets(api: MyDataAPI): void {
  // NodeSocketType's own struct (used as the fallback target by Node's socket
  // lists via api.getStruct(NodeSocketType)).
  api_define_socket(api)

  for (let cls of NodeSocketClasses) {
    // Chain the base socket props onto each subclass's own struct, then let the
    // subclass add its specifics — no dependency on NodeSocketType being built first.
    let st = api_define_socket(api, cls)
    cls.defineAPI(api, st)
  }
}

let libraryStruct: DataStruct | undefined
onBlockRegister(function onDataBlockRegister(blockCls: any) {
  if (libraryStruct !== undefined) {
    let def = blockCls.blockDefine()
    defineLibrarySet(dataApi, def.typeName, def.typeName, def.uiName, libraryStruct, blockCls)
  }
})

function api_define_library(api: MyDataAPI, parent: DataStruct): void {
  // Library's per-blocktype lists (library.mesh, …) are its own struct members,
  // populated by Library.defineAPI in the registry pass. This driver fetches that
  // struct, keeps the dynamic-registration wiring, and wires the parent attaches.
  let lstruct = api.mapStruct(Library, false)
  libraryStruct = lstruct

  parent.struct('datalib', 'library', 'Library', lstruct)

  parent.list('blocks', 'blocks', [
    function get(api: MyDataAPI, list: any, key: number | string) {
      return list.get(key)
    },

    function getIter(api: MyDataAPI, list: any) {
      return list
    },

    function getLength(api: MyDataAPI, list: any) {
      let len = 0
      for (let list2 of list.libs) {
        len += list2.length
      }

      return len
    },

    function getActive(api: MyDataAPI, list: any) {
      return undefined
    },

    function setActive(api: MyDataAPI, list: any, key: number | string) {
      return undefined
    },
    function getKey(api: MyDataAPI, list: any, obj: any) {
      return obj.lib_id
    },
    function getStruct(api: MyDataAPI, list: any, key: number | string) {
      let obj = list.get(key)

      if (obj === undefined) {
        return api.getStruct(DataBlock)
      }

      let ret = api.getStruct(obj.constructor)

      if (ret === undefined) {
        return api.getStruct(DataBlock)
      }
    },
  ])
}

export function api_define_velpan(api: MyDataAPI, parent?: DataStruct): DataStruct {
  let vp = api.mapStruct(VelPan)

  vp.vec2('pos', 'pos', 'Position')
  vp.vec2('scale', 'scale', 'Scale')
  vp.vec2('min', 'min', 'Boundary Minimum')
  vp.vec2('max', 'max', 'Boundary Maximum')

  return vp
}

export function api_define_matrix4(api: MyDataAPI): DataStruct {
  let st = api.mapStruct(Matrix4, true)

  let data = st.struct('$matrix', 'data', 'Matrix Data')

  for (let i = 1; i <= 4; i++) {
    for (let j = 1; j <= 4; j++) {
      let key = 'm' + i + j

      data.float(key, key, key).noUnits()
    }
  }

  return st
}

let _done = false

export function getDataAPI(): MyDataAPI {
  if (_done) {
    return dataApi
  }

  let cstruct = dataApi.mapStruct(ToolContext)

  // ── Population pass ─────────────────────────────────────────────────────
  // Non-class struct builders (path.ux types, free structs, the socket inherit
  // loop, customdata/procedural/graph-class helpers) have no class `defineAPI`, so
  // they stay explicit. Order is irrelevant — creation is decoupled from population.
  api_define_matrix4(dataApi)
  api_define_velpan(dataApi)
  api_define_nodesockets(dataApi)
  api_define_shadernode(dataApi) // Node.defineAPI on ShaderNode's struct (not ShaderNode.defineAPI)
  api_define_graph(dataApi) // Graph free struct (nodes list)

  // Provider builders that must run first, because a class `defineAPI` attaches
  // their structs by reference (the mesh addon's customdata elements are the
  // case that exists). Contributed through `api_define_registry.ts`.
  for (const builder of getDataAPIBuilders('before-classes')) {
    builder.build(dataApi)
  }

  // Every participating class populates its own struct via `defineAPI`; `defineOnce`
  // runs each registered class exactly once. Order is irrelevant — subclass `defineAPI`s
  // chain their parent, declaring its members onto the child struct, so none depends on
  // another's struct first. Core classes self-register at module scope (reached as an
  // import side-effect here); addon classes through their own `register(api)` hook.
  // By here the registry is fully populated.
  for (let cls of getDataAPIRegistry()) {
    defineOnce(dataApi, cls)
  }

  // Class-dependent non-class helpers: these chain/merge from now-populated
  // class structs (e.g. buildProcMeshAPI chains DataBlock.defineAPI), so they
  // must run after the registry pass.
  buildProcTextureAPI(dataApi, api_define_datablock)
  api_define_graphclasses(dataApi)

  for (const builder of getDataAPIBuilders('after-classes')) {
    builder.build(dataApi)
  }

  // ── Attach pass ─────────────────────────────────────────────────────────
  // Build the ToolContext tree: wire the now-populated class structs (fetched by
  // reference via mapStruct(_, false)) under named paths, plus the inline root lists.
  cstruct.struct('shadernetwork', 'shadernetwork', 'ShaderNetwork', dataApi.mapStruct(ShaderNetwork, false))
  cstruct.struct('graph', 'graph', 'Graph', dataApi.mapStruct(Graph))
  // Provider-contributed subtrees (`ctx.mesh`, …). An absent provider means an
  // absent subtree — never a throw, which is what a name lookup used to give.
  for (const contribution of getContextStructs()) {
    cstruct.struct(
      contribution.path,
      contribution.path,
      contribution.uiName,
      dataApi.mapStruct(contribution.cls, false)
    )
  }

  // Library: keep the dynamic-registration wiring (libraryStruct, read by the
  // onBlockRegister hook) and the parent-level attaches in the driver shim.
  api_define_library(dataApi, cstruct)

  cstruct.struct('screen', 'screen', 'Screen', dataApi.mapStruct(App, false))
  cstruct.struct('scene', 'scene', 'Scene', dataApi.mapStruct(Scene, false))
  cstruct.struct('light', 'light', 'Light', dataApi.mapStruct(Light, false))

  let ostruct = dataApi.mapStruct(SceneObject, false)
  // uiname is typed `string` but the SceneObject class is passed here; the value
  // is only used for display, so the mismatch is harmless.
  cstruct.struct('object', 'object', SceneObject as unknown as string, ostruct)

  cstruct.list('', 'objects', [
    function getIter(api: MyDataAPI, list: any) {
      return (function* () {
        for (let ob of list.datalib.object) {
          yield ob
        }
      })()
    },
    function getLength(api: MyDataAPI, list: any) {
      return list.datalib.object.length
    },
    function get(api: MyDataAPI, list: any, key: number | string) {
      return list.datalib.get(key)
    },
    function getKey(api: MyDataAPI, list: any, obj: any) {
      return obj.lib_id
    },
    function getStruct(api: MyDataAPI, list: any, key: number | string) {
      return ostruct
    },
  ])
  dataApi.setRoot(cstruct)

  cstruct.list('', 'datablocks', [
    function getIter(api: MyDataAPI, list: any) {
      return list.datalib.allBlocks
    },
    function getLength(api: MyDataAPI, list: any) {
      let len = 0
      for (let block of list.datalib.allBlocks) {
        len++
      }
      return len
    },
    function get(api: MyDataAPI, list: any, key: number | string) {
      return list.datalib.get(key)
    },
    function getKey(api: MyDataAPI, list: any, obj: any) {
      return obj.lib_id
    },
    function getStruct(api: MyDataAPI, list: any, key: number | string) {
      return api.mapStruct(list.datalib.get(key).constructor, false)
    },
  ])

  cstruct.struct('material', 'material', 'Material', dataApi.mapStruct(Material, false))

  cstruct.dynamicStruct('last_tool', 'last_tool', 'Last Tool')

  let def = cstruct.flags('selectMask', 'selectmode', SelMask, 'Selection Mode', 'Selection Mode')
  def.icons({
    VERTEX: Icons.VERT_MODE,
    EDGE  : Icons.EDGE_MODE,
    FACE  : Icons.FACE_MODE,
    OBJECT: Icons.CIRCLE_SEL,
  })

  let sstruct = dataApi.mapStruct(Scene, false)

  def = sstruct.flags('selectMask', 'selectMaskEnum', SelMask, 'Selection Mode', 'Selection Mode')
  def.icons({
    VERTEX: Icons.VERT_MODE,
    EDGE  : Icons.EDGE_MODE,
    FACE  : Icons.FACE_MODE,
    OBJECT: Icons.CIRCLE_SEL,
  })
  def.on('change', function (this: ApiCallbackThis<Scene>, newv: any, oldv: any) {
    let owner = this.dataref

    let mask = owner.selectMask
    let old = oldv

    let newf = mask & ~old

    owner.selectMask &= ~(SelMask.VERTEX | SelMask.FACE | SelMask.EDGE)
    owner.selectMask |= newf

    for (let ob of owner.objects.selected.editable) {
      // Duck-type on `regenElementsDraw` so core doesn't import the addon-owned
      // Mesh class. Any SceneObjectData exposing it (Mesh and its subclasses) gets
      // its draw buffers rebuilt on mode change.
      const data = ob.data as {regenElementsDraw?: () => void} | undefined
      if (data && typeof data.regenElementsDraw === 'function') {
        data.regenElementsDraw()
      }
    }
  })

  buildEditorsAPI(dataApi, cstruct)
  buildToolSysAPI(dataApi, true)

  cstruct.struct('propCache', 'toolDefaults', 'Tool Defaults', dataApi.mapStruct(ToolPropertyCache))

  cstruct.struct('settings', 'settings', 'Settings', dataApi.mapStruct(AppSettings, false))

  _done = true

  return dataApi
}
