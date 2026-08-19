/**
 * Subsurf addon entry point.
 *
 * Subsurf ships in the main bundle (mesh grids transitively pull in subsurf for
 * patch tessellation, so factoring it into its own bundle would create a
 * build-time mesh ↔ subsurf cycle). It is registered as an in-bundle builtin
 * source by `addons/builtin/builtin_registry.ts` and enabled through the
 * unified pipeline; this module's `register(api)` publishes its surface.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {ccSmooth, createPatches, loopSubdivide, subdivide} from './subsurf_mesh.js'
import {
  CubicPatch,
  CubicPatchFields,
  CubicPatchFlags,
  Patch4,
  PatchBase,
  SSPatch,
  bernstein,
  bspline,
} from './subsurf_patch.js'
import {PCOLOR, PCOS, PEID, PTOT, PatchData, PatchList} from './subsurf_base.js'

export const addonDefine: IAddonDefine = {
  name       : 'Subsurf',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Catmull-Clark subdivision surfaces and patch tessellation.',
}

export function register(api: AddonAPI<IAddon>) {
  // Keep in sync with `addons/builtin/subsurf/src/api.ts`.
  api.exportNamespace('subsurf', {
    ccSmooth,
    createPatches,
    loopSubdivide,
    subdivide,
    CubicPatchFields,
    CubicPatchFlags,
    bernstein,
    bspline,
    CubicPatch,
    SSPatch,
    Patch4,
    PatchBase,
    PCOS,
    PEID,
    PCOLOR,
    PTOT,
    PatchList,
    PatchData,
  })
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
