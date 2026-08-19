/**
 * VDM engine integration test — the V3 wasm↔native parity gate
 * (documentation/plans/displacementAndSubSurf.md; closes V2's deferred gate).
 *
 * Drives the real NW.js app headlessly per backend on the spherified
 * `litemesh-cube` scene, runs `__vdmTest()` (addons/builtin/litemesh/src/
 * litemesh_vdmtest_support.ts) via `--eval`, and asserts the structured result
 * reflected into the `--dump` JSON as `vdmtest`. The driver UV-charts every
 * face, updates frames, tags the mesh VDM-carried, and splats one dab at the
 * +Z pole into a fresh VdmStore(512, 32).
 *
 * Per backend: the splat must touch texels and allocate tiles, the GPU layout
 * must be self-consistent (slots > 0, atlas dims = tiles x tile_size), and the
 * position buffer must be byte-identical before/after (a VDM splat moves no
 * geometry). Cross-backend: the atlas checksum, layout ints, and tile count
 * must be equal between wasm and native (the same C++ splatter runs on both).
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app
 * bundle (`pnpm build`). The native leg additionally needs the N-API addon
 * (`make.mjs build node`); without it only the WASM leg + no cross-compare run.
 */

import fs from 'node:fs'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {bootDump, resolveNwjsExe} from './nwjs_boot'
import {backendTable, crossBackends} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

interface VdmTestResult {
  ok: boolean
  error?: string
  charts?: number
  poleZ?: number
  radius?: number
  texelsTouched?: number
  tileCount?: number
  layout?: number[]
  layoutSlots?: number
  pageTableOccupied?: number
  pageTableSize?: number
  atlasChecksum?: number
  atlasFloatCount?: number
  posChecksumBefore?: number
  posChecksumAfter?: number
  posMaxResidual?: number
}

/** Boot headlessly under `backend`, run __vdmTest(), return its result. */
function runVdmTest(nwExe: string, backend: 'wasm' | 'native'): VdmTestResult {
  const dump = bootDump(
    nwExe,
    [
      '--headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      // Moderate density: enough faces (charts) under the dab for a clear
      // multi-tile signal, still fast to build + atlas-read per backend.
      '--scene-arg',
      'subdiv=32',
      '--eval',
      '__vdmTest()',
    ],
    {tmpPrefix: 'scvdm-', timeout: 120000}
  ) as {vdmtest?: VdmTestResult}
  if (!dump.vdmtest) throw new Error(`${backend} dump has no vdmtest result`)
  return dump.vdmtest
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveNative = fs.existsSync(NATIVE_ADDON)
// Cross-backend suite: it checksums wasm against native in one process, so the
// split run gives it entirely to the native pass (see ./split).
const backends = crossBackends(haveNative)
const canRun = !!nwExe && haveBundle && backends.length > 0

if (!canRun) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[sculptcore-vdm] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-vdm] native leg + cross-compare skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip
const eachBackend = backendTable(backends)

maybe('sculptcore VDM splat (VdmStore)', () => {
  const results = new Map<'wasm' | 'native', VdmTestResult>()

  beforeAll(() => {
    for (const backend of backends) {
      results.set(backend, runVdmTest(nwExe!, backend))
    }
  }, 300000)

  test.each(eachBackend)('%s: driver ran cleanly', (backend) => {
    const r = results.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-vdm] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.charts).toBeGreaterThan(0)
    expect(r.radius).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: the splat touches texels and allocates tiles', (backend) => {
    const r = results.get(backend)!
    expect(r.texelsTouched).toBeGreaterThan(0)
    expect(r.tileCount).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: GPU layout is self-consistent', (backend) => {
    const r = results.get(backend)!
    const [tileSize, resolution, grid, slots, tilesX, tilesY, atlasW, atlasH] = r.layout!
    expect(tileSize).toBe(32)
    expect(resolution).toBe(512)
    expect(grid).toBe(Math.ceil(512 / 32))
    expect(slots).toBeGreaterThan(0)
    expect(slots).toBe(r.layoutSlots)
    expect(atlasW).toBe(tilesX * tileSize)
    expect(atlasH).toBe(tilesY * tileSize)
    expect(tilesX * tilesY).toBeGreaterThanOrEqual(slots)
    // Every live tile occupies a page-table entry; the atlas is non-empty.
    expect(r.pageTableOccupied).toBeGreaterThan(0)
    expect(r.atlasFloatCount).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: the splat moves no geometry', (backend) => {
    const r = results.get(backend)!
    expect(r.posMaxResidual).toBe(0)
    expect(r.posChecksumAfter).toBe(r.posChecksumBefore)
  })

  const crossTest = haveNative ? test : test.skip
  crossTest('atlas checksum, layout, and tile count are equal across backends', () => {
    const wasm = results.get('wasm')!
    const native = results.get('native')!
    expect(native.texelsTouched).toBe(wasm.texelsTouched)
    expect(native.tileCount).toBe(wasm.tileCount)
    expect(native.layout).toEqual(wasm.layout)
    expect(native.pageTableOccupied).toBe(wasm.pageTableOccupied)
    expect(native.pageTableSize).toBe(wasm.pageTableSize)
    expect(native.atlasFloatCount).toBe(wasm.atlasFloatCount)
    expect(native.atlasChecksum).toBe(wasm.atlasChecksum)
  })
})
