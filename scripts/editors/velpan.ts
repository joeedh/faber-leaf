import {Matrix4, Vector2} from '../util/vectormath.js'
import {StringProperty, nstructjs, ToolOp, UndoFlags} from '../path.ux/scripts/pathux.js'
import * as util from '../util/util.js'
import type {ToolContext} from '../core/context'
import type {StructReader} from '../path.ux/scripts/util/nstructjs'

export const VelPanFlags = {
  UNIFORM_SCALE: 1,
}

/**
 * 2D pan + zoom transform with optional inertial (momentum) panning.
 *
 * `mat`/`imat` are the current view matrix and its inverse; `pos`/`scale` are the
 * pan offset and zoom. After a drag releases, `vel` carries the view on under
 * exponential `decay` until it falls below a threshold (see `doVelocity`).
 */
export class VelPan {
  /** lower/upper pan limits (pre-scale); `pos` is clamped to these * `scale` */
  bounds: [Vector2, Vector2] = [new Vector2([-2000, -2000]), new Vector2([2000, 2000])]

  /** per-millisecond momentum decay: `vel *= decay**dt`. 0 disables inertia. */
  decay = 0.995
  pos = new Vector2()
  scale = new Vector2([1, 1])
  /** current pan velocity (units/ms), integrated each `doVelocity` tick */
  vel = new Vector2()
  oldpos = new Vector2()

  /** floor on the integration timestep so a long frame can't over-decay `vel` */
  minTimeStep = 0.001

  /** bitmask of pannable axes (bit0 = x, bit1 = y); 3 = both */
  axes = 3
  flag = VelPanFlags.UNIFORM_SCALE

  mat = new Matrix4()
  imat = new Matrix4()
  domMat = new DOMMatrix()

  _last_mat = new Matrix4(this.mat)
  onchange: ((velpan?: VelPan) => void) | null = null
  last_update_time = util.time_ms()

  timer: number | undefined = undefined

  copy(): VelPan {
    return new VelPan().load(this)
  }

  //for controller api; doesn't support multipart datapaths
  get min(): Vector2 {
    return this.bounds[0]
  }

  //for controller api; doesn't support multipart datapaths
  get max(): Vector2 {
    return this.bounds[1]
  }

  reset(fireOnChange = true): this {
    this.pos.zero()
    this.scale.zero().addScalar(1.0)
    this.updateMatrix()

    if (this.onchange && fireOnChange) {
      this.onchange()
    }

    return this
  }

  /**
   load settings from another velocity pan instance
   does NOT set this.onchange
   * */
  load(velpan: VelPan): this {
    this.pos.load(velpan.pos)
    this.scale.load(velpan.scale)
    this.axes = velpan.axes
    this.bounds[0].load(velpan.bounds[0])
    this.bounds[1].load(velpan.bounds[1])

    this.update(false)

    return this
  }

  /** Begin (or keep) the inertial-pan timer that ticks `doVelocity`. */
  startVelocity(): void {
    if (this.timer === undefined) {
      this.last_update_time = util.time_ms()

      this.timer = window.setInterval(() => this.doVelocity(), 30)
    }
  }

  /**
   * One inertia tick: advance `pos` by `vel`, decay `vel`, and fire `onchange`.
   * Self-cancels its timer once the velocity drops below a small threshold.
   */
  doVelocity(): void {
    if (this.vel.dot(this.vel) < 0.001) {
      window.clearInterval(this.timer)
      this.timer = undefined
      return
    }

    let dt = util.time_ms() - this.last_update_time
    this.pos.addFac(this.vel, dt)

    dt = Math.max(dt, this.minTimeStep)
    this.vel.mulScalar(Math.pow(this.decay, dt))

    this.updateMatrix()

    if (this.onchange) {
      this.onchange()
    }

    this.last_update_time = util.time_ms()
  }

  /**
   * Scale the zoom by `fac` while keeping the world/graph-space point `pos`
   * fixed on screen. With `screen = scale * (graph + pan)`, holding `pos`
   * invariant gives `newPan = (pos + pan)/fac - pos`.
   */
  zoomAround(pos: Vector2, fac: number): this {
    this.pos
      .add(pos)
      .mulScalar(1.0 / fac)
      .sub(pos)
    this.scale.mulScalar(fac)
    this.update()
    return this
  }

  updateMatrix(): this {
    const s = this.scale
    const min = new Vector2(this.bounds[0]).div(s)
    const max = new Vector2(this.bounds[1]).div(s)

    this.pos.max(min)
    this.pos.min(max)

    const msmat = new Matrix4().scale(this.scale[0], this.scale[1], 1.0)
    const mtmat = new Matrix4().translate(this.pos[0], this.pos[1], 0.0)

    this.mat.makeIdentity()
    this.mat.multiply(msmat)
    this.mat.multiply(mtmat)

    this.imat.load(this.mat).invert()

    const smat = new DOMMatrix()
    const tmat = new DOMMatrix()

    smat.scaleSelf(this.scale[0], this.scale[1])
    tmat.translateSelf(this.pos[0], this.pos[1])

    this.domMat = new DOMMatrix()
    this.domMat.multiplySelf(smat)
    this.domMat.multiplySelf(tmat)

    return this
  }

  /**
   * Rebuild `mat`/`imat` from the current `pos`/`scale`. Kicks off inertial
   * panning when `do_velocity` and there's residual velocity, and fires
   * `onchange` (when `fire_events`) only if the matrix actually changed.
   */
  update(fire_events = true, do_velocity = true): this {
    if (do_velocity && this.vel.dot(this.vel) > 0.001) {
      this.startVelocity()
    }

    this.updateMatrix()

    if (fire_events && JSON.stringify(this.mat) !== JSON.stringify(this._last_mat)) {
      this._last_mat.load(this.mat)

      if (this.onchange) this.onchange(this)
    }

    return this
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    this.updateMatrix()
  }

  static STRUCT = `
VelPan {
  bounds : array(vec2);
  pos    : vec2;
  scale  : vec2;
  axes   : int;
  mat    : mat4;
  imat   : mat4;
  flag   : int;
}
`
}
nstructjs.register(VelPan)

/**
 * Modal drag-to-pan tool for any `VelPan`. `velpanPath` is a data-API path to
 * the target VelPan; the drag updates its `pos` and seeds `vel` so the view
 * keeps gliding (inertia) after release.
 */
export class VelPanPanOp extends ToolOp<{velpanPath: StringProperty}, {}, ToolContext> {
  start_pan = new Vector2()
  first = true
  last_mpos = new Vector2()
  start_mpos = new Vector2()
  start_time = 0
  last_time = 0
  _temps = util.cachering.fromConstructor<Vector2>(Vector2, 16)

  static tooldef() {
    return {
      uiname     : 'Pan (2d)',
      description: 'Pan 2d window',
      toolpath   : 'velpan.pan',
      undoflag   : UndoFlags.NO_UNDO,
      is_modal   : true,
      icon       : -1,

      inputs: {
        velpanPath: new StringProperty(),
      },
    }
  }

  on_pointermove(e: PointerEvent): void {
    const ctx = this.modal_ctx!
    const path = this.inputs.velpanPath.getValue()
    const velpan = ctx.api.getValue<VelPan>(ctx, path)

    if (velpan === undefined) {
      this.modalEnd(false)
      throw new Error('bad velpan path ' + path + '.')
    }

    const mpos = this._temps.next().zero()
    mpos[0] = e.x
    mpos[1] = e.y

    if (this.first) {
      this.start_mpos.load(mpos)
      this.last_mpos.load(mpos)
      this.start_pan.load(velpan.pos)
      this.start_time = util.time_ms()
      this.last_time = util.time_ms()

      this.first = false

      return
    }

    let dx = mpos[0] - this.last_mpos[0]
    let dy = mpos[1] - this.last_mpos[1]

    dx /= velpan.scale[0]
    dy /= velpan.scale[1]

    const dt = util.time_ms() - this.last_time
    const vel = new Vector2().loadXY(dx, dy)

    velpan.pos.add(vel)
    velpan.oldpos.load(velpan.pos)

    vel.mulScalar(dt !== 0.0 ? 1.0 / dt : 0.0)
    velpan.vel.load(vel)

    this.last_time = util.time_ms()

    velpan.update(undefined, false)

    this.last_mpos.load(mpos)
  }

  on_pointerup(_e: PointerEvent): void {
    const ctx = this.modal_ctx!
    this.modalEnd(false)

    const path = this.inputs.velpanPath.getValue()
    const velpan = ctx.api.getValue<VelPan>(ctx, path)
    velpan?.startVelocity()
  }
}

ToolOp.register(VelPanPanOp)
