import './mesh_loopops.js'
import './mesh_curvature_test'

import {Vector3, ToolDef, Number2, PropertySlots, Vector4, Number3, ContextLike} from '@framework/api'
import {
  IntProperty,
  BoolProperty,
  FloatProperty,
  EnumProperty,
  FlagProperty,
  StringProperty,
  ToolOp,
  ToolMacro,
  UndoFlags,
  keymap,
} from '@framework/pathux'
import {TranslateOp} from '@framework/api'
import {util} from '@framework/api'
import {SelMask} from '@framework/api'
import {Icons} from '@framework/api'

import {MeshFlags, MeshTypes, LogContext} from './mesh_base.js'
import {IMeshUndoData, MeshDeformOp, MeshOp} from './mesh_ops_base.js'
import {ccSmooth, subdivide, loopSubdivide} from '../../subsurf/src/subsurf_mesh.js'
import {splitEdgesSimple2, splitEdgesSmart, splitEdgesSmart2} from './mesh_subdivide.js'
import {GridBase, Grid, gridSides, GridSettingFlags, GridVertBase, GridVert} from './mesh_grids.js'
import {QuadTreeGrid, QuadTreeFields, QTGridVert} from './mesh_grids_quadtree.js'
import {AttrRef, CDFlags, CustomDataElem} from './customdata'
import {
  _testMVC,
  bisectMesh,
  connectVerts,
  cotanVertexSmooth,
  dissolveEdgeLoops,
  dissolveFaces,
  duplicateMesh,
  fixManifold,
  flipLongTriangles,
  pruneLooseGeometry,
  recalcWindings,
  symmetrizeMesh,
  trianglesToQuads,
  triangulateMesh,
  TriQuadFlags,
  vertexSmooth,
} from './mesh_utils.js'
import {QRecalcFlags} from './mesh_grids.js'

import {buildGridsSubSurf} from './mesh_grids_subsurf.js'

import '../../../../scripts/util/floathalf.js'
import {CubicPatch, bernstein, bspline} from '../../subsurf/src/subsurf_patch.js'
import {KdTreeGrid} from './mesh_grids_kdtree.js'
import {triangulateFace, setMeshClass, applyTriangulation} from './mesh_tess.js'
import {Edge, Element, Face, Handle, Mesh, Vertex} from './mesh.js'

setMeshClass(Mesh)

export class DeleteOp extends MeshOp<{}, {}> {
  static tooldef(): ToolDef {
    return {
      uiname  : 'Delete Selected',
      icon    : Icons.DELETE,
      toolpath: 'mesh.delete_selected',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ViewContext) {
    console.warn('mesh.delete_selected')

    const selectmode = ctx.selectMask
    console.log('selectmode:', selectmode)

    for (const mesh of this.getMeshes(ctx)) {
      const del = [] as Vertex[]

      if (selectmode & SelMask.VERTEX) {
        for (const v of new Set(mesh.verts.selected.editable)) {
          mesh.killVertex(v)
        }
      } else if (selectmode & SelMask.EDGE) {
        const vset = new Set<Vertex>()

        for (const e of new Set(mesh.edges.selected.editable)) {
          vset.add(e.v1)
          vset.add(e.v2)

          mesh.killEdge(e)
        }

        for (const v of vset) {
          if (v.edges.length === 0) {
            mesh.killVertex(v)
          }
        }
      } else if (selectmode & SelMask.FACE) {
        const vset = new Set<Vertex>()
        const eset = new Set<Edge>()

        for (const f of new Set(mesh.faces.selected.editable)) {
          for (const l of f.loops) {
            eset.add(l.e)
            vset.add(l.v)
          }

          mesh.killFace(f)
        }

        for (const e of eset) {
          if (!e.l) {
            mesh.killEdge(e)
          }
        }

        for (const v of vset) {
          if (v.edges.length === 0) {
            mesh.killVertex(v)
          }
        }
      }

      for (const v of del) {
        mesh.killVertex(v)
      }

      mesh.regenRender()
      mesh.regenTessellation()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class DeleteOnlyFacesOp extends MeshOp {
  static tooldef(): ToolDef {
    return {
      uiname  : 'Delete Only Faces',
      icon    : Icons.DELETE,
      toolpath: 'mesh.delete_only_faces',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ViewContext): void {
    console.warn('mesh.delete_only_faces')

    const selectmode = ctx.selectMask

    for (const mesh of this.getMeshes(ctx)) {
      for (const f of new Set(mesh.faces.selected.editable)) {
        mesh.killFace(f)
      }

      mesh.regenRender()
      mesh.regenUVEditor()
      mesh.regenUVWrangler()
      mesh.regenBVH()
      mesh.regenTessellation()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class FlipLongTrisOp extends MeshOp {
  static tooldef(): ToolDef {
    return {
      uiname  : 'Flip Long Triangles',
      icon    : Icons.TRIANGLE_FLIPPER,
      toolpath: 'mesh.flip_long_tris',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ViewContext) {
    console.warn('mesh.delete_selected')

    const selectmode = ctx.selectMask
    console.log('selectmode:', selectmode)

    for (const mesh of this.getMeshes(ctx)) {
      flipLongTriangles(mesh, mesh.faces.selected.editable)

      mesh.regenBVH()
      mesh.regenRender()
      mesh.regenTessellation()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class TriToQuadsOp extends MeshOp<{
  options: FlagProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Triangles To Quads',
      icon    : Icons.TRIS_TO_QUADS,
      toolpath: 'mesh.tris_to_quads',
      inputs: ToolOp.inherit({
        options: new FlagProperty(TriQuadFlags.DEFAULT, TriQuadFlags).saveLastValue(),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext): void {
    console.warn('mesh.tris_to_quads')

    for (const mesh of this.getMeshes(ctx)) {
      const fs = new Set(mesh.faces.selected.editable)

      for (const e of mesh.edges.selected.editable) {
        for (const l of e.loops) {
          fs.add(l.f)
        }
      }

      trianglesToQuads(mesh, fs, this.inputs.options.getValue())

      if (this.inputs.options.getValue()) {
        for (const f of mesh.faces.selected.editable) {
          for (const e of f.edges) {
            if (e.flag & MeshFlags.QUAD_EDGE) {
              e.flag |= MeshFlags.DRAW_DEBUG
            } else {
              e.flag &= ~MeshFlags.DRAW_DEBUG
            }

            e.flag |= MeshFlags.UPDATE
            e.v1.flag |= MeshFlags.UPDATE
            e.v2.flag |= MeshFlags.UPDATE
          }
        }
      }

      mesh.regenBVH()
      mesh.regenRender()
      mesh.regenTessellation()
      mesh.graphUpdate()
      mesh.recalcNormals()
    }

    window.redraw_viewport()
  }
}

export class SymmetrizeOp extends MeshOp<{
  axis: EnumProperty<number>
  side: EnumProperty<number>
  selectedOnly: BoolProperty
  threshold: FloatProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Symmetrize',
      toolpath: 'mesh.symmetrize',
      icon    : Icons.SYMMETRIZE,
      inputs: ToolOp.inherit({
        axis        : new EnumProperty(0, {X: 0, Y: 1, Z: 2}).saveLastValue(),
        side        : new EnumProperty(1, {LEFT: -1, RIGHT: 1}).saveLastValue(),
        selectedOnly: new BoolProperty(false).saveLastValue(),
        threshold   : new FloatProperty(0.0001).setRange(0.0, 2.0).noUnits().saveLastValue(),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext): void {
    console.warn('mesh.symmetrize')

    for (const mesh of this.getMeshes(ctx)) {
      const del = []

      let fset

      if (this.inputs.selectedOnly.getValue()) {
        fset = mesh.faces.selected.editable
      } else {
        fset = mesh.faces
      }

      fset = new Set(fset)

      const vector = new Vector3()
      const axis = this.inputs.axis.getValue() as Number2
      const side = this.inputs.side.getValue()

      vector[axis] = side

      //force bvh update
      if (mesh.bvh) {
        mesh.bvh.destroy(mesh)
      }

      const threshold = this.inputs.threshold.getValue()
      symmetrizeMesh(mesh, fset, axis, side, threshold)

      //force bvh update
      mesh.bvh = undefined

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class BisectOp extends MeshOp<{
  axis: EnumProperty<number>
  side: EnumProperty<number>
  selectedOnly: BoolProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Bisect Mesh',
      toolpath: 'mesh.bisect',
      icon    : Icons.BISECT,
      inputs: ToolOp.inherit({
        axis        : new EnumProperty(0, {X: 0, Y: 1, Z: 2}),
        side        : new EnumProperty(1, {LEFT: -1, RIGHT: 1}),
        selectedOnly: new BoolProperty(false),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.bisect')

    for (const mesh of this.getMeshes(ctx)) {
      const del = []

      let fset: Iterable<Face>

      if (this.inputs.selectedOnly.getValue()) {
        fset = mesh.faces.selected.editable
      } else {
        fset = mesh.faces
      }

      fset = new Set(fset)

      const vector = new Vector3()
      const axis = this.inputs.axis.getValue() as Number2
      const side = this.inputs.side.getValue()

      vector[axis] = side

      //force bvh update
      if (mesh.bvh) {
        mesh.bvh.destroy(mesh)
      }

      const vs = new Set<Vertex>()

      for (const f of fset) {
        for (const l of f.loops) {
          vs.add(l.v)
        }
      }

      const ret = bisectMesh(mesh, fset, vector)

      for (const v of vs) {
        if (Math.sign(v[axis]) !== Math.sign(side) && Math.abs(v[axis]) > 0.0001) {
          mesh.killVertex(v)
        }
      }

      //force bvh update
      mesh.bvh = undefined

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class TriangulateOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Triangulate',
      toolpath: 'mesh.triangulate',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext): void {
    console.warn('mesh.triangulate')

    const tri = [0, 0, 0]

    for (const mesh of this.getMeshes(ctx)) {
      const del = []

      const fs = new Set(mesh.faces.selected.editable)

      const lctx = new LogContext()
      lctx.onnew = (e) => {
        mesh.setSelect(e, true)

        if (e.type === MeshTypes.FACE) {
          for (const l of (e as Face).loops) {
            mesh.setSelect(l.v, true)
            mesh.setSelect(l.e, true)
          }
        }
      }

      for (const f of fs) {
        f.calcNormal()
        applyTriangulation(mesh, f, undefined, undefined, lctx)
      }

      /*
      let ltris = mesh.loopTris;

      for (let i = 0; i < ltris.length; i += 3) {
        let l1 = ltris[i], l2 = ltris[i + 1], l3 = ltris[i + 2];

        if (fs.has(l1.f)) {
          tri.length = 3;
          tri[0] = l1.v;
          tri[1] = l2.v;
          tri[2] = l3.v;

          let f2 = mesh.makeFace(tri);
          let l = f2.lists[0].l;

          mesh.copyElemData(f2, l1.f);
          mesh.copyElemData(l, l1);
          mesh.copyElemData(l.next, l2);
          mesh.copyElemData(l.prev, l3);
        }
      }

      for (let f of fs) {
        mesh.killFace(f);
      }

      */

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export const RemeshOpModes = {
  REMESH        : 0,
  GEN_CROSSFIELD: 1,
  OPT_CROSSFIELD: 2,
}

export class RemeshOp<InputSlots = {}> extends MeshOp<
  InputSlots & {
    flag: FlagProperty
    remesher: EnumProperty
    rakeFactor: FloatProperty
    relax: FloatProperty
    origFactor: FloatProperty
    projection: FloatProperty
    subdivideFac: FloatProperty
    collapseFac: FloatProperty
    goalType: EnumProperty
    goal: FloatProperty
    edgeRunPercent: FloatProperty
    curveSmoothFac: FloatProperty
    curveSmoothRepeat: IntProperty
    rakeMode: EnumProperty
    reproject: BoolProperty
  }
> {
  static tooldef(): ToolDef {
    return {
      uiname  : 'Remesh',
      toolpath: 'mesh.remesh',
      inputs: ToolOp.inherit({
        flag             : new FlagProperty(DefaultRemeshFlags, RemeshFlags),
        remesher         : new EnumProperty(Remeshers.UNIFORM_TRI, Remeshers).saveLastValue(),
        rakeFactor       : new FloatProperty(0.5).noUnits().setRange(0.0, 1.0).saveLastValue(),
        relax            : new FloatProperty(0.25).noUnits().setRange(0.0, 1.0).saveLastValue(),
        origFactor       : new FloatProperty(0.25).noUnits().setRange(0.0, 1.0).saveLastValue(),
        projection       : new FloatProperty(0.8).noUnits().setRange(0.0, 1.0).saveLastValue(),
        subdivideFac     : new FloatProperty(0.35).noUnits().setRange(0.01, 3.0).saveLastValue(),
        collapseFac      : new FloatProperty(0.35).noUnits().setRange(0.01, 1.0).saveLastValue(),
        goalType         : new EnumProperty(RemeshGoals.EDGE_AVERAGE, RemeshGoals).saveLastValue(),
        goal: new FloatProperty(1.0)
          .noUnits()
          .setRange(0, 1024 * 1024 * 32)
          .saveLastValue(),
        edgeRunPercent   : new FloatProperty(0.5).setRange(0.001, 1).noUnits().saveLastValue(),
        curveSmoothFac   : new FloatProperty(0.0).noUnits().setRange(0.0, 1.0).saveLastValue(),
        curveSmoothRepeat: new IntProperty(4).noUnits().setRange(0, 50).saveLastValue(),
        rakeMode         : new EnumProperty(RakeModes.CURVATURE, RakeModes).saveLastValue(),
        reproject        : new BoolProperty(false).saveLastValue(),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  remesher?: Remesher

  makeRemesher(ctx: ToolContext, mesh: Mesh, lctx: LogContext): Remesher {
    const goalType = this.inputs.goalType.getValue()
    const goalValue = this.inputs.goal.getValue()
    const rakeFactor = this.inputs.rakeFactor.getValue()
    const relax = this.inputs.relax.getValue()
    const origFactor = this.inputs.origFactor.getValue()
    const subdFac = this.inputs.subdivideFac.getValue()
    const collFac = this.inputs.collapseFac.getValue()
    const project = this.inputs.projection.getValue()
    let count = this.inputs.edgeRunPercent.getValue()
    const curveSmoothRepeat = this.inputs.curveSmoothRepeat.getValue()
    const curveSmoothFac = this.inputs.curveSmoothFac.getValue()
    const reproject = this.inputs.reproject.getValue()

    count = Math.ceil(mesh.edges.length * count)

    fixManifold(mesh, lctx)
    const cls = RemeshMap[this.inputs.remesher.getValue()]

    const remesher = new cls(mesh, lctx, goalType, goalValue)

    remesher.origFactor = origFactor
    remesher.reproject = reproject
    remesher.rakeMode = this.inputs.rakeMode.getValue()
    remesher.subdFac = subdFac
    remesher.collFac = collFac
    remesher.relax = relax
    remesher.projection = project
    remesher.rakeFactor = rakeFactor
    remesher.flag = this.inputs.flag.getValue()
    remesher.smoothCurveRepeat = curveSmoothRepeat
    remesher.smoothCurveFac = curveSmoothFac

    remesher.start(count)

    return remesher
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.remesh')

    const tri = [0, 0, 0]

    for (const mesh of this.getMeshes(ctx)) {
      const lctx = new LogContext()

      lctx.onnew = (e) => {
        mesh.setSelect(e, true)
        if (e.type === MeshTypes.FACE) {
          for (const l of (e as Face).loops) {
            mesh.setSelect(l.v, true)
            mesh.setSelect(l.e, true)
          }
        }
      }

      const remesher = this.makeRemesher(ctx, mesh, lctx)
      let i = 0

      while (!remesher.done && i++ < 5) {
        remesher.step()
      }

      remesher.finish()

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class InteractiveRemeshOp extends RemeshOp<{
  steps: IntProperty
  mode: EnumProperty
}> {
  static tooldef(): ToolDef {
    return {
      uiname  : 'Remesh (Interactive)',
      toolpath: 'mesh.interactive_remesh',
      inputs: ToolOp.inherit({
        steps: new IntProperty(5).private(),
        mode : new EnumProperty(RemeshOpModes.REMESH, RemeshOpModes),
      }),
      outputs : ToolOp.inherit({}),
      is_modal: true,
    }
  }

  _redo?: {
    [k: string]: IMeshUndoData
  }
  lctx?: LogContext
  last_time = 0

  redo(ctx: ToolContext) {
    const undo = this._undo

    this._undo = this._redo
    this._redo = undefined

    super.undo(ctx)

    this._undo = undo
  }

  undo(ctx: ToolContext) {
    const undo = this._undo

    this.undoPre(ctx)
    this._redo = this._undo
    this._undo = undo

    super.undo(ctx)
  }

  makeLogCtx(ctx: ToolContext, mesh: Mesh): LogContext {
    const lctx = new LogContext()

    lctx.onnew = (e: Element, tag?: any) => {
      /*
      mesh.setSelect(e, true);

      if (e.type === MeshTypes.FACE) {
        for (let l of (e as Face).loops) {
          mesh.setSelect(l.v, true);
          mesh.setSelect(l.e, true);
        }
      }
      */
    }

    return lctx
  }

  on_mousedown(e: MouseEvent): void {
    this.modalEnd(false)
  }

  on_mouseup(e: MouseEvent): void {
    this.modalEnd(false)
  }

  modalEnd(wasCancelled?: boolean): void {
    this.remesher?.finish()

    //prevent reference leaks
    this.remesher = undefined
    this.lctx = undefined

    const mesh = this.modal_ctx!.mesh!
    if (mesh) {
      for (const v of mesh.verts) {
        v.flag |= MeshFlags.UPDATE
      }
      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }

    super.modalEnd(false)
  }

  modalStart(ctx: ViewContext) {
    const mesh = ctx.mesh

    if (mesh === undefined) {
      console.warn('Mesh was undefined in tool', this)
      return new Promise<void>((accept, reject) => {
        accept()
      })
    }

    mesh.compact()

    this.lctx = this.makeLogCtx(ctx, mesh)
    this.remesher = this.makeRemesher(ctx, mesh, this.lctx)
    ;(this.remesher as unknown as any).minEdges = -1

    this.last_time = util.time_ms()

    return super.modalStart(ctx)
  }

  on_tick() {
    if (util.time_ms() - this.last_time < 50) {
      return
    }

    const mesh = this.modal_ctx!.mesh!

    const time = util.time_ms()
    while (this.remesher && util.time_ms() - time < 50 && !this.remesher.done) {
      const i = this.inputs.steps.getValue()
      this.inputs.steps.setValue(i + 1)

      this._step(this.modal_ctx!, this.remesher, mesh, this.lctx!)
    }

    if (!this.remesher) {
      this.modalEnd()
    }

    mesh.regenAll()
    mesh.graphUpdate()

    this.last_time = util.time_ms()
    window.redraw_viewport(true)
  }

  _step(ctx: ToolContext, remesher: Remesher, mesh: Mesh, lctx: LogContext): void {
    switch (this.inputs.mode.getValue()) {
      case RemeshOpModes.REMESH:
        remesher.step()
        break
      case RemeshOpModes.GEN_CROSSFIELD:
        ;(remesher as unknown as any).solveRakeDirections()
        break
      case RemeshOpModes.OPT_CROSSFIELD:
        ;(remesher as unknown as any).propRakeDirections()
        break
    }
  }

  exec(ctx: ToolContext): void {
    const mesh = ctx.mesh!
    const lctx = this.makeLogCtx(ctx, mesh)

    mesh.compact()

    const remesher = this.makeRemesher(ctx, mesh, lctx)

    const steps = this.inputs.steps.getValue()

    for (let i = 0; i < steps; i++) {
      this._step(ctx, remesher, mesh, lctx)
    }

    remesher.finish()

    mesh.regenAll()
    mesh.recalcNormals()
    mesh.graphUpdate()
    window.redraw_viewport()
  }
}

export class LoopSubdOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Subdivide Smooth (Loop)',
      toolpath: 'mesh.subdivide_smooth_loop',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.subdivide_smooth_loop')

    for (const mesh of this.getMeshes(ctx)) {
      const del = []

      loopSubdivide(mesh, mesh.faces.selected.editable)

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

import {meshSubdivideTest} from './mesh_subdivide.js'
import {UVWrangler, voxelUnwrap} from './unwrapping.js'
import {relaxUVs, fixSeams, UnWrapSolver} from './unwrapping_solve.js'
import {MeshOpBaseUV, UnwrapOpBase} from './mesh_uvops_base.js'
import {MultiGridSmoother} from './multigrid_smooth.js'
import {
  cleanupQuads,
  cleanupTris,
  DefaultRemeshFlags,
  RakeModes,
  Remesher,
  Remeshers,
  RemeshFlags,
  RemeshGoals,
  RemeshMap,
  remeshMesh,
  UniformTriRemesher,
} from './mesh_remesh.js'

export class CatmullClarkeSubd extends MeshOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname  : 'Subdivide Smooth',
      icon    : Icons.SUBDIVIDE,
      toolpath: 'mesh.subdivide_smooth',
      undoflag: 0,
      flag    : 0,
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.log('subdivide smooth!')

    for (const mesh of this.getMeshes(ctx)) {
      console.log('doing mesh', mesh.lib_id)

      subdivide(mesh, new Set(mesh.faces.selected.editable))

      mesh.regenRender()
      mesh.regenTessellation()

      const es = new Set<Edge>()

      for (const e of mesh.edges.selected.editable) {
        if (!e.l) {
          es.add(e)
        }
      }

      //handle wire edges
      const vs = new Set<Vertex>()

      for (const e of es) {
        vs.add(e.v1)
        vs.add(e.v2)

        const ret = mesh.splitEdge(e, 0.5)

        if (ret.length > 0) {
          vs.add(ret[1])
          mesh.setSelect(ret[0], true)
          mesh.setSelect(ret[1], true)
        }
      }

      vertexSmooth(mesh, vs)

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
      mesh.regenBVH()
    }
  }
}

export const SymFlags = {
  X   : 1,
  Y   : 2,
  Z   : 4,
  AUTO: 512,
}

export class MeshSnapToMirror extends MeshOp<{
  symFlag: FlagProperty
}> {
  constructor() {
    super()
  }

  static tooldef(): ToolDef {
    return {
      uiname  : 'Snap Verts To Mirror Line',
      icon    : -1,
      toolpath: 'mesh.snap_to_mirror_axis',
      inputs: ToolOp.inherit({
        symFlag: new FlagProperty(SymFlags.AUTO, SymFlags),
      }),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      let axes = this.inputs.symFlag.getValue()

      if (axes & SymFlags.AUTO) {
        axes = mesh.symFlag

        //check sculpt toolmode's symmetry settings too
        for (const mode of ctx.scene.toolmodes) {
          if (mode instanceof PaintToolModeBase) {
            axes |= mode.symmetryAxes
          }
        }
      }

      console.log('axes', axes)

      for (const v of mesh.verts.selected.editable) {
        let minaxis: (0 | 1 | 2) | undefined
        let mindis = Number.MAX_SAFE_INTEGER

        for (let i = 0; i < 3; i++) {
          if (!(axes & (1 << i))) {
            continue
          }

          if (minaxis === undefined || Math.abs(v.co[i as Number3]) < mindis) {
            minaxis = i as 0 | 1 | 2
            mindis = Math.abs(v.co[i as Number3])
          }
        }

        //console.log("minaxis", minaxis, v);

        if (minaxis !== undefined) {
          v.co[minaxis] = 0.0
          v.flag |= MeshFlags.UPDATE
        }
      }

      mesh.regenBVH()
      mesh.regenRender()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class MeshSubdTest extends MeshOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname  : 'Test Subdiv Reversing',
      icon    : Icons.SUBDIVIDE,
      toolpath: 'mesh.subdiv_test',
      undoflag: 0,
      flag    : 0,
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      meshSubdivideTest(mesh)

      mesh.graphUpdate()
      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.regenBVH()
    }

    window.redraw_viewport()
  }
}

export class SubdivideSimple extends MeshOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname  : 'Subdivide Simple',
      icon    : Icons.SUBDIVIDE,
      toolpath: 'mesh.subdivide_simple',
      undoflag: 0,
      flag    : 0,
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.log('subdivide simple!')

    for (const mesh of this.getMeshes(ctx)) {
      console.log('doing mesh', mesh.lib_id)

      mesh.updateMirrorTags()

      subdivide(mesh, Array.from(mesh.faces.selected.editable), true)

      mesh.regenRender()

      const es = new Set<Edge>()

      for (const e of mesh.edges.selected.editable) {
        if (!e.l) {
          es.add(e)
        }
      }

      //handle wire edges
      const vs = new Set<Vertex>()

      for (const e of es) {
        vs.add(e.v1)
        vs.add(e.v2)

        e.v1.flag |= MeshFlags.UPDATE
        e.v2.flag |= MeshFlags.UPDATE

        const ret = mesh.splitEdge(e, 0.5)

        if (ret.length > 0) {
          vs.add(ret[1])
          mesh.setSelect(ret[0], true)
          mesh.setSelect(ret[1], true)
        }
      }

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.regenBVH()
      mesh.graphUpdate()
    }
  }
}

export class SplitEdgesOp extends MeshOp {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname  : 'Split Edges',
      icon    : Icons.SUBDIVIDE,
      toolpath: 'mesh.split_edges',
      undoflag: 0,
      flag    : 0,
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      mesh.updateMirrorTags()

      const es = new Set(mesh.edges.selected.editable)

      for (const e of es) {
        mesh.splitEdge(e)
      }

      mesh.regenBVH()
      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }
  }
}

export function vertexSmooth_tst(mesh: Mesh, vertsInput = mesh.verts.selected.editable, fac = 0.5) {
  const verts = new Set<Vertex>(vertsInput)

  if (1) {
    const faces = new Set<Face>()

    for (const v of verts) {
      for (const f of v.faces) {
        faces.add(f)
      }
    }

    const ret = subdivide(mesh, faces, true)
    for (const v of ret.newVerts as unknown as Iterable<Vertex>) {
      verts.add(v)
    }

    mesh.regenRender()
    mesh.regenTessellation()
  }

  for (let i = 0; i < 5; i++) {
    vertexSmooth(mesh, verts, fac)
  }
}

export function ccVertexSmooth(
  mesh: Mesh,
  vertsInput = mesh.verts.selected.editable,
  fac = 0.5,
  projection = 0.0
): void {
  const verts = new Set<Vertex>(vertsInput)

  const cd_fset = getFaceSets(mesh, false)
  const cd_dyn_vert = getDynVerts(mesh)

  if (1) {
    const cos = new Map()

    for (const v of verts) {
      cos.set(v, new Vector3(ccSmooth(v, cd_fset, cd_dyn_vert, projection)))
    }

    for (const [v, co] of cos) {
      v.co.interp(co, fac)
      v.flag |= MeshFlags.UPDATE
    }
    return
  }

  const cos = {} as {[k: number]: Vector3}
  for (const v of verts) {
    cos[v.eid] = new Vector3(v.co)

    for (const e of v.edges) {
      const v2 = e.otherVertex(v)

      if (!(v2.eid in cos)) {
        cos[v2.eid] = new Vector3(v2.co)
      }
    }
  }

  const sym = mesh.symFlag

  const c1 = new Vector3()
  const c2 = new Vector3()

  for (const v of verts) {
    v.co.zero()
    let tot = 0.0

    c1.load(cos[v.eid])
    //v.zero().addScalar(1.0);

    for (const e of v.edges) {
      const v2 = e.otherVertex(v)

      if (!(v2.eid in cos)) {
        //console.error("Mesh corruption error!!", v, v2, e);
        continue
      }

      const w = 1.0
      v.co.addFac(cos[v2.eid], w)
      tot += w
    }

    if (tot === 0.0) {
      v.co.load(cos[v.eid])
    } else {
      v.co.mulScalar(1.0 / tot)
      /*
      for (let i=0; i<3; i++) {
        if (1||tot % 2 === 0) {
          v[i] = Math.pow(Math.abs(v[i]), 1.0/tot)*Math.sign(v[i]);
        } else {
          v[i] = Math.pow(v[i], 1.0/tot);
        }
        v[i] += c1[i] - off;
        //v[i] -= 10.0/v.edges.length;
        //v[i] = Math.pow(v[i], 1.0 / tot);
      }
      */

      v.co.interp(cos[v.eid], 1.0 - fac)
    }

    if (v.flag & MeshFlags.MIRRORED && v.flag & MeshFlags.MIRROR_BOUNDARY) {
      for (let i = 0; i < 3; i++) {
        if (sym & (1 << i)) {
          v.co[i as 0 | 1 | 2] = 0.0
        }
      }
    }
  }

  if (0) {
    const faces = new Set<Face>()

    for (const v of verts) {
      for (const f of v.faces) {
        faces.add(f)
      }
    }

    const ret = subdivide(mesh, faces, true)
    for (const v of ret.newVerts as Set<Vertex>) {
      verts.add(v)
    }

    mesh.regenRender()
    mesh.regenTessellation()
  }

  for (const v of verts) {
    //mesh.flagElemUpdate(v);
    v.flag |= MeshFlags.UPDATE
  }
}

export const SmoothTypes = {
  CC     : 1,
  COTAN  : 2,
  UNIFORM: 4,
}

export class SmoothCurvaturesOp extends MeshDeformOp<{
  repeat: IntProperty
  projection: FloatProperty
  factor: FloatProperty
}> {
  constructor() {
    super()
  }

  static tooldef(): ToolDef {
    return {
      uiname  : 'Smooth Curvatures',
      icon    : Icons.SCULPT_SMOOTH,
      toolpath: 'mesh.smooth_curvature_directions',
      undoflag: 0,
      flag    : 0,
      inputs: ToolOp.inherit({
        repeat    : new IntProperty(1).saveLastValue().noUnits().setRange(1, 256),
        projection: new FloatProperty(0.0).saveLastValue().setRange(0.0, 1.0).noUnits(),
        factor    : new FloatProperty(0.5).saveLastValue().setRange(0.0, 1.0).noUnits(),
      }),
    }
  }

  exec(ctx: ToolContext) {
    const fac = this.inputs.factor.getValue()
    const repeat = this.inputs.repeat.getValue()
    const proj = this.inputs.projection.getValue()

    for (const mesh of this.getMeshes(ctx)) {
      const cd_curv = getCurveVerts(mesh)

      for (let i = 0; i < repeat; i++) {
        smoothCurvatures(mesh, mesh.verts.selected.editable, fac, proj)
      }

      mesh.regenRender()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class MarkSingularitiesOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Mark Singularity',
      toolpath: 'mesh.mark_singularity',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      for (const v of mesh.verts.selected.editable) {
        v.flag |= MeshFlags.SINGULARITY | MeshFlags.UPDATE
      }

      mesh.regenRender()
      window.redraw_viewport(true)
    }
  }
}

export class UnmarkSingularitiesOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Unmark Singularity',
      toolpath: 'mesh.unmark_singularity',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      for (const v of mesh.verts.selected.editable) {
        v.flag &= ~MeshFlags.SINGULARITY
        v.flag |= MeshFlags.UPDATE
      }

      mesh.regenRender()
      window.redraw_viewport(true)
    }
  }
}

export class RelaxRakeUVCells extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Relax Rake Cells',
      toolpath: 'mesh.relax_rake_uv_cells',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    const mesh = ctx.mesh!

    const cd_curv = getCurveVerts(mesh)
    //let remesh = new UniformTriRemesher(mesh);
    const cd_fset = getFaceSets(mesh, false)

    for (const v of mesh.verts) {
      //.selected.editable) {
      const cv = v.customData[cd_curv] as unknown as CurvVert

      //cv.check(v, -1, undefined, cd_fset);

      cv._blendStep(v, -1, cd_fset)
      cv.relaxUvCells(v, cd_curv)
      v.flag |= MeshFlags.UPDATE
    }

    for (const v of mesh.verts) {
      //.verts.selected.editable) {
      const cv = v.customData[cd_curv] as unknown as CurvVert
      cv._ignoreUpdate(v, -1)
    }

    mesh.regenRender()
    mesh.recalcNormals()
    window.redraw_viewport(true)
  }
}

export class VertexSmooth extends MeshDeformOp<{
  repeat: IntProperty
  type: EnumProperty
  projection: FloatProperty
  factor: FloatProperty
}> {
  constructor() {
    super()
  }

  static tooldef() {
    return {
      uiname  : 'Vertex Smooth',
      icon    : Icons.SCULPT_SMOOTH,
      toolpath: 'mesh.vertex_smooth',
      undoflag: 0,
      flag    : 0,
      inputs: ToolOp.inherit({
        repeat    : new IntProperty(1).saveLastValue().noUnits().setRange(1, 256),
        type      : new EnumProperty(1, SmoothTypes).saveLastValue(),
        projection: new FloatProperty(0.0).saveLastValue().setRange(0.0, 1.0).noUnits(),
        factor    : new FloatProperty(0.5).saveLastValue().setRange(0.0, 1.0).noUnits(),
      }),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const repeat = this.inputs.repeat.getValue()

      const fac = this.inputs.factor.getValue()
      const proj = this.inputs.projection.getValue()

      const mirrorvs = new Set<Vertex>()

      for (const v of mesh.verts.selected.editable) {
        v.flag |= MeshFlags.UPDATE

        if (v.flag & MeshFlags.MIRROR_BOUNDARY) {
          mirrorvs.add(v)
        }
      }

      for (let i = 0; i < repeat; i++) {
        switch (this.inputs.type.getValue()) {
          case SmoothTypes.CC:
            ccVertexSmooth(mesh, mesh.verts.selected.editable, fac, proj)
            break
          case SmoothTypes.COTAN:
            cotanVertexSmooth(mesh, mesh.verts.selected.editable, fac, proj)
            break
          case SmoothTypes.UNIFORM:
            vertexSmooth(mesh, mesh.verts.selected.editable, fac, proj)
            break
        }

        for (const v of mirrorvs) {
          if (v.flag & MeshFlags.MIRROREDX) {
            v[0] = 0.0
          }

          if (v.flag & MeshFlags.MIRROREDY) {
            v[1] = 0.0
          }

          if (v.flag & MeshFlags.MIRROREDZ) {
            v[2] = 0.0
          }
        }
      }

      mesh.regenTessellation()
      mesh.recalcNormals()

      mesh.regenRender()
      mesh.regenElementsDraw()

      mesh.graphUpdate()
    }
  }
}

const SplitMethods = {
  SMART1: 0,
  SMART2: 1,
  SIMPLE: 2,
}

export class TestSplitFaceOp extends MeshOp<{
  method: EnumProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Split Edges (smart)',
      //icon    : Icons.SPLIT_EDGE,
      toolpath: 'mesh.split_edges_smart',
      inputs: ToolOp.inherit({
        method: new EnumProperty(SplitMethods.SMART2, SplitMethods).saveLastValue(),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.test_split_face')

    for (const mesh of this.getMeshes(ctx)) {
      const es = new Set(mesh.edges.selected.editable)
      const lctx = new LogContext()

      lctx.onnew = (e) => {
        mesh.setSelect(e, true)

        if (e.type === MeshTypes.FACE) {
          for (const l of (e as Face).loops) {
            l.v.flag |= MeshFlags.UPDATE
            l.e.flag |= MeshFlags.UPDATE

            mesh.setSelect(l.e, true)
            mesh.setSelect(l.v, true)
          }
        } else if (e instanceof Edge) {
          e.v1.flag |= MeshFlags.UPDATE
          e.v2.flag |= MeshFlags.UPDATE

          mesh.setSelect(e.v1, true)
          mesh.setSelect(e.v2, true)

          for (const l2 of e.loops) {
            mesh.setSelect(l2.f, true)
          }
        }

        e.flag |= MeshFlags.UPDATE
      }

      const method = this.inputs.method.getValue()

      switch (method) {
        case SplitMethods.SMART1:
          splitEdgesSmart(mesh, es, lctx)
          break
        case SplitMethods.SMART2:
          splitEdgesSmart2(mesh, es, undefined, lctx)
          break
        case SplitMethods.SIMPLE:
          splitEdgesSimple2(mesh, es, undefined, lctx)
          break
      }
      //splitEdgesPreserveQuads(mesh, es, undefined, lctx);

      //console.log(newvs, newfs);

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class TestCollapseOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Test Collapse Edge',
      icon    : Icons.TINY_X,
      toolpath: 'mesh.test_collapse_edge',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.test_collapse_edge')

    for (const mesh of this.getMeshes(ctx)) {
      const vs = new Set<Vertex>()
      const es = new Set<Edge>()

      for (const v of mesh.verts.selected.editable) {
        vs.add(v)
      }

      for (const v of vs) {
        for (const e of v.edges) {
          if (vs.has(e.otherVertex(v))) {
            es.add(e)
          }
        }
      }

      for (const e of es) {
        mesh.collapseEdge(e)
      }
      //let {newvs, newfs} = splitEdgesSmart(mesh, es);
      //console.log(newvs, newfs);

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

const GridTypes = {
  SIMPLE  : 0,
  QUADTREE: 1,
  KDTREE  : 2,
}

export class EnsureGridsOp extends MeshOp<{
  depth: IntProperty
  types: EnumProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Add/Subdivide Grids',
      toolpath: 'mesh.add_or_subdivide_grids',
      icon    : Icons.ADD_GRIDS,
      inputs: ToolOp.inherit({
        depth: new IntProperty(4),
        types: new EnumProperty(GridTypes.SIMPLE, GridTypes),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.ensure_grids')

    const depth = this.inputs.depth.getValue()
    const dimen = gridSides[depth]

    console.log('DIMEN', dimen)

    const type = this.inputs.types.getValue()
    let cls

    if (type === GridTypes.SIMPLE) {
      cls = Grid
    } else if (type === GridTypes.QUADTREE) {
      cls = QuadTreeGrid
    } else {
      cls = KdTreeGrid
    }

    for (const mesh of this.getMeshes(ctx)) {
      const cd_grid = GridBase.meshGridRef(mesh)

      if (!cd_grid.exists) {
        console.log('Adding grids to mesh', mesh)

        cls.initMesh(mesh, dimen, cd_grid)
        //QuadTreeGrid.initMesh(mesh, dimen, -1);
      } else {
        for (const l of mesh.loops) {
          cd_grid.get(l).update(mesh, l, cd_grid)
        }

        for (const l of mesh.loops) {
          const grid = cd_grid.get(l)

          grid.subdivideAll(mesh, l, cd_grid)
          grid.stripExtraData()
        }

        for (const l of mesh.loops) {
          const grid = cd_grid.get(l) as unknown as Grid
          grid.update(mesh, l, cd_grid as unknown as AttrRef<Grid>)
        }
      }

      mesh.regenBVH()
      mesh.regenTessellation()
      mesh.regenRender()
      mesh.regenElementsDraw()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class SubdivideGridsOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Subdivide Grids',
      toolpath: 'mesh.subdivide_grids',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.subdivide_grids')

    for (const mesh of this.getMeshes(ctx)) {
      const cd_grid_i = mesh.loops.customData.getLayerIndex(QuadTreeGrid)
      const cd_grid = new AttrRef<QuadTreeGrid>(cd_grid_i)

      if (cd_grid_i >= 0) {
        for (const l of mesh.loops) {
          const grid = cd_grid.get(l)

          grid.update(mesh, l, cd_grid)
          grid.subdivideAll(mesh, l, cd_grid)
          grid.update(mesh, l, cd_grid)
        }
      }

      mesh.regenBVH()
      mesh.regenTessellation()
      mesh.regenRender()
      mesh.regenElementsDraw()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class SmoothGridsOp extends MeshOp<{
  factor: FloatProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Smooth Grids',
      toolpath: 'mesh.smooth_grids',
      icon    : Icons.SMOOTH_GRIDS,
      inputs: ToolOp.inherit({
        factor: new FloatProperty(0.25).setRange(0.01, 2.0),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.smooth_grids')

    const fac = this.inputs.factor.getValue()

    function doSmooth(mesh: Mesh, cd_grid: AttrRef<Grid>) {
      for (let i = 0; i < 1; i++) {
        for (const l of mesh.loops) {
          const grid = cd_grid.get(l)

          //grid.recalcFlag |= QRecalcFlags.ALL | QRecalcFlags.NORMALS | QRecalcFlags.LEAVES | QRecalcFlags.NEIGHBORS | QRecalcFlags.POINTHASH;
          //grid.recalcFlag |= QRecalcFlags.LEAF_POINTS | QRecalcFlags.LEAF_NODES;
          //grid.recalcFlag |= QRecalcFlags.ALL | QRecalcFlags.NORMALS | QRecalcFlags.LEAVES | QRecalcFlags.NEIGHBORS;

          grid.update(mesh, l, cd_grid)
        }
      }

      for (let i = 0; i < 3; i++) {
        for (const l of mesh.loops) {
          const grid = cd_grid.get(l) as unknown as QuadTreeGrid
          const ps = grid.points

          const p1 = ps[0]
          const p2 = ps[1]
          const p3 = ps[2]
          const p4 = ps[3]

          for (const p of grid.points) {
            grid.smoothPoint(p, fac)
          }
        }
      }

      for (let i = 0; i < 3; i++) {
        for (const l of mesh.loops) {
          const grid = l.customData.get<QuadTreeGrid>(cd_grid.i)
          grid.stitchBoundaries()
        }
      }

      for (const l of mesh.loops) {
        const grid = l.customData.get<Grid>(cd_grid.i)
        grid.recalcFlag |= QRecalcFlags.ALL | QRecalcFlags.NORMALS | QRecalcFlags.LEAVES | QRecalcFlags.NEIGHBORS
        grid.update(mesh, l, cd_grid)
      }
    }

    for (const mesh of this.getMeshes(ctx)) {
      let cd_grid = mesh.loops.customData.getLayerIndex(QuadTreeGrid)

      if (cd_grid < 0) {
        cd_grid = mesh.loops.customData.getLayerIndex(KdTreeGrid)
      }

      if (cd_grid < 0) {
        continue
      }

      doSmooth(mesh, new AttrRef<Grid>(cd_grid))

      if (0) {
        let depth = 0

        for (const l of mesh.loops) {
          const grid = l.customData.get<QuadTreeGrid>(cd_grid)
          depth = Math.max(depth, grid.nodes[QuadTreeFields.QSUBTREE_DEPTH])
        }
        console.log('MRES DEPTH', depth)

        const mres = mesh.loops.customData.getLayerSettings(QuadTreeGrid)!
        const oldmres = mres.copy()

        const start = depth === 0 ? 0 : 1

        for (let i = 1; i <= Math.ceil(depth / 2); i++) {
          mres.flag |= GridSettingFlags.ENABLE_DEPTH_LIMIT
          mres.depthLimit = i * 2

          doSmooth(mesh, new AttrRef<Grid>(cd_grid))
        }

        oldmres.copyTo(mres)
      }

      mesh.regenBVH()
      mesh.regenTessellation()
      mesh.regenRender()
      mesh.regenElementsDraw()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

const staroffs = [
  [-1, 0],
  [1, 0],
  [0, 1],
  [0, -1],
]

const staroffs_origin = [
  [-1, 0],
  [1, 0],
  [0, 1],
  [0, -1],
  [0, 0],
]

const boxoffs = [] as number[][]

for (let ix = -1; ix <= 1; ix++) {
  for (let iy = -1; iy <= 1; iy++) {
    boxoffs.push([ix, iy])
  }
}

export class GridsTestOp2 extends MeshOp<{
  factor: FloatProperty
  setColors: BoolProperty
}> {
  static tooldef(): ToolDef {
    return {
      uiname  : 'Grid Test 2',
      toolpath: 'mesh.grids_test',
      icon    : Icons.GRIDS_TEST,
      inputs: ToolOp.inherit({
        factor   : new FloatProperty(0.25).setRange(0.01, 2.0),
        setColors: new BoolProperty(false),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    const mesh = ctx.mesh!

    const gridAttr = mesh.loops.customData.getLayerRef(QuadTreeGrid)
    const cd_grid = mesh.loops.customData.getLayerIndex(QuadTreeGrid)
    if (cd_grid < 0) {
      return
    }

    for (const l of mesh.loops) {
      const grid = l.customData[cd_grid] as unknown as QuadTreeGrid

      grid.recalcFlag |= QRecalcFlags.TOPO | QRecalcFlags.POLYS
      grid.update(mesh, l, gridAttr)
    }

    for (const l of mesh.loops) {
      const grid = l.customData[cd_grid] as QuadTreeGrid

      grid.recalcFlag |= QRecalcFlags.NEIGHBORS
      grid.update(mesh, l, gridAttr)
    }

    for (const l of mesh.loops) {
      const grid = l.customData[cd_grid] as QuadTreeGrid

      for (const pi of grid.getLeafPoints()) {
        const p = grid.points[pi]

        p.load(p.sco)
      }

      grid.recalcFlag |= QRecalcFlags.NORMALS
    }

    for (const l of mesh.loops) {
      const grid = l.customData[cd_grid] as QuadTreeGrid

      grid.update(mesh, l, gridAttr)
    }

    mesh.regenRender()
    mesh.regenBVH()
    mesh.graphUpdate()

    window.redraw_viewport(true)
  }
}

export class GridsTestOp extends MeshOp<{
  factor: FloatProperty
  setColors: BoolProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Grids Debug Test',
      toolpath: 'mesh.grids_test2',
      icon    : Icons.GRIDS_TEST,
      inputs: ToolOp.inherit({
        factor   : new FloatProperty(0.25).setRange(0.01, 2.0),
        setColors: new BoolProperty(false),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.grids_test')

    const fac = this.inputs.factor.getValue()

    /* XXX hack access of view context! */
    const view3d = (ctx.state.ctx as any).view3d
    view3d.resetDrawLines()

    function makeDrawLine(a: Vector3, b: Vector3, color?: Vector4 | string) {
      if (!('dd' in window)) {
        return view3d.makeDrawLine(a, b, color)
      }
    }

    const QPOINT1 = QuadTreeFields.QPOINT1
    const QPARENT = QuadTreeFields.QPARENT
    const QDEPTH = QuadTreeFields.QDEPTH
    const QSUBTREE_DEPTH = QuadTreeFields.QSUBTREE_DEPTH
    const QMINU = QuadTreeFields.QMINU
    const QMINV = QuadTreeFields.QMINV
    const QMAXU = QuadTreeFields.QMAXU
    const QMAXV = QuadTreeFields.QMAXV

    if (1) {
      //for (let mesh of this.getMeshes(ctx)) {
      const mesh = ctx.mesh!
      let gridAttr = mesh.loops.customData.getLayerRef(Grid) as AttrRef<any>

      if (gridAttr.i >= 0) {
        buildGridsSubSurf(mesh, this.inputs.setColors.getValue())
      }

      gridAttr = mesh.loops.customData.getLayerRef(QuadTreeGrid)
      if (gridAttr.i >= 0) {
        const p1 = new Vector3()
        const p2 = new Vector3()
        const temps = util.cachering.fromConstructor(Vector3, 64)

        const cd_grid = gridAttr.i

        for (const l of mesh.loops) {
          const grid = l.customData[cd_grid] as QuadTreeGrid

          grid.recalcFlag |= QRecalcFlags.TOPO
          grid.update(mesh, l, gridAttr)
        }

        for (const l of mesh.loops) {
          const grid = l.customData[cd_grid] as QuadTreeGrid
          grid.update(mesh, l, gridAttr)
          grid.recalcNeighbors(mesh, l, gridAttr)
        }

        for (const l of mesh.loops) {
          const grid = l.customData[cd_grid] as QuadTreeGrid
          grid.update(mesh, l, gridAttr)

          for (const p of grid.points) {
            p.orig = new Vector3(p.co)
          }
        }

        function getp(p: QTGridVert, o: Vector3, depth: number, grid: QuadTreeGrid) {
          const co = new Vector3()

          let tot = 0.0

          const dimen = gridSides[depth] - 1
          const dt = 1.0 / dimen

          const uv = p.uv

          for (const off of staroffs) {
            const u = uv[0] + off[0] * dt
            const v = uv[1] + off[1] * dt

            const co2 = grid.evaluate(u, v)
            co.add(co2)
            tot++
          }

          if (tot) {
            co.mulScalar(1.0 / tot)
            co.interp(p.orig!, 1.0 / 2.0)
          } else {
            co.load(p.orig!)
          }

          return co
        }

        function makePatch(
          grid: GridBase,
          ni: number,
          ns: number[],
          p1: GridVertBase<any>,
          p2: GridVertBase<any>,
          p3: GridVertBase<any>,
          p4: GridVertBase<any>,
          o1: Vector3,
          o2: Vector3,
          o3: Vector3,
          o4: Vector3
        ): CubicPatch {
          const p = new CubicPatch()

          const depth = ns[ni + QDEPTH]

          o1 = getp(p1 as QTGridVert, o1, depth, grid as unknown as QuadTreeGrid)
          o2 = getp(p2 as QTGridVert, o2, depth, grid as unknown as QuadTreeGrid)
          o3 = getp(p3 as QTGridVert, o3, depth, grid as unknown as QuadTreeGrid)
          o4 = getp(p4 as QTGridVert, o4, depth, grid as unknown as QuadTreeGrid)

          let clr = 'green'
          //*
          makeDrawLine(o1, o2, clr)
          makeDrawLine(o2, o3, clr)
          makeDrawLine(o3, o4, clr)
          makeDrawLine(o4, o1, clr)
          //*/

          p.basis = bernstein
          //let cent = new Vector3();
          //cent.load(o1).add(o2).add(o3).add(o4).mulScalar(1.0 / 4.0);

          function set(x: number, y: number, co: Vector3): void {
            for (let x2 = x; x2 < x + 2; x2++) {
              for (let y2 = y; y2 < y + 2; y2++) {
                p.setPoint(x2, y2, co)
              }
            }
          }

          const a = new Vector3()
          const b = new Vector3()
          const c = new Vector3()

          const disable = 0

          for (let x = 0; x < 4; x++) {
            const u = x / 3

            for (let y = 0; y < 4; y++) {
              const v = y / 3

              if (!disable && x >= 1 && x <= 2 && y >= 1 && y <= 2) {
                continue
              }
              a.load(o1).interp(o2, v)
              b.load(o4).interp(o3, v)
              a.interp(b, u)
              p.setPoint(x, y, a)
            }
          }

          if (disable) {
            return p
          }

          const l1 = o1.vectorDistance(o2)
          const l3 = o3.vectorDistance(o4)

          const l2 = o2.vectorDistance(o3)
          const l4 = o4.vectorDistance(o1)

          const d = 1.0 / 3.0 //window.d2 ?? 1.0 / 3.0;
          const d2 = 0.0 //window.d3 ?? 0.0;

          const dfac = 1.0 / Math.pow(2, depth)

          function gt(p: Vector3 | number[]): Vector3 {
            return new Vector3(p).mulScalar(dfac)
          }

          function gn(p1: GridVertBase<any>, p2: GridVertBase<any>, t: number): Vector3 {
            const n = new Vector3()

            const l = p1.co.vectorDistance(p2.co) * d2
            n.load(p1.no).interp(p2.no, t).normalize().mulScalar(l)
            return n
            /*

            let t1 = gt(p1.tan);
            let t2 = gt(p2.tan);
            let b1 = gt(p1.bin);
            let b2 = gt(p2.bin);

            t2.sub(t1);
            b2.sub(b1);

            n.load(b2).cross(t2).mulScalar(d2);
            l = n.vectorLength();

            n.load(p1.no).interp(p2.no, t).normalize().mulScalar(l);
            return n;
            */
          }

          /*
          function sinterp(v2, t) {
            let l1 = v1.vectorLength();
            let l2 = v2.vectorLength();

            v1.interp(v2, t).normalize().mulScalar(l1 + (l2 - l1) * t);
            return v1;
          }

          Vector3.prototype.sinterp = sinterp;
          */

          if (!disable) {
            for (let i = 0; i < 2; i++) {
              const t = (i + 1.0) / 3.0

              let mul2 = l1 + (l3 - l1) * t
              let mul1 = l2 + (l4 - l2) * t

              mul1 *= d
              mul2 *= d

              c.load(o1).interp(o2, t)
              b.load(gt(p1.tan)).sinterp(gt(p2.tan), t).mulScalar(d)
              a.load(c).addFac(b, 1.0)
              makeDrawLine(c, a, 'red')

              p.addPoint(1, i + 1, a)
              a.load(gn(p1, p2, t))
              p.addPoint(1, i + 1, a, false)
              p.addPoint(0, i + 1, a, false)

              c.load(o4).interp(o3, t)
              b.load(gt(p4.tan)).sinterp(gt(p3.tan), t).mulScalar(d)
              a.load(c).addFac(b, -1.0)
              makeDrawLine(c, a, 'red')

              p.addPoint(2, i + 1, a)
              a.load(gn(p4, p3, t))
              p.addPoint(2, i + 1, a, false)
              p.addPoint(3, i + 1, a, false)

              //*
              c.load(o1).interp(o4, t)
              b.load(gt(p1.bin)).sinterp(gt(p4.bin), t).mulScalar(d)
              a.load(c).addFac(b, 1.0)
              makeDrawLine(c, a, 'red')

              p.addPoint(i + 1, 1, a)
              a.load(gn(p1, p4, t))
              p.addPoint(i + 1, 1, a, false)
              p.addPoint(i + 1, 0, a, false)

              c.load(o2).interp(o3, t)
              b.load(gt(p2.bin)).sinterp(gt(p3.bin), t).mulScalar(d)
              a.load(c).addFac(b, -1.0)
              makeDrawLine(c, a, 'red')

              p.addPoint(i + 1, 2, a, true)
              a.load(gn(p2, p3, t))
              p.addPoint(i + 1, 2, a, false)
              p.addPoint(i + 1, 3, a, false)
              //*/
            }

            /*
            let ww = window.d5 ?? 0.0;
            p.addPoint(0, 0, p1.sco, true, ww);
            p.addPoint(0, 1, p2.sco, true, ww);
            p.addPoint(1, 1, p3.sco, true, ww);
            p.addPoint(1, 0, p4.sco, true, ww);
            */

            /*
            p.addPoint(0, 0, p1.no, false, d*d2);
            p.addPoint(0, 1, p2.no, false, d*d2);
            p.addPoint(1, 1, p3.no, false, d*d2);
            p.addPoint(1, 0, p4.no, false, d*d2);
            */

            p.finishPoints()
          }

          clr = 'orange'
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
              const a = p.getPoint(i, j)
              const b = p.getPoint(i, j + 1)
              const c = p.getPoint(i + 1, j + 1)
              const d = p.getPoint(i, j + 1)

              makeDrawLine(a, b, clr)
              makeDrawLine(b, c, clr)
              makeDrawLine(c, d, clr)
              makeDrawLine(d, a, clr)
            }
          }
          return p
        }

        for (const l of mesh.loops) {
          const doneset = new WeakSet()

          const grid = l.customData[cd_grid] as QuadTreeGrid
          const ns = grid.nodes
          const ps = grid.points

          const patches = new Map()

          const origco = new Map()
          for (const p of grid.points) {
            origco.set(p, new Vector3(p.co))
          }

          for (const ni of grid.getLeafNodes()) {
            if (ni === 0) {
              continue
            }

            for (let i = 0; i < 4; i++) {
              const pi = ns[ni + QPOINT1 + i]
              const p = ps[pi]

              if (doneset.has(p)) {
                continue
              }

              const uv = grid._getUV(ni, i)
              doneset.add(p)

              let ni2 = ns[ni + QPARENT]

              for (let j = 0; j < 2; j++) {
                if (ni2) {
                  ni2 = ns[ni2 + QPARENT]
                }
              }

              const u = (uv[0] - ns[ni2 + QMINU]) / (ns[ni2 + QMAXU] - ns[ni2 + QMINU])
              const v = (uv[1] - ns[ni2 + QMINV]) / (ns[ni2 + QMAXV] - ns[ni2 + QMINV])

              const p1 = ps[ns[ni2 + QPOINT1]]
              const p2 = ps[ns[ni2 + QPOINT1 + 1]]
              const p3 = ps[ns[ni2 + QPOINT1 + 2]]
              const p4 = ps[ns[ni2 + QPOINT1 + 3]]

              const p1b = origco.get(p1)
              const p2b = origco.get(p2)
              const p3b = origco.get(p3)
              const p4b = origco.get(p4)

              const a = temps.next()
              const b = temps.next()

              a.load(p1b).interp(p2b, v)
              b.load(p4b).interp(p3b, v)
              a.interp(b, u)

              let patch = patches.get(ni2)
              if (!patch) {
                patch = makePatch(grid as unknown as GridBase, ni2, ns, p1, p2, p3, p4, p1b, p2b, p3b, p4b)
                patches.set(ni2, patch)
              }

              p.load(patch.evaluate(u, v))
              p.load(grid.subsurf!.evaluate(uv[0], uv[1]))
            }
          }

          /*
          for (let pi of grid.getLeafPoints()) {
            let p = grid.points[pi];

            //p1.load(p).sub(p.sco);
            //p.addFac(p1, 0.5);
            p.load(p.sco);
          }
          */
        }

        for (const l of mesh.loops) {
          const grid = l.customData[cd_grid] as QuadTreeGrid
          grid.recalcFlag |= QRecalcFlags.ALL
          grid.update(mesh, l, gridAttr)
        }
      }

      mesh.regenBVH()
      mesh.regenTessellation()
      mesh.regenRender()
      mesh.regenElementsDraw()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }

  undo(ctx: ToolContext) {
    super.undo(ctx)

    // XXX hackish! accessing view context here!!
    const view3d = (ctx.state.ctx as any).view3d as unknown as View3D
    if (view3d) {
      view3d.resetDrawLines()
    }
  }
}

export class DeleteGridsOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Delete Grids',
      icon    : Icons.DELETE_GRIDS,
      toolpath: 'mesh.delete_grids',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.delete_grids')

    for (const mesh of this.getMeshes(ctx)) {
      const off = GridBase.meshGridOffset(mesh)

      if (off >= 0) {
        console.log('Deleting grids from mesh', mesh)

        mesh.loops.removeCustomDataLayer(off)
      }

      //force bvh update
      mesh.bvh = undefined

      mesh.regenRender()
      mesh.regenTessellation()
      mesh.regenElementsDraw()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class ResetGridsOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Reset Grids',
      icon    : Icons.RESET_GRIDS,
      toolpath: 'mesh.reset_grids',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.reset_grids')

    for (const mesh of this.getMeshes(ctx)) {
      const off = GridBase.meshGridOffset(mesh)
      if (off < 0) {
        continue
      }

      console.log('resetting grids')

      for (const f of mesh.faces) {
        f.calcCent()
      }

      for (const l of mesh.loops) {
        const grid = l.customData.get<Grid>(off)

        grid.init(grid.dimen, mesh, l, new AttrRef<Grid>(off))
      }

      //force bvh reload
      if (mesh.bvh) {
        mesh.bvh.destroy(mesh)
      }
      mesh.bvh = undefined

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.regenElementsDraw()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class ApplyGridBaseOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Apply Base',
      icon    : Icons.APPLY_GRIDS_BASE,
      toolpath: 'mesh.apply_grid_base',
      inputs  : ToolOp.inherit({}),
      outputs : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.apply_grid_base')

    for (const mesh of this.getMeshes(ctx)) {
      const off = GridBase.meshGridOffset(mesh)
      if (off < 0) {
        continue
      }

      for (const l of mesh.loops) {
        const grid = l.customData.get<Grid>(off)

        grid.applyBase(mesh, l, new AttrRef<Grid>(off))
      }

      //force bvh reload
      if (mesh.bvh) {
        mesh.bvh.destroy(mesh)
      }
      mesh.bvh = undefined

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.regenElementsDraw()
      mesh.graphUpdate()
    }

    window.redraw_viewport()
  }
}

export class AddCDLayerOp extends MeshOp<
  {
    elemType: EnumProperty<number>
    layerType: StringProperty
    name: StringProperty
  },
  {
    layerIndex: IntProperty
  }
> {
  static tooldef() {
    return {
      uiname  : 'Add Data Layer',
      icon    : Icons.SMALL_PLUS,
      toolpath: 'mesh.add_cd_layer',
      inputs: ToolOp.inherit({
        elemType : new EnumProperty(MeshTypes.VERTEX, MeshTypes),
        layerType: new StringProperty('uv'),
        name     : new StringProperty(''),
      }),
      outputs: ToolOp.inherit({
        layerIndex: new IntProperty(-1),
      }),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.add_cd_layer')

    for (const mesh of this.getMeshes(ctx)) {
      let name = this.inputs.name.getValue().trim() as string | undefined
      if (name === '') {
        name = undefined
      }

      const type = this.inputs.elemType.getValue()
      const elist = mesh.getElemList(type)

      const typecls = CustomDataElem.getTypeClass(this.inputs.layerType.getValue())
      if (!typecls) {
        ctx.error('Unknown layer type ' + this.inputs.layerType.getValue())
        return
      }

      const ret = elist.addCustomDataLayer(typecls, name)

      if (ret) {
        this.outputs.layerIndex.setValue(ret.index)
      }

      //XXX add support for MeshOp to only operate on active mesh
      break
    }

    window.redraw_viewport()
  }
}

export class RemCDLayerOp extends MeshOp<{
  elemType: EnumProperty<number>
  layerType: StringProperty
  name: StringProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Remove Data Layer',
      icon    : Icons.SMALL_PLUS,
      toolpath: 'mesh.remove_cd_layer',
      inputs: ToolOp.inherit({
        elemType : new EnumProperty(MeshTypes.VERTEX, MeshTypes),
        layerType: new StringProperty('uv'),
        name     : new StringProperty(''),
      }),
    }
  }

  exec(ctx: ToolContext) {
    console.warn('mesh.remove_cd_layer')

    for (const mesh of this.getMeshes(ctx)) {
      let name = this.inputs.name.getValue().trim() as string | undefined
      if (name === '') {
        name = undefined
      }

      const type = this.inputs.elemType.getValue()
      const elist = mesh.getElemList(type)

      const typecls = CustomDataElem.getTypeClass(this.inputs.layerType.getValue())
      if (!typecls) {
        ctx.error('Unknown layer type ' + this.inputs.layerType.getValue())
        continue
      }

      const off = elist.customData.getLayerIndex(typecls)

      if (off < 0) {
        ctx.error('no cd layers')
        continue
      }

      elist.removeCustomDataLayer(off)

      //XXX add support for MeshOp to only operate on active mesh
      break
    }

    window.redraw_viewport()
  }
}

export class TestMultiGridSmoothOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Test MultiGrid Smoother',
      toolpath: 'mesh.test_multigrid_smooth',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    console.log('mesh.test_multigrid_smooth()')

    for (const mesh of this.getMeshes(ctx)) {
      const ms = new MultiGridSmoother(mesh)

      for (const v of mesh.verts) {
        ms.addVert(v)
      }
      ms.update()

      mesh.selectNone()

      for (const v of ms.levels[0].superVerts) {
        mesh.verts.setSelect(v, true)
        v.flag |= MeshFlags.UPDATE

        //v.addFac(v.no, 0.5);
      }

      const supers = ms.getSuperVerts(mesh.verts) as Set<Vertex>

      ms.smooth(
        supers as unknown as any[],
        (v: Vertex): number => {
          return 1.0 //XXX
          /*
        if (v.flag & MeshFlags.SELECT) {
          return 1.0;
        }

        return 0.0;
        */
        },
        0.5
      )

      console.log('SuperVerts:', supers)

      ms.finish()

      mesh.recalcNormals()
      mesh.regenElementsDraw()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport(true)
  }
}

export class FixNormalsOp extends MeshOp<{
  outside: BoolProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Recalc Normals',
      toolpath: 'mesh.fix_normals',
      inputs: ToolOp.inherit({
        outside: new BoolProperty(true),
      }),
    }
  }

  exec(ctx: ToolContext) {
    console.log('mesh.test_multigrid_smooth()')

    for (const mesh of this.getMeshes(ctx)) {
      recalcWindings(mesh, mesh.faces.selected.editable)

      if (!this.inputs.outside.getValue()) {
        for (const f of mesh.faces.selected.editable) {
          mesh.reverseWinding(f)
        }
      }

      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenElementsDraw()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport(true)
  }
}

export class FixManifoldOp extends MeshOp<{
  fixLooseGeometry: BoolProperty
  minIslandVerts: IntProperty
}> {
  static tooldef() {
    return {
      uiname     : 'Fix Manifold',
      description: 'Fix manifold errors (except for holes)',
      toolpath   : 'mesh.fix_manifold',
      inputs: ToolOp.inherit({
        fixLooseGeometry: new BoolProperty(true).saveLastValue(),
        minIslandVerts: new IntProperty(5)
          .noUnits()
          .setRange(0, 1024 * 16)
          .setStep(5)
          .saveLastValue(),
      }),
    }
  }

  exec(ctx: ToolContext) {
    console.log('mesh.test_multigrid_smooth()')

    function calcEulerPoincare(mesh: Mesh) {
      const v = mesh.verts.length
      let l = 0
      for (const f of mesh.faces) {
        l += f.lists.length
      }
      const e = mesh.edges.length
      const s = 1
      const g = 0
      const f = mesh.faces.length

      return v - e + f - (l - f) - 2 * (s - g)
    }

    for (const mesh of this.getMeshes(ctx)) {
      mesh.validateMesh()

      console.log('euler-poincare:', calcEulerPoincare(mesh))

      const lctx = new LogContext()

      lctx.onnew = (e) => {
        mesh.setSelect(e, true)

        if (e.type === MeshTypes.FACE) {
          for (const l of (e as Face).loops) {
            mesh.setSelect(l.v, true)
            mesh.setSelect(l.e, true)
          }
        }
      }

      for (let i = 0; i < 1000; i++) {
        if (!fixManifold(mesh, lctx)) {
          break
        }
      }

      if (this.inputs.fixLooseGeometry.getValue()) {
        const minverts = this.inputs.minIslandVerts.getValue()
        pruneLooseGeometry(mesh, lctx, minverts)
      }

      recalcWindings(mesh, mesh.faces, lctx)

      mesh.fixLoops()

      console.log('euler-poincare:', calcEulerPoincare(mesh))

      mesh.regenBVH()
      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenElementsDraw()
      mesh.regenRender()
      mesh.graphUpdate()
    }

    window.redraw_viewport(true)
  }
}

export class ConnectVertsOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Connect Verts',
      toolpath: 'mesh.connect_verts',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const vs = Array.from(mesh.verts.selected.editable)

      if (vs.length === 2) {
        const v1 = vs[0]
        const v2 = vs[1]

        connectVerts(mesh, v1, v2)
        const e = mesh.getEdge(v1, v2)

        if (e) {
          mesh.setSelect(e, true)
        }
      }

      //mesh.selectFlush();

      mesh.regenBVH()
      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.regenRender()
      mesh.graphUpdate()
    }
  }
}

export class DissolveVertOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Dissolve Vertices',
      toolpath: 'mesh.dissolve_verts',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const vs = new Set(mesh.verts.selected.editable)
      if (vs.size === 0) {
        continue
      }

      const lctx = new LogContext()
      lctx.onnew = (e) => {
        e.flag |= MeshFlags.UPDATE

        if (e.type === MeshTypes.FACE) {
          for (const l of (e as Face).loops) {
            mesh.setSelect(l.v, true)
            mesh.setSelect(l.e, true)
          }
        }

        mesh.setSelect(e, true)
      }

      for (const v of vs) {
        if (v.valence === 2) {
          mesh.joinTwoEdges(v, lctx)
        } else {
          mesh.dissolveVertex(v, lctx)
        }
      }

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class CleanupQuads extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Cleanup Quads',
      toolpath: 'mesh.cleanup_quads',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const faces = new Set(mesh.faces.selected.editable)

      const lctx = new LogContext()
      let newfs = new Set<Face>()

      lctx.onnew = (e) => {
        mesh.setSelect(e, true)

        if (e.type === MeshTypes.FACE) {
          newfs.add(e as Face)
        }
      }

      trianglesToQuads(mesh, faces, undefined, lctx)

      for (const f of faces) {
        if (f.eid >= 0) {
          newfs.add(f)
        }
      }

      newfs = newfs.filter((f: Face) => f.eid >= 0)
      cleanupQuads(mesh, new Set(newfs), lctx)

      const vs = new Set<Vertex>()
      for (const f of newfs) {
        if (f.eid < 0) {
          continue
        }

        for (const l of f.loops) {
          vs.add(l.v)
        }
      }

      mesh.updateBoundaryFlags()

      for (let i = 0; i < 1; i++) {
        vertexSmooth(mesh, vs, 0.5, 0.5, true)
      }

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class CleanupTris extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Cleanup Tris',
      toolpath: 'mesh.cleanup_tris',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      let faces = new Set(mesh.faces.selected.editable)

      const lctx = new LogContext()
      const newfs = new Set<Face>()

      lctx.onnew = (e: Element): void => {
        mesh.setSelect(e, true)

        if (e.type === MeshTypes.FACE) {
          newfs.add(e as Face)
        }
      }

      for (let i = 0; i < 5; i++) {
        faces = new Set(mesh.faces.selected.editable)
        cleanupTris(mesh, faces, lctx)
      }

      const vs = new Set<Vertex>()
      for (const f of newfs) {
        if (f.eid < 0) {
          continue
        }

        for (const l of f.loops) {
          vs.add(l.v)
        }
      }

      vertexSmooth(mesh, vs, 0.5, 0.5)

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class DissolveEdgesOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Dissolve Edges',
      toolpath: 'mesh.dissolve_edges',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const lctx = new LogContext()
      lctx.onnew = (e) => {
        mesh.setSelect(e, true)
      }

      for (const e of new Set(mesh.edges.selected.editable)) {
        if (e.eid < 0) {
          continue
        }

        mesh.dissolveEdge(e, lctx)
      }

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export const RotateEdgeModes = {
  FORWARD : 0,
  BACKWARD: 1,
}

export class RotateEdgeOp extends MeshOp<{
  mode: EnumProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Rotate Edges',
      toolpath: 'mesh.rotate_edges',
      inputs: ToolOp.inherit({
        mode: new EnumProperty(0, RotateEdgeModes),
      }),
    }
  }

  exec(ctx: ToolContext) {
    const mode = this.inputs.mode.getValue()

    for (const mesh of this.getMeshes(ctx)) {
      const lctx = new LogContext()
      lctx.onnew = (e) => {
        if (e.type !== MeshTypes.FACE) {
          mesh.setSelect(e, true)
        }
      }

      for (const e of new Set(mesh.edges.selected.editable)) {
        if (e.eid >= 0) {
          mesh.rotateEdge(e, !mode ? 1 : -1, lctx)
        }
      }

      //rotating edges messes up partial GL update,
      //as topology changes happen without changing the
      //element count
      mesh._clearGPUMeshes()

      mesh.regenAll()
      mesh.regenTessellation()
      mesh.recalcNormals()
      mesh.graphUpdate()

      window.redraw_viewport(true)
    }
  }
}

export class CollapseEdgesOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Collapse Edges',
      toolpath: 'mesh.collapse_edges',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const lctx = new LogContext()
      lctx.onnew = (e) => {
        mesh.setSelect(e, true)
      }

      for (const e of new Set(mesh.edges.selected.editable)) {
        if (e.eid < 0) {
          continue
        }

        mesh.collapseEdge(e, undefined, lctx)
      }

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class RandomCollapseOp extends MeshOp<{
  probability: FloatProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Random Flip',
      toolpath: 'mesh.random_flip_edges',
      inputs: ToolOp.inherit({
        probability: new FloatProperty(0.85).saveLastValue(),
      }),
    }
  }

  exec(ctx: ToolContext) {
    const prob = this.inputs.probability.getValue()

    for (const mesh of this.getMeshes(ctx)) {
      const es = new Set<Edge>()

      for (const e of mesh.edges.selected.editable) {
        if (Math.random() > 0.8) {
          continue
        }

        let bad = false

        for (let i = 0; i < 2; i++) {
          const v = i ? e.v2 : e.v1
          for (const e2 of v.edges) {
            if (es.has(e2)) {
              bad = true
            }
          }
        }

        if (!bad) {
          es.add(e)
        }
      }

      for (const e of es) {
        if (e.eid < 0) {
          continue
        }

        if (Math.random() > prob) {
          continue
        }

        e.v1.flag |= MeshFlags.UPDATE
        e.v2.flag |= MeshFlags.UPDATE
        e.flag |= MeshFlags.UPDATE

        mesh.rotateEdge(e, Math.random() > 0.5 ? 1 : -1)
      }

      //rotating edges messes up partial GL update,
      //as topology changes happen without changing the
      //element count
      mesh._clearGPUMeshes(window._gl)

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class DissolveEdgeLoopsOp extends MeshOp<{
  ensureQuads: BoolProperty
  selectFaces: BoolProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Dissolve Loops',
      toolpath: 'mesh.dissolve_edgeloops',
      inputs: ToolOp.inherit({
        ensureQuads: new BoolProperty(false).saveLastValue(),
        selectFaces: new BoolProperty(false).saveLastValue(),
      }),
    }
  }

  exec(ctx: ToolContext) {
    const ensureQuads = this.inputs.ensureQuads.getValue()
    const selmask = ctx.selectMask

    for (const mesh of this.getMeshes(ctx)) {
      const lctx = new LogContext()

      const es = new Set(mesh.edges.selected.editable)

      if (this.inputs.selectFaces.getValue()) {
        for (const e of es) {
          for (const l of e.loops) {
            mesh.setSelect(l.f, true)

            for (const l2 of l.f.loops) {
              if (selmask & MeshTypes.EDGE) {
                l2.e.flag |= MeshFlags.UPDATE
                l2.v.flag |= MeshFlags.UPDATE
                mesh.setSelect(l2.e, true)
              }

              if (selmask & MeshTypes.VERTEX) {
                l2.v.flag |= MeshFlags.UPDATE
                mesh.setSelect(l2.v, true)
              }
            }

            l.f.flag |= MeshFlags.UPDATE
          }
        }
      }

      lctx.onnew = (elem) => {
        elem.flag |= MeshFlags.UPDATE
        mesh.setSelect(elem, true)
      }

      dissolveEdgeLoops(mesh, es, ensureQuads, lctx)

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class FlipNormalsOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Flip Normals',
      toolpath: 'mesh.flip_normals',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      for (const f of mesh.faces.selected.editable) {
        mesh.reverseWinding(f)
        f.flag |= MeshFlags.UPDATE

        for (const v of f.verts) {
          v.flag |= MeshFlags.UPDATE
        }
      }

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()

      window.updateDataGraph()
      window.redraw_viewport(true)
    }
  }
}

export class QuadSmoothOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Quad Smooth Test',
      toolpath: 'mesh.quad_smooth',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const lctx = new LogContext()

      lctx.onnew = (elem) => {
        mesh.setSelect(elem, true)
        elem.flag |= MeshFlags.UPDATE
      }

      function smooth() {
        for (let i = 0; i < 1; i++) {
          vertexSmooth(mesh, vs)
        }
      }

      const vs = new Set<Vertex>()
      for (const f of mesh.faces.selected.editable) {
        for (const v of f.verts) {
          vs.add(v)
        }
      }

      triangulateMesh(mesh, mesh.faces.selected.editable, lctx)
      smooth()
      mesh.recalcNormals()

      trianglesToQuads(mesh, mesh.faces.selected.editable, undefined, lctx)
      smooth()

      mesh.regenAll()
      mesh.recalcNormals()
      mesh.graphUpdate()
      window.redraw_viewport(true)
    }
  }
}

export class TestSmoothOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Test Color Smooth',
      toolpath: 'mesh.test_color_smooth',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      _testMVC(mesh)

      mesh.regenAll()
      mesh.recalcNormals()
      window.redraw_viewport(true)
    }
  }
}

export class DissolveFacesOp extends MeshOp {
  static tooldef() {
    return {
      uiname  : 'Dissolve Faces',
      toolpath: 'mesh.dissolve_faces',
      inputs  : ToolOp.inherit({}),
    }
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const faces = mesh.faces.selected.editable

      dissolveFaces(mesh, faces)

      mesh.regenAll()
      window.redraw_viewport(true)
    }
  }
}

export class OptRemeshParams extends ToolOp<{
  edgeGoal: FloatProperty
}> {
  remesher?: Remesher

  constructor() {
    super()

    this.remesher = undefined
  }

  static tooldef() {
    return {
      uiname  : 'Optimize Remesh Params',
      toolpath: 'mesh.opt_remesh_params',
      undoflag: UndoFlags.NO_UNDO,
      inputs: {
        edgeGoal: new FloatProperty(0.75),
      },
      outputs : {},
      is_modal: true,
    }
  }

  on_mouseup(e: MouseEvent) {
    this.modalEnd(false)
  }

  modalEnd(wasCancelled: boolean) {
    if (this.remesher) {
      ;(this.remesher as unknown as any).endOptTimer()
      this.remesher = undefined
    }

    super.modalEnd(wasCancelled)
  }

  modalStart(ctx: ToolContext) {
    const result = super.modalStart(ctx)

    const mesh = ctx.mesh
    if (!mesh) {
      this.modalEnd(true)
    }

    const goal = this.inputs.edgeGoal.getValue()

    this.remesher = new UniformTriRemesher(mesh, undefined, RemeshGoals.EDGE_AVERAGE, goal)
    // XXX
    ;(this.remesher as unknown as any).optimizeParams(ctx)
    return result
  }
}

import {SolverElem, Solver, VelConstraint} from './mesh_solver.js'
import {PaintToolModeBase} from '@framework/api'
import {CurvVert, getCurveVerts, smoothCurvatures} from './mesh_curvature.js'
import {getFaceSets} from './mesh_facesets.js'
import {getDynVerts} from './bvh.js'
import type {ToolContext, ViewContext} from '@framework/api'
import type {View3D} from '@framework/api'

export class SolverOpBase<InputSet extends PropertySlots = {}, OutputSet extends PropertySlots = {}> extends MeshOp<
  InputSet & {
    steps: IntProperty
    dt: FloatProperty
    implicitSteps: IntProperty
    damp: FloatProperty
  },
  OutputSet
> {
  solver?: Solver

  constructor() {
    super()

    this.solver = undefined
  }

  static tooldef(): ToolDef {
    return {
      toolpath: '',
      inputs: ToolOp.inherit({
        steps        : new IntProperty(1).private(),
        dt           : new FloatProperty(0.5).noUnits().setRange(0.0001, 1.0).saveLastValue(),
        implicitSteps: new IntProperty(5).noUnits().setRange(0, 45).saveLastValue(),
        damp         : new FloatProperty(0.99).noUnits().setRange(0.0, 1.0).saveLastValue(),
      }),
      is_modal: true,
      outputs : ToolOp.inherit({}),
    }
  }

  on_keydown(e: KeyboardEvent) {
    switch (e.keyCode) {
      case keymap['Escape']:
      case keymap['Enter']:
      case keymap['Space']:
        this.modalEnd(false)
        break
    }
  }

  getSolver(mesh: Mesh) {
    const solver = new Solver()
    solver.start(mesh)

    solver.implicitSteps = this.inputs.implicitSteps.getValue()

    return solver
  }

  execStep(mesh: Mesh, solver: Solver) {
    const dt = this.inputs.dt.getValue()

    try {
      solver.solve(1, dt)
    } catch (error) {
      console.log((error as Error).stack)
      console.log((error as Error).message)
      if (this.modalRunning) {
        this.modalEnd(false)
      }

      return
    }

    mesh.regenRender()
    mesh.recalcNormals()
    mesh.graphUpdate()

    window.redraw_viewport()
  }

  on_tick() {
    const time = util.time_ms()

    const solver = this.solver!
    const mesh = solver.mesh

    while (util.time_ms() - time < 150) {
      this.execStep(mesh, solver)
      this.inputs.steps.setValue(this.inputs.steps.getValue() + 1)

      if (!this.modalRunning) {
        break
      }

      //XXX
      //this.modalEnd(false);
    }
  }

  modalStart(ctx: ViewContext) {
    const result = super.modalStart(ctx)
    this.inputs.steps.setValue(0)
    this.solver = this.getSolver(ctx.mesh!)
    return result
  }

  exec(ctx: ToolContext) {
    const steps = this.inputs.steps.getValue()
    const mesh = ctx.mesh!
    const solver = this.getSolver(mesh)

    for (let i = 0; i < steps; i++) {
      this.execStep(mesh, solver)
    }

    solver.finish()
  }

  on_mouseup(e: PointerEvent) {
    this.modalEnd(false)
  }

  modalEnd(was_cancelled: boolean) {
    super.modalEnd(was_cancelled)

    if (this.solver) {
      this.solver.finish()
      this.solver = undefined
    }
  }
}

export class TestSolverOp extends SolverOpBase<{
  springK: FloatProperty
  inflate: FloatProperty
  edgeLenMul: FloatProperty
}> {
  constructor() {
    super()

    this.solver = undefined
  }

  static tooldef() {
    return {
      uiname  : 'Test Solver',
      toolpath: 'mesh.test_solver',
      inputs: ToolOp.inherit({
        springK   : new FloatProperty(5.5).noUnits().setRange(0.0, 55.0).saveLastValue(),
        inflate   : new FloatProperty(0.25).noUnits().setRange(0.0001, 2.0).saveLastValue(),
        edgeLenMul: new FloatProperty(1.85).noUnits().setRange(0.01, 5.0).saveLastValue(),
      }),
      is_modal: true,
      outputs : ToolOp.inherit({}),
    }
  }

  execStep(mesh: Mesh, solver: Solver) {
    const vs = solver.clientData
    const cd_slv = solver.cd_slv
    const inflate = this.inputs.inflate.getValue() * 0.01
    const dt = this.inputs.dt.getValue()
    const damp = this.inputs.damp.getValue()

    for (const v of vs) {
      const sv = v.customData[cd_slv]

      sv.oldco.load(v)
      sv.vel.mulScalar(damp)

      sv.force.zero()
      sv.scratch.zero()

      sv.force.addFac(v.no, (0.1 * dt * inflate) / sv.mass)

      if (isNaN(sv.vel.dot(sv.vel))) {
        console.error('NaN!')
        if (this.modalRunning) {
          this.modalEnd(false)
        }

        return
      }

      //v.addFac(sv.vel, dt);
      v.flag |= MeshFlags.UPDATE
    }

    mesh.regenRender()
    mesh.recalcNormals()
    mesh.graphUpdate()
    window.redraw_viewport(true)

    super.execStep(mesh, solver)

    for (const v of vs) {
      const sv = v.customData[cd_slv]

      if (sv.mass > 100) {
        v.load(sv.oldco)
      }
      //sv.vel.load(v).sub(sv.oldco);
    }
  }

  getSolver(mesh: Mesh): Solver {
    const solver = super.getSolver(mesh)

    const vs = new Set(mesh.verts.selected.editable)
    const es = new Set<Edge>()
    const fs = new Set<Face>()

    solver.clientData = vs

    for (const v of vs) {
      for (const e of v.edges) {
        es.add(e)

        for (const l of e.loops) {
          fs.add(e.l!.f)
        }
      }
    }

    if (0) {
      const cdname = '__solve_idx'
      let cd_idx = mesh.edges.customData.getNamedLayerIndex(cdname, 'int')

      if (cd_idx < 0) {
        const layer = mesh.edges.addCustomDataLayer('int', cdname)
        cd_idx = layer.index
        layer.flag |= CDFlags.TEMPORARY
      }
    }

    const sk = this.inputs.springK.getValue()
    const cd_slv = solver.cd_slv

    function debug(...args: any[]) {
      //return console.log(...arguments);
    }

    function spring_c(_params: any): number {
      const params: [Vertex, Vertex, number, number] = _params
      const [v1, v2, rlen, sk] = params

      //let m1 = v1.customData[cd_slv].mass;
      //let m2 = v1.customData[cd_slv].mass;

      return Math.abs(v1.co.vectorDistance(v2.co) - rlen)
    }

    function spring_c_vel(_params: any, klst: number[][], glst: number[][]): void {
      const [v1, v2, rlen, sk] = _params as [Vertex, Vertex, number, number]

      const [g1, g2] = glst

      const err = v1.co.vectorDistance(v2.co) - rlen

      for (let _j = 0; _j < 3; _j++) {
        const j = _j as Number3
        g1[j] = (v2.co[j] - v1.co[j]) * err * sk
        g2[j] = (v1.co[j] - v2.co[j]) * err * sk
      }

      debug(g1, g2)
    }

    function spring_c_acc(_params: any, klst: number, hlst: number[][]): void {
      const [v1, v2, rlen, sk] = _params as [Vertex, Vertex, number, number]

      const [h1, h2] = hlst

      const err = v1.co.vectorDistance(v2.co) - rlen

      for (let j = 0; j < 3; j++) {
        h1[j] = -err * sk
        h2[j] = err * sk
      }
    }

    let boundary = new Set<Vertex>()

    for (const e of es) {
      if (!vs.has(e.v1)) {
        boundary.add(e.v1)
      }
      if (!vs.has(e.v2)) {
        boundary.add(e.v2)
      }
    }

    for (const v of vs) {
      v.customData.get<SolverElem>(cd_slv).mass = 1.0
    }

    for (let i = 0; i < 5; i++) {
      const boundary2 = new Set<Vertex>()

      for (const v of boundary) {
        for (const v2 of v.neighbors) {
          if (!vs.has(v2) && !boundary.has(v2)) {
            boundary2.add(v2)
          }
        }

        v.customData.get<SolverElem>(cd_slv).mass = 100000000.0
        vs.add(v)
      }

      boundary = boundary2
    }

    for (const v of boundary) {
      v.customData.get<SolverElem>(cd_slv).mass = 100000000.0
      vs.add(v)
    }

    for (const v of vs) {
      for (const e of v.edges) {
        if (vs.has(e.v1) && vs.has(e.v2)) {
          es.add(e)
        }
      }
    }

    const edgeLenMul = this.inputs.edgeLenMul.getValue()

    for (const e of es) {
      const sv1 = e.v1.customData.get<SolverElem>(cd_slv)
      const sv2 = e.v1.customData.get<SolverElem>(cd_slv)
      const wlst = [sv1.mass, sv2.mass]
      const vel_lst = [sv1.vel, sv2.vel]
      const flst = [sv1.force, sv2.force]
      const slst = [sv1.scratch, sv2.scratch]

      const params = [e.v1, e.v2, e.v1.co.vectorDistance(e.v2.co) * edgeLenMul, sk]
      const con = new VelConstraint(
        spring_c,
        spring_c_vel,
        spring_c_acc,
        [e.v1, e.v2],
        params,
        wlst,
        vel_lst,
        flst,
        slst
      )
      solver.add(con)
    }

    return solver
  }
}

export class DuplicateMeshOp extends MeshOp<{
  selectMask: FlagProperty
}> {
  static tooldef() {
    return {
      uiname  : 'Duplicate Geometry',
      toolpath: 'mesh.duplicate',
      inputs: ToolOp.inherit({
        selectMask: new FlagProperty(0, MeshTypes).private(),
      }),
      outputs : ToolOp.inherit({}),
    }
  }

  static invoke<CTX extends ContextLike>(_ctx: CTX, args: Record<string, unknown>): ToolOp {
    const ctx = _ctx as unknown as ViewContext
    const tool = super.invoke(ctx, args) as unknown as DuplicateMeshOp

    if (!('selMask' in args)) {
      tool.inputs.selectMask.setValue(ctx.selectMask)
    }

    const macro = new ToolMacro<ViewContext>()
    macro.add(tool)

    const grab = new TranslateOp()
    macro.add(grab)

    return macro as unknown as ToolOp
  }

  exec(ctx: ToolContext) {
    for (const mesh of this.getMeshes(ctx)) {
      const selmask = this.inputs.selectMask.getValue()

      const geoms = [] as Element[][]

      if (selmask & MeshTypes.VERTEX) {
        geoms.push(Array.from(mesh.verts.selected.editable))
      }
      if (selmask & MeshTypes.EDGE) {
        geoms.push(Array.from(mesh.edges.selected.editable))
      }
      if (selmask & MeshTypes.FACE) {
        geoms.push(Array.from(mesh.faces.selected.editable))
      }

      let geom: Element[] = []
      for (let i = 0; i < geoms.length; i++) {
        geom = geom.concat(geoms[i])
      }

      console.log(selmask)
      console.log(geoms)
      console.log('GEOM', geom)

      mesh.selectNone()
      const ret = duplicateMesh(mesh, geom)

      for (const v of ret.newVerts) {
        v.flag |= MeshFlags.UPDATE
        mesh.verts.setSelect(v, true)
      }

      for (const e of ret.newEdges) {
        mesh.edges.setSelect(e, true)
      }

      for (const f of ret.newFaces) {
        mesh.faces.setSelect(f, true)
      }

      mesh.regenTessellation()
      mesh.regenBVH()
      mesh.regenRender()
      mesh.graphUpdate()
    }
  }
}
