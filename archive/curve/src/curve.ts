import {Vector2, Vector3, Vector4, Quat, Matrix4} from '@framework/api'
import {nstructjs, DataAPI, DataStruct} from '@framework/pathux'

import {Vertex, Edge} from '../../mesh/src/mesh_types'
import {Mesh} from '../../mesh/src/mesh.js'
import {
  MeshTypes,
  MeshFlags,
  MeshFeatures,
  MeshFeatureError,
  MeshDrawFlags,
  MeshError,
} from '../../mesh/src/mesh_base.js'
import {NodeFlags} from '@framework/api'
import {MeshTools} from '../../mesh/src/mesh_stdtools.js'
import {SelMask} from '@framework/api'
import {LayerTypes, SimpleMesh} from '@framework/api'

import {util} from '@framework/api'
import type {View3D} from '@framework/api'

export function basis(ks: number[], t: number, i: number, deg: number) {
  let len = ks.length

  function safe_inv(n: number): number {
    return n === 0 ? 0 : 1.0 / n
  }

  function bas(s: number, i: number, n: number): number {
    let kp = Math.min(Math.max(i - 1, 0), len - 1)
    let kn = Math.min(Math.max(i + 1, 0), len - 1)
    let knn = Math.min(Math.max(i + n, 0), len - 1)
    let knn1 = Math.min(Math.max(i + n + 1, 0), len - 1)
    let ki = Math.min(Math.max(i, 0), len - 1)

    if (n == 0) {
      return s >= ks[ki] && s < ks[kn] ? 1 : 0
    } else {
      let a = (s - ks[ki]) * safe_inv(ks[knn] - ks[ki] + 0.0001)
      let b = (ks[knn1] - s) * safe_inv(ks[knn1] - ks[kn] + 0.0001)

      return a * bas(s, i, n - 1) + b * bas(s, i + 1, n - 1)
    }
  }

  return bas(t, i - deg, deg)
}

export class WalkRet {
  v: Vertex
  e: Edge

  constructor(v?: Vertex, e?: Edge) {
    this.v = v as unknown as Vertex
    this.e = e as unknown as Edge
  }

  load(v: Vertex, e: Edge) {
    this.v = v
    this.e = e

    return this
  }
}

export * from './curve_knot'
import {KnotDataLayer, KnotFlags, getKnot} from './curve_knot'
import type {IUniformsBlock, ShaderProgram, DrawQueue, FrameContext} from '@framework/api'
import type {ViewContext} from '@framework/api'
import {SceneObject} from '@framework/api'
import type {StructReader} from '@framework/api'

let WalkRets = util.cachering.fromConstructor(WalkRet, 1024)

export class CurveSpline extends Mesh {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
CurveSpline {
  _length        : float;
  speedLength    : float;
  degree         : int;
  owningToolMode : string;
  isClosed       : bool;
}
`
  )

  isClosed: boolean
  knots: number[]
  degree: number
  knotpad: number
  owningToolMode: string
  _length: number
  speedLength: number

  private _evaluate_vs: util.cachering<Vector3>
  private _last_check_key: number = 0

  // Chains super (Mesh.defineAPI) onto our own struct, declaring Mesh's members
  // directly here, so there's no dependency on Mesh being defined first.
  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const cstruct = super.defineAPI(api, struct ?? api.mapStruct(this, true))

    cstruct.bool('isClosed', 'isClosed', 'Closed Curve').on('change', function (this: {dataref: CurveSpline}) {
      this.dataref.checkUpdate()
      this.dataref.regenRender()
    })

    return cstruct
  }

  constructor() {
    let features = MeshFeatures.MAKE_VERT | MeshFeatures.KILL_VERT

    features |= MeshFeatures.MAKE_EDGE | MeshFeatures.KILL_EDGE
    features |= MeshFeatures.SPLIT_EDGE | MeshFeatures.JOIN_EDGE
    features |= MeshFeatures.EDGE_HANDLES | MeshFeatures.EDGE_CURVES_ONLY
    features |= MeshFeatures.SINGLE_SHELL
    features &= ~MeshFeatures.BVH

    super(features)

    this.isClosed = false
    this.knots = []
    this.degree = 3
    this.knotpad = 0

    //owning tool mode, if we're owned by a tool mode
    this.owningToolMode = ''

    this._evaluate_vs = util.cachering.fromConstructor(Vector3, 512)

    this._length = 0
    this.speedLength = 0

    this.verts.customData.addLayer(KnotDataLayer)
    this.handles.customData.addLayer(KnotDataLayer)

    this.regenRender()
  }

  getBoundingBox(useGrids = true) {
    let d = 5

    return [new Vector3([d, d, d]), new Vector3([d, d, d])] as [Vector3, Vector3]
  }

  copy(): this {
    let ret = super.copy()

    ret.owningToolMode = this.owningToolMode
    ret.degree = this.degree
    ret.speedLength = this.speedLength
    ret._length = this._length

    return ret
  }

  *walk(all_verts = false) {
    if (this.verts.length === 0 || this.verts.first!.valence === 0) {
      return //empty mesh
    }

    //set flip flags
    let v = this.verts.first!
    let e = v.edges[0]

    let pv
    if (v.valence > 1) {
      pv = v.edges[1].otherVertex(v)
    }

    let _i = 0
    do {
      let ret = WalkRets.next().load(v, e)

      /*
      if (v === pv && !all_verts) {
        break;
      }
      //*/

      yield ret

      if (_i++ > 10000) {
        console.warn('mesh integrity error')
        break
      }

      let v2 = e.otherVertex(v)

      if (v2.valence < 2) {
        if (all_verts) {
          ret = WalkRets.next().load(v2, e)
          yield ret
        }

        break
      }

      e = v2.otherEdge(e)
      v = v2
    } while (v !== this.verts.first)
  }

  get length(): number {
    return this._length
  }

  updateKnots(): number {
    if (this.verts.length === 0 || this.edges.length === 0.0) return 0

    this.sortVerts()

    this.knotpad = this.degree

    let t = 0.0
    let laste, lastv

    this.knots = []
    let vs = []
    let es = []
    let e, v

    for ({v, e} of this.walk()) {
      break
    }

    for (let i = 0; i < this.knotpad; i++) {
      let k = 0.0

      k = getKnot(v!).knot
      t += e!.length * k

      this.knots.push(k)
    }

    for (let {v, e} of this.walk()) {
      let knot = getKnot(v)

      knot.computedKnot = t
      t += e.length * knot.knot
      laste = e
      lastv = v

      vs.push(v)
      es.push(e)

      this.knots.push(t)
    }

    if (laste && !this.isClosed) {
      let v2 = laste.otherVertex(lastv!)
      getKnot(v2).computedKnot = t
    }

    for (let i = 0; i < this.knotpad; i++) {
      if (this.isClosed) {
        let i2 = (vs.length + i - 1) % vs.length

        let k = getKnot(vs[i2]).knot

        //t += es[i2].length*k;
      }

      this.knots.push(t)
    }

    this.speedLength = t
    return this.speedLength
  }

  update(): this {
    super.update()

    if (this.verts.length === 0 || this.verts.first!.valence === 0) {
      return this //empty mesh
    }

    for (let e of this.edges) {
      e.update(true)
    }

    this._length = 0

    let i = 0
    for (let v of this.verts) {
      if (v.valence < 2) {
        if (i > 0) {
          console.warn('start of curve moved; fixing.')
          this.verts.swap(v, this.verts.first!)
        }

        break
      }
    }

    this.sortVerts()

    //set flip flags
    for (let {v, e} of this.walk()) {
      this._length += e.length
      if (v !== e.v1) {
        e.flag |= MeshFlags.CURVE_FLIP
      } else {
        e.flag &= ~MeshFlags.CURVE_FLIP
      }
    }

    this.updateKnots()
    return this
  }

  _genRenderElements(gl: WebGL2RenderingContext, uniforms: IUniformsBlock, combinedWireframe = false): void {
    this.update()
    return super._genRenderElements(gl, uniforms, combinedWireframe)
  }

  genRender(gl: WebGL2RenderingContext, combinedWireframe = false, view3d?: View3D) {
    this.update()
    return super.genRender(gl, combinedWireframe, view3d)
  }

  switchDirection(): void {
    this.verts.reverse()
    this.update()
  }

  static blockDefine() {
    return {
      typeName   : 'curve',
      defaultName: 'Curve',
      uiName     : 'Curve',
      flag       : 0,
      icon       : -1,
    }
  }

  static nodedef() {
    return {
      name   : 'curve',
      uiname : 'Curve',
      flag   : NodeFlags.SAVE_PROXY,
      inputs : {...super.nodedef().inputs}, //can inherit from parent class by wrapping in Node.inherit({})
      outputs: {...super.nodedef().outputs},
    }
  }

  static dataDefine() {
    return {
      name      : 'Curve',
      selectMask: SelMask.MESH,
      tools     : MeshTools,
    }
  }

  exec(ctx: ViewContext): void {
    super.exec(ctx)

    this.checkUpdate()
  }

  sortVerts(): this {
    let vs = []

    for (let {v} of this.walk(true)) {
      vs.push(v)
    }

    if (vs.length !== this.verts.length) {
      console.warn('Vertex sorting error', vs.length, this.verts.length)
      for (let v of this.verts) {
        if (vs.indexOf(v) < 0) {
          vs.push(v)
        }
      }
    }

    if (vs.length !== this.verts.length) {
      console.warn('Major sorting error! Aborting.')
      return this
    }

    this.verts.compact()

    for (let i = 0; i < vs.length; i++) {
      this.verts.list[i] = vs[i]
    }

    return this
  }

  evaluateSpeed2(s: number): number {
    return (s / this.length) * this.speedLength * 0.999999
  }

  evaluateSpeed(s: number): number {
    if (s < 0) return 0
    if (s > this.length) return this.length

    s = ((s * this.speedLength) / this.length) * 0.999999

    let vs = this.verts.list //compacted in sortVerts
    let ks = this.knots
    let sum = 0.0

    for (let i = 0; i < ks.length; i++) {
      let i2
      if (this.isClosed) {
        i2 = (i - this.knotpad + vs.length) % vs.length
      } else {
        i2 = Math.min(Math.max(i - this.knotpad, 0), vs.length - 1)
      }

      let w = basis(ks, s, i, this.degree)

      sum += w * ks[i]
    }

    return ((sum * this.length) / this.speedLength) * 0.999
  }

  /** s_out: array to hold [s, ds]*/
  evaluate(
    s: number,
    dv_out: Vector3 | undefined = undefined,
    no_out: Vector3 | undefined = undefined,
    e_out: Edge[] | undefined = undefined,
    s_out: number[] | undefined = undefined
  ) {
    s = Math.min(Math.max(s, 0.0), this.length)
    s = this.evaluateSpeed(s)

    let laste,
      lastv,
      ok = false,
      firste

    if (this.verts.length === 0) {
      return this._evaluate_vs.next().zero()
    }

    let knotIval = 1.0
    let lastknot
    let ds, firstds, lastds
    let t = 0.0
    let i = 0

    for (let {v, e} of this.walk()) {
      let knot = getKnot(v)
      let t2 = t + e.length

      if (firste === undefined) {
        firste = laste = e
      }

      let v2 = e.otherVertex(v)
      let knot2 = getKnot(v2)

      knotIval = t2 - t //(knot2.computedKnot - knot.computedKnot);

      if (firstds === undefined) {
        firstds = knotIval
      }

      if (s <= t2) {
        //knot2.computedKnot) {
        ok = true
        s = ((s - t) / knotIval) * e.length
        ds = lastds = knotIval

        laste = e
        lastv = v
        lastknot = knot2
        break
      }

      t += e.length
      laste = e
      lastv = v
      lastknot = knot2
      lastds = knotIval
      i++
    }

    let p = this._evaluate_vs.next()

    if (!ok) {
      s = s < this.length / 2.0 ? 0 : laste!.length
      if (s_out) {
        s_out[0] = s
        s_out[1] = lastds !== undefined ? lastds : laste!.length
      }

      if (e_out) e_out[0] = laste!
      if (dv_out) dv_out.load(laste!.arcDerivative(s))
      if (no_out) no_out.load(laste!.arcNormal(s))
      return p.load(laste!.arcEvaluate(s))
    } else {
      if (s_out) {
        s_out[0] = s
        s_out[1] = ds!
      }
      if (e_out) e_out[0] = laste!
      if (dv_out) dv_out.load(laste!.arcDerivative(s))
      if (no_out) no_out.load(laste!.arcNormal(s))

      return laste!.arcEvaluate(s)
    }
  }

  genRender_curves(
    gl: WebGL2RenderingContext,
    combinedWireframe: boolean,
    view3d: View3D,
    layers = LayerTypes.LOC | LayerTypes.UV | LayerTypes.ID
  ) {
    //let smesh

    let steps = 48 * this.edges.length
    let s = 0,
      ds = (this.length / (steps - 1)) * 1.4
    let drawnormals = this.drawflag & MeshDrawFlags.SHOW_NORMALS
    let sm = new SimpleMesh(layers)
    let lastco = undefined
    let no = new Vector3()
    let color1 = new Vector4(),
      color2 = new Vector4()
    let eout: Edge[] = new Array(1),
      sout: number[] = new Array(2)

    for (let i = 0; i < steps; i++, s += ds) {
      let co = this.evaluate(s, undefined, no, eout, sout)
      let e = eout[0]
      let s2 = sout[0]
      let elen = e.length
      let t = s2 / elen

      //console.log(s, co, this.speedLength);
      if (drawnormals) {
        let line

        let n = no

        let co2 = new Vector3(co)
        co2.addFac(n, (0.1 * this.length) / this.edges.length)

        line = sm.line(co, co2)
        if (layers & LayerTypes.COLOR) {
          if (e.flag & MeshFlags.CURVE_FLIP) {
            color1[0] = color1[1] = 1.0
            color1[2] = 0.0
            color1[3] = 1.0
          }
          line.colors(color1, color1)
        }
        if (layers & LayerTypes.ID) {
          line.ids(e.eid, e.eid)
        }
      }

      if (i > 0) {
        let line = sm.line(lastco!, co)

        if (layers & LayerTypes.COLOR) {
          line.colors(color1, color2)
        }

        if (layers & LayerTypes.ID) {
          line.ids(e.eid, e.eid)
        }
      }

      color1.load(color2)
      lastco = co
    }

    return sm
    /*
    for (let {v, e} of this.walk()) {
      if (e.flag & MeshFlags.HIDE) {
        continue;
      }

      let len;

      if (view3d !== undefined) {
        len = e.calcScreenLength(view3d);
      } else {
        len = e.length;
      }

      let steps = Math.max(Math.floor(len / 5), 8);
      let t = 0, dt = 1.0 / (steps - 1);
      let s = 0, ds = e.length / (steps - 1);
      let lastco = undefined;
      let black = [0, 0, 0, 1];
      let color1 = new Vector4();
      let color2 = new Vector4();

      for (let i = 0; i < steps; i++, t += dt, s += ds) {
        let co = e.arcEvaluate(s);

        if (layers & LayerTypes.COLOR) {
          color1.load(e.v1.color).interp(e.v2.color, t);
          color2.load(e.v1.color).interp(e.v2.color, t + dt);
        }

        if (drawnormals) {
          let line;

          if (lastco !== undefined) {
            line = sm.line(co, lastco);
            line.colors([0, 0, 0, 1], [1, 1, 1, 1]);
          }

          let n = e.arcNormal(s);

          let co2 = new Vector3(co);
          co2.addFac(n, e.length * 0.05);

          line = sm.line(co, co2);
          if (layers & LayerTypes.COLOR) {
            if (e.flag & MeshFlags.CURVE_FLIP) {
              color1[0] = color1[1] = 1.0;
              color1[2] = 0.0;
              color1[3] = 1.0;
            }
            line.colors(color1, color1);
          }
          if (layers & LayerTypes.ID) {
            line.ids(e.eid, e.eid);
          }
        }

        if (i > 0) {
          let line = sm.line(lastco, co);

          if (layers & LayerTypes.COLOR) {
            line.colors(color1, color2);
          }

          if (layers & LayerTypes.UV) {
            line.uvs([t, t], [t, t]);
          }

          if (layers & LayerTypes.ID) {
            line.ids(e.eid, e.eid);
          }
        }

        lastco = co;
      }
    }

    return sm;
    */
  }

  closestPoint(p: Vector3, mode: number): void {}

  checkClosed(): void {
    let v, e
    if (this.verts.length === 0 || this.edges.length === 0) {
      return
    }

    for ({v, e} of this.walk()) {
      break
    }

    let closed = v!.valence > 1
    if (!!closed !== !!this.isClosed) {
      this.sortVerts()

      if (closed) {
        for (let e of v!.edges) {
          if (e.otherVertex(v!) !== this.verts.list[1]) {
            this.killEdge(e)
            break
          }
        }
      } else {
        this.makeEdge(this.verts.first!, this.verts.last!)
      }

      for (let e of this.edges) {
        e.update()
      }
    }
  }

  checkUpdate(): void {
    this.checkClosed()

    //let hash = "";
    let key = this.isClosed ? 1 : 0

    for (let v of this.verts) {
      let knot = getKnot(v)
      let key2 = knot.knot * ((1 << 24) - 1)
      let key3 = knot.tilt * ((1 << 24) - 1)

      key = key ^ key2
      key = key ^ key3
    }

    if (key !== this._last_check_key) {
      console.log('detected knot update')
      this._last_check_key = key

      this.update()
      this.regenRender()
    }
  }

  drawQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject): void {
    this.checkUpdate()
    return super.drawQ(view3d, queue, frame, object)
  }

  drawElements(
    view3d: View3D,
    gl: WebGL2RenderingContext,
    selmask: number,
    uniforms: IUniformsBlock,
    program: ShaderProgram,
    object: SceneObject,
    drawTransFaces?: boolean
  ): void {
    this.checkUpdate()
    return super.drawElements(view3d, gl, selmask, uniforms, program, object, drawTransFaces)
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)
  }
}
