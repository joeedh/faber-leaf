import {Vector2} from '../../util/vectormath.js'
import {Node, Graph, type NodeSocketType, INodeUI} from '../../core/graph.js'

export type AnyGraph = Graph<unknown>
export type SocketType = NodeSocketType
/** an array that also carries `.highlight` = the currently hover-highlighted element */
export type HighlightArray<T> = T[] & {highlight?: T}

/* loose view of the object returned by layoutNode() (graph_spatial.js, untyped) */
export interface NodeLayout {
  pos: Vector2
  size: Vector2
  socksize: number
  inputs: {[k: string]: number[]}
  outputs: {[k: string]: number[]}
}

export type UINode = Node & INodeUI

/** flags for NodeEditorBase */
export enum NodeRecalcFlags {
  UI = 1,
  REBUILD = 2,
}
