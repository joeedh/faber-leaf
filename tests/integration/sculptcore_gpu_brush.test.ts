/**
 * GPU brush-stroke parity test (documentation/plans/gpuGlobalBrushes.md §8.2-8.4
 * + the §9.2 fixture-replay gate), M2: kelvinlet.
 *
 * Boots the real NW.js app headlessly per backend on the `litemesh-cube` scene
 * and runs `__gpuBrushTest({runShadow: true, capture: true})`
 * (addons/builtin/litemesh/src/litemesh_gpubrush_test_support.ts), asserting the result
 * reflected into the `--dump` JSON as `gpubrushtest`:
 *
 *  - §8.2 strict parity: the WORLD-SPACE dab sequence (runSculptcoreStroke, no
 *    per-dab raycast → identical marshal inputs) agrees CPU-vs-GPU within fp
 *    tolerance, with X symmetry (§8.4).
 *  - §8.3 undo fidelity: GPU stroke → undo restores exactly; redo reapplies
 *    exactly (both the screen-space op stroke and the world-space one).
 *  - §9.3: a shadow-verify stroke reports zero divergent dabs.
 *  - The screen-space end-to-end stroke also runs both ways; its diff includes
 *    legitimate raycast-staleness drift (the CPU pass raycasts progressively
 *    deformed geometry, the GPU pass's per-dab readbacks can't land inside the
 *    synchronous exec loop — plan D4), so it gets only a sanity bound; the
 *    strict gates above carry the correctness claim.
 *  - §9.2: the captured app fixture replays bit-exact through
 *    sculptcore/tests/webgpu/replay.mjs (Dawn), proving the app uploaded the
 *    same bytes the kernel contract expects.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js + the app bundle
 * (`pnpm build`). The native leg needs the N-API addon (`make.mjs build node`).
 * The replay gate needs `sculptcore/build/wgsl_ts/` (`make.mjs codegen`).
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
const WGSL_DIR = Path.join(REPO_ROOT, 'sculptcore', 'build', 'wgsl_ts')
const REPLAY = Path.join(REPO_ROOT, 'sculptcore', 'tests', 'webgpu', 'replay.mjs')

interface Fingerprint {
  n: number
  sum: number
  sqsum: number
  finite: boolean
}

interface GpuBrushTestResult {
  backend: string
  skipped?: string
  error?: string
  parityMaxDiff?: number | null
  cpuMoved?: boolean
  cpu?: Fingerprint
  gpu?: Fingerprint
  undoMaxDiff?: number | null
  redoMaxDiff?: number | null
  shadowDivergences?: number
  worldParityMaxDiff?: number | null
  worldMoved?: boolean
  worldUndoMaxDiff?: number | null
  fixture?: object
  gpuResident?: boolean
  scatterDispatches?: number
  selfCheck?: {checked?: boolean; badCorners?: number; maxErr?: number; reason?: string}
  grabWorldParityMaxDiff?: number | null
  grabWorldMoved?: boolean
  grabWorldUndoMaxDiff?: number | null
  grabShadowDivergences?: number
  stats?: {dabs: number; dispatches: number; tripwireTripped: boolean}
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

function runGpuBrushTest(nwExe: string, backend: 'wasm' | 'native'): GpuBrushTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scgpubrush-')), `${backend}.json`)
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      '--scene-arg',
      'subdiv=32',
      '--eval',
      '__gpuBrushTest({runShadow: true, capture: true})',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env: {...process.env}, encoding: 'utf-8', stdio: 'pipe', timeout: 180000}
  )
  if (!fs.existsSync(out)) {
    throw new Error(`${backend} dump not written to ${out}`)
  }
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {gpubrushtest?: GpuBrushTestResult}
  if (!dump.gpubrushtest) {
    throw new Error(`${backend} dump has no gpubrushtest result`)
  }
  return dump.gpubrushtest
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
  console.warn(`[sculptcore-gpu-brush] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-gpu-brush] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('sculptcore GPU brush parity (%s)', (backend) => {
  let r: GpuBrushTestResult

  beforeAll(() => {
    r = runGpuBrushTest(nwExe!, backend)
  }, 240000)

  test('driver ran on the GPU path', () => {
    if (r.error) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-gpu-brush] ${backend} driver error:\n${r.error}`)
    }
    expect(r.error ?? null).toBeNull()
    expect(r.skipped ?? null).toBeNull()
    expect(r.stats!.dispatches).toBeGreaterThan(0)
    expect(r.stats!.tripwireTripped).toBe(false)
    expect(r.cpu!.finite).toBe(true)
    expect(r.gpu!.finite).toBe(true)
  })

  test('§8.2/§8.4 world-space dab parity within fp tolerance (X symmetry)', () => {
    expect(r.worldMoved).toBe(true)
    expect(typeof r.worldParityMaxDiff).toBe('number') // Infinity JSON-serializes to null
    expect(r.worldParityMaxDiff!).toBeLessThan(1e-5)
  })

  test('§8.3 undo/redo fidelity (both drivers)', () => {
    expect(r.undoMaxDiff).toBe(0)
    expect(r.redoMaxDiff).toBe(0)
    expect(r.worldUndoMaxDiff).toBe(0)
  })

  test('§9.3 shadow-verify reports zero divergent dabs', () => {
    expect(r.shadowDivergences).toBe(0)
  })

  test('M4: grab world-space parity + undo + shadow (§8.2-8.4, §9.3)', () => {
    expect(r.grabWorldMoved).toBe(true)
    expect(typeof r.grabWorldParityMaxDiff).toBe('number')
    expect(r.grabWorldParityMaxDiff!).toBeLessThan(1e-5)
    expect(r.grabWorldUndoMaxDiff).toBe(0)
    expect(r.grabShadowDivergences).toBe(0)
  })

  test('M3: GPU-resident scatter path engaged, self-check clean (§9.6)', () => {
    expect(r.gpuResident).toBe(true)
    expect(r.scatterDispatches!).toBeGreaterThan(0)
    if (r.selfCheck?.checked !== true) {
      // eslint-disable-next-line no-console
      console.error('[sculptcore-gpu-brush] self-check did not run:', r.selfCheck)
    }
    expect(r.selfCheck?.checked).toBe(true)
    expect(r.selfCheck?.badCorners).toBe(0)
  })

  test('screen-space end-to-end stroke moved geometry sanely', () => {
    expect(r.cpuMoved).toBe(true)
    expect(typeof r.parityMaxDiff).toBe('number')
    // Raycast-staleness drift only — a kernel/marshal regression would blow
    // far past this (the strict gates above catch anything subtle).
    expect(r.parityMaxDiff!).toBeLessThan(3.0)
    // Fingerprint-level agreement despite per-dab input drift.
    const rel = Math.abs(r.gpu!.sqsum - r.cpu!.sqsum) / Math.max(1, r.cpu!.sqsum)
    expect(rel).toBeLessThan(1e-2)
  })

  const replayable = fs.existsSync(WGSL_DIR) && fs.existsSync(REPLAY)
  ;(replayable ? test : test.skip)(
    '§9.2 captured app fixture replays bit-exact through Dawn',
    () => {
      expect(r.fixture).toBeDefined()
      const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'scgpufix-'))
      const fixturePath = Path.join(dir, `${backend}-kelvinlet.json`)
      fs.writeFileSync(fixturePath, JSON.stringify(r.fixture))
      const out = execFileSync('node', [REPLAY, '--wgsl-dir', WGSL_DIR, '--fixture', fixturePath], {
        cwd     : REPO_ROOT,
        encoding: 'utf-8',
        timeout : 120000,
      })
      expect(out).toMatch(/PASS/)
    },
    180000
  )
})
