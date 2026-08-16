# TODO — non-addon consumers of addon files

Tracking direct `scripts/**` → `addons/builtin/<id>/src/**` imports discovered
while doing the toolmodes-addons-refactor (plan §2/§3). These work today
(esbuild resolves by path) but violate the layering promise of plan §3.2 —
core/non-addon code should reach addon content through `@addon/<id>/api` or
runtime registries, not through path imports.

Promote depcruise warn → error (plan §4) only after these are cleaned up,
otherwise CI will explode.

## mesh addon consumers (still-outstanding from plan §3)

- `scripts/core/context.ts:8` — `import type {Mesh} from '../../addons/builtin/mesh/src/mesh.js'` (type-only; cheapest fix is `DataBlock`)
- `scripts/core/lib_api.ts:8` — `import type {Mesh} from '../../addons/builtin/mesh/src/mesh.js'` (type-only)
- `scripts/core/missing_addon.ts:29` — runtime `import {CustomDataElem} from '../../addons/builtin/mesh/src/customdata.js'` — needs runtime registry lookup
- `scripts/addon/addon_base.ts` — multiple direct imports of mesh subsurfaces (see plan §3; this file was partially slimmed during the mesh_edit move but mesh/customdata/bvh/etc. still re-exported from here)

## mesh_edit consumers (from PR mesh_edit move)

- `scripts/editors/view3d/view3d.ts:34` — `import '../../../addons/builtin/mesh_edit/src/mesheditor'` (side-effect, ensures the toolmode registers). Refactored from `./tools/mesheditor` when mesh_edit moved.
- `scripts/editors/view3d/tools/curvetool.ts:6` — `MeshToolBase` import (this file is *itself* moving into the curve addon below, so this becomes intra-addon when curve moves).

## curve addon consumers (this work)

After `scripts/curve/*` and `curvetool*.ts` move into `addons/builtin/curve/src/`:

- `scripts/camera/camera.ts:15` — `import type {CurveSpline}` (type-only; safe but layered-improper).
- `scripts/hair/strand_types.js:1` — `import {CurveSpline}` — **runtime**, `Strand extends CurveSpline`. Class-extends requires a static reference; can't be moved to runtime lookup without restructuring Strand. Either:
  - hair eventually becomes its own addon depending on curve, or
  - curve's class surface is exposed via a runtime accessor and Strand is recast as composition rather than inheritance.
- `scripts/data_api/api_define.ts:40` — `import {CurveSpline}` — runtime; used to register the CurveSpline data API. Could move to an `api_register` hook on the addon's register() call. (Now also covered by the "Data API `defineAPI` registry" section below.)
- `addons/builtin/mesh/src/mesh_types.ts:348` — `import {KnotDataLayer}` — runtime, but this is **mesh addon → curve addon**. Currently mesh has no manifest dep on curve. Either:
  - mesh declares `dependencies: ['curve']` and reaches it via `@addon/curve/api` (creates a base-curve-then-mesh ordering), or
  - the `KnotDataLayer` CustomData type is registered via a runtime hook from the curve addon's register() (curve depends on mesh, registers its CustomData class into mesh's registry on load).
  The latter is the more idiomatic dependency-injection direction — mesh shouldn't know what KnotDataLayer is.

## Data API `defineAPI` registry — addon class decoupling ✅ DONE

The `defineAPI` refactor flipped `getDataAPI()` to iterate `dataAPIRegistry`
(see `documentation/plans/api-define-defineapi-refactor.md`). Core
`scripts/data_api/api_define.ts` no longer imports `addons/builtin/*`:

- The builtin-addon classes (`Mesh`, `Vertex`, `Element`, `CurveSpline`,
  `BVHSettings`) are registered by the inversion bridge
  `addons/builtin/builtin_data_api.ts`, imported for its side effects from
  `scripts/entry_point.js` (runs before `getDataAPI`) and from
  `tools/gen-datapaths.mjs`'s entry shim (the catalog generator never boots
  addons). The bridge reaches *up* into the dependency-free registry leaf
  (`scripts/data_api/api_define_registry.ts`) rather than core reaching *down*.
- The `ctx.mesh` struct is fetched by stable name via
  `api.getStructByName('mesh.Mesh')` (path.ux), and the Scene selectMask
  `regenElementsDraw` call duck-types instead of `instanceof Mesh`, so core
  holds no static reference to the Mesh class.
- **External (non-builtin) addons** register their own data-API classes through
  the `register(api)` lifecycle hook: `addon_base.ts`'s `register(cls)` now has a
  DataBlock/SceneObjectData branch that calls `registerDataAPI(cls)` and
  live-defines the class against the running API (since `getDataAPI` is one-shot
  and runs before addons start). A shared define-guard in the registry leaf
  (`isDataAPIDefined`/`markDataAPIDefined`) prevents double-defining a class the
  build pass already handled.

## Non-addon side-effect imports (registration triggers)

Some core-side files contain `import '…/addons/builtin/<id>/src/…'` purely
for the side effect of running `ToolMode.register(…)` / `nstructjs.register(…)`
at module load. These are the wiring points for the in-bundle (registerInternalAddon)
pattern. Should be reviewed during plan §4 cleanup to see if the
`scripts/entry_point.js` block can absorb them all:

- `scripts/entry_point.js` — `import '../addons/builtin/{mesh,subsurf,mesh_edit}/src/addon_register.js'`
- `scripts/editors/view3d/view3d.ts:34` — `import '../../../addons/builtin/mesh_edit/src/mesheditor'`

## Cross-addon path imports (still violate @addon/<id>/api boundary)

After the `@framework/api` rewrite, cross-addon refs remained hard-coded to
`scripts/...` paths because the target class is announced by another addon
but actually lives in the main bundle (pre-extraction):

- ~~`addons/builtin/mesh/src/mesh_ops.ts` — `import {BVHToolMode} from '../../../../scripts/editors/view3d/tools/pbvh.js'` used only for an `instanceof` check.~~
  **RESOLVED in P5** (delete the TS sculpting stack). `pbvh.ts` is gone; the
  symmetry-axis gather now tests `instanceof PaintToolModeBase` imported from
  `@framework/api`. That is option (a) in spirit — the check is against the
  shared stroke-toolmode base every sculpt/paint toolmode derives from, not
  against a concrete addon class — and it no longer crosses a layer boundary.

## lite-mesh → shadernodes coupling (renderengine-sculptcore integration)

The dynamic-attribute integration introduced a runtime dependency from the
lite-mesh layer onto the shader-node layer:

- `scripts/lite-mesh/litemesh.ts:23` — runtime `import {LightGenWgsl} from
  '../shadernodes/shader_lib_wgsl'` (plus type-only `RequestedAttrDesc` /
  `IRenderLights`). LiteMesh builds its fallback draw shader from the shared
  WGSL light-gen helper so the sculpt batch and material path agree on lighting.
  Both are core `scripts/` (not addons), so this doesn't cross the `@addon`
  boundary — but it is a new layer edge (lite-mesh now depends on shadernodes).
  Acceptable for now; revisit if either becomes an addon. See
  [documentation/shader-attributes.md](documentation/shader-attributes.md).
- **Pre-existing (not from this work):** opening the `MaterialEditor` while a
  `LiteMesh` object is active throws `invalid path library.object[N].data` from
  `_MaterialEditor.buildHeader → updatePath` — the editor header binds the active
  object's `.data` mesh path, which a LiteMesh datablock doesn't satisfy. The
  node-graph render path (`_recalcLines`, AttributeNode `buildUI`) is unaffected.
  Fix when LiteMesh gains a proper data-API surface for the editor header.

## WebGPU debug-capture coverage

The FBO debug editor's WebGPU path (`scripts/editors/debug/webgpu_debug.ts`)
only captures `render_final` today because the WebGPU draw path
(`scripts/editors/view3d/view3d_draw_webgpu.ts`) is the MVP that draws
straight to the canvas — it has no `RenderTarget`-based per-pass
intermediates yet. The WebGL counterpart
(`renderengine_realtime.ts:686–705`) iterates a full `rendergraph` and
captures each `FBOSocket` output (`NormalPass_fbo`, `AccumPass_fbo`,
`OutputPass_fbo`, etc).

Action when the WebGPU render graph lands (the TODO referenced in
`view3d_draw_webgpu.ts`'s `drawSceneWebGpu` comment block): at each
WGSL render-pass encode site, call
`getWebGpuDebug(device).pushTexture(passName, target.colors[0].handle, encoder)`
before the encoder is submitted. The debug editor's history dropdown
populates from the same registry, so new entries surface automatically.

## native-electron: de-numbering / Workstream C+D

See [documentation/plans/native-electron.md](documentation/plans/native-electron.md).
The native N-API backend keeps real `void*`s in C++, so JS must stop assuming a
sculptcore handle is a `number` / a WASM-heap offset. A gated, opt-in seam exists
(`sculptcore/typescript/api/nativeBackend.ts` + the `nativeBackendRequested()`
branch in `wasm.ts`); it detects the addon and falls back to WASM. The boundary
sites to make backend-agnostic before native can actually run the app:

- `sculptcore/typescript/api/wasm.ts` — `Mesh_createCube` / `Mesh_buildSpatialTree`
  / `SpatialTree_free` extract a numeric `.ptr` (`as unknown as number`) and call
  `manager.getBoundPointer(name, ptr)`. WASM-specific factories; the native backend
  needs its own (the addon does **not** yet export `Mesh_createCube` etc. — they
  live in the WASM Embind glue, not the binding system).
- ~~`scripts/editors/view3d/tools/sculptcore_ops.ts:183` —
  `manager.getBoundVector(name, nodes.ptr)`.~~ **Done.** Now calls the
  backend-agnostic `wasm.getBoundVector(name, nodes)` on `IWasmInterface`
  (opaque `SculptHandle`, not a number): WASM unwraps the numeric `.ptr`
  internally, native forwards the wrapper. `typescriptRuntime` untouched.
  Verified natively over CDP (Mesh → SpatialTree → `getBoundVector(leaves)`
  → length 2, iterates).
- ~~`scripts/lite-mesh/litemesh.ts` `rayCast()` — uses `wasm._rawAlloc`, `HEAPF32`,
  `F32SHIFT`, `ptr >> shift`.~~ **Done.** Now passes the ray endpoints as bound
  `float3`s via the `wasm.float3([...])` ring (both backends marshal the
  reference-arg wrapper's address; native keeps the pointer in C++), and the
  `CastRayIsect` disposer moved into a `finally` (guarded — native GC-finalizes,
  so the disposer is absent) which also fixed a pre-existing leak on the hit
  path. WASM-verified over CDP (ray hits the spherized cube at z≈0.5, correct
  normal, zero console errors).
- `sculptcore/typescript/api/gpuExecutor.ts` — ✅ **native bulk-data path wired.**
  `bufferBytes(buf, bytes)` now branches: WASM keeps the zero-copy
  `new Uint8Array(HEAPU8.buffer, buf.data, bytes)` (byte-identical, re-verified
  rendering litemesh-cube over CDP); native reads `gpu::Buffer.data` through the
  addon's new `pointerBytes(buf, 'data', bytes)` (pointer stays in C++; a copy
  under the V8 sandbox). The WASM-numeric `.ptr` cache key is replaced by
  `bufferKey(buf)` — WASM `.ptr`, native `objectAddress(buf)` (the C++ address as
  an opaque identity key, never dereferenced). Verified end-to-end at the
  addon/C++ level by the Electron smoke test (`tree.update(gpu)` → 2 populated
  vertex buffers → `pointerBytes` returns the correct-length, real-data view;
  `objectAddress` stable). **In-app native GPU rendering still blocked on the
  litemesh native scene** (rayCast HEAP rework, below) — that's what actually
  drives `gpuExecutor.dispatch` natively. Same inline `HEAPU8` pattern still in
  `scripts/webgl/batch.ts` and `scripts/webgpu/batch.ts`.
- ~~`scripts/editors/view3d/tools/sculptcore_ops.ts` `execBrush(..., boundNodes, ...)`
  — passed the `getBoundVector` inspection proxy (native-only, not napi-unwrappable).~~
  **Done.** Now passes the bound Vector (`nodes`, the `constructWith` result),
  which is unwrappable on both backends. The native sculpt-stroke primitives
  (`constructWith` with pointer args, enum/pointer method+member marshalling,
  `makeNodeVector`) + `NativeManager.get/findVectorClass/constructWith` shims
  landed in sculptcore so the stroke code is backend-agnostic. Verified in the
  live app on both backends (12 DRAW dabs → ~0.9-unit bulge, native `rayCast`
  confirms, screenshot-verified, WASM no regression).

Workstream C is functionally landed: `NativeManager` presents the
`construct`/`getBoundVector`/`constructWith`/`get`/`findVectorClass` surface
without the WASM heap, `loadWasm`'s native branch returns a real
`IWasmInterface`, the native litemesh scene builds + renders + sculpts in-app,
and the wired native `gpuExecutor`/WebGPU path executes per-frame. Workstreams E
(Electron→42, parent `f80e5ff`) and F (native↔WASM parity test
`tests/integration/sculptcore_parity.test.ts`, parent `eb99ca0`) are done. The
only open item is the deferred boot-GC identity cache (`Map<void*, napi_ref>`),
a non-blocking lifetime watch-item (see native-electron.md).
