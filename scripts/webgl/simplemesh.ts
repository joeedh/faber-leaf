/*
 * Warning: this API is particularly old.
 **/

import {Number3, Vector2Like, Vector3, Vector3Like, Vector4, Vector4Like, util} from '../path.ux/scripts/pathux'
import {IUniformsBlock, ShaderProgram} from './webgl'
import '../core/const'
import {loadShader, Shaders} from '../shaders/shaders'
import {RenderBuffer} from './webgl'
import {OptionalIf} from '../util/optionalIf'
import {GpuBuffer, ensureGpuBuffer} from '../webgpu/buffer.js'
import {isWebGPU} from '../core/renderer_flag.js'
import {getActiveWebGpuContext, createDrawQueue} from '../render/queue_factory.js'
import {isInstancedPointSprite} from '../webgpu/pipeline.js'
import {LayerTypeNames, LayerTypes, PrimitiveTypes, TypeSizes} from './primitive_types'

export {LayerTypeNames, LayerTypes, PrimitiveTypes, TypeSizes}

type OpenVector = number[] | Float32Array | Float64Array | Vector2Like | Vector3Like | Vector4Like

//class IIDMap extends Map<number, number> {}
class IIDMap extends util.IDMap<number> {}

const line2_temp4s = util.cachering.fromConstructor(Vector4, 64)
const line2_stripuvs = [
  [1, 0],
  [-1, 0],
  [-1, 1],

  [1, 0],
  [-1, 1],
  [1, 1],
]

const getSmoothLineProgram = (p: ShaderProgram) => {
  const p2 = p as ShaderProgram & {_smoothline?: ShaderProgram}
  return p2._smoothline
}
const setSmoothLineProgram = (p: ShaderProgram, sp: ShaderProgram) => {
  const p2 = p as ShaderProgram & {_smoothline?: ShaderProgram}
  p2._smoothline = sp
}

const _ids_arrs = [[0], [0], [0], [0]]
const zero = new Vector3()

export class TriEditor<OPT extends {dead?: true | false} = {dead: true}> {
  mesh: OptionalIf<SimpleIsland<{dead: false}>, OPT['dead']> = undefined as unknown as SimpleIsland<{dead: false}>
  i: number

  constructor() {
    this.i = 0
  }

  bind(mesh: SimpleIsland<{dead: false}>, i: number): TriEditor<OPT & {dead: false}> {
    this.mesh = mesh
    this.i = i
    return this as TriEditor<OPT & {dead: false}>
  }

  colors(this: TriEditor<{dead: false}>, c1: Vector4Like, c2: Vector4Like, c3: Vector4Like) {
    const data = this.mesh.tri_colors
    const i = this.i * 3 //*3 is because triangles have three vertices

    data.copy(i, c1)
    data.copy(i + 1, c2)
    data.copy(i + 2, c3)

    return this
  }

  normals(this: TriEditor<{dead: false}>, n1: Vector3Like, n2: Vector3Like, n3: Vector3Like) {
    const data = this.mesh.tri_normals

    const i = this.i * 3 //*3 is because triangles have three vertices

    data.copy(i, n1)
    data.copy(i + 1, n2)
    data.copy(i + 2, n3)

    return this
  }

  custom(this: TriEditor<{dead: false}>, layeri: number, v1: OpenVector, v2: OpenVector, v3: OpenVector) {
    const layer = this.mesh.layers.layers[layeri]

    const i = this.i * 3
    layer.copy(i, v1)
    layer.copy(i + 1, v2)
    layer.copy(i + 2, v3)

    return this
  }

  uvs(this: TriEditor<{dead: false}>, u1: Vector2Like, u2: Vector2Like, u3: Vector2Like) {
    const data = this.mesh.tri_uvs
    const i = this.i * 3 //*3 is because triangles have three vertices

    data.copy(i, u1)
    data.copy(i + 1, u2)
    data.copy(i + 2, u3)

    return this
  }

  ids(this: TriEditor<{dead: false}>, i1: number, i2: number, i3: number) {
    if (i1 === undefined || i2 === undefined || i3 === undefined) {
      throw new Error('i1/i2/i3 cannot be undefined')
    }

    const data = this.mesh.tri_ids
    const i = this.i * 3 //*3 is because triangles have three vertices

    _ids_arrs[0][0] = i1
    const a1 = _ids_arrs[0]
    _ids_arrs[1][0] = i2
    const a2 = _ids_arrs[1]
    _ids_arrs[2][0] = i3
    const a3 = _ids_arrs[2]

    data.copy(i, a1)
    data.copy(i + 1, a2)
    data.copy(i + 2, a3)

    return this
  }
}

export class QuadEditor<OPT extends {dead?: true | false} = {dead: true}> {
  t1: TriEditor<{dead: OPT['dead']}>
  t2: TriEditor<{dead: OPT['dead']}>

  constructor() {
    this.t1 = new TriEditor()
    this.t2 = new TriEditor()
  }

  bind(island: SimpleIsland<{dead: false}>, i: number, i2: number): QuadEditor<{dead: false}> {
    this.t1.bind(island, i)
    this.t2.bind(island, i2)
    return this as QuadEditor<{dead: false}>
  }

  uvs(this: QuadEditor<{dead: false}>, u1: Vector2Like, u2: Vector2Like, u3: Vector2Like, u4: Vector2Like) {
    this.t1.uvs(u1, u2, u3)
    this.t2.uvs(u1, u3, u4)

    return this
  }

  custom(this: QuadEditor<{dead: false}>, li: number, v1: OpenVector, v2: OpenVector, v3: OpenVector, v4: OpenVector) {
    this.t1.custom(li, v1, v2, v3)
    this.t2.custom(li, v1, v3, v4)
  }

  colors(this: QuadEditor<{dead: false}>, u1: Vector4Like, u2: Vector4Like, u3: Vector4Like, u4: Vector4Like) {
    this.t1.colors(u1, u2, u3)
    this.t2.colors(u1, u3, u4)

    return this
  }

  normals(this: QuadEditor<{dead: false}>, u1: Vector3Like, u2: Vector3Like, u3: Vector3Like, u4: Vector3Like) {
    this.t1.normals(u1, u2, u3)
    this.t2.normals(u1, u3, u4)

    return this
  }

  ids(this: QuadEditor<{dead: false}>, u1: number, u2: number, u3: number, u4: number) {
    this.t1.ids(u1, u2, u3)
    this.t2.ids(u1, u3, u4)

    return this
  }
}

export class LineEditor<OPT extends {dead?: true | false} = {dead: true}> {
  mesh: OptionalIf<SimpleIsland<{dead: false}>, OPT['dead']> = undefined as unknown as SimpleIsland<{dead: false}>
  i: number

  constructor() {
    this.i = 0
  }

  bind(mesh: SimpleIsland<{dead: false}>, i: number): LineEditor<OPT & {dead: false}> {
    this.mesh = mesh
    this.i = i
    return this as LineEditor<OPT & {dead: false}>
  }

  colors(this: LineEditor<{dead: false}>, c1: Vector4Like, c2: Vector4Like) {
    const data = this.mesh.line_colors
    const i = this.i * 2

    data.copy(i, c1)
    data.copy(i + 1, c2)

    return this
  }

  custom(this: LineEditor<{dead: false}>, layeri: number, v1: OpenVector, v2: OpenVector) {
    const layer = this.mesh.layers.layers[layeri]

    const i = this.i * 2
    layer.copy(i, v1)
    layer.copy(i + 1, v2)

    return this
  }

  normals(this: LineEditor<{dead: false}>, c1: Vector3Like, c2: Vector3Like) {
    const data = this.mesh.line_normals
    const i = this.i * 2

    data.copy(i, c1)
    data.copy(i + 1, c2)

    return this
  }

  uvs(this: LineEditor<{dead: false}>, c1: Vector2Like, c2: Vector2Like) {
    const data = this.mesh.line_uvs
    const i = this.i * 2

    data.copy(i, c1)
    data.copy(i + 1, c2)

    return this
  }

  ids(this: LineEditor<{dead: false}>, i1: number, i2: number) {
    if (i1 === undefined || i2 === undefined) {
      throw new Error('i1 i2 cannot be undefined')
    }

    const data = this.mesh.line_ids
    const i = this.i * 2

    _ids_arrs[0][0] = i1
    _ids_arrs[1][0] = i2

    data.copy(i, _ids_arrs[0])
    data.copy(i + 1, _ids_arrs[1])

    return this
  }
}

export class LineEditor2<OPT extends {dead?: true | false} = {dead: true}> {
  mesh: OptionalIf<SimpleIsland<{dead: false}>, OPT['dead']> = undefined as unknown as SimpleIsland<{dead: false}>
  i: number

  constructor() {
    this.i = 0
  }

  bind(this: LineEditor2<OPT & {dead: false}>, mesh: SimpleIsland<{dead: false}>, i: number) {
    this.mesh = mesh
    this.i = i
    return this
  }

  custom(this: LineEditor2<OPT & {dead: false}>, layeri: number, c1: OpenVector, c2: OpenVector) {
    const data = this.mesh.layers.layers[layeri]

    const i = this.i * 6

    data.copy(i + 0, c1)
    data.copy(i + 1, c1)
    data.copy(i + 2, c2)
    data.copy(i + 3, c1)
    data.copy(i + 4, c2)
    data.copy(i + 5, c2)

    return this
  }

  colors(this: LineEditor2<OPT & {dead: false}>, c1: Vector4Like, c2: Vector4Like) {
    const data = this.mesh.line_colors2
    const i = this.i * 6

    data.copy(i + 0, c1)
    data.copy(i + 1, c1)
    data.copy(i + 2, c2)
    data.copy(i + 3, c1)
    data.copy(i + 4, c2)
    data.copy(i + 5, c2)

    return this
  }

  normals(this: LineEditor2<OPT & {dead: false}>, c1: Vector3Like, c2: Vector3Like) {
    const data = this.mesh.line_normals2
    const i = this.i * 6

    data.copy(i + 0, c1)
    data.copy(i + 1, c1)
    data.copy(i + 2, c2)
    data.copy(i + 3, c1)
    data.copy(i + 4, c2)
    data.copy(i + 5, c2)

    return this
  }

  uvs(this: LineEditor2<OPT & {dead: false}>, c1: Vector2Like, c2: Vector2Like) {
    const data = this.mesh.line_uvs2
    const i = this.i * 6

    data.copy(i + 0, c1)
    data.copy(i + 1, c1)
    data.copy(i + 2, c2)
    data.copy(i + 3, c1)
    data.copy(i + 4, c2)
    data.copy(i + 5, c2)

    return this
  }

  ids(this: LineEditor2<OPT & {dead: false}>, i1: number, i2: number) {
    if (i1 === undefined || i2 === undefined) {
      throw new Error('i1 i2 cannot be undefined')
    }

    const data = this.mesh.line_ids2
    const i = this.i * 6

    const c1 = _ids_arrs[0]
    const c2 = _ids_arrs[1]

    c1[0] = i1
    c2[0] = i2

    data.copy(i + 0, c1)
    data.copy(i + 1, c1)
    data.copy(i + 2, c2)
    data.copy(i + 3, c1)
    data.copy(i + 4, c2)
    data.copy(i + 5, c2)

    return this
  }
}

export class PointEditor<OPT extends {dead?: true | false} = {dead: true}> {
  mesh: OptionalIf<SimpleIsland<{dead: false}>, OPT['dead']>
  i: number

  constructor() {
    this.mesh = undefined as unknown as SimpleIsland<{dead: false}>
    this.i = 0
  }

  bind(this: PointEditor<OPT & {dead: false}>, mesh: SimpleIsland<{dead: false}>, i: number) {
    this.mesh = mesh
    this.i = i
    return this
  }

  colors(this: PointEditor<OPT & {dead: false}>, c1: Vector4Like) {
    const data = this.mesh.point_colors
    const i = this.i

    data.copy(i, c1)

    return this
  }

  normals(this: PointEditor<OPT & {dead: false}>, c1: Vector3Like) {
    const data = this.mesh.point_normals
    const i = this.i

    data.copy(i, c1)

    return this
  }

  uvs(this: PointEditor<OPT & {dead: false}>, c1: Vector2Like) {
    const data = this.mesh.point_uvs
    const i = this.i

    data.copy(i, c1)

    return this
  }

  ids(this: PointEditor<OPT & {dead: false}>, i1: number) {
    if (i1 === undefined) {
      throw new Error('i1 cannot be undefined')
    }

    const data = this.mesh.point_ids
    const i = this.i

    _ids_arrs[0][0] = i1
    data.copy(i, _ids_arrs[0])

    return this
  }
}

export const glTypeSizes = {
  5126: 4, //gl.FLOAT
  5120: 1, //gl.BYTE
  5121: 1, //gl.UNSIGNED_BYTE
  5123: 2, //gl.UNSIGNED_SHORT
  5122: 2, //gl.SHORT
  5124: 4, //gl.INT
  5125: 4, //gl.UNSIGNED_INT
}
export const glTypeArrays = {
  5126: Float32Array, //gl.FLOAT
  5120: Int8Array, //gl.BYTE
  5121: Uint8Array, //gl.UNSIGNED_BYTE
  5122: Int16Array, //gl.SHORT
  5123: Uint16Array, //gl.UNSIGNED_SHORT
  5124: Int32Array, //gl.INT
  5125: Uint32Array, //gl.UNSIGNED_INT
}

export const glTypeArrayMuls = {
  5126: 1, //gl.FLOAT
  5120: 127, //gl.BYTE
  5121: 255, //gl.UNSIGNED_BYTE
  5123: 65535, //gl.UNSIGNED_SHORT
  5122: 32767, //gl.SHORT
  5124: 1, //gl.INT
  5125: 1, //gl.UNSIGNED_INT
}

const glSizes = {
  FLOAT         : 5126,
  BYTE          : 5120,
  UNSIGNED_BYTE : 5121,
  SHORT         : 5122,
  UNSIGNED_SHORT: 5123,
  INT           : 5124,
  UNSIGNED_INT  : 5125,
}
const glRanges = {
  [glSizes.FLOAT]         : [-1e17, 1e17],
  [glSizes.UNSIGNED_SHORT]: [0, 65535],
  [glSizes.SHORT]         : [-32767, 32767],
  [glSizes.BYTE]          : [-127, 127],
  [glSizes.UNSIGNED_BYTE] : [0, 255],
  [glSizes.UNSIGNED_INT]  : [0, (1 << 32) - 1],
  [glSizes.INT]           : [-((1 << 31) - 1), (1 << 31) - 1],
}

const dmap = new WeakSet()

function debugproxy(data: any, min = -1e17, max = 1e17, isint?: boolean) {
  if (dmap.has(data)) {
    data.debug.min = min
    data.isint = isint
    data.debug.max = max
    return data.debug.proxy
  }

  dmap.add(data)

  function validate(target: any, prop: string | symbol) {
    let num = NaN
    if (typeof prop === 'string') {
      num = parseFloat(prop)
    }

    let bad = num !== ~~num
    bad = bad || isNaN(num) || !isFinite(num)
    bad = bad || num < 0 || num >= data.length

    if (bad) {
      console.log(target, num)
      throw new Error('bad prop ' + num)
    }

    return num
  }

  const debug = {
    min,
    max,
    isint,
  }

  const proxy = new Proxy(data, {
    get(target, prop, rc) {
      const num = validate(target, prop)
      return target[num]
    },

    set(target, prop, val) {
      const num = validate(target, prop)

      let bad = typeof val !== 'number'
      bad = bad || val < debug.min || val > debug.max
      bad = bad || isNaN(val) || !isFinite(val)
      bad = bad || val !== ~~val

      if (bad) {
        console.log(val, target, num, debug.min, debug.max)
        throw new Error('bad value ' + val)
      }

      target[num] = val

      return true
    },
  })

  data.debug = debug
  data.debug.proxy = proxy

  return proxy
}

const GL_ARRAY_BUFFER = 34962
const GL_ELEMENT_ARRAY_BUFFER = 34963
const GL_STATIC_DRAW = 35044

export class GeoLayer extends Array {
  index?: number
  glSize: number
  glSizeMul: number
  glReady: boolean
  type: number
  _useTypedData: boolean
  data: number[]
  data_f32: Float32Array | number[]
  dataUsed: number = 0
  f32Ready: boolean
  normalized: boolean
  size: number
  name: string
  primflag: number
  bufferKey: string = ''
  idx: number
  id?: number

  bufferType: number
  bufferHint: number

  constructor(size: number, name: string, primflag: number, type: number, idx: number) {
    //idx is for different layers of same type, e.g. multiple uv layers
    super()

    this.index = undefined

    this.glSize = 5126 //gl.FLOAT
    this.glSizeMul = 1.0
    this.glReady = false

    this.type = type
    this.data = []
    this._useTypedData = false //make v8's optimizer happy by not assinging .data

    this.dataUsed = 0
    this.data_f32 = []

    this.f32Ready = false
    this.normalized = false

    this.bufferType = GL_ARRAY_BUFFER
    this.bufferHint = GL_STATIC_DRAW

    this.size = size
    this.name = name

    this.primflag = primflag
    this.bufferKey = ''
    this.idx = idx
    this.id = undefined
  }

  /*
  get dataUsed() {
    return this._dataUsed;
  }

  set dataUsed(v) {
    if (!v) {
      console.warn(LayerTypeNames[this.type])
    }

    this._dataUsed = v;
  }*/

  _getWriteData() {
    return this._useTypedData ? this.data_f32 : this.data
  }

  setGLSize(size: number): this {
    this.glSize = size
    this.glSizeMul = (glTypeArrayMuls as unknown as any)[size] as number

    return this
  }

  setNormalized(state: boolean) {
    this.normalized = !!state
    return this
  }

  reset() {
    this.glReady = false
    //this._useTypedData = false;
    //this.f32Ready = false;
    this.dataUsed = 0
    return this
  }

  extend(data: OpenVector, count = 1) {
    for (let i = 0; i < count; i++) {
      this.extendIntern(data, i * this.size)
    }
  }

  private extendIntern(data: OpenVector, dataStart: number) {
    if (this._useTypedData && this.dataUsed >= this.data_f32.length) {
      if (window.DEBUG?.simplemesh) {
        console.warn('Resizing simplemesh attribute after conversion to a typed array')
      }

      this._useTypedData = false
      this.data = new Array(this.data_f32.length)

      const a = this.data
      const b = this.data_f32

      for (let i = 0; i < a.length; i++) {
        a[i] = b[i]
      }

      this.data_f32 = []
    }

    let bad = isNaN(this.dataUsed) || this.dataUsed !== ~~this.dataUsed || this.dataUsed < 0
    bad = bad || isNaN(this.size) || isNaN(this.data.length) || this.size <= 0 || this.data.length < 0

    if (bad) {
      throw new Error('dataUsed NaN error ' + this.dataUsed)
    }

    const size = this.size
    const starti = this.dataUsed

    this.f32Ready = this._useTypedData
    this.dataUsed += size

    if (!this._useTypedData && this.dataUsed > this.data.length) {
      /*
        //v8's optimizer hates this:
        for (let i=0; i<tot; i++) {
          this.data.push(0);
        }//*/

      //according to ES spec this is valid:

      this.data.length = ~~(this.dataUsed * 1.5)
    }

    if (data !== undefined) {
      this.copy(~~(starti / this.size), data, 1, dataStart)
    }

    return this
  }

  setCount(count: number, dirty = false) {
    if (isNaN(count)) {
      throw new Error('count was NaN')
    }

    count *= this.size

    if (dirty) {
      this.glReady = false
    }

    this.dataUsed = count
    const data = this._useTypedData ? this.data_f32 : this.data

    if (this.dataUsed !== data.length) {
      if (!this._useTypedData) {
        if (this.data.length < this.dataUsed) {
          this.data.length = this.dataUsed
          this.glReady = false
        }

        this.f32Ready = false
      } else {
        if (window.DEBUG?.simplemesh) {
          console.log('simpleisland is converting back to simple array', count, this.data_f32.length, this.dataUsed)
        }

        const len = this.dataUsed

        this.data = new Array(len)

        const a = this.data
        const b = this.data_f32

        for (let i = 0; i < b.length; i++) {
          a[i] = b[i]
        }

        this.data.length = this.dataUsed

        this.glReady = false
        this._useTypedData = false
        this.f32Ready = false
      }
    }
  }

  _copy2Typed(data1: OpenVector, data2: OpenVector, n: number, mul: number, start: number, dataStart: number) {
    for (let i = 0; i < n; i++) {
      data1[start++] = ~~((data2 as any)[dataStart + i] * mul)
    }
  }

  _copy2(data1: OpenVector, data2: OpenVector, n: number, mul: number, start: number, dataStart: number) {
    for (let i = 0; i < n; i++) {
      data1[start++] = ~~((data2 as any)[dataStart + i] * mul)
    }
  }

  _copy_int(i: number, data: OpenVector, n = 1, dataStart = 0) {
    const tot = n * this.size
    this.f32Ready = false

    i *= this.size
    let thisdata
    const mul = this.glSizeMul

    //let di = 0;
    //let end = i + tot;

    if (this._useTypedData) {
      thisdata = this.data_f32
    } else {
      thisdata = this.data
    }

    if (window.DEBUG?.simplemesh) {
      const range = glRanges[this.glSize]
      thisdata = debugproxy(thisdata, range[0], range[1], this.glSize !== glSizes.FLOAT)
    }

    if (this._useTypedData) {
      this._copy2Typed(thisdata, data, tot, mul, i, dataStart)
    } else {
      this._copy2(thisdata, data, tot, mul, i, dataStart)
    }

    /*
    while (i < end) {
      thisdata[i] = ~~(data[di]*mul);
      di++;
      i++;
    }*/

    return this
  }

  /** i and n will be multiplied by .size, dataStart will not */
  copy(i: number, data: any, n = 1, dataStart = 0) {
    //V8's optimizer doesn't like it if we pass floats
    //to integer typed arrays, even if we multiply them by
    //the proper range scale first.  They must be truncated.
    if (this.glSizeMul !== 1) {
      return this._copy_int(i, data, n, dataStart)
    }

    const tot = n * this.size

    this.f32Ready = this._useTypedData

    i *= this.size
    let thisdata

    if (this._useTypedData) {
      thisdata = this.data_f32
    } else {
      thisdata = this.data
    }

    if (i >= this.dataUsed) {
      // || i + tot > this.data.length) {
      throw new Error('eek!')
      return
    }

    if (isNaN(i)) {
      throw new Error('NaN!')
    }

    let di = dataStart
    const end = i + tot

    while (i < end) {
      thisdata[i] = data[di]
      di++
      i++
    }

    return this
  }

  [Symbol.keystr]() {
    return '' + this.id
  }
}

export class GeoLayerMeta {
  type: number
  primflag: number
  layers: GeoLayer[]
  normalized: boolean
  attrsizes: {[k: string]: number}

  constructor(primflag: number, type: number, attrsizes: {[k: string]: number}) {
    this.type = type
    this.primflag = primflag
    this.layers = []
    this.normalized = false

    this.attrsizes = attrsizes
  }

  add(layer: GeoLayer) {
    this.layers.push(layer)

    if (this.attrsizes[LayerTypeNames[layer.type as keyof typeof LayerTypeNames]] === undefined) {
      this.attrsizes[LayerTypeNames[layer.type as keyof typeof LayerTypeNames]] = 0
    } else {
      this.attrsizes[LayerTypeNames[layer.type as keyof typeof LayerTypeNames]]++
    }
  }
}

function get_meta_mask(primflag: number, type: number): number {
  return type | (primflag << 16)
}

let _debug_idgen = 0

export class GeoLayerManager {
  layers: GeoLayer[]
  has_multilayers: boolean
  _debug_id: number
  layer_meta: Map<number, GeoLayerMeta>
  layer_idgen: util.IDGen
  attrsizes: Map<number, {[k: string]: number}>

  constructor() {
    this.layers = []
    //this.layers_prim_map = new

    this.has_multilayers = false

    this._debug_id = _debug_idgen++

    this.layer_meta = new Map()
    this.layer_idgen = new util.IDGen()

    this.attrsizes = new Map() //maps primitive types to attribute size maps
  }

  reset() {
    for (const [key, meta] of this.layer_meta) {
      for (const l of meta.layers) {
        l.reset()
      }
    }

    return this
  }

  copy() {
    const ret = new GeoLayerManager()

    ret.layer_idgen = this.layer_idgen.copy()
    ret.has_multilayers = this.has_multilayers

    for (const key of this.layer_meta.keys()) {
      const meta = this.layer_meta.get(key)!
      const meta2 = ret.get_meta(meta.primflag, meta.type)

      for (const layer of meta.layers) {
        const layer2 = new GeoLayer(layer.size, layer.name, layer.primflag, layer.type, layer.idx)

        layer2.data.length = layer.data.length
        layer2.dataUsed = layer.dataUsed

        layer2._useTypedData = layer._useTypedData

        layer2.glSize = layer.glSize
        layer2.glSizeMul = layer.glSizeMul
        layer2.id = layer.id
        layer2.index = layer.index
        layer2.bufferKey = layer.bufferKey
        layer2.normalized = layer.normalized

        if (layer._useTypedData) {
          layer2.data_f32 = layer.data_f32.slice(0, layer.data_f32.length)
        } else {
          layer2.data = layer.data.slice(0, layer.data.length)
        }

        meta2.layers.push(layer2)
        ret.layers.push(layer2)
      }
    }

    return ret
  }

  get_meta(primflag: number, type: number): GeoLayerMeta {
    const mask = get_meta_mask(primflag, type)

    if (!this.layer_meta.has(mask)) {
      const attrsizes = {}
      this.attrsizes.set(primflag, attrsizes)

      this.layer_meta.set(mask, new GeoLayerMeta(primflag, type, attrsizes))
    }

    return this.layer_meta.get(mask)!
  }

  [Symbol.iterator]() {
    return this.layers[Symbol.iterator]()
  }

  extend(primflag: PrimitiveTypes, type: number, data: OpenVector, count = 1): this {
    const meta = this.get_meta(primflag, type)!

    for (let i = 0; i < meta.layers.length; i++) {
      meta.layers[i].extend(data, count)
    }

    return this
  }

  layerCount(primflag: PrimitiveTypes, type: number): number {
    return this.get_meta(primflag, type)?.layers?.length ?? 0
  }

  pushLayer(name: string, primflag: number, type: number, size: number): GeoLayer {
    const meta = this.get_meta(primflag, type)
    const idx = meta.layers.length

    const layer = new GeoLayer(size, name, primflag, type, idx)

    layer.id = this.layer_idgen.next()
    layer.index = this.layers.length
    layer.primflag = primflag
    layer.bufferKey = layer.name + ':' + layer.id

    this.layers.push(layer)
    meta.add(layer)

    layer.normalized = meta.normalized

    return layer
  }

  get(name: string, primflag: number, type: number, size?: number, idx?: number): GeoLayer {
    if (size === undefined) {
      size = TypeSizes[type as keyof typeof TypeSizes]
    }

    if (size === undefined) {
      throw new Error('invalid type ' + type)
    }

    if (idx !== undefined && idx > 0) {
      this.has_multilayers = true
    }

    const meta = this.get_meta(primflag, type)

    if (type === LayerTypes.CUSTOM) {
      for (const layer of meta.layers) {
        if (layer.name === name) {
          return layer
        }
      }
    } else {
      idx = idx === undefined ? 0 : idx

      if (idx < meta.layers.length) {
        return meta.layers[idx]
      }
    }

    return this.pushLayer(name, primflag, type, size)
  }
}

const _default_uv = [0, 0]
const _default_color = [0, 0, 0, 1]
const _default_normal = [0, 0, 1]
const _default_id = [-1]

export class SimpleIsland<OPT extends {dead?: true | false} = {dead: true}> {
  gl: OptionalIf<WebGL2RenderingContext, OPT['dead']> = undefined as unknown as WebGL2RenderingContext
  layers: GeoLayerManager
  _glAttrs: {[k: string]: number}
  /** If undefined, will get from owning simplemesh's primflag. */
  primflag?: number
  mesh: SimpleMesh
  totpoint: number
  totline: number
  tottri: number
  totline_tristrip: number

  tri_editors: util.cachering<TriEditor>
  quad_editors: util.cachering<QuadEditor>
  line_editors: util.cachering<LineEditor>
  tristrip_line_editors: util.cachering<LineEditor2>
  point_editors: util.cachering<PointEditor>

  regen: boolean
  _regen_all: PrimitiveTypes

  /** If undefined, will get from owning simplemesh's primflag. */
  indexedMode?: boolean
  /** If undefined, will get from owning simplemesh's primflag. */
  _layerflag?: LayerTypes

  buffer: RenderBuffer
  program: OptionalIf<ShaderProgram, OPT['dead']> = undefined as unknown as ShaderProgram
  textures: any[]
  uniforms: IUniformsBlock
  _uniforms_temp: IUniformsBlock
  private extraLayerFlag: number = 0
  /** WebGPU buffer cache keyed by `layer.bufferKey` — populated by
   *  `_uploadGpuBuffers`, the WebGPU sibling of `gen_buffers`. */
  private _gpuBuffers: Map<string, GpuBuffer> = new Map()
  /** Owning device pointer — used to detect device swaps and reset
   *  the GPU buffer cache. */
  private _gpuDevice: GPUDevice | undefined = undefined

  constructor(mesh: SimpleMesh) {
    this.layers = new GeoLayerManager()
    this._glAttrs = {}
    this.primflag = undefined //if undefined, will get from this.mesh.primflag

    this.mesh = mesh
    this.makeBufferAliases()

    this.totpoint = 0
    this.totline = 0
    this.tottri = 0
    this.totline_tristrip = 0

    this.indexedMode = undefined //inherited from mesh

    this.regen = true
    this._regen_all = 0

    this.tri_editors = util.cachering.fromConstructor(TriEditor, 32, true)
    this.quad_editors = util.cachering.fromConstructor(QuadEditor, 32, true)
    this.line_editors = util.cachering.fromConstructor(LineEditor, 32, true)
    this.point_editors = util.cachering.fromConstructor(PointEditor, 32, true)

    this.tristrip_line_editors = util.cachering.fromConstructor(LineEditor2, 32, true)

    this.buffer = new RenderBuffer()

    this.textures = []
    this.uniforms = {}
    this._uniforms_temp = {}
  }

  public get layerflag() {
    return (this._layerflag ?? this.mesh.layerflag) | this.extraLayerFlag
  }

  reset(gl: WebGL2RenderingContext): void {
    this.layers.reset()
    this.buffer.reset(gl)

    this.tottri = this.totline = this.totpoint = this.totline_tristrip = 0
    this.regen = true
  }

  getIndexedMode(): boolean {
    if (this.indexedMode !== undefined) {
      return this.indexedMode
    } else {
      return this.mesh.indexedMode
    }
  }

  setPrimitiveCount(primtype: PrimitiveTypes, tot: number): this {
    switch (primtype) {
      case PrimitiveTypes.TRIS:
        this.tottri = tot
        tot *= 3
        break
      case PrimitiveTypes.LINES:
        this.totline = tot
        tot *= 2
        break
      case PrimitiveTypes.ADVANCED_LINES:
        this.totline_tristrip = tot
        tot *= 6
        break
      case PrimitiveTypes.POINTS:
        this.totpoint = tot
        break
    }

    const lf = this.layerflag ? this.layerflag : this.mesh.layerflag

    for (const layer of this.layers.layers) {
      if (layer.primflag !== primtype || !(layer.type & lf)) {
        continue
      }

      layer.setCount(tot)
    }

    return this
  }

  tri_cos: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  tri_normals: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  tri_uvs: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  tri_colors: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  tri_ids: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer

  line_cos: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_normals: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_uvs: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_colors: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_ids: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer

  line_cos2: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_normals2: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_uvs2: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_colors2: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_ids2: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer

  point_cos: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  point_normals: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  point_uvs: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  point_colors: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  point_ids: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer

  line_stripuvs: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_stripdirs: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer
  line_dirs2: OptionalIf<GeoLayer, OPT['dead']> = undefined as unknown as GeoLayer

  makeBufferAliases(): void {
    const lay = this.layers

    let pflag = PrimitiveTypes.TRIS
    this.tri_cos = lay.get('tri_cos', pflag, LayerTypes.LOC) //array
    this.tri_normals = lay.get('tri_normals', pflag, LayerTypes.NORMAL).setGLSize(glSizes.SHORT).setNormalized(true) //array
    this.tri_uvs = lay.get('tri_uvs', pflag, LayerTypes.UV).setGLSize(glSizes.SHORT).setNormalized(true) //array
    this.tri_colors = lay
      .get('tri_colors', pflag, LayerTypes.COLOR)
      .setGLSize(glSizes.UNSIGNED_BYTE)
      .setNormalized(true) //array
    this.tri_ids = lay.get('tri_ids', pflag, LayerTypes.ID) //array

    pflag = PrimitiveTypes.LINES
    this.line_cos = lay.get('line_cos', pflag, LayerTypes.LOC) //array
    this.line_normals = lay.get('line_normals', pflag, LayerTypes.NORMAL).setGLSize(glSizes.SHORT).setNormalized(true) //array
    this.line_uvs = lay.get('line_uvs', pflag, LayerTypes.UV).setGLSize(glSizes.SHORT).setNormalized(true) //array
    this.line_colors = lay
      .get('line_colors', pflag, LayerTypes.COLOR)
      .setGLSize(glSizes.UNSIGNED_BYTE)
      .setNormalized(true) //array
    this.line_ids = lay.get('line_ids', pflag, LayerTypes.ID) //array

    pflag = PrimitiveTypes.POINTS
    this.point_cos = lay.get('point_cos', pflag, LayerTypes.LOC) //array
    this.point_normals = lay.get('point_normals', pflag, LayerTypes.NORMAL).setGLSize(glSizes.SHORT).setNormalized(true) //array
    this.point_uvs = lay.get('point_uvs', pflag, LayerTypes.UV).setGLSize(glSizes.SHORT).setNormalized(true) //array
    this.point_colors = lay
      .get('point_colors', pflag, LayerTypes.COLOR)
      .setGLSize(glSizes.UNSIGNED_BYTE)
      .setNormalized(true) //array
    this.point_ids = lay.get('point_ids', pflag, LayerTypes.ID) //array

    const primflag = this.primflag ?? this.mesh.primflag
    if (primflag & PrimitiveTypes.ADVANCED_LINES) {
      pflag = PrimitiveTypes.ADVANCED_LINES

      this.line_cos2 = lay.get('line_cos2', pflag, LayerTypes.LOC) //array
      this.line_normals2 = lay
        .get('line_normals2', pflag, LayerTypes.NORMAL)
        .setGLSize(glSizes.SHORT)
        .setNormalized(true) //array
      this.line_uvs2 = lay.get('line_uvs2', pflag, LayerTypes.UV).setGLSize(glSizes.SHORT).setNormalized(true)
      this.line_colors2 = lay
        .get('line_colors2', pflag, LayerTypes.COLOR)
        .setGLSize(glSizes.UNSIGNED_BYTE)
        .setNormalized(true)
      this.line_ids2 = lay.get('line_ids2', pflag, LayerTypes.ID) //array

      this.line_stripuvs = this.getDataLayer(PrimitiveTypes.ADVANCED_LINES, LayerTypes.CUSTOM, 2, '_strip_uv')
      this.line_stripdirs = this.getDataLayer(PrimitiveTypes.ADVANCED_LINES, LayerTypes.CUSTOM, 4, '_strip_dir')
      this.line_stripdirs.normalized = false
    }
  }

  copy(): SimpleIsland<OPT> {
    const ret = new SimpleIsland<OPT>(this.mesh)

    ret.primflag = this.primflag
    ret._layerflag = this._layerflag
    ret.extraLayerFlag = this.extraLayerFlag

    ret.totline = this.totline
    ret.tottri = this.tottri
    ret.totpoint = this.totpoint

    for (const k in this.uniforms) {
      ret.uniforms[k] = this.uniforms[k]
    }

    for (const tex of this.textures) {
      ret.textures.push(tex)
    }

    ret.program = this.program
    ret.layers = this.layers.copy()
    ret.regen = true

    ret.makeBufferAliases()

    return ret
  }

  glFlagUploadAll(primflag: PrimitiveTypes = PrimitiveTypes.ALL): void {
    this._regen_all |= primflag
  }

  point(this: SimpleIsland<OPT & {dead: false}>, v1: Vector3Like): PointEditor<{dead: false}> {
    this.point_cos.extend(v1)

    this._newElem(PrimitiveTypes.POINTS, 1)

    this.totpoint++
    return this.point_editors.next().bind(this, this.totpoint - 1)
  }

  smoothline(
    this: SimpleIsland<OPT & {dead: false}>,
    v1: Vector3Like,
    v2: Vector3Like,
    w1 = 2,
    w2 = 2
  ): LineEditor2<{dead: false}> {
    let dv = 0.0
    for (let _i = 0; _i < 3; _i++) {
      const i = _i as Number3
      dv += (v1[i] - v2[i]) * (v1[i] - v2[i])
    }

    this.extraLayerFlag |= LayerTypes.CUSTOM

    if (!this.line_cos2 || !(this.extraLayerFlag & LayerTypes.CUSTOM)) {
      this.regen = true
      if (this.primflag === undefined) {
        this.primflag = this.mesh.primflag
      }
      this.primflag |= PrimitiveTypes.ADVANCED_LINES
      this.makeBufferAliases()
    }

    let li = this.line_cos2.dataUsed

    this.line_cos2.extend(v1)
    this.line_cos2.extend(v1)
    this.line_cos2.extend(v2)

    this.line_cos2.extend(v1)
    this.line_cos2.extend(v2)
    this.line_cos2.extend(v2)

    const data = this.line_cos2._getWriteData()
    if (dv === 0.0) {
      while (li < this.line_cos2.dataUsed) {
        data[li++] += Math.random() * 0.001
      }
    }

    this._newElem(PrimitiveTypes.ADVANCED_LINES, 6)

    const i = this.totline_tristrip * 6

    this.line_stripuvs.copy(i + 0, line2_stripuvs[0])
    this.line_stripuvs.copy(i + 1, line2_stripuvs[1])
    this.line_stripuvs.copy(i + 2, line2_stripuvs[2])
    this.line_stripuvs.copy(i + 3, line2_stripuvs[3])
    this.line_stripuvs.copy(i + 4, line2_stripuvs[4])
    this.line_stripuvs.copy(i + 5, line2_stripuvs[5])

    const d = line2_temp4s
      .next()
      .load3(v2)
      .sub(v1 as unknown as Vector4)
    d[3] = 0.0
    d.normalize()

    d[3] = w1
    this.line_stripdirs.copy(i, d)
    this.line_stripdirs.copy(i + 1, d)
    d[3] = w2
    this.line_stripdirs.copy(i + 2, d)

    d[3] = w1
    this.line_stripdirs.copy(i + 3, d)
    d[3] = w2
    this.line_stripdirs.copy(i + 4, d)
    this.line_stripdirs.copy(i + 5, d)

    this.totline_tristrip++

    return this.tristrip_line_editors.next().bind(this, this.totline_tristrip - 1)
  }

  line(this: SimpleIsland<OPT & {dead: false}>, v1: Vector3Like, v2: Vector3Like): LineEditor<{dead: false}> {
    //return this.smoothline(v1, v2);

    this.line_cos.extend(v1)
    this.line_cos.extend(v2)

    this._newElem(PrimitiveTypes.LINES, 2)

    this.totline++
    return this.line_editors.next().bind(this, this.totline - 1)
  }

  _newElem(primtype: PrimitiveTypes, primcount: number): number {
    const layerflag = this.layerflag

    const meta = this.layers.get_meta(primtype, LayerTypes.LOC)
    const start = meta.layers[0].dataUsed / meta.layers[0].size

    for (let j = 0; j < primcount; j++) {
      if (layerflag & LayerTypes.UV) {
        this.layers.extend(primtype, LayerTypes.UV, _default_uv)
      }

      if (layerflag & LayerTypes.CUSTOM) {
        this.layers.extend(primtype, LayerTypes.CUSTOM, _default_uv)
      }

      if (layerflag & LayerTypes.COLOR) {
        this.layers.extend(primtype, LayerTypes.COLOR, _default_color)
      }

      if (layerflag & LayerTypes.NORMAL) {
        this.layers.extend(primtype, LayerTypes.NORMAL, _default_normal)
      }

      if (layerflag & LayerTypes.ID) {
        this.layers.extend(primtype, LayerTypes.ID, _default_id)
      }
    }

    return start
  }

  tri(
    this: SimpleIsland<OPT & {dead: false}>,
    v1: Vector3Like,
    v2: Vector3Like,
    v3: Vector3Like
  ): TriEditor<{dead: false}> {
    this.tri_cos.extend(v1)
    this.tri_cos.extend(v2)
    this.tri_cos.extend(v3)

    this._newElem(PrimitiveTypes.TRIS, 3)

    this.tottri++

    return this.tri_editors.next().bind(this, this.tottri - 1)
  }

  quad(
    this: SimpleIsland<OPT & {dead: false}>,
    v1: Vector3Like,
    v2: Vector3Like,
    v3: Vector3Like,
    v4: Vector3Like
  ): QuadEditor<{dead: false}> {
    const i = this.tottri

    this.tri(v1, v2, v3)
    this.tri(v1, v3, v4)

    return this.quad_editors.next().bind(this, i, i + 1)
  }

  destroy(gl = this.gl): void {
    if (gl === undefined) {
      console.warn('failed to destroy a mesh')
    } else {
      this.buffer.destroy(gl)
    }
    this.regen = true
  }

  gen_buffers(gl: WebGL2RenderingContext): void {
    this.gl = gl
    const layerflag = this.layerflag

    const allflag = this._regen_all
    this._regen_all = 0

    //convert all layers to final typedarrays to save memory, even ones that aren't used
    for (const layer of this.layers) {
      if (layer.dataUsed === 0) {
        continue
      }

      if (layer._useTypedData && !layer.f32Ready) {
        layer.f32Ready = true
      }

      if (!layer.f32Ready) {
        layer.f32Ready = true

        const typedarray = glTypeArrays[layer.glSize as keyof typeof glTypeArrayMuls]

        if (layer.data_f32?.length !== layer.dataUsed) {
          if (window.DEBUG?.simplemesh) {
            console.warn('new layer data', layer.data_f32, layer)
          }

          layer.data_f32 = new typedarray(layer.dataUsed) as Float32Array
        }

        const a = layer.data
        const b = layer.data_f32

        const count = layer.dataUsed

        layer.data.length = layer.dataUsed
        ;(layer.data_f32 as unknown as Float32Array).set(layer.data)

        layer._useTypedData = true
        layer.data = []
        layer.glReady = false
      }

      if (layer.glReady && layer.dataUsed !== layer.data_f32.length) {
        throw new Error('simplemesh error')
      }
    }

    for (const layer of this.layers) {
      if (layer.glReady && !(allflag & layer.primflag)) {
        continue
      }

      if (layer.dataUsed === 0 || !(layer.type & layerflag)) {
        continue
      }

      //custom layers have their own attribute names
      if (layer.type !== LayerTypes.CUSTOM) {
        this._glAttrs[LayerTypeNames[layer.type as keyof typeof LayerTypeNames]] = 1
      }

      //console.log(layer.bufferKey, layer.dataUsed, layer.data_f32.length, layer.bufferType, layer.data_f32);

      const vbo = this.buffer.get(gl, layer.bufferKey, layer.bufferType)
      vbo.uploadData(gl, layer.data_f32 as Float32Array, layer.bufferType, layer.bufferHint)
      layer.glReady = true
    }
  }

  getIndexBuffer(ptype: PrimitiveTypes): GeoLayer {
    let key = ''

    switch (ptype) {
      case PrimitiveTypes.TRIS:
        key = 'tri'
        break
      case PrimitiveTypes.LINES:
        key = 'line'
        break
      case PrimitiveTypes.POINTS:
        key = 'point'
        break
    }

    key += '_indices'
    const anyThis = this as unknown as any

    if (!anyThis[key]) {
      const layer = (anyThis[key] = this.layers.get(key, ptype, LayerTypes.INDEX))

      layer.size = 1
      layer.glSizeMul = 1
      layer.glSize = glSizes.UNSIGNED_SHORT
      layer.normalized = false
      layer.bufferType = GL_ELEMENT_ARRAY_BUFFER
    }

    return (this as unknown as any)[key] as unknown as GeoLayer
  }

  _draw_tris(gl: WebGL2RenderingContext, uniforms: any, params: any, program?: ShaderProgram): void {
    if (this.tottri) {
      this.bindArrays(gl, uniforms, program, 'tri', PrimitiveTypes.TRIS)

      if (this.getIndexedMode()) {
        const idx = this.getIndexBuffer(PrimitiveTypes.TRIS)

        if (!idx) {
          console.warn('Missing index layer', this)
          return
        }

        const vbo = this.buffer.get(gl, idx.bufferKey, idx.bufferType)
        const buf = vbo.get(gl)

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf)
        gl.drawElements(gl.TRIANGLES, this.tottri * 3, gl.UNSIGNED_SHORT, 0)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, this.tottri * 3)
      }
    }
  }

  _draw_line_tristrips(gl: WebGL2RenderingContext, uniforms: any, params: any, program?: ShaderProgram): void {
    const attrs = this._glAttrs

    program = program ?? Shaders.LineTriStripShader

    if (this.totline_tristrip) {
      let _smoothline = getSmoothLineProgram(program)

      if (_smoothline === undefined) {
        const uniforms2 = Object.assign({}, uniforms)
        const attributes = new Set(program.attrs)

        attributes.add('_strip_dir')
        attributes.add('_strip_uv')

        let vertex = program.vertexSource
        let fragment = program.fragmentSource

        vertex = ShaderProgram.insertDefine(
          `
#ifndef SMOOTH_LINE
#define SMOOTH_LINE
#endif
        `,
          vertex
        )
        fragment = ShaderProgram.insertDefine(
          `
#ifndef SMOOTH_LINE
#define SMOOTH_LINE
#endif
        `,
          fragment
        )

        const sdef = {
          vertex,
          fragment,
          uniforms  : uniforms2,
          attributes: Array.from(attributes),
        }

        _smoothline = loadShader(gl, sdef)
        setSmoothLineProgram(program, _smoothline)
        //console.warn("Auto-generating smooth line shader");
        //let sdef = {
        //vertexProgram :
        //}
        //program._smoothline = loadShader(gl, sdef);
      }

      //program = Shaders.LineTriStripShader;
      program = (program as unknown as any)._smoothline as ShaderProgram
      program.bind(gl, uniforms, attrs)

      this.bindArrays(gl, uniforms, program, 'line2', PrimitiveTypes.ADVANCED_LINES)
      gl.drawArrays(gl.TRIANGLES, 0, this.totline_tristrip * 6)

      //gl.drawArrays(gl.LINES, 0, this.totline_tristrip*2);
    }
  }

  flagRecalc(): this {
    for (const layer of this.layers) {
      layer.f32Ready = false
    }

    this.regen = true

    return this
  }

  bindArrays(
    gl: WebGL2RenderingContext,
    uniforms: any,
    program: ShaderProgram | undefined,
    key: string,
    primflag: PrimitiveTypes
  ): void {
    program = program === undefined ? this.program : program
    program = program === undefined ? this.mesh.program : program
    const layerflag = this.layerflag

    if (program && !program.program) {
      //program.checkCompile(gl, uniforms);
      const attrs = this._glAttrs
      program.bind(gl, uniforms, attrs)
    }

    if (!program) {
      return
    }

    const maxattrib = gl.getParameter(gl.MAX_VERTEX_ATTRIBS)

    for (let i = 0; i < maxattrib; i++) {
      gl.disableVertexAttribArray(i)
    }

    let li = 0
    const layer = this.layers.get_meta(primflag, LayerTypes.LOC).layers[0]

    if (layer.dataUsed === 0) {
      return
    }

    const buf = this.buffer.get(gl, layer.bufferKey, layer.bufferType).get(gl)

    const btype = gl.ARRAY_BUFFER
    if (this.getIndexedMode()) {
      //btype = gl.ELEMENT_ARRAY_BUFFER;
    }

    gl.bindBuffer(btype, buf)
    gl.vertexAttribPointer(0, layer.size, layer.glSize, false, 0, 0)
    gl.enableVertexAttribArray(0)

    const bindArray = (name: string, type: LayerTypes) => {
      if (!(layerflag & type) || type & LayerTypes.INDEX) {
        return
      }

      const meta = this.layers.get_meta(primflag, type)
      if (!meta.layers.length) {
        //gl.disableVertexAttribArray(li);
        li++
        return
      } else {
        for (let i = 0; i < meta.layers.length; i++) {
          const layer = meta.layers[i]
          let count
          let mli = i

          if (layer.dataUsed === 0) {
            continue
          }

          if (type === LayerTypes.CUSTOM) {
            name = layer.name
            count = 0

            for (let j = 0; j < meta.layers.length; j++) {
              if (j === i) {
                break
              }

              if (meta.layers[j].type === LayerTypes.CUSTOM && meta.layers[j].name === name) {
                count++
              }
            }

            mli = count
          }

          const key = ShaderProgram.multiLayerAttrKey(name, mli)

          const vbo = this.buffer.get(gl, layer.bufferKey, layer.bufferType)
          const buf = vbo.get(gl)

          li = program.attrLoc(key)
          if (li < 0) {
            continue
          }

          gl.enableVertexAttribArray(li)
          gl.bindBuffer(btype, buf)

          gl.vertexAttribPointer(li, layer.size, layer.glSize, layer.normalized, 0, 0)
        }
      }
    }

    bindArray('normal', LayerTypes.NORMAL)
    bindArray('uv', LayerTypes.UV)
    bindArray('color', LayerTypes.COLOR)
    bindArray('id', LayerTypes.ID)
    bindArray('custom', LayerTypes.CUSTOM)
  }

  addDataLayer(
    primflag: PrimitiveTypes,
    type: number,
    size = TypeSizes[type as keyof typeof TypeSizes],
    name = LayerTypeNames[type as keyof typeof LayerTypeNames]
  ) {
    this._glAttrs[name] = 1

    return this.layers.pushLayer(name, primflag, type, size)
  }

  getDataLayer(
    primflag: PrimitiveTypes,
    type: number,
    size = TypeSizes[type as keyof typeof TypeSizes],
    name = LayerTypeNames[type as keyof typeof LayerTypeNames]
  ) {
    this._glAttrs[name] = 1

    return this.layers.get(name, primflag, type, size)
  }

  _draw_points(gl: WebGL2RenderingContext, uniforms: IUniformsBlock, params: any, program?: ShaderProgram): void {
    if (this.totpoint > 0) {
      //console.log(this.totpoint, this.point_cos);
      this.bindArrays(gl, uniforms, program, 'point', PrimitiveTypes.POINTS)
      gl.drawArrays(gl.POINTS, 0, this.totpoint)
    } else {
      console.log('no geometry')
    }
  }

  _draw_lines(gl: WebGL2RenderingContext, uniforms: any, params: any, program?: ShaderProgram): void {
    if (this.totline === 0) {
      return
    }

    if (this.getIndexedMode()) {
      const idx = this.getIndexBuffer(PrimitiveTypes.LINES)
      //reuse tri vert arrays in indexed mode
      this.bindArrays(gl, uniforms, program, 'tris', PrimitiveTypes.TRIS)

      if (!idx) {
        console.warn('Missing index layer', this)
        return
      }

      const vbo = this.buffer.get(gl, idx.bufferKey, idx.bufferType)
      const buf = vbo.get(gl)

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf)
      gl.drawElements(gl.LINES, this.totline * 2, gl.UNSIGNED_SHORT, 0)
    } else {
      this.bindArrays(gl, uniforms, program, 'line', PrimitiveTypes.LINES)
      gl.drawArrays(gl.LINES, 0, this.totline * 2)
    }
  }

  onContextLost(e: any): void {
    this.regen = true
  }

  draw(gl: WebGL2RenderingContext, uniforms?: IUniformsBlock, params?: any, program_override?: ShaderProgram): void {
    this.gl = gl

    let program = this.program === undefined ? this.mesh.program : this.program
    const primflag = this.primflag === undefined ? this.mesh.primflag : this.primflag

    if (program_override !== undefined) {
      program = program_override
    }

    if (this.regen) {
      this.regen = false
      this.gen_buffers(gl)
    }

    if (uniforms === undefined) {
      for (const k in this._uniforms_temp) {
        delete this._uniforms_temp[k]
      }

      uniforms = this._uniforms_temp
    }

    for (const k in this.uniforms) {
      if (!(k in uniforms)) {
        uniforms[k] = this.uniforms[k]
      }
    }

    for (const k in this.mesh.uniforms) {
      if (!(k in uniforms)) {
        uniforms[k] = this.mesh.uniforms[k]
      }
    }

    if (program === undefined) program = (gl as unknown as any).simple_shader as ShaderProgram

    const attrs = this._glAttrs

    if (!this.layers.has_multilayers) {
      program.bind(gl, uniforms, attrs)
    }

    if (this.tottri && primflag & PrimitiveTypes.TRIS) {
      if (this.layers.has_multilayers) {
        program.bindMultiLayer(gl, uniforms, this.layers.attrsizes.get(PrimitiveTypes.TRIS), attrs)
      }

      this._draw_tris(gl, uniforms, params, program)
    }

    if (this.totline && primflag & PrimitiveTypes.LINES) {
      if (this.layers.has_multilayers) {
        program.bindMultiLayer(gl, uniforms, this.layers.attrsizes.get(PrimitiveTypes.LINES), attrs)
      }
      this._draw_lines(gl, uniforms, params, program)
    }

    if (this.totpoint && primflag & PrimitiveTypes.POINTS) {
      if (this.layers.has_multilayers) {
        program.bindMultiLayer(gl, uniforms, this.layers.attrsizes.get(PrimitiveTypes.POINTS), attrs)
      }
      this._draw_points(gl, uniforms, params, program)
    }

    if (this.totline_tristrip && primflag & PrimitiveTypes.ADVANCED_LINES) {
      if (this.layers.has_multilayers) {
        program.bindMultiLayer(gl, uniforms, this.layers.attrsizes.get(PrimitiveTypes.ADVANCED_LINES), attrs)
      }
      this._draw_line_tristrips(gl, uniforms, params, program)
    }

    //if (gl.getError()) {
    //  this.regen = 1;
    //}
  }

  /**
   * WebGPU mirror of `gen_buffers(gl)`. Packs each non-CUSTOM,
   * non-INDEX `GeoLayer` in `layerflag` into its own `GpuBuffer`,
   * keyed by `layer.bufferKey`. Re-runs only when `regen` is set or
   * the device pointer changes. INDEX layers (uint16) get an
   * 'index'-usage `GpuBuffer` so callers can `setIndexBuffer` them.
   *
   * Caller (WebGPUDrawQueueAdapter / queue_adapter.ts) wires the
   * resulting buffers to the active shader's vertex layout slots —
   * the slot↔layer mapping is shader-side, not island-side.
   */
  _uploadGpuBuffers(device: GPUDevice): void {
    if (this._gpuDevice !== device) {
      for (const buf of this._gpuBuffers.values()) buf.destroy()
      this._gpuBuffers.clear()
      this._gpuDevice = device
    }

    const layerflag = this.layerflag

    for (const layer of this.layers) {
      if (layer.dataUsed === 0) continue
      if (!(layer.type & layerflag) && layer.type !== LayerTypes.INDEX) continue

      // Promote layer to a Float32Array for the GPU. We diverge from
      // `gen_buffers` here: it picks a typed-array constructor based
      // on `layer.glSize` (Int16 for packed normals, Uint8 for packed
      // colors, etc.) to save WebGL VRAM. The WGSL shader registry
      // (`scripts/shaders/wgsl_shaders.ts`) uses uniform float32
      // vertex formats for every layer, so the WebGPU upload always
      // emits Float32 — divide by `glSizeMul` if the source was
      // already packed into a smaller integer type.
      if (!layer.f32Ready || !(layer.data_f32 instanceof Float32Array) || layer.data_f32.length !== layer.dataUsed) {
        const out = new Float32Array(layer.dataUsed)
        const src = layer._useTypedData ? (layer.data_f32 as ArrayLike<number>) : layer.data
        const inv = layer.glSizeMul !== 1 ? 1 / layer.glSizeMul : 1
        if (inv === 1) {
          for (let k = 0; k < layer.dataUsed; k++) out[k] = src[k]
        } else {
          for (let k = 0; k < layer.dataUsed; k++) out[k] = src[k] * inv
        }
        layer.data_f32 = out
        layer._useTypedData = true
        layer.data = []
        layer.f32Ready = true
      }

      const data = layer.data_f32 as Float32Array
      const byteLength = data.byteLength
      if (byteLength === 0) continue
      const view = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, byteLength)

      const gpu = ensureGpuBuffer(
        this._gpuBuffers,
        layer.bufferKey,
        byteLength,
        {
          label: `SimpleIsland.${layer.bufferKey}`,
          usage: layer.type === LayerTypes.INDEX ? 'index' : 'vertex',
        },
        device,
        /*exactMatch*/ false
      )
      gpu.write(view as unknown as BufferSource)
    }
  }

  /** Look up an uploaded `GpuBuffer` by `layer.bufferKey`. */
  getGpuBuffer(bufferKey: string): GpuBuffer | undefined {
    return this._gpuBuffers.get(bufferKey)
  }

  /**
   * WebGPU draw entry. Uploads any dirty `GeoLayer`s into `GpuBuffer`s
   * (one per layer, matching the WebGL per-attribute VBO layout), then
   * binds the non-CUSTOM/non-INDEX layers to vertex slots in the
   * canonical order LOC, NORMAL, UV, COLOR, ID — the WGSL shaders in
   * `wgsl_shaders.ts` declare `@location(n)` slots in this same order.
   *
   * The `pipeline` argument is unused at this layer (the caller
   * already bound it before invoking us) but kept in the signature to
   * match the `Drawable.drawGPU` contract.
   */
  drawGPU(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, _uniforms: IUniformsBlock): void {
    if (!this._gpuDevice) {
      throw new Error('SimpleIsland.drawGPU: call _uploadGpuBuffers(device) before drawGPU.')
    }

    // Canonical fixed slot per LayerType — matches `WGSL_VERTEX_SLOTS`
    // in `scripts/shaders/wgsl_shaders.ts`. The mapping is positional
    // (not auto-increment): a mesh missing NORMAL still binds UV at
    // slot 2, COLOR at slot 3, etc. so pipelines declare their
    // `vertexBuffers` against these stable positions.
    const layerflag = this.layerflag
    const slotForType: Array<[LayerTypes, number]> = [
      [LayerTypes.LOC, 0],
      [LayerTypes.NORMAL, 1],
      [LayerTypes.UV, 2],
      [LayerTypes.COLOR, 3],
      [LayerTypes.ID, 4],
    ]

    // A single island can carry separate `LOC/COLOR/ID` layer sets per
    // primitive type (`tri_cos:N`, `point_cos:M`, …). Bind by primflag
    // before each primitive's draw call so e.g. a POINTS draw picks the
    // `point_cos` layer and not the first-matching `tri_cos`.
    const bindForPrim = (drawPrim: PrimitiveTypes): void => {
      for (const [type, slot] of slotForType) {
        if (!(type & layerflag)) continue
        for (const layer of this.layers) {
          if (layer.type !== type) continue
          if (!(layer.primflag & drawPrim)) continue
          const buf = this._gpuBuffers.get(layer.bufferKey)
          if (!buf) continue
          pass.setVertexBuffer(slot, buf.handle)
          break
        }
      }
    }

    const primflag = this.primflag ?? this.mesh.primflag
    const indexedMode = this.getIndexedMode()

    if (this.tottri && primflag & PrimitiveTypes.TRIS) {
      bindForPrim(PrimitiveTypes.TRIS)
      const count = this.tottri * 3
      if (indexedMode) {
        const idx = this.getIndexBuffer(PrimitiveTypes.TRIS)
        const buf = this._gpuBuffers.get(idx.bufferKey)
        if (buf) {
          pass.setIndexBuffer(buf.handle, 'uint16')
          pass.drawIndexed(count, 1, 0, 0, 0)
        }
      } else {
        pass.draw(count, 1, 0, 0)
      }
    }
    if (this.totline && primflag & PrimitiveTypes.LINES) {
      bindForPrim(PrimitiveTypes.LINES)
      const count = this.totline * 2
      pass.draw(count, 1, 0, 0)
    }
    if (this.totpoint && primflag & PrimitiveTypes.POINTS) {
      bindForPrim(PrimitiveTypes.POINTS)
      // Point-sprite pipelines (e.g. MeshEditPointShader) declare their
      // vertex buffers as instance-stepped and expect 6 verts per point
      // primitive — `@builtin(vertex_index)` 0..5 enumerates the corners
      // of a screen-space billboard quad. The plain non-sprite path
      // expects 1 draw per point with the native `point-list` topology.
      if (isInstancedPointSprite(pipeline)) {
        pass.draw(6, this.totpoint, 0, 0)
      } else {
        pass.draw(this.totpoint, 1, 0, 0)
      }
    }
    if (this.totline_tristrip && primflag & PrimitiveTypes.ADVANCED_LINES) {
      bindForPrim(PrimitiveTypes.ADVANCED_LINES)
      pass.draw(this.totline_tristrip * 6, 1, 0, 0)
    }
  }
}

export class SimpleMesh {
  program?: ShaderProgram
  layerflag: LayerTypes
  primflag: PrimitiveTypes
  indexedMode: boolean
  gl: WebGL2RenderingContext | undefined
  islands: SimpleIsland<{dead: false}>[]
  uniforms: IUniformsBlock
  island: SimpleIsland<{dead: false}>

  constructor(layerflag = LayerTypes.LOC | LayerTypes.NORMAL | LayerTypes.UV) {
    this.layerflag = layerflag
    this.primflag = PrimitiveTypes.ALL
    this.indexedMode = false

    this.gl = undefined

    this.islands = []
    this.uniforms = {}

    this.add_island()
    this.island = this.islands[0]
  }

  onContextLost(e: WebGLContextEvent) {
    for (const island of this.islands) {
      island.onContextLost(e)
    }
  }

  reset(gl: WebGL2RenderingContext) {
    for (const island of this.islands) {
      island.reset(gl)
    }
  }

  flagRecalc() {
    for (const island of this.islands) {
      island.flagRecalc()
    }
  }

  getDataLayer(
    primflag: PrimitiveTypes,
    type: number,
    size = TypeSizes[type as keyof typeof TypeSizes],
    name = LayerTypeNames[type as keyof typeof LayerTypeNames]
  ): GeoLayer | undefined {
    let ret

    for (const island of this.islands) {
      const ret2 = island.getDataLayer(primflag, type, size, name)

      if (island === this.island) {
        ret = ret2
      }
    }

    return ret
  }

  addDataLayer(
    primflag: PrimitiveTypes,
    type: number,
    size = TypeSizes[type as keyof typeof TypeSizes],
    name = LayerTypeNames[type as keyof typeof LayerTypeNames]
  ): GeoLayer {
    let ret

    for (const island of this.islands) {
      const ret2 = island.addDataLayer(primflag, type, size, name)

      if (island === this.island) {
        ret = ret2
      }
    }

    return ret!
  }

  copy(): SimpleMesh {
    const ret = new SimpleMesh()

    ret.primflag = this.primflag
    ret.layerflag = this.layerflag

    for (const k in this.uniforms) {
      ret.uniforms[k] = this.uniforms[k]
    }

    for (const island of this.islands) {
      const island2 = island.copy()

      island2.mesh = ret
      ret.islands.push(island2)

      if (island === this.island) {
        ret.island = island2
      }
    }

    return ret
  }

  add_island(): SimpleIsland<{dead: false}> {
    const island = new SimpleIsland<{dead: false}>(this)
    this.island = island
    this.islands.push(island)
    return island
  }

  destroy(gl = this.gl) {
    for (const island of this.islands) {
      island.destroy(gl)
    }
  }

  tri(v1: Vector3Like, v2: Vector3Like, v3: Vector3Like, _id?: number): TriEditor<{dead: false}> {
    return this.island.tri(v1, v2, v3)
  }

  quad(v1: Vector3Like, v2: Vector3Like, v3: Vector3Like, v4: Vector3Like, _id?: number): QuadEditor<{dead: false}> {
    return this.island.quad(v1, v2, v3, v4)
  }

  line(v1: Vector3Like, v2: Vector3Like, _id?: number): LineEditor<{dead: false}> {
    return this.island.line(v1, v2)
  }

  point(v1: Vector3Like, _id?: number): PointEditor<{dead: false}> {
    return this.island.point(v1)
  }

  smoothline(v1: Vector3Like, v2: Vector3Like, _id?: number): LineEditor2<{dead: false}> {
    return this.island.smoothline(v1, v2)
  }

  // No-op on non-chunked meshes; overridden in ChunkedSimpleMesh.
  free(_id?: number): void {}

  drawLines(gl: WebGL2RenderingContext, uniforms: IUniformsBlock, program_override?: ShaderProgram): void {
    if (this._submitWebGpu(gl, uniforms, program_override, true)) return

    for (const island of this.islands) {
      const primflag = island.primflag

      island.primflag = PrimitiveTypes.LINES | PrimitiveTypes.ADVANCED_LINES
      island.draw(gl, uniforms, undefined, program_override)
      island.primflag = primflag
    }
  }

  draw(gl: WebGL2RenderingContext, uniforms?: IUniformsBlock, program_override?: ShaderProgram): void {
    this.gl = gl

    if (this._submitWebGpu(gl, uniforms, program_override, false)) return

    for (const island of this.islands) {
      island.draw(gl, uniforms, undefined, program_override)
    }
  }

  /**
   * On the WebGPU backend, route the legacy `mesh.draw(gl, ...)` call
   * through `createDrawQueue` so the WebGPU adapter resolves the
   * pipeline via `program.wgslKey` and dispatches against the open
   * render pass. Returns `true` if it handled the draw; `false` lets
   * the WebGL imperative path run.
   *
   * `linesOnly` is for `drawLines` callers — overrides each island's
   * primflag to LINES so the WebGPU side picks up the line pipeline.
   * (Not yet plumbed all the way through the adapter; the linesOnly
   * case currently falls back to the legacy island.draw on WebGPU
   * until we wire a per-call primitive override.)
   */
  protected _submitWebGpu(
    _gl: WebGL2RenderingContext,
    uniforms: IUniformsBlock | undefined,
    program_override: ShaderProgram | undefined,
    linesOnly: boolean
  ): boolean {
    if (!isWebGPU()) return false
    if (linesOnly) return false
    const ctx = getActiveWebGpuContext()
    if (!ctx || !ctx.currentPass) return false
    const program = program_override ?? this.program
    if (!program) return false
    const merged = (uniforms ? {...this.uniforms, ...uniforms} : this.uniforms) as IUniformsBlock
    const frame = {gl: undefined as unknown as WebGL2RenderingContext, uniforms: merged, program}
    const queue = createDrawQueue(frame)
    queue.submit({pipeline: program, mesh: this, uniforms: merged})
    return true
  }

  _uploadGpuBuffers(device: GPUDevice): void {
    for (const island of this.islands) {
      island._uploadGpuBuffers(device)
    }
  }

  drawGPU(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, uniforms: IUniformsBlock): void {
    for (const island of this.islands) {
      island.drawGPU(pass, pipeline, uniforms)
    }
  }
}

export class ChunkedSimpleMesh extends SimpleMesh {
  idmap: IIDMap
  chunksize: number
  freelist: number[]
  freeset: Set<number>
  chunkmap: IIDMap
  idgen: number
  regen: boolean = true

  quad_editors: util.cachering<QuadEditor>

  constructor(layerflag = LayerTypes.LOC | LayerTypes.NORMAL | LayerTypes.UV, chunksize = 2048) {
    super(layerflag)

    this.chunksize = chunksize
    this.islands = []
    this.uniforms = {}

    this.primflag = PrimitiveTypes.TRIS

    // XXX could use an assumption tag here
    this.island = undefined as unknown as typeof this.island

    this.quad_editors = util.cachering.fromConstructor(QuadEditor, 32, true)

    this.freelist = []
    this.freeset = new Set()

    this.chunkmap = new IIDMap()
    this.idmap = new IIDMap()
    this.idgen = 0
  }

  reset(gl: WebGL2RenderingContext): void {
    this.chunkmap = new IIDMap()
    this.idmap = new IIDMap()
    this.freelist.length = 0
    this.freeset = new Set()

    for (const island of this.islands) {
      island.reset(gl)
    }
  }

  free(id: number): void {
    const chunk = this.chunkmap.get(id)

    if (chunk === undefined || this.freeset.has(id)) {
      return
    }

    this.freelist.push(chunk)
    this.freelist.push(id)

    this.freeset.add(id)

    const island = this.islands[chunk]
    const i = this.idmap.get(id)!
    //console.log("free", id, chunk);

    //if (this.primflag & PrimitiveTypes.POINTS) {
    island.point_cos.copy(i, zero)
    //}
    //if (this.primflag & PrimitiveTypes.LINES) {
    island.line_cos.copy(i * 2, zero)
    island.line_cos.copy(i * 2 + 1, zero)
    //}
    //if (this.primflag & PrimitiveTypes.TRIS) {
    island.tri_cos.copy(i * 3, zero)
    island.tri_cos.copy(i * 3 + 1, zero)
    island.tri_cos.copy(i * 3 + 2, zero)
    //}

    island.flagRecalc()
  }

  get_chunk(id: number): SimpleIsland<{dead: false}> {
    if (id > 1 << 18 && this.idmap instanceof util.IDMap) {
      const idmap = new IIDMap()

      for (const [k, v] of this.idmap) {
        idmap.set(k, v)
      }

      this.idmap = idmap

      const chunkmap = new IIDMap()
      for (const [k, v] of this.chunkmap) {
        chunkmap.set(k, v)
      }

      this.chunkmap = chunkmap
    }
    /*
    if (this.islands.length === 0) {
      this.add_island();
    }
    let island = this.islands;
    if (island._i === undefined) {
      island._i = 0;
    }
    island.primflag = this.primflag;
    this.idmap.set(id, island._i++);
    return this.islands[0];

    */

    if (this.chunkmap.has(id)) {
      return this.islands[this.chunkmap.get(id)!]
    }

    if (this.freelist.length > 1) {
      const id2 = this.freelist.pop()!
      const chunk = this.freelist.pop()!

      this.chunkmap.set(id, chunk)
      this.idmap.set(id, id2)

      return this.islands[chunk]
    }

    const chunki = this.islands.length
    const chunk = this.add_island()
    chunk.primflag = this.primflag

    for (let i = 0; i < this.chunksize; i++) {
      this.freelist.push(chunki)
      this.freelist.push(this.chunksize - i - 1)
      chunk.tri(zero, zero, zero)
    }

    return this.get_chunk(id)
  }

  destroy(gl?: WebGL2RenderingContext) {
    for (const island of this.islands) {
      island.destroy(gl)
    }

    this.regen = true
    this.chunkmap = new IIDMap()
    this.idmap = new IIDMap()
    this.freelist.length = 0

    this.islands.length = 0
    this.add_island()
  }

  tri(v1: Vector3Like, v2: Vector3Like, v3: Vector3Like, id?: number): TriEditor<{dead: false}> {
    if (id === undefined) {
      throw new Error('ChunkedSimpleMesh.tri requires an id')
    }
    if (0) {
      function isvec(v: any) {
        if (!v) {
          return false
        }
        let ret = typeof v.length === 'number'
        ret = ret && v.length >= 3

        ret = ret && typeof v[0] === 'number'
        ret = ret && typeof v[1] === 'number'
        ret = ret && typeof v[2] === 'number'

        return ret
      }

      let bad = typeof id !== 'number'
      bad = bad || Math.floor(id) !== id
      bad = bad || !isvec(v1)
      bad = bad || !isvec(v2)
      bad = bad || !isvec(v3)

      if (bad) {
        throw new Error('bad parameters')
      }
    }

    const chunk = this.get_chunk(id)!
    const itri = this.idmap.get(id)!

    chunk.flagRecalc()
    chunk.glFlagUploadAll(PrimitiveTypes.TRIS)

    const tri_cos = chunk.tri_cos

    let i = itri * 9

    if (tri_cos.dataUsed < i + 9) {
      chunk.regen = true

      return chunk.tri(v1, v2, v3)
    } else {
      tri_cos.glReady = false
      const cos = tri_cos._getWriteData()

      cos[i++] = v1[0]
      cos[i++] = v1[1]
      cos[i++] = v1[2]

      cos[i++] = v2[0]
      cos[i++] = v2[1]
      cos[i++] = v2[2]

      cos[i++] = v3[0]
      cos[i++] = v3[1]
      cos[i++] = v3[2]

      if (i > cos.length) {
        console.log(i, cos.length, cos)
        throw new Error('range error')
      }
    }

    chunk.regen = true
    return chunk.tri_editors.next().bind(chunk, itri)
  }

  quad(
    _v1: Vector3Like,
    _v2: Vector3Like,
    _v3: Vector3Like,
    _v4: Vector3Like,
    _id?: number
  ): QuadEditor<{dead: false}> {
    // TODO: synthesise two tri() slots per id once a caller needs it.
    // The two synthesised sub-ids would need to live in their own namespace
    // so they don't collide with `tri()` ids on the same mesh.
    throw new Error('ChunkedSimpleMesh.quad: not yet supported (use two tri() calls)')
  }

  smoothline(v1: Vector3Like, v2: Vector3Like, id?: number): LineEditor2<{dead: false}> {
    if (id === undefined) {
      throw new Error('ChunkedSimpleMesh.smoothline requires an id')
    }
    const chunk = this.get_chunk(id)
    let iline = this.idmap.get(id)!

    chunk.flagRecalc()
    chunk.glFlagUploadAll(PrimitiveTypes.ADVANCED_LINES)

    if (!chunk.line_cos2) {
      // XXX add an extraPrimFlag field like for layer flags
      if (chunk.primflag === undefined) {
        chunk.primflag = this.primflag
      }
      chunk.primflag |= PrimitiveTypes.ADVANCED_LINES
      this.layerflag |= LayerTypes.CUSTOM
      chunk.makeBufferAliases()
    }

    const line_cos = chunk.line_cos2
    let i = iline * 18

    if (line_cos.dataUsed < i + 18) {
      const ret = chunk.smoothline(v1, v2)

      iline = ret.i
      this.idmap.set(id, iline)

      return ret
    } else {
      const cos = line_cos._getWriteData()

      cos[i++] = v1[0]
      cos[i++] = v1[1]
      cos[i++] = v1[2]

      cos[i++] = v1[0]
      cos[i++] = v1[1]
      cos[i++] = v1[2]

      cos[i++] = v2[0]
      cos[i++] = v2[1]
      cos[i++] = v2[2]

      cos[i++] = v1[0]
      cos[i++] = v1[1]
      cos[i++] = v1[2]

      cos[i++] = v2[0]
      cos[i++] = v2[1]
      cos[i++] = v2[2]

      cos[i++] = v2[0]
      cos[i++] = v2[1]
      cos[i++] = v2[2]

      if (i > cos.length) {
        console.log(i, cos.length, cos)
        throw new Error('range error')
      }
    }

    chunk.regen = true
    return chunk.tristrip_line_editors.next().bind(chunk, iline)
  }

  line(v1: Vector3Like, v2: Vector3Like, id?: number): LineEditor<{dead: false}> {
    if (id === undefined) {
      throw new Error('ChunkedSimpleMesh.line requires an id')
    }
    //return this.smoothline(id, v1, v2);

    const chunk = this.get_chunk(id)
    const iline = this.idmap.get(id)!

    chunk.flagRecalc()
    chunk.glFlagUploadAll(PrimitiveTypes.LINES)

    const line_cos = chunk.line_cos
    let i = iline * 6

    if (line_cos.dataUsed < i + 6) {
      chunk.line(v1, v2)
    } else {
      const cos = line_cos._getWriteData()
      cos[i++] = v1[0]
      cos[i++] = v1[1]
      cos[i++] = v1[2]
      cos[i++] = v2[0]
      cos[i++] = v2[1]
      cos[i++] = v2[2]

      if (i > cos.length) {
        console.log(i, cos.length, cos)
        throw new Error('range error')
      }
    }

    chunk.regen = true
    return chunk.line_editors.next().bind(chunk, iline)
  }

  point(v1: Vector3Like, id?: number): PointEditor<{dead: false}> {
    if (id === undefined) {
      throw new Error('ChunkedSimpleMesh.point requires an id')
    }
    const chunk = this.get_chunk(id)
    const ipoint = this.idmap.get(id)!

    chunk.flagRecalc()
    chunk.glFlagUploadAll(PrimitiveTypes.POINTS)

    const point_cos = chunk.point_cos
    let i = ipoint * 3

    if (point_cos.dataUsed < i + 3) {
      chunk.point(v1)
    } else {
      const cos = point_cos._getWriteData()
      cos[i++] = v1[0]
      cos[i++] = v1[1]
      cos[i++] = v1[2]

      if (i > cos.length) {
        console.log(i, cos.length, cos)
        throw new Error('range error')
      }
    }

    chunk.regen = true
    return chunk.point_editors.next().bind(chunk, ipoint)
  }

  draw(gl: WebGL2RenderingContext, uniforms: IUniformsBlock, program_override?: ShaderProgram): void {
    this.gl = gl

    if (this._submitWebGpu(gl, uniforms, program_override, false)) return

    for (const island of this.islands) {
      island.draw(gl, uniforms, undefined, program_override)
    }
  }
}
