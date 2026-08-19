/**
 * Integration-test support for the renderengine ↔ sculptcore dynamic-attribute
 * path. Exposes `globalThis.__attrtestApply(...)`, which the Electron headless
 * harness drives from `--eval` (see `tests/integration/litemesh_attr_render.test.ts`).
 *
 * The headless `--dump` path never runs a real BasePass, so the renderengine's
 * material→`setRequestedAttrs`/`setDrawShader` wiring (M6) isn't exercised by
 * boot alone. This helper reproduces it deterministically: it builds a real
 * `Material` whose `AttributeNode`s request the named layers, runs the actual
 * WGSL codegen (`generateWgsl`, M1–M3) to collect the `requestedAttrs`, then
 * pushes them + the compiled WGSL to the active `LiteMesh` (M6 → M5 → M4). The
 * subsequent `--dump` snapshots the GPU buffers sculptcore built for them.
 *
 * It lives in the lite-mesh layer (it constructs a `LiteMesh`-bound material)
 * and is pulled in as a side-effect import from `litemesh_test_scene.ts`.
 */

import {Material} from '../../../../scripts/core/material'
import {AttributeNode, DiffuseNode, OutputNode} from '../../../../scripts/shadernodes/shader_nodes'
import type {IRenderLights} from '../../../../scripts/shadernodes/shader_lib_wgsl'
import type {RequestedAttrDesc} from '../../../../scripts/shadernodes/shader_nodes_wgsl'
import {nstructjs} from '../../../../scripts/path.ux/scripts/pathux.js'
import {LiteMesh} from './litemesh'

interface AttrTestRequest {
  /** Attribute layer name to request (e.g. 'color', 'uv', or a missing name). */
  name: string
  /** AttributeCategory: COLOR(2) / UV(4) / GENERIC(0). */
  category: number
}

interface AttrTestResult {
  ok: boolean
  error?: string
  /** The requested-attr contract handed to sculptcore (slot/elemSize/etc.). */
  requested: {name: string; slot: number; elemSize: number; gpuType: number; category: number}[]
  /** Slots sculptcore reports as absent on the mesh (advisory, default-filled). */
  missing: number[]
}

interface AttrTestOpts {
  /** Run `Mesh_updateFrames` first, so the `.frames.v.*` F3 frame vertex
   * layers exist for frame-slot requests (the V3 VDM render path's attrs). */
  updateFrames?: boolean
}

/**
 * Build a material requesting `requests`, generate its WGSL, and push the
 * resulting requested-attr set + shader to the scene's active LiteMesh.
 * Returns the requested contract + the missing-slot advisory. Never throws —
 * errors are captured in the result (the bulk-data/render seam must stay alive).
 */
function applyAttrTestMaterial(requests: AttrTestRequest[], opts: AttrTestOpts = {}): AttrTestResult {
  const result: AttrTestResult = {ok: false, requested: [], missing: []}
  try {
    const app = (globalThis as {_appstate?: {ctx: {scene: unknown}}})._appstate
    const scene = app?.ctx?.scene as {lights: Iterable<unknown>; objects: {active?: {data?: unknown}}} | undefined
    if (!scene) throw new Error('no active scene')

    const lite = scene.objects.active?.data
    if (!(lite instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')

    if (opts.updateFrames) {
      lite.wasm.Mesh_updateFrames(lite.mesh)
    }

    const mat = new Material()
    const diff = new DiffuseNode()
    const output = new OutputNode()
    mat.graph.add(diff)
    mat.graph.add(output)
    diff.outputs.surface.connect(output.inputs.surface)

    // Wire each requested attribute through a distinct DiffuseNode input so the
    // graph walker (getUsedNodes) counts the AttributeNode as contributing —
    // that's what makes generateWgsl collect it into requestedAttrs.
    requests.forEach((req, i) => {
      const node = new AttributeNode()
      node.attrName = req.name
      node.category = req.category
      mat.graph.add(node)
      switch (i % 3) {
        case 0:
          node.outputs.color.connect(diff.inputs.color) // vec4 → color
          break
        case 1:
          node.outputs.fac.connect(diff.inputs.roughness) // float → roughness
          break
        default:
          node.outputs.vector.connect(diff.inputs.normal) // vec3 → normal
      }
    })

    const rlights: IRenderLights = {}
    let lid = 0
    for (const light of scene.lights) {
      ;(rlights as Record<string, unknown>)[lid++] = {light}
    }

    const def = mat.generateWgsl(scene, rlights, {}) as {
      wgsl: string
      requestedAttrs: RequestedAttrDesc[]
    }

    lite.setRequestedAttrs(def.requestedAttrs)
    lite.setDrawShader(def.wgsl)
    // Build the GPU buffers now so a subsequent --dump (or this call) sees them.
    ;(lite.spatial as unknown as {update?: (gpu: unknown) => void}).update?.(lite.wasm.gpu)

    result.requested = def.requestedAttrs.map((r) => ({
      name    : r.name,
      slot    : r.slot,
      elemSize: r.elemSize,
      gpuType : r.gpuType,
      category: r.category,
    }))
    result.missing = lite.getMissingAttrSlots()
    result.ok = true
  } catch (err) {
    result.error = String(err)
  }
  ;(globalThis as {__attrtestResult?: AttrTestResult}).__attrtestResult = result
  return result
}

/**
 * Build the same material as `applyAttrTestMaterial` and run WGSL codegen, but
 * return `{wgsl, requestedAttrs}` WITHOUT pushing it to the mesh — so the
 * renderer never tries to draw the dynamic shader. Used to inspect the
 * generated WGSL / attr contract in isolation (debugging the render path).
 */
function buildAttrTestWgsl(requests: AttrTestRequest[]): {wgsl: string; requestedAttrs: unknown[]} | {error: string} {
  try {
    const app = (globalThis as {_appstate?: {ctx: {scene: unknown}}})._appstate
    const scene = app?.ctx?.scene as {lights: Iterable<unknown>} | undefined
    if (!scene) throw new Error('no active scene')

    const mat = new Material()
    const diff = new DiffuseNode()
    const output = new OutputNode()
    mat.graph.add(diff)
    mat.graph.add(output)
    diff.outputs.surface.connect(output.inputs.surface)

    requests.forEach((req, i) => {
      const node = new AttributeNode()
      node.attrName = req.name
      node.category = req.category
      mat.graph.add(node)
      switch (i % 3) {
        case 0:
          node.outputs.color.connect(diff.inputs.color)
          break
        case 1:
          node.outputs.fac.connect(diff.inputs.roughness)
          break
        default:
          node.outputs.vector.connect(diff.inputs.normal)
      }
    })

    const rlights: IRenderLights = {}
    let lid = 0
    for (const light of scene.lights) {
      ;(rlights as Record<string, unknown>)[lid++] = {light}
    }

    const def = mat.generateWgsl(scene, rlights, {}) as {wgsl: string; requestedAttrs: RequestedAttrDesc[]}
    return {wgsl: def.wgsl, requestedAttrs: def.requestedAttrs}
  } catch (err) {
    return {error: String(err)}
  }
}

interface AttrTestRoundtripResult {
  ok: boolean
  error?: string
  /** AttributeNodes recovered from the deserialized graph (name+category). */
  before: {name: string; category: number}[]
  after: {name: string; category: number}[]
  /** Length of the intermediate JSON text (proves it serialized to a string). */
  jsonLen: number
}

/**
 * Verify the M7 "test format" decision: a shader-node `Material` carrying
 * `AttributeNode`s round-trips losslessly through nstructjs JSON
 * (`writeJSON`/`readJSON`) — so a committed `.json` graph IS an adequate test
 * fixture format (no bespoke serializer needed). Builds a material with two
 * AttributeNodes, serializes the whole graph to JSON, reads it back into a
 * fresh `Material`, and reports the AttributeNode `attrName`/`category` on both
 * sides for the test to compare. Never throws — errors land in the result.
 */
function roundtripAttrTestGraph(requests: AttrTestRequest[]): AttrTestRoundtripResult {
  const result: AttrTestRoundtripResult = {ok: false, before: [], after: [], jsonLen: 0}
  try {
    const mat = new Material()
    const diff = new DiffuseNode()
    const output = new OutputNode()
    mat.graph.add(diff)
    mat.graph.add(output)
    diff.outputs.surface.connect(output.inputs.surface)

    requests.forEach((req, i) => {
      const node = new AttributeNode()
      node.attrName = req.name
      node.category = req.category
      mat.graph.add(node)
      if (i % 2 === 0) node.outputs.color.connect(diff.inputs.color)
      else node.outputs.fac.connect(diff.inputs.roughness)
    })

    const attrNodesOf = (m: Material): {name: string; category: number}[] =>
      [...m.graph.nodes]
        .filter((n): n is AttributeNode => n instanceof AttributeNode)
        .map((n) => ({name: n.attrName, category: n.category}))
        .sort((a, b) => a.name.localeCompare(b.name))

    result.before = attrNodesOf(mat)

    const json = nstructjs.writeJSON(mat)
    const text = JSON.stringify(json)
    result.jsonLen = text.length

    const restored = nstructjs.readJSON(JSON.parse(text), Material) as Material
    result.after = attrNodesOf(restored)
    result.ok = true
  } catch (err) {
    result.error = String(err)
  }
  ;(globalThis as {__attrtestRoundtripResult?: AttrTestRoundtripResult}).__attrtestRoundtripResult = result
  return result
}

;(globalThis as {__attrtestApply?: typeof applyAttrTestMaterial}).__attrtestApply = applyAttrTestMaterial
;(globalThis as {__attrtestBuildWgsl?: typeof buildAttrTestWgsl}).__attrtestBuildWgsl = buildAttrTestWgsl
;(globalThis as {__attrtestRoundtrip?: typeof roundtripAttrTestGraph}).__attrtestRoundtrip = roundtripAttrTestGraph

export {applyAttrTestMaterial, buildAttrTestWgsl, roundtripAttrTestGraph}
