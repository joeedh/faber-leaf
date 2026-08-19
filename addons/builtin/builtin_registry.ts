/**
 * The single in-bundle builtin registry.
 *
 * Statically imports every builtin that ships inside the main bundle (the
 * duplication-unavoidable subsystems — see
 * documentation/plans/native-electron.md / the unified-registrator plan) and
 * registers each as an addon *source* via `addonManager.registerBuiltin`. This
 * does NOT enable them — they flow through the same `start()` → topo-sort →
 * enable lifecycle as third-party addons. The only difference from an external
 * addon is that the module is already imported (no separate compile / dynamic
 * import).
 *
 * P13 deleted the BREP, and with it four of the five entries this file used to
 * carry; P15 merged the `sculptcore` shim into `litemesh`, which is now the only
 * in-bundle builtin left. `leafmesh` is not here because P11 ships it
 * out-of-bundle (build/addons/leafmesh/), which is the direction litemesh
 * travels in P16.
 *
 * `manifest.json` stays the single metadata source — imported here directly.
 */

import addonManager from '../../scripts/addon/addon.js'
import type {IAddon} from '../../scripts/addon/addon_base'

import litemeshManifest from './litemesh/manifest.json'
import * as litemeshAddon from './litemesh/src/main.js'

addonManager.registerBuiltin(litemeshManifest, litemeshAddon as IAddon)
