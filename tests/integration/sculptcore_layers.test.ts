/**
 * Sculpt-layer integration test — the F1 wasm↔native gate
 * (documentation/plans/displacementAndSubSurf.md).
 *
 * Drives the real NW.js app headlessly per backend on the spherified
 * `litemesh-cube` scene, runs `__layerTest()` (addons/builtin/litemesh/src/
 * litemesh_layertest_support.ts) via `--eval`, and asserts the structured
 * result reflected into the `--dump` JSON as `layertest`. The driver adds a
 * sculpt layer, runs one LAYERDRAW stroke at the +Z pole with the brush
 * program's attr handle pointed at the layer, then undoes one MeshLog step.
 *
 * Per backend: the stroke must deform the surface, one undo must restore the
 * pre-stroke positions, exactly one layer must exist, and the position buffer
 * must stay finite. Cross-backend: the post-stroke position-buffer checksums
 * must be identical (both backends run the same C++ kernel).
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

interface LayerTestResult {
  ok: boolean
  error?: string
  radius?: number
  layerIndex?: number
  layerAttrIndex?: number
  layerCount?: number
  movedCount?: number
  maxDisp?: number
  postChecksum?: number
  postFloatCount?: number
  undoResidual?: number
  nonFiniteCount?: number
}

/** `__layerToolTest()` result — the V5 real-tool-mapping + settings-mutator gate. */
interface LayerToolTestResult {
  ok: boolean
  error?: string
  radius?: number
  layerIndex?: number
  layerAttrIndex?: number
  movedCount?: number
  maxDisp?: number
  halfWeightMaxDisp?: number
  weightRestoreResidual?: number
  disabledResidual?: number
  enabledResidual?: number
  undoResidual?: number
  postChecksum?: number
  postFloatCount?: number
}

/** `__layerTargetTest()` result — the sculptLayersV2 edit-target gate. */
interface LayerTargetTestResult {
  ok: boolean
  error?: string
  radius?: number
  layerIndex?: number
  targetAfterOp?: number
  drawMoved?: number
  smoothMoved?: number
  grabMoved?: number
  postChecksum?: number
  postFloatCount?: number
  weightZeroResidual?: number
  weightRestoreResidual?: number
  opUndoTarget?: number
  opRedoTarget?: number
  strokeUndoResidual?: number
  undoFoldWeightZeroResidual?: number
  dynVertCountChanged?: boolean
  dynNonFinite?: number
  dynRoundTripResidual?: number
  gpuRan?: boolean
  gpuWeightZeroResidual?: number
}

/** Boot headlessly under `backend`, run all three layer drivers, return the
 * results. `__layerTest` runs first (the F1 stroke-seam gate), then
 * `__layerToolTest` (the V5 real-tool-mapping gate), then `__layerTargetTest`
 * (the V2 edit-target gate), each on independent layers. */
function runLayerTest(
  nwExe: string,
  backend: 'wasm' | 'native'
): {layertest: LayerTestResult; tooltest: LayerToolTestResult; targettest: LayerTargetTestResult} {
  const dump = bootDump(
    nwExe,
    [
      '--headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      // Moderate density: enough verts under a quarter-radius dab for a clear
      // displacement signal, still fast to build per backend.
      '--scene-arg',
      'subdiv=48',
      '--eval',
      '__layerTest()',
      '--eval',
      'globalThis.__evalTestResult = __layerToolTest()',
      // Async driver: the harness awaits each eval; the result lands on
      // __layerTargetTestResult → the dump's `layertargettest` key.
      '--eval',
      '__layerTargetTest()',
    ],
    {tmpPrefix: 'sclayer-', timeout: 180000}
  ) as {layertest?: LayerTestResult; evalResult?: LayerToolTestResult; layertargettest?: LayerTargetTestResult}
  if (!dump.layertest) throw new Error(`${backend} dump has no layertest result`)
  if (!dump.evalResult) throw new Error(`${backend} dump has no layerToolTest result`)
  if (!dump.layertargettest) throw new Error(`${backend} dump has no layerTargetTest result`)
  return {layertest: dump.layertest, tooltest: dump.evalResult, targettest: dump.layertargettest}
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
  console.warn(`[sculptcore-layers] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-layers] native leg + cross-compare skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip
const eachBackend = backendTable(backends)

maybe('sculptcore sculpt layers (LAYERDRAW)', () => {
  const results = new Map<'wasm' | 'native', LayerTestResult>()
  const toolResults = new Map<'wasm' | 'native', LayerToolTestResult>()
  const targetResults = new Map<'wasm' | 'native', LayerTargetTestResult>()

  beforeAll(() => {
    for (const backend of backends) {
      const r = runLayerTest(nwExe!, backend)
      results.set(backend, r.layertest)
      toolResults.set(backend, r.tooltest)
      targetResults.set(backend, r.targettest)
    }
  }, 600000)

  test.each(eachBackend)('%s: driver ran cleanly', (backend) => {
    const r = results.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-layers] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.radius).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: exactly one sculpt layer with a valid attr index', (backend) => {
    const r = results.get(backend)!
    expect(r.layerCount).toBe(1)
    expect(r.layerAttrIndex).toBeGreaterThanOrEqual(0)
  })

  test.each(eachBackend)('%s: LAYERDRAW stroke deforms the surface', (backend) => {
    const r = results.get(backend)!
    expect(r.movedCount).toBeGreaterThan(0)
    expect(r.maxDisp).toBeGreaterThan(0)
    // Sanity: a single full-strength dab stays bounded by the brush radius.
    expect(r.maxDisp!).toBeLessThan(r.radius!)
  })

  test.each(eachBackend)('%s: one undo restores the pre-stroke positions', (backend) => {
    const r = results.get(backend)!
    expect(r.undoResidual).toBeLessThan(1e-6)
  })

  test.each(eachBackend)('%s: no NaN/Inf in the post-stroke position buffer', (backend) => {
    const r = results.get(backend)!
    expect(r.nonFiniteCount).toBe(0)
  })

  const crossTest = haveNative ? test : test.skip
  crossTest('post-stroke position buffers are checksum-identical across backends', () => {
    const wasm = results.get('wasm')!
    const native = results.get('native')!
    expect(native.postFloatCount).toBe(wasm.postFloatCount)
    expect(native.postChecksum).toBe(wasm.postChecksum)
  })

  // --- V5 gate: LAYER_DRAW through the real tool mapping (no test seams) +
  // the Mesh_layerSet* settings mutators (weight / enabled round-trips). ---

  test.each(eachBackend)('%s: tool-path driver ran cleanly', (backend) => {
    const r = toolResults.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-layers] ${backend} tool-path driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.layerAttrIndex).toBeGreaterThanOrEqual(0)
  })

  test.each(eachBackend)('%s: LAYER_DRAW via brush.tool deforms the surface', (backend) => {
    const r = toolResults.get(backend)!
    expect(r.movedCount).toBeGreaterThan(0)
    expect(r.maxDisp).toBeGreaterThan(0)
    expect(r.maxDisp!).toBeLessThan(r.radius!)
  })

  test.each(eachBackend)('%s: weight mutator halves + restores the displacement', (backend) => {
    const r = toolResults.get(backend)!
    // co += Δw·d is exact per-vert scaling; allow fp slack around maxDisp/2.
    expect(r.halfWeightMaxDisp).toBeGreaterThan(r.maxDisp! * 0.4)
    expect(r.halfWeightMaxDisp).toBeLessThan(r.maxDisp! * 0.6)
    expect(r.weightRestoreResidual).toBeLessThan(1e-5)
  })

  test.each(eachBackend)('%s: enabled mutator subtracts + re-adds the contribution', (backend) => {
    const r = toolResults.get(backend)!
    expect(r.disabledResidual).toBeLessThan(1e-5)
    expect(r.enabledResidual).toBeLessThan(1e-5)
  })

  test.each(eachBackend)('%s: one undo restores the pre-stroke positions (tool path)', (backend) => {
    const r = toolResults.get(backend)!
    expect(r.undoResidual).toBeLessThan(1e-6)
  })

  crossTest('tool-path post-stroke positions are checksum-identical across backends', () => {
    const wasm = toolResults.get('wasm')!
    const native = toolResults.get('native')!
    expect(native.postFloatCount).toBe(wasm.postFloatCount)
    expect(native.postChecksum).toBe(wasm.postChecksum)
  })

  // --- V2 gate: the active layer is live geometry — ordinary brushes sculpt
  // into the edit target; folds derive the delta; weight-0 returns the rest. ---

  test.each(eachBackend)('%s: V2 edit-target driver ran cleanly', (backend) => {
    const r = targetResults.get(backend)!
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-layers] ${backend} edit-target driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.targetAfterOp).toBe(r.layerIndex)
  })

  test.each(eachBackend)('%s: DRAW/SMOOTH/GRAB all deform under an edit target', (backend) => {
    const r = targetResults.get(backend)!
    expect(r.drawMoved).toBeGreaterThan(0)
    expect(r.smoothMoved).toBeGreaterThan(0)
    expect(r.grabMoved).toBeGreaterThan(0)
  })

  test.each(eachBackend)('%s: weight 0 restores the at-target surface (fold captured the strokes)', (backend) => {
    const r = targetResults.get(backend)!
    expect(r.weightZeroResidual).toBeLessThan(1e-5)
    expect(r.weightRestoreResidual).toBeLessThan(1e-5)
  })

  test.each(eachBackend)('%s: toolstack undo/redo of the target op restores the engine target', (backend) => {
    const r = targetResults.get(backend)!
    expect(r.opUndoTarget).toBe(r.layerIndex)
    expect(r.opRedoTarget).toBe(-1)
  })

  test.each(eachBackend)('%s: stroke undo keeps co and the derived delta consistent', (backend) => {
    const r = targetResults.get(backend)!
    expect(r.strokeUndoResidual).toBeLessThan(1e-6)
    expect(r.undoFoldWeightZeroResidual).toBeLessThan(1e-5)
  })

  test.each(eachBackend)('%s: dyntopo under an edit target stays consistent', (backend) => {
    const r = targetResults.get(backend)!
    expect(r.dynVertCountChanged).toBe(true)
    expect(r.dynNonFinite).toBe(0)
    expect(r.dynRoundTripResidual).toBeLessThan(1e-5)
  })

  test.each(eachBackend)('%s: kelvinlet stroke records into the target (GPU path when available)', (backend) => {
    const r = targetResults.get(backend)!
    if (!r.gpuRan) {
      // eslint-disable-next-line no-console
      console.warn(`[sculptcore-layers] ${backend}: kelvinlet ran on the CPU fallback (no GPU dispatch)`)
    }
    expect(r.gpuWeightZeroResidual).toBeLessThan(1e-5)
  })

  crossTest('edit-target post-stroke positions are checksum-identical across backends', () => {
    const wasm = targetResults.get('wasm')!
    const native = targetResults.get('native')!
    expect(native.postFloatCount).toBe(wasm.postFloatCount)
    expect(native.postChecksum).toBe(wasm.postChecksum)
  })
})
