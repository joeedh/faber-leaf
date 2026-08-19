/*
 * Minimal image editor.
 *
 * This is the "clean" image editor that supports a single responsibility:
 * loading images into `ImageBlock`s and displaying the active image with
 * pan/zoom. The legacy UV-editing machinery it used to carry (the `UVEditor`
 * component, find-nearest UV picking, the UV select/transform/flag ToolOps,
 * and the UV tools sidebar) was archived by P13 and rebuilt by P18 as the
 * `uv_editor` addon, over the mesh-agnostic `IUVSource` contract.
 */
import {DataBlockBrowser, Editor, EditorSideBar, HotKey, VelPan} from '../editor_base'
import {Icons} from '../icon_enum.js'
import {Vector2, Vector3, Vector4, Matrix4} from '../../util/vectormath.js'
import {nstructjs, KeyMap, UIBase, eventWasTouch, haveModal, Menu, DataAPI} from '../../path.ux/scripts/pathux.js'
import {VelPanPanOp} from '../velpan.js'
import {ImageBlock, ImageUser} from '../../image/image.js'
import {PrimitiveTypes, LayerTypes, SimpleMesh} from '../../webgl/simplemesh'
import {Shaders} from '../../shaders/shaders.js'
import {type BlockLoader, BlockLoaderAddUser, DataBlock} from '../../core/lib_api'
import type {IUniformsBlock} from '../../webgl/webgl'
import {StructReader} from '../../path.ux/scripts/util/nstructjs'
import {isWebGPU} from '../../core/renderer_flag.js'
import {getWebGL} from '../view3d/view3d.js'
import {getActiveWebGpuViewport, primeWebGpuViewport, ensureCanvasDepth} from '../view3d/view3d_draw_webgpu.js'
import {createSampler} from '../../webgpu/texture.js'
import bus from '../../core/bus.js'
import type {BusTriggers} from '../../core/bus.js'
import {ImageBus} from './ImageBus.js'

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export class ImageEditor extends Editor {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
image.ImageEditor {
  imageUser : ImageUser;
  velpan    : VelPan;
}`
  )

  imageUser: ImageUser
  velpan: VelPan

  sidebar: EditorSideBar

  matrix: Matrix4
  imatrix: Matrix4

  glPos: Vector2
  glSize: Vector2

  // Background fill (WebGPU letterbox), checker grid, and the textured
  // image quad each carry their own program so the WebGPU queue adapter
  // can resolve a distinct pipeline per mesh (SimpleMesh.draw submits one
  // program for the whole mesh). The geometry is static — only the
  // projection matrix (a uniform) changes with pan/zoom.
  bgMesh: SimpleMesh | undefined
  checkerMesh: SimpleMesh | undefined
  imageMesh: SimpleMesh | undefined
  identity: Matrix4
  _gpuSampler: GPUSampler | undefined
  _gpuSamplerDevice: GPUDevice | undefined
  _last_image_key: string

  constructor() {
    super()

    this.matrix = new Matrix4()
    this.imatrix = new Matrix4()
    this.identity = new Matrix4()

    this.glPos = new Vector2()
    this.glSize = new Vector2([256, 256])

    this.bgMesh = undefined
    this.checkerMesh = undefined
    this.imageMesh = undefined
    this._gpuSampler = undefined
    this._gpuSamplerDevice = undefined
    this._last_image_key = ''

    this.imageUser = new ImageUser()

    this.velpan = new VelPan()
    this.velpan.onchange = this.onVelPanChange.bind(this)

    this.container.noMarginsOrPadding()

    this.sidebar = this.makeSideBar()
  }

  onVelPanChange() {
    this.flagRedraw()
  }

  flagRedraw() {
    window.redraw_viewport(false)
  }

  onTrigger(type: BusTriggers<typeof ImageBus>): void {
    // A screen torn down whole (a file load) never fires on_area_inactive, so
    // an emitter that outlived its DOM deregisters itself on first contact.
    if (this.isDead()) {
      bus.removeEmitter(this, ImageBus)
      return
    }

    if (type === 'flagRedraw') {
      this.flagRedraw()
    }
  }

  on_area_active(): void {
    super.on_area_active()
    bus.addEmitter(this, ImageBus)
  }

  on_area_inactive(): void {
    super.on_area_inactive()

    if (bus.hasEmitter(this, ImageBus)) {
      bus.removeEmitter(this, ImageBus)
    }
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

  copy(): this {
    const ret = document.createElement('uv-image-editor-x') as unknown as this

    ret.velpan.load(this.velpan)
    ret.imageUser.load(this.imageUser)
    ret.ctx = this.ctx

    return ret
  }

  static defineAPI(api: DataAPI) {
    const st = super.defineAPI(api)

    st.struct('imageUser', 'imageUser', 'Image', api.mapStruct(ImageUser))
    st.struct('velpan', 'velpan', 'VelPan', api.mapStruct(VelPan))

    return st
  }

  init() {
    super.init()

    const header = this.header!
    let row = header.row().strip()

    row.menu('Image', [
      'image.open()|Open',
      Menu.SEP,
      'datalib.default_new(blockType="image" dataPathToSet="imageEditor.imageUser.image")|New',
    ])
    row.menu('View', [])

    const col = header.col()
    row = col.row()

    row.iconbutton(Icons.HOME, 'Reset Pan/Zoom', () => {
      this.velpan.reset()
      this.flagRedraw()
    })

    const browser = document.createElement('data-block-browser-x') as DataBlockBrowser<ImageBlock>
    browser.setAttribute('datapath', 'imageEditor.imageUser.image')
    browser.blockClass = ImageBlock

    row.add(browser)

    this.addEventListener('pointerdown', this.on_mousedown.bind(this))
    // XXX pathux's WheelEvent typing isn't inferred for this overload
    this.addEventListener('mousewheel', this.on_mousewheel.bind(this) as EventListenerOrEventListenerObject)
  }

  defineKeyMap() {
    this.keymap = new KeyMap([new HotKey('O', ['ctrl'], 'image.open()')])
    return this.keymap
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
    if (haveModal() || !this.ctx) {
      return
    }

    const wasTouch = eventWasTouch(e)
    let ok = wasTouch && e.altKey
    ok = ok || (e.button !== 0 && !wasTouch)
    ok = ok || (e.button === 0 && e.altKey)

    if (ok) {
      const op = new VelPanPanOp()
      op.inputs.velpanPath.setValue('imageEditor.velpan')
      this.ctx.api.execTool(this.ctx, op)
    }
  }

  updateMatrix() {
    this.matrix.makeIdentity()

    const amat = new Matrix4()
    const aspect = this.glSize[1] / this.glSize[0]
    amat.scale(aspect, 1.0, 1.0)

    const pan = this.velpan.pos
    const zoom = this.velpan.scale[0]

    const pmat = new Matrix4()
    pmat.translate((2.0 * pan[0]) / this.glSize[1], (2.0 * pan[1]) / this.glSize[1], 0.0)

    const smat = new Matrix4()
    smat.scale(zoom, -zoom, 1.0)

    const tmat = new Matrix4()
    tmat.translate(-0.5, 0.5, 0.0)

    this.matrix.multiply(amat)
    this.matrix.multiply(smat)
    this.matrix.multiply(pmat)
    this.matrix.multiply(tmat)

    const image = this.imageUser.image
    const imgAspect = image?.ready ? image.width / image.height : 1.0

    const imat = new Matrix4()
    imat.scale(imgAspect, 1.0, 1.0)
    this.matrix.multiply(imat)

    this.imatrix.load(this.matrix).invert()
  }

  /**
   * Build the three static display meshes. The geometry never changes —
   * pan/zoom and image aspect are folded into the projection matrix, a
   * uniform — so this runs once (lazily) rather than per frame.
   *
   * Each mesh carries its own `program` so the WebGPU queue adapter
   * resolves a distinct pipeline per mesh: `SimpleMesh.draw` submits a
   * single program for the whole mesh, so a checker (vertex-colored) and
   * the image quad (textured) cannot share one mesh on WebGPU.
   */
  genMeshes() {
    // Background letterbox fill. Drawn with an identity projection so the
    // full-NDC quad covers the editor region — on WebGPU the pass uses
    // `loadOp: 'load'` (to preserve other editors on the shared canvas),
    // so the gray fill replaces the scissored clear the WebGL path gets.
    const bgMesh = new SimpleMesh(LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.ID)
    bgMesh.program = Shaders.MeshEditShader
    bgMesh.island.primflag = PrimitiveTypes.TRIS
    {
      const c = new Vector4([0.3, 0.3, 0.3, 1.0])
      const quad = bgMesh.island.quad(
        new Vector3([-1, -1, 0]),
        new Vector3([-1, 1, 0]),
        new Vector3([1, 1, 0]),
        new Vector3([1, -1, 0])
      )
      quad.colors(c, c, c, c)
      quad.ids(1, 1, 1, 1)
    }
    this.bgMesh = bgMesh

    // Checker backdrop behind (semi-transparent) images, in the unit square.
    const checkerMesh = new SimpleMesh(LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.ID)
    checkerMesh.program = Shaders.MeshEditShader
    checkerMesh.island.primflag = PrimitiveTypes.TRIS

    const checker = checkerMesh.island
    const bg = new Vector4([0.7, 0.7, 0.7, 1.0])
    const bg2 = new Vector4([0.8, 0.8, 0.8, 1.0])

    const steps = 32
    for (let i = 0; i < steps * steps; i++) {
      const ix = i % steps
      const iy = ~~(i / steps)
      const ds = 1.0 / steps

      const x = ix / steps
      const y = iy / steps

      const quad = checker.quad(
        new Vector3([x, y, 0]),
        new Vector3([x, y + ds, 0]),
        new Vector3([x + ds, y + ds, 0]),
        new Vector3([x + ds, y, 0])
      )

      const c = (ix + iy) & 1 ? bg : bg2
      quad.colors(c, c, c, c)
      quad.ids(1, 1, 1, 1)
    }
    this.checkerMesh = checkerMesh

    // Textured unit quad for the active image.
    const imageMesh = new SimpleMesh(LayerTypes.LOC | LayerTypes.UV | LayerTypes.COLOR)
    imageMesh.program = Shaders.FlatMeshTexture
    imageMesh.island.primflag = PrimitiveTypes.TRIS

    const white = new Vector4([1, 1, 1, 1])
    const quad = imageMesh.island.quad(
      new Vector3([0, 0, 0]),
      new Vector3([0, 1, 0]),
      new Vector3([1, 1, 0]),
      new Vector3([1, 0, 0])
    )

    quad.uvs(new Vector2([0, 0]), new Vector2([0, 1]), new Vector2([1, 1]), new Vector2([1, 0]))
    quad.colors(white, white, white, white)
    this.imageMesh = imageMesh
  }

  update() {
    if (!this.ctx) {
      return
    }

    this.push_ctx_active(false)
    super.update()

    const image = this.imageUser.image
    if (image) {
      image.update()
    }

    const key = image ? `${image.lib_id}:${image.updateGen}:${image.ready}` : ''
    if (key !== this._last_image_key) {
      this._last_image_key = key
      this.flagRedraw()
    }

    this.velpan.update(true, false)

    this.push_ctx_active(false)
  }

  /**
   * Per-draw uniforms shared by both backends. The `*_id` slots are all
   * `-1` and the mesh vertex ids are `1`, so `MeshEditShader` never tints
   * the checker/background with an active/highlight/last color. Extra keys
   * not present in a given WGSL struct (`texture`, `imageTex`, …) are
   * ignored by `UniformBindings`, so one shape feeds every pipeline.
   */
  buildUniforms(projectionMatrix: Matrix4, extra?: Record<string, unknown>): IUniformsBlock {
    const dpi = UIBase.getDPI()

    return {
      size         : this.glSize,
      aspect       : this.glSize[0] / this.glSize[1],
      near         : 0.0001,
      far          : 1.0,
      polygonOffset: 0.0,
      projectionMatrix,
      objectMatrix: this.identity,
      pointSize   : 5 * dpi,
      active_id   : -1,
      highlight_id: -1,
      last_id     : -1,
      opacity     : 1.0,
      alpha       : 1.0,
      ...extra,
    } as unknown as IUniformsBlock
  }

  viewportDraw(gl: WebGL2RenderingContext) {
    if (!gl || !this.ctx?.screen) {
      return
    }

    const dpi = UIBase.getDPI()

    this.glPos.load(this.pos!)
    this.glPos[1] = this.ctx.screen.size[1] - (this.pos![1] + this.size![1])
    this.glPos.mulScalar(dpi).floor()

    this.glSize.load(this.size!).mulScalar(dpi).ceil()

    this.style['backgroundColor'] = 'rgba(0,0,0,0)'
    this.container.style['backgroundColor'] = 'rgba(0,0,0,0)'

    this.updateMatrix()

    if (!this.checkerMesh) {
      this.genMeshes()
    }

    const image = this.imageUser.image
    if (image && !image.ready) {
      image.update()
    }

    if (isWebGPU()) {
      this.drawWebGpu(gl)
    } else {
      this.drawWebGl(gl)
    }
  }

  drawWebGl(gl: WebGL2RenderingContext) {
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(this.glPos[0], this.glPos[1], this.glSize[0], this.glSize[1])
    gl.viewport(this.glPos[0], this.glPos[1], this.glSize[0], this.glSize[1])

    gl.clearColor(0.3, 0.3, 0.3, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.disable(gl.CULL_FACE)

    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // The scissored clear already paints the gray backdrop; the WebGPU
    // path draws bgMesh instead because its pass uses `loadOp: 'load'`.
    this.checkerMesh!.draw(gl, this.buildUniforms(this.matrix))

    const image = this.imageUser.image
    if (image?.ready) {
      const gltex = image.getGlTex(gl)
      if (gltex) {
        this.imageMesh!.draw(gl, this.buildUniforms(this.matrix, {texture: gltex}))
      }
    }
  }

  getGpuSampler(device: GPUDevice): GPUSampler {
    if (!this._gpuSampler || this._gpuSamplerDevice !== device) {
      this._gpuSampler = createSampler(device, {magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear'})
      this._gpuSamplerDevice = device
    }

    return this._gpuSampler
  }

  drawWebGpu(gl: WebGL2RenderingContext) {
    const canvas = getWebGL()?.canvas
    if (!canvas) {
      return
    }

    const viewport = getActiveWebGpuViewport(canvas)
    if (!viewport) {
      // Device is still initializing — kick it; the next redraw draws.
      primeWebGpuViewport(canvas)
      return
    }

    const ctx = viewport.ctx
    const device = viewport.gpu.device
    const canvasTex = viewport.gpu.canvasContext.getCurrentTexture()
    const sw = canvasTex.width
    const sh = canvasTex.height

    ctx.size = [sw, sh]
    const depth = ensureCanvasDepth(viewport, sw, sh)

    // Editor region in WebGPU's origin-top-left device pixels. `this.pos` /
    // `this.size` are DOM (top-left) CSS pixels, so no Y-flip is needed —
    // just scale by DPI and clamp into the full-canvas attachment.
    const dpi = UIBase.getDPI()
    const rx = clampInt(Math.floor(this.pos![0] * dpi), 0, sw)
    const ry = clampInt(Math.floor(this.pos![1] * dpi), 0, sh)
    const rw = clampInt(Math.ceil(this.size![0] * dpi), 0, sw - rx)
    const rh = clampInt(Math.ceil(this.size![1] * dpi), 0, sh - ry)
    if (rw <= 0 || rh <= 0) {
      return
    }

    // `loadOp: 'load'` preserves whatever other editors drew into the
    // shared canvas; bgMesh paints this editor's region (the WebGPU
    // equivalent of the WebGL scissored clear).
    const desc: GPURenderPassDescriptor = {
      label                 : 'imageEditor.pass',
      colorAttachments: [
        {
          view   : canvasTex.createView(),
          loadOp : 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view           : depth.view,
        depthClearValue: 1.0,
        depthLoadOp    : 'clear',
        depthStoreOp   : 'store',
      },
    }

    const image = this.imageUser.image
    const gpuTex = image?.ready ? image.getGpuTex(device) : undefined
    const sampler = this.getGpuSampler(device)

    ctx.beginFrame()
    try {
      ctx.renderStageDesc(desc, (pass) => {
        pass.setViewport(rx, ry, rw, rh, 0, 1)
        pass.setScissorRect(rx, ry, rw, rh)

        this.bgMesh!.draw(gl, this.buildUniforms(this.identity))
        this.checkerMesh!.draw(gl, this.buildUniforms(this.matrix))

        if (gpuTex) {
          this.imageMesh!.draw(gl, this.buildUniforms(this.matrix, {imageTex: gpuTex.view, imageSmp: sampler}))
        }
      })
    } finally {
      ctx.endFrame()
    }
  }

  setCSS() {
    super.setCSS()
    this.background = 'rgba(0,0,0,0)'
  }

  dataLink(owner: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    super.dataLink(owner, getblock, getblock_addUser)
    this.imageUser.dataLink(owner, getblock, getblock_addUser)
  }

  loadSTRUCT(reader: StructReader<this>) {
    reader(this)
    super.loadSTRUCT(reader)

    this.velpan.onchange = this.onVelPanChange.bind(this)
  }
}

Editor.register(ImageEditor)
