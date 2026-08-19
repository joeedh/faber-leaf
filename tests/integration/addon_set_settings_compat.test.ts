/**
 * P10 — criterion 9's half: a settings blob and a startup file written by one
 * addon set load in a build with a different one.
 *
 * Two NW.js boots sharing an app-storage directory. The first ("set A") turns
 * on every default-off builtin, changes a couple of scalar prefs, saves
 * settings, and saves a scene as the startup file. The blob is then edited into
 * what a *fuller* build's blob looks like from here — an addon switched off,
 * one addon's key removed entirely, and a key for an addon this build has never
 * heard of — and the second boot ("set B") reads both files back.
 *
 * The startup file is the assertion that matters: `genDefaultFile` catches a
 * failed load and silently falls back to the default scene, and the default
 * scene has the same object *shape* as the fixture, so the writer renames its
 * object and the reader looks for that name. Anything less would pass on the
 * fallback.
 *
 * `--app-storage-dir` keeps all of this out of the developer's `.sculptcore`:
 * under NW.js `process.cwd()` is the app directory, so a spawned test cannot
 * isolate its state by choosing a working directory.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app bundle
 * (`pnpm build`). Backend-agnostic, so it runs once, in the wasm pass.
 */

import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {execFileSync} from 'node:child_process'
import {isolatedProfileArgs, REPO_ROOT, resolveNwjsExe} from './nwjs_boot'
import {isDefaultBackendPass} from './split'

const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')

/** Default-off builtins set A turns on, so set B can be strictly smaller. P13
 * left exactly one: `leafmesh`. It ships as an external per-addon bundle, which
 * `pnpm build` produces alongside the main one, so gating on the bundle (below)
 * is enough to know it is there. */
const EXTRA_ADDONS = ['leafmesh']
/** Present and default-on; stands in for the key-removed case below. */
const DEFAULT_ON_ADDON = 'sculptcore'
/** An id no build in the tree has — stands in for an addon set A shipped. */
const GHOST = 'ghost_addon'
/** Set A renames its mesh object so the reader can tell a real load from the
 * default-scene fallback. */
const MARKER = 'WrittenBySetA'

interface AddonSettingsJSON {
  addonSettings: Record<string, {name: string; enabled: boolean; settings: Record<string, unknown>}>
  undoMemLimit: number
  autosaveIntervalMinutes: number
}

interface WriterResult {
  ok: boolean
  error?: string
  stack?: string
  enabled?: [string, boolean][]
  objects?: {name: string; dataCls: string | null}[]
}

interface ReaderResult {
  ok: boolean
  error?: string
  stack?: string
  undoMemLimit?: number
  autosaveIntervalMinutes?: number
  persisted?: Record<string, boolean>
  live?: Record<string, boolean>
  objects?: {name: string; dataCls: string | null}[]
  missing?: string[]
  blockCounts?: Record<string, number>
}

const WRITER_EVAL = `globalThis.__evalTestResult = (() => {
  try {
    const mgr = _framework.api.addonManager
    const S = _appstate.settings
    for (const id of ${JSON.stringify(EXTRA_ADDONS)}) mgr.enable(id)
    for (const ob of _appstate.ctx.scene.objects) {
      if (ob.data && ob.data.constructor.name === 'LiteMesh') ob.name = ${JSON.stringify(MARKER)}
    }
    S.syncAddonList()
    S.syncEnabledFlags()
    S.undoMemLimit = 12345
    S.autosaveIntervalMinutes = 7
    S.save()
    _appstate.saveStartupFile()
    return {ok: true,
      enabled: mgr.addons.map((r) => [r.manifest ? r.manifest.id : r.key, r.enabled]),
      objects: [..._appstate.ctx.scene.objects].map((ob) => ({name: ob.name, dataCls: ob.data ? ob.data.constructor.name : null}))}
  } catch (e) { return {ok: false, error: String(e), stack: String(e.stack)} }
})()`

const READER_EVAL = `globalThis.__evalTestResult = (() => {
  try {
    const mgr = _framework.api.addonManager
    const S = _appstate.settings
    const missing = []
    const blockCounts = {}
    for (const set of _appstate.datalib.libs) {
      const name = set.savedTypeName ? set.savedTypeName() : '?'
      const blocks = [...set]
      if (blocks.length) blockCounts[name] = blocks.length
      for (const b of blocks) {
        if (b.constructor.name === 'MissingDataBlock') missing.push(b._origClsname ?? b.name)
      }
    }
    return {ok: true,
      undoMemLimit: S.undoMemLimit,
      autosaveIntervalMinutes: S.autosaveIntervalMinutes,
      persisted: Object.fromEntries(Object.entries(S.addonSettings).map(([k, v]) => [k, v.enabled])),
      live: Object.fromEntries(mgr.addons.map((r) => [r.manifest ? r.manifest.id : r.key, r.enabled])),
      objects: [..._appstate.ctx.scene.objects].map((ob) => ({name: ob.name, dataCls: ob.data ? ob.data.constructor.name : null})),
      missing, blockCounts}
  } catch (e) { return {ok: false, error: String(e), stack: String(e.stack)} }
})()`

function boot<T>(nwExe: string, stateDir: string, evalExpr: string, sceneArgs: string[]): T {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'p10addonset-')), 'dump.json')
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--app-storage-dir',
      stateDir,
      ...sceneArgs,
      '--eval',
      evalExpr,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 240000}
  )
  if (!fs.existsSync(out)) throw new Error(`dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: T}
  if (dump.evalResult === undefined) throw new Error(`dump has no evalResult (${out})`)
  return dump.evalResult
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const canRun = !!nwExe && haveBundle && isDefaultBackendPass()

if (!canRun && isDefaultBackendPass()) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  console.warn(`[addon_set_settings_compat] skipped: ${why}`)
}

const describeMaybe = canRun ? describe : describe.skip

describeMaybe('settings + startup file across an addon-set change (P10, criterion 9)', () => {
  let stateDir: string
  let writtenBlob: AddonSettingsJSON
  let readBlob: AddonSettingsJSON
  let writer: WriterResult
  let reader: ReaderResult

  beforeAll(() => {
    stateDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'p10state-'))

    writer = boot<WriterResult>(nwExe!, stateDir, WRITER_EVAL, ['--gen-scene', 'litemesh-cube'])
    if (!writer.ok) throw new Error(`set-A boot failed: ${writer.error}\n${writer.stack}`)

    const settingsPath = Path.join(stateDir, 'settings.json')
    writtenBlob = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AddonSettingsJSON

    // The blob is only worth editing if set A really wrote what it claims to;
    // a missing id would otherwise surface as a TypeError three lines down.
    for (const id of EXTRA_ADDONS) {
      if (!writtenBlob.addonSettings[id]?.enabled) {
        throw new Error(
          `set A did not persist ${id} as enabled (got ${JSON.stringify(writtenBlob.addonSettings[id])}); ` +
            `enabled map was ${JSON.stringify(writer.enabled)}`
        )
      }
    }

    // Turn the blob into one a *fuller* build wrote: an addon the user turned
    // off, one whose key predates this build, and one this build never had.
    const edited = JSON.parse(JSON.stringify(writtenBlob)) as AddonSettingsJSON
    edited.addonSettings.leafmesh.enabled = false
    delete edited.addonSettings[DEFAULT_ON_ADDON]
    edited.addonSettings[GHOST] = {name: GHOST, enabled: true, settings: {}}
    fs.writeFileSync(settingsPath, JSON.stringify(edited))

    // No --gen-scene: this boot takes the normal startup path, so it reads the
    // startup file set A wrote.
    reader = boot<ReaderResult>(nwExe!, stateDir, READER_EVAL, [])
    if (!reader.ok) throw new Error(`set-B boot failed: ${reader.error}\n${reader.stack}`)

    readBlob = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AddonSettingsJSON
  }, 900000)

  afterAll(() => {
    if (stateDir) fs.rmSync(stateDir, {recursive: true, force: true})
  })

  test('set A persists the addons it turned on', () => {
    for (const id of EXTRA_ADDONS) {
      expect([id, writtenBlob.addonSettings[id]?.enabled]).toEqual([id, true])
    }
  })

  test('the scalar prefs set A wrote come back in set B', () => {
    expect(reader.undoMemLimit).toBe(12345)
    expect(reader.autosaveIntervalMinutes).toBe(7)
  })

  test('set B honors the persisted disable, so its live addon set really differs', () => {
    // leafmesh is default-off, so set A had to turn it on and the edited blob
    // turns it back off: the disable is the user's, not the manifest's.
    expect(reader.live!.leafmesh).toBe(false)
    expect(reader.live![DEFAULT_ON_ADDON]).toBe(true)
  })

  test('an addon the blob never mentions comes back at its own default', () => {
    // The key was deleted outright, so syncAddonList() has to re-create it from
    // the manifest. sculptcore ships default-on, so this reads `true` either
    // way -- P13 left leafmesh as the only default-off builtin and it is spoken
    // for above. What is actually asserted here is that the key comes *back*
    // rather than staying missing.
    expect(reader.persisted![DEFAULT_ON_ADDON]).toBe(true)
    expect(reader.live![DEFAULT_ON_ADDON]).toBe(true)
    expect(readBlob.addonSettings[DEFAULT_ON_ADDON]).toBeDefined()
  })

  test('a setting for an addon this build does not have is kept, not dropped', () => {
    // Losing it would silently forget the user's preference for every addon
    // absent from the running build — the sculptcore-free case criterion 9 is
    // about. It survives in memory and back onto disk.
    expect(reader.persisted![GHOST]).toBe(true)
    expect(readBlob.addonSettings[GHOST]?.enabled).toBe(true)
  })

  test('the startup file set A wrote loads in set B, not the default-scene fallback', () => {
    expect(writer.objects).toEqual(expect.arrayContaining([{name: MARKER, dataCls: 'LiteMesh'}]))
    expect(reader.objects).toEqual(writer.objects)
    expect(reader.blockCounts!.litemesh).toBe(1)
  })

  test('nothing in the startup file decodes as a MissingDataBlock under set B', () => {
    expect(reader.missing).toEqual([])
  })
})
