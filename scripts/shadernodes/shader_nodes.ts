import type {DataBlock, BlockLoader, BlockLoaderAddUser} from '../core/lib_api.js'
import type {StructReader} from '../path.ux/scripts/util/nstructjs.js'
import {Node, NodeSocketType, SocketFlags, INodeSocketSet} from '../core/graph.js'
import {nstructjs, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'

import {Vec2Socket, Vec3Socket, RGBASocket, FloatSocket} from '../core/graphsockets.js'
import {UIBase} from '../path.ux/scripts/core/ui_base.js'
import {Container} from '../path.ux/scripts/core/ui.js'
import {Vector3} from '../util/vectormath.js'
import {AbstractGraphClass} from '../core/graph_class.js'
import {ImageUser} from '../image/image.js'
import type {ImageUserWidget} from '../editors/editor_base.js'
import type {RenderLight} from '../renderengine/renderengine_realtime.js'
import type {WgslShaderGenerator} from './shader_nodes_wgsl.js'
import {LightGenWgsl, DiffuseBRDFWgsl} from './shader_lib_wgsl.js'
import * as units from '../path.ux/scripts/core/units.js'

export {ClosureGLSL, PointLightCode} from './shader_lib.js'

export type IRenderLights = Record<string, RenderLight>

export const ShaderNodeTypes: (typeof ShaderNode)[] = []

export class ShaderNetworkClass extends AbstractGraphClass {
  declare static NodeTypes: (typeof ShaderNode)[]

  static graphdef() {
    return {
      typeName  : 'shader',
      uiName    : 'Shader Network',
      graph_flag: 0,
    }
  }
}

ShaderNetworkClass.NodeTypes = ShaderNodeTypes

AbstractGraphClass.registerClass(ShaderNetworkClass)

export class Closure {
  static STRUCT: string
  emission: Vector3
  light: Vector3
  scatter: Vector3
  normal: Vector3
  roughness: number
  sssRadius: number
  alpha: number

  constructor() {
    this.emission = new Vector3()
    this.light = new Vector3([1, 0.75, 0.5])
    this.scatter = new Vector3()
    this.normal = new Vector3()
    this.roughness = 0.1
    this.sssRadius = 0.0
    this.alpha = 1.0
  }

  load(b: Closure): this {
    this.emission.load(b.emission)
    this.light.load(b.light)
    this.scatter.load(b.scatter)
    this.normal = new Vector3()
    this.roughness = b.roughness
    this.sssRadius = b.sssRadius
    this.alpha = b.alpha

    return this
  }

  copy() {
    return new Closure().load(this)
  }
}

Closure.STRUCT = `
shader.Closure {
  emission   : vec3;
  light      : vec3;
  scatter    : vec3;
  normal     : vec3;
  roughness  : float;
  sssRadius  : float;
  alpha      : float;
}
`
nstructjs.register(Closure)

export class ClosureSocket extends NodeSocketType<Closure> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
shader.ClosureSocket {
  data : shader.Closure;
}`
  )

  data: Closure

  constructor() {
    super()

    this.data = new Closure()
  }

  static nodedef() {
    return {
      name  : 'closure',
      uiname: 'Surface',
      color : [0.59, 0.78, 1.0, 1.0],
      // A closure has no editable scalar value, so suppress the base socket's
      // inline value editor. Without this an *unconnected* closure socket
      // (e.g. a Diffuse `surface` output with nothing plugged in) makes
      // NodeSocketType.buildUI call container.prop('value'), which throws —
      // ClosureSocket exposes `data`, not `value` — and the throw aborts the
      // socket-widget build so the output dot never renders.
      flag  : SocketFlags.NO_UI_EDITING,
    }
  }

  copyValue(): Closure {
    return this.data.copy()
  }

  getValue(): Closure {
    return this.data
  }

  copyTo(b: this): void {
    super.copyTo(b)
  }

  copy(): this {
    const ret = new ClosureSocket()
    this.copyTo(ret as this)

    ret.data.load(this.data)
    return ret as this
  }

  setValue(b: Closure): void {
    this.data.load(b)
  }
}

NodeSocketType.register(ClosureSocket)

/**
 * Always-present coordinate-space varyings a node can fall back to when an
 * input socket is unconnected. WebGL-era attribute slots (NORMAL/UV/TANGENT/ID)
 * are gone — geometry attributes are now requested by name through the
 * `AttributeNode` and supplied as dynamic vertex buffers by the renderer.
 */
export const ShaderContext = {
  GLOBALCO: 1,
  LOCALCO : 2,
  SCREENCO: 4,
  COLOR   : 32,
}

const _warnedNoEmitter = new Set<string>()

/** Prefix on the container a ShaderNode's `buildUI` is handed. */
export type ShaderNodeDataPrefix = 'shadernetwork.graph.nodes[n].'
type DataPrefix = ShaderNodeDataPrefix
export class ShaderNode<
  InputSet extends INodeSocketSet = INodeSocketSet,
  OutputSet extends INodeSocketSet = INodeSocketSet,
> extends Node<InputSet, OutputSet, unknown> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
shader.ShaderNode {
}`
  )

  constructor() {
    super()
  }

  /**
   * Emit this node's WGSL into `gen.buf`. The base implementation writes
   * type-appropriate zero/default values for every output socket (used by
   * nodes that have no bespoke emission yet), warning once per class.
   * Subclasses override with their real codegen.
   */
  genWgsl(gen: WgslShaderGenerator): void {
    const name = this.constructor?.name ?? '<unknown>'
    if (!_warnedNoEmitter.has(name)) {
      _warnedNoEmitter.add(name)
      // eslint-disable-next-line no-console
      console.warn(`ShaderNode: no genWgsl override for ${name} — emitting defaults`)
    }
    for (const k in this.outputs) {
      const sock = this.outputs[k]
      const t = gen.getType(sock)
      const n = gen.getSocketName(sock)
      if (t === 'f32') gen.out(`${n} = 0.0;\n`)
      else if (t === 'vec2f') gen.out(`${n} = vec2f(0.0, 0.0);\n`)
      else if (t === 'vec3f') gen.out(`${n} = vec3f(0.0, 0.0, 0.0);\n`)
      else if (t === 'vec4f') gen.out(`${n} = vec4f(0.0, 0.0, 0.0, 1.0);\n`)
      else if (t === 'Closure') {
        gen.out(`${n}.diffuse = vec3f(0.0); ${n}.light = vec3f(0.0); `)
        gen.out(`${n}.emission = vec3f(0.0); ${n}.scatter = vec3f(0.0); ${n}.alpha = 1.0;\n`)
      }
    }
  }

  buildUI(_container: Container): void {}
}

export class OutputNode<InputSet extends INodeSocketSet = {}, OutputSet extends INodeSocketSet = {}> //
  extends ShaderNode<InputSet & {surface: ClosureSocket}, OutputSet>
{
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
shader.OutputNode {
}`
  )

  constructor() {
    super()
  }

  static nodedef() {
    return {
      category: 'Outputs',
      uiname  : 'Output',
      name    : 'output',
      inputs: {
        surface: new ClosureSocket(),
      },
      outputs : {},
    }
  }

  genWgsl(gen: WgslShaderGenerator): void {
    gen.out(`_mainSurface = ${gen.getSocketValue(this.inputs.surface)};\n`)
  }
}
ShaderNetworkClass.register(OutputNode)

export const MixModes = {
  MIX     : 0,
  MULTIPLY: 1,
  DIVIDE  : 2,
  ADD     : 3,
  SUBTRACT: 4,
}

export class MixNode<InputSet extends INodeSocketSet = {}, OutputSet extends INodeSocketSet = {}> //
  extends ShaderNode<
    InputSet & {factor: FloatSocket; color1: RGBASocket; color2: RGBASocket},
    OutputSet & {color: RGBASocket}
  >
{
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  shader.MixNode {
    mode : int;
  }`
  )

  mode: number

  constructor() {
    super()

    this.mode = MixModes.MIX
    this.graph_ui_size[1] = 350
  }

  static defineAPI(api: DataAPI, nodeStruct: DataStruct) {
    super.defineAPI(api, nodeStruct)
    nodeStruct.enum('mode', 'mode', MixModes, 'Mode')
    return nodeStruct
  }

  static nodedef() {
    return {
      category: 'Color',
      uiname  : 'Mix',
      name    : 'mix',
      inputs: {
        factor: new FloatSocket(undefined, undefined, 0.5),
        color1: new RGBASocket(),
        color2: new RGBASocket(),
      },

      outputs: {
        color: new RGBASocket(undefined, SocketFlags.NO_UI_EDITING),
      },
    }
  }

  genWgsl(gen: WgslShaderGenerator): void {
    let expr = 'a + (b - a)*fac'

    switch (this.mode) {
      case MixModes.MIX:
        expr = 'a + (b - a)*fac'
        break
      case MixModes.MULTIPLY:
        expr = 'a + (a*b - a)*fac'
        break
      case MixModes.DIVIDE:
        expr = 'a + (a/b - a)*fac'
        break
      case MixModes.ADD:
        expr = 'a + ((a+b) - a)*fac'
        break
      case MixModes.SUBTRACT:
        expr = 'a + ((a-b) - a)*fac'
        break
    }

    gen.out(`
      let a : vec4f = ${gen.getSocketValue(this.inputs.color1)};
      let b : vec4f = ${gen.getSocketValue(this.inputs.color2)};
      let fac : f32 = ${gen.getSocketValue(this.inputs.factor)};
      ${gen.getSocketName(this.outputs.color)} = ${expr};
    `)
  }

  buildUI(container: Container): void {
    super.buildUI(container)

    container.prop('mode')
  }

  loadSTRUCT(reader: StructReader): void {
    reader(this)
    super.loadSTRUCT(reader)
  }
}

ShaderNetworkClass.register(MixNode)

export class ImageNode<InputSet extends INodeSocketSet = {}, OutputSet extends INodeSocketSet = {}> //
  extends ShaderNode<InputSet & {uv: Vec2Socket}, OutputSet & {color: RGBASocket}>
{
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  shader.ImageNode {
    imageUser : ImageUser;
  }`
  )

  imageUser: ImageUser

  constructor() {
    super()

    this.imageUser = new ImageUser()
    this.graph_ui_size[1] = 512
  }

  static defineAPI(api: DataAPI, nodeStruct: DataStruct) {
    super.defineAPI(api, nodeStruct)
    nodeStruct.struct('imageUser', 'imageUser', 'Image', api.mapStruct(ImageUser))
    return nodeStruct
  }

  static nodedef() {
    return {
      category: 'Input',
      uiname  : 'Image',
      name    : 'image',
      inputs: {
        uv: new Vec2Socket(undefined, SocketFlags.NO_UI_EDITING),
      },

      outputs: {
        color: new RGBASocket(undefined, SocketFlags.NO_UI_EDITING),
      },
    }
  }

  genWgsl(gen: WgslShaderGenerator): void {
    const out = gen.getSocketName(this.outputs.color)

    if (this.imageUser.image) {
      const tex = gen.getTexture(this.imageUser.image)
      gen.out(`
        let uv : vec2f = ${gen.getSocketValue(this.inputs.uv, 'input.vLocalCo.xy')};
        let _c : vec4f = textureSample(${tex}_tex, ${tex}_smp, uv);
        ${out} = vec4f(_c.rgb, 1.0);
      `)
    } else {
      gen.out(`${out} = vec4f(1.0, 1.0, 1.0, 1.0);\n`)
    }
  }

  buildUI(container: Container): void {
    super.buildUI(container)

    container.label('Image')
    const iuser = UIBase.createElement('image-user-x') as ImageUserWidget
    const path = container._joinPrefix('imageUser') ?? ''

    iuser.setAttribute('datapath', path)
    iuser.vertical = true

    container.add(iuser)
  }

  graphDataLink(ownerBlock: DataBlock, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser): void {
    super.graphDataLink(ownerBlock, getblock, getblock_addUser)

    this.imageUser.dataLink(ownerBlock, getblock, getblock_addUser)
  }

  loadSTRUCT(reader: StructReader): void {
    reader(this)
    super.loadSTRUCT(reader)
  }
}

ShaderNetworkClass.register(ImageNode)

export class DiffuseNode<InputSet extends INodeSocketSet = {}, OutputSet extends INodeSocketSet = {}> //
  extends ShaderNode<
    InputSet & {color: RGBASocket; roughness: FloatSocket; normal: Vec3Socket},
    OutputSet & {surface: ClosureSocket}
  >
{
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  shader.DiffuseNode {
  }`
  )

  constructor() {
    super()
  }

  static nodedef() {
    return {
      category: 'Shaders',
      uiname  : 'Diffuse',
      name    : 'diffuse',
      inputs: {
        color    : new RGBASocket(undefined, undefined, [0.8, 0.8, 0.8, 1.0]),
        roughness: new FloatSocket(),
        normal   : new Vec3Socket(),
      },
      outputs: {
        surface: new ClosureSocket(),
      },
    }
  }

  genWgsl(gen: WgslShaderGenerator): void {
    const brdf = DiffuseBRDFWgsl.gen('cl', 'co', 'normal', 'color')
    const lights = LightGenWgsl.generate('cl', 'co', 'normal', 'color', brdf)
    const surfName = gen.getSocketName(this.outputs.surface)

    gen.out(`
      var cl : Closure;
      cl.diffuse  = vec3f(0.0);
      cl.light    = vec3f(0.0);
      cl.emission = vec3f(0.0);
      cl.scatter  = vec3f(0.0);
      cl.alpha    = 1.0;

      let co : vec3f = input.vGlobalCo;
      let roughness : f32 = ${gen.getSocketValue(this.inputs.roughness)};
      let normal : vec3f = ${gen.getSocketValue(this.inputs.normal, 'input.vNormal')};
      let color : vec4f = ${gen.getSocketValue(this.inputs.color)};

      cl.alpha   = color.a;
      cl.diffuse = color.rgb;

      ${lights}
      ${surfName} = cl;
    `)
  }

  loadSTRUCT(reader: StructReader): void {
    reader(this)
    super.loadSTRUCT(reader)
  }
}

ShaderNetworkClass.register(DiffuseNode)

/**
 * Distance units the SubsurfaceScattering node can author its scatter radius
 * in. Fixed integer enum (stable across saves); the meter-conversion factor is
 * resolved at codegen via `units.convert(1, name, baseUnit)`. Skin profiles are
 * conventionally authored in millimeters, so that is the default.
 */
export const SSSUnits = {
  MILLIMETER: 0,
  CENTIMETER: 1,
  METER     : 2,
  INCH      : 3,
  FOOT      : 4,
}

const SSSUnitName: Record<number, string> = {
  [SSSUnits.MILLIMETER]: 'millimeter',
  [SSSUnits.CENTIMETER]: 'centimeter',
  [SSSUnits.METER]     : 'meter',
  [SSSUnits.INCH]      : 'inch',
  [SSSUnits.FOOT]      : 'foot',
}

/**
 * Subsurface scattering BSDF node. Like DiffuseNode it accumulates lit diffuse
 * irradiance into the closure, but writes it into `scatter` (the irradiance the
 * screen-space SSS passes diffuse) and records a per-pixel world-space
 * `sssRadius`. The `unit` parameter converts the authored `radius`/`scale` into
 * world units (meters) via a CPU-computed factor baked into the emitted WGSL.
 */
export class SubsurfaceScatteringNode<
  InputSet extends INodeSocketSet = {},
  OutputSet extends INodeSocketSet = {},
> extends ShaderNode<
  InputSet & {
    surface: ClosureSocket
    color: RGBASocket
    radius: Vec3Socket
    scale: FloatSocket
    normal: Vec3Socket
  },
  OutputSet & {surface: ClosureSocket}
> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  shader.SubsurfaceScatteringNode {
    unit : int;
  }`
  )

  unit: number

  constructor() {
    super()
    this.unit = SSSUnits.MILLIMETER
  }

  static defineAPI(api: DataAPI, nodeStruct: DataStruct) {
    super.defineAPI(api, nodeStruct)
    nodeStruct.enum('unit', 'unit', SSSUnits, 'Unit', 'Unit the scatter radius is authored in')
    return nodeStruct
  }

  buildUI(container: Container): void {
    const con = container.withDataPrefix<DataPrefix>()
    con.prop('unit')
  }

  static nodedef() {
    return {
      category: 'Shaders',
      uiname  : 'Subsurface Scattering',
      name    : 'subsurface_scattering',
      inputs: {
        // Optional upstream lit surface (e.g. a Diffuse node). When connected,
        // its lit irradiance (cl.light) is what gets diffused; color/normal are
        // ignored. When unconnected the node lights itself from color/normal.
        surface: new ClosureSocket(),
        color  : new RGBASocket(undefined, undefined, [0.8, 0.5, 0.4, 1.0]),
        radius : new Vec3Socket(undefined, undefined, [1.0, 0.3, 0.2]),
        scale  : new FloatSocket(undefined, undefined, 1.0),
        normal : new Vec3Socket(),
      },
      outputs: {
        surface: new ClosureSocket(),
      },
    }
  }

  genWgsl(gen: WgslShaderGenerator): void {
    const surfName = gen.getSocketName(this.outputs.surface)

    // CPU-side: factor that converts the authored unit to internal/world
    // meters, baked as a WGSL literal (the user changes units rarely; this
    // recompiles the material). See [[shadernodes]] unit handling.
    const unitName = SSSUnitName[this.unit] ?? 'millimeter'
    const unitFactor = units.convert(1, unitName, units.Unit.baseUnit)

    const radiusVal = gen.getSocketValue(this.inputs.radius)
    const scaleVal = gen.getSocketValue(this.inputs.scale)

    // Common tail: route the lit irradiance into `scatter` (so the screen-space
    // SSS passes blur it) and record the per-pixel world-space radius.
    const tail = `
      let sssRadiusVec : vec3f = ${radiusVal};
      let sssScale : f32 = ${scaleVal};
      cl.scatter      = cl.light;
      cl.sssRadiusVec = sssRadiusVec * sssScale * ${unitFactor};
      cl.sssRadius    = max(cl.sssRadiusVec.x, max(cl.sssRadiusVec.y, cl.sssRadiusVec.z));
      ${surfName} = cl;
    `

    if (this.inputs.surface.edges.length > 0) {
      // Diffuse → SSS → Output: take the upstream node's already-lit closure and
      // mark its irradiance for subsurface diffusion. color/normal are unused
      // here (the upstream surface owns the shading), so they emit no uniforms.
      const upstream = gen.getSocketValue(this.inputs.surface)
      gen.out(`
      var cl : Closure = ${upstream};
      ${tail}
    `)
      return
    }

    // Standalone: light ourselves from color/normal, like DiffuseNode.
    const brdf = DiffuseBRDFWgsl.gen('cl', 'co', 'normal', 'color')
    const lights = LightGenWgsl.generate('cl', 'co', 'normal', 'color', brdf)

    gen.out(`
      var cl : Closure;
      cl.diffuse   = vec3f(0.0);
      cl.light     = vec3f(0.0);
      cl.emission  = vec3f(0.0);
      cl.scatter   = vec3f(0.0);
      cl.sssRadius = 0.0;
      cl.alpha     = 1.0;

      let co : vec3f = input.vGlobalCo;
      let normal : vec3f = ${gen.getSocketValue(this.inputs.normal, 'input.vNormal')};
      let color : vec4f = ${gen.getSocketValue(this.inputs.color)};
      let roughness : f32 = 1.0;

      cl.alpha   = color.a;
      cl.diffuse = color.rgb;

      ${lights}
      ${tail}
    `)
  }

  loadSTRUCT(reader: StructReader): void {
    reader(this)
    super.loadSTRUCT(reader)
  }
}

ShaderNetworkClass.register(SubsurfaceScatteringNode)

export class GeometryNode<
  InputSet extends INodeSocketSet = {},
  OutputSet extends INodeSocketSet = {},
> extends ShaderNode<
  InputSet,
  OutputSet & {
    position: Vec3Socket
    normal: Vec3Socket
    screen: Vec3Socket
    local: Vec3Socket
  }
> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  shader.GeometryNode {
  }`
  )

  constructor() {
    super()
  }

  static nodedef() {
    return {
      category: 'Inputs',
      uiname  : 'Geometry',
      name    : 'geometry',
      inputs  : {},
      outputs: {
        position: new Vec3Socket(),
        normal  : new Vec3Socket(),
        screen  : new Vec3Socket(),
        local   : new Vec3Socket(),
      },
    }
  }

  genWgsl(gen: WgslShaderGenerator): void {
    gen.out(`
      ${gen.getSocketName(this.outputs.position)} = input.vGlobalCo;
      ${gen.getSocketName(this.outputs.local)}    = input.vLocalCo;
      ${gen.getSocketName(this.outputs.normal)}   = input.vNormal;
      ${gen.getSocketName(this.outputs.screen)}   = vec3f(input.clipPos.xy, input.clipPos.z);
    `)
  }

  loadSTRUCT(reader: StructReader): void {
    reader(this)
    super.loadSTRUCT(reader)
  }
}

ShaderNetworkClass.register(GeometryNode)

/**
 * Attribute categories an `AttributeNode` can request. Values match the
 * sculptcore `AttrUse` bitflags (COLOR=2, UV=4) so they pass straight through
 * to the renderer / C++ attribute resolution; `GENERIC` (0) requests by name
 * regardless of role and is read as a vec3.
 */
export const AttributeCategory = {
  GENERIC: 0,
  COLOR  : 2,
  UV     : 4,
}

/** One attribute row offered in the AttributeNode dropdown. Duck-typed against
 * `LiteMesh.attrItems` so shadernodes need not import the lite-mesh layer. */
interface IAttrItem {
  attrName: string
  use: number
  name: string
}

/**
 * Reads a single named mesh attribute and exposes it Blender-style through
 * three fixed outputs (`color`/vec4, `vector`/vec3, `fac`/float), all driven
 * from the one selected attribute by swizzle/broadcast. The attribute is
 * requested by name + category from the renderer, which supplies it as a
 * dynamic vertex buffer (default-filled when absent — never an error).
 */
export class AttributeNode<
  InputSet extends INodeSocketSet = {},
  OutputSet extends INodeSocketSet = {},
> extends ShaderNode<InputSet, OutputSet & {color: RGBASocket; vector: Vec3Socket; fac: FloatSocket}> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  shader.AttributeNode {
    attrName : string;
    category : int;
  }`
  )

  attrName: string
  category: number

  constructor() {
    super()

    this.attrName = ''
    this.category = AttributeCategory.COLOR
  }

  static defineAPI(api: DataAPI, nodeStruct: DataStruct) {
    super.defineAPI(api, nodeStruct)
    nodeStruct.enum('category', 'category', AttributeCategory, 'Category', 'Attribute category to list')
    return nodeStruct
  }

  static nodedef() {
    return {
      category: 'Inputs',
      uiname  : 'Attribute',
      name    : 'attribute',
      inputs  : {},
      outputs: {
        color : new RGBASocket(undefined, SocketFlags.NO_UI_EDITING),
        vector: new Vec3Socket(undefined, SocketFlags.NO_UI_EDITING),
        fac   : new FloatSocket(undefined, SocketFlags.NO_UI_EDITING),
      },
    }
  }

  genWgsl(gen: WgslShaderGenerator): void {
    const colorOut = gen.getSocketName(this.outputs.color)
    const vecOut = gen.getSocketName(this.outputs.vector)
    const facOut = gen.getSocketName(this.outputs.fac)

    if (!this.attrName) {
      gen.out(`
        ${colorOut} = vec4f(0.0, 0.0, 0.0, 1.0);
        ${vecOut}   = vec3f(0.0, 0.0, 0.0);
        ${facOut}   = 0.0;
      `)
      return
    }

    const {field, wgslType} = gen.requestAttribute(this.attrName, this.category)
    const lum = 'vec3f(0.2126, 0.7152, 0.0722)'

    let asVec4: string
    let asVec3: string
    let asFac: string

    switch (wgslType) {
      case 'vec4f':
        asVec4 = field
        asVec3 = `${field}.xyz`
        asFac = `dot(${field}.rgb, ${lum})`
        break
      case 'vec2f':
        asVec4 = `vec4f(${field}, 0.0, 1.0)`
        asVec3 = `vec3f(${field}, 0.0)`
        asFac = `${field}.x`
        break
      default: // vec3f
        asVec4 = `vec4f(${field}, 1.0)`
        asVec3 = field
        asFac = `dot(${field}, ${lum})`
        break
    }

    gen.out(`
      ${colorOut} = ${asVec4};
      ${vecOut}   = ${asVec3};
      ${facOut}   = ${asFac};
    `)
  }

  buildUI(container: Container): void {
    super.buildUI(container)

    container.prop('category')

    const ctx = container.ctx as {mesh?: {attrItems?: IAttrItem[]}} | undefined
    const mesh = ctx?.mesh
    const enumDef: Record<string, string> = {}

    if (mesh && Array.isArray(mesh.attrItems)) {
      for (const item of mesh.attrItems) {
        if (this.category === AttributeCategory.GENERIC || item.use & this.category) {
          enumDef[item.name] = item.attrName
        }
      }
    }

    if (Object.keys(enumDef).length === 0) {
      enumDef['(no attributes)'] = ''
    }

    container.listenum(undefined, {
      name: 'Attribute',
      enumDef,
      defaultval: this.attrName,
      callback: (val: string | number) => {
        this.attrName = String(val)
        this.graphUpdate()
      },
    })
  }

  loadSTRUCT(reader: StructReader): void {
    reader(this)
    super.loadSTRUCT(reader)
  }
}

ShaderNetworkClass.register(AttributeNode)
