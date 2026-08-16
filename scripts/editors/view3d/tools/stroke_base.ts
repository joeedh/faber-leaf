/**
 * The geometry-agnostic half of the sculpt stroke stack: one dab sample, the
 * two ToolProperty types a stroke op declares, the symmetry table, and the
 * toolmode base every paint mode extends.
 *
 * Nothing here knows what is being sculpted. The BVH-driven halves — sample
 * gathering, `PaintOpBase`, `PaintOpMesh` — stay in `pbvh_base.ts`, which now
 * imports this module rather than the other way round. That inversion is the
 * whole point: `SculptCorePaintMode` can extend `PaintToolModeBase` without
 * reaching into files that are being deleted.
 *
 * Struct names are load-bearing. `PaintSample`, `PaintSampleProperty`,
 * `BrushProperty` and `PaintToolModeBase` are all on disk in any .wproj saved
 * with `save_toolstack` set, and nstructjs keys off the struct name rather
 * than the module path — so this file moved and they did not change.
 */

import {Bezier} from '../../../util/bezier.js'
import {
  Matrix4,
  PropFlags,
  ToolProperty,
  Vector2,
  Vector3,
  Vector4,
  nstructjs,
} from '../../../path.ux/scripts/pathux.js'
import {view3dProject} from '../view3d_base'
import {WidgetFlags} from '../widgets/widgets.js'
import {ToolMode} from '../view3d_toolmode.js'
import {BrushRadiusModes, DynTopoSettings, PaintToolSlot, SculptBrush, SculptTools} from '../../../brush/index'
import {ProceduralTex} from '../../../texture/proceduralTex'
import {enumValues} from '../../../util/enum-utils.js'
import type {BlockLoader, BlockLoaderAddUser} from '../../../core/lib_api.js'
import type {Scene} from '../../../scene/scene'
import type {StructReader} from '../../../path.ux/scripts/util/nstructjs.js'
import type {View3D} from '../view3d.js'

export class PaintSample {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
PaintSample {
  p              : vec4;
  dp             : vec4;
  screenP        : vec2;
  dScreenP       : vec2;
  strokeS        : float;
  dstrokeS       : float;
  origp          : vec4;
  isInterp       : bool;
  sharp          : float;
  futureAngle    : float;

  vec            : vec3;
  dvec           : vec3;
  mirrored       : bool;

  color          : vec4;

  rendermat      : mat4;
  irendermat     : mat4;
  view3dSize     : vec2;

  viewvec        : vec3;
  vieworigin     : vec3;
  viewPlane      : vec3;

  planeoff       : float;
  rake           : float;
  strength       : float;
  angle          : float;
  radius         : float;
  w              : float;
  pinch          : float;
  smoothProj     : float;
  autosmooth     : float;
  autosmoothInflate : float;
  concaveFilter  : float;
  invert         : bool;
  esize          : float;
  curve          : optional(bezier.Bezier);
  pressure       : float;
  hit            : bool;
  useAltBrush    : bool;
  anchorVec      : vec3;
  liveAngle      : float;
}`
  )

  pressure = 1.0
  twist = 0.0
  tiltX = 0.0
  tiltY = 0.0

  static interpKeys = [
    'pressure',
    'origp',
    'pinch',
    'sharp',
    'strength',
    'radius',
    'rake',
    'autosmooth',
    'concaveFilter',
  ] as const

  /** interpolated 'original' (at start of stroke) position via original position
   * attribute if one exists
   */
  origp: Vector4
  /** world space position */
  p: Vector4
  /** change in position */
  dp: Vector4
  viewPlane: Vector3
  rendermat: Matrix4
  irendermat: Matrix4
  view3dSize: Vector2
  /* arc length S along stroke in units of brush radius */
  strokeS: number
  /* change in arc length S along stroke in units of brush radius*/
  dstrokeS: number
  smoothProj: number
  pinch: number
  sharp: number
  // screen space point
  screenP: Vector2
  // screen space point change
  dScreenP: Vector2
  futureAngle: number
  invert: boolean
  w: number
  color: Vector4
  angle: number
  viewvec: Vector3
  vieworigin: Vector3
  isInterp: boolean
  vec: Vector3
  dvec: Vector3
  autosmoothInflate: number
  concaveFilter: number
  strength: number
  radius: number
  rake: number
  autosmooth: number
  esize: number
  planeoff: number
  mirrored: boolean
  // a slice of the stroke curve
  curve: Bezier | undefined
  /** false when this sample came from a ray that missed the scene and was
   * projected onto the camera-facing plane through the last surface hit */
  hit = true
  /** @deprecated */
  mpos = new Vector2()
  /** triggered by shift key */
  useAltBrush = false
  /** Anchored stroke method: object-local vector from the fixed anchor to the
   * live cursor position (see StrokeMethod.ANCHORED). Zero outside Anchored. */
  anchorVec: Vector3
  /** Anchored stroke method, AnchoredLiveMode.ANGLE: screen-space angle
   * (radians) from the anchor to the live cursor. Zero otherwise. */
  liveAngle = 0

  constructor() {
    this.origp = new Vector4()
    this.p = new Vector4()
    this.dp = new Vector4()
    this.viewPlane = new Vector3()

    this.rendermat = new Matrix4()
    this.irendermat = new Matrix4()
    this.view3dSize = new Vector2()

    this.strokeS = 0.0
    this.dstrokeS = 0.0

    this.smoothProj = 0.0

    this.pinch = 0.0
    this.sharp = 0.0

    //screen coordinates
    this.screenP = new Vector2()
    this.dScreenP = new Vector2()

    this.futureAngle = 0

    this.invert = false

    this.w = 0.0

    this.color = new Vector4()
    this.angle = 0

    this.viewvec = new Vector3()
    this.vieworigin = new Vector3()

    this.isInterp = false

    this.vec = new Vector3()
    this.dvec = new Vector3()
    this.anchorVec = new Vector3()

    this.autosmoothInflate = 0.0
    this.concaveFilter = 0.0
    this.strength = 0.0
    this.radius = 0.0
    this.rake = 0.0
    this.autosmooth = 0.0
    this.esize = 0.0
    this.planeoff = 0.0

    this.mirrored = false
  }

  static getMemSize(): number {
    let tot = 13 * 8
    tot += 5 * 3 * 8 + 8 * 5
    tot += 5 * 4 * 8 + 8 * 5 + 16 * 8

    return tot
  }

  mirror(mul: Vector3 = new Vector3([1, 1, 1])): this {
    const mul4 = new Vector4().load3(mul)
    mul4[3] = 1

    this.p.mul(mul4)
    this.dp.mul(mul4)
    this.origp.mul(mul4)

    // s1 = (p * flip) * screenMatrix
    // s2 = s1 + one_pixel_offset
    // radius_scale = distance(unproject(s2), unproject(s1))
    // radius_scale should be same regardless of which components of flip are 1 or -1
    //
    // Folding R = diag(flip) into rendermat (-> R·rendermat) gives exactly that:
    // (p*flip)·(R·rendermat) == p·rendermat, so the projection always lands at the
    // un-flipped (primary) depth and the per-pixel radius_scale is flip-invariant.
    const refl = new Matrix4()
    refl.scale(mul4[0], mul4[1], mul4[2])
    this.rendermat.multiply(refl) // Matrix4.multiply(B) = B·this
    this.irendermat.load(this.rendermat).invert()

    this.curve?.mirror(mul)

    this.screenP.load(this.p)
    view3dProject(this.screenP, this.view3dSize, this.rendermat)

    // derive mirrored screen delta
    this.dScreenP.load(this.p).sub(this.dp)
    view3dProject(this.dScreenP, this.view3dSize, this.rendermat)
    this.dScreenP.sub(this.screenP)

    this.viewvec.mul(mul4)
    this.viewPlane.mul(mul4)
    this.vieworigin.mul(mul4)

    this.vec.mul(mul4)
    this.dvec.mul(mul4)
    this.anchorVec.mul(mul4)

    this.angle *= mul4[0] * mul4[1] * mul4[2]
    this.futureAngle *= mul4[0] * mul4[1] * mul4[2]
    this.liveAngle *= mul4[0] * mul4[1] * mul4[2]

    this.mirrored = !this.mirrored
    return this
  }

  copyTo(b: PaintSample): void {
    b.curve = this.curve?.clone()

    b.strokeS = this.strokeS
    b.dstrokeS = this.dstrokeS
    b.sharp = this.sharp
    b.tiltX = this.tiltX
    b.tiltY = this.tiltY
    b.twist = this.twist

    b.screenP.load(this.screenP)
    b.dScreenP.load(this.dScreenP)

    b.vec.load(this.vec)
    b.dvec.load(this.dvec)
    b.anchorVec.load(this.anchorVec)
    b.liveAngle = this.liveAngle

    b.origp.load(this.origp)
    b.p.load(this.p)
    b.dp.load(this.dp)

    b.w = this.w
    b.esize = this.esize

    b.isInterp = this.isInterp
    b.mirrored = this.mirrored
    b.hit = this.hit

    b.rendermat.load(this.rendermat)
    b.irendermat.load(this.irendermat)
    b.view3dSize.load(this.view3dSize)
    b.viewPlane.load(this.viewPlane)
    b.viewvec.load(this.viewvec)
    b.vieworigin.load(this.vieworigin)

    b.invert = this.invert
    b.color.load(this.color)
    b.angle = this.angle
    b.futureAngle = this.futureAngle
    b.smoothProj = this.smoothProj
    b.pressure = this.pressure
    b.autosmoothInflate = this.autosmoothInflate
    b.pinch = this.pinch
    b.rake = this.rake
    b.strength = this.strength
    b.radius = this.radius
    b.autosmooth = this.autosmooth
    b.planeoff = this.planeoff
    b.concaveFilter = this.concaveFilter

    b.useAltBrush = this.useAltBrush
  }

  copy(): PaintSample {
    const ret = new PaintSample()

    this.copyTo(ret)

    return ret
  }
}

export const SymAxisMap: Vector3[][] = [
  [],
  [[-1, 1, 1]], //x
  [[1, -1, 1]], //y
  [
    [-1, 1, 1],
    [-1, -1, 1],
    [1, -1, 1],
  ], //x + y

  [[1, 1, -1]], //z
  [
    [-1, 1, 1],
    [1, 1, -1],
    [-1, 1, -1],
  ], //x+z
  [
    [1, -1, 1],
    [1, 1, -1],
    [1, -1, -1],
  ], //y+z

  [
    [-1, 1, 1],
    [1, -1, 1],
    [1, 1, -1],
    [-1, -1, 1],
    [-1, -1, -1],
    [-1, 1, -1],
    [1, -1, -1],
  ], //x+y+z
].map((v) => v.map((v) => new Vector3(v)))

export let BRUSH_PROP_TYPE: any

export const BrushPropTypes = {
  BRUSH: 100,
}

export class BrushProperty extends ToolProperty<SculptBrush, (typeof BrushPropTypes)['BRUSH']> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
BrushProperty {
  brush    : SculptBrush;
  _texture : ProceduralTex;
  hasTex   : bool | !!this.brush.texUser.texture;
}`
  )

  brush: SculptBrush
  _texture: any

  constructor(value?: any) {
    super(BRUSH_PROP_TYPE)

    this.brush = new SculptBrush()
    this._texture = new ProceduralTex()

    if (value) {
      this.setValue(value)
    }
  }

  calcMemSize(): number {
    return this.brush.calcMemSize() + this._texture.calcMemSize()
  }

  setDynTopoSettings(dynTopo: DynTopoSettings): void {
    this.brush.dynTopo.load(dynTopo)
  }

  setValue(brush: SculptBrush): this {
    brush.copyTo(this.brush, false)

    if (this.brush.texUser.texture) {
      this.brush.texUser.texture.copyTo(this._texture, true)
      this.brush.texUser.texture = this._texture
    }

    return this
  }

  getValue(): SculptBrush {
    return this.brush
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)

    const structThis = this as typeof this & {hasTex?: boolean}

    const texuser = this.brush.texUser
    if (structThis.hasTex) {
      delete structThis.hasTex
      this.brush.texUser.texture = this._texture
    } else {
      this.brush.texUser.texture = undefined
    }
  }
}

BRUSH_PROP_TYPE = ToolProperty.register(BrushProperty)

export let PAINT_SAMPLE_TYPE: any

export class PaintSampleProperty extends ToolProperty<PaintSample[] | Iterable<PaintSample>> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
PaintSampleProperty {
  data : array(PaintSample);
}`
  )

  data: PaintSample[]

  constructor() {
    super(PAINT_SAMPLE_TYPE)
    this.data = []
    this.flag |= PropFlags.NO_DEFAULT
  }

  calcMemSize(): number {
    let tot = super.calcMemSize()

    tot += PaintSample.getMemSize() * this.data.length

    return tot
  }

  push(sample: PaintSample): this {
    this.data.push(sample)
    return this
  }

  getValue(): PaintSample[] {
    return this.data
  }

  setValue(b: Iterable<PaintSample>): this {
    super.setValue(b instanceof Array ? b : Array.from(b))
    this.data.length = 0
    for (const item of b) {
      this.data.push(item)
    }

    return this
  }

  copy(): this {
    const ret = new PaintSampleProperty()

    for (const item of this) {
      ret.push(item.copy())
    }

    return ret as unknown as this
  }

  loadSTRUCT(reader: any): void {
    reader(this)
    super.loadSTRUCT(reader)
  }

  [Symbol.iterator](): Iterator<PaintSample> {
    return this.data[Symbol.iterator]()
  }
}

PAINT_SAMPLE_TYPE = ToolProperty.register(PaintSampleProperty)

export abstract class PaintToolModeBase extends ToolMode {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  PaintToolModeBase {
    drawBVH                : bool;
    drawCavityMap          : bool;
    drawFlat               : bool;
    drawWireframe          : bool;
    drawValidEdges         : bool;
    drawNodeIds            : bool;
    drawMask               : bool;
    drawDispDisField       : bool;
    editDisplaced          : bool;
    drawColPatches         : bool;
    symmetryAxes           : int;
    tool                   : int;
    slots                  : iterkeys(PaintToolSlot);
    sharedBrushRadius      : float;
    sharedRadiusMode       : int;
    lastScreenRadius       : float;
    lastWorldRadius        : float;
    dynTopo                : DynTopoSettings;
    reprojectCustomData    : bool;
  }`
  )

  mdown = false
  float = 0
  lastFaceSet: number
  editDisplaced: boolean
  drawDispDisField: boolean
  reprojectCustomData: boolean
  sharedBrushRadius: number
  /** The unit `sharedBrushRadius` is currently expressed in (BrushRadiusModes).
   * The shared value follows whichever brush last wrote it, so a SHARED_SIZE
   * brush whose own radiusMode differs must convert through sharedRadiusFor()
   * — reading raw treats world units as px (sub-pixel dab spacing). */
  sharedRadiusMode: number
  /** Screen (px) and world radii of the last primary dab that hit the surface;
   * their ratio is the world-units-per-pixel that `brush.set_radius_mode`
   * converts through. 0 = no dab yet, so there is nothing to convert with.
   * Only the sculptcore dab path populates these. */
  lastScreenRadius: number
  lastWorldRadius: number
  gridEditDepth: number
  enableMaxEditDepth: boolean
  dynTopo: DynTopoSettings
  mpos: Vector2
  _radius: number | undefined
  debugSphere: Vector3
  drawFlat: boolean
  drawMask: boolean
  _last_cd_mask: number
  tool: number
  slots: Record<number, PaintToolSlot>
  _brush_lines: {remove(): void}[]
  drawColPatches: boolean
  symmetryAxes: number
  drawBVH: boolean
  drawCavityMap: boolean
  drawNodeIds: boolean
  drawWireframe: boolean
  drawValidEdges: boolean
  _last_bvh_key: string
  _last_hqed: string
  view3d: View3D
  _last_enable_mres: string | undefined
  _last_draw_key: string | undefined

  constructor(manager: any) {
    super(manager)

    this.lastFaceSet = 1

    this.editDisplaced = false
    this.drawDispDisField = false
    this.reprojectCustomData = false

    this.sharedBrushRadius = 55
    this.sharedRadiusMode = BrushRadiusModes.SCREEN
    this.lastScreenRadius = 0
    this.lastWorldRadius = 0

    this.gridEditDepth = 2
    this.enableMaxEditDepth = false

    this.dynTopo = new DynTopoSettings()
    //this.dynTopo.flag = DynTopoFlags.COLLAPSE | DynTopoFlags.SUBDIVIDE | DynTopoFlags.FANCY_EDGE_WEIGHTS;

    this.mpos = new Vector2()
    this._radius = undefined

    this.debugSphere = new Vector3()

    this.drawFlat = false
    this.drawMask = true
    this._last_cd_mask = -1

    this.flag |= WidgetFlags.ALL_EVENTS

    this.tool = SculptTools.CLAY
    this.slots = {}

    this._brush_lines = []

    for (const k in SculptTools) {
      const tool = (SculptTools as unknown as Record<string, number>)[k]
      this.slots[tool] = new PaintToolSlot(tool as unknown as SculptTools)
    }

    this.drawColPatches = false
    this.symmetryAxes = 1
    this.drawBVH = false
    this.drawCavityMap = false
    this.drawNodeIds = false
    this.drawWireframe = false
    this.drawValidEdges = true

    this._last_bvh_key = ''
    this._last_hqed = ''

    this.view3d = manager !== undefined ? manager.view3d : undefined
  }

  getBrush(tool: number = this.tool): any {
    if (!this.ctx) {
      return undefined
    }

    return this.slots[tool].resolveBrush(this.ctx)
  }

  /** `sharedBrushRadius` expressed in `mode` units. Converts through the last
   * dab's world-units-per-pixel when the shared value's unit differs; before
   * any dab that factor is unknown and the raw value is returned. */
  sharedRadiusFor(mode: number): number {
    if (mode === this.sharedRadiusMode || this.lastScreenRadius <= 0 || this.lastWorldRadius <= 0) {
      return this.sharedBrushRadius
    }
    const dist = this.lastWorldRadius / this.lastScreenRadius
    return mode === BrushRadiusModes.WORLD ? this.sharedBrushRadius * dist : this.sharedBrushRadius / dist
  }

  /** Store the shared radius together with the unit it is expressed in. */
  setSharedRadius(value: number, mode: number): void {
    this.sharedBrushRadius = value
    this.sharedRadiusMode = mode
  }

  abstract drawBrush(view3d: View3D, force?: boolean): void

  protected clearBrushLines(): void {
    for (const l of this._brush_lines) {
      l.remove()
    }
    this._brush_lines.length = 0
  }

  dataLink(scene: Scene, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser): void {
    for (const k in this.slots) {
      this.slots[k].dataLink(scene, getblock, getblock_addUser)
    }

    for (const tool of enumValues(SculptTools)) {
      if (!(tool in this.slots)) {
        this.slots[tool as unknown as number] = new PaintToolSlot(tool as SculptTools)
      }
    }
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)

    //deal with old files
    if (Array.isArray(this.slots)) {
      const slots = this.slots
      this.slots = {}

      for (const slot of slots) {
        this.slots[slot.tool] = slot
      }
    }

    // also happens in old files
    if ('brush' in this) {
      this.tool = (this as unknown as any)['brush'].tool
      delete this.brush
    }
  }
}
