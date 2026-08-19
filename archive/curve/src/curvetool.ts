import {Shapes} from '@framework/api'
import {FindNearest} from '@framework/api'
import {ToolMode} from '@framework/api'
import {Icons} from '@framework/api'
import {SelMask} from '@framework/api'
import {MeshToolBase} from '../../mesh_edit/src/meshtool'

import {Vector2, Vector3, Vector4, Quat, Matrix4} from '@framework/api'
import {Shaders} from '@framework/api'

import {Mesh, MeshDrawFlags} from '../../mesh/src/mesh'
import {CurveSpline} from './curve'
import {ContextOverlay, nstructjs} from '@framework/pathux'
import {BlockLoader, BlockLoaderAddUser, DataRef} from '@framework/api'
import type {ViewContext} from '@framework/api'
import type {View3D} from '@framework/api'
import type {Scene} from '@framework/api'
import type {StructReader} from '@framework/api'
import type {SceneObject} from '@framework/api'
import type {CurveToolOverlay} from './curvetool_overlay'

declare global {
  interface Window {
    // hack to avoid circular module ref
    _CurveToolOverlay: typeof CurveToolOverlay
  }
}
export class CurveToolBase extends MeshToolBase {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
curve.CurveToolBase {
  curve    : DataRef | DataRef.fromBlock(obj.curve);
  drawflag : int;
}`
  )

  _isCurveTool: boolean
  sceneObject: any | undefined
  _meshPath: string | undefined
  selectMask: number
  drawflag: number
  curve: CurveSpline | undefined

  constructor(ctx: ViewContext) {
    super(ctx)

    this._isCurveTool = true

    //internal scene object
    this.sceneObject = undefined

    this._meshPath = undefined
    this.selectMask = SelMask.VERTEX | SelMask.HANDLE

    this.drawflag = MeshDrawFlags.SHOW_NORMALS

    this.curve = undefined //is created later
  }

  static toolModeDefine() {
    return {
      ...super.toolModeDefine(),
      name       : 'curve_test',
      uiname     : 'Curve Test',
      icon       : Icons.APPEND_VERTEX,
      flag       : 0,
      description: 'curve tester',
    }
  }

  static getContextOverlayClass() {
    return window._CurveToolOverlay
  }

  static isCurveTool(instance: any): boolean {
    return instance._isCurveTool
  }

  static buildElementSettings(container: any): void {
    const col: any = container.col()
    const path: string = 'scene.tools.' + this.toolModeDefine().name

    col.prop(path + ".curve.verts.active.namedLayers['knot'].speed")
    col.prop(path + ".curve.verts.active.namedLayers['knot'].tilt")
  }

  static buildSettings(container: any): void {}

  static buildHeader(header: any, addHeaderRow: any): void {
    const strip: any = header.strip()

    strip.useIcons()

    let path: string = 'scene.tools.' + this.toolModeDefine().name
    path += '.curve'

    //strip.tool(`mesh.delete_selected`);
    //strip.tool(`mesh.clear_points`);
  }

  getMeshPaths(): string[] {
    if (this._meshPath === undefined) {
      this._getObject()

      if (this.sceneObject !== undefined) {
        const ob: any = this.sceneObject
        //set path to parent SceneObject so resolveMesh knows to
        //set ownerMatrix and ownerId
        const path: string = `objects[${ob.lib_id}]`
        this._meshPath = path
      } else {
        return []
      }
      //let path = "scene.tools." + this.constructor.toolModeDefine().name;
      //path += ".curve";
    }

    return [this._meshPath]
  }

  static defineAPI(api: any): any {
    const tstruct: any = super.defineAPI(api)

    const mstruct: any = api.mapStruct(CurveSpline, false)

    tstruct.struct('curve', 'curve', 'Curve', mstruct)

    const onchange: () => void = () => {
      window.redraw_viewport()
    }

    return tstruct
  }

  on_mousedown(e: any, x: number, y: number, was_touch: boolean) {
    return super.on_mousedown(e, x, y, was_touch)
  }

  onActive(): void {
    super.onActive()
  }

  onInactive(): void {
    super.onInactive()
  }

  _getObject(): void {
    if (this.sceneObject === undefined) {
      const key: string = 'toolmode_' + this.constructor.toolModeDefine().name

      const data: CurveSpline | typeof CurveSpline = this.curve !== undefined ? this.curve : CurveSpline

      this.sceneObject = this.ctx.scene.getInternalObject(this.ctx, key, data)
      this.ctx.scene!.objects.setSelect(this.sceneObject, true)

      this.curve = this.sceneObject.data! as CurveSpline
      this.curve.owningToolMode = this.constructor.toolModeDefine().name
    }
  }

  update(): this {
    this._getObject()
    super.update()
    return this
  }

  findnearest3d(view3d: View3D, x: number, y: number, selmask: number) {
    /*
    make sure findnearest api gets the right mesh
    */
    //let ctx = this.buildFakeContext(this.ctx);
    return FindNearest(this.ctx!, selmask, new Vector2([x, y]), view3d)
  }

  on_mousemove(e: PointerEvent, x: number, y: number, was_touch: boolean) {
    return super.on_mousemove(e, x, y, was_touch)
  }

  drawSphere(gl: WebGL2RenderingContext, view3d: View3D, p: Vector3, scale: number = 0.01): void {
    const cam = this.ctx.view3d.activeCamera
    const mat = new Matrix4()

    const co: Vector4 = new Vector4().load3(p)
    mat.translate(co[0], co[1], co[2])

    co[3] = 1.0
    co.multVecMatrix(cam.rendermat)

    scale = Math.abs(co[3] * scale)
    mat.scale(scale, scale, scale)

    Shapes.SPHERE.draw(
      gl,
      {
        projectionMatrix: cam.rendermat,
        objectMatrix    : mat,
        color           : [1, 0.4, 0.2, 1.0],
      },
      Shaders.WidgetMeshShader
    )
  }

  draw(view3d: View3D, gl: WebGL2RenderingContext): void {
    this._getObject()

    if (this.curve !== undefined) {
      if (this.curve.drawflag !== this.drawflag) {
        this.curve.drawflag = this.drawflag
        this.curve.regenRender()
      }

      super.draw(view3d, gl)
    }
  }

  dataLink(scene: Scene, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser): void {
    super.dataLink(scene, getblock, getblock_addUser)
    this.curve = getblock<CurveSpline>(this.curve as unknown as DataRef)
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)
    if (this.curve !== undefined) {
      this.curve.owningToolMode = this.constructor.toolModeDefine().name
    }
  }
}
