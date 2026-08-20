# P19 — W4b: port the unwrapping stack onto `IUVSource`

**Status:** done — §5 is closed and §8 is met or recorded as a deliberate drop.
The angle solver, the relaxer, the packer and the randomizer run on both real
`IUVSource` implementors and on a source that is not a mesh at all, from ops the
UV editor registers; `archive/unwrapping/` is deleted. Three capabilities were
dropped rather than ported — voxel unwrap (§3.4), the paramizer and its
`ParamVert` settings (§3.2), and `fixSeams` (§6) — each a decision with a
recorded outcome, carried into `ImmediateTODOs.md`.

Three of this document's own claims were wrong when it was written, and are
corrected in place below (marked *2026-08-19*): `IUVSource` has no `unwrap`
member and never had one, `UVWrangler`'s internal representation was **not**
already index-based, and no numerical reference was ever captured from the
pre-delete code. §9 lists what landed.

**Date:** 2026-08-15 (outcome recorded 2026-08-19)

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

**Outcome (2026-08-19).** §3.1 held: the element imports were the bulk of the
diff. §3.2 went to (a). §3.3 became moot — the paramizer was dropped, and it was
the only consumer of the cotangent helpers and of `DispLayerVert`. §3.4 dropped
voxel unwrap. §3.5 works and is asserted through `ImageBus` in the integration
suite.

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

*2026-08-19:* (a), and `ParamVert` did not have to be decided — the paramizer
went with voxel unwrap. `UVVert` in `uv_wrangler.ts` is a plain object holding a
`Vector2` and an int flag; the graph is rebuilt per op and written back at the
end, so nothing scratch outlives a `ToolOp.exec`.

**3.3 `mesh_paramizer.ts`'s other BREP dependencies.**
`:9` imports `buildCotanVerts`, `getCotanData`, `VAREA`, `VCTAN1`, `VCTAN2`,
`VW`, `VETOT`, `vertexSmooth` from `mesh_utils`; `:11` imports `DispLayerVert`
from `mesh_displacement.ts` — a file P13 deleted. The cotangent machinery is
generic mesh math and should be ported alongside (it is small and this is its
only consumer left); the `DispLayerVert` import needs to be traced and almost
certainly dropped.

*2026-08-19:* moot. `mesh_paramizer.ts` was not ported, so nothing imports
`buildCotanVerts`, `getCotanData` or `DispLayerVert`, and the cotangent helpers
stayed deleted.

**3.4 `VoxelBVH extends BVH`** (`unwrapping.ts:1317`), from the mesh addon's
`./bvh.js`. Voxel unwrap needs a spatial structure over triangles. P7 declined
to expose a BVH on the geometry contract deliberately (`closestElements` instead).
Either port the BVH as a standalone triangle-soup structure inside this addon —
it only needs positions and indices, which `IUVSource`'s host source can supply
— or drop voxel unwrap and record it as a gap. Decide by reading `VoxelBVH`;
do not add `getBVH()` back to the contract for one consumer.

*2026-08-19:* dropped, and recorded in `ImmediateTODOs.md`. Voxel unwrap was one
entry point on top of ~700 lines of octree that exist to answer "which triangle
is nearest this cell centre" — a question `IUVSource` deliberately does not ask,
and one the angle solver never asks either. Porting it would have meant carrying
a spatial structure into the UV editor for a single tool that the ported stack
does not need to be complete.

**3.5 `ImageBus` draw-lines.** `unwrapping.ts:1030-1035` sends `resetDrawLines`
/ `addDrawLine` / `flagRedraw`. P18 re-subscribed the editor, so these become
live again for the first time since the slim-down. Verify they render something
sensible rather than assuming they still work.

*2026-08-19:* live. The packer takes an optional `drawLine` callback rather than
touching a bus itself, so it stays testable off-screen; `UVLayoutOpBase._bins`
is what turns that into `ImageBus` traffic, and it clears the old rectangles
whether or not new ones were asked for. `uv_editor_area.ts` draws them over the
UV view. Asserted end to end in `tests/integration/uv_unwrap_parity.test.ts`.

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

*2026-08-19 — two corrections, and the strategy still held.*

`UVWrangler`'s representation was **not** already index-based: `UVWrangler.uvw`
kept `Loop` objects in `CVElem` layers and reached mesh elements straight out of
the solver. So the port was not a constructor rewrite with the rest untouched —
`uv_wrangler.ts` is a new `UVGraph` of `UVVert` / `UVEdge` / `UVFace` /
`UVIsland` whose only handles are integers from `IUVSource`, and the solver was
rewritten against *that* rather than against `UVWrangler`. The prediction that
the difficulty lives in the builder and not the math was still right, which is
why this cost days and not weeks.

There is also no `unwrap` member on `IUVSource`, in P18 or now. What P18 left
optional was `getUVElementPositions` (`400ae6fd`), and that is the only bulk
read this plan needed to add — the topology reads (`getUVFans`, `listUVFaces`,
`getUVFaceRings`) were already there. Unwrapping is an *op* over a source, not a
method on one: a source that cannot be unwrapped is one whose
`getUVElementPositions` is absent, which the ops feature-detect. Keeping it that
way is what let the solvers be tested against a grid that is not a mesh.

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

**Outcome (2026-08-19).** Steps 1-3 landed as written, inside `uv_editor`.
Step 4 did not happen and did not need to (§3.3). Step 5 dropped voxel unwrap
(§3.4). Step 6's forced rename happened, under `uveditor.*` rather than `uv.*` —
P18 had already claimed that namespace for the editor's own ops, and a second
prefix for one editor buys nothing. Step 7 is not a thing that exists to do
(§4). Step 8 is done.

What the plan had no step for, and needed one for, is running the ported stack
against *both* implementors from one place. The solvers live in the
UV editor addon, the sources live in the geometry addons, and an addon may not
import a peer — so `scripts/core/uv_source_fixtures.ts` holds a registry of
named factories on the host side, each geometry addon registers what it can
build, and the check asks by name. `leafmesh-mirror` is the fixture that makes
parity mean something: it rebuilds LiteMesh's cube through `IUVSource` reads
alone, so the two providers are handed genuinely the same topology rather than
two cubes that merely look alike.

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

**Outcome (2026-08-19).** Everything above is covered except two rows.

The **numerical reference was never captured** — the window §7 warned about
closed when P13 landed, and re-animating the archived copy would have meant
resurrecting the BREP `Mesh` it reads. So the regression bar is properties
rather than a golden file: that the angle error of a curved chart falls as the
solver steps, that a planar chart stays flat, that a seed reproduces a layout
exactly, that pins hold, that islands land inside the unit square, and that two
independent providers given one topology agree to 1e-4. A golden file would have
pinned the arithmetic harder; a property suite survives a legitimate change to
the solver, which over a port is the more useful trade.

**`fixSeams` was dropped.** It edited the BREP mesh's seam flags from inside the
solver — a source-mutating side effect the contract has no room for, since
`IUVSource` writes UVs and flags and nothing else. Recorded in
`ImmediateTODOs.md`; if it comes back it belongs in a seam op, not in unwrap.

The suites: `tests/unit/uv_editor/uv_solve.test.ts` (14 cases) drives the
solvers against `UVGridSurface`, a grid of quads with no mesh and no engine
behind it, which is the whole claim the port makes; and
`tests/integration/uv_unwrap_parity.test.ts` (14 per backend) runs the same
stack through the real providers and through the ops, in one headless boot.

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

**Outcome (2026-08-19).** Risk 1 half-fired: the representation was rebuilt, not
preserved (§4), so the diff did spread into the solver — but the math came
across unchanged, which is the part the risk was really about. Risk 2 fired
outright (§6). Risks 3 and 5 were dissolved by dropping the paramizer and voxel
unwrap. Risk 4 did not fire: the interface gained nothing at all here.

## 8. Exit criteria

- ✅ Unwrap, relax and pack run on both `IUVSource` implementors from the UV
  editor.
- ✅ Unwrap works in a build without sculptcore, on LeafMesh. Two of the four
  parity fixtures never touch sculptcore, and the solver suite runs on a source
  that is not a mesh at all.
- ⛔ The numerical regression test passes against a reference captured from the
  pre-port implementation. **Not met, and cannot be** — no reference was
  captured before P13 landed. Replaced by the property suite in §6.
- ✅ `CVElem`, `ParamVert` and every `{Edge, Face, Loop, Mesh, Vertex}` import
  are gone from the ported files.
- ✅ `archive/unwrapping/` is deleted.
- ✅ Any dropped capability (voxel unwrap, `ParamVert` settings, `fixSeams`) is
  recorded in the release notes and in `ImmediateTODOs.md`, not just here.

## 9. What landed

New, in `addons/builtin/uv_editor/src/`:

| File | Contents |
| --- | --- |
| `uv_wrangler.ts` | `UVGraph` and `buildUVGraph(source, layer, scope)` — the welded UV mesh, built out of integer handles |
| `uv_solve.ts` | `SolveTri`, `UVSolver`, `relaxUVGraph`, `packUVIslands`, `randomizeUVGraph`, and the seeded `Rng` that replaced `Math.random()` |
| `uv_unwrap_support.ts` | the in-app driver the integration suite calls, over `globalThis.__uvUnwrapAll` |

Also: `resetUVs` / `gridUVs` in `uv_edit_geom.ts`; six ops in `uv_ops.ts`
(`uveditor.{unwrap,relax,pack_islands,randomize_uvs,reset_uvs,grid_uvs}`) with a
`UV` menu and `U` / `ctrl-P` hotkeys in `uv_editor_area.ts`, which also draws the
packer's bins; `resetDrawLines` / `addDrawLine` back on `ImageBus`, which P18
deleted rather than leave declared with no sender;
`scripts/core/uv_source_fixtures.ts` and its `@framework/api`
re-export; fixtures registered by both geometry addons; a `UVGridSurface` with
3D positions in `tests/lib/uv_grid_source.ts`; and `tests/lib/pathux_shim.ts`,
so a jest suite reaches the real path.ux solver without the widget barrel.

Three behaviours deliberately differ from the archive:

- **`steps` replaced the 400 ms budget.** `UnWrapSolver` ran until a wall-clock
  deadline. A `ToolOp` has to replay identically on redo, and a machine that is
  busy would otherwise redo a different unwrap than it did the first time.
- **The RNG is seeded and per-call.** The packer and the randomizer took
  `Math.random()`; both now take a `seed` input that defaults to 0, which is
  what makes "the same seed packs the same way twice" a test rather than a hope.
- **`step()` does not write UVs back.** Writing happens in `finish()`, or in
  `graph.write()` for a caller that wants to watch the solve run. An op that
  ran 25 steps used to mean 25 round trips through the source's bulk writer.
