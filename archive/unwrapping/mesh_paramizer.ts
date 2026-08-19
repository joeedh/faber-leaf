import {util, math, Vector3Like, Number3} from '@framework/api'
import {nstructjs, DataAPI, DataStruct} from '@framework/pathux'
import {CustomDataElem, LayerSettingsBase} from './customdata.js'
import {Vector2, Vector3, Vector4, Matrix4, Quat} from '@framework/api'
import '../../../../scripts/util/numeric.js'

const Queue = util.Queue
import {MeshTypes, MeshFlags} from './mesh_base.js'
import {buildCotanVerts, getCotanData, VAREA, VCTAN1, VCTAN2, VW, VETOT, vertexSmooth} from './mesh_utils.js'
import {AttrRef, Edge, Face, Loop, Mesh, Vertex} from './mesh.js'
import {DispLayerVert} from './mesh_displacement.js'
import {StructReader} from '@framework/api'

export const ParamizeModes = {
  SELECTED: 1,
  MAX_Z   : 2,
}

const tmp1 = new Vector3()
const tmp2 = new Vector3()
const tmp3 = new Vector3()

const gtmps = util.cachering.fromConstructor(Vector3, 256)

export const KDrawModes = {
  NO   : 0,
  TAN  : 1,
  BIN  : 2,
  DK1  : 3,
  DK2  : 4,
  DK3  : 5,
  D2K1 : 6,
  D2K2 : 7,
  D2K3 : 8,
  D3K1 : 9,
  D3K2 : 10,
  D3K3 : 11,
  ERROR: 12,
}

declare global {
  interface Window {
    kdrawmode: number
  }
}
window.kdrawmode = KDrawModes.TAN

/* Propagate distance from v1 and v2 to v0. */
export function geodesic_distance_triangle(
  v0: Vector3Like,
  v1: Vector3Like,
  v2: Vector3Like,
  dist1: number,
  dist2: number
) {
  /* Vectors along triangle edges. */
  const v10 = gtmps.next()
  const v12 = gtmps.next()

  v10.load(v0).sub(v1)
  v12.load(v2).sub(v1)

  const eps = 0.0

  if (dist1 > eps && dist2 > eps) {
    /* Local coordinate system in the triangle plane. */
    const u = gtmps.next()
    const v = gtmps.next()
    const n = gtmps.next()

    u.load(v12)
    let d12 = u.vectorLength()

    if (d12 > eps) {
      u.mulScalar(1.0 / d12)
    } else {
      d12 = 0.0
    }

    if (d12 * d12 > eps) {
      n.load(v12).cross(v10)
      n.normalize()

      v.load(n).cross(u)

      /* v0 in local coordinates */
      const v0_ = gtmps.next().zero()
      v0_[0] = v10.dot(u)
      v0_[1] = Math.abs(v10.dot(v))

      /* Compute virtual source point in local coordinates, that we estimate the geodesic
       * distance is being computed from. See figure 9 in the paper for the derivation. */
      const a = 0.5 * (1.0 + (dist1 * dist1 - dist2 * dist2) / (d12 * d12))
      const hh = dist1 * dist1 - a * a * d12 * d12

      if (hh > 0.0) {
        const h = Math.sqrt(hh)
        const S_ = gtmps.next().zero()

        S_[0] = a * d12
        S_[1] = -h

        /* Only valid if the line between the source point and v0 crosses
         * the edge between v1 and v2. */
        const x_intercept = S_[0] + (h * (v0_[0] - S_[0])) / (v0_[1] + h)

        if (x_intercept >= eps && x_intercept <= d12 - eps) {
          return S_.vectorDistance(v0_)
        }
      }
    }
  }

  /* Fall back to Dijsktra approximation in trivial case, or if no valid source
   * point found that connects to v0 across the triangle. */
  return Math.min(dist1 + v10.vectorLength(), dist2 + v0.vectorDistance(v2))
}

export const WeightModes = {
  SIMPLE     : 0,
  EDGE_LENGTH: 1,
  COTAN      : 2,
}

export class ParamVertSettings extends LayerSettingsBase {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  mesh.ParamVertSettings {
  updateGen      : int;
  smoothTangents : bool;
  weightMode     : int;
}`
  )

  declare updateGen: number
  declare smoothTangents: boolean
  declare weightMode: number

  constructor() {
    super()

    this.updateGen = 0
    this.smoothTangents = true
    this.weightMode = WeightModes.EDGE_LENGTH
  }

  static defineAPI(api: DataAPI, st?: DataStruct) {
    const ret = super.defineAPI(api, st!)

    ret.int('updateGen', 'updateGen', 'Generation').noUnits().readOnly()
    ret.bool('smoothTangents', 'smoothTangents', 'Smooth Tangents') //.noUnits().range(0, 25);
    ret.enum('weightMode', 'weightMode', WeightModes, 'Weight Mode')

    return ret
  }

  copyTo(b: this) {
    b.updateGen = this.updateGen
    b.smoothTangents = this.smoothTangents
    b.weightMode = this.weightMode
  }
}

const tmp = new Vector3()

export class ParamVert extends CustomDataElem {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  mesh.ParamVert {
    disUV        : vec4;
    updateGen    : int;
    smoothTan    : vec3;
    wlist        : array(float);
    totarea      : float;
  }`
  )

  updateGen: number
  needsSmooth: boolean
  disUV: Vector4
  smoothTan: Vector3
  totarea: number
  wlist: number[]
  dis!: number
  dv = new Vector3()
  k1 = 0
  k2 = 0
  k3 = 0
  tan = new Vector3()
  no = new Vector3()
  bin = new Vector3()
  lastd2k1 = new Vector3()
  lastd2k2 = new Vector3()
  lastd2k3 = new Vector3()
  dk1 = new Vector3()
  dk2 = new Vector3()
  dk3 = new Vector3()
  d2k1 = new Vector3()
  d2k2 = new Vector3()
  d2k3 = new Vector3()
  d3k1 = new Vector3()
  d3k2 = new Vector3()
  d3k3 = new Vector3()

  constructor() {
    super()

    /*
    this.lastd2k1 = new Vector3();
    this.lastd2k2 = new Vector3();
    this.lastd2k3 = new Vector3();
    this.d2k1 = new Vector3();
    this.d2k2 = new Vector3();
    this.d2k3 = new Vector3();
    this.dk1 = this.dk2 = this.dk3 = new Vector3();
    this.d3k1 = this.d3k2 = this.d3k3 = new Vector3();
    //*/

    this.updateGen = 0
    this.needsSmooth = false
    this.disUV = new Vector4()
    this.smoothTan = new Vector3()
    this.totarea = 0.0

    this.wlist = []
  }

  static define() {
    return {
      elemTypeMask : 0,
      typeName     : 'paramvert',
      uiTypeName   : 'Param Vert',
      defaultName  : 'Param Vert',
      valueSize    : undefined,
      flag         : 0,
      settingsClass: ParamVertSettings,
    }
  }

  calcMemSize() {
    return 32
  }

  getValue() {
    return this.disUV
  }

  interp(dest: this, datas: this[], ws: number[]) {
    let x = 0
    let y = 0
    let z = 0
    let w = 0
    let tx = 0
    let ty = 0
    let tz = 0

    for (let i = 0; i < datas.length; i++) {
      const vec = datas[i].disUV
      const weight = ws[i]

      x += vec[0] * weight
      y += vec[1] * weight
      z += vec[2] * weight
      w += vec[3] * weight

      const vec2 = datas[i].smoothTan

      tx += vec2[0] * weight
      ty += vec2[1] * weight
      tz += vec2[2] * weight
    }

    //normalize
    let l = Math.sqrt(y ** 2 + z ** 2 + w ** 2)

    if (l > 0.0) {
      l = 1.0 / l
    }

    dest.disUV[0] = x
    dest.disUV[1] = y * l
    dest.disUV[2] = z * l
    dest.disUV[3] = w * l

    dest.smoothTan[0] = tx
    dest.smoothTan[1] = ty
    dest.smoothTan[2] = tz

    dest.smoothTan.normalize()
  }

  updateWeights(
    ps: ParamVertSettings,
    owning_v: Vertex,
    cd_pvert: AttrRef<ParamVert>,
    cd_disp?: AttrRef<DispLayerVert>
  ) {
    const val = owning_v.valence

    if (this.wlist.length !== val) {
      this.wlist.length = val
    }

    if (ps.weightMode === WeightModes.SIMPLE) {
      const w = 1.0 / val

      for (let i = 0; i < val; i++) {
        this.wlist[i] = w
      }
    } else if (ps.weightMode === WeightModes.EDGE_LENGTH) {
      let wi = 0
      let tot = 0.0
      const wlist = this.wlist

      for (const v2 of owning_v.neighbors) {
        const va = v2
        const vb = owning_v

        let a = va.co
        let b = vb.co

        if (cd_disp !== undefined) {
          a = v2.customData.get(cd_disp).worldco
          b = owning_v.customData.get(cd_disp).worldco
        }

        const w = a.vectorDistance(b)

        wlist[wi++] = w
        tot += w
      }

      if (tot) {
        tot = 1.0 / tot
      }

      for (let i = 0; i < val; i++) {
        wlist[i] *= tot
      }
    } else {
      this.updateCotan(ps, owning_v, cd_pvert)
    }
  }

  updateCotan(ps: ParamVertSettings, owning_v: Vertex, cd_pvert: AttrRef<ParamVert>) {
    if (ps.weightMode !== WeightModes.COTAN) {
      return
    }

    const v = owning_v

    const vdata = getCotanData(v)
    let totarea = 0.0
    let totw = 0.0

    let wi = 0
    let vi = VETOT //skip first entry

    for (const e of v.edges) {
      const area = vdata[vi + VAREA]
      const cot1 = vdata[vi + VCTAN1]
      const cot2 = vdata[vi + VCTAN2]

      let w = vdata[vi + VW]

      //cot1 = 1.0 / (cot1 + 0.00001);
      //cot2 = 1.0 / (cot2 + 0.00001);
      w = 1.0 //cot1 + cot2;

      if (area !== 0.0) {
        w *= area
      }

      if (!area) {
        vi += VETOT
        wi++
        continue
      }

      totarea += area

      //w = -(cot1 + cot2);

      this.wlist[wi] = w //*area;

      vi += VETOT
      wi++
    }

    totw = totw ? 1.0 / totw : 0.0

    for (let i = 0; i < wi; i++) {
      this.wlist[wi] *= totw
    }

    this.totarea = totarea
  }

  smooth(ps: ParamVertSettings, owning_v: Vertex, cd_pvert: AttrRef<ParamVert>, depth = 0) {
    const v = owning_v

    let tot = 0.0
    tmp.zero()

    this.needsSmooth = false

    const flag = MeshFlags.MAKE_FACE_TEMP

    for (const v2 of v.neighbors) {
      for (const v3 of v2.neighbors) {
        v3.flag &= ~flag
      }
    }

    for (const v2 of v.neighbors) {
      for (const v3 of v2.neighbors) {
        if (v3 === v) {
          continue
        }

        if (v3.flag & flag) {
          continue
        }

        const pv3 = v3.customData.get(cd_pvert)
        const w = v3.co.vectorDistance(v.co)
        //w = 1.0;

        pv3.checkTangent(ps, v3, cd_pvert, true)
        v3.flag |= flag

        tmp[0] += pv3.disUV[1] * w
        tmp[1] += pv3.disUV[2] * w
        tmp[2] += pv3.disUV[3] * w
        //tmp.addFac(pv3.smoothTan, w);

        tot += w
      }
    }

    if (tot) {
      const d = tmp.dot(v.no)
      tmp.addFac(v.no, -d)
      tmp.normalize()
      /*
        this.smoothTan[0] = this.disUV[1];
        this.smoothTan[1] = this.disUV[2];
        this.smoothTan[2] = this.disUV[3];
        this.smoothTan.interp(tmp, 1.0);
      */
      this.smoothTan.load(tmp)
    }
  }

  checkTangent(ps: ParamVertSettings, owning_v: Vertex, cd_pvert: AttrRef<ParamVert>, noSmooth = false) {
    let updateCot = owning_v.valence !== this.wlist.length
    updateCot = updateCot || ps.updateGen !== this.updateGen

    if (updateCot) {
      this.updateWeights(ps, owning_v, cd_pvert)
    }

    if (ps.updateGen !== this.updateGen) {
      this.updateGen = ps.updateGen
      this.needsSmooth = true
      this.updateTangent(ps, owning_v, cd_pvert, noSmooth)
    }
  }

  /*calculate tangent and smooth with neighbors
   * if necassary */
  updateTangent(
    ps: ParamVertSettings,
    owning_v: Vertex,
    cd_pvert: AttrRef<ParamVert>,
    noSmooth = false,
    cd_disp?: AttrRef<DispLayerVert>,
    noNorm = false
  ) {
    const v = owning_v

    this.updateGen = ps.updateGen

    const pv = v.customData.get(cd_pvert)
    const d1 = pv.disUV[0]

    const dv = tmp1.zero()

    if (v.valence !== this.wlist.length) {
      this.updateWeights(ps, owning_v, cd_pvert)
    }

    const norm = 0.0
    const cotan = ps.weightMode === WeightModes.COTAN
    const edge_length = ps.weightMode === WeightModes.EDGE_LENGTH

    let i = 0
    for (const e of v.edges) {
      const v2 = e.otherVertex(v)
      const pv2 = v2.customData.get(cd_pvert)

      const d2 = pv2.disUV[0]

      let w = 1.0

      w = this.wlist[i]

      let dv2
      if (cd_disp !== undefined && cd_disp.i >= 0) {
        dv2 = tmp3.load(v2.customData.get(cd_disp).smoothco).sub(v.customData.get(cd_disp).smoothco)
      } else {
        dv2 = tmp3.load(v2.co).sub(v.co)
      }

      if (!noNorm) {
        dv2.normalize()
      }

      dv2.mulScalar((d2 - d1) * w)

      dv.add(dv2)

      i++
    }

    if (cotan) {
      //norm = this.totarea**2;
      //dv.mulScalar(1.0 / norm);
    }

    if (noNorm) {
      if (i) {
        dv.mulScalar(1.0 / i)
      }
    } else {
      dv.normalize()
    }

    pv.disUV[1] = dv[0]
    pv.disUV[2] = dv[1]
    pv.disUV[3] = dv[2]

    if (!noSmooth && ps.smoothTangents) {
      pv.smoothTan.load(dv)
      this.smooth(ps, owning_v, cd_pvert)
    }
  }

  mulScalar(f: number) {
    this.disUV.mulScalar(f)
    return this
  }

  clear() {
    this.disUV.zero()
    return this
  }

  add(b: this) {
    this.disUV.add(b.disUV)
    return this
  }

  addFac(b: this, fac: number) {
    this.disUV.addFac(b.disUV, fac)
    return this
  }

  sub(b: this) {
    this.disUV.sub(b.disUV)
    return this
  }

  setValue(v: Vector4) {
    this.disUV.load(v)
  }

  loadSTRUCT(reader: StructReader<this>) {
    super.loadSTRUCT(reader)

    if (typeof this.disUV !== 'object') {
      this.disUV = new Vector4()
    } else if (this.disUV instanceof Vector3) {
      this.disUV = new Vector4(this.disUV)
      this.disUV[3] = 0.0
    }
  }

  copyTo(b: this) {
    b.disUV.load(this.disUV)
    b.smoothTan.load(this.smoothTan)
  }
}

export function calcGeoDist(mesh: Mesh, cd_pvert: AttrRef<ParamVert>, shell: Face[], mode: number) {
  const ps = mesh.verts.customData.flatlist[cd_pvert.i].getTypeSettings() as ParamVertSettings

  const verts = new Set<Vertex>()
  const edges = new Set<Edge>()
  const loops = new Set<Loop>()
  const faces = new Set<Face>()

  let startv: Vertex | undefined = undefined

  console.log('cd_pvert', cd_pvert)
  for (const f of shell) {
    faces.add(f)

    for (const l of f.loops) {
      verts.add(l.v)
      edges.add(l.e)
      loops.add(l)

      if (startv === undefined || l.v.flag & MeshFlags.SELECT) {
        startv = l.v
      }
    }
  }
  if (mode === ParamizeModes.MAX_Z) {
    const min = new Vector3().addScalar(1e17)
    const max = new Vector3().addScalar(1e17)

    const vs = [] as Vertex[]

    for (const v of verts) {
      min.min(v.co)
      max.max(v.co)

      vs.push(v)
    }

    const cent = max.sub(min)
    vs.sort((a, b) => {
      const eps = 0.00001

      const dz = a[2] - b[2]
      if (dz > -eps && dz < eps) {
        return b[2] - a[2]
      }

      const da = (a[1] - cent[1]) ** 2 + (a[0] - cent[0]) ** 2
      const db = (b[1] - cent[1]) ** 2 + (b[0] - cent[0]) ** 2

      return da - db
    })

    if (vs.length > 0) {
      startv = vs[0]
    }
  }

  for (const v of verts) {
    const pv = v.customData.get(cd_pvert)
    pv.updateWeights(ps, v, cd_pvert)
  }

  for (const v of verts) {
    v.customData.get(cd_pvert).disUV[0] = -1
  }

  startv!.customData.get(cd_pvert).disUV[0] = 0.0

  const queue = new Queue<Vertex>(1024 * 64)
  queue.enqueue(startv!)

  const visit = new WeakSet()
  let _i = 0

  visit.add(startv!)

  while (queue.length > 0) {
    const v = queue.dequeue()!
    const pv = v.customData.get(cd_pvert)

    for (const e of v.edges) {
      const vb = e.otherVertex(v)
      const pvb = vb.customData.get(cd_pvert)

      for (const l of e.loops) {
        let l2 = l
        let _i = 0

        do {
          if (_i++ > 100000) {
            console.warn('Infinite loop error')
            break
          }

          const v2 = l2.v
          const pv2 = v2.customData.get(cd_pvert)

          if (v2 === v) {
            l2 = l2.next
            continue
          }

          let dis = v2.co.vectorDistance(v.co)

          if (v2 !== vb && pvb.disUV[0] >= 0.0) {
            dis = geodesic_distance_triangle(v2.co, v.co, vb.co, pv.disUV[0], pvb.disUV[0])
            dis -= pv.disUV[0]
          }

          if (visit.has(v2)) {
            const dis2 = pv.disUV[0] + dis
            pv2.disUV[0] = Math.min(pv2.disUV[0], dis2)
            l2 = l2.next
          } else {
            pv2.disUV[0] = pv.disUV[0] + dis

            visit.add(v2)
            queue.enqueue(v2)
          }
        } while (l2 !== l)
      }
    }

    if (_i++ > 5000000) {
      console.warn('infinite loop error')
      break
    }
  }

  return {
    verts,
    edges,
    loops,
    faces,
  }
}

export function testCurvatureMath(mesh: Mesh, cd_pvert: AttrRef<ParamVert>, shell: Face[], mode: number) {
  const ps = mesh.verts.customData.flatlist[cd_pvert.i].getTypeSettings() as ParamVertSettings

  const verts = new Set<Vertex>()
  const edges = new Set<Edge>()
  const loops = new Set<Loop>()
  const faces = new Set<Face>()

  let startv = undefined

  console.log('cd_pvert', cd_pvert)
  for (const f of shell) {
    faces.add(f)

    for (const l of f.loops) {
      verts.add(l.v)
      edges.add(l.e)
      loops.add(l)

      if (startv === undefined || l.v.flag & MeshFlags.SELECT) {
        startv = l.v
      }
    }
  }

  if (1) {
    const co = new Vector3()
    const n = new Vector3()
    const dv = new Vector3()
    const mat = new Matrix4()

    for (const v of verts) {
      const pv = v.customData.get(cd_pvert)

      co.zero()
      n.zero()
      let tot = 0.0

      for (const v2 of v.neighbors) {
        co.add(v2.co)
        n.add(v2.no)
        tot++
      }

      if (!tot) {
        continue
      }

      co.mulScalar(1.0 / tot)
      n.normalize()

      const dis = v.co.vectorDistance(co) * 0.1
      //dis = n.dot(v.no);
      //dis = Math.acos(n.dot(v.no);

      pv.disUV[0] = dis
      co.sub(v.co)
      pv.dis = dis

      pv.dv = new Vector3(co)
    }

    const CURVATURE = true
    const dvtmp = new Vector3()

    const cos = []
    const flag = MeshFlags.MAKE_FACE_TEMP

    for (const v of verts) {
      if (!CURVATURE) {
        break
      }
      const pv = v.customData.get(cd_pvert)

      mat.makeIdentity()
      const m = mat.$matrix

      m.m11 = m.m22 = m.m33 = m.m44 = 0.0

      const w = 1.0 / v.edges.length

      for (const v2 of v.neighbors) {
        v2.flag &= ~flag
        for (const v3 of v2.neighbors) {
          v3.flag &= ~flag
        }
      }

      v.flag |= flag

      let count = 0

      for (const v2 of v.neighbors) {
        for (const v3 of v2.neighbors) {
          if (!(v3.flag & flag)) {
            v3.flag |= flag

            const w = v3.co.vectorDistance(v.co)

            cov(m, v3.no as unknown as number[], -w)
            count += w
          }
        }
      }

      if (0 && count > 0) {
        const mul = 1.0 / count
        m.m11 *= mul
        m.m12 *= mul
        m.m13 *= mul
        m.m21 *= mul
        m.m22 *= mul
        m.m23 *= mul
        m.m31 *= mul
        m.m32 *= mul
        m.m33 *= mul
      }

      //cov(m, v.no, 1.0);

      const dv = dvtmp
      const dv2 = new Vector3()
      const dv3 = new Vector3()
      let k1
      let k2
      let k3

      let lastn = undefined

      function eigen(n: number[] | Vector3, k1: number) {
        /*
        on factor;
        off period;

        x2 := x*m11 + y*m21 + z*m31;
        y2 := x*m12 + y*m22 + z*m32;
        z2 := x*m13 + y*m23 + z*m33;

        len := (x2**2 + y2**2 + z2**2)**0.5;

        on fort;

        df(len, x, 2);
        df(len, y, 2);
        df(len, z, 2);
        x2 / len;
        y2 / len;
        z2 / len;

        off fort;

        */
        //this[0] = x*matrix.$matrix.m11 + y*matrix.$matrix.m21 + z*matrix.$matrix.m31;
        //this[1] = x*matrix.$matrix.m12 + y*matrix.$matrix.m22 + z*matrix.$matrix.m32;
        //this[2] = x*matrix.$matrix.m13 + y*matrix.$matrix.m23 + z*matrix.$matrix.m33;

        ;`
        for (let j = 0; j < 35; j++) {
          n.multVecMatrix(mat);
          k1 = n.dot(n);
          n.normalize();

          if (0 && lastn !== undefined && Math.abs(n.dot(lastn)) > 0.99) {
            n[0] = (Math.random() - 0.5);
            n[1] = (Math.random() - 0.5);
            n[2] = (Math.random() - 0.5);
            n.normalize();
          }
        }//`

        const m11 = m.m11
        const m12 = m.m12
        const m13 = m.m13
        const m21 = m.m21
        const m22 = m.m22
        const m23 = m.m23
        const m31 = m.m31
        const m32 = m.m32
        const m33 = m.m33
        const x = n[0]
        const y = n[1]
        const z = n[2]
        const sqrt = Math.sqrt

        //first derivative
        let dx =
          ((m22 * y + m32 * z + m12 * x) * m12 +
            (m23 * y + m33 * z + m13 * x) * m13 +
            (m21 * y + m31 * z + m11 * x) * m11) /
          sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          )
        let dy =
          ((m22 * y + m32 * z + m12 * x) * m22 +
            (m23 * y + m33 * z + m13 * x) * m23 +
            (m21 * y + m31 * z + m11 * x) * m21) /
          sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          )
        let dz =
          ((m22 * y + m32 * z + m12 * x) * m32 +
            (m23 * y + m33 * z + m13 * x) * m33 +
            (m21 * y + m31 * z + m11 * x) * m31) /
          sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          )

        dv[0] = dx
        dv[1] = dy
        dv[2] = dz

        //second derivative
        dx =
          (((m22 * y + m32 * z + m12 * x) ** 2 +
            (m23 * y + m33 * z + m13 * x) ** 2 +
            (m21 * y + m31 * z + m11 * x) ** 2) *
            (m12 ** 2 + m13 ** 2 + m11 ** 2) -
            ((m22 * y + m32 * z + m12 * x) * m12 +
              (m23 * y + m33 * z + m13 * x) * m13 +
              (m21 * y + m31 * z + m11 * x) * m11) **
              2) /
          (sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          ) *
            ((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2))

        dy =
          (((m22 * y + m32 * z + m12 * x) ** 2 +
            (m23 * y + m33 * z + m13 * x) ** 2 +
            (m21 * y + m31 * z + m11 * x) ** 2) *
            (m22 ** 2 + m23 ** 2 + m21 ** 2) -
            ((m22 * y + m32 * z + m12 * x) * m22 +
              (m23 * y + m33 * z + m13 * x) * m23 +
              (m21 * y + m31 * z + m11 * x) * m21) **
              2) /
          (sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          ) *
            ((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2))

        dz =
          (((m22 * y + m32 * z + m12 * x) ** 2 +
            (m23 * y + m33 * z + m13 * x) ** 2 +
            (m21 * y + m31 * z + m11 * x) ** 2) *
            (m32 ** 2 + m33 ** 2 + m31 ** 2) -
            ((m22 * y + m32 * z + m12 * x) * m32 +
              (m23 * y + m33 * z + m13 * x) * m33 +
              (m21 * y + m31 * z + m11 * x) * m31) **
              2) /
          (sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          ) *
            ((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2))

        dv2[0] = dx
        dv2[1] = dy
        dv2[2] = dz

        dx =
          (-3 *
            (((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2) *
              (m12 ** 2 + m13 ** 2 + m11 ** 2) -
              ((m22 * y + m32 * z + m12 * x) * m12 +
                (m23 * y + m33 * z + m13 * x) * m13 +
                (m21 * y + m31 * z + m11 * x) * m11) **
                2) *
            ((m22 * y + m32 * z + m12 * x) * m12 +
              (m23 * y + m33 * z + m13 * x) * m13 +
              (m21 * y + m31 * z + m11 * x) * m11)) /
          (sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          ) *
            ((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2) **
              2)

        dy =
          (-3 *
            (((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2) *
              (m22 ** 2 + m23 ** 2 + m21 ** 2) -
              ((m22 * y + m32 * z + m12 * x) * m22 +
                (m23 * y + m33 * z + m13 * x) * m23 +
                (m21 * y + m31 * z + m11 * x) * m21) **
                2) *
            ((m22 * y + m32 * z + m12 * x) * m22 +
              (m23 * y + m33 * z + m13 * x) * m23 +
              (m21 * y + m31 * z + m11 * x) * m21)) /
          (sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          ) *
            ((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2) **
              2)

        dz =
          (-3 *
            (((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2) *
              (m32 ** 2 + m33 ** 2 + m31 ** 2) -
              ((m22 * y + m32 * z + m12 * x) * m32 +
                (m23 * y + m33 * z + m13 * x) * m33 +
                (m21 * y + m31 * z + m11 * x) * m31) **
                2) *
            ((m22 * y + m32 * z + m12 * x) * m32 +
              (m23 * y + m33 * z + m13 * x) * m33 +
              (m21 * y + m31 * z + m11 * x) * m31)) /
          (sqrt(
            (m21 * y + m31 * z + m11 * x) ** 2 + (m22 * y + m32 * z + m12 * x) ** 2 + (m23 * y + m33 * z + m13 * x) ** 2
          ) *
            ((m22 * y + m32 * z + m12 * x) ** 2 +
              (m23 * y + m33 * z + m13 * x) ** 2 +
              (m21 * y + m31 * z + m11 * x) ** 2) **
              2)

        dv3[0] = dx
        dv3[1] = dy
        dv3[2] = dz

        //return k1;
      }

      n.load(v.no)

      if (1) {
        const nmat = [
          [m.m11, m.m12, m.m13],
          [m.m21, m.m22, m.m23],
          [m.m31, m.m32, m.m33],
        ]

        // XXX
        //@ts-ignore
        const ret = numeric.eig(nmat, 50)

        pv.no = new Vector3(ret.E.x[0])
        pv.tan = new Vector3(ret.E.x[1])
        pv.bin = new Vector3(ret.E.x[2])
        pv.k1 = ret.lambda.x[0]
        pv.k2 = ret.lambda.x[1]
        pv.k3 = ret.lambda.x[2]

        pv.disUV[0] = (pv.k2 + pv.k3) ** 2

        eigen(pv.no, pv.k1)
        pv.lastd2k1.load(pv.d2k1)
        pv.dk1 = new Vector3(dv)
        pv.d2k1 = new Vector3(dv2)
        pv.d3k1 = new Vector3(dv3)

        eigen(pv.tan, pv.k2)
        pv.lastd2k2.load(pv.d2k2)
        pv.dk2 = new Vector3(dv)
        pv.d2k2 = new Vector3(dv2)
        pv.d3k2 = new Vector3(dv3)

        eigen(pv.bin, pv.k3)
        pv.lastd2k3.load(pv.d2k3)
        pv.dk3 = new Vector3(dv)
        pv.d2k3 = new Vector3(dv2)
        pv.d3k3 = new Vector3(dv3)
      } else {
        // XXX pv.k1 = eigen()
        pv.lastd2k1.load(pv.d2k1)
        pv.no = new Vector3(n)
        pv.dk1 = new Vector3(dv)
        pv.d2k1 = new Vector3(dv2)
        pv.d3k1 = new Vector3(dv3)

        lastn = pv.no

        /*
        for (let v2 of v.neighbors) {
          if (v2.vectorDistanceSqr(v) > 0.00001) {
            n.load(v2).sub(v).normalize();
            break;
          }
        }//*/

        //n.addFac(v.no, -n.dot(v.no));
        //n.negate();

        n.cross(v.no).normalize()
        //bias away from previous eigenvector
        m.m11 -= pv.k1
        m.m22 -= pv.k1
        m.m33 -= pv.k1
        //no need to invert here, matrix is symmetric

        // XXX pv.k2 = eigen()
        pv.lastd2k2.load(pv.d2k2)
        pv.tan = new Vector3(n)
        pv.dk2 = new Vector3(dv)
        pv.d2k2 = new Vector3(dv2)
        pv.d3k2 = new Vector3(dv3)

        n.cross(v.no).normalize() //.negate();
        // XXX pv.k3 = eigen()
        pv.lastd2k3.load(pv.d2k3)
        pv.bin = new Vector3(n)
        pv.dk3 = new Vector3(dv)
        pv.d2k3 = new Vector3(dv2)
        pv.d3k3 = new Vector3(dv3)

        pv.disUV[0] = (pv.k2 + pv.k3) ** 2
      }
    }

    const dv2 = new Vector3()
    const dv3 = new Vector3()
    const dv4 = new Vector3()
    const dv5 = new Vector3()
    const dv6 = new Vector3()

    function cov(m: Matrix4['$matrix'], n: number[], w: number) {
      m.m11 += n[0] * n[0] * w
      m.m12 += n[0] * n[1] * w
      m.m13 += n[0] * n[2] * w
      m.m21 += n[1] * n[0] * w
      m.m22 += n[1] * n[1] * w
      m.m23 += n[1] * n[2] * w
      m.m31 += n[2] * n[0] * w
      m.m32 += n[2] * n[1] * w
      m.m33 += n[2] * n[2] * w
    }

    for (let i = 0; i < 0; i++) {
      for (const v of verts) {
        const pv = v.customData.get(cd_pvert)
        let dis = 0.0
        let tot = 0.0

        dv.zero()
        let error = 0.0

        if (!CURVATURE) {
          dv2[0] = pv.disUV[1]
          dv2[1] = pv.disUV[2]
          dv2[2] = pv.disUV[3]
        }

        for (const v2 of v.neighbors) {
          const pv2 = v2.customData.get(cd_pvert)
          const w = 1.0

          if (!CURVATURE) {
            dv3[0] = pv.disUV[1]
            dv3[1] = pv.disUV[2]
            dv3[2] = pv.disUV[3]

            const dis1 = pv.dis
            const dis2 = pv2.dis
            error += (dis1 - dis2) ** 2

            for (let _j = 0; _j < 3; _j++) {
              let j = _j as Number3
              dv4[j] = pv.dv[j] * dis1 - pv.dv[j] * dis2 - pv2.dv[j] * dis1 + pv2.dv[j] * dis2
            }

            dv.addFac(dv4, w)
          }

          dis += pv2.disUV[0] * w
          tot += w
        }

        if (!tot) {
          continue
        }

        dis /= tot
        error /= tot

        pv.disUV[0] += (dis - pv.disUV[0]) * 0.75

        if (!CURVATURE) {
          pv.dis = error

          dv.mulScalar(1.0 / tot)
          const totg = dv.dot(dv)

          if (totg === 0.0) {
            continue
          }

          const mul = -error / totg

          for (let _j = 0; _j < 3; _j++) {
            let j = _j as Number3
            v[j] += mul * dv[j] * 0.1
          }
        }

        v.flag |= MeshFlags.UPDATE
      }
    }

    const tmp2 = new Vector3()
    const tmp3 = new Vector3()
    const tmp4 = new Vector3()

    for (const v of verts) {
      v.flag |= MeshFlags.UPDATE

      const pv = v.customData.get(cd_pvert)
      const k = pv.disUV[0]

      let error = (pv.k2 + pv.k3) ** 2
      const vec = tmp3

      tmp2.load(pv.dk2).add(pv.dk3).mul(tmp2)

      vec
        .load(pv.d2k2)
        .add(pv.d2k3)
        .mulScalar(pv.k2 + pv.k3)
      vec.add(tmp2).mulScalar(2.0)

      error = vec.dot(vec) //pv.d2k3.dot(pv.d2k3);

      tmp4.load(pv.dk2).add(pv.dk3)
      tmp2.load(pv.d2k2).add(pv.d2k3).mul(tmp4).mulScalar(3.0)

      vec
        .load(pv.d3k2)
        .add(pv.d3k3)
        .mulScalar(pv.k2 + pv.k3)
      vec.add(tmp2).mulScalar(2.0)

      pv.disUV[0] = Math.abs(pv.k3) / 20000.0
      ;(pv.dk2.vectorLength() + pv.dk3.vectorLength()) / 20.0 //error*20.0;

      const t = new Vector3(pv.no)

      switch (window.kdrawmode) {
        case KDrawModes.TAN:
          t.load(pv.tan)
          break
        case KDrawModes.NO:
          t.load(pv.no)
          break
        case KDrawModes.BIN:
          t.load(pv.bin)
          break
        case KDrawModes.DK1:
          t.load(pv.dk1)
          break
        case KDrawModes.D2K1:
          t.load(pv.d2k1)
          break
        case KDrawModes.D3K1:
          t.load(pv.d3k1)
          break

        case KDrawModes.DK2:
          t.load(pv.dk2)
          break
        case KDrawModes.D2K2:
          t.load(pv.d2k2)
          break
        case KDrawModes.D3K2:
          t.load(pv.d3k2)
          break

        case KDrawModes.DK3:
          t.load(pv.dk3)
          break
        case KDrawModes.D2K3:
          t.load(pv.d2k3)
          break
        case KDrawModes.D3K3:
          t.load(pv.d3k3)
          break
      }
      vec.load(pv.d2k2).add(pv.d2k3)

      pv.smoothTan.load(t)
      pv.disUV[1] = t[0]
      pv.disUV[2] = t[1]
      pv.disUV[3] = t[2]

      if (vec.dot(vec) === 0.0) {
        continue
      }

      error /= vec.dot(vec)

      const co = new Vector3(v.co)

      let fac = -0.005
      if (0) {
        co.addFac(pv.d3k2, fac) //*pv.k2);///pv.k2);
        co.addFac(pv.d3k3, fac) //*pv.k3);///pv.k3);
      }

      if (isNaN(co.dot(co))) {
        console.warn('NaN!')
        co.load(v.co)
      }

      fac = pv.d2k1.vectorLength() //*0.5 + pv.dk3.vectorLength()*0.5;
      if (Math.abs(fac) > 1.0) {
        //fac = 1.0 / fac;
      }

      //co.addFac(v.no, fac);

      //v.addFac(pv.no, k*0.01);

      tmp2.load(pv.dk2).add(pv.dk3).mul(tmp2)

      vec
        .load(pv.d2k2)
        .add(pv.d2k3)
        .mulScalar(pv.k2 + pv.k3)
      vec.add(tmp2).mulScalar(2.0)

      pv.disUV[0] = pv.d2k2.dot(pv.d2k2) + pv.d2k3.dot(pv.d2k3)
      error = (pv.k2 + pv.k3) ** 2

      if (window.kdrawmode === KDrawModes.ERROR) {
        pv.smoothTan.load(vec)
      }

      pv.disUV[0] = (pv.k2 + pv.k3) ** 2

      if (0) {
        const totg = vec.dot(vec)
        if (totg > 0.0) {
          error /= totg

          co.addFac(vec, -error * 0.2)
        }
      } else if (1) {
        let fac = (pv.k1 + pv.k2 + pv.k3) ** 2

        if (fac !== 0.0) {
          fac = 1.0 / fac
        }

        fac *= -0.5

        co.addFac(pv.dk1, fac)
        co.addFac(pv.dk2, fac)
        co.addFac(pv.dk3, fac)
      }

      cos.push(co)
      //v.addFac(pv.bin, -k*0.01);
    }

    let vi = 0
    for (const v of verts) {
      v.load(cos[vi])
      vi++
    }

    //vertexSmooth(mesh, verts, 0.5);

    mesh.recalcNormals()
    mesh.regenRender()

    return {
      verts,
      edges,
      loops,
      faces,
    }
  }

  if (mode === ParamizeModes.MAX_Z) {
    const min = new Vector3().addScalar(1e17)
    const max = new Vector3().addScalar(1e17)

    const vs = [] as Vertex[]

    for (const v of verts) {
      min.min(v.co)
      max.max(v.co)

      vs.push(v)
    }

    const cent = max.sub(min)
    vs.sort((a, b) => {
      const eps = 0.00001

      const dz = a[2] - b[2]
      if (dz > -eps && dz < eps) {
        return b[2] - a[2]
      }

      const da = (a[1] - cent[1]) ** 2 + (a[0] - cent[0]) ** 2
      const db = (b[1] - cent[1]) ** 2 + (b[0] - cent[0]) ** 2

      return da - db
    })

    if (vs.length > 0) {
      startv = vs[0]
    }
  }

  for (const v of verts) {
    const pv = v.customData.get(cd_pvert)
    pv.updateWeights(ps, v, cd_pvert)
  }

  for (const v of verts) {
    v.customData.get(cd_pvert).disUV[0] = -1
  }

  console.log(verts, edges, loops, faces)
  console.log(startv)

  startv!.customData.get(cd_pvert).disUV[0] = 0.0

  const queue = new Queue<Vertex>(1024 * 64)
  queue.enqueue(startv!)

  const visit = new WeakSet()
  let _i = 0

  visit.add(startv!)

  while (queue.length > 0) {
    const v = queue.dequeue()!
    const pv = v.customData.get(cd_pvert)

    for (const e of v.edges) {
      const vb = e.otherVertex(v)
      const pvb = vb.customData.get(cd_pvert)

      for (const l of e.loops) {
        let l2 = l
        let _i = 0

        do {
          if (_i++ > 100000) {
            console.warn('Infinite loop error')
            break
          }

          const v2 = l2.v
          const pv2 = v2.customData.get(cd_pvert)

          if (v2 === v) {
            l2 = l2.next
            continue
          }

          let dis = v2.co.vectorDistance(v.co)

          if (v2 !== vb && pvb.disUV[0] >= 0.0) {
            dis = geodesic_distance_triangle(v2.co, v.co, vb.co, pv.disUV[0], pvb.disUV[0])
            dis -= pv.disUV[0]
          }

          if (visit.has(v2)) {
            const dis2 = pv.disUV[0] + dis
            pv2.disUV[0] = Math.min(pv2.disUV[0], dis2)
            l2 = l2.next
          } else {
            pv2.disUV[0] = pv.disUV[0] + dis

            visit.add(v2)
            queue.enqueue(v2)
          }
        } while (l2 !== l)
      }
    }

    if (_i++ > 5000000) {
      console.warn('infinite loop error')
      break
    }
  }

  return {
    verts,
    edges,
    loops,
    faces,
  }
}

export function paramizeShell(mesh: Mesh, cd_pvert: AttrRef<ParamVert>, shell: Face[], mode: number) {
  const {verts, edges, faces} = calcGeoDist(mesh, cd_pvert, shell, mode)
}

export function smoothParam(mesh: Mesh, verts: Iterable<Vertex> = mesh.verts) {
  if (!mesh.verts.customData.hasLayer('paramvert')) {
    console.error('No parameterization customdata layer')
    return
  }

  const cd_pvert = mesh.verts.customData.getLayerRef('paramvert') as AttrRef<ParamVert>
  const ps = mesh.verts.customData.flatlist[cd_pvert.i].getTypeSettings() as ParamVertSettings

  for (const v of verts) {
    const pv = v.customData.get(cd_pvert)
    pv.needsSmooth = true
  }

  for (const v of verts) {
    const pv = v.customData.get(cd_pvert)

    pv.smooth(ps, v, cd_pvert)
  }

  for (const v of verts) {
    const pv = v.customData.get(cd_pvert)

    pv.disUV[1] = pv.smoothTan[0]
    pv.disUV[2] = pv.smoothTan[1]
    pv.disUV[3] = pv.smoothTan[2]
  }
}

export function paramizeMesh(mesh: Mesh, cd_pvert: AttrRef<ParamVert>, mode = ParamizeModes.SELECTED) {
  console.log('parameterize mesh')

  if (cd_pvert === undefined) {
    cd_pvert = mesh.verts.customData.getLayerRef('paramvert')
  }

  if (!mesh.verts.customData.hasLayer('paramvert')) {
    cd_pvert = new AttrRef(mesh.verts.addCustomDataLayer('paramvert').index)
  }

  const ps = mesh.verts.customData.flatlist[cd_pvert.i].getTypeSettings() as ParamVertSettings

  const visit = new WeakSet()
  const stack = []
  const shells = [] as Face[][]

  for (let f of mesh.faces) {
    if (visit.has(f)) {
      continue
    }

    const shell = [] as Face[]
    shells.push(shell)

    stack.push(f)
    while (stack.length > 0) {
      f = stack.pop()!
      visit.add(f)
      shell.push(f)

      for (const l of f.loops) {
        for (const l2 of l.e.loops) {
          if (!visit.has(l2.f)) {
            stack.push(l2.f)
            visit.add(l2.f)
          }
        }
      }
    }
  }

  console.log('shells', shells)

  for (const shell of shells) {
    paramizeShell(mesh, cd_pvert, shell, mode)
  }

  for (const v of mesh.verts) {
    //break; //XXX
    const pv = v.customData.get(cd_pvert)
    pv.updateTangent(ps, v, cd_pvert, true)

    pv.smoothTan[0] = pv.disUV[1]
    pv.smoothTan[1] = pv.disUV[2]
    pv.smoothTan[2] = pv.disUV[3]
  }

  for (const v of mesh.verts) {
    //break; //XXX
    const pv = v.customData.get(cd_pvert)
    pv.updateTangent(ps, v, cd_pvert)
  }
}
