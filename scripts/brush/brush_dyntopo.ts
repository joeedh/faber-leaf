import {util, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import {nstructjs} from '../path.ux/pathux.js'

import {
  SculptTools,
  BrushFlags,
  DynTopoFlags,
  DynTopoOverrides,
  SubdivModes,
  DynTopoModes,
  BrushSpacingModes,
} from './brush_base'

function feq(a: number, b: number) {
  return Math.abs(a - b) < 0.00001
}

const apiKeyMap: {[k: string]: string} = {
  valenceGoal    : 'VALENCE_GOAL',
  edgeSize       : 'EDGE_SIZE',
  decimateFactor : 'DECIMATE_FACTOR',
  subdivideFactor: 'SUBDIVIDE_FACTOR',
  maxDepth       : 'MAX_DEPTH',
  edgeCount      : 'EDGE_COUNT',
  repeat         : 'REPEAT',
  spacingMode    : 'SPACING_MODE',
  spacing        : 'SPACING',
  edgeMode       : 'EDGEMODE',
  subdivMode     : 'SUBDIV_MODE',
}

for (const k in DynTopoOverrides) {
  const k2 = `flag[${k}]`
  apiKeyMap[k] = k
  apiKeyMap[k2] = k
}

const _ddigest = new util.HashDigest()

/**
 * Legacy PBVH dyntopo settings. Nothing reads these any more — the TS PBVH
 * stack that consumed them was deleted in P5 and sculptcore uses
 * `DynTopoSettingsSC`. The class survives only because `SculptBrush.dynTopo`
 * is a serialized field: removing it is a brush/.wproj format change, which
 * P5 deferred to P10's generic unknown-data machinery.
 */
export class DynTopoSettings {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  DynTopoSettings {
    flag            : int;
    overrideMask    : int;
    edgeSize        : float;
    edgeMode        : int;
    edgeCount       : int;
    decimateFactor  : float;
    subdivideFactor : float;
    maxDepth        : int;
    valenceGoal     : int;
    repeat          : int;
    spacingMode     : int;
    spacing         : float;
    subdivMode      : int;
  }`
  )

  overrideMask = DynTopoOverrides.NONE
  subdivMode = SubdivModes.SMART

  edgeMode = DynTopoModes.SCREEN

  valenceGoal = 6
  edgeSize = 20.0
  decimateFactor = 0.5
  subdivideFactor = 0.25
  maxDepth = 6 //used by multigrid code
  spacing = 1.0
  spacingMode = BrushSpacingModes.EVEN

  flag = DynTopoFlags.SUBDIVIDE | DynTopoFlags.COLLAPSE

  edgeCount = 150
  repeat = 1

  constructor() {}

  static apiKeyToOverride(k: string): string {
    return apiKeyMap[k]
  }

  calcHashKey(d = _ddigest.reset()) {
    d.add(this.valenceGoal)
    d.add(this.overrideMask)
    d.add(this.decimateFactor)
    d.add(this.subdivideFactor)
    d.add(this.maxDepth)
    d.add(this.flag)
    d.add(this.edgeCount)
    d.add(this.edgeSize)
    d.add(this.spacing)
    d.add(this.repeat)
    d.add(this.spacingMode)
    d.add(this.edgeMode)
    d.add(this.subdivMode)
    d.add(this.spacing)

    return d.get()
  }

  equals(b: this) {
    let r = true

    r = r && this.flag === b.flag
    r = r && this.overrideMask === b.overrideMask
    r = r && this.maxDepth === b.maxDepth
    r = r && this.edgeCount === b.edgeCount

    r = r && feq(this.spacing, b.spacing)
    r = r && feq(this.valenceGoal, b.valenceGoal)
    r = r && feq(this.decimateFactor, b.decimateFactor)
    r = r && feq(this.subdivideFactor, b.subdivideFactor)

    r = r && feq(this.edgeSize, b.edgeSize)
    r = r && this.repeat === b.repeat

    r = r && this.spacingMode === b.spacingMode
    r = r && this.edgeMode === b.edgeMode

    r = r && this.subdivMode === b.subdivMode

    return r
  }

  loadDefaults(defaults: this): this {
    const b = defaults

    const mask = this.overrideMask
    const dyn = DynTopoOverrides

    if (mask & dyn.NONE) {
      this.load(b)
      return this
    }

    for (const k in DynTopoFlags) {
      const f = DynTopoFlags[k]

      if (typeof f !== 'number') {
        continue
      }

      if (!(mask & f)) {
        const val = b.flag & f

        if (val) {
          this.flag |= f
        } else {
          this.flag &= ~f
        }
      }
    }

    if (!(mask & dyn.SUBDIVIDE_FACTOR)) {
      this.subdivideFactor = b.subdivideFactor
    }

    if (!(mask & dyn.DECIMATE_FACTOR)) {
      this.decimateFactor = b.decimateFactor
    }

    if (!(mask & dyn.MAX_DEPTH)) {
      this.maxDepth = b.maxDepth
    }

    if (!(mask & dyn.EDGE_COUNT)) {
      this.edgeCount = b.edgeCount
    }

    if (!(mask & dyn.EDGE_SIZE)) {
      this.edgeSize = b.edgeSize
    }

    if (!(mask & dyn.VALENCE_GOAL)) {
      this.valenceGoal = b.valenceGoal
    }

    if (!(mask & dyn.REPEAT)) {
      this.repeat = b.repeat
    }

    if (!(mask & dyn.SPACING_MODE)) {
      this.spacingMode = b.spacingMode
    }

    if (!(mask & dyn.SPACING)) {
      this.spacing = b.spacing
    }

    if (!(mask & dyn.EDGEMODE)) {
      this.edgeMode = b.edgeMode
    }

    if (!(mask & dyn.SUBDIV_MODE)) {
      this.subdivMode = b.subdivMode
    }

    return this
  }

  load(b: this): this {
    this.flag = b.flag
    this.overrideMask = b.overrideMask
    this.edgeMode = b.edgeMode

    this.edgeSize = b.edgeSize
    this.edgeCount = b.edgeCount
    this.repeat = b.repeat

    this.decimateFactor = b.decimateFactor
    this.subdivideFactor = b.subdivideFactor

    this.valenceGoal = b.valenceGoal
    this.maxDepth = b.maxDepth
    this.spacingMode = b.spacingMode
    this.spacing = b.spacing

    this.subdivMode = b.subdivMode

    return this
  }

  copy(): this {
    return new DynTopoSettings().load(this) as unknown as this
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    let st = struct ?? api.mapStruct(this)

    st.int('valenceGoal', 'valenceGoal', 'Valence Goal', 'Number of edges around vertices to aim for')
      .range(0, 12)
      .noUnits()

    let tooltips: Record<string, string> = {}
    for (let k in DynTopoOverrides) {
      if (k === 'NONE') {
        tooltips[k] = 'Use Defaults For Everything'
      } else {
        tooltips[k] = 'Use Local Brush Settings'
      }
    }

    st.enum('subdivMode', 'subdivMode', deleteTsEnumIntegers(SubdivModes))

    st.flags('overrideMask', 'overrides', deleteTsEnumIntegers(DynTopoOverrides), 'Overrides')
      .descriptions(tooltips)
      .uiNames({
        NONE: 'Inherit Everything',
      })

    st.float('subdivideFactor', 'subdivideFactor', 'Subdivision Factor').range(0.0, 1.0).noUnits()
    st.float('decimateFactor', 'decimateFactor', 'Decimate Factor').range(0.0, 1.0).noUnits()
    st.float('edgeSize', 'edgeSize', 'Edge Length', 'Edge length (in pixels)').range(0.25, 40.0).noUnits()
    st.flags('flag', 'flag', deleteTsEnumIntegers(DynTopoFlags), 'Flag').descriptions({
      ADAPTIVE: 'Subdivide based on curvature (Fancy Edge Weights only)  ',
    })
    st.int('maxDepth', 'maxDepth', 'Max Depth', 'Maximum quad tree grid subdivision level').range(0, 15).noUnits()
    st.int('repeat', 'repeat', 'Repeat', 'Number of times to run topology engine').range(1, 25).noUnits()

    st.float('spacing', 'spacing', 'Spacing').range(0.01, 12.0).noUnits()
    st.enum('spacingMode', 'spacingMode', deleteTsEnumIntegers(BrushSpacingModes), 'Spacing Mode').descriptions({
      EVEN: 'Fixed distance between brush points',
      NONE: 'Use raw brush points',
    })

    st.enum('edgeMode', 'edgeMode', deleteTsEnumIntegers(DynTopoModes), 'Mode')

    st.int('edgeCount', 'edgeCount', 'Edge Count')
      .range(1, 2048)
      .noUnits()
      .step(5)
      .description('Number of edges to split/collapse per run')

    return st
  }
}
