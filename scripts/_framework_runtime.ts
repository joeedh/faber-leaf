/**
 * Exposes the framework's re-export hubs on `globalThis._framework` so that
 * addon bundles (which externalize `@framework/api` and `@framework/pathux`
 * via `tools/framework_api_plugin.js`) can look up real values at runtime
 * instead of inlining the framework source.
 *
 * Must run before `scripts/entry_point.js` imports `@distribution` (whose
 * in-bundle addons are ordinary static imports). The main bundle keeps importing
 * `scripts/framework_api.ts` directly through its real path; addons go
 * through the global.
 */

import * as api from './framework_api.js'
// path.ux is re-exported through framework_api.ts today, so we don't strictly
// need a separate namespace until Step 3 of the pathux split. Adding it now
// is harmless and keeps the runtime contract stable across both steps.
import * as pathux from './path.ux/scripts/pathux.js'

declare global {
  var _framework: {
    api: typeof api
    pathux: typeof pathux
  }
}

;(globalThis as unknown as {_framework: unknown})._framework = {api, pathux}
