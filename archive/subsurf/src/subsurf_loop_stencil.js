import {Vector2, Vector3, Vector4, Matrix4, Quat} from '@framework/api'
import {util} from '@framework/api'
import {math} from '@framework/api'
import {MeshTypes, MeshFlags} from '../../mesh/src/mesh_base.js'

import {sym, binop, checksym, unaryop, call} from '@framework/api'

export class SymVector3 extends Array {
  constructor(val) {
    super()

    this.length = 3

    if (val) {
      this.load(val)
    } else {
      this[0] = sym(0)
      this[1] = sym(1)
      this[2] = sym(2)
    }
  }

  load(b) {
    this[0] = sym(b[0])
    this[1] = sym(b[1])
    this[2] = sym(b[2])

    return this
  }

  add(b) {
    this[0] = binop(this[0], b[0], '+')
    this[1] = binop(this[1], b[1], '+')
    this[2] = binop(this[2], b[2], '+')

    return this
  }

  sub(b) {
    this[0] = binop(this[0], b[0], '-')
    this[1] = binop(this[1], b[1], '-')
    this[2] = binop(this[2], b[2], '-')

    return this
  }

  mul(b) {
    this[0] = binop(this[0], b[0], '*')
    this[1] = binop(this[1], b[1], '*')
    this[2] = binop(this[2], b[2], '*')

    return this
  }

  div(b) {
    this[0] = binop(this[0], b[0], '/')
    this[1] = binop(this[1], b[1], '/')
    this[2] = binop(this[2], b[2], '/')

    return this
  }

  negate(b) {
    this.mulScalar(-1.0)
    return this
  }

  mulScalar(b) {
    this[0] = binop(this[0], b, '*')
    this[1] = binop(this[1], b, '*')
    this[2] = binop(this[2], b, '*')

    return this
  }

  dot(v) {
    let a = binop(this[0], v[0], '*')
    let b = binop(this[1], v[1], '*')
    let c = binop(this[2], v[2], '*')

    let ret = binop(a, b, '+')
    return binop(ret, c, '+')
  }

  normalize() {
    let l = this.vectorLength()

    this[0] = binop(this[0], l, '/')
    this[1] = binop(this[1], l, '/')
    this[2] = binop(this[2], l, '/')

    return this
  }

  vectorLengthSqr() {
    return this.dot(this)
  }

  vectorLength() {
    return call('sqrt', this.vectorLengthSqr())
  }

  vectorDistanceSqr(b) {
    let tmp = this.copy()
    tmp.sub(b)

    return tmp.dot(tmp)
  }

  addFac(b, c) {
    this[0] = binop(binop(this[0], b[0], '+'), c, '*')
    this[1] = binop(binop(this[1], b[1], '+'), c, '*')
    this[2] = binop(binop(this[2], b[2], '+'), c, '*')

    return this
  }

  vectorDistance(b) {
    let ret = this.vectorDistanceSqr(b)
    return call('sqrt', [ret])
  }

  copy() {
    let ret = new SymVector3()

    ret[0] = this[0].copy()
    ret[1] = this[1].copy()
    ret[2] = this[2].copy()

    return ret
  }
}

export function* getAdjLoopTris(mesh, v) {
  let ltris = mesh.loopTris
  let lstart = mesh._ltrimap_start
  let llen = mesh._ltrimap_len

  for (let l of v.loops) {
    let i1 = lstart[l.f.eid]
    let i2 = i1 + llen[l.f.eid] * 3

    for (let i = i1; i < i2; i += 3) {
      let l1 = ltris[i],
        l2 = ltris[i + 1],
        l3 = ltris[i + 2]

      if (l1 === l || l2 === l || l3 === l) {
        yield i
      }
    }
  }
}

export function* getNeighbors(mesh, v) {
  let ltris = mesh.loopTris

  let flag = MeshFlags.ITER_TEMP1

  for (let i of getAdjLoopTris(mesh, v)) {
    let l1 = ltris[i],
      l2 = ltris[i + 1],
      l3 = ltris[i + 2]

    l1.flag &= ~flag
    l2.flag &= ~flag
    l3.flag &= ~flag
  }

  for (let i of getAdjLoopTris(mesh, v)) {
    for (let j = i; j < i + 3; j++) {
      let l = ltris[j]

      if (l.v !== v && !(l.flag & flag)) {
        l.flag |= flag

        yield l.v
      }
    }
  }
}

let _digest2 = new util.HashDigest()

export function hashFace(mesh, f) {
  let digest = _digest2.reset()

  let ltris = mesh.loopTris
  let lstart = mesh._ltrimap_start
  let llen = mesh._ltrimap_len

  let i = 0
  for (let l of f.loops) {
    l.index = i++
  }

  let i1 = lstart[f.eid],
    i2 = i1 + llen[f.eid] * 3

  for (let i = i1; i < i2; i++) {
    digest.add(ltris[i].index)
  }

  return digest.get()
}

let _digest = new util.HashDigest()

export function hashTri(mesh, ls, fhashmap) {
  let digest = _digest.reset()

  for (let i = 0; i < ls.length; i++) {
    let l1 = ls[i]
    let l2 = ls[(i + 1) % 3]

    digest.add(l1.f.lists.length)
    digest.add(l1.list.length)
    digest.add(mesh.getEdge(l1.v, l2.v) !== undefined)
    digest.add(fhashmap.get(l1.f))
  }

  return digest.get()
}

export function buildLoopIdx(mesh, f, lmap) {
  let ltris = mesh.loopTris
  let lstart = mesh._ltrimap_start
  let llen = mesh._ltrimap_len

  let i1 = lstart[f.eid]
  let i2 = i1 + llen[f.eid] * 3

  for (let i = i1; i < i2; i++) {
    let l = ltris[i]

    lmap.set(l, i)
  }
}

export function buildTriData(tri) {}

let hashes = {}
hashes.length = 0

export function hashTris(mesh) {
  let fmap = new Map()

  for (let f of mesh.faces) {
    fmap.set(hashFace(mesh, f))
  }

  let ltris = mesh.loopTris
  let ls = [0, 0, 0]

  for (let i = 0; i < ltris.length; i += 3) {
    ls[0] = ltris[i]
    ls[1] = ltris[i + 1]
    ls[2] = ltris[i + 2]

    let hash = hashTri(mesh, ls, fmap)
    if (!(hash in hashes)) {
      hashes.length++
    }

    hashes[hash] = 1
  }

  return hashes
}

window.hashTris = hashTris
