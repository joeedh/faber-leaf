import {
  nstructjs,
  util,
  ToolOp,
  vectormath,
  math,
  ToolProperty,
  IntProperty,
  FloatProperty,
  EnumProperty,
  FlagProperty,
  StringProperty,
  BoolProperty,
  Vec2Property,
  Vec3Property,
  Vec4Property,
  Mat4Property,
  KeyMap,
  HotKey,
} from '../path.ux/scripts/pathux'
import * as pathux from '../path.ux/scripts/pathux'
import {DataBlock, DataRef, DataRefProperty, DataRefListProperty, IDataBlockConstructor} from '../core/lib_api'
import {SceneObjectData} from '../sceneobject/sceneobject_base'
import {
  registerDataAPI,
  isDataAPIDefined,
  markDataAPIDefined,
  type DefineAPIClass,
} from '../data_api/api_define_registry'
import {ToolMode} from '../editors/view3d/view3d_toolmode'
import {SceneObject, composeObjectMatrix} from '../sceneobject/sceneobject'
import {
  Editor,
  VelPan,
  VelPanFlags,
  DataBlockBrowser,
  DirectionChooser,
  EditorSideBar,
  makeDataBlockBrowser,
  MaterialChooser,
  MaterialPanel,
  NewDataBlockOp,
  getContextArea,
  IEditorConstructor,
} from '../editors/editor_base'
import {Icons} from '../editors/icon_enum'
import {SelMask} from '../core/select_types'
import {TransformOp} from '../editors/view3d/transform/transform_ops'
import * as widget_tools from '../editors/view3d/widgets/widget_tools'
import * as widgets from '../editors/view3d/widgets/widgets'
import * as simplemesh from '../webgl/simplemesh'
import * as bezier from '../util/bezier'
import * as shaders from '../shaders/shaders'
import * as graph from '../core/graph'
import * as graphsockets from '../core/graphsockets'
import * as sceneobject from '../sceneobject/index'
import {ViewContext} from '../core/context'

/** is a constructor a subclass of another constructor? */
export function subclassOf<T>(testCls: unknown, cls2: T): testCls is T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p = testCls as any
  while (p && p !== p.__proto__) {
    if (p === cls2 || p.constructor === cls2) {
      return true
    }
    p = p.__proto__
  }
  return false
}

export interface IAddonDefine {
  name: string
  version: number | number[]
  author?: string
  url?: string
  icon?: number | HTMLImageElement
  description?: string
  documentationUrl?: string
}

export interface IAddon {
  addonDefine: IAddonDefine
  /** called only once, create classes here */
  onAddonCreate?(api: AddonAPI<this>): void
  unregister(): void
  register(api: AddonAPI<this>): void
  handleArgv(api: AddonAPI<this>, argv: string[]): void
  validArgv(api: AddonAPI<this>, argv: string[]): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenericConstructor = Function

export class AddonClasses<T> {
  dataBlockClasses: IDataBlockConstructor[] = []
  toolOpClasses: GenericConstructor[] = []
  structClasses: GenericConstructor[] = []
  toolModeClasses: GenericConstructor[] = []
  sceneObjectDataClasses: GenericConstructor[] = []
  customDataClasses: GenericConstructor[] = []
  editorClasses: GenericConstructor[] = []
  other: GenericConstructor[] = []
}

/**
 * Looks up an addon's exported namespace via `window._addons`. Returns
 * undefined if the addon manager isn't initialized yet or the addon hasn't
 * registered. Used by the mesh/bvh/subsurf getters below so this file no
 * longer imports addon source directly (see plan §3.2).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lookupAddonExport(addonId: string, exportName: string): any {
  const manager = (typeof window !== 'undefined' ? window._addons : undefined) as
    | {getAddonAPI: (id: string) => {exports?: Record<string, unknown>} | undefined}
    | undefined
  return manager?.getAddonAPI(addonId)?.exports?.[exportName]
}

/** Narrows a registered class to one carrying the data-API `defineAPI` contract. */
function hasDefineAPI(cls: unknown): cls is DefineAPIClass {
  return typeof (cls as {defineAPI?: unknown}).defineAPI === 'function'
}

export class AddonAPI<T> {
  readonly shaders = shaders
  readonly nstructjs = nstructjs
  readonly util = util
  readonly vectormath = vectormath
  readonly math = math

  readonly simplemesh = simplemesh
  readonly pathux = pathux

  readonly sceneobject = sceneobject

  // Mesh-shaped namespaces are resolved lazily through the addon registry so
  // this file stays mesh-agnostic. The mesh addon publishes the full surface
  // from `addons/builtin/mesh/src/addon_register.ts`. See plan §3.2.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get mesh(): any {
    return lookupAddonExport('mesh', 'mesh')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get mesh_utils(): any {
    return lookupAddonExport('mesh', 'mesh_utils')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get bvh(): any {
    return lookupAddonExport('mesh', 'bvh')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get unwrapping(): any {
    return lookupAddonExport('mesh', 'unwrapping')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get subsurf(): any {
    return lookupAddonExport('subsurf', 'subsurf')
  }

  readonly KeyMap = KeyMap
  readonly HotKey = HotKey
  readonly bezier = bezier
  readonly Icons = Icons
  readonly SelMask = SelMask
  readonly editor = {
    Editor,
    VelPan,
    VelPanFlags,
    DataBlockBrowser,
    DirectionChooser,
    EditorSideBar,
    makeDataBlockBrowser,
    MaterialChooser,
    MaterialPanel,
    NewDataBlockOp,
    getContextArea,
  }

  readonly widgets3d = {
    ...widgets,
    ...widget_tools,
  } as const

  readonly toolmode = {
    ToolMode,
    // MeshToolBase / MeshEditor live in the `mesh_edit` builtin addon. They
    // are looked up at access time so this file holds no source-level import
    // into addons/builtin/. See plan §3.2 / §6 step 8.
    get MeshToolBase(): any {
      return lookupAddonExport('mesh_edit', 'mesh_edit')?.MeshToolBase
    },
    get MeshEditor(): any {
      return lookupAddonExport('mesh_edit', 'mesh_edit')?.MeshEditor
    },
  } as const
  readonly toolop = {
    ToolOp,
    ToolProperty,
    IntProperty,
    FloatProperty,
    StringProperty,
    EnumProperty,
    FlagProperty,
    Vec2Property,
    Vec3Property,
    Vec4Property,
    Mat4Property,
    DataRefProperty,
    DataRefListProperty,
    TransformOp,
    BoolProperty,
    // MeshOp / MeshDeformOp / MeshOpBaseUV are no longer re-exposed here.
    // Consumers use `api.mesh.MeshOp` / `api.deps.mesh.exports.mesh.MeshOp`.
  } as const
  readonly graph = {
    ...graph,
    ...graphsockets,
  }

  addon?: T

  /** Stable id from the addon's manifest. Set by the loader. */
  addonId?: string

  classes = new AddonClasses<T>()
  _graphNodes = new Set<graph.Node['graph_id']>()

  /**
   * Namespaces exported by this addon for other addons to consume. Populated
   * by `api.exportNamespace(name, exports)` from inside the addon's
   * `register()`. Other addons reach these via `api.getAddon(id).exports[name]`
   * — or via the typed `@addon/<id>/api` resolver at compile time. See plan §2.5.
   */
  exports: {[name: string]: unknown} = {}

  /**
   * Resolved dependency addons, keyed by manifest id. Populated by the loader
   * before this addon's `register()` runs (deps are loaded first by topological
   * sort). Addons can also use the typed `import * as mesh from '@addon/mesh/api'`
   * shim which resolves to `api.deps.mesh.exports['mesh']` at runtime.
   */
  deps: {[id: string]: AddonAPI<unknown>} = {}

  /**
   * Application-menu contributions made by this addon, keyed by menu id (e.g.
   * `'add'` for the View3D "Add" menu). Populated by `api.menuEntries(...)` from
   * inside `register()` and cleared by `unregisterAll()`, so entries track the
   * addon's enabled state. `AddonManager.getAddonMenuEntries()` reads these.
   * Entries are toolpath strings; a `Menu.SEP` symbol inserts a separator
   * within the addon's own block.
   */
  menuContributions: {[menuId: string]: (string | symbol)[]} = {}

  readonly lib_api: {
    DataBlock: typeof DataBlock
    DataRef: typeof DataRef
    DataRefProperty: typeof DataRefProperty
    DataRefListProperty: typeof DataRefListProperty
  }

  constructor() {
    //reference back to addon
    this.addon = undefined

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const this2 = this
    const dataBlockProxy = class DataBlockAddon extends DataBlock {
      static register(cls: any) {
        const ret = super.register(cls)
        this2.classes.dataBlockClasses.push(cls)

        return ret
      }
    }
    this.lib_api = {
      DataBlock: dataBlockProxy as typeof DataBlock,
      DataRef,
      DataRefProperty,
      DataRefListProperty,
    }
  }

  /**
   * Publishes a namespace that other addons can import. Typical use from inside
   * an addon's `register(api)`:
   *
   *   api.exportNamespace('mesh', {Mesh, MeshFlags, BVH, customdata: {...}})
   *
   * Consumers reach it as `api.getAddon('mesh').exports['mesh']` or, with full
   * type-checking, via the `@addon/mesh/api` resolver baked into the addon
   * build pipeline (see tools/build-addons.js).
   */
  exportNamespace(name: string, exports: Record<string, unknown>): void {
    this.exports[name] = exports
  }

  /**
   * Contribute entries to a named application menu. Call from `register(api)`:
   *
   *   api.menuEntries('add', ['mesh.make_cube()', 'mesh.make_sphere()'])
   *
   * Each entry is a toolpath string evaluated by the menu builder. Entries are
   * removed automatically when the addon is disabled (via `unregisterAll()`), so
   * the "Add" menu only shows ops from currently-enabled addons. `menuId`
   * defaults to `'add'` (the only dynamic menu today); pass another id to
   * target a different menu as the system grows.
   */
  menuEntries(menuId: string, entries: (string | symbol)[]): void
  menuEntries(entries: (string | symbol)[]): void
  menuEntries(menuIdOrEntries: string | (string | symbol)[], maybeEntries?: (string | symbol)[]): void {
    const menuId = Array.isArray(menuIdOrEntries) ? 'add' : menuIdOrEntries
    const entries = Array.isArray(menuIdOrEntries) ? menuIdOrEntries : maybeEntries ?? []
    const list = this.menuContributions[menuId] ?? (this.menuContributions[menuId] = [])
    list.push(...entries)
  }

  /** Returns another loaded addon's API by manifest id, or undefined. */
  getAddon(id: string): AddonAPI<unknown> | undefined {
    return window._addons?.getAddonAPI(id)
  }

  get argv() {
    return _appstate.arguments
  }

  get ctx() {
    return _appstate.ctx
  }

  register(cls: unknown) {
    if (typeof cls !== 'function') {
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (Object.hasOwnProperty.call(cls, 'STRUCT') && !nstructjs.isRegistered(cls as any)) {
      nstructjs.register(cls)
    }

    let addToOther = true

    if (subclassOf(cls, ToolOp)) {
      //ensure tooldef doesn't raise any errors
      cls.tooldef()

      ToolOp.register(cls)
      this.classes.toolOpClasses.push(cls)
      addToOther = false
    }

    if (subclassOf(cls, DataBlock)) {
      DataBlock.register(cls)
      this.classes.dataBlockClasses.push(cls)
      addToOther = false
    }

    if (subclassOf(cls, ToolMode)) {
      ToolMode.register(cls)
      this.classes.toolModeClasses.push(cls)
      addToOther = false

      if (window._appstate) {
        cls.defineAPI(_appstate.api)
      } else {
        const cb = () => {
          if (!window._appstate) {
            window.setTimeout(cb, 5)
            return
          }

          cls.defineAPI(_appstate.api)
        }

        window.setTimeout(cb)
      }
    }

    // CustomDataElem lives in the mesh addon; resolve at use time so this
    // file doesn't import from addons/builtin/mesh/. See plan §3.2.
    const CustomDataElem = lookupAddonExport('mesh', 'mesh')?.CustomDataElem
    if (CustomDataElem && subclassOf(cls, CustomDataElem)) {
      CustomDataElem.register(cls)
      this.classes.customDataClasses.push(cls)
      addToOther = false
    }

    if (subclassOf(cls, Editor)) {
      Editor.register(cls as unknown as IEditorConstructor)
      this.classes.editorClasses.push(cls)
      addToOther = false
    }

    if (subclassOf(cls, SceneObjectData)) {
      SceneObjectData.register(cls)
      this.classes.sceneObjectDataClasses.push(cls)
      addToOther = false
    }

    // Data-API participants: DataBlock / SceneObjectData subclasses carry a static
    // `defineAPI`. Register them for the next `getDataAPI` build and live-define an
    // externally-added one now; the registry guard prevents a double-define.
    if ((subclassOf(cls, DataBlock) || subclassOf(cls, SceneObjectData)) && hasDefineAPI(cls)) {
      registerDataAPI(cls)
      this._defineDataAPIWhenReady(cls)
    }

    if (addToOther) {
      this.classes.other.push(cls)
    }
  }

  /**
   * Live-define a data-API class against the running `DataAPI`. `getDataAPI` is
   * one-shot (it runs before addons start), so an addon enabled afterward defines
   * its classes itself; retries until `_appstate` exists, and runs at most once.
   */
  private _defineDataAPIWhenReady(cls: DefineAPIClass): void {
    const define = () => {
      if (isDataAPIDefined(cls)) {
        return
      }
      markDataAPIDefined(cls)
      cls.defineAPI(_appstate.api)
    }

    if (window._appstate) {
      define()
    } else {
      const cb = () => {
        if (!window._appstate) {
          window.setTimeout(cb, 5)
          return
        }
        define()
      }
      window.setTimeout(cb)
    }
  }

  /**
   * Bulk variant of {@link register}. Use from `register(api)`:
   *
   *   api.registerAll(MyToolMode, MyToolOp, MyDataBlock, MyCustomData)
   *
   * Each argument is forwarded to `register(cls)` individually, so the
   * dispatcher picks the right global registry per class.
   */
  registerAll(...classes: unknown[]): void {
    for (const cls of classes) {
      this.register(cls)
    }
  }

  graphConnect<
    SRC extends graph.Node,
    SRCOUT extends graph.NodeSocketType | string,
    DST extends graph.Node,
    DSTIN extends graph.NodeSocketType | string,
  >(src: SRC, output: SRCOUT, dst: DST, input: DSTIN) {
    const graph = this.ctx.graph

    if (src.graph_id < 0) {
      console.warn('Auto-adding node to dependency graph')
      graph.add(src)
      this._graphNodes.add(src.graph_id)
    }

    if (dst.graph_id < 0) {
      console.warn('Auto-adding node to dependency graph')
      graph.add(dst)
      this._graphNodes.add(dst.graph_id)
    }

    const outsocket = (typeof output === 'string' ? src.outputs[output] : output) as graph.NodeSocketType
    const insocket = (typeof input === 'string' ? dst.inputs[input] : input) as graph.NodeSocketType

    outsocket.connect(insocket)
  }

  onNewFilePost() {}

  onNewFilePre() {
    this._graphNodes = new Set()
  }

  graphAdd(node: graph.Node) {
    this.ctx.graph.add(node)
    this._graphNodes.add(node.graph_id)
  }

  graphRemove(node: graph.Node) {
    const id = node.graph_id
    this.ctx.graph.remove(node)
    this._graphNodes.delete(id)
  }

  unregister(cls: unknown) {
    if (typeof cls !== 'function') {
      console.error('unregister called with no arguments')
      return
    }

    function consolelog(...args: any[]) {
      //console.log(...args)
    }

    consolelog('unregistered', cls.name)

    if (nstructjs.isRegistered(cls)) {
      nstructjs.unregister(cls)
    }

    if (subclassOf(cls, ToolMode)) {
      consolelog('unregistering a toolmode', cls)

      ToolMode.unregister(cls)
    }

    const CustomDataElem = lookupAddonExport('mesh', 'mesh')?.CustomDataElem
    if (CustomDataElem && subclassOf(cls, CustomDataElem)) {
      consolelog('unregistering a customdata elem', cls)

      CustomDataElem.unregister(cls)
    }

    if (subclassOf(cls, ToolOp)) {
      ToolOp.unregister(cls)
    }

    if (subclassOf(cls, DataBlock)) {
      DataBlock.unregister(cls)
    }

    if (subclassOf(cls, SceneObjectData)) {
      SceneObjectData.unregister(cls)
    }

    if (subclassOf(cls, Editor)) {
      Editor.unregister(cls)
    }
  }

  unregisterAll() {
    let graph

    if (window._appstate) {
      graph = this.ctx.graph
    }

    for (const id of this._graphNodes) {
      let n

      if (!graph) {
        break
      }

      try {
        n = graph.node_idmap.get(id)

        if (n) {
          graph.remove(n)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        console.error(error.stack)
        console.error(error.message)
        console.error('Failed to remove a graph node!', id, n)
      }
    }

    for (const k in this.classes) {
      for (const cls of this.classes[k as keyof typeof this.classes]) {
        this.unregister(cls)
      }
    }

    this.classes = new AddonClasses()
    this.menuContributions = {}
    return this
  }
}
