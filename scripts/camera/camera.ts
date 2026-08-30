import {SceneObjectData} from '../sceneobject/sceneobject_base.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import {Vector3, Vector4, Matrix4} from '../util/vectormath.js'
import {nstructjs, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import {BlockLoader, BlockLoaderAddUser, DataBlock, DataRef} from '../core/lib_api.js'
import {Camera} from '../webgl/webgl.js'
import {SelMask} from '../core/select_types.js'
import {NodeFlags} from '../core/graph.js'
import type {DependSocket} from '../core/graphsockets.js'
import {SimpleMesh, LayerTypes} from '../webgl/simplemesh.js'
import {CameraTypes} from './camera_types.js'
import type {View3D} from '../editors/view3d/view3d.js'
import type {SceneObject} from '../sceneobject/sceneobject.js'
import type {ToolContext} from '../core/context.js'
import type {DrawQueue, FrameContext} from '../render/queue.js'

/**
 * What a SPLINE_PATH camera needs of the block it follows. The only thing that
 * ever implemented it was the BREP `CurveSpline`, archived in P13, so no block
 * satisfies this today — the field and its `DataRef` stay because old files
 * carry it and must round-trip.
 */
interface CameraPathCurve extends DataBlock<{}, {depend: DependSocket}> {
  length: number
  evaluate(t: number, tan: Vector3, nor: Vector3): Vector3
}

export class CameraData extends SceneObjectData {
  camera: Camera
  finalCamera: Camera
  type: number
  speed: number
  azimuth: number
  _drawkey: string | undefined
  mesh: SimpleMesh | undefined
  _last_hash: number | undefined
  pathFlipped: boolean
  curvespline: CameraPathCurve | DataRef<CameraPathCurve> | undefined

  constructor() {
    super()

    this.camera = new Camera()
    this.curvespline = undefined

    this.camera.pos.zero()
    this.camera.target.load([0, 0, 1])
    this.camera.up.load([0, 1, 0])

    this.finalCamera = new Camera()
    this.type = CameraTypes.STANDALONE
    this.speed = 1.0
    this.height = 1.0
    this.azimuth = 0.0

    this.speed = 1.0
    this._drawkey = undefined
    this.mesh = undefined

    this._last_hash = undefined
    this.pathFlipped = false
  }

  get height(): number {
    return this.camera.pos[0]
  }

  set height(h: number) {
    this.camera.target.sub(this.camera.pos)
    this.camera.pos[0] = h
    this.camera.target.add(this.camera.pos)
  }

  get rotate(): number {
    return Math.atan2(this.camera.up[1], this.camera.up[0])
  }

  set rotate(th: number) {
    this.camera.up[0] = Math.cos(th)
    this.camera.up[1] = Math.sin(th)

    this.update()
  }

  get flipped(): boolean {
    return this.camera.target[2] < 0.0
  }

  set flipped(val: boolean) {
    this.camera.target[2] = val ? -1 : 1

    this.update()
  }

  /**draws IDs.  no need for packing,
   they're drawn into a float framebuffer

   red should be sceneobject id + 1.
   green should be any sub-id (also + 1) provided by
   sceneobjectdata, e.g. vertices in a mesh.
   */
  drawIdsQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, selectMask: number, object: SceneObject) {
    this.drawQ(view3d, queue, frame, object)
  }

  gen(gl: WebGL2RenderingContext) {
    if (this.mesh) {
      this.mesh.destroy(gl)
    }

    const mesh = (this.mesh = new SimpleMesh(LayerTypes.LOC | LayerTypes.ID | LayerTypes.COLOR))

    const th = (this.camera.fovy / 180) * Math.PI
    let id = -1
    const ob = this.getOwningObject()

    if (ob) {
      id = ob.lib_id
    }

    const color = new Vector4([0, 0, 0, 1])

    const d1 = 1
    const d2 = this.camera.aspect
    const z = -Math.tan(Math.PI * 0.5 - th * 0.5)

    function line(v1: Vector3, v2: Vector3) {
      const l = mesh.line(v1, v2)
      l.ids(id, id)
      l.colors(color, color)
      return l
    }

    line(new Vector3([0, 0, 0]), new Vector3([-d1, -d2, z]))
    line(new Vector3([0, 0, 0]), new Vector3([-d1, d2, z]))
    line(new Vector3([0, 0, 0]), new Vector3([d1, d2, z]))
    line(new Vector3([0, 0, 0]), new Vector3([d1, -d2, z]))

    line(new Vector3([-d1, -d2, z]), new Vector3([-d1, d2, z]))
    line(new Vector3([-d1, d2, z]), new Vector3([d1, d2, z]))
    line(new Vector3([d1, d2, z]), new Vector3([d1, -d2, z]))
    line(new Vector3([d1, -d2, z]), new Vector3([-d1, -d2, z]))

    line(new Vector3([0, d2, z]), new Vector3([0, d2 + 1, z]))
  }

  drawQ(view3d: View3D, queue: DrawQueue, frame: FrameContext, object: SceneObject) {
    const hash = this.camera.generateUpdateHash()

    if (hash !== this._last_hash) {
      this._last_hash = hash
      this.update()
    }

    const uniforms = frame.uniforms

    uniforms['objectMatrix'] = new Matrix4(this.finalCamera.icameramat)

    const co = new Vector3()
    co.multVecMatrix(this.finalCamera.icameramat)
    const w = co.multVecMatrix(uniforms['projectionMatrix']) / 75.0

    uniforms['objectMatrix'].scale(w, w, w)

    const key = this.camera.fovy + ':' + this.camera.aspect

    if (!this.mesh || key !== this._drawkey) {
      this._drawkey = key
      this.gen(frame.gl)
    }

    queue.scheduleRawGLPass((gl) => gl.disable(gl.DEPTH_TEST))
    queue.submit({pipeline: frame.program!, mesh: this.mesh!})
    queue.scheduleRawGLPass((gl) => gl.enable(gl.DEPTH_TEST))
  }

  exec(ctx: ToolContext) {
    const ob = this.getOwningObject()
    const scene = ctx.scene

    if (!ob || !scene) return

    const matrix = new Matrix4(ob.outputs.matrix.getValue())

    const amatrix = new Matrix4()
    amatrix.euler_rotate(0, this.azimuth, 0)

    const curve = this.curvespline instanceof DataRef ? undefined : this.curvespline

    if (this.type === CameraTypes.SPLINE_PATH && curve) {
      if (!this.inputs.depend.has(curve)) {
        this.inputs.depend.connect(curve.outputs.depend)
      }

      let time = (scene.time * this.speed) / scene.fps

      time = time % curve.length
      if (this.pathFlipped) {
        time = curve.length - time
      }

      const tan = new Vector3()
      const nor = new Vector3()

      const p = curve.evaluate(time, tan, nor)
      const bin = new Vector3(tan).cross(nor)

      tan.normalize()
      bin.normalize()
      nor.normalize()

      //ignore scene object matrix
      matrix.makeIdentity()
      matrix.translate(p[0], p[1], p[2])

      const matrix2 = new Matrix4()
      const m = matrix2.$matrix

      m.m11 = bin[0]
      m.m12 = bin[1]
      m.m13 = bin[2]
      m.m21 = nor[0]
      m.m22 = nor[1]
      m.m23 = nor[2]
      m.m31 = tan[0]
      m.m32 = tan[1]
      m.m33 = tan[2]

      //matrix2.transpose();

      matrix.multiply(matrix2)

      matrix.multiply(amatrix)
    } else {
      matrix.multiply(amatrix)
    }

    const camera = this.camera
    const finalCamera = this.finalCamera

    finalCamera.load(camera)

    //*
    finalCamera.pos.multVecMatrix(matrix)
    finalCamera.target.multVecMatrix(matrix)
    finalCamera.orbitTarget.multVecMatrix(matrix)
    //*/

    const up = new Vector4([finalCamera.up[0], finalCamera.up[1], finalCamera.up[2], 0.0])
    up.multVecMatrix(matrix)
    up.normalize()
    finalCamera.up.load(up)

    finalCamera.regen_mats()
  }

  static nodedef() {
    return {
      flag   : NodeFlags.SAVE_PROXY,
      name   : 'camera',
      uiname : 'Camera',
      inputs : {...super.nodedef().inputs},
      outputs: {...super.nodedef().outputs},
    }
  }

  static blockDefine() {
    return {
      typeName   : 'camera',
      defaultName: 'Camera',
      uiName     : 'Camera',
      flag       : 0,
      icon       : -1,
    }
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    // CameraData extends SceneObjectData (helper layering ≠ JS inheritance);
    // chain the SceneObjectData base, not DataBlock.
    const mstruct = SceneObjectData.defineAPI(api, struct ?? api.mapStruct(this, true))

    const onchange = function (this: {dataref: CameraData}) {
      const camera = this.dataref

      camera.update()
    }

    // The Camera struct is mapped non-creating; it must already be built (its
    // own defineAPI runs earlier in the getDataAPI order).
    mstruct.struct('camera', 'camera', 'Camera', api.mapStruct(Camera, false))
    mstruct.struct('finalCamera', 'finalCamera', 'finalCamera', api.mapStruct(Camera, false))
    mstruct.float('speed', 'speed', 'Anim Speed').range(0.00001, 100.0)
    mstruct.float('height', 'height', 'Height').range(-100, 100.0).on('change', onchange)

    mstruct.bool('flipped', 'flipped', 'Flipped').on('change', onchange)
    mstruct.bool('pathFlipped', 'pathFlipped', 'Flip Path').on('change', onchange)

    mstruct
      .float('azimuth', 'azimuth', 'Azimuth')
      .on('change', onchange)
      .range(-Math.PI, Math.PI)
      .displayUnit('degree')
      .baseUnit('radian')

    mstruct.float('rotate', 'rotate', 'Rotation').range(-Math.PI, Math.PI).displayUnit('degree').baseUnit('radian')

    return mstruct
  }

  static dataDefine() {
    return {
      name          : '',
      selectMask    : SelMask.CAMERA, //valid selection modes for StandardTools, see SelMask
      selectTypeName: 'CAMERA',
      tools         : undefined,
    }
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
CameraData {
  camera       : Camera;
  curvespline  : DataRef | DataRef.fromBlock(obj.curvespline);
  type         : int;
  speed        : float;
  azimuth      : float;
}
`
  )

  dataLink(getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser) {
    super.dataLink(getblock, getblock_addUser)

    this.curvespline = getblock_addUser<CameraPathCurve>(this.curvespline as unknown as number, this)
  }
}

DataBlock.register(CameraData)
SceneObjectData.register(CameraData)
registerDataAPI(CameraData)
