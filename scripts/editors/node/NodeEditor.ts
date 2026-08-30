import {Area, contextWrangler} from '../../path.ux/scripts/screen/ScreenArea.js'
import {Editor, VelPan, type EditorSideBar} from '../editor_base'
import {AnyGraph, HighlightArray, NodeRecalcFlags, SocketType} from './node_base.js'
import {NodeUI} from './node_ui.js'
import {NodeSocketElem} from './node_socket_ui.js'
import {
  startMenu,
  saveUIData,
  loadUIData,
  DataPathError,
  KeyMap,
  HotKey,
  nstructjs,
  type DataAPI,
  type DataStruct,
  type Menu,
  type IAreaDef,
  Screen,
} from '../../path.ux/scripts/pathux.js'

import {UIBase, PackFlags} from '../../path.ux/scripts/core/ui_base.js'
import {Container, RowFrame} from '../../path.ux/scripts/core/ui.js'
import {Vector2} from '../../util/vectormath.js'
import * as util from '../../util/util.js'
import {ShaderNodeTypes} from '../../shadernodes/shader_nodes.js'

import {VelPanPanOp} from '../velpan.js'
import {SelOneToolModes} from '../../core/select_types.js'
import {Node, NodeFlags} from '../../core/graph.js'
import {Overdraw} from '../../path.ux/scripts/util/ScreenOverdraw.js'
import {ModalFlags} from '../../core/modalflags.js'
import {Icons} from '../icon_enum.js'
import type {ViewContext} from '../../core/context'
import type {Material} from '../../core/material'
import type {StructReader} from '../../path.ux/scripts/util/nstructjs'

const projcos = util.cachering.fromConstructor<Vector2>(Vector2, 64)

/**
 * Scroll/clip container that holds the NodeUI widgets and owns the SVG
 * `overdraw` layer the connection lines are drawn into.
 */
export class NodeContainer extends Container<ViewContext> {
  overdraw: Overdraw<ViewContext> | undefined = undefined

  static define() {
    return {
      tagname: 'shadergraph-node-container-x',
    }
  }

  clear() {
    const nodes = Array.from(this.childNodes).concat(Array.from(this.shadow.childNodes))
    nodes.forEach((n) => n.remove())
  }

  setCSS() {
    super.setCSS()
    this.style.transformOrigin = 'top left'
    this.style['overflow'] = 'visible'
  }

  removeOverdraw(): void {
    if (this.overdraw) {
      this.overdraw.clear()
      this.overdraw.remove()
      this.overdraw = undefined
    }
  }

  createOverdraw(screen: Screen<ViewContext>): void {
    if (this.overdraw !== undefined) {
      this.overdraw.remove()
    }

    try {
      this.overdraw = document.createElement('overdraw-x') as unknown as Overdraw<ViewContext>
      this.overdraw.startNode(this, screen)
      this.overdraw.style.overflow = 'visible'
      // The outermost <svg> clips to its viewport by default; connection lines
      // are drawn in graph space (then CSS-transformed) and fall outside it, so
      // disable the SVG clip too — the editor's own overflow:hidden still bounds it.
      this.overdraw.svg.style.overflow = 'visible'
    } catch (error) {
      console.error((error as Error).stack)
      console.error((error as Error).message)
      this.overdraw = undefined
    }
  }
}
UIBase.register(NodeContainer)

/**
 * Pan/zoom 2D graph editor. Mirrors the graph at `graphPath` as a tree of
 * NodeUI/NodeSocketElem widgets inside `nodeContainer`, draws the connections
 * into its SVG overdraw, and dispatches edits through the `node.*` ToolOps
 * (node_ops.ts / node_selectops.ts). Per-frame work is deferred via the
 * `recalcFlags` bitmask and drained in `update()`.
 */
export class NodeEditorBase extends Editor {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
NodeEditor {
  velpan     : VelPan;
  graphPath  : string;
}
  `
  )

  // 0 = no inertial panning in the node editor (velocity is zeroed each tick).
  #velPanDecay = 0.0

  /** >0 while a transform is suppressing reactions to graph update signals */
  ignoreGraphUpdates = 0
  _lastVelPanScale = ''
  _last_zoom = new Vector2()
  _last_script: string | undefined = undefined
  _last_compile_test = util.time_ms()
  _last_dpi: number | undefined = undefined
  _last_update_gen: number | undefined = undefined

  velpan: VelPan
  nodeContainer: NodeContainer
  /** pending work bitmask (NodeRecalcFlags.UI | REBUILD), drained in update() */
  recalcFlags = 0

  graphPath = 'material.graph'
  graphClass = 'shader'
  _last_graphpath = this.graphPath

  /** the NodeUI widgets, one per graph node (+ `.highlight` = hovered node) */
  nodes: HighlightArray<NodeUI>
  /** every socket widget across all nodes (+ `.highlight` = hovered socket) */
  sockets: HighlightArray<NodeSocketElem>
  node_idmap: {[graph_id: number]: NodeUI} = {}

  last_mpos = new Vector2()
  sidebar?: EditorSideBar

  constructor() {
    super()

    this.velpan = new VelPan()
    this.velpan.decay = this.#velPanDecay
    this.velpan.scale[0] = this.velpan.scale[1] = 0.8
    this.velpan.onchange = this._on_velpan_change.bind(this)

    // of NodeContainer type
    this.nodeContainer = document.createElement('shadergraph-node-container-x') as unknown as NodeContainer
    this.nodeContainer.inherit_packflag |= PackFlags.NO_NUMSLIDER_TEXTBOX
    this.nodeContainer.overdraw?.setCSS()

    this.loadThemeOverrides()

    // make the container report the editor's DPI, not its own
    this.nodeContainer.getDPI = () => this.getDPI()

    this.defineKeyMap()

    this._last_graphpath = this.graphPath

    this.nodes = [] as unknown as HighlightArray<NodeUI>
    this.nodes.highlight = undefined
    this.sockets = [] as unknown as HighlightArray<NodeSocketElem>
    this.sockets.highlight = undefined
    this.node_idmap = {}
  }

  get graph(): AnyGraph | undefined {
    return this.ctx.api.getValue<AnyGraph>(this.ctx, this.graphPath)
    //return this.material.graph;
  }

  get material(): undefined {
    //return this.ctx.datalib.get(this.matref);
    return undefined
  }

  static defineAPI(api: DataAPI): DataStruct {
    const nedstruct = super.defineAPI(api)

    nedstruct.string('graphPath', 'graphPath', "data path to graph that's being edited")
    nedstruct.struct('velpan', 'velpan', 'Pan / Zoom', api.getStruct(VelPan))

    return nedstruct
  }

  static define(): IAreaDef {
    return {
      tagname            : 'node-editor-x',
      areaname           : 'NodeEditor',
      apiname            : 'nodeEditor',
      uiname             : 'Node Editor',
      icon               : Icons.EDITOR_NODE,
      flag               : 0,
      style              : 'NodeEditor',
      subclassChecksTheme: true,
    } as IAreaDef
  }

  loadThemeOverrides(): void {
    const overrides = this.getDefault('NodeOverrides') as unknown as Record<string, Record<string, unknown>> | undefined

    for (const k in overrides) {
      const v = overrides[k]

      for (const k2 in v) {
        const v2 = v[k2]
        this.overrideClassDefault(k, k2, v2)
      }
    }
  }

  // Override the base Area push/pop to key the "active editor" bin on NodeEditor
  // (not this.constructor), so MaterialEditor and the base node editor share one
  // bin and the context system treats them as the same active-editor slot.
  push_ctx_active(dontSetLastRef = false): void {
    contextWrangler.push(this.constructor, this as unknown as Area, !dontSetLastRef)
  }

  pop_ctx_active(_dontSetLastRef = false): void {
    contextWrangler.pop(this.constructor, this as unknown as Area)
  }

  _on_velpan_change(): void {
    if (this.ctx === undefined) {
      return
    }

    this.flagUIUpdate()
    this.update()
  }

  /** Remove all node/socket widgets and reset the overdraw layer. */
  clearGraph(): void {
    for (const c of this.nodeContainer.children) {
      if (c instanceof NodeSocketElem) {
        c.remove()
      }
    }

    for (const node of this.nodes) {
      node.remove()
    }
    for (const sock of this.sockets) {
      sock.remove()
    }

    this.nodes.length = 0
    this.node_idmap = {}
    this.sockets.length = 0

    this.nodeContainer.clear()
    if (this.ctx?.screen) {
      this.nodeContainer.createOverdraw(this.ctx.screen)
    }
  }

  switchGraph(graphpath = this.graphPath): void {
    this.graphPath = graphpath
    this.recalcFlags |= NodeRecalcFlags.REBUILD
  }

  /** Tear down and recreate a NodeUI for every node in the current graph. */
  rebuildAll(): void {
    console.warn('rebuildAll')
    if (this.ctx === undefined) return

    this.recalcFlags &= ~NodeRecalcFlags.REBUILD

    this._last_graphpath = this.graphPath

    this.clearGraph()

    const graph = this.fetchGraph()

    if (!graph) {
      return
    }

    console.warn('regenerating node editor')

    const api = this.ctx.api

    for (const node of graph.nodes) {
      const cls = node.constructor!

      if (!api.hasStruct(cls)) {
        console.warn('Auto-making data api for ' + cls.name)
        // Chain Node.defineAPI onto the new node class's struct, declaring Node's
        // members directly on it.
        Node.defineAPI(api, api.mapStruct(cls, true))
      }

      const path = this.graphPath + '.nodes[' + node.graph_id + ']'

      const node2 = document.createElement('nodeui-x') as unknown as NodeUI

      node2.ned = this
      node2.ctx = this.ctx
      node2.setAttribute('datapath', path)

      this.nodes.push(node2)
      this.nodeContainer.shadow.appendChild(node2 as unknown as HTMLElement)
      node2.parentWidget = this.nodeContainer
      // check that node2 initialized
      if (this.ctx !== undefined) {
        node2.flushUpdate()
      }
    }

    this.flagUIUpdate()
    this.flushUpdate()
  }

  init(): void {
    super.init()

    const mwheel = (e: WheelEvent) => {
      const y = e.deltaY
      let fac = y / 500.0

      if (fac < 0.0) {
        fac = 1.0 + Math.abs(fac)
      } else {
        fac = 1.0 - fac
      }

      if (isNaN(fac) || fac === 0.0) {
        console.log('Bad scroll factor', fac)
        return
      }

      const pos = this.getLocalMouse(e.pageX, e.pageY)
      this.unproject(pos)

      this.velpan.zoomAround(pos, fac)
      this.flushUpdate()
    }

    if (!this.header) {
      throw new Error('no header')
    }

    this.shadow.prepend(this.nodeContainer as unknown as HTMLElement)
    this.nodeContainer.ctx = this.ctx
    this.nodeContainer.parentWidget = this

    //create svg overdraw element
    if (this.ctx?.screen) {
      this.nodeContainer.createOverdraw(this.ctx.screen)
    }

    this.last_mpos = new Vector2()

    const mmove = (e: PointerEvent) => {
      this.on_mousemove(e)

      this.last_mpos[0] = e.x
      this.last_mpos[1] = e.y
    }

    const makehandler = <E>(handler: (e: E) => void) => {
      return (e: E) => {
        this.push_ctx_active()
        try {
          return handler(e)
        } catch (error) {
          util.print_stack(error as Error)
        } finally {
          this.pop_ctx_active()
        }
      }
    }

    this.on_mousedown = makehandler(this.on_mousedown.bind(this))

    this.addEventListener('mousewheel', makehandler((e: WheelEvent) => mwheel(e)) as EventListener)
    this.addEventListener('pointermove', makehandler((e: PointerEvent) => mmove(e)) as EventListener)
    this.addEventListener('pointerdown', makehandler((e: PointerEvent) => this.on_mousedown(e)) as EventListener)

    this.setCSS()

    const bgcolor = this.getDefault('editorBG') as string
    this.background = bgcolor
    this.saneStyle['background-color'] = bgcolor

    this.flagRebuild()
    this.buildSidebar()
  }

  buildSidebar(): void {
    if (!this.ctx) {
      if (!this.isDead()) {
        this.doOnce(this.buildHeader)
      }
      return
    }

    if (!this.sidebar) {
      this.sidebar = this.makeSideBar()
      this.sidebar._init()
      this.sidebar.position = 'right'
      this.sidebar.collapse(false)
    }
    this.onSidebarBuild(this.sidebar)
    this.sidebar.flushUpdate()
    this.sidebar.style.zIndex = '10'
  }

  buildHeader(): void {}

  onSidebarBuild(sidebar: EditorSideBar): void {
    sidebar.tabpanel.tab('Node')
  }

  rebuildSidebar(): void {
    if (this.sidebar === undefined) {
      return
    }

    const uidata = saveUIData(this.sidebar, 'node editor sidebar')

    this.sidebar.clear()
    this.onSidebarBuild(this.sidebar)

    loadUIData(this.sidebar, uidata)
  }

  makeHeader(container: Container<ViewContext>, addNoteArea = true): Container<ViewContext> {
    const header = super.makeHeader(container, addNoteArea).row()
    const menustrip = (this.menuStrip = header.row())

    header.style.zIndex = '10'
    menustrip.saneStyle['margin-left'] = '35px' //go past mouse threshold for screen border

    const button = menustrip.menu('Add', []) as unknown as {_build_menu: () => void}
    const this2 = this
    button._build_menu = function (this: {_menu: Menu<ViewContext>}) {
      this._menu = this2.makeAddNodeMenu()
      console.warn('Create Menu ' + this._menu._id)
    }

    menustrip.menu('View', [['Reset View', () => this.resetView()]])

    return header
  }

  resetView() {
    this.velpan.reset()
  }

  menuStrip?: RowFrame<ViewContext>

  /** Find the socket widget caching a given graph socket (linear scan, by identity). */
  getUISocket(sock: SocketType): NodeSocketElem | undefined {
    for (const node of this.nodes) {
      for (const sock2 of node.allsockets) {
        //remember that we cache direct references to sockets
        //for performance reason
        if (sock2.socket === sock) return sock2
      }
    }

    return undefined
  }

  on_mousedown(e: PointerEvent): void {
    this.last_mpos[0] = e.pageX
    this.last_mpos[1] = e.pageY

    const p = this.getLocalMouse(e.pageX, e.pageY)
    const sock = this.findSocket(p[0], p[1])

    if (sock !== undefined) {
      sock.click()
      return
    }

    let elem = this.ctx.screen.pickElement<UIBase<ViewContext>>(e.pageX, e.pageY)

    if (!elem) {
      console.log('elem', elem, e.pageX, e.pageY)
      return
    }

    let n1: UIBase<ViewContext> | undefined = elem
    while (n1?.parentWidget) {
      if (n1 instanceof NodeUI) {
        elem = n1
        break
      }
      n1 = n1.parentWidget
    }

    if (e.button === 1 || elem === this.nodeContainer || elem === this.container || elem === this) {
      const tool = new VelPanPanOp()

      const id = this.getID()
      tool.inputs.velpanPath.setValue(`screen.editors[${id}].velpan`)

      this.ctx.toolstack.execTool(this.ctx, tool)
    } else if (elem instanceof NodeUI) {
      let mode = SelOneToolModes.UNIQUE
      const node = elem.getNode()

      if (e.shiftKey) {
        mode = node.graph_flag & NodeFlags.SELECT ? SelOneToolModes.SUB : SelOneToolModes.ADD
      }

      const gp = this.graphPath
      const gc = this.graphClass

      let cmd = `node.selectone(graphPath='${gp}' graphClass='${gc}' mode=${mode}`
      cmd += ` nodeId=${node.graph_id})`

      console.log(cmd)

      this.ctx.api.execTool(this.ctx, cmd)

      if (mode === SelOneToolModes.UNIQUE) {
        for (const elem2 of this.nodes) {
          elem2.setCSS()
        }
      } else {
        elem.setCSS()
      }

      console.log('translate')
      this.ctx.api.execTool(this.ctx, 'node.translate(useNodeEditorGraph=1)')
    }
  }

  on_resize(newsize: Vector2): void {
    super.on_resize(newsize)

    if (!this.header || !this.ctx) {
      this.flagRebuild()
      return
    }

    this._setNodeContainerRect()
  }

  get overdraw(): Overdraw<ViewContext> | undefined {
    return this.nodeContainer.overdraw
  }

  on_area_inactive(): void {
    if (this.overdraw) {
      this.nodeContainer.removeOverdraw()
    }

    this.clearGraph()
  }

  on_area_active(): void {
    super.on_area_active()
    this.nodeContainer.createOverdraw(this.ctx.screen)

    this.setCSS()
    this.flagRebuild()
    this.flagUIUpdate()
  }

  onFileLoad(is_active: boolean): void {
    if (!is_active) {
      return
    }

    this.overdraw?.clear()
    this.flagRebuild()
    this.flagUIUpdate()
  }

  /** Nearest socket widget to a local-mouse-space point, within `limit` px, or undefined. */
  findSocket(localX: number, localY: number, limit = 25): NodeSocketElem | undefined {
    limit *= this.getDPI()

    const mpos = new Vector2([localX, localY])
    const pos = new Vector2()

    let mindis = 1e17
    let minsock: NodeSocketElem | undefined = undefined

    for (const n of this.nodes) {
      for (const sock of n.allsockets) {
        pos.load(sock.getAbsPos())
        this.project(pos)

        const dis = mpos.vectorDistance(pos)

        if (dis < mindis && dis < limit) {
          mindis = dis
          minsock = sock
        }
      }
    }

    return minsock
  }

  on_mousemove(e: PointerEvent): void {
    let actnode: NodeUI | undefined = undefined
    if (0) {
      const elem = this.nodeContainer.pickElement(e.pageX, e.pageY)
      if (elem instanceof NodeUI) {
        actnode = elem
      } else {
        let n = elem as UIBase | undefined
        while (n) {
          if (n instanceof NodeUI) {
            actnode = n
            break
          } else if (n instanceof NodeSocketElem) {
            actnode = n.uinode
            break
          }
          n = n.parentWidget
        }
      }
    }

    const mpos = this.getLocalMouse(e.pageX, e.pageY)
    const sock = this.findSocket(mpos[0], mpos[1])

    if (sock !== this.sockets.highlight) {
      if (this.sockets.highlight !== undefined) {
        this.sockets.highlight.isHighlight = false
        this.sockets.highlight._redraw()
      }

      this.sockets.highlight = sock
      if (sock !== undefined) {
        actnode = sock.uinode

        sock.isHighlight = true
        sock._redraw()
      }
    }

    if (this.nodes.highlight !== actnode) {
      if (this.nodes.highlight !== undefined) {
        this.nodes.highlight.isHighlight = false
      }

      this.nodes.highlight = actnode

      if (actnode !== undefined) {
        actnode.isHighlight = true
      }
    }
  }

  updateDPI(): void {
    const dpi = this.getDPI()

    if (dpi !== this._last_dpi) {
      this._last_dpi = dpi

      console.log('dpi update')
      this.flagRebuild()
      this.flagUIUpdate()
    }
  }

  updateZoom(): void {
    if (this._last_zoom.vectorDistance(this.velpan.scale) > 0.0001) {
      this._last_zoom.load(this.velpan.scale)
    }
  }

  /** Throttled (500 ms) recompile of the material shader; redraws the viewport when it changed. */
  checkCompile(): void {
    if (util.time_ms() - this._last_compile_test < 500) {
      return
    }

    const graph = this.fetchGraph()
    if (graph === undefined) {
      this._last_compile_test = util.time_ms()
      return
    }

    let key
    if (this.graphClass === 'shader') {
      key = 'material'
    }

    if (key === undefined) {
      this._last_compile_test = util.time_ms()
      return
    }

    const mat = this.ctx.api.getValue<Material>(this.ctx, key)
    if (mat === undefined) return

    // Recompile-detection only: regenerate the WGSL and compare the source
    // string. rlights doesn't affect the change-detection here, so pass {}.
    const script = mat.generateWgsl(this.ctx.scene, {}).wgsl

    if (script !== this._last_script) {
      console.log('Shader compile update!')
      this._last_script = script
      mat._regen = true
      window.redraw_viewport()
    }

    this._last_compile_test = util.time_ms()
  }

  _setNodeContainerRect(): void {
    this.nodeContainer.saneStyle['background-color'] = this.getDefault('background-color') as string

    this.setCSS()
    for (const node of this.nodes) {
      node.setCSS()
    }
  }

  update(): void {
    if (!this.ctx || window.FILE_LOADING) {
      return
    }

    super.update()

    if (this.checkThemeUpdate()) {
      this.loadThemeOverrides()

      this.flushSetCSS()
      this.flushUpdate()
      this.flushUpdate()
    }

    this.checkCompile()
    this.updateZoom()
    this.updateDPI()

    if (this.ctx === undefined) return

    const graph = this.fetchGraph()
    if (graph === undefined) {
      this.clearGraph()
      return
    }

    let regen = graph && graph.nodes.length !== this.nodes.length
    regen = regen || this._last_graphpath !== this.graphPath
    regen = regen || !!(this.recalcFlags & NodeRecalcFlags.REBUILD)

    if (regen) {
      this.rebuildAll()
    } else if (this._last_update_gen !== graph.updateGen) {
      this._last_update_gen = graph.updateGen

      let ok = !this.ignoreGraphUpdates
      ok = ok && !(this.ctx.modalFlag & ModalFlags.TRANSFORMING)

      if (ok) {
        this.flagUIUpdate()
      }
    }

    if (this.recalcFlags & NodeRecalcFlags.UI) {
      try {
        this._recalcUI()
      } catch (error) {
        util.print_stack(error as Error)
      }
    }
  }

  /** Suppress reactions to graph update signals (balance with popIgnore). */
  pushIgnore(): void {
    this.ignoreGraphUpdates++
  }

  popIgnore(): void {
    this.ignoreGraphUpdates = Math.max(this.ignoreGraphUpdates - 1, 0)
  }

  /** Resolve the graph at `graphPath`; undefined (not throwing) on a bad/empty path. */
  fetchGraph(): AnyGraph | undefined {
    let graph

    if (this.graphPath.trim() === '') {
      return undefined
    }

    try {
      graph = this.ctx.api.getValue<AnyGraph>(this.ctx, this.graphPath)
    } catch (error) {
      if (error instanceof DataPathError) {
        if (DEBUG.verboseDataPath) console.warn('bad graph path for node editor:' + this.graphPath)
        return undefined
      } else {
        throw error
      }
    }

    return graph
  }

  setCSS(): void {
    super.setCSS()

    this.style['overflow'] = 'hidden'

    if (this.nodeContainer) {
      this.nodeContainer.saneStyle['background-color'] = 'rgba(0,0,0,0)'
    }

    if (!this.size || !this.pos) return

    if (this.overdraw) {
      this.overdraw.style['width'] = this.size[0] + 'px'
      this.overdraw.style['height'] = this.size[1] + 'px'
    }

    const dom = this.nodeContainer
    dom.style['position'] = 'absolute'
    dom.style['left'] = '0px'
    dom.style['top'] = '0px'
    dom.style['width'] = this.size[0] + 'px'
    dom.style['height'] = this.size[1] + 'px'
  }

  startAddNodeMenu(): void {
    const menu = this.makeAddNodeMenu()
    startMenu(menu, this.last_mpos[0] - 10, this.last_mpos[1] - 20, false)
  }

  makeAddNodeMenu(): Menu<ViewContext> {
    const menu = document.createElement('menu-x') as unknown as Menu<ViewContext>
    menu.ctx = this.ctx

    const cats: {[category: string]: (typeof ShaderNodeTypes)[number][]} = {}
    for (const cls of ShaderNodeTypes) {
      const def = cls.nodedef() as {category?: string}

      const cat = def.category !== undefined ? def.category : 'Misc'
      if (!(cat in cats)) {
        cats[cat] = []
      }

      cats[cat].push(cls)
    }

    for (const k in cats) {
      const menu2 = document.createElement('menu-x') as unknown as Menu<ViewContext>
      menu2.title = k
      menu2.ctx = this.ctx

      for (const cls of cats[k]) {
        menu2.addItem(cls.nodedef().uiname ?? cls.name, cls.name)
      }

      menu.addItem(menu2)
    }

    // Use the public `on_select` hook (the old TS port cast to a non-existent
    // `onselect`, so the callback never fired). Wrap the tool call in
    // push/pop_ctx_active so node.add_node runs against this editor's graph.
    menu.on_select = (id: string | number) => {
      this.push_ctx_active()
      try {
        console.log('node add menu select', id)

        let cmd = `node.add_node(useNodeEditorGraph=1 nodeClass='${id}'`
        const p = new Vector2(this.last_mpos)

        this.unproject(p, true)
        cmd += ` x=${~~p[0]} y=${~~p[1]})`

        console.log(cmd)
        this.ctx.api.execTool(this.ctx, cmd)
      } finally {
        this.pop_ctx_active()
      }
    }

    return menu
  }

  defineKeyMap(): KeyMap {
    this.keymap = new KeyMap([
      new HotKey('A', ['shift'], () => {
        console.log('Add Node!')
        this.startAddNodeMenu()
      }),
      new HotKey('G', [], 'node.translate(useNodeEditorGraph=1)'),
      new HotKey('Delete', [], 'node.delete_selected(useNodeEditorGraph=1)'),
      new HotKey('X', [], 'node.delete_selected(useNodeEditorGraph=1)'),
      new HotKey('=', [], () => {
        this.velpan.scale.mulScalar(1.1)
        this.flagUIUpdate()
        this.update()
      }),
      new HotKey('-', [], () => {
        this.velpan.scale.mulScalar(0.9)
        this.flagUIUpdate()
        this.update()
      }),
      new HotKey('A', [], `node.toggle_select_all(useNodeEditorGraph=1 mode='AUTO')`),
    ])

    return this.keymap
  }

  getKeyMaps(): KeyMap[] {
    return [this.keymap!]
  }

  getLocalMouse(x: number, y: number): Vector2 {
    //return new Vector2().loadXY(x, y)
    return new Vector2().loadXY(x - this.pos![0], y - this.pos![1])
    /*
    const rect = this.getClientRects()[0]
    if (rect === undefined) {
      return [0, 0]
    }

    return new Vector2([x - rect.x, y - rect.y])
    //*/
  }

  /** Graph space → screen space (in place); `useScreenSpace` also adds the editor offset. */
  project(co: Vector2, useScreenSpace = false): void {
    const p = projcos.next().load(co)

    p.multVecMatrix(this.velpan.mat)

    if (useScreenSpace) {
      p[0] += this.pos![0]
      p[1] += this.pos![1]
    }

    co[0] = p[0]
    co[1] = p[1]
  }

  /** Screen space → graph space (in place); inverse of `project`. */
  unproject(co: Vector2, useScreenSpace = false): void {
    const p = projcos.next().load(co)

    if (useScreenSpace) {
      p[0] -= this.pos![0]
      p[1] -= this.pos![1]
    }

    p.multVecMatrix(this.velpan.imat)

    co[0] = p[0]
    co[1] = p[1]
  }

  copy(): NodeEditorBase {
    const ret = document.createElement('node-editor-x') as unknown as NodeEditorBase

    ret.velpan.load(this.velpan)
    ret.graphPath = this.graphPath

    return ret
  }

  /** Redraw the socket-to-socket connection lines into the overdraw layer. */
  _recalcLines(): void {
    if (!this.nodeContainer.overdraw) {
      return
    }

    this.nodeContainer.overdraw.clear()

    for (const node of this.nodes) {
      for (const uisock of node.inputs) {
        let sock = uisock.socket
        // A UI socket whose data-socket ref hasn't resolved yet (e.g. mid-
        // rebuild after a graph edit) has no edges to draw — skip it rather
        // than dereferencing undefined (matches the uisock2 guard below).
        if (sock === undefined) {
          uisock.updateSocketRef()
          sock = uisock.socket
          if (sock === undefined) {
            continue
          }
        }

        const p = uisock.getAbsPos(true).copy()

        for (const sock2 of sock.edges) {
          const uisock2 = this.getUISocket(sock2)

          if (uisock2 === undefined) {
            console.warn('could not find uisocket for ', sock2)
            continue
          }

          const p2 = uisock2.getAbsPos(true).copy()
          this.overdraw!.line(p, p2, 'orange')
        }
      }
    }
  }

  flagUIUpdate() {
    this.recalcFlags |= NodeRecalcFlags.UI
    return this
  }

  flagRebuild() {
    this.recalcFlags |= NodeRecalcFlags.REBUILD
    return this
  }

  /** Re-sync every socket's cached ref + node CSS, then redraw lines; rebuilds if sockets drifted. */
  _recalcUI(): void {
    let totsock = 0

    const mat = this.velpan!.domMat
    this.nodeContainer.style.transform = mat.toString()

    for (const node of this.nodes) {
      for (const sock of node.allsockets) {
        sock.updateSocketRef()
        totsock++
      }

      node.setCSS()
    }

    this._recalcLines()

    //why does this happen? sometimes sockets get duplicated
    //in weird ways
    if (totsock !== this.sockets.length) {
      console.log('Socket length mismatch!')
      this.recalcFlags |= NodeRecalcFlags.REBUILD
      return
    }

    this.recalcFlags &= ~NodeRecalcFlags.UI
  }

  loadSTRUCT(reader: StructReader<this>): void {
    this.clearGraph()
    reader(this)

    this.velpan.onchange = this._on_velpan_change.bind(this)
    this.velpan.decay = this.#velPanDecay
  }
}
//Editor.register(NodeEditor)
