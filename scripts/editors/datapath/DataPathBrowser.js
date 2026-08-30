import {Editor, HotKey, VelPan} from '../editor_base.ts'
import {Icons} from '../icon_enum.js'
import {getAppState} from '../../core/app_instance.js'
import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../../util/vectormath.js'
import * as util from '../../util/util.js'
import {
  nstructjs,
  color2css,
  css2color,
  DataTypes,
  math,
  KeyMap,
  UIBase,
  eventWasTouch,
  haveModal,
  saveUIData,
  loadUIData,
  PackFlags,
} from '../../path.ux/scripts/pathux.js'

export class DataPathBrowser extends Editor {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
editors.DataPathBrowser {
}
`
  )

  constructor() {
    super()

    this.needsRebuild = true
  }

  init() {
    super.init()
    this.setCSS()
  }

  rebuild() {
    if (!this.ctx) {
      return
    }

    if (!this.isConnected || this.parentWidget === undefined) {
      return
    }

    this.needsRebuild = false
    this.container.clear()
    this.makeHeader(this.container, false)

    let dstruct = this.ctx.api.rootContextStruct

    function makeDataListPanel(dpath, path2, con) {
      let ctx = getAppState().ctx

      let panel = con.panel(dpath.apiname)
      panel.closed = true

      function load() {
        try {
          let ctx = getAppState().ctx
          let api = ctx.api

          let list = dpath.data
          let ldata = api.getValue(ctx, path2)

          let iter = list.getIter(api, ldata)

          let max = 35

          for (let item of iter) {
            if (max-- === 0) {
              break
            }

            let key = list.getKey(api, ldata, item)
            let pathkey = key

            if (typeof key === 'string' && key !== parseInt(key)) {
              pathkey = `'${key}'`
            }

            let path3 = `${path2}[${pathkey}]`

            let panel2 = panel.panel(key)
            panel2.closed = true

            try {
              let st2 = list.getStruct(api, ldata, key)

              rec(st2, panel2, path3)
            } catch (error2) {
              util.print_stack(error2)
            }
          }
        } catch (error) {
          util.print_stack(error)
          console.log('error iterating over list at ' + path2)
        }
      }

      panel.onchange = function (isClosed) {
        if (!isClosed) {
          load()
        } else {
          panel.clear()
        }
      }
    }

    var rec = (st, con, path) => {
      let makeLoadPanel = (st2, path2, dpath) => {
        return function (isClosed) {
          if (!isClosed) {
            this.label(st2.name)

            try {
              rec(st2, this, path2)
              this.flushUpdate()
            } catch (error) {
              util.print_stack(error)
            }
          } else {
            this.clear()
          }
        }
      }

      let ctx = con.ctx

      for (let dpath of st.members) {
        let path2 = path

        if (path2.length !== 0) {
          path2 += '.'
        }

        if (dpath.type === DataTypes.ARRAY) {
          path2 += dpath.apiname

          makeDataListPanel(dpath, path2, con)
        } else if (dpath.type === DataTypes.STRUCT) {
          let panel = con.panel(ToolProperty.makeUIName(dpath.apiname))

          panel.panelFrame.overrideDefault('padding-bottom', 0.0)
          panel.panelFrame.overrideDefault('padding-top', 0.0)
          panel.panelFrame.overrideDefault('padding-left', 5.0)
          panel.panelFrame.overrideDefault('margin-bottom-closed', 0.0)
          panel.panelFrame.overrideDefault('margin-top-closed', 0.0)

          panel.onchange = makeLoadPanel(dpath.data, path2 + dpath.apiname, dpath)
          panel.closed = true
        } else if (dpath.type === DataTypes.PROP) {
          path2 += dpath.apiname

          //console.log("PATH", path, path2);
          con.prop(path2, PackFlags.FORCE_PROP_LABELS | PackFlags.PUT_FLAG_CHECKS_IN_COLUMNS)
        } else if (dpath.type === DataTypes.DYNAMIC_STRUCT) {
          let panel = con.panel(ToolProperty.makeUIName(dpath.apiname))

          panel.panelFrame.overrideDefault('padding-bottom', 0.0)
          panel.panelFrame.overrideDefault('padding-top', 0.0)
          panel.panelFrame.overrideDefault('padding-left', 5.0)
          panel.panelFrame.overrideDefault('margin-bottom-closed', 0.0)
          panel.panelFrame.overrideDefault('margin-top-closed', 0.0)

          let rdef

          try {
            rdef = ctx.api.resolvePath(ctx, path2 + dpath.apiname)
          } catch (error) {
            console.error(error.stack)
            console.error(error.message)

            panel.label('error')
          }

          if (rdef?.dstruct) {
            panel.onchange = makeLoadPanel(rdef.dstruct, path2 + dpath.apiname, dpath)
          }

          panel.closed = true
        }
      }
    }

    let panel = this.container.panel('Root Context')
    panel.closed = false

    rec(dstruct, panel, '')
  }

  update() {
    super.update()

    if (this.needsRebuild) {
      this.doOnce(this.rebuild)
    }
  }

  defineKeyMap() {
    this.keymap = new KeyMap([])
  }

  setCSS() {
    super.setCSS()

    this.background = this.getDefault('DefaultPanelBG')
    this.container.background = this.background

    this.style['overflow'] = 'scroll'
    //this.container.style["overflow"] = "scroll";
  }

  static defineAPI(api) {
    let st = super.defineAPI(api)

    return st
  }

  static define() {
    return {
      tagname : 'data-path-browser-editor-x',
      areaname: 'dataPathBrowser',
      uiname  : 'Data Path Browser',
    }
  }

  loadSTRUCT(reader) {
    reader(this)
    super.loadSTRUCT(reader)
  }
}
Editor.register(DataPathBrowser)
