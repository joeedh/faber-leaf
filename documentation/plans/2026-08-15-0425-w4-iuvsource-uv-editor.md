# P18 — W4a: `IUVSource` + the mesh-agnostic UV editor

**Status:** in progress — §5 is closed. All three implementors landed and run
through one conformance suite; the editor's host-free core, its addon, its
Editor component, every tool path the archive registered, the redraw bus that
replaced the `window.redraw_uveditors` global, and `selectedFacesOnly` as a
proven op input are in, and `archive/uv-editor/` is gone. What is left is §6's
last two tests: the `--no-sculptcore` run of the double suite, and the `.wproj`
round-trip.

**Date:** 2026-08-15 (citations re-verified 2026-08-19)

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W4, §5 phase 12, §9.3 P18.
**Reference:** `archive/uv-editor/TODO.md` — the slim-down author's own port
checklist, and more accurate than this plan about what the old editor did.
Step 7 deleted it with the rest of the directory and records where each of its
rows landed; read the original out of git history if you need it
(`git show 1b268752:archive/uv-editor/TODO.md`). Two of its statements were
already stale by then: the directory had moved out of
`scripts/editors/image/pending-port/` (P13, `8d4ee0c4`), and `ImageBus` no
longer has the live importer it names — see §2.

**Workstream / phase:** W4 / phase 12.

**Depends on:** P8 (registry hooks), P11 (a second geometry type to be agnostic
*about*). **Blocks:** P19, P20.

**Authoring effort:** high.

**Closes:** success criterion 11.

---

## 1. Goal

Bring UV editing back as an addon that reads UVs through an interface, so that
LiteMesh, LeafMesh and a test double are all first-class UV sources, and none of
them is named in the editor.

## 2. Current state

The image editor was slimmed to "load `ImageBlock`s and pan/zoom" and the entire
UV half was moved, unwired, to what is now `archive/uv-editor/` (P13 moved it
there from `scripts/editors/image/pending-port/`; see `archive/README.md`).
Step 7 has since deleted that directory —
`git show 1b268752:archive/uv-editor/<file>` still reaches every file named
below, and the same goes for the citations further down this section:

| File | Lines | What it held |
| --- | --- | --- |
| `uv-editor/ImageEditor.ts` | 1,791 | the old editor **plus** the `UVEditor` UIBase component, `findnearestUV`, `DrawLine`, `ImageBlockOp` / `SetImageTypeOp`, the UV sidebar, and `window.redraw_uveditors` |
| `uv-editor/uv_selectops.js` | 335 | `uveditor.toggle_select_all`, `pick_select_linked`, `select_one` |
| `uv-editor/uv_transformops.js` | 550 | `uveditor.translate` / `scale` / `rotate`, modal, reading the mouse off `ctx.editors.imageEditor.uvEditor` |
| `uv-editor/uv_ops.js` | 331 | `uveditor.project_uvs`, `set_flag` / `clear_flag` / `toggle_flag` (`UVFlags.PIN`) |
| | **3,007** | |

Live remnants:

- `scripts/editors/image/ImageEditor.ts` — 552 lines, the minimal editor.
  `:534-552` declares and defines `window.redraw_uveditors`, called from
  `scripts/image/image_ops.js:119` and (in `pending-port`) from four UV op
  sites.
- `scripts/editors/image/ImageBus.ts` — 9 lines, triggers `resetDrawLines`,
  `flagRedraw`, `addDrawLine` (step 5 kept only `flagRedraw`). Deliberately left in place and re-exported from
  `@framework/api` — which, since P13 archived the unwrapping stack, is now its
  **only** reference anywhere in `scripts/`, `addons/` or `distributions/`.
  Nothing subscribes and nothing triggers: it is dead, not merely unheard, so
  §7's "verify each trigger still fires" is answered — none of them do, and the
  new editor's subscription has to be paired with a new caller.
- `addons/builtin/mesh/src/mesh_uvops_base.ts` — **deleted with the rest of
  `addons/builtin/mesh/` in P13**. Its hardcoded `selectedFacesOnly = true` went
  with it, so step 6 is no longer a rewrite of an existing file: it is deciding
  where the flag lives now. This plan puts it on the source
  (`IUVSource.listUVFaces(layer, selectedOnly)`), which is what §4.1 already
  asked for. The ops that read it are archived alongside it, under
  `archive/unwrapping/`.
- The tool paths listed in `archive/uv-editor/TODO.md` are unregistered and
  throw "unknown tool" if invoked.

Data-path change to carry through the port: the old editor nested everything
under a `uvEditor` sub-component (`imageEditor.uvEditor.imageUser.image`); the
new one owns the `ImageUser` directly (`imageEditor.imageUser.image`).
`archive/uv-editor/TODO.md` lists the consumers that were updated — those are exactly
the sites a naive port would break again.

## 3. Do not port the old code back

3,007 lines written against `Mesh`, `Loop`, `MeshFlags`, `mesh.faces.selected.editable`.
Porting it means porting the BREP element model with it, which is the opposite
of this workstream.

Use it as a **specification**: it is the record of what UV editing in this app
actually did, including the pieces nobody would think to re-specify (pinning,
`select_linked`, draw-lines, projection). Read it, list the behaviours, then
implement them against the interface. `archive/uv-editor/` was deleted in step 7,
along with its row in `archive/README.md`.

## 4. `IUVSource`

**Already declared.** P7 wrote `IUVSource` into
`scripts/core/geometry_contract.ts` ahead of any implementor, and
`documentation/geometry-contract.md` §11 reserves the right to revise it for
*this* plan alone. §5 step 1 is therefore closed on arrival, and what follows is
the record of the revision this plan made rather than a design still to do.

The strategy's original sketch, kept for comparison:

```ts
interface IUVSource {
  getUVLayers(): UVLayerDesc[]
  activeUVLayer(): number
  readUVs(layer: number, out: Float32Array): void
  selectedUVs(layer: number): Uint8Array
  setUVSelect(layer: number, indices: Int32Array, state: boolean): void
  writeUVs(layer: number, uvs: Float32Array, indices?: Int32Array): void
  pinUVs?(layer: number, indices: Int32Array, pinned: boolean): void
  unwrap?(opts: UnwrapOptions): void
}
```

P7's declaration was already stricter than that sketch — bulk everywhere,
opaque handles, `out` buffers, CSR fans. This plan added three things it was
missing, each because an implementor or the editor could not be written without
it:

- **`readonly topoStamp`** — handle validity is the source's to report. Without
  it a source with no geometry behind it (the in-memory double) could not say
  when its handles go stale, and the editor would have had to find an
  `IElementSource` to ask, which is exactly the coupling the resolver avoids.
- **`listUVFaces(layer, selectedOnly?)`** — the answer to §4.1's
  `selectedFacesOnly` question, expressed as a filter on the source.
- **`getUVFaceRings(layer, faces)`** — a face's UV elements in winding order,
  CSR-shaped. Without it the editor would rebuild rings out of the geometry to
  draw or pick anything, which is the BREP-shaped coupling this workstream
  exists to remove.

One convention the conformance suite forced into writing: an `out` buffer may
come back as a *view*, so callers compare buffers, never object identity. That
is now stated on `IElementSource`'s `out` note, which the whole contract shares.

Four constraints, from §4 W4, restated because each one is a rule the
implementation will otherwise break:

1. **Bulk access via opaque handles.** No per-element JS objects crossing the
   seam — that is what made the old editor BREP-shaped. Same handle-validity
   rule as P7: a handle is valid until the source's `topoStamp` changes.
2. **The editor owns no geometry state.** It holds a datapath to a source and
   re-reads. It does not cache element references across ToolOps.
3. **UV ToolOps take a datapath**, not `ctx.mesh`. This is what kills
   `mesh_uvops_base.ts`'s dependence on a global "the mesh".
4. **`ImageBus` replaces `window.redraw_uveditors`.** The bus already exists and
   already has `flagRedraw`; the new editor subscribes (the old handler was
   `ImageEditor.onTrigger`). Convert `image_ops.js:119` and delete the global
   and its `declare global` block. P20 audits what remains — do not leave this
   one for it.

### 4.1 Open questions — settled

- **What is a UV element?** Whatever domain the source stores UVs on, reported
  as `IUVSource.uvDomain`, with `getUVOwners` mapping an element back to the
  geometry element that carries it. On LeafMesh that domain is `CORNER` and the
  map is the *identity*; on the in-memory double the owners are grid vertices
  and it is many-to-one. Both are conformant, which is the check that the
  interface did not quietly assume one mesh's storage. `getUVs` packs `[u, v]`
  per handle.
- **`selectedFacesOnly`.** A filter on the source:
  `listUVFaces(layer, selectedOnly)`. The op passes the flag through; no editor
  state and no hardcoded default survive.
- **Layer identity.** `listUVLayers()` returns names in layer order and an index
  into that array is a `layer`. The *name* is what a file persists; the index is
  valid only for as long as the layer set is unchanged.
- **Where the flags live** (not in the original list, but a source has to answer
  it): on LeafMesh, in a sibling `Byte` corner layer named `.uvflags:<uv name>`,
  persistent so §6's `.wproj` round-trip holds, and internal so it can never
  itself be mistaken for a UV map.

## 5. Plan

1. ~~Declare `IUVSource` in the host and register implementations through the
   P7 `AddonAPI`.~~ **Done by P7**: the interface is in
   `scripts/core/geometry_contract.ts`, the registry is
   `scripts/core/uv_sources.ts` (a resolver keyed by data-kind id, not a
   capability narrow, because a provider may hand back an adapter over a cached
   unwrap), and the hook is `AddonAPI.registerUVSource`. Revised here per §4.
2. **Implement it three times, in the same PR** — this is the point of the
   plan. LiteMesh, LeafMesh, and an in-memory test double (a fixed grid of UVs
   with no geometry behind it). The double is what makes the editor testable
   headlessly and is the honest check that the interface is not
   LiteMesh-in-disguise. If any implementor needs an interface change, the
   interface is wrong — change it, do not special-case.
   - [x] **LeafMesh** — `addons/builtin/leafmesh/src/uv_source.ts` over a pure
     `uv_geom.ts`, registered from the addon's `register(api)` hook. UVs are
     corner-domain, so `getUVOwners` is the identity.
   - [x] **The double** — `tests/lib/uv_grid_source.ts`, a W×H grid of quads
     with vertex owners and no geometry object.
   - [x] **LiteMesh** — `addons/builtin/litemesh/src/uv_source.ts`, an adapter
     over ten new *bulk* methods bound on sculptcore's `Mesh` (`liveElems`,
     `topoStamp`, `uvCornerVerts`, `uvCornersOfVerts`, `uvFaceRings`,
     `uvGather`/`uvScatter`, `uvFlagsGather`/`uvFlagsScatter`), because
     attribute values are paged behind `AttrData<T>` and reachable from TS only
     one element at a time. A UV element is a corner and its owner is a vertex,
     so owners are many-to-one — the interface was shaped against those
     constraints from the start (strictly bulk, CSR, no per-element accessor)
     so that writing LeafMesh first could not bias it. Flags live in a
     persistent `.uvflags:<layer>` `BYTE` sidecar, named C++-side because names
     do not cross the generic method binding. Fan welding is computed host-side
     from the `uvCornersOfVerts` CSR, keeping the tolerance a host policy.
   - [x] **One suite, three implementors.** The rules moved to
     `scripts/core/uv_source_conformance.ts` and are jest-free: an addon imports
     `@framework/api`, which the unit workspace does not resolve, so *neither*
     real provider could ever have been run from `tests/`. Each addon carries a
     `*_uvsource_support.ts` driver and one headless NW.js boot runs both
     (`tests/integration/uv_source_conformance.test.ts`, per backend, so the
     native and WASM vector seams are both proven);
     `tests/lib/uv_source_conformance.ts` is now a thin jest wrapper over the
     same rules for the double.
3. Reimplement the editor as an addon (`addons/builtin/uv_editor/`), consuming
   `IUVSource` only. Draw, pick (`findnearestUV`'s replacement, reading through
   bulk handles), select, pin, transform.
   - [x] **The behaviour**, as one host-free module:
     `addons/builtin/uv_editor/src/uv_edit_geom.ts`. Draw geometry, picking,
     flags with snapshot/restore, selection, islands (union-find over face rings
     and UV fans — two elements are linked when a ring holds both or they are
     coincident on one owner, which is exactly what a seam is the absence of),
     and the proportional-edit transform gather plus translate/scale/rotate.
     Its only host import is `import type`, which the jest transform erases, so
     the whole editor runs under plain jest against the double while still
     typechecking against the real contract —
     `tests/unit/uv_editor/uv_edit_geom.test.ts`, 35 tests, no geometry engine
     in the process. Every rule that could otherwise hide in a UI callback lives
     there for that reason.
   - [x] **The addon**, external and default-on in both distributions. Out of
     bundle for a stronger reason than leafmesh's: a physical build boundary is
     a better guarantee of criterion 11 than a lint rule, and the built
     `build/addons/uv_editor/src/main.js` has five inputs, all its own.
   - [x] **The Editor component** — `uv_editor_area.ts`: the area, Canvas-2D
     draw (checker, backdrop image, edges, points), `VelPan` pan/zoom, and
     mouse-move highlight, reaching geometry only through `uvSourceFor`. Kept
     out of `index.ts` because it imports host *values* and so cannot run under
     jest; the rules it needs are all in the core it calls. Selection is
     deliberately not here — it is written once, in its undoable `uveditor.*`
     form, in step 4.
   - [x] **Editors registered by an addon get a data API.** `getDataAPI()` is
     one-shot and runs before addons start, so `buildEditorsAPI` had already
     swept `areaclasses` by the time an addon registered an editor: no struct,
     no `editors.<name>` context path, so every `prop()` binding and
     `VelPanPanOp`'s datapath would have failed. `defineEditorAPI(api, cls)` is
     now factored out of `buildEditorsAPI` and is idempotent, and
     `AddonAPI.register` calls it for an `Editor` subclass. `DataBlock` and
     `SceneObjectData` already had this path; editors were the gap.
   - [x] **The host stopped importing its own barrel.** Adding the editor's
     three hub exports (`editor_base`, `velpan`, `image`) pushed `no-circular`
     over budget, which surfaced the real defect: `MainMenu.js` and
     `MaterialEditor.ts` imported `@framework/api`, and those two edges closed
     23 cycles through a module that re-exports most of `scripts/`. Both now
     import the defining module, and a new error-severity
     `host-no-framework-api` rule keeps them there. `no-circular` 399 → 373.
4. Re-register the tool paths from `archive/uv-editor/TODO.md` under `uveditor.*`,
   with the same names, taking a datapath. Users have keymaps and
   `saveLastValue()` state keyed on these paths; a rename is gratuitous churn.
   `image.set_type` (`SetImageTypeOp`) is on that list and is not UV — restore
   it too rather than losing it silently.
   - [x] **All ten `uveditor.*` ops**, in `addons/builtin/uv_editor/src/uv_ops.ts`
     over the step-3 core. Paths, hotkeys and `saveLastValue()` inputs are the
     archive's byte for byte; only input *names* that spelled a BREP concept
     changed (`meshPath` → `dataPath`, `loopEid(s)` → `element(s)`), because
     nothing persists those, and the old vertex/edge/face `selectMask` is gone
     because a UV element has one domain. Undo is a snapshot rather than a
     memfile: scope-wide flags for the selection ops, and the coordinates of
     exactly the handles a transform moved. A modal drag re-`exec`s from the
     gathered start each move, so it accumulates no drift and lands as one undo
     step, and the gathered arrays are dropped at `execPost` so they never ride
     the undo stack.
   - [x] **The editor invokes them** — `uv_editor_area.ts` gained the archived
     keymap verbatim (A / L / shift-L / G / S / R / P / alt-P) and click-select,
     which sends the whole coincident stack under the cursor through
     `uveditor.select_one` so a welded corner selects as one point. The ops and
     the area never import each other: the op layer reaches the editor through
     a structural `IUVEditorView`.
   - [x] **`image.set_type`** — `scripts/image/image_type_ops.ts`, the archive's
     `ImageBlockOp` + its one subclass collapsed into a single class. Registered
     from `entry_point.js` rather than from `data_api/api_define.ts`: that hub
     is inside the host's cycle knot, and routing a side-effect-only ToolOp
     registration through it costs three cycles for nothing.
   - [x] **The paths are proven registered, not assumed** —
     `tests/integration/uv_editor_ops.test.ts` boots the app headlessly and
     resolves all eleven through `CTX.api.getToolDef`, which is the only honest
     check when the ops ship in an external addon.
5. Subscribe the editor to `ImageBus`; convert `image_ops.js:119`; delete
   `window.redraw_uveditors` and its `declare global`. **Done.**
   - [x] **Both editors register as `ImageBus` emitters** while they are the
     visible area (`on_area_active` / `on_area_inactive`, as the archive did),
     so a trigger reaches exactly the editors a user can see and nobody holds a
     list of editor types. `onTrigger` deregisters an emitter that outlived its
     DOM: a screen torn down whole — a file load — never fires
     `on_area_inactive`.
   - [x] **`image.open` sends the trigger** — `bus.sendTrigger(ImageBus,
     'flagRedraw')` at `scripts/image/image_ops.js:121`, the global's only
     caller. `ImageOp.getImage`'s one-argument `ctx.api.getValue(path)` was
     wrong in the same file and is fixed with it.
   - [x] **`resetDrawLines` / `addDrawLine` are recorded as dropped**, not kept
     as an unserved surface: `ImageBus` now declares only `flagRedraw`, with a
     comment saying the other two return with the overlay P19 ports. A trigger
     no emitter handles is silently swallowed, so declaring one is worse than
     not having it.
   - [x] `tests/unit/image_bus.test.ts` pins the trigger's spelling — the one
     string the sender and both editors must agree on — and the registration
     lifecycle, including that a second `on_area_active` does not
     double-deliver.
6. Give `selectedFacesOnly` a real home. `mesh_uvops_base.ts` and its hardcoded
   default are already gone (P13), so this is: pass the flag through the op's
   inputs into `listUVFaces`, and make §6's false-differs-from-true test real.
   **Done.**
   - [x] The path already ran end to end after step 3 — `UVOpBase`'s
     `selectedFacesOnly` input → `_scope()` → `UVScope` → `readUVRings` →
     `listUVFaces(layer, selectedOnly)` — so step 6 was entirely about proving
     it, which is what the archived hardcoded `true` made impossible.
   - [x] `tests/unit/uv_editor/uv_edit_geom.test.ts` covers a *partial* scope
     against the double: select-all, auto's read of "is anything selected
     here", a scoped flag snapshot restoring only its own faces, and a
     transform gathering only in-scope elements. Auto is the one that would
     rot silently — it has to ignore a selection outside the scope.
   - [x] `tests/integration/uv_editor_scope.test.ts` proves the *input*
     arrives: one headless boot on `litemesh-attrtest`, running
     `uveditor.toggle_select_all` through `ctx.api.execTool(ctx, path, inputs)`
     with the flag both ways. On the six-quad cube: 0 of 24 UV elements
     selected scoped with no face selected, 24 unscoped, 24 scoped once
     `litemesh.select_all` has run.
   - [x] No default is hardcoded anywhere: the property's own default is
     `false`, and `UVOpBase.invoke` copies the editor toggle in only when the
     caller passed no `selectedFacesOnly` at all.
7. **Done.** `archive/uv-editor/` and its `archive/README.md` row are gone; the
   README keeps a paragraph pointing here instead. The directory's own
   `TODO.md` *was* the port checklist, so its disposition is recorded here
   rather than deleted with it:

   | Its checklist row | Where it landed |
   | --- | --- |
   | Design the UV-editing abstraction layer | `IUVSource` in `scripts/core/geometry_contract.ts`, reached through `uvSourceFor` (steps 1–2) |
   | Decide where the select / transform / flag ToolOps live | their own `uv_editor` addon, not the mesh addon (step 3) |
   | Re-introduce `selectedFacesOnly` and restore its binding | an op input with the editor toggle behind it (step 6). `mesh_uvops_base.ts`, the file the row names, was deleted by P13 |
   | Replace the `window.redraw_uveditors` global | `ImageBus.flagRedraw` (step 5) |
   | Port `SetImageTypeOp` (`image.set_type`) | `scripts/image/image_type_ops.ts`, registered from `scripts/entry_point.js` — image-type conversion, not UV, exactly as the row guessed |
   | Bump relative import depth when a file comes back out | dropped: nothing came back out. The editor was rewritten against the interface (§3), so no file kept its old imports |
   | Delete the directory | this step |

   All ten `uveditor.*` tool paths it listed are registered again under their
   original names; `uv_editor_ops.test.ts` holds the list and boots the app to
   resolve each one. `DrawLine` is the one behaviour deliberately not carried
   over — P13 archived the unwrapper that drew the lines, so it comes back
   with P19.

`unwrap` and `pinUVs` are optional on the interface. `unwrap` is only
implementable once P19 lands the solver; declare it here, leave it unimplemented,
and let the editor feature-detect. That keeps P19 a pure port with no interface
design left in it.

## 6. Tests

- **Criterion 11**: the UV editor operates on LiteMesh and LeafMesh with no
  geometry-type name in the editor's sources. Grep is the check —
  `grep -rn "LiteMesh\|LeafMesh\|\bMesh\b" addons/builtin/uv_editor/src/` returns
  nothing.
- The test double drives the whole editor headlessly: select, transform, write,
  read back. This suite must pass in a `--no-sculptcore` build, which means it
  cannot touch LiteMesh.
- Every tool path the archived `TODO.md` listed is registered and invocable.
  The list outlived the file: it is in `uv_editor_ops.test.ts` and in §5 step 7.
- Every implementor passes `tests/lib/uv_source_conformance.ts`. A case there
  may only use the contract: one that has to know which source it is driving
  means the contract is under-specified, and the fix belongs in
  `geometry_contract.ts`.
- Round-trip: unwrap-free UV edits on a `.wproj` save and reload with selection
  and pin state intact.
- `selectedFacesOnly` false actually differs from true — the current hardcoded
  path makes that untestable, so it is a real regression test. Landed in step 6
  at both levels: `uv_edit_geom.test.ts` for a partial scope against the double,
  `uv_editor_scope.test.ts` for the op input on a real mesh.

## 7. Risks

- **The interface is shaped by whichever implementor is written first.**
  Mitigation: §5 step 2 — three implementors in one PR, test double included.
- **The old editor's behaviours are lost by omission.** Mitigation: `TODO.md`'s
  table is the checklist, and `pending-port/` is not deleted until every row is
  implemented or recorded as dropped. Settled in step 7: every row is
  dispositioned in the table there, in the commit that deleted the directory.
- **`findnearestUV` is rebuilt per-element** and is slow on a real mesh.
  Mitigation: bulk handles (constraint 1) plus the same "no per-element JS
  objects" rule; if picking needs acceleration, it belongs behind an optional
  capability on the source, not in the editor.
- **`selectedFacesOnly` restoration changes behaviour** for anyone relying on
  the hardcoded `true`. It is a placeholder with a comment saying it is a
  placeholder; restoring it is the fix. Note it in the release notes. Settled in
  step 6: the default is `false`, so an op invoked with no editor and no
  argument now reads the whole layer where the archive read the selection.
- **`ImageBus` had neither subscribers nor callers** — P13 archived the
  unwrapping stack that pushed seam draw-lines, so all three triggers were dead
  code, not merely unheard. Settled in step 5: `flagRedraw` got a caller and two
  handlers, and the two draw-line triggers were deleted rather than left
  declared. P19 re-adds them with the overlay that needs them.

## 8. Exit criteria

- Criterion 11: `IUVSource` exists, is implemented by LiteMesh, LeafMesh and a
  test double, and the UV editor addon names no concrete geometry type.
- The headless test-double suite passes in a `--no-sculptcore` build.
- Every `uveditor.*` tool path from the archived `TODO.md` (§5 step 7) is
  registered again, under its original name, taking a datapath.
- `window.redraw_uveditors` is gone; the editor subscribes to `ImageBus`.
- `selectedFacesOnly` reaches the source as an argument, with no default
  hardcoded anywhere.
- `archive/uv-editor/` and its `archive/README.md` row are deleted.
