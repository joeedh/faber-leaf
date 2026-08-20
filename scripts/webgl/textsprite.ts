import {Texture, IUniformsBlock, ShaderProgram} from './webgl'
import {css2color} from '../path.ux/scripts/core/ui_theme'
import {CSSFont} from '../path.ux/scripts/core/cssfont'
import {SimpleMesh, LayerTypes} from './simplemesh'
import {loadShader, PolygonOffset} from '../shaders/shaders'
import {Vector2, Vector2Like, Vector3, Vector4, Matrix4} from '../util/vectormath'
import {getAppState} from '../core/app_instance'

export class FontEncoding {
  map: {[k: number]: number}
  characters: string

  constructor() {
    this.map = {}
    this.characters = ''
  }

  add(chr: number | string): void {
    let i: number
    if (typeof chr === 'number') {
      i = chr
      chr = String.fromCharCode(chr)
    } else {
      i = chr.charCodeAt(0)
    }

    this.map[i] = this.characters.length
    this.characters += chr
  }
}

const latin_1: FontEncoding = new FontEncoding()

for (let i = 97; i <= 122; i++) {
  latin_1.add(i)
}
for (let i = 65; i <= 90; i++) {
  latin_1.add(i)
}
for (let i = 48; i <= 57; i++) {
  latin_1.add(i)
}
let extra: string = `<>?,./;':"[]{}|\``
extra += `!@#$%^&*()_+-=~`

for (let i = 0; i < extra.length; i++) {
  latin_1.add(extra[i])
}

latin_1.add(0x20ac) //euro symbol

/*included in extended charset below
latin_1.add(0x00bf); //upside down question mark
latin_1.add(0x00B0); //degrees symbol
*/

//extended characters
for (let i = 161; i < 255; i++) {
  latin_1.add(i)
}

export const TextShader: {
  vertex: string
  fragment: string
  uniforms: {
    polygonOffset: number
    size: number[]
    outlineWidth: number
    outlineColor: number[]
  }
  attributes: string[]
} = {
  vertex: `precision mediump float;  
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;

uniform vec2 size;
uniform mat4 projectionMatrix;
uniform mat4 objectMatrix;
uniform mat4 normalMatrix;
uniform vec2 shift;

${PolygonOffset.pre}

varying vec4 vColor;
varying vec2 vUv;

void main() {
  vec4 p = objectMatrix * vec4(position, 1.0);
  p = projectionMatrix * vec4(p.xyz, 1.0);
  
  ${PolygonOffset.vertex('p')}
  p.xy += shift*p.w;
  gl_Position = p;
  
  vUv = uv;
  vColor = color;
}

  `,

  fragment: `precision mediump float;
uniform float alpha;

uniform sampler2D font;

varying vec4 vColor;
varying vec2 vUv;
${PolygonOffset.pre}

uniform vec4 outlineColor;
uniform float outlineWidth;

void main() {
  vec2 uv = vUv;
  vec4 f = texture2D(font, uv);
  float alpha = f[2];
  float outline = f[0];
  vec4 color = vColor;
  
  float th = 0.05;
  
  if (outline > th) {
    float mixf = alpha;
    
    mixf = 1.0 - mixf;
    color = mix(color, outlineColor, mixf);
    
    float alpha2 = (outline-th) / (1.0 - th);
    alpha2 = min(alpha2/(th*0.5), 1.0);
    
    alpha = max(alpha, alpha2);
  }
  
  if (alpha < 0.1) {
    discard;
  }
  
  ${PolygonOffset.fragment}
  
  gl_FragColor = vec4(color.rgb, color.a*alpha);
}
  `,

  uniforms: {
    polygonOffset: 0.0,
    size         : [512, 512],
    outlineWidth : 1.0,
    outlineColor : [1, 1, 1, 1],
  },

  attributes: ['position', 'uv', 'color'],
}

let glShader: ShaderProgram | undefined = undefined

export const encoding: FontEncoding = latin_1
export const defaultFontName: string = 'sans-serif'

export const FONTSCALE: number = 1.0 / 64

interface ExtendedSimpleMesh extends SimpleMesh {
  lastColor?: string | number[]
  lastPos?: number[]
}

export class SpriteFontSheet {
  encoding: FontEncoding
  size: number
  kerning: {[k: number]: number}
  font: CSSFont
  cells?: number
  cellsize?: number
  canvas?: HTMLCanvasElement
  g?: CanvasRenderingContext2D
  glTex?: Texture

  constructor(encoding_: FontEncoding, size: number, font: CSSFont) {
    this.encoding = encoding_
    this.size = size
    this.kerning = {}
    this.font = font
  }

  render(): void {
    const chars = this.encoding.characters
    const cells = Math.ceil(Math.sqrt(chars.length))
    const cellsize = this.size
    const font = this.font

    const blur = Math.max(~~(this.size * 0.3), 2)

    this.cells = cells
    this.cellsize = cellsize

    font.size = this.size - 2

    const width = cellsize * cells
    const height = cellsize * cells

    const canvas = (this.canvas = document.createElement('canvas'))
    const g = (this.g = canvas.getContext('2d')!)

    canvas.width = width
    canvas.height = height

    //*
    g.shadowBlur = blur
    g.shadowColor = 'red'

    g.beginPath()
    g.fillStyle = 'black'
    g.rect(0, 0, canvas.width, canvas.height)
    g.fill()
    //*/

    g.fillStyle = 'rgb(0, 255, 255)'
    g.strokeStyle = 'rgb(0, 255, 255)'

    g.font = font.genCSS(this.size * 2 - 2)
    g.font = ~~this.size + 'px sans-serif'
    canvas.style['font'] = g.font

    //canvas.font = font.genCSS(this.size*2-2);

    console.log(g.font, g.fillText) //font.genCSS(this.size*2-2));

    /*
    g.beginPath();
    for (let i=0; i<chars.length; i++) {
      let x = i % cells, y = ~~(i / cells);

      x *= cellsize;
      y *= cellsize;
      g.rect(x, y, x+cellsize, y+cellsize);
    }
    g.stroke();
    //*/

    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      const ci = chars.charCodeAt(i)
      const s = 0.7

      const w = g.measureText(c).width * s
      this.kerning[ci] = w

      let x = i % cells
      let y = ~~(i / cells)

      y += 0.8

      x *= cellsize
      y *= cellsize

      x += 0

      g.scale(s, s)
      g.fillText(c, x / s, y / s)
      g.scale(1 / s, 1 / s)
    }
  }

  startMesh(): ExtendedSimpleMesh {
    const sm = new SimpleMesh(LayerTypes.LOC | LayerTypes.UV | LayerTypes.COLOR) as ExtendedSimpleMesh

    sm.lastColor = 'white'
    sm.lastPos = [0, 0, 0]

    return sm
  }

  appendMesh(smesh: ExtendedSimpleMesh, text: string, color: string | number[] = smesh.lastColor!): void {
    for (let i = 0; i < text.length; i++) {
      this.appendChar(smesh, text[i], color)
    }
  }

  appendChar(smesh: ExtendedSimpleMesh, char: string, color: string | number[] = smesh.lastColor!): void {
    const charCode = char.charCodeAt(0)

    const i = this.encoding.map[charCode]

    let colorVec: Vector4
    if (typeof color === 'string') {
      colorVec = css2color(color)
    } else {
      colorVec = color.length < 4 ? new Vector4([color[0], color[1], color[2], 1.0]) : new Vector4(color)
    }
    const scale = FONTSCALE
    const margin = 0.0

    const x = smesh.lastPos![0]
    const d = this.size
    const w = this.kerning[charCode] * 2.0

    smesh.lastPos![0] += w * scale

    const vs = [new Vector3([-w, d, 0]), new Vector3([-w, -d, 0]), new Vector3([w, -d, 0]), new Vector3([w, d, 0])]

    for (const v of vs) {
      v.mulScalar(scale)
      v[0] += x
    }

    const ux = (i % this.cells!) / this.cells!
    const uy = ~~(i / this.cells!) / this.cells!
    const uxscale = w / this.size

    const m = margin

    const uvs = [new Vector2([-m, -m]), new Vector2([-m, 1 + m]), new Vector2([1 + m, 1 + m]), new Vector2([1 + m, -m])]

    for (let j = 0; j < 4; j++) {
      uvs[j].mulScalar(1.0 / this.cells!)
      uvs[j][0] *= uxscale

      uvs[j][0] += ux
      uvs[j][1] += uy
    }

    const quad = smesh.quad(vs[0], vs[1], vs[2], vs[3])
    quad.uvs(uvs[0], uvs[1], uvs[2], uvs[3])
    quad.colors(colorVec, colorVec, colorVec, colorVec)
  }

  makeTex(gl: WebGL2RenderingContext): void {
    const canvas = this.canvas!

    const data = this.g!.getImageData(0, 0, canvas.width, canvas.height)

    const tex = Texture.load(gl, canvas.width, canvas.height, data.data)

    gl.bindTexture(gl.TEXTURE_2D, tex.texture!)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)

    this.glTex = tex
  }

  drawMeshScreenSpace(
    gl: WebGL2RenderingContext,
    smesh: SimpleMesh,
    co: Vector2Like,
    uniforms: IUniformsBlock = {}
  ): void {
    uniforms = Object.assign({}, uniforms)

    uniforms.objectMatrix = new Matrix4()
    uniforms.projectionMatrix = new Matrix4()

    let aspect = 1.0
    if (uniforms.aspect) {
      aspect = uniforms.aspect
    }

    let scale = 0.05 / this.size
    scale /= FONTSCALE

    uniforms.projectionMatrix.translate(co[0], co[1], 0.0)
    uniforms.projectionMatrix.scale(scale / aspect, scale, scale)

    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)

    this.drawMesh(gl, smesh, uniforms)
  }

  drawMesh(gl: WebGL2RenderingContext, smesh: SimpleMesh, uniforms: IUniformsBlock): void {
    if (!this.glTex) {
      this.makeTex(gl)
    }

    if (glShader === undefined) {
      glShader = loadShader(gl, TextShader)
    }

    uniforms.font = this.glTex

    smesh.draw(gl, uniforms, glShader)
  }

  onContextLost(e: WebGLContextEvent): void {
    this.glTex = undefined
  }
}

export function onContextLostTexSprite(e: WebGLContextEvent): void {
  glShader = undefined
}

export class SpriteFont {
  sheets: {[k: number]: SpriteFontSheet}
  font: CSSFont
  gl?: WebGL2RenderingContext

  constructor(font: string | CSSFont) {
    if (typeof font === 'string') {
      font = new CSSFont({
        font: font,
      })
    }

    this.sheets = {}
    this.font = font
  }

  update(gl: WebGL2RenderingContext): void {
    if (this.gl === undefined) {
      this.gl = gl
    }

    if (glShader === undefined) {
      glShader = loadShader(gl, TextShader)
    }
  }

  onContextLost(e: WebGLContextEvent): void {
    for (const k in this.sheets) {
      this.sheets[k].onContextLost(e)
    }
  }

  getSheet(size: number = 64): SpriteFontSheet {
    const dpi = devicePixelRatio

    size = ~~(size * dpi)
    size = Math.max(size, 10)

    if (!(size in this.sheets)) {
      this.sheets[size] = new SpriteFontSheet(encoding, size, this.font)
      this.sheets[size].render()
    }

    return this.sheets[size]
  }
}

export const defaultFont = new SpriteFont(defaultFontName)

let testCanvas: HTMLCanvasElement | undefined = undefined

declare global {
  interface Window {
    test_sprite_fonts: (size?: number, fontName?: string) => void
  }
}

window.test_sprite_fonts = function (size: number = 12, fontName: string = 'sans-serif'): void {
  if (testCanvas !== undefined) {
    testCanvas.remove()
  }

  const font = new CSSFont({
    font : fontName,
    color: 'black',
  })

  const sheet = new SpriteFontSheet(encoding, size, font)
  sheet.render()

  const canvas = sheet.canvas!

  canvas.style.position = 'absolute'
  canvas.style.zIndex = '2'
  canvas.style.left = '10px'
  canvas.style.top = '10px'
  testCanvas = canvas

  document.body.appendChild(canvas)
}

let _testmesh: ExtendedSimpleMesh | undefined = undefined
export function testDraw(gl: WebGL2RenderingContext, uniforms: IUniformsBlock): void {
  let mesh = _testmesh
  const font = defaultFont.getSheet(24)

  if (mesh === undefined) {
    mesh = _testmesh = font.startMesh()
    font.appendMesh(mesh, 'yay', 'black')
    font.appendMesh(mesh, 'yay2', 'blue')
  }

  font.drawMesh(gl, mesh, uniforms)

  const appstate = getAppState()
  const co = new Vector2(appstate.screen!.mpos)
  const view3d = appstate.ctx.view3d

  co[0] = (co[0] - view3d.glPos[0]) / view3d.glSize[0]
  co[1] = (co[1] - view3d.glPos[1]) / view3d.glSize[1]

  co[0] = co[0] * 2.0 - 1.0
  co[1] = co[1] * 2.0 - 1.0
  co[1] = -co[1]

  font.drawMeshScreenSpace(gl, mesh, co, uniforms)
}
