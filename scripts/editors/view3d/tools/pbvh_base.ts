import {bez4, dbez4} from '../../../util/bezier.js'
import {copyMouseEvent} from '../../../path.ux/scripts/path-controller/util/events.js'
import type {ToolContext, ViewContext} from '../../../core/context.js'
import {BrushProperty, PaintSample, PaintSampleProperty, PaintToolModeBase} from './stroke_base.js'
import {resolveToolDabPolicy} from './sculptcore_bindings'

import {
  Curve1DProperty,
  Vec2Property,
  EnumProperty,
  FlagProperty,
  FloatProperty,
  keymap,
  Mat4Property,
  Matrix4,
  ToolOp,
  Vector2,
  Vector3,
  Vector4,
  PropertySlots,
  IVectorOrHigher,
  Number3,
} from '../../../path.ux/scripts/pathux.js'

import {BrushFlags, BrushRadiusModes, SculptBrush, SculptTools, BrushSpacingModes} from '../../../brush/index'
import {TexUserFlags, TexUserModes} from '../../../texture/proceduralTex'
import {DataRefProperty, DataRef} from '../../../core/lib_api.js'
import {AttrRef, CDFlags} from '../../../../addons/builtin/mesh/src/customdata.js'
import {TetMesh} from '../../../tet/tetgen.js'
import {Mesh, Vector3LayerElem, Vertex} from '../../../../addons/builtin/mesh/src/mesh.js'
import {GridBase} from '../../../../addons/builtin/mesh/src/mesh_grids.js'
import {BVH, BVHFlags, IBVHVertex} from '../../../../addons/builtin/mesh/src/bvh.js'
import {GenericIsect} from '../../../util/spatial.js'
import type {IGenericIsect, ISurfaceSampler} from '../../../util/spatial.js'
import {MeshFlags} from '../../../../addons/builtin/mesh/src/mesh.js'

import * as util from '../../../util/util.js'
import {SceneObject, SceneObjectData} from '../../../sceneobject/index.js'

export interface ISampleViewRet {
  origco: Vector3
  p: Vector3
  isect: IGenericIsect
  radius: number
  ob: SceneObject
  vec: Vector3
  mpos: Vector2
  view: Vector3
  origin: Vector3
  getchannel(key: string, value: number): number
  w: number
}

export function getBVH(ctx: any): BVH | undefined {
  const ob = ctx.object

  if (!ob) {
    return undefined
  }

  if (ob.data instanceof Mesh || ob.data instanceof TetMesh) {
    return ob.data.getBVH({autoUpdate: false})
  }
}

export function regenBVH(ctx: any): void {
  const ob = ctx.object

  if (!ob) {
    return undefined
  }

  if (ob.data instanceof Mesh || ob.data instanceof TetMesh) {
    ob.data.regenBVH()
  }
}

export class SetBrushRadius extends ToolOp<
  {radius: FloatProperty; brush: DataRefProperty<SculptBrush>},
  {},
  ToolContext,
  ViewContext
> {
  last_mpos: Vector2
  mpos: Vector2
  start_mpos: Vector2
  cent_mpos: Vector2
  first: boolean
  _undo: {radius?: number; sharedMode?: number; brushref?: DataRef} | undefined
  rand: util.MersenneRandom

  constructor() {
    super()

    this.rand = new util.MersenneRandom()

    this.last_mpos = new Vector2()
    this.mpos = new Vector2()
    this.start_mpos = new Vector2()
    this.cent_mpos = new Vector2()
    this.first = true
  }

  static canRun(ctx: ToolContext): boolean {
    return ctx.toolmode instanceof PaintToolModeBase
  }

  static tooldef(): any {
    return {
      uiname  : 'Set Brush Radius',
      toolpath: 'brush.set_radius',
      inputs: {
        radius: new FloatProperty(15.0),
        brush : new DataRefProperty(SculptBrush),
      },
      is_modal: true,
    }
  }

  static invoke(ctx: ViewContext, args: any) {
    const tool = super.invoke(ctx, args) as SetBrushRadius

    const toolmode = ctx.toolmode as PaintToolModeBase
    if (!(toolmode instanceof PaintToolModeBase)) {
      return tool
    }

    const brush = toolmode.getBrush()
    if (!brush) {
      return tool
    }

    if (!('brush' in args)) {
      tool.inputs.brush.setValue(brush)
    }

    if (!('radius' in args)) {
      const radius = brush.flag & BrushFlags.SHARED_SIZE ? toolmode.sharedRadiusFor(brush.radiusMode) : brush.radius
      tool.inputs.radius.setValue(radius)
    }

    return tool
  }

  modalStart(ctx: any): any {
    this.rand.seed(0)
    this.first = true

    return super.modalStart(ctx)
  }

  on_pointermove(e: PointerEvent): void {
    const mpos = this.mpos

    mpos[0] = e.x
    mpos[1] = e.y

    const ctx = this.modal_ctx!

    const brush = ctx.datalib.get(this.inputs.brush.getValue())
    if (!brush) {
      return
    }

    if (this.first) {
      this.first = false
      // Screen-space pivot, so a WORLD-unit radius has to be converted first.
      const screenRadius = this._toScreenRadius(ctx, brush, brush.radius)
      this.cent_mpos.load(mpos).subScalar(screenRadius / devicePixelRatio / Math.sqrt(2.0))

      this.start_mpos.load(mpos)
      this.last_mpos.load(mpos)
      return
    }

    const l1 = mpos.vectorDistance(this.cent_mpos)
    const l2 = this.last_mpos.vectorDistance(this.cent_mpos)

    if (l2 === 0.0 || l1 === 0.0) {
      return
    }

    this.resetTempGeom()
    this.makeTempLine(this.cent_mpos, this.mpos, 'rgba(25,25,25,0.25)')

    const toolmode = ctx.toolmode
    if (toolmode instanceof PaintToolModeBase) {
      toolmode.mpos.load(this.cent_mpos)
    }

    const ratio = l1 / l2
    let radius: number

    if (brush.flag & BrushFlags.SHARED_SIZE) {
      const paintmode = this._paintToolMode(ctx)
      radius = paintmode ? paintmode.sharedRadiusFor(brush.radiusMode) : brush.radius
    } else {
      radius = brush.radius
    }

    radius *= ratio

    this.last_mpos.load(mpos)
    this.inputs.radius.setValue(radius)

    this.exec(ctx)
    window.redraw_viewport_p(false).then(() => {
      // XXX find less hackish way of getting brush to draw
      // since drawBrush by default hides it in modal toolops
      const toolmode = ctx.toolmode
      if (ctx.view3d && toolmode instanceof PaintToolModeBase) {
        toolmode.drawBrush(ctx.view3d, true)
      }
    })
  }

  on_pointerup(e: PointerEvent): void {
    this.modalEnd(false)
  }

  /** SHARED_SIZE stores the radius on the paint toolmode instead of the brush, and
   * each paint toolmode keeps its own `sharedBrushRadius` — so this must follow the
   * active mode. Resolving a fixed mode strands the write in sculptcore mode. */
  private _paintToolMode(ctx: ToolContext): PaintToolModeBase | undefined {
    const toolmode = ctx.toolmode
    return toolmode instanceof PaintToolModeBase ? toolmode : undefined
  }

  /** Convert `radius` (in the brush's own unit) to screen pixels — this modal's
   * geometry is screen-space. A WORLD-unit radius converts through the last
   * dab's world-units-per-pixel; before any dab that factor is unknown. */
  private _toScreenRadius(ctx: ToolContext, brush: SculptBrush, radius: number): number {
    const toolmode = this._paintToolMode(ctx)
    if (brush.radiusMode !== BrushRadiusModes.WORLD || !toolmode || toolmode.lastScreenRadius <= 0) {
      return radius
    }
    const dist = toolmode.lastWorldRadius / toolmode.lastScreenRadius
    return dist > 0 ? radius / dist : radius
  }

  exec(ctx: ToolContext): void {
    const brush = ctx.datalib.get(this.inputs.brush.getValue())

    if (brush) {
      if (brush.flag & BrushFlags.SHARED_SIZE) {
        const toolmode = this._paintToolMode(ctx)

        if (toolmode) {
          // The radius input rides in the brush's own unit; tag the store with it.
          toolmode.setSharedRadius(this.inputs.radius.getValue(), brush.radiusMode)
        }
      } else {
        brush.radius = this.inputs.radius.getValue()
      }
    }
  }

  undoPre(ctx: ToolContext): void {
    const brush = ctx.datalib.get(this.inputs.brush.getValue())

    this._undo = {}

    if (brush) {
      const toolmode = this._paintToolMode(ctx)

      // Capture whichever value exec() will overwrite, or undo restores a stale radius.
      this._undo.radius = brush.flag & BrushFlags.SHARED_SIZE && toolmode ? toolmode.sharedBrushRadius : brush.radius
      this._undo.sharedMode = toolmode?.sharedRadiusMode
      this._undo.brushref = DataRef.fromBlock(brush)
    }
  }

  undo(ctx: ToolContext): void {
    const undo = this._undo

    if (!undo?.brushref || undo.radius === undefined) {
      return
    }

    const brush = ctx.datalib.get<SculptBrush>(undo.brushref)
    if (!brush) {
      return
    }

    if (brush.flag & BrushFlags.SHARED_SIZE) {
      const toolmode = this._paintToolMode(ctx)

      if (toolmode) {
        toolmode.setSharedRadius(undo.radius, undo.sharedMode ?? toolmode.sharedRadiusMode)
      }
    } else {
      brush.radius = undo.radius
    }
  }

  on_keydown(e: KeyboardEvent): void {
    switch (e.keyCode) {
      case keymap['Escape']:
      case keymap['Enter']:
      case keymap['Space']:
        this.modalEnd(false)
        break
    }
  }
}

ToolOp.register(SetBrushRadius)

/**
 * Switch the unit `brush.radius` is expressed in, rewriting the stored value so
 * the brush keeps its current on-screen size across the switch (55 px and 55
 * mesh units are wildly different sizes). The world-units-per-pixel factor comes
 * from the last primary dab that hit the surface; before any dab there is
 * nothing to convert through, so the value is left alone.
 */
export class SetBrushRadiusMode extends ToolOp<
  {mode: EnumProperty; brush: DataRefProperty<SculptBrush>},
  {},
  ToolContext,
  ViewContext
> {
  _undo: {radius?: number; shared?: number; sharedMode?: number; radiusMode?: number; brushref?: DataRef} | undefined

  static canRun(ctx: ToolContext): boolean {
    return ctx.toolmode instanceof PaintToolModeBase
  }

  static tooldef(): any {
    return {
      uiname  : 'Set Radius Unit',
      toolpath: 'brush.set_radius_mode',
      inputs: {
        mode: new EnumProperty(BrushRadiusModes.SCREEN, {
          SCREEN: BrushRadiusModes.SCREEN,
          WORLD : BrushRadiusModes.WORLD,
        }),
        brush: new DataRefProperty(SculptBrush),
      },
    }
  }

  static invoke(ctx: ViewContext, args: any) {
    const tool = super.invoke(ctx, args) as SetBrushRadiusMode

    const toolmode = ctx.toolmode
    if (!(toolmode instanceof PaintToolModeBase)) {
      return tool
    }

    const brush = toolmode.getBrush()
    if (brush && !('brush' in args)) {
      tool.inputs.brush.setValue(brush)
    }

    return tool
  }

  /** The paint toolmode owning `sharedBrushRadius` / the tracked radii. */
  private _paintToolMode(ctx: ToolContext): PaintToolModeBase | undefined {
    const toolmode = ctx.toolmode
    return toolmode instanceof PaintToolModeBase ? toolmode : undefined
  }

  undoPre(ctx: ToolContext): void {
    const brush = ctx.datalib.get<SculptBrush>(this.inputs.brush.getValue())

    this._undo = {}
    if (brush) {
      const toolmode = this._paintToolMode(ctx)
      this._undo.radius = brush.radius
      this._undo.shared = toolmode?.sharedBrushRadius
      this._undo.sharedMode = toolmode?.sharedRadiusMode
      this._undo.radiusMode = brush.radiusMode
      this._undo.brushref = DataRef.fromBlock(brush)
    }
  }

  undo(ctx: ToolContext): void {
    const undo = this._undo
    if (!undo?.brushref || undo.radius === undefined || undo.radiusMode === undefined) {
      return
    }

    const brush = ctx.datalib.get<SculptBrush>(undo.brushref)
    if (!brush) {
      return
    }

    const toolmode = this._paintToolMode(ctx)
    brush.radius = undo.radius
    brush.radiusMode = undo.radiusMode
    if (toolmode && undo.shared !== undefined) {
      toolmode.setSharedRadius(undo.shared, undo.sharedMode ?? toolmode.sharedRadiusMode)
    }
  }

  exec(ctx: ToolContext): void {
    const brush = ctx.datalib.get<SculptBrush>(this.inputs.brush.getValue())
    if (!brush) {
      return
    }

    const mode = this.inputs.mode.getValue() as number
    if (mode === brush.radiusMode) {
      return
    }

    const toolmode = this._paintToolMode(ctx)
    const screen = toolmode ? toolmode.lastScreenRadius : 0
    const world = toolmode ? toolmode.lastWorldRadius : 0

    // SHARED_SIZE keeps the live radius on the toolmode, so converting
    // brush.radius alone would be a no-op in the default configuration.
    if (brush.flag & BrushFlags.SHARED_SIZE && toolmode) {
      // sharedRadiusFor converts from the tagged unit (no-op when it already
      // matches); retagging keeps readers in the other unit from misreading.
      toolmode.setSharedRadius(toolmode.sharedRadiusFor(mode), mode)
    } else if (screen > 0 && world > 0) {
      // Both are only set by a dab that hit the surface; without them the factor
      // is unknown, so switch the unit and leave the number as the user set it.
      const dist = world / screen
      brush.radius = mode === BrushRadiusModes.WORLD ? brush.radius * dist : brush.radius / dist
    }

    brush.radiusMode = mode
  }
}

ToolOp.register(SetBrushRadiusMode)

const co = new Vector3()
const t1 = new Vector3()
const t2 = new Vector3()

export class PathPoint {
  color: string
  co: Vector2
  origco: Vector2
  vel: Vector2
  acc: Vector2
  dt: number
  pressure = 1.0

  constructor(co: any, dt: number, pressure = 1.0) {
    this.color = 'yellow'
    this.pressure = pressure
    this.co = new Vector2(co)
    this.origco = new Vector2(co)
    this.vel = new Vector2()
    this.acc = new Vector2()
    this.dt = dt
  }
}

export function calcConcave(v: any): number {
  co.zero()
  let tot = 0.0
  let elen = 0

  for (const v2 of v.neighbors) {
    co.add(v2.co)
    elen += v2.co.vectorDistance(v.co)

    tot++
  }

  if (tot === 0.0) {
    return 0.5
  }

  elen /= tot

  co.mulScalar(1.0 / tot)
  t1.load(v.co)
    .sub(co)
    .mulScalar(1.0 / elen)
  const fac = t1.dot(v.no) * 0.5 + 0.5

  return 1.0 - fac
}

export function calcConcaveLayer(mesh: any): void {
  const name = '_paint_concave'

  let cd_concave = mesh.verts.customData.getNamedLayerIndex(name, 'float')
  if (cd_concave < 0) {
    const layer = mesh.verts.addCustomDataLayer('float', name)
    layer.flag |= CDFlags.TEMPORARY

    cd_concave = layer.index
  }

  for (const v of mesh.verts) {
    //
  }
}

export abstract class PaintOpBase<
  OBDATA extends SceneObjectData,
  Inputs extends PropertySlots = {},
  Outputs extends PropertySlots = {},
> extends ToolOp<
  {
    brush: BrushProperty //
    samples: PaintSampleProperty //
    symmetryAxes: FlagProperty //
    falloff: Curve1DProperty //
    rendermat: Mat4Property //
    viewportSize: Vec2Property
  } & Inputs,
  Outputs,
  ToolContext,
  ViewContext
> {
  task: Generator<void, void, unknown> | undefined
  grabMode: boolean
  mfinished: boolean
  last_mpos: Vector2 | Vector3
  last_p: Vector3
  last_origco: Vector4
  _first: boolean
  last_draw: number
  lastps1: PaintSample | undefined
  lastps2: PaintSample | undefined
  lastps3: PaintSample | undefined
  lastDabS = 0
  sumDabS = 0
  last_radius: number
  last_vec: Vector3
  rand: util.MersenneRandom
  queue: [PointerEvent, PathPoint, number][]
  qlast_time: number
  timer: number | undefined
  path: PathPoint[]
  alast_time: number
  _savedViewPoints: {viewvec: Vector3; viewp: Vector3; rendermat: Matrix4; mpos: Vector2}[]

  constructor() {
    super()

    this.task = undefined

    this.grabMode = false

    this.mfinished = false
    this.last_mpos = new Vector2()
    this.last_p = new Vector3()
    this.last_origco = new Vector4()
    this._first = true

    this.last_draw = util.time_ms()

    this.lastps1 = undefined
    this.lastps2 = undefined

    this.last_radius = 0
    this.last_vec = new Vector3()

    this.rand = new util.MersenneRandom()

    this.queue = []
    this.qlast_time = util.time_ms()
    this.timer = undefined

    this.path = []
    this.alast_time = util.time_ms()

    this._savedViewPoints = []
  }

  abstract getSampler(obdata: OBDATA): ISurfaceSampler

  static tooldef(): any {
    return {
      inputs: {
        brush       : new BrushProperty(),
        samples     : new PaintSampleProperty(),
        symmetryAxes: new FlagProperty(undefined, {X: 1, Y: 2, Z: 4}),
        falloff     : new Curve1DProperty(),
        rendermat   : new Mat4Property(),
        viewportSize: new Vec2Property(),
      },
    }
  }

  static needOrig(brush: any): boolean {
    const mode = brush.tool

    let isPaint = mode === SculptTools.MASK_PAINT || mode === SculptTools.TEXTURE_PAINT
    isPaint = isPaint || mode === SculptTools.PAINT || mode === SculptTools.PAINT_SMOOTH

    let ret = mode === SculptTools.SHARP || mode === SculptTools.GRAB
    ret = ret || mode === SculptTools.SNAKE // || mode === SculptTools.SMOOTH;
    ret = ret || (!isPaint && mode !== SculptTools.GRAB && brush.pinch !== 0.0)
    ret = ret || mode === SculptTools.PINCH || mode === SculptTools.SLIDE_RELAX

    //ret = ret || brush.autosmooth > 0 || brush.rake > 0 || brush.pinch > 0;

    if (brush.texUser.texture) {
      ret = ret || !!(brush.texUser.flag & TexUserFlags.ORIGINAL_CO)
    }

    return ret
  }

  timer_on_tick(): void {
    if (!this.modalRunning) {
      window.clearInterval(this.timer)
      this.timer = undefined
      return
    }

    // TODO: paint timer queue is currently disabled; investigate before re-enabling.
    if (this.queue.length === 0) {
      return
    }

    if (util.time_ms() - this.last_draw > 100) {
      this.last_draw = util.time_ms()
      this.drawPath()
    }

    if (util.time_ms() - this.qlast_time > 5) {
      const time = util.time_ms()

      this.taskNext()

      this.qlast_time = util.time_ms()
    }
  }

  appendPath(x: number, y: number, pressure = 1.0): void {
    let dt = util.time_ms() - this.alast_time
    dt = Math.max(dt, 1.0)

    const p = new PathPoint([x, y], dt, pressure)
    const path = this.path
    const dpi = devicePixelRatio

    if (path.length > 0) {
      const p0 = path[path.length - 1]
      p.vel.load(p.co).sub(p0.co)
      p.acc.load(p.vel).sub(p0.vel)

      let vel: Vector2
      //vel = new Vector3(p.vel).add(p0.vel).mulScalar(0.5);
      vel = p.vel
      const l1 = p0.vel.vectorLength()
      const l2 = p.vel.vectorLength()

      if (p.vel.vectorLength() > 7 / dpi) {
        const co = new Vector2()

        const a = new Vector2()
        const b = new Vector2()
        const c = new Vector2()
        const d = new Vector2()

        const vel1 = new Vector2(p0.vel).addFac(p0.acc, 0.5).mulScalar(0.5)
        const vel2 = new Vector2(p.vel).addFac(p.acc, 0.5).mulScalar(0.5)

        a.load(p0.co)
        d.load(p.co)
        b.load(a).addFac(vel1, 1.0 / 3.0)
        c.load(d).addFac(vel2, -1.0 / 3.0)

        co.load(p0.co)
          .addFac(p.vel, 0.5)
          .addFac(p.acc, 1.0 / 6.0)

        const brush = this.inputs.brush.getValue()
        const radius = brush.radius
        const spacing = brush.spacing

        const steps = Math.ceil(p.co.vectorDistance(p0.co) / (4 * radius * spacing))

        if (steps === 0) {
          this.path.push(p)
          this.alast_time = util.time_ms()
          return
        }

        let s = 0
        const ds = 1.0 / steps
        dt *= ds

        const lastp = p0

        for (let i = 0; i < steps; i++, s += ds) {
          const p2 = new PathPoint(undefined, ds, pressure)
          for (let j = 0; j < 2; j++) {
            p2.co[j as 0 | 1] = bez4(a[j], b[j], c[j], d[j], s)
            p2.vel[j as 0 | 1] = dbez4(a[j], b[j], c[j], d[j], s) * ds
          }

          p2.color = 'orange'
          p2.origco.load(p0.co).interp(p.co, s)

          p2.vel.load(p2.co).sub(lastp.co)
          p2.acc.load(p2.vel).sub(lastp.vel)
          this.path.push(p2)
        }

        p.vel
          .load(d)
          .sub(c)
          .mulScalar(-3.0 * ds)

        p.acc.load(p.vel).sub(lastp.vel)
        p.dt = dt

        if (0) {
          const p2 = new PathPoint(co, dt * 0.5)
          path.push(p2)

          p2.dt = dt * 0.5
          p.dt = dt * 0.5

          p2.vel.load(p2.co).sub(p0.co)
          p2.acc.load(p2.vel).sub(p0.vel)

          p.vel.load(p.co).sub(p2.co)
          p.acc.load(p.vel).sub(p2.vel)
        }
      }
    }

    path.push(p)
    this.alast_time = util.time_ms()
  }

  drawPath(): void {
    this.resetTempGeom()
    let lastp: PathPoint | undefined

    let start = this.path.length
    if (this.queue.length > 0) {
      start = this.queue[0][2]
    }

    const n = new Vector2()
    const color = 'rgba(255, 255, 255, 0.4)'

    for (let pi = start; pi < this.path.length; pi++) {
      const p = this.path[pi]

      if (lastp) {
        n.load(p.co).sub(lastp.co).normalize()
        const t = n[0]
        n[0] = n[1]
        n[1] = -t
        n.mulScalar(15.0)
        n.add(p.origco)

        this.makeTempLine(lastp.co, p.co, color)

        //this.makeTempLine(p.co, n, p.color);
        //this.makeTempLine(lastp.origco, p.origco, p.color);
      }
      lastp = p
    }
  }

  on_keydown(e: any): void {
    switch (e.keyCode) {
      case keymap['Escape']:
        this.modalEnd(false)

        if (this.timer) {
          window.clearInterval(this.timer)
          this.timer = undefined
        }

        //terminate immediately
        this.queue.length = 0
        while (this.task) {
          this.taskNext()
        }
        break
      case keymap['Enter']:
      case keymap['Space']:
        this.modalEnd(false)
        break
    }
  }

  getPressure(e: PointerEvent) {
    return e.pressure ?? 1.0
  }

  on_pointermove(e: any, in_timer: boolean = false): void {
    if (this.mfinished) {
      return //wait for modalEnd
    }

    let pi = this.path.length

    if (this.inputs.brush.getValue().spacingMode === BrushSpacingModes.EVEN) {
      //try to detect janky events and interpolate with a curve
      //note that this is not the EVEN spacing mode which happens in
      //subclases, it doesn't respect brush spacing when outputting the curve
      this.appendPath(e.x, e.y, this.getPressure(e))
    } else {
      const p = new PathPoint([e.x, e.y], util.time_ms() - this.alast_time, this.getPressure(e))
      this.path.push(p)
    }

    this.alast_time = util.time_ms()
    this.drawPath()

    for (; pi < this.path.length; pi++) {
      const p = this.path[pi]

      const e2 = copyMouseEvent(e) as unknown as PointerEvent

      this.queue.push([e2, p, pi])
      //this.on_pointermove_intern(e, p.co[0], p.co[1], in_timer, pi !== this.path.length-1);
    }

    if (!this.task) {
      this.task = this.makeTask()
    }
  }

  rayCast?: (
    ctx: ToolContext,
    origin: Vector3,
    dir: Vector3
  ) => {p: Vector3; uv: Vector2; dis: number; normal: Vector3} | undefined

  feedTask(e: PointerEvent, p: PathPoint, pi: number): Generator<void, void, unknown> | void {
    const ps = new PaintSample()
    const ctx = this.modal_ctx!
    const view3d = ctx.view3d

    const local = view3d.getLocalMouse(e.x, e.y)
    const viewvec = view3d.getViewVec(local[0], local[1])
    const origin = view3d.activeCamera.pos.copy()
    const brush = this.inputs.brush.getValue()
    // Grab-class kernels (@grabmode / @incremental) drive grabFrom/grabTo from
    // raw pointer movement, so they take unsmoothed events and ignore invert.
    const isGrabTool = resolveToolDabPolicy(brush.tool).isGrab

    ps.screenP.load(view3d.getLocalMouse(p.co[0], p.co[1]))
    ps.viewPlane.load(viewvec).normalize()
    ps.invert = e.ctrlKey && !isGrabTool

    if (this.rayCast) {
      const r = this.rayCast(ctx, origin, viewvec)
      if (r) {
        ps.p.load3(r.p)
        ps.p[3] = 1.0
      }
    }

    let pressure = 1.0
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      pressure = e.pressure
    }
    const getchannel = (key: string, val: number): number => {
      const ch = brush.dynamics.getChannel(key)
      if (ch?.useDynamics) {
        return val * ch.curve.evaluate(pressure)
      } else {
        return val
      }
    }

    ps.pressure = pressure
    ps.strength = getchannel('strength', brush.strength)
    ps.radius = getchannel('radius', brush.radius)
    ps.color = brush.color

    const spacing = getchannel('spacing', brush.spacing)

    // TODO: find where this setting is
    const spacingMode: 'world' | 'screen' = 'screen'

    // grab tools get raw events
    if (isGrabTool) {
      ps.isInterp = false
      this.onBrushDab(e, ps, true, false)
      return
    }

    // interpolate stroke

    if (!this.lastps1) {
      ps.isInterp = false
      this.onBrushDab(e, ps, true, false)
    } else {
      const lastps1 = this.lastps1
      const lastps2 = this.lastps2
      const lastps3 = this.lastps3

      function interpScalar(t: number, key: keyof PaintSample, subkey?: number) {
        /** TODO: smoothly interpolate using ps, lastps1, lastps2, lastps3*/
        const a = (subkey !== undefined ? (lastps1![key] as any)[subkey] : lastps1[key]) as number
        const b = (subkey !== undefined ? (ps![key] as any)[subkey] : ps[key]) as number

        return a + (b - a) * t
      }
      function interp(t: number, key: keyof PaintSample) {
        const val = ps[key]
        if (typeof val === 'number') {
          return interpScalar(t, key)
        } else if (val instanceof Vector2 || val instanceof Vector3 || val instanceof Vector4) {
          const result = val.copy()
          for (let i = 0; i < val.length; i++) {
            result[i] = interpScalar(t, key, i)
          }
          return result
        }
        console.warn(key, val)
        throw new Error('invalid type for key ' + key)
      }
      function arcLength() {
        // TODO implement this to for whatever curve interpolation we end up using
        if (spacingMode === 'world') {
          return lastps1.p.vectorDistance(ps.p)
        } else {
          return lastps1.screenP.vectorDistance(ps.screenP)
        }
      }

      ps.dp.load(ps.p).sub(lastps1.p)
      ps.dScreenP.load(ps.screenP).sub(lastps1.screenP)

      this.sumDabS += arcLength() / (ps.radius * 2.0)
      ps.strokeS = this.sumDabS

      // enforce minimum spacing
      if (ps.strokeS - this.lastDabS < spacing) {
        return
      }

      ps.dstrokeS = ps.strokeS - this.lastDabS

      const steps = Math.floor(ps.dstrokeS / spacing)
      let prevps: PaintSample | undefined

      for (let i = 0; i < steps; i++) {
        const t = (i + i) / steps

        const ps2 = new PaintSample()
        ps.copyTo(ps2)

        // manual interpolation here
        ps2.strokeS = this.lastDabS + (ps.strokeS - this.lastDabS) * t

        ps2.p = interp(t, 'p') as Vector4
        ps2.screenP = interp(t, 'screenP') as Vector2
        // deltas
        ps2.dp = prevps ? ps2.p.copy().sub(prevps.p) : lastps1.dp.copy()
        ps2.dScreenP = prevps ? ps2.screenP.copy().sub(prevps.screenP) : lastps1.dScreenP.copy()

        // interpolate properties
        for (const key of PaintSample.interpKeys) {
          const val = ps2[key]
          if (val instanceof Vector2 || val instanceof Vector3 || val instanceof Vector4) {
            val.load(interp(t, key) as unknown as number[])
          } else if (typeof val === 'number') {
            ;(ps2[key] as number) = interp(t, key) as number
          }
        }

        this.onBrushDab(e, ps2, true, true)
        prevps = ps2
      }
      this.lastDabS = ps.strokeS
    }

    this.lastps3 = this.lastps2
    this.lastps2 = this.lastps1
    this.lastps1 = ps
  }

  makeTask(): Generator<void, void, unknown> {
    const this2 = this

    return (function* () {
      while (this2.queue.length > 0) {
        const [e, p, pi] = this2.queue.shift()!
        const result = this2.feedTask(e, p, pi)

        // did pointermove return an asyncronous task generator?
        if (typeof result === 'object' && Symbol.iterator in result) {
          for (const step of result) {
            yield
          }
        }

        yield
      }
    })()
  }

  hasSampleDelay(): void {
    const brush = this.inputs.brush.getValue()

    let delayMode = false
    if (brush.texUser.texture) {
      const flag = brush.texUser.flag
      const mode = brush.texUser.mode

      delayMode = mode === TexUserModes.VIEW_REPEAT
      delayMode = delayMode && !!(flag & TexUserFlags.FANCY_RAKE)
    }
  }

  onBrushDab(
    e: PointerEvent,
    p: PaintSample,
    in_timer: boolean = false,
    isInterp: boolean = false
  ): undefined | ISampleViewRet {
    let x = p.screenP[0]
    let y = p.screenP[1]
    const ctx = this.modal_ctx!

    if (!ctx.object || !(ctx.object.data instanceof Mesh || ctx.object.data instanceof TetMesh)) {
      return
    }

    const toolmode = ctx.toolmode
    const view3d = ctx.view3d

    if (toolmode instanceof PaintToolModeBase) {
      // the pbvh toolmode is responsible for drawing brush circle,
      // make sure it has up to date info for that
      toolmode.mpos[0] = x
      toolmode.mpos[1] = y
    }

    const mpos = view3d.getLocalMouse(x, y)
    x = mpos[0]
    y = mpos[1]

    let pressure = 1.0

    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      pressure = e.pressure
    }

    const rendermat = view3d.activeCamera.rendermat
    const view = view3d.getViewVec(x, y)
    const origin = view3d.activeCamera.pos
    const invert = this.getInvertFromEvent(e)

    this.inputs.viewportSize.setValue(view3d.size)

    // return useful information for child class implementations
    return this.sampleViewRay(rendermat, mpos, view, origin, pressure, invert, isInterp)
  }

  getInvertFromEvent(e: PointerEvent) {
    let invert = false
    const brush = this.inputs.brush.getValue()
    const mode = brush.tool

    if (e.ctrlKey && mode !== SculptTools.PAINT && mode !== SculptTools.PAINT_SMOOTH) {
      invert = true
    }

    if (brush.flag & BrushFlags.INVERT) {
      invert = !invert
    }
    return invert
  }

  abstract initOrigData(mesh: OBDATA): AttrRef<Vector3LayerElem>
  abstract getSymflag(mesh: OBDATA): number

  sampleViewRay(
    rendermat: Matrix4,
    mpos: Vector2,
    view: IVectorOrHigher<3>,
    origin: IVectorOrHigher<3>,
    pressure: number,
    invert: boolean,
    isInterp: boolean
  ): ISampleViewRet | undefined {
    const brush = this.inputs.brush.getValue()
    const mode = brush.tool

    const ctx = this.modal_ctx!

    if (!ctx.object || !(ctx.object.data instanceof Mesh || ctx.object.data instanceof TetMesh)) {
      return undefined
    }

    /*
    let falloff = this.inputs.falloff.getValue();
    let strengthMul = falloff.integrate(1.0) - falloff.integrate(0.0);
    strengthMul = Math.abs(strengthMul !== 0.0 ? 1.0 / strengthMul : strengthMul);
    */

    const getchannel = (key: string, val: number): number => {
      const ch = brush.dynamics.getChannel(key)
      if (ch?.useDynamics) {
        return val * ch.curve.evaluate(pressure)
      } else {
        return val
      }
    }

    let radius = getchannel('radius', brush.radius)

    const toolmode = ctx.toolmode
    const view3d = ctx.view3d

    if (toolmode instanceof PaintToolModeBase) {
      toolmode._radius = radius
    }

    const ob = ctx.object
    const mesh = ob.data as OBDATA

    const sampler = this.getSampler(mesh)

    const axes: number[] = [-1] as (Number3 | -1)[]
    const sym = this.getSymflag(mesh)

    for (let i = 0; i < 3; i++) {
      if (sym & (1 << i)) {
        axes.push(i)
      }
    }

    let isect: IGenericIsect | undefined
    const obmat = ob.outputs.matrix.getValue()
    const matinv = new Matrix4(obmat)
    matinv.invert()

    origin = new Vector3(origin)
    origin.multVecMatrix(matinv)

    const view4 = new Vector4().load3(view as Vector3)
    view4[3] = 0.0
    view4.multVecMatrix(matinv)
    view = new Vector3(view4).normalize()

    for (const axis of axes) {
      let view2 = new Vector3(view)
      let origin2 = new Vector3(origin)

      if (axis !== -1) {
        origin2[axis] = -origin2[axis]!
        view2[axis] = -view2[axis]!
      }

      origin2 = new Vector3(origin2)
      view2 = new Vector3(view2)

      const isect2 = sampler.rayCast(origin2, view2)

      if (isect2 && (!isect || isect2.dis < isect.dis)) {
        isect = isect2.copy()
        origin = origin2
        view = view2
      }
    }

    const origco = new Vector4()

    if (!isect) {
      if ((this.grabMode || mode === SculptTools.GRAB || mode === SculptTools.SNAKE) && !this._first) {
        const p = new Vector3(this.last_p)
        p.multVecMatrix(obmat)

        view3d.project(p, rendermat)

        p[0] = mpos[0]
        p[1] = mpos[1]

        view3d.unproject(p, rendermat.clone().invert()!)
        p.multVecMatrix(matinv)

        const dis = p.vectorDistance(origin)

        isect = new GenericIsect()

        isect.p = p
        isect.origp = new Vector3(p)
        isect.dis = dis
        isect.tri = -1
        origco.load3(p)
        origco[3] = 1.0
      } else {
        return
      }
    } else {
      origco.load3(isect.origp)
      origco[3] = 1.0
    }

    const p3 = new Vector4().load3(isect.p)
    p3[3] = 1.0

    const matrix = new Matrix4(ob.outputs.matrix.getValue())
    p3.multVecMatrix(rendermat)

    const w = p3[3] * matrix.$matrix.m11
    if (w <= 0) return

    radius /= Math.max(view3d.glSize[0], view3d.glSize[1])
    radius *= Math.abs(w)

    const vec = new Vector3()

    if (isect.tri) {
      vec.load(isect.normal)
    } else {
      vec.load(view).normalize()
    }

    view.negate()
    if (vec.dot(view) < 0) {
      view.negate()
    }
    view.normalize()

    vec.interp(view, 1.0 - brush.normalfac).normalize()

    if (this._first) {
      this.last_mpos.load2(mpos)
      this.last_p.load(isect.p)
      this.last_origco.load(origco)
      this.last_vec.load(vec)
      this.last_radius = radius
      this._first = false

      return undefined
    }

    this._savedViewPoints.push({
      viewvec  : new Vector3(view),
      viewp    : new Vector3(origin),
      rendermat: rendermat.clone(),
      mpos     : new Vector2(mpos),
    })

    return {
      // origco/p escape this scope as part of the returned struct, so
      // they must be freshly allocated; do not try to pool these.
      origco: new Vector3(origco),
      p     : new Vector3().load3(isect.p),
      isect : isect.copy(),
      radius,
      ob,
      vec,
      mpos,
      view  : new Vector3().load3(view),
      origin: new Vector3().load3(origin),
      getchannel,
      w,
    } as ISampleViewRet
  }

  taskNext(): void {
    if (!this.task) {
      return
    }

    const time = util.time_ms()
    while (util.time_ms() - time < 45) {
      let ret: any

      try {
        ret = this.task.next()
      } catch (error) {
        util.print_stack(error as Error)
        this.task = undefined
        break
      }

      if (!ret || ret.done) {
        this.task = undefined
        break
      }
    }
  }

  modalEnd(was_cancelled: boolean): void {
    this.mfinished = true

    if (!this.modalRunning) {
      return
    }

    if (this.task) {
      //can't end modal
      console.warn('Waiting for task to finish')
      this.taskNext()

      window.setTimeout(() => {
        this.modalEnd(was_cancelled)
      }, 150)

      return
    }

    super.modalEnd(was_cancelled)

    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }

    const ctx = this.modal_ctx
    if (ctx && ctx.toolmode instanceof PaintToolModeBase) {
      //stop custom radius drawing for brush circle
      ctx.toolmode._radius = undefined
    }
  }

  on_pointerup(e: PointerEvent): void {
    this.mfinished = true
    this.modalEnd(false)
  }

  undoPre(ctx: ToolContext): void {
    throw new Error('implement me!')
  }

  calcUndoMem(ctx: ToolContext): number {
    throw new Error('implement me!')
  }

  modalStart(ctx: ViewContext) {
    this.mfinished = false

    this.lastps1 = undefined
    this.lastps2 = undefined

    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
    }

    this.timer = window.setInterval(() => this.timer_on_tick(), 5)

    this._first = true
    return super.modalStart(ctx)
  }

  undo(ctx: ToolContext): void {
    throw new Error('implement me!')
  }
}

export class MaskOpBase<Inputs extends {} = {}, Outputs extends {} = {}> extends ToolOp<Inputs, Outputs> {
  _undo: any
  rand = new util.MersenneRandom()

  constructor() {
    super()
  }

  calcUndoMem(ctx: any): number {
    const ud = this._undo

    if (ud.gridData) {
      return ud.gridData.length * 8
    }

    if (ud.vertData) {
      return ud.vertData.length * 8
    }

    return 0
  }

  undoPre(ctx: any): void {
    const mesh = ctx.mesh || ctx.tetmesh

    const ud: any = (this._undo = {mesh: -1})

    if (!mesh) {
      return
    }

    ud.mesh = mesh.lib_id

    const cd_grid = GridBase.meshGridOffset(mesh)
    let cd_mask: number

    ud.cd_grid = cd_grid

    if (cd_grid >= 0) {
      const gd: number[] = (ud.gridData = [])
      cd_mask = ud.cd_mask = mesh.loops.customData.getLayerIndex('mask')

      if (cd_mask < 0) {
        return
      }

      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid]

        for (const p of grid.points) {
          if (p.flag & MeshFlags.HIDE) {
            continue
          }

          gd.push(l.eid)
          gd.push(p.eid)
          gd.push(p.customData[cd_mask].value)
        }
      }
    } else {
      cd_mask = ud.cd_mask = mesh.verts.customData.getLayerIndex('mask')

      if (cd_mask < 0) {
        return
      }
      const vd: number[] = (ud.vertData = [])

      for (const v of mesh.verts) {
        if (v.flag & MeshFlags.HIDE) {
          continue
        }

        vd.push(v.eid)
        vd.push(v.customData[cd_mask].value)
      }
    }
  }

  undo(ctx: any): void {
    const ud = this._undo
    const mesh = ctx.datalib.get(ud.mesh)

    if (!mesh) {
      return
    }

    const cd_grid = GridBase.meshGridOffset(mesh)
    let cd_mask: number
    const cd_node = mesh.bvh ? mesh.bvh.cd_node : new AttrRef(-1)

    ud.cd_grid = cd_grid
    const updateflag = BVHFlags.UPDATE_MASK | BVHFlags.UPDATE_DRAW

    if (cd_grid >= 0) {
      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid]
        grid.regenEIDMap()
      }

      const gd = ud.gridData
      cd_mask = ud.cd_mask = mesh.loops.customData.getLayerIndex('mask')

      if (cd_mask < 0) {
        return
      }

      for (let gi = 0; gi < gd.length; gi += 3) {
        const leid = gd[gi]
        const peid = gd[gi + 1]
        const mask = gd[gi + 2]

        const l = mesh.eidMap.get(leid)
        if (!l) {
          console.error('Missing loop ' + leid)
          continue
        }

        const grid = l.customData[cd_grid]
        const eidMap = grid.getEIDMap(mesh)

        const p = eidMap.get(peid)

        if (!p) {
          console.warn('Missing grid vert:' + peid)
          continue
        }

        p.customData[cd_mask].value = mask
        p.flag |= MeshFlags.UPDATE

        if (cd_node.i >= 0) {
          const node = p.customData[cd_node.i].node

          if (node) {
            node.setUpdateFlag(updateflag)
          }
        }
      }
    } else {
      cd_mask = ud.cd_mask = mesh.verts.customData.getLayerIndex('mask')

      if (cd_mask < 0) {
        return
      }
      const vd = ud.vertData

      for (let vi = 0; vi < vd.length; vi += 2) {
        const veid = vd[vi]
        const mask = vd[vi + 1]

        const v = mesh.eidMap.get(veid)

        if (!v) {
          console.warn('Missing vertex ' + veid)
          continue
        }

        v.customData[cd_mask].value = mask
        v.flag |= MeshFlags.UPDATE

        if (cd_node.i >= 0) {
          const node = v.customData[cd_node.i].node
          if (node) {
            node.setUpdateFlag(updateflag)
          }
        }
      }
    }

    mesh.regenRender()
    mesh.graphUpdate()
    window.redraw_viewport(true)
  }

  getCDMask(mesh: Mesh | TetMesh): number {
    const cd_grid = GridBase.meshGridOffset(mesh as Mesh)

    if (cd_grid >= 0) {
      return (mesh as Mesh).loops.customData.getLayerIndex('mask')
    } else {
      return mesh.verts.customData.getLayerIndex('mask')
    }
  }

  execPre(ctx: ToolContext): void {
    this.rand.seed(0)
  }

  getVerts(mesh: Mesh | TetMesh, updateBVHNodes: boolean = true): Generator<Vertex, void, unknown> {
    const this2 = this

    const cd_node = mesh.bvh ? mesh.bvh.cd_node : new AttrRef(-1)
    const bvh = mesh.bvh ? mesh.bvh : undefined

    updateBVHNodes = updateBVHNodes && cd_node.i >= 0

    const updateflag = BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_MASK

    return (function* () {
      const cd_mask = this2.getCDMask(mesh)
      const cd_grid = GridBase.meshGridOffset(mesh as Mesh)

      if (cd_mask < 0) {
        return
      }

      if (cd_grid >= 0) {
        for (const l of mesh.loops) {
          const grid = l.customData[cd_grid]
          for (const p of grid.points) {
            yield p

            if (updateBVHNodes) {
              const node = p.customData[cd_node.i].node
              if (node) {
                node.setUpdateFlag(updateflag)
              }
            }
          }
        }
      } else {
        for (const v of mesh.verts) {
          yield v

          if (updateBVHNodes) {
            const node = v.customData[cd_node.i].node
            if (node) {
              node.setUpdateFlag(updateflag)
            }
          }
        }
      }

      mesh.regenRender()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    })()
  }
}

export class ClearMaskOp extends MaskOpBase<{value: FloatProperty}> {
  static tooldef(): any {
    return {
      uiname  : 'Clear Mask',
      toolpath: 'paint.clear_mask',
      inputs: {
        value: new FloatProperty(1.0),
      },
    }
  }

  exec(ctx: any): void {
    const mesh = ctx.mesh
    if (!mesh) {
      return
    }

    const cd_mask = this.getCDMask(mesh)
    if (cd_mask < 0) {
      return
    }

    const value = this.inputs.value.getValue()

    for (const v of this.getVerts(mesh, true)) {
      ;(v.customData[cd_mask] as unknown as {value: number}).value = value
    }
  }
}

ToolOp.register(ClearMaskOp)

export abstract class PaintOpMesh<
  Inputs extends PropertySlots = {},
  Outputs extends PropertySlots = {},
> extends PaintOpBase<Mesh, Inputs, Outputs> {
  private cachedGrid!: AttrRef<GridBase>
  private cachedOrigCo!: AttrRef<Vector3LayerElem>
  private cachedMesh!: Mesh

  protected getOrigCoCallback = (v: IBVHVertex) => {
    return this.getOrigCo(this.cachedMesh, v as Vertex, this.cachedGrid, this.cachedOrigCo)
  }

  protected updateCachedLinks(
    cachedMesh: Mesh,
    cachedGrid: AttrRef<GridBase>,
    cachedOrigCo: AttrRef<Vector3LayerElem>
  ) {
    this.cachedMesh = cachedMesh
    this.cachedGrid = cachedGrid
    this.cachedOrigCo = cachedOrigCo
  }

  getBVH(mesh: Mesh): BVH {
    const bvh = mesh.getBVH({autoUpdate: false})!
    bvh.getOrigCo = this.getOrigCoCallback
    return bvh
  }
  getSampler(mesh: Mesh) {
    return this.getBVH(mesh).sampler
  }
  getSymflag(mesh: Mesh) {
    return mesh.symFlag
  }
  abstract getOrigCo(
    mesh: Mesh,
    vertex: Vertex,
    cd_grid: AttrRef<GridBase>,
    cd_orig: AttrRef<Vector3LayerElem>
  ): Vector3

  sampleViewRay(
    rendermat: Matrix4,
    mpos: Vector2,
    view: IVectorOrHigher<3>,
    origin: IVectorOrHigher<3>,
    pressure: number,
    invert: boolean,
    isInterp: boolean
  ) {
    const ctx = this.modal_ctx!

    if (!ctx.object || !(ctx.object.data instanceof Mesh || ctx.object.data instanceof TetMesh)) {
      return
    }

    const ob = ctx.object
    const mesh = ob.data as Mesh
    const brush = this.inputs.brush.getValue()

    const haveOrigData = PaintOpBase.needOrig(brush)
    const cd_orig = haveOrigData ? this.initOrigData(mesh) : undefined
    const cd_grid = GridBase.meshGridRef(mesh)

    this.updateCachedLinks(mesh, cd_grid, cd_orig ?? new AttrRef(-1))

    return super.sampleViewRay(rendermat, mpos, view, origin, pressure, invert, isInterp)
  }
}
