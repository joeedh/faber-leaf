export function registerToolMode(api) {
  const ToolMode = api.toolmode.ToolMode
  const {util, nstructjs, KeyMap, Icons, SelMask} = api

  class StrandTool extends ToolMode {
    static STRUCT = nstructjs.inlineRegister(
      this,
      `
strand.StrandTool {
}`
    )

    constructor() {
      super()
    }

    drawsObjectIdsExclusively(ob) {
      return false
    }

    defineKeyMap() {
      this.keymap = new KeyMap([])
    }

    static buildEditMenu() {
      return []
    }

    static buildElementSettings(container) {}

    static buildSettings(container) {
      let panel, strip

      panel = container.panel('Tools')
    }

    dataLink(scene, getblock, getblock_addUser) {}

    static buildHeader(header, addHeaderRow) {}

    static toolModeDefine() {
      return {
        name        : 'strandset',
        uiname      : 'Strands',
        icon        : Icons.STRANDS,
        flag        : 0,
        description : 'Hair/Fur Tool',
        selectMode  : SelMask.strandset, //if set, preferred selectmode, see SelModes
        transWidgets: [], //list of widget classes tied to this.transformWidget
      }
    }

    static nodedef() {
      return {
        name   : 'strandset',
        uiname : 'strandset',
        inputs : {},
        outputs: {},
      }
    }

    loadSTRUCT(reader) {
      super.loadSTRUCT(reader)
    }
  }

  api.register(StrandTool)
}
