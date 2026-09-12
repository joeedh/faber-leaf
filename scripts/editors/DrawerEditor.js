/** Dead code! */
import {Area, AreaFlags, ScreenArea} from '../path.ux/scripts/screen/ScreenArea.js'
import {Editor} from './editor_base.ts'
import {Vector2} from '../path.ux/scripts/util/vectormath.js'
import * as util from '../util/util.js'
import {UIBase} from '../path.ux/scripts/core/ui_base.js'
import * as nstructjs from '../path.ux/scripts/util/struct.js'

export class DrawerEditor extends Editor {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
editors.DrawerEditor {
  openWidth  : float;
  activePane : string | obj.panes.active ? obj.panes.active.id : String() ;
;}
`
  )

  constructor() {
    super()

    this.floating = true

    this.panes = []
    this.panes.active = undefined

    this.openWidth = 445
    this.minWidth = 325

    this.closedWidth = 5
    this._closed = true

    this.minSize[0] = this.maxSize[0] = this.closedWidth
  }

  pane(name, id = name) {
    let con = document.createElement('colframe-x')

    con.ctx = this.ctx
    con.checkInit()
    con.style['width'] = '100%'

    let pane = {
      contents: con,
      name    : name,
      id      : id,
    }

    this.panes.push(pane)
    return pane.contents
  }

  togglePane(id) {
    if (this._closed) {
      this.showPane(id)
    } else {
      if (this.panes.active === undefined || this.panes.active.id !== id) {
        this.showPane(id)
      } else {
        this.close()
      }
    }
  }

  showPane(id, autoOpen = true) {
    let p

    for (let p2 of this.panes) {
      if (p2.id === id) {
        p = p2
        break
      }
    }

    if (!p) {
      console.warn('Unknown pane ' + p)
      return
    }

    if (p === this.panes.active) {
      if (autoOpen) {
        this.open()
      }

      return
    }

    if (autoOpen && this._closed) {
      this.panes.active = p
      this.open()
    } else if (!this._closed) {
      if (this.panes.active) {
        this.contents.clear(false)
      }

      this.panes.active = p
      this.contents.add(p.contents)
    } else {
      this.panes.active = p
    }
  }

  clear() {
    this.contents.clear()
    this.panes = []
  }

  init() {
    super.init()

    let con = this.container
    con.clear()

    let row = con.row()
    //row.label("Properties");

    this.contents = con.row()
    this.contents.style['width'] = '100%'
    con.style['width'] = '100%'
  }

  open() {
    if (!this._closed) {
      return
    }

    this.minSize[0] = this.minWidth
    this.maxSize[0] = undefined

    this.size[0] = this.openWidth
    this.size[1] = this.ctx.screen.size[1] - this.pos[1]

    this.pos[0] = this.ctx.screen.size[0] - Math.max(this.openWidth, this.minWidth)
    this.pos[1] = 0

    this._closed = false

    if (this.panes.active) {
      this.contents.add(this.panes.active.contents)
    }

    if (this.owning_sarea) {
      this.owning_sarea.loadFromPosSize()
      this.owning_sarea.bringToFront()
      this.owning_sarea.update()
    }

    this.ctx.screen._internalRegenAll()
    this.ctx.screen.completeUpdate()

    /*
    this.update();
    this.ctx.screen.regenBorders();
    this.ctx.screen.solveAreaConstraints();
    //*/
  }

  close() {
    if (this._closed) {
      return
    }

    this.openWidth = this.size[0]

    this.minSize[0] = this.maxSize[0] = this.closedWidth
    this._closed = true

    this.size[0] = this.closedWidth
    this.owning_sarea.loadFromPosSize()

    this.contents.clear(false)

    if (this.parentWidget && this.ctx) this.parentWidget.update()
  }

  update() {
    super.update()

    if (!this.ctx || !this.ctx.screen) return

    let screen = this.ctx.screen

    let pos = new Vector2()
    let size = new Vector2(this.size)

    pos[0] = screen.size[0] - this.size[0]

    let menubar = this.ctx.menubar
    if (menubar !== undefined) {
      pos[1] = menubar.pos[1] + menubar.size[1]
      size[1] = Math.min(size[1], this.ctx.screen.size[1] - pos[1])
    } else {
      pos[1] = 0
    }

    if (!this._closed) {
      let rect = this.contents.getClientRects()[0]
      if (rect) {
        size[1] = rect.height
      } else {
        size[1] = this.ctx.screen.size[1] - pos[1]
      }
    }

    if (pos.vectorDistance(this.pos) > 1 || size.vectorDistance(this.size) > 1) {
      //console.log("repositioning drawer", this.pos, pos, this.size, size);

      this.size[0] = size[0]
      this.size[1] = size[1]

      this.pos[0] = pos[0]
      this.pos[1] = pos[1]

      this.owning_sarea.loadFromPosSize()
      screen.regenBorders()
    }
  }

  loadSTRUCT(reader) {
    reader(this)
    super.loadSTRUCT(reader)

    if (this.activePane && this.activePane.length > 0) {
      this.doOnce(() => {
        this.showPane(this.activePane)
        delete this.activePane
      })
    }
  }

  setCSS() {
    super.setCSS()
  }

  static define() {
    return {
      flag: AreaFlags.INDEPENDENT | AreaFlags.FLOATING,
    }
  }
}
