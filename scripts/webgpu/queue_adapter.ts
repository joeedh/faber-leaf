/**
 * DrawQueue backend that records into a `GPUCommandEncoder` /
 * `GPURenderPassEncoder`. Parallel to `WebGLDrawQueueAdapter` in
 * `scripts/render/queue.ts`.
 *
 * `scheduleRawGLPass` intentionally throws — the texpaint shim is the
 * only legitimate caller on the WebGPU backend, and it goes through
 * its own readPixels → writeTexture bridge.
 */

import type {DrawQueue, FrameContext, Submission} from '../render/queue.js'
import type {IUniformsBlock} from '../webgl/webgl.js'
import type {Pipeline, PipelineCache, PipelineDescriptor} from './pipeline.js'
import {applySurfaceFormat, markInstancedPointSprite} from './pipeline.js'
import {buildPipelineDescriptor, lookupWgslShader} from '../shaders/wgsl_shaders.js'
import {BufferUsage} from './flags.js'
import {PrimitiveTypes} from '../webgl/primitive_types.js'
import {UniformBindings} from './uniform_bindings.js'

/**
 * Submissions tagged with the WebGL-side MeshEditShader need to swap to a
 * different WGSL pipeline when the mesh's primflag is POINTS — WebGPU has
 * no `gl_PointSize` equivalent, so vertex points become invisible 1-px
 * dots under the standard triangle-list MeshEditShader. The point variant
 * declares instance-stepped vertex buffers and expands each point into a
 * 6-vertex billboard quad.
 */
const POINT_SPRITE_REMAP: Record<string, string> = {
  MeshEditShader: 'MeshEditPointShader',
}

export interface WebGPUFrameContext extends FrameContext {
  device: GPUDevice
  encoder: GPUCommandEncoder
  passEncoder: GPURenderPassEncoder
  pipelineCache: PipelineCache
  // Maps the WebGL-side `ShaderProgram` identity in `Submission.pipeline`
  // to the cached WebGPU `Pipeline`.
  pipelineBindings: Map<unknown, Pipeline>
  // Surface format the canvas pass actually targets — used to rewrite
  // the registry's default color target so the pipeline matches the
  // open render pass attachment.
  surfaceFormat?: GPUTextureFormat
}

const uniformBindingsByPipeline = new WeakMap<Pipeline, UniformBindings>()

function getUniformBindings(device: GPUDevice, pipeline: Pipeline): UniformBindings {
  let bindings = uniformBindingsByPipeline.get(pipeline)
  if (!bindings) {
    bindings = new UniformBindings(device, pipeline.descriptor.wgsl, pipeline.descriptor.label)
    uniformBindingsByPipeline.set(pipeline, bindings)
  }
  return bindings
}

/**
 * One zero-filled vertex buffer per device, bound to any pipeline slot the
 * drawn mesh doesn't supply. Lets pipelines declare a fixed vertex-buffer
 * layout (positional `WGSL_VERTEX_SLOTS`) without forcing every drawable to
 * upload a NORMAL/UV/COLOR/ID buffer it doesn't actually use — the WGSL
 * shader still reads zeros from the missing attribute, which the fragment
 * stage discards or treats as a sensible default. Sized at 1 MiB which
 * covers ~65k vertices at stride 16; if a mesh exceeds that it will hit
 * a WebGPU validation error and we can grow this.
 */
const DUMMY_VERTEX_BUFFER_SIZE = 1024 * 1024
const dummyVertexBufferByDevice = new WeakMap<GPUDevice, GPUBuffer>()

/**
 * Mesh-primflag → pipeline topology. SimpleIsland.drawGPU at the WebGL
 * level dispatches a single primtype per island; we need a matching
 * pipeline variant on WebGPU because the registered shader entry typically
 * declares `triangle-list`. Returns `undefined` when the registered
 * topology should be used as-is (TRIS, mixed/unknown, or no primflag).
 *
 * POINTS deliberately falls through to undefined: point primitives are
 * routed via the `POINT_SPRITE_REMAP` shader swap (above) into a separate
 * triangle-list pipeline that expands each point into a screen-space
 * billboard quad. WebGPU's native `point-list` is 1 px only.
 */
function topologyForMesh(mesh: unknown): GPUPrimitiveTopology | undefined {
  const flag = (mesh as {primflag?: number}).primflag
  if (flag === undefined) return undefined
  if (flag === PrimitiveTypes.LINES) return 'line-list'
  return undefined
}

function pointSpriteRemapKeyFor(s: Submission): string | undefined {
  const flag = (s.mesh as {primflag?: number}).primflag
  if (flag !== PrimitiveTypes.POINTS) return undefined
  const key = (s.pipeline as unknown as {wgslKey?: string}).wgslKey
  return key ? POINT_SPRITE_REMAP[key] : undefined
}

// Lazily caches a non-tri topology variant of a base pipeline. Triggered
// the first time a verts/edges ChunkedSimpleMesh submits through a
// triangle-list-registered ShaderProgram (MeshEditShader, etc.). Each
// (base pipeline, topology) pair is cached so subsequent submissions hit
// the underlying `PipelineCache` and not a fresh pipeline build.
const topologyVariantsByBase = new WeakMap<Pipeline, Map<GPUPrimitiveTopology, Pipeline>>()

function getTopologyVariant(cache: PipelineCache, base: Pipeline, topology: GPUPrimitiveTopology): Pipeline {
  const baseTopology = base.descriptor.primitive?.topology ?? 'triangle-list'
  if (baseTopology === topology) return base
  let variants = topologyVariantsByBase.get(base)
  if (!variants) {
    variants = new Map()
    topologyVariantsByBase.set(base, variants)
  }
  let variant = variants.get(topology)
  if (!variant) {
    const desc: PipelineDescriptor = {
      ...base.descriptor,
      primitive: {...(base.descriptor.primitive ?? {}), topology},
    }
    variant = cache.get(desc)
    variants.set(topology, variant)
  }
  return variant
}

function getDummyVertexBuffer(device: GPUDevice): GPUBuffer {
  let buf = dummyVertexBufferByDevice.get(device)
  if (!buf) {
    buf = device.createBuffer({
      label           : 'WebGPUDrawQueueAdapter.dummyVertexBuffer',
      size            : DUMMY_VERTEX_BUFFER_SIZE,
      usage           : BufferUsage.VERTEX,
      mappedAtCreation: true,
    })
    new Uint8Array(buf.getMappedRange()).fill(0)
    buf.unmap()
    dummyVertexBufferByDevice.set(device, buf)
  }
  return buf
}

export class WebGPUDrawQueueAdapter implements DrawQueue {
  readonly frame: WebGPUFrameContext

  constructor(frame: WebGPUFrameContext) {
    this.frame = frame
  }

  submit(s: Submission): void {
    // Resolve the pipeline. The fast path is the program-keyed cache the
    // material BasePass populates per-frame. Point-sprite-remapped
    // submissions skip the cache because the WebGL ShaderProgram identity
    // (e.g. MeshEditShader) maps to a *different* WebGPU pipeline per
    // primtype — caching by program alone would collide with the TRIS/LINES
    // submissions that share the same program.
    let pipeline: Pipeline | undefined
    const pointSpriteKey = pointSpriteRemapKeyFor(s)
    if (pointSpriteKey) {
      const entry = lookupWgslShader(pointSpriteKey)
      if (!entry) {
        throw new Error(`WebGPUDrawQueueAdapter: point-sprite remap target "${pointSpriteKey}" not registered.`)
      }
      pipeline = this.frame.pipelineCache.get(
        applySurfaceFormat(buildPipelineDescriptor(entry), this.frame.surfaceFormat)
      )
      markInstancedPointSprite(pipeline.handle)
    } else {
      pipeline = this.frame.pipelineBindings.get(s.pipeline)
    }
    if (!pipeline) {
      // Fall back to the registry: a ShaderProgram tagged with `.wgslKey`
      // resolves directly into a pipeline descriptor, no per-frame
      // wiring required.
      const key = (s.pipeline as unknown as {wgslKey?: string}).wgslKey
      const entry = key ? lookupWgslShader(key) : undefined
      if (!entry) {
        const name = (s.pipeline as unknown as {name?: string}).name ?? '<unknown>'
        throw new Error(
          `WebGPUDrawQueueAdapter: pipeline "${name}" not yet ported to WGSL — ` +
            `tag the ShaderProgram with .wgslKey or register it in ` +
            `frame.pipelineBindings.`
        )
      }
      const desc = applySurfaceFormat(buildPipelineDescriptor(entry), this.frame.surfaceFormat)
      pipeline = this.frame.pipelineCache.get(desc)
      this.frame.pipelineBindings.set(s.pipeline, pipeline)
    }
    // Edges (LINES primflag through MeshEditShader / LineShader) need a
    // line-list variant of the triangle-list pipeline. POINTS falls
    // through to the point-sprite remap above instead.
    const topology = topologyForMesh(s.mesh)
    if (topology) {
      pipeline = getTopologyVariant(this.frame.pipelineCache, pipeline, topology)
    }
    if (!s.mesh.drawGPU) {
      const meshName = (s.mesh as unknown as {constructor?: {name?: string}}).constructor?.name ?? '<unknown>'
      throw new Error(
        `WebGPUDrawQueueAdapter: mesh "${meshName}" has no drawGPU() — ` +
          `implement Drawable.drawGPU(pass, pipeline, uniforms).`
      )
    }
    // SimpleMesh / SimpleIsland exposes `_uploadGpuBuffers(device)`; other
    // Drawable implementers manage their own uploads internally.
    const uploader = (s.mesh as unknown as {_uploadGpuBuffers?: (device: GPUDevice) => void})._uploadGpuBuffers
    if (uploader) uploader.call(s.mesh, this.frame.device)
    // Legacy ShaderProgram-style call sites stash per-draw values on
    // `program.uniforms` (Light.drawQ sets `color` there) instead of
    // threading them through `Submission.uniforms`. Merge that bag in
    // first so the WebGPU bindings see the same final value the WebGL
    // bind would.
    const pipelineUniforms = (s.pipeline as unknown as {uniforms?: IUniformsBlock}).uniforms
    const uniforms: IUniformsBlock = pipelineUniforms
      ? {...pipelineUniforms, ...this.frame.uniforms, ...(s.uniforms ?? {})}
      : s.uniforms ?? this.frame.uniforms
    this.frame.passEncoder.setPipeline(pipeline.handle)
    const bindings = getUniformBindings(this.frame.device, pipeline)
    if (!bindings.isEmpty) {
      bindings.bind(this.frame.passEncoder, pipeline.handle, uniforms)
    }
    // Pre-bind a shared zero buffer to every non-null pipeline slot.
    // `drawGPU` overwrites slots the mesh actually provides; slots the
    // pipeline declares but the mesh lacks stay bound to the zero buffer
    // so WebGPU validation passes.
    const dummy = getDummyVertexBuffer(this.frame.device)
    const slots = pipeline.descriptor.vertexBuffers
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) this.frame.passEncoder.setVertexBuffer(i, dummy)
    }
    s.mesh.drawGPU(this.frame.passEncoder, pipeline.handle, uniforms)
  }

  scheduleRawGLPass(): void {
    throw new Error(
      'WebGPUDrawQueueAdapter: scheduleRawGLPass is WebGL-only. The texpaint shim ' +
        'bridges through readPixels → writeTexture instead.'
    )
  }
}
