import {DataPathError, haveModal} from '../../path.ux/scripts/pathux.js'
import {UIBase, PackFlags, color2css} from '../../path.ux/scripts/core/ui_base.js'
import {RowFrame} from '../../path.ux/scripts/core/ui.js'
import {Matrix4, Vector2} from '../../util/vectormath.js'
import {SocketTypes} from '../../core/graph.js'
import type {ViewContext} from '../../core/context'
import type {NodeEditorBase} from './NodeEditor.js'
import {SocketType} from './node_base.js'
import type {NodeUI} from './node_ui.js'

/**
 * One input/output socket: the little colored connection dot (drawn on its own
 * `canvas`) plus, for inputs, the socket's inline value UI. Caches a direct
 * reference to its graph `socket` (re-fetching from the data API per frame would
 * be too slow with many sockets) — keep it current via `updateSocketRef`.
 */
export class NodeSocketElem extends RowFrame<ViewContext> {
  canvas: HTMLCanvasElement
  g: CanvasRenderingContext2D
  size = 20
  /** drawn socket-dot radius, in CSS px (pre-DPI) */
  radius = 5
  /** 'input' or 'output' (or undefined before init); see the `isOutput` getter */
  type: 'input' | 'output' | undefined = undefined
  isHighlight = false

  _last_update_key: string | undefined = undefined
  ned: NodeEditorBase | undefined = undefined //owning node editor

  //okay, it's going to be too slow to always fetch sockets from the data api
  //instead, cache direct references to them here
  //but make sure to keep up to date. . .
  socket: SocketType | undefined = undefined
  needDraw = true

  uinode: NodeUI | undefined = undefined
  pos = new Vector2()
  _abspos = new Vector2()
  _last_dpi: number

  constructor() {
    super()

    this.canvas = document.createElement('canvas')
    this.g = this.canvas.getContext('2d')!

    this.inherit_packflag |= PackFlags.NO_NUMSLIDER_TEXTBOX
    this._last_dpi = this.getDPI()
  }

  /** true for output sockets; derived from `type` so the two can't disagree */
  get isOutput(): boolean {
    return this.type === 'output'
  }

  static define() {
    return {
      tagname: 'node-socket-elem-x',
    }
  }

  click(_e?: PointerEvent): void {
    this.updateSocketRef()

    if (haveModal()) {
      return
    }

    if (this.socket === undefined) {
      console.warn('socket ui error')
      return
    }

    const node = this.uinode!.getNode()
    const sock = this.socket

    if (sock === undefined) {
      console.warn('Error in node editor ui socket', this, this.uinode)
      return
    }

    let cmd

    console.log(sock, sock.socketType === SocketTypes.INPUT, sock.edges.length)

    if (sock.socketType === SocketTypes.INPUT && sock.edges.length === 1) {
      const srcSock = sock.edges[0]
      const srcNode = srcSock.node

      cmd = `node.connect(useNodeEditorGraph=1 node1_id=${srcNode.graph_id}`
      cmd += ` disconnectSockID=${sock.graph_id}`
      cmd += ` sock1_id=${srcSock.graph_id})`
    } else {
      cmd = `node.connect(useNodeEditorGraph=1 node1_id=${node.graph_id}`
      cmd += ` sock1_id=${sock.graph_id})`
    }

    this.ctx.api.execTool(this.ctx, cmd)
  }

  getAbsPos(center_in_circle = false): Vector2 {
    const p = this._abspos

    p.load(this.pos).add(this.uinode!.pos)

    if (this.type === 'output') {
      p[0] -= this.size
    } else {
      p[0] += this.size
    }
    p[1] += this.size

    if (center_in_circle) {
      const r = this.size * 0.5

      p[0] += this.type === 'output' ? r : -r
      p[1] += -r
    }

    return p
  }

  updateSocketRef(): void {
    try {
      this.socket = this.ctx.api.getValue<SocketType>(this.ctx, this.getAttribute('datapath')!)
    } catch (error) {
      if (error instanceof DataPathError) {
        this.socket = undefined
      } else {
        throw error
      }
    }

    if (this.socket === undefined) {
      console.warn('Bad socket reference')
    }
  }

  init(): void {
    super.init()

    if (this.type === 'input') {
      this.add(this.canvas as unknown as UIBase<ViewContext>)
    }

    if (this.socket !== undefined) {
      this.dataPrefix = this.getAttribute('datapath') + '.'

      this.overrideDefault('height', 20)
      this.overrideDefault('width', 70)

      const onchange = () => {
        window.redraw_viewport()
      }

      this.socket.buildUI(this, onchange)
    }
    if (this.type === 'output') {
      this.add(this.canvas as unknown as UIBase<ViewContext>)
    }

    this.setCSS()

    this.updateSocketRef()
    this._redraw()

    this.background = 'rgba(0,0,0,0)'
  }

  _redraw(): void {
    const g = this.g
    const dpi = this.getDPI()
    const size = Math.ceil(this.size * dpi)

    this.canvas.width = size
    this.canvas.height = size

    g.beginPath()
    g.clearRect(0, 0, size, size)

    if (this.socket === undefined) {
      this.updateSocketRef()
    }

    if (this.socket === undefined) {
      console.warn('bad socket', this.getAttribute('datapath'))
      return
    }
    const rawColor: number[] | string | undefined = this.socket.constructor!.nodedef().color

    let color: string
    if (rawColor === undefined) {
      color = 'blue'
    } else if (rawColor instanceof Array) {
      color = color2css(rawColor)
    } else {
      color = rawColor
    }

    g.fillStyle = color
    g.beginPath()

    const r = this.radius * dpi

    g.moveTo(size * 0.5, size * 0.5)
    g.arc(size * 0.5, size * 0.5, r, -Math.PI, Math.PI)
    g.fill()

    if (this.isHighlight) {
      g.fillStyle = 'rgba(255, 255, 255, 0.5)'
      g.fill()
    }
  }

  updateDPI(): void {
    const dpi = this.getDPI()

    if (dpi !== this._last_dpi) {
      this._last_dpi = dpi

      console.log('dpi update')

      this.setCSS()
      this._redraw()
    }
  }

  updatePos(): void {
    const key = '' + this.pos[0] + ':' + this.pos[1] + ':' + this.size + ':' + UIBase.getDPI()

    if (key === this._last_update_key) {
      return
    }
    this._last_update_key = key
    this.setCSS()
  }

  update(): void {
    super.update()

    this.updateDPI()
    //this.updatePos();

    //DO NOT CALL this.updateSocketRef! there will be far
    //too many sockets to regularly update the socket reference
    //in each update tick

    if (this.needDraw) {
      this.needDraw = false
      this._redraw()
    }
  }

  setCSS(): void {
    super.setCSS()

    this.style['position'] = 'absolute'
    this.style['margin'] = this.style['padding'] = '0px'
    this.saneStyle['white-space'] = 'nowrap'

    if (this.ned === undefined) {
      console.warn('no node editor in setCSS()')
      return
    }

    const ned = this.ned
    const pos = new Vector2(this.pos)
    pos.add(this.uinode!.pos)

    const w = this.uinode!.size[0] / 2.0

    if (this.isOutput) {
      pos[0] -= w
      this.canvas.style.marginLeft = 'auto'
    }

    this.style['position'] = 'absolute'

    const tmat = new DOMMatrix()
    tmat.translateSelf(pos[0], pos[1], 0.0)
    this.style['transform'] = tmat.toString()

    this.canvas.style['width'] = this.size + 'px'
    this.canvas.style['height'] = this.size + 'px'

    this.style['width'] = w + 'px'
    this.style['height'] = this.size + 'px'
    this._redraw()
    this.background = 'rgba(0,0,0,0)'
  }
}

UIBase.register(NodeSocketElem)
