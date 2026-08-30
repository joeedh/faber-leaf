/**
 * Headless / scripted test harness for the NW.js shell.
 *
 * Driven by CLI args read from `nw.App.argv` (see `app_argv.ts`); the launcher
 * `nwjs/launch.mjs` / `nwjs_boot.ts` passes them after the app dir.
 * Lets a build/CI step boot the *real* app, build a deterministic scene
 * (notably one containing a sculptcore-backed `LiteMesh`), optionally run a
 * tool, then save a `.wproj`, dump a backend-comparable JSON snapshot, grab a
 * screenshot, and/or quit — all without clicking through the UI.
 *
 * This is the orchestration layer for documentation/plans/native-electron.md:
 * the same scene can be built under the WASM backend today and the native
 * N-API backend later, and the dumps diffed for parity (Workstream F).
 *
 * Recognized flags (renderer side):
 *   --gen-scene <name>      build a registered test scene (see test_scenes.ts),
 *                           replacing the default startup file (non-cached)
 *   --scene-arg k=v         (repeatable) parameters passed to the builder
 *   --eval "<js expr>"      (repeatable) eval JS in global scope (CTX/_appstate
 *                           reachable) after scene build, before --run tools
 *   --run "tool.path(...)"  (repeatable) run a ToolOp by data-API path
 *   --save <out.wproj>      write a project file after building
 *   --dump <out.json>       write a structured scene dump (for parity diffs)
 *   --screenshot <out.png>  capture the #webgl canvas (best-effort)
 *   --backend native|wasm   record the requested sculptcore backend
 *   --list-scenes           print the registered scene names and quit
 *   --exit                  quit the app once the scenario completes
 *   --apptest-crash         (temp) call sculptcore_node.crashTest() after boot to
 *                           verify Crashpad writes a symbolizable *.dmp. NOT
 *                           --crash-test: that is a real Chromium switch NW.js
 *                           intercepts (breakpoints the browser process), like
 *                           --headless. See crashpad.md.
 *
 * Nothing here runs unless one of these flags is present, so a normal launch
 * (`pnpm run nwjs`) is unaffected.
 */

import {getAppArgv, getArg, getArgList, hasArg} from './app_argv'
import {genDefaultFile} from './gen_default_file'
import {getDefaultSceneBuilder, setDefaultSceneBuilder} from './default_file'
import {getTestScene, listTestScenes, TestSceneArgs} from './test_scenes'
import type {ToolContext} from './context'
import type {Library} from './lib_api'
import type {Scene} from '../scene/scene'
import {peekAppState} from './app_instance'

const TAG = '[apptest]'

// Minimal view of AppState — avoids importing the heavy AppState type and the
// circular imports that come with it.
interface AppStateLike {
  ctx: ToolContext & {api?: {execTool: (ctx: unknown, path: string) => void}; scene?: Scene}
  datalib: Library
  saveHandle: unknown
  createFile(args?: Record<string, unknown>): ArrayBuffer
  loadFile(buf: ArrayBuffer): void
}

function appstate(): AppStateLike {
  return peekAppState() as unknown as AppStateLike
}

function nodeRequire(): ((m: string) => unknown) | undefined {
  return (globalThis as {require?: (m: string) => unknown}).require
}

function writeFile(path: string, data: Uint8Array | string): void {
  const req = nodeRequire()
  if (!req) throw new Error('node fs unavailable (not running under NW.js)')
  const fs = req('fs') as {writeFileSync: (p: string, d: Uint8Array | string) => void}
  fs.writeFileSync(path, data)
}

/** Read a file as an ArrayBuffer (for `--load`). */
function readFileBuffer(path: string): ArrayBuffer {
  const req = nodeRequire()
  if (!req) throw new Error('node fs unavailable (not running under NW.js)')
  const fs = req('fs') as {readFileSync: (p: string) => {buffer: ArrayBuffer; byteOffset: number; byteLength: number}}
  const b = fs.readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

export interface HarnessOptions {
  genScene?: string
  sceneArgs: TestSceneArgs
  evals: string[]
  runTools: string[]
  load?: string
  save?: string
  dump?: string
  screenshot?: string
  backend?: string
  listScenes: boolean
  exit: boolean
  crashTest: boolean
  active: boolean
}

export function parseHarnessArgs(argv: string[] = getAppArgv()): HarnessOptions {
  const sceneArgs: TestSceneArgs = {}
  for (const pair of getArgList('scene-arg', argv)) {
    const eq = pair.indexOf('=')
    if (eq > 0) sceneArgs[pair.slice(0, eq)] = pair.slice(eq + 1)
  }

  const opts: HarnessOptions = {
    genScene: getArg('gen-scene', argv) || undefined,
    sceneArgs,
    evals     : getArgList('eval', argv),
    runTools  : getArgList('run', argv),
    load      : getArg('load', argv) || undefined,
    save      : getArg('save', argv) || undefined,
    dump      : getArg('dump', argv) || undefined,
    screenshot: getArg('screenshot', argv) || undefined,
    backend   : getArg('backend', argv) || undefined,
    listScenes: hasArg('list-scenes', argv),
    exit      : hasArg('exit', argv),
    crashTest : hasArg('apptest-crash', argv),
    active    : false,
  }

  opts.active = !!(
    opts.genScene ||
    opts.evals.length ||
    opts.runTools.length ||
    opts.load ||
    opts.save ||
    opts.dump ||
    opts.screenshot ||
    opts.listScenes ||
    opts.crashTest
  )
  return opts
}

/** Rebuild the startup file using a named test-scene builder (non-cached). */
function buildScene(name: string, sceneArgs: TestSceneArgs): boolean {
  const builder = getTestScene(name)
  if (!builder) {
    console.error(`${TAG} unknown scene "${name}". Known: ${listTestScenes().join(', ')}`)
    return false
  }

  const app = appstate()
  app.saveHandle = undefined

  // Temporarily route core's default-scene hook at our builder, then run the
  // normal non-cached file init (dont_load_startup=1 skips the localStorage
  // startup snapshot so the scene is exactly what the builder produced).
  const prev = getDefaultSceneBuilder()
  setDefaultSceneBuilder((ctx: ToolContext, lib: Library, scene: Scene) => builder(ctx, lib, scene, sceneArgs))
  try {
    genDefaultFile(app as unknown as Parameters<typeof genDefaultFile>[0], 1)
  } finally {
    setDefaultSceneBuilder(prev)
  }
  console.log(`${TAG} built scene "${name}"`, sceneArgs)
  return true
}

// Minimal structural view of the IWasmInterface bits the geometry dump needs.
// Read off the LiteMesh's own `.wasm` field so `scripts/core` stays free of any
// sculptcore import (the layering rule). `HEAPU8` present ⇒ WASM (zero-copy heap
// view); absent ⇒ native (read `gpu::Buffer.data` through `pointerBytes`).
interface DumpWasm {
  HEAPU8?: {buffer: ArrayBufferLike}
  gpu: Record<string, unknown>
  getBoundVector(name: string, vec: unknown): ArrayLike<unknown>
  pointerBytes?(bound: unknown, member: string, byteLen: number): Uint8Array | undefined
}
interface DumpBuffer {
  size: number
  elemsize: number
  name?: string
  data?: number
}

/** A backend-comparable float32 signature of one GPU buffer's contents. */
function bufferSignature(wasm: DumpWasm, buf: DumpBuffer): Record<string, unknown> {
  const floatCount = (buf.size | 0) * (buf.elemsize | 0)
  const bytes = floatCount * 4
  let u8: Uint8Array | undefined
  if (wasm.HEAPU8 !== undefined) {
    u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data as number, bytes)
  } else if (bytes > 0) {
    u8 = wasm.pointerBytes?.(buf, 'data', bytes)
  }
  const sig: Record<string, unknown> = {size: buf.size | 0, elemsize: buf.elemsize | 0, floatCount}
  if (!u8 || u8.length < bytes) {
    sig.empty = true
    return sig
  }
  const f = new Float32Array(u8.buffer, u8.byteOffset, floatCount)
  let sum = 0
  let sumAbs = 0
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < f.length; i++) {
    const v = f[i]
    sum += v
    sumAbs += Math.abs(v)
    if (v < min) min = v
    if (v > max) max = v
  }
  // Strided sample so the signature also catches per-element divergence the
  // aggregates could cancel out, without dumping every float of a 120³ cube.
  const sample: number[] = []
  const stride = Math.max(1, Math.floor(f.length / 32))
  for (let i = 0; i < f.length; i += stride) sample.push(f[i])
  return {...sig, sum, sumAbs, min, max, sample}
}

/**
 * Structured, backend-comparable snapshot for native↔WASM parity diffing
 * (Workstream F). For each LiteMesh it captures: scalar mesh counts, the spatial
 * leaf count (topology), and a float32 signature of every populated GPU vertex
 * buffer keyed by name (geometry) — the bulk-data seam that WASM reads off the
 * heap and native reads via `pointerBytes`. The construction is deterministic, so
 * the two backends produce a diffable-equal dump (see litemesh_test_scene.ts).
 */
function dumpScene(): unknown {
  const app = appstate()
  const scene = app.ctx.scene
  const objects: unknown[] = []

  for (const ob of scene?.objects ?? ([] as Iterable<Record<string, unknown>>)) {
    const data = (ob as {data?: Record<string, unknown>}).data
    const entry: Record<string, unknown> = {
      name    : (ob as {name?: string}).name,
      dataType: data ? data.constructor.name : undefined,
    }

    // LiteMesh exposes a sculptcore WasmMesh on `.mesh`; pull whatever scalar
    // counts it offers without assuming a specific API (guarded).
    const mesh = data?.mesh as Record<string, unknown> | undefined
    if (mesh) {
      const counts: Record<string, unknown> = {}
      for (const key of ['vertexCount', 'faceCount', 'edgeCount', 'cornerCount', 'triCount']) {
        try {
          const v = (mesh as Record<string, unknown>)[key]
          if (typeof v === 'number') counts[key] = v
          else if (typeof v === 'function') counts[key] = (v as () => unknown).call(mesh)
        } catch {
          /* not available on this backend */
        }
      }
      entry.mesh = counts
    }

    // Geometry + topology signature (backend-agnostic; read via the LiteMesh's
    // own `.wasm` interface so core never imports sculptcore). Vertex `co` isn't
    // JS-readable on native, so the comparable geometry is the filled GPU vertex
    // buffers — exactly the bytes the renderer uploads.
    const spatial = data?.spatial as {update?: (gpu: unknown) => void; leaves?: () => unknown} | undefined
    const wasm = data?.wasm as DumpWasm | undefined
    if (spatial && wasm) {
      try {
        const gpu = wasm.gpu
        spatial.update?.(gpu)
        const buffersVec = (gpu as {buffers?: unknown}).buffers
        const buffers =
          wasm.HEAPU8 !== undefined
            ? (buffersVec as ArrayLike<DumpBuffer>)
            : (wasm.getBoundVector('', buffersVec) as ArrayLike<DumpBuffer>)
        const sigs: Record<string, unknown> = {}
        for (let i = 0; i < (buffers.length | 0); i++) {
          const buf = buffers[i]
          if (!buf || !(buf.size | 0) || !(buf.elemsize | 0)) continue
          const name = (typeof buf.name === 'string' && buf.name) || `buf${i}`
          sigs[name] = bufferSignature(wasm, buf)
        }
        entry.gpuBuffers = sigs
        // Spatial leaf count — a topology signal independent of geometry.
        try {
          const leaves = spatial.leaves?.()
          const lv = wasm.HEAPU8 !== undefined ? (leaves as ArrayLike<unknown>) : wasm.getBoundVector('', leaves)
          entry.leafCount = lv?.length | 0
        } catch {
          /* leaves() not available */
        }
      } catch (err) {
        entry.gpuBuffersError = String(err)
      }
    }

    objects.push(entry)
  }

  // Datalib material shader-graphs, keyed by lib_id — lets the headless harness
  // observe the node-editor ToolOps (node.add_node / node.delete_selected /
  // node.toggle_select_all in editors/node/) mutate `library.material[id].graph`
  // without needing a rendered mesh object. Duck-typed so core stays free of the
  // material import.
  const materials: {libId: number; nodeCount: number}[] = []
  try {
    const matSet = (app.datalib as {material?: Iterable<{lib_id?: number; graph?: {nodes?: {length?: number}}}>})
      .material
    if (matSet) {
      for (const m of matSet) {
        if (m.graph?.nodes && typeof m.graph.nodes.length === 'number') {
          materials.push({libId: m.lib_id ?? -1, nodeCount: m.graph.nodes.length})
        }
      }
    }
  } catch {
    /* no materials in datalib */
  }

  return {
    backend    : (globalThis as {__SCULPTCORE_BACKEND?: string}).__SCULPTCORE_BACKEND ?? 'wasm',
    objectCount: objects.length,
    objects,
    materials,
    // Reflect the dynamic-attribute test driver's result if it ran (set by
    // litemesh_attrtest_support's `__attrtestApply`, invoked via `--eval`). Lets
    // the attr-render integration test assert the requested-attr contract +
    // missing-slot advisory alongside the GPU-buffer evidence in `objects`.
    attrtest       : (globalThis as {__attrtestResult?: unknown}).__attrtestResult,
    // Reflect the IUVSource conformance drivers (`__uvsourceLiteMesh` /
    // `__uvsourceLeafMesh`), keyed by source name. The suite is jest-free
    // because a provider is only reachable from inside the app, so the dump is
    // how its pass/fail list gets back out.
    uvsource       : (globalThis as {__uvsourceResult?: unknown}).__uvsourceResult,
    // Reflect the quad-remesh ToolOp driver (`__quadRemeshTest`): before/after/
    // undone/redone topology fingerprints, so the parity test asserts success +
    // undo/redo round-trip per backend alongside the remeshed GPU-buffer parity.
    quadRemesh     : (globalThis as {__quadRemeshResult?: unknown}).__quadRemeshResult,
    // Reflect the shader-graph JSON round-trip driver (`__attrtestRoundtrip`),
    // proving nstructjs JSON is an adequate test-fixture format for
    // AttributeNode-carrying materials (M7 "test format" decision).
    attrRoundtrip  : (globalThis as {__attrtestRoundtripResult?: unknown}).__attrtestRoundtripResult,
    // Reflect the brush-behavior driver (`__brushTest`): scripted strokes at
    // the sphere poles, diffing GPU position/color buffers to assert invert,
    // draw-sharp boundedness, mask gating, brush.color, and accumulate flags.
    brushtest      : (globalThis as {__brushTestResult?: unknown}).__brushTestResult,
    // Reflect the sculpt-layer driver (`__layerTest`): a LAYERDRAW stroke on a
    // fresh sculpt layer — displacement, post-stroke position checksum (the
    // wasm↔native bit-parity gate), and the one-undo residual.
    layertest      : (globalThis as {__layerTestResult?: unknown}).__layerTestResult,
    // Reflect the V2 edit-target driver (`__layerTargetTest`): ordinary
    // brushes sculpting into a targeted layer, fold + weight round-trips,
    // toolstack/MeshLog undo consistency, dyntopo + kelvinlet under a target.
    layertargettest: (globalThis as {__layerTargetTestResult?: unknown}).__layerTargetTestResult,
    // Reflect the VDM engine driver (`__vdmTest`): one vdm splat dab at the +Z
    // pole — texels touched, tile count, atlas checksum (the wasm↔native
    // bit-parity gate), layout ints, and the positions-unchanged proof.
    vdmtest        : (globalThis as {__vdmTestResult?: unknown}).__vdmTestResult,
    // Reflect the boundary-constraint driver (`__boundaryTest`): seam-marking
    // via ToolOp + strokes with/without dyntopo, asserting the polyline-graph
    // invariants (non-2-valence verts, components) and both undo stacks.
    boundarytest   : (globalThis as {__boundaryTestResult?: unknown}).__boundaryTestResult,
    // Reflect the undo-memory driver (`__undoMemTest`): per-step MeshLog byte
    // accounting, calcUndoMem parity, redo-branch truncation, and the
    // toolstack limitMemory trim freeing C++ steps via onUndoDestroy/freeStep.
    undomemtest    : (globalThis as {__undoMemTestResult?: unknown}).__undoMemTestResult,
    // Reflect the autosave driver (`__autosaveTest`): random dyntopo strokes for
    // ~5s with two randomly-timed split-serialization autosaves, each read back
    // and validated (container framing + geometry-signature round-trip).
    autosavetest   : (globalThis as {__autosaveTestResult?: unknown}).__autosaveTestResult,
    // Reflect the fuzz driver (`__fuzzTest`): random sculptcore strokes with
    // random dyntopo toggles, a replayable per-stroke log, and a non-finite scan
    // (hunts the intermittent dyntopo crash).
    fuzztest       : (globalThis as {__fuzzTestResult?: unknown}).__fuzzTestResult,
    // Reflect the GPU-brush parity driver (`__gpuBrushTest`): CPU-vs-GPU
    // kelvinlet stroke fingerprints, undo/redo fidelity, and shadow-verify
    // divergences (plans/gpuGlobalBrushes.md §8.2-8.4).
    gpubrushtest   : (globalThis as {__gpuBrushTestResult?: unknown}).__gpuBrushTestResult,
    // Generic seam for ad-hoc `--eval` checks: whatever an eval expression
    // stores on globalThis.__evalTestResult lands in the dump (renderer
    // console output never reaches the harness stdout, so the dump is the
    // only way an eval can report back without a bespoke support module).
    evalResult     : (globalThis as {__evalTestResult?: unknown}).__evalTestResult,
  }
}

async function pumpFrames(n: number): Promise<void> {
  const w = globalThis as unknown as {
    updateDataGraph?: (f?: boolean) => void
    redraw_viewport?: (reset?: boolean) => void
  }
  w.updateDataGraph?.(true)
  const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
  for (let i = 0; i < n; i++) {
    w.redraw_viewport?.(i === 0)
    await raf()
  }
}

async function captureScreenshot(path: string): Promise<void> {
  await pumpFrames(30)
  const canvas = peekAppState()?.glCanvas
  if (!canvas) {
    console.error(`${TAG} no #webgl canvas to screenshot`)
    return
  }
  // toDataURL can come back blank for a GPU canvas without preserveDrawingBuffer;
  // this is best-effort. The robust path is `node nwjs/cdp.mjs shot <out>` over
  // the CDP endpoint (see --remote-debug).
  const url = canvas.toDataURL('image/png')
  const bin = atob(url.slice(url.indexOf(',') + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  writeFile(path, bytes)
  console.log(`${TAG} wrote screenshot ${path}`)
}

async function quit(): Promise<void> {
  try {
    // NW.js: quit the whole app directly (no main process / IPC needed).
    const nw = (globalThis as {nw?: {App?: {quit(): void}}}).nw
    if (nw?.App) {
      nw.App.quit()
      return
    }
  } catch (err) {
    console.warn(`${TAG} nw.App.quit failed, falling back to window.close`, err)
  }
  window.close()
}

/** Entry point — called from entry_point.js once the app instance is mounted. */
export async function runTestHarness(argv: string[] = getAppArgv()): Promise<void> {
  const opts = parseHarnessArgs(argv)

  if (opts.backend) {
    // entry_point.js already set this from --backend before the first loadWasm
    // (the authoritative point); re-asserting here is harmless and documents intent.
    ;(globalThis as {__SCULPTCORE_BACKEND?: string}).__SCULPTCORE_BACKEND = opts.backend
    if (opts.backend !== 'wasm' && opts.backend !== 'native') {
      console.warn(`${TAG} unknown backend "${opts.backend}"; expected "wasm" or "native"`)
    }
  }

  if (opts.crashTest) {
    // Crashpad self-test: build the litemesh scene so sculptcore_node is loaded,
    // then call its crashTest() export, which null-derefs INSIDE sculptcore.
    // Crashpad catches the access violation and writes a minidump whose faulting
    // stack is in sculptcore_node — verifying end to end that the CodeView PDB
    // symbolicates native frames. The dump lands in NW.js's default Crashpad dir
    // (NW.js 0.112 has no setCrashDumpDir); read it with sculptcore/crash/dump.mjs.
    // NOTE: the flag is --apptest-crash, NOT --crash-test (a real Chromium switch
    // NW.js intercepts, like --headless). See documentation/plans/crashpad.md.
    const req = nodeRequire()
    buildScene('litemesh-cube', {})
    let addon: {crashTest?: () => void} | undefined
    for (const p of [
      'sculptcore/build/native-node/sculptcore_node.node',
      '../sculptcore/build/native-node/sculptcore_node.node',
    ]) {
      try {
        addon = req?.(p) as {crashTest?: () => void}
        if (addon?.crashTest) break
      } catch {
        /* try next candidate */
      }
    }
    console.log(`${TAG} --apptest-crash: scene built; calling native crashTest() in 1s (addon=${!!addon})`)
    setTimeout(() => addon?.crashTest?.(), 1000)
    return
  }

  if (!opts.active && !opts.exit) return

  const result: Record<string, unknown> = {ok: true}

  try {
    if (opts.listScenes) {
      result.scenes = listTestScenes()
      console.log(`${TAG} scenes: ${listTestScenes().join(', ')}`)
    }

    if (opts.genScene) {
      result.builtScene = buildScene(opts.genScene, opts.sceneArgs) ? opts.genScene : null
    }

    if (opts.load) {
      // Round-trip the deserialization path: load a `.wproj` (e.g. one written
      // by an earlier `--save`), reconstructing LiteMesh geometry via its
      // STRUCT/loadSTRUCT (Mesh_deserialize). `--dump` then snapshots the result.
      const buf = readFileBuffer(opts.load)
      appstate().loadFile(buf)
      result.load = opts.load
      console.log(`${TAG} loaded project ${opts.load} (${buf.byteLength} bytes)`)
    }

    for (const expr of opts.evals) {
      try {
        // Indirect eval runs in global scope, where the `CTX` / `_appstate`
        // window globals are reachable — e.g.
        // `CTX.debug.showEditor({editorType:'MaterialEditor', minVisibleWidth:400})`.
        // Runs after the scene is built and before `--run` tools, so it can set
        // up editor state those tools need (many editor ToolOps gate on the
        // active editor type — see the CTX.debug guide in CLAUDE.md). Await the
        // result so an async driver (e.g. __autosaveTest's 5s stroke+save loop)
        // completes before --dump snapshots its reflected result.

        await (0, eval)(expr)
        console.log(`${TAG} eval ${expr}`)
      } catch (err) {
        console.error(`${TAG} eval failed: ${expr}`, err)
        result.ok = false
        result.error = String(err)
      }
    }

    for (const tool of opts.runTools) {
      try {
        appstate().ctx.api?.execTool(appstate().ctx, tool)
        console.log(`${TAG} ran ${tool}`)
      } catch (err) {
        console.error(`${TAG} tool failed: ${tool}`, err)
        result.ok = false
      }
    }

    if (opts.dump) {
      const data = dumpScene()
      writeFile(opts.dump, JSON.stringify(data, null, 2))
      result.dump = opts.dump
      console.log(`${TAG} wrote dump ${opts.dump}`)
    }

    if (opts.save) {
      const buf = appstate().createFile({save_screen: true, save_library: true, compress: false})
      writeFile(opts.save, new Uint8Array(buf))
      result.save = opts.save
      console.log(`${TAG} wrote project ${opts.save}`)
    }

    if (opts.screenshot) {
      await captureScreenshot(opts.screenshot)
      result.screenshot = opts.screenshot
    }
  } catch (err) {
    result.ok = false
    result.error = String(err)
    console.error(`${TAG} harness error`, err)
  }

  // Expose for external drivers (e.g. `nwjs/cdp.mjs eval` over CDP).
  ;(globalThis as {__apptestResult?: unknown}).__apptestResult = result
  console.log(`${TAG} done`, result)

  if (opts.exit) {
    // Let the final log/IO flush before tearing the process down.
    setTimeout(() => void quit(), 250)
  }
}
