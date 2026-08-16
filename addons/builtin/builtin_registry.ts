/**
 * The single in-bundle builtin registry.
 *
 * Statically imports every builtin that ships inside the main bundle (these are
 * the duplication-unavoidable subsystems — see
 * documentation/plans/native-electron.md / the unified-registrator plan) and
 * registers each as an addon *source* via `addonManager.registerBuiltin`. This
 * does NOT enable them — they flow through the same `start()` → topo-sort →
 * enable lifecycle as third-party addons. The only difference from an external
 * addon is that the module is already imported (no separate compile / dynamic
 * import).
 *
 * Replaces the per-addon `addon_register.ts` side-effect imports that used to
 * live in `scripts/entry_point.js` plus the in-bundle toolmode registration in
 * `scripts/editors/view3d/tools/addon_register.ts`.
 *
 * `manifest.json` stays the single metadata source — imported here directly.
 */

import addonManager from '../../scripts/addon/addon.js'
import type {IAddon} from '../../scripts/addon/addon_base'

import meshManifest from './mesh/manifest.json'
import * as meshAddon from './mesh/src/main.js'

import subsurfManifest from './subsurf/manifest.json'
import * as subsurfAddon from './subsurf/src/main.js'

import meshEditManifest from './mesh_edit/manifest.json'
import * as meshEditAddon from './mesh_edit/src/main.js'

import curveManifest from './curve/manifest.json'
import * as curveAddon from './curve/src/main.js'

import sculptcoreManifest from './sculptcore/manifest.json'
import * as sculptcoreAddon from './sculptcore/src/main.js'

addonManager.registerBuiltin(meshManifest, meshAddon as IAddon)
addonManager.registerBuiltin(subsurfManifest, subsurfAddon as IAddon)
addonManager.registerBuiltin(meshEditManifest, meshEditAddon as IAddon)
addonManager.registerBuiltin(curveManifest, curveAddon as IAddon)
// tetmesh is NOT here: it ships as an external per-addon bundle (build/addons/
// tetmesh/) loaded via the index.json pipeline. See tools/check-addon-duplication.js.
addonManager.registerBuiltin(sculptcoreManifest, sculptcoreAddon as IAddon)
