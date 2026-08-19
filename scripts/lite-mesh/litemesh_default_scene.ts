/**
 * LiteMesh default-scene override (ImmediateTODOs #2).
 *
 * Replaces the mesh subsystem's classic startup cube with a LiteMesh sphere
 * (spherified cube, dimen 50 / size 4) and asks the default file to start in the
 * sculptcore toolmode. Registered as a side-effect import in entry_point.js
 * AFTER any addon-contributed builder so this one wins.
 *
 * Lives in the lite-mesh layer (which owns the wasm-backed LiteMesh) rather than
 * the mesh addon, per the "builders register downward from the layer that owns
 * their deps" convention. wasm is loaded (entry_point's `await loadWasm()`)
 * before the default file is built, so getWasmImmediate() is valid here.
 */

import {setDefaultSceneBuilder, setDefaultToolMode} from '../core/default_file'
import type {ToolContext} from '../core/context'
import type {Library} from '../core/lib_api'
import type {Scene} from '../scene/scene'
import {SceneObject} from '../sceneobject/sceneobject'
import {Light} from '../light/light.js'
import {makeDefaultMaterial} from '../core/material'
import {getWasmImmediate} from '@sculptcore/api/api'
import {LiteMesh} from './litemesh'

setDefaultSceneBuilder((ctx: ToolContext, lib: Library, scene: Scene) => {
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
})

setDefaultToolMode('sculptcore')
