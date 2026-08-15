/**
 * Sculptcore fuzz integration test (ImmediateTODOs: hunt the intermittent
 * dyntopo crash).
 *
 * Boots the real Electron app headlessly per backend on the spherified
 * `litemesh-cube` scene and runs `__fuzzTest({iters, seed})`
 * (scripts/lite-mesh/litemesh_fuzztest_support.ts) via `--eval`. The driver
 * runs random sculptcore strokes — random valid brush tool, random surface
 * anchor, 1–6 dabs, with a 1/5 chance of toggling dynamic topology — and after
 * every stroke refreshes the spatial tree and scans for non-finite vertices.
 * The replayable per-stroke log + seed are reflected into the `--dump` JSON as
 * `fuzztest`, so a crashing seed reproduces the exact run.
 *
 * Stroke count is controlled by the FUZZ_ITERS env var (default 40); a longer
 * soak (e.g. FUZZ_ITERS=2000) is the way to chase the rare crash. The test
 * fails if the driver throws (a crash), reports a non-finite vertex, or the
 * Electron process itself dies (segfault) — exactly the failure modes the
 * dyntopo crash would produce.
 *
 * Prerequisites (else self-skips, logged): a resolvable Electron and the app
 * bundle (`pnpm build`). The native leg additionally needs the N-API addon
 * (`make.mjs build node`); without it only the WASM leg runs.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {backendTable, selectedBackends} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

const ITERS = Number(process.env.FUZZ_ITERS ?? '40')
const SEED = Number(process.env.FUZZ_SEED ?? '305419896') // 0x1234abcd

interface FuzzAction {
  i: number
  toolName: string
  dabs: number
  dyntopo: boolean
  toggledDyntopo: boolean
}
interface FuzzTestResult {
  ok: boolean
  error?: string
  seed: number
  iters: number
  ranStrokes: number
  crashedAt?: number
  nonFiniteAt?: number
  finalVertCount?: number
  log: FuzzAction[]
}

function resolveElectronExe(): string | undefined {
  try {
    const exe = execFileSync('node', ['-p', "require('electron')"], {
      cwd     : Path.join(REPO_ROOT, 'electron'),
      encoding: 'utf-8',
    }).trim()
    return exe && fs.existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}

/** Boot headlessly under `backend`, run __fuzzTest, return its result (or a
 * synthesized crash result if the Electron process itself died). */
function runFuzz(electronExe: string, backend: 'wasm' | 'native'): FuzzTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scfuzz-')), `${backend}.json`)
  const env = {...process.env}
  delete env.ELECTRON_RUN_AS_NODE
  const expr = `__fuzzTest({iters:${ITERS},seed:${SEED}})`
  try {
    execFileSync(
      electronExe,
      [
        Path.join(REPO_ROOT, 'electron', 'main.js'),
        '--headless',
        '--no-devtools',
        '--backend',
        backend,
        '--gen-scene',
        'litemesh-cube',
        '--scene-arg',
        'subdiv=32',
        '--eval',
        expr,
        '--dump',
        out,
        '--exit',
      ],
      {cwd: REPO_ROOT, env, encoding: 'utf-8', stdio: 'pipe', timeout: 600000}
    )
  } catch (err) {
    // The process crashed (segfault / abort): if a partial dump exists use it,
    // else synthesize a failure so the assertion reports the crash.
    if (!fs.existsSync(out)) {
      return {
        ok        : false,
        error     : `electron process died: ${String(err)}`,
        seed      : SEED,
        iters     : ITERS,
        ranStrokes: -1,
        log       : [],
      }
    }
  }
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {fuzztest?: FuzzTestResult}
  if (!dump.fuzztest) throw new Error(`${backend} dump has no fuzztest result`)
  return dump.fuzztest
}

const electronExe = resolveElectronExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveNative = fs.existsSync(NATIVE_ADDON)
const backends = selectedBackends(haveNative)
const canRun = !!electronExe && haveBundle && backends.length > 0

if (!canRun) {
  const why = [
    !electronExe && 'electron not resolvable (electron/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[sculptcore-fuzz] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-fuzz] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('sculptcore fuzz (%s)', (backend) => {
  let r: FuzzTestResult

  beforeAll(() => {
    r = runFuzz(electronExe!, backend)
  }, 660000)

  test('driver ran without crashing', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(
        `[sculptcore-fuzz] ${backend} crashed at stroke ${r.crashedAt}; seed=${r.seed}\n` +
          `${r.error}\nlast actions:\n${JSON.stringify(r.log.slice(-5), null, 2)}`
      )
    }
    expect(r.ok).toBe(true)
  })

  test('no non-finite vertices produced', () => {
    if (r.nonFiniteAt !== undefined) {
      // eslint-disable-next-line no-console
      console.error(
        `[sculptcore-fuzz] ${backend} non-finite at stroke ${r.nonFiniteAt}; seed=${r.seed}\n` +
          `action: ${JSON.stringify(r.log[r.nonFiniteAt])}`
      )
    }
    expect(r.nonFiniteAt).toBeUndefined()
  })

  test('ran the requested strokes', () => {
    expect(r.ranStrokes).toBe(ITERS)
    expect(r.finalVertCount).toBeGreaterThan(0)
  })
})
