/**
 * Storage backend interface for third-party addons.
 *
 * Each backend exposes the same shape so `installFromBlob` (and the loader's
 * "list installed addons" walk) work uniformly across the web (IndexedDB),
 * NW.js (filesystem, direct require), and tests (in-memory). See plan §2 / §6 step 9.
 *
 * Path semantics: relative POSIX paths within the addon, e.g.
 *   "manifest.json", "build/main.js", "build/_chunks/chunk-AB12.js"
 * No leading slash, no "..", no absolute paths. The installer normalizes
 * entries from the zip before passing them through here.
 */

import {APP_KEY_NAME} from '../core/const'

export interface AddonStorage {
  /** List ids of all installed addons (one entry per addon directory). */
  list(): Promise<string[]>

  /** Read a single file under an installed addon as raw bytes. */
  read(addonId: string, relPath: string): Promise<Uint8Array>

  /** Read a JSON file (convenience). Throws if missing or not JSON. */
  readJSON(addonId: string, relPath: string): Promise<unknown>

  /**
   * Write a new addon's full file set, replacing any previous install. The
   * map keys are POSIX relative paths (see file-header comment). Files not
   * in the map are removed.
   */
  write(addonId: string, files: Map<string, Uint8Array>): Promise<void>

  /** Remove an installed addon. No-op if it isn't present. */
  remove(addonId: string): Promise<void>

  /**
   * Returns a URL that can be passed to `import()` for an addon file.
   * Backends may return `blob:` URLs (web, in-memory) or `file:`/scheme
   * URLs (Electron). Repeated calls for the same path may return cached
   * URLs so import maps stay stable.
   */
  urlFor(addonId: string, relPath: string): Promise<string>
}

// ---------------------------------------------------------------------------
// InMemoryAddonStorage — used by tests and as the default for environments
// without a persistent backend yet.
// ---------------------------------------------------------------------------

export class InMemoryAddonStorage implements AddonStorage {
  /** addonId -> (relPath -> bytes). */
  private files = new Map<string, Map<string, Uint8Array>>()

  /** addonId|relPath -> object URL, so repeated urlFor() returns the same URL. */
  private urls = new Map<string, string>()

  async list(): Promise<string[]> {
    return Array.from(this.files.keys())
  }

  async read(addonId: string, relPath: string): Promise<Uint8Array> {
    const dir = this.files.get(addonId)
    if (!dir) throw new Error(`addon "${addonId}" not installed`)
    const bytes = dir.get(this.normalize(relPath))
    if (!bytes) throw new Error(`addon "${addonId}": file "${relPath}" not found`)
    return bytes
  }

  async readJSON(addonId: string, relPath: string): Promise<unknown> {
    const bytes = await this.read(addonId, relPath)
    return JSON.parse(new TextDecoder().decode(bytes))
  }

  async write(addonId: string, files: Map<string, Uint8Array>): Promise<void> {
    // Revoke any cached object URLs from a previous install.
    this.revokeAddonUrls(addonId)

    const normalized = new Map<string, Uint8Array>()
    for (const [p, bytes] of files) {
      normalized.set(this.normalize(p), bytes)
    }
    this.files.set(addonId, normalized)
  }

  async remove(addonId: string): Promise<void> {
    this.revokeAddonUrls(addonId)
    this.files.delete(addonId)
  }

  async urlFor(addonId: string, relPath: string): Promise<string> {
    const key = `${addonId}|${this.normalize(relPath)}`
    const existing = this.urls.get(key)
    if (existing) return existing

    const bytes = await this.read(addonId, relPath)
    const url = makeBlobUrl(bytes, mimeFor(relPath))
    this.urls.set(key, url)
    return url
  }

  private normalize(relPath: string): string {
    if (relPath.includes('..') || relPath.startsWith('/')) {
      throw new Error(`invalid addon relPath: ${relPath}`)
    }
    return relPath.replace(/\\/g, '/')
  }

  private revokeAddonUrls(addonId: string) {
    const prefix = `${addonId}|`
    for (const [key, url] of this.urls) {
      if (key.startsWith(prefix)) {
        revokeBlobUrl(url)
        this.urls.delete(key)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — kept here so the IndexedDB + Electron backends can share.
// ---------------------------------------------------------------------------

function makeBlobUrl(bytes: Uint8Array, mime: string): string {
  // Browsers and NW.js renderers implement URL.createObjectURL; jsdom (test
  // environment) doesn't. Fall back to a data: URL there — same import()
  // semantics, just less compact.
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const blob = new Blob([new Uint8Array(bytes)], {type: mime})
    return URL.createObjectURL(blob)
  }
  return makeDataUrl(bytes, mime)
}

function revokeBlobUrl(url: string): void {
  if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url)
  }
  // data: URLs don't need explicit revocation — they're inert strings.
}

/** Encode bytes as base64 without exceeding String.fromCharCode's spread limit. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)))
  }
  // btoa is universal in browser/jsdom; in pure Node we'd need Buffer.from.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const btoaFn = (globalThis as any).btoa as ((s: string) => string) | undefined
  if (btoaFn) return btoaFn(binary)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = (globalThis as any).Buffer
  if (buf?.from) return buf.from(binary, 'binary').toString('base64')
  throw new Error('no base64 encoder available')
}

function makeDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`
}

function mimeFor(relPath: string): string {
  if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) return 'application/javascript'
  if (relPath.endsWith('.json')) return 'application/json'
  if (relPath.endsWith('.css')) return 'text/css'
  if (relPath.endsWith('.html') || relPath.endsWith('.htm')) return 'text/html'
  return 'application/octet-stream'
}

function normalizePath(relPath: string): string {
  if (relPath.includes('..') || relPath.startsWith('/')) {
    throw new Error(`invalid addon relPath: ${relPath}`)
  }
  return relPath.replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// IndexedDBAddonStorage — persistent backend for web (browser + jsdom envs
// with a polyfilled `indexedDB`). Schema:
//
//   db `<APP_KEY_NAME>-addons`, version 1
//     objectStore `files`
//       keyPath: `key` (string `${addonId}/${relPath}`)
//       value:   {key, addonId, relPath, bytes: Uint8Array, mime}
//       index `addonId`: non-unique
//
// All operations wrap the request-callback API in promises so the public
// AddonStorage methods remain async. See plan §6 step 9b.
// ---------------------------------------------------------------------------

/** Exported so core/identity_migration.ts can carry a pre-rename database over
 *  under this name without duplicating the literal. */
export const ADDON_DB_NAME = `${APP_KEY_NAME}-addons`

const DB_NAME = ADDON_DB_NAME
const DB_VERSION = 1
const STORE = 'files'
const ADDON_INDEX = 'addonId'

interface IFileRow {
  key: string
  addonId: string
  relPath: string
  bytes: Uint8Array
  mime: string
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
  })
}

export class IndexedDBAddonStorage implements AddonStorage {
  private dbName: string
  private dbPromise: Promise<IDBDatabase> | null = null

  /** addonId|relPath -> object URL (or data: URL) cache so urlFor is stable. */
  private urls = new Map<string, string>()

  constructor(dbName: string = DB_NAME) {
    this.dbName = dbName
  }

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDBAddonStorage: no indexedDB in this environment')
    }
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, {keyPath: 'key'})
          store.createIndex(ADDON_INDEX, 'addonId', {unique: false})
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return this.dbPromise
  }

  async list(): Promise<string[]> {
    const db = await this.openDB()
    const tx = db.transaction(STORE, 'readonly')
    const idx = tx.objectStore(STORE).index(ADDON_INDEX)
    // Use openKeyCursor to enumerate distinct addonIds without loading row bodies.
    const seen = new Set<string>()
    await new Promise<void>((resolve, reject) => {
      const req = idx.openKeyCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve()
          return
        }
        seen.add(cursor.key as string)
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
    await txDone(tx).catch(() => {})
    return Array.from(seen)
  }

  async read(addonId: string, relPath: string): Promise<Uint8Array> {
    const normalized = normalizePath(relPath)
    const db = await this.openDB()
    const tx = db.transaction(STORE, 'readonly')
    const row = (await reqAsPromise(tx.objectStore(STORE).get(`${addonId}/${normalized}`))) as IFileRow | undefined
    if (!row) {
      throw new Error(`addon "${addonId}": file "${relPath}" not found`)
    }
    return row.bytes
  }

  async readJSON(addonId: string, relPath: string): Promise<unknown> {
    const bytes = await this.read(addonId, relPath)
    return JSON.parse(new TextDecoder().decode(bytes))
  }

  async write(addonId: string, files: Map<string, Uint8Array>): Promise<void> {
    this.revokeAddonUrls(addonId)
    const db = await this.openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)

    // Delete all existing entries for this addon, then add the new set.
    await new Promise<void>((resolve, reject) => {
      const req = store.index(ADDON_INDEX).openKeyCursor(IDBKeyRange.only(addonId))
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve()
          return
        }
        store.delete(cursor.primaryKey)
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })

    for (const [relPath, bytes] of files) {
      const normalized = normalizePath(relPath)
      const row: IFileRow = {
        key: `${addonId}/${normalized}`,
        addonId,
        relPath: normalized,
        bytes,
        mime: mimeFor(normalized),
      }
      store.put(row)
    }
    await txDone(tx)
  }

  async remove(addonId: string): Promise<void> {
    this.revokeAddonUrls(addonId)
    const db = await this.openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    await new Promise<void>((resolve, reject) => {
      const req = store.index(ADDON_INDEX).openKeyCursor(IDBKeyRange.only(addonId))
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve()
          return
        }
        store.delete(cursor.primaryKey)
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
    await txDone(tx)
  }

  async urlFor(addonId: string, relPath: string): Promise<string> {
    const normalized = normalizePath(relPath)
    const key = `${addonId}|${normalized}`
    const existing = this.urls.get(key)
    if (existing) return existing
    const bytes = await this.read(addonId, normalized)
    const url = makeBlobUrl(bytes, mimeFor(normalized))
    this.urls.set(key, url)
    return url
  }

  /** Test helper — clears the database. Closes the connection so the next
   * openDB() reads a fresh state. */
  async _resetForTests(): Promise<void> {
    const db = await this.openDB()
    db.close()
    this.dbPromise = null
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this.dbName)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => resolve() // best-effort
    })
    for (const url of this.urls.values()) revokeBlobUrl(url)
    this.urls.clear()
  }

  private revokeAddonUrls(addonId: string) {
    const prefix = `${addonId}|`
    for (const [key, url] of this.urls) {
      if (key.startsWith(prefix)) {
        revokeBlobUrl(url)
        this.urls.delete(key)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// NodeFsAddonStorage — filesystem backend for environments with Node access
// (NW.js renderer, pure Node tests, or any host
// that wires up `fs` via a context bridge).
//
// Layout under the base directory: <baseDir>/<addonId>/<relPath>
//
// In NW.js the caller picks baseDir as `path.join(nw.App.dataPath, 'addons')`
// (see scripts/addon/storage_nwjs.ts). See plan §6.
// ---------------------------------------------------------------------------

export interface INodeFs {
  readdir(path: string, options: {withFileTypes: true}): Promise<Array<{name: string; isDirectory(): boolean}>>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string, options?: {recursive?: boolean}): Promise<string | undefined>
  rm(path: string, options?: {recursive?: boolean; force?: boolean}): Promise<void>
}

export interface INodePath {
  join(...parts: string[]): string
  dirname(p: string): string
}

export class NodeFsAddonStorage implements AddonStorage {
  private fs: INodeFs
  private pathlib: INodePath
  private baseDir: string

  /** addonId|relPath -> object/data URL cache. */
  private urls = new Map<string, string>()

  constructor(opts: {baseDir: string; fs: INodeFs; pathlib: INodePath}) {
    this.baseDir = opts.baseDir
    this.fs = opts.fs
    this.pathlib = opts.pathlib
  }

  async list(): Promise<string[]> {
    try {
      const entries = await this.fs.readdir(this.baseDir, {withFileTypes: true})
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      // baseDir doesn't exist yet — no addons installed.
      return []
    }
  }

  async read(addonId: string, relPath: string): Promise<Uint8Array> {
    const normalized = normalizePath(relPath)
    const fullPath = this.pathlib.join(this.baseDir, addonId, normalized)
    try {
      return await this.fs.readFile(fullPath)
    } catch (err) {
      throw new Error(`addon "${addonId}": file "${relPath}" not found: ${(err as Error).message}`)
    }
  }

  async readJSON(addonId: string, relPath: string): Promise<unknown> {
    const bytes = await this.read(addonId, relPath)
    return JSON.parse(new TextDecoder().decode(bytes))
  }

  async write(addonId: string, files: Map<string, Uint8Array>): Promise<void> {
    this.revokeAddonUrls(addonId)
    const addonDir = this.pathlib.join(this.baseDir, addonId)
    // Remove any previous install, then write the new file set.
    await this.fs.rm(addonDir, {recursive: true, force: true})
    await this.fs.mkdir(addonDir, {recursive: true})

    for (const [relPath, bytes] of files) {
      const normalized = normalizePath(relPath)
      const fullPath = this.pathlib.join(this.baseDir, addonId, normalized)
      await this.fs.mkdir(this.pathlib.dirname(fullPath), {recursive: true})
      await this.fs.writeFile(fullPath, bytes)
    }
  }

  async remove(addonId: string): Promise<void> {
    this.revokeAddonUrls(addonId)
    const addonDir = this.pathlib.join(this.baseDir, addonId)
    await this.fs.rm(addonDir, {recursive: true, force: true})
  }

  async urlFor(addonId: string, relPath: string): Promise<string> {
    const normalized = normalizePath(relPath)
    const key = `${addonId}|${normalized}`
    const existing = this.urls.get(key)
    if (existing) return existing
    const bytes = await this.read(addonId, normalized)
    const url = makeBlobUrl(bytes, mimeFor(normalized))
    this.urls.set(key, url)
    return url
  }

  private revokeAddonUrls(addonId: string) {
    const prefix = `${addonId}|`
    for (const [key, url] of this.urls) {
      if (key.startsWith(prefix)) {
        revokeBlobUrl(url)
        this.urls.delete(key)
      }
    }
  }
}
