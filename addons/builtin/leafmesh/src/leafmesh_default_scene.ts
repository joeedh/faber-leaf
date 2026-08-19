/**
 * The `leafmesh-cube` startup scene — what `faber-leaf-core` opens with.
 *
 * A cube, a default material and a light: the smallest scene that proves the
 * distribution booted with no engine present. Registered by name from the
 * addon's `register(api)` hook, so the distribution selects it rather than
 * addon load order deciding.
 */

import type {Library, Scene, ToolContext} from '@framework/api'
import {Light, SceneObject, makeDefaultMaterial} from '@framework/api'

import {LeafMeshData} from './leafmesh.js'
import {makeCube} from './primitives.js'

export function buildLeafMeshDefaultScene(_ctx: ToolContext, lib: Library, scene: Scene): void {
  const data = new LeafMeshData()
  data.name = 'Cube'
  makeCube(data.mesh, 1)
  lib.add(data)

  const mat = makeDefaultMaterial()
  lib.add(mat)
  data.materials.push(mat)
  mat.lib_addUser(data)

  const sob = new SceneObject()
  lib.add(sob)
  sob.data = data
  data.lib_addUser(sob)

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
  data.graphUpdate()
}
