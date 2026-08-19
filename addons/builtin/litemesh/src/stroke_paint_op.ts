/**
 * Modal ToolOp base that drives a brush stroke through `BrushStrokeDriver`
 * (stroke_driver.ts) instead of the legacy queue/timer/feedTask machinery in
 * `PaintOpBase`. It owns the projection / param / raycast adapters over View3D
 * and the modal pointer plumbing; subclasses implement `applyDab` (apply one
 * evenly-spaced PaintSample to their geometry) and `makeRayCast` (so the driver
 * can place control points in world space). Mirroring, undo logging and the
 * actual dab application all stay in the subclass — this base is purely the
 * input → evenly-spaced-sample pipeline.
 */
import * as util from '../../../../scripts/util/util.js'
import type {ToolContext, ViewContext} from '../../../../scripts/core/context.js'
import {BrushProperty, PaintSample, PaintSampleProperty, PaintToolModeBase} from './stroke_base.js'
import {BrushFlags, BrushRadiusModes, SculptTools} from '../../../../scripts/brush/index'
import {
  AnchoredLiveMode,
  BrushStrokeDriver,
  IBrushStrokeDriver,
  IStrokeProjection,
  StrokeInput,
  StrokeMethod,
  StrokeParamProvider,
  StrokeParams,
  StrokeRayCast,
  StrokeSpaceMode,
} from './stroke_driver.js'
import {NativeStrokeDriver} from './stroke_driver_native.js'
import {FeatureFlags} from '../../../../scripts/core/feature-flag'
import {getWasmImmediate} from '@sculptcore/api/api'

import {
  Curve1DProperty,
  Vec2Property,
  FlagProperty,
  keymap,
  Mat4Property,
  Matrix4,
  ToolOp,
  PropertySlots,
} from '../../../../scripts/path.ux/scripts/pathux.js'

export abstract class StrokeDriverOp<
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
  driver: IBrushStrokeDriver | undefined
  /** Pressure->params resolver, built once per stroke in modalStart. */
  paramProvider: StrokeParamProvider | undefined
  mfinished = false
  timer: number | undefined
  /** most recent raw pointer event; supplies modifiers/pressure to applyDab */
  lastEvent: PointerEvent | undefined

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

  /** Apply one evenly-spaced dab to the subclass's geometry. */
  abstract applyDab(ctx: ToolContext | ViewContext, ps: PaintSample, e: PointerEvent): void
  /** World-space ray cast used to place the driver's control points (and, in
   * WORLD space mode, to measure spacing). Return undefined to run screen-only. */
  abstract makeRayCast(): StrokeRayCast | undefined

  /** Override to drive even spacing in world units instead of screen pixels. */
  getSpaceMode(): StrokeSpaceMode {
    return StrokeSpaceMode.SCREEN
  }

  /** Override to switch the driver off the default arc-length Path walk onto
   * StrokeMethod.ANCHORED or .DRAG_DOT. */
  getStrokeMethod(): StrokeMethod {
    return StrokeMethod.PATH
  }

  /** ANCHORED only: which scalar the anchor->cursor drag drives live. */
  getAnchoredLiveMode(): AnchoredLiveMode {
    return AnchoredLiveMode.RADIUS
  }

  /** Object local->world matrix so the driver emits object-local PaintSamples
   * (positions + view vectors in the sculpt mesh's own space). Return undefined
   * to keep samples in world space (the default). */
  getObjectMatrix(): Matrix4 | undefined {
    return undefined
  }

  getInvertFromEvent(e: PointerEvent): boolean {
    let invert = false
    const brush = this.inputs.brush.getValue()
    const mode = brush.tool

    if (
      e.ctrlKey &&
      mode !== SculptTools.PAINT &&
      mode !== SculptTools.PAINT_SMOOTH &&
      mode !== SculptTools.POLYGROUP
    ) {
      invert = true
    }
    if (brush.flag & BrushFlags.INVERT) {
      invert = !invert
    }
    return invert
  }

  getPressure(e: PointerEvent): number {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      return e.pressure
    }
    return 1.0
  }

  toStrokeInput(e: PointerEvent): StrokeInput {
    const twistE = e as PointerEvent & {twist?: number}
    // Poly-group "extend" is on ctrl (shift smooths instead, see sculptcore
    // on_mousedown); every other brush uses shift for its alt path.
    const isPolyGroup = this.inputs.brush.getValue().tool === SculptTools.POLYGROUP
    const pressure = this.getPressure(e)
    // Both drivers take LOCAL view3d px and already-resolved params, so the
    // parity test can feed them the same StrokeInput.
    const local = this.modal_ctx!.view3d.getLocalMouse(e.x, e.y)
    const params = (this.paramProvider ?? this.makeParamProvider())(pressure)
    return {
      ...params,
      x: local[0],
      y: local[1],
      pressure,
      tiltX      : e.tiltX,
      tiltY      : e.tiltY,
      twist      : twistE.twist ?? 0.0,
      invert     : this.getInvertFromEvent(e),
      useAltBrush: isPolyGroup ? e.ctrlKey : e.shiftKey,
      time       : util.time_ms(),
      pointerType: e.pointerType,
    }
  }

  /** Lifts feedTask's getchannel(): pressure -> dynamics-resolved brush params. */
  makeParamProvider(): StrokeParamProvider {
    const brush = this.inputs.brush.getValue()
    return (pressure: number): StrokeParams => {
      const getchannel = (key: string, val: number): number => {
        const ch = brush.dynamics.getChannel(key)
        if (ch?.useDynamics) {
          return val * ch.curve.evaluate(pressure)
        }
        return val
      }
      return {
        radius  : getchannel('radius', brush.radius),
        strength: getchannel('strength', brush.strength),
        spacing : getchannel('spacing', brush.spacing),
        color   : brush.color,
      }
    }
  }

  makeProjection(): IStrokeProjection {
    const view3d = this.modal_ctx!.view3d
    return {
      project   : (co, mat) => view3d.project(co, mat),
      unproject : (co, imat) => view3d.unproject(co, imat),
      getViewVec: (x, y) => view3d.getViewVec(x, y),
      cameraPos : () => view3d.activeCamera.pos,
      rendermat : () => view3d.activeCamera.rendermat,
      glSize    : () => view3d.glSize,
      size      : () => view3d.size!,
      camNear   : () => view3d.activeCamera.near,
    }
  }

  /** Bound `sculptcore::spatial::SpatialTree` for the geometry under the
   * stroke. Undefined (the default) means the C++ driver has nothing to
   * raycast, so the TS driver is used regardless of the feature flag. */
  getSpatialTree(): unknown | undefined {
    return undefined
  }

  /** Pick the C++ sampler when `sculptcore.cpp_stroke_driver` is on and the
   * subclass can hand it a spatial tree; otherwise the TS one. */
  makeDriver(useCpp: boolean = FeatureFlags.get('sculptcore.cpp_stroke_driver')): IBrushStrokeDriver {
    const radiusIsWorld = this.inputs.brush.getValue().radiusMode === BrushRadiusModes.WORLD
    const wasm = getWasmImmediate()
    const spatial = wasm && useCpp ? this.getSpatialTree() : undefined

    if (wasm && spatial !== undefined) {
      return new NativeStrokeDriver({
        wasm,
        spatial,
        projection      : this.makeProjection(),
        spaceMode       : this.getSpaceMode(),
        objectMatrix    : () => this.getObjectMatrix(),
        strokeMethod    : this.getStrokeMethod(),
        anchoredLiveMode: this.getAnchoredLiveMode(),
        radiusIsWorld,
      })
    }

    return new BrushStrokeDriver({
      projection      : this.makeProjection(),
      spaceMode       : this.getSpaceMode(),
      rayCast         : this.makeRayCast(),
      objectMatrix    : () => this.getObjectMatrix(),
      strokeMethod    : this.getStrokeMethod(),
      anchoredLiveMode: this.getAnchoredLiveMode(),
      radiusIsWorld,
    })
  }

  modalStart(ctx: ViewContext): any {
    this.mfinished = false
    this.lastEvent = undefined

    this.paramProvider = this.makeParamProvider()
    this.driver = this.makeDriver()

    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
    }
    this.timer = window.setInterval(() => this.timer_on_tick(), 5)

    return super.modalStart(ctx)
  }

  timer_on_tick(): void {
    if (!this.modalRunning) {
      if (this.timer !== undefined) {
        window.clearInterval(this.timer)
        this.timer = undefined
      }
      return
    }
    this.flushDriver()
  }

  /** Drain whatever dabs the driver has ready and apply each one. */
  flushDriver(): void {
    const driver = this.driver
    const e = this.lastEvent
    if (!driver || !e) {
      return
    }
    for (const ps of driver.poll()) {
      this.inputs.samples.push(ps)
      this.applyDab(this.modal_ctx!, ps, e)
    }
  }

  on_pointermove(e: PointerEvent): void {
    if (this.mfinished || !this.driver) {
      return //wait for modalEnd
    }
    this.lastEvent = e
    this.driver.push(this.toStrokeInput(e))
  }

  on_pointerup(e: PointerEvent): void {
    this.lastEvent = e ?? this.lastEvent
    this.driver?.end()
    this.flushDriver() // synchronously apply the trailing segment
    this.mfinished = true
    this.modalEnd(false)
  }

  on_keydown(e: KeyboardEvent): void {
    switch (e.keyCode) {
      case keymap['Escape']:
        this.driver?.reset()
        this.modalEnd(true)
        break
      case keymap['Enter']:
      case keymap['Space']:
        this.driver?.end()
        this.flushDriver()
        this.modalEnd(false)
        break
    }
  }

  modalEnd(was_cancelled: boolean): any {
    this.mfinished = true
    // Drop the reference as well as the native object: the brush-cursor overlay
    // reads `toolstack.head.driver` after the stroke (sculptcore.ts drawBrush),
    // and calling a disposed NativeStrokeDriver hands C++ a null `this`.
    this.driver?.destroy?.()
    this.driver = undefined

    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }

    const ctx = this.modal_ctx
    if (ctx && ctx.toolmode instanceof PaintToolModeBase) {
      // stop custom radius drawing for the brush circle
      ctx.toolmode._radius = undefined
    }

    return super.modalEnd(was_cancelled)
  }
}
