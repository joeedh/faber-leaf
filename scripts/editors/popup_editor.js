import {Editor} from './editor_base.ts'
import {UIBase, theme, PackFlags} from '../path.ux/scripts/core/ui_base.js'
import {keymap} from '../path.ux/scripts/util/events.js'

export const PopupTabModes = {
  BINARY: 1,

  /**
   Trinary mode.  Calls a callback on first click,
   opens popup on second click.
   */
  TRINARY: 2,
}

export class PopupButton {
  constructor(owner, contents, id, mode) {
    this.cb1 = undefined
    this.cb2 = undefined
    this.id = id
    this.contents = contents
    this.mode = mode
    this.owner = owner
  }
}

export class PopupEditor extends Editor {
  constructor() {
    super()

    this.inherit_packflag = 0
    this.toolbar = undefined
    this.tabs = []
    this.tab_idmap = {}
    this.tabs.active = undefined
    this.tab_idgen = 0

    this._open = false

    this.openSize = 350
    this.contents = undefined
    this.lastContents = undefined
  }

  clear() {
    this.tabs = []
    this.tabs.active = undefined
    this.toolbar.clear()

    if (this.contents !== undefined) {
      this.contents.remove()
      this.contents = undefined
      this._open = false
    }

    this.setCSS()
    this.ctx.screen.regenBorders()

    return this
  }

  _colorTabs() {
    for (let tab of this.tabs) {
      if (tab === this.tabs.active) {
        let color = tab.button.getClassDefault('Highlight')

        tab.button.overrideDefault('BoxBG', color)
        tab.button.update()
      } else {
        let color = tab.button.getClassDefault('BoxBG')

        tab.button.overrideDefault('BoxBG', color)
        tab.button.update()
      }
    }
  }

  toggleTab(tab) {
    console.log('toggle tab', tab.name)

    if (tab.mode === PopupTabModes.TRINARY) {
      if (tab !== this.tabs.active) {
        this.tabs.active = tab
        this._colorTabs()
        if (tab.cb1) {
          tab.cb1()
        }

        return
      } else {
        if (this._open) {
          this.close()
        } else {
          this.open()
          if (tab.cb2) {
            tab.cb2()
          }
        }

        return
      }
    }

    this.lastContents = tab.contents

    if (this._open) {
      this.openSize = this.size[0]
    }

    if (this.contents !== undefined) {
      this.close()

      if (this.tabs.active === tab) {
        return
      }
    }

    this.tabs.active = tab

    console.log('T', tab.contents.children.length, this._open)
    let ok = tab.contents.children.length > 0

    if (!ok && this._open) {
      this.close()
    } else if (ok) {
      this.open()
    }

    this._colorTabs()
  }

  open() {
    this._open = true
    let tab = this.tabs.active

    if (tab === undefined) {
      return
    }

    this.contents = tab.contents
    this.container.add(this.contents)

    //this.shadow.appendChild(this.contents);
    if (this.owning_sarea !== undefined) {
      this.size[0] = this.openSize
      console.log('openSize', this.openSize)

      this.owning_sarea.loadFromPosSize()
      this.owning_sarea.setCSS()

      this.ctx.screen._internalRegenAll()
      this.ctx.screen.setCSS()
    }

    this.setCSS()
    this.update()
  }

  close() {
    if (!this._open) {
      if (this.contents !== undefined) {
        this.contents.remove(false)
        this.contents = undefined
      }

      this.setCSS()
      this.ctx.screen._internalRegenAll()
      return
    }

    this._open = false

    this.contents.remove()
    this.contents = undefined

    this.setCSS()
    this.update()
    this.ctx.screen._internalRegenAll()
  }

  shrinkToFit() {
    if (this.owning_sarea === undefined) {
      return
    }

    let rect = this.getClientRects()[0]
    if (rect !== undefined) {
      let w = ~~(rect.width + 0.5)
      let h = ~~(rect.height + 0.5)

      if (w !== this.owning_sarea.size[0] || h !== this.owning_sarea.size[1]) {
        this.owning_sarea.size[0] = w
        this.owning_sarea.size[1] = h

        this.ctx.screen.regenBorders()
        this.setCSS()
        this.owning_sarea.setCSS()
      }
    }
  }

  updateHeight() {
    let rect = this.getClientRects()[0]
    if (rect !== undefined) {
      let w = ~~(rect.width + 0.5)
      let h = ~~(rect.height + 0.5)

      if (h !== this.size[1]) {
        console.log('updating .size[1]')
        this.owning_sarea.size[1] = h

        this.owning_sarea.loadFromPosSize()
        //this.ctx.screen.regenBorders();
        this.setCSS()
        this.owning_sarea.setCSS()
      }
    }
  }
  update() {
    super.update()

    if (!this._open) {
      this.shrinkToFit()
    } else {
      this.updateHeight()
    }
  }

  setCSS() {
    super.setCSS()

    if (this.contents === undefined) {
      this.style['width'] = 'min-content'
      this.container.style['width'] = 'min-content'
    } else {
      this.container.style['width'] = 'auto'
    }

    this.style['height'] = 'min-content'
  }

  iconbutton(icon, description, cb) {
    let ret = this.toolbar.iconbutton(icon, description, cb)
    ret.overrideClass('PopupEditorIcon')

    return ret
  }

  button(name, description, cb) {
    let ret = this.toolbar.button(icon, name, cb)
    ret.description = description
    ret.overrideClass('PopupEditorIcon')

    return ret
  }

  tritab(name, icon = -1, description = name, cb = undefined) {
    for (let tab of this.tabs) {
      if (tab.name === name) {
        tab.contents.clear()
        return tab.contents
      }
    }

    let tab = this.tab(name, icon, description)._tab

    tab.name = name
    tab.contents.name = name

    tab.mode = PopupTabModes.TRINARY
    tab.cb1 = cb

    return tab.contents
  }

  tab(name, icon = -1, description = name) {
    for (let tab of this.tabs) {
      if (tab.name === name) {
        tab.contents.clear()
        return tab.contents
      }
    }

    let container = document.createElement('container-x')

    container.ctx = this.ctx
    container.checkInit()

    container.background = this.getDefault('DefaultPanelBG')
    container.parentWidget = this
    container.useDataPathUndo = this.useDataPathUndo

    let packflag = this.packflag | this.inherit_packflag

    container.packflag |= packflag
    container.inherit_packflag |= packflag

    container.style['align-items'] = 'start'
    container.style['height'] = 'min-content'
    container.style['width'] = '100%'

    container._tab_id = this.tab_idgen++
    container.name = name

    let mode = PopupTabModes.BINARY
    let tab = new PopupButton(this, container, container._tab_id, mode)

    tab.packflag |= packflag
    tab.inherit_packflag = packflag

    tab.name = name
    this.tabs.push(tab)
    this.tab_idmap[container._tab_id] = tab

    let id = container._tab_id

    let cb = () => {
      this.toggleTab(this.tab_idmap[id])
    }

    if (icon >= 0) {
      tab.button = this.toolbar.iconbutton(icon, description, cb)
    } else {
      tab.button = this.toolbar.button(name, cb)
      tab.button.title = description
    }

    tab.button.overrideClass('PopupEditorIcon')
    container._tab = tab

    return container
  }

  on_keydown(e) {
    super.on_keydown(e)
    console.log('key down!')

    switch (e.keyCode) {
      case keymap['Escape']:
        if (this._open) {
          this.toggleTab(this.tabs.active)
        }
        break
    }
  }

  makeHeader() {
    return
  }

  init() {
    super.init()

    this.container.remove()

    let container = (this.container = document.createElement('rowframe-x'))
    container.ctx = this.ctx
    container.checkInit()
    container.parentWidget = this
    this.shadow.appendChild(container)

    let toolbar = (this.toolbar = container.col())

    container.style['align-items'] = 'start'
    toolbar.style['margin-left'] = '25px'
    toolbar.style['margin-right'] = '5px'
    toolbar.style['padding'] = '15px'

    //toolbar.overrideDefault("BoxBG", "rgba(0, 0, 0, 0.25)");
    //toolbar.overrideDefault("BoxMargin", 24);

    container.style['width'] = 'auto'
    container.style['height'] = 'min-content'
    toolbar.style['width'] = 'min-content'
    toolbar.style['height'] = 'min-content'
  }
}
