import cconst2 from './path.ux/scripts/config/const.js'
import {default as config, loadConfigLocal} from './config/config.js'
import {IconManager, setBaseUnit, setIconManager, setIconMap, setMetric, UIBase} from './path.ux/scripts/pathux.js'
import {Icons} from './editors/icon_enum.js'
import {resolvePath} from './config.js'
import {_setUIBase} from './framework_api.js'

_setUIBase(UIBase)

export var iconmanager

/**
 * @param {string|undefined} iconSheetUrl explicit sheet URL; when omitted the
 *        host document's `#iconsheet` is used, then a prefix-resolved default.
 *        The NW.js shell needs the markup: its window.html sits one directory
 *        down, so resolvePath() would aim at `nwjs/assets/`.
 */
export function setupIconsSvg(iconSheetUrl) {
  const existingSheet = document.querySelector('#iconsheet')
  let iconsheet

  if (iconSheetUrl !== undefined) {
    iconsheet = document.createElement('img')
    iconsheet.src = iconSheetUrl
  } else if (existingSheet instanceof HTMLImageElement) {
    iconsheet = existingSheet
  } else {
    iconsheet = document.createElement('img')
    iconsheet.src = resolvePath('assets/iconsheet.svg')
  }

  iconmanager = new IconManager(
    [iconsheet, iconsheet, iconsheet, iconsheet],
    [
      [32, 22],
      [32, 25],
      [32, 38],
      [32, 55],
    ],
    16
  )

  setIconManager(iconmanager, {
    SMALL : 0,
    LARGE : 1,
    XLARGE: 2,
  })

  window.updateIconDPI = () => {
    //do nothing.
  }
}

/**
 * Process-wide path.ux setup: constants, units and the icon manager. path.ux
 * holds these as module globals, so this runs once per page, not per mounted
 * app instance.
 *
 * @param {{iconSheetUrl?: string}} options
 */
export async function setupPathux(options = {}) {
  await loadConfigLocal()

  config.pathuxConfig.DEBUG = config.DEBUG || {}
  cconst2.loadConstants(config.pathuxConfig)
  window.DEBUG = cconst2.DEBUG

  setBaseUnit('meter')
  setMetric(true)

  setupIconsSvg(options.iconSheetUrl)
}
