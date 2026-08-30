/**
 * GPU brush-stroke dispatcher (documentation/plans/gpuGlobalBrushes.md §4).
 *
 * One `GpuBrushStroke` per stroke, owned by SculptPaintOp: the C++ side owns
 * every byte layout (the GpuBrush_* seam marshals ready-to-upload blobs per
 * compute_layout.h); this class owns the GPU objects — pipeline, stroke-static
 * storage buffers, per-dab uniform uploads, dispatch, and readback. It runs on
 * the renderer's own GPUDevice/queue, so compute and render submissions are
 * ordered without any render-graph hook (plan D3).
 *
 * M2 shape: per-dab full readback → GpuBrush_applyCo (interactive but not yet
 * GPU-resident); the M3 scatter/normal passes replace the per-dab readback.
 *
 * Failure policy: never throw across the stroke seam. Any GPU error before the
 * first dab aborts to the CPU fallback (`valid` false); after dabs have run,
 * the stroke finishes via readback-and-apply so the mesh is never left
 * half-stroked.
 */

import {brushWgsl} from '@sculptcore/api/sculptcore/brush/brushWgsl'
import {GpuBrushData, GpuBrushInfo, IWasmInterface, SculptHandle} from '@sculptcore/api/api'

import {BufferUsage, MapMode, ShaderStage, TextureUsage} from '@framework/api'

/** std430 array<vec3<f32>> element stride (xyz + pad). */
const VEC3_STRIDE = 16

type BindKind = 'uniform' | 'storage-rw' | 'storage-ro' | 'texture' | 'sampler'

interface BindingInfo {
  binding: number
  kind: BindKind
}

/**
 * Parse the `@group(0) @binding(N) var<...> name: type;` table out of the
 * kernel's WGSL text — the same introspection convention as
 * WgpuBrushComputeDispatch::loadKernel and tests/webgpu/replay.mjs. An
 * unrecognized declaration returns null so stroke begin fails loudly instead
 * of silently no-rendering.
 */
export function parseBindings(wgsl: string): BindingInfo[] | null {
  const out: BindingInfo[] = []
  const re = /@group\(0\)\s*@binding\((\d+)\)\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(wgsl))) {
    const binding = parseInt(m[1], 10)
    const decl = m[2].replace(/\s+/g, '')
    let kind: BindKind
    if (decl.includes('var<uniform>')) {
      kind = 'uniform'
    } else if (decl.includes('var<storage,read_write>')) {
      kind = 'storage-rw'
    } else if (decl.includes('var<storage,read>')) {
      kind = 'storage-ro'
    } else if (decl.includes('texture_2d')) {
      kind = 'texture'
    } else if (decl.includes(':sampler')) {
      kind = 'sampler'
    } else {
      return null
    }
    out.push({binding, kind})
  }
  return out.length ? out : null
}

function layoutEntry(b: BindingInfo): GPUBindGroupLayoutEntry {
  const e: GPUBindGroupLayoutEntry = {binding: b.binding, visibility: ShaderStage.COMPUTE}
  switch (b.kind) {
    case 'uniform':
      e.buffer = {type: 'uniform'}
      break
    case 'storage-rw':
      e.buffer = {type: 'storage'}
      break
    case 'storage-ro':
      e.buffer = {type: 'read-only-storage'}
      break
    case 'texture':
      e.texture = {sampleType: 'unfilterable-float', viewDimension: '2d'}
      break
    case 'sampler':
      e.sampler = {type: 'non-filtering'}
      break
  }
  return e
}

/** Expand packed xyz triples into stride-16 std430 vec3 slots. */
function expandVec3(packed: Float32Array): Float32Array {
  const n = packed.length / 3
  const out = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    out[i * 4 + 0] = packed[i * 3 + 0]
    out[i * 4 + 1] = packed[i * 3 + 1]
    out[i * 4 + 2] = packed[i * 3 + 2]
  }
  return out
}

/** Gather stride-16 vec3 slots back into packed xyz triples. */
function packVec3(strided: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    out[i * 3 + 0] = strided[i * 4 + 0]
    out[i * 3 + 1] = strided[i * 4 + 1]
    out[i * 3 + 2] = strided[i * 4 + 2]
  }
  return out
}

/** Non-finite tripwire kernel (plan §9.4): ORs an exponent-all-ones test over
 * the dab's work set into a 4-byte flag. Exponent bits are used instead of
 * `x != x` because WGSL implementations may assume no NaNs and fold float
 * comparisons. */
const TRIPWIRE_WGSL = `
struct NodeMeta { vert_offset: u32, vert_count: u32, };
@group(0) @binding(0) var<storage, read>       co_buf: array<vec3<f32>>;
@group(0) @binding(1) var<storage, read>       unique_verts: array<u32>;
@group(0) @binding(2) var<storage, read>       nodes: array<NodeMeta>;
@group(0) @binding(3) var<storage, read_write> flag: atomic<u32>;
fn bad(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u;
}
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) gid: vec3<u32>) {
  let n = nodes[gid.x];
  if (lid >= n.vert_count) { return; }
  let c = co_buf[unique_verts[n.vert_offset + lid]];
  if (bad(c.x) || bad(c.y) || bad(c.z)) { atomicStore(&flag, 1u); }
}
`

/** Scatter kernel (plan §4/M3): fans the compute-pass co into a GPU node's
 * corner-major position/normal VBOs via the corner->global-vert map — the GPU
 * twin of fill_leaf_slice. The renderer is flat-shaded (face normal broadcast
 * to all 3 corners), and a tri's corners are adjacent map slots, so the face
 * normal is computed inline from the corner's tri triple — no separate
 * face/vertex normal passes are needed for rendering parity. */
const SCATTER_WGSL = `
struct Params { cornerCount: u32, mapOffset: u32, };
@group(0) @binding(0) var<storage, read>       co_buf: array<vec3<f32>>;
@group(0) @binding(1) var<storage, read>       corner_vert: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_pos: array<f32>;
@group(0) @binding(3) var<storage, read_write> out_nor: array<f32>;
@group(0) @binding(4) var<uniform>             params: Params;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= params.cornerCount) { return; }
  let v = corner_vert[params.mapOffset + s];
  let base = params.mapOffset + (s / 3u) * 3u;
  let a = co_buf[corner_vert[base]];
  let b = co_buf[corner_vert[base + 1u]];
  let c = co_buf[corner_vert[base + 2u]];
  let n = normalize(cross(b - a, c - a));
  let p = co_buf[v];
  out_pos[s * 3u + 0u] = p.x;
  out_pos[s * 3u + 1u] = p.y;
  out_pos[s * 3u + 2u] = p.z;
  out_nor[s * 3u + 0u] = n.x;
  out_nor[s * 3u + 1u] = n.y;
  out_nor[s * 3u + 2u] = n.z;
}
`

/** One GPU node's scatter targets, resolved by the controller from the batch
 * executor's buffer cache + the seam's SCATTER_META records. */
export interface ScatterOwner {
  posBuf: GPUBuffer
  norBuf: GPUBuffer
  /** Uniform {cornerCount, mapOffset} for this owner (cached per layout gen). */
  paramsBuf: GPUBuffer
  cornerCount: number
}

export interface ScatterTables {
  /** The full corner->global-vert map (cached across strokes per layout gen). */
  mapBuf: GPUBuffer
  owners: ScatterOwner[]
}

/** Per-stroke stats mirrored onto window.DEBUG.gpuBrush / the HUD (plan §9.7). */
export interface GpuBrushStats {
  kernel: string
  elemCount: number
  dabs: number
  dispatches: number
  uniqueCount: number
  nodeCount: number
  bytesUploadedLastDab: number
  marshalMs: number
  uploadMs: number
  submitMs: number
  readbackMs: number
  /** Kernel+scatter GPU time (timestamp-query; 0 when the feature is absent). */
  gpuMs: number
  scatterDispatches: number
  gpuResident: boolean
  tripwireTripped: boolean
}

/** One per-dab fixture record in the tests/webgpu/replay.mjs format. */
interface CaptureDab {
  nodeCount: number
  unique: string
  nodes: string
  brushU: string
  ctxU: string
  falloff: string
  stroke: string
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(bin)
}

export interface GpuBrushStrokeOptions {
  device: GPUDevice
  wasm: IWasmInterface
  /** The open GpuBrush_* session (GpuBrush_beginStroke). The stroke does NOT
   * own it — SculptPaintOp ends/frees it. */
  session: SculptHandle
  /** Capture per-binding upload bytes into a replay.mjs fixture (plan §9.2). */
  capture?: boolean
  log?: (msg: string) => void
}

export class GpuBrushStroke {
  readonly kernel: string
  readonly elemCount: number
  /** False after any GPU error — callers fall back to the CPU path. */
  valid = false
  stats: GpuBrushStats

  /** The renderer's device (shared queue — D3). Readable by the controller
   * for scatter-cache buffer creation. */
  readonly device: GPUDevice
  private wasm: IWasmInterface
  private session: SculptHandle
  private log: (msg: string) => void
  private captureEnabled: boolean

  private bindings: BindingInfo[] = []
  private pipeline: GPUComputePipeline | null = null
  private bgLayout: GPUBindGroupLayout | null = null
  private bindGroup: GPUBindGroup | null = null
  private bindGroupDirty = true

  private bufs = new Map<number, GPUBuffer>()
  private bufSizes = new Map<number, number>()
  private texture: GPUTexture | null = null
  private texView: GPUTextureView | null = null
  private sampler: GPUSampler | null = null

  private scatterPipeline: GPUComputePipeline | null = null
  private scatter: ScatterTables | null = null
  private scatterBindGroups = new Map<number, GPUBindGroup>()

  private tripPipeline: GPUComputePipeline | null = null
  private tripFlag: GPUBuffer | null = null
  private tripStaging: GPUBuffer | null = null
  private tripInFlight = false

  private readback: GPUBuffer | null = null
  private deviceLost = false

  // §9.7 GPU pass timing (timestamp-query; all null when the feature is absent).
  private tsQuerySet: GPUQuerySet | null = null
  private tsResolve: GPUBuffer | null = null
  private tsStaging: GPUBuffer | null = null
  private tsInFlight = false

  private capture: {
    kernel: string
    vertCount: number
    hasNeighbors: boolean
    writesMask: boolean
    co: string
    no: string
    mask: string
    automask: string | null
    nbrMeta: string | null
    nbrVerts: string | null
    texture: null
    dabs: CaptureDab[]
  } | null = null

  constructor(opts: GpuBrushStrokeOptions) {
    this.device = opts.device
    this.wasm = opts.wasm
    this.session = opts.session
    this.log =
      opts.log ??
      ((msg) => {
        // eslint-disable-next-line no-console
        console.warn(`[gpu-brush] ${msg}`)
      })
    this.captureEnabled = !!opts.capture
    this.kernel = opts.wasm.GpuBrush_kernelName(opts.session)
    this.elemCount = opts.wasm.GpuBrush_info(opts.session, GpuBrushInfo.ELEM_COUNT)
    this.stats = {
      kernel              : this.kernel,
      elemCount           : this.elemCount,
      dabs                : 0,
      dispatches          : 0,
      uniqueCount         : 0,
      nodeCount           : 0,
      bytesUploadedLastDab: 0,
      marshalMs           : 0,
      uploadMs            : 0,
      submitMs            : 0,
      readbackMs          : 0,
      gpuMs               : 0,
      scatterDispatches   : 0,
      gpuResident         : false,
      tripwireTripped     : false,
    }
    this.device.lost.then(() => {
      this.deviceLost = true
      this.valid = false
    })
  }

  /**
   * Compile the kernel, build the pipeline + stroke-static buffers, and upload
   * the begin blobs. Async because pipeline validation is surfaced through an
   * error scope — any failure here leaves `valid` false (CPU fallback) before
   * the first dab (plan §4 failure policy).
   */
  async begin(): Promise<boolean> {
    const wgsl = brushWgsl[this.kernel]
    if (!wgsl) {
      this.log(`no WGSL for kernel '${this.kernel}'`)
      return false
    }
    const parsed = parseBindings(wgsl)
    if (!parsed) {
      this.log(`unparseable bindings in kernel '${this.kernel}'`)
      return false
    }
    this.bindings = parsed
    // The dispatcher fills bindings 0-13 + 23/24/25; a kernel wanting an attr
    // slot (>=14, other than those) needs marshaling this class doesn't do
    // yet — fail loudly at begin, not silently at draw.
    for (const b of this.bindings) {
      if (b.binding >= 14 && (b.binding < 23 || b.binding > 25)) {
        this.log(`kernel '${this.kernel}' wants unsupported binding ${b.binding}`)
        return false
      }
    }

    const dev = this.device
    dev.pushErrorScope('validation')

    const module = dev.createShaderModule({
      label: `gpuBrush.${this.kernel}.module`,
      code : wgsl,
    })
    this.bgLayout = dev.createBindGroupLayout({
      label  : `gpuBrush.${this.kernel}.bgl`,
      entries: this.bindings.map(layoutEntry),
    })
    this.pipeline = dev.createComputePipeline({
      label  : `gpuBrush.${this.kernel}.pipeline`,
      layout : dev.createPipelineLayout({bindGroupLayouts: [this.bgLayout]}),
      compute: {module, entryPoint: 'main'},
    })

    // Stroke-static geometry. co/no expand to stride-16; the dab stamps (23)
    // and the accumulated displacement (25) both start at zero, which a fresh
    // GPUBuffer already is.
    const co = new Float32Array(this.data(GpuBrushData.CO).slice().buffer)
    const no = new Float32Array(this.data(GpuBrushData.NO).slice().buffer)
    const mask = this.data(GpuBrushData.MASK).slice()
    const coStrided = expandVec3(co)
    const noStrided = expandVec3(no)
    this.upload(0, coStrided, BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST)
    this.upload(1, noStrided, BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST)
    this.upload(2, mask, BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST)
    if (this.has(23)) {
      this.upload(23, new Uint8Array(this.elemCount * 4), BufferUsage.STORAGE | BufferUsage.COPY_DST)
    }
    if (this.has(25)) {
      this.upload(25, new Uint8Array(this.elemCount * VEC3_STRIDE), BufferUsage.STORAGE | BufferUsage.COPY_DST)
    }
    // Cavity automask (binding 24): one f32 per vertex, identity 1.0 from the
    // C-API when cavity masking is off (so GPU strength == CPU strength).
    if (this.has(24)) {
      this.upload(24, this.data(GpuBrushData.AUTOMASK).slice(), BufferUsage.STORAGE | BufferUsage.COPY_DST)
    }
    if (this.has(11)) {
      this.ensureBuf(11, this.elemCount * VEC3_STRIDE, BufferUsage.STORAGE | BufferUsage.COPY_DST)
    }
    if (this.has(12)) {
      this.upload(12, this.data(GpuBrushData.NBR_META), BufferUsage.STORAGE | BufferUsage.COPY_DST)
      this.upload(13, this.data(GpuBrushData.NBR_VERTS), BufferUsage.STORAGE | BufferUsage.COPY_DST)
    }
    if (this.has(8)) {
      this.makeWhiteTexture()
    }

    // §9.7: GPU pass timing when the adapter granted timestamp-query.
    if (dev.features.has('timestamp-query')) {
      this.tsQuerySet = dev.createQuerySet({label: `gpuBrush.${this.kernel}.ts`, type: 'timestamp', count: 2})
      this.tsResolve = dev.createBuffer({
        label: `gpuBrush.${this.kernel}.tsResolve`,
        size : 16,
        usage: BufferUsage.QUERY_RESOLVE | BufferUsage.COPY_SRC,
      })
      this.tsStaging = dev.createBuffer({
        label: `gpuBrush.${this.kernel}.tsStaging`,
        size : 16,
        usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
      })
    }

    // Non-finite tripwire (plan §9.4).
    this.tripPipeline = dev.createComputePipeline({
      label  : `gpuBrush.${this.kernel}.tripwire`,
      layout : 'auto',
      compute: {module: dev.createShaderModule({code: TRIPWIRE_WGSL}), entryPoint: 'main'},
    })
    this.tripFlag = dev.createBuffer({
      label: `gpuBrush.${this.kernel}.tripFlag`,
      size : 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
    })
    this.tripStaging = dev.createBuffer({
      label: `gpuBrush.${this.kernel}.tripStaging`,
      size : 4,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    })

    if (this.captureEnabled) {
      this.capture = {
        kernel      : this.kernel,
        vertCount   : this.elemCount,
        hasNeighbors: this.has(12),
        writesMask  : this.wasm.GpuBrush_info(this.session, GpuBrushInfo.WRITES_MASK) !== 0,
        co          : b64(new Uint8Array(coStrided.buffer)),
        no          : b64(new Uint8Array(noStrided.buffer)),
        mask        : b64(mask),
        automask    : this.has(24) ? b64(this.data(GpuBrushData.AUTOMASK).slice()) : null,
        nbrMeta     : this.has(12) ? b64(this.data(GpuBrushData.NBR_META).slice()) : null,
        nbrVerts    : this.has(12) ? b64(this.data(GpuBrushData.NBR_VERTS).slice()) : null,
        texture     : null,
        dabs        : [],
      }
    }

    // Everything above is synchronous — the whole stroke's dabs may dispatch
    // in this same tick (a headless exec loop never yields), so capture init
    // must precede this await. The error-scope pop resolves asynchronously and
    // flips `valid` off on failure (callers abort to CPU when nothing has
    // dispatched yet).
    this.valid = true
    const err = await dev.popErrorScope()
    if (err) {
      this.fail(`pipeline/buffer setup failed: ${err.message}`)
      this.destroy()
      return false
    }

    return true
  }

  /**
   * Install the M3 scatter tables (controller-resolved node VBOs + the cached
   * corner->vert map). From then on `dab()` encodes a scatter pass over each
   * touched owner in the same submit, and the stroke is GPU-resident — no
   * per-dab readback. Requires begin() to have run (needs the pipeline's
   * device objects).
   */
  setScatter(tables: ScatterTables): boolean {
    if (!this.pipeline) {
      return false
    }
    const dev = this.device
    dev.pushErrorScope('validation')
    if (!this.scatterPipeline) {
      this.scatterPipeline = dev.createComputePipeline({
        label  : `gpuBrush.${this.kernel}.scatter`,
        layout : 'auto',
        compute: {
          module    : dev.createShaderModule({code: SCATTER_WGSL}),
          entryPoint: 'main',
        },
      })
    }
    this.scatter = tables
    this.scatterBindGroups.clear()
    void dev.popErrorScope().then((err) => {
      if (err) {
        this.log(`scatter pipeline failed: ${err.message} — falling back to per-dab readback`)
        this.scatter = null
        this.stats.gpuResident = false
      }
    })
    this.stats.gpuResident = true
    return true
  }

  /** Encode scatter passes for the given owner (meta) indices into `enc`. */
  private encodeScatter(enc: GPUCommandEncoder, ownerIndices: ArrayLike<number>) {
    const scatter = this.scatter
    const co = this.bufs.get(0)
    if (!scatter || !this.scatterPipeline || !co) {
      return
    }
    for (let i = 0; i < ownerIndices.length; i++) {
      const idx = ownerIndices[i]
      const owner = scatter.owners[idx]
      if (!owner) {
        continue
      }
      let bg = this.scatterBindGroups.get(idx)
      if (!bg) {
        bg = this.device.createBindGroup({
          label  : `gpuBrush.${this.kernel}.scatter.bg${idx}`,
          layout : this.scatterPipeline.getBindGroupLayout(0),
          entries: [
            {binding: 0, resource: {buffer: co}},
            {binding: 1, resource: {buffer: scatter.mapBuf}},
            {binding: 2, resource: {buffer: owner.posBuf}},
            {binding: 3, resource: {buffer: owner.norBuf}},
            {binding: 4, resource: {buffer: owner.paramsBuf}},
          ],
        })
        this.scatterBindGroups.set(idx, bg)
      }
      const pass = enc.beginComputePass({label: `gpuBrush.${this.kernel}.scatterPass`})
      pass.setPipeline(this.scatterPipeline)
      pass.setBindGroup(0, bg)
      pass.dispatchWorkgroups(Math.ceil(owner.cornerCount / 64))
      pass.end()
      this.stats.scatterDispatches++
    }
  }

  /**
   * Overwrite the GPU co buffer from packed CPU positions — the shadow-verify
   * re-sync (divergence must never compound across dabs).
   */
  resyncCo(packed: Float32Array) {
    const buf = this.bufs.get(0)
    if (!buf) {
      return
    }
    const strided = expandVec3(packed)
    this.device.queue.writeBuffer(buf, 0, strided.buffer, 0, strided.byteLength)
  }

  /**
   * Dispatch one already-marshaled dab image (GpuBrush_marshalDab returned
   * `nodeCount` workgroups). Uploads the per-dab blobs (index arrays only when
   * the filter set changed) and submits kernel + tripwire in one command
   * buffer. Synchronous — the queue orders everything.
   */
  dab(nodeCount: number, scatterOwners?: ArrayLike<number>): boolean {
    if (!this.valid || nodeCount <= 0) {
      return this.valid
    }
    const dev = this.device
    const t0 = performance.now()
    let bytes = 0

    const uvertsChanged = this.wasm.GpuBrush_info(this.session, GpuBrushInfo.UVERTS_CHANGED) !== 0
    if (uvertsChanged || !this.bufs.get(3)) {
      bytes += this.upload(3, this.data(GpuBrushData.UVERTS), BufferUsage.STORAGE | BufferUsage.COPY_DST)
      bytes += this.upload(4, this.data(GpuBrushData.NODE_META), BufferUsage.STORAGE | BufferUsage.COPY_DST)
    }
    bytes += this.upload(5, this.data(GpuBrushData.BRUSH_UNIFORMS), BufferUsage.UNIFORM | BufferUsage.COPY_DST)
    bytes += this.upload(6, this.data(GpuBrushData.CTX_UNIFORMS), BufferUsage.UNIFORM | BufferUsage.COPY_DST)
    bytes += this.upload(7, this.data(GpuBrushData.FALLOFF_LUT), BufferUsage.UNIFORM | BufferUsage.COPY_DST)
    if (this.has(10)) {
      bytes += this.upload(10, this.data(GpuBrushData.STROKE_PATH), BufferUsage.STORAGE | BufferUsage.COPY_DST)
    }

    if (this.capture) {
      this.capture.dabs.push({
        nodeCount,
        unique : b64(this.data(GpuBrushData.UVERTS).slice()),
        nodes  : b64(this.data(GpuBrushData.NODE_META).slice()),
        brushU : b64(this.data(GpuBrushData.BRUSH_UNIFORMS).slice()),
        ctxU   : b64(this.data(GpuBrushData.CTX_UNIFORMS).slice()),
        falloff: b64(this.data(GpuBrushData.FALLOFF_LUT).slice()),
        stroke : b64(this.data(GpuBrushData.STROKE_PATH).slice()),
      })
    }

    const t1 = performance.now()

    if (this.bindGroupDirty) {
      this.bindGroup = this.buildBindGroup()
      this.bindGroupDirty = false
    }
    if (!this.bindGroup || !this.pipeline) {
      this.fail('bind group build failed')
      return false
    }

    const firstDab = this.stats.dispatches === 0
    if (firstDab) {
      dev.pushErrorScope('validation')
    }

    const enc = dev.createCommandEncoder({label: `gpuBrush.${this.kernel}.dab`})
    // Jacobi snapshot for for_neighbor kernels (binding 11), like the C++
    // dispatchers: copy + dispatch share the command buffer, so order holds.
    if (this.has(11)) {
      enc.copyBufferToBuffer(this.bufs.get(0)!, 0, this.bufs.get(11)!, 0, this.elemCount * VEC3_STRIDE)
    }
    const wantTs = !!this.tsQuerySet && !this.tsInFlight
    const pass = enc.beginComputePass({
      label          : `gpuBrush.${this.kernel}.pass`,
      timestampWrites: wantTs
        ? {querySet: this.tsQuerySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1}
        : undefined,
    })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.dispatchWorkgroups(nodeCount)
    pass.end()
    if (wantTs) {
      enc.resolveQuerySet(this.tsQuerySet!, 0, 2, this.tsResolve!, 0)
      enc.copyBufferToBuffer(this.tsResolve!, 0, this.tsStaging!, 0, 16)
    }
    this.encodeTripwire(enc, nodeCount)
    if (scatterOwners?.length) {
      this.encodeScatter(enc, scatterOwners)
    }
    dev.queue.submit([enc.finish()])

    if (firstDab) {
      void dev.popErrorScope().then((err) => {
        if (err) {
          this.fail(`first dab validation: ${err.message}`)
        }
      })
    }
    this.pollTripwire()
    if (wantTs) {
      this.pollTimestamps()
    }

    const t2 = performance.now()
    this.stats.dispatches++
    this.stats.uniqueCount = this.wasm.GpuBrush_info(this.session, GpuBrushInfo.UNIQUE_COUNT)
    this.stats.nodeCount = nodeCount
    this.stats.bytesUploadedLastDab = bytes
    this.stats.uploadMs += t1 - t0
    this.stats.submitMs += t2 - t1
    return this.valid
  }

  /** Read the full co buffer back as packed xyz (one stall; M2's per-dab and
   * the stroke-end readback both land here). */
  async readCo(): Promise<Float32Array | null> {
    if (!this.pipeline || this.deviceLost) {
      return null
    }
    const t0 = performance.now()
    const byteLen = this.elemCount * VEC3_STRIDE
    if (!this.readback) {
      this.readback = this.device.createBuffer({
        label: `gpuBrush.${this.kernel}.readback`,
        size : byteLen,
        usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
      })
    }
    const enc = this.device.createCommandEncoder()
    enc.copyBufferToBuffer(this.bufs.get(0)!, 0, this.readback, 0, byteLen)
    this.device.queue.submit([enc.finish()])
    try {
      await this.readback.mapAsync(MapMode.READ, 0, byteLen)
    } catch (e) {
      this.fail(`readback mapAsync failed: ${e}`)
      return null
    }
    const strided = new Float32Array(this.readback.getMappedRange(0, byteLen).slice(0))
    this.readback.unmap()
    this.stats.readbackMs += performance.now() - t0
    return packVec3(strided, this.elemCount)
  }

  /** The replay.mjs-format fixture for this stroke (capture mode only). The
   * caller appends expectCo after the final readback. */
  captureFixture(expectCo: Float32Array | null): object | null {
    if (!this.capture) {
      return null
    }
    return {
      ...this.capture,
      expectCo  : expectCo ? b64(new Uint8Array(expectCo.buffer.slice(0))) : null,
      expectMask: null,
    }
  }

  destroy() {
    for (const b of this.bufs.values()) {
      b.destroy()
    }
    this.bufs.clear()
    this.bufSizes.clear()
    this.readback?.destroy()
    this.readback = null
    this.tripFlag?.destroy()
    this.tripFlag = null
    this.tsQuerySet?.destroy()
    this.tsQuerySet = null
    this.tsResolve?.destroy()
    this.tsResolve = null
    if (!this.tsInFlight) {
      this.tsStaging?.destroy()
    }
    this.tsStaging = null
    if (!this.tripInFlight) {
      this.tripStaging?.destroy()
    }
    this.tripStaging = null
    this.texture?.destroy()
    this.texture = null
    // Scatter map/params buffers are owned by the controller's cross-stroke
    // cache — only drop this stroke's references.
    this.scatter = null
    this.scatterBindGroups.clear()
    this.pipeline = null
    this.bindGroup = null
    this.valid = false
  }

  // ---------------------------------------------------------------------

  private fail(msg: string) {
    this.log(msg)
    this.valid = false
  }

  private has(binding: number): boolean {
    return this.bindings.some((b) => b.binding === binding)
  }

  private data(which: number): Uint8Array {
    return this.wasm.GpuBrush_data(this.session, which)
  }

  private ensureBuf(binding: number, size: number, usage: number): GPUBuffer {
    const have = this.bufs.get(binding)
    const haveSize = this.bufSizes.get(binding) ?? 0
    const need = Math.max(4, (size + 3) & ~3)
    if (have && haveSize >= need) {
      return have
    }
    have?.destroy()
    let rounded = 256
    while (rounded < need) {
      rounded *= 2
    }
    const buf = this.device.createBuffer({
      label: `gpuBrush.${this.kernel}.b${binding}`,
      size : rounded,
      usage,
    })
    this.bufs.set(binding, buf)
    this.bufSizes.set(binding, rounded)
    this.bindGroupDirty = true
    return buf
  }

  /** ensure + writeBuffer; returns bytes written. */
  private upload(binding: number, bytes: Uint8Array | Float32Array, usage: number): number {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const buf = this.ensureBuf(binding, view.byteLength, usage)
    if (view.byteLength) {
      this.device.queue.writeBuffer(buf, 0, view, 0, view.byteLength)
    }
    return view.byteLength
  }

  private makeWhiteTexture() {
    this.texture = this.device.createTexture({
      label : `gpuBrush.${this.kernel}.whiteTex`,
      size  : {width: 1, height: 1},
      format: 'r32float',
      usage : TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture(
      {texture: this.texture},
      new Float32Array([1]),
      {bytesPerRow: 4},
      {width: 1, height: 1}
    )
    this.texView = this.texture.createView()
    this.sampler = this.device.createSampler({label: `gpuBrush.${this.kernel}.sampler`})
  }

  private buildBindGroup(): GPUBindGroup | null {
    if (!this.bgLayout) {
      return null
    }
    const entries: GPUBindGroupEntry[] = []
    for (const b of this.bindings) {
      if (b.kind === 'texture') {
        if (!this.texView) {
          return null
        }
        entries.push({binding: b.binding, resource: this.texView})
        continue
      }
      if (b.kind === 'sampler') {
        if (!this.sampler) {
          return null
        }
        entries.push({binding: b.binding, resource: this.sampler})
        continue
      }
      const buf = this.bufs.get(b.binding)
      if (!buf) {
        return null
      }
      entries.push({binding: b.binding, resource: {buffer: buf}})
    }
    return this.device.createBindGroup({
      label : `gpuBrush.${this.kernel}.bg`,
      layout: this.bgLayout,
      entries,
    })
  }

  private encodeTripwire(enc: GPUCommandEncoder, nodeCount: number) {
    if (!this.tripPipeline || !this.tripFlag) {
      return
    }
    const bg = this.device.createBindGroup({
      layout : this.tripPipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: this.bufs.get(0)!}},
        {binding: 1, resource: {buffer: this.bufs.get(3)!}},
        {binding: 2, resource: {buffer: this.bufs.get(4)!}},
        {binding: 3, resource: {buffer: this.tripFlag}},
      ],
    })
    const pass = enc.beginComputePass({label: `gpuBrush.${this.kernel}.tripwire`})
    pass.setPipeline(this.tripPipeline)
    pass.setBindGroup(0, bg)
    pass.dispatchWorkgroups(nodeCount)
    pass.end()
    if (this.tripStaging && !this.tripInFlight) {
      enc.copyBufferToBuffer(this.tripFlag, 0, this.tripStaging, 0, 4)
    }
  }

  /** Async GPU-time accumulation (at most one map in flight; never stalls). */
  private pollTimestamps() {
    const staging = this.tsStaging
    if (!staging || this.tsInFlight) {
      return
    }
    this.tsInFlight = true
    staging
      .mapAsync(MapMode.READ, 0, 16)
      .then(() => {
        const t = new BigUint64Array(staging.getMappedRange(0, 16).slice(0))
        staging.unmap()
        this.tsInFlight = false
        this.stats.gpuMs += Number(t[1] - t[0]) / 1e6
      })
      .catch(() => {
        this.tsInFlight = false
      })
  }

  /** Async, never stalls the stroke: map the tripwire staging copy and flag
   * the stats/log on trip. At most one map in flight. */
  private pollTripwire() {
    const staging = this.tripStaging
    if (!staging || this.tripInFlight) {
      return
    }
    this.tripInFlight = true
    staging
      .mapAsync(MapMode.READ, 0, 4)
      .then(() => {
        const tripped = new Uint32Array(staging.getMappedRange(0, 4))[0] !== 0
        staging.unmap()
        this.tripInFlight = false
        if (tripped && !this.stats.tripwireTripped) {
          this.stats.tripwireTripped = true
          this.log(`non-finite tripwire: kernel '${this.kernel}' produced NaN/Inf at dab ${this.stats.dispatches}`)
        }
      })
      .catch(() => {
        this.tripInFlight = false
      })
  }
}
