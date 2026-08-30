import {util, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import {nstructjs} from '../path.ux/pathux.js'

import {DynTopoEdgeModeSC, DynTopoSCMode, DynTopoFlagsSC, DynTopoOverridesSC} from './brush_base'

function feq(a: number, b: number) {
  return Math.abs(a - b) < 0.00001
}

// Property/flag key -> DynTopoOverridesSC enum-key (used by the tool-mode Proxy
// to decide whether a key resolves from the brush override or the tool default).
const apiKeyMap: {[k: string]: string} = {
  edgeMode      : 'EDGE_MODE',
  edgeSize      : 'EDGE_SIZE',
  collapseRatio : 'COLLAPSE_RATIO',
  grade         : 'GRADE',
  mode          : 'MODE',
  smoothLambda  : 'SMOOTH_LAMBDA',
  maxSplits     : 'MAX_SPLITS',
  maxCollapses  : 'MAX_COLLAPSES',
  maxRounds     : 'MAX_ROUNDS',
  dynTopoSpacing: 'DYNTOPO_SPACING',
}

for (const k in DynTopoOverridesSC) {
  apiKeyMap[k] = k
  apiKeyMap[`flag[${k}]`] = k
}

const _ddigest = new util.HashDigest()

/**
 * Dynamic-topology settings for the sculptcore-native sculpt path. Distinct from
 * the legacy pbvh `DynTopoSettings` (brush_dyntopo.ts): its fields map directly
 * onto the C++ `sculptcore::dyntopo::DynTopoParams`. The three edge-goal modes
 * (world / percent-of-radius / pixels) are resolved to a single `l_max` in TS via
 * {@link resolveEdgeGoal}; sculptcore stays camera-free.
 *
 * Like the legacy class it participates in the mode-default + per-brush override
 * model: a per-brush instance's `overrideMask` selects which fields come from the
 * brush vs. the tool-mode defaults (see SculptCorePaintMode's `_apiDynTopoSC`
 * Proxy). `overrideMask & NONE` means "inherit everything".
 */
export class DynTopoSettingsSC {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  DynTopoSettingsSC {
    flag          : int;
    overrideMask  : int;
    edgeMode      : int;
    edgeSize      : float;
    collapseRatio : float;
    grade         : float;
    mode          : int;
    smoothLambda  : float;
    maxSplits     : int;
    maxCollapses  : int;
    maxRounds     : int;
    dynTopoSpacing : float;
  }`
  )

  flag = DynTopoFlagsSC.DO_FLIPS | DynTopoFlagsSC.DO_SMOOTH | DynTopoFlagsSC.PRESERVE_FEATURES
  overrideMask = DynTopoOverridesSC.NONE

  edgeMode = DynTopoEdgeModeSC.PERCENT
  edgeSize = 10.0 // 10% of the brush radius by default (PERCENT mode)
  collapseRatio = 0.5

  grade = 0.0
  mode = DynTopoSCMode.BOTH
  smoothLambda = 0.5
  // Per-dab split budget = the defer strategy. A cap keeps a large/dense dab
  // single-round (~25fps+ on a ~5M-tri mesh); excess splits defer to later
  // dabs. 0 = unlimited triggers the round-2 cascade (~110ms/dab at 5M).
  maxSplits = 1024
  /* Per-dab collapse budget (the maxSplits analog for decimation-mode dabs,
   * where the detail target is coarser than the mesh). Same latency math as
   * the split budget: ~0.02-0.04ms per collapse+flip. 0 = unlimited. */
  maxCollapses = 1024
  maxRounds = 5
  // Remesh spacing, independent of the brush-dab spacing: dyntopo runs only
  // once per this much stroke travel (units of 2·radius, like brush spacing),
  // not on every dab. Decoupling keeps a dense, finely-spaced deform stroke from
  // remeshing on every dab (expensive + over-refining). 0.25 ≈ every half-radius.
  dynTopoSpacing = 0.25

  constructor() {}

  static apiKeyToOverride(k: string): string {
    // `flag[X]` mirrors override key X directly (don't depend on the enum
    // for..in above having populated, which is module-eval-order sensitive).
    const m = /^flag\[(.+)\]$/.exec(k)
    if (m) {
      return m[1]
    }
    return apiKeyMap[k]
  }

  get enabled(): boolean {
    return !!(this.flag & DynTopoFlagsSC.ENABLED)
  }

  /**
   * Resolve the per-dab target edge length from the active mode. `radius` is the
   * brush radius in mesh/world units; `dist` is the world-units-per-pixel at the
   * dab point. Returns the split target `l_max` and the collapse target `l_min`.
   */
  resolveEdgeGoal(radius: number, dist: number): {l_max: number; l_min: number} {
    let l_max: number
    switch (this.edgeMode) {
      case DynTopoEdgeModeSC.WORLD:
        l_max = this.edgeSize
        break
      case DynTopoEdgeModeSC.PIXELS:
        l_max = this.edgeSize * dist
        break
      case DynTopoEdgeModeSC.PERCENT:
      default:
        l_max = (this.edgeSize / 100.0) * radius
        break
    }
    // Guard against a zero/negative target (would make every edge a split
    // candidate and never converge); fall back to a small fraction of radius.
    if (!(l_max > 0)) {
      l_max = Math.max(radius * 0.05, 1e-6)
    }
    const l_min = l_max * this.collapseRatio
    return {l_max, l_min}
  }

  calcHashKey(d = _ddigest.reset()) {
    d.add(this.flag)
    d.add(this.overrideMask)
    d.add(this.edgeMode)
    d.add(this.edgeSize)
    d.add(this.collapseRatio)
    d.add(this.grade)
    d.add(this.mode)
    d.add(this.smoothLambda)
    d.add(this.maxSplits)
    d.add(this.maxCollapses)
    d.add(this.maxRounds)
    d.add(this.dynTopoSpacing)

    return d.get()
  }

  equals(b: this) {
    let r = true

    r = r && this.flag === b.flag
    r = r && this.overrideMask === b.overrideMask
    r = r && this.edgeMode === b.edgeMode
    r = r && this.mode === b.mode
    r = r && this.maxSplits === b.maxSplits
    r = r && this.maxCollapses === b.maxCollapses
    r = r && this.maxRounds === b.maxRounds

    r = r && feq(this.edgeSize, b.edgeSize)
    r = r && feq(this.collapseRatio, b.collapseRatio)
    r = r && feq(this.grade, b.grade)
    r = r && feq(this.smoothLambda, b.smoothLambda)
    r = r && feq(this.dynTopoSpacing, b.dynTopoSpacing)

    return r
  }

  loadDefaults(defaults: this): this {
    const b = defaults
    const mask = this.overrideMask
    const dyn = DynTopoOverridesSC

    if (mask & dyn.NONE) {
      this.load(b)
      return this
    }

    for (const k in DynTopoFlagsSC) {
      const f = DynTopoFlagsSC[k as keyof typeof DynTopoFlagsSC]
      if (typeof f !== 'number') {
        continue
      }
      if (!(mask & f)) {
        if (b.flag & f) {
          this.flag |= f
        } else {
          this.flag &= ~f
        }
      }
    }

    if (!(mask & dyn.EDGE_MODE)) this.edgeMode = b.edgeMode
    if (!(mask & dyn.EDGE_SIZE)) this.edgeSize = b.edgeSize
    if (!(mask & dyn.COLLAPSE_RATIO)) this.collapseRatio = b.collapseRatio
    if (!(mask & dyn.GRADE)) this.grade = b.grade
    if (!(mask & dyn.MODE)) this.mode = b.mode
    if (!(mask & dyn.SMOOTH_LAMBDA)) this.smoothLambda = b.smoothLambda
    if (!(mask & dyn.MAX_SPLITS)) this.maxSplits = b.maxSplits
    if (!(mask & dyn.MAX_COLLAPSES)) this.maxCollapses = b.maxCollapses
    if (!(mask & dyn.MAX_ROUNDS)) this.maxRounds = b.maxRounds
    if (!(mask & dyn.DYNTOPO_SPACING)) this.dynTopoSpacing = b.dynTopoSpacing

    return this
  }

  load(b: this): this {
    this.flag = b.flag
    this.overrideMask = b.overrideMask
    this.edgeMode = b.edgeMode
    this.edgeSize = b.edgeSize
    this.collapseRatio = b.collapseRatio
    this.grade = b.grade
    this.mode = b.mode
    this.smoothLambda = b.smoothLambda
    this.maxSplits = b.maxSplits
    this.maxCollapses = b.maxCollapses
    this.maxRounds = b.maxRounds
    this.dynTopoSpacing = b.dynTopoSpacing

    return this
  }

  copy(): this {
    return new DynTopoSettingsSC().load(this) as unknown as this
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = struct ?? api.mapStruct(this)

    const tooltips: Record<string, string> = {}
    for (const k in DynTopoOverridesSC) {
      if (k === 'NONE') {
        tooltips[k] = 'Use Defaults For Everything'
      } else {
        tooltips[k] = 'Use Local Brush Settings'
      }
    }

    st.flags('overrideMask', 'overrides', deleteTsEnumIntegers(DynTopoOverridesSC), 'Overrides')
      .descriptions(tooltips)
      .uiNames({
        NONE: 'Inherit Everything',
      })

    st.flags('flag', 'flag', deleteTsEnumIntegers(DynTopoFlagsSC), 'Flag').descriptions({
      ENABLED          : 'Enable dynamic topology while sculpting',
      DO_FLIPS         : 'Edge flips (keeps triangles well-shaped; recommended)',
      DO_SMOOTH        : 'Tangential smoothing (evens triangle sizes)',
      PRESERVE_FEATURES: 'Keep seams / sharp edges / face-set & UV-chart boundaries intact',
    })

    st.enum('edgeMode', 'edgeMode', deleteTsEnumIntegers(DynTopoEdgeModeSC), 'Detail Mode').descriptions({
      WORLD  : 'Target edge length in world units',
      PERCENT: 'Target edge length as a percentage of the brush radius',
      PIXELS : 'Target edge length as a multiple of the projected pixel size',
    })

    st.enum('mode', 'mode', deleteTsEnumIntegers(DynTopoSCMode), 'Refine Mode').descriptions({
      SUBDIVIDE: 'Only subdivide (split long edges)',
      COLLAPSE : 'Only collapse (remove short edges)',
      BOTH     : 'Subdivide and collapse',
    })

    st.float('edgeSize', 'edgeSize', 'Detail Size', 'Target edge length (units depend on Detail Mode)')
      .range(0.0001, 200.0)
      .noUnits()
      .decimalPlaces(4)
      .step(0.1)
      .slideSpeed(10.0)
      .expRate(1.75)

    st.float(
      'collapseRatio',
      'collapseRatio',
      'Collapse Ratio',
      'Collapse edges shorter than this fraction of the target'
    )
      .range(0.05, 0.95)
      .expRate(1.75)
      .decimalPlaces(3)
      .slideSpeed(2.0)
      .noUnits()
    st.float('grade', 'grade', 'Grade', 'Relax the target outward from the brush center (0 = uniform)')
      .range(0.0, 8.0)
      .decimalPlaces(2)
      .slideSpeed(2.0)
      .noUnits()
    st.float('smoothLambda', 'smoothLambda', 'Smooth Amount', 'Tangential smoothing step (0..1)')
      .range(0.0, 1.0)
      .decimalPlaces(4)
      .slideSpeed(2.0)
      .noUnits()
    st.int(
      'maxSplits',
      'maxSplits',
      'Split Budget',
      'Max splits per dab (0 = unlimited; default 1024 keeps large dabs ~25fps+ at 5M tris)'
    )
      .range(0, 200000)
      .expRate(1.75)
      .slideSpeed(2.0)
      .noUnits()
    st.int(
      'maxCollapses',
      'maxCollapses',
      'Collapse Budget',
      'Max collapses per dab (0 = unlimited; bounds decimation-mode dabs the way Split Budget bounds refinement)'
    )
      .range(0, 200000)
      .expRate(1.75)
      .slideSpeed(2.0)
      .noUnits()
    st.int('maxRounds', 'maxRounds', 'Max Rounds', 'Max independent-set rounds per dab').range(1, 200).noUnits()
    st.float(
      'dynTopoSpacing',
      'dynTopoSpacing',
      'Remesh Spacing',
      'How often dyntopo remeshes along the stroke, independent of brush dab spacing (fraction of 2·radius; 0 = every dab)'
    )
      .range(0.0, 2.0)
      .decimalPlaces(3)
      .slideSpeed(2.0)
      .noUnits()

    return st
  }
}
