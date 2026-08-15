# P18 — W4a: `IUVSource` + the mesh-agnostic UV editor

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W4, §5 phase 12, §9.3 P18.
**Reference:** `scripts/editors/image/pending-port/TODO.md` — the slim-down
author's own port checklist. Read it in full before starting; it is more
accurate than this plan about what the old editor did.

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
UV half was moved, unwired, to `scripts/editors/image/pending-port/`:

| File | Lines | What it held |
| --- | --- | --- |
| `pending-port/ImageEditor.ts` | 1,791 | the old editor **plus** the `UVEditor` UIBase component, `findnearestUV`, `DrawLine`, `ImageBlockOp` / `SetImageTypeOp`, the UV sidebar, and `window.redraw_uveditors` |
| `pending-port/uv_selectops.js` | 335 | `uveditor.toggle_select_all`, `pick_select_linked`, `select_one` |
| `pending-port/uv_transformops.js` | 550 | `uveditor.translate` / `scale` / `rotate`, modal, reading the mouse off `ctx.editors.imageEditor.uvEditor` |
| `pending-port/uv_ops.js` | 331 | `uveditor.project_uvs`, `set_flag` / `clear_flag` / `toggle_flag` (`UVFlags.PIN`) |
| | **3,007** | |

Live remnants:

- `scripts/editors/image/ImageEditor.ts` — 552 lines, the minimal editor.
  `:534-552` declares and defines `window.redraw_uveditors`, called from
  `scripts/image/image_ops.js:119` and (in `pending-port`) from four UV op
  sites.
- `scripts/editors/image/ImageBus.ts` — 9 lines, triggers `resetDrawLines`,
  `flagRedraw`, `addDrawLine`. Deliberately left in place; still imported by
  `addons/builtin/mesh/src/unwrapping.ts` to push seam draw-lines, and
  re-exported from `@framework/api`. **The minimal editor does not subscribe**,
  so those triggers are live no-ops today.
- `addons/builtin/mesh/src/mesh_uvops_base.ts` — 171 lines. `:37-43` and
  `:135-138`: because the editor's per-editor preference is gone, the op
  **hardcodes `selectedFacesOnly = true`** whenever the caller does not pass it,
  with a comment saying so. `:55-70` and `mesh_uvops.ts:536` read it.
- The tool paths listed in `pending-port/TODO.md` are unregistered and throw
  "unknown tool" if invoked.

Data-path change to carry through the port: the old editor nested everything
under a `uvEditor` sub-component (`imageEditor.uvEditor.imageUser.image`); the
new one owns the `ImageUser` directly (`imageEditor.imageUser.image`).
`pending-port/TODO.md` lists the consumers that were updated — those are exactly
the sites a naive port would break again.

## 3. Do not port the old code back

3,007 lines written against `Mesh`, `Loop`, `MeshFlags`, `mesh.faces.selected.editable`.
Porting it means porting the BREP element model with it, which is the opposite
of this workstream.

Use it as a **specification**: it is the record of what UV editing in this app
actually did, including the pieces nobody would think to re-specify (pinning,
`select_linked`, draw-lines, projection). Read it, list the behaviours, then
implement them against the interface. `pending-port/` is deleted at the end of
this plan.

## 4. `IUVSource`

From strategy §4 W4:

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

### 4.1 Open questions to settle while writing the interface

- **What is a UV element?** The signatures index by `Int32Array`, so the
  addressing domain has to be named. LeafMesh's Corner domain and LiteMesh's
  loop domain both work; say which, and say what `readUVs`' `out` layout is
  (tightly packed `[u, v]` per index).
- **`selectedFacesOnly`.** Restore it as a real binding on the editor, since
  the hardcoded `true` at `mesh_uvops_base.ts:37-43` is an acknowledged
  placeholder. It is a *filter on the source*, not editor state — express it in
  the op's inputs and resolve it against the source's face selection.
- **Layer identity.** `UVLayerDesc` needs a stable name, since files persist a
  layer choice. Index alone is not stable across attribute-layer edits.

## 5. Plan

1. Declare `IUVSource` + `UVLayerDesc` + `UnwrapOptions` in the host, and
   register implementations through the P7 `AddonAPI` (same pattern as
   `ITransDataType`). Nothing else in this step.
2. **Implement it three times, in the same PR** — this is the point of the
   plan. LiteMesh, LeafMesh, and an in-memory test double (a fixed grid of UVs
   with no geometry behind it). The double is what makes the editor testable
   headlessly and is the honest check that the interface is not
   LiteMesh-in-disguise. If any implementor needs an interface change, the
   interface is wrong — change it, do not special-case.
3. Reimplement the editor as an addon (`addons/builtin/uv_editor/`), consuming
   `IUVSource` only. Draw, pick (`findnearestUV`'s replacement, reading through
   bulk handles), select, pin, transform.
4. Re-register the tool paths from `pending-port/TODO.md` under `uveditor.*`,
   with the same names, taking a datapath. Users have keymaps and
   `saveLastValue()` state keyed on these paths; a rename is gratuitous churn.
   `image.set_type` (`SetImageTypeOp`) is on that list and is not UV — restore
   it too rather than losing it silently.
5. Subscribe the editor to `ImageBus`; convert `image_ops.js:119`; delete
   `window.redraw_uveditors` and its `declare global`.
6. Rewrite `mesh_uvops_base.ts`'s successor against the interface, restoring
   `selectedFacesOnly` as a real binding, and drop the hardcoded default.
7. Delete `scripts/editors/image/pending-port/` in the final commit, once every
   behaviour in its TODO table is either implemented or explicitly recorded as
   dropped.

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
- Every tool path in `pending-port/TODO.md` is registered and invocable.
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
- **`ImageBus` has no subscribers today**, so its triggers have been silently
  dropped for however long. Verify each of the three actually does something
  once subscribed rather than assuming they still fire.

## 8. Exit criteria

- Criterion 11: `IUVSource` exists, is implemented by LiteMesh, LeafMesh and a
  test double, and the UV editor addon names no concrete geometry type.
- The headless test-double suite passes in a `--no-sculptcore` build.
- Every `uveditor.*` tool path from `pending-port/TODO.md` is registered again,
  under its original name, taking a datapath.
- `window.redraw_uveditors` is gone; the editor subscribes to `ImageBus`.
- `selectedFacesOnly` is a real binding again and
  `mesh_uvops_base.ts`'s hardcoded default is gone.
- `scripts/editors/image/pending-port/` is deleted.
