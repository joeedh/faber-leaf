/**
 * The LeafMesh modeling ToolOps — P12 §4, step 4: extrude region, extrude
 * individual, split-off. Thin shells over `modeling.ts`, which is pure and
 * carries the tests; what is decided here is selection, undo and the follow-up
 * transform.
 *
 * Undo is a whole-mesh copy (§7). A topology op rewrites handles across four
 * domains at once, so there is no snapshot smaller than the mesh that is
 * honest — `calcUndoMem` reports what it actually costs rather than zero, and
 * `meshSnapshotBytes` is what it reports.
 *
 * `transform=1` chains a `TranslateOp` behind the geom op in one `ToolMacro`,
 * so an interactive extrude is one undo step. The op's `normalSpace` output
 * drives the translate's constraint space, which is what locks the drag to the
 * region's averaged normal.
 */

import type {SceneObject, ToolContext, ViewContext} from '@framework/api'
import {Icons, InvalidationKind, SelMask, TranslateOp} from '@framework/api'
import {
  BoolProperty,
  FloatProperty,
  Mat4Property,
  Matrix4,
  PropertySlots,
  ToolMacro,
  ToolOp,
  Vector3,
  Vector4,
} from '@framework/pathux'

import {Domain} from './attrs.js'
import {bevelEdges, bevelVerts} from './bevel.js'
import {LeafMeshData} from './leafmesh.js'
import type {RegionResult} from './modeling.js'
import {
  extrudeFaceRegion,
  extrudeFacesIndividual,
  insetFaceRegion,
  insetFacesIndividual,
  meshSnapshotBytes,
  splitOffFaces,
} from './modeling.js'
import type {SelectDomain} from './select_geom.js'
import {applySelection, flushSelection, listSelected, selectAll} from './select_geom.js'
import {LeafMesh} from './topo.js'

/** The output every one of these carries, so the macro can wire it up. */
interface NormalSpaceOut extends PropertySlots {
  normalSpace: Mat4Property
}

/** The inputs shared by all three: whether to chain a grab behind the op. */
interface TransformIn extends PropertySlots {
  transform: BoolProperty
}

/** Extrude adds a scripted lift, so §8's headless sequences need no pointer. */
interface ExtrudeIn extends TransformIn {
  offset: FloatProperty
}

/** What a drag writes: an inset's width, a bevel's radius. */
interface AmountIn extends PropertySlots {
  amount: FloatProperty
}

interface InsetIn extends AmountIn {
  depth: FloatProperty
  individual: BoolProperty
}

/** The parts of the view a drag touches that are not on `View3D`'s surface. */
interface DragView3D {
  getLocalMouse(x: number, y: number): {0: number; 1: number}
  activeCamera: {rendermat: Matrix4}
  unproject(p: Vector4, imat: Matrix4): void
}

interface DragCtx {
  view3d?: DragView3D
  object?: SceneObject
}

/** Object-local units per screen pixel, so a drag reads the same at any zoom. */
function localUnitsPerPixel(ctx: DragCtx): number {
  const {view3d, object} = ctx
  if (view3d === undefined || object === undefined) {
    return 0.01
  }

  const imat = new Matrix4(object.outputs.matrix.getValue())
  imat.multiply(view3d.activeCamera.rendermat)
  imat.invert()

  const a = new Vector4([0, 0, 0.5, 1])
  const b = new Vector4([100, 0, 0.5, 1])
  view3d.unproject(a, imat)
  view3d.unproject(b, imat)

  return new Vector3([a[0], a[1], a[2]]).vectorDistance(new Vector3([b[0], b[1], b[2]])) / 100
}

export abstract class LeafMeshTopoOpBase<
  Inputs extends PropertySlots = {},
  Outputs extends PropertySlots = {},
> extends ToolOp<Inputs, Outputs> {
  _snap?: LeafMesh

  _getData(ctx: ToolContext): LeafMeshData | undefined {
    const data = ctx.scene?.objects?.active?.data
    return data instanceof LeafMeshData ? data : undefined
  }

  undoPre(ctx: ToolContext): void {
    const data = this._getData(ctx)
    this._snap = data?.mesh.copy()
  }

  undo(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined || this._snap === undefined) {
      return
    }

    // A fresh copy each time, so the snapshot survives undo → redo → undo.
    data.mesh = this._snap.copy()
    data.invalidate(InvalidationKind.ALL)
    window.redraw_viewport()
  }

  calcUndoMem(_ctx: ToolContext): number {
    return this._snap === undefined ? 0 : meshSnapshotBytes(this._snap)
  }

  /** Leave the result selected, flushed down to verts and edges, and drawn. */
  _finish(data: LeafMeshData, faces: readonly number[]): void {
    for (const d of [Domain.VERT, Domain.EDGE, Domain.FACE] as SelectDomain[]) {
      selectAll(data.mesh, d, false)
    }

    applySelection(data.mesh, Domain.FACE, faces, 'add')
    flushSelection(data.mesh, Domain.FACE)

    data.invalidate(InvalidationKind.ALL)
    window.redraw_viewport()
  }
}

/**
 * The geom op followed by a grab, as one undo unit. `constrainNormal` locks the
 * drag to the op's `normalSpace` Z — the extrude direction; a split-off drags
 * freely instead.
 */
function makeTransformMacro(tool: ToolOp, constrainNormal = true): ToolMacro<ToolContext> {
  const macro = new ToolMacro<ToolContext>()
  macro.add(tool)

  const translate = new TranslateOp()
  translate.inputs.selmask.setValue(SelMask.GEOM)
  macro.add(translate)

  if (constrainNormal) {
    translate.inputs.constraint.setValue([0, 0, 1])
    macro.connect(tool, 'normalSpace', translate, 'constraint_space')
  }

  return macro
}

/** Publish the region's averaged normal as the space a follow-up grab uses. */
function setNormalSpace(op: LeafMeshTopoOpBase<PropertySlots, NormalSpaceOut>, out: RegionResult): void {
  op.outputs.normalSpace.setValue(new Matrix4().makeNormalMatrix(new Vector3(out.normal)))
}

/** Extrude the selected faces as one region: one rim, one wall per rim edge. */
export class LeafMeshExtrudeRegionOp extends LeafMeshTopoOpBase<ExtrudeIn, NormalSpaceOut> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.extrude_region',
      uiname  : 'Extrude Region',
      icon    : Icons.EXTRUDE,
      inputs: {
        transform: new BoolProperty(false).private(),
        offset   : new FloatProperty(0),
      },
      outputs : {normalSpace: new Mat4Property()},
    }
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>): ToolOp {
    const tool = super.invoke(ctx, args) as unknown as LeafMeshExtrudeRegionOp
    return args['transform'] ? (makeTransformMacro(tool) as unknown as ToolOp) : (tool as unknown as ToolOp)
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const out = extrudeFaceRegion(data.mesh, listSelected(data.mesh, Domain.FACE), {
      offset: this.inputs.offset.getValue(),
    })

    setNormalSpace(this, out)
    this._finish(data, out.faces)
  }
}

/** Extrude each selected face on its own, so neighbours come apart. */
export class LeafMeshExtrudeIndividualOp extends LeafMeshTopoOpBase<ExtrudeIn, NormalSpaceOut> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.extrude_individual',
      uiname  : 'Extrude Individual Faces',
      icon    : Icons.EXTRUDE_INDIVIDUAL,
      inputs: {
        transform: new BoolProperty(false).private(),
        offset   : new FloatProperty(0),
      },
      outputs : {normalSpace: new Mat4Property()},
    }
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>): ToolOp {
    const tool = super.invoke(ctx, args) as unknown as LeafMeshExtrudeIndividualOp
    return args['transform'] ? (makeTransformMacro(tool) as unknown as ToolOp) : (tool as unknown as ToolOp)
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const out = extrudeFacesIndividual(data.mesh, listSelected(data.mesh, Domain.FACE), {
      offset: this.inputs.offset.getValue(),
    })

    setNormalSpace(this, out)
    this._finish(data, out.faces)
  }
}

/** Detach the selected faces from everything they touch, raising no walls. */
export class LeafMeshSplitOffOp extends LeafMeshTopoOpBase<TransformIn, NormalSpaceOut> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.split_off',
      uiname  : 'Split Faces Off',
      icon    : Icons.SPLIT_FACES_OFF,
      inputs  : {transform: new BoolProperty(false).private()},
      outputs : {normalSpace: new Mat4Property()},
    }
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>): ToolOp {
    const tool = super.invoke(ctx, args) as unknown as LeafMeshSplitOffOp
    // A detached piece goes anywhere, so the grab behind it is unconstrained.
    return args['transform'] ? (makeTransformMacro(tool, false) as unknown as ToolOp) : (tool as unknown as ToolOp)
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const out = splitOffFaces(data.mesh, listSelected(data.mesh, Domain.FACE))

    setNormalSpace(this, out)
    this._finish(data, out.faces)
  }
}

/**
 * Inset and bevel read out as one number, so they drag rather than chaining a
 * translate: the modal restores the undo snapshot and re-runs `exec` from the
 * new width each move. `exec` doing the whole job from its inputs is what keeps
 * these scriptable — §8's headless sequences call them with no pointer at all.
 */
abstract class LeafMeshDragOpBase<Inputs extends AmountIn> extends LeafMeshTopoOpBase<Inputs, {}> {
  _startX = 0
  _haveStart = false
  _scale = 0.01

  _dragCtx(): (DragCtx & ToolContext) | undefined {
    return this.modal_ctx as unknown as (DragCtx & ToolContext) | undefined
  }

  modalStart(ctx: ViewContext) {
    this._haveStart = false
    this._scale = localUnitsPerPixel(ctx as unknown as DragCtx)
    this.exec(ctx as unknown as ToolContext)
    return super.modalStart(ctx)
  }

  /** A drag is a fresh op each move, run against the mesh as it was before. */
  _replay(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined || this._snap === undefined) {
      return
    }

    data.mesh = this._snap.copy()
    this.exec(ctx)
  }

  on_pointermove(e: PointerEvent): void {
    const ctx = this._dragCtx()
    if (ctx?.view3d === undefined) {
      return
    }

    const m = ctx.view3d.getLocalMouse(e.x, e.y)
    if (!this._haveStart) {
      this._startX = m[0]
      this._haveStart = true
      return
    }

    this.inputs.amount.setValue((m[0] - this._startX) * this._scale)
    this._replay(ctx)
  }

  on_pointerdown(e: PointerEvent): void {
    if (e.button === 2) {
      this.modalEnd(true)
    } else if (e.button === 0) {
      this.modalEnd(false)
    }
  }

  on_keydown(e: KeyboardEvent): void {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      this.modalEnd(false)
    } else if (e.code === 'Escape') {
      // `modalEnd(true)` runs the toolstack's cancel, which is our `undo`.
      this.modalEnd(true)
    }
  }
}

/** Inset the selected faces, optionally lifting the result along its normal. */
export class LeafMeshInsetOp extends LeafMeshDragOpBase<InsetIn> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.inset_faces',
      uiname  : 'Inset Faces',
      icon    : Icons.INSET,
      is_modal: true,
      inputs: {
        amount    : new FloatProperty(0),
        depth     : new FloatProperty(0),
        individual: new BoolProperty(false),
      },
    }
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const faces = listSelected(data.mesh, Domain.FACE)
    const opts = {amount: this.inputs.amount.getValue(), depth: this.inputs.depth.getValue()}
    const out = this.inputs.individual.getValue()
      ? insetFacesIndividual(data.mesh, faces, opts)
      : insetFaceRegion(data.mesh, faces, opts)

    this._finish(data, out.faces)
  }
}

/** Replace each selected vertex by a face. */
export class LeafMeshBevelVertsOp extends LeafMeshDragOpBase<AmountIn> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.bevel_verts',
      uiname  : 'Bevel Vertices',
      icon    : Icons.BEVEL,
      is_modal: true,
      inputs  : {amount: new FloatProperty(0)},
    }
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const out = bevelVerts(data.mesh, listSelected(data.mesh, Domain.VERT), {
      amount: this.inputs.amount.getValue(),
    })

    this._finish(data, out.faces)
  }
}

/** Replace each selected edge by a quad. Chained selections are refused. */
export class LeafMeshBevelEdgesOp extends LeafMeshDragOpBase<AmountIn> {
  static tooldef() {
    return {
      toolpath: 'leafmesh.bevel_edges',
      uiname  : 'Bevel Edges',
      icon    : Icons.BEVEL,
      is_modal: true,
      inputs  : {amount: new FloatProperty(0)},
    }
  }

  exec(ctx: ToolContext): void {
    const data = this._getData(ctx)
    if (data === undefined) {
      return
    }

    const out = bevelEdges(data.mesh, listSelected(data.mesh, Domain.EDGE), {
      amount: this.inputs.amount.getValue(),
    })

    this._finish(data, out.faces)
  }
}

export const LEAFMESH_MODELING_OPS = [
  LeafMeshExtrudeRegionOp,
  LeafMeshExtrudeIndividualOp,
  LeafMeshSplitOffOp,
  LeafMeshInsetOp,
  LeafMeshBevelVertsOp,
  LeafMeshBevelEdgesOp,
]
