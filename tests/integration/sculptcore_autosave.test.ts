/**
 * Autosave round-trip integration test (plan §3/§5, M1–M3).
 *
 * Boots the real NW.js app headlessly per backend on the spherified
 * `litemesh-cube`, then drives `__autosaveTest()` (addons/builtin/litemesh/src/
 * litemesh_autosavetest_support.ts) via `--eval`: ~5 seconds of randomly-placed
 * dyntopo DRAW strokes with two randomly-timed autosaves through the real
 * AutosaveManager + split serializer (Mesh_serializeRaw → lz4 worker → WASV
 * container). After the 5s both backups are read back and validated — WASV
 * framing plus a geometry-signature round-trip against the state captured at
 * save time. The structured result rides the `--dump` JSON as `autosavetest`.
 *
 * The harness awaits async `--eval` results, so the 5s loop completes before the
 * dump. The legs are wall-clock-bound (~5s each) on top of boot, so the jest
 * timeouts are generous.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app
 * bundle (`pnpm build`). The native leg additionally needs the N-API addon
 * (`make.mjs build node`); without it only the WASM leg runs.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfileArgs} from './nwjs_boot'
import {backendTable, selectedBackends} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

interface PosSig {
  floatCount: number
  sum: number
  sumAbs: number
  min: number
  max: number
  finite: boolean
}
interface SaveRecord {
  index: number
  scheduledMs: number
  firedAtMs: number
  strokesBefore: number
  backupKey: string | null
  bytesLen: number
  sigAtSave: PosSig
  containerValid?: boolean
  blobCount?: number
  shellLen?: number
  parseError?: string
  sigLoaded?: PosSig
  finite?: boolean
  sigMatch?: boolean
}
interface AutosaveTestResult {
  ok: boolean
  error?: string
  seed?: number
  backendKind?: string
  usedManager?: boolean
  durationMs?: number
  totalStrokes?: number
  saveTimes?: number[]
  saves?: SaveRecord[]
}

function resolveNwjsExe(): string | undefined {
  try {
    const exe = execFileSync(
      'node',
      ['-e', "require('nw').findpath().then(p=>process.stdout.write(p),()=>process.exit(1))"],
      {
        cwd     : REPO_ROOT,
        encoding: 'utf-8',
      }
    ).trim()
    return exe && fs.existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}

/** Boot headlessly under `backend`, run __autosaveTest(), return its result. */
function runAutosaveTest(nwExe: string, backend: 'wasm' | 'native'): AutosaveTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scautosave-')), `${backend}.json`)
  const env = {...process.env}
  // Real autosave writes real backup files; without this they land in the
  // checkout's own `.sculptcore/autosave`, where the launch-time GC then prunes
  // the developer's own recovery snapshots.
  const stateDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'scautosave-state-'))
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--app-storage-dir',
      stateDir,
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      // Moderate density so dyntopo has geometry to subdivide, still fast/leg.
      '--scene-arg',
      'subdiv=32',
      '--eval',
      '__autosaveTest()',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {autosavetest?: AutosaveTestResult}
  fs.rmSync(stateDir, {recursive: true, force: true})
  if (!dump.autosavetest) throw new Error(`${backend} dump has no autosavetest result`)
  return dump.autosavetest
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveNative = fs.existsSync(NATIVE_ADDON)
const backends = selectedBackends(haveNative)
const canRun = !!nwExe && haveBundle && backends.length > 0

if (!canRun) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[sculptcore-autosave] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-autosave] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('sculptcore autosave round-trip (%s)', (backend) => {
  let r: AutosaveTestResult

  beforeAll(() => {
    r = runAutosaveTest(nwExe!, backend)
  }, 120000)

  test('driver ran cleanly through the 5s stroke loop', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-autosave] ${backend} driver error (seed ${r.seed}):\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.totalStrokes).toBeGreaterThan(0)
    expect(r.durationMs).toBe(5000)
  })

  test('took exactly two autosaves at distinct, in-interval times', () => {
    expect(r.saves).toHaveLength(2)
    const [a, b] = r.saves!
    // Both save windows fall inside (0, 5s) and the second is meaningfully later.
    expect(a.firedAtMs).toBeGreaterThan(0)
    expect(b.firedAtMs).toBeGreaterThan(a.firedAtMs)
    expect(b.firedAtMs).toBeLessThanOrEqual(r.durationMs! + 500)
    // Strokes kept running between the two saves.
    expect(b.strokesBefore).toBeGreaterThan(a.strokesBefore)
  })

  test('each save produced a non-empty WASV container with ≥1 mesh blob', () => {
    for (const s of r.saves!) {
      expect(s.parseError).toBeUndefined()
      expect(s.containerValid).toBe(true)
      expect(s.bytesLen).toBeGreaterThan(0)
      expect(s.shellLen).toBeGreaterThan(0)
      expect(s.blobCount).toBeGreaterThanOrEqual(1)
    }
  })

  test('both saves read back and round-trip to their save-time geometry', () => {
    for (const s of r.saves!) {
      expect(s.sigAtSave.floatCount).toBeGreaterThan(0)
      expect(s.sigAtSave.finite).toBe(true)
      expect(s.finite).toBe(true)
      expect(s.sigMatch).toBe(true)
    }
  })

  test('the two snapshots captured different mesh states', () => {
    const [a, b] = r.saves!
    // Continuous dyntopo strokes between the saves must change the geometry —
    // topology (vertex count) and/or vertex positions.
    const changed =
      a.sigAtSave.floatCount !== b.sigAtSave.floatCount || Math.abs(a.sigAtSave.sumAbs - b.sigAtSave.sumAbs) > 1e-4
    expect(changed).toBe(true)
  })
})
