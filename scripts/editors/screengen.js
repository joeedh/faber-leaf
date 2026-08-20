import {MenuBarEditor} from './menu/MainMenu.js'
import {PropsEditor} from './properties/PropsEditor.js'
import {View3D} from './view3d/view3d.js'
import {getAppState} from '../core/app_instance.js'

export function genResBrowserScreen(appstate, ResourceBrowser) {
  let screen = document.createElement('webgl-app-x')

  let oldscreen = appstate.screen

  screen.ctx = appstate.ctx
  screen.size[0] = oldscreen.size[0]
  screen.size[1] = oldscreen.size[1]

  let sarea = document.createElement('screenarea-x')

  sarea.ctx = appstate.ctx
  sarea.floating = false

  sarea.pos[0] = 0.0
  sarea.pos[1] = 0.0

  sarea.size[0] = oldscreen.size[0]
  sarea.size[1] = oldscreen.size[1]

  sarea.switch_editor(ResourceBrowser)
  screen.appendChild(sarea)

  return screen
}

export function genDefaultScreen(appstate) {
  let screen = getAppState().screen

  screen.clear()
  screen.ctx = appstate.ctx

  let sarea = document.createElement('screenarea-x')

  sarea.ctx = appstate.ctx
  sarea.floating = false

  sarea.pos[0] = sarea.pos[1] = 0.0
  sarea.size[0] = appstate.screen.size[0]
  sarea.size[1] = appstate.screen.size[1]

  sarea.switchEditor(View3D)

  screen.appendChild(sarea)

  let t = 35 / sarea.size[1]
  let smenu = sarea

  let sarea2 = screen.splitArea(sarea, t, true)

  smenu.area.closed = true // hide view3d
  smenu.switchEditor(MenuBarEditor)

  let sarea3 = screen.splitArea(sarea2, 0.75, false)
  sarea3.area.closed = true // hide view3d
  sarea3.switchEditor(PropsEditor)

  screen.listen()
}

window._genDefaultScreen = genDefaultScreen
