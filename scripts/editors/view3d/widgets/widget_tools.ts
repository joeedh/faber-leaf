import {Vector2, Vector3, Vector4, Quat, Matrix4} from '../../../util/vectormath.js'
import {SimpleMesh, LayerTypes} from '../../../webgl/simplemesh.js'
import {
  IntProperty,
  BoolProperty,
  FloatProperty,
  EnumProperty,
  FlagProperty,
  ToolProperty,
  Vec3Property,
  ToolOp,
  ToolFlags,
  UndoFlags,
  ToolMacro,
  PropFlags,
  PropTypes,
  PropSubTypes,
} from '../../../path.ux/scripts/pathux.js'
import {Shaders} from '../../../shaders/shaders.js'
import {dist_to_line_2d} from '../../../path.ux/scripts/util/math.js'
import {CallbackNode, Node, NodeFlags} from '../../../core/graph.js'
import {DependSocket} from '../../../core/graphsockets.js'
import * as util from '../../../util/util.js'
import {SelMask} from '../../../core/select_types.js'

import {View3DFlags} from '../view3d_base.js'
import {WidgetBase, WidgetSphere, WidgetArrow, WidgetFlags, WidgetManager} from './widgets.js'
import {TranslateOp, ScaleOp, RotateOp, InflateOp} from '../transform/transform_ops.js'
import {calcTransCenter, type TransCenterResult} from '../transform/transform_query.js'
import {Icons} from '../../icon_enum.js'
import {ConstraintSpaces} from '../transform/transform_base.js'
import {InsetTransformOp} from '../transform/transform_inset.js'
import type {ViewContext} from '../../../core/context.js'

/** The part of a BREP mesh `TransformWidget.validate` reads. Erased with the BREP at P13. */
interface BrepSelectedVerts {
  verts: {selected: Iterable<unknown>}
}

// Late-bound by the mesh addon's register hook so this file does not
// statically depend on the mesh addon (which would cycle back through
// mesh_ops_base.ts → mesh.ts). See addons/builtin/mesh/src/addon_register.ts.
import type {ToolOpAny} from '../../../path.ux/scripts/path-controller/controller/controller_abstract.js'
let _InsetHoleOp: {invoke(ctx: unknown, args: object): ToolOpAny} | undefined
export function setInsetHoleOp(op: typeof _InsetHoleOp): void {
  _InsetHoleOp = op
}

const update_temps = util.cachering.fromConstructor(Vector3, 64)
const update_temps4 = util.cachering.fromConstructor(Vector4, 64)
const update_mats = util.cachering.fromConstructor(Matrix4, 64)

export class WidgetSceneCursor extends WidgetBase {
  constructor() {
    super()
  }

  get isDead() {
    return !this.manager.ctx.view3d._showCursor()
  }

  static widgetDefine() {
    return {
      description: 'Cursor Widget',
      uiname     : 'cursor',
      name       : 'cursor',
      selMask    : undefined,
      flag       : WidgetFlags.IGNORE_EVENTS,
      icon       : -1,
    }
  }

  update(): this {
    super.update()
    const view3d = this.manager.ctx.view3d

    if (this.shape === undefined) {
      this.shape = new WidgetSphere()
      this.shape.shapeid = 'CURSOR'
    }

    this.matrix.load(view3d.cursor3D)
    this.matrix.scale(0.15, 0.15, 0.15)
    return this
  }
}

export class NoneWidget extends WidgetBase {
  static widgetDefine() {
    return {
      description: 'Disable Widget',
      uiname     : 'Disable widgets',
      name       : 'none',
      icon       : -1,
      flag       : 0,
    }
  }

  static validate(ctx: ViewContext) {
    return true
  }
}

export class TransformWidget extends WidgetBase {
  static validate(ctx: ViewContext) {
    const selmask = ctx.selectMask

    if (selmask & SelMask.OBJECT) {
      for (const ob of ctx.selectedObjects) {
        return true
      }
    }

    if (selmask & SelMask.GEOM) {
      for (const ob of ctx.selectedMeshObjects) {
        for (const v of (ob.data as unknown as BrepSelectedVerts).verts.selected) {
          return true
        }
      }
    }

    return false
  }

  create(ctx: ViewContext, manager: WidgetManager) {}

  /** space: see ConstraintSpaces */
  getTransMatrix(space: number): Matrix4 {
    if (!this.ctx?.view3d) {
      return new Matrix4()
    }

    const view3d = this.ctx.view3d
    return new Matrix4(view3d.getTransMatrix(space))
  }

  getTransAABB(): [Vector3, Vector3] {
    if (!this.ctx?.view3d) {
      window.redraw_viewport()

      const d = 0.00001
      return [new Vector3([-d, -d, -d]), new Vector3([d, d, d])]
    }

    const ctx = this.ctx
    const view3d = ctx.view3d
    const aabb = ctx.view3d.getTransBounds()

    if (!aabb) {
      const d = 0.00001
      return [new Vector3([-d, -d, -d]), new Vector3([d, d, d])]
    }

    //console.log(new Vector3(aabb[1]).sub(aabb[0]));

    return [new Vector3(aabb[0]), new Vector3(aabb[1])]
  }

  getTransCenter(): TransCenterResult | {center: Vector3} {
    if (!this.ctx?.view3d) {
      window.redraw_viewport()
      return {center: new Vector3()}
    }

    const ret = this.ctx.view3d.getTransCenter()
    const aabb = this.ctx.view3d.getTransBounds()

    if (!aabb) {
      if (ret) {
        ret.center = new Vector3()
        return ret
      } else {
        return {
          center: new Vector3(),
        }
      }
    }

    //use aabb midpoint instead of median center
    ret.center = new Vector3(aabb[0]).interp(aabb[1], 0.5)

    return ret
  }

  update(): this {
    return super.update()
  }
}

export class ThreeAxisWidget extends TransformWidget {
  axes?: WidgetBase[]
  center_widget?: WidgetBase
  plane_axes?: WidgetBase[]

  update(): this {
    super.update()

    const x = this.axes![0]
    const y = this.axes![1]
    const z = this.axes![2]

    const ret = this.getTransCenter()

    this.center_widget!.matrix.makeIdentity()
    const sz = 0.4
    this.center_widget!.matrix.scale(sz, sz, sz)

    const p = new Vector3(ret.center)
    const w = this.ctx!.view3d.project(p)

    const mat = new Matrix4() //XXX get proper matrix space transform
    if ('spaceMatrix' in ret) {
      mat.multiply(ret.spaceMatrix)
    }
    const mat2 = new Matrix4()
    mat2.translate(ret.center[0], ret.center[1], ret.center[2])

    mat.multiply(mat2)
    this.setMatrix(mat)

    const xmat = new Matrix4()
    const ymat = new Matrix4()

    let scale = 1.0
    const toff = 1.0
    const scale2 = 1.0 //scale*1.5;

    xmat.euler_rotate(0.0, Math.PI * 0.5, 0.0)
    xmat.translate(0.0, 0.0, toff)
    xmat.scale(scale, scale, scale2)

    ymat.euler_rotate(Math.PI * 0.5, 0.0, 0.0)
    ymat.translate(0.0, 0.0, toff)
    ymat.scale(scale, scale, scale2)

    const zmat = new Matrix4()
    zmat.translate(0.0, 0.0, toff)
    zmat.scale(scale, scale, scale2)

    x.setMatrix(xmat)
    y.setMatrix(ymat)
    z.setMatrix(zmat)

    if (!this.plane_axes) {
      return this
    }

    const px = this.plane_axes[0]
    const py = this.plane_axes[1]
    const pz = this.plane_axes[2]

    xmat.makeIdentity()
    ymat.makeIdentity()
    zmat.makeIdentity()

    scale *= 0.6
    const fac = 0.6

    xmat.euler_rotate(0.0, Math.PI * 0.5, 0.0)
    xmat.translate(-toff * fac, -toff * fac, 0.0)
    xmat.scale(scale, scale, scale)

    ymat.euler_rotate(Math.PI * 0.5, 0.0, 0.0)
    ymat.translate(toff * fac, toff * fac, 0.0)
    ymat.scale(scale, scale, scale)

    zmat.euler_rotate(0.0, 0.0, 0.0)
    zmat.translate(toff * fac, -toff * fac, 0.0)
    zmat.scale(scale, scale, scale)

    px.setMatrix(xmat)
    py.setMatrix(ymat)
    pz.setMatrix(zmat)

    return this
  }
}

export class TranslateWidget extends ThreeAxisWidget {
  constructor() {
    super()
    this.axes = undefined
  }

  static widgetDefine() {
    return {
      description: 'Move Widget',
      uiname     : 'Move',
      name       : 'translate',
      icon       : Icons.TRANSLATE,
      flag       : 0,
    }
  }

  create(ctx: ViewContext, manager: WidgetManager) {
    console.log('creating widget')

    super.create(ctx, manager)

    const center = (this.center_widget = this.getSphere(undefined, new Vector4([0.5, 0.5, 0.5, 1.0])))

    const px = this.getPlane(undefined, new Vector4([1, 0, 0, 0.5])) //"rgba(255, 0, 0, 0.8)");
    const py = this.getPlane(undefined, 'rgba(0, 255, 0, 0.2)')
    const pz = this.getPlane(undefined, 'rgba(0, 0, 255, 0.2)')
    this.plane_axes = [px, py, pz]

    const x = this.getArrow(undefined, 'red')
    const y = this.getArrow(undefined, 'green')
    const z = this.getArrow(undefined, 'blue')

    this.axes = [x, y, z]

    center.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(-1, localX, localY)
      return true
    }

    x.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(0, localX, localY)
      return true
    }
    y.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(1, localX, localY)
      return true
    }
    z.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(2, localX, localY)
      return true
    }

    px.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(3, localX, localY)
      return true
    }
    py.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(4, localX, localY)
      return true
    }
    pz.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(5, localX, localY)
      return true
    }
  }

  startTool(axis: number, localX: number, localY: number) {
    const tool = TranslateOp.invoke(this.ctx!, {}) //new TranslateOp([localX, localY]);
    const con = new Vector3()
    const selmode = this.ctx!.view3d.ctx.selectMask

    tool.inputs.selmask.setValue(selmode)

    if (axis >= 0) {
      if (axis > 2) {
        axis -= 3
        con[(axis + 1) % 3] = 1.0
        con[(axis + 2) % 3] = 1.0
      } else {
        con[axis] = 1.0
      }

      tool.inputs.constraint.setValue(con)
    }

    this.execTool(this.ctx!, tool)
  }

  update(): this {
    if (this.axes === undefined) {
      this.create(this.ctx!, this.manager)
    }

    return super.update()
  }
}

export class ScaleWidget extends ThreeAxisWidget {
  constructor() {
    super()

    this.axes = undefined
  }

  static widgetDefine() {
    return {
      description: 'Scale Widget',
      uiname     : 'Scale',
      name       : 'scale',
      icon       : Icons.SCALE_WIDGET,
      flag       : 0,
    }
  }

  create(ctx: ViewContext, manager: WidgetManager) {
    console.log('creating widget')
    super.create(ctx, manager)

    const center = (this.center_widget = this.getSphere(undefined, new Vector4([0.5, 0.5, 0.5, 1.0])))

    const x = this.getBlockArrow(undefined, 'red')
    const y = this.getBlockArrow(undefined, 'green')
    const z = this.getBlockArrow(undefined, 'blue')

    //manager.remove(x);
    //manager.remove(y);
    //manager.remove(z);
    //manager.remove(px);
    //manager.remove(py);
    //manager.remove(center);

    this.axes = [x, y, z]

    center.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(-1, localX, localY)
      return true
    }

    x.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(0, localX, localY)
      return true
    }
    y.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(1, localX, localY)
      return true
    }
    z.on_mousedown = (e: PointerEvent, localX: number, localY: number) => {
      this.startTool(2, localX, localY)
      return true
    }

    return this.update()
  }

  startTool(axis: number, localX: number, localY: number) {
    const tool = ScaleOp.invoke(this.ctx!, {}) //new ScaleOp([localX, localY]);
    const con = new Vector3()
    const selmode = this.ctx!.view3d.ctx.selectMask

    tool.inputs.selmask.setValue(selmode)

    if (axis >= 0) {
      con[axis] = 1.0

      tool.inputs.constraint.setValue(con)
    }

    this.execTool(this.ctx!, tool)
  }

  update(): this {
    if (this.axes === undefined) {
      this.create(this.ctx!, this.manager)
    }

    super.update()
    return this
  }
}

export class RotateWidget extends TransformWidget {
  _first: boolean
  axes?: WidgetBase[]

  constructor() {
    super()

    this._first = true
  }

  static widgetDefine() {
    return {
      description: 'Rotate Widget',
      uiname     : 'Rotate',
      name       : 'rotate',
      icon       : Icons.ROTATE,
      flag       : 0,
    }
  }

  static nodedef() {
    return {
      ...super.nodedef(),
      name: 'rotate_widget',
    }
  }

  create(ctx: ViewContext, manager: WidgetManager) {
    super.create(ctx, manager)

    this._first = false

    this.axes = [
      this.getTorus(new Matrix4(), new Vector4([1, 0, 0, 1])),
      this.getTorus(new Matrix4(), new Vector4([0, 1, 0, 1])),
      this.getTorus(new Matrix4(), new Vector4([0, 0, 1, 1])),
      //this.getTorus(new Matrix4(), new Vector4([1, 1, 1, 1])) //view axis
    ]

    const makeonclick = (axis: number) => {
      return (e: PointerEvent) => {
        this._handleClick(e, axis)
      }
    }

    for (let i = 0; i < this.axes.length; i++) {
      this.axes[i].onclick = makeonclick(i)
    }
  }

  _handleClick(e: PointerEvent, axis: number) {
    console.log(axis)
    const op = new RotateOp()
    const con = new Vector3()
    con[axis] = 1.0

    op.inputs.constraint.setValue(con)
    op.inputs.selmask.setValue(this.ctx!.selectMask)

    this.ctx!.api.execTool(this.ctx!, op)
  }

  draw(gl: WebGL2RenderingContext, manager: WidgetManager, matrix?: Matrix4) {
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)

    super.draw(gl, manager, matrix)

    gl.disable(gl.DEPTH_TEST)
  }

  update(): this {
    if (!this.ctx?.view3d) {
      return this
    }

    if (this._first) {
      this.create(this.ctx!, this.manager)
    }
    super.update()
    return this
  }
}

export class InflateWidget extends TransformWidget {
  _first: boolean
  arrow?: WidgetBase

  constructor() {
    super()

    this._first = true
  }

  static widgetDefine() {
    return {
      description: 'Inflate Widget',
      uiname     : 'Inflate',
      name       : 'inflate',
      icon       : Icons.INFLATE,
      flag       : 0,
    }
  }

  static nodedef() {
    return {
      ...super.nodedef(),
      name: 'inflate_widget',
    }
  }

  create(ctx: ViewContext, manager: WidgetManager) {
    this._first = false

    super.create(ctx, manager)

    this.arrow = this.getBlockArrow(new Matrix4(), new Vector4([0.7, 0.7, 0.7, 1]))
    this.arrow.onclick = (e: PointerEvent) => {
      this._handleClick(e)
    }
  }

  _handleClick(e: PointerEvent) {
    const macro = new ToolMacro()
    if (!_InsetHoleOp) {
      throw new Error('InsetHoleOp not registered — mesh addon must register before widget use')
    }
    macro.add(_InsetHoleOp.invoke(this.ctx!, {}))
    macro.add(InsetTransformOp.invoke(this.ctx!, {selmask: this.ctx!.selectMask}))

    this.execTool(this.ctx!, macro)
  }

  draw(gl: WebGL2RenderingContext, manager: WidgetManager, matrix?: Matrix4) {
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)

    super.draw(gl, manager, matrix)

    gl.disable(gl.DEPTH_TEST)
  }

  update(): this {
    if (!this.ctx?.view3d) {
      return this
    }

    if (this._first) {
      this.create(this.ctx!, this.manager)
    }
    super.update()
    return this
  }
}
