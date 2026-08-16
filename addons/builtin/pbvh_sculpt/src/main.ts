/**
 * PBVH Sculpt addon entry point.
 *
 * Ships in the main bundle: its toolmode classes live in
 * `scripts/editors/view3d/tools/`. The addon's register() hook registers
 * BVHToolMode through api.register (so disabling the addon unregisters the
 * toolmode + its viewport-header icon) and publishes its surface so it appears
 * in the addon UI and peers can declare `dependencies: ['pbvh_sculpt']`.
 * Registered as an in-bundle builtin source by `addons/builtin/builtin_registry.ts`.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {BVHToolMode} from '../../../../scripts/editors/view3d/tools/pbvh.js'
import {PaintToolModeBase} from '../../../../scripts/editors/view3d/tools/stroke_base.js'

export const addonDefine: IAddonDefine = {
  name       : 'PBVH Sculpt',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Legacy mesh sculpt toolmode (BVH-based dyntopo + paint).',
}

export function register(api: AddonAPI<IAddon>) {
  // Register the toolmode through the addon lifecycle so disabling the addon
  // unregisters it (removing its viewport-header icon) — previously a
  // module-scope ToolMode.register leaked the icon while disabled (#7).
  api.register(BVHToolMode)
  api.exportNamespace('pbvh_sculpt', {BVHToolMode, PaintToolModeBase})
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
