/**
 * Immutable render pipeline objects keyed by (wgsl-hash, vertex-layout,
 * target-format, blend-state, primitive topology). WebGPU equivalent of
 * `ShaderProgram` in `scripts/webgl/webgl.ts:442-1150`, with the major
 * mental shift that state which varies per-draw goes into a separate
 * pipeline variant.
 */

export interface PipelineDescriptor {
  label?: string
  wgsl: string
  vertexEntry?: string
  fragmentEntry?: string
  vertexBuffers: (GPUVertexBufferLayout | null)[]
  colorTargets: GPUColorTargetState[]
  depthStencil?: GPUDepthStencilState
  primitive?: GPUPrimitiveState
  multisample?: GPUMultisampleState
  bindGroupLayouts?: GPUBindGroupLayout[]
}

export class Pipeline {
  readonly handle: GPURenderPipeline
  readonly module: GPUShaderModule
  readonly descriptor: PipelineDescriptor
  readonly cacheKey: string

  constructor(device: GPUDevice, desc: PipelineDescriptor, cacheKey: string) {
    this.descriptor = desc
    this.cacheKey = cacheKey

    this.module = device.createShaderModule({
      label: desc.label ? `${desc.label}.module` : undefined,
      code : desc.wgsl,
    })

    const layout: GPUPipelineLayout | 'auto' = desc.bindGroupLayouts
      ? device.createPipelineLayout({
          label           : desc.label ? `${desc.label}.layout` : undefined,
          bindGroupLayouts: desc.bindGroupLayouts,
        })
      : 'auto'

    this.handle = device.createRenderPipeline({
      label: desc.label,
      layout,
      vertex: {
        module    : this.module,
        entryPoint: desc.vertexEntry ?? 'vs_main',
        buffers   : desc.vertexBuffers,
      },
      fragment: {
        module    : this.module,
        entryPoint: desc.fragmentEntry ?? 'fs_main',
        targets   : desc.colorTargets,
      },
      depthStencil: desc.depthStencil,
      primitive   : desc.primitive ?? {topology: 'triangle-list'},
      multisample : desc.multisample,
    })
  }
}

// WGSL source contributes to the key, so a `#define` variant produces a
// distinct entry (defines are expanded upstream of this point).
function hashDescriptor(desc: PipelineDescriptor): string {
  const parts = [
    desc.wgsl,
    desc.vertexEntry ?? 'vs_main',
    desc.fragmentEntry ?? 'fs_main',
    JSON.stringify(desc.vertexBuffers),
    JSON.stringify(desc.colorTargets),
    JSON.stringify(desc.depthStencil ?? null),
    JSON.stringify(desc.primitive ?? null),
    JSON.stringify(desc.multisample ?? null),
  ]
  return parts.join('|')
}

/**
 * Marks a pipeline as expecting point-sprite-style instanced expansion:
 * vertex buffers are instance-stepped and `@builtin(vertex_index)` 0..5
 * enumerates the corners of a screen-space quad per primitive. The mesh
 * draw path uses this signal to switch its POINTS dispatch from
 * `pass.draw(totpoint, 1, 0, 0)` to `pass.draw(6, totpoint, 0, 0)` so
 * the legacy `GL_POINTS + gl_PointSize` mesh-edit verts get a sized
 * splat on WebGPU (the native `point-list` topology is 1 px only).
 *
 * Set by the `WebGPUDrawQueueAdapter` after resolving a point-sprite
 * pipeline variant; read by `SimpleIsland.drawGPU`. Lives here rather
 * than in queue_adapter.ts to avoid the simplemesh ↔ queue_adapter
 * import cycle.
 */
const instancedPointSpritePipelines = new WeakSet<GPURenderPipeline>()

export function markInstancedPointSprite(handle: GPURenderPipeline): void {
  instancedPointSpritePipelines.add(handle)
}

export function isInstancedPointSprite(handle: GPURenderPipeline): boolean {
  return instancedPointSpritePipelines.has(handle)
}

/**
 * The registry color targets default to `'bgra8unorm'`, but Chrome on
 * some platforms prefers `'rgba8unorm'` for the canvas. Rewrite the
 * interchangeable 8-bit unorm formats so they match the open canvas
 * pass. Other formats (e.g. `'rgba32float'` for ID picking) pass
 * through unchanged.
 *
 * Pure — no device or `this` access. Live callers pass
 * `WebGpuRenderContext.surfaceFormat` as the second argument.
 */
const SURFACE_INTERCHANGEABLE: ReadonlySet<GPUTextureFormat> = new Set<GPUTextureFormat>(['bgra8unorm', 'rgba8unorm'])
export function applySurfaceFormat(
  desc: PipelineDescriptor,
  surfaceFormat: GPUTextureFormat | undefined
): PipelineDescriptor {
  if (!surfaceFormat) return desc
  return {
    ...desc,
    colorTargets: desc.colorTargets.map((t) =>
      SURFACE_INTERCHANGEABLE.has(t.format) ? {...t, format: surfaceFormat} : t
    ),
  }
}

export class PipelineCache {
  private readonly device: GPUDevice
  private readonly entries = new Map<string, Pipeline>()

  constructor(device: GPUDevice) {
    this.device = device
  }

  get(desc: PipelineDescriptor): Pipeline {
    const key = hashDescriptor(desc)
    let pipeline = this.entries.get(key)
    if (!pipeline) {
      pipeline = new Pipeline(this.device, desc, key)
      this.entries.set(key, pipeline)
    }
    return pipeline
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
