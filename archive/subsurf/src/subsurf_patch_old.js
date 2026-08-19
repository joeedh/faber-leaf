import {Vector2, Vector3, Vector4, Quat, Matrix4} from '@framework/api'
import {util} from '@framework/api'

function facto(n) {
  let prod = 1
  for (let i = 1; i < n + 1; i++) {
    prod *= i
  }
  return prod
}

function gen_xy_array(sizex, sizey) {
  let arr = new Array([])
  for (let i = 0; i < sizex; i++) {
    arr.push(new Array([]))

    for (let j = 0; j < sizey; j++) {
      arr[i].push(new Vector3())
    }
  }

  return arr
}

function list(lst) {
  if (lst === undefined) return lst

  let ret = []

  if (lst instanceof Array) {
    for (let i = 0; i < lst.length; i++) {
      ret.push(lst[i])
    }
  } else {
    lst.forEach(function (item) {
      ret.push(item)
    }, this)
  }

  return ret
}

let _p_tab = [1, 3, 3, 1]
export class Patch {
  constructor(degx, degy) {
    this.size = [degx + 1, degy + 1]
    this.points = gen_xy_array(degx + 1, degy + 1)

    this.degree = [degx, degy]
  }

  eval(u, v) {
    let n = this.degree[0]
    let m = this.degree[1]
    let dx = this.size[0]
    let dy = this.size[1]

    let u2 = u
    let v2 = v

    let k = this.points
    let p = new Vector3()
    for (let i = 0; i < n + 1; i++) {
      for (let j = 0; j < m + 1; j++) {
        let bi = _p_tab[i]
        bi *= Math.pow(u, i) * Math.pow(1 - u, n - i)

        let bj = _p_tab[j]
        bj *= Math.pow(v, j) * Math.pow(1 - v, m - j)

        p.add(k[i][j].static_mulScalar(bi * bj))
      }
    }
  }
}

function tess_patch(m, face, patch, steps) {
  let df = 1.0 / (steps - 1)
  let verts = gen_xy_array(steps, steps)

  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      let p = patch.eval(df * i, df * j)

      let v = m.make_vert(p)
      verts[i][j] = v
    }
  }

  for (let i = 0; i < steps - 1; i++) {
    for (let j = 0; j < steps - 1; j++) {
      let vs = new Array([verts[i][j], verts[i + 1][j], verts[i + 1][j + 1], verts[i][j + 1]])
      vs.reverse()
      let f = m.make_face(vs)
      f.flag = face.flag
    }
  }
}

function out_patch(m, patch) {
  let verts = gen_xy_array(4, 4)

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let p = patch.points[i][j]

      let v = m.make_vert(p)
      verts[i][j] = v
    }
  }

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let vs = [verts[i][j], verts[i + 1][j], verts[i + 1][j + 1], verts[i][j + 1]]
      ensure_edge(m, vs[0], vs[1])
      ensure_edge(m, vs[1], vs[2])
      ensure_edge(m, vs[2], vs[3])
      ensure_edge(m, vs[3], vs[0])
    }
  }
}

function norm(m) {
  let sum = 0.0

  for (let k = 0; k < m.length; k++) {
    sum += m[k]
  }

  for (let k = 0; k < m.length; k++) {
    m[k] /= sum
  }
}

function get_v_loops(v, vlooplists) {
  let vloops
  if (vlooplists.hasOwnProperty(v.eid.toString())) {
    vloops = vlooplists[v.eid]
  } else {
    vloops = new Array()

    v.loops.forEach(function (l) {
      vloops.push(l)
    })

    vlooplists[v.eid.toString()] = vloops
  }

  return vloops
}

function get_ring(v, f) {
  let e = v.edges[0]
  let v1 = e.other_vert(v)
}

//we're assuming consistent face windings
function get_ring(v, f, vlooplists) {
  let lst = new Array()
  let l = null

  let vls = get_v_loops(v, vlooplists)
  for (let i = 0; i < vls.length; i++) {
    let l2 = vls[i]
    if (l2.v === v && l2.f === f) {
      l = l2
      break
    }
  }

  if (l === undefined) return lst

  let startl = l
  let unwind = false

  if (1) {
    while (1) {
      lst.push(l.next.v)
      lst.push(l.next.next.v)

      if (l.radial_next === l) {
        unwind = true
        break
      }

      l = l.radial_next.next

      if (l === startl) break
    }
  }

  l = startl.prev.radial_next
  if (l === l.radial_next || unwind === false) {
    if (l === l.radial_next && unwind) {
      lst.push(l.v)

      /*hackish! give startl.v greater weight*/
      lst.push(startl.v)
      lst.push(startl.v)
      lst.push(startl.v)
      lst.push(startl.v)
    }

    return lst
  }

  if (unwind) {
    /*hackish! give startl.v greater weight*/
    lst.push(startl.v)
    lst.push(startl.v)
    lst.push(startl.v)
    lst.push(startl.v)
  }

  let i = 0
  while (1) {
    lst.push(l.next.v)
    lst.push(l.next.next.v)

    if (l.prev.radial_next !== l.prev) {
      l = l.prev.radial_next
    } else {
      lst.push(l.prev.v)
      break
    }

    if (l === startl) break

    if (i > 1000) {
      console.log('lset test was necessary')
      i = -1
      break
    }

    i++
  }

  if (i === -1) {
    let lset = new util.set()
    while (1) {
      lst.push(l.next.v)
      lst.push(l.next.next.v)

      if (l.prev.radial_next !== l.prev) {
        l = l.prev.radial_next
      } else {
        lst.push(l.prev.v)

        lst.push(startl.v)
        lst.push(startl.v)
        lst.push(startl.v)
        break
      }

      if (l === startl) break

      if (lset.has(l)) {
        break
      }

      lset.add(l)
    }
  }

  return lst
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function match_quad(f, vlooplists) {
  let ptch = new Patch(3, 3)

  let ls = list(f.loops)

  let v1 = ls[0].v,
    v2 = ls[1].v,
    v3 = ls[2].v,
    v4 = ls[3].v

  let ps = ptch.points
  function corner(x, y, i) {
    let ring = get_ring(ls[i].v, f, vlooplists)
    ring.push(ls[i].v)

    ps[x][y] = new Vector3()

    let mc = new Array()
    for (let j = 0; j < ring.length - 1; j++) {
      mc.push(j % 2 === 0 ? 4 : 1)
    }

    let len = ls[i].v.edges.length
    mc.push(len * len)

    norm(mc)

    for (let j = 0; j < ring.length; j++) {
      if (j >= mc.length) break
      let v = ring[j]

      ps[x][y].add(v.co.static_mulScalar(mc[j]))
    }
  }

  corner(0, 0, 0)
  corner(0, 3, 1)
  corner(3, 3, 2)
  corner(3, 0, 3)

  function get_e_ring(v1, v2, f) {
    let l1 = null,
      l2 = null
    let r = []

    let vls = get_v_loops(v1, vlooplists)
    for (let i = 0; i < vls.length; i++) {
      let l = vls[i]

      if (l.f === f) {
        l1 = l
        break
      }
    }

    vls = get_v_loops(v2, vlooplists)

    for (let i = 0; i < vls.length; i++) {
      let l = vls[i]
      if (l.f === f) {
        l2 = l
        break
      }
    }

    if (l1 === undefined || l2 === undefined) {
      console.log('yeeek---->', l1, l2)
      console.log('subsurf yeek')

      return r
    }

    //corner1 adj1 adj2 corner2
    if (l1.next.v === v2) {
      if (l1.radial_next !== l1) {
        r.push(l1.radial_next.next.next.v)
        r.push(l1.prev.v)
        r.push(l1.next.next.v)
        r.push(l1.radial_next.prev.v)
      } else {
        r.push(v1)
        r.push(l1.prev.v)
        r.push(l1.next.next.v)
        r.push(v2)
      }
    } else {
      if (l2.radial_next.prev !== l2) {
        r.push(l2.radial_next.prev.v)
        r.push(l2.prev.prev.v)
        r.push(l2.radial_next.next.next.v)
        r.push(l2.prev.v)
      } else {
        r.push(v1)
        r.push(l2.prev.prev.v)
        r.push(v2)
        r.push(l2.prev.v)
      }
    }

    r.push(v1)
    r.push(v2)

    return r
  }

  function edge(x1, y1, x2, y2, v1, v2) {
    let r = get_e_ring(v1, v2, f)

    if (r.length !== 6) return

    let v11 = new Vector3()
    let v22 = new Vector3()

    let me1 = [2, 2, 1, 1, 8, 4]
    let me2 = [1, 1, 2, 2, 4, 8]
    me1[me1.length - 2] = 2 * v1.edges.length
    me2[me1.length - 1] = 2 * v2.edges.length
    norm(me1)
    norm(me2)

    for (let j = 0; j < me1.length; j++) {
      v11.add(r[j].co.static_mulScalar(me1[j]))
    }

    for (let j = 0; j < me2.length; j++) {
      v22.add(r[j].co.static_mulScalar(me2[j]))
    }

    ps[x1][y1] = v11
    ps[x2][y2] = v22
  }

  function rot(m, end) {
    //end is optional
    if (end === undefined) end = 0
    let m2 = []
    for (let i1 = m.length; i1 < -end; i1++) {
      m2.push(m[(i1 + 1) % (m.length - end)])
    }

    for (let i1 = m.length - end; i1 < m.length; i1++) {
      m2.push(m[i1])
    }

    for (let i1 = 0; i1 < m.length; i1++) m[i1] = m2[i1]
  }

  edge(0, 1, 0, 2, v1, v2)
  edge(1, 3, 2, 3, v2, v3)
  edge(3, 1, 3, 2, v4, v3)
  edge(1, 0, 2, 0, v1, v4)

  function interior(x, y, v) {
    let r = get_ring(v, f, vlooplists)
    r[3] = v

    if (v === ls[0].v) r = [ls[0].v, ls[1].v, ls[2].v, ls[3].v]
    else if (v === ls[1].v) r = [ls[1].v, ls[2].v, ls[3].v, ls[0].v]
    else if (v === ls[2].v) r = [ls[2].v, ls[3].v, ls[0].v, ls[1].v]
    else if (v === ls[3].v) r = [ls[3].v, ls[0].v, ls[1].v, ls[2].v]

    r.splice(r.indexOf(v), 1)
    r.push(v)

    let mi = [2, 1, 2, v.edges.length]
    norm(mi)

    ps[x][y] = new Vector3()
    for (let i = 0; i < 4; i++) {
      ps[x][y].add(r[i].co.static_mulScalar(mi[i]))
    }
  }

  interior(1, 1, v1)
  interior(1, 2, v2)
  interior(2, 2, v3)
  interior(2, 1, v4)

  return ptch
}

function v_in_e(e, v) {
  return v === e.v1 || v === e.v2
}
