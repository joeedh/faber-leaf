import {BoolProperty, FloatProperty, nstructjs, PropFlags} from '../../path.ux/scripts/pathux.js'
import {Vector2, Vector3} from '../../util/vectormath.js'
import {AbstractGraphClass} from '../../core/graph_class.js'
import {Graph, SocketFlags, type Node} from '../../core/graph.js'

import {
  IntProperty,
  Vec2Property,
  StringProperty,
  ToolOp,
  DataPathError,
  type PropertySlots,
  type ToolDef,
} from '../../path.ux/scripts/pathux.js'
import {Icons} from '../icon_enum.js'
import {ModalFlags} from '../../core/modalflags.js'
import {NodeEditorBase} from './NodeEditor.js'
import type {ToolContext, ViewContext} from '../../core/context'
import type {BlockLoader, DataBlock, DataRef} from '../../core/lib_api'
import {Editor} from '../editor_base.js'
import {NodeSocketElem} from './node_socket_ui.js'

type AnyGraph = Graph<unknown>
type AnyNode = Node

/** nstructjs wrapper that serializes a whole graph for undo snapshots. */
export class SavedGraph {
  graph!: AnyGraph

  constructor(graph?: AnyGraph) {
    if (graph !== undefined) {
      this.graph = graph
    }
  }

  static STRUCT = `
graph.SavedGraph {
  graph : abstract(graph.Graph);
}
`
}
nstructjs.register(SavedGraph)

interface NodeGraphInputs extends PropertySlots {
  graphPath: StringProperty
  graphClass: StringProperty
  nodeEditorPath: StringProperty
  useNodeEditorGraph: BoolProperty
}

export interface NodeGraphUndo {
  graphPath?: string
  data?: DataView
  /* NodeSelectOpBase (node_selectops.ts) reuses this._undo with this shape */
  sel?: {[graph_id: number]: number}
  order?: {[graph_id: number]: number}
}

/**
 * Base for every node-graph ToolOp. Holds the `graphPath`/`graphClass` inputs
 * that locate the target graph (see `fetchGraph`) and a default undo that
 * snapshots/restores the entire graph via `SavedGraph`.
 */
export class NodeGraphOp<
  InputSet extends PropertySlots = {},
  OutputSet extends PropertySlots = {},
  NODE_EDITOR extends NodeEditorBase = NodeEditorBase,
> extends ToolOp<InputSet & NodeGraphInputs, OutputSet, ToolContext, ViewContext> {
  _undo?: NodeGraphUndo

  canRun(ctx: ViewContext): boolean {
    return this.getNodeEditor(ctx, false) !== undefined
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>): NodeGraphOp {
    // When `useNodeEditorGraph` is set, inherit graphPath/graphClass from the
    // active node editor instead of requiring them as explicit args.
    const tool = super.invoke(ctx, args) as NodeGraphOp
    const useNodeEditorGraph = tool.inputs.useNodeEditorGraph.getValue()

    const area = ctx.editor
    if (area instanceof NodeEditorBase) {
      tool.inputs.nodeEditorPath.setValue(Editor.getDataPath(area.constructor))
    }

    if (useNodeEditorGraph && tool.getNodeEditor(ctx) !== undefined) {
      const nodeEditor = tool.getNodeEditor(ctx)!
      tool.inputs.graphPath.setValue(nodeEditor.graphPath)
      tool.inputs.graphClass.setValue(nodeEditor.graphClass)
    }
    return tool
  }

  getNodeEditor(ctx: ViewContext, report = true): NODE_EDITOR | undefined {
    try {
      return ctx.api.getValue<NODE_EDITOR>(ctx, this.inputs.nodeEditorPath.getValue())
    } catch (error) {
      if (error instanceof DataPathError) {
        if (report) {
          ctx.error('Unknown node editor path ' + this.inputs.nodeEditorPath.getValue())
        }
        return undefined
      } else {
        throw error
      }
    }
  }

  static tooldef(): ToolDef {
    return {
      inputs: {
        graphPath         : new StringProperty(),
        graphClass        : new StringProperty(), //AbstractGraphClass.graphdef().typeName, see graph_class.js.
        nodeEditorPath    : new StringProperty(),
        useNodeEditorGraph: new BoolProperty(false),
      },
    }
  }

  /** Resolve the target graph from `graphPath`; returns undefined (not throws) on a bad path. */
  fetchGraph(ctx: ToolContext): AnyGraph | undefined {
    if (this.inputs.graphPath.getValue() === '') {
      // eslint-disable-next-line no-console
      console.warn('graphPath was empty string')
      return undefined
    }

    try {
      return ctx.api.getValue<AnyGraph>(ctx, this.inputs.graphPath.getValue())
    } catch (error) {
      if (error instanceof DataPathError) {
        // eslint-disable-next-line no-console
        console.warn('Unknown graph path ' + this.inputs.graphPath.getValue())
        return undefined
      } else {
        throw error
      }
    }
  }

  /** Flush every open NodeEditor so the change is reflected live (used by modal ops). */
  updateAllEditors(ctx: ToolContext): void {
    for (const sarea of ctx.screen.sareas) {
      if (sarea.area instanceof NodeEditorBase) {
        sarea.area.flagUIUpdate()
        sarea.area.flushUpdate()
      }
    }
  }

  undoPre(ctx: ToolContext): void {
    const graphPath = this.inputs.graphPath.getValue()
    const undo: NodeGraphUndo = (this._undo = {})

    if (graphPath === '') {
      // eslint-disable-next-line no-console
      console.warn('graphPath was empty string')
      return
    }

    const graph = ctx.api.getValue<AnyGraph>(ctx, graphPath)
    if (!graph) {
      // eslint-disable-next-line no-console
      console.warn('could not get graph')
      return
    }

    const saved = new SavedGraph(graph)

    const buf: number[] = []
    nstructjs.writeObject(buf, saved)
    const data = new DataView(new Uint8Array(buf).buffer)

    undo.graphPath = graphPath
    undo.data = data
  }

  calcUndoMem(_ctx: ToolContext): number {
    if (this._undo?.data) {
      return this._undo.data.byteLength
    }
    return 0
  }

  undo(ctx: ToolContext): void {
    if (!this._undo) {
      return
    }

    const data = this._undo.data
    const path = this._undo.graphPath

    if (!data || path === undefined) {
      // eslint-disable-next-line no-console
      console.warn('no undo data')
      return
    }

    const graph = ctx.api.getValue<AnyGraph>(ctx, path)
    if (!graph) {
      // eslint-disable-next-line no-console
      console.warn('failed to resolve graph at path ' + path)
      return
    }

    const savedgraph = nstructjs.readObject<SavedGraph>(data, SavedGraph)

    const getblock: BlockLoader = <T extends DataBlock>(ref: T | DataRef<T> | number): T | undefined => {
      const block = ctx.datalib.get<T>(ref as DataRef<T> | number)

      if (block) {
        block.lib_addUser()
      }

      return block
    }

    graph.load(savedgraph.graph)
    graph.dataLink(undefined as never, getblock, getblock)
    graph.signalUI()
  }
}

/** Modal drag that moves the selected nodes by `offset` (graph UI space). */
export class NodeTranslateOp extends NodeGraphOp<{offset: Vec2Property}> {
  first = true
  mpos = new Vector2()
  start_mpos = new Vector2()
  start_positions?: {[graph_id: number]: Vector3}

  static tooldef() {
    return {
      toolpath: 'node.translate',
      uiname  : 'Translate (Node)',
      icon    : Icons.TRANSLATE,
      is_modal: true,
      inputs: ToolOp.inherit({
        offset: new Vec2Property(),
      }),
    }
  }

  modalStart(ctx: ViewContext) {
    ctx.setModalFlag(ModalFlags.TRANSFORMING)
    return super.modalStart(ctx)
  }

  modalEnd(cancelled: boolean): void {
    const ctx = this.modal_ctx!
    super.modalEnd(cancelled)
    ctx.clearModalFlag(ModalFlags.TRANSFORMING)

    this.first = true
    this.start_mpos = new Vector2()
    this.mpos = new Vector2()
    //this.last_mpos = new Vector2();

    if (cancelled) {
      this._apply(ctx, new Vector2())
    }
  }

  on_pointermove(e: PointerEvent): void {
    const ctx = this.modal_ctx!

    const mpos = this.mpos
    const ned = this.getNodeEditor(ctx)
    if (ned === undefined) {
      return
    }
    const scale = ned.velpan.scale

    mpos[0] = e.pageX / scale[0]
    mpos[1] = e.pageY / scale[1]

    if (this.first) {
      this.start_mpos.load(mpos)
      this.first = false
      return
    }

    const off = this.inputs.offset.getValue()
    off.load(mpos).sub(this.start_mpos)

    this.exec(ctx)
    this.updateAllEditors(ctx)
  }

  _apply(ctx: ToolContext, offset: Vector2): void {
    const graph = this.fetchGraph(ctx)
    if (!graph) {
      return
    }

    let startpos: {[graph_id: number]: Vector3}

    if (this.start_positions === undefined) {
      startpos = this.start_positions = {}
      for (const node of graph.nodes.selected.editable) {
        startpos[node.graph_id] = new Vector3([node.graph_ui_pos[0], node.graph_ui_pos[1], 0])
      }
    } else {
      startpos = this.start_positions
    }

    for (const node of graph.nodes.selected.editable) {
      node.graph_ui_pos.load(startpos[node.graph_id]).add(offset)
    }

    graph.signalUI()
  }

  undo(ctx: ToolContext): void {
    super.undo(ctx)
    this.start_positions = undefined
  }

  exec(ctx: ToolContext): void {
    this._apply(ctx, this.inputs.offset.getValue())
  }

  on_pointerup(e: PointerEvent): void {
    this.modalEnd(e.button !== 0)
  }
}

ToolOp.register(NodeTranslateOp)

/** Create a node of type `nodeClass` at `pos` and add it to the graph. */
export class AddNodeOp extends NodeGraphOp<
  {
    nodeClass: StringProperty //
    pos: Vec2Property
    x: FloatProperty
    y: FloatProperty
  },
  {graph_id: IntProperty}
> {
  static invoke(ctx: ViewContext, args: Record<string, unknown>): AddNodeOp {
    const tool = super.invoke(ctx, args) as AddNodeOp

    if ('x' in args || tool.inputs.x.flag & PropFlags.USER_SET) {
      tool.inputs.pos.getValue()[0] = tool.inputs.x.getValue()
    }

    if ('y' in args || tool.inputs.y.flag & PropFlags.USER_SET) {
      tool.inputs.pos.getValue()[1] = tool.inputs.y.getValue()
    }

    return tool
  }

  static tooldef() {
    return {
      toolpath: 'node.add_node',
      uiname  : 'Add Node',

      inputs: ToolOp.inherit({
        nodeClass: new StringProperty(), //node class name, just constructor.name
        pos      : new Vec2Property([10, 300]),
        // optional x/y for nicer access from toolop command strings
        x        : new FloatProperty(),
        y        : new FloatProperty(),
      }),
      outputs: {
        graph_id: new IntProperty(), //id of new node
      },
    }
  }

  exec(ctx: ToolContext): void {
    const graphPath = this.inputs.graphPath.getValue()
    const gclassName = this.inputs.graphClass.getValue()
    const nclass = this.inputs.nodeClass.getValue()

    const graph = ctx.api.getValue<AnyGraph>(ctx, graphPath)!
    const gclass = AbstractGraphClass.getGraphClass(gclassName)
    const node = gclass.create(nclass) as AnyNode | undefined

    if (node === undefined) {
      throw new Error('failed to create node of type ' + nclass)
    }

    const pos = this.inputs.pos.getValue()

    node.graph_ui_pos[0] = pos[0]
    node.graph_ui_pos[1] = pos[1]

    graph.add(node)
    this.outputs.graph_id.setValue(node.graph_id)
  }
}

ToolOp.register(AddNodeOp)

/**
 * Modal op that wires sockets together: drag from sock1 and drop on a
 * compatible sock2. `disconnectSockID` lets a drag pull an existing input
 * connection loose before reconnecting it elsewhere.
 */
export class ConnectNodeOp extends NodeGraphOp<{
  node1_id: IntProperty
  sock1_id: IntProperty
  node2_id: IntProperty
  sock2_id: IntProperty
  disconnectSockID: IntProperty
}> {
  first = true
  start_mpos = new Vector2()
  mpos = new Vector2()
  last_sock2?: NodeSocketElem

  static invoke(ctx: ViewContext, args: Record<string, unknown>): ConnectNodeOp {
    const tool = super.invoke(ctx, args) as ConnectNodeOp

    if ('disconnectSockID' in args) {
      tool.inputs.disconnectSockID.setValue(args.disconnectSockID as number)
    }

    if ('node1_id' in args) {
      tool.inputs.node1_id.setValue(args.node1_id as number)
    }
    if ('sock1_id' in args) {
      tool.inputs.sock1_id.setValue(args.sock1_id as number)
    }

    if ('node2_id' in args) {
      tool.inputs.node2_id.setValue(args.node2_id as number)
    }
    if ('sock2_id' in args) {
      tool.inputs.sock2_id.setValue(args.sock2_id as number)
    }

    return tool
  }

  static tooldef() {
    return {
      toolpath   : 'node.connect',
      description: 'connect node sockets',
      uiname     : 'Connect Sockets',
      icon       : -1,
      inputs: ToolOp.inherit({
        node1_id: new IntProperty(-1),
        sock1_id: new IntProperty(-1),

        node2_id: new IntProperty(-1),
        sock2_id: new IntProperty(-1),

        /*used for "dragging" connections between input sockets
          which of course requires that old connection be destroyed
         */
        disconnectSockID: new IntProperty(-1),
      }),
      is_modal   : true,
    }
  }

  on_pointermove(e: PointerEvent): void {
    const ctx = this.modal_ctx!

    const graph = this.fetchGraph(ctx)
    if (!graph) {
      return
    }

    // note: reports an error notification to the user on failure
    const ned = this.getNodeEditor(ctx)
    if (ned === undefined) {
      return
    }

    const mpos = this.mpos
    mpos[0] = e.x
    mpos[1] = e.y

    const sock1 = graph.sock_idmap.get(this.inputs.sock1_id.getValue())

    const uisock1 = sock1 ? ned.getUISocket(sock1) : undefined

    this.resetTempGeom()

    if (uisock1 === undefined || sock1 === undefined) {
      return
    }

    const p = new Vector2(uisock1.getAbsPos(true))
    ned.project(p, true)

    this.makeTempLine(p, mpos, 'orange')

    const p2 = ned.getLocalMouse(mpos[0], mpos[1])
    //ned.unproject(p2, true)

    this.inputs.sock2_id.setValue(-1)
    this.inputs.node2_id.setValue(-1)

    if (this.last_sock2?.isHighlight) {
      this.last_sock2.isHighlight = false
      this.last_sock2.setCSS()
    }

    const sock2 = ned.findSocket(p2[0], p2[1])

    if (sock2 === undefined) {
      return
    }

    this.last_sock2 = sock2
    sock2.updateSocketRef()

    let ok = sock2.socket !== sock1 && sock2.socket!.node !== sock1.node
    ok = ok && sock2.socket!.socketType !== sock1.socketType

    if (ok) {
      this.inputs.sock2_id.setValue(sock2.socket!.graph_id)
      this.inputs.node2_id.setValue(sock2.socket!.node.graph_id)

      sock2.isHighlight = true
      sock2.setCSS()
    }
  }

  modalStart(ctx: ViewContext) {
    const ret = super.modalStart(ctx)

    this.execPre(ctx)
    return ret
  }

  modalEnd(cancelled: boolean): void {
    const ctx = this.modal_ctx!
    super.modalEnd(cancelled)

    if (!cancelled) {
      this.exec(ctx)
      this.getNodeEditor(ctx)?.rebuildAll()
      window.redraw_viewport()
    }
  }

  on_pointerup(e: PointerEvent): void {
    this.modalEnd(e.button != 0)
  }

  execPre(ctx: ToolContext): void {
    super.execPre(ctx)

    const graph = this.fetchGraph(ctx)
    if (!graph) {
      return
    }
    const remsock = graph.sock_idmap.get(this.inputs.disconnectSockID.getValue())

    if (remsock !== undefined) {
      remsock.disconnect()
      graph.signalUI()
    }
  }

  exec(ctx: ToolContext): void {
    const graph = this.fetchGraph(ctx)
    if (!graph) {
      return
    }

    const node1 = graph.node_idmap.get(this.inputs.node1_id.getValue())
    const sock1 = graph.sock_idmap.get(this.inputs.sock1_id.getValue())
    const node2 = graph.node_idmap.get(this.inputs.node2_id.getValue())
    const sock2 = graph.sock_idmap.get(this.inputs.sock2_id.getValue())

    if (!node1 || !sock1 || !node2 || !sock2) {
      // eslint-disable-next-line no-console
      console.log(this)
      // eslint-disable-next-line no-console
      console.warn('Error in node connect op')
      return
    }

    if (node1 === node2 || sock1 === sock2 || sock1.socketType === sock2.socketType) {
      // eslint-disable-next-line no-console
      console.log(this)
      // eslint-disable-next-line no-console
      console.warn('Error in node connect op: bad arguments')
      return
    }

    if (sock1.hasEdges && !(sock1.graph_flag & SocketFlags.MULTI)) {
      sock1.disconnect()
    }
    if (sock2.hasEdges && !(sock2.graph_flag & SocketFlags.MULTI)) {
      sock2.disconnect()
    }

    sock1.connect(sock2)
    graph.signalUI()
  }

  undo(ctx: ToolContext): void {
    super.undo(ctx)

    const graph = this.fetchGraph(ctx)
    if (graph !== undefined) {
      graph.signalUI()
    }
  }
}

ToolOp.register(ConnectNodeOp)

/** Remove every selected node from the graph. */
export class DeleteNodeOp extends NodeGraphOp {
  static tooldef() {
    return {
      uiname  : 'Delete Node',
      toolpath: 'node.delete_selected',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext): void {
    const graph = this.fetchGraph(ctx)

    if (!graph) {
      return
    }

    for (const node of new Set(graph.nodes.selected.editable)) {
      graph.remove(node)
    }

    graph.signalUI()
  }
}

ToolOp.register(DeleteNodeOp)
