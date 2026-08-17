/**
 * Batch executor for the WebGPU backend — uploads wasm-owned `Buffer`s
 * into `GpuBuffer`s, caches a pipeline per shader, encodes draw calls
 * from a `DrawBatch` into a `GPURenderPassEncoder`. Parallel of
 * `WebGLBatchExecutor` in `scripts/webgl/batch.ts`.
 *
 *   * No VAO — vertex buffers are bound per-draw on the pass.
 *   * No attribute lookup by name — sculptcore's `ShaderDef.attrs`
 *     order is the source of truth for the matching `@location(n)`
 *     slots in WGSL.
 *   * Pipelines are immutable: every (shader, vertex layout, target
 *     format, blend, primitive) combination is its own
 *     `GPURenderPipeline`. The cache keys on sdef pointer + topology
 *     since the rest is fixed per executor instance.
 *   * Uniforms aren't bound by name — the caller supplies a
 *     `bindGroupForCommand` callback returning a ready `GPUBindGroup`.
 *
 * The wasm-side `ShaderDef` still carries GLSL sources used by the WebGL
 * fallback; this executor consumes the WGSL equivalent via the
 * `wgslForShader(sdef)` lookup the caller provides.
 */

import {Buffer, DrawBatch, DrawCommand, ShaderDef} from '@sculptcore/api'
import {} from '@litestl/typescript-runtime'
import {GPUType} from '@sculptcore/api/sculptcore/gpu/GPUType'
import {GPUCmdType} from '@sculptcore/api/sculptcore/gpu/GPUCmdType'
import {IWasmInterface} from '@sculptcore/api/api'

import {VertexScalarType, buildVertexBufferLayout, type VertexAttrDesc} from '../core/vertex_layout.js'

import {GpuBuffer, GpuBufferUsage} from './buffer.js'
import {Pipeline, PipelineCache, type PipelineDescriptor} from './pipeline.js'

interface BoundLike {
  ptr: number
}

interface CachedGpuBuffer {
  buf: GpuBuffer
  uploadedSize: number
  uploadedDataPtr: number
}

function gpuTypeBytes(t: GPUType): number {
  switch (t) {
    case GPUType.FLOAT16:
    case GPUType.INT16:
    case GPUType.UINT16:
      return 2
    case GPUType.FLOAT32:
    case GPUType.INT32:
    case GPUType.UINT32:
      return 4
    case GPUType.FLOAT64:
      return 8
    case GPUType.INT8:
    case GPUType.UINT8:
      return 1
    default:
      return 4
  }
}

/** sculptcore's buffer element type in the contract's vertex-fetch vocabulary
 * (`core/vertex_layout.ts`), which owns the format/stride tables from there. */
function gpuTypeToVertexScalar(t: GPUType): VertexScalarType {
  switch (t) {
    case GPUType.FLOAT32:
      return VertexScalarType.FLOAT32
    case GPUType.FLOAT16:
      return VertexScalarType.FLOAT16
    case GPUType.UINT8:
      return VertexScalarType.UNORM8
    case GPUType.UINT16:
      return VertexScalarType.UINT16
    case GPUType.UINT32:
      return VertexScalarType.UINT32
    case GPUType.INT32:
      return VertexScalarType.SINT32
    default:
      return VertexScalarType.FLOAT32
  }
}

function cmdTypeToTopology(t: GPUCmdType): GPUPrimitiveTopology {
  switch (t) {
    case GPUCmdType.DRAW_TRIS:
      return 'triangle-list'
    case GPUCmdType.DRAW_TRI_STRIP:
      return 'triangle-strip'
    case GPUCmdType.DRAW_LINES:
      return 'line-list'
    case GPUCmdType.DRAW_POINTS:
      return 'point-list'
    default:
      return 'triangle-list'
  }
}

/**
 * Color-attachment locations the WGSL fragment entry point (`fs_main`) writes:
 * an inline `-> @location(n) vec4f` return, or every `@location(n)` member of
 * its FsOut-style return struct. Used to pad the pipeline's color targets with
 * `writeMask: 0` for pass attachments the shader does not write (e.g. a
 * 1-output overlay shader drawn inside the 3-attachment SSS MRT BasePass).
 */
export function fragmentOutputLocations(wgsl: string): Set<number> {
  const locs = new Set<number>()
  const fm = /@fragment\s+fn\s+\w+\s*\(([\s\S]*?)\)\s*->\s*([^{]+)\{/.exec(wgsl)
  if (!fm) {
    locs.add(0)
    return locs
  }
  const ret = fm[2].trim()
  const inline = /^@location\(\s*(\d+)\s*\)/.exec(ret)
  if (inline) {
    locs.add(parseInt(inline[1], 10))
    return locs
  }
  const structName = ret.split(/\s+/)[0]
  const sm = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`).exec(wgsl)
  if (!sm) {
    locs.add(0)
    return locs
  }
  for (const m of sm[1].matchAll(/@location\(\s*(\d+)\s*\)/g)) {
    locs.add(parseInt(m[1], 10))
  }
  return locs
}

/** One `@group(n)` → `GPUBindGroup` binding the dispatch loop will set. */
export interface CommandBindGroup {
  group: number
  bindGroup: GPUBindGroup
}

export interface WebGPUBatchExecutorOptions {
  device: GPUDevice
  wasm: IWasmInterface
  pipelineCache?: PipelineCache
  wgslForShader: (sdef: ShaderDef) => string
  // Returns the bind group(s) the WGSL source declares, or `null` to skip this
  // draw command (the dispatch loop continues with the rest of the batch rather
  // than aborting the whole pass — see the "never throw on the render seam"
  // note: a throw here is swallowed as a drawObjects warning). A bare
  // `GPUBindGroup` is shorthand for `@group(0)`; return a `CommandBindGroup[]`
  // when the shader spans several groups (e.g. a material's frame/light/object
  // groups), and every entry is bound before the draw.
  bindGroupForCommand: (cmd: DrawCommand, pipeline: Pipeline) => GPUBindGroup | CommandBindGroup[] | null
  colorTargets: GPUColorTargetState[]
  depthStencil?: GPUDepthStencilState
  /** Usage for the cached vertex buffers (default `['vertex']`). LiteMesh
   * passes `['vertex','storage']` so the GPU brush stroke's scatter pass can
   * write node VBOs in place (gpuGlobalBrushes.md M3/D4). */
  bufferUsage?: GpuBufferUsage[]
  /** Triangle cull mode baked into this executor's pipelines (default 'none').
   * LiteMesh rebuilds its surface executor when the backface-cull flag flips. */
  cullMode?: GPUCullMode
}

/** Per-frame dispatch options. */
export interface DispatchOptions {
  /** Clip-space transform (16 floats, column-major `proj*object`) for frustum
   * culling against the batch's per-command AABBs (`DrawBatch.cmdAabbs`).
   * Omit to draw every command. */
  cullMatrix?: ArrayLike<number>
}

/** Cached per-command dispatch state (normalized once per batch version). */
interface CachedCommand {
  cmd: DrawCommand
  /** Index into the batch's original `commands` vector (keys `cmdAabbs`). */
  srcIndex: number
  pipeline: Pipeline
  /** Vertex buffers by shader slot (`null` = slot unused by this command). */
  vbufs: ({slot: number; engineBuf: Buffer; gpu: GpuBuffer} | null)[]
  count: number
  start: number
}

interface BatchCache {
  version: number
  aabbVersion: number
  targetsKey: string
  entries: CachedCommand[]
  /** Unique engine buffers across entries (for the dirty-flush walk). */
  engineBufs: Buffer[]
  /** 6 floats per entry (min.xyz, max.xyz); null = producer doesn't cull. */
  aabbs: Float32Array | null
  visible: Uint8Array
  visibleKey: number
  bundle: GPURenderBundle | null
  /** Bind-group identities the bundle was encoded with (per pipeline), so a
   * resource-group identity change (fresh texture views) re-encodes. */
  bundleBindGroups: GPUBindGroup[]
}

export class WebGPUBatchExecutor {
  readonly device: GPUDevice
  readonly queue: GPUQueue
  readonly wasm: IWasmInterface
  readonly pipelineCache: PipelineCache
  private readonly bufferCache = new Map<number, CachedGpuBuffer>()
  private readonly pipelinesByShader = new Map<string, Pipeline>()
  /** Per-batch dispatch caches keyed on the batch's stable identity; entries
   * rebuild when `DrawBatch.version` (or the target formats) change. Bounded —
   * overlay batches are recreated wholesale, so old keys age out FIFO. */
  private readonly batchCaches = new Map<number, BatchCache>()
  private readonly opts: WebGPUBatchExecutorOptions
  // Mutable color-target state — the same executor can draw into passes of
  // different attachment formats (offscreen rgba16float vs the canvas
  // surface format), so the format is settable per-frame and folded into
  // the pipeline cache key. Buffer uploads stay shared across formats.
  private colorTargets: GPUColorTargetState[]
  // Shaders we've already logged a build/dispatch failure for, so a persistently
  // broken command warns once instead of every frame.
  private readonly warnedShaders = new Set<string>()

  constructor(opts: WebGPUBatchExecutorOptions) {
    this.device = opts.device
    this.queue = opts.device.queue
    this.wasm = opts.wasm
    this.pipelineCache = opts.pipelineCache ?? new PipelineCache(opts.device)
    this.opts = opts
    this.colorTargets = opts.colorTargets
  }

  /** Drop every cached pipeline so the next dispatch rebuilds from the current
   * `wgslForShader(sdef)`. Needed when a shader's WGSL changes under a stable
   * `ShaderDef` identity (the cache key is the sdef pointer, not the source) —
   * e.g. a material-graph edit re-runs `SpatialTree.setDrawShader`. The shared
   * `PipelineCache` already keys on WGSL, so genuinely-new sources compile and
   * unchanged ones are reused. */
  invalidatePipelines(): void {
    this.pipelinesByShader.clear()
    // Cached entries hold resolved Pipeline refs — drop them too.
    this.batchCaches.clear()
  }

  /** Point subsequent draws at a pass with these color attachment format(s),
   * preserving each existing target's blend state. Grows/shrinks to match the
   * pass — the SSS MRT BasePass has 3 attachments, solid mode has 1. Grown
   * targets (the SSS data attachments) carry raw data and never blend.
   * No-op when the formats are unchanged. */
  setColorFormats(formats: GPUTextureFormat[]): void {
    let changed = formats.length !== this.colorTargets.length
    if (!changed) {
      for (let i = 0; i < formats.length; i++) {
        if (this.colorTargets[i].format !== formats[i]) {
          changed = true
          break
        }
      }
    }
    if (!changed) return
    const prev = this.colorTargets
    this.colorTargets = formats.map((format, i) => {
      const t = prev[i]
      return t ? {...t, format} : {format}
    })
  }

  // --- backend-agnostic seams (see TODO.md "native-electron: de-numbering") ---
  // WASM keeps a numeric heap `.ptr` + a numeric `buf.data` and reads the
  // linear-memory heap directly; the native (N-API) backend keeps real pointers
  // in C++, so identity comes from `objectAddress` (an opaque key) and bytes from
  // `pointerBytes` (a copy under the V8 sandbox). Vector *members* are array-like
  // on WASM but plain bound instances natively, so route them through
  // `getBoundVector`.

  /** Stable per-Buffer identity for the GPU-buffer cache. */
  private bufferKey(buf: Buffer): number {
    const wasmKey = (buf as unknown as BoundLike).ptr
    if (typeof wasmKey === 'number') return wasmKey
    const addr = this.wasm.objectAddress?.(buf as unknown as object)
    if (typeof addr === 'number') return addr
    throw new Error('WebGPUBatch: no stable buffer identity (objectAddress missing)')
  }

  /**
   * `byteLen` bytes of the buffer's backing storage starting `byteOffset` bytes
   * in (WASM heap view vs native pointerBytes copy — the offset keeps a partial
   * upload's cross-boundary copy proportional to the dirty range). An empty
   * view for a not-yet-filled buffer (`byteLen === 0` / null `data`) — the WASM
   * path likewise yields a zero-length view there; do NOT throw, or the first
   * frame (before the spatial tree fills its buffers) would abort the whole
   * drawObjects pass.
   */
  private bufferBytes(buf: Buffer, byteLen: number, byteOffset = 0): Uint8Array<ArrayBuffer> {
    const heap = this.wasm.HEAPU8
    if (heap !== undefined) {
      const dataPtr = (buf as unknown as {data: number}).data
      return new Uint8Array(heap.buffer as ArrayBuffer, dataPtr + byteOffset, byteLen)
    }
    if (byteLen === 0) return new Uint8Array(0)
    const view = this.wasm.pointerBytes?.(buf as unknown as object, 'data', byteLen, byteOffset)
    return (view as Uint8Array<ArrayBuffer>) ?? new Uint8Array(0)
  }

  /** A bound Vector member as array-like (`.length` + numeric index). */
  private vecMember<T>(v: unknown): ArrayLike<T> {
    if (this.wasm.HEAPU8 !== undefined) {
      return v as ArrayLike<T>
    }
    return this.wasm.getBoundVector('', v as object) as ArrayLike<T>
  }

  private uploadBuffer(buf: Buffer): GpuBuffer {
    const key = this.bufferKey(buf)
    const bytes = buf.size * buf.elemsize * gpuTypeBytes(buf.type)

    let cached = this.bufferCache.get(key)
    let fresh = false
    if (!cached || cached.uploadedSize !== bytes) {
      cached?.buf.destroy()
      cached = {
        buf: new GpuBuffer(this.device, {
          label: 'WebGPUBatch.vbo',
          size : Math.max(bytes, 4),
          usage: this.opts.bufferUsage ?? 'vertex',
        }),
        uploadedSize   : bytes,
        uploadedDataPtr: -1,
      }
      this.bufferCache.set(key, cached)
      fresh = true
    }

    // WASM tracks the data pointer to detect a realloc; native relies on the
    // engine's `update_buffer` dirty flag (the pointer stays in C++). A fresh
    // GPU buffer must ALWAYS write: a prior executor for the same batch may
    // have consumed update_buffer already (e.g. the xray flip rebuilds the
    // overlay executor), and an unwritten VBO draws degenerate zeros.
    const dataPtr = this.wasm.HEAPU8 !== undefined ? (buf as unknown as {data: number}).data : undefined
    const needsWrite = fresh || (dataPtr !== undefined && cached.uploadedDataPtr !== dataPtr) || buf.update_buffer
    if (needsWrite) {
      // Partial upload: when only `update_buffer` triggered the write and the
      // engine flagged a dirty sub-range (update_end >= 0, element units — see
      // gpu::Buffer.markDirtyRange), read + write just that span. A fresh GPU
      // buffer or a realloc'd WASM data pointer still writes everything.
      const rangeBuf = buf as unknown as {update_start?: number; update_end?: number}
      const updStart = rangeBuf.update_start ?? 0
      const updEnd = rangeBuf.update_end ?? -1
      const elemBytes = buf.elemsize * gpuTypeBytes(buf.type)
      const partial =
        !fresh &&
        (dataPtr === undefined || cached.uploadedDataPtr === dataPtr) &&
        updEnd >= 0 &&
        updStart >= 0 &&
        updStart < updEnd &&
        updEnd <= buf.size
      const byteOffset = partial ? updStart * elemBytes : 0
      const byteLen = partial ? (updEnd - updStart) * elemBytes : bytes
      const view = this.bufferBytes(buf, byteLen, byteOffset)
      cached.buf.write(view, byteOffset)
      if (dataPtr !== undefined) cached.uploadedDataPtr = dataPtr
      buf.update_buffer = false
      rangeBuf.update_start = 0
      rangeBuf.update_end = -1
    }

    return cached.buf
  }

  /**
   * The cached GPUBuffer for a sculptcore Buffer identity key (`buf.ptr` on
   * WASM / `objectAddress` natively) — the GPU brush scatter pass resolves
   * node VBOs through this. Undefined until the buffer has been drawn once.
   */
  cachedBufferByKey(key: number): GPUBuffer | undefined {
    return this.bufferCache.get(key)?.buf.handle
  }

  releaseBuffer(buf: Buffer): void {
    const key = this.bufferKey(buf)
    const cached = this.bufferCache.get(key)
    if (cached) {
      cached.buf.destroy()
      this.bufferCache.delete(key)
    }
  }

  private getPipeline(sdef: ShaderDef, cmd: DrawCommand, cmdAttrs: Buffer[]): Pipeline {
    const sdefPtr = (sdef as unknown as BoundLike).ptr
    const topology = cmdTypeToTopology(cmd.type)

    // Build the per-slot layout from the *actual* buffer shape, not the
    // shader's declared `elemSize`. WebGPU tolerates a narrower vertex
    // format than the WGSL variable (e.g. `float32x3` data into a
    // `vec4f` slot — missing components default to 0, w to 1). Keying
    // off the buffer shape lets sculptcore feed vec3 normals into a
    // WGSL `vec4f` declaration without the pipeline rejecting the bind.
    const attrs = Array.from(this.vecMember<{name: string}>(sdef.attrs))
    const slotAttrs: VertexAttrDesc[] = []
    attrs.forEach((a, slot) => {
      const found = cmdAttrs.find((b) => b.name === a.name)
      if (!found) return
      slotAttrs.push({
        name: a.name,
        slot,
        scalar     : gpuTypeToVertexScalar(found.type),
        elemSize   : found.elemsize,
        arrayStride: found.elemsize * gpuTypeBytes(found.type),
      })
    })

    const shapeKey = slotAttrs.map((a) => `${a.slot}:${a.scalar}x${a.elemSize}@${a.arrayStride}`).join(',')
    const targetKey = this.colorTargets.map((t) => t.format).join('+')
    const cacheKey = `${sdefPtr}|${topology}|${shapeKey}|${targetKey}|${this.opts.cullMode ?? 'none'}`

    let pipeline = this.pipelinesByShader.get(cacheKey)
    if (pipeline) return pipeline

    const vertexBuffers = buildVertexBufferLayout(slotAttrs)

    // Pad pass attachments the fragment doesn't write with writeMask 0 (a
    // nonzero-writeMask target with no shader output fails pipeline creation);
    // more outputs than attachments can't draw — throw so dispatch() skips it.
    const wgsl = this.opts.wgslForShader(sdef)
    const outLocs = fragmentOutputLocations(wgsl)
    let maxLoc = -1
    for (const loc of outLocs) {
      maxLoc = Math.max(maxLoc, loc)
    }
    if (maxLoc >= this.colorTargets.length) {
      throw new Error(
        `WebGPUBatch: shader "${sdef.name}" writes @location(${maxLoc}) but the current pass has ` +
          `${this.colorTargets.length} color attachment(s)`
      )
    }
    const colorTargets = this.colorTargets.map((t, i) => (outLocs.has(i) ? t : {...t, blend: undefined, writeMask: 0}))

    const desc: PipelineDescriptor = {
      label: `WebGPUBatch.pipeline[${sdefPtr}]`,
      wgsl,
      vertexBuffers,
      colorTargets,
      depthStencil: this.opts.depthStencil,
      primitive   : {topology, cullMode: this.opts.cullMode ?? 'none'},
    }

    pipeline = this.pipelineCache.get(desc)
    this.pipelinesByShader.set(cacheKey, pipeline)
    return pipeline
  }

  /** Stable per-DrawBatch identity for the dispatch cache: the manager-minted
   * `DrawBatch.id` (addresses/ptrs get reused across destroy/create). */
  private batchKey(batch: DrawBatch): number {
    const id = (batch as unknown as {id?: number}).id
    if (typeof id === 'number' && id > 0) return id
    // Pre-id engine build: fall back to pointer identity.
    const wasmKey = (batch as unknown as BoundLike).ptr
    if (typeof wasmKey === 'number') return -wasmKey
    const addr = this.wasm.objectAddress?.(batch as unknown as object)
    if (typeof addr === 'number') return -addr
    throw new Error('WebGPUBatch: no stable batch identity')
  }

  /** The batch's packed per-command culling AABBs (`DrawBatch.cmdAabbs`, 6
   * floats per source command), or null when absent/mismatched. One bulk read
   * natively (`vectorFloatView`); element-indexed copy on WASM. */
  private readBatchAabbs(batch: DrawBatch, srcCmdCount: number): Float32Array | null {
    const vec = (batch as unknown as {cmdAabbs?: unknown}).cmdAabbs
    if (!vec) return null
    const bulk = (
      this.wasm as unknown as {vectorFloatView?: (v: object) => ArrayBufferView | undefined}
    ).vectorFloatView?.(vec as object)
    if (bulk instanceof Float32Array) {
      return bulk.length === srcCmdCount * 6 ? bulk : null
    }
    const arr = this.vecMember<number>(vec)
    if (arr.length !== srcCmdCount * 6) return null
    const out = new Float32Array(arr.length)
    for (let i = 0; i < out.length; i++) out[i] = arr[i]
    return out
  }

  /** Normalize a batch's commands into cached dispatch state (per batch
   * version): attr arrays, pipelines, resolved vertex buffers, AABBs. */
  private buildBatchCache(batch: DrawBatch, version: number, targetsKey: string): BatchCache {
    const commands = this.vecMember<DrawCommand>(batch.commands)
    const entries: CachedCommand[] = []
    const engineBufs: Buffer[] = []
    const seenBufs = new Set<number>()

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]
      if (!cmd || !cmd.shader) continue
      // Skip a single bad draw command rather than letting a throw abort the
      // whole batch (an unported WGSL shader, a not-yet-filled buffer); warn
      // once per shader, like the old per-command dispatch loop did.
      try {
        const cmdAttrs = Array.from(this.vecMember<Buffer>(cmd.attrs))
        const pipeline = this.getPipeline(cmd.shader, cmd, cmdAttrs)
        const sdefAttrs = Array.from(this.vecMember<{name: string}>(cmd.shader.attrs))
        const vbufs: CachedCommand['vbufs'] = []
        for (let slot = 0; slot < sdefAttrs.length; slot++) {
          const found = cmdAttrs.find((a) => a.name === sdefAttrs[slot].name)
          if (!found) {
            vbufs.push(null)
            continue
          }
          vbufs.push({slot, engineBuf: found, gpu: this.uploadBuffer(found)})
          const bkey = this.bufferKey(found)
          if (!seenBufs.has(bkey)) {
            seenBufs.add(bkey)
            engineBufs.push(found)
          }
        }
        entries.push({cmd, srcIndex: i, pipeline, vbufs, count: cmd.end - cmd.start, start: cmd.start})
      } catch (e) {
        const key = (cmd.shader as {name?: string}).name ?? String(i)
        if (!this.warnedShaders.has(key)) {
          this.warnedShaders.add(key)
          console.error(`WebGPUBatchExecutor: skipping draw command for shader "${key}" after error`, e)
        }
      }
    }

    return {
      version,
      aabbVersion: (batch as unknown as {aabbVersion?: number}).aabbVersion ?? -1,
      targetsKey,
      entries,
      engineBufs,
      aabbs           : this.readBatchAabbs(batch, commands.length),
      visible         : new Uint8Array(entries.length),
      visibleKey      : -1,
      bundle          : null,
      bundleBindGroups: [],
    }
  }

  /** Frustum-cull the cached entries against `m` (clip = m * [x,y,z,1], the
   * column-major flat proj*object matrix). Conservative: an entry is culled
   * only when all 8 AABB corners are outside one clip plane. The near test is
   * `z < -w` so both z-in-[-w,w] and z-in-[0,w] projection conventions stay
   * safe. Returns a hash of the visible set. */
  private cullEntries(m: ArrayLike<number>, cache: BatchCache): number {
    const aabbs = cache.aabbs!
    const vis = cache.visible
    let hash = 0x811c9dc5
    for (let ei = 0; ei < cache.entries.length; ei++) {
      const o = cache.entries[ei].srcIndex * 6
      // Bitmask of clip planes every corner so far is outside of.
      let allOut = 0x3f
      for (let c = 0; c < 8 && allOut !== 0; c++) {
        const x = aabbs[o + ((c & 1) !== 0 ? 3 : 0)]
        const y = aabbs[o + 1 + ((c & 2) !== 0 ? 3 : 0)]
        const z = aabbs[o + 2 + ((c & 4) !== 0 ? 3 : 0)]
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
        const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
        const cz = m[2] * x + m[6] * y + m[10] * z + m[14]
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
        let out = 0
        if (cx < -cw) out |= 1
        if (cx > cw) out |= 2
        if (cy < -cw) out |= 4
        if (cy > cw) out |= 8
        if (cz < -cw) out |= 16
        if (cz > cw) out |= 32
        allOut &= out
      }
      const v = allOut === 0 ? 1 : 0
      vis[ei] = v
      if (v) hash = ((hash ^ ei) * 0x01000193) | 0
    }
    return hash
  }

  /** Record the visible cached draws into a render bundle (compatible with
   * this executor's color/depth formats). Null when nothing is visible. */
  private encodeBundle(cache: BatchCache, groupsByPipeline: Map<Pipeline, CommandBindGroup[]>): GPURenderBundle | null {
    const enc = this.device.createRenderBundleEncoder({
      label             : 'WebGPUBatch.bundle',
      colorFormats      : this.colorTargets.map((t) => t.format),
      depthStencilFormat: this.opts.depthStencil?.format,
      sampleCount       : 1,
    })
    let drew = false
    let curPipe: Pipeline | undefined
    for (let ei = 0; ei < cache.entries.length; ei++) {
      if (!cache.visible[ei]) continue
      const e = cache.entries[ei]
      const groups = groupsByPipeline.get(e.pipeline)
      if (!groups || groups.length === 0) continue
      if (e.pipeline !== curPipe) {
        enc.setPipeline(e.pipeline.handle)
        for (const g of groups) enc.setBindGroup(g.group, g.bindGroup)
        curPipe = e.pipeline
      }
      for (const vb of e.vbufs) {
        if (vb) enc.setVertexBuffer(vb.slot, vb.gpu.handle)
      }
      enc.draw(e.count, 1, e.start, 0)
      drew = true
    }
    return drew ? enc.finish() : null
  }

  /** Re-upload any dirty engine buffers of a cached batch (push model — the
   * producer calls this when it knows geometry/attrs changed, instead of the
   * dispatch loop polling `update_buffer` per buffer per frame). Refreshes
   * cached GPU-buffer refs + forces a bundle re-encode when a resize recreated
   * a GPUBuffer. */
  flushBatchBuffers(batch: DrawBatch): void {
    const cache = this.batchCaches.get(this.batchKey(batch))
    if (!cache) return
    // A rebuilt batch may have DISPOSED the cached engine buffers — don't
    // touch them; the next dispatch rebuilds the cache and uploads everything.
    const version = (batch as unknown as {version?: number}).version ?? -1
    if (version !== cache.version) return
    let identityChanged = false
    for (const buf of cache.engineBufs) {
      const before = this.bufferCache.get(this.bufferKey(buf))?.buf
      if (this.uploadBuffer(buf) !== before) {
        identityChanged = true
      }
    }
    if (identityChanged) {
      for (const e of cache.entries) {
        for (const vb of e.vbufs) {
          if (vb) vb.gpu = this.uploadBuffer(vb.engineBuf)
        }
      }
      cache.visibleKey = -1 // force re-encode
    }
  }

  // Caller must already have opened the pass and set the viewport. Per-command
  // state (attr arrays, pipelines, vertex buffers) is cached per DrawBatch
  // version; the shared uniforms are written once per distinct pipeline (not
  // per command) and the visible draws replay from a cached render bundle.
  dispatch(batch: DrawBatch, pass: GPURenderPassEncoder, opts?: DispatchOptions): void {
    const key = this.batchKey(batch)
    const version = (batch as unknown as {version?: number}).version ?? -1
    const targetsKey = this.colorTargets.map((t) => t.format).join('+') + '|' + (this.opts.cullMode ?? 'none')

    let cache = this.batchCaches.get(key)
    if (!cache || cache.version !== version || cache.targetsKey !== targetsKey) {
      cache = this.buildBatchCache(batch, version, targetsKey)
      if (this.batchCaches.size > 32) {
        const oldest = this.batchCaches.keys().next().value
        if (oldest !== undefined) this.batchCaches.delete(oldest)
      }
      this.batchCaches.set(key, cache)
    } else if (cache.aabbs) {
      const av = (batch as unknown as {aabbVersion?: number}).aabbVersion ?? -1
      if (av !== cache.aabbVersion) {
        cache.aabbs = this.readBatchAabbs(batch, this.vecMember<DrawCommand>(batch.commands).length)
        cache.aabbVersion = av
      }
    }
    if (cache.entries.length === 0) return

    // Frustum culling (per frame, pure JS over the cached AABBs).
    let visKey: number
    if (opts?.cullMatrix && cache.aabbs) {
      visKey = this.cullEntries(opts.cullMatrix, cache)
    } else {
      cache.visible.fill(1)
      visKey = 0x7fffffff
    }

    // Shared uniforms/bind groups once per distinct pipeline. Commands sharing
    // a pipeline are assumed to share their uniform values (true for the
    // spatial batches — all commands read one per-frame uniforms block).
    const groupsByPipeline = new Map<Pipeline, CommandBindGroup[]>()
    const bindGroupIds: GPUBindGroup[] = []
    for (const e of cache.entries) {
      if (groupsByPipeline.has(e.pipeline)) continue
      const bg = this.opts.bindGroupForCommand(e.cmd, e.pipeline)
      const list: CommandBindGroup[] = !bg ? [] : Array.isArray(bg) ? bg : [{group: 0, bindGroup: bg}]
      groupsByPipeline.set(e.pipeline, list)
      for (const g of list) bindGroupIds.push(g.bindGroup)
    }

    // Bundle reuse: re-encode only when the visible set or any bind-group
    // identity changed (resource-bearing groups mint fresh bind groups per
    // frame; uniform-only groups are stable, so the static case replays).
    const bgSame =
      bindGroupIds.length === cache.bundleBindGroups.length &&
      bindGroupIds.every((b, i) => b === cache!.bundleBindGroups[i])
    if (visKey !== cache.visibleKey || !bgSame) {
      cache.bundle = this.encodeBundle(cache, groupsByPipeline)
      cache.visibleKey = visKey
      cache.bundleBindGroups = bindGroupIds
    }
    if (cache.bundle) {
      pass.executeBundles([cache.bundle])
    }
  }

  dispose(): void {
    for (const cached of this.bufferCache.values()) cached.buf.destroy()
    this.bufferCache.clear()
    this.pipelinesByShader.clear()
    this.batchCaches.clear()
  }
}
