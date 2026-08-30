/**
 * Storage backends for autosave (plan §3.3 / §7).
 *
 * The manager produces the bytes; a backend rotates them onto durable storage
 * atomically and tracks a single global "latest" recovery pointer so the next
 * launch can offer to recover. NW.js writes rotating files (next to the
 * project, or under `.sculptcore/autosave/`); browser builds write to OPFS /
 * IndexedDB (see autosave_backend_browser.ts, wired in by the factory).
 *
 * Writes are async on purpose: even M1's disk I/O runs off the UI thread (on
 * libuv's pool in NW.js, via the async OPFS API in the browser).
 */

import * as cconst from './const'
import {getAppStorage} from './app_storage'

export interface AutosaveWriteOpts {
  /** Absolute path / handle name of the open project, or null when untitled. */
  sourcePath: string | null
  appVersion: number
  maxBackups: number
  /** Write backups next to the project file vs. into the autosave store dir. */
  toProjectDir: boolean
}

/** The single recovery pointer at the newest backup written. */
export interface AutosaveLatest {
  /** Backend-specific locator for readBackup (abs path / OPFS name / IDB key). */
  backupKey: string
  sourcePath: string | null
  /** Epoch ms the backup was written. */
  timestamp: number
  appVersion: number
  bytes: number
}

export interface AutosaveBackend {
  readonly kind: 'nwjs' | 'opfs' | 'indexeddb'
  /** Write @p bytes to the next rotating slot and update the latest pointer. */
  writeBackup(bytes: Uint8Array, opts: AutosaveWriteOpts): Promise<AutosaveLatest>
  /** The newest recovery pointer, or undefined if none exists. */
  readLatest(): Promise<AutosaveLatest | undefined>
  /** Read back a previously-written backup by its locator. */
  readBackup(key: string): Promise<Uint8Array | undefined>
  /** Modification time (epoch ms) of the source project, or undefined. */
  sourceMtime(sourcePath: string): Promise<number | undefined>
  /** Drop the latest pointer after an explicit successful save. */
  clearLatest(): Promise<void>
}

interface NodeFsPromises {
  writeFile(p: string, data: Uint8Array | string): Promise<void>
  readFile(p: string): Promise<Uint8Array>
  readFile(p: string, enc: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  mkdir(p: string, opts: {recursive: boolean}): Promise<unknown>
  stat(p: string): Promise<{mtimeMs: number}>
  unlink(p: string): Promise<void>
  readdir(p: string): Promise<string[]>
}

/** True if @p pid names a live process. EPERM (exists, not ours) counts as
 * alive; only a clean ESRCH means gone. 0/NaN are treated as dead. */
function pidAlive(pid: number): boolean {
  if (!pid || Number.isNaN(pid)) return false
  const proc = (globalThis as {process?: {kill(pid: number, sig: number): void}}).process
  if (!proc) return true // can't tell → assume alive (never GC live work)
  try {
    proc.kill(pid, 0)
    return true
  } catch (err) {
    return (err as {code?: string}).code === 'EPERM'
  }
}

/** A unique per-launch autosave session id: `<pid>-<time36>-<rand>`. The pid
 * prefix lets GC test liveness; the time/rand tail survives pid reuse so a new
 * instance never rotates over a dead instance's still-recoverable backups. */
function makeSessionId(): string {
  const proc = (globalThis as {process?: {pid?: number}}).process
  const pid = proc?.pid ?? 0
  return `${pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function sessionPid(session: string): number {
  return parseInt(session.split('-')[0], 10)
}

/** Retain at most this many *dead* sessions' backups; older dead sessions are
 * GC'd on launch so throwaway/crashed instances don't accumulate forever. */
const MAX_DEAD_SESSIONS = 8
interface NodePath {
  join(...parts: string[]): string
  dirname(p: string): string
  basename(p: string): string
}

/** Per-store rotation manifest (next to the rotating slot files). */
interface RotationManifest {
  newestSlot: number
  maxBackups: number
  slots: {slot: number; timestamp: number; bytes: number}[]
}

class NwjsAutosaveBackend implements AutosaveBackend {
  readonly kind = 'nwjs'
  private fsp: NodeFsPromises
  private path: NodePath
  private storeDir: string
  /** Unique per-launch id; namespaces this instance's slot files + pointer so
   * concurrent instances sharing `.sculptcore/autosave` never collide. */
  private session = makeSessionId()

  constructor(fsp: NodeFsPromises, path: NodePath, sculptcoreDir: string) {
    this.fsp = fsp
    this.path = path
    this.storeDir = path.join(sculptcoreDir, 'autosave')
    void this.gcDeadSessions()
  }

  /** Where slots + rotation manifest live for a given project/mode. */
  private slotDir(opts: AutosaveWriteOpts): string {
    if (opts.toProjectDir && opts.sourcePath) {
      return this.path.dirname(opts.sourcePath)
    }
    return this.storeDir
  }

  private prefix(opts: {sourcePath: string | null}): string {
    return opts.sourcePath ? this.path.basename(opts.sourcePath) : 'untitled.' + cconst.FILE_EXT
  }

  private slotFile(dir: string, prefix: string, slot: number): string {
    return this.path.join(dir, `${prefix}.autosave.${this.session}.${slot}`)
  }

  private manifestFile(dir: string, prefix: string): string {
    return this.path.join(dir, `${prefix}.autosave.${this.session}.manifest.json`)
  }

  /** Per-session recovery pointer, always in the central store (even when slots
   * live next to the project), so readLatest can scan one dir across sessions. */
  private latestFile(session: string = this.session): string {
    return this.path.join(this.storeDir, `latest.${session}.json`)
  }

  private async readJSON<T>(p: string): Promise<T | undefined> {
    try {
      const txt = await this.fsp.readFile(p, 'utf8')
      return JSON.parse(txt) as T
    } catch {
      return undefined
    }
  }

  /** Write JSON atomically (tmp + rename). */
  private async writeJSON(p: string, obj: unknown): Promise<void> {
    const tmp = p + '.tmp'
    await this.fsp.writeFile(tmp, JSON.stringify(obj))
    await this.fsp.rename(tmp, p)
  }

  async writeBackup(bytes: Uint8Array, opts: AutosaveWriteOpts): Promise<AutosaveLatest> {
    const dir = this.slotDir(opts)
    const prefix = this.prefix(opts)
    await this.fsp.mkdir(dir, {recursive: true})
    await this.fsp.mkdir(this.storeDir, {recursive: true})

    const manPath = this.manifestFile(dir, prefix)
    const man = (await this.readJSON<RotationManifest>(manPath)) ?? {
      newestSlot: -1,
      maxBackups: opts.maxBackups,
      slots     : [],
    }

    const slot = (man.newestSlot + 1) % Math.max(1, opts.maxBackups)
    const target = this.slotFile(dir, prefix, slot)
    const tmp = target + '.tmp'

    // Atomic: full write to a temp path, then rename over the slot.
    await this.fsp.writeFile(tmp, bytes)
    await this.fsp.rename(tmp, target)

    const timestamp = Date.now()
    man.newestSlot = slot
    man.maxBackups = opts.maxBackups
    man.slots = man.slots.filter((s) => s.slot !== slot)
    man.slots.push({slot, timestamp, bytes: bytes.byteLength})
    await this.writeJSON(manPath, man)

    const latest: AutosaveLatest = {
      backupKey : target,
      sourcePath: opts.sourcePath,
      timestamp,
      appVersion: opts.appVersion,
      bytes     : bytes.byteLength,
    }
    await this.writeJSON(this.latestFile(), latest)
    return latest
  }

  async readLatest(): Promise<AutosaveLatest | undefined> {
    // Newest recovery pointer across ALL sessions (any instance, incl. crashed
    // ones): no single global latest.json to race, so we scan per-session
    // pointers and pick the newest whose backup file still exists.
    let files: string[]
    try {
      files = await this.fsp.readdir(this.storeDir)
    } catch {
      return undefined
    }
    let best: AutosaveLatest | undefined
    for (const f of files) {
      if (!f.startsWith('latest.') || !f.endsWith('.json')) continue
      const latest = await this.readJSON<AutosaveLatest>(this.path.join(this.storeDir, f))
      if (!latest) continue
      try {
        await this.fsp.stat(latest.backupKey)
      } catch {
        continue // backup vanished
      }
      if (!best || latest.timestamp > best.timestamp) best = latest
    }
    return best
  }

  /**
   * Prune backups from dead sessions on launch so throwaway/crashed instances
   * don't accumulate forever. Keeps every live session plus the newest
   * MAX_DEAD_SESSIONS dead ones (so the most recent crash stays recoverable).
   */
  private async gcDeadSessions(): Promise<void> {
    let files: string[]
    try {
      files = await this.fsp.readdir(this.storeDir)
    } catch {
      return // store not created yet
    }
    const infos: {session: string; mtime: number}[] = []
    for (const f of files) {
      if (!f.startsWith('latest.') || !f.endsWith('.json')) continue
      const session = f.slice('latest.'.length, -'.json'.length)
      if (session === this.session) continue
      try {
        infos.push({session, mtime: (await this.fsp.stat(this.path.join(this.storeDir, f))).mtimeMs})
      } catch {
        /* vanished */
      }
    }
    infos.sort((a, b) => b.mtime - a.mtime)

    let deadKept = 0
    for (const info of infos) {
      if (pidAlive(sessionPid(info.session))) continue
      if (++deadKept <= MAX_DEAD_SESSIONS) continue
      await this.purgeSession(info.session, files)
    }
  }

  /** Delete a session's central-store files (pointer, manifest, slots). Slots
   * written next to a project (toProjectDir) for a dead session are left be. */
  private async purgeSession(session: string, storeFiles: string[]): Promise<void> {
    const marker = `.autosave.${session}.`
    const pointer = `latest.${session}.json`
    for (const f of storeFiles) {
      if (f !== pointer && !f.includes(marker)) continue
      try {
        await this.fsp.unlink(this.path.join(this.storeDir, f))
      } catch {
        /* already gone */
      }
    }
  }

  async readBackup(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await this.fsp.readFile(key))
    } catch {
      return undefined
    }
  }

  async sourceMtime(sourcePath: string): Promise<number | undefined> {
    try {
      return (await this.fsp.stat(sourcePath)).mtimeMs
    } catch {
      return undefined
    }
  }

  async clearLatest(): Promise<void> {
    try {
      await this.fsp.unlink(this.latestFile())
    } catch {
      /* already gone */
    }
  }
}

let _backend: AutosaveBackend | null | undefined

/** The active autosave backend, or null when none is available. */
export function getAutosaveBackend(): AutosaveBackend | null {
  if (_backend !== undefined) {
    return _backend
  }

  const req = (globalThis as {require?: (m: string) => unknown}).require
  const haveNwjs = (globalThis as {haveNwjs?: boolean}).haveNwjs
  const storage = getAppStorage()

  if (haveNwjs && typeof req === 'function' && storage.isFileBacked && storage.baseDir) {
    try {
      const fsp = (req('fs') as {promises: NodeFsPromises}).promises
      const path = req('path') as NodePath
      _backend = new NwjsAutosaveBackend(fsp, path, storage.baseDir)
      return _backend
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('autosave: NW.js fs backend unavailable', err)
    }
  }

  // Browser backends (OPFS / IndexedDB) register here, see M4.
  _backend = makeBrowserAutosaveBackend()
  return _backend
}

// Filled in by autosave_backend_browser.ts via registerBrowserAutosaveBackend.
let _browserFactory: (() => AutosaveBackend | null) | undefined
export function registerBrowserAutosaveBackend(factory: () => AutosaveBackend | null): void {
  _browserFactory = factory
  _backend = undefined // allow re-resolution now that a browser backend exists
}
function makeBrowserAutosaveBackend(): AutosaveBackend | null {
  return _browserFactory ? _browserFactory() : null
}
