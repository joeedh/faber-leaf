// Side-effect: assigns globalThis._framework so externalized addon bundles
// (which see `@framework/api` as a stub looking up globalThis._framework.api)
// resolve to the main bundle's namespace. Must run before any addon's
// addon_register side effects below.
import './_framework_runtime.js'

import './typescript_entry.js'
import './camera/camera.js'

import * as appstate from './core/appstate.js'
import {migrateAppIdentity} from './core/identity_migration.js'
import {getAppStorage} from './core/app_storage.js'
// Registers the OPFS / IndexedDB autosave backend (used when no NW.js fs
// backend is available). Side-effect import; harmless under NW.js.
import './core/autosave_backend_browser.js'
import {loadShapes} from './webgl/simplemesh_shapes.js'

import './test/test_base.js'
import './test/test.js'

// View3D toolmode registrations. Was previously in core/appstate.ts; moved
// here so core stops importing from editors/view3d/tools. See plan §3 / §12.
import './editors/view3d/tools/tools.js'

// The single in-bundle builtin registry: registers each in-bundle builtin as an
// addon source; the unified startAddons() pipeline materializes + enables them.
import '../addons/builtin/builtin_registry.js'

import addon, {startAddons} from './addon/addon.js'

import {getAppArgv, getArg} from './core/app_argv.js'
import {runTestHarness} from './core/test_harness.js'

import config from './config/config.js'
import {setupPathux} from './setup_pathux.js'
import {nstructjs} from './path.ux/pathux.js'
import * as sculptcore from '@sculptcore/api/api'

// Backend selection (Workstream C seam) must be set BEFORE the initial
// loadWasm() — it runs at module load, before handleNodeArguments(). The test
// harness's later --backend handling is too late for this first load.
const _backend = getArg('backend')
if (_backend) {
  globalThis.__SCULPTCORE_BACKEND = _backend
}

await sculptcore.loadWasm()

export function handleNodeArguments() {
  // getAppArgv reads the NW.js user args (nw.App.argv); see
  // scripts/core/app_argv.ts.
  let args = getAppArgv()
  _appstate.arguments = args
  console.log('app arguments', args)

  addon.handleArgv(args)

  // Run the scripted test harness if any --gen-scene/--save/--dump/--run/
  // --screenshot/--exit flags are present (a no-op otherwise). This is the
  // orchestration entry point for documentation/plans/native-electron.md.
  runTestHarness(args).catch((err) => console.error('test harness error', err))
}

export async function init() {
  // Must run before anything reads the startup scene, settings or the installed
  // addon list, i.e. before preinit()/startAddons(). Never throws.
  await migrateAppIdentity(getAppStorage())

  await setupPathux()

  await sculptcore.getWasm()

  //give addons 500 ms to load
  let timeout = config.addonLoadWaitTime
  if (timeout === undefined) {
    timeout = 500
  }

  nstructjs.setWarningMode(0)
  nstructjs.validateStructs()

  appstate.preinit()

  console.log('Loading addons')
  // Await the unified pipeline so every addon's toolmodes/editors/datablocks
  // are registered + enabled before we build the UI (appstate.init). Builtin
  // sources were registered synchronously by the builtin_registry import above.
  await startAddons(true)

  window.setTimeout(() => {
    loadShapes()

    appstate.init()
    window.setTimeout(() => {
      window._print_evt_debug = true
    }, 100)

    if (window.haveNwjs) {
      window.setTimeout(() => {
        handleNodeArguments()
      }, 0)
    }

    //shortcut for console use only
    if (typeof CTX === 'undefined') {
      Object.defineProperty(window, 'CTX', {
        get: () => {
          return _appstate.ctx
        },
      })
    }
  }, timeout)
}
