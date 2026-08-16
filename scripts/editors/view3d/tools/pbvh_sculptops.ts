import * as util from '../../../util/util.js'
import {
  BoolProperty,
  FloatArrayProperty,
  FloatProperty,
  IntProperty,
  Matrix4,
  Number3,
  Quat,
  ToolOp,
  Vec3Property,
  Vector2,
  Vector3,
  Vector4,
  closest_point_on_line,
} from '../../../path.ux/scripts/pathux.js'
import {Grid, GridBase, GridVert, GridVertBase, QRecalcFlags} from '../../../../addons/builtin/mesh/src/mesh_grids.js'
import {AttrRef, CDFlags, CustomDataElem} from '../../../../addons/builtin/mesh/src/customdata.js'
import {
  BrushFlags,
  DynTopoFlags,
  SculptTools,
  BrushSpacingModes,
  DynTopoModes,
  SubdivModes,
  SculptBrush,
} from '../../../brush/index'
import {
  CDElemArray,
  ColorLayerElem,
  Edge,
  Element,
  Face,
  FloatElem,
  getArrayTemp,
  IntElem,
  LogContext,
  Loop,
  MaskElem,
  Mesh,
  MeshFlags,
  MeshTypes,
  Vector3LayerElem,
  Vertex,
} from '../../../../addons/builtin/mesh/src/mesh.js'
import {
  BVH,
  BVHFlags,
  BVHNode,
  BVHTriFlags,
  BVHVertFlags,
  CDNodeInfo,
  getDynVerts,
  IBVHVertex,
  MDynVert,
  OrigCoType,
} from '../../../../addons/builtin/mesh/src/bvh.js'
import {QuadTreeFields, QuadTreeFlags, QuadTreeGrid} from '../../../../addons/builtin/mesh/src/mesh_grids_quadtree.js'
import {
  EMapFields,
  KdTreeFields,
  KdTreeFlags,
  KdTreeGrid,
  VMapFields,
} from '../../../../addons/builtin/mesh/src/mesh_grids_kdtree.js'
import {splitEdgesSimple2, splitEdgesSmart2} from '../../../../addons/builtin/mesh/src/mesh_subdivide.js'
import {calcConcave, PaintOpBase, PathPoint, PaintOpMesh} from './pbvh_base'
import {SymAxisMap} from './stroke_base.js'
import {trianglesToQuads, TriQuadFlags} from '../../../../addons/builtin/mesh/src/mesh_utils.js'
import {applyTriangulation, triangulateFace, triangulateQuad} from '../../../../addons/builtin/mesh/src/mesh_tess.js'
import {MeshLog} from '../../../../addons/builtin/mesh/src/mesh_log.js'
import {TetMesh} from '../../../tet/tetgen.js'
import {MultiGridSmoother} from '../../../../addons/builtin/mesh/src/multigrid_smooth.js'
import {getCurveVerts, dirCurveSmooth, CurvVert} from '../../../../addons/builtin/mesh/src/mesh_curvature.js'
import {TexUserFlags, TexUserModes} from '../../../texture/proceduralTex'
import {Bezier} from '../../../util/bezier.js'
import {tetSolve} from '../../../tet/tet_deform.js'
import {
  DispContext,
  DispLayerVert,
  getSmoothMemo,
  SmoothMemoizer,
} from '../../../../addons/builtin/mesh/src/mesh_displacement.js'
import {getCornerFlag, getFaceSets, getSmoothBoundFlag} from '../../../../addons/builtin/mesh/src/mesh_facesets.js'
import {TetVertex} from '../../../tet/tetgen_types.js'
import type {ViewContext} from '../../../core/context.js'
import {PaintSample} from './stroke_base.js'

//grab data field definition
const GEID = 0
const GEID2 = 1
const GDIS = 2
const GSX = 3
const GSY = 4
const GSZ = 5
const GAX = 6
const GAY = 7
const GAZ = 8
const GOFFX = 9
const GOFFY = 10
const GOFFZ = 11
const GTOT = 12

const UGTOT = 9

let ENABLE_DYNTOPO_EDGE_WEIGHTS = true
let DYNTOPO_T_GOAL = 7

let ENABLE_RAKE = true
let ENABLE_CURVATURE_RAKE = true

const FANCY_MUL = 1.0

declare global {
  interface Window {
    noMemoize?: boolean
  }
}
const _g = globalThis as any
_g._disableRake = function (curvatureOnly: boolean = false, mode: boolean = false): void {
  ENABLE_CURVATURE_RAKE = mode

  if (!curvatureOnly) {
    ENABLE_RAKE = mode
  }
}

/*
let GVEID = 0, GVTOT=1;
let GGEID_LOOP=0, GGEID_GRIDVERT=1, GGTOT=2;
*/

/*
BrushProperty works by copying SculptBrush.  It also copies any
textures inside of them, but not anything those textures references (e.g. images).

WARNING: this means there could conceivably be reference leaks here with the undo stack
*/

const cfrets = util.cachering.fromConstructor(Vector4, 128)
type ColorFilterFunc = (v: any, cd_color: number, fac?: number) => Vector4 | undefined
export const colorfilterfuncs: (ColorFilterFunc | number)[] = [0, 0]
const midtmp = new Vector3()

colorfilterfuncs[1] = function (v: any, cd_color: number, fac: number = 0.5): Vector4 | undefined {
  if (cd_color < 0) {
    return
  }

  const ret = cfrets.next().zero()
  let tot = 0.0
  fac = 1.0 - fac

  for (const v2 of v.neighbors) {
    const clr = v2.customData[cd_color].color
    const w = 1.0

    tot += w
    ret.addFac(clr, w)
  }

  if (tot === 0.0) {
    ret.load(v.customData[cd_color].color)
  } else {
    ret.mulScalar(1.0 / tot)
    ret.interp(v.customData[cd_color].color, fac)
  }

  return ret
}

colorfilterfuncs[0] = function (v: any, cd_color: number, fac: number = 0.5): Vector4 | undefined {
  if (cd_color < 0) {
    return
  }

  const ret = cfrets.next().zero()
  let tot = 0.0
  fac = 1.0 - fac

  for (const e of v.edges) {
    const v2 = e.otherVertex(v)
    const clr = v2.customData[cd_color].color
    const w = 1.0

    tot += w
    ret.addFac(clr, w)
  }

  if (tot === 0.0) {
    ret.load(v.customData[cd_color].color)
  } else {
    ret.mulScalar(1.0 / tot)
    ret.interp(v.customData[cd_color].color, fac)
  }

  return ret
}

export class PaintOp extends PaintOpMesh<
  {
    grabData: FloatArrayProperty
    grabCo: Vec3Property
    grabRadiusFactor: FloatProperty
    grabTh: FloatProperty

    dynTopoLength: FloatProperty
    dynTopoDepth: IntProperty
    useDynTopo: BoolProperty
    useMultiResDepth: BoolProperty
    reprojectCustomData: BoolProperty
    drawFaceSet: FloatProperty
  },
  {}
> {
  edist_scale: any
  _last_enable_mres: string
  dynTopoRand: any
  grabEidMap: Map<number, IBVHVertex> | undefined
  grabDists: number[] | undefined
  last_mpos: Vector2
  last_p: Vector3
  last_p2: Vector3
  last_p3: Vector3
  last_p4: Vector3
  last_p5: Vector3
  last_origco: Vector4
  last_origco2: Vector4
  last_origco3: Vector4
  last_origco4: Vector4
  last_origco5: Vector4
  _first2: number
  last_radius: number
  last_vec: Vector3
  smoother: any | undefined
  task: any | undefined
  _undo: any
  lastbez: any
  lastps1: any
  lastps2: any
  last_r: number = 0
  _last_time: number = 0

  constructor() {
    super()

    this.edist_scale = () => 1.0

    this.edist_subd = this.edist_subd.bind(this)
    this.edist_coll = this.edist_coll.bind(this)

    this._last_enable_mres = ''

    this.dynTopoRand = new util.MersenneRandom()

    this.grabEidMap = undefined
    this.grabDists = undefined

    this.last_mpos = new Vector2()
    this.last_p = new Vector3()
    this.last_p2 = new Vector3()
    this.last_p3 = new Vector3()
    this.last_p4 = new Vector3()
    this.last_p5 = new Vector3()
    this.last_origco = new Vector4()
    this.last_origco2 = new Vector4()
    this.last_origco3 = new Vector4()
    this.last_origco4 = new Vector4()
    this.last_origco5 = new Vector4()

    this._first2 = 4
    this.last_radius = 0
    this.last_vec = new Vector3()

    this.smoother = undefined
    this.task = undefined
  }

  static tooldef(): any {
    return {
      uiname  : 'paintop',
      toolpath: 'bvh.paint',
      is_modal: true,
      inputs: ToolOp.inherit({
        grabData        : new FloatArrayProperty(),
        grabCo          : new Vec3Property(),
        grabRadiusFactor: new FloatProperty(2.5),
        grabTh          : new FloatProperty(0.0),

        dynTopoLength      : new FloatProperty(25),
        dynTopoDepth       : new IntProperty(20),
        useDynTopo         : new BoolProperty(false),
        useMultiResDepth   : new BoolProperty(false),
        reprojectCustomData: new BoolProperty(false),

        drawFaceSet: new IntProperty(2),
      }),
    }
  }

  getBVH(mesh: Mesh) {
    return mesh.getBVH({autoUpdate: true})
  }

  ensureSmoother(mesh: Mesh): void {
    if (!this.smoother) {
      this.smoother = MultiGridSmoother.ensureSmoother(mesh, true, undefined, true)
    }
  }

  initOrigData(mesh: Mesh): AttrRef<Vector3LayerElem> {
    const cd_grid = GridBase.meshGridOffset(mesh)

    let cd_orig
    const haveGrids = cd_grid >= 0
    let initverts = false

    if (haveGrids) {
      cd_orig = mesh.loops.customData.getNamedLayerIndex('__orig_co', 'vec3')

      if (cd_orig < 0) {
        const layer = mesh.loops.addCustomDataLayer('vec3', '__orig_co')
        layer.flag |= CDFlags.TEMPORARY
        cd_orig = layer.index
        initverts = true
      }
    } else {
      cd_orig = mesh.verts.customData.getNamedLayerIndex('__orig_co', 'vec3')

      if (cd_orig < 0) {
        const layer = mesh.verts.addCustomDataLayer('vec3', '__orig_co')
        layer.flag |= CDFlags.TEMPORARY
        cd_orig = layer.index
        initverts = true
      }
    }

    if (initverts) {
      for (const v of mesh.verts) {
        v.customData.get<Vector3LayerElem>(cd_orig).value.load(v.co)
      }
    }

    return new AttrRef<Vector3LayerElem>(cd_orig)
  }

  calcUndoMem(ctx: ViewContext): number {
    const ud = this._undo
    let tot = 0

    if (!ud) {
      return 0
    }

    tot += ud.vmap.size * (8 + 3 * 8)
    tot += ud.gmap.size * (16 * 8) //approximate size of gmap
    tot += ud.gdata.length * 8
    tot += ud.gset.size * 8
    tot += ud.log.calcMemSize()

    return tot
  }

  undoPre(ctx: any): void {
    let mesh
    if (ctx.object && ctx.object.data instanceof Mesh) {
      mesh = ctx.object.data
    } else if (ctx.object && ctx.object.data instanceof TetMesh) {
      mesh = ctx.object.data
    }

    let cd_grid = -1
    let cd_mask = -1

    if (mesh) {
      cd_grid = GridBase.meshGridOffset(mesh)

      if (cd_grid >= 0) {
        cd_mask = mesh.loops.customData.getLayerIndex('mask')
      } else {
        cd_mask = mesh.verts.customData.getLayerIndex('mask')
      }
    }

    this._undo = {
      mesh: mesh ? mesh.lib_id : -1,
      mode: this.inputs.brush.getValue().tool,
      vmap: new Map(),
      gmap: new Map(),
      mmap: new Map(), //mask data for nongrid verts
      cd_mask,
      gdata  : [],
      log    : new MeshLog(),
      gset   : new Set(),
      fsetmap: new Map(),
    }

    if (mesh) {
      this._undo.log.start(mesh)
    }
  }

  undo(ctx: any): void {
    const undo = this._undo
    const mesh = ctx.datalib.get(undo.mesh) as Mesh

    if (!mesh) {
      console.warn('eek! no mesh!')
      return
    }

    const cd_fset = getFaceSets(mesh, false)

    const cd_mask = undo.cd_mask

    let bvh: BVH | undefined = this.getBVH(mesh)
    let cd_node: AttrRef<CDNodeInfo> | undefined
    const cd_dyn_vert = getDynVerts(mesh)

    if (bvh) {
      cd_node = bvh.cd_node
    } else {
      cd_node = mesh.verts.customData.getLayerRef('bvh')
    }

    if (cd_node?.i === -1) {
      cd_node = undefined
    }

    const cd_grid = GridBase.meshGridOffset(mesh)
    const gd = undo.gdata

    if (cd_grid < 0 && cd_fset >= 0) {
      for (const [eid, fset] of undo.fsetmap) {
        const f = mesh.eidMap.get<Face>(eid)

        if (f?.type !== MeshTypes.FACE) {
          console.warn('invalid face in undo!', eid, f)
          continue
        }

        ;(f.customData[cd_fset] as IntElem).value = fset

        for (const v of f.verts) {
          v.flag |= MeshFlags.UPDATE

          if (cd_node !== undefined) {
            const mv = cd_node.get(v)

            mv.flag |= BVHVertFlags.NEED_BOUNDARY

            const node = cd_node.get(v).node!
            node.setUpdateFlag(
              BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_MASK
            )
          }
        }
      }
    }

    if (cd_grid < 0 && this._undo.log.log.length > 0) {
      const log = this._undo.log

      log.undo(mesh)
      mesh.regenTessellation()
      mesh.regenBVH()
      bvh = this.getBVH(mesh)
    }

    const doColors = (): void => {
      let cd_color = mesh.loops.customData.getLayerIndex('color')

      for (let i = 0; i < gd.length; i += UGTOT) {
        let l = gd[i]
        const index = gd[i + 1]
        const r = gd[i + 2]
        const g = gd[i + 3]
        const b = gd[i + 4]
        const a = gd[i + 5]

        l = mesh.eidMap.get(l)
        if (!l || !(l instanceof Loop)) {
          console.error('undo error')
          continue
        }

        const grid = l.customData[cd_grid] as GridBase
        const p = grid.points[index]

        const c = (p.customData[cd_color] as ColorLayerElem).color
        c[0] = r
        c[1] = g
        c[2] = b
        c[3] = a

        const node = cd_node ? cd_node.get(p)?.node : undefined
        if (node) {
          node.setUpdateFlag(BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS)
        }
      }

      cd_color = mesh.verts.customData.getLayerIndex('color')

      if (cd_color < 0) {
        return
      }

      for (const eid of undo.vmap.keys()) {
        const v = mesh.eidMap.get(eid)

        if (v) {
          v.flag |= MeshFlags.UPDATE
          ;(v.customData[cd_color] as ColorLayerElem).color.load(undo.vmap.get(eid))

          if (bvh) {
            const node = cd_node ? cd_node.get(v)?.node : undefined
            if (node) {
              node.flag |= BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS
            }
          }
        }
      }

      //XXX for now, regen bvh on undo
      mesh.regenBVH()

      mesh.regenRender()
      mesh.regenPartial()
    }

    const doMasks = (): void => {
      if (cd_mask < 0) {
        return
      }

      const mmap = undo.mmap

      for (let i = 0; i < gd.length; i += UGTOT) {
        let l = gd[i]
        const index = gd[i + 1]
        const mask = gd[i + 2]

        l = mesh.eidMap.get(l)
        if (!l || !(l instanceof Loop)) {
          console.error('undo error')
          continue
        }

        const grid = l.customData[cd_grid] as GridBase
        const p = grid.points[index]

        const maskElem = p.customData[cd_mask] as unknown as MaskElem
        maskElem.value = mask

        const node = cd_node!.get(p).node

        if (node) {
          node.setUpdateFlag(BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS)
        }
      }

      for (const [veid, mask] of mmap) {
        const v = mesh.eidMap.get(veid)

        if (!v) {
          continue
        }

        ;(v.customData[cd_mask] as unknown as FloatElem).value = mask
        const node = cd_node!.get(v).node

        if (node) {
          node.setUpdateFlag(BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_MASK)
        }
      }
    }

    const doCoords = (): void => {
      let cd_node = bvh?.cd_node
      if (cd_node?.i === -1) {
        cd_node = undefined
      }

      for (let i = 0; i < gd.length; i += UGTOT) {
        let l = gd[i]
        const index = gd[i + 1]
        const x = gd[i + 2]
        const y = gd[i + 3]
        const z = gd[i + 4]
        const nx = gd[i + 5]
        const ny = gd[i + 6]
        const nz = gd[i + 7]

        l = mesh.eidMap.get(l)
        if (!l || !(l instanceof Loop)) {
          console.error('undo error')
          continue
        }

        const grid = l.customData[cd_grid] as GridBase
        const p = grid.points[index]

        p.co[0] = x
        p.co[1] = y
        p.co[2] = z
        p.no[0] = nx
        p.no[1] = ny
        p.no[2] = nz

        const node = cd_node!.get(p).node

        if (node) {
          node.setUpdateFlag(BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS)
        }
      }

      for (const eid of undo.vmap.keys()) {
        const v = mesh.eidMap.get<Vertex>(eid)

        if (v) {
          v.flag |= MeshFlags.UPDATE
          v.load(undo.vmap.get(eid))

          if (bvh) {
            const node = cd_node!.get(v).node

            if (node) {
              node.setUpdateFlag(BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS)
            }
          }
        }
      }

      bvh?.update()

      if (cd_grid < 0) {
        mesh.recalcNormals()
      }

      mesh.regenRender()
      mesh.regenPartial()
    }

    const doQuadTreeGrids = (): void => {
      const gmap = undo.gmap

      const cd_node = new AttrRef(mesh.loops.customData.getLayerIndex('bvh'))
      const gridAttr = GridBase.meshGridRef(mesh)
      const cd_grid = gridAttr.i

      const updateloops = new Set<Loop>()
      const killloops = new Set<Loop>()

      for (const l of gmap.keys()) {
        const grid1 = l.customData[cd_grid]
        const grid2 = gmap.get(l)

        //forcably unlink verts from uniqueVerts in bvh tree nodes
        //except we're destroy the bvh anyway, and mesh.bvh does this for us
        /*
        if (cd_node >= 0) {
          for (let p of grid1.points) {
            let node = cd_node.get(p);
            if (node && node.node && node.node.uniqueVerts) {
              node.node.uniqueVerts.delete(p);
            }
            if (node) {
              node.node = undefined;
            }
          }
        }*/

        //bvh.removeFace(l.eid, true);

        grid2.copyTo(grid1, true)

        grid1.recalcFlag |= QRecalcFlags.MIRROR | QRecalcFlags.ALL | QRecalcFlags.TOPO

        killloops.add(l)

        updateloops.add(l)
        updateloops.add(l.prev.radial_next)
        updateloops.add(l.radial_next.next)
        updateloops.add(l.prev)
        updateloops.add(l.next)
      }

      //bvh.update();

      //let updateflag = QRecalcFlags.NEIGHBORS|QRecalcFlags.POLYS|QRecalcFlags.TOPO|QRecalcFlags.CHECK_CUSTOMDATA;
      const updateflag = QRecalcFlags.ALL | QRecalcFlags.MIRROR

      for (const l of killloops) {
        const grid = l.customData[cd_grid] as GridBase

        //bvh.removeFace(l.eid, true);
        grid.recalcFlag |= updateflag
      }

      //do modified grids first
      for (const l of killloops) {
        const grid = l.customData[cd_grid] as GridBase

        grid.update(mesh, l, gridAttr)
      }

      //now do neightboring grids
      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid] as GridBase

        grid.update(mesh, l, gridAttr)
      }

      //just regenerate entire bvh tree on undo for now
      if (bvh) {
        mesh.regenBVH()
      }

      if (0 && bvh !== undefined) {
        const trisout = [] as (number | GridVert)[]

        for (const l of killloops) {
          const grid = l.customData[cd_grid] as GridBase
          grid.makeBVHTris(mesh, bvh, l, gridAttr, trisout)
        }

        while (trisout.length > 0) {
          const ri = ~~(((this.rand.random() * trisout.length) / 5.0) * 0.99999) * 5
          const ri2 = trisout.length - 5

          const eid = trisout[ri] as number
          const id = trisout[ri + 1] as number
          const v1 = trisout[ri + 2] as GridVert
          const v2 = trisout[ri + 3] as GridVert
          const v3 = trisout[ri + 4] as GridVert

          bvh.addTri(eid, id, v1, v2, v3)

          for (let j = 0; j < 5; j++) {
            trisout[ri + j] = trisout[ri2 + j]
          }

          trisout.length -= 5
        }
      }

      bvh = undefined
    }

    let haveQuadTreeGrids = false
    if (cd_grid >= 0) {
      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid]

        if (grid instanceof QuadTreeGrid) {
          haveQuadTreeGrids = true
        }

        if (grid instanceof KdTreeGrid) {
          haveQuadTreeGrids = true
        }
        break
      }
    }
    const mode = undo.mode
    const isPaintColor = mode === SculptTools.PAINT || mode === SculptTools.PAINT_SMOOTH

    if (mode === SculptTools.MASK_PAINT) {
      doMasks()
    } else if (haveQuadTreeGrids) {
      doQuadTreeGrids()
    } else if (isPaintColor) {
      doColors()
    } else {
      doCoords()
    }

    if (bvh) {
      bvh.update()
    }
    window.redraw_viewport(true)
  }

  sampleViewRay(
    rendermat: Matrix4,
    _mpos: Vector2,
    view: Vector3,
    origin: Vector3,
    pressure: number,
    invert: boolean,
    isInterp: boolean
  ): any {
    const ctx = this.modal_ctx!
    const view3d = ctx.view3d
    const mesh = ctx.mesh
    const tetmesh = ctx.tetmesh

    if ((!mesh && !tetmesh) || !view3d) {
      return
    }

    return super.sampleViewRay(rendermat, _mpos, view, origin, pressure, invert, isInterp)
  }

  /* XXX unported
  feedTask(e: PointerEvent, p: PathPoint, pi: any): Generator<void, void, unknown> | void {
    const result = this.onBrushDab(e, p, true, pi !== this.path.length - 1)
    if (result === undefined) {
      return undefined
    }

    const view3d = this.modal_ctx!.view3d
    const mpos = p.screenP
    const invert = this.getInvertFromEvent(e)
    return this.processSample(view3d.activeCamera.rendermat, mpos, result.view, result.origin, p.pressure, invert, true)
  }
  */

  processSample(
    rendermat: Matrix4,
    _mpos: Vector2,
    view: Vector3,
    origin: Vector3,
    pressure: number,
    invert: boolean,
    isInterp: boolean
  ): any {
    const ctx = this.modal_ctx!
    const view3d = ctx.view3d
    const mesh = ctx.mesh
    const tetmesh = ctx.tetmesh

    if ((!mesh && !tetmesh) || !view3d) {
      return
    }

    const the_mesh = mesh || tetmesh

    const brush = this.inputs.brush.getValue()
    const mode = brush.tool

    const first = this._first2
    const ret = this.sampleViewRay(rendermat, _mpos, view, origin, pressure, invert, isInterp)

    if (!ret) {
      return
    }

    let {ob, origco, p, radius, vec, mpos, getchannel, w} = ret
    view = ret.view

    let strength = brush.strength
    const planeoff = brush.planeoff
    let autosmooth = brush.autosmooth
    let autosmoothInflate = brush.autosmoothInflate
    let concaveFilter = brush.concaveFilter
    let pinch = brush.pinch
    let smoothProj = brush.smoothProj
    let rake = brush.rake
    let sharp = brush.sharp

    strength = getchannel('strength', strength)
    autosmooth = getchannel('autosmooth', autosmooth)
    autosmoothInflate = getchannel('autosmoothInflate', autosmoothInflate)
    concaveFilter = getchannel('concaveFilter', concaveFilter)
    pinch = getchannel('pinch', pinch)
    smoothProj = getchannel('smoothProj', smoothProj)
    rake = getchannel('rake', rake)
    sharp = getchannel('sharp', sharp)

    const haveOrigData = PaintOpBase.needOrig(brush)
    let cd_orig: AttrRef<Vector3LayerElem> | undefined

    const cd_grid = mesh ? GridBase.meshGridOffset(mesh) : -1

    if (haveOrigData) {
      cd_orig = this.initOrigData(the_mesh as Mesh)
    }

    const isect = the_mesh!.getBVH()!.castRay(ret.origin, ret.view)
    if (isect === undefined) {
      return undefined
    }

    const p3 = new Vector4(isect!.p as unknown as Vector4)
    p3[3] = 1.0

    const matrix = new Matrix4(ob.outputs.matrix.getValue())
    p3.multVecMatrix(rendermat)

    if (mode !== SculptTools.SNAKE && mode !== SculptTools.SLIDE_RELAX && mode !== SculptTools.GRAB) {
      vec = new Vector3(isect.tri!.v1.no)
      vec.add(isect.tri!.v2.no)
      vec.add(isect.tri!.v3.no)
      vec.normalize()

      view.negate()
      if (vec.dot(view) < 0) {
        view.negate()
      }
      view.normalize()

      //if (mode !== SculptTools.SMOOTH) {
      vec.interp(view, 1.0 - brush.normalfac).normalize()
      //}
    } else if (!first) {
      vec = new Vector3(isect.p).sub(this.last_p)
      const p1 = new Vector3(isect.p)
      const p2 = new Vector3(this.last_p)

      view3d.project(p1)
      view3d.project(p2)

      p1[2] = p2[2]

      view3d.unproject(p1)
      view3d.unproject(p2)

      vec.load(p1).sub(p2)
    }

    //console.log("first", this._first);

    window.redraw_viewport(true)

    if (this._first2 === 2) {
      this.last_mpos.load(mpos)
      this.last_p5.load(isect.p)
      this.last_p4.load(isect.p)
      this.last_p3.load(isect.p)
      this.last_p2.load(isect.p)
      this.last_p.load(isect.p)
      this.last_origco.load3(origco)
      this.last_origco2.load3(origco)
      this.last_origco3.load3(origco)
      this.last_origco4.load3(origco)
      this.last_origco5.load3(origco)
      this.last_vec.load(vec)
      this.last_radius = radius
      this._first2--

      if (mode === SculptTools.GRAB) {
        this.inputs.grabCo.setValue(isect.p)
        this.initGrabData(the_mesh, isect.p, radius * this.inputs.grabRadiusFactor.getValue())
      }

      return
    } else if (this._first2 > 0) {
      this.last_origco5.load(this.last_origco4)
      this.last_origco4.load(this.last_origco3)
      this.last_origco3.load(this.last_origco2)
      this.last_origco2.load(this.last_origco)
      this.last_origco.load3(origco)

      this.last_p5.load(this.last_p4)
      this.last_p4.load(this.last_p3)
      this.last_p3.load(this.last_p2)
      this.last_p2.load(this.last_p)
      this.last_p.load(isect.p)

      this._first2--
    }

    const spacing = brush.spacing
    let steps = 0

    if (mode === SculptTools.GRAB) {
      steps = 1
    }

    if (brush.spacingMode !== BrushSpacingModes.EVEN) {
      steps = 1
    } else if (mode !== SculptTools.GRAB) {
      steps = this.last_p.vectorDistance(isect.p) / (2.0 * radius * spacing)

      if (steps < 1) {
        return
      }

      steps = Math.max(Math.ceil(steps), 1)
    }

    //console.log("STEPS", steps, radius, spacing, this._first);

    const DRAW = SculptTools.DRAW
    const SHARP = SculptTools.SHARP
    const FILL = SculptTools.FILL
    const SMOOTH = SculptTools.SMOOTH
    const CLAY = SculptTools.CLAY
    const SCRAPE = SculptTools.SCRAPE
    const PAINT = SculptTools.PAINT
    const INFLATE = SculptTools.INFLATE
    const SNAKE = SculptTools.SNAKE
    const PAINT_SMOOTH = SculptTools.PAINT_SMOOTH
    const GRAB = SculptTools.GRAB

    if (mode === SHARP) {
      invert = !invert
    }

    const this2 = this

    const task = (function* () {
      const ds = 1.0 / steps

      const d1 = new Vector3(this2.last_p3).sub(this2.last_p4)
      const d2 = new Vector3(this2.last_p2).sub(this2.last_p3)
      const d3 = new Vector3(this2.last_p).sub(this2.last_p2)

      d1.interp(d2, 0.5).mulScalar(ds)
      d2.interp(d3, 0.5).mulScalar(ds)

      const ca = new Vector3(this2.last_p3)
      const cd = new Vector3(this2.last_p2)
      const cb = new Vector3(ca).addFac(d1, 1.0 / 3.0)
      const cc = new Vector3(cd).addFac(d2, -1.0 / 3.0)

      const bez = new Bezier(ca, cb, cc, cd)

      /* Make future curve. */
      d1.load(this2.last_p2).sub(this2.last_p3)
      d2.load(this2.last_p).sub(this2.last_p2)
      d3.load(isect.p).sub(this2.last_p)

      d1.interp(d2, 0.5).mulScalar(ds)
      d2.interp(d3, 0.5).mulScalar(ds)

      ca.load(this2.last_p2)
      cd.load(this2.last_p)
      cb.load(ca).addFac(d1, 1.0 / 3.0)
      cc.load(cd).addFac(d2, -1.0 / 3.0)

      const nextbez = new Bezier(ca, cb, cc, cd)

      if (!this2.lastbez) {
        this2.lastbez = bez
      }

      for (let i = 0; i < steps; i++) {
        const s = (i + 1) / steps

        let isplane = false

        switch (mode) {
          case FILL:
          case CLAY:
          case SCRAPE:
            isplane = true
            break
          default:
            isplane = false
            break
        }

        const sco = new Vector4().load3(bez.evaluate(s))
        sco[3] = 1.0
        view3d.project(sco)

        const p2 = bez.evaluate(s)
        const op2 = new Vector4(this2.last_origco3).interp(this2.last_origco2, s)

        p3.load3(p2)
        p3[3] = 1.0
        p3.multVecMatrix(rendermat)

        const w = p3[3] * matrix.$matrix.m11

        const vec2 = new Vector3(this2.last_vec).interp(vec, s)

        //view3d.makeDrawLine(isect.p, p2, [1, 0, 0, 1]);

        //console.log(isect, isect.tri);

        //vec.load(view);

        let esize = brush.dynTopo.edgeSize
        const emode = brush.dynTopo.edgeMode

        if (emode === DynTopoModes.SCREEN) {
          esize /= view3d.glSize[1] //Math.min(view3d.glSize[0], view3d.glSize[1]);
          esize *= w
        } else {
          esize *= 0.1
        }

        const radius2 = radius + (this2.last_radius - radius) * s

        if (invert) {
          if (isplane) {
            //planeoff = -planeoff;
          } else {
            //strength = -strength;
          }
        }

        const ps = new PaintSample()

        let ca2
        let cb2
        let cc2
        let cd2
        const ds2 = ds * 0.5

        const sp = s - ds2
        const sn = s + ds2

        if (sp <= 0) {
          ca2 = this2.lastbez.evaluate(sp + 1.0)
          cb2 = this2.lastbez
            .derivative(sp + 1.0)
            .mulScalar(ds / 3.0)
            .add(ca2)
          cd2 = bez.evaluate(sn)
          cc2 = bez
            .derivative(sn)
            .mulScalar(-ds / 3.0)
            .add(cd2)
        } else if (sn >= 1.0) {
          ca2 = bez.evaluate(sp)
          cb2 = bez
            .derivative(sp)
            .mulScalar(ds / 3.0)
            .add(ca2)
          cd2 = nextbez.evaluate(sn - 1.0)
          cc2 = nextbez
            .derivative(sn - 1.0)
            .mulScalar(-ds / 3.0)
            .add(cd2)
        } else {
          ca2 = bez.evaluate(sp)
          cb2 = bez
            .derivative(sp)
            .mulScalar(ds / 3.0)
            .add(ca2)
          cd2 = bez.evaluate(sn)
          cc2 = bez
            .derivative(sn)
            .mulScalar(-ds / 3.0)
            .add(cd2)
        }

        ps.curve = new Bezier(ca2, cb2, cc2, cd2).createQuads()

        ps.smoothProj = smoothProj
        ps.pinch = pinch
        ps.sharp = sharp
        ps.screenP.load(sco)
        ps.rake = rake
        ps.invert = invert
        ps.origp.load(op2)
        ps.p.load3(p2)
        ps.p[3] = w
        ps.viewPlane.load(view).normalize()
        ps.viewvec.load(view).normalize()
        ps.dstrokeS = brush.spacing
        ps.strokeS = 0 //will be set from lastps below
        ps.isInterp = isInterp || (i > 0 && i < steps - 1)

        ps.rendermat.load(rendermat)

        ps.concaveFilter = concaveFilter
        ps.autosmooth = autosmooth
        ps.autosmoothInflate = autosmoothInflate
        ps.esize = esize
        ps.vec.load(vec2)
        ps.planeoff = planeoff
        ps.radius = radius2
        ps.strength = strength

        let lastps
        const data = this2.inputs.samples.data

        if (this2.lastps1) {
          lastps = this2.lastps1

          ps.strokeS = lastps.strokeS + spacing

          ps.dScreenP.load(ps.screenP).sub(lastps.sp)
          ps.angle = Math.atan2(ps.dScreenP[1], ps.dScreenP[0])

          lastps.futureAngle = ps.angle

          ps.dvec.load(ps.vec).sub(lastps.vec)
          ps.dp.load(ps.p).sub(lastps.p)
        }

        const runps = this2.lastps2

        if (runps) {
          runps.futureAngle = lastps.angle
          data.push(runps)
        }

        this2.lastps2 = this2.lastps1
        this2.lastps1 = ps

        this2.inputs.samples.push(ps)

        if (this2.modalRunning && runps) {
          for (const iter of this2.execDotWithMirror_task(ctx, runps, lastps)) {
            yield
          }
        }
      }

      this2.lastbez = bez
    })()

    this.last_mpos.load(mpos)

    this.last_p5.load(this.last_p4)
    this.last_p4.load(this.last_p3)
    this.last_p3.load(this.last_p2)
    this.last_p2.load(this.last_p)
    this.last_p.load(isect.p)

    this.last_origco5.load(this.last_origco4)
    this.last_origco4.load(this.last_origco3)
    this.last_origco3.load(this.last_origco2)
    this.last_origco2.load(this.last_origco)
    this.last_origco.load3(origco)

    this.last_vec.load(vec)
    this.last_r = radius

    return task
  }

  initGrabData(mesh: any, co: Vector3, radius: number): void {
    const sym = this.inputs.symmetryAxes.getValue()
    const axismap = SymAxisMap

    let bvhRadius = radius
    const smul = this.inputs.brush.getValue().smoothRadiusMul

    bvhRadius *= smul

    const bvh = this.getBVH(mesh)
    const vs = bvh.closestVerts(co, bvhRadius)
    const co2 = new Vector3()

    const offs = axismap[sym]
    if (offs) {
      for (const off of offs) {
        co2.load(co).mul(off)
        const vs2 = bvh.closestVerts(co2, bvhRadius)

        for (const v of vs2) {
          vs.add(v)
        }
      }
    }

    const gd = [] as number[]
    const cd_grid = GridBase.meshGridOffset(mesh)
    const haveGrids = cd_grid >= 0
    this.grabDists = []
    const gdists = this.grabDists
    const sign = new Vector3()
    const add = new Vector3()

    if (haveGrids) {
      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid]
        grid.update(mesh, l, cd_grid)
      }

      this.grabEidMap = new Map()

      for (const v of vs) {
        gd.push(v.loopEid ?? -1)
        gd.push(v.eid)

        let dis = v.co.vectorDistance(co)
        const offs = axismap[sym]

        if (offs) {
          for (const off of offs) {
            co2.load(co).mul(off)
            const dis2 = v.co.vectorDistance(co2)
            if (dis2 < dis) {
              for (let i = 0; i < 3; i++) {
                if (off[i as Number3] < 0) {
                  //dis2 = Math.min(dis2, Math.abs(v[i]-co2[i]));
                }
              }
              dis = dis2
              sign.load(off)
            }
          }
        }

        gd.push(dis)

        gd.push(sign[0])
        gd.push(sign[1])
        gd.push(sign[2])

        gd.push(add[0])
        gd.push(add[1])
        gd.push(add[2])

        gd.push(0)
        gd.push(0)
        gd.push(0)

        gdists.push(dis)

        this.grabEidMap.set(v.eid, v)
      }
    } else {
      for (const v of vs) {
        gd.push(v.eid)
        gd.push(0)

        add.zero()
        sign[0] = sign[1] = sign[2] = 1.0

        const offs = axismap[sym]

        let dis = v.co.vectorDistance(co)
        if (sym && offs) {
          for (const off of offs) {
            for (let i = 0; i < 3; i++) {
              if (off[i as Number3] > 0) {
                continue
              }

              //dis2 = Math.min(dis2, Math.abs(v[i]-co2[i]));
              const f = Math.abs(co[i as Number3]) + 0.00001
              const ratio = radius / f

              //add[i] = -Math.abs(co[i]);
              sign[i as Number3] *= ratio
            }
          }
        }

        if (offs) {
          for (const off of offs) {
            co2.load(co).mul(off)
            const dis2 = v.co.vectorDistance(co2)
            if (dis2 < dis) {
              dis = dis2
              sign.load(off)
              add.zero()

              for (let i = 0; i < 3; i++) {
                if (off[i as Number3] > 0) {
                  continue
                }

                //dis2 = Math.min(dis2, Math.abs(v[i]-co2[i]));
                const f = Math.abs(co2[i as Number3]) + 0.00001
                const ratio = radius / f

                //add[i] = -Math.abs(co[i]);
                sign[i as 0 | 1 | 2] *= ratio
              }

              dis = dis2
            }
          }
        }

        gd.push(dis)

        gd.push(sign[0])
        gd.push(sign[1])
        gd.push(sign[2])

        gd.push(add[0])
        gd.push(add[1])
        gd.push(add[2])

        gd.push(0)
        gd.push(0)
        gd.push(0)

        gdists.push(dis)
      }
    }

    this.inputs.grabData.setValue(gd)
  }

  execPost(): void {
    //prevent nasty reference leak in undo stack
    this.grabEidMap = undefined

    if (this.smoother) {
      //this.smoother.finish();
      this.smoother = undefined
    }
  }

  _ensureGrabEidMap(ctx: any): void {
    const mesh = ctx.mesh || ctx.tetmesh

    if (!this.grabEidMap) {
      this.grabDists = []
      const gdists = this.grabDists

      const gmap = (this.grabEidMap = new Map())
      const grids = new WeakSet()
      const gd = this.inputs.grabData.getValue()

      const gridAttr = GridBase.meshGridRef(mesh)
      const cd_grid = gridAttr.i

      if (cd_grid >= 0) {
        for (let i = 0; i < gd.length; i += GTOT) {
          const dis = gd[i + 2]
          gdists.push(dis)

          const l = mesh.eidMap.get(gd[i])
          if (!l) {
            console.error('error, missing loop ' + l)
            continue
          }

          const grid = l.customData[cd_grid] as GridBase
          if (!grids.has(grid)) {
            grids.add(grid)
            grid.update(mesh, l, gridAttr)

            for (const p of grid.points) {
              gmap.set(p.eid, p)
            }
          }
        }
      } else {
        for (let i = 0; i < gd.length; i += GTOT) {
          const eid = gd[i]
          const dis = gd[i + 2]

          const v = mesh.eidMap.get(eid)
          if (!v) {
            console.warn('Missing vertex error: ' + eid + ' was missing')
            continue
          }

          gdists.push(dis)
          gmap.set(v.eid, v)
        }
      }
    }
  }

  execDotWithMirror(ctx: any, ps: any, lastps: any): void {
    for (const iter of this.execDotWithMirror_task(ctx, ps, lastps)) {
    }
  }

  *execDotWithMirror_task(ctx: any, ps: any, lastps: any): Generator<void> {
    const sym = this.inputs.symmetryAxes.getValue()

    if (!sym) {
      for (const iter of this.execDot_task(ctx, ps, lastps)) {
        yield
      }
      return
    }

    for (const iter of this.execDot_task(ctx, ps.copy(), lastps ? lastps.copy() : undefined)) {
      yield
    }

    const offs = SymAxisMap[sym]

    const mode = this.inputs.brush.getValue().tool
    if (mode === SculptTools.GRAB) {
      // || mode === SculptTools.SNAKE) {
      return
    }

    if (!offs) {
      return
    }

    for (const _off of offs) {
      const off = new Vector4(_off as unknown as Vector4)
      off[3] = 1.0

      const mps = ps.copy()
      const mlastps = lastps ? lastps.copy().mirror(off) : undefined

      mps.mirror(off)

      const gco = this.inputs.grabCo.getValue()
      const orig = new Vector3(gco)

      gco.mul(off)
      this.inputs.grabCo.setValue(gco)

      for (const iter of this.execDot_task(ctx, mps, mlastps)) {
        yield
      }

      this.inputs.grabCo.setValue(orig)
    }
  }

  exec(ctx: any): void {
    this.dynTopoRand.seed(0)
    this.rand.seed(0)

    const i = 0
    let lastps

    if (!this.modalRunning) {
      const mesh = ctx.mesh || ctx.tetmesh
      const brush = this.inputs.brush.getValue()

      const haveOrigData = PaintOpBase.needOrig(brush)

      if (haveOrigData) {
        this._checkOrig(ctx)
      }

      if (mesh) {
        this.getBVH(mesh)
      }
    }

    for (const ps of this.inputs.samples) {
      this.execDotWithMirror(ctx, ps, lastps)
      lastps = ps
    }

    /*
    for (let p of this.inputs.points) {
      this.execDot(ctx, p, this.inputs.vecs.getListItem(i), this.inputs.extra.getListItem(i), lastp);
      lastp = p;
      i++;
    }*/

    window.redraw_viewport(true)
  }

  getOrigCo(mesh: Mesh, v: Vertex | GridVert, cd_grid: AttrRef<GridBase>, cd_orig: AttrRef<Vector3LayerElem>): Vector3 {
    const gset = this._undo.gset
    const gmap = this._undo.gmap
    const vmap = this._undo.vmap

    if (cd_grid.i >= 0 && mesh.eidMap.has((v as GridVert).loopEid)) {
      const gridv = v as GridVert
      const l = mesh.eidMap.get(gridv.loopEid)
      const grid = l.customData.get(cd_grid)

      if (grid instanceof Grid) {
        const gdimen = grid.dimen
        const id = gridv.loopEid * gdimen * gdimen + gridv.index

        //let execDot set orig data
        if (!gset.has(id)) {
          return gridv.co
        }
      } else {
        if (!gmap.has(l)) {
          return gridv.co
        }
      }
    } else {
      //let execDot set orig data
      if (!vmap.has(v.eid)) {
        return v.co
        //v.customData[cd_orig].value.load(v);
        //vmap.set(v.eid, new Vector3(v));
      }
    }

    //ok, we have valid orig data? return it
    return v.customData.get(cd_orig).value
  }

  calcNormalVariance(mesh: any, bvh: any, co: Vector3, radius: number): {n: Vector3; t: Vector3} | undefined {
    const tris = bvh.closestTris(co, radius)

    const cd_cotan = mesh.verts.customData.getLayerIndex('cotan')

    //how much do normals cancel each other out?
    const n = new Vector3()
    const tan = new Vector3()
    let tot = 0

    const tan2 = new Vector3()

    const cd_curv = getCurveVerts(mesh)
    const cd_fset = getFaceSets(mesh, false)

    for (const t of tris) {
      if (!t.v1) {
        continue
      }

      const cv = t.v1.customData[cd_curv]
      cv.update(t.v1, cd_cotan, cd_fset)

      //tan2.load(cv.tan).normalize();
      tan.addFac(cv.tan, t.area)
      n.addFac(t.no, t.area)

      tot += t.area
    }

    if (!tot) {
      return undefined
    }

    tan.mulScalar(1.0 / tot)
    n.mulScalar(1.0 / tot)

    return {
      n,
      t: tan,
    }
  }

  sampleNormal(ctx: any, mesh: any, bvh: any, p: Vector3, radius: number): Vector3 {
    const vs = bvh.closestVerts(p, radius)

    const no = new Vector3()

    for (const v of vs) {
      no.add(v.no)
    }

    no.normalize()
    return no
  }

  execDot(ctx: any, ps: any, lastps: any): void {
    for (const iter of this.execDot_task(ctx, ps, lastps)) {
    }
  }

  *execDot_task(ctx: any, ps: any, lastps: any): Generator<void> {
    //ctx, p3, vec, extra, lastp3 = p3) {
    const brush = this.inputs.brush.getValue()
    const falloff = brush.falloff
    const falloff2 = brush.flag & BrushFlags.USE_LINE_CURVE ? brush.falloff2 : brush.falloff
    const haveTex = brush.texUser.texture !== undefined
    const texUser = brush.texUser
    let texScale = 1.0
    const tex = brush.texUser.texture

    if (this.inputs.brush.getValue().tool === SculptTools.GRAB) {
      this._ensureGrabEidMap(ctx)
    }

    const ob = ctx.object
    const obmat = ob.outputs.matrix.getValue()
    const mesh = ob.data as Mesh

    const DRAW = SculptTools.DRAW
    const SHARP = SculptTools.SHARP
    const FILL = SculptTools.FILL
    const SMOOTH = SculptTools.SMOOTH
    const CLAY = SculptTools.CLAY
    const SCRAPE = SculptTools.SCRAPE
    const PAINT = SculptTools.PAINT
    const INFLATE = SculptTools.INFLATE
    const SNAKE = SculptTools.SNAKE
    const PAINT_SMOOTH = SculptTools.PAINT_SMOOTH
    const GRAB = SculptTools.GRAB
    const COLOR_BOUNDARY = SculptTools.COLOR_BOUNDARY
    const MASK_PAINT = SculptTools.MASK_PAINT
    const WING_SCRAPE = SculptTools.WING_SCRAPE
    const PINCH = SculptTools.PINCH
    const TOPOLOGY = SculptTools.TOPOLOGY
    const DIRECTIONAL_FAIR = SculptTools.DIRECTIONAL_FAIR
    const SLIDE_RELAX = SculptTools.SLIDE_RELAX
    const FACE_SET_DRAW = SculptTools.FACE_SET_DRAW

    if (!ctx.object || !(ctx.object.data instanceof Mesh || ctx.object.data instanceof TetMesh)) {
      console.error('execDot: missing or invalid object data')
      return
    }

    const mode = this.inputs.brush.getValue().tool
    const haveOrigData = PaintOpBase.needOrig(brush)

    const drawFaceSet = this.inputs.drawFaceSet.getValue()
    const cd_fset = getFaceSets(mesh, mode === FACE_SET_DRAW)

    const undo = this._undo
    const vmap = undo.vmap
    const gset = undo.gset
    const gmap = undo.gmap
    const gdata = undo.gdata

    let mres: GridBase | undefined
    let oldmres: GridBase | undefined

    const bvh = this.getBVH(mesh)
    let vsw

    bvh.checkCD()

    /* test deforming base (well, level 1) of grid but displaying full thing
    if (GridBase.meshGridOffset(mesh) >= 0) {
      let cd_grid = GridBase.meshGridOffset(mesh);
      let layer = mesh.loops.customData.flatlist[cd_grid];

      mres = mesh.loops.customData.getLayerSettings(layer.typeName);
      if (mres) {
        for (let l of mesh.loops) {
          let grid = l.customData[cd_grid];
          let co = new Vector3();

          for (let p of grid.points) {
            co.load(p);
            let tot = 1;

            for (let pr of p.bRing) {
              co.add(pr);
              tot++;
            }

            co.mulScalar(1.0 / tot);
            p.load(co);
          }

          grid.recalcFlag |= QRecalcFlags.NORMALS|QRecalcFlags.TOPO|QRecalcFlags.NEIGHBORS;
          grid.update(mesh, l, cd_grid);
        }

        oldmres = mres.copy();

        mres.flag |= GridSettingFlags.ENABLE_DEPTH_LIMIT;
        mres.depthLimit = 1;

        mesh.regenBVH();
        for (let l of mesh.loops) {
          let grid = l.customData[cd_grid];

          grid.recalcFlag |= QRecalcFlags.NORMALS|QRecalcFlags.TOPO|QRecalcFlags.NEIGHBORS;
          grid.update(mesh, l, cd_grid);
        }
        bvh = mesh.getBVH({autoUpdate: false});
      }
    }
    //*/

    let pinch = ps.pinch
    let radius = ps.radius
    let strength = ps.strength

    if (mode === PINCH) {
      pinch = 1.0 //strength defines pinch in this case
    }

    const smoothProj = ps.smoothProj
    const haveQuadEdges = brush.dynTopo.flag & DynTopoFlags.DRAW_TRIS_AS_QUADS

    const haveGrids = bvh.cd_grid.i >= 0
    const gridAttr = bvh.cd_grid
    const cd_grid = gridAttr.i

    //let maskAttr: AttrRef<MaskElem>
    let cd_mask = haveGrids ? mesh.loops.customData.getLayerIndex('mask') : mesh.verts.customData.getLayerIndex('mask')

    let cd_curv = -1
    const cd_dyn_vert = getDynVerts(mesh)

    let rakeCurveFac = 0.0

    const doCurvRake = ENABLE_CURVATURE_RAKE && !haveGrids && (ps.rake > 0.0 || ps.pinch > 0.0 || mode === WING_SCRAPE)
    const rakeCurvePosXOnly = brush.flag & BrushFlags.CURVE_RAKE_ONLY_POS_X

    let sharp = ps.sharp
    if (ps.invert && mode === TOPOLOGY) {
      sharp += ps.autosmooth + Math.abs(ps.strength)
      ps.autosmooth = 0.0
    } else if (ps.invert && mode === SMOOTH) {
      sharp = Math.abs(ps.strength)
    }

    if (doCurvRake || sharp !== 0.0 || this.hasCurveVerts(brush)) {
      cd_curv = getCurveVerts(mesh)
      rakeCurveFac = brush.rakeCurvatureFactor
    }

    if (mode === MASK_PAINT && cd_mask < 0) {
      if (haveGrids) {
        mesh.verts.addCustomDataLayer('mask')
        GridBase.syncVertexLayers(mesh)

        cd_mask = mesh.loops.customData.getLayerIndex('mask')
      } else {
        cd_mask = mesh.verts.addCustomDataLayer('mask').index
      }
    }

    const cd_cotan = mesh.verts.customData.getLayerIndex('cotan')

    const isPaintMode = mode === PAINT || mode === PAINT_SMOOTH || mode === FACE_SET_DRAW
    const isMaskMode = mode === MASK_PAINT

    let doTopo = mode === TOPOLOGY || !!(brush.dynTopo.flag & DynTopoFlags.ENABLED)
    doTopo = doTopo && (!haveGrids || !this.inputs.useMultiResDepth.getValue())
    doTopo = doTopo && !(isPaintMode || isMaskMode)
    doTopo = doTopo && !(mesh instanceof TetMesh)

    //console.error("strokeS", ps.strokeS, ps.dstrokeS);

    if (brush.dynTopo.spacingMode !== BrushSpacingModes.EVEN && ps.isInterp) {
      doTopo = false
    } else if (mode !== SNAKE && brush.dynTopo.spacingMode === BrushSpacingModes.EVEN) {
      //enforce dyntopo spacing

      let p1 = lastps ? lastps.strokeS : 0.0
      let p2 = ps.strokeS

      const spacing = 0.5 * brush.dynTopo.spacing

      p1 = ~~(p1 / spacing)
      p2 = ~~(p2 / spacing)

      if (lastps && p1 === p2) {
        doTopo = false
      }
    }

    let planeoff = ps.planeoff
    let pinchpower = 1.0
    let pinchmul = 1.0

    let isplane = false

    const vec = new Vector3(ps.vec)
    const planep = new Vector3(ps.p)

    const cd_disp = mesh.verts.customData.getLayerIndex('displace')
    const esize = ps.esize

    let w = ps.p[3]

    if (haveTex) {
      texScale *= 10.0 / w
    }

    switch (mode) {
      case SMOOTH:
      case PAINT_SMOOTH:
        vsw = Math.abs(strength) + ps.autosmooth
        break
      default:
        vsw = ps.autosmooth //autosmooth
        break
    }

    const wvec1 = new Vector3()
    const wvec2 = new Vector3()
    const wtan = new Vector3()
    const wtmp0 = new Vector3()
    const wtmp1 = new Vector3()
    const wtmp2 = new Vector3()
    const wtmp3 = new Vector3()
    const wno = new Vector3()
    let woff = planeoff
    const wplanep1 = new Vector3()
    const wplanep2 = new Vector3()

    if (mode === WING_SCRAPE) {
      isplane = true

      pinchpower = 3.0
      pinchmul = 0.25

      //sample normal
      const no = this.sampleNormal(ctx, mesh, bvh, ps.p, radius * 0.25)
      const tan = new Vector3(ps.dp)

      const d = no.dot(tan)
      tan.addFac(no, -d).normalize()

      const len = vec.vectorLength()
      const quat = new Quat()

      const th = Math.PI * 0.2
      quat.axisAngleToQuat(tan, -th)
      quat.normalize()
      let mat = quat.toMatrix()

      wvec1.load(no) //.mulScalar(len);
      wvec1.multVecMatrix(mat)

      quat.axisAngleToQuat(tan, th)
      quat.normalize()
      mat = quat.toMatrix()

      wvec2.load(no) //.mulScalar(len);
      wvec2.multVecMatrix(mat)

      wno.load(no)
      wtan.load(tan)

      //planep.load(ps.p).addFac(wno, woff);

      woff = ps.planeoff * 0.25

      wplanep1.load(ps.p).addFac(wvec1, -0.005)
      wplanep2.load(ps.p).addFac(wvec2, -0.005)

      //wplanep1.addFac(wno, woff);
      //wplanep2.addFac(wno, woff);

      planeoff = 0
      //vec.multVecMatrix(mat);
      //vec.load(tan).mulScalar(len);
      //
    } else if (mode === MASK_PAINT) {
      strength = Math.abs(strength)
    } else if (mode === SCRAPE) {
      planeoff += -1.0
      //strength *= 5.0;
      isplane = true
    } else if (mode === FILL) {
      planeoff -= 0.1

      strength *= 0.5
      isplane = true
    } else if (mode === CLAY) {
      planeoff += 3.25

      //strength *= 2.0;

      isplane = true
    } else if (mode === SMOOTH) {
      isplane = !(brush.flag & BrushFlags.MULTIGRID_SMOOTH)
      isplane = isplane && !!(brush.flag & BrushFlags.PLANAR_SMOOTH)

      if (brush.flag & BrushFlags.MULTIGRID_SMOOTH) {
        strength *= 0.15
      }

      //if (1 || (brush.flag & BrushFlags.MULTIGRID_SMOOTH)) {
      radius *= 1.0 + vsw * vsw

      //}
    } else if (mode === PAINT) {
    } else if (mode === SHARP) {
      const t1 = new Vector3(ps.dp)

      //isplane = true;
      //planeoff += 3.0;
      //strength *= 2.0;
    } else if (mode === GRAB) {
      strength *= 5.0
      radius *= this.inputs.grabRadiusFactor.getValue()

      isplane = false
    } else if (mode === SNAKE || mode === SLIDE_RELAX || mode === FACE_SET_DRAW) {
      isplane = false
    }

    if (ps.invert) {
      //isplane && strength < 0) {
      //strength = Math.abs(strength);
      if (isplane) {
        planeoff = -planeoff
      } else if (mode !== SMOOTH && mode !== PAINT_SMOOTH) {
        strength *= -1
      }
    }

    let updateflag = BVHFlags.UPDATE_DRAW
    if (mode !== PAINT && mode !== PAINT_SMOOTH) {
      updateflag |= BVHFlags.UPDATE_NORMALS
    } else {
      updateflag |= BVHFlags.UPDATE_COLORS
    }

    const cd_orig = haveOrigData ? this.initOrigData(mesh) : undefined
    const sym = mesh.symFlag

    if (mode !== SNAKE && mode !== SLIDE_RELAX) {
      //let w2 = Math.pow(Math.abs(w), 0.5)*Math.sign(w);
      const w2 = Math.pow(Math.abs(radius), 0.5) * Math.sign(radius)

      planeoff *= w2

      vec.mulScalar(strength * 0.1 * w2)
    }

    const vlen = vec.vectorLength()
    const nvec = new Vector3(vec).normalize()
    const nvec2 = new Vector3(nvec)

    planep.addFac(nvec, planeoff * radius * 0.5)

    if (0 && mode === SHARP) {
      const q = new Quat()
      const pth = Math.PI * 0.35

      q.axisAngleToQuat(nvec, pth)
      let mat = q.toMatrix()

      nvec.multVecMatrix(mat)

      q.axisAngleToQuat(nvec2, -pth)
      mat = q.toMatrix()

      nvec2.multVecMatrix(mat)
    }

    const p3 = new Vector3(ps.p)

    let useLinePlane = !!(brush.flag & BrushFlags.LINE_FALLOFF)
    if (ps.dp.dot(ps.dp) === 0.0) {
      useLinePlane = false
    }

    const linePlane = new Vector3(ps.dp).cross(ps.viewPlane).normalize()
    const linePlane2 = new Vector3(ps.dp)

    //move into view plane
    const d = linePlane2.dot(ps.viewPlane)
    linePlane2.addFac(ps.viewPlane, -d).normalize()

    const useSmoothMemo = vsw < 0.75 && GridBase.meshGridOffset(mesh) < 0

    let smemo: SmoothMemoizer | undefined
    if (useSmoothMemo) {
      smemo = new SmoothMemoizer(mesh, new AttrRef(-1))
      smemo.noDisp = true
      smemo.projection = smoothProj
      smemo.smoothGen = Math.random()
      smemo.initGen = Math.random()
      smemo.start(false, new AttrRef(-1), true)
      smemo.memoize = !(window.noMemoize ?? false)
    }

    //query bvh tree
    let vs: Set<IBVHVertex>
    let gd: number[] | undefined
    const signs = [] as number[]
    const goffs = [] as number[]
    const gidxs = [] as number[]

    let bvhRadius = radius
    const smoothRadiusMul = brush.smoothRadiusMul

    if (smoothRadiusMul !== 1.0) {
      bvhRadius *= smoothRadiusMul
    }

    if (mode === GRAB && doTopo && cd_orig !== undefined) {
      this.grabDists = []
      const gdists = this.grabDists

      const co = this.inputs.grabCo.getValue() //ps.origp;

      vs = bvh.closestOrigVerts(co, bvhRadius)
      gd = [] as number[]

      const axismap = SymAxisMap
      const sym = this.inputs.symmetryAxes.getValue()

      const co2 = new Vector3()
      const sign = new Vector3()
      const add = new Vector3()

      for (const v of vs) {
        let dis = v.customData.get(cd_orig).value.vectorDistance(co)
        const offs = axismap[sym]

        add.zero()
        sign[0] = sign[1] = sign[2] = 1.0

        if (sym && offs) {
          for (const off of offs) {
            for (let i = 0; i < 3; i++) {
              if (off[i as Number3] > 0) {
                continue
              }

              //dis2 = Math.min(dis2, Math.abs(v[i]-co2[i]));
              const f = Math.abs(co[i as Number3]) + 0.00001
              const ratio = radius / f

              //add[i] = -Math.abs(co[i]);
              sign[i as 0 | 1 | 2] *= ratio
            }
          }
        }

        if (offs) {
          for (const off of offs) {
            co2.load(co).mul(off)

            const dis2 = v.co.vectorDistance(co2)
            if (dis2 < dis) {
              dis = dis2
              sign.load(off)
              add.zero()

              for (let i = 0; i < 3; i++) {
                if (off[i as Number3] > 0) {
                  continue
                }

                //dis2 = Math.min(dis2, Math.abs(v[i]-co2[i]));
                const f = Math.abs(co2[i as Number3]) + 0.00001
                const ratio = radius / f

                //add[i] = -Math.abs(co[i]);
                sign[i as 0 | 1 | 2] *= ratio
              }

              dis = dis2
            }
          }
        }

        const i = gd.length

        gd.push(v.eid)
        gd.push(0)
        gd.push(dis)

        gd.push(sign[0])
        gd.push(sign[1])
        gd.push(sign[2])

        gd.push(add[0])
        gd.push(add[1])
        gd.push(add[2])

        gd.push(0)
        gd.push(0)
        gd.push(0)

        const jtot = GTOT - (gd.length - i)

        for (let j = 0; j < jtot; j++) {
          gd.push(0)
        }

        signs.push(sign[0])
        signs.push(sign[1])
        signs.push(sign[2])

        gdists.push(dis)

        goffs.push(0)
        goffs.push(0)
        goffs.push(0)

        gidxs.push(i)
      }
    } else if (mode === GRAB) {
      const gmap = this.grabEidMap
      gd = this.inputs.grabData.getValue()
      vs = new Set()

      if (haveGrids) {
        for (let i = 0; i < gd.length; i += GTOT) {
          const leid = gd[i]
          const peid = gd[i + 1]
          const dis = gd[i + 2]

          const v = gmap!.get(peid)
          if (!v) {
            console.warn('Missing grid vert ' + peid)
            throw new Error('missing grid vert')
            continue
          }

          const sx = gd[i + 3]
          const sy = gd[i + 4]
          const sz = gd[i + 5]
          signs.push(sx)
          signs.push(sy)
          signs.push(sz)

          const ox = gd[i + 6]
          const oy = gd[i + 7]
          const oz = gd[i + 8]

          goffs.push(ox)
          goffs.push(oy)
          goffs.push(oz)

          vs.add(v)
          gidxs.push(i)
        }
      } else {
        for (let i = 0; i < gd.length; i += GTOT) {
          const v = mesh.eidMap.get<Vertex>(gd[i])

          if (!v) {
            console.warn('Missing vert ' + gd[i])
            //signs.length += 3;
            //goffs.length += 3;
            //vs.push(new Vector3());

            continue
          }

          const sx = gd[i + 3]
          const sy = gd[i + 4]
          const sz = gd[i + 5]
          signs.push(sx)
          signs.push(sy)
          signs.push(sz)

          const ox = gd[i + 6]
          const oy = gd[i + 7]
          const oz = gd[i + 8]

          goffs.push(ox)
          goffs.push(oy)
          goffs.push(oz)

          vs.add(v)
          gidxs.push(i)
        }
      }
    } else {
      if (brush.flag & BrushFlags.SQUARE) {
        const mat = new Matrix4()

        const linePlane3 = new Vector3(linePlane)
        const d = linePlane3.dot(ps.viewPlane)
        linePlane3.addFac(ps.viewPlane, -d).normalize()

        let bad = ps.dp.dot(ps.dp) < 0.00001 || linePlane3.dot(linePlane3) < 0.00001
        bad = bad || linePlane3.vectorDistanceSqr(ps.viewPlane) < 0.0001
        bad = bad || Math.abs(linePlane3.dot(ps.viewPlane)) > 0.001

        if (bad) {
          return //do nothing
        }

        ps.viewPlane.normalize()

        mat.makeNormalMatrix(ps.viewPlane, linePlane3)
        mat.invert()

        vs = bvh.closestVertsSquare(p3, bvhRadius, mat)
      } else {
        vs = bvh.closestVerts(p3, bvhRadius)
      }
    }

    if (doTopo && !haveGrids) {
      const log = this._undo.log
      log.checkStart(mesh)

      for (const v of vs) {
        log.ensure(v)

        for (const v2 of v.neighbors) {
          log.ensure(v2)
        }
      }
    }

    if (mode === SNAKE || mode === SLIDE_RELAX) {
      p3.zero()
      let tot = 0.0

      for (const v of vs) {
        p3.add(v.co)
        tot++
      }

      if (tot) {
        p3.mulScalar(1.0 / tot)
      }
    }

    const rmat = new Matrix4()

    const _tmp = new Vector3()

    let vsmooth: any
    let gdimen: number
    let cd_color: number
    let have_color: boolean
    let haveQuadTreeGrids = false

    if (haveGrids) {
      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid] as GridBase

        if (grid instanceof QuadTreeGrid) {
          haveQuadTreeGrids = true
        } else if (grid instanceof KdTreeGrid) {
          haveQuadTreeGrids = true
        }

        break
      }
    }

    const origset = new WeakSet()
    const mmap = this._undo.mmap
    const fsetmap = this._undo.fsetmap

    function doUndo(v: any): void {
      if (!haveGrids && mode === MASK_PAINT && cd_mask >= 0 && !mmap.has(v.eid)) {
        mmap.set(v.eid, v.customData[cd_mask].value)
      }

      if (mode === FACE_SET_DRAW && !vmap.has(v.eid)) {
        for (const f of v.faces) {
          if (!fsetmap.has(f.eid)) {
            const fset = f.customData[cd_fset].value

            fsetmap.set(f.eid, fset)
          }
        }

        vmap.set(v.eid, new Vector3(v))
      }

      if (doTopo && !haveGrids) {
        if (haveOrigData && !vmap.has(v.eid)) {
          const data = v.customData.get(cd_orig).value

          data.load(v.co)

          if (isPaintMode && have_color) {
            vmap.set(v.eid, new Vector4(v.customData[cd_color].color))
          } else {
            vmap.set(v.eid, new Vector3(data))
          }
        }

        return
      }

      if (!haveGrids && !vmap.has(v.eid)) {
        if (haveOrigData) {
          v.customData.get(cd_orig).value.load(v.co)
        }

        if (isPaintMode && have_color) {
          vmap.set(v.eid, new Vector4(v.customData[cd_color].color))
        } else if (!isPaintMode) {
          vmap.set(v.eid, new Vector3(v.co))
        }
      } else if (haveQuadTreeGrids && cd_orig !== undefined) {
        const node = cd_node.get(v)
        v.flag |= MeshFlags.UPDATE

        if (node.node) {
          node.node.flag |= updateflag
        }

        if (v.loopEid !== undefined) {
          const l = mesh.eidMap.get(v.loopEid)

          if (l && l instanceof Loop && l.eid === v.loopEid) {
            const grid = l.customData[cd_grid] as GridBase

            if (!gmap.has(l)) {
              if (haveOrigData) {
                for (const p of grid.points) {
                  ;(p.customData.get(cd_orig) as Vector3LayerElem).value.load(p.co)
                }
              }

              grid.recalcFlag |= QRecalcFlags.MIRROR | QRecalcFlags.NORMALS
              grid.update(mesh, l, gridAttr)

              bvh.updateGridLoops.add(l)

              const gridcpy = new grid.constructor()
              grid.copyTo(gridcpy, true)

              gmap.set(l, gridcpy)
              grid.update(mesh, l, gridAttr)
              grid.relinkCustomData()
            } else {
              //grid.recalcFlag |= QRecalcFlags.MIRROR|QRecalcFlags.NORMALS;
              //bvh.updateGridLoops.add(l);
            }
          }
        }
      } else if (haveGrids && cd_orig !== undefined) {
        const id = v.loopEid * gdimen * gdimen + v.index

        if (!gset.has(id)) {
          if (haveOrigData) {
            v.customData.get(cd_orig).value.load(v.co)
          }

          gset.add(id)

          let gi = gdata.length
          gdata.length += UGTOT

          gdata[gi++] = v.loopEid
          gdata[gi++] = v.index

          if (isPaintMode) {
            const c = v.customData[cd_color].color
            gdata[gi++] = c[0]
            gdata[gi++] = c[1]
            gdata[gi++] = c[2]
            gdata[gi++] = c[3]
          } else if (isMaskMode) {
            let mask = 1.0

            if (cd_mask >= 0) {
              mask = (v.customData[cd_mask] as MaskElem).value
            }

            gdata[gi++] = mask
          } else {
            gdata[gi++] = v[0]
            gdata[gi++] = v[1]
            gdata[gi++] = v[2]
            gdata[gi++] = v.no[0]
            gdata[gi++] = v.no[1]
            gdata[gi++] = v.no[2]
          }
        }
      }
    }

    function doGridBoundary(v: any): void {
      if (v.eid < 0) {
        console.warn('eek!', v)
        return
      }

      if (!v.bLink?.v1) {
        return
      }

      if (v.bLink.v1.eid < 0) {
        console.warn('eek2!', v.bLink.v1)
        return
      }

      if (v.bLink.v2 && v.bLink.v2.eid < 0) {
        console.warn('eek3!', v.bLink.v2)
        return
      }

      //return;
      doUndo(v.bLink.v1)

      if (v.bLink.v2) {
        doUndo(v.bLink.v2)
      }

      if (isPaintMode && have_color) {
        const c1 = v.customData[cd_color].color
        const c2 = v.bLink.getColor(cd_color)

        c1.interp(c2, 0.5)

        //if (isNaN(c1.dot(c1))) {
        //  c1.load(c2);
        //}

        if (!v.bLink.v2) {
          const c2 = v.bLink.v1.customData[cd_color].color
          c2.load(c1)
        }
      } else if (!isPaintMode) {
        const co = v.bLink.get().co

        if (!v.bLink.v2) {
          v.co.interp(co, 0.5)
          v.bLink.v1.co.load(v.co)
        } else {
          v.co.load(co)
        }
      }

      let node = cd_node.get(v.bLink.v1).node
      if (node) {
        node.setUpdateFlag(updateflag)
      }

      if (v.bLink.v2) {
        node = cd_node.get(v.bLink.v2).node

        if (node) {
          node.setUpdateFlag(updateflag)
        }
      }
    }

    let colorfilter: any
    if (bvh.cd_grid.i >= 0) {
      cd_color = mesh.loops.customData.getLayerIndex('color')
    } else {
      cd_color = mesh.verts.customData.getLayerIndex('color')
    }
    have_color = cd_color >= 0

    const smoothmap = new Map()

    const _gridVertStitch = (v: any): void => {
      if (v.eid < 0) {
        console.warn('eek!', v)
        return
      }

      let first = true

      const update = false
      let co = v

      for (const vr of v.bRing) {
        if (vr.eid < 0) {
          console.warn('eek!', v, vr)
          continue
        }

        if (vr.bLink?.v1 && vr.bLink.v2) {
          co = vr
        }
      }

      for (const vr of v.bRing) {
        //v.neighbors) {
        if (vr.eid < 0) {
          continue
        }

        doUndo(vr)
        //continue;

        const update = first || vr.vectorDistanceSqr(co) > 0.00001

        if (first) {
          vr.interp(v, 0.5)
          co.load(vr.co, true)
          doGridBoundary(co)

          first = false
        } else {
          vr.co.load(co, true)
        }

        if (1 || update) {
          const node = cd_node.get(vr.customData).node

          if (node) {
            node.setUpdateFlag(updateflag)
          }

          doGridBoundary(vr)
        }
      }

      doGridBoundary(v)
    }

    const gridVertStitch = (v: any): void => {
      //return;

      _gridVertStitch(v)

      return
      for (const v2 of v.neighbors) {
        _gridVertStitch(v2)
      }

      doGridBoundary(v)

      for (const v2 of v.bRing) {
        if (v2.eid >= 0) {
          doGridBoundary(v2)
        }
      }
    }

    let vsharp: (v: IBVHVertex, fac: number) => void | undefined

    if (haveGrids) {
      colorfilter = colorfilterfuncs[1]

      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid] as GridBase

        gdimen = grid.dimen
        break
      }

      const _tmp4 = new Vector3()

      vsharp = (v: any, fac: number): void => {
        //implement me!
      }

      vsmooth = (v: any, fac: number): void => {
        _tmp.zero()
        let totw = 0.0

        /*
        for (let vr of v.bRing) {//v.neighbors) {
          doUndo(vr);
          vr.co.interp(v.co, 0.5);
          v.co.load(vr.co, true);
        }

        for (let vr of v.bRing) {
          for (let v2 of vr.neighbors) {
            if (v2 === vr || v2.loopEid !== vr.loopEid) {
              continue;
            }

            let w = 1.0;

            if (smoothProj !== 0.0) {
              let w2 = v2.vectorDistanceSqr(v);
              w += (w2 - w)*smoothProj;

              let t = _tmp4.load(v2).sub(v);
              let d = t.dot(v.no);

              t.addFac(v.no, -d).add(v);

              _tmp.addFac(t, smoothProj*w);
              _tmp.addFac(v2, (1.0 - smoothProj)*w);
            } else {
              _tmp.addFac(v2, w);
            }

            totw += w;
          }
        }//*/

        for (const v2 of v.neighbors) {
          let w = 1.0

          if (v2.loopEid !== v.loopEid) {
            continue
          }

          if (smoothProj !== 0.0) {
            const w2 = v2.co.vectorDistanceSqr(v.co)
            w += (w2 - w) * smoothProj

            const t = _tmp4.load(v2.co).sub(v.co)
            const d = t.dot(v.no)

            t.addFac(v.no, -d).add(v.co)

            _tmp.addFac(t, smoothProj * w)
            _tmp.addFac(v2.co, (1.0 - smoothProj) * w)
          } else {
            _tmp.addFac(v2.co, w)
          }

          totw += w
        }

        if (totw !== 0.0) {
          _tmp.mulScalar(1.0 / totw)
          v.co.interp(_tmp, fac)
        }

        gridVertStitch(v)

        /*
        for (let v2 of v.bRing) {
          v2[0] = v[0];
          v2[1] = v[1];
          v2[2] = v[2];
        }//*/
      }
    } else if (ps.autosmoothInflate === 0.0 && smoothProj === 0.0 && !(brush.flag & BrushFlags.MULTIGRID_SMOOTH)) {
      colorfilter = colorfilterfuncs[0]
      const _tmp2 = new Vector3()
      const _tmp3 = new Vector3()
      const _tmp4 = new Vector3()

      let velfac // = window.dd !== undefined ? window.dd : 0.75;
      if (mode !== GRAB) {
        if (mode === SMOOTH) {
          velfac = strength * 0.5 + 0.5
        } else {
          velfac = ps.autosmooth * 0.5 + 0.5
        }

        velfac *= 0.5
        velfac *= (1.0 - smoothProj) * 0.75 + 0.25
      } else {
        velfac = 0.5
        velfac *= (1.0 - smoothProj) * 0.75 + 0.25
      }

      const quadedge = haveQuadEdges ? MeshFlags.QUAD_EDGE : 0

      const velfac2 = velfac * 0.05

      vsmooth = function (v: Vertex, fac: number) {
        if (mode === SMOOTH && ps.invert) {
          vsharp(v, fac)
          return
        }

        const vel = cd_node.get(v).vel

        _tmp2.zero()
        let count = 0
        let totw = 0.0

        for (const e of v.edges) {
          if (e.flag & quadedge) {
            continue
          }

          //let v2 = e.otherVertex(v);
          const v2 = v === e.v1 ? e.v2 : e.v1

          _tmp2[0] += v2[0]
          _tmp2[1] += v2[1]
          _tmp2[2] += v2[2]

          const vel2 = cd_node.get(v2).vel

          //vel2.addFac(vel, velfac2*0.1);

          vel2[0] += (vel[0] - vel2[0]) * velfac2
          vel2[1] += (vel[1] - vel2[1]) * velfac2
          vel2[2] += (vel[2] - vel2[2]) * velfac2

          totw += 1.0
          count++
        }

        if (count === 0.0) {
          return
        }

        _tmp2.mulScalar(1.0 / totw)
        _tmp3.load(v.co)

        v.co.interp(_tmp2, fac)
        v.co.addFac(vel, velfac)

        _tmp3.sub(v.co).negate()
        //vel.interp(_tmp3, 0.5);
        vel.load(_tmp3)
      }
    } else if (!(brush.flag & BrushFlags.MULTIGRID_SMOOTH)) {
      colorfilter = colorfilterfuncs[0]
      const _tmp2 = new Vector3()
      const _tmp3 = new Vector3()
      const _tmp4 = new Vector3()

      let velfac

      if (mode !== GRAB) {
        if (mode === SMOOTH) {
          velfac = strength * 0.5 + 0.5
        } else {
          velfac = ps.autosmooth * 0.5 + 0.5
        }

        velfac *= 0.5
        velfac *= (1.0 - smoothProj) * 0.75 + 0.25
      } else {
        velfac = 0.5
        velfac *= (1.0 - smoothProj) * 0.75 + 0.25
      }

      const velfac2 = velfac * 0.05

      const quadedge = haveQuadEdges ? MeshFlags.QUAD_EDGE : 0
      const inflate = ps.autosmoothInflate

      vsmooth = (v: any, fac: number): void => {
        if (mode === SMOOTH && ps.invert) {
          vsharp(v, fac)
          return
        }

        const vel = cd_node.get(v).vel

        _tmp2.zero()
        let count = 0
        let totw = 0.0
        let avglen = 0.0

        for (const e of v.edges) {
          if (e.flag & quadedge) {
            continue
          }

          const v2 = e.otherVertex(v)
          let w = 1.0
          //w = Math.sqrt(w);
          //w *= w;

          if (smoothProj !== 0.0) {
            const w2 = v2.vectorDistanceSqr(v)
            avglen += w2

            w += (w2 - w) * smoothProj

            const t = _tmp4.load(v2).sub(v)
            const d = t.dot(v.no)

            t.addFac(v.no, -d).add(v)

            _tmp2.addFac(t, smoothProj * w)
            _tmp2.addFac(v2, (1.0 - smoothProj) * w)
          } else {
            avglen += v2.vectorDistanceSqr(v)
            _tmp2.addFac(v2, w)
          }

          const vel2 = cd_node.get(v2).vel

          vel2.interp(vel, velfac2)
          //vel2.addFac(vel, 0.1*velfac);

          totw += w
          count++
        }

        if (count === 0.0) {
          return
        }

        //let w2 = totw/count*0.1;
        //_tmp2.addFac(v, w2);
        //totw += w2;
        //count++;

        avglen /= count

        _tmp2.mulScalar(1.0 / totw)
        //_tmp2.sub(v);
        //let d = -_tmp2.dot(v.no);
        //let d = _tmp2.vectorLength();
        //_tmp2.add(v);
        _tmp2.addFac(v.no, avglen * inflate * 4.0)

        _tmp3.load(v.co)

        v.co.interp(_tmp2, fac)
        v.co.addFac(vel, velfac)

        _tmp3.sub(v.co).negate()
        vel.interp(_tmp3, 0.5)
      }
    } else {
      colorfilter = colorfilterfuncs[0]

      vsmooth = (v: any, fac: number = 0.5): void => {
        this.ensureSmoother(mesh)
        smoothmap.set(v, fac / vsw)
      }
    }

    const mat1 = new Matrix4()
    const _tmp4 = new Vector3()
    const _tmp5 = new Vector3()

    const vsmooth_median = (v: any, fac: number = 0.5): void => {
      const nmat = mat1

      mat1.makeIdentity()
      mat1.makeNormalMatrix(v.no)
      mat1.transpose()

      const co = _tmp.zero()
      const co2 = _tmp4.zero()
      const co3 = _tmp5.zero()

      let totw = 0.0

      const val = v.valence
      if (val < 2) {
        return
      }

      const list1 = getArrayTemp<number>(val + 1, false)
      const list2 = getArrayTemp<number>(val + 1, false)
      const list3 = getArrayTemp<number>(val + 1, false)

      let vi = 1

      list1[0] = 0
      list2[0] = 0
      list3[0] = 0

      for (const v2 of v.neighbors) {
        co2.load(v2).sub(v).multVecMatrix(nmat)
        //co2.load(v2).sub(v);

        list1[vi] = co2[0]
        list2[vi] = co2[1]
        list3[vi] = co2[2]
        vi++

        co3.add(v2)
        totw++
      }

      list1.sort()
      list2.sort()
      list3.sort()

      const len = list1.length
      const idx = (len - 1) >> 1

      if (len > 2 && (len & 1) === 0) {
        co[0] = list1[idx] * 0.5 + list1[idx + 1] * 0.5
        co[1] = list2[idx] * 0.5 + list2[idx + 1] * 0.5
        co[2] = list3[idx] * 0.5 + list3[idx + 1] * 0.5
      } else {
        co[0] = list1[idx]
        co[1] = list2[idx]
        co[2] = list3[idx]
      }

      mat1.transpose()

      co.multVecMatrix(mat1)
      co.add(v.co)

      co3.mulScalar(1.0 / totw)
      co.interp(co3, 0.5)

      v.co.interp(co, fac)
    }

    //vsmooth = vsmooth_median;

    if (!haveGrids) {
      const _tmp0 = new Vector3()
      const _tmp1 = new Vector3()
      const _tmp2 = new Vector3()
      const _tmp3 = new Vector3()
      const _tmp4 = new Vector3()

      vsharp = (v: IBVHVertex, fac: number): void => {
        const cv = v.customData[cd_curv] as CurvVert
        cv.check(v, cd_cotan, undefined, cd_fset)

        let maxedge = 0
        let minedge = 1e17

        for (const v2 of v.neighbors) {
          const dist = v2.co.vectorDistance(v.co)
          maxedge = Math.max(maxedge, dist)
          minedge = Math.min(minedge, dist)
        }

        const flag = MeshFlags.NOAPI_TEMP2

        //go over two vert rings
        for (const v1 of v.neighbors) {
          const cv1 = v1.customData[cd_curv] as CurvVert
          cv1.check(v1)
          v1.flag &= ~flag

          for (const v2 of v1.neighbors) {
            const cv2 = v2.customData[cd_curv] as CurvVert
            cv2.check(v2)

            v2.flag &= ~flag
            maxedge = Math.max(maxedge, v2.co.vectorDistanceSqr(v.co))
          }
        }

        maxedge = Math.sqrt(maxedge)

        let totw = 0
        const co = _tmp2.zero()
        const proj = smoothProj

        function add(v2: IBVHVertex): void {
          const cv2 = v2.customData[cd_curv] as CurvVert

          v2.flag |= flag
          let w = 1.0

          let dist
          const co2 = _tmp4

          if (smoothProj > 0.0) {
            co2.load(v2.co).sub(v.co)
            const d = co2.dot(v.no)

            co2.addFac(v.no, -d * smoothProj).add(v.co)
            dist = co2.vectorDistance(v.co)
          } else {
            co2.load(v2.co)
            dist = v2.co.vectorDistance(v.co)
          }

          const w2 = 1.0 - dist / maxedge
          //w2 *= w2*w2;

          const d = 0.1
          //w2 = (w2 - d) / (1.0 - d);

          w *= w2

          //w = 1.0;
          w = cv2.k1

          co.addFac(co2, w)
          totw += w
        }

        for (const v1 of v.neighbors) {
          if (!(v1.flag & flag)) {
            add(v1)
          }

          continue
          for (const v2 of v1.neighbors) {
            if (!(v2.flag & flag)) {
              add(v2)
            }
          }
        }

        const ratio = minedge / maxedge

        if (totw !== 0.0 && ratio !== 0.0) {
          co.mulScalar(1.0 / totw)

          const co2 = _tmp4.load(co).sub(v.co)
          const d = co2.dot(v.no)
          co2.addFac(v.no, -d)

          //subtract horizontal movement
          const dfac = 1.0 - ratio
          co.addFac(co2, -dfac)

          v.co.interp(co, fac)
          v.flag |= MeshFlags.UPDATE
        }
      }
    }

    const _rtmp = new Vector3()
    const _rtmp2 = new Vector3()
    const _rdir = new Vector3()
    _rdir.load(ps.dp).normalize()

    const rakefac = ps.rake * 0.5

    const rtmps = util.cachering.fromConstructor(Vector3, 64)

    function rerror(v: any): number {
      const d1 = rtmps.next()
      const d2 = rtmps.next()
      let err = 0.0

      d1.load(ps.dp).normalize()
      const d = d1.dot(v.no)

      d1.addFac(v.no, -d).normalize()

      for (const v2 of v.neighbors) {
        d2.load(v2).sub(v)

        const d = d2.dot(v.no)
        d2.addFac(v.no, -d).normalize()

        let w = d1.dot(d2)

        w = Math.abs(w)
        w = 1.0 - Math.abs(w - 0.5) * 2.0
        w = 1.0 - Math.abs(w - 0.5) * 2.0

        err += w * w
      }

      return err
    }

    const rake2 = (v: any, fac: number = 0.5): void => {
      const co = _rtmp.zero()
      const g = _rtmp2.zero()

      const df = 0.0001

      let r1 = rerror(v)
      let totg = 0.0

      for (let i = 0; i < 3; i++) {
        const orig = v[i]

        v[i] += df
        const r2 = rerror(v)
        v[i] = orig

        g[i as 0 | 1 | 2] = (r2 - r1) / df
        totg += g[i as Number3] * g[i as Number3]
      }

      if (totg === 0.0) {
        return
      }

      r1 /= totg
      g.mulScalar(-r1)

      //co.load(v).add(g);

      v.addFac(g, 0.25 * fac)
    }

    if (useSmoothMemo) {
      //console.log("USING SMOOTH MEMO");

      vsmooth = (v: Vertex, fac: number = 0.5): void => {
        smemo!.fac = fac
        const co = smemo!.smoothco(v)

        if (isNaN(co.dot(co))) {
          debugger
          return
        }

        v.co.interp(co, fac)
      }
    }

    const _rtmp3 = new Vector3()

    const _dir2 = new Vector3()
    const skipflag = 0 //haveQuadEdges ? MeshFlags.QUAD_EDGE : 0;
    const _rtmp4 = new Vector3()

    /*
      on factor;

      f1 := x*x1 + y*y1 + z*z1 + w*w1;
      f2 := x*x2 + y*y2 + z*z2 + w*w2;
      f3 := x*x3 + y*y3 + z*z3 + w*w3;
      f4 := x**2+y**2+z**2+w**2 - 1.0;

      ff := solve({f1, f2, f3, f4}, {x, y, z, w});
      part(ff, 1, 1);
      part(ff, 1, 2);
      part(ff, 1, 3);
      part(ff, 1, 4);

      f1 := w1*a + w2*b + w3*c + w4*d;
     */

    const CD_DYNTOPO = doTopo && cd_color >= 0

    function makeDummyCData(): any {
      const cdata = {
        customData: [] as CustomDataElem[],
        reset() {
          for (const cd of this.customData) {
            cd.mulScalar(0.0)
          }

          return this
        },

        add(b: any) {
          for (let i = 0; i < this.customData.length; i++) {
            this.customData[i].add(b.customData[i])
          }

          return this
        },

        sub(b: any) {
          for (let i = 0; i < this.customData.length; i++) {
            this.customData[i].sub(b.customData[i])
          }

          return this
        },

        interpSimple(b: any, fac: number) {
          for (let i = 0; i < this.customData.length; i++) {
            const cd1 = this.customData[i]
            const cd2 = b.customData[i]

            cd1.mulScalar(1.0 - fac)
            cd1.addFac(cd2, fac)
          }

          return this
        },

        interp(srcs: {customData: CustomDataElem[]}[], ws: number[], tmp?: CustomDataElem[]) {
          if (!tmp) {
            tmp = getArrayTemp(srcs.length)
          }

          for (let i = 0; i < this.customData.length; i++) {
            const cd = this.customData[i]

            for (let j = 0; j < srcs.length; j++) {
              tmp[j] = srcs[j].customData[i]
            }

            cd.interp(cd, tmp, ws)
          }

          return this
        },

        load(b: any) {
          for (let i = 0; i < this.customData.length; i++) {
            b.customData[i].copyTo(this.customData[i])
          }

          return this
        },

        addFac(b: any, fac: number) {
          for (let i = 0; i < this.customData.length; i++) {
            this.customData[i].addFac(b.customData[i], fac)
          }

          return this
        },

        copyTo(b: any) {
          for (let i = 0; i < this.customData.length; i++) {
            this.customData[i].copyTo(b.customData[i])
          }
        },

        mulScalar(fac: number) {
          for (let i = 0; i < this.customData.length; i++) {
            this.customData[i].mulScalar(fac)
          }

          return this
        },
      }

      const clayout = haveGrids ? mesh.loops.customData : mesh.verts.customData

      for (const layer of clayout.flatlist) {
        const cls = CustomDataElem.getTypeClass(layer.typeName)!
        cdata.customData.push(new cls())
      }

      return cdata
    }

    const cdata1 = makeDummyCData()
    const cdata2 = makeDummyCData()
    const cdata3 = makeDummyCData()

    const cornerflag = getCornerFlag()

    let rake = (v: IBVHVertex, fac: number = 0.5, sdis: number = 1.0): void => {
      const mv = v.customData[cd_dyn_vert] as MDynVert

      if (mv && mv.flag & cornerflag) {
        return
      }

      const smoothboundflag = getSmoothBoundFlag()
      const boundflag = mv ? mv.flag & BVHVertFlags.BOUNDARY_ALL : 0

      if (v.valence === 4) {
        //return; //done do 4-valence verts
        fac *= 0.15
      }

      if (!ENABLE_RAKE) {
        return
      }

      //XXX
      if (doCurvRake && rakeCurvePosXOnly && v.co[0] < 0.0) {
        return
      }

      const val = v.valence
      if (fac === 0.0 || val === 0.0) {
        return
      }

      const co = _rtmp.zero()

      const d1 = _rdir
      const d2 = _rtmp2
      //let d3 = _rtmp3;

      d1.load(ps.dp)
      const d = d1.dot(v.no)
      d1.addFac(v.no, -d).normalize()

      if (Math.abs(ps.angle) > Math.PI) {
        //d1.negate();
      }

      if (doCurvRake && (!rakeCurvePosXOnly || v.co[0] >= 0.0)) {
        const cv = v.customData[cd_curv] as CurvVert
        cv.check(v, cd_cotan, undefined, cd_fset)

        d1.interp(cv.tan, rakeCurveFac).normalize()
      }

      const pad = 0.02
      let tot = 0.0

      const dorake = (v2: IBVHVertex, e?: Edge): void => {
        const mv2 = v2.customData[cd_dyn_vert] as MDynVert

        if (boundflag && (mv2.flag & BVHVertFlags.BOUNDARY_ALL) !== boundflag) {
          return
        }

        if (e && e.flag & skipflag) {
          return
        }

        d2.load(v2.co).sub(v.co)

        const nfac = -d2.dot(v.no) * 0.99

        d2.addFac(v.no, nfac)
        d2.normalize()

        let w

        let dot = d1.dot(d2)

        dot = Math.acos(dot * 0.999999) / Math.PI
        dot = Math.tent(dot * 2.0 - 0.5)

        w = dot ** 2

        w = w * (1.0 - pad) + pad

        co.addFac(v2.co, w)
        co.addFac(v.no, nfac * w)
        tot += w
      }

      if (v instanceof Vertex) {
        for (const e of v.edges) {
          const v2 = e.otherVertex(v)
          dorake(v2, e)
        }
      } else if (v instanceof GridBase) {
        for (const v2 of v.neighbors) {
          dorake(v2)
        }
      }

      if (tot === 0.0) {
        return
      }

      co.mulScalar(1.0 / tot)
      v.co.interp(co, fac)

      if (haveGrids) {
        gridVertStitch(v)
      }
    }

    //disabled for tet meshes
    const oldrake = (v: any, fac: number = 0.5, sdis: number = 1.0): void => {
      if (v.valence === 4) {
        //return; //done do 4-valence verts
        fac *= 0.15
      }

      if (!ENABLE_RAKE) {
        return
      }

      //XXX
      if (doCurvRake && rakeCurvePosXOnly && v[0] < 0.0) {
        return
      }

      //return rake2(v, fac);

      const val = v.valence
      let cdvs: Vertex[] | undefined
      let cdws: number[] | undefined

      if (fac === 0.0 || val === 0.0) {
        return
      }

      if (CD_DYNTOPO) {
        cdvs = getArrayTemp<Vertex>(val + 1)
        cdws = getArrayTemp<number>(val + 1)

        cdvs[0] = v
        cdws[0] = 1.0 - fac
        let vi = 1

        for (const v2 of v.neighbors) {
          cdvs[vi] = v2
          cdws[vi] = fac / val
          vi++
        }

        cdata1.interp(cdvs, cdws)
      }

      //attempt to tweak rake falloff
      /*
      fac *= 1.0 - (1.0 - sdis)*(1.0 - sdis);

      //approximate square root with newton-raphson
      let fac0 = fac;
      fac = (fac0/fac + fac)*0.5;
      //*/

      //fac = 1.0 - (1.0 - fac)*(1.0 - fac);

      const co = _rtmp.zero()
      let tot = 0.0

      const d1 = _rdir
      const d2 = _rtmp2
      //let d3 = _rtmp3;

      d1.load(ps.dp)
      const d = d1.dot(v.no)
      d1.addFac(v.no, -d).normalize()

      if (Math.abs(ps.angle) > Math.PI) {
        d1.negate()
      }

      if (doCurvRake && (!rakeCurvePosXOnly || v[0] >= 0.0)) {
        const cv = v.customData[cd_curv]
        cv.check(v, cd_cotan, undefined, cd_fset)

        d1.interp(cv.tan, rakeCurveFac).normalize()
      }

      const pad = 0.025 //5*(1.35 - fac);

      if (0 && val < 5) {
        const flag = MeshFlags.TEMP1

        for (const e of v.edges) {
          for (const l of e.loops) {
            for (const l2 of l.f.loops) {
              l2.e.flag &= ~flag
              l2.v.flag &= ~flag
            }
          }
        }

        for (const e of v.edges) {
          e.flag |= flag
        }

        for (const e of v.edges) {
          for (const l0 of e.loops) {
            for (const l of l0.f.loops) {
              if (l.v === v || l.e.flag & skipflag || l.v.flag & flag) {
                continue
              }

              l.v.flag |= flag

              const v2 = l.v
              d2.load(v2).sub(v)

              const nfac = -d2.dot(v.no)
              d2.addFac(v.no, nfac)
              const len = d2.vectorLength()

              const d3 = _rtmp4.load(d2)
              /*
              on factor;

              operator tent;

              forall s let df(tent(s), s) = -2;

              f1 := x1*x2 + y1*y2 + z1*z2;
              f1 := tent(f1);
              f2 := x1*x1 + y1*y1 + z1*z2 - 1.0;
              f3 := f1**2 + f2**2;

              dx1 := df(f3, x1);
              dy1 := df(f3, y1);
              dz1 := df(f3, z1);

              on fort;
              dx1;
              dy1;
              dz1;
              off fort;

              */

              if (len > 0.00001) {
                d2.mulScalar(1.0 / len)
              }

              if (l.e.flag & flag) {
                const x1 = d2[0]
                const y1 = d2[1]
                const z1 = d2[2]
                const x2 = d1[0]
                const y2 = d1[1]
                const z2 = d1[2]

                let dx1 = 2.0 * (2.0 * (z1 * z2 - 1.0 + y1 ** 2 + x1 ** 2) * x1 + (y1 * y2 + z1 * z2 + x1 * x2) * x2)
                let dy1 = 2.0 * (2.0 * (z1 * z2 - 1.0 + y1 ** 2 + x1 ** 2) * y1 + (y1 * y2 + z1 * z2 + x1 * x2) * y2)
                let dz1 = 2.0 * (x1 ** 2 + x1 * x2 + y1 ** 2 + y1 * y2 + 2.0 * z1 * z2 - 1.0) * z2

                const pi = Math.PI
                const sin = Math.sin
                const cos = Math.cos //, tent = Math.tent;

                function tent(f: number): number {
                  const f2 = Math.fract(f)

                  return 1.0 - Math.tent(f)
                }

                dx1 =
                  4.0 * (z1 * z2 - 1.0 + y1 ** 2 + x1 ** 2) * x1 -
                  (cos(2.0 * (z1 * z2 - 1.0 + y1 * y2 + x1 * x2) * pi) + 1.0) *
                    sin(2.0 * (z1 * z2 - 1.0 + y1 * y2 + x1 * x2) * pi) *
                    pi *
                    x2
                dy1 =
                  4.0 * (z1 * z2 - 1.0 + y1 ** 2 + x1 ** 2) * y1 -
                  (cos(2.0 * (z1 * z2 - 1.0 + y1 * y2 + x1 * x2) * pi) + 1.0) *
                    sin(2.0 * (z1 * z2 - 1.0 + y1 * y2 + x1 * x2) * pi) *
                    pi *
                    y2
                dz1 =
                  (2.0 * (z1 * z2 - 1.0 + y1 ** 2 + x1 ** 2) -
                    (cos(2.0 * (z1 * z2 - 1.0 + y1 * y2 + x1 * x2) * pi) + 1.0) *
                      sin(2.0 * (z1 * z2 - 1.0 + y1 * y2 + x1 * x2) * pi) *
                      pi) *
                  z2

                dx1 = 4.0 * ((z1 * z2 - 1.0 + y1 ** 2 + x1 ** 2) * x1 - tent(y1 * y2 + z1 * z2 + x1 * x2) * x2)
                dy1 = 4.0 * ((z1 * z2 - 1.0 + y1 ** 2 + x1 ** 2) * y1 - tent(y1 * y2 + z1 * z2 + x1 * x2) * y2)
                dz1 = 2.0 * (z1 * z2 - 1.0 + y1 ** 2 + x1 ** 2 - 2.0 * tent(y1 * y2 + z1 * z2 + x1 * x2)) * z2

                const nfac2 = nfac

                /*if (len > 0.00001) {
                  nfac2 /= len;
                }

                dx1 += v.no[0]*-nfac2;
                dy1 += v.no[1]*-nfac2;
                dz1 += v.no[2]*-nfac2;
                //*/

                let glen = Math.sqrt(dx1 ** 2 + dy1 ** 2 + dz1 ** 2)
                if (glen > 0.00001) {
                  glen = 1.0 / glen
                  glen *= -len * 0.05

                  dx1 *= glen
                  dy1 *= glen
                  dz1 *= glen
                }

                //v2.sub(v);
                //let len2 = v2.vectorLength();
                const len2 = v2.vectorDistance(v)

                v2[0] += dx1
                v2[1] += dy1
                v2[2] += dz1

                v2.sub(v).normalize().mulScalar(len2).add(v)

                //util.console.log(dx1, dy1, dz1);
              }

              w = d1.dot(d2)
              w = Math.acos(w * 0.99999) / Math.PI
              w = 1.0 - Math.tent(w)
              //w = Math.abs(w);

              //if (val > 4) {
              if (1 || !(l.e.flag & flag)) {
                w = Math.tent(w - 0.5)
              } else {
                //w = 1.0 - w;
              }
              //}

              w *= w
              w = w * (1.0 - pad) + pad
              co.addFac(v2, w)
              co.addFac(v.no, nfac * w)
              tot += w
            }
          }
        }

        return
      } else {
        let vi = 1

        for (const e of v.edges) {
          const v2 = e.otherVertex(v)

          if (e.flag & skipflag) {
            continue
          }

          d2.load(v2).sub(v)

          const nfac = -d2.dot(v.no) * 0.95

          d2.addFac(v.no, nfac)
          d2.normalize()

          let w

          if (0) {
            let w2 = d1.dot(d2)
            w = d2.cross(d1).vectorLength()
            //let w = d1.dot(d2);
            //w = 1.0 - Math.abs(w-0.5)*2.0;

            w = 1.0 - w
            w *= w * w * w

            w2 = 1.0 - Math.abs(w2)
            w2 *= w2 * w2 * w2

            w = w * 0.5 + w2 * 0.5
          } else {
            w = d1.dot(d2)
            if (0) {
              w = 1.0 - Math.tent(Math.tent(w))
              w = w * w * (3.0 - 2.0 * w)
            } else if (val !== 4) {
              w = Math.acos(w * 0.99999) / Math.PI
              w = 1.0 - Math.tent((w - 0.5) * 2.0)
              w = w * w * (3.0 - 2.0 * w)
            } else {
              w = Math.acos(w * 0.99999) / Math.PI
              w = Math.tent(w - 0.5)
              w = w * w * (3.0 - 2.0 * w)
            }

            //if (val > 4) {
            //w += 0.5;
            //w = Math.tent(w - 0.5);
            //}
          }

          w = w * (1.0 - pad) + pad

          if (CD_DYNTOPO) {
            cdws![vi++] = w
          }

          co.addFac(v2, w)
          co.addFac(v.no, nfac * w)
          tot += w
        }
      }

      if (tot === 0.0) {
        return
      }

      if (CD_DYNTOPO) {
        for (let i = 1; i < cdws!.length; i++) {
          cdws![i] *= fac / tot
        }

        cdata2.interp(cdvs, cdws)
        cdata2.interpSimple(v, 0.85)

        //cdata2.sub(cdata1);
        //cdata2.mulScalar(-1.0);
        //cdata2.add(v);

        cdata2.copyTo(v)
      }

      co.mulScalar(1.0 / tot)
      v.co.interp(co, fac)

      if (haveGrids) {
        gridVertStitch(v)
      }
    }

    if (mesh instanceof TetMesh) {
      rake = (): void => {}
    }

    const dopinch = (v: IBVHVertex, f: number): void => {
      f = Math.pow(f, pinchpower) * 2.0

      const f3 = f * Math.abs(strength)

      const height = radius * 2.0

      const oco = (v.customData.get(cd_orig!) as OrigCoType).value

      conetmp.load(ps.p).addFac(nvec, planeoff * radius * 0.25 + 0.5)
      planetmp.load(conetmp).addFac(nvec, height)

      const r = closest_point_on_line(v.co, conetmp, planetmp, false)

      const origdis = v.co.vectorDistance(oco)
      const fac = 1.0 - Math.min((2.0 * origdis) / radius, 1.0)

      planetmp
        .load(v.co)
        .sub(r ? r[0] : v.co)
        .mulScalar(0.5)
        .add(r ? r[0] : v.co)
      v.co.interp(planetmp, pinchmul * f3 * pinch * fac)

      if (haveGrids) {
        gridVertStitch(v)
      }
    }

    const _ctmp = new Vector3()
    const abs = Math.abs

    const colorboundary = (v: IBVHVertex, fac: number): void => {
      const co = _ctmp.zero()
      const c1 = (v.customData[cd_color] as ColorLayerElem).color

      co.add(v.co)
      let tot = 1.0

      for (const v2 of v.neighbors) {
        const c2 = (v2.customData[cd_color] as ColorLayerElem).color

        const dr = abs(c1[0] - c2[0])
        const dg = abs(c1[1] - c2[1])
        const db = abs(c1[2] - c2[2])

        const w = (dr * 1.25 + dg * 1.5 + db) * 0.25
        //w *= w;

        co.addFac(v2.co, w)
        tot += w
      }

      if (tot === 0.0) {
        return
      }

      co.mulScalar(1.0 / tot)

      v.co.interp(co, fac)
    }

    const cd_node = bvh.cd_node
    const ws = new Array<number>(vs.size)

    if (isPaintMode && !have_color) {
      cd_color = mesh.verts.addCustomDataLayer('color').index

      if (bvh.cd_grid.i >= 0) {
        GridBase.syncVertexLayers(mesh)
        cd_color = mesh.loops.customData.getLayerIndex('color')
      }

      have_color = true
    }

    let color
    const concaveFilter = ps.concaveFilter
    const invertConcave = brush.flag & BrushFlags.INVERT_CONCAVE_FILTER

    if (have_color) {
      color = new Vector4(this.inputs.brush.getValue().color)
    }

    if (mode === COLOR_BOUNDARY && !have_color) {
      return
    }

    let wi = 0

    const planetmp = new Vector3()
    const conetmp = new Vector3()
    const planetmp2 = new Vector3()
    const planetmp3 = new Vector3()

    if (isPaintMode && !have_color) {
      return
    }

    const astrength = Math.abs(strength)
    const bLinks = new Set()

    const gdists = this.grabDists
    let idis = 0

    const WF = 0
    const WDIS = 1
    const WF2 = 2
    const WTOT = 3

    wi = 0
    let vi = 0

    //propegate undo since smooth propegates
    //velocities to vertex ring neighborhoods now
    if (vsw !== 0.0 || ps.rake !== 0.0 || mode === DIRECTIONAL_FAIR) {
      const flag = MeshFlags.TEMP1

      for (const v of vs) {
        v.flag &= ~flag

        for (const v2 of v.neighbors) {
          v2.flag &= ~flag
        }
        //for (let v2 of v.neighbors) {
        //  v2.flag &= ~flag;
        //}
      }

      let log
      if (doTopo) {
        log = this._undo.log
        log.checkStart(mesh)
      }

      for (const v of vs) {
        if (!(v.flag & flag)) {
          const node = cd_node.get(v).node
          if (node) {
            node.setUpdateFlag(BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_DRAW)
          }

          doUndo(v)

          if (doTopo && log) {
            log.ensure(v)
          }

          v.flag |= flag
        }

        for (const v2 of v.neighbors) {
          //for (let v2 of v.neighbors) {
          if (!(v2.flag & flag)) {
            v2.flag |= flag

            const node = cd_node.get(v2).node

            if (node) {
              node.setUpdateFlag(BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_DRAW)
            }

            if (doTopo && log && v2) {
              log.ensure(v2)
            }

            doUndo(v2)
          }
        }
      }
    } else {
      for (const v of vs) {
        doUndo(v)
      }
    }

    if (1) {
      //this.calcNormalVariance(mesh, bvh, ps.p, radius);
    }

    const texco = new Vector3()
    const irendermat = new Matrix4(ps.rendermat)
    const viewportSize = this.inputs.viewportSize.getValue()
    const aspect = viewportSize[0] / viewportSize[1]

    irendermat.invert()
    const texco2 = new Vector3()
    const texdsp = new Vector3()

    const console1 = util.console.context('console1')
    const console2 = util.console.context('console2')

    const needTexDv = brush.texUser.pinch !== 0.0
    const texDv = needTexDv ? new Vector3() : undefined

    const rendermat2 = new Matrix4(ps.rendermat)
    const tmat = new Matrix4()

    const ba = new Vector2()
    const bb = new Vector2()
    const bc = new Vector2()
    const bp = new Vector2()
    const distmp = new Vector3()

    const okflag = MeshFlags.NOAPI_TEMP2

    for (const v of vs) {
      let pco = p3
      if (mode === SHARP) {
        // || (mode === SMOOTH && (brush.flag & BrushFlags.MULTIGRID_SMOOTH))) {
        //vco = v.customData[cd_orig].value;
        pco = ps.origp || ps.p
      }

      let dis
      let f

      if (mode === GRAB) {
        dis = gdists![idis++]

        if (dis > radius) {
          v.flag &= ~okflag
        } else {
          v.flag |= okflag
        }

        f = Math.max(1.0 - dis / radius, 0.0)
        f = falloff.evaluate(f)
      } else if (useLinePlane) {
        distmp.load(v.co).sub(pco)

        dis = Math.abs(distmp.dot(linePlane))
        const dis2 = Math.abs(distmp.dot(linePlane2))

        if (dis > radius) {
          v.flag &= ~okflag
        } else {
          v.flag |= okflag
        }

        //

        if (1) {
          f = Math.max(1.0 - dis / radius, 0.0)
          f = falloff.evaluate(f)

          let f2 = Math.max(1.0 - dis2 / radius, 0.0)
          f2 = falloff2.evaluate(f2)

          const dis3 = Math.abs(distmp.dot(ps.viewPlane))
          let f3 = Math.max(1.0 - dis3 / radius, 0.0)
          f3 = falloff2.evaluate(f3)

          //f = Math.min(f, f2);
          //f = (f + f2)*0.5;
          //f = Math.sqrt(f*f2);
          f = Math.pow(f * f2 * f3, 1.0 / 3.0)

          //f *= Math.abs(v.no.dot(ps.viewPlane));
        } else {
          const curve = falloff

          if (dis2 > dis) {
            //  dis = dis2;
            //  curve = falloff2;
          }
          dis = Math.abs(dis + dis2) * 0.5 //Math.sqrt(dis*dis + dis2*dis2) / Math.sqrt(2.0);

          f = Math.max(1.0 - dis / radius, 0.0)
          f = curve.evaluate(f)
        }
      } else {
        dis = v.co.vectorDistance(pco)

        if (dis > radius) {
          v.flag &= ~okflag
        } else {
          v.flag |= okflag
        }

        f = Math.max(1.0 - dis / radius, 0.0)
        f = falloff.evaluate(f)
      }

      if (!(v.flag & okflag)) {
        const wdis = dis
        let wf = Math.max(1.0 - wdis / bvhRadius, 0.0)
        wf = falloff.evaluate(wf)

        ws[wi++] = wf
        ws[wi++] = wdis
        ws[wi++] = wf

        vi++
        continue
      }

      const w1 = f
      let f2 = f

      let texf = 1.0

      if (haveTex && cd_orig !== undefined) {
        if (texUser.flag & TexUserFlags.ORIGINAL_CO) {
          texco.load((v.customData.get(cd_orig) as Vector3LayerElem).value)
        } else {
          texco.load(v.co)
        }

        let scale = 1.0
        let texco3

        if (texUser.mode === TexUserModes.VIEW_REPEAT) {
          texco3 = texco2.load(texco)
          texco3.multVecMatrix(ps.rendermat)

          texco3[0] = (texco3[0] * 0.5 + 0.5) * viewportSize[0]
          texco3[1] = (1.0 - (texco3[1] * 0.5 + 0.5)) * viewportSize[1]
          texco3[2] = ps.sp[2]

          if (texUser.flag & TexUserFlags.CONSTANT_SIZE) {
            scale = viewportSize[1] / 100.0
          } else {
            scale = viewportSize[1] / (brush.radius * 2.0)
          }
        }

        let th = ps.angle

        if (texUser.flag & TexUserFlags.FANCY_RAKE && lastps) {
          if (1 || !texco3) {
            texco3 = texco2.load(texco)
            texco3.multVecMatrix(ps.rendermat)
            texco3[0] = (texco3[0] * 0.5 + 0.5) * viewportSize[0]
            texco3[1] = (1.0 - (texco3[1] * 0.5 + 0.5)) * viewportSize[1]
          }

          //console1.log("texco", texco3);

          const n = texdsp.load(ps.dsp)
          n[2] = texco3[2] = 0.0
          n.normalize()

          texco3.sub(ps.sp)

          //let tt = n[0];
          //n[0] = n[1];
          //n[1] = -tt;

          const dx = ps.sp[0] - lastps.sp[0]
          const dy = ps.sp[1] - lastps.sp[1]

          let t = texco3.dot(n) / (0.5 * Math.sqrt(dx * dx + dy * dy))
          t /= brush.spacing

          t = t * 0.5 + 0.5
          //t *= 2.0;
          t = Math.min(Math.max(t, 0.0), 1.0)

          ba.load(lastps.sp)
          bb.load(lastps.dsp).add(ps.dsp).mulScalar(0.25).add(ba)
          bc.load(ps.sp)

          //let ret = closest_bez3_v2(texco3, ba, bb, bc);
          //util.console.log(ret, texco3, ba, bb, bc);
          //if (Math.random() > 0.995) {
          //texf = ret.t;
          //console.log(ret);
          //}

          if (0) {
            //ret) {
            //let dv = dbez3_v2(ba, bb, bc, ret.t)
            //th = Math.atan2(dv[1], dv[0])
            //texf = (0.015 * Math.sqrt(ret.distSqr)) / radius
            //texf = Math.min(Math.max(texf, 0.0), 1.0)
          } else {
            //th = 0;
          }

          //console2.log(t, dx.toFixed(3), dy.toFixed(3), lastps.sp, ps.sp, viewportSize);

          if (isNaN(t)) {
            //throw new Error("NaN");
            t = 0.5
          }

          texf = t

          let th1 = ps.angle
          const th2 = ps.futureAngle

          if (th1 > th2 + Math.PI) {
            th1 -= Math.PI
          } else if (th1 < th2 - Math.PI) {
            th1 += Math.PI
          }

          th = th1 + (th2 - th1) * t

          //util.console.log(lastps.angle, ps.angle, t, th, ps.angle);

          if (isNaN(th)) {
            throw new Error('NaN')
          }
        }

        if (texUser.flag & TexUserFlags.CURVED) {
          const p1 = ps.curve.closestPoint(v)
          let strokeS

          strokeS = ps.strokeS + brush.spacing * p1.t

          if (lastps) {
            const p2 = lastps.curve.closestPoint(v.co)
            if (p2.dist < p1.dist) {
              //p1 = p2;
              //strokeS = lastps.strokeS + brush.spacing*p2.t;
            }
          }

          if (lastps) {
            //texco[0] = lastps.strokeS + (ps.strokeS - lastps.strokeS)*p1.t;
          } else {
            //texco[0] = ps.strokeS;
          }

          if (Math.abs(p1.t) < 0.001 || Math.abs(p1.t) > 0.999) {
            wi += 3
            vi++
            continue
          }

          texco[1] = (strokeS / radius) * 0.1
          //texco[0] = texco[1] = p1.t*p1.dist/radius;

          texco[0] = p1.dist / radius
          texco[2] = 0.0

          if (texco[1] > 0.5) {
            //continue;
          }
        }

        texco2.load(ps.sp)
        texco2[0] = (texco2[0] / viewportSize[0]) * 2.0 - 1.0
        texco2[1] = (1.0 - texco2[1] / viewportSize[1]) * 2.0 - 1.0

        th = Math.PI * 0.5 - th
        texf = texUser.sample(texco, scale * 2.0, th, ps.rendermat, texco2, aspect, texDv)
        //texf = Math.min(Math.max(texco.vectorLength()/radius, 0.0), 1.0);

        if (isNaN(texf) || !isFinite(texf)) {
          debugger
          continue
        }

        if (texDv) {
          texDv.normalize()
          const d = texDv.dot(v.no)
          texDv.addFac(v.no, -d).normalize()
          texDv.mulScalar(radius * 0.25)

          v.co.addFac(texDv, 0.1 * texUser.pinch)
        }
        if (isplane) {
          let sign = ps.invert ? -1 : 1
          if (planeoff) {
            sign = Math.sign(planeoff)
          }

          const planeoff2 = planeoff + (texf - 0.5) * sign
          planep.load(ps.p).addFac(nvec, planeoff2 * radius * 0.5)
        } else {
          f *= texf
        }
      }

      if (mode !== MASK_PAINT && cd_mask >= 0) {
        f *= (v.customData[cd_mask] as MaskElem).value
      }

      if (f === undefined || isNaN(f) || !isFinite(f)) {
        debugger
        continue
      }

      /*if (mode === SHARP) {
        let d = 1.0 - Math.max(v.no.dot(nvec), 0.0);

        //d = 1.0 - d;
        //d *= d*d*d*d;
        d *= d;
        //d = 1.0 - d;

        f2 *= f2;

        //v.addFac(v.no, -vlen*d*f2*0.5*strength);
        v.addFac(vec, f);//
      } else */

      if (mode === DIRECTIONAL_FAIR) {
        const dir = wtmp1

        dir.load(ps.dvec)
        const d = dir.dot(v.no)

        dir.addFac(v.no, -d)
        dir.normalize()

        dirCurveSmooth(v, dir, f * strength, cd_curv)
      } else if (0 && mode === PINCH) {
        const d2 = wtmp0.load(ps.dp)

        let f3 = f

        if (doCurvRake) {
          // && (!rakeCurvePosXOnly || v[0] >= 0.0)) {
          const cv = v.customData[cd_curv] as CurvVert
          cv.check(v, cd_cotan, undefined, cd_fset)

          const tan = wtmp1.load(cv.tan)
          let neg = false

          if (tan.dot(d2) < 0) {
            //tan.negate();
            neg = true
          }

          d2.load(tan)

          if (Math.abs(cv.k1) > 0.0001) {
            f3 /= 1.0 + cv.k1 //Math.abs(cv.k1);
          }

          //d2.interp(tan, rakeCurveFac).normalize();
          if (neg) {
            //d2.negate();
          }
        }
        let d

        d2.cross(v.no).normalize()
        const sign = ps.invert ? -1 : 1

        f3 *= astrength * sign * radius * 0.1

        v.co.addFac(v.no, -f3)
        v.co.addFac(d2, f3)

        //v.addFac(d2, f3);

        /*

        //d = d2.dot(v.no);
        //d2.addFac(v.no, -d).normalize();

        let p = wtmp2.load(ps.p);
        let co = wtmp3.load(v).sub(p);

        d = co.dot(d2);

        let sign = ps.invert ? -1 : 1;
        v.addFac(co, -d*f*astrength*sign);

         */
      } else if (mode === WING_SCRAPE) {
        f2 = f * strength

        const t = wtmp1.load(v.co).sub(ps.p)
        let d = t.dot(wno)
        t.addFac(wno, -d).normalize()

        const wtan2 = wtan

        let nvec

        t.cross(wtan2)

        t.normalize()
        const th = t.dot(wno)
        const doboth = false

        //let d2 = wtmp2.load(v).sub(ps.p).dot(t);

        f2 *= 0.3

        if (th < 0.0 || doboth) {
          nvec = wvec1

          const co = planetmp.load(v.co)
          co.sub(wplanep1)

          d = co.dot(nvec)
          v.co.addFac(nvec, -d * f2)
        }

        if (th >= 0.0 || doboth) {
          nvec = wvec2

          const co = planetmp.load(v.co)
          co.sub(wplanep2)

          d = co.dot(nvec)
          v.co.addFac(nvec, -d * f2)
        }
      } else if (mode === MASK_PAINT) {
        const f2 = ps.invert ? astrength * 0.5 : -astrength * 0.5

        const mask = v.customData[cd_mask] as MaskElem
        let val = mask.value

        val += f2
        val = Math.min(Math.max(val, 0.0), 1.0)

        val = mask.value + (val - mask.value) * f
        mask.value = val

        v.flag |= MeshFlags.UPDATE

        const node = cd_node.get(v).node
        if (node) {
          node.setUpdateFlag(BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_MASK)
        }
      } else if (mode === SHARP) {
        v.co.addFac(vec, f)
      } else if (mode === SMOOTH && isplane) {
        planetmp.load(v.co)
        vsmooth(v, f * strength)
        const dist = planetmp.vectorDistance(v.co)

        f2 = w1 * w1 * (3.0 - 2.0 * w1) * w1
        f2 *= strength * 0.25

        const co = planetmp.load(v.co)
        co.sub(planep)

        const n = planetmp2.load(nvec)

        const nco = planetmp3.load(co)
        nco.normalize()

        if (n.dot(co) < -0.5) {
          f2 = -f2
        }

        let d = co.dot(n)

        const s1 = Math.sign(d)
        d = Math.max(Math.abs(d) - dist, 0) * s1

        v.co.addFac(n, -d * f2)
      } else if (isplane) {
        f2 = f * strength

        const co = planetmp.load(v.co)
        co.sub(planep)
        co.addFac(nvec, -f * radius * 0.25 * (ps.invert ? -1 : 1))

        const d = co.dot(nvec)

        v.co.addFac(nvec2, -d * f2 * 0.2)
      } else if (mode === DRAW) {
        v.co.addFac(vec, f) //
      } else if (have_color && mode === PAINT) {
        if (concaveFilter !== 0.0) {
          let cf = calcConcave(v)

          if (invertConcave) {
            cf = 1.0 - cf
          }

          cf = Math.pow(cf * 1.25, (concaveFilter + 1.0) * 4.0)
          cf = cf < 0.0 ? 0.0 : cf
          cf = cf > 1.0 ? 1.0 : cf

          f *= cf
        }
        const c = v.customData[cd_color] as ColorLayerElem
        if (color) {
          c.color.interp(color, f * strength)
        }

        if (0) {
          const u = Math.fract(texco[0])
          const v = Math.fract(texco[1])
          c.color[0] = u
          c.color[1] = v
          c.color[2] = 0.5
        }
      } else if (mode === INFLATE) {
        v.co.addFac(v.no, f * strength * 0.1)
      } else if (mode === SLIDE_RELAX) {
        const co = _tmp4.load(v.co)

        co.interp(v.customData.get(cd_orig!).value, 0.1 * f)
        co.addFac(vec, f * strength)

        _tmp.load(co).multVecMatrix(rmat)
        co.interp(_tmp, f * strength)

        co.sub(v.co)
        const d = co.dot(v.no)
        co.addFac(v.no, -d)

        v.co.addFac(co, 0.25)
      } else if (mode === SNAKE) {
        v.co.interp(v.customData.get(cd_orig!).value, 0.1 * f)
        v.co.addFac(vec, f * strength)

        _tmp.load(v.co).multVecMatrix(rmat)
        v.co.interp(_tmp, f * strength)
      } else if (mode === GRAB) {
        //v.load(v.customData[cd_orig].value);

        const i = vi * 3
        const gi = gidxs[vi]

        const gx = goffs[i]
        const gy = goffs[i + 1]
        const gz = goffs[i + 2]

        const disx = (dis + gx) * Math.abs(signs[i])
        const disy = (dis + gy) * Math.abs(signs[i + 1])
        const disz = (dis + gz) * Math.abs(signs[i + 2])

        //disx = disy = disz = dis;

        let fx = Math.max(1.0 - disx / radius, 0.0)
        let fy = Math.max(1.0 - disy / radius, 0.0)
        let fz = Math.max(1.0 - disz / radius, 0.0)

        fx = falloff.evaluate(fx) * texf
        fy = falloff.evaluate(fy) * texf
        fz = falloff.evaluate(fz) * texf

        if (0) {
          //purely delta mode
          v.co[0] += vec[0] * fx * Math.sign(signs[i])
          v.co[1] += vec[1] * fy * Math.sign(signs[i + 1])
          v.co[2] += vec[2] * fz * Math.sign(signs[i + 2])
        } else {
          //accumulated delta mode
          v.co.load(v.customData.get(cd_orig!).value)

          //_tmp.zero();
          _tmp.load(vec).multVecMatrix(rmat)
          //_tmp.sub(v);
          //_tmp.add(vec);

          const vec2 = _tmp

          //fx = fy = fz = 1.0;

          //v[0] += vec2[0]*fx*Math.sign(signs[i]);
          //v[1] += vec2[1]*fy*Math.sign(signs[i+1]);
          //v[2] += vec2[2]*fz*Math.sign(signs[i+2]);

          //*
          gd![gi + GOFFX] += vec2[0]
          gd![gi + GOFFY] += vec2[1]
          gd![gi + GOFFZ] += vec2[2]

          v.co[0] += gd![gi + GOFFX] * fx * Math.sign(signs[i])
          v.co[1] += gd![gi + GOFFY] * fy * Math.sign(signs[i + 1])
          v.co[2] += gd![gi + GOFFZ] * fz * Math.sign(signs[i + 2])
          //*/
        }

        f = 1.0 - f //make sure smooth uses inverse falloff
        f = Math.sqrt(f)
        //f = 1.0;

        //v.addFac(vec, f);
      } else if (mode === COLOR_BOUNDARY) {
        colorboundary(v, f * strength)
      } else if (mode === FACE_SET_DRAW && v instanceof Vertex) {
        for (const f of v.faces) {
          ;(f.customData[cd_fset] as FloatElem).value = drawFaceSet

          for (const v2 of f.verts) {
            const mv = v2.customData[cd_dyn_vert] as MDynVert

            const node = cd_node.get(v2).node!
            node.setUpdateFlag(
              BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_MASK
            )

            mv.flag |= BVHVertFlags.NEED_BOUNDARY
          }
        }

        v.flag |= MeshFlags.UPDATE
      }

      if (haveGrids && v instanceof GridVertBase) {
        v.flag |= MeshFlags.UPDATE

        const l = v.loopEid !== undefined ? (mesh.eidMap.get(v.loopEid) as Loop) : undefined

        if (l) {
          const grid = l.customData[cd_grid] as GridBase
          grid.flagNormalsUpdate()
          grid.recalcFlag |= QRecalcFlags.NORMALS
          bvh.updateGridLoops.add(l)
        }

        const node = cd_node.get(v).node
        if (node) {
          node.setUpdateFlag(updateflag)
        }

        gridVertStitch(v)

        if (v.bLink && v.bLink.v1.eid >= 0) {
          bLinks.add(v)
        }
      }

      ws[wi++] = f
      ws[wi++] = dis
      ws[wi++] = w1

      v.flag |= MeshFlags.UPDATE
      vi++
    }

    //let es = new Set();
    wi = 0

    let smoothvs = vs

    if (mode === SNAKE) {
      smoothvs = new Set(vs)

      if (haveGrids) {
        /*
        for (let v of vs) {
          for (let v2 of v.neighbors) {
            smoothvs.add(v2);
          }
        }
        //*/
      } else {
        let vs2 = vs

        for (let i = 0; i < 4; i++) {
          const boundary = new Set<IBVHVertex>()

          for (const v of vs2) {
            for (const v2 of v.neighbors) {
              if (!smoothvs.has(v2)) {
                boundary.add(v2)
                doUndo(v2)
              }

              smoothvs.add(v2)
            }
          }

          vs2 = boundary
        }
      }
    }

    /*
    if (mode === GRAB) {
      let vs2 = bvh.closestVerts(ps.origp, radius*4);

      for (let v of vs2) {
        doUndo(v);

        vsmooth(v, vsw);
        let node = cd_node.get(v).node;
        if (node) {
          node.setUpdateFlag(BVHFlags.UPDATE_DRAW|BVHFlags.UPDATE_NORMALS);
        }
      }
    }//*/

    const origVs = [] as Vector3[]
    const origNs = [] as Vector3[]

    for (const v of vs) {
      origVs.push(new Vector3(v.co))
      origNs.push(new Vector3(v.no))
    }

    let reproject = false

    for (const v of vs) {
      const node = cd_node.get(v).node

      if (node) {
        node.setUpdateFlag(updateflag)
      }

      //for (let e of v.edges) {
      //  es.add(e);
      //}

      if (ws[wi] === undefined) {
        continue
      }

      if (!isPaintMode && rakefac > 0.0) {
        reproject = true
        rake(v, rakefac * ws[wi + WF], ws[wi + WF2])
      }

      if (vsw > 0) {
        if (isPaintMode) {
          ;(v.customData[cd_color] as ColorLayerElem).color.load(colorfilter(v, cd_color, vsw * ws[wi]))
        } else {
          if (vsw * ws[wi] > 0.0) {
            reproject = true
          }

          vsmooth(v, vsw * ws[wi])
        }
      }

      if (!isPaintMode && sharp !== 0.0) {
        reproject = true
        vsharp!(v, ws[wi] * sharp)
      }

      if (!isPaintMode && pinch !== 0.0) {
        reproject = true
        dopinch(v, ws[wi])
      }

      wi += 3

      if (v.flag & MeshFlags.MIRRORED && v.flag & MeshFlags.MIRROR_BOUNDARY) {
        if (v.flag & MeshFlags.MIRROREDX) {
          v.co[0] = 0.0
        }
        if (v.flag & MeshFlags.MIRROREDY) {
          v.co[1] = 0.0
        }
        if (v.flag & MeshFlags.MIRROREDZ) {
          v.co[2] = 0.0
        }
      }

      v.flag |= MeshFlags.UPDATE
    }

    if (haveGrids && vsw > 0.0) {
      let steps = ~~(vsw * 4.0)
      steps = Math.min(Math.max(steps, 2), 4)

      for (let i = 0; i < steps; i++) {
        for (const v of bLinks) {
          //doGridBoundary(v);
          gridVertStitch(v)
        }
      }
    }

    if (reproject && !haveGrids && this.inputs.reprojectCustomData.getValue()) {
      const vertexVs = vs as Set<Vertex>

      function swap3(a: any, b: any): void {
        for (let i = 0; i < 3; i++) {
          const t = a[i]
          a[i] = b[i]
          b[i] = t
        }
      }

      const ls = new Set()

      let i = 0
      let li = 0

      for (const v of vertexVs) {
        const node = cd_node.get(v).node!

        for (let l of v.loops) {
          if (l.v !== v) {
            l = l.next
          }

          if (!ls.has(l)) {
            l.index = li++
          }
          ls.add(l)
        }

        node.setUpdateFlag(BVHFlags.UPDATE_BOUNDS)

        //XXX
        //origVs[i].load(v);
        //origNs[i].load(v.no);

        swap3(v.co, origVs[i])
        swap3(v.no, origNs[i])

        i++
      }

      bvh.update()

      const cdblocks_loop = new Map<Loop, CDElemArray>()
      const cdblocks = [] as CDElemArray[]
      const dummy = new Vertex()

      const vstmp = new Array<Vertex>(3)
      const wstmp = [0, 0, 0]

      i = 0
      for (const v of vertexVs) {
        const origco = origVs[i]
        const origno = origNs[i]

        origco.addFac(origno, -0.00001)

        const r1 = bvh.castRay(origco, origno)
        origno.negate()
        const r2 = bvh.castRay(origco, origno)

        let r

        if (r1 && r2) {
          if (Math.abs(r1.dist) < Math.abs(r2.dist)) {
            r = r1
          } else {
            r = r2
          }
        } else if (r1) {
          r = r1
        } else if (r2) {
          r = r2
        }

        if (r === undefined) {
          // Ray missed the pre-stroke surface (border verts do this routinely).
          // Skip the vert — throwing here aborted the whole reproject pass and
          // left every vert swapped to its pre-stroke position.
          cdblocks.push(undefined as unknown as CDElemArray)
          i++
          continue
        }

        const tri = r.tri!
        vstmp[0] = tri.v1 as Vertex
        vstmp[1] = tri.v2 as Vertex
        vstmp[2] = tri.v3 as Vertex

        wstmp[0] = r.uv[0]
        wstmp[1] = r.uv[1]
        wstmp[2] = 1.0 - r.uv[0] - r.uv[1]

        dummy.customData = new CDElemArray()
        for (const cd of v.customData) {
          dummy.customData.push(cd.copy())
        }

        mesh.verts.customDataInterp(dummy, vstmp, wstmp)
        cdblocks.push(dummy.customData)

        for (let l of v.loops) {
          if (l.v !== v) {
            l = l.next
          }

          dummy.customData = new CDElemArray()
          for (const cd of l.customData) {
            dummy.customData.push(cd.copy())
          }

          const lstmp = vstmp as unknown as Loop[]
          lstmp[0] = r.tri!.l1!
          lstmp[1] = r.tri!.l2!
          lstmp[2] = r.tri!.l3!

          mesh.loops.customDataInterp(dummy as unknown as Loop, lstmp, wstmp)
          cdblocks_loop.set(l, dummy.customData)
        }
        i++
      }

      //console.log("CDBLOCKS_LOOP", cdblocks_loop);

      for (const l of cdblocks_loop.keys()) {
        const block = cdblocks_loop.get(l)!

        for (let i = 0; i < l.customData.length; i++) {
          block[i].copyTo(l.customData[i])
        }
      }

      i = 0
      for (const v of vertexVs) {
        if (cdblocks[i] !== undefined) {
          const block = cdblocks[i]

          for (let j = 0; j < v.customData.length; j++) {
            block[j].copyTo(v.customData[j])
          }
        }

        swap3(v.co, origVs[i])
        swap3(v.no, origNs[i])

        const node = cd_node.get(v).node
        node.setUpdateFlag(BVHFlags.UPDATE_COLORS | BVHFlags.UPDATE_BOUNDS | BVHFlags.UPDATE_DRAW)

        i++
      }
    }

    if (!this.smoother && vsw > 0.7) {
      const fac = 0.3
      const repeat = 1 //vsw > 0.95 ? 2 : 1;

      for (let i = 0; i < repeat; i++) {
        let wi = 0
        for (const v of vs) {
          vsmooth(v, fac * ws[wi])

          wi += WTOT
        }
      }
    }

    if (this.smoother && vsw > 0.0) {
      let update = false
      const smoother = this.smoother

      for (const v of vs) {
        update ||= smoother.ensureVert(v)
      }

      if (update) {
        smoother.update()
      }

      const wfunc = function (v: Vertex) {
        const w = smoothmap.get(v)

        if (w === undefined) {
          return 0.0
        }

        return w
      }

      const wfac = vsw

      const sverts = smoother.getSuperVerts(vs)
      smoother.smooth(sverts, wfunc, wfac, smoothProj)
    }

    if (useSmoothMemo) {
      //console.log("steps:", smemo.steps);
    }

    if (cd_disp >= 0) {
      const dctx = new DispContext()

      dctx.reset(mesh, cd_disp)

      dctx.settings.smoothGen++
      dctx.settings.initGen++

      const smemo = getSmoothMemo(mesh, new AttrRef(cd_disp))
      dctx.smemo = smemo

      for (const v of vs) {
        if (v.eid < 0) {
          continue
        }

        dctx.v = v as Vertex
        const dv = v.customData[cd_disp] as DispLayerVert

        dv.flushUpdateCo(dctx, true)
      }
    }

    const this2 = this
    const doDynTopo = function* (vs: Iterable<IBVHVertex>) {
      let repeat = brush.dynTopo.repeat
      if (mode === SNAKE) {
        repeat += 3
      }

      if (haveGrids && haveQuadTreeGrids) {
        for (let step = 0; step < repeat; step++) {
          let vs2 = bvh.closestVerts(ps.p, bvhRadius)

          if (!(vs2 instanceof Set)) {
            vs2 = new Set(vs2)
          }

          for (const v of vs) {
            for (const v2 of v.neighbors) {
              vs2.add(v2)
            }
          }

          this2.doQuadTopo(mesh, bvh, esize, vs2 as Set<GridVertBase<any>>, p3, radius, brush)
        }
      } else if (!haveGrids) {
        const es = new Set<Edge>()
        let vertexVs = vs as Set<Vertex>

        const log = this2._undo.log
        log.checkStart(mesh)

        for (let step = 0; step < repeat; step++) {
          if (1) {
            if (step > 0) {
              vertexVs = bvh.closestVerts(ps.p, bvhRadius) as Set<Vertex>
            }

            const emin = esize * 0.5 * (esize * 0.5)
            const emax = esize * 2.0 * (esize * 2.0)

            for (const v of vertexVs) {
              for (const e of v.edges) {
                es.add(e)

                const distsqr = e.v1.co.vectorDistanceSqr(e.v2.co)

                //include surrounding geometry if edge size is
                //within esize/2, esize*2

                if (0 && distsqr > emin && distsqr < emax) {
                  for (const l of e.loops) {
                    for (const l2 of l.f.loops) {
                      es.add(l2.e)
                    }
                  }

                  const v2 = e.otherVertex(v)
                  for (const e2 of v2.edges) {
                    es.add(e2)
                  }
                }

                /*
                let v2 = e.otherVertex(v);

                //*
                for (let e2 of v2.edges) {
                  //let v3 = e2.otherVertex(v2);
                  //log.ensure(v3);

                  es.add(e2);
                }//*/
              }
            }
          } else {
            const tris = bvh.closestTris(ps.p, bvhRadius)
            for (const tri of tris) {
              const v1 = tri.v1 as Vertex
              const v2 = tri.v2 as Vertex
              const v3 = tri.v3 as Vertex

              for (const e of v1.edges) {
                es.add(e)
              }
              for (const e of v2.edges) {
                es.add(e)
              }
              for (const e of v3.edges) {
                es.add(e)
              }
            }
          }

          const maxedges = brush.dynTopo.edgeCount

          /*
          //try to subdivide long edges extra
          let eratio = (e) => {
            let mindis = 1e17;
            let tot = 0;

            for (let i=0; i<2; i++) {
              let v = i ? e.v2 : e.v1;

              for (let e2 of v.edges) {
                mindis = Math.min(mindis, e2.v1.vectorDistanceSqr(e2.v2));
                tot++;
              }
            }

            if (!tot) {
              return 1.0;
            }

            let ret = e.v1.vectorDistance(e.v2) / Math.sqrt(mindis + 0.000001);

            if (ret < 1.0) {
              return 1.0 / ret;
            }

            return ret;
          }

          let rec = (e, depth = 0) => {
            if (depth > 3) {
              return;
            }

            //let len = e.v1.vectorDistanceSqr(e.v2);
            if (eratio(e) > 4.0) {//len > (esize*8.0)**2) {
              es.add(e);

              for (let i = 0; i < 2; i++) {
                let v = i ? e.v2 : e.v1;

                for (let e2 of v.edges) {
                  if (!es.has(e2)) {
                    maxedges++;
                    rec(e2, depth + 1);
                  }
                }
              }
            } else if (depth > 0) {
              //add leaves to es anyway
              for (let i = 0; i < 2; i++) {
                let v = i ? e.v2 : e.v1;

                for (let e2 of v.edges) {
                  es.add(e2);
                }
              }
            }
          }

          if (0) {
            let vs2 = bvh.closestVerts(ps.p, radius*2);
            let evisit = new WeakSet();

            for (let e of es) {
              evisit.add(e);
            }

            for (let v of vs2) {
              for (let e of v.edges) {
                if (!evisit.has(e)) {
                  evisit.add(e);
                  rec(e);
                }
              }
            }
          }

          for (let e of new Set(es)) {
            rec(e);
          }

          //*/

          for (const e of es) {
            vertexVs.add(e.v1)
            vertexVs.add(e.v2)
          }

          for (const v of vertexVs) {
            if (v) {
              log.ensure(v)
            }
          }

          for (const step2 of this2.doTopology(mesh, maxedges, bvh, esize, vertexVs, es, radius, brush)) {
            yield
          }

          for (let j = 0; j < 2; j++) {
            if (brush.dynTopo.flag & DynTopoFlags.COLLAPSE) {
              this2.doTopologyCollapse(mesh, maxedges, bvh, esize, vertexVs, es, radius, brush)
              yield
            }
          }

          yield

          if (step !== repeat - 1) {
            bvh.update()
            yield
          }
        }
      }
    }

    yield

    if (doTopo) {
      for (const iter of doDynTopo(vs)) {
        yield
      }
    }

    /*
    
    if (mesh instanceof TetMesh) {
      if (mode === GRAB) {
        let radius3 = radius * 4.0
        let vs2 = bvh.closestVerts(ps.origp, radius3) as unknown as Set<TetVertex>
        for (let v of vs) {
          vs2.add(v)
        }
        //let vs2 = new Set(mesh.verts);

        for (let v of vs2) {
          doUndo(v)

          let dis = v.co.vectorDistance(ps.origp)
          let w = Math.max(1.0 - dis / radius3, 0)

          if (w > 0.75) {
            w = 0.0
          } else {
            w = falloff.evaluate(w)
          } 

          v.w = w
        }

        tetSolve(mesh, vs2)

        let updateflag = BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_BOUNDS

        for (let v of vs2) {
          let node = cd_node.get(v).node
          if (!node) {
            continue
          }

          node.setUpdateFlag(updateflag)
        }
      }
    }
    */

    bvh.update()

    if (cd_disp >= 0) {
      const dctx = new DispContext()
      dctx.reset(mesh, cd_disp)

      dctx.settings.smoothGen++
      dctx.settings.initGen++

      const smemo = getSmoothMemo(mesh, new AttrRef(cd_disp))
      dctx.smemo = smemo

      vs = bvh.closestVerts(ps.p, bvhRadius)
      for (const v of vs) {
        dctx.v = v as Vertex

        let i = 0
        for (const cd of v.customData) {
          if (cd instanceof DispLayerVert) {
            dctx.pushDisp(i)
            cd.checkInterpNew(dctx)
            dctx.popDisp()
          }

          i++
        }
      }

      for (const v of vs) {
        if (v.eid < 0) {
          continue
        }

        dctx.v = v as Vertex
        const dv = v.customData[cd_disp] as DispLayerVert
        dv.flushUpdateCo(dctx, true)
      }
    }

    if (mres !== undefined && oldmres) {
      oldmres.copyTo(mres)

      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid] as GridBase

        grid.recalcFlag |= QRecalcFlags.NORMALS | QRecalcFlags.TOPO | QRecalcFlags.NEIGHBORS
        grid.update(mesh, l, gridAttr)
      }

      mesh.regenBVH()
      this.getBVH(mesh).update()
    }

    if (!this.modalRunning) {
      mesh.regenTessellation()
    }

    //flag mesh to upload to gpu after exiting pbvh toolmode
    mesh.regenRender()
  }

  _checkcurv(v: IBVHVertex, cd_curv: number, cd_cotan: number, force: boolean = false, cd_fset: number): void {
    if (cd_curv >= 0) {
      const curvVert = v.customData[cd_curv] as CurvVert
      curvVert.check(v, cd_cotan, force, cd_fset)
    }
  }

  hasCurveVerts(brush: SculptBrush): boolean {
    let ok = !!(brush.dynTopo.flag & DynTopoFlags.ADAPTIVE)
    ok = ok || (brush.rake > 0 && brush.rakeCurvatureFactor > 0)
    ok = ok || brush.sharp > 0
    ok = ok || brush.tool === SculptTools.DIRECTIONAL_FAIR

    return ok
  }

  *doTopology(
    mesh: Mesh,
    maxedges: number,
    bvh: BVH,
    esize: number,
    vs: Set<Vertex>,
    es: Set<Edge>,
    radius: number,
    brush: SculptBrush
  ): Generator<void> {
    DYNTOPO_T_GOAL = brush.dynTopo.valenceGoal
    ENABLE_DYNTOPO_EDGE_WEIGHTS = !!(brush.dynTopo.flag & DynTopoFlags.FANCY_EDGE_WEIGHTS)

    if (brush.dynTopo.flag & DynTopoFlags.ADAPTIVE) {
      this.edist_scale = this.edist_curvmul
    }

    const cd_fset = getFaceSets(mesh, false)
    const cd_curv = this.hasCurveVerts(brush) ? getCurveVerts(mesh) : -1
    //let cd_curv = -1;
    const cd_cotan = mesh.verts.customData.getLayerIndex('cotan')

    if (cd_curv >= 0) {
      const flag = MeshFlags.TEMP1
      for (const e of es) {
        e.v1.flag &= ~flag
        e.v2.flag &= ~flag
      }

      for (const e of es) {
        if (!(e.v1.flag & flag)) {
          e.v1.flag |= flag
          const cv = e.v1.customData.get(cd_curv) as CurvVert
          cv.check(e.v1, cd_cotan, undefined, cd_fset)
        }

        if (!(e.v2.flag & flag)) {
          e.v2.flag |= flag
          const cv = e.v2.customData.get(cd_curv) as CurvVert
          cv.check(e.v2, cd_cotan, undefined, cd_fset)
        }
      }
    }

    let origes: Set<Edge> | undefined

    if (brush.dynTopo.flag & DynTopoFlags.DRAW_TRIS_AS_QUADS) {
      origes = new Set(es)
    }

    const log = this._undo.log
    log.checkStart(mesh)

    es = es.filter((e: Edge) => e.eid >= 0)

    for (const e of es) {
      if (!e?.v1 || !e.v2 || e.eid < 0) {
        console.warn('Bad edge in doTopology:', e)
        es.delete(e)
        continue
      }

      log.ensure(e.v1)
      log.ensure(e.v2)

      for (const v of e.verts) {
        for (const v2 of v.neighbors) {
          log.ensure(v2)
        }
      }
    }

    const filter4 = !(brush.dynTopo.flag & DynTopoFlags.ALLOW_VALENCE4)
    //filter4 = filter4 && (brush.dynTopo.flag & (DynTopoFlags.SUBDIVIDE | DynTopoFlags.COLLAPSE));

    if (filter4) {
      this.doTopologyValence4(mesh, maxedges, bvh, esize, vs, es, radius, brush)
      es = es.filter((e) => e.eid >= 0)

      yield
    }

    //let chunksize = 20;
    //let steps = Math.ceil(maxedges / 50);
    //maxedges = Math.min(maxedges, chunksize);

    if (1) {
      //for (let si=0; si<steps; si++) {
      //if (util.time_ms() - this._last_time < 50) {
      //  return;
      //}
      this._last_time = util.time_ms()

      let elen = 0
      let tot = 0
      for (const e of es) {
        elen += e.v2.co.vectorDistance(e.v1.co)
        tot++
      }

      if (elen === 0.0) {
        return
      }

      let ratio = elen / esize
      ratio = Math.min(Math.max(ratio, 0.05), 20.0)

      const dflag = brush.dynTopo.flag & (DynTopoFlags.SUBDIVIDE | DynTopoFlags.COLLAPSE)

      // XXX check this
      if (dflag !== (DynTopoFlags.SUBDIVIDE | DynTopoFlags.COLLAPSE)) {
        ratio = 1.0
      }

      const max1 = Math.ceil(maxedges / ratio)
      const max2 = Math.ceil(maxedges * ratio)

      const nosmooth = 1

      //for future reference: An Enhanced Steepest Descent Method for Global Optimization-Based Mesh Smoothing
      //https://www.scirp.org/journal/paperinformation.aspx?paperid=104388
      //similar to my velocity smooth idea.
      const dosmooth = (vs: Iterable<IBVHVertex>, fac: number = 0.5): void => {
        if (nosmooth) {
          return
        }

        const co = new Vector3()
        const co2 = new Vector3()
        const g = new Vector3()

        for (const v of vs) {
          let tot = 0
          co.zero()

          log.ensure(v)

          for (const v2 of v.neighbors) {
            co2.load(v2.co).sub(v.co)
            const d = co2.dot(v.no)

            co2.addFac(v.no, -d).add(v.co)
            co.add(co2)

            //co.add(v2);
            tot++
          }

          if (tot > 0) {
            co.mulScalar(1.0 / tot)
            v.co.interp(co, fac)
            v.flag |= MeshFlags.UPDATE
          }
        }
      }

      const co = new Vector3()
      const co2 = new Vector3()

      const dosmooth2 = (v: Vertex, fac: number = 0.5): void => {
        if (nosmooth) {
          return
        }

        let tot = 0
        co.zero()

        log.ensure(v)

        for (const v2 of v.neighbors) {
          co2.load(v2.co).sub(v.co)
          const d = co2.dot(v.no)

          co2.addFac(v.no, -d).add(v.co)
          co.add(co2)

          //co.add(v2);
          tot++
        }

        if (tot > 0) {
          co.mulScalar(1.0 / tot)
          v.co.interp(co, fac)
          v.flag |= MeshFlags.UPDATE
        }
      }

      //this._runLogUndo(mesh, bvh);

      let newes = new Set<Edge>()

      //if (brush.dynTopo.flag & DynTopoFlags.COLLAPSE) {
      //  this.doTopologyCollapse(mesh, max2, bvh, esize, vs, es, radius, brush);
      //  es = es.filter(e => e.eid >= 0);
      //}

      if (brush.dynTopo.flag & DynTopoFlags.SUBDIVIDE) {
        const es_out = new Array<Set<Edge>>(1)

        for (let i = 0; i < 1; i++) {
          const gen = this.doTopologySubdivide(
            mesh,
            max1,
            bvh,
            esize,
            vs,
            es,
            radius,
            brush,
            newes,
            dosmooth2,
            cd_curv,
            es_out
          )
          for (const iter of gen) {
            yield
          }

          es = es_out[0]
          es = es.filter((e) => e.eid >= 0)

          for (const e of new Set(es)) {
            for (let i = 0; i < 2; i++) {
              const v = i ? e.v2 : e.v1
              for (const e2 of v.edges) {
                es.add(e2)
              }
            }
          }

          yield
        }
      }

      //dosmooth(vs);

      if (brush.dynTopo.flag & DynTopoFlags.QUAD_COLLAPSE) {
        this.doTopologyCollapseTris2Quads(mesh, max2, bvh, esize, vs, es, radius, brush, false, cd_curv)
        es = es.filter((e) => e.eid >= 0)
        yield
      }

      if (brush.dynTopo.flag & DynTopoFlags.COLLAPSE) {
        this.doTopologyCollapse(mesh, max2, bvh, esize, vs, es, radius, brush, cd_curv)
        yield
      } else if (0) {
        newes = newes.filter((e) => e.eid >= 0)
        const newvs = new Set<Vertex>()

        let esize2 = 0
        let tot = 0

        for (const e of new Set(newes)) {
          esize2 += e.v1.co.vectorDistance(e.v2.co)
          tot++

          for (let i = 0; i < 2; i++) {
            const v = i ? e.v2 : e.v1

            for (const e2 of v.edges) {
              newes.add(e2)

              const v2 = e2.otherVertex(v)
              newvs.add(v2)

              for (const e3 of v2.edges) {
                //  newes.add(e3);
              }
            }
          }

          newvs.add(e.v1)
          newvs.add(e.v2)
        }

        if (tot) {
          esize2 /= tot
        } else {
          esize2 = esize
        }

        //esize *= 2.0;

        this.doTopologyCollapse(mesh, max2, bvh, esize2, newvs, newes, radius, brush, cd_curv)
        for (const e of newes) {
          if (e.eid >= 0) {
            es.add(e)
          }
        }

        yield
      }

      es = es.filter((e) => e.eid >= 0)

      for (const e of es) {
        vs.add(e.v1)
        vs.add(e.v2)
      }

      dosmooth(vs, 0.15 * (1.0 - brush.rake))

      if (brush.dynTopo.flag & DynTopoFlags.DRAW_TRIS_AS_QUADS) {
        for (const e of origes!) {
          if (e.eid >= 0) {
            es.add(e)
          }
        }

        for (const e of new Set(es)) {
          for (const v of e.verts) {
            for (const e2 of v.edges) {
              //*
              const v2 = e2.otherVertex(v)

              for (const e3 of v2.edges) {
                es.add(e3)
              }
              //*/

              es.add(e2)
            }
          }
        }

        this.doTopologyCollapseTris2Quads(mesh, max2, bvh, esize, vs, es, radius, brush, true, cd_curv)
        yield
      }
    }

    //mark tessellation as bad, will happen on switching to another mode
    mesh.regenTessellation()
  }

  edist_simple(e: Edge, v1: Vertex, v2: Vertex, eset?: Set<Edge>, cd_curv?: number): number {
    return v1.co.vectorDistanceSqr(v2.co)
  }

  val(v: Vertex): number {
    let tot = 0

    for (const e of v.edges) {
      if (!(e.flag & MeshFlags.QUAD_EDGE)) {
        tot++
      }
    }

    return tot
  }

  edist_subd(e: Edge, v1: Vertex, v2: Vertex, eset?: Set<Edge>, cd_curv?: number): number {
    let dis = v1.co.vectorDistanceSqr(v2.co) * this.edist_scale(e, cd_curv)

    const val1 = this.val(v1) //v1.valence;
    const val2 = this.val(v2) //v2.valence;

    if (val1 === 4) {
      dis /= 1.5
    }

    if (val2 === 4) {
      dis /= 1.5
    }

    return dis

    //return dis; //XXX

    const val = (v1.valence + v2.valence) * 0.5
    //let mul = Math.max(Math.abs(val - 5.0)**3, 1.0);
    const mul = Math.max(val - 5.0, 1.0)

    dis /= mul ** 0.5

    return dis * FANCY_MUL

    //let dis = v1.vectorDistanceSqr(v2);

    //return dis;
    //*
    if (dis === 0.0) {
      return 0.0
    }

    //let val = (v1.valence + v2.valence) * 0.5;
    let d = Math.max(val - 5, 1) * 0.5

    d = Math.abs(val - 6) + 1.0
    return dis / d
    //*/

    /*
    let rtot = 0, ratio = 0;
    for (let l of e.loops) {
      l = l.next.next;

      let co = midtmp.load(v1).interp(v2, 0.5);

      let ratio2 = l.v.vectorDistanceSqr(co)/dis;

      if (ratio2 < 0.000001) {
        continue;
        //eek
        //return 0.0;
      }

      ratio2 = Math.max(ratio2, 0.001);

      //if (ratio2 > 1.0) {
      //  ratio2 = 1.0 / ratio2;
      //}
      ratio2 = 1.0 + Math.abs(ratio2 - 1.0);

      ratio += ratio2;
      rtot++;
    }

    if (rtot > 0) {
      ratio /= rtot;

      dis /= ratio;
    }

    if (cd_curv >= 0) {
      let cv1 = v1.customData[cd_curv];
      let cv2 = v2.customData[cd_curv];
      let tan = edist_coll_tmp1;

      cv1.check(v1);
      cv2.check(v2);

      tan.load(cv1.tan);
      if (cv1.tan.dot(cv2.tan) < 0) {
        tan.negate();
      }

      tan.add(cv2.tan).normalize();

      let vec = edist_coll_tmp2.load(v2).sub(v1).normalize();

      if (vec.dot(tan) < 0) {
        vec.negate();
      }

      let d = tan.dot(vec);
      d *= d;

      dis /= 1.0 + d*3.0;
    }*/

    return dis * this.edist_scale(e, cd_curv)
  }

  edist_curvmul(e: Edge, cd_curv: number): number {
    if (cd_curv >= 0) {
      const cv1 = e.v1.customData[cd_curv] as CurvVert
      const cv2 = e.v2.customData[cd_curv] as CurvVert

      //cv1.check(e.v1);
      //cv2.check(e.v2);

      let k1 = Math.abs(cv1.k1 + cv2.k1) * 0.5

      /*
      const pw = window.dd7 || 0.5;
      const add = window.dd8 || 1.0;
      const mul = window.dd9 || 1.0;
      //*/

      //*
      const pw = 0.5
      const add = 1.0
      const mul = 1.0
      //*/

      k1 = add + Math.pow(k1, pw) * mul
      return k1 * k1
      //return window.dd7 || 1.0;
    }
    return 1.0
    //return window.dd8 || 1.0;
  }

  edist_coll(e: Edge, v1: Vertex, v2: Vertex, eset?: Set<Edge>, cd_curv?: number): number {
    let dis = v1.co.vectorDistanceSqr(v2.co)

    const val1 = this.val(v1) //v1.valence;
    const val2 = this.val(v2) //v2.valence;

    if (val1 === 4) {
      dis *= 1.5
    }

    if (val2 === 4) {
      dis *= 1.5
    }

    return dis

    let d = (val1 + val2) * 0.5

    //goal is six-valence verts
    d = Math.max(d - 5.0, 1.0)
    //d = Math.abs(d - 6.0) + 1.0;
    //d *= 0.5;

    dis *= d

    return dis * FANCY_MUL

    /*
    if (cd_curv >= 0) {
      let cv1 = v1.customData[cd_curv];
      let cv2 = v2.customData[cd_curv];
      let tan = edist_coll_tmp1;

      cv1.check(v1);
      cv2.check(v2);

      tan.load(cv1.tan);
      if (cv1.tan.dot(cv2.tan) < 0) {
        tan.negate();
      }

      tan.add(cv2.tan).normalize();

      let vec = edist_coll_tmp2.load(v2).sub(v1).normalize();

      if (vec.dot(tan) < 0) {
        vec.negate();
      }

      let d = tan.dot(vec);
      d *= d;

      dis *= 1.0 + d*3.0;
    }*/

    return dis * this.edist_scale(e, cd_curv) * FANCY_MUL
  }

  edist_old(e: Edge, v1: Vertex, v2: Vertex, mode: number = 0): number {
    let dis = v1.co.vectorDistanceSqr(v2.co)
    //return dis;

    const val1 = v1.valence
    const val2 = v2.valence

    let d = val1 + val2

    if (0) {
      //d = (val1+val2)*0.5;
      d = Math.max(val1, val2)

      const t = DYNTOPO_T_GOAL

      let dis2 = dis

      if (mode) {
        //collapse
        dis2 /= 1.0 + Math.max((d - t) * this.dynTopoRand.random(), -0.75)

        if (d > t) {
          // dis2 /= 1.0 + (d - t)*Math.random();
        }
      } else {
        //subdivide
        dis2 /= 1.0 + Math.max((t - d) * this.dynTopoRand.random(), -0.75)

        if (d < t) {
          //dis2 /= 1.0 + (t - d)*Math.random();
        }
      }

      dis += (dis2 - dis) * 0.5
      return dis
    }

    d = 0.5 + d * 0.25

    d += -2.0
    d = Math.pow(Math.max(d, 0.0), 2)
    d *= 0.5

    //let fac = window.dd1 || 0.5; //0.3;
    //d += window.dd2 || -2.0;
    //d = Math.pow(d, window.dd3 || 0.5);

    if (d !== 0.0) {
      if (!mode) {
        //d = 1.0 / d;
        //d = (val1 + val2)*0.5 - 6;
        //d = Math.max(d, 0.0) + 1.0;
        //d = 1.0;
      }

      dis *= d
    }

    //try to avoid four-valence verts with all triangles
    //if (mode && (val1 === 4 || val2 === 4) && Math.random() > 0.8) {
    //dis /= 3.0;
    //}

    if (0) {
      //!mode) {
      let minsize = 1e17
      for (let i = 0; i < 2; i++) {
        const v = i ? v2 : v1
        for (const e of v.edges) {
          minsize = Math.min(minsize, e.v1.co.vectorDistance(e.v2.co))
        }
      }
      const dist = v1.co.vectorDistance(v2.co)

      minsize = Math.min(minsize, dist)
      let ratio = dist / (minsize + 0.00001)

      ratio = Math.max(ratio, 1.0)

      let p = 1.0 - 1.0 / ratio

      p *= p

      if (this.dynTopoRand.random() < p) {
        return dis * 0.5
      }
    }

    //dihedral angle
    /*
    if (e.l) {
      let th = Math.abs(e.l.f.no.dot(e.l.radial_next.f.no));
      th *= th;
      th = 1.0 - th;
      //th *= th;

      dis += (dis*9.0 - dis)*th;
    }//*/

    return dis //*1.5;
  }

  //calculates edge size from density and radius
  calcESize2(totedge: number, radius: number): number {
    if (totedge === 0) {
      return 0.0
    }

    const area = Math.PI * radius ** 2

    //let density1 = area / ((k*esize)**2);
    //esize2 is density1 solved for esize

    return Math.sqrt(area / totedge)
  }

  doTopologyCollapseTris2Quads(
    mesh: Mesh,
    max: number,
    bvh: BVH,
    esize: number,
    vs: Set<Vertex>,
    es: Set<Edge>,
    radius: number,
    brush: SculptBrush,
    mark_only: boolean,
    cd_curv: number
  ): void {
    const log = this._undo.log
    log.checkStart(mesh)

    const cd_cotan = mesh.verts.customData.getLayerIndex('cotan')

    const fs = new Set<Face>()

    for (const e of es) {
      for (const l of e.loops) {
        if (l.f.lists.length === 1 && l.f.lists[0].length === 3) {
          fs.add(l.f)
        }
      }
    }

    let updateflag = BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_COLORS
    updateflag = updateflag | BVHFlags.UPDATE_TOTTRI | BVHFlags.UPDATE_INDEX_VERTS
    updateflag = updateflag | BVHFlags.UPDATE_UNIQUE_VERTS | BVHFlags.UPDATE_OTHER_VERTS

    const cd_node = bvh.cd_node

    if (!mark_only) {
      for (const f of fs) {
        for (const l of f.loops) {
          const node = cd_node.get(l.v).node
          if (node) {
            node.setUpdateFlag(updateflag)
          }
        }

        bvh.removeFace(f.eid)
      }
    }

    let newfs = new Set(fs)

    const cd_fset = getFaceSets(mesh, false)

    const lctx = new LogContext()
    lctx.onnew = (e: Element, tag: number): void => {
      if (e.type === MeshTypes.VERTEX) {
        this._checkcurv(e, cd_curv, cd_cotan, true, cd_fset)
      }

      log.logAdd(e, tag)

      if (e.type === MeshTypes.FACE) {
        newfs.add(e)
      }
    }

    lctx.onkill = (e: Element, tag: number): void => {
      log.logKill(e, tag)
    }

    let splitflag = TriQuadFlags.DEFAULT

    if (mark_only) {
      splitflag |= TriQuadFlags.MARK_ONLY

      const flag = MeshFlags.NOAPI_TEMP2

      for (const f of fs) {
        for (const e of f.edges) {
          e.flag &= ~flag
        }
      }

      lctx.onchange = (e: Element): void => {
        if (e.type !== MeshTypes.EDGE) {
          return
        }

        if (e.flag & flag) {
          return
        }

        e.flag |= flag

        for (const l of e.loops) {
          const f = l.f
          const tris = bvh.getFaceTris(f._old_eid)

          if (!tris) {
            continue
          }

          for (const t of tris) {
            if (!t.node) {
              continue
            }

            t.node.setUpdateFlag(BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_DRAW)
          }
        }
      }
    }

    trianglesToQuads(mesh, fs, splitflag, lctx)

    newfs = newfs.filter((f) => f.eid >= 0)

    if (mark_only) {
      for (const f of newfs) {
        const tris = bvh.getFaceTris(f._old_eid)
        if (!tris) {
          continue
        }

        for (const t of tris) {
          if (t.node) {
            t.node.flag |= BVHFlags.UPDATE_INDEX_VERTS
          }
        }
      }
      return
    }

    const looptris = [] as Loop[]

    for (const f of newfs) {
      triangulateFace(f, looptris)
    }

    for (let i = 0; i < looptris.length; i += 3) {
      const l1 = looptris[i]
      const l2 = looptris[i + 1]
      const l3 = looptris[i + 2]
      const f = l1.f

      const tri = bvh.addTri(f.eid, bvh._nextTriIdx(), l1.v, l2.v, l3.v, true, l1, l2, l3)
      tri.flag |= BVHTriFlags.LOOPTRI_INVALID
    }
  }

  doTopologyValence4(
    mesh: Mesh,
    max: number,
    bvh: BVH,
    esize: number,
    vs: Set<Vertex>,
    es: Set<Edge>,
    radius: number,
    brush: SculptBrush,
    lctx?: LogContext
  ): void {
    let addfaces = false
    const newfaces = [] as Face[]

    if (!lctx) {
      addfaces = true

      const log = this._undo.log
      log.checkStart(mesh)

      lctx = new LogContext()
      //lctx callback for deleting 4-valence verts
      lctx.onnew = (e: Element, tag: number): void => {
        log.logAdd(e, tag)

        if (e.type === MeshTypes.FACE) {
          newfaces.push(e)
        }
      }

      let updateflag = BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_UNIQUE_VERTS
      updateflag |= BVHFlags.UPDATE_OTHER_VERTS | BVHFlags.UPDATE_TOTTRI | BVHFlags.UPDATE_INDEX_VERTS

      lctx.onkill = (e: Element, tag: number): void => {
        log.logKill(e, tag)

        if (e.type === MeshTypes.FACE) {
          const tris = bvh.getFaceTris(e._old_eid)

          if (tris) {
            for (const t of tris) {
              for (const node of t.nodes) {
                if (node) {
                  node.setUpdateFlag(updateflag)
                }
              }
            }
          }

          bvh.removeFace(e._old_eid)
        }
      }
    }

    //filter out 4-valence verts that are surrounded by
    //all triangles

    for (const e of es) {
      if (e.eid < 0) {
        continue
      }

      const v1 = e.v1
      const v2 = e.v2

      for (let i = 0; i < 2; i++) {
        const v = i ? v2 : v1
        const val = v.valence

        if (val !== 4 && val !== 3) {
          continue
        }

        let bad = false
        const flag = MeshFlags.TEMP1

        for (const e2 of v.edges) {
          if (!e2.l) {
            bad = true
            break
          }

          for (const l of e2.loops) {
            l.f.flag &= ~flag

            if (!l.f.isTri()) {
              bad = true
              break
            }
          }
        }

        if (bad) {
          continue
        }

        const node = bvh.cd_node.get(v).node
        if (node) {
          node.setUpdateFlag(BVHFlags.UPDATE_INDEX_VERTS)

          if (node.uniqueVerts) {
            node.uniqueVerts.delete(v)
          }
        }

        let f
        f = mesh.dissolveVertex(v, lctx)

        if (f && !(brush.dynTopo.flag & DynTopoFlags.QUAD_COLLAPSE)) {
          if (f.isNgon()) {
            //should never happen
            console.warn('Something bad happened!')
            f.calcNormal()
            applyTriangulation(mesh, f, undefined, undefined, lctx)
          } else if (f.isQuad()) {
            triangulateQuad(mesh, f, lctx)
          }
        } else if (f) {
          //lctx.onnew(f);
        }

        break
      }
    }

    if (addfaces) {
      for (const f of newfaces) {
        if (f.eid < 0) {
          continue
        }

        const l1 = f.lists[0].l
        const l2 = l1.next
        const l3 = l2.next
        let l4
        let tri

        if (f.isQuad()) {
          l4 = l3.next

          tri = bvh.addTri(f.eid, bvh._nextTriIdx(), l1.v, l2.v, l3.v, true, l1, l2, l3)
          tri.flag |= BVHTriFlags.LOOPTRI_INVALID

          bvh.addTri(f.eid, bvh._nextTriIdx(), l1.v, l3.v, l4.v, true, l1, l3, l4)
          tri.flag |= BVHTriFlags.LOOPTRI_INVALID
        } else {
          tri = bvh.addTri(f.eid, bvh._nextTriIdx(), l1.v, l2.v, l3.v, true, l1, l2, l3)
          tri.flag |= BVHTriFlags.LOOPTRI_INVALID
        }
      }
    }
  }

  _calcEsizeScale(esize: number, factor: number): number {
    return 1.5 + factor
  }

  doTopologyCollapse(
    mesh: Mesh,
    max: number,
    bvh: BVH,
    esize: number,
    vs: Set<Vertex>,
    es: Set<Edge>,
    radius: number,
    brush: SculptBrush,
    cd_curv?: number
  ): void {
    const lctx = new LogContext()

    const rand = this.dynTopoRand

    //return;
    const es2 = [] as Edge[]

    esize /= this._calcEsizeScale(esize, brush.dynTopo.decimateFactor)

    const fancyWeights = brush.dynTopo.flag & DynTopoFlags.FANCY_EDGE_WEIGHTS
    const cd_cotan = mesh.verts.customData.getLayerIndex('cotan')
    const edist = fancyWeights ? this.edist_coll : this.edist_simple
    const log = this._undo.log
    log.checkStart(mesh)

    const fs = new Set()

    if (es.size === 0) {
      return
    }

    let esize2

    if (0) {
      esize2 = this.calcESize2(es.size, radius)
      if (esize2 < esize) {
        esize += (esize2 - esize) * 0.75
      }
    } else {
      esize2 = esize
    }

    const esqr = esize * esize
    const es0 = [] as Edge[]

    for (const e of es) {
      if (e.eid >= 0) {
        es0.push(e)
      }
    }
    const elist = es0

    for (let e of elist) {
      const ri = ~~(rand.random() * elist.length * 0.9999)
      e = elist[ri]

      if (es2.length >= max) {
        break
      }

      if (!e.l) {
        continue
      }

      const lensqr = edist(e, e.v1, e.v2, undefined, cd_curv!)

      if (rand.random() > lensqr / esqr) {
        continue
      }

      if (lensqr <= esqr) {
        let l = e.l
        let _i = 0

        do {
          fs.add(l.f)
          l = l.radial_next
        } while (l !== e.l && _i++ < 100)

        es2.push(e)
      }
    }

    const fs2 = new Set<Face>()
    const es3 = new Set<Edge>()

    for (const e1 of es2) {
      es3.add(e1)

      log.ensure(e1.v1)
      log.ensure(e1.v2)
      log.ensure(e1)

      for (let i = 0; i < 2; i++) {
        const v = i ? e1.v2 : e1.v1

        for (const e of v.edges) {
          es3.add(e)

          if (!e.l) {
            continue
          }

          let l = e.l
          let _i = 0

          do {
            fs2.add(l.f)

            //let node = l.f.customData[cd_face_node].node;
            //if (node) {
            //  fmap.set(l.f, node);
            //}

            bvh.removeFace(l.f.eid)
            l = l.radial_next
          } while (l !== e.l && _i++ < 10)
        }
      }
    }

    const kills = new Map()
    for (const f of fs2) {
      if (f.eid >= 0) {
        kills.set(f, log.logKillFace(f))
      }
    }

    for (const e of es3) {
      if (e.eid >= 0) {
        kills.set(e, log.logKillEdge(e))
      }
    }

    //console.log("es2", es2);

    const typemask = MeshTypes.VERTEX | MeshTypes.EDGE | MeshTypes.FACE

    lctx.onkill = (elem: Element, tag: number): void => {
      if (!(elem.type & typemask)) {
        return
      }
      if (kills.has(elem)) {
        return
      }

      if (elem.type === MeshTypes.VERTEX) {
        const node = bvh.cd_node.get(elem).node

        if (node && node.uniqueVerts) {
          node.uniqueVerts.delete(elem)
          const nodeinfo = bvh.cd_node.get(elem) as CDNodeInfo<{dead: true}>
          nodeinfo.node = undefined
        }
      } else if (elem.type === MeshTypes.FACE) {
        bvh.removeFace(elem._old_eid)
      }

      log.logKill(elem, tag)
    }

    const cd_fset = getFaceSets(mesh, false)

    lctx.onnew = (elem: Element, tag: number): void => {
      if (cd_curv! >= 0 && elem.type === MeshTypes.VERTEX) {
        this._checkcurv(elem, cd_curv!, cd_cotan, true, cd_fset)
      }

      if (elem.type & typemask) {
        //if (kills.has(elem)) {
        //  kills.delete(elem);
        //}

        log.logAdd(elem, tag)
      }
    }

    /*
    let flag = MeshFlags.TEMP2;

    function logStart(v) {
      v.flag |= flag;

      log.ensure(v);

      for (let v2 of v.neighbors) {
        if (!(v2.flag & flag)) {
          v2.flag |= flag;

          log.ensure(v2);
        }
      }
    }

    for (let e of es2) {
      for (let i=0; i<2; i++) {
        let v = i ? e.v2 : e.v1;

        v.flag &= ~flag;

        for (let v2 of v.neighbors) {
          v2.flag &= ~flag;
        }
      }
    }

    for (let e of es2) {
      if (!(e.v1.flag & flag)) {
        logStart(e.v1);
      }
      if (!(e.v2.flag & flag)) {
        logStart(e.v2);
      }
    }//*/

    for (const e of es2) {
      if (e.eid < 0) {
        continue
      }

      mesh.collapseEdge(e, undefined, lctx)
    }

    for (const e of es3) {
      if (e.eid >= 0) {
        const le = kills.get(e)

        if (le) {
          //log.cancelEntry(le);
          log.logAddEdge(e)
        }
      }
    }

    for (const f of fs2) {
      if (f.eid >= 0) {
        //log.cancelEntry(kills.get(f));
        log.logAddFace(f)
      }
    }

    const cd_node = bvh.cd_node
    const updateflag =
      BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_UNIQUE_VERTS | BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_INDEX_VERTS

    for (const f of fs2) {
      if (f.eid < 0) {
        continue //face was deleted
      }

      const startl = f.lists[0].l
      let l = startl.next
      let _i = 0

      //cleanup wire edges
      do {
        const v1 = startl.v
        const v2 = l.v
        const v3 = l.next.v

        for (let i = 0; i < l.v.edges.length; i++) {
          const e = l.v.edges[i]

          const node = cd_node.get(l.v)

          if (node && node.node && !node.node.bvh.dead) {
            if ((node.node.flag & updateflag) !== updateflag) {
              node.node.bvh.updateNodes.add(node.node)
            }

            node.node.flag |= updateflag
          }

          if (!e.l) {
            mesh.killEdge(e, lctx)
            i--
          }
        }

        //let tri = bvh.getTrackById(f.eid, bvh._nextTriIdx(), v1, v2, v3);

        const tri = bvh.addTri(f.eid, bvh._nextTriIdx(), v1, v2, v3, true, startl, l, l.next)
        tri.flag |= BVHTriFlags.LOOPTRI_INVALID

        l = l.next
      } while (l !== f.lists[0].l.prev && _i++ < 1000)
    }

    for (const v of vs) {
      if (!v) {
        console.warn('Eek, undefined in vs!')
        vs.delete(v)
        continue
      }

      if (v.eid < 0) {
        continue
      }

      let count = 0

      let ok

      do {
        ok = false
        count = 0

        for (const e of v.edges) {
          if (!e.l) {
            mesh.killEdge(e, lctx)
            ok = true
          }

          count++
        }
      } while (ok)

      if (!count) {
        mesh.killVertex(v, undefined, lctx)
      }
    }
  }

  /*

  on factor;

  m := mat((m11, m12, m13), (m21, m22, m23), (m31, m32, m33));

  m := mat((n1x*n1x, n1x*n1y, n1x*n1z), (n1y*n1x, n1y*n1y, n1y*n1z), (n1z*n1x, n1z*n1y, n1z*n1z));
  m2 := mat((n2x*n2x, n2x*n2y, n2x*n2z), (n2y*n2x, n2y*n2y, n2y*n2z), (n2z*n2x, n2z*n2y, n2z*n2z));
  m3 := mat((n3x*n3x, n3x*n3y, n3x*n3z), (n3y*n3x, n3y*n3y, n3y*n3z), (n3z*n3x, n3z*n3y, n3z*n3z));
  m := m + m2 + m3;

  eg := mateigen(m, x);

  tm := mat((x, 0, 0), (0, x, 0), (0, 0, x));

  f1 := det (tm - m);
  solve(f1, x);

  l1 := part(eg, 1, 1);
  l2 := part(eg, 2, 1);

  * */

  doQuadTopo<GV extends GridVertBase<any> = GridVert>(
    mesh: Mesh,
    bvh: BVH,
    esize: number,
    vs: Set<GV>,
    brushco: Vector3,
    brushradius: number,
    brush: SculptBrush
  ): void {
    //console.log("quadtree topo!")
    //if (util.time_ms() - this._last_time < 15) {
    //  return;
    //}

    //ensure bounds are correct
    bvh.update()

    const docol = brush.dynTopo.flag & DynTopoFlags.COLLAPSE
    const dosub = brush.dynTopo.flag & DynTopoFlags.SUBDIVIDE

    const cd_grid = bvh.cd_grid as unknown as AttrRef<QuadTreeGrid | KdTreeGrid>
    let cd_node = bvh.cd_node

    const esize1 = esize * (1.0 + 0.75 * brush.dynTopo.subdivideFactor)
    const esize2 = esize * (1.0 - 0.75 * brush.dynTopo.decimateFactor)

    const esqr1 = esize1 * esize1
    const esqr2 = esize2 * esize2

    let haveKdTree = false
    const layer = mesh.loops.customData.flatlist[bvh.cd_grid.i]
    if (layer.typeName === 'KdTreeGrid') {
      haveKdTree = true
    }

    const MAXCHILD = haveKdTree ? 2 : 4
    const data = [] as (QuadTreeGrid | KdTreeGrid | number | Loop)[]
    const DGRID = 0
    const DNODE = 1
    const DLOOP = 2
    const DMODE = 3
    const DTOT = 4

    const SUBDIVIDE = 0
    const COLLAPSE = 1

    let QFLAG = QuadTreeFields.QFLAG
    let QDEPTH = QuadTreeFields.QDEPTH
    let QPARENT = QuadTreeFields.QPARENT
    let QPOINT1 = QuadTreeFields.QPOINT1

    let LEAF = QuadTreeFlags.LEAF
    let DEAD = QuadTreeFlags.DEAD

    if (haveKdTree) {
      QFLAG = KdTreeFields.QFLAG
      QDEPTH = KdTreeFields.QDEPTH
      QPARENT = KdTreeFields.QPARENT
      QPOINT1 = KdTreeFields.QPOINT1
      LEAF = KdTreeFlags.LEAF
      DEAD = KdTreeFlags.DEAD
    }

    const updateflag = BVHFlags.UPDATE_NORMALS | BVHFlags.UPDATE_DRAW

    const {VTOT, VTOTE, VTOTN, VINDEX, VV, VU} = VMapFields
    const {ETOT, ETOTN, EINDEX, EID, EV1, EV2} = EMapFields

    const vs2 = new Set<GV>()
    const grids = new Set<GridBase>()
    const gridmap = new Map<GridBase, Loop>()

    const visit = new Set()
    const updateloops = new Set<Loop>()
    const bnodes = new Set<BVHNode>()

    let maxDepth = brush.dynTopo.maxDepth //this.inputs.dynTopoDepth.getValue();

    if (haveKdTree) {
      maxDepth *= 2
    }

    const visits = new Map()
    let tot = 0

    const vs3 = [] as GV[]
    for (const v of vs) {
      vs3.push(v)
    }

    const vlist = vs3

    const dn1 = new Vector3()
    const dn2 = new Vector3()
    const dn3 = new Vector3()
    const dn4 = new Vector3()
    const dn5 = new Vector3()

    const rsqr = brushradius * brushradius

    //vs.sort((a, b) => a.vectorDistanceSqr(brushco) - b.vectorDistanceSqr(brushco));

    const limit = brush.dynTopo.edgeCount

    for (let _i = 0; _i < vlist.length; _i++) {
      const ri = ~~(this.dynTopoRand.random() * vlist.length * 0.99999)
      const v = vlist[ri]

      //for (let v of vs) {
      if (tot >= limit) {
        break
      }

      const l = mesh.eidMap.get(v.loopEid)

      if (l === undefined || !(l instanceof Loop)) {
        continue
      }

      let ok = false
      let dtot = 0
      let ntot = 0
      let etot = 0
      let maxlen = 0
      let minlen = 1e17

      for (const v2 of v.neighbors) {
        if (v2.bLink && v2.loopEid !== v.loopEid) {
          continue
        }

        const distsqr = v.co.vectorDistanceSqr(v2.co)

        maxlen = Math.max(maxlen, distsqr)
        minlen = Math.min(minlen, distsqr)

        if (distsqr > esqr1) {
          dtot++
        } else if (distsqr < esqr2) {
          etot++
        }

        ntot++
      }

      etot = maxlen < esqr2 ? 1 : 0

      if (dtot > 0 || etot > 0) {
        //>= ntot*0.5) {
        ok = true
      }

      if (ok) {
        vs2.add(v)

        const grid = cd_grid.get(l)

        if (!grids.has(grid as unknown as GridBase)) {
          grid.recalcPointIndices()
          visits.set(grid, new Set())
          gridmap.set(grid as unknown as GridBase, l)

          grids.add(grid as unknown as GridBase)
          // XXX strange type inference error with cd_grid
          /* @ts-ignore */
          grid.update(mesh, l, cd_grid)
        }

        const visit2 = visits.get(grid)

        // XXX strange type inference error with cd_grid
        /* @ts-ignore */
        const topo = grid.getTopo(mesh, cd_grid)
        const ns = grid.nodes

        const vi2 = v.index2 * VTOT

        /*
        let v2 = topo.vmap[v.index];
        if (!v2) {
          v.index = grid.points.indexOf(v);
          vi2 = v.index*VTOT;
          v2 = topo.vmap[v.index];

          if (!v2) {
            throw new Error("index error!");
          }
          //console.log("error", v.index);
          //continue;
        }*/

        let ok = false

        const vmap2 = topo.vmap2
        const totn = vmap2[vi2 + VTOTN]

        for (let vni = 0; vni < totn; vni++) {
          let ni = vi2 + VTOTN + 1 + vni
          ni = vmap2[ni]

          //for (let ni of v2.nodes) {
          if (tot >= limit) {
            break
          }

          let found = false
          for (let i = 0; i < 4; i++) {
            const p = grid.points[ns[ni + QPOINT1 + i]]
            const p2 = grid.points[ns[ni + QPOINT1 + ((i + 1) % 4)]]

            if (!p2 || !p) {
              console.warn('eek!', ni)
              continue
            }

            let dist = p.co.vectorDistanceSqr(brushco)

            if (dist <= rsqr) {
              found = true
              break
            }

            const t = dn1.load(p2.co).sub(p.co)
            const len = t.vectorLength()

            if (len > 0.000001) {
              t.mulScalar(1.0 / len)
            }

            const co = dn2.load(brushco).sub(p.co)

            let dt = t.dot(co) / len

            dt = Math.min(Math.max(dt, 0.0), 1.0)

            co.load(p.co).interp(p2.co, dt)
            dist = p.co.vectorDistanceSqr(co)

            if (dist < rsqr) {
              found = true
              break
            }
          }

          if (!found) {
            continue
          }

          if (!visit2.has(ni) && ns[ni + QFLAG] & LEAF && !(ns[ni + QFLAG] & DEAD)) {
            let mode

            mode = etot < dtot ? SUBDIVIDE : COLLAPSE

            if (this.dynTopoRand.random() > 0.9) {
              mode = COLLAPSE
            } else if (!etot && !dtot) {
              continue
            }

            if (mode === SUBDIVIDE && !dosub) {
              continue
            }
            if (mode === COLLAPSE && !docol) {
              continue
            }

            /*
            if (Math.random() > 0.97) {
              etot = 1;
            }

            if (etot) {
              mode = COLLAPSE;
            } else if (dtot) {
              mode = SUBDIVIDE;
            } else {
              continue;
            }
            //*/

            //let mode = dtot > etot ? SUBDIVIDE : COLLAPSE;

            if (maxDepth > 0 && mode === SUBDIVIDE && ns[ni + QDEPTH] >= maxDepth) {
              continue
            }

            if (mode === COLLAPSE) {
              if (!ni || visit2.has(grid.nodes[ni + QPARENT])) {
                continue
              }

              ni = grid.nodes[ni + QPARENT]
            }

            updateloops.add(l)

            data.push(grid)
            data.push(ni)
            data.push(l)
            //data.push(COLLAPSE);
            data.push(mode)

            visit2.add(ni)

            ok = true
            tot++
          }
        }

        if (ok) {
          const node = cd_node.get(v).node

          if (node) {
            node.setUpdateFlag(updateflag)
            bnodes.add(node)
          }
        }
      }
    }

    /*
    for (let n of bvh.nodes) {//bnodes) {
      if (n.id < 0) {
        continue;
      }

      //bvh.checkJoin(n);
    }*/

    //console.log(data);
    //updateloops = new Set(mesh.loops);

    cd_node = mesh.loops.customData.getLayerRef('bvh')

    for (const l of updateloops) {
      const grid = l.customData[cd_grid.i] as GridBase

      //forcibly unlink vert node refs
      for (const p of grid.points) {
        const node = cd_node.get(p) as CDNodeInfo<{dead: true}>

        if (node.node?.uniqueVerts) {
          node.node.uniqueVerts.delete(p)
        }
        node.node = undefined
      }

      bvh.removeFace(l.eid, true, false)
    }

    /*
    for (let grid of visits.keys()) {
      let qnodes = visits.get(grid);
      let idmul = grid.idmul;
      let l = gridmap.get(grid);

      let id = l.eid*idmul;
      for (let ni of qnodes) {
        bvh.removeFace(id + ni);
      }
    }
    //*/

    for (const node of bnodes) {
      if (node.id < 0) {
        //node died at some point?
        continue
      }
    }
    bvh.updateTriCounts()

    let maxdimen = 1
    for (const grid of grids) {
      maxdimen = Math.max(maxdimen, grid.dimen)
    }

    const idmul = (maxdimen + 2) * (maxdimen + 2) * 128

    //console.log(data.length / DTOT);
    for (const grid of grids) {
      grid.recalcFlag |= QRecalcFlags.TOPO

      //grid._rebuildHash();
      //grid.checkCustomDataLayout(mesh);
      //grid.relinkCustomData();
    }

    const compactgrids = new Set<QuadTreeGrid | KdTreeGrid>()

    for (let di = 0; di < data.length; di += DTOT) {
      const grid = data[di] as QuadTreeGrid | KdTreeGrid
      const ni = data[di + 1] as number
      const l = data[di + 2] as Loop
      const mode = data[di + 3] as number
      const key = l.eid * idmul + ni

      if (visit.has(key) || grid.nodes[ni + QFLAG] & DEAD) {
        continue
      }

      visit.add(key)
      if (mode === SUBDIVIDE && grid.points.length < 512 * 512) {
        // && (ns[ni + QFLAG] & LEAF)) {
        grid.subdivide(ni, l.eid, mesh)
      } else if (mode === COLLAPSE) {
        //continue;
        grid.collapse(ni)
        bvh.updateGridLoops.add(l)
      }

      grid.recalcFlag |= QRecalcFlags.NODE_DEPTH_DELTA

      if (grid.freelist.length > 16) {
        compactgrids.add(grid)
      }
      //console.log(ni, "depth:", ns[ni+QDEPTH], "key", key);
    }

    if (compactgrids.size > 0) {
      //console.log("COMPACT", compactgrids);
    }

    for (const grid of compactgrids) {
      grid.compactNodes()
    }

    //console.log(bvh.nodes.length, bvh.root.tottri);

    const trisout = [] as (number | GridVert)[]

    const visit2 = new Set()

    const updateloops2 = new Set<Loop>()

    for (const l of updateloops) {
      let l2 = l.radial_next
      updateloops2.add(l2)

      l2 = l.prev.radial_next
      updateloops2.add(l2)

      l2 = l.next.radial_next
      updateloops2.add(l2)

      l2 = l.radial_next.next
      updateloops2.add(l2)

      l2 = l.radial_next.prev
      updateloops2.add(l2)

      l2 = l.next
      updateloops2.add(l2)

      l2 = l.prev
      updateloops2.add(l2)

      updateloops2.add(l)
    }

    //let uflag = QRecalcFlags.LEAVES|QRecalcFlags.ALL|QRecalcFlags.NEIGHBORS|QRecalcFlags.TOPO|QRecalcFlags.POINTHASH;
    //uflag = (1<<20)-1;
    const uflag = QRecalcFlags.NORMALS //|QRecalcFlags.NEIGHBORS|QRecalcFlags.TOPO|QRecalcFlags.POLYS;
    const updateflag2 =
      QRecalcFlags.NEIGHBORS |
      QRecalcFlags.TOPO |
      QRecalcFlags.INDICES |
      QRecalcFlags.LEAVES |
      QRecalcFlags.POLYS |
      QRecalcFlags.MIRROR |
      QRecalcFlags.POINTHASH

    for (const l of updateloops2) {
      const grid = l.customData[cd_grid.i] as GridBase
      grid.recalcFlag |= updateflag2 // | QRecalcFlags.ALL;
    }

    for (const grid of grids) {
      grid.recalcFlag |= uflag
    }

    for (const l of updateloops) {
      const grid = l.customData[cd_grid.i] as GridBase
      grid.update(mesh, l, cd_grid as unknown as AttrRef<GridBase>)
    }

    for (const l of updateloops2) {
      const grid = l.customData[cd_grid.i] as GridBase
      grid.update(mesh, l, cd_grid as unknown as AttrRef<GridBase>)
    }

    for (const l of mesh.loops) {
      const grid = l.customData[cd_grid.i] as GridBase
      //if (grids.has(grid)) {
      grid.update(mesh, l, cd_grid as unknown as AttrRef<GridBase>)
      //}
    }

    //XXX

    for (const l of updateloops) {
      const grid = l.customData[cd_grid.i] as GridBase

      if (visit2.has(grid)) {
        throw new Error('eek!')
      }
      visit2.add(grid)

      const a = trisout.length

      // XXX the type inference errors with cd_grid are annoying
      grid.makeBVHTris(mesh, bvh, l, cd_grid as any, trisout)
    }

    const _tmp = [0, 0, 0]

    function sort3(a: number, b: number, c: number): number[] {
      _tmp[0] = a
      _tmp[1] = b
      _tmp[2] = c
      _tmp.sort()

      return _tmp
    }

    let _i = 0
    while (trisout.length > 0) {
      const ri = ~~(((this.rand.random() * trisout.length) / 5) * 0.999999) * 5
      //let ri = 0;

      const feid = trisout[ri] as number
      const id = trisout[ri + 1] as number
      const v1 = trisout[ri + 2] as GridVert
      const v2 = trisout[ri + 3] as GridVert
      const v3 = trisout[ri + 4] as GridVert

      //let sort = sort3(v1.index, v2.index, v3.index);
      //let key = `${feid}:${id}:${sort[0]}:${sort[1]}:${sort[2]}`
      //if (visit2.has(key)) {
      //throw new Error("eek2");
      //} else {

      //console.log("feid", feid);
      //if (!bvh.hasTri(id)) {

      if (!bvh.hasTri(feid, id)) {
        bvh.addTri(feid, id, v1, v2, v3)
      }
      //}
      //}

      //swap with last for fast pop
      const ri2 = trisout.length - 5

      for (let j = 0; j < 5; j++) {
        trisout[ri + j] = trisout[ri2 + j]
      }

      trisout.length -= 5

      if (_i++ >= 97) {
        //  break;
      }
    }

    for (let i = 0; i < 3; i++) {
      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid.i] as GridBase
        grid.recalcFlag = QRecalcFlags.EVERYTHING & ~QRecalcFlags.NODE_DEPTH_DELTA
        grid.recalcFlag |= QRecalcFlags.FIX_NEIGHBORS | QRecalcFlags.POINT_PRUNE
      }

      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid.i] as GridBase
        // XXX TS really doesn't like AttrRef<QuadTreeGrid | KDTreeGrid>
        grid.update(mesh, l, cd_grid as any)
      }
    }

    /*

        update_grid(l); //will do l.prev/.next too
        update_grid(l.radial_next);


    * */
  }

  _runLogUndo(mesh: Mesh, bvh: BVH): void {
    const log = this._undo.log

    if (!log.checkStart(mesh)) {
      log.undo(
        mesh,
        (f: Face): void => {
          if (f.lists[0].length === 3 && f.lists.length === 1) {
            const l = f.lists[0].l
            const tri2 = bvh.addTri(f.eid, bvh._nextTriIdx(), l.v, l.next.v, l.prev.v, undefined, l, l.next, l.prev)
            tri2.flag |= BVHTriFlags.LOOPTRI_INVALID
          } else {
            const ltris = triangulateFace(f) as Loop[]
            for (let i = 0; i < ltris.length; i += 3) {
              const l1 = ltris[i]
              const l2 = ltris[i + 1]
              const l3 = ltris[i + 2]

              const tri2 = bvh.addTri(f.eid, bvh._nextTriIdx(), l1.v, l2.v, l3.v, undefined, l1, l2, l3)
              tri2.flag |= BVHTriFlags.LOOPTRI_INVALID
            }
          }
        },
        (f: Face): void => {
          bvh.removeFace(f.eid)
        }
      )

      log.reset()
      log.start(mesh)
    }
  }

  *doTopologySubdivide(
    mesh: Mesh,
    max: number,
    bvh: BVH,
    esize: number,
    vs: Set<Vertex>,
    es: Set<Edge>,
    radius: number,
    brush: SculptBrush,
    newes_out: Set<Edge>,
    dosmooth: (v: Vertex, number: number) => void,
    cd_curv: number,
    es_out: Set<Edge>[]
  ): Generator<void> {
    es_out[0] = es

    const useSmart = brush.dynTopo.subdivMode === SubdivModes.SMART

    const esize1 = esize
    esize *= this._calcEsizeScale(esize, brush.dynTopo.subdivideFactor)

    let esize2

    if (0) {
      esize2 = this.calcESize2(es.size, radius)
      if (esize2 < esize) {
        esize += (esize2 - esize) * 0.35
      }
    } else {
      esize2 = esize
    }

    //console.log(esize, esize2);

    //esize = esize2;

    const fancyWeights = brush.dynTopo.flag & DynTopoFlags.FANCY_EDGE_WEIGHTS

    const edist0 = fancyWeights ? this.edist_subd : this.edist_simple

    //*
    function edist(e: Edge, v1: Vertex, v2: Vertex, eset?: Set<Edge>, cd_curv?: number): number {
      const dis = v1.co.vectorDistance(v2.co)
      let w = edist0(e, v1, v2, eset, cd_curv!)

      if (e.l?.next.e && e.l.prev.e) {
        const e2 = e.l.next.e
        const e3 = e.l.prev.e

        const dis2 = e2.v1.co.vectorDistance(e2.v2.co)
        const dis3 = e3.v1.co.vectorDistance(e3.v2.co)
        let ratio1 = 0
        let ratio2 = 0

        if (dis2 !== 0.0) {
          ratio1 = dis > dis2 ? dis / dis2 : dis2 / dis
        }
        if (dis3 !== 0.0) {
          ratio2 = dis > dis3 ? dis / dis3 : dis3 / dis
        }

        let ratio: number
        if (dis2 !== 0.0 && dis3 !== 0.0) {
          ratio = Math.max(ratio1, ratio2)
        } else if (dis2 !== 0.0) {
          ratio = ratio1
        } else if (dis3 !== 0.0) {
          ratio = ratio2
        } else {
          return dis * dis
        }

        //ratio = Math.cbrt(ratio);
        w = (Math.sqrt(w) / ratio) ** 2
      }

      return w
    } //*/

    let eset = es

    let es2 = [] as Edge[]
    const es0 = [] as Edge[]

    for (const e of es) {
      es0.push(e)
    }

    const workEs = es0

    const log = this._undo.log

    log.checkStart(mesh)

    const esqr = esize * esize
    let fs = new Set<Face>()
    let max2 = max

    //let rand = Math;
    const rand = this.dynTopoRand

    if (max2 < 10) {
      max2 = 64
    } else {
      max2 *= 8
    }

    const lens = [] as number[]
    const esqr2 = (esize * 0.5) ** 2

    function weight_fancy(e: Edge, lensqr: number): number {
      lensqr += -(e.v1.valence + e.v2.valence)
      //lensqr += countNewSplitEdges(e, eset);

      return lensqr
    }

    function weight_simple(e: Edge, lensqr: number): number {
      return lensqr
    }

    let weight

    if (!fancyWeights) {
      weight = weight_simple
    } else {
      weight = weight_fancy
    }

    for (let e of workEs) {
      const ri = ~~(rand.random() * 0.9999 * workEs.length)
      e = workEs[ri]

      if (es2.length >= max2) {
        break
      }

      if (!e.l) {
        continue
      }

      let lensqr = edist(e, e.v1, e.v2, eset, cd_curv)

      if (lensqr >= esqr) {
        const ok = true

        //if (window.dd1) {
        lensqr = weight(e, lensqr)

        let l = e.l
        let _i = 0
        //let esqr3 = (esize*1.75)**2;

        do {
          fs.add(l.f)

          /*
          for (let l2 of l.f.loops) {
            let dis2 = l2.e.v1.vectorDistanceSqr(l2.e.v2);

            if (dis2 < esqr2) {
              ok = false;
              break;
            }
          }//*/

          l = l.radial_next
        } while (l !== e.l && _i++ < 100)

        if (ok) {
          e.index = es2.length

          es2.push(e)
          lens.push(lensqr)
        }
      }
    }

    if (es2.length === 0) {
      es_out[0] = new Set(workEs)
      return
    }

    es2.sort((a, b) => lens[b.index] - lens[a.index])
    if (es2.length > max) {
      es2 = es2.slice(0, ~~max)
    }

    const ws = [] as number[]
    for (const e of es2) {
      ws.push(-lens[e.index])
    }

    //let heap = new util.MinHeapQueue(es2, ws);

    const es2Set = new Set(es2)

    const flag2 = MeshFlags.TEMP2

    //expand
    if (0) {
      for (const e of es2Set) {
        e.flag &= ~flag2
      }

      for (const e of es2Set) {
        if (e.flag & flag2) {
          continue
        }

        e.flag |= flag2

        for (const l of e.loops) {
          for (const l2 of l.f.loops) {
            l2.e.flag |= flag2
            es2Set.add(l2.e)
          }
        }
      }
    }

    const test = (e: Edge): boolean => {
      const dis = edist(e, e.v1, e.v2, eset, cd_curv)
      return dis >= esqr
    }

    const lctx = new LogContext()
    const cd_node = bvh.cd_node

    const es3 = new Set(workEs)
    const newvs = new Set<Vertex>()
    let newfs = new Set<Face>()
    const killfs = new Set<Face>()
    const newes = new Set<Edge>()

    let updateflag = BVHFlags.UPDATE_UNIQUE_VERTS | BVHFlags.UPDATE_OTHER_VERTS
    updateflag = updateflag | BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_TOTTRI
    updateflag = updateflag | BVHFlags.UPDATE_INDEX_VERTS

    lctx.onkill = (e: Element, tag: number): void => {
      log.logKill(e, tag)

      if (e.type === MeshTypes.FACE) {
        newfs.delete(e)

        const tris = bvh.getFaceTris(e._old_eid)
        if (tris) {
          for (const t of tris) {
            if (t.node) {
              t.node.setUpdateFlag(updateflag)
            }
          }
        }

        bvh.removeFace(e._old_eid)
      } else if (e.type === MeshTypes.VERTEX) {
        newvs.delete(e)
      } else if (e.type === MeshTypes.EDGE) {
        newes.delete(e)
      }
    }

    const cd_cotan = mesh.verts.customData.getLayerIndex('cotan')
    const cd_fset = getFaceSets(mesh, false)

    lctx.onnew = (e: Element, tag: number): void => {
      log.logAdd(e, tag)

      if (cd_curv >= 0 && e.type === MeshTypes.VERTEX) {
        this._checkcurv(e, cd_curv, cd_cotan, true, cd_fset)
      }

      if (e.type === MeshTypes.EDGE) {
        es3.add(e)
        newes.add(e)
      } else if (e.type === MeshTypes.FACE) {
        newfs.add(e)

        for (const l of e.loops) {
          newes.add(l.e)
          es3.add(l.e)

          const node = cd_node.get(l.v).node
          if (node) {
            node.setUpdateFlag(updateflag)
          }
        }
      } else if (e.type === MeshTypes.VERTEX) {
        const node = cd_node.get(e).node
        if (node) {
          node.setUpdateFlag(updateflag)
        }

        newvs.add(e)
      }
    }

    let es4 = es2Set

    const oldnew = lctx.onnew
    const oldkill = lctx.onkill

    let esize3 = esize

    for (let step = 0; step < 4; step++) {
      if (es4.size === 0) {
        break
      }

      const newes2 = new Set<Edge>()

      const flag = MeshFlags.TEMP2

      for (const e of es4) {
        for (const l of e.loops) {
          l.f.flag &= ~flag
        }
      }

      esize3 *= 0.2
      const esqr3 = esize3 * esize3

      lctx.onkill = (e: Element, tag: number): void => {
        oldkill(e, tag)

        if (e.type === MeshTypes.VERTEX) {
          const node = cd_node.get(e).node
          if (node) {
            node.setUpdateFlag(updateflag)
          }
        } else if (e.type === MeshTypes.EDGE) {
          newes2.delete(e)
          newes_out.delete(e)
        } else if (e.type === MeshTypes.FACE) {
          for (const l of e.loops) {
            const node = cd_node.get(l.v).node
            if (node) {
              node.setUpdateFlag(updateflag)
            }

            newes2.delete(l.e)
            newes_out.delete(l.e)
          }
        }
      }

      lctx.onnew = (e: Element, tag: number): void => {
        oldnew(e, tag)

        if (cd_curv >= 0 && e.type === MeshTypes.VERTEX) {
          this._checkcurv(e, cd_curv, cd_cotan, true, cd_fset)
        }

        if (e.type === MeshTypes.EDGE) {
          let ok = newes2.size < max

          const val = e.v1.valence + e.v2.valence
          let ok2 = val > 16

          ok2 = ok2 || edist(e, e.v1, e.v2, eset) >= esqr3
          ok = ok && ok2

          if (ok) {
            newes2.add(e)
          } else {
            newes_out.add(e)
          }
        } else if (e.type === MeshTypes.FACE) {
          for (const l of e.loops) {
            if (edist(l.e, l.e.v1, l.e.v2, undefined, cd_curv) >= esqr) {
              newes2.add(l.e)
            } else {
              newes_out.add(l.e)
            }
          }
        } else if (e.type === MeshTypes.VERTEX) {
          const node = cd_node.get(e).node

          if (node) {
            node.setUpdateFlag(updateflag)
          }
        }
      }

      //set edge set reference used to feed edist_subd
      eset = es4

      //try to avoid 4-valence verts by preventing isolated edge splits
      for (const e of new Set(es4)) {
        if (e.l) {
          es4.add(e.l.next.e)
          es4.add(e.l.prev.e)
        }
      }

      const splitSmoothFac = 0.0

      //pattern based subdivision algo
      if (useSmart) {
        splitEdgesSmart2(mesh, es4, test, lctx, splitSmoothFac)
      } else {
        splitEdgesSimple2(mesh, es4, test, lctx)
      }

      //yield;

      //this.doTopologyValence4(mesh, max, bvh, esize, vs, es, radius, brush, lctx);
      //es = es.filter(e => e.eid >= 0);

      const lens = [] as number[]
      const es5 = [] as Edge[]
      for (let i = 0; i < 2; i++) {
        const list = i ? es4 : newes2

        for (const e of list) {
          if (e.eid < 0) {
            continue
          }

          const dist = edist(e, e.v1, e.v2, undefined, cd_curv)
          const step2 = Math.min(step, 3) * 2
          const limit = esqr * (step2 + 1) * (step2 + 1)

          if (dist >= limit) {
            const lensqr = weight(e, dist)
            lens.push(lensqr)
            es5.push(e)
          }
          //if (dist >= esqr*(step + 1)*(step + 1)) {

          //}
        }
      }

      es5.sort((a, b) => lens[b.index] - lens[a.index])
      es4 = new Set(es5)

      /*es4 = es4.filter(e => {
        return edist(e, e.v1, e.v2, undefined, cd_curv) >= esqr*(step + 1)*(step + 1);
      });//*/

      for (const e of es4) {
        e.flag &= ~flag2
        e.v1.flag &= ~flag2
        e.v2.flag &= ~flag2
      }

      for (const e of es4) {
        if (!(e.v1.flag & flag2)) {
          e.v1.flag |= flag2
          dosmooth(e.v1, 0.25)
        }
        if (!(e.v2.flag & flag2)) {
          e.v2.flag |= flag2
          dosmooth(e.v2, 0.25)
        }
      }
    }

    newfs = newfs.filter((f) => f.eid >= 0)

    for (const e of newes) {
      if (e.eid >= 0) {
        newes_out.add(e)
      }
    }

    for (const v of newvs) {
      for (const e of v.edges) {
        es3.add(e)
      }
    }

    /*
    for (let v of newvs) {
      log.logAddVertex(v);
    }

    for (let e of es2) {
      log.logAddEdge(e);
    }

    for (let e of newes) {
      log.logAddEdge(e);
    }

    for (let f of newfs) {
      if (f.eid < 0) {
        console.warn(f);
        throw new Error("newfs error");
      }

      log.logAddFace(f);
    }*/

    //let newvs = new Set();
    //let newfs = new Set();
    //let killfs = new Set();

    const fs2 = new Set<Face>()

    fs = fs.filter((f) => f.eid >= 0)
    newfs = newfs.filter((f) => f.eid >= 0)

    for (const f of fs) {
      fs2.add(f)
    }

    //console.log("NEW", newvs, newfs, es2, esize);
    //return;
    //let newvs = new Set(), newfs = fs;

    //console.log("new", newvs.size, newes.size, newfs.size, killfs.size);

    //mesh.regenTessellation();

    for (let i = 0; i < 2; i++) {
      const fsiter = i ? fs2 : newfs

      for (const f of fsiter) {
        if (f.eid < 0) {
          console.warn('eek!', f)
          continue
        }

        if (0 && f.lists[0].length > 3) {
          const newfaces = new Set<Face>()
          const newedges = new Set<Edge>()

          //log.logKillFace(f);

          f.calcNormal()
          applyTriangulation(mesh, f, newfaces, newedges, lctx)

          for (const e of newedges) {
            newes_out.add(e)
            //log.logAddEdge(e);
          }

          for (const tri of newfaces) {
            //log.logAddFace(tri);

            tri.calcNormal()
            const l = tri.lists[0].l
            const v1 = l.v
            const v2 = l.next.v
            const v3 = l.prev.v

            const tri2 = bvh.addTri(tri.eid, bvh._nextTriIdx(), v1, v2, v3, undefined, l, l.next, l.prev)
            tri2.flag |= BVHTriFlags.LOOPTRI_INVALID
          }

          continue
        }

        f.calcNormal()

        let l = f.lists[0].l
        const firstl = l
        let _i = 0

        l = l.next

        do {
          const v1 = firstl.v
          const v2 = l.v
          const v3 = l.next.v

          if (isNaN(v1.co.dot(v1.co))) {
            v1.co.zero()
            console.warn('v1 NaN', v1)
          }
          if (isNaN(v2.co.dot(v2.co))) {
            v2.co.zero()
            console.warn('v2 NaN', v2)
          }
          if (isNaN(v3.co.dot(v1.co))) {
            v3.co.zero()
            console.warn('v3 NaN', v3)
          }

          //v1[0] += (Math.random()-0.5)*esize*0.2;
          //v1[1] += (Math.random()-0.5)*esize*0.2;
          //v1[2] += (Math.random()-0.5)*esize*0.2;

          const tri = bvh.addTri(f.eid, bvh._nextTriIdx(), v1, v2, v3, undefined, firstl, l, l.next)
          tri.flag |= BVHTriFlags.LOOPTRI_INVALID

          if (_i++ > 1000) {
            console.error('infinite loop detected!')
            break
          }

          l = l.next
        } while (l !== firstl.prev)
      }
    }

    bvh.update()

    if (0) {
      for (const e of new Set(es3)) {
        if (e.eid < 0) {
          continue
        }

        for (let step = 0; step < 2; step++) {
          const v = step ? e.v2 : e.v1
          for (const e2 of v.edges) {
            es3.add(e2)
          }
        }
      }
    }

    es_out[0] = es3
  }

  _checkOrig(ctx: ViewContext): void {
    const brush = this.inputs.brush.getValue()
    const mesh = ctx.mesh!

    if (PaintOpBase.needOrig(brush)) {
      const cd_orig = this.initOrigData(mesh)

      if (cd_orig !== undefined) {
        const bvh = this.getBVH(mesh)
        bvh.origCoStart(cd_orig.i)
      }
    }
  }

  modalStart(ctx: ViewContext) {
    this._checkOrig(ctx)

    this.lastps1 = this.lastps2 = undefined
    this.dynTopoRand.seed(0)
    this.rand.seed(0)

    this._first2 = 4
    return super.modalStart(ctx)
  }

  modalEnd(was_cancelled: boolean) {
    if (!this.modalRunning) {
      return
    }

    if (this.task) {
      //can't end modal
      console.warn('Waiting for task to finish')
      this.taskNext()

      window.setTimeout(() => {
        this.modalEnd(was_cancelled)
      }, 150)

      return
    }

    const ctx = this.modal_ctx!

    //prevent reference leaks
    this.grabEidMap = undefined
    if (this.smoother) {
      //this.smoother.finish();
      this.smoother = undefined
    }

    const ret = super.modalEnd(was_cancelled)
    return ret
  }

  on_pointerup(): void {
    this.mfinished = true

    const ob = this.modal_ctx!.object
    const mesh = ob ? ob.data : undefined

    this.modal_ctx!.view3d.resetDrawLines()
    this.modalEnd(false)

    //auto-rebuild bvh if topology changed?
    //if (mesh instanceof Mesh) {
    //mesh.getBVH({autoUpdate: true});
    //}
  }
}

ToolOp.register(PaintOp)
