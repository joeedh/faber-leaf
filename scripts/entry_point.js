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

// Inversion bridge: registers the builtin-addon classes (Mesh, Vertex, Element,
// BVHSettings, CurveSpline) into the core data-API registry. Must be imported
// before preinit() (which constructs AppState → getDataAPI), so the registry is
// populated when getDataAPI walks it. See addons/builtin/builtin_data_api.ts.
import '../addons/builtin/builtin_data_api.js'

// View3D toolmode registrations. Was previously in core/appstate.ts; moved
// here so core stops importing from editors/view3d/tools. See plan §3 / §12.
import './editors/view3d/tools/tools.js'

// The single in-bundle builtin registry. Imported AFTER tools.js so the
// toolmode class modules (sculptcore) are evaluated before the registry
// references them. Registers each in-bundle builtin as an addon source; the
// unified startAddons() pipeline materializes + enables them. Replaces the
// per-addon addon_register.js side-effect imports.
import '../addons/builtin/builtin_registry.js'

import addon, {startAddons} from './addon/addon.js'

// Registers the 'litemesh-cube' test scene into core's test-scene registry so
// the CLI harness (`--gen-scene litemesh-cube`) can build a sculptcore-backed
// LiteMesh scene. Side-effect import; lite-mesh layer registering downward.
// See documentation/plans/native-electron.md (Workstream F).
import './lite-mesh/litemesh_test_scene.js'

// Overrides the mesh subsystem's startup cube with a LiteMesh sphere +
// sculptcore startup toolmode. Must come AFTER builtin_registry, which pulls in
// the mesh addon's default_scene, so this builder wins. See ImmediateTODOs #2.
import './lite-mesh/litemesh_default_scene.js'

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
