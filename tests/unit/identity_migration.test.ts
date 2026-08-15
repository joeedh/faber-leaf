/**
 * Tests the webgl-app-framework → faber-leaf profile migration
 * (scripts/core/identity_migration.ts, plan §6 of the W0 rename).
 *
 * The IndexedDB half runs against fake-indexeddb, installed globally by
 * tests/lib/jest-setup.ts.
 */

import {TextEncoder as NodeTextEncoder} from 'node:util'

import {APP_KEY_NAME} from '../../scripts/core/const'
import {ADDON_DB_NAME} from '../../scripts/addon/storage'
import type {AppStorage} from '../../scripts/core/app_storage'
import {
  LEGACY_APP_KEY,
  LEGACY_SETTINGS_KEY,
  migrateAddonDatabase,
  migrateAppIdentity,
} from '../../scripts/core/identity_migration'

const enc = new NodeTextEncoder()

class FakeStorage implements AppStorage {
  map = new Map<string, string>()
  isFileBacked = false
  /** Set to a key to make every access to it throw. */
  poison?: string
  /** Total stored value length allowed, mimicking the localStorage quota. */
  capacity?: number
  /** Keys whose writes always fail with a quota error. */
  refuseWrites = new Set<string>()

  private check(key: string) {
    if (this.poison !== undefined && key === this.poison) {
      throw new Error(`storage refused key "${key}"`)
    }
  }

  private quotaError(): Error {
    const err = new Error('quota exceeded')
    err.name = 'QuotaExceededError'
    return err
  }

  getText(key: string): string | undefined {
    this.check(key)
    return this.map.get(key)
  }
  setText(key: string, data: string): void {
    this.check(key)
    if (this.refuseWrites.has(key)) throw this.quotaError()
    if (this.capacity !== undefined) {
      let total = data.length
      for (const [k, v] of this.map) {
        if (k !== key) total += v.length
      }
      if (total > this.capacity) throw this.quotaError()
    }
    this.map.set(key, data)
  }
  getBlob(key: string): Uint8Array | undefined {
    const text = this.getText(key)
    return text === undefined ? undefined : enc.encode(text)
  }
  setBlob(key: string, data: ArrayBuffer | Uint8Array): void {
    this.setText(key, String(data))
  }
  updateText(key: string, merge: (current: string | undefined) => string): void {
    this.setText(key, merge(this.getText(key)))
  }
  remove(key: string): void {
    this.map.delete(key)
  }
  version(): undefined {
    return undefined
  }
}

function uniqDbName(): string {
  return `identity-migration-${Math.random().toString(36).slice(2)}`
}

/** Build a legacy-shaped addon database with `rows` records in `files`. */
function seedLegacyDb(name: string, rows: {key: string; addonId: string; bytes: Uint8Array}[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('files', {keyPath: 'key'})
      store.createIndex('addonId', 'addonId', {unique: false})
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('files', 'readwrite')
      for (const row of rows) tx.objectStore('files').put(row)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

function readAll(name: string, store: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(store, 'readonly')
      const get = tx.objectStore(store).getAll()
      get.onsuccess = () => {
        db.close()
        resolve(get.result)
      }
      get.onerror = () => reject(get.error)
    }
  })
}

describe('localStorage key migration', () => {
  test('carries the startup file and settings over to the new names', async () => {
    const s = new FakeStorage()
    s.map.set(LEGACY_APP_KEY, 'STARTUP-BYTES')
    s.map.set(LEGACY_SETTINGS_KEY, '{"theme":"dark"}')

    await migrateAppIdentity(s)

    expect(s.map.get(APP_KEY_NAME)).toBe('STARTUP-BYTES')
    expect(s.map.get(`${APP_KEY_NAME}-settings`)).toBe('{"theme":"dark"}')
  })

  test('leaves the legacy keys in place (copy, never move)', async () => {
    const s = new FakeStorage()
    s.map.set(LEGACY_APP_KEY, 'STARTUP-BYTES')

    await migrateAppIdentity(s)

    expect(s.map.get(LEGACY_APP_KEY)).toBe('STARTUP-BYTES')
  })

  test('is idempotent: a second run does not clobber post-migration edits', async () => {
    const s = new FakeStorage()
    s.map.set(LEGACY_APP_KEY, 'OLD')
    await migrateAppIdentity(s)

    // The user works in the renamed app; the new key moves on, the old doesn't.
    s.map.set(APP_KEY_NAME, 'NEW')
    await migrateAppIdentity(s)

    expect(s.map.get(APP_KEY_NAME)).toBe('NEW')
  })

  test('does not overwrite a destination that already holds data', async () => {
    const s = new FakeStorage()
    s.map.set(LEGACY_APP_KEY, 'OLD')
    s.map.set(APP_KEY_NAME, 'ALREADY-HERE')

    await migrateAppIdentity(s)

    expect(s.map.get(APP_KEY_NAME)).toBe('ALREADY-HERE')
  })

  test('survives a storage backend that throws', async () => {
    const s = new FakeStorage()
    s.map.set(LEGACY_APP_KEY, 'OLD')
    s.poison = LEGACY_APP_KEY

    await expect(migrateAppIdentity(s)).resolves.toBeUndefined()
    expect(s.map.has(APP_KEY_NAME)).toBe(false)
  })

  // A saved startup scene is megabytes of base64 and localStorage allows ~5MB
  // per origin, so the two copies never coexist — the real profile test hit
  // exactly this and lost the scene.
  test('falls back to a move when holding both copies would blow the quota', async () => {
    const s = new FakeStorage()
    const scene = 'S'.repeat(12)
    s.map.set(LEGACY_APP_KEY, scene)
    s.capacity = 20

    await migrateAppIdentity(s)

    expect(s.map.get(APP_KEY_NAME)).toBe(scene)
    expect(s.map.has(LEGACY_APP_KEY)).toBe(false)
    expect(s.map.get(`${APP_KEY_NAME}-migrated-from-legacy`)).toBe('moved')
  })

  test('puts the legacy key back if the move also fails', async () => {
    const s = new FakeStorage()
    s.map.set(LEGACY_APP_KEY, 'SCENE')
    s.refuseWrites.add(APP_KEY_NAME)

    await migrateAppIdentity(s)

    expect(s.map.get(LEGACY_APP_KEY)).toBe('SCENE')
    expect(s.map.has(APP_KEY_NAME)).toBe(false)
    expect(s.map.has(`${APP_KEY_NAME}-migrated-from-legacy`)).toBe(false)
  })

  test('is a no-op on file-backed (NW.js) storage', async () => {
    const s = new FakeStorage()
    s.isFileBacked = true
    s.map.set(LEGACY_APP_KEY, 'OLD')

    await migrateAppIdentity(s)

    expect(s.map.has(APP_KEY_NAME)).toBe(false)
  })
})

describe('addon database migration', () => {
  const rows = [
    {key: 'a/manifest.json', addonId: 'a', bytes: enc.encode('{"id":"a"}')},
    {key: 'a/build/main.js', addonId: 'a', bytes: enc.encode('export const x = 1')},
  ]

  test('copies every record under the new database name', async () => {
    const legacy = uniqDbName()
    const dest = uniqDbName()
    await seedLegacyDb(legacy, rows)

    expect(await migrateAddonDatabase(legacy, dest)).toBe('copied')

    const copied = (await readAll(dest, 'files')) as typeof rows
    expect(copied.map((r) => r.key).sort()).toEqual(['a/build/main.js', 'a/manifest.json'])
    expect(new Uint8Array(copied.find((r) => r.key === 'a/manifest.json')!.bytes)).toEqual(rows[0].bytes)
  })

  test('leaves the legacy database intact', async () => {
    const legacy = uniqDbName()
    await seedLegacyDb(legacy, rows)

    await migrateAddonDatabase(legacy, uniqDbName())

    expect((await readAll(legacy, 'files')).length).toBe(2)
  })

  test('reports "absent" when there is nothing to migrate', async () => {
    expect(await migrateAddonDatabase(uniqDbName(), uniqDbName())).toBe('absent')
  })

  test('does not clobber a destination that already has records', async () => {
    const legacy = uniqDbName()
    const dest = uniqDbName()
    await seedLegacyDb(legacy, rows)
    await seedLegacyDb(dest, [{key: 'b/manifest.json', addonId: 'b', bytes: enc.encode('{"id":"b"}')}])

    expect(await migrateAddonDatabase(legacy, dest)).toBe('skipped')

    const kept = (await readAll(dest, 'files')) as typeof rows
    expect(kept.map((r) => r.key)).toEqual(['b/manifest.json'])
  })

  test('migrateAppIdentity targets the name the addon backend actually opens', async () => {
    expect(ADDON_DB_NAME).toBe(`${APP_KEY_NAME}-addons`)
  })
})
