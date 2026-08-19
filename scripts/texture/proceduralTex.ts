import {Icons} from '../editors/icon_enum.js'
import {
  EnumProperty,
  nstructjs,
  Vec3Property,
  FloatProperty,
  Vec4Property,
  Vec2Property,
  Vector2,
  Vector3,
  Vector4,
  Matrix4,
  util,
  ToolProperty,
  DataAPI,
  DataStruct,
  IVector3,
  Container,
  CallbackThis,
} from '../path.ux/scripts/pathux.js'
import {DataBlock} from '../core/lib_api'
import {NodeFlags} from '../core/graph'
import {DependSocket} from '../core/graphsockets'

import {
  ITextureShaderDef,
  TexProperty,
  TexPropertyBlock,
  TexPropTypeBase,
  TextureShader,
  TextureShaderFlags,
} from './texture_base.js'
import {compileTexShaderJS} from './textureGen'
import './textures.js'
import {TexPaintShaderLib} from '../shaders/shaders.js'
import {IUniformsBlock} from '../webgl/webgl'
import type {CompiledJS} from '../mathl/index.ts'
import {HashDigest} from '../util/util.js'
import {StructReader} from '../path.ux/scripts/util/nstructjs.js'
import type {ViewContext} from '../core/context.js'

export enum PatternRecalcFlags {
  PREVIEW = 1,
}

export enum PatternFlags {
  SELECT = 1,
}

export enum TexUserFlags {
  SELECT = 1,
  RAKE = 2,
  CONSTANT_SIZE = 4,
  FANCY_RAKE = 8,
  ORIGINAL_CO = 16,
  CURVED = 32,
}

export enum TexUserModes {
  GLOBAL = 0,
  VIEWPLANE = 1,
  VIEW_REPEAT = 2,
}

const patternsNameMap: {[k: string]: IPatternConstructor} = {}
export const Patterns: IPatternConstructor[] = []

//const _dv_rets = new util.cachering(() => [new Vector3(), new Vector3(), new Vector3()], 1024)
const _dv_cos = util.cachering.fromConstructor(Vector3, 1024)
//const out_temps = [0, 0, 0, 0, 0]
const eval_temps = new util.cachering(
  () => [new Array(5), new Vector3(), new Vector3(), 0.0, new Vector4()] as const,
  64
)

function createShaderClass(
  base: PatternGen,
  patternDefine: IPatternDef,
  uniformProps: TexPropertyBlock,
  uniforms: IUniformsBlock
) {
  return class Shader extends TextureShader {
    static textureDefine() {
      return {
        typeName   : patternDefine.typeName,
        flag       : TextureShaderFlags.HAS_COLOR,
        uniforms   : uniformProps,
        params: {
          inP: new Vec3Property(),
        },
        fragmentPre: TexPaintShaderLib + '\n' + base.genGlslPre('Point', 'Color', uniforms) + '\n',
      } as ITextureShaderDef
    }

    genCode() {
      const s = base.genGlsl('Point', 'Color', uniforms)

      return `
float fsample(inout vec3 Point, inout vec3 Normal, float Time, inout vec4 Color) {
  ${s}
}        

        `
    }
  }
}

export type TexGeneratedShader = ReturnType<typeof createShaderClass>

export type IPatternDef = {
  typeName: string
  uiName?: string
  defaultName?: string
  icon?: number
  flag?: number
  uniforms?: IUniformsBlock
}

export interface IPatternConstructor<T = unknown> {
  new (): T

  STRUCT: string

  defineAPI(api: DataAPI): DataStruct

  patternDefine(): IPatternDef

  buildSettings(container: Container<ViewContext>): void
}

export type TexJSArgs = {[k: string]: TexPropTypeBase}

export class PatternGen {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  PatternGen {
    flag : int;
    name : string;
  }`
  );

  ['constructor']: IPatternConstructor<this> = this['constructor']

  flag: number = 0
  name: string = ''
  texShaderJS?: CompiledJS
  texShaderJSHash: number = 0

  constructor() {
    const def = this.constructor.patternDefine()

    this.flag = def.flag !== undefined ? def.flag : 0
    this.name = def.defaultName !== undefined ? def.defaultName : 'pattern'
  }

  static safeFloat(f: number) {
    let sf = '' + f
    if (sf.search(/\./) < 0) {
      sf += '.0'
    }
    return sf
  }

  static patternDefine() {
    return {
      typeName   : '',
      uiName     : '',
      defaultName: '',
      icon       : -1,
      flag       : 0,
      uniforms   : {},
    } as IPatternDef
  }

  static defineAPI(api: DataAPI) {
    const st = api.mapStruct(this, true)

    st.flags('flag', 'flag', PatternFlags, 'Flag')
    st.string('name', 'name', 'Name')

    return st
  }

  //container.pathPrefix is set to point to correct location

  static buildSettings(container: Container<ViewContext>) {}

  static getGeneratorClass(name: string): IPatternConstructor {
    return patternsNameMap[name]
  }

  static register<T>(cls: IPatternConstructor<T>) {
    if (!nstructjs.isRegistered(cls)) {
      throw new Error('You forgot to register ' + cls.name + ' with nstructjs')
    }

    if (cls.patternDefine().typeName in patternsNameMap) {
      throw new Error('Pattern ' + cls.name + ' does not have a unique typeName in its patternDefine')
    }

    patternsNameMap[cls.patternDefine().typeName] = cls
    Patterns.push(cls)
  }

  genTexShader() {
    const uniforms = {
      angle: 0.0,
    } as IUniformsBlock

    this.bindUniforms(uniforms)

    const uniformProps: {[k: string]: ToolProperty<any>} = {}

    for (const k in uniforms) {
      let v = uniforms[k]

      if (typeof v === 'number' || typeof v === 'boolean') {
        v = new FloatProperty(v as number)
        uniforms[k] = v
      } else if (Array.isArray(v)) {
        switch (v.length) {
          case 2:
            v = new Vec2Property(v as unknown as Vector2)
            break
          case 3:
            v = new Vec3Property(v as unknown as Vector3)
            break
          case 4:
            v = new Vec4Property(v as unknown as Vector4)
            break
          default:
            console.error('Texture uniform error', k, v)
        }

        uniformProps[k] = v
      }
    }

    const patternDefine = this.constructor.patternDefine()

    const Shader = createShaderClass(this, patternDefine, uniformProps, uniforms)
    const shader = compileTexShaderJS(new Shader())

    this.texShaderJS = shader

    const digest = new util.HashDigest()
    this.calcUpdateHash(digest, true)

    this.texShaderJSHash = digest.get()
    console.log('SHADER:', shader)
  }

  checkTexShaderJS() {
    const digest = new util.HashDigest()
    this.calcUpdateHash(digest, true)
    const hash = digest.get()

    if (!this.texShaderJS || hash !== this.texShaderJSHash) {
      this.genTexShader()
    }
  }

  genGlsl(inputP: string, outputC: string, uniforms: any): string {
    console.error('Implement me! genGlsl!')
    return ''
  }

  genGlslPre(inC: string, outP: string, uniforms: any = {}) {
    const uniforms2 = this.constructor.patternDefine().uniforms || {}

    let pre = ''

    for (const k in uniforms2) {
      const v = uniforms2[k]

      pre += `uniform ${v} ${k};\n`
    }

    return pre
  }

  bindUniforms(uniforms: IUniformsBlock) {
    const uniforms2 = this.constructor.patternDefine().uniforms || {}

    for (const k in uniforms2) {
      uniforms[k] = (this as unknown as IUniformsBlock)[k]
    }

    return this
  }

  copy() {
    const ret = new this.constructor()

    this.copyTo(ret)

    return ret
  }

  copyTo(b: this): void {
    b.flag = this.flag
  }

  calcUpdateHash(digest: HashDigest, recompileOnly = false): void {}

  evaluate(co: Vector3, color_out?: Vector3): number {
    this.checkTexShaderJS()

    const texShaderJS = this.texShaderJS!

    const args = eval_temps.next()

    texShaderJS.setInput(texShaderJS.inputTypes.Time.index, performance.now() / 1000.0)

    const pointIdx = texShaderJS.inputTypes.Point.index
    const point = texShaderJS.getInput<number[]>(pointIdx)

    point[0] = co[0]
    point[1] = co[1]
    point[2] = co[2]

    this.bindUniforms(texShaderJS.uniforms)
    texShaderJS.call()
    return texShaderJS.outputs[texShaderJS.outputTypes.Value.index] as number
  }

  derivative(co: Vector3): Vector3 {
    const co2 = _dv_cos.next().load(co)
    let df = 0.00015

    const a = this.evaluate(co)
    co2[0] += df

    const b = this.evaluate(co2)
    co2.load(co)
    co2[1] += df

    const c = this.evaluate(co2)
    co2.load(co)
    co2[2] += df
    const d = this.evaluate(co2)

    df = 1.0 / df

    co2[0] = (b - a) / df
    co2[1] = (c - a) / df
    co2[2] = (d - a) / df

    /*
    b.sub(a).mulScalar(df);
    c.sub(a).mulScalar(df);
    d.sub(a).mulScalar(df);

    const ret = _dv_rets.next()
    ret[0] = b;
    ret[1] = c;
    ret[2] = d;
     */

    return co2
  }
}

const sntmps = util.cachering.fromConstructor(Vector3, 32)

function hash(f: number): number {
  //return Math.fract(f*31.23423 + Math.fract(f*23324.2343));
  const sign = f < 0 ? -1 : 1
  f *= sign

  let f2 = f - ~~f
  f2 = sign < 0 ? 1.0 - f2 : f2

  f = f * 3.316624 * 128.0 * f2

  const sign2 = f < 0.0
  f -= ~~f

  if (sign2) {
    f = 1.0 - f
  }

  //f = Math.fract(f*Math.sqrt(11.0)*Math.sin(f));

  return f
  return Math.fract(1.0 / Math.fract(0.00001 * f + 0.00001))
}

function hash3(x: number, y: number, z: number) {
  const f = x * Math.sqrt(3.0) + y * Math.sqrt(5.0) * 10.0 + z * Math.sqrt(7.0) * 100.0
  return hash(f)
  //return hash(x*y*z + x*x + y*y + z*x);
}

export class SimpleNoise extends PatternGen {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  SimpleNoise {
    levels     : float;
    levelScale : float;
    zoff       : float;
    factor     : float;
  }`
  )

  levels = 5
  levelScale = 3.0

  factor = 0.0

  //for debugging purposes
  zoff = 0.0

  constructor() {
    super()
  }

  static defineAPI(api: DataAPI): DataStruct {
    const st = super.defineAPI(api)

    st.float('zoff', 'zoff', 'Zoffs').noUnits().range(-100, 100)
    st.float('levels', 'levels', 'Levels').noUnits().range(1, 15)
    st.float('levelScale', 'levelScale', 'Level Scale').noUnits().range(0.001, 10.0)
    st.float('factor', 'factor', 'factor').noUnits().range(0.0, 1.0)

    return st
  }

  static buildSettings(container: Container<ViewContext>): void {
    container.prop('levels')
    container.prop('levelScale')
    container.prop('factor')

    container.prop('zoff')
  }

  static patternDefine() {
    return {
      typeName   : 'SimpleNoise',
      defaultName: 'noise',
      uiName     : 'Noise',
    }
  }

  copyTo(b: this) {
    super.copyTo(b)

    b.levels = this.levels
    b.levelScale = this.levelScale
    b.zoff = this.zoff
    b.factor = this.factor
  }

  calcUpdateHash(digest: util.HashDigest, recompileOnly?: boolean): void {
    digest.add(this.levels)
    digest.add(this.levelScale)
    digest.add(this.zoff)
    digest.add(this.factor)
  }

  evaluate(co: Vector3): number {
    co = sntmps.next().load(co)

    let scale = Math.pow(this.levelScale, this.levels)
    const f = this.evaluate_intern(co, scale)

    let f1 = f
    let f2 = f
    let tot = 1.0

    const lscale = 1.0 / this.levelScale

    for (let i = 0; i < this.levels; i++) {
      const rf = i + 1

      co[0] += hash(rf) * 1024.23432
      co[1] += hash(rf + 0.234) * 1024.523
      co[2] += hash(rf + 0.345) * 1024.234

      scale *= lscale

      const f3 = this.evaluate_intern(co, scale)

      f1 *= f3
      f2 += f3

      tot++
    }

    if (tot === 0.0) {
      return 0.0
    }

    f1 = Math.pow(f1, 1.0 / tot)
    f2 /= tot

    return f1 + (f2 - f1) * this.factor
  }

  evaluate_intern(co: Vector3, scale: number): number {
    const x = co[0] * scale
    const y = co[1] * scale
    const z = co[2] * scale + this.zoff

    let u = Math.fract(x)
    let v = Math.fract(y)
    let w = Math.fract(z)

    function hash3(x: number, y: number, z: number) {
      const f = x * Math.sqrt(3.0) + y * Math.sqrt(5.0) * 10.0 + z * Math.sqrt(7.0) * 100.0
      return Math.fract(hash(f))
      //return hash(x*y*z + x*x + y*y + z*x);
    }

    const cx = Math.floor(x)
    const cy = Math.floor(y)
    const cz = Math.floor(z)

    const h1 = hash3(cx, cy, cz)

    const h2 = hash3(cx, cy + 1, cz)
    const h3 = hash3(cx + 1, cy + 1, cz)
    const h4 = hash3(cx + 1, cy, cz)

    const h5 = hash3(cx, cy, cz + 1)
    const h6 = hash3(cx, cy + 1, cz + 1)
    const h7 = hash3(cx + 1, cy + 1, cz + 1)
    const h8 = hash3(cx + 1, cy, cz + 1)

    u = u * u * (3.0 - 2.0 * u)
    v = v * v * (3.0 - 2.0 * v)
    w = w * w * (3.0 - 2.0 * w)

    const a = h1 + (h2 - h1) * v
    const b = h4 + (h3 - h4) * v
    const r1 = a + (b - a) * u

    const c = h5 + (h6 - h5) * v
    const d = h8 + (h7 - h8) * v
    const r2 = c + (d - c) * u

    return r1 + (r2 - r1) * w
  }
}

PatternGen.register(SimpleNoise)

const mevals = util.cachering.fromConstructor(Vector3, 64)

export class MoireNoise extends PatternGen {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  MoireNoise {
    dynamicAngle : bool;
    angleOffset  : float; 
  }`
  )

  dynamicAngle = false
  angleOffset = 0.0

  constructor() {
    super()
  }

  static defineAPI(api: DataAPI): DataStruct {
    const st = super.defineAPI(api)

    st.bool('dynamicAngle', 'dynamicAngle', 'Rake Mode')
    st.float('angleOffset', 'angleOffset', 'Angle')
      .displayUnit('degree')
      .baseUnit('radian')
      .range(-Math.PI * 2, Math.PI * 2)

    return st
  }

  static buildSettings(container: Container<ViewContext>): void {
    container.prop('angleOffset')
    container.prop('dynamicAngle')
  }

  static patternDefine() {
    return {
      typeName   : 'MoireNoise',
      defaultName: 'Moire',
      uiName     : 'Moire',
      uniforms: {
        angleOffset: 'float',
      },
    }
  }

  copyTo(b: this) {
    super.copyTo(b)

    b.dynamicAngle = this.dynamicAngle
    b.angleOffset = this.angleOffset
  }

  calcUpdateHash(digest: util.HashDigest, recompileOnly?: boolean): void {
    digest.add(this.dynamicAngle)
    digest.add(this.angleOffset)
  }

  genGlsl(inputP: string, outputC: string, uniforms: any) {
    let th = PatternGen.safeFloat(this.angleOffset)

    if (uniforms.brushAngle !== undefined) {
      th = `(${th} + brushAngle)`
    }

    return `
  
  
  vec3 p = ${inputP};
  vec2 p2 = rot2d(p.xy, ${th});
  
  float dx1 = 1.0 - abs(fract(p2.x)-0.5)*2.0;
  float dy1 = 1.0 - abs(fract(p2.y)-0.5)*2.0;
  float dx2 = 1.0 - abs(fract(p.x)-0.5)*2.0;
  float dy2 = 1.0 - abs(fract(p.y)-0.5)*2.0;
  
  //float f = pow(dx1*dy1*dx2*dy2, 1.0/4.0);
  float f = (dx1+dx2+dy1+dy2)*0.25;
  
  f = cos(f*13.11432)*0.5 + 0.5;
  
  ${outputC} = vec4(f, f, f, 1.0);
`
  }

  evaluate(co: Vector3): number {
    const p = mevals.next().load(co)
    const p2 = mevals.next().load(co)

    p.mulScalar(5.0)

    p2.rot2d(this.angleOffset)

    const fract = Math.fract
    const abs = Math.abs
    const cos = Math.cos

    const dx1 = 1.0 - abs(fract(p2[0]) - 0.5) * 2.0
    const dy1 = 1.0 - abs(fract(p2[1]) - 0.5) * 2.0
    const dx2 = 1.0 - abs(fract(p[0]) - 0.5) * 2.0
    const dy2 = 1.0 - abs(fract(p[1]) - 0.5) * 2.0

    //let f = pow(dx1*dy1*dx2*dy2, 1.0/4.0);
    let f = (dx1 + dx2 + dy1 + dy2) * 0.25

    f = cos(f * 13.11432) * 0.5 + 0.5

    return f
  }
}

PatternGen.register(MoireNoise)

export const CombModes = {
  SAW     : 0,
  TENT    : 1,
  SIN     : 2,
  STEP    : 3,
  DOME    : 4,
  RAW_STEP: 5,
}

const ModeFuncs = {
  [CombModes.SAW]     : Math.fract,
  [CombModes.TENT]    : Math.tent,
  [CombModes.SIN]     : (f: number) => Math.sin(f * Math.PI * 2.0) * 0.5 + 0.5,
  [CombModes.RAW_STEP]: (f: number) => (Math.fract(f) > 0.5 ? 1.0 : 0.0),
  [CombModes.DOME]    : (f: number) => Math.abs(Math.sin(f * Math.PI * 2.0)),
  [CombModes.STEP]: (f: number) => {
    f = Math.tent(f)
    f = f * 2.0

    f = Math.min(Math.max(f, 0.0), 1.0)

    return f
  },
}

export class CombPattern extends PatternGen {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  CombPattern {
    angleOffset  : float; 
    count        : float;
    mode         : int;
    combWidth    : float;
    blackPoint   : float;
  }`
  )

  count = 1
  angleOffset = 0.0
  mode = CombModes.STEP
  combWidth = 0.5
  blackPoint = 0.5

  constructor() {
    super()
  }

  static defineAPI(api: DataAPI): DataStruct {
    const st = super.defineAPI(api)

    st.enum('mode', 'mode', CombModes, 'Mode')

    st.float('angleOffset', 'angleOffset', 'Angle')
      .displayUnit('degree')
      .baseUnit('radian')
      .range(-Math.PI * 2, Math.PI * 2)

    st.float('combWidth', 'combWidth', 'Width', 'Comb Width').range(0.0, 1.0).step(0.01).noUnits()

    st.float('blackPoint', 'blackPoint', 'Black Point').range(0.0, 1.0).step(0.1).noUnits()

    st.float('count', 'count', 'Count', 'Number of strokes').range(1.0, 5.0).step(0.15).noUnits()

    return st
  }

  static buildSettings(container: Container<ViewContext>): void {
    container.prop('mode')
    container.prop('count')
    container.prop('angleOffset')
    container.prop('combWidth')
    container.prop('blackPoint')
  }

  static patternDefine() {
    return {
      typeName   : 'CombPattern',
      defaultName: 'Comb',
      uiName     : 'Comb',
      uniforms: {
        angleOffset: 'float',
        count      : 'float',
        combWidth  : 'float',
        blackPoint : 'float',
      },
    }
  }

  copyTo(b: this) {
    super.copyTo(b)

    b.blackPoint = this.blackPoint
    b.count = this.count
    b.mode = this.mode
    b.combWidth = this.combWidth
    b.angleOffset = this.angleOffset
  }

  bindUniforms(uniforms: any): this {
    uniforms.blackPoint = this.blackPoint
    uniforms.combWidth = this.combWidth
    uniforms.count = this.count
    uniforms.angleOffset = this.angleOffset
    return this
  }

  calcUpdateHash(digest: util.HashDigest, recompileOnly = false): void {
    digest.add(this.angleOffset)
    digest.add(this.mode)

    if (!recompileOnly) {
      digest.add(this.blackPoint)
      digest.add(this.count)
      digest.add(this.combWidth)
    }
  }

  genGlsl(inputP: string, outputC: string, uniforms: any): string {
    let th = PatternGen.safeFloat(this.angleOffset)
    let line

    const pi2 = Math.PI * 2.0

    switch (this.mode) {
      case CombModes.SAW:
        line = `float f = fract(p.x*count);`
        break

      default:
      case CombModes.TENT:
        line = `float f = tent(p.x*count);`
        break
      case CombModes.SIN:
        line = `float f = sin(p.x*count*${pi2})*0.5 + 0.5;`
        break
      case CombModes.STEP:
        line = `float f = fract(p.x*count) > 0.5 ? 1.0 : 0.0;`
        break
      case CombModes.DOME:
        line = `float f = abs(sin(p.x*count*${pi2}));`
        break
    }

    if (uniforms.angleOffset !== undefined) {
      th = `(${th} + angleOffset)`
    }

    return `
  
  
  vec3 p = ${inputP};
  vec2 p2 = rot2d(p.xy, ${th});

  ${line}
  
  ${outputC} = vec4(f, f, f, 1.0);
`
  }

  evaluate(co: Vector3): number {
    return super.evaluate(co)
    /*
    let d = co[0]*co[0] + co[1]*co[1];
    d = 1.0 - Math.sqrt(d);
    d = Math.fract(d);
    return d;
    //*/

    const p = mevals.next().load(co)
    p.rot2d(this.angleOffset)

    let f = Math.fract(p[0] * this.count)
    const cwid = 1.0 - this.combWidth

    f = Math.min(f * (1.0 + cwid), 1.0)

    const b = this.blackPoint

    return ModeFuncs[this.mode](f) * (1.0 - b) + b
  }
}

PatternGen.register(CombPattern)

export class GaborNoise extends PatternGen {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  GaborNoise {
    levels     : float;
    levelScale : float;
    zoff       : float;
    factor     : float;
    randomness : float;
    decayPower : float;
    decay2     : float;
  }`
  )

  levels = 5
  levelScale = 3.0

  factor = 0.0
  randomness = 0.5
  decayPower = 0.5
  decay2 = 0.5

  //for debugging purposes
  zoff = 0.0

  constructor() {
    super()
  }

  static defineAPI(api: DataAPI): DataStruct {
    const st = super.defineAPI(api)

    st.float('zoff', 'zoff', 'Zoffs').noUnits().range(-100, 100)
    st.float('levels', 'levels', 'Levels').noUnits().range(1, 15)
    st.float('levelScale', 'levelScale', 'Level Scale').noUnits().range(0.001, 10.0)
    st.float('factor', 'factor', 'factor').noUnits().range(0.0, 1.0)
    st.float('randomness', 'randomness', 'randomness').noUnits().range(0.0, 1.0)
    st.float('decayPower', 'decayPower', 'Decay Power').noUnits().range(0.001, 4.0)
    st.float('decay2', 'decay2', 'Decay 2').noUnits().range(0.001, 4.0).step(0.003)

    return st
  }

  static buildSettings(container: Container<ViewContext>): void {
    container.prop('levels')
    container.prop('levelScale')
    container.prop('factor')
    container.prop('randomness')
    container.prop('decayPower')
    container.prop('decay2')

    container.prop('zoff')
  }

  static patternDefine() {
    return {
      typeName   : 'GaborNoise',
      defaultName: 'Gabor',
      uiName     : 'Gabor',
      uniforms: {
        levels    : 'float',
        levelScale: 'float',
        factor    : 'float',
        randomness: 'float',
        decayPower: 'float',
        decay2    : 'float',
        zoff      : 'float',
      },
    }
  }

  copyTo(b: this): void {
    super.copyTo(b)

    b.levels = this.levels
    b.levelScale = this.levelScale
    b.zoff = this.zoff
    b.factor = this.factor
    b.randomness = this.randomness
    b.decayPower = this.decayPower
    b.decay2 = this.decay2
  }

  calcUpdateHash(digest: HashDigest, recompileOnly = false) {
    digest.add(this.levels)
    digest.add(this.levelScale)
    digest.add(this.zoff)
    digest.add(this.factor)
    digest.add(this.randomness)
    digest.add(this.decayPower)
    digest.add(this.decay2)
  }

  evaluate(co: Vector3): number {
    return super.evaluate(co)
    ;`
    co = sntmps.next().load(co)

    let scale = 5.0 //*Math.pow(this.levelScale, this.levels);
    const f = this.evaluate_intern(co, scale)

    return f
    let f1 = f
    let f2 = 0.0
    let tot = 1.0

    const lscale = 1.0 / this.levelScale

    for (let i = 0; i < this.levels; i++) {
      const rf = i + 1

      co[0] += hash(rf) * 1024.0
      co[1] += hash(rf + 0.234) * 1024.0
      co[2] += hash(rf + 0.345) * 1024.0

      scale *= lscale

      const f3 = this.evaluate_intern(co, scale)
      f1 *= f3
      f2 += f3
      tot++
    }

    f1 = Math.pow(f1, 1.0 / tot)
    f2 /= tot

    return f1 + (f2 - f1) * this.factor
    `
  }

  genGlsl(inputP: string, outputC: string, uniforms: any): string {
    const u = uniforms

    return `
    vec3 co = ${inputP} * 5.0;
  
    float x = co[0];
    float y = co[1];
    float z = co[2] + zoff;

    float f = 0.0;
    float tot = 0.0;

    /*

    f := exp(-decay2*r2);
    ff := solve(f-goal, r2);
    ff := part(ff, 1, 2);
    ff := sub(i=0, ff);

    sub(goal=0.1, decay2=1.0, ff);
    **/

    float err = 0.1;
    float decay2 = decay2*2.0;

    const int steps = 2; //int(log(10.0) / decay2);    
    const int n = steps;
    
    int n2 = n*n*2;
    float mul = 1.0/float(n2);

    int ix1 = int(x);
    int iy1 = int(y);
    int iz1 = int(z);

    float factor = factor*10.0 + 1.0;
    float rfac = randomness;
    float efac = decayPower;

    f = 0.0;
    float fmax = 0.0;

    for (int ix = -n; ix <= n; ix++) {
      for (int iy = -n; iy <= n; iy++) {
        for (int iz = -n; iz <= n; iz++) {
          float ix2 = float(ix1 + ix);
          float iy2 = float(iy1 + iy);
          float iz2 = float(iz1 + iz);

          float rx = hash3(ix2, iy2, iz2) - 0.5;
          float ry = hash3(ix2 + 0.234, iy2 + 0.2343, iz2 + 0.63434) - 0.5;
          float rz = hash3(ix2 - 0.274, iy2 + 0.83432, iz2 + 0.123523) - 0.5;

          ix2 += rx*rfac;
          iy2 += ry*rfac;
          iz2 += rz*rfac;

          float dx = x - ix2;
          float dy = y - iy2;
          float dz = z - iz2;

          float dis = ((dx*dx + dy*dy + dz*dz)*mul);
          //dis = min(min(dx*dx, dy*dy), dz*dz)*mul;

          //dx = tent(dx);
          //dy = tent(dy);
          //dz = tent(dz);
          //dis = (dx+dy+dz)/3.0;
          //dis *= dis;

          float dis2 = dis;
          float w = exp(-dis2*decay2);

          dis = pow(dis, efac);

          float f2 = 1.0 - abs(fract(dis*factor) - 0.5)*2.0;

          //f2 = f2*f2*(3.0 - 2.0*f2);

          f += f2*w;
          tot += w;
        }
      }
    }

    //tot = max(tot, 0.0001);
    f /= tot;
    //f = fmax;
    //f = pow(f, 1.0 / tot);

    f = f*1.8;
    ${outputC} = vec4(f, f, f, 1.0);
    `
  }

  evaluate_intern(co: number[], scale: number) {
    const x = co[0] * scale
    const y = co[1] * scale
    const z = co[2] * scale + this.zoff

    let f = 0.0
    let tot = 0.0

    /*

    f := exp(-decay2*r2);
    ff := solve(f-goal, r2);
    ff := part(ff, 1, 2);
    ff := sub(i=0, ff);

    sub(goal=0.1, decay2=1.0, ff);
    **/

    const err = 0.1
    const decay2 = this.decay2 * 2.0

    let steps = Math.log(1.0 / err) / decay2
    steps = Math.ceil(steps)
    steps = Math.min(Math.max(steps, 1), 3)

    const n = steps
    const n2 = n * n * 2.0
    const mul = 1.0 / n2

    const ix1 = Math.floor(x)
    const iy1 = Math.floor(y)
    const iz1 = Math.floor(z)

    const factor = this.factor * 10.0 + 1.0
    const rfac = this.randomness
    const efac = this.decayPower

    f = 0.0
    const fmax = 0.0

    for (let ix = -n; ix <= n; ix++) {
      for (let iy = -n; iy <= n; iy++) {
        for (let iz = -n; iz <= n; iz++) {
          let ix2 = ix1 + ix
          let iy2 = iy1 + iy
          let iz2 = iz1 + iz

          const rx = hash3(ix2, iy2, iz2) - 0.5
          const ry = hash3(ix2 + 0.234, iy2 + 0.2343, iz2 + 0.63434) - 0.5
          const rz = hash3(ix2 - 0.274, iy2 + 0.83432, iz2 + 0.123523) - 0.5

          ix2 += rx * rfac
          iy2 += ry * rfac
          iz2 += rz * rfac

          const dx = x - ix2
          const dy = y - iy2
          const dz = z - iz2

          let dis = (dx * dx + dy * dy + dz * dz) * mul
          //dis = Math.min(Math.min(dx*dx, dy*dy), dz*dz)*mul;

          //dx = Math.tent(dx);
          //dy = Math.tent(dy);
          //dz = Math.tent(dz);
          //dis = (dx+dy+dz)/3.0;
          //dis *= dis;

          const dis2 = dis

          const w = Math.exp(-dis2 * decay2)

          dis = dis ** efac

          const f2 = 1.0 - Math.abs(Math.fract(dis * factor) - 0.5) * 2.0

          //f2 = f2*f2*(3.0 - 2.0*f2);

          f += f2 * w
          tot += w
        }
      }
    }

    //tot = Math.max(tot, 0.0001);
    f /= tot
    //f = fmax;
    //f = Math.pow(f, 1.0 / tot);

    f = f * 1.8
    return f * f * f * f

    const u = Math.fract(x)
    const v = Math.fract(y)
    const w = Math.fract(z)
  }
}

PatternGen.register(GaborNoise)

const evalcos = util.cachering.fromConstructor(Vector3, 512)
const dvcos = util.cachering.fromConstructor(Vector3, 512)

export class ProceduralTex extends DataBlock {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  ProceduralTex {
    scale         : float;
    power         : float;
    brightness    : float;
    contrast      : float;
    generators    : array(abstract(PatternGen));
    generator     : string | this.generator ? this.generator.constructor.patternDefine().typeName : "";  
  }
  `
  )

  updateGen = 0

  generators: PatternGen[] = [] //stored generator instances
  generator: PatternGen

  scale = 1.0
  power = 1.0
  brightness = 0.0
  contrast = 1.0

  recalcFlag = PatternRecalcFlags.PREVIEW
  previews = [] as HTMLCanvasElement[]

  _last_update_hash: string | undefined | number = undefined
  _digest = new util.HashDigest()

  constructor() {
    super()

    this.generator = this.setGenerator(SimpleNoise)
  }

  static getPattern(index_or_typename_or_class: any): IPatternConstructor | undefined {
    const cls = index_or_typename_or_class

    if (typeof cls === 'string') {
      for (const cls2 of Patterns) {
        if (cls2.patternDefine().typeName === cls) {
          return cls2
        }
      }

      return undefined
    } else if (typeof cls === 'number') {
      return Patterns[cls]
    } else {
      return Patterns.includes(cls) ? cls : undefined
    }
  }

  static buildGeneratorEnum(): EnumProperty {
    const enumdef = {} as Record<string, number>
    const uinames = {} as Record<string, string>
    const icons = {} as Record<string, number>
    let i = 0

    for (const cls of Patterns) {
      const def = cls.patternDefine()

      enumdef[def.typeName] = i
      if (def.uiName !== undefined) {
        uinames[def.typeName] = def.uiName
      }
      if (def.icon !== undefined) {
        icons[def.typeName] = def.icon
      }

      i++
    }

    return new EnumProperty(0, enumdef).addUINames(uinames).addIcons(icons)
  }

  static blockDefine() {
    return {
      typeName   : 'texture',
      uiName     : 'Texture',
      defaultName: 'Texture',
      icon       : Icons.RENDER,
    }
  }

  static nodedef() {
    return {
      name   : 'texture',
      uiname : 'Texture',
      flag   : NodeFlags.SAVE_PROXY,
      inputs: {
        depend: new DependSocket(),
      },
      outputs: {
        depend: new DependSocket(),
      },
    }
  }

  calcMemSize(): number {
    return 1024 //just assume a large-ish block of memory
  }

  bindUniforms(uniforms: any): void {
    uniforms['texScale'] = this.scale
    uniforms['texBrightness'] = this.brightness
    uniforms['texContrast'] = this.contrast
    uniforms['texPower'] = this.power

    this.generator.bindUniforms(uniforms)
  }

  genGlsl(inP: string, outC: string, uniforms: any = {}): string {
    uniforms = Object.assign({}, uniforms)
    this.bindUniforms(uniforms)

    return this.generator.genGlsl(inP, outC, uniforms)
  }

  genGlslPre(inP: string, outC: string, uniforms: any = {}): string {
    uniforms = Object.assign({}, uniforms)
    this.bindUniforms(uniforms)

    return (
      `
uniform float texScale;
uniform float texBrightness;
uniform float texContrast;
uniform float texPower;
    ` + this.generator.genGlslPre(inP, outC, uniforms)
    )
  }

  copyTo(b: this, nonDataBlockMode = false): void {
    if (!nonDataBlockMode) {
      super.copyTo(b)
    }

    b.generators.length = 0
    b.generator = undefined as unknown as PatternGen

    for (const gen of this.generators) {
      const gen2 = gen.copy()
      b.generators.push(gen2)
    }

    b.setGenerator(this.generator.constructor)

    b.scale = this.scale
    b.power = this.power
    b.brightness = this.brightness
    b.contrast = this.contrast

    b.previews = this.previews.concat([]) //reuse preview instances
    b.recalcFlag = this.recalcFlag
  }

  //XXX why do we return a bool here?
  update() {
    const digest = this._digest.reset()

    this.generator.calcUpdateHash(digest)

    digest.add(this.scale)
    digest.add(this.power)
    digest.add(this.updateGen)
    digest.add(this.brightness)
    digest.add(this.contrast)

    const hash = digest.get()

    if (hash !== this._last_update_hash) {
      this.recalcFlag |= PatternRecalcFlags.PREVIEW
      this._last_update_hash = hash

      //XXX
      return true as unknown as this
    }

    //XXX
    return false as unknown as this
  }

  buildSettings(container: Container<ViewContext>) {
    container.prop('scale')
    container.prop('brightness')
    container.prop('contrast')
    container.prop('power')

    if (this.generator) {
      const prefix = container.dataPrefix
      container.dataPrefix += '.generator'

      this.generator.constructor.buildSettings(container)

      container.dataPrefix = prefix
    }
  }

  getPreview(width: number, height: number) {
    if (this.recalcFlag & PatternRecalcFlags.PREVIEW) {
      this.previews.length = 0
      this.recalcFlag &= ~PatternRecalcFlags.PREVIEW
    }

    for (const p of this.previews) {
      if (p.width === width && p.height === height) {
        return p
      }
    }

    const p = this.genPreview(width, height)
    this.previews.push(p)

    return p
  }

  genPreview(width: number, height: number): HTMLCanvasElement {
    console.log('generating texture preview')

    const image = new ImageData(width, height)
    const idata = image.data

    const gen = this.generator
    const co = new Vector3()

    for (let i = 0; i < width * height; i++) {
      const ix = i % width
      const iy = ~~(i / height)
      const x = ix / width
      const y = iy / height

      const idx = i * 4

      co[0] = x
      co[1] = y

      let f

      try {
        f = this.evaluate(co)
      } catch (error) {
        util.print_stack(error as Error)
        break
      }

      idata[idx] = idata[idx + 1] = idata[idx + 2] = ~~(f * 255)
      idata[idx + 3] = 255
    }

    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d')!
    canvas.width = width
    canvas.height = height

    g.putImageData(image, 0, 0)

    return canvas
  }

  getGenerator(cls: any) {
    for (const gen of this.generators) {
      if (gen.constructor === cls) {
        return gen
      }
    }

    const gen = new cls()
    this.generators.push(gen)

    return gen
  }

  setGenerator(cls: any) {
    this.generator = this.getGenerator(cls)
    return this.generator
  }

  evaluate(co_: IVector3, scale = 1.0) {
    const co = evalcos.next().load(co_)
    co.mulScalar(this.scale * scale)

    let f = this.generator.evaluate(co)
    f *= this.contrast
    f = Math.pow(f, this.power) + this.brightness

    return f
  }

  derivative(co1: IVector3, scale: number) {
    const co = evalcos.next().load(co1)

    const a = this.evaluate(co, scale)

    const df = 0.00001
    co[0] += df
    const b = this.evaluate(co, scale)

    co.load(co1)
    co[1] += df
    const c = this.evaluate(co, scale)

    co.load(co1)
    co[2] += df
    const d = this.evaluate(co, scale)

    const dv = dvcos.next()

    dv[0] = (b - a) / df
    dv[1] = (c - a) / df
    dv[2] = (d - a) / df

    return dv
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)

    if ((this.generator as unknown as string) === '') {
      console.warn('failed to read active generator')

      if (this.generators.length > 0) {
        this.setGenerator(this.generators[0].constructor)
      } else {
        this.setGenerator(SimpleNoise)
      }
    } else {
      const gen = this.generator as unknown as string
      this.generator = undefined as unknown as PatternGen

      for (const cls of Patterns) {
        if (cls.patternDefine().typeName === gen) {
          this.setGenerator(cls)
        }
      }

      if (!this.generator) {
        this.setGenerator(Patterns[0])
      }
    }
  }
}

DataBlock.register(ProceduralTex)

const _udigest = new util.HashDigest()
const cotmp = new Vector3()

export class ProceduralTexUser {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  ProceduralTexUser {
    texture : DataRef | DataRef.fromBlock(this.texture);
    flag    : int;
    mode    : int;
    scale   : float;
    pinch   : float;
  }`
  )

  texture?: ProceduralTex = undefined
  scale = 1.0
  mode = TexUserModes.GLOBAL
  flag = 0 //see TexUserFlags
  pinch = 0.0

  constructor() {}

  sample(
    co: Vector3,
    texScale: number,
    angle: number,
    rendermat: Matrix4,
    screen_origin: Vector3,
    aspect: number,
    dv_out?: Vector3
  ): number {
    if (this.mode === TexUserModes.VIEWPLANE || this.mode === TexUserModes.VIEW_REPEAT) {
      cotmp.load(co).multVecMatrix(rendermat)

      if (screen_origin) {
        cotmp.sub(screen_origin)
      }

      cotmp[0] *= aspect

      if (this.flag & TexUserFlags.RAKE) {
        cotmp.rot2d(-angle)
      }

      co = cotmp
    }

    if (dv_out) {
      dv_out.load(this.texture!.derivative(co, texScale))
    }

    return this.texture!.evaluate(co, texScale)
  }

  copyTo(b: this): void {
    b.texture = this.texture
    b.scale = this.scale
    b.mode = this.mode
    b.flag = this.flag
    b.pinch = this.pinch
  }

  copy(): ProceduralTexUser {
    const ret = new ProceduralTexUser()
    this.copyTo(ret as this)
    return ret
  }

  equals(b: this): boolean {
    let r = this.texture === b.texture

    function feq(a: number, b: number) {
      return Math.abs(a - b) < 0.00001
    }

    r = r && feq(this.scale, b.scale)
    r = r && this.mode === b.mode
    r = r && this.flag === b.flag
    r = r && feq(this.pinch, b.pinch)

    return r
  }

  calcHashKey(digest: util.HashDigest = _udigest) {
    const d = digest

    d.add(this.scale)
    d.add(this.texture ? this.texture.lib_id : -1)
    d.add(this.mode)
    d.add(this.flag)
    d.add(this.pinch)

    return d.get()
  }

  dataLink(owner: any, getblock: any, getblock_adduser: any): void {
    if (this.texture !== undefined) {
      this.texture = getblock_adduser(this.texture, owner)
    }
  }

  loadSTRUCT(reader: StructReader<this>) {
    reader(this)
  }
}

export function buildProcTextureAPI(
  api: DataAPI<ViewContext>,
  api_define_datablock: <T extends DataBlock>(api: DataAPI<ViewContext>, cls: any) => DataStruct<any, T>
) {
  for (const cls of Patterns) {
    cls.defineAPI(api)
  }

  const st = api_define_datablock<ProceduralTex>(api, ProceduralTex)

  const onchange = function (this: {dataref: ProceduralTex}) {
    this.dataref.updateGen++
    this.dataref.graphUpdate()
  }

  const prop = ProceduralTex.buildGeneratorEnum()
  st.enum('mode', 'mode', prop, 'Mode')
    .on('change', function (this: {dataref: ProceduralTex}) {
      const tex = this.dataref
      tex.recalcFlag |= PatternRecalcFlags.PREVIEW
    })
    .customGetSet(
      function () {
        const tex = this.dataref

        return prop.values[tex.generator.constructor.patternDefine().typeName] as number
      },
      function (val) {
        const tex = this.dataref

        let cls

        if (typeof val === 'string') {
          cls = PatternGen.getGeneratorClass(val)
        } else {
          cls = Patterns[val as number]
        }

        tex.setGenerator(cls)
      }
    )

  st.float('scale', 'scale', 'Scale').noUnits().range(0.001, 2000.0).on('change', onchange)
  st.float('power', 'power', 'Exp').noUnits().range(0.001, 100.0).on('change', onchange)
  st.float('brightness', 'brightness', 'Brightness').noUnits().range(-5.0, 5.0).on('change', onchange)
  st.float('contrast', 'contrast', 'Contrast').noUnits().range(0.001, 100.0).on('change', onchange)

  st.dynamicStruct('generator', 'generator', 'Generator')

  const onch = function (this: {dataref: ProceduralTexUser}) {
    const texuser = this.dataref

    if (texuser.texture) {
      texuser.texture.graphUpdate()
    }
  }

  const userst = api.mapStruct(ProceduralTexUser, true)

  userst.flags('flag', 'flag', TexUserFlags, 'flag').descriptions({
    CONSTANT_SIZE: "Use constant instead of brush size in 'View Repeat' mode",
  })

  userst.enum('mode', 'mode', TexUserModes, 'Mode')
  userst.struct('texture', 'texture', 'Texture', st)
  userst.float('scale', 'scale', 'Scale').noUnits().range(0.0001, 1000.0).on('change', onch)
  userst.float('pinch', 'pinch', 'Tex Pinch').noUnits().range(-1.0, 1.0)

  return st
}
