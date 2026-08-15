/**
 * One-time migration of the persistent keys that were named after the old
 * `webgl-app-framework` app identity: the startup-scene and settings
 * `localStorage` keys, and the installed-addon IndexedDB database.
 *
 * Three rules the implementation holds to:
 *
 * - **Copy, then mark.** The legacy key/database is left in place, so a user
 *   who downgrades still has a working install. The one exception is a value
 *   too big to exist twice: the startup scene is routinely megabytes and
 *   localStorage only allows ~5MB per origin, so a quota failure degrades to a
 *   move rather than losing the scene (see `migrateTextKey`).
 * - **Idempotent.** If the destination already holds data, nothing is copied —
 *   newer data is never overwritten with older.
 * - **Never throws.** A failed migration degrades to "fresh profile", not to
 *   "the app does not boot".
 *
 * Only the browser build needs this. The NW.js backend keys its files by a
 * fixed filename (`FILE_NAMES` in app_storage.ts) rather than by the app name,
 * and uses filesystem addon storage, so nothing there moved.
 *
 * See documentation/plans/2026-08-15-0305-w0-rename-faber-leaf.md.
 */

// Type-only on app_storage on purpose: the caller passes the backend in, so
// this module stays free of the util/pathux runtime and is unit-testable.
import {APP_KEY_NAME} from './const'
import type {AppStorage} from './app_storage'
import {ADDON_DB_NAME} from '../addon/storage'

/** The pre-Faber-Leaf app identity. Every legacy key is derived from it. */
export const LEGACY_APP_KEY = 'webgl-app-framework'

export const LEGACY_SETTINGS_KEY = `${LEGACY_APP_KEY}-settings`
export const LEGACY_ADDON_DB_NAME = `${LEGACY_APP_KEY}-addons`

/** Sentinel written next to a destination key once its copy has completed. */
function markerKey(destination: string): string {
  return `${destination}-migrated-from-legacy`
}

function warn(what: string, err: unknown): void {
  console.warn(`identity migration: ${what} failed; continuing with a fresh profile`, err)
}

/** True for the various spellings of "localStorage is full". */
function isQuotaError(err: unknown): boolean {
  const e = err as {name?: string; code?: number}
  return (
    e?.name === 'QuotaExceededError' || e?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e?.code === 22 || e?.code === 1014
  )
}

/**
 * Copy one `localStorage` entry. Returns true if the value was carried over.
 *
 * Values move as raw text: the browser backend base64-encodes blobs on the way
 * in, so the startup scene round-trips byte-for-byte without a decode.
 *
 * A saved startup scene is easily 4MB of base64 against a ~5MB origin quota, so
 * holding both copies is impossible and the plain copy throws. Rather than lose
 * the scene, drop the legacy key and retry — the value is in memory for the
 * whole window, so a failed retry can put it back.
 */
export function migrateTextKey(storage: AppStorage, legacyKey: string, destKey: string): boolean {
  try {
    if (storage.getText(markerKey(destKey)) !== undefined) return false
    if (storage.getText(destKey) !== undefined) {
      storage.setText(markerKey(destKey), 'skipped')
      return false
    }

    const legacy = storage.getText(legacyKey)
    if (legacy === undefined) return false

    try {
      storage.setText(destKey, legacy)
      storage.setText(markerKey(destKey), 'copied')
    } catch (err) {
      if (!isQuotaError(err)) throw err

      storage.remove(legacyKey)
      try {
        storage.setText(destKey, legacy)
        storage.setText(markerKey(destKey), 'moved')
      } catch (retryErr) {
        try {
          storage.setText(legacyKey, legacy)
        } catch {
          // Out of options; the warn() below is the user's only signal.
        }
        throw retryErr
      }
    }
    return true
  } catch (err) {
    warn(`localStorage key "${legacyKey}"`, err)
    return false
  }
}

// ---------------------------------------------------------------------------
// IndexedDB. There is no rename primitive, so the addon database is copied
// store by store: read the legacy schema and rows, recreate that schema under
// the new name, write the rows back, verify the counts, and only then mark it
// done. The legacy database is deliberately left behind — deleting it is a
// later release's job.
// ---------------------------------------------------------------------------

interface StoreDump {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: {name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean}[]
  values: unknown[]
  /** Only set for out-of-line stores (`keyPath === null`). */
  keys?: IDBValidKey[]
}

interface DatabaseDump {
  version: number
  stores: StoreDump[]
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

/**
 * Open a database only if it already exists, resolving undefined otherwise.
 *
 * `indexedDB.databases()` is not universally available, so the fallback is to
 * open at the implicit version and watch for `upgradeneeded`, which only fires
 * when the database had to be created — that creation is then undone.
 */
function openExisting(name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    let created = false

    req.onupgradeneeded = () => {
      created = true
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      if (!created) {
        resolve(db)
        return
      }
      db.close()
      const del = indexedDB.deleteDatabase(name)
      const done = () => resolve(undefined)
      del.onsuccess = done
      del.onerror = done
      del.onblocked = done
    }
  })
}

/** Read a database's full schema and contents. */
async function dumpDatabase(db: IDBDatabase): Promise<DatabaseDump> {
  const names = Array.from(db.objectStoreNames)
  if (names.length === 0) return {version: db.version, stores: []}

  const tx = db.transaction(names, 'readonly')
  const stores: StoreDump[] = []

  for (const name of names) {
    const store = tx.objectStore(name)
    const indexes = Array.from(store.indexNames).map((indexName) => {
      const index = store.index(indexName)
      return {
        name      : indexName,
        keyPath   : index.keyPath,
        unique    : index.unique,
        multiEntry: index.multiEntry,
      }
    })

    const values = await reqAsPromise(store.getAll())
    const keys = store.keyPath === null ? await reqAsPromise(store.getAllKeys()) : undefined

    stores.push({name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, values, keys})
  }

  await txDone(tx)
  return {version: db.version, stores}
}

/** Create the destination database at the legacy schema and version. */
function createFromDump(name: string, dump: DatabaseDump): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, dump.version)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of dump.stores) {
        if (db.objectStoreNames.contains(s.name)) continue
        const store = db.createObjectStore(s.name, {keyPath: s.keyPath, autoIncrement: s.autoIncrement})
        for (const idx of s.indexes) {
          store.createIndex(idx.name, idx.keyPath, {unique: idx.unique, multiEntry: idx.multiEntry})
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** True when the database holds at least one record in any store. */
async function hasAnyRecords(db: IDBDatabase): Promise<boolean> {
  const names = Array.from(db.objectStoreNames)
  if (names.length === 0) return false
  const tx = db.transaction(names, 'readonly')
  for (const name of names) {
    if ((await reqAsPromise(tx.objectStore(name).count())) > 0) return true
  }
  await txDone(tx).catch(() => {})
  return false
}

export type DbMigrationResult = 'copied' | 'skipped' | 'absent' | 'unsupported' | 'failed'

/**
 * Copy `legacyName` to `destName`. The store list comes from the legacy
 * database rather than from this build's schema, so stores a newer build added
 * still travel.
 */
export async function migrateAddonDatabase(legacyName: string, destName: string): Promise<DbMigrationResult> {
  if (typeof indexedDB === 'undefined') return 'unsupported'

  let legacy: IDBDatabase | undefined
  let dest: IDBDatabase | undefined

  try {
    legacy = await openExisting(legacyName)
    if (!legacy) return 'absent'

    const existing = await openExisting(destName)
    if (existing) {
      const populated = await hasAnyRecords(existing)
      existing.close()
      if (populated) return 'skipped'
      // An empty destination is one this build created on a boot that raced the
      // migration; drop it so the legacy schema and version can be recreated.
      await new Promise<void>((resolve) => {
        const del = indexedDB.deleteDatabase(destName)
        del.onsuccess = del.onerror = del.onblocked = () => resolve()
      })
    }

    const dump = await dumpDatabase(legacy)
    legacy.close()
    legacy = undefined

    dest = await createFromDump(destName, dump)

    for (const store of dump.stores) {
      if (store.values.length === 0) continue
      const tx = dest.transaction(store.name, 'readwrite')
      const target = tx.objectStore(store.name)
      store.values.forEach((value, i) => {
        if (store.keys) {
          target.put(value, store.keys[i])
        } else {
          target.put(value)
        }
      })
      await txDone(tx)
    }

    for (const store of dump.stores) {
      const tx = dest.transaction(store.name, 'readonly')
      const count = await reqAsPromise(tx.objectStore(store.name).count())
      await txDone(tx).catch(() => {})
      if (count !== store.values.length) {
        throw new Error(`store "${store.name}": copied ${count} of ${store.values.length} records`)
      }
    }

    return 'copied'
  } catch (err) {
    warn(`IndexedDB database "${legacyName}"`, err)
    return 'failed'
  } finally {
    legacy?.close()
    dest?.close()
  }
}

/**
 * Bring a pre-rename profile forward. Call once at boot, before anything reads
 * the startup scene, the settings, or the installed addon list.
 */
export async function migrateAppIdentity(storage: AppStorage): Promise<void> {
  // File-backed (NW.js) storage keys its files by name, not by the app
  // identity, so there is nothing to move.
  if (storage.isFileBacked) return

  migrateTextKey(storage, LEGACY_APP_KEY, APP_KEY_NAME)
  migrateTextKey(storage, LEGACY_SETTINGS_KEY, `${APP_KEY_NAME}-settings`)

  try {
    if (storage.getText(markerKey(ADDON_DB_NAME)) !== undefined) return
    const result = await migrateAddonDatabase(LEGACY_ADDON_DB_NAME, ADDON_DB_NAME)
    if (result === 'copied' || result === 'skipped') {
      storage.setText(markerKey(ADDON_DB_NAME), result)
    }
  } catch (err) {
    warn('addon database', err)
  }
}
