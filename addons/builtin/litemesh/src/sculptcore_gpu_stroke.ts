/**
 * GPU brush-stroke controller (documentation/plans/gpuGlobalBrushes.md §5).
 *
 * Owns one stroke's GpuBrush_* seam session + GpuBrushStroke dispatcher on
 * behalf of SculptPaintOp: eligibility (D5), per-dab marshal + dispatch, the
 * coalesced async readback that keeps rendering current in the M2 shape, the
 * shadow-verify mode (CPU authoritative + per-dab GPU diff, §9.3), the
 * capture/replay fixture hook (§9.2), and the window.DEBUG.gpuBrush surface
 * (§9.1). All GPU work serializes through one promise chain so per-dab
 * readbacks, undo requests, and the stroke-end apply can never interleave.
 */

import {GpuBrushData, GpuBrushInfo, IWasmInterface, SculptHandle} from '@sculptcore/api/api'
import {SculptBrushes} from '@sculptcore/api/sculptcore/brush/SculptBrushes'

import {GpuBrushStroke, GpuBrushStats, ScatterTables} from '../../../../scripts/webgpu/brush_compute'
import {BufferUsage, MapMode} from '../../../../scripts/webgpu/flags'
import {getActiveWebGpuContext} from '../../../../scripts/render/queue_factory'
import {FeatureFlags} from '../../../../scripts/core/feature-flag'

import type {LiteMesh} from './litemesh'

const SHADOW_ATOL = 1e-5
const SHADOW_RTOL = 1e-4
const SHADOW_LOG_VERTS = 8

/** window.DEBUG.gpuBrush — the CDP-reachable debug surface (§9.1). */
export interface GpuBrushDebug {
  verbose: boolean
  /** Test hook: let non-modal (exec-replayed) strokes take the GPU path. The
   * headless parity harness drives SculptPaintOp through execTool, which is
   * non-modal; real replay determinism stays CPU because this defaults off. */
  allowNonModal: boolean
  /** Pending capture count: the next N GPU strokes record replay fixtures. */
  captureNext: number
  /** The last captured stroke fixture (tests/webgpu/replay.mjs format). */
  lastFixture: object | undefined
  /** The last (or live) stroke's stats object. */
  lastStats: GpuBrushStats | undefined
  /** Divergent-dab count reported by shadow-verify this session. */
  shadowDivergences: number
  capture(strokes?: number): void
  state(): object | undefined
  /** Mid-stroke: sync the CPU mesh from the GPU buffers so every existing
   * inspection tool sees live GPU state. No-op with no active GPU stroke. */
  forceReadback(): Promise<boolean>
  /** §9.6: after a forceReadback, byte-check one touched node's scattered pos
   * VBO against a CPU gather over the corner->vert map — the direct test of
   * the fill-order-disagreement risk. Requires an active GPU-resident stroke. */
  scatterSelfCheck(): Promise<object>
  /** Run the §9.6 self-check automatically at the next GPU stroke's finish
   * (before the final apply), storing the result in `lastSelfCheck` — the
   * hook headless drivers use (the stroke is finished by the time they can
   * call scatterSelfCheck directly). */
  selfCheckNext: boolean
  lastSelfCheck: object | undefined
}

/** Install (or fetch) window.DEBUG.gpuBrush. Exported for the headless parity
 * driver, which needs `allowNonModal` set before the first GPU stroke. */
export function ensureGpuBrushDebug(): GpuBrushDebug {
  return ensureDebugSurface()
}

function ensureDebugSurface(): GpuBrushDebug {
  const w = window as unknown as {DEBUG?: Record<string, unknown>}
  w.DEBUG = w.DEBUG ?? {}
  let dbg = w.DEBUG.gpuBrush as GpuBrushDebug | undefined
  if (!dbg) {
    dbg = {
      verbose          : false,
      allowNonModal    : false,
      selfCheckNext    : false,
      lastSelfCheck    : undefined,
      captureNext      : 0,
      lastFixture      : undefined,
      lastStats        : undefined,
      shadowDivergences: 0,
      capture(strokes = 1) {
        this.captureNext = strokes
      },
      state() {
        const c = activeController
        return {
          active : !!c,
          shadow : c?.shadow ?? false,
          stats  : this.lastStats,
          session: c
            ? {
                kernel              : c.stroke.kernel,
                elemCount           : c.stroke.elemCount,
                uniqueCount         : c.wasm.GpuBrush_info(c.session, GpuBrushInfo.UNIQUE_COUNT),
                nodeCount           : c.wasm.GpuBrush_info(c.session, GpuBrushInfo.NODE_COUNT),
                dabGen              : c.wasm.GpuBrush_info(c.session, GpuBrushInfo.DAB_GEN),
                lastBrushUniformsHex: hex(c.wasm.GpuBrush_data(c.session, GpuBrushData.BRUSH_UNIFORMS)),
                lastCtxUniformsHex  : hex(c.wasm.GpuBrush_data(c.session, GpuBrushData.CTX_UNIFORMS)),
              }
            : undefined,
        }
      },
      async forceReadback() {
        const c = activeController
        if (!c || !c.stroke.valid) {
          return false
        }
        await c.forceReadback()
        return true
      },
      async scatterSelfCheck() {
        const c = activeController
        if (!c || !c.stroke.valid) {
          return {checked: false, reason: 'no active GPU stroke'}
        }
        return c.scatterSelfCheck()
      },
    }
    w.DEBUG.gpuBrush = dbg
  }
  return dbg
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
    if ((i & 3) === 3) {
      out += ' '
    }
  }
  return out.trim()
}

/** The live stroke's controller (one GPU stroke at a time), for the debug
 * surface's mid-stroke hatches. */
let activeController: GpuStrokeController | undefined = undefined

/** Cross-stroke scatter-table cache (plan §3/§7): the corner->vert map upload
 * (~4 B/corner — tens of MB at 5M tris) is paid only when the spatial GPU
 * layout generation moves; per-stroke work is just re-resolving the node VBOs
 * (buffer identity is part of the generation contract). */
interface ScatterCacheEntry {
  gen: number
  mapBuf: GPUBuffer
  /** Parsed SCATTER_META records (u32×6 per node). */
  meta: Uint32Array
  /** Per-owner {cornerCount, mapOffset} uniform buffers, meta-index-aligned. */
  paramsBufs: GPUBuffer[]
}
const scatterCache = new WeakMap<LiteMesh, ScatterCacheEntry>()

export interface GpuStrokeBeginArgs {
  wasm: IWasmInterface
  mesh: LiteMesh
  /** Bound sculptcore::brush::Brush (already writeProps'd). */
  wasmBrush: SculptHandle
  meshLog: SculptHandle
  brushType: number
  /** Replay (non-modal exec) must stay on the CPU for determinism. */
  modalRunning: boolean
  dyntopoEnabled: boolean
  autosmooth: number
}

export class GpuStrokeController {
  readonly wasm: IWasmInterface
  readonly session: SculptHandle
  readonly stroke: GpuBrushStroke
  /** Shadow-verify: the CPU executor stays authoritative; the GPU runs in
   * parallel and every dab is diffed (§9.3). */
  readonly shadow: boolean
  /** Resolves when all enqueued GPU work (readbacks, final apply) has landed.
   * Undo/redo arriving mid-await chain onto it. */
  completion: Promise<void> = Promise.resolve()

  private mesh: LiteMesh
  private chain: Promise<void> = Promise.resolve()
  private readbackQueued = false
  private finished = false
  private debug: GpuBrushDebug

  /**
   * Evaluate D5 eligibility once per stroke and open the session + dispatcher.
   * Any miss returns undefined and the caller stays on the CPU path,
   * unchanged. Never throws.
   */
  static tryBegin(args: GpuStrokeBeginArgs): GpuStrokeController | undefined {
    try {
      const flagOn = FeatureFlags.get('sculptcore.gpu_brush') as boolean
      const shadowOn = FeatureFlags.get('sculptcore.gpu_brush_verify') as boolean
      if (!flagOn && !shadowOn) {
        return undefined
      }
      const debugSurface = ensureDebugSurface()
      if (!args.modalRunning && !debugSurface.allowNonModal) {
        return undefined
      }
      if (args.dyntopoEnabled || args.autosmooth > 0) {
        return undefined
      }
      // (View-normal masking needs no symmetry fallback: the kernel evaluates
      // the factor dynamically per dab from the ctx uniforms, so each mirror
      // image's dispatch carries its own reflected ray — binding 24 is the
      // image-independent cavity cache only.)
      // Kernel-map gate (M2 kelvinlet, M4 grab). Other tools stay CPU until
      // their kernels are A/B-gated per gpuGlobalBrushes.md non-goals. Grab
      // soaks behind its own flag (M6 default decision).
      if (args.brushType !== (SculptBrushes.KELVINLET as number) && args.brushType !== (SculptBrushes.GRAB as number)) {
        return undefined
      }
      if (
        args.brushType === (SculptBrushes.GRAB as number) &&
        !(FeatureFlags.get('sculptcore.gpu_brush_grab') as boolean) &&
        !shadowOn
      ) {
        return undefined
      }
      const device = getActiveWebGpuContext()?.device
      if (!device) {
        return undefined
      }
      const session = args.wasm.GpuBrush_beginStroke(
        args.mesh.mesh,
        args.mesh.spatial,
        args.wasmBrush,
        args.meshLog,
        args.brushType
      )
      if (!session) {
        return undefined
      }
      const debug = debugSurface
      const capture = debug.captureNext > 0
      if (capture) {
        debug.captureNext--
      }
      const stroke = new GpuBrushStroke({
        device,
        wasm: args.wasm,
        session,
        capture,
        log: (msg) => console.warn(`[gpu-brush] ${msg}`),
      })
      const ctl = new GpuStrokeController(args.wasm, args.mesh, session, stroke, shadowOn, debug)
      void stroke.begin().then((ok) => {
        if (!ok) {
          console.warn('[gpu-brush] begin failed; stroke falls back to CPU-applied finish')
        }
      })
      if (!shadowOn) {
        // M3: GPU-resident rendering — scatter into the node VBOs per dab
        // instead of the M2 per-dab readback (which stays as the fallback).
        ctl.tryEnableScatter()
      }
      return ctl
    } catch (e) {
      console.warn('[gpu-brush] tryBegin failed:', e)
      return undefined
    }
  }

  private constructor(
    wasm: IWasmInterface,
    mesh: LiteMesh,
    session: SculptHandle,
    stroke: GpuBrushStroke,
    shadow: boolean,
    debug: GpuBrushDebug
  ) {
    this.wasm = wasm
    this.mesh = mesh
    this.session = session
    this.stroke = stroke
    this.shadow = shadow
    this.debug = debug
    this.debug.lastStats = stroke.stats
    activeController = this
  }

  /**
   * Resolve the M3 scatter tables and hand them to the dispatcher: cached
   * corner->vert map (rebuilt only when SpatialTree::gpuLayoutGen moved) plus
   * this stroke's node-VBO lookups through the batch executor's buffer cache.
   * Any miss (no executor yet, a VBO not drawn/cached yet) leaves the stroke
   * on the M2 per-dab-readback shape — never throws.
   */
  private tryEnableScatter(): void {
    try {
      const exec = this.mesh.drawBatchExecutorGPU
      if (!exec) {
        return
      }
      const device = this.stroke.device
      const gen = this.wasm.GpuBrush_info(this.session, GpuBrushInfo.GPU_LAYOUT_GEN)
      let cache = scatterCache.get(this.mesh)
      if (!cache || cache.gen !== gen) {
        cache?.mapBuf.destroy()
        cache?.paramsBufs.forEach((b) => b.destroy())
        const metaBytes = this.wasm.GpuBrush_data(this.session, GpuBrushData.SCATTER_META).slice()
        const meta = new Uint32Array(metaBytes.buffer, 0, metaBytes.byteLength / 4)
        const mapBytes = this.wasm.GpuBrush_data(this.session, GpuBrushData.SCATTER_MAP)
        if (!meta.length || !mapBytes.length) {
          return
        }
        const mapBuf = device.createBuffer({
          label: 'gpuBrush.scatterMap',
          size : (mapBytes.byteLength + 3) & ~3,
          usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(mapBuf, 0, mapBytes, 0, mapBytes.byteLength)
        const paramsBufs: GPUBuffer[] = []
        for (let i = 0; i * 6 < meta.length; i++) {
          const params = device.createBuffer({
            label: `gpuBrush.scatterParams${i}`,
            size : 16,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
          })
          device.queue.writeBuffer(params, 0, new Uint32Array([meta[i * 6 + 5], meta[i * 6 + 4]]))
          paramsBufs.push(params)
        }
        cache = {gen, mapBuf, meta, paramsBufs}
        scatterCache.set(this.mesh, cache)
      }

      // Per-stroke: resolve each owner's pos/nor VBO by identity key.
      const owners: ScatterTables['owners'] = []
      let missing = 0
      for (let i = 0; i * 6 < cache.meta.length; i++) {
        const posKey = cache.meta[i * 6 + 0] + cache.meta[i * 6 + 1] * 0x100000000
        const norKey = cache.meta[i * 6 + 2] + cache.meta[i * 6 + 3] * 0x100000000
        const posBuf = exec.cachedBufferByKey(posKey)
        const norBuf = exec.cachedBufferByKey(norKey)
        if (!posBuf || !norBuf) {
          missing++
          owners.push(undefined as never)
          continue
        }
        owners.push({
          posBuf,
          norBuf,
          paramsBuf  : cache.paramsBufs[i],
          cornerCount: cache.meta[i * 6 + 5],
        })
      }
      if (missing === owners.length) {
        // Nothing drawn yet — no VBOs to scatter into; stay on readback.
        return
      }
      this.stroke.setScatter({mapBuf: cache.mapBuf, owners})
      if (missing > 0) {
        console.warn(`[gpu-brush] scatter: ${missing} node VBO(s) not cached yet (will readback-render)`)
      }
    } catch (e) {
      console.warn('[gpu-brush] scatter setup failed; staying on readback:', e)
    }
  }

  /**
   * §9.6 scatter-map self-check: read one touched owner's pos VBO back and
   * compare it corner-by-corner against a CPU gather of GpuBrush LIVE_CO over
   * the seam's corner->vert map (run forceReadback first so LIVE_CO reflects
   * the GPU state). Serialized on the chain; never throws.
   */
  scatterSelfCheck(): Promise<object> {
    let out: object = {checked: false, reason: 'not run'}
    return this.enqueue(async () => {
      out = await this.selfCheckInner()
    }).then(() => out)
  }

  /** The §9.6 check body — callers must hold the chain (enqueue / finish). */
  private async selfCheckInner(): Promise<object> {
    {
      const cache = scatterCache.get(this.mesh)
      const exec = this.mesh.drawBatchExecutorGPU
      if (!cache || !exec || !this.stroke.stats.gpuResident) {
        return {checked: false, reason: 'not GPU-resident'}
      }
      // Sync the CPU mesh from the GPU co first (LIVE_CO is the reference).
      const co = await this.stroke.readCo()
      if (!co) {
        return {checked: false, reason: 'readback failed'}
      }
      this.wasm.GpuBrush_applyCo(this.session, co)
      const tBytes = this.wasm.GpuBrush_data(this.session, GpuBrushData.TOUCHED_OWNERS)
      const touched = new Uint32Array(tBytes.buffer, tBytes.byteOffset, tBytes.byteLength / 4)
      const idx = touched.length ? touched[0] : 0
      const posKey = cache.meta[idx * 6 + 0] + cache.meta[idx * 6 + 1] * 0x100000000
      const mapOffset = cache.meta[idx * 6 + 4]
      const cornerCount = cache.meta[idx * 6 + 5]
      const posBuf = exec.cachedBufferByKey(posKey)
      if (!posBuf || !cornerCount) {
        return {checked: false, reason: 'owner VBO not cached'}
      }
      const byteLen = cornerCount * 12
      const staging = this.stroke.device.createBuffer({
        label: 'gpuBrush.scatterSelfCheck',
        size : (byteLen + 3) & ~3,
        usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
      })
      const enc = this.stroke.device.createCommandEncoder()
      enc.copyBufferToBuffer(posBuf, 0, staging, 0, byteLen)
      this.stroke.device.queue.submit([enc.finish()])
      await staging.mapAsync(MapMode.READ, 0, byteLen)
      const got = new Float32Array(staging.getMappedRange(0, byteLen).slice(0))
      staging.unmap()
      staging.destroy()

      const mapBytes = this.wasm.GpuBrush_data(this.session, GpuBrushData.SCATTER_MAP).slice()
      const map = new Uint32Array(mapBytes.buffer, 0, mapBytes.byteLength / 4)
      let bad = 0
      let maxErr = 0
      for (let s = 0; s < cornerCount; s++) {
        const v = map[mapOffset + s]
        for (let j = 0; j < 3; j++) {
          const e = Math.abs(got[s * 3 + j] - co[v * 3 + j])
          maxErr = Math.max(maxErr, e)
          if (e > 1e-6) {
            bad++
            break
          }
        }
      }
      const result = {checked: true, ownerIdx: idx, cornerCount, badCorners: bad, maxErr}
      if (bad > 0) {
        console.warn('[gpu-brush] scatter self-check FAILED:', result)
      }
      return result
    }
  }

  /**
   * Marshal + dispatch one dab image. Returns true when the GPU path is still
   * healthy; the caller keeps its CPU work only in shadow mode. In pure GPU
   * mode a coalesced async readback keeps rendering current (M2 shape).
   */
  dab(
    center: ArrayLike<number | undefined>,
    normal: ArrayLike<number | undefined>,
    radius: number,
    filterRadius: number,
    mirrorIdx: number,
    nonAccum: boolean
  ): boolean {
    if (this.finished) {
      return false
    }
    const t0 = performance.now()
    const n = this.wasm.GpuBrush_marshalDab(
      this.session,
      center[0] ?? 0,
      center[1] ?? 0,
      center[2] ?? 0,
      normal[0] ?? 0,
      normal[1] ?? 0,
      normal[2] ?? 1,
      radius,
      filterRadius,
      mirrorIdx,
      nonAccum ? 1 : 0
    )
    this.stroke.stats.marshalMs += performance.now() - t0
    if (mirrorIdx === 0) {
      this.stroke.stats.dabs++
    }
    if (n > 0) {
      const touched = this.stroke.stats.gpuResident
        ? (() => {
            const t = this.wasm.GpuBrush_data(this.session, GpuBrushData.TOUCHED_OWNERS)
            return new Uint32Array(t.buffer, t.byteOffset, t.byteLength / 4)
          })()
        : undefined
      this.stroke.dab(n, touched)
    }
    if (this.stroke.valid && !this.shadow && !this.stroke.stats.gpuResident) {
      this.scheduleReadback()
    }
    if (this.stroke.valid && !this.shadow && this.stroke.stats.gpuResident && mirrorIdx === 0) {
      // GPU-resident: rendering currency comes from the scatter pass; just
      // repaint (the render queue orders after our compute submit — D3).
      window.redraw_viewport()
    }
    if (this.stroke.valid && this.shadow && mirrorIdx === 0) {
      this.scheduleShadowDiff()
    }
    if (this.debug.verbose) {
      console.log(
        `[gpu-brush] dab ${this.stroke.stats.dabs} img ${mirrorIdx}: ${n} workgroups, ` +
          `${this.wasm.GpuBrush_info(this.session, GpuBrushInfo.UNIQUE_COUNT)} verts`
      )
    }
    return this.stroke.valid
  }

  /** Drop the GPU stroke before any dispatch landed (begin failed): free the
   * session so the caller can run the whole stroke on the CPU path. */
  abort() {
    this.finished = true
    activeController = undefined
    this.wasm.GpuBrush_free(this.session)
    this.stroke.destroy()
  }

  /** Mid-stroke CPU sync for the debug surface: readback + applyCo + spatial
   * refresh, serialized on the chain. */
  forceReadback(): Promise<void> {
    return this.enqueue(async () => {
      const co = await this.stroke.readCo()
      if (co && !this.finished) {
        this.wasm.GpuBrush_applyCo(this.session, co)
        this.refreshMesh()
      }
    })
  }

  /**
   * Close the stroke (§5): final readback → GpuBrush_endStroke (snapshot +
   * write + dirty + free) → mesh refresh → `tail` (the op's endStep/dispose
   * sequence). In shadow mode the CPU already owns the mesh, so the session is
   * freed without an apply. `tail` runs exactly once, even on GPU failure.
   * Returns the completion promise (also stored on `.completion`).
   */
  finish(tail: () => void): Promise<void> {
    this.finished = true
    activeController = undefined
    this.completion = this.enqueue(async () => {
      try {
        if (!this.shadow && this.debug.selfCheckNext && this.stroke.stats.gpuResident) {
          // §9.6 hook: check the scatter output against the CPU gather before
          // the final apply refreshes the VBOs from the CPU mesh.
          this.debug.selfCheckNext = false
          this.debug.lastSelfCheck = await this.selfCheckInner()
        }
        if (this.shadow) {
          // CPU path owns the mesh; drop the GPU side.
          this.wasm.GpuBrush_free(this.session)
        } else {
          const co = this.stroke.valid ? await this.stroke.readCo() : null
          if (this.stroke.stats.tripwireTripped) {
            // §9.4: a poisoned buffer must never reach the mesh or the undo
            // step — finish from the CPU state (per-dab applies already
            // landed only finite-checked-late data; the conservative choice
            // is to keep whatever the mesh already holds).
            console.warn('[gpu-brush] tripwire tripped — discarding final GPU readback')
            this.wasm.GpuBrush_endStroke(this.session, null, null)
          } else if (co) {
            const fixture = this.stroke.captureFixture(co)
            if (fixture) {
              this.debug.lastFixture = fixture
              console.warn('[gpu-brush] stroke fixture captured (DEBUG.gpuBrush.lastFixture)')
            }
            this.wasm.GpuBrush_endStroke(this.session, co, null)
          } else {
            // GPU died mid-stroke: per-dab applies (if any) already landed
            // consistent geometry; endStroke(null) just frees.
            this.wasm.GpuBrush_endStroke(this.session, null, null)
          }
          this.refreshMesh()
        }
      } finally {
        this.stroke.destroy()
        tail()
      }
    })
    // Test/report seam: the headless harness awaits this before reading
    // buffers (the finalization is mapAsync-bearing).
    ;(window as unknown as {__gpuBrushCompletion?: Promise<void>}).__gpuBrushCompletion = this.completion
    return this.completion
  }

  // -----------------------------------------------------------------------

  /** Serialize all GPU work; errors are logged, never thrown into callers. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((e) => {
      console.warn('[gpu-brush] async stage failed:', e)
    })
    return this.chain
  }

  /** Coalesced per-dab readback: at most one queued at a time — a burst of
   * dabs costs one readback, not N (the debug app's per-frame flush shape). */
  private scheduleReadback() {
    if (this.readbackQueued) {
      return
    }
    this.readbackQueued = true
    void this.enqueue(async () => {
      this.readbackQueued = false
      if (this.finished || !this.stroke.valid) {
        return
      }
      const co = await this.stroke.readCo()
      if (co && !this.finished) {
        this.wasm.GpuBrush_applyCo(this.session, co)
        this.refreshMesh()
      }
    })
  }

  /** §9.3: diff the GPU buffers against the authoritative CPU mesh after a
   * dab. On breach: log the first N divergent verts, auto-capture, and
   * re-sync the GPU co buffer so divergence never compounds. */
  private scheduleShadowDiff() {
    void this.enqueue(async () => {
      if (this.finished || !this.stroke.valid) {
        return
      }
      const gpuCo = await this.stroke.readCo()
      if (!gpuCo || this.finished) {
        return
      }
      const liveBytes = this.wasm.GpuBrush_data(this.session, GpuBrushData.LIVE_CO).slice()
      const cpuCo = new Float32Array(liveBytes.buffer, 0, liveBytes.byteLength / 4)
      const uvBytes = this.wasm.GpuBrush_data(this.session, GpuBrushData.UVERTS).slice()
      const uverts = new Uint32Array(uvBytes.buffer, 0, uvBytes.byteLength / 4)

      let divergent = 0
      for (const v of uverts) {
        let bad = false
        for (let j = 0; j < 3; j++) {
          const a = cpuCo[v * 3 + j]
          const b = gpuCo[v * 3 + j]
          const d = Math.abs(a - b)
          if (d > SHADOW_ATOL + SHADOW_RTOL * Math.abs(a)) {
            bad = true
            break
          }
        }
        if (!bad) {
          continue
        }
        divergent++
        if (divergent <= SHADOW_LOG_VERTS) {
          console.warn(
            `[gpu-brush] shadow-verify divergence v${v}: cpu(${cpuCo[v * 3]}, ${cpuCo[v * 3 + 1]}, ` +
              `${cpuCo[v * 3 + 2]}) gpu(${gpuCo[v * 3]}, ${gpuCo[v * 3 + 1]}, ${gpuCo[v * 3 + 2]})`
          )
        }
      }
      if (divergent > 0) {
        this.debug.shadowDivergences++
        console.warn(
          `[gpu-brush] shadow-verify: ${divergent}/${uverts.length} divergent verts at dab ` +
            `${this.stroke.stats.dabs}; re-syncing GPU from CPU`
        )
        const fixture = this.stroke.captureFixture(gpuCo)
        if (fixture) {
          this.debug.lastFixture = fixture
        }
        this.stroke.resyncCo(cpuCo)
      } else if (this.debug.verbose) {
        console.log(`[gpu-brush] shadow-verify dab ${this.stroke.stats.dabs}: 0 divergent`)
      }
    })
  }

  private refreshMesh() {
    this.mesh.regenTreeBatch()
    // Queries half only: this call exists for query currency after a GPU
    // readback; the redraw's drawQ full update runs the GPU buffer half.
    this.mesh.spatial.updateQueries()
    this.mesh.regenBounds()
    window.redraw_viewport()
  }
}
