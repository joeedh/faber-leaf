import {util, nstructjs, DataAPI, DataStruct} from '../path.ux/scripts/pathux.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import {BrushSets, setBrushSet} from '../brush/brush'
import addonManager from '../addon/addon.js'
import {getAppStorage} from './app_storage'
import {APP_KEY_NAME} from './const'
import {registerSyncTarget, noteLocalWrite} from './storage_sync'
import {FeatureFlags, FeatureFlagManager} from './feature-flag'

import '../util/polyfill.d.ts'
import {StructReader} from '../path.ux/scripts/util/nstructjs.js'

declare let _appstate: any

export class SavedScreen {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
SavedScreen {
  data : array(byte);
}
`
  )

  name: string
  data: ArrayBuffer | string

  constructor(name: string, data: ArrayBuffer | string) {
    this.name = name
    this.data = data
  }

  static create(name = 'Screen'): SavedScreen {
    const file = _appstate.createFile({save_screen: true, save_library: false, save_settings: false})
    return new SavedScreen(name, file)
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    this.data = new Uint8Array(this.data as any).buffer
  }
}

export const SETTINGS_KEY = `${APP_KEY_NAME}-settings`

/** Deep structural equality for the small JSON values in AppSettings. */
function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Merge this instance's settings onto whatever is currently on disk, so a
 * concurrent instance's changes to *other* fields survive. `mine` wins only for
 * fields it actually changed since `baseline` (the on-disk state we loaded);
 * every unchanged field defers to `disk`. `addonSettings` is merged per addon
 * id so two instances toggling different addons don't clobber each other.
 */
function mergeSettings(
  disk: Partial<AppSettingsJSON>,
  mine: AppSettingsJSON,
  baseline: AppSettingsJSON | undefined
): AppSettingsJSON {
  const out = {...mine} as Record<string, unknown>
  const md = disk as Record<string, unknown>
  const mm = mine as unknown as Record<string, unknown>
  const mb = (baseline ?? {}) as Record<string, unknown>

  for (const k of Object.keys(mine)) {
    if (k === 'addonSettings') continue
    const changedByMe = !jsonEq(mm[k], mb[k])
    out[k] = changedByMe ? mm[k] : k in md ? md[k] : mm[k]
  }

  out.addonSettings = mergeAddonSettings(
    (mm.addonSettings ?? {}) as Record<string, unknown>,
    (md.addonSettings ?? {}) as Record<string, unknown>,
    (mb.addonSettings ?? {}) as Record<string, unknown>
  )
  return out as unknown as AppSettingsJSON
}

function mergeAddonSettings(
  mine: Record<string, unknown>,
  disk: Record<string, unknown>,
  baseline: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {...disk}
  for (const id of new Set([...Object.keys(mine), ...Object.keys(disk)])) {
    if (!jsonEq(mine[id], baseline[id])) {
      // I changed this addon's entry: my value wins (or removal).
      if (mine[id] === undefined) delete out[id]
      else out[id] = mine[id]
    } else if (!(id in out) && mine[id] !== undefined) {
      out[id] = mine[id]
    }
  }
  return out
}

export interface AddonSettingsJSON {
  name: string
  enabled: boolean
  settings: Record<string, any>
}

export class AddonSettings {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
AddonSettings {
  name     : string;
  enabled  : bool;
  settings : string | JSON.stringify(this.settings);
}
`
  )

  name: string
  enabled: boolean
  settings: Record<string, any> | string

  constructor(name = '') {
    this.name = name
    this.enabled = false
    this.settings = {} //json
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    try {
      this.settings = JSON.parse(this.settings as string)
    } catch (error) {
      console.error((error as Error).message, '\n' + (error as Error).stack)
      this.settings = {}
    }
  }

  toJSON(): AddonSettingsJSON {
    return {
      name    : this.name,
      enabled : this.enabled,
      settings: this.settings as Record<string, any>,
    }
  }

  loadJSON(json: AddonSettingsJSON): this {
    this.settings = json.settings
    this.name = json.name
    this.enabled = json.enabled

    return this
  }
}

export interface AppSettingsJSON {
  screens: SavedScreen[]
  limitUndoMem: boolean
  undoMemLimit: number
  brushSet: number
  autosaveEnabled: boolean
  autosaveIntervalMinutes: number
  autosaveMaxBackups: number
  autosaveToProjectDir: boolean
  addonSettings: Record<string, AddonSettingsJSON>
}

export class AppSettings {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
AppSettings {
  screens                 : array(SavedScreen);
  limitUndoMem            : bool;
  undoMemLimit            : int;
  brushSet                : int;
  autosaveEnabled         : bool;
  autosaveIntervalMinutes : double;
  autosaveMaxBackups      : int;
  autosaveToProjectDir    : bool;
  addonSettings           : iterkeys(AddonSettings);
}
`
  )

  screens: SavedScreen[]
  addonSettings: Record<string, AddonSettings>
  limitUndoMem: boolean
  undoMemLimit: number
  brushSet: number
  autosaveEnabled: boolean
  autosaveIntervalMinutes: number
  autosaveMaxBackups: number
  autosaveToProjectDir: boolean

  /** On-disk JSON we last loaded/synced; the diff baseline for CAS merges so a
   * save only overrides fields this instance actually changed. */
  private _baseline?: AppSettingsJSON

  constructor() {
    this.screens = []
    this.addonSettings = {}
    this.limitUndoMem = true
    this.undoMemLimit = 512 //in megabytes
    this.brushSet = BrushSets.MEDIUM_RES
    this.autosaveEnabled = true
    this.autosaveIntervalMinutes = 1 //UI in minutes; clamped 0.5–120
    this.autosaveMaxBackups = 5
    this.autosaveToProjectDir = true
  }

  /* Feature flags persist through their own storage key, not AppSettings;
   * this getter just roots them in the datapath tree at settings.featureFlags. */
  get featureFlags(): FeatureFlagManager {
    return FeatureFlags
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = struct ?? api.mapStruct(this, true)

    const onchange = function (this: {dataref: AppSettings}) {
      if (this.dataref === _appstate.settings) {
        this.dataref.save()
      }
    }

    st.bool('limitUndoMem', 'limitUndoMem', 'Limit Undo Memory').on('change', onchange)
    st.int('undoMemLimit', 'undoMemLimit', 'Mem Limit', 'Memory Limit in megabytes (for undo)').on('change', onchange)

    // Autosave: persist immediately on change and re-arm the running timer so a
    // new interval / enable toggle takes effect without a restart.
    const onAutosaveChange = function (this: {dataref: AppSettings}) {
      if (this.dataref === _appstate.settings) {
        this.dataref.save()
        ;(window as unknown as {_appstate?: {autosave?: {rearm(): void}}})._appstate?.autosave?.rearm()
      }
    }

    st.bool('autosaveEnabled', 'autosaveEnabled', 'Enable Autosave').on('change', onAutosaveChange)
    st.float('autosaveIntervalMinutes', 'autosaveIntervalMinutes', 'Autosave Interval', 'Minutes between autosaves')
      .noUnits()
      .range(0.5, 120)
      .on('change', onAutosaveChange)
    st.int('autosaveMaxBackups', 'autosaveMaxBackups', 'Max Backups', 'Number of rotating autosave backups to keep')
      .range(1, 50)
      .on('change', onAutosaveChange)
    st.bool(
      'autosaveToProjectDir',
      'autosaveToProjectDir',
      'Autosave Next To Project',
      'Write backups next to the open project (vs. into .sculptcore/autosave)'
    ).on('change', onAutosaveChange)
    st.enum('brushSet', 'brushSet', BrushSets)
      .on('change', function (this: {dataref: AppSettings}) {
        const settings = this.dataref

        setBrushSet(settings.brushSet)
      })
      .descriptions({
        MEDIUM_RES:
          'For 100k triangle meshes and less.\nBrushes will try to align geometry to curvature.\n (i.e. Rake and Curvature Factor are set to 1).',
      })

    const ast = api.mapStruct(AddonSettings, true)
    ast.bool('enabled', 'enabled', 'Enabled').on('change', function (this: {dataref: AddonSettings}, val: unknown) {
      // AddonSettings.name is the manifest id. Route through the manager so
      // dependencies are auto-enabled and disabling a depended-on addon is
      // blocked with a message.
      const id = this.dataref.name
      const result = val ? addonManager.enable(id) : addonManager.disable(id)

      if (!result.ok && result.message) {
        window.alert?.(result.message)
      }

      // Reconcile every persisted flag to the real enabled state — a blocked
      // toggle snaps the checkbox back, and an enable that pulled deps on marks
      // those deps enabled too.
      const settings = (window as any)._appstate?.settings as AppSettings | undefined
      if (settings) {
        settings.syncEnabledFlags()
        settings.save()
      } else {
        this.dataref.enabled = addonManager.idmap.get(id)?.enabled ?? false
      }
    })

    ast.string('name', 'name', 'Name').readOnly()

    st.struct('featureFlags', 'featureFlags', 'Feature Flags', api.mapStruct(FeatureFlagManager, true))

    st.list('addonSettings', 'addons', {
      getStruct(api: any, list: any, key: string) {
        return ast
      },

      get(api: any, list: Record<string, AddonSettings>, key: string) {
        return list[key]
      },

      getKey(api: any, list: any, obj: AddonSettings) {
        return obj.name
      },

      getLength(api: any, list: Record<string, AddonSettings>) {
        return Object.keys(list).length
      },

      getIter(api: any, list: Record<string, AddonSettings>) {
        return (function* () {
          for (const k in list) {
            yield list[k]
          }
        })()
      },
    })
    return st
  }

  toJSON(): AppSettingsJSON {
    return {
      screens                : this.screens,
      limitUndoMem           : this.limitUndoMem,
      undoMemLimit           : this.undoMemLimit,
      brushSet               : this.brushSet,
      autosaveEnabled        : this.autosaveEnabled,
      autosaveIntervalMinutes: this.autosaveIntervalMinutes,
      autosaveMaxBackups     : this.autosaveMaxBackups,
      autosaveToProjectDir   : this.autosaveToProjectDir,
      addonSettings          : this.addonSettings as any,
    }
  }

  loadJSON(json: AppSettingsJSON): void {
    this.limitUndoMem = json.limitUndoMem
    this.undoMemLimit = json.undoMemLimit

    if (json.brushSet !== undefined) {
      this.brushSet = json.brushSet
    }

    if (json.autosaveEnabled !== undefined) {
      this.autosaveEnabled = json.autosaveEnabled
    }
    if (json.autosaveIntervalMinutes !== undefined) {
      this.autosaveIntervalMinutes = json.autosaveIntervalMinutes
    }
    if (json.autosaveMaxBackups !== undefined) {
      this.autosaveMaxBackups = json.autosaveMaxBackups
    }
    if (json.autosaveToProjectDir !== undefined) {
      this.autosaveToProjectDir = json.autosaveToProjectDir
    }

    this.addonSettings = (json.addonSettings as any) || {}

    for (const k in this.addonSettings) {
      const json2 = this.addonSettings[k] as any as AddonSettingsJSON
      this.addonSettings[k] = new AddonSettings().loadJSON(json2)
    }

    //this.screens = json.screens;
  }

  save(): void {
    console.log(util.termColor('Saving settings', 'green'))
    const mine = this.toJSON()
    getAppStorage().updateText(SETTINGS_KEY, (existing) => {
      const disk = existing ? (JSON.parse(existing) as Partial<AppSettingsJSON>) : {}
      return JSON.stringify(mergeSettings(disk, mine, this._baseline))
    })
    // The committed state is our new diff baseline. If another instance merged
    // fields in (committed differs from what we wrote), converge in-memory now:
    // we made the last write, so polling would never see a version change to
    // trigger the reload. No-op churn-free in the single-instance case.
    const committed = getAppStorage().getText(SETTINGS_KEY)
    if (committed !== undefined) {
      const json = JSON.parse(committed) as AppSettingsJSON
      if (JSON.stringify(json) !== JSON.stringify(mine)) {
        this.loadJSON(json)
      }
      this._baseline = json
    } else {
      this._baseline = mine
    }
    noteLocalWrite(SETTINGS_KEY)
  }

  /** Re-read settings after another instance wrote (storage_sync). Applies the
   * scalar prefs and addon *flags*, but never live-toggles addons — that stays
   * a deliberate, same-instance action. */
  syncFromDisk(): void {
    const raw = getAppStorage().getText(SETTINGS_KEY)
    if (raw === undefined) return
    let json: AppSettingsJSON
    try {
      json = JSON.parse(raw)
    } catch {
      return
    }
    this.loadJSON(json)
    this._baseline = json
    try {
      setBrushSet(this.brushSet)
    } catch (error) {
      util.print_stack(error as Error)
    }
    ;(window as unknown as {_appstate?: {autosave?: {rearm(): void}}})._appstate?.autosave?.rearm()
  }

  _loadAddons(): void {
    // One-time migration: addon settings are now keyed by manifest id. Drop any
    // legacy url-derived keys (e.g. "internalmesh") that don't match a current
    // addon id — builtin legacy entries unreliably stored enabled=false (they
    // were force-enabled), so we don't trust them. syncAddonList() below then
    // recreates id-keyed entries at their current (default-on) state. Net: a
    // one-time reset of addon enabled prefs.
    const validIds = new Set(addonManager.addons.map((r) => r.manifest?.id ?? r.key))
    for (const k of Object.keys(this.addonSettings)) {
      if (!validIds.has(k)) {
        delete this.addonSettings[k]
      }
    }

    this.syncAddonList()

    // Pass 1: enable everything the user wants enabled (pulls deps on
    // transitively, regardless of a dep's own persisted flag).
    for (const rec of addonManager.addons) {
      const id = rec.manifest?.id ?? rec.key
      const s = this.addonSettings[id]
      if (s?.enabled && !rec.enabled) {
        addonManager.enable(id)
      }
    }

    // Pass 2: disable user-disabled addons, honoring dependents. A disable
    // blocked by an enabled dependent is retried after that dependent is
    // disabled (loop until stable).
    let changed = true
    while (changed) {
      changed = false
      for (const rec of addonManager.addons) {
        const id = rec.manifest?.id ?? rec.key
        const s = this.addonSettings[id]
        if (s && !s.enabled && rec.enabled) {
          const res = addonManager.disable(id)
          if (res.ok) changed = true
        }
      }
    }

    // Truth pass: make persisted flags match reality (a dep kept on because a
    // dependent needs it gets its flag corrected to enabled).
    this.syncEnabledFlags()
  }

  /** Writes each addon's actual enabled state back into its AddonSettings. */
  syncEnabledFlags(): void {
    for (const rec of addonManager.addons) {
      const id = rec.manifest?.id ?? rec.key
      if (this.addonSettings[id]) {
        this.addonSettings[id].enabled = rec.enabled
      }
    }
  }

  load(): void {
    let json: AppSettingsJSON

    const raw = getAppStorage().getText(SETTINGS_KEY)
    if (raw === undefined) {
      return
    }

    try {
      json = JSON.parse(raw)
    } catch (error) {
      console.warn('Failed to load user settings')
      return
    }

    this.loadJSON(json)
    this._baseline = json

    try {
      setBrushSet(this.brushSet)
    } catch (error) {
      util.print_stack(error as Error)
    }

    //window.setTimeout(() => {
    this._loadAddons()
    //});
  }

  syncAddonList(): boolean {
    let ret = false

    for (const addon of addonManager.addons) {
      const id = addon.manifest?.id ?? addon.key
      if (!(id in this.addonSettings)) {
        const s = new AddonSettings(id)
        // Capture the addon's current (default-on after start()) state so a
        // freshly-seen addon isn't spuriously treated as user-disabled.
        s.enabled = addon.enabled
        this.addonSettings[id] = s

        ret = true
      }
    }

    if (ret) {
      this.save()
    }

    return ret
  }

  destroy(): void {}

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    const addonSettings = this.addonSettings as any

    console.error('addonSettings', addonSettings)

    if (!(addonSettings instanceof Array)) {
      return
    }

    this.addonSettings = {}

    for (const addon of addonSettings as AddonSettings[]) {
      this.addonSettings[addon.name] = addon
    }
  }
}

registerDataAPI(AppSettings)

// Converge when another instance changes settings (NW.js multi-instance): the
// active app's settings re-read from disk. Target the live instance, not a
// captured one, since AppSettings is swapped on file load.
registerSyncTarget({
  key   : SETTINGS_KEY,
  reload: () => (window as unknown as {_appstate?: {settings?: AppSettings}})._appstate?.settings?.syncFromDisk(),
})
