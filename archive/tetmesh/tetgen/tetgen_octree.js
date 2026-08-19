import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as math from '../util/math.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'

import {TetTypes, TetFlags, TetRecalcFlags} from './tetgen_base.js'
import {TetLogContext} from './tetgen_base.js'
import {TetMesh} from './tetgen.js'
import {triBoxOverlap} from '../util/isect.js'

export const OcNodeFlags = {
  LEAF  : 1,
  INSIDE: 2,
}

let a = 0
export const OctreeNodeFields = {
  NMINX     : a++,
  NMINY     : a++,
  NMINZ     : a++,
  NMAXX     : a++,
  NMAXY     : a++,
  NMAXZ     : a++,
  NHALFSIZEX: a++,
  NHALFSIZEY: a++,
  NHALFSIZEZ: a++,
  NCENTX    : a++,
  NCENTY    : a++,
  NCENTZ    : a++,
  NDEPTH    : a++,
  NFLAG     : a++,
  NDIST     : a++,
  NAREA     : a++,
  NPARENT   : a++,
  NCHILD1   : a++,
  NCHILD2   : a++,
  NCHILD3   : a++,
  NCHILD4   : a++,
  NCHILD5   : a++,
  NCHILD6   : a++,
  NCHILD7   : a++,
  NCHILD8   : a++,
  NTRISTART : a++,
  NTRITOT   : a++,
}
export const NTOT = a

const NMINX = OctreeNodeFields.NMINX,
  NMINY = OctreeNodeFields.NMINY,
  NMINZ = OctreeNodeFields.NMINZ,
  NMAXX = OctreeNodeFields.NMAXX,
  NAREA = OctreeNodeFields.NAREA,
  NMAXY = OctreeNodeFields.NMAXY,
  NMAXZ = OctreeNodeFields.NMAXZ,
  NHALFSIZEX = OctreeNodeFields.NHALFSIZEX,
  NHALFSIZEY = OctreeNodeFields.NHALFSIZEY,
  NHALFSIZEZ = OctreeNodeFields.NHALFSIZEZ,
  NCENTX = OctreeNodeFields.NCENTX,
  NCENTY = OctreeNodeFields.NCENTY,
  NCENTZ = OctreeNodeFields.NCENTZ,
  NFLAG = OctreeNodeFields.NFLAG,
  NDEPTH = OctreeNodeFields.NDEPTH,
  NDIST = OctreeNodeFields.NDIST,
  NPARENT = OctreeNodeFields.NPARENT,
  NTRISTART = OctreeNodeFields.NTRISTART,
  NTRITOT = OctreeNodeFields.NTRITOT,
  NCHILD1 = OctreeNodeFields.NCHILD1

let addtri_tmps = util.cachering.fromConstructor(Vector3, 512)
let _tverts = [0, 0, 0]

a = 0
export const TriListRec = {
  TFEID: a++,
  TV1  : a++,
  TV2  : a++,
  TV3  : a++,
  TAREA: a++,
  TNX  : a++,
  TNY  : a++,
  TNZ  : a++,
}

const TFEID = TriListRec.TFEID,
  TV1 = TriListRec.TV1,
  TV2 = TriListRec.TV2,
  TV3 = TriListRec.TV3,
  TAREA = TriListRec.TAREA,
  TNX = TriListRec.TNX,
  TNY = TriListRec.TNY,
  TNZ = TriListRec.TNZ

export const TTOT = a

export class TetOctreeGen {
  constructor(mesh, maxDepth = 7) {
    this.mesh = mesh
    this.tetmesh = new TetMesh()
    this.nodes = []

    this.verts = []
    this.vmap = new Map()

    this.trilist = []
    this.tris_freelist = []
    this.leafLimit = 32

    this.maxDepth = maxDepth

    this.min = new Vector3()
    this.max = new Vector3()
    this.cent = new Vector3()
    this.stack1 = new Array(512)
  }

  start() {
    let aabb = this.mesh.getBoundingBox()

    this.nodes.length = 0

    this.min.load(aabb[0])
    this.max.load(aabb[1])
    this.cent.load(this.min).interp(this.max, 0.5)

    let ni = this._newNode()
    if (ni !== 0) {
      throw new Error('node error')
    }

    let ns = this.nodes

    ns[ni + NMINX] = aabb[0][0]
    ns[ni + NMINY] = aabb[0][1]
    ns[ni + NMINZ] = aabb[0][2]
    ns[ni + NMAXX] = aabb[1][0]
    ns[ni + NMAXY] = aabb[1][1]
    ns[ni + NMAXZ] = aabb[1][2]
    ns[ni + NCENTX] = this.cent[0]
    ns[ni + NCENTY] = this.cent[1]
    ns[ni + NCENTZ] = this.cent[2]

    ns[ni + NHALFSIZEX] = (this.max[0] - this.min[0]) * 0.5
    ns[ni + NHALFSIZEY] = (this.max[1] - this.min[1]) * 0.5
    ns[ni + NHALFSIZEZ] = (this.max[2] - this.min[2]) * 0.5

    ns[ni + NFLAG] = OcNodeFlags.LEAF
    ns[ni + NPARENT] = 0
  }

  split(ni) {
    let ns = this.nodes

    ns[ni + NFLAG] &= ~OcNodeFlags.LEAF

    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          let ci = z * 2 * 2 + y * 2 + x

          let ni2 = this._newNode()

          ns[ni + NCHILD1 + ci] = ni2

          ns[ni2 + NMINX] = ns[ni + NMINX] + ns[ni + NHALFSIZEX + i] * x
          ns[ni2 + NMINY] = ns[ni + NMINY] + ns[ni + NHALFSIZEX + i] * y
          ns[ni2 + NMINZ] = ns[ni + NMINZ] + ns[ni + NHALFSIZEX + i] * z

          ns[ni2 + NHALFSIZEX] = ns[ni + NHALFSIZEX] * 0.5
          ns[ni2 + NHALFSIZEY] = ns[ni + NHALFSIZEY] * 0.5
          ns[ni2 + NHALFSIZEZ] = ns[ni + NHALFSIZEZ] * 0.5

          ns[ni2 + NMAXX] = ns[ni2 + NMINX] + ns[ni + NHALFSIZEX]
          ns[ni2 + NMAXY] = ns[ni2 + NMINY] + ns[ni + NHALFSIZEY]
          ns[ni2 + NMAXZ] = ns[ni2 + NMINZ] + ns[ni + NHALFSIZEZ]

          ns[ni2 + NDEPTH] = ns[ni + NDEPTH] + 1
          ns[ni2 + NPARENT] = ni
          ns[ni2 + NFLAG] = OcNodeFlags.LEAF
        }
      }
    }

    let ti = ns[ni + NTRISTART]
    let tend = ti + ns[ni + NTRITOT] * TTOT
    let vs = this.verts
    let ts = this.trilist

    let n = new Vector3()

    for (let ti = ns[ni + NTRISTART]; ti < tend; ti += TTOT) {
      let feid = ts[ti + TFEID]
      let v1 = vs[ts[ti + TV1]]
      let v2 = vs[ts[ti + TV2]]
      let v3 = vs[ts[ti + TV3]]

      n[0] = ts[ti + TNX]
      n[1] = ts[ti + TNY]
      n[2] = ts[ti + TNZ]

      this.addTri(feid, v1, v2, v3, n)
    }

    this.tris_freelist.push(ns[ni + NTRISTART])
    ns[ni + NTRITOT] = 0
  }

  addVert(v) {
    let i = this.vmap.get(v.eid)

    if (i === undefined) {
      i = this.verts.length
      this.verts.push(v)

      this.vmap.set(v.eid, i)
    }

    return i
  }

  addTri(feid, v1, v2, v3, n = math.normal_tri(v1, v2, v3)) {
    let ni = 0
    let ns = this.nodes

    let iv1 = this.addVert(v1)
    let iv2 = this.addVert(v2)
    let iv3 = this.addVert(v3)

    let nx = n[0],
      ny = n[1],
      nz = n[2]

    let cur = 0
    let stack = this.stack1

    stack[cur++] = ni

    _tverts[0] = v1
    _tverts[1] = v2
    _tverts[2] = v3

    let min = addtri_tmps.next()
    let max = addtri_tmps.next()
    let halfsize = addtri_tmps.next()
    let cent = addtri_tmps.next()
    let ts = this.tris
    let vs = this.verts

    let area = math.tri_area(v1, v2, v3)

    while (cur > 0) {
      let ni = stack[--cur]

      if (!(ns[ni + NFLAG] & OcNodeFlags.LEAF)) {
        for (let i = 0; i < 8; i++) {
          let ni2 = ns[ni + NCHILD1 + i]
          if (ni2 > 0) {
            min[0] = ns[ni2 + NMINX]
            min[1] = ns[ni2 + NMINY]
            min[2] = ns[ni2 + NMINZ]
            max[0] = ns[ni2 + NMAXX]
            max[1] = ns[ni2 + NMAXY]
            max[2] = ns[ni2 + NMAXZ]
            halfsize[0] = ns[ni2 + NHALFSIZEX]
            halfsize[1] = ns[ni2 + NHALFSIZEY]
            halfsize[2] = ns[ni2 + NHALFSIZEZ]
            cent[0] = ns[ni2 + NCENTX]
            cent[1] = ns[ni2 + NCENTY]
            cent[2] = ns[ni2 + NCENTZ]

            if (triBoxOverlap(cent, halfsize, _tverts)) {
              stack.push(ni2)
            }
          }
        }

        continue
      }

      if (ns[ni + NTRITOT] >= this.leafLimit && ns[ni + NDEPTH] < this.maxDepth) {
        this.split(ni)
        stack.push(ni)
        continue
      }

      ns[ni + NAREA] += area
      //let size = halfsize.vectorLength() / Math.sqrt(3.0);

      let ti = ns[ni + NTRISTART] + ns[ni + NTRITOT] * TTOT
      ns[ni + NTRITOT]++

      ts[ti + TFEID] = feid
      ts[ti + TV1] = iv1
      ts[ti + TV2] = iv2
      ts[ti + TV3] = iv3
      ts[ti + TAREA] = area
      ts[ti + TNX] = nx
      ts[ti + TNY] = ny
      ts[ti + TNZ] = nz
    }
  }

  _newTriList() {
    let ts = this.trilist

    if (this.freelist.length > 0) {
      let ti = this.freelist.pop()
      return ti
    }

    let ti = ts.length
    ts.length += this.leafLimit * TTOT
  }
  _newNode() {
    let ns = this.nodes
    let ni = ns.length

    ns.length += NTOT

    for (let i = 0; i < NTOT; i++) {
      ns[ni + i] = 0.0
    }

    ns[ni + NTRISTART] = this._newTriList()

    return ni
  }

  gen() {}

  finish() {}
}
