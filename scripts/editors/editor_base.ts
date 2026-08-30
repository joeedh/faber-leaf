import {registerDataAPI} from '../data_api/api_define_registry.js'
import {getAppState, peekAppState} from '../core/app_instance.js'
import {
  nstructjs,
  Vector2,
  Vector3,
  Vector4,
  ToolOp,
  StringProperty,
  Quat,
  Matrix4,
  keymap,
  KeyMap,
  HotKey,
  ToolClasses,
  ToolFlags,
  DropBox,
  DataAPI,
  Area,
  DataStruct,
  UIBase,
  Container,
  Menu,
  pushModalLight,
  popModalLight,
  Number3,
  PropertySlots,
  ToolDef,
  IVector2,
  ColumnFrame,
  ToolProperty,
  TabContainer,
  IAreaDef,
  IToolOpConstructor,
  ListItem,
  ModalState,
} from '../path.ux/scripts/pathux'

export const SIDEBAR_ANIM_TIME = 0
import * as units from '../path.ux/scripts/core/units'

//set base unit for world space data
units.Unit.baseUnit = 'foot'

import './theme'

import {Screen} from '../path.ux/scripts/screen/FrameManager'
import {saveUIData, loadUIData} from '../path.ux/scripts/core/ui_base'
import * as util from '../util/util'
import {warning} from '../path.ux/scripts/widgets/ui_noteframe'
import {Icons} from './icon_enum'
import {PackFlags} from '../path.ux/scripts/core/ui_base'

export {keymap, KeyMap, HotKey} from '../path.ux/scripts/pathux'
import {
  DataBlock,
  BlockFlags,
  DataRefProperty,
  IDataBlockConstructor,
  BlockLoader,
  BlockLoaderAddUser,
} from '../core/lib_api'

export {VelPanFlags, VelPan} from './velpan'

/*default toolops for new/duplicate/unlinking datablocks*/
export class NewDataBlockOp<InputSet extends PropertySlots = {}, OutputSet extends PropertySlots = {}> extends ToolOp<
  InputSet & {
    name: StringProperty
    blockType: StringProperty
    dataPathToSet: StringProperty
  },
  OutputSet & {
    block: DataRefProperty<DataBlock>
  },
  ToolContext,
  ViewContext
> {
  static tooldef() {
    return {
      uiname  : 'New',
      toolpath: 'datalib.default_new',
      inputs: {
        name         : new StringProperty(),
        blockType    : new StringProperty(),
        dataPathToSet: new StringProperty(),
      },
      outputs: {
        block: new DataRefProperty(),
      },
    }
  }

  exec(ctx: ToolContext): void {
    const type = this.inputs.blockType.getValue()
    const cls = DataBlock.getClass(type)!

    const ret = new cls()
    const name = this.inputs.name.getValue()

    if (name !== '') {
      ret.name = name
    }

    ctx.datalib.add(ret)

    const path = this.inputs.dataPathToSet.getValue()
    let addUser = true

    if (path !== '') {
      //try to intelligently add reference count with owner block ref. . .
      const rdef = ctx.api.resolvePath(ctx, path)

      if (rdef?.obj && rdef.obj instanceof DataBlock && rdef.obj.lib_id >= 0) {
        if (rdef.obj !== ctx.api.getValue(ctx, path)) {
          ret.lib_addUser(rdef.obj as DataBlock)
          addUser = false
        }
      }

      ctx.api.setValue(ctx, path, ret)
    }

    //if pulling owner block from data api failed (e.g. the owner isn't a datablcok) increment the reference count
    //anyway; it will be regenerated on file load
    if (addUser) {
      ret.lib_addUser()
    }

    this.outputs.block.setValue(ret)
  }
}

ToolOp.register(NewDataBlockOp)

export class CopyDataBlockOp<InputSet extends PropertySlots = {}, OutputSet extends PropertySlots = {}> extends ToolOp<
  InputSet & {
    block: DataRefProperty<DataBlock>
    dataPathToSet: StringProperty
  },
  OutputSet & {
    block: DataRefProperty<DataBlock>
  }
> {
  static tooldef() {
    return {
      uiname  : 'Copy',
      toolpath: 'datalib.default_copy',
      inputs: {
        block        : new DataRefProperty(),
        dataPathToSet: new StringProperty(),
      },
      outputs: {
        block: new DataRefProperty(),
      },
    }
  }

  exec(ctx: ToolContext) {
    const block = ctx.datalib.get(this.inputs.block.getValue())

    if (!block) {
      ctx.warning('failed to duplicated block', block)
      return
    }

    const ret = block.copy()

    //just to be safe, add a user ref, it will be re-derived on load anyway
    ret.lib_users++
    ret.name = block.name

    ctx.datalib.add(ret)

    const path = this.inputs.dataPathToSet.getValue()
    if (path !== '') {
      ctx.api.setValue(ctx, path, ret)
    }

    this.outputs.block.setValue(ret)
  }
}

ToolOp.register(CopyDataBlockOp)

export class AssignDataBlock<InputSet extends PropertySlots = {}, OutputSet extends PropertySlots = {}> extends ToolOp<
  InputSet & {
    block: DataRefProperty<DataBlock>
    dataPathToSet: StringProperty
  },
  OutputSet
> {
  static tooldef(): ToolDef {
    return {
      uiname  : 'Assign',
      toolpath: 'datalib.default_assign',
      inputs: {
        block        : new DataRefProperty(),
        dataPathToSet: new StringProperty(),
      },
    }
  }

  exec(ctx: ToolContext): void {
    const block = ctx.datalib.get(this.inputs.block.getValue())

    const path = this.inputs.dataPathToSet.getValue()
    const rdef = ctx.api.resolvePath(ctx, path)

    if (rdef?.obj && rdef.obj instanceof DataBlock && rdef.obj.lib_id >= 0) {
      const obj = rdef.obj
      const old = ctx.api.getValue<DataBlock>(ctx, path)

      if (old) {
        old.lib_remUser(obj)
      }

      if (block) {
        obj.lib_addUser(block)
      }
    }

    if (path !== '') {
      ctx.api.setValue(ctx, path, block)
    }
  }
}

ToolOp.register(AssignDataBlock)

export class UnlinkDataBlockOp<
  InputSet extends PropertySlots = {},
  OutputSet extends PropertySlots = {},
> extends ToolOp<
  InputSet & {
    block: DataRefProperty<DataBlock>
    dataPathToUnset: StringProperty
  },
  OutputSet & {}
> {
  static tooldef() {
    return {
      uiname  : 'Unlink Block',
      toolpath: 'datalib.default_unlink',
      inputs: {
        block          : new DataRefProperty(),
        dataPathToUnset: new StringProperty(),
      },
      outputs : {},
    }
  }

  exec(ctx: ToolContext) {
    const block = ctx.datalib.get(this.inputs.block.getValue())

    const path = this.inputs.dataPathToUnset.getValue()
    const rdef = ctx.api.resolvePath(ctx, path)

    if (block && rdef?.obj && rdef.obj instanceof DataBlock && rdef.obj.lib_id >= 0) {
      rdef.obj.lib_remUser(block)
    }

    console.log(`setting ${path} to undefined`)
    ctx.api.setValue(ctx, path, undefined)
  }
}

ToolOp.register(UnlinkDataBlockOp)

/**
 * Requires attributes:
 *
 * \attribute datapath
 *
 * \prop blockClass class of data blocks for this browser
 * \prop newOp toolpath for op to make a new block (defaults to "datalib.default_new")
 * \prop duplicateOp toolpath for op to duplciate a block (defaults to "datalib.default_copy")
 * \prop unlinkOp toolpath for op to unlink a block from its owner (defualts to "datalib.default_unlink")
 */

export class DataBlockBrowser<BlockType extends DataBlock> extends Container<ViewContext> {
  blockClass?: IDataBlockConstructor<BlockType, INodeSocketSet, INodeSocketSet>

  //if not undefined, path to "owner" of datapath
  //if undefined, will be derived via datapath api
  ownerPath?: string = undefined
  vertical = false

  _owner_exists = false
  _path_exists = false
  _needs_rebuild = true
  _last_mat_name?: string = undefined

  /* if not undefined, is a function that filters blocks for visibility
   *  in menu*/
  filterFunc?: (block: BlockType) => boolean
  onValidData?: (col: ColumnFrame<ViewContext>) => void

  newOp = 'datalib.default_new'
  duplicateOp = 'datalib.default_copy'
  unlinkOp = 'datalib.default_unlink'
  assignOp = 'datalib.default_assign'

  constructor() {
    super()

    this.useDataPathUndo = false
    this.overrideClass('strip')
  }

  static define() {
    return {
      tagname: 'data-block-browser-x',
    }
  }

  init() {
    super.init()

    this.flagRebuild()
  }

  setCSS() {
    super.setCSS()

    this.background = this.getDefault('background-color') as string

    const radius = this.getDefault('border-radius') ?? 10
    const color = this.getDefault('border-color') ?? 'black'
    const wid = this.getDefault('border-width') ?? 1
    const padding = this.getDefault('padding') ?? 2

    this.style['border'] = `${wid}px solid ${color}`
    this.style['borderRadius'] = radius + 'px'
    this.style['padding'] = padding + 'px'
  }

  flagRebuild() {
    console.warn('flagRebuild')
    this._needs_rebuild = true
  }

  _getDataPath() {
    //image user widget overrides this
    return this.getAttribute('datapath')
  }

  rebuild() {
    this._needs_rebuild = false

    const ctx = this.ctx
    const path = this._getDataPath()

    this.clear()

    if (!this.doesOwnerExist() || path === null) {
      //this.label("Nothing selected");
      return
    }

    console.warn('Data block browser recalc')

    const col = this.col()

    const val = this.getPathValue(ctx, path) as DataBlock | undefined

    this._last_mat_name = val === undefined ? undefined : val.name

    const prop = ctx.datalib.getBlockListEnum(this.blockClass!, this.filterFunc!)
    const dropbox = document.createElement('dropbox-x') as DropBox<ViewContext>

    dropbox.prop = prop
    dropbox.setAttribute('name', val !== undefined ? val.name : '')

    //listenum(inpath, name, enummap, defaultval, callback, iconmap, packflag=0) {
    dropbox.on_select = (id: string | number): void => {
      const val = this.getPathValue(ctx, path) as DataBlock | undefined
      const meta = this.ctx.api.resolvePath(this.ctx, path)

      if (meta === undefined) {
        return
      }
      if (val?.lib_id === parseInt(id as string)) {
        return
      }
      if (val !== undefined) {
        val.lib_remUser(meta.obj)
      }

      const block = ctx.datalib.get(id)!
      block.lib_addUser(meta.obj)

      console.log('Assigning block')

      this.useDataPathUndo = false
      this.setPathValue(ctx, path, block)
      this.flagRebuild()
    }

    const update = dropbox.update as (...args: any[]) => void
    dropbox.update = (...args: any[]) => {
      dropbox.prop = ctx.datalib.getBlockListEnum(this.blockClass!, this.filterFunc!)
      update.apply(dropbox, args)
    }

    let row
    if (!this.vertical) {
      row = col.row()
    } else {
      row = col.col()
    }

    row.add(dropbox)

    const type = this.blockClass!.blockDefine().typeName

    if (val) {
      row.tool(`${this.duplicateOp}(block=${val.lib_id} dataPathToSet="${path}")`, {packflag: PackFlags.USE_ICONS})
      row.tool(`${this.unlinkOp}(block=${val.lib_id} dataPathToUnset="${path}")`, {packflag: PackFlags.USE_ICONS})
    } else {
      row.tool(`${this.newOp}(blockType="${type}" dataPathToSet="${path}")`, {packflag: PackFlags.USE_ICONS})
    }

    if (val !== undefined) {
      row.prop(`${path}.lib_flag[FAKE_USER]`, PackFlags.USE_ICONS)

      if (this.onValidData !== undefined) {
        col.inherit_packflag = this.inherit_packflag
        this.onValidData(col)
      }
    }
  }

  doesOwnerExist() {
    if (this.ownerPath !== undefined) {
      return Boolean(this.ctx.api.getValue(this.ctx, this.ownerPath))
    }

    const path = this._getDataPath()!
    const meta = this.ctx.api.resolvePath(this.ctx, path)

    if (meta === undefined) {
      return false
    }

    return meta.obj !== undefined
  }

  update() {
    // check that init has been called
    this._init()

    const path = this._getDataPath()!

    const exists = this.doesOwnerExist()
    const val = this.getPathValue<DataBlock>(this.ctx, path)
    const name = val?.name

    let rebuild = exists !== this._owner_exists || !!val !== this._path_exists
    rebuild = rebuild || this._needs_rebuild
    rebuild = rebuild || name !== this._last_mat_name

    if (rebuild) {
      this._owner_exists = exists
      this._path_exists = !!val
      this._last_mat_name = name

      this.rebuild()
    }

    super.update()
  }
}

UIBase.register(DataBlockBrowser)

export class ImageUserWidget extends DataBlockBrowser<ImageBlock> {
  constructor() {
    super()
    this.blockClass = ImageBlock
  }

  static define() {
    return {
      tagname: 'image-user-x',
    }
  }

  _getDataPath() {
    return this.getAttribute('datapath') + '.image'
  }
}

UIBase.register(ImageUserWidget)

/**
 *
 * @param container
 * @param cls
 * @param path
 * @param onValidData : callback, gets a container as argument so you can build elements when valid data exists.
 * @returns {*}
 */
export function makeDataBlockBrowser(
  container: Container<ViewContext>,
  cls: IDataBlockConstructor,
  path: string,
  onValidData: (col: ColumnFrame<ViewContext>) => void
) {
  const row = container.row()
  const ret = document.createElement('data-block-browser-x') as any

  ret.inherit_packflag = container.inherit_packflag

  ret.setAttribute('datapath', path)
  ret.blockClass = cls
  ret.onValidData = onValidData

  row.add(ret)

  return row
}

export const getContextArea = <T>(cls: any) => {
  return Area.getActiveArea(cls) as T
}

//used by datapath system
export class EditorAccessor {
  /* @ts-ignore */
  imageEditor: ImageEditor

  _defined: Set<any> = new Set()
  _namemap: {[k: string]: any} = {}

  constructor() {
    this.update()
  }

  update() {
    const define = (k: string, cls: any): void => {
      Object.defineProperty(this, k, {
        get() {
          return getContextArea(cls)
        },
      })
    }

    for (const k in areaclasses) {
      if (this._defined.has(k)) {
        continue
      }

      this._defined.add(k)

      const cls = areaclasses[k]
      const def = cls.define()

      let name = def.apiname ?? def.areaname
      name = name.replace(/[\- \t]/g, '_')

      this._namemap[name] = k
      define(name, areaclasses[k])
    }
  }
}

export const editorAccessor = new EditorAccessor()

/** Characters an area name may carry that a data-API path may not. */
const NAME_RE = /[\- \t]/g

/** The ToolContext struct, kept so an editor registered later can still attach. */
let _editorCtxStruct: DataStruct | undefined = undefined
const _definedEditors = new Set<IEditorConstructor<any>>()

/**
 * Attach one editor class to the data API: its own struct, the `editors.<name>`
 * path on the context, and the accessor property that path reads through.
 *
 * `getDataAPI` is one-shot and runs before addons start, so an addon that owns
 * an editor calls this itself (via `AddonAPI.register`) rather than being swept
 * up by `buildEditorsAPI`. Idempotent: a class already attached is a no-op, so
 * a disable/enable cycle doesn't redefine anything.
 */
export function defineEditorAPI(api: DataAPI, cls: IEditorConstructor<any>): void {
  if (_definedEditors.has(cls)) {
    return
  }
  _definedEditors.add(cls)

  // Incremental and guarded, so this is cheap per class.
  editorAccessor.update()
  cls.defineAPI(api)

  const def = cls.define()
  const name = (def.apiname ?? def.areaname).replace(NAME_RE, '_')
  const uiname = def.uiname ?? ToolProperty.makeUIName(def.areaname)

  api.mapStruct(EditorAccessor, true).struct(name, name, uiname, api.mapStruct(cls))
  _editorCtxStruct?.struct('editors.' + name, name, uiname, api.mapStruct(cls))
}

export function buildEditorsAPI(api: DataAPI, ctxStruct: DataStruct) {
  _editorCtxStruct = ctxStruct

  Editor.defineAPI(api)

  const editorclasses = areaclasses as unknown as {[k: string]: IEditorConstructor<any>}

  for (const k in editorclasses) {
    defineEditorAPI(api, editorclasses[k])
  }
}

export class EditorSideBar extends Container<ViewContext> {
  //expects this.editor to be set by Editor
  editor?: Editor = undefined

  tabpanel!: TabContainer<ViewContext>
  _icon?: UIBase<ViewContext> & {icon?: number}
  _closed = false

  closedWidth = 25
  openWidth = 250

  _height = 500
  _width = this.openWidth

  // can be 'left' or 'right'
  position = 'left'

  #lastUpdateKey = ''

  constructor() {
    super()

    // sets up tabpanel _icon etc
    this.clear()
  }

  get width() {
    return this._width
  }

  set width(v) {
    this._width = v
    this.style['width'] = this._width + 'px'
  }

  get height() {
    return this._height
  }

  set height(v) {
    this._height = v
  }

  set closed(v: boolean) {
    if (!!v === !!this._closed) {
      return
    }

    if (v) {
      this.collapse()
    } else {
      this.expand()
    }
  }

  static define() {
    return {
      tagname: 'editor-sidebar-x',
      style  : 'sidebar',
    }
  }

  updateIcon() {
    if (this._icon === undefined) {
      return
    }

    this._icon.icon = !!this._closed !== !!(this.position === 'right') ? Icons.SHIFT_RIGHT : Icons.SHIFT_LEFT
  }

  clear() {
    super.clear()

    this._icon = this.iconbutton(
      Icons.SHIFT_RIGHT,
      'Collapse/Expand',
      () => {
        if (this._closed) {
          this.expand()
        } else {
          this.collapse()
        }
      },
      undefined,
      PackFlags.SMALL_ICON
    )

    this.updateIcon()

    this.tabpanel = this.tabs('left')
    this.tabpanel.addEventListener('tabclick', (e) => {
      if (this._closed) {
        e.preventDefault()
        this.expand()
      }
    })
    //make tabs smaller
    this.tabpanel.tabFontScale = 0.75
  }

  collapse(doAnim = true) {
    if (this._closed) {
      return
    }

    this._closed = true

    let anim: ReturnType<typeof this.animate> | undefined

    const finish = () => {
      anim?.cancel()
      this.saneStyle['width'] = `${this.closedWidth}px`
      this._width = this.closedWidth
      this.updateIcon()
      this.setCSS()
    }

    if (doAnim) {
      anim = this.animate(
        {width: [this.saneStyle['width'], `${this.closedWidth}px`]},
        {duration: SIDEBAR_ANIM_TIME, fill: 'forwards'}
      )
      anim.finished.then(finish)
    } else {
      finish()
    }
    this.tabpanel.contentsHidden = this.position === 'right'
  }

  expand() {
    if (!this._closed) {
      return
    }

    this._closed = false

    const anim = this.animate(
      {width: [this.saneStyle['width'], `${this.openWidth}px`]},
      {duration: SIDEBAR_ANIM_TIME, fill: 'forwards'}
    )
    this.tabpanel.contentsHidden = false
    anim.finished.then(() => {
      anim.cancel()
      this.saneStyle['width'] = `${this.openWidth}px`
      this.updateIcon()
    })
  }

  update() {
    super.update()

    if (!this.editor?.size) {
      return
    }

    const key = '' + this.position + ':' + this._height

    if (key !== this.#lastUpdateKey) {
      this.#lastUpdateKey = key

      this.tabpanel.setAttribute('bar_pos', this.position)

      const h = this.editor.size[1]
      this._height = h
      this.style['height'] = '' + this._height + 'px'
      this.setCSS()
      this.flushUpdate()
      console.log('Sidebar height update')
      this.updateIcon()
    }
  }

  setCSS() {
    this.style.overflow = 'hidden'
    this.style['height'] = '' + this._height + 'px'
    this.style['width'] = '' + this._width + 'px'
    if (this.position === 'right') {
      this.style.marginLeft = 'auto'
    }
    this.background = this.getDefault('background-color') as string
  }

  saveData() {
    return {
      ...super.saveData(),
      closed: this._closed,
    }
  }

  loadData(obj: any): this {
    if (!obj) {
      return this
    }

    this.closed = obj.closed
    return this
  }
}

UIBase.register(EditorSideBar)

export interface IEditorConstructor<T extends Editor = Editor> extends IAreaConstructor<ViewContext, T> {
  new (): T
  defineAPI(api: DataAPI, struct?: DataStruct): DataStruct
}

const dataPathCache = new Map<IEditorConstructor, string>()

export abstract class Editor extends Area<ViewContext> {
  // we can't pass ViewContext to Area above since TS complains
  //about circular type references.  Instead we do this hack to try and forcibly
  //change the type for (hopefully) base classes
  //ts-expect-error
  //declare ctx: ViewContext

  swapParent?: HTMLElement = undefined
  container: Container<ViewContext>;

  //@ts-ignore
  ['constructor']: IEditorConstructor<this> = this['constructor']

  static getDataPath(areaClass: IEditorConstructor) {
    let path = dataPathCache.get(areaClass)
    if (path === undefined) {
      const def = areaClass.define()
      path = def.apiname ?? def.areaname
      dataPathCache.set(areaClass, path)
    }
    return path
  }

  static define() {
    // abstract static method
    return undefined as unknown as IAreaDef
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
Editor {
}
  `
  )

  constructor() {
    super()

    this.useDataPathUndo = true

    this.swapParent = undefined
    this.container = document.createElement('container-x') as unknown as Container<ViewContext>
    this.container.parentWidget = this

    this.shadow.appendChild(this.container as unknown as HTMLElement)
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = struct ?? api.mapStruct(this, true)

    st.vec2('pos', 'pos', 'Position', 'Position of editor in window')
    st.vec2('size', 'size', 'Size', 'Size of editor')
    st.string('type', 'type', 'Type', 'Editor type')
      .customGet(function (this: ToolProperty) {
        const editor = this.dataref as Editor
        return editor.constructor.define().areaname
      })
      .readOnly()

    return st
  }

  static register(cls: IEditorConstructor<any>): void {
    if (!nstructjs.isRegistered(cls)) {
      throw new Error('You must register editors with nstructjs: ' + cls.name)
    }

    Area.register(cls, false)
  }

  static newSTRUCT() {
    return document.createElement((this as unknown as IEditorConstructor).define().tagname)
  }

  makeSideBar() {
    const sidebar = document.createElement('editor-sidebar-x') as unknown as EditorSideBar
    sidebar.editor = this
    this.container.add(sidebar)
    return sidebar
  }

  dataLink(owner: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {}

  init() {
    super.init()

    this.tabIndex = 1
    this.setAttribute('tabindex', '-1')

    this.container.useDataPathUndo = this.useDataPathUndo

    this.style['overflow'] = 'hidden'

    const cb = () => {
      this.push_ctx_active()
      this.pop_ctx_active()
    }

    /*
    this.addEventListener("dragover", cb, {passive: true});
    this.addEventListener("mouseenter", cb, {passive: true});
    this.addEventListener("mouseover", cb, {passive: true});
    this.addEventListener("mousein", cb, {passive: true});
    this.addEventListener("focus", cb, {passive: true});
*/
    this.defineKeyMap()

    this.container.ctx = this.ctx
    this.makeHeader(this.container, false)
    this.setCSS()
  }

  swapBack() {
    const sarea = this.owning_sarea

    if (this.swapParent) {
      this.swap((this.swapParent as Editor).constructor)
      this.swapParent = undefined
    }

    return sarea!.area
  }

  swap<T extends Editor>(editor_cls: IEditorConstructor<T>, storeSwapParent = true) {
    const sarea = this.owning_sarea!

    sarea.switchEditor(editor_cls)
    if (storeSwapParent) {
      ;(sarea.area! as Editor).swapParent = this as unknown as HTMLElement
    }

    return sarea.area
  }

  onFileLoad(isActive: boolean) {}

  getKeyMaps() {
    return [this.keymap!]
  }

  /*copy of code in Area clas in ScreenArea.js in path.ux.
    example of how to define an area.

  static define() {return {
    tagname  : "areaname-x", //the -x is required by html
    areaname : "areaname", //api name for area type
    apiname  : undefined, //if undefined, will override api instance name, e.g. if you want ctx.areaName instead of ctx.areaname
    uiname   : undefined,
    icon : undefined //icon representing area in MakeHeader's area switching menu. Integer.
    flag : see AreaFlags
  };}
  */

  defineKeyMap() {
    this.keymap = new KeyMap()

    return this.keymap
  }

  getID() {
    return this.ctx.screen.sareas.indexOf(this.owning_sarea!)
  }

  on_keydown(e: KeyboardEvent) {
    this.push_ctx_active()
    this.pop_ctx_active()
  }

  getScreen() {
    return (this.owning_sarea?.screen !== undefined
      ? this.owning_sarea.screen
      : getAppState().screen) as unknown as Screen<ViewContext>
  }
}

import {time_ms} from '../util/util'
import {MakeMaterialOp, Material} from '../core/material'
import {INodeSocketSet, SocketFlags} from '../core/graph'
import {DependSocket} from '../core/graphsockets'
import {ImageBlock} from '../image/image'
import type {ImageEditor} from './all'
import type {ViewContext, ToolContext} from '../core/context'
import messageBus from '../core/bus'
import {areaclasses, IAreaConstructor} from '../path.ux/scripts/screen/area_base'
import type {ShaderNode} from '../shadernodes/shader_nodes'
import type {StructReader} from 'nstructjs'
import type {SceneObjectData} from '../sceneobject'

export function spawnToolSearchMenu(ctx: ViewContext) {
  const tools: IToolOpConstructor[] = []
  const screen = ctx.screen

  const menu = document.createElement('menu-x') as Menu<ViewContext>

  for (const cls of ToolClasses) {
    let ok = !(cls.tooldef().flag! & ToolFlags.PRIVATE)

    try {
      ok = cls.canRun(ctx)
    } catch (error) {
      util.print_stack(error as Error)
      ok = false
    }

    if (!ok) {
      continue
    }

    const tdef = cls.tooldef()
    let hotkey = undefined

    if (tdef.toolpath) {
      hotkey = screen.getHotKey(tdef.toolpath)

      if (hotkey) {
        hotkey = hotkey.buildString()

        console.log('hotkey:', hotkey)
      }
    }

    menu.addItemExtra(tdef.uiname ?? tdef.toolpath ?? 'unknown', tools.length, hotkey)
    tools.push(cls)
  }

  menu.setAttribute('title', 'Tools')

  document.body.appendChild(menu)
  menu.startFancy()

  menu.float(screen.mpos[0], screen.mpos[1], 8)
  menu.style['width'] = '500px'
  menu.on_select = (item: number | string) => {
    console.log(item, 'got item')

    const cls = tools[item as number]
    const tool = cls.invoke(ctx, {})

    if (tool === undefined) {
      warning(ctx.screen, 'Tool failed')
      return
    }

    ctx.toolstack.execTool(ctx, tool)
  }
  //ui.menu("Tools", [["Test", () => {}]]);
}

export class App extends Screen<ViewContext> {
  static STRUCT = nstructjs.inlineRegister(
    App,
    `
App {
}
  `
  )

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = struct ?? api.mapStruct(this)

    st.list('sareas', 'editors', [
      //list should be main App (Screen) instance
      function get(api: DataAPI, list: any, key: number) {
        return list[key].area
      },

      function getKey(api: DataAPI, list: any, obj: any) {
        for (let i = 0; i < list.length; i++) {
          if (list[i].area === obj) {
            return i
          }
        }
      },

      function getLength(api: DataAPI, list: any) {
        return list.length
      },

      function getIter(api: DataAPI, list: any) {
        return (function* () {
          for (const sarea of list) {
            yield sarea.area
          }
        })()
      },

      function getStruct(api: DataAPI, list: any, key: number) {
        let obj = list[key]
        if (obj === undefined) return api.getStruct(Editor)
        obj = obj.area

        let ret = api.getStruct(obj.constructor)
        ret = ret === undefined ? api.getStruct(Editor) : ret

        return ret
      },

      function getActive(api: DataAPI, list: any) {
        return Editor.getActiveArea()
      },
    ])

    return st
  }

  _last_wutime = 0
  //last dpi update time
  _last_dpi: number | undefined

  constructor() {
    super()

    //this.testAllKeyMaps = true;
    this.useDataPathUndo = true

    //last widget update time
    this._last_wutime = 0

    //last dpi update time
    this._last_dpi = undefined

    this.keymap = new KeyMap([
      new HotKey('Z', ['ctrl'], () => {
        getAppState().toolstack.undo()
        window.redraw_viewport()
      }),
      new HotKey('Z', ['ctrl', 'shift'], () => {
        getAppState().toolstack.redo()
        window.redraw_viewport()
      }),
      new HotKey('Y', ['ctrl'], () => {
        console.log('redo!')
        getAppState().toolstack.redo()
        window.redraw_viewport()
      }),
      /*
      new HotKey("T", ["ALT"], () => {
        if (window.__stest) {
          window.__stest.stop();
          window.__stest = undefined;
        } else {
          window.__stest = window._testSculpt(undefined, {sort : 1});
          window.__stest.start();
        }
      }),
      new HotKey("I", ["ALT"], () => {
        if (window.__stest) {
          window.__stest.stop();
          window.__stest = undefined;
        } else {
          window.__stest = window._testSculpt(undefined, {sort : 0});
          window.__stest.start();
        }
      }),*/
      new HotKey('S', ['ctrl'], 'app.save(forceDialog=false)'),
      new HotKey('O', ['ctrl'], 'app.open()'),
      new HotKey('N', ['ctrl'], 'app.new()'),
      new HotKey('N', ['ctrl', 'alt'], 'app.new()'),

      new HotKey('Left', [], () => {
        const time = this.ctx.scene.time
        this.ctx.scene.changeTime(Math.max(time - 1, 0))
      }),
      new HotKey('Right', [], () => {
        const time = this.ctx.scene.time
        this.ctx.scene.changeTime(time + 1)
      }),
    ])
  }

  static define() {
    return {
      tagname: 'webgl-app-x',
    }
  }

  static newSTRUCT() {
    return document.createElement(this.define().tagname)
  }

  setCSS() {
    super.setCSS()
    this.updateCanvasSize()
  }

  updateCanvasSize() {
    const dpi = this.getDPI()

    const size = this.size
    const canvas = this.ctx?.state?.glCanvas

    if (!canvas || size === undefined) {
      return
    }

    const w = size[0]
    const h = size[1]
    const w2 = ~~(w * dpi)
    const h2 = ~~(h * dpi)

    if (canvas.width === w2 && canvas.height === h2) {
      return
    }

    canvas.width = w2
    canvas.height = h2

    canvas.style['width'] = w + 'px'
    canvas.style['height'] = h + 'px'
    canvas.style['position'] = 'absolute'
    canvas.style.zIndex = '-2'
    canvas.dpi = dpi
  }

  on_resize(oldsize: Vector2 | number[], newsize: Vector2 | number[] = this.size, _set_key?: boolean) {
    super.on_resize(oldsize, newsize, _set_key)
    this.setCSS()
  }

  updateDPI() {
    if (this.getDPI() !== this._last_dpi) {
      this._last_dpi = this.getDPI()
      this.setCSS()
    }
  }

  updateWidgets() {
    if (time_ms() - this._last_wutime < 50) {
      return
    }

    this._last_wutime = time_ms()
    const scene = this.ctx.scene

    if (scene !== undefined && typeof scene === 'object') {
      scene.updateWidgets()
    }
  }

  /** @deprecated */
  positionMenu() {
    if (this.ctx === undefined) return

    const menu = this.ctx.menubar
    const view3d = this.ctx.view3d

    if (menu === undefined || view3d === undefined) return

    const x = Math.floor(menu.pos![0])
    const y = Math.floor(menu.pos![0] + menu.size![1])

    const w = Math.ceil(this.size[0])
    const h = Math.ceil(this.size[1] - menu.size![1])

    let update = view3d.pos![0] !== x || view3d.pos![1] !== y
    update = update || view3d.size![0] !== w || view3d.size![1] !== h

    if (update) {
      console.log('menu update', x, y, w, h)

      view3d.pos![0] = x
      view3d.pos![1] = y
      view3d.size![0] = w
      view3d.size![1] = h

      view3d.setCSS()
      window.redraw_viewport()
    }
  }

  update() {
    super.update()

    //this.positionMenu()

    this.updateCanvasSize()

    this.updateWidgets()
    this.updateDPI()
  }
}

window.setInterval(() => {
  const state = peekAppState()
  if (state?.ctx && state.screen) {
    window.updateDataGraph(true)
  }

  ToolOp.onTick()
}, 50)

window.setInterval(() => {
  const state = peekAppState()
  if (state?.ctx) {
    messageBus.validateSubscribers()
  }
}, 5000)
// XXX fix me, any cast
UIBase.register(App as any)

export class ScreenBlock extends DataBlock {
  screen?: App

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
ScreenBlock {
  screen : App;
}`
  )

  constructor() {
    super()

    //this.screen = document.createElement("webgl-app-x");
  }

  static blockDefine() {
    return {
      typeName   : 'screen',
      defaultName: 'Screen',
      uiName     : 'Screen',
      icon       : -1,
      flag       : BlockFlags.FAKE_USER, //always have user count > 0
    }
  }

  copy(): this {
    const ret = new ScreenBlock()

    ret.screen = this.screen?.copy()
    ret.name = this.name
    ret.lib_flag = this.lib_flag

    return ret as unknown as this
  }

  loadSTRUCT(reader: StructReader<this>) {
    reader(this)
    super.loadSTRUCT(reader)
  }
}

DataBlock.register(ScreenBlock)

export class MaterialChooser extends Container<ViewContext> {
  addButton?: UIBase<ViewContext> = undefined
  _last_obdata_key?: string = undefined
  _activeMatCache: number[] = []
  _activeMatCacheSize = 5

  constructor() {
    super()
  }

  static define() {
    return {
      tagname: 'material-chooser-x',
    }
  }

  init() {
    if (this.ctx) {
      try {
        this.rebuild()
      } catch (error) {
        console.error((error as any).stack)
        console.error((error as any).message)
        this.doOnce(this.rebuild)
      }
    }
  }

  getActive(objectData: SceneObjectData): number {
    if (!objectData) return 0

    for (let i = 0; i < this._activeMatCache.length; i += 2) {
      if (this._activeMatCache[i] === objectData.lib_id) {
        let ret = this._activeMatCache[i + 1]

        if (ret >= objectData.materials.length) {
          ret = this._activeMatCache[i + 1] = objectData.materials.length - 1
        }

        return ret
      }
    }

    this.setActive(objectData, 0)
    return 0
  }

  saveData() {
    return Object.assign(super.saveData(), {
      _activeMatCache: this._activeMatCache,
    })
  }

  loadData(json: any) {
    super.loadData(json)

    if (json._activeMatCache) {
      this._activeMatCache = json._activeMatCache
    }

    return this
  }

  setActive(objectData: SceneObjectData, mati: number) {
    let idx = -1

    for (let i = 0; i < this._activeMatCache.length; i += 2) {
      if (this._activeMatCache[i] === objectData.lib_id) {
        idx = i
        break
      }
    }

    if (idx < 0) {
      if (this._activeMatCache.length >= this._activeMatCacheSize) {
        this._activeMatCache.pop()
      }
      this._activeMatCache = [objectData.lib_id, mati].concat(this._activeMatCache)
    } else {
      this._activeMatCache[idx + 1] = mati
    }
  }

  rebuild() {
    const uidata = saveUIData(this, 'material chooser')

    this.clear()
    let objectData = this.ctx.api.getValue<SceneObjectData>(this.ctx, this.getAttribute('datapath')!)

    if (!objectData) {
      this.disabled = true
    }

    this.disabled = false
    this.label(objectData?.name ?? 'No Mesh Selected')

    if (this.on_change && objectData !== undefined) {
      this.on_change(this.getActive(objectData))
    }

    this.button('Add Material', () => {
      const obData = this.ctx.api.getValue<SceneObjectData>(this.ctx, this.getAttribute('datapath')!)
      if (obData === undefined) {
        console.log('Invalid sceneobject data at ' + this.getAttribute('datapath'))
        this.ctx.error('Invalid sceneobject data at ' + this.getAttribute('datapath'))
        return
      }
      const op = new MakeMaterialOp()

      this.ctx.toolstack.execTool(this.ctx, op)
      const mat = this.ctx.datalib.get<Material>(op.outputs.materialID.getValue())!

      obData.materials.push(mat)
      mat.lib_addUser(obData)

      if (this.on_change) {
        ;(this.on_change as unknown as (change: any) => void)(obData.materials.length - 1)
      }
    })

    if (objectData === undefined || objectData.materials.length === 0) {
      return
    }

    const box = this.listbox<number>()
    let i = 0
    for (const mat of objectData.materials) {
      box.addItem(mat?.name ?? '(no material)', i)
      i++
    }
    box.setActive(box.items[this.getActive(objectData)])

    box.onitemchange = (id?: number) => {
      if (this.on_change) {
        this.on_change(id)

        objectData = this.ctx.api.getValue<SceneObjectData>(this.ctx, this.getAttribute('datapath')!)
        if (objectData !== undefined && id !== undefined) {
          this.setActive(objectData, id)
        }
      }
    }

    loadUIData(this, uidata)
    this.flushUpdate()
  }

  update() {
    super.update()

    if (!this.ctx || !this.hasAttribute('datapath')) {
      return
    }

    const mesh = this.ctx.api.getValue<SceneObjectData>(this.ctx, this.getAttribute('datapath')!)
    let key = ''

    if (mesh) {
      key += mesh.lib_id + ':' + mesh.name + ':' + mesh.materials.length

      for (const mat of mesh.materials) {
        key += ':' + (mat?.lib_id ?? -1)
      }
    }

    if (key !== this._last_obdata_key) {
      this._last_obdata_key = key
      this.doOnce(this.rebuild)
    }
  }
}

UIBase.register(MaterialChooser)

export class MaterialPanel extends Container<ViewContext> {
  _lastnode_name?: string = undefined
  chooser?: MaterialChooser
  subpanel?: Container<ViewContext>

  constructor() {
    super()
  }

  static define() {
    return {
      tagname: 'material-panel-x',
    }
  }

  init() {
    this.chooser = document.createElement('material-chooser-x') as unknown as MaterialChooser
    if (this.hasAttribute('datapath')) {
      this.chooser.setAttribute('datapath', this.getAttribute('datapath')!)
    }
    this.add(this.chooser)

    this.subpanel = this.col()

    this.chooser.on_change = () => {
      this.doOnce(this.rebuild)
    }
    this.rebuild()
    this.flushUpdate()
  }

  rebuild() {
    if (!this.ctx || !this.hasAttribute('datapath') || this.chooser === undefined || this.subpanel === undefined) {
      console.error('material panel error cannot build widget')
      return
    }

    const objectData = this.ctx.api.getValue<SceneObjectData>(this.ctx, this.getAttribute('datapath')!)

    console.log('Material panel rebuild')

    const uidata = saveUIData(this.subpanel, 'mesh material panel')
    this.subpanel?.clear()

    if (!objectData) {
      loadUIData(this.subpanel, uidata)
      this.flushUpdate()
      return
    }

    const mati = this.chooser!.getActive(objectData)
    const datapath = this.getAttribute('datapath')
    const mat = objectData.materials[mati]

    if (!mat) {
      loadUIData(this.subpanel, uidata)
      this.flushUpdate()
      return
    }

    // The active toolmode can contribute rows for this slot (box-modeling's
    // "Assign to Selected", sculpt's "Assign by Poly Group"). Duck-typed rather
    // than importing ToolMode — editor_base is below the view3d layer.
    const toolmodeClass = (this.ctx.scene as unknown as {toolmode?: {constructor: unknown}})?.toolmode?.constructor as
      | {buildMaterialPanel?(container: unknown, slot: number): void}
      | undefined
    toolmodeClass?.buildMaterialPanel?.(this.subpanel, mati)

    const dataPrefix = `${datapath}.materials[${mati}].`
    this.subpanel.dataPrefix = dataPrefix
    this.subpanel.prop('has_shader')

    if (this.ctx.api.getValue(this.ctx, this.subpanel.dataPrefix + 'has_shader')) {
      const node = this.ctx.api.getValue<ShaderNode>(this.ctx, this.subpanel.dataPrefix + 'shader')
      if (node === undefined) {
        this.ctx.error('Could not find shader node ' + this.subpanel.dataPrefix + 'shader')
        loadUIData(this.subpanel, uidata)
        return
      }

      for (const k in node.inputs) {
        const sock = node.inputs[k]
        let bad = sock.edges.length > 0
        bad = bad || !!(sock.graph_flag & SocketFlags.PRIVATE)
        bad = bad || sock instanceof DependSocket

        if (bad) {
          continue
        }

        const subpath = dataPrefix + `shader.inputs["${k}"].`
        this.subpanel.dataPrefix = subpath
        this.subpanel.inherit_packflag |= PackFlags.NO_NUMSLIDER_TEXTBOX

        sock.buildUI(this.subpanel, () => {})
      }

      this.subpanel.dataPrefix = dataPrefix
    }

    loadUIData(this.subpanel, uidata)
    this.flushUpdate()
  }

  getShadingNode() {
    if (!this.hasAttribute('datapath')) {
      return undefined
    }

    const objectData = this.getPathValue<SceneObjectData>(this.ctx, this.getAttribute('datapath')!)
    if (!objectData) {
      return undefined
    }

    const mat = this.chooser!.getActive(objectData)
    return this.getPathValue(this.ctx, this.getAttribute('datapath') + `.materials[${mat}].shader`)
  }

  update() {
    super.update()

    if (!this.chooser || !this.ctx) {
      return
    }

    let rebuild = false

    if (this.hasAttribute('datapath')) {
      if (this.getAttribute('datapath') !== this.chooser.getAttribute('datapath')) {
        this.chooser.setAttribute('datapath', this.getAttribute('datapath')!)
        rebuild = true
      }
    }

    const node = this.getShadingNode()
    const name = node ? node.constructor.name : 'undefined'

    if (name !== this._lastnode_name) {
      this._lastnode_name = name
      rebuild = true
    }

    if (rebuild) {
      this.doOnce(this.rebuild)
    }
  }
}

UIBase.register(MaterialPanel)

export class DirectionChooser extends UIBase<ViewContext, Vector3> {
  _last_dpi?: number
  size = 128
  mdown = false
  modaldata?: ModalState
  _highlight = false
  last_th = 0
  start_th = 0

  flip = [1, 1]

  first: boolean = false
  start_value: Vector3 = new Vector3()
  last_mpos = new Vector2()
  start_mpos = new Vector2()
  accessor value = new Vector3([0, 0.1, 1])

  canvas: HTMLCanvasElement
  g: CanvasRenderingContext2D
  _disabled: boolean = false

  constructor() {
    super()

    this.canvas = document.createElement('canvas')
    this.shadow.appendChild(this.canvas)

    this.g = this.canvas.getContext('2d')!
  }

  get highlight() {
    return this._highlight
  }

  set highlight(v) {
    const render = !!v !== !!this._highlight

    this._highlight = v
    if (render) {
      this.doOnce(this.render)
    }
  }

  get disabled() {
    super.disabled
    return this._disabled
  }

  set disabled(v) {
    let render

    if (this._disabled !== v) {
      this.render()
    }

    this._disabled = v
  }

  static define() {
    return {
      tagname: 'direction-chooser-3d-x',
    }
  }

  endModal() {
    if (this.modaldata) {
      console.log('end modal')
      popModalLight(this.modaldata)
    }

    this.modaldata = undefined
    this.mdown = false
    return
  }

  init() {
    super.init()

    this.noMarginsOrPadding()
    this.setCSS()
    this._disabled = false

    this.addEventListener('mouseover', (e) => {
      this.highlight = true
    })
    this.addEventListener('mouseleave', (e) => {
      this.highlight = false
      //this.mdown = false;
    })
    this.addEventListener('mouseout', (e) => {
      this.highlight = false
      //this.mdown = false;
    })
    this.addEventListener('focus', (e) => {
      this.highlight = true
    })
    this.addEventListener('blur', (e) => {
      this.highlight = false
      this.mdown = false
    })

    const mousedown = (event: PointerEvent, x: number, y: number) => {
      this.mdown = true
      this.last_th = 0
      this.first = true
      this.start_value = new Vector3(this.value)
      this.start_mpos[0] = x
      this.start_mpos[1] = y
      this.last_mpos[0] = x
      this.last_mpos[1] = y

      this.flip = [1, 1]

      const table = [-1, 1, -1, -1]

      const a = this.value[0] >= 0.0 ? 1 : 0
      const b = this.value[1] >= 0.0 ? 1 : 0
      const m = a | (b << 1)

      const r = this.getBoundingClientRect()
      const dx2 = x - (r.x + r.width * 0.5)
      const dy2 = y - r.y - r.height * 0.5
      const s = dx2 * this.value[1] - dy2 * this.value[0]

      //this.flip[0] = s < 0.0 ? -1.0 : 1.0;
      //this.flip[0] = table[m];

      if (this.modaldata) {
        this.endModal()
      }

      this.modaldata = pushModalLight({
        on_mousedown: (e: MouseEvent) => {
          if (e.button === 2) {
            this.endModal()
            this.setValue(this.start_value)
          }
        },
        on_mousemove: (e: MouseEvent) => {
          let mat = new Matrix4()

          //mat.multiply(rmat);

          const r = this.canvas.getBoundingClientRect()
          const rx = r.x + r.width * 0.5
          const ry = r.y + r.height * 0.5

          let dx2 = e.x - rx
          let dy2 = e.y - ry
          let sdx2 = this.start_mpos[0] - rx
          let sdy2 = this.start_mpos[1] - ry

          const scale = 1.0 / (0.5 * this.size * Math.sqrt(3.0))
          let rawlen = Math.sqrt(dx2 * dx2 + dy2 * dy2) / (Math.sqrt(2.0) * this.size)

          sdx2 = Math.min(Math.max(sdx2, -this.size), this.size)
          sdy2 = Math.min(Math.max(sdy2, -this.size), this.size)
          dx2 = Math.min(Math.max(dx2, -this.size), this.size)
          dy2 = Math.min(Math.max(dy2, -this.size), this.size)

          const v1 = new Vector3([sdx2 * scale, sdy2 * scale, 0])
          const v2 = new Vector3([dx2 * scale, dy2 * scale, 0])

          v1[2] = 1.0 - (v1[0] + v1[1])
          v2[2] = 1.0 - (v2[0] + v2[1])

          v1.normalize()
          v2.normalize()

          if (v1.vectorDistance(v2) < 0.05) {
            return
          }

          const axis = new Vector3(v1).cross(v2).normalize()
          rawlen *= 4.0

          let th = Math.acos(v1.dot(v2) * 0.999999)
          th += rawlen * Math.sign(th)

          const quat = new Quat()
          quat.axisAngleToQuat(axis, th)
          quat.normalize()
          mat = quat.toMatrix()

          this.value.load(this.start_value)
          this.value.multVecMatrix(mat)

          //*
          if (this.hasAttribute('datapath')) {
            this.setPathValue(this.ctx, this.getAttribute('datapath')!, this.value)
          }
          if (this.on_change) {
            this.on_change(this.value as unknown as Event)
          } //*/

          this.last_mpos[0] = e.x
          this.last_mpos[1] = e.y
          this.render()
        },
        on_mouseup: (e: PointerEvent) => {
          this.endModal()
        },
        on_touchend: (e: PointerEvent) => {
          this.endModal()
        },
        on_touchcancel: (e: PointerEvent) => {
          this.endModal()
          this.setValue(this.start_value)
        },

        on_keydown: (e: KeyboardEvent) => {
          console.log(e.keyCode, this.modaldata)

          switch (e.keyCode) {
            case keymap['Escape']:
              this.setValue(this.start_value)
            // eslint-disable-next-line no-fallthrough
            case keymap['Enter']:
              this.endModal()
              break
          }
        },
      })
    }

    this.addEventListener('pointerdown', (e) => {
      mousedown(e, e.x, e.y)
    })
    this.addEventListener('pointerend', (e) => {
      if (this.modaldata) {
        this.endModal()
      }
    })

    this.tabIndex = 0
  }

  _getRMat() {
    const quat = new Quat()
    const axis = new Vector3()
    const av = new Vector3(this.value)
    const value = new Vector3(this.value).normalize()

    av.abs()

    if (1 || (av[0] > av[1] && av[0] > av[2])) {
      axis[2] = 1.0
    } else {
      axis[0] = 1.0
    }

    axis.cross(value).normalize()

    const vth = Math.acos(value[2] * 0.99999)
    quat.axisAngleToQuat(axis, vth)
    quat.normalize()
    const rmat = quat.toMatrix()

    return rmat
  }

  setCSS() {
    super.setCSS()

    const dpi = UIBase.getDPI()

    this._last_dpi = dpi

    const w = ~~(this.size * dpi)
    this.canvas.width = w
    this.canvas.height = w

    this.canvas.style.width = w / dpi + 'px'
    this.canvas.style.height = w / dpi + 'px'

    this.canvas.style['borderRadius'] = '5px'
    this.canvas.style['backgroundColor'] = 'white'

    this.render()
  }

  render() {
    //console.log("rendering direction chooser");

    const g = this.g
    const canvas = this.canvas
    const size = canvas.width

    g.clearRect(0, 0, size, size)

    if (this.disabled) {
      g.fillStyle = 'rgb(55,55,55)'
      g.beginPath()
      g.rect(0, 0, size, size)
      g.fill()
      return
    }

    g.save()
    g.scale(size, size)
    g.beginPath()

    let steps
    const p = new Vector4()
    let r = 0.04

    const mat = new Matrix4()

    const rmat = this._getRMat()

    mat.perspective(25, 1.0, 0.01, 10.0)

    function proj(p2: Vector4) {
      p2[3] = 1.0
      //p[2] = -p[2];
      p2[2] -= 4.0

      p2.multVecMatrix(mat)
      const w = p2[3]

      if (Math.abs(w) > 0.00001) {
        p2.mulScalar(1.0 / w)
        p2[3] = w
      }

      p2[0] = p2[0] * 0.5 + 0.5
      p2[1] = p2[1] * 0.5 + 0.5

      return w
    }

    g.beginPath()
    g.fillStyle = 'rgba(55,55,55,0.35)'

    steps = 64
    let th = -Math.PI
    const dth = (Math.PI * 2.0) / steps
    r *= 1.5

    for (let i = 0; i < steps; i++, th += dth) {
      //break;
      for (let j = 0 as Number3; j < 3; j++) {
        const r2 = 0.33
        p[j] = Math.sin(th) * r2
        p[((j + 1) % 3) as Number3] = Math.cos(th) * r2
        p[((j + 2) % 3) as Number3] = 0.0

        p.multVecMatrix(rmat)

        const w = proj(p)

        if (w < 0) continue

        //console.log("XY",p[0].toFixed(3), p[1].toFixed(3), th, i, dth);

        g.moveTo(p[0], p[1])
        g.arc(p[0], p[1], r / w, -Math.PI, Math.PI)
      }
    }

    g.fill()

    g.beginPath()
    if (this.highlight) {
      g.fillStyle = 'rgba(250, 128, 55, 0.5)'
    } else {
      g.fillStyle = 'rgba(55,55,55,0.5)'
    }

    steps = 64
    let s = 0
    const ds = 1.0 / steps

    const value4 = new Vector4().loadXYZ(this.value[0], this.value[1], this.value[2])

    for (let i = 0; i < steps; i++, s += ds) {
      p.zero().interp(value4, s).mulScalar(1.5)

      const w = proj(p)

      const x = p[0]
      const y = p[1]

      if (w < 0.0) {
        continue
      }
      g.moveTo(x, y)
      g.arc(x, y, r / w, -Math.PI, Math.PI)
    }

    g.fill()

    g.restore()
  }

  setValue(v: Vector3) {
    this.value.load(v)

    if (this.hasAttribute('datapath')) {
      this.setPathValue(this.ctx, this.getAttribute('datapath')!, this.value)
      this.render()
    }

    if (this.on_change) {
      ;(this.on_change as unknown as (value: Vector3) => void)(this.value)
    }
  }

  updateDataPath() {
    if (!this.hasAttribute('datapath') || !this.ctx) {
      return
    }

    const val = this.getPathValue<Vector3>(this.ctx, this.getAttribute('datapath')!)

    if (val === undefined) {
      this.disabled = true
      return
    }

    this.disabled = false
    if (this.value.vectorDistance(val) > 0.0001) {
      console.log('path update')

      this.value.load(val)
      if (this.on_change) {
        this.on_change(val)
      }

      this.render()
    }
  }

  updateDPI() {
    const dpi = UIBase.getDPI()

    if (this._last_dpi !== dpi) {
      this._last_dpi = dpi
      this.setCSS()
    }
  }

  update() {
    super.update()

    this.updateDPI()
    this.updateDataPath()
  }
}

UIBase.register(DirectionChooser)

registerDataAPI(App)
