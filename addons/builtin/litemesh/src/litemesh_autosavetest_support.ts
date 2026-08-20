/**
 * Integration-test support for the autosave split-serialization pipeline under
 * a live dyntopo sculpt. Exposes `globalThis.__autosaveTest()`, an async driver
 * the NW.js headless harness awaits from `--eval` (see
 * `tests/integration/sculptcore_autosave.test.ts`); its result is reflected
 * into the `--dump` JSON as `autosavetest`.
 *
 * For ~5 seconds it runs randomly-placed dyntopo DRAW strokes on the spherified
 * `litemesh-cube`, mutating topology continuously. Two save times are chosen at
 * random within that interval (one in the early half, one in the late half so
 * the two snapshots are guaranteed distinct); at each, the real AutosaveManager's
 * split serializer produces the autosave bytes through the M3 split path
 * (Mesh_serializeRaw → lz4 → WASV container) and stashes them. After the 5s, each
 * stashed save is validated independently: its WASV framing is checked, it is
 * loaded back, and the reloaded geometry's position-buffer signature is compared
 * to the signature captured at save time (order-independent aggregates, so leaf
 * re-batching on reload is tolerated). Geometry is observed through the GPU
 * position buffer — the backend-agnostic bulk-data seam, as in the brush/parity
 * drivers.
 *
 * Macrotask discipline: the headless harness has no real WebGPU surface, and the
 * path.ux 20 ms screen-tick interval draws the live dyntopo mesh whenever control
 * reaches the macrotask queue — which wedges. So the driver never yields to a
 * macrotask: the stroke loop is synchronous, saves use the inline (worker-free)
 * SplitSerializer (microtask-only), and validation loads via the synchronous
 * `loadFile` rather than `loadSplitAutosave` (whose `loadFileAsync` is a
 * setInterval-driven generator). Disk I/O (saveNow/readBackup) is likewise a
 * macrotask, so the in-memory serialized bytes are validated directly.
 */

import {getAppState} from '@framework/api'
import {AutosaveManager} from '../../../../scripts/core/autosave'
import {isAutosaveContainer, parseAutosaveContainer} from '../../../../scripts/core/autosave_format'
import {SplitSerializer} from '../../../../scripts/core/autosave_serialize'
import {setDeferredBlobResolver} from '../../../../scripts/core/serialize_cache'
import {DynTopoFlagsSC, SculptTools} from '../../../../scripts/brush/brush_base'
import {SculptBrush, DefaultBrushes} from '../../../../scripts/brush/index'
import {runSculptcoreStroke} from './sculptcore_ops'
import {LiteMesh} from './litemesh'

/** Geometry fingerprint of the concatenated GPU position buffer. The buffer
 * duplicates leaf-shared vertices, so floatCount/sum/sumAbs scale with the
 * spatial-tree partition (which differs live vs. freshly-loaded); the round-trip
 * comparison leans on the partition-invariant min/max + per-float means. */
interface PosSig {
  floatCount: number
  sum: number
  sumAbs: number
  min: number
  max: number
  finite: boolean
}

interface SaveRecord {
  index: number
  scheduledMs: number
  firedAtMs: number
  strokesBefore: number
  backupKey: string | null
  bytesLen: number
  sigAtSave: PosSig
  /** WASV framing (filled during the post-loop validation pass). */
  containerValid?: boolean
  blobCount?: number
  shellLen?: number
  parseError?: string
  /** Round-trip result. */
  sigLoaded?: PosSig
  finite?: boolean
  sigMatch?: boolean
}

interface AutosaveTestResult {
  ok: boolean
  error?: string
  /** Last stage entered — so a hang/timeout is diagnosable from the dump. */
  lastStage?: string
  seed?: number
  backendKind?: string
  usedManager?: boolean
  durationMs?: number
  totalStrokes?: number
  saveTimes?: number[]
  saves?: SaveRecord[]
}

interface BufWasm {
  HEAPU8?: {buffer: ArrayBufferLike}
  gpu: Record<string, unknown>
  getBoundVector(name: string, vec: unknown): ArrayLike<unknown>
  pointerBytes?(bound: unknown, member: string, byteLen: number): Uint8Array | undefined
}
interface BufDesc {
  size: number
  elemsize: number
  name?: string
  data?: number
}

/** Concatenate every GPU buffer named `name` (after a spatial.update refresh).
 * The stream is split into per-leaf batches sharing a name; reading just the
 * first covers only part of the mesh. Copies — buffers are reused across strokes. */
function readPos(lm: LiteMesh): Float32Array | undefined {
  const wasm = lm.wasm as unknown as BufWasm
  const spatial = lm.spatial as unknown as {update?: (gpu: unknown) => boolean}
  // spatial.update flushes pending edits and returns whether any were pending;
  // bump meshRevision on a real change so the autosave M2 blob cache invalidates
  // (the live app's per-frame draw path does this; the headless test has none).
  if (spatial.update?.(wasm.gpu)) lm.meshRevision++
  const buffersVec = (wasm.gpu as {buffers?: unknown}).buffers
  const buffers =
    wasm.HEAPU8 !== undefined
      ? (buffersVec as ArrayLike<BufDesc>)
      : (wasm.getBoundVector('', buffersVec) as ArrayLike<BufDesc>)
  const parts: Float32Array[] = []
  let total = 0
  for (let i = 0; i < (buffers.length | 0); i++) {
    const buf = buffers[i]
    if (!buf || buf.name !== 'position' || !(buf.size | 0) || !(buf.elemsize | 0)) continue
    const floatCount = (buf.size | 0) * (buf.elemsize | 0)
    const bytes = floatCount * 4
    let u8: Uint8Array | undefined
    if (wasm.HEAPU8 !== undefined) {
      u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data as number, bytes)
    } else {
      u8 = wasm.pointerBytes?.(buf, 'data', bytes)
    }
    if (!u8 || u8.length < bytes) return undefined
    parts.push(new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + bytes)))
    total += floatCount
  }
  if (!parts.length) return undefined
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function signature(f: Float32Array | undefined): PosSig {
  const sig: PosSig = {floatCount: 0, sum: 0, sumAbs: 0, min: Infinity, max: -Infinity, finite: true}
  if (!f) {
    sig.finite = false
    return sig
  }
  sig.floatCount = f.length
  for (let i = 0; i < f.length; i++) {
    const v = f[i]
    if (!Number.isFinite(v)) sig.finite = false
    sig.sum += v
    sig.sumAbs += Math.abs(v)
    if (v < sig.min) sig.min = v
    if (v > sig.max) sig.max = v
  }
  return sig
}

/** Save-time vs reloaded comparison. floatCount/sum/sumAbs aren't preserved
 * across the reload's re-partition, so compare the partition-invariant bounding
 * box (min/max) and per-float means, with both sides non-empty. */
function sigClose(a: PosSig, b: PosSig): boolean {
  if (a.floatCount === 0 || b.floatCount === 0) return false
  const rel = (x: number, y: number, eps: number) => Math.abs(x - y) <= eps * (1 + Math.abs(x) + Math.abs(y))
  const meanA = a.sum / a.floatCount
  const meanB = b.sum / b.floatCount
  const absA = a.sumAbs / a.floatCount
  const absB = b.sumAbs / b.floatCount
  return rel(a.min, b.min, 1e-3) && rel(a.max, b.max, 1e-3) && rel(meanA, meanB, 5e-3) && rel(absA, absB, 5e-3)
}

async function autosaveTest(): Promise<AutosaveTestResult> {
  const result: AutosaveTestResult = {ok: false}
  const stash: Array<Uint8Array | undefined> = []
  // Record the last stage entered so a failure (or unexpected hang) is
  // diagnosable from the --dump JSON; the renderer console isn't forwarded.
  const setStage = (s: string) => {
    result.lastStage = s
  }
  setStage('start')
  try {
    const app = getAppState()
    let mesh = app.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')

    let draw: SculptBrush | undefined
    for (const k in DefaultBrushes.brushes) {
      const b = DefaultBrushes.brushes[k]
      if (b && b.tool === SculptTools.DRAW) draw = b
    }
    if (!draw) throw new Error('no default DRAW brush')

    // Seeded PRNG so a failing run is reproducible from the logged seed; seeded
    // off the wall clock so each run picks fresh strokes + save times.
    let s = (Date.now() ^ 0x9e3779b9) >>> 0
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
    result.seed = s

    // Manager + backend with the real split serializer; force autosave on with
    // ≥2 rotating slots so two distinct backups survive (don't write next to a
    // nonexistent project file). Use an inline (worker-free) SplitSerializer:
    // it exercises the full M3 split path (placeholder shell + DeferredBlobCollector
    // + lz4 + WASV container) deterministically, without the compression Web Worker
    // — which can construct but never load/respond under the headless renderer.
    const mgr = new AutosaveManager(app as never, new SplitSerializer())
    app.settings.autosaveEnabled = true
    app.settings.autosaveMaxBackups = 4
    app.settings.autosaveToProjectDir = false
    result.backendKind = mgr.backend?.kind ?? 'none'

    const draws = draw
    draws.tool = SculptTools.DRAW
    draws.dynTopoSC.flag |= DynTopoFlagsSC.ENABLED

    const extent = (): number => {
      const p = readPos(mesh as LiteMesh)
      let r = 0
      if (p) for (let i = 0; i < p.length; i++) if (Math.abs(p[i]) > r) r = Math.abs(p[i])
      return r || 1
    }
    const R = extent()

    const randomStroke = () => {
      const pos = readPos(mesh as LiteMesh)
      if (!pos || pos.length < 3) return
      const vi = (rand() * (pos.length / 3)) | 0
      const p = [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]
      const pl = Math.hypot(p[0], p[1], p[2]) || 1
      const normal = [p[0] / pl, p[1] / pl, p[2] / pl]
      const radius = R * (0.15 + rand() * 0.25)
      draws.strength = 0.3 + rand() * 0.4
      const dabCount = 1 + ((rand() * 3) | 0)
      const dabs = Array.from({length: dabCount}, () => ({p, normal}))
      runSculptcoreStroke({mesh: mesh as LiteMesh, brush: draws, dabs, radius})
    }

    // First stroke re-batches the GPU buffers (length changes); warm up so the
    // measured layout is settled before the timed loop.
    draws.strength = 0
    randomStroke()
    ;(mesh as LiteMesh).regenTreeBatch()

    const DURATION = 5000
    // Two random save times: one in the early window, one in the late window —
    // distinct, spaced, and both inside the interval with strokes between them.
    const saveTimes = [(0.1 + rand() * 0.3) * DURATION, (0.55 + rand() * 0.3) * DURATION]
    result.saveTimes = saveTimes.slice()
    result.durationMs = DURATION

    const saves: SaveRecord[] = []
    const doSave = async (index: number, strokesBefore: number, firedAtMs: number) => {
      setStage(`save${index}:serialize`)
      const sigAtSave = signature(readPos(mesh as LiteMesh))
      // The inline SplitSerializer resolves through microtasks only (createFile
      // is synchronous; lz4 compress is sync-in-async), so this await never lets
      // a macrotask fire. It produces the exact bytes the file backend would
      // write — the disk write/read itself is a macrotask and is skipped.
      const bytes = await mgr.serializer.serialize(app as never)
      stash.push(bytes)
      saves.push({
        index,
        scheduledMs: saveTimes[index],
        firedAtMs,
        strokesBefore,
        backupKey: null,
        bytesLen : bytes?.length ?? 0,
        sigAtSave,
      })
    }

    setStage('stroke-loop')
    const t0 = Date.now()
    let strokes = 0
    let saveIdx = 0
    // Synchronous loop (no setTimeout pacing): strokes run back-to-back until the
    // wall-clock window elapses, so control never reaches the macrotask queue.
    while (Date.now() - t0 < DURATION) {
      randomStroke()
      strokes++
      const elapsed = Date.now() - t0
      if (saveIdx < saveTimes.length && elapsed >= saveTimes[saveIdx]) {
        await doSave(saveIdx, strokes, elapsed)
        saveIdx++
      }
    }
    result.totalStrokes = strokes
    // Fire any save whose window didn't elapse before the loop ended.
    while (saveIdx < saveTimes.length) {
      await doSave(saveIdx, strokes, Date.now() - t0)
      saveIdx++
    }

    result.usedManager = !!mgr.backend
    result.saves = saves

    // Validation pass: each stashed save is framed-checked, loaded back through
    // the split path, and its reloaded geometry signature compared to save time.
    setStage('validate')
    for (let i = 0; i < stash.length; i++) {
      const bytes = stash[i]
      const rec = saves[i]
      if (!bytes) {
        rec.containerValid = false
        continue
      }
      rec.containerValid = isAutosaveContainer(bytes)
      let parsed
      try {
        parsed = parseAutosaveContainer(bytes)
        rec.blobCount = parsed.blobs.size
        rec.shellLen = parsed.shell.length
      } catch (err) {
        rec.parseError = String(err)
        continue
      }
      setStage(`load${i}`)
      // Synchronous equivalent of loadSplitAutosave: install the blobId→bytes
      // resolver, then load the shell through the inline loadFile (its async twin
      // loadFileAsync is a setInterval-driven generator = macrotask).
      setDeferredBlobResolver((id) => parsed!.blobs.get(id))
      try {
        const shellBuf = parsed.shell.slice().buffer
        ;(app as unknown as {loadFile(buf: ArrayBuffer, args: object): void}).loadFile(shellBuf, {
          reset_toolstack: true,
          load_screen    : true,
          reset_context  : true,
        })
      } finally {
        setDeferredBlobResolver(null)
      }
      mesh = app.ctx?.object?.data
      if (!(mesh instanceof LiteMesh)) {
        rec.sigMatch = false
        continue
      }
      const sigLoaded = signature(readPos(mesh))
      rec.sigLoaded = sigLoaded
      rec.finite = sigLoaded.finite
      rec.sigMatch = sigClose(rec.sigAtSave, sigLoaded)
    }

    mgr.dispose()
    setStage('done')
    result.ok = true
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  ;(globalThis as {__autosaveTestResult?: AutosaveTestResult}).__autosaveTestResult = result
  return result
}

;(globalThis as {__autosaveTest?: typeof autosaveTest}).__autosaveTest = autosaveTest

export {autosaveTest}
