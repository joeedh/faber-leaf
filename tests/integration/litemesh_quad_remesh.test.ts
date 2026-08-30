/**
 * Host-side quad-remesh integration + parity test
 * (`sculptcore/documentation/plans/quad-remeshing.md`, M6h).
 *
 * Drives the real `litemesh.quad_remesh` ToolOp through the NW.js app
 * headlessly, once per backend, on the deterministic `litemesh-uvsphere` scene —
 * a UV sphere being the smallest mesh that drives a *successful* feature-aligned
 * remesh (the spherified cube of `litemesh-cube` has eight valence-3 corner
 * singularities the global MIQ field can't satisfy, so it clean-fails; mirrors
 * the C++ synthetic suite's `makeUVSphere`). The `--eval` harness hook calls
 * `globalThis.__quadRemeshTest()` (addons/builtin/litemesh/src/litemesh_quad_remesh_support.ts),
 * which runs the op then undo + redo, recording a backend-agnostic topology
 * fingerprint at each stage; the subsequent `--dump` snapshots the redone
 * (remeshed) GPU buffers.
 *
 * Asserts, per backend: the remesh changed the mesh (success — not a clean
 * failure), undo restored it exactly, redo reapplied it. Across backends: the
 * remeshed geometry (GPU vertex buffers) is byte-identical native↔WASM — the
 * RemeshParams bound struct + the whole M1–M6 pipeline run the same through
 * either seam. Strict all-quad topology is gated upstream in C++
 * (`test_remesh_extract`), not re-proven here.
 *
 * Self-skips (logged) without the app bundle (`pnpm build`) + native addon
 * (`make.mjs build node`) + a resolvable NW.js, so CI without the native toolchain
 * stays green — same prerequisites as sculptcore_parity.test.ts.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfileArgs} from './nwjs_boot'
import {isCrossBackendPass} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

// The backends share the C++ kernel, so remeshed dumps are normally exact; the
// tolerance only absorbs any platform fp wobble in the JS-side aggregation.
const ATOL = 1e-5
const RTOL = 1e-4

function diffDump(a: unknown, b: unknown, path = ''): string[] {
  const out: string[] = []
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = ATOL + RTOL * Math.max(Math.abs(a), Math.abs(b))
    if (Math.abs(a - b) > tol) {
      out.push(`${path || '<root>'}: ${a} != ${b} (|Δ|=${Math.abs(a - b).toExponential(3)})`)
    }
    return out
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: array length ${a.length} != ${b.length}`)
      return out
    }
    for (let i = 0; i < a.length; i++) out.push(...diffDump(a[i], b[i], `${path}[${i}]`))
    return out
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) {
      const av = (a as Record<string, unknown>)[k]
      const bv = (b as Record<string, unknown>)[k]
      if (!(k in (a as object)) || !(k in (b as object))) {
        out.push(`${path}/${k}: present in only one dump`)
        continue
      }
      out.push(...diffDump(av, bv, `${path}/${k}`))
    }
    return out
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
  return out
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

/** Topology fingerprint recorded by `__quadRemeshTest` at one stage. */
interface TopoSig {
  ngon: number
  leaf: number
  vertexCount?: number
}
interface QuadRemeshResult {
  ok: boolean
  error?: string
  backend: string
  success: boolean
  before: TopoSig
  after: TopoSig
  undone: TopoSig
  redone: TopoSig
}

/**
 * Boot the app headlessly under `backend`, build the UV-sphere scene, run the
 * quad-remesh ToolOp (+ undo + redo) via `--eval`, and return the dump.
 */
function dumpBackend(nwExe: string, backend: 'wasm' | 'native'): Record<string, unknown> {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'qremesh-')), `${backend}.json`)
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
      'litemesh-uvsphere',
      // radius 2.0 @ the default target 0.10 is the valid (Euler-2, all-quad,
      // no holes) sphere case — mirrors the C++ gate's makeUVSphere(24,32,2.0).
      // (radius 1.0 @ 0.10 is twice as fine and lands on an odd-cone-rim parity
      // hole — the same accepted odd-loop-cap limitation as the capped cylinder.)
      '--scene-arg',
      'radius=2.0',
      '--eval',
      'globalThis.__quadRemeshTest()',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env, encoding: 'utf-8', stdio: 'pipe', timeout: 180000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  return JSON.parse(fs.readFileSync(out, 'utf-8'))
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveNative = fs.existsSync(NATIVE_ADDON)
// Compares the two backends head-to-head, so it belongs to the native pass of
// the split run (see ./split).
const canRun = !!nwExe && haveBundle && haveNative && isCrossBackendPass(haveNative)

const maybe = canRun ? describe : describe.skip

if (!canRun) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
    !haveNative && `native addon missing (${Path.relative(REPO_ROOT, NATIVE_ADDON)}; run make.mjs build node)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[litemesh-quad-remesh] skipped: ${why}`)
}

maybe('litemesh quad-remesh ToolOp (native↔WASM)', () => {
  let wasmDump: Record<string, unknown>
  let nativeDump: Record<string, unknown>
  let wasmQR: QuadRemeshResult
  let nativeQR: QuadRemeshResult

  beforeAll(() => {
    wasmDump = dumpBackend(nwExe!, 'wasm')
    nativeDump = dumpBackend(nwExe!, 'native')
    wasmQR = wasmDump.quadRemesh as QuadRemeshResult
    nativeQR = nativeDump.quadRemesh as QuadRemeshResult
  }, 420000)

  test('the quad-remesh driver ran cleanly on both backends', () => {
    expect(wasmQR).toBeDefined()
    expect(nativeQR).toBeDefined()
    expect(wasmQR.error).toBeUndefined()
    expect(nativeQR.error).toBeUndefined()
    expect(wasmQR.ok).toBe(true)
    expect(nativeQR.ok).toBe(true)
    expect(wasmQR.backend).toBe('wasm')
    expect(nativeQR.backend).toBe('native')
  })

  test('the remesh changed the mesh (success, not a clean failure) on both backends', () => {
    for (const qr of [wasmQR, nativeQR]) {
      expect(qr.success).toBe(true)
      // A real remesh both re-tessellates (ngon face count moves) and rebuilds
      // the BVH (leaf count moves) away from the input UV sphere.
      const changed = qr.after.ngon !== qr.before.ngon || qr.after.leaf !== qr.before.leaf
      expect(changed).toBe(true)
      // The output carries n-gon (quad) faces — not a degenerate empty/triangle soup.
      expect(qr.after.ngon).toBeGreaterThan(0)
      expect(qr.after.leaf).toBeGreaterThan(0)
    }
  })

  test('undo restores the pre-remesh mesh, redo reapplies it (both backends)', () => {
    for (const qr of [wasmQR, nativeQR]) {
      // Serialize-snapshot undo must land exactly back on the input fingerprint.
      expect(qr.undone.ngon).toBe(qr.before.ngon)
      expect(qr.undone.leaf).toBe(qr.before.leaf)
      // Redo re-runs the deterministic (fixed-seed) pipeline → back to the output.
      expect(qr.redone.ngon).toBe(qr.after.ngon)
      expect(qr.redone.leaf).toBe(qr.after.leaf)
    }
  })

  test('both backends agree on the input and remeshed topology fingerprints', () => {
    // Input parity (sanity: the UV sphere builds identically).
    expect(nativeQR.before.ngon).toBe(wasmQR.before.ngon)
    expect(nativeQR.before.leaf).toBe(wasmQR.before.leaf)
    // Remesh-output topology parity.
    expect(nativeQR.after.ngon).toBe(wasmQR.after.ngon)
    expect(nativeQR.after.leaf).toBe(wasmQR.after.leaf)
  })

  test('the remeshed LiteMesh has populated GPU buffers', () => {
    const lm = (wasmDump.objects as Record<string, unknown>[]).find((o) => o.dataType === 'LiteMesh')
    expect(lm).toBeDefined()
    const bufs = lm!.gpuBuffers as Record<string, unknown> | undefined
    expect(bufs && Object.keys(bufs).length).toBeGreaterThan(0)
    const pos = bufs!.position as Record<string, unknown> | undefined
    expect(pos).toBeDefined()
    expect(pos!.empty).toBeUndefined()
    expect(pos!.floatCount as number).toBeGreaterThan(0)
  })

  test('native and WASM remeshed geometry/topology dumps match within tolerance', () => {
    // Compare the per-object geometry (GPU buffers, leaf counts) of the remeshed
    // result — the bytes the renderer would upload — across backends. This is the
    // core M6h claim: the remesh OUTPUT is identical through either seam.
    const mismatches = diffDump(nativeDump.objects, wasmDump.objects, '/objects')
    if (mismatches.length) {
      // eslint-disable-next-line no-console
      console.error('[litemesh-quad-remesh] mismatches:\n' + mismatches.slice(0, 40).join('\n'))
    }
    expect(mismatches).toEqual([])
  })
})
