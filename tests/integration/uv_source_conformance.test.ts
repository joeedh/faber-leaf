/**
 * `IUVSource` conformance for the two real implementors — P18 §5 step 2, §6.
 *
 * The rules live in `scripts/core/uv_source_conformance.ts` and are jest-free
 * on purpose: both providers are addon modules, an addon imports
 * `@framework/api`, and jest resolves no such specifier. So the suite runs
 * *inside* the app — one headless NW.js boot drives
 * `__uvsourceLiteMesh()` + `__uvsourceLeafMesh()` (the addons'
 * `*_uvsource_support.ts` modules) and reports both results through `--dump`
 * as `uvsource`.
 *
 * One boot serves both: leafmesh is default-off in the `faber-leaf`
 * distribution, but its module is still evaluated at load, so its driver is on
 * `globalThis` without enabling the addon — and nothing in the driver needs
 * registration.
 *
 * Per backend, because LiteMesh's source is an adapter over sculptcore's bulk
 * UV accessors and marshals through both the WASM and the native N-API vector
 * seam. LeafMesh is pure TS, so its leg is the same answer twice; asserting it
 * on both is free and keeps the two sources reading identically.
 *
 * Self-skips (green) without a resolvable NW.js or an app bundle, like the
 * other headless suites.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfileArgs} from './nwjs_boot'
import {backendTable, selectedBackends} from './split'
import {uvConformanceCaseNames} from '../../scripts/core/uv_source_conformance'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

/** The sources the boot is expected to report, in dump-key order. */
const SOURCES = ['litemesh', 'leafmesh'] as const

interface ConformanceResult {
  passed: string[]
  failures: string[]
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

/**
 * Boot headlessly under `backend` and run both drivers. The scene is only there
 * to bring sculptcore up — each driver builds the mesh it checks, fresh per
 * case, because half the cases write.
 */
function runConformance(nwExe: string, backend: 'wasm' | 'native'): {[source: string]: ConformanceResult} {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'uvsource-')), `${backend}.json`)
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
      'subdiv=2',
      // `--eval=<expr>`, one token: a bare argv token is parsed by headless
      // Chromium as a positional URL and aborts the launch (see
      // litemesh_attr_render.test.ts).
      '--eval=(globalThis.__uvsourceLiteMesh(),globalThis.__uvsourceLeafMesh())',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env: {...process.env}, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)

  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {
    uvsource?: {[source: string]: ConformanceResult}
  }
  if (!dump.uvsource) throw new Error(`${backend} dump has no uvsource result`)
  return dump.uvsource
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
  console.warn(`[uv-source] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[uv-source] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('IUVSource conformance (%s)', (backend) => {
  let results: {[source: string]: ConformanceResult}

  beforeAll(() => {
    results = runConformance(nwExe!, backend)
  }, 180000)

  test.each(SOURCES)('%s conforms to IUVSource', (source) => {
    const r = results[source]
    expect(r).toBeDefined()
    if (r.failures.length) {
      // eslint-disable-next-line no-console
      console.error(`[uv-source] ${backend}/${source}:\n  ${r.failures.join('\n  ')}`)
    }
    expect(r.failures).toEqual([])
  })

  test.each(SOURCES)('%s ran every case (a silent no-op is a failure)', (source) => {
    expect(results[source].passed).toEqual(uvConformanceCaseNames())
  })
})
