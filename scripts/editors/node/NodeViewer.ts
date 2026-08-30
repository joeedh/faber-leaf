import {layoutNode, sortGraphSpatially} from '../../core/graph_spatial.js'
import {Editor} from '../editor_base.js'
import {Area} from '../../path.ux/scripts/screen/ScreenArea.js'
import {nstructjs} from '../../path.ux/scripts/pathux.js'
import {VelPan, VelPanPanOp} from '../velpan.js'
import {Vector2} from '../../path.ux/scripts/pathux.js'
import {UIBase, color2css} from '../../path.ux/scripts/pathux.js'
import {Icons} from '../icon_enum.js'
import {Graph, type Node} from '../../core/graph.js'
import type {DataAPI, DataStruct, IAreaDef} from '../../path.ux/scripts/pathux.js'
import type {ViewContext} from '../../core/context.js'
import type {Screen} from '../../path.ux/scripts/screen/FrameManager.js'

type AnyGraph = Graph<unknown>

type Canvas2D = HTMLCanvasElement & {g: CanvasRenderingContext2D}
type Sock = Vector2 & {color?: string}

/* the per-node layout object returned by layoutNode() and augmented in buildNode() */
interface ViewerLayout {
  pos: Vector2
  size: Vector2
  socksize: number
  header: number
  graph_id: number
  canvas: Canvas2D
  inputs: {[k: string]: Sock}
  outputs: {[k: string]: Sock}
}

/**
 * Read-only, canvas-rendered debug viewer for an arbitrary graph (defaults to
 * the scene dependency graph). Unlike NodeEditor it doesn't use DOM widgets per
 * node — each node is rasterized to a cached offscreen canvas (keyed by
 * `hashNode`) and blitted, so large graphs stay cheap to pan/zoom.
 */
export class NodeViewer extends Editor {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
node.NodeViewer {
  graphPath  : string;
  graphClass : string;
  velpan     : VelPan;
}`
  )

  graphPath = 'graph'
  graphClass: string | undefined = ''

  _last_graph_path: string | undefined = undefined

  velpan: VelPan
  _last_scale = new Vector2()

  canvases: {[hash: string]: Canvas2D} = {}
  nodes: {[hash: string]: ViewerLayout} = {}
  node_idmap: {[graph_id: number]: ViewerLayout} = {}
  sockSize = 20
  extraNodeWidth = 155

  canvas: HTMLCanvasElement
  g: CanvasRenderingContext2D

  constructor() {
    super()

    this.velpan = new VelPan()
    this.velpan.pos[0] = 0
    this.velpan.pos[1] = 0
    this.velpan.onchange = this._on_velpan_change.bind(this)

    this.canvas = document.createElement('canvas')
    this.g = this.canvas.getContext('2d')!

    this.shadow.appendChild(this.canvas)
  }

  static defineAPI(api: DataAPI): DataStruct {
    const nedstruct = super.defineAPI(api)

    nedstruct.string('graphPath', 'graphPath', "data path to graph that's being edited")
    nedstruct.struct('velpan', 'velpan', 'Pan / Zoom', api.getStruct(VelPan))

    return nedstruct
  }

  init(): void {
    super.init()

    this.velpan.onchange = this._on_velpan_change.bind(this)

    this.addEventListener('mousedown', () => {
      this.push_ctx_active()

      console.log('node viewer mousedown')

      const toolop = new VelPanPanOp()
      toolop.inputs.velpanPath.setValue('nodeViewer.velpan')
      this.ctx.toolstack.execTool(this.ctx, toolop)

      this.pop_ctx_active()
    })

    this.header!.button('Arrange', () => {
      const graph = this.getGraph()

      console.log('Arranging graph', graph)
      if (graph) {
        sortGraphSpatially(graph, {
          socksize    : this.sockSize,
          steps       : 45,
          headerHeight: 75,
          extraWidth  : this.extraNodeWidth,
        })

        this.clear()
        this.rebuild()
        this.draw()
      }
    })

    this.addEventListener('wheel', (e) => {
      const df = Math.sign(e.deltaY) * 0.15

      console.log('wheel in node viewer!')

      this.velpan.scale.mulScalar(1.0 - df)
      this.velpan.update()
      this.rebuild()
    })
  }

  getGraph(): AnyGraph | undefined {
    return this.ctx.api.getValue<AnyGraph>(this.ctx, this.graphPath)
  }

  getCanvas(id: string): Canvas2D {
    if (!(id in this.canvases)) {
      const canvas = document.createElement('canvas') as Canvas2D
      canvas.g = canvas.getContext('2d')!
      this.canvases[id] = canvas
    }

    return this.canvases[id]
  }

  /** Cache key for a node's rendered canvas — changes when its layout/zoom changes. */
  hashNode(node: Node): string {
    const layout = layoutNode(node, {socksize: this.sockSize}) as ViewerLayout
    const mask = (1 << 19) - 1
    const mul = (1 << 14) - 1
    let hash = node.graph_id

    function dohash(n: number) {
      const f = ((n + mask) * mul) & mask
      hash = hash ^ f
    }

    const scale = this.velpan.scale

    dohash(layout.size[0] * scale[0])
    dohash(layout.size[1] * scale[1])

    for (let i = 0; i < 2; i++) {
      const socks = i ? layout.outputs : layout.inputs
      let j = 0

      for (const k in socks) {
        const sock = socks[k]

        dohash(sock[0] * scale[0])
        dohash(sock[1] * scale[1])
        dohash(j++)
      }
    }

    return hash + ':' + node.graph_id
  }

  _on_velpan_change(): void {
    if (this._last_scale.vectorDistance(this.velpan.scale) > 0.1) {
      this.rebuild()
    } else {
      this.draw()
    }

    this._last_scale.load(this.velpan.scale)
  }

  clear(): void {
    this.canvases = {}
    this.nodes = {}
    this.node_idmap = {}
  }

  /** Render one node (header, sockets, labels) to an offscreen canvas and cache it. */
  buildNode(node: Node): ViewerLayout {
    const scale = this.velpan.scale
    const layout = layoutNode(node, {socksize: this.sockSize, extraWidth: this.extraNodeWidth}) as ViewerLayout
    const hash = this.hashNode(node)

    layout.size = new Vector2(layout.size)

    layout.size.mulScalar(scale[0])
    layout.size.floor()

    const nodeSockets = node as unknown as {
      inputs: {[k: string]: {constructor: {nodedef(): {color?: number[]}}}}
      outputs: {[k: string]: {constructor: {nodedef(): {color?: number[]}}}}
    }

    for (let i = 0; i < 2; i++) {
      const lsocks = i ? layout.outputs : layout.inputs
      const socks = i ? nodeSockets.outputs : nodeSockets.inputs

      for (const k in lsocks) {
        const sock = socks[k]
        let lsock = lsocks[k]

        lsock = new Vector2(lsock) as unknown as Sock

        const rawColor = sock.constructor.nodedef().color
        lsock.color = rawColor ? color2css(rawColor) : 'orange'
        lsocks[k] = lsock
      }
    }

    layout.canvas = this.getCanvas(hash)

    const canvas = layout.canvas
    const g = canvas.g

    const ts = (this.getDefault('DefaultText') as {size: number}).size * 1.45

    const header = (layout.header = ts * this.velpan.scale[0] * 1.3 * 2.5)

    layout.size[1] += Math.ceil(header)

    canvas.width = layout.size[0]
    canvas.height = layout.size[1]

    g.font = (this.getDefault('DefaultText') as {genCSS(size: number): string}).genCSS(ts * this.velpan.scale[0])

    g.clearRect(0, 0, canvas.width, canvas.height)
    g.beginPath()
    g.rect(0, 0, canvas.width, canvas.height)
    g.lineWidth = 2

    g.fillStyle = 'grey'
    g.strokeStyle = 'black'
    g.fill()
    g.stroke()

    g.fillStyle = 'white'

    const name = (node as unknown as {graphDisplayName(): string}).graphDisplayName()

    g.fillText(name, 1, ts * this.velpan.scale[0] * 1.3)
    g.fillText('(' + node.constructor!.name + ')', 45 * this.velpan.scale[0], ts * this.velpan.scale[0] * 1.3 * 1.7)

    layout.graph_id = node.graph_id
    this.nodes[hash] = layout
    this.node_idmap[node.graph_id] = layout

    for (let i = 0; i < 2; i++) {
      const socks = i ? layout.outputs : layout.inputs
      for (const k in socks) {
        const sock = socks[k]

        sock[1] += header / this.velpan.scale[0]

        const w = g.measureText(k).width

        const x = i ? layout.size[0] - w : 0
        const y = sock[1] * this.velpan.scale[0]

        g.fillText(k, x, y)
      }
    }

    return layout
  }

  updateCanvasSize(): void {
    const canvas = this.canvas

    const size = this.size!
    const dpi = UIBase.getDPI()

    const w = ~~(size[0] * dpi)
    const h = ~~(size[1] * dpi)

    canvas.width = w
    canvas.height = h
    canvas.style['width'] = size[0] + 'px'
    canvas.style['height'] = size[1] + 'px'
  }

  /** Composite the cached node canvases + connection lines onto the main canvas. */
  draw(): void {
    const canvas = this.canvas
    const g = this.g

    this.updateCanvasSize()

    g.clearRect(0, 0, canvas.width, canvas.height)
    g.font = (this.getDefault('DefaultText') as {genCSS(): string}).genCSS()
    g.strokeStyle = 'black'

    const transform = (p: Vector2) => {
      p[0] -= canvas.width * 0.5
      p[1] -= canvas.height * 0.5
      p.multVecMatrix(this.velpan.mat)
      p[0] += canvas.width * 0.5
      p[1] += canvas.height * 0.5
    }

    const p = new Vector2()
    const p2 = new Vector2()
    const p3 = new Vector2()
    const s = new Vector2()

    function find_sock_key(node: AnyNode, sock: unknown): string | undefined {
      for (const k in node.inputs) {
        if (node.inputs[k] === sock) {
          return k
        }
      }
    }

    g.beginPath()

    const graph = this.getGraph()
    if (!graph) {
      return
    }
    const idmap = graph.node_idmap
    let rebuild = false

    for (const k1 in this.nodes) {
      const node = this.nodes[k1]

      p.load(node.pos)
      const node2 = idmap.get(node.graph_id)

      if (node2 === undefined) {
        rebuild = true
        continue
      }

      const inputs2 = node2.inputs
      for (const k in inputs2) {
        const sock = inputs2[k]

        for (const sock2 of sock.edges) {
          let node3 = this.node_idmap[sock2.node.graph_id]
          node3 = this.node_idmap[node3.graph_id]

          const lsock1 = node.inputs[k]
          const lsock2 = node3.outputs[k]

          p2.load(node.pos).add(lsock1)
          p3.load(node3.pos).add(lsock2)

          transform(p2)
          transform(p3)

          g.moveTo(p2[0], p2[1])
          g.lineTo(p3[0], p3[1])
        }
      }
    }

    if (rebuild) {
      this.rebuild()
      this.doOnce(this.draw)
      return
    }

    g.strokeStyle = 'white'
    g.stroke()

    for (const k2 in this.nodes) {
      const node = this.nodes[k2]

      p.load(node.pos)

      for (let i = 0; i < 2; i++) {
        const socks = i ? node.outputs : node.inputs

        for (const k in socks) {
          const sock = socks[k]

          p2.load(sock)
          p2.add(p)
          transform(p2)

          g.beginPath()
          g.fillStyle = sock.color ?? 'orange'

          g.moveTo(p2[0], p2[1])
          g.arc(p2[0], p2[1], this.sockSize * 0.35, -Math.PI, Math.PI)

          g.fill()
        }
      }
    }

    g.fill()

    g.fillStyle = 'grey'
    g.beginPath()
    for (const k in this.nodes) {
      const node = this.nodes[k]

      p.load(node.pos)
      s.load(node.size)

      transform(p)
      g.drawImage(node.canvas, p[0], p[1])
    }

    g.fill()
    g.stroke()
  }

  /** Rebuild the per-node canvas cache for the current graph, dropping stale entries. */
  rebuild(): void {
    if (!this.ctx) {
      return
    }

    this._last_graph_path = this.graphPath
    console.log('rebuilding node editor')

    this.updateCanvasSize()

    const graph = this.ctx.api.getValue<AnyGraph>(this.ctx, this.graphPath)
    if (this.graphPath === '' || graph === undefined) {
      console.warn('Failed to load graph!')
      this._last_graph_path = undefined
      return
    }

    const visit = new Set<string>()

    for (const node of graph.nodes) {
      const hash = this.hashNode(node)
      visit.add(hash)

      if (!(hash in this.nodes)) {
        this.buildNode(node)
      }
    }

    const del: string[] = []
    for (const k in this.canvases) {
      if (!visit.has(k)) {
        del.push(k)
      }
    }

    for (const k of del) {
      delete this.canvases[k]
      delete this.nodes[k]
    }

    this.draw()
  }

  on_resize(): void {
    this.draw()
  }

  update(): void {
    if (this._last_graph_path !== this.graphPath) {
      this.clear()
      this.rebuild()
    }

    this.velpan.update()
  }

  static define(): IAreaDef {
    return {
      apiname : 'nodeViewer',
      tagname : 'nodegraph-viewer-x',
      areaname: 'nodegraph_viewer',
      uiname  : 'SceneGraph Viewer',
      icon    : Icons.EDITOR_NODE,
    }
  }
}

type AnyNode = Node

Editor.register(NodeViewer)

export function getNodeViewer(screen: Screen<ViewContext>) {
  for (const sarea of screen.sareas) {
    if (sarea.area && sarea.area instanceof NodeViewer) {
      return sarea
    }
  }
}

export function showDebugNodePanel(screen: Screen<ViewContext>): void {
  const existing = getNodeViewer(screen)

  if (existing) {
    existing.hidden = false
    screen.regenBorders()

    existing.pos![0] = Math.max(existing.pos![0], 200)
    existing.loadFromPosSize()

    existing.bringToFront()
    return
  }

  const sarea = screen.popupArea(NodeViewer as unknown as typeof Area)

  const area = sarea.area as NodeViewer
  area.velpan.scale.mulScalar(0.5)

  area.graphPath = 'graph'
  area.graphClass = undefined
}

export function hideDebugNodePanel(screen: Screen<ViewContext>): void {
  const editor = getNodeViewer(screen)

  if (editor) {
    editor.hidden = true
    // original sets `.visible` (not a ScreenArea property); preserved verbatim
    ;(editor as unknown as {visible: boolean}).visible = false

    screen.regenBorders()
  }
}

export function toggleDebugNodePanel(screen: Screen<ViewContext>): void {
  const editor = getNodeViewer(screen)

  if (!editor || editor.hidden) {
    showDebugNodePanel(screen)
  } else {
    hideDebugNodePanel(screen)
  }
}
