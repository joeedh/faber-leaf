/**
 * RenderEngine ↔ sculptcore dynamic-attribute integration test (Milestone 7 of
 * documentation/plans/precious-waddling-wall.md / the renderengine-sculptcore
 * integration plan).
 *
 * Exercises the end-to-end dynamic-attribute path: a node-graph material whose
 * `AttributeNode`s request named mesh layers (`color`, `uv`) drives the WGSL
 * codegen (M1–M3), which hands sculptcore a `RequestedAttr` contract (M5), which
 * builds one GPU vertex buffer per requested attribute (M4) — and a request for
 * a *missing* layer must still render (default-filled) while reporting the slot
 * as absent, never throwing on the bulk-data seam.
 *
 * It runs the real NW.js app headlessly against the `litemesh-attrtest` scene
 * (a cube carrying a VERTEX FLOAT4 `color` layer + a CORNER FLOAT2 `uv` layer,
 * both built deterministically in C++ — see litemesh_test_scene.ts), then drives
 * `globalThis.__attrtestApply([...])` via `--eval` to build the material, run
 * codegen, and push the requested attrs to the LiteMesh (reproducing the M6
 * renderengine wiring the headless boot doesn't otherwise reach). The subsequent
 * `--dump` snapshots both the resulting GPU buffers (`objects[].gpuBuffers`) and
 * the driver's requested/missing contract (`attrtest`).
 *
 * Mirrors sculptcore_parity.test.ts for the NW.js-resolution / self-skip
 * boilerplate, and reuses its tolerant numeric diff for the WASM↔native attr
 * parity assertion. Self-skips (green) when the app bundle / native addon /
 * NW.js toolchain is absent, like the parity test.
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

// AttributeCategory (scripts/shadernodes): GENERIC=0, COLOR=2, UV=4.
const CAT_COLOR = 2
const CAT_UV = 4

// Tolerances mirror sculptcore_parity.test.ts — the backends share the C++
// kernel, so the only divergence is JS-side fp aggregation wobble.
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

interface AttrTestResult {
  ok: boolean
  error?: string
  requested: {name: string; slot: number; elemSize: number; gpuType: number; category: number}[]
  missing: number[]
}
interface BufferSig {
  size: number
  elemsize: number
  floatCount: number
  empty?: boolean
  sum?: number
}
interface DumpObject {
  name?: string
  dataType?: string
  gpuBuffers?: Record<string, BufferSig>
}
interface AttrRoundtripResult {
  ok: boolean
  error?: string
  before: {name: string; category: number}[]
  after: {name: string; category: number}[]
  jsonLen: number
}
interface Dump {
  backend: string
  objects: DumpObject[]
  attrtest?: AttrTestResult
  attrRoundtrip?: AttrRoundtripResult
}

/**
 * Boot the app headlessly under `backend`, build `litemesh-attrtest`, drive
 * `__attrtestApply(requests)` via --eval, then dump. The eval runs after the
 * scene is built and before the dump (test_harness flag order), so the dump sees
 * the attr buffers the driver caused sculptcore to build.
 */
function runAttrScene(
  nwExe: string,
  backend: 'wasm' | 'native',
  requests: {name: string; category: number}[],
  opts: {updateFrames?: boolean} = {}
): Dump {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'attrtest-')), `${backend}.json`)
  const evalExpr = `globalThis.__attrtestApply(${JSON.stringify(requests)}, ${JSON.stringify(opts)})`
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
      'litemesh-attrtest',
      '--scene-arg',
      'subdiv=8',
      // NB: `--eval=<expr>` (single token), NOT `--eval <expr>`. A bare
      // `<expr>` argv token is parsed by headless Chromium as a positional
      // URL; with a value-taking flag (`--dump <out>`) following it, the
      // headless launch aborts immediately (exit -1, no output). The `=` form
      // makes Chromium see an ignored switch, and getArgList() still reads it.
      `--eval=${evalExpr}`,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env, encoding: 'utf-8', stdio: 'pipe', timeout: 60000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  return JSON.parse(fs.readFileSync(out, 'utf-8')) as Dump
}

/**
 * Boot headlessly and drive `__attrtestRoundtrip(requests)` via --eval — builds a
 * shader-node Material carrying AttributeNodes, serializes its whole graph to
 * nstructjs JSON and reads it back, recording the AttributeNode attrName/category
 * on both sides into `attrRoundtrip` for the test to compare. WASM is sufficient
 * (serialization is backend-independent pure JS).
 */
function runRoundtripScene(nwExe: string, requests: {name: string; category: number}[]): Dump {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'attrjson-')), 'wasm.json')
  const evalExpr = `globalThis.__attrtestRoundtrip(${JSON.stringify(requests)})`
  const env = {...process.env}
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      'wasm',
      '--gen-scene',
      'litemesh-attrtest',
      '--scene-arg',
      'subdiv=2',
      `--eval=${evalExpr}`,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env, encoding: 'utf-8', stdio: 'pipe', timeout: 60000}
  )
  if (!fs.existsSync(out)) throw new Error(`roundtrip dump not written to ${out}`)
  return JSON.parse(fs.readFileSync(out, 'utf-8')) as Dump
}

function liteMeshOf(dump: Dump): DumpObject {
  const lm = dump.objects.find((o) => o.dataType === 'LiteMesh')
  if (!lm) throw new Error('dump has no LiteMesh object')
  return lm
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveNative = fs.existsSync(NATIVE_ADDON)
// The core path (request → codegen → buffers) is fully exercised on WASM; native
// is only needed for the parity sub-test, which self-skips independently below.
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
  console.warn(`[attr-render] skipped: ${why}`)
}

const maybe = canRun ? describe : describe.skip

maybe('renderengine ↔ sculptcore dynamic attributes', () => {
  let wasmDump: Dump

  beforeAll(() => {
    wasmDump = runAttrScene(nwExe!, 'wasm', [
      {name: 'color', category: CAT_COLOR},
      {name: 'uv', category: CAT_UV},
    ])
  }, 120000)

  test('the attribute driver ran without throwing on the seam', () => {
    expect(wasmDump.attrtest).toBeDefined()
    expect(wasmDump.attrtest!.error).toBeUndefined()
    expect(wasmDump.attrtest!.ok).toBe(true)
  })

  test('both requested layers resolve to a slot with the right element size', () => {
    const req = wasmDump.attrtest!.requested
    const color = req.find((r) => r.name === 'color')
    const uv = req.find((r) => r.name === 'uv')
    expect(color).toBeDefined()
    expect(uv).toBeDefined()
    // color is FLOAT4 (vec4), uv is FLOAT2 (vec2).
    expect(color!.elemSize).toBe(4)
    expect(uv!.elemSize).toBe(2)
    // Slots come after the implicit position(0)/normal(1).
    expect(color!.slot).toBeGreaterThanOrEqual(2)
    expect(uv!.slot).toBeGreaterThanOrEqual(2)
    expect(color!.slot).not.toBe(uv!.slot)
    // Both layers exist on the mesh, so nothing is reported missing.
    expect(wasmDump.attrtest!.missing).toEqual([])
  })

  test('sculptcore built a populated GPU buffer per requested attribute', () => {
    const bufs = liteMeshOf(wasmDump).gpuBuffers
    expect(bufs).toBeDefined()
    // Geometry must be present (the cube actually built).
    expect(bufs!.position).toBeDefined()
    expect(bufs!.position.empty).toBeUndefined()
    expect(bufs!.position.floatCount).toBeGreaterThan(0)
    // The two requested attribute buffers, by name, with their element sizes.
    expect(bufs!.color).toBeDefined()
    expect(bufs!.color.empty).toBeUndefined()
    expect(bufs!.color.elemsize).toBe(4)
    expect(bufs!.color.floatCount).toBeGreaterThan(0)
    expect(bufs!.uv).toBeDefined()
    expect(bufs!.uv.empty).toBeUndefined()
    expect(bufs!.uv.elemsize).toBe(2)
    expect(bufs!.uv.floatCount).toBeGreaterThan(0)
    // The position→rgb fill + box unwrap are non-trivial (not all-zero).
    expect(Math.abs(bufs!.color.sum ?? 0)).toBeGreaterThan(0)
    expect(Math.abs(bufs!.uv.sum ?? 0)).toBeGreaterThan(0)
  })

  test('a request for a missing layer renders with defaults and is reported absent', () => {
    const dump = runAttrScene(nwExe!, 'wasm', [
      {name: 'color', category: CAT_COLOR},
      {name: 'nonexistent', category: CAT_UV},
    ])
    // No throw on the seam — the driver completed.
    expect(dump.attrtest!.error).toBeUndefined()
    expect(dump.attrtest!.ok).toBe(true)
    // The missing layer is still part of the requested contract (it gets a slot
    // + a default-filled buffer), and is flagged in the missing-slot advisory.
    const missingReq = dump.attrtest!.requested.find((r) => r.name === 'nonexistent')
    expect(missingReq).toBeDefined()
    expect(dump.attrtest!.missing).toContain(missingReq!.slot)
    // The frame still has geometry and a buffer for the missing attr, default-filled
    // rather than absent or half-sized — the never-blank-frame guarantee.
    const bufs = liteMeshOf(dump).gpuBuffers!
    expect(bufs.position.empty).toBeUndefined()
    const missingBuf = bufs.nonexistent
    expect(missingBuf).toBeDefined()
    expect(missingBuf.empty).toBeUndefined()
    expect(missingBuf.floatCount).toBeGreaterThan(0)
  })

  test('a frame-attribute request resolves to a populated vertex buffer (V3 frame slot)', () => {
    // The VDM fragment path (displacementAndSubSurf V3) requests the F3 frame
    // vertex layers by name. With Mesh_updateFrames run first the layers exist,
    // so the GENERIC (float3) request must resolve — not report missing — and
    // sculptcore must fill a real per-vertex buffer with unit-ish tangents.
    const dump = runAttrScene(
      nwExe!,
      'wasm',
      [
        {name: 'color', category: CAT_COLOR},
        {name: '.frames.v.tangent', category: 0 /* GENERIC */},
      ],
      {updateFrames: true}
    )
    expect(dump.attrtest!.error).toBeUndefined()
    expect(dump.attrtest!.ok).toBe(true)
    const req = dump.attrtest!.requested.find((r) => r.name === '.frames.v.tangent')
    expect(req).toBeDefined()
    expect(req!.elemSize).toBe(3)
    expect(dump.attrtest!.missing).toEqual([])
    const buf = liteMeshOf(dump).gpuBuffers!['.frames.v.tangent'] as BufferSig & {sumAbs?: number}
    expect(buf).toBeDefined()
    expect(buf.empty).toBeUndefined()
    expect(buf.elemsize).toBe(3)
    expect(buf.floatCount).toBeGreaterThan(0)
    // Tangents are unit-length vectors — the buffer must be non-trivially filled.
    expect(buf.sumAbs ?? 0).toBeGreaterThan(0)
  })

  test('a shader-node Material round-trips losslessly through nstructjs JSON', () => {
    // M7 "test format" decision: nstructjs JSON IS adequate as a committed
    // shader-graph fixture format. Build a material with AttributeNodes, write
    // it to JSON, read it back, and confirm every AttributeNode's name+category
    // survives — so a `.json` graph round-trips into a runnable material.
    const dump = runRoundtripScene(nwExe!, [
      {name: 'color', category: CAT_COLOR},
      {name: 'uv', category: CAT_UV},
    ])
    const rt = dump.attrRoundtrip
    expect(rt).toBeDefined()
    expect(rt!.error).toBeUndefined()
    expect(rt!.ok).toBe(true)
    // It actually produced JSON text (not an empty/degenerate emission).
    expect(rt!.jsonLen).toBeGreaterThan(0)
    // Both AttributeNodes present before serialization, with the right categories.
    expect(rt!.before).toEqual([
      {name: 'color', category: CAT_COLOR},
      {name: 'uv', category: CAT_UV},
    ])
    // …and recovered identically after the JSON round-trip.
    expect(rt!.after).toEqual(rt!.before)
  })

  // Native parity is a separate concern from the core path; skip just this test
  // when the native addon isn't built (keeps CI without the clang toolchain green).
  const parityTest = haveNative ? test : test.skip
  parityTest(
    'native and WASM build identical attribute buffers',
    () => {
      const nativeDump = runAttrScene(nwExe!, 'native', [
        {name: 'color', category: CAT_COLOR},
        {name: 'uv', category: CAT_UV},
      ])
      const wbufs = liteMeshOf(wasmDump).gpuBuffers!
      const nbufs = liteMeshOf(nativeDump).gpuBuffers!
      for (const name of ['position', 'normal', 'color', 'uv']) {
        const mismatches = diffDump(nbufs[name], wbufs[name], `gpuBuffers/${name}`)
        if (mismatches.length) {
          // eslint-disable-next-line no-console
          console.error(`[attr-render] ${name} mismatch:\n` + mismatches.slice(0, 20).join('\n'))
        }
        expect(mismatches).toEqual([])
      }
      // The requested-attr contract itself must be backend-independent.
      expect(nativeDump.attrtest!.requested).toEqual(wasmDump.attrtest!.requested)
      expect(nativeDump.attrtest!.missing).toEqual(wasmDump.attrtest!.missing)
    },
    120000
  )
})
