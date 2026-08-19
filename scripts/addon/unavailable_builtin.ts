/**
 * Stands in for an in-bundle builtin addon that is not part of this build.
 *
 * A builtin addon may declare its engine as an `optionalDependencies` entry in
 * its package.json (the only `workspace:` field pnpm tolerates when the package
 * is absent). When that dependency did not install, `tools/builtin_addons.js`
 * reports the addon unavailable and both the typecheck config and esbuild
 * resolve its `@builtin/<id>` entry here instead — so its source never enters
 * the program or the bundle, and its build assets are never copied.
 *
 * `registerBuiltin` sees the sentinel and records the addon as unloaded rather
 * than enabling a shell of it. Nothing here is ever called (P16 W3b step 2).
 */

import type {AddonAPI, IAddon} from './addon_base'
import type {IAddonDefine} from './addon_base'

/** Read by AddonManager.registerBuiltin. The whole point of this module. */
export const unavailableBuiltin = true

export const addonDefine: IAddonDefine = {
  name       : 'Unavailable',
  version    : [0, 0, 0],
  author     : '',
  description: 'This addon is not part of this build.',
}

export function register(_api: AddonAPI<IAddon>): void {
  throw new Error('unavailable builtin: register() must never run')
}

export function unregister(): void {}

// The rest of IAddon, so `@builtin/<id>` typechecks against the same shape
// whether it resolved here or to the real addon. Never reached: registerBuiltin
// bails on the sentinel above before the module is ever driven.
export function handleArgv(_api: AddonAPI<IAddon>, _argv: string[]): void {}

export function validArgv(_api: AddonAPI<IAddon>, _argv: string[]): void {}
