/**
 * TS <-> C++ stroke-sampler parity gate.
 *
 * `addons/builtin/litemesh/src/stroke_driver.ts` (TS `BrushStrokeDriver`) and
 * `sculptcore/source/brush/stroke_driver.{h,cc}` (the C++ port, reached through
 * `stroke_driver_native.ts`) must emit the *same* dabs for the same pointer
 * path: same count, same positions / view vectors / radii / spacing state. Both
 * take the identical fully-resolved `StrokeInput` (local view3d px plus
 * pressure-resolved radius/strength/spacing), so a divergence here is a real
 * sampler difference and not an input-plumbing one.
 *
 * `window._sculptcoreStrokeTester.sampleStroke({useCpp})` runs one sampler and
 * returns the flattened dabs *without* touching geometry, so both legs run in a
 * single NW.js boot against the same camera and the same mesh. Coverage is
 * PATH / ANCHORED / DRAG_DOT x SCREEN / WORLD space x screen / world radius
 * units. This is the gate for flipping `sculptcore.cpp_stroke_driver` on by
 * default.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app
 * bundle (`pnpm build`). The native leg additionally needs the N-API addon
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

/** Per-field tolerance: `max(TOL_ABS, TOL_REL * |ts|)`. Both samplers walk the
 * spline in doubles, but the C++ `DabSample` stores its vectors as `float`s, so
 * a screen coordinate in the hundreds of px comes back a few float32 ulps off
 * (~2e-4) — a flat absolute epsilon would flag that as a divergence. The
 * relative term stays ~25x above that noise floor and still catches any real
 * sampler difference, which would be whole pixels. */
const TOL_ABS = 1e-4
const TOL_REL = 1e-5

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(TOL_ABS, TOL_REL * Math.abs(a))
}

type Dab = Record<string, number | boolean | number[]>

interface CaseResult {
  name: string
  ts: Dab[]
  cpp: Dab[]
}

interface ParityResult {
  ok: boolean
  error?: string
  cases?: CaseResult[]
  postDestroy?: {
    driver: string
    anchor?: number[]
    preview?: number[]
    polled: number
    finished: boolean
  }
}

/** A steady S-curve drag; long enough that PATH emits many evenly-spaced dabs
 * and the Catmull-Rom carry has to survive several segments. */
const PATH_POINTS = [
  [0.32, 0.34],
  [0.4, 0.42],
  [0.5, 0.46],
  [0.58, 0.54],
  [0.64, 0.62],
  [0.7, 0.66],
]

/** Anchored / Drag Dot: press at center, then wander -- each move re-emits a
 * live preview dab, so the count and the live radius/angle both get compared. */
const ANCHOR_POINTS = [
  [0.5, 0.5],
  [0.56, 0.44],
  [0.62, 0.4],
  [0.6, 0.52],
]

// [name, sampleStroke opts]. sculptTool 0 = CLAY, 9 = GRAB.
// brushSettings.strokeMethod: 0 PATH, 1 ANCHORED, 2 DRAG_DOT.
// brushSettings.radiusMode: 0 SCREEN, 1 WORLD. spaceMode: 0 SCREEN, 1 WORLD.
const CASES: Array<[string, Record<string, unknown>]> = [
  ['path-screen-screenRadius', {points: PATH_POINTS, sculptTool: 0, brushSettings: {strokeMethod: 0}}],
  [
    'path-screen-worldRadius',
    {points: PATH_POINTS, sculptTool: 0, brushSettings: {strokeMethod: 0, radiusMode: 1, radius: 0.3}},
  ],
  ['path-world-screenRadius', {points: PATH_POINTS, sculptTool: 0, brushSettings: {strokeMethod: 0}, spaceMode: 1}],
  [
    'path-world-worldRadius',
    {points: PATH_POINTS, sculptTool: 0, brushSettings: {strokeMethod: 0, radiusMode: 1, radius: 0.3}, spaceMode: 1},
  ],
  ['anchored-screen', {points: ANCHOR_POINTS, sculptTool: 9, brushSettings: {strokeMethod: 1}}],
  [
    'anchored-worldRadius',
    {points: ANCHOR_POINTS, sculptTool: 9, brushSettings: {strokeMethod: 1, radiusMode: 1, radius: 0.3}},
  ],
  ['dragdot-screen', {points: ANCHOR_POINTS, sculptTool: 0, brushSettings: {strokeMethod: 2}}],
  [
    'dragdot-worldRadius',
    {points: ANCHOR_POINTS, sculptTool: 0, brushSettings: {strokeMethod: 2, radiusMode: 1, radius: 0.3}},
  ],
]

const DRIVER = `(function () {
  var r = {ok: false, cases: []}
  try {
    var ctx = _appstate.ctx
    ctx.scene.switchToolMode('sculptcore')
    var t = window._sculptcoreStrokeTester
    if (!t.mesh) throw new Error('active object is not a LiteMesh')
    t.frameMeshInCamera()

    var cases = ${JSON.stringify(CASES)}
    for (var i = 0; i < cases.length; i++) {
      var name = cases[i][0]
      var opts = cases[i][1]
      r.cases.push({
        name: name,
        ts  : t.sampleStroke(Object.assign({useCpp: false, radius: 100}, opts)),
        cpp : t.sampleStroke(Object.assign({useCpp: true, radius: 100}, opts)),
      })
    }
    // A destroyed NativeStrokeDriver must stay inert. The brush-cursor overlay
    // reads toolstack.head.driver after modalEnd (sculptcore.ts drawBrush), and
    // on the native backend calling a disposed bound object handed C++ a null
    // 'this' -> renderer segfault.
    var probe = t.runStroke({points: [[0.5, 0.5], [0.52, 0.5]], radius: 20, sculptTool: 9})
    t.undo()
    var op = new (probe.tool.constructor)()
    op.inputs.brush.setValue(t.getBrush({sculptTool: 9}))
    op.modal_ctx = ctx
    var d = op.makeDriver(true)
    r.postDestroy = {driver: d.constructor.name}
    d.destroy()
    d.destroy() // idempotent
    r.postDestroy.anchor = d.getAnchorScreen()
    r.postDestroy.preview = d.getPreviewScreen()
    r.postDestroy.polled = d.poll().length
    r.postDestroy.finished = d.finished
    r.ok = true
  } catch (e) {
    r.error = String((e && e.stack) || e)
  }
  globalThis.__evalTestResult = r
})()`

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

/** Boot headlessly under `backend`, run the driver, return its result. */
function runParity(nwExe: string, backend: 'wasm' | 'native'): ParityResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scparity-')), `${backend}.json`)
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
      'subdiv=48',
      '--eval',
      DRIVER,
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env: {...process.env}, encoding: 'utf-8', stdio: 'pipe', timeout: 180000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {evalResult?: ParityResult}
  if (!dump.evalResult) throw new Error(`${backend} dump has no evalResult`)
  return dump.evalResult
}

/** Field-by-field diff of one dab pair; returns human-readable mismatches. */
function diffDab(a: Dab, b: Dab, where: string): string[] {
  const bad: string[] = []
  for (const key of Object.keys(a)) {
    const av = a[key]
    const bv = b[key]
    if (Array.isArray(av) && Array.isArray(bv)) {
      for (let i = 0; i < av.length; i++) {
        if (!near(av[i], bv[i])) {
          bad.push(`${where}.${key}[${i}]: ts=${av[i]} cpp=${bv[i]}`)
        }
      }
    } else if (typeof av === 'number' && typeof bv === 'number') {
      if (!near(av, bv)) {
        bad.push(`${where}.${key}: ts=${av} cpp=${bv}`)
      }
    } else if (av !== bv) {
      bad.push(`${where}.${key}: ts=${String(av)} cpp=${String(bv)}`)
    }
  }
  return bad
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
  console.warn(`[stroke-driver-parity] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[stroke-driver-parity] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('TS vs C++ stroke sampler parity (%s)', (backend) => {
  let r: ParityResult

  beforeAll(() => {
    r = runParity(nwExe!, backend)
  }, 240000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[stroke-driver-parity] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.cases!.length).toBe(CASES.length)
  })

  test('a destroyed driver stays inert', () => {
    const d = r.postDestroy!
    expect(d.driver).toBe('NativeStrokeDriver')
    expect(d.anchor).toBeUndefined()
    expect(d.preview).toBeUndefined()
    expect(d.polled).toBe(0)
    expect(d.finished).toBe(true)
  })

  test.each(CASES.map(([name]) => name))('%s: both samplers emit dabs', (name) => {
    const c = r.cases!.find((x) => x.name === name)!
    expect(c.ts.length).toBeGreaterThan(0)
  })

  test.each(CASES.map(([name]) => name))('%s: same dab count', (name) => {
    const c = r.cases!.find((x) => x.name === name)!
    expect(c.cpp.length).toBe(c.ts.length)
  })

  test.each(CASES.map(([name]) => name))('%s: every field agrees', (name) => {
    const c = r.cases!.find((x) => x.name === name)!
    const n = Math.min(c.ts.length, c.cpp.length)
    const bad: string[] = []
    for (let i = 0; i < n; i++) {
      bad.push(...diffDab(c.ts[i], c.cpp[i], `${name}[${i}]`))
    }
    expect(bad.slice(0, 20)).toEqual([])
  })
})
