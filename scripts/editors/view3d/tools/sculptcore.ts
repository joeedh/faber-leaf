import {
  Container,
  DataAPI,
  DataStruct,
  haveModal,
  HotKey,
  KeyMap,
  Matrix4,
  nstructjs,
  PackFlags,
  PanelContents,
  UIBase,
  util,
  Vector2,
  Vector3,
  Vector4,
  IconButton,
  Button,
} from '../../../path.ux/pathux'
import {FeatureFlags} from '../../../core/feature-flag'
import {ToolMode, type IToolModeDefine} from '../view3d_toolmode'
import {PaintToolModeBase} from './stroke_base.js'
import {Icons} from '../../icon_enum.js'
import type {View3D} from '../view3d'
import {
  BrushFlags,
  DynTopoFlags,
  DynTopoOverrides,
  DynTopoFlagsSC,
  DynTopoOverridesSC,
  SculptIcons,
  SculptTools,
  StrokeMethod,
} from '../../../brush/brush_base.js'
import {SelMask} from '../../../core/select_types.js'
import type {ISurfaceSampler} from '../../../util/spatial'
import type {LiteMesh} from '../../../lite-mesh/index'
import {BrushRadiusModes, DynTopoSettings, DynTopoSettingsSC, SculptBrush} from '../../../brush/index'
import type {ViewContext} from '../../../core/context'
import {DataBlockBrowser} from '../../editor_base'
import {SculptPaintOp} from './sculptcore_ops'
import {TOOL_TO_SCULPTBRUSH, wingApexOffset} from './sculptcore_bindings'

/* Shift-smooth over a poly-group brush relaxes the group boundaries in the
 * surface, so projection sits just below 1 — a sliver of normal-direction
 * smoothing keeps the relaxed boundary from crawling off the surface. */
const POLYGROUP_SMOOTH_PROJECTION = 0.9

export class SculptCorePaintMode extends PaintToolModeBase {
  _apiDynTopo: any
  _apiDynTopoSC: any
  /** Tool-mode dyntopo defaults for the sculptcore path (per-brush overrides
   * merge over this via DynTopoSettingsSC.loadDefaults). */
  dynTopoSC = new DynTopoSettingsSC()

  /** Draw the boundary-feature overlay (seam=orange, sharp=cyan, projected=green,
   * UV-chart=yellow). Poly-group edges are a separate opt-in toggle below. */
  drawFeatureOverlay = true

  /** Draw poly-group boundary edges (magenta). Off by default and refreshed each
   * dab while painting groups (ImmediateTODOs #28). Independent of the feature
   * overlay's seam/sharp edges, but only visible while that overlay is on. */
  drawPolyGroupEdges = false

  /** Scene-wide backface culling for view-normal automasking. Brushes with
   * BrushFlags.SHARED_CULL_BACKFACES read this instead of their own
   * BrushFlags.CULL_BACKFACES; see resolveCullBackfaces. */
  sceneCullBackfaces = false

  /** Accumulated dyntopo op counts for the current/last stroke (debug HUD). */
  dynTopoStats = {splits: 0, collapses: 0, flips: 0, rounds: 0, budgetHit: false}

  /** Last screen-space pointer direction, used to orient the Wing Scrape plane
   * preview between dabs (the engine's strokeDir only exists mid-stroke). */
  private wingScreenDir = new Vector2([1, 0])
  private wingPrevMpos: Vector2 | undefined

  /** Reset the per-stroke dyntopo stats accumulator (call at stroke start). */
  resetDynTopoStats(): void {
    this.dynTopoStats = {splits: 0, collapses: 0, flips: 0, rounds: 0, budgetHit: false}
  }

  /** One-line HUD summary of the current/last GPU brush stroke (§9.7 of
   * plans/gpuGlobalBrushes.md) — dab/dispatch counts, filter-set size, upload
   * bytes, marshal/upload/submit CPU ms, and GPU pass ms when timestamp-query
   * is granted. Empty dash when no GPU stroke has run. */
  get gpuBrushStatsLabel(): string {
    const s = (window as unknown as {DEBUG?: {gpuBrush?: {lastStats?: Record<string, number | boolean | string>}}})
      .DEBUG?.gpuBrush?.lastStats
    if (!s?.dabs) {
      return 'GPU Brush: —'
    }
    const ms = (v: unknown) => (typeof v === 'number' ? v.toFixed(1) : '0')
    const mode = s.gpuResident ? 'resident' : 'readback'
    return (
      `GPU Brush(${mode}): ${s.dabs}d/${s.dispatches}x sc${s.scatterDispatches} ` +
      `${s.uniqueCount}v ${s.bytesUploadedLastDab}B ` +
      `m${ms(s.marshalMs)} u${ms(s.uploadMs)} s${ms(s.submitMs)} r${ms(s.readbackMs)} g${ms(s.gpuMs)}ms` +
      (s.tripwireTripped ? ' TRIPPED' : '')
    )
  }

  /** One-line HUD summary of the current/last stroke's dyntopo activity. */
  get dynTopoStatsLabel(): string {
    const s = this.dynTopoStats
    if (s.splits === 0 && s.collapses === 0 && s.flips === 0) {
      return 'DynTopo: —'
    }
    return `DynTopo: +${s.splits} −${s.collapses} ⇄${s.flips} r${s.rounds}${s.budgetHit ? ' (capped)' : ''}`
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
        SculptCorePaintMode {
          dynTopoSC : DynTopoSettingsSC;
          sceneCullBackfaces : bool;
        }
    `
  )

  static toolModeDefine(): IToolModeDefine {
    return {
      name        : 'sculptcore',
      uiname      : 'Sculptcore',
      icon        : Icons.SCULPT_DRAW,
      flag        : 0,
      description : 'Sculptcore mode',
      selectMode  : SelMask.OBJECT,
      transWidgets: [],
    }
  }

  static buildSettings(container: Container<ViewContext>): void {
    const name = this.toolModeDefine().name
    const path = `scene.tools.${name}`

    const browser = document.createElement('data-block-browser-x') as DataBlockBrowser<SculptBrush>
    browser.blockClass = SculptBrush
    browser.setAttribute('datapath', path + '.brush')
    browser.filterFunc = function (brush: SculptBrush): boolean {
      if (!browser.ctx) {
        return false
      }

      const toolmode = browser.ctx.toolmode! as SculptCorePaintMode
      return brush.tool === toolmode.tool
    }

    const row = container.row()
    row.add(browser)
    row.useIcons(true)
    row.tool("brush.load_default(dataPath='scene.tools.sculptcore.brush')")

    const col = container.col()
    let strip
    let panel
    let panel2

    const settings = col.panel('Brush Settings')
    settings.closed = true
    strip = settings.row().strip()
    strip.useIcons(false)
    strip.label('Spacing')
    strip.prop(path + '.brush.spacingMode')

    strip = settings.row().strip()
    strip.useIcons(false)
    strip.label('Stroke Method')
    strip.prop(path + '.brush.strokeMethod')

    strip = settings.row().strip()
    strip.useIcons(false)
    strip.label('Anchored Live')
    strip.prop(path + '.brush.anchoredDragRadius')
    strip.prop(path + '.brush.anchoredLiveMode')

    function doChannel(chName: string, settingsPanel: PanelContents<ViewContext> = settings) {
      const strip = settingsPanel.col()

      const panelCh = strip.panel('')
      const col2 = panelCh.panelFrame.titleframe.strip()
      if (chName === 'radius') {
        col2.prop(path + `.brushRadius`)
      } else {
        col2.prop(path + `.brush.${chName}`)
      }
      col2.flushUpdate()

      panelCh.panelFrame.openCloseIcon.overrideClassDefault('panel.header', 'iconSize', 12)

      panelCh.panelFrame.overrideDefault('padding-top', 0)
      panelCh.panelFrame.overrideDefault('padding-bottom', 0)
      panelCh.prop(path + `.brush.dynamics.${chName}.useDynamics`)
      panelCh.prop(path + `.brush.dynamics.${chName}.curve`)
      panelCh.closed = true
      panelCh.setCSS()

      panelCh.useIcons(false)
      panelCh.flushSetCSS()
      panelCh.flushUpdate()

      return strip
    }

    /*
    panel = col.panel('Texture')
    panel.closed = true
    const tex = document.createElement('texture-select-panel-x') as TextureSelectPanel

    tex.setAttribute('datapath', path + '.brush.texUser.texture')

    strip = panel.row().strip()
    strip.useIcons(false)

    strip.prop(path + '.brush.texUser.mode')
    strip.prop(path + '.brush.texUser.flag[RAKE]')
    strip.prop(path + '.brush.texUser.flag[FANCY_RAKE]')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.prop(path + '.brush.texUser.flag[ORIGINAL_CO]')
    strip.prop(path + '.brush.texUser.flag[CONSTANT_SIZE]')
    strip.prop(path + '.brush.texUser.flag[CURVED]')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.prop(path + '.brush.texUser.pinch')

    panel.add(tex)
    */

    panel = col.panel('Falloff')
    panel.prop(path + '.brush.falloff')

    panel2 = panel.panel('Square Settings')
    panel2.prop(path + '.brush.flag[SQUARE]')
    strip = panel2.row().strip()
    strip.useIcons(false)
    strip.prop(path + '.brush.flag[LINE_FALLOFF]')
    strip.prop(path + '.brush.flag[USE_LINE_CURVE]')
    panel2.prop(path + '.brush.falloff2')
    panel2.closed = true

    panel.closed = true

    let p: Container<ViewContext> | PanelContents<ViewContext>

    col.useIcons(false)

    doChannel('radius')
    doChannel('strength')

    p = doChannel('autosmooth')
    //p.prop(path + '.brush.flag[MULTIGRID_SMOOTH]')
    //p.prop(path + '.brush.flag[PLANAR_SMOOTH]')
    p.prop(path + '.brush.smoothRadiusMul')

    doChannel('smoothProj', p as PanelContents<ViewContext>)
    doChannel('autosmoothInflate', p as PanelContents<ViewContext>)

    p = doChannel('rake')
    p.prop(path + '.brush.rakeCurvatureFactor')
    p.prop(path + '.brush.flag[CURVE_RAKE_ONLY_POS_X]')

    doChannel('pinch')

    p = doChannel('concaveFilter')
    p.prop(path + '.brush.flag[INVERT_CONCAVE_FILTER]')

    const cav = col.panel('Cavity Masking')
    cav.prop(path + '.brush.flag[AUTOMASK_CAVITY]')
    cav.prop(path + '.brush.flag[AUTOMASK_CAVITY_INVERT]')
    cav.prop(path + '.brush.cavityFactor')
    cav.prop(path + '.brush.cavityBlurSteps')
    cav.prop(path + '.brush.flag[AUTOMASK_CAVITY_CURVE]')
    cav.prop(path + '.brush.cavityCurve')
    cav.closed = true

    // View-normal masking. The cull toggle is the scene/brush proxy; the icon
    // button beside it picks which of the two the proxy is reading.
    const vnm = col.panel('View Normal Masking')
    vnm.prop(path + '.brush.flag[AUTOMASK_VIEW_NORMAL]')
    const cullRow = vnm.row()
    strip = cullRow.strip()
    strip.useIcons(false)
    strip.prop(`scene.tools.${name}.cullBackfaces`)
    strip = cullRow.strip()
    strip.useIcons(true)
    strip.prop(path + '.brush.flag[SHARED_CULL_BACKFACES]', PackFlags.HIDE_CHECK_MARKS)
    vnm.prop(path + '.brush.viewNormalLimit')
    vnm.prop(path + '.brush.viewNormalFalloff')
    vnm.closed = true

    // Enhance-details brush params (only used by the Enhance tool).
    const enh = col.panel('Enhance Details')
    enh.prop(path + '.brush.enhanceRings')
    enh.prop(path + '.brush.enhanceInner')
    enh.closed = true

    doChannel('sharp')

    col.useIcons(false)
    col.prop(path + '.brush.flag[INVERT]')
    col.prop(path + '.brush.flag[ACCUMULATE]')
    col.prop(path + '.brush.spacing')
    col.prop(path + '.brush.color')
    col.prop(path + '.brush.bgcolor')
    col.tool(`brush.swap_colors(dataPath='${path}.brush')`)

    col.prop(path + '.brush.planeoff')
    col.prop(path + '.brush.wingAngle')
    col.prop(path + '.brush.planeNormalMode')
    col.prop(path + '.brush.normalfac')

    function dfield(con: Container<ViewContext>, key: string): UIBase<ViewContext> {
      const row = con.row()
      const strip = row.strip(undefined, 4, 0)

      strip.overrideDefault('labelOnTop', 0)
      strip.overrideDefault('BoxMargin', 0)
      strip.overrideDefault('margin', 0)
      strip.overrideDefault('BoxRadius', 5)

      const opath = `${path}.dynTopo.overrides[NONE]`

      const okey = DynTopoSettingsSC.apiKeyToOverride(key)
      const ret = strip.prop(`${path}.dynTopo.${key}`)
      if (!okey) {
        // No override mapping for this key — render the value without the
        // per-field inherit toggle (avoids an `overrides[undefined]` binding).
        return ret
      }
      const icon = strip.iconcheck(`${path}.dynTopo.overrides[${okey}]`, -1)

      icon.iconsheet = 0 //use small icons
      icon.drawCheck = false

      icon.updateAfter(() => {
        if (!icon.ctx) {
          return
        }

        const val = icon.ctx.api.getValue(icon.ctx, opath)

        if (!!val !== !!icon.disabled) {
          icon.disabled = !!val
        }
      })

      return ret
    }

    panel = col.panel('DynTopo')
    panel.useIcons(false)
    panel.noMarginsOrPadding()

    panel.prop(path + '.inheritDynTopo')
    dfield(panel, 'flag[ENABLED]')
    dfield(panel, 'edgeMode')
    dfield(panel, 'edgeSize')
    dfield(panel, 'mode')
    dfield(panel, 'flag[DO_SMOOTH]')
    dfield(panel, 'flag[PRESERVE_FEATURES]')

    panel2 = panel.panel('Advanced')
    dfield(panel2, 'flag[DO_FLIPS]')
    dfield(panel2, 'collapseRatio')
    dfield(panel2, 'grade')
    dfield(panel2, 'smoothLambda')
    dfield(panel2, 'maxSplits')
    dfield(panel2, 'maxRounds')
    dfield(panel2, 'dynTopoSpacing')

    if (FeatureFlags.get('sculptcore.quad_remesher')) {
      col.toolPanel('litemesh.quad_remesh')
    }

    const dbg = col.panel('Debug')
    dbg.useIcons(false)
    dbg.prop('object.data.saveTempAttrs')

    //panel
    container.flushUpdate()
  }

  static buildHeader(header: Container<ViewContext>, addHeaderRow: () => Container<ViewContext>): void {
    super.buildHeader(header, addHeaderRow)

    const name = this.toolModeDefine().name

    // see SculptCorePaintMode.defineAPI for how these properties are defined

    let strip = header.strip()
    strip.prop(`scene.tools.${name}.drawBVH`)
    strip.prop(`scene.tools.${name}.drawFlat`)
    strip.prop(`scene.tools.${name}.drawWireframe`)
    strip.prop(`scene.tools.${name}.drawMask`)
    strip.prop(`scene.tools.${name}.drawFeatureOverlay`)
    strip.prop(`scene.tools.${name}.drawPolyGroupEdges`)
    strip.pathlabel(`scene.tools.${name}.dynTopoStatsLabel`, '')
    strip.pathlabel(`scene.tools.${name}.gpuBrushStatsLabel`, '')

    let row = addHeaderRow()
    const path = `scene.tools.${name}.brush`

    strip = row.strip()
    strip.useIcons(true)

    //strip.listenum(path + ".tool");
    strip.prop(`scene.tools.${name}.tool`)

    row = addHeaderRow()
    strip = row.strip()
    strip.useIcons(true)
    strip.tool('litemesh.symmetrize()')
    strip.tool('litemesh.mark_seam_interactive()')
    strip.tool('litemesh.mark_sharp_interactive()')
    strip.tool('litemesh.mark_sharp_by_angle()')
    strip.tool('litemesh.generate_uv()')
    strip.tool('litemesh.triangulate()')
    if (FeatureFlags.get('sculptcore.quad_remesher')) {
      strip.tool('litemesh.quad_remesh()')
    }
    // TODO: draw a small "large mesh would be faster if triangulated" footer tip
    // overlay in the viewport when the active object is a LiteMesh that is both
    // large (mesh.triCount over a threshold, ~1M) and still has n-gons
    // (LiteMesh.hasNgons()), pointing the user at the Triangulate button above.
    // dyntopo on a quad mesh pays a per-dab triangulate prepass + scans an
    // unbalanced BVH; one-time triangulating fixes both.
    strip.prop(`scene.tools.${name}.symmetryAxes`)
    // Click a face -> extrude every face in its poly group (the polygroup brush
    // paints the groups; this pulls a painted region out).
    strip.tool('litemesh.extrude_polygroup()')

    row = addHeaderRow()
    strip = row.strip()
    strip.prop(path + '.dynamics.radius.useDynamics')
    strip.prop(`scene.tools.${name}.brushRadius`)
    strip.prop(path + '.flag[SHARED_SIZE]', PackFlags.HIDE_CHECK_MARKS)
    // Via the ToolOp, not the raw `radiusMode` datapath: switching the unit has
    // to rescale the stored radius or the brush changes size on the switch.
    const screenRadiusMode = strip.tool('brush.set_radius_mode(mode=SCREEN)')
    const worldRadiusMode = strip.tool('brush.set_radius_mode(mode=WORLD)')

    if (screenRadiusMode) {
      if (!(screenRadiusMode instanceof IconButton)) {
        screenRadiusMode.name = 'Screen'
      }
      screenRadiusMode.title = 'Set brush radius space to screen'
    }
    if (worldRadiusMode) {
      if (!(worldRadiusMode instanceof IconButton)) {
        worldRadiusMode.name = 'World'
      }
      worldRadiusMode.title = 'Set brush radius space to world'
    }

    strip.prop(path + '.dynamics.strength.useDynamics')
    strip.prop(path + '.strength')

    strip = row.strip()
    strip.pathlabel('object.data.faceCount', 'Faces')

    strip.prop(path + '.spacing')

    row = addHeaderRow()
    strip = row.strip()
    strip.prop(`scene.tools.${name}.reprojectCustomData`)

    header.flushUpdate()
  }

  static defineAPI(api: DataAPI): DataStruct {
    const st = super.defineAPI(api)

    st.flags('symmetryAxes', 'symmetryAxes', {
      X: 1,
      Y: 2,
      Z: 4,
    }).icons({
      X: Icons.SYM_X,
      Y: Icons.SYM_Y,
      Z: Icons.SYM_Z,
    })

    st.float('sharedBrushRadius', 'sharedBrushRadius', 'Shared Radius').noUnits().range(0, 450).decimalPlaces(2)
    st.float('_brushSizeHelper', 'brushRadius', 'Radius')
      .noUnits()
      .range(0, 450)
      .step(2.0)
      .decimalPlaces(2)
      .description('Press F to set brush radius interactively')

    st.bool('sceneCullBackfaces', 'sceneCullBackfaces', 'Scene Cull Backfaces').description(
      'Scene-wide backface culling, used by brushes that defer to the tool mode'
    )
    st.bool('_cullBackfacesHelper', 'cullBackfaces', 'Cull Backfaces').description(
      'Skip geometry facing away from the view instead of fading it in with the front side'
    )

    function onchange(this: any): void {
      const toolmode = this.dataref
      const mesh = toolmode.ctx.mesh

      if (mesh?.bvh && !mesh.bvh.dead) {
        mesh.bvh.redrawAll()
        window.redraw_viewport(true)
      }
    }

    st.bool('drawWireframe', 'drawWireframe', 'Draw Wireframe').on('change', onchange).icon(Icons.DRAW_SCULPT_WIREFRAME)
    st.bool('drawBVH', 'drawBVH', 'Draw BVH').on('change', onchange)
    st.bool('drawMask', 'drawMask', 'Draw Mask').on('change', onchange)

    st.bool('drawColPatches', 'drawColPatches', 'Draw Color Patches').on('change', onchange)

    st.bool('drawNodeIds', 'drawNodeIds', 'Draw BVH Vertex IDs').on('change', onchange)
    st.bool('drawFlat', 'drawFlat', 'Draw Flat').on('change', onchange).icon(Icons.DRAW_SCULPT_FLAT)
    const refreshSeams = function (this: any) {
      const mesh = this.dataref?.ctx?.mesh
      if (mesh && 'markSeamsDirty' in mesh) {
        ;(mesh as LiteMesh).markSeamsDirty()
      }
      window.redraw_viewport(true)
    }
    st.bool('drawFeatureOverlay', 'drawFeatureOverlay', 'Feature Overlay')
      .description('Draw seam / sharp / UV-chart boundaries')
      .on('change', refreshSeams)
    st.bool('drawPolyGroupEdges', 'drawPolyGroupEdges', 'Poly Group Edges')
      .description('Draw poly-group boundary edges (off by default; updates each dab)')
      .on('change', refreshSeams)
    st.string('dynTopoStatsLabel', 'dynTopoStatsLabel', 'DynTopo Stats').readOnly()
    st.string('gpuBrushStatsLabel', 'gpuBrushStatsLabel', 'GPU Brush Stats').readOnly()
    /* Only tools sculptcore implements (TOOL_TO_SCULPTBRUSH) are selectable
     * here; SculptTools still carries entries no kernel backs. */
    const sculptcoreTools = {} as Record<string, number>
    for (const [k, v] of Object.entries(deleteTsEnumIntegers(SculptTools))) {
      // Layer Draw is retired from the picker (sculptLayersV2: the panel's
      // edit-target toggle replaces it); the engine kernel stays as a test
      // fixture for the sbrush attr-redirection path.
      if ((v as number) === SculptTools.LAYER_DRAW) {
        continue
      }
      if ((v as number) in TOOL_TO_SCULPTBRUSH) {
        sculptcoreTools[k] = v as number
      }
    }
    st.enum('tool', 'tool', sculptcoreTools).icons(SculptIcons)

    st.struct('_apiBrushHelper', 'brush', 'Brush', api.mapStruct(SculptBrush))

    // Sculptcore dyntopo: the datapath stays `dynTopo` / `inheritDynTopo` (so the
    // UI paths are unchanged) but is backed by the sculptcore DynTopoSettingsSC.
    st.struct('_apiDynTopoSC', 'dynTopo', 'DynTopo', api.mapStruct(DynTopoSettingsSC))
    st.bool('_apiInheritDynTopoSC', 'inheritDynTopo', 'Inherit Everything')

    st.bool('reprojectCustomData', 'reprojectCustomData', 'Reproject UVs & colors').icon(Icons.REPROJECT_CUSTOM_DATA)

    return st
  }

  /** Material tab: click a face to put its whole poly group on the chooser's
   * active slot. Sculpt mode has no face selection, so the group is the unit. */
  static buildMaterialPanel(container: Container<ViewContext>, slot: number): void {
    container.tool(`litemesh.assign_material_polygroup(slot=${slot})`)
  }

  defineKeyMap(): void {
    this.keymap = new KeyMap([
      new HotKey('F', [], 'brush.set_radius()'),
      new HotKey('.', [], 'view3d.view_selected()'),
      // No Alt+M: `paint.clear_mask` was a legacy-Mesh op and went with the TS
      // PBVH stack in P5. Restoring it needs a sculptcore-side mask fill.
      new HotKey('K', [], 'litemesh.mark_seam_interactive()'),
      new HotKey('K', ['shift'], 'litemesh.mark_sharp_interactive()'),
    ])
  }

  constructor(manager: any) {
    super(manager)

    this.tool = SculptTools.DRAW

    this._apiDynTopo = new Proxy(this.dynTopo, {
      get: (target: any, key: string | symbol): any => {
        const brush = this.getBrush()

        if (brush && key === 'overrideMask') {
          return brush.dynTopo.overrideMask
        }

        const all = !brush || brush.dynTopo.overrideMask & DynTopoOverrides.NONE

        if (all) {
          return (this.dynTopo as any)[key]
        }

        if (key !== 'flag') {
          const key2 = DynTopoSettings.apiKeyToOverride(key as string)

          if (!key2) {
            return (brush.dynTopo as any)[key]
          }

          let override = DynTopoOverrides[key2 as keyof typeof DynTopoOverrides] as unknown as number
          override = brush.dynTopo.overrideMask & override

          if (override) {
            return (brush.dynTopo as any)[key]
          } else {
            return (this.dynTopo as any)[key]
          }
        } else {
          //create merged flags
          let flag = 0

          const f1 = this.dynTopo.flag
          const f2 = brush.dynTopo.flag
          const oflag = brush.dynTopo.overrideMask

          for (const k in DynTopoFlags) {
            const f = DynTopoFlags[k] as unknown as number

            if (oflag & f) {
              flag |= f2 & f ? f : 0
            } else {
              flag |= f1 & f ? f : 0
            }
          }

          return flag
        }
      },
      set: (target: any, key: string | symbol, val: any): boolean => {
        const brush = this.getBrush()

        const all = !brush || brush.dynTopo.overrideMask & DynTopoOverrides.NONE

        if (brush && key === 'overrideMask') {
          brush.dynTopo.overrideMask = val
          return true
        } else if (all) {
          ;(this.dynTopo as any)[key] = val
          return true
        }

        if (key !== 'flag') {
          const key2 = DynTopoSettings.apiKeyToOverride(key as string)

          if (
            key2 &&
            brush.dynTopo.overrideMask & (DynTopoOverrides[key2 as keyof typeof DynTopoOverrides] as unknown as number)
          ) {
            ;(brush.dynTopo as any)[key] = val
          } else {
            ;(this.dynTopo as any)[key] = val
          }
        } else {
          const flag = 0
          const oflag = brush.dynTopo.overrideMask

          for (const k in DynTopoFlags) {
            const f = DynTopoFlags[k] as unknown as number
            const dynTopo = oflag & f ? brush.dynTopo : this.dynTopo

            if (val & f) {
              dynTopo.flag |= f
            } else {
              dynTopo.flag &= ~f
            }
          }
        }

        return true
      },
    })

    // Sculptcore dyntopo: same mode-default + per-brush-override merge as the
    // legacy proxy above, over DynTopoSettingsSC / DynTopoOverridesSC.
    this._apiDynTopoSC = new Proxy(this.dynTopoSC, {
      get: (target: any, key: string | symbol): any => {
        const brush = this.getBrush()

        if (brush && key === 'overrideMask') {
          return brush.dynTopoSC.overrideMask
        }

        const all = !brush || brush.dynTopoSC.overrideMask & DynTopoOverridesSC.NONE

        if (all) {
          return (this.dynTopoSC as any)[key]
        }

        if (key !== 'flag') {
          const key2 = DynTopoSettingsSC.apiKeyToOverride(key as string)

          if (!key2) {
            return (brush.dynTopoSC as any)[key]
          }

          let override = DynTopoOverridesSC[key2 as keyof typeof DynTopoOverridesSC] as unknown as number
          override = brush.dynTopoSC.overrideMask & override

          if (override) {
            return (brush.dynTopoSC as any)[key]
          } else {
            return (this.dynTopoSC as any)[key]
          }
        } else {
          let flag = 0

          const f1 = this.dynTopoSC.flag
          const f2 = brush.dynTopoSC.flag
          const oflag = brush.dynTopoSC.overrideMask

          for (const k in DynTopoFlagsSC) {
            const f = DynTopoFlagsSC[k as keyof typeof DynTopoFlagsSC] as unknown as number
            if (typeof f !== 'number') {
              continue
            }

            if (oflag & f) {
              flag |= f2 & f ? f : 0
            } else {
              flag |= f1 & f ? f : 0
            }
          }

          return flag
        }
      },
      set: (target: any, key: string | symbol, val: any): boolean => {
        const brush = this.getBrush()

        const all = !brush || brush.dynTopoSC.overrideMask & DynTopoOverridesSC.NONE

        if (brush && key === 'overrideMask') {
          brush.dynTopoSC.overrideMask = val
          return true
        } else if (all) {
          ;(this.dynTopoSC as any)[key] = val
          return true
        }

        if (key !== 'flag') {
          const key2 = DynTopoSettingsSC.apiKeyToOverride(key as string)

          if (
            key2 &&
            brush.dynTopoSC.overrideMask &
              (DynTopoOverridesSC[key2 as keyof typeof DynTopoOverridesSC] as unknown as number)
          ) {
            ;(brush.dynTopoSC as any)[key] = val
          } else {
            ;(this.dynTopoSC as any)[key] = val
          }
        } else {
          const oflag = brush.dynTopoSC.overrideMask

          for (const k in DynTopoFlagsSC) {
            const f = DynTopoFlagsSC[k as keyof typeof DynTopoFlagsSC] as unknown as number
            if (typeof f !== 'number') {
              continue
            }

            const dynTopo = oflag & f ? brush.dynTopoSC : this.dynTopoSC

            if (val & f) {
              dynTopo.flag |= f
            } else {
              dynTopo.flag &= ~f
            }
          }
        }

        return true
      },
    })
  }

  onInactive() {
    this.clearBrushLines()
  }

  get _brushSizeHelper(): number {
    const brush = this.getBrush()

    if (!brush) {
      return 55.0
    }

    if (brush.flag & BrushFlags.SHARED_SIZE) {
      return this.sharedRadiusFor(brush.radiusMode)
    } else {
      return brush.radius
    }
  }

  set _brushSizeHelper(val: number) {
    const brush = this.getBrush()

    if (!brush) {
      return
    }

    if (brush.flag & BrushFlags.SHARED_SIZE) {
      this.setSharedRadius(val, brush.radiusMode)
    } else {
      brush.radius = val
    }
  }

  /** Backface culling actually in force for `brush`: the tool mode's scene-wide
   * toggle when the brush defers to it, else the brush's own flag. */
  resolveCullBackfaces(brush: SculptBrush): boolean {
    if (brush.flag & BrushFlags.SHARED_CULL_BACKFACES) {
      return this.sceneCullBackfaces
    }
    return !!(brush.flag & BrushFlags.CULL_BACKFACES)
  }

  get _cullBackfacesHelper(): boolean {
    const brush = this.getBrush()

    if (!brush) {
      return this.sceneCullBackfaces
    }

    return this.resolveCullBackfaces(brush)
  }

  set _cullBackfacesHelper(val: boolean) {
    const brush = this.getBrush()

    if (!brush || brush.flag & BrushFlags.SHARED_CULL_BACKFACES) {
      this.sceneCullBackfaces = val
      return
    }

    if (val) {
      brush.flag |= BrushFlags.CULL_BACKFACES
    } else {
      brush.flag &= ~BrushFlags.CULL_BACKFACES
    }
  }

  get _apiBrushHelper(): SculptBrush | undefined {
    return this.getBrush()
  }

  set _apiBrushHelper(brush: SculptBrush | undefined) {
    if (brush === undefined) {
      return
    }

    const oldbrush = this.getBrush()
    if (oldbrush === brush) {
      return
    }

    const scene = this.ctx ? this.ctx.scene : undefined
    this.slots[this.tool].setBrush(brush, scene)
  }

  get _apiInheritDynTopo(): boolean {
    const brush = this.getBrush()
    if (!brush) {
      return false
    }

    return !!(brush.dynTopo.overrideMask & DynTopoOverrides.NONE)
  }

  set _apiInheritDynTopo(v: boolean) {
    const brush = this.getBrush()
    if (!brush) {
      return
    }

    if (v) {
      brush.dynTopo.overrideMask |= DynTopoOverrides.NONE
    } else {
      brush.dynTopo.overrideMask &= ~DynTopoOverrides.NONE
    }
  }

  get _apiInheritDynTopoSC(): boolean {
    const brush = this.getBrush()
    if (!brush) {
      return false
    }

    return !!(brush.dynTopoSC?.overrideMask & DynTopoOverridesSC.NONE)
  }

  set _apiInheritDynTopoSC(v: boolean) {
    const brush = this.getBrush()
    if (!brush) {
      return
    }

    if (v) {
      brush.dynTopoSC.overrideMask |= DynTopoOverridesSC.NONE
    } else {
      brush.dynTopoSC.overrideMask &= ~DynTopoOverridesSC.NONE
    }
  }

  /** Eyedropper for the color brush: ray-pick the vertex under the cursor and
   * load its color into the active brush's primary color. No-op on a miss. */
  sampleColorUnderCursor(e: PointerEvent): void {
    const ctx = this.ctx
    if (!ctx?.view3d || !ctx.object) {
      return
    }
    const mesh = ctx.object.data as LiteMesh
    const m = ctx.view3d.getLocalMouse(e.x, e.y)
    const obmatrix = ctx.object.outputs.matrix.getValue()

    // Object-local ray through the cursor pixel: invert the local->clip
    // matrix (rendermat ∘ obmatrix; Matrix4.multiply(b) applies b first).
    const imat = new Matrix4(ctx.view3d.activeCamera.rendermat)
    imat.multiply(obmatrix)
    imat.invert()
    const d = 0.9999
    const p1 = new Vector4([m[0], m[1], -d, 1.0])
    ctx.view3d.unproject(p1, imat)
    const origin = new Vector3(p1)
    const p2 = new Vector4([m[0], m[1], d, 1.0])
    ctx.view3d.unproject(p2, imat)
    const dir = new Vector3(p2).sub(origin)

    const vert = mesh.pickVert(origin, dir)
    if (vert < 0) {
      return
    }
    const out: number[] = []
    mesh.mesh.vertexColor(vert, out)
    if (out.length < 4) {
      return
    }
    const brush = this.getBrush()
    brush.color.load([out[0], out[1], out[2], out[3]])
    brush.graphUpdate()
    window.redraw_viewport()
  }

  on_mousedown(e: PointerEvent, x: number, y: number): boolean {
    this.mpos[0] = e.x
    this.mpos[1] = e.y

    if (e.button === 0 && !e.altKey) {
      let brush = this.getBrush()

      const isColor =
        brush.tool === SculptTools.COLOR || brush.tool === SculptTools.PAINT || brush.tool === SculptTools.PAINT_SMOOTH
      const smoothtool = isColor ? SculptTools.PAINT_SMOOTH : SculptTools.SMOOTH

      // Ctrl-click with a color brush is the eyedropper: sample the vertex color
      // under the cursor into the primary color and skip the stroke entirely.
      if (e.ctrlKey && isColor) {
        this.sampleColorUnderCursor(e)
        return true
      }

      // Shift smooths. For the poly-group brush, ctrl is the "extend" modifier
      // (sample the existing group under the cursor; see useAltBrush in
      // stroke_paint_op), and shift smooths at near-full surface projection.
      const wasPolyGroup = brush.tool === SculptTools.POLYGROUP
      if (e.shiftKey) {
        brush = this.getBrush(smoothtool)
      }

      // sharedBrushRadius is unit-tagged; convert into this brush's radiusMode
      // (a SCREEN-mode smooth brush reading a WORLD-unit number floods the
      // stroke with sub-pixel-spaced dabs).
      const radius = brush.flag & BrushFlags.SHARED_SIZE ? this.sharedRadiusFor(brush.radiusMode) : brush.radius

      brush = brush.copy()
      brush.dynTopo.loadDefaults(this.dynTopo)
      brush.dynTopoSC.loadDefaults(this.dynTopoSC)
      brush.radius = radius
      if (wasPolyGroup && e.shiftKey) {
        brush.smoothProj = POLYGROUP_SMOOTH_PROJECTION
      }

      this.ctx.api.execTool(this.ctx, 'sculptcore.paint()', {
        brush       : brush,
        //drawFaceSet        : drawFaceSet,
        symmetryAxes: this.symmetryAxes,
        //dynTopoDepth       : brush.dynTopo.maxDepth,
        //useMultiResDepth   : this.enableMaxEditDepth,
        //reprojectCustomData: this.reprojectCustomData,
      })

      return true
    }

    window.redraw_viewport()

    return false
  }

  on_mousemove(e: PointerEvent, x: number, y: number, was_touch: boolean): any {
    const ret = super.on_mousemove(e, x, y, was_touch)

    this.mpos[0] = e.x
    this.mpos[1] = e.y

    // Track the pointer direction for the Wing Scrape preview. The threshold
    // keeps a jittering (effectively stationary) cursor from spinning the wings.
    if (this.wingPrevMpos === undefined) {
      this.wingPrevMpos = new Vector2(this.mpos)
    } else {
      const dx = e.x - this.wingPrevMpos[0]
      const dy = e.y - this.wingPrevMpos[1]
      if (dx * dx + dy * dy > 2.25) {
        this.wingScreenDir[0] = dx
        this.wingScreenDir[1] = dy
        this.wingScreenDir.normalize()
        this.wingPrevMpos[0] = e.x
        this.wingPrevMpos[1] = e.y
      }
    }

    if (this.ctx?.view3d) {
      this.drawBrush(this.ctx.view3d)
    }

    return ret
  }

  on_mouseup(e: PointerEvent, x: number, y: number, wasTouch: boolean): boolean {
    super.on_mouseup(e, x, y, wasTouch)

    this.mdown = false
    return false
  }

  on_drawend(view3d: View3D): void {
    this.ctx = view3d.ctx
    this.drawBrush(view3d)
  }

  drawBrush(view3d: View3D, force = false, x = this.mpos[0], y = this.mpos[1]): void {
    this.clearBrushLines()

    // XXX haveModal is too granular, leads to bad code
    // in brush.set_radius() toolop
    const activeOp = this.ctx?.toolstack?.head
    if (haveModal() && !force && !(activeOp instanceof SculptPaintOp)) {
      return
    }

    const drawCircle = (x: number, y: number, r: number, mat: Matrix4 = new Matrix4(), z: number = 0.0): void => {
      const p = new Vector3()
      p[0] = x
      p[1] = y
      p[2] = z
      this._brush_lines.push(view3d.overdraw!.circle(Array.from(p), r, 'rgb(255,175,75)'))
    }

    const brush = this.getBrush()
    if (!brush) {
      return
    }

    const radius = brush.flag & BrushFlags.SHARED_SIZE ? this.sharedRadiusFor(brush.radiusMode) : brush.radius

    const r = this._radius !== undefined ? this._radius : this.overlayScreenRadius(brush, radius)
    drawCircle(x, y, r)

    // Anchored: (x, y) is the fixed anchor for the whole stroke (applyDab
    // pins the cursor overlay there), so draw a line out to the live pointer
    // (this.mpos) -- the drag distance/direction the anchor->cursor vector
    // (radius or angle, per anchoredLiveMode) is otherwise invisible.
    if (
      activeOp instanceof SculptPaintOp &&
      activeOp.getStrokeMethod() === StrokeMethod.ANCHORED &&
      activeOp.driver?.getAnchorScreen()
    ) {
      this._brush_lines.push(view3d.overdraw!.line([x, y], [this.mpos[0], this.mpos[1]], 'rgb(255,175,75)'))
    }

    // Drag Dot: (x, y) already tracks the live positioning-preview origin
    // (applyDab's ps.screenP is the dab origin, which for Drag Dot is the
    // live cursor -- see the comment on that call site), but draw an extra,
    // visually-distinct footprint circle off the driver's own preview
    // accessor so the not-yet-committed dab is explicit rather than
    // incidental, and stays correct even if drawBrush's default (x, y) ever
    // stops tracking the dab origin.
    if (activeOp instanceof SculptPaintOp && activeOp.getStrokeMethod() === StrokeMethod.DRAG_DOT) {
      const preview = activeOp.driver?.getPreviewScreen()
      if (preview) {
        this._brush_lines.push(view3d.overdraw!.circle([preview[0], preview[1]], r, 'rgb(120,200,255)'))
      }
    }

    if (brush.tool === SculptTools.WING_SCRAPE) {
      this.drawWingPlanes(view3d, brush, x, y, r)
    }
  }

  /** Wing Scrape live preview: the two wing planes the next dab would scrape
   * onto, drawn as screen-projected quad outlines meeting at their apex ridge.
   * Mirrors wingscrape.sbrush exactly — apex sunk `planeoff * radius` below the
   * surface point, normals = surface normal rotated ∓wingAngle about the stroke
   * tangent. Silently skipped on a raycast miss. */
  private drawWingPlanes(view3d: View3D, brush: SculptBrush, x: number, y: number, screenRadius: number): void {
    const ctx = this.ctx
    if (!ctx?.object || !view3d.overdraw) {
      return
    }
    const mesh = ctx.object.data as LiteMesh
    const obmatrix = ctx.object.outputs.matrix.getValue()

    // Object-local <-> screen, so the hit point and its normal need no
    // transform (same construction as sampleColorUnderCursor).
    const mat = new Matrix4(view3d.activeCamera.rendermat)
    mat.multiply(obmatrix)
    const imat = new Matrix4(mat)
    imat.invert()

    const m = view3d.getLocalMouse(x, y)
    const d = 0.9999
    const near = new Vector4([m[0], m[1], -d, 1.0])
    view3d.unproject(near, imat)
    const far = new Vector4([m[0], m[1], d, 1.0])
    view3d.unproject(far, imat)
    const origin = new Vector3(near)
    const dir = new Vector3(far)
    dir.sub(origin)
    const isect = mesh.rayCast(origin, dir)
    if (isect === undefined) {
      return
    }

    const p = new Vector3(isect.p)
    const n = new Vector3(isect.normal)
    n.normalize()

    // Local units per screen pixel at the hit point, so a SCREEN-unit radius
    // and the screen-space stroke direction both resolve into local space.
    const s0 = new Vector3(p)
    view3d.project(s0, mat)
    const s1 = new Vector3(s0)
    s1[0] += 1
    view3d.unproject(s1, imat)
    const perPixel = s1.vectorDistance(p)
    if (!(perPixel > 0)) {
      return
    }
    const radius = brush.radiusMode === BrushRadiusModes.WORLD ? brush.radius : screenRadius * perPixel

    // Stroke tangent: the last pointer direction, pushed back into the surface
    // tangent plane. Degenerate (view looking straight down the tangent) drops
    // the preview rather than drawing a collapsed V.
    const sd = new Vector3(s0)
    sd[0] += this.wingScreenDir[0]
    sd[1] += this.wingScreenDir[1]
    view3d.unproject(sd, imat)
    const t = new Vector3(sd)
    t.sub(p)
    t.addFac(n, -t.dot(n))
    if (t.dot(t) < 1e-12) {
      return
    }
    t.normalize()

    const theta = brush.wingAngle * (Math.PI / 180.0)
    const c = Math.cos(theta)
    const sn = Math.sin(theta)
    const kxv = new Vector3(t)
    kxv.cross(n)
    const kv = t.dot(n)
    const wingNormal = (sign: number): Vector3 => {
      const wn = new Vector3(n)
      wn.mulScalar(c)
      wn.addFac(kxv, sign * sn)
      wn.addFac(t, kv * (1.0 - c))
      wn.normalize()
      return wn
    }
    // Signs as in wingscrape.sbrush: each wing leans toward its own lateral
    // side, so the pair tents up over the stroke instead of forming a valley.
    const wnA = wingNormal(-1)
    const wnB = wingNormal(1)

    // Apex line: sunk below the surface by the same offset the kernel uses.
    const planeoff = wingApexOffset(brush)
    const apex = new Vector3(p)
    apex.addFac(n, planeoff * radius)
    const lat = new Vector3(n)
    lat.cross(t)
    lat.normalize()

    // In-plane "across" axis of each wing, oriented onto its own lateral side.
    const across = (wn: Vector3, sign: number): Vector3 => {
      const a = new Vector3(wn)
      a.cross(t)
      a.normalize()
      if (a.dot(lat) * sign < 0) {
        a.negate()
      }
      return a
    }
    const aA = across(wnA, 1)
    const aB = across(wnB, -1)

    const toScreen = (v: Vector3): number[] => {
      const q = new Vector3(v)
      view3d.project(q, mat)
      return [q[0], q[1]]
    }
    const seg = (a: Vector3, b: Vector3, color: string): void => {
      this._brush_lines.push(view3d.overdraw!.line(toScreen(a), toScreen(b), color))
    }
    const corner = (alongFac: number, acrossAxis: Vector3, acrossFac: number): Vector3 => {
      const v = new Vector3(apex)
      v.addFac(t, alongFac * radius)
      v.addFac(acrossAxis, acrossFac * radius)
      return v
    }

    const wingColor = 'rgb(120,200,255)'
    for (const a of [aA, aB]) {
      const c0 = corner(-1, a, 0)
      const c1 = corner(1, a, 0)
      const c2 = corner(1, a, 1)
      const c3 = corner(-1, a, 1)
      seg(c1, c2, wingColor)
      seg(c2, c3, wingColor)
      seg(c3, c0, wingColor)
    }
    // The shared apex ridge, brighter — the crease the two wings meet at.
    seg(corner(-1, aA, 0), corner(1, aA, 0), 'rgb(255,175,75)')
  }

  /** The cursor ring is drawn in screen space, so a WORLD-unit radius has to be
   * converted back through the last dab's world-units-per-pixel. Before any dab
   * that factor is unknown; draw the raw value rather than nothing. */
  private overlayScreenRadius(brush: SculptBrush, radius: number): number {
    if (brush.radiusMode !== BrushRadiusModes.WORLD || this.lastScreenRadius <= 0) {
      return radius
    }
    const dist = this.lastWorldRadius / this.lastScreenRadius
    return dist > 0 ? radius / dist : radius
  }
}
ToolMode.register(SculptCorePaintMode)
