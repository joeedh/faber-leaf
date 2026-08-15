# Sculptcore ↔ TypeScript App Integration Report

How the Faber Leaf TypeScript/JS app integrates the `sculptcore`
C++20 sculpting engine. The engine lives in the `sculptcore/` submodule; its
binding surface is the workspace package `@sculptcore/api`
(`sculptcore/typescript/`), which the app (`scripts/`, `@sculptcore/frontend`)
depends on as `workspace:*`.

The whole integration follows a single principle: **one interface, two
backends.** All app-side code talks to `IWasmInterface`. An Emscripten/WASM
backend serves the browser; a native N-API `.node` addon serves the NW.js
desktop shell. Nothing above the seam knows which backend is live.

Governing design docs: [native-napi-electron.md](native-napi-electron.md),
[native-electron-test-harness.md](native-electron-test-harness.md),
[plans/native-electron.md](plans/native-electron.md).

---

## 1. The backend abstraction seam — `IWasmInterface`

**File:** `sculptcore/typescript/api/wasm.ts`

`IWasmInterface` (`wasm.ts:295`) is the single surface app code consumes. It
composes:

- **`INeededWasm`** (from `@litestl/typescript-runtime`) — the low-level runtime
  contract: heap accessors, `LSTL_*` allocator introspection, method-invoke
  helpers.
- **`IWasmMethods`** (`wasm.ts:16`) — the raw C-export surface: factory
  free-functions and pointer-level exports (`Mesh_createCube`,
  `Mesh_makeUVSphere`, `Mesh_buildSpatialTree`, `serializeMesh`/`deserializeMesh`,
  `IntVector_assign`, the VDM/Multires seams, `setTreeRequestedAttrs`).

On top of the raw methods `IWasmInterface` adds the **backend-agnostic wrappers**
the app actually calls: `getBoundVector`, `setBoundIntVector`,
`Mesh_serialize`/`Mesh_deserialize`, the `GpuBrush_*` stroke seam, and
native-only optional members (`pointerBytes?`, `vectorFloatView?`,
`objectAddress?`). It also carries the `manager: BindingManager` and
`gpu: GPUManager` fields plus `float3`/`float2` cache-ring helpers.

The opaque handle type is `SculptHandle = object` (`wasm.ts:213`) — **never read
`.ptr` as a number.** On WASM a handle wraps a numeric `.ptr`; on native it is a
`napi_wrap`'d C++ object.

### Construction & backend selection — `loadWasm()` (`wasm.ts:520`)

```
loadWasm():
  if nativeBackendRequested():                 # nativeBackend.ts:359
      native = loadNativeAddon()               # nativeBackend.ts:331
      if native:
          nm   = buildNativeManager()          # nativeManager.ts:436
          wasm = makeNativeInterface(nm)        # nativeManager.ts:449
          return wasm
      # else warn + fall through to WASM
  mod  = await import(insideNode ? '../build/sculptcore.js'
                                 : '../build/sculptcore-browser.js')
  _wasm = await mod.default({wasmMemory: createWasmMemory()})
  initialWasm = createWasmHelpers(_wasm, mod.default)
  _wasm.initBindings()
  managerPtr = _wasm.getBindingManager()
  manager = new WasmBindingManager(initialWasm, managerPtr); manager.load()
  gpu = manager.construct('sculptcore::gpu::GPUManager')
  wasm = { ...initialWasm, manager, gpu, <backend-agnostic wrappers> }
```

`getWasm()` / `getWasmImmediate()` (`wasm.ts:1090`, `:1101`) are the app-facing
accessors over a cached singleton promise; `globalThis.getWasm` is exposed for
the console.

**Where `--backend native|wasm` is decided** — three layers:

1. **CLI flag** parsed by the renderer harness `scripts/core/test_harness.ts`;
   it sets `globalThis.__SCULPTCORE_BACKEND`. It must be set early in
   `scripts/entry_point.js`, **before the first `loadWasm()`**.
2. **`nativeBackendRequested()`** (`nativeBackend.ts:359`): true only when
   `insideDesktopShell` (keyed off `process.versions.nw || .electron`) **and**
   `__SCULPTCORE_BACKEND === 'native'`.
3. **`loadNativeAddon()`** (`nativeBackend.ts:331`): `require()`s the `.node`,
   trying `globalThis.__SCULPTCORE_NODE_PATH` then a `CANDIDATES` list
   (`sculptcore/build/native-node/sculptcore_node.node`, …). Returns `undefined`
   in the browser (no `require`), so the browser path is **always** WASM.

### The two backends side by side

- **WASM backend** — `wasm` is `initialWasm` (Emscripten module +
  `createWasmHelpers`) plus wrapper closures (`wasm.ts:592`–1086). Pointers are
  32-bit `number`s internally; each wrapper unwraps `(handle).ptr` and re-wraps
  returned pointers via `manager.getBoundPointer(...)`. Reflection is a JS
  re-implementation over linear memory; bulk reads are true zero-copy
  `new Uint8Array(HEAPU8.buffer, ptr, len)`.
- **Native N-API backend** — `makeNativeInterface(nm)` (`nativeManager.ts:449`)
  returns a plain object literal whose keys **match the `IWasmInterface` member
  names**, so it is a drop-in. It wraps a `NativeManager` (`nativeManager.ts:55`)
  wrapping a `NativeAddon` (the `.node`'s exported surface). `gpu` is a lazy
  getter so boot never constructs `GPUManager`. WASM-heap fields (`HEAPF32`,
  `_rawAlloc`, …) are intentionally absent — nothing reads them on native.

---

## 2. Loading & initialization

**WASM path** (`wasm.ts:552`): dynamic-imports the Emscripten glue —
`../build/sculptcore.js` in Node, `../build/sculptcore-browser.js` in the
browser (two separate emscripten link outputs, see §6). Instantiates with an
explicit `createWasmMemory()` (shared memory for the pthread pool). Then:
`initBindings()` (populates the C++ reflection registry) → `getBindingManager()`
→ `new WasmBindingManager(...).load()` → construct `GPUManager` → build two
1024-entry `cachering`s of `float2`/`float3` for the `wasm.float3(...)` helper.

The browser Emscripten build is `-sMODULARIZE=1 --bind` and runs a pthread pool;
workers self-spawn via `new Worker(new URL('sculptcore-browser.js', ...))`, which
is why that glue chunk must keep a stable, unhashed name (see esbuild note in
§6).

**Native path:** `require()` is synchronous — no async module load. At addon init
`source/napi/napi_entry.cc` (`Init`) calls the *same* `initBindings()`,
constructs one process-lifetime `NapiRuntime`, and `installExports(exports)`.
`loadWasm` then just assembles `makeNativeInterface`.

**Loader plumbing in `scripts/`:** `getWasmImmediate()` is consumed directly in
the `LiteMesh` constructor (`litemesh.ts:1046`), i.e. LiteMesh assumes wasm is
already loaded. Backend args come from `nw.App.argv` via
`scripts/core/app_argv.ts` + `scripts/core/test_harness.ts`.

---

## 3. Data-model bridge — LiteMesh ↔ C++ mesh

**File:** `scripts/lite-mesh/litemesh.ts`

`LiteMesh extends SceneObjectData` (`:452`) is the app-side datablock, but the
**geometry lives entirely in C++**. The TS object only holds opaque handles:

- `mesh!: WasmMesh` (`:938`) — the `sculptcore::mesh::Mesh` handle
- `spatial!: SpatialTree` (`:939`), `wasm: IWasmInterface` (`:940`), draw batches

The C++ mesh and tree are created in `_initSpatial()` (`:1066`):
`Mesh_buildSpatialTree(mesh, 1024, 32, gpuTriTarget)` → `spatial.update(gpu)` →
`getDrawBatch()`. The constructor default is `Mesh_createCube(2, 1.0, 1.0)`.

**Pointer discipline.** Handles always flow through backend-agnostic helpers; app
code never reads a raw pointer. E.g. `rayCast` (`:1908`) marshals endpoints as
bound `float3`s via `wasm.float3([...])` rather than poking `HEAPF32`; `castRay`
takes them by reference so native keeps the pointer in C++.

**Out-params — `_intVecOut()`** (`:2566`): bound `Vector<T>` params are out-params
only across the binding, so to *receive* computed index sets the app constructs
an empty bound `Vector<int>` and reads it back:

```ts
const cls  = manager.findVectorClass('int32')
const ctor = cls.findDefaultConstructor()
const vec  = manager.constructWith(ctor)                        // empty Vector<int>
const read = () => wasm.getBoundVector(cls.buildFullName(), vec) // array-like view
return {vec, read}
```

There is a `_floatVecOut()` sibling (`:2577`). ~20 call sites use these:
screen-circle/rect picking, shortest-path, loop select, `gatherMovableVerts`,
boundary-graph stats, etc. The inbound direction (JS array → C++ Vector) is
`setBoundIntVector` / the `IntVector_assign` export (`wasm.ts:602`,
`nativeManager.ts:123`) — this backs `MeshLog.selectIndices`.

**Reflection runtime — `sculptcore/source/napi/napi_runtime.{h,cc}`.** The C++
port of the WASM-side TS runtime; it reads `litestl::binding` descriptors and
dereferences real `void*`s. Key machinery:

- `NapiRuntime` (`.h:30`) holds the `napi_env`, `BindingManager*`, and two caches:
  `classRefs_` (one JS class per struct, keyed by `buildFullName()` so
  `Vector<T,N>` specializations don't collide) and `arrayClassRefs_` (one class
  per (element, length) for inline fixed arrays like `float3.vec`).
- A **bound object** = an instance of `getBoundClass(st)` with a prototype
  accessor per `StructMember` and a method per `Method`. `napi_wrap` attaches
  `struct Wrapped { void* ptr; const _StructBase* st; bool owning; }` — the
  `void*` is never exposed.
- **Member get/set** computes `ptr + member.offset` and switches on binding type
  (Number→number, Int64→BigInt, Pointer/Reference→dereference+recurse, embedded
  Struct→non-owning wrapper).
- **Methods** — `methodInvoker` marshals JS args (`marshalArg`: Number/Enum/Bool
  →typed slot; Pointer→`void*`; Reference/by-value struct→the bound object's
  address), calls the descriptor's `MethodThunk`, marshals the return.
- **Construction/lifetime:** `construct(name)` = 0-arg owning ctor;
  `constructWith(structName, ctorName, ...args)` = named parameterized ctor (e.g.
  `CommandExecutor "main"(SpatialTree*, Brush*)`); `makeNodeVector` /
  `makeIntVector` / `makeFloatVector` mint the three empty-Vector out-param
  specializations (recovered from a method's return/param descriptor because they
  can't be looked up by element type). Owning instances carry a GC finalizer and
  a deterministic `[Symbol.dispose]`.
- **Fixed inline arrays** (`float3.vec`) are wrapped as a real
  `napi_define_class` instance indexing `base + i*elemSize` straight into C++
  memory — no ArrayBuffer, so writes survive the V8 sandbox.
- **V8 sandbox caveat:** `vectorView` / `pointerBytes` cannot return zero-copy
  external ArrayBuffers under NW.js — they fall back to a one-shot **copy**. Hence
  the bulk-data seam (`bufferBytes` / `bufferKey` / `objectAddress`) and the rule
  "never throw on the bulk-data seam."

`litestl::util::String` is special-cased (reads `char*` at offset 0) so `buf.name`
works for GPU-buffer↔shader-slot matching.

---

## 4. Brush / stroke flow — TS → sculptcore

Bridge files: `scripts/editors/view3d/tools/sculptcore_bindings.ts`,
`sculptcore_ops.ts`, `sculptcore.ts`; engine handle
`sculptcore/typescript/sculptcore/brush/CommandExecutor.ts`.

**Tool → kernel map: `TOOL_TO_SCULPTBRUSH`** (`sculptcore_bindings.ts:145`) — a
`Partial<Record<SculptTools, SculptBrushes>>` mapping the TS `SculptTools` enum to
the engine `SculptBrushes` kernel enum (DRAW→DRAW, SMOOTH→BSMOOTH,
CLAY/SCRAPE/FILL→their kernels, GRAB→GRAB, …). Tools absent from the map are
skipped with a warning; the sculpt toolmode's `defineAPI` filters the picker to
mapped tools only. `toolToSculptBrush()` (`:174`) resolves it.

**Entry from the UI:** `SculptCorePaintMode.on_mousedown` (`sculptcore.ts:858`)
copies the brush, loads dyntopo defaults, and runs the ToolOp `sculptcore.paint()`
with `{brush, symmetryAxes}`.

**Per-stroke setup — `builSculptcoreBrush({...})`** (`sculptcore_bindings.ts:359`):
constructs (or reuses) a bound `sculptcore::brush::Brush`
(`manager.construct('sculptcore::brush::Brush')`), syncs every scalar/flag member
(strength, radius, invert, pinch, cavity automask, enhance, plane/wing/falloff via
`configureToolUniforms`), and builds the executor:

```ts
const st   = manager.get('sculptcore::brush::CommandExecutor')
const ctor = st.findConstructor('main')!
wasmExec = manager.constructWith(ctor, mesh.spatial, wasmBrush)  // CommandExecutor
wasmExec.setNeighborMode(1)  // CSR ring-1 cache
```

Pen dynamics: `configureBrushDynamics` maps TS `BrushDynamics` channels →
C++ prop-ids, baking per-kernel uniform manifests into 32-sample curves; per-dab
device samples are pushed by `pushBrushDeviceInputs`.

**Per-dab program — `buildBrushProgram(...)`** (`sculptcore_bindings.ts:210`):
builds a `BrushProgram` (main command + optional chained BSMOOTH autosmooth) via
`prog.addCommand`, `prog.setCommandFloat`, `prog.setCommandInvert`,
`prog.setCommandAttrLayer` (paint tools point the kernel's attr handle at the
active layer). DynTopo params are copied onto a bound `DynTopoParams` by
`configureDynTopoParams`.

**Execution — `SculptPaintOp`** (`sculptcore_ops.ts`):
- `exec.beginStep(hasDyntopo)` opens a MeshLog undo step before the first dab.
- `applyDabOne` (`:423`) per dab: resolve dyntopo-due, push device inputs,
  `buildBrushProgram`, resolve plane/grab/stroke-dir, then either the GPU branch
  (`GpuStrokeController`) or the CPU
  `wasmExec.applyDab(prog, float3(center), float3(normal), filterRadius, params,
  seed)`.
- `executor.endStep()` closes the step.

`CommandExecutor` (generated handle) exposes `beginStep`/`endStep`,
`execBrush(mesh, brushType, nodes, origin, normal)`,
`execProgram(prog, nodes, origin, normal)`, `applyDab(...)`, and the
`new (SpatialTree, Brush)` "main" ctor. At the C++ level (`source/brush/`)
`execBrush` walks `SpatialNode`s and runs the compiled kernel; `createCommand()`
dispatches the `SculptBrushes` enum to the matching generated factory
(`kernels/generated/<name>.brush.gen.h`).

Headless scripted strokes go through `runLiteMeshBrushTest`
(`scripts/lite-mesh/litemesh_brushtest_support.ts`), exercising the same
`builSculptcoreBrush` → `buildBrushProgram` → `applyDab` path.

**GPU brush seam** — a parallel path:
`GpuBrush_beginStroke/marshalDab/data/applyCo/endStroke` on `IWasmInterface`
(`wasm.ts:419`–470), backed by `source/brush/gpu_brush_c_api.cc` (native: the
`gpuBrush*` addon exports, session handle = napi external).

---

## 5. Serialization — LiteMesh round-trip + nstructjs

LiteMesh mesh bytes are **produced by C++** and carried through nstructjs as
opaque blobs. The STRUCT (`litemesh.ts:453`, via `nstructjs.inlineRegister`):

```
litemesh.LiteMesh {
  _data          : arraybuffer(byte) | this.serialize();
  repairLog      : array(string);
  _displayColorMode : int;
  _vdmData       : arraybuffer(byte) | this.serializeVdm();
  _mrData        : arraybuffer(byte) | this.serializeMultires();
  _mrLevels      : int | this.multiresLevels;
  _mrActiveLevel : int | this.multiresLevel;
}
```

The `field | this.method()` form means the serialized value is produced by calling
that method at save time (`arraybuffer(byte)` stores the returned `Uint8Array`).
The `VertexData`/`EdgeData`/… STRUCTs are empty shells — the real data is the C++
blob.

**Save — `serialize()`** (`:1856`): returns `wasm.Mesh_serialize(persistMesh)`, a
versioned, **lz4hc-compressed** blob (`serial::writeMesh` / `SCULPT00` header).
Two optimizations:
- **Autosave split path:** when a deferred-blob collector is active, hand it a
  `Mesh_serializeRaw(persistMesh)` (uncompressed columns) and return only an
  8-byte `makeBlobPlaceholder` inline; the autosave worker (`scripts/util/lz4.ts`)
  compresses off-thread, reproducing the container byte-for-byte.
- **Cache mode:** an unchanged mesh (keyed by `meshRevision`) reuses `_blobCache`.

`serializeVdm()` → `VdmStore_serializeBlob`; `serializeMultires()` folds the
active level back then `Multires_storeBlob`.

**Load — `loadSTRUCT(reader)`** (`:876`): after `reader(this)`, if `_data` has
bytes, resolve any autosave placeholder, then
`this.mesh = wasm.Mesh_deserialize(data)`, `mesh.repairMesh()` (the bound
`validateAndRepair`), `_initSpatial()`, clear `_data`. Multires/VDM blobs are
rebuilt/re-attached. `newSTRUCT()` passes `deferInit=true` so the ctor skips the
throwaway default cube.

The `Mesh_serialize`/`Mesh_deserialize` wrappers marshal the heap themselves:
WASM via `serializeMeshHeap` copying out of `HEAPU8`; native via
`meshSerialize`/`meshDeserialize` copying into a sandbox ArrayBuffer.

> ⚠️ Known gap (per `native-electron-test-harness.md`): LiteMesh's scene-level
> `.wproj` round-trip was still being wired at the harness's writing — hence the
> procedural / `--gen-scene` test scenes.

---

## 6. Build integration

**Driver:** `sculptcore/make.mjs` (a yargs CLI under `node configureEnv.mjs`).
Build dirs: WASM → `build/`, native lib → `build/native/`, node addon →
`build/native-node/`.

**WASM build** (`build [wasm]`):
- `deleteFinalWasmFiles()` first removes `build/sculptcore*.{js,wasm}` (emcc can
  silently succeed on compile errors otherwise).
- `sbrushCodegen()` then `cmake --build` (configured `-DBUILD_WASM=ON`). Link:
  `-sMODULARIZE=1 --bind` + `-sEXPORTED_FUNCTIONS` collected from the CMake
  `WASM_SYMBOLS` global property.
- Produces **two glue variants**: `sculptcore.{js,wasm}` (Node) and
  `sculptcore-browser.{js,wasm}` (browser), both copied into `typescript/build/`,
  then `cd tools && pnpm build` regenerates the TS bindings.

**Node addon build** (`build node`, `buildNodeAddon`):
- cmake-js drives configure (`-r nw`) to download NW.js N-API headers + `node.lib`;
  `provisionNwjsCache` pre-populates cmake-js's cache from `dl.nwjs.io` (the S3
  mirror 404s).
- `cmake --build build/native-node --target sculptcore_node` builds only the addon
  MODULE target (root `CMakeLists.txt` gates on `DEFINED CMAKE_JS_VERSION`), entry
  `source/napi/napi_entry.cc`, clang toolchain. Output:
  `build/native-node/sculptcore_node.node`; the PDB is archived for Crashpad.
  `--smoke` loads it in a hidden NW.js window via `source/napi/napi_smoke.cjs`.

**App build (esbuild) — `tools/esbuilder.js`:**
- Copies `sculptcore/typescript/build/sculptcore-browser.{js,wasm}` into the app
  `build/` under a stable **unhashed** name (the pthread pool self-references
  `sculptcore-browser.js` by URL). `.wasm` uses the `copy` loader.
- Marks `*/build/sculptcore.js` (Node glue) **external** so the browser bundle
  never pulls it in — the `insideNode` branch in `wasm.ts:552` is dead code in the
  browser bundle.
- `@sculptcore/api` resolves via the pnpm workspace, not an esbuild alias.
- The `.node` addon is **not** bundled — it's `require()`d at runtime from
  `build/native-node/` by `loadNativeAddon`.

Net landing spots: `build/sculptcore-browser.{js,wasm}` (browser),
`build/native-node/sculptcore_node.node` (require'd by NW.js), and
`sculptcore/typescript/build/` (staging copies esbuild reads).

---

## 7. The "4-place change" for a new N-API method

To surface a new native method, thread it through four layers (documented in
`native-napi-electron.md`):

1. **C++ export** — implement the static callback in
   `sculptcore/source/napi/napi_runtime.{h,cc}` and register it in
   `installExports` via `define(exports, "<name>", &NapiRuntime::<Cb>)`.
2. **`NativeAddon` type** — add the signature to the `NativeAddon` interface in
   `sculptcore/typescript/api/nativeBackend.ts` (typed view of the raw addon).
3. **`NativeManager` method** — add a method on `NativeManager`
   (`sculptcore/typescript/api/nativeManager.ts`) calling `this.addon.<name>(...)`.
4. **`makeNativeInterface` entry** — the easy-to-forget one: add the property to
   the object literal `makeNativeInterface` returns, which is what the app
   consumes as `IWasmInterface`.

Name the manager/interface entry to match the corresponding WASM
`INeededWasm`/`IWasmMethods` member (`LSTL_*`, `Mesh_*`, …) so both backends stay
true drop-ins. (On the WASM side the equivalent is added to
`IWasmMethods`/`IWasmInterface` in `wasm.ts` and wired to an Embind/C export.)

---

## Key file map

| Concern | Files |
|---|---|
| Interface seam / backend select | `sculptcore/typescript/api/wasm.ts`, `nativeBackend.ts`, `nativeManager.ts` |
| C++ N-API runtime | `sculptcore/source/napi/napi_runtime.{h,cc}`, `napi_entry.cc`, `napi_smoke.cjs` |
| Data model | `scripts/lite-mesh/litemesh.ts` |
| Brush bridge | `scripts/editors/view3d/tools/sculptcore_bindings.ts`, `sculptcore_ops.ts`, `sculptcore.ts`; `sculptcore/typescript/sculptcore/brush/CommandExecutor.ts` |
| Build | `sculptcore/make.mjs`, `tools/esbuilder.js` |
| Docs | `documentation/native-napi-electron.md`, `native-electron-test-harness.md`, `plans/native-electron.md` |

---

## Architecture at a glance

```
         app code (scripts/, @sculptcore/frontend)
                        │  talks only to
                        ▼
                 IWasmInterface  (wasm.ts:295)
                 ┌──────┴───────┐
        WASM backend        Native backend
   (browser, pthreads)   (NW.js desktop shell)
   sculptcore-browser.js    sculptcore_node.node
   linear-memory ptr=number  napi_wrap'd C++ objects
   zero-copy heap views      sandbox-copy bulk reads
                 └──────┬───────┘
                        ▼
              sculptcore C++20 engine
         (Mesh, SpatialTree, Brush/CommandExecutor,
          MeshLog undo, DynTopo, Multires, VDM, GPU brush)
```
