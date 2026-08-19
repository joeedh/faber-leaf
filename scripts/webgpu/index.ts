/**
 * `scripts/webgpu/` — WebGPU abstraction layer used by `RealtimeEngine`
 * and the view3d overlay encode. Sits alongside the legacy WebGL stack
 * in `scripts/webgl/`, which is now only reached when the browser lacks
 * `navigator.gpu`.
 */

export {GpuContext} from './gpucontext.js'
export type {GpuContextOptions} from './gpucontext.js'

export {GpuBuffer} from './buffer.js'
export type {GpuBufferOptions, GpuBufferUsage} from './buffer.js'

export {GpuTexture, createSampler} from './texture.js'
export type {GpuTextureOptions, GpuSamplerOptions} from './texture.js'

export {RenderTarget} from './render_target.js'
export type {RenderTargetOptions} from './render_target.js'

export {Pipeline, PipelineCache} from './pipeline.js'
export type {PipelineDescriptor} from './pipeline.js'

export {BindGroupBuilder, BindGroupSlot} from './bind_group.js'
export type {BindGroupEntry} from './bind_group.js'

export {BufferUsage, TextureUsage, ShaderStage} from './flags.js'

export {WebGPUDrawQueueAdapter} from './queue_adapter.js'
export type {WebGPUFrameContext} from './queue_adapter.js'

export {WebGpuRenderContext, FULLSCREEN_QUAD_LAYOUT} from './render_context.js'
export type {WebGpuRenderContextOptions} from './render_context.js'

export {WebGpuRenderGraph} from './render_graph.js'
export type {GraphNodeRef, DispatchHooks} from './render_graph.js'

export {UniformBindings, reflectPipelineBindings} from './uniform_bindings.js'
export type {UniformBindingSlot} from './uniform_bindings.js'
