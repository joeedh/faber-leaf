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
 * out-of-bundle (build/addons/leafmesh/); litemesh follows when P17's
 * distributions decide the addon set, not here.
 *
 * `manifest.json` stays the single metadata source — imported here directly.
 *
 * The entry module comes in through `@builtin/<id>`, not a relative path: when
 * the addon's optional workspace dependency did not install, that alias resolves
 * to `scripts/addon/unavailable_builtin` in both the typecheck config and the
 * bundle, and `registerBuiltin` records the addon as not-in-build. The manifest
 * import stays relative — it is metadata, and it is always there (P16 W3b).
 */

import addonManager from '../../scripts/addon/addon.js'
import type {IAddon} from '../../scripts/addon/addon_base'

import * as litemeshAddon from '@builtin/litemesh'
import litemeshManifest from './litemesh/manifest.json'

addonManager.registerBuiltin(litemeshManifest, litemeshAddon as IAddon)
