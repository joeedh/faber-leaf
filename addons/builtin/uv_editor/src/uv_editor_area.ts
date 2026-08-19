/**
 * The UV editor's area — P18 §5 step 3.
 *
 * Kept out of `index.ts` on purpose: this file imports host values, so it
 * cannot run under plain jest, while everything it draws and picks with can.
 * The geometry lives in `uv_edit_geom.ts` and is tested against the in-memory
 * double; what is here is the shell — a canvas, pan/zoom, and a data path.
 *
 * It reaches geometry only through `uvSourceFor`, so it edits any data kind
 * that registered an `IUVSource` while naming none of them.
 *
 * Canvas 2D rather than the renderer: this addon ships in the distribution
 * with no geometry engine, and a device-free painter is one less thing that
 * can be missing there.
 */

import {
  Editor,
  Icons,
  ImageBlock,
  ImageBus,
  ImageUser,
  SelOneToolModes,
  VelPan,
  VelPanPanOp,
  bus,
  uvSourceFor,
} from '@framework/api'
import type {
  BlockLoader,
  BlockLoaderAddUser,
  BusTriggers,
  DataBlock,
  IUVSource,
  StructReader,
  ViewContext,
} from '@framework/api'
import {HotKey, KeyMap, Menu, UIBase, Vector2, eventWasTouch, haveModal, nstructjs} from '@framework/pathux'
import type {DataAPI, DataStruct, IAreaDef, UIBase as UIBaseType} from '@framework/pathux'

import {UV_PIN, UV_SELECT, UV_SNAP_LIMIT, buildUVDrawGeometry, pickNearestUV} from './uv_edit_geom.js'
import type {UVDrawGeometry, UVScope} from './uv_edit_geom.js'
import {SelectOneUVOp} from './uv_ops.js'

const BACKGROUND = 'rgb(45,45,45)'
const CHECKER_DARK = 'rgb(90,90,90)'
const CHECKER_LIGHT = 'rgb(130,130,130)'
const EDGE_COLOR = 'rgba(215,215,215,0.55)'
const POINT_COLOR = 'rgb(175,175,175)'
const POINT_SELECTED = 'rgb(255,180,40)'
const POINT_PINNED = 'rgb(240,70,70)'
const HIGHLIGHT_COLOR = 'rgb(255,255,255)'

/** Cells across the unit square, so the checker zooms with the layout. */
const CHECKER_CELLS = 8

/** Half-width of a drawn UV point, and the pick radius, both in CSS pixels. */
const POINT_SIZE = 2.5
const PICK_RADIUS = 12

/** Fraction of the smaller canvas axis the unit square covers at zoom 1. */
const UNIT_SQUARE_FIT = 0.9

const _tmp1 = new Vector2()
const _tmp2 = new Vector2()
const _tmp3 = new Vector2()
const _tmp4 = new Vector2()
const _tmp5 = new Vector2()

/**
 * A UV layout editor for whatever the active object's data resolves to.
 *
 * Screen math is in CSS pixels throughout — the backing store is scaled by DPI
 * once, at the top of `draw` — because `VelPanPanOp` works in CSS pixels too,
 * and a pan that tracked the cursor at one DPI but not another is the bug that
 * convention avoids.
 */
export class UVEditor extends Editor {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
uveditor.UVEditor {
  imageUser         : ImageUser;
  velpan            : VelPan;
  selectedFacesOnly : bool;
  uvLayer           : int;
}`
  )

  imageUser: ImageUser
  velpan: VelPan

  /** Restricts every read to the source's selected faces. */
  selectedFacesOnly = false

  /** Layer to edit, or -1 to follow the source's active one. */
  uvLayer = -1

  canvas: HTMLCanvasElement
  g: CanvasRenderingContext2D

  /** Element under the cursor, or -1. Handles die with `topoStamp`. */
  highlight = -1

  _geom: UVDrawGeometry | undefined = undefined
  _geomSource: IUVSource | undefined = undefined
  _geomKey = ''
  _lastKey = ''

  constructor() {
    super()

    this.imageUser = new ImageUser()

    this.velpan = new VelPan()
    this.velpan.onchange = this.onVelPanChange.bind(this)

    this.canvas = document.createElement('canvas')
    this.g = this.canvas.getContext('2d')!

    this.container.noMarginsOrPadding()
    this.shadow.appendChild(this.canvas)
  }

  static define(): IAreaDef {
    return {
      areaname: 'UVEditor',
      tagname : 'uv-editor-x',
      uiname  : 'UV Editor',
      apiname : 'uvEditor',
      // TODO: the icon sheet has no UV cell yet; sharing the image editor's.
      icon    : Icons.IMAGE_EDITOR,
    }
  }

  static defineAPI(api: DataAPI): DataStruct {
    const st = super.defineAPI(api)

    st.struct('imageUser', 'imageUser', 'Image', api.mapStruct(ImageUser))
    st.struct('velpan', 'velpan', 'Pan / Zoom', api.mapStruct(VelPan))
    st.bool('selectedFacesOnly', 'selectedFacesOnly', 'Selected Faces Only', 'Only show UVs of selected faces')
    st.int('uvLayer', 'uvLayer', 'UV Layer', 'Layer to edit; -1 follows the active one')

    return st
  }

  init(): void {
    super.init()

    const header = this.header!
    const row = header.row().strip()

    row.menu('Image', [
      'image.open()|Open',
      Menu.SEP,
      'datalib.default_new(blockType="image" dataPathToSet="uvEditor.imageUser.image")|New',
    ])

    row.iconbutton(Icons.HOME, 'Reset Pan/Zoom', () => {
      this.velpan.reset()
      this.flagRedraw()
    })

    const browser = document.createElement('data-block-browser-x') as unknown as UIBaseType<ViewContext> & {
      blockClass: typeof ImageBlock
    }
    browser.setAttribute('datapath', 'uvEditor.imageUser.image')
    browser.blockClass = ImageBlock
    row.add(browser)

    row.prop('uvEditor.selectedFacesOnly')

    this.addEventListener('pointerdown', this.onPointerDown.bind(this))
    this.addEventListener('pointermove', this.onPointerMove.bind(this))
    // XXX pathux's WheelEvent typing isn't inferred for this overload
    this.addEventListener('mousewheel', this.onMouseWheel.bind(this) as EventListenerOrEventListenerObject)
  }

  /** The archived editor's hotkeys, unchanged — users have muscle memory. */
  defineKeyMap() {
    this.keymap = new KeyMap([
      new HotKey('A', [], "uveditor.toggle_select_all(mode='AUTO')"),
      new HotKey('L', [], "uveditor.pick_select_linked(mode='ADD' immediateMode=true)"),
      new HotKey('L', ['shift'], "uveditor.pick_select_linked(mode='SUB' immediateMode=true)"),
      new HotKey('G', [], 'uveditor.translate()'),
      new HotKey('S', [], 'uveditor.scale()'),
      new HotKey('R', [], 'uveditor.rotate()'),
      new HotKey('P', [], "uveditor.set_flag(flag='PIN')"),
      new HotKey('P', ['alt'], "uveditor.clear_flag(flag='PIN')"),
    ])

    return this.keymap
  }

  copy(): this {
    const ret = document.createElement('uv-editor-x') as unknown as this

    ret.velpan.load(this.velpan)
    ret.imageUser.load(this.imageUser)
    ret.selectedFacesOnly = this.selectedFacesOnly
    ret.uvLayer = this.uvLayer
    ret.ctx = this.ctx

    return ret
  }

  // -------------------------------------------------------------------------
  // Source
  // -------------------------------------------------------------------------

  /** The active object's UV source, or undefined if its kind has none. */
  getSource(): IUVSource | undefined {
    return this.ctx ? uvSourceFor(this.ctx.object?.data) : undefined
  }

  /** The layer being edited, or -1 when the source has none. */
  getLayer(source: IUVSource): number {
    return this.uvLayer >= 0 && this.uvLayer < source.listUVLayers().length ? this.uvLayer : source.activeUVLayer
  }

  getScope(): UVScope {
    return {selectedFacesOnly: this.selectedFacesOnly}
  }

  // -------------------------------------------------------------------------
  // Transform
  // -------------------------------------------------------------------------

  /** CSS-pixel size of the drawing area, header excluded. */
  getViewSize(out: Vector2): Vector2 {
    const size = this.size!
    const headerHeight = this.header ? this.header.getBoundingClientRect().height : 0

    out[0] = Math.max(size[0], 1)
    out[1] = Math.max(size[1] - headerHeight, 1)

    return out
  }

  /** Side of the unit square in graph units, before pan and zoom. */
  getUnitSize(): number {
    const view = this.getViewSize(_tmp3)
    return Math.min(view[0], view[1]) * UNIT_SQUARE_FIT
  }

  /** Widens u so a non-square image is drawn at its own aspect. */
  getImageAspect(): number {
    const image = this.imageUser.image
    return image?.ready && image.height > 0 ? image.width / image.height : 1.0
  }

  projectUV(u: number, v: number, out: Vector2): Vector2 {
    const view = this.getViewSize(_tmp4)
    const size = this.getUnitSize()
    const zoom = this.velpan.scale[0]
    const pan = this.velpan.pos

    out[0] = ((u - 0.5) * size * this.getImageAspect() + pan[0]) * zoom + view[0] * 0.5
    out[1] = ((0.5 - v) * size + pan[1]) * zoom + view[1] * 0.5

    return out
  }

  unprojectUV(x: number, y: number, out: Vector2): Vector2 {
    const view = this.getViewSize(_tmp4)
    const size = this.getUnitSize()
    const zoom = this.velpan.scale[0]
    const pan = this.velpan.pos

    out[0] = ((x - view[0] * 0.5) / zoom - pan[0]) / (size * this.getImageAspect()) + 0.5
    out[1] = 0.5 - ((y - view[1] * 0.5) / zoom - pan[1]) / size

    return out
  }

  /** Cursor position in CSS pixels relative to the canvas. */
  getLocalMouse(e: {clientX: number; clientY: number}, out: Vector2): Vector2 {
    const rect = this.canvas.getBoundingClientRect()

    out[0] = e.clientX - rect.left
    out[1] = e.clientY - rect.top

    return out
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  onVelPanChange(): void {
    this.flagRedraw()
  }

  onMouseWheel(e: WheelEvent): void {
    const local = this.getLocalMouse(e, _tmp1)
    const view = this.getViewSize(_tmp2)
    const zoom = this.velpan.scale[0]

    // zoomAround wants graph space: screen, un-centred and un-zoomed.
    _tmp5[0] = (local[0] - view[0] * 0.5) / zoom - this.velpan.pos[0]
    _tmp5[1] = (local[1] - view[1] * 0.5) / zoom - this.velpan.pos[1]

    this.velpan.zoomAround(_tmp5, 1.0 - e.deltaY * 0.001)

    e.preventDefault()
    e.stopPropagation()
  }

  onPointerDown(e: PointerEvent): void {
    if (haveModal() || !this.ctx) {
      return
    }

    const wasTouch = eventWasTouch(e)
    let pan = wasTouch && e.altKey
    pan = pan || (e.button !== 0 && !wasTouch)
    pan = pan || (e.button === 0 && e.altKey)

    if (pan) {
      const op = new VelPanPanOp()
      op.inputs.velpanPath.setValue('uvEditor.velpan')
      this.ctx.api.execTool(this.ctx, op)
    } else if (e.button === 0 || wasTouch) {
      this.doSelect(e)
    }
  }

  /**
   * Click-select, as the archived editor did it.
   *
   * The whole coincident stack under the cursor goes in together, so a corner
   * shared by several faces selects as one point rather than whichever ring
   * happened to be read first.
   */
  doSelect(e: PointerEvent): void {
    const source = this.getSource()
    const layer = source ? this.getLayer(source) : -1

    if (!source || layer < 0 || !this.ctx) {
      return
    }

    const local = this.getLocalMouse(e, _tmp1)
    const uv = this.unprojectUV(local[0], local[1], _tmp2)

    const limit = PICK_RADIUS / Math.max(this.velpan.scale[0] * this.getUnitSize(), 1e-6)
    const hits = pickNearestUV(source, layer, uv[0], uv[1], {...this.getScope(), limit})

    if (hits.length === 0) {
      return
    }

    const elements: number[] = []
    for (const hit of hits) {
      const du = hit.u - hits[0].u
      const dv = hit.v - hits[0].v

      if (Math.sqrt(du * du + dv * dv) >= UV_SNAP_LIMIT) {
        break
      }

      elements.push(hit.handle)
    }

    let mode = SelOneToolModes.UNIQUE
    if (e.shiftKey) {
      mode = hits[0].selected ? SelOneToolModes.SUB : SelOneToolModes.ADD
    }

    const op = new SelectOneUVOp()
    op.inputs.elements.setValue(elements)
    op.inputs.mode.setValue(mode)

    this.ctx.api.execTool(this.ctx, op)
  }

  onPointerMove(e: PointerEvent): void {
    if (haveModal() || !this.ctx) {
      return
    }

    const source = this.getSource()
    const layer = source ? this.getLayer(source) : -1

    if (!source || layer < 0) {
      return
    }

    const local = this.getLocalMouse(e, _tmp1)
    const uv = this.unprojectUV(local[0], local[1], _tmp2)

    const limit = PICK_RADIUS / Math.max(this.velpan.scale[0] * this.getUnitSize(), 1e-6)
    const hits = pickNearestUV(source, layer, uv[0], uv[1], {...this.getScope(), limit})
    const handle = hits.length > 0 ? hits[0].handle : -1

    if (handle !== this.highlight) {
      this.highlight = handle
      this.flagRedraw()
    }
  }

  // -------------------------------------------------------------------------
  // Draw
  // -------------------------------------------------------------------------

  flagRedraw(): void {
    this.doOnce(this.draw)
  }

  /**
   * `ImageBus` reaches whichever editors are on screen: an area registers as an
   * emitter while it is the visible one, so a trigger fans out to exactly the
   * editors a user can see, without anyone holding a list of them.
   */
  onTrigger(type: BusTriggers<typeof ImageBus>): void {
    // A screen torn down whole (a file load) never fires on_area_inactive, so
    // an emitter that outlived its DOM deregisters itself on first contact.
    if (this.isDead()) {
      bus.removeEmitter(this, ImageBus)
      return
    }

    if (type === 'flagRedraw') {
      this.flagRedraw()
    }
  }

  on_area_active(): void {
    super.on_area_active()
    bus.addEmitter(this, ImageBus)
  }

  on_area_inactive(): void {
    super.on_area_inactive()

    if (bus.hasEmitter(this, ImageBus)) {
      bus.removeEmitter(this, ImageBus)
    }
  }

  /** Drops the cached rings. Selection and position changes don't need it. */
  flagGeometryDirty(): void {
    this._geom = undefined
    this.flagRedraw()
  }

  on_resize(): void {
    this.flagRedraw()
  }

  update(): void {
    if (!this.ctx) {
      return
    }

    super.update()

    const image = this.imageUser.image
    if (image) {
      image.update()
    }

    const source = this.getSource()
    const layer = source ? this.getLayer(source) : -1
    const view = this.getViewSize(_tmp1)

    const key = [
      layer,
      source ? source.topoStamp : -1,
      this.imageUser.calcUpdateKey(),
      this.selectedFacesOnly,
      ~~view[0],
      ~~view[1],
    ].join(':')

    if (key !== this._lastKey) {
      this._lastKey = key
      this.flagRedraw()
    }

    this.velpan.update(true, false)
  }

  updateCanvasSize(): void {
    const view = this.getViewSize(_tmp1)
    const dpi = UIBase.getDPI()
    const canvas = this.canvas

    const w = ~~(view[0] * dpi)
    const h = ~~(view[1] * dpi)

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }

    canvas.style['width'] = view[0] + 'px'
    canvas.style['height'] = view[1] + 'px'
  }

  /**
   * Ring geometry, rebuilt only when the topology, layer or scope changes.
   * Positions and flags are re-read every draw instead, so a move or a
   * selection shows immediately without walking the rings again.
   */
  getDrawGeometry(source: IUVSource, layer: number): UVDrawGeometry {
    const key = layer + ':' + source.topoStamp + ':' + this.selectedFacesOnly

    if (!this._geom || this._geomSource !== source || this._geomKey !== key) {
      this._geom = buildUVDrawGeometry(source, layer, this.getScope())
      this._geomSource = source
      this._geomKey = key
    } else {
      source.getUVs(layer, this._geom.handles, this._geom.points)
      source.getUVFlags(layer, this._geom.handles, this._geom.flags)
    }

    return this._geom
  }

  draw(): void {
    this.updateCanvasSize()

    const g = this.g
    const view = this.getViewSize(_tmp1)
    const dpi = UIBase.getDPI()

    g.setTransform(dpi, 0, 0, dpi, 0, 0)

    g.fillStyle = BACKGROUND
    g.fillRect(0, 0, view[0], view[1])

    this.drawBackdrop(g)

    const source = this.getSource()
    const layer = source ? this.getLayer(source) : -1

    if (!source || layer < 0) {
      return
    }

    const geom = this.getDrawGeometry(source, layer)

    this.drawEdges(g, geom)
    this.drawPoints(g, geom)
  }

  /** The checkerboard, and the image over it when one is loaded and ready. */
  drawBackdrop(g: CanvasRenderingContext2D): void {
    const tl = this.projectUV(0, 1, _tmp1)
    const br = this.projectUV(1, 0, _tmp2)

    g.fillStyle = CHECKER_DARK
    g.fillRect(tl[0], tl[1], br[0] - tl[0], br[1] - tl[1])

    g.fillStyle = CHECKER_LIGHT
    for (let y = 0; y < CHECKER_CELLS; y++) {
      for (let x = 0; x < CHECKER_CELLS; x++) {
        if (((x + y) & 1) === 0) {
          continue
        }

        const a = this.projectUV(x / CHECKER_CELLS, (y + 1) / CHECKER_CELLS, _tmp3)
        const b = this.projectUV((x + 1) / CHECKER_CELLS, y / CHECKER_CELLS, _tmp4)

        g.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1])
      }
    }

    const image = this.imageUser.image
    if (image?.ready && image._image) {
      const a = this.projectUV(0, 1, _tmp3)
      const b = this.projectUV(1, 0, _tmp4)

      g.drawImage(image._image, a[0], a[1], b[0] - a[0], b[1] - a[1])
    }
  }

  drawEdges(g: CanvasRenderingContext2D, geom: UVDrawGeometry): void {
    const edges = geom.edges
    const p = _tmp1

    g.beginPath()
    g.strokeStyle = EDGE_COLOR
    g.lineWidth = 1

    for (let i = 0; i < edges.length; i += 4) {
      this.projectUV(edges[i], edges[i + 1], p)
      g.moveTo(p[0], p[1])

      this.projectUV(edges[i + 2], edges[i + 3], p)
      g.lineTo(p[0], p[1])
    }

    g.stroke()
  }

  drawPoints(g: CanvasRenderingContext2D, geom: UVDrawGeometry): void {
    const {points, flags, handles} = geom
    const p = _tmp1
    const size = POINT_SIZE * 2

    // One path per colour: a fill per point would be three state changes each.
    const passes: [string, (flag: number) => boolean][] = [
      [POINT_COLOR, (flag) => (flag & (UV_SELECT | UV_PIN)) === 0],
      [POINT_SELECTED, (flag) => (flag & UV_SELECT) !== 0 && (flag & UV_PIN) === 0],
      [POINT_PINNED, (flag) => (flag & UV_PIN) !== 0],
    ]

    for (const [color, wanted] of passes) {
      g.beginPath()
      g.fillStyle = color

      for (let i = 0; i < handles.length; i++) {
        if (!wanted(flags[i])) {
          continue
        }

        this.projectUV(points[i * 2], points[i * 2 + 1], p)
        g.rect(p[0] - POINT_SIZE, p[1] - POINT_SIZE, size, size)
      }

      g.fill()
    }

    if (this.highlight < 0) {
      return
    }

    for (let i = 0; i < handles.length; i++) {
      if (handles[i] !== this.highlight) {
        continue
      }

      this.projectUV(points[i * 2], points[i * 2 + 1], p)

      g.beginPath()
      g.strokeStyle = HIGHLIGHT_COLOR
      g.lineWidth = 1.5
      g.rect(p[0] - POINT_SIZE * 2, p[1] - POINT_SIZE * 2, size * 2, size * 2)
      g.stroke()
      break
    }
  }

  dataLink(owner: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser): void {
    super.dataLink(owner, getblock, getblock_addUser)
    this.imageUser.dataLink(owner, getblock, getblock_addUser)
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)

    this.velpan.onchange = this.onVelPanChange.bind(this)
  }
}
