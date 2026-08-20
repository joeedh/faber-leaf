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
import {
  DataBlock,
  DataRef,
  DataRefProperty,
  DataRefListProperty,
  IDataBlockConstructor,
  type Library,
} from '../core/lib_api'
import {SceneObjectData} from '../sceneobject/sceneobject_base'
import {
  registerDataAPI,
  registerContextStruct as registerContextStructImpl,
  unregisterContextStruct,
  isDataAPIDefined,
  markDataAPIDefined,
  type ContextStructContribution,
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
  defineEditorAPI,
  getContextArea,
  IEditorConstructor,
} from '../editors/editor_base'
import {Icons} from '../editors/icon_enum'
import {UIBase, type IUIBaseConstructor} from '../path.ux/scripts/core/ui_base'
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
import type {ToolContext} from '../core/context'
import {registerDataKind, unregisterDataKind, type IDataKindDescriptor} from '../core/data_kinds'
import {registerDefaultScene, unregisterDefaultScene, type DefaultSceneBuilder} from '../core/default_file'
import {registerTestScene, unregisterTestScene, type TestSceneBuilder} from '../core/test_scenes'
import {registerBootTask, unregisterBootTask, type BootTask} from '../core/boot_tasks'
import {FeatureFlagManager, FeatureFlags, defineFeatureFlagMember, type FeatureFlag} from '../core/feature-flag'
import {registerFileMigrator, unregisterFileMigrator, type IFileMigrator} from '../core/file_migrations'
import {registerFileFormat, unregisterFileFormat, type IFileFormat} from '../core/file_formats'
import {registerUVSource, unregisterUVSource, type IUVSourceProvider} from '../core/uv_sources'
import {registerPropsPanel, unregisterPropsPanel, type IPropsPanel} from '../core/props_panels'
import {getAppState, peekAppState} from '../core/app_instance'
import {registerKeymapEntries as registerKeymapEntriesImpl, unregisterKeymapEntries} from '../core/keymap_contributions'
import {
  registerLegacyStructNames as registerLegacyStructNamesImpl,
  unregisterLegacyStructNames,
} from '../core/legacy_struct_migration'
import {TransDataType, type ITransDataType} from '../editors/view3d/transform/transform_base'

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
  editorClasses: GenericConstructor[] = []
  other: GenericConstructor[] = []
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

  // P13 deleted the TS BREP addons, and with them the lazy `api.mesh` /
  // `api.bvh` / `api.subsurf` / `api.toolmode.MeshToolBase` getters. A peer
  // addon reaches another through `@addon/<id>/api`.

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
   * Undo thunks for the non-class registries below (data kinds, transform
   * types, file formats, ...). Every `register*` pushes exactly one;
   * `unregisterAll` runs them in reverse. Keeping the undo next to the do is
   * what makes "everything registered here is unregisterable" checkable by
   * reading one method rather than auditing a dispatcher.
   */
  private _undoRegistrations: (() => void)[] = []

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
   * sort). Addons can also use the typed
   * `import * as leafmesh from '@addon/leafmesh/api'` shim, which resolves to
   * `api.deps.leafmesh.exports['leafmesh']` at runtime.
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
   *   api.exportNamespace('leafmesh', {LeafMesh, LeafMeshData, AttrType, ...})
   *
   * Consumers reach it as `api.getAddon('leafmesh').exports['leafmesh']` or,
   * with full type-checking, via the `@addon/leafmesh/api` resolver baked into
   * the addon build pipeline (see tools/build-addons.js).
   */
  exportNamespace(name: string, exports: Record<string, unknown>): void {
    this.exports[name] = exports
  }

  /**
   * Contribute entries to a named application menu. Call from `register(api)`:
   *
   *   api.menuEntries('add', ['litemesh.add_cube()', 'litemesh.add_plane()'])
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

  /**
   * Is the addon with this manifest id loaded *and enabled* — are its
   * registrations live? An addon that needs an optional subsystem can
   * hard-depend on it, crash at first use, or ask and degrade; only the third
   * lets a distribution ship without the subsystem, which is the point of the
   * layered architecture. See geometry-contract.md §9 and documentation/addons.md.
   *
   * Enabled, not merely loaded: a disabled addon has had its classes, ops and
   * menu entries unregistered, so it is no more usable than an absent one.
   */
  has(id: string): boolean {
    return window._addons?.isEnabled(id) === true
  }

  // -------------------------------------------------------------------------
  // Non-class registries (documentation/geometry-contract.md §9)
  //
  // Each of these pairs a global `register*` with the matching `unregister*`,
  // because module-scope registration works exactly once and cannot be undone —
  // an addon that registers at module scope can be loaded but never unloaded.
  // -------------------------------------------------------------------------

  /**
   * Declare a data kind: its capabilities, vertex attributes, importer hooks.
   * This is how a geometry type becomes visible to the host without the host
   * naming it (`documentation/geometry-contract.md` §2.1).
   */
  registerDataKind(desc: IDataKindDescriptor<ToolContext>): void {
    registerDataKind(desc)
    this._undoRegistrations.push(() => unregisterDataKind(desc.id))
  }

  /** Contribute a transform type (§8). Replaces module-scope `TransDataType.register`. */
  registerTransType(type: ITransDataType): void {
    TransDataType.register(type)
    this._undoRegistrations.push(() => TransDataType.unregister(type))
  }

  /**
   * Contribute a named startup scene, so a distribution's default file is not
   * hardcoded in core. The distribution picks one by name, which is what keeps
   * the choice independent of addon load order. `toolMode` is the mode the new
   * file opens in — it belongs to the scene, so it travels with it.
   */
  registerDefaultSceneBuilder(name: string, fn: DefaultSceneBuilder, toolMode?: string): void {
    registerDefaultScene(name, fn, toolMode)
    this._undoRegistrations.push(() => unregisterDefaultScene(name, fn))
  }

  /**
   * Contribute a named `--gen-scene` builder. Deterministic test scenes are
   * built out of a geometry type, so they belong to whichever addon owns it.
   */
  registerTestScene(name: string, builder: TestSceneBuilder): void {
    registerTestScene(name, builder)
    this._undoRegistrations.push(() => unregisterTestScene(name, builder))
  }

  /**
   * Hold the boot open until this addon's async warm-up finishes. `start()`
   * awaits every registered task after the enable pass, so nothing reads a
   * file or builds the UI before it lands. Rejections are reported, not fatal.
   */
  registerBootTask(fn: BootTask, label: string): void {
    registerBootTask(fn, label)
    this._undoRegistrations.push(() => unregisterBootTask(fn))
  }

  /**
   * Feature flags owned by this addon. `getDataAPI()` is one-shot and has
   * already run by the time an addon registers, so each flag also declares its
   * own data-API member against the live API — that member is what the settings
   * UI binds to. Stored values are keyed by flag name and outlive the addon, so
   * turning it off and on again does not reset the user's toggles.
   */
  registerFeatureFlags(flags: readonly Readonly<FeatureFlag>[]): void {
    FeatureFlags.registerFlags(flags)
    this._undoRegistrations.push(() => FeatureFlags.unregisterFlags(flags.map((f) => f.key)))

    this._whenAppstateReady(() => {
      const st = getAppState().api.mapStruct(FeatureFlagManager, true)
      for (const flag of flags) {
        if (FeatureFlags.markDefined(flag.key)) {
          defineFeatureFlagMember(st, flag)
        }
      }
    })
  }

  /** Register a per-version file migration owned by this addon's data. */
  registerFileMigrator(m: IFileMigrator<Library>): void {
    registerFileMigrator(m)
    this._undoRegistrations.push(() => unregisterFileMigrator(m.id))
  }

  /** Register an interchange file format (STL, OBJ, ...). */
  registerFileFormat(fmt: IFileFormat<ToolContext>): void {
    registerFileFormat(fmt)
    this._undoRegistrations.push(() => unregisterFileFormat(fmt.id))
  }

  /** Register the UV source for a data kind. Declared ahead of its implementors; see §11. */
  registerUVSource(provider: IUVSourceProvider): void {
    registerUVSource(provider)
    this._undoRegistrations.push(() => unregisterUVSource(provider.kindId))
  }

  /** Contribute a properties-editor panel, instead of the host branching on type. */
  registerPropsPanel(panel: IPropsPanel): void {
    registerPropsPanel(panel)
    this._undoRegistrations.push(() => unregisterPropsPanel(panel.id))
  }

  /**
   * Register a path.ux custom element. `UIBase.register` is idempotent and
   * `UIBase.unregister` is a documented no-op — the platform's custom-element
   * registry is append-only — so re-enabling an addon reuses the same tag.
   */
  registerUIElement(cls: IUIBaseConstructor): void {
    UIBase.register(cls)
    this._undoRegistrations.push(() => UIBase.unregister(cls))
  }

  /**
   * Contribute hotkeys to an editor's keymap (`'view3d'`). A host default keymap
   * must not name an addon's ToolOp — the hotkey would outlive the tool.
   */
  registerKeymapEntries(keymapId: string, keymap: KeyMap): void {
    const ownerId = this.addonId ?? 'unknown'
    registerKeymapEntriesImpl(keymapId, ownerId, keymap)
    this._undoRegistrations.push(() => unregisterKeymapEntries(ownerId, keymapId))
  }

  /**
   * Attach a struct under the ToolContext data-API tree. In-bundle builtins
   * used to go through `builtin_data_api.ts`, which P13 deleted along with the
   * BREP addon; every addon now uses this hook.
   */
  registerContextStruct(contribution: ContextStructContribution): void {
    registerContextStructImpl(contribution)
    this._undoRegistrations.push(() => unregisterContextStruct(contribution.path))
  }

  /**
   * Contribute legacy nstructjs struct-name migrations for structs this addon
   * owns, mapping each old embedded name onto its module-qualified one. Core
   * keeps only the host-owned entries; see plan §2.4.
   */
  registerLegacyStructNames(entries: Record<string, string>): void {
    const ownerId = this.addonId ?? 'unknown'
    registerLegacyStructNamesImpl(ownerId, entries)
    this._undoRegistrations.push(() => unregisterLegacyStructNames(ownerId))
  }

  get argv() {
    return getAppState().arguments
  }

  get ctx() {
    return getAppState().ctx
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

      if (peekAppState() !== undefined) {
        cls.defineAPI(getAppState().api)
      } else {
        const cb = () => {
          if (peekAppState() === undefined) {
            window.setTimeout(cb, 5)
            return
          }

          cls.defineAPI(getAppState().api)
        }

        window.setTimeout(cb)
      }
    }

    if (subclassOf(cls, Editor)) {
      Editor.register(cls as unknown as IEditorConstructor)
      this.classes.editorClasses.push(cls)
      addToOther = false

      // An editor's own struct and its `editors.<name>` context path are wired
      // by the one-shot `getDataAPI` build, which has already run by now; an
      // addon-owned editor attaches itself so its `prop()` bindings resolve.
      const editorCls = cls as unknown as IEditorConstructor
      this._whenAppstateReady(() => defineEditorAPI(getAppState().api, editorCls))
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
   * its classes itself; retries until an instance exists, and runs at most once.
   */
  private _defineDataAPIWhenReady(cls: DefineAPIClass): void {
    this._whenAppstateReady(() => {
      if (isDataAPIDefined(cls)) {
        return
      }
      markDataAPIDefined(cls)
      cls.defineAPI(getAppState().api)
    })
  }

  /** Runs `fn` once an instance exists — now if one already does, else polling. */
  private _whenAppstateReady(fn: () => void): void {
    if (peekAppState() !== undefined) {
      fn()
      return
    }
    const cb = () => {
      if (peekAppState() === undefined) {
        window.setTimeout(cb, 5)
        return
      }
      fn()
    }
    window.setTimeout(cb)
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

    if (peekAppState() !== undefined) {
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

    // A class that is both a DataBlock and a SceneObjectData is filed under two
    // lists, and unregistering it twice throws ("item not in array"), which
    // would abort the rest of the teardown and leave the addon un-re-enableable.
    const seen = new Set<unknown>()
    for (const k in this.classes) {
      for (const cls of this.classes[k as keyof typeof this.classes]) {
        if (seen.has(cls)) {
          continue
        }
        seen.add(cls)

        try {
          this.unregister(cls)
        } catch (error) {
          console.error('Failed to unregister an addon class', cls, error)
        }
      }
    }

    // Reverse order, so a slot-style registration (the default-scene builder)
    // unwinds to whatever held it before this addon did.
    for (const undo of this._undoRegistrations.reverse()) {
      try {
        undo()
      } catch (error) {
        console.error('Failed to unregister an addon contribution', error)
      }
    }

    this._undoRegistrations = []
    this.classes = new AddonClasses()
    this.menuContributions = {}
    return this
  }
}
