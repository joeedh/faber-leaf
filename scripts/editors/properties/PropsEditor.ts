import {Icons} from '../icon_enum'

import {DataBlockBrowser, Editor, MaterialPanel} from '../editor_base'
import {
  DataAPI,
  LastToolPanel,
  loadUIData,
  nstructjs,
  Number3,
  PanelContents,
  TabContainer,
  TabItemContainer,
  saveUIData,
} from '../../path.ux/scripts/pathux'

import {UIBase} from '../../path.ux/scripts/core/ui_base'
import {Container, ColumnFrame} from '../../path.ux/scripts/core/ui'
import {ProceduralTex, ProceduralTexUser} from '../../texture/proceduralTex'
import {listPropsPanels} from '../../core/props_panels'
import type {ViewContext} from '../../core/context'
import messageBus from '../../core/bus'
import {FeatureFlagManager} from '../../core/feature-flag'
import {ToolMode} from '../view3d/view3d_toolmode'
import {SceneObject} from '../../sceneobject/sceneobject'
import {SettingsEditor} from '../settings/SettingsEditor'

export const TexturePathModes = {
  BRUSH : 0,
  EDITOR: 1,
}

export class ObjectPanel extends ColumnFrame<ViewContext> {
  _last_update_key: string

  constructor() {
    super()

    this._last_update_key = ''
  }

  static define() {
    return {
      tagname: 'scene-object-panel-x',
    }
  }

  init() {
    super.init()
    this.rebuild()
    //this.doOnce(this.rebuild);
  }

  rebuild() {
    if (!this.ctx) {
      if (!this.isDead()) {
        this.doOnce(this.rebuild)
      }

      return
    }

    this.clear()
    this.pathlabel('object.name')

    let panel: PanelContents<ViewContext>

    panel = this.panel('Transform')
    panel.useIcons(false)

    panel.prop(`object.inputs["loc"].value`)

    panel.label('Rotation')
    panel.prop('object.inputs["rot"].value')
    panel.prop('object.inputs["rotOrder"].value')

    panel.prop('object.inputs["scale"].value')

    panel.tool('object.apply_transform()')

    panel = this.panel('Draw')
    panel.useIcons(false)
    panel.prop('object.drawMode')
    panel.prop('object.drawFlag[FORCE_XRAY]')
    panel.prop('object.drawFlag[WIREFRAME]')

    const ob = this.ctx.object
    if (!ob) {
      return
    }

    // Panels for the object's data kind come from the registry, so a geometry
    // type contributes UI from its own addon instead of appearing in a branch
    // here. See scripts/core/props_panels.ts and plan §3.3.
    const data = ob.data
    if (!data) {
      return
    }

    for (const contribution of listPropsPanels(data.lib_type)) {
      if (contribution.poll && !contribution.poll(this.ctx, data)) {
        continue
      }

      // The registry is context-agnostic — core cannot name ViewContext without
      // closing a cycle — so the container's context parameter is re-bound here.
      const sub = (contribution.uiName ? this.panel(contribution.uiName) : this) as unknown as Container
      contribution.build(sub, this.ctx, data)
    }
  }

  update() {
    super.update()

    if (!this.ctx?.object) {
      return
    }

    const ob = this.ctx.object
    const key = '' + ob.lib_id + ':' + ob.data.lib_id

    if (key !== this._last_update_key) {
      this._last_update_key = key
      this.rebuild()
    }
  }
}

UIBase.register(ObjectPanel)

export class TexturePanel extends Container<ViewContext> {
  canvas: HTMLCanvasElement
  g: CanvasRenderingContext2D
  previewSize: number
  _lastkey: string | undefined
  _drawreq: number | undefined
  _rebuildReq: boolean
  mode!: ReturnType<Container<ViewContext>['listenum']>
  settings!: PanelContents<ViewContext>
  preview!: PanelContents<ViewContext>

  constructor() {
    super()

    this.canvas = document.createElement('canvas')
    this.g = this.canvas.getContext('2d')!
    this.previewSize = 100

    this._lastkey = undefined

    this._drawreq = undefined
    this._rebuildReq = false

    /*
    this.modebox = this.listenum(undefined, {
      name : "Mode",
      enumDef : ProceduralTex.buildGeneratorEnum(),
      defaultVal : 0,
      callback : (id) => {
        console.log("id", id);
        let tex = this.getTexture();
        if (tex) {
          tex.setGenerator(ProceduralTex.getPattern(id));
        }
      }
    });*/
  }

  static define() {
    return {
      tagname: 'texture-panel-x',
    }
  }

  getTexture() {
    const path = this.getAttribute('datapath')
    if (!path) {
      return undefined
    }

    return this.getPathValue<ProceduralTex>(this.ctx, path)
  }

  init() {
    super.init()

    this.mode = this.listenum(undefined, 'Type', {})
    this.preview = this.panel('Preview')
    this.settings = this.panel('Settings')
    this.preview.appendChild(this.canvas)

    this.flagRebuild()

    this.flagRedraw()
  }

  rebuild() {
    if (!this.ctx || !this.settings || !this.hasAttribute('datapath')) {
      this.flagRedraw()
      return
    }

    this._rebuildReq = false

    const panel = this.settings
    panel.clear()

    const tex = this.getTexture()

    if (!tex) {
      return
    }

    this.mode.ctx = this.ctx

    const path = this.getAttribute('datapath')!

    this.mode.setAttribute('datapath', path + '.mode')

    panel.dataPrefix = path

    console.log('Path prefix', path)
    tex.buildSettings(panel)

    this.flagRedraw()
    this.flushUpdate()
  }

  flagRebuild() {
    // check if we have an inflight request already
    if (this._rebuildReq) {
      return
    }

    this._rebuildReq = true
    window.setTimeout(() => {
      this.rebuild()
    })
  }

  update() {
    if (!this.preview) {
      return
    }

    const tex = this.getTexture()
    const texid = tex !== undefined ? tex.lib_id : -1

    let key = '' + texid
    if (tex) {
      key += ':' + (tex as any).generator.constructor.name
    }

    if (key !== this._lastkey) {
      this._lastkey = key
      this.flagRebuild()
      this.flagRedraw()
    }

    if (tex?.update()) {
      this.flagRedraw()
    }
  }

  flagRedraw() {
    if (this._drawreq) {
      return
    }

    this._drawreq = 1
    window.setTimeout(() => {
      this.redraw()
    })
  }

  redraw() {
    this._drawreq = undefined

    const g = this.g
    const canvas = this.canvas

    g.clearRect(0, 0, canvas.width, canvas.height)

    const f1 = 200
    const f2 = 135

    const colors = [`rgb(${f1},${f1},${f1})`, `rgb(${f2},${f2},${f2})`]

    const csize = 16
    const steps = Math.ceil(this.previewSize / csize)
    for (let i = 0; i < steps * steps; i++) {
      let x = i % steps
      let y = ~~(i / steps)

      const j = (x + y) % 2
      const color = colors[j]

      x *= csize
      y *= csize

      g.fillStyle = color

      g.beginPath()
      g.rect(x, y, csize, csize)
      g.fill()
    }

    const tex = this.getTexture()
    if (!tex) {
      return
    }

    const size = this.previewSize
    const image = tex.getPreview(size, size)

    g.drawImage(image, 0, 0)
  }

  setCSS() {
    super.setCSS()

    const dpi = UIBase.getDPI()
    const w = ~~(this.previewSize * dpi)

    const canvas = this.canvas
    canvas.width = w
    canvas.height = w

    const w2 = w / dpi
    const h2 = w / dpi

    canvas.style['width'] = w2 + 'px'
    canvas.style['height'] = h2 + 'px'

    this.flagRedraw()
  }
}

UIBase.register(TexturePanel)

export class TextureSelectPanel extends TexturePanel {
  browser: DataBlockBrowser<ProceduralTex>

  constructor() {
    super()

    this.browser = UIBase.createElement('data-block-browser-x')
    this.browser.blockClass = ProceduralTex
  }

  static define() {
    return {
      tagname: 'texture-select-panel-x',
    }
  }

  init() {
    super.init()
    this.browser.setAttribute('datapath', this.getAttribute('datapath')!)

    this.prepend(this.browser)
  }

  update() {
    if (!this.ctx) {
      return
    }

    super.update()
    this.browser.setAttribute('datapath', this.getAttribute('datapath')!)
  }
}

UIBase.register(TextureSelectPanel)

export class PropsEditor extends Editor {
  tabs!: TabContainer<ViewContext>
  texPanel!: Container<ViewContext>
  objTab!: TabItemContainer<ViewContext>
  texTab!: TabItemContainer<ViewContext>
  workspaceTab!: TabItemContainer<ViewContext>
  _settingsTab?: TabItemContainer<ViewContext>
  _last_toolmode?: ToolMode
  _last_obj?: SceneObject
  texUser: ProceduralTexUser
  texturePathMode: number
  texturePath: string

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
PropsEditor {
  texturePath     : string;
  texturePathMode : int;
}
`
  )

  constructor() {
    super()

    this.texUser = new ProceduralTexUser()

    this.texturePathMode = TexturePathModes.EDITOR
    this.texturePath = ''

    this._last_toolmode = undefined
  }

  //used by data path api
  get _texture() {
    if (this.texturePath === '') {
      return undefined
    }

    const path = this.texturePath
    return this.ctx.api.getValue<ProceduralTex>(this.ctx, path)
  }

  //used by data path api
  set _texture(val) {
    if (val !== undefined && val.lib_id < 0) {
      throw new Error('pattern is not in the datalib')
    }

    if (this.texturePathMode === TexturePathModes.EDITOR) {
      if (!val) {
        this.texturePath = ''
      } else {
        this.texturePath = `library.texture[${val.lib_id}]`
      }
    } else {
      this.setPathValue(this.ctx, this.texturePath, val)
      /*
      let rdef = this.ctx.resolvePath(this.texturePath);
      if (!rdef) {
        return;
      }

      let obj = rdef.obj;
      if (obj instanceof DataBlock && obj.lib_id >= 0) {
        let block = val === undefined ? -1 : val.lib_id;
        let path = this.texturePath;

        let toolpath = `datalib.default_assign(block=${block} dataPathToSet=${path})`;
        this.ctx.api.execTool(this.ctx, toolpath);
      } else {
        this.setPathValue(this.ctx, this.texturePathMode, val);
      }//*/
    }
  }

  static defineAPI(api: DataAPI<ViewContext>) {
    const st = super.defineAPI(api)

    st.string('texturePath', 'texturePath', 'Active Texture Path')
    st.struct('_texture', 'texture', 'Active Texture', api.mapStruct(ProceduralTex))
    st.enum('texturePathMode', 'texturePathMode', TexturePathModes, 'Source').uiNames({
      EDITOR: 'Any',
      BRUSH : 'Brush',
    })

    return st
  }

  static define() {
    return {
      tagname : 'props-editor-x',
      areaname: 'props',
      apiname : 'propsEditor',
      uiname  : 'Properties',
      icon    : Icons.EDITOR_PROPERTIES,
    }
  }

  on_area_active() {
    super.on_area_active()

    if (!this.ctx) {
      return
    }

    // check that init has been called
    this._init()
    this.setCSS()
    // on_area_active could be called during file load, so put
    // flushUpdate in a try block

    try {
      this.flushUpdate()
    } catch (error) {}
  }

  init() {
    super.init()
    this.background = this.getDefault('DefaultPanelBG')

    this.style['overflow'] = 'scroll'

    const container = this.container
    this.tabs = container.tabs('left')

    this.workspaceTab = this.tabs.tab('Workspace')
    let panel: PanelContents<ViewContext>

    let tab = this.tabs.tab('Scene')
    panel = tab.panel('Viewport Settings')
    panel.useIcons(false)
    panel.prop('view3d.cameraMode[PERSPECTIVE]')
    panel.prop('view3d.cameraMode[ORTHOGRAPHIC]')

    const viewAxis = (axis: Number3, sign: number) => {
      this.ctx.view3d.viewAxis(axis, sign)
    }

    const axes = {
      Front : [1, 1],
      Left  : [0, 1],
      Back  : [1, -1],
      Right : [0, -1],
      Top   : [2, 1],
      Bottom: [2, -1],
    } as const

    function makeAxis(key: string, axis: Number3, sign: number) {
      panel.button(key, () => {
        viewAxis(axis, sign)
      })
    }

    for (const k in axes) {
      const [axis, sign] = axes[k as keyof typeof axes]
      makeAxis(k, axis, sign)
    }

    panel = tab.panel('Render Settings')
    panel.prop('scene.envlight.color')
    panel.prop('scene.envlight.power')
    panel.prop('scene.envlight.flag')
    panel.prop('scene.envlight.ao_dist')
    panel.prop('scene.envlight.ao_fac')
    panel.prop('view3d.render.sharpen')

    tab = this.tabs.tab('Material')
    this.materialPanel(tab)

    tab = this.objTab = this.tabs.tab('Object')
    const obpanel = UIBase.createElement('scene-object-panel-x') as ObjectPanel
    tab.add(obpanel)

    const obDataTab = this.tabs.tab('ObData')
    let obDataType: string | undefined
    let obDataUIDatas = new Map<string, string>()

    // Feature flags gate whole panels inside buildPropertiesTab (sculpt layers,
    // multires, VDM), so a flag flip must rebuild the tab, not wait for restart.
    let obDataForceRebuild = false
    messageBus.subscribe(
      () => (this.isDead() ? undefined : this),
      FeatureFlagManager,
      () => {
        obDataForceRebuild = true
        this.doOnce(rebuildObDataTab)
      },
      'FLAG_SET'
    )

    const rebuildObDataTab = () => {
      const type = this.ctx?.object?.data?.lib_type ?? undefined

      if (type === obDataType && !obDataForceRebuild) {
        return
      }
      obDataForceRebuild = false

      if (obDataType !== undefined) {
        obDataUIDatas.set(obDataType, saveUIData(obDataTab, 'obDataTab'))
      }

      obDataType = this.ctx?.object?.data?.lib_type
      obDataTab.clear()

      if (obDataType !== undefined && this.ctx?.object?.data !== undefined) {
        const cls = this.ctx?.object?.data?.constructor as any
        cls.buildPropertiesTab(obDataTab)

        const uidata = obDataUIDatas.get(obDataType)
        if (uidata !== undefined) {
          loadUIData(obDataTab, uidata)
        }
        obDataTab.flushUpdate()
      }
    }
    this.updateAfter(rebuildObDataTab)

    tab = this.texTab = this.tabs.tab('Texture')
    this.textureTab(tab)

    this._last_obj = undefined

    tab = this.tabs.tab('Last Command')
    const last = document.createElement('last-tool-panel-x') as LastToolPanel<ViewContext>
    tab.add(last)

    this._settingsTab = this.tabs.tab('Settings')
    this._buildSettingsPanels()
  }

  /** Build (or rebuild) the Settings tab. Folds the former Settings/Theme
   * editor's General, Addons and Feature Flags tabs in here as panels (#4);
   * theme editing stays in the (now "Theme Editor") SettingsEditor. */
  _buildSettingsPanels(): void {
    const tab = this._settingsTab
    if (!tab) return
    tab.clear()

    let panel = tab.panel('Brushes')
    const strip = panel.row()
    strip.useIcons(false)
    strip.prop('settings.brushSet')
    strip.useIcons(true)
    strip.tool('brush.reload_all_defaults()')

    panel = tab.panel('General')
    SettingsEditor.buildGeneralSettings(panel.col())

    panel = tab.panel('Addons')
    SettingsEditor.buildAddonsSettings(panel.col(), () => this.doOnce(this._buildSettingsPanels))

    panel = tab.panel('Feature Flags')
    SettingsEditor.buildFeatureFlagsSettings(panel.col())
  }

  textureTab(tab: TabItemContainer<ViewContext>) {
    //let tex = document.createElement("texture-panel-x");
    ;(this.texPanel = UIBase.createElement('texture-panel-x')) as TexturePanel
    const tex = this.texPanel

    const browser = UIBase.createElement('data-block-browser-x') as DataBlockBrowser<ProceduralTex>

    const path = 'propsEditor.texture'

    browser.setAttribute('datapath', path)
    browser.blockClass = ProceduralTex

    const strip = tab.row().strip()
    strip.label('Source')
    strip.prop('propsEditor.texturePathMode')

    tex.setAttribute('datapath', path)
    tex.ctx = this.ctx

    tab.add(browser)
    tab.add(tex)
  }

  materialPanel(tab: TabItemContainer<ViewContext>) {
    const panel = UIBase.createElement('material-panel-x') as MaterialPanel
    panel.setAttribute('datapath', 'object.data')
    tab.add(panel)
  }

  updateToolMode() {
    if (!this.ctx?.toolmode || !this.workspaceTab) {
      return
    }

    const toolmode = this.ctx.toolmode

    if (toolmode === this._last_toolmode) {
      return
    }

    this._last_toolmode = toolmode

    this.workspaceTab.clear()

    // propagate toolmode's ctx if it changed it
    toolmode.checkCtx(this.ctx)
    if (toolmode.ctx && toolmode.ctx !== this.workspaceTab.ctx) {
      this.workspaceTab.ctx = toolmode.ctx
    }

    try {
      toolmode.constructor.buildSettings(this.workspaceTab)
    } catch (error) {
      console.error((error as Error).stack)
      console.error((error as Error).message)
      console.warn('failed to build toolmode settings', this.ctx?.toolmode)
      // try to build again later
      this._last_toolmode = undefined
    }
  }

  update() {
    //check init
    if (this.texPanel) {
      this.texPanel._init()
    }

    // Refresh the Settings tab's Addons panel when the addon list changes.
    if (this._settingsTab && this.ctx?.settings.syncAddonList()) {
      this.doOnce(this._buildSettingsPanels)
    }

    this.updateToolMode()

    super.update()
  }

  copy() {
    const ret = UIBase.createElement('props-editor-x') as this
    ret.ctx = this.ctx
    return ret
  }

  setCSS() {
    super.setCSS()
  }
}

Editor.register(PropsEditor)
