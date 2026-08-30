import {CommandExecutor, MeshLog, Brush as WasmBrush, BrushProgram, DynTopoParams} from '@sculptcore/api'
import type {ToolContext, ViewContext} from '../../../../scripts/core/context'
import {LiteMesh, LiteMeshDisplayMode} from './index'
import {Matrix4, Vector2, Vector3, Vector4} from '../../../../scripts/path.ux/pathux'
import {StrokeDriverOp} from './stroke_paint_op'
import {AnchoredLiveMode, IStrokeHit, StrokeInput, StrokeRayCast, StrokeSpaceMode} from './stroke_driver'
import type {SculptCorePaintMode} from './sculptcore'
import {getWasmImmediate} from '@sculptcore/api/api'
import {DefaultBrushes, type SculptBrush} from '../../../../scripts/brush/index'
import {
  builSculptcoreBrush,
  toolToSculptBrush,
  buildBrushProgram,
  pushBrushDeviceInputs,
  configureDynTopoParams,
  resolveDabPolicy,
} from './sculptcore_bindings'
import type {SculptBrushes} from '@sculptcore/api/sculptcore/brush/SculptBrushes'
import {
  BrushFlags,
  DynTopoEdgeModeSC,
  DynTopoFlagsSC,
  SculptTools,
  StrokeMethod,
  resolvePlaneDabNormal,
} from '../../../../scripts/brush/brush_base'
import {PaintSample, SymAxisMap} from './stroke_base.js'
import type {View3D} from '../../../../scripts/editors/view3d/view3d'
import {view3dProject, view3dUnproject} from '../../../../scripts/editors/view3d/view3d_base'
import {FeatureFlags, getAppState, peekAppState} from '@framework/api'
import {GpuStrokeController} from './sculptcore_gpu_stroke'

/** Vert page-spread ratio above which the opt-in stroke-end auto-defrag
 * (`sculptcore.auto_defrag`) compacts the mesh layout. 1.0 = perfectly compact. */
const AUTO_DEFRAG_VERT_RATIO = 3.0

export interface IGetBrushRet {
  brush: SculptBrush
  wasmExec: CommandExecutor
  wasmBrush: WasmBrush
}

/**
 * "Show what you paint": switch the LiteMesh surface display to the attribute
 * the active attribute-brush writes (color → vertex color, polygroup → poly
 * groups), so painted results are visible without manually toggling the ObData
 * display mode. Sculpting brushes (draw/smooth/…) leave the display untouched.
 * No-op when the display is already in the right mode (the setter dirties every
 * GPU node, so we guard against re-running it each dab).
 */
function syncDisplayModeToBrush(mesh: LiteMesh, tool: SculptTools): void {
  // displayColorMode is a bitmask, so OR the relevant overlay on without
  // disturbing any other enabled overlay (the user may want both at once).
  let bit = 0
  if (tool === SculptTools.COLOR) {
    bit = LiteMeshDisplayMode.VERTEX_COLOR
  } else if (tool === SculptTools.POLYGROUP) {
    bit = LiteMeshDisplayMode.POLY_GROUP
  }
  if (bit !== 0 && (mesh.displayColorMode & bit) === 0) {
    mesh.displayColorMode = mesh.displayColorMode | bit
  }
}

export class SculptPaintOp extends StrokeDriverOp<{}, {}> {
  wasmBrush?: WasmBrush
  executor?: CommandExecutor
  brushProgram?: BrushProgram
  /** Reused per-stroke dyntopo params handle (rebuilt fields each dab). */
  dynTopoParams?: DynTopoParams
  /** Deterministic per-dab seed for dyntopo's independent-set selection. */
  dabSeed = 1
  /** Stroke arc-length (ps.strokeS) at which dyntopo last remeshed. Dyntopo runs
   * at its own `dynTopoSpacing`, not every dab; -Infinity makes the first dab
   * always remesh. */
  lastDynTopoS = -Infinity
  /** Whether the current stroke sample is a dyntopo-remesh sample. Decided once
   * on the primary dab (mirrorIdx 0) and reused by every mirror image so all
   * sides of a symmetric stroke remesh together (#38). */
  _dabDynTopoDue = false
  /** One add-a-level clamp note per stroke (X3 stage 4 VDM routing). */
  _vdmClampNoted = false
  /** Poly-group id for the active stroke (computed once on the first dab:
   * a fresh maxFaceGroup()+1, or the sampled id under the cursor with shift). */
  strokeGroupId?: number
  /** Per-mirror-image previous dab object-local surface center, for Snake Hook
   * (the one grab-family tool still on strokeMethod=Path): grabTo = thisDab −
   * prevDab. Index 0 = primary dab, 1..n = SymAxisMap mirror images; each image
   * traces its own path so its grab delta must not be shared. Empty until the
   * first dab of the stroke. */
  prevDabLocal: (Vector3 | undefined)[] = []

  /** Previous *primary* dab surface center, and the current stroke tangent
   * derived from it. The oriented Box falloff (and wing-scrape) follow this
   * tangent; under mirror symmetry the shared sculptcore ring buffer can't
   * derive a per-image tangent, so the primary tangent is computed here and each
   * mirror image reflects it across its symmetry plane(s). Undefined until the
   * second dab of the stroke (the first has no previous center). */
  prevPrimaryDabCenter?: Vector3
  curStrokeDir?: Vector3

  /** View-normal mask ray, pinned at the stroke's first primary dab (mirror
   * images reflect it). The per-dab viewvec drifts with the cursor under
   * perspective; because mask factors stamp first-touch in leaf-sized blocks,
   * a drifting ray tears along spatial-node boundaries. Pinning also matches
   * the GPU pack, which is stroke-static by construction. */
  strokeViewDir?: Vector3

  /** GPU stroke controller (plans/gpuGlobalBrushes.md §5); undefined = CPU
   * path. Decided once per stroke on the first primary dab (D5). */
  gpu?: GpuStrokeController
  gpuDecided = false
  /** Monotonic high-water mark of the node-filter radius over the stroke. A
   * from-orig grab/kelvinlet dab only writes verts inside the filter, so if the
   * region ever shrinks (drag reversal) the verts it dropped keep their last
   * displaced value and leave a stale ring. Never let it go down. */
  maxFilterRadius = 0
  /** Resolves when the GPU stroke's async finalization (final readback +
   * endStep) lands; undo/redo arriving mid-await chain onto it. */
  gpuCompletion?: Promise<void>

  static meshLog: MeshLog | undefined
  inStep = false
  /** MeshLog step id owned by this op (set in undoPre); -1 = none. Keys
   * calcUndoMem/onUndoDestroy so stack trimming frees the C++ step too. */
  logStepId = -1

  /** Monotonic, process-global non-accumulate generation stamp; pre-incremented
   * once per stroke (so the first stroke gets 1, never 0 = "not stamped"). The
   * executor + dyntopo key each vert's `.brush.orig.*` snapshot on it. */
  static nextStrokeGen = 0
  /** This stroke's generation stamp (set in undoPre). */
  curStrokeGen = 0

  static tooldef() {
    return {
      toolpath: 'sculptcore.paint',
      inputs  : {},
      outputs : {},
      is_modal: true,
    }
  }

  constructor() {
    super()
    SculptPaintOp.ensureMeshLog()
  }

  /** The single shared C++ undo stack for all mesh-mutating ops (sculpt strokes
   * + the litemesh layout-reorder op). Lazily constructed so any op can record
   * onto it before the first stroke. */
  static ensureMeshLog(): MeshLog {
    if (SculptPaintOp.meshLog === undefined) {
      const wasm = getWasmImmediate()!
      SculptPaintOp.meshLog = wasm.manager.construct('sculptcore::meshlog::MeshLog')
    }
    return SculptPaintOp.meshLog!
  }

  /** Build (or reuse) the executor + wasmBrush so the step can be opened via
   * `executor.beginStep` before the first dab. Sets the shared meshLog on it;
   * later dabs reuse the same executor through getBrush. */
  ensureExecutor(ctx: ToolContext): CommandExecutor {
    const brush = this.inputs.brush.getValue()
    const result = builSculptcoreBrush({
      wasm: getWasmImmediate()!,
      brush,
      mesh     : ctx.object!.data as LiteMesh,
      radius   : brush.radius,
      invert   : false,
      wasmBrush: this.wasmBrush,
      wasmExec : this.executor,
      nonAccum : !(brush.flag & BrushFlags.ACCUMULATE),
      strokeGen: this.curStrokeGen,
    })
    this.wasmBrush = result.wasmBrush
    this.executor = result.wasmExec
    this.executor.meshLog = SculptPaintOp.meshLog
    return this.executor
  }

  undoPre(ctx: ToolContext) {
    const brush = this.inputs.brush.getValue()
    // Dyntopo mutates topology; the multires writeback needs the level's fixed
    // grid topology, so it is forced off while a multires stack is attached.
    const opMesh = ctx.object?.data
    const hasDyntopo = brush.dynTopoSC.enabled && !(opMesh instanceof LiteMesh && opMesh.multiresActive)

    this.strokeGroupId = undefined
    this.prevDabLocal = []
    this.prevPrimaryDabCenter = undefined
    this.curStrokeDir = undefined
    this.strokeViewDir = undefined
    this.dabSeed = 1
    this.lastDynTopoS = -Infinity
    this.curStrokeGen = ++SculptPaintOp.nextStrokeGen
    this.gpu = undefined
    this.gpuDecided = false
    this.maxFilterRadius = 0
    // Snapshot the live symmetry axes as an op input so a later exec replay
    // (which may see a different ctx.toolmode) mirrors the same way (A.4).
    this.inputs.symmetryAxes.setValue((ctx.toolmode as SculptCorePaintMode | undefined)?.symmetryAxes ?? 0)
    ;(ctx.toolmode as SculptCorePaintMode | undefined)?.resetDynTopoStats()
    if (SculptPaintOp.meshLog) {
      // The executor owns the meshlog step boundary; build it now so the step
      // is opened the same way every client (debug app, tests) opens one.
      const exec = this.ensureExecutor(ctx)
      exec.beginStep(hasDyntopo)
      this.logStepId = SculptPaintOp.meshLog.lastStepId()
      this.inStep = true
      window.redraw_viewport(true)
    }
  }

  /** GPU strokes finalize asynchronously (mapAsync readback); an undo/redo
   * arriving mid-await must wait for the step to close (plan §11). */
  private afterGpuCompletion(fn: () => void): void {
    if (this.gpuCompletion) {
      void this.gpuCompletion.then(fn)
    } else {
      fn()
    }
  }

  undo(ctx: ToolContext) {
    this.afterGpuCompletion(() => {
      if (SculptPaintOp.meshLog) {
        const mesh = ctx.object!.data! as LiteMesh
        SculptPaintOp.meshLog.undo(mesh.mesh, mesh.spatial)
        // Re-sync the grids store to the restored level positions (no-op
        // without a multires stack).
        mesh.multiresWriteback()
        mesh.regenBounds()
        // The stroke path consumes the spatial flush the draw path keys revision
        // bumps on; bump explicitly so wireframe/points overlays rebuild.
        mesh.meshRevision++
        window.redraw_viewport(true)
      }
    })
  }

  redo(ctx: ToolContext) {
    this.afterGpuCompletion(() => {
      if (SculptPaintOp.meshLog) {
        const mesh = ctx.object!.data! as LiteMesh
        SculptPaintOp.meshLog.redo(mesh.mesh, mesh.spatial)
        mesh.multiresWriteback()
        mesh.regenBounds()
        mesh.meshRevision++
        window.redraw_viewport(true)
      }
    })
  }

  /** Undo data lives in the shared C++ MeshLog; report this op's step size so
   * the tool stack's memory limit sees the real cost. */
  calcUndoMem(_ctx: ToolContext): number {
    const log = SculptPaintOp.meshLog
    if (!log || this.logStepId < 0) {
      return 0
    }
    return log.stepMemSize(this.logStepId)
  }

  /** Stack trim dropped this op — free its C++ MeshLog step too. */
  onUndoDestroy(): void {
    const log = SculptPaintOp.meshLog
    if (log && this.logStepId >= 0) {
      log.freeStep(this.logStepId)
      this.logStepId = -1
    }
  }

  /** Backface culling in force: the tool mode's scene-wide toggle when the brush
   * defers to it (BrushFlags.SHARED_CULL_BACKFACES), else the brush's own flag.
   * Falls back to the brush alone when replayed without a sculptcore toolmode. */
  resolveCullBackfaces(ctx: ToolContext, brush: SculptBrush): boolean {
    const toolmode = ctx.toolmode as SculptCorePaintMode | undefined
    if (toolmode?.resolveCullBackfaces) {
      return toolmode.resolveCullBackfaces(brush)
    }
    return !!(brush.flag & BrushFlags.CULL_BACKFACES)
  }

  getBrush(ctx: ToolContext, ps: PaintSample): IGetBrushRet {
    const brush = this.inputs.brush.getValue()
    // Non-accumulate is the default (ACCUMULATE bit CLEAR). The executor ignores
    // it for non-deform brushes, so it's safe to pass unconditionally.
    const nonAccum = !(brush.flag & BrushFlags.ACCUMULATE)
    const result = builSculptcoreBrush({
      wasm: getWasmImmediate()!,
      brush,
      mesh     : ctx.object!.data as LiteMesh,
      radius   : brush.radius,
      invert   : ps.invert,
      wasmBrush: this.wasmBrush,
      wasmExec : this.executor,
      nonAccum,
      strokeGen    : this.curStrokeGen,
      cullBackfaces: this.resolveCullBackfaces(ctx, brush),
    })

    this.wasmBrush = result.wasmBrush
    this.executor = result.wasmExec
    return {brush, ...result}
  }

  calcRadius(screenRadius: number): number {
    return screenRadius
  }

  /** Read the active brush's configured stroke method (base class defaults to
   * Path for any StrokeDriverOp that doesn't override this). */
  getStrokeMethod(): StrokeMethod {
    return this.inputs.brush.getValue().strokeMethod
  }

  /** Anchored strokes only drive a live scalar off the drag when the brush opts
   * in (`anchoredDragRadius`). Off = Angle: the drag still sets the brush angle
   * / stroke direction, but the radius stays the brush's own — the grab-class
   * default, since for Grab/Kelvinlet the radius IS the deformation width (and,
   * for the kelvinlet kernel, its regularization epsilon). */
  getAnchoredLiveMode(): AnchoredLiveMode {
    const brush = this.inputs.brush.getValue()
    return brush.anchoredDragRadius ? brush.anchoredLiveMode : AnchoredLiveMode.ANGLE
  }

  /** Lazily-constructed, reused-per-dab composite brush program (autosmooth). */
  getProgram(): BrushProgram {
    if (!this.brushProgram) {
      this.brushProgram = getWasmImmediate()!.manager.construct('sculptcore::brush::BrushProgram') as BrushProgram
    }
    return this.brushProgram
  }

  /** Lazily-constructed, reused-per-dab dyntopo params handle. */
  getDynTopoParams(): DynTopoParams {
    if (!this.dynTopoParams) {
      this.dynTopoParams = getWasmImmediate()!.manager.construct('sculptcore::dyntopo::DynTopoParams') as DynTopoParams
    }
    return this.dynTopoParams
  }

  /** Emit object-local PaintSamples from the driver (positions + view vectors in
   * the LiteMesh's own space), so applyDabOne can raycast the mesh and run the
   * brush kernel without a per-dab world->local conversion. */
  getObjectMatrix(): Matrix4 | undefined {
    const ob = this.modal_ctx?.object
    if (!ob) {
      return undefined
    }
    return new Matrix4(ob.outputs.matrix.getValue())
  }

  /** The C++ driver raycasts this tree itself (it has the object matrix), so
   * makeRayCast's world<->local round trip is only for the TS driver. */
  getSpatialTree(): unknown | undefined {
    const mesh = this.modal_ctx?.object?.data
    return mesh instanceof LiteMesh ? mesh.spatial : undefined
  }

  /** World-space ray cast for the stroke driver's control points: world
   * origin/dir -> object-local -> mesh.rayCast -> hit back in world space. */
  makeRayCast(): StrokeRayCast {
    const ctx = this.modal_ctx!
    const mesh = ctx.object!.data as LiteMesh

    return (origin: Vector3, dir: Vector3): IStrokeHit | undefined => {
      const obmat = new Matrix4(ctx.object!.outputs.matrix.getValue())
      const imatrix = new Matrix4(obmat)
      imatrix.invert()
      // Directions must not pick up the (inverse) object translation.
      const idirmat = new Matrix4(imatrix)
      idirmat.clearTranslation()

      const o = origin.copy()
      const d = dir.copy()
      o.multVecMatrix(imatrix)
      d.multVecMatrix(idirmat)

      const isect = mesh.rayCast(o, d)
      if (!isect) {
        return undefined
      }

      const p = new Vector3(isect.p)
      p.multVecMatrix(obmat)
      const dirmat = new Matrix4(obmat)
      dirmat.clearTranslation()
      const normal = new Vector3(isect.normal)
      normal.multVecMatrix(dirmat)
      normal.normalize()

      return {p, normal, dist: p.vectorDistance(origin)}
    }
  }

  /** Apply one evenly-spaced driver dab to the surface, plus a mirrored dab for
   * every active symmetry axis. The brush cursor overlay is drawn once here (for
   * the real, unmirrored sample); the per-dab work — including the object-local
   * ray reflection — lives in {@link applyDabOne}. */
  applyDab(ctx: ViewContext | ToolContext, ps: PaintSample): void {
    if (!this.inStep) {
      return
    }

    const view3d = (ctx as ViewContext).view3d as View3D | undefined
    const toolmode = ctx.toolmode as SculptCorePaintMode

    // XXX move this into the base class and out of applyDab
    if (view3d !== undefined) {
      view3d.resetDrawLines()
      // ps.screenP is the dab's origin -- the live cursor for Path/DragDot, but
      // the FIXED anchor for the whole Anchored stroke (see emitAnchored). mpos
      // must track the real pointer regardless, so hover redraws after an
      // Anchored stroke don't stick at the anchor, and so drawBrush's Anchored
      // aim line has a live far endpoint.
      const liveX = this.lastEvent ? this.lastEvent.x : ps.screenP[0] + view3d.pos![0]
      const liveY = this.lastEvent ? this.lastEvent.y : ps.screenP[1] + view3d.pos![1]
      toolmode.mpos[0] = liveX
      toolmode.mpos[1] = liveY
      toolmode.drawBrush(view3d, true, ps.screenP[0] + view3d.pos![0], ps.screenP[1] + view3d.pos![1])
    }

    // Primary dab (identity reflection), then one dab per SymAxisMap mirror image
    // about the mesh's own local axis planes. Each image keeps its own grab state
    // (prevDabLocal[i]) and advances the dyntopo seed (A.5).
    this.applyDabOne(ctx, ps, undefined, 0)

    const sym = this.getSymmetryAxes(ctx)
    if (sym !== 0) {
      const muls = SymAxisMap[sym]
      for (let i = 0; i < muls.length; i++) {
        this.applyDabOne(ctx, ps, muls[i], i + 1)
      }
    }

    // When the poly-group edge overlay is enabled, refresh its boundaries each
    // dab so group painting shows live (#28). Cheap no-op when the overlay is off.
    if ((toolmode as unknown as {drawPolyGroupEdges?: boolean})?.drawPolyGroupEdges) {
      const mesh = ctx.object?.data as LiteMesh | undefined
      mesh?.markSeamsDirty?.()
    }
  }

  /** The live symmetry axes bitflag {X:1,Y:2,Z:4}: the value snapshotted in
   * undoPre, falling back to the toolmode for any non-snapshotted call (A.4). */
  getSymmetryAxes(ctx: ViewContext | ToolContext): number {
    const v = this.inputs.symmetryAxes.getValue()
    if (v !== undefined) {
      return v
    }
    return (ctx.toolmode as SculptCorePaintMode | undefined)?.symmetryAxes ?? 0
  }

  /** Apply one dab on the (optionally mirrored) side of the mesh: reflect the
   * object-local view ray by `mul` (a SymAxisMap component-sign multiplier;
   * undefined = primary dab), re-raycast to snap to the surface, then run the
   * sculptcore brush pipeline + optional dyntopo. `mirrorIdx` keys this image's
   * cross-dab grab state (0 = primary, 1..n = SymAxisMap order). */
  private applyDabOne(
    ctx: ViewContext | ToolContext,
    ps: PaintSample,
    mirrorFlips: Vector3 | undefined,
    mirrorIdx: number
  ): void {
    const toolmode = ctx.toolmode as SculptCorePaintMode

    if (mirrorFlips !== undefined) {
      ps = ps.copy()
      ps.mirror(mirrorFlips)
    }

    const {brush, wasmExec, wasmBrush} = this.getBrush(ctx, ps)
    const wasm = getWasmImmediate()!

    const mesh = ctx.object!.data as LiteMesh

    const viewvec = new Vector3(ps.viewvec)

    // Still in the brush's own unit here; resolved to world once `dist` is known.
    let radius = ps.radius

    let p: Vector3
    let normal: Vector3
    let isectFace = -1
    let isect: ReturnType<LiteMesh['rayCast']> | undefined

    if (brush.strokeMethod === StrokeMethod.ANCHORED) {
      // Anchored: the driver already resolved the fixed dab position/normal
      // (ps.p / ps.vec, object-local — BrushStrokeDriver.emitAnchored) and,
      // for Grab-family kernels, the live anchor->cursor drag (ps.anchorVec).
      // No per-dab raycast; the dab center never moves off the anchor.
      p = new Vector3(ps.p)
      normal = new Vector3(ps.vec)
    } else {
      const origin = new Vector3(ps.vieworigin)
      isect = mesh.rayCast(origin, viewvec)
      if (isect === undefined) {
        return
      }
      p = isect.p
      normal = isect.normal
      isectFace = isect.face
    }

    const p4 = new Vector4().load3(p)
    p4[3] = 1.0
    p4.multVecMatrix(ps.rendermat)

    const m1 = new Vector3(p)
    view3dProject(m1, ps.view3dSize, ps.rendermat)
    const m2 = new Vector3(m1)
    m2[0] += 1

    view3dUnproject(m2, ps.view3dSize, ps.irendermat)

    const dist = m2.vectorDistance(p)
    radius = brush.resolveWorldRadius(radius, dist)

    // Remember both radii from a primary dab that actually hit the surface;
    // brush.set_radius_mode converts through them so the on-screen brush size
    // doesn't jump when the unit changes. Mirror dabs share the primary's size.
    if (brush.strokeMethod !== StrokeMethod.ANCHORED && mirrorIdx === 0 && isect !== undefined && dist > 0) {
      toolmode.lastWorldRadius = radius
      toolmode.lastScreenRadius = radius / dist
    }

    const brushType = toolToSculptBrush(brush.tool)
    if (brushType === undefined) {
      // TS tool with no sculptcore equivalent (e.g. Grab, Snake, Paint).
      // Skip the dab rather than silently running a Draw.
      console.warn(`sculptcore: no kernel for tool ${SculptTools[brush.tool] ?? brush.tool}; skipping dab`)
    } else if (mesh.hasVdm && brush.tool === SculptTools.DRAW && SculptPaintOp.meshLog) {
      // VDM carrier routing (X3 stage 4): with a store attached, Draw dabs
      // splat texels (no vertex moves); undo rides the stroke's MeshLog step.
      applyVdmSplatDab(
        wasm,
        mesh,
        SculptPaintOp.meshLog,
        p as unknown as ArrayLike<number>,
        normal as unknown as ArrayLike<number>,
        radius,
        ps.strength,
        ps.invert
      )
      if (wasm.Vdm_lastSplatClamped() > 0 && !this._vdmClampNoted) {
        // Fold clamp hit its ceiling — on a (topo-locked) multires base the
        // remedy is another level (X1 prompt signal). Note once per stroke.
        this._vdmClampNoted = true
        ;(this.modal_ctx as unknown as {message?: (msg: string) => void})?.message?.(
          'VDM detail clamped — add a multires level for more'
        )
      }
    } else {
      // Make the painted attribute visible (color/polygroup) without a manual
      // display-mode toggle.
      syncDisplayModeToBrush(mesh, brush.tool)

      // Poly-group paint: choose the stroke's group id once, on the first dab.
      // Default = a fresh incremented id (max existing + 1); holding shift
      // samples the group under the cursor and extends it (falling back to a
      // new id when that face has no group yet).
      if (brush.tool === SculptTools.POLYGROUP) {
        if (this.strokeGroupId === undefined) {
          if (ps.useAltBrush && isectFace >= 0) {
            const sampled = mesh.mesh.faceGroup(isectFace)
            this.strokeGroupId = sampled > 0 ? sampled : mesh.mesh.maxFaceGroup() + 1
          } else {
            this.strokeGroupId = mesh.mesh.maxFaceGroup() + 1
          }
        }
        wasmBrush.activeGroup = this.strokeGroupId!
      }

      wasmBrush.strength = ps.strength
      wasmBrush.radius = radius
      wasmBrush.writeProps()
      wasmExec.meshLog = SculptPaintOp.meshLog

      // Dynamic topology config: build the params handle the executor uses to
      // remesh under the dab BEFORE the brush deform. `dist` is world-units-
      // per-pixel at the dab (computed above). Null params = dyntopo off.
      // Dyntopo runs at its own `dynTopoSpacing` along the stroke, not on every
      // dab (a dense deform stroke would otherwise remesh excessively). ps.strokeS
      // is the accumulated arc-length in units of 2·radius (same units as the
      // spacing param); remesh only once it has advanced past dynTopoSpacing.
      const dt = brush.dynTopoSC
      // Dyntopo would desync the fixed grid topology the multires writeback
      // assumes — force it off on a multires level mesh.
      const dtEnabled = dt.enabled && !mesh.multiresActive
      let params: DynTopoParams | undefined = undefined
      // Decide remesh-due once per stroke sample on the primary dab; mirror
      // images (mirrorIdx > 0) reuse it so every symmetric side remeshes on the
      // same samples. Updating lastDynTopoS per-image would make the primary dab
      // consume the budget and starve the mirror dabs of dyntopo (#38).
      const dynTopoDue = mirrorIdx === 0 ? ps.strokeS - this.lastDynTopoS >= dt.dynTopoSpacing : this._dabDynTopoDue
      if (mirrorIdx === 0) {
        this._dabDynTopoDue = dynTopoDue
      }
      if (dtEnabled && dynTopoDue) {
        const {l_max, l_min} = dt.resolveEdgeGoal(radius, dist)
        params = this.getDynTopoParams()
        configureDynTopoParams(params, dt, l_max, l_min)
        if (mirrorIdx === 0) {
          this.lastDynTopoS = ps.strokeS
        }
      }

      // Per-dab pen device samples (pressure/tilt/twist) drive the dynamics
      // stack that loadProps applies inside the deform.
      pushBrushDeviceInputs(wasmBrush, ps)

      // Build the per-dab command list (main brush + optional autosmooth).
      const prog = this.getProgram()
      buildBrushProgram(prog, brushType, brush, radius, mesh)
      // Plane brushes (Clay/Scrape/Fill) optionally project along the viewport
      // view vector instead of the center surface normal; viewvec is already
      // object-local here (same vector the dab raycast used).
      const dabNormal = resolvePlaneDabNormal(brush.tool, brush.planeNormalMode, normal, viewvec)

      // Grab-style brushes (grab/snakehook/kelvinlet) pull the region in the
      // stroke-movement direction (see applyGrabDabState).
      const dabCenter: number[] | Vector3 = p
      // Node-filter radius. Grab/kelvinlet widen it by the cumulative drag below
      // (the falloff still uses the brush radius via wasmBrush.radius), so the
      // deformed region's leaves stay in the filter and can't shrink + tear (#35).
      let filterRadius = radius
      const dabPolicy = resolveDabPolicy(brushType)
      if (dabPolicy.isGrab) {
        if (dabPolicy.incrementalGrab) {
          // `@incremental` (snakehook, strokeMethod=Path): dab tracks the live
          // raycast surface each dab; grabFrom = current center, grabTo = step
          // since last dab.
          this.prevDabLocal[mirrorIdx] = applyGrabDabState(wasmBrush, p, this.prevDabLocal[mirrorIdx])
          // No high-water latch here: an incremental kernel is not a from-orig
          // grab (grabMode stays false), and this radius also sizes the dyntopo
          // dab — pinning it at the stroke's widest collapses edges well outside
          // the dab.
        } else {
          // Grab / kelvinlet (strokeMethod=Anchored): deform a region FIXED at
          // the stroke anchor, from each vert's orig position (#35). grabFrom =
          // anchor (p, fixed); grabTo = the driver's live anchor->cursor drag
          // (ps.anchorVec, object-local, tracks the view plane not the curved
          // surface — see BrushStrokeDriver.projectOntoAnchorPlane), so the
          // from-orig kernel recomputes the absolute pull each dab. Widen the
          // node filter by the drag length so moved leaves stay in the set.
          const gf = wasmBrush.grabFrom.vec
          const gt = wasmBrush.grabTo.vec
          gf[0] = p[0]
          gf[1] = p[1]
          gf[2] = p[2]
          gt[0] = ps.anchorVec[0]
          gt[1] = ps.anchorVec[1]
          gt[2] = ps.anchorVec[2]
          // An `@unbounded` field (kelvinlet) has no distance falloff of its own,
          // only the C1 window the kernel applies over [0.8R, R],
          // R = radius * unboundedExtent. Filter to that same R or the field is
          // still live where the node set stops and the leaf boundary tears. Plus
          // the drag, since the region must also cover where the verts move *to*.
          // This sizes the GPU dab and the preview snapshot; the CPU executor
          // pins its own (drag-independent) region — CommandExecutor::grabFilterNodes.
          const fieldRadius = dabPolicy.unbounded ? radius * wasmBrush.unboundedExtent : radius
          filterRadius = fieldRadius + ps.anchorVec.vectorLength()
          // Symmetry: the primary image re-bases every touched vert from orig
          // (Absolute); mirror images add their pull onto it (Add) so shared verts
          // sum instead of the last pass overwriting.
          wasmExec.setGrabAccumAdd(mirrorIdx > 0)
          // Never let the region shrink mid-stroke (drag reversal): a from-orig
          // dab only writes verts inside the filter, so any vert it drops keeps
          // its previous displacement and leaves a stale ring behind.
          this.maxFilterRadius = Math.max(this.maxFilterRadius, filterRadius)
          filterRadius = this.maxFilterRadius
        }
      }

      // Stroke tangent for the oriented Box falloff + wing-scrape, mirror-aware:
      // the primary dab derives it from consecutive primary centers, each mirror
      // image reflects it (host owns it so sculptcore won't re-derive a corrupt one).
      let strokeDir: Vector3 | undefined
      if (mirrorIdx === 0) {
        if (brush.strokeMethod === StrokeMethod.ANCHORED) {
          // An anchored dab is pinned at the anchor, so consecutive centers never
          // yield a direction. Orient off the live anchor->cursor drag instead,
          // flattened into the surface tangent plane — that is what "the brush
          // angle follows the cursor" means here, and it holds in both
          // AnchoredLiveMode.RADIUS and .ANGLE.
          const d = new Vector3(ps.anchorVec)
          const n = new Vector3(normal).normalize()
          d.addFac(n, -d.dot(n))
          if (d.dot(d) > 1e-14) {
            d.normalize()
            this.curStrokeDir = d
          }
        } else if (this.prevPrimaryDabCenter !== undefined) {
          const d = new Vector3(p).sub(this.prevPrimaryDabCenter)
          if (d.dot(d) > 1e-14) {
            d.normalize()
            this.curStrokeDir = d
          }
        }
        this.prevPrimaryDabCenter = new Vector3(p)
        strokeDir = this.curStrokeDir
      } else if (this.curStrokeDir !== undefined && mirrorFlips !== undefined) {
        strokeDir = new Vector3(this.curStrokeDir).mul(mirrorFlips)
      }
      if (strokeDir !== undefined) {
        const sd = (wasmBrush.strokeDir as unknown as {vec: number[]}).vec
        sd[0] = strokeDir[0]
        sd[1] = strokeDir[1]
        sd[2] = strokeDir[2]
        wasmBrush.strokeDirHostSet = true
      } else {
        wasmBrush.strokeDirHostSet = false
      }

      // View-normal automasking reads the eye->surface ray in object space,
      // pinned per stroke (see strokeViewDir); each mirror image reflects the
      // pinned primary ray so it masks against its own silhouette (symmetric
      // strokes mask symmetrically). Safe because the view factor is DYNAMIC —
      // evaluated in strength() per dab with this image's ray — never cached
      // per vertex. (The old per-stroke factor cache initialized whole spatial
      // leaves from whichever image reached them first, mixing opposed rays in
      // leaf-sized blocks: the ntest.wproj node-boundary tearing.)
      if (this.strokeViewDir === undefined) {
        // The first dab of a stroke is always the primary image.
        this.strokeViewDir = new Vector3(viewvec)
      }
      let maskRay: Vector3 = this.strokeViewDir
      if (mirrorIdx > 0 && mirrorFlips !== undefined) {
        maskRay = new Vector3(maskRay).mul(mirrorFlips)
      }
      const vd = (wasmBrush.viewDir as unknown as {vec: number[]}).vec
      vd[0] = maskRay[0]
      vd[1] = maskRay[1]
      vd[2] = maskRay[2]

      // GPU stroke branch (plans/gpuGlobalBrushes.md §5): eligibility is
      // decided once, on the stroke's first primary dab (D5) — never
      // mid-stroke. In shadow-verify mode the CPU dab below stays
      // authoritative and the GPU runs in parallel for the per-dab diff.
      if (mirrorIdx === 0 && !this.gpuDecided) {
        this.gpuDecided = true
        this.gpu = GpuStrokeController.tryBegin({
          wasm,
          mesh,
          wasmBrush,
          meshLog: SculptPaintOp.meshLog!,
          brushType,
          modalRunning  : this.modalRunning,
          dyntopoEnabled: dtEnabled,
          autosmooth    : brush.autosmooth,
        })
      }
      if (this.gpu) {
        const nonAccum = !(brush.flag & BrushFlags.ACCUMULATE)
        const ok = this.gpu.dab(dabCenter, dabNormal, radius, filterRadius, mirrorIdx, nonAccum)
        if (!ok && this.gpu.stroke.stats.dispatches === 0) {
          // GPU init failed before anything dispatched — the whole stroke
          // falls back to the CPU path (§4 failure policy).
          this.gpu.abort()
          this.gpu = undefined
        }
      }

      // Anchored/Drag Dot live preview (step 2a): every dab but the stroke's
      // last is provisional — rolled back the instant the next one lands —
      // so a long drag never leaves a trail of committed partial dabs behind
      // (required for Drag Dot's discrete-stamp semantics; a memory-bloat
      // optimization for Grab/Kelvinlet's idempotent from-orig kernel). Under
      // symmetry, one driver tick's primary dab (mirrorIdx 0) starts the
      // preview session and each mirror image extends it with its own region
      // (extendPreviewDab) rather than resetting it — the whole group of
      // dabs then rolls back together as one unit when the NEXT tick's
      // primary dab lands.
      const doPreview = brush.strokeMethod !== StrokeMethod.PATH

      // One unified dab: dyntopo pre-pass (if params != null), node filter,
      // deform, and per-dab topo-chunk seal — all in the executor, one order
      // shared by every client. The seed only matters when dyntopo is on.
      // Skipped on the pure-GPU branch (the kernel dispatch replaces it).
      if (!this.gpu || this.gpu.shadow) {
        if (doPreview && mirrorIdx === 0 && wasmExec.previewActive()) {
          wasmExec.rollbackPreviewDab()
          mesh.spatial.updateQueries()
        }
        if (doPreview) {
          if (mirrorIdx === 0) {
            wasmExec.beginPreviewDab(wasm.float3(dabCenter), filterRadius)
          } else {
            wasmExec.extendPreviewDab(wasm.float3(dabCenter), filterRadius)
          }
        }
        wasmExec.applyDab(
          prog,
          wasm.float3(dabCenter),
          wasm.float3(dabNormal),
          filterRadius,
          params ?? (0 as never),
          dtEnabled ? this.dabSeed++ : 0
        )
        mesh.regenBounds()
      }

      if (dtEnabled) {
        // Accumulate stats for the debug HUD (lastDynTopoStats holds this dab's
        // counts).
        const st = wasmExec.lastDynTopoStats
        const acc = toolmode.dynTopoStats
        acc.splits += st.splits
        acc.collapses += st.collapses
        acc.flips += st.flips
        acc.rounds = st.rounds
        acc.budgetHit = acc.budgetHit || st.budget_hit
      }
    }

    if (!this.gpu || this.gpu.shadow) {
      mesh.regenTreeBatch()
      if (this.gpu?.shadow) {
        // Shadow-verify diffs CPU buffers per dab — keep the eager full update.
        mesh.spatial.update(mesh.wasm.gpu)
      } else {
        // Per-dab: only the query-correctness half (split/merge, tris, bounds,
        // normals). The GPU buffer half runs once per frame in drawQ.
        mesh.spatial.updateQueries()
      }
    }
    window.redraw_viewport(true)
  }

  modalEnd(was_cancelled: boolean) {
    const ctx = this.modal_ctx!
    const result = super.modalEnd(was_cancelled)
    this.finishStroke(ctx)
    return result
  }

  finishStroke(ctx: ToolContext): void {
    const gpu = this.gpu
    if (gpu) {
      this.gpu = undefined
      if (gpu.shadow) {
        // CPU owns the mesh; the controller just frees its GPU side on the
        // serialized chain, and the normal CPU finish below proceeds.
        this.gpuCompletion = gpu.finish(() => {})
      } else {
        // Final readback -> GpuBrush_endStroke -> the same tail as the CPU
        // path, all on the stroke's serialized chain. Undo/redo arriving
        // before it lands wait on gpuCompletion (plan §11).
        this.gpuCompletion = gpu.finish(() => this.finishStrokeTail(ctx))
        return
      }
    }
    this.finishStrokeTail(ctx)
  }

  private finishStrokeTail(ctx: ToolContext): void {
    // Anchored/Drag Dot: the last dab was applied as a preview (applyDabOne has
    // no "this is the final sample" signal), so keep its effect and drop the
    // snapshot bookkeeping here -- otherwise previewActive() stays stale and
    // the next stroke's first preview dab rolls back against the wrong step.
    this.executor?.commitPreviewDab()
    // Release the stroke-long topology thaw the dyntopo path held (no-op if the
    // executor never ran a dyntopo dab).
    this.executor?.endDynTopoStroke()
    const mesh = ctx.object?.data
    if (SculptPaintOp.meshLog && this.inStep) {
      this.inStep = false
      // Mechanism B (opt-in): fold an incremental DRAM-layout compaction into the
      // still-open stroke step when dyntopo churn has fragmented the layout past
      // the threshold. Undo then reverts stroke + compaction as one step.
      if (
        mesh instanceof LiteMesh &&
        !mesh.multiresActive && // compaction reorders verts → stale grid tables
        this.inputs.brush.getValue().dynTopoSC.enabled &&
        FeatureFlags.get('sculptcore.auto_defrag')
      ) {
        SculptPaintOp.meshLog.compactIfFragmented(mesh.spatial, AUTO_DEFRAG_VERT_RATIO)
      }
      // The executor closes the step it opened in undoPre (forwards to meshLog).
      this.executor?.endStep()
    }
    if (this.brushProgram) {
      this.brushProgram[Symbol.dispose]()
      this.brushProgram = undefined
    }
    if (this.dynTopoParams) {
      this.dynTopoParams[Symbol.dispose]()
      this.dynTopoParams = undefined
    }
    // Dyntopo changes the seam/feature topology; refresh the overlay batch.
    if (mesh instanceof LiteMesh) {
      mesh.markSeamsDirty()
      // Bump at stroke end so wireframe/points overlays rebuild (per-dab
      // rebuilds would thaw topology, O(all edges)); drawQ's per-frame bump
      // mid-stroke doesn't cover a stroke that ends between frames.
      mesh.meshRevision++
      // Fold the stroke into the multires grids store (no-op without a stack).
      mesh.multiresWriteback()
    }
    window.redraw_viewport(true)
  }

  exec(ctx: ToolContext): void {
    for (const ps of this.inputs.samples.getValue()) {
      this.applyDab(ctx, ps)
    }
    if (!this.modalRunning) {
      this.finishStroke(ctx)
    }

    window.redraw_viewport(true)
    //console.error('TODO: support re-execution of sculptcore paint ops')
  }
}

/**
 * Set the kelvinlet grab vectors for one dab and return the new previous-dab
 * point. grabFrom = force application point (this dab center, object-local);
 * grabTo = the per-dab displacement vector (zero on the first dab, so the
 * kelvinlet is a no-op until the brush moves). Both are bound Brush members the
 * kernel reads from ctx.brush. Shared by the interactive op and the test driver.
 */
function applyGrabDabState(wasmBrush: WasmBrush, p: number[] | Vector3, prev: Vector3 | undefined): Vector3 {
  const gf = wasmBrush.grabFrom.vec
  const gt = wasmBrush.grabTo.vec
  for (let i = 0; i < 3; i++) {
    const cur = p[i] ?? 0
    gf[i] = cur
    gt[i] = prev ? cur - (prev[i] ?? 0) : 0
  }
  return new Vector3(p)
}

/**
 * Dev/test driver: run a sculptcore brush stroke programmatically over a list of
 * world-space dabs on a LiteMesh, with undo logging — the headless/CDP
 * counterpart to interactively dragging the sculpt brush. Mirrors
 * `SculptPaintOp.applyDab`'s per-dab work (builSculptcoreBrush + buildBrushProgram
 * + executor.applyDab) but takes world-space `p`/`normal` directly instead of
 * casting a view ray. Returns the dab count, or `skipped:true` when the tool has
 * no sculptcore kernel.
 */
/** Fold-bound clamp fraction for interactive VDM splats (|texel| <= alpha *
 * rho_min; the engine kernel's own default). Clamp hits surface via
 * Vdm_lastSplatClamped as the add-a-level prompt signal. */
const VDM_SPLAT_ALPHA = 0.5

/** One interactive VDM dab (X3 stage 4 carrier routing): splat tangent-space
 * texels into the mesh's attached store instead of moving vertices; the tile
 * delta rides `meshLog`'s open step as a VdmLogChunk. Returns texels touched. */
function applyVdmSplatDab(
  wasm: NonNullable<ReturnType<typeof getWasmImmediate>>,
  mesh: LiteMesh,
  meshLog: MeshLog,
  p: ArrayLike<number>,
  normal: ArrayLike<number>,
  radius: number,
  strength: number,
  invert: boolean
): number {
  return wasm.Mesh_vdmSplatDabLogged(
    mesh.mesh,
    mesh.spatial,
    mesh.vdmStore!,
    meshLog as never,
    p[0],
    p[1],
    p[2],
    normal[0],
    normal[1],
    normal[2],
    radius,
    strength,
    VDM_SPLAT_ALPHA,
    invert ? 1 : 0
  )
}

/** Point a driver stroke's view-normal mask at `viewDir`, reflected by a
 * SymAxisMap multiplier for a mirror image (per-image rays are safe: the view
 * factor is evaluated dynamically per dab, never cached — see the applyDab
 * note). A headless driver has no camera, so an omitted ray turns the mask off
 * for the stroke rather than masking against some arbitrary default. */
function applyDriverViewDir(wasmBrush: WasmBrush, viewDir: number[] | undefined, mul: Vector3 | undefined): void {
  if (viewDir === undefined) {
    wasmBrush.automask_view_normal = false
    return
  }
  const vd = (wasmBrush.viewDir as unknown as {vec: number[]}).vec
  for (let i = 0; i < 3; i++) {
    vd[i] = (viewDir[i] ?? 0) * (mul?.[i] ?? 1)
  }
}

export function runSculptcoreStroke(opts: {
  mesh: LiteMesh
  brush: SculptBrush
  dabs: {p: number[]; normal: number[]}[]
  radius?: number
  /** world-units-per-pixel at the dab; only needed for PIXELS edge mode. */
  dist?: number
  /** Stroke-level invert (the interactive op's ctrl modifier). */
  invert?: boolean
  /** Symmetry axes bitflag {X:1,Y:2,Z:4}: each dab is also applied at its
   * SymAxisMap mirror images (p/normal sign-flipped about the local origin),
   * exactly like `SculptPaintOp.applyDab`. The test scene is object-local at the
   * origin, so the world-space dabs here are already in mirror space. */
  symmetryAxes?: number
  /** Object-space eye->surface ray for view-normal automasking; the same ray
   * serves every symmetry image (camera-relative mask). Omitted (the usual case
   * for a headless driver, which has no camera) = the mask is forced off. */
  viewDir?: number[]
  /** Test seam: run this sculptcore kernel instead of the tool's mapped one
   * (e.g. LAYERDRAW, whose LAYER_DRAW tool is hidden from the sculpt picker). */
  brushTypeOverride?: SculptBrushes
  /** Test seam: point command 0's attr handle `attrIdx` at `layerIndex`
   * (a per-domain AttrGroup index) after each dab's buildBrushProgram. */
  attrLayerOverride?: {attrIdx: number; layerIndex: number}
}): {dabs: number; skipped: boolean; completion?: Promise<void>} {
  const wasm = getWasmImmediate()!
  const {mesh, brush} = opts
  const radius = opts.radius ?? brush.radius
  const dist = opts.dist ?? 0
  // Dyntopo would desync the fixed grid topology the multires writeback
  // assumes — force it off on a multires level mesh (mirrors SculptPaintOp).
  const dtEnabled = brush.dynTopoSC.enabled && !mesh.multiresActive

  const brushType = opts.brushTypeOverride ?? toolToSculptBrush(brush.tool)
  if (brushType === undefined) {
    return {dabs: 0, skipped: true}
  }

  if (SculptPaintOp.meshLog === undefined) {
    SculptPaintOp.meshLog = wasm.manager.construct('sculptcore::meshlog::MeshLog')
  }
  const meshLog = SculptPaintOp.meshLog!

  // Mirror SculptPaintOp: show the painted attribute (color/polygroup).
  syncDisplayModeToBrush(mesh, brush.tool)

  // Poly-group: allocate a fresh incremented id (max existing + 1) for this
  // driver stroke. The interactive op also supports shift-to-extend; the driver
  // always starts a new group.
  const polyGroupId = brush.tool === SculptTools.POLYGROUP ? mesh.mesh.maxFaceGroup() + 1 : 0

  // Mirror the interactive op's non-accumulate handling (default = on; ACCUMULATE
  // bit re-enables accumulate) with one stroke-generation stamp for this stroke.
  const nonAccum = !(brush.flag & BrushFlags.ACCUMULATE)
  const strokeGen = ++SculptPaintOp.nextStrokeGen

  // Build the executor up-front so the step is opened via executor.beginStep —
  // the same boundary every client uses (the loop reuses this executor/brush).
  let {wasmExec, wasmBrush} = builSculptcoreBrush({
    wasm,
    brush,
    mesh,
    radius,
    invert: opts.invert ?? false,
    nonAccum,
    strokeGen,
  })
  wasmExec.meshLog = meshLog
  wasmExec.beginStep(dtEnabled)

  // Prime the primary image's view ray before tryBegin; the loop re-sets it
  // per image (the kernel reads it per dab from the ctx uniforms).
  applyDriverViewDir(wasmBrush, opts.viewDir, undefined)

  // GPU stroke branch (plans/gpuGlobalBrushes.md): world-space dabs marshal
  // identically on both paths (no per-dab raycast), so this driver is the
  // deterministic §8.2 parity gate. Headless drivers must OPT IN via
  // DEBUG.gpuBrush.allowNonModal (like the screen-space tester) — this
  // driver finishes asynchronously on the GPU path, and the many existing
  // tests that call it expect synchronous CPU strokes.
  let gpu = GpuStrokeController.tryBegin({
    wasm,
    mesh,
    wasmBrush,
    meshLog,
    brushType,
    modalRunning  : false,
    dyntopoEnabled: dtEnabled,
    autosmooth    : brush.autosmooth,
  })

  // Expand each input dab into its primary image plus SymAxisMap mirror images
  // (p/normal component-sign-flipped about the local origin), exactly like
  // SculptPaintOp.applyDab. Each image keeps its own previous-dab state so a
  // grab brush traces an independent path per mirror.
  const sym = opts.symmetryAxes ?? 0
  const muls = sym ? SymAxisMap[sym] : []
  const prevByImage: (Vector3 | undefined)[] = []
  const anchorByImage: (number[] | undefined)[] = []
  // Node-filter high-water mark for the stroke; see SculptPaintOp.maxFilterRadius.
  let maxFilterRadius = 0

  let dynParams: DynTopoParams | undefined = undefined
  let dabIdx = 0
  for (const dab of opts.dabs) {
    const images: {p: number[]; normal: number[]; image: number}[] = [{p: dab.p, normal: dab.normal, image: 0}]
    for (let i = 0; i < muls.length; i++) {
      const mul = muls[i]
      images.push({
        p     : [dab.p[0] * mul[0], dab.p[1] * mul[1], dab.p[2] * mul[2]],
        normal: [dab.normal[0] * mul[0], dab.normal[1] * mul[1], dab.normal[2] * mul[2]],
        image : i + 1,
      })
    }

    for (const img of images) {
      const r = builSculptcoreBrush({
        wasm,
        brush,
        mesh,
        radius,
        invert: opts.invert ?? false,
        wasmBrush,
        wasmExec,
        nonAccum,
        strokeGen,
      })
      wasmBrush = r.wasmBrush
      wasmExec = r.wasmExec

      if (brush.tool === SculptTools.POLYGROUP) {
        wasmBrush.activeGroup = polyGroupId
      }
      wasmBrush.strength = brush.strength
      wasmBrush.radius = radius
      wasmBrush.writeProps()
      wasmExec.meshLog = meshLog
      pushBrushDeviceInputs(wasmBrush, new PaintSample())

      applyDriverViewDir(wasmBrush, opts.viewDir, img.image === 0 ? undefined : muls[img.image - 1])

      // Dyntopo config before the deform (mirrors SculptPaintOp). Undefined = off.
      const dt = brush.dynTopoSC
      let params: DynTopoParams | undefined = undefined
      if (dtEnabled) {
        const {l_max, l_min} = dt.resolveEdgeGoal(radius, dist)
        if (!dynParams) {
          dynParams = wasm.manager.construct('sculptcore::dyntopo::DynTopoParams') as DynTopoParams
        }
        configureDynTopoParams(dynParams, dt, l_max, l_min)
        params = dynParams
      }

      // Grab-style brushes set grabFrom/grabTo; each mirror image traces its own
      // path. Mirrors the interactive op (#35): snakehook = per-dab; grab/kelvinlet
      // = anchored grabFrom + CUMULATIVE grabTo (from-orig kernel re-bases each dab)
      // + the dab centered on the anchor + the filter widened by the cumulative
      // drag. Symmetry: primary image re-bases from orig (Absolute), mirror images
      // add their pull onto it (Add).
      let dabCenter: number[] = img.p
      let filterRadius = radius
      const dabPolicy = resolveDabPolicy(brushType)
      if (dabPolicy.isGrab) {
        if (anchorByImage[img.image] === undefined) {
          anchorByImage[img.image] = [img.p[0], img.p[1], img.p[2]]
        }
        if (dabPolicy.incrementalGrab) {
          prevByImage[img.image] = applyGrabDabState(wasmBrush, img.p, prevByImage[img.image])
        } else {
          const a = anchorByImage[img.image]!
          const gf = wasmBrush.grabFrom.vec
          const gt = wasmBrush.grabTo.vec
          gf[0] = a[0]
          gf[1] = a[1]
          gf[2] = a[2]
          gt[0] = img.p[0] - a[0]
          gt[1] = img.p[1] - a[1]
          gt[2] = img.p[2] - a[2]
          dabCenter = a
          // An @unbounded kernel filters to its window cutoff R, not the brush
          // radius (see the interactive op).
          const fieldRadius = dabPolicy.unbounded ? radius * wasmBrush.unboundedExtent : radius
          filterRadius = fieldRadius + new Vector3(img.p).sub(new Vector3(a)).vectorLength()
          wasmExec.setGrabAccumAdd(img.image > 0)
          // From-orig grabs only; snakehook must keep its per-dab region (see
          // the interactive op).
          maxFilterRadius = Math.max(maxFilterRadius, filterRadius)
          filterRadius = maxFilterRadius
        }
      }

      // VDM carrier routing (X3 stage 4) — mirrors the interactive op: Draw
      // dabs on a store-attached mesh splat texels instead of moving verts.
      if (mesh.hasVdm && brush.tool === SculptTools.DRAW) {
        applyVdmSplatDab(wasm, mesh, meshLog, img.p, img.normal, radius, brush.strength, opts.invert ?? false)
        dabIdx++
        continue
      }

      if (gpu) {
        const ok = gpu.dab(dabCenter, img.normal, radius, filterRadius, img.image, nonAccum)
        if (!ok && gpu.stroke.stats.dispatches === 0) {
          gpu.abort()
          gpu = undefined
        }
      }
      if (!gpu || gpu.shadow) {
        const prog = wasm.manager.construct('sculptcore::brush::BrushProgram') as BrushProgram
        buildBrushProgram(prog, brushType, brush, radius, mesh)
        if (opts.attrLayerOverride !== undefined) {
          prog.setCommandAttrLayer(0, opts.attrLayerOverride.attrIdx, opts.attrLayerOverride.layerIndex)
        }
        wasmExec.applyDab(
          prog,
          wasm.float3(new Vector3(dabCenter)),
          wasm.float3(new Vector3(img.normal)),
          filterRadius,
          params ?? (0 as never),
          dabIdx + 1
        )
        prog[Symbol.dispose]()
      }
      dabIdx++
    }
  }

  wasmExec.endDynTopoStroke()
  if (dynParams) {
    dynParams[Symbol.dispose]()
  }

  if (gpu && !gpu.shadow) {
    // Final readback + endStroke apply + endStep, on the stroke's serialized
    // chain; callers await `completion` before reading geometry.
    const completion = gpu.finish(() => {
      wasmExec.endStep()
      mesh.multiresWriteback()
      mesh.regenTreeBatch()
    })
    return {dabs: opts.dabs.length, skipped: false, completion}
  }
  if (gpu) {
    gpu.finish(() => {})
  }
  wasmExec.endStep()
  mesh.multiresWriteback()
  mesh.regenTreeBatch()
  return {dabs: opts.dabs.length, skipped: false}
}

export interface SculptcoreStrokeRunResult {
  /** the executed op, on the toolstack — inspect or undo/redo it */
  tool: SculptPaintOp
  /** number of evenly-spaced dabs the driver emitted (after interpolation) */
  dabs: number
  /** resolves once the post-stroke viewport redraw completes */
  redrawPromise: Promise<void>
}

/** Enable dynamic topology on the tester's brush. `true` uses the brush default
 * detail; an object overrides the per-dab target edge length as a percentage of
 * the brush radius (PERCENT edge mode) — smaller = finer = more churn. */
export type StrokeTesterDyntopo = boolean | {edgeSizePercent?: number}

export interface SculptcoreStrokeTester {
  readonly ctx: ViewContext
  readonly meshLog: MeshLog | undefined
  readonly mesh: LiteMesh | undefined
  frameMeshInCamera(): void
  getBrush(opts: {
    sculptTool?: SculptTools
    brushSettings?: Partial<SculptBrush>
    dyntopo?: StrokeTesterDyntopo
  }): SculptBrush
  runStroke(opts: {
    points: ArrayLike<number>[]
    symmetryAxes?: number
    radius?: number
    pressure?: number
    sculptTool?: SculptTools
    brushSettings?: Partial<SculptBrush>
    dyntopo?: StrokeTesterDyntopo
    brush?: SculptBrush
  }): SculptcoreStrokeRunResult
  sampleStroke(opts: {
    points: ArrayLike<number>[]
    useCpp: boolean
    radius?: number
    pressure?: number
    sculptTool?: SculptTools
    brushSettings?: Partial<SculptBrush>
    brush?: SculptBrush
    /** StrokeSpaceMode override; the sculpt op is always SCREEN otherwise. */
    spaceMode?: number
  }): StrokeDabDump[]
  undo(): void
  redo(): void
}

/** One emitted dab, flattened to plain numbers so it survives `--dump` JSON.
 * Used by `tests/integration/stroke_driver_parity.test.ts` to diff the TS and
 * C++ samplers field by field. */
export interface StrokeDabDump {
  p: number[]
  dp: number[]
  screenP: number[]
  dScreenP: number[]
  vec: number[]
  viewvec: number[]
  vieworigin: number[]
  viewPlane: number[]
  anchorVec: number[]
  strokeS: number
  dstrokeS: number
  angle: number
  futureAngle: number
  strength: number
  radius: number
  w: number
  pressure: number
  liveAngle: number
  isInterp: boolean
  invert: boolean
  hit: boolean
  useAltBrush: boolean
}

declare global {
  interface Window {
    _sculptcoreStrokeTester: SculptcoreStrokeTester
  }
}

/**
 * Headless/CDP test driver for sculptcore strokes that goes through the *real*
 * `SculptPaintOp` + `BrushStrokeDriver` pipeline (projection, raycast,
 * object-local sample emission, even spacing, mirroring, undo logging) — the
 * programmatic counterpart to dragging the brush. Reach it as
 * `window._sculptcoreStrokeTester` over `--eval` / CDP. The active object must
 * be a `LiteMesh` and the sculpt tool mode active (the dab overlay path expects
 * `SculptCorePaintMode`).
 */
window._sculptcoreStrokeTester = {
  get ctx(): ViewContext {
    return getAppState().ctx
  },

  get meshLog(): MeshLog | undefined {
    return SculptPaintOp.meshLog
  },

  get mesh(): LiteMesh | undefined {
    const data = this.ctx.object?.data
    return data instanceof LiteMesh ? data : undefined
  },

  /** Frame the active mesh's bounding box in the viewport camera, so subsequent
   * normalized stroke points land on the surface.
   *
   * Forces a canonical projection size + camera orientation FIRST: the headless
   * screen layout is non-deterministic (the View3D area width and the inherited
   * camera orbit vary across boots), so without this the same normalized stroke
   * points project to different world positions and the screen-space dab spacing
   * changes — yielding bimodal (~2.4x) geometry. Pinning size + view direction
   * makes the tester reproducible. */
  frameMeshInCamera(): void {
    const view3d = this.ctx.view3d as View3D | undefined
    if (!view3d) {
      return
    }
    view3d.size = new Vector2([1024, 768])
    const cam = view3d.activeCamera
    cam.pos.loadXYZ(20, 0, 10)
    cam.target.loadXYZ(0, 0, 0)
    cam.up.loadXYZ(0, 0, 1)
    cam.regen_mats()
    view3d.viewSelected(this.ctx.object)
  },

  /** Resolve a brush for `sculptTool` (default CLAY) from the default-brush set,
   * with input dynamics disabled (deterministic) and `brushSettings` applied. */
  getBrush({
    sculptTool = SculptTools.CLAY,
    brushSettings = {},
    dyntopo = false,
  }: {
    sculptTool?: SculptTools
    brushSettings?: Partial<SculptBrush>
    dyntopo?: StrokeTesterDyntopo
  }): SculptBrush {
    let brush = DefaultBrushes.slotMap[sculptTool]
    if (brush === undefined) {
      throw new Error(`invalid sculpt tool ${sculptTool}`)
    }

    brush = brush.copy()
    brush.tool = sculptTool

    // disable all input dynamics by default so dabs are deterministic
    for (const dyn of brush.dynamics.channels) {
      dyn.useDynamics = false
    }

    if (dyntopo) {
      // Flip on the sculptcore dyntopo flag the stroke path reads
      // (brush.dynTopoSC.enabled) so strokes remesh — and finishStroke's auto-
      // defrag trigger engages.
      brush.dynTopoSC.flag |= DynTopoFlagsSC.ENABLED
      if (typeof dyntopo === 'object' && dyntopo.edgeSizePercent !== undefined) {
        brush.dynTopoSC.edgeMode = DynTopoEdgeModeSC.PERCENT
        brush.dynTopoSC.edgeSize = dyntopo.edgeSizePercent
      }
    }

    for (const k in brushSettings) {
      if (!(k in brush)) {
        throw new Error(`invalid brush setting ${k}`)
      }

      ;(brush as any)[k] = brushSettings[k as keyof SculptBrush]
    }

    return brush
  },

  /**
   * Run a stroke through `SculptPaintOp`. `points` are normalized screen-space
   * positions (0..1 over the viewport, [x,y] each); they are fed to the real
   * `BrushStrokeDriver`, which raycasts the mesh and emits evenly-spaced,
   * object-local `PaintSample`s exactly like an interactive drag. `radius` (px)
   * and `brushSettings`/`sculptTool` override the brush; pass an explicit `brush`
   * to skip resolution. The op runs non-modally through the toolstack, so it is
   * a normal undoable entry (`undo()`/`redo()` below, or ctrl-Z).
   */
  runStroke({
    points,
    symmetryAxes = 0,
    radius,
    pressure = 1,
    sculptTool,
    brushSettings,
    dyntopo,
    brush,
  }: {
    points: ArrayLike<number>[]
    symmetryAxes?: number
    radius?: number
    pressure?: number
    sculptTool?: SculptTools
    brushSettings?: Partial<SculptBrush>
    dyntopo?: StrokeTesterDyntopo
    brush?: SculptBrush
  }): SculptcoreStrokeRunResult {
    const ctx = this.ctx
    const view3d = ctx.view3d as View3D | undefined
    if (!view3d) {
      throw new Error('_sculptcoreStrokeTester.runStroke: no active view3d')
    }
    const mesh = this.mesh
    if (!mesh) {
      throw new Error('_sculptcoreStrokeTester.runStroke: active object is not a LiteMesh')
    }
    if (points.length === 0) {
      throw new Error('_sculptcoreStrokeTester.runStroke: need at least one point')
    }

    const resolvedBrush: SculptBrush = brush ?? this.getBrush({sculptTool, brushSettings, dyntopo})
    if (radius !== undefined) {
      resolvedBrush.radius = radius
    }

    const tool = new SculptPaintOp()
    tool.inputs.brush.setValue(resolvedBrush)
    tool.inputs.symmetryAxes.setValue(symmetryAxes)

    // modal_ctx feeds makeProjection / makeRayCast / getObjectMatrix while we
    // build samples below; we still run the op non-modally (see is_modal=false).
    tool.modal_ctx = ctx

    // Same flag-driven pick as the interactive path (modalStart).
    const driver = tool.makeDriver()
    const getParams = tool.makeParamProvider()

    // Normalized (0..1) viewport coords -> LOCAL view3d px, which is what both
    // drivers take (StrokeInput.x/y).
    const size = view3d.size!

    const samples: PaintSample[] = []
    const drain = () => {
      for (const ps of driver.poll()) {
        samples.push(ps)
      }
    }

    const invert = (resolvedBrush.flag & BrushFlags.INVERT) !== 0
    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      const input: StrokeInput = {
        ...getParams(pressure),
        x: p[0] * size[0],
        y: p[1] * size[1],
        pressure,
        tiltX: 0,
        tiltY: 0,
        twist: 0,
        invert,
        useAltBrush: false,
        time       : i,
        pointerType: 'mouse',
      }
      driver.push(input)
      drain()
    }
    driver.end()
    drain()
    driver.destroy?.()

    tool.inputs.samples.setValue(samples)

    // Run non-modally: execTool then does undoPre -> exec -> execPost
    // synchronously (exec replays inputs.samples through applyDab and closes the
    // meshlog step), as a normal undoable toolstack entry. undoPre() re-snapshots
    // symmetryAxes from ctx.toolmode (A.4, for the real interactive/replay path),
    // which would silently clobber the override above -- drive it through the
    // toolmode too, for the duration of this call, so callers asking for
    // symmetryAxes: 0 (e.g. every Anchored/Drag Dot preview-rollback test) get it.
    const paintMode = ctx.toolmode as SculptCorePaintMode | undefined
    const prevSymmetryAxes = paintMode?.symmetryAxes
    if (paintMode) {
      paintMode.symmetryAxes = symmetryAxes
    }
    tool.is_modal = false
    try {
      ctx.toolstack.execTool(ctx, tool)
    } finally {
      if (paintMode && prevSymmetryAxes !== undefined) {
        paintMode.symmetryAxes = prevSymmetryAxes
      }
    }

    // The interactive path leans on the render loop to refresh the spatial tree;
    // do it explicitly so headless callers see up-to-date geometry immediately.
    mesh.regenTreeBatch()

    return {tool, dabs: samples.length, redrawPromise: window.redraw_viewport_p(true)}
  },

  /**
   * Sample a stroke through one sampler and return the raw dabs *without*
   * applying them — the parity gate for the C++ driver. `useCpp` picks
   * `NativeStrokeDriver` (sculptcore) over the TS `BrushStrokeDriver`,
   * bypassing the `sculptcore.cpp_stroke_driver` flag so one boot can run both.
   */
  sampleStroke({
    points,
    useCpp,
    radius,
    pressure = 1,
    sculptTool,
    brushSettings,
    brush,
    spaceMode,
  }: {
    points: ArrayLike<number>[]
    useCpp: boolean
    radius?: number
    pressure?: number
    sculptTool?: SculptTools
    brushSettings?: Partial<SculptBrush>
    brush?: SculptBrush
    spaceMode?: number
  }): StrokeDabDump[] {
    const ctx = this.ctx
    const view3d = ctx.view3d as View3D | undefined
    if (!view3d) {
      throw new Error('_sculptcoreStrokeTester.sampleStroke: no active view3d')
    }
    if (!this.mesh) {
      throw new Error('_sculptcoreStrokeTester.sampleStroke: active object is not a LiteMesh')
    }

    const resolvedBrush: SculptBrush = brush ?? this.getBrush({sculptTool, brushSettings})
    if (radius !== undefined) {
      resolvedBrush.radius = radius
    }

    const tool = new SculptPaintOp()
    tool.inputs.brush.setValue(resolvedBrush)
    tool.modal_ctx = ctx
    if (spaceMode !== undefined) {
      tool.getSpaceMode = () => spaceMode as StrokeSpaceMode
    }

    const driver = tool.makeDriver(useCpp)
    const getParams = tool.makeParamProvider()
    const size = view3d.size!
    const invert = (resolvedBrush.flag & BrushFlags.INVERT) !== 0

    const dabs: StrokeDabDump[] = []
    const drain = () => {
      for (const ps of driver.poll()) {
        dabs.push(dumpDab(ps))
      }
    }

    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      driver.push({
        ...getParams(pressure),
        x: p[0] * size[0],
        y: p[1] * size[1],
        pressure,
        tiltX: 0,
        tiltY: 0,
        twist: 0,
        invert,
        useAltBrush: false,
        time       : i,
        pointerType: 'mouse',
      })
      drain()
    }
    driver.end()
    drain()
    driver.destroy?.()

    return dabs
  },

  /** Undo the last stroke through the toolstack (the real ctrl-Z path). */
  undo(): void {
    this.ctx.toolstack.undo()
  },

  /** Redo the last undone stroke through the toolstack. */
  redo(): void {
    this.ctx.toolstack.redo()
  },
}

/** Flatten a PaintSample to plain arrays/numbers so it survives `--dump` JSON. */
function dumpDab(ps: PaintSample): StrokeDabDump {
  return {
    p          : [ps.p[0], ps.p[1], ps.p[2], ps.p[3]],
    dp         : [ps.dp[0], ps.dp[1], ps.dp[2], ps.dp[3]],
    screenP    : [ps.screenP[0], ps.screenP[1]],
    dScreenP   : [ps.dScreenP[0], ps.dScreenP[1]],
    vec        : [ps.vec[0], ps.vec[1], ps.vec[2]],
    viewvec    : [ps.viewvec[0], ps.viewvec[1], ps.viewvec[2]],
    vieworigin : [ps.vieworigin[0], ps.vieworigin[1], ps.vieworigin[2]],
    viewPlane  : [ps.viewPlane[0], ps.viewPlane[1], ps.viewPlane[2]],
    anchorVec  : [ps.anchorVec[0], ps.anchorVec[1], ps.anchorVec[2]],
    strokeS    : ps.strokeS,
    dstrokeS   : ps.dstrokeS,
    angle      : ps.angle,
    futureAngle: ps.futureAngle,
    strength   : ps.strength,
    radius     : ps.radius,
    w          : ps.w,
    pressure   : ps.pressure,
    liveAngle  : ps.liveAngle,
    isInterp   : ps.isInterp,
    invert     : ps.invert,
    hit        : ps.hit,
    useAltBrush: ps.useAltBrush,
  }
}

// Headless/CDP-friendly entry point:
// _testSculptcoreStroke(toolInt, dabs?, radius?, symmetryAxes?)
// resolves the active LiteMesh + the default brush for the tool and runs a
// stroke. dabs are world-space [{p:[x,y,z], normal:[x,y,z]}]; symmetryAxes is
// the {X:1,Y:2,Z:4} bitflag (0 = none).
;(globalThis as unknown as any)._testSculptcoreStroke = function (
  toolInt: number,
  dabs?: {p: number[]; normal: number[]}[],
  radius?: number,
  symmetryAxes?: number
) {
  const mesh = peekAppState()?.ctx?.object?.data
  if (!(mesh instanceof LiteMesh)) {
    return {error: 'active object is not a LiteMesh'}
  }
  const brush = DefaultBrushes.slotMap[toolInt] as SculptBrush | undefined
  if (!brush) {
    return {error: `no default brush for tool ${toolInt}`}
  }
  brush.tool = toolInt
  return runSculptcoreStroke({
    mesh,
    brush,
    dabs: dabs ?? [{p: [0, 0, 0], normal: [0, 0, 1]}],
    radius,
    symmetryAxes,
  })
}

// Headless/CDP access to the sculpt undo log (created lazily by the first
// stroke); lets --eval probes drive MeshLog.undo/redo directly.
;(globalThis as unknown as any)._testSculptcoreMeshLog = () => SculptPaintOp.meshLog
