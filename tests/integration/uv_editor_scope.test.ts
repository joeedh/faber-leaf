/**
 * Confirms that `selectedFacesOnly`, a tool input, actually reaches the source —
 * P18 §5 step 6, and §6's "`selectedFacesOnly` false actually differs from true".
 *
 * The archived UV ops hardcoded that filter, so nothing could tell whether it
 * was wired. Here it is set the way any caller sets it, on the op, and the
 * answer is read back off `IUVSource`. `listUVFaces(layer, selectedOnly)` carries
 * the entire meaning of the flag, and the op is the only thing between the two.
 *
 * Headless rather than a unit test for the usual reason — the ops ship in the
 * *external* `uv_editor` addon, so only a real app that started its addons can
 * invoke them. What a *partial* scope does to each geometry entry point is
 * covered against the in-memory double in
 * `tests/unit/uv_editor/uv_edit_geom.test.ts`; this suite exists to prove the
 * input arrives at all.
 *
 * `litemesh-attrtest` is the one generated scene that lays out a UV layer
 * (`markAllSeams` + `generateUVFromSeams`); `subdiv=2` is its smallest
 * setting that produces one, which is a cube of six quads.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfileArgs} from './nwjs_boot'
import {isDefaultBackendPass} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const ADDON = Path.join(REPO_ROOT, 'build', 'addons', 'uv_editor', 'src', 'main.js')

/** One reading of the source, taken between op runs. */
interface Counts {
  /** Distinct UV elements on the faces in scope, and on the whole layer. */
  scoped: number
  all: number

  /** How many of each carry UV_SELECT. */
  selScoped: number
  selAll: number
}

interface ScopeResult {
  ok: boolean
  error?: string
  stack?: string

  /** No face selected, scoped select-all ran. */
  noFaces?: Counts

  /** No face selected, unscoped select-all ran. */
  unscoped?: Counts

  /** Every face selected, scoped select-all ran. */
  allFaces?: Counts
}

/**
 * One `--eval` token, so it is written as statements joined by spaces rather
 * than as a multi-line literal: a newline inside an argv token is not worth
 * the risk, and Chromium already dictates the `--eval=<expr>` form (see the
 * note in `litemesh_attr_render.test.ts`).
 */
const SCOPE_EVAL = [
  'globalThis.__evalTestResult = (function () {',
  'try {',
  'var ctx = _appstate.ctx;',
  'var src = _framework.api.uvSourceFor(ctx.object && ctx.object.data);',
  "if (!src) { return {ok: false, error: 'no IUVSource for the active object'}; }",
  'var layer = src.activeUVLayer;',
  "if (layer < 0) { return {ok: false, error: 'the active object carries no UV layer'}; }",
  'var elemsOf = function (scoped) {',
  'var rings = src.getUVFaceRings(layer, src.listUVFaces(layer, scoped));',
  'var seen = new Set();',
  'for (var i = 0; i < rings.values.length; i++) { seen.add(rings.values[i]); }',
  'return Int32Array.from(seen);',
  '};',
  'var selectedIn = function (handles) {',
  'var flags = src.getUVFlags(layer, handles);',
  'var n = 0;',
  'for (var i = 0; i < flags.length; i++) { if (flags[i] & 1) { n++; } }',
  'return n;',
  '};',
  'var counts = function () {',
  'var scoped = elemsOf(true), all = elemsOf(false);',
  'return {scoped: scoped.length, all: all.length, selScoped: selectedIn(scoped), selAll: selectedIn(all)};',
  '};',
  'var uvOp = function (mode, selectedFacesOnly) {',
  "ctx.api.execTool(ctx, 'uveditor.toggle_select_all', {mode: mode, selectedFacesOnly: selectedFacesOnly});",
  '};',
  'var clear = function () { uvOp(1, false); };',
  'clear(); uvOp(0, true);',
  'var noFaces = counts();',
  'clear(); uvOp(0, false);',
  'var unscoped = counts();',
  "clear(); ctx.api.execTool(ctx, 'litemesh.select_all', {mode: 0}); uvOp(0, true);",
  'var allFaces = counts();',
  'return {ok: true, noFaces: noFaces, unscoped: unscoped, allFaces: allFaces};',
  '} catch (e) {',
  'return {ok: false, error: String(e), stack: String(e && e.stack)};',
  '}',
  '})()',
].join(' ')

function resolveNwjsExe(): string | undefined {
  try {
    const exe = execFileSync(
      'node',
      ['-e', "require('nw').findpath().then(p=>process.stdout.write(p),()=>process.exit(1))"],
      {cwd: REPO_ROOT, encoding: 'utf-8'}
    ).trim()
    return exe && fs.existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}

function probe(nwExe: string): ScopeResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'uvscope-')), 'dump.json')

  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      'wasm',
      '--gen-scene',
      'litemesh-attrtest',
      '--scene-arg',
      'subdiv=2',
      `--eval=${SCOPE_EVAL}`,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )

  if (!fs.existsSync(out)) {
    throw new Error(`dump not written to ${out}`)
  }

  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: ScopeResult}

  if (!dump.evalResult) {
    throw new Error('eval did not report back (see harness stderr for the throw)')
  }

  return dump.evalResult
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveAddon = fs.existsSync(ADDON)
const canRun = !!nwExe && haveBundle && haveAddon && isDefaultBackendPass()

const maybe = canRun ? describe : describe.skip

if (!canRun) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
    !haveAddon && `uv_editor addon not built (${Path.relative(REPO_ROOT, ADDON)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[uv-editor-scope] skipped: ${why}`)
}

maybe('selectedFacesOnly reaches the source as a tool input (headless)', () => {
  let result: ScopeResult

  beforeAll(() => {
    result = probe(nwExe!)
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`[uv-editor-scope] eval failed: ${result.error}\n${result.stack ?? ''}`)
    }
  }, 150000)

  test('the eval ran against a real UV source', () => {
    expect(result.ok).toBe(true)
    expect(result.unscoped!.all).toBeGreaterThan(0)
  })

  test('with no face selected, a scoped select-all selects nothing', () => {
    expect(result.noFaces!.scoped).toBe(0)
    expect(result.noFaces!.selAll).toBe(0)
  })

  test('the same op unscoped selects the whole layer, so the flag decides', () => {
    expect(result.unscoped!.selAll).toBe(result.unscoped!.all)
  })

  test('selecting the faces brings the scoped run back to the whole layer', () => {
    expect(result.allFaces!.scoped).toBe(result.allFaces!.all)
    expect(result.allFaces!.selAll).toBe(result.allFaces!.all)
  })
})
