/**
 * `createDrawQueue` — chooses the WebGL or WebGPU `DrawQueue` adapter
 * based on `getRenderer()`. The call sites in `sceneobject.ts` and
 * `view3d_draw.ts` route through this factory instead of constructing
 * `WebGLDrawQueueAdapter` directly so the backend swap is a one-line
 * change once the WebGPU stack is initialized.
 *
 * The WebGPU branch requires a process-wide `WebGpuRenderContext` to
 * have been registered via `setActiveWebGpuContext` — the render
 * engine sets this once at boot when the user has flipped the
 * `?renderer=webgpu` flag (and `navigator.gpu` is available).
 *
 * If WebGPU is selected but no active context is registered, the
 * factory falls back to WebGL with a one-time console warning rather
 * than throwing — keeps a stale URL param from bricking the app.
 */

import {WebGLDrawQueueAdapter, type DrawQueue, type FrameContext} from './queue.js'
import {WebGPUDrawQueueAdapter, type WebGPUFrameContext} from '../webgpu/queue_adapter.js'
import type {WebGpuRenderContext} from '../webgpu/render_context.js'
import {isWebGPU} from '../core/renderer_flag.js'

let activeCtx: WebGpuRenderContext | undefined
let warnedNoCtx = false

/** Register the process-wide `WebGpuRenderContext` — call once at
 *  render-engine init when WebGPU is selected. */
export function setActiveWebGpuContext(ctx: WebGpuRenderContext | undefined): void {
  activeCtx = ctx
  warnedNoCtx = false
}

export function getActiveWebGpuContext(): WebGpuRenderContext | undefined {
  return activeCtx
}

/**
 * Build a `DrawQueue` for the active backend. The WebGL adapter wraps
 * `frame` directly; the WebGPU adapter pulls the open command encoder
 * and pass encoder off the registered `WebGpuRenderContext`.
 */
export function createDrawQueue(frame: FrameContext): DrawQueue {
  if (!isWebGPU()) {
    return new WebGLDrawQueueAdapter(frame)
  }

  const ctx = activeCtx
  if (!ctx?.encoder) {
    if (!warnedNoCtx) {
      console.warn(
        'createDrawQueue: WebGPU selected but no active WebGpuRenderContext is open — ' +
          'falling back to WebGL. Did the render engine forget to call setActiveWebGpuContext + ctx.beginFrame?'
      )
      warnedNoCtx = true
    }
    return new WebGLDrawQueueAdapter(frame)
  }

  // The caller must have already opened a render pass against the
  // target. We pull the current pass encoder off the context — the
  // shared mutable slot is the WebGPU equivalent of "gl is global".
  const passEncoder = (ctx as unknown as {currentPass?: GPURenderPassEncoder}).currentPass
  if (!passEncoder) {
    if (!warnedNoCtx) {
      console.warn(
        'createDrawQueue: WebGpuRenderContext has no open pass — falling back to WebGL. ' +
          'Wrap draw dispatch in ctx.renderStage(...) so currentPass is set.'
      )
      warnedNoCtx = true
    }
    return new WebGLDrawQueueAdapter(frame)
  }

  const gpuFrame: WebGPUFrameContext = {
    gl      : frame.gl,
    uniforms: frame.uniforms,
    program : frame.program,
    device  : ctx.device,
    encoder : ctx.encoder,
    passEncoder,
    pipelineCache   : ctx.pipelineCache,
    pipelineBindings: ctx.pipelineBindings,
    surfaceFormat   : ctx.surfaceFormat,
  }
  return new WebGPUDrawQueueAdapter(gpuFrame)
}
