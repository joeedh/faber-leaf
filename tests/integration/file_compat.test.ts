/**
 * P10 — cross-build file compatibility
 * (documentation/plans/2026-08-15-0345-serialization-and-file-compat-hardening.md).
 *
 * The invariant: a `.wproj` opened by a build that does not have the addon which
 * wrote part of it must load, preserve that part byte-exactly, and re-save it
 * intact, so a build that does have the addon can still read it.
 *
 * `tests/integration/fixtures/curve-addon-scene.wproj` is **committed**, written
 * once by `tools/gen-file-compat-fixtures.mjs` under addon set A
 * (mesh + sculptcore + **curve**). Regenerating it from the build under test
 * would prove nothing, so nothing here writes it — and after P13 it could not
 * be regenerated at all: `mesh` is deleted and `curve` is archived.
 *
 * `curve-addon-scene-v8.wproj` is the same scene written before struct ids were
 * derived from struct names (plan §4.3). It is kept, and asserted on separately,
 * because that scheme change is the one thing in the format a build cannot paper
 * over: an old file still opens anywhere, but the unknown-block bytes inside it
 * stop being portable the moment a partial build re-saves them.
 *
 * One headless boot, under addon set B (this build's default set, which has
 * never heard of curve): it cycles an addon on and off twice, loads the
 * fixture, makes an unrelated edit, re-saves it, and re-loads its own output.
 *
 * The cycle is `leafmesh` rather than `curve`, and it is not incidental: it
 * exercises the teardown path — the one that drops an addon's struct schemas,
 * and that used to throw on a class filed as both DataBlock and
 * SceneObjectData. `LeafMeshData` is that same double-filed shape, so the case
 * survives the substitution intact.
 *
 * **P13 removed the full-build half.** Criterion 8 used to be a second boot
 * that enabled curve and tetmesh and re-opened boot 1's output as live
 * objects; both addons are archived out of the build now, so no build can
 * decode this fixture's curve blocks any more. P13 §7 sanctions exactly that:
 * "if all were deleted, assert bytes only". What is left is the stronger half
 * anyway — that a build which *cannot* understand the data still carries it
 * through load → edit → save → load without touching a byte.
 *
 * A third block covers the other direction of time: the same fixture with its
 * header version bumped past this build's, which must load *and say so* rather
 * than surface as corruption (§6a). The classification behind that guard is
 * unit-tested in `tests/unit/file_version_guard.test.ts`.
 *
 * Criteria 5, 6, 7 and 8 are asserted separately and deliberately: their failure
 * modes differ (crash on load, silent reference loss, throw on save, silent
 * mis-decode) and one combined "it round-trips" assertion would hide three of
 * them. Criterion 7's nstructjs-level half — a concrete `struct(T)` / `array(T)`
 * field of an unregistered class — lives in the submodule's own suite,
 * `vendor/nstructjs/tests/unknown_struct_field.test.ts`; §4.2a of the plan
 * records why it is unreachable from a `.wproj` today.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app bundle
 * (`pnpm build`). Backend-agnostic, so it runs once, in the wasm pass.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {APP_VERSION} from '../../scripts/core/const'
import {isolatedProfileArgs, REPO_ROOT, resolveNwjsExe} from './nwjs_boot'
import {isDefaultBackendPass} from './split'

const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const FIXTURE_DIR = Path.join(REPO_ROOT, 'tests', 'integration', 'fixtures')
const FIXTURE = Path.join(FIXTURE_DIR, 'curve-addon-scene.wproj')
const FIXTURE_META = Path.join(FIXTURE_DIR, 'curve-addon-scene.json')
const FIXTURE_V8 = Path.join(FIXTURE_DIR, 'curve-addon-scene-v8.wproj')
const FIXTURE_V8_META = Path.join(FIXTURE_DIR, 'curve-addon-scene-v8.json')

/** What the fixture's authoring build recorded about the blocks it wrote. */
interface FixtureMeta {
  curveLibId: number
  curveName: string
  obLibId: number
  obName: string
  /** Only meaningful to a build that can decode the block; none can, post-P13. */
  numVerts: number
  numEdges: number
}

/** One inspection of the datalib + scene, taken by the partial build. */
interface PartialProbe {
  haveCurveSet: boolean
  savedTypeName: string | null
  setInLibs: boolean
  count: number
  cls: string | null
  libId: number | null
  name: string | null
  origClsname: string | null
  origBytes: number
  origHash: number
  obFound: boolean
  obDataCls: string | null
  obDataLibId: number | null
  obDataName: string | null
  editObFound: boolean
}

interface PartialResult {
  ok: boolean
  error?: string
  stack?: string
  /** Whether this build has a `curve` addon at all. It must not. */
  curvePresent?: boolean
  /** enable → disable → enable → disable, taken before the fixture is loaded. */
  cycle?: {ok: boolean; reason: string | null}[]
  afterLoad?: PartialProbe
  afterResave?: PartialProbe
  resavedBytes?: number
}

/** One load of a file whose header claims a version this build does not know. */
interface FutureResult {
  ok: boolean
  error?: string
  stack?: string
  warned?: boolean
  count?: number
  cls?: string | null
  libId?: number | null
  obDataLibId?: number | null
}

function boot(nwExe: string, evalExpr: string, tmpPrefix: string): unknown {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), tmpPrefix))
  const out = Path.join(dir, 'dump.json')
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      // A Chromium profile is not app state: settings.json lives in
      // `<cwd>/.sculptcore`, so without this the boot inherits whichever addons
      // the developer last had enabled -- and the cycle below reads that.
      '--app-storage-dir',
      Path.join(dir, 'storage'),
      '--apptest-headless',
      '--no-devtools',
      '--gen-scene',
      'empty',
      '--eval',
      evalExpr,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 240000}
  )
  if (!fs.existsSync(out)) throw new Error(`dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: unknown}
  if (dump.evalResult === undefined) throw new Error(`dump has no evalResult (${out})`)
  return dump.evalResult
}

/** JS source shared by both evals: a file→ArrayBuffer read and an FNV-1a hash. */
const EVAL_PRELUDE = `
  const nodefs = require('fs')
  const readAB = (p) => {
    const b = nodefs.readFileSync(p)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  const fnv = (u8) => {
    let h = 2166136261 >>> 0
    for (let i = 0; i < u8.length; i++) {
      h ^= u8[i]
      h = Math.imul(h, 16777619) >>> 0
    }
    return h
  }
  const findObject = (name) => {
    for (const ob of _appstate.ctx.scene.objects) {
      if (ob.name === name) return ob
    }
    return undefined
  }
`

function partialBuildEval(fixture: string, resaved: string): string {
  return `globalThis.__evalTestResult = (() => {
  try {
${EVAL_PRELUDE}
    const am = window._addons

    // Turn an addon on and back off twice before anything else, so the teardown
    // path -- the one that drops the addon's struct schemas, and that used to
    // throw on a class filed as both DataBlock and SceneObjectData -- is really
    // entered. leafmesh ships defaultEnabled:false and registers LeafMeshData,
    // which is that same double-filed shape (P13 archived curve).
    const cycle = [
      am.enable('leafmesh'),
      am.disable('leafmesh'),
      am.enable('leafmesh'),
      am.disable('leafmesh'),
    ]

    const probe = () => {
      const lib = _appstate.datalib
      const set = lib.libmap['curve']
      const blocks = set ? [...set] : []
      const b = blocks[0]
      const ob = findObject('CurveObject')
      return {
        haveCurveSet : !!set,
        savedTypeName: set ? set.savedTypeName() : null,
        setInLibs    : !!set && lib.libs.indexOf(set) >= 0,
        count        : blocks.length,
        cls          : b ? b.constructor.name : null,
        libId        : b ? b.lib_id : null,
        name         : b ? b.name : null,
        origClsname  : b ? b._origClsname ?? null : null,
        origBytes    : b && b._origBytes ? b._origBytes.length : -1,
        origHash     : b && b._origBytes ? fnv(b._origBytes) : -1,
        obFound      : !!ob,
        obDataCls    : ob && ob.data ? ob.data.constructor.name : null,
        obDataLibId  : ob && ob.data ? ob.data.lib_id : null,
        obDataName   : ob && ob.data ? ob.data.name : null,
        editObFound  : !!findObject('PartialEditObject'),
      }
    }

    _appstate.loadFile(readAB(${JSON.stringify(fixture)}))
    const afterLoad = probe()

    // Edit something unrelated before re-saving. Without it the save could be a
    // byte-copy of the input and would prove nothing about a real session.
    const lib = _appstate.datalib
    const nul = new (lib.libmap['nullobject'].type)()
    nul.name = 'PartialEdit'
    lib.add(nul)
    const editOb = new (lib.libmap['object'].type)()
    lib.add(editOb)
    editOb.name = 'PartialEditObject'
    editOb.data = nul
    nul.lib_addUser(editOb)
    _appstate.ctx.scene.add(editOb)
    editOb.graphUpdate()

    const buf = _appstate.createFile({save_screen: true, save_library: true, compress: false})
    nodefs.writeFileSync(${JSON.stringify(resaved)}, Buffer.from(new Uint8Array(buf)))

    _appstate.loadFile(readAB(${JSON.stringify(resaved)}))
    const afterResave = probe()

    return {
      ok          : true,
      curvePresent: !!am.idmap.get('curve'),
      cycle       : cycle.map((r) => ({ok: r.ok, reason: r.reason ?? null})),
      afterLoad,
      afterResave,
      resavedBytes: buf.byteLength,
    }
  } catch (e) {
    return {ok: false, error: String(e), stack: String(e.stack)}
  }
})()`
}

/**
 * Loads a fixture whose header version this build has never heard of, with
 * `console.warn` captured so the guard is observable rather than inferred from
 * the load merely not throwing.
 */
function futureVersionEval(fixture: string): string {
  return `globalThis.__evalTestResult = (() => {
  try {
${EVAL_PRELUDE}
    const warnings = []
    const realWarn = console.warn
    console.warn = function () {
      warnings.push(Array.prototype.map.call(arguments, String).join(' '))
      return realWarn.apply(console, arguments)
    }

    try {
      _appstate.loadFile(readAB(${JSON.stringify(fixture)}))
    } finally {
      console.warn = realWarn
    }

    const set = _appstate.datalib.libmap['curve']
    const blocks = set ? [...set] : []
    const b = blocks[0]
    const ob = findObject('CurveObject')

    return {
      ok         : true,
      warned     : warnings.some((w) => w.indexOf('written by a newer version') >= 0),
      count      : blocks.length,
      cls        : b ? b.constructor.name : null,
      libId      : b ? b.lib_id : null,
      obDataLibId: ob && ob.data ? ob.data.lib_id : null,
    }
  } catch (e) {
    return {ok: false, error: String(e), stack: String(e.stack)}
  }
})()`
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveFixture =
  fs.existsSync(FIXTURE) && fs.existsSync(FIXTURE_META) && fs.existsSync(FIXTURE_V8) && fs.existsSync(FIXTURE_V8_META)
const canRun = !!nwExe && haveBundle && haveFixture && isDefaultBackendPass()

if (!canRun && isDefaultBackendPass()) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
    !haveFixture && `fixture missing (${Path.relative(REPO_ROOT, FIXTURE)}; run tools/gen-file-compat-fixtures.mjs)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[file_compat] skipped: ${why}`)
}

const describeMaybe = canRun ? describe : describe.skip

describeMaybe('cross-build .wproj compatibility (P10)', () => {
  let meta: FixtureMeta
  let partial: PartialResult

  beforeAll(() => {
    meta = JSON.parse(fs.readFileSync(FIXTURE_META, 'utf-8')) as FixtureMeta

    const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'p10compat-'))
    const resaved = Path.join(dir, 'resaved.wproj')

    partial = boot(nwExe!, partialBuildEval(FIXTURE, resaved), 'p10partial-') as PartialResult
    if (!partial.ok) throw new Error(`partial-build boot failed: ${partial.error}\n${partial.stack}`)
  }, 600000)

  test('the reading build really does not have the addon that wrote the file', () => {
    // Post-P13 this is stronger than "disabled": the addon is not installable.
    expect(partial.curvePresent).toBe(false)
  })

  test('an addon survives being enabled and disabled repeatedly', () => {
    // A class filed under two of AddonAPI's lists — every SceneObjectData is
    // also a DataBlock — used to be unregistered twice, and the second throw
    // aborted the teardown before it could undo the addon's registrations. The
    // second enable is the one that noticed, with "already registered".
    expect(partial.cycle).toEqual([
      {ok: true, reason: null},
      {ok: true, reason: null},
      {ok: true, reason: null},
      {ok: true, reason: null},
    ])
  })

  test('criterion 5: the unknown block keeps its bytes across load → save → load', () => {
    const a = partial.afterLoad!
    const b = partial.afterResave!

    expect(a.cls).toBe('MissingDataBlock')
    expect(a.origClsname).toBe('curve')
    expect(a.origBytes).toBeGreaterThan(0)

    expect(b.cls).toBe('MissingDataBlock')
    expect(b.origBytes).toBe(a.origBytes)
    expect(b.origHash).toBe(a.origHash)
  })

  test('criterion 6: lib_id and the inbound DataRef survive load → save → load', () => {
    for (const probe of [partial.afterLoad!, partial.afterResave!]) {
      expect(probe.libId).toBe(meta.curveLibId)
      expect(probe.name).toBe(meta.curveName)
      expect(probe.obFound).toBe(true)
      // The stand-in object is a NullObject, but it must carry the original
      // block's identity or the re-save rewrites the reference to its own.
      expect(probe.obDataLibId).toBe(meta.curveLibId)
    }
  })

  test('criterion 7: saving a file holding unknown data does not throw', () => {
    expect(partial.resavedBytes).toBeGreaterThan(0)
  })

  test("the unknown type's BlockSet survives, under its original name", () => {
    for (const probe of [partial.afterLoad!, partial.afterResave!]) {
      expect(probe.haveCurveSet).toBe(true)
      expect(probe.savedTypeName).toBe('curve')
      // Dropped from `libs`, the set is invisible to the save loop and every
      // preserved block in it is silently lost. See plan §4.1.
      expect(probe.setInLibs).toBe(true)
      expect(probe.count).toBe(1)
    }
  })

  test('the partial build can edit and save a file it only half understands', () => {
    expect(partial.afterLoad!.editObFound).toBe(false)
    expect(partial.afterResave!.editObFound).toBe(true)
  })
})

describeMaybe('legacy (registration-order struct id) .wproj files (P10 §4.3)', () => {
  let meta: FixtureMeta
  let partial: PartialResult

  beforeAll(() => {
    meta = JSON.parse(fs.readFileSync(FIXTURE_V8_META, 'utf-8')) as FixtureMeta

    const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'p10legacy-'))
    const resaved = Path.join(dir, 'resaved-v8.wproj')

    partial = boot(nwExe!, partialBuildEval(FIXTURE_V8, resaved), 'p10lpartial-') as PartialResult
    if (!partial.ok)
      throw new Error(`partial-build boot failed: ${partial.error}
${partial.stack}`)
  }, 600000)

  test('a pre-stable-id file still loads, with the unknown block preserved', () => {
    const a = partial.afterLoad!

    expect(a.cls).toBe('MissingDataBlock')
    expect(a.origClsname).toBe('curve')
    expect(a.origBytes).toBeGreaterThan(0)
    expect(a.libId).toBe(meta.curveLibId)
    expect(a.name).toBe(meta.curveName)
    expect(a.obFound).toBe(true)
    expect(a.obDataLibId).toBe(meta.curveLibId)
  })

  test('a pre-stable-id file can still be edited and saved', () => {
    expect(partial.resavedBytes).toBeGreaterThan(0)
    expect(partial.afterResave!.editObFound).toBe(true)
    // Byte preservation is orthogonal to the id scheme: the bytes are opaque.
    expect(partial.afterResave!.origHash).toBe(partial.afterLoad!.origHash)
  })
})

describeMaybe('forward-version guard (P10 §6a)', () => {
  let meta: FixtureMeta
  let future: FutureResult

  beforeAll(() => {
    meta = JSON.parse(fs.readFileSync(FIXTURE_META, 'utf-8')) as FixtureMeta

    const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'p10future-'))
    const bumped = Path.join(dir, 'future.wproj')
    const bytes = fs.readFileSync(FIXTURE)

    // Header is 'WPRJ' + a little-endian uint16 version. Claiming the next
    // version up is the case the guard is for; if that version ever becomes a
    // real break, `BREAKING_FILE_VERSIONS` and this test move together.
    bytes.writeUInt16LE(APP_VERSION + 1, 4)
    fs.writeFileSync(bumped, bytes)

    future = boot(nwExe!, futureVersionEval(bumped), 'p10fut-') as FutureResult
    if (!future.ok) throw new Error(`future-version boot failed: ${future.error}\n${future.stack}`)
  }, 600000)

  test('a file from a newer build says so instead of failing as corruption', () => {
    expect(future.warned).toBe(true)
  })

  test('a newer, non-breaking file still loads with its blocks intact', () => {
    expect(future.count).toBe(1)
    expect(future.cls).toBe('MissingDataBlock')
    expect(future.libId).toBe(meta.curveLibId)
    expect(future.obDataLibId).toBe(meta.curveLibId)
  })
})
