import {DataBlock, DataRef, BlockFlags, BlockLoader, BlockLoaderAddUser} from '../core/lib_api'
import {getAppState, peekAppState} from '../core/app_instance'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import {ToolModes, makeToolModeEnum, ToolMode} from '../editors/view3d/view3d_toolmode.js'
import {WidgetManager} from '../editors/view3d/widgets/widgets.js'
import {
  EnumProperty,
  nstructjs,
  util,
  Vector3,
  Matrix4,
  Number3,
  DataAPI,
  DataStruct,
} from '../path.ux/scripts/pathux.js'

import {ObjectFlags, SceneObject} from '../sceneobject/sceneobject'
import {DependSocket, FloatSocket} from '../core/graphsockets.js'
import {Light} from '../light/light.js'
import {SelMask, normalizeSelMask, selMaskToNames} from '../core/select_types.js'
import {Icons} from '../editors/icon_enum.js'
import {PropModes} from '../editors/view3d/transform/transform_base.js'
import {Collection} from './collection'
import {SceneObjectData} from '../sceneobject/sceneobject_base'
import {toolModeStruct, updateToolModeAPI} from './scene_utils'

export enum EnvLightFlags {
  USE_AO = 1,
}

export class EnvLight {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  EnvLight {
    color      : vec3;
    power      : float;
    ao_dist    : float;
    ao_fac     : float;
    flag       : int;
    sunColor   : vec3;
    sunPower   : float;
    sunRadius  : float;
    sunDir     : vec3;
  }`
  )

  color = new Vector3([1.0, 1.0, 1])
  power = 0.55
  ao_dist = 25.0
  ao_fac = 0.7
  flag = EnvLightFlags.USE_AO

  sunDir = new Vector3([-0.14083751989292737, -0.4480698391806443, -0.8828353256451855]).normalize()

  sunPower = 0.33
  sunRadius = 0.5
  sunColor = new Vector3([1, 1, 1])

  _digest = new util.HashDigest()

  constructor() {}

  calcUpdateHash(): number {
    const ret = this._digest

    ret.reset()

    for (let i = 0; i < 3; i++) {
      ret.add(this.color[i as Number3] * 1024)
    }

    ret.add(this.ao_dist * 1024)
    ret.add(this.ao_fac * 1024)
    ret.add(this.flag * 1024)
    ret.add(this.power * 1024)

    for (let i = 0; i < 3; i++) {
      ret.add(this.sunDir[i as Number3])
      ret.add(this.sunColor[i as Number3])
    }

    ret.add(this.sunPower)
    ret.add(this.sunRadius)

    return ret.get()
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const estruct = struct ?? api.mapStruct(this)

    const onchange = () => {
      window.redraw_viewport()
    }

    estruct.color3('color', 'color', 'Color', 'Ambient light color').on('change', onchange)
    estruct.float('power', 'power', 'Power', 'Power of ambient light power').on('change', onchange).noUnits()
    estruct.flags('flag', 'flag', EnvLightFlags, 'flag', 'Ambient light flags').on('change', onchange)
    estruct.float('ao_dist', 'ao_dist', 'Distance').on('change', onchange).noUnits()
    estruct.float('ao_fac', 'ao_fac', 'Factor').on('change', onchange).noUnits()

    return estruct
  }
}

export const SceneFlags = {
  SELECT: 1,
}

export class ObjectSet extends util.set<SceneObject> {
  list: ObjectList

  constructor(list: ObjectList, scene: Scene) {
    super()
    this.list = list
  }

  get renderable(): Iterable<SceneObject> {
    const this2 = this

    return (function* () {
      for (const ob of this2) {
        if (ob.flag & ObjectFlags.HIDE) {
          continue
        }

        yield ob
      }
    })()
  }

  get editable(): Iterable<SceneObject> {
    const this2 = this

    return (function* () {
      for (const ob of this2) {
        if (ob.flag & (ObjectFlags.HIDE | ObjectFlags.LOCKED)) {
          continue
        }

        yield ob
      }
    })()
  }
}

export class ObjectList extends Array {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  ObjectList {
    refs       : array(DataRef) | obj._getDataRefs();
    active     : DataRef |  DataRef.fromBlock(obj.active);
    highlight  : DataRef |  DataRef.fromBlock(obj.highlight);
  }`
  )

  scene: Scene
  selected: ObjectSet

  onselect?: (ob: SceneObject, state: boolean) => void = undefined

  active?: SceneObject = undefined
  highlight?: SceneObject = undefined

  constructor(list: Iterable<SceneObject> | undefined, scene: Scene) {
    super()

    this.scene = scene
    this.selected = new ObjectSet(this, scene)

    if (list !== undefined) {
      for (const ob of list) {
        super.push(ob)
      }
    }
  }

  has(ob: SceneObject): boolean {
    return this.includes(ob)
  }

  clearSelection(): void {
    for (const ob of this) {
      this.setSelect(ob, false)
    }
  }

  remove(ob: SceneObject): void {
    if (this.selected.has(ob)) {
      this.selected.remove(ob)
    }

    if (ob === this.active) {
      this.active = undefined
    }

    ob.lib_remUser(this.scene)
    return super.remove(ob)
  }

  push(ob: SceneObject): number {
    if (ob instanceof SceneObject) {
      ob.lib_addUser(this.scene)
    }

    return super.push(ob)
  }

  get editable(): Iterable<SceneObject> {
    const this2 = this

    return (function* () {
      for (const ob of this2) {
        if (ob.flag & (ObjectFlags.HIDE | ObjectFlags.LOCKED)) {
          continue
        }

        yield ob
      }
    })()
  }

  get visible(): Iterable<SceneObject> {
    const this2 = this

    return (function* () {
      for (const ob of this2) {
        if (ob.flag & ObjectFlags.HIDE) {
          continue
        }

        yield ob
      }
    })()
  }

  get renderable(): Iterable<SceneObject> {
    return this.visible
  }

  setSelect(ob: SceneObject, state: boolean): void {
    const execCallback = !!(ob.flag & ObjectFlags.SELECT) === !!state

    if (!state) {
      ob.flag &= ~ObjectFlags.SELECT

      if (this.selected.has(ob)) {
        this.selected.remove(ob)
      }
    } else {
      ob.flag |= ObjectFlags.SELECT
      this.selected.add(ob)
    }

    if (execCallback && this.onselect) {
      this.onselect(ob, state)
    }
  }

  setHighlight(ob: SceneObject | undefined): void {
    if (this.highlight !== undefined) {
      this.highlight.flag &= ~ObjectFlags.HIGHLIGHT
    }

    this.highlight = ob

    if (ob !== undefined) {
      ob.flag |= ObjectFlags.HIGHLIGHT
    }
  }

  setActive(ob: SceneObject | undefined): void {
    if (this.active !== undefined) {
      this.active.flag &= ~ObjectFlags.ACTIVE
    }

    this.active = ob
    if (ob !== undefined) {
      ob.flag |= ObjectFlags.ACTIVE
    }
  }

  dataLink(scene: Scene, getblock: (ref: any, owner: any) => any, getblock_addUser: (ref: any, owner: any) => any) {
    this.active = getblock(this.active, scene)

    if (this.highlight !== undefined) {
      this.highlight = getblock(this.highlight, scene)
    }

    for (const ob of (this as unknown as any).refs as any[]) {
      const ob2 = getblock_addUser(ob, scene)

      if (ob2 === undefined) {
        // eslint-disable-next-line no-console
        console.warn('Warning: missing SceneObject in scene')
        continue
      }

      super.push(ob2)

      if (ob2.flag & ObjectFlags.SELECT) {
        this.selected.add(ob2)
      }
    }

    const typeErased = this as unknown as {refs?: any[]}
    delete typeErased.refs
  }

  _getDataRefs(): DataRef[] {
    const ret: DataRef[] = []

    for (const ob of this) {
      ret.push(DataRef.fromBlock(ob))
    }

    return ret
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
  }
}

export const SceneRecalcFlags = {
  OBJECTS: 1, //update flat object list
}

import messageBus from '../core/bus.js'
import type {INodeSocketSet} from '../core/graph'
import type {ToolContext, ViewContext} from '../core/context'
import type {StructReader} from '../path.ux/scripts/util/nstructjs'

export class Scene<InputSet extends INodeSocketSet = {}, OutputSet extends INodeSocketSet = {}> extends DataBlock<
  InputSet & {},
  OutputSet & {
    onSelect: DependSocket
    onToolModeChange: DependSocket
    onTimeChange: FloatSocket
  }
> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
Scene {
  flag         : int;
  objects      : ObjectList;
  active       : int | obj.active !== undefined ? obj.active.lib_id : -1;
  time         : float;
  selectMask   : string | obj.selectMaskName;
  cursor3D     : mat4;
  envlight     : EnvLight;
  toolmode_i   : string | obj.constructor.toolModeProp.keys[obj.toolmode_i];
  toolmodes    : array(abstract(ToolMode));
  collection   : DataRef | DataRef.fromBlock(obj.collection);
  fps          : int;
  propMode     : int;
propIslandOnly : bool;
  propRadius   : float;
  propEnabled  : bool;
}
  `
  )

  #linked?: boolean

  // XXX hack!
  ctx: ViewContext = getAppState().ctx as ViewContext

  // note: we can't create the collection here, since that requires the
  // data lib
  collection: Collection = undefined as unknown as Collection

  //magnet transform settings
  propRadius = 1.0
  propMode = 0
  propEnabled = false
  propIslandOnly = true

  widgets: WidgetManager
  cursor3D = new Matrix4()

  selectMask = SelMask.OBJECT
  toolmodes: ToolMode[] = [] //we cache toolmode instances, these are saved in files too

  /** Write-side of the frozen name form of `selectMask`; see `core/select_types.ts`. */
  get selectMaskName(): string {
    return selMaskToNames(this.selectMask)
  }

  toolmode_map: {[k: string]: ToolMode} = {}
  toolmode_namemap: {[k: string]: ToolMode} = {}
  static toolModeProp = makeToolModeEnum()
  toolmode_i: number

  envlight = new EnvLight()
  recalc = 0

  _objects: ObjectList = new ObjectList(undefined, this)

  get objects() {
    return this._objects
  }

  set objects(ob) {
    if (this.recalc && !this.#loading) {
      this.updateObjectList()
    }
    this._objects = ob
  }

  flag = 0
  #loading = false
  time = 0.0
  fps = 30.0
  timeStart = 0.0 //in seconds
  timeEnd = 10.0 //in seconds

  constructor(objects: Iterable<SceneObject> = []) {
    super()

    //XXX hack!
    this.widgets = new WidgetManager(getAppState().ctx as ViewContext)

    this.objects = new ObjectList(undefined, this)
    this.objects.onselect = this._onselect.bind(this)

    if (objects !== undefined) {
      for (const ob of objects) {
        this.add(ob)
      }
    }

    this.toolmode_i = Scene.toolModeProp.values['object'] as number

    const busgetter = () => {
      if (!peekAppState()?.datalib) {
        // app state is still bootstrapping
        return this
      }

      //check if scene is still in datalib
      const block = getAppState().datalib.get(this.lib_id)
      if (block !== this) {
        //  return undefined
      }

      return this
    }

    messageBus.subscribe(
      busgetter,
      ToolMode,
      () => {
        // Scene.toolModeProp should have been updated already
        const key = Scene.toolModeProp.keys[this.toolmode_i]
        this.toolmode_i = Scene.toolModeProp.values[key] as number

        if (this.toolmode_i === undefined) {
          this.switchToolMode(0)
        }
      },
      ['REGISTER', 'UNREGISTER'],
      1
    )
  }

  get toolmode() {
    if (!(this.toolmode_i in this.toolmode_map)) {
      this.switchToolMode(this.toolmode_i)
    }

    return this.toolmode_map[this.toolmode_i]
  }

  regenObjectList() {
    this.recalc |= SceneRecalcFlags.OBJECTS
  }

  get lights() {
    const this2 = this

    const ret = (function* () {
      for (const ob of this2.objects) {
        if (ob.data instanceof Light) {
          yield ob as SceneObject<Light>
        }
      }
    })() as unknown as Iterable<SceneObject<Light>> & {
      visible: Iterable<SceneObject<Light>>
      renderable: Iterable<SceneObject<Light>>
    }

    ret.visible = (function* () {
      for (const ob of this2.objects) {
        if (ob.flag & ObjectFlags.HIDE) {
          continue
        }

        if (ob.data instanceof Light) {
          yield ob as SceneObject<Light>
        }
      }
    })()

    //the the future they'll be a seperate flag for
    //whether something shows up in renders and shows up
    //while editing in the viewport.
    //for now just alias to ret.visible.
    ret.renderable = ret.visible

    return ret
  }

  //get a child collection, or create
  //a new one if necassary
  getCollection(ctx: ToolContext, name: string): Collection {
    let cl = this.collection.getChild(name)

    const add = cl === undefined

    //check if it exists in the datalib somewhere
    cl = cl === undefined ? ctx.datalib.collection.get(name) : cl

    if (cl === undefined) {
      cl = new Collection(name)
      ctx.datalib.add(cl)
    }

    if (add) {
      this.collection.add(cl)
    }

    return cl
  }

  getInternalObject(
    ctx: ToolContext,
    key: string | number,
    dataclass_or_instance: SceneObjectData['constructor'] | SceneObjectData
  ): SceneObject {
    const cname = '[Internal ' + this.lib_id + ']'
    const name = cname + ' ' + key

    const cl = this.getCollection(ctx, cname)

    let ob = ctx.datalib.object.get(name)

    if (ob === undefined) {
      ob = new SceneObject()
      ob.name = name

      let data: SceneObjectData

      if (dataclass_or_instance instanceof SceneObjectData) {
        data = dataclass_or_instance
      } else {
        data = new dataclass_or_instance()
      }

      ctx.datalib.add(ob)
      ctx.datalib.add(data)

      ob.data = data
    }

    ob.flag |= ObjectFlags.INTERNAL

    if (!cl.has(ob)) {
      cl.add(ob)
      this.updateObjectList()
    }

    return ob
  }

  updateObjectList(): void {
    this.recalc &= ~SceneRecalcFlags.OBJECTS

    if (this.collection === undefined) {
      // eslint-disable-next-line no-console
      console.warn('No collection in scene!!!')
      return
    }

    const set = new Set<SceneObject>()

    const rec = (cl: Collection): void => {
      for (const ob of cl.objects) {
        set.add(ob)
      }

      for (const child of cl.children) {
        rec(child)
      }
    }

    rec(this.collection)

    for (const ob of this.objects) {
      if (!set.has(ob)) {
        this.objects.remove(ob)
      }
    }

    for (const ob of set) {
      if (!this.objects.has(ob)) {
        this.objects.push(ob)
        ob.lib_addUser(this)

        if (this.objects.active === undefined) {
          this.objects.active = ob
        }
      }
    }

    rec(this.collection)
  }

  add(ob: SceneObject): void {
    this.objects.push(ob)
    this.collection.add(ob)

    if (this.objects.active === undefined) {
      this.objects.active = ob
    }
  }

  switchToolMode(mode: boolean | number | string, _file_loading = false) {
    if (mode === undefined) {
      throw new Error('switchToolMode: mode cannot be undefined')
    }

    if (typeof mode === 'boolean') {
      mode = mode ? 1 : 0
    }

    const i = typeof mode == 'number' ? mode : (Scene.toolModeProp.values[mode] as number)

    if (i === undefined) {
      throw new Error('invalid tool mode ' + mode)
    }

    let old: ToolMode
    const cls = ToolModes[i]
    let ret: ToolMode | undefined

    if (this.toolmode_i in this.toolmode_map) {
      if (!_file_loading) {
        this.toolmode.onInactive()
      }
    }

    for (const tm of this.toolmodes) {
      if (tm.constructor === cls) {
        ret = tm
        break
      }
    }

    if (this.toolmode_i < this.toolmodes.length && this.toolmode_i >= 0) {
      old = this.toolmodes[this.toolmode_i]
      old.storedSelectMask = this.selectMask
    }

    if (ret === undefined) {
      ret = new cls(this.widgets.ctx)
      const def = cls.toolModeDefine()

      this.toolmodes.push(ret)
      this.toolmode_map[i] = ret
      this.toolmode_namemap[def.name] = ret
    }

    ret.ctx = this.ctx
    this.toolmode_i = i

    if (ret.storedSelectMask === -1 || ret.storedSelectMask === undefined) {
      const def = cls.toolModeDefine()

      if (def.selectMode !== undefined) {
        ret.storedSelectMask = def.selectMode
      }
    }

    if (ret.storedSelectMask >= 0) {
      this.selectMask = ret.storedSelectMask
    }

    if (_file_loading) {
      window.setTimeout(() => {
        if (ret === this.toolmode) {
          ret.onActive()
        }
      }, 10)
    } else {
      ret.onActive()
    }

    if (!_file_loading && this.outputs.onToolModeChange.hasEdges) {
      this.outputs.onToolModeChange.graphUpdate()
    }

    return ret
  }

  remove(ob: SceneObject) {
    if (ob === undefined || !this.objects.includes(ob)) {
      // eslint-disable-next-line no-console
      console.warn('object not in scene', ob)
      return
    }

    this.objects.remove(ob)
    this.collection.remove(ob)
  }

  destroy() {
    try {
      this.destroyIntern()
    } catch (error) {
      util.print_stack(error as Error)
      // eslint-disable-next-line no-console
      console.warn('got error in Scene.prototype.destroy')
    }
  }

  destroyIntern() {
    for (const ob of this.objects) {
      ob.lib_remUser()
    }

    this.objects = new ObjectList(undefined, this)
    this.objects.onselect = this._onselect.bind(this)

    this.widgets.destroy(this.widgets.gl!)
  }

  static blockDefine() {
    return {
      typeName   : 'scene',
      defaultName: 'Scene',
      uiName     : 'Scene',
      flag       : BlockFlags.FAKE_USER, //always have user count > 0
      icon       : -1,
    }
  }

  _onselect(obj: SceneObject, state: boolean): void {
    if (this.outputs.onSelect.hasEdges) {
      this.outputs.onSelect.graphUpdate()
    }
  }

  static nodedef() {
    return {
      name   : 'scene',
      uiname : 'Scene',
      flag   : 0,
      inputs : {},
      outputs: {
        onSelect        : new DependSocket('Selection Change'),
        onToolModeChange: new DependSocket('Toolmode Change'),
        onTimeChange    : new FloatSocket('Time Change'),
      },
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const sstruct = DataBlock.defineAPI(api, struct ?? api.mapStruct(this, true))

    sstruct.struct('envlight', 'envlight', 'Ambient Light', EnvLight.defineAPI(api))
    sstruct.bool('propEnabled', 'propEnabled', 'Magnet Mode').icon(Icons.MAGNET)
    sstruct.enum('propMode', 'propMode', PropModes, 'Magnet Curve')
    sstruct.float('propRadius', 'propRadius', 'Magnet Radius').noUnits().range(0.01, 1000000)
    sstruct.bool('propIslandOnly', 'propIslandOnly', 'Island Only')

    const prop = makeToolModeEnum()

    const def = sstruct.enum('toolmode_i', 'toolmode', prop, 'ToolMode', 'ToolMode')
    def.on('change', function (this: {dataref: Scene}, newval: any, oldval: any) {
      const scene = this.dataref

      scene.toolmode_i = oldval
      scene.switchToolMode(newval)
      window.redraw_viewport()
    })

    const base = ToolMode.defineAPI(api)
    sstruct.dynamicStruct('toolmode', 'tool', 'Active Tool', base)

    const struct2 = sstruct.struct('toolmode_namemap', 'tools', 'Saved Tool Data', toolModeStruct)
    struct2.name = 'ToolModes'
    updateToolModeAPI(api, ToolModes)

    messageBus.subscribe(
      () => Scene,
      ToolMode,
      () => {
        updateToolModeAPI(api, ToolModes)
      },
      ['REGISTER', 'UNREGISTER']
    )
    return sstruct
  }

  changeTime(newtime: number): void {
    this.time = newtime
    for (const ob of this.objects) {
      ob.graphUpdate()
    }

    if (this.collection) {
      this.collection.update()
      for (const c of this.collection.flatChildren) {
        c.graphUpdate()
      }
    }

    this.outputs.onTimeChange.graphUpdate()
    window.updateDataGraph(true)
  }

  loadSTRUCT(reader: StructReader<this>): void {
    this.#loading = true

    //very important these three lines go *before*
    //call to reader(this)
    this.toolmodes = []
    this.toolmode_map = {}
    this.toolmode_namemap = {}

    reader(this)
    super.loadSTRUCT(reader)

    //files written before APP_VERSION 8 store this as a raw int
    this.selectMask = normalizeSelMask(this.selectMask, SelMask.OBJECT)

    this.objects.scene = this
    this.objects.onselect = this._onselect.bind(this)

    this.widgets.ctx = getAppState().ctx as ViewContext
    this.widgets.clear()

    let found = 0

    //detected dead toolmodes
    this.toolmodes = this.toolmodes.filter((mode) => mode.setManager)
    this.toolmode_i = Scene.toolModeProp.values[this.toolmode_i] as number

    //sanity check
    if (this.toolmode_i === undefined) {
      this.toolmode_i = 0
    }

    for (const mode of this.toolmodes) {
      mode.setManager(this.widgets)

      const def = (mode.constructor as unknown as {toolModeDefine(): {name: string}}).toolModeDefine()
      const i = Scene.toolModeProp.values[def.name]

      // A mode whose addon is disabled is still deserializable (nstructjs knows
      // the struct) but has no enum slot, so it stays in `toolmodes` to round-trip
      // and out of the runtime maps, which are keyed by that slot.
      if (i === undefined) {
        continue
      }

      if (i === this.toolmode_i) {
        found = 1
      }

      this.toolmode_map[i] = mode
      this.toolmode_namemap[def.name] = mode
    }

    if (!found) {
      this.toolmode_i = -1

      this.switchToolMode(0, true)
    }
  }

  dataLink(getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    super.dataLink(getblock, getblock_addUser)

    this.collection = getblock_addUser(this.collection as unknown as number, this) as Collection

    if (this.#linked) {
      // eslint-disable-next-line no-console
      console.log('DOUBLE CALL TO dataLink')
      return
    }

    this.#linked = true

    this.objects.dataLink(this, getblock, getblock_addUser)
    delete (this as unknown as any).active

    this.#loading = false
    this.regenObjectList()

    for (const tool of this.toolmodes) {
      tool.dataLink(this, getblock, getblock_addUser)
    }
  }

  updateWidgets() {
    const ctx = this.widgets.ctx

    if (ctx?.scene === undefined) {
      return
    }

    const toolmode = this.toolmode
    if (toolmode) {
      toolmode.ctx = ctx
    }

    try {
      this.updateWidgets_intern()
    } catch (error) {
      util.print_stack(error as Error)
      // eslint-disable-next-line no-console
      console.warn('updateWidgets() failed')
    }
  }

  updateWidgets_intern() {
    const ctx = this.widgets.ctx
    if (ctx === undefined) return

    this.ctx = ctx

    this.widgets.update()
    if (this.toolmode !== undefined) {
      this.toolmode.ctx = ctx
      this.toolmode.update()
    }
  }
}

DataBlock.register(Scene)
registerDataAPI(Scene)

messageBus.subscribe(
  () => Scene,
  ToolMode,
  () => {
    Scene.toolModeProp = makeToolModeEnum()

    //update enum property in data api
    const api = peekAppState()?.api
    if (api?.hasStruct(Scene)) {
      const st = api.mapStruct(Scene)
      const prop = st.pathmap.toolmode.data as unknown as EnumProperty
      prop.updateDefinition(Scene.toolModeProp)
    }
  },
  ['REGISTER', 'UNREGISTER'],
  1
)
