import * as ui_noteframe from '../path.ux/scripts/widgets/ui_noteframe'
import '../path.ux/scripts/util/struct.js'
import {NodeViewer} from '../editors/node/NodeViewer.js'
import {Editor, editorAccessor, getContextArea, IEditorConstructor} from '../editors/editor_base'
import {ResourceBrowser} from '../editors/resbrowser/resbrowser.js'
import {dataHasCapability} from './data_kinds.js'
import {GeometryCapability} from './geometry_contract.js'
import {Light} from '../light/light.js'
import type {Scene} from '../scene/scene'
import {BlockSet, DataBlock, DataRef, Library} from './lib_api'
import {DebugEditor} from '../editors/debug/DebugEditor.js'
import {MenuBarEditor} from '../editors/menu/MainMenu.js'
import {Context, DataAPI, ILockableCtx, toLockedImpl} from '../path.ux/scripts/pathux.js'
import {SavedToolDefaults, Screen, UIBase} from '../path.ux/scripts/pathux.js'
import {PropsEditor} from '../editors/properties/PropsEditor.js'
import {MaterialEditor} from '../editors/node/MaterialEditor.js'
import {Icons} from '../editors/icon_enum.js'
const passthrus = new Set<string | number | symbol>(['datalib', 'gl', 'graph', 'last_tool', 'toolstack', 'api'])

import bus from './bus'
import type {AppState} from './appstate.js'
import {Material} from './material'
import {View3D} from '../editors/all.js'
import {SceneObject} from '../sceneobject/sceneobject'
import {areaclasses, AreaFlags} from '../path.ux/scripts/screen/area_base'
import {RootLoadFileOp} from './gen_default_file'

type AppLibrary = Library & {material: BlockSet<Material>; scene: BlockSet<Scene>}

function saveProperty(ctx: any, key: string | symbol | number) {
  const val = ctx[key]

  if (passthrus.has(key) || val instanceof UIBase || val instanceof Screen) {
    return new KeyPassThruProp(key)
  }

  //console.log("saveProperty called", key);
  return saveProperty_intern(ctx, ctx[key], key)
}

function saveProperty_intern(ctx: any, val: any, owning_key: string | symbol | number): any {
  if (typeof val !== 'object') return val

  if (typeof val === 'function' && !val[Symbol.iterator]) {
    return val
  }
  if (val instanceof DataBlock) {
    return DataRef.fromBlock(val)
  }

  // handle iterator methods
  let isiter = typeof val === 'function' || typeof val === 'object'
  isiter = isiter && val[Symbol.iterator]

  if (isiter) {
    const ret = []
    for (const item of val) {
      ret.push(saveProperty_intern(ctx, item, owning_key))
    }
    return ret
  }

  console.warn('Warning, unknown data in ToolContext.prototype.savePropertyIntern()', owning_key)
  return val
}

function loadProperty(ctx: any, key: symbol | string | number, data: any) {
  if (typeof data !== 'object') {
    return data
  }

  if (data instanceof KeyPassThruProp) {
    return ctx[data.key]
  } else if (data instanceof DataRef) {
    return ctx.state.datalib.get(data)
  } else if (data.constructor === Array) {
    // stupid TS won't let us manipulate any[] arrays
    const ret = [] as unknown as Record<number, any>
    ;(ret as any).length = data.length

    for (let i = 0; i < data.length; i++) {
      ret[i] = loadProperty(ctx, i, (data as unknown as Record<number, any>)[i])
    }

    return ret
  } else {
    return data
  }
}

class ContextExtraAPI implements ILockableCtx {
  state: AppState

  constructor(state: AppState) {
    this.state = state
  }

  toLocked = toLockedImpl
  saveProperty = saveProperty
  loadProperty = loadProperty

  play() {
    this.state.playing = true
  }

  stop() {
    this.state.playing = false
  }

  message(msg: string, timeout = 2500) {
    return ui_noteframe.message(this.state.screen, msg, timeout)
  }

  error(msg: string, timeout = 2500) {
    return ui_noteframe.error(this.state.screen, msg, timeout)
  }

  warning(msg: string, timeout = 2500) {
    return ui_noteframe.warning(this.state.screen, msg, timeout)
  }

  progressBar(msg: string, percent: number, color: string, timeout = 1000) {
    return ui_noteframe.progbarNote(this.state.screen, msg, percent, color, timeout)
  }
}

export class ToolContext extends ContextExtraAPI {
  constructor(appstate: AppState) {
    super(appstate)
  }

  reset() {
    // do nothing
    console.warn('ctx.reset called')
  }

  get messagebus() {
    return bus
  }

  messagebus_save() {
    return undefined
  }

  messagebus_load() {
    return bus
  }

  get settings() {
    return this.state.settings
  }

  settings_save() {
    return undefined //do nothing
  }

  settings_load(ctx: this, data: any) {
    return ctx.state.settings
  }

  get timeStart() {
    return this.scene ? this.scene.timeStart : 0
  }

  get timeEnd() {
    return this.scene ? this.scene.timeEnd : 0
  }

  get gl() {
    return window._gl
  }

  gl_save() {
    return undefined
  }

  gl_load(ctx: this, data: any) {
    //do nothing
  }

  validate() {
    return true
  }

  get toolDefaults() {
    return SavedToolDefaults.accessors
  }

  toolDefaults_save() {
    return SavedToolDefaults.accessors
  }

  toolDefaults_load() {
    return SavedToolDefaults.accessors
  }

  get propCache() {
    //used by datapath api
    return SavedToolDefaults
  }

  propCache_save() {
    return SavedToolDefaults
  }

  propCache_load(ctx: this, data: any) {
    return SavedToolDefaults
  }

  //used by UI code
  //refers to last executed *ToolOp*, don't confused with tool *modes*
  get last_tool() {
    return this.state.toolstack.head
  }

  copy() {
    return new ToolContext(this.state)
  }

  get material() {
    const ob = this.object

    // `usesMaterial` is the kind-agnostic form of the old `dataKindOf() ===
    // 'mesh'` test: the materials array lives on SceneObjectData itself.
    if (ob?.data?.usesMaterial && ob.data.materials.length > 0) {
      return ob.data.materials[0]
    }
  }

  get playing() {
    return this.state.playing
  }

  get graph() {
    /** execution graph */
    return this.state.datalib.graph
  }

  get toolmode() {
    const scene = this.scene

    return scene !== undefined ? scene.toolmode : undefined
  }

  get screen() {
    return this.state.screen
  }
  get toolstack() {
    return this.state.toolstack
  }

  // `DataAPI<this>`, not the bare `DataAPI` AppState stores it as: path.ux's
  // ContextLike declares `api: DataAPI<this>`, so a context whose `api` is
  // `DataAPI<ContextLike>` fails the constraint on ToolMacro<ToolContext> etc.
  get api(): DataAPI<this> {
    return this.state.api as unknown as DataAPI<this>
  }

  get datalib() {
    return this.state.datalib
  }

  toolmode_save() {
    if (this.scene === undefined) return 0
    return this.scene.toolmode_i
  }
  toolmode_load(ctx: this, data: any) {
    return ctx.scene?.toolmode_map[data]
  }

  get scene(): Scene {
    const ret = this.datalib.scene.active

    if (ret === undefined && this.datalib.scene.length > 0) {
      console.warn('Something happened to active scene; fixing...')
      this.datalib.scene.active = this.datalib.scene[0]
    }

    return this.datalib.scene.active!
  }

  get object() {
    return this.scene ? this.scene.objects.active : undefined
  }

  get light() {
    const ob = this.object

    if (ob !== undefined) {
      return ob.data instanceof Light ? ob.data : undefined
    }
  }

  get selectedObjects() {
    if (this.scene === undefined) return []

    return this.scene.objects.selected.editable
  }

  /* unlike selectedTriangleSourceObjects, this returns all light objects
   * even if they share .data Light instances*/
  get selectedLightObjects() {
    const this2 = this

    if (this.scene === undefined) {
      return []
    }

    return (function* () {
      for (const ob of this2.scene?.objects ?? []) {
        if (ob.data.type instanceof Light) {
          yield ob.data
        }
      }
    })()
  }

  /**
   * Selected objects whose geometry can be read as triangles, ignoring objects
   * that share one data block (only one of those is yielded).
   */
  get selectedTriangleSourceObjects(): Iterable<SceneObject> {
    const this2 = this
    return (function* () {
      const visit = new Set<unknown>()

      for (const ob of this2.selectedObjects) {
        let bad = ob.data === undefined
        bad = bad || !dataHasCapability(ob.data, GeometryCapability.TRIANGLES)
        bad = bad || visit.has(ob.data)

        if (bad) {
          continue
        }

        yield ob
      }
    })()
  }

  get selectMask() {
    const scene = (this.state.datalib as AppLibrary).scene.active
    if (!scene) {
      return 0
    }
    return scene.selectMask
  }

  set selectMask(val) {
    const scene = (this.state.datalib as AppLibrary).scene.active
    if (!scene) {
      return
    }
    scene.selectMask = val
  }
}

/**
 * Debugging / test-automation surface hanging off `ViewContext.debug`. Reach it
 * from any renderer-JS eval context as `CTX.debug` (the `CTX` window global is
 * `getAppState().ctx`, defined in entry_point.js) or as `ctx.debug` in app code.
 *
 * Its main job is reflecting over the editor registry and forcing a given
 * editor on-screen (`showEditor`) — handy in integration tests, where many
 * ToolOps gate on `canRun` finding an open editor of the right type. See the
 * "Debug context API" guide in CLAUDE.md.
 */
class DebugEditorAPI {
  ctx: ViewContext
  constructor(ctx: ViewContext) {
    this.ctx = ctx
  }

  /**
   * Decode a numeric bitmask into the matching flag names. Relies on the
   * TypeScript `enum` reverse mapping (numeric key → name), so `Flags` must be a
   * real `enum` (e.g. AreaFlags); a plain `{NAME: bit}` object yields nothing.
   */

  private extractTSFlags(Flags: any, flag: number) {
    const flags = [] as string[]
    for (const k in Flags) {
      if (typeof k === 'string' && !isNaN(parseInt(k))) {
        const bit = parseInt(k)
        if (flag & bit) {
          flags.push((Flags as any)[k])
        }
      }
    }
    return flags
  }

  /** Reverse-lookup an icon number to its name in the `Icons` enum (or undefined). */
  getIconKey(icon: number) {
    for (const k in Icons) {
      if (Icons[k as keyof typeof Icons] === icon) {
        return k
      }
    }
    return undefined
  }

  /**
   * List every registered editor type with its `define()` metadata, made
   * human-readable: `flag` is decoded to its `AreaFlags` names, `icon` to its
   * `Icons` key, and the keys are sorted into a stable, readable order. Handy
   * for discovering valid `editorType` values for `showEditor`.
   */
  listEditorTypes() {
    return Object.keys(areaclasses).map((k) => {
      const def = areaclasses[k as keyof typeof areaclasses].define()
      const flags = this.extractTSFlags(AreaFlags, def.flag ?? 0)
      const result = {...def, flags, icon: def.icon ? this.getIconKey(def.icon) : undefined}

      const keyOrder = ['areaname', 'tagname', 'apiname', 'uiname', 'icon', 'flag', 'description', 'borderLock']
      // sort keys
      return Object.fromEntries(
        Object.entries(result).sort((a, b) => {
          let i1 = keyOrder.indexOf(a[0])
          let i2 = keyOrder.indexOf(b[0])
          i1 = i1 === -1 ? 100 : i1
          i2 = i2 === -1 ? 100 : i2
          return i1 - i2
        })
      )
    })
  }

  /** The GPU brush-stroke debug surface (window.DEBUG.gpuBrush) — session
   * state, capture(n), forceReadback(); see documentation/debugSurface.md and
   * plans/gpuGlobalBrushes.md §9.1. Undefined until the first GPU stroke. */
  get gpuBrush(): unknown {
    return (window as unknown as {DEBUG?: {gpuBrush?: unknown}}).DEBUG?.gpuBrush
  }

  /** e.g. CTX.debug.showEditor({editorType: "MaterialEditor"}) */
  showEditor({
    editorType,
    minVisibleWidth,
    minVisibleHeight = minVisibleWidth,
  }: {
    editorType: IEditorConstructor | Editor | string
    minVisibleWidth: number
    minVisibleHeight?: number
  }): {
    editor: Editor
    action:
      | 'already exists'
      | 'swapped out with a PropsEditor'
      | 'swapped out with another editor'
      | 'swapped out with the 3d viewport'
    swappedOutEditor?: Editor
  } {
    const isVisible = (editor2: Editor) => {
      const x1 = Math.max(editor2.pos![0], 0)
      const y1 = Math.max(editor2.pos![1], 0)

      const x2 = Math.min(x1 + editor2.size![0], this.ctx.screen.size[0])
      const y2 = Math.min(y1 + editor2.size![1], this.ctx.screen.size[1])

      const width = x2 - x1
      const height = y2 - y1
      return width > minVisibleWidth && height > minVisibleHeight
    }

    if (editorType instanceof Editor && editorType.owning_sarea?.area === editorType && isVisible(editorType)) {
      return {editor: editorType, action: 'already exists'}
    }
    if (editorType instanceof Editor) {
      console.log('finding another editor, the one you passed in does not meet visibility requirements')
      editorType = editorType.constructor
    }

    let areaname = typeof editorType === 'string' ? editorType : editorType.define().areaname

    if (!(areaname in areaclasses)) {
      // see if we got a cls.define().apiname or tagname instead of .areaname
      for (const k in areaclasses) {
        const def = areaclasses[k as keyof typeof areaclasses].define()
        if (areaname === def.apiname || areaname === def.tagname) {
          areaname = k
        }
      }
    }

    if (!(areaname in areaclasses)) {
      throw new Error('could not find editor class with areaname ' + areaname)
    }

    // see if one is already visible
    const screen = this.ctx.screen
    for (const sarea of screen.sareas) {
      const area = sarea.area as Editor
      if (area.constructor.define().areaname === areaname && isVisible(area)) {
        return {editor: area, action: 'already exists'}
      }
    }

    // if there's a PropsEditor open of sufficient size, use it
    // in preference to a viewport
    for (const sarea of screen.sareas) {
      const area = sarea.area as Editor
      if (area instanceof PropsEditor && isVisible(area)) {
        sarea.switchEditor(areaclasses[areaname])
        return {
          editor          : sarea.area as Editor, //
          action          : 'swapped out with a PropsEditor',
          swappedOutEditor: area,
        }
      }
    }

    // find any area of sufficient size not a viewport
    for (const sarea of screen.sareas) {
      const area = sarea.area as Editor
      if (area instanceof MenuBarEditor) {
        // do not consider the main menu
        continue
      }

      if (!(area instanceof View3D) && isVisible(area)) {
        sarea.switchEditor(areaclasses[areaname])
        return {
          editor          : sarea.area as Editor,
          action          : `swapped out with another editor`,
          swappedOutEditor: area,
        }
      }
    }

    // fall back to replacing the viewport
    for (const sarea of screen.sareas) {
      const area = sarea.area as Editor
      if (area instanceof MenuBarEditor) {
        // do not consider the main menu
        continue
      }

      if (isVisible(area)) {
        sarea.switchEditor(areaclasses[areaname])
        return {
          editor          : sarea.area as Editor,
          action          : `swapped out with the 3d viewport`,
          swappedOutEditor: area,
        }
      }
    }

    console.log('offending cls paramater:', editorType)
    throw new Error('could not resolve editor')
  }
}

export class ViewContext extends ToolContext {
  constructor(state: AppState) {
    super(state)
  }

  debug = new DebugEditorAPI(this)

  /**
   * fulfills when replay is finished, stopCB returns false if it wants replay to stop
   * (it's called after each tool).
   */
  replay(stopCB: () => boolean): Promise<unknown> {
    const start = () => {
      // instead of undo'ing back to root,
      // use RootFileLoadOp
      const toolstack = this.toolstack
      if (toolstack[0] instanceof RootLoadFileOp) {
        this.state.loadFile(toolstack[0].inputs.fileBuffer.getValue(), {
          load_screen    : false,
          reset_toolstack: false,
          reset_context  : false,
        })
        toolstack.cur = 0 // replay will start at cur + 1
      } else {
        console.log('failed to find root file load op; rewinding via undo')
        toolstack.rewind()
      }
    }
    return this.toolstack.replay(stopCB, undefined, start)
  }
  validate() {
    return true
  }

  get camera() {
    return this.view3d?.camera
  }

  get activeTexture() {
    const editor = this.editors.imageEditor

    if (!editor) {
      return undefined
    }

    const image = editor.imageUser.image
    if (!image?.ready) {
      if (image) {
        image.update()
      }

      return undefined
    }

    return image
  }

  activeTexture_save() {
    const block = this.activeTexture

    return block ? block.lib_id : -1
  }

  activeTexture_load(ctx: this, data: number) {
    return ctx.state.datalib.get(data)
  }

  get modalFlag() {
    return this.state.modalFlag
  }

  setModalFlag(f: number) {
    this.state.modalFlag |= f
  }

  clearModalFlag(f: number) {
    this.state.modalFlag &= ~f
  }

  copy() {
    return new ViewContext(this.state)
  }

  get view3d(): View3D {
    // TODO: remove casting after TS-ification
    return getContextArea<View3D>(View3D)
  }

  get propsbar() {
    // TODO: remove casting after TS-ification
    return getContextArea<PropsEditor>(PropsEditor)
  }

  get menubar() {
    // TODO: remove casting after TS-ification
    return getContextArea<MenuBarEditor>(MenuBarEditor)
  }

  get resbrowser() {
    // TODO: remove casting after TS-ification
    return getContextArea<ResourceBrowser>(ResourceBrowser)
  }

  get debugEditor() {
    // TODO: remove casting after TS-ification
    return getContextArea<DebugEditor>(DebugEditor)
  }

  get gl() {
    return this.view3d.gl
  }

  get shaderEditor() {
    // TODO: remove casting after TS-ification
    return getContextArea<MaterialEditor>(MaterialEditor)
  }

  get nodeViewer() {
    // TODO: remove casting after TS-ification
    return getContextArea<NodeViewer>(NodeViewer)
  }

  get editors() {
    return editorAccessor
  }

  editors_save() {
    const editors = this.editors as unknown as Record<string, this>
    const ret = {} as Record<string, this>

    for (const k in editors._namemap) {
      ret[k] = editors[k]
    }

    return ret
  }
  editors_load(ctx: this, data: any) {
    return data
  }

  get area() {
    return this.editor
  }

  get editor() {
    return Editor.getActiveArea()
  }
}

Context.register(ViewContext)

class KeyPassThruProp<K extends string | number | symbol> {
  key: K

  constructor(key: K) {
    this.key = key
  }
}
