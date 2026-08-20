// Side-effect: assigns globalThis._framework so externalized addon bundles
// (which see `@framework/api` as a stub looking up globalThis._framework.api)
// resolve to the main bundle's namespace. Must run before the distribution
// below, whose in-bundle addons are imported at module scope.
import './_framework_runtime.js'

import './typescript_entry.js'
import './camera/camera.js'

// Registers the OPFS / IndexedDB autosave backend (used when no NW.js fs
// backend is available). Side-effect import; harmless under NW.js.
import './core/autosave_backend_browser.js'

import './test/test_base.js'
import './test/test.js'

// View3D toolmode registrations. Was previously in core/appstate.ts; moved
// here so core stops importing from editors/view3d/tools. See plan §3 / §12.
import './editors/view3d/tools/tools.js'

// `image.set_type`, restored from the archived image editor. Registered here
// rather than beside the other op imports in data_api/api_define.ts: that hub
// sits inside the host's import-cycle knot, and a side-effect-only ToolOp
// registration has no reason to join it.
import './image/image_type_ops.js'

// The distribution this bundle was built for: which addons ship, which startup
// scene opens, what the window is called. `@distribution` is aliased by
// tools/esbuilder.js --distribution <name>; the default is faber-leaf. This is
// the only place the app names a product.
import distribution from '@distribution'

import addon from './addon/addon.js'

import {getAppState} from './core/app_instance.js'
import {getAppArgv} from './core/app_argv.js'
import {runTestHarness} from './core/test_harness.js'
import {mountFaberLeaf} from './mount.js'

// The embedding surface. `mountFaberLeaf` is a page-level entry, not an addon
// one, so it ships from the bundle entry rather than @framework/api.
export {mountFaberLeaf, mountedInstances} from './mount.js'

export function handleNodeArguments() {
  // getAppArgv reads the NW.js user args (nw.App.argv); see
  // scripts/core/app_argv.ts.
  let args = getAppArgv()
  getAppState().arguments = args
  console.log('app arguments', args)

  addon.handleArgv(args)

  // Run the scripted test harness if any --gen-scene/--save/--dump/--run/
  // --screenshot/--exit flags are present (a no-op otherwise). This is the
  // orchestration entry point for documentation/plans/native-electron.md.
  runTestHarness(args).catch((err) => console.error('test harness error', err))
}

export async function init() {
  const handle = await mountFaberLeaf(document.body, {distribution})

  window.setTimeout(() => {
    window._print_evt_debug = true
  }, 100)

  if (window.haveNwjs) {
    window.setTimeout(() => {
      handleNodeArguments()
    }, 0)
  }

  return handle
}
