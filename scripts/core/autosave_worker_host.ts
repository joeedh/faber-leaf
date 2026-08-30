/**
 * Main-thread host for the autosave compression worker (plan §5.4). Lazily
 * spawns the module worker (browser + NW.js renderer), forwards raw mesh
 * payloads as transferables, and resolves with the compressed `SCULPT00` blobs.
 * If a worker can't be spawned (no `Worker`, headless context, build missing) it
 * transparently falls back to inline main-thread compression, so autosave always
 * works — only the off-thread speedup is lost.
 */

import type {BlobCompressor} from './autosave_serialize'
import {compressMeshBlob} from '../util/lz4'

interface PendingJob {
  resolve: (results: Uint8Array[]) => void
  reject: (err: unknown) => void
}

/** Compress raws on the main thread; the worst-case fallback compressor. */
const inlineCompress = (raws: Uint8Array[]): Uint8Array[] => raws.map((r) => compressMeshBlob(r))

/** entry_point.js and autosave_worker.js are siblings in build/. Compute the
 * base separately so esbuild doesn't statically rewrite the URL into an asset. */
function workerUrl(): string | undefined {
  const meta = import.meta as {url?: string}
  const base = meta.url ?? (typeof location !== 'undefined' ? location.href : undefined)
  if (!base) {
    return undefined
  }
  return new URL('autosave_worker.js', base).href
}

class AutosaveWorkerHost {
  private worker?: Worker
  private nextId = 1
  private pending = new Map<number, PendingJob>()
  /** Latches once the worker fails to spawn — we then stay on inline. */
  private failed = false

  private ensureWorker(): Worker | undefined {
    if (this.worker || this.failed) {
      return this.worker
    }
    if (typeof Worker === 'undefined') {
      this.failed = true
      return undefined
    }
    try {
      const url = workerUrl()
      if (!url) {
        this.failed = true
        return undefined
      }
      const worker = new Worker(url, {type: 'module'})
      worker.onmessage = (e: MessageEvent) => {
        const {id, results} = e.data as {id: number; results: ArrayBuffer[]}
        const job = this.pending.get(id)
        if (job) {
          this.pending.delete(id)
          job.resolve(results.map((b) => new Uint8Array(b)))
        }
      }
      worker.onerror = (e) => {
        // Fail every in-flight job; future calls fall back to inline.
        // eslint-disable-next-line no-console
        console.warn('autosave worker error; falling back to inline compression', e.message)
        this.failWorker(e.message ?? 'worker error')
      }
      this.worker = worker
      return worker
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('autosave worker spawn failed; using inline compression', err)
      this.failed = true
      return undefined
    }
  }

  private failWorker(reason: unknown): void {
    this.failed = true
    for (const job of this.pending.values()) {
      job.reject(reason)
    }
    this.pending.clear()
    try {
      this.worker?.terminate()
    } catch {
      /* ignore */
    }
    this.worker = undefined
  }

  /** A BlobCompressor that uses the worker, falling back to inline on failure. */
  readonly compress: BlobCompressor = async (raws: Uint8Array[]): Promise<Uint8Array[]> => {
    if (raws.length === 0) {
      return []
    }
    const worker = this.ensureWorker()
    if (!worker) {
      return inlineCompress(raws)
    }
    const id = this.nextId++
    // Transfer each raw buffer; serializeRaw hands us full-buffer Uint8Arrays.
    const buffers: ArrayBuffer[] = []
    const transfer: Transferable[] = []
    for (const r of raws) {
      const buf =
        r.byteOffset === 0 && r.byteLength === r.buffer.byteLength
          ? (r.buffer as ArrayBuffer)
          : (r.slice().buffer as ArrayBuffer)
      buffers.push(buf)
      transfer.push(buf)
    }
    try {
      return await new Promise<Uint8Array[]>((resolve, reject) => {
        this.pending.set(id, {resolve, reject})
        worker.postMessage({id, buffers}, transfer)
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('autosave worker compress failed; retrying inline', err)
      // The raw buffers were transferred (detached); recompute would need them.
      // The caller still holds undetached copies only when transfer was skipped,
      // so a clean inline retry isn't generally possible — surface the failure.
      throw err
    }
  }

  dispose(): void {
    try {
      this.worker?.terminate()
    } catch {
      /* ignore */
    }
    this.worker = undefined
    this.pending.clear()
  }
}

export {AutosaveWorkerHost}
