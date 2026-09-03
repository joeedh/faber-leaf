import {Curve1D, SplineTemplates, util, Vector4, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import {Icons} from '../editors/icon_enum.js'
import {DataBlock, BlockFlags, BlockLoader, BlockLoaderAddUser} from '../core/lib_api.js'
import {NodeFlags} from '../core/graph.js'
import {
  CombModes,
  CombPattern,
  ProceduralTex,
  ProceduralTexUser,
  TexUserFlags,
  TexUserModes,
} from '../texture/proceduralTex'
import {nstructjs, Number4, ToolProperty} from '../path.ux/pathux.js'
import type {Scene} from '../scene/scene.js'
import type {ToolContext} from '../core/context'
import type {StructReader} from '../path.ux/scripts/util/nstructjs.js'
import {BrushDynamics, BrushDynChannel} from './brush_dynamics'
export {BrushDynamics} from './brush_dynamics'

import {
  SculptTools,
  SculptIcons,
  BrushFlags,
  BrushRadiusModes,
  ColorMixModes,
  DynTopoFlags,
  DynTopoOverrides,
  BrushSpacingModes,
  PlaneNormalModes,
  DynTopoOverridesSC,
  DynTopoFlagsSC,
  StrokeMethod,
  AnchoredLiveMode,
} from './brush_base'
import {DynTopoSettings} from './brush_dyntopo'
import {DynTopoSettingsSC} from './brush_dyntopo_sc'

function feq(a: number, b: number) {
  return Math.abs(a - b) < 0.00001
}

const ckey_digest = new util.HashDigest()

export class SculptBrush extends DataBlock {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
SculptBrush {
  autosmooth : float;
  autosmoothInflate : float;
  strength   : float;
  tool       : int;
  radius     : float;
  planeoff   : float;
  planeNormalMode : int;
  concaveFilter : float;
  rake       : float;    
  spacing    : float;
  smoothProj : float;
  color      : vec4;
  normalfac  : float;
  bgcolor    : vec4;
  dynamics   : BrushDynamics;
  flag       : int;
  falloff    : Curve1D;
  falloff2   : Curve1D;
  texUser    : ProceduralTexUser;
  pinch      : float;
  dynTopo    : DynTopoSettings;
  dynTopoSC  : DynTopoSettingsSC;
  rakeCurvatureFactor : float;
  spacingMode: int;
  strokeMethod : int;
  anchoredLiveMode : int;
  anchoredDragRadius : bool;
  sharp      : float;
  smoothRadiusMul : float;
  cavityFactor : float;
  cavityBlurSteps : int;
  cavityCurve : Curve1D;
  viewNormalLimit : float;
  viewNormalFalloff : float;
  enhanceRings : int;
  enhanceInner : int;
  radiusMode : int;
  colorMixMode : int;
  wingAngle  : float;
}`
  )

  // View-normal masking is on by default (silhouette tearing is a defect, not a
  // stylistic choice); backface culling stays opt-in and follows the tool mode.
  flag = BrushFlags.SHARED_SIZE | BrushFlags.AUTOMASK_VIEW_NORMAL | BrushFlags.SHARED_CULL_BACKFACES

  /** Unit `radius` is in; see BrushRadiusModes and resolveWorldRadius. */
  radiusMode = BrushRadiusModes.SCREEN

  /** Blend mode for the color paint brush; see ColorMixModes and color.sbrush. */
  colorMixMode = ColorMixModes.MIX

  smoothRadiusMul = 1.0

  // Cavity automasking strength scale and BFS blur radius (rings). Enabled via
  // BrushFlags.AUTOMASK_CAVITY; see automask.h.
  cavityFactor = 1.0
  cavityBlurSteps = 2
  cavityCurve = new Curve1D()

  // View-normal automasking angles, in degrees (sculptcore stores radians).
  // Full strength until `viewNormalLimit - viewNormalFalloff` off head-on, then
  // a linear ramp to zero at the limit. Enabled via BrushFlags.AUTOMASK_VIEW_NORMAL.
  viewNormalLimit = 90.0
  viewNormalFalloff = 25.0

  // Enhance-details brush: outer smoothing depth (feature scale) and inner depth
  // (0 = high-pass / classic unsharp, >=1 = difference-of-smooths band-pass).
  enhanceRings = 4
  enhanceInner = 1

  smoothProj = 0.0 //how much smoothing should project to surface
  spacingMode = BrushSpacingModes.EVEN
  strokeMethod = StrokeMethod.PATH
  anchoredLiveMode = AnchoredLiveMode.RADIUS

  /** Opt-in: let the anchor->cursor drag drive `anchoredLiveMode`'s scalar. Off
   * means an Anchored stroke keeps the brush's own radius for the whole drag,
   * which is what the grab-class brushes (Grab, Kelvinlet) want — their radius
   * is the deformation's falloff width, not a size the drag should set. */
  anchoredDragRadius = false

  texUser = new ProceduralTexUser()

  concaveFilter = 0.0

  dynTopo = new DynTopoSettings()
  dynTopoSC = new DynTopoSettingsSC()

  rakeCurvatureFactor = 0.0

  tool = SculptTools.CLAY

  sharp = 0.0
  strength = 0.5
  spacing = 0.175
  radius = 55.0
  autosmooth = 0.0
  autosmoothInflate = 0.0
  planeoff = 0.0
  planeNormalMode = PlaneNormalModes.VIEW
  rake = 0.0
  pinch = 0.0

  /** Wing Scrape: half-angle between the two wing planes, in degrees
   * (sculptcore stores radians). 0 degrades to a plain flat scrape. */
  wingAngle = 20.0

  normalfac = 0.5

  falloff = new Curve1D()
  falloff2 = new Curve1D()

  color = new Vector4([1, 1, 1, 1])
  bgcolor = new Vector4([0, 0, 0, 1])

  dynamics = new BrushDynamics()

  constructor() {
    super()
  }

  static blockDefine() {
    return {
      typeName   : 'brush',
      defaultName: 'Brush',
      uiName     : 'Brush',
      flag       : BlockFlags.FAKE_USER,
      icon       : Icons.SCULPT_PAINT,
    }
  }

  static nodedef() {
    return {
      name   : 'brush',
      uiname : 'Brush',
      flag   : NodeFlags.SAVE_PROXY,
      inputs : {},
      outputs: {},
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const bst = super.defineAPI(api, struct ?? api.mapStruct(this, true))

    // Sibling structs referenced below must exist first.
    DynTopoSettings.defineAPI(api)
    DynTopoSettingsSC.defineAPI(api)

    bst
      .flags('flag', 'flag', deleteTsEnumIntegers(BrushFlags), 'Flag')
      .icons({
        SHARED_SIZE          : Icons.SHARED_BRUSH_SIZE,
        SQUARE               : Icons.SQUARE_BRUSH,
        SHARED_CULL_BACKFACES: Icons.SHARED_BACKFACE_CULL,
      })
      .descriptions({
        AUTOMASK_VIEW_NORMAL : 'Fade the brush out where the surface turns edge-on to the view',
        CULL_BACKFACES       : 'Skip geometry facing away from the view',
        SHARED_CULL_BACKFACES: 'Use the tool mode’s backface-culling setting instead of this brush’s',
      })

    bst
      .float('smoothRadiusMul', 'smoothRadiusMul', 'Smooth Radius')
      .description('Multiply brush radius by this factor for smoothing')
      .range(0.125, 15.0)
      .noUnits()

    bst.float('rakeCurvatureFactor', 'rakeCurvatureFactor', 'Curvature Factor').noUnits().range(0.0, 1.0)

    bst.enum('spacingMode', 'spacingMode', deleteTsEnumIntegers(BrushSpacingModes), 'Spacing Mode').descriptions({
      EVEN: 'Fixed distance between brush points',
      NONE: 'Use raw brush points',
    })

    bst.enum('strokeMethod', 'strokeMethod', deleteTsEnumIntegers(StrokeMethod), 'Stroke Method').descriptions({
      PATH    : 'Sample dabs along the drawn path',
      ANCHORED: 'Fix the origin on mouse-down; the drag pulls from there',
      DRAG_DOT: 'Follow the cursor, previewing one dab at a time',
    })

    bst
      .enum('anchoredLiveMode', 'anchoredLiveMode', deleteTsEnumIntegers(AnchoredLiveMode), 'Anchored Live')
      .descriptions({
        RADIUS: 'Drag distance scales the brush radius',
        ANGLE : 'Drag angle drives a live rotation',
      })

    bst
      .bool('anchoredDragRadius', 'anchoredDragRadius', 'Drag Sets Size')
      .description('Anchored strokes: let the drag drive the live scalar above instead of keeping the brush radius')

    bst.float('sharp', 'sharp', 'Sharpening').range(0.0, 1.0).noUnits().step(0.015)

    bst
      .float('strength', 'strength', 'Strength')
      .range(0.001, 2.0)
      .noUnits()
      .step(0.05)
      .simpleSlider()
      .sliderDisplayExp(0.5)
    bst
      .float('radius', 'radius', 'Radius')
      .range(0.1, 350.0)
      .noUnits()
      .step(2.5)
      .expRate(2.75)
      .decimalPlaces(2)
      .description('Press F to set brush radius interactively')
    bst.enum('radiusMode', 'radiusMode', deleteTsEnumIntegers(BrushRadiusModes), 'Radius Unit').descriptions({
      SCREEN: 'Radius is in screen pixels; the sculpted footprint changes as you zoom',
      WORLD : 'Radius is in mesh units; the sculpted footprint stays fixed as you zoom',
    })
    bst.enum('tool', 'tool', deleteTsEnumIntegers(SculptTools)).icons(SculptIcons)

    bst.float('autosmooth', 'autosmooth', 'Autosmooth').range(0.0, 2.0).noUnits()
    bst.float('autosmoothInflate', 'autosmoothInflate', 'Inflation').range(0.0, 1.0).noUnits()

    bst.float('planeoff', 'planeoff', 'planeoff').range(-3.5, 3.5).noUnits()
    bst
      .float('wingAngle', 'wingAngle', 'Wing Angle', 'Half-angle between the two Wing Scrape planes')
      .range(0.0, 80.0)
      .step(1.0)
      .baseUnit('degree')
      .displayUnit('degree')
    bst
      .enum('planeNormalMode', 'planeNormalMode', deleteTsEnumIntegers(PlaneNormalModes), 'Plane Normal')
      .descriptions({
        VIEW   : 'Project onto a plane facing the viewport camera',
        SURFACE: 'Project onto the surface-normal plane at the brush center',
      })
    bst
      .float('spacing', 'spacing', 'Spacing')
      .range(0.02, 2.0)
      .noUnits()
      .decimalPlaces(2)
      .expRate(2.5)
      .step(0.01)
      .slideSpeed(3.0)
      .simpleSlider()
      .sliderDisplayExp(1.0 / 4.0)
    bst.color4('color', 'color', 'Primary Color')
    bst.color4('bgcolor', 'bgcolor', 'Secondary Color')
    bst
      .enum('colorMixMode', 'colorMixMode', deleteTsEnumIntegers(ColorMixModes), 'Color Mix')
      .description('How the color brush blends onto the vertex color')
    bst.float('concaveFilter', 'concaveFilter', 'Concave Wash').range(0.0, 1.0).noUnits()
    bst.float('rake', 'rake', 'Rake').range(0.0, 1.0).noUnits()
    bst.float('normalfac', 'normalfac', 'Normal Fac').range(0.0, 1.0).noUnits()
    bst.float('pinch', 'pinch', 'Pinch').range(0.0, 1.0).noUnits()

    bst.float('cavityFactor', 'cavityFactor', 'Cavity Factor', 'Cavity automasking strength').range(0.0, 5.0).noUnits()
    bst
      .int('cavityBlurSteps', 'cavityBlurSteps', 'Cavity Blur', 'Cavity automask blur radius (rings)')
      .range(0, 8)
      .noUnits()
    bst.curve1d('cavityCurve', 'cavityCurve', 'Cavity Curve')

    bst
      .float('viewNormalLimit', 'viewNormalLimit', 'View Limit', 'Angle off head-on at which the brush fades out')
      .range(0.0, 90.0)
      .step(1.0)
      .baseUnit('degree')
      .displayUnit('degree')
    bst
      .float('viewNormalFalloff', 'viewNormalFalloff', 'View Falloff', 'Width of the ramp leading up to the limit')
      .range(0.0, 90.0)
      .step(1.0)
      .baseUnit('degree')
      .displayUnit('degree')

    bst
      .int('enhanceRings', 'enhanceRings', 'Detail Scale', 'Enhance-details outer smoothing depth (feature scale)')
      .range(1, 8)
      .noUnits()
    bst
      .int(
        'enhanceInner',
        'enhanceInner',
        'Detail Inner',
        'Inner depth: 0 = high-pass, >=1 = band-pass (rejects noise)'
      )
      .range(0, 6)
      .noUnits()

    bst
      .float('smoothProj', 'smoothProj', 'Projection', 'How much smoothing should project to surface')
      .range(0.0, 0.97)
      .noUnits()

    bst.struct('texUser', 'texUser', 'Texture', api.mapStruct(ProceduralTexUser))
    bst.struct('dynTopo', 'dynTopo', 'DynTopo', api.mapStruct(DynTopoSettings))
    bst.struct('dynTopoSC', 'dynTopoSC', 'DynTopo', api.mapStruct(DynTopoSettingsSC))

    bst.curve1d('falloff', 'falloff', 'Falloff')
    bst.curve1d('falloff2', 'falloff2', 'Falloff', 'Inbetween Falloff')

    const cst = api.mapStruct(BrushDynChannel, true)
    cst.bool('useDynamics', 'useDynamics', 'Use Dynamics').icon(Icons.BRUSH_DYNAMICS)
    cst.curve1d('curve', 'curve', 'Curve')

    const dst = api.mapStruct(BrushDynamics, true)
    const b = new BrushDynamics()

    for (const ch of b.channels) {
      dst.struct(ch.name, ch.name, ch.name, cst)
    }

    bst.struct('dynamics', 'dynamics', 'Dynamics', dst)

    return bst
  }

  /**
   * Resolve `radius` to mesh/world units for a dab. `dist` is the
   * world-units-per-screen-pixel at the dab point, so a SCREEN-mode radius
   * scales with the view while a WORLD-mode one is already in mesh units.
   * Mirrors DynTopoSettingsSC.resolveEdgeGoal.
   */
  resolveWorldRadius(radius: number, dist: number): number {
    return this.radiusMode === BrushRadiusModes.WORLD ? radius : radius * dist
  }

  /** Inverse of resolveWorldRadius: mesh units -> the unit `radius` is stored in. */
  worldRadiusToLocal(worldRadius: number, dist: number): number {
    if (this.radiusMode === BrushRadiusModes.WORLD) {
      return worldRadius
    }
    return dist > 0 ? worldRadius / dist : worldRadius
  }

  equals(b: this, fast = true, ignoreRadiusStrength = false): boolean {
    if (fast) {
      const key1 = this.calcHashKey()
      const key2 = b.calcHashKey()

      return key1 === key2
    }

    let r = true

    r = r && this.flag === b.flag

    if (!ignoreRadiusStrength) {
      r = r && feq(this.strength, b.strength)
      r = r && feq(this.radius, b.radius)
      r = r && this.radiusMode === b.radiusMode
      r = r && this.colorMixMode === b.colorMixMode
    }

    r = r && feq(this.smoothRadiusMul, b.smoothRadiusMul)
    r = r && this.spacingMode === b.spacingMode
    r = r && this.strokeMethod === b.strokeMethod
    r = r && this.anchoredLiveMode === b.anchoredLiveMode
    r = r && this.anchoredDragRadius === b.anchoredDragRadius
    r = r && feq(this.tool, b.tool)
    r = r && feq(this.rake, b.rake)
    r = r && feq(this.pinch, b.pinch)
    r = r && feq(this.cavityFactor, b.cavityFactor)
    r = r && this.cavityBlurSteps === b.cavityBlurSteps
    r = r && this.cavityCurve.equals(b.cavityCurve)
    r = r && feq(this.viewNormalLimit, b.viewNormalLimit)
    r = r && feq(this.viewNormalFalloff, b.viewNormalFalloff)
    r = r && this.enhanceRings === b.enhanceRings
    r = r && this.enhanceInner === b.enhanceInner
    const cavMask = BrushFlags.AUTOMASK_CAVITY | BrushFlags.AUTOMASK_CAVITY_INVERT
    r = r && (this.flag & cavMask) === (b.flag & cavMask)
    r = r && feq(this.rakeCurvatureFactor, b.rakeCurvatureFactor)
    r = r && feq(this.autosmooth, b.autosmooth)
    r = r && feq(this.smoothProj, b.smoothProj)
    r = r && feq(this.normalfac, b.normalfac)
    r = r && feq(this.spacing, b.spacing)
    r = r && this.tool === b.tool
    r = r && feq(this.sharp, b.sharp)
    r = r && feq(this.autosmoothInflate, b.autosmoothInflate)

    r = r && this.color.vectorDistanceSqr(b.color) < 0.00001
    r = r && this.bgcolor.vectorDistanceSqr(b.bgcolor) < 0.00001

    r = r && feq(this.concaveFilter, b.concaveFilter)
    r = r && feq(this.wingAngle, b.wingAngle)

    r = r && this.texUser.equals(b.texUser)
    //r = r && this.dynamics.equals(b.dynamics);
    r = r && this.falloff.equals(b.falloff)
    r = r && this.dynTopo.equals(b.dynTopo)
    r = r && this.dynTopoSC.equals(b.dynTopoSC)
    r = r && this.falloff2.equals(b.falloff2)

    return r
  }

  calcHashKey(digest = ckey_digest.reset(), ignoreRadiusStrength = false): number {
    const d = digest

    for (let i = 0; i < 4; i++) {
      d.add(this.color[i as Number4])
      d.add(this.bgcolor[i as Number4])
    }
    d.add(this.colorMixMode)

    if (!ignoreRadiusStrength) {
      d.add(this.strength)
      d.add(this.radius)
      d.add(this.radiusMode)
    }

    d.add(this.smoothRadiusMul)
    d.add(this.spacingMode)
    d.add(this.strokeMethod)
    d.add(this.anchoredLiveMode)
    d.add(this.anchoredDragRadius ? 1 : 0)
    d.add(this.flag)
    d.add(this.tool)

    d.add(this.sharp)
    d.add(this.rakeCurvatureFactor)
    d.add(this.concaveFilter)
    d.add(this.tool)
    d.add(this.smoothProj)
    d.add(this.spacing)
    d.add(this.autosmooth)
    d.add(this.autosmoothInflate)
    d.add(this.pinch)
    d.add(this.planeoff)
    d.add(this.planeNormalMode)
    d.add(this.wingAngle)
    d.add(this.rake)
    d.add(this.pinch)
    d.add(this.cavityFactor)
    d.add(this.cavityBlurSteps)
    this.cavityCurve.calcHashKey(d)
    d.add(this.viewNormalLimit)
    d.add(this.viewNormalFalloff)
    d.add(this.enhanceRings)
    d.add(this.enhanceInner)
    d.add(this.normalfac)
    this.falloff.calcHashKey(d)
    d.add(this.color)
    d.add(this.bgcolor)

    this.texUser.calcHashKey(d)
    this.dynamics.calcHashKey(d)
    this.falloff.calcHashKey(d)
    this.dynTopo.calcHashKey(d)
    this.dynTopoSC.calcHashKey(d)
    this.falloff2.calcHashKey(d)

    return d.get()
  }

  calcMemSize(): number {
    return 16 * 8 + 512 //is an estimation
  }

  copyTo(b: this, copyBlockData = false): void {
    if (copyBlockData) {
      super.copyTo(b, false)
    }

    this.dynamics.copyTo(b.dynamics)

    b.flag = this.flag
    b.tool = this.tool
    b.sharp = this.sharp
    b.smoothRadiusMul = this.smoothRadiusMul

    b.spacingMode = this.spacingMode
    b.strokeMethod = this.strokeMethod
    b.anchoredLiveMode = this.anchoredLiveMode
    b.anchoredDragRadius = this.anchoredDragRadius
    b.spacing = this.spacing

    b.smoothProj = this.smoothProj
    b.concaveFilter = this.concaveFilter
    b.rake = this.rake
    b.pinch = this.pinch
    b.cavityFactor = this.cavityFactor
    b.cavityBlurSteps = this.cavityBlurSteps
    b.cavityCurve = this.cavityCurve.copy()
    b.viewNormalLimit = this.viewNormalLimit
    b.viewNormalFalloff = this.viewNormalFalloff
    b.enhanceRings = this.enhanceRings
    b.enhanceInner = this.enhanceInner
    b.autosmooth = this.autosmooth
    b.autosmoothInflate = this.autosmoothInflate

    b.rakeCurvatureFactor = this.rakeCurvatureFactor

    b.normalfac = this.normalfac
    b.strength = this.strength
    b.radius = this.radius
    b.radiusMode = this.radiusMode
    b.colorMixMode = this.colorMixMode
    b.planeoff = this.planeoff
    b.planeNormalMode = this.planeNormalMode
    b.wingAngle = this.wingAngle

    b.color.load(this.color)
    b.bgcolor.load(this.bgcolor)

    b.falloff2.load(this.falloff2)
    this.texUser.copyTo(b.texUser)
    b.dynTopo.load(this.dynTopo)
    b.dynTopoSC.load(this.dynTopoSC)
    b.falloff = this.falloff.copy()
  }

  copy(addLibUsers = false): this {
    const ret = super.copy(addLibUsers) as this
    this.copyTo(ret, false)
    ret.name = this.name

    return ret
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    //handle old file data
    if (typeof this.lib_userData !== 'string') {
      this.lib_userData = '{}'
    }

    super.loadSTRUCT(reader)
  }

  dataLink(getblock: BlockLoader, getblock_adduser: BlockLoaderAddUser) {
    super.dataLink(getblock, getblock_adduser)
    this.texUser.dataLink(this, getblock, getblock_adduser)
  }
}
DataBlock.register(SculptBrush)

/** Tools whose default brushes ship with ACCUMULATE set. */
const ACCUMULATE_DEFAULT_TOOLS = [
  SculptTools.SMOOTH,
  SculptTools.BSMOOTH,
  SculptTools.PAINT_SMOOTH,
  SculptTools.INFLATE,
  SculptTools.CLAY,
  SculptTools.FEATURE_ALIGN,
]

export function makeDefaultBrushes() {
  const brushes = {} as {[k: string]: SculptBrush}
  const bmap = {} as {[k: string]: SculptBrush}

  for (const k in SculptTools) {
    if (typeof k === 'string' && isNaN(parseInt(k))) {
      continue
    }

    const name = ToolProperty.makeUIName(SculptTools[k] as string)
    const brush = new SculptBrush()
    brush.name = name
    brush.tool = parseInt(k) as SculptTools
    brushes[name] = brush
    bmap[parseInt(k)] = brush
  }

  // Smoothing, inflate and clay brushes accumulate by default.
  for (const tool of ACCUMULATE_DEFAULT_TOOLS) {
    bmap[tool].flag |= BrushFlags.ACCUMULATE
  }

  let brush
  brush = bmap[SculptTools.PAINT]
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.PAINT_SMOOTH]
  brush.autosmooth = 0.0
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SQRT)

  brush = bmap[SculptTools.COLOR_BOUNDARY]
  //brush.autosmooth = 0.01;
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SQRT)

  brush = bmap[SculptTools.DRAW]
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)
  brush.strength = 0.25

  // Layer Draw (retired from the picker in sculptLayersV2; kept for tests):
  // same feel as Draw, no autosmooth — smoothing would write geometry the
  // active layer doesn't own.
  brush = bmap[SculptTools.LAYER_DRAW]
  brush.autosmooth = 0.0
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.CLAY]
  brush.autosmooth = 0.3
  brush.strength = 0.75
  brush.dynamics.autosmooth.useDynamics = true
  brush.dynamics.strength.useDynamics = true
  brush.dynamics.strength.curve.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.LINEAR)

  brush.flag |= BrushFlags.SQUARE | BrushFlags.LINE_FALLOFF | BrushFlags.USE_LINE_CURVE
  brush.spacing = 0.2
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTHER)
  brush.falloff2.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.GUASSIAN)

  brush = brush.copy()
  brush.name = 'Comb'
  brush.flag |= BrushFlags.INVERT
  brush.spacing = 0.15
  brush.texUser.mode = TexUserModes.VIEW_REPEAT
  brush.texUser.flag = TexUserFlags.FANCY_RAKE | TexUserFlags.RAKE

  brush.autosmooth = 0.25
  brush.dynamics.autosmooth.useDynamics = true
  const curve = brush.dynamics.autosmooth.curve
  curve.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.LINEAR)

  const tex = (brush.texUser.texture = new ProceduralTex())
  tex.lib_users++
  tex.lib_flag |= BlockFlags.FAKE_USER
  tex.name = 'CombBrush'

  tex.setGenerator(CombPattern)

  const pat = tex.getGenerator(CombPattern)
  pat.count = 1
  pat.mode = CombModes.STEP
  brush.flag |= BlockFlags.FAKE_USER

  brushes['Comb'] = brush

  brush = bmap[SculptTools.FILL]
  brush.flag |= BrushFlags.ACCUMULATE
  brush.planeNormalMode = PlaneNormalModes.VIEW
  brush.planeoff = 0.0
  brush.autosmooth = 0.5
  brush.strength = 0.5
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTHER)

  brush = bmap[SculptTools.SCRAPE]
  brush.autosmooth = 0.2
  brush.flag |= BrushFlags.ACCUMULATE
  brush.planeNormalMode = PlaneNormalModes.VIEW
  brush.strength = 0.2
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SQRT)

  brush = bmap[SculptTools.INFLATE]
  brush.strength = 0.5
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.SMOOTH]
  brush.strength = 1.0
  brush.planeoff = -1.0
  brush.normalfac = 1.0

  brush.dynTopo.overrideMask = DynTopoOverrides.NONE
  brush.dynTopo.flag = DynTopoFlags.SUBDIVIDE | DynTopoFlags.COLLAPSE

  //brush.flag |= BrushFlags.PLANAR_SMOOTH;
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SPHERE)

  brush.dynamics.strength.curve.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.LINEAR)
  brush.dynamics.strength.useDynamics = false

  brush = bmap[SculptTools.FEATURE_ALIGN]
  brush.strength = 0.6
  // Full rake bias by default — the brush's whole purpose is aligning edge flow.
  brush.rake = 1.0
  brush.rakeCurvatureFactor = 1.0
  // Tangential sliding (don't inflate) so the rake redistributes verts in-surface.
  brush.smoothProj = 0.5
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)
  // Designed to be used with dyntopo — enable it by default on this brush.
  brush.dynTopoSC.overrideMask |= DynTopoOverridesSC.ENABLED
  brush.dynTopoSC.flag |= DynTopoFlagsSC.ENABLED

  // Enhance details: gentle default strength so detail amplification doesn't
  // blow up, smooth falloff like the other neighbor brushes.
  brush = bmap[SculptTools.ENHANCE]
  brush.strength = 0.5
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  // Snake Hook's dab tracks the live (deforming) raycast surface each dab
  // rather than a fixed anchor plane, so it stays on the default Path stroke
  // method instead of Anchored (see stroke_driver.ts / sculptcore_ops.ts).
  brush = bmap[SculptTools.SNAKE]
  brush.strength = 1.0
  brush.autosmooth = 0.0
  brush.spacing = 0.075
  // Grab-class default: no view-normal masking — it fades the very geometry
  // being dragged as it rotates toward the silhouette mid-grab.
  brush.flag &= ~BrushFlags.AUTOMASK_VIEW_NORMAL
  // grabTo is the step since the last dab, so a dab has no stroke-start base to
  // replay from; the kernel is @incremental and the engine ignores non-accumulate
  // for it either way. Set here so the UI shows what actually happens.
  brush.flag |= BrushFlags.ACCUMULATE
  brush.dynTopo.flag = DynTopoFlags.SUBDIVIDE | DynTopoFlags.COLLAPSE
  brush.dynTopo.overrideMask = DynTopoOverrides.COLLAPSE | DynTopoOverrides.SUBDIVIDE
  brush.dynTopo.overrideMask |= DynTopoOverrides.EDGE_COUNT | DynTopoOverrides.DECIMATE_FACTOR
  brush.dynTopo.edgeCount = 550
  brush.dynTopo.decimateFactor = 0.05
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.SHARP]
  brush.strength = 0.5
  brush.autosmooth = 0.0
  brush.dynamics.autosmooth.useDynamics = false
  brush.flag |= BrushFlags.INVERT | BrushFlags.ACCUMULATE
  brush.pinch = 0.5
  brush.spacing = 0.1
  brush.dynamics.strength.useDynamics = true
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SHARP)

  brush = bmap[SculptTools.TOPOLOGY]
  brush.rake = 0.5
  brush.rakeCurvatureFactor = 1.0
  brush.autosmooth = 0.15
  brush.spacing = 0.2
  brush.spacingMode = BrushSpacingModes.EVEN
  brush.dynamics.autosmooth.curve.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.LINEAR)
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.CONSTANT)

  brush = bmap[SculptTools.GRAB]
  brush.autosmooth = 0.0
  brush.rake = 0.0
  brush.flag &= ~BrushFlags.AUTOMASK_VIEW_NORMAL // grab-class (see SNAKE note)
  brush.radius = 100
  brush.strokeMethod = StrokeMethod.ANCHORED
  brush.flag &= ~BrushFlags.SHARED_SIZE
  brush.dynTopo.overrideMask = DynTopoOverrides.ENABLED
  brush.dynTopo.flag &= ~DynTopoFlags.ENABLED
  brush.dynTopoSC.overrideMask = DynTopoOverridesSC.ENABLED
  brush.dynTopoSC.flag &= ~DynTopoFlags.ENABLED
  brush.flag &= ~BrushFlags.ACCUMULATE
  const curvejson = {
    type         : 'BSplineCurve',
    points: [
      {
        '0'    : 0,
        '1'    : 0,
        eid    : 16,
        flag   : 0,
        tangent: 1,
        rco    : [0, 0],
      },
      {
        '0'    : 0.41673,
        '1'    : -0.06794,
        eid    : 17,
        flag   : 1,
        tangent: 1,
        rco    : [0.41673, -0.06794],
      },
      {'0': 1, '1': 1, eid: 18, flag: 0, tangent: 1, rco: [1, 1]},
    ],
    deg          : 3,
    interpolating: false,
    eidgen       : {_cur: 19},
    range: [
      [0, 1],
      [-0.19203, 1],
    ],
  }
  brush.falloff.getGenerator('BSplineCurve').loadJSON(curvejson)

  //brush.falloff.getGenerator("BSplineCurve").loadTemplate(SplineTemplates.SMOOTH);
  brush.dynamics.autosmooth.useDynamics = false

  brush = bmap[SculptTools.WING_SCRAPE]
  brush.autosmooth = 0.0
  brush.pinch = 0.0
  // A scrape variant, so it inherits Scrape's accumulating, low-strength feel.
  brush.flag |= BrushFlags.ACCUMULATE
  brush.strength = 0.2
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.PINCH]
  brush.autosmooth = 0.2
  brush.pinch = 1.0
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SHARPER)
  brush.dynamics.strength.useDynamics = true
  brush.dynamics.autosmooth.useDynamics = false

  brush = bmap[SculptTools.SLIDE_RELAX]
  brush.autosmooth = 0.05
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SQRT)
  brush.dynamics.strength.useDynamics = false
  brush.dynamics.autosmooth.useDynamics = false
  brush.spacing = 0.04
  brush.smoothProj = 0.85

  brush = bmap[SculptTools.KELVINLET]
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTHER)
  brush.autosmooth = 0.0
  brush.rake = 0.0
  brush.flag &= ~BrushFlags.AUTOMASK_VIEW_NORMAL // grab-class (see SNAKE note)
  brush.radius = 100
  brush.strokeMethod = StrokeMethod.ANCHORED
  brush.flag &= ~BrushFlags.SHARED_SIZE
  brush.dynTopo.overrideMask = DynTopoOverrides.ENABLED
  brush.dynTopo.flag &= ~DynTopoFlags.ENABLED
  brush.dynTopoSC.overrideMask = DynTopoOverridesSC.ENABLED
  brush.dynTopoSC.flag &= ~DynTopoFlags.ENABLED
  brush.flag &= ~BrushFlags.ACCUMULATE

  return {brushes, slotMap: bmap}
}

export function makeDefaultBrushes_MediumRes() {
  const {brushes, slotMap: bmap} = makeDefaultBrushes()

  for (const k in SculptTools) {
    if (typeof k !== 'string') {
      continue
    }

    let name = k[0] + k.slice(1, k.length).toLowerCase()
    name = name.replace(/_/g, ' ').trim()

    const brush = new SculptBrush()
    brushes[name] = brush
    brush.name = name
    brush.tool = SculptTools[k] as unknown as SculptTools

    bmap[SculptTools[k]] = brush
  }

  // Smoothing, inflate and clay brushes accumulate by default.
  for (const tool of ACCUMULATE_DEFAULT_TOOLS) {
    bmap[tool].flag |= BrushFlags.ACCUMULATE
  }

  let brush
  brush = bmap[SculptTools.PAINT]
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.PAINT_SMOOTH]
  brush.autosmooth = 0.0
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SQRT)

  brush = bmap[SculptTools.COLOR_BOUNDARY]
  //brush.autosmooth = 0.01;
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SQRT)

  brush = bmap[SculptTools.DRAW]
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)
  brush.rake = 0.0
  brush.strength = 0.25
  brush.rakeCurvatureFactor = 1.0

  brush = bmap[SculptTools.CLAY]
  brush.autosmooth = 0.3
  brush.strength = 0.75
  brush.dynamics.autosmooth.useDynamics = true
  brush.dynamics.strength.useDynamics = true
  brush.dynamics.strength.curve.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.LINEAR)
  brush.rake = 0.0
  brush.rakeCurvatureFactor = 1.0

  brush.flag |= BrushFlags.SQUARE | BrushFlags.LINE_FALLOFF | BrushFlags.USE_LINE_CURVE
  brush.spacing = 0.2
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTHER)
  brush.falloff2.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.GUASSIAN)

  brush = brush.copy()
  brush.name = 'Comb'
  brush.flag |= BrushFlags.INVERT
  brush.spacing = 0.15
  brush.texUser.mode = TexUserModes.VIEW_REPEAT
  brush.texUser.flag = TexUserFlags.FANCY_RAKE | TexUserFlags.RAKE

  brush.autosmooth = 0.25
  brush.dynamics.autosmooth.useDynamics = true
  const curve = brush.dynamics.autosmooth.curve
  curve.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.LINEAR)

  const tex = (brush.texUser.texture = new ProceduralTex())
  tex.lib_users++
  tex.lib_flag |= BlockFlags.FAKE_USER
  tex.name = 'CombBrush'

  tex.setGenerator(CombPattern)

  const pat = tex.getGenerator(CombPattern)
  pat.count = 1
  pat.mode = CombModes.STEP
  brush.flag |= BlockFlags.FAKE_USER

  brushes[brush.name] = brush

  brush = bmap[SculptTools.FILL]
  brush.flag |= BrushFlags.ACCUMULATE
  brush.planeNormalMode = PlaneNormalModes.VIEW
  brush.planeoff = 0.2
  brush.autosmooth = 0.75
  brush.strength = 0.5
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTHER)

  brush = bmap[SculptTools.SCRAPE]
  brush.autosmooth = 0.2
  brush.spacing = 0.125
  brush.flag |= BrushFlags.ACCUMULATE
  brush.planeNormalMode = PlaneNormalModes.VIEW
  brush.strength = 0.2
  brush.rake = 0.0
  brush.rakeCurvatureFactor = 1.0
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SQRT)

  brush = bmap[SculptTools.INFLATE]
  brush.strength = 0.5
  brush.rake = 0.0
  brush.rakeCurvatureFactor = 1.0
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.SMOOTH]
  brush.strength = 0.5
  brush.planeoff = -1.0
  brush.normalfac = 1.0
  brush.rake = 0.0
  brush.rakeCurvatureFactor = 1.0

  brush.dynTopo.overrideMask = DynTopoOverrides.NONE
  brush.dynTopo.flag = DynTopoFlags.SUBDIVIDE | DynTopoFlags.COLLAPSE

  //brush.flag |= BrushFlags.PLANAR_SMOOTH;
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SPHERE)

  brush.dynamics.strength.curve.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.LINEAR)
  brush.dynamics.strength.useDynamics = true

  // Enhance details: gentle default strength so detail amplification doesn't
  // blow up, smooth falloff like the other neighbor brushes.
  brush = bmap[SculptTools.ENHANCE]
  brush.strength = 0.5
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  // Snake Hook's dab tracks the live (deforming) raycast surface each dab
  // rather than a fixed anchor plane, so it stays on the default Path stroke
  // method instead of Anchored (see stroke_driver.ts / sculptcore_ops.ts).
  brush = bmap[SculptTools.SNAKE]
  brush.strength = 1.0
  brush.autosmooth = 0.0
  brush.spacing = 0.075
  // Grab-class default: no view-normal masking — it fades the very geometry
  // being dragged as it rotates toward the silhouette mid-grab.
  brush.flag &= ~BrushFlags.AUTOMASK_VIEW_NORMAL
  // grabTo is the step since the last dab, so a dab has no stroke-start base to
  // replay from; the kernel is @incremental and the engine ignores non-accumulate
  // for it either way. Set here so the UI shows what actually happens.
  brush.flag |= BrushFlags.ACCUMULATE
  brush.dynTopo.flag = DynTopoFlags.SUBDIVIDE | DynTopoFlags.COLLAPSE
  brush.dynTopo.overrideMask = DynTopoOverrides.COLLAPSE | DynTopoOverrides.SUBDIVIDE
  brush.dynTopo.overrideMask |= DynTopoOverrides.EDGE_COUNT | DynTopoOverrides.DECIMATE_FACTOR
  brush.dynTopo.edgeCount = 550
  brush.dynTopo.decimateFactor = 0.05

  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.SHARP]
  brush.strength = 0.5
  brush.autosmooth = 0.25
  brush.dynamics.autosmooth.useDynamics = false
  brush.rake = 0.0
  brush.rakeCurvatureFactor = 1.0
  brush.pinch = 0.5
  brush.spacing = 0.09
  brush.dynamics.strength.useDynamics = true
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SHARP)

  brush = bmap[SculptTools.TOPOLOGY]
  brush.autosmooth = 0.15
  brush.spacing = 0.2
  brush.spacingMode = BrushSpacingModes.EVEN
  brush.rake = 1.0
  brush.rakeCurvatureFactor = 1.0
  brush.dynamics.autosmooth.curve.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.LINEAR)
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.CONSTANT)

  brush = bmap[SculptTools.GRAB]
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTHER)
  brush.autosmooth = 0.0
  brush.rake = 0.0
  brush.flag &= ~BrushFlags.AUTOMASK_VIEW_NORMAL // grab-class (see SNAKE note)
  brush.radius = 100
  brush.strokeMethod = StrokeMethod.ANCHORED
  brush.flag &= ~BrushFlags.SHARED_SIZE
  brush.dynTopo.overrideMask = DynTopoOverrides.ENABLED
  brush.dynTopo.flag &= ~DynTopoFlags.ENABLED
  brush.dynTopoSC.overrideMask = DynTopoOverridesSC.ENABLED
  brush.dynTopoSC.flag &= ~DynTopoFlags.ENABLED
  brush.flag &= ~BrushFlags.ACCUMULATE

  const curvejson = {
    type         : 'BSplineCurve',
    points: [
      {
        '0'    : 0,
        '1'    : 0,
        eid    : 16,
        flag   : 0,
        tangent: 1,
        rco    : [0, 0],
      },
      {
        '0'    : 0.41673,
        '1'    : -0.06794,
        eid    : 17,
        flag   : 1,
        tangent: 1,
        rco    : [0.41673, -0.06794],
      },
      {'0': 1, '1': 1, eid: 18, flag: 0, tangent: 1, rco: [1, 1]},
    ],
    deg          : 3,
    interpolating: false,
    eidgen       : {_cur: 19},
    range: [
      [0, 1],
      [-0.19203, 1],
    ],
  }
  brush.falloff.getGenerator('BSplineCurve').loadJSON(curvejson)

  //brush.falloff.getGenerator("BSplineCurve").loadTemplate(SplineTemplates.SMOOTH);
  brush.dynamics.autosmooth.useDynamics = false

  brush = bmap[SculptTools.WING_SCRAPE]
  brush.autosmooth = 0.0
  brush.rake = 0.0
  brush.rakeCurvatureFactor = 1.0
  brush.pinch = 0.0
  // A scrape variant, so it inherits Scrape's accumulating, low-strength feel.
  brush.flag |= BrushFlags.ACCUMULATE
  brush.strength = 0.2
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SMOOTH)

  brush = bmap[SculptTools.PINCH]
  brush.rake = 0.0
  brush.rakeCurvatureFactor = 1.0
  brush.autosmooth = 0.2
  brush.pinch = 1.0
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SHARPER)
  brush.dynamics.strength.useDynamics = true
  brush.dynamics.autosmooth.useDynamics = false

  brush = bmap[SculptTools.SLIDE_RELAX]
  brush.autosmooth = 0.05
  brush.falloff.getGenerator('BSplineCurve').loadTemplate(SplineTemplates.SQRT)
  brush.dynamics.strength.useDynamics = false
  brush.dynamics.autosmooth.useDynamics = false
  brush.spacing = 0.04
  brush.smoothProj = 0.85

  brush = bmap[SculptTools.KELVINLET]
  brush.autosmooth = 0.0
  brush.rake = 0.0
  brush.flag &= ~BrushFlags.AUTOMASK_VIEW_NORMAL // grab-class (see SNAKE note)
  brush.radius = 100
  brush.strokeMethod = StrokeMethod.ANCHORED
  brush.flag &= ~BrushFlags.SHARED_SIZE
  brush.dynTopo.overrideMask = DynTopoOverrides.ENABLED
  brush.dynTopo.flag &= ~DynTopoFlags.ENABLED
  brush.dynTopoSC.overrideMask = DynTopoOverridesSC.ENABLED
  brush.dynTopoSC.flag &= ~DynTopoFlags.ENABLED
  brush.flag &= ~BrushFlags.ACCUMULATE

  return {brushes, slotMap: bmap}
}

export class PaintToolSlot {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  PaintToolSlot {
    brush : DataRef | DataRef.fromBlock(this.brush);
    tool  : int;
  }
`
  )

  brush?: SculptBrush = undefined
  tool: SculptTools

  constructor(tool: SculptTools) {
    this.tool = tool
  }

  dataLink(owner: DataBlock, getblock: any, getblock_addUser: any) {
    this.brush = getblock_addUser(this.brush, owner)
  }

  setBrush(brush: SculptBrush, scene: Scene | undefined) {
    if (brush === this.brush) {
      return
    }

    if (this.brush !== undefined && typeof this.brush === 'object' && scene) {
      this.brush.lib_remUser(scene)
    }

    if (scene) {
      brush.lib_addUser(scene)
    }
    this.brush = brush
  }

  resolveBrush(ctx: ToolContext) {
    if (!this.brush) {
      const scene = ctx.scene

      //there should always be at least one brush (we enforce this in getBrushes)
      //for each tool type
      this.brush = this.getBrushList(ctx)[0]
      this.brush.lib_addUser(scene)
    }

    return this.brush
  }

  getBrushList(ctx: ToolContext) {
    return getBrushes(ctx).filter((f) => f.tool === this.tool)
  }
}

export enum BrushSets {
  HIGH_RES = 0,
  MEDIUM_RES = 1,
  DEFAULT = 2,
}

export const BrushSetFactories = [makeDefaultBrushes, makeDefaultBrushes_MediumRes]
export const DefaultBrushes = makeDefaultBrushes()
export let brushSet = BrushSets.DEFAULT

export function setBrushSet(set: BrushSets | string) {
  const update = set !== brushSet

  let found = false

  for (const k in BrushSets) {
    const v = BrushSets[k] as unknown as BrushSets

    if (v === set) {
      found = true
    } else if (k === set) {
      set = BrushSets[k]
      found = true
    }
  }

  if (!found) {
    throw new Error('unknown brush set ' + set)
  }

  brushSet = set as unknown as BrushSets

  if (update) {
    // eslint-disable-next-line no-console
    console.log('Loading brush set ' + set)
    Object.assign(DefaultBrushes, BrushSetFactories[set as number]())
  }
}

/**
 Ensures that at least one brush instance of each brush tool type
 exists in the datalib
 * */
export function getBrushes(ctx: ToolContext, overrideDefaultBrushes = false) {
  const brushes = ctx.datalib.brush

  for (const k in DefaultBrushes.brushes) {
    let found: SculptBrush | undefined = undefined
    let b = DefaultBrushes.brushes[k]

    for (const b2 of brushes) {
      if (b2.tool === b.tool) {
        found = b2
        break
      }
    }

    if (found && overrideDefaultBrushes) {
      b.copyTo(found, false)
      found.graphUpdate()
    } else if (!found) {
      b = b.copy()
      b.lib_id = -1

      const tex = b.texUser.texture
      if (tex && tex.lib_id < 0) {
        ctx.datalib.add(tex)
      }

      ctx.datalib.add(b)
    }

    const tex = b.texUser.texture
    if (tex && tex.lib_id < 0) {
      ctx.datalib.add(tex)
    }

    if (overrideDefaultBrushes || !found) {
      //add a hidden copy too
      const oname = '__original_brush_' + b.name
      let b2 = ctx.datalib.get<SculptBrush>(oname)

      if (!b2) {
        b2 = b.copy()
        b2.lib_id = -1

        b2.name = oname
        b2.lib_flag |= BlockFlags.HIDE
        ctx.datalib.add(b2)

        const tex2 = b2.texUser.texture
        if (tex2 && tex2.lib_id < 0) {
          ctx.datalib.add(tex2)
        }
      } else {
        b.copyTo(b2, false)
        b2.graphUpdate()
      }
    }
  }

  const ret = []
  for (const b of brushes) {
    ret.push(b)
  }

  return ret
}

;(window as unknown as any)._getBrushes = getBrushes

registerDataAPI(SculptBrush)
