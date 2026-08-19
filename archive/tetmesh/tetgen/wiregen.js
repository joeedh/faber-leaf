import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as math from '../util/math.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'
import {aabb_ray_isect, ray_tri_isect, triBoxOverlap} from '../util/isect.js'
import {tetrahedralizeMesh} from './tetgen_utils.js'
import {TetFlags} from './tetgen_base.js'
import {MAX_EDGE_FACES} from '../../addons/builtin/mesh/src/mesh_base.js'

function makeBoxVerts(min, max) {
  let ret = [
    [min[0], min[1], min[2]],
    [min[0], max[1], min[2]],
    [max[0], max[1], min[2]],
    [max[0], min[1], min[2]],

    [min[0], min[1], max[2]],
    [min[0], max[1], max[2]],
    [max[0], max[1], max[2]],
    [max[0], min[1], max[2]],
  ]

  for (let i = 0; i < ret.length; i++) {
    ret[i] = new Vector3(ret[i])
  }

  return ret
}

export class OcNode {
  constructor(min, max, maxDepth) {
    this.leaf = true

    this.min = new Vector3(min)
    this.max = new Vector3(max)
    this.size = new Vector3(max).sub(min)

    this.centw = 0

    this.verts = makeBoxVerts(this.min, this.max)

    this.halfsize = new Vector3(this.size).mulScalar(0.5)
    this.cent = new Vector3(this.min).interp(this.max, 0.5)

    this.dead = false
    this.edges = []
    this.sizes = []

    this.leafLimit = 16

    this.depth = 0
    this.subtree_depth = 0
    this.parent = undefined

    this.children = []

    this.maxDepth = maxDepth
  }

  split(getvert) {
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

          if (getvert) {
            for (let l = 0; l < node.verts.length; l++) {
              node.verts[l] = getvert(node.verts[l])
            }
          }
        }
      }
    }

    let edges = this.edges
    let sizes = this.sizes

    this.edges = []
    this.sizes = []

    let ei = 0
    for (let e of edges) {
      this.addEdge(e, sizes[ei++])
    }
  }

  addEdge(e, size) {
    if (!this.leaf) {
      for (let c of this.children) {
        if (math.aabb_isect_cylinder_3d(e.v1, e.v2, size, c.min, c.max)) {
          c.addEdge(e, size)
        }
      }
    } else {
      this.edges.push(e)
      this.sizes.push(size)
    }
  }
}

function sunion(a, b) {
  if (a === undefined) {
    return b
  } else {
    return Math.min(a, b)
  }
}

let _t1 = new Vector3()
let _t2 = new Vector3()
let _t3 = new Vector3()
let _t4 = new Vector3()

export class ImplicitWireGen {
  constructor(mesh, size, edges = mesh.edges, maxDepth = 4, minDepth = 3) {
    this.mesh = mesh
    this.verts = new Set()
    this.size = size

    this.projectVerts = true

    this.minDepth = minDepth
    this.maxDepth = maxDepth

    edges = this.edges = new Set(edges)

    let min = new Vector3().addScalar(1e17)
    let max = new Vector3().addScalar(-1e17)

    for (let e of edges) {
      this.verts.add(e.v1)
      this.verts.add(e.v2)
    }

    for (let v of this.verts) {
      min.min(v)
      max.max(v)
    }

    min.addScalar(-0.001)
    max.addScalar(0.001)

    let size2 = new Vector3(max).sub(min)
    size2 = Math.max(Math.max(size2[0], size2[1]), size2[2]) * 0.5

    let cent = new Vector3(min).interp(max, 0.5)

    min.load(cent).addScalar(-size2)
    max.load(cent).addScalar(size2)

    this.min = min
    this.max = max
    this.cent = cent

    //this.lookupTree = new OcNode(min, max, maxDepth);
    this.tree = new OcNode(min, max, maxDepth)
  }

  generate(tm) {
    let mesh = this.mesh
    let tree = this.tree
    let minDepth = this.minDepth

    let rec1 = (n) => {
      if (n.leaf && n.depth < minDepth) {
        n.split()
      }

      if (!n.leaf) {
        for (let c of n.children) {
          rec1(c)
        }
      }
    }

    rec1(this.tree)

    let nodes = new Set()
    let maxDepth = 0

    let rec2 = (n) => {
      if (!n.leaf) {
        for (let n2 of n.children) {
          rec2(n2)
        }
      } else {
        nodes.add(n)
        maxDepth = Math.max(maxDepth, n.depth)
      }
    }

    rec2(this.tree)

    for (let e of this.edges) {
      this.tree.addEdge(e, this.size)
    }

    maxDepth = Math.max(maxDepth, this.maxDepth)

    let dimen = 1 << (maxDepth + 2)
    console.log('dimen', dimen)

    let vhash = new Map()
    let _min = this.min,
      _max = this.max
    let _vscale = dimen / (this.max[0] - this.min[0])
    let sverts = []

    let getVert = (v) => {
      let x = ~~((v[0] - _min[0]) * _vscale + 0.00001)
      let y = ~~((v[1] - _min[1]) * _vscale + 0.00001)
      let z = ~~((v[2] - _min[2]) * _vscale + 0.00001)

      let key = z * dimen * dimen + y * dimen + x

      let ret = vhash.get(key)
      if (!ret) {
        ret = {
          co  : new Vector3(v),
          v   : tm.makeVertex(v),
          w   : this.evaluate(v),
          flag: 0,
        }

        ret.v.index = sverts.length
        sverts.push(ret)

        vhash.set(key, ret)
      }

      return ret
    }

    let SURFACE = 1

    for (let n of nodes) {
      for (let i = 0; i < n.verts.length; i++) {
        n.verts[i] = getVert(n.verts[i])
      }

      n.centw = this.evaluate(n.cent)
    }

    console.log('leaves', nodes)
    let nodes2 = []
    let p = new Vector3()

    function tag(n) {
      let mask = 0
      for (let i = 0; i < n.verts.length; i++) {
        if (n.verts[i].w < 0) {
          mask |= 1 << i
        }
      }

      if (n.centw < 0.0) {
        mask |= 1 << n.verts.length
      }

      if (n.edges.length > 0) {
        mask |= 1 << (n.verts.length + 1)
      }

      n.mask = mask
    }

    for (let n of nodes) {
      tag(n)
    }

    nodes2 = nodes.filter((n) => n.mask)

    let count = this.maxDepth - this.minDepth

    const mask2 = (1 << 7) - 1
    for (let step = 0; step < count; step++) {
      for (let n of new Set(nodes2)) {
        let ok = (n.mask || n.edges.length > 0) && n.depth < this.maxDepth

        //don't split if all verts are inside?
        //ok = ok && (n.mask & mask2) !== mask2;

        if (ok) {
          n.split(getVert)
          nodes2.delete(n)

          for (let c of n.children) {
            nodes2.add(c)
            tag(c)
          }
        }
      }

      nodes2 = nodes2.filter((n) => n.mask)
    }

    //surface verts
    let svs = new Set()

    for (let n of nodes2) {
      for (let v of n.verts) {
        if (v.w >= 0.0) {
          v.flag |= SURFACE
          svs.add(v)
        }
      }
    }

    console.log('surface verts:', svs)
    let co = new Vector3()
    let dv = new Vector3()
    let df = 0.0001

    let project = () => {
      for (let sv of svs) {
        let a = this.evaluate(sv.v)

        let totg = 0.0

        for (let i = 0; i < 3; i++) {
          co.load(sv.v)
          co[i] += df

          let b = this.evaluate(co)
          dv[i] = (b - a) / df

          totg += dv[i] * dv[i]
        }

        if (isNaN(dv.dot(dv))) {
          console.log(dv, co, sv, sv.v)
          throw new Error('nan!')
        }

        if (totg === 0.0) {
          continue
        }

        a /= totg
        sv.v.addFac(dv, -a)
      }
    }

    console.log('nodes2', nodes2)
    for (let n of nodes2) {
      let vs = n.verts
      tm.makeHex(vs[0].v, vs[1].v, vs[2].v, vs[3].v, vs[4].v, vs[5].v, vs[6].v, vs[7].v)
    }

    let svs2 = new Array(8)
    for (let c of tm.cells) {
      let i = 0
      for (let v of c.verts) {
        svs2[i++] = sverts[v.index]
      }

      let ok = svs2[0].w >= 0
      ok = ok || svs2[7] >= 0

      if (!ok) {
        c.flag |= TetFlags.FLIP_HEX
      }
    }

    tetrahedralizeMesh(tm, tm.cells)

    for (let v of tm.verts) {
      if (v.edges.length === 0) {
        tm.killVertex(v)
      }
    }

    for (let v of tm.verts) {
      let sv = sverts[v.index]
      let count = 0

      let flag = TetFlags.TEMP1

      if (sv.w < 0) {
        continue
      }

      for (let step = 0; step < 2; step++) {
        for (let e of v.edges) {
          let l = e.l
          let _i = 0

          if (!l) {
            continue
          }

          do {
            let f = l.f
            let p = f.p

            if (_i++ > MAX_EDGE_FACES) {
              console.error('infinite loop error')
              break
            }

            if (!p) {
              _i++
              l = l.radial_next
              continue
            }

            let _j = 0

            do {
              if (step === 0) {
                p.c.flag &= ~flag
              } else {
                if (!(p.c.flag & flag)) {
                  p.c.flag |= flag
                  count++
                }
              }

              if (_j++ > 100) {
                console.error('infinite loop error')
                break
              }

              p = p.plane_next
            } while (p !== f.p)

            l = l.radial_next
          } while (l !== e.l)
        }
      }

      if (Math.random() > 0.95) {
        console.log('count', count)
      }

      if (count < 2) {
        tm.killVertex(v)
      }
    }

    if (this.projectVerts) {
      project()
    }

    tm.regenAll()
    tm.recalcNormals()
    tm.flagSurfaceFaces()
  }

  evaluate(co) {
    let size = this.size

    let ret = 10000.0
    const t1 = _t1,
      t2 = _t2,
      t3 = _t3,
      t4 = _t4

    for (let e of this.edges) {
      t1.load(e.v2).sub(e.v1).normalize()
      t2.load(co).sub(e.v1)

      let d1 = t1.dot(t2)
      d1 = Math.min(Math.max(d1, 0.0), e.v1.vectorDistance(e.v2))

      t2.load(e.v1).addFac(t1, d1)

      let d = t2.vectorDistance(co) - size

      //let d = math.dist_to_line(co, e.v1, e.v2, true) - size;

      ret = sunion(ret, d)
    }

    if (ret === undefined) {
      return 1000.0
    }

    return ret
  }
}
