# Faber Leaf refactor — high-level strategy

**Status:** strategy / direction-setting. Not an implementation plan; each
workstream below needs its own plan doc in `documentation/plans/` before work
starts.

**Date:** 2026-08-15

**Revision:** 2026-08-15, after an adversarial review of §1–§9. The findings are
preserved verbatim in
[documentation/research/2026-08-15-faber-leaf-adversarial-review-architecture.md](../research/2026-08-15-faber-leaf-adversarial-review-architecture.md);
file/line references throughout this doc were verified at that commit and should
be re-checked before acting on them. The review changed three things structurally:
the coupling taxonomy in §2.2 (the couplings that stop the work are not
import-shaped), the enforcement story in the new §2.4 (the gates this plan used
to define *done* do not currently work), and the empty-host mitigation in §6
(LeafMesh alone does not mitigate it).

**Revision 2:** 2026-08-15, per direction from the project owner. **Sculptcore is
the default configuration** — it is what CI builds and tests on every PR, and the
submodule stays (§1, §4 W3, open decision #10); `faber-leaf-core` is a secondary
lane serving the embedding use case. And the unloaded-addon nstructjs round-trip
is now written as a **named, permanently-required invariant** with four separately
failable criteria (§4 W1 step 5, §8), rather than as BREP-delete cleanup.

---

<!-- toc -->

- [1. Goals](#1-goals)
- [2. Where we are today](#2-where-we-are-today)
  - [2.1 The removal surface](#21-the-removal-surface)
  - [2.2 The coupling map](#22-the-coupling-map)
  - [2.3 What is already good](#23-what-is-already-good)
  - [2.4 The gates do not work](#24-the-gates-do-not-work)
- [3. Target architecture](#3-target-architecture)
- [4. Workstreams](#4-workstreams)
  - [W0. Rename and rebrand](#w0-rename-and-rebrand)
  - [W1. Sever core → mesh, then delete the TS BREP](#w1-sever-core--mesh-then-delete-the-ts-brep)
  - [W2. Delete the TS sculpting stack](#w2-delete-the-ts-sculpting-stack)
  - [W3. Make sculptcore optional](#w3-make-sculptcore-optional)
  - [W4. Mesh-source-agnostic UV editor](#w4-mesh-source-agnostic-uv-editor)
  - [W5. Embeddability](#w5-embeddability)
- [5. Sequencing](#5-sequencing)
- [6. Risks](#6-risks)
- [7. Open decisions](#7-open-decisions)
- [8. Success criteria](#8-success-criteria)
- [9. Task list — the plans](#9-task-list--the-plans)
  - [9.1 Plan index](#91-plan-index)
  - [9.2 Tracks](#92-tracks)
  - [9.3 The plans](#93-the-plans)
  - [9.4 Where the open decisions land](#94-where-the-open-decisions-land)
  - [9.5 Where the success criteria are closed](#95-where-the-success-criteria-are-closed)

<!-- tocstop -->

---

## 1. Goals

Two product goals drive everything here:

1. **Extensible by addon.** A third party should be able to add a new geometry
   type, toolmode, editor, or renderer pass without patching `scripts/`.
2. **Embeddable.** A downstream app should be able to take Faber Leaf, drop
   half the builtins, add its own, and ship it inside its own product — with a
   build that does not require a C++/Emscripten toolchain unless it actually
   wants sculpting.

**Sculptcore stays the default configuration.** This refactor makes sculptcore
*removable*, not optional-by-default. The reference build — what developers run,
what CI builds and tests on every PR, and what ships — includes sculptcore and
its submodule. `faber-leaf-core` exists to serve the embedding use case in goal 2
and to keep the capability boundary honest; it is a second lane, not the primary
one. Read every "sculptcore-free" requirement below as *"the boundary is real and
tested"*, never as *"the default build drops sculptcore"*.

Both goals reduce to the same technical requirement: **the host must not know
about any concrete geometry type.** Today it knows about exactly one — the TS
BREP `Mesh` — and that single dependency is what makes the framework
un-embeddable and the addon boundary leaky.

The four asks in this refactor (delete TS BREP, delete TS sculpting, unpin
sculptcore, make the UV editor mesh-agnostic) are not four independent chores.
They are four consequences of enforcing that one rule.

---

## 2. Where we are today

### 2.1 The removal surface

Measured line counts (`.ts` + `.js`, excluding submodules):

| Subsystem | Location | Lines | Disposition |
| --- | --- | --- | --- |
| TS BREP mesh | `addons/builtin/mesh/src/` | 63,059 | **delete** |
| TS sculpt (PBVH) | `scripts/editors/view3d/tools/pbvh*.ts` | 15,236 | **delete** |
| TS sculpt tests | `scripts/test/test_sculpt*.js` | 3,714 | **delete** |
| Mesh-dependent addons | `subsurf`, `curve`, `tetmesh`, `mesh_edit` | 5,897 | **delete or rebase** |
| Tet solver | `scripts/tet/` | 3,874 | **delete or rebase** |
| Hair / strands | `scripts/hair/` | 354 | **delete** (dead-ish) |
| Legacy UV editor | `scripts/editors/image/pending-port/` | 3,007 | **rewrite** (W4) |
| **Total** | | **~95,000** | |

Retained and load-bearing:

| Subsystem | Location | Lines |
| --- | --- | --- |
| LiteMesh (sculptcore-backed geometry) | `scripts/lite-mesh/` | 15,307 |
| Sculptcore host bindings | `tools/`-adjacent `sculptcore*.ts` in view3d/tools | ~4,200 |
| Brush model | `scripts/brush/` | 2,741 (split needed) |
| Editors / UI | `scripts/editors/` | 47,776 (minus the above) |

The line counts above are exact (verified against `git ls-files`). The mesh addon
is **28.5%** of first-party non-vendor code — still the single largest lever
available, and still the *precondition* for everything else, because every other
builtin addon declares `"dependencies": ["mesh"]` and
`scripts/addon/manifest.ts:163-165` *throws* on an unknown dependency rather than
warning. Those manifests must be rewritten in the same change that deletes the
addon, not later.

### 2.2 The coupling map

`grep` for `addons/builtin/mesh` finds **50 files** outside the mesh addon
itself. They fall into seven classes, and the class determines the fix.

**Classes A–D are import-shaped and are what `grep` and dependency-cruiser can
see. Classes E–G are not, and they are the ones that actually stop the work.**
Every gate this plan uses to define *done* (§8) measures A–D only. Budget the
schedule against E–G.

**Class A — type-only leaks (cheap).** `core/lib_api.ts`, `core/context.ts`,
`editors/editor_base.ts`, `transform/transform_base.ts` import `type {Mesh}`.
These erase at compile time and the `core-no-addons` depcruise rule already
whitelists them. They disappear for free when `Mesh` disappears.

**Class B — enum leaks (cheap but structural).** The worst offender is
`scripts/editors/view3d/selectmode.ts:1`:

```ts
import {MeshTypes} from '../../../addons/builtin/mesh/src/mesh_base.js'

export const SelMask = {
  VERTEX: MeshTypes.VERTEX,   // the host's selection vocabulary is
  EDGE  : MeshTypes.EDGE,     // *defined by* the BREP's element enum
  ...
}
```

`SelMask` is the host's entire picking vocabulary (`findnearest.ts` gates on
it), and it is derived from a mesh-addon constant. `scripts/lite-mesh/litemesh_base.ts:1`
imports the same enum — meaning even the *new* geometry type is defined in
terms of the *old* one. `transform_types.ts` and `PropsEditor.ts` do the same
with `MeshFlags`.

**Class C — value imports from core-adjacent layers (real work).**
`data_api/api_define.ts` side-effect-imports six mesh modules and calls
`buildCDAPI` / `buildProcMeshAPI`. `view3d_draw.ts` imports `Mesh` as a value
and branches on element types. `PropsEditor.ts` imports `ProceduralMesh`,
`CDFlags`, `loadUndoMesh`/`saveUndoMesh`. `entry_point.js` imports and
*re-exports* five mesh modules as part of the public bundle surface. These are
genuine architectural violations that need a registry hook, not a delete.

**Class D — dependent features.** `scripts/tet/`, `scripts/hair/`, and the
`subsurf` / `curve` / `mesh_edit` / `tetmesh` addons are built on BREP element
types. They die with it unless deliberately rebased.

**Class E — inheritance (invisible to a delete plan).** The code that *survives*
inherits from the code being deleted:

- `scripts/editors/view3d/tools/sculptcore.ts:22` — `SculptCorePaintMode`
  **extends** `PaintToolModeBase`, imported from `./pbvh_base`. So does the whole
  stroke stack: `sculptcore_ops.ts:27,28`, `sculptcore_bindings.ts:9`,
  `stroke_paint_op.ts:13,14`, `stroke_driver.ts:14`, `stroke_driver_native.ts:21`
  pull `PaintSample` / `PaintSampleProperty` / `BrushProperty` / `SymAxisMap`
  from the pbvh files.
- `addons/builtin/curve/src/curve.ts:75` — `class CurveSpline extends Mesh`.
- `scripts/hair/strand_types.js:36` — `class Strand extends CurveSpline`.

The fix for E is always a *hoist first, delete second* step. It cannot be
scheduled as part of the deletion PR.

**Class F — string-keyed (invisible to every tool we own).** No import graph,
depcruise rule, `instanceof` grep, or typecheck sees any of these:

- `scripts/data_api/api_define.ts:339-344` — `getStructByName('mesh.Mesh')` and
  **throws** if absent. `getDataAPI()` is called from the `AppState` constructor,
  so deleting the mesh addon makes the app fail at boot.
- `scripts/editors/view3d/view3d.ts:680` — a host keymap hardcodes
  `'mesh.vertex_smooth()'`; `widgets/widget_tools.ts:580` throws if the mesh
  addon's `InsetHoleOp` was never registered.
- Six keymap strings hardcode the numeric select mask `selmask=17`
  (`mesheditor.ts:391,392`, `meshtool.ts:67`, `curvaturetool.js:49`,
  `subsurf_tangent_test.js:655-657`).
- `scripts/core/legacy_struct_migration.ts:34-102` is a rename table whose
  entries point *into* the deletion set.

**Class G — serialization (a file-format problem wearing a refactor's clothes).**

- **Struct ids shift.** nstructjs assigns ids by global registration order
  (`vendor/nstructjs/src/struct_intern.ts:376`) and embeds them inside every
  `abstract(...)` payload (`struct_intern2.ts:859-860,878-881`). Removing ~50
  `mesh.*` registrations renumbers everything after them.
- **The missing-class net covers one of the two struct paths.** The hooks live in
  `StructTStructField` — the `abstract(T)` path (`struct_intern2.ts:854-855` on
  write, `:1006-1008`/`:1035-1037` on read). `CurveSpline._elists :
  array(mesh.ElementList)`, `hair.Strand.eidgen : mesh.EIDGen` and
  `tet.TetElementList.customData : mesh.CustomData` are **concrete** struct
  fields, which go through `StructStructField.pack` (`:735-739`) — no hook, just
  `get_struct` on the declared name, which throws. Files containing curve /
  strand / tet blocks **throw on save** after the delete. Containers inherit
  their element type's path (`StructArrayField.pack:1142` recurses via
  `do_pack`), so `array(abstract(T))` is safe and `array(T)` is not.
- **`SelMask` is persisted as raw ints in three places** with no name table:
  `scripts/scene/scene.ts:350`, `scripts/editors/view3d/view3d_toolmode.ts:549`
  (and `scene.ts:354` serializes `toolmodes : array(abstract(ToolMode))`, so
  *every* toolmode the user ever visited carries one), and
  `scripts/editors/view3d/tools/boxmodel.ts:31-43`.
- **Every save embeds every registered toolmode.** Because of `scene.ts:354`,
  the freshly-generated LiteMesh fixtures `examples/tests/multiresBasic.wproj`
  and `textureCube.wproj` already contain `mesh_edit.MeshEditor`,
  `curve.CurveToolBase`, `tetmesh.TetMeshTool`, nine `tet.*` structs and ~50
  `mesh.*` structs. New fixtures are not clean fixtures.
- **`.wproj` can embed a serialized toolstack** (`scripts/core/appstate.ts:370-371`,
  a user-facing option), containing ToolOp instances of classes about to be
  deleted. `examples/brush_asymmetric_toolstack.wproj` already embeds
  `BrushProperty` / `PaintSample` / `PaintSampleProperty` — the exact Class E
  types above.

Separately, **sculptcore is coupled through pnpm, not just imports**.
`pnpm-workspace.yaml` lists six sculptcore paths as workspace packages, and
`scripts/package.json` declares `"@sculptcore/api": "workspace:*"`. So the
alias `@sculptcore/api` is resolved by pnpm workspace linking. A missing
`sculptcore/` directory today is not "sculptcore disabled" — it is "install
and typecheck are broken." (Verified in this session: with submodules
unchecked-out, `sculptcore/` is empty and nothing resolves.)

### 2.3 What is already good

This refactor is not starting from zero. Prior passes left most of the
scaffolding in place, and the strategy should exploit it rather than reinvent:

- **`AddonAPI` register/unregister dispatch** (`scripts/addon/addon_base.ts`)
  already handles ToolOp / ToolMode / DataBlock / CustomDataElem /
  SceneObjectData / Editor / nstructjs from one call, tracked per addon so
  disable cleanly tears down.
- **`core/data_kinds.ts`** is exactly the right registry — `registerDataKind({id, factory, importFromBytes, ...})`, consumed by core via callbacks. It exists and is under-used.
- **`core/missing_addon.ts`'s `MissingToolMode` path works and is tested.**
  `Scene.toolmodes` is `array(abstract(ToolMode))`, so the nstructjs
  `onUnknownClass`/`onSerializeUnknown` hooks engage and re-emit under the
  original struct id (`missing_addon.ts:267-275`, covered by
  `tests/integration/graph_missing_nodes.test.ts:117-152`). *Only* that path
  works, and it works because the field is `abstract(...)` — the
  `MissingDataBlock` / `OpaqueCustomDataElem` halves and every concrete struct
  field do not (§4 W1 step 5). So this is a proven mechanism on one path, not a
  working safety net.
- **`SceneObjectData`** already owns the picking contract (`castViewRay`,
  `findNearest`, `castScreenCircle`, `castScreenRect`) so `findnearest.ts` is a
  thin dispatcher. LiteMesh already implements it.
- **`@framework/api` + `@addon/<id>/api`** aliases, the esbuild plugins behind
  them, and `tools/check-addon-duplication.js` are wired and working. The
  `.dependency-cruiser.cjs` layer rules are *not* — see §2.4.
- **`LiteMesh` is essentially already decoupled.** Its only mesh-addon import
  is the `MeshTypes` enum (Class B). Everything else routes through
  `@sculptcore/api`, `SceneObjectData`, and the render queue.
- **The integration suite is already sculptcore-first.** Of 28 integration
  tests, nearly all are `sculptcore_*` / `litemesh_*`. Almost no test coverage
  is lost by deleting the BREP. One exception matters:
  `tests/integration/tetmesh_real_build.test.ts` is the **only** test that
  `tools/build-addons.js` produces a working external per-addon bundle with a
  correct `index.json` dependency entry — and W5's embeddability story rests on
  that pipeline. It must be re-pointed at a surviving addon before `tetmesh` is
  deleted.
- **The UV editor was already slimmed** and its legacy parked under
  `pending-port/` with a written port checklist that *already names* the
  mesh-agnostic abstraction as the blocker. Confirmed: those 3,007 lines of code
  (3,104 with the checklist) are genuinely unreferenced by the rest of the tree.
- **The render queue is genuinely generic.** `scripts/render/queue.ts` is 90
  lines and `scripts/renderengine/renderengine_realtime.ts:1-27` imports nothing
  from sculptcore or lite-mesh; the sculptcore protocol at `:1254-1262` is
  duck-typed and skippable, and non-BREP geometry already draws in 12 lines
  (`scripts/light/light.js:94-105`). A new geometry with a plain `drawQ` gets
  NormalPass/SSAO for free — which LiteMesh does not (`:1376` skips it).
- **The default-scene registry is proven in production.**
  `scripts/core/default_file.ts` is a clean 49-line last-writer-wins registry,
  and `scripts/lite-mesh/litemesh_default_scene.ts:25-56` already overrides the
  mesh cube with a LiteMesh sphere. The startup scene does not need the mesh
  addon at runtime.
- **The shader-node layer is already mesh-agnostic.**
  `scripts/shadernodes/shader_nodes.ts:715-721` declares `IAttrItem` as an
  explicitly duck-typed interface with a fallback at `:824-838`;
  `shader_nodes_wgsl.ts` imports nothing from the deletion set.
- **`scripts/path.ux`, `scripts/mathl` and the native/WASM backend seam are
  clean.** Neither submodule references the deletion set, and
  `sculptcore/typescript/api/wasm.ts:531-551` / `nativeBackend.ts:331-367`
  already degrade gracefully. The sculptcore optionality problem is entirely
  *upstream* of that seam (pnpm, esbuild, entry point), not in it.

The honest read: the previous refactor built the seams and stopped before
walking through them. This one walks through them and deletes what's behind —
but it has to build the enforcement first, because the seams were never
load-bearing.

### 2.4 The gates do not work

§8 defines *done* in terms of `pnpm check:layers` and a green `pnpm test`. Both
are near-vacuous today, and every phase boundary in §5 inherits that. Fixing
this is the **first** phase, not a step inside a later one.

**Dependency-cruiser.** A run today reports `288 dependency violations (0 errors,
288 warnings)`, and the 288 are almost entirely `no-circular`:

- `.dependency-cruiser.cjs:23,39` — `core-no-mesh` and `util-no-mesh` both target
  `to: {path: '^scripts/mesh/'}`. **That directory has not existed since the
  addon migration.** Two of the four layer rules are dead.
- `:51-52` — `core-no-addons` excludes all of `scripts/editors/` and permits
  `type-only` imports. It is also direct-dependency-only, so
  `core/context.ts → tet/tetgen.js → addons/builtin/mesh/src/bvh.js` is invisible
  (`scripts/tet/` and `scripts/hair/` are not in the `from` set).
- `:67-79` — `options.exclude.path` drops `scripts/renderengine` and
  `scripts/shadernodes` from the graph entirely, so the renderer's coupling is
  unmeasurable by construction.
- `tools/check-layers.js:22` crashes with `spawn EINVAL` on Windows, and can only
  fail the build on `error`-severity findings.

Repointing `core-no-mesh` / `util-no-mesh` at `^addons/builtin/mesh/`, dropping
the `scripts/editors/` carve-out and the type-only exemption, and un-excluding
`renderengine` / `shadernodes` will make the number go **up** sharply before it
goes down. *That* number, not today's 288/0, is the real W1 budget — and it
cannot be estimated until the rules are repaired.

**There is no PR CI.** `.github/workflows/deploy-pages.yml` is the only workflow
in the repo. It builds and deploys on push to `master`; it runs no test, no
typecheck, no lint, and no `check:layers`. Every "ends at a green `pnpm test`"
phase boundary in §5 is currently a claim no machine checks.

**Typecheck barely covers the addons.** The root `tsconfig.json` uses `files`
rather than `include`, so addon sources enter the program only through
`typescript_entry.ts`'s mesh imports — the very imports W1 deletes. And
`scripts/tsconfig.json` has no `paths` block at all, so anything under
`scripts/` importing `@addon/<id>/api` typechecks only from the repo root.

**Consequence for the plan.** The three gates §8 leans on measure classes A–D
(§2.2) and would not catch a single one of the Class E/F/G couplings. They are
necessary but not sufficient; §8 has been rewritten accordingly.

---

## 3. Target architecture

Four layers, with a hard rule at each boundary.

```
┌─ Layer 0: kernel ──────────────────────────────────────────────┐
│  util, math, graph, DataBlock/Library, nstructjs, path.ux       │
│  RULE: knows nothing about 3D scenes.                           │
├─ Layer 1: host ────────────────────────────────────────────────┤
│  Scene, SceneObject, SceneObjectData, ToolStack/undo, Data API, │
│  render queue + WebGPU frame graph, editors shell, addon mgr,   │
│  registries: data_kinds, default_file, file_migrations,         │
│              missing_addon, feature flags                       │
│  RULE: zero imports of any concrete geometry type. Enforced by  │
│        dependency-cruiser at severity: error.                   │
├─ Layer 2: capability providers (addons) ───────────────────────┤
│  litemesh (sculptcore-backed)  │  <your geometry type here>     │
│  sculpt toolmode               │  boxmodel toolmode             │
│  uv editor                     │  node/material editor          │
│  RULE: talk to Layer 1 via @framework/api only; to each other   │
│        via @addon/<id>/api only.                                │
├─ Layer 3: distributions ───────────────────────────────────────┤
│  faber-leaf (full DCC)  │  faber-leaf-core (embeddable, no C++) │
│  <downstream app's custom bundle>                               │
│  RULE: a distribution is a manifest + entry file, not a fork.   │
└────────────────────────────────────────────────────────────────┘
```

Four interfaces carry the whole design. Getting these right is 80% of the value;
everything else is mechanical deletion. **All four are larger than they look**,
and under-sizing them is the way this refactor fails — it produces a host that
compiles without `Mesh` but cannot do anything with what replaces it.

**(a) `IGeometrySource` — what the host is allowed to ask geometry.**
Generalize the existing `SceneObjectData` contract into an explicit, documented
interface. The obvious half — bounds, transform, draw submission, the four
picking entry points, selection state, undo push/pop — maps onto
`SceneObjectData:153,186,220,274,305,346,348,352,354` and is roughly **eight of
the twenty-two things the host actually demands today**. The rest, all of which
the host uses and none of which can be dropped:

| Capability | Where the host demands it |
| --- | --- |
| Kind identity + factory + import | `core/data_kinds.ts:1-58`; `sceneobject_base.ts:405`; `context.ts:222,318,362` |
| Element iteration + stable eids | `transform_types.ts:78,92-93,334,340-341,470,485,552-553`; `view3d_draw.ts:170-222` |
| Invalidation / regen protocol (9 methods) | `transform_types.ts:367-368,498,500,670-671,699,712,716-717`; `PropsEditor.ts:166,189-196,235-237` |
| Spatial acceleration | `transform_types.ts:110-115` (`mesh.getBVH().closestVerts`); `PropsEditor.ts:633-637` |
| Material slots + shader/attribute negotiation | `sceneobject_base.ts:56-58`; `renderengine_realtime.ts:1226-1299` |
| CustomData layers | `PropsEditor.ts:138,168,367-387,494-513`; `api_define.ts:312` |
| Self-description (`defineAPI` / `getTools` / `buildPropertiesTab` / `_ownSelectMask`) | `sceneobject_base.ts:72,101,128,181,419` |
| Graph participation (`inputs.depend`, `exec`, `SAVE_PROXY`) | `sceneobject_base.ts:80,124`; `sceneobject.ts:279-293` |
| Datablock lifecycle (`copy`, `copyAddUsers`, `dataLink`, `destroy`, `swapDataBlockContents`, `onContextLost`) | `sceneobject_base.ts:149,358,360`; `sceneobject.ts:269,364-380,410-417` |
| Undo beyond push/pop (`calcUndoMem`) | `toolstack.js:7-8,29-41`; `transform_ops.ts:265-294` |
| `applyMatrix` (bake into coords) | `sceneobject_base.ts:67` |
| Triangle extraction for export | `stlformat.js:13,33,40-43`; `app_ops.js:203-228` |
| Symmetry / mirror state | `transform_types.ts:85,246` |
| Active / highlight element (shader uniforms) | `view3d_draw.ts:302-368` |

Anything the host currently learns by `instanceof Mesh` must become a method here
or a `data_kinds` descriptor field. `SelMask` moves *out* of mesh vocabulary and
becomes host-owned: `SelMask.OBJECT` plus a per-kind sub-mask block that each
provider claims at registration — subject to the format constraints in §4 W1
step 1, which are severe.

**(b) `ITransDataType` — the second geometry interface, and it already exists.**
`scripts/editors/view3d/transform/transform_base.ts:108-141` defines 13 required
methods; `transform_ops.ts:177` hardcodes the type list `['mesh','object','litemesh']`;
and `MeshTransType` is **745 lines living in the host** (`transform_types.ts:38-782`).
Proportional edit, per-element transform, and snapping all run through it. It is
not a subset of `IGeometrySource` and must be planned as its own surface, with
its registration moved onto `AddonAPI` (today
`scripts/lite-mesh/litemesh_transtype.ts:202` is a bare module-scope
`TransDataType.register(...)`, which this project's own addon rules forbid).

**(c) `IUVSource` — the mesh-agnostic UV contract (W4).** See §4 W4.

**(d) `AddonAPI` — already exists.** Extend it, don't replace it.
`scripts/addon/addon_base.ts:331-405` dispatches ToolOp / DataBlock / ToolMode /
CustomDataElem / Editor / SceneObjectData / nstructjs / `defineAPI`. It has **no
case** for `TransDataType`, `DataKind`, `DefaultSceneBuilder`, `FileMigrator`,
`UVSource`, or a properties-panel contribution — all of which a geometry addon
needs, and all of which register at module scope today. Add those cases, plus a
capability query (`api.has('sculptcore')`) so addons can degrade instead of
crash. Until this lands, success criterion #12 is unachievable by construction.

### The vertex-layout contract is part of the architecture

Attribute-driven materials cannot work for a new TS geometry type without an
engine change, and no workstream below currently owns it.
`scripts/shaders/wgsl_shaders.ts:1361-1370`:

```ts
export function buildMaterialPipelineDescriptor(wgsl: string, label: string): PipelineDescriptor {
  return {label, wgsl, vertexBuffers: LIT_MESH_VERTEX_LAYOUT, ...}
}
```

The doc comment immediately above it states outright that a material with an
`AttributeNode` declares `@location(2+)` inputs this fixed layout does not
supply, and that *"those materials only render correctly through the
LiteMesh/sculptcore draw path."* The only dynamic vertex-layout builder in the
tree is `scripts/webgpu/batch.ts:380-443`, which is 100% sculptcore-bound
(`import {Buffer, DrawBatch, DrawCommand, ShaderDef} from '@sculptcore/api'`).

Generalizing that builder and threading it through both compile sites
(`renderengine_realtime.ts:708`, `view3d_draw_webgpu.ts:490`) is engine work
outside any geometry addon. It belongs to whoever ships the second geometry type,
and it is the difference between "LeafMesh renders" and "LeafMesh renders the
material system users actually author."

One further caveat against "just use the render queue": `scripts/camera/camera.ts:163,165`
calls `queue.scheduleRawGLPass(...)`, which **throws** on the WebGPU adapter
(`scripts/webgpu/queue_adapter.ts:229-234`). The queue is generic; it is not yet
uniformly used.

The rule that makes all of this stick: **when the host needs to know something
type-specific, it asks the registry, never the type.**

---

## 4. Workstreams

### W0. Rename and rebrand

Not the trivia it looks like: **the old name is also six runtime storage keys**,
so this is a user-data migration with a rename attached.

Already done outside this plan: the GitHub remote is `joeedh/faber-leaf`, and
`index.html:15` is already `<title>FaberLeaf</title>`. The rename is therefore
*half-applied* right now, which is the state that breeds inconsistency bugs.

**Cosmetic (safe).**

- `package.json` name `webgl-app-framework` → `faber-leaf`; `Readme.MD`.
- The tests workspace package is `@webgl-app-framework/tests-integration`
  (referenced in the root `test:slow` script) — rename together.
- `scripts/package.json` is confusingly named `@sculptcore/frontend` for what
  is the *app*, not sculptcore. Rename to `@faber-leaf/host`.
- Leave `@sculptcore/api` alone — that is the real sculptcore package name.
- `tools/publish-gh-pages.sh:14` still clones the old URL. It resolves today only
  through GitHub's rename redirect and breaks the moment anyone claims the old
  name.
- `.gitmodules` needs no change (the four submodules are separate repos), and
  `.github/workflows/deploy-pages.yml` hardcodes no repo name or base path
  (`:127-129` — all app references are relative), so only the published URL moves.

**Load-bearing (needs a migration).** Each of these is the old name used as a
persistent key:

| Key | Location | Cost of renaming blind |
| --- | --- | --- |
| `APP_KEY_NAME` | `scripts/core/const.ts:2` | — |
| localStorage `webgl-app-framework` → `startup.bin` | `scripts/core/app_storage.ts:97-98` | the user's startup scene |
| localStorage `webgl-app-framework-settings` | `app_storage.ts:97-98`, `scripts/core/settings.ts:44` | all app settings |
| IndexedDB database `webgl-app-framework-addons` | `scripts/addon/storage.ts:189` | **every installed third-party addon vanishes** |
| NW.js profile + `.cache` dir | `nwjs/profile_dir.mjs:22,24` | profile and crashdump location moves |
| `package.json` `name` | `package.json:2` | it is *simultaneously* the pnpm root name, the NW.js manifest name, and the key Chromium derives the profile and Crashpad dir from (`nwjs/window.html:18-23`) |

Two options, and this is a call to make explicitly (§7 decision 7): freeze the
storage keys at the old string permanently and rename only the cosmetics, or
rename them behind a one-time migration that copies the localStorage entries and
renames the IndexedDB database on first run. The second is correct for a shipping
product; it is migration code, not a find-and-replace.

### W1. Sever core → mesh, then delete the TS BREP

The order matters: **sever first, delete second.** Deleting first turns 50
files red simultaneously and the migration becomes un-reviewable.

**Step 0 — sever the Class E and Class F edges.** These are invisible to the
import graph, so they must be listed by hand and fixed before anything else:

- `data_api/api_define.ts:339-344` — the `getStructByName('mesh.Mesh')` throw,
  reached from the `AppState` constructor. Also in this file: six mesh
  side-effect imports (`:18-20,33,38,41`) and `buildCDAPI` (`:312`) /
  `buildProcMeshAPI` (`:328`) — the customdata-layer and procedural-generator
  data APIs live in *core*, defined against BREP types.
- `core/context.ts:17,18` — **value** imports of `TetMesh` and `StrandSet`, used
  in `instanceof` at `:283` and `:311`.
- `editors/view3d/view3d.ts:36` — side-effect import of the `mesh_edit`
  toolmode; `:680` — a host keymap hardcoding `'mesh.vertex_smooth()'`;
  `widgets/widget_tools.ts:580` — throws if the mesh addon's `InsetHoleOp` is
  unregistered.
- `addon/addon_base.ts:190-195` — `MeshToolBase` / `MeshEditor` are on the
  *public* `AddonAPI`; `:381,520` resolve `CustomDataElem` via
  `lookupAddonExport('mesh', 'mesh')`.
- `scripts/tet/tetgen.js:17-19` and `framework_api.ts:89-92` — `@framework/api`
  deliberately re-exports `TetMesh` / `TetTypes` / `tetSolve` to avoid
  duplicate-struct registration. That deliberate coupling has to be unwound, not
  just deleted.
- `core/legacy_struct_migration.ts:34-102` — a rename table pointing into the
  deletion set.

**Step 1 — host-owned selection vocabulary. This is a file-format change.**
Move the `MeshTypes`/`MeshFlags` constants the host needs into
`scripts/editors/view3d/selectmode.ts` (or a new `scripts/core/select_types.ts`)
and invert the dependency: the mesh addon imports from the host, not the reverse.
Fix `selectmode.ts:1`, `transform_types.ts:4-5`, `PropsEditor.ts:2,32`, and —
importantly — `litemesh_base.ts:1`. This alone unblocks LiteMesh from ever
needing the mesh addon again.

But the §3(a) proposal — a dynamically allocated per-kind sub-mask block — cannot
land as a pure refactor, because the bits are persisted (Class G) *and*
structurally pinned:

- `SelMask.VERTEX/EDGE/FACE/HANDLE` are **aliases of `MeshTypes`**, which is
  serialized per-element as `mesh.Element.type : byte` and
  `mesh.ElementList.type : int`. Bits 1/2/4/8/16 are locked by the mesh file
  format and must stay statically reserved forever, even after the BREP is gone.
- `selectmode.ts:51` — `OBJECT` is a hardcoded `(1<<8)|…|(1<<15)` composite with
  exactly **one** unnamed free slot (bit 10).
- `sceneobject_ops.js:108` — `if (selmask == SelMask.OBJECT)`, exact equality
  against that composite. Under dynamic allocation it silently stops matching.
- `litemesh.ts:4068-4070` — a raw `(tmSel & 1) !== 0` with a comment naming the
  numeric value.
- 144 hardcoded uses across 42 files, plus the six `selmask=17` keymap strings,
  and `addon/addon_base.ts:165` hands addons a live mutable reference to the mask
  object.
- Allocation order is not stable across machines: `addon/addon.ts:492-501`
  enables newly-installed addons at arbitrary later points, and enable/disable
  are user-driven.

The persisted values also survive restarts through the startup slot
(`appstate.ts:996-1008` → `gen_default_file.ts:121-133`), so a bit reallocation
silently changes the user's selection mode on next launch.

**Required approach:** persist *names*, not bits, in all three `SelMask` fields;
bump `APP_VERSION` with a migrator; keep 1/2/4/8/16 statically reserved; convert
`OBJECT` comparisons to `&`-tests; and replace the numeric keymap strings. That
work lands **before** any dynamic allocation, and it is large enough to be its
own plan.

**Step 2 — registry-ize the Class C value imports.**
- `data_api/api_define.ts`: replace the six mesh side-effect imports and the
  `buildCDAPI`/`buildProcMeshAPI` calls with an "API contributor" hook that
  addons call from `register(api)`. The `registerDataAPI` mechanism in
  `data_api/api_define_registry.js` (already used by LiteMesh) is the model.
- `view3d_draw.ts`: it should submit through the render queue for whatever
  `SceneObjectData` says is drawable, with no `Mesh` value import.
- `PropsEditor.ts`: mesh-specific panels become addon-contributed panels
  (`api.registerPropsPanel(...)`), not core-resident code branching on type.
- `entry_point.js`: delete the mesh imports **and the `export {mesh, mesh_types,
  customdata, mesh_customdata, mesh_base}` re-export** — that re-export is a
  public API commitment to the BREP and must go.

**Step 3 — repair the depcruise rules, re-baseline, then flip to `error`.**
The rules are `severity: warn` today with the comment "convert to error in the
cleanup pass," but flipping them as written would prove nothing — two of the four
target a directory that no longer exists (§2.4). The sequence is: repair
(`^scripts/mesh/` → `^addons/builtin/mesh/`; drop the `scripts/editors/`
carve-out and the type-only exemption; un-exclude `renderengine` /
`shadernodes`; add `scripts/tet/` and `scripts/hair/` to the `from` set; fix the
Windows `spawn EINVAL` at `check-layers.js:22`) → re-baseline and *publish the
real violation count* → drive it to zero → flip to `error`. Add
`core-no-litemesh` and `core-no-sculptcore` at the same time so the new geometry
type cannot re-create the problem it was meant to solve. Wire
`pnpm check:layers` into CI as a blocking gate — which first requires there to
*be* a PR CI workflow (§2.4).

**Step 4 — delete.** `addons/builtin/mesh/`, plus `subsurf`, `curve`,
`mesh_edit`, `tetmesh`, plus `scripts/tet/` and `scripts/hair/`, plus their
`@framework/api` re-exports (`TetMesh`, `TetTypes`, `meshToTetMesh`,
`tetSolve`, …), plus `tools/migrate-mesh-registers.js`,
`addons/builtin/builtin_data_api.ts`, and the `IN_BUNDLE_BUILTIN_IDS` entries
in `tools/check-addon-duplication.js`.

**Step 5 — file compatibility. This is a workstream, not a decision.** The
original framing offered a choice between (a) opaque round-trip through
`missing_addon.ts`, (b) a BREP→LiteMesh importer, and (c) a declared format
break, recommending (a) on the grounds that "the placeholder machinery already
exists and works." It does not. Option (a) is still the right answer, but it must
be *built*, and it must land before the delete.

**The invariant to build against — state it once and test it directly:**

> A `.wproj` containing data from an addon that is **not loaded** must survive
> load → save → load with that addon's bytes unchanged, its identity (`lib_id`)
> unchanged, and every reference to it from loaded data still resolving.

"Not loaded" is deliberately broader than "deleted". It covers a disabled addon, a
third-party addon the recipient never installed, `faber-leaf-core` opening a file
written by the full build, and the BREP after W1 — one mechanism for all four. The
invariant has three parts, and nstructjs today satisfies only the first.

1. **Bytes.** The unknown block's payload is preserved verbatim and re-emitted
   under its original struct name.
2. **Identity.** The placeholder keeps the `lib_id` it was loaded with, so
   `DataRef`s from loaded blocks still resolve.
3. **Decodability.** The struct ids inside the preserved bytes still mean the same
   structs the next time the file is read.

- **Old `.wproj` files crash on load today.** `core/lib_api.ts:1033` writes
  `libmap[blockType]` for every BlockSet *before* the registered-type check at
  `:1041`; `:1044-1046` then removes the lib without calling `afterLoad`, so
  `lib.datalib` is never set. `appstate.ts:806` reaches `BlockSet.push`
  (`lib_api.ts:615-617`), which does `block.lib_id = this.datalib.idgen.next()`
  on `undefined`. TypeError, no guard.
- **Fix that and the scene graph still breaks silently.**
  `MissingDataBlock.fromUnknownBlock` (`missing_addon.ts:82-89`) never parses the
  preserved bytes, so `lib_id` stays `-1` and `push()` assigns a fresh one. The
  `SceneObject`'s `DataRef` still carries the original id, resolves to
  `undefined`, and `sceneobject.ts:413-416` substitutes a `NullObject`. On the
  next save `DataRef.fromBlock` yields `lib_id = -1`. **The object→geometry
  association is destroyed permanently while the mesh bytes sit intact in the
  file.**
- **The unknown-class net covers one of nstructjs's two struct paths.** The hooks
  are consulted only from `StructTStructField` — the `abstract(T)` path — where
  `struct_intern2.ts:854-855` asks `onSerializeUnknown` for a replacement struct
  name on write, and `:1006-1008` / `:1035-1037` route an unresolvable name
  through `onUnknownClass` on read. A field declared as a **concrete** struct type
  goes through `StructStructField.pack` (`:735-739`), which looks up the *declared*
  struct and calls `manager.write_struct` against it unconditionally — no hook, no
  placeholder. That is why `MissingToolMode` works (`scene.ts:354` is an
  `array(abstract(ToolMode))`) and curve / strand / tet blocks **throw on save**.
  `StructArrayField.pack:1142` and the iter fields recurse through `do_pack`, so
  each container inherits whichever path its element type is: `array(abstract(T))`
  is covered, `array(T)` is not. Extending the hooks to `StructStructField` is a
  change in `vendor/nstructjs`, not in the app — budget for it as one.
- **The preserved bytes do not stay decodable.** Struct ids are assigned by global
  registration order (`struct_intern.ts:376`) and embedded in the payload, so
  removing or reordering an addon renumbers structs the preserved bytes still
  reference (Class G). Either pin struct ids in the format or rewrite the ids
  inside `_origBytes` on save — including inside nested `abstract(...)` payloads,
  which is the part that makes rewriting harder than it looks (open decision #3).
  Note this bites the *default* build too: adding a builtin addon shifts ids for
  every addon registered after it.
- **The CustomDataElem half of the net lives inside the addon being deleted.**
  `missing_addon.ts:34-44` holds a `null` slot filled by
  `registerOpaqueCustomDataElem`, called from
  `addons/builtin/mesh/src/missing_customdata.ts:44`. Delete the addon and
  `opaqueCustomDataElemCls` is permanently `null`. Move it into core.
- **The keying test is inverted.** `missing_addon.ts:262` requires
  `clsname.includes('CustomData')`, but the real elem names are
  `mesh.UVLayerElem`, `mesh.MaskElem`, `mesh.ColorLayerElem`, … — none match,
  while `mesh.CustomDataLayer` (a layer *descriptor*) does. Key off the schema,
  not the name.
- **There is no test.** `tests/integration/graph_missing_nodes.test.ts:8-13`
  states it cannot import `missing_addon.ts` and uses synthetic classes instead;
  the intended fixtures at `tests/lib/scene-fixture.ts:14-19,22-47` are stubs
  that throw. `examples/error-test.wproj` (117 KB, exactly one BREP `mesh`
  block) is the ideal round-trip fixture.

Also in scope here: **file migrations are owned by the addon being deleted.**
`addons/builtin/mesh/src/migrations.ts:33,46` registers the v5/v6 migrators, and
`core/file_migrations.ts:60-62` swallows migrator throws into `console.error` —
a failed migration silently produces a corrupt scene. `appstate.ts:1010-1025`'s
`version < 4` path iterates `datalib.mesh`, which becomes `undefined` once `mesh`
is not a registered BlockType. And there is no minimum-version floor:
`appstate.ts:654-660` checks only the `WPRJ` magic, and a version-0 file
(`examples/sculpt test.wproj`) is still loaded by a live green test.

**Boxmodel is the thing to watch.** `scripts/editors/view3d/tools/boxmodel.ts`
and `scripts/lite-mesh/litemesh_modeling_ops.ts` (1,592 lines) are the
LiteMesh-side polygon-modeling toolmode — this is the *replacement* for
`mesh_edit`, and it is sculptcore-backed. That means "delete the BREP" and
"make sculptcore optional" are in direct tension: with sculptcore absent, the
host has **no** geometry type at all. §7 covers the resolution.

### W2. Delete the TS sculpting stack

**This is not leaf code, and it must not go first.** An earlier draft of this
strategy called it "leaf code with almost no inbound dependencies" and scheduled
it as the low-risk opener. That is false in the most direct way possible: the
sculptcore toolmode that *survives* inherits from the pbvh code being deleted
(Class E). `pbvh_base.ts` (2,073 lines) and `pbvh_paintsample.ts` (300) are the
inheritance and property-type root of the surviving stroke stack.

**Step 0 — hoist the stroke base.** Extract `PaintSample`,
`PaintSampleProperty`, `BrushProperty`, `SymAxisMap`, and the non-BVH half of
`PaintToolModeBase` into a `stroke_base.ts` with no BREP imports. Re-point
`sculptcore.ts`, `sculptcore_ops.ts`, `sculptcore_bindings.ts`,
`stroke_paint_op.ts`, `stroke_driver.ts`, `stroke_driver_native.ts`. Land it,
verify strokes still work, *then* delete. Note `examples/brush_asymmetric_toolstack.wproj`
embeds `BrushProperty` / `PaintSample` / `PaintSampleProperty` in a serialized
toolstack, so the hoist must preserve their struct names or carry a migration.

**Step 1 — delete the true leaf set**, which is six files, not nine:
`pbvh_sculptops.ts`, `pbvh_texpaint.ts`, `pbvh_texpaint_blur.ts`, `pbvh_ui.ts`,
`pbvh_holefiller.ts`, `pbvh_bvhdef.ts`. `pbvh.ts` (2,584) and the residue of
`pbvh_base.ts` / `pbvh_paintsample.ts` go only after step 0 lands.

- Delete `addons/builtin/pbvh_sculpt/` and its `@framework/api` surface.
- Delete `scripts/test/test_sculpt.js` + `test_sculpt_run.js` (3,714 lines).
- `pbvh_sculptops.ts` is 7,842 lines — large, but the 5th-largest file in the
  tree, not the largest.
- Delete the BREP-side dyntopo/multires: `mesh_grids*.ts` (~11k lines),
  `mesh_displacement.ts`, `multigrid_smooth.js`, `mesh_remesh.js` — these go
  with W1 but are worth calling out as sculpting code specifically.

**`scripts/brush/` splits rather than dies.** `brush.ts` (1,282 lines) defines
`SculptBrush`, which `sculptcore_ops.ts` consumes as its brush-settings model.
`brush_dyntopo.ts` is PBVH-side (delete); `brush_dyntopo_sc.ts` is
sculptcore-side (keep). Extract a backend-neutral brush *model* (channels,
dynamics, presets — genuinely reusable UI state) into the host and move the
sculptcore-specific mapping into the sculpt addon. `scripts/webgpu/brush_compute.ts`
needs the same audit.

**Texture painting is a real loss.** `pbvh_texpaint.ts` (1,206 lines) is the
only texture-paint implementation. Deleting it removes the feature until
sculptcore provides an equivalent. Flag this to the user as a scope decision,
not a silent casualty.

### W3. Make sculptcore optional

The unit of change is **not** "swap `.gitmodules` for a clone script." It is
"the app boots, renders, and passes a smoke suite with `sculptcore/` absent."

**Step 0 — the addon manager cannot express "optional" yet.** Build this first;
everything below assumes it:

- `"optional": true` **does not exist**. `scripts/addon/manifest.ts:9-47` defines
  the interface without it, and `validateManifest` at `:123-135` returns a
  whitelisted object rather than rejecting unknown keys — so writing it into a
  manifest today is silently a no-op.
- `"buildMode": "prebuilt"` is **inert for builtins**. Its only behavioral use is
  `scripts/addon/install.ts:113`, on the third-party zip path.
- A missing dependency is fatal, not degraded: `manifest.ts:163-165` *throws*
  from the topological sort; `addon.ts:430-439` returns
  `{ok:false, reason:'missing-dep'}`.
- `tools/addon_api_plugin.js:54-58` makes esbuild **error** when
  `addons/builtin/<id>/src/api.ts` is absent. There is no absent-addon code path
  in the build at all.

So step 0 is: add real optional-dependency semantics to the manifest schema, the
validator, the topo sort, `enable()`, and the esbuild plugin — with a test.
Note also that `addons/*` is a workspace glob but `addons/builtin/*` is **not**,
so a new `addons/builtin/<id>/package.json` is not picked up today.

**Step 1 — a real capability boundary.** Everything that imports
`@sculptcore/api` (30+ files, essentially all of `scripts/lite-mesh/` plus the
sculpt toolmode) moves behind one gate. Two viable shapes:

- *Addon-shaped (recommended).* `scripts/lite-mesh/` and the sculpt/boxmodel
  toolmodes become a real addon — `addons/builtin/litemesh/` — declared optional
  via the step-0 mechanism. Absent sculptcore, the addon is simply not
  registered; the hardened `missing_addon.ts` (W1 step 5) covers the file-load
  path. This is the shape that also serves W5, because a downstream embedder
  wants exactly this switch.
- *Lazy-import-shaped.* Keep the files where they are and gate every entry on
  `await getWasm()`. Less churn now, but leaves ~19k lines of sculptcore-
  dependent code inside the host, which defeats both goals.

Take the addon shape. It is **not** a directory move: several host→lite-mesh
edges have to be rewritten or they strand code.

- `data_api/api_define.ts:63` — `import '../lite-mesh/litemesh.js'`, the data-API
  registry side-effect import. This is why `library.litemesh` and
  `toolDefaults.litemesh.*` appear in the *committed*
  `scripts/data_api/generated/datapaths.ts:74,536-554`; moving lite-mesh changes
  generated core code.
- `editors/view3d/view3d_draw_webgpu.ts:50` — the core WebGPU draw path imports
  `buildSolidTexturedWgsl` from `lite-mesh/litemesh_wgsl.js`.
- `framework_api.ts:157` — the framework's own public API re-exports `LiteMesh`.
- `editors/view3d/tools/boxmodel.ts:27,28` — a host toolmode imports LiteMesh ops.
- `scripts/webgpu/stencil_compute.ts` — a **host** file (multires SpMV, Ptex VDM
  sampler) imported *only* by lite-mesh (`litemesh.ts:50`). It would be stranded;
  `framework_api.ts` exports nothing from `scripts/webgpu/`.

**Step 2 — decouple the build.** Optionality is blocked at three levels below the
addon layer, and all three must be fixed or the addon switch is cosmetic:

- **pnpm.** `pnpm-workspace.yaml` lists six sculptcore-rooted packages, and
  `scripts/package.json:8,10` declare `"@litestl/typescript-runtime": "workspace:*"`
  and `"@sculptcore/api": "workspace:*"`. The `workspace:` protocol has no
  registry fallback — `pnpm install` **hard-fails on a clone without the
  submodule, before any build step runs.**
- **esbuild.** `tools/esbuilder.js:37,46` list
  `sculptcore/typescript/build/sculptcore-browser.{wasm,js}` as unconditional
  entry points.
- **Entry point.** `scripts/entry_point.js:83` is a static
  `import * as sculptcore from '@sculptcore/api/api'`, and `:93` is a
  **top-level `await sculptcore.loadWasm()`** before `init()`.

Then: glob the workspace entries so absence is tolerated; make `@sculptcore/api`
an optional dependency of the *litemesh addon package*, not the host; and add a
tsconfig `paths` fallback so `@sculptcore/api` resolves to a types-only stub when
the real package is missing — there is no `@sculptcore/api` path mapping anywhere
today, it resolves purely through the pnpm workspace symlink, and
`scripts/tsconfig.json` has no `paths` block at all.

Also de-sculptcore-ify the feature flags: all 11 in
`scripts/core/feature-flag.ts:174-249` are `sculptcore.*`, `:254` derives the key
union from that array (so emptying it makes every call site a type error), `:64`
uses a double non-null assertion that throws on a persisted key absent from the
definitions, and `:103-131` `merge()` never prunes unknown persisted keys. A
sculptcore-free build must not throw on a settings blob written by a full build.

**Step 3 — how sculptcore is acquired. The submodule stays.** Sculptcore is the
default configuration (§1), so the default acquisition path stays what it is
today: a git submodule, initialized by a normal recursive clone, built by the
existing `make.mjs` pipeline. `scripts/path.ux`, `scripts/mathl`, and
`vendor/nstructjs` stay submodules for the same reason.

What this step must produce is therefore not a replacement acquisition mechanism
but a **supported way to be without it**: `git submodule deinit sculptcore` (or a
clone that never initialized it) must leave a tree that installs, typechecks,
builds, boots, and passes a smoke suite. That is entirely step 2's work — pnpm
globs, the optional dependency on the addon package, the tsconfig stub, the
esbuild entry points, the entry-point `await`.

A `pnpm setup:sculptcore` clone script and a committed `sculptcore.lock.json`
were in the first draft as a *replacement* for the submodule. They are **out of
scope now** — the submodule already gives pinning and reproducibility, and
replacing it would trade a working default for a hand-rolled one. Revisit only if
we ever decide the submodule itself must go (open decision #10).

**Step 4 — CI lanes: full is primary, core is the guard.** Every PR runs the
**full** lane — submodule present, sculptcore built, `pnpm test` including the
integration suites. That is the lane whose failure blocks a merge on correctness.

Alongside it, a **`--no-sculptcore` lane** installs, typechecks, builds, boots
and smoke-tests with the submodule deinitialized. It is cheaper and narrower —
it is not trying to test sculpting, it is testing that the boundary still
exists. Without it the optionality rots within weeks, because nothing a developer
does day to day exercises it.

### W4. Mesh-source-agnostic UV editor

The existing `pending-port/TODO.md` already scoped this correctly and named the
blocker ("decouple UV display/edit from the `Mesh` addon so core does not
depend on mesh element types"). **W1's *sever* removes the blocker — not W1's
delete.** This workstream depends on the host-owned vocabulary and registry
hooks, nothing more, so it can start as soon as those land and does not need to
queue behind a 70k-line deletion.

**Do not port the old code back** — 3,007 lines written against BREP element
types, with stale imports, that nothing currently compiles. Reimplement against
the interface.

Define `IUVSource` in the host, mirroring the `SceneObjectData` picking pattern
that already works:

```ts
interface IUVSource {
  /** Opaque, stable per-corner handles. Not required to be mesh loops. */
  getUVLayers(): IUVLayerDesc[]
  activeUVLayer(): number

  /** Bulk read for drawing: positions + island/topology for wire display. */
  readUVs(layer: number, out: IUVReadback): void

  /** Selection lives in the source, addressed by opaque handle. */
  selectedUVs(layer: number): Iterable<UVHandle>
  setUVSelect(layer: number, handles: Iterable<UVHandle>, state: boolean): void

  /** Writes go through the source so undo/dirty-flagging stays its business. */
  writeUVs(layer: number, handles: Iterable<UVHandle>, coords: Float32Array): void

  /** Optional capabilities — editor greys out what is unsupported. */
  pinUVs?(...): void
  unwrap?(...): void
}
```

Design constraints worth stating up front, because they are what make this
different from the old editor:

- **Handles are opaque and bulk-oriented.** The old editor walked
  `mesh.loops` and read `loop.customData[uvLayer]` per element. Sculptcore-
  backed geometry lives across a WASM/native boundary where per-element
  round-trips are the dominant cost. The interface must be arrays-in /
  arrays-out.
- **The editor owns no geometry state.** Selection, pinning, and coordinates
  live in the source; the editor holds only view state (velpan, active layer,
  tool settings). This is what makes it work for *any* future source.
- **UV ToolOps take a datapath to the source object**, not a `Mesh`. They
  become `uv.translate` / `uv.select_one` / etc. registered by a `uv_editor`
  addon, resolving the active source through the context.
- **Replace `window.redraw_uveditors`** with an `ImageBus` signal (already
  exists, already re-exported from `@framework/api`, currently unsubscribed).
- **Restore `selectedFacesOnly`** as a real editor preference —
  `mesh_uvops_base.ts` hardcoded it to `true` during the slim-down.

LiteMesh implements `IUVSource` first. A second implementation (even a trivial
in-memory test double) should land in the same PR — an interface with one
implementor is a guess, not an abstraction, and the double doubles as the unit-
test fixture for the editor without requiring sculptcore.

### W5. Embeddability

Embedding is mostly a *packaging* problem once W1–W3 land, plus a handful of
global-state problems that will surface immediately.

**Step 0 — keep the only test of the packaging pipeline alive.**
`tests/integration/tetmesh_real_build.test.ts` is the sole test that
`tools/build-addons.js` produces a working external per-addon bundle with a
correct `index.json` dependency entry. Everything in this workstream rests on
that pipeline, and W1 deletes `tetmesh`. Re-point the test at a surviving addon
(LeafMesh is the natural candidate, since it also has zero dependencies) before
the deletion lands, or W5 proceeds with no coverage at all.

**Step 1 — a distribution manifest.** `scripts/entry_point.js` is currently a
hand-ordered list of side-effect imports with load-order comments explaining
TDZ hazards ("Must come AFTER the mesh default_scene import so this builder
wins"). That is not embeddable. Replace with a declared distribution:

```ts
// distributions/faber-leaf/index.ts
export default defineDistribution({
  addons: [litemesh, sculpt, boxmodel, uv_editor, node_editor],
  defaultScene: 'litemesh-sphere',
  branding: {title: 'Faber Leaf'},
})
```

`entry_point` becomes generic; `tools/esbuilder.js` takes a
`--distribution <name>` flag. Ship two in-tree distributions —
`faber-leaf` (full) and `faber-leaf-core` (no sculptcore) — because the second
one *is* the W3 secondary CI lane, and having two consumers of the mechanism
from day one is what keeps it honest. `faber-leaf` is what ships and what
developers run; `faber-leaf-core` exists to serve embedders and to keep the
boundary from rotting (§1).

**Step 2 — kill the load-order fragility.** `framework_api.ts` carries multiple
comments about export ordering to dodge TDZ ("MUST be re-exported BEFORE
context.ts"), and `builtin_registry.ts` has import-order comments too. This is
a circular-dependency smell — `pnpm cyclecheck` exists precisely for it. With
the BREP gone the cycle count drops sharply; use the opportunity to fix the
rest, because arbitrary addon load order under a distribution manifest will
otherwise reintroduce these crashes non-deterministically.

**Step 3 — de-globalize.** An embedded instance cannot own the page. Audit and
gate: `window._appstate`, `window.DEBUG`, `window._SelMask` (`selectmode.ts:54`),
`window.redraw_uveditors`, `globalThis._framework` (the addon-externalization
bridge in `_framework_runtime.ts`), and the `#canvas2d`/`#canvas3d`/`#iconsheet`
fixed element IDs in `index.html`. Target: `mountFaberLeaf(container, options)`
returning a handle, with debug globals behind a dev flag. The
`globalThis._framework` bridge is load-bearing for external addons — it needs a
per-instance registry, not deletion.

**Step 4 — document the embedding contract.** A short
`documentation/embedding.md`: what the host guarantees, what a distribution may
override, semver policy on `@framework/api`. `@framework/api` is the public
API; once embedders exist, changing it is a breaking change. Say so now.

---

## 5. Sequencing

Fourteen phases. Each ends at a green `pnpm test` + `pnpm typecheck` +
`pnpm check:layers` + a bootable app — no phase leaves the tree broken. Phase 1
is what makes that sentence mean anything.

| # | Phase | Depends on | Notes |
| --- | --- | --- | --- |
| 0 | LeafMesh core: storage, attrs, topo, `cdt2d` | — | Headless and dependency-free; runs in parallel with everything below from day one. |
| 1 | **CI + gate repair** | — | **Start here.** Repair the depcruise rules, fix `check-layers.js` on Windows, widen the typecheck program, and add a PR workflow that runs test + typecheck + lint + layers. Publish the real violation baseline. Without this, every phase boundary below is unverified (§2.4). |
| 2 | W0 rename + identity migration | 1 | Small but not trivial — it is a user-data migration (§4 W0). Independent of everything else. |
| 3 | W2: hoist `stroke_base`, then delete TS sculpting | 1 | Step 0 (hoist) and step 1 (delete) are separate landings. No longer the risk-free opener it was billed as. |
| 4 | W1 steps 0–1: sever Class E/F edges; `SelMask` format migration + host geometry contract | 1 | The hard part, and the part with a file-format change in it. Persist names not bits; bump `APP_VERSION`. |
| 5 | W1 step 2: registry hooks | 4 | Registry-ize `api_define` / `PropsEditor` / `view3d_draw` / `entry_point`; extend `AddonAPI` with the six missing dispatch cases. |
| 6 | W1 step 3: drive the repaired rules to zero, flip to `error` | 5 | The ratchet. Nothing regresses after this. |
| 7 | Serialization + file-compat hardening | 5 | The unloaded-addon round-trip invariant: the seven `missing_addon` defects, the concrete-struct `StructStructField` path (a `vendor/nstructjs` change), struct-id stability, and round-trip tests on `examples/error-test.wproj` + a curve/tet fixture. **Must precede the delete.** |
| 8 | LeafMesh host integration + modeling toolmode | 0, 5 | The tree gains a working, authorable geometry type *before* it loses one. |
| 9 | W1 steps 4–5: delete the BREP | 6, 7, 8 | ~70k lines. Mechanical only because 4–8 are done. |
| 10 | W3: addon-manager optional deps, then sculptcore optional | 9 | Step 0 (manifest/topo-sort/esbuild) is a prerequisite, not a detail. |
| 11 | W5 steps 1–2: distributions | 10 | `faber-leaf-core` *is* the W3 secondary CI lane. The full build stays the default and the merge gate. |
| 12 | W4: UV abstraction | 5, 0 | Forks off after the **sever**, not the delete. Parallelizable with 6–11. |
| 13 | W5 steps 3–4: de-globalize + docs | 11, 12 | Final polish. |

Phase 0 runs alongside everything — it is new code with no inbound
dependencies. Phases 3, 4 and 12 can run in parallel with different people once
phase 1 lands.

**Why the deletion no longer goes first.** The previous ordering opened with W2
on the grounds that it was leaf code with the best lines-deleted-to-risk ratio.
It is not leaf code (§4 W2), and more importantly, opening with *any* deletion
means deleting against gates that do not run. Phase 1 is cheap, and it is the
only phase that makes the other thirteen checkable.

**Why the BREP deletion moved behind LeafMesh's toolmode.** `mesh_edit` is the
only polygon-editing toolmode in the tree, and core imports it directly
(`view3d.ts:36`). Deleting the BREP before a LeafMesh modeling toolmode exists
leaves the tree with **no polygon-editing capability at all** for the duration of
phases 9–12. That is a real product outage in exchange for finishing a deletion
three phases earlier.

---

## 6. Risks

**The gates do not measure the work (new highest risk).** Every phase boundary,
and six of the eight success criteria, are stated in terms of `check:layers`,
`pnpm test` and a `grep`. None of those run on PRs today, two of the four layer
rules target a directory that does not exist, and *none* of them can see a Class
E, F or G coupling (§2.2, §2.4) — which is where the actual difficulty lives.
Mitigation: phase 1 repairs the gates and publishes a real baseline before any
code moves, and §8 has been rewritten so each criterion can fail.

**The empty-host problem (still severe, and the old mitigation was wrong).**
After W1 and W3, a build without sculptcore has zero geometry types. The previous
mitigation was "ship LeafMesh so the host isn't empty." That is necessary but not
sufficient, and the reason matters: **the gap is not the mesh data structure, it
is roughly twenty host subsystems written against `Mesh`'s incidental API.**
`IGeometrySource` as originally sketched covers about eight of twenty-two host
demands, `ITransDataType` is a second 13-method interface with 745 lines of
`MeshTransType` living in the host, and attribute-driven materials cannot render
on a new geometry type at all until the hardcoded `LIT_MESH_VERTEX_LAYOUT` is
generalized (§3).

The real mitigation is therefore two-part: **(a)** the host-facing interface work
in §3 is the deliverable that closes the gap, and **(b)** LeafMesh is the second
implementor that proves it closed — designed in
[2026-08-15-0248-leafmesh-design.md](./2026-08-15-0248-leafmesh-design.md), and
the worked example for criteria #12–#14. Note that the design's own ~3,500–4,500-line
budget has **no line item** for a transform module, the selection/regen protocol,
customdata layers, `defineAPI`, `buildPropertiesTab`, or graph-socket wiring, and
that selection derivation/flush is currently C++-resident (`select_derive.{h,cc}`)
— so a sculptcore-free modeling toolmode must reimplement it in TS. Re-budget
before committing to a date.

**A file-format break is in scope whether or not we choose it.** Struct-id
renumbering, the three raw-int `SelMask` fields, and the toolmode array written
into every save (Class G) mean the delete changes the on-disk format. Mitigation:
phase 7 owns it explicitly — persist names not bits, pin or rewrite struct ids,
bump `APP_VERSION`, and land the round-trip tests — rather than discovering it
after the delete.

The under-appreciated half is that **the unloaded-addon round-trip is a
permanent, generic requirement, not a migration chore.** Once addons are
genuinely optional, every user with a third-party addon installed and every
`faber-leaf-core` embedder is opening files full of blocks they cannot decode.
The BREP delete is simply the first and largest instance. If phase 7 is scoped as
"make the old mesh files not crash", it will be rebuilt from scratch the first
time a third-party addon is uninstalled.

**Feature regression.** Deleting the BREP removes: BREP mesh editing (partly
replaced by the LiteMesh boxmodel toolmode), subsurf, curves, tet meshes,
hair/strands, OBJ/FBX import (`objloader.js`, `fbxloader.js`), procedural
meshes, texture painting, and the whole UV unwrapping stack
(`unwrapping.ts`, `unwrapping_solve.ts`, `mesh_paramizer.ts` — ~4,700 lines of
real algorithm work). Mitigation: enumerate these explicitly before deleting;
decide per-feature between drop / port-to-LiteMesh / preserve-as-reference in
`archive/`. **Unwrapping in particular is expensive to rewrite — port it, do
not delete it.** OBJ import is cheap to reimplement against a simple mesh and
should be, since import is table stakes for an embeddable host.

~~**Reproducibility regression from unpinning sculptcore.**~~ **Retired.** The
submodule stays and remains the default acquisition path (§1, open decision #10),
so there is no unpinning to regress from. The risk this replaces it with is the
opposite one — see *Bit-rot of optionality* below.

**Interface-design risk in W4/W5.** Both `IUVSource` and the distribution
manifest are single-consumer designs at authoring time. Mitigation is stated
in-line above: two implementors before either is declared done.

**Bit-rot of optionality.** Sculptcore is the default configuration (§1), so
*nothing a developer does day to day exercises the boundary*. That is precisely
why the secondary `--no-sculptcore` lane is not optional itself: it is the only
thing standing between "removable" and "removable in principle, six months ago".
Cheap to run, and the single highest-leverage piece of CI in the plan.

**Review burden.** ~95k deleted lines. Mitigation: the sever-before-delete
ordering means the large-deletion PRs are near-mechanical (imports already
gone), and the genuinely reviewable logic changes are concentrated in phases 4–5.

**Loss of the only packaging test.** `tetmesh_real_build.test.ts` is deleted by
W1 and is the sole coverage of the external addon-bundle pipeline W5 depends on
(§4 W5 step 0). Mitigation: re-point it before the delete, not after.

---

## 7. Open decisions

These need the user's call before the corresponding phase starts.

1. ~~**Does the host ship a built-in geometry type?**~~ **Resolved: yes —
   LeafMesh.** A non-BREP SoA mesh whose faces are lists of loops (holes are
   first-class), with sculptcore's CDT ported to TS for triangulation. Full
   design: [2026-08-15-0248-leafmesh-design.md](./2026-08-15-0248-leafmesh-design.md).
   Its own open questions (winding enforcement, live vs. rebuilt cycles,
   F32/F64) are tracked there.
2. **Boxmodel / polygon modeling with sculptcore absent.** `boxmodel.ts` +
   `litemesh_modeling_ops.ts` are sculptcore-backed. Options: (a) modeling is a
   sculptcore feature, `faber-leaf-core` has none; (b) build a modeling
   toolmode on LeafMesh's Euler-op surface. Recommend (b) now that LeafMesh
   exists — it has the primitives, and (a) would leave the core distribution
   able to display geometry but not author it.
3. **File compatibility.** ~~Choose between opaque round-trip, a converter, and a
   format break.~~ **No longer a free choice.** Opaque round-trip is still the
   right answer, but `missing_addon.ts` does not do it today — old `.wproj` files
   crash on load, the object→geometry association is destroyed on re-save, and
   the preserved bytes decode against shifted struct ids (§4 W1 step 5). The
   remaining decision is narrower: **do we pin struct ids in the file format, or
   rewrite the ids inside `_origBytes` on save?** Pinning is a format change with
   a migrator and permanent id reservations; rewriting is contained but must
   handle nested `abstract(...)` payloads. Recommend pinning — it is the only
   option that also survives future addon removals, which is the whole point of
   the refactor.
4. **Curves, tets, hair, subsurf.** Delete outright, or preserve in `archive/`
   as reference for later reimplementation? Recommend: `archive/`, since
   `archive/` already exists and the cost is zero.
5. **Texture painting.** Accept the gap after `pbvh_texpaint.ts` is deleted, or
   block W2 on a sculptcore-backed replacement? Recommend: accept the gap,
   track it in `ImmediateTODOs.md`.
6. **UV unwrapping.** Port `unwrapping_solve.ts` / `mesh_paramizer.ts` to the
   `IUVSource` interface (they are largely topology-agnostic solvers), or drop?
   Recommend: port — it is the most valuable algorithm code in the deleted set.
   The rescue to `archive/` must happen in the same change that deletes, or the
   decision is made for us.
7. ~~**The rename's storage keys.**~~ **Resolved: migrate, do not freeze**
   (landed in P2, 2026-08-15). `scripts/core/identity_migration.ts` copies the
   two `localStorage` keys and the addon IndexedDB database forward at boot —
   copy-then-mark, idempotent, never throwing — and deliberately leaves the
   legacy originals in place so a downgrade still works
   (`ImmediateTODOs.md` tracks their eventual deletion). The one exception is a
   value too big to exist twice: a real startup scene is ~4MB of base64 against
   a ~5MB `localStorage` origin quota, so a `QuotaExceededError` degrades to a
   move (legacy key removed, restored if the retry also fails) rather than
   losing the scene. The NW.js profile
   directory moved without a copy: it holds only regenerable Chromium state, and
   copying a live profile would carry a stale `SingletonLock` across.
8. **Does `faber-leaf-core` ship polygon modeling on day one?** This is what
   decides whether the BREP deletion can precede the LeafMesh modeling toolmode.
   Recommend: yes (it is the same call as decision 2), which is why §5 phase 8
   now sits ahead of phase 9. Saying no is defensible, but it means accepting a
   display-only core distribution and a multi-phase window with no polygon
   editing in the tree at all.
9. **Do we accept a one-way format break at the struct-id boundary?** If decision
   3 lands on pinning, files written by the current build remain readable; if it
   lands on rewriting, there is a window where files round-trip only through the
   version that wrote them. State the answer in `documentation/embedding.md`
   before the first external embedder exists.
10. **Does the sculptcore submodule ever go away?** Settled for now: **no.**
    Sculptcore is the default configuration (§1), the submodule already provides
    pinning and reproducibility, and replacing it with a clone script plus a
    hand-maintained lock file would trade a working default for a worse one. The
    embedding story is served by *deinitializing* the submodule, not by removing
    it from the repo. Recorded here because the first draft assumed the opposite,
    and because a downstream that vendors Faber Leaf without git submodules would
    reopen it.

---

## 8. Success criteria

Every criterion below is written so that it can **fail**. The previous set could
not: it leaned on a `check:layers` run that reports zero errors by construction,
a `grep` that cannot see string-keyed or inheritance coupling, and a `pnpm test`
that nothing runs on PRs (§2.4).

**Gate integrity (new — these come first because the rest are measured by them).**

0a. A PR workflow runs `pnpm test`, `pnpm typecheck`, `pnpm eslint`, and
    `pnpm check:layers` on every pull request and blocks merge on failure — on
    the **full, sculptcore-present** configuration, which is the default (§1).
0b. `pnpm check:layers` runs clean on Windows, and the repaired rules cover
    `^addons/builtin/mesh/`, include `scripts/editors/`, `scripts/tet/` and
    `scripts/hair/` in the `from` sets, count type-only imports in a dedicated
    rule, and no longer exclude `renderengine` / `shadernodes` from the graph.
0c. `pnpm typecheck` includes every addon source file — demonstrated by
    introducing a deliberate type error in an addon and watching it fail.

**Decoupling.**

1. `pnpm check:layers` passes at `severity: error` with `core-no-addons`,
   `core-no-mesh`, `core-no-litemesh`, and `core-no-sculptcore` enforced against
   the **repaired** rule set, from a published non-zero starting baseline.
2. `grep -r "addons/builtin/mesh" scripts/` returns nothing, **and** so do
   `grep -rn "getStructByName('mesh\." scripts/`, `grep -rn "extends Mesh"`, and
   a scan for numeric `selmask=` literals in keymap strings. Class F is not
   covered by criterion 2 unless it is named in criterion 2.
3. With the sculptcore submodule **deinitialized**, `pnpm install`, `pnpm
   typecheck`, `pnpm build` all succeed and the app boots, loads a scene, and
   passes a smoke suite — enforced by a secondary CI lane, not by hand.
   (`pnpm install` is the part that fails today, before any build step.)
4. The default lane is unaffected: a normal recursive clone builds and tests the
   full app with sculptcore, and remains the lane that gates merges. Making
   sculptcore removable must not make it awkward to have.

**Data integrity — the unloaded-addon round-trip.**

These four together are the invariant from §4 W1 step 5, split so each can fail
on its own. All are tested in CI against `examples/error-test.wproj` plus a
fixture carrying curve / strand / tet data.

5. **Bytes survive.** A `.wproj` written by the full build, opened in a build
   without the owning addon and re-saved, still contains that addon's block —
   byte-identical, under its original struct name — and a third load in the full
   build reads it back into a live, correct object.
6. **Identity survives.** The re-saved file preserves each unknown block's
   `lib_id`, and every `DataRef` from a loaded block still resolves to it. The
   object→geometry association is what silently dies today.
7. **Saving never throws** for data from an unloaded addon, on *both* nstructjs
   struct paths — `abstract(T)` and concrete `T`, including `array(T)` and
   `iter(T)` containers (the curve / strand / tet case).
8. **Struct ids stay meaningful.** Registering or removing an addon does not
   change the meaning of ids already written into preserved bytes — verified by
   writing a file, changing the registered addon set, and re-reading it.
9. Loading a settings blob and a startup file written by the full build does not
   throw in a sculptcore-free build (feature-flag keys, `SelMask` values).

**Architecture.**

10. Two distributions build from the same tree with no source forking.
11. The UV editor operates on a non-LiteMesh `IUVSource` in a test, with no
    sculptcore present.
12. A new geometry type can be added by a third-party addon — with LeafMesh
    serving as the worked example — touching no file under `scripts/`. This
    requires `AddonAPI` dispatch for `TransDataType`, `DataKind`,
    `DefaultSceneBuilder`, `FileMigrator`, `UVSource` and properties panels; it
    is unachievable until those exist (§3d).
13. That geometry type renders a material containing an `AttributeNode` — i.e.
    the vertex layout is negotiated, not hardcoded (§3).
14. That geometry type supports per-element transform and proportional edit
    through a registered `ITransDataType`, with no host edit.
15. `documentation/embedding.md` exists and states the `@framework/api`
    stability contract and the file-format compatibility policy.

Criteria 12–14 are the real test, and they are deliberately three rather than
one: a geometry type that can be registered but cannot be shaded or transformed
proves the registry works, not the architecture. If adding a geometry type still
requires editing `selectmode.ts`, `api_define.ts`, `PropsEditor.ts`,
`transform_ops.ts`, or `wgsl_shaders.ts`, the refactor has moved code without
changing the architecture.

---

## 9. Task list — the plans

The work splits into **twenty plans**. Each is one reviewable unit that ends at a
green `pnpm test` + `pnpm typecheck` + `pnpm check:layers` + a bootable app, and
each needs its own doc in `documentation/plans/` written before its work starts.
This strategy doc is not a plan and neither is the LeafMesh design — the design
describes *what* LeafMesh is; P3 and P11 describe *how it gets built*.

Four of the twenty (P1, P4, P10, P14) exist only because of the adversarial
review; three more are splits of plans that were single units in the first draft
(P6/P7 out of the old P4, P8/P9 out of the old P5, P14/P15 out of the old P8).

**Filenames below are reserved**, and all twenty were authored at those exact
names on 2026-08-15, so the links resolve. Each plan re-verifies this document's
file:line evidence against the tree before its work starts — the citations here
are a 2026-08-15 snapshot, not a standing guarantee.

### 9.1 Plan index

| # | Plan | Workstream | Phase (§5) | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| — | [LeafMesh design](./2026-08-15-0248-leafmesh-design.md) | risk mitigation | 0 | — | **written** |
| P1 | [CI + layer-gate repair](./2026-08-15-0300-ci-and-layer-gate-repair.md) | new — §2.4 | 1 | — | **written** |
| P2 | [W0 — rename + identity migration](./2026-08-15-0305-w0-rename-faber-leaf.md) | W0 | 2 | P1 | **landed** |
| P3 | [LeafMesh core — storage, attrs, topo, CDT](./2026-08-15-0310-leafmesh-core-storage-topo-cdt.md) | risk mitigation | 0 | — | **written** |
| P4 | [W2a — hoist the stroke base](./2026-08-15-0315-w2-stroke-base-hoist.md) | W2 §0 | 3 | P1 | **written** |
| P5 | [W2b — delete the TS sculpting stack](./2026-08-15-0320-w2-delete-ts-sculpting-stack.md) | W2 §1 | 3 | P4 | **written** |
| P6 | [W1a — `SelMask` format migration](./2026-08-15-0325-w1-selmask-format-migration.md) | W1 §1 | 4 | P1 | **written** |
| P7 | [W1b — host geometry contract](./2026-08-15-0330-w1-host-geometry-contract.md) | W1 §1, §3(a)(b) | 4 | P6 | **written** |
| P8 | [W1c — registry hooks + string-key severing](./2026-08-15-0335-w1-registry-hooks-and-string-key-severing.md) | W1 §0, §2 | 5 | P7 | **written** |
| P9 | [W1d — layer ratchet to `error`](./2026-08-15-0340-w1-layer-ratchet.md) | W1 §3 | 6 | P8 | **written** |
| P10 | [Serialization + file-compat hardening](./2026-08-15-0345-serialization-and-file-compat-hardening.md) | W1 §5 (promoted) | 7 | P8 | **written** |
| P11 | [LeafMesh host integration](./2026-08-15-0350-leafmesh-host-integration.md) | risk mitigation | 8 | P3, P8 | **written** |
| P12 | [LeafMesh modeling toolmode](./2026-08-15-0355-leafmesh-modeling-toolmode.md) | open decisions #2, #8 | 8 | P11 | **written** |
| P13 | [W1e — delete the TS BREP](./2026-08-15-0400-w1-delete-ts-brep.md) | W1 §4 | 9 | P5, P9, P10, P12 | **written** |
| P14 | [Addon manager — optional dependencies](./2026-08-15-0405-addon-manager-optional-dependencies.md) | W3 §0 | 10 | P9 | **written** |
| P15 | [W3a — LiteMesh becomes an optional addon](./2026-08-15-0410-w3-litemesh-optional-addon.md) | W3 §1 | 10 | P13, P14 | **written** |
| P16 | [W3b — sculptcore build decoupling](./2026-08-15-0415-w3-sculptcore-build-decoupling.md) | W3 §2–4 | 10 | P15 | **written** |
| P17 | [W5a — distributions + cycle cleanup](./2026-08-15-0420-w5-distributions.md) | W5 §1–2 | 11 | P16 | **written** |
| P18 | [W4a — `IUVSource` + UV editor rewrite](./2026-08-15-0425-w4-iuvsource-uv-editor.md) | W4 | 12 | P8, P11 | **written** |
| P19 | [W4b — port the unwrapping solvers](./2026-08-15-0430-w4-unwrapping-port.md) | W4 | 12 | P18, P13 (rescue) | **written** |
| P20 | [W5b — de-globalize + embedding contract](./2026-08-15-0435-w5-deglobalize-embedding-api.md) | W5 §3–4 | 13 | P17, P18 | **written** |

Five of them — **P3, P7, P10, P14, P20** — are tagged **`[xhigh]`** in §9.3 and
are worth writing at raised reasoning effort; the compact-and-switch points are
marked inline there.

### 9.2 Tracks

Five tracks. Only the spine is strictly serial, and everything hangs off P1.

```
gates      P1 ─┬──────────────────────────────────────────────────────────
               │
spine          ├─ P6 ─ P7 ─ P8 ─┬─ P9 ─ P14 ───────┐
               │                │                  ├─ P13 ─ P15 ─ P16 ─ P17 ───────┐
sculpt         ├─ P4 ─ P5 ──────┼──────────────────┤                               ├─ P20
               │                ├─ P10 ────────────┤                               │
leafmesh   P3 ─┼────────────────┴─ P11 ─ P12 ──────┘                               │
               │                       │                                           │
uv             │                       └─ P18 ─ P19 ───────────────────────────────┘
               │
rename         └─ P2
```

P3 starts on day one and is the only track with no inbound dependency at all.
**P1 gates everything else** — not because the work depends on it technically,
but because without it no phase can demonstrate it finished (§2.4).

Three ordering constraints are load-bearing and were wrong in the first draft:

- **P4 before P5.** The surviving sculptcore toolmode inherits from the pbvh code
  P5 deletes; the hoist has to land first (§4 W2).
- **P11 and P12 before P13.** The tree must have an authorable geometry type
  before it loses the only one it has (§5, and open decision #8).
- **P10 before P13.** Old files crash on load and curve/tet files throw on save
  *today*; the delete makes both permanent and silent (§4 W1 step 5).

Two edges were also re-pointed *off* the critical path. **P18 no longer waits for
the delete** — it needs the sever (P8), not the removal — which takes the whole UV
track off the spine. **P14 does not either**: the addon manager's missing
optional-dependency support can be built and proved on a throwaway addon as soon
as the ratchet lands, and P15 is the only thing that has to wait for P13.

### 9.3 The plans

**Authoring effort.** Five plans are tagged **`[xhigh]`** — P3, P7, P10, P14,
P20. Those are the ones whose *shape* is unknown going in: a storage model, an
interface boundary, a file format, a dependency semantics, a public API. A wrong
shape there propagates into every plan downstream of it. The other fifteen are
survey work — the shape is already known and the only open question is
completeness, which reasoning effort does not buy. Write those at `high`.

The `⏸` notes below mark the effort transitions in this section's order.
**Compact first, then change effort** — carrying a stale context window across
the switch spends the expensive tier re-reading things already settled. If you
write the plans in dependency order (§9.2) instead of numeric order, the tag
travels with the plan and the pause points move with it.

**Grounding beats effort.** Both rounds of errors found in this document were
grounding failures, not reasoning failures — layer rules pointing at a path that
no longer exists (§2.4), and an assumption that nstructjs's unknown-class hooks
covered all struct fields (§4 W1 step 5). Before an `xhigh` plan, spend the cheap
tokens first on a sweep that enumerates the real call sites; `xhigh` over
ungrounded input just argues a wrong plan more convincingly.

> **⚠ Temporary machine constraint — REVERT WHEN THE REFACTOR IS COMPLETE.**
> While this refactor is in flight, nothing may use more than **5 parallel jobs,
> and that is a *global* cap**, not per-tool: do not build sculptcore and run
> tests at the same time. In force:
>
> - `pnpm test` runs through `tools/run-tests.mjs`, which serializes turbo
>   packages (`--concurrency=1`) and caps jest / vitest workers at 5.
> - `tests/jest.config.ts` and `tests/integration/jest.config.mjs` are at
>   `maxWorkers: 5` (were 6).
> - Sculptcore builds are capped by `BUILD_JOBS: 5` in the gitignored
>   `sculptcore/local-build-options.mjs`; pass `-j 5` explicitly on any
>   invocation that bypasses it.
>
> None of this belongs in the shipped configuration. **Revert all four when the
> Faber Leaf refactor is done** — `pnpm test` back to `turbo test`, delete the
> wrapper, restore `maxWorkers`, delete the local build options. The CI workflow
> is deliberately *not* capped: it runs on its own runner.

- [x] **P1 — [CI + layer-gate repair](./2026-08-15-0300-ci-and-layer-gate-repair.md)** — landed 2026-08-15, commit `2144aeef`. Real layer baseline is **2483**, not the 288 this doc cited. ESLint is **not** gated (untriaged ~17k backlog; deferred to P9) — see that plan's §5 step 4 correction. `master` branch protection still has to mark the jobs required.
  - Add a PR workflow: `pnpm test`, `pnpm typecheck`, `pnpm eslint`,
    `pnpm check:layers`, blocking on failure, on the **full sculptcore-present**
    configuration — that is the default and the merge gate (§1).
    `deploy-pages.yml` is currently the only workflow and runs none of them.
  - Budget for the sculptcore build in CI up front (submodule checkout, emsdk,
    build cache). If the full lane is too slow to block merges, that is a problem
    to solve here, not a reason to gate on a cheaper configuration.
  - Repair `.dependency-cruiser.cjs`: `^scripts/mesh/` → `^addons/builtin/mesh/`
    in `core-no-mesh` / `util-no-mesh`; drop the `scripts/editors/` carve-out;
    move the type-only exemption into its own rule so it is visible; add
    `scripts/tet/` and `scripts/hair/` to the `from` sets; remove
    `renderengine` / `shadernodes` from `options.exclude.path`.
  - Fix `tools/check-layers.js:22` (`spawn EINVAL` on Windows).
  - Widen the typecheck program: root `tsconfig.json` uses `files`, not
    `include`, so addons enter only through `typescript_entry.ts`'s mesh imports;
    add a `paths` block to `scripts/tsconfig.json`.
  - **Publish the repaired baseline** in this plan's doc — the violation count
    after repair is the real W1 budget, and it is unknown today.
  - Exit: criteria 0a/0b/0c. A deliberate type error in an addon and a deliberate
    layer violation both fail CI.

- [x] **P2 — [W0: rename + identity migration](./2026-08-15-0305-w0-rename-faber-leaf.md)** — landed 2026-08-15 (`09570d73` + sculptcore `905c4c4`, then the migration commit). Open decision #7 settled: **migrate**. Two extra workspace packages the plan missed were renamed too (`@webgl-app-framework/tests`, `@webgl-app-framework/addon-code-editor`). `nwjs/profile_dir.mjs` turned out to hardcode the name rather than read the manifest, so the profile move was an independent edit. The **manual** exit item is now closed: a real pre-rename profile (written by the build at `09570d73`, with a saved scene, non-default settings and a third-party addon installed) was reopened against the renamed build — 19/19 checks pass. It found a real bug: the ~4MB base64 startup scene blew the ~5MB `localStorage` quota and was silently dropped, so `migrateTextKey` now falls back to a move on quota failure.
  - Cosmetic: `package.json` name, `Readme.MD`, branding strings.
    `index.html:15` and the git remote are already done.
  - `@webgl-app-framework/tests-integration` → renamed together with the root
    `test:slow` script that references it.
  - `scripts/package.json` `@sculptcore/frontend` → `@faber-leaf/host`; leave
    `@sculptcore/api` alone.
  - `tools/publish-gh-pages.sh:14` still clones the old GitHub URL — it works
    only through the rename redirect.
  - **The migration** (open decision #7): `const.ts:2`, `app_storage.ts:97-98`,
    `settings.ts:44`, `addon/storage.ts:189`, `nwjs/profile_dir.mjs:22,24`. The
    IndexedDB rename is the dangerous one — get it wrong and every installed
    third-party addon silently disappears.
  - Exit: `pnpm i` from clean, `pnpm test`, `pnpm build` green under the new
    names, **and** a profile written by the old build still opens its scene,
    settings, and installed addons.

> **⏸ Pause — compact, then switch to `xhigh`.** P3 picks the storage model,
> attribute layout and topology representation that P11, P12 and P18 all build
> against, and that a shipped `.wproj` will encode. It is the most expensive
> shape in the refactor to get wrong.

- [ ] **P3 — [LeafMesh core: storage, attrs, topo, CDT](./2026-08-15-0310-leafmesh-core-storage-topo-cdt.md)** — **`[xhigh]`**
  - Design steps 1–3 of the [LeafMesh design](./2026-08-15-0248-leafmesh-design.md) §12:
    `elem_array.ts`, `attrs.ts`, `topo.ts`, `cdt2d.ts`, `triangulate.ts`,
    `primitives.ts`.
  - Port `tests/test_constrained_delaunay.cc` vectors alongside `cdt2d.ts` in
    the same PR, plus the hole/property/Euler-invariant suites from design §13.
  - Settle design open questions 2 and 4 (winding enforcement, F32 vs F64).
  - Headless and host-free — no `scripts/` import, no addon registration yet.
  - Exit: unit suite green; nothing else in the tree references it.

> **⏸ Pause — compact, then drop back to `high`.** P4 is a mechanical hoist, P5
> a delete, P6 a bit-layout migration whose shape §4 W1 already fixes. All three
> are bounded by how completely they enumerate call sites, not by how hard they
> are thought about.

- [ ] **P4 — [W2a: hoist the stroke base](./2026-08-15-0315-w2-stroke-base-hoist.md)**
  - `sculptcore.ts:22` — `SculptCorePaintMode extends PaintToolModeBase`, which
    lives in `pbvh_sculpt`. The surviving toolmode inherits from the code P5
    deletes; nothing else in W2 can start until that is untangled.
  - Move `stroke_base.ts` (~1,700 lines: `PaintToolModeBase`, `PaintOpBase`,
    `StrokeProperty`, `SculptTools`, `BrushSpacingModes`) to a host-owned or
    `litemesh`-owned module, and re-point `sculptcore.ts`.
  - Audit what else in the "leaf" set is actually inherited from — this is the
    Class E sweep for W2 specifically.
  - Exit: `pbvh_sculpt` has no inbound `extends` from surviving code; sculpting
    still works.

- [ ] **P5 — [W2b: delete the TS sculpting stack](./2026-08-15-0320-w2-delete-ts-sculpting-stack.md)**
  - Delete `pbvh*.ts` (9 files, 15,236 lines), the rest of
    `addons/builtin/pbvh_sculpt/` and its `@framework/api` surface,
    `scripts/test/test_sculpt*.js`.
  - `pbvh_sculptops.ts` (6,196 lines) is the fifth-largest file in the tree —
    budget for it as a real read, not as leaf code.
  - Split `scripts/brush/`: backend-neutral brush model (channels, dynamics,
    presets) stays in the host; `brush_dyntopo.ts` dies, `brush_dyntopo_sc.ts`
    stays; audit `scripts/webgpu/brush_compute.ts` the same way.
  - Settle open decision #5 (texture painting): recommended accept the gap,
    record it in `ImmediateTODOs.md`.
  - BREP-side `mesh_grids*.ts` / `mesh_displacement.ts` / `multigrid_smooth.js`
    / `mesh_remesh.js` are **not** in scope here — they leave with P13.
  - Exit: sculpting via sculptcore still works end-to-end; integration suite
    green.

- [ ] **P6 — [W1a: `SelMask` format migration](./2026-08-15-0325-w1-selmask-format-migration.md)**
  - This is a **file-format change**, not a refactor. `SelMask` is
    `MeshTypes` — the same bits are persisted as raw ints in `scene.ts:350`
    (`ToolMode.selectMask`), `view3d_toolmode.ts:549`, and `boxmodel.ts:31-43`,
    and appear as literals in six keymap strings (`selmask=17`).
  - Persist selection modes as **names**, not bits; reserve 1/2/4/8/16 for
    VERTEX/EDGE/FACE/LOOP/HANDLE so old files keep meaning; make `OBJECT` an
    `&`-test rather than an equality test; bump `APP_VERSION` and write the
    reader migration.
  - Then move the constants into a host-owned module
    (`scripts/core/select_types.ts`) and invert the dependency — the mesh addon
    imports from the host. 144 uses across 42 files.
  - Fix `selectmode.ts:1`, `transform_types.ts:4-5`, `PropsEditor.ts:2,32`,
    `scripts/lite-mesh/litemesh_base.ts:1`.
  - Exit: `grep -r "addons/builtin/mesh" scripts/lite-mesh/` returns nothing,
    **and** a pre-migration `.wproj` opens with its selection mode intact.

> **⏸ Pause — compact, then switch to `xhigh`.** P7 writes the four interfaces
> the entire target architecture rests on (§3). P8, P11, P12, P15 and P18 all
> implement against them; getting the boundary wrong is not a local mistake.

- [ ] **P7 — [W1b: host geometry contract](./2026-08-15-0330-w1-host-geometry-contract.md)** — **`[xhigh]`**
  - Write down §3's four interfaces as real, documented TS:
    `IGeometrySource` (the 14-row capability table), `ITransDataType`,
    `IUVSource` (declared here, implemented in P18), and the `AddonAPI`
    additions.
  - `transform_ops.ts:177` hardcodes `['mesh', 'object', 'litemesh']`;
    `MeshTransType` is 745 lines living in the host; `litemesh_transtype.ts:202`
    registers at module scope. All three are the same bug.
  - **The vertex layout is part of this contract.**
    `buildMaterialPipelineDescriptor` hardcodes `LIT_MESH_VERTEX_LAYOUT`; a
    third-party geometry type cannot use the material system until the layout
    is derived from the attribute set. Include the `camera.ts:163,165`
    `scheduleRawGLPass` caveat.
  - Exit: an interface document plus at least two implementors compiling against
    it (LiteMesh and the BREP), with no new host branch on concrete type.

> **⏸ Pause — compact, then drop back to `high`.** P8 is a call-site sweep
> against the contract P7 just fixed, and P9 is a ratchet. Both are won by
> enumeration — a subagent sweep is worth more here than a bigger model.

- [ ] **P8 — [W1c: registry hooks + string-key severing](./2026-08-15-0335-w1-registry-hooks-and-string-key-severing.md)**
  - **Step 0 — sever the invisible edges first.** `api_define.ts:339-344`
    (`getStructByName('mesh.Mesh')` throws from the AppState constructor),
    `view3d.ts:680` `'mesh.vertex_smooth()'`, the `selmask=17` keymap strings
    (closed by P6), `curve.ts:75` `CurveSpline extends Mesh`,
    `strand_types.js:36` `Strand extends CurveSpline`, and the
    `legacy_struct_migration.ts:34-102` table.
  - `data_api/api_define.ts`: replace the six mesh side-effect imports and the
    `buildCDAPI`/`buildProcMeshAPI` calls with an addon-contributed API hook,
    modelled on `api_define_registry.js`.
  - `view3d_draw.ts`: submit through the render queue for anything the
    `SceneObjectData` contract says is drawable; drop the `Mesh` value import.
  - `PropsEditor.ts`: `api.registerPropsPanel(...)` instead of core branching
    on type.
  - `entry_point.js`: delete the mesh imports **and** the five-module
    re-export — that re-export is a public commitment to the BREP.
  - Extend `AddonAPI` with the six missing dispatch cases (`registerDataKind`,
    `registerUVSource`, `registerTransType`, `registerPropsPanel`,
    `registerFileFormat`, `has('sculptcore')`).
  - Exit: booting with the mesh addon force-disabled reaches an empty viewport
    instead of a constructor throw.

- [ ] **P9 — [W1d: layer ratchet to `error`](./2026-08-15-0340-w1-layer-ratchet.md)**
  - Re-baseline against P1's repaired rules — the count that matters is the one
    P1 published, not the vacuous 288/0 the current config reports.
  - Drive the remaining violations to zero, then flip `core-no-mesh`,
    `core-no-addons`, `util-no-mesh` to `severity: error` and add
    `core-no-litemesh` + `core-no-sculptcore`.
  - Any rule that cannot be driven to zero gets an explicit, dated exemption
    with the plan that closes it — not a silent `warn`.
  - Exit: success criterion #1.

> **⏸ Pause — compact, then switch to `xhigh`.** P10 is the one plan whose
> failure mode is silent and discovered months later, in user files that cannot
> be re-created. It also reaches into `vendor/nstructjs` and has to close the
> struct-id question (open decision #3) for a format that is already shipping.

- [ ] **P10 — [Serialization + file-compat hardening](./2026-08-15-0345-serialization-and-file-compat-hardening.md)** — **`[xhigh]`**
  - Builds the unloaded-addon round-trip invariant from §4 W1 step 5. It applies
    to *any* addon that is not loaded — disabled, uninstalled, absent from
    `faber-leaf-core`, or deleted — so this is written once, generically, and not
    as BREP cleanup.
  - **Bytes + identity.** Fix the seven known defects:
    `lib_api.ts:1033/1041/1044-1046` and `615-617`, `appstate.ts:806`,
    `sceneobject.ts:413-416`, `missing_addon.ts:34-44/82-89/262`,
    `mesh/src/missing_customdata.ts:44`. Parsing the preserved bytes far enough
    to recover `lib_id` is what saves the object→geometry association.
  - **The second struct path.** The hooks are wired into `StructTStructField`
    only (`struct_intern2.ts:854-855`); `StructStructField.pack:735-739` writes
    against the declared struct unconditionally, so a curve or tet block
    **throws on save today**. Extending it is a change in `vendor/nstructjs` —
    budget for a submodule commit, a test in that repo's own suite, and a
    gitlink bump, and cover `array(T)` / `iter(T)` containers via
    `StructArrayField.pack:1142`'s `do_pack` recursion.
  - **Struct-id stability.** Close open decision #3 — pin ids in the format, or
    rewrite them inside `_origBytes` (including nested `abstract(...)` payloads)
    on save. This is not delete-specific either: adding a builtin addon shifts
    ids for everything registered after it.
  - Take ownership of the file migrations the mesh addon currently owns
    (`mesh/src/migrations.ts:33,46`, `file_migrations.ts:60-62`,
    `appstate.ts:1010-1025`, `appstate.ts:654-660`).
  - Rehome the fixtures that will die with the addon:
    `graph_missing_nodes.test.ts:8-13`, `scene-fixture.ts:14-19,22-47`,
    `examples/error-test.wproj`. `scene.ts:354`'s toolmode array will otherwise
    contaminate every new fixture — the new ones must exercise concrete struct
    fields, since that is the path with no coverage at all.
  - Settle open decision #9: is a one-way format break acceptable, and does the
    app say so out loud when it happens?
  - Exit: criteria 5–8. A `.wproj` carrying curve, tet and hair data opens in a
    build without the owning addon, re-saves byte-identically with `lib_id`s and
    `DataRef`s intact, and re-opens in the full build as live objects.

> **⏸ Pause — compact, then drop back to `high`.** P11 and P12 build LeafMesh
> against shapes P3 and P7 already settled; P13 is a delete whose whole
> difficulty is the completeness of its checklist.

- [ ] **P11 — [LeafMesh host integration](./2026-08-15-0350-leafmesh-host-integration.md)**
  - Design steps 4–7 of §12: `leafmesh.ts` (DataBlock + `SceneObjectData`),
    `draw.ts`, `pick.ts`, `serialize.ts`, `main.ts`/`api.ts`, plus the
    `manifest.json` with zero dependencies.
  - It is the worked example for criterion #12: adding it must touch **no** file
    under `scripts/`. If it does, P7/P8 are not finished — fix them, do not
    special-case LeafMesh.
  - Expect the vertex-layout contract (P7) to be the thing that bites: without
    it, LeafMesh either reuses `LIT_MESH_VERTEX_LAYOUT` verbatim or cannot use
    the material system at all.
  - Reimplement OBJ import against LeafMesh (§6: import is table stakes for an
    embeddable host); FBX is out of scope.
  - `uv_source.ts` is deliberately deferred to P18, where the interface it
    implements is actually designed.
  - Exit: LeafMesh renders, picks, round-trips through `.wproj`, and an OBJ
    file imports — with the BREP still present, so P13 has a safety net.

- [ ] **P12 — [LeafMesh modeling toolmode](./2026-08-15-0355-leafmesh-modeling-toolmode.md)**
  - **Contingent on open decisions #2 and #8**, and it is on the critical path:
    the BREP delete (P13) is what removes the tree's only authorable geometry
    type, so this lands *first*.
  - Scope mirrors the existing box-modeling toolmode (selection, extrude,
    inset, bevel, split-off, subdivide, loop-cut) — see
    [boxModelingTools.md](./boxModelingTools.md) — but against LeafMesh, where
    faces-with-holes are first-class.
  - Implements `ITransDataType` for LeafMesh, which is the second consumer P7's
    interface needs to stay honest.
  - Decide before P17 freezes what `faber-leaf-core` contains.
  - Exit: a cube is modelled into a hole-bearing shape in a sculptcore-free
    build.

- [ ] **P13 — [W1e: delete the TS BREP](./2026-08-15-0400-w1-delete-ts-brep.md)**
  - Enumerate the feature-regression list from §6 **before** deleting, and
    decide per feature: drop / port / preserve in `archive/`.
  - **Rescue before delete**: `unwrapping.ts`, `unwrapping_solve.ts`,
    `mesh_paramizer.ts` move to `archive/` intact — P19 ports them.
  - Delete `addons/builtin/mesh/` plus `subsurf`, `curve`, `mesh_edit`,
    `tetmesh`, `scripts/tet/`, `scripts/hair/`, the BREP dyntopo/multires
    files, the `@framework/api` re-exports, `tools/migrate-mesh-registers.js`,
    `addons/builtin/builtin_data_api.ts`, and the `IN_BUNDLE_BUILTIN_IDS`
    entries.
  - **Rewrite every builtin manifest in the same change.**
    `scripts/addon/manifest.ts:163-165` *throws* on an unknown dependency, and
    every builtin addon currently declares `mesh`. A staged delete is not
    possible here.
  - `MeshTransType`'s 745 host lines leave with it; so does
    `legacy_struct_migration.ts`'s mesh table (severed in P8).
  - Settle open decision #4 (archive curves/tets/hair/subsurf). Decision #3 is
    already closed by P10 — do not re-open it here.
  - Exit: success criterion #2, with P10's round-trip test still green.

> **⏸ Pause — compact, then switch to `xhigh`.** P14 defines what "optional"
> *means* across four systems that currently disagree — manifest schema,
> dependency resolver, build-time `@addon/<id>/api` resolution, and boot-time
> enable/disable. That semantics is what P15, P16 and every third-party addon
> inherit.

- [ ] **P14 — [Addon manager: optional dependencies](./2026-08-15-0405-addon-manager-optional-dependencies.md)** — **`[xhigh]`**
  - The manifest schema has no notion of an optional or disabled builtin.
    `"optional": true` is **silently dropped** — `AddonManifest`
    (`manifest.ts:9-47`) does not declare it, `validateManifest:123-135` does
    not read it, and `install.ts:113` does not act on it.
  - `manifest.ts:163-165` throws on a missing dependency; `addon.ts:430-439`
    has no disable path for builtins; `addon_api_plugin.js:54-58` resolves
    `@addon/<id>/api` at build time regardless of whether the addon ships.
  - `addons/builtin/*` is not a pnpm workspace glob, so a builtin cannot own a
    package dependency yet. Fix that here, or P16's optional
    `@sculptcore/api` has nowhere to live.
  - Exit: a builtin addon can be declared optional, force-disabled at boot, and
    depended on optionally by another addon — proved on a throwaway addon
    before LiteMesh depends on it.

> **⏸ Pause — compact, then drop back to `high`.** P15–P17 are moves and build
> wiring; P18 implements an interface P7 already designed; P19 is a port of
> working math. Five plans at `high` before the last switch.

- [ ] **P15 — [W3a: LiteMesh becomes an optional addon](./2026-08-15-0410-w3-litemesh-optional-addon.md)**
  - Move `scripts/lite-mesh/` (15,307 lines) plus the sculpt and boxmodel
    toolmodes into `addons/builtin/litemesh/` with `"buildMode": "prebuilt"`
    and `"optional": true` (which P14 made real).
  - Cut the five surviving host→lite-mesh edges first: `api_define.ts:63`,
    `view3d_draw_webgpu.ts:50`, `framework_api.ts:157`, `boxmodel.ts:27,28`,
    and the stranded `scripts/webgpu/stencil_compute.ts`.
  - Everything importing `@sculptcore/api` (30+ files) ends up behind that one
    gate; absent sculptcore the addon simply does not register.
  - Verify P10's `missing_addon` work covers LiteMesh blocks and sculpt
    toolmodes — this is the first time it is exercised on data users actually
    have.
  - Exit: the app boots with the addon force-disabled; `core-no-sculptcore` and
    `core-no-litemesh` still hold at `error`.

- [ ] **P16 — [W3b: sculptcore build decoupling](./2026-08-15-0415-w3-sculptcore-build-decoupling.md)**
  - `pnpm-workspace.yaml`: glob the six sculptcore paths so absence is
    tolerated. Note pnpm hard-fails on an unresolvable `workspace:*` — the
    optional dependency has to hang off the *litemesh addon package*, not the
    host.
  - `esbuilder.js:37,46` and `entry_point.js:83,93` still reach into sculptcore
    directly; so does the feature-flag registry
    (`feature-flag.ts:64,103-131,174-249,254`, where the sculptcore flags are
    hardcoded in host code). De-sculptcore-ify all four.
  - tsconfig `paths` fallback to a types-only stub, or `pnpm typecheck` fails
    in exactly the configuration this workstream exists to support.
  - **The submodule stays** and remains the default acquisition path (§1). The
    deliverable is that `git submodule deinit sculptcore` yields a working tree,
    not a replacement for `git submodule`. The `setup:sculptcore` clone script
    and `sculptcore.lock.json` from the first draft are out of scope (open
    decision #10).
  - Add the secondary `--no-sculptcore` CI lane — install, typecheck, build,
    boot, smoke — alongside the full lane, which stays primary and keeps gating
    merges. Re-pointed at the `faber-leaf-core` distribution in P17.
  - Exit: success criteria #3 and #4 — the boundary is real, **and** the default
    build is no harder to work in than it is today.

- [ ] **P17 — [W5a: distributions + cycle cleanup](./2026-08-15-0420-w5-distributions.md)**
  - `defineDistribution({addons, defaultScene, branding})`; `entry_point`
    becomes generic; `tools/esbuilder.js` takes `--distribution <name>`.
  - Ship `faber-leaf` (full) and `faber-leaf-core` (no sculptcore) from the
    same tree — two consumers from day one is what keeps the mechanism honest.
  - **Restore a packaging test.** `tetmesh_real_build.test.ts` is the only test
    that builds an addon the way a third party would, and it dies with P13.
    Re-point it at LeafMesh (or a fixture addon) or the external ship mode goes
    permanently unverified.
  - Kill the load-order fragility: the TDZ comments in `framework_api.ts` and
    `builtin_registry.ts` are a circular-dependency smell, and arbitrary addon
    load order under a manifest will turn them into non-deterministic crashes.
    Drive `pnpm cyclecheck` to a clean baseline and gate it.
  - Exit: success criterion #10, plus a green external-addon packaging test.

- [ ] **P18 — [W4a: `IUVSource` + UV editor rewrite](./2026-08-15-0425-w4-iuvsource-uv-editor.md)**
  - Define `IUVSource` per §4 W4 — opaque handles, bulk arrays-in/arrays-out,
    no per-element round-trips across the WASM boundary. Declared in P7,
    implemented here.
  - Reimplement the editor as a `uv_editor` addon against the interface. **Do
    not port `pending-port/`** (3,007 lines of code against BREP element types;
    3,104 with the checklist); use it as a spec, not as source.
  - UV ToolOps take a datapath to the source object; `window.redraw_uveditors`
    becomes an `ImageBus` signal; restore `selectedFacesOnly` as a real editor
    preference.
  - Two implementors land together: LiteMesh (`uv_source.ts`) and LeafMesh
    (design §12 step 7) — plus an in-memory test double that doubles as the
    sculptcore-free unit fixture.
  - Needs P8's sever, **not** P13's delete — this is deliberately off the
    critical path.
  - Exit: success criterion #11.

- [ ] **P19 — [W4b: port the unwrapping solvers](./2026-08-15-0430-w4-unwrapping-port.md)**
  - Port `unwrapping.ts`, `unwrapping_solve.ts`, `mesh_paramizer.ts` (~4,700
    lines rescued to `archive/` by P13) onto `IUVSource`. They are largely
    topology-agnostic; the work is the element-access seam, not the math.
  - Settle open decision #6 at P13 time, not here — the rescue must happen
    before the delete lands.
  - Exit: unwrap runs on both `IUVSource` implementors, one of them without
    sculptcore present.

> **⏸ Pause — compact, then switch to `xhigh` one last time.** P20 writes the
> public embedding surface — `mountFaberLeaf`, the per-instance registry, and
> the semver policy on `@framework/api`. It is the only plan whose output third
> parties depend on directly, which makes it the hardest one to revise later.

- [ ] **P20 — [W5b: de-globalize + embedding contract](./2026-08-15-0435-w5-deglobalize-embedding-api.md)** — **`[xhigh]`**
  - Audit and gate `window._appstate`, `window.DEBUG`, `window._SelMask`
    (`selectmode.ts:54`), `window.redraw_uveditors`, `globalThis._framework`,
    and the fixed `#canvas2d`/`#canvas3d`/`#iconsheet` IDs in `index.html`.
  - `mountFaberLeaf(container, options)` returning a handle; debug globals
    behind a dev flag. `globalThis._framework` is load-bearing for external
    addons — give it a per-instance registry, do not delete it.
  - Write `documentation/embedding.md`: host guarantees, what a distribution
    may override, and the semver policy on `@framework/api`.
  - Exit: success criterion #15, plus two instances mounted on one page.

> **⏸ End of the sequence — drop back to `high`.** P20 is the last plan; the
> remaining work is execution against twenty written plans, which is `high`
> throughout. Re-raise only if a plan turns out to have left its shape open.

### 9.4 Where the open decisions land

| §7 decision | Settled in | Deadline |
| --- | --- | --- |
| 1. Built-in geometry type | **Resolved** — LeafMesh (P3, P11) | — |
| 2. Modeling without sculptcore | P12 | before P13 |
| 3. File compatibility (pin ids vs. rewrite `_origBytes`) | P10 | before P13 |
| 4. Curves / tets / hair / subsurf | P13 | at the delete |
| 5. Texture painting | P5 | at the delete |
| 6. UV unwrapping | decided in P13 (rescue), executed in P19 | rescue before the delete |
| 7. Rename's storage keys | **Resolved** — migrate (P2, landed 2026-08-15) | — |
| 8. Does `faber-leaf-core` model on day one? | P12 | **before P13 is scheduled** — it decides the phase order |
| 9. One-way format break | P10, documented in P20 | before the first external embedder |
| 10. Does the sculptcore submodule go away? | **Resolved — no** (§7) | — |

Decisions 3, 8 and 9 are the ones that change the *shape* of the plan rather than
its content. All three must be answered before phase 9 is scheduled.

### 9.5 Where the success criteria are closed

| §8 criterion | Closed by |
| --- | --- |
| 0a. PR workflow blocks on test/typecheck/lint/layers | P1 |
| 0b. `check:layers` runs clean and measures the right paths | P1 |
| 0c. `typecheck` covers every addon source file | P1 |
| 1. `check:layers` at `error` from a published baseline | P9 |
| 2. No `addons/builtin/mesh` references — incl. Class E/F greps | P8 (sever), P13 (delete) |
| 3. Deinitialized submodule still installs/builds/boots | P16 |
| 4. Default sculptcore-present lane still gates merges | P1 (lane), P16 (keep it working) |
| 5. Unknown-addon bytes survive the round-trip | P10 |
| 6. Unknown-addon `lib_id` + `DataRef`s survive | P10 |
| 7. Saving never throws on either nstructjs struct path | P10 (incl. `vendor/nstructjs`) |
| 8. Struct ids stay meaningful across addon-set changes | P10 |
| 9. Settings + startup file load in a sculptcore-free build | P6 (SelMask), P10, P16 (flags) |
| 10. Two distributions, no fork | P17 |
| 11. UV editor on a non-LiteMesh source | P18 |
| 12. Third-party geometry type, no `scripts/` edit | P11 (proved), P14 (registry) |
| 13. That type renders an `AttributeNode` material | P7 (contract), P11 (proof) |
| 14. That type transforms through a registered `ITransDataType` | P7 (contract), P12 (proof) |
| 15. `documentation/embedding.md` | P20 |

Criteria 12–14 are each closed by a *pair*: the plan that writes the contract and
the plan that proves it with a second implementor. A contract with one implementor
has not been tested — it has been described.

Criteria 5–8 are all closed by P10 and are all four *separately* testable, which
is the point: today the tree passes none of them, and the failure modes are
different enough (crash on load, silent reference loss, throw on save, silent
mis-decode) that a single "round-trips" assertion would hide three of them.
