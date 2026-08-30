/**
 * VDM fragment render path — the V3 headless screenshot A/B gate
 * (sculptcore/documentation/plans/displacementAndSubSurf.md).
 *
 * Boots the real NW.js app headlessly on the `litemesh-vdmrender` scene and
 * drives `__vdmRenderTest(mode)` (addons/builtin/litemesh/src/litemesh_vdmrender_support.ts)
 * via `--eval` before a `--screenshot`, three ways:
 *   flat — undisplaced mesh, plain node material (baseline image);
 *   vdm  — undisplaced mesh + a VdmStore holding one analytic splat dab,
 *          rendered through the VDM_MODE material WGSL (fragment displacement
 *          + gradient-derived shading normal — the path under test);
 *   ref  — the same analytic dab applied to the real vertex positions,
 *          plain material (ground-truth shading).
 *
 * PNGs are decoded by the dependency-free `tests/lib/png_gray.ts` (node:zlib)
 * and compared as luminance images. Asserted (whole-frame means, 0..255):
 *   - the VDM path visibly changes the image: meanAbs(vdm−flat) > 0.1
 *     (measured ≈ 0.31), and sanity meanAbs(ref−flat) > 0.1 (≈ 0.37);
 *   - the VDM shading matches the reference: meanAbs(vdm−ref) <
 *     0.65·meanAbs(ref−flat) (measured ratio ≈ 0.36) — the fragment path
 *     shades but cannot move silhouettes, so a strict pixel-equality bound is
 *     not achievable; additionally the shading *responses* correlate:
 *     ncc(vdm−flat, ref−flat) > 0.6 (measured ≈ 0.87).
 *
 * Cost note: the 3-image A/B runs on the WASM backend only. When the native
 * addon is present, one extra native `vdm` boot asserts backend parity of the
 * splat metrics and of the rendered image (meanAbs(native−wasm) < 0.1,
 * measured ≈ 0.008). Self-skips (green, logged) without NW.js or the bundle.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolveNwjsExe, NWJS_APP_DIR, REPO_ROOT, isolatedProfileArgs} from './nwjs_boot'
import {isCrossBackendPass} from './split'
import {decodePngGray, meanAbsDiff, ncc, diffImage, type GrayImage} from '../lib/png_gray'

const __filename = fileURLToPath(import.meta.url)
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')
void __filename

type Mode = 'flat' | 'vdm' | 'ref'

interface VdmRenderResult {
  ok: boolean
  error?: string
  mode?: string
  charts?: number
  sphereR?: number
  radius?: number
  amp?: number
  texelsTouched?: number
  tileCount?: number
  refMoved?: number
}

interface RenderRun {
  result: VdmRenderResult
  image: GrayImage
}

/** Boot headlessly under `backend`, drive `__vdmRenderTest(mode)`, capture the
 * screenshot, and return the driver result (from the dump) + decoded image. */
function runRender(nwExe: string, backend: 'wasm' | 'native', mode: Mode): RenderRun {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'vdmrender-'))
  const dumpPath = Path.join(dir, 'dump.json')
  const pngPath = Path.join(dir, 'shot.png')
  execFileSync(
    nwExe,
    [
      NWJS_APP_DIR,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-vdmrender',
      // `--eval=<expr>` as a single token (see litemesh_attr_render.test.ts:
      // a bare expr token is parsed by headless Chromium as a positional URL).
      `--eval=__vdmRenderTest('${mode}')`,
      '--dump',
      dumpPath,
      '--screenshot',
      pngPath,
      '--exit',
    ],
    {cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 180000}
  )
  if (!fs.existsSync(dumpPath)) throw new Error(`${backend}/${mode}: dump not written`)
  if (!fs.existsSync(pngPath)) throw new Error(`${backend}/${mode}: screenshot not written`)
  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf-8')) as {evalResult?: VdmRenderResult}
  if (!dump.evalResult) throw new Error(`${backend}/${mode}: dump has no evalResult`)
  return {result: dump.evalResult, image: decodePngGray(fs.readFileSync(pngPath))}
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveNative = fs.existsSync(NATIVE_ADDON)
// Its parity test boots the native backend alongside the default wasm one, so
// the suite belongs to the native pass of the split run (see ./split).
const canRun = !!nwExe && haveBundle && isCrossBackendPass(haveNative)

if (!canRun) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[vdm-render] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[vdm-render] native parity leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe('sculptcore VDM fragment render (screenshot A/B)', () => {
  const runs = new Map<Mode, RenderRun>()

  beforeAll(() => {
    for (const mode of ['flat', 'vdm', 'ref'] as Mode[]) {
      runs.set(mode, runRender(nwExe!, 'wasm', mode))
    }
  }, 600000)

  test.each([['flat'], ['vdm'], ['ref']] as const)('%s: driver ran cleanly', (mode) => {
    const r = runs.get(mode)!.result
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[vdm-render] ${mode} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    // The 12 cube-edge seams must unwrap into exactly the 6 side charts.
    expect(r.charts).toBe(6)
    expect(r.sphereR).toBeGreaterThan(0)
  })

  test('vdm splats texels; ref moves vertices', () => {
    const vdm = runs.get('vdm')!.result
    expect(vdm.texelsTouched).toBeGreaterThan(0)
    expect(vdm.tileCount).toBeGreaterThan(0)
    const ref = runs.get('ref')!.result
    expect(ref.refMoved).toBeGreaterThan(0)
  })

  test('screenshots decode to same-sized non-empty images', () => {
    const flat = runs.get('flat')!.image
    expect(flat.width).toBeGreaterThan(0)
    expect(flat.height).toBeGreaterThan(0)
    for (const mode of ['vdm', 'ref'] as Mode[]) {
      const img = runs.get(mode)!.image
      expect(img.width).toBe(flat.width)
      expect(img.height).toBe(flat.height)
    }
    // Not a blank canvas: the lit sphere must contribute real luminance.
    let sum = 0
    for (let i = 0; i < flat.data.length; i++) sum += flat.data[i]
    expect(sum / flat.data.length).toBeGreaterThan(1)
  })

  test('the VDM dab visibly changes the rendered image (vdm != flat)', () => {
    const d = meanAbsDiff(runs.get('vdm')!.image, runs.get('flat')!.image)
    // eslint-disable-next-line no-console
    console.log(`[vdm-render] meanAbs(vdm-flat) = ${d.toFixed(4)}`)
    expect(d).toBeGreaterThan(0.1) // measured ~0.31
  })

  test('the reference displacement visibly changes the image (ref != flat)', () => {
    const d = meanAbsDiff(runs.get('ref')!.image, runs.get('flat')!.image)
    // eslint-disable-next-line no-console
    console.log(`[vdm-render] meanAbs(ref-flat) = ${d.toFixed(4)}`)
    expect(d).toBeGreaterThan(0.1) // measured ~0.37
  })

  test('the VDM shading matches the displaced reference (vdm ~= ref)', () => {
    const vdm = runs.get('vdm')!.image
    const ref = runs.get('ref')!.image
    const flat = runs.get('flat')!.image
    const dVdmRef = meanAbsDiff(vdm, ref)
    const dRefFlat = meanAbsDiff(ref, flat)
    const corr = ncc(diffImage(vdm, flat), diffImage(ref, flat))
    // eslint-disable-next-line no-console
    console.log(
      `[vdm-render] meanAbs(vdm-ref) = ${dVdmRef.toFixed(4)} ` +
        `(${((dVdmRef / dRefFlat) * 100).toFixed(1)}% of ref response), ncc = ${corr.toFixed(4)}`
    )
    // The fragment path shades but doesn't move silhouettes, so vdm-ref can't
    // be pixel-tight; it must stay well under the ref response itself.
    expect(dVdmRef).toBeLessThan(0.65 * dRefFlat) // measured ratio ~0.36
    // The vdm and ref shading responses must also strongly correlate.
    expect(corr).toBeGreaterThan(0.6) // measured ~0.87
  })

  const parityTest = haveNative ? test : test.skip
  parityTest(
    'native backend renders the same VDM image (splat metrics + pixels)',
    () => {
      const native = runRender(nwExe!, 'native', 'vdm')
      const wasm = runs.get('vdm')!
      expect(native.result.ok).toBe(true)
      // The splat runs the same C++ code on both backends, so these metrics must match exactly.
      expect(native.result.charts).toBe(wasm.result.charts)
      expect(native.result.texelsTouched).toBe(wasm.result.texelsTouched)
      expect(native.result.tileCount).toBe(wasm.result.tileCount)
      const d = meanAbsDiff(native.image, wasm.image)
      // eslint-disable-next-line no-console
      console.log(`[vdm-render] meanAbs(vdm native-wasm) = ${d.toFixed(4)}`)
      expect(d).toBeLessThan(0.1) // measured ~0.008
    },
    240000
  )
})
