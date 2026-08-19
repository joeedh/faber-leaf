/**
 * The `uveditor.*` ToolOps — P18 §5 step 4.
 *
 * Same tool paths, same hotkeys, same input semantics as the editor that was
 * archived, because users have keymaps and `saveLastValue()` state keyed on
 * them; only the data underneath changed. Where an input named a BREP concept
 * (`meshPath`, `loopEid`) it is renamed, since nothing persists those.
 *
 * Every op is a shell around `uv_edit_geom.ts`, which is where the rules are
 * and where they are tested. What lives here is the three things a ToolOp adds:
 * inputs that make a run replayable, an undo step proportional to the edit, and
 * the modal loop for the interactive ones.
 *
 * Undo is a snapshot, not a memfile: flags for the selection ops, and the
 * coordinates of exactly the handles a transform moved. Both refuse to restore
 * across a `topoStamp` change, which is the only way a handle can go stale.
 */

import {SelOneToolModes, SelToolModes, uvSourceFor} from '@framework/api'
import type {GeometryDataRef, IUVSource, ToolContext, ViewContext} from '@framework/api'
import {
  BoolProperty,
  EnumProperty,
  FlagProperty,
  FloatProperty,
  IntProperty,
  ListProperty,
  Mat4Property,
  Matrix4,
  StringProperty,
  ToolOp,
  Vec2Property,
  Vector2,
  Vector3,
} from '@framework/pathux'
import type {PropertySlots, ToolDef} from '@framework/pathux'

import {
  UV_PIN,
  UV_SELECT,
  applyUVFlag,
  applyUVRotate,
  applyUVScale,
  applyUVTranslate,
  gatherUVTransData,
  listSelectedUVs,
  restoreUVCoords,
  restoreUVFlags,
  ringElements,
  readUVRings,
  selectAllUVs,
  selectLinkedUV,
  selectOneUV,
  snapshotUVCoords,
  snapshotUVFlags,
} from './uv_edit_geom.js'
import type {UVCoordSnapshot, UVFlagSnapshot, UVScope, UVTransData} from './uv_edit_geom.js'

/** The contract's `UVFlags`, restated for `FlagProperty` — see uv_edit_geom.ts. */
export const UVFlagEnum = {
  SELECT: UV_SELECT,
  PIN   : UV_PIN,
}

/**
 * The editor surface the modal ops drive, structurally so that neither file
 * imports the other — the ops stay loadable in a build with no area registered.
 */
export interface IUVEditorView {
  getSource(): IUVSource | undefined
  getLayer(source: IUVSource): number
  getScope(): UVScope
  getLocalMouse(e: {clientX: number; clientY: number}, out: Vector2): Vector2
  unprojectUV(x: number, y: number, out: Vector2): Vector2
  flagRedraw(): void
  highlight: number
}

interface UVEditorCtx {
  editors?: {uvEditor?: IUVEditorView}
}

const _tmp1 = new Vector2()
const _tmp2 = new Vector2()
const _tmp3 = new Vector2()
const _tmp4 = new Vector2()

/** What every UV op needs to find its data. */
type UVOpInputs = {
  dataPath: StringProperty
  layer: IntProperty
  selectedFacesOnly: BoolProperty
}

/**
 * `dataPath` empty means the active object, which is what a keymap invocation
 * wants; a caller with a specific source passes a data-API path instead. The
 * scope is an input rather than a live read of the editor toggle so that redo
 * replays what actually ran — `invoke` copies the toggle in once.
 */
export abstract class UVOpBase<Inputs extends PropertySlots = {}, Outputs extends PropertySlots = {}> extends ToolOp<
  Inputs & UVOpInputs,
  Outputs,
  ToolContext,
  ViewContext
> {
  static tooldef(): ToolDef {
    return {
      inputs: ToolOp.inherit({
        dataPath         : new StringProperty(''),
        layer            : new IntProperty(-1),
        selectedFacesOnly: new BoolProperty(false),
      }),
    }
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>): UVOpBase {
    const tool = super.invoke(ctx, args) as UVOpBase
    const editor = (ctx as unknown as UVEditorCtx).editors?.uvEditor

    if (editor && !('selectedFacesOnly' in args)) {
      tool.inputs.selectedFacesOnly.setValue(editor.getScope().selectedFacesOnly ?? false)
    }

    return tool
  }

  _editor(ctx: ToolContext | undefined): IUVEditorView | undefined {
    return (ctx as unknown as UVEditorCtx | undefined)?.editors?.uvEditor
  }

  _source(ctx: ToolContext): IUVSource | undefined {
    const path = this.inputs.dataPath.getValue()
    const data = path === '' ? ctx.object?.data : (ctx.api.getValue(ctx, path) as GeometryDataRef | undefined)

    return uvSourceFor(data as GeometryDataRef | undefined)
  }

  /** The pinned layer when it is still in range, else the source's active one. */
  _layer(source: IUVSource): number {
    const layer = this.inputs.layer.getValue()
    return layer >= 0 && layer < source.listUVLayers().length ? layer : source.activeUVLayer
  }

  _scope(): UVScope {
    return {selectedFacesOnly: this.inputs.selectedFacesOnly.getValue()}
  }

  _redraw(ctx: ToolContext | undefined): void {
    this._editor(ctx)?.flagRedraw()
  }

  execPost(ctx: ToolContext): void {
    this._redraw(ctx)
  }
}

// ---------------------------------------------------------------------------
// Flags and selection
// ---------------------------------------------------------------------------

/**
 * Undo for anything that only writes flags. Scope-wide rather than
 * edit-wide because a selection op's own result is what it overwrote —
 * "select all" has no smaller answer than the layer.
 */
export abstract class UVFlagOpBase<
  Inputs extends PropertySlots = {},
  Outputs extends PropertySlots = {},
> extends UVOpBase<Inputs, Outputs> {
  _flagUndo?: UVFlagSnapshot

  undoPre(ctx: ToolContext): void {
    const source = this._source(ctx)
    this._flagUndo = source === undefined ? undefined : snapshotUVFlags(source, this._layer(source), this._scope())
  }

  undo(ctx: ToolContext): void {
    const source = this._source(ctx)

    if (source !== undefined && this._flagUndo !== undefined) {
      restoreUVFlags(source, this._layer(source), this._flagUndo)
      this._redraw(ctx)
    }
  }

  calcUndoMem(): number {
    const snap = this._flagUndo
    return snap === undefined ? 0 : snap.handles.length * 4 + snap.flags.length
  }
}

/** Select all, none, or the opposite of whatever is there. */
export class ToggleSelectAllUVsOp extends UVFlagOpBase<{mode: EnumProperty}> {
  static tooldef() {
    return {
      uiname  : 'Toggle Select All (UV)',
      toolpath: 'uveditor.toggle_select_all',
      inputs: ToolOp.inherit({
        mode: new EnumProperty(SelToolModes.AUTO, SelToolModes),
      }),
    }
  }

  exec(ctx: ToolContext): void {
    const source = this._source(ctx)
    if (source === undefined) {
      return
    }

    const layer = this._layer(source)
    if (layer < 0) {
      return
    }

    const mode = this.inputs.mode.getValue()
    selectAllUVs(
      source,
      layer,
      mode === SelToolModes.SUB ? 'sub' : mode === SelToolModes.ADD ? 'add' : 'auto',
      this._scope()
    )
  }
}

/** Select specific elements. The editor's click-select invokes this. */
export class SelectOneUVOp extends UVFlagOpBase<{elements: ListProperty<IntProperty>; mode: EnumProperty}> {
  static tooldef() {
    return {
      uiname  : 'Select UV',
      toolpath: 'uveditor.select_one',
      inputs: ToolOp.inherit({
        elements: new ListProperty(IntProperty),
        mode    : new EnumProperty(SelOneToolModes.UNIQUE, SelOneToolModes),
      }),
    }
  }

  exec(ctx: ToolContext): void {
    const source = this._source(ctx)
    if (source === undefined) {
      return
    }

    const layer = this._layer(source)
    if (layer < 0) {
      return
    }

    const mode = this.inputs.mode.getValue()
    const handles: number[] = []

    for (const handle of this.inputs.elements) {
      handles.push(handle as number)
    }

    selectOneUV(
      source,
      layer,
      Int32Array.from(handles),
      mode === SelOneToolModes.SUB ? 'sub' : mode === SelOneToolModes.ADD ? 'add' : 'unique',
      this._scope()
    )
  }
}

/**
 * Select the island under the cursor. Modal so that the L hotkey can pick
 * without a preceding click; `element` is what it picked, so redo needs no
 * pointer.
 */
export class SelectLinkedPickUVOp extends UVFlagOpBase<{
  element: IntProperty
  mode: EnumProperty
  immediateMode: BoolProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Select Linked (Pick)',
      toolpath: 'uveditor.pick_select_linked',
      is_modal: true,
      inputs: ToolOp.inherit({
        element      : new IntProperty(-1),
        mode         : new EnumProperty(SelToolModes.ADD, SelToolModes),
        immediateMode: new BoolProperty(false),
      }),
    }
  }

  modalStart(ctx: ViewContext) {
    const ret = super.modalStart(ctx)

    if (this.inputs.immediateMode.getValue()) {
      this._pickAndRun(this._editor(ctx)?.highlight ?? -1)
    }

    return ret
  }

  on_pointerup(e: PointerEvent): void {
    const ctx = this.modal_ctx
    const editor = this._editor(ctx)
    const source = editor?.getSource()

    if (!ctx || !editor || !source) {
      this.modalEnd(true)
      return
    }

    const local = editor.getLocalMouse(e, _tmp1)
    editor.unprojectUV(local[0], local[1], _tmp2)

    this._pickAndRun(editor.highlight)
  }

  on_keydown(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      this.modalEnd(true)
      return
    }
    super.on_keydown(e)
  }

  /** The editor already highlights what is under the cursor; reuse that pick. */
  _pickAndRun(element: number): void {
    const ctx = this.modal_ctx

    if (element < 0 || !ctx) {
      this.modalEnd(true)
      return
    }

    this.inputs.element.setValue(element)
    this.modalEnd(false)
    this.exec(ctx as unknown as ToolContext)
  }

  exec(ctx: ToolContext): void {
    const source = this._source(ctx)
    const element = this.inputs.element.getValue()

    if (source === undefined || element < 0) {
      return
    }

    const layer = this._layer(source)
    if (layer < 0) {
      return
    }

    selectLinkedUV(
      source,
      layer,
      element,
      this.inputs.mode.getValue() === SelToolModes.SUB ? 'sub' : 'add',
      this._scope()
    )
  }
}

/**
 * Set, clear or toggle a flag on the current UV selection — which is what
 * pinning is. Selection itself goes through the ops above, so `flag` defaulting
 * to `PIN` keeps a stray invocation from silently rewriting a selection.
 */
export abstract class UVFlagWriteOpBase extends UVFlagOpBase<{flag: FlagProperty}> {
  static tooldef(): ToolDef {
    return {
      inputs: ToolOp.inherit({
        flag: new FlagProperty(UV_PIN, UVFlagEnum),
      }),
    }
  }

  protected abstract action(): 'set' | 'clear' | 'toggle'

  exec(ctx: ToolContext): void {
    const source = this._source(ctx)
    if (source === undefined) {
      return
    }

    const layer = this._layer(source)
    if (layer < 0) {
      return
    }

    applyUVFlag(
      source,
      layer,
      listSelectedUVs(source, layer, this._scope()),
      this.inputs.flag.getValue(),
      this.action()
    )
  }
}

export class UVSetFlagOp extends UVFlagWriteOpBase {
  static tooldef() {
    return {
      uiname  : 'Set Flag (UV)',
      toolpath: 'uveditor.set_flag',
      inputs  : ToolOp.inherit({}),
    }
  }

  protected action(): 'set' {
    return 'set'
  }
}

export class UVClearFlagOp extends UVFlagWriteOpBase {
  static tooldef() {
    return {
      uiname  : 'Clear Flag (UV)',
      toolpath: 'uveditor.clear_flag',
      inputs  : ToolOp.inherit({}),
    }
  }

  protected action(): 'clear' {
    return 'clear'
  }
}

export class UVToggleFlagOp extends UVFlagWriteOpBase {
  static tooldef() {
    return {
      uiname  : 'Toggle Flag (UV)',
      toolpath: 'uveditor.toggle_flag',
      inputs  : ToolOp.inherit({}),
    }
  }

  protected action(): 'toggle' {
    return 'toggle'
  }
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/** Proportional-edit inputs, mirroring the 3D transform ops' vocabulary. */
type UVPropInputs = {
  propEnabled: BoolProperty
  propRadius: FloatProperty
  propIslandOnly: BoolProperty
}

/**
 * The modal drag every UV transform shares.
 *
 * `_tdata` is gathered once and every `exec` recomputes from its `start`, so a
 * drag that fires `exec` on each move accumulates no rounding and one drag is
 * one undo step. It is dropped at `execPost` and at `modalEnd` so the gathered
 * arrays do not ride the undo stack; the snapshot that undo actually needs is
 * separate and covers only the handles that moved.
 */
export abstract class UVTransformOpBase<Inputs extends PropertySlots = {}> extends UVOpBase<Inputs & UVPropInputs> {
  start = new Vector2()
  last = new Vector2()
  mpos = new Vector2()
  first = true

  _tdata?: UVTransData
  _coordUndo?: UVCoordSnapshot

  static tooldef(): ToolDef {
    return {
      is_modal: true,
      inputs: ToolOp.inherit({
        propEnabled   : new BoolProperty(false),
        propRadius    : new FloatProperty(0.1).setRange(0.001, 10).noUnits(),
        propIslandOnly: new BoolProperty(false),
      }),
    }
  }

  _transData(ctx: ToolContext): UVTransData | undefined {
    if (this._tdata !== undefined) {
      return this._tdata
    }

    const source = this._source(ctx)
    if (source === undefined) {
      return undefined
    }

    const layer = this._layer(source)
    if (layer < 0) {
      return undefined
    }

    this._tdata = gatherUVTransData(source, layer, {
      ...this._scope(),
      prop: {
        enabled   : this.inputs.propEnabled.getValue(),
        radius    : this.inputs.propRadius.getValue(),
        islandOnly: this.inputs.propIslandOnly.getValue(),
      },
    })

    return this._tdata
  }

  undoPre(ctx: ToolContext): void {
    this._tdata = undefined
    this._coordUndo = undefined

    const source = this._source(ctx)
    const td = this._transData(ctx)

    if (source !== undefined && td !== undefined) {
      this._coordUndo = snapshotUVCoords(source, this._layer(source), td.handles)
    }
  }

  undo(ctx: ToolContext): void {
    const source = this._source(ctx)

    if (source !== undefined && this._coordUndo !== undefined) {
      restoreUVCoords(source, this._layer(source), this._coordUndo)
      this._redraw(ctx)
    }
  }

  calcUndoMem(): number {
    const snap = this._coordUndo
    return snap === undefined ? 0 : snap.handles.length * 4 + snap.uvs.length * 4
  }

  modalStart(ctx: ViewContext) {
    this.first = true
    return super.modalStart(ctx)
  }

  modalEnd(wasCancelled: boolean) {
    this._tdata = undefined
    return super.modalEnd(wasCancelled)
  }

  on_pointermove(e: PointerEvent): void {
    const ctx = this.modal_ctx
    const editor = this._editor(ctx)

    if (!ctx || !editor) {
      this.modalEnd(true)
      return
    }

    const local = editor.getLocalMouse(e, _tmp1)
    const uv = editor.unprojectUV(local[0], local[1], _tmp2)

    if (this.first) {
      this.first = false
      this.start.load(uv)
      this.last.load(uv)
      return
    }

    this.mpos.load(uv)
    this.onDrag(ctx as unknown as ToolContext)
    this.last.load(uv)

    editor.flagRedraw()
  }

  on_pointerup(e: PointerEvent): void {
    this.modalEnd(e.button === 2)
  }

  on_keydown(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      const ctx = this.modal_ctx

      if (ctx && this._coordUndo !== undefined) {
        this.undo(ctx as unknown as ToolContext)
      }
      this.modalEnd(true)
      return
    }
    super.on_keydown(e)
  }

  /** Turn the cursor's UV position into this op's inputs, then run it. */
  protected abstract onDrag(ctx: ToolContext): void

  execPost(ctx: ToolContext): void {
    this._tdata = undefined
    super.execPost(ctx)
  }
}

export class UVTranslateOp extends UVTransformOpBase<{offset: Vec2Property}> {
  static tooldef() {
    return {
      uiname  : 'Translate',
      toolpath: 'uveditor.translate',
      is_modal: true,
      inputs: ToolOp.inherit({
        offset: new Vec2Property(),
      }),
    }
  }

  protected onDrag(ctx: ToolContext): void {
    this.inputs.offset.setValue(_tmp3.load(this.mpos).sub(this.start))
    this.exec(ctx)
  }

  exec(ctx: ToolContext): void {
    const source = this._source(ctx)
    const td = this._transData(ctx)

    if (source === undefined || td === undefined) {
      return
    }

    const offset = this.inputs.offset.getValue()
    applyUVTranslate(source, this._layer(source), td, offset[0], offset[1])
  }
}

export class UVScaleOp extends UVTransformOpBase<{scale: Vec2Property}> {
  static tooldef() {
    return {
      uiname  : 'Scale',
      toolpath: 'uveditor.scale',
      is_modal: true,
      inputs: ToolOp.inherit({
        scale: new Vec2Property([1, 1]),
      }),
    }
  }

  protected onDrag(ctx: ToolContext): void {
    const td = this._transData(ctx)
    if (td === undefined) {
      return
    }

    const center = _tmp4.load(td.center as unknown as number[])
    const from = this.start.vectorDistance(center)

    if (from === 0) {
      return
    }

    const ratio = this.mpos.vectorDistance(center) / from
    this.inputs.scale.setValue([ratio, ratio])
    this.exec(ctx)
  }

  exec(ctx: ToolContext): void {
    const source = this._source(ctx)
    const td = this._transData(ctx)

    if (source === undefined || td === undefined) {
      return
    }

    const scale = this.inputs.scale.getValue()
    applyUVScale(source, this._layer(source), td, scale[0], scale[1])
  }
}

export class UVRotateOp extends UVTransformOpBase<{rotation: FloatProperty}> {
  static tooldef() {
    return {
      uiname  : 'Rotate',
      toolpath: 'uveditor.rotate',
      is_modal: true,
      inputs: ToolOp.inherit({
        rotation: new FloatProperty(0.0),
      }),
    }
  }

  /**
   * Accumulated per move rather than taken as an absolute angle, so a drag
   * past half a turn keeps winding instead of snapping back.
   */
  protected onDrag(ctx: ToolContext): void {
    const td = this._transData(ctx)
    if (td === undefined) {
      return
    }

    const center = _tmp4.load(td.center as unknown as number[])
    const v1 = _tmp3.load(this.last).sub(center).normalize()
    const v2 = new Vector2(this.mpos).sub(center).normalize()

    this.inputs.rotation.setValue(
      this.inputs.rotation.getValue() + Math.asin((v1[0] * v2[1] - v1[1] * v2[0]) * 0.999999)
    )
    this.exec(ctx)
  }

  exec(ctx: ToolContext): void {
    const source = this._source(ctx)
    const td = this._transData(ctx)

    if (source === undefined || td === undefined) {
      return
    }

    applyUVRotate(source, this._layer(source), td, this.inputs.rotation.getValue())
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project element positions through a matrix — the camera's by default — and
 * fit the result to the unit square.
 *
 * `getUVElementPositions` is optional on the contract, so a source with no
 * geometry behind it (a generated layout, the test double) makes this a no-op
 * rather than an error.
 */
export class UVProjectOp extends UVOpBase<{matrix: Mat4Property; selectedOnly: BoolProperty}> {
  _coordUndo?: UVCoordSnapshot

  static tooldef() {
    return {
      uiname  : 'UV Project',
      toolpath: 'uveditor.project_uvs',
      inputs: ToolOp.inherit({
        matrix      : new Mat4Property().saveLastValue(),
        selectedOnly: new BoolProperty(true).saveLastValue(),
      }),
    }
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>): UVProjectOp {
    const tool = super.invoke(ctx, args) as UVProjectOp
    const camera = ctx.view3d?.activeCamera

    if (camera && !('matrix' in args)) {
      tool.inputs.matrix.setValue(camera.rendermat)
    }

    return tool
  }

  /** The elements to project: the selection, or everything in scope. */
  _targets(source: IUVSource, layer: number): Int32Array {
    return this.inputs.selectedOnly.getValue()
      ? listSelectedUVs(source, layer, this._scope())
      : ringElements(readUVRings(source, layer, this._scope()))
  }

  undoPre(ctx: ToolContext): void {
    const source = this._source(ctx)
    this._coordUndo = undefined

    if (source !== undefined) {
      const layer = this._layer(source)

      if (layer >= 0) {
        this._coordUndo = snapshotUVCoords(source, layer, this._targets(source, layer))
      }
    }
  }

  undo(ctx: ToolContext): void {
    const source = this._source(ctx)

    if (source !== undefined && this._coordUndo !== undefined) {
      restoreUVCoords(source, this._layer(source), this._coordUndo)
      this._redraw(ctx)
    }
  }

  calcUndoMem(): number {
    const snap = this._coordUndo
    return snap === undefined ? 0 : snap.handles.length * 4 + snap.uvs.length * 4
  }

  exec(ctx: ToolContext): void {
    const source = this._source(ctx)
    if (source === undefined || source.getUVElementPositions === undefined) {
      return
    }

    const layer = this._layer(source)
    if (layer < 0) {
      return
    }

    const handles = this._targets(source, layer)
    if (handles.length === 0) {
      return
    }

    const co = source.getUVElementPositions(layer, handles)
    const matrix = new Matrix4(this.inputs.matrix.getValue())
    const p = new Vector3()
    const uv = new Float32Array(handles.length * 2)

    let minU = 1e17
    let minV = 1e17
    let maxU = -1e17
    let maxV = -1e17

    for (let i = 0; i < handles.length; i++) {
      p[0] = co[i * 3]
      p[1] = co[i * 3 + 1]
      p[2] = co[i * 3 + 2]
      p.multVecMatrix(matrix)

      uv[i * 2] = p[0]
      uv[i * 2 + 1] = p[1]

      minU = Math.min(minU, p[0])
      minV = Math.min(minV, p[1])
      maxU = Math.max(maxU, p[0])
      maxV = Math.max(maxV, p[1])
    }

    // One scale for both axes, so the projection keeps its aspect ratio.
    const scale = 1.0 / Math.max(maxU - minU, maxV - minV, 1e-4)

    for (let i = 0; i < uv.length; i += 2) {
      uv[i] = (uv[i] - minU) * scale
      uv[i + 1] = (uv[i + 1] - minV) * scale
    }

    source.setUVs(layer, handles, uv)
  }
}

/** Everything registered under `uveditor.*`, in one list for `main.ts`. */
export const UV_OPS = [
  ToggleSelectAllUVsOp,
  SelectOneUVOp,
  SelectLinkedPickUVOp,
  UVSetFlagOp,
  UVClearFlagOp,
  UVToggleFlagOp,
  UVTranslateOp,
  UVScaleOp,
  UVRotateOp,
  UVProjectOp,
]
