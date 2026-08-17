import {Vector3, Vector2, Vector4, Matrix4, Quat} from '../../../util/vectormath.js'
import {ToolOp, UndoFlags} from '../../../path.ux/scripts/pathux.js'
import {keymap} from '../../../path.ux/scripts/util/simple_events.js'
import {MeshFlags, MeshTypes} from '../../../../addons/builtin/mesh/src/mesh_base.js'
import type {Mesh, Vertex, Face} from '../../../../addons/builtin/mesh/src/mesh.js'
import {SelMask} from '../../../core/select_types.js'
import {SceneObject, ObjectFlags} from '../../../sceneobject/sceneobject.js'
import {PropModes, TransDataType, TransDataElem, TransDataList, ITransDataType} from './transform_base.js'
import * as util from '../../../util/util.js'
import {aabb_union} from '../../../util/math.js'
import {SpatialHash} from '../../../util/spatialhash.js'

import {ConstraintSpaces} from './transform_base.js'
import {ToolContext} from '../../../core/context.js'
import type {TransformOp} from './transform_ops.js'

interface MeshUndoData {
  cos: Map<number, Vector3>
  nos: Map<number, Vector3>
  fnos: Map<number, Vector3>
  fcos: Map<number, Vector3>
}

const meshGetCenterTemps = util.cachering.fromConstructor(Vector3, 64)
const meshGetCenterTemps2 = util.cachering.fromConstructor(Vector3, 64)
const meshGetCenterTempsMats = util.cachering.fromConstructor(Matrix4, 16)

const meshapplytemp = new Vector3()

export class MeshTransList extends TransDataList<Vertex, Vector3> {
  faces = new Set<Face>()
  normalvs = new Set<Vertex>()
}
export class MeshTransVert extends TransDataElem<Vertex, Vector3> {
  mesh?: Mesh
}

export const MeshTransType: ITransDataType<Vertex, Vector3, MeshTransVert> = {
  transformDefine() {
    return {
      name  : 'mesh',
      uiname: 'Mesh',
      flag  : 0,
      icon  : -1,
    }
  },

  isValid: TransDataType.isValid,

  /**FIXME this only handles the active mesh object, it should
   iterate over ctx.selectedMeshObjets*/
  genData(
    ctx: ToolContext,
    selectmode: number,
    propmode: number,
    propradius: number,
    toolop: TransformOp
  ): TransDataList<Vertex, Vector3> | undefined {
    const mesh = ctx.mesh
    const tdata = new MeshTransList(this)

    if (!mesh || !(selectmode & SelMask.GEOM)) {
      return undefined
    }

    const faces = (tdata.faces = new Set())
    const normalvs = (tdata.normalvs = new Set())

    const propconnected = true

    if (propmode !== undefined && !propconnected) {
      let i = 0
      const unset_w = 100000.0

      const visit = new WeakSet()
      const vs = new Set(mesh.verts.selected.editable)
      const boundary = new Set<Vertex>()

      for (const v of vs) {
        v.index = i

        const td = new MeshTransVert()

        td.mesh = mesh
        td.data1 = v
        td.w = 0.0
        td.data2 = new Vector3(v.co)
        td.symFlag = mesh.symFlag

        tdata.push(td)

        for (const e of v.edges) {
          const v2 = e.otherVertex(v)
          let ok = !(v2.flag & MeshFlags.HIDE)
          ok = ok && !(v2.flag & MeshFlags.SELECT)

          if (ok) {
            boundary.add(v)
            break
          }
        }

        td.w = v.flag & MeshFlags.SELECT ? 0.0 : unset_w
        i++
      }

      //let shash = SpatialHash.fromMesh(mesh, mesh.verts.editable);
      //console.log("shash:", shash);

      const bvh = mesh.getBVH()
      bvh.update()

      const tvs = new Map<Vertex, number>()
      for (const v of boundary) {
        for (const bvhv of bvh.closestVerts(v.co, propradius * 1.1)) {
          const v2 = bvhv as Vertex

          if (boundary.has(v2) || v === v2) {
            continue
          }

          let w = tvs.get(v2)
          if (w === undefined) {
            tvs.set(v2, v.co.vectorDistanceSqr(v2.co))
          } else {
            w = Math.min(w, v.co.vectorDistanceSqr(v2.co))
            tvs.set(v2, w)
          }
        }
      }

      for (const [v, dis] of tvs) {
        const td = new MeshTransVert()

        td.mesh = mesh
        td.data1 = v
        td.w = Math.sqrt(dis)
        td.data2 = new Vector3(v.co)
        td.symFlag = mesh.symFlag

        tdata.push(td)
      }

      console.log(tvs)

      for (const td of tdata) {
        td.w = TransDataType.calcPropCurve(td.w, propmode, propradius)
      }
    } else if (propmode !== undefined) {
      let i = 0
      const unset_w = 100000.0

      const visit = new WeakSet()
      const vs = new Set(mesh.verts.selected.editable)
      const boundary = new Set<Vertex>()

      for (const v of vs) {
        v.index = i

        const td = new MeshTransVert()

        td.mesh = mesh
        td.data1 = v
        td.w = 0.0
        td.data2 = new Vector3(v.co)
        td.symFlag = mesh.symFlag

        tdata.push(td)

        for (const e of v.edges) {
          const v2 = e.otherVertex(v)
          let ok = !(v2.flag & MeshFlags.HIDE)
          ok = ok && !(v2.flag & MeshFlags.SELECT)

          if (ok) {
            boundary.add(v)
            break
          }
        }

        td.w = v.flag & MeshFlags.SELECT ? 0.0 : unset_w
        i++
      }

      const limit = 2

      const doneset = new WeakSet()

      interface RingStack extends Array<Vertex | number> {
        cur: number
        end: number
      }

      let stack = [] as unknown as RingStack

      stack.cur = 0
      stack.end = 0

      for (const vboundary of vs) {
        stack.push(vboundary)
        stack.push(vboundary)
        stack.push(0)
      }
      stack.end = stack.length

      stack.length *= 8

      const _i = 0

      let vi = 0
      const wmap = new Array<number>(mesh.verts.length)
      const totmap = new Array<number>(mesh.verts.length)

      for (const v of mesh.verts) {
        wmap[vi] = -1
        totmap[vi] = 0
        v.index = vi++
      }

      for (const v of vs) {
        wmap[v.index] = 0.0
      }

      const radius = propradius * 1.01

      while (stack.length > 0 && Math.abs(stack.cur - stack.end) !== 0) {
        const v = stack[stack.cur++] as Vertex
        const vboundary = stack[stack.cur++] as Vertex
        const waccum = stack[stack.cur++] as number

        const w = v.co.vectorDistance(vboundary.co)

        //if (_i++ > 1000000) {
        //  console.warn("infinite loop detected");
        // break;
        //}

        stack.cur = stack.cur % stack.length

        const td = new MeshTransVert()

        td.data1 = v
        td.data2 = new Vector3(v.co)
        td.mesh = mesh
        td.w = w
        td.symFlag = mesh.symFlag

        tdata.push(td)
        for (const e of v.edges) {
          const v2 = e.otherVertex(v)

          if (v === v2 || v2.flag & (MeshFlags.SELECT | MeshFlags.HIDE)) {
            continue
          }

          const dis = v2.co.vectorDistance(v.co)
          const dx = v2.co[0] - v.co[0]
          const dy = v2.co[1] - v.co[1]
          const dz = v2.co[2] - v.co[2]

          //hackish, try to cull unrelated geometry with geometric distance
          if (w + dis > propradius) {
            continue
          }

          const w2 = w + dis
          const w3 = !doneset.has(v2) ? w2 : wmap[v2.index]

          wmap[v2.index] = Math.min(w2, w3)

          if (doneset.has(v2)) {
            continue
          }

          doneset.add(v2)

          const end = (stack.end + 3) % stack.length

          if (end === stack.cur) {
            console.warn('Reallocating stack', stack.length, stack.cur, stack.end)
            const len: number = stack.length * 3

            const stack2: RingStack = new Array(len) as RingStack
            for (let i = 0; i < stack.length; i++) {
              const i2 = (i + stack.cur) % stack.length
              stack2[i] = stack[i2]
            }

            stack2.cur = 0
            stack2.end = stack.length - 3
            stack = stack2
          }

          stack[stack.end++] = v2
          stack[stack.end++] = vboundary
          stack[stack.end++] = waccum + dis
          stack.end = stack.end % stack.length
        }
      }

      for (const v of vs) {
        //wmap[v.index] = 0;
      }

      for (const td of tdata) {
        td.w = wmap[td.data1.index]

        let tot = totmap[td.data1.index]
        tot = !tot ? 1.0 : tot

        td.w /= tot
        td.w = TransDataType.calcPropCurve(td.w, propmode, propradius)
      }

      //      tdata[v.index].w = TransDataType.calcPropCurve(tdata[v.index].w, propmode, propradius);
    } else {
      for (const v of mesh.verts.selected.editable) {
        const td = new MeshTransVert()
        td.data1 = v
        td.data2 = new Vector3(v.co)
        td.mesh = mesh
        td.w = 1.0
        td.symFlag = mesh.symFlag

        tdata.push(td)
      }
    }

    for (const td of tdata) {
      const v = td.data1

      normalvs.add(v)

      for (const f of v.faces) {
        faces.add(f)
      }
    }

    for (const f of faces) {
      for (const l of f.loops) {
        normalvs.add(l.v)

        /*
        if (l === l.radial_next) {
          continue;
        }

        for (let v of l.radial_next.f.verts) {
          normalvs.add(v);
        }//*/
      }
    }
    return tdata
  },

  buildTypesProp: TransDataType.buildTypesProp,

  applyTransform(
    ctx: ToolContext,
    elem: TransDataElem<Vertex, Vector3>,
    do_prop: boolean,
    matrix: Matrix4,
    toolop: TransformOp
  ): void {
    const td = elem as MeshTransVert

    td.mesh!.regenBVH()
    td.mesh!.graphUpdate()

    const v = td.data1
    v.flag |= MeshFlags.UPDATE
    /*

    for (let e of v.edges) {
      e.flag |= MeshFlags.UPDATE;

      if (e.l) {
        let l = e.l;
        let _i = 0;

        do {
          l.f.flag |= MeshFlags.UPDATE;
          l = l.radial_next;
        } while (l !== e.l && _i++ < 100);
      }
    }*/

    const co = meshapplytemp

    co.load(td.data2).multVecMatrix(matrix)
    v.co.load(td.data2).interp(co, td.w)

    if (v.flag & MeshFlags.MIRRORED) {
      for (let i = 0; i < 3; i++) {
        if (td.symFlag & (1 << i)) {
          v.co[i] = 0.0
        }
      }
    }
  },

  calcUndoMem(ctx: ToolContext, undodata: any) {
    const ud = undodata

    function count(obj: Map<number, Vector3>) {
      const c = obj.size
      return c * 3 * 8
    }

    return count(ud.cos) + count(ud.nos) + count(ud.fnos) + count(ud.fcos)
  },

  //static getOriginMatrix(ctx, list, selmask, spacemode, space_matrix_out) {
  getOriginMatrix(
    ctx: ToolContext,
    list: TransDataList<Vertex, Vector3> | MeshTransVert[],
    selmask: number,
    spacemode: number,
    space_matrix_out?: Matrix4
  ): Matrix4 | undefined {
    if (!(selmask & SelMask.GEOM)) {
      return undefined
    }

    const cent = this.getCenter(ctx, list, selmask, spacemode, space_matrix_out)

    if (cent) {
      const mat = new Matrix4()

      return mat
    }
  },

  undoPre(ctx: ToolContext, elemlist: MeshTransList) {
    const cos = new Map()
    const nos = new Map()
    const fnos = new Map()
    const fcos = new Map()

    for (const td of elemlist) {
      const v = td.data1

      for (const f of v.faces) {
        if (fnos.has(f.eid)) continue

        fnos.set(f.eid, new Vector3(f.no))
        fcos.set(f.eid, new Vector3(f.cent))
      }

      cos.set(v.eid, new Vector3(v.co))
      nos.set(v.eid, new Vector3(v.no))
    }

    return {
      cos : cos,
      nos : nos,
      fnos: fnos,
      fcos: fcos,
    }
  },

  undo(ctx: ToolContext, undodata: MeshUndoData) {
    const cos = undodata.cos
    const nos = undodata.nos
    const fcos = undodata.fcos
    const fnos = undodata.fnos
    const mesh = ctx.mesh!

    for (const [k, co] of cos) {
      const v = mesh.eidMap.get(k) as Vertex | undefined

      if (v === undefined) {
        console.warn('Mesh integrity error in Transform undo')
        continue
      }

      const no = nos.get(k)!

      v.co.load(co)
      v.no.load(no)
      v.flag |= MeshFlags.UPDATE
    }

    for (const [k, fno] of fnos) {
      const f = mesh.eidMap.get(k) as Face | undefined

      if (f === undefined) {
        console.warn('Mesh integrity error in Transform undo')
        continue
      }

      f.no.load(fno)
      f.cent.load(fcos.get(k)!)

      f.flag |= MeshFlags.UPDATE
    }

    mesh.regenRender()
    if (mesh.haveNgons) {
      mesh.regenTessellation()
    }
  },

  getCenter(
    ctx: ToolContext,
    list: MeshTransList | MeshTransVert[],
    selmask: number,
    spacemode?: number,
    space_matrix_out?: Matrix4,
    toolop?: TransformOp
  ): Vector3 | undefined {
    const c = meshGetCenterTemps.next().zero()
    let tot = 0.0

    if (!(selmask & SelMask.GEOM)) {
      return undefined
    }

    const quat = new Quat()
    let spacetots = 0.0

    for (const ob of ctx.selectedMeshObjects) {
      const mesh = ob.data as Mesh
      const obmat = ob.outputs.matrix.getValue()

      if (spacemode === ConstraintSpaces.LOCAL) {
        //XXX implement me
      }

      for (const v of mesh.verts.selected.editable) {
        c.add(v.co)
        tot++
      }

      for (const f of mesh.faces.selected.editable) {
        if (spacemode === ConstraintSpaces.NORMAL) {
          const mat = meshGetCenterTempsMats.next()

          const up = meshGetCenterTemps2.next()
          const n = meshGetCenterTemps2.next()

          n.load(f.no).normalize()

          n.multVecMatrix(obmat)

          if (n.dot(n) == 0.0 || isNaN(n.dot(n))) {
            console.warn('NaN')
            continue //ignore bad/corrupted normal
          }

          //if (v.edges.length > 0) {
          const l = f.lists[0].l
          up.load(l.next.v.co).sub(l.v.co).normalize()
          //  up.load(v.edges[0].otherVertex(v)).sub(v).normalize();
          //} else {
          //  up.zero();

          if (Math.abs(up.dot(n)) > 0.9 || up.dot(up) < 0.0001) {
            up.zero()

            if (n[2] > 0.95) {
              up[1] = 1.0
            } else {
              up[2] = 1.0
            }
          }

          const x = meshGetCenterTemps2.next()
          const y = meshGetCenterTemps2.next()

          x.load(n).cross(up).normalize()
          y.load(x).cross(n).normalize()
          //y.negate();

          const mat2 = meshGetCenterTempsMats.next()
          mat2.makeIdentity()
          const m = mat2.$matrix

          m.m11 = x[0]
          m.m12 = x[1]
          m.m13 = x[2]

          m.m21 = y[0]
          m.m22 = y[1]
          m.m23 = y[2]

          m.m31 = n[0]
          m.m32 = n[1]
          m.m33 = n[2]
          m.m44 = 1.0

          //mat2.transpose();
          //mat2.invert();
          if (space_matrix_out) {
            space_matrix_out.load(mat2)
          }

          const quat2 = new Quat()
          quat2.matrixToQuat(mat2)
          quat.add(quat2)
          spacetots++

          //XXX implement me
        }
      }
    }

    if (isNaN(quat.dot(quat))) {
      console.warn('NaN error calculating mesh transformation space!')
    }

    if (space_matrix_out) {
      //space_matrix_out.makeIdentity();
    }

    if (spacetots > 0.0 && quat.dot(quat) > 0.0 && !isNaN(quat.dot(quat))) {
      //quat.mulScalar(1.0 / spacetots);
      quat.normalize()
      //console.log("quat", quat);

      if (space_matrix_out) {
        //quat.toMatrix(space_matrix_out);
        //console.log(JSON.stringify(space_matrix_out.$matrix));
      }
    }

    if (tot > 0) {
      c.mulScalar(1.0 / tot)
    }

    return c
  },

  calcAABB(ctx: ToolContext, selmask: number): [Vector3, Vector3] | undefined {
    if (!(selmask & SelMask.GEOM)) {
      return undefined
    }

    const d = 1e17
    const min = new Vector3([d, d, d])
    const max = new Vector3([-d, -d, -d])
    let ok = false

    for (const ob of ctx.selectedMeshObjects) {
      const mesh = ob.data as Mesh

      for (const v of mesh.verts.selected.editable) {
        min.min(v.co)
        max.max(v.co)
        ok = true
      }
    }

    if (!ok) {
      min.zero()
      max.zero()
    }

    return [min, max]
  },

  update(ctx: ToolContext, elemlist: MeshTransList): void {
    const mesh = ctx.mesh!

    if (mesh.haveNgons) {
      mesh.regenTessellation()
    }

    if (elemlist === undefined) {
      mesh.recalcNormals()
      mesh.regenElementsDraw()
      mesh.regenRender()
      mesh.graphUpdate()

      return
    }

    /*
    for (let v of elemlist.normalvs) {
      v.flag |= MeshFlags.UPDATE;
    }
    for (let td of elemlist) {
      let v = td.data1;
      v.flag |= MeshFlags.UPDATE;
    }

    mesh.regenRender();
    mesh.outputs.depend.graphUpdate();
    return;
    //*/

    for (const v of elemlist.normalvs) {
      v.no[0] = v.no[1] = v.no[2] = 0.0
    }

    for (const f of elemlist.faces) {
      f.calcNormal()

      mesh.flagElemUpdate(f)

      for (const v of f.verts) {
        v.no.add(f.no)
      }
    }

    for (const v of elemlist.normalvs) {
      v.no.normalize()
    }

    for (const e of elemlist) {
      const v = e.data1
      mesh.flagElemUpdate(v)
    }

    mesh.regenElementsDraw()
    mesh.regenRender()
    mesh.outputs.depend.graphUpdate()
    return /*

    if (elemlist !== undefined) {
      const doneset = new WeakSet()

      for (const e of elemlist) {
        const v = e.data1

        const n = v.no
        n[0] = n[1] = n[2] = 0.0

        for (const f of v.faces) {
          if (!doneset.has(f)) {
            doneset.add(f)

            f.calcCent()
            f.calcNormal()

            mesh.flagElemUpdate(f)
          }

          v.no.add(f.no)
        }*/
    /*
        for (let e of v.edges) {
          if (!e.l) {
            continue;
          }
          let l = e.l;
          let _i = 0;

          do {
            let f = l.f;

            if (!doneset.has(f)) {
              doneset.add(f);

              f.calcCent();
              f.calcNormal();

              mesh.flagElemUpdate(f);

              v.no.add(f.no);
            }
            l = l.radial_next;
          } while (l !== e.l && _i++ < 10);
        }
         */
    /*
        v.no.normalize()
        mesh.flagElemUpdate(v)
      }
    } else {
      mesh.recalcNormals()
    }

    //mesh.regenTessellation(); //slow, disables partial redraw for that frame
    mesh.regenElementsDraw()
    mesh.regenRender()
    mesh.outputs.depend.graphUpdate()
    //mesh.regenPartial();*/
  },
}

TransDataType.register(MeshTransType)

export class ObjectTransform {
  invmatrix: Matrix4
  tempmat: Matrix4
  matrix: Matrix4
  loc: Vector3
  rot: Vector3
  scale: Vector3
  ob: SceneObject | undefined

  constructor(ob: SceneObject) {
    this.invmatrix = new Matrix4()
    this.tempmat = new Matrix4()
    this.matrix = new Matrix4(ob.outputs.matrix.getValue())
    this.loc = new Vector3(ob.inputs.loc.getValue())
    this.rot = new Vector3(ob.inputs.rot.getValue())
    this.scale = new Vector3(ob.inputs.scale.getValue())
    this.ob = ob

    this.invmatrix.load(this.matrix).invert()
  }

  copy(): ObjectTransform {
    const ret = new ObjectTransform(this.ob!)
    return ret
  }
}

interface ObjectUndoData {
  [lib_id: string]: ObjectTransform
}

export const ObjectTransType: ITransDataType<
  SceneObject,
  ObjectTransform,
  TransDataElem<SceneObject, ObjectTransform>,
  ObjectUndoData
> = {
  transformDefine() {
    return {
      name  : 'object',
      uiname: 'Object',
      flag  : 0,
      icon  : -1,
    }
  },

  isValid       : TransDataType.isValid,
  buildTypesProp: TransDataType.buildTypesProp,

  genData(
    ctx: ToolContext,
    selectmode: number,
    propmode: number,
    propradius: number,
    toolop: TransformOp
  ): TransDataList<SceneObject, ObjectTransform> | undefined {
    const ignore_meshes = selectmode & (SelMask.VERTEX | SelMask.EDGE | SelMask.FACE)

    if (!(selectmode & SelMask.OBJECT)) {
      return undefined
    }

    const tdata = new TransDataList<SceneObject, ObjectTransform>(this)

    function get_transform_parent(ob: SceneObject): SceneObject {
      if (ob.inputs.matrix.edges.length > 0) {
        const parent = ob.inputs.matrix.edges[0].node

        if (parent instanceof SceneObject) {
          if (parent.flag & ObjectFlags.SELECT && !(parent.flag & (ObjectFlags.HIDE | ObjectFlags.LOCKED))) {
            return parent
          } else {
            return get_transform_parent(parent)
          }
        }
      }

      return ob
    }

    for (const ob of ctx.selectedObjects) {
      let ok = get_transform_parent(ob) === ob
      ok = ok && (!ignore_meshes || ob.data?.lib_type !== 'mesh')

      if (!ok) {
        continue
      }

      console.warn('processing transform sceneobject', ob.name, ob)

      const td = new TransDataElem<SceneObject, ObjectTransform>()

      td.data1 = ob
      td.data2 = new ObjectTransform(ob)
      tdata.push(td)
    }

    return tdata
  },

  applyTransform(
    ctx: ToolContext,
    elem: TransDataElem<SceneObject, ObjectTransform>,
    do_prop: boolean,
    matrix: Matrix4,
    toolop: TransformOp
  ): void {
    const mat = elem.data2.tempmat

    mat.load(elem.data2.matrix)

    mat.preMultiply(matrix)

    const ob = elem.data1

    const order = ob.inputs.rotOrder.getValue()

    const r = ob.inputs.rot.getValue()
    const s = ob.inputs.scale.getValue()

    mat.decompose(ob.inputs.loc.getValue(), r, s, undefined, undefined, order)

    ob.graphUpdate()
  },

  calcUndoMem(ctx: ToolContext, undodata: ObjectUndoData): number {
    let tot = 0

    for (const k in undodata) {
      tot += 16 * 8 + 32 //matrix4
    }

    return tot
  },

  undoPre(ctx: ToolContext, elemlist: TransDataList<SceneObject, ObjectTransform>): ObjectUndoData {
    const undo: ObjectUndoData = {}

    for (const td of elemlist) {
      const transform = td.data2.copy()
      transform.ob = undefined //kill unwanted reference
      undo[td.data1.lib_id] = transform
    }

    return undo
  },

  undo(ctx: ToolContext, undodata: {[lib_id: string]: ObjectTransform}): void {
    for (const k in undodata) {
      const numK = parseInt(k)

      const ob = ctx.datalib.get<SceneObject>(numK)
      const transform = undodata[k]!

      if (ob === undefined) {
        console.warn('error in transform', numK, typeof numK)
        continue
      }

      ob.inputs.loc.setValue(transform.loc)
      ob.inputs.rot.setValue(transform.rot)
      ob.inputs.scale.setValue(transform.scale)
      ob.outputs.matrix.setValue(transform.matrix)

      ob.graphUpdate()
    }

    window.updateDataGraph()
  },

  getOriginMatrix(
    ctx: ToolContext,
    list: TransDataList<SceneObject, ObjectTransform> | TransDataElem<SceneObject, ObjectTransform>[],
    selmask: number,
    spacemode: number,
    space_matrix_out?: Matrix4
  ): Matrix4 | undefined {
    const cent = this.getCenter(ctx, list, selmask, spacemode, space_matrix_out)

    if (cent !== undefined) {
      const tmat = new Matrix4()
      const ob = ctx.object

      if (ob) {
        tmat.load(ob.outputs.matrix.getValue())
        tmat.makeRotationOnly()
        tmat.invert()
      }

      return tmat
    }
  },

  getCenter(
    ctx: ToolContext,
    list: TransDataList<SceneObject, ObjectTransform> | TransDataElem<SceneObject, ObjectTransform>[],
    selmask: number,
    spacemode?: number,
    space_matrix_out?: Matrix4
  ): Vector3 | undefined {
    if (!(selmask & SelMask.OBJECT)) {
      return undefined
    }

    if (space_matrix_out !== undefined) {
      space_matrix_out.makeIdentity()
    }

    const cent = new Vector3()
    let tot = 0.0

    for (const ob of ctx.selectedObjects) {
      const bbox = ob.getBoundingBox()

      const co = new Vector3(bbox[0]).interp(bbox[1], 0.5)
      cent.add(co)

      tot++
    }

    if (tot > 0) {
      cent.mulScalar(1.0 / tot)
    }

    return cent
  },

  calcAABB(ctx: ToolContext, selmask: number): [Vector3, Vector3] | undefined {
    let ret: [Vector3, Vector3] | undefined = undefined

    if (!(selmask & SelMask.OBJECT)) {
      return undefined
    }

    for (const ob of ctx.selectedObjects) {
      const aabb = ob.getBoundingBox()

      if (ret === undefined) {
        ret = [aabb[0].copy(), aabb[1].copy()]
      } else {
        aabb_union(ret, aabb)
      }
    }

    return ret
  },

  update(ctx: ToolContext, elemlist: TransDataList<SceneObject, ObjectTransform>): void {
    for (const td of elemlist) {
      td.data1.graphUpdate()
    }

    window.updateDataGraph()
    window.redraw_viewport()
  },
}

TransDataType.register(ObjectTransType)
