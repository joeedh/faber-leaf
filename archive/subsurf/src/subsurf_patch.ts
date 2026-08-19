import {Vector3, Matrix4, util} from '@framework/api'
import {BinomialTable} from '@framework/api'
import {Loop} from '../../mesh/src/mesh_types'

let KPOINTS = 0,
  KTOT = KPOINTS + 16 * 3

export const CubicPatchFields = {
  KPOINTS,
  KTOT,
}

export enum CubicPatchFlags {
  NONE = 0,
  SELECT = 1,
  UPDATE = 2,
}

export function bernstein(v: number, x: number, n: number): number {
  let eps = 0.00001
  x = eps + (1.0 - eps * 2.0) * x
  //v++;
  let f = BinomialTable[n][v]

  return f * Math.pow(x, v) * Math.pow(1.0 - x, n - v)
}

bernstein.derivative = function (v: number, x: number, n: number) {
  let eps = 0.000001
  x = eps + (1.0 - eps * 2.0) * x

  let bin = BinomialTable[n][v]

  let f = Math.pow(x, v) * Math.pow(1.0 - x, n) * bin * (n * x - v)
  f /= Math.pow(1.0 - x, v) * x * (x - 1)

  return f / 32.0
}

//uniform bspline basis
export function bspline(i: number, s: number, degree: number) {
  function impulse(s: number, a: number, b: number) {
    return s >= a && s < b ? 1 : 0
  }

  let i1 = i

  return (
    ((((s + 3.0 - i1) * impulse(s, i1 - 3.0, i1 - 2.0) - (s + 1.0 - i1) * impulse(s, i1 - 2.0, i1 - 1.0)) *
      (s + 3.0 - i1) +
      ((s + 2.0 - i1) * impulse(s, i1 - 2.0, i1 - 1.0) + (i1 - s) * impulse(s, i1 - 1.0, i1)) * (i1 - s)) *
      (s + 3.0 - i1) -
      (((s + 2.0 - i1) * impulse(s, i1 - 2.0, i1 - 1.0) + (i1 - s) * impulse(s, i1 - 1.0, i1)) * (s + 2.0 - i1) -
        ((s + 1.0 - i1) * impulse(s, i1 - 1.0, i1) - (s - 1.0 - i1) * impulse(s, i1, i1 + 1.0)) * (s - 1.0 - i1)) *
        (s - 1.0 - i1)) /
    6.0
  )
  ;`
  let n = degree
  s *= n - 2
  //let tdiv = 1.0;

  //uniform cox de boor
  function deboor(i: number, n: number): number {
    let i2 = i - 3

    let ti = i2
    let ti2 = i2 + 1
    let tip = i2 + n
    let tip2 = i2 + n + 1

    /*
    let ti *= tdiv
    let ti2 *= tdiv
    let tip *= tdiv
    let tip2 *= tdiv
    */

    if (n === 0) {
      return s >= ti && s < ti2 ? 1 : 0
    } else {
      let a = (s - ti) / (tip - ti)
      let b = (tip2 - s) / (tip2 - ti2)

      return deboor(i, n - 1) * a + deboor(i + 1, n - 1) * b
    }
  }

  return deboor(i, n)
  `
}

bspline.derivative = function (i: number, s: number, degree: number) {
  let i1 = i

  function impulse(s: number, a: number, b: number) {
    return s >= a && s < b ? 1 : 0
  }

  return (
    (impulse(s, i1 - 3.0, i1 - 2.0) * i1 ** 2 -
      2.0 * impulse(s, i1 - 3.0, i1 - 2.0) * i1 * s -
      6.0 * impulse(s, i1 - 3.0, i1 - 2.0) * i1 +
      impulse(s, i1 - 3.0, i1 - 2.0) * s ** 2 +
      6.0 * impulse(s, i1 - 3.0, i1 - 2.0) * s +
      9.0 * impulse(s, i1 - 3.0, i1 - 2.0) -
      3.0 * impulse(s, i1 - 2.0, i1 - 1.0) * i1 ** 2 +
      6.0 * impulse(s, i1 - 2.0, i1 - 1.0) * i1 * s +
      10.0 * impulse(s, i1 - 2.0, i1 - 1.0) * i1 -
      3.0 * impulse(s, i1 - 2.0, i1 - 1.0) * s ** 2 -
      10.0 * impulse(s, i1 - 2.0, i1 - 1.0) * s -
      7.0 * impulse(s, i1 - 2.0, i1 - 1.0) +
      3.0 * impulse(s, i1 - 1.0, i1) * i1 ** 2 -
      6.0 * impulse(s, i1 - 1.0, i1) * i1 * s -
      2.0 * impulse(s, i1 - 1.0, i1) * i1 +
      3.0 * impulse(s, i1 - 1.0, i1) * s ** 2 +
      2.0 * impulse(s, i1 - 1.0, i1) * s -
      impulse(s, i1 - 1.0, i1) -
      impulse(s, i1, i1 + 1.0) * i1 ** 2 +
      2.0 * impulse(s, i1, i1 + 1.0) * i1 * s -
      2.0 * impulse(s, i1, i1 + 1.0) * i1 -
      impulse(s, i1, i1 + 1.0) * s ** 2 +
      2.0 * impulse(s, i1, i1 + 1.0) * s -
      impulse(s, i1, i1 + 1.0)) /
    2.0
  )

  /*
  on factor;
  operator impulse;
  for all s,a,b let df(impulse(s, a, b), s) = 0;

  procedure basis1(i, n, degree); begin scalar n, s2, i2, ti, ti2, tip, tip2, a, b;
    i2 := i - 3;
    s2 := s*(degree - 2);

    ti := i2;
    ti2 := i2 + 1;
    tip := i2 + n;
    tip2 := i2 + n + 1;

    return if n=0 then
      impulse(s2, ti, ti2)
    else <<
      a := (s2 - ti) / (tip - ti);
      b := (tip2 - s2) / (tip2 - ti2);

      basis1(i, n-1, degree)*a + basis1(i+1, n-1, degree)*b
      >>
  end;


  procedure basis(i, n);
    basis1(i, n, n);

  f1 := basis(i1, 2);
  f2 := basis(i1, 3);

  on factor;
  on fort;

  f1;
  f2;
  df(f1, s);
  df(f2, s);

  off fort;



  for (let i=0; i<4; i++) {
    for (let j=0; j<4; j++) {
      let w = basis(i, u, degree)*basis(j,v,degree);

      let pi = (j*4 + i)*3;
      ret[0] += ps[pi]*w;
      ret[1] += ps[pi+1]*w;
      ret[2] += ps[pi+2]*w;
    }
  }

  */
}

let getpoints_ret = util.cachering.fromConstructor(Vector3, 64)

let _btm_temp1 = new Vector3()
let _btm_temp2 = new Vector3()
let _btm_temp3 = new Vector3()
let _btm_temp4 = new Vector3()
let _btm_temp5 = new Vector3()
let _btm_temp6 = new Vector3()
let _btm_temp7 = new Vector3()
let _btm_temp8 = new Vector3()

let tmptanmat = new Matrix4()
let tanmats_rets = util.cachering.fromConstructor(Matrix4, 64)

export abstract class PatchBase {
  basis = bernstein
  _patch = new Float64Array()

  getPoint(x: number, y: number): Vector3 {
    throw new Error('implement me')
  }

  setPoint(x: number, y: number, p: Vector3): void {
    throw new Error('implement me')
  }

  buildTangentMatrix(u: number, v: number, matOut = tanmats_rets.next().makeIdentity()): Matrix4 {
    let eps = 0.000001
    u = eps + u * (1.0 - eps * 2.0)
    v = eps + v * (1.0 - eps * 2.0)

    let m = matOut.$matrix

    matOut.makeIdentity()

    let dvu = _btm_temp1,
      dvv = _btm_temp2,
      no = _btm_temp3
    let quadco = this.evaluate(u, v, dvu, dvv, no)

    let tmat = tmptanmat
    tmat.makeIdentity()
    tmat.translate(quadco[0], quadco[1], quadco[2])

    //let vx = dvv, vy = dvu;
    let vx = dvu,
      vy = dvv

    let lx = vx.vectorLength()
    let ly = vy.vectorLength()

    if (lx === 0.0 || ly === 0.0) {
      console.warn('Error!')
      return new Matrix4()
    }

    let n = _btm_temp5

    let scale = (lx + ly) * 0.5
    //scale = lx = ly = 1.0;
    scale = Math.max(scale, 0.0001)

    vx.normalize()
    vy.normalize()

    n.load(vx).cross(vy).normalize()
    n.mulScalar(scale)

    vy.load(n).cross(vx).normalize().mulScalar(lx)
    vx.load(vy).cross(n).normalize().mulScalar(ly)

    m.m11 = vx[0]
    m.m21 = vx[1]
    m.m31 = vx[2]

    m.m12 = vy[0]
    m.m22 = vy[1]
    m.m32 = vy[2]

    m.m13 = n[0]
    m.m23 = n[1]
    m.m33 = n[2]

    matOut.preMultiply(tmat)

    return matOut
  }

  abstract evaluate(u: number, v: number, dv_u_out?: Vector3, dv_v_out?: Vector3, normal_out?: Vector3): Vector3

  abstract derivative(u: number, v: number): Vector3

  abstract derivative2(u: number, v: number): Vector3

  abstract normal(u: number, v: number): Vector3
}

//uniform cubic bspline patch
export class CubicPatch extends PatchBase {
  evaluate_rets: util.cachering<Vector3>
  dv_rets: util.cachering<Vector3>
  dv2_rets: util.cachering<Vector3>
  normal_rets: util.cachering<Vector3>
  scratchu: Vector3
  scratchv: Vector3
  pointTots: number[]
  flag: CubicPatchFlags = 0

  constructor() {
    super()

    this._patch = new Float64Array(KTOT)
    for (let i = 0; i < KTOT; i++) {
      this._patch[i] = 0
    }

    this.evaluate_rets = util.cachering.fromConstructor(Vector3, 64)
    this.dv_rets = util.cachering.fromConstructor(Vector3, 64)
    this.dv2_rets = util.cachering.fromConstructor(Vector3, 64)
    this.normal_rets = util.cachering.fromConstructor(Vector3, 64)

    this.basis = bspline
    this.scratchu = new Vector3()
    this.scratchv = new Vector3()

    this.pointTots = new Array(16)
    for (let i = 0; i < 16; i++) {
      this.pointTots[i] = 0.0
    }

    //this.basis = bernstein;
  }

  setPoint(x: number, y: number, p: Vector3) {
    let i = (y * 4 + x) * 3
    let ps = this._patch

    ps[i] = p[0]
    ps[i + 1] = p[1]
    ps[i + 2] = p[2]

    this.pointTots[~~(i / 3)] = 1
    this.flag |= CubicPatchFlags.UPDATE
    return this
  }

  addPoint(x: number, y: number, p: Vector3, increment = true, fac = 1.0) {
    let i = (y * 4 + x) * 3
    let ps = this._patch

    ps[i] += p[0] * fac
    ps[i + 1] += p[1] * fac
    ps[i + 2] += p[2] * fac

    if (increment) {
      this.pointTots[~~(i / 3)] += fac
    }

    this.flag |= CubicPatchFlags.UPDATE
    return this
  }

  finishPoints() {
    for (let i = 0; i < 16; i++) {
      let tot = this.pointTots[i]
      let x = i % 4,
        y = ~~(i / 4)
      if (tot) {
        this.mulScalarPoint(x, y, 1.0 / tot)
      }
    }
  }

  mulScalarPoint(x: number, y: number, f: number): this {
    let i = (y * 4 + x) * 3
    let ps = this._patch

    ps[i] *= f
    ps[i + 1] *= f
    ps[i + 2] *= f

    this.flag |= CubicPatchFlags.UPDATE

    return this
  }

  getPoint(x: number, y: number): Vector3 {
    let p = getpoints_ret.next()
    let ps = this._patch

    let idx = (y * 4 + x) * 3

    p[0] = ps[idx]
    p[1] = ps[idx + 1]
    p[2] = ps[idx + 2]

    return p
  }

  evaluate(u: number, v: number, dv_u_out?: Vector3, dv_v_out?: Vector3, normal_out?: Vector3): Vector3 {
    //we do not have derivatives everywhere
    let eps = 0.000005
    u = eps + u * (1.0 - eps * 2)
    v = eps + v * (1.0 - eps * 2)

    let ret = this.evaluate_rets.next().zero()
    let order = 4
    let degree = 3
    let ps = this._patch

    let basis = this.basis

    let dvu, dvv

    if (dv_u_out) {
      dvu = dv_u_out
    } else {
      dvu = this.scratchu
    }

    if (dv_v_out) {
      dvv = dv_v_out
    } else {
      dvv = this.scratchv
    }

    dvu[0] = dvu[1] = dvu[2] = 0.0
    dvv[0] = dvv[1] = dvv[2] = 0.0

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let wu = basis(i, u, degree)
        let wv = basis(j, v, degree)

        let dwu = basis.derivative(i, u, degree)
        let dwv = basis.derivative(j, v, degree)

        let w = wu * wv

        let pi = (j * 4 + i) * 3

        ret[0] += ps[pi] * w
        ret[1] += ps[pi + 1] * w
        ret[2] += ps[pi + 2] * w

        dvu[0] += ps[pi] * dwu * wv
        dvu[1] += ps[pi + 1] * dwu * wv
        dvu[2] += ps[pi + 2] * dwu * wv

        dvv[0] += ps[pi] * dwv * wu
        dvv[1] += ps[pi + 1] * dwv * wu
        dvv[2] += ps[pi + 2] * dwv * wu
      }
    }

    if (normal_out) {
      normal_out.load(dvv).cross(dvu).normalize()
      if (this.basis === bernstein) {
        //normal_out.negate();
      }
    }

    return ret
  }

  derivative(u: number, v: number): Vector3 {
    return this.dv_rets.next().zero()
  }

  derivative2(u: number, v: number): Vector3 {
    return this.dv2_rets.next().zero()
  }

  normal(u: number, v: number): Vector3 {
    return this.normal_rets.next().zero()
  }
}

export class SSPatch {
  patch: PatchBase
  l: Loop

  constructor(patch: PatchBase, loop: Loop) {
    this.patch = patch
    this.l = loop
  }

  evaluate(u: number, v: number, dv_u?: Vector3, dv_v?: Vector3, norout?: Vector3): Vector3 {
    return this.patch.evaluate(u, v, dv_u, dv_v, norout)
  }

  derivative(u: number, v: number): Vector3 {
    return this.patch.derivative(u, v)
  }

  derivative2(u: number, v: number): Vector3 {
    return this.patch.derivative2(u, v)
  }

  normal(u: number, v: number): Vector3 {
    return this.patch.normal(u, v)
  }
}

let zeropatch = new CubicPatch()

export class Patch4 extends PatchBase {
  private dv_urets: util.cachering<Vector3>
  private dv_vrets: util.cachering<Vector3>
  private nor_rets: util.cachering<Vector3>
  patches: PatchBase[]

  constructor(p1: PatchBase, p2: PatchBase, p3: PatchBase, p4: PatchBase) {
    super()

    this.patches = [p1, p2, p3, p4]
    this.dv_urets = util.cachering.fromConstructor(Vector3, 8)
    this.dv_vrets = util.cachering.fromConstructor(Vector3, 8)
    this.nor_rets = util.cachering.fromConstructor(Vector3, 8)
  }

  evaluate(u: number, v: number, dv_u?: Vector3, dv_v?: Vector3, norout?: Vector3) {
    let p

    let su = u,
      sv = v

    //return this.patches[0].evaluate(...arguments);
    let usign = 1,
      vsign = 1

    if (u <= 0.5 && v <= 0.5) {
      let t = u
      u = v
      v = t

      let t2 = dv_v
      dv_v = dv_u
      dv_u = t2

      u = 1.0 - u * 2.0
      v = 1.0 - v * 2.0

      usign = -1
      vsign = -1

      p = this.patches[0]
    } else if (u <= 0.5 && v >= 0.5) {
      u *= 2.0
      v = (v - 0.5) * 2.0

      u = 1.0 - u

      usign = -1

      p = this.patches[1]
    } else if (u >= 0.5 && v >= 0.5) {
      let t = u
      u = v
      v = t

      let t2 = dv_v
      dv_v = dv_u
      dv_u = t2

      u = (u - 0.5) * 2.0
      v = (v - 0.5) * 2.0

      p = this.patches[2]
    } else {
      u = (u - 0.5) * 2.0
      v = 1.0 - v * 2.0

      vsign = -1
      p = this.patches[3]
    }

    let co = p.evaluate(v, u, dv_v, dv_u, norout)

    if (0 && window.DTST2) {
      let df = 0.1
      let du2, dv2

      if (u < 1.0 - df) {
        du2 = p.evaluate(v, u + df, undefined, undefined, undefined)
        du2.sub(p.evaluate(v, u - df, undefined, undefined, undefined))
        du2.mulScalar(1.0 / (df * 2.0))
      } else {
        du2 = p.evaluate(v, u, undefined, undefined, undefined)
        du2.sub(p.evaluate(v, u - df, undefined, undefined, undefined))
        du2.mulScalar(1.0 / df)
      }

      dv_u!.load(du2)

      if (v < 1.0 - df) {
        dv2 = p.evaluate(v + df, u, undefined, undefined, undefined)
        dv2.sub(p.evaluate(v - df, u, undefined, undefined, undefined))
        dv2.mulScalar(1.0 / (df * 2.0))
      } else {
        dv2 = p.evaluate(v, u, undefined, undefined, undefined)
        dv2.sub(p.evaluate(v - df, u, undefined, undefined, undefined))
        dv2.mulScalar(1.0 / df)
      }

      dv_v!.load(dv2)

      if (norout) {
        norout.load(dv_u!).cross(dv_v!).normalize()
      }
    }

    if (dv_u) {
      dv_u.mulScalar(usign)
    }

    if (dv_v) {
      dv_v.mulScalar(vsign)
    }

    if (norout) {
      //norout.mulScalar(usign*vsign);
    }

    //co[2] += su*0.5;

    return co
  }

  derivativeU(u: number, v: number) {
    let dv = this.dv_urets.next().zero()
    this.evaluate(u, v, dv)

    return dv
  }

  derivativeV(u: number, v: number) {
    let dv = this.dv_vrets.next().zero()
    this.evaluate(u, v, undefined, dv)

    return dv
  }

  derivative(u: number, v: number): Vector3 {
    debugger
    return new Vector3()
  }

  derivative2(u: number, v: number): Vector3 {
    debugger
    return new Vector3()
  }

  normal(u: number, v: number) {
    let dv = this.nor_rets.next().zero()
    this.evaluate(u, v, undefined, undefined, dv)

    return dv
  }
}
