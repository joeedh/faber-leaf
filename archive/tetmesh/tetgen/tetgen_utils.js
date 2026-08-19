import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as math from '../util/math.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'

import {TetTypes, TetFlags, TetRecalcFlags} from './tetgen_base.js'
import {TetLogContext} from './tetgen_base.js'
import {TetMesh} from './tetgen.js'
import {triBoxOverlap, aabb_ray_isect, ray_tri_isect} from '../util/isect.js'
import {getArrayTemp} from '../../addons/builtin/mesh/src/mesh_base.js'

export class OcTri {
  constructor(v1, v2, v3) {
    this.v1 = v1
    this.v2 = v2
    this.v3 = v3

    this.verts = [v1, v2, v3]
  }
}

export class IsectRayRet {
  constructor() {
    this.uv = new Vector2()
    this.t = 0
    this.p = new Vector3()
    this.tri = undefined
  }

  load(b) {
    this.uv.load(b.uv)
    this.p.load(b.p)
    this.t = b.t
    this.tri = b.tri

    return this
  }
}

let castray_rets = util.cachering.fromConstructor(IsectRayRet, 2048)
let castray_tmps = util.cachering.fromConstructor(Vector3, 64)

export class OcNode {
  constructor(min, max, leafLimit, maxDepth) {
    this.leaf = true
    this.min = new Vector3(min)
    this.max = new Vector3(max)
    this.size = new Vector3(max).sub(min)

    this.halfsize = new Vector3(this.size).mulScalar(0.5)
    this.cent = new Vector3(this.min).interp(this.max, 0.5)

    this.dead = false

    this.tris = []
    this.depth = 0
    this.subtree_depth = 0
    this.parent = undefined

    this.children = []

    this.leafLimit = leafLimit
    this.maxDepth = maxDepth
  }

  castRay(origin, ray) {
    let minret = castray_rets.next()
    let found = false

    if (!this.leaf) {
      for (let c of this.children) {
        if (!aabb_ray_isect(origin, ray, c.min, c.max)) {
          continue
        }

        let ret = c.castRay(origin, ray)

        if (!ret) {
          continue
        }

        if (!found || ret.t < minret.t) {
          minret.load(ret)
          found = true
        }
      }

      return found ? minret : undefined
    }

    let mint = undefined
    let co = castray_tmps.next()
    let mintri = undefined
    let uv = castray_tmps.next()

    for (let tri of this.tris) {
      let isect = ray_tri_isect(origin, ray, tri.v1, tri.v2, tri.v3)

      if (!isect) {
        continue
      }

      let t = isect[2]

      if (mint === undefined || (t >= 0 && t < mint)) {
        co.zero()

        co.addFac(tri.v1, isect[0])
        co.addFac(tri.v2, isect[1])
        co.addFac(tri.v3, 1.0 - isect[0] - isect[1])

        uv[0] = isect[0]
        uv[1] = isect[1]

        mintri = tri
        mint = t
      }
    }

    if (!mintri) {
      return undefined
    }

    let ret = castray_rets.next()

    ret.tri = mintri
    ret.p.load(co)
    ret.uv.load(uv)
    ret.t = mint

    return ret
  }

  countCastRays(origin, ray) {
    if (!this.leaf) {
      let tot = 0

      for (let c of this.children) {
        if (!aabb_ray_isect(origin, ray, c.min, c.max)) {
          continue
        }

        tot += c.countCastRays(origin, ray)
      }

      return tot
    }

    let tot = 0

    for (let tri of this.tris) {
      let isect = ray_tri_isect(origin, ray, tri.v1, tri.v2, tri.v3)

      if (!isect || isect[2] < 0) {
        continue
      }

      tot++
    }

    return tot
  }

  split() {
    util.console.log('split!')

    this.leaf = false

    this.subtree_depth++

    let sdepth = this.subtree_depth

    let p = this.parent
    while (p) {
      p.subtree_depth = Math.max(p.subtree_depth, sdepth)
      p = p.parent
      sdepth++
    }

    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          let min = new Vector3(this.min)

          min[0] += this.halfsize[0] * i
          min[1] += this.halfsize[1] * j
          min[2] += this.halfsize[2] * k

          let max = new Vector3(min).add(this.halfsize)

          let node = new OcNode(min, max, this.leafLimit, this.maxDepth)
          node.depth = this.depth + 1
          node.parent = this

          this.children.push(node)
        }
      }
    }

    for (let tri of this.tris) {
      this.addTri(tri)
    }

    this.tris.length = 0
  }

  splitTest() {
    let ok = this.tris.length >= this.leafLimit
    ok = ok && this.depth < this.maxDepth

    return ok
  }

  addTri(tri) {
    if (!this.leaf) {
      for (let c of this.children) {
        if (triBoxOverlap(c.cent, c.halfsize, tri.verts)) {
          c.addTri(tri)
        }
      }

      return
    }

    this.tris.push(tri)

    if (this.splitTest()) {
      this.split()
    }
  }
}

export function meshToTetMesh(mesh, tm = new TetMesh(), maxDepth = 5, leafLimit = 32, haveInterior = false) {
  let min = new Vector3().addScalar(1e17)
  let max = new Vector3().addScalar(-1e17)

  if (mesh.verts.length === 0) {
    min.zero()
    max.zero()
  }

  for (let v of mesh.verts) {
    min.min(v)
    max.max(v)
  }

  let d = 0.001
  min.addScalar(-d)
  max.addScalar(d)

  let node = new OcNode(min, max, leafLimit, maxDepth)
  let root = node

  let ltris = mesh.loopTris
  for (let i = 0; i < ltris.length; i += 3) {
    let l1 = ltris[i],
      l2 = ltris[i + 1],
      l3 = ltris[i + 2]
    let tri = new OcTri(l1.v, l2.v, l3.v)

    node.addTri(tri)
  }

  let maxdepth2 = 0
  let rec2 = (n) => {
    if (n.leaf) {
      maxdepth2 = Math.max(maxdepth2, n.depth)
    } else {
      for (let n2 of n.children) {
        rec2(n2)
      }
    }
  }
  rec2(root)

  //XXX
  maxdepth2 = maxDepth

  let nodes = []
  let rec = (n) => {
    if (n.leaf) {
      if (n.depth < maxdepth2) {
        n.split()
        return rec(n)
      }

      nodes.push(n)
    } else {
      for (let c of n.children) {
        rec(c)
      }
    }
  }

  rec(root)

  let vhash = new Map()
  let step = 1.0 / (min.vectorDistance(max) * 0.001)

  function getv(co) {
    let x = ~~(co[0] * step)
    let y = ~~(co[1] * step)
    let z = ~~(co[2] * step)

    let key = '' + x + ':' + y + ':' + z
    let v = vhash.get(key)

    if (!v) {
      v = tm.makeVertex(co)
      vhash.set(key, v)
    }

    return v
  }

  /*
  for (let n of nodes) {
    if (n.tris.length > 0) {
      continue;
    }

    let origin = new Vector3(n.cent);
    let ray = new Vector3([1, 2, 3]);
    ray.normalize();

    let count = root.countCastRays(origin, ray);

    util.console.log(count);

    if (count % 2 === 0) {
      n.dead = true;
    }
  }
  */

  console.log('done')

  nodes = nodes.filter((n) => !n.dead)

  console.log('nodes', nodes)

  for (let n of nodes) {
    if (!haveInterior && n.tris.length === 0) {
      continue
    }

    let vs = [
      [n.min[0], n.min[1], n.min[2]],
      [n.min[0], n.max[1], n.min[2]],
      [n.max[0], n.max[1], n.min[2]],
      [n.max[0], n.min[1], n.min[2]],

      [n.min[0], n.min[1], n.max[2]],
      [n.min[0], n.max[1], n.max[2]],
      [n.max[0], n.max[1], n.max[2]],
      [n.max[0], n.min[1], n.max[2]],
    ]

    for (let i = 0; i < 8; i++) {
      vs[i] = new Vector3(vs[i])
      vs[i] = getv(vs[i])
    }

    let c = tm.makeHex.apply(tm, vs)

    if (n.tris.length > 0) {
      c.flag |= TetFlags.SURFACE
    }
  }

  for (let c of tm.cells) {
    if (!(c.flag & TetFlags.SURFACE)) {
      continue
    }

    for (let p of c.planes) {
      if (p.plane_next === p) {
        p.f.flag |= TetFlags.SURFACE
      }
    }

    for (let f of c.faces) {
      if (f.p.plane_next === f.p) {
        f.flag |= TetFlags.SURFACE
      }
    }
  }

  console.log('marking inside nodes...')

  let stack = []

  let flag = TetFlags.TEMP1
  let flag2 = TetFlags.TEMP2

  for (let c of tm.cells) {
    if (!haveInterior) {
      break
    }
    if (c.flag & TetFlags.SURFACE) {
      c.flag |= flag | flag2

      for (let p of c.planes) {
        p.plane_next.c.flag |= flag2
      }
    }
  }

  for (let c of tm.cells) {
    if (!haveInterior) {
      break
    }

    if (c.flag & (flag | TetFlags.SURFACE)) {
      continue
    }

    c.calcCent()

    let origin = new Vector3(c.cent)
    let ray = new Vector3([1, 2, 3])
    ray.normalize()

    let count = root.countCastRays(origin, ray)

    if (Math.random() > 0.995) {
      console.log(count, c.cent)
    }

    if (count % 2 === 0) {
      tm.killCell(c)

      continue
    }

    if (c.flag & flag2) {
      continue
    }

    //good? now propegate
    stack.length = 0
    stack.push(c)
    c.flag |= flag

    while (stack.length > 0) {
      let c2 = stack.pop()

      for (let p of c2.planes) {
        let p2 = p.plane_next
        let c3 = p2.c

        if (c3.flag & TetFlags.SURFACE) {
          continue
        }

        if (!(c3.flag & flag)) {
          c3.flag |= flag
          //stack.push(c3);
        }
      }
    }
  }

  /*
  for (let c of tm.cells) {
    let ok = false;

    if (!(c.flag & TetFlags.SURFACE)) {
      continue;
    }

    for (let p of c.planes) {
      if (p.plane_next !== p) {
        ok = true;
        break;
      }
    }

    if (!ok) {
      tm.killCell(c);
    }
  }//*/

  for (let f of tm.faces) {
    if (!f.p) {
      tm.killFace(f)
    }
  }

  for (let e of tm.edges) {
    if (!e.l) {
      tm.killEdge(e)
    }
  }

  for (let v of tm.verts) {
    if (v.valence === 0) {
      tm.killVertex(v)
    }
  }

  tm.recalcNormals()
}

export function vertexSmooth(tm, verts = tm.verts, fac = 0.5) {
  let co = new Vector3()

  for (let v of verts) {
    co.zero()
    let tot = 0

    for (let e of v.edges) {
      let v2 = e.otherVertex(v)

      co.add(v2)
      tot++
    }

    if (tot) {
      co.mulScalar(1.0 / tot)
      v.interp(co, fac)
      v.flag |= TetFlags.UPDATE
    }
  }
}

export function tetMeshToMesh(tm, mesh = new Mesh()) {
  let fset = new Set()
  let eset = new Set()
  let vset = new Set()

  for (let f of tm.faces) {
    if (!f.p || f.flag & TetFlags.SURFACE) {
      //f.p.plane_next === f.p) {
      fset.add(f)

      for (let l of f.loops) {
        eset.add(l.e)
        vset.add(l.e.v1)
        vset.add(l.e.v2)
      }
    }
  }

  let eidMap = new Map()
  for (let v of vset) {
    let v2 = mesh.makeVertex(v)
    eidMap.set(v.eid, v2)
  }

  for (let e of eset) {
    let v1 = eidMap.get(e.v1.eid)
    let v2 = eidMap.get(e.v2.eid)

    if (!v1 || !v2) {
      throw new Error('eek')
    }

    let e2 = mesh.makeEdge(v1, v2)
    eidMap.set(e.eid, e2)
  }

  for (let f of fset) {
    let vs = []
    for (let l of f.loops) {
      vs.push(eidMap.get(l.v.eid))
    }

    let f2 = mesh.makeFace(vs)
    eidMap.set(f.eid, f2)
  }

  return eidMap
}

export function tetrahedralize(tm, cell, lctx) {
  let vs2 = cell.verts

  if (1 && cell.flag & TetFlags.FLIP_HEX) {
    vs2 = getArrayTemp(8, false)
    for (let i = 0; i < 8; i++) {
      vs2[i] = cell.verts[(i + 4) % 8]
    }
  }

  let [v1, v2, v3, v4, v5, v6, v7, v8] = vs2

  tm.killCell(cell)

  let faces = cell.faces
  for (let f of cell.faces) {
    if (!f.p) {
      tm.killFace(f)
    }
  }

  //let t3 = tm.makeTet(v2, v5, v7, v6);
  let t1 = tm.makeTet(v4, v2, v5, v7)
  let t2 = tm.makeTet(v5, v4, v2, v1)
  let t3 = tm.makeTet(v6, v7, v5, v2)
  let t4 = tm.makeTet(v8, v7, v5, v4)
  let t5 = tm.makeTet(v4, v7, v2, v3)

  return
  let dd2 = window.dd2 || 0

  /*
  let t1 = tm.makeTet(v4, v2, v5, v7);
  let t2 = tm.makeTet(v1, v2, v4, v5);
  let t3 = tm.makeTet(v2, v5, v7, v6);
  let t4 = tm.makeTet(v4, v5, v7, v8);
  let t5 = tm.makeTet(v4, v7, v2, v3);
  */
  if (dd2 & 1) tm.reverseCellWinding(t1)
  if (dd2 & 2) tm.reverseCellWinding(t2)
  if (dd2 & 4) tm.reverseCellWinding(t3)
  if (dd2 & 8) tm.reverseCellWinding(t4)
  if (dd2 & 16) tm.reverseCellWinding(t5)
}

export function tetrahedralizeMesh(tm, cells = tm.cells, lctx) {
  let cs = new Set()
  for (let c of cells) {
    if (c.planes.length === 6) {
      cs.add(c)
    }
  }

  console.log('cells', cs)

  let es = new Set()
  let fs = new Set()
  let vs = new Set()

  for (let c of cs) {
    for (let f of c.faces) {
      fs.add(f)
    }
    for (let e of c.edges) {
      es.add(e)
    }
    for (let v of c.verts) {
      vs.add(v)
    }
    tetrahedralize(tm, c, lctx)
  }

  for (let f of fs) {
    if (f.eid >= 0 && !f.p) {
      tm.killFace(f)
    }
  }

  for (let e of es) {
    if (e.eid >= 0 && !e.l) {
      tm.killEdge(e)
    }
  }

  for (let v of vs) {
    if (v.eid >= 0 && v.valence === 0) {
      tm.killVertex(v)
    }
  }

  tm.flagSurfaceFaces()
}
