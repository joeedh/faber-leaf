import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as math from '../util/math.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'

import {TetTypes, TetFlags, TetRecalcFlags} from './tetgen_base.js'
import {TetElementList} from './tet_element_list.js'
import {TetVertex, TetElement, TetEdge, TetFace, TetLoop, TetCell, TetClasses, TetPlane} from './tetgen_types.js'
import {SceneObjectData} from '../sceneobject/sceneobject_base.js'
import {StandardTools} from '../sceneobject/stdtools.js'
import {Node, NodeFlags} from '../core/graph.js'
import {DependSocket} from '../core/graphsockets.js'
import {SelMask} from '../core/select_types.js'
import {DataBlock} from '../core/lib_api.js'
import {SimpleMesh, LayerTypes, PrimitiveTypes, ChunkedSimpleMesh} from '../webgl/simplemesh.ts'
import {Shaders} from '../shaders/shaders.js'
import {BVH} from '../../addons/builtin/mesh/src/bvh.js'
import {CDFlags} from '../../addons/builtin/mesh/src/customdata.js'
import {getArrayTemp} from '../../addons/builtin/mesh/src/mesh_base.js'

/*
  on factor;
  off period;

  load_package "avector";

  d := avec(dx, dy, dz);

  a := avec(ax, ay, az) - d;
  b := avec(bx, by, bz) - d;
  c := avec(cx, cy, cz) - d;

  tmp := b cross c;
  area := (a dot tmp) / 6.0;

  f1 := area - goal;

*/

export class TetMesh extends SceneObjectData {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  tet.TetMesh {
  eidgen : IDGen;
  elists : iterkeys(tet.TetElementList);
}
`
  )

  symflag = 0

  constructor() {
    super()

    this.elists = {}
    this.verts = this.edges = this.faces = this.cells = this.planes = undefined
    this.eidgen = new util.IDGen()
    this.eidMap = new Map()

    this.recalcFlag = TetRecalcFlags.ALL
    this.bvh = undefined

    this._meshes = {}
    this._last_render_key = ''
    this._last_bvh_key = ''

    this.updateGen = 0

    this.makeElists()

    Object.seal(this)
  }

  static dataDefine() {
    return {
      name          : 'TetMesh',
      selectMask    : SelMask.TETMESH, //valid selection modes for StandardTools, see SelMask
      selectTypeName: 'TETMESH',
    }
  }

  static nodedef() {
    return {
      name   : 'TetMesh',
      inputs : Node.inherit({...super.nodedef().inputs}),
      outputs: Node.inherit({...super.nodedef().outputs}),
      flag   : NodeFlags.SAVE_PROXY,
    }
  }

  static blockDefine() {
    return {
      typeName   : 'TetMesh',
      defaultName: 'TetMesh',
      uiName     : 'Tet Mesh',
      flag       : 0,
      icon       : -1,
    }
  }

  getBoundingBox() {
    let min = new Vector3(),
      max = new Vector3()

    min.addScalar(1e17)
    max.addScalar(-1e17)

    for (let v of this.verts) {
      min.min(v)
      max.max(v)
    }

    if (this.verts.length === 0) {
      min.zero().addScalar(-2)
      max.zero().addScalar(2)
    }

    return [min, max]
  }

  _ensureRender(gl) {
    let regen = this.recalcFlag & TetRecalcFlags.RENDER
    regen = regen || !this._meshes.faces

    if (regen) {
      this.genRender(gl)
    }

    return regen
  }

  drawIdsQ(view3d, queue, frame, selectMask, object) {}

  drawQ(view3d, queue, frame, object) {
    this._ensureRender(frame.gl)

    const smeshes = this._meshes
    const program = frame.program ?? Shaders.BasicLitMesh

    queue.submit({pipeline: program, mesh: smeshes.faces})
    queue.submit({
      pipeline: Shaders.ObjectLineShader,
      mesh: {
        draw: (gl, u, p) => smeshes.edges.drawLines(gl, u, p),
      },
    })
  }

  recalcStartLengths(edges = this.edges) {
    for (let e of edges) {
      e.startLength = e.v1.vectorDistance(e.v2)
    }

    for (let c of this.cells) {
      //XXX implement me
    }
  }

  drawElements(view3d, gl, uniforms, selmask, object) {
    //XXX implement me
    return this.draw(view3d, gl, uniforms, undefined, object)
  }

  drawWireframeQ(view3d, queue, frame, object) {}

  drawOutlineQ(view3d, queue, frame, object) {
    this.drawWireframeQ(view3d, queue, frame, object)
  }

  applyMatrix(matrix) {
    for (let v of this.verts) {
      v.multVecMatrix(matrix)
    }

    return this
  }

  makeElistAliases() {
    this.verts = this.elists[TetTypes.VERTEX]
    this.edges = this.elists[TetTypes.EDGE]
    this.loops = this.elists[TetTypes.LOOP]
    this.faces = this.elists[TetTypes.FACE]
    this.cells = this.elists[TetTypes.CELL]
    this.planes = this.elists[TetTypes.PLANE]

    return this
  }

  makeElists() {
    this.elists = {}

    for (let k in TetTypes) {
      this.elists[TetTypes[k]] = new TetElementList(TetTypes[k])
    }

    this.makeElistAliases()

    return this
  }

  _elementPush(elem, custom_eid = undefined) {
    if (custom_eid === undefined) {
      elem.eid = this.eidgen.next()
    } else {
      elem.eid = custom_eid
    }

    this.eidMap.set(elem.eid, elem)

    let list = this.elists[elem.type]

    list.initElem(elem)
    list.push(elem)
  }

  makeVertex(co, custom_eid = undefined) {
    let v = new TetVertex(co)

    this._elementPush(v, custom_eid)

    return v
  }

  ensureEdge(v1, v2, lctx) {
    let e = this.getEdge(v1, v2)

    if (e) {
      return e
    }

    return this.makeEdge(v1, v2, false, undefined, lctx)
  }

  getEdge(v1, v2) {
    for (let e of v1.edges) {
      if (e.otherVertex(v1) === v2) {
        return e
      }
    }

    return undefined
  }

  _diskInsert(v, e) {
    v.edges.push(e)
    return this
  }

  _diskRemove(v, e) {
    v.edges.remove(e)
    return this
  }

  makeEdge(v1, v2, checkExist = true, custom_eid = undefined, lctx) {
    if (checkExist) {
      let e = this.getEdge(v1, v2)

      if (e) {
        return e
      }
    }

    let e = new TetEdge()
    this._elementPush(e, custom_eid)

    e.v1 = v1
    e.v2 = v2

    e.startLength = v1.vectorDistance(v2)

    if (lctx) {
      lctx.newEdge(e)
    }

    this._diskInsert(e.v1, e)
    this._diskInsert(e.v2, e)

    return e
  }

  _radialInsert(e, l) {
    if (e.l === undefined) {
      e.l = l
      l.radial_next = l.radial_prev = l
    } else {
      l.radial_prev = e.l
      l.radial_next = e.l.radial_next
      e.l.radial_next.radial_prev = l
      e.l.radial_next = l
    }
  }

  _radialRemove(e, l) {
    if (e.l === l) {
      e.l = l === l.radial_next ? undefined : l.radial_next
    }

    l.radial_next.radial_prev = l.radial_prev
    l.radial_prev.radial_next = l.radial_next
  }

  selectNone() {
    for (let k in this.elists) {
      this.elists[k].selectNone()
    }
  }

  selectAll() {
    for (let k in this.elists) {
      this.elists[k].selectAll()
    }
  }

  reverseCellWinding(c) {
    for (let p of c.planes) {
      this.reverseFaceWinding(p.f)
    }

    c.verts.reverse()
    c.planes.reverse()
    c.faces.reverse()
    c.edges.reverse()
  }

  reverseFaceWinding(f) {
    for (let l of f.loops) {
      this._radialRemove(l.e, l)
    }

    f.loops.reverse()

    for (let i = 0; i < f.loops.length; i++) {
      let l = f.loops[i]
      l.next = f.loops[(i + 1) % f.loops.length]
      l.prev = f.loops[(i - 1 + f.loops.length) % f.loops.length]
    }
    f.l = f.loops[0]

    for (let l of f.loops) {
      l.e = this.getEdge(l.v, l.next.v)
      if (!l.e) {
        console.log(l, l.next)
        throw new Error('eek!')
      }
      this._radialInsert(l.e, l)
    }
  }

  makeFace(vs, lctx, custom_eid) {
    let f = new TetFace()
    this._elementPush(f, custom_eid)

    for (let i = 0; i < vs.length; i++) {
      let l = new TetLoop()
      this._elementPush(l)

      l.v = vs[i]
      l.f = f

      f.loops.push(l)
    }

    for (let i = 0; i < f.loops.length; i++) {
      let l = f.loops[i]

      l.next = f.loops[(i + 1) % f.loops.length]
      l.prev = f.loops[(i - 1 + f.loops.length) % f.loops.length]
      l.radial_next = l.radial_prev = l

      l.e = this.ensureEdge(l.v, l.next.v)
      this._radialInsert(l.e, l)
    }

    f.l = f.loops[0]

    if (lctx) {
      lctx.newFace(f)
    }

    return f
  }

  _makePlane(f, cell, custom_eid) {
    let p = new TetPlane()

    p.plane_next = p.plane_prev = p
    p.eid = custom_eid !== undefined ? custom_eid : this.eidgen.next()

    p.c = cell
    p.f = f

    this.eidMap.set(p.eid, p)
    this.planes.push(p)

    return p
  }

  _planeInsert(f, p) {
    if (f.p === undefined) {
      f.p = p
      p.plane_next = p.plane_prev = p
    } else {
      p.plane_prev = f.p
      p.plane_next = f.p.plane_next

      f.p.plane_next.plane_prev = p
      f.p.plane_next = p
    }
  }

  _planeRemove(f, p) {
    if (f.p === p) {
      f.p = p === p.plane_next ? undefined : p.plane_next
    }

    p.plane_next.plane_prev = p.plane_prev
    p.plane_prev.plane_next = p.plane_next
  }

  ensureFace(vs, lctx) {
    let v = vs[0]

    for (let e of v.edges) {
      let l = e.l
      let _i = 0

      if (!l) {
        continue
      }

      do {
        for (let v2 of vs) {
          v2.flag &= ~TetFlags.MAKEFACE_TEMP
        }

        for (let l2 of l.f.loops) {
          l2.v.flag |= TetFlags.MAKEFACE_TEMP
        }

        let ok = true

        for (let v2 of vs) {
          if (!(v2.flag & TetFlags.MAKEFACE_TEMP)) {
            ok = false
            break
          }
        }

        if (ok) {
          return l.f
        }

        if (_i++ > 100) {
          console.warn('infinite loop error')
          break
        }
        l = l.radial_next
      } while (l !== e.l)
    }

    return this.makeFace(vs, lctx)
  }

  findHex(vs) {
    let flag = TetFlags.MAKEFACE_TEMP
    for (let v of vs) {
      v.flag &= ~flag
    }

    for (let e of vs[0].edges) {
      if (!e.l) {
        continue
      }

      let l = e.l
      let _i = 0

      do {
        if (_i++ > 100) {
          console.warn('Infinite loop error')
          break
        }

        let f = l.f
        let p = f.p

        if (!p) {
          l = l.radial_next
          continue
        }

        let _j = 0
        do {
          let c = p.c
          if (c.verts.length !== 8) {
            continue
          }

          for (let v of c.verts) {
            v.flag |= flag
          }

          let count = 0
          for (let v of vs) {
            if (v.flag & flag) {
              count++
            }
          }

          if (count === vs.length) {
            return c
          }

          for (let v of vs) {
            v.flag &= ~flag
          }

          if (_j++ > 100) {
            console.warn('infinite loop error')
            break
          }
          p = p.plane_next
        } while (p !== f.p)

        l = l.radial_next
      } while (l !== e.l)
    }
  }

  makeHex(v1, v2, v3, v4, v5, v6, v7, v8, checkExist = false, lctx) {
    if (checkExist) {
      let vs = getArrayTemp(8, false)
      vs[0] = v1
      vs[1] = v2
      vs[2] = v3
      vs[3] = v4
      vs[4] = v5
      vs[5] = v6
      vs[6] = v7
      vs[7] = v8

      let c = this.findHex(vs)
      if (c) {
        if (checkExist === 2) {
          throw new Error('hex already exists')
        } else {
          return c
        }
      }
    }
    /*
    let f1 = this.ensureFace([v4, v3, v2, v1], lctx);
    let f2 = this.ensureFace([v5, v6, v7, v8], lctx);
    let f3 = this.ensureFace([v1, v2, v6, v5], lctx);

    let f4 = this.ensureFace([v2, v3, v7, v6], lctx);
    let f5 = this.ensureFace([v3, v4, v8, v7], lctx);
    let f6 = this.ensureFace([v4, v1, v5, v8], lctx);
    */
    let f1 = this.ensureFace([v1, v2, v3, v4], lctx)
    let f2 = this.ensureFace([v8, v7, v6, v5], lctx)
    let f3 = this.ensureFace([v5, v6, v2, v1], lctx)

    let f4 = this.ensureFace([v6, v7, v3, v2], lctx)
    let f5 = this.ensureFace([v7, v8, v4, v3], lctx)
    let f6 = this.ensureFace([v8, v5, v1, v4], lctx)

    /*
    let dd = window.dd || 0;

    if (dd & 1)
      this.reverseFaceWinding(f1);
    if (dd & 2)
      this.reverseFaceWinding(f2);
    if (dd & 4)
      this.reverseFaceWinding(f3);
    if (dd & 8)
      this.reverseFaceWinding(f4);
    if (dd & 16)
      this.reverseFaceWinding(f5);
    if (dd & 32)
      this.reverseFaceWinding(f6);
    //*/

    let hex = new TetCell()
    this._elementPush(hex)

    hex.faces.length = 6
    hex.faces[0] = f1
    hex.faces[1] = f2
    hex.faces[2] = f3
    hex.faces[3] = f4
    hex.faces[4] = f5
    hex.faces[5] = f6

    for (let i = 0; i < 6; i++) {
      let f = hex.faces[i]
      let p = (hex.planes[i] = this._makePlane(f, hex))

      this._planeInsert(f, p)
    }

    hex.verts.length = 8
    hex.verts[0] = v1
    hex.verts[1] = v2
    hex.verts[2] = v3
    hex.verts[3] = v4
    hex.verts[4] = v5
    hex.verts[5] = v6
    hex.verts[6] = v7
    hex.verts[7] = v8

    hex._regenEdges()

    return hex
  }

  makeTet(v1, v2, v3, v4, lctx) {
    let f1 = this.ensureFace([v4, v2, v1], lctx)
    let f2 = this.ensureFace([v4, v3, v2], lctx)
    let f3 = this.ensureFace([v4, v1, v3], lctx)
    let f4 = this.ensureFace([v1, v2, v3], lctx)

    let dd3 = window.dd3 || 0

    if (dd3 & 1) this.reverseFaceWinding(f1)
    if (dd3 & 2) this.reverseFaceWinding(f2)
    if (dd3 & 4) this.reverseFaceWinding(f3)
    if (dd3 & 8) this.reverseFaceWinding(f4)

    let tet = new TetCell()
    this._elementPush(tet)

    tet.planes.length = 4
    tet.faces.length = 4
    tet.verts.length = 4

    tet.faces[0] = f1
    tet.faces[1] = f2
    tet.faces[2] = f3
    tet.faces[3] = f4

    tet.verts[0] = v1
    tet.verts[1] = v2
    tet.verts[2] = v3
    tet.verts[3] = v4

    for (let i = 0; i < tet.faces.length; i++) {
      let f = tet.faces[i]
      let p = (tet.planes[i] = this._makePlane(f, tet))
      this._planeInsert(f, p)
    }

    tet._regenEdges()

    if (lctx) {
      lctx.newCell(tet)
    }

    return tet
  }

  _elementKill(elem) {
    if (elem.eid < 0) {
      console.warn('Element was already freed!', elem)
      return false
    }

    this.eidMap.delete(elem.eid)
    this.elists[elem.type].remove(elem)
    elem.eid = -1

    return true
  }

  killVertex(v) {
    let _i = 0

    while (v.edges.length > 0) {
      if (_i++ > 1000) {
        console.warn('infinite loop error')
        break
      }

      this.killEdge(v.edges[0])
    }

    this._elementKill(v)
  }

  killEdge(e) {
    let _i = 0

    while (e.l) {
      if (_i++ > 1000) {
        console.warn('infinite loop error')
        break
      }

      this.killFace(e.l.f)
    }

    this._diskRemove(e.v1, e)
    this._diskRemove(e.v2, e)

    this._elementKill(e)
  }

  killFace(f) {
    let _i = 0

    while (f.p) {
      if (_i++ > 100) {
        console.warn('infinite loop error')
        break
      }

      this.killCell(f.p.c)
    }

    for (let l of f.loops) {
      this._radialRemove(l.e, l)
      this._elementKill(l)
    }

    this._elementKill(f)
  }

  killCell(c) {
    for (let p of c.planes) {
      this._planeRemove(p.f, p)
      this._elementKill(p)
    }

    this._elementKill(c)
  }

  dataLink(getblock, getblock_addUser) {
    super.dataLink(getblock, getblock_addUser)
  }

  getElemLists() {
    let lists = []

    for (let k in this.elists) {
      lists.push(this.elists[k])
    }

    return lists
  }

  copyElemData(dst, src) {
    for (let i = 0; i < dst.customData.length; i++) {
      dst.customData[i].load(src.customData[i])
    }

    //make sure dst is actually in this mesh before selecting it
    if (src.flag & TetFlags.SELECT && dst.eid >= 0 && this.eidMap.get(dst.eid) === dst) {
      this.setSelect(dst, true)
    }

    dst.flag = src.flag
    switch (dst.type) {
      case TetPlane:
        dst.no.load(src.no)
        dst.cent.load(src.cent)
        break
      case TetFace:
        dst.no.load(src.no)
        dst.cent.load(src.cent)
        break
      case TetVertex:
        dst.no.load(src.no)
        break
    }
  }

  setSelect(elem, state) {
    this.elists[elem.type].setSelect(elem, state)
    return this
  }

  copy() {
    let ret = new TetMesh()
    let eidMap = ret.eidMap

    let lists = this.getElemLists()

    for (let list of lists) {
      let cls = TetClasses[list.type]
      let list2 = ret.elists[list.type]

      list2.customData = list.customData.copy()

      for (let elem of list) {
        let elem2 = new cls()

        switch (elem.type) {
          case TetTypes.EDGE:
            elem2.v1 = elem.v1
            elem2.v2 = elem.v2
            break
          case TetTypes.LOOP:
            elem2.v = elem.v
            break
          case TetTypes.FACE:
            for (let l of elem.loops) {
              elem2.loops.push(l)
            }
            break
          case TetTypes.PLANE:
            elem2.f = elem.f
            break
          case TetTypes.CELL:
            for (let p of elem.planes) {
              elem2.planes.push(p)
            }
            for (let v of elem.verts) {
              elem2.verts.push(v)
            }
            break
        }
        ret.copyElemData(elem2, elem)

        elem2.eid = elem.eid
        elem2.flag = elem.flag
        elem2.index = elem.index

        list2.initElem(elem2)
        list2.push(elem2)

        eidMap.set(elem2.eid, elem2)
      }
    }

    for (let v of ret.verts) {
      for (let i = 0; i < v.edges.length; i++) {
        v.edges[i] = eidMap.get(v.edges[i].eid)
      }
    }

    for (let e of ret.edges) {
      e.v1 = eidMap.get(e.v1.eid)
      e.v2 = eidMap.get(e.v2.eid)
    }

    for (let l of ret.loops) {
      l.v = eidMap.get(l.v.eid)
    }

    for (let f of ret.faces) {
      for (let i = 0; i < f.loops.length; i++) {
        f.loops[i] = eidMap.get(f.loops[i].eid)
      }

      for (let i = 0; i < f.loops.length; i++) {
        let l = f.loops[i]

        l.next = f.loops[(i + 1) % f.loops.length]
        l.prev = f.loops[(i - 1 + f.loops.length) % f.loops.length]

        l.e = ret.getEdge(l.v, l.next.v)
        ret._radialInsert(l.e, l)
      }

      f.l = f.loops[0]
    }

    for (let p of ret.planes) {
      p.f = eidMap.get(p.f.eid)
      ret._planeInsert(p.f, p)
    }

    for (let c of ret.cells) {
      for (let i = 0; i < c.planes.length; i++) {
        let p = (c.planes[i] = eidMap.get(c.planes[i].eid))
        p.c = c
        c.faces.push(p.f)
      }

      for (let i = 0; i < c.verts.length; i++) {
        c.verts[i] = eidMap.get(c.verts[i].eid)
      }

      c._regenEdges()
    }
  }

  loadSTRUCT(reader) {
    super.loadSTRUCT(reader)

    let elists = {}
    for (let elist of this.elists) {
      elists[elist.type] = elist
    }
    this.elists = elists

    this.makeElistAliases()

    let eidMap = (this.eidMap = new Map())

    for (let k in this.elists) {
      let list = this.elists[k]

      for (let elem of list) {
        eidMap.set(elem.eid, elem)
      }
    }

    for (let e of this.edges) {
      e.v1 = eidMap.get(e.v1)
      e.v2 = eidMap.get(e.v2)

      e.startLength = e.v1.vectorDistance(e.v2)

      this._diskInsert(e.v1, e)
      this._diskInsert(e.v2, e)
    }

    for (let l of this.loops) {
      l.v = eidMap.get(l.v)
      l.next = eidMap.get(l.next)
      l.prev = eidMap.get(l.prev)
    }

    for (let f of this.faces) {
      for (let i = 0; i < f.loops.length; i++) {
        f.loops[i] = eidMap.get(f.loops[i])
      }
      for (let i = 0; i < f.loops.length; i++) {
        let l = f.loops[i]

        l.next = f.loops[(i + 1) % f.loops.length]
        l.prev = f.loops[(i - 1 + f.loops.length) % f.loops.length]
      }
      f.l = f.loops[0]

      for (let l of f.loops) {
        l.e = this.ensureEdge(l.v, l.next.v)
        l.f = f

        this._radialInsert(l.e, l)
      }
    }

    for (let p of this.planes) {
      p.f = eidMap.get(p.f)
      this._planeInsert(p.f, p)
    }

    for (let c of this.cells) {
      for (let i = 0; i < c.faces.length; i++) {
        c.faces[i] = eidMap.get(c.faces[i])
        c.planes[i] = eidMap.get(c.planes[i])
        c.planes[i].c = c
      }

      for (let i = 0; i < c.verts.length; i++) {
        c.verts[i] = eidMap.get(c.verts[i])
      }

      for (let f of c.faces) {
        f.c = c

        for (let l of f.loops) {
          l.c = c
        }
      }

      c._regenEdges()
    }
  }

  regenAll() {
    this.recalcFlag |= TetRecalcFlags.ALL
  }

  regenPartial() {}

  regenRender() {
    this.recalcFlag |= TetRecalcFlags.RENDER
  }

  static makeBVH(tm) {
    let [min, max] = tm.getBoundingBox()
    let eps = min.vectorDistance(max) * 0.01

    min.addScalar(-eps)
    max.addScalar(eps)

    let bvh = new BVH(tm, min, max)

    let cd_node = tm.verts.customData.getLayerIndex('bvh')
    if (cd_node < 0) {
      let layer = tm.verts.addCustomDataLayer('bvh')
      layer.flag |= CDFlags.TEMPORARY
      cd_node = layer.index
    }

    bvh.cd_node = new AttrRef(cd_node)

    let time = util.time_ms()

    let i = 0
    for (let f of tm.faces) {
      let ls = f.loops

      bvh.addTri(f.eid, i++, ls[0].v, ls[1].v, ls[2].v, false, ls[0], ls[1], ls[2])

      if (f.isQuad()) {
        bvh.addTri(f.eid, i++, ls[0].v, ls[2].v, ls[3].v, false, ls[0], ls[2], ls[3])
      }
    }

    time = util.time_ms() - time
    console.error('BVH build time:', time.toFixed(2) + 'ms')

    return bvh
  }

  getBVH() {
    let key = ''

    for (let k in this.elists) {
      let elist = this.elists[k]

      key += elist.length + ':'
    }

    key += this.updateGen

    if (key !== this._last_bvh_key) {
      console.error('Regenerating BVH', key, this._last_bvh_key)
      this._last_bvh_key = key

      if (this.bvh) {
        this.bvh.destroy(this)
      }

      this.bvh = TetMesh.makeBVH(this)
    }

    return this.bvh
  }

  regenBVH() {
    if (this.bvh) {
      this.bvh.destroy(this)
      this.bvh = undefined
    }
  }

  genRender(gl) {
    this.recalcFlag &= ~TetRecalcFlags.RENDER

    let key = ''
    for (let k in this.elists) {
      let elist = this.elists[k]
      key += elist.length + ':'
    }

    if (key !== this._last_render_key || this.recalcFlag & TetRecalcFlags.TESSELATION) {
      this.recalcFlag &= ~TetRecalcFlags.TESSELATION

      console.log('full element redraw', key, 'previous key was:', this._last_render_key)

      this._last_render_key = key

      for (let k in this._meshes) {
        this._meshes[k].destroy(gl)
      }

      this._meshes = {}
    }

    console.log('Generating tet draw meshes')

    let layerflag = LayerTypes.LOC | LayerTypes.NORMAL | LayerTypes.UV | LayerTypes.ID
    layerflag = layerflag | LayerTypes.COLOR

    let getMesh = (name, primtype = PrimitiveTypes.TRIS) => {
      let key = name

      if (key in this._meshes) {
        return this._meshes[key]
      }

      let sm = (this._meshes[key] = new ChunkedSimpleMesh(layerflag))
      sm.primflag = primtype

      return sm
    }

    let sm

    let black = [0, 0, 0, 1]
    let white = [1, 1, 1, 1]

    sm = getMesh('faces')
    for (let f of this.faces) {
      if (f.flag & TetFlags.HIDE) {
        continue
      }

      let ls = f.loops
      let c = white

      if (ls.length === 4) {
        let tri = sm.tri(f.eid * 2, ls[0].v, ls[1].v, ls[2].v)
        tri.normals(f.no, f.no, f.no)
        tri.colors(c, c, c, c)
        tri.ids(f.eid + 1, f.eid + 1, f.eid + 1)

        tri = sm.tri(f.eid * 2 + 1, ls[0].v, ls[2].v, ls[3].v)
        tri.normals(f.no, f.no, f.no)
        tri.colors(c, c, c, c)
        tri.ids(f.eid + 1, f.eid + 1, f.eid + 1)
      } else {
        let tri = sm.tri(f.eid * 2, ls[0].v, ls[1].v, ls[2].v)
        tri.normals(f.no, f.no, f.no)
        tri.colors(c, c, c, c)
        tri.ids(f.eid + 1, f.eid + 1, f.eid + 1)
      }
    }

    sm = getMesh('edges', PrimitiveTypes.LINES)
    let uv1 = [0, 0]
    let uv2 = [1, 1]

    for (let e of this.edges) {
      let line = sm.line(e.eid, e.v1, e.v2)

      line.colors(black, black)
      line.ids(e.eid + 1, e.eid + 1)
      line.uvs(uv1, uv2)
    }
  }

  flagSurfaceFaces() {
    for (let f of this.faces) {
      f.flag &= ~TetFlags.SURFACE
    }

    for (let f of this.faces) {
      if (!f.p || f.p.plane_next === f.p) {
        f.flag |= TetFlags.SURFACE
      }
    }
  }

  regenNormals() {
    this.recalcFlag |= TetRecalcFlags.NORMALS
  }

  checkNormals() {
    if (!(this.recalcFlag & TetRecalcFlags.NORMALS)) {
      return
    }

    this.recalcNormals()
  }

  recalcNormals() {
    this.recalcFlag &= ~TetRecalcFlags.NORMALS

    let cd_disp = this.verts.customData.getLayerIndex('displace')

    for (let f of this.faces) {
      f.calcNormal(cd_disp)
    }

    for (let c of this.cells) {
      if (c.isTet()) {
        c.volume = math.tet_volume(c.verts[0], c.verts[1], c.verts[2], c.verts[3])
        if (c.startVolume === 0) {
          c.startVolume = c.volume
        }
      }
    }

    for (let v of this.verts) {
      v.no.zero()

      for (let e of v.edges) {
        for (let l of e.loops) {
          v.no.add(l.f.no)
        }
      }

      if (v.no.dot(v.no) > 0) {
        v.no.normalize()
      } else {
        v.no[2] = 1.0 //ensure non-zero normal
      }
    }

    return this
  }
}

DataBlock.register(TetMesh)
SceneObjectData.register(TetMesh)
