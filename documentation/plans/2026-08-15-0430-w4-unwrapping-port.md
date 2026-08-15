# P19 — W4b: port the unwrapping stack onto `IUVSource`

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W4, §5 phase 12, §6 (the rescue), §9.3 P19.

**Workstream / phase:** W4 / phase 12.

**Depends on:** P18 (`IUVSource` exists and is implemented three times),
P13 (the stack is in `archive/`, rescued in its own commit).

**Authoring effort:** high.

---

## 1. Goal

Bring the rescued unwrapping code back as a working feature, reading geometry
through `IUVSource` instead of through BREP element objects.

## 2. What was rescued

P13 `git mv`'d these to `archive/unwrapping/` in a commit that landed *before*
the BREP delete:

| File | Lines | Contents |
| --- | --- | --- |
| `unwrapping.ts` | 1,597 | `UVWrangler` (the UV-mesh builder, `:129`), `UVIsland` (`:94`), `CVElem` (`:18`), `VoxelNode` / `VoxelBVH` (`:1242`, `:1317`) |
| `unwrapping_solve.ts` | 1,476 | `UnWrapSolver` (`:161`), `SolveTri` (`:135`), `relaxUVs` (`:12`), `fixSeams` (`:1389`) |
| `mesh_paramizer.ts` | 1,628 | `ParamVert` (`:167`), `paramizeShell` (`:1532`), `paramizeMesh` (`:1565`), `calcGeoDist` (`:597`), `geodesic_distance_triangle` (`:49`) |
| | **4,701** | |

If `archive/unwrapping/` does not contain all three, stop — P13's rescue commit
did not happen and the code is in the reflog, not the tree.

## 3. The work is the element-access seam, not the math

The algorithms are self-contained: ABF/LSCM-style solving, cotangent weights,
geodesic distance, island packing. None of it cares what a mesh is. Every line
that *does* care is an element access, and they cluster in four places.

**3.1 BREP element imports.** All three files import
`{Edge, Face, Loop, Mesh, Vertex}` from `./mesh` and iterate them directly.
This is the bulk of the diff and it is mechanical once §4 is settled.

**3.2 `CustomDataElem` subclassing — the Class E edge.** `CVElem`
(`unwrapping.ts:18`) and `ParamVert` (`mesh_paramizer.ts:167`) both
`extends CustomDataElem`, the BREP attribute-layer base, and `ParamVertSettings`
extends `LayerSettingsBase`. That class dies with P13. These are per-vertex
scratch layers with nstructjs structs on them, so this is not a rename — decide
whether the ported code:

- (a) keeps scratch state in plain typed arrays sized to the UV-element count
  (recommended — it is scratch, it does not need to persist or interpolate), or
- (b) needs a real attribute layer, in which case it goes through the source's
  attribute API and `IUVSource` gains a capability for it.

Prefer (a). `ParamVert` is the harder case because it carries settings and is
registered with the data API; check whether anything actually reads those
settings from the UI before preserving them.

**3.3 `mesh_paramizer.ts`'s other BREP dependencies.**
`:9` imports `buildCotanVerts`, `getCotanData`, `VAREA`, `VCTAN1`, `VCTAN2`,
`VW`, `VETOT`, `vertexSmooth` from `mesh_utils`; `:11` imports `DispLayerVert`
from `mesh_displacement.ts` — a file P13 deleted. The cotangent machinery is
generic mesh math and should be ported alongside (it is small and this is its
only consumer left); the `DispLayerVert` import needs to be traced and almost
certainly dropped.

**3.4 `VoxelBVH extends BVH`** (`unwrapping.ts:1317`), from the mesh addon's
`./bvh.js`. Voxel unwrap needs a spatial structure over triangles. P7 declined
to expose a BVH on the geometry contract deliberately (`closestElements` instead).
Either port the BVH as a standalone triangle-soup structure inside this addon —
it only needs positions and indices, which `IUVSource`'s host source can supply
— or drop voxel unwrap and record it as a gap. Decide by reading `VoxelBVH`;
do not add `getBVH()` back to the contract for one consumer.

**3.5 `ImageBus` draw-lines.** `unwrapping.ts:1030-1035` sends `resetDrawLines`
/ `addDrawLine` / `flagRedraw`. P18 re-subscribed the editor, so these become
live again for the first time since the slim-down. Verify they render something
sensible rather than assuming they still work.

## 4. Settle the addressing model first

The port is mechanical *after* one decision: what `UVWrangler` builds its UV
mesh out of.

`UVWrangler` already is the seam — it exists precisely to turn loops-with-UVs
into a welded UV-space mesh with islands. Rewrite **its input** to be
`IUVSource` bulk reads (positions, face/corner topology, UV array, pin flags,
selection) and everything downstream of it keeps working on `UVWrangler`'s own
internal representation, which is already index-based.

That is the whole strategy: **port `UVWrangler`'s constructor, not the solvers.**
Budget the effort accordingly — expect most of the difficulty in
`unwrapping.ts:129`'s class and comparatively little in the 1,476-line solver.

`IUVSource` may need bulk reads the interface does not have (3D positions,
face-corner topology). That is expected — P18 declared `unwrap` optional
precisely so this plan could finish the interface. Add what is needed, and add
it to the test double too, or the double stops being a valid implementor.

## 5. Plan

1. Land the ported code in the UV editor addon (or a peer `unwrap` addon —
   prefer inside `uv_editor`, since it is the only consumer and a separate addon
   buys nothing). Excluded from `archive/`'s build exclusions from this point.
2. Port `UVWrangler`'s input side to `IUVSource` (§4). Nothing else changes yet.
3. Replace `CVElem` / `ParamVert` per §3.2's decision.
4. Port the cotangent helpers out of `mesh_utils`; trace and drop
   `DispLayerVert`.
5. Decide `VoxelBVH` (§3.4) and implement or drop.
6. Re-register the ToolOps that had UI but no implementation after P13:
   `mesh.unwrap_solve`, `mesh.relax_uvs`, `mesh.voxel_unwrap`, `mesh.pack_uvs`
   and the rest. They were mesh-addon paths, so they need new names —
   `uv.unwrap_solve` etc. — since the `mesh.` namespace is gone. That is a
   forced rename, unlike P18's; record it and add keymap entries.
7. Wire `unwrap` on `IUVSource` for both real implementors.
8. Delete `archive/unwrapping/` and its `archive/README.md` entry.

## 6. Tests

- Unwrap a LiteMesh and a LeafMesh, both from the same UI action, and assert the
  results are equivalent for the same input topology. Two implementors giving
  different answers means geometry-specific behaviour leaked in.
- **Unwrap runs in a `--no-sculptcore` build**, on LeafMesh. This is the exit
  condition that makes the port worth doing.
- Numerical regression: an unwrap of a fixture mesh matches a committed
  reference within tolerance. The pre-port code can generate that reference —
  do it **before** P13's delete lands if at all possible, otherwise from the
  archived copy.
- Relax, pack and pin round-trip.
- Seam handling: `fixSeams` (`unwrapping_solve.ts:1389`) against LeafMesh's seam
  attribute.
- Draw-lines appear in the editor during solve (§3.5).

## 7. Risks

- **The port turns into a rewrite.** Mitigation: §4 — the seam is
  `UVWrangler`'s constructor. If the diff is spreading into the solver, stop and
  re-check that `UVWrangler`'s internal representation was preserved.
- **No reference output exists** to check the port against, so "it produces
  *some* UVs" becomes the acceptance bar. Mitigation: capture the reference from
  the working pre-delete code, early.
- **`ParamVert`'s settings were user-facing** and dropping them is a silent
  feature loss. Mitigation: §3.2 — check the data API for readers before
  deciding.
- **`IUVSource` grows a large bulk-read surface** to serve one consumer, and
  becomes a geometry interface by the back door. Mitigation: whatever is added
  must be implementable by P18's test double in a few lines; if it cannot be,
  it is too geometry-specific.
- **Voxel unwrap quietly disappears.** Mitigation: §3.4 is a decision with a
  recorded outcome, not an omission.

## 8. Exit criteria

- Unwrap, relax and pack run on both `IUVSource` implementors from the UV
  editor.
- Unwrap works in a build without sculptcore, on LeafMesh.
- The numerical regression test passes against a reference captured from the
  pre-port implementation.
- `CVElem`, `ParamVert` and every `{Edge, Face, Loop, Mesh, Vertex}` import are
  gone from the ported files.
- `archive/unwrapping/` is deleted.
- Any dropped capability (voxel unwrap, `ParamVert` settings) is recorded in the
  release notes and in `ImmediateTODOs.md`, not just in this document.
