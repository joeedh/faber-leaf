import {FindNearest} from '../findnearest.js'
import {ObjectFlags, SceneObject} from '../../../sceneobject/sceneobject.js'
import {ToolMode} from '../view3d_toolmode.js'
import {SelMask, SelOneToolModes} from '../../../core/select_types.js'
import type {SceneObjectData} from '../../../sceneobject/sceneobject_base.js'
import {Shaders} from '../../../shaders/shaders.js'
import {Vector2} from '../../../util/vectormath.js'
import {View3DFlags} from '../view3d_base.js'
import {KeyMap, HotKey} from '../../editor_base'
import {eventWasMouseDown, nstructjs} from '../../../path.ux/scripts/pathux.js'
import {Icons} from '../../icon_enum.js'
import {RotateWidget, ScaleWidget, TranslateWidget} from '../widgets/widget_tools.js'
import type {IUniformsBlock, ShaderProgram} from '../../../webgl/webgl.js'
import type {View3D} from '../view3d.js'
import type {ViewContext} from '../../../core/context.js'

const _shift_temp: number[] = [0, 0]

export class ObjectEditor extends ToolMode {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
view3d.ObjectEditor {
}`
  )

  start_mpos: Vector2
  transformWidget: number
  _transformProp: any
  test: string
  declare view3d: View3D
  declare keymap: KeyMap

  constructor(ctx: ViewContext) {
    super(ctx)

    this.start_mpos = new Vector2()

    this.transformWidget = 0
    this._transformProp = this.constructor.getTransformProp()

    this.test = 'yay'

    this.defineKeyMap()
  }

  static defineAPI(api: any): any {
    const tstruct = super.defineAPI(api)

    return tstruct
  }

  static toolModeDefine() {
    return {
      name        : 'object',
      uiname      : 'Object',
      description : 'Select Scene Objects',
      icon        : Icons.CURSOR_ARROW,
      flag        : 0,
      selectMode  : SelMask.OBJECT,
      transWidgets: [TranslateWidget, ScaleWidget, RotateWidget],
    }
  }

  defineKeyMap(): KeyMap {
    this.keymap = new KeyMap([
      new HotKey('G', [], "view3d.translate(selmask='OBJECT')"),
      new HotKey('R', [], "view3d.rotate(selmask='OBJECT')"),
      new HotKey('A', [], "object.toggle_select_all(mode='AUTO')"),
      new HotKey('A', ['alt'], "object.toggle_select_all(mode='SUB')"),
      new HotKey('X', [], 'object.delete_selected()'),
      new HotKey('Delete', [], 'object.delete_selected()'),
    ])

    return this.keymap
  }

  clearHighlight(ctx: any): void {
    ctx.scene.objects.setHighlight(undefined)
  }

  static buildSettings(container: any): void {
    container.useIcons()
    const strip = container.strip()

    strip.label('Move Tool')
    strip.prop('scene.tool.transformWidget[NONE]')
    strip.prop('scene.tool.transformWidget[translate]')
    strip.prop('scene.tool.transformWidget[scale]')
    strip.prop('scene.tool.transformWidget[rotate]')
  }

  static buildHeader(header: any, addHeaderRow: any): void {
    super.buildHeader(header, addHeaderRow)

    const row: any = header //addHeaderRow();
    let strip: any

    strip = row.strip()
    strip.prop('scene.tool.transformWidget[NONE]')
    strip.prop('scene.tool.transformWidget[translate]')
    strip.prop('scene.tool.transformWidget[scale]')
    strip.prop('scene.tool.transformWidget[rotate]')
  }

  on_mousedown(e: PointerEvent, x: number, y: number, was_touch?: boolean): boolean | void {
    const ctx = this.ctx

    this.start_mpos[0] = x
    this.start_mpos[1] = y

    console.log(this.hasWidgetHighlight())

    if (this.hasWidgetHighlight()) {
      return false
    }

    if (e.button !== 0) {
      return false
    }

    this._updateHighlight(e, x, y, was_touch)

    if (e.ctrlKey || e.altKey || e.metaKey) {
      return
    }

    const ret = this.findnearest(ctx, x, y)

    if (ret === undefined || ret.object === undefined) {
      return
    }

    const ob = ret.object
    let mode = SelOneToolModes.UNIQUE

    if (e.shiftKey) {
      mode = ob.flag & ObjectFlags.SELECT ? SelOneToolModes.SUB : SelOneToolModes.ADD
    }

    const cmd = `object.selectone(objectId=${ob.lib_id} setActive=true mode=${mode})`
    this.ctx.api.execTool(this.ctx, cmd)

    return true
  }

  on_mouseup(e: any, x: number, y: number, was_touch: boolean): any {
    if (e.button == 0) {
      this.start_mpos[0] = x
      this.start_mpos[1] = y
    }

    return super.on_mouseup(e, x, y, was_touch)
  }

  on_mousemove(e: PointerEvent, x: number, y: number, was_touch?: boolean): boolean | void {
    if (this.hasWidgetHighlight()) {
      return false
    }

    const mdown = eventWasMouseDown(e)

    if (!mdown && super.on_mousemove(e, x, y, was_touch)) {
      return true
    }

    //(ctx, selectMask, p, view3d, mode=CastModes.FRAMEBUFFER) {
    //let mpos = new Vector2([x, y]);

    /*
    let's rely on transform widget for click-drag tweaking.

    if (mdown && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      let mpos = new Vector2([x, y]);
      let dis = this.start_mpos.vectorDistance(mpos);
      console.log(mpos, this.start_mpos);

      if (dis > 35) {
        let tool = new TranslateOp(this.start_mpos);
        tool.inputs.selmask.setValue(ctx.selectMask);

        console.log("selectMask", ctx.selectMask);

        ctx.toolstack.execTool(ctx, tool);
        return true;
      }
    }//*/

    this._updateHighlight(e, x, y, was_touch)
  }

  _updateHighlight(e: PointerEvent | KeyboardEvent, x: number, y: number, was_touch?: boolean): void {
    const ctx = this.ctx

    const ret = this.findnearest(ctx, x, y)
    const scene = ctx.scene

    if (ret !== undefined) {
      const ob = ret.object

      if (ob !== scene.objects.highlight) {
        scene.objects.setHighlight(ob)
        window.redraw_viewport()
      }
    } else {
      scene.objects.setHighlight(undefined)
      window.redraw_viewport()
    }
  }

  on_drawstart(view3d: View3D): void {
    super.on_drawstart(view3d)
  }

  /*
   * called for all objects;  returns true
   * if an object is valid for this editor (and was drawn)*/
  drawObject(
    gl: WebGL2RenderingContext,
    uniforms: IUniformsBlock,
    program: ShaderProgram,
    object: SceneObject,
    data: SceneObjectData
  ): boolean {
    if (this.view3d.flag & (View3DFlags.SHOW_RENDER | View3DFlags.ONLY_RENDER)) {
      return false
    }

    uniforms.objectMatrix = object.outputs.matrix.getValue()
    uniforms.object_id = object.lib_id
    uniforms.polygonOffset = -5.5
    uniforms.shift = _shift_temp
    uniforms.uColor = object.getEditorColor()

    program = Shaders.ObjectLineShader

    let draw_outline: number | boolean = object.flag & ObjectFlags.SELECT
    draw_outline = draw_outline || object === this.ctx.scene.objects.highlight

    if (draw_outline) {
      const mask = gl.getParameter(gl.DEPTH_WRITEMASK)

      gl.depthMask(false)

      object.drawOutline(this.view3d, gl, uniforms, program)

      //uniforms.shift = undefined;
      gl.depthMask(mask)
    }

    program = Shaders.BasicLitMesh
    object.draw(this.view3d, gl, uniforms, program)

    return true
  }

  on_drawend(view3d: any): void {
    super.on_drawend(view3d)
  }

  findnearest(ctx: any, x: number, y: number, selmask: number = SelMask.OBJECT, limit: number = 25): any | undefined {
    //let ret = findnearest()
    const ret = FindNearest(ctx, selmask, new Vector2([x, y]), this.view3d, limit)

    if (ret !== undefined && ret.length > 0) {
      return ret[0]
    }
  }
}
ToolMode.register(ObjectEditor)
