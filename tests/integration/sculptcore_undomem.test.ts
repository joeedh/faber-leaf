/**
 * Sculpt undo-memory integration test (ImmediateTODOs: undo memory size
 * calculation for sculptcore's toolops + the maximum undo memory limit).
 *
 * Drives the real NW.js app headlessly per backend on the `litemesh-cube`
 * scene, runs `__undoMemTest()` (addons/builtin/litemesh/src/litemesh_undomem_support.ts)
 * via `--eval`, and asserts the structured result reflected into the `--dump`
 * JSON as `undomemtest`. The driver runs real sculpt strokes (one with dyntopo
 * so topo chunks are measured), checks per-step MeshLog accounting
 * (`stepMemSize`/`totalMemSize`), `SculptPaintOp.calcUndoMem` parity,
 * redo-branch truncation, the real `AppToolStack.limitMemory` trim path
 * (dropped ops must free their C++ steps via `onUndoDestroy` → `freeStep`),
 * the settings → stack `_syncSettings` wiring, and `freeStep`'s guards.
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

interface UndoMemTestResult {
  ok: boolean
  error?: string
  stepIds?: number[]
  stepSizes?: number[]
  totalAfterStrokes?: number
  entriesAfterStrokes?: number
  calcUndoMemMatches?: boolean
  calcUndoMemNoStep?: number
  entriesAfterTruncate?: number
  truncatedSizes?: number[]
  entriesAfterTrim?: number
  droppedStepIds?: number[]
  keptStepIds?: number[]
  syncedMemLimit?: number
  syncedEnforce?: boolean
  refreeDropped?: number
  freePendingRedo?: number
  entriesAfterUndoRedo?: number
  totalAfterUndoRedo?: number
}

/** Resolve the NW.js executable via the nwjs/ workspace package. */
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

/** Boot headlessly under `backend`, run __undoMemTest(), return its result. */
function runUndoMemTest(nwExe: string, backend: 'wasm' | 'native'): UndoMemTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scundomem-')), `${backend}.json`)
  const env = {...process.env}
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
      '__undoMemTest()',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {undomemtest?: UndoMemTestResult}
  if (!dump.undomemtest) throw new Error(`${backend} dump has no undomemtest result`)
  return dump.undomemtest
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
  console.warn(`[sculptcore-undomem] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-undomem] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('sculptcore undo memory (%s)', (backend) => {
  let r: UndoMemTestResult

  beforeAll(() => {
    r = runUndoMemTest(nwExe!, backend)
  }, 180000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-undomem] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
  })

  test('each stroke gets a distinct monotonic step id with a real byte size', () => {
    expect(r.stepIds).toHaveLength(5)
    expect(new Set(r.stepIds).size).toBe(5)
    for (let i = 1; i < 5; i++) {
      expect(r.stepIds![i]).toBeGreaterThan(r.stepIds![i - 1])
    }
    // A 2-dab stroke on a subdiv=32 cube swaps real attr data; the size must
    // reflect that, not a placeholder.
    for (const size of r.stepSizes!) {
      expect(size).toBeGreaterThan(1000)
    }
  })

  test('totalMemSize is the sum of the per-step sizes', () => {
    const sum = r.stepSizes!.reduce((a, b) => a + b, 0)
    expect(r.totalAfterStrokes).toBeCloseTo(sum, 3)
    expect(r.entriesAfterStrokes).toBe(5)
  })

  test('SculptPaintOp.calcUndoMem reports the C++ step size', () => {
    expect(r.calcUndoMemMatches).toBe(true)
    expect(r.calcUndoMemNoStep).toBe(0)
  })

  test('a stroke after undos frees the redo-branch steps', () => {
    // 5 steps, undo ×2, stroke 6: beginStep truncates the two redo entries.
    expect(r.entriesAfterTruncate).toBe(4)
    expect(r.truncatedSizes).toEqual([0, 0])
  })

  test("toolstack memory trim frees the dropped op's MeshLog step", () => {
    // limitMemory always keeps the newest 3 ops, so of our 4 the oldest drops.
    expect(r.droppedStepIds).toEqual([r.stepIds![0]])
    expect(r.keptStepIds).toHaveLength(3)
    expect(r.entriesAfterTrim).toBe(3)
  })

  test('_syncSettings maps settings.undoMemLimit (MB) onto the stack', () => {
    expect(r.syncedMemLimit).toBe(7 * 1024 * 1024)
    expect(r.syncedEnforce).toBe(true)
  })

  test('freeStep refuses already-freed and pending-redo steps', () => {
    expect(r.refreeDropped).toBe(0)
    expect(r.freePendingRedo).toBe(0)
  })

  test('surviving steps stay undo/redo aligned after trimming', () => {
    expect(r.entriesAfterUndoRedo).toBe(3)
    expect(r.totalAfterUndoRedo).toBeGreaterThan(0)
  })
})
