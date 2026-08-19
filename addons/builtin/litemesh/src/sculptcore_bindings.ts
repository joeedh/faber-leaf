import {CommandExecutor, Brush as WasmBrush, BrushProgram, BrushMetadata, DynTopoParams} from '@sculptcore/api'
import {FalloffShape} from '@sculptcore/api/sculptcore/gpu/FalloffShape'
import {IWasmInterface, getWasmImmediate} from '@sculptcore/api/api'
import {SculptBrush, DynTopoSettingsSC, DynTopoFlagsSC} from '../../../../scripts/brush/index'
import {StructType} from '@litestl/typescript-runtime'
import {LiteMesh} from './index'
import {SculptBrushes} from '@sculptcore/api/sculptcore/brush/SculptBrushes'
import {SculptTools, BrushFlags, StrokeMethod, isPlaneFamilyTool} from '../../../../scripts/brush/brush_base'
import {PaintSample} from './stroke_base.js'
import {FalloffKind} from '@sculptcore/api/sculptcore/gpu/FalloffKind'
import {FeatureFlags} from '@framework/api'

/** Mirror of C++ enum DeviceType (prop_dynamics.h). */
const DeviceType = {
  PRESSURE : 0,
  TILTX    : 1,
  TILTY    : 2,
  SPEED    : 3,
  ANGLE    : 4,
  CURVATURE: 5,
  TWIST    : 6,
} as const

/** Mirror of C++ enum BasicMix (litestl/math/mix.h). */
const BasicMix = {LINEAR: 0, MULTIPLY: 1, ADD: 2, SUBTRACT: 3, DIFFERENCE: 4} as const

/**
 * Mirror of C++ enum `BrushProp` (brush.h). Float props are addressed by id,
 * not name, across the binding — the TS runtime can't marshal a JS string into
 * a `util::string` parameter.
 */
const BrushProp = {STRENGTH: 0, RADIUS: 1, AUTOSMOOTH: 2, PLANEOFF: 3, SPACING: 4} as const

/**
 * TS BrushDynamics channel → sculptcore Brush prop id. Only channels backed by
 * a bound float prop are bridged; channels with no sculptcore equivalent (rake,
 * concaveFilter, …) are skipped.
 */
const DYNAMIC_CHANNEL_TO_PROP: Record<string, number> = {
  strength  : BrushProp.STRENGTH,
  radius    : BrushProp.RADIUS,
  autosmooth: BrushProp.AUTOSMOOTH,
}
const DYN_CURVE_SAMPLES = 32

/**
 * Fixed common float props — driven by the int-keyed loop in
 * configureBrushDynamics, so the per-kernel manifest pass skips any uniform that
 * shares one of these names (a kernel can redeclare `radius`, etc.).
 */
const COMMON_PROP_NAMES = new Set(['strength', 'radius', 'spacing', 'planeoff', 'autosmooth'])

/**
 * Configure the brush's pen-dynamics stack from the TS BrushDynamics channels
 * (called once per stroke). Each channel with `useDynamics` adds a PRESSURE
 * device whose response curve is the channel's `Curve1D` baked into a 32-entry
 * table, applied multiplicatively — this is the C++-side replacement for the
 * old TS `getchannel()` curve eval.
 *
 * Two prop families are bridged: the fixed common props (strength/radius/...,
 * int-keyed) and — when `wasmExec`/`brushType` are supplied — the active
 * kernel's scalar `uniform`s, enumerated from the C++ manifest (Wave 5). The
 * binding runtime can't pass a JS string into a `util::string` arg, so per-kernel
 * uniforms are addressed by their 0-based manifest index; C++ resolves the index
 * to the uniform name and routes through the same by-name dynamics API.
 */
export function configureBrushDynamics(
  wasmBrush: WasmBrush,
  brush: SculptBrush,
  wasmExec?: CommandExecutor,
  brushType?: SculptBrushes
): void {
  for (const propId of Object.values(DYNAMIC_CHANNEL_TO_PROP)) {
    wasmBrush.clearPropDynamics(propId)
  }
  for (const chanName in DYNAMIC_CHANNEL_TO_PROP) {
    const propId = DYNAMIC_CHANNEL_TO_PROP[chanName]
    const ch = brush.dynamics.getChannel(chanName, false)
    if (!ch?.useDynamics) {
      continue
    }
    wasmBrush.addPropDynamic(propId, DeviceType.PRESSURE, BasicMix.MULTIPLY, 1.0)
    for (let i = 0; i < DYN_CURVE_SAMPLES; i++) {
      const x = i / (DYN_CURVE_SAMPLES - 1)
      const y = ch.curve.evaluate(x)
      wasmBrush.setPropDynamicSample(propId, DeviceType.PRESSURE, i, DYN_CURVE_SAMPLES, y)
    }
  }

  // Per-kernel scalar uniforms (Wave 5): drive any dynamic-capable uniform of the
  // active brush that has a matching BrushDynamics channel. Skipped when the tool
  // has no sculptcore kernel (brushType === undefined).
  if (wasmExec === undefined || brushType === undefined) {
    return
  }
  const count = wasmExec.queryUniformManifest(brushType)
  for (let idx = 0; idx < count; idx++) {
    const entry = wasmExec.queriedUniformEntry(idx)
    if (!entry || !entry.dynamic || COMMON_PROP_NAMES.has(entry.name)) {
      continue
    }
    wasmExec.clearUniformDynamics(idx)
    const ch = brush.dynamics.getChannel(entry.name, false)
    if (!ch?.useDynamics) {
      continue
    }
    wasmExec.addUniformDynamic(idx, DeviceType.PRESSURE, BasicMix.MULTIPLY, 1.0)
    for (let i = 0; i < DYN_CURVE_SAMPLES; i++) {
      const x = i / (DYN_CURVE_SAMPLES - 1)
      wasmExec.setUniformDynamicSample(idx, DeviceType.PRESSURE, i, DYN_CURVE_SAMPLES, ch.curve.evaluate(x))
    }
  }
}

/**
 * Push per-dab device samples for the next loadProps. Only PRESSURE is consumed
 * today (the one device `configureBrushDynamics` wires up); tilt/twist are
 * pushed but currently inert until a channel maps to them. Mouse has no
 * pressure, so it reads as full strength (curve(1) ≈ 1).
 */
export function pushBrushDeviceInputs(wasmBrush: WasmBrush, ps: PaintSample): void {
  wasmBrush.clearDeviceInputs()
  wasmBrush.pushDeviceInput(DeviceType.PRESSURE, ps.pressure)
  wasmBrush.pushDeviceInput(DeviceType.TILTX, (ps.tiltX || 0) / 90)
  wasmBrush.pushDeviceInput(DeviceType.TILTY, (ps.tiltY || 0) / 90)
  const twist = ps.twist
  if (twist !== undefined) {
    wasmBrush.pushDeviceInput(DeviceType.TWIST, twist / 360)
  }
}

/**
 * Maps a TS `SculptTools` brush tool to the sculptcore `SculptBrushes` kernel
 * that implements it. Tools with no sculptcore equivalent are absent from the
 * map; the caller (`SculptPaintOp`) warns and skips those.
 *
 * The plane family CLAY/SCRAPE/FILL all run the `plane` kernel; the per-tool
 * planeoff/planeSide uniforms (set in `configureToolUniforms`) select build-up
 * / cut / fill. WING_SCRAPE runs its own kernel.
 *
 * The SMOOTH tool routes to the boundary-aware BSMOOTH kernel — bsmooth replaces
 * the plain smooth brush (ImmediateTODOs). bsmooth reduces to plain Laplacian
 * smoothing when no boundaries are marked, so it's a transparent drop-in; the
 * legacy `smooth` kernel survives only for the C++ test harness.
 */
export const TOOL_TO_SCULPTBRUSH: Partial<Record<SculptTools, SculptBrushes>> = {
  [SculptTools.DRAW]         : SculptBrushes.DRAW,
  [SculptTools.SMOOTH]       : SculptBrushes.BSMOOTH,
  [SculptTools.INFLATE]      : SculptBrushes.INFLATE,
  [SculptTools.SHARP]        : SculptBrushes.SHARP,
  [SculptTools.PINCH]        : SculptBrushes.PINCH,
  [SculptTools.MASK_PAINT]   : SculptBrushes.MASK,
  [SculptTools.CLAY]         : SculptBrushes.CLAY,
  [SculptTools.SCRAPE]       : SculptBrushes.SCRAPE,
  [SculptTools.FILL]         : SculptBrushes.FILL,
  [SculptTools.WING_SCRAPE]  : SculptBrushes.WINGSCRAPE,
  [SculptTools.COLOR]        : SculptBrushes.COLOR,
  [SculptTools.PAINT_SMOOTH] : SculptBrushes.COLORSMOOTH,
  [SculptTools.POLYGROUP]    : SculptBrushes.POLYGROUP,
  [SculptTools.KELVINLET]    : SculptBrushes.KELVINLET,
  [SculptTools.GRAB]         : SculptBrushes.GRAB,
  [SculptTools.SNAKE]        : SculptBrushes.SNAKEHOOK,
  [SculptTools.FEATURE_ALIGN]: SculptBrushes.FEATURE_ALIGN,
  [SculptTools.LAYER_DRAW]   : SculptBrushes.LAYERDRAW,
  [SculptTools.ENHANCE]      : SculptBrushes.ENHANCE,
}

/** Resolve a TS sculpt tool to its sculptcore kernel, or undefined if none. */
export function toolToSculptBrush(tool: SculptTools): SculptBrushes | undefined {
  return TOOL_TO_SCULPTBRUSH[tool]
}

/** One retargetable `attr` handle of a kernel: its manifest index (what
 * `BrushProgram.setCommandAttrLayer` addresses) and the `mesh::AttrUse` category
 * whose active layer the host should point it at. */
export interface DabAttrTarget {
  attrIdx: number
  use: number
}

/**
 * Everything a host needs to shape a dab for one kernel, all of it emitted by
 * that kernel's sbrush annotations — so adding a brush never adds a TS
 * conditional. See sculptcore/documentation/plans/brushMetadataToTS-2026-07-28.md.
 */
export interface DabPolicy {
  /** `@incremental`: grabFrom = the live dab center, grabTo = the step since the
   * last dab. Region tracks the cursor (snakehook). */
  incrementalGrab: boolean
  /** `@grabmode`: an anchored stroke deforms a region FIXED at the stroke anchor
   * from each vert's orig position, with a cumulative grabTo and a latched
   * (never-shrinking) node-filter radius. */
  anchoredGrab: boolean
  /** Either grab shape — the tool drives grabFrom/grabTo and takes raw
   * (non-interpolated) pointer events. */
  isGrab: boolean
  /** `@unbounded`: the field carries no falloff of its own, so the node filter
   * must reach `radius * unboundedExtent`, not `radius`. */
  unbounded: boolean
  /** `@relaxation`: inverting a relax-toward-the-mean kernel diverges. */
  ignoresInvert: boolean
  /** Retargetable attr handles, in manifest order. */
  attrs: DabAttrTarget[]
}

/** Stroke-independent metadata query object, built once on first use. */
let brushMetadata: BrushMetadata | undefined
const dabPolicyCache = new Map<SculptBrushes, DabPolicy>()

/**
 * The kernel policy for `brushType`, memoized — it is fixed for the life of the
 * process (codegen output), so a stroke can call this per dab.
 */
export function resolveDabPolicy(brushType: SculptBrushes): DabPolicy {
  const cached = dabPolicyCache.get(brushType)
  if (cached !== undefined) {
    return cached
  }
  const policy: DabPolicy = {
    incrementalGrab: false,
    anchoredGrab   : false,
    isGrab         : false,
    unbounded      : false,
    ignoresInvert  : false,
    attrs          : [],
  }
  const wasm = getWasmImmediate()
  if (wasm === undefined) {
    // Pre-init (no engine yet): don't memoize a all-false answer.
    return policy
  }
  if (brushMetadata === undefined) {
    brushMetadata = wasm.manager.construct('sculptcore::brush::BrushMetadata') as BrushMetadata
  }
  const flags = brushMetadata.queryBrushFlags(brushType)
  if (flags) {
    policy.incrementalGrab = flags.incremental
    policy.anchoredGrab = flags.grabModeCapable
    policy.isGrab = flags.incremental || flags.grabModeCapable
    policy.unbounded = flags.unbounded
    policy.ignoresInvert = flags.relaxesBase
  }
  const count = brushMetadata.queryAttrManifest(brushType)
  for (let attrIdx = 0; attrIdx < count; attrIdx++) {
    const entry = brushMetadata.queriedAttrEntry(attrIdx)
    // A fixed layer name is an engine-internal binding, not retargetable.
    if (!entry || entry.use === 0 || entry.boundName !== '') {
      continue
    }
    policy.attrs.push({attrIdx, use: entry.use})
  }
  dabPolicyCache.set(brushType, policy)
  return policy
}

/** The policy for a TS tool; all-false when the tool has no sculptcore kernel. */
export function resolveToolDabPolicy(tool: SculptTools): DabPolicy {
  const brushType = TOOL_TO_SCULPTBRUSH[tool]
  if (brushType === undefined) {
    return {
      incrementalGrab: false,
      anchoredGrab   : false,
      isGrab         : false,
      unbounded      : false,
      ignoresInvert  : false,
      attrs          : [],
    }
  }
  return resolveDabPolicy(brushType)
}

/**
 * (Re)build a composite brush program for one dab: the main brush command,
 * plus a chained BSMOOTH command (autosmooth) when `brush.autosmooth > 0`.
 *
 * Autosmooth uses the boundary-aware BSMOOTH kernel (bsmooth replaces smooth),
 * so it preserves marked seams/sharp/polygroup borders just like the smooth
 * brush. The command strength is `autosmooth` directly: the `strength` intrinsic
 * is `strength * falloff` and the smooth kernel applies it as a relative
 * Laplacian blend that doesn't scale by radius. The program runs over the same
 * node set, so BSMOOTH re-snapshots `co_prev` after the main pass and smooths
 * the deformed result.
 */
export function buildBrushProgram(
  prog: BrushProgram,
  mainBrushType: SculptBrushes,
  brush: SculptBrush,
  radius: number,
  mesh?: LiteMesh
): void {
  prog.clear()

  // Point each retargetable `attr` handle the kernel declares (its `@use(...)`
  // category) at the mesh layer active for that category. -1 (no active layer)
  // leaves the codegen default ensure-by-name binding in place.
  const bindAttrLayers = (cmdIdx: number): void => {
    if (!mesh) {
      return
    }
    for (const target of resolveDabPolicy(mainBrushType).attrs) {
      const layer = mesh.activeAttrLayerIndex(target.use)
      if (layer >= 0) {
        prog.setCommandAttrLayer(cmdIdx, target.attrIdx, layer)
      }
    }
  }

  // The dedicated Smooth tools (geometry BSMOOTH, color COLORSMOOTH) iterate the
  // blend step up to 4× with strength (strength 0 → 0 passes, 2.0 → 4 passes).
  // Each pass is a stable per-vertex blend (capped at 1.0); the pass count carries
  // the total smoothing, which avoids the >1 overshoot a single high-strength step
  // produces. Pressure dynamics still modulate each pass (the override is a base
  // value loadProps resolves through the device-input stack). Default strength
  // 0.5 → 1 pass, bit-identical to the pre-iteration single command.
  if (mainBrushType === SculptBrushes.BSMOOTH || mainBrushType === SculptBrushes.COLORSMOOTH) {
    const iters = Math.max(0, Math.min(4, Math.round(brush.strength * 2)))
    const passStrength = Math.min(brush.strength, 1.0)
    for (let j = 0; j < iters; j++) {
      const idx = prog.addCommand(mainBrushType)
      prog.setCommandFloat(idx, BrushProp.STRENGTH, passStrength)
      prog.setCommandInvert(idx, false)
      bindAttrLayers(idx)
    }
    return
  }

  const mainIdx = prog.addCommand(mainBrushType)
  bindAttrLayers(mainIdx)

  if (brush.autosmooth > 0 && radius > 0) {
    const smoothStrength = brush.autosmooth
    const i = prog.addCommand(SculptBrushes.BSMOOTH)
    prog.setCommandFloat(i, BrushProp.STRENGTH, smoothStrength)
    // Autosmooth always smooths forward, even when the main command is inverted.
    prog.setCommandInvert(i, false)
  }
}

/** Depth of the Wing Scrape apex ridge below the surface point, in units of
 * brush radius — Scrape's plane offset. Shared with the viewport preview so it
 * can't drift from the kernel. */
export function wingApexOffset(brush: SculptBrush): number {
  return -0.05 + brush.planeoff * 0.1
}

/**
 * Configure the plane-family + wing + falloff uniforms on `wasmBrush` for the
 * active TS tool. Clay/Scrape/Fill share one kernel, selected by `planeoff`
 * (signed offset ×radius) and `planeSide` (+1/-1); SQUARE-flagged brushes use
 * the stroke-aligned oriented Box falloff (the executor sets falloff_dir =
 * strokeDir per dab).
 *
 * Must run before the per-dab `writeProps()` so the props-backed `planeoff`
 * round-trips through `loadProps`; `planeSide` / `falloff_shape` are plain
 * members that `loadProps` leaves untouched.
 */
export function configureToolUniforms(wasmBrush: WasmBrush, brush: SculptBrush): void {
  wasmBrush.falloff_shape = FalloffShape.SPHERICAL
  wasmBrush.planeoff = 0.0
  wasmBrush.planeSide = 1.0

  switch (brush.tool) {
    case SculptTools.CLAY:
      // Plane above the surface; pull verts below it up (build material up).
      wasmBrush.planeoff = 0.05 + brush.planeoff * 0.1
      wasmBrush.planeSide = 1.0
      break
    case SculptTools.SCRAPE:
      // Plane below the surface; pull verts above it down (cut away).
      wasmBrush.planeoff = -0.05 + brush.planeoff * 0.1
      wasmBrush.planeSide = -1.0
      break
    case SculptTools.FILL:
      // Plane at the surface; fill cavities behind it up to the plane.
      wasmBrush.planeoff = brush.planeoff * 0.1
      wasmBrush.planeSide = 1.0
      break
    case SculptTools.WING_SCRAPE:
      // Half-angle of the two stroke-following wing planes (brush prop is in
      // degrees, the kernel's Rodrigues rotation wants radians).
      wasmBrush.wingAngle = brush.wingAngle * (Math.PI / 180.0)
      // The wings' shared apex line sinks below the surface exactly like
      // Scrape's plane — without it nothing on a flat face is above a wing.
      wasmBrush.planeoff = wingApexOffset(brush)
      wasmBrush.planeSide = -1.0
      break
    case SculptTools.COLOR: {
      // Paint color — a bound float4, written elementwise through its `vec` view.
      const vec = (wasmBrush.brushColor as unknown as {vec: number[]}).vec
      for (let i = 0; i < 4; i++) {
        vec[i] = brush.color[i] ?? 0
      }
      // Blend mode (color.sbrush `mixMode` switch; matches ColorMixModes).
      wasmBrush.mixMode = brush.colorMixMode
      break
    }
  }

  wasmBrush.falloff_kind = FalloffKind.CURVE
  let t = 0
  const dt = 1.0 / (wasmBrush.falloffCurveSize - 1)
  for (let i = 0; i < wasmBrush.falloffCurveSize; i++, t += dt) {
    const f = brush.falloff.evaluate(t)
    wasmBrush.setFalloffCurveEntry(i, f)
  }

  // SQUARE brushes get the stroke-aligned oriented Box falloff: equal in-plane
  // half-extents (a square footprint) and a large along-normal extent so the
  // normal axis never clips the dab (a square column through the surface).
  if (brush.flag & BrushFlags.SQUARE) {
    wasmBrush.falloff_shape = FalloffShape.BOX
    const ext = (wasmBrush.falloff_extent as unknown as {vec: number[]}).vec
    ext[0] = 1.0
    ext[1] = 1.0
    ext[2] = 1000.0
  }
}

/**
 * Copy a resolved {@link DynTopoSettingsSC} onto a bound C++ `DynTopoParams` for
 * one dab. `l_max`/`l_min` are pre-resolved in TS (DynTopoSettingsSC.resolveEdgeGoal)
 * so sculptcore stays camera-free. The enum/flags map 1:1 onto the C++ fields.
 */
export function configureDynTopoParams(
  params: DynTopoParams,
  dt: DynTopoSettingsSC,
  l_max: number,
  l_min: number
): void {
  params.l_max = l_max
  params.l_min = l_min
  // DynTopoSCMode mirrors sculptcore::dyntopo::DynTopoMode int values.
  params.mode = dt.mode as unknown as DynTopoParams['mode']
  params.grade = dt.grade
  params.max_rounds = dt.maxRounds
  params.max_splits = dt.maxSplits
  params.max_collapses = dt.maxCollapses
  params.smooth_lambda = dt.smoothLambda
  params.do_flips = !!(dt.flag & DynTopoFlagsSC.DO_FLIPS)
  params.do_smooth = !!(dt.flag & DynTopoFlagsSC.DO_SMOOTH)
  params.preserve_features = !!(dt.flag & DynTopoFlagsSC.PRESERVE_FEATURES)
}

export function builSculptcoreBrush({
  wasm,
  brush,
  wasmBrush,
  radius,
  invert,
  wasmExec,
  mesh,
  nonAccum = false,
  strokeGen = 0,
  cullBackfaces,
}: {
  wasm: IWasmInterface
  brush: SculptBrush
  wasmBrush?: WasmBrush
  radius: number
  invert: boolean
  wasmExec?: CommandExecutor
  mesh: LiteMesh
  /** Non-accumulate mode for this stroke + its monotonic generation stamp (see
   * nonAccumMode.md). The executor ignores nonAccum for non-deform (paint /
   * global) brushes, which are never accumulable. */
  nonAccum?: boolean
  strokeGen?: number
  /** Backface culling in force for this stroke, already resolved through
   * BrushFlags.SHARED_CULL_BACKFACES by the tool mode. Omitted = use the
   * brush's own CULL_BACKFACES flag. */
  cullBackfaces?: boolean
}) {
  let freshBrush = false
  if (wasmBrush === undefined) {
    wasmBrush = wasm.manager.construct('sculptcore::brush::Brush')
    freshBrush = true
    if (wasmExec !== undefined) {
      wasmExec[Symbol.dispose]()
      wasmExec = undefined
    }
  }

  // sync properties
  const planeFamily = isPlaneFamilyTool(brush.tool)
  const effInvert = invert && !resolveToolDabPolicy(brush.tool).ignoresInvert
  wasmBrush.strength = brush.strength
  wasmBrush.radius = radius
  // Plane brushes invert by flipping the plane (below), not by negating
  // strength — negative strength would push verts away from the plane.
  // Color paint inverts by painting the secondary color (below) instead.
  wasmBrush.invert = effInvert && !planeFamily && brush.tool !== SculptTools.COLOR
  wasmBrush.spacing = brush.spacing
  wasmBrush.autosmooth = brush.autosmooth
  // Pinch (sharp/pinch kernels) and smooth projection (bsmooth volume
  // preservation) are @static uniforms read straight off these members.
  wasmBrush.pinch = brush.pinch
  wasmBrush.projection = brush.smoothProj
  // Feature-align rake strength (read by the featurealign kernel as ctx.brush.rake).
  wasmBrush.rake = brush.rake
  // Cavity automasking: a per-vertex convexity factor the executor computes and
  // strength() multiplies in (automask.h). Booleans ride BrushFlags bits.
  wasmBrush.automask_cavity = !!(brush.flag & BrushFlags.AUTOMASK_CAVITY)
  wasmBrush.cavity_inverted = !!(brush.flag & BrushFlags.AUTOMASK_CAVITY_INVERT)
  wasmBrush.cavity_factor = brush.cavityFactor
  wasmBrush.cavity_blur_steps = brush.cavityBlurSteps
  // Enhance-details params (read by the host pre-pass in enhance.h).
  wasmBrush.enhance_rings = brush.enhanceRings
  wasmBrush.enhance_inner = brush.enhanceInner
  // View-normal automasking: fades verts whose normal turns edge-on to the view
  // (automask.h). The angles are degrees in TS, radians in the engine; viewDir
  // itself is set per dab by the caller.
  wasmBrush.automask_view_normal = !!(brush.flag & BrushFlags.AUTOMASK_VIEW_NORMAL)
  wasmBrush.cull_backfaces = cullBackfaces ?? !!(brush.flag & BrushFlags.CULL_BACKFACES)
  wasmBrush.view_normal_limit = brush.viewNormalLimit * (Math.PI / 180)
  wasmBrush.view_normal_falloff = brush.viewNormalFalloff * (Math.PI / 180)
  wasmBrush.cavity_use_curve = !!(brush.flag & BrushFlags.AUTOMASK_CAVITY_CURVE)
  if (wasmBrush.cavity_use_curve) {
    let ct = 0
    const cdt = 1.0 / (wasmBrush.cavityCurveSize - 1)
    for (let i = 0; i < wasmBrush.cavityCurveSize; i++, ct += cdt) {
      wasmBrush.setCavityCurveEntry(i, brush.cavityCurve.evaluate(ct))
    }
  }

  // Per-tool plane / wing / falloff uniforms (runs before the caller's
  // writeProps() so props-backed scalars round-trip through loadProps).
  configureToolUniforms(wasmBrush, brush)
  if (effInvert && planeFamily) {
    // Inverted clay digs, inverted scrape builds: mirror the plane setup.
    wasmBrush.planeoff = -wasmBrush.planeoff
    wasmBrush.planeSide = -wasmBrush.planeSide
  }
  if (effInvert && brush.tool === SculptTools.COLOR) {
    const vec = (wasmBrush.brushColor as unknown as {vec: number[]}).vec
    for (let i = 0; i < 4; i++) {
      vec[i] = brush.bgcolor[i] ?? 0
    }
  }

  if (wasmExec === undefined) {
    const st = wasm.manager.get('sculptcore::brush::CommandExecutor') as StructType
    const ctor = st.findConstructor('main')!
    wasmExec = wasm.manager.constructWith(ctor, mesh.spatial, wasmBrush) as CommandExecutor
    // BSMOOTH (the smooth brush + autosmooth) reads neighbors from the CSR ring1
    // cache, not the live disk — a freshly built LiteMesh doesn't maintain live
    // disk links, so a LiveDisk smooth would find no neighbors and no-op.
    // (1 = NeighborMode::Csr)
    wasmExec.setNeighborMode(1)
  }

  // Non-accumulate stroke state (deform brushes measure from the stroke-start
  // position, derived as `co - .brush.disp.vec` under strokeGen). Pushed each
  // dab — cheap, and keeps a reused executor in sync with the active stroke.
  wasmExec.setNonAccum(nonAccum)
  // Whether a `@grabmode` kernel (grab / kelvinlet) takes the from-orig fixed-
  // region policy is a property of the stroke, not the kernel: the same field
  // dragged along a path accumulates like any other brush. Anchored is the one
  // mode with a stroke-start origin to deform from.
  wasmExec.setAnchoredGrab(brush.strokeMethod === StrokeMethod.ANCHORED)
  wasmExec.setStrokeGen(strokeGen)

  // Pen-dynamics stack only needs (re)building when the brush is fresh — its
  // channels/curves are fixed for the stroke. Runs after the executor exists so
  // the per-kernel uniform pass can enumerate the active brush's manifest.
  if (freshBrush) {
    configureBrushDynamics(wasmBrush, brush, wasmExec, toolToSculptBrush(brush.tool))
  }

  return {wasmExec, wasmBrush}
}
