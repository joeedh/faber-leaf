/**
 * Headless verification for the litemesh texture draw path (ImmediateTODOs
 * "Make sure litemeshes with textures and uv maps draws properly"): builds a
 * cube + UV layer + a UVGRID image wired into the material through an
 * ImageNode, then checks (a) the render-mode material WGSL declares and seeds
 * the image's texture bindings and (b) the non-render frame loop installs the
 * solid-mode textured draw shader with the UV attribute. Driven by
 * `--eval "return __solidTexTest()"` through the NW.js harness; the result
 * lands in the dump as `evalResult`.
 */

import {peekAppState} from '@framework/api'
import {LiteMesh} from './litemesh'
import {ImageBlock} from '../../../../scripts/image/image'
import {ImageNode, DiffuseNode} from '../../../../scripts/shadernodes/shader_nodes'
import type {Material} from '../../../../scripts/core/material'
import {getActiveWebGpuContext} from '../../../../scripts/render/queue_factory'

interface SolidTexTestResult {
  backend: string
  error?: string
  skipped?: string
  renderWgslHasTex?: boolean
  renderSeeded?: string[]
  solidInstalled?: boolean
  solidKey?: string
  solidUniforms?: string[]
  missingAttrSlots?: number[]
  uvAttr?: string
}

async function solidTexTest(): Promise<SolidTexTestResult> {
  const g = globalThis as unknown as {
    __SCULPTCORE_BACKEND?: string
  }
  const backend = g.__SCULPTCORE_BACKEND ?? 'wasm'
  const ctx = peekAppState()?.ctx
  if (!ctx) {
    return {backend, error: 'no app context'}
  }

  ctx.api.execTool(ctx, 'litemesh.add_cube(goalFaces=294)')
  // UV layer (VERTEX domain, Float2, use=UV=4 — mirrors the Add UV button).
  ctx.api.execTool(ctx, 'litemesh.add_attr(domain=1 type=2 use=4)')

  const ob = ctx.scene.objects.active
  const mesh = ob?.data
  if (!(mesh instanceof LiteMesh)) {
    return {backend, error: 'active object is not a LiteMesh'}
  }
  const mat = mesh.materials[0] as Material | undefined
  if (!mat) {
    return {backend, error: 'no default material'}
  }

  // UVGRID test image (the default genType) + an ImageNode wired into the
  // diffuse color so the render-mode WGSL actually samples it.
  const img = new ImageBlock()
  ctx.datalib.add(img)
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
  if (!diffuse) {
    return {backend, error: 'default material has no DiffuseNode'}
  }
  imageNode.outputs.color.connect(diffuse.inputs.color)
  ;(mat as unknown as {_regen: boolean})._regen = true

  // (a) Render-mode contract: the material WGSL declares the image bindings
  // and setTextureUniforms seeds view + sampler once the device exists.
  const deadline = performance.now() + 15000
  while (!getActiveWebGpuContext()?.device) {
    if (performance.now() > deadline) {
      return {backend, skipped: 'WebGPU device never initialized'}
    }
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  }
  const device = getActiveWebGpuContext()!.device

  const def = mat.generateWgsl(ctx.scene, {})
  const texName = `sampler_${img.lib_id}_tex`
  const renderWgslHasTex = def.wgsl.includes(texName)
  const seeded: Record<string, unknown> = {}
  def.generator.setTextureUniforms(device, seeded)
  const renderSeeded = Object.keys(seeded).filter((k) => seeded[k] !== undefined)

  // (b) Solid-mode: let the frame loop run so updateSolidTexturedDrawShader
  // installs the textured draw shader.
  const w = window as Window & {redraw_viewport: (all?: boolean) => void}
  const solidDeadline = performance.now() + 15000
  const meshAny = mesh as unknown as {_solidTexKey?: string; solidTexUniforms?: Record<string, unknown>}
  while (!meshAny._solidTexKey) {
    if (performance.now() > solidDeadline) {
      break
    }
    w.redraw_viewport(true)
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  }

  const uvItem = mesh.attrItems.find((it) => (it.use & 4) !== 0)

  return {
    backend,
    renderWgslHasTex,
    renderSeeded,
    solidInstalled  : (mesh as unknown as {_hasMaterialDrawShader: boolean})._hasMaterialDrawShader,
    solidKey        : meshAny._solidTexKey,
    solidUniforms   : Object.keys(meshAny.solidTexUniforms ?? {}),
    missingAttrSlots: mesh.getMissingAttrSlots(),
    uvAttr          : uvItem?.attrName,
  }
}

;(globalThis as unknown as {__solidTexTest?: () => Promise<SolidTexTestResult>}).__solidTexTest = solidTexTest
