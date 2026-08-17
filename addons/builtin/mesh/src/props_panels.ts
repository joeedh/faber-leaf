/**
 * The mesh subsystem's properties-editor contributions: the active-CustomData-layer
 * ToolOp, the layer-list element it drives, and the three panels the host used to
 * build by branching on concrete type. Registered from `main.ts`'s `register(api)`,
 * so they appear and disappear with the addon (plan §3.3).
 */

import {
  BoolProperty,
  Check,
  ColumnFrame,
  Container,
  EnumProperty,
  IconCheck,
  IntProperty,
  JSONAny,
  ListBox,
  StringProperty,
  ToolOp,
  UIBase,
  loadUIData,
  saveUIData,
} from '@framework/pathux'
import {
  Icons,
  InvalidationKind,
  type GeometryDataRef,
  type IPropsPanel,
  type PropertySlots,
  type ToolContext,
  type ViewContext,
} from '@framework/api'

import {MeshFlags, MeshTypes} from './mesh_base.js'
import type {Mesh} from './mesh.js'
import {CDFlags} from './customdata.js'
import {ProceduralMesh} from './mesh_gen.js'
import {loadUndoMesh, saveUndoMesh} from './mesh_ops_base.js'

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

/**
 * Elem type, layer type, then the three optional behaviour flags the element
 * reads off its attributes: show-disable-icons, full-mesh-undo, redraw-all.
 */
const CD_PANELS: [string, string, boolean?, boolean?, boolean?][] = [
  ['VERTEX', 'color', false, false, true],
  ['LOOP', 'uv', false, false, true],
  ['VERTEX', 'mask'],
  ['VERTEX', 'displace', true, true],
  ['VERTEX', 'paramvert'],
]

export const MESH_PROPS_PANELS: IPropsPanel[] = [
  {
    id    : 'mesh.data-layers',
    kindId: 'mesh',
    uiName: 'Data Layers',
    order : 10,
    build(container: Container) {
      for (const [elemType, layerType, showDisable, fullUndo, redrawAll] of CD_PANELS) {
        const cd = UIBase.createElement('cd-layer-panel-x') as CDLayerPanel

        cd.setAttribute('show-disable-icons', showDisable ? 'true' : 'false')
        cd.fullMeshUndo = !!fullUndo
        cd.redrawAll = !!redrawAll

        cd.setAttribute('datapath', 'mesh')
        cd.setAttribute('type', elemType)
        cd.setAttribute('layer', layerType)
        container.add(cd)
      }
    },
  },
  {
    id    : 'mesh.bvh',
    kindId: 'mesh',
    uiName: 'BVH',
    order : 20,
    build(container: Container) {
      container.prop('mesh.bvhSettings.leafLimit')
      container.prop('mesh.bvhSettings.drawLevelOffset')
      container.prop('mesh.bvhSettings.depthLimit')
    },
  },
  {
    id    : 'mesh.procedural',
    kindId: 'mesh',
    uiName: 'Procedural',
    order : 30,
    poll(_ctx: ViewContext, data: GeometryDataRef) {
      return data instanceof ProceduralMesh
    },
    build(container: Container, ctx: ViewContext, data: GeometryDataRef) {
      const ob = ctx.object
      if (!ob) {
        return
      }

      let strip = container.col().strip()
      strip.prop('toolDefaults.mesh.procedural_to_mesh.triangulate')
      strip.tool(`mesh.procedural_to_mesh(objectId=${ob.lib_id})`)

      strip = container.col().strip()
      strip.dataPrefix = 'object.data.generator'
      // XXX fix me later after dealing with procedural gen thing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;((data as ProceduralMesh).generator.constructor as any).buildSettings(strip)
    },
  },
]
