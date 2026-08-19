/**
 * LiteMesh default-scene override (ImmediateTODOs #2).
 *
 * Replaces the mesh subsystem's classic startup cube with a LiteMesh sphere
 * (spherified cube, dimen 50 / size 4) and asks the default file to start in the
 * sculptcore toolmode. Installed by the addon's `register(api)` hook, so it is
 * withdrawn again when the addon is disabled.
 *
 * wasm is loaded (entry_point's `await loadWasm()`) before the default file is
 * built, so getWasmImmediate() is valid here.
 */

import type {ToolContext} from '../../../../scripts/core/context'
import type {Library} from '../../../../scripts/core/lib_api'
import type {Scene} from '../../../../scripts/scene/scene'
import {SceneObject} from '../../../../scripts/sceneobject/sceneobject'
import {Light} from '../../../../scripts/light/light.js'
import {makeDefaultMaterial} from '../../../../scripts/core/material'
import {getWasmImmediate} from '@sculptcore/api/api'
import {LiteMesh} from './litemesh'

export function buildLiteMeshDefaultScene(ctx: ToolContext, lib: Library, scene: Scene): void {
  const wasm = getWasmImmediate()!
  // Spherified cube: dimen 50 subdivisions, size 4, fully spherified (sphere=1).
  const lm = new LiteMesh(wasm.Mesh_createCube(165, 16.0, 1.0))
  lib.add(lm)

  const mat = makeDefaultMaterial()
  lib.add(mat)
  lm.materials.push(mat)
  mat.lib_addUser(lm)

  const sob = new SceneObject()
  lib.add(sob)
  sob.data = lm
  lm.lib_addUser(sob)

  scene.add(sob)
  scene.objects.setSelect(sob, true)
  scene.objects.setActive(sob)

  const light = new Light()
  lib.add(light)
  const lightOb = new SceneObject(light)
  lib.add(lightOb)
  lightOb.location[2] = 7.0
  scene.add(lightOb)

  sob.graphUpdate()
  lm.graphUpdate()
}
