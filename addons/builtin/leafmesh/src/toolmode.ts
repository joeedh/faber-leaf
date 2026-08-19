/**
 * The LeafMesh modeling toolmode — P12 §4, step 1.
 *
 * A sibling of the box-modeling mode, but addon-owned: it is registered from
 * `register(api)` through `api.register(...)`, and every symbol it needs comes
 * off the framework hub. It holds only view/tool state — the selection domains,
 * the overlay toggles the step-2 overlay reads, and the circle-select radius —
 * and dispatches the `leafmesh.select_*` ToolOps.
 */

import type {SceneObject, StructReader, View3D, ViewContext} from '@framework/api'
import {ElementDomain, Icons, SelMask, ToolMode, normalizeSelMask, selMaskToNames} from '@framework/api'
import type {Container, DataAPI, DataStruct, IconCheck, Menu} from '@framework/pathux'
import {HotKey, KeyMap, Vector2, createMenu, nstructjs, startMenu} from '@framework/pathux'

import {Domain} from './attrs.js'
import {LeafMeshData} from './leafmesh.js'
import {SelectNearestLeafMeshOp, selMaskToDomains} from './select_ops.js'

/** `Domain` and the contract's `ElementDomain` agree numerically; say so once. */
function hostDomain(domain: Domain): ElementDomain {
  return domain as unknown as ElementDomain
}

/** Criterion lists for the shift-G popup, in the enum's own vocabulary. */
const SIMILAR_MENU: {mask: number; title: string; items: [string, string][]}[] = [
  {
    mask : SelMask.FACE,
    title: 'Faces',
    items: [
      ['Sides', 'FACE_SIDES'],
      ['Area', 'FACE_AREA'],
      ['Normal', 'FACE_NORMAL'],
      ['Coplanar', 'FACE_COPLANAR'],
      ['Hole Count', 'FACE_HOLES'],
    ],
  },
  {
    mask : SelMask.EDGE,
    title: 'Edges',
    items: [
      ['Length', 'EDGE_LENGTH'],
      ['Direction', 'EDGE_DIRECTION'],
      ['Face Count', 'EDGE_FACES'],
    ],
  },
  {
    mask : SelMask.VERTEX,
    title: 'Vertices',
    items: [
      ['Edge Count', 'VERT_EDGES'],
      ['Face Count', 'VERT_FACES'],
    ],
  },
]

export class LeafMeshToolMode extends ToolMode {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
leafmesh.LeafMeshToolMode {
    leafMeshSelMode      : string | obj.leafMeshSelModeName;
    drawSelectionOverlay : bool;
    drawWireframe        : bool;
    drawPoints           : bool;
    xray                 : bool;
    selectRadius         : float;
}
    `
  )

  /** Active element-selection domains (`SelMask.VERTEX|EDGE|FACE`). The
   * selection ops read this to decide which `.select` layers they write. */
  leafMeshSelMode = SelMask.VERTEX

  /** Write-side of the frozen name form; see `core/select_types.ts`. */
  get leafMeshSelModeName(): string {
    return selMaskToNames(this.leafMeshSelMode)
  }

  /** Draw selected / active elements (the step-2 overlay reads these four). */
  drawSelectionOverlay = true
  drawWireframe = true
  drawPoints = true
  xray = false
  /** Circle/brush-select radius, screen px. */
  selectRadius = 25

  /* The shift-G popup gets only a context, so remember where the cursor was. */
  private _lastScreenX = 0
  private _lastScreenY = 0

  static toolModeDefine() {
    return {
      name       : 'leafmesh',
      uiname     : 'Leaf Model',
      // Shared with the BREP editor until P13 removes it, at which point this
      // is the only mesh-editing mode wearing it.
      icon       : Icons.MESHTOOL,
      flag       : 0,
      description: 'Model a LeafMesh (select / extrude / inset / loop cut)',
      selectMode : SelMask.OBJECT,
      transWidgets: [],
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = super.defineAPI(api, struct)

    st.flags('leafMeshSelMode', 'leafMeshSelMode', {
      VERTEX: SelMask.VERTEX,
      EDGE  : SelMask.EDGE,
      FACE  : SelMask.FACE,
    })
      .icons({
        VERTEX: Icons.VERT_MODE,
        EDGE  : Icons.EDGE_MODE,
        FACE  : Icons.FACE_MODE,
      })
      .description('Selection mode (shift-click to add domains)')

    st.bool('drawSelectionOverlay', 'drawSelectionOverlay', 'Selection Overlay')
      .icon(Icons.SELECTION_OVERLAY)
      .description('Highlight selected / active elements')
    st.bool('drawWireframe', 'drawWireframe', 'Wireframe')
      .icon(Icons.DRAW_SCULPT_WIREFRAME)
      .description('Draw all edges as a dim wireframe overlay')
    st.bool('drawPoints', 'drawPoints', 'Vertex Points')
      .icon(Icons.VERTEX_POINTS)
      .description('Draw every vertex as a billboard point')
    st.bool('xray', 'xray', 'X-Ray').icon(Icons.XRAY).description('Draw the overlays through the mesh')
    st.float('selectRadius', 'selectRadius', 'Select Radius').noUnits().range(1, 500).step(1.0)

    return st
  }

  /**
   * Vertex / edge / face chips: a plain click switches to exactly that domain,
   * shift-click toggles it into the set. The stock flag-prop expansion toggles
   * bits independently, which lets a click clear the last domain and leave
   * nothing selectable — hence the hand-built press handler.
   */
  static buildSelModeChips(strip: Container<ViewContext>, name: string): void {
    const path = `scene.tools.${name}.leafMeshSelMode`
    const uinames = {VERTEX: 'Vertex', EDGE: 'Edge', FACE: 'Face'}

    for (const key of ['VERTEX', 'EDGE', 'FACE'] as const) {
      const bit: number = SelMask[key]
      const chip = strip.check(`${path}[${key}]`, uinames[key]) as IconCheck<ViewContext>

      chip.description = `${uinames[key]} select mode (shift-click to combine modes)`

      chip._on_press = (e?: Event): void => {
        const ctx = chip.ctx
        const cur = chip.getPathValue(ctx, path) as number
        let next: number = bit

        if ((e as MouseEvent | undefined)?.shiftKey) {
          next = cur & bit ? cur & ~bit : cur | bit
        }

        // Never leave every domain off — the viewport would select nothing.
        chip.setPathValue(ctx, path, next || cur)
      }
    }
  }

  /**
   * The shift-G "Select Similar" popup: the criteria for each enabled domain,
   * each entry seeded from that domain's active element. One domain enabled
   * gives its criteria directly; several give a menu of submenus.
   */
  static buildSelectSimilarMenu(ctx: ViewContext, mode: number): Menu | undefined {
    // createMenu's CTX constraint doesn't accept ViewContext (invariant `api`),
    // so cast across the path.ux boundary in one place.
    const mk = (title: string, templ: unknown[]): Menu =>
      createMenu(ctx as never, title, templ as never) as unknown as Menu
    const item = (label: string, criterion: string): [string, () => void] => [
      label,
      (): void => {
        ctx.api.execTool(ctx, `leafmesh.select_similar(criterion=${criterion})`)
      },
    ]

    const sections = SIMILAR_MENU.filter((s) => mode & s.mask).map((s) =>
      mk(
        s.title,
        s.items.map(([label, criterion]) => item(label, criterion))
      )
    )

    if (sections.length === 0) {
      return undefined
    }
    return sections.length === 1 ? sections[0] : mk('Select Similar', sections)
  }

  private _popupSelectSimilar(ctx: ViewContext): void {
    const menu = LeafMeshToolMode.buildSelectSimilarMenu(ctx, this.leafMeshSelMode)
    if (menu) {
      startMenu(menu, this._lastScreenX, this._lastScreenY)
    }
  }

  static buildHeader(header: Container<ViewContext>, addHeaderRow: () => Container<ViewContext>): void {
    super.buildHeader(header, addHeaderRow)

    const name = this.toolModeDefine().name

    let strip = header.strip()
    strip.useIcons(true)
    this.buildSelModeChips(strip, name)
    strip.prop(`scene.tools.${name}.drawSelectionOverlay`)
    strip.prop(`scene.tools.${name}.drawWireframe`)
    strip.prop(`scene.tools.${name}.drawPoints`)
    strip.prop(`scene.tools.${name}.xray`)

    const row = addHeaderRow()
    strip = row.strip()
    strip.useIcons(true)
    strip.tool('leafmesh.select_all(mode=AUTO)')
    strip.tool('leafmesh.select_box()')
    strip.tool('leafmesh.select_circle()')

    header.flushUpdate()
  }

  /** The active object's LeafMesh, or undefined when the mode is not on one. */
  private _data(): LeafMeshData | undefined {
    const data = this.ctx?.object?.data
    return data instanceof LeafMeshData ? data : undefined
  }

  /**
   * Left-click selection: plain click replace-selects the nearest element in the
   * first enabled domain, shift-click toggles it. Ctrl-click is left alone — it
   * is the global 3D-cursor shortcut.
   */
  on_mousedown(e: PointerEvent, x: number, y: number): boolean | void {
    if (e.button !== 0 || e.altKey || e.ctrlKey || this.hasWidgetHighlight()) {
      return false
    }

    const ctx = this.ctx
    if (!ctx?.view3d || !ctx.object || this._data() === undefined) {
      return false
    }

    const op = new SelectNearestLeafMeshOp()
    op.is_modal = false // the click position is already known; skip the modal wait
    op.inputs.useXY.setValue(true)
    op.inputs.x.setValue(x)
    op.inputs.y.setValue(y)
    op.inputs.toggle.setValue(e.shiftKey)
    ctx.toolstack.execTool(ctx, op)
    return true
  }

  /** Hover highlight: the nearest element in the first enabled domain. */
  on_mousemove(e: PointerEvent, x: number, y: number): boolean | void {
    this._lastScreenX = e.x
    this._lastScreenY = e.y

    if (e.buttons !== 0) {
      return // dragging — modal ops own the pointer
    }

    const ctx = this.ctx
    const view3d = ctx?.view3d
    const object = ctx?.object
    const data = this._data()
    if (!view3d || !object || data === undefined) {
      return
    }

    this._setHover(ctx, view3d, object, x, y, data)
  }

  private _setHover(
    ctx: ViewContext,
    view3d: View3D,
    object: SceneObject,
    x: number,
    y: number,
    data: LeafMeshData
  ): void {
    const domain = selMaskToDomains(this.leafMeshSelMode)[0]
    const mask = domain === Domain.FACE ? SelMask.FACE : domain === Domain.EDGE ? SelMask.EDGE : SelMask.VERTEX
    const hits = data.findNearest(ctx, view3d, object, mask, new Vector2([x, y]), 1)
    const elem = hits?.[0]?.data as {type: string; index: number} | undefined

    LeafMeshToolMode.clearHighlight(data)

    if (elem !== undefined) {
      const hovered = elem.type === 'face' ? Domain.FACE : elem.type === 'edge' ? Domain.EDGE : Domain.VERT
      data.setHighlightElement(hostDomain(hovered), elem.index)
    }
  }

  /** Drop the hover highlight in every domain. */
  private static clearHighlight(data: LeafMeshData): void {
    for (const d of [Domain.VERT, Domain.EDGE, Domain.FACE]) {
      data.setHighlightElement(hostDomain(d), undefined)
    }
  }

  onInactive(): void {
    const data = this._data()
    if (data !== undefined) {
      LeafMeshToolMode.clearHighlight(data)
    }
    super.onInactive()
  }

  defineKeyMap(): void {
    // G / R / S arrive with the transform bridge (P12 step 3); until then the
    // mode is selection-only by design.
    this.keymap = new KeyMap([
      new HotKey('A', [], 'leafmesh.select_all(mode=AUTO)'),
      new HotKey('A', ['alt'], 'leafmesh.select_all(mode=NONE)'),
      new HotKey('B', [], 'leafmesh.select_box()'),
      new HotKey('C', [], 'leafmesh.select_circle()'),
      new HotKey('L', [], 'leafmesh.select_linked()'),
      new HotKey('G', ['shift'], (ctx) => this._popupSelectSimilar(ctx as ViewContext)),
    ])
  }

  loadSTRUCT(reader: StructReader<this>): void {
    super.loadSTRUCT(reader)

    // Older files store this as a raw int; newer ones as the frozen name form.
    this.leafMeshSelMode = normalizeSelMask(this.leafMeshSelMode, SelMask.VERTEX)
  }
}
