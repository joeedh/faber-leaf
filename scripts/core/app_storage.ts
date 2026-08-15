/**
 * Persistence backend for the startup file and user settings.
 *
 * Browser builds keep using `localStorage` (blobs base64-encoded under their
 * existing keys, so web behavior is unchanged). The NW.js build instead writes
 * discrete files under a `.sculptcore` directory at `<cwd>/.sculptcore` (the
 * repo root when launched via `pnpm run nwjs` or the test harness). The
 * renderer computes this itself — NW.js merges the Node + browser contexts, so
 * `require('fs')`/`require('path')` and `process.cwd()` are available directly.
 *
 * The API is synchronous on purpose: `fs.*Sync` is available under NW.js,
 * letting the existing sync save/load call sites stay sync. NW.js starts fresh
 * from `.sculptcore`; it does not migrate old `localStorage` data.
 */

import * as util from '../util/util'
import {APP_KEY_NAME} from './const'

export interface AppStorage {
  /** Binary blob (e.g. the compressed startup file). */
  getBlob(key: string): Uint8Array | undefined
  setBlob(key: string, data: ArrayBuffer | Uint8Array): void
  /** UTF-8 text (e.g. settings JSON). */
  getText(key: string): string | undefined
  setText(key: string, data: string): void
  /**
   * Optimistic read-merge-write for state shared across instances (settings,
   * feature flags). `merge` receives the freshest on-disk text and returns the
   * bytes to commit; the write is atomic and retried if another instance wrote
   * between our read and commit. Tiny residual races (two instances committing
   * within the same recheck window) resolve to last-writer-wins and are healed
   * by the polling sync — see storage_sync.ts.
   */
  updateText(key: string, merge: (current: string | undefined) => string): void
  remove(key: string): void
  /** Opaque change token (mtime:size) for cross-instance polling; undefined if
   * absent or not file-backed (the browser is single-instance, no polling). */
  version(key: string): string | undefined
  /** True when backed by `.sculptcore` files rather than localStorage. */
  readonly isFileBacked: boolean
  readonly baseDir?: string
}

/** Sync sleep for the brief atomic-rename retry (SharedArrayBuffer is enabled
 * in the NW.js manifest; a no-op busy fallback covers its absence). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* spin */
    }
  }
}

function toU8(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

class BrowserAppStorage implements AppStorage {
  readonly isFileBacked = false

  getBlob(key: string): Uint8Array | undefined {
    const v = window.localStorage[key]
    return v === undefined ? undefined : util.atob(v)
  }

  setBlob(key: string, data: ArrayBuffer | Uint8Array): void {
    window.localStorage[key] = util.btoa(toU8(data))
  }

  getText(key: string): string | undefined {
    return window.localStorage[key]
  }

  setText(key: string, data: string): void {
    window.localStorage[key] = data
  }

  updateText(key: string, merge: (current: string | undefined) => string): void {
    // Single-threaded: no cross-instance concurrency to guard against.
    this.setText(key, merge(this.getText(key)))
  }

  remove(key: string): void {
    delete window.localStorage[key]
  }

  version(): undefined {
    return undefined
  }
}

// localStorage key → on-disk filename. Unmapped keys fall back to a sanitized
// name; the three real consumers are listed explicitly. The filenames are fixed,
// so the app-name rename moved only the keys — no on-disk migration is needed.
const FILE_NAMES: Record<string, string> = {
  [APP_KEY_NAME]              : 'startup.bin',
  [`${APP_KEY_NAME}-settings`]: 'settings.json',
  'feature-flags-app'       : 'feature-flags.json',
}

interface NodeFsSync {
  existsSync(p: string): boolean
  mkdirSync(p: string, opts: {recursive: boolean}): void
  readFileSync(p: string, enc?: string): Uint8Array | string
  writeFileSync(p: string, data: Uint8Array | string): void
  renameSync(from: string, to: string): void
  statSync(p: string): {mtimeMs: number; size: number}
  rmSync?(p: string, opts: {force: boolean}): void
  unlinkSync(p: string): void
}
interface NodePath {
  join(...parts: string[]): string
}

class NwjsAppStorage implements AppStorage {
  readonly isFileBacked = true
  readonly baseDir: string
  private fs: NodeFsSync
  private pathlib: NodePath

  constructor(baseDir: string, fs: NodeFsSync, pathlib: NodePath) {
    this.baseDir = baseDir
    this.fs = fs
    this.pathlib = pathlib
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, {recursive: true})
    }
  }

  private file(key: string): string {
    const name = FILE_NAMES[key] ?? key.replace(/[^\w.-]/g, '_') + '.dat'
    return this.pathlib.join(this.baseDir, name)
  }

  /** Atomic write: full write to a unique temp then rename over the target, so
   * a concurrent reader never sees a truncated file. The rename can transiently
   * EPERM on Windows (AV / indexer / open handle); retry briefly. */
  private writeAtomic(p: string, data: Uint8Array | string): void {
    const tmp = `${p}.${_procId()}.tmp`
    this.fs.writeFileSync(tmp, data)
    for (let i = 0; ; i++) {
      try {
        this.fs.renameSync(tmp, p)
        return
      } catch (err) {
        const code = (err as {code?: string}).code
        if (i >= 20 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EEXIST')) {
          try {
            this.fs.unlinkSync(tmp)
          } catch {
            /* ignore */
          }
          throw err
        }
        sleepSync(5)
      }
    }
  }

  getBlob(key: string): Uint8Array | undefined {
    const p = this.file(key)
    if (!this.fs.existsSync(p)) return undefined
    return new Uint8Array(this.fs.readFileSync(p) as Uint8Array)
  }

  setBlob(key: string, data: ArrayBuffer | Uint8Array): void {
    this.writeAtomic(this.file(key), toU8(data))
  }

  getText(key: string): string | undefined {
    const p = this.file(key)
    if (!this.fs.existsSync(p)) return undefined
    return this.fs.readFileSync(p, 'utf8') as string
  }

  setText(key: string, data: string): void {
    this.writeAtomic(this.file(key), data)
  }

  version(key: string): string | undefined {
    try {
      const s = this.fs.statSync(this.file(key))
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return undefined
    }
  }

  updateText(key: string, merge: (current: string | undefined) => string): void {
    // Optimistic CAS: read the on-disk state, merge, and commit only if nothing
    // wrote in between; retry on conflict. The recheck-before-commit narrows the
    // race to a sub-ms window that last-writer-wins + polling sync absorb.
    for (let attempt = 0; attempt < 50; attempt++) {
      const before = this.version(key)
      const next = merge(this.getText(key))
      if (this.version(key) !== before) {
        sleepSync(2)
        continue
      }
      this.writeAtomic(this.file(key), next)
      return
    }
    // Contention backstop: commit our best merge rather than spin forever.
    this.writeAtomic(this.file(key), merge(this.getText(key)))
  }

  remove(key: string): void {
    const p = this.file(key)
    if (this.fs.existsSync(p)) this.fs.unlinkSync(p)
  }
}

/** A per-process id for unique temp-file names (falls back to a random tag when
 * `process` is unavailable, e.g. an exotic embedding). */
function _procId(): string {
  const proc = (globalThis as {process?: {pid?: number}}).process
  return proc?.pid !== undefined ? String(proc.pid) : Math.random().toString(36).slice(2, 8)
}

let _storage: AppStorage | undefined

function buildStorage(): AppStorage {
  const req = (globalThis as {require?: (m: string) => unknown}).require
  const haveNwjs = (globalThis as {haveNwjs?: boolean}).haveNwjs

  if (haveNwjs && typeof req === 'function') {
    try {
      const fs = req('fs') as NodeFsSync
      const pathlib = req('path') as NodePath
      const proc = (globalThis as {process?: {cwd(): string}}).process
      // <cwd>/.sculptcore — the repo root when launched via `pnpm run nwjs` or
      // the test harness (NW.js inherits the launcher's cwd, never chdir's).
      const baseDir = pathlib.join(proc!.cwd(), '.sculptcore')
      return new NwjsAppStorage(baseDir, fs, pathlib)
    } catch (err) {
      console.warn('app_storage: NW.js fs backend unavailable, using localStorage', err)
    }
  }

  return new BrowserAppStorage()
}

/** The active persistence backend (localStorage in the browser, files in NW.js). */
export function getAppStorage(): AppStorage {
  if (_storage === undefined) {
    _storage = buildStorage()
  }
  return _storage
}
