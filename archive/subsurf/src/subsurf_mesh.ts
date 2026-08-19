import {Number3, Vector3} from '@framework/api'
import {util} from '@framework/api'
import {PCOS, PTOT, PatchList} from './subsurf_base.js'
import {MeshTypes, MeshFlags} from '../../mesh/src/mesh_base.js'
import {BVHVertFlags, MDynVert} from '../../mesh/src/bvh.js'
import {Edge, Face, Loop, Mesh, Vertex} from '../../mesh/src/mesh.js'
import {CustomDataElem} from '../../mesh/src/customdata.js'

const eco = new Vector3()
const ccSmoothRets = util.cachering.fromConstructor(Vector3, 128)
const ccSmoothTemps = util.cachering.fromConstructor(Vector3, 64)

export function ccSmooth(
  v: Vertex,
  cd_fset: number | undefined,
  cd_dyn_vert: number,
  projection = 0.0,
  weight1?: number,
  weightR?: number,
  weightS?: number
) {
  const ret = ccSmoothRets.next()

  const val = v.edges.length
  let tot = 0.0
  let boundary = 0

  if (val === 0.0) {
    return
  }

  if (weight1 === undefined) {
    weight1 = (val - 3) / val
  }

  if (weightR === undefined) {
    weightR = 2.0 / val
  }

  if (weightS === undefined) {
    weightS = 1.0 / val
  }

  const mv = v.customData[cd_dyn_vert] as MDynVert

  for (const e of v.edges) {
    let bflag = false

    if (e.l?.radial_next === e.l) {
      bflag = true
    } else {
      const v2 = e.otherVertex(v)
      const mv2 = v2.customData[cd_dyn_vert] as MDynVert

      if (mv.flag & BVHVertFlags.BOUNDARY_ALL && mv2.flag & BVHVertFlags.BOUNDARY_ALL) {
        bflag = true
      }
    }

    if (bflag) {
      boundary++
    }
  }

  if (boundary && v.edges.length === 2) {
    return ret.load(v.co)
  }

  const pco = ccSmoothTemps.next()

  if (boundary) {
    eco.zero()

    const w1 = 1
    const w2 = 2

    eco.load(v.co)
    eco.mulScalar(w1)

    tot = w1

    for (const e of v.edges) {
      const v2 = e.otherVertex(v)
      let w2 = 1.0

      if (e.l?.radial_next === e.l) {
        w2 = 10.0
      } else {
        const v2 = e.otherVertex(v)
        const mv2 = v2.customData[cd_dyn_vert] as MDynVert

        if (mv.flag & BVHVertFlags.BOUNDARY_ALL && mv2.flag & BVHVertFlags.BOUNDARY_ALL) {
          w2 = 10.0
        }
      }

      pco.load(v2.co).sub(v.co)

      eco.addFac(pco, -pco.dot(v.no) * w2)
      eco.addFac(v2.co, w2)
      tot += w2
    }

    if (tot === 0.0) {
      return
    }

    eco.mulScalar(1.0 / tot)

    ret.load(eco)
    return ret
  }

  const w1 = weight1

  ret.load(v.co).mulScalar(w1)
  tot += w1

  const wR = weightR
  const wS = weightS

  eco.zero()
  let tot2 = 0.0

  for (const f of v.faces) {
    eco.addFac(f.cent, 1.0)
    tot2 += 1.0
  }

  if (tot2) {
    eco.mulScalar(1.0 / tot2)
    ret.addFac(eco, wS)
    tot += wS
  }

  eco.zero()
  tot2 = 0.0

  for (const e of v.edges) {
    const v2 = e.otherVertex(v)

    eco.addFac(v2.co, 1.0)
    tot2 += 1.0
  }

  if (tot2 > 0.0) {
    eco.mulScalar(1.0 / tot2)
    ret.addFac(eco, wR)
    tot += wR
  }

  if (tot !== 0.0) {
    ret.mulScalar(1.0 / tot)
  }

  return ret
}

//this assumes that all faces are already quads
export function createPatches(mesh: Mesh) {
  const patches = new PatchList()
  const ps = [] as number[]

  for (const f of mesh.faces) {
    const l = f.lists[0].l

    const pi = ps.length
    patches.eidMap.set(f.eid, pi)

    for (let i = 0; i < PTOT; i++) {
      ps.push(0.0)
    }

    const v1 = l.v
    const v2 = l.next.v
    const v3 = l.next.next.v
    const v4 = l.next.next.next.v

    for (let _i = 0; _i < 3; _i++) {
      const i = _i as Number3
      ps[pi + PCOS + i] = v1.co[i]
      ps[pi + PCOS + (0 * 4 + 4) * 3 + i] = v2.co[i]
      ps[pi + PCOS + (4 * 4 + 4) * 3 + i] = v3.co[i]
      ps[pi + PCOS + (4 * 4 + 0) * 3 + i] = v4.co[i]
    }
  }

  let dimen = patches.patchdata.length / 4

  dimen = Math.ceil(Math.sqrt(dimen))
  dimen = Math.ceil(Math.log(dimen) / Math.log(2.0))
  dimen = 1 << dimen

  patches.texdimen = dimen
  const totps = dimen * dimen * 4

  while (ps.length < totps) {
    ps.push(0.0)
  }

  patches.patchdata = new Float32Array(ps)
  return patches
}

export function loopSubdivide(mesh: Mesh, facesIn: Iterable<Face> = mesh.faces) {
  const faces = new Set<Face>()
  for (const f of facesIn) {
    let ok = f.lists.length === 1
    ok = ok && f.lists[0].length === 3
    if (ok) {
      faces.add(f)
    }
  }

  console.log(faces)
  const vset = new Set<Vertex>()
  const eset = new Set<Edge>()

  for (const f of faces) {
    for (const l of f.lists[0]) {
      vset.add(l.v)
      eset.add(l.e)
    }
  }

  const vdatas = new Map<Vertex, any>()
  const vlist = [] as Vertex[]
  const wlist = [] as number[]

  for (const e of eset) {
    vset.add(e.v1)
    vset.add(e.v2)
  }

  function makeDummy(v: Vertex) {
    let d = {} as any
    d = Object.create(d)
    d.co = new Vector3()
    d.customData = v !== undefined ? v.customData.map((f) => f.copy()) : []
    d.eid = v !== undefined ? v.eid : -1
    d.type = MeshTypes.VERTEX

    return d
  }

  for (const v of vset) {
    const dummy = makeDummy(v)
    let tot = 0.0

    vlist.length = 0
    wlist.length = 0

    for (const v2 of v.neighbors) {
      const w = 1.0

      dummy.addFac(v2, w)

      vlist.push(v2)
      wlist.push(w)

      tot += w
    }

    const w1 = tot * 0.5

    vlist.push(v)
    wlist.push(w1)
    dummy.addFac(v, w1)

    tot += w1

    if (tot !== 0.0) {
      dummy.mulScalar(1.0 / tot)

      for (let i = 0; i < wlist.length; i++) {
        wlist[i] /= tot
      }
    }

    //XXX
    //dummy.load(v);

    mesh.verts.customDataInterp(dummy, vlist, wlist)
    vdatas.set(v, dummy)
  }

  const splitvs = new Set()
  for (const e of new Set(eset)) {
    const d1 = vdatas.get(e.v1)
    const d2 = vdatas.get(e.v2)

    const [ne, nv] = mesh.splitEdge(e)

    splitvs.add(nv)
    eset.add(ne)

    mesh.verts.setSelect(nv, true)
    mesh.edges.setSelect(ne, true)

    const dummy = makeDummy(nv)
    vlist.length = 3
    wlist.length = 3

    vlist[0] = d1
    vlist[1] = d2
    vlist[2] = nv

    const w1 = 1
    const w2 = 1
    const w3 = 1

    wlist[0] = w1 / (w1 + w2 + w3)
    wlist[1] = w2 / (w1 + w2 + w3)
    wlist[2] = w3 / (w1 + w2 + w3)

    dummy.load(d1).interp(d2, 0.5).interp(nv, 0.5)

    mesh.verts.customDataInterp(dummy, vlist, wlist)

    vdatas.set(nv, dummy)

    nv.customData = dummy.customData
    nv[0] = dummy[0]
    nv[1] = dummy[1]
    nv[2] = dummy[2]
  }

  for (const v of vset) {
    const d = vdatas.get(v)
    v.customData = d.customData
    //continue;
    v[0] = d[0]
    v[1] = d[1]
    v[2] = d[2]
  }

  function lerp(l: Loop, l1: Loop, l2: Loop, l3: Loop) {
    mesh.copyElemData(l, l1)
    mesh.copyElemData(l.next, l2)
    mesh.copyElemData(l.next.next, l3)
  }

  for (const f of faces) {
    const l1 = f.lists[0].l
    const l2 = l1.next
    const l3 = l2.next
    const l4 = l3.next
    const l5 = l4.next
    const l6 = l5.next

    const t1 = mesh.makeTri(l6.v, l1.v, l2.v)
    const t2 = mesh.makeTri(l2.v, l3.v, l4.v)
    const t3 = mesh.makeTri(l4.v, l5.v, l6.v)
    const t4 = mesh.makeTri(l6.v, l2.v, l4.v)

    mesh.faces.setSelect(t1, true)
    mesh.faces.setSelect(t2, true)
    mesh.faces.setSelect(t3, true)
    mesh.faces.setSelect(t4, true)

    lerp(t1.lists[0].l, l6, l1, l2)
    lerp(t2.lists[0].l, l2, l3, l4)
    lerp(t3.lists[0].l, l4, l5, l6)
    lerp(t4.lists[0].l, l6, l2, l4)

    mesh.killFace(f)
  }
}

export function subdivide(mesh: Mesh, faces: Iterable<Face> = mesh.faces, linear = false) {
  const fset = new Set<Face>()
  const eset = new Set<Edge>()
  const vset = new Set<Vertex>()
  const splitvs = new Set<Vertex>()

  const lmap = new Map<number, Face>()

  const lsinterp = [] as Loop[]
  const vsinterp = [] as Vertex[]
  const winterp = [] as number[]

  for (const f of faces) {
    fset.add(f)
    f.calcCent()

    for (const list of f.lists) {
      for (const l of list) {
        vset.add(l.v)
        eset.add(l.e)
      }
    }
  }

  function getorig(v: Vertex) {
    return v
  }

  const cents = []

  for (const f of faces) {
    f.calcCent()
    f.index = cents.length

    f.flag |= MeshFlags.UPDATE

    const centv = mesh.makeVertex(f.cent)

    mesh.verts.setSelect(centv, true)

    f.lists[0]._recount()

    vsinterp.length = 0
    const fw = 1.0 / f.lists[0].length

    for (const l of f.lists[0]) {
      vsinterp.push(l.v)
      lsinterp.push(l)
      winterp.push(fw)
    }

    mesh.verts.customDataInterp(centv, vsinterp, winterp)

    cents.push(centv)
  }

  const vset2 = new Set<Vertex>()
  const vset3 = new Set<Vertex>()

  for (const e of eset) {
    vset2.add(e.v1)
    vset2.add(e.v2)
  }

  for (const v of vset) {
    vset2.add(v)

    for (const f of v.faces) {
      for (const list of f.lists) {
        for (const l of list) {
          vset2.add(l.v)
        }
      }
    }
  }

  for (const v of vset2) {
    vset3.add(v)
  }

  const vcos = new Array<Vector3>(vset3.size)

  let i = 0
  for (const v of vset3) {
    for (const e of v.edges) {
      vset3.add(e.otherVertex(v))
    }

    v.index = i
    vcos[i] = new Vector3(v.co)
    i++
  }

  const eco = new Vector3()

  const vlist = [] as Vertex[]
  const wlist = [] as number[]

  for (const e of eset) {
    const v1 = e.v1
    const v2 = e.v2

    e.flag |= MeshFlags.UPDATE
    v1.flag |= MeshFlags.UPDATE
    v2.flag |= MeshFlags.UPDATE

    //console.log("subdividing edge", e.eid);
    const ret = mesh.splitEdge(e, 0.5)

    const ne = ret[0]
    const nv = ret[1]

    mesh.verts.setSelect(nv, true)
    mesh.edges.setSelect(ne, true)

    mesh.updateMirrorTag(nv)

    splitvs.add(nv)
    vlist.length = 0
    wlist.length = 0

    if (!linear && e.l && e.l.radial_next !== e.l) {
      const cent1 = cents[e.l.f.index]
      const cent2 = cents[e.l.radial_next.f.index]

      eco.load(vcos[v1.index]).add(vcos[v2.index])
      eco.add(cent1.co).add(cent2.co)
      eco.mulScalar(0.25)

      vlist.push(cent1)
      vlist.push(cent2)
      vlist.push(v1)
      vlist.push(v2)
      for (let i = 0; i < 4; i++) {
        wlist.push(0.25)
      }

      mesh.verts.customDataInterp(nv, vlist, wlist)

      nv.co.load(eco)
    } else if (!linear && e.l) {
      const cent1 = cents[e.l.f.index]

      /*
      on factor;

      polya := w1*a + w2*b + w3*c;
      polyb := w1*a + w3*c + w4*d;

      f1 := k1 + (k2 - k1)*v;
      f2 := k4 + (k3 - k4)*v;
      f3 := f1 + (f2 - f1)*u;

      wq1 := sub(k1=1, k2=0, k3=0, k4=0, f3);
      wq2 := sub(k1=0, k2=1, k3=0, k4=0, f3);
      wq3 := sub(k1=0, k2=0, k3=1, k4=0, f3);
      wq4 := sub(k1=0, k2=0, k3=0, k4=1, f3);

      polyc := wq1*a + wq2*b + wq3*c + wq4*d;

      f1 := polya*mul1 - polyc;
      f2 := polyb - polyc;

      solve({f1, f2}, {w1, w2});

      **/
      eco.load(vcos[v1.index]).add(vcos[v2.index])
      const w = 0.0
      eco.addFac(cent1.co, w)

      vlist.push(cent1)
      vlist.push(v1)
      vlist.push(v2)
      for (let i = 0; i < 4; i++) {
        wlist.push(1.0 / (2.0 + w))
      }

      mesh.verts.customDataInterp(nv, vlist, wlist)

      eco.mulScalar(1.0 / (2.0 + w))
      nv.co.load(eco)
    } else {
      eco.load(vcos[v1.index]).interp(vcos[v2.index], 0.5)
      nv.co.load(eco)
    }

    nv.index = -1
  }

  if (!linear) {
    function finish(v: Vertex) {
      //return;
      if (wlist.length !== vlist.length) {
        throw new Error()
      }
      if (wlist.length === 0) {
        return
      }

      let totw = 0.0
      for (const w of wlist) {
        totw += w
      }
      for (let i = 0; i < wlist.length; i++) {
        wlist[i] /= totw
      }

      mesh.verts.customDataInterp(v, vlist, wlist)
    }

    for (const v of vset2) {
      let dummy

      const val = v.edges.length
      let tot = 0.0

      if (v.edges.length === 2) {
        let bad = false
        for (const e of v.edges) {
          if (!e.l || e.l.radial_next === e.l) {
            bad = true
            break
          }
        }

        if (bad) {
          continue
        }
      }

      const w1 = (val - 3) / val
      tot += w1

      const wR = 2.0 / val
      const wS = 1.0 / val

      vlist.length = 0
      wlist.length = 0

      if (1) {
        dummy = {customData: [] as CustomDataElem[]}
        for (const cd of v.customData) {
          dummy.customData.push(cd.copy())
        }

        vlist.push(dummy as unknown as Vertex)
        wlist.push(w1)
      }

      v.co.mulScalar(w1)

      eco.zero()
      let tot2 = 0.0
      let boundary = 0

      for (const e of v.edges) {
        if (e.l?.radial_next === e.l) {
          boundary++
        }
      }

      if (boundary) {
        eco.zero()

        const w1 = 1
        const w2 = 2

        eco.load(vcos[v.index])
        eco.mulScalar(w1)

        tot = w1

        for (const e of v.edges) {
          if (e.l?.radial_next === e.l) {
            const v2 = e.otherVertex(v)

            eco.addFac(v2.co, w2)

            wlist.push(w2 / v.edges.length)
            vlist.push(getorig(v2))

            tot += w2
          }
        }

        eco.mulScalar(1.0 / tot)
        v.load(eco)

        finish(v)
        continue
      }

      for (const e of v.edges) {
        let v2 = e.otherVertex(v)

        //vlist.push(v2);
        vlist.push(getorig(v2))
        wlist.push(wR / v.edges.length)

        let co2 = v2.co
        if (!splitvs.has(v2)) {
          co2 = vcos[v2.index]
        }

        eco.addFac(co2, 1.0)
        tot2 += 1.0
      }

      if (tot2 > 0.0) {
        eco.mulScalar(1.0 / tot2)
        v.co.addFac(eco, wR)
        tot += wR
      }

      eco.zero()
      tot2 = 0.0

      for (const f of v.faces) {
        if (boundary) {
          break
        }

        for (const l2 of f.lists[0]) {
          const v2 = l2.v === v ? dummy : getorig(l2.v)

          vlist.push(v2 as unknown as Vertex)
          wlist.push(wS / v.edges.length / f.lists[0].length)
        }

        eco.addFac(cents[f.index].co, 1.0)
        tot2 += 1.0
      }

      if (tot2) {
        eco.mulScalar(1.0 / tot2)
        v.co.addFac(eco, wS)
        tot += wS
      }

      /*
      if (boundary) {
        let w2 = 1.0;
        v.addFac(vcos[v.index], w2);

        tot += w2;
      }
      */

      finish(v)

      v.co.mulScalar(1.0 / tot)
      mesh.doMirrorSnap(v)
    }
  }

  for (const f of fset) {
    const centv = cents[f.index]

    lsinterp.length = 0
    winterp.length = 0

    f.lists[0]._recount()

    const fw = 1.0 / f.lists[0].length

    for (const l of f.lists[0]) {
      lsinterp.push(l)
      winterp.push(fw)
    }

    let l = f.lists[0].l
    let _i = 0
    do {
      const li = lsinterp.indexOf(l)
      const t = lsinterp[li]
      lsinterp[li] = lsinterp[lsinterp.length - 1]
      lsinterp[lsinterp.length - 1] = t

      /*
      let v1 = l.v;
      let v2 = l.next.v;
      let v3 = centv;
      let v4 = l.prev.v;
      */

      const v1 = centv
      const v2 = l.prev.v
      const v3 = l.v
      const v4 = l.next.v

      const f2 = mesh.makeQuad(v1, v2, v3, v4)
      const l2 = f2.lists[0].l

      f2.calcCent()

      lmap.set(l.eid, f2)

      mesh.loops.customDataInterp(l2, lsinterp, winterp)
      mesh.copyElemData(l2.next, l.prev)
      mesh.copyElemData(l2.next.next, l)
      mesh.copyElemData(l2.prev, l.next)

      mesh.faces.setSelect(f2, true)

      for (const l of f2.lists[0]) {
        mesh.edges.setSelect(l.e, true)
      }

      if (_i++ > 10000) {
        console.warn('infinite loop in subdiivde')
        break
      }

      l = l.next.next
    } while (l !== f.lists[0].l)

    mesh.killFace(f)
  }

  for (const v of vset) {
    mesh.doMirrorSnap(v)
  }
  for (const v of splitvs) {
    mesh.doMirrorSnap(v)
  }

  mesh.updateMirrorTags()
  mesh.validateMesh()

  return {
    oldLoopEidsToQuads: lmap,
    newVerts          : splitvs,
  }
  //return mesh;
}
