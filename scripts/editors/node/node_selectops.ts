import {Node, NodeFlags} from '../../core/graph.js'
import {
  IntProperty,
  EnumProperty,
  ToolOp,
  type ToolDef,
  PropertySlots,
  StringProperty,
} from '../../path.ux/scripts/pathux.js'
import {NodeGraphOp} from './node_ops.js'
import {SelToolModes, SelOneToolModes} from '../../core/select_types.js'
import type {ToolContext, ViewContext} from '../../core/context'
import {NodeEditorBase} from './NodeEditor.js'
import {Editor} from '../editor_base.js'

/**
 * Base for node selection ops. Its undo snapshots both the per-node selection
 * state *and* the node array order (some select ops reorder nodes — see
 * NodeSelectOneOp.pushToFront), restoring both on undo.
 */
export class NodeSelectOpBase<
  InputSet extends PropertySlots = {},
  OutputSet extends PropertySlots = {},
  NODE_EDITOR extends NodeEditorBase = NodeEditorBase,
> extends NodeGraphOp<InputSet & {nodeEditorPath: StringProperty}, OutputSet, NODE_EDITOR> {
  static tooldef(): ToolDef {
    return {
      inputs: {},
    }
  }

  undoPre(ctx: ToolContext): void {
    const graph = this.fetchGraph(ctx)

    if (graph === undefined) {
      return
    }

    const ud = (this._undo = {
      sel  : {} as {[graph_id: number]: number},
      order: {} as {[graph_id: number]: number},
    })

    const sel = ud.sel,
      order = ud.order

    let i = 0
    for (const node of graph.nodes) {
      sel[node.graph_id] = node.graph_flag & NodeFlags.SELECT
      order[node.graph_id] = i++
    }
  }

  undo(ctx: ToolContext): void {
    const ud = this._undo!
    const sel = ud.sel!,
      order = ud.order!
    const graph = this.fetchGraph(ctx)!

    for (const k in sel) {
      const state = sel[k as unknown as number]
      const node = graph.node_idmap.get(k as unknown as number)

      if (node === undefined) {
        console.warn('Warning: missing node ' + k + ' in graph ' + this.inputs.graphPath.getValue())
        continue
      }

      graph.nodes.setSelect(node, !!state)
    }

    //restore original node order, which can be changed by some selection ops
    //this is distinct from the calculated toplogical sort order

    const nodes = graph.nodes.slice(0, graph.nodes.length)
    const donemap: {[graph_id: number]: number} = {}

    const nodeList = graph.nodes as unknown as (Node | undefined)[]
    for (let i = 0; i < nodes.length; i++) {
      nodeList[i] = undefined
    }

    for (const k in order) {
      const node = graph.node_idmap.get(k as unknown as number)
      const i = order[k as unknown as number]

      if (node === undefined) {
        console.warn('Warning: missing node ' + k + ' in graph ' + this.inputs.graphPath.getValue())
        continue
      }

      donemap[k as unknown as number] = 1
      nodeList[i] = node
    }

    //do a sanity check that we've re-added all nodes
    for (const node of nodes) {
      if (!(node.graph_id in donemap)) {
        console.warn('orphan node found in node_selectops.NodeSelectOpBase.prototype.undo')
        for (let i = 0; i < nodes.length; i++) {
          if (nodeList[i] === undefined) {
            nodeList[i] = node
          }
        }
      }
    }

    graph.signalUI()
  }
}

/**
 * Select one node by id (UNIQUE/ADD/SUB). Also moves it to the front of the
 * node list — shader networks treat the first output node as the active one, so
 * this is how clicking a node previews its sub-network.
 */
export class NodeSelectOneOp extends NodeSelectOpBase<{nodeId: IntProperty; mode: EnumProperty}> {
  static tooldef(): ToolDef {
    return {
      toolpath: 'node.selectone',
      inputs: {
        nodeId: new IntProperty(),
        mode  : new EnumProperty('UNIQUE', SelOneToolModes),
      },
    }
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>): NodeSelectOneOp {
    const tool = super.invoke(ctx, args) as NodeSelectOneOp

    if ('nodeId' in args) {
      tool.inputs.nodeId.setValue(args.nodeId as number)
    }

    if ('mode' in args) {
      tool.inputs.mode.setValue(args.mode as number)
    }

    return tool
  }

  exec(ctx: ToolContext): void {
    const mode = this.inputs.mode.getValue()
    const graph = this.fetchGraph(ctx)

    if (graph === undefined) {
      console.warn('error in node_selectops.NodeSelectOneOp')
      return
    }

    console.log('mode', mode)

    const node = graph.node_idmap.get(this.inputs.nodeId.getValue())
    if (node === undefined) {
      return
    }

    if (mode == SelOneToolModes.UNIQUE) {
      for (const node2 of graph.nodes) {
        graph.nodes.setSelect(node2, false)
      }

      graph.nodes.setSelect(node, true)
    } else {
      const state = this.inputs.mode.getValue() == SelOneToolModes.ADD

      graph.nodes.setSelect(node, state)
    }

    //change order, shader networks rely on this to
    //tell which output nodes is "active", so user can
    //interactively select different subnetworks to preview in real time
    graph.nodes.pushToFront(node)
  }
}

ToolOp.register(NodeSelectOneOp)

/** Select/deselect all nodes; AUTO deselects if anything is selected, else selects all. */
export class NodeToggleSelectAll extends NodeSelectOpBase<{mode: EnumProperty}> {
  static tooldef(): ToolDef {
    return {
      toolpath: 'node.toggle_select_all',
      inputs: {
        mode: new EnumProperty('AUTO', SelToolModes),
      },
    }
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>): NodeToggleSelectAll {
    const tool = super.invoke(ctx, args) as NodeToggleSelectAll

    if ('nodeId' in args) {
      ;(tool.inputs as {nodeId?: IntProperty}).nodeId?.setValue(args.nodeId as number)
    }

    if ('mode' in args) {
      tool.inputs.mode.setValue(args.mode as number)
    }

    return tool
  }

  exec(ctx: ToolContext): void {
    let mode = this.inputs.mode.getValue()
    const graph = this.fetchGraph(ctx)

    console.log('toggle select all', graph)

    if (graph === undefined) {
      console.warn('error in node_selectops.NodeToggleSelectAll')
      return
    }

    if (mode == SelToolModes.AUTO) {
      mode = SelToolModes.ADD

      for (const node of graph.nodes) {
        if (node.graph_flag & NodeFlags.SELECT) {
          mode = SelToolModes.SUB
          break
        }
      }
    }

    console.log('mode', mode)

    for (const node of graph.nodes) {
      graph.nodes.setSelect(node, mode === SelToolModes.ADD)
    }

    graph.signalUI()
  }
}

ToolOp.register(NodeToggleSelectAll)
