/**
 * LiteMesh addon entry point.
 *
 * The sculptcore-dependent half of the application: the `LiteMesh` geometry
 * type, its ToolOps, the sculpt and box-modeling toolmodes, and the stroke
 * driver. `"optional": true` — absent sculptcore, this addon does not register,
 * and that is the single gate the whole engine sits behind (P15 §2).
 *
 * It absorbed the old `addons/builtin/sculptcore/` addon, which was a three-file
 * shim publishing a toolmode and three `litemesh.add_*` menu entries. The engine
 * *binding* is the `@sculptcore/api` workspace package, not an addon, so a split
 * would have bought only "LiteMesh with no sculpt mode" — see P15 §4.1.
 *
 * Still in-bundle (registered by `addons/builtin/builtin_registry.ts`), so its
 * modules still reach `scripts/` by relative path. P16 pushes it out-of-bundle,
 * which is what forces those onto `@framework/api`.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {BoxModelToolMode} from './boxmodel.js'
import * as litemesh from './index.js'
import {LITEMESH_DATA_KIND, LiteMesh} from './litemesh.js'
import {buildLiteMeshDefaultScene} from './litemesh_default_scene.js'
import {LITEMESH_EXAMPLE_SCENES} from './litemesh_example_scenes.js'
import {LITEMESH_OPS} from './litemesh_ops.js'
import {LITEMESH_TEST_SCENES} from './litemesh_test_scene.js'
import {LiteMeshTransType} from './litemesh_transtype.js'
import {SculptCorePaintMode} from './sculptcore.js'
import {SculptPaintOp} from './sculptcore_ops.js'
import {PaintToolModeBase, STROKE_BASE_OPS} from './stroke_base.js'

export const addonDefine: IAddonDefine = {
  name       : 'Lite Mesh',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Sculptcore-backed triangle mesh, sculpt and box-modeling toolmodes.',
}

export function register(api: AddonAPI<IAddon>) {
  // Keep in sync with addons/builtin/litemesh/src/api.ts.
  api.exportNamespace('litemesh', {...litemesh, BoxModelToolMode, PaintToolModeBase, SculptCorePaintMode})

  api.register(LiteMesh)
  api.registerDataKind(LITEMESH_DATA_KIND)
  api.registerAll(...LITEMESH_OPS, ...STROKE_BASE_OPS, SculptPaintOp, SculptCorePaintMode, BoxModelToolMode)
  api.registerTransType(LiteMeshTransType)

  // The startup file: a LiteMesh sphere, opened in sculpt mode. One slot, so
  // disabling the addon hands it back to whoever held it before.
  api.registerDefaultSceneBuilder(buildLiteMeshDefaultScene, 'sculptcore')

  for (const [name, builder] of Object.entries({...LITEMESH_TEST_SCENES, ...LITEMESH_EXAMPLE_SCENES})) {
    api.registerTestScene(name, builder)
  }

  // Contribute to the View3D "Add" menu (cleared automatically on disable).
  api.menuEntries('add', ['litemesh.add_cube(goalFaces=0)'])
  api.menuEntries('add', ['litemesh.add_cube(goalFaces=58806 sphere=1.0)|Add Sphere (Sculptcore)'])
  api.menuEntries('add', ['litemesh.add_plane()'])
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
