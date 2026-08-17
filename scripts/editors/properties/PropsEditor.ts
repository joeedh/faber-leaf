import {Icons} from '../icon_enum'
import {MeshFlags} from '../../../addons/builtin/mesh/src/mesh_base'
import type {Mesh} from '../../../addons/builtin/mesh/src/mesh'

import {DataBlockBrowser, Editor, MaterialPanel} from '../editor_base'
import {
  Check,
  DataAPI,
  IconCheck,
  JSONAny,
  LastToolPanel,
  ListBox,
  nstructjs,
  Number3,
  PanelContents,
  TabContainer,
  TabItemContainer,
} from '../../path.ux/scripts/pathux'

import {
  saveUIData,
  loadUIData,
  ToolOp,
  BoolProperty,
  EnumProperty,
  StringProperty,
  IntProperty,
  PropertySlots,
} from '../../path.ux/scripts/pathux'
import {UIBase} from '../../path.ux/scripts/core/ui_base'
import {Container, ColumnFrame} from '../../path.ux/scripts/core/ui'
import {MeshTypes} from '../../../addons/builtin/mesh/src/mesh_base'
import {ProceduralTex, ProceduralTexUser} from '../../texture/proceduralTex'
import {ProceduralMesh} from '../../../addons/builtin/mesh/src/mesh_gen'
import {CDFlags} from '../../../addons/builtin/mesh/src/customdata'
import {loadUndoMesh, saveUndoMesh} from '../../../addons/builtin/mesh/src/mesh_ops_base'
import type {ToolContext, ViewContext} from '../../core/context'
import messageBus from '../../core/bus'
import {InvalidationKind} from '../../core/geometry_contract'
import {FeatureFlagManager} from '../../core/feature-flag'
import {ToolMode} from '../view3d/view3d_toolmode'
import {SceneObject} from '../../sceneobject/sceneobject'
import {SettingsEditor} from '../settings/SettingsEditor'

export const TexturePathModes = {
  BRUSH : 0,
  EDITOR: 1,
}

export class ChangeActCDLayerOp<
  InputSlots extends PropertySlots = {},
  OutputSlots extends PropertySlots = {},
> extends ToolOp<
  InputSlots & {
    fullMeshUndo: BoolProperty
    redrawAll: BoolProperty
    meshPath: StringProperty
    type: StringProperty
    elemType: EnumProperty<number>
    active: IntProperty
  },
  OutputSlots
> {
  _undo:
    | {
        elemtype?: number
        type?: string
        mesh?: string
        full?: boolean
        data?: ReturnType<typeof saveUndoMesh>
        active?: number
      }
    | undefined

  constructor() {
    super()
    this._undo = undefined
  }

  static tooldef() {
    return {
      uiname  : 'Change Active Layer',
      toolpath: 'mesh.change_active_cdlayer',
      inputs: {
        fullMeshUndo: new BoolProperty(false).private(),
        redrawAll   : new BoolProperty(false).private(),
        meshPath    : new StringProperty('mesh').private(),
        type        : new StringProperty().private(),
        elemType    : new EnumProperty(undefined, MeshTypes).private(),
        active      : new IntProperty(-1).private(),
      },
    }
  }

  getMesh(ctx: ToolContext) {
    return ctx.api.getValue(ctx, this.inputs.meshPath.getValue()) as Mesh | undefined
  }

  calcUndoMem(ctx: ToolContext) {
    if (!this._undo) {
      return 0
    }

    let tot = 0

    if (this._undo.full) {
      tot += this._undo.data!.dview.buffer.byteLength
    } else {
      return 32 //guesstimate
    }

    return tot
  }

  undoPre(ctx: ToolContext) {
    this._undo = {
      elemtype: this.inputs.elemType.getValue(),
      type    : this.inputs.type.getValue(),
    }
    const undo = this._undo!

    const mesh = this.getMesh(ctx)

    if (!mesh) {
      console.warn('Error in undoPre.ChangeActCDLayerOp')
      undo.mesh = this._undo.full = undefined
      return
    }

    undo.mesh = this.inputs.meshPath.getValue()

    const elemtype = this.inputs.elemType.getValue()
    const type = this.inputs.type.getValue()

    if (this.inputs.fullMeshUndo.getValue()) {
      undo.full = true
      undo.data = saveUndoMesh(mesh)
    } else {
      const layerst = mesh.elists.get(elemtype)!.customData.getLayerSet(type, false)

      undo.full = false
      undo.active = layerst.indexOf(layerst.active!)
    }
  }

  undo(ctx: ToolContext) {
    const undo = this._undo

    if (!undo) {
      return
    }

    if (!undo.mesh) {
      return
    }

    const mesh = ctx.api.getValue(ctx, undo.mesh) as Mesh | undefined
    if (!mesh) {
      console.error('Error in ChangeActCDLayerOp.undo', undo)
      return
    }

    if (undo.full) {
      const mesh2 = loadUndoMesh(ctx, undo.data!)

      mesh.swapDataBlockContents(mesh2)

      for (const v of mesh.verts) {
        v.flag |= MeshFlags.UPDATE
      }
    } else {
      const layerst = mesh.elists.get(undo.elemtype!)!.customData.getLayerSet(undo.type!, false)

      const layer = layerst[undo.active!]
      if (!layer) {
        console.error('Error in ChangeActCDLayerOp.undo', undo)
        return
      }

      mesh.elists.get(undo.elemtype!)!.customData.setActiveLayer(layer.index)

      if (this.inputs.redrawAll.getValue()) {
        for (const v of mesh.verts) {
          v.flag |= MeshFlags.UPDATE
        }
      }
    }

    mesh.invalidate(InvalidationKind.ALL)

    //force immediate execution of dependency graph
    //so disp layers are properly handled
    mesh.graphUpdate()
    window.updateDataGraph(true)

    window.redraw_viewport(true)
  }

  exec(ctx: ToolContext) {
    const mesh = this.getMesh(ctx)

    if (!mesh) {
      return
    }

    const elemtype = this.inputs.elemType.getValue()
    const type = this.inputs.type.getValue()

    const cdata = mesh.elists.get(elemtype)!.customData
    const layerset = cdata.getLayerSet(type, false)

    if (!layerset) {
      console.warn('No customdata layers of type', type, 'exist')
      return
    }

    const act = this.inputs.active.getValue()
    const layer = cdata.flatlist[act]

    if (layer?.typeName !== layerset.typeName) {
      console.warn("Invalid layer; layer not of type '" + type + "'", act, layer)
      return
    }

    cdata.setActiveLayer(layer.index)

    if (this.inputs.redrawAll.getValue()) {
      for (const v of mesh.verts) {
        v.flag |= MeshFlags.UPDATE
      }
    }

    mesh.invalidate(InvalidationKind.ALL)

    mesh.graphUpdate()
    window.updateDataGraph(true) //force immediate execution of data graph
    window.redraw_viewport(true)
  }
}

ToolOp.register(ChangeActCDLayerOp)

export class CDLayerPanel extends ColumnFrame<ViewContext> {
  _lastUpdateKey: string | undefined
  _saving: boolean
  _saved_uidata: unknown
  list: ListBox<ViewContext> | undefined

  constructor() {
    super()
    this._lastUpdateKey = undefined

    this._saving = false
    this._saved_uidata = undefined
  }

  get showDisableIcons() {
    let s = this.getAttribute('show-disable-icons')

    if (!s) {
      return false
    }

    s = s.toLowerCase()
    return s === 'true' || s === 'on' || s === 'yes'
  }

  set showDisableIcons(state) {
    this.setAttribute('show-disable-icons', state ? 'true' : 'false')
  }

  get fullMeshUndo() {
    let s = this.getAttribute('full-mesh-undo')
    if (!s) {
      return false
    }

    s = s.toLowerCase()
    return s === 'yes' || s === 'true' || s === 'on'
  }

  set fullMeshUndo(val) {
    this.setAttribute('full-mesh-undo', val ? 'true' : 'false')
  }

  get redrawAll() {
    let s = this.getAttribute('redraw-all-undo')
    if (!s) {
      return false
    }

    s = s.toLowerCase()
    return s === 'yes' || s === 'true' || s === 'on'
  }

  set redrawAll(val) {
    this.setAttribute('redraw-all-undo', val ? 'true' : 'false')
  }

  static define() {
    return {
      tagname: 'cd-layer-panel-x',
    }
  }

  init() {
    super.init()
    this.doOnce(this.rebuild)
  }

  saveData() {
    if (this._saving) {
      return super.saveData()
    }

    const ret = super.saveData() as JSONAny

    this._saving = true
    ret.uidata = saveUIData(this, 'cdlayerpanel')
    this._saving = false

    return ret
  }

  loadData(json: {uidata?: unknown}) {
    super.loadJSON(json)

    this._saved_uidata = json.uidata
    return this
  }

  rebuild() {
    if (!this.ctx) {
      this._lastUpdateKey = undefined
      return
    }

    let uidata: unknown

    if (this._saved_uidata) {
      uidata = this._saved_uidata
    } else {
      uidata = saveUIData(this, 'cdlayerpanel')
    }

    this.clear()

    if (!this.hasAttribute('datapath') || !this.hasAttribute('type') || !this.hasAttribute('layer')) {
      this.ctx.error("Expected 'datapath' 'type' and 'layer' attributes'")
      return
    }
    const meshpath = this.getAttribute('datapath')!
    let typeStr = this.getAttribute('type')!
    const layertype = this.getAttribute('layer')!
    typeStr = typeStr.toUpperCase().trim()
    const type = MeshTypes[typeStr as keyof typeof MeshTypes]

    if (!type) {
      this.ctx.error('Bad mesh type ' + this.getAttribute('type'))
      return
    }

    const mesh = this.ctx.api.getValue<Mesh>(this.ctx, meshpath!)
    if (!mesh) {
      this.ctx.error('data api error: ' + meshpath)
      return
    }
    const elist = mesh.getElemList(type)
    if (!elist) {
      this.ctx.error('Mesh api error ' + type)
      return
    }

    const panel = this.panel(layertype + ' Layers')

    this.list = panel.listbox()
    const actlayer = elist.customData.getActiveLayer(layertype!)

    const checks = [] as (Check | IconCheck)[]
    const show_disabled = this.showDisableIcons
    const checkLayerMap = new Map<Check | IconCheck, number>()

    for (const layer of elist.customData.flatlist) {
      if (layer.typeName === layertype) {
        const item = this.list!.addItem(layer.name)

        let check = item.iconcheck(undefined, Icons.CIRCLE_SEL, layer.name)
        check.checked = layer === actlayer
        checkLayerMap.set(check, layer.index)

        checks.push(check)
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const this2 = this

        check.on_change = function () {
          if (this.checked) {
            const tool = new ChangeActCDLayerOp()

            tool.inputs.elemType.setValue(type)
            tool.inputs.type.setValue(layertype)
            tool.inputs.fullMeshUndo.setValue(this2.fullMeshUndo)
            tool.inputs.redrawAll.setValue(this2.redrawAll)
            tool.inputs.active.setValue(checkLayerMap.get(this)!)

            //elist.customData.setActiveLayer(this.layerIndex);
            this.ctx.api.execTool(this.ctx, tool)

            for (const c of checks) {
              if (c !== this) {
                c.checked = false
              }
            }
          } else {
            if (elist.customData.getActiveLayer(layertype!)!.index === checkLayerMap.get(this)!) {
              const chg = this.on_change
              this.checked = true
              this.on_change = chg
            }
          }

          if (check.ctx?.mesh) {
            check.ctx.mesh.graphUpdate()
          }
          if (check.ctx?.object) {
            check.ctx.object.graphUpdate()
          }
          window.redraw_viewport(true)
        }

        if (show_disabled) {
          check = item.iconcheck(undefined, Icons.DISABLED)
          checkLayerMap.set(check, layer.index)

          check.checked = !!(layer.flag & CDFlags.DISABLED)

          check.on_change = function () {
            const layerIndex = checkLayerMap.get(this)!
            const layer = elist.customData.flatlist[layerIndex]

            if (this.checked) {
              layer.flag |= CDFlags.DISABLED
            } else {
              layer.flag &= ~CDFlags.DISABLED
            }

            if (check.ctx?.mesh) {
              check.ctx.mesh.graphUpdate()
            }
            if (check.ctx?.object) {
              check.ctx.object.graphUpdate()
            }
            window.redraw_viewport(true)
          }
        }
      }
    }

    panel.useIcons(false)
    panel.tool(`mesh.add_cd_layer(elemType=${type} layerType="${layertype}")`)
    panel.tool(`mesh.remove_cd_layer(elemType=${type} layerType="${layertype}")`)

    this._saved_uidata = undefined
    loadUIData(this, uidata as JSONAny)

    this.flushUpdate()
    this.flushSetCSS()
    this.flushUpdate()
  }

  updateDataPath() {
    if (!this.ctx) {
      return
    }

    if (!this.hasAttribute('datapath') || !this.hasAttribute('type') || !this.hasAttribute('layer')) {
      return
    }

    const meshpath = this.getAttribute('datapath')!
    let typeStr = this.getAttribute('type')!
    const layertype = this.getAttribute('layer')!

    typeStr = typeStr!.toUpperCase().trim()
    const type = MeshTypes[typeStr as keyof typeof MeshTypes]

    if (!type) {
      return
    }

    const mesh = this.ctx.api.getValue(this.ctx, meshpath!) as Mesh | undefined
    if (!mesh) {
      return
    }

    let key = mesh.lib_id + ':'
    const elist = mesh.getElemList(type)

    if (!elist) {
      return
    }

    const layerset = elist.customData.getLayerSet(layertype!)
    if (layerset?.active) {
      key += layerset.active.index + '|'
    }

    for (const layer of elist.customData.flatlist) {
      if (layer.typeName === layertype) {
        key += layer.name + ':' + (layer.flag & CDFlags.DISABLED)
      }
    }

    if (key !== this._lastUpdateKey) {
      this._lastUpdateKey = key

      //console.log("rebuilding mesh layers list");
      this.rebuild()
    }
  }

  update() {
    super.update()

    this.updateDataPath()
  }
}

UIBase.register(CDLayerPanel)

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

    const cdpanels = [
      //[elem type, layer type, show-disable-icons, full-mesh-undo]
      ['VERTEX', 'color', false, false, true],
      ['LOOP', 'uv', false, false, true],
      ['VERTEX', 'mask'],
      ['VERTEX', 'displace', true, true],
      ['VERTEX', 'paramvert'],
    ]

    const data = ob.data
    if (data?.lib_type === 'mesh') {
      panel = this.panel('Data Layers')

      for (const cdp of cdpanels) {
        const cd = UIBase.createElement('cd-layer-panel-x') as CDLayerPanel

        if (cdp.length > 2 && cdp[2]) {
          cd.setAttribute('show-disable-icons', 'true')
        } else {
          cd.setAttribute('show-disable-icons', 'false')
        }

        if (cdp.length > 3 && cdp[3]) {
          cd.fullMeshUndo = true
        } else {
          cd.fullMeshUndo = false
        }

        if (cdp.length > 4 && cdp[4]) {
          cd.redrawAll = true
        } else {
          cd.redrawAll = false
        }

        cd.setAttribute('datapath', 'mesh')
        cd.setAttribute('type', '' + cdp[0])
        cd.setAttribute('layer', '' + cdp[1])
        panel.add(cd)
      }

      panel = this.panel('BVH')

      panel.prop('mesh.bvhSettings.leafLimit')
      panel.prop('mesh.bvhSettings.drawLevelOffset')
      panel.prop('mesh.bvhSettings.depthLimit')
    } else if (data instanceof ProceduralMesh) {
      panel = this.panel('Procedural')
      let strip = panel.col().strip()

      strip.prop('toolDefaults.mesh.procedural_to_mesh.triangulate')
      strip.tool(`mesh.procedural_to_mesh(objectId=${ob.lib_id})`)

      strip = panel.col().strip()

      strip.dataPrefix = 'object.data.generator'
      // XXX fix me later after dealing with procedural gen thing
      ;(data.generator.constructor as any).buildSettings(strip)
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
