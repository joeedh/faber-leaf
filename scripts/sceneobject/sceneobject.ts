import {BlockLoader, BlockLoaderAddUser, DataBlock, DataRef} from '../core/lib_api.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import {
  nstructjs,
  util,
  Matrix4,
  EulerOrders,
  Vector3,
  Vector4,
  IVector4,
  DataAPI,
  DataStruct,
} from '../path.ux/pathux.js'

import {SocketFlags} from '../core/graph.js'
import {DrawModes, DrawFlags} from './drawmode'
import {deleteTsEnumIntegers} from '../util/enum-utils'
import {Vec3Socket, DependSocket, Matrix4Socket, Vec4Socket, EnumSocket} from '../core/graphsockets.js'
import {Shaders} from '../shaders/shaders'
import {SceneObjectData} from './sceneobject_base'
import {Material} from '../core/material'
import {ShaderProgram} from '../webgl/webgl.js'
import type {View3D} from '../editors/all.js'
import {StructReader} from '../path.ux/scripts/util/nstructjs.js'
import {NullObject} from '../nullobject/nullobject.js'
import {FrameContext} from '../render/queue'
import {createDrawQueue} from '../render/queue_factory.js'

const loc_rets = util.cachering.fromConstructor(Vector3, 256)

/**
 Scene object flags

 @example

 export const ObjectFlags = {
 SELECT    : 1,
 HIDE      : 2,
 LOCKED    : 4,
 HIGHLIGHT : 8,
 ACTIVE    : 16
 };
 */
export enum ObjectFlags {
  NONE = 0,
  SELECT = 1,
  HIDE = 2,
  LOCKED = 4,
  HIGHLIGHT = 8,
  ACTIVE = 16,
  INTERNAL = 32,
  /* Bit 64 was DRAW_WIREFRAME — folded into DrawFlags.WIREFRAME (loadSTRUCT
   * migrates old files). Keep the bit reserved. */
}

function mix(a: IVector4 | number[], b: IVector4 | number[], t: number) {
  return new Vector4(a).interp(b as unknown as IVector4, t)
}

export const Colors: {[k: number]: Vector4} = {
  0                    : new Vector4([0.7, 0.7, 0.7, 1.0]), //0
  [ObjectFlags.SELECT]   : new Vector4([1.0, 0.378, 0.15, 1.0]), //1
  [ObjectFlags.HIGHLIGHT]: new Vector4([0.9, 0.5, 0.3, 1.0]), //8
  [ObjectFlags.ACTIVE]   : new Vector4([0.0, 0.5, 1.0, 1.0]),
}

Colors[ObjectFlags.SELECT | ObjectFlags.HIGHLIGHT] = mix(Colors[ObjectFlags.SELECT], Colors[ObjectFlags.HIGHLIGHT], 0.5)
Colors[ObjectFlags.SELECT | ObjectFlags.ACTIVE] = mix(Colors[ObjectFlags.SELECT], Colors[ObjectFlags.ACTIVE], 0.5)
Colors[ObjectFlags.SELECT | ObjectFlags.ACTIVE | ObjectFlags.HIGHLIGHT] = mix(
  Colors[ObjectFlags.SELECT | ObjectFlags.HIGHLIGHT],
  Colors[ObjectFlags.ACTIVE | ObjectFlags.SELECT],
  0.5
)

export function composeObjectMatrix(
  loc: Vector3,
  rot: Vector3,
  scale: Vector3,
  rotorder: EulerOrders,
  mat = new Matrix4()
) {
  mat.makeIdentity()

  if (isNaN(loc.dot(loc))) {
    loc.zero()
  }
  if (isNaN(rot.dot(rot))) {
    rot.zero()
  }
  if (isNaN(scale.dot(scale))) {
    scale[0] = scale[1] = scale[2] = 1.0
  }

  mat.euler_rotate_order(rot[0], rot[1], rot[2], rotorder)
  mat.scale(scale[0], scale[1], scale[2])

  const m = mat.$matrix
  m.m41 = loc[0]
  m.m42 = loc[1]
  m.m43 = loc[2]
  m.m44 = 1.0
  //mat.translate(loc[0], loc[1], loc[2]);

  return mat
}

export class SceneObject<
  OBDATA extends SceneObjectData<any, any> = SceneObjectData<any, any>,
  InputSet extends {} = {},
  OutputSet extends {} = {},
> extends DataBlock<
  InputSet & {
    depend: DependSocket
    rot: Vec3Socket
    loc: Vec3Socket
    scale: Vec3Socket
    rotOrder: EnumSocket
    color: Vec4Socket
    matrix: Matrix4Socket
  },
  OutputSet & {
    depend: DependSocket
    color: Vec4Socket
    matrix: Matrix4Socket
  }
> {
  data: OBDATA
  flag: ObjectFlags
  drawMode: DrawModes
  drawFlag: DrawFlags

  // update generation
  updateGen?: number

  constructor(data?: OBDATA) {
    super()

    // is assigned after datablock instantiation
    this.data = data as unknown as OBDATA
    this.flag = 0
    this.drawMode = DrawModes.TEXTURED
    this.drawFlag = DrawFlags.NONE

    if (data) {
      data.lib_addUser(this)
    }
    /** @type {ObjectFlags}*/
  }

  get rotationEuler() {
    return this.inputs.rot.getValue()
  }

  get rotationOrder() {
    return this.inputs.rotOrder.getValue()
  }

  set rotationOrder(i) {
    this.inputs.rotOrder.setValue(i)
  }

  get location() {
    return this.inputs.loc.getValue()
  }

  get scale() {
    return this.inputs.scale.getValue()
  }

  get material(): Material | undefined {
    return this.data?.usesMaterial ? this.data.material : undefined
  }

  set material(mat: Material | undefined) {
    if (this.data?.usesMaterial) {
      this.data.material = mat
      window.redraw_viewport()
    }
  }

  get locationWorld() {
    const ret = loc_rets.next().zero()

    ret.multVecMatrix(this.outputs.matrix.getValue())

    return ret
  }

  static nodedef() {
    return {
      name  : 'sceneobject',
      inputs: {
        depend  : new DependSocket('depend', SocketFlags.MULTI),
        matrix  : new Matrix4Socket('matrix'),
        color   : new Vec4Socket('color', undefined, new Vector4([0.5, 0.5, 0.5, 1.0])),
        loc     : new Vec3Socket('loc'),
        rot     : new Vec3Socket('rot'),
        rotOrder: new EnumSocket('Euler Order', EulerOrders, undefined, EulerOrders.XYZ),
        scale   : new Vec3Socket('scale', undefined, new Vector3([1, 1, 1])),
      },

      outputs: {
        color : new Vec4Socket('color'),
        matrix: new Matrix4Socket('matrix'),
        depend: new DependSocket('depend'),
      },
    }
  }

  static blockDefine() {
    return {
      typeName   : 'object',
      defaultName: 'Object',
      uiName     : 'Object',
      flag       : 0,
      icon       : -1,
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    // `super`, not `DataBlock`, so `this` reaches Node.defineAPI as the subclass
    // whose sockets the `inputs` / `outputs` lists hold.
    const ostruct = super.defineAPI(api, struct ?? api.mapStruct(this, true))

    ostruct.dynamicStruct('data', 'data', 'data')
    ostruct.struct('material', 'material', 'Material', api.mapStruct(Material, false))

    ostruct.flags('flag', 'flag', ObjectFlags).on('change', function () {
      window.redraw_viewport(true)
    })

    ostruct
      .enum(
        'drawMode',
        'drawMode',
        deleteTsEnumIntegers(DrawModes),
        'Draw Mode',
        'How the object is drawn in the viewport'
      )
      .on('change', function () {
        window.redraw_viewport(true)
      })

    ostruct
      .flags('drawFlag', 'drawFlag', deleteTsEnumIntegers(DrawFlags), 'Draw Flags', 'Extra viewport draw options')
      .on('change', function () {
        window.redraw_viewport(true)
      })

    return ostruct
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
SceneObject {
  flag     : int;
  drawMode : int;
  drawFlag : int;
  data     : DataRef | DataRef.fromBlock(obj.data);
}
`
  )

  getEditorColor() {
    const flag = this.flag & (ObjectFlags.SELECT | ObjectFlags.HIGHLIGHT | ObjectFlags.ACTIVE)

    return Colors[flag]
  }

  destroy() {
    if (this.data !== undefined) {
      this.data.lib_remUser(this)
    }
  }

  graphDisplayName() {
    return this.name + ':' + this.graph_id + ':' + this.lib_id
  }

  ensureGraphConnection() {
    if (!this.data.inputs.depend) {
      return //data doesn't have a depend socket
    }

    for (const s of this.outputs.depend.edges) {
      if (s.node === this.data) {
        return true
      }
    }

    this.outputs.depend.connect(this.data.inputs.depend)

    return false
  }

  exec() {
    let pmat: Matrix4

    this.ensureGraphConnection()

    if (this.inputs.matrix.edges.length > 0) {
      pmat = this.inputs.matrix.edges[0].getValue()
    } else {
      pmat = this.inputs.matrix.getValue()
    }

    const loc = this.inputs.loc.getValue()
    const rot = this.inputs.rot.getValue()
    const scale = this.inputs.scale.getValue()

    const mat = this.outputs.matrix.getValue()

    mat.makeIdentity()

    if (isNaN(loc.dot(loc))) {
      loc.zero()
    }
    if (isNaN(rot.dot(rot))) {
      rot.zero()
    }
    if (isNaN(scale.dot(scale))) {
      scale[0] = scale[1] = scale[2] = 1.0
    }

    mat.euler_rotate_order(rot[0], rot[1], rot[2], this.inputs.rotOrder.getValue())
    mat.scale(scale[0], scale[1], scale[2])

    const m = mat.$matrix
    m.m41 = loc[0]
    m.m42 = loc[1]
    m.m43 = loc[2]
    m.m44 = 1.0
    //mat.translate(loc[0], loc[1], loc[2]);

    mat.multiply(pmat)

    this.outputs.matrix.setValue(mat)
    this.outputs.depend.setValue(true)

    this.outputs.matrix.graphUpdate()
    this.outputs.depend.graphUpdate()
  }

  loadMatrixToInputs(mat: Matrix4): void {
    const rot = new Vector3()
    const loc = new Vector3()
    const size = new Vector3()

    mat.decompose(loc, rot, size)

    this.inputs.loc.setValue(loc)
    this.inputs.rot.setValue(rot)
    this.inputs.scale.setValue(size)

    this.update()
  }

  copyTo(b: this) {
    super.copyTo(b, false)

    b.drawMode = this.drawMode
    b.drawFlag = this.drawFlag
  }

  copy(addLibUsers = false) {
    //note that DataBlock.prototype.copy
    //will have copied datagraph sockets for us, though not their connections

    const ret = super.copy()

    ret.flag = this.flag
    ret.drawMode = this.drawMode
    ret.drawFlag = this.drawFlag
    ret.data = this.data

    if (addLibUsers) {
      ret.data.lib_addUser(ret)
    }

    return ret
  }

  getBoundingBox() {
    let ret = this.data.getBoundingBox()

    if (!ret) {
      ret = [new Vector3(), new Vector3()]
    } else {
      ret = [ret[0].copy(), ret[1].copy()]
    }

    const matrix = this.outputs.matrix.getValue()

    ret[0].multVecMatrix(matrix)
    ret[1].multVecMatrix(matrix)

    return ret
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)

    // Migrate pre-DrawFlags files: ObjectFlags bit 64 was DRAW_WIREFRAME.
    if (this.flag & 64) {
      this.flag &= ~64
      this.drawFlag |= DrawFlags.WIREFRAME
    }
  }

  dataLink(getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    const ref = this.data as unknown as DataRef | undefined
    const block = getblock_addUser(this.data, this)

    if (block instanceof SceneObjectData) {
      this.data = block as OBDATA
      return
    }

    // Either the reference dangled, or it resolved to a MissingDataBlock
    // standing in for an unloaded addon's type. Either way this object needs
    // something drawable; the stand-in keeps the original id so the next save
    // preserves the reference instead of rewriting it to the stand-in's own.
    // eslint-disable-next-line no-console
    console.log('failed to load scene object data! ref:', ref)

    const stub = new NullObject()

    if (ref !== undefined && typeof ref.lib_id === 'number' && ref.lib_id >= 0) {
      stub.lib_id = ref.lib_id
      stub.lib_type = ref.lib_type
      stub.name = ref.name
    }

    this.data = stub as unknown as OBDATA
  }

  draw(view3d: View3D, gl: WebGL2RenderingContext, uniforms: any, program: ShaderProgram = Shaders.BasicLitMesh): void {
    uniforms.objectMatrix = this.outputs.matrix.getValue()
    uniforms.object_id = this.lib_id

    const frame: FrameContext = {gl, uniforms, program}
    const queue = createDrawQueue(frame)

    if (this.drawFlag & DrawFlags.WIREFRAME) {
      uniforms.polygonOffset = uniforms.polygonOffset || 0.0

      this.data.drawQ(view3d, queue, frame, this)

      frame.program = Shaders.ObjectLineShader

      const off = uniforms.polygonOffset

      uniforms.polygonOffset = 0.3
      uniforms.uColor = [0, 0, 0, 1]

      this.data.drawWireframeQ(view3d, queue, frame, this)

      uniforms.polygonOffset = off
    } else {
      this.data.drawQ(view3d, queue, frame, this)
    }
  }

  drawWireframe(
    view3d: View3D,
    gl: WebGL2RenderingContext,
    uniforms: any,
    program: ShaderProgram = Shaders.ObjectLineShader
  ): void {
    uniforms.objectMatrix = this.outputs.matrix.getValue()
    uniforms.object_id = this.lib_id

    const frame: FrameContext = {gl, uniforms, program}
    const queue = createDrawQueue(frame)
    this.data.drawWireframeQ(view3d, queue, frame, this)
  }

  drawOutline(
    view3d: View3D,
    gl: WebGL2RenderingContext,
    uniforms: any,
    program: ShaderProgram = Shaders.ObjectLineShader
  ): void {
    uniforms.objectMatrix = this.outputs.matrix.getValue()
    uniforms.object_id = this.lib_id

    const frame: FrameContext = {gl, uniforms, program}
    const queue = createDrawQueue(frame)
    this.data.drawOutlineQ(view3d, queue, frame, this)
  }

  drawIds(view3d: View3D, gl: WebGL2RenderingContext, selectMask: number, uniforms: any): void {
    uniforms.objectMatrix = this.outputs.matrix.getValue()
    uniforms.object_id = this.lib_id

    const frame: FrameContext = {gl, uniforms, program: Shaders.MeshIDShader}
    const queue = createDrawQueue(frame)
    this.data.drawIdsQ(view3d, queue, frame, selectMask, this)
  }

  onContextLost(e: Event) {}
}

DataBlock.register(SceneObject)
registerDataAPI(SceneObject)
