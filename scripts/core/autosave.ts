/**
 * Periodic, dirty-gated, atomic autosave + crash recovery (plan §3).
 *
 * A single setTimeout-rearmed loop (never setInterval, so a long save can't
 * pile up) serializes the project on an interval, but only when the document
 * actually changed (dirty gate) and no modal tool / sculpt stroke is running
 * (idle gate). Bytes go to a pluggable AutosaveBackend that rotates them
 * atomically and records a recovery pointer. On the next launch checkRecovery()
 * offers to reload the newest backup if it shadows newer-than-the-project work.
 *
 * The serializer is pluggable: M1 serializes on the main thread (createFile);
 * M3 swaps in a worker-backed split serializer (see autosave_serialize.ts).
 */

import type {AppState} from './appstate'
import * as cconst from './const'
import {getAutosaveBackend, type AutosaveBackend, type AutosaveLatest} from './autosave_backend'
import {setSerializeCacheMode} from './serialize_cache'
import {isAutosaveContainer} from './autosave_format'
import {loadSplitAutosave, SplitSerializer} from './autosave_serialize'
import {AutosaveWorkerHost} from './autosave_worker_host'
import {hasArg} from './app_argv'

const MIN_INTERVAL_MIN = 0.5
const MAX_INTERVAL_MIN = 120

export interface AutosaveSerializer {
  /** Produce the full autosave file bytes for the current project. */
  serialize(state: AppState): Promise<Uint8Array>
  /** Load a recovered autosave file (default: treat as a plain .wproj). */
  load?(state: AppState, bytes: Uint8Array): Promise<void>
  dispose?(): void
}

/** Default serializer (M3): split serialization with the compression worker.
 * The worker host falls back to inline main-thread compression when no worker
 * can be spawned, so this is always safe; recovery is format-aware regardless. */
function makeDefaultSerializer(): AutosaveSerializer {
  const host = new AutosaveWorkerHost()
  return new SplitSerializer(host.compress, () => host.dispose())
}

/** M1 fallback: serialize synchronously on the main thread via createFile.
 * M2: opt into the per-mesh blob cache so unchanged meshes aren't recompressed
 * (the canonical app.save path never sets this, so its output is always fresh).
 * Retained as a simple, worker-free serializer (pass it to AutosaveManager). */
export class MainThreadSerializer implements AutosaveSerializer {
  async serialize(state: AppState): Promise<Uint8Array> {
    // No whole-file deflate: the bulk (mesh blobs) is already lz4-compressed
    // inline, so JSZip would burn main-thread CPU for little gain.
    setSerializeCacheMode(true)
    try {
      const buf = state.createFile({save_toolstack: false, save_screen: true, compress: false})
      return new Uint8Array(buf)
    } finally {
      setSerializeCacheMode(false)
    }
  }
}

function clampInterval(min: number): number {
  if (!(min > 0)) return MIN_INTERVAL_MIN
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, min))
}

export class AutosaveManager {
  state: AppState
  backend: AutosaveBackend | null
  serializer: AutosaveSerializer

  private timer: ReturnType<typeof setTimeout> | undefined
  private lastSavedChangeId = 0
  private saving = false
  private recoveryChecked = false
  /** Last successful autosave time (epoch ms), for the status indicator. */
  lastAutosaveTime = 0

  constructor(state: AppState, serializer?: AutosaveSerializer) {
    this.state = state
    this.backend = getAutosaveBackend()
    this.serializer = serializer ?? makeDefaultSerializer()
  }

  private get settings() {
    return this.state.settings
  }

  private enabled(): boolean {
    return !!this.backend && !!this.settings.autosaveEnabled
  }

  /** Begin the scheduler. Call once after the app has booted. */
  start(): void {
    // Baseline: don't autosave a pristine just-loaded file until it's edited.
    this.lastSavedChangeId = this.state.changeId
    this.scheduleNext()
  }

  /** Re-arm the timer (settings changed: interval / enable toggled). */
  rearm(): void {
    this.scheduleNext()
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  dispose(): void {
    this.stop()
    this.serializer.dispose?.()
  }

  private scheduleNext(): void {
    this.stop()
    if (!this.enabled()) {
      return
    }
    const ms = clampInterval(this.settings.autosaveIntervalMinutes) * 60_000
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private isIdle(): boolean {
    const ts = this.state.toolstack as unknown as {modal_running?: boolean}
    return !ts.modal_running
  }

  private isDirty(): boolean {
    return this.state.changeId !== this.lastSavedChangeId
  }

  private async tick(): Promise<void> {
    try {
      if (this.enabled() && !this.saving && this.isIdle() && this.isDirty()) {
        await this.runAutosave('auto')
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('autosave: tick failed', err)
    } finally {
      this.scheduleNext()
    }
  }

  /** Force an autosave now (e.g. on window blur / before quit). */
  async saveNow(): Promise<AutosaveLatest | undefined> {
    if (!this.enabled() || this.saving) return undefined
    return this.runAutosave('manual')
  }

  private currentSourcePath(): string | null {
    const h = this.state.saveHandle as {data?: string; name?: string} | undefined
    return h?.data ?? h?.name ?? null
  }

  private async runAutosave(reason: 'auto' | 'manual'): Promise<AutosaveLatest | undefined> {
    if (!this.backend) return undefined

    this.saving = true
    const changeIdAtStart = this.state.changeId
    this.status('Autosaving…')

    try {
      const bytes = await this.serializer.serialize(this.state)
      const latest = await this.backend.writeBackup(bytes, {
        sourcePath  : this.currentSourcePath(),
        appVersion  : cconst.APP_VERSION,
        maxBackups  : Math.max(1, this.settings.autosaveMaxBackups | 0),
        toProjectDir: !!this.settings.autosaveToProjectDir,
      })

      // Edits made *during* the async serialize bump changeId past the snapshot;
      // leaving lastSavedChangeId at the snapshot makes the next tick re-save.
      this.lastSavedChangeId = changeIdAtStart
      this.lastAutosaveTime = latest.timestamp
      this.status(`Autosaved ${formatTime(latest.timestamp)}`)
      return latest
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('autosave: save failed', err)
      this.status('Autosave failed')
      if (reason === 'manual') throw err
      return undefined
    } finally {
      this.saving = false
    }
  }

  /** Reset dirty baseline + drop the recovery pointer after an explicit save. */
  onProjectSaved(): void {
    this.lastSavedChangeId = this.state.changeId
    void this.backend?.clearLatest()
  }

  /**
   * Offer to reload the newest backup when it shadows newer-than-the-project
   * work (or the project was never saved). Call once after boot.
   */
  async checkRecovery(): Promise<boolean> {
    if (this.recoveryChecked || !this.backend) return false
    this.recoveryChecked = true

    // NW.js headless automation never auto-offers recovery on boot (the confirm()
    // would wedge the hidden renderer, and a deterministic test scene shouldn't be
    // silently replaced by a stale backup). Pass --autosave-recover to opt back in.
    if (hasArg('apptest-headless') && !hasArg('autosave-recover')) {
      return false
    }

    const latest = await this.backend.readLatest()
    if (!latest) return false

    let offer = true
    if (latest.sourcePath) {
      const mtime = await this.backend.sourceMtime(latest.sourcePath)
      // Only offer if the backup is meaningfully newer than the saved project
      // (1s slop absorbs filesystem timestamp granularity).
      offer = mtime === undefined || latest.timestamp > mtime + 1000
    }
    if (!offer) return false

    // Headless / automation: `--no-autosave-recover` skips the recovery prompt
    // and declines; `--autosave-recover` accepts it without prompting.
    if (hasArg('no-autosave-recover')) {
      return false
    }
    if (!hasArg('autosave-recover')) {
      const where = latest.sourcePath ? `Project: ${latest.sourcePath}` : '(untitled project)'
      const msg = `Recover unsaved work from ${formatTime(latest.timestamp)}?\n${where}`
      if (!(await recoverPrompt(this.state, msg))) {
        return false
      }
    }

    return this._applyLatest(latest)
  }

  /**
   * Unconditionally load the newest backup (the "Load Last Autosave" command).
   * Unlike checkRecovery this skips the once-only guard and the newer-than-project
   * test, so it always reloads whatever the latest backup is.
   */
  async loadLatest(): Promise<boolean> {
    if (!this.backend) return false
    const latest = await this.backend.readLatest()
    if (!latest) {
      this.status('No autosave found')
      return false
    }
    return this._applyLatest(latest)
  }

  /** Read + load a specific backup record, restoring the source fileHandle and
   * marking the result dirty so it re-autosaves. */
  private async _applyLatest(latest: AutosaveLatest): Promise<boolean> {
    if (!this.backend) return false

    const bytes = await this.backend.readBackup(latest.backupKey)
    if (!bytes) {
      // eslint-disable-next-line no-console
      console.warn('autosave: recovery backup vanished', latest.backupKey)
      return false
    }

    // Detect the format from the bytes, not the active serializer: a split
    // container must load split even if the serializer was since swapped back.
    if (isAutosaveContainer(bytes)) {
      await loadSplitAutosave(this.state, bytes)
    } else if (this.serializer.load) {
      await this.serializer.load(this.state, bytes)
    } else {
      await this.state.loadFileAsync(bytes.buffer as ArrayBuffer, {
        reset_toolstack: true,
        load_screen    : true,
        reset_context  : true,
      })
    }
    // Restore the save handle so a subsequent Save writes back to the project's
    // original file (works on Electron, where the handle is a path; a web
    // FileSystemFileHandle can't be reconstructed from a string, so Save there
    // falls back to a Save-As dialog).
    if (latest.sourcePath) {
      this.state.saveHandle = {data: latest.sourcePath, name: baseName(latest.sourcePath)}
    }
    this.lastSavedChangeId = -1 // mark dirty so the recovered state re-autosaves
    return true
  }
}

/**
 * Non-blocking recovery prompt: a path.ux screen popup with Recover / Discard
 * buttons. The native confirm() modal is deliberately avoided — it blocks the
 * renderer event loop (and devtools) until dismissed. Falls back to confirm()
 * only if no screen ever materializes (bounded wait — boot-time callers run
 * before the UI is built).
 */
interface RecoverPromptPopup {
  label(text: string): unknown
  row(): {button(label: string, cb: () => void): unknown}
  remove(): void
}
interface RecoverPromptScreen {
  size: ArrayLike<number>
  popup(owner: unknown, x: number, y: number, closeOnMouseOut: boolean): RecoverPromptPopup
}

async function recoverPrompt(state: AppState, msg: string): Promise<boolean> {
  const getScreen = () => (state as unknown as {screen?: RecoverPromptScreen}).screen
  for (let i = 0; i < 100 && !getScreen(); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const screen = getScreen()
  if (!screen) {
    return globalThis.confirm?.(msg) ?? false
  }

  return new Promise<boolean>((resolve) => {
    const w = 320
    const x = Math.max(10, screen.size[0] * 0.5 - w * 0.5)
    const y = Math.max(10, screen.size[1] * 0.33)
    const popup = screen.popup(screen, x, y, false)

    for (const line of msg.split('\n')) {
      popup.label(line)
    }

    let done = false
    const finish = (val: boolean) => {
      if (done) return
      done = true
      popup.remove()
      resolve(val)
    }

    const row = popup.row()
    row.button('Recover', () => finish(true))
    row.button('Cancel', () => finish(false))
  })
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString()
  } catch {
    return String(ms)
  }
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

// Augment AutosaveManager.prototype with a private status helper via a closure
// keeps the class body focused; declared here so methods above can call it.
;(AutosaveManager.prototype as unknown as {status(m: string): void}).status = function (
  this: AutosaveManager,
  m: string
): void {
  try {
    this.state.ctx?.message?.(m)
  } catch {
    /* context not ready */
  }
}

declare module './autosave' {
  interface AutosaveManager {
    status(m: string): void
  }
}
