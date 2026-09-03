/**
 Graph classes (perhaps 'class' is a bad word choice) are
 classes of node graphs.  Nodes within the class belong to "categories"
 and are registered with the class.  Right now the shader node system
 uses this to keep track of shader node types.
 */

import {Node, INodeConstructor} from './graph'
import {DataAPI} from '../path.ux/scripts/pathux'

export const GraphTypes = [] as (typeof AbstractGraphClass)[]
export const GraphMap = {} as Record<string, typeof AbstractGraphClass>

export function api_define_graphclasses(api: DataAPI) {
  for (const cls of GraphTypes) {
    cls.buildAPI(api)
  }
}

interface GraphClassDef {
  typeName: string
  uiName: string
  graph_flag: number
}

export interface GraphClsNodeConstructor extends INodeConstructor<any, any, any> {
  new (): Node
}

export class AbstractGraphClass {
  static graphdef(): GraphClassDef {
    return {
      typeName  : '',
      uiName    : '',
      graph_flag: 0,
    }
  }

  static NodeTypes = [] as GraphClsNodeConstructor[]

  static buildAPI(api: DataAPI) {
    for (const cls of this.NodeTypes) {
      if (!api.hasStruct(cls)) {
        const nstruct = api.mapStruct(cls, true)
        cls.defineAPI(api, nstruct)
      }
    }
  }

  /** register an abstract graph class, don't subclass this*/
  static registerClass(cls: typeof AbstractGraphClass) {
    GraphTypes.push(cls)
    GraphMap[cls.graphdef().typeName] = cls
  }

  static getGraphClass(name: string) {
    if (!(name in GraphMap)) {
      // eslint-disable-next-line no-console
      console.warn(GraphMap)
      throw new Error('invalid graph class ' + name)
    }
    return GraphMap[name]
  }

  static create(cls_name: string | GraphClsNodeConstructor) {
    if (typeof cls_name != 'string') {
      return new cls_name()
    }

    for (const cls of this.NodeTypes) {
      if (cls.name === cls_name) {
        return new cls()
      }
    }
  }
  /** add a node class to this type */
  static register(cls: GraphClsNodeConstructor) {
    this.NodeTypes.push(cls)
  }
}
/** Always instantiate this for each subclass*/
/** @type {any[]} */
AbstractGraphClass.NodeTypes = []
