/**
 * P10 — cross-build file compatibility
 * (documentation/plans/2026-08-15-0345-serialization-and-file-compat-hardening.md).
 *
 * The invariant: a `.wproj` opened by a build that does not have the addon which
 * wrote part of it must load, preserve that part byte-exactly, re-save it
 * intact, and re-open in the full build as live objects.
 *
 * `tests/integration/fixtures/curve-addon-scene.wproj` is **committed**, written
 * once by `tools/gen-file-compat-fixtures.mjs` under addon set A
 * (mesh + sculptcore + **curve**). Regenerating it from the build under test
 * would prove nothing, so nothing here writes it.
 *
 * Two headless boots, both under addon set B (the default set, which does *not*
 * enable curve):
 *
 * - boot 1 loads the fixture, makes an unrelated edit, re-saves it, and re-loads
 *   its own output;
 * - boot 2 enables curve **and** tetmesh — adding as well as removing an addon
 *   relative to A, which is what criterion 8 asks for — and opens boot 1's
 *   output.
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
import {isolatedProfileArgs, REPO_ROOT, resolveNwjsExe} from './nwjs_boot'
import {isDefaultBackendPass} from './split'

const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const FIXTURE = Path.join(REPO_ROOT, 'tests', 'integration', 'fixtures', 'curve-addon-scene.wproj')
const FIXTURE_META = Path.join(REPO_ROOT, 'tests', 'integration', 'fixtures', 'curve-addon-scene.json')

/** What the fixture's authoring build recorded about the blocks it wrote. */
interface FixtureMeta {
  curveLibId: number
  curveName: string
  obLibId: number
  obName: string
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
  curveEnabled?: boolean
  afterLoad?: PartialProbe
  afterResave?: PartialProbe
  resavedBytes?: number
}

interface FullResult {
  ok: boolean
  error?: string
  stack?: string
  curveEnabled?: boolean
  tetmeshEnabled?: boolean
  count?: number
  cls?: string | null
  libId?: number | null
  name?: string | null
  numVerts?: number
  numEdges?: number
  obFound?: boolean
  obDataIsCurve?: boolean
  obDataLibId?: number | null
  editObFound?: boolean
}

function boot(nwExe: string, evalExpr: string, tmpPrefix: string): unknown {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), tmpPrefix)), 'dump.json')
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
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
    am.disable('curve')

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
      curveEnabled: am.idmap.get('curve').enabled,
      afterLoad,
      afterResave,
      resavedBytes: buf.byteLength,
    }
  } catch (e) {
    return {ok: false, error: String(e), stack: String(e.stack)}
  }
})()`
}

function fullBuildEval(resaved: string): string {
  return `globalThis.__evalTestResult = (() => {
  try {
${EVAL_PRELUDE}
    const am = window._addons
    const e1 = am.enable('curve')
    const e2 = am.enable('tetmesh')
    if (!e1.ok) return {ok: false, error: 'enable(curve): ' + e1.message}
    if (!e2.ok) return {ok: false, error: 'enable(tetmesh): ' + e2.message}

    _appstate.loadFile(readAB(${JSON.stringify(resaved)}))

    const lib = _appstate.datalib
    const set = lib.libmap['curve']
    const blocks = set ? [...set] : []
    const c = blocks[0]
    const ob = findObject('CurveObject')

    return {
      ok            : true,
      curveEnabled  : am.idmap.get('curve').enabled,
      tetmeshEnabled: am.idmap.get('tetmesh').enabled,
      count         : blocks.length,
      cls           : c ? c.constructor.name : null,
      libId         : c ? c.lib_id : null,
      name          : c ? c.name : null,
      numVerts      : c && c.verts ? c.verts.length : -1,
      numEdges      : c && c.edges ? c.edges.length : -1,
      obFound       : !!ob,
      obDataIsCurve : !!(ob && c && ob.data === c),
      obDataLibId   : ob && ob.data ? ob.data.lib_id : null,
      editObFound   : !!findObject('PartialEditObject'),
    }
  } catch (e) {
    return {ok: false, error: String(e), stack: String(e.stack)}
  }
})()`
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveFixture = fs.existsSync(FIXTURE) && fs.existsSync(FIXTURE_META)
const canRun = !!nwExe && haveBundle && haveFixture && isDefaultBackendPass()

if (!canRun && isDefaultBackendPass()) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
    !haveFixture && `fixture missing (${Path.relative(REPO_ROOT, FIXTURE)}; run tools/gen-file-compat-fixtures.mjs)`,
  ]
    .filter(Boolean)
    .join('; ')
  console.warn(`[file_compat] skipped: ${why}`)
}

const describeMaybe = canRun ? describe : describe.skip

describeMaybe('cross-build .wproj compatibility (P10)', () => {
  let meta: FixtureMeta
  let partial: PartialResult
  let full: FullResult

  beforeAll(() => {
    meta = JSON.parse(fs.readFileSync(FIXTURE_META, 'utf-8')) as FixtureMeta

    const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'p10compat-'))
    const resaved = Path.join(dir, 'resaved.wproj')

    partial = boot(nwExe!, partialBuildEval(FIXTURE, resaved), 'p10partial-') as PartialResult
    if (!partial.ok) throw new Error(`partial-build boot failed: ${partial.error}\n${partial.stack}`)

    full = boot(nwExe!, fullBuildEval(resaved), 'p10full-') as FullResult
    if (!full.ok) throw new Error(`full-build boot failed: ${full.error}\n${full.stack}`)
  }, 600000)

  test('the reading build really does not have the addon that wrote the file', () => {
    expect(partial.curveEnabled).toBe(false)
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

  test('criterion 8: the full build re-opens the partial build’s output as live objects', () => {
    expect(full.curveEnabled).toBe(true)
    expect(full.tetmeshEnabled).toBe(true)

    expect(full.count).toBe(1)
    expect(full.cls).toBe('CurveSpline')
    expect(full.libId).toBe(meta.curveLibId)
    expect(full.name).toBe(meta.curveName)
    expect(full.numVerts).toBe(meta.numVerts)
    expect(full.numEdges).toBe(meta.numEdges)

    expect(full.obFound).toBe(true)
    expect(full.obDataIsCurve).toBe(true)
    expect(full.obDataLibId).toBe(meta.curveLibId)

    // The unrelated edit the partial build made survives alongside it.
    expect(full.editObFound).toBe(true)
  })
})
