/**
 * selectFlush integration test (documentation/plans/selectFlush.md M4).
 *
 * Boots the real NW.js app headlessly per backend on the `litemesh-cube`
 * scene, runs `__selectFlushTest()` (addons/builtin/litemesh/src/
 * litemesh_selectflushtest_support.ts) via `--eval`, and asserts the
 * structured result reflected into the `--dump` JSON as `evalResult`:
 * a vert-only region selection drives extrude_region (face-domain op) and
 * subdivide (edge-domain op); with the flag on an explicit face selection
 * wins outright; with it off explicit + derived merge.
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

interface SelCounts {
  v: number
  e: number
  f: number
}

interface SelectFlushTestResult {
  ok: boolean
  error?: string
  extrudeFromVerts?: {before: SelCounts; after: SelCounts; worked: boolean}
  subdivideFromVerts?: {before: SelCounts; after: SelCounts; worked: boolean}
  preferExplicit?: {explicit: number; capAfter: number; worked: boolean}
  union?: {explicit: number; capAfter: number; worked: boolean}
}

/** Resolve the NW.js executable via the nwjs/ workspace package. */
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

/** Boot headlessly under `backend`, run __selectFlushTest(), return its result. */
function runSelectFlushTest(nwExe: string, backend: 'wasm' | 'native'): SelectFlushTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scsflush-')), `${backend}.json`)
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
      'subdiv=8',
      '--eval',
      '(async()=>{globalThis.__evalTestResult = await __selectFlushTest()})()',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: SelectFlushTestResult}
  if (!dump.evalResult) throw new Error(`${backend} dump has no evalResult`)
  return dump.evalResult
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
  console.warn(`[sculptcore-selectflush] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-selectflush] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('selectFlush derivation (%s)', (backend) => {
  let r: SelectFlushTestResult

  beforeAll(() => {
    r = runSelectFlushTest(nwExe!, backend)
  }, 180000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-selectflush] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
  })

  test('vert-only selection drives extrude_region', () => {
    expect(r.extrudeFromVerts?.before.f).toBe(0)
    expect(r.extrudeFromVerts?.worked).toBe(true)
  })

  test('vert-only selection drives subdivide', () => {
    expect(r.subdivideFromVerts?.worked).toBe(true)
  })

  test('explicit face selection wins with flag on', () => {
    expect(r.preferExplicit?.worked).toBe(true)
  })

  test('flag off merges explicit + derived', () => {
    expect(r.union?.worked).toBe(true)
  })
})
