/**
 * Registers sculptcore-backed `LiteMesh` test scenes into the core test-scene
 * registry (`scripts/core/test_scenes.ts`), driven by the NW.js CLI harness
 * (`--gen-scene litemesh-cube`, see `scripts/core/test_harness.ts`).
 *
 * This lives in the lite-mesh layer — not core — because building the scene
 * constructs a `LiteMesh` (which pulls in sculptcore via `@sculptcore/api`),
 * and core must not depend on lite-mesh / sculptcore. The registration is the
 * same downward-inversion the old BREP default scene used for
 * the startup cube. The builders are handed to `api.registerTestScene` by the
 * addon's `register(api)` hook, so they come back out on disable.
 *
 * The scene is built *procedurally* at startup (rather than loaded from a
 * `.wproj`): the construction is deterministic, so the native and WASM
 * sculptcore backends build byte-identical geometry for parity diffing
 * (documentation/plans/native-electron.md, Workstream F). `LiteMesh`
 * serialization is now wired (`_data: iter(byte) | this.serialize()`), so the
 * harness can also round-trip a saved `.wproj` via `--load`.
 */

import type {ToolContext} from '../../../../scripts/core/context'
import type {Library} from '../../../../scripts/core/lib_api'
import type {Scene} from '../../../../scripts/scene/scene'
import type {TestSceneArgs, TestSceneBuilder} from '../../../../scripts/core/test_scenes'
import {SceneObject} from '../../../../scripts/sceneobject/index'
import {Light} from '../../../../scripts/light/light.js'
import {getWasmImmediate} from '@sculptcore/api/api'
import {AttrDomain, AttrUseFlags, LiteMesh} from './litemesh'
import {AttrType} from './litemesh_base'
// Side-effect: registers globalThis.__attrtestApply for the attr-render test.
import './litemesh_attrtest_support'
// Side-effect: registers globalThis.__quadRemeshTest for the quad-remesh test.
import './litemesh_quad_remesh_support'
// Side-effect: registers globalThis.__brushTest for the brush-behavior test.
import './litemesh_brushtest_support'
import './litemesh_gpubrush_test_support'
// Side-effect: registers globalThis.__layerTest for the sculpt-layer test.
import './litemesh_layertest_support'
// Side-effect: registers globalThis.__vdmTest for the VDM splat/parity test.
import './litemesh_vdmtest_support'
// Side-effect: registers globalThis.__vdmRenderTest for the VDM screenshot gate.
import './litemesh_vdmrender_support'
// Side-effect: registers globalThis.__boundaryTest for the boundary-constraint test.
import './litemesh_boundarytest_support'
// Side-effect: registers globalThis.__undoMemTest for the undo-memory test.
import './litemesh_undomem_support'
// Side-effect: registers globalThis.__solidTexTest for the textured-draw test.
import './litemesh_solidtextest_support'
// Side-effect: registers globalThis.__autosaveTest for the autosave round-trip test.
import './litemesh_autosavetest_support'
// Side-effect: registers globalThis.__fuzzTest for the sculpt fuzz test.
import './litemesh_fuzztest_support'
// Side-effect: registers globalThis.__selectFlushTest for the selectFlush test.
import './litemesh_selectflushtest_support'
// Side-effect: registers globalThis.__multiresTest for the multires subsurf test.
import './litemesh_multirestest_support'
// Side-effect: registers globalThis.__materialFragTest for the material draw-split measurement.
import './litemesh_materialfragtest_support'
// Side-effect: registers globalThis.__selectSimilarTest for the select-similar test.
import './litemesh_selectsimilartest_support'
// Side-effect: registers globalThis.__colorMixTest for the color-brush mix-mode test.
import './litemesh_colormixtest_support'
// Side-effect: registers the example-scene builders (example-multires-sphere,
// example-texture-cube) used to generate the shipped examples/tests/*.wproj files.
import './litemesh_example_scenes'

/**
 * Builds a single LiteMesh object (a sculptcore cube) plus a light.
 *
 * Scene args:
 *   subdiv=<n>   cube subdivision count (default 60)
 *   size=<f>     cube half-extent / size passed to Mesh_createCube (default 4 —
 *                large enough that the mesh fills the viewport under the default
 *                camera; the built-in LiteMesh() cube is size 1, which renders
 *                tiny in the test harness)
 *   sphere=<f>   cube->sphere morph factor 0..1 (default 1 = fully spherified)
 *   light=0      omit the light
 */
function buildLiteMeshCube(_ctx: ToolContext, lib: Library, scene: Scene, args: TestSceneArgs): void {
  const subdiv = args.subdiv && Number.isFinite(parseInt(args.subdiv, 10)) ? parseInt(args.subdiv, 10) : 60
  const size = args.size && Number.isFinite(parseFloat(args.size)) ? parseFloat(args.size) : 6.0
  const sphere = args.sphere !== undefined && Number.isFinite(parseFloat(args.sphere)) ? parseFloat(args.sphere) : 1.0

  const wasm = getWasmImmediate()!
  const lm = new LiteMesh(wasm.Mesh_createCube(subdiv, size, sphere))
  lib.add(lm)

  const sob = new SceneObject()
  lib.add(sob)
  sob.data = lm
  lm.lib_addUser(sob)

  scene.add(sob)
  scene.objects.setSelect(sob, true)
  scene.objects.setActive(sob)

  if (args.light !== '0') {
    const light = new Light()
    lib.add(light)
    const lightOb = new SceneObject(light)
    lib.add(lightOb)
    lightOb.location[2] = 7.0
    scene.add(lightOb)
  }

  sob.graphUpdate()
  lm.graphUpdate()
}

/**
 * The VDM fragment-render gate's scene (`__vdmRenderTest`, V3): the same
 * spherified cube, denser by default (subdiv 48) so the analytically-displaced
 * *reference* mesh is smooth enough for the screenshot A/B against the
 * fragment-path image. Same args as `litemesh-cube`.
 */
function buildLiteMeshVdmRender(ctx: ToolContext, lib: Library, scene: Scene, args: TestSceneArgs): void {
  buildLiteMeshCube(ctx, lib, scene, {subdiv: '48', ...args})
}

/**
 * Builds a LiteMesh cube carrying the two attribute layers the renderengine ↔
 * sculptcore dynamic-attribute path is meant to consume:
 *
 *   - a VERTEX FLOAT4 layer named `color` (AttrUse COLOR), filled with a
 *     deterministic position→rgb gradient (`fillVertexColorFromPosition`), and
 *   - a CORNER FLOAT2 layer named `uv` (AttrUse UV) from a per-face box unwrap
 *     (every edge seamed → `generateUVFromSeams`).
 *
 * Both layers are created procedurally and deterministically (C++-side, so the
 * WASM and native backends build byte-identical data), so a material's
 * `AttributeNode`s requesting `color`/`uv` resolve to real buffers, and the
 * parity dump can diff the new attr buffers. A material requesting a name that
 * isn't here exercises the missing-attr (default-fill + advisory) path.
 *
 * Scene args:
 *   subdiv=<n>   cube subdivision (default 8 — small, fast, parity-friendly)
 *   size=<f>     cube half-extent (default 6)
 *   light=0      omit the light
 *
 * Deliberately a *real* cube (sphere=0) so the per-face planar charts are clean.
 */
function buildLiteMeshAttrTest(_ctx: ToolContext, lib: Library, scene: Scene, args: TestSceneArgs): void {
  const subdiv = args.subdiv && Number.isFinite(parseInt(args.subdiv, 10)) ? parseInt(args.subdiv, 10) : 8
  const size = args.size && Number.isFinite(parseFloat(args.size)) ? parseFloat(args.size) : 6.0

  const wasm = getWasmImmediate()!
  const lm = new LiteMesh(wasm.Mesh_createCube(subdiv, size, 0.0))
  lib.add(lm)

  // Vertex color layer (FLOAT4, tagged COLOR), filled position→rgb.
  lm.addAttr(AttrDomain.VERTEX, AttrType.Float4, AttrUseFlags.COLOR)
  lm.fillVertexColorFromPosition()

  // Per-face UV unwrap: seam every edge, then generate a packed corner UV layer.
  lm.markAllSeams()
  lm.generateUVFromSeams()

  const sob = new SceneObject()
  lib.add(sob)
  sob.data = lm
  lm.lib_addUser(sob)

  scene.add(sob)
  scene.objects.setSelect(sob, true)
  scene.objects.setActive(sob)

  if (args.light !== '0') {
    const light = new Light()
    lib.add(light)
    const lightOb = new SceneObject(light)
    lib.add(lightOb)
    lightOb.location[2] = 7.0
    scene.add(lightOb)
  }

  sob.graphUpdate()
  lm.graphUpdate()
}

/**
 * Builds a single all-quad UV-sphere LiteMesh (plus a light) — the
 * remesh-friendly primitive for the quad-remesh parity / round-trip test
 * (`tests/integration/litemesh_quad_remesh.test.ts`). The spherified cube of
 * `litemesh-cube` has eight valence-3 corner singularities that the global MIQ
 * field can't satisfy, so it clean-fails; a UV sphere (poles its only
 * singularities) is the smallest mesh that drives a *successful* remesh, mirroring
 * the synthetic C++ suite's `makeUVSphere`. Construction is deterministic, so the
 * native and WASM backends build byte-identical geometry for parity diffing.
 *
 * Scene args:
 *   rings=<n>    latitudinal bands (default 24)
 *   segs=<n>     longitudinal segments (default 32)
 *   radius=<f>   sphere radius (default 2)
 *   light=0      omit the light
 */
function buildLiteMeshUVSphere(_ctx: ToolContext, lib: Library, scene: Scene, args: TestSceneArgs): void {
  const rings = args.rings && Number.isFinite(parseInt(args.rings, 10)) ? parseInt(args.rings, 10) : 24
  const segs = args.segs && Number.isFinite(parseInt(args.segs, 10)) ? parseInt(args.segs, 10) : 32
  const radius = args.radius !== undefined && Number.isFinite(parseFloat(args.radius)) ? parseFloat(args.radius) : 2.0

  const wasm = getWasmImmediate()!
  const lm = new LiteMesh(wasm.Mesh_makeUVSphere(rings, segs, radius))
  lib.add(lm)

  const sob = new SceneObject()
  lib.add(sob)
  sob.data = lm
  lm.lib_addUser(sob)

  scene.add(sob)
  scene.objects.setSelect(sob, true)
  scene.objects.setActive(sob)

  if (args.light !== '0') {
    const light = new Light()
    lib.add(light)
    const lightOb = new SceneObject(light)
    lib.add(lightOb)
    lightOb.location[2] = 7.0
    scene.add(lightOb)
  }

  sob.graphUpdate()
  lm.graphUpdate()
}

/** The parity / integration scenes, keyed by their `--gen-scene` name. */
export const LITEMESH_TEST_SCENES: {[name: string]: TestSceneBuilder} = {
  'litemesh-cube'     : buildLiteMeshCube,
  'litemesh-vdmrender': buildLiteMeshVdmRender,
  'litemesh-attrtest' : buildLiteMeshAttrTest,
  'litemesh-uvsphere' : buildLiteMeshUVSphere,
}
