import {math, Vector2, Vector3, Vector4, Matrix4, util} from '@framework/api'
import {nstructjs, PackNode} from '@framework/pathux'
import '../../../../scripts/util/numeric.js'

import {MeshTypes, MeshFlags, MAX_FACE_VERTS} from './mesh_base.js'
import {AttrRef, ColorLayerElem, IntElem, UVFlags, UVLayerElem} from './mesh_customdata.js'
import {BVH, BVHNode, BVHTri} from './bvh.js'
import {CustomDataElem} from './customdata.js'
import {Edge, Face, Loop, Mesh, RecalcFlags, Vertex} from './mesh'
import {INumberList} from '@framework/api'
import {bus} from '@framework/api'
import type {SolveTri} from './unwrapping_solve.js'
import {OptionalIf, OptionalIfNot} from '@framework/api'
import {ImageBus} from '@framework/api'

const chp_rets = util.cachering.fromConstructor(Vector2, 64)

export class CVElem<OPT extends {dead?: true | false} = {}> extends CustomDataElem<CVElem> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
CVElem {
  hasPins : int;
  corner  : int;
  orig    : vec3;
}`
  )

  hasPins: boolean
  corner: boolean
  orig: Vector3
  vel: Vector2
  oldco: Vector2
  oldvel: Vector2
  area?: number
  wind?: boolean
  bTangent: Vector3
  tris?: SolveTri[]

  constructor() {
    super()
    this.hasPins = false
    this.corner = false
    this.orig = new Vector3()
    this.vel = new Vector2()
    this.oldco = new Vector2()
    this.oldvel = new Vector2()
    this.area = undefined
    this.wind = undefined

    //boundary tangent;
    this.bTangent = new Vector3()
  }

  static define() {
    return {
      typeName    : 'uvcorner',
      uiTypeName  : 'uvcorner',
      defaultName : 'uvcorner',
      elemTypeMask: MeshTypes.LOOP,
    }
  }

  calcMemSize() {
    return 8 * 5
  }

  copyTo(b: this): this {
    b.hasPins = this.hasPins
    b.corner = this.corner
    b.orig = this.orig
    b.vel.load(this.vel)
    b.oldco.load(this.oldco)
    b.oldvel.load(this.oldvel)
    return this
  }

  setValue(b: this) {
    b.copyTo(this)
  }

  getValue() {
    return this
  }

  clear(): this {
    this.hasPins = this.corner = false
    this.orig.zero()

    return this
  }
}

export class UVIsland extends Set {
  hasPins: boolean
  hasSelLoops: boolean
  boxcenter: Vector2
  boxsize: Vector2
  area: number
  min: Vector2
  max: Vector2

  oldmin?: Vector2 = undefined
  oldmax?: Vector2 = undefined
  oldsize?: Vector2 = undefined

  constructor() {
    super()

    this.hasPins = false
    this.hasSelLoops = false

    this.boxcenter = new Vector2()
    this.boxsize = new Vector2()
    this.area = 0.0
    this.min = new Vector2()
    this.max = new Vector2()
  }
}

export interface IUVWranglerConstructor<type> {
  new (mesh: Mesh, faces?: Iterable<Face>, cd_uv?: AttrRef<UVLayerElem>): type

  _calcSeamHash(mesh: Mesh, faces?: Iterable<Face>): number

  restoreOrRebuild(mesh: Mesh, faces: Iterable<Face>, wrangler: UVWrangler, buildSeams?: boolean): UVWrangler
}

export class UVWrangler<OPT extends {dead?: true | false; hasUVMesh?: true | false} = {}> {
  islands: UVIsland[] = []
  mesh: Mesh
  uvMesh: OptionalIfNot<Mesh, OPT['hasUVMesh']> = undefined as unknown as Mesh
  faces: Set<Face>
  cd_uv: AttrRef<UVLayerElem>
  needTopo: boolean
  loopMap: Map<Loop, Vertex>
  edgeMap: Map<Loop, Edge>
  vertMap: Map<Vertex, Set<Loop>>
  islandLoopMap: OptionalIf<Map<Loop, UVIsland>, OPT['dead']>
  islandFaceMap: OptionalIf<Map<Face, UVIsland>, OPT['dead']>
  islandVertMap: OptionalIf<Map<Vertex, UVIsland>, OPT['dead']>
  cellDimen: number
  hashBounds: number[]
  hashWidth: number
  hashWidthMul: number
  cellSizeMul: number
  snapLimit: number
  shash: OptionalIf<Map<number, Loop[]>, OPT['dead']>
  saved: boolean
  cd_corner: AttrRef<CVElem> = new AttrRef(-1)
  cd_edge_seam: AttrRef<IntElem> = new AttrRef(-1)
  _seamHash: number = 0;

  ['constructor']: IUVWranglerConstructor<this> = this['constructor']

  constructor(mesh: Mesh, faces?: Iterable<Face>, cd_uv?: AttrRef<UVLayerElem>) {
    this.mesh = mesh

    this.needTopo = true

    if (cd_uv === undefined) {
      cd_uv = mesh.loops.customData.getLayerRef(UVLayerElem)
    }

    this.cd_uv = cd_uv !== undefined ? cd_uv : new AttrRef(-1)
    this.faces = new Set(faces)

    this._makeUVMesh()

    this.loopMap = new Map() //maps loops in this.mesh to verts in this.uvmesh
    this.edgeMap = new Map() //maps loops in this.mesh to uvmesh edges
    this.vertMap = new Map()

    this.islandLoopMap = new Map()
    this.islandFaceMap = new Map()
    this.islandVertMap = new Map()

    this.cellDimen = 1
    this.hashBounds = [-4, 4]
    this.hashWidth = this.hashBounds[1] - this.hashBounds[0]
    this.hashWidthMul = 1.0 / this.hashWidth
    this.cellSizeMul = this.cellDimen * this.hashWidthMul
    this.snapLimit = 0.001
    this.shash = new Map()

    this.saved = false
  }

  static _calcSeamHash(mesh: Mesh, faces: Iterable<Face>): number {
    const digest = new util.HashDigest()
    const es = new Set<Edge>()

    for (const f of faces) {
      for (const e of f.edges) {
        es.add(e)
      }
    }

    for (const e of es) {
      digest.add(e.eid)
      digest.add(e.flag & MeshFlags.SEAM)
    }

    return digest.get()
  }

  static restoreOrRebuild(mesh: Mesh, faces: Iterable<Face>, wrangler: UVWrangler, buildSeams?: boolean): UVWrangler {
    let bad = false

    if (wrangler && wrangler.saved) {
      for (const f of faces) {
        if (!(f.eid in wrangler.faces)) {
          bad = true
          break
        }
      }
    }

    try {
      bad = bad || !wrangler || !wrangler.saved || !wrangler.restore(mesh)
    } catch (error) {
      util.print_stack(error as Error)
      bad = true
    }

    if (bad) {
      console.warn('UVWrangler.restoreOrRebuild(): making new uv wrangler. . .')
      const ret = new UVWrangler(mesh, faces)

      ret.buildIslands(buildSeams)
      return ret
    }

    return wrangler
  }

  _makeUVMesh(): Mesh {
    this.uvMesh = new Mesh()
    this.uvMesh.verts.addCustomDataLayer(CVElem)
    this.uvMesh.edges.addCustomDataLayer(IntElem)
    this.cd_corner = this.uvMesh.verts.customData.getLayerRef(CVElem)
    this.cd_edge_seam = this.uvMesh.edges.customData.getLayerRef(IntElem)

    return this.uvMesh
  }

  destroy(mesh?: Mesh) {
    return this
  }

  save(): void {
    if (this.saved) {
      console.error('UVWrangler was already saved')
      return
    }

    this._seamHash = this.constructor._calcSeamHash(this.mesh, this.faces)
    ;(this.faces as unknown as Set<number>) = this.faces.map((f) => f.eid)

    const loopMap = new Map()

    for (const l of this.loopMap.keys()) {
      loopMap.set(l.eid, this.loopMap.get(l))
    }

    const edgeMap = new Map()
    for (const l of this.edgeMap.keys()) {
      edgeMap.set(l.eid, this.edgeMap.get(l))
    }

    const vertMap = new Map()

    for (const [v, ls] of this.vertMap) {
      const ls2 = ls.map((l) => l.eid)
      vertMap.set(v, ls)
    }

    const deadThis = this as UVWrangler<{dead: true}>
    deadThis.islandVertMap = undefined
    deadThis.islandLoopMap = undefined
    deadThis.islandFaceMap = undefined
    deadThis.shash = undefined
    ;(this.loopMap as unknown as Map<any, any>) = loopMap
    ;(this.edgeMap as unknown as Map<any, any>) = edgeMap
    ;(this.vertMap as unknown as Map<any, any>) = vertMap
    ;(this.mesh as unknown as number) = this.mesh.lib_id
    this.saved = true
  }

  /*returns true if restore succeeded*/
  restore(mesh: Mesh): boolean {
    if (!this.saved) {
      console.error('UVWrangler is not saved')
      return false
    }

    this.mesh = mesh
    this.saved = false

    const faces = new Set<Face>()

    for (const eid of this.faces as unknown as Set<number>) {
      const f = mesh.eidMap.get<Face>(eid)
      if (f?.type !== MeshTypes.FACE) {
        console.warn('Missing face ' + eid)
        return false
      }

      faces.add(f)
    }

    this.faces = faces

    const loopMap = new Map()
    for (const [leid, v] of this.loopMap as unknown as Map<number, Vertex>) {
      const l = mesh.eidMap.get(leid)

      if (l?.type !== MeshTypes.LOOP) {
        console.warn('Missing loop ' + leid, l)
        return false
      }

      loopMap.set(l, v)
    }

    const edgeMap = new Map()
    for (const [leid, e] of this.edgeMap as unknown as Map<number, Edge>) {
      const l = mesh.eidMap.get(leid)

      if (l?.type !== MeshTypes.LOOP) {
        console.warn('Missing loop ' + leid, l)
        return false
      }

      edgeMap.set(l, e)
    }

    const vertMap = new Map()
    for (const [v, ls] of this.vertMap as unknown as Map<number, number[]>) {
      const ls2 = new Set<Loop>()

      for (const leid of ls) {
        const l = mesh.eidMap.get(leid)
        if (l?.type !== MeshTypes.LOOP) {
          console.warn('Missing loop ' + leid, l)
          return false
        } else {
          ls2.add(l)
        }
      }

      vertMap.set(v, ls2)
    }

    this.loopMap = loopMap
    this.edgeMap = edgeMap
    this.vertMap = vertMap
    this.needTopo = false

    const seamhash = this.constructor._calcSeamHash(mesh, this.faces)
    console.warn('Seam hash:', seamhash)

    if (seamhash !== this._seamHash) {
      return false
    }

    this.islandLoopMap = new Map()
    this.islandFaceMap = new Map()
    this.islandVertMap = new Map()

    const liveThis = this as UVWrangler<{dead: false; hasUVMesh: false}>
    liveThis.buildIslands()
    return true
  }

  setCornerTags = function (this: UVWrangler<{dead: false; hasUVMesh: true}>) {
    const cd_corner = this.cd_corner
    const cd_edge_seam = this.cd_edge_seam

    for (const l of this.mesh.loops) {
      let seam = false //(l.e.flag & MeshFlags.SEAM); //seam
      seam = seam || l === l.radial_next //mesh boundary
      seam = seam || this.islandLoopMap!.get(l) !== this.islandLoopMap!.get(l.radial_next)

      if (seam) {
        const v1 = this.loopMap.get(l)
        const v2 = this.loopMap.get(l.next)

        if (!v1 || !v2) {
          console.error('error in setCornerTags, missing vertices', v1, v2)
          continue
        }

        const uve = this.uvMesh.getEdge(v1, v2)

        if (uve) {
          cd_edge_seam.get(uve).value = 1
        }

        cd_corner.get(this.loopMap!.get(l)!).corner = true
        cd_corner.get(this.loopMap!.get(l.next)!).corner = true
      }
    }
  }

  /*checks if a uv edge is a seam*/
  seamUVEdge(e: Edge): number {
    return this.cd_edge_seam.get(e).value
  }

  /*checks if an edge in the base mesh is a seam*/
  seamEdge(e: Edge): boolean {
    const l = e.l

    if (!l) {
      return false //no faces
    }

    if (l === l.radial_next) {
      return true
    }

    return this.islandFaceMap!.get(l.f) !== this.islandFaceMap!.get(l.radial_next.f)
  }

  _getHashPoint(x: number, y: number): Vector2 {
    const p = chp_rets.next()

    p[0] = Math.floor((x - this.hashBounds[0]) * this.cellSizeMul)
    p[1] = Math.floor((y - this.hashBounds[1]) * this.cellSizeMul)

    return p
  }

  hashPoint(x: number, y: number): number {
    x = Math.floor((x - this.hashBounds[0]) * this.cellSizeMul)
    y = Math.floor((y - this.hashBounds[1]) * this.cellSizeMul)

    return y * this.cellDimen + x
  }

  loadSnapLimit(limit: number): void {
    limit = Math.max(limit, 0.00005)

    const cell = Math.ceil(this.hashWidth / limit) >> 2

    this.snapLimit = limit
    this.cellDimen = cell
    this.cellSizeMul = this.cellDimen * this.hashWidthMul
  }

  finish = function (this: UVWrangler<{dead: false; hasUVMesh: true}>): void {
    const cd_uv = this.cd_uv

    for (const v of this.uvMesh!.verts) {
      for (const l of this.vertMap.get(v)!) {
        const uv = cd_uv.get(l)
        uv.uv.load(v.co as unknown as Vector2)
      }
    }
  }

  resetSpatialHash(limit = this.snapLimit): void {
    this.shash = new Map()
    this.loadSnapLimit(limit)
  }

  shashAdd = function (this: UVWrangler<OPT & {dead: false | undefined}>, l: Loop, uv: Vector2): number {
    const key = this.hashPoint(uv[0], uv[1])

    if (!this.shash.has(key)) {
      this.shash.set(key, [])
    }

    return this.shash.get(key)!.push(l)
  }

  buildIslands = function (this: UVWrangler<{dead: false}>, buildSeams = false) {
    if (this.needTopo) {
      if (buildSeams) {
        this.buildTopologySeam()
      } else {
        this.buildTopology()
      }
    }

    const cd_uv = this.cd_uv
    const cd_corner = this.cd_corner

    for (const v of this.uvMesh.verts) {
      cd_corner.get(v).hasPins = false

      for (const l of this.vertMap.get(v)!) {
        if (cd_uv.get(l).flag & UVFlags.PIN) {
          cd_corner.get(v).hasPins = true
          break
        }
      }
    }

    this.islands = []
    const doneset = new Set()

    for (const v of this.uvMesh.verts) {
      if (doneset.has(v)) {
        continue
      }

      doneset.add(v)
      const stack = [v]

      const island = new UVIsland()
      island.hasPins = false

      while (stack.length > 0) {
        const v2 = stack.pop()!

        this.islandVertMap!.set(v2, island)

        for (const l of this.vertMap.get(v2)!) {
          if (cd_uv.get(l).flag & UVFlags.PIN) {
            island.hasPins = true
          }

          if (l.flag & MeshFlags.SELECT && !(l.flag & MeshFlags.HIDE)) {
            island.hasSelLoops = true
          }

          this.islandFaceMap!.set(l.f, island)
          this.islandLoopMap!.set(l, island)
        }

        island.add(v2)

        for (const e of v2.edges) {
          const v3 = e.otherVertex(v2)

          if (!doneset.has(v3)) {
            doneset.add(v3)
            stack.push(v3)
          }
        }
      }

      /*
      for (let v of island) {
        for (let l of this.vertMap.get(v)) {
          //this.islandLoopMap.set(l, island);
        }
      }//*/

      this.islands.push(island)
    }

    for (const island of this.islands) {
      this.updateAABB(island)
    }

    const uvMeshThis = this as unknown as UVWrangler<{dead: false; hasUVMesh: true}>
    this.setCornerTags()
    uvMeshThis.buildBoundaryTangents()

    return this
  }

  buildTopologySeam() {
    const uvmesh = this._makeUVMesh()
    const cd_uv = this.cd_uv

    this.loopMap = new Map()
    this.vertMap = new Map()
    this.islandLoopMap = new Map()
    this.islandVertMap = new Map()
    this.islandFaceMap = new Map()

    const cd_corner = this.cd_corner

    const doneset = new WeakSet()

    function hasSeam(v: Vertex) {
      for (const e of v.edges) {
        if (e.flag & MeshFlags.SEAM) {
          return true
        }
      }

      return false
    }

    const islands = [] as Set<Face>[]

    const faces = this.faces

    for (const f of faces) {
      if (doneset.has(f)) {
        continue
      }

      const island = new Set<Face>()
      const stack = [f]

      islands.push(island)
      doneset.add(f)

      while (stack.length > 0) {
        const f2 = stack.pop()!

        island.add(f2)

        for (const l of f2.loops) {
          if (l === l.radial_next || l.e.flag & MeshFlags.SEAM) {
            continue
          }

          const l2 = l.radial_next

          if (l2.f.flag & MeshFlags.HIDE || doneset.has(l2.f)) {
            continue
          }

          doneset.add(l2.f)
          stack.push(l2.f)
        }
      }
    }

    function nextl(startl: Loop, cb: (l: Loop) => void, reverse = false) {
      let _i = 0
      let l = startl

      //do {
      for (let i = 0; i < 1; i++) {
        if (cb) {
          cb(l)
        }

        if (reverse) {
          const lr = l.prev.radial_next

          if (lr === l.prev) {
            l = lr
            break
          }

          //don't allow bad winding
          if (l.v === lr.v) {
            l = lr
          } else {
            l = lr
            break //l = lr.next;
          }
        } else {
          const lr = l.radial_next

          if (lr === l) {
            break
          }

          //don't allow bad winding
          if (lr.v !== l.v) {
            l = lr.next
          } else {
            l = lr
            break
            //l = lr.prev;
          }
        }

        if (_i++ > 100) {
          console.error('infinite loop detected')
          break
        }
      }
      //} while (l !== startl && !(l.e.flag & MeshFlags.SEAM));

      //if (l.radial_next !== l && !(l.e.flag & MeshFlags.SEAM)) {
      //  return undefined;
      //}

      //if (cb) {
      //  cb(l);
      //}

      return l
    }

    function prevl(startl: Loop, cb: (l: Loop) => void) {
      return nextl(startl, cb, true)
    }

    console.log('Islands length b:', islands.length)

    const imap = new Map()

    let li2 = 0
    let islandindex = 0
    for (const island of islands) {
      for (const f of island) {
        f.index = islandindex

        for (const l of f.loops) {
          l.index = li2++
        }
      }

      islandindex++
    }

    for (const island of islands) {
      const ls = new Set<Loop>()
      const doneset = new WeakSet<Loop>()

      for (const f of island) {
        for (const l of f.loops) {
          ls.add(l)
        }
      }

      for (const l of ls) {
        if (doneset.has(l)) {
          continue
        }

        for (const e of l.v.edges) {
          if (!e.l) {
            continue
          }

          let l2 = e.l
          let _i = 0
          do {
            if (l2.v === l.v && l2.f.index === l.f.index) {
              l2.index = l.index
              doneset.add(l2)
            }
            if (_i++ > MAX_FACE_VERTS) {
              console.error('infinite loop error')
              break
            }
          } while ((l2 = l2.radial_next) !== e.l)
        }
      }

      const iset = new Set()

      for (const l of ls) {
        if (!imap.has(l.index)) {
          const v = uvmesh.makeVertex(new Vector3().load2(cd_uv.get(l).uv))
          v.co[2] = 0.0

          this.vertMap.set(v, new Set([l]))
          this.loopMap.set(l, v)

          imap.set(l.index, v)
          doneset.add(l)
        } else {
          const v = imap.get(l.index)
          this.loopMap.set(l, v)
          this.vertMap.get(v)!.add(l)
        }
        iset.add(l.index)
      }

      for (const l of ls) {
        const v1 = this.loopMap.get(l)!
        const v2 = this.loopMap.get(l.next)!

        if (v1 !== v2) {
          const e = uvmesh.ensureEdge(v1, v2)
          this.edgeMap.set(l, e)
        }
      }
      //console.log(iset, ls);
    }

    for (const v of uvmesh.verts) {
      cd_corner.get(v).corner = false

      for (const l of this.vertMap.get(v)!) {
        if (l.e.flag & MeshFlags.SEAM) {
          cd_corner.get(v).corner = true
        }
      }
    }
  }

  buildBoundaryTangents = function (this: UVWrangler<{hasUVMesh: true}>): void {
    const cd_corner = this.cd_corner
    const cd_uv = this.cd_uv

    const t1 = new Vector2()
    const t2 = new Vector2()
    const t3 = new Vector2()

    for (const v of this.uvMesh.verts) {
      const c = cd_corner.get(v)

      if (!c.corner) {
        continue
      }

      let v1: Vertex | undefined
      let v2: Vertex | undefined
      let vcent: Vertex | undefined

      for (const e2 of v.edges) {
        const v3 = e2.otherVertex(v)

        if (!this.seamUVEdge(e2)) {
          vcent = v3
          continue
        }

        if (!v1) {
          v1 = v3
        } else {
          v2 = v3
          break
        }
      }

      if (!v1 || !v2) {
        console.error('Orphaned UV corner!')
        continue
      }

      t1.load(v1.co).sub(v.co).normalize()
      t2.load(v2.co).sub(v.co).normalize().negate()

      t3.load(t1).add(t2).normalize()

      const th = Math.acos(t1.dot(t3))

      const shellth = th < 0.0001 ? 1.0 : 1.0 / Math.abs(Math.cos(th))

      t1.interp(t2, 0.5).normalize()
      t1.mulScalar(shellth)

      if (isNaN(t1.dot(t2))) {
        throw new Error('NaN!')
      }

      const tmp = t1[0]
      t1[0] = -t1[1]
      t1[1] = tmp

      if (!vcent) {
        for (const l of this.vertMap.get(v)!) {
          if (this.seamEdge(l.e)) {
            const uv1 = cd_uv.get(l).uv
            const uv2 = cd_uv.get(l.next).uv

            t3.zero()
            let tot = 0.0
            for (const l3 of l.list) {
              const uv3 = cd_uv.get(l3).uv
              t3.add(uv3)
              tot++
            }

            t3.mulScalar(1.0 / tot)
            t3.sub(v.co).negate()

            //console.log("TT4", t3, t3.dot(t1));

            if (t3.dot(t1) < 0.0) {
              t1.negate()
            }
          }
        }
      }

      if (vcent) {
        t2.load(v.co).sub(vcent.co)

        if (t1.dot(t2) < 0) {
          t1.negate()
        }
      }

      c.bTangent[0] = t1[0]
      c.bTangent[1] = t1[1]
      c.bTangent[2] = 0.0
    }
  }

  isCorner(l: Loop): boolean {
    return this.cd_corner.get(this.loopMap.get(l)!).corner
  }

  buildTopology = function (this: UVWrangler<OPT & {dead: false | undefined}>, snap_threshold = 0.0001): void {
    if (!this.cd_uv.exists) {
      console.warn('No uvs')
      return
    }

    const cd_uv = this.cd_uv
    this.resetSpatialHash(snap_threshold)
    this._makeUVMesh()

    const faces = this.faces
    const uvmesh = this.uvMesh!

    for (const f of faces) {
      for (const l of f.loops) {
        const uv = cd_uv.get(l).uv
        this.shashAdd(l, uv)
      }
    }

    const offs = [
      [0, 0],
      [-1, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
      [1, 0],
      [1, -1],
      [0, -1],
    ]

    const celldimen = this.cellDimen
    const hp = new Vector2()
    const uvsum = new Vector2()

    const vmap = new Set<Vertex>()
    const doneset = new WeakSet()
    const limit = this.snapLimit
    const limitsqr = limit * limit

    const loops = new Set<Loop>()

    for (const f of this.faces) {
      for (const l of f.loops) {
        loops.add(l)

        if (doneset.has(l)) {
          continue
        }

        const uv = cd_uv.get(l).uv
        let tot = 1

        uvsum.load(uv)
        hp.load(this._getHashPoint(uv[0], uv[1]))

        const lset = new Set([l])
        const v = uvmesh.makeVertex()

        this.loopMap.set(l, v)
        this.vertMap.set(v, lset)

        for (const off of offs) {
          const x2 = hp[0] + off[0]
          const y2 = hp[1] + off[1]
          const key = y2 * celldimen + x2

          const list = this.shash.get(key)

          if (!list) {
            continue
          }

          for (const l2 of list) {
            if (doneset.has(l2)) {
              continue
            }

            const uv2 = cd_uv.get(l2).uv

            if (uv2.vectorDistanceSqr(uv) < limitsqr) {
              doneset.add(l2)
              lset.add(l2)
              uvsum.add(uv2)
              tot++
              this.loopMap.set(l2, v)
            }
          }
        }

        uvsum.mulScalar(1.0 / tot)
        v.co.load2(uvsum)
        v.co[2] = 0.0
      }
    }

    const loopmap = this.loopMap

    for (const l of loops) {
      const v1 = loopmap.get(l)!

      if (doneset.has(l.next)) {
        const v2 = loopmap.get(l.next)!
        if (v2 !== v1) {
          this.edgeMap.set(l.next, uvmesh.ensureEdge(v1, v2))
        }
      }

      if (doneset.has(l.prev)) {
        const v2 = loopmap.get(l.prev)!
        if (v2 !== v1) {
          this.edgeMap.set(l.prev, uvmesh.ensureEdge(v1, v2))
        }
      }
    }
  }

  updateAABB(island: UVIsland): void {
    const l = island
    l.min = new Vector2().addScalar(1e17)
    l.max = new Vector2().addScalar(-1e17)

    for (const v of l) {
      v.co[2] = 0.0

      l.min.min(v.co)
      l.max.max(v.co)
    }

    l.boxsize = new Vector2(l.max).sub(l.min)

    l.boxsize[0] = Math.max(l.boxsize[0], 0.00001)
    l.boxsize[1] = Math.max(l.boxsize[1], 0.00001)

    l.area = l.boxsize[0] * l.boxsize[1]
  }

  packIslands(ignorePinnedIslands = false, islandsWithSelLoops = false) {
    bus.sendTrigger(ImageBus, 'resetDrawLines')
    bus.sendTrigger(ImageBus, 'flagRedraw')

    function drawline(v1: INumberList, v2: INumberList, color = 'red'): void {
      bus.sendTrigger(ImageBus, 'addDrawLine', [v1, v2, color])
      bus.sendTrigger(ImageBus, 'flagRedraw')
    }

    const cd_corner = this.cd_corner

    let islands = [] as UVIsland[]
    for (const l of this.islands) {
      if (ignorePinnedIslands && l.hasPins) {
        continue
      }
      if (islandsWithSelLoops && !l.hasSelLoops) {
        continue
      }

      this.updateAABB(l)

      for (const v of l) {
        cd_corner.get(v).orig = new Vector3(v.co)
      }

      const cent = new Vector2(l.min).interp(l.max, 0.5)
      const steps = 16
      let th = 0.0
      const dth = (Math.PI * 0.5) / steps

      let min = 1e17
      let minth = 0.0
      for (let i = 0; i < steps; i++, th += dth) {
        //th += (Math.random()-0.5)*dth;

        for (const v of l) {
          v.co.load(cd_corner.get(v).orig).sub(cent).rot2d(th).add(cent)
        }

        this.updateAABB(l)
        const size = (l.max[0] - l.min[0]) * (l.max[1] - l.min[1])
        if (size < min) {
          min = size
          minth = th
        }
      }

      for (const v of l) {
        v.co.load(cd_corner.get(v).orig).sub(cent).rot2d(minth).add(cent)
      }

      this.updateAABB(l)
    }

    let totarea = 0.0

    islands = [] as UVIsland[]
    for (const island of this.islands) {
      if (ignorePinnedIslands && island.hasPins) {
        continue
      }
      if (islandsWithSelLoops && !island.hasSelLoops) {
        continue
      }

      this.updateAABB(island)
      islands.push(island)
      totarea += island.area
    }

    if (totarea === 0.0 || isNaN(totarea)) {
      if (isNaN(totarea)) {
        throw new Error('NaN!')
      }
      return
    }

    for (const island of islands) {
      this.updateAABB(island)

      const ratio = 0.75 / Math.sqrt(totarea)

      for (const v of island) {
        v.co.sub(island.min).mulScalar(ratio).add(island.min)
        v.co[2] = 0.0
      }

      this.updateAABB(island)
    }

    islands.sort((a, b) => {
      return b.area - a.area
    })

    const rec = (uv1: Vector2, uv2: Vector2, axis: 0 | 1, depth = 0) => {
      drawline([uv1[0], uv1[1]], [uv1[0], uv2[1]])
      drawline([uv1[0], uv2[1]], [uv2[0], uv2[1]])
      drawline([uv2[0], uv2[1]], [uv2[0], uv1[1]])
      drawline([uv2[0], uv1[1]], [uv1[0], uv1[1]])

      if (islands.length === 0) {
        return
      }

      const size = new Vector2(uv2).sub(uv1)
      const area = size[0] * size[1]
      const axis2 = (axis ^ 1) as 0 | 1

      const margin = 0.001

      let min = 1e17
      let island
      for (const island2 of islands) {
        this.updateAABB(island2)

        const pass = Math.random() > 0.85

        if (!pass && island2.area < area && Math.abs(area - island2.area) < min) {
          min = Math.abs(area - island2.area)
          island = island2
        }
      }

      if (!island && islands.length === 0) {
        return
      }

      const maxdepth = 10

      if (depth > maxdepth) {
        return
      }

      //console.log("min", min);

      const vec = new Vector2(uv2).sub(uv1)
      const dis = vec[0] * vec[1]

      if ((min > dis * 0.5 && depth < maxdepth - 1) || !island) {
        const split = 0.5

        const uv3 = new Vector2(uv1)
        const uv4 = new Vector2(uv2)
        const t = uv1[axis] + (uv2[axis] - uv1[axis]) * split

        uv3[axis] = t
        uv4[axis] = t

        rec(uv1, uv4, axis2, depth + 1)
        rec(uv3, uv2, axis2, depth + 1)
        return
      }

      const axis3 = island.boxsize[1] > island.boxsize[0] ? 1 : 0
      if (axis3 !== axis) {
        const cent = island.min.interp(island.max, 0.5)

        for (const v of island) {
          v.co
            .sub(cent)
            .rot2d(Math.PI * 0.5)
            .add(cent)
        }

        this.updateAABB(island)
      }

      islands.remove(island)
      let ratio = island.boxsize[0] / island.boxsize[1]
      size.subScalar(margin * 2.0)

      const ratio2 = size[0] / size[1]
      ratio = ratio / ratio2

      for (const v of island) {
        v.co.sub(island.min).div(island.boxsize).mul(size)
        v.co.addScalar(margin)

        if (ratio > 1.0) {
          v.co[1] /= ratio
        } else {
          v.co[0] *= ratio
        }

        v.co.add(uv1)
      }

      this.updateAABB(island)
      return

      let split = 0.5
      split = uv1[axis] + (uv2[axis] - uv1[axis]) * split
      const mid = new Vector2()

      mid[axis] = split
      mid[axis2] = uv1[axis2]

      rec(mid, uv2, axis2, depth + 1)

      //mid[axis2] = uv2[axis2];
      //rec(mid, uv2, axis2, depth+1);
    }

    const minuv = new Vector2([0, 0])
    const maxuv = new Vector2([1, 1])

    rec(minuv, maxuv, 0)
  }
}

const splitTemps = util.cachering.fromConstructor(Vector3, 32)

export class VoxelNode extends BVHNode {
  avgNo: Vector3
  avgNoTot: number
  splitVar: number

  constructor(bvh: BVH, min: Vector3, max: Vector3) {
    super(bvh, min, max)

    this.avgNo = new Vector3()
    this.avgNoTot = 0.0

    this.splitVar = 0.16

    if (this.constructor === VoxelNode) {
      Object.seal(this)
    }
  }

  _pushTri(tri: BVHTri) {
    const no = math.normal_tri(tri.v1.co, tri.v2.co, tri.v3.co)
    tri.no.load(no)

    const w = (tri.area = math.tri_area(tri.v1.co, tri.v2.co, tri.v3.co))

    this.avgNo.addFac(no, w)
    this.avgNoTot += w

    return super._pushTri(tri)
  }

  splitTest(depth = 0): number {
    if (this.depth >= this.bvh.depthLimit) {
      return 0
    }

    const avg = splitTemps.next().zero()

    if (this.avgNoTot === 0) {
      return 0
    }

    avg.load(this.avgNo).normalize()

    //did normals cancel each other out?
    if (avg.vectorLength() < 0.00001) {
      return 1
    }

    avg.normalize()

    let variance = 0.0
    let tot = 0.0
    for (const t of this.uniqueTris) {
      let th = Math.acos(t.no.dot(avg) * 0.999999) / Math.PI

      const w = t.area
      //w = math.tri_area(t.v1, t.v2, t.v3);

      th *= th
      //th = Math.abs(th);

      variance += th * w
      tot += w
    }

    variance = variance / tot

    if (variance > this.splitVar) {
      return 1
    }

    return 0
  }
}

export class VoxelBVH extends BVH {
  splitVar = 0.15

  constructor(mesh: Mesh, min: Vector3, max: Vector3, tottri = 0) {
    super(mesh, min, max, tottri)

    this.leafLimit = 15
  }
}

VoxelBVH.nodeClass = VoxelNode

export function voxelUnwrap(
  mesh: Mesh,
  faces: Iterable<Face>,
  cd_uv?: AttrRef<UVLayerElem>,
  setSeams = true,
  leafLimit = 255,
  depthLimit = 25,
  splitVar = 0.16
) {
  if (cd_uv === undefined) {
    cd_uv = mesh.loops.customData.getLayerRef(UVLayerElem)
  }

  if (!cd_uv.exists) {
    console.log('no uv layers')
    return
  }

  const cd_color = mesh.verts.customData.getLayerRef(ColorLayerElem)
  mesh.regenBVH()

  const bvh = VoxelBVH.create<VoxelBVH>(mesh, {
    leafLimit,
    depthLimit,
    useGrids  : false,
    deformMode: true,
  })
  bvh.splitVar = splitVar

  const aabb = mesh.getBoundingBox()
  const p = new Vector3()
  const scale = new Vector3(aabb[1]).sub(aabb[0])

  console.log(aabb, scale)
  const patches = new Map()

  let idgen = 0
  const rand = new util.MersenneRandom()
  const doneset = new WeakSet()

  class ColorSet extends Set<Face> {
    color: Vector4 = new Vector4()
  }

  for (const node of bvh.nodes) {
    if (!node.leaf) {
      continue
    }

    rand.seed(idgen)
    const c = new Vector4([rand.random(), rand.random(), rand.random(), 1.0])
    idgen++

    const patch = new ColorSet()
    patch.color = c

    for (const t of node.uniqueTris) {
      const f = mesh.eidMap.get<Face>(t.id)

      if (f && !doneset.has(f)) {
        doneset.add(f)
        patch.add(f)
      }
    }

    if (patch.size > 0) {
      //console.log(patch.color, cd_color)
      patches.set(node, patch)
    }
  }

  console.log('patches', patches)

  const graph = [] as MyPackNode[]

  let totarea = 0.0

  class MyPackNode extends PackNode {
    ls: Set<Loop>

    constructor(ls: Set<Loop> = new Set()) {
      super()
      this.ls = ls
    }
  }

  for (const patch of patches.values()) {
    const p = new Vector3()
    const no = new Vector3()

    let li = 0
    const ls = new Set<Loop>()

    for (const f of patch) {
      no.add(f.no)

      for (const l of f.loops) {
        ls.add(l)
        if (cd_color.exists) {
          //l.v.customData[cd_color].color.load(patch.color);
        }
      }
    }

    for (const l of ls) {
      l.index = li++
    }

    no.normalize()

    const mat = new Matrix4()
    mat.makeNormalMatrix(no)

    const min = new Vector2().addScalar(1e17)
    const max = new Vector2().addScalar(-1e17)

    for (const l of ls) {
      p.load(l.v.co).multVecMatrix(mat)

      l.v.co[1] = 1
      //l.v.co[3] = 1;

      min.min(p)
      max.max(p)

      cd_uv.get(l).uv.load(p)
    }

    max.sub(min)
    totarea += max[0] * max[1]

    const pnode = new MyPackNode(ls)
    pnode.pos.load(min).mulScalar(1000)
    pnode.size.load(max).mulScalar(1000)
    pnode.startpos = new Vector2(pnode.pos)

    for (const l of ls) {
      const uv = cd_uv.get(l).uv

      uv.sub(min).div(max)
    }

    graph.push(pnode)
  }

  console.log('totarea', totarea)

  totarea = Math.sqrt(totarea) * 0.4

  if (totarea === 0.0) {
    totarea = 1.0
  }

  for (const patch of patches.values()) {
    const rx = rand.random()
    const ry = rand.random()

    for (const f of patch) {
      for (const l of f.loops) {
        const uv = cd_uv.get(l).uv

        uv.mulScalar(1.0 / totarea)
        uv[0] += rx
        uv[1] += ry
      }
    }
  }

  for (const pn of graph) {
    const off = new Vector2(pn.pos).sub(pn.startpos!).mulScalar(1.0 / 1000)

    for (const l of pn.ls) {
      const uv = cd_uv.get(l).uv
      uv.add(off)
    }
  }

  const min = new Vector2().addScalar(1e17)
  const max = new Vector2().addScalar(-1e17)
  for (const patch of patches.values()) {
    for (const f of patch) {
      for (const l of f.loops) {
        const uv = cd_uv.get(l).uv
        min.min(uv)
        max.max(uv)
      }
    }
  }

  if (!setSeams) {
    return
  }

  for (const patch of patches.values()) {
    for (const f of patch) {
      for (const l of f.loops) {
        if (!patch.has(l.radial_next.f)) {
          l.e.flag |= MeshFlags.SEAM
        }
      }
    }
  }
  //bvh.destroy(mesh);

  const wn = new UVWrangler(mesh, faces)

  wn.buildIslands()
  wn.packIslands()
  wn.finish()
}

export function getUVWrangler(mesh: Mesh, check = true, checkUvs = false) {
  let update: boolean = !mesh.uvWrangler || !!(mesh.recalc & RecalcFlags.UVWRANGLER)

  if (!check && mesh.uvWrangler) {
    return mesh.uvWrangler
  }

  if (mesh._last_wr_loophash === undefined) {
    checkUvs = true
  }

  const cd_uv = mesh.loops.customData.getLayerRef(UVLayerElem)

  let key = '' + mesh.loops.length + ':' + mesh.edges.length + ':' + mesh.faces.length
  key += ':' + mesh.verts.length + ':' + cd_uv

  if (checkUvs && cd_uv.exists) {
    const hash = new util.HashDigest()

    for (const l of mesh.loops) {
      const uv = cd_uv.get(l).uv

      hash.add(uv[0] * 8196)
      hash.add(uv[1] * 8196)
    }

    mesh._last_wr_loophash = hash.get()
  }

  key += ':' + mesh._last_wr_loophash

  update = update || key !== mesh._last_wr_key

  if (update) {
    mesh.recalc &= ~RecalcFlags.UVWRANGLER
    mesh._last_wr_key = key

    console.log('making new UVWrangler', key)

    if (mesh.uvWrangler) {
      mesh.uvWrangler.destroy(mesh)
    }

    mesh.uvWrangler = new UVWrangler(mesh, mesh.faces, cd_uv)
    mesh.uvWrangler.buildIslands()
  }

  return mesh.uvWrangler
}

export function destroyUVWrangler(mesh: Mesh) {
  if (mesh.uvWrangler) {
    mesh.uvWrangler.destroy(mesh)
  }

  mesh.uvWrangler = undefined
  return mesh
}
