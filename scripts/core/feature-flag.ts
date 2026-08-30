import {DataAPI, DataStruct} from '../path.ux/scripts/pathux'
import {default as messageBus, IBusEmitter, BusTriggers} from './bus'
import {getAppStorage} from './app_storage'
import {registerSyncTarget, noteLocalWrite} from './storage_sync'
import {registerDataAPI} from '../data_api/api_define_registry'

const FEATURE_FLAGS_KEY = 'feature-flags-app'

/** Flag keys contain dots; datapath member apinames cannot. */
export function featureFlagApiName(key: string): string {
  return key.replace(/[^\w]/g, '_')
}

export interface FeatureFlag {
  key: string
  uiName?: string
  description: string
  type: 'bool' // only bool for now
  value: boolean
}

declare global {
  /**
   * Flag keys, contributed by declaration merging. The host defines no flags —
   * a flag describes a feature, and features live in addons — so an addon adds
   * its keys with `declare global { interface FeatureFlagRegistry { … } }` and
   * `FeatureFlags.get/set` stay typo-checked without the host naming anything.
   * A build whose augmentations are all absent degrades to `string`, which is
   * looser but never wrong.
   */

  interface FeatureFlagRegistry {}
}

/** The registered keys, or `string` when nothing has augmented the registry. */
export type FeatureFlagKeys = keyof FeatureFlagRegistry extends never ? string : keyof FeatureFlagRegistry

/**
 * Declares `flag` on a `FeatureFlagManager` struct. Used by `defineAPI` and, for
 * a flag registered after `getDataAPI()` already ran, by the addon API.
 */
export function defineFeatureFlagMember(st: DataStruct, flag: Readonly<FeatureFlag>): void {
  const key = flag.key as FeatureFlagKeys
  /* customGetSet means the member path is never dereferenced, but path.ux
   * still parses it — so it must be the dot-free mangled name too. */
  const apiname = featureFlagApiName(flag.key)
  st.bool(apiname, apiname, flag.uiName ?? flag.key, flag.description).customGetSet<FeatureFlagManager>(
    function () {
      return this.dataref.get(key)
    },
    function (value: boolean) {
      this.dataref.set(key, value)
    }
  )
}

type StoredFeatureFlag = Omit<FeatureFlag, 'value'> & {
  /** undefined means use default value */
  value?: FeatureFlag['value']
  /** last modification time */
  mtime: number
}

export class FeatureFlagManager implements IBusEmitter<typeof FeatureFlagManager> {
  static busDefine() {
    return {
      events  : ['FLAG_SET'],
      triggers: [],
    } as const
  }

  /** Stored overrides, including flags no addon in this build defines. */
  flags: StoredFeatureFlag[] = []
  /** Definitions of the flags this build actually has, by key. */
  private defs = new Map<string, Readonly<FeatureFlag>>()
  private defined = new Set<string>()
  private LSKEY = FEATURE_FLAGS_KEY

  constructor() {
    this.load()
    messageBus.addEmitter(this, FeatureFlagManager)
  }

  /**
   * Adds flag definitions. Storage is keyed by flag name and never pruned, so a
   * value written by a build that had the flag survives a build that does not
   * and comes back when the addon does.
   */
  registerFlags(flags: readonly Readonly<FeatureFlag>[]): void {
    for (const flag of flags) {
      this.defs.set(flag.key, flag)
      if (!this.has(flag.key)) {
        this.flags.push({...flag, value: undefined, mtime: Date.now()})
      }
    }
  }

  /** Drops definitions (their stored values stay). Mirrors `registerFlags`. */
  unregisterFlags(keys: readonly string[]): void {
    for (const key of keys) {
      this.defs.delete(key)
    }
  }

  /** True once `key`'s data-API member has been declared; set by the caller. */
  markDefined(key: string): boolean {
    if (this.defined.has(key)) {
      return false
    }
    this.defined.add(key)
    return true
  }

  onTrigger(type: BusTriggers<typeof FeatureFlagManager>, data: any) {
    //
  }

  /** Whether a value is stored for `key` — `string`, not a registered key,
   * because storage outlives the addon that defined the flag. */
  has(key: string): boolean {
    return this.flags.find((f) => f.key === key) !== undefined
  }

  /** Reading a flag no addon in this build defines yields `false`, not a throw. */
  get(key: FeatureFlagKeys): boolean {
    return this.flags.find((f) => f.key === key)?.value ?? this.defs.get(key)?.value ?? false
  }

  /** The definitions this build has (defaults), not the stored overrides. */
  get definitions(): readonly Readonly<FeatureFlag>[] {
    return [...this.defs.values()]
  }

  private stored(key: string): StoredFeatureFlag {
    let flag = this.flags.find((f) => f.key === key)
    if (!flag) {
      const def = this.defs.get(key)
      flag = {key, description: def?.description ?? '', type: 'bool', value: undefined, mtime: Date.now()}
      this.flags.push(flag)
    }
    return flag
  }

  set(key: FeatureFlagKeys, value: boolean) {
    const flag = this.stored(key)
    if (flag.value !== value) {
      flag.value = value
      flag.mtime = Date.now()
      this.save()
      messageBus.emit(this, FeatureFlagManager, 'FLAG_SET', {key, value})
    }
  }

  reset(key: FeatureFlagKeys) {
    const flag = this.stored(key)
    if (flag.value !== undefined) {
      flag.value = undefined
      flag.mtime = Date.now()
      this.save()
      // Resets change the effective value too — same rebuild signal as set().
      messageBus.emit(this, FeatureFlagManager, 'FLAG_SET', {key, value: this.get(key)})
    }
  }

  load() {
    const json = getAppStorage().getText(this.LSKEY)
    this.flags = json ? (JSON.parse(json) as StoredFeatureFlag[]) : this.flags
  }

  private merge() {
    /* Merge in-memory flags with whatever's on disk, keyed by `key` with the
     * newest mtime winning — this per-key mtime merge IS the cross-instance
     * conflict resolution (two instances toggling different flags both survive).
     * Deduping by key also bounds the array (a prior bug grew it every save).
     * Runs inside the storage CAS loop so a concurrent writer can't be lost. */
    getAppStorage().updateText(this.LSKEY, (existing) => {
      const byKey = new Map<string, StoredFeatureFlag>()
      const consider = (flag: StoredFeatureFlag) => {
        const prev = byKey.get(flag.key)
        if (!prev || prev.mtime < flag.mtime) {
          byKey.set(flag.key, {...flag})
        }
      }

      for (const f of this.flags) {
        consider(f)
      }
      if (existing !== undefined) {
        for (const f of JSON.parse(existing) as StoredFeatureFlag[]) {
          consider(f)
        }
      }

      this.flags = [...byKey.values()]
      return JSON.stringify(this.flags, undefined, 2)
    })
    noteLocalWrite(this.LSKEY)
  }

  /** Re-read flags after another instance wrote (storage_sync). path.ux polls
   * flag getters each frame, so refreshing `flags` is enough for the UI. */
  reloadFromDisk() {
    this.load()
    for (const flag of this.definitions) {
      if (!this.has(flag.key)) {
        this.flags.push({...flag, value: undefined, mtime: Date.now()})
      }
    }
  }

  /**
   * Declares whatever is registered when the data API is built. Addons register
   * after that (`getDataAPI()` is one-shot), so those flags declare themselves
   * against the live API instead — see `AddonAPI.registerFeatureFlags`.
   */
  static defineAPI(api: DataAPI, st?: DataStruct): DataStruct {
    st = st ?? api.mapStruct(FeatureFlagManager, true)

    for (const flag of FeatureFlags.definitions) {
      if (FeatureFlags.markDefined(flag.key)) {
        defineFeatureFlagMember(st, flag)
      }
    }

    return st
  }

  save() {
    this.merge()
  }
}

registerDataAPI(FeatureFlagManager)

export const FeatureFlags = new FeatureFlagManager()

// Converge when another instance toggles a flag (NW.js multi-instance).
registerSyncTarget({key: FEATURE_FLAGS_KEY, reload: () => FeatureFlags.reloadFromDisk()})

declare global {
  interface Window {
    FeatureFlags: FeatureFlagManager
  }
}
/* Debug-surface global (documentation/debugSurface.md): lets CDP / --eval
 * probes flip flags at runtime. */
if (typeof window !== 'undefined') {
  window.FeatureFlags = FeatureFlags
}
