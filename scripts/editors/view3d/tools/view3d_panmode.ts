import {WidgetFlags} from '../widgets/widgets'
import {ToolModes, ToolMode} from '../view3d_toolmode'
import {Icons} from '../../icon_enum.js'
import {SelMask} from '../../../core/select_types.js'
import {nstructjs} from '../../../path.ux/scripts/pathux.js'

export class PanToolMode extends ToolMode {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
view3d.PanToolMode {
}`
  )

  constructor(manager: any) {
    super(manager)

    this.flag |= WidgetFlags.ALL_EVENTS

    this.view3d = manager !== undefined ? manager.view3d : undefined
  }

  static register(cls: any): void {
    ToolModes.push(cls)
    //WidgetTool.register(cls);
  }

  static toolModeDefine() {
    return {
      name        : 'pan',
      uiname      : 'Pan',
      icon        : Icons.PAN,
      flag        : 0,
      description : 'Pan',
      selectMode  : SelMask.OBJECT, //if set, preferred selectmode, see SelModes
      transWidgets: [],
    }
  }

  static buildSettings(container: any): void {}

  static buildHeader(header: any, addHeaderRow: any): void {
    super.buildHeader(header, addHeaderRow)

    //let strip = header.strip();
  }

  destroy(): void {}

  /*
   * called for all objects;  returns true
   * if an object if the toolmode drew the object
   * itself
   */
  drawObject(gl: WebGL2RenderingContext, uniforms: any, program: any, object: any, mesh: any): boolean {
    return false
  }
}

ToolMode.register(PanToolMode)
