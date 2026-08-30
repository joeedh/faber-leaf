/**
 * Cross-instance settings/flag sync (NW.js multi-instance).
 *
 * Several NW.js windows in one worktree share `.sculptcore` (settings.json,
 * feature-flags.json). Writes go through the app_storage CAS path so they don't
 * clobber each other; this module makes the *readers* converge: it polls each
 * shared file's change token (mtime:size) and, when another instance wrote,
 * reloads that state into the running app.
 *
 * Kept import-free of settings/feature-flag to avoid an import cycle: those
 * modules register a target and stamp their own writes via noteLocalWrite so a
 * poll never reloads an instance's own just-written file (which could stomp an
 * in-memory edit made between the write and the next tick).
 */

import {getAppStorage} from './app_storage'

interface SyncTarget {
  /** Storage key of the shared file. */
  key: string
  /** Reload this state from disk (another instance changed it). */
  reload(): void
}

const POLL_MS = 1000
const targets: SyncTarget[] = []
const lastVersion = new Map<string, string | undefined>()
let started = false

/** Register a shared-state consumer. Called once per module at import time. */
export function registerSyncTarget(target: SyncTarget): void {
  targets.push(target)
}

/** Record that this instance just wrote @p key, so the next poll treats the
 * resulting version bump as our own and skips the reload. */
export function noteLocalWrite(key: string): void {
  lastVersion.set(key, getAppStorage().version(key))
}

/** Begin polling. No-op in the browser (single instance) or if already running. */
export function startStorageSync(): void {
  const storage = getAppStorage()
  if (started || !storage.isFileBacked) return
  started = true

  for (const t of targets) lastVersion.set(t.key, storage.version(t.key))

  setInterval(() => {
    for (const t of targets) {
      const v = storage.version(t.key)
      if (v === lastVersion.get(t.key)) continue
      lastVersion.set(t.key, v)
      try {
        t.reload()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('storage_sync: reload failed for', t.key, err)
      }
    }
  }, POLL_MS)
}
