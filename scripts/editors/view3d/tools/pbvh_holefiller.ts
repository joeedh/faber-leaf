import * as util from '../../../util/util.js'
import {FlagProperty, IVector2, IVector3, ToolOp, Vector3, Vector4} from '../../../path.ux/scripts/pathux.js'
import {
  AttrRef,
  Edge,
  LogContext,
  Mesh,
  MeshFlags,
  MeshTypes,
  Vector3LayerElem,
  Vertex,
} from '../../../../addons/builtin/mesh/src/mesh.js'
import {BVH, BVHFlags, BVHTriFlags, IsectRet} from '../../../../addons/builtin/mesh/src/bvh.js'
import {PaintOpBase, PaintOpMesh, PathPoint} from './pbvh_base'
import {BrushProperty, PaintSampleProperty} from './stroke_base.js'
import {applyTriangulation} from '../../../../addons/builtin/mesh/src/mesh_tess.js'
import {MeshLog} from '../../../../addons/builtin/mesh/src/mesh_log.js'
import type {GridBase} from '../../../../addons/builtin/mesh/src/mesh_grids.js'
import type {ViewContext} from '../../../core/context.js'
import {PaintSample} from './stroke_base.js'

export function fillHoleFromVert(
  mesh: Mesh,
  bvh: BVH,
  startv: Vertex,
  visit: WeakSet<Vertex | Edge>,
  lctx?: LogContext
): void {
  let count = 0

  let _i = 0
  const vs = [] as Vertex[]
  let v = startv
  let laste: Edge | undefined

  while (1) {
    if (_i++ > 100000) {
      console.warn('Infinite loop error')
      break
    }

    vs.push(v)
    visit.add(v)

    let e: Edge | undefined
    for (const e2 of v.edges) {
      if (!e2.l || e2.l.radial_next === e2.l) {
        count++

        if (!e && !visit.has(e2)) {
          e = e2
          visit.add(e2)
        }
      }
    }

    if (!e) {
      break
    }

    v = e.otherVertex(v)
    laste = e
  }

  const flag1 = MeshFlags.TEMP3
  const flag2 = MeshFlags.TEMP4

  let vi: number = 0
  for (const v of vs) {
    v.flag &= ~flag1
  }

  for (const v of vs) {
    if (!(v.flag & flag1)) {
      v.flag |= flag1
      vs[vi++] = v
    }
  }

  vs.length = vi

  if (vs.length < 3) {
    return
  }

  if (!lctx) {
    lctx = new LogContext()
  }

  let updateflag: number = BVHFlags.UPDATE_UNIQUE_VERTS | BVHFlags.UPDATE_OTHER_VERTS
  updateflag = updateflag | BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_DRAW
  updateflag = updateflag | BVHFlags.UPDATE_COLORS | BVHFlags.UPDATE_INDEX_VERTS
  updateflag = updateflag | BVHFlags.UPDATE_TOTTRI

  const oldnew: ((e: any) => void) | undefined = lctx.onnew
  lctx.onnew = (e: any): void => {
    if (e.type === MeshTypes.FACE && e.isTri()) {
      const l: any = e.lists[0].l

      const tri: any = bvh.addTri(e.eid, bvh._nextTriIdx(), l.v, l.next.v, l.prev.v, undefined, l, l.next, l.prev)
      tri.flag |= BVHTriFlags.LOOPTRI_INVALID

      for (const node of tri.nodes) {
        node.setUpdateFlag(updateflag)
      }
    }

    if (oldnew) {
      oldnew(e)
    }
  }

  const f: any = mesh.makeFace(vs, undefined, undefined, lctx)
  let badf: number = 0

  for (const l of f.loops) {
    badf += l.radial_next !== l && l.radial_next.v === l.v ? 1 : -1
  }
  if (badf > 0.0) {
    mesh.reverseWinding(f)
  }

  let first: boolean = true

  for (const l of f.loops) {
    if (l.radial_next !== l) {
      mesh.copyElemData(l, l.radial_next)

      if (first) {
        mesh.copyElemData(f, l.radial_next.f)
        first = false
      }
    }
  }

  if (!f.isTri()) {
    applyTriangulation(mesh, f, undefined, undefined, lctx)
  }
}

export function fillBoundaryHoles(mesh: Mesh, bvh: BVH, vs: Iterable<Vertex>, lctx?: LogContext): void {
  const visit: WeakSet<Vertex> = new WeakSet()

  for (const v of vs) {
    if (!v.isBoundary()) {
      continue
    }

    if (!visit.has(v)) {
      fillHoleFromVert(mesh, bvh, v, visit, lctx)
    }
  }
}

export class HoleFillPaintOp extends PaintOpMesh<{}, {}> {
  last_mpos: Vector3
  start_mpos: Vector3
  _undo: any

  constructor() {
    super()

    this.last_mpos = new Vector3()
    this.start_mpos = new Vector3()
  }

  static tooldef() {
    return {
      uiname  : 'paintop',
      toolpath: 'bvh.hole_filler',
      is_modal: true,
      inputs: ToolOp.inherit({
        brush       : new BrushProperty(),
        samples     : new PaintSampleProperty(),
        symmetryAxes: new FlagProperty(undefined, {X: 1, Y: 2, Z: 4}),
      }),
    }
  }

  initOrigData(mesh: Mesh): AttrRef<Vector3LayerElem> {
    return new AttrRef(-1)
  }
  getOrigCo(mesh: Mesh, vertex: Vertex, cd_grid: AttrRef<GridBase>, cd_orig: AttrRef<Vector3LayerElem>): Vector3 {
    return vertex.co
  }
  calcUndoMem(ctx: any): number {
    if (!this._undo) {
      return 0
    }

    return this._undo.log.calcMemSize()
  }

  undoPre(ctx: any): void {
    const ud: any = (this._undo = {})

    const mesh: any = ctx.mesh

    if (mesh) {
      ud.mesh = mesh.lib_id
    }

    ud.log = new MeshLog()
  }

  undo(ctx: any): void {
    const ud: any = this._undo

    if (ud.mesh === undefined) {
      return
    }

    const mesh: any = ctx.datalib.get(ud.mesh)

    if (!mesh) {
      console.error('Could not find mesh ' + ud.mesh)
      return
    }

    ud.log.undo(mesh)
    mesh.regenBVH()
    mesh.regenAll()

    window.redraw_viewport(true)
  }

  onBrushDab(
    //
    e: PointerEvent,
    pt: PaintSample,
    in_timer: boolean = false,
    isInterp: boolean = false
  ) {
    const ctx = this.modal_ctx
    if (!ctx?.mesh) {
      return
    }

    const ret = super.onBrushDab(e, pt, in_timer)

    if (!ret) {
      return undefined
    }

    const {origco, p, view, vec, w, mpos, radius, getchannel} = ret

    const brush: any = this.inputs.brush.getValue()
    const strength: number = getchannel('strength', brush.strength)
    const autosmooth: number = getchannel('autosmooth', brush.autosmooth)

    const ps: PaintSample = new PaintSample()

    const lastp = new Vector4().load3(this.last_p)

    ps.p.load3(p)
    ps.p[3] = 1.0
    ps.dp.load3(p).sub(lastp)
    ps.radius = radius
    ps.strength = strength
    ps.autosmooth = autosmooth
    ps.w = w
    ps.isInterp = isInterp ?? false

    const list = this.inputs.samples.getValue()
    let lastps: PaintSample | undefined

    if (list.length > 0) {
      lastps = list[list.length - 1]
    }

    list.push(ps)

    this.execDot(ctx, ps, lastps)
    window.redraw_viewport(true)
    return ret
  }

  exec(ctx: any): void {
    let lastps: PaintSample | undefined

    if (!ctx.mesh) {
      return
    }

    for (const ps of this.inputs.samples.getValue()) {
      this.execDot(ctx, ps, lastps)

      lastps = ps
    }

    window.redraw_viewport(true)
  }

  execDot(ctx: ViewContext, ps: PaintSample, lastps: PaintSample | undefined): void {
    const mesh = ctx.mesh

    if (!mesh) {
      return
    }

    const bvh = mesh.getBVH({autoUpdate: false})
    const log: any = this._undo.log

    log.checkStart(mesh)

    const lctx: any = new LogContext()
    lctx.onnew = (e: any): void => {
      if (!(e.type & (MeshTypes.HANDLE | MeshTypes.LOOP))) {
        log.logAdd(e)
      }
    }

    lctx.onkill = (e: any): void => {
      if (!(e.type & (MeshTypes.HANDLE | MeshTypes.LOOP))) {
        log.logKill(e)
      }
    }

    let vs = bvh.closestVerts(ps.p, ps.radius) as Set<Vertex>

    for (const v of new Set(vs)) {
      for (const v2 of v.neighbors) {
        vs.add(v2)

        /*
        for (let v3 of v2.neighbors) {
          vs.add(v3);
        }//*/
      }
    }

    for (const v of vs) {
      if (v.valence === 0) {
        mesh.killVertex(v, undefined, lctx)
        continue
      }

      let ok: boolean = false

      for (const e of v.edges) {
        if (e.l) {
          ok = true
        }
      }

      if (!ok) {
        mesh.killVertex(v, undefined, lctx)
      }
    }

    vs = vs.filter((v: Vertex) => v.eid >= 0 && v.isBoundary(false))

    if (vs.size === 0) {
      return
    }

    for (const v of vs) {
      log.ensure(v)
    }

    fillBoundaryHoles(mesh, bvh, vs, lctx)

    bvh.update()
  }
}
ToolOp.register(HoleFillPaintOp)
