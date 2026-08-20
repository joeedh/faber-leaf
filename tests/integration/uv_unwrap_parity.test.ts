/**
 * The ported unwrapping stack, on the two real `IUVSource` implementors —
 * P19 §5 step 7, §6 ("unwrap a LiteMesh and a LeafMesh … and assert the results
 * are equivalent for the same input topology").
 *
 * How the solvers behave — convergence, pinning, seeding, packing — is settled
 * in `tests/unit/uv_editor/uv_solve.test.ts` against an in-memory grid. What is
 * settled here is the thing a unit test cannot reach: that two independently
 * written providers feed them the same way. Both are addon modules, and jest
 * resolves no `@framework/api`, so the run happens inside one headless NW.js
 * boot and comes back through `--dump`.
 *
 * "The same input topology" is arranged, not assumed. LiteMesh is triangles
 * only and LeafMesh is not, so the `leafmesh-mirror` fixture rebuilds the
 * LiteMesh cube face by face through `IUVSource` alone (see
 * `addons/builtin/leafmesh/src/leafmesh_uvsource_support.ts`). Any difference
 * in the answer after that is provider-specific behaviour, which is what this
 * suite is looking for.
 *
 * The two sculptcore-free fixtures are `leafmesh`, a quad cube, and
 * `leafmesh-dome`, a grid welded into one non-developable chart. Their legs are
 * the §6 exit condition — unwrap without an engine — standing in for the
 * `--no-sculptcore` build the CI gate gets to later. The dome is also the only
 * fixture whose charts are curved, so it is the one where the solver has real
 * angle error to work down rather than a plane fit that is already exact.
 *
 * Per backend, because the LiteMesh source marshals through both the WASM and
 * the native N-API vector seam.
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
const ADDON = Path.join(REPO_ROOT, 'build', 'addons', 'uv_editor', 'src', 'main.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

/** Mirrors `UVUnwrapReport` in `addons/builtin/uv_editor/src/uv_unwrap_support.ts`. */
interface UnwrapReport {
  ok: boolean
  error?: string
  elements?: number
  verts?: number
  tris?: number
  islands?: number
  angleBefore?: number
  angleAfter?: number
  positioned?: boolean
  finite?: boolean
  inUnitSquare?: boolean
  bins?: number
  uvs?: number[]
}

/** The op leg: the same three ops, run the way the UI runs them. */
interface OpsReport {
  ok: boolean
  error?: string

  /** Whether `uveditor.unwrap` moved anything at all. */
  moved?: boolean

  /** `addDrawLine` payloads seen on `ImageBus` while packing, and their sanity. */
  bins?: number
  binsFinite?: boolean

  /** How many `resetDrawLines` arrived — one per layout op, or the overlay leaks. */
  resets?: number

  finite?: boolean
  inUnitSquare?: boolean
}

interface Probe {
  error?: string
  stack?: string
  reports?: {[name: string]: UnwrapReport}
  ops?: OpsReport
}

/**
 * One `--eval` token, statements joined by spaces: a bare argv token is parsed
 * by headless Chromium as a positional URL, and a newline inside one is not
 * worth the risk (see `litemesh_attr_render.test.ts`).
 */
const EVAL = [
  'globalThis.__evalTestResult = (function () {',
  'try {',
  'var api = _framework.api;',
  'var ctx = _appstate.ctx;',
  'var reports = globalThis.__uvUnwrapAll();',
  'var ops = (function () {',
  'var lines = [], resets = 0;',
  'var spy = {onTrigger: function (type, data) {',
  'if (type === "resetDrawLines") { resets++; lines.length = 0; }',
  'else if (type === "addDrawLine") { lines.push(data); }',
  '}};',
  'api.bus.addEmitter(spy, api.ImageBus);',
  'try {',
  'var src = api.uvSourceFor(ctx.object && ctx.object.data);',
  'if (!src) { return {ok: false, error: "no IUVSource for the active object"}; }',
  'var layer = src.activeUVLayer;',
  'if (layer < 0) { return {ok: false, error: "the active object carries no UV layer"}; }',
  'var read = function () { return Array.from(src.getUVs(layer, src.listUVElements(layer))); };',
  'var before = read();',
  'ctx.api.execTool(ctx, "uveditor.unwrap", {steps: 12, showBins: false, seed: 0});',
  'var moved = String(read()) !== String(before);',
  'ctx.api.execTool(ctx, "uveditor.relax", {steps: 1});',
  'ctx.api.execTool(ctx, "uveditor.pack_islands", {showBins: true, seed: 0});',
  'var uvs = read(), finite = true, inside = true;',
  'for (var i = 0; i < uvs.length; i++) {',
  'finite = finite && isFinite(uvs[i]);',
  'inside = inside && uvs[i] >= -1e-4 && uvs[i] <= 1 + 1e-4;',
  '}',
  'var binsFinite = lines.length > 0;',
  'for (var j = 0; j < lines.length; j++) {',
  'var d = lines[j];',
  'binsFinite = binsFinite && isFinite(d.x1) && isFinite(d.y1) && isFinite(d.x2) && isFinite(d.y2);',
  '}',
  'return {ok: true, moved: moved, bins: lines.length, binsFinite: binsFinite, resets: resets,',
  'finite: finite, inUnitSquare: inside};',
  '} finally { api.bus.removeEmitter(spy, api.ImageBus); }',
  '})();',
  'return {reports: reports, ops: ops};',
  '} catch (e) {',
  'return {error: String(e), stack: String(e && e.stack)};',
  '}',
  '})()',
].join(' ')

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

function probe(nwExe: string, backend: 'wasm' | 'native'): Probe {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'uvunwrap-')), `${backend}.json`)

  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      backend,
      // The one generated scene that lays out a UV layer, so the op leg has
      // something to unwrap (see uv_editor_scope.test.ts).
      '--gen-scene',
      'litemesh-attrtest',
      '--scene-arg',
      'subdiv=2',
      `--eval=${EVAL}`,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env: {...process.env}, encoding: 'utf-8', stdio: 'pipe', timeout: 180000}
  )

  if (!fs.existsSync(out)) {
    throw new Error(`${backend} dump not written to ${out}`)
  }

  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: Probe}
  if (!dump.evalResult) {
    throw new Error(`${backend} eval did not report back (see harness stderr for the throw)`)
  }
  return dump.evalResult
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveAddon = fs.existsSync(ADDON)
const haveNative = fs.existsSync(NATIVE_ADDON)
const backends = selectedBackends(haveNative)
const canRun = !!nwExe && haveBundle && haveAddon && backends.length > 0

if (!canRun) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
    !haveAddon && `uv_editor addon not built (${Path.relative(REPO_ROOT, ADDON)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[uv-unwrap] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[uv-unwrap] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('unwrapping through IUVSource (%s)', (backend) => {
  let result: Probe

  beforeAll(() => {
    result = probe(nwExe!, backend)
    if (result.error) {
      // eslint-disable-next-line no-console
      console.error(`[uv-unwrap] ${backend} eval failed: ${result.error}\n${result.stack ?? ''}`)
    }
  }, 240000)

  /** One fixture's report, with its failure spelled out rather than as `undefined`. */
  function report(name: string): UnwrapReport {
    const r = result.reports?.[name]
    expect(r).toBeDefined()
    expect(r!.error ?? null).toBeNull()
    expect(r!.ok).toBe(true)
    return r!
  }

  test('every registered fixture unwrapped', () => {
    expect(result.error).toBeUndefined()
    expect(Object.keys(result.reports ?? {}).sort()).toEqual([
      'leafmesh',
      'leafmesh-dome',
      'leafmesh-mirror',
      'litemesh',
    ])
  })

  test.each(['litemesh', 'leafmesh', 'leafmesh-dome', 'leafmesh-mirror'])('%s produces usable UVs', (name) => {
    const r = report(name)

    expect(r.positioned).toBe(true)
    expect(r.elements).toBeGreaterThan(0)
    expect(r.islands).toBeGreaterThan(0)
    expect(r.finite).toBe(true)
    expect(r.inUnitSquare).toBe(true)
    expect(r.bins).toBeGreaterThanOrEqual(4)
    expect(r.bins! % 4).toBe(0)
  })

  // One planar face per island, so the plane fit is already the answer. The
  // floor is small rather than zero because each step smooths before it solves
  // — the residual `uv_solve.test.ts` pins down on a flat grid.
  test.each(['litemesh', 'leafmesh', 'leafmesh-mirror'])('%s keeps its planar charts flat', (name) => {
    const r = report(name)

    expect(r.angleBefore).toBeLessThan(0.05)
    expect(r.angleAfter).toBeLessThan(0.05)
  })

  test('the dome, which is not developable, is solved rather than fitted', () => {
    const r = report('leafmesh-dome')

    // One island, so flattening it costs angle error no plane fit can avoid.
    expect(r.islands).toBe(1)
    expect(r.angleBefore).toBeGreaterThan(0.05)
    expect(r.angleAfter).toBeLessThan(r.angleBefore!)
  })

  test('the two providers see the same topology', () => {
    const a = report('litemesh')
    const b = report('leafmesh-mirror')

    expect(b.elements).toBe(a.elements)
    expect(b.verts).toBe(a.verts)
    expect(b.tris).toBe(a.tris)
    expect(b.islands).toBe(a.islands)
  })

  test('and unwrap it to the same answer', () => {
    const a = report('litemesh')
    const b = report('leafmesh-mirror')

    expect(b.bins).toBe(a.bins)
    expect(b.angleAfter).toBeCloseTo(a.angleAfter!, 6)
    expect(b.uvs!.length).toBe(a.uvs!.length)

    // Element handles are each provider's own numbering, so the comparison is
    // in face-ring order — the one ordering the contract makes them agree on.
    let worst = 0
    for (let i = 0; i < a.uvs!.length; i++) {
      worst = Math.max(worst, Math.abs(a.uvs![i] - b.uvs![i]))
    }
    expect(worst).toBeLessThan(1e-4)
  })

  describe('the same run through the ops', () => {
    test('unwrap moved the layout', () => {
      expect(result.ops?.error ?? null).toBeNull()
      expect(result.ops!.ok).toBe(true)
      expect(result.ops!.moved).toBe(true)
    })

    test('and left every UV finite and inside the unit square', () => {
      expect(result.ops!.finite).toBe(true)
      expect(result.ops!.inUnitSquare).toBe(true)
    })

    test('the packer reported its bins over ImageBus', () => {
      // Four sides per bin. Cleared by unwrap and by pack — the two ops that
      // lay islands out — so an earlier run's rectangles never outlive it.
      expect(result.ops!.bins).toBeGreaterThanOrEqual(4)
      expect(result.ops!.bins! % 4).toBe(0)
      expect(result.ops!.binsFinite).toBe(true)
      expect(result.ops!.resets).toBe(2)
    })
  })
})
