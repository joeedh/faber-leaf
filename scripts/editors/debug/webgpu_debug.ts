/**
 * Per-device singleton for the FBO debug editor's WebGPU capture
 * registry. Mirrors a captured `GPUTexture` into a persistent
 * `GpuTexture` ring buffer keyed by name, so the editor can blit it to
 * its region in a later render pass.
 *
 * Capture sites call `pushTexture(name, sourceTex, encoder)` while a
 * `GPUCommandEncoder` is open — currently just the view3d canvas pass
 * in `view3d_draw_webgpu.ts`. The capture is a
 * `copyTextureToTexture()`, so the source texture must have `COPY_SRC`
 * in its usage (see `GpuContext.create` in `scripts/webgpu/gpucontext.ts`
 * for the canvas configure, and pre-existing `RenderTarget` colors which
 * already include `COPY_SRC` in `render_target.ts:40`).
 */

import {GpuTexture, createSampler} from '../../webgpu/texture.js'
import {TextureUsage, BufferUsage} from '../../webgpu/flags.js'
import {GpuBuffer} from '../../webgpu/buffer.js'
import {buildDebugDisplayDescriptor, writeDebugUniforms, DEBUG_UNIFORMS_SIZE} from './debug_display_wgsl.js'
import type {WebGpuViewport} from '../view3d/view3d_draw_webgpu.js'
import {peekAppState} from '../../core/app_instance.js'

export class GpuTextureHistory {
  readonly max: number
  private entries: GpuTexture[] = []

  constructor(max = 5) {
    this.max = max
  }

  get length(): number {
    return this.entries.length
  }

  get head(): GpuTexture | undefined {
    return this.entries[this.entries.length - 1]
  }

  at(i: number): GpuTexture | undefined {
    return this.entries[i]
  }

  pushCopy(device: GPUDevice, encoder: GPUCommandEncoder, source: GPUTexture, label: string): GpuTexture {
    let dest: GpuTexture | undefined
    if (this.entries.length >= this.max) {
      dest = this.entries.shift()
    }
    if (!dest || dest.width !== source.width || dest.height !== source.height || dest.format !== source.format) {
      dest?.destroy()
      dest = new GpuTexture(device, {
        label,
        width : source.width,
        height: source.height,
        format: source.format,
        usage : TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
      })
    }
    encoder.copyTextureToTexture(
      {texture: source},
      {texture: dest.handle},
      {width: source.width, height: source.height, depthOrArrayLayers: 1}
    )
    this.entries.push(dest)
    return dest
  }

  clear(): void {
    for (const e of this.entries) e.destroy()
    this.entries.length = 0
  }
}

export class WebGpuDebug {
  readonly device: GPUDevice
  readonly fbos: Record<string, GpuTextureHistory> = {}

  constructor(device: GPUDevice) {
    this.device = device
  }

  get debugEditorOpen(): boolean {
    const sareas = peekAppState()?.screen?.sareas
    if (!sareas) return false
    for (const sarea of sareas) {
      const cls = sarea.area?.constructor as {define?: () => {areaname: string}} | undefined
      const def = cls?.define?.()
      if (def?.areaname === 'DebugEditor') return true
    }
    return false
  }

  pushTexture(name: string, source: GPUTexture, encoder: GPUCommandEncoder, onlyIfDebugEditor = true): void {
    if (onlyIfDebugEditor && !this.debugEditorOpen) return
    let history = this.fbos[name]
    if (!history) {
      history = new GpuTextureHistory()
      this.fbos[name] = history
    }
    history.pushCopy(this.device, encoder, source, `webgpu_debug.${name}`)
  }

  dispose(): void {
    for (const k in this.fbos) this.fbos[k].clear()
  }
}

let singleton: WebGpuDebug | undefined

export function getWebGpuDebug(device: GPUDevice): WebGpuDebug {
  if (!singleton || singleton.device !== device) {
    singleton?.dispose()
    singleton = new WebGpuDebug(device)
  }
  return singleton
}

export function peekWebGpuDebug(): WebGpuDebug | undefined {
  return singleton
}

// Per-editor reusable WebGPU resources for the blit pass.
export interface DebugEditorWebGpuResources {
  sampler: GPUSampler
  uniformBuffer: GpuBuffer
  // Bind groups are keyed by the underlying captured GpuTexture so that
  // re-sampling the same capture across frames doesn't allocate a new
  // group each draw.
  bindGroups: WeakMap<GpuTexture, GPUBindGroup>
}

export function createDebugEditorResources(device: GPUDevice): DebugEditorWebGpuResources {
  return {
    sampler      : createSampler(device, {magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'nearest'}),
    uniformBuffer: new GpuBuffer(device, {
      label: 'debug-editor.uniforms',
      size : DEBUG_UNIFORMS_SIZE,
      usage: 'uniform',
    }),
    bindGroups   : new WeakMap(),
  }
}

/**
 * Encode + submit the debug-display blit pass.
 *
 *  - `region` is in canvas pixel coords (origin bottom-left, matching
 *    the WebGL editor's `glPos`/`glSize` convention). We flip Y to
 *    WebGPU's origin-top-left here, so the editor's region lands in
 *    the right rectangle on screen.
 *  - The render pass uses `loadOp: 'load'` so view3d's already-rendered
 *    canvas content is preserved outside the editor's scissor.
 */
export function drawDebugEditorBlit(
  viewport: WebGpuViewport,
  resources: DebugEditorWebGpuResources,
  source: GpuTexture,
  region: {x: number; y: number; w: number; h: number},
  mode: number,
  valueScale: number
): void {
  const {device} = viewport.gpu
  const wgpu = viewport.ctx

  writeDebugUniforms(device, resources.uniformBuffer.handle, mode, valueScale)

  const pipeline = wgpu.pipelineCache.get(buildDebugDisplayDescriptor(viewport.gpu.surfaceFormat))

  let bindGroup = resources.bindGroups.get(source)
  if (!bindGroup) {
    bindGroup = device.createBindGroup({
      label  : 'debug-editor.bindGroup',
      layout : pipeline.handle.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: resources.sampler},
        {binding: 1, resource: source.view},
        {binding: 2, resource: {buffer: resources.uniformBuffer.handle}},
      ],
    })
    resources.bindGroups.set(source, bindGroup)
  }

  const canvasTex = viewport.gpu.canvasContext.getCurrentTexture()
  const surfaceW = canvasTex.width
  const surfaceH = canvasTex.height

  // Convert region from origin-bottom-left (WebGL convention used by
  // DebugEditor.drawStart) to WebGPU's origin-top-left.
  const x = clamp(region.x | 0, 0, surfaceW)
  const yTop = clamp(surfaceH - ((region.y | 0) + (region.h | 0)), 0, surfaceH)
  const w = clamp(region.w | 0, 0, surfaceW - x)
  const h = clamp(region.h | 0, 0, surfaceH - yTop)
  if (w === 0 || h === 0) return

  const encoder = device.createCommandEncoder({label: 'debug-editor.encoder'})
  const pass = encoder.beginRenderPass({
    label           : 'debug-editor.pass',
    colorAttachments: [
      {
        view   : canvasTex.createView(),
        loadOp : 'load',
        storeOp: 'store',
      },
    ],
  })
  pass.setPipeline(pipeline.handle)
  pass.setBindGroup(0, bindGroup)
  pass.setVertexBuffer(0, wgpu.fullscreenQuad.handle)
  pass.setViewport(x, yTop, w, h, 0, 1)
  pass.setScissorRect(x, yTop, w, h)
  pass.draw(6, 1, 0, 0)
  pass.end()

  device.queue.submit([encoder.finish()])
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// Avoid unused-import warning when consumers only need the type.
void BufferUsage
