/**
 * LiteMesh addon entry point.
 *
 * The sculptcore-dependent half of the application: the `LiteMesh` geometry
 * type, its ToolOps, the sculpt and box-modeling toolmodes, and the stroke
 * driver. This addon declares `"optional": true`, so it does not register
 * when sculptcore is absent; that registration check is the single point
 * that gates the whole engine (P15 §2).
 *
 * It absorbed the old `addons/builtin/sculptcore/` addon, which was a
 * three-file shim publishing a toolmode and three `litemesh.add_*` menu
 * entries. The engine binding is the `@sculptcore/api` workspace package,
 * not an addon, so splitting this addon further would have produced only
 * "LiteMesh with no sculpt mode" — see P15 §4.1.
 *
 * Still in-bundle wherever a distribution imports it (`bundled(...)` in
 * distributions/<id>/index.ts), so its modules still reach `scripts/` by
 * relative path. Pushing it out-of-bundle would force those onto
 * `@framework/api`.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {getArg} from '@framework/api'
import {loadWasm} from '@sculptcore/api/api'
import {BoxModelToolMode} from './boxmodel.js'
import {LITEMESH_FEATURE_FLAGS} from './feature_flags.js'
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
import {LITEMESH_UV_PROVIDER} from './uv_source.js'

export const addonDefine: IAddonDefine = {
  name       : 'Lite Mesh',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Sculptcore-backed triangle mesh, sculpt and box-modeling toolmodes.',
}

export function register(api: AddonAPI<IAddon>) {
  // Before anything that reads one: a flag with no definition reads false, so
  // a late registration would silently take the default path for one boot.
  api.registerFeatureFlags(LITEMESH_FEATURE_FLAGS)

  // `--backend native|wasm` must be read before the first loadWasm(); the test
  // harness's own --backend handling runs far too late for it.
  const backend = getArg('backend')
  if (backend) {
    ;(globalThis as {__SCULPTCORE_BACKEND?: string}).__SCULPTCORE_BACKEND = backend
  }

  // Nothing may deserialize a LiteMesh before the engine is up, so hold the
  // boot open until it is. Kicking it off here rather than at module load keeps
  // a force-disabled litemesh from paying for a load it will never use.
  const engineReady = loadWasm()
  api.registerBootTask(async () => {
    await engineReady
  }, 'litemesh: sculptcore engine')

  // Keep in sync with addons/builtin/litemesh/src/api.ts.
  api.exportNamespace('litemesh', {...litemesh, BoxModelToolMode, PaintToolModeBase, SculptCorePaintMode})

  api.register(LiteMesh)
  api.registerDataKind(LITEMESH_DATA_KIND)
  api.registerAll(...LITEMESH_OPS, ...STROKE_BASE_OPS, SculptPaintOp, SculptCorePaintMode, BoxModelToolMode)
  api.registerTransType(LiteMeshTransType)

  // Implementor #2 of `IUVSource` (P18 §5 step 2). Registered, not narrowed:
  // the source is an adapter over the engine's bulk UV accessors, so it cannot
  // be found by a capability query on the data block.
  api.registerUVSource(LITEMESH_UV_PROVIDER)

  // The startup file `faber-leaf` selects: a LiteMesh sphere in sculpt mode.
  // Named, so the distribution picks it rather than load order deciding.
  api.registerDefaultSceneBuilder('litemesh-sphere', buildLiteMeshDefaultScene, 'sculptcore')

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
