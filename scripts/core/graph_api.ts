import {DataAPI, DataStruct} from '../path.ux'
import type {ViewContext} from '../core/context.js'
import {Graph, Node} from './graph.js'

export type MyDataAPI = DataAPI<ViewContext>

export function api_define_graph(graphSt: DataStruct, validStructs?: DataStruct<ViewContext>[]): DataStruct {
  const listDef = graphSt.list<Graph<any, any>, number, string>('', 'nodes', [
    function getIter(api: MyDataAPI, list: any) {
      return list.nodes.values()
    },
    function getLength(api: MyDataAPI, list: any) {
      return list.nodes.length
    },
    function get(api: MyDataAPI, list: any, key: string) {
      return list.node_idmap.get(key)
    },
    function getKey(api: MyDataAPI, list: any, obj: any) {
      return '' + obj.graph_id
    },
    function getActive(api: MyDataAPI, list: any) {
      return list.nodes.active
    },
    function setActive(api: MyDataAPI, list: any, key: string) {
      list.nodes.active = list.node_idmap.get(key)
    },
    function getStruct(api: MyDataAPI, list: any, key: string) {
      const obj = list.node_idmap.get(key)

      if (obj === undefined) return api.getStruct(Node)

      const ret = api.getStruct(obj.constructor)
      return ret === undefined ? api.getStruct(Node) : ret
    },
  ])
  listDef.validStructs = validStructs ?? []

  return graphSt
}
