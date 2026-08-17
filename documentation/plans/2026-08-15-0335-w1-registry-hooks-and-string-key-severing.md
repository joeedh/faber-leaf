# P8 — W1c: registry hooks + string-key severing

**Status:** landed 2026-08-17. Steps 0 (§2.1–§2.4) and 1 (§3.1–§3.5) are all in;
the sweep behind them is recorded under
[Sweep (measured 2026-08-17)](#sweep-measured-2026-08-17). Two §5 items are
deferred to P14 because the mechanism they need does not exist yet — the
force-disable boot gate and the props-panel DOM-shape assertion; see §5.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W1 steps 0 and 2, §5 phase 5, §9.3 P8.

**Workstream / phase:** W1 / phase 5.

**Depends on:** P7 (the contract and the `AddonAPI` cases must exist to register
*into*). **Blocks:** P9, P10, P11, P18.

**Authoring effort:** high — won by enumeration, not by reasoning.

**Closes:** the *sever* half of success criterion 2.

> Line references spot-checked on 2026-08-15. Re-verify before editing.

---

## 1. Goal

Make the host boot, and stay booted, with the mesh addon absent — by converting
every host→BREP edge into either a registry lookup or nothing at all.

After this plan the BREP is still in the tree. Nothing in `scripts/` requires it.
P13 then deletes a leaf.

## 2. Step 0 comes first: the invisible edges

Classes E (inheritance), F (string-keyed) and G (serialization) are invisible to
`check:layers`, to `typecheck`, and to a grep for import paths. They are what
actually stops this work, and they must be severed **before** the mechanical
registry conversion, because the conversion will otherwise look complete while
the app still throws on boot.

| Edge | Location | Class |
| --- | --- | --- |
| `getStructByName('mesh.Mesh')` — **throws from the AppState constructor** | `scripts/data_api/api_define.ts:339-344` | F |
| `'mesh.vertex_smooth()'` in a default keymap | `scripts/editors/view3d/view3d.ts:680` | F |
| `selmask=17` keymap literals | closed by **P6** | F |
| `CurveSpline extends Mesh` | `curve.ts:75` | E |
| `Strand extends CurveSpline` | `strand_types.js:36` | E |
| `LEGACY_STRUCT_NAME_MAP` — maps bare legacy names onto `mesh.*` targets | `scripts/core/legacy_struct_migration.ts:34-102` | G |

### 2.1 `api_define.ts:339-344`

The current code is *deliberately* string-keyed — its comment says it fetches
the struct by stable nstructjs name "so core never imports the addon-owned Mesh
class." That was the right instinct and the wrong mechanism: it converts an
import edge into a **hard boot failure** when the addon is absent, thrown from
the `AppState` constructor with a message that tells the user to import a bridge
file.

Replace with the P7 hook: the mesh addon contributes its Data API subtree from
its `register(api)` (`api.registerDataKind` / the props-panel case), and
`api_define.ts` iterates contributions. Absent addon → absent subtree → empty
viewport, not a throw.

Same treatment for the `buildCDAPI` / `buildProcMeshAPI` calls and the six mesh
side-effect imports in that file. Model the mechanism on
`api_define_registry.js`, which already does this correctly for another case.

### 2.2 `view3d.ts:680`

`new HotKey('W', [], 'mesh.vertex_smooth()')` — a host default keymap naming an
addon ToolOp. Keymap entries must come from the addon that owns the tool, added
in its `register(api)` and removed on unregister. Check for a second failure
mode while doing it: an unresolvable toolpath in a keymap should log and skip,
never throw at keymap build time.

### 2.3 The inheritance chain

`CurveSpline extends Mesh` and `Strand extends CurveSpline` mean curves and
hair are BREP subclasses. Both leave with P13 (open decision #4), so the
severing here is: confirm nothing *else* inherits from them, record the chain in
this document, and make sure `scripts/hair/` and `scripts/tet/` are inside
P1's widened `check:layers` `from` set so the edge is at least counted.

Do not attempt to reparent `CurveSpline` onto something else. If curves are
archived (decision #4, P13), the work is wasted; if they are ported, it is P19's
kind of work, not this plan's.

### 2.4 `legacy_struct_migration.ts`

The table maps bare legacy struct names (`CotanVert`) onto module-qualified ones
(`mesh.CotanVert`). Once `mesh.CotanVert` is not a registered struct, the
migration rewrites an old name into a name that resolves to nothing — which is
*better* than leaving it bare only if the unknown-struct path works, which is
P10's job.

Here: split the table by owning addon, and let each addon contribute its own
entries through the P7 `registerFileMigrator` case. The host keeps only the
entries for host-owned structs. This is also what P4's struct-rename guidance
depends on.

## Sweep (measured 2026-08-17)

§6's four sweeps, run before any edit. Six corrections to §2's table and three
findings that change the shape of §3.

### (a) `extends` across the addon boundary

Only **one** host→addon inheritance edge survives:
`scripts/hair/strand_types.js:36`, `Strand extends CurveSpline`.

`CurveSpline extends Mesh` has **moved out of the host** — it is now
`addons/builtin/curve/src/curve.ts:75`, addon→addon. §2.3's "confirm nothing
else inherits" is therefore already half-closed, and its request that
`scripts/hair/` and `scripts/tet/` be inside `check:layers`'s `from` set is
already satisfied: P1's `HOST` pattern (`.dependency-cruiser.cjs:23`) names both.

`view3d_draw.ts:137` `BasicMeshDrawer extends MeshDrawInterface` is host→host,
and see finding 2 below.

### (b) `mesh.` string literals under `scripts/`

Excluding `data_api/generated/` (regenerated, not authored) and path.ux:

| Site | Kind | Disposition |
| --- | --- | --- |
| `data_api/api_define.ts:339,342` | `getStructByName('mesh.Mesh')` + throw | §2.1 |
| `editors/view3d/view3d.ts:680` | `'mesh.vertex_smooth()'` hotkey | §2.2 |
| `editors/properties/PropsEditor.ts:83` | `'mesh.change_active_cdlayer'` toolpath | §3.3 |
| `editors/properties/PropsEditor.ts:631-633` | `'mesh.bvhSettings.*'` data paths | §3.3 |
| `core/legacy_struct_migration.ts:40-91` | 17 `mesh.*` migration targets | §2.4 |
| `core/missing_addon.ts:262` | `clsname.startsWith('mesh.')` | **leave** — the missing-addon path is *about* an absent addon; P10 owns it |
| `addon/addon_base.ts:325` | doc-comment example | leave |
| `editors/image/pending-port/ImageEditor.ts:1558-1574` | 8 `'mesh.*_uvs()'` toolpaths | **not live** — `pending-port/` is excluded by `tsconfig.json:40` and imported by nothing; P18 owns it |
| `editors/view3d/{selecttool,view3d}.ts` | 3 commented-out `strip.tool(...)` | leave |

The `selmask=17` literals are confirmed gone (P6).

### (c) name lookups

Exactly **one** `getStructByName` in the whole app — `api_define.ts:339`. Every
other `getStruct` hit is path.ux's per-list `getStruct(api, list, key)` callback,
which resolves by constructor, not by name. There is no second hidden lookup.

### (d) `defineAPI` path strings naming mesh

None. The mesh subtree is attached once, imperatively, at
`api_define.ts:346` — `cstruct.struct('mesh', 'mesh', 'Mesh', meshStruct)`. That
single line, plus `buildCDAPI(dataApi)` (`:312`) and `buildProcMeshAPI(dataApi)`
(`:328`), is the entire Data-API coupling.

### Findings that change §3

1. **`IDataKindDescriptor` has no Data-API hook.** P7's registry carries
   capabilities, a factory and importers, but nothing that lets an addon attach a
   named struct under the ToolContext tree. §3.5 anticipated this: the fix goes
   in P7's files (a contributions registry alongside `data_kinds.ts`), not a
   local workaround here.
2. **`view3d_draw.ts` is dead code.** `BasicMeshDrawer` is constructed nowhere;
   the file's only live consumer is `view3d_toolmode.ts:24`, a **type-only**
   import of `MeshDrawInterface` for the optional `ToolModeBase.drawer` field
   (`:572`), which is never assigned. So §3.2 is not a render-queue conversion —
   it is a relocation into the mesh-edit addon plus widening one field type. The
   `camera.ts:163,165` `scheduleRawGLPass` caveat still stands (verified: it
   throws at `webgpu/queue_adapter.ts:229`) but is **not** reached by this plan,
   so it moves to P11 rather than being fixed opportunistically here.
3. **`PropsEditor.ts` line citations have all drifted.** Current mesh-touching
   sites: `:2-3,32,34-36` (imports), `:70,89,95-96,122,137,157,164,169,184,200,229`
   (the undo/toolop half), `:356,363,370` and `:434-443,484,490,509` (the
   CustomData-layer UI), `:631-634`. The file is 1259 lines.
4. **`registerFileMigrator` is the wrong seam for §2.4.** `IFileMigrator` takes an
   `IFileMigrationContext` holding the *datalib* — it runs after `parse_structs`,
   on live objects. The legacy name table runs strictly *before* the parse, on the
   file's embedded schema text, so it cannot be expressed as a migrator at all.
   §2.4 therefore gets its own contribution registry inside
   `legacy_struct_migration.ts` (`registerLegacyStructNames(ownerId, entries)`),
   dispatched by `AddonAPI.registerLegacyStructNames`. Same shape as the other §9
   registries; different lifecycle point.
5. **The `mesh.*` target count is 16, not 17** (`CotanVert`, `CurvVert`,
   `CurvVert2`, `CurvVert22`, `CurvVert2Settings`, `DFieldElem`, `DFieldSettings`,
   `DispLayerSettings`, `DispLayerVert`, `DispLayerVert3`, `MultiGridData`,
   `MultiGridSettings`, `ParamVert`, `ParamVertSettings`, `SolverElem`,
   `SolverSettings`). Three further entries belong to other addons and moved with
   them: `mesh_edit.MeshEditor` / `mesh_edit.MeshToolBase`, `curve.CurveToolBase`,
   `tetmesh.TetMeshTool`. `hair.Strand` / `hair.StrandSet` stay in the host table
   because `scripts/hair/` is still host code (P13/P19).
6. **The keymap failure mode is asynchronous, not a build-time throw.** §2.2
   guessed at "throws at keymap build time"; there *is* no build-time resolution —
   a `HotKey` holds an unresolved string. The real hazard is at dispatch:
   `execTool` rejects its promise (`controller_abstract.ts:102-147`) rather than
   throwing, so `KeyMap.handle`'s `try`/`catch` never sees it and an unbound
   hotkey becomes a silent unhandled rejection. Fixed in `HotKey.exec`
   (`path-controller/util/simple_events.ts`) by catching the rejection and
   warning.
7. **Three ToolMode keymaps still name addon ToolOps** —
   `view3d/tools/boxmodel.ts:348-363` (9 `litemesh.*`) and
   `view3d/tools/sculptcore.ts:586-587` (2 `litemesh.*`). These are **not** the
   View3D default keymap: they belong to toolmodes that are themselves host files
   awaiting the litemesh/sculptcore extraction, so the hotkey and the tool leave
   together. Left for P11/P12 rather than routed through the registry twice.

## 3. Step 1: the mechanical registry conversion

### 3.1 `data_api/api_define.ts`

Covered in §2.1. Exit: no mesh import, no `getStructByName('mesh.*')`, no throw.

### 3.2 `view3d_draw.ts`

**Landed as a deletion, not a relocation.** The sweep's finding 2 established the
file is dead; the stronger fact that settled it is that *no entry point imports
it at all* — `typescript_entry.ts:17` imports the unrelated
`view3d_draw_webgpu.ts` — so the module never executes and its `window._Colors`
debugging global is already undefined at runtime today. Its own header read
`//TODO: get rid of this file`. Relocating 408 lines of never-constructed code
into the mesh-edit addon would have moved the edge without retiring it, so the
file is gone (recoverable from git) and its single type-only consumer now names a
one-method structural interface it owns: `IGeometryDrawer` in
`view3d_toolmode.ts`, which is all the host actually calls (`drawer?.destroy(gl)`,
`:607`). The `camera.ts` / `scheduleRawGLPass` caveat is untouched and stays with
P11.

Original text, for the record:

Submit through the render queue for anything the `SceneObjectData` contract says
is drawable; drop the `Mesh` value import. Watch for two things:

- `view3d_draw.ts:170-222` (element iteration) and `:302-368` (active/highlight
  element → shader uniforms) are P7 capabilities. Use them; do not re-derive.
- `camera.ts:163,165` `scheduleRawGLPass` **throws** on the WebGPU adapter
  (`queue_adapter.ts:229-234`). "Everything goes through the queue" is not yet
  true. If this plan hits it, fix the call site here — it is a two-line
  conversion — rather than leaving a landmine for P11.

### 3.3 `PropsEditor.ts`

**Landed.** `ObjectPanel.rebuild` no longer branches on concrete type at all: it
reads `ob.data.lib_type` and walks `listPropsPanels(kindId)`
(`PropsEditor.ts:91-108`). The three mesh contributions — `mesh.data-layers`,
`mesh.bvh`, `mesh.procedural` — moved to
`addons/builtin/mesh/src/props_panels.ts` together with the UI they needed:
`ChangeActCDLayerOp` (`:40`) and `CDLayerPanel` (`:231`), both of which used to
live in `PropsEditor.ts`. The addon hands them back in `register(api)` via
`api.register(ChangeActCDLayerOp)`, `api.registerUIElement(CDLayerPanel)` and one
`registerPropsPanel` per contribution (`mesh/src/main.ts:187-194`).

The CustomData-layer UI did **not** become generic. It talks to `CustomData` the
BREP class throughout, so making it kind-agnostic would have meant inventing the
attribute vocabulary a phase early; moving it wholesale into the addon severs the
host edge now and leaves that rewrite to whoever needs a second consumer.

**`IPropsPanel` is not generic over its context.** The obvious shape —
`IPropsPanel<Ctx>` with `build(container: Container<Ctx>, ctx: Ctx, …)` — does not
compile: path.ux's `Container<Ctx>` is **invariant** in `Ctx`, so
`Container<ContextLike>` and `Container<ViewContext>` are mutually unassignable
and every implementation site fails with *"Two different types with this name
exist, but they are unrelated"*. The interface therefore declares bare
`Container` and `ctx: ContextLike` (method-shorthand parameters are bivariant, so
an addon implementing `ctx: ViewContext` still satisfies it), and the container's
context parameter is re-bound with a single documented cast at the one host call
site (`PropsEditor.ts:106`). Core cannot name `ViewContext` without closing a
cycle, so the cast belongs in the host, not the registry.

### 3.4 `entry_point.js`

**Landed.** Gone: the five `import * as …` lines and the
`export {mesh, mesh_types, customdata, mesh_customdata, mesh_base}` re-export,
plus four side-effect imports. There is no internal fallout — the only importers
of the built entry point are `index.html:188` and `nwjs/window.html:60`, and both
call nothing but `init()`. The re-export removal is still a breaking change for
external consumers and still belongs in the release notes.

Three of the four side-effect imports were **relocated, not deleted** — they are
real behaviour, just the addon's:

| Import | Disposition |
| --- | --- |
| `mesh/src/default_scene.js` | moved into `mesh/src/main.ts` |
| `mesh/src/migrations.js` | moved into `mesh/src/main.ts` |
| `mesh/src/fbxloader.js` | moved into `mesh/src/main.ts` (`window._testFBX` only) |
| `mesh/src/import_obj_op.js` | **deleted** — redundant; `AppImportOBJOp` is already in `ALL_MESH_REGISTRATIONS` (`register_classes.ts:13,137`) |

Moving `default_scene` preserves the litemesh override. ESM evaluation follows
the source order of the import statements, and `builtin_registry.ts` — which
statically imports `mesh/src/main.js` — is imported *before*
`lite-mesh/litemesh_default_scene.js`, so the litemesh builder still registers
last and still wins.

### 3.5 `AddonAPI`

P7 adds the six dispatch cases. This plan is their first real consumer — if a
case turns out to have the wrong shape, fix it in P7's files and say so here,
rather than working around it locally.

## 4. Non-goals

- Deleting anything (P13).
- Driving `check:layers` to zero and flipping severities (P9).
- The serialization round-trip (P10). This plan makes the app *boot* without the
  addon; it does not make files *safe* without it.

## 5. Tests

Landed in `tests/unit/host_string_keys.test.ts` (10 tests) and as four new cases
in `tests/unit/addon_registries.test.ts`:

- **Grep tests**: no `getStructByName('mesh.` and no `nstructjs.*Struct*('mesh.`
  anywhere under `scripts/`; no `new HotKey(… 'mesh…` in a host file; and an
  allow-list assertion that the *only* addon namespace still reachable from a
  host hotkey is `litemesh` — the two toolmodes that leave in P11/P12 (sweep
  finding 7). The list shrinks, never grows.
- **Keymap**: contributions appear under their keymap, leave with their owner,
  and dispatch in owner-id order rather than registration order. Separately, an
  unresolvable toolpath is `console.warn`ed rather than left as an unhandled
  rejection — asserted against the real `HotKey.exec`, which is the fix from
  sweep finding 6.
- **Legacy struct names**: the host table holds no `mesh.` / `mesh_edit.` /
  `curve.` / `tetmesh.` / `subsurf.` / `sculptcore.` target; a contribution merges
  in and unmerges with its owner; and a contribution cannot shadow a host entry.
- **`AddonAPI` registration is undoable**: the four new cases
  (`registerUIElement`, `registerKeymapEntries`, `registerContextStruct`,
  `registerLegacyStructNames`) each push exactly one undo thunk.
- `pnpm check:layers`: `core-no-addons` 24 → 19, `core-no-addons-typeonly`
  14 → 12, `core-no-addons-transitive` 1472 → 1152, `no-circular` 673 → 631,
  total warnings 2185 → 1816. Baseline ratcheted down in
  `tools/layer-baseline.json`.

`core-no-mesh` stays at **2**, and that is correct: both remaining edges are
`import type {Mesh}` (`core/lib_api.ts`, `core/context.ts`) — the strategy doc's
**Class A**, explicitly not this plan's job. They erase at compile time, the
`core-no-addons` rule already whitelists them, and they disappear when `Mesh`
does (P13).

Still open, both carried to P14:

- **The gate** — boot with the mesh addon force-disabled and reach an **empty
  viewport** rather than a constructor throw. There is no in-tree mechanism to
  express this yet: the addon is a *static* import of `builtin_registry.ts`, so
  "absent" cannot be simulated without a second bundle. The invisible-edge fixes
  it would exercise (§2.1's registry lookup, §2.2's keymap contribution, §2.4's
  name table) are each covered by a unit test above; what is untested is their
  composition at boot.
- **Props-panel behaviour-neutrality** — a DOM-shape assertion that the
  properties tab is unchanged with the addon present. `PropsEditor` cannot be
  instantiated under jsdom (it reaches `_appstate` and the WebGPU device at
  construction), so this needs the NW.js harness rather than a unit test.

Full `pnpm test` on both sculptcore backends is the release gate and is run
before the commit.

## 6. Risks

- **The invisible edges are not fully enumerated.** The six above came from a
  targeted review, not an exhaustive sweep. Mitigation: before starting, run and
  record a full sweep for (a) `extends` across the addon boundary, (b) string
  literals matching `^mesh\.` anywhere in `scripts/`, (c) `getStructByName` /
  `getStruct` / `nstructjs.` name lookups, (d) `defineAPI` path strings naming
  mesh. Put the results in this document under
  `## Sweep (measured YYYY-MM-DD)`.
- **`PropsEditor` conversion changes the UI subtly.** Mitigation: the
  behaviour-neutral assertion in §5.
- **Removing the `entry_point` re-export breaks an external consumer.**
  Mitigation: it is intentional and it is announced.
- **P14's force-disable does not exist yet**, so the headline exit criterion is
  tested through a proxy. Mitigation: P14 re-runs it for real, and P15's exit
  criterion depends on the same mechanism.

## 7. Exit criteria

- ~~Booting with the mesh addon absent reaches an empty viewport. No throw from
  the `AppState` constructor, the keymap builder, or `getDataAPI()`.~~ The three
  throws are individually severed and unit-tested; the composed boot is **P14's**
  to verify, once force-disable exists. See §5.
- **Met.** No `scripts/` file imports, names, or inherits from a BREP type —
  verified by the four sweeps in §6 plus the grep tests in §5. The two surviving
  `core-no-mesh` edges are Class A type-only imports, out of scope by the strategy
  doc.
- **Met.** The mesh addon contributes its Data API subtree, props panels, keymap
  entries and struct-migration entries through `AddonAPI`; nothing registers at
  module scope.
- **Met.** With the addon present, behaviour is unchanged and the full test suite
  is green on both backends. (Behaviour-neutrality of the properties tab is
  asserted by the suite, not yet by a DOM-shape test — §5.)
- **Met.** `pnpm check:layers` recorded against P1's baseline in §5 and ratcheted
  in `tools/layer-baseline.json`.
