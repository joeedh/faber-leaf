import {AddonAPI, IAddon} from './addon_base'
import * as util from '../util/util'
import {DisabledAddon, IAddonManifest, resolveManifests, validateManifest} from './manifest'
import {isForceDisabled} from './force_disable'
import {distributionEnabled, isInDistribution, setActiveDistribution, type Distribution} from './distribution'
import {runBootTasks} from '../core/boot_tasks'
import type {AddonStorage} from './storage'
import {Menu} from '../path.ux/scripts/widgets/ui_menu'

/**
 * Result of an enable()/disable() request. `ok` is false when the request was
 * blocked or failed; `message` is a human-readable explanation (e.g. the
 * dependent-addons block message) suitable for a UI toast.
 */
export interface AddonOpResult {
  ok: boolean
  reason?: 'unknown' | 'missing-dep' | 'register-threw' | 'has-dependents' | 'unregister-threw' | 'force-disabled'
  dependents?: AddonRecord<IAddon>[]
  message?: string
  error?: unknown
}

/**
 * How the manager obtains an addon's IAddon module. Builtin (in-bundle) sources
 * return the already-statically-imported module; external sources dynamic-import
 * it from a URL.
 */
type AddonModuleLoader = () => IAddon | Promise<IAddon>

interface AddonSource {
  manifest: IAddonManifest
  loadModule: AddonModuleLoader
  builtin: boolean
  /** Present only for external addons; becomes the AddonRecord.url + urlmap key. */
  url?: string
}

/**
 * Represents an addon that is known but not loaded, and records why.
 * Force-disabled addons and ones the resolver rejected both land here, so
 * the UI can report what happened instead of leaving the addon simply
 * absent.
 */
export interface UnloadedAddon {
  id: string
  name?: string
  reason: DisabledAddon['reason'] | 'force-disabled' | 'not-in-build' | 'not-in-distribution'
  message: string
}

export class AddonRecord<T extends IAddon> {
  addon: T
  addonAPI: AddonAPI<T>
  url: string
  _enabled: boolean
  /** True once onAddonCreate() has run (it must run at most once). */
  _created: boolean
  key: string
  name: string

  /** Parsed manifest. Every record now flows through the manifest pipeline. */
  manifest?: IAddonManifest

  /** True for first-party addons shipped with the app (builtin or in `index.json`). */
  builtin: boolean = false

  constructor(url: string, addon: T, addonAPI: AddonAPI<T>) {
    this.addon = addon
    this.addonAPI = addonAPI
    this.url = url
    this._enabled = false
    this._created = false

    let key = url.replace(/\.js/g, '').replace(/\./g, '')
    key = key.replace(/\//g, '').replace(/\\/g, '')
    key = key.replace(/-/g, '_').replace(/[ \n\r\t]/g, '')

    this.key = key

    if (addon.addonDefine) {
      if (typeof addon.addonDefine == 'function') {
        // eslint-disable-next-line no-console
        console.error(url + ': addonDefine should not be a function')
        this.name = this.key
      } else {
        this.name = addon.addonDefine.name
      }
    } else {
      this.name = this.key
    }
  }

  nstructjsRegister() {
    const enabled = this.enabled

    //register
    if (!this.enabled) {
      this.enabled = true
    }

    //deregister
    this.enabled = enabled
  }

  get enabled() {
    return this._enabled
  }

  /**
   * Low-level enable/disable primitive: runs the addon's register()/unregister()
   * and (on first enable) onAddonCreate(). Does NOT do dependency logic — that
   * lives in AddonManager.enable()/disable(), which has the manifest graph and
   * wraps the setter in error handling. Prefer routing toggles through the
   * manager so dependencies are respected.
   */
  set enabled(val) {
    if (!!val === !!this._enabled) {
      return
    }

    if (!val) {
      this._enabled = false
      this.addonAPI.unregisterAll()
      this.addon.unregister()
    } else {
      if (!this._created) {
        this.addon.onAddonCreate?.(this.addonAPI)
        this._created = true
      }
      this.addon.register(this.addonAPI)
      this._enabled = true
    }
  }
}

export class AddonManager {
  addons: AddonRecord<IAddon>[]
  urlmap: Map<string, AddonRecord<IAddon>>
  /** Lookup by manifest id. Populated for every loaded addon. */
  idmap: Map<string, AddonRecord<IAddon>>

  /**
   * Addons that were seen but did not load, keyed by id: force-disabled, or
   * rejected by the resolver for a missing required dependency. Never a fatal
   * state — one bad manifest must not take the app down. See P14 §10.2 D1/D2.
   */
  unloaded: Map<string, UnloadedAddon>

  /**
   * Storage backend for third-party addons. Set once at boot via setStorage().
   * Built-in addons don't go through storage — they ship in the main bundle
   * via registerBuiltin.
   */
  storage: AddonStorage | undefined

  /** The product this build is, once loadDistribution() has run. */
  distribution: Distribution | undefined

  /**
   * Sources awaiting record creation in start(). Keyed by manifest id. Builtin
   * sources are added by loadDistribution(); external sources are added by
   * start()'s collectors.
   */
  private pendingSources: Map<string, AddonSource>
  private started: boolean

  constructor() {
    this.addons = []
    this.urlmap = new Map()
    this.idmap = new Map()
    this.unloaded = new Map()
    this.pendingSources = new Map()
    this.started = false
  }

  /**
   * Collects the dynamic menu entries contributed by every enabled addon for a
   * given menu (default the View3D "Add" menu). Addons declare these from their
   * `register(api)` hook via `api.menuEntries('add', [...])`; the contributions
   * live on each addon's AddonAPI and are cleared on disable, so this naturally
   * reflects the currently-enabled set. A separator is inserted before each
   * contributing addon's block.
   */
  getAddonMenuEntries(menuId = 'add'): any[] {
    let list = [] as any[]
    for (const addon of this.addons) {
      if (!addon.enabled) continue
      const entries = addon.addonAPI?.menuContributions?.[menuId]
      if (entries?.length) {
        list.push(Menu.SEP)
        list = list.concat(entries)
      }
    }
    return list
  }

  /** Sets the storage backend for third-party addons. */
  setStorage(storage: AddonStorage): void {
    this.storage = storage
  }

  /**
   * Declares an in-bundle (builtin) addon source. The `module` is the
   * statically-imported IAddon for this addon. Does NOT register or enable —
   * the addon flows through the same enable() lifecycle as external ones during
   * start(). Idempotent: a second call for the same id is ignored.
   *
   * A builtin is an addon whose source is too entangled with the host to build
   * separately yet; this lets it load through the unified path without its own
   * compile. `litemesh` is the only one left.
   */
  registerBuiltin(rawManifest: unknown, module: IAddon): void {
    let m: IAddonManifest
    try {
      m = validateManifest(rawManifest, `builtin:${(rawManifest as {id?: string})?.id}`)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('registerBuiltin: invalid manifest:', err)
      return
    }
    if (this.pendingSources.has(m.id) || this.idmap.has(m.id)) {
      return
    }
    if (this._skipExcluded(m, true)) {
      return
    }
    // The build resolved this builtin's entry to scripts/addon/unavailable_builtin
    // because an optional workspace dependency of its package did not install —
    // its real source is in neither the program nor the bundle. Record it so the
    // UI can say so, and never enable the shell.
    if ((module as {unavailableBuiltin?: boolean}).unavailableBuiltin) {
      const message = `addon "${m.id}" is not part of this build (an optional dependency did not install)`
      this.unloaded.set(m.id, {id: m.id, name: m.name, reason: 'not-in-build', message})
      return
    }
    const source: AddonSource = {manifest: m, loadModule: () => module, builtin: true}
    this.pendingSources.set(m.id, source)

    // Late registration (after start() already ran, e.g. tests/HMR): create the
    // record + enable immediately so it behaves like a boot-time builtin.
    if (this.started) {
      this._materializePending([m.id]).then(() => {
        if (m.defaultEnabled !== false) this.enable(m.id)
      })
    }
  }

  /**
   * Fetches `build/addons/index.json` and adds each entry as an EXTERNAL source
   * (dynamic-imported at materialize time). Skips ids already present as builtin
   * sources or loaded records — the in-bundle builtin wins over its (dead)
   * index.json bundle. Non-fatal on any failure.
   */
  private async collectIndexSources(): Promise<void> {
    const indexUrl = window.haveNwjs ? '../build/addons/index.json' : './build/addons/index.json'

    let json: unknown
    try {
      const res = await fetch(indexUrl)
      json = await res.json()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`no addon index at ${indexUrl}:`, err)
      return
    }

    if (!Array.isArray(json)) {
      // eslint-disable-next-line no-console
      console.error(`addon index ${indexUrl} must be a JSON array`)
      return
    }

    const baseUrl = window.haveNwjs ? '../build/addons' : './build/addons'

    for (const raw of json) {
      let m: IAddonManifest
      try {
        m = validateManifest((raw as {manifest?: unknown}).manifest ?? raw)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('invalid entry in addon index:', err)
        continue
      }

      if (this.pendingSources.has(m.id) || this.idmap.has(m.id)) {
        continue // builtin / already-loaded wins
      }

      // Only the shipped builtins are the distribution's to withhold. A test
      // fixture is in this index because the build was asked for fixtures, and
      // that is a harness decision, not a shipping one.
      const builtin = !!(raw as {builtin?: boolean}).builtin
      if (this._skipExcluded(m, builtin)) {
        continue
      }

      const entryJs = m.entry.replace(/\.ts$/, '.js')
      const rel = `${baseUrl.replace(/\/$/, '')}/${m.id}/${entryJs}`
      // Anchor to the document base so import() agrees with fetch() (a raw
      // "./build/addons/..." would resolve relative to this chunk's URL and
      // double into "/build/build/addons/...").
      const url = typeof document !== 'undefined' ? new URL(rel, document.baseURI).href : rel

      this.pendingSources.set(m.id, {
        manifest  : m,
        loadModule: () => import(/* @vite-ignore */ url) as Promise<IAddon>,
        builtin,
        url,
      })
    }
  }

  /**
   * Reads each installed third-party addon's manifest from storage and adds it
   * as an external source. Skips id collisions (warns). Non-fatal on failure.
   */
  private async collectInstalledSources(): Promise<void> {
    const storage = this.storage
    if (!storage) return

    let ids: string[]
    try {
      ids = await storage.list()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('addon storage list failed:', err)
      return
    }
    if (ids.length === 0) return

    for (const id of ids) {
      let m: IAddonManifest
      try {
        const raw = await storage.readJSON(id, 'manifest.json')
        m = validateManifest(raw, `${id}/manifest.json`)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`failed to read manifest for installed addon "${id}":`, err)
        continue
      }
      if (m.id !== id) {
        // eslint-disable-next-line no-console
        console.error(`storage entry "${id}" has manifest.id "${m.id}" — skipping`)
        continue
      }
      if (this.pendingSources.has(m.id) || this.idmap.has(m.id)) {
        // eslint-disable-next-line no-console
        console.warn(`installed addon "${m.id}" collides with an already-loaded id; skipping`)
        continue
      }
      if (this._skipExcluded(m, false)) {
        continue
      }
      const entryJs = m.entry.replace(/\.ts$/, '.js')
      this.pendingSources.set(m.id, {
        manifest  : m,
        loadModule: async () => {
          const url = await storage.urlFor(m.id, entryJs)
          return (await import(/* @vite-ignore */ url)) as IAddon
        },
        builtin   : false,
      })
    }
  }

  /**
   * Materializes a set of pending sources into AddonRecords, in topological
   * dependency order, wiring api.deps from already-created records. Does NOT
   * enable them. `ids` defaults to every pending source. Removes materialized
   * entries from pendingSources.
   */
  private async _materializePending(ids?: string[]): Promise<void> {
    const wanted = ids ?? [...this.pendingSources.keys()]
    const manifests: IAddonManifest[] = []
    const byId = new Map<string, IAddonManifest>()
    for (const id of wanted) {
      const src = this.pendingSources.get(id)
      if (src) {
        manifests.push(src.manifest)
        byId.set(src.manifest.id, src.manifest)
      }
    }
    if (manifests.length === 0) return

    // Topo-sort the union of (already-loaded records) + (pending manifests) so
    // dependencies on already-loaded addons resolve, then materialize only the
    // pending ones in that order.
    const loadedStubs: IAddonManifest[] = []
    for (const rec of this.addons) {
      if (rec.manifest && !this.pendingSources.has(rec.manifest.id)) {
        loadedStubs.push(rec.manifest)
      }
    }

    let sorted: IAddonManifest[]
    try {
      const {loaded, disabled} = resolveManifests([...loadedStubs, ...manifests])
      sorted = loaded
      for (const d of disabled) {
        // An already-loaded stub cannot be un-loaded here; only pending ones
        // are actually withheld.
        if (!this.pendingSources.has(d.id)) continue
        this.pendingSources.delete(d.id)
        this.unloaded.set(d.id, {
          id     : d.id,
          name   : byId.get(d.id)?.name,
          reason : d.reason,
          message: d.message,
        })
        // eslint-disable-next-line no-console
        console.warn(d.message)
      }
    } catch (err) {
      // Only a cycle or a duplicate id reaches here — both programming errors.
      // eslint-disable-next-line no-console
      console.error('addon dependency sort failed:', err)
      // Fall back to unsorted pending order so we at least try to load.
      sorted = manifests
    }

    for (const m of sorted) {
      const src = this.pendingSources.get(m.id)
      if (!src) continue // an already-loaded stub; skip

      let module: IAddon
      try {
        module = await src.loadModule()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`failed to load addon "${m.id}":`, err)
        this.pendingSources.delete(m.id)
        continue
      }

      const api = new AddonAPI<IAddon>()
      api.addon = module
      api.addonId = m.id
      for (const depId of m.dependencies ?? []) {
        const depApi = this.getAddonAPI(depId)
        if (depApi !== undefined) {
          api.deps[depId] = depApi
        } else {
          // eslint-disable-next-line no-console
          console.warn(`addon "${m.id}": dep "${depId}" not yet loaded`)
        }
      }
      // Optional deps are wired when present and silent when not — their
      // absence is the state the addon is expected to handle.
      for (const depId of m.optionalDependencies ?? []) {
        const depApi = this.getAddonAPI(depId)
        if (depApi !== undefined) {
          api.deps[depId] = depApi
        }
      }

      const rec = new AddonRecord(src.url ?? `builtin:${m.id}`, module, api)
      rec.manifest = m
      rec.builtin = src.builtin
      rec.name = m.name

      this.addons.push(rec)
      this.idmap.set(m.id, rec)
      if (src.url) this.urlmap.set(src.url, rec)

      this.pendingSources.delete(m.id)
    }
  }

  /**
   * Apply a distribution: its addon list becomes the first-party allow-list, its
   * in-bundle entries are declared as builtin sources, and the title takes
   * effect. The startup scene follows from the active distribution itself —
   * core's default_file reads the name back. Must run before start(); the order
   * of `dist.addons` is deliberately not load-bearing.
   */
  loadDistribution(dist: Distribution): void {
    this.distribution = dist
    setActiveDistribution(dist)

    for (const entry of dist.addons) {
      if (entry.manifest && entry.module) {
        this.registerBuiltin(entry.manifest, entry.module as IAddon)
      }
    }

    if (typeof document !== 'undefined') {
      document.title = dist.title
    }
  }

  /**
   * The single unified load pipeline. Collects builtin (already pending) +
   * index.json + storage sources, materializes them into records in dependency
   * order, then — when `autoEnable` — enables every record by default (deps
   * first). Persisted per-addon enabled state is reconciled afterward by
   * settings._loadAddons(), which disables user-disabled addons honoring deps.
   */
  async start(autoEnable: boolean = true): Promise<void> {
    await this.collectIndexSources()
    await this.collectInstalledSources()

    await this._materializePending()

    this.started = true

    if (autoEnable) {
      // Enable in record order (already topological from materialize); enable()
      // is idempotent and pulls deps on first, so order is not load-bearing.
      // Skip addons that opt out via manifest.defaultEnabled=false (they ship
      // disabled until the user turns them on); their deps are still pulled in
      // by any default-enabled dependent.
      for (const rec of this.addons.slice()) {
        if (!rec.manifest || rec.enabled) {
          continue
        }
        // The distribution's `enabled` wins over the manifest's default: an
        // addon that ships off in one product can ship on in another.
        const want = distributionEnabled(rec.manifest.id) ?? rec.manifest.defaultEnabled !== false
        if (want) {
          this.enable(rec.manifest.id)
        }
      }
    }

    // An enabled addon may need async warm-up (sculptcore's WASM/native load is
    // the reason this exists) before anything reads a file or builds the UI.
    await runBootTasks()
  }

  /** Returns the AddonAPI for a loaded addon, keyed by manifest id. */
  getAddonAPI(id: string): AddonAPI<unknown> | undefined {
    return this.idmap.get(id)?.addonAPI as AddonAPI<unknown> | undefined
  }

  /**
   * Is this addon loaded *and* enabled — i.e. are its registrations live right
   * now? This is what `api.has(id)` answers, because a disabled addon has had
   * its classes, ops and menu entries unregistered and is no more usable than
   * an absent one.
   */
  isEnabled(id: string): boolean {
    return this.idmap.get(id)?.enabled === true
  }

  /**
   * Records an addon this build withholds and reports whether the caller should
   * skip it. Both exclusions withhold the source entirely — no module import, no
   * record — so `isEnabled()` is false by construction. `firstParty` is false
   * for user-installed addons and for test fixtures, which a distribution's
   * allow-list does not touch: neither one is a shipping decision.
   */
  private _skipExcluded(m: IAddonManifest, firstParty: boolean): boolean {
    if (isForceDisabled(m.id)) {
      this.unloaded.set(m.id, {
        id     : m.id,
        name   : m.name,
        reason : 'force-disabled',
        message: `addon "${m.id}" is force-disabled for this session`,
      })
      return true
    }
    if (firstParty && !isInDistribution(m.id)) {
      this.unloaded.set(m.id, {
        id     : m.id,
        name   : m.name,
        reason : 'not-in-distribution',
        message: `addon "${m.id}" is not part of this distribution`,
      })
      return true
    }
    return false
  }

  /**
   * Enables an addon and all of its (transitive) dependencies first. Idempotent.
   * Returns {ok:false} with a reason if a dependency is missing or the addon's
   * register() throws (in which case it is rolled back).
   */
  enable(id: string): AddonOpResult {
    if (isForceDisabled(id)) {
      const message = `addon "${id}" is force-disabled for this session`
      return {ok: false, reason: 'force-disabled', message}
    }
    const rec = this.idmap.get(id)
    if (!rec) {
      // eslint-disable-next-line no-console
      console.error(`enable: unknown addon "${id}"`)
      return {ok: false, reason: 'unknown', message: `unknown addon "${id}"`}
    }
    if (rec.enabled) {
      return {ok: true}
    }

    // 1. transitively enable deps first (cycles already rejected at sort time).
    for (const depId of rec.manifest?.dependencies ?? []) {
      const depRec = this.idmap.get(depId)
      if (!depRec) {
        const message = `addon "${id}": missing dependency "${depId}"`
        // eslint-disable-next-line no-console
        console.error(message)
        return {ok: false, reason: 'missing-dep', message}
      }
      const res = this.enable(depId)
      if (!res.ok) return res
    }

    // 2. enable self — deps are live, so register() can read api.deps[*].exports.
    try {
      rec.enabled = true
    } catch (error) {
      util.print_stack(error as Error)
      // eslint-disable-next-line no-console
      console.error(`addon "${id}" register() failed:`, error)
      rec.addonAPI.unregisterAll()
      rec._enabled = false
      return {ok: false, reason: 'register-threw', error, message: `addon "${id}" failed to register`}
    }

    return {ok: true}
  }

  /**
   * Disables an addon. BLOCKED (returns {ok:false}) when other *enabled* addons
   * depend on it — the message names the dependents. Idempotent.
   */
  disable(id: string): AddonOpResult {
    const rec = this.idmap.get(id)
    if (!rec) {
      return {ok: false, reason: 'unknown', message: `unknown addon "${id}"`}
    }
    if (!rec.enabled) {
      return {ok: true}
    }

    // Only *required* dependents block. An optional dependent that blocked its
    // optional dependency from being turned off would make "optional" mean
    // nothing at the one moment it is tested. See P14 §10.2 D3.
    const dependents = this.addons.filter(
      (r) => r.enabled && r !== rec && (r.manifest?.dependencies ?? []).includes(id)
    )
    if (dependents.length > 0) {
      const names = dependents.map((r) => r.manifest?.name ?? r.name).join(', ')
      const message = `Cannot disable "${rec.manifest?.name ?? rec.name}": still required by ${names}. Disable those first.`
      // eslint-disable-next-line no-console
      console.warn(message)
      return {ok: false, reason: 'has-dependents', dependents, message}
    }

    try {
      rec.enabled = false
    } catch (error) {
      util.print_stack(error as Error)
      return {ok: false, reason: 'unregister-threw', error, message: `addon "${id}" failed to unregister`}
    }

    return {ok: true}
  }

  /**
   * Re-scans storage for newly-installed addons, materializes the new ones, and
   * enables them (with deps). Used by the install UI after a fresh install.
   */
  async loadInstalledAddons(): Promise<void> {
    if (!this.storage) return
    await this.collectInstalledSources()
    const newIds = [...this.pendingSources.keys()]
    if (newIds.length === 0) return
    await this._materializePending(newIds)
    for (const id of newIds) {
      if (this.idmap.has(id)) this.enable(id)
    }
  }

  /**
   * Removes an installed (third-party) addon from disk + from the in-process
   * registries. Refuses builtin addons (they can be disabled, not uninstalled).
   */
  async uninstall(id: string): Promise<boolean> {
    const rec = this.idmap.get(id)
    if (rec?.builtin) {
      // eslint-disable-next-line no-console
      console.warn(`refusing to uninstall builtin addon "${id}"`)
      return false
    }
    if (rec) {
      const res = this.disable(id)
      if (!res.ok && res.reason === 'has-dependents') {
        // eslint-disable-next-line no-console
        console.warn(res.message)
        return false
      }
      this.addons = this.addons.filter((r) => r !== rec)
      this.urlmap.delete(rec.url)
      this.idmap.delete(id)
    }
    if (this.storage) {
      await this.storage.remove(id)
    }
    return true
  }

  unload(addon_or_url: string | IAddon): boolean {
    let rec: AddonRecord<IAddon> | undefined

    if (typeof addon_or_url === 'string') {
      rec = this.urlmap.get(addon_or_url) ?? this.idmap.get(addon_or_url)
    } else {
      for (const rec2 of this.addons) {
        if (rec2.addon === addon_or_url) {
          rec = rec2
          break
        }
      }
    }

    if (!rec?.manifest) {
      throw new Error('Unknown addon ' + addon_or_url)
    }

    const res = this.disable(rec.manifest.id)
    if (!res.ok) {
      // eslint-disable-next-line no-console
      if (res.message) console.warn(res.message)
      return false
    }
    return true
  }

  /**
   * Auto-enables addons whose validArgv() matches the CLI args, then forwards
   * the args to every enabled addon's handleArgv(). Routes through enable() so
   * dependencies are pulled on. Used by the --backend native test harness.
   */
  handleArgv(argv: string[]) {
    for (const addon of this.addons.slice()) {
      if (!addon.enabled && addon.manifest && addon.addon.validArgv?.(addon.addonAPI, argv)) {
        this.enable(addon.manifest.id)
      }

      if (addon.enabled && addon.addon.handleArgv) {
        addon.addon.handleArgv(addon.addonAPI, argv)
      }
    }
  }
}

const manager = new AddonManager()
export default manager

/**
 * Boots the unified addon pipeline: materializes every source (builtin sources
 * are already registered synchronously by the builtin registry import; index +
 * storage sources are collected here) and, by default, enables them. Persisted
 * disabled-state is applied later by settings._loadAddons(). Awaitable so the
 * caller can ensure toolmodes/editors are registered before building the UI.
 */
export async function startAddons(autoEnable: boolean = true): Promise<void> {
  if (!manager.storage) {
    const storage = await initAddonStorage()
    if (storage) manager.setStorage(storage)
  }

  try {
    await manager.start(autoEnable)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('addon start failed:', err)
  }
}

/**
 * Picks a default storage backend: NodeFs (direct require) when running
 * inside NW.js, IndexedDB when in a real browser, or undefined in any
 * environment that has neither. Hosts that need a different backend (e.g.
 * tests) should bypass this and call manager.setStorage() directly.
 */
async function initAddonStorage(): Promise<AddonStorage | undefined> {
  if (window.haveNwjs) {
    try {
      const {createNwjsAddonStorage} = await import('./storage_nwjs.js')
      return await createNwjsAddonStorage()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('NW.js addon storage init failed:', err)
      return undefined
    }
  }
  if (typeof indexedDB !== 'undefined') {
    const {IndexedDBAddonStorage} = await import('./storage.js')
    return new IndexedDBAddonStorage()
  }
  return undefined
}

declare global {
  interface Window {
    _addons: AddonManager
  }
}

window._addons = manager
