import {nstructjs, KeyMap, HotKey} from '@framework/pathux'
import {ToolMode} from '@framework/api'
import {Icons} from '@framework/api'
import {SelMask} from '@framework/api'

import type {ViewContext} from '@framework/api'
import type {StructReader} from '@framework/api'

export class TetMeshTool extends ToolMode {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
tetmesh.TetMeshTool {
}`
  )

  constructor(ctx: ViewContext) {
    super(ctx)
  }

  drawsObjectIdsExclusively(ob: any): boolean {
    return false
  }

  defineKeyMap(): any {
    this.keymap = new KeyMap([new HotKey('W', [], 'tet.vertex_smooth()'), new HotKey('D', [], 'tet.test()')])
  }

  static buildEditMenu(): string[] {
    return ['tet.from_mesh()', 'tet.vertex_smooth()', 'tet.hexes_to_tets()', 'tet.fix_normals()']
  }

  static buildElementSettings(container: any): void {}

  static buildSettings(container: any): void {
    let panel, strip

    panel = container.panel('Conversion')
    panel.useIcons(false)
    panel.prop('toolDefaults.tet.from_mesh.maxDepth')
    panel.prop('toolDefaults.tet.from_mesh.leafLimit')
    panel.tool('tet.from_mesh()')
    panel.tool('tet.to_mesh()')

    panel = container.panel('Tools')
    panel.tool('tet.vertex_smooth()')
    panel.tool('tet.hexes_to_tets()')
    panel.tool('tet.fix_normals()')

    panel.toolPanel('tet.solidify_wireframe')
  }

  static toolModeDefine() {
    return {
      name        : 'tetmesh',
      uiname      : 'Tetrahedron',
      icon        : Icons.TETRAHEDRON,
      flag        : 0,
      description : 'Tetrahedral Mesh Tool',
      selectMode  : SelMask.TETMESH, //if set, preferred selectmode, see SelModes
      transWidgets: [], //list of widget classes tied to this.transformWidget
    }
  }

  static nodedef() {
    return {
      name   : 'tetmesh',
      uiname : 'tetmesh',
      inputs : {...super.nodedef().inputs},
      outputs: {...super.nodedef().outputs},
    }
  }

  loadSTRUCT(reader: StructReader<this>): void {
    super.loadSTRUCT(reader)
  }
}
