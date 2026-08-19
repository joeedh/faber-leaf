/**
 * The LeafMesh selection ToolOps — P12 §4, step 1. Every one of them is a thin
 * shell: the traversal lives in `select_geom.ts` (pure, unit-tested) and the
 * screen-space queries in P11's pick entry points.
 *
 * Undo is a snapshot of the three selection columns, taken in `undoPre` and put
 * back in `undo` (§7). LeafMesh handles are stable under tombstoned deletion, so
 * a snapshot stays meaningful; `calcUndoMem` reports the real byte count rather
 * than zero.
 *
 * Modal ops call `exec` themselves when the interaction commits — the toolstack
 * does not call it for them — which is also what makes redo work, since redo is
 * `undoPre` + `exec`.
 */

import type {FindNearestRet, SceneObject, ToolContext, View3D, ViewContext} from '@framework/api'
import {ElementDomain, Icons, InvalidationKind, SelMask, SelToolModes} from '@framework/api'
import {BoolProperty, EnumProperty, FloatProperty, PropertySlots, ToolOp, Vector2} from '@framework/pathux'

import {Domain} from './attrs.js'
import {ELEM_NONE} from './elem_array.js'
import {LeafMeshData} from './leafmesh.js'
import type {LeafMeshPickElem} from './pick_geom.js'
import type {SelectAction, SelectDomain, SelectionSnapshot, SimilarCriterion} from './select_geom.js'
import {
  applySelection,
  countSelected,
  linkedFrom,
  listSelected,
  restoreSelection,
  selectAll,
  similarTo,
  snapshotSelection,
} from './select_geom.js'

/** The toolmode fields the ops read, structurally so neither file imports the other. */
export interface ILeafMeshToolMode {
  leafMeshSelMode?: number
  selectRadius?: number
}

/** The parts of the view we touch that are not on `View3D`'s declared surface. */
interface SelModalView3D {
  getLocalMouse(x: number, y: number): {0: number; 1: number}
  overdraw?: {
    clear(): void
    line(a: number[], b: number[], color: string): unknown
    circle(p: number[], r: number, stroke?: string, fill?: string): unknown
  }
}

/** The modal context these ops reach into, named rather than cast ad hoc. */
interface SelModalCtx {
  view3d?: SelModalView3D & View3D
  object?: SceneObject
  toolmode?: ILeafMeshToolMode
}

/** `SelMask` bits to LeafMesh domains, defaulting to vertices. */
export function selMaskToDomains(mask: number): SelectDomain[] {
  const out: SelectDomain[] = []

  if (mask & SelMask.VERTEX) {
    out.push(Domain.VERT)
  }
  if (mask & SelMask.EDGE) {
    out.push(Domain.EDGE)
  }
  if (mask & SelMask.FACE) {
    out.push(Domain.FACE)
  }

  return out.length > 0 ? out : [Domain.VERT]
}

/** The pick layer's domain names, in the same vocabulary. */
const PICK_DOMAIN: Record<string, SelectDomain> = {
  vert: Domain.VERT,
  edge: Domain.EDGE,
  face: Domain.FACE,
}

export abstract class LeafMeshSelectOpBase<
  Inputs extends PropertySlots = {},
  Outputs extends PropertySlots = {},
> extends ToolOp<Inputs, Outputs> {
  _snap?: SelectionSnapshot

  _getData(ctx: ToolContext): LeafMeshData | undefined {
    const data = ctx.scene?.objects?.active?.data
    return data instanceof LeafMeshData ? data : undefined
  }

  /** Which domains the active toolmode's selection mode covers. */
  _domains(ctx: ToolContext): SelectDomain[] {
    const mode = (ctx as unknown as SelModalCtx).toolmode?.leafMeshSelMode
    return selMaskToDomains(mode ?? SelMask.VERTEX)
  }

  /** The domain a single-element pick writes: the first enabled one. */
  _pickDomain(ctx: ToolContext): SelectDomain {
    return this._domains(ctx)[0]
  }

  _refresh(data: LeafMeshData): void {
    data.invalidate(InvalidationKind.SELECTION)
    window.redraw_viewport()
  }

  undoPre(ctx: ToolContext): void {
    const data = this._getData(ctx)
    this._snap = data === undefined ? undefined : snapshotSelection(data.mesh)
  }

  undo(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data !== undefined && this._snap !== undefined) {
      restoreSelection(data.mesh, this._snap)
      this._refresh(data)
    }
  }

  calcUndoMem(_ctx: ToolContext): number {
    return this._snap?.bytes ?? 0
  }
}

/**
 * Select all / none / auto (auto = all when nothing is selected, else none).
 * Operates on every domain rather than the active selection mode, so A never
 * leaves stale selection behind in a domain the mode has switched away from.
 */
export class SelectAllLeafMeshOp extends LeafMeshSelectOpBase<{mode: EnumProperty}> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.select_all',
      uiname  : 'Select All',
      icon    : Icons.TOGGLE_SEL_ALL,
      inputs  : {
        mode: new EnumProperty(2, {ALL: 0, NONE: 1, AUTO: 2}),
      },
    }
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const domains: SelectDomain[] = [Domain.VERT, Domain.EDGE, Domain.FACE]
    let mode = this.inputs.mode.getValue()

    if (mode === 2) {
      let any = 0
      for (const d of domains) {
        any += countSelected(data.mesh, d)
      }
      mode = any > 0 ? 1 : 0
    }

    for (const d of domains) {
      selectAll(data.mesh, d, mode === 0)
    }
    this._refresh(data)
  }
}

/**
 * Box select. The rubber band is drawn live; the selection itself is applied in
 * `exec`, once, when the drag commits — so redo replays it without the pointer.
 */
export class SelectBoxLeafMeshOp extends LeafMeshSelectOpBase<{
  mode: EnumProperty
  x1: FloatProperty
  y1: FloatProperty
  x2: FloatProperty
  y2: FloatProperty
}> {
  mdown = false

  static tooldef() {
    return {
      toolpath: 'leafmesh.select_box',
      uiname  : 'Box Select',
      icon    : Icons.SELECT_BOX,
      is_modal: true,
      inputs  : {
        mode: new EnumProperty(SelToolModes.ADD, SelToolModes).private(),
        x1  : new FloatProperty(0).private(),
        y1  : new FloatProperty(0).private(),
        x2  : new FloatProperty(0).private(),
        y2  : new FloatProperty(0).private(),
      },
    }
  }

  _ctx(): SelModalCtx | undefined {
    return this.modal_ctx as unknown as SelModalCtx | undefined
  }

  on_pointerdown(e: PointerEvent): void {
    const view3d = this._ctx()?.view3d
    if (view3d === undefined) {
      return
    }
    if (e.button === 2) {
      this.modalEnd(true)
      return
    }

    this.inputs.mode.setValue(e.shiftKey ? SelToolModes.SUB : SelToolModes.ADD)

    const m = view3d.getLocalMouse(e.x, e.y)
    this.inputs.x1.setValue(m[0])
    this.inputs.y1.setValue(m[1])
    this.inputs.x2.setValue(m[0])
    this.inputs.y2.setValue(m[1])
    this.mdown = true
  }

  on_pointermove(e: PointerEvent): void {
    const view3d = this._ctx()?.view3d
    if (!this.mdown || view3d === undefined) {
      return
    }

    const m = view3d.getLocalMouse(e.x, e.y)
    this.inputs.x2.setValue(m[0])
    this.inputs.y2.setValue(m[1])
    this._drawRect(view3d)
  }

  on_pointerup(_e: PointerEvent): void {
    const ctx = this._ctx()
    if (this.mdown && ctx !== undefined) {
      this.exec(ctx as unknown as ToolContext)
    }

    this.mdown = false
    ctx?.view3d?.overdraw?.clear()
    this.modalEnd(false)
  }

  on_keydown(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      this._ctx()?.view3d?.overdraw?.clear()
      this.modalEnd(true)
    }
  }

  private _drawRect(view3d: SelModalView3D): void {
    const overdraw = view3d.overdraw
    if (!overdraw) {
      return
    }

    const ax = this.inputs.x1.getValue()
    const ay = this.inputs.y1.getValue()
    const bx = this.inputs.x2.getValue()
    const by = this.inputs.y2.getValue()

    overdraw.clear()
    overdraw.line([ax, ay], [bx, ay], 'white')
    overdraw.line([bx, ay], [bx, by], 'white')
    overdraw.line([bx, by], [ax, by], 'white')
    overdraw.line([ax, by], [ax, ay], 'white')
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    const {view3d, object} = (ctx as unknown as SelModalCtx) ?? {}
    if (data === undefined || view3d === undefined || object === undefined) {
      return
    }

    const x1 = this.inputs.x1.getValue()
    const y1 = this.inputs.y1.getValue()
    const x2 = this.inputs.x2.getValue()
    const y2 = this.inputs.y2.getValue()
    const min = new Vector2([Math.min(x1, x2), Math.min(y1, y2)])
    const max = new Vector2([Math.max(x1, x2), Math.max(y1, y2)])

    const mask = this._domains(ctx).reduce((m, d) => m | domainToMask(d), 0)
    const hit = data.castScreenRect(ctx as unknown as ViewContext, view3d, object, mask, min, max)
    const action: SelectAction = this.inputs.mode.getValue() === SelToolModes.SUB ? 'sub' : 'add'

    applyPicks(data, hit.elements as LeafMeshPickElem[], action)
    this._refresh(data)
  }
}

/**
 * Circle/brush select. The drag paints selection live, and every element it
 * touched is re-applied by `exec` on commit so that one drag is one undo step.
 */
export class SelectCircleLeafMeshOp extends LeafMeshSelectOpBase<{
  radius: FloatProperty
  mode: EnumProperty
}> {
  mdown = false
  /** Everything the brush touched this drag, keyed by domain. */
  private _touched = new Map<SelectDomain, Set<number>>()

  static tooldef() {
    return {
      toolpath: 'leafmesh.select_circle',
      uiname  : 'Circle Select',
      icon    : Icons.CIRCLE_SEL,
      is_modal: true,
      inputs  : {
        radius: new FloatProperty(25).setRange(1, 500).noUnits().saveLastValue(),
        mode  : new EnumProperty(SelToolModes.ADD, SelToolModes).private(),
      },
    }
  }

  _ctx(): SelModalCtx | undefined {
    return this.modal_ctx as unknown as SelModalCtx | undefined
  }

  modalStart(ctx: ViewContext) {
    this.mdown = false
    this._touched.clear()

    const radius = (ctx as unknown as SelModalCtx).toolmode?.selectRadius
    if (radius) {
      this.inputs.radius.setValue(radius)
    }
    return super.modalStart(ctx)
  }

  private _stamp(e: PointerEvent): void {
    const ctx = this._ctx()
    const data = ctx === undefined ? undefined : this._getData(ctx as unknown as ToolContext)
    if (ctx?.view3d === undefined || ctx.object === undefined || data === undefined) {
      return
    }

    const m = ctx.view3d.getLocalMouse(e.x, e.y)
    const mask = this._domains(ctx as unknown as ToolContext).reduce((acc, d) => acc | domainToMask(d), 0)
    const hit = data.castScreenCircle(
      ctx as unknown as ViewContext,
      ctx.view3d,
      ctx.object,
      mask,
      new Vector2([m[0], m[1]]),
      this.inputs.radius.getValue()
    )

    this.inputs.mode.setValue(e.shiftKey ? SelToolModes.SUB : SelToolModes.ADD)
    const action: SelectAction = e.shiftKey ? 'sub' : 'add'

    for (const elem of hit.elements as LeafMeshPickElem[]) {
      const domain = PICK_DOMAIN[elem.type]
      let set = this._touched.get(domain)
      if (set === undefined) {
        set = new Set()
        this._touched.set(domain, set)
      }
      set.add(elem.index)
    }

    applyPicks(data, hit.elements as LeafMeshPickElem[], action)
    this._refresh(data)
  }

  private _drawCircle(e: PointerEvent): void {
    const view3d = this._ctx()?.view3d
    const overdraw = view3d?.overdraw
    if (view3d === undefined || !overdraw) {
      return
    }

    const m = view3d.getLocalMouse(e.x, e.y)
    overdraw.clear()
    overdraw.circle([m[0], m[1]], this.inputs.radius.getValue(), 'white')
  }

  on_pointerdown(e: PointerEvent): void {
    if (e.button === 2) {
      this._commit()
      return
    }
    this.mdown = true
    this._stamp(e)
  }

  on_pointermove(e: PointerEvent): void {
    if (this.mdown) {
      this._stamp(e)
    }
    this._drawCircle(e)
  }

  on_pointerup(_e: PointerEvent): void {
    this.mdown = false
  }

  on_keydown(e: KeyboardEvent): void {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      this._commit()
    } else if (e.code === 'Escape') {
      this._ctx()?.view3d?.overdraw?.clear()
      this.modalEnd(true)
    }
  }

  private _commit(): void {
    const ctx = this._ctx()
    if (ctx !== undefined) {
      this.exec(ctx as unknown as ToolContext)
    }

    ctx?.view3d?.overdraw?.clear()
    this.modalEnd(false)
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const action: SelectAction = this.inputs.mode.getValue() === SelToolModes.SUB ? 'sub' : 'add'
    for (const [domain, handles] of this._touched) {
      applySelection(data.mesh, domain, handles, action)
    }
    this._refresh(data)
  }
}

/**
 * Click select: plain click replaces, shift toggles, and the picked element
 * becomes active. Modal only so that the toolmode can hand it a live pointer;
 * a scripted caller sets `x`/`y`/`useXY` and runs it non-modally.
 */
export class SelectNearestLeafMeshOp extends LeafMeshSelectOpBase<{
  toggle: BoolProperty
  x: FloatProperty
  y: FloatProperty
  useXY: BoolProperty
}> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.select_nearest',
      uiname  : 'Select',
      icon    : Icons.CURSOR_ARROW,
      is_modal: true,
      inputs  : {
        toggle: new BoolProperty(false).private(),
        x     : new FloatProperty(0).private(),
        y     : new FloatProperty(0).private(),
        useXY : new BoolProperty(false).private(),
      },
    }
  }

  _ctx(): SelModalCtx | undefined {
    return this.modal_ctx as unknown as SelModalCtx | undefined
  }

  on_pointerdown(e: PointerEvent): void {
    const ctx = this._ctx()
    const view3d = ctx?.view3d
    if (ctx === undefined || view3d === undefined) {
      this.modalEnd(true)
      return
    }

    const m = view3d.getLocalMouse(e.x, e.y)
    this.inputs.x.setValue(m[0])
    this.inputs.y.setValue(m[1])
    this.inputs.useXY.setValue(true)
    this.inputs.toggle.setValue(e.shiftKey)

    this.exec(ctx as unknown as ToolContext)
    this.modalEnd(false)
  }

  on_keydown(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      this.modalEnd(true)
    }
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    const {view3d, object} = (ctx as unknown as SelModalCtx) ?? {}
    if (data === undefined || view3d === undefined || object === undefined || !this.inputs.useXY.getValue()) {
      return
    }

    const domain = this._pickDomain(ctx)
    const mpos = new Vector2([this.inputs.x.getValue(), this.inputs.y.getValue()])
    const hits = data.findNearest(ctx as unknown as ViewContext, view3d, object, domainToMask(domain), mpos, 1)
    const elem = nearestPick(hits)

    const toggle = this.inputs.toggle.getValue()

    if (elem === undefined) {
      // Clicking empty space clears, which is what every modeler does.
      if (!toggle) {
        this._clearAll(data)
        this._refresh(data)
      }
      return
    }

    const target = PICK_DOMAIN[elem.type] ?? domain
    if (!toggle) {
      this._clearAll(data)
    }

    applySelection(data.mesh, target, [elem.index], toggle ? 'toggle' : 'add')
    data.setActiveElement(toElementDomain(target), elem.index)
    this._refresh(data)
  }

  /** A plain click replaces the whole selection, not just the picked domain. */
  private _clearAll(data: LeafMeshData): void {
    for (const d of [Domain.VERT, Domain.EDGE, Domain.FACE] as SelectDomain[]) {
      applySelection(data.mesh, d, [], 'replace')
      data.setActiveElement(toElementDomain(d), undefined)
    }
  }
}

/** Grow the current selection to every element connected to it. */
export class SelectLinkedLeafMeshOp extends LeafMeshSelectOpBase<{deselect: BoolProperty}> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.select_linked',
      uiname  : 'Select Linked',
      inputs  : {
        deselect: new BoolProperty(false),
      },
    }
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const action: SelectAction = this.inputs.deselect.getValue() ? 'sub' : 'add'
    for (const domain of this._domains(ctx)) {
      const seeds = listSelected(data.mesh, domain)
      if (seeds.length > 0) {
        applySelection(data.mesh, domain, linkedFrom(data.mesh, domain, seeds), action)
      }
    }
    this._refresh(data)
  }
}

const SIMILAR_CRITERIA: Record<string, number> = {
  FACE_SIDES    : 0,
  FACE_AREA     : 1,
  FACE_NORMAL   : 2,
  FACE_COPLANAR : 3,
  FACE_HOLES    : 4,
  EDGE_LENGTH   : 5,
  EDGE_FACES    : 6,
  EDGE_DIRECTION: 7,
  VERT_EDGES    : 8,
  VERT_FACES    : 9,
}

const SIMILAR_NAMES = Object.keys(SIMILAR_CRITERIA) as SimilarCriterion[]

/** Seeded from the active element, which is what makes the result predictable. */
export class SelectSimilarLeafMeshOp extends LeafMeshSelectOpBase<{
  criterion: EnumProperty
  threshold: FloatProperty
}> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.select_similar',
      uiname  : 'Select Similar',
      inputs  : {
        criterion: new EnumProperty(0, SIMILAR_CRITERIA),
        threshold: new FloatProperty(0.01).setRange(0, 1).noUnits().saveLastValue(),
      },
    }
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const criterion = SIMILAR_NAMES[Number(this.inputs.criterion.getValue())]
    const domain = criterion.startsWith('FACE')
      ? Domain.FACE
      : criterion.startsWith('EDGE')
        ? Domain.EDGE
        : Domain.VERT

    const active = data.getActiveElement(toElementDomain(domain))
    const seed = active ?? listSelected(data.mesh, domain)[0] ?? ELEM_NONE
    if (seed === ELEM_NONE) {
      ctx.error('Select Similar needs an active element')
      return
    }

    const matches = similarTo(data.mesh, domain, seed, criterion, this.inputs.threshold.getValue())
    applySelection(data.mesh, domain, matches, 'add')
    this._refresh(data)
  }
}

/** One domain's `SelMask` bit — the inverse of {@link selMaskToDomains}. */
function domainToMask(domain: SelectDomain): number {
  return domain === Domain.FACE ? SelMask.FACE : domain === Domain.EDGE ? SelMask.EDGE : SelMask.VERTEX
}

/**
 * The contract's `ElementDomain` and the addon's `Domain` agree numerically for
 * the three modeling domains, but the active-element API is typed on the former.
 */
function toElementDomain(domain: SelectDomain): ElementDomain {
  return domain as unknown as ElementDomain
}

/** `findNearest` answers one hit per domain; take the closest of them. */
function nearestPick(hits: FindNearestRet[] | undefined): LeafMeshPickElem | undefined {
  let best: LeafMeshPickElem | undefined
  let bestDis = Infinity

  for (const hit of hits ?? []) {
    const elem = hit.data as LeafMeshPickElem | undefined
    const dis = hit.dis ?? Infinity

    if (elem !== undefined && PICK_DOMAIN[elem.type] !== undefined && dis < bestDis) {
      best = elem
      bestDis = dis
    }
  }
  return best
}

/** Apply a pick result, grouping by domain so `replace` clears only once. */
function applyPicks(data: LeafMeshData, elements: readonly LeafMeshPickElem[], action: SelectAction): void {
  const byDomain = new Map<SelectDomain, number[]>()

  for (const elem of elements) {
    const domain = PICK_DOMAIN[elem.type]
    if (domain === undefined) {
      continue
    }

    const list = byDomain.get(domain)
    if (list === undefined) {
      byDomain.set(domain, [elem.index])
    } else {
      list.push(elem.index)
    }
  }

  for (const [domain, handles] of byDomain) {
    applySelection(data.mesh, domain, handles, action)
  }
}

export const LEAFMESH_SELECT_OPS = [
  SelectAllLeafMeshOp,
  SelectBoxLeafMeshOp,
  SelectCircleLeafMeshOp,
  SelectNearestLeafMeshOp,
  SelectLinkedLeafMeshOp,
  SelectSimilarLeafMeshOp,
]
