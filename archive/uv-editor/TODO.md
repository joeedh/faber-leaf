# Image / UV editor — pending port

This directory holds the **legacy** image-editor implementation. It was moved
here wholesale when the image editor was slimmed down to a minimal
"load images into `ImageBlock`s + display the active image" editor (the
sculptcore cleanup pass). None of these files are imported, registered, or
bundled anymore — they are kept for reference while a new **UV-editing
abstraction layer** is designed in a follow-up plan.

> Because nothing imports them, the files here are outside the TypeScript
> module graph (`tsconfig.json` uses `files`, not a glob `include`), so they
> are **not** type-checked or bundled. Their now-stale relative imports
> (`../editor_base` → would need `../../editor_base`, etc.) are therefore
> harmless until the code is brought back. Fix the import depth (+1 `../`)
> when porting a file back out.

## What was here

| File                 | Lines | Responsibility                                                                                                                                                                                       |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ImageEditor.ts`     | ~1790 | The old `ImageEditor` **and** the `UVEditor` UIBase component, `findnearestUV` picking, `DrawLine`, `ImageBlockOp`/`SetImageTypeOp`, the UV-tools sidebar, and the `window.redraw_uveditors` global. |
| `uv_selectops.js`    | ~335  | UV select ToolOps: `uveditor.toggle_select_all`, `uveditor.pick_select_linked`, `uveditor.select_one` (`UVSelMask`, `SelectOpBaseUV`).                                                               |
| `uv_transformops.js` | ~550  | UV transform ToolOps: `uveditor.translate` / `scale` / `rotate` (modal, read mouse from `ctx.editors.imageEditor.uvEditor`).                                                                         |
| `uv_ops.js`          | ~331  | UV misc ToolOps: `uveditor.project_uvs`, `uveditor.set_flag` / `clear_flag` / `toggle_flag` (`UVFlags.PIN`).                                                                                         |

`ImageBus.ts` was **left at its original location** (`scripts/editors/image/ImageBus.ts`),
not moved here: it is a cross-cutting bus token (`resetDrawLines` / `flagRedraw`
/ `addDrawLine`) still imported by `addons/builtin/mesh/src/unwrapping.ts` (to
push UV seam draw-lines) and re-exported from `@framework/api`. The new minimal
editor does **not** subscribe to it, so those triggers are currently harmless
no-ops. The future UV editor should re-subscribe (old handler was
`ImageEditor.onTrigger`).

### Tool paths that USED to be registered (now gone)

These were registered as side effects of importing the old files. They are
**no longer registered** and will throw "unknown tool" if invoked until ported:

- `uveditor.toggle_select_all`, `uveditor.pick_select_linked`,
  `uveditor.select_one`
- `uveditor.translate`, `uveditor.scale`, `uveditor.rotate`
- `uveditor.project_uvs`, `uveditor.set_flag`, `uveditor.clear_flag`,
  `uveditor.toggle_flag`
- `image.set_type` (the `SetImageTypeOp` — image float/byte/generated type
  conversion; lived in the old `ImageEditor.ts`, not strictly UV)

The mesh-addon unwrap/relax/pack ToolOps (`mesh.unwrap_solve`,
`mesh.relax_uvs`, `mesh.voxel_unwrap`, `mesh.pack_uvs`, etc.) are **not** here —
they live in `addons/builtin/mesh/src/` and are still registered. They just no
longer have a UI surface in the image editor.

## Data-path / API changes made during the slim-down

The old editor nested everything under a `uvEditor` sub-component, so the
image lived at `imageEditor.uvEditor.imageUser.image`. The new editor owns the
`ImageUser` directly: **`imageEditor.imageUser.image`**.

Consumers updated to the new path (search for these when porting UV back):

- `scripts/core/context.ts` — `get activeTexture()` now reads
  `editor.imageUser.image` (was `editor.uvEditor.imageUser.image`).
- `scripts/image/image_ops.js` — `ImageOp.dataPath` default is now
  `imageEditor.imageUser` (was `imageEditor.uvEditor.imageUser`).
- `addons/builtin/mesh/src/mesh_uvops_base.ts` — `MeshOpBaseUV.invoke` and
  `UVOpBase.invoke` no longer read `editor.uvEditor.selectedFacesOnly`; they
  default `selectedFacesOnly` to `true`. **Restore a real binding here** when
  the new UV editor exposes a `selectedFacesOnly` preference.
- `window.redraw_uveditors` — still defined (in the new `ImageEditor.ts`) and
  still called by mesh UV ops + `image_ops.js`; it now just redraws open image
  editors. Keep it until the UV layer owns its own redraw signal.

## Port checklist (for the future UV-abstraction plan)

- [ ] Design the UV-editing abstraction layer (decouple "UV display/edit" from
      the `Mesh` addon so core does not depend on mesh element types — see the
      picking conventions in the root `CLAUDE.md` for the pattern to mirror).
- [ ] Decide where UV select/transform/flag ToolOps live (mesh addon vs. a new
      uv addon). They currently import directly from
      `addons/builtin/mesh/src/...` — route through `@addon/mesh/api` /
      `@framework/api` per the addon authoring guide.
- [ ] Re-introduce a `selectedFacesOnly` preference and restore the bindings in
      `mesh_uvops_base.ts`.
- [ ] Replace the `window.redraw_uveditors` global with a proper bus signal.
- [ ] Port `SetImageTypeOp` (`image.set_type`) — it is image-type conversion,
      not UV; it may belong in `scripts/image/image_ops.js` rather than the
      editor.
- [ ] When bringing a file back out of `pending-port/`, bump its relative
      import depth by one `../` (or convert to `@framework/api` /
      `@addon/<id>/api`).
- [ ] Delete this directory once everything is ported or intentionally dropped.

## Cross-layer note

The `TODO.md` at the repo root tracks cross-layer addon-import follow-ups. The
`mesh_uvops_base.ts` change above (mesh addon defaulting `selectedFacesOnly`
instead of reaching into the image editor) is the kind of coupling the new UV
abstraction should remove for good.
