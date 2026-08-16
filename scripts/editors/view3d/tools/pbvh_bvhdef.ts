import * as util from '../../../util/util.js'
import {
  FlagProperty,
  IndexRange,
  IVector2,
  IVector3,
  ToolOp,
  trilinear_co,
  trilinear_v3,
  Vector3,
  Vector4,
} from '../../../path.ux/scripts/pathux.js'
import {AttrRef} from '../../../../addons/builtin/mesh/src/customdata.js'
import {Mesh, MeshFlags, Vector3LayerElem, Vertex} from '../../../../addons/builtin/mesh/src/mesh.js'
import {BVH, BVHFlags, BVHNodeVertex, CDNodeInfo, IsectRet} from '../../../../addons/builtin/mesh/src/bvh.js'
import {PaintOpBase, PaintOpMesh, PathPoint} from './pbvh_base'
import {BrushProperty, PaintSampleProperty} from './stroke_base.js'
import {SceneObject} from '../../../sceneobject/sceneobject.js'
import type {ViewContext} from '../../../core/context.js'
import {GridBase} from '../../../../addons/builtin/mesh/src/mesh_grids.js'
import {PaintSample} from './stroke_base.js'
;(window as any).testTrilinear = function (seed: number = 0, d: number = 0.5): void {
  let boxverts: any[] = [
    [-d, -d, -d],
    [-d, d, -d],
    [d, d, -d],
    [d, -d, -d],

    [-d, -d, d],
    [-d, d, d],
    [d, d, d],
    [d, -d, d],
  ]

  boxverts = boxverts.map((b) => new Vector3(b))

  const rand = new util.MersenneRandom(seed)

  for (let i = 0; i < 5; i++) {
    const co = new Vector3()

    for (const j of IndexRange(3)) {
      co[j] = (rand.random() - 0.5) * 2.0 * d
    }

    const a = trilinear_co(co, boxverts)
    const b = trilinear_v3(a, boxverts)
    console.log(co.vectorDistance(b))
    console.log('\n')
  }
}

export class BVHDeformPaintOp extends PaintOpMesh<{}, {}> {
  bvhfirst: boolean
  bGrabVerts: Map<BVHNodeVertex, number> | undefined
  grabMode: boolean
  randSeed: number
  rand: util.MersenneRandom
  last_mpos: Vector3
  start_mpos: Vector3
  _undo: any

  constructor() {
    super()

    this.bvhfirst = true
    this.bGrabVerts = undefined
    this.grabMode = true

    this.randSeed = 0
    this.rand = new util.MersenneRandom()
    this.rand.seed(this.randSeed)

    this.last_mpos = new Vector3()
    this.start_mpos = new Vector3()
  }

  static tooldef(): any {
    return {
      uiname  : 'bvh deform paintop',
      toolpath: 'bvh.bvh_deform',
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

    // TODO: compute actual undo memory; currently returns a constant placeholder.
    return 32
  }

  onBrushDab(e: PointerEvent, pt: PaintSample, in_timer?: boolean, isInterp?: boolean) {
    const ctx = this.modal_ctx!
    if (!ctx.mesh) {
      return
    }

    const ret = super.onBrushDab(e, pt, in_timer)

    if (!ret) {
      return ret
    }

    const mesh = ctx.mesh

    const {origco, p, view, vec, w, mpos, radius, getchannel} = ret

    const brush = this.inputs.brush.getValue()
    const strength: number = getchannel('strength', brush.strength)
    const autosmooth: number = getchannel('autosmooth', brush.autosmooth)

    const ps = new PaintSample()

    ps.p.load3(p)
    ps.dp.load3(p).sub(this.last_p as unknown as Vector4)
    this.last_p.load(p)

    ps.radius = radius
    ps.strength = strength
    ps.autosmooth = autosmooth
    ps.w = w
    ps.isInterp = !!isInterp

    const bvh: any = this.getBVH(mesh)

    if (this.bvhfirst) {
      this.bvhfirst = false
      const bvs: Map<any, number> = (this.bGrabVerts = new Map())

      for (const node of bvh.leaves) {
        for (const bv of node.boxverts) {
          const dis: number = bv.vectorDistance(ps.p)
          bv.origco.load(bv)

          if (dis < radius) {
            bvs.set(bv, dis)
          }
        }
      }
    }

    const list = this.inputs.samples.getValue()
    let lastps: PaintSample | undefined

    if (list.length > 0) {
      lastps = list[list.length - 1]
    }

    list.push(ps)

    this.execDot(ctx, ps, lastps)
    ;(window as any).redraw_viewport(true)
  }

  on_pointermove(e: any, in_timer: boolean): void {
    return super.on_pointermove(e, in_timer)
  }

  undoPre(ctx: any): void {
    const ud = (this._undo = {
      vmap : new Map(),
      nvset: new WeakSet(),
      vlist: [] as number[],
      mesh : -1,
    })

    const mesh: any = ctx.mesh
    ud.mesh = mesh ? mesh.lib_id : -1
  }

  _doUndo(v: any): void {
    const vmap: Map<number, number> = this._undo.vmap
    const vlist: number[] = this._undo.vlist

    if (!vmap.has(v.eid)) {
      vmap.set(v.eid, vlist.length)
      vlist.push(v.eid)

      vlist.push(v.co[0])
      vlist.push(v.co[1])
      vlist.push(v.co[2])

      vlist.push(v.no[0])
      vlist.push(v.no[1])
      vlist.push(v.no[2])
    }
  }

  undo(ctx: any): void {
    const ud = this._undo

    if (ud.mesh === undefined) {
      return
    }

    const mesh: any = ctx.datalib.get(ud.mesh)

    if (!mesh) {
      console.error('Could not find mesh ' + ud.mesh)
      return
    }

    const bvh: any = mesh.bvh
    const cd_node: AttrRef<CDNodeInfo> = bvh ? bvh.cd_node : new AttrRef(-1)

    let i: number = 0
    const vlist: number[] = ud.vlist
    while (i < vlist.length) {
      const eid: number = vlist[i++]

      const x: number = vlist[i++]
      const y: number = vlist[i++]
      const z: number = vlist[i++]

      const nx: number = vlist[i++]
      const ny: number = vlist[i++]
      const nz: number = vlist[i++]

      const v: any = mesh.eidMap.get(eid)
      if (!v) {
        console.error('Could not find vertex ' + eid, v)
        continue
      }

      v.co[0] = x
      v.co[1] = y
      v.co[2] = z
      v.no[0] = nx
      v.no[1] = ny
      v.no[2] = nz

      v.flag |= MeshFlags.UPDATE

      if (bvh) {
        const node: any = cd_node.get(v).node
        if (node) {
          if (node.boxverts) {
            for (const bv of node.boxverts) {
              bv.load(bv.origco)
            }
          }

          node.setUpdateFlag(BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_BOUNDS)
        }
      }
    }

    if (bvh) {
      bvh.update()
    }

    ;(window as any).redraw_viewport(true)
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

    ;(window as any).redraw_viewport(true)
  }

  getBVH(mesh: Mesh): BVH {
    return mesh.getBVH({
      autoUpdate: false,
      deformMode: true,
      onCreate  : this.onBind.bind(this),
    })
  }

  onBind(bvh: BVH): void {
    bvh.splitToUniformDepth()

    //abuse the velocity field of BVHNodeElem
    const cd_node: any = bvh.cd_node

    for (const node of bvh.leaves) {
      node.boxvdata = new Map()

      /*
      for (let i=0; i<2; i++) {
        let set = !i ? node.uniqueVerts : node.otherVerts;

        for (let v of set) {
          node.boxvdata.set(v, new Vector3(trilinear_co(v, node.boxverts)));
        }
      }*/

      for (const v of node.uniqueVerts) {
        node.boxvdata.set(v, new Vector3(trilinear_co(v.co, node.boxverts)))
      }

      node.setUpdateFlag(BVHFlags.UPDATE_DRAW)
    }

    bvh.update()
  }

  modalEnd(wascanceled: boolean): void {
    const ctx = this.modal_ctx ?? ((globalThis as any)._appstate.ctx as ViewContext)
    super.modalEnd(wascanceled)

    if (!wascanceled && ctx.mesh) {
      const bvh = this.getBVH(ctx.mesh)

      this._applyDef(bvh)

      bvh.update()
      ;(window as any).redraw_viewport()
    }
  }

  _applyDef(bvh: BVH): void {
    //return;
    const cd_node: any = bvh.cd_node

    for (const node of bvh.leaves) {
      for (const v of node.uniqueVerts) {
        const uvw: any = node.boxvdata.get(v)

        this._doUndo(v)

        v.co.load(trilinear_v3(uvw, node.boxverts))
        v.flag |= MeshFlags.UPDATE
      }

      let flag: number = BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS
      flag |= BVHFlags.UPDATE_BOUNDS

      node.setUpdateFlag(flag)
    }
  }

  execDot(ctx: any, ps: PaintSample, lastps: PaintSample | undefined): void {
    const ob = ctx.object
    const mesh = ctx.mesh

    if (!mesh) {
      console.warn('No mesh!')
      return
    }

    const ud = this._undo

    const fac: number = 0.1

    const bvh = this.getBVH(mesh)

    const radius: number = ps.radius
    const brush = this.inputs.brush.getValue()
    const falloff = brush.falloff

    const visit: WeakSet<any> = new WeakSet()
    const bvs: (BVHNodeVertex | number)[] = []

    const vset = this.bGrabVerts!

    /*
    for (let n of bvh.leaves) {
      for (let bv of n.boxverts) {
        vset.add(bv);
      }
    }*/

    for (const bv of vset.keys()) {
      if (visit.has(bv)) {
        continue
      }

      visit.add(bv)

      if (!ud.nvset.has(bv)) {
        ud.nvset.add(bv)
        bv.origco.load(bv)
      }

      const dis = vset.get(bv)!
      if (dis >= radius) {
        //continue;
      }

      let w = 1.0 - dis / radius
      w = falloff.evaluate(w)
      w = Math.min(Math.max(w, 0.0), 1.0)

      bv.addFac(ps.dp, w * ps.strength)

      bvs.push(bv)
      bvs.push(w)

      //bv[0] += (this.rand.random() - 0.25)*fac;
      //bv[1] += (this.rand.random() - 0.25)*fac;
      //bv[2] += (this.rand.random() - 0.25)*fac;
    }

    const tmp: Vector3 = new Vector3()

    const smooth = (bv: BVHNodeVertex, fac: number = 0.5): void => {
      const co: Vector3 = tmp.zero()
      let tot: number = 0.0

      for (const e of bv.edges) {
        const bv2 = e.otherVertex(bv)

        if (vset.has(bv2)) {
          co.add(bv2)
          tot++
        }
      }

      if (tot > 0.0) {
        co.mulScalar(1.0 / tot)
        bv.interp(co, fac)
      }
    }

    for (let i: number = 0; i < bvs.length; i += 2) {
      const bv = bvs[i] as BVHNodeVertex
      const w: number = (1.0 - (bvs[i + 1] as number)) * ps.autosmooth

      smooth(bv, w)
    }

    if (!this.modalRunning) {
      this._applyDef(bvh)

      for (const node of bvh.leaves) {
        node.setUpdateFlag(BVHFlags.UPDATE_BOUNDS)
      }

      bvh.update()
    }

    window.redraw_viewport(true)
  }
}

ToolOp.register(BVHDeformPaintOp)
