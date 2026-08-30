import {Container, DataAPI, DataStruct, ToolProperty, Vector2, nstructjs, util} from '../path.ux/scripts/pathux.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'

import '../util/polyfill.d.ts'
import type {StructReader} from '../path.ux/scripts/util/nstructjs.js'
import type {ViewContext} from './context'
import type {BlockLoader, BlockLoaderAddUser, DataBlock} from './lib_api.js'

export class GraphCycleError extends Error {}

export enum SocketTypes {
  INPUT = 0,
  OUTPUT = 1,
  NONE = -1,
}

export class NodeInheritFlag {
  flag: number
  constructor(flag: number) {
    this.flag = flag
  }
}

/**
 Socket flags

 @example
 export const SocketFlags = {
 SELECT           : 1, //for use by ui
 UPDATE           : 2,
 MULTI            : 4, //socket can have multiple connections, enabled by default for outputs
 NO_MULTI_OUTPUTS : 8  //don't flag outputs with MULTI by default
 };
 */
export enum SocketFlags {
  SELECT = 1, //for use by ui
  UPDATE = 2,
  MULTI = 4, //socket can have multiple connections, enable by default for outputs
  NO_MULTI_OUTPUTS = 8, //don't flag outputs with MULTI by default
  PRIVATE = 16,
  //unused = 32,
  INSTANCE_API_DEFINE = 64,
  NO_UI_EDITING = 128,
}

/**
 Node flags

 @example
 export const NodeFlags = {
 SELECT    : 1,  // for use by ui
 UPDATE    : 2,  // node needs execution
 SORT_TAG  : 4,  // used by internal graph sort
 CYCLE_TAG : 8,  // used by internal graph sort
 DISABLED  : 16, // node is disabled
 ZOMBIE    : 32, // don't save this node, used for UI event handlers and stuff

 //proxy nodes are replaced during saving with a lightwieght proxy,
 //that can be replaced with real object on load.  for dealing with
 //nodes that are saved outside of the Graph data structure.
 SAVE_PROXY     : 64
 };
 */
export enum NodeFlags {
  SELECT = 1 /** for use by ui */,
  UPDATE = 2 /** node needs execution */,
  SORT_TAG = 4 /** used by internal graph sort */,
  CYCLE_TAG = 8 /** used by internal graph sort */,
  DISABLED = 16 /** node is disabled */,
  ZOMBIE = 32 /** don't save this node, used for UI event handlers and stuff */,

  /**proxy nodes are replaced during saving with a lightwieght proxy,
   that can be replaced with real object on load.  for dealing with
   nodes that are saved outside of the Graph data structure.*/
  SAVE_PROXY = 64,
  /* @unused */
  FORCE_SOCKET_INHERIT = 128,
  /* @unused */
  FORCE_FLAG_INHERIT = 256,
  /* @unused */
  FORCE_INHERIT = 128 | 256,
}

/**
 Graph flags

 @example
 export const GraphFlags = {
 SELECT : 1, //for use by ui
 RESORT : 2,
 CYCLIC_ALLOWED : 4, //graph may have cycles, set by user
 CYCLIC : 8 //graph has cycles, is set in graph.sort()
 };
 */
export enum GraphFlags {
  SELECT = 1, //for use by ui
  RESORT = 2,
  CYCLIC_ALLOWED = 4, //graph may have cycles, set by user
  CYCLIC = 8, //graph has cycles, is set in graph.sort()
}

export const NodeSocketClasses = [] as (typeof NodeSocketType)[]

export interface INodeSocketDef {
  name: string
  uiname?: string
  flag?: number
  color?: number[]
}

export interface INodeDef<InputSet extends {} = {}, OutputSet extends {} = {}> {
  name: string
  uiname?: string
  flag?: any
  inputs: InputSet
  outputs: OutputSet
}

export interface INodeConstructor<
  NodeType extends Node<InputSet, OutputSet>,
  InputSet extends INodeSocketSet = {},
  OutputSet extends INodeSocketSet = {},
> {
  new (): NodeType

  nodedef(): INodeDef<InputSet, OutputSet>
  getFinalNodeDef?(): INodeDef<InputSet, OutputSet>
}

export interface ISocketConstructor {
  new (): NodeSocketType

  nodedef(): INodeSocketDef
}

export function nodeSocket_api_uiname(this: any) {
  return this.dataref.uiname
}

export abstract class NodeSocketType<ValueType = any> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
graph.NodeSocketType {
  graph_id   : int;
  node       : int | this.node !== undefined ? this.node.graph_id : -1;
  edges      : array(e, int) | e.graph_id;
  uiname     : string;
  name       : string;
  socketName : string;
  graph_flag : int;
  socketType : int;
}`
  )

  _old?: ValueType
  uiname: string
  name: string
  graph_flag: number
  graph_id: number
  socketName: string
  socketType: SocketTypes
  edges: this[]
  node: GenericNode<any>;

  // @ts-ignore
  ['constructor']?: ISocketConstructor

  constructor(uiname?: string, flag = 0) {
    if (uiname === undefined) {
      uiname = this.constructor!.nodedef().uiname
    }
    if (uiname === undefined) {
      uiname = ToolProperty.makeUIName(this.constructor!.nodedef().name)
    }

    //XXX shouldn't this be this.graph_uiname?
    this.uiname = uiname

    const def = this.constructor!.nodedef()

    //TODO: should this be typeName?
    this.name = def.name

    if (def.flag !== undefined) {
      flag |= def.flag
    }

    if (!def.name || typeof def.name !== 'string') {
      throw new Error('nodedef must have a .name member')
    }

    this.socketName = ''
    this.socketType = SocketTypes.NONE
    this.edges = []
    // is assigned later
    this.node = undefined as unknown as Node
    this.graph_flag = flag
    this.graph_id = -1
  }

  get hasEdges() {
    return this.edges.length > 0
  }

  static defineAPI(api: DataAPI, sockstruct: DataStruct) {}

  //used to load data that might change between file versions

  static register(cls: any) {
    NodeSocketClasses.push(cls)
  }

  /**
   Callback for defining socket types.
   Child classes must implement this.

   @example
   static nodedef() { return {
   name   : "name",
   uiname : "uiname",
   color  : [0.5, 0.5, 0.5, 1.0],
   flag   : 0 //see SocketFlags
   }}

   */
  static nodedef(): INodeSocketDef {
    return {
      name  : 'name',
      uiname: 'uiname',
      color : undefined,
      flag  : 0,
    }
  }

  graphDestory(): void {}

  graphDataLink(ownerBlock: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser): void {}

  //e.g. EnumProperty's enumeration definitions
  onFileLoad(templateInstance: any) {
    this.graph_flag |= templateInstance.graph_flag
  }

  needInstanceAPI() {
    this.graph_flag |= SocketFlags.INSTANCE_API_DEFINE
    return this
  }

  /*
  get node() {
    return this._node;
  }

  set node(node) {
    if (!node) {
      console.warn("setting node", this.name, this);
    }

    this._node = node;
  }*/

  noUnits() {
    // eslint-disable-next-line no-console
    console.warn('Deprecated call to NodeSocketType.prototype.noUnits()')
    return this
  }

  setAndUpdate(val: ValueType, updateParentNode = false) {
    this.setValue(val)
    this.graphUpdate(updateParentNode)

    return this
  }

  has(node_or_socket: GenericNode<any> | this) {
    for (const socket of this.edges) {
      if (socket === node_or_socket) return true
      if (socket.node === node_or_socket) return true
    }

    return false
  }

  /**
   Build ui for a node socket.

   Note that container has a data path prefix applied to it,
   so anything in container.prop that takes a datapath (e.g. container.prop)

   will have its path evaluated *relative to the node itself*,
   NOT Context as usual.
   */
  buildUI(container: Container<ViewContext>, onchange?: () => void) {
    if (this.edges.length === 0 && !(this.graph_flag & SocketFlags.NO_UI_EDITING)) {
      const ret = container.prop('value')

      if (ret) {
        ret.setAttribute('name', this.uiname)
        ret.on_change = onchange ?? null
      } else {
        container.label(this.uiname)
      }
    } else {
      container.label(this.uiname)
    }
  }

  copyValue(): ValueType {
    throw new Error('implement me')
  }

  cmpValue(b: ValueType): number {
    throw new Error('implement me')
  }

  //return float value representing difference with value b
  diffValue(b: ValueType): number {
    throw new Error('implement me')
  }

  connect(sock: this) {
    if (this.edges.includes(sock)) {
      // eslint-disable-next-line no-console
      console.warn('Already have socket connected')
      return
    }

    for (const s of this.edges) {
      if (s.node === sock.node && s.name === sock.name) {
        // eslint-disable-next-line no-console
        console.warn('Possible duplicate socket add', s, sock)
      }
    }

    this.edges.push(sock)
    sock.edges.push(this)

    if (!sock.node) {
      // eslint-disable-next-line no-console
      console.warn('graph corruption')
    } else {
      sock.node.graphUpdate()
    }

    if (!this.node) {
      // eslint-disable-next-line no-console
      console.warn('graph corruption')
    } else {
      this.node.graphUpdate()
      this.node.graph_graph?.flagResort()
    }

    return this
  }

  //for the sake of sane, performant code,
  //this is allowed to return a reference, but client
  //code is *only allowed to modify that reference's data

  disconnect(sock?: this) {
    if (sock === undefined) {
      let _i = 0

      while (this.edges.length > 0) {
        if (_i++ > 10000) {
          // eslint-disable-next-line no-console
          console.warn('infinite loop detected in graph code')
          break
        }

        this.disconnect(this.edges[0])
      }

      return
    }

    this.edges.remove(sock, true)
    sock.edges.remove(this, true)

    this.node.graphUpdate()
    sock.node.graphUpdate()
    this.node.graph_graph?.flagResort()

    return this
  }

  //inside of the owning Node class's exec method*
  abstract getValue(): ValueType

  abstract setValue(value: ValueType): void

  copyTo(b: this) {
    b.graph_flag = this.graph_flag
    b.name = this.name
    b.uiname = this.uiname
    b.socketName = this.socketName
    b.socketType = this.socketType
    //b.node = this.node;
  }

  copyFrom(b: this): this {
    b.copyTo(this)
    return this
  }

  /*
  flag the socket as updated and immediately
  execute the data graph
  */
  immediateUpdate() {
    this.graphUpdate()

    if (this.edges.length > 0) {
      window.updateDataGraph(true)
    }
  }

  update() {
    // eslint-disable-next-line no-console
    console.warn('NodeSocketType.prototype.update() is deprecated; use .graphUpdate instead')
    return this.graphUpdate()
  }

  /*
  flag the socket as updated and queue
  the datagraph for execution
  */
  graphUpdate(updateParentNode = false, _exclude?: NodeSocketType) {
    if (this.graph_id === -1) {
      //we're not in a graph
      // eslint-disable-next-line no-console
      console.warn('graphUpdate called on non-node', this)
      return
    }

    if (this === _exclude) return

    this.graph_flag |= NodeFlags.UPDATE

    if (updateParentNode) {
      this.node.graphUpdate()
    }

    //make sure a graph update is queued up
    //only one update will be queued at a time
    //via setTimeout
    window.updateDataGraph()

    for (const sock of this.edges) {
      sock.setValue(this.getValue())

      if (sock.node) sock.node.graphUpdate()
    }

    return this
  }

  copy(): this {
    const ret = new (this.constructor as unknown as new () => this)()

    this.copyTo(ret)
    ret.graph_flag = this.graph_flag

    return ret
  }

  loadSTRUCT(reader: StructReader<this>) {
    reader(this)
  }
}

export class KeyValPair<Value extends {} = {}> {
  key: string
  val: Value

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
graph.KeyValPair {
  key : string;
  val : abstract(Object);
}
`
  )

  constructor(key: string, val: Value) {
    this.key = key
    this.val = val
  }
}

export interface INodeSocketSet {
  [k: string]: NodeSocketType
}

/** Some node subclasses (e.g. ShaderNode) add these; the base graph Node does not. */
export interface INodeUI {
  uiname?: string
  buildUI?: (container: Container<ViewContext>) => void
}

/**
 Base class for all nodes
 It's required to implement the nodedef() static
 method in child classes.
 */
export class Node<
  InputSet extends INodeSocketSet = INodeSocketSet,
  OutputSet extends INodeSocketSet = INodeSocketSet,
  ExecContextType = any,
> {
  inputs: InputSet
  outputs: OutputSet
  graph_uiname: string
  graph_name: string
  graph_flag: number
  graph_ui_pos: Vector2
  graph_ui_size: Vector2
  graph_ui_flag: number
  graph_id: number
  graph_graph?: Graph<any, any>
  icon: number = -1

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
graph.Node {
  graph_name    : string;
  graph_uiname  : string;
  graph_id      : int;
  graph_flag    : int;
  inputs        : array(graph.KeyValPair) | obj._save_map(obj.inputs);
  outputs       : array(graph.KeyValPair) | obj._save_map(obj.outputs);
  graph_ui_pos  : vec2;
  graph_ui_size : vec2;
  graph_ui_flag : int;
}
`
  );

  /* @ts-ignore */
  ['constructor']: INodeConstructor<this, InputSet, OutputSet> | undefined

  static inheritFlag(flag: number) {
    return new NodeInheritFlag(flag)
  }

  /**
   * The point of this method is to perform
   * socket inheritance (which is now required) in
   * a way friendly to TS's type inference.
   *
   * Note: the TS types are set up to force us to do
   * something like this
   */
  static merge<
    I1 extends INodeSocketSet,
    O1 extends INodeSocketSet,
    I2 extends INodeSocketSet, //
    O2 extends INodeSocketSet, //
    D extends INodeDef<I1, O1>,
    P extends INodeDef<I2, O2>,
  >(def: D, parentDef: P) {
    const inputs1 = def.inputs ?? parentDef.inputs
    const outputs1 = def.outputs ?? parentDef.outputs
    const inputs2 = parentDef.inputs ?? {}
    const outputs2 = parentDef.outputs ?? {}

    return {
      ...def,
      inputs : {...inputs1, ...inputs2} as I1 & I2,
      outputs: {...outputs1, ...outputs2} as O1 & O2,
    } as const
  }
  constructor(flag = 0) {
    const def = this.constructor!.nodedef()

    if (!def.name || typeof def.name !== 'string') {
      throw new Error('nodedef must have a .name member')
    }

    this.graph_uiname = def.uiname || def.name
    this.graph_name = def.name

    this.graph_ui_pos = new Vector2()
    this.graph_ui_size = new Vector2([235, 200])
    this.graph_ui_flag = 0

    this.graph_id = -1
    this.graph_graph = undefined

    const getflag = () => {
      const inherit = true // TS should enforce inheritance

      //walk up class hiearchy andd see if NodeFlags.FORCE_SOCKET_INHERIT
      //is nodedef().flag of any ancestor
      const p = this.constructor as any
      let def2 = def

      if (inherit) {
        let flag = def.flag !== undefined ? def.flag : 0

        let p = this.constructor as any
        while (p !== null && p !== undefined && p !== Object && p !== Node) {
          if (p.nodedef) {
            def2 = p.nodedef()

            if (def2.flag) {
              flag |= def2.flag
            }
          }
          p = p.prototype.__proto__.constructor
        }

        return flag
      } else {
        return def.flag === undefined ? 0 : def.flag
      }
    }

    this.graph_flag = flag | getflag() | NodeFlags.UPDATE

    const getsocks = (key: 'inputs' | 'outputs') => {
      const obj = def[key] as {[k: string]: NodeSocketType}
      const ret = {} as {[k: string]: NodeSocketType}

      let inherit = true
      inherit = inherit || (flag & NodeFlags.FORCE_SOCKET_INHERIT) !== 0

      //walk up class hiearchy andd see if NodeFlags.FORCE_SOCKET_INHERIT
      //is nodedef().flag of any ancestor
      let p = this.constructor as any
      while (p !== null && p !== undefined && p !== Object && p !== Node) {
        if (p.nodedef) {
          const def = p.nodedef()

          inherit = inherit || (def.flag & NodeFlags.FORCE_SOCKET_INHERIT) !== 0
        }
        p = p.prototype.__proto__.constructor
      }

      if (inherit) {
        let p = this.constructor as any

        while (p !== null && p !== undefined && p !== Object && p !== Node) {
          if (p.nodedef === undefined) continue
          const obj2 = p.nodedef()[key]

          if (obj2 !== undefined) {
            for (const k in obj2) {
              const sock2 = obj2[k]

              if (!(k in ret)) {
                ret[k] = sock2.copy()
              }
            }
          }

          p = p.prototype.__proto__.constructor
        }
      } else if (obj !== undefined) {
        for (const k in obj) {
          ret[k] = obj[k].copy()
        }
      }

      for (const k in ret) {
        ret[k].node = this
      }

      return ret
    }

    this.inputs = getsocks('inputs') as InputSet
    this.outputs = getsocks('outputs') as OutputSet

    for (const sock of this.allsockets) {
      ;(sock as NodeSocketType).node = this as unknown as GenericNode<ExecContextType>
    }

    for (let i = 0; i < 2; i++) {
      const socks = i ? this.outputs : this.inputs

      for (const k in socks as unknown as {}) {
        const sock = socks[k] as NodeSocketType

        sock.socketType = i ? SocketTypes.OUTPUT : SocketTypes.INPUT
        sock.node = this as unknown as GenericNode<ExecContextType>
        sock.name = sock.name !== undefined ? sock.name : k
        sock.socketName = k //sock.socketName always corrosponds to socket key

        if (sock.uiname === undefined || sock.uiname === sock.constructor!.nodedef().uiname) {
          sock.uiname = k
        }
      }
    }

    for (const k in this.outputs) {
      const sock = this.outputs[k] as NodeSocketType

      if (!(sock.graph_flag & SocketFlags.NO_MULTI_OUTPUTS)) {
        sock.graph_flag |= SocketFlags.MULTI
      }
    }

    this.icon = -1
  }

  get allsockets(): Iterable<NodeSocketType> {
    const this2 = this
    return (function* () {
      for (const k in this2.inputs) {
        yield this2.inputs[k]
      }
      for (const k in this2.outputs) {
        yield this2.outputs[k]
      }
    })() as unknown as Iterable<NodeSocketType>
  }

  static graphDefineAPI(api: DataAPI, nodeStruct: DataStruct) {}

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const nstruct = struct ?? api.mapStruct(this, true)

    nstruct.flags('graph_flag', 'graph_flag', NodeFlags, 'Graph Flags', 'Flags')
    nstruct.int('graph_id', 'graph_id', 'Graph ID', 'Unique graph ID').readOnly()

    function defineSockets(inorouts: 'inputs' | 'outputs'): void {
      nstruct.list('', inorouts, [
        function getIter(api: DataAPI, list: any) {
          return (function* () {
            for (const k in list[inorouts]) {
              yield list[inorouts][k]
            }
          })()
        },
        function getLength(api: DataAPI, list: any) {
          return Object.keys(list[inorouts]).length
        },
        function get(api: DataAPI, list: any, key: string) {
          return list[inorouts][key]
        },
        function getKey(api: DataAPI, list: any, obj: any) {
          for (const k in list[inorouts]) {
            if (list[inorouts][k] === obj) return k
          }
        },
        function getStruct(api: DataAPI, list: any, key: string) {
          const obj = list[inorouts][key]

          if (obj === undefined) return api.getStruct(NodeSocketType)

          let ret

          if (obj.graph_flag & SocketFlags.INSTANCE_API_DEFINE) {
            if (!api.hasStruct(obj)) {
              ret = api.mapStruct(obj, true)
              obj.defineInstanceAPI(api, ret)
            } else {
              ret = api.getStruct(obj)
            }
          } else {
            ret = api.getStruct(obj.constructor)
          }

          return ret === undefined ? api.getStruct(NodeSocketType) : ret
        },
      ])
    }

    defineSockets('inputs')
    defineSockets('outputs')

    return nstruct
  }

  /** get final node def with inheritance applied to input/output sockets
   *
   * @returns {{} & {name, uiname, flag, inputs, outputs}}
   */
  static getFinalNodeDef(): INodeDef<any, any> {
    const def = this.nodedef()

    //I'm a little nervous about using Object.create,
    //dunno if I'm just being paranoid
    const def2 = Object.assign({}, def)

    interface NodeProto extends INodeConstructor<any, INodeSocketSet, INodeSocketSet> {
      __proto__?: NodeProto
    }

    const getsocks = (key: 'inputs' | 'outputs') => {
      const obj = def[key]
      const ret = {} as INodeSocketSet

      let p = this as unknown as NodeProto

      while (p !== null && p !== undefined && (p as any) !== Object && p !== Node) {
        if (p.nodedef === undefined) continue
        const obj2 = p.nodedef()[key]

        if (obj2) {
          for (const k in obj2) {
            if (!(k in ret)) {
              ret[k] = (obj2 as INodeSocketSet)[k]
            }
          }
        }

        p = p.prototype.__proto__.constructor
      }

      return ret
    }

    def2.inputs = getsocks('inputs')
    def2.outputs = getsocks('outputs')

    return def2
  }

  /**
   Type information for node, child classes
   must subtype this.  To inherit sockets,
   wrap inputs and/or outputs in Node.inherit, see example

   @example

   static nodedef() {return {
   name   : "name",
   uiname : "uiname",
   flag   : 0,  //see NodeFlags
   inputs : {
    input1 : new FloatSocket()
   }

   outputs : {
    output1 : new FloatSocket()
   }
   }}
   */
  static nodedef(): INodeDef<{}, {}> {
    return {
      name   : 'name',
      uiname : 'uiname',
      flag   : 0,
      inputs : {}, //can inherit from parent class by wrapping in Node.inherit({})
      outputs: {},
    }
  }

  graphDataLink(ownerBlock: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {}

  copyTo(b: this): void {
    b.graph_name = this.graph_name
    b.graph_uiname = this.graph_uiname
    b.icon = this.icon
    b.graph_flag = this.graph_flag

    for (let i = 0; i < 2; i++) {
      const sockets1 = i ? this.outputs : this.inputs
      const sockets2 = i ? b.outputs : b.inputs

      for (const k in sockets1 as unknown as {}) {
        const sock1 = sockets1[k]

        if (!(k in (sockets2 as unknown as {}))) {
          ;(sockets2[k] as any) = sock1.copy()
        }

        const sock2 = sockets2[k]
        sock2.node = b as unknown as GenericNode<ExecContextType>

        sock2.setValue(sock1.getValue())
      }
    }
  }

  copy(addLibUsers = false, libOwner?: DataBlock): this {
    const ret = new this.constructor!()
    this.copyTo(ret as this)

    return ret as unknown as this
  }

  /**state is provided by client code, it's the argument to Graph.prototype.exec()
   *exec should call update on output sockets itself
   *DO NOT call super() unless you want to send an update signal to all
   *output sockets
   */
  exec(state: ExecContextType): void {
    //default implementation simply flags all output sockets
    for (const k in this.outputs) {
      ;(this.outputs[k] as unknown as NodeSocketType).graphUpdate()
    }
  }

  update(): this {
    this.graphUpdate()
    // eslint-disable-next-line no-console
    console.warn('deprecated call to graph.Node.prototype.update(); use graphUpdate instead')

    //this.graph_flag |= NodeFlags.UPDATE;
    return this
  }

  graphDestroy(): void {}

  graphUpdate(): this {
    this.graph_flag |= NodeFlags.UPDATE
    return this
  }

  afterSTRUCT() {}

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    if (Array.isArray(this.inputs)) {
      const ins = {} as any

      for (const pair of this.inputs) {
        ins[pair.key] = pair.val

        pair.val.socketType = SocketTypes.INPUT
        pair.val.socketName = pair.key
        pair.val.node = this
      }

      ;(this.inputs as unknown as {}) = ins
    }

    if (Array.isArray(this.outputs)) {
      const outs = {} as any

      for (const pair of this.outputs) {
        outs[pair.key] = pair.val

        pair.val.socketType = SocketTypes.OUTPUT
        pair.val.socketName = pair.key
        pair.val.node = this
      }

      ;(this.outputs as unknown as {}) = outs
    }

    /*deal with any changes in sockets across file versions*/
    const def = this.constructor!.getFinalNodeDef!()

    for (let i = 0; i < 2; i++) {
      const socks1 = (i ? this.outputs : this.inputs) as INodeSocketSet
      const socks2 = (i ? def.outputs : def.inputs) as INodeSocketSet

      for (const k in socks2) {
        //there's a new socket?
        if (!(k in socks1)) {
          socks1[k] = socks2[k].copy()
          socks1[k].graph_id = -1 //flag that we are a new socket
        }
      }

      for (const k in socks1) {
        //does the socket exist in this version?
        //note that this can happend with nodes with dynamic sockets,
        //which is why we don't delete s1 in this case
        if (!(k in socks2)) {
          continue
        }

        const s1 = socks1[k]
        let s2 = socks2[k]

        if (s1.constructor !== s2.constructor) {
          //our types differ?
          if (s2 instanceof s1.constructor! || s1 instanceof (s2 as NodeSocketType).constructor!) {
            //easy case, the old file uses a parent class of a new one,
            //e.g. Vec4Socket was changed to RGBASocket
            s2 = s2.copy()
            s1.copyTo(s2)

            s2.edges = s1.edges
            s2.node = this
            s2.graph_id = s1.graph_id
            socks1[k] = s2
          }
        }

        socks1[k].node = this as unknown as GenericNode<ExecContextType>
      }
    }

    //load any template data that needs loading
    for (let i = 0; i < 2; i++) {
      const socks1 = (i ? this.outputs : this.inputs) as INodeSocketSet
      const socks2 = (i ? def.outputs : def.inputs) as INodeSocketSet

      for (const k in socks1 as unknown as {}) {
        const sock = socks1[k]

        //ensure socketName is corret
        if (!sock.socketName) {
          sock.socketName = k
        }

        if (!(k in (socks2 as unknown as {}))) {
          continue
        }

        sock.onFileLoad(socks2[k])
      }
    }
  }

  graphDisplayName() {
    return this.constructor!.name + this.graph_id
  }

  _save_map(map: INodeSocketSet) {
    const ret = [] as KeyValPair[]

    for (const k in map) {
      ret.push(new KeyValPair(k, map[k]))
    }

    return ret
  }
}

/*proxy nodes are stand-ins for nodes that are
  saved/loaded from outside the Graph data structure
 */
export class ProxyNode<InputSet extends INodeSocketSet, OutputSet extends INodeSocketSet> extends Node<
  InputSet,
  OutputSet
> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
graph.ProxyNode {
  className : string; 
}`
  )

  className: string

  constructor() {
    super()

    this.className = ''
  }

  static fromNode(node: Node) {
    const ret = new ProxyNode()

    ret.graph_id = node.graph_id

    for (let i = 0; i < 2; i++) {
      const socks1 = i ? node.outputs : node.inputs
      const socks2 = i ? ret.outputs : ret.inputs

      for (const k in socks1) {
        const s1 = socks1[k]
        const s2 = s1.copy()

        s2.graph_id = s1.graph_id
        for (const e of s1.edges) {
          s2.edges.push(e)
        }

        socks2[k] = s2
        s2.node = ret
      }
    }

    return ret
  }

  nodedef() {
    return {
      inputs : {},
      outputs: {},
      flag   : NodeFlags.SAVE_PROXY,
    }
  }
}

/**
 * Placeholder for a Node subclass whose addon isn't loaded (its class isn't
 * registered with nstructjs). The nstructjs `onUnknownClass` hook returns this
 * class and walks the *file* schema, so the node's data + live links survive in
 * the graph; `onSerializeUnknown` re-emits it under `_origClsname` on the next
 * save. Intentionally has NO `static STRUCT` and is NOT in any node registry —
 * see scripts/core/missing_addon.ts and documentation/plans/fixGraphMissingNodes.md.
 */
export class MissingNode extends Node<any, any> {
  /** Original struct name; also set dynamically by nstructjs on read. */
  _origClsname: string = ''

  static nodedef(): INodeDef<{}, {}> {
    return {name: 'MissingNode', uiname: 'Missing (Addon Disabled)', flag: 0, inputs: {}, outputs: {}}
  }

  /**
   * Only the inputs/outputs array→map conversion that base Node.loadSTRUCT does;
   * skips the version-patching block (it calls getFinalNodeDef() against a def
   * that doesn't exist here). Keeping the conversion is essential so `allsockets`
   * yields the loaded sockets into `sock_idmap` during Graph.loadSTRUCT.
   */
  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    if (Array.isArray(this.inputs)) {
      const ins = {} as any
      for (const pair of this.inputs as unknown as KeyValPair<NodeSocketType>[]) {
        ins[pair.key] = pair.val
        pair.val.socketType = SocketTypes.INPUT
        pair.val.socketName = pair.key
        pair.val.node = this as unknown as GenericNode<any>
      }
      ;(this.inputs as unknown as {}) = ins
    }

    if (Array.isArray(this.outputs)) {
      const outs = {} as any
      for (const pair of this.outputs as unknown as KeyValPair<NodeSocketType>[]) {
        outs[pair.key] = pair.val
        pair.val.socketType = SocketTypes.OUTPUT
        pair.val.socketName = pair.key
        pair.val.node = this as unknown as GenericNode<any>
      }
      ;(this.outputs as unknown as {}) = outs
    }
  }
}

/**
 * Placeholder for a NodeSocketType subclass whose addon isn't loaded. Stores the
 * socket's loaded value opaquely so edges to/from known nodes relink. See
 * MissingNode and scripts/core/missing_addon.ts.
 */
export class MissingNodeSocket extends NodeSocketType<any> {
  _origClsname: string = ''
  _value: any = undefined

  static nodedef(): INodeSocketDef {
    return {name: 'MissingNodeSocket', uiname: 'Missing (Addon Disabled)', flag: 0}
  }

  getValue(): any {
    return this._value
  }

  setValue(value: any): void {
    this._value = value
  }

  // Inert to the cyclic solver: never compares unequal, never reports a diff.
  copyValue(): any {
    return this._value
  }

  cmpValue(_b: any): number {
    return 0
  }

  diffValue(_b: any): number {
    return 0
  }
}

export class CallbackNode<
  InputSet extends INodeSocketSet = any,
  OutputSet extends INodeSocketSet = any,
  ExecContextType = ViewContext,
> extends Node<InputSet, OutputSet, ExecContextType> {
  callback?: (ctx: ExecContextType, node: this) => void

  name = '(unnamed)'
  _key = ''

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
graph.CallbackNode {
}`
  )

  constructor() {
    super()

    this.callback = undefined
    this.graph_flag |= NodeFlags.ZOMBIE
  }

  static nodedef() {
    return {
      name   : 'callback node',
      inputs : {},
      outputs: {},
      flag   : NodeFlags.ZOMBIE,
    }
  }

  static create<InputSet extends INodeSocketSet, OutputSet extends INodeSocketSet, ExecContextType = any>(
    name: string,
    callback: (ctx: ExecContextType, node: CallbackNode<InputSet, OutputSet, ExecContextType>) => void,
    inputs: InputSet,
    outputs: OutputSet
  ) {
    const ret = new CallbackNode<InputSet, OutputSet, ExecContextType>()

    if (inputs === undefined) {
      ;(inputs as unknown as {}) = {}
    }
    if (outputs === undefined) {
      ;(outputs as unknown as {}) = {}
    }

    ret.name = name
    ret.callback = callback

    ret.inputs = inputs
    ret.outputs = outputs

    for (const k in inputs) {
      if (typeof k === 'string') {
        ;((ret.inputs as unknown as any)[k] as NodeSocketType).node = ret as unknown as GenericNode<ExecContextType>
      }
    }

    for (const k in outputs) {
      if (typeof k === 'string') {
        ;((ret.outputs as unknown as any)[k] as NodeSocketType).node = ret as unknown as GenericNode<ExecContextType>
      }
    }

    return ret
  }

  exec(ctx: ExecContextType) {
    if (this.callback !== undefined) {
      this.callback(ctx, this)
    }
  }

  graphDisplayName() {
    return this.constructor!.name + '(' + this.name + ')' + this.graph_id
  }
}

export type GenericNode<ExecContextType> = Node<INodeSocketSet, INodeSocketSet, ExecContextType>

export class NodeSelectedSet<
  ExecContextType,
  NodeBase extends Node = GenericNode<ExecContextType>,
> extends Set<NodeBase> {
  /* We don't support hidden nodes yet, for
   * now just return this set.
   */
  get editable(): Iterable<GenericNode<ExecContextType>> {
    return this
  }
}

export class GraphNodes<ExecContextType, NodeBase extends Node = GenericNode<ExecContextType>> extends Array<NodeBase> {
  graph: Graph<ExecContextType, NodeBase>
  active?: NodeBase
  highlight?: NodeBase
  selected: NodeSelectedSet<ExecContextType, NodeBase>

  constructor(graph: Graph<ExecContextType, NodeBase>, list?: Iterable<NodeBase>) {
    super()
    this.graph = graph
    this.selected = new NodeSelectedSet()

    if (list !== undefined) {
      for (const l of list) {
        this.push(l)
      }
    }

    this.active = undefined
    this.highlight = undefined
  }

  replace(olditem: NodeBase, newitem: NodeBase) {
    const i = this.indexOf(olditem)
    if (i >= 0) {
      this[i] = newitem
    } else {
      // eslint-disable-next-line no-console
      console.warn(olditem, newitem)
      throw new Error('Node is not in node list')
    }

    return this
  }

  setSelect<NodeType extends NodeBase>(node: NodeType, state = false): void {
    if (state) {
      node.graph_flag |= GraphFlags.SELECT
      this.selected.add(node)
    } else {
      node.graph_flag &= ~GraphFlags.SELECT
      this.selected.delete(node)
    }
  }

  /**
   swap node to first element in list.

   a convention in shader networks is that the active "output" node is the first one found in the list.
   this way users can click different output nodes to preview different subnetworks in real time.
   */
  pushToFront<NodeType extends NodeBase>(frontNode: NodeType) {
    const node = frontNode
    let i = this.indexOf(node)

    if (i < 0) {
      throw new Error('node not in list')
    }

    if (this.length === 1) {
      return
    }

    while (i > 0) {
      this[i] = this[i - 1]
      i--
    }

    this[0] = node

    return this
  }
}

export class Graph<ExecContextType, NodeBase extends Node = GenericNode<ExecContextType>> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
graph.Graph {
  graph_idgen : IDGen; 
  nodes       : iter(abstract(graph.Node)) | obj._save_nodes();
}`
  )

  updateGen = 0
  onFlagResort?: (graph: this) => void
  nodes: GraphNodes<ExecContextType, NodeBase>
  graph_flag: number
  max_cycle_steps: number
  cycle_stop_threshold: number
  graph_idgen: util.IDGen
  node_idmap: Map<number, NodeBase>
  sock_idmap: Map<number, NodeSocketType>
  sortlist: NodeBase[]

  constructor() {
    /**unfortunately we can't use normal event callbacks (or the graph itself)
     to send certain updates to the UI, because the sheer number of nodes
     in normal workflows would make that slow and error-prone.
     so, like with meshes, we use a random number that changes when the ui should
     redraw things.

     That said, in theory you could make the dependency graph compile into code
     like shader graphs compile to glsl.
     */
    this.updateGen = Math.random()

    this.onFlagResort = undefined

    this.nodes = new GraphNodes<ExecContextType, NodeBase>(this)
    this.sortlist = []
    this.graph_flag = 0
    this.max_cycle_steps = 64
    this.cycle_stop_threshold = 0.0005 //stop cyclic solver when change per socket is less than this

    this.graph_idgen = new util.IDGen()
    this.node_idmap = new Map()
    this.sock_idmap = new Map()
  }

  copy(addLibUsers = false, libOwner?: DataBlock) {
    const ret = new (this.constructor as new () => this)()

    ret.nodes.length = 0
    ret.node_idmap = new Map()
    ret.sock_idmap = new Map()
    ret.graph_idgen = this.graph_idgen.copy()

    for (const node of this.nodes) {
      const n2 = node.copy(addLibUsers, libOwner)

      n2.graph_id = node.graph_id
      n2.graph_name = node.graph_name
      n2.graph_flag = node.graph_flag
      n2.graph_graph = ret

      n2.graph_ui_pos.load(node.graph_ui_pos)
      n2.graph_ui_size.load(node.graph_ui_size)
      n2.icon = node.icon
      n2.graph_ui_flag = node.graph_ui_flag

      ret.nodes.push(n2)
      ret.node_idmap.set(n2.graph_id, n2)

      for (let i = 0; i < 2; i++) {
        const s1 = i ? node.outputs : node.inputs
        const s2 = i ? n2.outputs : n2.inputs

        for (const k in s1) {
          const sock1 = s1[k]
          const sock2 = s2[k]

          sock2.graph_id = sock1.graph_id
          sock2.graph_flag = sock1.graph_flag
          sock2.socketType = sock1.socketType
          sock2.socketName = sock1.socketName
          sock2.name = sock1.name
          sock2.uiname = sock1.uiname

          ret.sock_idmap.set(sock2.graph_id, sock2)
        }
      }
    }

    for (const node of this.nodes) {
      const n2 = ret.node_idmap.get(node.graph_id)!

      for (let i = 0; i < 2; i++) {
        const s1 = i ? node.outputs : node.inputs
        const s2 = i ? n2.outputs : n2.inputs

        for (const k in s1) {
          const sock1 = s1[k]
          const sock2 = s2[k]

          for (const sock3 of sock1.edges) {
            const bad = sock3.node?.graph_graph && sock3.node.graph_graph !== this

            if (bad) {
              // eslint-disable-next-line no-console
              console.log('bad socket', sock3)
              continue
            }

            const n3 = sock3.node
            const n4 = ret.node_idmap.get(n3.graph_id)

            if (!n4) {
              // eslint-disable-next-line no-console
              console.log('bad socket2', sock3)
              continue
            }

            const socks = i ? n4.inputs : n4.outputs
            const sock4 = socks[sock3.socketName]

            if (!sock4) {
              // eslint-disable-next-line no-console
              console.log('bad socket3', sock3, socks)
              continue
            }

            sock2.edges.push(sock4)
          }
        }
      }
    }

    return ret
  }

  destroy() {
    for (const n of this.nodes) {
      for (const sock of n.allsockets) {
        sock.graphDestory()
      }
      n.graphDestroy()
    }
  }

  clear() {
    const nodes = this.nodes.concat([])

    for (const n of nodes) {
      this.remove(n)
    }

    return this
  }

  load(graph: this): this {
    this.graph_idgen = graph.graph_idgen
    this.node_idmap = graph.node_idmap
    this.sock_idmap = graph.sock_idmap

    this.graph_flag = graph.graph_flag

    this.sortlist = graph.sortlist
    this.nodes = graph.nodes

    this.max_cycle_steps = graph.max_cycle_steps
    this.cycle_stop_threshold = graph.cycle_stop_threshold

    return this
  }

  /**unfortunately we can't use normal event callbacks (or the graph itself)
   to send certain updates to the UI, because the sheer number of nodes
   in normal workflows would make that slow and error-prone.
   so, like with meshes, we use a random number that changes when the ui should
   redraw things*/
  signalUI(): void {
    this.updateGen = Math.random()
  }

  flagResort(): void {
    if (this.onFlagResort) {
      this.onFlagResort(this)
    }

    this.graph_flag |= GraphFlags.RESORT
  }

  sort(): void {
    const sortlist = this.sortlist
    const nodes = this.nodes

    this.graph_flag &= ~GraphFlags.CYCLIC

    sortlist.length = 0

    for (const n of nodes) {
      n.graph_flag &= ~(NodeFlags.SORT_TAG | NodeFlags.CYCLE_TAG)
    }

    const dosort = (n: NodeBase) => {
      if (n.graph_flag & NodeFlags.CYCLE_TAG) {
        // eslint-disable-next-line no-console
        console.warn('Warning: graph cycle detected!')
        this.graph_flag |= GraphFlags.CYCLIC
        n.graph_flag &= ~NodeFlags.CYCLE_TAG

        return
      }

      if (n.graph_flag & NodeFlags.SORT_TAG) {
        return
      }

      n.graph_flag |= NodeFlags.SORT_TAG
      n.graph_flag |= NodeFlags.CYCLE_TAG

      for (const k in n.inputs) {
        const s1 = n.inputs[k]

        for (const s2 of s1.edges) {
          const n2 = s2.node as NodeBase

          if (!(n2.graph_flag & NodeFlags.SORT_TAG)) {
            dosort(n2)
          }
        }
      }

      sortlist.push(n)

      n.graph_flag &= ~NodeFlags.CYCLE_TAG
    }

    for (const n of nodes) {
      dosort(n as NodeBase)
    }

    //we may not have caught all cycle cases

    const cyclesearch = (n: GenericNode<ExecContextType>): boolean => {
      if (n.graph_flag & NodeFlags.CYCLE_TAG) {
        // eslint-disable-next-line no-console
        console.warn('Warning: graph cycle detected!')
        this.graph_flag |= GraphFlags.CYCLIC
        return true
      }

      for (const k in n.outputs) {
        const s1 = n.outputs[k]

        n.graph_flag |= NodeFlags.CYCLE_TAG
        for (const s2 of s1.edges) {
          if (s2.node === undefined) {
            // eslint-disable-next-line no-console
            console.warn('Dependency graph corruption detected', s1, s2, n)
            continue
          }

          const ret = cyclesearch(s2.node)

          if (ret) {
            n.graph_flag &= ~NodeFlags.CYCLE_TAG
            return ret
          }
        }
        n.graph_flag &= ~NodeFlags.CYCLE_TAG
      }
      return false
    }

    for (const n of this.nodes) {
      if (cyclesearch(n)) break
    }

    this.graph_flag &= ~GraphFlags.RESORT
  }

  _cyclic_step(context: ExecContextType) {
    const sortlist = this.sortlist

    for (const n of sortlist) {
      if (n.graph_flag & NodeFlags.DISABLED) {
        continue
      }
      if (!(n.graph_flag & NodeFlags.UPDATE)) {
        continue
      }

      n.graph_flag &= ~NodeFlags.UPDATE
      n.exec(context)
    }

    let change = 0.0 //, tot = 0.0;

    for (const n of sortlist) {
      if (n.graph_flag & NodeFlags.DISABLED) {
        continue
      }
      if (!(n.graph_flag & NodeFlags.UPDATE)) {
        continue
      }

      for (const sock of n.allsockets) {
        const diff = Math.abs(sock.diffValue(sock._old))

        if (isNaN(diff)) {
          // eslint-disable-next-line no-console
          console.warn("Got NaN from a socket's diffValue method!", sock)
          continue
        }

        change += diff
        //tot += 1.0;

        sock._old = sock.copyValue()
      }
    }

    return change //tot > 0.0 ? change : 0.0;
  }

  _cyclic_exec(context: ExecContextType) {
    const sortlist = this.sortlist

    for (const n of sortlist) {
      if (n.graph_flag & NodeFlags.DISABLED) {
        continue
      }

      for (const sock of n.allsockets) {
        sock._old = sock.copyValue()
      }
    }

    for (let i = 0; i < this.max_cycle_steps; i++) {
      const limit = this.cycle_stop_threshold
      const change = this._cyclic_step(context)

      if (Math.abs(change) < limit) {
        break
      }
    }
  }

  //context is provided by client code
  exec(context: ExecContextType, force_single_solve = false) {
    if (this.graph_flag & GraphFlags.RESORT) {
      this.sort()
    }

    if (this.graph_flag & GraphFlags.CYCLIC && !(this.graph_flag & GraphFlags.CYCLIC_ALLOWED)) {
      throw new Error('cycles in graph now allowed')
    } else if (!force_single_solve && this.graph_flag & GraphFlags.CYCLIC) {
      return this._cyclic_exec(context)
    }

    const sortlist = this.sortlist

    for (const node of sortlist) {
      if (node.graph_flag & NodeFlags.DISABLED) {
        continue
      }

      //paranoia check
      node.graph_flag &= ~NodeFlags.CYCLE_TAG

      if (node.graph_flag & NodeFlags.UPDATE) {
        node.graph_flag &= ~NodeFlags.UPDATE
        node.exec(context)
      }
    }
  }

  update() {
    // eslint-disable-next-line no-console
    console.warn('Graph.prototype.update() called; use .graphUpdate instead')
    return this.graphUpdate()
  }

  graphUpdate() {
    if (this.graph_flag & GraphFlags.RESORT) {
      this.sort()
    }
  }

  remove(node: Node) {
    if (node.graph_id === -1) {
      // eslint-disable-next-line no-console
      console.warn('Warning, twiced to remove node not in graph (double remove?)', node.graph_id, node)
      return
    }

    for (const s of node.allsockets) {
      let _i = 0

      while (s.edges.length > 0) {
        s.disconnect(s.edges[0])

        if (_i++ > 10000) {
          // eslint-disable-next-line no-console
          console.warn('infinite loop detected')
          break
        }
      }

      this.sock_idmap.delete(s.graph_id)
    }

    this.node_idmap.delete(node.graph_id)
    this.nodes.remove(node as NodeBase)
    node.graph_id = -1
  }

  has(node: Node) {
    let ok = node !== undefined
    ok = ok && node.graph_id !== undefined
    ok = ok && node === this.node_idmap.get(node.graph_id)

    return ok
  }

  add(node: NodeBase) {
    if (node.graph_id !== -1) {
      // eslint-disable-next-line no-console
      console.warn('Warning, tried to add same node twice', node.graph_id, node)
      return
    }

    node.graph_graph = this
    node.graph_id = this.graph_idgen.next()

    for (const k in node.inputs) {
      const sock = node.inputs[k]

      sock.node = node
      sock.graph_id = this.graph_idgen.next()
      this.sock_idmap.set(sock.graph_id, sock)
    }

    for (const k in node.outputs) {
      const sock = node.outputs[k]

      sock.node = node
      sock.graph_id = this.graph_idgen.next()
      this.sock_idmap.set(sock.graph_id, sock)
    }

    this.node_idmap.set(node.graph_id, node)
    this.nodes.push(node)

    this.flagResort()
    node.graph_flag |= NodeFlags.UPDATE

    return this
  }

  dataLink(owner: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    for (const node of this.nodes) {
      node.graphDataLink(owner, getblock, getblock_addUser)

      for (const sock of node.allsockets) {
        sock.graphDataLink(owner, getblock, getblock_addUser)
      }
    }
  }

  loadSTRUCT(reader: StructReader<this>) {
    reader(this)

    this.nodes = new GraphNodes(this, this.nodes)

    const node_idmap = this.node_idmap
    const sock_idmap = this.sock_idmap

    for (const n of this.nodes) {
      n.afterSTRUCT()
    }

    for (const n of this.nodes) {
      node_idmap.set(n.graph_id, n)
      n.graph_graph = this

      for (const s of n.allsockets) {
        if (s.graph_id === -1) {
          // eslint-disable-next-line no-console
          console.warn('Found patched socket from old file; fixing.', s)
          //old file, didn't have socket
          s.graph_id = this.graph_idgen.next()
        }

        s.node = n
        sock_idmap.set(s.graph_id, s)
      }
    }

    for (const n of this.nodes) {
      for (const s of n.allsockets) {
        for (let i = 0; i < s.edges.length; i++) {
          s.edges[i] = sock_idmap.get(s.edges[i] as unknown as number)!

          if (!s.edges[i]) {
            //probably a connection to a zombie node, which aren't saved?
            let j = i

            while (j < s.edges.length - 1) {
              s.edges[j] = s.edges[j + 1]
              j++
            }

            s.edges.length--

            i--
          }
        }

        sock_idmap.set(s.graph_id, s)
      }
    }

    //paranoia check, prune any surviving zombie nodes
    for (const node of this.nodes.slice(0, this.nodes.length)) {
      if (node.graph_flag & NodeFlags.ZOMBIE) {
        this.remove(node)
      }
    }

    for (const node of this.nodes) {
      for (const sock of node.allsockets) {
        for (let i = 0; i < sock.edges.length; i++) {
          const sock_id = sock.edges[i]
          let e: NodeSocketType | undefined

          if (typeof sock_id === 'number') {
            e = this.sock_idmap.get(sock_id as unknown as number)
          } else {
            e = sock_id
          }

          if (!e) {
            // eslint-disable-next-line no-console
            console.warn('pruning dead graph connection', sock)
            sock.edges.remove(sock.edges[i])
            i--
          }
        }
      }
    }

    this.flagResort()

    return this
  }

  //substitute proxy with original node
  relinkProxyOwner<NodeType extends NodeBase>(n: NodeType): void {
    let ok = n !== undefined && this.node_idmap.has(n.graph_id)
    ok = ok && this.node_idmap.get(n.graph_id) instanceof ProxyNode

    //console.trace("relinking proxy", n.name);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn(
        'structural error in Graph: relinkProxyOwner was called in error',
        n,
        this.node_idmap.get(n.graph_id),
        this
      )
      return
    }

    const n2 = this.node_idmap.get(n.graph_id)!

    const node_idmap = this.node_idmap
    const sock_idmap = this.sock_idmap

    n.graph_graph = this

    this.nodes.replace(n2, n)
    node_idmap.set(n2.graph_id, n)

    for (let i = 0; i < 2; i++) {
      const socks1 = i ? n.outputs : n.inputs
      const socks2 = i ? n2.outputs : n2.inputs

      for (const k in socks2) {
        if (typeof socks2[k] === 'number') {
          socks2[k] = sock_idmap.get(socks2[k] as unknown as number)!
        }

        //deal with socket type changes
        const s1 = socks1[k]
        const s2 = socks2[k]

        if (s1.constructor !== s2.constructor) {
          try {
            //attempt to copy old value
            s1.setValue(s2.getValue())
          } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('Failed to load data from old file ' + s2.constructor!.name + ' to ' + s1.constructor!.name)
          }

          s1.edges = s2.edges

          for (const s3 of s2.edges) {
            if (s3.edges.includes(s2)) {
              //paranoia check
              if (s3.edges.includes(s1)) {
                s3.edges.remove(s2)
              } else {
                s3.edges.replace(s2, s1)
              }
            }
          }

          if (s1.graph_id < 0) {
            s1.graph_id = s2.graph_id
            sock_idmap.set(s1.graph_id, s1)
          } else {
            sock_idmap.delete(s2.graph_id)
            sock_idmap.set(s1.graph_id, s1)
          }
        } else {
          if (socks1[k]) {
            socks2[k].onFileLoad(socks1[k])
          }

          socks1[k] = s2
          socks1[k].node = n
        }
      }
    }

    this.flagResort()
    n.graphUpdate()

    if (window.updateDataGraph) {
      window.updateDataGraph()
    }
  }

  execSubtree(startnode: Node, context: ExecContextType, checkStartParents = true) {
    if (this.graph_flag & GraphFlags.RESORT) {
      this.sort()
    }

    function visit(node: Node) {
      if (node.graph_flag & NodeFlags.CYCLE_TAG) {
        throw new GraphCycleError('Cycle error')
      }

      node.graph_flag |= NodeFlags.CYCLE_TAG
      let found_parent = false

      for (const k in node.inputs) {
        if (node === startnode && !checkStartParents) {
          break
        }

        const sock = node.inputs[k]

        for (const e of sock.edges) {
          const n = e.node

          if (n.graph_flag & NodeFlags.UPDATE) {
            node.graph_flag &= ~NodeFlags.CYCLE_TAG
            visit(n)
            found_parent = true
          }
        }
      }

      if (found_parent) {
        return
      }

      if (node.graph_flag & NodeFlags.UPDATE) {
        node.graph_flag &= ~NodeFlags.UPDATE

        try {
          node.exec(context)
        } catch (error) {
          node.graph_flag &= ~NodeFlags.CYCLE_TAG
          throw error
        }

        for (const k in node.outputs) {
          const sock = node.outputs[k]

          for (const e of sock.edges) {
            const n = e.node

            if (n.graph_flag & NodeFlags.UPDATE) {
              visit(n)
            }
          }
        }
      }

      node.graph_flag &= ~NodeFlags.CYCLE_TAG
    }

    visit(startnode)
  }

  _save_nodes() {
    const ret = [] as Node[]

    //ensure node socket id sanity
    for (const n of this.nodes) {
      for (const s of n.allsockets) {
        if (s.graph_id < 0) {
          // eslint-disable-next-line no-console
          console.warn('graph corruption', s)
          s.graph_id = this.graph_idgen.next()
          this.sock_idmap.set(s.graph_id, s)
        }
      }
    }

    for (let n of this.nodes) {
      //don't save zombie nodes
      if (n.graph_flag & NodeFlags.ZOMBIE) {
        continue
      }

      //replace nodes with proxies, for nodes who request it
      if (n.graph_flag & NodeFlags.SAVE_PROXY) {
        n = ProxyNode.fromNode(n) as unknown as NodeBase
      }

      ret.push(n)
    }

    return ret
  }
}

registerDataAPI(Node)
