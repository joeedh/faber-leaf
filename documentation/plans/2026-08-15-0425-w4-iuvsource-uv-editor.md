# P18 — W4a: `IUVSource` + the mesh-agnostic UV editor

**Status:** in progress — §5 step 1 closed, step 2 under way (LeafMesh and the
test double landed; LiteMesh open).

**Date:** 2026-08-15 (citations re-verified 2026-08-19)

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W4, §5 phase 12, §9.3 P18.
**Reference:** `archive/uv-editor/TODO.md` — the slim-down author's own port
checklist. Read it in full before starting; it is more accurate than this plan
about what the old editor did. Two of its statements have since gone stale: the
directory moved out of `scripts/editors/image/pending-port/` (P13, `8d4ee0c4`),
and `ImageBus` no longer has the live importer it names — see §2.

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
there from `scripts/editors/image/pending-port/`; see `archive/README.md`):

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
  `flagRedraw`, `addDrawLine`. Deliberately left in place and re-exported from
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
implement them against the interface. `archive/uv-editor/` is deleted at the end
of this plan, along with its row in `archive/README.md`.

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
     with vertex owners and no geometry object. `tests/lib/uv_source_conformance.ts`
     is the shared suite every implementor is run through.
   - [ ] **LiteMesh** — needs new *bulk* bound methods on sculptcore's `Mesh`
     (face corner rings, corner→vert, and gather/scatter of a float attribute)
     because attribute values are paged behind `AttrData<T>` and reachable from
     TS only one element at a time. That is a C++ change plus a rebuild, hence a
     second commit; the interface was shaped against those constraints from the
     start (strictly bulk, CSR, no per-element accessor) so that writing
     LeafMesh first could not bias it.
3. Reimplement the editor as an addon (`addons/builtin/uv_editor/`), consuming
   `IUVSource` only. Draw, pick (`findnearestUV`'s replacement, reading through
   bulk handles), select, pin, transform.
4. Re-register the tool paths from `archive/uv-editor/TODO.md` under `uveditor.*`,
   with the same names, taking a datapath. Users have keymaps and
   `saveLastValue()` state keyed on these paths; a rename is gratuitous churn.
   `image.set_type` (`SetImageTypeOp`) is on that list and is not UV — restore
   it too rather than losing it silently.
5. Subscribe the editor to `ImageBus`; convert `image_ops.js:119`; delete
   `window.redraw_uveditors` and its `declare global`.
6. Give `selectedFacesOnly` a real home. `mesh_uvops_base.ts` and its hardcoded
   default are already gone (P13), so this is: pass the flag through the op's
   inputs into `listUVFaces`, and make §6's false-differs-from-true test real.
7. Delete `archive/uv-editor/` and its `archive/README.md` row in the final
   commit, once every behaviour in its TODO table is either implemented or
   explicitly recorded as dropped.

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
- Every tool path in `archive/uv-editor/TODO.md` is registered and invocable.
- Every implementor passes `tests/lib/uv_source_conformance.ts`. A case there
  may only use the contract: one that has to know which source it is driving
  means the contract is under-specified, and the fix belongs in
  `geometry_contract.ts`.
- Round-trip: unwrap-free UV edits on a `.wproj` save and reload with selection
  and pin state intact.
- `selectedFacesOnly` false actually differs from true — the current hardcoded
  path makes that untestable, so it is a real regression test.

## 7. Risks

- **The interface is shaped by whichever implementor is written first.**
  Mitigation: §5 step 2 — three implementors in one PR, test double included.
- **The old editor's behaviours are lost by omission.** Mitigation: `TODO.md`'s
  table is the checklist, and `pending-port/` is not deleted until every row is
  implemented or recorded as dropped.
- **`findnearestUV` is rebuilt per-element** and is slow on a real mesh.
  Mitigation: bulk handles (constraint 1) plus the same "no per-element JS
  objects" rule; if picking needs acceleration, it belongs behind an optional
  capability on the source, not in the editor.
- **`selectedFacesOnly` restoration changes behaviour** for anyone relying on
  the hardcoded `true`. It is a placeholder with a comment saying it is a
  placeholder; restoring it is the fix. Note it in the release notes.
- **`ImageBus` has neither subscribers nor callers today** — P13 archived the
  unwrapping stack that pushed seam draw-lines, so all three triggers are dead
  code, not merely unheard. Subscribing is half the work; each trigger needs a
  new caller or an explicit note that it is dropped.

## 8. Exit criteria

- Criterion 11: `IUVSource` exists, is implemented by LiteMesh, LeafMesh and a
  test double, and the UV editor addon names no concrete geometry type.
- The headless test-double suite passes in a `--no-sculptcore` build.
- Every `uveditor.*` tool path from `archive/uv-editor/TODO.md` is registered
  again, under its original name, taking a datapath.
- `window.redraw_uveditors` is gone; the editor subscribes to `ImageBus`.
- `selectedFacesOnly` reaches the source as an argument, with no default
  hardcoded anywhere.
- `archive/uv-editor/` and its `archive/README.md` row are deleted.
