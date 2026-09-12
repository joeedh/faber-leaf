# Headless stroke tests

How to drive sculpt brush strokes from a headless integration test and assert on
the result. Strokes are the main way to exercise the sculptcore engine
(brushes, dyntopo, undo) end-to-end, so most engine regressions are caught here.

See also: the harness flag reference in
[native-electron-test-harness.md](native-electron-test-harness.md), the debug
surface map in [debugSurface.md](debugSurface.md), and the worked tests under
`tests/integration/` (`sculptcore_brushes.test.ts`, `sculptcore_stroke_tester.test.ts`).

## The boot model

The integration tests boot the **real app** under NW.js, headlessly, once per
backend. `--apptest-headless` is **not** Chromium's true `--headless`: the window
is a *hidden but real* 1400×900 window (`show:false`), so it lays out a screen
(a default `View3D` with a valid `view3d.size`/camera) and **WebGPU is available**
(the chromium-args enable it). That means a headless test can render, read GPU
vertex buffers, raycast the viewport, and drive the full UI op path — not just
low-level engine calls.

The canonical invocation (see `runBrushTest` / `runStrokeTester` in the tests):

```
nw <repo-root> --apptest-headless --no-devtools \
   --backend wasm|native \
   --gen-scene litemesh-cube --scene-arg subdiv=48 \
   --eval "<driver JS>" \
   --dump out.json --exit
```

`--gen-scene` builds a deterministic scene; `--eval` runs JS in the renderer
global scope (where `_appstate`, `CTX`, `window.*` live) **after** the scene is
built; `--dump` writes a JSON snapshot; `--exit` quits. Resolve the `nw`
executable via the `nwjs/` workspace (`require('nw').findpath()`), and **self-skip**
when the app bundle (`build/entry_point.js`) or — for the native leg — the N-API
addon (`sculptcore/build/native-node/sculptcore_node.node`) is missing.

## Two stroke drivers

Pick based on what you're testing. Both live in
`scripts/editors/view3d/tools/sculptcore_ops.ts`.

| | `runSculptcoreStroke` / `_testSculptcoreStroke` | `window._sculptcoreStrokeTester` |
|---|---|---|
| dab input | **world-space** `{p, normal}` dabs | **normalized screen** points `[x,y]` (0..1) |
| path | low-level: builds the brush + executor directly | the **real `SculptPaintOp`** via `BrushStrokeDriver` |
| needs view3d / toolmode | no | yes (raycasts the viewport; needs sculpt mode active) |
| undo | meshlog only | full toolstack entry (`undo()`/`redo()`) |
| use when | testing brush/kernel/dyntopo math in isolation | testing the op pipeline: sampling, raycast, mirroring, undo |

`__brushTest` uses the low-level driver (deterministic world-space dabs at the
sphere poles). `sculptcore_stroke_tester.test.ts` uses the high-level one to
prove the op path works headless.

### Driving the real op path

`_sculptcoreStrokeTester.runStroke({points, radius, symmetryAxes?, sculptTool?,
brushSettings?, brush?})` needs the **sculpt tool mode active** (its `applyDab`
casts `ctx.toolmode` to `SculptCorePaintMode`). Activate it and frame the mesh
first:

```js
_appstate.ctx.scene.switchToolMode('sculptcore')
const t = window._sculptcoreStrokeTester
t.frameMeshInCamera()                 // so normalized points hit the surface
const res = await t.runStroke({points: [[0.42,0.5],[0.5,0.5],[0.58,0.5]], radius: 150})
await t.undo(); await t.redo()        // real toolstack undo/redo
```

`runStroke`, `undo` and `redo` return promises: the toolstack serializes every
operation behind a lock and runs it asynchronously, so an `--eval` driver that
reads the mesh after a stroke has to `await` (wrap the script in an
`(async () => { ... })()` and return the promise — the harness awaits it).

## Reporting a result back

Two ways for an `--eval` driver to get data into the `--dump` JSON:

1. **Generic seam (no app code):** store anything on `globalThis.__evalTestResult`;
   it lands in the dump as `evalResult`. Best for a small, self-contained driver —
   the whole test logic lives in the `--eval` string.
2. **Bespoke support module:** define `globalThis.__myTest()` in an app module
   (side-effect imported in `entry_point.js`), set `globalThis.__myTestResult`,
   and reflect it in `scripts/core/test_harness.ts` (add a `myTest:
   (globalThis as ...).__myTestResult` line). Use when the driver is large or
   reused (`__brushTest` → `brushtest`, `__boundaryTest` → `boundarytest`).

The `--eval` runs in global scope, so it can only reach **globals** — no `import`.
`SculptTools` etc. aren't global; omit `sculptTool` to get the default (CLAY), or
pass `brushSettings`. Throwing inside the eval is recorded by the harness, but
catching and reporting structured fields gives better assertions.

## Measuring geometry change

- **GPU position buffer** (backend-agnostic): the only way to read per-vertex
  positions on the native backend (raw `co` isn't JS-readable there). Refresh via
  `spatial.update(gpu)`, then read every `position`-named buffer and concatenate
  (it's split per batch). See `readGpuBuffer`/`diffMetrics` in
  `scripts/lite-mesh/litemesh_brushtest_support.ts` — reuse those for displacement
  metrics (moved count, mean along/perpendicular to the dab normal).
- **Bounding box** (`mesh.getBoundingBox()`): a coarse but simple, backend-agnostic
  signal for "geometry changed / undo restored it" when you don't need per-vertex
  detail. `_sculptcoreStrokeTester.runStroke` already refreshes the tree, and
  `undo()` refreshes bounds, so before/after/undo/redo bbox snapshots round-trip.
- **MeshLog step size** (`meshLog.stepMemSize(tool.logStepId)`): `>0` proves the
  stroke recorded undo data, i.e. it actually mutated the mesh.

## Asserting per backend

Run both backends and assert on each (`describe.each(['wasm','native'])`), so a
regression on one path can't hide behind the other. The native leg self-skips if
the addon is absent. Always assert *no NaN/Inf* in the final position buffer when
you read it.

## Driving GPU brush strokes headlessly

The GPU path (documentation/gpuBrushes.md) is drivable through the same two
drivers once three switches are set:

```js
FeatureFlags.set('sculptcore.gpu_brush', true)       // (+ 'sculptcore.gpu_brush_grab' for grab)
DEBUG.gpuBrush.allowNonModal = true                  // execTool strokes are non-modal
// ... run the stroke (either driver) ...
await globalThis.__gpuBrushCompletion                // the finish is mapAsync-bearing
```

The debug surface installs on the first GPU stroke *attempt* — a throwaway
stroke with the flag on suffices before `allowNonModal` exists. Awaiting
`__gpuBrushCompletion` before reading buffers is mandatory: the final
readback + `endStep` land asynchronously on the stroke's serialized chain.
Also wait for the renderer's device before the first GPU stroke — the
harness `--eval` fires before the async WebGPU init, and an absent device
silently falls back to the CPU path (RAF-poll
`getActiveWebGpuContext()?.device`; see `litemesh_gpubrush_test_support.ts`).

- **Strict parity** belongs on the world-space driver: its dabs marshal
  identically on both paths. The screen-space driver's CPU pass raycasts
  progressively deformed geometry while the GPU pass sees the stroke-start
  surface (D4), so its end-to-end diff carries real input drift — bound it,
  don't fp-compare it.
- **Shadow-verify** (`sculptcore.gpu_brush_verify`) is the identical-input
  bit-level gate: CPU authoritative, GPU diffed per dab
  (`DEBUG.gpuBrush.shadowDivergences`).
- `__gpuBrushTest()` (litemesh_gpubrush_test_support.ts) packages all of the
  above — parity/undo/shadow/self-check/fixture — and reflects into the
  `--dump` as `gpubrushtest`; `tests/integration/sculptcore_gpu_brush.test.ts`
  is the worked example.
- `--eval` runs a bare expression (indirect eval): `return X` is a
  SyntaxError there — that convention belongs to `nwjs/cdp.mjs eval`, which
  wraps its input in a function. Promises returned by the expression ARE
  awaited.

## Gotchas

- **Rebuild the bundle** (`node tools/esbuilder.js`, or `pnpm build`) after editing
  any TS the test exercises — the harness loads `build/entry_point.js`, not your
  source.
- **`showEditor` can crash the bare headless boot** — that caveat is about
  dynamically instantiating/swapping *editor areas*, not the default viewport.
  The default `View3D` + sculpt toolmode work headless (this guide's whole point).
- A native C++ crash mid-stroke is captured as a Crashpad minidump — see
  [plans/crashpad.md](plans/crashpad.md).
