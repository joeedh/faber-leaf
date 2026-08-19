import {
  FloatProperty,
  IntProperty,
  BoolProperty,
  FlagProperty,
  EnumProperty,
  ToolOp,
  UndoFlags,
  PropertySlots,
  Vector3,
  Vector4,
  Matrix4,
} from '../../../../scripts/path.ux/scripts/pathux'
import type {ViewContext, ToolContext} from '../../../../scripts/core/context'
import type {VdmStore, Mesh as WasmMesh} from '@sculptcore/api'
import type {IWasmInterface} from '@sculptcore/api/api'
import {SceneObject, ObjectFlags} from '../../../../scripts/sceneobject/sceneobject'
import {getWasmImmediate} from '@sculptcore/api/api'
import {LiteMesh, AttrDomain} from './litemesh'
import {makeDefaultMaterial} from '../../../../scripts/core/material'
import {FeatureFlags} from '@framework/api'
import {Icons} from '../../../../scripts/editors/icon_enum.js'
import {SculptPaintOp} from './sculptcore_ops'

export class LiteMeshOp<Inputs extends PropertySlots = {}, Outputs extends PropertySlots = {}> extends ToolOp<
  Inputs,
  Outputs,
  ToolContext,
  ViewContext
> {
  execPost(ctx: ToolContext, ob = ctx.object) {
    if (ob?.data instanceof LiteMesh) {
      ob.data.regenBounds()
      window.redraw_viewport()
    }
  }
}

/** Shared add-shape scaffolding: subclasses provide the tooldef and the wasm
 * mesh factory; exec wraps it in a LiteMesh + SceneObject + default material
 * and the synchronous object-removal undo below handles undo/redo. */
export abstract class AddLiteMeshShapeOp<Inputs extends PropertySlots = {}> extends LiteMeshOp<
  Inputs,
  {newObjectId: IntProperty}
> {
  // Created datablocks (for the synchronous undo). Refs are stable because this
  // op does NOT use the default memfile undo — see undo() below.
  _prevActiveId?: number
  _prevActiveSelected?: boolean

  protected abstract makeWasmMesh(wasm: IWasmInterface): WasmMesh

  /** Place a newly created object at the scene 3D cursor, oriented so its +Z
   * faces the active view3d camera. Headless (no view3d) keeps identity
   * orientation; translation still comes from the cursor. */
  protected placeAtCursor(ctx: ToolContext, ob: SceneObject): void {
    const cursor = ctx.scene?.cursor3D
    if (!cursor) {
      return
    }

    const loc = new Vector3()
    loc.multVecMatrix(cursor)
    ob.inputs.loc.setValue(loc)

    const cam = (ctx as unknown as {view3d?: {activeCamera?: {pos: Vector3; up: Vector3}}}).view3d?.activeCamera
    if (cam) {
      const z = new Vector3(cam.pos).sub(loc)
      if (z.dot(z) > 1e-12) {
        // Orthonormal camera-facing basis: local +Z toward the camera, roll
        // taken from the camera up (Matrix4.lookat is unsuitable here — it
        // keeps the raw up vector, so the result shears unless up happens to
        // be perpendicular to the view ray, and decompose() then returns a
        // garbage euler).
        z.normalize()
        let up = new Vector3(cam.up).normalize()
        if (Math.abs(up.dot(z)) > 0.99) {
          up = Math.abs(z[2]) < 0.9 ? new Vector3([0, 0, 1]) : new Vector3([0, 1, 0])
        }
        const x = new Vector3(up).cross(z).normalize()
        const y = new Vector3(z).cross(x)

        const mat = new Matrix4()
        const m = mat.$matrix
        m.m11 = x[0]
        m.m12 = x[1]
        m.m13 = x[2]
        m.m21 = y[0]
        m.m22 = y[1]
        m.m23 = y[2]
        m.m31 = z[0]
        m.m32 = z[1]
        m.m33 = z[2]

        const dloc = new Vector3()
        const drot = new Vector3()
        const dscale = new Vector3()
        mat.decompose(dloc, drot, dscale)
        ob.inputs.rot.setValue(drot)
      }
    }

    ob.update()
  }

  // Lightweight undo: track + remove the created object/mesh/material. The
  // default ToolOp undo does a full async loadUndoFile, but ToolStack.rerun()
  // re-execs synchronously right after undo() — before that async reload
  // settles — so the re-exec wrote into a stale context and the mesh vanished
  // (ImmediateTODOs #10). A synchronous remove/re-create avoids the reload.
  undoPre(ctx: ToolContext): void {
    this._prevActiveSelected = Boolean((ctx.scene?.objects?.active?.flag ?? 0) & ObjectFlags.SELECT)
    this._prevActiveId = ctx.scene?.objects?.active?.lib_id ?? -1
  }
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const wasm = getWasmImmediate()!
    const wasmMesh = this.makeWasmMesh(wasm)

    const litemesh = new LiteMesh(wasmMesh)
    const ob = new SceneObject(litemesh)
    const mat = makeDefaultMaterial()

    ctx.datalib.add(mat)
    ctx.datalib.add(litemesh)
    ctx.datalib.add(ob)

    mat.lib_addUser(litemesh)
    litemesh.materials.push(mat)

    ctx.scene.add(ob)
    this.placeAtCursor(ctx, ob)
    ctx.scene.objects.clearSelection()
    ctx.scene.objects.setSelect(ob, true)
    ctx.scene.objects.setActive(ob)

    this.outputs.newObjectId.setValue(ob.lib_id)
    window.redraw_viewport(true)
  }

  execPost(ctx: ToolContext) {
    // note: ctx is locked prior to run, so
    // ctx.object is now stale (we updated it in exec)
    return super.execPost(ctx, ctx.datalib.get(this.outputs.newObjectId.getValue()))
  }

  undo(ctx: ToolContext) {
    const ob = ctx.datalib.get(this.outputs.newObjectId.getValue()) as SceneObject
    if (ob && ctx.scene.objects.includes(ob)) {
      const mat = ob.data.materials[0]

      ctx.scene.objects.setSelect(ob, false)
      ctx.scene.remove(ob)
      const data = ob.data
      if (ob.lib_users <= 0) {
        ctx.datalib.remove(ob) // calls ob.destroy()
      }
      if (data && data.lib_users <= 0) {
        ctx.datalib.remove(data)
      }
      if (mat && mat.lib_users <= 0) {
        ctx.datalib.remove(mat)
      }
    }

    // Restore the prior active/selection so the viewport reflects the undone state.
    const prev = ctx.datalib.get(this._prevActiveId ?? -1) as SceneObject | undefined
    ctx.scene.objects.setActive(prev)
    if (prev && this._prevActiveSelected) {
      ctx.scene.objects.setSelect(prev, true)
    }
  }
}

export class AddLiteMeshCubeOp extends AddLiteMeshShapeOp<{
  sphere: FloatProperty
  goalFaces: IntProperty
  size: FloatProperty
}> {
  static tooldef() {
    return {
      toolpath: 'litemesh.add_cube',
      uiname  : 'Add Cube (SculptCore)',
      inputs: {
        sphere   : new FloatProperty(0.0).setRange(0.0, 1.0).noUnits(),
        goalFaces: new IntProperty(0).setRange(0, 1024 * 1024 * 6).noUnits(),
        size     : new FloatProperty(1.0),
      },
      outputs: {
        newObjectId: new IntProperty(-1).noUnits().private(),
      },
    }
  }

  protected makeWasmMesh(wasm: IWasmInterface): WasmMesh {
    const {sphere, size, goalFaces} = this.getInputs()
    return wasm.Mesh_createCube(goalFacesToDimen(goalFaces), size, sphere)
  }
}

/**
 * A cube face is a `dimen x dimen` vertex grid, so the mesh has
 * `6 * (dimen - 1)**2` faces. Invert that, picking the `dimen` whose face
 * count is closest to `goalFaces`; a goal of 0 (or less) yields a simple
 * 6-face cube (`dimen === 2`).
 */
function goalFacesToDimen(goalFaces: number): number {
  if (goalFaces <= 6) {
    return 2
  }
  return Math.max(2, Math.round(Math.sqrt(goalFaces / 6)) + 1)
}

export class AddLiteMeshPlaneOp extends AddLiteMeshShapeOp<{size: FloatProperty}> {
  static tooldef() {
    return {
      toolpath: 'litemesh.add_plane',
      uiname  : 'Add Plane (SculptCore)',
      inputs: {
        size: new FloatProperty(1.0),
      },
      outputs: {
        newObjectId: new IntProperty(-1).noUnits().private(),
      },
    }
  }

  protected makeWasmMesh(wasm: IWasmInterface): WasmMesh {
    const {size} = this.getInputs()
    // 2x2 verts -> a single 1x1 quad facing +Z.
    return wasm.Mesh_makeGrid(2, 2, size)
  }
}

/** Shared mesh lookup for the attribute ToolOps. */
class LiteMeshAttrOp<Inputs extends PropertySlots = {}, Outputs extends PropertySlots = {}> extends LiteMeshOp<
  Inputs,
  Outputs
> {
  _getMesh(ctx: ToolContext): LiteMesh | undefined {
    const data = ctx.scene?.objects?.active?.data
    return data instanceof LiteMesh ? data : undefined
  }
}

/**
 * Add a new attribute layer (domain/type/use ints; see LiteMesh AttrDomain /
 * AttrType / AttrUseFlags). Undo removes the freshly-created layer by name (it
 * has no data worth preserving — any paint into it is a later, separately-undone
 * op). `_name` is captured at exec for the by-name remove on undo / redo.
 *
 * Note: unlike RemoveAttrOp / GenerateUVOp (which detach/reattach the *same*
 * layer via the C++ stash), redo here re-runs exec and mints a *fresh* layer —
 * `_name` is re-captured each time. That's fine because a just-added layer has
 * no data to preserve, but it does mean a redo can pick a different unique name
 * (`.NNN`) than the original add if the namespace changed in between.
 */
export class AddAttrOp extends LiteMeshAttrOp<{
  domain: IntProperty
  type: IntProperty
  use: IntProperty
}> {
  _name = ''

  static tooldef() {
    return {
      toolpath: 'litemesh.add_attr',
      uiname  : 'Add Attribute',
      inputs: {
        domain: new IntProperty(1),
        type  : new IntProperty(8),
        use   : new IntProperty(0),
      },
    }
  }

  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    const {domain, type, use} = this.getInputs()
    mesh.addAttr(domain, type, use)
    this._name = mesh._selectedAttr?.attrName ?? ''
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && this._name) {
      mesh.removeAttrByName(this.getInputs().domain, this._name)
      window.redraw_all?.()
    }
  }
}

/**
 * Remove the LiteMesh's currently-selected attribute layer (builtins refused in
 * C++). Detaches the layer into the C++ stash (data preserved, no serialize) so
 * undo restores it intact. The target (domain + name) is captured on the first
 * undoPre so redo re-detaches the same layer regardless of selection state.
 */
export class RemoveAttrOp extends LiteMeshAttrOp {
  _domain = -1
  _name = ''
  _stashId = -1

  static tooldef() {
    return {
      toolpath: 'litemesh.remove_attr',
      uiname  : 'Remove Attribute',
      inputs  : {},
    }
  }

  undoPre(ctx: ToolContext): void {
    if (this._name === '') {
      const sel = this._getMesh(ctx)?._selectedAttr
      if (sel) {
        this._domain = sel.domain
        this._name = sel.attrName
      }
    }
  }
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh || this._name === '') {
      return
    }
    this._stashId = mesh.detachAttrLayer(this._domain, this._name)
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && this._stashId >= 0) {
      mesh.reattachAttrLayer(this._stashId)
      window.redraw_all?.()
    }
  }
}

/**
 * Base for the sculpt-layer ToolOps (displacementAndSubSurf.md V5): shared
 * flag gate + layer resolution. `layer` is the engine settings index; -1
 * resolves to the mesh's active sculpt layer at undoPre time (stored on
 * `_layer` so redo targets the same layer regardless of selection churn).
 */
abstract class SculptLayerOpBase<Inputs extends PropertySlots = {}> extends LiteMeshAttrOp<Inputs> {
  _layer = -1

  static canRun(_ctx: ToolContext): boolean {
    return FeatureFlags.get('sculptcore.sculpt_layers')
  }

  _resolveLayer(ctx: ToolContext): LiteMesh | undefined {
    const mesh = this._getMesh(ctx)
    if (!mesh) return undefined
    if (this._layer < 0) {
      const li = (this.inputs as unknown as {layer?: IntProperty}).layer?.getValue() ?? -1
      this._layer = li >= 0 ? li : mesh.activeSculptLayer
    }
    return this._layer >= 0 && this._layer < mesh.mesh.sculptLayerCount() ? mesh : undefined
  }

  /** Refresh node bounds + GPU buffers after a compositor co adjustment
   * (settings mutators move verts without flagging spatial nodes). */
  _refresh(mesh: LiteMesh): void {
    mesh.recalcNormals()
    mesh.rebuildSpatialFromEdit()
    window.redraw_all?.()
  }

  /** Post-mutation refresh that respects the layer-routing split (M3): the
   * multires branch already re-attached fresh level views inside the LiteMesh
   * layer helpers, so only a redraw is needed there. */
  _refreshAfterLayer(mesh: LiteMesh): void {
    if (mesh.multiresActive) {
      window.redraw_all?.()
    } else {
      this._refresh(mesh)
    }
  }
}

/**
 * Add a sculpt layer (engine-named `slayer.NNN`, zero-filled) and make it
 * active. A fresh layer has no data, so undo removes it outright via the
 * displace mutator (mirrors AddAttrOp; redo mints a fresh layer).
 */
export class SculptLayerAddOp extends SculptLayerOpBase {
  static tooldef() {
    return {
      toolpath: 'litemesh.sculpt_layer_add',
      uiname  : 'Add Sculpt Layer',
      inputs  : {},
    }
  }

  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) return
    this._layer = mesh.layerAdd()
    mesh.activeSculptLayer = this._layer
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && this._layer >= 0) {
      mesh.layerRemove(this._layer)
      window.redraw_all?.()
    }
  }
}

/**
 * Remove a sculpt layer (default: the active one). The engine subtracts the
 * layer's contribution and drops its settings row + delta column — destructive,
 * so undo restores the whole-mesh serialize blob (the symmetrize/quad-remesh
 * pattern), which brings the layer's painted data back intact.
 */
export class SculptLayerRemoveOp extends SculptLayerOpBase<{layer: IntProperty}> {
  _undoBlob?: Uint8Array
  /** Multires undo seam: the layer channels live in the grids store, so the
   * snapshot is {store blob + layer settings table + level} instead of a
   * whole-mesh blob (which would tear down the attached stack). */
  _storeBlob?: Uint8Array
  _layerTable?: unknown
  _level = 0

  static tooldef() {
    return {
      toolpath: 'litemesh.sculpt_layer_remove',
      uiname  : 'Remove Sculpt Layer',
      inputs  : {layer: new IntProperty(-1).noUnits()},
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._resolveLayer(ctx)
    if (mesh?.multiresActive) {
      // Fold pending level edits first so the blob holds the current state.
      mesh.layerFold()
      this._storeBlob = mesh.multiresStoreBlob()
      this._layerTable = mesh.multiresLayerTableCapture()
      this._level = mesh.multiresLevel
      this._undoBlob = undefined
    } else {
      this._undoBlob = mesh ? mesh.serialize() : undefined
    }
  }
  calcUndoMem(): number {
    return (this._undoBlob?.length ?? 0) + (this._storeBlob?.length ?? 0)
  }

  exec(ctx: ToolContext) {
    const mesh = this._resolveLayer(ctx)
    if (!mesh) return
    const wasEnabled = mesh.layerEnabled(this._layer)
    mesh.layerRemove(this._layer)
    if (wasEnabled) {
      this._refreshAfterLayer(mesh)
    } else {
      window.redraw_all?.()
    }
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (!mesh) return
    if (mesh.multiresActive && this._storeBlob) {
      mesh.multiresRestoreStoreBlob(this._storeBlob, this._level)
      mesh.multiresLayerTableRestore(this._layerTable)
      window.redraw_all?.()
    } else if (this._undoBlob) {
      mesh._replaceMesh(getWasmImmediate()!.Mesh_deserialize(this._undoBlob))
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }
}

/**
 * Set a sculpt layer's weight through the displace mutator (which keeps
 * evaluated v.co current). Undo re-applies the previous weight via the same
 * mutator (self-inverse up to fp rounding). The panel's slider commits through
 * `execOrRedo`, so a drag collapses to a single op on the stack.
 */
export class SculptLayerSetWeightOp extends SculptLayerOpBase<{layer: IntProperty; weight: FloatProperty}> {
  _prev = 0

  static tooldef() {
    return {
      toolpath: 'litemesh.sculpt_layer_set_weight',
      uiname  : 'Sculpt Layer Weight',
      inputs: {
        layer : new IntProperty(-1).noUnits(),
        weight: new FloatProperty(1.0).setRange(-2, 2).noUnits(),
      },
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._resolveLayer(ctx)
    this._prev = mesh ? mesh.layerWeight(this._layer) : 0
  }
  calcUndoMem(): number {
    return 0
  }

  _apply(ctx: ToolContext, weight: number): void {
    const mesh = this._resolveLayer(ctx)
    if (!mesh) return
    mesh.layerSetWeight(this._layer, weight)
    // A disabled layer contributes nothing, so co (and the tree) are untouched.
    if (mesh.layerEnabled(this._layer)) {
      this._refreshAfterLayer(mesh)
    }
  }

  exec(ctx: ToolContext) {
    this._apply(ctx, this.getInputs().weight)
  }
  undo(ctx: ToolContext): void {
    this._apply(ctx, this._prev)
  }
}

/**
 * Toggle a sculpt layer's enabled / frozen bit (kind selects which). Enabled
 * adds/subtracts the layer's contribution (tree refresh); frozen only gates
 * brush writes (no geometry change). Undo re-applies the previous bit.
 */
export class SculptLayerSetFlagOp extends SculptLayerOpBase<{
  layer: IntProperty
  kind: EnumProperty
  value: BoolProperty
}> {
  _prev = false

  static tooldef() {
    return {
      toolpath: 'litemesh.sculpt_layer_set_flag',
      uiname  : 'Sculpt Layer State',
      inputs: {
        layer: new IntProperty(-1).noUnits(),
        kind : new EnumProperty(0, {ENABLED: 0, FROZEN: 1}),
        value: new BoolProperty(true),
      },
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._resolveLayer(ctx)
    const frozen = this.getInputs().kind === 1
    this._prev = mesh ? (frozen ? mesh.layerFrozen(this._layer) : mesh.layerEnabled(this._layer)) : false
  }
  calcUndoMem(): number {
    return 0
  }

  _apply(ctx: ToolContext, value: boolean): void {
    const mesh = this._resolveLayer(ctx)
    if (!mesh) return
    if (this.getInputs().kind === 1) {
      mesh.layerSetFrozen(this._layer, value)
      window.redraw_all?.()
    } else {
      mesh.layerSetEnabled(this._layer, value)
      this._refreshAfterLayer(mesh)
    }
  }

  exec(ctx: ToolContext) {
    this._apply(ctx, this.getInputs().value)
  }
  undo(ctx: ToolContext): void {
    this._apply(ctx, this._prev)
  }
}

/**
 * Make a sculpt layer the edit target (sculptLayersV2), or clear it with
 * layer=-1. While targeted, every brush/dyntopo/GPU stroke edits the layer by
 * construction (the delta is derived from co); the engine enables the layer
 * and pins its weight to 1 on activation. Undo replays setActiveEditLayer with
 * the previous target — folds are semantically no-ops, so no column snapshot
 * is needed — then restores the pinned layer's previous weight/enabled state.
 */
export class SculptLayerSetTargetOp extends SculptLayerOpBase<{layer: IntProperty}> {
  _prevTarget = -1
  _prevWeight = 1
  _prevEnabled = true

  static tooldef() {
    return {
      toolpath: 'litemesh.sculpt_layer_set_target',
      uiname  : 'Sculpt Layer Edit Target',
      inputs  : {layer: new IntProperty(-1).noUnits()},
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    this._layer = this.getInputs().layer
    if (!mesh) return
    this._prevTarget = mesh.layerEditTarget()
    if (this._layer >= 0) {
      this._prevWeight = mesh.layerWeight(this._layer)
      this._prevEnabled = mesh.layerEnabled(this._layer)
    }
  }
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) return
    mesh.layerSetTarget(this._layer)
    // Activation can move co (enable fold-in + the weight-1 pin); a plain
    // fold/deactivation cannot.
    if (this._layer >= 0 && (this._prevWeight !== 1 || !this._prevEnabled)) {
      this._refreshAfterLayer(mesh)
    } else {
      window.redraw_all?.()
    }
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (!mesh) return
    mesh.layerSetTarget(this._prevTarget)
    if (this._layer >= 0 && this._layer !== this._prevTarget) {
      mesh.layerSetWeight(this._layer, this._prevWeight)
      mesh.layerSetEnabled(this._layer, this._prevEnabled)
    }
    if (this._layer >= 0 && (this._prevWeight !== 1 || !this._prevEnabled)) {
      this._refreshAfterLayer(mesh)
    } else {
      window.redraw_all?.()
    }
  }
}

/** Feature-flag gate shared by the multires ops (displacementAndSubSurf S). */
abstract class MultiresOpBase<Inputs extends PropertySlots = {}> extends LiteMeshAttrOp<Inputs> {
  static canRun(_ctx: ToolContext): boolean {
    return FeatureFlags.get('sculptcore.multires')
  }
}

/**
 * Enable multires on the active LiteMesh: refine it into a `levels`-deep
 * Catmull-Clark stack (the mesh parks as the untouched cage) and attach the
 * finest level. Enable never mutates the cage geometry, so undo normally
 * just tears the stack down — EXCEPT when vertex-column sculpt layers exist:
 * those are flattened (baked + dropped, V2 — they don't convert to level
 * channels), so a serialize blob is snapshotted and restored on undo.
 */
export class MultiresEnableOp extends MultiresOpBase<{levels: IntProperty}> {
  _flattenBlob?: Uint8Array

  static tooldef() {
    return {
      toolpath: 'litemesh.multires_enable',
      uiname  : 'Enable Multires',
      inputs  : {levels: new IntProperty(2).setRange(1, 7).noUnits()},
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    this._flattenBlob = mesh && !mesh.multiresActive && mesh.mesh.sculptLayerCount() > 0 ? mesh.serialize() : undefined
  }
  calcUndoMem(): number {
    return this._flattenBlob?.length ?? 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh || mesh.multiresActive) return
    mesh.multiresEnable(this.getInputs().levels)
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh?.multiresActive) {
      mesh.multiresDelete()
      if (this._flattenBlob) {
        // Restore the pre-flatten layer stack (columns + settings rows).
        mesh._replaceMesh(getWasmImmediate()!.Mesh_deserialize(this._flattenBlob))
      }
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }
}

/**
 * Switch the active multires edit level. The engine writes the outgoing level
 * back into the grids store first, so the switch is lossless (S3 gate) and
 * undo is simply switching back.
 */
export class MultiresSetLevelOp extends MultiresOpBase<{level: IntProperty}> {
  _prev = 0

  static tooldef() {
    return {
      toolpath: 'litemesh.multires_set_level',
      uiname  : 'Multires Level',
      inputs  : {level: new IntProperty(1).setRange(1, 16).noUnits()},
    }
  }

  undoPre(ctx: ToolContext): void {
    this._prev = this._getMesh(ctx)?.multiresLevel ?? 0
  }
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh?.multiresActive) return
    mesh.multiresSetLevel(this.getInputs().level)
    mesh.regenBounds()
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh?.multiresActive && this._prev >= 1) {
      mesh.multiresSetLevel(this._prev)
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }
}

/**
 * Least-squares-refit the level below the active one to the active surface
 * (the active surface is preserved; see Multires::downRefit). Rewrites the
 * grids store wholesale, so undo restores a store-blob snapshot.
 */
export class MultiresDownRefitOp extends MultiresOpBase {
  _undoBlob?: Uint8Array
  _level = 0

  static tooldef() {
    return {
      toolpath: 'litemesh.multires_down_refit',
      uiname  : 'Refit Level Below',
      inputs  : {},
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    this._level = mesh?.multiresLevel ?? 0
    this._undoBlob = mesh?.multiresActive && this._level >= 2 ? mesh.multiresStoreBlob() : undefined
  }
  calcUndoMem(): number {
    return this._undoBlob?.length ?? 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh?.multiresActive || mesh.multiresLevel < 2) {
      this._undoBlob = undefined
      return
    }
    if (mesh.multiresDownRefit() === 0) {
      this._undoBlob = undefined // nothing moved — keep the op a no-op
    }
    mesh.regenBounds()
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh?.multiresActive && this._undoBlob) {
      mesh.multiresRestoreStoreBlob(this._undoBlob, this._level)
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }
}

/**
 * Append one finer multires level (a smooth Catmull-Clark subdivision of the
 * current finest surface) to the active stack, preserving all existing detail
 * and attaching the new finest level. Undo pops the freshly-added level —
 * exact, because a newly added level carries zero displacement. Refused while a
 * VDM store is attached: its Ptex texels are bound to the current finest-grid
 * resolution, so growing the stack would desync them (delete VDM first).
 */
export class MultiresAddLevelOp extends MultiresOpBase {
  _added = false

  static tooldef() {
    return {
      toolpath: 'litemesh.multires_add_level',
      uiname  : 'Add Multires Level',
      inputs  : {},
    }
  }

  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    this._added = false
    if (!mesh?.multiresActive || mesh.hasVdm) {
      return
    }
    const before = mesh.multiresLevels
    this._added = mesh.multiresAddLevel() > before
    mesh.regenBounds()
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh?.multiresActive && this._added) {
      mesh.multiresRemoveTopLevel()
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }
}

/**
 * Delete the multires stack, re-adopting the untouched cage as a plain mesh.
 * The levels' displacement lives in the grids store, so undo rebuilds the
 * stack from the cage and restores a store-blob snapshot (topology-compatible
 * by construction — same cage, same refinement).
 */
export class MultiresDeleteOp extends MultiresOpBase {
  _undoBlob?: Uint8Array
  _levels = 0
  _level = 0

  static tooldef() {
    return {
      toolpath: 'litemesh.multires_delete',
      uiname  : 'Delete Multires',
      inputs  : {},
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    this._levels = mesh?.multiresLevels ?? 0
    this._level = mesh?.multiresLevel ?? 0
    this._undoBlob = mesh?.multiresActive ? mesh.multiresStoreBlob() : undefined
  }
  calcUndoMem(): number {
    return this._undoBlob?.length ?? 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh?.multiresActive) {
      this._undoBlob = undefined
      return
    }
    mesh.multiresDelete()
    mesh.regenBounds()
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (!mesh || mesh.multiresActive || !this._undoBlob) return
    if (mesh.multiresEnable(this._levels, this._level)) {
      mesh.multiresRestoreStoreBlob(this._undoBlob, this._level)
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }
}

/** Feature-flag gate for the VDM sculpting lifecycle ops (X3 stage 4). */
abstract class VdmOpBase<Inputs extends PropertySlots = {}> extends LiteMeshAttrOp<Inputs> {
  static canRun(_ctx: ToolContext): boolean {
    return FeatureFlags.get('sculptcore.vdm_sculpt')
  }
}

/**
 * Attach a VDM store to the active LiteMesh (Ptex-configured from the
 * multires stack when one is attached, else the UV-atlas backend over an
 * existing unwrap). With a store attached, Draw dabs splat texels instead of
 * moving vertices. Undo RELEASES the store instance rather than freeing it:
 * stroke history holds non-owning VdmLogChunk pointers into it, so the same
 * instance must come back on redo.
 */
export class VdmEnableOp extends VdmOpBase {
  _store?: VdmStore

  static tooldef() {
    return {
      toolpath: 'litemesh.vdm_enable',
      uiname  : 'Enable VDM',
      inputs  : {},
    }
  }

  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh || mesh.hasVdm) return
    if (this._store) {
      // Redo: re-attach the SAME instance the undo released.
      mesh.vdmReattach(this._store)
      this._store = undefined
    } else if (!mesh.vdmEnable()) {
      ;(ctx as unknown as {error?: (msg: string) => void}).error?.('VDM needs a multires stack or a UV unwrap')
      return
    }
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh?.hasVdm) {
      this._store = mesh.releaseVdmStore()
      window.redraw_all?.()
    }
  }
}

/**
 * Detach the active LiteMesh's VDM store. The instance is released, not
 * freed (see VdmEnableOp), so undo re-attaches it with every texel — and
 * every stroke-history chunk that references it — intact.
 */
export class VdmDeleteOp extends VdmOpBase {
  _store?: VdmStore

  static tooldef() {
    return {
      toolpath: 'litemesh.vdm_delete',
      uiname  : 'Delete VDM',
      inputs  : {},
    }
  }

  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh?.hasVdm) return
    this._store = mesh.releaseVdmStore()
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && !mesh.hasVdm && this._store) {
      mesh.vdmReattach(this._store)
      this._store = undefined
      window.redraw_all?.()
    }
  }
}

/**
 * VDM -> geometry extraction (X4): bake the store's displacement field into
 * the vertices (each vert displaced by its own texel sample through the F3
 * frame — exactly what the render tiers show) and clear the texels. On a
 * multires level mesh the result is folded into the grids store
 * (`multiresWriteback`), so undo restores the multires-store blob; on a
 * plain mesh undo restores a whole-mesh blob (the quad-remesh pattern).
 * The VDM store contents restore from their own blob either way.
 */
export class VdmApplyOp extends VdmOpBase {
  _meshBlob?: Uint8Array
  _mrBlob?: Uint8Array
  _storeBlob?: Uint8Array
  _level = 0

  static tooldef() {
    return {
      toolpath: 'litemesh.vdm_apply',
      uiname  : 'Apply VDM to Mesh',
      inputs  : {},
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    const wasm = getWasmImmediate()!
    this._meshBlob = undefined
    this._mrBlob = undefined
    this._storeBlob = undefined
    if (!mesh?.hasVdm) return
    this._storeBlob = wasm.VdmStore_serializeBlob(mesh.vdmStore!)
    if (mesh.multiresActive) {
      this._level = mesh.multiresLevel
      this._mrBlob = mesh.multiresStoreBlob()
    } else {
      this._meshBlob = wasm.Mesh_serialize(mesh.mesh)
    }
  }
  calcUndoMem(): number {
    return (this._meshBlob?.length ?? 0) + (this._mrBlob?.length ?? 0) + (this._storeBlob?.length ?? 0)
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh?.hasVdm) return
    const wasm = getWasmImmediate()!
    const moved = wasm.Mesh_vdmApplyToVerts(mesh.mesh, mesh.vdmStore!, 1)
    if (moved > 0) {
      if (mesh.multiresActive) {
        mesh.multiresWriteback()
      }
      mesh.rebuildSpatialFromEdit()
      mesh.regenBounds()
    }
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (!mesh) return
    const wasm = getWasmImmediate()!
    if (this._mrBlob) {
      mesh.multiresRestoreStoreBlob(this._mrBlob, this._level)
    } else if (this._meshBlob) {
      mesh._replaceMesh(wasm.Mesh_deserialize(this._meshBlob))
    }
    if (this._storeBlob && mesh.hasVdm) {
      // Refill the SAME instance in place — stroke-history VdmLogChunks hold
      // non-owning pointers into it, so it must never be freed + replaced.
      wasm.VdmStore_restoreFromBlob(mesh.vdmStore!, this._storeBlob)
    }
    mesh.regenBounds()
    window.redraw_all?.()
  }
}

/**
 * Geometry -> VDM capture (X4, the apply's inverse; multires only): move the
 * active level's grids-store displacement into the Ptex VDM texels (added in
 * the same smoothed-base frame space) and drop the surface onto the smooth
 * base. Undo restores the multires-store blob + refills the VDM store in
 * place.
 */
export class VdmCaptureOp extends VdmOpBase {
  _mrBlob?: Uint8Array
  _storeBlob?: Uint8Array
  _level = 0

  static tooldef() {
    return {
      toolpath: 'litemesh.vdm_capture',
      uiname  : 'Capture to VDM',
      inputs  : {},
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    const wasm = getWasmImmediate()!
    this._mrBlob = undefined
    this._storeBlob = undefined
    if (!mesh?.hasVdm || !mesh.multiresActive || !mesh.vdmIsPtex) return
    this._level = mesh.multiresLevel
    this._mrBlob = mesh.multiresStoreBlob()
    this._storeBlob = wasm.VdmStore_serializeBlob(mesh.vdmStore!)
  }
  calcUndoMem(): number {
    return (this._mrBlob?.length ?? 0) + (this._storeBlob?.length ?? 0)
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh?.hasVdm || !mesh.multiresActive || !mesh.vdmIsPtex || !mesh._multires) return
    const wasm = getWasmImmediate()!
    const texels = wasm.Multires_captureToVdm(mesh._multires, mesh.vdmStore!, mesh.multiresLevel)
    if (texels > 0) {
      mesh.rebuildSpatialFromEdit()
      mesh.regenBounds()
    }
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (!mesh) return
    const wasm = getWasmImmediate()!
    if (this._mrBlob) {
      mesh.multiresRestoreStoreBlob(this._mrBlob, this._level)
    }
    if (this._storeBlob && mesh.hasVdm) {
      wasm.VdmStore_restoreFromBlob(mesh.vdmStore!, this._storeBlob)
    }
    mesh.regenBounds()
    window.redraw_all?.()
  }
}

/**
 * Wave 5: mark the shortest edge-path between two vertices as a seam
 * (EDGE_SEAM). Takes the path endpoints as vert indices; the C++ `markSeamPath`
 * runs Dijkstra + flags the path edges + recomputes derived boundary state, and
 * `edgePathCoords` gives the path for a viewport overlay. Undo restores each
 * path edge's *prior* seam bit (snapshotted at exec), so it doesn't clear seams
 * that pre-existed on edges this path happens to overlap.
 */
export class MarkSeamOp extends LiteMeshAttrOp<{
  vStart: IntProperty
  vEnd: IntProperty
}> {
  /** Path edges + their seam bit before this op, captured at exec for a
   * true-inverse undo (parallel arrays). */
  _priorEdges: number[] = []
  _priorStates: number[] = []

  static tooldef() {
    return {
      toolpath: 'litemesh.mark_seam',
      uiname  : 'Mark Seam Path',
      inputs: {
        vStart: new IntProperty(-1),
        vEnd  : new IntProperty(-1),
      },
    }
  }

  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    const {vStart, vEnd} = this.getInputs()
    if (vStart < 0 || vEnd < 0) {
      return
    }
    // Snapshot the path edges' prior seam state before marking (so undo/redo are
    // exact inverses; the path is deterministic so re-capture on redo matches).
    this._priorEdges = mesh.edgePathEdges(vStart, vEnd)
    this._priorStates = this._priorEdges.map((e) => mesh.edgeSeam(e))
    const n = mesh.markSeamPath(vStart, vEnd, 1)
    if (n > 0) {
      this._drawPath(ctx, mesh, vStart, vEnd)
    }
    window.redraw_all?.()
  }

  undo(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    mesh.restoreSeamEdges(this._priorEdges, this._priorStates)
    const v3d = (ctx as unknown as {view3d?: {resetDrawLines?: () => void}}).view3d
    v3d?.resetDrawLines?.()
    window.redraw_all?.()
  }

  /** Draw the marked path as orange overlay lines (view3d.makeDrawLine). */
  _drawPath(ctx: ToolContext, mesh: LiteMesh, v0: number, v1: number) {
    const v3d = (
      ctx as unknown as {
        view3d?: {makeDrawLine(a: Vector3, b: Vector3, c: number[]): unknown}
      }
    ).view3d
    if (!v3d) {
      return
    }
    const c = mesh.edgePathCoords(v0, v1)
    for (let i = 0; i + 5 < c.length; i += 3) {
      const a = new Vector3([c[i], c[i + 1], c[i + 2]])
      const b = new Vector3([c[i + 3], c[i + 4], c[i + 5]])
      v3d.makeDrawLine(a, b, [1.0, 0.4, 0.0, 1.0])
    }
  }
}

/* Minimal structural views of the View3D/SceneObject bits the modal needs, so we
 * don't pull the whole View3D type into the lite-mesh layer. */
interface MarkPathView3D {
  getLocalMouse(x: number, y: number): {0: number; 1: number}
  activeCamera: {rendermat: Matrix4; pos: Vector3}
  unproject(p: Vector4, mat: Matrix4): void
  project(co: Vector3): number
  getViewVec(localX: number, localY: number): Vector3
  makeDrawLine(a: Vector3, b: Vector3, color: number[]): unknown
  resetDrawLines(): void
}
interface MarkPathCtx {
  view3d?: MarkPathView3D
  object?: {outputs: {matrix: {getValue(): Matrix4}}}
  scene?: {objects?: {active?: {data?: unknown}}}
}

/** Snap radius (px) for connecting the path to an existing feature vertex, and
 * the segment count of the snap-indicator ring drawn at the cursor. */
const SNAP_PX = 10
const RING_SEG = 16

/**
 * Wave 5: interactive chain (knife-style) feature-edge marking. Modal base class
 * — click vertices in sequence; each click marks the shortest-path feature edge
 * (of `_kind()`: seam or sharp) from the previous vertex (live), with a hover
 * preview of the next segment. Enter or right-click finishes (a single undo step
 * for the whole chain); Esc cancels. During preview the endpoint snaps to an
 * existing feature vertex of the same kind within {@link SNAP_PX}, drawing a ring
 * at the cursor while a snap is active.
 *
 * Vertex picking, path-finding and flag-writing are all engine-side
 * (`pickVert` / `markEdgePath` / `edgePathCoords` / `featureVerts`); this op is
 * just the interaction shell + overlay. The concrete seam / sharp subclasses only
 * supply `_kind()` and the overlay colors. Invoke without a pointer event
 * (keymap/button) so the modal receives pointer move/down events, not only key
 * events.
 */
export abstract class MarkEdgePathBaseOp extends LiteMeshAttrOp {
  /** Committed picked verts (the confirmed chain nodes). */
  _chain: number[] = []
  /** Cached world-space endpoint pairs for the committed segments (so a
   * mousemove redraw doesn't recompute every path). */
  _committed: [Vector3, Vector3][] = []
  _hoverVert = -1
  _hoverLines: [Vector3, Vector3][] = []
  /** Snap-indicator ring (world-space line pairs), non-empty while snapping. */
  _snapRing: [Vector3, Vector3][] = []
  /** Cached feature-vert indices + object-local coords for snapping, refreshed on
   * start and after each click (when new edges may have been flagged). */
  _featIdx: number[] = []
  _featCo: number[] = []
  /** Prior feature bit of every edge the chain touched, recorded the first time
   * each edge is seen (before it's live-marked), so undo restores the exact
   * pre-chain state instead of clearing pre-existing overlapping features. */
  _priorByEdge: Map<number, number> = new Map()

  /** 0 = seam (EDGE_SEAM), 1 = sharp (EDGE_SHARP). */
  abstract _kind(): number
  /** RGBA for committed segments / the hover preview. */
  protected abstract _committedColor(): number[]
  protected abstract _hoverColor(): number[]

  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    return 0
  }

  modalStart(ctx: ViewContext) {
    this._chain = []
    this._committed = []
    this._hoverLines = []
    this._snapRing = []
    this._hoverVert = -1
    this._priorByEdge = new Map()
    this._refreshFeatureCache()
    return super.modalStart(ctx as never)
  }

  protected _mctx(): MarkPathCtx | undefined {
    return this.modal_ctx as unknown as MarkPathCtx | undefined
  }

  private _refreshFeatureCache(): void {
    const ctx = this._mctx()
    const mesh = ctx ? this._getMesh(ctx as unknown as ToolContext) : undefined
    if (!mesh) {
      this._featIdx = []
      this._featCo = []
      return
    }
    const {idx, co} = mesh.featureVerts(this._kind())
    this._featIdx = idx
    this._featCo = co
  }

  /** Build the object-local ray through screen pixel (lx, ly) — same unproject
   * the BVH picking path uses. */
  private _localRay(view3d: MarkPathView3D, obmatrix: Matrix4, lx: number, ly: number) {
    // clip→local = (rendermat∘obmat)^-1 (multiply applies its argument first).
    const imat = new Matrix4(view3d.activeCamera.rendermat)
    imat.multiply(obmatrix)
    imat.invert()
    const d = 0.9999
    const p1 = new Vector4([lx, ly, -d, 1.0])
    view3d.unproject(p1, imat)
    const origin = new Vector3(p1)
    const p2 = new Vector4([lx, ly, d, 1.0])
    view3d.unproject(p2, imat)
    const dir = new Vector3(p2).sub(origin)
    return {origin, dir}
  }

  /** edgePathCoords (object-local) → world-space endpoint pairs for drawing. */
  private _segmentLines(mesh: LiteMesh, obmatrix: Matrix4, a: number, b: number): [Vector3, Vector3][] {
    const c = mesh.edgePathCoords(a, b)
    const pts: Vector3[] = []
    for (let i = 0; i + 2 < c.length; i += 3) {
      const v = new Vector3([c[i], c[i + 1], c[i + 2]])
      v.multVecMatrix(obmatrix)
      pts.push(v)
    }
    const lines: [Vector3, Vector3][] = []
    for (let i = 0; i + 1 < pts.length; i++) {
      lines.push([pts[i], pts[i + 1]])
    }
    return lines
  }

  /** Project the cached feature verts to screen; if one lands within SNAP_PX of
   * the cursor, return its index + world position (object-space already applied).
   * Returns vert -1 when nothing snaps. */
  private _snapVert(
    view3d: MarkPathView3D,
    obmatrix: Matrix4,
    mx: number,
    my: number
  ): {vert: number; world?: Vector3} {
    let best = -1
    let bestD = SNAP_PX
    let bestWorld: Vector3 | undefined
    const tmp = new Vector3()
    for (let i = 0; i < this._featIdx.length; i++) {
      tmp[0] = this._featCo[i * 3]
      tmp[1] = this._featCo[i * 3 + 1]
      tmp[2] = this._featCo[i * 3 + 2]
      tmp.multVecMatrix(obmatrix)
      const world = new Vector3(tmp)
      const w = view3d.project(tmp) // tmp now holds pixel x/y
      if (w <= 0) continue // behind the camera
      const d = Math.hypot(tmp[0] - mx, tmp[1] - my)
      if (d < bestD) {
        bestD = d
        best = this._featIdx[i]
        bestWorld = world
      }
    }
    return {vert: best, world: bestWorld}
  }

  /** Billboarded SNAP_PX-radius ring (view-plane) at `world`, as line pairs. */
  private _snapRingLines(view3d: MarkPathView3D, world: Vector3, mx: number, my: number): [Vector3, Vector3][] {
    const cam = view3d.activeCamera
    const dir0 = new Vector3(view3d.getViewVec(mx, my))
    const right = new Vector3(view3d.getViewVec(mx + SNAP_PX, my)).sub(dir0)
    const up = new Vector3(view3d.getViewVec(mx, my + SNAP_PX)).sub(dir0)
    const dist = Math.hypot(world[0] - cam.pos[0], world[1] - cam.pos[1], world[2] - cam.pos[2])
    right.mulScalar(dist)
    up.mulScalar(dist)
    const pts: Vector3[] = []
    for (let k = 0; k < RING_SEG; k++) {
      const a = (2 * Math.PI * k) / RING_SEG
      const c = Math.cos(a)
      const s = Math.sin(a)
      pts.push(
        new Vector3([
          world[0] + c * right[0] + s * up[0],
          world[1] + c * right[1] + s * up[1],
          world[2] + c * right[2] + s * up[2],
        ])
      )
    }
    const lines: [Vector3, Vector3][] = []
    for (let k = 0; k < RING_SEG; k++) lines.push([pts[k], pts[(k + 1) % RING_SEG]])
    return lines
  }

  /** Ray-pick the vert under the cursor, then snap to a nearby feature vert if
   * one is within SNAP_PX. Returns the resolved vert plus the snap ring (empty if
   * no snap). */
  private _pick(e: PointerEvent): {vert: number; ring: [Vector3, Vector3][]} {
    const ctx = this._mctx()
    const mesh = ctx ? this._getMesh(ctx as unknown as ToolContext) : undefined
    if (!ctx?.view3d || !ctx.object || !mesh) {
      return {vert: -1, ring: []}
    }
    const m = ctx.view3d.getLocalMouse(e.x, e.y)
    const obmatrix = ctx.object.outputs.matrix.getValue()
    const {origin, dir} = this._localRay(ctx.view3d, obmatrix, m[0], m[1])
    const picked = mesh.pickVert(origin, dir)
    const snap = this._snapVert(ctx.view3d, obmatrix, m[0], m[1])
    if (snap.vert >= 0 && snap.world) {
      return {vert: snap.vert, ring: this._snapRingLines(ctx.view3d, snap.world, m[0], m[1])}
    }
    return {vert: picked, ring: []}
  }

  private _redraw() {
    const ctx = this._mctx()
    if (!ctx?.view3d) {
      return
    }
    const v3d = ctx.view3d
    v3d.resetDrawLines()
    for (const [a, b] of this._committed) {
      v3d.makeDrawLine(a, b, this._committedColor())
    }
    for (const [a, b] of this._hoverLines) {
      v3d.makeDrawLine(a, b, this._hoverColor())
    }
    for (const [a, b] of this._snapRing) {
      v3d.makeDrawLine(a, b, [1.0, 1.0, 1.0, 1.0])
    }
    window.redraw_viewport?.()
  }

  on_pointermove(e: PointerEvent): void {
    const {vert: v, ring} = this._pick(e)
    this._snapRing = ring
    this._hoverVert = v
    this._hoverLines = []
    const ctx = this._mctx()
    const mesh = ctx ? this._getMesh(ctx as unknown as ToolContext) : undefined
    const anchor = this._chain.length ? this._chain[this._chain.length - 1] : -1
    if (ctx?.object && mesh && anchor >= 0 && v >= 0 && v !== anchor) {
      this._hoverLines = this._segmentLines(mesh, ctx.object.outputs.matrix.getValue(), anchor, v)
    }
    this._redraw()
  }

  on_pointerdown(e: PointerEvent): void {
    if (e.button === 2) {
      this.modalEnd(false)
      return
    }
    if (e.button !== 0) {
      return
    }
    const {vert: v} = this._pick(e)
    if (v < 0) {
      return
    }
    const anchor = this._chain.length ? this._chain[this._chain.length - 1] : -1
    if (v === anchor) {
      return
    }
    const ctx = this._mctx()
    const mesh = ctx ? this._getMesh(ctx as unknown as ToolContext) : undefined
    const kind = this._kind()
    if (anchor >= 0 && ctx?.object && mesh) {
      // Snapshot each path edge's prior feature bit (first sighting only) before
      // marking live, so undo can restore the exact pre-chain state.
      for (const e of mesh.edgePathEdges(anchor, v)) {
        if (!this._priorByEdge.has(e)) this._priorByEdge.set(e, mesh.edgeFlagKind(e, kind))
      }
      // mark live for immediate feedback; exec() re-marks the whole chain on redo
      mesh.markEdgePath(anchor, v, kind, 1)
      this._committed.push(...this._segmentLines(mesh, ctx.object.outputs.matrix.getValue(), anchor, v))
    }
    this._chain.push(v)
    this._hoverLines = []
    this._hoverVert = -1
    this._snapRing = []
    this._refreshFeatureCache() // new feature verts are now snap targets
    this._redraw()
  }

  on_keydown(e: KeyboardEvent): void {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      this.modalEnd(false)
    } else if (e.code === 'Escape') {
      this.modalEnd(true)
    }
  }

  modalEnd(wasCancelled: boolean) {
    // Clear the transient preview lines on *both* paths: on finish the persistent
    // seamBatch (rebuilt by exec's markEdgePath) carries the committed features,
    // so the temp _committed/_hover/_snap lines would otherwise double-draw on top
    // until the next resetDrawLines.
    this._mctx()?.view3d?.resetDrawLines()
    return super.modalEnd(wasCancelled)
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    const kind = this._kind()
    for (let i = 0; i + 1 < this._chain.length; i++) {
      mesh.markEdgePath(this._chain[i], this._chain[i + 1], kind, 1)
    }
    window.redraw_all?.()
  }

  undo(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (mesh) {
      // Restore the snapshotted pre-chain feature bits (true inverse) rather than
      // blanket-clearing the chain, which would unset pre-existing features the
      // chain overlapped.
      const edges = [...this._priorByEdge.keys()]
      const states = edges.map((e) => this._priorByEdge.get(e) ?? 0)
      mesh.restoreEdgeFlags(edges, states, this._kind())
    }
    ;(ctx as unknown as {view3d?: {resetDrawLines?: () => void}}).view3d?.resetDrawLines?.()
    window.redraw_all?.()
  }
}

/** Interactive seam marking (EDGE_SEAM). Orange overlay. */
export class MarkSeamInteractiveOp extends MarkEdgePathBaseOp {
  static tooldef() {
    return {
      toolpath: 'litemesh.mark_seam_interactive',
      uiname  : 'Mark Seam',
      icon    : Icons.MARK_SEAM,
      inputs  : {},
      is_modal: true,
    }
  }

  _kind(): number {
    return 0
  }
  protected _committedColor(): number[] {
    return [1.0, 0.4, 0.0, 1.0]
  }
  protected _hoverColor(): number[] {
    return [1.0, 0.7, 0.2, 0.7]
  }
}

/** Interactive sharp-edge marking (EDGE_SHARP). Cyan overlay, matching the
 * feature overlay's sharp color. */
export class MarkSharpInteractiveOp extends MarkEdgePathBaseOp {
  static tooldef() {
    return {
      toolpath: 'litemesh.mark_sharp_interactive',
      uiname  : 'Mark Sharp',
      icon    : Icons.MARK_SHARP,
      inputs  : {},
      is_modal: true,
    }
  }

  _kind(): number {
    return 1
  }
  protected _committedColor(): number[] {
    return [0.0, 0.8, 1.0, 1.0]
  }
  protected _hoverColor(): number[] {
    return [0.4, 0.9, 1.0, 0.7]
  }
}

/**
 * Wave 7: generate a per-corner UV map from the marked seams (EDGE_SEAM). Calls
 * the engine unwrapper (`generateUVFromSeams`: flood-fill charts bounded by
 * seams → group-normal projection → shelf box-pack into [0,1]), which creates a
 * FLOAT2 corner layer tagged UV. Undo detaches that layer into the C++ stash
 * (data preserved); redo reattaches the same layer rather than regenerating.
 */
export class GenerateUVOp extends LiteMeshAttrOp<{
  margin: FloatProperty
}> {
  _name = ''
  _stashId = -1

  static tooldef() {
    return {
      toolpath: 'litemesh.generate_uv',
      uiname  : 'Generate UVs from Seams',
      inputs: {
        margin: new FloatProperty(0.01).setRange(0.0, 0.25).noUnits(),
      },
    }
  }

  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    return 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    if (this._stashId >= 0) {
      // redo after undo: restore the exact layer we detached
      mesh.reattachAttrLayer(this._stashId)
      this._stashId = -1
    } else {
      const {name} = mesh.generateUVFromSeams(this.getInputs().margin)
      this._name = name
    }
    window.redraw_all?.()
  }

  undo(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (mesh && this._name) {
      this._stashId = mesh.detachAttrLayer(AttrDomain.CORNER, this._name)
    }
    window.redraw_all?.()
  }
}

/**
 * Fan-triangulate every n-gon of the active LiteMesh and rebuild its spatial tree
 * cleanly (a balanced, all-triangle BVH — dyntopo is much faster on it; see the
 * "faster if triangulated" tip overlay). Whole-mesh topology change, so undo uses
 * a serialize snapshot of the pre-triangulate mesh (captured in undoPre only when
 * there is work to do); undo restores it via `_replaceMesh`, redo re-runs exec.
 */
export class TriangulateLiteMeshOp extends LiteMeshAttrOp {
  /** Pre-triangulate mesh blob, or undefined when the mesh was already all-tris. */
  _undoBlob?: Uint8Array

  static tooldef() {
    return {
      toolpath: 'litemesh.triangulate',
      uiname  : 'Triangulate',
      inputs  : {},
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    // Snapshot only when there's an n-gon to triangulate; an already-triangle
    // mesh makes exec a no-op, so undo has nothing to restore.
    this._undoBlob = mesh?.hasNgons() ? mesh.serialize() : undefined
  }
  calcUndoMem(): number {
    return this._undoBlob?.length ?? 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    mesh.triangulate()
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && this._undoBlob) {
      const wasm = getWasmImmediate()!
      mesh._replaceMesh(wasm.Mesh_deserialize(this._undoBlob))
      window.redraw_all?.()
    }
  }
}

/**
 * Reorder the active LiteMesh's elements for cache locality (depth-first BVH
 * order), making subsequent sculpting/dyntopo faster. The reorder is recorded as
 * a single step on the shared MeshLog undo stack (`SpatialTree::applyReorder` via
 * `MeshLog::reorderForLocality`), so undo/redo route through MeshLog — not a
 * serialize snapshot — keeping the TS toolstack and the C++ stack in sync exactly
 * like a sculpt stroke. `_logStepId` captures the pushed step for undo-mem
 * accounting.
 */
export class ReorderLocalityOp extends LiteMeshAttrOp {
  _logStepId = -1

  static tooldef() {
    return {
      toolpath   : 'litemesh.reorder_locality',
      uiname     : 'Optimize Mesh Layout',
      description: 'Reorder mesh elements for cache locality (faster sculpting)',
      inputs     : {},
    }
  }

  // The reorder records its own MeshLog step; there's no separate undo snapshot.
  undoPre(_ctx: ToolContext): void {}
  calcUndoMem(): number {
    const log = SculptPaintOp.meshLog
    return log && this._logStepId >= 0 ? log.stepMemSize(this._logStepId) : 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    const log = SculptPaintOp.ensureMeshLog()
    mesh.reorderForLocality(log)
    this._logStepId = log.lastStepId()
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && SculptPaintOp.meshLog) {
      SculptPaintOp.meshLog.undo(mesh.mesh, mesh.spatial)
      mesh.refreshAfterReorder()
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }

  redo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && SculptPaintOp.meshLog) {
      SculptPaintOp.meshLog.redo(mesh.mesh, mesh.spatial)
      mesh.refreshAfterReorder()
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }
}

/**
 * Make the active LiteMesh geometrically symmetric along a chosen axis set,
 * topology-preserving (positions only — no bisect/weld). For each enabled axis
 * the destination side's verts copy the mirrored position of their nearest
 * source-side counterpart; verts within `threshold` of a plane snap onto it.
 * Pairs with mirrored sculpt strokes (both reflect about the mesh's own local
 * axis planes). Undo snapshots the pre-symmetrize mesh (serialize blob), like
 * TriangulateLiteMeshOp.
 */
/**
 * Destructive symmetrize: for each selected axis, the native `Mesh::symmetrize`
 * bisects the mesh along the plane, keeps the `direction` half, mirrors it, and
 * welds the seam so the result stays watertight (a real topology change, unlike
 * the position-snapping `litemesh.symmetrize_snap`). Multiple axes apply in
 * sequence (X→Y→Z), yielding bilateral/quadrant/octant symmetry. Undo snapshots
 * the pre-op mesh (serialize) and restores it via `_replaceMesh`.
 */
export class SymmetrizeLiteMeshOp extends LiteMeshAttrOp<{
  axes: FlagProperty
  direction: EnumProperty
  threshold: FloatProperty
}> {
  _undoBlob?: Uint8Array

  static tooldef() {
    return {
      toolpath: 'litemesh.symmetrize',
      uiname  : 'Symmetrize',
      icon    : Icons.SYMMETRIZE,
      inputs: ToolOp.inherit({
        axes     : new FlagProperty(1, {X: 1, Y: 2, Z: 4}).saveLastValue(),
        direction: new EnumProperty(1, {NEGATIVE: -1, POSITIVE: 1}).saveLastValue(),
        threshold: new FloatProperty(1e-4).setRange(0, 2).noUnits().saveLastValue(),
      }),
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    this._undoBlob = mesh ? mesh.serialize() : undefined
  }
  calcUndoMem(): number {
    return this._undoBlob?.length ?? 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    const {axes, direction, threshold} = this.getInputs()
    if (!axes) {
      return
    }

    const sign = Number(direction) >= 0 ? 1 : -1
    for (let a = 0; a < 3; a++) {
      if (!(axes & (1 << a))) {
        continue
      }
      // Bisect/mirror/weld this axis; the native op rewrites topology, so normals
      // and the spatial tree are rebuilt inside symmetrizeDestructive.
      mesh.symmetrizeDestructive(a, sign, threshold)
    }
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && this._undoBlob) {
      const wasm = getWasmImmediate()!
      mesh._replaceMesh(wasm.Mesh_deserialize(this._undoBlob))
      window.redraw_all?.()
    }
  }
}

/**
 * Non-destructive symmetrize: snaps destination-side vertices onto the mirrored
 * position of their nearest source-side counterpart WITHOUT changing topology
 * (no bisect/weld). Keeps a mesh's existing vertices but makes their positions
 * symmetric — useful when the mesh is already topologically symmetric and only
 * drifted. For a true watertight half-mirror use `litemesh.symmetrize`.
 */
export class SymmetrizeSnapLiteMeshOp extends LiteMeshAttrOp<{
  axes: FlagProperty
  direction: EnumProperty
  threshold: FloatProperty
}> {
  _undoBlob?: Uint8Array

  static tooldef() {
    return {
      toolpath: 'litemesh.symmetrize_snap',
      uiname  : 'Symmetrize (Snap)',
      icon    : Icons.SYMMETRIZE,
      inputs: ToolOp.inherit({
        axes     : new FlagProperty(1, {X: 1, Y: 2, Z: 4}).saveLastValue(),
        direction: new EnumProperty(1, {NEGATIVE: -1, POSITIVE: 1}).saveLastValue(),
        threshold: new FloatProperty(1e-4).setRange(0, 2).noUnits().saveLastValue(),
      }),
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    this._undoBlob = mesh ? mesh.serialize() : undefined
  }
  calcUndoMem(): number {
    return this._undoBlob?.length ?? 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    const {axes, direction, threshold} = this.getInputs()
    if (!axes) {
      return
    }

    // Read all live vertex positions once; mutate this array per axis, write
    // back at the end (one setVertCo per moved vert).
    const {idx, co} = mesh.dumpVertCo()
    const n = idx.length
    if (n === 0) {
      return
    }

    const dir = Number(direction) >= 0 ? 1 : -1
    for (let a = 0; a < 3; a++) {
      if (!(axes & (1 << a))) {
        continue
      }
      symmetrizeAxis(co, a, dir, threshold)
    }

    for (let i = 0; i < n; i++) {
      const p = co[i]
      mesh.setVertCo(idx[i], p[0], p[1], p[2])
    }

    mesh.recalcNormals()
    // Direct setVertCo writes don't flag spatial nodes, so node bounds and the
    // GPU vertex buffers are stale; rebuild the tree to refresh both.
    mesh.rebuildSpatialFromEdit()
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && this._undoBlob) {
      const wasm = getWasmImmediate()!
      mesh._replaceMesh(wasm.Mesh_deserialize(this._undoBlob))
      window.redraw_all?.()
    }
  }
}

/**
 * Rebuild the LiteMesh spatial tree from scratch. Non-destructive to mesh data
 * (only the acceleration structure + GPU buffers are regenerated), so it carries
 * no undo state.
 */
export class RebuildSpatialTreeLiteMeshOp extends LiteMeshAttrOp {
  static tooldef() {
    return {
      toolpath: 'litemesh.rebuild_spatial_tree',
      uiname  : 'Rebuild Spatial Tree',
      undoflag: UndoFlags.NO_UNDO,
      inputs  : {},
    }
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    mesh.rebuildSpatialFromEdit()
    window.redraw_all?.()
  }
}

/**
 * Mark edges sharp automatically wherever the dihedral angle between adjacent
 * faces exceeds `angle` (degrees). Additive (won't clear existing sharps).
 * Serialize-snapshot undo, mirroring SymmetrizeSnapLiteMeshOp.
 */
export class MarkSharpByAngleLiteMeshOp extends LiteMeshAttrOp<{
  angle: FloatProperty
}> {
  _undoBlob?: Uint8Array

  static tooldef() {
    return {
      toolpath: 'litemesh.mark_sharp_by_angle',
      uiname  : 'Mark Sharp by Angle',
      icon    : Icons.MARK_SHARP_ANGLE,
      inputs: {
        angle: new FloatProperty(30).setRange(0, 180).noUnits().saveLastValue(),
      },
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    this._undoBlob = mesh ? mesh.serialize() : undefined
  }
  calcUndoMem(): number {
    return this._undoBlob?.length ?? 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    const {angle} = this.getInputs()
    mesh.markSharpByAngle((angle * Math.PI) / 180, 1)
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && this._undoBlob) {
      const wasm = getWasmImmediate()!
      mesh._replaceMesh(wasm.Mesh_deserialize(this._undoBlob))
      window.redraw_all?.()
    }
  }
}

/**
 * Make `co` (flat object-local positions, mutated in place) symmetric about the
 * plane `axis = 0`: every destination-side vertex (`sign(p[axis]) === −dir`)
 * copies the mirrored position of its nearest source-side counterpart, and any
 * vertex within `threshold` of the plane snaps onto it. Source side is the half
 * with `sign(p[axis]) === dir` (plus on-plane verts). Topology-preserving.
 */
function symmetrizeAxis(co: number[][], axis: number, dir: number, threshold: number): void {
  // Source = the kept half (dir side) plus on-plane verts: the mirror target set.
  const srcIdx: number[] = []
  for (let i = 0; i < co.length; i++) {
    const s = co[i][axis]
    if (Math.abs(s) <= threshold || Math.sign(s) === dir) {
      srcIdx.push(i)
    }
  }
  if (srcIdx.length === 0) {
    return
  }

  // Spatial hash over source positions for nearest-vertex matching. Cell size is
  // the mean nearest-neighbor scale approximated from the bound diagonal / n^(1/3).
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const i of srcIdx) {
    const p = co[i]
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k]
      if (p[k] > max[k]) max[k] = p[k]
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1
  const cell = Math.max(diag / Math.max(1, Math.cbrt(srcIdx.length)), 1e-6)
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  for (const i of srcIdx) {
    const p = co[i]
    const k = key(p[0], p[1], p[2])
    let bucket = grid.get(k)
    if (!bucket) {
      bucket = []
      grid.set(k, bucket)
    }
    bucket.push(i)
  }

  // Find the source vertex nearest to point m by scanning a growing ring of
  // cells until a hit is found, then one extra ring to confirm the true nearest.
  const nearest = (m: number[]): number => {
    const cx = Math.floor(m[0] / cell)
    const cy = Math.floor(m[1] / cell)
    const cz = Math.floor(m[2] / cell)
    let best = -1
    let bestD = Infinity
    for (let r = 0; r < 64; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            // Only the shell at radius r (interior already scanned).
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) {
              continue
            }
            const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
            if (!bucket) {
              continue
            }
            for (const i of bucket) {
              const p = co[i]
              const d = (p[0] - m[0]) ** 2 + (p[1] - m[1]) ** 2 + (p[2] - m[2]) ** 2
              if (d < bestD) {
                bestD = d
                best = i
              }
            }
          }
        }
      }
      // Once we have a candidate, scan one more shell (a closer vert can sit in
      // an as-yet-unscanned neighbor cell) then stop.
      if (best >= 0 && r > 0) {
        break
      }
    }
    return best
  }

  // Destination side: mirror each vert across the plane, snap to the nearest
  // source vert, and copy that source's mirrored position back.
  for (let i = 0; i < co.length; i++) {
    const p = co[i]
    const s = p[axis]
    if (Math.abs(s) <= threshold) {
      p[axis] = 0
      continue
    }
    if (Math.sign(s) === dir) {
      continue
    }
    const m = [p[0], p[1], p[2]]
    m[axis] = -m[axis]
    const sj = nearest(m)
    if (sj < 0) {
      continue
    }
    const sp = co[sj]
    p[0] = sp[0]
    p[1] = sp[1]
    p[2] = sp[2]
    p[axis] = -p[axis]
  }
}

/**
 * Feature-aligned global quad remesh of the active LiteMesh (cross-field →
 * seamless param → integer quantization → quad extraction → reprojection). A
 * whole-mesh topology change, so undo snapshots the pre-remesh mesh (serialize)
 * and restores it via `_replaceMesh`; redo re-runs exec. A clean failure
 * (infeasible field / too many folds) leaves the mesh untouched and drops the
 * snapshot. Input defaults mirror C++ `remesh_params.h` — keep them in sync, as
 * exec always passes every field, overriding the bound struct's own defaults.
 */
export class QuadRemeshLiteMeshOp extends LiteMeshAttrOp<{
  targetQuadCount: IntProperty
  targetEdgeLength: FloatProperty
  useCurvature: BoolProperty
  useSharpFeatures: BoolProperty
  sharpAngle: FloatProperty
  useDensity: BoolProperty
  reproject: BoolProperty
  smoothIterations: IntProperty
  smoothStrength: FloatProperty
  seed: IntProperty
  triage: BoolProperty
  triageWeldRel: FloatProperty
  triageMinComponentFrac: FloatProperty
  curvatureSmoothIters: IntProperty
  curvatureSmoothLambda: FloatProperty
  fieldSmoothness: FloatProperty
  curvatureWeight: FloatProperty
  singularityCancel: BoolProperty
  singularityCancelMaxSep: FloatProperty
  autoDensity: BoolProperty
  densityMin: FloatProperty
  densityMax: FloatProperty
  densityGradation: FloatProperty
  densityGradationIters: IntProperty
  preRemesh: BoolProperty
  preRemeshTarget: FloatProperty
  preRemeshIters: IntProperty
  preRemeshDensity: BoolProperty
  preRemeshGradation: FloatProperty
  preRemeshGradationIters: IntProperty
  preRemeshAlign: FloatProperty
  preRemeshFieldCadence: IntProperty
  preRemeshBootstrapIters: IntProperty
  preRemeshSmoothIters: IntProperty
  preRemeshSmoothLambda: FloatProperty
  preRemeshConvergeEps: FloatProperty
  preRemeshPreserveFeatures: BoolProperty
  preRemeshSharpAngle: FloatProperty
}> {
  /** Pre-remesh mesh blob, or undefined when the remesh cleanly failed (no-op). */
  _undoBlob?: Uint8Array

  /* Feature-flagged: hidden from the op search menu (and blocked) when the
   * quad-remesher flag is off; the toolmode UI gates its panels the same way. */
  static canRun(_ctx: ToolContext): boolean {
    return FeatureFlags.get('sculptcore.quad_remesher')
  }

  static tooldef() {
    return {
      toolpath: 'litemesh.quad_remesh',
      uiname  : 'Quad Remesh',
      inputs: {
        targetQuadCount          : new IntProperty(15000).setRange(1, 1000000).noUnits(),
        // 0 = derive the edge length from targetQuadCount (count mode).
        targetEdgeLength         : new FloatProperty(0.0).setRange(0.0, 10.0),
        useCurvature             : new BoolProperty(true),
        useSharpFeatures         : new BoolProperty(false),
        sharpAngle               : new FloatProperty(0.7853982).setRange(0.0, Math.PI),
        useDensity               : new BoolProperty(false),
        reproject                : new BoolProperty(false),
        smoothIterations         : new IntProperty(2).setRange(0, 20).noUnits(),
        smoothStrength           : new FloatProperty(0.5).setRange(0.0, 1.0).noUnits(),
        seed                     : new IntProperty(1).setRange(0, 1 << 30).noUnits(),
        triage                   : new BoolProperty(true),
        triageWeldRel            : new FloatProperty(1e-5).setRange(0.0, 1e-3).noUnits(),
        triageMinComponentFrac   : new FloatProperty(0.0).setRange(0.0, 0.5).noUnits(),
        curvatureSmoothIters     : new IntProperty(0).setRange(0, 20).noUnits(),
        curvatureSmoothLambda    : new FloatProperty(0.5).setRange(0.0, 1.0).noUnits(),
        fieldSmoothness          : new FloatProperty(1.0).setRange(0.1, 8.0).noUnits(),
        curvatureWeight          : new FloatProperty(1.0).setRange(0.0, 8.0).noUnits(),
        singularityCancel        : new BoolProperty(true),
        singularityCancelMaxSep  : new FloatProperty(1.5).setRange(0.5, 4.0).noUnits(),
        autoDensity              : new BoolProperty(false),
        densityMin               : new FloatProperty(0.25).setRange(0.05, 1.0).noUnits(),
        densityMax               : new FloatProperty(4.0).setRange(1.0, 16.0).noUnits(),
        densityGradation         : new FloatProperty(0.5).setRange(0.0, 2.0).noUnits(),
        densityGradationIters    : new IntProperty(10).setRange(1, 30).noUnits(),
        preRemesh                : new BoolProperty(false),
        preRemeshTarget          : new FloatProperty(0.0).setRange(0.0, 10.0).noUnits(),
        preRemeshIters           : new IntProperty(0).setRange(0, 20).noUnits(),
        preRemeshDensity         : new BoolProperty(true),
        preRemeshGradation       : new FloatProperty(0.5).setRange(0.0, 2.0).noUnits(),
        preRemeshGradationIters  : new IntProperty(10).setRange(1, 30).noUnits(),
        preRemeshAlign           : new FloatProperty(1.0).setRange(0.0, 1.0).noUnits(),
        preRemeshFieldCadence    : new IntProperty(2).setRange(1, 8).noUnits(),
        preRemeshBootstrapIters  : new IntProperty(-1).setRange(-1, 8).noUnits(),
        preRemeshSmoothIters     : new IntProperty(5).setRange(0, 20).noUnits(),
        preRemeshSmoothLambda    : new FloatProperty(0.5).setRange(0.0, 1.0).noUnits(),
        preRemeshConvergeEps     : new FloatProperty(0.05).setRange(0.0, 0.2).noUnits(),
        preRemeshPreserveFeatures: new BoolProperty(true),
        preRemeshSharpAngle      : new FloatProperty(0.7853982).setRange(0.0, Math.PI),
      },
    }
  }

  undoPre(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    this._undoBlob = mesh ? mesh.serialize() : undefined
  }
  calcUndoMem(): number {
    return this._undoBlob?.length ?? 0
  }

  exec(ctx: ToolContext) {
    const mesh = this._getMesh(ctx)
    if (!mesh) {
      return
    }
    const i = this.getInputs()
    const changed = mesh.quadRemesh({
      targetQuadCount          : i.targetQuadCount,
      targetEdgeLength         : i.targetEdgeLength,
      useCurvature             : i.useCurvature,
      useSharpFeatures         : i.useSharpFeatures,
      sharpAngle               : i.sharpAngle,
      useDensity               : i.useDensity,
      reproject                : i.reproject,
      smoothIterations         : i.smoothIterations,
      smoothStrength           : i.smoothStrength,
      seed                     : i.seed,
      triage                   : i.triage,
      triageWeldRel            : i.triageWeldRel,
      triageMinComponentFrac   : i.triageMinComponentFrac,
      curvatureSmoothIters     : i.curvatureSmoothIters,
      curvatureSmoothLambda    : i.curvatureSmoothLambda,
      fieldSmoothness          : i.fieldSmoothness,
      curvatureWeight          : i.curvatureWeight,
      singularityCancel        : i.singularityCancel,
      singularityCancelMaxSep  : i.singularityCancelMaxSep,
      autoDensity              : i.autoDensity,
      densityMin               : i.densityMin,
      densityMax               : i.densityMax,
      densityGradation         : i.densityGradation,
      densityGradationIters    : i.densityGradationIters,
      preRemesh                : i.preRemesh,
      preRemeshTarget          : i.preRemeshTarget,
      preRemeshIters           : i.preRemeshIters,
      preRemeshDensity         : i.preRemeshDensity,
      preRemeshGradation       : i.preRemeshGradation,
      preRemeshGradationIters  : i.preRemeshGradationIters,
      preRemeshAlign           : i.preRemeshAlign,
      preRemeshFieldCadence    : i.preRemeshFieldCadence,
      preRemeshBootstrapIters  : i.preRemeshBootstrapIters,
      preRemeshSmoothIters     : i.preRemeshSmoothIters,
      preRemeshSmoothLambda    : i.preRemeshSmoothLambda,
      preRemeshConvergeEps     : i.preRemeshConvergeEps,
      preRemeshPreserveFeatures: i.preRemeshPreserveFeatures,
      preRemeshSharpAngle      : i.preRemeshSharpAngle,
    })
    // Clean failure leaves the mesh untouched, so there's nothing to undo.
    if (!changed) {
      this._undoBlob = undefined
    }
    window.redraw_all?.()
  }

  undo(ctx: ToolContext): void {
    const mesh = this._getMesh(ctx)
    if (mesh && this._undoBlob) {
      const wasm = getWasmImmediate()!
      mesh._replaceMesh(wasm.Mesh_deserialize(this._undoBlob))
      mesh.regenBounds()
      window.redraw_all?.()
    }
  }
}

/** Every ToolOp this module defines, in declaration order; the addon's
 * `register(api)` hook registers the list. */
export const LITEMESH_OPS = [
  AddLiteMeshCubeOp,
  AddLiteMeshPlaneOp,
  AddAttrOp,
  RemoveAttrOp,
  SculptLayerAddOp,
  SculptLayerRemoveOp,
  SculptLayerSetWeightOp,
  SculptLayerSetFlagOp,
  SculptLayerSetTargetOp,
  MultiresEnableOp,
  MultiresSetLevelOp,
  MultiresDownRefitOp,
  MultiresAddLevelOp,
  MultiresDeleteOp,
  VdmEnableOp,
  VdmDeleteOp,
  VdmApplyOp,
  VdmCaptureOp,
  MarkSeamOp,
  MarkSeamInteractiveOp,
  MarkSharpInteractiveOp,
  GenerateUVOp,
  TriangulateLiteMeshOp,
  ReorderLocalityOp,
  SymmetrizeLiteMeshOp,
  SymmetrizeSnapLiteMeshOp,
  RebuildSpatialTreeLiteMeshOp,
  MarkSharpByAngleLiteMeshOp,
  QuadRemeshLiteMeshOp,
]
