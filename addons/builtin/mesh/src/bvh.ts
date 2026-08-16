import {util, Vector2, Vector3, Vector4, Matrix4, Quat, Number3, IVectorOrHigher} from '@framework/api'
import {nstructjs, DataAPI, DataStruct} from '@framework/pathux'

import '../../../../scripts/path.ux/scripts/global.d.ts'

const DYNAMIC_SHUFFLE_NODES = false //attempt fast debalancing of tree dynamically

const normalRets = util.cachering.fromConstructor(Vector3, 512)

import {math} from '@framework/api'
import {aabb_ray_isect, ray_tri_isect, aabb_cone_isect, tri_cone_isect} from '@framework/api'
import {aabb_frustum_isect, tri_frustum_isect, point_in_frustum} from '@framework/api'

import {Vertex, Handle, Edge, Loop, LoopList, Face, Element} from './mesh_types.js'

import {AttrRef, CDFlags, CDRef, CustomData, CustomDataElem} from './customdata'
import {MeshTypes, MeshFlags, ENABLE_CACHING, CDElemArray} from './mesh_base.js'
import {GenericGridVert, GridBase, GridVert} from './mesh_grids'

import {QRecalcFlags} from './mesh_grids'
import {EDGE_LINKED_LISTS} from '@framework/api'
import {aabb_sphere_dist, closest_point_on_tri} from '@framework/api'
import {getFaceSets} from './mesh_facesets.js'
import {FaceSetElem, IntElem, Vector3LayerElem} from './mesh_customdata'
import type {Mesh} from './mesh'

// Mesh-agnostic spatial interfaces moved to ./spatial. Re-exported here so
// existing consumers that import from '../util/bvh' keep compiling; new code
// should import {directly} from '@framework/api'. See plan §3.
import {GenericIsect} from '@framework/api'
import type {
  IBVHCreateArgs as ISpatialBVHCreateArgs,
  IBVHVertex as ISpatialBVHVertex,
  IGenericIsect,
  ISurfaceSampler,
} from '@framework/api'

export {GenericIsect}
export type {IGenericIsect, ISurfaceSampler}

/** BVH vertex specialized to mesh's concrete CDElemArray. */
export type IBVHVertex = ISpatialBVHVertex<CDElemArray>

/** BVH construction args specialized to the concrete BVH/BVHTri types. */
export type IBVHCreateArgs = ISpatialBVHCreateArgs<BVHTri, BVH>

const surfaceCastRets = util.cachering.fromConstructor(GenericIsect, 512)

const safetimes = new Array<number>(32).map((f) => 0)

function safeprint(id: number, ...args: any[]) {
  if (util.time_ms() - safetimes[id] < 200) {
    return
  }

  console.warn(id, ...args)
  safetimes[id] = util.time_ms()
}

const _triverts = [new Vector3(), new Vector3(), new Vector3()]

const _ntmptmp = new Vector3()

const HIGH_QUAL_SPLIT = true

const _fictmp1 = new Vector3()
const _fictmp2 = new Vector3()
const _fictmp3 = new Vector3()
const _fictmp4 = new Vector3()
const _fictmpco = new Vector3()

export class BVHSettings {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
bvh.BVHSettings {
  leafLimit       : int;
  drawLevelOffset : int;
  depthLimit      : int;
}`
  )

  leafLimit: number
  drawLevelOffset: number
  depthLimit: number
  _last_key: string

  constructor(leafLimit = 256, drawLevelOffset = 3, depthLimit = 18) {
    this.leafLimit = leafLimit
    this.drawLevelOffset = drawLevelOffset
    this.depthLimit = depthLimit

    this._last_key = ''
  }

  copyTo(b: this): void {
    b.leafLimit = this.leafLimit
    b.drawLevelOffset = this.drawLevelOffset
    b.depthLimit = this.depthLimit
  }

  calcUpdateKey() {
    return '' + this.leafLimit + ':' + this.drawLevelOffset + ':' + this.depthLimit
  }

  load(b: this) {
    b.copyTo(this)
    return this
  }

  copy(b: this) {
    return new BVHSettings().load(this)
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    let st = struct ?? api.mapStruct(this, true)

    st.int('depthLimit', 'depthLimit', 'Depth Limit').range(1, 32).noUnits()
    st.int('drawLevelOffset', 'drawLevelOffset', 'Draw Level').range(0, 8).noUnits()
    st.int('leafLimit', 'leafLimit', 'Tri Limit').range(1, 4096).step(5).noUnits()

    return st
  }
}

export const BVHFlags = {
  UPDATE_DRAW          : 1,
  TEMP_TAG             : 2,
  UPDATE_UNIQUE_VERTS  : 4,
  UPDATE_UNIQUE_VERTS_2: 8,
  UPDATE_NORMALS       : 16,
  UPDATE_TOTTRI        : 32,
  UPDATE_OTHER_VERTS   : 64,
  UPDATE_INDEX_VERTS   : 128,
  UPDATE_COLORS        : 256,
  UPDATE_MASK          : 512,
  UPDATE_BOUNDS        : 1024,
  UPDATE_ORIGCO_VERTS  : 2048,
}

export const BVHTriFlags = {
  LOOPTRI_INVALID: 1,
}

const FakeSet = Set //util.set; //FakeSet1;

let _tri_idgen = 0

// IBVHVertex moved to ./spatial — re-exported at the top of this file.

export class BVHTri<OPT extends {grid?: true | false; dead?: true | false} = {}> {
  seti: number
  node?: BVHNode
  v1: OptionalIf<IBVHVertex, OPT['dead']> = undefined as unknown as IBVHVertex
  v2: OptionalIf<IBVHVertex, OPT['dead']> = undefined as unknown as IBVHVertex
  v3: OptionalIf<IBVHVertex, OPT['dead']> = undefined as unknown as IBVHVertex
  l1: OptionalIf<Loop, BoolOr<OPT['dead'], OPT['grid']>>
  l2: OptionalIf<Loop, BoolOr<OPT['dead'], OPT['grid']>>
  l3: OptionalIf<Loop, BoolOr<OPT['dead'], OPT['grid']>>
  id: number
  flag: number
  no: Vector3
  area: number
  f?: Face
  vs: OptionalIf<IBVHVertex, OPT['dead']>[]
  nodes: OptionalIf<OptionalIf<BVHNode, OPT['dead']>[], OPT['dead']>
  _id1: number
  tri_idx: number
  removed: boolean

  constructor(id?: number, tri_idx?: number, f?: Face) {
    this.seti = 0

    this.node = undefined

    /* Ensure v1,v2,v3 exist prior to Object.seal.*/
    this.v1 = this.v2 = this.v3 = undefined as unknown as this['v1']

    //only used in non grids mode
    this.l1 = this.l2 = this.l3 = undefined as unknown as this['l1']

    this.id = id ?? -1
    this._id1 = _tri_idgen++
    this.tri_idx = tri_idx ?? -1
    this.node = undefined
    this.removed = false

    this.flag = 0

    this.no = new Vector3()
    this.area = 0.0

    this.f = f

    this.vs = new Array(3)
    this.nodes = []

    Object.seal(this)
  }

  [Symbol.keystr]() {
    return this._id1
  }
}

const addtri_tempco1 = new Vector3()
const addtri_tempco2 = new Vector3()
const addtri_tempco3 = new Vector3()
const addtri_tempco4 = new Vector3()
const addtri_tempco5 = new Vector3()
const addtri_stack = new Array<BVHNode>(2048)

const lastt = util.time_ms()

export const BVHVertFlags = {
  BOUNDARY_MESH: 1 << 1,
  BOUNDARY_FSET: 1 << 2,
  CORNER_MESH  : 1 << 3,
  CORNER_FSET  : 1 << 4,
  NEED_BOUNDARY: 1 << 5,
  NEED_VALENCE : 1 << 6,
  NEED_ALL     : (1 << 5) | (1 << 6),
  BOUNDARY_ALL : (1 << 1) | (1 << 2),
  CORNER_ALL   : (1 << 3) | (1 << 4),
}

export class MDynVert extends CustomDataElem<number> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
MDynVert {
  flag : int;
}`
  )

  flag: number
  valence: number

  constructor() {
    super()

    this.flag = BVHVertFlags.NEED_BOUNDARY | BVHVertFlags.NEED_VALENCE
    this.valence = 0
  }

  static define() {
    return {
      elemTypeMask : MeshTypes.VERTEX,
      typeName     : 'dynvert',
      uiTypeName   : 'dynvert',
      defaultName  : 'dynvert',
      flag         : 0,
      settingsClass: undefined,
    }
  }

  updateBoundary(v: Vertex, fsetAt: AttrRef<FaceSetElem>) {
    this.flag &= ~(
      BVHVertFlags.BOUNDARY_FSET |
      BVHVertFlags.BOUNDARY_MESH |
      BVHVertFlags.CORNER_FSET |
      BVHVertFlags.CORNER_MESH
    )

    let flag = 0
    const fsets = new Set()

    for (const e of v.edges) {
      if (!e.l || e.l.radial_next === e.l) {
        flag |= BVHVertFlags.BOUNDARY_MESH
      }

      if (!e.l || fsetAt.i === -1) {
        continue
      }

      let l = e.l
      let _i = 0
      do {
        const fset = Math.abs(fsetAt.get(l.f).value)
        fsets.add(fset)

        if (_i++ > 100) {
          console.error('infinite loop')
          break
        }
        l = l.radial_next
      } while (l !== e.l)
    }

    if (fsets.size > 1) {
      flag |= BVHVertFlags.BOUNDARY_FSET
    }

    if (fsets.size > 2) {
      flag |= BVHVertFlags.CORNER_FSET
    }

    this.flag |= flag
  }

  check(v: Vertex, cd_fset: AttrRef<FaceSetElem>) {
    let ret = false

    if (this.flag & BVHVertFlags.NEED_BOUNDARY) {
      this.updateBoundary(v, cd_fset)
      ret = true
    }

    if (this.flag & BVHVertFlags.NEED_VALENCE) {
      let i = 0

      for (const v2 of v.neighbors) {
        i++
      }

      this.valence = i
      ret = true
    }

    return ret
  }

  copyTo(b: this) {
    b.flag = this.flag | BVHVertFlags.NEED_BOUNDARY | BVHVertFlags.NEED_VALENCE
  }

  interp(dest: this, blocks: this[], weights: number[]) {
    dest.flag |= BVHVertFlags.NEED_BOUNDARY | BVHVertFlags.NEED_VALENCE
  }

  calcMemSize() {
    return 8
  }

  getValue() {
    return this.flag
  }

  setValue(v: number) {
    this.flag = v
  }
}

export function getDynVerts(mesh: Mesh): CDRef<MDynVert> {
  let cd_dyn_vert = mesh.verts.customData.getLayerIndex('dynvert')

  if (cd_dyn_vert < 0) {
    mesh.verts.addCustomDataLayer('dynvert')
    cd_dyn_vert = mesh.verts.customData.getLayerIndex('dynvert')
  }

  return cd_dyn_vert
}

export class CDNodeInfo<OPT extends {dead?: true | false} = {}> extends CustomDataElem<any> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
CDNodeInfo {
  flag : int;
}`
  )

  node: OptionalIf<BVHNode, OPT['dead']>
  vel: Vector3
  flag: number
  valence: number

  constructor() {
    super()
    this.node = undefined as unknown as BVHNode
    this.vel = new Vector3() //for smoothing
    this.flag = BVHVertFlags.NEED_ALL
    this.valence = 0
  }

  static define() {
    return {
      elemTypeMask : MeshTypes.VERTEX, //see MeshTypes in mesh.js
      typeName     : 'bvh',
      uiTypeName   : 'bvh',
      defaultName  : 'bvh',
      flag         : CDFlags.TEMPORARY | CDFlags.IGNORE_FOR_INDEXBUF,
      settingsClass: undefined,
    }
  }

  /*
  get node() {
    return this._node;
  }

  set node(v) {
    if (v === undefined && this._node !== undefined) {
      if (util.time_ms() - lastt > 10) {
        console.warn("clear node ref");
        lastt = util.time_ms();
      }
    }

    this._node = v;
  }
  //*/

  clear() {
    //this.node = undefined;
    this.vel.zero()
    return this
  }

  calcMemSize() {
    return 32
  }

  getValue() {
    return this.node
  }

  setValue(node: BVHNode) {
    this.node = node
  }

  interp(dest: this, datas: this[], ws: number[]): void {
    return
  }

  /*
    set node(v) {
      if (typeof v === "number") {
        throw new Error("eek");
      }

      this._node = v;
    }

    get node() {
      return this._node;
    }
  */
  copyTo(b: this) {
    //b.node = this.node;
    //b.node = undefined;
    b.vel.load(this.vel)
  }
}

const cvstmps = util.cachering.fromConstructor<Vector3>(Vector3, 64)
const cvstmps2 = util.cachering.fromConstructor<Vector3>(Vector3, 64)
const vttmp1 = new Vector3()
const vttmp2 = new Vector3()
const vttmp3 = new Vector3()
const vttmp4 = new Vector3()

export class IsectRet {
  id: number
  p: Vector3
  uv: Vector2
  dist: number
  tri?: BVHTri
  tri_idx: number = -1

  constructor() {
    this.id = 0
    this.p = new Vector3()
    this.uv = new Vector2()
    this.dist = 0

    this.tri = undefined
  }

  load(b: this): this {
    this.id = b.id
    this.p.load(b.p)
    this.uv.load(b.uv)
    this.dist = b.dist

    this.tri = b.tri

    return this
  }

  copy(): this {
    return new (this.constructor as new () => this)().load(this)
  }
}

let _bvh_idgen = 0

export class BVHNodeVertex extends Vector3 {
  origco: Vector3
  id: number
  nodes: BVHNode[]
  edges: BVHNodeEdge[]

  constructor(arg?: Vector3) {
    super(arg)

    this.origco = new Vector3(arg)

    this.id = -1
    this.nodes = []
    this.edges = []
  }
}

export class BVHNodeEdge {
  id: number
  v1: BVHNodeVertex
  v2: BVHNodeVertex
  nodes: BVHNode[]

  constructor(v1: BVHNodeVertex, v2: BVHNodeVertex) {
    this.id = -1

    this.v1 = v1
    this.v2 = v2

    this.nodes = []
  }

  otherVertex(v: BVHNodeVertex) {
    if (v === this.v1) {
      return this.v2
    } else if (v === this.v2) {
      return this.v1
    } else {
      throw new Error('vertex not in edge (BVHNodeEdge)')
    }
  }
}

export const DEFORM_BRIDGE_TRIS = false

export type OrigCoType = Vector3LayerElem
import {BoolOr, OptionalIf, OptionalIfNot} from '@framework/api'

export class BVHNode<
  OPT extends {
    leaf?: true | false
    dead?: true | false //
    grid?: true | false
    boxedges?: true | false
  } = {},
> {
  __id2: any
  id: number
  _id: number
  min: Vector3
  max: Vector3
  cent: Vector3
  halfsize: Vector3
  nodePad: number

  omin: Vector3
  omax: Vector3
  ocent: Vector3
  ohalfsize: Vector3

  leafIndex: number
  leafTexUV: Vector2
  boxverts: OptionalIfNot<BVHNodeVertex[], OPT['boxedges']>
  boxedges: OptionalIfNot<BVHNodeEdge[], OPT['boxedges']>
  boxvdata: OptionalIfNot<Map<any, any>, OPT['boxedges']>
  boxbridgetris?: any

  origGen: number
  bvh: BVH<OPT>
  drawData?: any

  axis: number
  depth: number
  leaf: boolean
  parent?: this
  index: number
  flag: number
  tottri: number
  indexVerts: OptionalIfNot<IBVHVertex[], OPT['leaf']>
  indexEdges: OptionalIfNot<number[], OPT['leaf']>
  indexTris: OptionalIfNot<number[], OPT['leaf']>
  indexLoops: OptionalIfNot<(Loop | IBVHVertex)[], OPT['leaf']>
  allTris: Set<BVHTri>
  otherTris: Set<BVHTri>
  children: OptionalIf<BVHNode[], OPT['dead']>
  subtreeDepth: number
  _castRayRets: util.cachering<IsectRet>
  _closestRets: util.cachering<IsectRet>

  uniqueVerts: OptionalIfNot<Set<IBVHVertex>, OPT['leaf']>
  uniqueTris: OptionalIfNot<Set<BVHTri>, OPT['leaf']>
  otherVerts: OptionalIfNot<Set<IBVHVertex>, OPT['leaf']>
  wireVerts?: Set<IBVHVertex> // is created on demand

  constructor(bvh: BVH, min: Vector3, max: Vector3) {
    this.__id2 = undefined //scratch id slot for BVH consumers

    this.min = new Vector3(min)
    this.max = new Vector3(max)

    this.omin = new Vector3(min)
    this.omax = new Vector3(max)

    this.leafIndex = -1
    this.leafTexUV = new Vector2()
    this.boxverts = undefined as unknown as this['boxverts']
    this.boxedges = undefined as unknown as this['boxedges']
    this.boxvdata = undefined as unknown as this['boxvdata']

    if (DEFORM_BRIDGE_TRIS) {
      //cross-node triangle buffer
      this.boxbridgetris = undefined
    }

    this.ocent = new Vector3()
    this.ohalfsize = new Vector3()
    this.origGen = 0

    this.axis = 0
    this.depth = 0
    this.leaf = true
    this.parent = undefined
    this.bvh = bvh as unknown as (typeof this)['bvh']
    this.index = -1

    this.flag = BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_OTHER_VERTS

    this.tottri = 0

    this.drawData = undefined

    this.id = -1
    this._id = _bvh_idgen++

    this.uniqueVerts = new Set()
    this.uniqueTris = new Set() //new Set();
    this.otherVerts = new Set()
    this.wireVerts = undefined as unknown as Set<IBVHVertex> //is created on demand

    this.indexVerts = []
    this.indexLoops = []
    this.indexTris = []
    this.indexEdges = []

    this.otherTris = new Set()

    this.allTris = new Set()
    this.children = []

    this.subtreeDepth = 0

    this.nodePad = 0.00001

    this._castRayRets = util.cachering.fromConstructor<IsectRet>(IsectRet, 64, true)
    this._closestRets = util.cachering.fromConstructor<IsectRet>(IsectRet, 64, true)

    this.cent = new Vector3(min).interp(max, 0.5)
    this.halfsize = new Vector3(max).sub(min).mulScalar(0.5)

    if (this.constructor === BVHNode) {
      Object.seal(this)
    }
  }

  calcBoxVerts = function (this: BVHNode<OPT & {boxedges: true}>) {
    const min = this.min
    const max = this.max

    this.boxedges = []

    const boxverts = (this.boxverts = [
      [min[0], min[1], min[2]],
      [min[0], max[1], min[2]],
      [max[0], max[1], min[2]],
      [max[0], min[1], min[2]],

      [min[0], min[1], max[2]],
      [min[0], max[1], max[2]],
      [max[0], max[1], max[2]],
      [max[0], min[1], max[2]],
    ].map((v) => this.bvh.getNodeVertex(new Vector3(v))))

    for (let i = 0; i < 4; i++) {
      const i2 = (i + 1) % 4
      this.bvh.getNodeEdge(this, boxverts[i], boxverts[i2])
      this.bvh.getNodeEdge(this, boxverts[i + 4], boxverts[i2 + 4])
      this.bvh.getNodeEdge(this, boxverts[i], boxverts[i + 4])
    }

    for (const e of this.boxedges) {
      e.nodes.push(this)
      if (!e.v1.nodes.includes(this)) {
        e.v1.nodes.push(this)
      }

      if (!e.v2.nodes.includes(this)) {
        e.v2.nodes.push(this)
      }
    }
  }

  origUpdate(force = false, updateOrigVerts = false) {
    let ok = this.origGen !== this.bvh.origGen
    ok = ok || !this.omin
    ok = ok || force

    ok = ok && this.bvh.cd_orig >= 0

    if (!ok) {
      return false
    }

    if (this.flag & BVHFlags.UPDATE_ORIGCO_VERTS) {
      this.flag &= ~BVHFlags.UPDATE_ORIGCO_VERTS
      updateOrigVerts = true
    }

    if (!this.omin) {
      this.omin = new Vector3()
      this.omax = new Vector3()
      this.ocent = new Vector3()
      this.ohalfsize = new Vector3()
    }

    console.warn('updating node origco bounds', this.id)
    this.origGen = this.bvh.origGen

    this.omin.zero().addScalar(1e17)
    this.omax.zero().addScalar(-1e17)

    const cd_orig = this.bvh.cd_orig

    if (!this.leaf) {
      for (const c of this.children!) {
        c.origUpdate(force, updateOrigVerts)

        this.omin.min(c.min)
        this.omax.max(c.max)
      }
    } else {
      const omin = this.omin
      const omax = this.omax

      if (updateOrigVerts) {
        for (let i = 0; i < 2; i++) {
          const list = i ? this.otherVerts! : this.uniqueVerts!

          for (const v of list) {
            v.customData.get<OrigCoType>(cd_orig).value.load(v.co)
          }
        }
      }

      for (const t of this.uniqueTris!) {
        omin.min(t.v1.co)
        omin.min(t.v2.co)
        omin.min(t.v3.co)

        omax.max(t.v1.co)
        omax.max(t.v2.co)
        omax.max(t.v3.co)
      }
    }

    this.ocent.load(this.omin).interp(this.omax, 0.5)
    this.ohalfsize.load(this.omax).sub(this.omin).mulScalar(0.5)

    return true
  }

  setUpdateFlag = function (this: BVHNode<OPT & {dead: false}>, flag: number) {
    if (!this.bvh || this.bvh.dead) {
      console.warn('Dead BVH!')
      return
    }

    if ((this.flag & flag) !== flag) {
      this.bvh.updateNodes.add(this)
      this.flag |= flag
    }

    return this
  }

  split = function (this: BVHNode<OPT & {dead: false}>, test?: number) {
    if (test === undefined) {
      throw new Error('test was undefined')
    }
    if (test === 3) {
      console.warn('joining node from split()')
      this.bvh.joinNode(this.parent!, true)
      //abort;
      return
    }

    const addToRoot = test > 1

    if (!this.leaf) {
      console.error('bvh split called on non-leaf node', this)
      return
    }
    if (this.allTris.size === 0 && !this.bvh.isDeforming && !this.wireVerts?.size) {
      console.error('split called on empty node')
      return
    }

    //this.update();

    let n: BVHNode | undefined = this
    while (n !== undefined) {
      n.subtreeDepth = Math.max(n.subtreeDepth, this.depth + 1)
      n = n.parent
    }

    const uniqueVerts = this.uniqueVerts!
    const otherVerts = this.otherVerts!
    const wireVerts = this.wireVerts!
    const uniqueTris = this.uniqueTris!
    const allTris = this.allTris!

    this.wireVerts = undefined as unknown as Set<IBVHVertex>
    this.indexVerts = undefined as unknown as (typeof this)['indexVerts']
    this.indexLoops = undefined as unknown as (typeof this)['indexLoops']
    this.uniqueVerts = undefined as unknown as Set<IBVHVertex>
    this.otherVerts = undefined as unknown as Set<IBVHVertex>
    this.uniqueTris = undefined as unknown as Set<BVHTri>
    this.allTris = undefined as unknown as Set<BVHTri>

    this.tottri = 0 //will be regenerated later
    this.leaf = false

    let axis = ((this.axis + 1) % 3) as Number3

    let min
    let max
    if (!this.bvh.isDeforming) {
      min = new Vector3(this.min)
      max = new Vector3(this.max)
    } else {
      min = new Vector3(this.omin)
      max = new Vector3(this.omax)
    }

    let split = 0
    let tot = 0

    if (!this.bvh.isDeforming) {
      // || this === this.bvh.root) {
      const ax = Math.abs(max[0] - min[0])
      const ay = Math.abs(max[1] - min[1])
      const az = Math.abs(max[2] - min[2])

      if (ax > ay && ax > az) {
        axis = 0
      } else if (ay > ax && ay > az) {
        axis = 1
      } else if (az > ax && az > ay) {
        axis = 2
      }
    }

    const min2 = new Vector3(min)
    const max2 = new Vector3(max)

    if (!this.bvh.isDeforming) {
      let smin = 1e17
      let smax = -1e17

      if (wireVerts) {
        for (const v of wireVerts) {
          split += v.co[axis]
          smin = Math.min(smin, v.co[axis])
          smax = Math.min(smax, v.co[axis])
        }
      }

      for (const tri of uniqueTris!) {
        tri.nodes.remove(this)

        split += tri.v1.co[axis]
        split += tri.v2.co[axis]
        split += tri.v3.co[axis]

        smin = Math.min(smin, tri.v1.co[axis])
        smin = Math.min(smin, tri.v2.co[axis])
        smin = Math.min(smin, tri.v3.co[axis])

        smax = Math.max(smax, tri.v1.co[axis])
        smax = Math.max(smax, tri.v2.co[axis])
        smax = Math.max(smax, tri.v3.co[axis])

        tot += 3
      }

      if (!tot) {
        split = max[axis] * 0.5 + min[axis] * 0.5
      } else {
        split /= tot
      }

      //try to handle teapot in a stadium situations

      split = (min[axis] + max[axis]) * 0.5
      const mid = (smin + smax) * 0.5

      split = (split + mid) * 0.5

      const dd = Math.abs(max[axis] - min[axis]) * 0.1

      if (split < min[axis] + dd) {
        split = min[axis] + dd
      }
      if (split > max[axis] - dd) {
        split = max[axis] - dd
      }
    } else {
      for (const tri of allTris) {
        tri.nodes.remove(this)
      }

      split = (min[axis] + max[axis]) * 0.5
    }

    for (let i = 0; i < 2; i++) {
      min2.load(min)
      max2.load(max)

      if (!i) {
        max2[axis] = split
      } else {
        min2[axis] = split
      }

      const c = this.bvh._newNode(min2, max2)
      c.omin.load(min2)
      c.omax.load(max2)

      if (!this.bvh.isDeforming) {
        c.min.subScalar(this.nodePad)
        c.max.addScalar(this.nodePad)
      } else {
        c.calcBoxVerts()
      }

      c.axis = axis
      c.parent = this
      c.depth = this.depth + 1

      this.children!.push(c)
    }

    for (const tri of uniqueTris!) {
      tri.node = undefined
    }

    const cd_node = this.bvh.cd_node

    for (const v of uniqueVerts) {
      cd_node.get(v).node = undefined as unknown as BVHNode
    }

    if (addToRoot) {
      for (const tri of allTris) {
        this.bvh.addTri(
          tri.id,
          tri.tri_idx,
          tri.v1,
          tri.v2,
          tri.v3,
          undefined,
          tri.l1,
          tri.l2,
          tri.l3,
          this.bvh.addPass + 1
        )
      }

      if (wireVerts) {
        for (const v of wireVerts) {
          this.bvh.addWireVert(v)
        }
      }
    } else {
      for (const tri of allTris) {
        this.addTri(tri.id, tri.tri_idx, tri.v1, tri.v2, tri.v3, undefined, tri.l1, tri.l2, tri.l3)
      }

      if (wireVerts) {
        for (const v of wireVerts) {
          this.addWireVert(v)
        }
      }
    }
  }

  /*gets tris based on distances to verts, instead of true tri distance*/
  closestTrisSimple(co: Vector3, radius: number, out: Set<BVHTri>) {
    const radius_sqr = radius * radius

    if (!this.leaf) {
      for (const c of this.children!) {
        if (!math.aabb_sphere_isect(co, radius, c.min, c.max)) {
          continue
        }

        c.closestTris(co, radius, out)
      }

      return
    }

    for (const t of this.allTris) {
      if (out.has(t)) {
        continue
      }

      let dis = co.vectorDistanceSqr(t.v1.co)
      dis = dis > radius ? Math.min(dis, co.vectorDistanceSqr(t.v2.co)) : dis
      dis = dis > radius ? Math.min(dis, (dis = co.vectorDistanceSqr(t.v3.co))) : dis

      if (dis < radius_sqr) {
        out.add(t)
      }
    }
  }

  closestTris(co: Vector3, radius: number, out: Set<BVHTri>) {
    if (!this.leaf) {
      for (const c of this.children!) {
        if (!math.aabb_sphere_isect(co, radius, c.min, c.max)) {
          continue
        }

        c.closestTris(co, radius, out)
      }

      return
    }

    for (const t of this.allTris) {
      if (out.has(t)) {
        continue
      }

      if (t.no.dot(t.no) < 0.999) {
        t.no.load(math.normal_tri(t.v1.co, t.v2.co, t.v3.co))
      }

      const dis = math.dist_to_tri_v3(co, t.v1.co, t.v2.co, t.v3.co, t.no)
      if (dis < radius) {
        out.add(t)
      }
    }
  }

  closestOrigVerts(co: Vector3, radius: number, out: Set<IBVHVertex>) {
    const radius2 = radius * radius

    this.origUpdate()

    if (!this.leaf) {
      for (const c of this.children!) {
        c.origUpdate()

        if (!math.aabb_sphere_isect(co, radius, c.omin, c.omax)) {
          continue
        }

        c.closestOrigVerts(co, radius, out)
      }

      return
    }

    const cd_orig = this.bvh.cd_orig

    for (const v of this.uniqueVerts!) {
      if (v.customData.get<OrigCoType>(cd_orig).value.vectorDistanceSqr(co) < radius2) {
        out.add(v)
      }
    }
  }

  nearestVertsN(
    co: Vector3,
    n: number,
    heapOut: util.MinHeapQueue<IBVHVertex>,
    mindis: number[]
  ): Set<IBVHVertex> | undefined {
    if (!this.leaf) {
      let mindis2
      let minc

      if (this.children!.length === 1) {
        return this.children![0].nearestVertsN(co, n, heapOut, mindis)
      }

      let i = 0
      let mina = 0
      let minb = 0

      for (const c of this.children!) {
        const dis = math.aabb_sphere_dist(co, c.min, c.max)

        if (mindis2 === undefined || dis < mindis2) {
          mindis2 = dis
          minc = c
        }

        if (i) {
          minb = dis
        } else {
          mina = dis
        }
        i++
      }

      let a = 0
      let b = 1

      if (minc === this.children![1]) {
        a = 1
        b = 0
        const t = mina
        mina = minb
        minb = t
      }

      mina /= 5.0
      minb /= 5.0

      if (heapOut.length >= n * 5 && mindis[0] !== undefined && mina >= mindis[0]) {
        return
      }

      this.children![a].nearestVertsN(co, n, heapOut, mindis)

      if (heapOut.length >= n * 5 && mindis[0] !== undefined && minb >= mindis[0]) {
        return
      }

      this.children![b].nearestVertsN(co, n, heapOut, mindis)

      //while (heap.length > n) {
      //  heap.pop();
      //}
      return
    }

    const flag = MeshFlags.MAKE_FACE_TEMP

    for (let j = 0; j < n; j++) {
      let mindis2 = 0
      let minv: IBVHVertex | undefined

      for (let i = 0; i < 2; i++) {
        const set = i ? this.wireVerts : this.uniqueVerts
        this.bvh._i++

        if (!set) {
          continue
        }

        for (const v of set) {
          if (j === 0) {
            v.flag &= ~flag
          } else {
            if (v.flag & flag) {
              continue
            }
          }

          const dis = v.co.vectorDistanceSqr(co)

          if (mindis2 === undefined || dis <= mindis2) {
            mindis2 = dis
            minv = v
          }
        }
      }

      if (minv === undefined) {
        return
      }

      minv.flag |= flag

      if (mindis[0] === undefined || mindis2 < mindis[0]) {
        mindis[0] = mindis2
      }

      heapOut.push(minv, mindis2)
      //out.add(minv);
    }
  }

  closestVerts(co: IVectorOrHigher<3>, radius: number, out: Set<IBVHVertex>) {
    const radius2 = radius * radius

    if (!this.leaf) {
      for (const c of this.children!) {
        if (!math.aabb_sphere_isect(co, radius, c.min, c.max)) {
          continue
        }

        c.closestVerts(co, radius, out)
      }

      return
    }

    for (const v of this.uniqueVerts!) {
      if (v.co.vectorDistanceSqr(co) < radius2) {
        out.add(v)
      }
    }
  }

  closestVertsSquare(
    co: IVectorOrHigher<3>,
    origco: IVectorOrHigher<3>,
    radius: number,
    matrix: Matrix4,
    min: Vector3,
    max: Vector3,
    out: Set<IBVHVertex>
  ) {
    if (!this.leaf) {
      for (const c of this.children!) {
        /*
        XXX 
        let a = cvstmps.next().load(c.min);
        let b = cvstmps.next().load(c.max);
        let cmin = cvstmps.next().zero().addScalar(1e17);
        let cmax = cvstmps.next().zero().addScalar(-1e17);

        a.multVecMatrix(matrix);
        b.multVecMatrix(matrix);

        cmin.min(a);
        cmin.min(b);
        cmax.max(a);
        cmax.max(b);

        cmin.load(c.cent).multVecMatrix(matrix);
        cmax.load(cmin);

        cmin.addFac(c.halfsize, -4.0);
        cmax.addFac(c.halfsize, 4.0);

        if (!math.aabb_isect_3d(min, max, cmin, cmax)) {
          continue;
        }
        //*/

        //use 1.5 instead of sqrt(2) to add a bit of error margin
        if (!math.aabb_sphere_isect(origco, radius * 1.5, c.min, c.max)) {
          continue
        }

        c.closestVertsSquare(co, origco, radius, matrix, min, max, out)
      }

      return
    }

    const co2 = cvstmps.next()

    for (const v of this.uniqueVerts!) {
      co2.load(v.co).multVecMatrix(matrix)

      let dx = co2[0] - co[0]
      let dy = co2[1] - co[1]

      dx = dx < 0 ? -dx : dx
      dy = dy < 0 ? -dy : dy

      //let dis = (dx+dy)*0.5;
      const dis = Math.max(dx, dy)

      if (dis < radius) {
        out.add(v)
      }
    }
  }

  vertsInTube(co: Vector3, ray: Vector3, radius: number, clip: boolean, isSquare = false, out: Set<IBVHVertex>) {
    if (!this.leaf) {
      for (const c of this.children!) {
        if (!aabb_ray_isect(co, ray, c.min, c.max)) {
          continue
        }

        c.vertsInTube(co, ray, radius, clip, isSquare, out)
      }

      return
    }

    const co2 = vttmp1.load(co).add(ray)
    const t1 = vttmp2
    const rsqr = radius * radius
    const raylen = clip ? ray.vectorLength() : 0.0
    let nray = ray

    if (clip) {
      nray = new Vector3(nray).normalize()
    }

    for (let i = 0; i < 2; i++) {
      const set = i ? this.wireVerts : this.uniqueVerts

      if (!set) {
        continue
      }

      for (const v of set) {
        t1.load(v.co).sub(co)
        const t = t1.dot(nray)

        if (t < 0) {
          continue
        }

        if (clip && t > raylen) {
          continue
        }

        co2.load(co).addFac(nray, t)
        const dis = co2.vectorDistanceSqr(v.co)

        if (dis < rsqr) {
          out.add(v)
        }
      }
    }
  }

  /** length of ray vector is length of cone*/
  facesInCone(
    co: Vector3,
    ray: Vector3,
    radius1: number,
    radius2: number,
    visibleOnly = true,
    isSquare = false,
    out: Set<Face>,
    tris?: Set<BVHTri>
  ) {
    if (!this.leaf) {
      for (const c of this.children!) {
        if (!aabb_cone_isect(co, ray, radius1, radius2, c.min, c.max)) {
          continue
        }

        c.facesInCone(co, ray, radius1, radius2, visibleOnly, isSquare, out, tris)
      }

      return
    }

    const co2 = _fictmp1.load(co).add(ray)
    const ray2 = _fictmp2

    for (const t of this.allTris) {
      const v1 = t.v1
      const v2 = t.v2
      const v3 = t.v3

      let ok = tri_cone_isect(co, co2, radius1, radius2, v1.co, v2.co, v3.co, false)
      if (ok && visibleOnly) {
        ok = false

        for (let i = 0; i < 2; i++) {
          let u = Math.random()
          let v = Math.random()
          let w = Math.random()
          let sum = u + v + w

          if (sum > 0.0) {
            sum = 1.0 / sum
            u *= sum
            v *= sum
            w *= sum
          }

          const co3 = _fictmp3
          const ray3 = _fictmp4

          co3.load(t.v1.co).mulScalar(u)
          co3.addFac(t.v2.co, v)
          co3.addFac(t.v3.co, w)

          ray3.load(ray).negate()
          co3.addFac(ray3, 0.0001)

          const maxdis = co3.vectorDistance(co)
          const isect = this.bvh.castRay(co3, ray3)

          //intersected behind origin?
          if (isect && isect.dist >= maxdis) {
            ok = true
            break
          } else if (!isect) {
            //did we not intersect at all?
            ok = true
            break
          }
        }
      }

      if (ok) {
        if (tris) {
          tris.add(t)
        }

        if (t.l1) {
          out.add(t.l1.f)
        } else if (t.f) {
          out.add(t.f)
        }
      }
    }
  }

  vertsInCone(co: Vector3, ray: Vector3, radius1: number, radius2: number, isSquare: boolean, out: Set<IBVHVertex>) {
    if (!this.leaf) {
      for (const c of this.children!) {
        if (!aabb_cone_isect(co, ray, radius1, radius2, c.min, c.max)) {
          continue
        }

        c.vertsInCone(co, ray, radius1, radius2, isSquare, out)
      }

      return
    }

    const co2 = vttmp1
    const t1 = vttmp2
    const raylen = ray.vectorLength()

    const report = Math.random() > 0.9995

    const nray = vttmp3.load(ray)
    nray.normalize()

    for (let i = 0; i < 2; i++) {
      const set = i ? this.wireVerts : this.uniqueVerts

      if (!set) {
        continue
      }

      for (const v of set) {
        t1.load(v.co).sub(co)
        let t = t1.dot(nray)

        if (t < 0 || t >= raylen) {
          continue
        }

        // project ray origin in plane with vertex
        co2.load(co).addFac(nray, t)

        t /= raylen
        const r = radius1 * (1.0 - t) + radius2 * t
        const rsqr = r * r

        let dis

        if (!isSquare) {
          dis = co2.vectorDistanceSqr(v.co)
        } else {
          co2.sub(v.co)
          dis = (Math.abs(co2[0]) + Math.abs(co2[1]) + Math.abs(co2[2])) / 3.0
          dis *= dis
        }

        if (report) {
          //console.log("r", r, "t", t, "dis", Math.sqrt(dis), "rsqr", rsqr);
        }

        if (dis < rsqr) {
          out.add(v)
        }
      }
    }
  }

  /** Faces whose triangles intersect a frustum (array of inward planes). */
  facesInFrustum(planes: Vector4[], out: Set<Face>, tris?: Set<BVHTri>) {
    if (!this.leaf) {
      for (const c of this.children!) {
        if (!aabb_frustum_isect(planes, c.min, c.max)) {
          continue
        }

        c.facesInFrustum(planes, out, tris)
      }

      return
    }

    for (const t of this.allTris) {
      if (!tri_frustum_isect(planes, t.v1.co, t.v2.co, t.v3.co)) {
        continue
      }

      if (tris) {
        tris.add(t)
      }

      if (t.l1) {
        out.add(t.l1.f)
      } else if (t.f) {
        out.add(t.f)
      }
    }
  }

  /** Verts inside a frustum (array of inward planes). */
  vertsInFrustum(planes: Vector4[], out: Set<IBVHVertex>) {
    if (!this.leaf) {
      for (const c of this.children!) {
        if (!aabb_frustum_isect(planes, c.min, c.max)) {
          continue
        }

        c.vertsInFrustum(planes, out)
      }

      return
    }

    for (let i = 0; i < 2; i++) {
      const set = i ? this.wireVerts : this.uniqueVerts

      if (!set) {
        continue
      }

      for (const v of set) {
        if (point_in_frustum(planes, v.co)) {
          out.add(v)
        }
      }
    }
  }

  closestPoint(p: Vector3, mindis = 1e17): IsectRet | undefined {
    if (!this.leaf) {
      if (this.children!.length === 2) {
        let [c1, c2] = this.children!
        const d1 = aabb_sphere_dist(p, c1.min, c1.max)
        const d2 = aabb_sphere_dist(p, c2.min, c2.max)

        if (c1 > c2) {
          const t = c1
          c1 = c2
          c2 = t
        }

        let r1
        let r2

        if (d1 < mindis) {
          r1 = c1.closestPoint(p, mindis)
          if (r1) {
            mindis = r1.dist
          }
        }

        if (d2 < mindis) {
          r2 = c2.closestPoint(p, mindis)
          if (r2) {
            mindis = r2.dist
          }
        }

        if (r1 && r2) {
          return r1.dist <= r2.dist ? r1 : r2
        } else if (r1) {
          return r1
        } else if (r2) {
          return r2
        } else {
          return undefined
        }
      } else if (this.children!.length === 1) {
        return this.children![0].closestPoint(p, mindis)
      }
    }

    const ret = this._closestRets.next()
    let ok = false

    for (const tri of this.allTris) {
      const cp = closest_point_on_tri(p, tri.v1.co, tri.v2.co, tri.v3.co, tri.no)

      const dis = cp.dist

      if (dis < mindis) {
        ok = true
        mindis = dis

        ret.dist = Math.sqrt(dis)
        ret.uv.load(cp.uv)
        ret.p.load(cp.co)
        ret.tri = tri
        ret.id = tri.id
      }
    }

    if (ok) {
      return ret
    }
  }

  castRay(origin: IVectorOrHigher<3, Vector3>, dir: IVectorOrHigher<3, Vector3>): IsectRet | undefined {
    const ret = this._castRayRets.next()
    let found = false

    if (!this.leaf) {
      for (const c of this.children!) {
        if (!aabb_ray_isect(origin, dir, c.min, c.max)) {
          continue
        }

        const ret2 = c.castRay(origin, dir)
        if (ret2 && (!found || ret2.dist < ret.dist)) {
          found = true
          ret.load(ret2)
        }
      }

      if (found) {
        return ret
      } else {
        return undefined
      }
    }

    for (const t of this.allTris) {
      const isect = ray_tri_isect(origin, dir, t.v1.co, t.v2.co, t.v3.co)

      if (!isect || isect[2] < 0.0) {
        continue
      }

      if (!found || (isect[2] >= 0 && isect[2] < ret.dist)) {
        found = true

        ret.dist = isect[2]
        ret.uv[0] = isect[0]
        ret.uv[1] = isect[1]
        ret.id = t.id
        ret.tri_idx = t.tri_idx
        ret.p.load(origin).addFac(dir, ret.dist)
        ret.tri = t
      }
    }

    if (found) {
      return ret
    }
  }

  addTri_new(
    id: number,
    tri_idx: number,
    v1: IBVHVertex,
    v2: IBVHVertex,
    v3: IBVHVertex,
    noSplit = false,
    l1: OptionalIf<Loop, OPT['grid']>,
    l2: OptionalIf<Loop, OPT['grid']>,
    l3: OptionalIf<Loop, OPT['grid']>
  ): BVHTri {
    const stack = addtri_stack
    let si = 0

    stack[si++] = this

    const centx = (v1.co[0] + v2.co[0] + v3.co[0]) / 3.0
    const centy = (v1.co[1] + v2.co[1] + v3.co[1]) / 3.0
    const centz = (v1.co[2] + v2.co[2] + v3.co[2]) / 3.0

    const tri = this.bvh._getTri(id, tri_idx, v1, v2, v3)

    tri.l1 = l1
    tri.l2 = l2
    tri.l3 = l3

    while (si > 0) {
      const node = stack[--si]

      if (!node) {
        break
      }
      node.tottri++

      if (!node.leaf) {
        let mindis = 1e17
        let closest

        for (let i = 0; i < node.children.length; i++) {
          const c = node.children[i]

          const dx = centx - c.cent[0]
          const dy = centy - c.cent[1]
          const dz = centz - c.cent[2]

          const dis = dx * dx + dy * dy + dz * dz
          if (dis < mindis) {
            closest = c
            mindis = dis
          }
        }

        if (closest) {
          stack[si++] = closest
        }
      } else {
        let test

        if (!noSplit && (test = node.splitTest())) {
          node.split(test)

          if (test > 1) {
            return this.bvh.addTri(id, tri_idx, v1, v2, v3, noSplit, l1, l2, l3, this.bvh.addPass + 1)
          }

          //push node back onto stack if split was successful
          if (!node.leaf) {
            stack[si++] = test > 1 ? this.bvh.root! : node!
            continue
          }
        }

        if (!tri.node) {
          tri.node = node
          node.uniqueTris.add(tri)
        }

        node._pushTri(tri)
      }
    }

    return tri
  }

  addWireVert(v: IBVHVertex) {
    if (!this.leaf) {
      for (const c of this.children!) {
        if (math.point_in_aabb(v.co, c.min, c.max)) {
          c.addWireVert(v)
        }
      }
    } else {
      if (!this.wireVerts) {
        this.wireVerts = new Set()
      }

      this.wireVerts.add(v)

      if (this.otherVerts) {
        this.otherVerts.add(v)
      }

      if (this.wireVerts.size >= this.bvh.leafLimit) {
        this.split(1)
      }
    }
  }

  addTri(
    id: number,
    tri_idx: number,
    v1: IBVHVertex,
    v2: IBVHVertex,
    v3: IBVHVertex,
    noSplit = false,
    l1: OptionalIf<Loop, OPT['grid']>,
    l2: OptionalIf<Loop, OPT['grid']>,
    l3: OptionalIf<Loop, OPT['grid']>
  ): BVHTri {
    //return this.addTri_old(...arguments);
    return this.addTri_new(id, tri_idx, v1, v2, v3, noSplit, l1, l2, l3)
  }

  //try to detect severely deformed nodes and split them
  shapeTest(report = true) {
    let split = false

    if (!this.parent) {
      return 0
    }

    const p = this.parent
    if (p.tottri < this.bvh.leafLimit * 1.75) {
      return 0
    }

    if (this.halfsize[0] === 0.0 || this.halfsize[1] === 0.0 || this.halfsize[2] === 0.0) {
      if (1 || report) {
        console.warn('Malformed node detected', this.halfsize)
      }
      return 0
    }

    if (1) {
      //aspect ratio test
      const ax = this.halfsize[0] / this.halfsize[1]
      const ay = this.halfsize[1] / this.halfsize[2]
      const az = this.halfsize[2] / this.halfsize[0]

      const l2 = 2.0
      const l1 = 1.0 / l2

      split = ax < l1 || ax > l2
      split = split || ay < l1 || ay > l2
      split = split || az < l1 || az > l2

      if (split) {
        if (report) {
          console.warn('Splitting node due to large aspect ratio')
        }

        return 3
      }
    }

    if (0) {
      //area test
      const area1 = this.halfsize[0] * 2 * (this.halfsize[1] * 2) * (this.halfsize[2] * 2)
      const side = 2.25
      const limit = area1 * side * side

      const p = this.parent
      for (const c of p.children!) {
        if (c.tottri < this.bvh.leafLimit >> 2) {
          continue
        }

        const area2 = (c.halfsize[0] * 2) ** 2 + (c.halfsize[1] * 2) ** 2 + (c.halfsize[2] * 2) ** 2
        if (area2 >= limit) {
          split = true

          if (report) {
            console.log('Splitting due to sibling node')
          }
          break
        }
      }
      return split ? 2 : 0
    }
    return 0
  }

  splitTest(depth = 0): number {
    if (!this.leaf) {
      return 0
    }

    const split = this.leaf && this.uniqueTris!.size >= this.bvh.leafLimit && this.depth <= this.bvh.depthLimit

    if (split) {
      return 1
    } else if (this.bvh.addPass > 2 || this.depth >= this.bvh.depthLimit || this.uniqueTris!.size < 1) {
      return 0
    }

    return 0
  }

  _addVert(v: IBVHVertex, cd_node: AttrRef<CDNodeInfo>, isDeforming: boolean) {
    const n = cd_node.get(v)

    if (isDeforming) {
      if (!n.node && math.point_in_hex(v.co, this.boxverts!)) {
        this.uniqueVerts!.add(v)
        n.node = this
      } else {
        this.otherVerts!.add(v)
      }
    } else {
      if (!n.node) {
        this.uniqueVerts!.add(v)
        n.node = this
      } else {
        this.otherVerts!.add(v)
      }
    }
  }

  _pushTri(tri: BVHTri) {
    const cd_node = this.bvh.cd_node
    const isDef = this.bvh.isDeforming

    this._addVert(tri.v1, cd_node, isDef)
    this._addVert(tri.v2, cd_node, isDef)
    this._addVert(tri.v3, cd_node, isDef)

    if (!tri.node) {
      tri.node = this
      this.uniqueTris!.add(tri)
    } else {
      this.otherTris!.add(tri)
      //this.uniqueTris.add(tri);
    }

    tri.nodes.push(this)

    this.allTris.add(tri)

    let updateflag = BVHFlags.UPDATE_INDEX_VERTS
    updateflag |= BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_BOUNDS
    updateflag |= BVHFlags.UPDATE_TOTTRI

    this.setUpdateFlag(updateflag)

    return tri
  }

  updateUniqueVerts() {
    //console.error("update unique verts");

    this.flag &= ~BVHFlags.UPDATE_UNIQUE_VERTS_2

    if (!this.leaf) {
      for (const c of this.children!) {
        c.updateUniqueVerts()
      }

      return
    }

    this.uniqueVerts = new Set()
    this.otherVerts = new Set()

    const cd_node = this.bvh.cd_node
    const isDeforming = this.bvh.isDeforming

    for (const tri of this.allTris) {
      for (let i = 0; i < 3; i++) {
        const v = tri.vs[i]

        if (!v) {
          console.warn('Tri error!')
          this.allTris.delete(tri)
          break
        }

        const cdn = cd_node.get(v)

        if (cdn.node === this) {
          cdn.node = undefined as unknown as BVHNode
        }

        this._addVert(v, cd_node, isDeforming)
      }
    }
  }

  updateNormalsGrids = function (this: BVHNode<OPT & {dead: false}>) {
    const mesh = this.bvh.mesh
    const cd_grid = this.bvh.cd_grid

    const ls = new Set<Loop>()

    let hasBoundary = false
    for (const v of this.uniqueVerts!) {
      const lEid = (v as unknown as any).loopEid as number | undefined
      const l = lEid !== undefined ? mesh.eidMap.get(lEid) : undefined

      hasBoundary = hasBoundary || (v as unknown as any).bLink !== undefined

      if (l === undefined) {
        continue
      }

      ls.add(l as Loop)
    }

    if (0 && hasBoundary) {
      for (const l of new Set(ls)) {
        ls.add(l)
        ls.add(l.radial_next)
        ls.add(l.radial_next.next)
        ls.add(l.radial_next.prev)
        ls.add(l.prev.radial_next)
        ls.add(l.prev.radial_next.next)
        ls.add(l.prev)
        ls.add(l.next)
      }
    }

    for (const tri of this.uniqueTris!) {
      tri.no.load(math.normal_tri(tri.v1.co, tri.v2.co, tri.v3.co))
      tri.area = math.tri_area(tri.v1.co, tri.v2.co, tri.v3.co)
    }

    for (const l of ls) {
      const grid = cd_grid.get(l)

      grid.flagNormalsUpdate()
      this.bvh.updateGridLoops.add(l)
    }

    /*
    for (let v of this.uniqueVerts) {
      for (let v2 of v.neighbors) {
        if (v2.loopEid !== v.loopEid) {
         for (let v3 of v2.neighbors) {
           if (v3.loopEid !== v2.loopEid) {
             continue;
           }

           v.no.add(v3.no);
         }
        } else {
          v.no.add(v2.no);
        }
      }

      v.no.normalize();
    }
    //*/

    return
    const vs = new Set<Vertex>()
    const fs = new Set<Face>()

    for (const tri of this.uniqueTris!) {
      //stupid hack to get better normals along grid seams
      /*
      let d = 4;
      tri.v1.no.mulScalar(d);
      tri.v2.no.mulScalar(d);
      tri.v3.no.mulScalar(d);
      //*/

      //*
      tri.v1.no.zero()
      tri.v2.no.zero()
      tri.v3.no.zero()
      //*/

      const l1 = mesh.eidMap.get((tri.v1 as any).loopEid as number) as Loop
      const l2 = mesh.eidMap.get((tri.v2 as any).loopEid as number) as Loop
      const l3 = mesh.eidMap.get((tri.v3 as any).loopEid as number) as Loop

      if (l1) {
        vs.add(l1.v)
        fs.add(l1.f)
      }
      if (l2) {
        vs.add(l1.v)
        fs.add(l1.f)
      }
      if (l3) {
        vs.add(l1.v)
        fs.add(l1.f)
      }
    }

    for (const v of vs) {
      v.no.zero()
    }

    for (const f of fs) {
      f.calcNormal()
      for (const v of f.verts) {
        v.no.add(f.no)
      }
    }

    for (const v of vs) {
      v.no.normalize()
    }

    const n = new Vector3()

    for (const tri of this.uniqueTris!) {
      const n2 = math.normal_tri(tri.v1.co, tri.v2.co, tri.v3.co)

      tri.no.load(n2)
      tri.v1.no.add(n2)
      tri.v2.no.add(n2)
      tri.v3.no.add(n2)
    }

    function doBoundary(v: GenericGridVert) {
      if (!v.bLink) {
        return
      }

      if (v.bLink.v2) {
        n.load(v.bLink.v1.no).interp(v.bLink.v2.no, v.bLink.t)
        n.normalize()
        n.interp(v.no, 0.5)
        v.no.load(n).normalize()
      } else {
        n.load(v.bLink.v1.no).interp(v.no, 0.5)
        n.normalize()

        v.no.load(n)
        v.bLink.v1.no.load(n)
      }
    }

    for (const tri of this.uniqueTris!) {
      tri.v1.no.normalize()
      tri.v2.no.normalize()
      tri.v3.no.normalize()

      doBoundary(tri.v1 as GenericGridVert)
      doBoundary(tri.v2 as GenericGridVert)
      doBoundary(tri.v3 as GenericGridVert)
    }

    /*
    for (let p1 of this.uniqueVerts) {
      for (let p2 of p1.neighbors) {
        p1.no.add(p2.no);
      }
      p1.no.normalize();
    }*/
  }

  updateNormals = function (this: BVHNode<{leaf: true}>) {
    this.flag &= ~BVHFlags.UPDATE_NORMALS

    //for (let tri of this.uniqueTris) {
    //  tri.area = math.tri_area(tri.v1.co, tri.v2.co, tri.v3.co) + 0.00001;
    //}

    if (this.bvh.cd_grid.exists) {
      this.updateNormalsGrids()
      return
    }

    const eidMap = this.bvh.mesh.eidMap

    for (const t of this.uniqueTris) {
      let bad = !t.v1 || !t.v2 || !t.v3 || t.v1.eid < 0 || t.v2.eid < 0 || t.v3.eid < 0

      bad = bad || isNaN(t.v1.co.dot(t.v1.co))
      bad = bad || isNaN(t.v2.co.dot(t.v2.co))
      bad = bad || isNaN(t.v3.co.dot(t.v3.co))

      if (bad) {
        safeprint(0, 'corrupted tri', t)

        this.uniqueTris!.delete(t)
        continue
      }

      const no = math.normal_tri(t.v1.co, t.v2.co, t.v3.co)

      t.no[0] = no[0]
      t.no[1] = no[1]
      t.no[2] = no[2]

      t.area = math.tri_area(t.v1.co, t.v2.co, t.v3.co) + 0.00001

      //let d = t.no.dot(t.no);

      //let ok = Math.abs(t.area) > 0.00001 && !isNaN(t.area);
      //ok = ok && isFinite(t.area) && d > 0.0001;
      //ok = ok && !isNaN(d) && isFinite(d);

      //ensure non-zero t.area
      //t.area = Math.max(Math.abs(t.area), 0.00001) * Math.sign(t.area);

      //if (!ok) {
      //continue;
      //}

      let f

      if (t.l1) {
        f = t.l1.f
      } else {
        f = eidMap.get<Face>(t.id)
      }

      if (f !== undefined) {
        if (f.no === undefined) {
          //eek!

          f.no = new Vector3()

          console.warn(f, f.no)
          throw new Error('eek!')
        }

        f.no[0] = t.no[0]
        f.no[1] = t.no[1]
        f.no[2] = t.no[2]
      }
    }

    for (const bvhv of this.uniqueVerts) {
      const v = bvhv as Vertex
      const no = v.no
      let x = 0
      let y = 0
      let z = 0
      let ok = false

      for (const e of v.edges) {
        if (!e.l) {
          continue
        }

        let l = e.l
        let _i = 0

        do {
          const fno = l.f.no
          const fx = fno[0]
          const fy = fno[1]
          const fz = fno[2]

          if (fx * fx + fy * fy + fz * fz < 0.0001) {
            l.f.calcNormal()
          }

          x += fx
          y += fy
          z += fz

          ok = true

          if (_i++ > 32) {
            console.warn('Infinite loop detected')
            break
          }

          l = l.radial_next
        } while (l !== e.l)
      }

      if (ok) {
        no[0] = x
        no[1] = y
        no[2] = z

        no.normalize()
      }
    }
  }

  updateIndexVertsGrids = function (this: BVHNode<OPT & {dead: false}>) {
    this.indexVerts = []
    this.indexLoops = []
    this.indexTris = []
    this.indexEdges = []
    const vlist = this.indexVerts!
    const llist = this.indexLoops!
    const trimap = this.indexTris!
    const emap = this.indexEdges!

    const computeValidEdges = this.bvh.computeValidEdges

    const cd_grid = this.bvh.cd_grid

    const edgeExists = (v1: GenericGridVert, v2: GenericGridVert) => {
      if (!computeValidEdges) {
        return true
      }

      for (const v3 of v1.neighbors) {
        if (v3 === v2) {
          return true
        }
      }

      for (const v3 of v2.neighbors) {
        if (v3 === v1) {
          console.warn('Neighbor error!')
          for (let i = 0; i < 2; i++) {
            const v = i ? v2 : v1
            if (v.loopEid === undefined) {
              console.warn('Missing loop!', v.loopEid, v)
              continue
            }

            const l = this.bvh.mesh.eidMap.get<Loop>(v.loopEid)
            if (l?.type !== MeshTypes.LOOP) {
              console.warn('Missing loop', v.loopEid, v)
              continue
            }

            cd_grid.get(l).flagFixNeighbors()
          }
          return true
        }
      }

      return false
    }

    for (const v of this.uniqueVerts!) {
      v.index = vlist.length

      vlist.push(v)
      llist.push(v)
    }

    for (const v of this.otherVerts!) {
      v.index = vlist.length
      vlist.push(v)
      llist.push(v)
    }

    for (const tri of this.uniqueTris!) {
      trimap.push(tri.v1.index)
      trimap.push(tri.v2.index)
      trimap.push(tri.v3.index)

      if (edgeExists(tri.v1 as GenericGridVert, tri.v2 as GenericGridVert)) {
        emap.push(tri.v1.index)
        emap.push(tri.v2.index)
      }

      if (edgeExists(tri.v2 as GenericGridVert, tri.v3 as GenericGridVert)) {
        emap.push(tri.v2.index)
        emap.push(tri.v3.index)
      }

      if (edgeExists(tri.v3 as GenericGridVert, tri.v1 as GenericGridVert)) {
        emap.push(tri.v3.index)
        emap.push(tri.v1.index)
      }
    }
  }

  updateIndexVerts = function (this: BVHNode<{grid: true; leaf: true}>) {
    if (this.bvh.cd_grid.exists) {
      return this.updateIndexVertsGrids()
    }

    const computeValidEdges = this.bvh.computeValidEdges
    const hideQuadEdges = this.bvh.hideQuadEdges
    const quadflag = MeshFlags.QUAD_EDGE
    const isDef = this.bvh.isDeforming

    this.indexVerts = []
    this.indexLoops = []

    this.indexTris = []
    this.indexEdges = []

    const mesh = this.bvh.mesh

    for (const tri of this.uniqueTris! as Set<BVHTri<{grid: false}>>) {
      tri.v1.index = tri.v2.index = tri.v3.index = -1
      tri.l1.index = tri.l2.index = tri.l3.index = -1
    }

    const cd_fset = getFaceSets(mesh, false)

    let cdlayers = mesh.loops.customData.flatlist
    cdlayers = cdlayers.filter((cdl) => !(cdl.flag & (CDFlags.TEMPORARY | CDFlags.IGNORE_FOR_INDEXBUF)))

    let bridgeTris
    const dflag = MeshFlags.MAKE_FACE_TEMP
    let bridgeIdxMap

    if (isDef && DEFORM_BRIDGE_TRIS) {
      bridgeTris = new Set()
      bridgeIdxMap = new Map()

      this.boxbridgetris = {
        indexVerts: [],
        indexLoops: [],
        indexTris : [],
        indexEdges: [],
      }

      for (const v of this.uniqueVerts!) {
        v.flag &= ~dflag
        v.index = -1
      }

      for (const v of this.otherVerts!) {
        v.flag |= dflag
        v.index = -1
      }
    } else {
      for (const v of this.uniqueVerts!) {
        v.flag &= ~dflag
      }
      for (const v of this.otherVerts!) {
        v.flag &= ~dflag
      }
    }

    //simple code path for if there's no cd layer to build islands out of
    if (cd_fset < 0 && cdlayers.length === 0) {
      let vi = 0

      if (!isDef || !DEFORM_BRIDGE_TRIS) {
        for (let step = 0; step < 2; step++) {
          const indexVerts = this.indexVerts!
          const indexLoops = this.indexLoops!

          for (const tri of this.uniqueTris!) {
            tri.v1.index = tri.v2.index = tri.v3.index = -1
          }
          for (const tri of this.uniqueTris!) {
            for (let i = 0; i < 3; i++) {
              const v = tri.vs[i] as Vertex

              if (v.index !== -1) {
                continue
              }

              for (const e of v.edges) {
                if (e.l) {
                  indexLoops.push(e.l)
                  break
                }
              }

              v.index = vi++
              indexVerts.push(v)
            }
          }

          if (0) {
            const list = step ? this.otherVerts! : this.uniqueVerts!

            for (const bvhv of list) {
              const v = bvhv as Vertex
              let ok = false

              for (const e of v.edges) {
                if (e.l) {
                  ok = true
                  indexLoops.push(e.l)
                  break
                }
              }

              if (ok) {
                v.index = vi++
                indexVerts.push(v)
              }
            }
          }
        }
      } else {
        for (const bvhv of this.uniqueVerts!) {
          const v = bvhv as Vertex

          if (v.eid < 0) {
            console.warn('Bad vertex in bvh node', v)
            continue
          }

          let ok = false

          for (const e of v.edges) {
            if (e.l) {
              ok = true
              this.indexLoops.push(e.l)
              break
            }
          }

          if (ok) {
            v.index = this.indexVerts.length
            this.indexVerts.push(v)
          }
        }

        //deal with deform bridge tris
        for (const tri of this.allTris) {
          let ok = false

          for (let i = 0; i < 3; i++) {
            if (tri.vs[i].eid < 0) {
              console.warn('Bad tri in bvh node', tri, tri.vs[i])
              ok = false
              break
            }

            if (tri.vs[i].flag & dflag) {
              ok = true
            }
          }

          if (!ok) {
            continue
          }

          for (let i = 0; i < 3; i++) {
            const v = tri.vs[i]
            let l

            switch (i) {
              case 0:
                l = tri.l1
                break
              case 1:
                l = tri.l2
                break
              case 2:
                l = tri.l3
                break
            }

            let indexLoops
            let indexVerts

            if (v.flag & dflag) {
              if (v.index < 0) {
                v.index = this.boxbridgetris.indexVerts.length
                this.boxbridgetris.indexVerts.push(v)
                this.boxbridgetris.indexLoops.push(l)
              }
            } else if (!bridgeIdxMap!.has(v)) {
              const idx = this.boxbridgetris.indexVerts.length
              this.boxbridgetris.indexVerts.push(v)
              this.boxbridgetris.indexLoops.push(l)

              bridgeIdxMap!.set(v, idx)
            }
          }
        }
      }

      const deadtris = new Set<BVHTri>()

      /*
      this.indexTris.length = 0;
      this.indexVerts.length = 0;
      this.indexLoops.length = 0;
      this.indexEdges.length = 0;
      //*/

      for (const tri of this.uniqueTris!) {
        let indexVerts
        let indexLoops
        let indexTris
        let indexEdges

        let i1: number
        let i2: number
        let i3: number

        if (this.boxbridgetris && (tri.v1.flag | tri.v2.flag | tri.v3.flag) & dflag) {
          if (bridgeIdxMap) {
            i1 = !(tri.v1.flag & dflag) ? bridgeIdxMap.get(tri.v1) : tri.v1.index
            i2 = !(tri.v2.flag & dflag) ? bridgeIdxMap.get(tri.v2) : tri.v2.index
            i3 = !(tri.v3.flag & dflag) ? bridgeIdxMap.get(tri.v3) : tri.v3.index
          } else {
            i1 = tri.v1.index
            i2 = tri.v2.index
            i3 = tri.v3.index
          }

          if (bridgeTris) {
            bridgeTris.add(tri)
          }

          indexVerts = this.boxbridgetris.indexVerts
          indexLoops = this.boxbridgetris.indexLoops
          indexTris = this.boxbridgetris.indexTris
          indexEdges = this.boxbridgetris.indexEdges
        } else {
          i1 = tri.v1.index
          i2 = tri.v2.index
          i3 = tri.v3.index

          indexVerts = this.indexVerts
          indexLoops = this.indexLoops
          indexTris = this.indexTris
          indexEdges = this.indexEdges
        }

        if (tri.v1.index < 0 || tri.v2.index < 0 || tri.v3.index < 0) {
          if (tri.v1.eid < 0 || tri.v2.eid < 0 || tri.v3.eid < 0) {
            console.warn('Tri index buffer error', tri)
            deadtris.add(tri)
            continue
          }

          console.warn('Missing vertex in tri index buffer!', tri.v1.index, tri.v2.index, tri.v3.index)

          if (tri.l1.eid < 0 || tri.l2.eid < 0 || tri.l3.eid < 0) {
            console.warn('Tri index buffer error 2')
            deadtris.add(tri)
            continue
          }

          if (tri.v1.index < 0) {
            i1 = tri.v1.index = vi++
            indexVerts.push(tri.v1)
            indexLoops.push(tri.l1)
            this.otherVerts!.add(tri.v1)
          }

          if (tri.v2.index < 0) {
            i2 = tri.v2.index = vi++
            indexVerts.push(tri.v2)
            indexLoops.push(tri.l2)
            this.otherVerts!.add(tri.v2)
          }

          if (tri.v3.index < 0) {
            i3 = tri.v3.index = vi++
            indexVerts.push(tri.v3)
            indexLoops.push(tri.l3)
            this.otherVerts!.add(tri.v3)
          }
          //continue;
        }

        indexTris.push(i1)
        indexTris.push(i2)
        indexTris.push(i3)

        if (validEdge(tri.v1, tri.v2)) {
          indexEdges.push(i1)
          indexEdges.push(i2)
        }

        if (validEdge(tri.v2, tri.v3)) {
          indexEdges.push(i2)
          indexEdges.push(i3)
        }

        if (validEdge(tri.v3, tri.v1)) {
          indexEdges.push(i3)
          indexEdges.push(i1)
        }
      }

      if (deadtris.size > 0) {
        for (const v of this.uniqueVerts!) {
          if (v.eid < 0) {
            this.uniqueVerts!.delete(v)
          }
        }

        for (const v of this.otherVerts!) {
          if (v.eid < 0) {
            this.otherVerts.delete(v)
          }
        }
      }

      for (const tri of deadtris) {
        this.uniqueTris.delete(tri)
        this.bvh.removeTri(tri)
      }

      return
    }

    const ls = new Set<Loop>()
    const vs = new Set<Vertex>()

    function validEdge(v1: IBVHVertex, v2: IBVHVertex) {
      if (v1.eid < 0 || v2.eid < 0) {
        return false
      }

      if (!computeValidEdges) {
        return true
      }

      const e = v1 instanceof Vertex && v2 instanceof Vertex && mesh.getEdge(v1 as Vertex, v2 as Vertex)
      if (!e) {
        return false
      }

      if (hideQuadEdges && e.flag & quadflag) {
        return false
      }

      return true
    }

    for (const tri of this.uniqueTris) {
      if (tri.l1.eid >= 0 && tri.l2.eid >= 0 && tri.l3.eid >= 0) {
        vs.add(tri.v1 as Vertex)
        vs.add(tri.v2 as Vertex)
        vs.add(tri.v3 as Vertex)

        ls.add(tri.l1)
        ls.add(tri.l2)
        ls.add(tri.l3)
      }
    }

    const lmap = new Map()
    const lmap2 = new Map()

    let idxbase = 0

    for (const v of vs) {
      let hash
      let cdata

      for (const e of v.edges) {
        for (let l of e.loops) {
          if (l.eid < 0 || l.v.eid < 0) {
            console.warn('bvh corruption', l)
            continue
          }

          if (l.v !== v) {
            l = l.next.v === v ? l.next : l.prev
          }

          //let key = "" + v.eid;
          let key = v.eid

          for (const layer of cdlayers) {
            const data = l.customData[layer.index]
            const hash2 = data.hash(layer.islandSnapLimit) ?? 0

            key = ~~(key ^ hash2)

            //key += ":" + hash2;
          }

          if (cd_fset >= 0) {
            let fset = l.f.customData.get<IntElem>(cd_fset).value
            fset = (fset * 2343 + 234234) % 65535

            key = ~~(key ^ fset)
          }

          let idx
          if (!lmap.has(key)) {
            idx = idxbase++

            if (!isDef || !DEFORM_BRIDGE_TRIS || this.uniqueVerts.has(l.v)) {
              this.indexVerts.push(l.v)
              this.indexLoops.push(l)
            } else {
              this.boxbridgetris.indexVerts.push(l.v)
              this.boxbridgetris.indexLoops.push(l)
            }

            lmap.set(key, l)
          } else {
            idx = lmap.get(key).index
          }

          l.index = idx
        }
      }
    }

    for (const l of ls) {
      if (l.eid < 0 || l.v.eid < 0) {
        console.error('BVH loop corruption', l, l.eid, l.v.eid)
        continue
      }

      if (l.index < 0) {
        l.index = idxbase++

        if (!isDef || !DEFORM_BRIDGE_TRIS || this.uniqueVerts.has(l.v)) {
          this.indexVerts.push(l.v)
          this.indexLoops.push(l)
        } else {
          this.boxbridgetris.indexVerts.push(l.v)
          this.boxbridgetris.indexLoops.push(l)
        }
      }
    }

    //make sure indices are correct in deform mode,
    //which builds two seperate sets of triangles
    if (isDef && DEFORM_BRIDGE_TRIS) {
      let i = 0

      i = 0
      for (const l of this.indexLoops) {
        l.index = i++
      }

      i = 0
      for (const l of this.boxbridgetris.indexLoops) {
        l.index = i++
      }
    }

    this.indexTris = []
    this.indexEdges = []
    let idxmap = this.indexTris
    let eidxmap = this.indexEdges

    for (const tri of this.uniqueTris) {
      let bad = tri.l1.index < 0 || tri.l2.index < 0 || tri.l3.index < 0
      bad = bad || tri.l1.eid < 0 || tri.l2.eid < 0 || tri.l3.eid < 0
      bad = bad || tri.v1.eid < 0 || tri.v2.eid < 0 || tri.v3.eid < 0

      if (bad) {
        console.warn('Tri index buffer error')
        continue
      }

      if ((tri.v1.flag | (tri.v2.flag & tri.v3.flag)) & dflag) {
        idxmap = this.boxbridgetris.indexTris
        eidxmap = this.boxbridgetris.indexEdges
      } else {
        idxmap = this.indexTris
        eidxmap = this.indexEdges
      }

      idxmap.push(tri.l1.index)
      idxmap.push(tri.l2.index)
      idxmap.push(tri.l3.index)

      if (validEdge(tri.v1, tri.v2)) {
        eidxmap.push(tri.l1.index)
        eidxmap.push(tri.l2.index)
      }

      if (validEdge(tri.v2, tri.v3)) {
        eidxmap.push(tri.l2.index)
        eidxmap.push(tri.l3.index)
      }

      if (validEdge(tri.v3, tri.v1)) {
        eidxmap.push(tri.l3.index)
        eidxmap.push(tri.l1.index)
      }
    }

    //console.log("lmap", lmap, vs.size);
  }

  updateOtherVerts = function (this: BVHNode<{leaf: true}>) {
    this.flag &= ~BVHFlags.UPDATE_OTHER_VERTS

    const othervs = (this.otherVerts = new Set())

    //just do uniqueTris, otherVerts is used to calculate index
    //buffers for gl
    for (const tri of this.uniqueTris) {
      if (!this.uniqueVerts.has(tri.v1)) {
        othervs.add(tri.v1)
      }

      if (!this.uniqueVerts.has(tri.v2)) {
        othervs.add(tri.v2)
      }

      if (!this.uniqueVerts.has(tri.v3)) {
        othervs.add(tri.v3)
      }
    }
  }

  update = function (this: BVHNode<OPT & {dead: false}>, boundsOnly = false) {
    this.flag &= ~BVHFlags.UPDATE_BOUNDS

    if (this.leaf && this.flag & BVHFlags.UPDATE_INDEX_VERTS) {
      const leafThis = this as BVHNode<{leaf: true; grid: OPT['grid']}>

      for (const tri of leafThis.uniqueTris) {
        if (!tri.v1 || !tri.v2 || !tri.v3) {
          console.warn('Corrupted tri in bvh', tri)
          leafThis.uniqueTris.delete(tri)
        }
      }
    }

    if (isNaN(this.min.dot(this.max))) {
      //throw new Error("eek!");
      console.error('NAN!', this, this.min, this.max)
      this.min.zero().subScalar(0.01)
      this.max.zero().addScalar(0.01)
    }

    if (!boundsOnly && this.leaf) {
      const leafThis = this as BVHNode<{leaf: true; grid: OPT['grid']}>

      let doidx = !!(this.flag & BVHFlags.UPDATE_INDEX_VERTS)
      doidx = doidx && !(this.flag & BVHFlags.UPDATE_UNIQUE_VERTS)

      if (this.flag & BVHFlags.UPDATE_UNIQUE_VERTS) {
        this.flag |= BVHFlags.UPDATE_INDEX_VERTS

        for (const v of leafThis.uniqueVerts) {
          const node = this.bvh!.cd_node.get(v) as CDNodeInfo<{dead: true}>
          node.node = undefined
        }

        this.flag &= ~BVHFlags.UPDATE_UNIQUE_VERTS
        this.flag |= BVHFlags.UPDATE_UNIQUE_VERTS_2
      } else if (this.flag & BVHFlags.UPDATE_UNIQUE_VERTS_2) {
        this.flag &= ~BVHFlags.UPDATE_UNIQUE_VERTS_2
        this.updateUniqueVerts()
      }

      if (this.flag & BVHFlags.UPDATE_OTHER_VERTS) {
        this.flag &= ~BVHFlags.UPDATE_OTHER_VERTS
        leafThis.updateOtherVerts()
      }

      if (this.flag & BVHFlags.UPDATE_NORMALS) {
        leafThis.updateNormals()
      }

      if (doidx) {
        if (this.bvh.isDeforming && !this.boxvdata) {
          //no bind data? delay update.
          if (Math.random() > 0.8) {
            console.warn('No bind data; delaying construction of gpu index buffers')
          }
        } else {
          this.flag &= ~BVHFlags.UPDATE_INDEX_VERTS
          leafThis.updateIndexVerts()
        }
      }
    }

    //return;
    //if (!boundsOnly) {
    //  return;
    //}

    if (!this.leaf && this.children.length > 0) {
      for (const c of this.children) {
        c.update()

        this.min.min(c.min)
        this.max.max(c.max)
      }

      //let pad = this.min.vectorDistance(this.max)*0.00001;
      //let pad = 0.00001;
      //this.min.subScalar(pad);
      //this.max.addScalar(pad);

      this.cent.load(this.min).interp(this.max, 0.5)
      this.halfsize.load(this.max).sub(this.min).mulScalar(0.5)
    } else if (this.leaf) {
      const leafThis = this as BVHNode<OPT & {leaf: true}>
      const min = this.min
      const max = this.max

      const omin = new Vector3(min)
      const omax = new Vector3(max)
      let size = max[0] - min[0] + (max[1] - min[1]) + (max[2] - min[2])
      size /= 3.0

      min.zero().addScalar(1e17)
      max.zero().addScalar(-1e17)

      let tot = 0

      if (leafThis.wireVerts) {
        for (const v of leafThis.wireVerts) {
          min.min(v.co)
          max.max(v.co)
          tot++
        }
      }

      for (const tri of leafThis.uniqueTris) {
        if (!tri.v1) {
          leafThis.uniqueTris.delete(tri)
          continue
        }

        min.min(tri.v1.co)
        max.max(tri.v1.co)

        min.min(tri.v2.co)
        max.max(tri.v2.co)

        min.min(tri.v3.co)
        max.max(tri.v3.co)

        tot++
      }

      if (tot === 0) {
        size = 0.01
        min.zero().addScalar(-size * 0.5)
        max.zero().addScalar(size * 0.5)
        //min.load(omin);
        //max.load(omax);
      } else {
        //let pad = this.nodePad;
        //let pad = min.vectorDistance(max) * 0.001;
        //this.min.subScalar(pad);
        //this.max.addScalar(pad);
      }

      if (this.max.vectorDistance(this.min) < 0.00001) {
        //XXX
        this.min.subScalar(0.0001)
        this.max.addScalar(0.0001)
      }

      this.cent.load(this.min).interp(this.max, 0.5)
      this.halfsize.load(this.max).sub(this.min).mulScalar(0.5)
    }
  }

  // XXX what is this?
  remTri(id: number) {}
}

let bvhidgen = 0

export interface BVHConstructor<BVHType> {
  new (): BVHType

  nodeClass: BVHNode
}

export class BVH<
  OPT extends {
    grid?: true | false //
    dead?: true | false
  } = {dead: false},
> {
  sampler: ISurfaceSampler

  cd_node: AttrRef<CDNodeInfo>
  min: Vector3
  max: Vector3
  glLeafTex: any
  _id: number
  nodeVerts: BVHNodeVertex[]
  nodeEdges: BVHNodeEdge[]
  nodeVertHash: Map<string, BVHNodeVertex>
  nodeEdgeHash: Map<string, BVHNodeEdge>
  _node_elem_idgen: number

  isDeforming: boolean
  totTriAlloc: number
  totTriFreed: number

  static nodeClass = BVHNode

  cd_orig: number
  origGen: number
  dead: boolean
  freelist: BVHTri<OPT & {dead: true}>[]

  needsIndexRebuild: boolean
  hideQuadEdges: boolean
  computeValidEdges: boolean

  tottri: number
  addPass: number
  flag: number
  updateNodes: OptionalIf<Set<BVHNode<OPT>>, OPT['dead']>
  updateGridLoops: Set<Loop>
  mesh: OptionalIf<Mesh, OPT['dead']>
  node_idgen: number

  forceUniqueTris: boolean
  storeVerts: boolean
  leafLimit: number
  drawLevelOffset: number
  depthLimit: number
  nodes: OptionalIf<BVHNode[], OPT['dead']>
  node_idmap: OptionalIf<Map<number, BVHNode>, OPT['dead']>
  root: OptionalIf<BVHNode, OPT['dead']>

  tri_idgen: number
  cd_grid: AttrRef<GridBase>
  tris: OptionalIf<Map<number, BVHTri<OPT>>, OPT['dead']>
  fmap: OptionalIf<Map<number, BVHTri<OPT>[]>, OPT['dead']>
  dirtemp: Vector3
  _i: number
  getOrigCo: (v: IBVHVertex) => Vector3 = (v) => v.co

  constructor(mesh: Mesh, min: Vector3, max: Vector3, tottri = 0) {
    this.min = new Vector3(min)
    this.max = new Vector3(max)

    this.glLeafTex = undefined

    this._id = bvhidgen++

    this.nodeVerts = []
    this.nodeEdges = []
    this.nodeVertHash = new Map()
    this.nodeEdgeHash = new Map()
    this._node_elem_idgen = 0

    this.isDeforming = false

    this.totTriAlloc = 0
    this.totTriFreed = 0

    this.cd_orig = -1
    this.origGen = 0

    this.dead = false

    this.freelist = []

    this.needsIndexRebuild = false
    this.hideQuadEdges = false
    this.computeValidEdges = false //when building indexed draw buffers, only add edges that really exist in mesh

    this.tottri = 0
    this.addPass = 0

    this.flag = 0
    this.updateNodes = new Set()
    this.updateGridLoops = new Set()

    this.mesh = mesh

    this.node_idgen = 1

    this.forceUniqueTris = false
    this.storeVerts = false

    this.leafLimit = 256
    this.drawLevelOffset = 1
    this.depthLimit = 18

    this.nodes = []
    this.node_idmap = new Map()
    this.root = this._newNode(min, max)

    //note that ids are initially just the indices within mesh.loopTris
    this.tri_idgen = 0

    this.cd_node = new AttrRef(-1)
    this.cd_grid = new AttrRef(-1)

    //this.cd_face_node = -1;
    this.tris = new Map()
    this.fmap = new Map()

    this.mesh = mesh
    this.dirtemp = new Vector3()

    this._i = 0

    this.sampler = {
      rayCast: (origin: Vector3, direction: Vector3) => {
        const result = this.castRay(origin, direction)
        if (result !== undefined) {
          const ret = surfaceCastRets.next()

          const u = result.uv[0]
          const v = result.uv[1]
          const w = 1.0 - (u + v)

          const normal = normalRets.next().zero()
          normal.addFac(result.tri!.v1!.no, u)
          normal.addFac(result.tri!.v2!.no, v)
          normal.addFac(result.tri!.v3!.no, w)
          normal.normalize()

          const o1 = this.getOrigCo(result.tri!.v1)
          const o2 = this.getOrigCo(result.tri!.v2)
          const o3 = this.getOrigCo(result.tri!.v3)

          const orig = ret.origp.zero()
          orig.addFac(o1, u)
          orig.addFac(o2, v)
          orig.addFac(o3, w)

          const co1 = result.tri!.v1!.co
          const co2 = result.tri!.v2!.co
          const co3 = result.tri!.v3!.co

          const d1 = co1.vectorDistanceSqr(result.p)
          const d2 = co2.vectorDistanceSqr(result.p)
          const d3 = co3.vectorDistanceSqr(result.p)

          let vertexIndex = result.tri!.v1!.eid
          if (d2 <= d1 && d2 <= d3) {
            vertexIndex = result.tri!.v2!.eid
          } else if (d3 <= d1 && d3 <= d2) {
            vertexIndex = result.tri!.v3!.eid
          }

          ret.dis = result.dist
          ret.tri = result.tri_idx
          ret.normal.load(normal)
          ret.vertex = vertexIndex
          ret.face = result.tri!.f!.eid
          ret.p.load(result.p)
          ret.uv.load(result.uv)
          return ret
        }
      },
    }
    if (this.constructor === BVH) {
      Object.seal(this)
    }
  }

  get leaves() {
    const this2 = this as BVH<OPT & {dead: false}>

    return (function* () {
      for (const n of this2.nodes) {
        if (n.leaf) {
          yield n
        }
      }
    })()
  }

  /*
  get leafLimit() {
    return this._leafLimit;
  }

  set leafLimit(v) {
    console.error("leafLimit set", v);
    this._leafLimit = v;
  }
  //*/

  static create<BVHType extends BVH = BVH>(mesh: Mesh, args: IBVHCreateArgs = {}): BVHType {
    const times: (number | string)[] = [util.time_ms()] //0

    const storeVerts = args.storeVerts ?? true
    const leafLimit = args.leafLimit
    const depthLimit = args.depthLimit
    const addWireVerts = args.addWireVerts
    const deformMode = args.deformMode
    const useGrids = args.useGrids ?? true
    const freelist = args.freelist
    const onCreate = args.onCreate

    mesh.updateMirrorTags()

    times.push(util.time_ms()) //1

    const cdname = this.name

    if (!mesh.verts.customData.hasNamedLayer(cdname, CDNodeInfo)) {
      mesh.verts.addCustomDataLayer(CDNodeInfo, cdname).flag |= CDFlags.TEMPORARY
    }

    if (useGrids && GridBase.meshGridOffset(mesh) >= 0) {
      if (!mesh.loops.customData.hasNamedLayer(cdname, CDNodeInfo)) {
        mesh.loops.addCustomDataLayer(CDNodeInfo, cdname).flag |= CDFlags.TEMPORARY
      }
    }

    /*
    if (!mesh.faces.customData.hasNamedLayer(cdname, CDNodeInfo)) {
      mesh.faces.addCustomDataLayer(CDNodeInfo, cdname).flag |= CDFlags.TEMPORARY;
    }*/

    times.push(util.time_ms()) //2

    let aabb = mesh.getBoundingBox(useGrids)

    times.push(util.time_ms()) //3

    if (!aabb) {
      const d = 1
      aabb = [new Vector3([-d, -d, -d]), new Vector3([d, d, d])]
    }

    aabb[0] = new Vector3(aabb[0])
    aabb[1] = new Vector3(aabb[1])

    const pad = Math.max(aabb[0].vectorDistance(aabb[1]) * 0.001, 0.001)

    aabb[0].subScalar(pad)
    aabb[1].addScalar(pad)

    const cd_grid = useGrids ? GridBase.meshGridRef(mesh) : new AttrRef<GridBase>(-1)
    let tottri = 0

    if (cd_grid.exists) {
      //estimate tottri from number of grid points
      for (const l of mesh.loops) {
        const grid = cd_grid.get(l)

        tottri += grid.points.length * 2
      }
    } else {
      tottri = ~~(mesh.loopTris!.length / 3)
    }

    //tottri is used by the SpatialHash subclass
    const bvh: BVHType = new this(mesh, aabb[0], aabb[1], tottri) as unknown as BVHType
    //console.log("Saved tri freelist:", freelist);

    console.log('isDeforming', deformMode)

    bvh.isDeforming = deformMode ?? false
    bvh.cd_grid = cd_grid

    if (deformMode) {
      bvh.root.calcBoxVerts()
    }

    if (freelist) {
      bvh.freelist = freelist
    }

    if (leafLimit !== undefined) {
      bvh.leafLimit = leafLimit
    } else {
      bvh.leafLimit = mesh.bvhSettings.leafLimit
    }

    if (depthLimit !== undefined) {
      bvh.depthLimit = depthLimit
    } else {
      bvh.depthLimit = mesh.bvhSettings.depthLimit
    }

    bvh.drawLevelOffset = mesh.bvhSettings.drawLevelOffset

    if (useGrids && cd_grid.exists) {
      bvh.cd_node = new AttrRef(mesh.loops.customData.getNamedLayerIndex(cdname, CDNodeInfo))
    } else {
      bvh.cd_node = new AttrRef(mesh.verts.customData.getNamedLayerIndex(cdname, CDNodeInfo))
    }

    const cd_node = bvh.cd_node

    if (cd_grid.exists) {
      for (const l of mesh.loops) {
        const grid = cd_grid.get(l)

        for (const v of grid.points) {
          const vnode = cd_node.get(v) as CDNodeInfo<{dead: true}>
          vnode.vel.zero()
          vnode.node = undefined
        }
      }
    } else {
      for (const v of mesh.verts) {
        const vnode = cd_node.get(v) as CDNodeInfo<{dead: true}>
        vnode.vel.zero()
        vnode.node = undefined
      }
    }

    //bvh.cd_face_node = mesh.faces.customData.getLayerIndex(CDNodeInfo);
    bvh.storeVerts = storeVerts

    if (cd_grid.exists) {
      const rand = new util.MersenneRandom(0)
      const cd_node = bvh.cd_node

      //we carefully randomize insertion order
      const tris = [] as (GridVert | number)[]

      /*
      for (let l of mesh.loops) {
        let grid = cd_grid.get(l);

        //reset any temporary data
        //we do this to prevent convergent behavior
        //across bvh builds
        grid.stripExtraData();
      }
      */

      for (const l of mesh.loops) {
        const grid = cd_grid.get(l)

        grid.recalcFlag = QRecalcFlags.EVERYTHING
        //grid.recalcFlag |= QRecalcFlags.TOPO | QRecalcFlags.NORMALS | QRecalcFlags.NEIGHBORS;
      }

      for (const l of mesh.loops) {
        const grid = cd_grid.get(l)

        for (const p of grid.points) {
          const vnode = cd_node.get(p) as CDNodeInfo<{dead: true}>
          vnode.node = undefined
        }

        grid.update(mesh, l, cd_grid)
        //grid.recalcNeighbors(mesh, l, cd_grid);

        const a = tris.length
        grid.makeBVHTris(mesh, bvh, l, cd_grid, tris)
        grid.updateMirrorFlags(mesh, l, cd_grid)
      }

      times.push(util.time_ms()) //4

      while (tris.length > 0) {
        const i = ~~(((rand.random() * tris.length) / 5) * 0.99999) * 5
        const i2 = tris.length - 5

        bvh.addTri(
          tris[i] as number,
          tris[i + 1] as number,
          tris[i + 2] as GridVert,
          tris[i + 3] as GridVert,
          tris[i + 4] as GridVert
        )

        for (let j = 0; j < 5; j++) {
          tris[i + j] = tris[i2 + j]
        }

        tris.length -= 5
      }

      times.push(util.time_ms()) //5

      for (const node of bvh.nodes) {
        if (node.leaf) {
          node.flag |= BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_DRAW
          bvh.updateNodes.add(node)
        }
      }

      times.push(util.time_ms()) //6

      bvh.root.update()

      times.push(util.time_ms()) //7
    } else {
      const ltris = mesh.loopTris!

      const order = new Array<number>(ltris.length / 3)

      for (let i = 0; i < ltris.length; i += 3) {
        order[~~(i / 3)] = i
      }

      for (let i = 0; i < order.length >> 1; i++) {
        const ri = ~~(util.random() * order.length * 0.99999)
        const t = order[ri]

        order[ri] = order[i]
        order[i] = t
      }

      /*
      order.sort((a, b) => {
        a = ltris[a];
        b = ltris[b];

        let f = a.v[0] - b.v[0];
        let eps = 0.001;

        if (Math.abs(f) < eps) {
          f = a.v[1] - b.v[1];
        }

        if (Math.abs(f) < eps) {
          f = a.v[2] - b.v[2];
        }

        return f;
      }) //*/

      for (const ri of order) {
        const i = ri
        const l1 = ltris[i]
        const l2 = ltris[i + 1]
        const l3 = ltris[i + 2]

        bvh.addTri(l1.f.eid, i, l1.v, l2.v, l3.v, undefined, l1, l2, l3)
      }

      if (addWireVerts) {
        for (const v of mesh.verts) {
          let wire = true

          for (const e of v.edges) {
            if (e.l) {
              wire = false
              break
            }
          }

          if (!wire) {
            continue
          }

          bvh.addWireVert(v)
        }
      }
    }

    times.push(util.time_ms())

    //deform mode assigns verts to nodes only if they
    //lie within the node's hexahedron. fix any orphans.
    if (bvh.isDeforming) {
      bvh._fixOrphanDefVerts()
    }
    //update aabbs
    bvh.update()

    if (onCreate) {
      onCreate(bvh)
    }

    times.push(util.time_ms())

    for (let i = 1; i < times.length; i++) {
      ;(times[i] as number) -= times[0] as number
      times[i] = ((times[i] as number) / 1000).toFixed(3)
    }

    times[0] = 0.0

    console.log('times', times)
    return bvh
  }

  makeNodeDefTexture() {
    const leaves = Array.from(this.leaves)

    let size = Math.ceil((leaves.length * 8 * 3) / 4)
    size = Math.max(size, 16)

    let dimen = Math.ceil(Math.sqrt(size))
    const f = Math.ceil(Math.log(dimen) / Math.log(2.0))
    dimen = Math.pow(2.0, f)

    const tex = new Float32Array(dimen * dimen * 4)
    console.log('dimen', dimen)

    tex.fill(0)

    let li = 0
    let i = 0

    const elemSize = 8 * 4

    //since dimen is a multiply of 8, we should be able
    //to get away with assuming each entry lies within
    //only one row of the texture

    for (const node of this.leaves) {
      node.leafIndex = li

      const idx = i / 4
      let u = idx % dimen
      let v = ~~(idx / dimen)

      //v = dimen - 1 - v;

      u = u / dimen + 0.00001
      v = v / dimen + 0.00001

      node.leafTexUV[0] = u
      node.leafTexUV[1] = v

      for (const v of node.boxverts!) {
        tex[i++] = v[0]
        tex[i++] = v[1]
        tex[i++] = v[2]
        tex[i++] = 0.0
      }

      li++
    }

    return {
      data: tex,
      dimen,
    }
  }

  _fixOrphanDefVerts() {
    const cd_node = this.cd_node
    let ret = false

    ;`
    for (let v of vs) {
      let ok = false;

      for (let e of v.edges) {
        if (e.l) {
          ok = true;
          break;
        }
      }

      if (!ok) {
        continue;
      }

      if (!v.customData[cd_node].node) {
        console.warn("Orphaned vertex!", v);
      }
    }`

    for (const n of this.leaves) {
      for (const tri of n.allTris) {
        for (let i = 0; i < 3; i++) {
          const v = tri.vs[i]
          const cdn = cd_node.get(v)

          if (!cdn.node) {
            //console.warn("Orphaned deform vert", v);

            cdn.node = n

            n.otherVerts.delete(v)
            n.uniqueVerts.add(v)
            n.setUpdateFlag(BVHFlags.UPDATE_BOUNDS | BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_DRAW)

            ret = true
          }
        }
      }
    }

    return ret
  }

  splitToUniformDepth = function (this: BVH<OPT & {dead: false}>) {
    let maxdepth = 0

    const vs = new Set()

    for (const n of this.leaves) {
      for (const tri of n.allTris) {
        for (const v of tri.vs) {
          vs.add(v)
        }
      }
      maxdepth = Math.max(n.depth, maxdepth)
    }

    console.log('maxdepth:', maxdepth)
    const rec = (n: BVHNode): void => {
      if (n.depth >= maxdepth) {
        return
      }

      if (n.leaf) {
        n.split(2)

        for (const child of n.children) {
          //child.update();
        }
      }

      for (const child of Array.from(n.children)) {
        if (child.leaf && child.allTris.size === 0) {
          n.children.remove(child)
          this.nodes.remove(child)

          child.leaf = false
          continue
        }

        rec(child)
      }
    }

    const leaves = Array.from(this.leaves)
    for (const node of leaves) {
      if (!node.leaf) {
        //node was destroyed for being empty?
        continue
      }

      rec(node)
    }

    this._fixOrphanDefVerts()
  }

  getNodeVertex(co: Vector3) {
    const prec = 1000
    const x = ~~(co[0] * prec)
    const y = ~~(co[1] * prec)
    const z = ~~(co[2] * prec)

    const key = x + ':' + y + ':' + z
    let v = this.nodeVertHash.get(key)

    if (v) {
      return v
    }

    v = new BVHNodeVertex(co)
    v.id = this._node_elem_idgen++

    this.nodeVerts.push(v)
    this.nodeVertHash.set(key, v)

    return v
  }

  getNodeEdge(node: BVHNode<{boxedges: true}>, v1: BVHNodeVertex, v2: BVHNodeVertex) {
    const key = Math.min(v1.id, v2.id) + ':' + Math.max(v1.id, v2.id)
    let e = this.nodeEdgeHash.get(key)

    if (e) {
      node.boxedges.push(e)
      return e
    }

    e = new BVHNodeEdge(v1, v2)
    e.id = this._node_elem_idgen++

    v1.edges.push(e)
    v2.edges.push(e)

    this.nodeEdges.push(e)
    this.nodeEdgeHash.set(key, e)
    node.boxedges.push(e)

    return e
  }

  origCoStart = function (this: BVH<OPT & {dead: false}>, cd_orig: number): void {
    this.cd_orig = cd_orig
    this.origGen++

    for (const node of this.nodes) {
      if (node.leaf) {
        node.flag |= BVHFlags.UPDATE_ORIGCO_VERTS
      }
    }
  }

  //attempt to sort mesh spatially within memory

  _checkCD = function (this: BVH<OPT & {dead: false}>): void {
    this.cd_grid = GridBase.meshGridRef(this.mesh)

    let cdata: CustomData

    if (this.cd_grid.exists) {
      cdata = this.mesh.loops.customData
    } else {
      cdata = this.mesh.verts.customData
    }

    const layer = cdata.flatlist[this.cd_node.i]

    if (layer?.typeName !== 'bvh') {
      this.cd_node = new AttrRef(cdata.getLayerIndex('bvh'))
    }
  }

  checkCD(): void {
    this._checkCD()
  }

  //in an attempt to improve cpu cache performance
  spatiallySortMesh = function (this: BVH<OPT & {dead: false}>): void {
    const mesh = this.mesh

    console.error('spatiallySortMesh called')

    /* First destroy node references. */
    const cd_node = this.cd_node

    if (this.cd_grid.exists) {
      const cd_grid = this.cd_grid

      for (const l of mesh.loops) {
        const grid = cd_grid.get(l)
        for (const p of grid.points) {
          cd_node.get(p).node = undefined as unknown as BVHNode
        }
      }
    } else {
      for (const v of mesh.verts) {
        cd_node.get(v).node = undefined as unknown as BVHNode
      }
    }

    const doneflag = MeshFlags.TEMP2
    const updateflag = MeshFlags.UPDATE
    const allflags = doneflag

    for (const elist of mesh.getElemLists()) {
      let i = 0

      for (const elem of elist) {
        elem.flag &= ~allflags
        elem.index = i++
      }
    }

    const verts = Array.from(mesh.verts)
    const edges = Array.from(mesh.edges)
    const faces = Array.from(mesh.faces)
    const loops = Array.from(mesh.loops)
    const handles = Array.from(mesh.handles)

    const newvs = new Array<Vertex>(verts.length)
    const newhs = new Array<Handle>(handles.length)
    const newes = new Array<Edge>(edges.length)
    const newls = new Array<Loop>(loops.length)
    const newfs = new Array<Face>(faces.length)

    const elists = new Map(mesh.elists)

    mesh.clear()

    const visit = new WeakSet<Element>()
    const fleaves = [] as Face[][]

    for (const n of this.nodes) {
      if (!n.leaf) {
        continue
      }

      const fs = [] as Face[]

      for (const t of n.uniqueTris) {
        const f: Face = mesh.eidMap.get<Face>(t.id) ?? t.f ?? (t.l1 ? t.l1.f : undefined)

        if (f === undefined) {
          continue
        }

        if (!visit.has(f) && f.type === MeshTypes.FACE) {
          fs.push(f)
          visit.add(f)
        }
      }

      if (fs.length > 0) {
        fleaves.push(fs)
      }
    }

    console.log(fleaves)

    function copyCustomData(cd: CDElemArray): CDElemArray {
      const ret = new CDElemArray()
      for (let i = 0; i < ret.length; i++) {
        ret.push(cd[i].copy())
      }

      return ret
    }

    for (const fs of fleaves) {
      for (const f of fs) {
        for (const l of f.loops) {
          const v = l.v

          if (newvs[v.index]) {
            continue
          }

          const v2 = new Vertex(v.co)
          newvs[v.index] = v2

          v2.eid = v.eid
          mesh.eidMap.set(v2.eid, v2)

          v2.customData = copyCustomData(v.customData)

          v2.no.load(v.no)
          v2.flag = v.flag | updateflag

          mesh.verts.push(v2)
        }

        for (const l of f.loops) {
          const e = l.e

          if (newes[e.index]) {
            continue
          }

          const e2 = (newes[e.index] = new Edge())

          if (EDGE_LINKED_LISTS) {
            // XXX kind of weird having to cast to typeof e['v1next'] here
            e.v1next = e.v1prev = e as unknown as (typeof e)['v1next']
            e.v2next = e.v2prev = e as unknown as (typeof e)['v1next']
          }

          e2.eid = e.eid
          e2.customData = copyCustomData(e.customData)
          e2.flag = e.flag | updateflag

          e2.length = e.length
          e2.v1 = newvs[e.v1.index]
          e2.v2 = newvs[e.v2.index]

          if (e.h1 && !e2.h1) {
            for (let step = 0; step < 2; step++) {
              const h1 = step ? e.h2 : e.h1
              const h2 = new Handle(h1.co)

              h2.owner = e2
              h2.roll = h1.roll
              h2.mode = h1.mode
              h2.flag = h1.flag | updateflag
              h2.index = h1.index

              if (step) {
                e.h2 = h2
              } else {
                e.h1 = h2
              }

              h2.eid = h1.eid
              mesh.eidMap.set(h2.eid, h2)
              mesh.handles.push(h2)
            }
          }

          mesh.edges.push(e2)
          mesh.eidMap.set(e2.eid, e2)

          mesh._diskInsert(e2.v1, e2)
          mesh._diskInsert(e2.v2, e2)
        }

        const f2 = (newfs[f.index] = new Face())

        f2.eid = f.eid
        f2.flag = f.flag | updateflag
        f2.customData = copyCustomData(f.customData)
        f2.no.load(f.no)
        f2.area = f.area
        f2.cent.load(f.cent)

        mesh.eidMap.set(f2.eid, f2)
        mesh.faces.push(f2)

        for (const list1 of f.lists) {
          const list2 = new LoopList()
          list2.flag = list1.flag

          f2.lists.push(list2)

          let l1 = list1.l
          let prevl: Loop | undefined = undefined
          let _i = 0

          do {
            const l2 = new Loop()

            l2.customData = copyCustomData(l1.customData)
            l2.eid = l1.eid
            l2.flag = l1.flag
            l2.index = l1.index

            l2.v = newvs[l1.v.index]
            l2.e = newes[l1.e.index]
            l2.list = list2
            l2.f = f2

            mesh.eidMap.set(l2.eid, l2)
            mesh.loops.push(l2)

            if (prevl) {
              l2.prev = prevl
              prevl.next = l2
            } else {
              list2.l = l2
            }

            prevl = l2

            if (_i++ > 1000000) {
              console.error('infinite loop error')
              break
            }
            l1 = l1.next
          } while (l1 !== list1.l)

          list2.l.prev = prevl
          prevl.next = list2.l
          list2._recount()
        }

        for (const l of f2.loops) {
          mesh._radialInsert(l.e, l)
        }
      }
    }

    for (const elist of mesh.getElemLists()) {
      const oelist = elists.get(elist.type)!

      let i = 0
      const act = oelist.active

      for (const elem of elist) {
        if (elem.flag & MeshFlags.SELECT) {
          elist.setSelect(elem, true)
        }

        if (i === act?.index) {
          elist.setActive(elem)
        }
        i++
      }
    }

    //don't allow this.destroy to be called
    mesh.bvh = undefined

    //ensure ltris are dead
    mesh._ltris = []

    mesh.regenAll()
    mesh.recalcNormals()
    mesh.graphUpdate()

    this.nodes = []
  }

  oldspatiallySortMesh(mesh: Mesh) {
    const verts = Array.from(mesh.verts)
    const edges = Array.from(mesh.edges)
    const faces = Array.from(mesh.faces)

    mesh.elists = new Map()
    mesh.verts = mesh.getElemList(MeshTypes.VERTEX)
    mesh.edges = mesh.getElemList(MeshTypes.EDGE)
    mesh.handles = mesh.getElemList(MeshTypes.HANDLE)
    mesh.loops = mesh.getElemList(MeshTypes.LOOP)
    mesh.faces = mesh.getElemList(MeshTypes.FACE)

    mesh.eidMap = new Map()
    const idcur = mesh.eidgen.cur
    const cd_node = this.cd_node

    for (const f of faces) {
      f.index = -1
    }

    for (const e of edges) {
      e.index = -1
    }

    for (const v of verts) {
      const node = cd_node.get(v).node

      if (!node) {
        v.index = -1
        continue
      }

      v.index = node.id

      if (Math.random() > 0.999) {
        console.log(v, node.id)
      }

      for (const e of v.edges) {
        if (e.index === -1) {
          e.index = v.index
        }

        for (const l of e.loops) {
          if (l.f.index === -1) {
            l.f.index = v.index
          }
        }
      }
    }

    verts.sort((a, b) => a.index - b.index)
    edges.sort((a, b) => a.index - b.index)
    faces.sort((a, b) => a.index - b.index)

    for (const v1 of verts) {
      const v2 = mesh.makeVertex(v1, v1.eid)
      mesh.copyElemData(v2, v1)
    }

    for (const e1 of edges) {
      const eid = e1.eid

      const e2 = mesh.makeEdge(mesh.eidMap.get(e1.v1.eid), mesh.eidMap.get(e1.v2.eid), undefined, eid)
      mesh.copyElemData(e2, e1)
    }

    const vs = []
    for (const f1 of faces) {
      let f2: Face | undefined

      for (const list of f1.lists) {
        vs.length = 0

        for (const l of list) {
          vs.push(mesh.eidMap.get(l.v.eid))
        }

        if (list === f1.lists[0]) {
          f2 = mesh.makeFace(vs, f1.eid)
          mesh.copyElemData(f2, f1)
        } else if (f2) {
          mesh.makeHole(f2, vs)
        }
      }

      if (f2 === undefined) {
        throw new Error('f2 was undefined')
      }

      for (let i = 0; i < f1.lists.length; i++) {
        const list1 = f1.lists[i]
        const list2 = f2.lists[i]

        let l1 = list1.l
        let l2 = list2.l
        let _i = 0
        do {
          mesh.copyElemData(l2, l1)

          if (_i++ > 100000) {
            console.warn('Infinite loop error')
            break
          }

          l1 = l1.next
          l2 = l2.next
        } while (l1 !== list1.l)
      }
    }

    mesh.regenAll()
    mesh.regenBVH()
    mesh.recalcNormals()
    mesh.graphUpdate()
  }

  destroy(mesh: Mesh) {
    const deadThis = this as unknown as BVH<{dead: true}>
    //console.error("BVH.destroy called");

    if (this.dead) {
      return
    }

    this.dead = true

    const freelist = this.freelist
    this.freelist = undefined as unknown as this['freelist']

    for (const tri of this.tris!.values()) {
      const deadtri = tri as unknown as BVHTri<{dead: true}>
      deadtri.v1 = undefined
      deadtri.v2 = deadtri.v3 = undefined
      deadtri.l1 = deadtri.l2 = deadtri.l3 = undefined
      deadtri.f = undefined
      deadtri.vs[0] = deadtri.vs[1] = deadtri.vs[2] = undefined

      freelist.push(deadtri)
    }

    this._checkCD()

    const cd_node = this.cd_node as AttrRef<CDNodeInfo<{dead: true}>>
    const cd_grid = this.cd_grid

    //let cd_face_node = this.cd_face_node;

    if (cd_node.i < 0) {
      return freelist
    }

    if (cd_grid.exists) {
      for (const l of mesh.loops) {
        const grid = cd_grid.get(l)

        grid.relinkCustomData()

        for (const p of grid.points) {
          //console.log(p.customData, cd_node);
          cd_node.get(p).node = undefined
        }
      }
    } else {
      for (const v of mesh.verts) {
        cd_node.get(v).node = undefined
      }
    }

    if (this.glLeafTex && window._gl) {
      //XXX evil global ref
      this.glLeafTex.destroy(window._gl)
      this.glLeafTex = undefined
    }

    for (const n of this.nodes!) {
      if (n.drawData) {
        n.drawData.destroy()
        n.drawData = undefined
      }
    }

    deadThis.root = undefined
    deadThis.nodes = undefined
    deadThis.mesh = undefined
    deadThis.node_idmap = undefined
    deadThis.updateNodes = undefined
    deadThis.tris = undefined
    deadThis.fmap = undefined

    deadThis.cd_node.i = -1
    deadThis.cd_grid = new AttrRef(-1)

    //for (let f of mesh.faces) {
    //  f.customData[cd_face_node].node = undefined;
    //}

    return freelist
  }

  preallocTris(count = 1024 * 128) {
    for (let i = 0; i < count; i++) {
      this.freelist.push(new BVHTri())
    }
  }

  closestOrigVerts = function (this: BVH<OPT & {dead: false}>, co: Vector3, radius: number) {
    const ret = new Set<IBVHVertex>()

    this.root.closestOrigVerts(co, radius, ret)

    return ret
  }

  facesInCone(origin: Vector3, ray: Vector3, radius1: number, radius2: number, visibleOnly = true, isSquare = false) {
    origin = _fictmpco.load(origin)

    const ret = new Set<Face>()

    if (!this.root) {
      return ret
    }

    this.root.facesInCone(origin, ray, radius1, radius2, visibleOnly, isSquare, ret)

    return ret
  }

  /** Faces whose triangles intersect the frustum (array of inward planes). */
  facesInFrustum(planes: Vector4[]) {
    const ret = new Set<Face>()

    if (!this.root) {
      return ret
    }

    this.root.facesInFrustum(planes, ret)

    return ret
  }

  /** Verts inside the frustum (array of inward planes). */
  vertsInFrustum(planes: Vector4[]) {
    const ret = new Set<IBVHVertex>()

    if (!this.root) {
      return ret
    }

    this.root.vertsInFrustum(planes, ret)

    return ret
  }

  vertsInCone = function (
    this: BVH<OPT & {dead: false}>,
    origin: Vector3,
    ray: Vector3,
    radius1: number,
    radius2: number,
    isSquare = false
  ): Set<IBVHVertex> {
    const ret = new Set<IBVHVertex>()

    if (!this.root) {
      return new Set()
    }

    this.root.vertsInCone(origin, ray, radius1, radius2, isSquare, ret)

    return ret
  }

  vertsInTube = function (
    this: BVH<OPT & {dead: false}>,
    origin: Vector3,
    ray: Vector3,
    radius: number,
    clip = false,
    isSquare = false
  ) {
    const ret = new Set<Vertex>()

    if (!clip) {
      ray = new Vector3(ray)
      ray.normalize()
    }

    this.root.vertsInTube(origin, ray, radius, clip, isSquare, ret)

    return ret
  }

  nearestVertsN = function (this: BVH<OPT & {dead: false}>, co: Vector3, n: number) {
    const ret = new Set()
    const heap = new util.MinHeapQueue<IBVHVertex>()
    const visit = new WeakSet()
    const mindis = [undefined] as [number | undefined]

    this._i = 0
    this.root.nearestVertsN(co, n, heap, mindis as number[])

    n = Math.min(n, heap.length)
    console.log('HEAP LEN', heap.length)

    //while (heap.length > n) {
    //      heap.pop();
    // }

    for (let i = 0; i < n; i++) {
      const item = heap.pop()

      if (item) {
        //console.log(item.eid);
        ret.add(item)
      }
    }

    return ret
  }

  closestVerts = function (this: BVH<OPT & {dead: false}>, co: IVectorOrHigher<3>, radius: number) {
    const ret = new Set<IBVHVertex>()

    this.root.closestVerts(co, radius, ret)

    return ret
  }

  closestVertsSquare = function (
    this: BVH<OPT & {dead: false}>,
    co: IVectorOrHigher<3>,
    radius: number,
    matrix: Matrix4
  ) {
    const ret = new Set<IBVHVertex>()

    const origco = co

    co = cvstmps2.next().load(co)
    co.multVecMatrix(matrix)

    const min = cvstmps2.next()
    const max = cvstmps2.next()

    min.load(co).addScalar(-radius)
    max.load(co).addScalar(radius)

    this.root.closestVertsSquare(co, origco, radius, matrix, min, max, ret)

    return ret
  }

  closestTris = function (this: BVH<OPT & {dead: false}>, co: Vector3, radius: number) {
    const ret = new Set<BVHTri<OPT>>()

    this.root.closestTris(co, radius, ret)

    return ret
  }

  closestTrisSimple = function (this: BVH<OPT & {dead: false}>, co: Vector3, radius: number) {
    const ret = new Set<BVHTri<OPT>>()

    this.root.closestTrisSimple(co, radius, ret)

    return ret
  }

  closestPoint = function (this: BVH<OPT & {dead: false}>, co: Vector3) {
    return this.root.closestPoint(co)
  }

  castRay = function (
    this: BVH<OPT & {dead: false}>,
    origin: IVectorOrHigher<3, Vector3>,
    dir: IVectorOrHigher<3, Vector3>
  ) {
    if (!this.root) {
      return undefined
    }

    dir = this.dirtemp.load(dir)
    dir.normalize()

    return this.root.castRay(origin, dir)
  }

  getFaceTris = function (this: BVH<OPT & {dead: false}>, id: number) {
    return this.fmap.get(id)
  }

  removeFace = function (this: BVH<OPT & {dead: false}>, id: number, unlinkVerts = false, joinNodes = false) {
    if (!this.fmap.has(id)) {
      return
    }

    const tris = this.fmap.get(id)!

    for (const t of tris) {
      if (t.node) {
        t.node.flag |= BVHFlags.UPDATE_UNIQUE_VERTS | BVHFlags.UPDATE_TOTTRI | BVHFlags.UPDATE_INDEX_VERTS
      }

      this._removeTri(t, true, unlinkVerts, joinNodes)
      this.tris.delete(t.tri_idx)
    }

    this.fmap.delete(id)
  }

  _nextTriIdx() {
    //XXX
    return ~~(Math.random() * 1024 * 1024 * 32)
    this.tri_idgen++

    return this.tri_idgen
  }

  checkJoin = function (this: BVH<OPT & {dead: false}>, _node: BVHNode<OPT & {dead: false}>) {
    let node: typeof _node | undefined = _node

    //return;
    if (this.isDeforming) {
      return
    }

    if (!node.parent || node.parent === this.root) {
      return
    }

    let p: typeof node | undefined = node
    let join = false
    let lastp
    let lastp2

    while (p) {
      if (p.tottri > this.leafLimit / 1.5 || p.shapeTest(false)) {
        break
      }

      node = lastp
      lastp2 = lastp
      lastp = p
      p = p.parent
    }
    const tot = 0

    if (lastp && !lastp.leaf && !lastp.shapeTest(false) && lastp.tottri < this.leafLimit / 1.5) {
      join = true
      p = lastp
    }

    if (join) {
      const cd_node = this.cd_node

      //console.log("EMPTY node!", p.children);
      const allTris = new Set<BVHTri>()

      const rec = (n: BVHNode<OPT & {dead: false}>) => {
        if (n.id >= 0) {
          this._remNode(n)
        }

        if (!n.leaf) {
          for (const c of n.children) {
            rec(c)
          }

          return
        }

        for (const v of n.uniqueVerts!) {
          const node = cd_node.get(v)
          if (node.node === n) {
            node.node = undefined as unknown as BVHNode
          }
        }

        for (const tri of n.allTris) {
          if (tri.nodes.includes(n)) {
            tri.nodes.remove(n)
          }
          if (tri.node === n) {
            tri.node = undefined
          }
          allTris.add(tri)
        }
      }

      if (p === undefined) {
        throw new Error('p was undefined')
      }

      for (const n2 of p.children) {
        rec(n2)
      }

      p.tottri = 0
      p.children = []

      p.leaf = true

      p.allTris = new Set()
      p.uniqueTris = new FakeSet() //new Set();
      p.otherTris = new Set()
      p.uniqueVerts = new Set()
      p.otherVerts = new Set()
      p.indexVerts = []
      p.indexLoops = []
      p.indexTris = []
      p.indexEdges = []

      for (const tri of allTris) {
        p.addTri(tri.id, tri.tri_idx, tri.v1, tri.v2, tri.v3, undefined, tri.l1, tri.l2, tri.l3)
      }

      p.flag |= BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_TOTTRI | BVHFlags.UPDATE_OTHER_VERTS
      p.flag |= BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_UNIQUE_VERTS

      this.updateNodes.add(p)
    }
  }

  joinNode = function (this: BVH<OPT & {dead: false}>, node: BVHNode, addToRoot = false) {
    const p = node

    if (this.isDeforming) {
      console.warn('joinNode called in deforming mode')
      return
    }

    if (!node.parent || node.parent === this.root || node.leaf) {
      return
    }

    const cd_node = this.cd_node

    //console.log("EMPTY node!", p.children);
    const allTris = new Set<BVHTri>()

    const rec = (n: BVHNode) => {
      if (n.id >= 0) {
        this._remNode(n)
      }

      if (!n.leaf) {
        for (const c of n.children) {
          rec(c)
        }

        return
      }

      for (const v of n.uniqueVerts) {
        const node = cd_node.get(v)
        if (node.node === n) {
          node.node = undefined as unknown as BVHNode
        }
      }

      for (const tri of n.allTris) {
        if (tri.nodes.includes(n)) {
          tri.nodes.remove(n)
        }
        if (tri.node === n) {
          tri.node = undefined
        }
        allTris.add(tri)
      }
    }

    for (const n2 of p.children) {
      rec(n2)
    }

    p.tottri = 0
    p.children = []

    p.leaf = true

    p.allTris = new Set()
    p.uniqueTris = new FakeSet() //new Set();
    p.otherTris = new Set()
    p.uniqueVerts = new Set()
    p.otherVerts = new Set()
    p.indexVerts = []
    p.indexLoops = []
    p.indexTris = []
    p.indexEdges = []

    const addp = addToRoot ? this.root! : p

    for (const tri of allTris) {
      addp.addTri(tri.id, tri.tri_idx, tri.v1, tri.v2, tri.v3, undefined, tri.l1, tri.l2, tri.l3)
    }

    p.flag |= BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_TOTTRI | BVHFlags.UPDATE_OTHER_VERTS
    p.flag |= BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_UNIQUE_VERTS

    this.updateNodes.add(p)
  }

  removeTri = function (this: BVH<OPT & {dead: false}>, tri: BVHTri<OPT & {dead: false}>) {
    this._removeTri(tri, false, false)
    this.tris.delete(tri.tri_idx)
  }

  getDebugCounts() {
    return {
      totAlloc: this.totTriAlloc,
      totFreed: this.totTriFreed,
    }
  }

  _removeTri = function (
    this: BVH<OPT & {dead: false}>,
    tri: BVHTri<OPT & {dead: false}>,
    partial = false,
    unlinkVerts = false,
    joinNodes = false
  ) {
    if (tri.removed) {
      return
    }

    this.totTriFreed++
    this.tottri--

    const cd_node = this.cd_node

    let updateflag = BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS
    updateflag |= BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_UNIQUE_VERTS
    updateflag |= BVHFlags.UPDATE_OTHER_VERTS | BVHFlags.UPDATE_COLORS

    if (unlinkVerts) {
      const n1 = cd_node.get(tri.v1)
      const n2 = cd_node.get(tri.v2)
      const n3 = cd_node.get(tri.v3)

      if (n1.node && n1.node.uniqueVerts) {
        const deadn1 = n1 as CDNodeInfo<{dead: true}>
        deadn1.node!.uniqueVerts.delete(tri.v1)
        deadn1.node = undefined
      }

      if (n2.node && n2.node.uniqueVerts) {
        const deadn2 = n2 as CDNodeInfo<{dead: true}>
        deadn2.node!.uniqueVerts.delete(tri.v2)
        deadn2.node = undefined
      }

      if (n3.node && n3.node.uniqueVerts) {
        const deadn3 = n3 as CDNodeInfo<{dead: true}>
        deadn3.node!.uniqueVerts.delete(tri.v3)
        deadn3.node = undefined
      }

      for (const node of tri.nodes) {
        node.otherVerts.delete(tri.v1)
        node.otherVerts.delete(tri.v2)
        node.otherVerts.delete(tri.v3)

        node.flag |= updateflag
        this.updateNodes.add(node)
      }
    }

    tri.removed = true

    //console.log("tri.nodes", tri.nodes.concat([]));

    for (const node of tri.nodes) {
      if (!node.allTris?.has(tri)) {
        //throw new Error("bvh error");
        console.warn('bvh error')
        continue
      }

      node.allTris.delete(tri)
      //if (node.uniqueTris.has(tri)) {
      //XXX node.otherTris.delete(tri);
      //} else {
      node.uniqueTris.delete(tri)
      //}

      node.flag |= updateflag

      this.updateNodes.add(node)

      node.tottri--
    }

    if (joinNodes) {
      for (const node of tri.nodes) {
        this.checkJoin(node)
      }
    }

    this.flag |= BVHFlags.UPDATE_TOTTRI

    tri.node = undefined

    if (!partial) {
      const tris = this.fmap.get(tri.id)!
      tris.remove(tri)
      this.tris.delete(tri.id)
    }

    const deadtri = tri as BVHTri<{dead: true}>

    for (let i = 0; i < tri.nodes.length; i++) {
      deadtri.nodes![i] = undefined
    }

    deadtri.v1 = deadtri.v2 = deadtri.v3 = undefined
    deadtri.l1 = deadtri.l2 = deadtri.l3 = undefined
    deadtri.vs[0] = deadtri.vs[1] = deadtri.vs[2] = undefined
    tri.f = undefined

    if (ENABLE_CACHING) {
      this.freelist.push(tri)
    }
  }

  hasTri(id: number, tri_idx: number) {
    //, v1, v2, v3) {
    const tri = this.tris!.get(tri_idx)
    return tri && !tri.removed
  }

  _getTri1(id: number, tri_idx: number, v1: IBVHVertex, v2: IBVHVertex, v3: IBVHVertex) {
    const tri = new BVHTri(id, tri_idx)

    tri.area = math.tri_area(v1.co, v2.co, v3.co) + 0.00001

    tri.v1 = v1
    tri.v2 = v2
    tri.v3 = v3

    return tri
  }

  _getTri = function (
    this: BVH<OPT & {dead: false}>,
    id: number,
    tri_idx: number,
    v1: IBVHVertex,
    v2: IBVHVertex,
    v3: IBVHVertex
  ) {
    this.tri_idgen = Math.max(this.tri_idgen, tri_idx + 1)

    let tri = this.tris.get(tri_idx)

    if (!tri) {
      if (this.freelist.length > 0) {
        tri = this.freelist.pop()!
        tri.id = id
        tri.tri_idx = tri_idx
        tri.nodes = []
      } else {
        tri = new BVHTri(id, tri_idx)
      }

      this.totTriAlloc++

      this.tottri++
      this.tris.set(tri_idx, tri)
    }

    let trilist = this.fmap.get(id)
    if (!trilist) {
      trilist = []
      this.fmap.set(id, trilist)
    }

    trilist.push(tri)

    tri.removed = false

    if (tri.node?.uniqueTris) {
      tri.node.uniqueTris.delete(tri)
      tri.node = undefined
    }

    tri.v1 = tri.vs[0] = v1
    tri.v2 = tri.vs[1] = v2
    tri.v3 = tri.vs[2] = v3

    tri.no.load(v2.co).sub(v1.co)
    _ntmptmp.load(v3.co).sub(v1.co)
    tri.no.cross(_ntmptmp)

    if (isNaN(tri.no.dot(tri.no))) {
      console.error('NaN in bvh tri', tri, tri.v1, tri.v2, tri.v3)
      console.error('  vertex eids:', tri.v1.eid, tri.v2.eid, tri.v3.eid)
      tri.no.zero()
      tri.area = 0.0
    } else {
      tri.no.normalize()
      tri.area = math.tri_area(v1.co, v2.co, v3.co) + 0.00001
    }

    //tri.f = this.mesh.eidMap.get(id);

    return tri
  }

  _newNode = function (this: BVH<OPT & {dead: false}>, min: Vector3, max: Vector3): BVHNode {
    //let node = new this.constructor.nodeClass(this, min, max);
    const node = new BVHNode(this, min, max)

    node.flag |= BVHFlags.UPDATE_OTHER_VERTS | BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_COLORS

    node.index = this.nodes.length
    node.id = this.node_idgen++

    this.updateNodes.add(node)

    this.node_idmap.set(node.id, node)
    this.nodes.push(node)

    return node
  }

  ensureIndices = function (this: BVH<OPT & {dead: false}>) {
    if (!this.needsIndexRebuild) {
      return
    }

    this.needsIndexRebuild = false
    const nodes = this.nodes

    for (let i = 0; i < nodes.length; i++) {
      nodes[i].index = i
    }
  }

  _remNode = function (this: BVH<OPT & {dead: false}>, node: BVHNode) {
    if (node.id < 0) {
      console.error('node already removed', node)
      return
    }

    if (node.drawData) {
      node.drawData.destroy()
      node.drawData = undefined
    }

    this.needsIndexRebuild = true

    this.node_idmap.delete(node.id)
    node.id = -1

    const ni = this.nodes.indexOf(node)
    const last = this.nodes.length - 1

    if (ni >= 0) {
      this.nodes[ni] = this.nodes[last]
      this.nodes[last] = undefined as unknown as BVHNode
      this.nodes.length--
    }
  }

  updateTriCounts = function (this: BVH<OPT & {dead: false}>) {
    this.flag &= ~BVHFlags.UPDATE_TOTTRI

    const rec = (n: BVHNode<{dead: false}>) => {
      if (!n.leaf) {
        n.tottri = 0

        for (const c of n.children) {
          n.tottri += rec(c)
        }

        return n.tottri
      } else {
        n.tottri = n.uniqueTris.size

        return n.tottri
      }
    }

    rec(this.root)
  }

  update = function (this: BVH<OPT & {dead: false}>) {
    if (this.dead) {
      console.error('BVH is dead!')
      return
    }

    if (DYNAMIC_SHUFFLE_NODES) {
      const prune = false
      for (const node of this.updateNodes) {
        if (node.id < 0) {
          continue
        }

        if (Math.random() > 0.2) {
          continue
        }

        const test = node.shapeTest(true)
        if (test === 2) {
          node.split(test)
        } else if (test === 3) {
          this.joinNode(node.parent!)
        }
      }

      if (prune) {
        this.updateNodes = this.updateNodes.filter((n) => n.id >= 0)
      }
    }

    if (this.updateNodes === undefined) {
      console.warn('Dead bvh!')
      return
    }

    if (this.flag & BVHFlags.UPDATE_TOTTRI) {
      this.updateTriCounts()
    }

    let run_again = false

    const cd_grid = this.cd_grid
    if (cd_grid.exists) {
      for (const l of this.updateGridLoops) {
        const grid = cd_grid.get(l)
        grid.update(this.mesh, l, cd_grid)
      }
    }

    let check_verts = false

    for (const node of this.updateNodes) {
      if (node.flag & BVHFlags.UPDATE_UNIQUE_VERTS) {
        run_again = true
        check_verts = true
      }

      node.update()
    }

    if (run_again) {
      for (const node of this.updateNodes) {
        node.update()
      }
    }

    // XXX fixOrphanDefVerts is way overkill
    // it iterates over every single triangle in the bvh
    if (false && check_verts) {
      if (this._fixOrphanDefVerts()) {
        for (const node of this.updateNodes) {
          node.update()
        }
      }
    }

    if (this.cd_grid.exists) {
      const cd_grid = this.cd_grid

      for (const l of this.updateGridLoops) {
        const grid = cd_grid.get(l)

        grid.update(this.mesh, l, cd_grid)
      }

      this.updateGridLoops = new Set()
    } else if (this.updateGridLoops.size > 0) {
      this.updateGridLoops = new Set()
    }

    for (const node of this.updateNodes) {
      let p = node.parent

      while (p) {
        p.min.zero().addScalar(1e17)
        p.max.zero().addScalar(-1e17)

        for (const c of p.children) {
          p.min.min(c.min)
          p.max.max(c.max)
        }

        p.cent.load(p.min).interp(p.max, 0.5)
        p.halfsize.load(p.max).sub(p.min).mulScalar(0.5)

        p = p.parent
      }
    }

    this.updateNodes = new Set()
  }

  addWireVert = function (this: BVH<OPT & {dead: false}>, v: IBVHVertex) {
    return this.root.addWireVert(v)
  }

  addTri = function (
    this: BVH<OPT & {dead: false}>,
    id: number,
    tri_idx: number,
    v1: IBVHVertex,
    v2: IBVHVertex,
    v3: IBVHVertex,
    noSplit = false,
    l1?: Loop,
    l2?: Loop,
    l3?: Loop,
    addPass = 0
  ) {
    const ret = this.root.addTri(id, tri_idx, v1, v2, v3, noSplit, l1!, l2!, l3!)
    this.addPass = addPass

    return ret
  }
}

/*
window._profileBVH = function (count = 4) {
  let mesh = _appstate.ctx.mesh;

  console.profile("bvh");
  for (let i = 0; i < count; i++) {
    mesh.regenBVH();
    mesh.getBVH();
  }
  console.profileEnd("bvh");
}
*/

const hashsizes = [
  /*2, 5, 11, 19, 37, 67, 127, 223, 383, 653, 1117,*/ 1901, 3251, 5527, 9397, 15991, 27191, 46229, 78593, 133631,
  227177, 38619, 656587, 1116209, 1897561, 3225883, 5484019, 9322861, 15848867, 26943089, 45803279, 77865577, 132371489,
  225031553,
]

const addmin = new Vector3()
const addmax = new Vector3()

export class SpatialHash extends BVH {
  dimen: number
  hsize: number
  hused: number
  htable: BVHNode[]
  ktable: number[]
  hmul: Vector3

  constructor(mesh: Mesh, min: Vector3, max: Vector3, tottri = 0) {
    super(mesh, min, max)

    this.dimen = this._calcDimen(tottri)
    this.hsize = 0
    this.hused = 0
    this.htable = new Array(hashsizes[this.hsize])
    this.ktable = new Array(hashsizes[this.hsize])

    this.depthLimit = 0
    this.leafLimit = 1000000

    this.hmul = new Vector3(max).sub(min)
    this.hmul = new Vector3().addScalar(1.0).div(this.hmul)

    Object.seal(this)
  }

  hashkey(co: Vector3) {
    const dimen = this.dimen

    const hmul = this.hmul

    const x = ~~((co[0] - this.min[0]) * hmul[0] * dimen)
    const y = ~~((co[1] - this.min[1]) * hmul[1] * dimen)
    const z = ~~((co[2] - this.min[2]) * hmul[2] * dimen)

    return z * dimen * dimen + y * dimen + x
  }

  _resize(hsize: number) {
    this.hsize = hsize
    const ht = this.htable
    const kt = this.ktable

    this.htable = new Array(hashsizes[this.hsize])
    this.ktable = new Array(hashsizes[this.hsize])

    for (let i = 0; i < ht.length; i++) {
      if (ht[i] !== undefined) {
        this._addNode(ht[i])
      }
    }
  }

  _calcDimen(tottri: number): number {
    return 2 + ~~(Math.log(tottri) / Math.log(3.0))
  }

  _lookupNode(key: number): BVHNode | undefined {
    const ht = this.htable
    const kt = this.ktable
    const size = ht.length
    let probe = 0
    let _i = 0
    let idx

    while (_i++ < 100000) {
      idx = (key + probe) % size

      if (ht[idx] === undefined) {
        break
      }

      if (kt[idx] === key) {
        return ht[idx]
      }

      probe = (probe + 1) * 2
    }

    return undefined
  }

  checkJoin = function (this: BVH<{dead: false}>) {
    return false
  }

  addTr = function (
    this: SpatialHash,
    id: number,
    tri_idx: number,
    v1: IBVHVertex,
    v2: IBVHVertex,
    v3: IBVHVertex,
    noSplit = false,
    l1?: Loop,
    l2?: Loop,
    l3?: Loop,
    addPass = 0
  ) {
    const tottri = this.tottri

    if (this._calcDimen(tottri) > this.dimen + 4) {
      console.log('Dimen update', this.dimen, this._calcDimen(tottri))
    }

    const tri = this._getTri(id, tri_idx, v1, v2, v3)

    if (l1) {
      tri.l1 = l1 as unknown as Loop
      tri.l2 = l2 as unknown as Loop
      tri.l3 = l3 as unknown as Loop
    }

    const min = this.min
    const max = this.max
    const dimen = this.dimen
    const hmul = this.hmul

    const minx = Math.min(Math.min(v1.co[0], v2.co[0]), v3.co[0])
    const miny = Math.min(Math.min(v1.co[1], v2.co[1]), v3.co[1])
    const minz = Math.min(Math.min(v1.co[2], v2.co[2]), v3.co[2])

    const maxx = Math.max(Math.max(v1.co[0], v2.co[0]), v3.co[0])
    const maxy = Math.max(Math.max(v1.co[1], v2.co[1]), v3.co[1])
    const maxz = Math.max(Math.max(v1.co[2], v2.co[2]), v3.co[2])

    let x1 = Math.floor((minx - min[0]) * hmul[0] * dimen)
    let y1 = Math.floor((miny - min[1]) * hmul[1] * dimen)
    let z1 = Math.floor((minz - min[2]) * hmul[2] * dimen)

    let x2 = Math.floor((maxx - min[0]) * hmul[0] * dimen)
    let y2 = Math.floor((maxy - min[1]) * hmul[1] * dimen)
    let z2 = Math.floor((maxz - min[2]) * hmul[2] * dimen)

    x1 = Math.min(Math.max(x1, 0), dimen - 1)
    y1 = Math.min(Math.max(y1, 0), dimen - 1)
    z1 = Math.min(Math.max(z1, 0), dimen - 1)

    x2 = Math.min(Math.max(x2, 0), dimen - 1)
    y2 = Math.min(Math.max(y2, 0), dimen - 1)
    z2 = Math.min(Math.max(z2, 0), dimen - 1)

    tri.node = undefined

    const updateflag =
      BVHFlags.UPDATE_DRAW |
      BVHFlags.UPDATE_INDEX_VERTS |
      BVHFlags.UPDATE_BOUNDS |
      BVHFlags.UPDATE_NORMALS |
      BVHFlags.UPDATE_TOTTRI

    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        for (let z = z1; z <= z2; z++) {
          const key = z * dimen * dimen + y * dimen + x
          let node = this._lookupNode(key)

          if (!node) {
            const min = new Vector3()
            const max = new Vector3()

            const eps = 0.000001

            min[0] = (x / dimen + eps) / hmul[0] + this.min[0]
            min[1] = (y / dimen + eps) / hmul[1] + this.min[1]
            min[2] = (z / dimen + eps) / hmul[2] + this.min[2]

            console.log('Adding node', key, this.hashkey(min), [x, y, z])

            max
              .load(this.max)
              .sub(this.min)
              .mulScalar(1.0 / dimen)
              .add(min)

            node = this._newNode(min, max)
            node.leaf = true

            if (this.isDeforming) {
              node.calcBoxVerts()
            }

            this.updateNodes.add(node)

            node.flag |= BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_TOTTRI
            node.flag |= BVHFlags.UPDATE_COLORS | BVHFlags.UPDATE_NORMALS

            this._addNode(node)
          }

          node._pushTri(tri)
          node.setUpdateFlag(updateflag)
        }
      }
    }

    return tri
  }

  castRay = function (this: BVH<{dead: false}>, origin: IVectorOrHigher<3, Vector3>, dir: IVectorOrHigher<3, Vector3>) {
    dir = this.dirtemp.load(dir)
    dir.normalize()

    const x1 = origin[0]
    const y1 = origin[1]
    const z1 = origin[2]

    const sz = this.min.vectorDistance(this.max) * 4.0

    const x2 = x1 + dir[0] * sz
    const y2 = y1 + dir[1] * sz
    const z2 = z1 + dir[2] * sz

    const minx = Math.min(x1, x2)
    const miny = Math.min(y1, y2)
    const minz = Math.min(z1, z2)

    const maxx = Math.max(x1, x2)
    const maxy = Math.max(y1, y2)
    const maxz = Math.max(z1, z2)

    let minret: IsectRet | undefined = undefined

    const cb = (node: BVHNode) => {
      const ret = node.castRay(origin, dir)

      if (ret && (!minret || (ret.dist >= 0 && ret.dist < minret.dist))) {
        minret = ret
      }
    }

    ;(this as unknown as SpatialHash)._forEachNode(cb, minx, miny, minz, maxx, maxy, maxz)
    return minret
  }

  _forEachNode(
    cb: (node: BVHNode) => void,
    minx: number,
    miny: number,
    minz: number,
    maxx: number,
    maxy: number,
    maxz: number
  ) {
    const min = this.min
    const dimen = this.dimen
    const hmul = this.hmul

    let x1 = Math.floor((minx - min[0]) * hmul[0] * dimen)
    let y1 = Math.floor((miny - min[1]) * hmul[1] * dimen)
    let z1 = Math.floor((minz - min[2]) * hmul[2] * dimen)

    let x2 = Math.ceil((maxx - min[0]) * hmul[0] * dimen)
    let y2 = Math.ceil((maxy - min[1]) * hmul[1] * dimen)
    let z2 = Math.ceil((maxz - min[2]) * hmul[2] * dimen)

    x1 = Math.min(Math.max(x1, 0), dimen - 1)
    y1 = Math.min(Math.max(y1, 0), dimen - 1)
    z1 = Math.min(Math.max(z1, 0), dimen - 1)

    x2 = Math.min(Math.max(x2, 0), dimen - 1)
    y2 = Math.min(Math.max(y2, 0), dimen - 1)
    z2 = Math.min(Math.max(z2, 0), dimen - 1)

    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        for (let z = z1; z <= z2; z++) {
          const key = z * dimen * dimen + y * dimen + x
          const node = this._lookupNode(key)

          if (node) {
            cb(node)
          }
        }
      }
    }
  }

  closestVerts = function (this: BVH<{dead: false}>, co: IVectorOrHigher<3>, radius: number) {
    const eps = radius * 0.01

    const minx = co[0] - radius - eps
    const miny = co[1] - radius - eps
    const minz = co[2] - radius - eps

    const maxx = co[0] + radius + eps
    const maxy = co[1] + radius + eps
    const maxz = co[2] + radius + eps

    const ret = new Set<IBVHVertex>()
    const rsqr = radius * radius

    const cb = (node: BVHNode) => {
      if (node.wireVerts) {
        for (const v of node.wireVerts) {
          if (v.co.vectorDistanceSqr(co) <= rsqr) {
            ret.add(v)
          }
        }
      }

      for (const t of node.allTris) {
        if (t.v1.co.vectorDistanceSqr(co) <= rsqr) {
          ret.add(t.v1)
        }

        if (t.v2.co.vectorDistanceSqr(co) <= rsqr) {
          ret.add(t.v2)
        }

        if (t.v3.co.vectorDistanceSqr(co) <= rsqr) {
          ret.add(t.v3)
        }
      }
    }

    ;(this as unknown as SpatialHash)._forEachNode(cb, minx, miny, minz, maxx, maxy, maxz)
    return ret
  }

  _addNode(node: BVHNode) {
    if (this.hused > this.htable.length / 3) {
      this._resize(this.hsize + 1)
    }

    const key = this.hashkey(node.min)
    const ht = this.htable
    const kt = this.ktable
    const size = ht.length
    let probe = 0
    let _i = 0
    let idx = 0

    while (_i++ < 100000) {
      idx = (key + probe) % size

      if (ht[idx] === undefined) {
        break
      }

      probe = (probe + 1) * 2
    }

    ht[idx] = node
    kt[idx] = key

    this.hused++
  }
}
