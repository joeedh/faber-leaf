# P15 — W3a: LiteMesh becomes an optional addon

**Status:** done — §3, §4, §5 and §7 all landed 2026-08-19.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W3 step 1, §5 phase 10, §9.3 P15.

**Workstream / phase:** W3 / phase 10.

**Depends on:** P13 (the BREP is gone), P14 (optionality is real).
**Blocks:** P16.

**Authoring effort:** high — a move plus five edge cuts.

---

## 1. Goal

Move `scripts/lite-mesh/` and the sculpt/boxmodel toolmodes out of the host and
into `addons/builtin/litemesh/`, declared optional, so that the entire
sculptcore-dependent half of the application sits behind one gate.

## 2. Why this is the shape

30 files, ~15,318 lines, and **30+ files importing `@sculptcore/api`**. Almost
all of them end up inside this addon. Once they do, "does this build have
sculptcore?" has exactly one answer site: is the litemesh addon registered.

Absent sculptcore, the addon does not register. That is the whole mechanism.

## 3. Cut the host edges first

`scripts/` → `lite-mesh` edges. Line numbers **re-measured 2026-08-19**;
the 2026-08-15 originals are in parentheses where they drifted.

| Site | Kind |
| --- | --- |
| `scripts/data_api/api_define.ts:50` (was 63) | `import '../lite-mesh/litemesh.js'` — side-effect |
| `scripts/editors/view3d/view3d_draw_webgpu.ts:55` (was 50) | `buildSolidTexturedWgsl` from `litemesh_wgsl.js` — **cut 2026-08-19** |
| `scripts/framework_api.ts:226` (was 157) | `export {LiteMesh} from './lite-mesh/index.js'` — the hub re-exports it |
| `scripts/editors/view3d/tools/boxmodel.ts:28,29` (was 27,28) | `SelectLoopLiteMeshOp`, `SelectNearestLiteMeshOp`, `localRay`, `LiteMesh` |
| `scripts/entry_point.js:38,43` (was 70,75) | side-effect imports of `litemesh_test_scene.js` and `litemesh_default_scene.js` |
| `scripts/webgpu/stencil_compute.ts` | stranded — assigned here by the strategy; **stays**, 2026-08-19 |
| `scripts/renderengine/renderengine_realtime.ts:1250,1393` (was 1253) | already duck-typed; verify it stays that way |

The `sculptcore*.ts` toolmode files (`sculptcore.ts:37`,
`sculptcore_bindings.ts:6`, `sculptcore_gpu_stroke.ts:21`,
`sculptcore_ops.ts:3`) also import LiteMesh — those **move with it**, so they
are not edges to cut. P4's `stroke_driver_native.ts` no longer names LiteMesh
at all; it moves in §4 for cluster cohesion, not because it is an edge.

Everything else that says "LiteMesh" in `scripts/` is already a comment, a
duck-typed check, or a feature-flag *description string*
(`feature-flag.ts:231,238,245` — §6's subject). That is the baseline §9's
`grep` criterion is measured against.

Cuts, in order:

1. **`api_define.ts:50`** — replace the side-effect import with the P7/P8
   `registerDataKind` contribution from the addon's `register(api)`. Same
   pattern P8 applied to the mesh addon; this is its second use.
2. **`framework_api.ts:226`** — delete. A host hub re-exporting a concrete
   geometry type is the coupling in its purest form. Consumers move to
   `@addon/litemesh/api`.
3. **`entry_point.js:38,43`** — default scene and test scene become
   `registerDefaultSceneBuilder` contributions (P7 §9). This is also what P17
   needs: a distribution picks its default scene, it is not hardcoded in the
   entry point.
4. **`view3d_draw_webgpu.ts:55`** — `buildSolidTexturedWgsl` is shader
   construction for a specific geometry type. Either it moves into the addon and
   is supplied through the material/vertex-layout contract (P7 §8), or it is
   genuinely generic and moves into `scripts/shaders/`. Decide by reading it;
   do not leave a LiteMesh-named symbol imported by a host draw file.
   **Decided 2026-08-19: generic → `scripts/shaders/wgsl_shaders.ts`.** See §3.1.
5. **`boxmodel.ts:28,29`** — the boxmodel toolmode moves into the addon
   wholesale. It is a LiteMesh toolmode.
6. **`stencil_compute.ts`** — same question as `brush_compute.ts` in P5: generic
   GPU seam (stays) or LiteMesh-shaped (moves). Read it.
   **Decided 2026-08-19: generic GPU seam → stays in `scripts/webgpu/`.** See §3.1.

Cutting these **before** the move keeps the move mechanical and keeps
`check:layers` interpretable throughout. Two of them can only be *partly* done
that way: cuts 1 and 2 hand their responsibility to `addons/builtin/litemesh/`,
which does not exist until §4. They are therefore cut **as part of** the move
commit; cuts 4 and 6 are the reads, and they land first.

### 3.1 Steps 4 and 6 — the two read-and-decide cuts (landed 2026-08-19)

**`buildSolidTexturedWgsl` is generic — moved to `scripts/shaders/wgsl_shaders.ts`**,
next to `buildMaterialVertexLayout` / `buildMaterialPipelineDescriptor`, whose
family it belongs to. The evidence is the *binding convention*: it declares
`@group(0)` frame, `@group(1)` material texture+sampler, `@group(2)` object —
which is `wgsl_shaders.ts`'s convention, and explicitly **not** the one
`litemesh_wgsl.ts`'s own header describes ("sculptcore's `WebGPUBatchExecutor`
only binds `@group(0)` per draw, so … are packed into a single
`SpatialUniforms` struct"). Its vertex layout is P7's material contract
(position/normal at 0/1, requested attrs from 2), and its caller
(`updateSolidTexturedDrawShader`) is already fully duck-typed over
`setDrawShader`/`setRequestedAttrs`/`attrItems`. Nothing about it is LiteMesh
except the file it happened to be sitting in. A second geometry type with a
TEXTURED draw mode needs exactly this function, which is the test §8 states.

What is left in `litemesh_wgsl.ts` is now uniformly the sculptcore spatial
`ShaderDef` ports, so the file moves with the addon without a caveat.

**`stencil_compute.ts` is a generic GPU seam — it stays in `scripts/webgpu/`.**
Its only import is `./flags`; its API is `stencilAmplify(device, levels,
srcPositions)` (a CSR SpMV chain) and `tessFinalize(device, count, pos, nor,
tan, topo, vdm?)`, both parameterized entirely by `GPUDevice` + typed arrays.
Its inputs are *multires-grid*-shaped, not LiteMesh-shaped — and multires grids
are a sculptcore store, so any geometry type that materializes CC levels
through the engine reaches this the same way. It is the `brush_compute.ts`
answer from P5, for the same reason. The addon imports it through
`@framework/api`; the hub does not export these symbols yet, so §4 adds
`stencilAmplify` / `tessFinalize` / `StencilLevel` / `TessTopoInputs` /
`TessVdmInputs` to `framework_api.ts` as part of the move.

Note what the bit-consistency contract in that file's header means for the
decision: the `fma` chain has to match `StencilTable::eval` bit-for-bit, and
the stage-1 gate compares GPU readback against the CPU-materialized level. That
gate is a *host* gate over a *host* device. Moving the kernel into an addon
would put the reference implementation and the thing it is pinned to on
opposite sides of an optional boundary.

## 4. The move

`git mv scripts/lite-mesh/ addons/builtin/litemesh/src/`, plus the sculpt and
boxmodel toolmodes from `scripts/editors/view3d/tools/`, plus P4's
`stroke_base.ts` cluster (`stroke_base.ts`, `stroke_driver.ts`,
`stroke_driver_native.ts`, `stroke_paint_op.ts`) — P4 deliberately deferred
their final home to this plan so the cluster moves once.

`manifest.json`:

```jsonc
{
  "id": "litemesh",
  "buildMode": "prebuilt",
  "optional": true,
  "dependencies": [],
  "optionalDependencies": []
}
```

`"optional": true` is meaningful because P14 made it so. `dependencies` is empty
— the `mesh` dependency every builtin used to carry died with P13.

The sculptcore *addon* (`addons/builtin/sculptcore/`) also exists; decide
whether litemesh depends on it (`"dependencies": ["sculptcore"]`) or whether the
two merge. Prefer keeping them separate with a required dependency: the
sculptcore addon is the engine binding, litemesh is the geometry type. One gate
is still one gate, because a required dependency that is absent disables the
dependent (P14). *(Superseded — see §4.1: the premise is wrong and the two
merged.)*

Use `git mv` throughout (repo convention) so history follows.

### 4.1 What the move actually was (landed 2026-08-19)

39 files by `git mv` into a flat `addons/builtin/litemesh/src/` (matching
leafmesh's layout): the 30 `scripts/lite-mesh/*.ts`, plus `boxmodel.ts`,
`sculptcore.ts`, `sculptcore_bindings.ts`, `sculptcore_gpu_stroke.ts`,
`sculptcore_ops.ts` and P4's four-file `stroke_base.ts` cluster from
`scripts/editors/view3d/tools/`. Relative imports were re-derived by resolving
each specifier against the old directory and re-emitting it against the new one,
so nothing was hand-patched.

Four decisions the plan above left open, resolved during the move:

**The sculptcore addon was merged in, not depended on.** §4's "prefer keeping
them separate with a required dependency" rested on a false premise: the engine
binding is not `addons/builtin/sculptcore/`, it is the `@sculptcore/api`
workspace package under `sculptcore/typescript/`. The addon directory was a
three-file shim (manifest, `api.ts` re-exporting `SculptCorePaintMode`, `main.ts`
holding three `litemesh.add_*` menu entries) whose entire contents were
LiteMesh-shaped. Splitting would have bought only the configuration "LiteMesh
present, sculpt mode absent" — which nothing wants — while doubling P16's work.
`addons/builtin/sculptcore/` is deleted; its menu entries and export live in
litemesh's `main.ts`. No consumer of `@addon/sculptcore/api` existed.

**The addon stays in-bundle for P15.** Going out-of-bundle would mean rewriting
every `scripts/` import across ~15,318 moved lines onto `@framework/api` in the
same commit as the move. §9's exit criteria do not ask for it and P16 owns build
decoupling, so litemesh registers through `addons/builtin/builtin_registry.ts`
and keeps relative `../../../../scripts/...` imports, exactly as the sculptcore
addon did. `IN_BUNDLE_BUILTIN_IDS` in `tools/check-addon-duplication.js` moved
from `sculptcore` to `litemesh` — without that rename `build-addons.js` stops
skipping it and emits a redundant 15 MB second copy into `build/addons/`.

**The addon needed its own `package.json`.** `scripts/` is itself a pnpm
workspace package (`@faber-leaf/host`) and carries `@sculptcore/api` /
`@litestl/typescript-runtime` as `workspace:*` deps resolved through
`scripts/node_modules`; the repo root carries neither. So 15 of the moved files
stopped resolving `@sculptcore/api` the moment they left `scripts/`. The fix is
the P16 mechanism arriving early: `addons/builtin/litemesh/package.json`
declaring those deps itself, which works because P14 already added
`addons/builtin/*` to `pnpm-workspace.yaml`. This is the addon owning its
dependency on the engine rather than the host carrying it for it.

**~45 module-scope registrations became a `register(api)` hook.** 29 + 2 + 1
`ToolOp.register` calls became exported `LITEMESH_OPS` / `STROKE_BASE_OPS`
arrays; `ToolMode.register`, `TransDataType.register`, `DataBlock.register`,
`SceneObjectData.register`, `registerDataAPI`, `registerDataKind`,
`setDefaultSceneBuilder` / `setDefaultToolMode` and six `registerTestScene` calls
became exported values `main.ts` hands to the API. The 34
`nstructjs.inlineRegister` static-field initializers are untouched — they are
the sanctioned exception, and struct names are unchanged by the move.

Two host additions were needed to receive that (landed separately, `113e1280`):
`api.registerTestScene(name, builder)` on `AddonAPI`, backed by a new
`unregisterTestScene` in `core/test_scenes.ts`; and an optional second argument
on `registerDefaultSceneBuilder(fn, toolMode?)`, because the default scene and
the toolmode it opens in are one contribution and must be withdrawn together.

Host edges cut, all five: `api_define.ts`'s side-effect import, `framework_api`'s
`LiteMesh` and `PaintToolModeBase` re-exports, `tools.ts`'s toolmode aggregation
(now only `selecttool` + `view3d_panmode`), and `entry_point.js`'s two
`lite-mesh` imports. The cycles they closed went with them: `no-circular`
459 → 400, ratcheted down in `tools/layer-baseline.json`. `core-no-litemesh` was
retargeted from `^scripts/lite-mesh/` to `^addons/builtin/litemesh/` and still
reads zero.

**Survivors of §8's grep, all intentional:** the three `feature-flag.ts`
description strings that name LiteMesh (§6's business), one
`buildScene('litemesh-cube')` in `core/test_harness.ts` behind the
`--apptest-crash` self-test (a flag that is meaningless without sculptcore
anyway), and a duck-typed local named `litemesh` in
`renderengine_realtime.ts:1264` that reaches its object through a structural cast
with no import — a P8-style bridge, not an edge. `tests/unit/host_string_keys.test.ts`'s
`ALLOWED_NAMESPACES` is now empty: no host keymap names a `litemesh.*` toolpath.

Regenerated: `tsconfig.paths.json` (`@addon/sculptcore/api` → `@addon/litemesh/api`)
and `scripts/data_api/generated/`, where `datapaths.ts` lost 548 lines because
`gen:paths` does not boot addons — the same drop-out the mesh addon already has.

## 5. Serialization is the risk, not the move

This is the **first time P10's unknown-addon machinery runs on data users
actually have.** Every existing `.wproj` contains LiteMesh blocks, sculpt
toolmodes, and — where sculpt layers or multires are in use — engine-owned
stores.

Verify explicitly, on real files from `examples/`:

- A LiteMesh DataBlock survives load→save with the addon disabled, bytes and
  `lib_id` intact, and re-opens live with the addon enabled.
- The serialized toolmode array (`scene.ts:354`) tolerates a sculpt toolmode
  that is not registered — P5 added the fallback; this exercises it.
- Sculpt layers and multires stores round-trip as opaque data.
- Struct names are unchanged by the move. A file move must not rename a struct;
  if any struct name embeds a module path, P4's rule applies — keep the name or
  add a migration entry.

If any of this fails, it is a P10 defect and it must be fixed in P10's files,
because the same failure will hit every third-party addon.

### 5.1 Outcome (2026-08-19)

All four bullets verified; **two P10 defects were found and fixed in P10's own
files**, exactly as the rule above requires.

**Method.** A three-leg harness (A: load with the addon enabled; B: reload with
`--disable-addon=litemesh`, then re-save; C: reload B's output with the addon
enabled) run on two subjects, one per backend.

**Prerequisite that is not obvious.** Every file under `examples/` predates
`APP_VERSION = 9` / `STABLE_STRUCT_ID_VERSION = 9` (`scripts/core/const.ts`), and
a pre-v9 preserved blob cannot be spliced into a v9 file — the re-save writes
name-derived struct ids around bytes carrying numeric ones, and leg C dies with
`Unknown struct type NN`. So each subject is re-saved through the current build
once (a plain load→save boot) before the A/B/C legs run. This is a property of
the version seam, not of P10: a v9 file preserved by a v9 build round-trips.

**Subject 1 — `examples/remesh2.wproj` re-saved to v9, wasm backend.**
Leg A: 323 blocks, 0 missing. Leg B: exactly 1 `MissingDataBlock`, `lib_id` 10
preserved, 392,395 bytes held opaquely, `_legacyStructIds: false`; re-saved to
2.93 MB. Leg C: a live `LiteMesh` back at data id 10, **A == C geometry
signature**, `lib_id` set unchanged.

**Subject 2 — a litemesh cube carrying a sculpt layer and a multires level,
native backend.** Built with `litemesh.sculpt_layer_add` +
`litemesh.multires_enable` + `litemesh.multires_add_level`. Leg B preserved
2,455,116 bytes opaquely at `lib_id` 4; **A == C**. That is §5's "sculpt layers
and multires stores round-trip as opaque data" — they ride inside the block's
own blob, so the disabled build never has to understand them.

**The toolmode bullet.** With the addon disabled the serialized array
round-trips intact (`["SculptCorePaintMode", "ObjectEditor"]`) while the *active*
mode falls back to `ObjectEditor`; leg C restores the original. Note the subtlety
P5's fallback did not cover: a disabled addon's toolmode still *deserializes*
into the real class, because the class's module is in the bundle and its
`nstructjs.inlineRegister` static-field initializer runs regardless of whether
`register()` did — so it is never a `MissingToolMode`. It simply has no enum
slot.

**The struct-name bullet** is satisfied implicitly: leg C loads a v9 file, whose
struct ids *are* the struct names. A rename anywhere in the move would have
failed it.

#### The two defects (fixed in P10/P5's files, not worked around)

1. **`NullObject` and `MissingDataBlock` were never registered with the data
   API.** `SceneObject.dataLink` substitutes a `NullObject` for any object whose
   data block belongs to a disabled addon, and a preserved block sits in the
   datalib like any other — so both are reachable at `library.object[N].data` /
   `library.<type>[id]` on an ordinary load. `api_define.ts`'s
   `ostruct.dynamicStruct('data', …)` resolves the value's struct at runtime, so
   an unregistered class makes the *path itself* invalid: `MaterialEditor.updatePath`
   called `getValue('library.object[N].data')` during `loadFile_finish` and threw
   `invalid path`, which aborted the whole load. Not addon-specific — it also hit
   `examples/sss-test.wproj` with nothing disabled. Fixed with `registerDataAPI(...)`
   in `scripts/nullobject/nullobject.js` and `scripts/core/missing_addon.ts`.

2. **An unregistered toolmode landed in the runtime maps under a literal
   `"undefined"` key.** `Scene.loadSTRUCT` indexed `toolmode_map` /
   `toolmode_namemap` by the mode's enum slot without checking that the slot
   exists. Fixed in `scripts/scene/scene.ts`: a mode with no slot stays in
   `toolmodes` (so it round-trips) and out of the maps (which are keyed by that
   slot) — which is what `MissingToolMode`'s doc comment always claimed.

#### Recorded, not fixed: saving multires on the wasm backend

Isolated while building subject 2. Saving a LiteMesh that carries a multires
level throws `RangeError: Start offset … is outside the bounds of the buffer`
(or `RuntimeError: memory access out of bounds`) on `--backend wasm`; the
identical scene saves cleanly on `--backend native`. Isolated by op: only
`multires_add_level` triggers it. The cause is a stale `HEAPU8` view —
`serializeMeshHeap` (`sculptcore/typescript/api/wasm.ts:570`) takes the view
*before* a pool worker grows the shared memory, and the `wasmMemory.grow` patch
(`litestl/binding/typescriptRuntime/wasmInterface.ts:494`) only re-derives views
for growth initiated from that JS context. Pre-existing, in litestl/sculptcore,
outside P15's scope — but the browser is the shipping target, so it is a real
bug and belongs on W3's follow-up list.

## 6. Feature flags

`feature-flag.ts` hardcodes the sculptcore flags in host code
(`:64,103-131,174-249,254`). Those flags describe addon features. Moving them is
P16's step, but note the interaction here: a flag registered by the host for a
feature in a disabled addon shows up in the UI as a knob that does nothing.
Either move them with the addon now, or accept the cosmetic issue for one plan
and record it — do not leave it undecided.

### 6.1 Decision: the flags stay in the host for P15 (2026-08-19)

Accepted as a recorded cosmetic issue, not moved. Two reasons, one of which
only became visible after the move:

**Every reader is already inside the addon**, so the *dependency* argument for
moving them is settled — all 32 `FeatureFlags.get/set('sculptcore.…')` call
sites now live under `addons/builtin/litemesh/src/`, with one exception in
`tests/e2e/settings_editor.e2e.ts` that drives the settings UI rather than the
flag. Nothing in `scripts/` reads a `sculptcore.*` flag. What survives in host
code is the *definition* list at `feature-flag.ts:174-249` and the three
descriptions that name LiteMesh (`:231`, `:238`, `:245`).

**But the flag DataAPI is built once, before any addon enables.**
`FeatureFlagManager.defineAPI` walks the module-level `featureFlags` const and
emits one `st.bool(...)` per flag; the struct is built when the DataAPI is
assembled, which is earlier than `enable()`. So an `api.registerFeatureFlags(...)`
hook would register the flags but not their datapaths, and the settings editor
would silently lose every sculptcore knob. Making that work needs the same
rebuild-the-DataAPI-when-an-addon-arrives machinery that `gen:paths` not booting
addons already implies (§4.1), which is P16/P17 work, not a P15 side quest. The
literal-union `FeatureFlagKeys` type would also have to become an augmentable
interface in the style of `KnownDataPath`.

**The accepted cost:** with the addon disabled, the settings editor shows eleven
`sculptcore.*` toggles that do nothing. They are inert rather than broken — the
reader that would act on them is not loaded. P16 moves the definition list into
the addon together with the DataAPI-rebuild hook.

## 7. Tests

- **The gate**: the app boots with the litemesh addon force-disabled (P14's
  mechanism), reaching a viewport with LeafMesh available and no LiteMesh. Not a
  crash, not an empty screen with an error toast.
- With the addon enabled, **everything still works**: full sculptcore
  integration suites on both backends, the GPU brush suite, the stroke tester,
  the boxmodel toolmode.
- §5's serialization checks on real `examples/*.wproj` files.
- `pnpm check:layers`: `core-no-litemesh` and `core-no-sculptcore` still hold at
  `error` — they were flipped in P9 at zero and must remain at zero. This plan
  is the one most likely to violate them, which is why they were flipped early.
- `pnpm typecheck` — the addon's sources are in the program (P1 step 3) and
  `@addon/litemesh/api` resolves through P1's generated `paths`.

### 7.1 Gate result (2026-08-19)

Run: one NW.js boot, `--apptest-headless --backend wasm --disable-addon=litemesh`
with a fresh `--app-storage-dir` (so the startup path builds the real default
scene rather than the developer's saved startup file), reporting through
`--dump`'s `evalResult` and a `--screenshot`.

- `addonManager.unloaded` = `litemesh: force-disabled`; `DataBlock.getClass('litemesh')`
  is `undefined`. No LiteMesh anywhere.
- A real screen: `MenuBarEditor / View3D / PropsEditor`, `ctx.view3d` is a
  `View3D`. No crash, no error toast.
- The startup scene is **empty** — 3 blocks (screen, collection, scene), 0
  objects. That is `default_file.ts` behaving as documented: the default-scene
  builder is a single slot, litemesh held it, and disabling the addon withdraws
  it. Not a failure mode; leafmesh is default-off, so it would be wrong for it
  to seize the slot.
- `mgr.enable('leafmesh')` at runtime → `LeafMeshData` registers, a cube
  (8 verts / 12 edges / 6 faces) is built through the addon's exported
  namespace, added to the scene and drawn; `switchToolMode('leafmesh')` gives a
  live `LeafMeshToolMode`. The screenshot shows the shaded cube with its
  edit-mode vertex overlay over the grid (83,313 bytes, against 73,077 for the
  empty scene).

Gate: **pass**.

## 8. Risks

- **A missed host edge only shows at runtime.** Type-only edges compile;
  side-effect imports do not appear in a symbol grep. Mitigation: after the
  move, `grep -rn "lite-mesh\|litemesh\|LiteMesh" scripts/` must return only
  comments. The measured list in §3 already shows the survivors are mostly
  comments — keep it that way.
- **`buildSolidTexturedWgsl` and `stencil_compute.ts` get moved without being
  read**, taking generic shader/GPU code into an addon where a second geometry
  type cannot reach it. Mitigation: §3 steps 4 and 6 are reads, not moves.
- **Serialization breaks on real user files.** Mitigation: §5, on `examples/`
  rather than on fixtures.
- **The move is huge and the diff is unreviewable.** Mitigation: land §3's cuts
  as individual commits first; then the move commit is pure `git mv` plus
  manifest.

## 9. Exit criteria

All met 2026-08-19.

- [x] The app boots with the litemesh addon force-disabled; LeafMesh is available
  and modelling works (P12) — §7.1.
- [x] With it enabled, the full sculptcore integration suites are green on both
  backends and nothing about the sculpt experience changed.
- [x] `grep -rn "lite-mesh" scripts/` returns only comments. The wider
  `litemesh|LiteMesh` grep is down to four non-comment hits, all recorded: three
  feature-flag *descriptions* (§6.1) and `test_harness.ts`'s `--apptest-crash`
  self-test, which names a scene by string through the registry rather than
  importing anything. The renderengine's duck-typed local was renamed
  `treeProvider`, since a variable name was the only thing keeping that file on
  the list.
- [x] `core-no-litemesh` and `core-no-sculptcore` hold at `severity: error` with
  zero violations (`pnpm check:layers`: 0 error, no-circular 400/400).
- [x] Existing `examples/*.wproj` files round-trip with the addon both enabled and
  disabled — §5.1, with the v9 re-save prerequisite noted there.
