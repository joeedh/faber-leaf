import {KeyMap} from '../editor_base'
import {SimpleMesh, ChunkedSimpleMesh, LayerTypes} from '../../webgl/simplemesh'
import {IWidgetConstructor, WidgetBase, WidgetFlags, WidgetManager} from './widgets/widgets.js'
import {WidgetSceneCursor} from './widgets/widget_tools.js'
import {Container, DataAPI, DataStruct, EnumProperty, Vector3, Vector4} from '../../path.ux/scripts/pathux.js'
import {Icons} from '../icon_enum.js'
import '../../path.ux/scripts/util/struct.js'
import {INodeConstructor, INodeSocketSet, Node} from '../../core/graph.js'
import {nstructjs} from '../../path.ux/scripts/pathux.js'

import '../../webgl/textsprite.js'

import messageBus, {BusTriggers} from '../../core/bus'
import type {ViewContext} from '../../core/context'
import type {SceneObject} from '../../sceneobject/sceneobject'
import type {Scene} from '../../scene/scene'
import type {BlockLoader, BlockLoaderAddUser} from '../../core/lib_api'
import {StandardTools} from '../../sceneobject/stdtools'
import type {AppState} from '../../core/appstate'
import {View3D} from '../all'
import {DrawLine, type ITempText} from './view3d_base'
import {IUniformsBlock, ShaderProgram} from '../../webgl/webgl'
import type {SceneObjectData} from '../../sceneobject/sceneobject_base'
import type {BoundingBox} from './view3d_utils'
import type {StructReader} from '../../path.ux/scripts/util/nstructjs'
import {normalizeSelMask, selMaskToNames} from '../../core/select_types.js'

export interface IToolModeDefine {
  name: string
  uiname: string
  icon: number
  flag: number
  description: string
  selectMode?: number
  stdtools?: StandardTools
  transWidgets?: (typeof WidgetBase<any, any>)[]
}

type ViewContainer = Container<ViewContext>

export class ToolMode<NodeInputs extends INodeSocketSet = {}, NodeOutputs extends INodeSocketSet = {}> extends Node<
  NodeInputs,
  NodeOutputs,
  ViewContext
> {
  static dataPath = 'scene.tool'

  // owning view3d
  view3d?: View3D

  transformWidget: number = -1
  ctx: ViewContext
  flag: number = 0
  widgets: WidgetBase[] = []
  _uniqueWidgets: {[key: string]: WidgetBase} = {}
  transWidget: WidgetBase | undefined

  drawlines: DrawLine[] = []
  drawtexts: ITempText[] = []

  selectMask: number = 0
  _transProp: EnumProperty
  storedSelectMask: number = -1
  keymap: KeyMap
  manager?: WidgetManager;

  ['constructor']: INodeConstructor<this, NodeInputs, NodeOutputs> & typeof ToolMode = this['constructor']

  constructor(ctx: ViewContext) {
    super()

    this.ctx = ctx
    this.flag |= WidgetFlags.ALL_EVENTS

    this.drawlines = []
    this.drawtexts = []

    this.widgets = []
    this._uniqueWidgets = {}
    this.transWidget = undefined

    //@ts-expect-error constructor is typed as Function; toolModeDefine is a static on the subclass
    this.selectMask = this.constructor.toolModeDefine().selectMode
    this._transProp = this.constructor.getTransformProp()

    this.storedSelectMask = -1 //used by scene

    this.keymap = new KeyMap()
    this.defineKeyMap()
  }

  drawsObjectIdsExclusively(ob: SceneObject) {
    return false
  }

  setManager(widget_manager: WidgetManager) {
    this.manager = widget_manager
  }

  /** easy line drawing (in 3d)*/
  makeTempLine(v1: Vector3, v2: Vector3, color: Vector4) {
    const dl = this.ctx.view3d.makeDrawLine(v1, v2, color)
    this.drawlines.push(dl)
    return dl
  }

  makeTempText(co: Vector3, string: string, color: Vector4) {
    const dt = this.ctx.view3d.makeDrawText(co, string, color)
    this.drawtexts.push(dt)
    return dt
  }

  resetTempGeom(ctx = this.ctx) {
    for (const dl of this.drawlines) {
      ctx.view3d.removeDrawLine(dl)
    }
    for (const dt of this.drawtexts) {
      ctx.view3d.removeDrawText(dt)
    }

    this.drawlines.length = 0
  }

  static toolModeDefine(): IToolModeDefine {
    return {
      name        : 'name',
      uiname      : 'uiname',
      icon        : -1,
      flag        : 0,
      description : '',
      selectMode  : undefined, //if set, preferred selectmode, see SelModes
      stdtools    : undefined, //if set, will override standard tools in inherited keymaps
      transWidgets: [] as (typeof WidgetBase<any, any>)[], //list of widget classes tied to this.transformWidget
    }
  }

  static nodedef() {
    return {
      name   : 'tool',
      uiname : 'tool',
      inputs : {},
      outputs: {},
    }
  }

  get typeName() {
    return this.constructor.toolModeDefine().name
  }

  getKeyMaps() {
    return [this.keymap]
  }

  defineKeyMap() {
    this.keymap = new KeyMap([])
  }

  //returns a bounding box [min, max]
  //if toolmode has a preferred aabb to
  //zoom out on, otherwise returns undefined;
  getViewCenter(): BoundingBox | undefined {
    return undefined
  }

  static buildEditMenu(): string[] {
    return []
  }

  static buildElementSettings(container: ViewContainer) {}

  static buildSettings(container: ViewContainer) {}

  /**
   * Contribute rows to the properties editor's Material tab for the active
   * material slot — e.g. box-modeling's "Assign to Selected". Called by
   * MaterialPanel.rebuild with the slot the chooser has active, so an op bound
   * here should take `slot=${slot}`. Only the active toolmode contributes.
   */
  static buildMaterialPanel(container: ViewContainer, slot: number) {}

  dataLink(scene: Scene, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {}

  static buildHeader(header: ViewContainer, addHeaderRow: () => ViewContainer) {}

  static getContextOverlayClass(): (new (state: AppState, toolmode: ToolMode) => ViewContext) | undefined {
    return undefined
  }

  static busDefine() {
    return {
      events  : ['REGISTER', 'UNREGISTER'],
      triggers: [],
    } as const
  }

  onTrigger(trigger: BusTriggers<typeof ToolMode>, data: any) {
    // no triggers currently
    switch (
      trigger
      //
      // eslint-disable-next-line no-empty
    ) {
    }
  }

  static unregister(cls: any) {
    ToolModes.remove(cls)
    messageBus.emitSync(undefined, ToolMode, 'UNREGISTER', cls)
  }

  static register(cls: any) {
    if (cls.toolModeDefine === this.toolModeDefine) {
      throw new Error('cls is missing its toolModeDefine')
    }
    // eslint-disable-next-line no-prototype-builtins
    if (!cls.hasOwnProperty('STRUCT') || cls.STRUCT === this.STRUCT) {
      throw new Error('cls lacks its own STRUCT script')
    }

    ToolModes.push(cls)
    messageBus.emitSync(undefined, ToolMode, 'REGISTER', cls)
  }

  static getTransformProp() {
    let classes = this.toolModeDefine().transWidgets
    classes = classes === undefined ? [] : classes

    const enumdef = {} as {[key: string]: number}
    const uinames = {} as {[key: string]: string}
    const icons = {} as {[key: string]: number}
    const descr = {} as {[key: string]: string}

    enumdef.NONE = 0
    icons.NONE = Icons.DISABLED
    uinames.NONE = 'disable'
    descr.NONE = 'Hide transform widgets'

    let i = 1

    for (const cls of classes) {
      const def = cls.widgetDefine()

      const k = def.name || cls.name

      enumdef[k] = i++
      uinames[k] = def.uiname ? def.uiname : k
      descr[k] = def.description ? def.description : uinames[k]
      icons[k] = def.icon ? def.icon : -1
    }

    const prop = new EnumProperty(undefined, enumdef)
    prop.addIcons(icons)
    prop.addUINames(uinames)
    prop.addDescriptions(descr)

    return prop
    //return WidgetTool.getToolEnum(classes, FlagProperty, true);
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const tstruct = struct ?? api.mapStruct(this, true)
    tstruct.name = this.name !== undefined ? this.name : this.toolModeDefine().name
    tstruct.string('typeName', 'type', 'Type', 'Tool Mode Type')

    const prop = this.getTransformProp()
    if (prop !== undefined) {
      tstruct.enum('transformWidget', 'transformWidget', prop, 'Transform Widget', 'Current transformation widget')
    }

    return tstruct
  }

  hasWidgetWithKey(key: string) {
    return this.getWidgetWithKey(key) !== undefined
  }

  getWidgetWithKey(key: string) {
    const widget = this.ctx.scene.widgets.getWidgetWithKey(key)

    if (widget && !widget.isDead && this.widgets.includes(widget)) {
      return widget
    }

    return undefined
  }

  /**
   * Spawn a unique widget
   * @param widgetclass : widget class
   */
  ensureUniqueWidget(widgetclass: typeof WidgetBase) {
    if (this.ctx === undefined) {
      return
    }

    const manager = this.ctx.scene.widgets

    const valid = widgetclass.ctxValid(this.ctx)
    const def = widgetclass.widgetDefine()

    if (def.name in this._uniqueWidgets && this._uniqueWidgets[def.name].isDead) {
      this.removeUniqueWidget(this.getUniqueWidget(widgetclass))
    }

    if (!valid && def.name in this._uniqueWidgets) {
      this.removeUniqueWidget(this.getUniqueWidget(widgetclass))
      window.redraw_viewport()

      return
    } else if (valid && !(def.name in this._uniqueWidgets)) {
      const widget = new widgetclass()
      manager.add(widget)

      this.widgets.push(widget)
      this._uniqueWidgets[def.name] = widget

      if (def.selectMode !== undefined && this.ctx.scene.selectMask !== def.selectMode) {
        this.ctx.scene.selectMask = def.selectMode
      }

      window.redraw_viewport()
      return widget
    } else {
      return this._uniqueWidgets[def.name]
    }
  }

  addWidget(widget: WidgetBase) {
    this.widgets.push(widget)
    this.ctx.scene.widgets.add(widget)
  }

  removeWidget(widget: WidgetBase) {
    for (const k in this._uniqueWidgets) {
      if (this._uniqueWidgets[k] === widget) {
        delete this._uniqueWidgets[k]
      }
    }

    this.widgets.remove(widget)
    this.ctx.scene.widgets.remove(widget)
  }

  hasUniqueWidget(cls: IWidgetConstructor) {
    return this.getUniqueWidget(cls) !== undefined
  }

  getUniqueWidget(cls: IWidgetConstructor) {
    const def = cls.widgetDefine()
    return this._uniqueWidgets[def.name]
  }

  removeUniqueWidget(widget: WidgetBase) {
    const def = widget.constructor.widgetDefine()

    if (this.widgets.includes(widget)) {
      this.widgets.remove(widget)
    }

    delete this._uniqueWidgets[def.name]
    widget.remove()
  }

  getWidgetHighlight() {
    return this.ctx.scene.widgets.widgets.highlight
  }

  hasWidgetHighlight() {
    return this.getWidgetHighlight() !== undefined
  }

  checkCtx(ctx?: ViewContext) {
    if (ctx !== undefined && this.ctx === undefined) {
      //note: toolmode may have it's own ctx
      this.ctx = ctx
    }
    return this
  }

  update() {
    if (!this.ctx) {
      return this
    }

    const cls = this.constructor.getContextOverlayClass()
    if (cls !== undefined && !(this.ctx instanceof cls)) {
      // eslint-disable-next-line no-console
      console.warn('reimplement toolmode ctx overlays!')
      this.ctx = new cls((this.ctx as any).state, this)
    }

    const del = []

    for (const widget of this.widgets) {
      if (widget.isDead) {
        del.push(widget)
      }
    }

    for (const widget of del) {
      this.widgets.remove(widget)
    }

    const tws = this.constructor.toolModeDefine().transWidgets || []
    let tcls: typeof WidgetBase | undefined
    const ti = this.transformWidget - 1

    if (ti >= 0 && ti < tws.length) {
      tcls = tws[ti]
    }

    if (this.transWidget && tcls !== this.transWidget.constructor) {
      this.removeUniqueWidget(this.transWidget)
      this.transWidget = undefined
    }

    if (!this.transWidget && tcls) {
      this.transWidget = this.ensureUniqueWidget(tcls)
    }

    // Scene 3D-cursor widget: alive whenever the active view shows the cursor
    // (its isDead getter removes it via the dead-sweep above when hidden).
    // The manager-level hasWidget guard keeps toolmode switches from stacking
    // duplicates (each toolmode has its own _uniqueWidgets registry).
    if (this.ctx.view3d?._showCursor?.() && !this.ctx.scene.widgets.hasWidget(WidgetSceneCursor)) {
      this.ensureUniqueWidget(WidgetSceneCursor as unknown as typeof WidgetBase)
    }

    /*
    for (let widget of this.widgets) {
      widget.update(this.ctx.scene.widgets);
    }
    //*/
    return this
  }

  onActive() {}

  clearWidgets() {
    if (!this.ctx?.scene) {
      return
    }

    const manager = this.ctx.scene.widgets

    for (const widget of this.widgets) {
      manager.remove(widget)
    }

    this.transWidget = undefined

    this._uniqueWidgets = {}
    this.widgets = []
  }

  onInactive() {
    //if (this.ctx && cls && this.ctx.hasOverlay(cls)) {
    //  this.ctx.removeOverlay(this.ctx.getOverlay(cls))
    //}

    this.clearWidgets()

    if (this.ctx) {
      this.resetTempGeom()
    }
  }

  graphDisconnect() {
    for (const sock of this.allsockets) {
      sock.disconnect()
    }
  }

  destroy() {
    this.clearWidgets()
    this.graphDisconnect()
  }

  onContextLost(e: WebGLContextEvent) {
    //
  }

  /** returns true if consumed the event */
  on_mousedown(e: PointerEvent, x: number, y: number, was_touch?: boolean): boolean | void {}

  on_mousemove(e: PointerEvent, x: number, y: number, was_touch?: boolean): boolean | void {}

  on_mouseup(e: PointerEvent, x: number, y: number, was_touch?: boolean): boolean | void {}

  on_drawstart(view3d: View3D): boolean | void {}

  draw(view3d: View3D, gl: WebGL2RenderingContext): boolean | void {}

  on_drawend(view3d: View3D): boolean | void {}

  /*
get view3d() {
  return this._view3d;
}

set view3d(val) {
  console.warn("view3d set", val !== undefined ? val.constructor.name : undefined);
  this._view3d = val;
}
//*/

  drawsObjectIds(obj: SceneObject) {
    return false
  }

  /**
   * draw any extra ids the toolmode needs
   * */
  drawIDs(view3d: View3D, gl: WebGL2RenderingContext, uniforms: IUniformsBlock) {}

  /*
   * called for all objects;  returns true
   * if an object if the toolmode drew the object
   * itself
   */
  drawObject(
    gl: WebGL2RenderingContext,
    uniforms: IUniformsBlock,
    program: ShaderProgram,
    object: SceneObject,
    data: SceneObjectData
  ) {
    return false
  }

  /** Write-side of the frozen name form of `storedSelectMask`; see `core/select_types.ts`. */
  get storedSelectMaskName(): string {
    return this.storedSelectMask === -1 ? '' : selMaskToNames(this.storedSelectMask)
  }

  loadSTRUCT(reader: StructReader<this>) {
    reader(this)
    super.loadSTRUCT(reader)

    //files written before APP_VERSION 8 store this as a raw int; '' means unset
    this.storedSelectMask = normalizeSelMask(this.storedSelectMask, -1)
  }
}

ToolMode.STRUCT = `
ToolMode {
  transformWidget  : int;
  storedSelectMask : string | obj.storedSelectMaskName;
}
`
nstructjs.register(ToolMode)

type MeshId = string | number

/**
 * All the host asks of a cached per-geometry drawer: that it can release its GL
 * resources. Structural rather than a named base class, so the drawer itself can
 * live in whichever addon owns the geometry it draws.
 */
export interface IGeometryDrawer {
  destroy(gl: WebGL2RenderingContext): void
}

export class MeshCache {
  meshid: MeshId
  meshes: {[k: MeshId]: ChunkedSimpleMesh | SimpleMesh}
  /**
   * current generation, we know mesh has changed when
   *  mesh.updateGen is not this
   */
  gen?: number
  drawer?: IGeometryDrawer

  constructor(meshid: MeshId) {
    this.meshid = meshid
    this.meshes = {}
    this.drawer = undefined

    this.gen = undefined
  }

  getMesh(name: MeshId) {
    return this.meshes[name]
  }

  makeMesh(name: MeshId, layers: LayerTypes) {
    if (!(name in this.meshes)) {
      this.meshes[name] = new SimpleMesh(layers)
    }

    return this.meshes[name]
  }

  makeChunkedMesh(name: MeshId, layers: LayerTypes) {
    if (layers === undefined) {
      throw new Error('layers cannot be undefined')
    }

    if (!(name in this.meshes)) {
      this.meshes[name] = new ChunkedSimpleMesh(layers)
    }

    return this.meshes[name]
  }

  destroy(gl: WebGL2RenderingContext) {
    this.drawer?.destroy(gl)

    for (const k in this.meshes) {
      this.meshes[k].destroy(gl)
    }

    this.meshes = {}
  }
}

export const ToolModes = [] as (typeof ToolMode)[]

export function makeToolModeEnum() {
  const map = {} as {[k: string]: number}
  const icons = {} as {[k: string]: number}
  const descr = {} as {[k: string]: string}
  const uinames = {} as {[k: string]: string}
  let i = 0

  for (const cls of ToolModes) {
    const def = cls.toolModeDefine()

    const key = def.name || cls.name

    map[key] = i
    icons[key] = def.icon !== undefined ? def.icon : -1
    descr[key] = '' + def.description
    uinames[key] = '' + def.uiname

    i++
  }

  const prop = new EnumProperty(undefined, map, 'toolmode', 'Tool Mode', 'Active tool mode')

  prop.addIcons(icons)
  prop.addDescriptions(descr)
  prop.addUINames(uinames)

  return prop
}
