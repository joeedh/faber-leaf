/**
 * Registers sculptcore-backed `LiteMesh` *example* scenes into the core
 * test-scene registry (`scripts/core/test_scenes.ts`). Unlike the parity /
 * integration scenes in `litemesh_test_scene.ts`, these exist to be dumped to a
 * loadable `.wproj` (via the NW.js harness `--gen-scene <name> --save <file>`)
 * so the repo can ship ready-to-open example projects (see `examplesToMake.md`).
 *
 * Handed to `api.registerTestScene` alongside the parity scenes by the addon's
 * `register(api)` hook.
 */

import type {ToolContext} from '../../../../scripts/core/context'
import type {Library} from '../../../../scripts/core/lib_api'
import type {Scene} from '../../../../scripts/scene/scene'
import type {TestSceneArgs, TestSceneBuilder} from '../../../../scripts/core/test_scenes'
import {SceneObject} from '../../../../scripts/sceneobject/index'
import {Light} from '../../../../scripts/light/light.js'
import {makeDefaultMaterial} from '../../../../scripts/core/material'
import {FeatureFlags} from '@framework/api'
import {ImageBlock} from '../../../../scripts/image/image'
import {DiffuseNode, ImageNode} from '../../../../scripts/shadernodes/shader_nodes'
import {getWasmImmediate} from '@sculptcore/api/api'
import {LiteMesh} from './litemesh'

/** Add the shared "sun" light every example scene wants (unless light=0). */
function addLight(lib: Library, scene: Scene, args: TestSceneArgs): void {
  if (args.light === '0') {
    return
  }
  const light = new Light()
  lib.add(light)
  const lightOb = new SceneObject(light)
  lib.add(lightOb)
  lightOb.location[2] = 7.0
  scene.add(lightOb)
}

/** Wrap a LiteMesh in a SceneObject, add it to the scene, make it active. */
function addMeshObject(lib: Library, scene: Scene, lm: LiteMesh): SceneObject {
  const sob = new SceneObject()
  lib.add(sob)
  sob.data = lm
  lm.lib_addUser(sob)

  scene.add(sob)
  scene.objects.setSelect(sob, true)
  scene.objects.setActive(sob)
  return sob
}

/**
 * Basic multires sphere: a coarse spherified-cube cage with a Catmull-Clark
 * multires stack attached (the finest level is the active edit level). Saved as
 * `examples/tests/multiresBasic.wproj`.
 *
 * Scene args:
 *   subdiv=<n>   cage cube subdivision / dimen (default 8 — a coarse cage)
 *   size=<f>     cube half-extent (default 4)
 *   levels=<n>   multires stack depth (default 3)
 *   light=0      omit the light
 */
function buildMultiresSphere(_ctx: ToolContext, lib: Library, scene: Scene, args: TestSceneArgs): void {
  const subdiv = args.subdiv && Number.isFinite(parseInt(args.subdiv, 10)) ? parseInt(args.subdiv, 10) : 8
  const size = args.size && Number.isFinite(parseFloat(args.size)) ? parseFloat(args.size) : 4.0
  const levels = args.levels && Number.isFinite(parseInt(args.levels, 10)) ? parseInt(args.levels, 10) : 3

  const wasm = getWasmImmediate()!
  const lm = new LiteMesh(wasm.Mesh_createCube(subdiv, size, 1.0))
  lib.add(lm)

  const mat = makeDefaultMaterial()
  lib.add(mat)
  lm.materials.push(mat)
  mat.lib_addUser(lm)

  const sob = addMeshObject(lib, scene, lm)
  addLight(lib, scene, args)

  // Multires is a feature-flagged surface; enable it so the ToolOps that manage
  // the stack are live for anyone who opens the example.
  FeatureFlags.set('sculptcore.multires', true)
  lm.multiresEnable(levels)

  sob.graphUpdate()
  lm.graphUpdate()
}

/**
 * UV-mapped cube carrying a UVGRID test image: a real cube with a per-face box
 * unwrap (every edge seamed → `generateUVFromSeams`) and the default material's
 * diffuse color driven by an `ImageNode` sampling a fresh `ImageBlock` (whose
 * default `genType` is UVGRID — the built-in UV test grid). Saved as
 * `examples/tests/textureCube.wproj`.
 *
 * Scene args:
 *   subdiv=<n>   cube subdivision / dimen (default 2 — a plain 6-face cube)
 *   size=<f>     cube half-extent (default 4)
 *   light=0      omit the light
 */
function buildTextureCube(_ctx: ToolContext, lib: Library, scene: Scene, args: TestSceneArgs): void {
  const subdiv = args.subdiv && Number.isFinite(parseInt(args.subdiv, 10)) ? parseInt(args.subdiv, 10) : 2
  const size = args.size && Number.isFinite(parseFloat(args.size)) ? parseFloat(args.size) : 4.0

  const wasm = getWasmImmediate()!
  const lm = new LiteMesh(wasm.Mesh_createCube(subdiv, size, 0.0))
  lib.add(lm)

  // Per-face box unwrap: seam every edge, then generate the packed corner UVs.
  lm.markAllSeams()
  lm.generateUVFromSeams()

  const mat = makeDefaultMaterial()
  lib.add(mat)
  lm.materials.push(mat)
  mat.lib_addUser(lm)

  // Fresh ImageBlock defaults to the UVGRID generator (the built-in test image).
  const img = new ImageBlock()
  lib.add(img)
  img.update()

  const imageNode = new ImageNode()
  mat.graph.add(imageNode)
  imageNode.imageUser.image = img
  img.lib_addUser(mat)

  let diffuse: DiffuseNode | undefined
  for (const node of mat.graph.nodes) {
    if (node instanceof DiffuseNode) {
      diffuse = node
      break
    }
  }
  if (diffuse) {
    imageNode.outputs.color.connect(diffuse.inputs.color)
  }
  ;(mat as unknown as {_regen: boolean})._regen = true

  const sob = addMeshObject(lib, scene, lm)
  addLight(lib, scene, args)

  sob.graphUpdate()
  lm.graphUpdate()
}

/** The shippable example scenes, keyed by their `--gen-scene` name. */
export const LITEMESH_EXAMPLE_SCENES: {[name: string]: TestSceneBuilder} = {
  'example-multires-sphere': buildMultiresSphere,
  'example-texture-cube'   : buildTextureCube,
}
