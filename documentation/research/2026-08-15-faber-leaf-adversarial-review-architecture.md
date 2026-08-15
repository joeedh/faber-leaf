# Adversarial review — architecture & sequencing (Faber Leaf refactor)

> Verbatim report from the architecture/sequencing pressure-test agent run on
> 2026-08-15 against
> [documentation/plans/2026-08-15-0237-faber-leaf-refactor-strategy.md](../plans/2026-08-15-0237-faber-leaf-refactor-strategy.md)
> (§1–§8) and its §9 task list. Line/file references were verified by the agent
> at that commit; re-verify before acting on any of them in a later tree.

# Adversarial review: Faber Leaf refactor strategy

## Fatal or near-fatal problems

Ranked by impact. Each is something that makes a stated step impossible, or strands the tree in a state that does not boot.

---

### F1. The toolmode the strategy keeps inherits from the code W2 deletes

W2 ("delete the TS PBVH sculpting stack") is described at `C:/dev/webgl-app-framework/documentation/plans/2026-08-15-0237-faber-leaf-refactor-strategy.md:300` as *"leaf code with almost no inbound dependencies."* That is false in the most direct way possible.

- `C:/dev/webgl-app-framework/scripts/editors/view3d/tools/sculptcore.ts:22` — `import {PaintToolModeBase} from './pbvh_base'`. `SculptCorePaintMode` **extends** it.
- `C:/dev/webgl-app-framework/scripts/editors/view3d/tools/sculptcore_ops.ts:27,28` — `PaintSample` from `./pbvh_paintsample`, `SymAxisMap` from `./pbvh_base`
- `C:/dev/webgl-app-framework/scripts/editors/view3d/tools/sculptcore_bindings.ts:9`, `stroke_paint_op.ts:13,14`, `stroke_driver.ts:14`, `stroke_driver_native.ts:21` — all import `PaintSample` / `BrushProperty` / `PaintSampleProperty` / `PaintToolModeBase`.

`pbvh_base.ts` is 2,073 lines, `pbvh.ts` 2,584, `pbvh_paintsample.ts` 300 (verified by `wc -l`). These are not leaves; they are the inheritance and property-type root of the *surviving* sculptcore stack. The "~12K lines of pbvh" figure in the deletion budget is not deletable without first extracting a stroke-sample/brush-property base — which is a new workstream, not a `git rm`.

**Fix / resequencing:** insert a W2-0 that hoists `PaintSample`, `PaintSampleProperty`, `BrushProperty`, `SymAxisMap`, and the non-BVH half of `PaintToolModeBase` into a `stroke_base.ts` with no BREP imports, land it, *then* delete. Re-budget W2: the true leaf set is only `pbvh_sculptops.ts`, `pbvh_texpaint.ts`, `pbvh_texpaint_blur.ts`, `pbvh_ui.ts`, `pbvh_holefiller.ts`, `pbvh_bvhdef.ts`.

---

### F2. `missing_addon.ts` does not survive this. Old `.wproj` files crash on load *today*

§7 decision 3's entire file-compatibility position rests on this file. I traced the load path myself:

**(a) Hard crash.** `C:/dev/webgl-app-framework/scripts/core/lib_api.ts:1033` writes `this.libmap[blockType] = lib` for **every** BlockSet in the file, *before* the registered-type check at `:1041`. When no class has `typeName === 'mesh'`, `:1044-1046` does `this.libs.remove(lib); continue` — skipping `lib.afterLoad(this, type)` at `:1048`, which is the only thing that sets `lib.datalib`. The orphan stays in `libmap`. Then `C:/dev/webgl-app-framework/scripts/core/appstate.ts:806` does `datalib.getLibrary(dblock[0]).add(dblock[1], true)` with `dblock[0]` = the *file's* class name `'mesh'` (pushed at `appstate.ts:754`), reaching `BlockSet.push` at `lib_api.ts:615-617`:

```ts
if (block.lib_id === -1) {
  block.lib_id = this.datalib.idgen.next()   // this.datalib is undefined
}
```

TypeError. There is no guard on this path.

**(b) Even if you fix (a), the scene graph still breaks.** `MissingDataBlock.fromUnknownBlock` (`C:/dev/webgl-app-framework/scripts/core/missing_addon.ts:82-89`) stores `_origClsname`, `_origBytes`, `name`, `lib_type` — and **never parses the bytes**, so `lib_id` stays at the `DataBlock` ctor default of `-1` (`lib_api.ts:138`). `push()` then assigns a *fresh* id. The `SceneObject`'s `DataRef` still carries the original id, and `Library.get` resolves through the global `block_idmap[f.lib_id]` (`lib_api.ts:953-954`) → `undefined` → `C:/dev/webgl-app-framework/scripts/sceneobject/sceneobject.ts:413-416` silently substitutes `new NullObject()`. On the next save, `SceneObject.STRUCT` is `data : DataRef | DataRef.fromBlock(obj.data)` (`sceneobject.ts:258`) and `DataRef.fromBlock` on an un-added NullObject yields `lib_id = -1` (`lib_api.ts:439`). **The object→geometry association is destroyed permanently, even though the mesh bytes are still in the file.**

**(c) The bytes themselves do not round-trip either.** nstructjs struct ids are assigned by global registration order (`C:/dev/webgl-app-framework/vendor/nstructjs/src/struct_intern.ts:376`), written into the schema header (`:324`), and **embedded inside every `abstract(...)` payload** (`struct_intern2.ts:859-860`, `878-881`). `_origBytes` for a `mesh.Mesh` contains ids for `mesh.Vertex`, `mesh.UVLayerElem`, `mesh.CDElemArray`… Delete ~50 `mesh.*` registrations and every id from that point shifts; the preserved bytes now decode against different structs.

**(d) The CustomDataElem half of the net lives inside the addon being deleted.** `C:/dev/webgl-app-framework/scripts/core/missing_addon.ts:34-44` holds a `null` slot filled by `registerOpaqueCustomDataElem`, called from `C:/dev/webgl-app-framework/addons/builtin/mesh/src/missing_customdata.ts:44`. Delete the mesh addon and `opaqueCustomDataElemCls` is permanently `null`, so the branch at `missing_addon.ts:262` can never fire. `C:/dev/webgl-app-framework/scripts/addon/addon_base.ts:381` and `:520` likewise resolve `CustomDataElem` via `lookupAddonExport('mesh', 'mesh')`.

**(e) The keying test at `missing_addon.ts:262` is inverted.** It requires `clsname.includes('CustomData')`. The real elem struct names are `mesh.UVLayerElem`, `mesh.ColorLayerElem`, `mesh.MaskElem`, `mesh.FloatElem`, `mesh.IntElem`, `mesh.NormalLayerElem`, `mesh.Vector2/3/4LayerElem`, `mesh.OrigIndexElem` (`C:/dev/webgl-app-framework/addons/builtin/mesh/src/mesh_customdata.ts:18,105,194,248,327,391,458,568,638,712`) — **none contain the substring**. They fall through to the fallback at `:267-269` and are instantiated as `MissingToolMode`. Meanwhile `mesh.CustomDataLayer` (a layer *descriptor*) does match and gets an `OpaqueCustomDataElem`. Exactly backwards.

**(f) There is one test, and it does not test this file.** `C:/dev/webgl-app-framework/tests/integration/graph_missing_nodes.test.ts:8-13` states it cannot import `missing_addon.ts` and drives vendored nstructjs with synthetic classes instead. The intended tests are stubs that throw: `C:/dev/webgl-app-framework/tests/lib/scene-fixture.ts:14-19,22-47`.

**Fix / resequencing:** this is a workstream, not a decision. Minimum: recover `lib_id`/`name` from the block header out-of-band; make `getLibrary` tolerate unknown types; make struct ids file-pinned or rewrite ids inside `_origBytes` on save; extend the hooks to the non-abstract `StructStructField` path (F5); move `OpaqueCustomDataElem` into core with schema-derived keying; land a round-trip test against `C:/dev/webgl-app-framework/examples/error-test.wproj` (117 KB, exactly one BREP `mesh` block — the ideal fixture). None of this appears in any of the 14 plans.

---

### F3. Deleting the mesh addon makes the app throw at boot, by string lookup

`C:/dev/webgl-app-framework/scripts/data_api/api_define.ts:339-344`:

```ts
const meshStruct = dataApi.getStructByName('mesh.Mesh')
if (meshStruct === undefined) {
  throw new Error("api_define: struct 'mesh.Mesh' not found — ...")
}
```

`getDataAPI()` is called from the `AppState` constructor. This is a string-keyed hard dependency that no import-graph analysis, depcruise rule, or `instanceof` grep will surface. The same file also side-effect-imports six mesh modules (`:18-20,33,38,41`) and hosts `buildCDAPI` (`:312`) and `buildProcMeshAPI` (`:328`) — the customdata-layer and procedural-generator data APIs live in *core*, defined against BREP types.

---

### F4. Every surviving addon — including `sculptcore` — declares `dependencies: ["mesh"]`, and the sort throws

- `C:/dev/webgl-app-framework/addons/builtin/sculptcore/manifest.json` → `"dependencies": ["mesh"]`. Same for `pbvh_sculpt`, `curve`, `mesh_edit`, `subsurf`, `tetmesh`.
- `C:/dev/webgl-app-framework/scripts/addon/manifest.ts:163-165` — `throw new Error(\`addon "${m.id}" depends on unknown addon "${depId}"\`)`. Not a warning; the topological sort hard-fails.
- `C:/dev/webgl-app-framework/scripts/addon/addon.ts:430-439` — `enable()` returns `{ok:false, reason:'missing-dep'}`.
- `C:/dev/webgl-app-framework/tools/addon_api_plugin.js:54-58` — esbuild **errors** when `addons/builtin/<id>/src/api.ts` is absent. There is no absent-addon code path in the build today.

Additionally, the strategy's proposed `"optional": true` manifest field does not exist and would be **silently dropped**: `C:/dev/webgl-app-framework/scripts/addon/manifest.ts:9-47` defines the interface without it, and `validateManifest` at `:123-135` returns a whitelisted object rather than rejecting unknown keys. And `buildMode: "prebuilt"` is inert for builtins — its only behavioral use is `C:/dev/webgl-app-framework/scripts/addon/install.ts:113` on the third-party zip path.

---

### F5. `CurveSpline extends Mesh`, `Strand extends CurveSpline`, and core value-imports both

Verified directly:

- `C:/dev/webgl-app-framework/addons/builtin/curve/src/curve.ts:75` — `export class CurveSpline extends Mesh`
- `C:/dev/webgl-app-framework/scripts/hair/strand_types.js:1,36` — `import {CurveSpline} from '../../addons/builtin/curve/src/curve.js'`; `export class Strand extends CurveSpline`
- `C:/dev/webgl-app-framework/scripts/core/context.ts:17,18` — **value** imports of `TetMesh` and `StrandSet`, used in `instanceof` at `:283`, `:311`
- `C:/dev/webgl-app-framework/scripts/tet/tetgen.js:17-19` — imports `BVH`, `CDFlags`, `getArrayTemp` from `addons/builtin/mesh/src/`
- `C:/dev/webgl-app-framework/scripts/framework_api.ts:89-92` — `@framework/api` re-exports `TetMesh`, `TetTypes`, `tetSolve`, with a comment at `:82-88` explaining this is deliberate to avoid duplicate-struct registration

Depcruise confirms the cycle is real and reaches core:

```
addons/builtin/curve/src/curve.ts → addons/builtin/mesh/src/mesh_base.ts →
scripts/framework_api.ts → scripts/core/context.ts → scripts/hair/strand.js →
scripts/hair/strand_types.js → addons/builtin/curve/src/curve.ts
```

The serialization consequence is worse than the import consequence. `CurveSpline._elists : array(mesh.ElementList)`, `hair.Strand.eidgen : mesh.EIDGen`, `tet.TetElementList.customData : mesh.CustomData` are **non-abstract** struct fields. `C:/dev/webgl-app-framework/vendor/nstructjs/src/struct_intern2.ts:725-738` (`StructStructField.pack`) never consults `onSerializeUnknown` — it goes straight to `get_struct`, which throws at `struct_intern.ts:765-771`. So any file containing a `curve`, `strands`, or `TetMesh` block **throws on save** after the mesh addon is gone, and the missing-class machinery is bypassed entirely.

---

### F6. Dynamically allocated `SelMask` sub-mask blocks are a file-format change, not a refactor

Three separate persisted `int` fields carry `SelMask` values, with no name table and no migration hook that can remap them:

- `C:/dev/webgl-app-framework/scripts/scene/scene.ts:350` — `selectMask : int;` in `Scene.STRUCT`
- `C:/dev/webgl-app-framework/scripts/editors/view3d/view3d_toolmode.ts:549` — `storedSelectMask : int;` in `ToolMode.STRUCT`, and `scene.ts:354` serializes `toolmodes : array(abstract(ToolMode))`, so **every toolmode the user ever visited** carries one
- `C:/dev/webgl-app-framework/scripts/editors/view3d/tools/boxmodel.ts:31-43` — `boxModelSelMode : int;`

And these are not just save-file values: `C:/dev/webgl-app-framework/scripts/core/appstate.ts:996-1008` writes a full file to the startup slot, reloaded on every launch via `C:/dev/webgl-app-framework/scripts/core/gen_default_file.ts:121-133`. A bit reallocation silently changes selection mode across an app restart.

Structural blockers on top of the serialization one:

- `C:/dev/webgl-app-framework/scripts/editors/view3d/selectmode.ts:33-38` — `VERTEX/EDGE/FACE/HANDLE` are **aliases of `MeshTypes`**, which is serialized per-element as `mesh.Element.type : byte` (`C:/dev/webgl-app-framework/addons/builtin/mesh/src/mesh_types.ts:360`) and `mesh.ElementList.type : int` (`mesh_element_list.ts:199`). Bits 1/2/4/8/16 are locked by the mesh file format.
- `selectmode.ts:51` — `OBJECT` is a hardcoded `(1<<8)|…|(1<<15)` literal with only **one** unnamed free slot (bit 10).
- `C:/dev/webgl-app-framework/scripts/sceneobject/sceneobject_ops.js:108` — `if (selmask == SelMask.OBJECT)`, **exact equality against the composite**. Under dynamic allocation `OBJECT` changes value on every enable/disable and this silently stops matching.
- `C:/dev/webgl-app-framework/scripts/lite-mesh/litemesh.ts:4068-4070` — a raw `(tmSel & 1) !== 0` with the comment `// (SelMask.VERTEX = 1 in boxModelSelMode)`.
- Six keymap strings hardcode the numeric mask: `mesheditor.ts:391,392`, `meshtool.ts:67`, `curvaturetool.js:49`, `subsurf_tangent_test.js:655-657` — all `selmask=17`. Strings; nothing typechecks them.
- Allocation order is not stable across machines: `C:/dev/webgl-app-framework/scripts/addon/addon.ts:492-501` enables newly-installed addons at arbitrary later points, and enable/disable are user-driven at `:419`/`:459`.

144 hardcoded uses across 42 files, and `C:/dev/webgl-app-framework/scripts/addon/addon_base.ts:165` hands addons a live mutable reference to the object.

**Fix:** persist names, not bits, for all three fields (bump `APP_VERSION`), keep 1/2/4/8/16 statically reserved forever, and make `OBJECT` a computed `&`-test rather than an `==` comparand. That is a format change with a migrator, and it must land *before* any dynamic allocation.

---

### F7. "Make sculptcore optional" is blocked below the addon layer

P8/P9 treat this as a manifest/flag change. It is blocked at three levels that no plan touches:

- **pnpm.** `C:/dev/webgl-app-framework/pnpm-workspace.yaml` lists six sculptcore-rooted packages. `C:/dev/webgl-app-framework/scripts/package.json:8,10` declare `"@litestl/typescript-runtime": "workspace:*"` and `"@sculptcore/api": "workspace:*"`. The `workspace:` protocol has no registry fallback — `pnpm install` hard-fails on a clone without the submodule, before any build step runs.
- **esbuild.** `C:/dev/webgl-app-framework/tools/esbuilder.js:37,46` list `sculptcore/typescript/build/sculptcore-browser.{wasm,js}` as unconditional entry points.
- **Entry point.** `C:/dev/webgl-app-framework/scripts/entry_point.js:83` — static `import * as sculptcore from '@sculptcore/api/api'`; `:93` — **top-level `await sculptcore.loadWasm()`** before `init()`.
- **tsconfig.** There is no `@sculptcore/api` path mapping anywhere; it resolves only through the pnpm workspace symlink. And `C:/dev/webgl-app-framework/scripts/tsconfig.json` has **no `paths` block at all**, so anything under `scripts/` importing `@addon/leafmesh/api` typechecks only from the repo root.

Note also `addons/*` is a workspace glob but `addons/builtin/*` is not — a new `addons/builtin/leafmesh/package.json` would not be picked up.

---

### F8. The P5 depcruise ratchet cannot ratchet: it is already vacuous

Success criterion #1 leans on flipping the layer rules from `warn` to `error`. I ran it:

```
x 288 dependency violations (0 errors, 288 warnings). 488 modules, 1532 dependencies cruised.
```

- `C:/dev/webgl-app-framework/.dependency-cruiser.cjs:23` and `:39` — `core-no-mesh` and `util-no-mesh` both target `to: {path: '^scripts/mesh/'}`. **That directory does not exist** (`ls -d scripts/mesh` → no such file). Two of the four layer rules are dead.
- `:51-52` — `core-no-addons` excludes all of `scripts/editors/`, and `dependencyTypesNot: ['type-only']` permits type imports. It is also *direct-dependency only*, so `scripts/core/context.ts → scripts/tet/tetgen.js → addons/builtin/mesh/src/bvh.js` is invisible: `scripts/tet/` and `scripts/hair/` are not in the `from` set.
- `:67-79` — `options.exclude.path` drops `scripts/renderengine` and `scripts/shadernodes` from the graph entirely. The renderer's duck-typed sculptcore protocol (see U3) is unmeasurable by design.
- The remaining 288 warnings are almost entirely `no-circular`.

Flipping severity to `error` today would prove nothing about mesh coupling; the rule that would catch it is measuring a path that has not existed since the addon migration.

**Fix:** repoint `core-no-mesh`/`util-no-mesh` at `^addons/builtin/mesh/`, drop the `scripts/editors/` carve-out and the type-only exemption in a second rule, remove `renderengine`/`shadernodes` from `exclude`, and re-baseline. Expect the count to go up sharply before it goes down — and that number, not the current 288/0, is the real W1 budget.

---

## Underestimated work

### U1. `IGeometrySource` covers roughly 8 of ~22 things the host demands

The proposed set — bounds, transform, draw submission, 4 picking entries, selection state, undo push/pop — maps cleanly onto `SceneObjectData:153,186,220,274,305,346,348,352,354`. Everything else on that base class is uncovered, and the host uses all of it:

| Capability | Evidence |
|---|---|
| Kind identity + factory + import | `scripts/core/data_kinds.ts:1-58`; `sceneobject_base.ts:405` `dataKindOf`; `context.ts:222,318,362` |
| Element iteration + stable eids | `transform_types.ts:78,92-93,334,340-341,470,485,552-553`; `view3d_draw.ts:170-222` |
| Invalidation/regen protocol (9 methods) | `transform_types.ts:367-368,498,500,670-671,699,712,716-717`; `PropsEditor.ts:166,189-196,235-237`; `stlformat.js:10` |
| Spatial acceleration | `transform_types.ts:110-115` `mesh.getBVH().closestVerts`; UI paths `PropsEditor.ts:633-637` |
| Material slots + shader/attr negotiation | `sceneobject_base.ts:56-58`; `renderengine_realtime.ts:1226-1299` |
| CustomData layers | `PropsEditor.ts:138,168,367-387,494-513`; `api_define.ts:312` |
| Self-description (`defineAPI`/`getTools`/`buildPropertiesTab`/`_ownSelectMask`) | `sceneobject_base.ts:72,101,128,181,419` |
| Graph participation (`inputs.depend`, `exec`, `SAVE_PROXY`) | `sceneobject_base.ts:80,124`; `sceneobject.ts:279-293`; `graph.ts:75` |
| Datablock lifecycle (`copy`, `copyAddUsers`, `dataLink`, `destroy`, `swapDataBlockContents`, `onContextLost`) | `sceneobject_base.ts:149,358,360`; `sceneobject.ts:269,364-380,410-417`; `PropsEditor.ts:165` |
| Undo beyond push/pop | `toolstack.js:7-8,29-41` `calcUndoMem`; `transform_ops.ts:265-294`; `PropsEditor.ts:136,163` |
| `applyMatrix` (bake into coords) | `sceneobject_base.ts:67` |
| Triangle extraction for export | `stlformat.js:13,33,40-43`; `app_ops.js:203-228` |
| Symmetry/mirror state | `transform_types.ts:85,246` `mesh.symFlag`, `MeshFlags.MIRRORED` |
| Active/highlight element (shader uniforms) | `view3d_draw.ts:302-368` |

The transform system alone is a **second, richer interface**: `C:/dev/webgl-app-framework/scripts/editors/view3d/transform/transform_base.ts:108-141` defines `ITransDataType` with 13 required methods, and `transform_ops.ts:177` hardcodes the type list `['mesh','object','litemesh']`. `MeshTransType` is 745 lines living *in the host* (`transform_types.ts:38-782`).

### U2. LeafMesh's 3,500-4,500-line budget has no line item for any of that

`documentation/plans/2026-08-15-0248-leafmesh-design.md` §12 lists `leafmesh.ts ~900`, `draw.ts ~350`, `pick.ts ~300`, `serialize.ts ~250`, `uv_source.ts ~250`. There is **no transform module**, no selection/regen protocol, no customdata-layer API, no `defineAPI`, no `buildPropertiesTab`, no graph-socket wiring. LiteMesh's element-level selection surface alone (`C:/dev/webgl-app-framework/scripts/lite-mesh/litemesh.ts:412-452,2058-2090`) is ~15 public methods. And selection *derivation/flush* is C++-resident — `documentation/plans/selectFlush.md` puts it in `select_derive.{h,cc}` behind flag `sculptcore.select_flush_prefer_op_domain` — so a LeafMesh modeling toolmode in a no-sculptcore build must reimplement it in TS. Not budgeted.

Also unbudgeted: §9 of the design calls LeafMesh↔sculptcore interop "a column copy, not a topology rebuild." There is no bulk column-set seam. `C:/dev/webgl-app-framework/documentation/native-napi-electron.md:243-257` documents that the V8 sandbox forbids zero-copy bulk reads on the native backend, and `sculptcore/typescript/api/wasm.ts:307-313` shows the only JS→C++ bulk path is `setBoundIntVector`, a single-type `Vector<int>` fill.

### U3. `draw.ts ~350` is right for the draw path and wrong for the *material* path

I want to give the strategy credit here: the render queue really is generic. `C:/dev/webgl-app-framework/scripts/render/queue.ts` is 90 lines total, `C:/dev/webgl-app-framework/scripts/renderengine/renderengine_realtime.ts:1-27` imports nothing from sculptcore or lite-mesh, and existing non-BREP geometry draws in 12 lines (`C:/dev/webgl-app-framework/scripts/light/light.js:94-105`). BREP `Mesh.drawQ` is 22 lines (`addons/builtin/mesh/src/mesh.ts:5981-6002`) plus a 45-line `SimpleMesh` builder (`:5540-5584`). ~350 lines is a fair budget for that.

What is *not* in the budget is that **attribute-driven materials cannot work for a new TS geometry without an engine change**. `C:/dev/webgl-app-framework/scripts/shaders/wgsl_shaders.ts:1361-1370`:

```ts
export function buildMaterialPipelineDescriptor(wgsl: string, label: string): PipelineDescriptor {
  return {label, wgsl, vertexBuffers: LIT_MESH_VERTEX_LAYOUT, ...}
}
```

with the doc comment immediately above it (`:1347-1360`) stating outright that a material with an `AttributeNode` declares `@location(2+)` inputs this fixed layout does not supply, and *"those materials only render correctly through the LiteMesh/sculptcore draw path."* The only dynamic vertex-layout builder in the codebase is `C:/dev/webgl-app-framework/scripts/webgpu/batch.ts:380-443`, which is 100% sculptcore-bound (`import {Buffer, DrawBatch, DrawCommand, ShaderDef} from '@sculptcore/api'`). Generalizing it and threading it through both compile sites (`renderengine_realtime.ts:708`, `view3d_draw_webgpu.ts:490`) is ~160-270 lines of engine work outside `draw.ts`.

Edit-mode element overlays are also unbudgeted: `addons/builtin/mesh/src/mesh_draw.ts` is 552 lines for that alone, and LiteMesh spends five `_ensure*Batch` methods plus a 209-line `drawQ` on overlays (`litemesh.ts:2108,2144,2160,2176,2197,4053-4261`).

One counter-example worth knowing about: `C:/dev/webgl-app-framework/scripts/camera/camera.ts:163,165` calls `queue.scheduleRawGLPass(...)`, which **throws** on the WebGPU adapter (`scripts/webgpu/queue_adapter.ts:229-234`). "Just use the queue" is not uniformly true even today.

### U4. Moving `scripts/lite-mesh/` into an addon is a bidirectional cycle break

The strategy treats it as a directory move. Host→lite-mesh edges that must all be rewritten or die:

- `C:/dev/webgl-app-framework/scripts/data_api/api_define.ts:63` — `import '../lite-mesh/litemesh.js'`, the data-API registry side-effect import. This is why `library.litemesh` and `toolDefaults.litemesh.*` appear in the committed `scripts/data_api/generated/datapaths.ts:74,536-554`. Moving lite-mesh changes generated core code.
- `C:/dev/webgl-app-framework/scripts/editors/view3d/view3d_draw_webgpu.ts:50` — the core WebGPU draw path imports `buildSolidTexturedWgsl` from `lite-mesh/litemesh_wgsl.js`
- `C:/dev/webgl-app-framework/scripts/framework_api.ts:157` — `export {LiteMesh} from './lite-mesh/index.js'`; the framework's own public API re-exports it
- `C:/dev/webgl-app-framework/scripts/editors/view3d/tools/boxmodel.ts:27,28` — a host toolmode imports LiteMesh ops
- `C:/dev/webgl-app-framework/scripts/webgpu/stencil_compute.ts` — a **host** file (multires SpMV, Ptex VDM sampler) imported *only* by lite-mesh (`litemesh.ts:50`). It would be stranded; `framework_api.ts` exports nothing from `scripts/webgpu/`.

### U5. `mesh_edit` is the only polygon toolmode and core imports it directly

`C:/dev/webgl-app-framework/scripts/editors/view3d/view3d.ts:36` — `import '../../../addons/builtin/mesh_edit/src/mesheditor'` (side-effect, registers the toolmode). `C:/dev/webgl-app-framework/scripts/addon/addon_base.ts:190-195` exposes `MeshToolBase`/`MeshEditor` on the *public* `AddonAPI`. `C:/dev/webgl-app-framework/scripts/editors/view3d/view3d.ts:680` hardcodes `new HotKey('W', [], 'mesh.vertex_smooth()')` in a host keymap, and `scripts/editors/view3d/widgets/widget_tools.ts:580` throws if the mesh addon's `InsetHoleOp` was not registered.

Deleting the BREP before LeafMesh + a LeafMesh modeling toolmode ship leaves the tree with **no polygon-editing capability at all** for the duration — which is the sequencing hazard the brief asked about, and it is real.

---

## Missing from the strategy entirely

**M1. CI has no test lane.** `C:/dev/webgl-app-framework/.github/workflows/deploy-pages.yml` is the *only* workflow. It is entirely sculptcore-shaped: recursive submodule checkout (`:29-32`), emsdk install and WASM build from source (`:73-95`), and a coi-serviceworker for COOP/COEP because sculptcore's pthread pool needs `SharedArrayBuffer` (`:105-130`). Nothing runs `turbo test`, `turbo typecheck`, eslint, jest, or playwright. A `faber-leaf-core` lane is a from-scratch second workflow, and there is no existing safety net that would catch any of F1-F8.

**M2. W0's rename is a user-data migration.** `package.json:2` is simultaneously the pnpm root name, the NW.js manifest name, and the key Chromium derives its profile and Crashpad dir from (`nwjs/window.html:18-23`). The same string is duplicated at `nwjs/profile_dir.mjs:22,24`, `scripts/core/const.ts:2` (`APP_KEY_NAME`), `scripts/core/settings.ts:44`, `scripts/core/app_storage.ts:97-98` (**raw localStorage keys**), and `scripts/addon/storage.ts:189` (**IndexedDB database name** — rename and every installed third-party addon vanishes).

**M3. File migrations are owned by the addon being deleted, and the format has no floor.** `C:/dev/webgl-app-framework/addons/builtin/mesh/src/migrations.ts:33,46` registers the v5/v6 grid migrators. `C:/dev/webgl-app-framework/scripts/core/file_migrations.ts:60-62` **swallows migrator throws** into `console.error` — a failed migration silently produces a corrupt scene. `C:/dev/webgl-app-framework/scripts/core/appstate.ts:654-660` rejects only a bad `WPRJ` magic; there is no minimum-version check (`examples/sculpt test.wproj` is version 0 and is still accepted, and it is loaded by a live green test at `tests/e2e/load_wproj.e2e.ts:11`). And `appstate.ts:1010-1025`'s `version < 4` path iterates `datalib.mesh`, which becomes `undefined` once `mesh` is not a registered BlockType.

**M4. Feature flags are 100% sculptcore-owned.** All 11 flags in `C:/dev/webgl-app-framework/scripts/core/feature-flag.ts:174-249` are `sculptcore.*`. `:64` `get()` uses a **double non-null assertion** — a persisted key absent from the definitions throws `TypeError`. `:254` derives the key union from the array, so emptying it makes every call site a type error. `:103-131` `merge()` never prunes unknown persisted keys.

**M5. `AddonAPI.register` has no dispatch for half of what LeafMesh needs to register.** `C:/dev/webgl-app-framework/scripts/addon/addon_base.ts:331-405` covers ToolOp / DataBlock / ToolMode / CustomDataElem / Editor / SceneObjectData / nstructjs / defineAPI. There is no case for `TransDataType`, `DataKind`, `DefaultSceneBuilder`, `FileMigrator`, `UVSource`, or a properties-panel contribution. Today those register at module scope — `C:/dev/webgl-app-framework/scripts/lite-mesh/litemesh_transtype.ts:202` is a bare `TransDataType.register(LiteMeshTransType)` — which the project's own addon rules in `CLAUDE.md` forbid.

**M6. Deleting `tetmesh` removes the only end-to-end test of the machinery W5 depends on.** `C:/dev/webgl-app-framework/tests/integration/tetmesh_real_build.test.ts` is the sole test that `tools/build-addons.js` produces a working external per-addon bundle with a correct `index.json` dependency entry. W5's embeddability story rests on that pipeline.

**M7. `.wproj` can embed a serialized toolstack.** `C:/dev/webgl-app-framework/scripts/core/appstate.ts:370-371` writes it when `save_toolstack` is set — a user-facing option (`scripts/core/app_ops.js:41,53`) — and `:712-714,949-960` reads it back. Those blocks contain ToolOp instances of classes about to be deleted. `C:/dev/webgl-app-framework/examples/brush_asymmetric_toolstack.wproj` already embeds `BrushProperty`, `PaintSample`, `PaintSampleProperty` — the exact two pbvh files the sculptcore stack still imports (F1). Separately, `saveUndoMesh`/`loadUndoMesh` live in the mesh addon (`addons/builtin/mesh/src/mesh_ops_base.ts:68,79`) and are imported by core at `C:/dev/webgl-app-framework/scripts/editors/properties/PropsEditor.ts:36`.

**M8. Shipped fixtures already contain the full deletion-set schema.** `C:/dev/webgl-app-framework/scripts/scene/scene.ts:354` serializes `toolmodes : array(abstract(ToolMode))` — every save writes one instance of *every registered toolmode*. The consequence: the new sculptcore/LiteMesh-generated test fixtures `examples/tests/multiresBasic.wproj` and `textureCube.wproj` still embed `view3d.BVHToolMode`, `mesh_edit.MeshEditor`, `curve.CurveToolBase`, `tetmesh.TetMeshTool`, `hair.Strand`, the nine `tet.*` structs, and ~50 `mesh.*` structs. And `C:/dev/webgl-app-framework/scripts/core/legacy_struct_migration.ts:34-102` is a rename table whose entries point *into* the deletion set (`BVHToolMode`, `MeshEditor`, `CurveToolBase`, `Strand`, `TetMeshTool`, and 15 `mesh.*` names).

---

## What the strategy gets right

Short, but these are load-bearing and I verified each:

- **"Submit draws through the render queue" is accurate.** `scripts/render/queue.ts` is 90 lines with no sculptcore or lite-mesh coupling, `renderengine_realtime.ts:1-27` imports neither, and the sculptcore/LiteMesh protocol at `:1254-1262` is duck-typed and skippable. A new geometry with a normal `drawQ` would even get NormalPass/SSAO *for free*, which LiteMesh does not (`:1376` skips it).
- **The last-writer-wins default-scene hook already works and is proven in production.** `scripts/core/default_file.ts` is a clean 49-line registry, and `scripts/lite-mesh/litemesh_default_scene.ts:25-56` already overrides the mesh cube with a LiteMesh sphere plus `setDefaultToolMode('sculptcore')`. The startup scene does not need the mesh addon at runtime — this is the one part of the deletion that is genuinely low-risk.
- **`MissingToolMode`'s abstract-dispatch path really works.** `Scene.toolmodes` is `array(abstract(ToolMode))`, so `onUnknownClass`/`onSerializeUnknown` engage correctly and re-emit under the original struct id (`missing_addon.ts:267-275`; `vendor/nstructjs/src/struct_intern2.ts:852-863`; covered by `tests/integration/graph_missing_nodes.test.ts:117-152`). It is the one piece of the file-compat story that is real. (Two caveats: the comment at `missing_addon.ts:102` claiming a `toolmode_map` filter is wrong — `scene.ts:847-859` inserts under `undefined`; and the active toolmode selection resets to 0 at `scene.ts:840-845`.)
- **The shader-node layer is already mesh-agnostic.** `scripts/shadernodes/shader_nodes.ts:715-721` declares `IAttrItem` explicitly duck-typed against `LiteMesh.attrItems`, with an `Array.isArray` guard and a `'(no attributes)'` fallback at `:824-838`. `shader_nodes_wgsl.ts` imports nothing from the deletion set.
- **`scripts/path.ux` and `scripts/mathl` are clean.** Repo-wide search for deletion-set imports under both submodules returns only lint config. path.ux's ToolOp/DataAPI machinery makes no mesh assumptions.
- **The native/WASM backend seam is sound.** `sculptcore/typescript/api/wasm.ts:531-551` and `nativeBackend.ts:331-367` already degrade gracefully; the TS host never imports the `.node`. The problem is upstream of the seam (F7), not in it.
- **The §2.2 Class A-D coupling taxonomy is accurate for the mesh addon itself** — as far as it goes. It just stops short of the string-keyed (F3), inheritance-based (F1, F5), and serialization-based (F2, M8) couplings, which are the ones that actually stop the work.
- **`data_kinds.ts` is a correct, working extension point** (`scripts/core/data_kinds.ts:1-58`), and `sceneobject.ts:220-249`'s `ostruct.dynamicStruct('data','data','data')` is a genuinely generic per-geometry API hook.

### Assumptions I actively verified as sound

The render queue's genericity; the absence of sculptcore/lite-mesh imports in `renderengine_realtime.ts`; the native-backend fallback; the default-scene override mechanism; `MissingToolMode`'s abstract round-trip; path.ux/mathl cleanliness; and that `scripts/editors/image/pending-port/` (3,104 lines) is genuinely unreferenced. Those parts of the plan hold.

### The honest answer to "what can a downstream embedder do with faber-leaf-core?"

After all 14 plans land as written: display a LeafMesh with pos/normal/uv/color materials, pick and box/circle-select it, transform whole objects, and save/load a `.wproj` that no full-build user can round-trip (F2). No polygon modeling until a LeafMesh toolmode exists (U5), no sculpting, no attribute-driven materials (U3), no proportional edit or per-element transform (U1, U2), no customdata-layer UI (F3), no `pnpm install` without the sculptcore submodule (F7), and no CI (M1). The "empty host" risk that LeafMesh is meant to mitigate is real, and LeafMesh as currently scoped does not mitigate it — the gap is not the mesh data structure, it is the ~20 host subsystems written against `Mesh`'s incidental API surface.
