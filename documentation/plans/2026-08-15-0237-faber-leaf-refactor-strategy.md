# Faber Leaf refactor — high-level strategy

**Status:** strategy / direction-setting. Not an implementation plan; each
workstream below needs its own plan doc in `documentation/plans/` before work
starts.

**Date:** 2026-08-15

---

<!-- toc -->

- [1. Goals](#1-goals)
- [2. Where we are today](#2-where-we-are-today)
  - [2.1 The removal surface](#21-the-removal-surface)
  - [2.2 The coupling map](#22-the-coupling-map)
  - [2.3 What is already good](#23-what-is-already-good)
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

The mesh addon is ~40% of first-party non-vendor code. Deleting it is the
single largest lever available, and it is the *precondition* for everything
else — every other builtin addon declares `"dependencies": ["mesh"]`.

### 2.2 The coupling map

`grep` for `addons/builtin/mesh` finds **50 files** outside the mesh addon
itself. They fall into four classes, and the class determines the fix:

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

Separately, **sculptcore is coupled through pnpm, not just imports**.
`pnpm-workspace.yaml` lists five sculptcore paths as workspace packages, and
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
- **`core/missing_addon.ts`** already round-trips data for classes whose addon
  is absent (`MissingDataBlock`, `OpaqueCustomDataElem`, `MissingToolMode`),
  via nstructjs `onUnknownClass`/`onSerializeUnknown` hooks. This is the file-
  compat safety net that makes optional subsystems survivable.
- **`SceneObjectData`** already owns the picking contract (`castViewRay`,
  `findNearest`, `castScreenCircle`, `castScreenRect`) so `findnearest.ts` is a
  thin dispatcher. LiteMesh already implements it.
- **`@framework/api` + `@addon/<id>/api`** aliases, the esbuild plugins behind
  them, `tools/check-addon-duplication.js`, and `.dependency-cruiser.cjs` layer
  rules (`core-no-mesh`, `core-no-addons`, `util-no-mesh`) are all wired — the
  rules are just set to `severity: warn` "while the refactor is in flight."
- **`LiteMesh` is essentially already decoupled.** Its only mesh-addon import
  is the `MeshTypes` enum (Class B). Everything else routes through
  `@sculptcore/api`, `SceneObjectData`, and the render queue.
- **The integration suite is already sculptcore-first.** Of ~25 integration
  tests, nearly all are `sculptcore_*` / `litemesh_*`. Almost no test coverage
  is lost by deleting the BREP.
- **The UV editor was already slimmed** and its legacy parked under
  `pending-port/` with a written port checklist that *already names* the
  mesh-agnostic abstraction as the blocker.

The honest read: the previous refactor built the seams and stopped before
walking through them. This one walks through them and deletes what's behind.

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

Three interfaces carry the whole design. Getting these right is 80% of the
value; everything else is mechanical deletion.

**(a) `IGeometrySource` — what the host is allowed to ask geometry.**
Generalize the existing `SceneObjectData` contract into an explicit, documented
interface: bounds, transform, draw submission, the four picking entry points,
selection state, and undo push/pop. Anything the host currently learns by
`instanceof Mesh` must instead be a method here or a `data_kinds` descriptor
field. `SelMask` moves *out* of mesh vocabulary and becomes host-owned:
`SelMask.OBJECT` plus a per-kind sub-mask block that each provider claims at
registration.

**(b) `IUVSource` — the mesh-agnostic UV contract (W4).** See §4 W4.

**(c) `AddonAPI` — already exists.** Extend it, don't replace it: it needs
`api.registerDataKind(...)`, `api.registerUVSource(...)`, and a capability-
query (`api.has('sculptcore')`) so addons can degrade instead of crash.

The rule that makes this stick: **when the host needs to know something
type-specific, it asks the registry, never the type.**

---

## 4. Workstreams

### W0. Rename and rebrand

Small, do it first, unblocks nothing but avoids churn later.

- `package.json` name `webgl-app-framework` → `faber-leaf`; `index.html`
  `<title>`; `Readme.MD`.
- The tests workspace package is `@webgl-app-framework/tests-integration`
  (referenced in the root `test:slow` script) — rename together.
- `scripts/package.json` is confusingly named `@sculptcore/frontend` for what
  is the *app*, not sculptcore. Rename to `@faber-leaf/host`.
- Leave `@sculptcore/api` alone — that is the real sculptcore package name.

### W1. Sever core → mesh, then delete the TS BREP

The order matters: **sever first, delete second.** Deleting first turns 50
files red simultaneously and the migration becomes un-reviewable.

**Step 1 — host-owned selection vocabulary.** Move `MeshTypes`/`MeshFlags`
constants that the host actually needs into `scripts/editors/view3d/selectmode.ts`
(or a new `scripts/core/select_types.ts`) and invert the dependency: the mesh
addon imports from the host, not the reverse. Fix `selectmode.ts:1`,
`transform_types.ts:4-5`, `PropsEditor.ts:2,32`, and — importantly —
`litemesh_base.ts:1`. This alone unblocks LiteMesh from ever needing the mesh
addon again.

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

**Step 3 — flip the depcruise rules to `error`.** `core-no-mesh`,
`core-no-addons`, `util-no-mesh` are all `severity: warn` today with the
comment "convert to error in the cleanup pass." This is that pass. Add
`core-no-litemesh` and `core-no-sculptcore` at the same time so the new
geometry type cannot re-create the problem it was meant to solve. Wire
`pnpm check:layers` into CI as a blocking gate.

**Step 4 — delete.** `addons/builtin/mesh/`, plus `subsurf`, `curve`,
`mesh_edit`, `tetmesh`, plus `scripts/tet/` and `scripts/hair/`, plus their
`@framework/api` re-exports (`TetMesh`, `TetTypes`, `meshToTetMesh`,
`tetSolve`, …), plus `tools/migrate-mesh-registers.js`,
`addons/builtin/builtin_data_api.ts`, and the `IN_BUNDLE_BUILTIN_IDS` entries
in `tools/check-addon-duplication.js`.

**Step 5 — file compatibility.** Old `.wproj` files reference `Mesh`,
`CustomDataElem` subclasses, and mesh toolmodes. Decide explicitly (see §7)
between: (a) let `missing_addon.ts` swallow them as opaque blocks — files load
with empty objects, no crash; (b) write a one-way BREP→LiteMesh importer; or
(c) declare a format break. **Recommendation: (a) plus a loud UI notice.** The
placeholder machinery already exists and works; a converter is weeks of work
for content that mostly does not exist outside the author's own scenes.

**Boxmodel is the thing to watch.** `scripts/editors/view3d/tools/boxmodel.ts`
and `scripts/lite-mesh/litemesh_modeling_ops.ts` (1,592 lines) are the
LiteMesh-side polygon-modeling toolmode — this is the *replacement* for
`mesh_edit`, and it is sculptcore-backed. That means "delete the BREP" and
"make sculptcore optional" are in direct tension: with sculptcore absent, the
host has **no** geometry type at all. §7 covers the resolution.

### W2. Delete the TS sculpting stack

Cleaner than W1 — it is leaf code with almost no inbound dependencies.

- Delete `pbvh.ts`, `pbvh_base.ts`, `pbvh_bvhdef.ts`, `pbvh_holefiller.ts`,
  `pbvh_paintsample.ts`, `pbvh_sculptops.ts` (7,842 lines — the largest single
  file in the tree), `pbvh_texpaint.ts`, `pbvh_texpaint_blur.ts`, `pbvh_ui.ts`.
- Delete `addons/builtin/pbvh_sculpt/` and its `@framework/api` surface.
- Delete `scripts/test/test_sculpt.js` + `test_sculpt_run.js` (3,714 lines).
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

**Step 1 — a real capability boundary.** Everything that imports
`@sculptcore/api` (30+ files, essentially all of `scripts/lite-mesh/` plus the
sculpt toolmode) moves behind one gate. Two viable shapes:

- *Addon-shaped (recommended).* `scripts/lite-mesh/` and the sculpt/boxmodel
  toolmodes become a real addon — `addons/builtin/litemesh/` — with
  `"buildMode": "prebuilt"` and `"optional": true` in its manifest. Absent
  sculptcore, the addon is simply not registered; `missing_addon.ts` covers
  the file-load path. This is the shape that also serves W5, because a
  downstream embedder wants exactly this switch.
- *Lazy-import-shaped.* Keep the files where they are and gate every entry on
  `await getWasm()`. Less churn now, but leaves ~19k lines of sculptcore-
  dependent code inside the host, which defeats both goals.

Take the addon shape. The extra work is mostly moving files and fixing imports
— the addon registration machinery already handles the rest.

**Step 2 — decouple the build.** Today `pnpm-workspace.yaml` hard-lists five
sculptcore paths and `scripts/package.json` declares `@sculptcore/api` as a
`workspace:*` dependency. Replace with:

- Glob the workspace entries (`sculptcore/**` patterns that tolerate absence)
  or move sculptcore packages under a globbed root.
- Make `@sculptcore/api` an **optional** dependency of the *litemesh addon
  package*, not of the host package.
- Add a tsconfig `paths` fallback so `@sculptcore/api` resolves to a
  types-only stub when the real package is missing — otherwise `pnpm typecheck`
  fails in the exact configuration we are trying to support.

**Step 3 — the clone script.** Replace the `sculptcore` submodule entry in
`.gitmodules` with `pnpm setup:sculptcore`:

```
pnpm setup:sculptcore          # clone (pinned rev) + pnpm install + emsdk + wgpu-native
pnpm setup:sculptcore --ref X  # explicit revision
pnpm build:sculptcore          # existing make.mjs pipeline
```

Pin the revision in a committed `sculptcore.lock.json` (url + rev) so the
non-submodule path is still reproducible — a bare `git clone` of a moving
branch is a worse guarantee than the submodule it replaces, and reproducibility
is the one thing submodules were actually buying. `sculptcore/` goes in
`.gitignore`.

Note `scripts/path.ux`, `scripts/mathl`, and `vendor/nstructjs` stay as
submodules — they are pure-JS, small, and always required. Only sculptcore
(the C++/Emscripten toolchain dependency) is worth this treatment.

**Step 4 — a `--no-sculptcore` CI lane.** Build + boot + smoke-test with
sculptcore absent, on every PR. Without this the capability boundary rots
within weeks; it is the only mechanism that keeps the optionality real.

### W4. Mesh-source-agnostic UV editor

The existing `pending-port/TODO.md` already scoped this correctly and named the
blocker ("decouple UV display/edit from the `Mesh` addon so core does not
depend on mesh element types"). W1 removes the blocker; this workstream builds
the abstraction. **Do not port the old code back** — 3,007 lines written
against BREP element types, with stale imports, that nothing currently
compiles. Reimplement against the interface.

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
one *is* the W3 CI lane, and having two consumers of the mechanism from day
one is what keeps it honest.

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

Nine phases. Each ends at a green `pnpm test` + `pnpm typecheck` + a bootable
app — no phase leaves the tree broken.

| # | Phase | Depends on | Notes |
| --- | --- | --- | --- |
| 0 | LeafMesh core: storage, attrs, topo, `cdt2d` | — | Headless and dependency-free; runs in parallel with everything below from day one. |
| 1 | W0 rename | — | Trivial, do it first |
| 2 | W2 delete TS sculpting | — | **Start here** on the deletion track. Leaf code, biggest ratio of lines-deleted to risk. Independent of W1. |
| 3 | W1 steps 1–2: sever core→mesh | 2 | The hard part. Host-owned `SelMask`, registry-ize `api_define` / `PropsEditor` / `view3d_draw` / `entry_point`. |
| 4 | W1 step 3: depcruise → `error` | 3 | The ratchet. Nothing regresses after this. |
| 5 | W1 steps 4–5: delete the BREP | 4 | ~70k lines. Mechanical once 3–4 are done. |
| 6 | W3: sculptcore optional | 5 | Needs the BREP gone first, or "optional" is meaningless — the host would still carry a mandatory geometry type. |
| 7 | W5 steps 1–2: distributions | 6 | `faber-leaf-core` distribution *is* the W3 CI lane. |
| 8 | W4: UV abstraction | 5, 0 | Parallelizable with 6–7. Needs the BREP gone and LeafMesh's `IUVSource` as the second implementor. |
| 9 | W5 steps 3–4: de-globalize + docs | 7, 8 | Final polish. |

Phase 0 runs alongside everything — it is new code with no inbound
dependencies, and having a working geometry type in hand before phase 5
deletes the old one removes the scariest gap in the plan. Phases 2 and 3 can
run in parallel with different people. Phase 8 forks off after 5.

**Why sculpting deletion goes first:** it is the only large deletion with
essentially no inbound host dependencies, so it de-risks the process, shrinks
the surface for phase 3, and produces an immediate, visible win. Doing W1
first means carrying 15k lines of PBVH code through every intermediate state of
the core-severing work.

---

## 6. Risks

**The empty-host problem (highest risk).** After W1 and W3, a build without
sculptcore has zero geometry types. "It boots" is then a weak claim — nothing
can be modeled. Mitigation: ship **LeafMesh**, a small non-BREP geometry type
with first-class faces-with-holes and a ported CDT, as an in-bundle addon —
designed in
[2026-08-15-0248-leafmesh-design.md](./2026-08-15-0248-leafmesh-design.md).
It is what makes `faber-leaf-core` a real product rather than a compile
target, it is the second `IUVSource` implementor W4 needs, and it is the
worked example that proves success criterion #7. **This is an explicit
deliverable, not an afterthought** — its first three modules have no
dependency on the rest of the refactor and can start immediately.

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

**Reproducibility regression from unpinning sculptcore.** A clone script is
weaker than a submodule unless the revision is pinned. Mitigated by the
committed `sculptcore.lock.json` in W3 step 3 — do not skip it.

**Interface-design risk in W4/W5.** Both `IUVSource` and the distribution
manifest are single-consumer designs at authoring time. Mitigation is stated
in-line above: two implementors before either is declared done.

**Bit-rot of optionality.** Without the `--no-sculptcore` CI lane the boundary
dies quietly. This is the single highest-leverage piece of CI in the plan.

**Review burden.** ~95k deleted lines. Mitigation: the sever-before-delete
ordering means the large-deletion PRs are near-mechanical (imports already
gone), and the genuinely reviewable logic changes are concentrated in phase 3.

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
3. **File compatibility.** Recommended: opaque round-trip via `missing_addon.ts`
   plus a UI notice; no BREP→LiteMesh converter.
4. **Curves, tets, hair, subsurf.** Delete outright, or preserve in `archive/`
   as reference for later reimplementation? Recommend: `archive/`, since
   `archive/` already exists and the cost is zero.
5. **Texture painting.** Accept the gap after `pbvh_texpaint.ts` is deleted, or
   block W2 on a sculptcore-backed replacement? Recommend: accept the gap,
   track it in `ImmediateTODOs.md`.
6. **UV unwrapping.** Port `unwrapping_solve.ts` / `mesh_paramizer.ts` to the
   `IUVSource` interface (they are largely topology-agnostic solvers), or drop?
   Recommend: port — it is the most valuable algorithm code in the deleted set.

---

## 8. Success criteria

The refactor is done when all of these hold:

1. `pnpm check:layers` passes at `severity: error` with `core-no-addons`,
   `core-no-litemesh`, and `core-no-sculptcore` enforced.
2. `grep -r "addons/builtin/mesh" scripts/` returns nothing.
3. A fresh clone with **no** sculptcore builds, boots, loads a scene, and
   passes a smoke suite — enforced by a CI lane, not by hand.
4. `pnpm setup:sculptcore && pnpm build:sculptcore` produces the full app, at a
   pinned, committed revision.
5. Two distributions build from the same tree with no source forking.
6. The UV editor operates on a non-LiteMesh `IUVSource` in a test, with no
   sculptcore present.
7. A new geometry type can be added by a third-party addon — with LeafMesh
   serving as the worked example — touching no file under `scripts/`.
8. `documentation/embedding.md` exists and states the `@framework/api`
   stability contract.

Criterion 7 is the real test. If adding a geometry type still requires editing
`selectmode.ts`, `api_define.ts`, or `PropsEditor.ts`, the refactor has moved
code without changing the architecture.
