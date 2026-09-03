import {BlockLoader, BlockLoaderAddUser, DataBlock, DataRef} from '../core/lib_api.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import {nstructjs, util, color2css, Vector4, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import {Icons} from '../editors/icon_enum.js'
import {DependSocket} from '../core/graphsockets.js'
import {NodeFlags} from '../core/graph.js'
import {Texture} from '../webgl/webgl.js'
import {FBO} from '../webgl/fbo'
import {GpuTexture} from '../webgpu/texture.js'
import type {OptionalIf} from '../util/optionalIf.js'
import type {StructReader} from '../path.ux/scripts/util/nstructjs.js'

export enum ImageFlags {
  SELECT = 1,
  HIDE = 2,
  UPDATE = 4,
}

export enum ImageTypes {
  GENERATED = 0,
  BYTE_BUFFER = 1,
  FLOAT_BUFFER = 2,
  URL = 3,
}

export enum ImageGenTypes {
  COLOR = 0,
  UVGRID = 1,
}

export type HTMLImageElementTex = HTMLImageElement & {image: ImageData | undefined}
export const HTMLImageElementTex = HTMLImageElement

export class ImageBlock<OPT extends {dead?: true | false} = {}> extends DataBlock<{}, {depend: DependSocket}> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
ImageBlock {
  type        : int;
  flag        : int;
  genType     : int;
  url         : string | this._save();
  width       : int;
  height      : int; 
  genColor    : vec4;
}
`
  )

  type: ImageTypes
  genType: ImageGenTypes
  flag: ImageFlags
  width: number
  height: number
  byteBuffer?: Uint8ClampedArray
  floatBuffer?: Float32Array
  updateGen: number
  genColor: Vector4
  url: string
  glReady: boolean = false
  ready: boolean
  gpuHasData: boolean
  gl: OptionalIf<WebGL2RenderingContext, OPT['dead']> = undefined as unknown as WebGL2RenderingContext
  glType: number
  glTex?: Texture
  gpuTex?: GpuTexture
  _gpuKey: string = ''
  glRegen: boolean
  _drawFBO: FBO | undefined
  _tex2: any
  _last_update_key: string
  _promises: {accept: (image: any) => void; reject: (err: any) => void}[]
  _image?: HTMLImageElementTex

  constructor() {
    super()

    this.type = ImageTypes.GENERATED
    this.genType = ImageGenTypes.UVGRID
    this.flag = ImageFlags.UPDATE

    this.width = 512
    this.height = 512

    this.byteBuffer = undefined
    this.floatBuffer = undefined
    this.updateGen = 0

    this.genColor = new Vector4([1, 1, 1, 1])

    this.url = ''
    this.ready = false

    //does the gpu have the main copy of the image?
    this.gpuHasData = false
    this.glType = -1
    this.glTex = undefined
    this.glRegen = false

    this._drawFBO = undefined
    this._tex2 = undefined

    this._last_update_key = ''
    this._promises = []
  }

  getDrawFBO(gl: WebGL2RenderingContext): FBO {
    if (!this._drawFBO) {
      this._drawFBO = new FBO(gl, this.width, this.height)
      this._drawFBO.update(gl, this.width, this.height)
      this._drawFBO.create(gl)
    }

    return this._drawFBO
  }

  freeDrawFBO(gl: WebGL2RenderingContext): this {
    if (this._drawFBO) {
      this._drawFBO.destroy()
    }

    this._drawFBO = undefined
    return this
  }

  swapWithFBO(gl: WebGL2RenderingContext): this {
    const fbo = this.getDrawFBO(gl)
    Texture.unbindAllTextures(gl)

    const temp = this.glTex
    this.glTex = fbo.texColor

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.finish()

    fbo.setTexColor(gl, temp!)
    gl.bindTexture(gl.TEXTURE_2D, null)

    return this
  }

  packAsURL = function (this: ImageBlock<OPT & {dead: false}>): void {
    if (!this._image?.image || !this.ready) {
      throw new Error('image is not ready')
    }

    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d')!

    canvas.width = this.width
    canvas.height = this.height

    g.putImageData(this._image.image, 0, 0)

    const url = canvas.toDataURL()
    this.url = url

    this.type = ImageTypes.URL
    this.floatBuffer = undefined
    this.byteBuffer = undefined
  }

  copyTo(b: this, copy_contents = true): void {
    super.copyTo(b, copy_contents)
    this._copyTo(b)
  }

  _copyTo(b: this): void {
    if (this.gpuHasData) {
      this.downloadFromGL()
    }

    b.width = this.width
    b.height = this.height

    b.type = this.type
    if (this.floatBuffer !== undefined && this.floatBuffer.length > 0) {
      b.floatBuffer = new Float32Array(this.floatBuffer.length)
      b.floatBuffer.set(this.floatBuffer)
    }

    if (this.byteBuffer !== undefined && this.byteBuffer.length > 0) {
      b.byteBuffer = new Uint8ClampedArray(this.byteBuffer.length)
      b.byteBuffer.set(this.byteBuffer)
    }

    b.url = this.url
    b.genType = this.genType
    b.genColor = this.genColor
    b.flag = this.flag

    b._image = this._image
    b.ready = this.ready
    b.glTex = undefined
    b.glRegen = true
    b.gl = this.gl
  }

  copy() {
    const ret = new this.constructor()

    this._copyTo(ret)

    return ret
  }

  downloadFromGL = function (this: ImageBlock<OPT & {dead: false}>): void {
    if (!this.glTex) {
      // eslint-disable-next-line no-console
      console.error('No gl texture data')
      return
    }

    const gl = this.gl
    const tex = this.glTex
    const fbo = new FBO(gl, this.width, this.height)

    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.DITHER)

    gl.depthMask(false)

    /*
    if (this.glType === gl.FLOAT) {
      fbo.ctype = gl.RGBA32F;
    } else {
      fbo.ctype = gl.RGBA;
    }

    fbo.etype = this.glType;
    */

    fbo.create(gl) //, tex);
    fbo.bind(gl)

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    fbo.drawQuad(gl, this.width, this.height, tex)

    let buf: Uint8ClampedArray | Uint8Array | Float32Array | undefined
    if (this.glType === gl.UNSIGNED_BYTE) {
      buf = this.byteBuffer

      if (buf?.length !== this.width * this.height * 4) {
        buf = this.byteBuffer = new Uint8ClampedArray(this.width * this.height * 4)
      }

      if (!(buf instanceof Uint8ClampedArray && buf instanceof Uint8Array)) {
        buf = this.byteBuffer = new Uint8ClampedArray(buf)
      }
    } else {
      buf = this.floatBuffer
      if (buf?.length !== this.width * this.height * 4) {
        buf = this.floatBuffer = new Float32Array(this.width * this.height * 4)
      }
    }

    //let fbuf = new Float32Array(this.width*this.height*4);

    gl.finish()

    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, this.glType, buf)

    fbo.unbind(gl)
    fbo.destroy()
    //copyTexImage2D

    if (this.glType === gl.FLOAT && this.type === ImageTypes.BYTE_BUFFER) {
      this.type = ImageTypes.FLOAT_BUFFER
      this.convertTypeTo(ImageTypes.BYTE_BUFFER)
    } else if (this.glType === gl.UNSIGNED_BYTE && this.type === ImageTypes.FLOAT_BUFFER) {
      this.type = ImageTypes.BYTE_BUFFER
      this.convertTypeTo(ImageTypes.FLOAT_BUFFER)
    }

    this.flag |= ImageFlags.UPDATE
    //this._image = undefined;
    //this.ready = false;
    //this.glRegen = true;

    gl.enable(gl.DITHER)
  }

  _convertToFloat() {
    if (this.type === ImageTypes.FLOAT_BUFFER) {
      return
    }

    this._convertToByte()
    const buf = this.byteBuffer

    if (!buf) {
      const fbuf = new Float32Array(this.width * this.height * 4)
      for (let i = 0; i < fbuf.length; i++) {
        fbuf[i] = 1.0
      }

      return
    }

    const fbuf = new Float32Array(this.width * this.height * 4)
    const mul = 1.0 / 255.0

    for (let i = 0; i < buf.length; i++) {
      fbuf[i] = buf[i] * mul
    }

    this.floatBuffer = fbuf
    this.glRegen = true
    this.type = ImageTypes.FLOAT_BUFFER

    return this
  }

  _convertToByte() {
    this.byteBuffer = undefined
    if (!this._image?.image) {
      throw new Error('Image is not fully loaded yet')
    }

    if (this.type !== ImageTypes.FLOAT_BUFFER) {
      if (this._image) {
        this.byteBuffer = this._image.image.data
      } else {
        this.byteBuffer = new Uint8ClampedArray(this.width * this.height * 4)
      }
    } else {
      const buf = new Uint8ClampedArray(this.floatBuffer!.length)
      const fbuf = this.floatBuffer!

      for (let i = 0; i < buf.length; i++) {
        buf[i] = ~~(fbuf[i] * 255)
      }

      this.byteBuffer = buf
    }

    return this
  }

  convertTypeTo(type: number) {
    if (type === undefined || type === this.type) {
      return this
    }

    if (this.gpuHasData) {
      if (type === ImageTypes.GENERATED) {
        this.gpuHasData = false
        this.glRegen = true
      } else {
        this.downloadFromGL()
      }
    }

    if (type === ImageTypes.BYTE_BUFFER) {
      this._convertToByte()
    } else if (type === ImageTypes.FLOAT_BUFFER) {
      this._convertToFloat()
    }

    this.ready = false
    this.flag |= ImageFlags.UPDATE
    this.update()

    if (this._drawFBO) {
      this._drawFBO.destroy()
      this._drawFBO = undefined
    }

    this.type = type

    return this
  }

  static blockDefine() {
    return {
      uiName     : 'Image',
      typeName   : 'image',
      defaultName: 'image.png',
      icon       : Icons.IMAGE_EDITOR,
      flag       : 0,
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = super.defineAPI(api, struct ?? api.mapStruct(this, true))

    st.enum('type', 'type', ImageTypes, 'Image Type')
    st.enum('genType', 'genType', ImageGenTypes, 'Generator')
    st.int('width', 'width', 'Width').noUnits().range(1, 16384).step(5)
    st.int('height', 'height', 'Height').noUnits().range(1, 16384).step(5)
    st.string('url', 'url', 'URL')
    st.bool('ready', 'ready', 'Ready', 'Is the image ready for use').readOnly()
    st.flags('flag', 'flag', ImageFlags, 'Flag')
    st.color4('genColor', 'genColor', 'Color')

    return st
  }

  destroy(): void {
    if (this.glTex) {
      try {
        this.glTex.destroy(this.gl!)
      } catch (error) {
        util.print_stack(error as Error)
      }
    }

    if (this._drawFBO) {
      this._drawFBO.destroy()
    }

    this.gpuTex?.destroy()

    const deadThis = this as ImageBlock<OPT & {dead: true}>

    deadThis._drawFBO = undefined
    deadThis.glTex = undefined
    deadThis.gpuTex = undefined
    deadThis.gl = undefined
  }

  getGlTex(gl: WebGL2RenderingContext): Texture | undefined {
    if (!this._image || !this.ready) {
      return undefined
    }

    //handle context loss
    if (gl && gl !== this.gl) {
      this.gl = gl
      this.glTex = undefined
      this.glRegen = true
    }

    if (this.glTex && (!this.glRegen || this.gpuHasData)) {
      return this.glTex
    }

    if (this.glTex) {
      this.glTex.destroy(gl)
    }

    this.glRegen = false

    let img

    if (this.floatBuffer?.length === this.width * this.height * 4) {
      img = this.floatBuffer
      this.glType = gl.FLOAT
    } else {
      img = this._image
      this.glType = gl.UNSIGNED_BYTE
    }

    //console.warn("Uploading image to gpu...", img instanceof Float32Array ? img : "(img tag)");

    return (this.glTex = Texture.load(gl, this.width, this.height, img))
  }

  /**
   * WebGPU sibling of `getGlTex`. Lazily uploads the decoded RGBA8 pixels
   * (`this._image.image`, set by `_regen`) into a `GpuTexture` and returns
   * it, recreating only when the image content changes. Unlike `getGlTex`
   * there is no float-buffer path — the editor display sampler reads
   * `rgba8unorm`. Returns `undefined` until the image is ready.
   */
  getGpuTex(device: GPUDevice): GpuTexture | undefined {
    if (!this._image?.image || !this.ready) {
      return undefined
    }

    const data = this._image.image
    const key = `${this.width}x${this.height}:${this.updateGen}`

    if (this.gpuTex && this._gpuKey === key) {
      return this.gpuTex
    }

    this.gpuTex?.destroy()

    const tex = new GpuTexture(device, {
      label : `image.${this.lib_id}`,
      width : this.width,
      height: this.height,
      format: 'rgba8unorm',
    })

    device.queue.writeTexture(
      {texture: tex.handle},
      data.data,
      {bytesPerRow: this.width * 4, rowsPerImage: this.height},
      {width: this.width, height: this.height}
    )

    this.gpuTex = tex
    this._gpuKey = key

    return tex
  }

  calcUpdateKey(digest = new util.HashDigest()): void {
    digest.add(this.lib_id)
    digest.add(Number(this.ready))
    digest.add(this.type)

    if (this.type === ImageTypes.GENERATED) {
      digest.add(this.genType)

      digest.add(this.genColor[0])
      digest.add(this.genColor[1])
      digest.add(this.genColor[2])
      digest.add(this.genColor[3])
    }

    digest.add(this.width)
    digest.add(this.height)
    digest.add(this.url.length)
    digest.add(this.flag)
    digest.add(this.updateGen)
  }

  _firePromises() {
    this.ready = true

    for (const {accept} of this._promises) {
      accept(this._image)
    }
  }

  update(): this {
    let key = ':' + this.type + ':' + (this.flag & ImageFlags.UPDATE)
    if (this.type === ImageTypes.GENERATED) {
      key += ':' + this.genType
      key += ':' + this.genColor[0] + ':' + this.genColor[1] + ':' + this.genColor[2] + ':' + this.genColor[3]
    }

    key += ':' + this.width + ':' + this.height

    let doupdate = key !== this._last_update_key || !this._image
    doupdate = doupdate || !!(this.flag & ImageFlags.UPDATE)

    //ignore updates while gpu has data
    if (this.gpuHasData) {
      //this._last_update_key = key;
      return this
    }

    if (doupdate) {
      this._last_update_key = key
      // eslint-disable-next-line no-console
      console.warn('regenerating image data for block', this)
      this._regen()
    }

    return this
  }

  _regen() {
    this.updateGen++

    this.flag &= ~ImageFlags.UPDATE
    this.ready = false
    this._image = undefined

    if (this.type === ImageTypes.URL) {
      this._image = document.createElement('img') as HTMLImageElementTex
      const image = this._image
      image.src = this.url

      this.ready = false
      this._promises.length = 0

      image.onload = () => {
        this.width = image.width
        this.height = image.height

        const canvas = document.createElement('canvas')
        const g = canvas.getContext('2d')!
        canvas.width = this.width
        canvas.height = this.height

        g.imageSmoothingEnabled = false
        g.drawImage(image, 0, 0)
        image.image = g.getImageData(0, 0, canvas.width, canvas.height)
        this._firePromises()
      }

      return
    }

    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d')!
    canvas.width = this.width
    canvas.height = this.height

    let idata

    if (this.type === ImageTypes.GENERATED) {
      if (this.genType === ImageGenTypes.COLOR) {
        g.beginPath()
        g.rect(0, 0, canvas.width, canvas.height)
        g.fillStyle = color2css(this.genColor)
        g.fill()

        idata = g.getImageData(0, 0, canvas.width, canvas.height)
      } else {
        const steps = 16

        const colors = ['rgb(200, 200, 200)', 'rgb(65, 65, 65)']

        const cx = canvas.width / steps
        const cy = canvas.height / steps

        g.strokeStyle = 'black'
        const tsize = cx * 0.5
        g.font = tsize + 'px sans-serif'

        for (let i = 0; i < steps * steps; i++) {
          const ix = i % steps
          const iy = ~~(i / steps)

          const x = (ix / steps) * canvas.width
          const y = (iy / steps) * canvas.height

          const c = (ix + iy) % 2

          g.fillStyle = 'black'
          const t = String.fromCharCode('A'.charCodeAt(0) + ix) + '' + iy
          g.fillText('' + t, x + cx * 0.5 - tsize * 0.5, y - cy * 0.5 + tsize * 0.5)

          g.beginPath()
          g.rect(x, y, cx, cy)
          g.fillStyle = colors[c]
          g.fill()
          g.stroke()
        }
      }

      this.glRegen = true
    } else if (this.type === ImageTypes.FLOAT_BUFFER) {
      idata = new ImageData(this.width, this.height)
      const buf = this.floatBuffer

      if (buf === undefined) {
        // eslint-disable-next-line no-console
        console.warn('Missing float buffer')
        return
      }

      for (let i = 0; i < buf.length; i++) {
        idata.data[i] = ~~(buf[i] * 255)
      }

      this.byteBuffer = idata.data
      g.putImageData(idata, 0, 0)
    } else if (this.type === ImageTypes.BYTE_BUFFER) {
      idata = new ImageData(this.width, this.height)
      const a = this.byteBuffer
      const b = idata.data

      if (a === undefined) {
        // eslint-disable-next-line no-console
        console.warn('missing byte buffer')
        return
      }
      b.set(a)
      /*
      for (let i=0; i<a.length; i++) {
        b[i] = a[i];
      }//*/

      g.putImageData(idata, 0, 0)
    }

    if (!idata) {
      idata = g.getImageData(0, 0, canvas.width, canvas.height)
    }

    this.ready = false

    this._image = document.createElement('img') as HTMLImageElementTex
    this._image.src = canvas.toDataURL()
    this._image.image = idata
    this._image.onload = () => {
      this._firePromises()
    }

    return this._image
  }

  exec() {
    this.outputs.depend.graphUpdate()
  }

  getImage() {
    this.update()

    return new Promise((accept, reject) => {
      if (!this.ready) {
        this._promises.push({accept, reject})
      } else {
        accept(this._image)
      }
    })
  }

  _save() {
    if (this.type === ImageTypes.URL) {
      return this.url
    }

    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d')!
    let ok = false
    let dataurl = ''
    let idata

    canvas.width = this.width
    canvas.height = this.height

    let type = this.type

    if (this.gpuHasData) {
      this.downloadFromGL()
      type = ImageTypes.FLOAT_BUFFER
    }

    if (type === ImageTypes.FLOAT_BUFFER) {
      const fbuf = this.floatBuffer!
      idata = new ImageData(this.width, this.height)
      const ibuf = idata.data

      for (let i = 0; i < ibuf.length; i++) {
        ibuf[i] = ~~(fbuf[i] * 255)
      }
    } else if (type === ImageTypes.BYTE_BUFFER) {
      idata = new ImageData(this.width, this.height)
      if (this.byteBuffer!.length > 0) {
        idata.data.set(this.byteBuffer!)
      }
    }

    if (idata) {
      g.putImageData(idata, 0, 0)
      dataurl = canvas.toDataURL()

      ok = true
    }

    if (!ok && this._image) {
      dataurl = this._image.src
    }

    return dataurl
  }

  loadSTRUCT(reader: StructReader<this>): void {
    super.loadSTRUCT(reader)

    if (this.type !== ImageTypes.GENERATED) {
      this.type = ImageTypes.URL
    }
  }

  static nodedef() {
    return {
      name  : 'image',
      uiname: 'Image',
      inputs: {},

      outputs: {
        depend: new DependSocket(),
      },
      flag   : NodeFlags.SAVE_PROXY,
    }
  }
}

DataBlock.register(ImageBlock)

export class ImageUser {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
ImageUser {
  image       : DataRef | DataRef.fromBlock(this.image);
}`
  )

  image: ImageBlock | undefined

  constructor(image?: ImageBlock) {
    this.image = image
  }

  load(b: this) {
    this.image = b.image
    return this
  }

  dataLink(ownerBlock: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    this.image = getblock_addUser(this.image as unknown as DataRef<ImageBlock>, ownerBlock)
  }

  calcUpdateKey(digest = new util.HashDigest()): number {
    if (this.image && typeof this.image === 'number') {
      digest.add(this.image)
    } else if (this.image && this.image instanceof ImageBlock) {
      this.image.calcUpdateKey(digest)
    } else {
      digest.add(1)
    }

    return digest.get()
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = struct ?? api.mapStruct(this, true)

    st.struct('image', 'image', 'Image', api.mapStruct(ImageBlock))

    return st
  }
}

registerDataAPI(ImageBlock)
registerDataAPI(ImageUser)
