/**
 * Select Similar integration test (ImmediateTODOs "Select Similar";
 * documentation/plans -> per-face material unblocked the Material criterion).
 *
 * Boots the real NW.js app headlessly per backend on the `litemesh-cube` scene,
 * runs `__selectSimilarTest()` (addons/builtin/litemesh/src/litemesh_selectsimilartest_support.ts)
 * via `--eval`, and asserts the structured `evalResult`: seeding an active
 * element and running litemesh.select_similar gathers the matching elements
 * (FACE_MATERIAL count checked against an independent faceMaterial() count,
 * FACE_SIDES = all quads, VERT_EDGES isolates the valence-distinct cube corners),
 * and the selection undoes.
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

interface SimCase {
  selected: number
  expected: number
  worked: boolean
}

interface SelectSimilarTestResult {
  ok: boolean
  error?: string
  nFaces?: number
  nVerts?: number
  faceMaterial?: SimCase
  faceMaterialNegative?: {slot0FaceSelected: boolean; worked: boolean}
  faceSides?: SimCase
  vertEdges?: SimCase & {allVerts: number}
  undoRestores?: {after: number; restored: number; worked: boolean}
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

/** Boot headlessly under `backend`, run __selectSimilarTest(), return its result. */
function runSelectSimilarTest(nwExe: string, backend: 'wasm' | 'native'): SelectSimilarTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scsimilar-')), `${backend}.json`)
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
      '(async()=>{globalThis.__evalTestResult = await __selectSimilarTest()})()',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: SelectSimilarTestResult}
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
  console.warn(`[sculptcore-selectsimilar] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-selectsimilar] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('select similar (%s)', (backend) => {
  let r: SelectSimilarTestResult

  beforeAll(() => {
    r = runSelectSimilarTest(nwExe!, backend)
  }, 180000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-selectsimilar] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
  })

  test('FACE_MATERIAL selects exactly the same-material faces', () => {
    expect(r.faceMaterial?.expected).toBeGreaterThan(0)
    expect(r.faceMaterial?.selected).toBe(r.faceMaterial?.expected)
    expect(r.faceMaterialNegative?.worked).toBe(true)
  })

  test('FACE_SIDES selects every quad', () => {
    expect(r.faceSides?.worked).toBe(true)
  })

  test('VERT_EDGES selects valence-matching verts', () => {
    expect(r.vertEdges?.selected).toBeGreaterThan(0)
    expect(r.vertEdges?.worked).toBe(true)
  })

  test('selection undoes', () => {
    expect(r.undoRestores?.worked).toBe(true)
  })
})
