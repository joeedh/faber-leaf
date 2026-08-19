/**
 * Box-modeling tool mode (Milestone 0 of documentation/plans/boxModelingTools.md).
 *
 * A thin ToolMode sibling of SculptCorePaintMode: it owns the box-modeling UI
 * (Blender-style vertex/edge/face selection-mode chips, an xray toggle, and the
 * selection-overlay toggle) and dispatches the selection tools. All geometry,
 * selection state and overlay batches live in C++ (sculptcore); this mode only
 * holds the small amount of view/tool state the C++ side and the LiteMesh draw
 * path read (`boxModelSelMode`, `drawSelectionOverlay`, `xray`, `selectRadius`).
 */
import {
  Container,
  DataAPI,
  DataStruct,
  HotKey,
  IconCheck,
  KeyMap,
  Menu,
  createMenu,
  startMenu,
  nstructjs,
} from '../../../../scripts/path.ux/pathux'
import {ToolMode, type IToolModeDefine} from '../../../../scripts/editors/view3d/view3d_toolmode'
import {Icons} from '../../../../scripts/editors/icon_enum.js'
import {SelMask, normalizeSelMask, selMaskToNames} from '../../../../scripts/core/select_types.js'
import type {ViewContext} from '../../../../scripts/core/context'
import type {StructReader} from '../../../../scripts/path.ux/scripts/util/nstructjs'
import {SelectLoopLiteMeshOp, SelectNearestLiteMeshOp, localRay} from './litemesh_modeling_ops'
import {LiteMesh} from './litemesh'

export class BoxModelToolMode extends ToolMode {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
BoxModelToolMode {
    boxModelSelMode      : string | obj.boxModelSelModeName;
    drawSelectionOverlay : bool;
    drawWireframe        : bool;
    drawPoints           : bool;
    xray                 : bool;
    selectRadius         : float;
}
    `
  )

  /** Active element-selection domains (SelMask.VERTEX|EDGE|FACE bitmask). The
   * selection ops read this to decide which `select` layers to write. */
  boxModelSelMode = SelMask.VERTEX

  /** Write-side of the frozen name form of `boxModelSelMode`; see `core/select_types.ts`. */
  get boxModelSelModeName(): string {
    return selMaskToNames(this.boxModelSelMode)
  }

  /** Draw the selection overlay (selected verts/edges/faces + active). */
  drawSelectionOverlay = true
  /** Draw the full wireframe overlay (every edge, dim). */
  drawWireframe = true
  /** Draw every vertex as a billboard point sprite. */
  drawPoints = true
  /** When set, the box-modeling overlays ignore depth (see-through). */
  xray = false
  /** Circle/brush-select radius (screen px). */
  selectRadius = 25

  /* Double-click detection for loop select (pointerdown `detail` is 0 in
   * Chromium, so track it ourselves). */
  private _lastClickTime = 0
  private _lastClickX = 0
  private _lastClickY = 0

  /* Last cursor screen position, so the shift-G popup opens under the mouse
   * (a keymap callback gets only ctx, no event). */
  private _lastScreenX = 0
  private _lastScreenY = 0

  static toolModeDefine(): IToolModeDefine {
    return {
      name        : 'boxmodel',
      uiname      : 'Box Model',
      icon        : Icons.BOX_MODEL,
      flag        : 0,
      description : 'Traditional box modeling (select / extrude / inset / loop cut)',
      selectMode  : SelMask.OBJECT,
      transWidgets: [],
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = super.defineAPI(api, struct)

    st.flags('boxModelSelMode', 'boxModelSelMode', {
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
   * Vertex / edge / face chips, Blender-style: a plain click switches to exactly
   * that domain, shift-click toggles it into/out of the set. The default flag-prop
   * expansion toggles each bit independently, which lets a plain click clear the
   * last domain and leave nothing selectable — hence the hand-built chips.
   */
  static buildSelModeChips(strip: Container<ViewContext>, name: string): void {
    const path = `scene.tools.${name}.boxModelSelMode`
    const uinames = {VERTEX: 'Vertex', EDGE: 'Edge', FACE: 'Face'}

    for (const key of ['VERTEX', 'EDGE', 'FACE'] as const) {
      const bit: number = SelMask[key]
      // `useIcons(true)` on the strip makes every check an IconCheck.
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

  /** Material tab: put the selected faces on the chooser's active slot. */
  static buildMaterialPanel(container: Container<ViewContext>, slot: number): void {
    container.tool(`litemesh.assign_material(slot=${slot})`)
  }

  /**
   * The shift-G "Select Similar" popup: a submenu of criteria per enabled
   * selection domain (each entry runs litemesh.select_similar, which is seeded
   * from the active element of that domain). Returns undefined when nothing is
   * selectable. One domain active → its criteria directly; several → a menu of
   * per-domain submenus.
   */
  static buildSelectSimilarMenu(ctx: ViewContext, mode: number): Menu | undefined {
    // createMenu's CTX constraint doesn't accept ViewContext (invariant `api`),
    // so cast across the path.ux boundary in one place.
    const mk = (title: string, templ: unknown[]): Menu =>
      createMenu(ctx as never, title, templ as never) as unknown as Menu
    const item = (label: string, type: string): [string, () => void] => [
      label,
      (): void => {
        ctx.api.execTool(ctx, `litemesh.select_similar(type=${type})`)
      },
    ]

    const sections: Menu[] = []
    if (mode & SelMask.FACE) {
      sections.push(
        mk('Faces', [
          item('Material', 'FACE_MATERIAL'),
          item('Poly Group', 'FACE_GROUP'),
          item('Area', 'FACE_AREA'),
          item('Normal', 'FACE_NORMAL'),
          item('Coplanar', 'FACE_COPLANAR'),
          item('Sides', 'FACE_SIDES'),
        ])
      )
    }
    if (mode & SelMask.EDGE) {
      sections.push(
        mk('Edges', [
          item('Length', 'EDGE_LENGTH'),
          item('Direction', 'EDGE_DIRECTION'),
          item('Face Count', 'EDGE_FACES'),
          item('Face Angle', 'EDGE_DIHEDRAL'),
        ])
      )
    }
    if (mode & SelMask.VERTEX) {
      sections.push(
        mk('Vertices', [
          item('Normal', 'VERT_NORMAL'),
          item('Edge Count', 'VERT_EDGES'),
          item('Face Count', 'VERT_FACES'),
        ])
      )
    }

    if (sections.length === 0) {
      return undefined
    }
    if (sections.length === 1) {
      return sections[0]
    }
    return mk('Select Similar', sections)
  }

  /** shift-G handler: pop the Select Similar menu under the cursor. */
  private _popupSelectSimilar(ctx: ViewContext): void {
    const menu = BoxModelToolMode.buildSelectSimilarMenu(ctx, this.boxModelSelMode)
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

    let row = addHeaderRow()
    strip = row.strip()
    strip.useIcons(true)
    strip.tool('litemesh.select_all(mode=AUTO)')
    strip.tool('litemesh.select_box()')
    strip.tool('litemesh.select_circle()')
    strip.tool('litemesh.select_path()')

    // Modeling tools (the "T" tools auto-chain a transform via transform=true).
    row = addHeaderRow()
    strip = row.strip()
    strip.useIcons(true)
    strip.tool('litemesh.extrude_region(transform=true)')
    strip.tool('litemesh.extrude_individual(transform=true)')
    strip.tool('litemesh.extrude_wire(transform=true)')
    strip.tool('litemesh.split_off(transform=true)')
    strip.tool('litemesh.inset_region()')
    strip.tool('litemesh.bevel_verts()')
    strip.tool('litemesh.subdivide()')
    strip.tool('litemesh.loop_cut()')

    header.flushUpdate()
  }

  /** Left-click selection, Blender-style: plain click replace-selects the
   * nearest element in the first enabled selection domain; shift-click toggles
   * it. Double-click loop-selects (edge loop / face loop; shift-double-click =
   * the edge ring, "face loop edge select"), toggling off a fully-selected
   * loop. Ctrl-click is NOT consumed — it is the global 3D-cursor shortcut. */
  on_mousedown(e: PointerEvent, x: number, y: number): boolean | void {
    if (e.button !== 0 || e.altKey || e.ctrlKey || this.hasWidgetHighlight()) {
      return false
    }
    const ctx = this.ctx
    if (!ctx?.view3d || !ctx.object) {
      return false
    }

    const now = performance.now()
    const dx = x - this._lastClickX
    const dy = y - this._lastClickY
    const isDouble = now - this._lastClickTime < 400 && dx * dx + dy * dy < 8 * 8
    this._lastClickTime = isDouble ? 0 : now // a triple-click starts a new cycle
    this._lastClickX = x
    this._lastClickY = y

    if (isDouble) {
      const op = new SelectLoopLiteMeshOp()
      op.inputs.x.setValue(x)
      op.inputs.y.setValue(y)
      op.inputs.ring.setValue(e.shiftKey)
      ctx.toolstack.execTool(ctx, op)
      return true
    }
    const op = new SelectNearestLiteMeshOp()
    op.is_modal = false // click position is already known; skip the modal wait
    op.inputs.useXY.setValue(true)
    op.inputs.x.setValue(x)
    op.inputs.y.setValue(y)
    // Blender semantics: plain click replaces the selection, shift toggles.
    op.inputs.toggle.setValue(e.shiftKey)
    ctx.toolstack.execTool(ctx, op)
    return true
  }

  onInactive(): void {
    // Drop any hover highlight when leaving the mode.
    const mesh = this.ctx?.object?.data
    if (mesh instanceof LiteMesh) {
      mesh.setHover(-1, -1, -1)
    }
    super.onInactive()
  }

  /** Hover highlight: pick the nearest element in the first enabled selection
   * domain under the cursor and hand it to the LiteMesh selection overlay
   * (cyan; setHover no-ops when unchanged). */
  on_mousemove(e: PointerEvent, x: number, y: number): boolean | void {
    this._lastScreenX = e.x
    this._lastScreenY = e.y
    if (e.buttons !== 0) {
      return // dragging — modal ops own the pointer
    }
    const ctx = this.ctx
    const view3d = ctx?.view3d
    const object = ctx?.object
    const mesh = object?.data
    if (!view3d || !object || !(mesh instanceof LiteMesh)) {
      return
    }
    const mode = this.boxModelSelMode
    let v = -1
    let ed = -1
    let f = -1
    if (mode & SelMask.EDGE && !(mode & SelMask.VERTEX)) {
      // Screen-space edge pick (3D nearest mis-picks on foreshortened faces).
      ed = mesh.pickEdge(view3d, object, x, y)
    } else if (mode & SelMask.VERTEX) {
      // Screen-space vert pick (barycentric pickVert mis-picks on coarse meshes).
      v = mesh.pickVertScreen(view3d, object, x, y)
    } else if (mode & SelMask.FACE) {
      const obmatrix = object.outputs.matrix.getValue()
      const {origin, dir} = localRay(view3d as unknown as Parameters<typeof localRay>[0], obmatrix, x, y)
      f = mesh.pickFace(origin, dir)
    }
    mesh.setHover(v, ed, f)
  }

  defineKeyMap(): void {
    this.keymap = new KeyMap([
      new HotKey('A', [], 'litemesh.select_all(mode=AUTO)'),
      new HotKey('A', ['alt'], 'litemesh.select_all(mode=NONE)'),
      new HotKey('B', [], 'litemesh.select_box()'),
      new HotKey('C', [], 'litemesh.select_circle()'),
      // Transform the current selection via the shared transform modal — the
      // LiteMeshTransType bridge (litemesh_transtype.ts) supplies the movable
      // verts, so constraints / numeric entry / snapping all come for free.
      new HotKey('G', [], 'view3d.translate()'),
      new HotKey('G', ['shift'], (ctx) => this._popupSelectSimilar(ctx as ViewContext)),
      new HotKey('R', [], 'view3d.rotate()'),
      new HotKey('S', [], 'view3d.scale()'),
      new HotKey('E', [], 'litemesh.extrude_region(transform=true)'),
      new HotKey('I', [], 'litemesh.inset_region()'),
      new HotKey('V', [], 'litemesh.bevel_verts()'),
      new HotKey('D', [], 'litemesh.subdivide()'),
      new HotKey('R', ['ctrl'], 'litemesh.loop_cut()'),
    ])
  }

  loadSTRUCT(reader: StructReader<this>): void {
    super.loadSTRUCT(reader)

    //files written before APP_VERSION 8 store this as a raw int
    this.boxModelSelMode = normalizeSelMask(this.boxModelSelMode, SelMask.VERTEX)
  }
}

