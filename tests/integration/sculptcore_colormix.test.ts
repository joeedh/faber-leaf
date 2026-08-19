/**
 * Color paint mix-mode integration test (ImmediateTODOs "color mix modes";
 * also exercises the DSL vector-swizzle fix in emit_cpp — the per-channel modes
 * lower `.x/.y/.z` to litestl Vec operator[]).
 *
 * Boots the real NW.js app headlessly per backend on the `litemesh-cube` scene,
 * runs `__colorMixTest()` (addons/builtin/litemesh/src/litemesh_colormixtest_support.ts)
 * via `--eval`, and asserts the structured `evalResult`: from a uniform base
 * color, each mix mode blends the brush color as its formula predicts (MULTIPLY
 * darkens, SCREEN lightens, DIFFERENCE lowest on R, DARKEN clamps G, LIGHTEN
 * raises B).
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app bundle
 * (`pnpm build`). The native leg additionally needs the N-API addon
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

interface ModeMean {
  painted: number
  r: number
  g: number
  b: number
}

interface ColorMixTestResult {
  ok: boolean
  error?: string
  base?: number
  brushColor?: number[]
  modes?: Record<string, ModeMean>
  checks?: Record<string, boolean>
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

function runColorMixTest(nwExe: string, backend: 'wasm' | 'native'): ColorMixTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'sccolormix-')), `${backend}.json`)
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
      '(async()=>{globalThis.__evalTestResult = await __colorMixTest()})()',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: ColorMixTestResult}
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
  console.warn(`[sculptcore-colormix] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-colormix] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('color mix modes (%s)', (backend) => {
  let r: ColorMixTestResult

  beforeAll(() => {
    r = runColorMixTest(nwExe!, backend)
  }, 180000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-colormix] ${backend} driver error / checks:\n${r.error ?? JSON.stringify(r.checks)}`)
    }
    expect(r.ok).toBe(true)
  })

  test('every mode painted the surface', () => {
    expect(r.checks?.allPainted).toBe(true)
  })

  test('MULTIPLY darkens and SCREEN lightens', () => {
    expect(r.checks?.multiplyDarkensR).toBe(true)
    expect(r.checks?.screenLightensR).toBe(true)
  })

  test('DIFFERENCE / OVERLAY blend per channel (DSL swizzle path)', () => {
    expect(r.checks?.differenceLowestR).toBe(true)
    expect(r.checks?.overlayBetweenR).toBe(true)
  })

  test('DARKEN clamps down and LIGHTEN raises', () => {
    expect(r.checks?.darkenClampsG).toBe(true)
    expect(r.checks?.lightenRaisesB).toBe(true)
  })
})
