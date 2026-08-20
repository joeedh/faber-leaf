# Debug surface (for live debugging via CDP)

This is a quick map of what an agent can reach from a renderer-realm eval — a
page `evaluate` (browser build) or `node nwjs/cdp.mjs eval "<js>"` over the CDP
endpoint (NW.js build, `--remote-debug`) — when debugging the **browser build**
or the **NW.js build**. Everything below lives in the page realm and is present
once the app has booted (`appstate.init()` has run).

See also: the **Debug context API (`CTX.debug`)** and **NW.js test harness**
sections of [../CLAUDE.md](../CLAUDE.md), and
[native-electron-test-harness.md](native-electron-test-harness.md)
for the headless `--eval`/`--run` flags.

## Entry globals (the roots)

| Global | What it is | Source |
|---|---|---|
| `CTX` | `getAppState().ctx` — the **active** instance's live `ViewContext`. Lazy getter on `window`. **Primary entry point.** | `mount.ts` (`installConsoleShortcut`) |
| `_appstate` | Deprecated alias to the **first-mounted** instance. Prefer `CTX` or `getAppState()`; see [embedding.md §5](./embedding.md). | `mount.ts` (`mountFaberLeaf`) |
| `_framework` | `globalThis._framework` — the framework API hub addon bundles look up. | `entry_point.js:1` |
| `DEBUG` | `cconst.DEBUG` — path.ux debug-toggle flags (see below). | path.ux `config/const.ts:192` |
| `redraw_all()` | Schedules a `requestAnimationFrame` redraw of the active instance. | `appstate.ts` (`initProcessGlobals`) |
| `updateDataGraph(force?)` | Re-execs the active instance's dependency graph (`force=true` runs synchronously). | `appstate.ts` (`initProcessGlobals`) |
| `haveNwjs` | Truthy in the NW.js shell. | `entry_point.js` |
| `__SCULPTCORE_BACKEND` | `'native'`/`'wasm'` backend selector (set early). | `entry_point.js:82` |
| `__apptestResult` | Where the `--eval` harness records eval success/failure. | `test_harness.ts:451` |
| `FILE_LOADING` | True while a `.wproj` is loading. | `appstate.ts` |
| `FeatureFlags` | The `FeatureFlagManager` singleton — `get`/`set`/`reset` runtime feature flags (persisted; `set` saves immediately, so restore in probes). | `feature-flag.ts` |
| `_print_evt_debug` | Set true ~100ms after init; gates verbose event logging. | `entry_point.js:131` |

## `CTX.debug` — `DebugEditorAPI` (`scripts/core/context.ts:407`)

The purpose-built reflection / automation surface:

- `CTX.debug.listEditorTypes()` — every registered editor's `define()` metadata,
  with `flag` decoded to `AreaFlags` names and `icon` resolved to its `Icons` key.
  Use it to discover valid `editorType` values.
- `CTX.debug.getIconKey(icon)` — reverse-lookup an icon number → `Icons` name.
- `CTX.debug.showEditor({editorType, minVisibleWidth, minVisibleHeight?})` —
  ensure an editor of that type is open and at least that size, swapping a
  suitable on-screen area (already-visible → PropsEditor → any non-viewport →
  3D viewport) and making it active. `editorType` takes an areaname/apiname/
  tagname string, an Editor class, or an instance. Returns
  `{editor, action, swappedOutEditor?}`.
  - ⚠️ Needs a laid-out screen — fine in browser/Playwright and windowed
    NW.js, but **can crash a bare headless boot**.

`showEditor` is the way to satisfy ToolOps that read the **active editor**. The
node-graph ops (`node.*`, `editors/node/node_ops.ts`) read `ctx.editor` in their
static `invoke`: when it's a `NodeEditorBase` subclass they auto-fill the op's
`nodeEditorPath` (used e.g. by `useNodeEditorGraph=1`, which copies the editor's
current graph path). The only *registered* such editor is `MaterialEditor`
(areaname `MaterialEditor`, the Shader Editor); `NodeEditorBase` is abstract and
intentionally unregistered. Pass an explicit `graphPath`/`graphClass` and these
ops run with **no editor open** (what `tests/integration/node_editor_ops.test.ts`
does); use `showEditor` only when the op must follow the *editor's* graph.

## `CTX` (ViewContext) — live state by getter

- State: `scene`, `object`, `mesh`, `material`, `light`, `tetmesh`,
  `strandset`/`strandset_object`, `selectedObjects`, `camera`, `activeTexture`,
  `toolmode`, `playing`, `modalFlag`.
- Plumbing: `api`, `toolstack`, `datalib`, `graph`, `screen`, `state`.
- Editors: `view3d`, `propsbar`, `menubar`, `resbrowser`, `debugEditor`,
  `shaderEditor`, `nodeViewer`, `editors` (named map), `editor`/`area` (active).

## `CTX.api` — data-path / ToolOp layer (path.ux `DataAPI`)

The most powerful surface for driving/inspecting the app headlessly:

- `CTX.api.execTool(CTX, "tool.path(args)")` — run any registered ToolOp
  (undoable). This is what `--run` and the harness use.
- `CTX.api.getValue(CTX, path)` / `CTX.api.setValue(CTX, path, val)` — read/write
  any catalogued data path (see `scripts/data_api/generated/API_PATHS.md`).
- `CTX.api.resolvePath(CTX, path)` — resolve a path string to struct/prop/object.
- `CTX.api.getToolDef(toolpath)` / `CTX.api.createTool(CTX, path, inputs)` —
  introspect a tool's inputs/outputs or build one without executing.

## `window.DEBUG` — path.ux runtime toggles (`config/const.ts:156`)

Flip live to enable diagnostic logging without a rebuild: `paranoidEvents`,
`screenborders`, `areaContextPushes`, `allBordersMovable`, `doOnce`,
`modalEvents`, `areaConstraintSolver`, `datapaths`, `lastToolPanel`, `domEvents`,
`domEventAddRemove`, `debugUIUpdatePerf`, `screenAreaPosSizeAccesses`,
`buttonEvents`. App-side code reads extra keys off the same object: `DEBUG.gl`,
`DEBUG.simplemesh`, `DEBUG.DataLink`, `DEBUG.THREE`.

## `window.DEBUG.gpuBrush` — GPU brush strokes (also `CTX.debug.gpuBrush`)

Installed lazily on the first GPU-brush stroke attempt
(`scripts/editors/view3d/tools/sculptcore_gpu_stroke.ts`); full guide in
[gpuBrushes.md](gpuBrushes.md). Highlights, all CDP-reachable:

- `state()` — live session dump: kernel, elem/filter counts, dab generation,
  the last dab's brush/ctx uniform blobs as hex (layout bugs show here first).
- `forceReadback()` — sync the CPU mesh from the GPU buffers mid-stroke so
  vert dumps / bounding boxes / buffer-signature helpers see live GPU state.
- `capture(n)` / `lastFixture` — record strokes as `tests/webgpu/replay.mjs`
  fixtures (bit-exact Dawn replays).
- `scatterSelfCheck()` / `selfCheckNext` + `lastSelfCheck` — scattered-VBO vs
  CPU-gather byte check (fill-order regression tripwire).
- `allowNonModal` — let non-modal (execTool-driven, i.e. headless) strokes
  take the GPU path; `verbose` — per-dab `[gpu-brush]` logging;
  `shadowDivergences` — shadow-verify breach counter.

The related feature flags (`sculptcore.gpu_brush`, `.gpu_brush_grab`,
`.gpu_brush_verify`) are flippable at runtime via `window.FeatureFlags`.

## `_appstate` — the first instance, directly

`_appstate.ctx`, `.screen`, `.toolstack` (`.undo()`/`.redo()`/`.execTool()`),
`.datalib` (`.get(lib_id)`, `.graph`), `.api`, `.arguments`, `.draw()`,
`.createFile()`, `.modalFlag`, `.container`, `.glCanvas`.

There can be more than one app instance on a page now, and `_appstate` only ever
names the first. The registry is the general form:

```js
import {mountedInstances} from './build/entry_point.js'   // every instance, in mount order
CTX.state                                                 // the active one
```

Anything that used to find the 3D canvas with `document.getElementById('webgl')`
should read `state.glCanvas` — a fixed id finds the wrong instance's canvas as
soon as a second one mounts. See [embedding.md](./embedding.md).

## Caveats / gaps

- **No GPU id-buffer / pick-buffer debug API** — picking is geometric and
  addon-owned (the old `GPUSelectBuffer`/`FindnearestClass` are gone), so there's
  no GPU-readback hook to inspect.
- **Headless boot is the fragile path**: `--eval` reaches `CTX`/`_appstate`, but
  anything needing a laid-out screen (`showEditor`, most editor accessors) can
  crash a windowless boot. Use browser/Playwright or a windowed NW.js over CDP
  (`nwjs/cdp.mjs`) for those; in bare headless prefer reflection or
  explicit-`graphPath` ops.
- **CDP `Runtime.evaluate` serializes return values** (structure-clone), so returning
  a live `CTX.mesh` gives a flattened view — return primitives / hand-picked
  fields (counts, ids, bbox), not whole live objects.
- **Never throw on the bulk-data seam natively** — a throw there is swallowed as a
  `drawObjects` warning and silently aborts the render pass; don't probe a
  not-yet-filled buffer in a way that throws.
