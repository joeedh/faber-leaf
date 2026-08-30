/**
 * Multires subsurf integration test — the S app-wiring wasm↔native gate
 * (documentation/plans/displacementAndSubSurf.md).
 *
 * Drives the real NW.js app headlessly per backend on the spherified
 * `litemesh-cube` scene, runs `__multiresTest()` (addons/builtin/litemesh/src/
 * litemesh_multirestest_support.ts) via `--eval`, and asserts the structured
 * result reflected into the `--dump` JSON as `evalResult`. The driver enables
 * a 3-level stack, proves the level round-trip is lossless, strokes the finest
 * level through the real sculpt seam (stroke-end writeback), round-trips the
 * stroke through MeshLog undo/redo, down-refits it into level 2, and deletes
 * the stack.
 *
 * Per backend: round-trip bit-stable, stroke deforms, undo/redo exact, refit
 * preserves the fine surface while moving the coarse one, cage restored.
 * Cross-backend: level counts and every position checksum must be identical
 * (the stencil chain is fma-anchored and the CG solve is deterministic).
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app
 * bundle (`pnpm build`). The native leg additionally needs the N-API addon
 * (`make.mjs build node`); without it only the WASM leg + no cross-compare run.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {bootDump, resolveNwjsExe, NWJS_APP_DIR, isolatedProfileArgs} from './nwjs_boot'
import {backendTable, crossBackends} from './split'
import {decodePngGray, meanAbsDiff} from '../lib/png_gray'
import type {GrayImage} from '../lib/png_gray'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

interface MultiresTestResult {
  ok: boolean
  error?: string
  radius?: number
  cageVerts?: number
  cageFaces?: number
  levels?: number
  levelVerts?: number
  levelFaces?: number
  roundTripOk?: boolean
  baseChecksum?: number
  baseFloatCount?: number
  movedCount?: number
  maxDisp?: number
  postChecksum?: number
  postFloatCount?: number
  undoResidual?: number
  redoResidual?: number
  level2PreChecksum?: number
  level2PostChecksum?: number
  level2FloatCount?: number
  refitChanged?: number
  refitFineResidual?: number
  cageRestored?: boolean
}

/** `__multiresVdmTest()` result — the X1 VDM-on-finest-level gate. */
interface MultiresVdmTestResult {
  ok: boolean
  error?: string
  radius?: number
  levels?: number
  texelsTouched?: number
  clampedDefault?: number
  promptSignal?: number
  tileCount?: number
  atlasFloatCount?: number
  atlasChecksum?: number
  atlasQuantChecksum?: number
  atlasMaxAbs?: number
  posChecksumBefore?: number
  posChecksumAfter?: number
  hasVdmAfterSwitch?: boolean
  atlasStableAcrossSwitch?: boolean
}

/** `__stencilAmplifyTest()` result — the X3 stage-1 TS-device SpMV gate. */
interface StencilAmplifyResult {
  ok: boolean
  error?: string
  editLevel?: number
  renderLevel?: number
  fineCount?: number
  nnz?: number
  diffs?: number
  maxAbsErr?: number
  jsVsCpu?: number
  jsVsGpu?: number
  gpuChecksum?: number
  cpuChecksum?: number
  triIndexCount?: number
  triIndexOk?: boolean
}

/** `__multiresLayerTest()` result — the sculptLayersV2 M3 channel gate. */
interface MultiresLayerTestResult {
  ok: boolean
  error?: string
  radius?: number
  layerIndex?: number
  targetSet?: boolean
  movedCount?: number
  maxDisp?: number
  postChecksum?: number
  postFloatCount?: number
  weightZeroResidual?: number
  weightRestoreResidual?: number
  roundTripOk?: boolean
  blobRestoreResidual?: number
  layerCountAfterRestore?: number
}

/** `__multiresAddLevelTest()` result — the litemesh.multires_add_level gate. */
interface MultiresAddLevelResult {
  ok: boolean
  error?: string
  levelsBefore?: number
  facesBefore?: number
  levelsAfter?: number
  activeAfter?: number
  facesAfter?: number
  postChecksum?: number
  postFloatCount?: number
  preservedChecksum?: number
  preservedMatches?: boolean
  levelsAfterUndo?: number
  undoChecksum?: number
  undoMatches?: boolean
  levelsAfterRedo?: number
  redoChecksum?: number
}

function runMultiresTest(
  nwExe: string,
  backend: 'wasm' | 'native'
): {
  base: MultiresTestResult
  vdm: MultiresVdmTestResult
  amp: StencilAmplifyResult
  layers: MultiresLayerTestResult
  addLevel: MultiresAddLevelResult
} {
  const dump = bootDump(
    nwExe,
    [
      '--headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      // Small cage: 3 levels of CC refinement multiply the face count 64x, so
      // keep the cube coarse (levels drive the density, not the cage).
      '--scene-arg',
      'subdiv=3',
      '--eval',
      'globalThis.__evalTestResult = {base: __multiresTest(), vdm: __multiresVdmTest(), layers: __multiresLayerTest(), addLevel: __multiresAddLevelTest()}',
      // Async driver: the harness awaits each eval's RESULT, so return the
      // promise chain (top-level await is not legal in an eval'd script).
      '--eval',
      '__stencilAmplifyTest().then(r => { globalThis.__evalTestResult.amp = r })',
    ],
    {tmpPrefix: 'scmultires-', timeout: 180000}
  ) as {
    evalResult?: {
      base?: MultiresTestResult
      vdm?: MultiresVdmTestResult
      amp?: StencilAmplifyResult
      layers?: MultiresLayerTestResult
      addLevel?: MultiresAddLevelResult
    }
  }
  if (!dump.evalResult?.base) throw new Error(`${backend} dump has no multiresTest result`)
  if (!dump.evalResult?.vdm) throw new Error(`${backend} dump has no multiresVdmTest result`)
  if (!dump.evalResult?.amp) throw new Error(`${backend} dump has no stencilAmplifyTest result`)
  if (!dump.evalResult?.layers) throw new Error(`${backend} dump has no multiresLayerTest result`)
  if (!dump.evalResult?.addLevel) throw new Error(`${backend} dump has no multiresAddLevelTest result`)
  return {
    base    : dump.evalResult.base,
    vdm     : dump.evalResult.vdm,
    amp     : dump.evalResult.amp,
    layers  : dump.evalResult.layers,
    addLevel: dump.evalResult.addLevel,
  }
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
  console.warn(`[sculptcore-multires] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-multires] native leg + cross-compare skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip
const eachBackend = backendTable(backends)

maybe('sculptcore multires subsurf (level switch / writeback / down-refit)', () => {
  const results = new Map<'wasm' | 'native', MultiresTestResult>()
  const vdmResults = new Map<'wasm' | 'native', MultiresVdmTestResult>()
  const ampResults = new Map<'wasm' | 'native', StencilAmplifyResult>()
  const layerResults = new Map<'wasm' | 'native', MultiresLayerTestResult>()
  const addLevelResults = new Map<'wasm' | 'native', MultiresAddLevelResult>()

  beforeAll(() => {
    for (const backend of backends) {
      const r = runMultiresTest(nwExe!, backend)
      results.set(backend, r.base)
      vdmResults.set(backend, r.vdm)
      ampResults.set(backend, r.amp)
      layerResults.set(backend, r.layers)
      addLevelResults.set(backend, r.addLevel)
    }
  }, 600000)

  test.each(eachBackend)('%s: driver ran cleanly', (backend) => {
    const r = results.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-multires] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.radius).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: enable refines the cage into a 3-level stack', (backend) => {
    const r = results.get(backend)!
    expect(r.levels).toBe(3)
    // Uniform CC: every level multiplies faces by 4; level 3 = 64x the cage
    // quads (the spherified cube is all-quads already).
    expect(r.levelFaces).toBe(r.cageFaces! * 64)
    expect(r.levelVerts).toBeGreaterThan(r.cageVerts!)
  })

  test.each(eachBackend)('%s: level switch round-trip is bit-stable (S3 gate)', (backend) => {
    expect(results.get(backend)!.roundTripOk).toBe(true)
  })

  test.each(eachBackend)('%s: DRAW stroke on the finest level deforms the surface', (backend) => {
    const r = results.get(backend)!
    expect(r.movedCount).toBeGreaterThan(0)
    expect(r.maxDisp).toBeGreaterThan(0)
    expect(r.maxDisp!).toBeLessThan(r.radius!)
  })

  test.each(eachBackend)('%s: MeshLog undo/redo round-trips exactly (+ store resync)', (backend) => {
    const r = results.get(backend)!
    expect(r.undoResidual).toBeLessThan(1e-6)
    expect(r.redoResidual).toBeLessThan(1e-6)
  })

  test.each(eachBackend)('%s: down-refit moves level 2 and preserves level 3', (backend) => {
    const r = results.get(backend)!
    expect(r.refitChanged).toBeGreaterThan(0)
    expect(r.refitFineResidual).toBeLessThan(1e-6)
    expect(r.level2PostChecksum).not.toBe(r.level2PreChecksum)
  })

  test.each(eachBackend)('%s: delete restores the cage', (backend) => {
    expect(results.get(backend)!.cageRestored).toBe(true)
  })

  const crossTest = haveNative ? test : test.skip

  // --- multires_add_level: grow one level, lossless + undoable ---

  test.each(eachBackend)('%s: add-level driver ran cleanly', (backend) => {
    const r = addLevelResults.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-multires] ${backend} add-level driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
  })

  test.each(eachBackend)('%s: the op grows the stack by one and quadruples the finest faces', (backend) => {
    const r = addLevelResults.get(backend)!
    expect(r.levelsBefore).toBe(3)
    expect(r.levelsAfter).toBe(4)
    expect(r.activeAfter).toBe(4)
    expect(r.facesAfter).toBe(r.facesBefore! * 4)
  })

  test.each(eachBackend)('%s: the grow preserves the pre-grow finest surface bit-exactly', (backend) => {
    expect(addLevelResults.get(backend)!.preservedMatches).toBe(true)
  })

  test.each(eachBackend)('%s: toolstack undo/redo of add-level round-trips exactly', (backend) => {
    const r = addLevelResults.get(backend)!
    expect(r.levelsAfterUndo).toBe(3)
    expect(r.undoMatches).toBe(true)
    expect(r.levelsAfterRedo).toBe(4)
    expect(r.redoChecksum).toBe(r.postChecksum)
  })

  crossTest('add-level grow is checksum-identical across backends', () => {
    const wasm = addLevelResults.get('wasm')!
    const native = addLevelResults.get('native')!
    expect(native.postFloatCount).toBe(wasm.postFloatCount)
    expect(native.postChecksum).toBe(wasm.postChecksum)
    expect(native.preservedChecksum).toBe(wasm.preservedChecksum)
  })

  crossTest('level meshes and refit results are checksum-identical across backends', () => {
    const wasm = results.get('wasm')!
    const native = results.get('native')!
    expect(native.levelVerts).toBe(wasm.levelVerts)
    expect(native.levelFaces).toBe(wasm.levelFaces)
    expect(native.baseFloatCount).toBe(wasm.baseFloatCount)
    expect(native.baseChecksum).toBe(wasm.baseChecksum)
    expect(native.postFloatCount).toBe(wasm.postFloatCount)
    expect(native.postChecksum).toBe(wasm.postChecksum)
    expect(native.refitChanged).toBe(wasm.refitChanged)
    expect(native.level2FloatCount).toBe(wasm.level2FloatCount)
    expect(native.level2PreChecksum).toBe(wasm.level2PreChecksum)
    expect(native.level2PostChecksum).toBe(wasm.level2PostChecksum)
  })

  // --- sculptLayersV2 M3: layers on levels are grids-store channels ---

  test.each(eachBackend)('%s: layer-channel driver ran cleanly + target set', (backend) => {
    const r = layerResults.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-multires] ${backend} layer driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.layerIndex).toBe(0)
    expect(r.targetSet).toBe(true)
  })

  test.each(eachBackend)('%s: targeted stroke lands in the layer channel', (backend) => {
    const r = layerResults.get(backend)!
    expect(r.movedCount).toBeGreaterThan(0)
    expect(r.maxDisp).toBeGreaterThan(0)
    // Weight 0 removes exactly the stroke; weight 1 returns it (frame
    // re-encode drift only).
    expect(r.weightZeroResidual).toBeLessThan(1e-6)
    expect(r.weightRestoreResidual).toBeLessThan(1e-5)
  })

  test.each(eachBackend)('%s: level switch stays bit-stable with the layer composited', (backend) => {
    expect(layerResults.get(backend)!.roundTripOk).toBe(true)
  })

  test.each(eachBackend)('%s: store blob + layer table restore the removed layer', (backend) => {
    const r = layerResults.get(backend)!
    expect(r.blobRestoreResidual).toBeLessThan(1e-6)
    expect(r.layerCountAfterRestore).toBe(1)
  })

  crossTest('layer-channel strokes are checksum-identical across backends', () => {
    const wasm = layerResults.get('wasm')!
    const native = layerResults.get('native')!
    expect(native.postFloatCount).toBe(wasm.postFloatCount)
    expect(native.postChecksum).toBe(wasm.postChecksum)
  })

  // --- X1 gate: a VDM layer on the finest multires level. ---

  test.each(eachBackend)('%s: VDM driver ran cleanly', (backend) => {
    const r = vdmResults.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-multires] ${backend} VDM driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.levels).toBe(2)
  })

  test.each(eachBackend)('%s: splat lands through the synthesized grid-chart UVs', (backend) => {
    const r = vdmResults.get(backend)!
    expect(r.texelsTouched).toBeGreaterThan(0)
    expect(r.tileCount).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: VDM splat moves no vertices', (backend) => {
    const r = vdmResults.get(backend)!
    expect(r.posChecksumAfter).toBe(r.posChecksumBefore)
  })

  test.each(eachBackend)('%s: the clamp ceiling fires the add-a-level prompt signal', (backend) => {
    const r = vdmResults.get(backend)!
    // Near-zero α collapses the fold ceiling — most of the footprint clamps.
    expect(r.promptSignal).toBeGreaterThan(r.texelsTouched! / 2)
  })

  test.each(eachBackend)('%s: the store survives a level switch bit-exactly', (backend) => {
    const r = vdmResults.get(backend)!
    expect(r.hasVdmAfterSwitch).toBe(true)
    expect(r.atlasStableAcrossSwitch).toBe(true)
  })

  // --- X3 stage 1: the TS-device stencil SpMV reproduces the CPU chain. ---

  test.each(eachBackend)('%s: amplification export seam is bit-exact; GPU within tolerance', (backend) => {
    const r = ampResults.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-multires] ${backend} amplify driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.fineCount).toBeGreaterThan(0)
    // The export seam (tables, row order, src) is gated bit-exact via the
    // JS fma-exact eval; the GPU gets a display-tier absolute tolerance —
    // Dawn's D3D12 path lowers WGSL fma unfused (1-ulp-class noise; native
    // wgpu is bit-exact per the S5 gate), and determinism is gated by the
    // exact cross-backend checksum below.
    // eslint-disable-next-line no-console
    console.log(
      `[sculptcore-multires] ${backend} amplify diffs=${r.diffs} maxAbsErr=${r.maxAbsErr} jsVsCpu=${r.jsVsCpu}`
    )
    expect(r.jsVsCpu).toBe(0)
    expect(r.maxAbsErr).toBeLessThanOrEqual(1e-5)
  })

  test.each(eachBackend)('%s: the render-level index emitter is sane', (backend) => {
    const r = ampResults.get(backend)!
    expect(r.triIndexOk).toBe(true)
    expect(r.triIndexCount).toBeGreaterThan(0)
    expect(r.triIndexCount! % 3).toBe(0)
  })

  crossTest('amplified positions are checksum-identical across backends', () => {
    const wasm = ampResults.get('wasm')!
    const native = ampResults.get('native')!
    expect(native.fineCount).toBe(wasm.fineCount)
    expect(native.nnz).toBe(wasm.nnz)
    expect(native.gpuChecksum).toBe(wasm.gpuChecksum)
    expect(native.triIndexCount).toBe(wasm.triIndexCount)
  })

  crossTest('VDM atlases agree across backends (quantized signature)', () => {
    const wasm = vdmResults.get('wasm')!
    const native = vdmResults.get('native')!
    expect(native.texelsTouched).toBe(wasm.texelsTouched)
    expect(native.clampedDefault).toBe(wasm.clampedDefault)
    expect(native.promptSignal).toBe(wasm.promptSignal)
    expect(native.tileCount).toBe(wasm.tileCount)
    expect(native.atlasFloatCount).toBe(wasm.atlasFloatCount)
    // Bit-exact since the F3 frame provider went transcendental-free (the X1
    // follow-up): the curvature seed now uses only IEEE-exact ops, so frames —
    // and therefore texels — are identical across backends.
    expect(native.atlasQuantChecksum).toBe(wasm.atlasQuantChecksum)
    expect(native.atlasChecksum).toBe(wasm.atlasChecksum)
  })
})

// --- X2 stage 3: the Ptex fragment render gate (screenshot A/B) ------------

interface PtexRenderResult {
  texels2?: number
  refinalized?: boolean
  ok: boolean
  error?: string
  mode?: string
  charts?: number
  texelsTouched?: number
  tileCount?: number
}

/** Boot on litemesh-cube, drive `__vdmRenderTest(mode)` (the vdmrender support
 * gained 'mrflat'/'ptex' modes), capture the screenshot. */
function runPtexRender(
  nwExe2: string,
  backend: 'wasm' | 'native',
  mode: 'mrflat' | 'ptex'
): {result: PtexRenderResult; image: GrayImage} {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'ptexrender-'))
  const dumpPath = Path.join(dir, 'dump.json')
  const pngPath = Path.join(dir, 'shot.png')
  execFileSync(
    nwExe2,
    [
      NWJS_APP_DIR,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      '--scene-arg',
      'subdiv=3',
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
  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf-8')) as {evalResult?: PtexRenderResult}
  if (!dump.evalResult) throw new Error(`${backend}/${mode}: dump has no evalResult`)
  return {result: dump.evalResult, image: decodePngGray(fs.readFileSync(pngPath))}
}

maybe('sculptcore tessellated tier render (X3 stage 2 screenshot A/B)', () => {
  let coarse!: {result: PtexRenderResult; image: GrayImage}
  let fine!: {result: PtexRenderResult; image: GrayImage}
  let tess!: {result: PtexRenderResult; image: GrayImage}
  let tessVdm!: {result: PtexRenderResult; image: GrayImage}
  let tessNative: {result: PtexRenderResult; image: GrayImage} | undefined
  let tessVdmNative: {result: PtexRenderResult; image: GrayImage} | undefined

  beforeAll(() => {
    coarse = runPtexRender(nwExe!, 'wasm', 'mrcoarse' as never)
    fine = runPtexRender(nwExe!, 'wasm', 'mrflat')
    tess = runPtexRender(nwExe!, 'wasm', 'tess' as never)
    tessVdm = runPtexRender(nwExe!, 'wasm', 'tessvdm' as never)
    if (haveNative) {
      tessNative = runPtexRender(nwExe!, 'native', 'tess' as never)
      tessVdmNative = runPtexRender(nwExe!, 'native', 'tessvdm' as never)
    }
  }, 900000)

  test('drivers ran cleanly', () => {
    for (const run of [coarse, fine, tess, tessVdm]) {
      if (!run.result.ok) {
        // eslint-disable-next-line no-console
        console.error(`[tess-render] ${run.result.mode} error:\n${run.result.error}`)
      }
      expect(run.result.ok).toBe(true)
    }
  })

  test('the tessellated draw shows the amplified geometry, not the cage', () => {
    const vsFine = meanAbsDiff(tess.image, fine.image)
    const vsCoarse = meanAbsDiff(tess.image, coarse.image)
    const fineVsCoarse = meanAbsDiff(fine.image, coarse.image)
    // eslint-disable-next-line no-console
    console.log(
      `[tess-render] tess-vs-fine=${vsFine.toFixed(4)} tess-vs-coarse=${vsCoarse.toFixed(4)} ` +
        `fine-vs-coarse=${fineVsCoarse.toFixed(4)}`
    )
    // The coarse and fine levels must actually differ for the A/B to mean
    // anything; tess (same geometry as fine, shading residual only — the
    // finalize pass computes 4-neighbour lattice normals vs the batch's full
    // 1-ring v.no, measured 0.055 vs 0.23 level separation) must sit well
    // inside half the level separation.
    expect(fineVsCoarse).toBeGreaterThan(0.05)
    expect(vsFine).toBeLessThan(0.1)
    expect(vsFine).toBeLessThan(vsCoarse * 0.5)
  })

  test('the stage-3 VDM apply displaces the tessellated silhouette', () => {
    expect(tessVdm.result.texelsTouched).toBeGreaterThan(0)
    const vsTess = meanAbsDiff(tessVdm.image, tess.image)
    // eslint-disable-next-line no-console
    console.log(`[tess-render] tessvdm-vs-tess=${vsTess.toFixed(4)}`)
    // The splat dab must visibly move the amplified surface (the fragment
    // tier shades but cannot move silhouettes — this tier can).
    expect(vsTess).toBeGreaterThan(0.05)
  })

  test('a texel-only change re-finalizes the tessellated streams (4b caching)', () => {
    // The driver splats a second dab AFTER the tess build and waits for the
    // storeRev catch-up — proving the finalize re-runs off the kept amplified
    // channels instead of going stale (or re-amplifying).
    expect(tessVdm.result.texels2).toBeGreaterThan(0)
    expect(tessVdm.result.refinalized).toBe(true)
  })

  const parityTest = haveNative ? test : test.skip
  parityTest(
    'native and wasm render the same tessellated images',
    () => {
      expect(tessNative!.result.ok).toBe(true)
      const d = meanAbsDiff(tessNative!.image, tess.image)
      const dv = meanAbsDiff(tessVdmNative!.image, tessVdm.image)
      // eslint-disable-next-line no-console
      console.log(`[tess-render] meanAbs(native-wasm) tess=${d.toFixed(4)} tessvdm=${dv.toFixed(4)}`)
      expect(d).toBeLessThan(0.1)
      expect(dv).toBeLessThan(0.1)
    },
    240000
  )
})

maybe('sculptcore Ptex fragment render (screenshot A/B)', () => {
  let flat!: {result: PtexRenderResult; image: GrayImage}
  let ptex!: {result: PtexRenderResult; image: GrayImage}
  let ptexNative: {result: PtexRenderResult; image: GrayImage} | undefined

  beforeAll(() => {
    flat = runPtexRender(nwExe!, 'wasm', 'mrflat')
    ptex = runPtexRender(nwExe!, 'wasm', 'ptex')
    if (haveNative) {
      ptexNative = runPtexRender(nwExe!, 'native', 'ptex')
    }
  }, 600000)

  test('drivers ran cleanly and the splat landed', () => {
    for (const run of [flat, ptex]) {
      if (!run.result.ok) {
        // eslint-disable-next-line no-console
        console.error(`[ptex-render] ${run.result.mode} error:\n${run.result.error}`)
      }
      expect(run.result.ok).toBe(true)
    }
    expect(ptex.result.texelsTouched).toBeGreaterThan(0)
    expect(ptex.result.tileCount).toBeGreaterThan(0)
  })

  test('the VDM_PTEX sampler visibly displaces the shading', () => {
    expect(ptex.image.width).toBe(flat.image.width)
    const d = meanAbsDiff(ptex.image, flat.image)
    // eslint-disable-next-line no-console
    console.log(`[ptex-render] meanAbs(ptex-flat)=${d.toFixed(4)}`)
    expect(d).toBeGreaterThan(0.1)
  })

  const parityTest = haveNative ? test : test.skip
  parityTest(
    'native and wasm render the same ptex image',
    () => {
      expect(ptexNative!.result.ok).toBe(true)
      expect(ptexNative!.result.texelsTouched).toBe(ptex.result.texelsTouched)
      expect(ptexNative!.result.tileCount).toBe(ptex.result.tileCount)
      const d = meanAbsDiff(ptexNative!.image, ptex.image)
      // eslint-disable-next-line no-console
      console.log(`[ptex-render] meanAbs(native-wasm)=${d.toFixed(4)}`)
      expect(d).toBeLessThan(0.1)
    },
    240000
  )
})

/** `__vdmSculptTest()` result (litemesh_multirestest_support.ts) — X3 stage 4. */
interface VdmSculptResult {
  ok: boolean
  error?: string
  levels?: number
  isPtex?: boolean
  tilesAfterStroke?: number
  vertResidual?: number
  blobLenAfterStroke?: number
  blobChecksumAfterStroke?: number
  tilesAfterUndo?: number
  tilesAfterRedo?: number
  blobChecksumAfterRedo?: number
  vdmAfterDeleteOp?: boolean
  vdmAfterDeleteUndo?: boolean
  blobChecksumAfterDeleteUndo?: number
  posBeforeApply?: number
  posAfterApply?: number
  tilesAfterApply?: number
  posAfterApplyUndo?: number
  tilesAfterApplyUndo?: number
  blobChecksumAfterApplyUndo?: number
  tilesAfterCapture?: number
  posAfterCapture?: number
  captureRoundTripResidual?: number
  captureMaxDisp?: number
  captureUndoResidual?: number
  tilesAfterCaptureUndo?: number
}

function runVdmSculpt(nwExe2: string, backend: 'wasm' | 'native'): VdmSculptResult {
  const dump = bootDump(
    nwExe2,
    [
      '--headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      '--scene-arg',
      'subdiv=3',
      '--eval',
      '__vdmSculptTest()',
    ],
    {tmpPrefix: 'scvdmsculpt-', timeout: 180000}
  ) as {evalResult?: VdmSculptResult}
  if (!dump.evalResult) throw new Error(`${backend} dump has no vdmSculptTest result`)
  return dump.evalResult
}

maybe('sculptcore interactive VDM sculpting (ops / routing / undo)', () => {
  const results = new Map<'wasm' | 'native', VdmSculptResult>()

  beforeAll(() => {
    for (const backend of backends) {
      results.set(backend, runVdmSculpt(nwExe!, backend))
    }
  }, 600000)

  test.each(eachBackend)('%s: driver ran cleanly', (backend) => {
    const r = results.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[vdm-sculpt] ${backend} driver error:
${r.error}`)
    }
    expect(r.ok).toBe(true)
  })

  test.each(eachBackend)('%s: lifecycle ops attach a Ptex store on the multires mesh', (backend) => {
    const r = results.get(backend)!
    expect(r.levels).toBe(2)
    expect(r.isPtex).toBe(true)
  })

  test.each(eachBackend)('%s: routed DRAW stroke splats texels and moves no vertices', (backend) => {
    const r = results.get(backend)!
    expect(r.tilesAfterStroke).toBeGreaterThan(0)
    expect(r.vertResidual).toBe(0)
    expect(r.blobLenAfterStroke).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: the stroke undo/redo round-trips the texels exactly', (backend) => {
    const r = results.get(backend)!
    expect(r.tilesAfterUndo).toBe(0)
    expect(r.tilesAfterRedo).toBe(r.tilesAfterStroke)
    expect(r.blobChecksumAfterRedo).toBe(r.blobChecksumAfterStroke)
  })

  test.each(eachBackend)('%s: delete + toolstack undo restore the store intact', (backend) => {
    const r = results.get(backend)!
    expect(r.vdmAfterDeleteOp).toBe(false)
    expect(r.vdmAfterDeleteUndo).toBe(true)
    expect(r.blobChecksumAfterDeleteUndo).toBe(r.blobChecksumAfterStroke)
  })

  test.each(eachBackend)('%s: vdm_apply bakes texels into geometry and undoes exactly', (backend) => {
    const r = results.get(backend)!
    // The bake moves vertices (checksum changes) and empties the store...
    expect(r.posAfterApply).not.toBe(r.posBeforeApply)
    expect(r.tilesAfterApply).toBe(0)
    // ...and one toolstack undo restores positions bit-exact plus every tile
    // (in-place refill: the same store instance, same blob checksum).
    expect(r.posAfterApplyUndo).toBe(r.posBeforeApply)
    expect(r.tilesAfterApplyUndo).toBe(r.tilesAfterStroke)
    expect(r.blobChecksumAfterApplyUndo).toBe(r.blobChecksumAfterStroke)
  })

  test.each(eachBackend)('%s: vdm_capture inverts the apply (geometry -> texels)', (backend) => {
    const r = results.get(backend)!
    // Capture rasterizes the detail into texels and drops the surface
    // EXACTLY onto the smooth base (= the pre-apply positions: disp transfer
    // is exact at the vert level)...
    expect(r.tilesAfterCapture).toBeGreaterThan(0)
    expect(r.posAfterCapture).toBe(r.posBeforeApply)
    // ...re-applying the captured texels reproduces the surface to within
    // the double-bilinear discretization (measured 0.33% of the max
    // displacement)...
    expect(r.captureRoundTripResidual).toBeLessThan(r.captureMaxDisp! * 0.02)
    // ...and undoing the capture returns to the applied state (residual, not
    // checksum: the undo rematerializes through the disp encoding).
    expect(r.captureUndoResidual).toBeLessThan(1e-5)
    expect(r.tilesAfterCaptureUndo).toBe(0)
  })

  const crossTest = haveNative ? test : test.skip
  crossTest('cross-backend: identical tile counts and store checksums', () => {
    const w = results.get('wasm')!
    const n = results.get('native')!
    // eslint-disable-next-line no-console
    console.log(
      `[vdm-sculpt] tiles=${w.tilesAfterStroke}/${n.tilesAfterStroke} ` +
        `blob=${w.blobChecksumAfterStroke}/${n.blobChecksumAfterStroke}`
    )
    expect(n.tilesAfterStroke).toBe(w.tilesAfterStroke)
    expect(n.blobLenAfterStroke).toBe(w.blobLenAfterStroke)
    expect(n.blobChecksumAfterStroke).toBe(w.blobChecksumAfterStroke)
    // The bake itself is deterministic cross-backend too.
    expect(n.posAfterApply).toBe(w.posAfterApply)
    // ...and so is the capture (tile counts + exact base drop).
    expect(n.tilesAfterCapture).toBe(w.tilesAfterCapture)
    expect(n.posAfterCapture).toBe(w.posAfterCapture)
  })
})

/** `__vdmPersistTest()` result (litemesh_multirestest_support.ts) — X4 stage 3. */
interface VdmPersistResult {
  ok: boolean
  error?: string
  levels?: number
  activeLevel?: number
  tiles?: number
  vdmChecksum?: number
  cageChecksum?: number
  streamBytes?: number
  loadedLevels?: number
  loadedActiveLevel?: number
  loadedHasVdm?: boolean
  loadedIsPtex?: boolean
  loadedTiles?: number
  loadedVdmChecksum?: number
  loadedCageChecksum?: number
  posResidual?: number
}

function runVdmPersist(nwExe2: string, backend: 'wasm' | 'native'): VdmPersistResult {
  const dump = bootDump(
    nwExe2,
    [
      '--headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      '--scene-arg',
      'subdiv=3',
      '--eval',
      '__vdmPersistTest()',
    ],
    {tmpPrefix: 'scvdmpersist-', timeout: 180000}
  ) as {evalResult?: VdmPersistResult}
  if (!dump.evalResult) throw new Error(`${backend} dump has no vdmPersistTest result`)
  return dump.evalResult
}

maybe('sculptcore VDM + multires .wproj persistence (X4 stage 3)', () => {
  const results = new Map<'wasm' | 'native', VdmPersistResult>()

  beforeAll(() => {
    for (const backend of backends) {
      results.set(backend, runVdmPersist(nwExe!, backend))
    }
  }, 600000)

  test.each(eachBackend)('%s: driver ran cleanly', (backend) => {
    const r = results.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[vdm-persist] ${backend} driver error:
${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.streamBytes).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: the multires stack survives the round-trip (no flatten)', (backend) => {
    const r = results.get(backend)!
    expect(r.loadedLevels).toBe(r.levels)
    expect(r.loadedActiveLevel).toBe(r.activeLevel)
    // The persistent mesh is the CAGE, byte-identical through the stream.
    expect(r.loadedCageChecksum).toBe(r.cageChecksum)
    // Active-level positions rematerialize through the disp encoding —
    // residual, not checksum (frameT then frame = two fp roundings).
    expect(r.posResidual).toBeLessThan(1e-5)
  })

  test.each(eachBackend)('%s: the VDM store survives the round-trip byte-exact', (backend) => {
    const r = results.get(backend)!
    expect(r.loadedHasVdm).toBe(true)
    expect(r.loadedIsPtex).toBe(true)
    expect(r.loadedTiles).toBe(r.tiles)
    expect(r.loadedVdmChecksum).toBe(r.vdmChecksum)
  })

  const crossTest = haveNative ? test : test.skip
  crossTest('cross-backend: identical persisted state', () => {
    const w = results.get('wasm')!
    const n = results.get('native')!
    expect(n.vdmChecksum).toBe(w.vdmChecksum)
    expect(n.cageChecksum).toBe(w.cageChecksum)
    expect(n.tiles).toBe(w.tiles)
  })
})
