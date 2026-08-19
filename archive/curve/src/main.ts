/**
 * Curve addon entry point.
 *
 * Ships in the main bundle (the app's data_api eagerly imports CurveSpline at
 * startup). Registered as an in-bundle builtin source by
 * `addons/builtin/builtin_registry.ts` and enabled through the unified
 * pipeline; this module's `register(api)` registers its classes + publishes its
 * surface.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {CurveSpline} from './curve.js'
import {KnotDataLayer} from './curve_knot.js'
import {CurveToolBase} from './curvetool.js'
import {CurveToolOverlay} from './curvetool_overlay.js'

export const addonDefine: IAddonDefine = {
  name       : 'Curve',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Bezier curve editing toolmode + CurveSpline DataBlock.',
}

export function register(api: AddonAPI<IAddon>) {
  // Keep in sync with addons/builtin/curve/src/api.ts.
  api.exportNamespace('curve', {CurveSpline, KnotDataLayer, CurveToolBase, CurveToolOverlay})
  api.registerAll(CurveSpline, KnotDataLayer, CurveToolBase, CurveToolOverlay)

  api.registerLegacyStructNames({CurveToolBase: 'curve.CurveToolBase'})
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
