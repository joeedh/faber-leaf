import {BrushProperty, PaintSampleProperty} from './stroke_base.js'
import type {BVHToolMode} from './pbvh'
import * as util from '../../../util/util.js'
import {
  BoolProperty,
  FlagProperty,
  Matrix4,
  ToolOp,
  Vector2,
  Vector3,
  Vector4,
  math,
  Mat4Property,
  Vec2Property,
  IVectorOrHigher,
  Number3,
} from '../../../path.ux/scripts/pathux.js'
import {BVH, BVHFlags, BVHTri, IsectRet} from '../../../../addons/builtin/mesh/src/bvh.js'
import {GridBase} from '../../../../addons/builtin/mesh/src/mesh_grids'
import {ImageBlock, ImageTypes} from '../../../image/image.js'
import {FBO} from '../../../webgl/index'
import {LayerTypes, PrimitiveTypes, SimpleMesh} from '../../../webgl/simplemesh'
import {ShaderDef} from '../../../shaders/shaders.js'
import {Texture, getShader, ShaderProgram} from '../../../webgl/webgl'
import {project} from '../view3d_utils.js'
import {SculptBrush} from '../../../brush/brush'
import {ProceduralTex} from '../../../texture/proceduralTex'
import {BrushBlurFBO} from './pbvh_texpaint_blur'

const _id: number = 0

import {GPUTile, tileManager, UNDO_TILESIZE} from '../../../image/gpuimage.js'
import type {ToolContext, ViewContext} from '../../../core/context'
import type {SceneObject} from '../../../sceneobject/sceneobject'
import type {View3D} from '../view3d'
import {Loop, Mesh, UVLayerElem} from '../../../../addons/builtin/mesh/src/mesh'
import {AttrRef, ColorLayerElem} from '../../../../addons/builtin/mesh/src/mesh_customdata'
import {getUVWrangler} from '../../../../addons/builtin/mesh/src/unwrapping'
import {PaintSample} from './stroke_base.js'

declare global {
  let DDD: number
  let DD5: number
  let DD6: number

  interface Window {
    DDD: number
    DD5: number
    DD6: number
  }
}

export class TexPaintOp extends ToolOp<
  {
    //
    rendermat: Mat4Property
    samples: PaintSampleProperty
    brush: BrushProperty
    glSize: Vec2Property
    viewSize: Vec2Property
    symmetryAxes: FlagProperty
    doBlur: BoolProperty
  },
  {},
  ToolContext,
  ViewContext
> {
  blurfbo: BrushBlurFBO | undefined
  first: boolean
  start_mpos: Vector3
  last_p: Vector4
  last_radius: number | undefined
  last_mpos: Vector3
  mpos: Vector3
  _tiles: GPUTile[] = []
  _tilemap: {[key: number]: GPUTile} = {}

  constructor() {
    super()

    this.blurfbo = undefined

    this.first = true
    this.start_mpos = new Vector3()
    this.last_p = new Vector4()
    this.last_radius = undefined
    this.last_mpos = new Vector3()
    this.mpos = new Vector3()
  }

  static tooldef() {
    return {
      uiname  : 'Paint Stroke (Texture)',
      toolpath: 'bvh.texpaint',
      inputs: {
        brush       : new BrushProperty(),
        samples     : new PaintSampleProperty(),
        rendermat   : new Mat4Property(),
        glSize      : new Vec2Property(),
        viewSize    : new Vec2Property(),
        symmetryAxes: new FlagProperty(undefined, {X: 1, Y: 2, Z: 4}),
        doBlur      : new BoolProperty(),
      },

      is_modal: true,
    }
  }

  getShader(gl: WebGL2RenderingContext, brush: SculptBrush): ShaderProgram {
    const sdef = Object.assign({}, ShaderDef.TexturePaintShader)

    const uniforms: Record<string, unknown> = {
      angle: 0.0,
    }

    if (brush.texUser.texture) {
      let pre: string = '\n' //#define BRUSH_TEX\n';

      const tex: ProceduralTex = brush.texUser.texture
      pre += tex.genGlslPre('inP', 'outC', uniforms)

      let code: string = tex.genGlsl('inP', 'outC', uniforms)

      //put code in new block scope
      code = `{\n${code}\n}\n`

      //console.error("CODE", code);

      let frag: string = sdef.fragment
      frag = frag.replace(/\/\/\{BRUSH_TEX_PRE\}/, pre)
      frag = frag.replace(/BRUSH_TEX_CODE/, code)
      sdef.fragment = frag.trim() + '\n'

      //console.log(sdef.fragment);
    }

    const shader = getShader(gl, sdef)

    //console.error("SHADER", shader);

    return shader
  }

  on_keydown(e: KeyboardEvent): void {
    //super.on_keydown(e)
  }

  on_mousemove(e: PointerEvent): void {
    const ctx = this.modal_ctx!
    const view3d = ctx.view3d
    const mesh = ctx.mesh

    if (!mesh || !view3d) {
      return
    }

    const mpos: Vector2 = view3d.getLocalMouse(e.x, e.y)
    const x: number = mpos[0]
    const y: number = mpos[1]

    this.mpos.load2(mpos)
    this.mpos[2] = 0.0

    const toolmode = ctx.toolmode as BVHToolMode

    //the bvh toolmode is responsible for drawing brush circle,
    //make sure it has up to date info for that
    toolmode.mpos[0] = e.x
    toolmode.mpos[1] = e.y

    const bvh: BVH = mesh.getBVH({autoUpdate: false})
    //log("sample!");

    const axes: number[] = [-1]
    const sym: number = mesh.symFlag

    for (let i = 0; i < 3; i++) {
      if (mesh.symFlag & (1 << i)) {
        axes.push(i)
      }
    }

    const view = new Vector3(view3d.getViewVec(x, y))
    const origin = new Vector3(view3d.activeCamera.pos)

    const cam = view3d.activeCamera
    const rendermat = cam.rendermat

    this.inputs.rendermat.setValue(cam.rendermat)
    this.inputs.glSize.setValue(view3d.glSize)
    this.inputs.viewSize.setValue(view3d.size)

    const ob = ctx.object!

    let isect: IsectRet | undefined
    //isect = bvh.castRay(origin, view);

    for (const axis of axes as (-1 | Number3)[]) {
      let origin2 = new Vector4(origin as unknown as Vector4)
      let view2 = new Vector4(view as unknown as Vector4)

      if (axis !== -1) {
        const obmat = ob.outputs.matrix.getValue()
        const mat = new Matrix4(ob.outputs.matrix.getValue())
        mat.invert()

        origin2 = new Vector4(origin as unknown as Vector4)
        origin2[3] = 1.0

        view2 = new Vector4(view as unknown as Vector4)
        view2[3] = 0.0

        origin2.multVecMatrix(mat)
        origin2[axis] = -origin2[axis]

        view2.multVecMatrix(mat)
        view2[axis] = -view2[axis]

        origin2[3] = 1.0
        view2[3] = 0.0

        origin2.multVecMatrix(obmat)
        view2.multVecMatrix(obmat)
        view2.normalize()
        //log(origin2, view2);
      }

      const isect2 = bvh.castRay(origin2, view2)

      //log(isect2);

      if (isect2 && (!isect || isect2.dist < isect.dist)) {
        isect = isect2.copy()
        origin.load(origin2)
        view.load(view2)
      }
    }

    if (!isect) {
      return
    }

    toolmode.debugSphere.load(isect.p)

    if (this.first) {
      this.first = false
      this.mpos.load2(mpos)
      this.start_mpos.load2(mpos)
      this.last_mpos.load2(mpos)
      this.last_p.load2(isect.p)
      return
    }

    const brush: SculptBrush = this.inputs.brush.getValue()
    const sradius: number = brush.radius
    let radius: number = sradius

    toolmode._radius = radius

    //log("isect:", isect);

    const color: Vector4 = e.ctrlKey ? brush.bgcolor : brush.color

    const p4: Vector4 = new Vector4().load3(isect.p)
    p4[3] = 1.0

    p4.multVecMatrix(rendermat)
    const w: number = p4[3]

    if (w < 0.0) {
      return
    }

    radius /= Math.max(view3d.glSize[0], view3d.glSize[1])
    radius *= Math.abs(w)

    const doBlur: boolean = this.inputs.doBlur.getValue()
    if (doBlur) {
      if (!this.blurfbo) {
        this.blurfbo = new BrushBlurFBO()
      }

      const sradius2: number = Math.max(~~(sradius * window.devicePixelRatio), 4)
      this.blurfbo.update(view3d.gl, sradius2)

      this.blurfbo.draw(view3d.gl, this.mpos, ob, view3d, bvh, isect.p, sradius2, radius)
    }

    const spacing: number = this.inputs.brush.getValue().spacing
    let steps: number = isect.p.vectorDistance(this.last_p) / (radius * spacing)
    //log("steps", steps);

    if (steps < 1) {
      return
    }
    steps = Math.max(Math.ceil(steps), 1)

    p4.load2(isect.p)
    p4[3] = w

    const dx: number = this.mpos[0] - this.last_mpos[0]
    const dy: number = this.mpos[1] - this.last_mpos[1]

    const th: number = Math.atan2(dy, dx)

    const list: PaintSample[] = this.inputs.samples.getValue()
    let lastw: number

    if (list.length > 0) {
      lastw = list[list.length - 1].w
    } else {
      lastw = w
    }

    const interpTmp = new Vector4()

    for (let i = 0; i < steps; i++) {
      const t: number = i / (steps - 1)

      const ps = new PaintSample()

      ps.w = w + (lastw - w) * t

      ps.viewvec.load(view)
      ps.vieworigin.load(origin)

      ps.strength = brush.strength
      ps.color.load(color)
      ps.angle = th

      ps.p.load(this.last_p).interp(interpTmp.load3(isect.p), t)

      ps.mpos = new Vector2().loadXY(this.last_mpos[0], this.last_mpos[1]).interp(this.mpos, t)
      ps.radius = radius

      this.inputs.samples.push(ps)

      this.execDot(ctx, ps)
    }

    this.last_mpos.load2(mpos)
    this.last_p.load2(isect.p)
    this.last_p[3] = w

    window.redraw_viewport()
  }

  exec(ctx: ViewContext): void {
    const mesh = ctx.mesh

    if (!mesh) {
      return
    }

    const cd_uv: number = mesh.loops.customData.getLayerIndex('uv')
    if (cd_uv < 0) {
      return
    }

    //check that UV island mesh is up to date
    getUVWrangler(mesh, true, true)

    for (const ps of this.inputs.samples) {
      this.execDot(ctx, ps)
    }
  }

  execDot(ctx: ViewContext, ps: PaintSample): void {
    const gl: WebGL2RenderingContext = _gl!

    function log(...args: any[]): void {
      //console.log(...arguments)
    }

    if (!ctx.mesh || !ctx.activeTexture) {
      return
    }

    const texture = ctx.activeTexture

    if (!texture.ready) {
      return
    }

    if (texture.type !== ImageTypes.FLOAT_BUFFER) {
      // || texture.type !== ImageTypes.BYTE_BUFFER) {
      if (texture.glTex) {
        texture.glTex.destroy(gl)
        texture.glTex = undefined
      }
      if (texture._drawFBO) {
        texture._drawFBO.destroy()
        texture._drawFBO = undefined
      }

      texture.convertTypeTo(ImageTypes.FLOAT_BUFFER)
      texture.update()
    }

    if (!texture.ready) {
      return
    }

    let fbo: FBO

    texture.getDrawFBO(gl)

    const co: Vector3 = new Vector3(ps.p)
    const w: number = ps.p[3]
    const radius: number = ps.radius
    const strength: number = ps.strength

    const mesh: Mesh = ctx.mesh
    const bvh: BVH = mesh.getBVH({autoUpdate: false})

    fbo = texture._drawFBO!

    const wrangler = getUVWrangler(mesh, false, false)!
    //console.log(wrangler);

    const gltex = texture.getGlTex(gl)
    texture.gpuHasData = true

    const cd_grid: number = GridBase.meshGridOffset(mesh)
    const haveGrids: boolean = cd_grid >= 0

    const cd_uv = mesh.loops.customData.getLayerRef<UVLayerElem>('uv')
    if (cd_uv.i < 0) {
      console.error('no uvs')
      return
    }

    let cd_color: AttrRef<ColorLayerElem>
    if (haveGrids) {
      cd_color = mesh.loops.customData.getLayerRef('color')
    } else {
      cd_color = mesh.verts.customData.getLayerRef('color')
    }

    const haveColor: boolean = cd_color.i >= 0
    const tsSet: Set<BVHTri> = bvh.closestTris(co, radius)
    const avgno: Vector3 = new Vector3()

    let ts = [...tsSet].filter((t: BVHTri) => {
      t.no.load(math.normal_tri(t.v1.co, t.v2.co, t.v3.co))

      const area: number = (t.area = math.tri_area(t.v1.co, t.v2.co, t.v3.co))
      avgno.addFac(t.no, area)

      const dot: number = t.no.dot(ps.viewvec)
      //log("DOT", dot, ps.viewvec, t.no);
      return dot <= 0.0
    })

    avgno.normalize()

    if (ts.length === 0) {
      return
    }

    // */

    const rendermat: Matrix4 = this.inputs.rendermat.getValue() //view3d.activeCamera.rendermat;
    const glSize: Vector2 = this.inputs.glSize.getValue()
    const viewSize: Vector2 = this.inputs.viewSize.getValue()

    const brush: SculptBrush = this.inputs.brush.getValue()
    const brushco: Vector3 = new Vector3(ps.p)

    brushco.load2(ps.mpos)
    brushco[2] = 0.0

    const uvring = util.cachering.fromConstructor(Vector3, 64)

    let radius2: number = brush.radius
    radius2 *= 0.5

    //radius2 = radius;

    const line_sm = new SimpleMesh(LayerTypes.LOC | LayerTypes.UV | LayerTypes.CUSTOM) // | LayerTypes.COLOR | LayerTypes.NORMAL);
    line_sm.primflag = PrimitiveTypes.LINES
    line_sm.island.primflag = PrimitiveTypes.LINES

    const sm = new SimpleMesh(LayerTypes.LOC | LayerTypes.UV | LayerTypes.CUSTOM) // | LayerTypes.COLOR | LayerTypes.NORMAL);

    //screen position
    const sm_loc: number = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'sm_loc').index!

    const sm_worldloc: number = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 3, 'sm_worldloc').index!

    const sm_params: number = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 2, 'sm_params').index!

    const sm_line_loc: number = line_sm.addDataLayer(PrimitiveTypes.LINES, LayerTypes.CUSTOM, 4, 'sm_loc').index!
    const sm_line_worldloc: number = line_sm.addDataLayer(
      PrimitiveTypes.LINES,
      LayerTypes.CUSTOM,
      4,
      'sm_worldloc'
    ).index!
    const sm_line_params: number = line_sm.addDataLayer(PrimitiveTypes.LINES, LayerTypes.CUSTOM, 2, 'sm_params').index!

    const ltris = mesh._ltris!
    const uv1 = new Vector3()
    const uv2 = new Vector3()
    const uv3 = new Vector3()

    const size = new Vector2().loadXY(texture.width, texture.height)
    const sizem1 = new Vector2().loadXY(texture.width - 1, texture.height - 1)
    const isize = new Vector2().addScalar(1.0).div(size)
    const isizem1 = new Vector2().addScalar(1.0).div(sizem1)

    const params: Vector4[] = [new Vector4(), new Vector4(), new Vector4()]

    const centuv = new Vector2()
    const cd_corner = wrangler.cd_corner

    function getisland(l: Loop) {
      return wrangler.islandLoopMap.get(l)
    }

    function getcorner(l: Loop) {
      const ret2 = wrangler.loopMap.get(l)

      if (ret2) {
        return ret2.customData.get(cd_corner).corner
      } else {
        return false
      }
    }

    function processuv(uv: IVectorOrHigher<2, Vector2>, cent: IVectorOrHigher<2, Vector2>, corner: boolean): void {
      //corner = false;
      let d: number = -0.001
      //let fac = corner ? 3.5 : 0.0;

      d = 0.0

      //duv.load(uv).sub(cent).normalize();

      if (!window.DD5) {
        window.DD5 = 0.5
      }

      d += DD5

      uv.mul(size)
      uv.addScalar(d).floor().mul(isize)
    }

    const umin = new Vector2().addScalar(1e17)
    const umax = new Vector2().addScalar(-1e17)
    const utmp = new Vector2()
    const triuv2 = new Vector2()

    const ue1 = new Vector3()
    const ue2 = new Vector3()
    const ue3 = new Vector3()
    const uetmp = new Vector3()
    const tmp2 = new Vector3()

    const radiusx: number = brush.radius / (texture.width - 1)
    const radiusy: number = brush.radius / (texture.height - 1)
    const pradius = new Vector2().loadXY(radiusx, radiusy)

    for (const tri of ts) {
      let cr1: boolean | undefined
      let cr2: boolean | undefined
      let cr3: boolean | undefined
      let l1: Loop | undefined
      let l2: Loop | undefined
      let l3: Loop | undefined

      if (haveGrids) {
        uv1.load2(tri.v1.customData.get(cd_uv).uv)
        uv2.load2(tri.v2.customData.get(cd_uv).uv)
        uv3.load2(tri.v3.customData.get(cd_uv).uv)
        cr1 = cr2 = cr3 = false
      } else {
        const li: number = tri.tri_idx
        l1 = ltris[li]
        l2 = ltris[li + 1]
        l3 = ltris[li + 2]

        if (!l1 || !l2 || !l3) {
          continue
        }

        cr1 = getcorner(l1)
        cr2 = getcorner(l2)
        cr3 = getcorner(l3)

        uv1.load2(l1.customData.get(cd_uv).uv)
        uv2.load2(l2.customData.get(cd_uv).uv)
        uv3.load2(l3.customData.get(cd_uv).uv)
      }

      centuv
        .load(uv1)
        .add(uv2)
        .add(uv3)
        .mulScalar(1.0 / 3.0)

      processuv(uv1, centuv, cr1! && cr2!)
      processuv(uv2, centuv, cr2! && cr3!)
      processuv(uv3, centuv, cr3! && cr1!)

      ue1.loadXY(-(uv1[1] - uv2[1]), uv1[0] - uv2[0])
      ue2.loadXY(-(uv2[1] - uv3[1]), uv2[0] - uv3[0])
      ue3.loadXY(-(uv3[1] - uv1[1]), uv3[0] - uv1[0])

      uetmp.load(uv1).sub(tmp2.load2(centuv))
      if (ue1.dot(uetmp) < 0.0) {
        ue1.negate()
        ue2.negate()
        ue3.negate()
      }

      if (!window.DD6) {
        window.DD6 = 0.0
      }

      const efac: number = isizem1[0] * DD6

      ue1.normalize().mulScalar(efac)
      ue2.normalize().mulScalar(efac)
      ue3.normalize().mulScalar(efac)

      uv1.add(ue1)
      uv1.add(ue3)

      uv2.add(ue2)
      uv2.add(ue1)

      uv3.add(ue3)
      uv3.add(ue2)

      const p1 = new Vector4().load3(tri.v1.co)
      const p2 = new Vector4().load3(tri.v2.co)
      const p3 = new Vector4().load3(tri.v3.co)

      p1[3] = p2[3] = p3[3] = 1.0

      project(p1, rendermat, viewSize)
      project(p2, rendermat, viewSize)
      project(p3, rendermat, viewSize)

      let triuv: Vector2

      //if (0) {
      //  const [axis1, axis2] = math.calc_projection_axes(tri.no)
      //  triuv = math.barycentric_v2(ps.p, tri.v1.co, tri.v2.co, tri.v3.co, axis1, axis2)
      //} else {
      triuv = math.barycentric_v2(brushco, p1, p2, p3, 0, 1) as Vector2
      //}

      triuv.minScalar(1.0)
      triuv.maxScalar(0.0)

      const w2: number = triuv[0] * p1[3] + triuv[1] * p2[3] + (1.0 - triuv[0] - triuv[1]) * p3[3]
      //w2 = w0;

      let rx: number
      let ry: number

      //rx = w2 / (texture.width - 1) //*(glSize[1]/texture.width);
      //ry = w2 / (texture.height - 1) //*(glSize[1]/texture.height);

      rx = w2 / (glSize[1] - 1)
      ry = w2 / (glSize[1] - 1)

      rx *= 6.0
      ry *= 6.0

      //rx *= 2;
      //ry *= 2;

      log('RADIUS', (rx * texture.width).toFixed(4), (ry * texture.height).toFixed(4))
      //console.log("TRIUV", triuv);

      triuv2.zero()

      triuv2.addFac(uv1, triuv[0])
      triuv2.addFac(uv2, triuv[1])
      triuv2.addFac(uv3, 1.0 - triuv[0] - triuv[1])

      umin.min(triuv2)
      umax.max(triuv2)

      //rx = 0.0;
      //ry = 0.0;

      utmp.loadXY(rx, ry).add(triuv2)
      umin.min(utmp)
      umax.max(utmp)

      utmp.loadXY(rx, ry).negate().add(triuv2)
      umin.min(utmp)
      umax.max(utmp)

      uv1.mulScalar(2.0).subScalar(1.0)
      uv2.mulScalar(2.0).subScalar(1.0)
      uv3.mulScalar(2.0).subScalar(1.0)

      uv1[2] = uv2[2] = uv3[2] = 0.0

      const tri2 = sm.tri(uv1, uv2, uv3)
      const fade: number = Math.abs(tri.no.dot(ps.viewvec))

      tri2.custom(sm_loc, p1, p2, p3)
      tri2.custom(sm_worldloc, tri.v1.co, tri.v2.co, tri.v3.co)

      const pw: number = 3.0
      params[0][0] = Math.abs(tri.v1.no.dot(ps.viewvec)) ** pw
      params[1][0] = Math.abs(tri.v2.no.dot(ps.viewvec)) ** pw
      params[2][0] = Math.abs(tri.v3.no.dot(ps.viewvec)) ** pw

      if (l1 === undefined || l2 === undefined || l3 === undefined) {
        throw new Error('tex painting error')
      }

      tri2.custom(sm_params, params[0], params[1], params[2])

      const uvstmp = [uv1, uv2, uv3]
      const pstmp = [p1, p2, p3]
      const crs = [cr1, cr2, cr3]
      const ls = [l1, l2, l3]
      const vstmp = [tri.v1, tri.v2, tri.v3]

      const uvmul = uvring.next()

      uvmul[0] = 1.0 / (texture.width - 1)
      uvmul[1] = 1.0 / (texture.height - 1)

      if (window.DDD === undefined) {
        window.DDD = 3.0
      }

      /* draw seam guard border */
      for (let j = 0; j < 3; j++) {
        if (ls[j].next === ls[(j + 1) % 3] && wrangler.seamEdge(ls[j].e)) {
          //for (let k=0; k<1; k++) {
          const uva = uvring.next().load(uvstmp[j])
          const uvb = uvring.next().load(uvstmp[(j + 1) % 3])
          uva[2] = uvb[2] = 0.0

          const c1 = wrangler.loopMap.get(ls[j])!.customData.get(cd_corner)
          const c2 = wrangler.loopMap.get(ls[(j + 1) % 3])!.customData.get(cd_corner)

          const t1 = uvring.next().load(c1.bTangent).mul(uvmul)
          const t2 = uvring.next().load(c2.bTangent).mul(uvmul)
          t1[2] = t2[2] = 0.0

          //uva.addFac(t1, 0.5);
          //uvb.addFac(t2, 0.5);

          const uvc = uvring.next().load(uva)
          const uvd = uvring.next().load(uvb)

          uvc.addFac(t1, DDD)
          uvd.addFac(t2, DDD)

          const quad = sm.quad(uva, uvc, uvd, uvb)
          quad.custom(sm_loc, pstmp[j], pstmp[j], pstmp[(j + 1) % 3], pstmp[(j + 1) % 3])
          quad.custom(sm_worldloc, vstmp[j].co, vstmp[j].co, vstmp[(j + 1) % 3].co, vstmp[(j + 1) % 3].co)
          quad.custom(sm_params, params[j], params[j], params[(j + 1) % 3], params[(j + 1) % 3])

          //let line = line_sm.line(uva, uvb);
          //line.custom(sm_line_loc, pstmp[j], pstmp[(j + 1)%3]);
          //line.custom(sm_line_params, params[j], params[(j + 1)%3]);
          //}
        }
      }
      //tri2.normals(tri.v1.no, tri.v2.no, tri.v3.no);
    }

    //umin.sub(pradius);
    //umax.add(pradius);

    let margin: number | Vector2 = 8
    margin = new Vector2().loadXY(margin / (texture.width - 1), margin / (texture.height - 1))

    umin.sub(margin)
    umax.add(margin)

    const usize: Vector2 = new Vector2(umax).sub(umin)
    const tsize: Vector2 = new Vector2(usize).addScalar(0.0001).mul(sizem1).ceil()
    tsize.max(new Vector2().loadXY(4, 4))

    size[0] = texture.width
    size[1] = texture.height

    umin.addScalar(0.00001).mul(sizem1).floor()
    umax.addScalar(0.00001).mul(sizem1).ceil()

    log(umin, umax)

    const saveUndoTile_intern = (tx: number, ty: number): GPUTile => {
      const smin: Vector2 = new Vector2([tx * UNDO_TILESIZE, ty * UNDO_TILESIZE])
      smin[0] /= texture.width
      smin[1] /= texture.height

      const smax: Vector2 = new Vector2([(tx + 1) * UNDO_TILESIZE, (ty + 1) * UNDO_TILESIZE])
      smax[0] /= texture.width
      smax[1] /= texture.height

      const ssize: Vector2 = new Vector2([UNDO_TILESIZE, UNDO_TILESIZE])

      //let gldebug = getFBODebug(gl);
      const tile: GPUTile = tileManager.alloc(gl)

      const savetile: FBO = tile.fbo //new FBO(gl, ssize[0], ssize[1]);
      savetile.update(gl, ssize[0], ssize[1])

      const sm = new SimpleMesh(LayerTypes.LOC | LayerTypes.UV)
      sm.primflag = PrimitiveTypes.TRIS
      sm.island.primflag = PrimitiveTypes.TRIS

      const quad = sm.quad(
        new Vector3([-1, -1, 0]),
        new Vector3([-1, 1, 0]),
        new Vector3([1, 1, 0]),
        new Vector3([1, -1, 0])
      )

      Texture.unbindAllTextures(gl)

      quad.uvs(
        new Vector2([smin[0], smin[1]]),
        new Vector2([smin[0], smax[1]]),
        new Vector2([smax[0], smax[1]]),
        new Vector2([smax[0], smin[1]])
      )

      sm.program = fbo.getBlitShader(gl)
      sm.uniforms.rgba = texture.glTex
      sm.uniforms.valueScale = 1.0

      gl.disable(gl.DEPTH_TEST)
      gl.disable(gl.CULL_FACE)
      gl.disable(gl.BLEND)
      gl.disable(gl.SCISSOR_TEST)

      gl.depthMask(false)

      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

      savetile.bind(gl)

      sm.draw(gl, sm.uniforms, sm.program)

      gl.finish()

      const rowsize: number = Math.ceil(texture.width / UNDO_TILESIZE)
      const id: number = ty * rowsize + tx

      //gldebug.saveDrawBuffer("undotile:" + id); //"buf:" + (_id++));

      gl.finish()
      savetile.unbind(gl)

      tile.x = tx * UNDO_TILESIZE
      tile.y = ty * UNDO_TILESIZE
      tile.u = (tx * UNDO_TILESIZE) / texture.width
      tile.v = (ty * UNDO_TILESIZE) / texture.height

      sm.destroy(gl)

      return tile
    }

    const saveUndoTile = (smin: Vector2, smax: Vector2): void => {
      smin[0] = Math.min(Math.max(smin[0], 0), texture.width - 1)
      smin[1] = Math.min(Math.max(smin[1], 0), texture.height - 1)

      smax[0] = Math.min(Math.max(smax[0], 0), texture.width)
      smax[1] = Math.min(Math.max(smax[1], 0), texture.height)

      smin.mulScalar(1.0 / UNDO_TILESIZE).floor()
      smax.mulScalar(1.0 / UNDO_TILESIZE).ceil()

      smax[0] = Math.max(smax[0], smin[0] + 1)
      smax[1] = Math.max(smax[1], smin[1] + 1)

      const rowsize: number = Math.ceil(texture.width / UNDO_TILESIZE)

      //console.log(smin, smax);

      for (let iy: number = smin[1]; iy < smax[1]; iy++) {
        for (let ix: number = smin[0]; ix < smax[0]; ix++) {
          const idx: number = iy * rowsize + ix
          if (!(idx in this._tilemap)) {
            const t: GPUTile = saveUndoTile_intern(ix, iy)

            this._tilemap[idx] = t
            this._tiles.push(t)
          }
        }
      }
    }

    if (1) {
      const smin: Vector2 = new Vector2(umin)
      const smax: Vector2 = new Vector2(umax)
      if (!(fbo as FBO & {__first?: boolean}).__first) {
        smin.zero()
        smax[0] = texture.width
        smax[1] = texture.height
      }

      saveUndoTile(smin, smax)
      Texture.unbindAllTextures(gl)

      fbo.update(gl, texture.width, texture.height)
      fbo.bind(gl)

      gl.depthMask(false)
      gl.disable(gl.DEPTH_TEST)

      if (!(fbo as FBO & {__first?: boolean}).__first) {
        gl.disable(gl.SCISSOR_TEST)
        ;(fbo as FBO & {__first?: boolean}).__first = true
      } else {
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(umin[0], umin[1], umax[0] - umin[0], umax[1] - umin[1])
      }

      gl.clearColor(0.5, 0.5, 0.5, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)

      gl.disable(gl.DEPTH_TEST)
      gl.depthMask(false)

      fbo.drawQuad(gl, texture.width, texture.height, texture.glTex, undefined)
      gl.disable(gl.DEPTH_TEST)

      //console.log(texture, texture.glTex, fbo.smesh);

      const color: Vector4 = new Vector4(ps.color)
      color[3] *= strength

      const matrix: Matrix4 = new Matrix4()

      const uniforms: Record<string, unknown> = {
        size            : [texture.width, texture.height],
        aspect          : texture.width / texture.height,
        projectionMatrix: matrix,
        objectMatrix    : new Matrix4(),
        uColor          : color,
        brushCo         : brushco,
        radius          : radius2,
        brushAngle      : ps.angle,
      }

      if (brush.texUser.texture) {
        brush.texUser.texture.bindUniforms(uniforms)
      }

      gl.depthMask(false)

      sm.program = this.getShader(gl, brush)
      //sm.program = Shaders.TexturePaintShader;
      sm.uniforms = uniforms

      if (this.blurfbo) {
        Texture.unbindAllTextures(gl)

        console.error('BLUR')

        sm.program.defines.BLUR_MODE = null
        texture.glTex!.textureSlot = undefined
        this.blurfbo.fbo.texColor!.textureSlot = undefined

        uniforms.rgba1 = texture.glTex
        uniforms.blurFBO = this.blurfbo.fbo.texColor
        uniforms.vboxMin = this.blurfbo.vboxMin
        uniforms.vboxMax = this.blurfbo.vboxMax
        uniforms.screenSize = glSize
      } else if ('BLUR_MODE' in sm.program.defines) {
        delete sm.program.defines['BLUR_MODE']
      }

      gl.enable(gl.BLEND)
      gl.blendColor(1.0, 1.0, 1.0, 1.0)
      //gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.CONSTANT_ALPHA)

      if (brush.texUser.texture) {
        sm.program.defines.BRUSH_TEX = null
        sm.program.defines.BRUSH_TEX_SPACE = brush.texUser.mode
        brush.texUser.texture.bindUniforms(uniforms)
      } else {
        delete sm.program.defines.BRUSH_TEX
      }

      sm.program.bind(gl, uniforms, sm.islands[0]._glAttrs)

      sm.draw(gl, uniforms, sm.program) //Shaders.TexturePaintShader);
      line_sm.draw(gl, uniforms, sm.program)

      delete sm.program.defines.BRUSH_TEX

      gl.readBuffer(gl.COLOR_ATTACHMENT0)
      gl.finish()

      /*if (0) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, gltex!.texture!)

        gl.readBuffer(gl.COLOR_ATTACHMENT0)
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, texture.width, texture.height)
      */

      fbo.unbind(gl)

      texture.swapWithFBO(gl)
    }

    if (haveColor && 0) {
      const ts2: BVHTri[] = []

      for (const t of ts) {
        const c1 = t.v1.customData.get(cd_color).color
        const c2 = t.v2.customData.get(cd_color).color
        const c3 = t.v3.customData.get(cd_color).color

        c1.zero().addScalar(1.0)
        c2.zero().addScalar(1.0)
        c3.zero().addScalar(1.0)

        ts2.push(t)
      }
      ts = ts2

      for (const v of mesh.verts) {
        const c = v.customData.get(cd_color).color
        c.zero().addScalar(1.0)
      }

      for (let i1 = 0; i1 < ts.length; i1++) {
        const ri = ~~(Math.random() * 0.99999 * ts.length)
        const t = ts[ri]

        //for (let t of ts) {
        const c1 = t.v1.customData.get(cd_color).color
        const c2 = t.v2.customData.get(cd_color).color
        const c3 = t.v3.customData.get(cd_color).color

        t.no.load(math.normal_tri(t.v1.co, t.v2.co, t.v3.co))

        const dis = math.dist_to_tri_v3(ps.p, t.v1.co, t.v2.co, t.v3.co, t.no)

        //dis = Math.sqrt(Math.abs(dis));

        //let t1 = new Vector3(ps.p).sub(t.v1);
        //dis = (Math.abs(t1.dot(t.no)));

        const dis2: number = (dis / radius) * 0.5

        c1[0] = Math.min(c1[0], dis2)
        c2[0] = Math.min(c2[0], dis2)
        c3[0] = Math.min(c3[0], dis2)

        for (let i = 1; i < 3; i++) {
          c1[i as 1 | 2 | 3] = c2[i as 1 | 2 | 3] = c3[i as 1 | 2 | 3] = 0.2
        }

        if (t.node) {
          t.node.flag |= BVHFlags.UPDATE_DRAW
          //bvh.updateNodes.add(t.node);
        }
      }
    }

    sm.destroy(gl)

    //bvh.update();
    window.redraw_viewport(true)
    //console.log(vs);
  }

  modalStart(ctx: ViewContext) {
    this.first = true

    const mesh = ctx.mesh
    if (mesh) {
      //check that UV island mesh is up to date
      getUVWrangler(mesh, true, true)
    }

    return super.modalStart(ctx)
  }

  undoPre(ctx: ViewContext): void {
    this._tiles = []
    this._tilemap = {}

    console.warn('undoPre: implement me!')
  }

  undo(ctx: ViewContext): void {
    console.warn('undo: implement me!')

    if (!ctx.mesh || !ctx.activeTexture) {
      return
    }

    const texture: ImageBlock = ctx.activeTexture

    //check texture is in proper float buffer state
    if (texture.type !== ImageTypes.FLOAT_BUFFER) {
      texture.convertTypeTo(ImageTypes.FLOAT_BUFFER)
      texture.update()
    }

    if (!texture.ready || !texture.glTex) {
      if (texture.ready) {
        texture.getGlTex(ctx.gl)
      }

      //hrm, should be a rare case
      if (this._tiles.length > 0) {
        console.warn('Texture race condition?')
        const time: number = util.time_ms()

        //try again
        window.setTimeout(() => {
          //is texture still not ready after 5 seconds?
          if (util.time_ms() - time > 5000) {
            console.warn('Undo timeout')
            return
          }

          this.undo(ctx)
        }, 10)

        return
      }
      return
    }

    const gl: WebGL2RenderingContext = ctx.gl

    const dbuf = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    const rbuf = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null

    const fbo: FBO = texture.getDrawFBO(gl)

    fbo.bind(gl)

    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.BLEND)
    gl.disable(gl.DITHER)

    fbo.drawQuad(gl, texture.width, texture.height, texture.glTex, undefined)
    fbo.unbind(gl)

    for (const tile of this._tiles) {
      const tilefbo: FBO = tile.fbo

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tilefbo.fbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo.fbo)

      let w: number = tile.width
      let h: number = tile.height

      w = Math.max(w + tile.x, texture.width - 1) - tile.x
      h = Math.max(h + tile.y, texture.height - 1) - tile.y

      gl.blitFramebuffer(0, 0, w, h, tile.x, tile.y, tile.x + w, tile.y + h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, dbuf)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rbuf)

    gl.enable(gl.DITHER)
    ;(fbo as FBO & {__first?: boolean}).__first = true

    texture.swapWithFBO(gl)
    texture.freeDrawFBO(gl)

    window.redraw_viewport(true)
  }

  modalEnd(wasCanceled: boolean) {
    const ctx = this.modal_ctx!

    const ret = super.modalEnd(wasCanceled)

    if (ctx.toolmode && '_radius' in ctx.toolmode) {
      //stop custom radius drawing for brush circle
      ctx.toolmode._radius = undefined
    }

    return ret
  }

  on_mouseup(e: PointerEvent): void {
    this.modalEnd(false)
  }
}

ToolOp.register(TexPaintOp)
