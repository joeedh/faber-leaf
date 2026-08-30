import {resourceManager} from '../../core/resource.js'
import {getAppState} from '../../core/app_instance.js'
import {ResourcePages} from './resbrowser_types.js'
import {genResBrowserScreen} from '../screengen.js'
import {nstructjs} from '../../path.ux/scripts/pathux.js'

import {Editor} from '../editor_base.ts'
import {KeyMap} from '../../path.ux/scripts/util/simple_events.js'
import {AreaFlags} from '../../path.ux/scripts/screen/ScreenArea.js'
import {UIBase} from '../../path.ux/scripts/core/ui_base.js'

let ResIconStyle = `
.resicon {
  border: 2px solid rgba(200, 200, 200, 1.0);
  border-radius: 15px;
  background-color : rgba(175, 175, 175, 1.0);
}

.resicon:hover {
  border: 2px solid rgba(100, 175, 255, 1.0);
  border-radius: 15px;
  background-color : rgba(175, 175, 175, 1.0);
}

.resicon_active {
  border: 2px solid rgba(180, 200, 255, 1.0);
  border-radius: 15px;
  background-color : rgba(180, 200, 255, 1.0);
}

.resicon_active:hover {
  border: 2px solid rgba(100, 175, 255, 1.0);
  border-radius: 15px;
  background-color : rgba(180, 200, 255, 1.0);
}

`.trim()

export class ResourceIcon extends UIBase {
  constructor() {
    super()
    this._last_cellsize = undefined
  }

  init() {
    super.init()

    // border-radius: 5px;

    let span = (this.span = document.createElement('span'))
    span.setAttribute('class', 'DefaultText')
    span.textContent = this.getAttribute('name')

    this.shadow.appendChild(span)

    this.setAttribute('class', 'resicon')
    this.setCSS()
  }

  setCSS() {
    super.setCSS()

    let cellsize = parseFloat(this.getAttribute('cellsize'))

    let span = this.span

    span.style['position'] = 'absolute'
    span.style['top'] = cellsize - 35 + 'px'

    this.style['position'] = 'absolute'
    this.style['width'] = cellsize + 'px'
    this.style['height'] = cellsize + 'px'
  }

  static define() {
    return {
      tagname: 'resource-icon-x',
      flag   : AreaFlags.HIDDEN,
    }
  }

  updateCellSize() {
    if (this.getAttribute('cellsize') !== this._last_cellsize) {
      this._last_cellsize = this.getAttribute('cellsize')
      this.setCSS()
    }
  }

  update() {
    super.update()
    this.updateCellSize()
  }
}

UIBase.register(ResourceIcon)

export class ResourceBrowser extends Editor {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
ResourceBrowser {
  resourceType : string;
}
`
  )

  constructor() {
    super()

    this.resourceType = undefined
    this.needsRebuild = true
    this.icons = []
    this.icons.active = undefined
    this.swapCallback = undefined
    this.swapCancelled = undefined
    this._swapEnd = undefined
    this.cellsize = 128
  }

  static defineAPI(api) {
    let rstruct = super.defineAPI(api)
    let types = resourceManager.makeEnum()

    function rebuild() {
      let resbrowser = this.dataref

      if (resbrowser !== undefined) {
        resbrowser.rebuild()
      }
    }

    let prop = rstruct.enum('resourceType', 'resourceType', types, 'Mode')
    prop.on('change', rebuild)

    return rstruct
  }

  static openResourceBrowser(area, resourceType, oncancel) {
    return new Promise((accept, reject) => {
      let ctx = area.ctx

      let screen = genResBrowserScreen(ctx.state, ResourceBrowser)
      ctx.state.swapScreen(screen)

      let resarea = screen.sareas[0].area

      resarea._swapEnd = () => {
        getAppState().unswapScreen()
      }

      resarea.swapCallback = accept
      resarea.resourceType = resourceType
      resarea.needsRebuild = true
      resarea.swapCancelled = oncancel
    })

    return new Promise((accept, reject) => {
      let newarea = area.swap(ResourceBrowser)

      newarea.swapCallback = accept
      newarea.resourceType = resourceType
      newarea.needsRebuild = true
      newarea.swapCancelled = oncancel
    })
  }

  init() {
    super.init()

    let header = this.header
    //this.typeWidget = header.prop("resbrowser.resourceType");

    header.button('Load', () => {
      let res = this.icons.active

      if (res === undefined) {
        return
      }

      this.end()

      if (this.swapCallback !== undefined) {
        this.swapCallback(res.res)
      }
    })

    header.button('Cancel', () => {
      this.end()

      if (this.swapCancelled !== undefined) {
        this.swapCancelled()
      }
    })

    this.table = this.container.table()
    this.rebuild()
  }

  end() {
    if (this._swapEnd !== undefined) {
      this._swapEnd()
    }

    this._swapEnd = undefined
  }

  makeResIcon() {
    let ret = document.createElement('resource-icon-x')
    ret.setAttribute('cellsize', this.cellsize)
    return ret
  }

  on_area_inactive() {
    super.on_area_inactive()

    this.table.clear()
    this.icons = []
    this.icons.active = undefined
    this.needsRebuild = false
  }

  on_area_active() {
    super.on_area_active()
    this.needsRebuild = true
  }

  rebuild() {
    if (this.table === undefined) {
      return
    }

    this.setCSS()

    let rect = this.getClientRects()[0]

    //probably been disconnected from the dom
    if (rect === undefined) {
      this.needsRebuild = true
      return
    }

    let width = rect.width
    let cells = Math.floor(width / this.cellsize)
    cells = Math.max(cells, 1)

    this.needsRebuild = false

    this.icons = []
    this.icons.active = undefined

    let table = this.table
    table.clear()

    if (!(this.resourceType in ResourcePages)) {
      return
    }

    let page = ResourcePages[this.resourceType]

    let setActive = (icon) => {
      if (this.icons.active !== undefined) {
        this.icons.active.setAttribute('class', 'resicon')
      }

      icon.setAttribute('class', 'resicon_active')
      this.icons.active = icon
    }

    let icon_click = (e) => {
      setActive(e.target)
    }

    let i = 0
    let row = table.row()

    for (let res of page.getResources()) {
      let cell = row.cell()

      cell.style['background-color'] = 'rgba(0,0,0,0.0)'
      cell.style['padding'] = '5px'

      cell.overrideDefault('DefaultPanelBG', 'rgba(0,0,0,0.0)')

      cell.style['width'] = this.cellsize + 'px'
      cell.style['height'] = this.cellsize + 'px'

      /*this is the stupidest thing.
       * why do I have to insert the stylesheet node *here*?*/
      let style = document.createElement('style')
      style.textContent = ResIconStyle
      cell.shadow.prepend(style)

      let name = res.name !== undefined ? res.name : res.url

      let icon = this.makeResIcon()
      icon.setAttribute('name', name)
      icon.res = res

      cell.shadow.appendChild(icon)

      this.icons.push(icon)

      icon.addEventListener('click', icon_click)
      icon.addEventListener('mousedown', icon_click)
      icon.addEventListener('touchstart', icon_click)

      i++
      if (i == cells) {
        row = table.row()
        i = 0
      }
    }
  }

  update() {
    super.update()

    if (this.needsRebuild) {
      this.rebuild()
    }
  }

  copy() {
    let ret = document.createElement('resource-browser-x')
    ret.resourceType = this.resourceType
    return ret
  }

  defineKeyMap() {
    this.keymap = new KeyMap()

    return this.keymap
  }

  setCSS() {
    super.setCSS()

    if (this.table === undefined) {
      return
    }

    let table = this.table

    table.style['background-color'] = 'rgba(100, 100, 100, 1.0)'
    this.background = 'rgba(100, 100, 100, 1.0)'
    //table.style["position"] = "absolute";
    //table.style["width"] = "100%";
    //table.style["height"] = "100%";
  }

  static define() {
    return {
      tagname : 'resource-browser-x',
      areaname: 'resbrowser',
      uiname  : 'Resource Browser',
      flag    : AreaFlags.HIDDEN,
    }
  }

  static newSTRUCT() {
    return document.createElement(this.define().tagname)
  }
}

Editor.register(ResourceBrowser)
