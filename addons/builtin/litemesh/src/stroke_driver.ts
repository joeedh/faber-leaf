/**
 * Generic brush stroke driver: turns a stream of raw pointer events into
 * evenly-spaced PaintSample dabs along an interpolating (centripetal
 * Catmull-Rom) spline. Even spacing can be measured in screen space or world
 * space; world spacing raycasts each input point and falls back to a
 * camera-facing plane for rays that miss. The driver does NOT mirror and does
 * NOT apply dabs to geometry — a consumer pushes events, pulls ready samples on
 * its tick, and owns mirroring / yielding / dab application downstream.
 *
 * All curve/arc-length math lives in the dependency-free
 * `scripts/util/stroke_math.ts`; this file only adds raycasting, projection and
 * PaintSample construction.
 */
import {PaintSample} from './stroke_base.js'
import {Bezier} from '../../../../scripts/util/bezier.js'
import {Matrix4, Vector2, Vector3, Vector4} from '../../../../scripts/path.ux/scripts/pathux.js'
import {arcLengthWalk, crToBezier, Cubic, evalCubic, lerpV, subCubic, Vec} from '../../../../scripts/util/stroke_math.js'
import {AnchoredLiveMode, StrokeMethod} from '../../../../scripts/brush/brush_base.js'
export {AnchoredLiveMode, StrokeMethod} from '../../../../scripts/brush/brush_base.js'

/** Centripetal Catmull-Rom: no cusps/loops on clustered jittery input. */
const ALPHA = 0.5
/** Parameter half-width of the per-dab world-curve slice stored on ps.curve. */
const SLICE_HALF = 0.15

export interface StrokeInput {
  /** LOCAL view3d px — the caller has already applied getLocalMouse(). */
  x: number
  y: number
  /** 0..1; caller normalizes (mouse => 1, pen/touch => e.pressure) */
  pressure: number
  tiltX: number
  tiltY: number
  twist: number
  /** caller pre-resolves ctrlKey + BrushFlags.INVERT */
  invert: boolean
  /** shift held: poly-group "extend" (sample existing id under cursor) */
  useAltBrush: boolean
  /** ms; informational only (not used for spacing) */
  time: number
  pointerType?: string
  /** Brush params with pressure dynamics already applied by the caller
   * (StrokeDriverOp.makeParamProvider) — both the TS and the C++ driver
   * consume the same fully-resolved input. */
  radius: number
  strength: number
  spacing: number
  color: Vector4
}

export enum StrokeSpaceMode {
  SCREEN = 0,
  WORLD = 1,
}

/** Narrow adapter over View3D so the driver stays decoupled/testable. */
export interface IStrokeProjection {
  project(co: Vector4, rendermat?: Matrix4): number
  unproject(co: Vector4, irendermat?: Matrix4): number
  getViewVec(localX: number, localY: number): Vector3
  cameraPos(): Vector3
  rendermat(): Matrix4
  /** device px; used to convert a screen-px radius to world units */
  glSize(): Vector2
  size(): Vector2
  /** camera near plane; only the C++ driver needs it (it ports getViewVec
   * itself rather than calling back across the binding). */
  camNear(): number
}

/** World-space ray hit. origin/dir and p/normal are all world space. */
export interface IStrokeHit {
  p: Vector3
  normal: Vector3
  dist: number
}
export type StrokeRayCast = (origin: Vector3, dir: Vector3) => IStrokeHit | undefined

export interface StrokeParams {
  radius: number
  strength: number
  spacing: number
  color: Vector4
}
/** Lifts feedTask's getchannel(): pressure -> dynamics-resolved params. */
export type StrokeParamProvider = (pressure: number) => StrokeParams

/** The stroke-sampler surface shared by the TS and the C++-backed driver
 * (stroke_driver_native.ts), so StrokeDriverOp can hold either behind the
 * `sculptcore.cpp_stroke_driver` flag. */
export interface IBrushStrokeDriver {
  push(input: StrokeInput): void
  /** Signal pointer-up; the next poll() flushes the trailing segment. */
  end(): void
  reset(): void
  /** The dabs that became ready since the last call. */
  poll(): PaintSample[]
  /** true once end() has been called AND the trailing segment is drained */
  readonly finished: boolean
  getAnchorScreen(): Vec | undefined
  getPreviewScreen(): Vec | undefined
  /** Release engine-side resources; absent on the pure-TS driver. */
  destroy?(): void
}

export interface StrokeDriverOptions {
  projection: IStrokeProjection
  spaceMode: StrokeSpaceMode
  /** required for WORLD mode; optional for SCREEN */
  rayCast?: StrokeRayCast
  /** Object local->world matrix. When provided, emitted PaintSamples are in
   * object-local space: positions (`p`, `vieworigin`), view/normal directions
   * (`viewvec`, `viewPlane`, `vec`) and the stroke `curve` are converted, and
   * `rendermat`/`irendermat` become local->clip / clip->local so a screen-px
   * radius measured against them lands in the object's own units. The driver's
   * internal control-point / spacing / raycast math stays in world space.
   * Absent => samples stay world space (identity conversion). */
  objectMatrix?: () => Matrix4 | undefined
  /** Default StrokeMethod.PATH (unchanged arc-length walk). ANCHORED fixes the
   * dab origin on the first input and re-emits at the anchor on every later
   * input, carrying the anchor->cursor vector (ps.anchorVec) and its angle
   * (ps.liveAngle), plus a live radius (ps.radius) in AnchoredLiveMode.RADIUS.
   * DRAG_DOT follows the cursor, emitting one dab per input. Neither mode
   * arc-length-walks or spacing-gates — one input event is one dab. */
  strokeMethod?: StrokeMethod
  /** ANCHORED only: which scalar the anchor->cursor drag drives live. */
  anchoredLiveMode?: AnchoredLiveMode
  /** `params.radius` is in world units (BrushRadiusModes.WORLD) rather than
   * screen px. The driver converts at the point of use — spacing walks and the
   * anchored live radius — so a world-unit brush never gets read as pixels. */
  radiusIsWorld?: boolean
}

interface ControlPoint {
  screen: Vec // [x,y]
  world: Vec // [x,y,z]
  normal: Vec // [x,y,z]
  viewvec: Vec // [x,y,z] ray direction at this point
  hit: boolean
  pressure: number
  tiltX: number
  tiltY: number
  twist: number
  invert: boolean
  useAltBrush: boolean
  params: StrokeParams
}

export class BrushStrokeDriver implements IBrushStrokeDriver {
  opts: StrokeDriverOptions

  private inQueue: StrokeInput[] = []
  private cps: ControlPoint[] = []
  private walkCarry = 0
  private strokeS = 0
  private firstHit = false
  private lastHitWorld: Vec = [0, 0, 0]
  private prevEmitted: PaintSample | undefined
  private rawEmitted = false
  private ended = false
  private done = false
  // StrokeMethod.ANCHORED: the fixed dab origin, set on the first ingested input.
  private anchorCP: ControlPoint | undefined
  // StrokeMethod.DRAG_DOT: the live positioning-preview origin, updated on every input.
  private previewCP: ControlPoint | undefined

  private out: PaintSample[] = []
  private _rendermat = new Matrix4()
  private _irendermat = new Matrix4()
  private _view3dSize = new Vector2()
  private _tmp4 = new Vector4()
  // Object transform snapshot for the current batch (see StrokeDriverOptions
  // .objectMatrix). Identity when no object => world-space emit.
  private _iobmat = new Matrix4() // world->local
  private _iobmatDir = new Matrix4() // world->local, translation cleared (directions)
  private _localRendermat = new Matrix4() // local->clip
  private _localIrendermat = new Matrix4() // clip->local
  private _tmpV3 = new Vector3()

  constructor(opts: StrokeDriverOptions) {
    this.opts = opts
  }

  /** true once end() has been called AND the trailing segment is drained */
  get finished(): boolean {
    return this.done
  }

  /** ANCHORED only: the fixed anchor's local view3d screen position, once
   * established (undefined before the first input or outside Anchored). */
  getAnchorScreen(): Vec | undefined {
    return this.anchorCP?.screen
  }

  /** DRAG_DOT only: the live positioning-preview's local view3d screen
   * position, once established (undefined before the first input or outside
   * Drag Dot). Mirrors {@link getAnchorScreen}. */
  getPreviewScreen(): Vec | undefined {
    return this.previewCP?.screen
  }

  reset(): void {
    this.inQueue.length = 0
    this.cps.length = 0
    this.walkCarry = 0
    this.strokeS = 0
    this.firstHit = false
    this.lastHitWorld = [0, 0, 0]
    this.prevEmitted = undefined
    this.rawEmitted = false
    this.ended = false
    this.done = false
    this.anchorCP = undefined
    this.previewCP = undefined
    this.out.length = 0
  }

  /** Enqueue one raw pointer event (e.g. from on_pointermove). */
  push(input: StrokeInput): void {
    if (this.ended) {
      return
    }
    this.inQueue.push(input)
  }

  /** Signal pointer-up; the next poll() flushes the trailing segment. */
  end(): void {
    this.ended = true
  }

  /** Drain queued events through the spline and return the dabs now ready. */
  poll(): PaintSample[] {
    this.out = []

    if (this.done) {
      return this.out
    }

    // snapshot the camera transform for this batch of events
    this._rendermat.load(this.opts.projection.rendermat())
    this._view3dSize.load(this.opts.projection.size())
    this._irendermat.load(this._rendermat)
    this._irendermat.invert()

    // Snapshot the object transform (constant over a stroke); identity when no
    // object matrix, so samples stay world-space. localRendermat = local->clip so
    // the consumer can project a local point directly for its screen-px radius.
    const obmat = this.opts.objectMatrix?.()
    this._iobmat.makeIdentity()
    this._localRendermat.load(this._rendermat)
    if (obmat) {
      this._iobmat.load(obmat)
      this._iobmat.invert()
      // local->clip: obmat (local->world) must apply BEFORE the camera
      // rendermat, and Matrix4.multiply(b) composes b first, receiver second.
      this._localRendermat.load(this._rendermat)
      this._localRendermat.multiply(obmat)
    }
    this._iobmatDir.load(this._iobmat)
    this._iobmatDir.clearTranslation()
    this._localIrendermat.load(this._localRendermat)
    this._localIrendermat.invert()

    while (this.inQueue.length > 0) {
      this.ingest(this.inQueue.shift()!)
    }

    if (this.ended) {
      this.flush()
      this.done = true
    }

    return this.out
  }

  private ingest(input: StrokeInput): void {
    const proj = this.opts.projection

    const screen: Vec = [input.x, input.y]

    const vv = proj.getViewVec(screen[0], screen[1])
    const viewvec: Vec = [vv[0], vv[1], vv[2]]
    const originV3 = proj.cameraPos()
    const origin: Vec = [originV3[0], originV3[1], originV3[2]]

    const params: StrokeParams = {
      radius  : input.radius,
      strength: input.strength,
      spacing : input.spacing,
      color   : input.color,
    }
    const method = this.opts.strokeMethod ?? StrokeMethod.PATH

    let world: Vec
    let normal: Vec
    let hit = false

    if (method === StrokeMethod.ANCHORED && this.anchorCP) {
      // Grab-family drag over empty space (#35): once anchored, every later
      // input projects onto the plane through the anchor, facing the camera
      // as it was AT ANCHOR TIME (anchorCP.viewvec) rather than the live
      // surface normal — so the drag tracks the view plane, not the curved
      // (and, for Grab/Kelvinlet, actively deforming) mesh surface.
      world = this.projectOntoAnchorPlane(origin, viewvec)
      normal = this.anchorCP.viewvec.slice()
    } else {
      const r = this.opts.rayCast?.(new Vector3(origin), new Vector3(vv))
      if (r) {
        world = [r.p[0], r.p[1], r.p[2]]
        normal = [r.normal[0], r.normal[1], r.normal[2]]
        hit = true
        this.firstHit = true
        this.lastHitWorld = world.slice()
      } else if (method === StrokeMethod.ANCHORED) {
        // Anchored can't start a stroke over empty space: the first input
        // needs a real surface hit to establish the anchor.
        return
      } else if (this.firstHit) {
        // miss after a real hit: project the last hit onto the camera-facing
        // plane at the cursor (sampleViewRay grab/snake fallback)
        world = this.synthesizeMiss(screen)
        normal = viewvec.slice()
      } else if (this.opts.spaceMode === StrokeSpaceMode.SCREEN) {
        // screen-mode before any surface exists: best-effort world position
        world = [origin[0] + viewvec[0], origin[1] + viewvec[1], origin[2] + viewvec[2]]
        normal = viewvec.slice()
      } else {
        // world-mode before any hit: no plane to project onto yet, discard
        return
      }
    }

    const cp: ControlPoint = {
      screen,
      world,
      normal,
      viewvec,
      hit,
      pressure   : input.pressure,
      tiltX      : input.tiltX ?? 0,
      tiltY      : input.tiltY ?? 0,
      twist      : input.twist ?? 0,
      invert     : input.invert,
      useAltBrush: input.useAltBrush,
      params,
    }

    if (method === StrokeMethod.ANCHORED) {
      this.ingestAnchored(cp)
      return
    } else if (method === StrokeMethod.DRAG_DOT) {
      this.emitDot(cp)
      return
    }

    this.cps.push(cp)

    // first control point => one raw, non-interpolated dab
    if (!this.rawEmitted) {
      this.rawEmitted = true
      this.emitRaw(this.cps[this.cps.length - 1])
      return
    }

    // 1-segment lookahead: with a right neighbor present, the segment between
    // cps[L-3] and cps[L-2] is now fully determined
    const L = this.cps.length
    if (L >= 3) {
      this.emitSegment(L - 3, false)
    }
  }

  /** StrokeMethod.ANCHORED: fix the anchor on the first input, then emit one
   * dab per later input at the anchor, carrying the live anchor->cursor vector. */
  private ingestAnchored(cp: ControlPoint): void {
    if (!this.anchorCP) {
      this.anchorCP = cp
      this.emitAnchored(cp, cp)
      return
    }
    this.emitAnchored(this.anchorCP, cp)
  }

  private flush(): void {
    const method = this.opts.strokeMethod ?? StrokeMethod.PATH
    if (method !== StrokeMethod.PATH) {
      // ANCHORED/DRAG_DOT already emitted one dab per input; no trailing
      // spline segment to flush.
      return
    }

    const L = this.cps.length
    if (L >= 2) {
      this.emitSegment(L - 2, true)
    }
  }

  /** sampleViewRay miss trick: world point on the camera plane through last hit. */
  private synthesizeMiss(screen: Vec): Vec {
    const proj = this.opts.projection
    const p = this._tmp4
    p[0] = this.lastHitWorld[0]
    p[1] = this.lastHitWorld[1]
    p[2] = this.lastHitWorld[2]
    p[3] = 1.0

    proj.project(p, this._rendermat) // -> screen px, keeps depth in p[2]
    p[0] = screen[0]
    p[1] = screen[1]
    proj.unproject(p, this._irendermat)

    return [p[0], p[1], p[2]]
  }

  private emitRaw(cp: ControlPoint): void {
    const ps = this.makeSample(cp.world, cp.screen, cp, cp, 0, cp.normal, cp.hit)
    ps.isInterp = false
    ps.strokeS = this.strokeS
    ps.dstrokeS = 0
    ps.angle = 0
    ps.futureAngle = 0
    ps.curve = undefined

    this.prevEmitted = ps
    this.out.push(ps)
  }

  /** StrokeMethod.ANCHORED: a dab centered on `anchor`, carrying the live
   * anchor->cur vector (ps.anchorVec) and the cursor angle (ps.liveAngle);
   * anchoredLiveMode additionally maps the screen-space drag length onto the
   * radius. Not arc-length walked — one input is one dab. */
  private emitAnchored(anchor: ControlPoint, cur: ControlPoint): void {
    const ps = this.makeSample(anchor.world, anchor.screen, anchor, anchor, 0, anchor.normal, anchor.hit)
    ps.isInterp = false
    ps.strokeS = this.strokeS
    ps.dstrokeS = 0
    ps.curve = undefined

    const worldVec: Vec = [
      cur.world[0] - anchor.world[0],
      cur.world[1] - anchor.world[1],
      cur.world[2] - anchor.world[2],
    ]
    const localVec = this.toLocalDir(worldVec)
    ps.anchorVec[0] = localVec[0]
    ps.anchorVec[1] = localVec[1]
    ps.anchorVec[2] = localVec[2]

    const dx = cur.screen[0] - anchor.screen[0]
    const dy = cur.screen[1] - anchor.screen[1]

    // The brush angle tracks the cursor in *both* live modes; the mode only
    // decides whether the drag length also drives the radius.
    ps.liveAngle = Math.atan2(dy, dx)

    if ((this.opts.anchoredLiveMode ?? AnchoredLiveMode.RADIUS) !== AnchoredLiveMode.ANGLE) {
      const dragPx = Math.sqrt(dx * dx + dy * dy)
      if (dragPx > 1e-5) {
        // ps.radius rides in the brush's own unit (see resolveWorldRadius).
        ps.radius = this.opts.radiusIsWorld ? this.worldRadiusAt(anchor.world, dragPx) : dragPx
      }
    }

    this.prevEmitted = ps
    this.out.push(ps)
  }

  /** StrokeMethod.DRAG_DOT: one dab centered on the live cursor per input. */
  private emitDot(cp: ControlPoint): void {
    const ps = this.makeSample(cp.world, cp.screen, cp, cp, 0, cp.normal, cp.hit)
    ps.isInterp = false
    ps.strokeS = this.strokeS
    ps.dstrokeS = 0
    ps.angle = 0
    ps.futureAngle = 0
    ps.curve = undefined

    this.previewCP = cp
    this.prevEmitted = ps
    this.out.push(ps)
  }

  private emitSegment(i: number, rightClamp: boolean): void {
    const cps = this.cps
    const p1 = cps[i]
    const p2 = cps[i + 1]
    const p0 = i > 0 ? cps[i - 1] : p1
    const p3 = rightClamp ? p2 : cps[i + 2]

    const screenB = crToBezier(p0.screen, p1.screen, p2.screen, p3.screen, ALPHA)
    const worldB = crToBezier(p0.world, p1.world, p2.world, p3.world, ALPHA)

    const spacing = p2.params.spacing
    const radius = p2.params.radius

    let drivingB: Cubic
    let spacingDist: number
    if (this.opts.spaceMode === StrokeSpaceMode.WORLD) {
      drivingB = worldB
      const worldRadius = this.opts.radiusIsWorld ? radius : this.worldRadiusAt(evalCubic(worldB, 0.5), radius)
      spacingDist = Math.max(spacing * 2 * worldRadius, 1e-5)
    } else {
      drivingB = screenB
      // A world-unit radius must resolve to px before driving the screen walk,
      // or sub-pixel spacing floods the stroke with dabs.
      const radiusPx = this.opts.radiusIsWorld ? this.screenRadiusAt(evalCubic(worldB, 0.5), radius) : radius
      spacingDist = Math.max(spacing * 2 * radiusPx, 1e-5)
    }

    const walk = arcLengthWalk(drivingB, spacingDist, this.walkCarry)
    this.walkCarry = walk.carryOut

    for (const t of walk.ts) {
      const worldP = evalCubic(worldB, t)
      const screenP = evalCubic(screenB, t)
      const normalP = lerpV(p1.normal, p2.normal, t)
      const hit = t < 0.5 ? p1.hit : p2.hit

      const ps = this.makeSample(worldP, screenP, p1, p2, t, normalP, hit)
      ps.isInterp = true

      this.strokeS += spacing
      ps.strokeS = this.strokeS
      ps.dstrokeS = spacing

      const prev = this.prevEmitted
      if (prev) {
        ps.dScreenP[0] = ps.screenP[0] - prev.screenP[0]
        ps.dScreenP[1] = ps.screenP[1] - prev.screenP[1]
        ps.dp[0] = ps.p[0] - prev.p[0]
        ps.dp[1] = ps.p[1] - prev.p[1]
        ps.dp[2] = ps.p[2] - prev.p[2]
        ps.angle = Math.atan2(ps.dScreenP[1], ps.dScreenP[0])
        prev.futureAngle = ps.angle
      }

      const slice = subCubic(worldB, t - SLICE_HALF, t + SLICE_HALF)
      // Convert the per-dab curve slice to object-local (no-op without an object
      // matrix) so ps.curve matches the rest of the local-space sample.
      ps.curve = new Bezier(
        this.toLocal(slice[0]),
        this.toLocal(slice[1]),
        this.toLocal(slice[2]),
        this.toLocal(slice[3])
      ).createQuads()
      ps.futureAngle = ps.angle

      this.prevEmitted = ps
      this.out.push(ps)
    }
  }

  /** Screen-px radius -> world units at a world point (sampleViewRay ~1336-1340). */
  private worldRadiusAt(worldP: Vec, radiusPx: number): number {
    const proj = this.opts.projection
    const p = this._tmp4
    p[0] = worldP[0]
    p[1] = worldP[1]
    p[2] = worldP[2]
    p[3] = 1.0
    const w = proj.project(p, this._rendermat)
    const gl = proj.glSize()
    return (radiusPx / Math.max(gl[0], gl[1])) * Math.abs(w)
  }

  /** Inverse of worldRadiusAt: world-unit radius -> screen px at a world point. */
  private screenRadiusAt(worldP: Vec, worldRadius: number): number {
    const worldPerPx = this.worldRadiusAt(worldP, 1)
    return worldRadius / Math.max(worldPerPx, 1e-12)
  }

  /** World point -> object-local point via the batch's world->local snapshot
   * (identity when no object matrix). */
  private toLocal(p: Vec | Vector3): Vec {
    this._tmpV3[0] = p[0] as number
    this._tmpV3[1] = p[1] as number
    this._tmpV3[2] = p[2] as number
    this._tmpV3.multVecMatrix(this._iobmat)
    return [this._tmpV3[0], this._tmpV3[1], this._tmpV3[2]]
  }

  /** World direction -> object-local direction (translation-free; identity
   * when no object matrix). Used for the Anchored drag vector. */
  private toLocalDir(v: Vec): Vec {
    this._tmpV3[0] = v[0]
    this._tmpV3[1] = v[1]
    this._tmpV3[2] = v[2]
    this._tmpV3.multVecMatrix(this._iobmatDir)
    return [this._tmpV3[0], this._tmpV3[1], this._tmpV3[2]]
  }

  /** ANCHORED, post-anchor: intersect the current view ray with the plane
   * through anchorCP.world, facing the camera as it was at anchor time
   * (anchorCP.viewvec as the plane normal). Degenerate (ray parallel to the
   * plane) falls back to the anchor position itself. */
  private projectOntoAnchorPlane(origin: Vec, viewvec: Vec): Vec {
    const anchor = this.anchorCP!
    const n = anchor.viewvec
    const denom = viewvec[0] * n[0] + viewvec[1] * n[1] + viewvec[2] * n[2]
    if (Math.abs(denom) > 1e-7) {
      const d =
        (anchor.world[0] - origin[0]) * n[0] +
        (anchor.world[1] - origin[1]) * n[1] +
        (anchor.world[2] - origin[2]) * n[2]
      const s = d / denom
      return [origin[0] + viewvec[0] * s, origin[1] + viewvec[1] * s, origin[2] + viewvec[2] * s]
    }
    return anchor.world.slice()
  }

  /** Fill the position / view / interpolated-param fields of a PaintSample. */
  private makeSample(
    worldP: Vec,
    screenP: Vec,
    cpA: ControlPoint,
    cpB: ControlPoint,
    t: number,
    normalP: Vec,
    hit: boolean
  ): PaintSample {
    const proj = this.opts.projection
    const ps = new PaintSample()

    const p = this._tmp4
    p[0] = worldP[0]
    p[1] = worldP[1]
    p[2] = worldP[2]
    p[3] = 1.0
    // World projection w (depth/scale hint); kept as-is regardless of space.
    const w = proj.project(p, this._rendermat)

    // position: world -> object-local (point)
    const lp = this.toLocal(worldP)
    ps.p[0] = lp[0]
    ps.p[1] = lp[1]
    ps.p[2] = lp[2]
    ps.p[3] = w
    ps.w = w
    ps.screenP[0] = screenP[0]
    ps.screenP[1] = screenP[1]

    // surface normal + view ray: world -> local through the translation-free
    // inverse (directions must not pick up the object translation), then
    // re-normalized (the inverse scale changes their length).
    setNorm(ps.vec, normalP)
    ps.vec.multVecMatrix(this._iobmatDir)
    ps.vec.normalize()
    const viewvec = lerpV(cpA.viewvec, cpB.viewvec, t)
    setNorm(ps.viewvec, viewvec)
    ps.viewvec.multVecMatrix(this._iobmatDir)
    ps.viewvec.normalize()
    setNorm(ps.viewPlane, viewvec)
    ps.viewPlane.multVecMatrix(this._iobmatDir)
    ps.viewPlane.normalize()

    // camera origin: world -> local (point)
    const lo = this.toLocal(proj.cameraPos())
    ps.vieworigin[0] = lo[0]
    ps.vieworigin[1] = lo[1]
    ps.vieworigin[2] = lo[2]
    // local->clip / clip->local so the consumer's screen-px radius is in local units
    ps.rendermat.load(this._localRendermat)
    ps.irendermat.load(this._localIrendermat)
    ps.view3dSize.load(this._view3dSize)

    ps.radius = lerpNum(cpA.params.radius, cpB.params.radius, t)
    ps.strength = lerpNum(cpA.params.strength, cpB.params.strength, t)
    ps.pressure = lerpNum(cpA.pressure, cpB.pressure, t)
    ps.tiltX = lerpNum(cpA.tiltX, cpB.tiltX, t)
    ps.tiltY = lerpNum(cpA.tiltY, cpB.tiltY, t)
    ps.twist = lerpNum(cpA.twist, cpB.twist, t)
    ps.invert = t < 0.5 ? cpA.invert : cpB.invert
    ps.useAltBrush = t < 0.5 ? cpA.useAltBrush : cpB.useAltBrush
    ps.color.load(cpA.params.color).interp(cpB.params.color, t)
    ps.hit = hit

    return ps
  }
}

function setNorm(out: Vector3, v: Vec): void {
  out[0] = v[0]
  out[1] = v[1]
  out[2] = v[2]
  out.normalize()
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
