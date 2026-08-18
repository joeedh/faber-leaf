/**
 * P10 step 8 — the one real legacy `.wproj` in the tree still opens.
 *
 * `fixtures/legacy-v7-mesh-scene.wproj` was `examples/error-test.wproj`: a file
 * version 7 scene written by a build that predates stable struct ids (§4.3), the
 * forward-version guard (§6a) and the mesh migration split (§4.4a). Nothing in
 * the tree can write one any more, which is exactly why it is worth committing —
 * every other fixture here is regenerable, so none of them can catch a migration
 * being deleted.
 *
 * It carries a `Mesh` block and a `curve` BlockSet with no blocks in it, so it
 * exercises both halves of the addon seam at once: a datablock type this build
 * still has a class for, and one it does not. After P13 the `Mesh` half changes
 * sides, and this test is what notices if that stops working.
 *
 * The assertions are deliberately about *structure surviving a round-trip*, not
 * about pixels: load, re-save, re-load, and check the same blocks and object
 * bindings are still there. `.json` alongside records what the authoring build
 * wrote — assert against that, never against re-derived values.
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
const FIXTURE_DIR = Path.join(REPO_ROOT, 'tests', 'integration', 'fixtures')
const FIXTURE = Path.join(FIXTURE_DIR, 'legacy-v7-mesh-scene.wproj')
const FIXTURE_META = Path.join(FIXTURE_DIR, 'legacy-v7-mesh-scene.json')

interface LegacyMeta {
  fileVersion: number
  blockCounts: Record<string, number>
  objects: {name: string; dataCls: string; dataName: string}[]
  emptyLibTypes: string[]
}

/** One inspection of the datalib + scene, taken after a load. */
interface Probe {
  blockCounts: Record<string, number>
  objects: {name: string; dataCls: string | null; dataName: string | null}[]
  libTypes: string[]
  missing: string[]
}

interface LegacyResult {
  ok: boolean
  error?: string
  stack?: string
  headerVersion?: number
  afterLoad?: Probe
  afterRoundTrip?: Probe
  resavedBytes?: number
}

function legacyEval(fixture: string, resaved: string): string {
  return `globalThis.__evalTestResult = (() => {
  try {
    const nodefs = require('fs')
    const readAB = (p) => {
      const b = nodefs.readFileSync(p)
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    }

    const probe = () => {
      const lib = _appstate.datalib
      const blockCounts = {}
      const libTypes = []
      const missing = []
      for (const set of lib.libs) {
        const name = set.savedTypeName ? set.savedTypeName() : '?'
        libTypes.push(name)
        const blocks = [...set]
        if (blocks.length) blockCounts[name] = blocks.length
        for (const b of blocks) {
          if (b.constructor.name === 'MissingDataBlock') missing.push(b._origClsname ?? b.name)
        }
      }
      const objects = []
      for (const ob of _appstate.ctx.scene.objects) {
        objects.push({
          name    : ob.name,
          dataCls : ob.data ? ob.data.constructor.name : null,
          dataName: ob.data ? ob.data.name : null,
        })
      }
      return {blockCounts, objects, libTypes, missing}
    }

    const bytes = new Uint8Array(readAB(${JSON.stringify(fixture)}))
    const headerVersion = new DataView(bytes.buffer).getUint16(4, true)

    _appstate.loadFile(bytes.buffer)
    const afterLoad = probe()

    const buf = _appstate.createFile({save_screen: true, save_library: true, compress: false})
    nodefs.writeFileSync(${JSON.stringify(resaved)}, Buffer.from(new Uint8Array(buf)))

    _appstate.loadFile(readAB(${JSON.stringify(resaved)}))
    const afterRoundTrip = probe()

    return {ok: true, headerVersion, afterLoad, afterRoundTrip, resavedBytes: buf.byteLength}
  } catch (e) {
    return {ok: false, error: String(e), stack: String(e.stack)}
  }
})()`
}

function boot(nwExe: string, evalExpr: string): LegacyResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'p10legacy-')), 'dump.json')
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
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: LegacyResult}
  if (dump.evalResult === undefined) throw new Error(`dump has no evalResult (${out})`)
  return dump.evalResult
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveFixture = fs.existsSync(FIXTURE) && fs.existsSync(FIXTURE_META)
const canRun = !!nwExe && haveBundle && haveFixture && isDefaultBackendPass()

if (!canRun && isDefaultBackendPass()) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
    !haveFixture && `fixture missing (${Path.relative(REPO_ROOT, FIXTURE)})`,
  ]
    .filter(Boolean)
    .join('; ')
  console.warn(`[legacy_file_compat] skipped: ${why}`)
}

const describeMaybe = canRun ? describe : describe.skip

describeMaybe('a file-version 7 .wproj still opens (P10 step 8)', () => {
  let meta: LegacyMeta
  let res: LegacyResult

  beforeAll(() => {
    meta = JSON.parse(fs.readFileSync(FIXTURE_META, 'utf-8')) as LegacyMeta

    const resaved = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'p10legacyout-')), 'resaved.wproj')
    res = boot(nwExe!, legacyEval(FIXTURE, resaved))
    if (!res.ok) throw new Error(`legacy boot failed: ${res.error}\n${res.stack}`)
  }, 600000)

  test('the fixture is still the old file it claims to be', () => {
    expect(res.headerVersion).toBe(meta.fileVersion)
  })

  test('every block the authoring build wrote comes back', () => {
    expect(res.afterLoad!.blockCounts).toEqual(meta.blockCounts)
  })

  test('objects keep their geometry binding, by class and by name', () => {
    expect(res.afterLoad!.objects).toEqual(meta.objects)
  })

  test('a datablock type this build has no addon for survives as an empty set', () => {
    // The curve addon ships defaultEnabled:false, so its BlockSet is preserved
    // rather than dropped — losing it would silently drop blocks in a file that
    // had any (§4.1).
    for (const type of meta.emptyLibTypes) {
      expect([type, res.afterLoad!.libTypes.includes(type)]).toEqual([type, true])
    }
  })

  test('nothing in it decodes as a MissingDataBlock in the default build', () => {
    // Not a general invariant — it is true of *this* fixture, and it is the
    // assertion that flips when P13 moves Mesh behind the addon boundary.
    expect(res.afterLoad!.missing).toEqual([])
  })

  test('re-saving and re-opening it preserves the same scene', () => {
    expect(res.afterRoundTrip!.blockCounts).toEqual(meta.blockCounts)
    expect(res.afterRoundTrip!.objects).toEqual(meta.objects)
    expect(res.resavedBytes).toBeGreaterThan(0)
  })
})
