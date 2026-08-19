/**
 * `IBrushStrokeDriver` backed by sculptcore's C++ sampler
 * (`sculptcore/source/brush/stroke_driver.{h,cc}`) instead of the TypeScript
 * one in `stroke_driver.ts`. The engine owns the spline, the arc-length walk
 * and the per-input raycast (it holds the `SpatialTree` directly), so this file
 * is only marshalling: push the camera/object snapshot before each poll, feed
 * fully-resolved `StrokeInput`s across, and convert each emitted `DabSample`
 * back into a real `PaintSample` so everything downstream (SculptPaintOp,
 * `inputs.samples` serialization, undo replay) is untouched.
 *
 * Selected by the `sculptcore.cpp_stroke_driver` feature flag; the TS driver
 * stays the default and the two are gated by
 * `tests/integration/stroke_driver_parity.test.ts`.
 */
import type {BrushStrokeDriver as WasmStrokeDriver} from '@sculptcore/api/sculptcore/brush/BrushStrokeDriver'
import type {DabSample} from '@sculptcore/api/sculptcore/brush/DabSample'
import {IWasmInterface} from '@sculptcore/api/api'
import {StructType} from '@litestl/typescript-runtime'
import {Bezier} from '../../../../scripts/util/bezier.js'
import {Matrix4, Vector3} from '../../../../scripts/path.ux/scripts/pathux.js'
import {PaintSample} from './stroke_base.js'
import {IBrushStrokeDriver, IStrokeProjection, StrokeInput, StrokeSpaceMode} from './stroke_driver.js'
import {Vec} from '../../../../scripts/util/stroke_math.js'
import {AnchoredLiveMode, StrokeMethod} from '../../../../scripts/brush/brush_base.js'

export interface NativeStrokeDriverOptions {
  wasm: IWasmInterface
  /** Bound `sculptcore::spatial::SpatialTree` (LiteMesh.spatial). */
  spatial: unknown
  projection: IStrokeProjection
  spaceMode: StrokeSpaceMode
  /** Object local->world; absent => samples stay world space. */
  objectMatrix?: () => Matrix4 | undefined
  strokeMethod?: StrokeMethod
  anchoredLiveMode?: AnchoredLiveMode
  radiusIsWorld?: boolean
}

/** Bound float2/float3/float4 wrappers expose their storage as `.vec`. */
interface BoundVec {
  vec: ArrayLike<number>
}

export class NativeStrokeDriver implements IBrushStrokeDriver {
  private opts: NativeStrokeDriverOptions
  private driver: WasmStrokeDriver
  private ended = false
  private done = false
  /** Once disposed the bound object's pointer is null; every entry point below
   * has to no-op rather than call into C++ with a null `this`. */
  private destroyed = false
  private _tmpMat = new Matrix4()

  constructor(opts: NativeStrokeDriverOptions) {
    this.opts = opts

    const st = opts.wasm.manager.get('sculptcore::brush::BrushStrokeDriver') as StructType
    const ctor = st.findConstructor('main')!
    this.driver = opts.wasm.manager.constructWith(ctor, opts.spatial) as WasmStrokeDriver

    this.driver.spaceMode = opts.spaceMode as unknown as WasmStrokeDriver['spaceMode']
    this.driver.strokeMethod = (opts.strokeMethod ?? StrokeMethod.PATH) as unknown as WasmStrokeDriver['strokeMethod']
    this.driver.anchoredLiveMode = (opts.anchoredLiveMode ??
      AnchoredLiveMode.RADIUS) as unknown as WasmStrokeDriver['anchoredLiveMode']
    this.driver.radiusIsWorld = opts.radiusIsWorld ?? false
  }

  get finished(): boolean {
    return this.done || this.destroyed
  }

  /** Release the bound object (WASM only; native GC-finalizes its wrapper).
   * Idempotent — modalEnd can run more than once per stroke. */
  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.done = true
    ;(this.driver as unknown as {[Symbol.dispose]?: () => void})[Symbol.dispose]?.()
  }

  push(input: StrokeInput): void {
    if (this.ended || this.destroyed) {
      return
    }
    this.driver.pushColor(input.color[0], input.color[1], input.color[2], input.color[3])
    this.driver.push(
      input.x,
      input.y,
      input.pressure,
      input.tiltX ?? 0,
      input.tiltY ?? 0,
      input.twist ?? 0,
      input.invert,
      input.useAltBrush,
      input.radius,
      input.strength,
      input.spacing
    )
  }

  end(): void {
    this.ended = true
  }

  reset(): void {
    if (this.destroyed) {
      return
    }
    this.driver.reset()
    this.ended = false
    this.done = false
  }

  poll(): PaintSample[] {
    const out: PaintSample[] = []
    if (this.done || this.destroyed) {
      return out
    }

    this.pushView()
    if (this.ended) {
      this.driver.end()
    }

    const n = this.driver.poll()
    for (let i = 0; i < n; i++) {
      const dab = this.driver.sampleAt(i)
      if (dab) {
        out.push(this.toPaintSample(dab))
      }
    }

    if (this.ended) {
      this.done = true
    }
    return out
  }

  getAnchorScreen(): Vec | undefined {
    if (this.destroyed || !this.driver.hasAnchorScreen()) {
      return undefined
    }
    return [this.driver.anchorScreenX(), this.driver.anchorScreenY()]
  }

  getPreviewScreen(): Vec | undefined {
    if (this.destroyed || !this.driver.hasPreviewScreen()) {
      return undefined
    }
    return [this.driver.previewScreenX(), this.driver.previewScreenY()]
  }

  /** Camera/object snapshot for this batch; mirrors the TS driver's poll()
   * preamble (stroke_driver.ts) but pushed row-by-row across the binding. */
  private pushView(): void {
    const proj = this.opts.projection
    const obmat = this.opts.objectMatrix?.()

    this.setMatrix(0, proj.rendermat())
    this.setMatrix(1, obmat ?? this._tmpMat.makeIdentity())

    const cam = proj.cameraPos()
    const size = proj.size()
    const gl = proj.glSize()
    this.driver.setViewParams(
      cam[0],
      cam[1],
      cam[2],
      size[0],
      size[1],
      gl[0],
      gl[1],
      this.opts.projection.camNear(),
      obmat !== undefined
    )
  }

  private setMatrix(matId: number, mat: Matrix4): void {
    const m = mat.getAsArray()
    for (let row = 0; row < 4; row++) {
      this.driver.setViewRow(matId, row, m[row * 4], m[row * 4 + 1], m[row * 4 + 2], m[row * 4 + 3])
    }
  }

  private toPaintSample(dab: DabSample): PaintSample {
    const ps = new PaintSample()
    const p = (dab.p as unknown as BoundVec).vec
    const dp = (dab.dp as unknown as BoundVec).vec
    const screenP = (dab.screenP as unknown as BoundVec).vec
    const dScreenP = (dab.dScreenP as unknown as BoundVec).vec

    for (let i = 0; i < 4; i++) {
      ps.p[i] = p[i]
      ps.dp[i] = dp[i]
    }
    for (let i = 0; i < 2; i++) {
      ps.screenP[i] = screenP[i]
      ps.dScreenP[i] = dScreenP[i]
    }
    loadVec3(ps.vec, dab.vec)
    loadVec3(ps.viewvec, dab.viewvec)
    loadVec3(ps.vieworigin, dab.vieworigin)
    loadVec3(ps.viewPlane, dab.viewPlane)
    loadVec3(ps.anchorVec, dab.anchorVec)
    const color = (dab.color as unknown as BoundVec).vec
    for (let i = 0; i < 4; i++) {
      ps.color[i] = color[i]
    }

    ps.strokeS = dab.strokeS
    ps.dstrokeS = dab.dstrokeS
    ps.isInterp = dab.isInterp
    ps.angle = dab.angle
    ps.futureAngle = dab.futureAngle
    ps.strength = dab.strength
    ps.radius = dab.radius
    ps.w = dab.w
    ps.invert = dab.invert
    ps.pressure = dab.pressure
    ps.hit = dab.hit
    ps.useAltBrush = dab.useAltBrush
    ps.liveAngle = dab.liveAngle
    ps.tiltX = dab.tiltX
    ps.tiltY = dab.tiltY
    ps.twist = dab.twist

    // The per-batch view state lives on the driver, not on every dab.
    this.loadMatrixFrom(0, ps.rendermat)
    this.loadMatrixFrom(1, ps.irendermat)
    ps.view3dSize[0] = this.driver.viewSizeX()
    ps.view3dSize[1] = this.driver.viewSizeY()

    ps.curve = dab.hasCurve
      ? new Bezier(toVec(dab.curve0), toVec(dab.curve1), toVec(dab.curve2), toVec(dab.curve3)).createQuads()
      : undefined

    return ps
  }

  /** matId 0 = localRendermat (local->clip), 1 = localIrendermat. */
  private loadMatrixFrom(matId: number, out: Matrix4): void {
    const m = out.$matrix
    const g = (row: number, col: number): number => this.driver.getMatrixElem(matId, row, col)
    m.m11 = g(0, 0)
    m.m12 = g(0, 1)
    m.m13 = g(0, 2)
    m.m14 = g(0, 3)
    m.m21 = g(1, 0)
    m.m22 = g(1, 1)
    m.m23 = g(1, 2)
    m.m24 = g(1, 3)
    m.m31 = g(2, 0)
    m.m32 = g(2, 1)
    m.m33 = g(2, 2)
    m.m34 = g(2, 3)
    m.m41 = g(3, 0)
    m.m42 = g(3, 1)
    m.m43 = g(3, 2)
    m.m44 = g(3, 3)
  }
}

function loadVec3(out: Vector3, src: unknown): void {
  const v = (src as BoundVec).vec
  out[0] = v[0]
  out[1] = v[1]
  out[2] = v[2]
}

function toVec(src: unknown): Vector3 {
  const v = (src as BoundVec).vec
  return new Vector3([v[0], v[1], v[2]])
}
