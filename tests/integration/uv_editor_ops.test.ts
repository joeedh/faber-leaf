/**
 * Every tool path the archived image/UV editor registered is registered again
 * — P18 §6, "Every tool path the archived `TODO.md` listed is registered and
 * invocable".
 *
 * A headless NW.js boot rather than a unit test because registration is the
 * thing under test: the ops ship in the *external* `uv_editor` addon, so the
 * only honest check is a real app that started its addons. The paths are
 * transcribed from that TODO's "Tool paths that USED to be registered" list;
 * `image.set_type` is on it and is not UV, which is why it is here too. P18
 * step 7 deleted the file, so this list is now the surviving copy of it
 * (`git show 1b268752:archive/uv-editor/TODO.md` reaches the original).
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js, the app bundle,
 * and the built addon. The native addon is NOT required — nothing here touches
 * geometry.
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

const TOOL_PATHS = [
  'uveditor.toggle_select_all',
  'uveditor.pick_select_linked',
  'uveditor.select_one',
  'uveditor.translate',
  'uveditor.scale',
  'uveditor.rotate',
  'uveditor.project_uvs',
  'uveditor.set_flag',
  'uveditor.clear_flag',
  'uveditor.toggle_flag',
  // The unwrapping stack, back from `archive/` under new names (P19 §5 step 4).
  'uveditor.unwrap',
  'uveditor.relax',
  'uveditor.pack_islands',
  'uveditor.randomize_uvs',
  'uveditor.reset_uvs',
  'uveditor.grid_uvs',
  'image.set_type',
]

interface EvalResult {
  missing: string[]
  editors: string[]
}

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

/**
 * One boot on the empty scene. The eval reports through
 * `globalThis.__evalTestResult`, which the harness copies into the dump —
 * renderer console output never reaches this process.
 */
function probe(nwExe: string): EvalResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'uvops-')), 'dump.json')

  const expr =
    `globalThis.__evalTestResult = {` +
    `missing: ${JSON.stringify(TOOL_PATHS)}.filter(p => {` +
    `try { return !CTX.api.getToolDef(p) } catch (e) { return true }}),` +
    `editors: CTX.debug.listEditorTypes().map(e => e.areaname)}`

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
      'empty',
      `--eval=${expr}`,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 90000}
  )

  if (!fs.existsSync(out)) {
    throw new Error(`dump not written to ${out}`)
  }

  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: EvalResult}

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
  console.warn(`[uv-editor-ops] skipped: ${why}`)
}

maybe('the archived UV tool paths are registered again (headless)', () => {
  let result: EvalResult

  beforeAll(() => {
    result = probe(nwExe!)
  }, 120000)

  test('every path the archived TODO listed resolves to a ToolOp', () => {
    expect(result.missing).toEqual([])
  })

  test('the UV editor itself registered, so the ops have a surface', () => {
    expect(result.editors).toContain('UVEditor')
  })
})
