import {DataPathError} from '../../path.ux/scripts/pathux.js'
import {UIBase} from '../../path.ux/scripts/core/ui_base.js'
import {Container} from '../../path.ux/scripts/core/ui.js'
import {Vector2} from '../../util/vectormath.js'
import {Node, NodeFlags} from '../../core/graph.js'
import {layoutNode} from '../../core/graph_spatial.js'
import type {ViewContext} from '../../core/context'
import type {NodeSocketElem} from './node_socket_ui.js'
import type {NodeEditorBase} from './NodeEditor.js'
import {NodeLayout, SocketType, UINode} from './node_base.js'

/**
 * The widget for one graph node: its title, body UI, and the socket widgets
 * around it. Positioned absolutely in graph space (see `setCSS`, which projects
 * the node's `graph_ui_pos` through the editor's VelPan).
 */
export class NodeUI extends Container<ViewContext> {
  pos = new Vector2()
  size = new Vector2()
  /** node position before VelPan projection (used to detect when it moved) */
  rawpos = new Vector2()

  inputs: NodeSocketElem[] = []
  outputs: NodeSocketElem[] = []
  allsockets: NodeSocketElem[] = []

  _isHighlight = false
  _node: Node | undefined = undefined

  graph_id: number | undefined = undefined
  ned: NodeEditorBase | undefined = undefined // owning node editor

  get isHighlight(): boolean {
    return this._isHighlight
  }

  set isHighlight(val: boolean) {
    this._isHighlight = val
    this.updateColor()
  }

  updateColor() {
    let mask = 0
    if (this.isHighlight) {
      mask |= 1
    }
    if (this.getNode().graph_flag & NodeFlags.SELECT) {
      mask |= 2
    }

    switch (mask) {
      case 0: // normal
        this.background = this.getDefault('background-color') as string
        break
      case 1: // highlight
        this.background = this.getDefault('highlight-color') as string
        break
      case 2: // select
        this.background = this.getDefault('select-color') as string
        break
      case 3: // highlight + select
        this.background = this.getDefault('highlight-select-color') as string
        break
    }
  }

  static define() {
    return {
      tagname: 'nodeui-x',
      style  : 'NodeEditorNode',
    }
  }

  remove(): void {
    super.remove()

    for (const s of this.allsockets) {
      s.remove()
    }
  }

  init(): void {
    super.init()

    const path = this.getAttribute('datapath')!

    let node: Node
    try {
      node = this.ctx.api.getValue<Node>(this.ctx, path)!
    } catch (error) {
      if (error instanceof DataPathError) {
        // eslint-disable-next-line no-console
        console.warn('Invalid node path ' + path)
        return
      } else {
        throw error
      }
    }

    const uinode = node as UINode
    let uiname = uinode.uiname
    if (uiname === undefined) {
      uiname = node.constructor!.nodedef().uiname
    }
    if (uiname === undefined) {
      uiname = node.constructor!.name
    }

    const title = this.label(uiname)
    title.font = 'TitleText'

    let y = 35

    const layout = layoutNode(node, {
      // socket spacing
      socksize: 40,
    }) as NodeLayout

    // how much sockets stick out from the node
    const stickOutAmount = 20

    this.size.load(layout.size)

    for (let i = 0; i < 2; i++) {
      const socks = (i ? node.outputs : node.inputs) as {[k: string]: SocketType}
      const lsocks = i ? layout.outputs : layout.inputs
      const key = i ? 'outputs' : 'inputs'

      for (const k in socks) {
        const sock = socks[k]

        const uisock = document.createElement('node-socket-elem-x') as unknown as NodeSocketElem

        // note: uisock is physically the child of this.ned.nodeContainer
        uisock.parentWidget = this
        uisock.type = i ? 'output' : 'input'

        const lsock = lsocks[k]

        uisock.pos[0] = lsock[0]
        uisock.pos[1] = lsock[1]

        if (!i) {
          uisock.pos[0] -= stickOutAmount
        } else {
          uisock.pos[0] += stickOutAmount
        }

        uisock.ctx = this.ctx
        uisock.ned = this.ned
        uisock.socket = sock
        uisock.uinode = this
        uisock.setAttribute('datapath', this.getAttribute('datapath') + '.' + key + "['" + k + "']")

        this.ned!.nodeContainer.shadow.appendChild(uisock)

        uisock.update()
        uisock.setCSS()

        uisock.doOnce(uisock.updatePos)

        if (i) {
          this.outputs.push(uisock)
        } else {
          this.inputs.push(uisock)
        }

        this.allsockets.push(uisock)
        this.ned!.sockets.push(uisock)

        y += ~~(uisock.size * 1.45) + 8
      }
    }

    const ui = document.createElement('container-x') as unknown as Container<ViewContext>
    ui.ctx = this.ctx
    ui.dataPrefix = this.getAttribute('datapath') + '.'
    this.add(ui)

    if (uinode.buildUI) {
      uinode.buildUI(ui)
    }

    ui.style['position'] = 'absolute'
    // XXX magic number
    ui.style['top'] = ~~(y + 30) + 'px'

    this.setCSS()
  }

  getNode(): Node {
    //let's cache this
    if (!this._node) {
      this._node = this.ctx.api.getValue<Node>(this.ctx, this.getAttribute('datapath')!)
    }

    return this._node!
  }

  setCSS(): void {
    super.setCSS()

    let node = this.getNode()
    if (!node) {
      return
    }

    this.pos.load(node.graph_ui_pos)

    let co = this.pos
    let scale = this.size

    this.rawpos = new Vector2(co)

    if (this.hasAttribute('datapath')) {
      const path = this.getAttribute('datapath')!
      try {
        node = this.ctx.api.getValue<Node>(this.ctx, path)!
      } catch (error) {
        if (error instanceof DataPathError) {
          // eslint-disable-next-line no-console
          console.warn('error in ui wrapper node; path to real node was:', path)
          return
        } else {
          throw error
        }
      }

      co.load(node.graph_ui_pos)
      scale.load(node.graph_ui_size)
    }

    this.updateColor()

    const ned = this.ned

    if (ned === undefined && this.parentNode !== undefined) {
      this.doOnce(this.setCSS)
      return
    }

    for (const sock of this.allsockets) {
      sock.uinode = this
      sock.setCSS()

      scale[1] += sock.size
    }

    co = new Vector2(co)
    scale = new Vector2(scale)

    const mat = new DOMMatrix()
    mat.translateSelf(co[0], co[1], 0.0)
    this.style['transform'] = mat.toString()

    this.style['position'] = 'absolute'
    this.style['width'] = ~~scale[0] + 'px'
    this.style['height'] = ~~scale[1] + 'px'

    let color
    if (node.graph_flag & NodeFlags.SELECT) {
      color = this.getDefault('borderSelect')
    } else {
      color = this.getDefault('border-color')
    }

    const r = this.getDefault('border-width')
    const s = this.getDefault('border-style')

    this.style['border'] = `${r}px ${s} ${color}`
    this.saneStyle['border-radius'] = this.getDefault('border-radius') + 'px'

    this.noMarginsOrPadding()
  }

  update(): void {
    super.update()

    const node = this.getNode()
    if (!node) {
      //this.remove();
      return
    }

    if (this.rawpos.vectorDistance(node.graph_ui_pos)) {
      this.setCSS()
    }
  }
}

UIBase.register(NodeUI)
