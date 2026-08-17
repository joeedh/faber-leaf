import {ImageBus} from './ImageBus'
import {DataBlockBrowser, Editor, EditorSideBar, HotKey, VelPan} from '../editor_base'
import {Icons} from '../icon_enum.js'
import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../../util/vectormath.js'
import * as util from '../../util/util.js'
import {
  nstructjs,
  ToolOp,
  color2css,
  css2color,
  math,
  KeyMap,
  UIBase,
  eventWasTouch,
  haveModal,
  saveUIData,
  loadUIData,
  EnumProperty,
  Menu,
  DataAPI,
  PropertySlots,
  IVectorOrHigher,
  Container,
} from '../../path.ux/scripts/pathux.js'
import {VelPanPanOp} from '../velpan.js'
import {Colors, ObjectFlags} from '../../sceneobject/sceneobject.js'
import {MeshFlags} from '../../../addons/builtin/mesh/src/mesh_base.js'
import {SelectOneUVOp} from './uv_selectops.js'
import {SelOneToolModes} from '../../../core/select_types.js'
import {ImageBlock, ImageFlags, ImageGenTypes, ImageTypes, ImageUser} from '../../image/image.js'
import {PrimitiveTypes, LayerTypes, SimpleMesh} from '../../webgl/simplemesh'
import {UVWrangler} from '../../../addons/builtin/mesh/src/unwrapping.js'
import {Shaders} from '../../shaders/shaders.js'
import {type BlockLoader, BlockLoaderAddUser, DataBlock, DataRef, DataRefProperty} from '../../core/lib_api'

import './uv_selectops.js'
import './uv_transformops.js'
import './uv_ops.js'
import {AttrRef, UVFlags, UVLayerElem} from '../../../addons/builtin/mesh/src/mesh_customdata'
import {resetUnwrapSolvers} from '../../../addons/builtin/mesh/src/mesh_uvops.js'
import bus, {BusTriggers} from '../../core/bus'
import type {Loop, Mesh} from '../../../addons/builtin/mesh/src/mesh'
import type {ToolContext, ViewContext} from '../../core/context'
import type {IUniformsBlock, ShaderProgram} from '../../webgl/index'
import {StructReader} from '../../path.ux/scripts/util/nstructjs'

const _projtmp = new Vector2()

export const NearestUVTypes = {
  VERTEX: 1,
  EDGE  : 2,
  FACE  : 4,
}

export class NearestUVRet {
  type: number
  dist: number
  uv: Vector2
  l: Loop
  z: number

  constructor() {
    this.type = 0
    this.dist = 0
    this.uv = new Vector2()
    this.l = undefined as unknown as Loop // can't initialize this here
    this.z = 0
  }
}

const findnearestRets = util.cachering.fromConstructor(NearestUVRet, 2048)

const uvp = new Vector2()

export function findnearestUV(
  localX: number,
  localY: number,
  uvEditor: UVEditor,
  limit = 55,
  type = NearestUVTypes.VERTEX,
  cd_uv?: number,
  snapLimit = 0.00025,
  selectedFacesOnly = true
) {
  limit /= uvEditor.getScale() * (uvEditor.glSize[1] / UIBase.getDPI())
  //console.log(limit)
  //XXX remember to fix me
  limit = 0.2

  const mesh = uvEditor.getMesh()

  if (!mesh) {
    return undefined
  }

  if (cd_uv === undefined) {
    cd_uv = mesh.loops.customData.getLayerIndex('uv')
  }
  if (cd_uv < 0) {
    return undefined
  }
  const uvAttr = new AttrRef<UVLayerElem>(cd_uv)

  let mindis
  let minret
  const p = uvp

  p[0] = localX
  p[1] = localY

  const list = [] as NearestUVRet[]
  let li = 0

  const iter = selectedFacesOnly ? mesh.faces.selected.editable : mesh.faces

  //have to iterate over faces to get z order right
  for (const f of iter) {
    for (const l of f.loops) {
      const uv = uvAttr.get(l).uv
      const dis = uv.vectorDistance(p)

      if (dis < limit) {
        const ret = findnearestRets.next()
        ret.l = l
        ret.uv.load(uv)
        ret.dist = dis
        ret.type = NearestUVTypes.VERTEX
        ret.z = li

        list.push(ret)
        li++
      }
    }
  }

  const maxli = li

  if (list.length === 0) {
    return undefined
  }

  list.sort((a, b) => {
    let ret = a.dist - b.dist

    //for uvs stacked on top of each other, sort so top most comes first
    if (a.uv.vectorDistance(b.uv) < snapLimit) {
      ret = ret * maxli + (b.z - a.z) / maxli
    } else {
      //weight by selection
      const s1 = a.l.flag & MeshFlags.SELECT ? 1 : 0
      const s2 = b.l.flag & MeshFlags.SELECT ? 1 : 0
      ret += (s1 - s2) / maxli
    }

    return ret
  })

  /*
  let i = 0;
  while (i < list.length && list[i].uv.vectorDistance(list[0].uv) < snapLimit) {
    i++;
  }

  list.length =i;
  //*/

  return list
}

const localtemps = util.cachering.fromConstructor(Vector2, 64)

/**
 expects a datapath attribute references a Mesh
 and a selfpath attribute for building a path to itself
 **/
export class UVEditor extends UIBase<ViewContext> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  UVEditor {
    velpan              : VelPan;
    meshpath            : string | this.getAttribute("datapath");
    selfpath            : string | this.getAttribute("selfpath");
    imageUser           : ImageUser;
    selectedFacesOnly   : bool; 
  }`
  )

  gl?: WebGL2RenderingContext
  parentEditor?: ImageEditor
  mdown?: boolean
  meshpath?: string
  selfpath?: string

  velpan: VelPan
  imageUser: ImageUser

  matrix: Matrix4
  imatrix: Matrix4

  smesh: SimpleMesh | undefined
  smesh2: SimpleMesh | undefined

  glPos: Vector2
  glSize: Vector2

  mpos: Vector2
  start_mpos: Vector2

  selectedFacesOnly: boolean

  snapLimit: number

  canvas: HTMLCanvasElement
  g: CanvasRenderingContext2D

  size: Vector2
  drawlines: DrawLine[]

  _last_update_key: string
  _redraw_req?: number

  constructor() {
    super()

    this.matrix = new Matrix4()
    this.imatrix = new Matrix4()

    this.smesh2 = undefined
    this.smesh = undefined

    this.glPos = new Vector2() //is set by parent
    this.glSize = new Vector2([512, 512]) //is set by parent

    this.mpos = new Vector2()
    this.start_mpos = new Vector2()

    this.selectedFacesOnly = true

    this.snapLimit = 0.0001

    this.canvas = document.createElement('canvas')
    this.g = this.canvas.getContext('2d')!

    this.size = new Vector2([512, 512])
    this.velpan = new VelPan()

    this.imageUser = new ImageUser()
    this.velpan.onchange = this.onVelPanChange.bind(this)

    this._redraw_req = undefined
    this._last_update_key = ''

    this.drawlines = []
    this.shadow.appendChild(this.canvas)
  }

  resetDrawLines() {
    this.drawlines.length = 0
  }

  addDrawLine(v1: Vector2, v2: Vector2, color = 'black') {
    if (typeof color === 'object') {
      color = color2css(color)
    }

    const dl = new DrawLine(v1, v2, color)
    this.drawlines.push(dl)

    return dl
  }

  findnearest(localX: number, localY: number, limit: number) {
    return findnearestUV(localX, localY, this, limit)
  }

  onVelPanChange() {
    this.flagRedraw()
  }

  getScale() {
    return this.velpan.scale[0]
  }

  static defineAPI(api: DataAPI) {
    const st = api.mapStruct(UVEditor, true)

    st.struct('velpan', 'velpan', 'VelPan', api.mapStruct(VelPan))
    st.struct('imageUser', 'imageUser', 'Image', api.mapStruct(ImageUser))

    return st
  }

  init() {
    super.init()

    this.addEventListener('pointerdown', this.on_mousedown.bind(this))
    this.addEventListener('pointermove', this.on_mousemove.bind(this))
    this.addEventListener('pointerup', this.on_mouseup.bind(this))
    // XXX weird ts type error here, doesn't infer WheelEvent parameter correctly
    this.addEventListener('mousewheel', this.on_mousewheel.bind(this) as EventListenerOrEventListenerObject)
  }

  on_mousewheel(e: WheelEvent) {
    const dt = 1.0 - e.deltaY * 0.001

    const scale = this.velpan.scale[0] * dt

    this.velpan.scale[0] = this.velpan.scale[1] = scale
    this.velpan.update()

    e.preventDefault()
    e.stopPropagation()
  }

  on_mousedown(e: PointerEvent) {
    if (haveModal()) {
      this.mdown = false
      return
    }

    this.mpos[0] = e.x
    this.mpos[1] = e.y

    if (!this.ctx) {
      return
    }
    console.log('mdown')

    const wasTouch = eventWasTouch(e)
    let ok = wasTouch && e.altKey
    ok = ok || (e.button !== 0 && !wasTouch)
    ok = ok || (e.button === 0 && e.altKey)

    //console.log("ok", ok, e.button, wasTouch);

    if (ok) {
      const op = new VelPanPanOp()
      let path = this.getAttribute('selfpath')
      path += '.velpan'

      op.inputs.velpanPath.setValue(path)
      this.ctx.api.execTool(this.ctx, op)
      //console.log("pan op");
    } else if (e.button === 0 || (e.pointerType === 'touch' && e.pointerId === 0)) {
      this.doSelect(e)

      this.mdown = true
      this.start_mpos.load(this.mpos)
    }
  }

  doSelect(e: PointerEvent) {
    const mpos = this.getLocalMouse(e.x, e.y)
    const snapLimit = this.snapLimit
    const loops = findnearestUV(mpos[0], mpos[1], this, undefined, snapLimit)

    if (!loops) {
      return
    }

    let i = 0
    while (i < loops.length && loops[i].uv.vectorDistance(loops[0].uv) < snapLimit) {
      i++
    }

    if (i === 0) {
      return
    }

    const tool = new SelectOneUVOp()

    let mode
    if (e.shiftKey) {
      mode = loops[0].l.flag & MeshFlags.SELECT ? SelOneToolModes.SUB : SelOneToolModes.ADD
    } else {
      mode = SelOneToolModes.UNIQUE
    }

    tool.inputs.mode.setValue(mode)

    i--
    while (i >= 0) {
      tool.inputs.loopEids.push(loops[i].l.eid)
      i--
    }

    console.log(tool)

    this.ctx.api.execTool(this.ctx, tool)
    this.flagRedraw()
  }

  updateHighlight(localX: number, localY: number) {
    const uvHit = findnearestUV(localX, localY, this)

    const mesh = this.getMesh()
    if (!mesh) {
      return
    }

    let redraw = false
    if (uvHit !== undefined) {
      const l = uvHit[0]?.l
      redraw = l !== mesh.loops.highlight
      mesh.loops.highlight = l
    } else if (mesh.loops.highlight !== undefined) {
      redraw = true
    }

    if (redraw) {
      this.flagRedraw()
    }
  }

  on_mousemove(e: PointerEvent) {
    //console.log(e, e.x, e.y);
    const x = e.x //e.screenX;
    const y = e.y //e.screenY;

    this.mpos[0] = x
    this.mpos[1] = y

    if (this.mdown && this.mpos.vectorDistance(this.start_mpos) > 15) {
      console.log('transform!')
      this.mdown = false
      this.ctx.api.execTool(this.ctx, 'uveditor.translate()')
    }

    if (!this.ctx) {
      return
    }

    const p = this.getLocalMouse(x, y)
    this.updateHighlight(p[0], p[1])

    //if (!window._over) {
    //window._over = document.createElement("overdraw-x");
    //window._over.start(_appstate.screen);
    //}
    //console.log(p[0], p[1], );
    //findnearestUV
    //console.log(this.getLocalMouse(e.x, e.y));
    //console.log("mmove");
  }

  on_mouseup(e: PointerEvent) {
    this.mdown = false
    this.mpos[0] = e.x
    this.mpos[1] = e.y

    e.stopPropagation()

    if (!this.ctx) {
      return
    }
    console.log('mup')
  }

  getLocalMouse(x: number, y: number) {
    const p = localtemps.next()
    const dpi = UIBase.getDPI()

    let h = window.innerHeight
    h = visualViewport!.height

    y = h - y

    p[0] = x * dpi - this.glPos[0]
    p[1] = y * dpi - this.glPos[1]
    this.unproject(p)

    return p
  }

  project(p: Vector2) {
    const p2 = _projtmp.load(p)
    p2.multVecMatrix(this.matrix)

    p[0] = (p2[0] * 0.5 + 0.5) * this.glSize[0]
    p[1] = (p2[1] * 0.5 + 0.5) * this.glSize[1]

    return p
  }

  unproject(p: Vector2) {
    const p2 = _projtmp

    p2[0] = (p[0] / this.glSize[0]) * 2.0 - 1.0
    p2[1] = (p[1] / this.glSize[1]) * 2.0 - 1.0

    p2.multVecMatrix(this.imatrix)

    p[0] = p2[0]
    p[1] = p2[1]

    return p
  }

  getMesh(): Mesh | undefined {
    if (!this.ctx) {
      return undefined
    }
    return this.ctx.api.getValue(this.ctx, this.getAttribute('datapath') ?? '')
  }

  hasMesh() {
    return this.getMesh() !== undefined
  }

  flagRedraw() {
    window.redraw_viewport(false)

    //console.warn("Redraw");

    if (this._redraw_req) {
      return
    }

    this._redraw_req = 1
    //window.setTimeout(() => this.redraw());

    //requestAnimationFrame(() => this.redraw());
  }

  updateMatrix() {
    const smat = new Matrix4()
    const smat2 = new Matrix4()
    const scale = this.glSize[1] / UIBase.getDPI()

    smat.scale(scale, scale, 1.0)
    smat2.scale(1 / scale, 1 / scale, 1.0)

    this.matrix.makeIdentity()

    const tmat1 = new Matrix4()
    const tmat2 = new Matrix4()

    const amat = new Matrix4()
    let aspect = this.glSize[1] / this.glSize[0]
    amat.scale(aspect, 1.0, 1.0)
    //amat.scale(1.0, 1.0/aspect, 1.0);

    const pan = this.velpan.pos
    const pmat = new Matrix4()
    const zoom = this.velpan.scale[0]

    pmat.translate((2.0 * pan[0]) / this.size[1], (2.0 * pan[1]) / this.size[1], 0.0)

    smat.makeIdentity()
    smat.scale(zoom, -zoom, 1.0)

    const d = 0.5
    tmat1.translate(-d, d, 0.0)
    tmat2.translate(-d, -d, 0.0)

    //this.matrix.multiply(tmat2);
    this.matrix.multiply(tmat1)
    this.matrix.multiply(amat)
    this.matrix.multiply(smat)
    this.matrix.multiply(pmat)

    //this.matrix.multiply(tmat1);

    const mat = new Matrix4()
    const image = this.ctx.activeTexture

    if (image?.ready) {
      aspect = image.width / image.height
    } else {
      aspect = 1.0
    }

    mat.scale(aspect, 1.0, 1.0)
    this.matrix.multiply(mat)

    this.imatrix.load(this.matrix).invert()
  }

  drawDrawLines(gl: WebGL2RenderingContext, uniforms: IUniformsBlock, program: ShaderProgram) {
    const lf = LayerTypes.LOC | LayerTypes.UV | LayerTypes.COLOR | LayerTypes.ID

    const sm = new SimpleMesh(lf)
    sm.primflag |= PrimitiveTypes.ADVANCED_LINES | PrimitiveTypes.LINES

    for (const dl of this.drawlines) {
      const line = sm.line(dl.v1, dl.v2)

      line.colors(dl.color, dl.color)
      line.ids(2, 2)
      line.uvs(new Vector2([0, 0]), new Vector2([1, 1]))
    }

    sm.draw(gl, uniforms, program)
    sm.destroy(gl)
  }

  viewportDraw(gl: WebGL2RenderingContext) {
    this.gl = gl

    this.updateMatrix()

    let gltex
    const image = this.ctx.activeTexture

    if (this._redraw_req || !this.smesh) {
      console.log('regenerated uveditor meshes')
      this.genMeshes(gl)
    }

    const dpi = UIBase.getDPI()

    //console.log(this.glPos, this.glSize);

    const wsmat = new Matrix4()
    const wmat = new Matrix4()

    wsmat.scale(1.0, -1.0, 1.0)
    wmat.translate(0.0, 0.5, 0.0)

    const matrix = new Matrix4()

    //flip y
    //matrix.multiply(wmat);
    //matrix.multiply(wsmat);

    matrix.multiply(this.matrix)

    if (image?.ready) {
      gltex = image.getGlTex(gl)
    } else if (image) {
      image.update()
    }

    const uniforms = {
      size            : this.glSize,
      aspect          : this.glSize[0] / this.glSize[1],
      near            : 0.0001,
      far             : 1.0,
      polygonOffset   : 0.0,
      projectionMatrix: matrix,
      objectMatrix    : new Matrix4(),
      pointSize       : 5 * dpi,
      active_id       : -1,
      highlight_id    : -1,
      texture         : gltex,
      opacity         : 1.0,
      alpha           : 1.0,
    }

    gl.clearColor(0.3, 0.3, 0.3, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.disable(gl.CULL_FACE)

    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    //gl.disable(gl.BLEND);

    this.smesh2!.islands[0].draw(gl, uniforms)

    if (gltex) {
      this.smesh2!.islands[1].draw(gl, uniforms)
    }

    this.smesh!.draw(gl, uniforms, Shaders.MeshEditShader)
    this.drawDrawLines(gl, uniforms, Shaders.MeshEditShader)
  }

  genMeshes(gl = this.gl) {
    this.redraw()

    if (!this.gl || !this.ctx?.mesh) {
      return
    }

    const colors = {} as typeof Colors
    for (const k in Colors) {
      const c = new Vector4(Colors[k])
      c[3] = 0.7

      colors[k] = c
    }

    const GREY = new Vector4([0.1, 0.1, 0.1, 0.7])
    function getColor(isSel?: boolean, isHigh?: boolean, isAct?: boolean, isPin?: boolean) {
      let mask = 0

      if (isSel) {
        mask |= ObjectFlags.SELECT
      }

      if (isAct) {
        mask |= ObjectFlags.ACTIVE
      }

      if (isHigh) {
        mask |= ObjectFlags.HIGHLIGHT
      }

      if (mask === 0) {
        return GREY
      }

      return colors[mask]
    }

    this._redraw_req = undefined
    let island1
    let island2

    if (this.smesh) {
      this.smesh.reset(this.gl)
      this.smesh2!.reset(this.gl)

      island1 = this.smesh2!.islands[0]
      island2 = this.smesh2!.islands[1]
    } else {
      this.smesh = new SimpleMesh(LayerTypes.UV | LayerTypes.COLOR | LayerTypes.ID | LayerTypes.LOC)
      this.smesh2 = new SimpleMesh(LayerTypes.UV | LayerTypes.COLOR | LayerTypes.ID | LayerTypes.LOC)
      this.smesh2.add_island()

      this.smesh.primflag |= PrimitiveTypes.POINTS | PrimitiveTypes.LINES
      this.smesh2.island.primflag = (this.smesh2.island.primflag ?? this.smesh2.primflag) | PrimitiveTypes.TRIS

      island1 = this.smesh2.islands[0]
      island2 = this.smesh2.islands[1]
    }

    island1.program = Shaders.MeshEditShader
    island2.program = Shaders.FlatMeshTexture

    //let quad = this.smesh2.quad([0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]);
    const bgf = 0.7
    const bg2f = 0.8
    const bg = new Vector4([bgf, bgf, bgf, 1.0])
    const bg2 = new Vector4([bg2f, bg2f, bg2f, 1.0])

    const steps = 32
    for (let i = 0; i < steps * steps; i++) {
      const ix = i % steps
      const iy = ~~(i / steps)
      const ds = 1.0 / steps

      const x = ix / steps
      const y = iy / steps

      const quad = island1.quad(
        new Vector3([x, y, 0]),
        new Vector3([x, y + ds, 0]),
        new Vector3([x + ds, y + ds, 0]),
        new Vector3([x + ds, y, 0])
      )

      const c = (ix + iy) & 1 ? bg : bg2
      quad.colors(c, c, c, c)
      quad.ids(1, 1, 1, 1)
    }

    const white = new Vector4([1, 1, 1, 1])
    const quad = island2.quad(
      new Vector3([0, 0, 0]),
      new Vector3([0, 1, 0]),
      new Vector3([1, 1, 0]),
      new Vector3([1, 0, 0])
    )

    quad.ids(1, 1, 1, 1)
    quad.uvs(new Vector2([0, 0]), new Vector2([0, 1]), new Vector2([1, 1]), new Vector2([1, 0]))
    quad.colors(white, white, white, white)

    const sm = this.smesh
    const mesh = this.ctx.mesh
    const cd_uv = mesh.loops.customData.getLayerRef<UVLayerElem>('uv')

    if (cd_uv.i < 0) {
      return
    }

    const wr = new UVWrangler(mesh, mesh.faces.selected.editable, cd_uv)
    wr.buildIslands()
    //let wr = getUVWrangler(mesh, true, true);

    const lhighlight = mesh.loops.highlight
    const lactive = mesh.loops.active

    const red = new Vector4([1, 0, 0, 0.6])

    for (const island of wr.islands) {
      for (const v of island) {
        v.co[2] = 0.0

        let p = sm.point(v.co)
        p.ids(v.eid)

        let sel = false
        let high = false
        let active = false
        let pin = false

        for (const l of wr.vertMap.get(v)!) {
          if (l.flag & MeshFlags.SELECT) {
            sel = true
          }

          if (l === lhighlight) {
            high = true
          }

          if (l === lactive) {
            active = true
          }

          if (l.customData.get(cd_uv).flag & UVFlags.PIN) {
            pin = true
          }

          if (wr.islandLoopMap.get(l) !== island) {
            // continue;
          }

          const v2 = wr.loopMap.get(l.next)!
          v2.co[2] = 0.0

          const line = sm.line(v.co, v2.co)
          line.ids(l.eid, l.eid)
        }

        const color = getColor(sel, high, active)
        p.colors(color)

        if (pin) {
          p = sm.point(v.co)
          p.ids(v.eid)
          p.colors(red)
        }
      }
    }
  }

  redraw() {
    // do nothing
  }

  redrawOld() {
    //return this.genMeshes();

    this._redraw_req = undefined
    //return;

    const g = this.g
    const canvas = this.canvas

    //console.log("redraw");

    const bg = this.getDefault('background')
    const lineclr = this.getDefault('gridLines')

    g.strokeStyle = '' + lineclr
    g.fillStyle = '' + bg

    //g.save();
    g.beginPath()
    g.rect(0, 0, canvas.width, canvas.height)
    //g.fill();

    g.clearRect(0, 0, canvas.width, canvas.height)

    const quad = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ].map((q) => new Vector2(q))
    for (let i = 0; i < 4; i++) {
      this.project(quad[i])
      const p = quad[i]

      p[1] = this.glSize[1] - p[1]
    }

    //console.log(quad);

    g.fillStyle = 'rgba(200, 200, 200, 0.1)'
    g.beginPath()
    g.moveTo(quad[0][0], quad[0][1])
    g.lineTo(quad[1][0], quad[1][1])
    g.lineTo(quad[2][0], quad[2][1])
    g.lineTo(quad[3][0], quad[3][1])
    g.lineTo(quad[0][0], quad[0][1])
    g.fill()

    const dpi = UIBase.getDPI()

    const cell = 32

    g.resetTransform()

    const width = canvas.width / dpi
    const height = canvas.height / dpi

    g.scale(dpi, dpi)

    const ysteps = Math.ceil(canvas.height / cell) + 1
    const xsteps = ysteps

    g.beginPath()
    const lp = new Vector2()
    for (let i = 0; i < xsteps + 1; i++) {
      const dt = i / xsteps
      lp[0] = dt
      lp[1] = 0
      this.project(lp)

      g.moveTo(lp[0], lp[1])
      lp[0] = dt
      lp[1] = 1.0

      this.project(lp)
      g.lineTo(lp[0], lp[1])
    }

    for (let i = 0; i < ysteps + 1; i++) {
      const dt = i / ysteps
      lp[1] = dt
      lp[0] = 0
      this.project(lp)

      g.moveTo(lp[0], lp[1])
      lp[1] = dt
      lp[0] = 1.0

      this.project(lp)
      g.lineTo(lp[0], lp[1])
    }

    g.stroke()

    const redrawOld2 = () => {
      if (this.imageUser.image) {
        const image = this.imageUser.image

        //console.log("image", image);
        image.update()

        if (image.ready) {
          //get image field directly
          g.save()
          const p = this.velpan.pos
          const s = this.velpan.scale[0]

          g.scale(s, s)

          g.translate(p[0], p[1])

          const wid = this.size[1]
          g.scale(wid / image._image!.width, wid / image._image!.height)

          //g.drawImage(image._image, 0, 0)
          g.restore()
        }
      }

      //let scale = this.velpan.

      const drawtmps = util.cachering.fromConstructor(Vector2, 64)
      const mesh = this.getMesh()!

      if (!mesh) {
        console.log('No mesh')
        //g.restore();
        return
      }

      const cd_uv = mesh.loops.customData.getLayerRef<UVLayerElem>('uv')
      if (cd_uv.i < 0) {
        console.log('No uvs')
        //g.restore();
        return
      }

      //scale /= this.size[1];

      g.beginPath()

      const colors = {} as {[k: keyof typeof Colors]: string}
      for (const k in Colors) {
        const c = new Vector4(Colors[k])
        c[3] = 0.7
        colors[k] = color2css(c)
      }

      function getColor(l: Loop) {
        let mask = 0

        if (l.flag & MeshFlags.SELECT) {
          mask |= ObjectFlags.SELECT
        }

        if (l === mesh.loops.active) {
          mask |= ObjectFlags.ACTIVE
        }

        if (l === mesh.loops.highlight) {
          mask |= ObjectFlags.HIGHLIGHT
        }

        if (mask === 0) {
          return 'rgba(22, 22, 22, 0.7)'
        }

        return colors[mask]
      }

      const vsize = 4

      function inrect(p: IVectorOrHigher<2>) {
        return p[0] >= 0 && p[0] < width && p[1] > 1 && p[1] <= height
      }

      const selectedFacesOnly = true
      const iter = selectedFacesOnly ? mesh.faces.selected.editable : mesh.faces

      for (const f of iter) {
        if (f.flag & MeshFlags.HIDE) {
          continue
        }

        for (const list of f.lists) {
          let lastp
          let lastinside
          let firstp
          let firstinside

          for (const l of list) {
            let bad = l.flag & MeshFlags.HIDE
            bad = bad || l.f.flag & MeshFlags.HIDE

            if (bad) {
              continue
            }

            const uv = l.customData.get(cd_uv).uv

            const color = getColor(l)

            const p = drawtmps.next().load(uv)
            this.project(p)

            //p[0] += this.velpan.pos[0];

            const inside = inrect(p)

            if (lastp && (lastinside || inside)) {
              g.moveTo(lastp[0], lastp[1])
              g.lineTo(p[0], p[1])
              g.strokeStyle = 'rgba(0,0,0,0.5)'
              g.stroke()
            } else {
              firstp = p
              firstinside = inside
            }

            if (inside) {
              g.fillStyle = color
              g.beginPath()
              g.rect(p[0] - vsize * 0.5, p[1] - vsize * 0.5, vsize, vsize)
              g.fill()
            }

            lastp = p
            lastinside = inside
          }

          if (firstp) {
            g.moveTo(lastp![0], lastp![1])
            g.lineTo(firstp[0], firstp[1])
            g.strokeStyle = 'rgba(0,0,0,0.5)'
            g.stroke()
          }
        }
      }

      for (const dl of this.drawlines) {
        const v1 = new Vector2(dl.v1)
        const v2 = new Vector2(dl.v2)

        this.project(v1)
        this.project(v2)

        g.beginPath()
        g.moveTo(v1[0], v1[1])
        g.lineTo(v2[0], v2[1])
        g.strokeStyle = color2css(dl.color)
        g.stroke()
      }
    }
    //g.restore();
  }

  setCSS() {
    super.setCSS()

    this.style['width'] = this.size[0] + 'px'
    this.style['height'] = this.size[1] + 'px'
    this.style['overflow'] = 'hidden'
  }

  updateSize() {
    const dpi = UIBase.getDPI()
    const w = ~~(this.size[0] * dpi)
    const h = ~~(this.size[1] * dpi)

    const ok = w !== this.canvas.width || h !== this.canvas.height

    if (!ok) {
      return
    }

    this.setCSS()
    const canvas = this.canvas
    console.log('size update')

    canvas.width = w
    canvas.height = h
    canvas.style['width'] = w / dpi + 'px'
    canvas.style['height'] = h / dpi + 'px'

    this.redraw()
  }

  updateMesh() {
    if (!this.ctx) {
      return
    }

    const mesh = this.getMesh()
    let key = ''

    if (mesh) {
      key += mesh.lib_id + ':' + mesh.loops.length + ':' + ':' + mesh.uvRecalcGen
    }

    const image = this.imageUser.image

    if (key !== this._last_update_key) {
      this._last_update_key = key
      this.flagRedraw()
    }
  }

  update() {
    if (!this.ctx) {
      return
    }

    this.updateMatrix()
    super.update()

    //deal with any possible (rare) cases of dataLink failing to be called correctly
    if (this.imageUser.image && this.imageUser.image instanceof DataRef) {
      this.imageUser.image = this.ctx.datalib.get(this.imageUser.image)
      this.imageUser.image!.lib_addUser()
    }

    if (this.imageUser.image) {
      this.imageUser.image.update()
    }

    this.updateMesh()
    this.velpan.minTimeStep = 0.0003

    /*
    let velpan = this.velpan;
    let b = this.velpan.bounds;

    b[0][0] = -this.size[1]*3.0;
    b[0][1] = -this.size[1]*3.0;

    console.log(b[0][0], this.velpan.pos[0]);
    */

    this.velpan.update(true, false)
    this.updateSize()
  }

  static newSTRUCT() {
    return UIBase.createElement('uv-editor-x')
  }

  loadSTRUCT(reader: StructReader<this>) {
    reader(this)

    this.velpan.onchange = this.onVelPanChange.bind(this)
  }

  dataLink(owner: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    this.imageUser.dataLink(owner, getblock, getblock_addUser)
  }

  static define() {
    return {
      tagname: 'uv-editor-x',
      style  : 'uveditor',
    }
  }
}

UIBase.register(UVEditor)

export class DrawLine {
  v1: Vector3
  v2: Vector3
  color: Vector4

  constructor(v1: Vector2, v2: Vector2, colorIn: string | number[] | Vector4 = 'black') {
    const color = new Vector4(typeof colorIn === 'string' ? css2color(colorIn) : colorIn)

    if (isNaN(color[3])) {
      color[3] = 1.0
    }

    this.v1 = new Vector3().loadXY(v1[0], v1[1])
    this.v2 = new Vector3().loadXY(v2[0], v2[1])
    this.color = color
  }
}

interface IImageUndoBlock {
  type: 'empty' | 'image'
  dataref: DataRef<ImageBlock>
  image: ImageBlock
}

export class ImageBlockOp<Inputs extends PropertySlots, Outputs extends PropertySlots = {}> extends ToolOp<
  Inputs & {
    //
    image: DataRefProperty<ImageBlock>
    type: EnumProperty
  },
  {},
  ToolContext,
  ViewContext
> {
  _ud?: IImageUndoBlock

  constructor() {
    super()
  }

  static tooldef() {
    return {
      toolpath: '', // needed to make TS happy
      inputs: {
        image: new DataRefProperty(ImageBlock),
        type : new EnumProperty(ImageTypes.FLOAT_BUFFER, ImageTypes),
      },
    }
  }

  undoPre(ctx: ToolContext) {
    const imageRef = this.inputs.image.getValue()
    const image = ctx.datalib.get(imageRef)

    const ud = {} as IImageUndoBlock
    this._ud = ud

    if (!image) {
      ud.type = 'empty'
      return
    }

    ud.dataref = DataRef.fromBlock(image)
    ud.type = 'image'
    ud.image = image.copy()
  }

  undo(ctx: ViewContext) {
    const ud = this._ud
    if (ud === undefined) {
      console.warn('undo called in error', this)
      return
    }

    if (ud.type === 'empty') {
      return
    }

    const image = ctx.datalib.get(ud.dataref)
    if (!image) {
      console.warn('Missing image in undo handler')
      return
    }

    ud.image.copyTo(image)
    image.flag |= ImageFlags.UPDATE
    image.glReady = false
    image.ready = false
  }
}

export class SetImageTypeOp extends ImageBlockOp<{}, {}> {
  static tooldef() {
    return {
      ...super.tooldef(),
      uiname  : 'Set Image Type',
      toolpath: 'image.set_type',
    }
  }

  exec(ctx: ToolContext) {
    const image = ctx.datalib.get(this.inputs.image.getValue())

    if (!image) {
      console.warn('Missing image', this.inputs.image.getValue())
      return
    }

    image.convertTypeTo(this.inputs.type.getValue() as number)
    image.flag |= ImageFlags.UPDATE
    image.update()
  }
}

ToolOp.register(SetImageTypeOp)

export class ImageEditor extends Editor {
  uvEditor: UVEditor
  subframe: Container<ViewContext>
  sidebar: EditorSideBar
  updateSideBar = false
  glPos: Vector2
  glSize: Vector2

  constructor() {
    super()

    this.glPos = new Vector2()
    this.glSize = new Vector2([256, 256])

    this.container.noMarginsOrPadding()

    this.uvEditor = document.createElement('uv-editor-x') as UVEditor
    this.uvEditor.parentEditor = this
    this.uvEditor.setAttribute('datapath', 'mesh')
    this.uvEditor.setAttribute('selfpath', 'imageEditor.uvEditor')

    //panel.style["z-order"] = "5";

    this.sidebar = this.makeSideBar()

    this.subframe = this.container.row()
    this.subframe.noMarginsOrPadding()

    this.rebuildLayout()
  }

  onTrigger(type: BusTriggers<typeof ImageBus>, data: any) {
    switch (type) {
      case 'resetDrawLines': {
        this.uvEditor.resetDrawLines()
        break
      }
      case 'flagRedraw': {
        this.uvEditor.flagRedraw()
        break
      }
      case 'addDrawLine': {
        this.uvEditor.addDrawLine(data[0], data[1], data[2])
      }
    }
  }

  on_area_active() {
    bus.addEmitter(this, ImageBus)
  }
  on_area_inactive() {
    bus.removeEmitter(this, ImageBus)
  }
  on_destroy() {
    if (bus.hasEmitter(this, ImageBus)) {
      bus.removeEmitter(this, ImageBus)
    }
  }

  makeSideBar() {
    const sidebar = super.makeSideBar()

    return sidebar
  }

  rebuildLayout() {
    this.uvEditor.remove()
    this.sidebar.remove()

    this.subframe.clear()

    this.subframe.add(this.uvEditor)
    this.subframe.add(this.sidebar)

    this.updateSideBar = true
  }

  flagSidebarRegen() {
    this.updateSideBar = true
  }

  onFileLoad(isActive: boolean) {
    /*
    let data = saveUIData(this.sidebar, "imageeditor");
    this.regenSidebar();
    loadUIData(this.sidebar, data);
    */
  }

  makeImageTypeMenu(con: Container<ViewContext>, path: string) {
    const on_select = (id: string | number) => {
      console.log('callback', id)
      const rdef = this.ctx.api.resolvePath(this.ctx, path)
      const image = rdef ? rdef.obj : undefined

      if (!image) {
        console.warn('no image')
        return
      }

      const tool = new SetImageTypeOp()
      tool.inputs.image.setValue(image)
      tool.inputs.type.setValue(id as number)

      this.ctx.api.execTool(this.ctx, tool)
    }

    const dropbox = con.listenum(undefined, {
      name   : 'Type',
      enumDef: ImageTypes,
    })

    dropbox.on_select = on_select

    // pathux's after aspect annotation of methods
    // isn't very TS friendly
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    dropbox.update.after(() => {
      let val: number | undefined

      try {
        val = dropbox.ctx.api.getValue<number>(this.ctx, path)
      } catch (error) {
        dropbox.internalDisabled = true
        return
      }
      if (val === undefined) {
        dropbox.internalDisabled = true
        return
      }

      dropbox.internalDisabled = false
      dropbox.setValue(val)
    })
  }

  regenSidebar() {
    if (!this.ctx || !this.updateSideBar) {
      this.updateSideBar = true
      return
    }

    this.updateSideBar = false

    const uidata = saveUIData(this.sidebar, 'sidebar')

    const sidebar = this.sidebar

    sidebar.clear()

    const tabs = sidebar.tabpanel!
    let tab: Container<ViewContext>
    let panel: Container<ViewContext>
    let strip: Container<ViewContext>
    let path: string
    let row: Container<ViewContext>
    let col: Container<ViewContext>

    tab = tabs!.tab('Workspace')
    tab.useIcons(false)

    col = tab.col()
    row = col.row()

    row.useIcons(true)
    row.prop('scene.propEnabled')
    row.useIcons(false)

    row.prop('scene.propMode')
    col.prop('scene.propRadius').range = [0.1, 500.0]
    col.prop('scene.propIslandOnly')

    tab = tabs.tab('Image Settings')
    const basepath = 'imageEditor.uvEditor'

    path = basepath + '.imageUser.image'
    tab.dataPrefix = path

    tab.prop('name')

    this.makeImageTypeMenu(tab, path + '.type')

    panel = tab.panel('Generator Settings')

    panel.prop('genType')
    const color = panel.prop('genColor')

    // pathux's after aspect annotation of methods
    // isn't very TS friendly
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    color.update.after(function (this: color) {
      if (!this.ctx) {
        return
      }

      const image = this.ctx.api.getValue(this.ctx, 'imageEditor.uvEditor.imageUser.image')
      let enabled = image
      enabled = enabled && image.genType === ImageGenTypes.COLOR
      enabled = enabled && image.type === ImageTypes.GENERATED

      if (!!color.disabled !== !enabled) {
        color.disabled = !enabled
      }
    })

    const sizeUpdate = function (this: UIBase<ViewContext>) {
      const image = this.ctx.api.getValue<ImageBlock>(this.ctx, 'imageEditor.uvEditor.imageUser.image')
      const enabled = image?.type === ImageTypes.GENERATED

      if (!!this.disabled !== !enabled) {
        this.disabled = !enabled
      }
    }

    // XXX
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    panel.prop('width').update.after(sizeUpdate)
    //XXX
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    panel.prop('height').update.after(sizeUpdate)

    tab = tabs.tab('Tools')
    col = tab.col()
    row = col.row()

    row.tool('mesh.unwrap_solve()')
    row.tool('mesh.relax_uvs()')

    row = col.row()
    row.tool('mesh.voxel_unwrap()')
    row.tool('mesh.randomize_uvs()')

    row = col.row()
    row.tool('mesh.reset_uvs()')
    row.tool('mesh.grid_uvs()')

    row = col.row()
    row.tool('mesh.pack_uvs()')
    row.tool('uveditor.project_uvs()')

    row = col.row()
    row.tool('mesh.fix_seams()')
    row.button('Reset Solver', () => {
      resetUnwrapSolvers()
    })

    loadUIData(this.sidebar, uidata)
    this.sidebar.flushUpdate()
  }

  init() {
    super.init()

    this.doOnce(this.regenSidebar)

    const header = this.header!
    let row = header.row().strip()

    const image_menu = ['image.open()|Open', Menu.SEP]

    row.menu('Image', image_menu)
    row.menu('Edit', this.buildEditMenu())
    row.menu('View', [])

    const col = header.col()
    row = col.row()

    row.iconbutton(Icons.HOME, 'Reset Pan/Zoom', () => {
      this.uvEditor.velpan.reset()
    })

    const browser = document.createElement('data-block-browser-x') as DataBlockBrowser<ImageBlock>
    browser.setAttribute('datapath', 'imageEditor.uvEditor.imageUser.image')
    browser.blockClass = ImageBlock

    row.add(browser)

    row = col.row()
    row.prop('scene.propEnabled')
    row.prop('scene.propMode')
    row.prop('scene.propRadius').range = [0.1, 500.0]
  }

  buildEditMenu() {
    return [
      "uveditor.toggle_select_all(mode='AUTO')",
      "uveditor.pick_select_linked(mode='ADD' immediateMode=true)",
      "uveditor.pick_select_linked(mode='SUB' immediateMode=true)",
      'uveditor.translate()',
      'uveditor.scale()',
      'uveditor.rotate()',
      "uveditor.set_flag(flag='PIN')|Set Pin",
      "uveditor.clear_flag(flag='PIN')|Clear Pin",
    ]
  }

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

  setCSS() {
    super.setCSS()
    this.background = 'rgba(0,0,0,0)' //this.getDefault("DefaultPanelBG");
  }

  update() {
    if (!this.ctx) {
      return
    }

    if (this.updateSideBar) {
      this.doOnce(this.regenSidebar)
    }

    this.push_ctx_active(false)
    super.update()

    const uve = this.uvEditor
    const w = this.owning_sarea!.size[0]
    const h = this.owning_sarea!.size[1] - 100

    uve.update()

    if (uve.size[0] !== w || uve.size[1] !== h) {
      uve.size[0] = w
      uve.size[1] = h
      uve.updateSize()
    }

    this.push_ctx_active(false)
  }

  static defineAPI(api: DataAPI) {
    const st = super.defineAPI(api)

    const uvst = UVEditor.defineAPI(api)

    st.struct('uvEditor', 'uvEditor', 'UV Editor Component', uvst)

    return st
  }

  viewportDraw(gl: WebGL2RenderingContext) {
    if (!gl || !this.ctx?.screen) {
      return
    }

    const dpi = UIBase.getDPI()
    if (0) {
      const screen = this.ctx.screen

      const r = this.getBoundingClientRect()
      this.glPos[0] = r.x * dpi
      this.glPos[1] = (screen.size[1] - r.bottom) * dpi
      this.glPos.floor()

      this.glSize.load(this.size!).mulScalar(dpi).ceil()
      //this.glSize[0] = ~~(r.width*dpi);
      //this.glSize[1] = ~~(r.height*dpi);
    } else {
      this.glPos.load(this.pos!)
      this.glPos[1] = this.ctx.screen.size[1] - (this.pos![1] + this.size![1])
      this.glPos.mulScalar(dpi).floor()

      this.glSize.load(this.size!).mulScalar(dpi).ceil()
    }

    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(this.glPos[0], this.glPos[1], this.glSize[0], this.glSize[1])
    gl.viewport(this.glPos[0], this.glPos[1], this.glSize[0], this.glSize[1])

    this.style['backgroundColor'] = 'rgba(0,0,0,0)'
    this.container.style['backgroundColor'] = 'rgba(0,0,0,0)'
    this.uvEditor.style['backgroundColor'] = 'rgba(0,0,0,0)'

    this.uvEditor.glPos = this.glPos
    this.uvEditor.glSize = this.glSize

    this.uvEditor.viewportDraw(gl)
  }

  loadSTRUCT(reader: StructReader<this>) {
    const uve = this.uvEditor

    this.uvEditor.remove()
    this.uvEditor = undefined as unknown as UVEditor

    reader(this)
    super.loadSTRUCT(reader)

    if (!this.uvEditor) {
      this.uvEditor = uve
    } else {
      this.uvEditor.setAttribute('datapath', uve.getAttribute('datapath')!)
      this.uvEditor.setAttribute('selfpath', uve.getAttribute('selfpath')!)
    }

    this.uvEditor.parentEditor = this
    this.rebuildLayout()
  }

  dataLink(owner: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    super.dataLink(owner, getblock, getblock_addUser)

    this.uvEditor.dataLink(owner, getblock, getblock_addUser)
  }

  static define() {
    return {
      areaname: 'ImageEditor',
      tagname : 'uv-image-editor-x',
      uiname  : 'Image Editor',
      apiname : 'imageEditor',
      flag    : 0,
      icon    : Icons.IMAGE_EDITOR,
      has3D   : true,
    }
  }
}

ImageEditor.STRUCT =
  nstructjs.inherit(ImageEditor, Editor) +
  `
  uvEditor  : UVEditor;
  snapLimit : float;
}`

nstructjs.register(ImageEditor)
Editor.register(ImageEditor)

declare global {
  interface Window {
    redraw_uveditors(): void
  }
}

window.redraw_uveditors = function () {
  if (!_appstate?.screen) {
    return
  }

  for (const sarea of _appstate.screen.sareas) {
    const editor = sarea.area

    if (editor instanceof ImageEditor) {
      editor.uvEditor.flagRedraw()
    }
  }
}
