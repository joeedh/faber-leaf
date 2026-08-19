# P12 — LeafMesh modeling toolmode

**Status:** in progress — see §11 for the plan of record and §12 for what has
landed.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§5 phase 8, §9.3 P12. **Design:**
[LeafMesh](./2026-08-15-0248-leafmesh-design.md) §7, §10.
**Reference:** [boxModelingTools.md](./boxModelingTools.md),
[boxModelingMode.md](../boxModelingMode.md).

**Workstream / phase:** decisions #2 and #8 / phase 8.

**Depends on:** P11. **Blocks:** P13 — this is on the critical path.

**Authoring effort:** high.

**Settles:** open decisions #2 (modeling without sculptcore) and #8 (does
`faber-leaf-core` model on day one). **Closes:** the second-implementor half of
success criterion 14.

---

## 1. Goal

Give the tree an authorable geometry type that does not need sculptcore, and
give P7's `ITransDataType` its second honest implementor.

## 2. Why it blocks the delete

P13 removes the tree's **only** authorable geometry type. LiteMesh is a sculpt
target, not a modeling target, and it requires sculptcore. If P13 lands first,
there is a window — of unknown length — in which the application cannot create
or edit a polygon mesh at all. That is not a refactor step, it is an outage.

So this lands first. That ordering is why decision #8 has to be answered
"**before P13 is scheduled**" rather than before P13 ships: it decides the phase
order, not just the content.

## 3. Open decisions

### 3.1 Decision #2 — modeling without sculptcore

**Yes.** LeafMesh + this toolmode is the answer, and it is what makes
`faber-leaf-core` a usable product rather than a viewer. The alternative — core
can view but not author — makes the embeddable distribution far less
interesting and pushes every embedder back to the full build.

### 3.2 Decision #8 — does `faber-leaf-core` model on day one?

**Yes**, at the scope in §4. Settle this *here*, in writing, before P17 freezes
what `faber-leaf-core` contains, and record it in the strategy doc's §9.4 table.

The risk of answering "no" is that `faber-leaf-core` ships as a strictly
lesser thing and the modeling toolmode never gets prioritized. The risk of
answering "yes" is scope: bounded by §4 and §5.

## 4. Scope

Mirror the existing box-modeling toolmode, but against LeafMesh where
faces-with-holes are first-class:

| Tool | Note |
| --- | --- |
| selection (vert/edge/face, box, circle, linked, similar) | on P6's host-owned `SelMask` and P11's claimed bit |
| extrude | region and individual |
| inset | must handle a face with holes — inset the outer ring, not each ring blindly |
| bevel | vertex and edge |
| split-off | |
| subdivide | per ring; a face whose every edge is selected quad-splits |
| loop-cut | stops at any face that is not a hole-free quad, and says where |

Plus the transform integration (§6).

**Explicitly out of scope**, and say so: knife, boolean, bridge, symmetrize,
remesh, UV tools (P18/P19). A modeling toolmode is an endless surface; this list
is the deliverable and additions are separate plans.

Modeling ops live **in the toolmode**, not in P3's `topo.ts` (design §7, §10).
`topo.ts` has the Euler surface and nothing more; if a tool needs a new
primitive operation, it is added to P3's module deliberately, with a test, one
at a time.

## 5. Where hole support actually shows up

This is the part that is genuinely different from the BREP toolmode and worth
designing rather than discovering:

- **Inset / extrude on a face with holes.** Insetting must offset the outer
  ring inward and the hole rings *outward* (both toward the face interior). A
  naive per-ring inset collapses holes.
- **Face deletion adjacent to a hole.** Deleting a face that shares an edge with
  a hole ring may merge the hole into the outer boundary. `joinFaces` needs to
  handle ring merging; make it a named, tested case.
- **Loop-cut across a hole.** A cut line that crosses a hole produces two
  separate cuts. Either handle it or refuse it explicitly — do not produce a
  face whose loop list is inconsistent.
- **Subdivide.** Each ring subdivides independently; the triangulation cache
  invalidates via `topoStamp`.

Every one of these gets a test with a hole-bearing fixture — P3's
cylinder-with-a-hole-in-its-cap primitive exists for this.

## 6. `ITransDataType` for LeafMesh

P7 documented the 13 methods; `MeshTransType` (745 lines) is implementor #1 and
leaves with P13. LeafMesh's implementation is implementor #2 and is what keeps
the interface honest once the BREP is gone.

Requirements:

- Registered through `api.registerTransType(...)` in the addon's `register(api)`
  hook — **never** at module scope (`litemesh_transtype.ts:202`'s pattern is the
  anti-example).
- Proportional edit needs `closestElements` (P7 §5.1). P11 declined spatial
  acceleration and answers by brute force. If proportional edit on a large
  LeafMesh is unusable, add a real acceleration structure to the LeafMesh
  addon — not a `getBVH()` reach-through, and not in the host.
- Snapping and per-element transform go through the same interface.
- `transform_ops.ts` must contain no LeafMesh literal. If it does, P7 is not
  finished.

## 7. Undo

Modeling ops are ToolOps and must be undoable. LeafMesh's indices are stable
under tombstoned deletion (P3), so undo can hold raw `int32` handles — but only
as long as nothing calls `compact()` mid-session.

**Asserted, and the answer is stronger than this section predicted: `compact()`
has *no* production caller at all.** Not two. `serialize.ts` builds its own
old-index → new-index table rather than compacting the mesh being saved
(`serialize.ts:12`), and the GPU upload path in `draw_buffers.ts` walks the live
elements without compacting. The only caller in the tree is
`tests/unit/leafmesh/elem_array.test.ts`. So a stored handle cannot be
invalidated by anything a ToolOp does, and undo holding raw `int32` is safe by
construction rather than by convention. Re-check this if a caller ever appears.

`calcUndoMem` (P7's undo capability) needs a real implementation — the column
byte count — or large-mesh undo silently mis-budgets.

## 8. Tests

- **The headline**: a cube is modelled into a hole-bearing shape **in a
  sculptcore-free build**. Build the fixture as a scripted ToolOp sequence so it
  runs headlessly.
- Each tool in §4: one basic case, one hole-bearing case, one undo/redo cycle.
- The five hole cases in §5, individually.
- Transform: translate/rotate/scale on vert/edge/face selections; proportional
  edit; snapping. Assert `transform_ops.ts` has no type literal.
- Euler invariants (P3's property test) hold after every modeling op — this is
  the cheap net that catches a tool leaving the mesh malformed.
- Round-trip: model, save, load, continue modelling.
- `pnpm test` green with **sculptcore absent from the build**, which is the
  configuration this plan exists to prove. Until P16 makes that lane real, run
  it as a manual configuration and record the result.

## 9. Risks

- **Scope.** A modeling toolmode has no natural end. Mitigation: §4's list is
  the contract; additions are separate plans with numbers.
- **Hole handling is where the bugs are.** Mitigation: §5 enumerates them up
  front and each gets a test, rather than being found by users.
- **Proportional edit is too slow without acceleration.** Mitigation: measure
  before building anything; brute force may well be fine at the sizes a
  modeling toolmode sees.
- **This plan slips and P13 waits.** It is on the critical path by design. If it
  slips, the correct response is to cut §4's tool list, not to reorder P13 ahead
  of it.
- **The toolmode ends up needing host edits.** Same rule as P11: that is a P7
  defect. Record it, fix it there.

## 10. Exit criteria

- A cube is modelled into a hole-bearing shape in a sculptcore-free build,
  headlessly reproducible.
- Every tool in §4 works, is undoable, and has a hole-bearing test case.
- LeafMesh implements `ITransDataType`, registered through `AddonAPI`;
  `transform_ops.ts` contains no type literal.
- Open decisions #2 and #8 are recorded as settled in the strategy doc's §9.4
  table, and §4's scope is what P17 freezes into `faber-leaf-core`.
- No file under `scripts/` changed, or every change is recorded as a P7/P8 gap
  and closed there.

---

## 11. Plan of record (2026-08-18)

Written after re-verifying §6's citations against the tree, which is what the
plan header asks for. What survived and what moved:

- `ITransDataType` is `scripts/editors/view3d/transform/transform_base.ts:108`,
  **13 methods** exactly as §6 says.
- `MeshTransType` is registered from the mesh addon's `register(api)`
  (`addons/builtin/mesh/src/main.ts:167`), not at module scope — so P8 already
  fixed implementor #1. The anti-example §6 cites is still real, but it is
  `scripts/lite-mesh/litemesh_transtype.ts`'s **last line**, not line 202, and
  its own comment already says P12 moves it. It moves in **P15**, not here —
  LiteMesh is host code until then. Correcting the citation, not the point.
- `transform_ops.ts` **already contains no geometry-type literal.** §6's
  requirement is met before the phase starts; §8's assertion becomes a
  regression guard rather than a fix.
- The toolmode to mirror is `scripts/editors/view3d/tools/boxmodel.ts` (375
  lines) plus `scripts/lite-mesh/litemesh_modeling_ops.ts` (1,592). The second
  number is misleading as a budget: its topology tools are thin wrappers over
  sculptcore C++. **LeafMesh has no C++ to delegate to**, so the topology
  algorithms are the bulk of this phase and they are new code.
- P11 already supplies the substrate: `listSelected` / `getSelected` /
  `setSelected`, `getActiveElement` / `setActiveElement` /
  `setHighlightElement`, `closestElements`, and the four pick entry points.
  `SelMask.LEAFMESH` is claimed and `registerSelectType('LEAFMESH')` runs.

### Steps

1. **Toolmode shell + selection ops.** `LeafMeshToolMode` (sel-mode chips,
   overlay toggles, keymap, click/hover), `select_all` / `box` / `circle` /
   `nearest` / `linked` / `similar`, on `SelMask` and P11's claimed bit. Pure
   traversal in a testable module; the ToolOps are thin.
2. **Selection overlay.** LiteMesh draws its overlay from C++; LeafMesh has to
   draw its own, or the mode is unusable and every later step is untestable by
   eye.
3. **`ITransDataType` (§6).** Registered through `api.registerTransType`, with
   `calcUndoMem` honest (§7) and proportional edit on `closestElements`.
4. **Extrude (region + individual) and split-off**, on a new pure `modeling.ts`.
5. **Inset and bevel**, carrying §5's outer-ring-in / hole-rings-out rule.
6. **Subdivide and loop-cut**, carrying §5's cut-across-a-hole rule.
7. **§5's five hole cases as named tests**, plus the Euler property test after
   every op and the model→save→load→model round-trip.
8. **The headline (§8)**: a cube modelled into a hole-bearing shape as a
   scripted ToolOp sequence, headless, and the sculptcore-free run recorded.
9. **Close-out**: decisions #2 and #8 into the strategy doc's §9.4 table, and
   the criterion-12 audit.

### Rules carried from P11

§2's rule holds unchanged and is the same one P11 ran under: **if the toolmode
needs a change under `scripts/`, P7 is not finished — fix P7, in its own
commit, and record the gap in §13.** Gaps continue the P11 numbering (G1-G5 are
in the P11 plan), so the first one here is **G6**.

Foreseen already, from grepping the hub for what a toolmode needs: `ToolMode` is
exported but `IToolModeDefine` is not; none of `ITransDataType` /
`TransDataType` / `TransDataElem` / `TransDataList` are; neither are
`normalizeSelMask` / `selMaskToNames`. Each is a hub re-export, and each is a
thing *every* addon-owned toolmode needs — which is the test P11 §2 applies.

## 12. What has landed

### Step 1 — toolmode shell + selection ops

- **`select_geom.ts`** (pure, no `scripts/` import): the `.select` byte layer per
  domain, created on first write; `applySelection` (replace/add/sub/toggle),
  `flushSelection` (down first, then up, so the upward pass reads a settled
  vertex layer), `linkedFrom`, `similarTo` over ten criteria, and the
  measurement helpers they need. `faceArea` subtracts hole rings — the first
  place §5's hole rule shows up in code. 30 unit tests in
  `tests/unit/leafmesh/select_geom.test.ts`.
- **`SELECT_ATTR` moved out of `leafmesh.ts` into `select_geom.ts`.** The
  framework-facing half now imports the constant from the pure half, which is
  the direction that keeps the pure module testable.
- **`select_ops.ts`**: `leafmesh.select_all` / `select_box` / `select_circle` /
  `select_nearest` / `select_linked` / `select_similar`, all thin over the
  above. Box and circle are modal and call `exec` themselves on commit, because
  the toolstack does not (`modalEnd` never calls `exec`) — which is also what
  makes redo work, since redo is `undoPre` + `exec`.
- **`toolmode.ts`**: `LeafMeshToolMode` — sel-mode chips, the overlay
  toggles step 2 reads, `selectRadius`, click-select, hover highlight, and
  the A / alt-A / B / C / L / shift-G keymap. Registered from `register(api)`
  via `api.registerAll(...)`, never at module scope.

**Undo is a snapshot, not a log** (§7). LiteMesh's selection ops delegate
undo/redo to the C++ `MeshLog`; LeafMesh has nothing to delegate to, so
`undoPre` copies the three `.select` columns and `undo` puts them back.
`calcUndoMem` reports those bytes rather than zero. `restoreSelection` tolerates
a column that has grown since the snapshot — the extra rows stay clear — which
is sound because P3's handles are stable under tombstoned deletion.

G / R / S are deliberately absent from the keymap until step 3 lands the
transform bridge; the mode is selection-only until then.

`git diff --stat scripts/` for this commit is empty (criterion 12), with the one
hub gap it needed landed separately as G6 below.

### Step 2 — selection overlay

- **`overlay_geom.ts`** (pure): `buildSelectionOverlay(mesh, req, cache?)`
  returns three position+colour batches — points, lines, tris — and decides the
  whole of what the viewport shows. Colours are resolved on the CPU
  (highlight ▸ active ▸ selected ▸ base) against a replaceable `OverlayTheme`,
  so the tinting is unit-testable rather than something to squint at. Selected
  faces are filled through the shared `TriangulationCache`, which means the
  hole rule §5 states is inherited rather than re-implemented. 14 unit tests in
  `tests/unit/leafmesh/overlay_geom.test.ts`.
- **`overlay.ts`** (framework-facing): three `SimpleMesh` batches, each with
  `primflag` set to exactly `POINTS` / `LINES` / `TRIS` so
  `WebGPUDrawQueueAdapter` picks the line topology and the point-sprite remap,
  drawn with `Shaders.MeshEditShader`. Cached per `LeafMeshData` in a
  `WeakMap`, rebuilt only when `overlayCacheKey` changes — `updateGen` covers
  topology, positions and selection, and the rest of the key covers the things
  `invalidate` does *not* bump (the sel-mode, the toggles, active/highlight).
- **The overlay draws from `on_drawend`, not from `drawQ`.** That hook runs
  inside the open pass in both the solid path and the render-mode overlay pass,
  whereas `drawQ` is skipped for renderables under `SHOW_RENDER`; and a
  modeling overlay should only exist while the mode is active.
  `SimpleMesh.draw` self-routes through `createDrawQueue` when a WebGPU pass is
  open, so no queue or frame plumbing crosses the addon boundary.

**Two shader facts the overlay had to be built around**, both consequences of
the WGSL port rather than of LeafMesh:

- *No polygon offset.* The GLSL `MeshEditShader` had one; the WGSL port
  dropped it, and there is no per-submission depth bias. So the overlay is
  lifted off the surface **geometrically** — along an accumulated face normal,
  by `OVERLAY_LIFT` × the bounding diagonal, with face fills lifted half as far
  as the wires over them. Doing it in the pure module keeps it camera-free and
  testable.
- *Unset vertex ids are `-1`.* `MeshEditShader` tints any vertex whose id
  matches `active_id` / `highlight_id` / `last_id`, and `SimpleIsland` fills an
  unwritten ID layer with `-1` — so `-1` is exactly the wrong "off" sentinel.
  The uniforms are set to `-2` instead, which switches the shader's own tinting
  off and leaves the baked per-vertex colours alone.

**The `xray` toggle was removed rather than shipped dead.** Every WGSL pipeline
gets `DEFAULT_DEPTH_STATE` from `buildPipelineDescriptor`, and there is no
depth-off path through the queue adapter — LiteMesh's own x-ray works only
because it bypasses the queue via `WebGPUBatchExecutor`, which is
sculptcore-only. Honouring the toggle would mean a `depthTest` field on
`Submission` plus a depth-variant pipeline cache in
`scripts/webgpu/queue_adapter.ts`, *and* a hub re-export of `createDrawQueue`
(because `SimpleMesh.draw` builds its own `Submission` internally) — a real P8
change, worth making when a second consumer needs it and not before. A toggle
that silently does nothing is worse than no toggle, and the branch is
unreleased, so dropping the STRUCT field is free.

`git diff --stat scripts/` for this commit is empty (criterion 12); no new
contract gap was needed.

### Step 3 — `ITransDataType`

The same pure/framework split again.

- **`transform_geom.ts`** (pure): `gatherMovableVerts`, `propagationDistances`,
  `centroidOf`, `aabbOf`, `snapshotBytes`. Which vertices move, how far each
  unselected one follows, and what a snapshot costs — 11 tests.
- **`transtype.ts`** (framework): `LeafMeshTransType`, plus the `TransDataElem` /
  `TransDataList` subclasses. Registered from `register(api)` through
  `api.registerTransType`, so it can be unregistered when the addon unloads —
  which `litemesh_transtype.ts:204`'s module-scope `TransDataType.register`
  cannot.

`transform_ops.ts` names no geometry type: `TransDataType.defaultTypeNames()`
already collects every registered name, so registering is the whole of the
wiring.

**Proportional edit runs on `closestElements`, and the pure module takes the
query as a parameter** (`NearVertQuery`) rather than importing it. That is what
keeps `transform_geom.ts` free of `scripts/` while still making the real path
the contract's own query — production passes `data.closestElements`, the tests
pass a brute-force stand-in and one that deliberately ignores the radius, which
is how the hard radius cut is pinned. P11's `closestElements` is itself brute
force; §6 permits that, and speeding it up stays a LeafMesh-internal change.

**`calcUndoMem` reports the real figure** (§7): an `int32` handle plus three
`float64` per vertex, counted over every element in the list — the
proportional-edit ones included, since undo has to put those back too.

`applyTransform` writes straight into `mesh.v.co` and `update` issues one
`invalidate(POSITIONS, VERT, handles)` per step. Per-vertex `setPositions` would
be one invalidation per vertex per frame.

This step needed **G7** below; the addon-side diff carries no `scripts/`.

### Step 4 — extrude and split-off

The same split a third time, and this time the hub needed nothing new.

- **`modeling.ts`** (pure): `extrudeFaceRegion`, `extrudeFacesIndividual`,
  `splitOffFaces`, `regionBoundaryEdges`, `meshSnapshotBytes` — 14 tests.
- **`modeling_ops.ts`** (framework): `leafmesh.extrude_region`,
  `leafmesh.extrude_individual`, `leafmesh.split_off` on a shared
  `LeafMeshTopoOpBase`, registered through `main.ts`'s one `registerAll`.

**All three tools are the same rewrite**: snapshot the region, duplicate the
vertices that have to come apart, rebuild the faces on the copies, and — for an
extrude — raise a wall along the rim. Only two things differ: *which* vertices
are duplicated (an extrude duplicates the rim's, a split-off duplicates every
vertex the region shares with a face outside it) and whether walls go up.

**The rim is an edge property, not a vertex one**: an edge with exactly one
adjacent *region* face. Classifying vertices instead would make a lone flat quad
extrude into nothing; the edge rule extrudes it into an open box, raises one
wall rather than three between two selected neighbours, and correctly no-ops a
closed region — all four are tests.

**Wall winding follows the region face's own traversal.** For the directed edge
`a → b` as the region face walks it, the wall ring is `[a, b, b', a']`, whose
Newell normal points out of the solid. That is right for a hole ring as well as
an outer one, because a hole ring is already wound the other way — §5's case,
pinned by the tube test that checks the eight inner walls face inward and the
eight outer ones outward while the cap keeps its hole.

Two things the rewrite has to get right and does: every attribute row is
snapshotted **before** the first `killFace`, because a freed row's storage is
handed straight back out to the faces being rebuilt; and a region-interior edge
whose endpoints were both duplicated is left with zero faces, so every region
edge is collected up front and the survivors killed.

**Undo is a whole-mesh `copy()`.** A topology op rewrites handles across four
domains at once, so no smaller snapshot is honest — `calcUndoMem` reports
`meshSnapshotBytes`, which counts every column of every domain plus the
freemaps. `undo` restores a *fresh* copy each time, so undo → redo → undo works.

`transform=1` chains a `TranslateOp` behind the geom op in one `ToolMacro`
(`E`, `Alt+E`, `V`), with the op's `normalSpace` output driving the translate's
constraint space — the same shape as `litemesh_modeling_ops.ts`'s
`makeTransformMacro`. Split-off drags freely instead: a detached piece goes
anywhere. Both extrudes also carry a plain `offset` input, which is what makes
§8's scripted headless sequences expressible without a pointer.

`ToolMacro`, `Mat4Property` and `Matrix4` all already reach the addon through
`@framework/pathux` and `@framework/api`, so this step opened **no** gap: the
addon-side diff carries no `scripts/`.

### Step 5 — inset and bevel

- **`modeling.ts`** (pure) gained `insetFaceRegion` / `insetFacesIndividual`
  and `InsetOptions` — 6 more tests.
- **`bevel.ts`** (pure, new): `bevelVerts`, `bevelEdges` — 12 tests.
- **`modeling_ops.ts`** (framework) gained `leafmesh.inset_faces`,
  `leafmesh.bevel_verts` and `leafmesh.bevel_edges` on a shared
  `LeafMeshDragOpBase`.

**Inset is extrude with a different mover.** `rewriteRegion` used to take a
scalar offset; it now takes a `MoveFn`, and that is the whole difference between
the two tools — an extrude slides the duplicated rim along the region normal, an
inset slides it in the face plane. Walls, rim classification, attribute
snapshotting and orphan-edge cleanup are shared unchanged.

**§5's outer-ring-in / hole-rings-out rule falls out of winding and needs no
special case.** The inward direction at a rim vertex is `cross(N, d)` for the
rim direction `d` — the left of the rim as the region's own faces walk it. A
hole ring is wound the other way, so the one expression moves an outer ring in
and a hole ring out, both toward the material. Exact width comes from the
bisector: `bis = normalize(w1 + w2)`, scaled by `amount / (bis · w1)`. The tube
test pins it — the outer ring's mean radius falls, the hole ring's rises, the
face keeps its hole, and 32 skirt faces come up.

**Vertex bevel and edge bevel are one construction seen twice.** Around a vertex
the incident edges form a cyclic fan; the bevel replaces the vertex with one
point per fan edge, each incident face taking the two points of the edges it
sits between, and closes the hole with a cap. Beveling an edge is the same at
each of its ends with that edge's own point left out: the fan becomes an arc,
and the gap the arc leaves is filled by the bevel quad instead of by a cap — so
a three-edge end needs no cap (the single face between the arc's two points
already spans it) and a four-edge end gets a triangular one.

**Winding is derived, not tested for.** A fan face between `edges[i]` and
`edges[i + 1]` walks its ring as `other(edges[i]) → v → other(edges[i + 1])`,
so it uses the directed edge `p_i → p_(i+1)`; a cap therefore walks the fan
backwards, and the quad crosses head-to-tail between the two arcs. No normal
test appears anywhere in `bevel.ts` — `validateAndRepair() === 0` in every case
is what proves it.

**A bevel refuses what it cannot do, explicitly.** `vertFan` returns nothing for
a boundary vertex, a wire edge, a face meeting the vertex twice or a
non-manifold disk, and `bevelEdges` additionally requires two faces per edge and
**no two selected edges sharing a vertex** — a chain needs one shared offset
point at the vertex the edges meet in, which is a vertex bevel's job. Refused
elements come back in `BevelResult.skipped` and the mesh is left untouched;
both refusals are tests. Lifting that restriction is future work, not silent
breakage.

**These three drag rather than chaining a translate.** An inset width has no
`TranslateOp` analogue, so `LeafMeshDragOpBase` is modal: it reads a horizontal
drag through the same object-local-units-per-pixel unprojection
`litemesh_modeling_ops.ts` uses, and each move restores the undo snapshot and
re-runs `exec` from the new width. `exec` doing the whole job from its inputs is
what keeps them scriptable — §8's headless sequences set `amount` / `depth` /
`individual` and never touch a pointer. Cancel needs no code: `modalEnd(true)`
runs the toolstack's cancel, which is the base class's `undo`.

Hotkeys: `I` insets; `Ctrl+B` bevels whatever the mode is selecting — edges when
edge mode is on, vertices otherwise. This step opened **no** gap either; the
addon-side diff carries no `scripts/`.

### Step 6 — subdivide and loop-cut

- **`subdivide.ts`** (pure, new): `subdivideEdges`, `subdivideFaces`,
  `subdivideSelection`, `edgeRing`, `loopCut`, `loopCutEdges` — 12 tests.
- **`modeling_ops.ts`** (framework) gained `leafmesh.subdivide` and
  `leafmesh.loop_cut`; `_finish` now takes the domain to leave selected, so a
  cut can leave its new vertices selected rather than nothing.

**§5's two rules pull in opposite directions, and that is the design.** A
subdivision is per ring by construction — `splitEdge` inserts the vertex into
every face on the edge and leaves each ring's order alone — so a face with holes
subdivides correctly with no case of its own, and the hole-ring test only has to
confirm it. A chord is the other thing: it is only meaningful across a single
ring, so the loop-cut walk stops dead at any face that is not a hole-free quad
and reports it in `LoopCutResult.stopped`. Nothing is drawn through a hole, and
the refusal is visible to the caller rather than implied. The tube pins it — a
cut round the outer wall stops at both annular caps, names them, and the caps
keep their holes.

**Winding is derived here too.** A chord splits a ring at two of its vertices
into the two spans between them, each walked in the ring's own direction; a quad
split walks `mid → corner → mid` before closing on the centre. `subdivide.ts`
reads no normal anywhere, and `validateAndRepair() === 0` in all twelve cases is
what proves it.

**A quad split is a subdivision that finished the job.** `subdivideEdges` is the
primitive: `cuts` vertices into each selected edge, faces keeping their identity
and simply growing. `subdivideFaces` cuts each ring edge once — once, not once
per adjacent selected face — and then rebuilds the face as one quad per original
corner around a new centre vertex, which is what a modelling subdivide is
expected to do. A face with a hole is refused, because its centre would have to
be somewhere the face is not, and comes back in `skipped` to subdivide by ring
instead. `subdivideSelection` is the dispatch the ToolOp calls: a face whose
every edge is selected is quad-split, every other selected edge is just cut.
More than one cut subdivides by ring throughout, since a quad split is a single
cut by construction.

**The triangulation cache invalidates for free.** Every Euler call the two make —
`splitEdge`, `killFace`, `makeFace`, `makeVert` — bumps `topoStamp`, which is
what §5 asks for; no op-side invalidation call exists or is needed.

**Both ops are plain, not modal.** A loop cut's interactive slide would drag `t`
along the ring rather than in object units, which `LeafMeshDragOpBase`'s
pixels-to-local-units mapping does not describe; `t` is an input at 0.5 and the
slide is future work, not a silent narrowing. `leafmesh.loop_cut` cuts the ring
through each selected edge, skipping edges an earlier ring already ran through,
so selecting a whole loop cuts once. Hotkey `Ctrl+R`; subdivide has no default
key (Blender has none either) and sits in the header's tool row.

This step opened **no** gap; the addon-side diff carries no `scripts/`.

### Step 7 — the hole cases named, the Euler count, and a round trip

`tests/unit/leafmesh/holes.test.ts` (ten cases) states §5's list one test at a
time, and `topo.ts`'s `joinFaces` grew the ring merge §5 asks it for.

**§5 lists four bullets and step 12 asks for five cases, because the first
bullet is one rule over two ops.** The five: extrude a holed cap, inset a holed
cap, dissolve a face beside a hole, cut a loop across a hole, subdivide a hole
ring. Four of them were already true of the code — `modeling.test.ts` and
`subdivide.test.ts` cover some of the same ground — but a rule scattered across
three files by side effect is not an audited rule, and this file is where §5 can
be read against the tests one line at a time.

**`joinFaces` now merges a hole ring into the other face's outer ring.** It used
to require both corners on their faces' outer rings, which refused the one case
§5 names. The generalisation is small because the walk never cared: an edge is
traversed in opposite directions by its two faces whichever rings they sit on,
so the merge is unchanged and only the bookkeeping moves — when either side's
corner is on a hole, the *other* face's outer ring leads the new face and the
merged ring becomes its hole. Two hole rings are refused, because the result
would have no outer ring at all; two faces sharing more than one edge were
already refused, which is what a face exactly filling its own hole is.

**Face deletion is a capability here, not a tool.** §4's list has no delete or
dissolve op and §4 says additions are separate plans, so §5's case lands as
`joinFaces` plus its tests. The tube is the honest fixture: joining the annular
cap to an inner wall quad dissolves the quad into the hole, and the hole ring
comes back with ten vertices — eight plus four, less the two the dropped edge
held in common.

**The Euler–Poincaré count is the property test.** `V − E + F − H = 2(S − G)`,
`H` counting inner rings: the cube's term is 2 and the tube's, being genus one,
is 0, and every op in §4 except split-off leaves it alone. Only the closed
fixtures are held to it — an open surface's boundary is not in the formula, and
split-off is the one op that opens one, so it is named and left out rather than
quietly skipped.

**The round trip models, saves, loads, and goes on modelling.** A cube extruded,
subdivided and loop-cut, through `serialize.ts` and back, comes out with the
same counts, the same term, the same vertex column and no repairs — and then
takes an inset that matches the same inset on the mesh it came from. Serialising
is not a snapshot of a finished mesh; it is a pause in the middle of one.

This step opened **no** gap; the diff carries no `scripts/`.

### Step 8 — the headline, headless

`addons/builtin/leafmesh/src/headless_demo.ts` models a cube into a hole-bearing
shape and a tube through its holed cap, entirely through the real ToolOps, and
reports what each one did. It lives in the addon, not in `scripts/`, so
criterion 12 survives it; `runLeafMeshHeadlessDemo` is exported on the
`leafmesh` namespace and the harness reaches it by name.

**The invocation**, since renderer stdout never reaches the launcher and
`--dump` is how an eval answers back:

```
node nwjs/launch.mjs --headless --app-storage-dir <dir>   --eval "_framework.api.addonManager.enable('leafmesh')"   --eval "globalThis.__evalTestResult = _framework.api.addonManager.getAddonAPI('leafmesh').exports.leafmesh.runLeafMeshHeadlessDemo(_appstate.ctx)"   --dump <out.json> --exit
```

`__evalTestResult` is reflected into the dump as `evalResult`
(`scripts/core/test_harness.ts`), and the evals run after the scene is built.
Enabling the addon by hand is the first thing the script does because leafmesh
is the first builtin that is not `defaultEnabled` — which is also how G8 was
found.

**The cube.** Subdivide every face, inset a quad of the top, extrude it into a
boss, inset the cap, split the cap centre off, bevel the far corner: 8/12/6
becomes 40/63/25, the Euler term stays 2 throughout, and `boundaryEdges` goes
0 → 8 at the split-off. That eight-edge ring is the hole.

**No op in §4 creates a face that carries a hole ring**, so the cube's hole is
an opening in its surface, not an inner ring — which is why the demo also runs
a tube. `makeTube` starts holed (two annular caps, `holeRings` 2, Euler term 0
for genus one), and inset, extrude, subdivide and loop-cut take it from
48/72/26 to 101/176/77 with both rings intact and the term unmoved. The cube
proves the sequence; the tube proves the ops handle a face that already has a
hole.

Every step reports `repairs: 0`.

**A redo re-runs `exec` against the live selection.** `ToolStack.redo` calls
`tool.redo(ctx)`, which is `undoPre; execPre; exec; execPost` — and every
modelling op reads `listSelected(mesh, domain)`, i.e. mesh state, not op inputs.
So undoing a whole run is exact (the undo snapshot restores the selection attrs
with everything else), but redoing one only reproduces it when the selections
are themselves on the stack. In the app they are: selection is
`leafmesh.select_*`. This fixture sets selection with plain helpers on purpose,
so it cycles undo/redo **per step, in place** — which is what §8 asked for
anyway — then undoes the whole run to the base and replays it. `undo → base`
and `replay == final` both hold for both shapes, hashed order-independently.

**Sculptcore-free, measured two ways.** At the module level it already holds:
the addon's only mentions of sculptcore are seven prose comments, and the
seventeen `tests/unit/leafmesh/` suites (256 tests, 4.3s) run in plain jest with
no sculptcore anywhere in the graph. At the *boot* level it does not yet:
`scripts/entry_point.js`'s `init()` awaits `sculptcore.getWasm()`
unconditionally, so with `build/sculptcore-browser.wasm` moved aside the app
never reaches the eval stage and the run produces no dump at all. That is a host
boot fact, not a LeafMesh dependency, and making the sculptcore-free lane real
is P16's — recorded here as the measured result §8 asked for rather than left
as a claim.

This step opened **no** gap of its own; G8 was opened before it, by it.

## 13. Contract gaps

Numbering continues from the P11 plan (G1-G5 are recorded there).

### G6 — a toolmode's own define type and mask conversion were not on the hub

`scripts/framework_api.ts` re-exported `ToolMode` but not `IToolModeDefine`, the
type every subclass must return from `toolModeDefine()`; and it re-exported
`SelMask` but neither `normalizeSelMask` nor `selMaskToNames`, which are both
halves of the conversion any toolmode that persists a select mask has to do
(`loadSTRUCT` reads the integer form, the nstructjs field writes the name form).
An addon-owned toolmode cannot be written without all three, so this is P7's
defect and not LeafMesh's — exactly the test §2 applies. Fixed in
`8b05090d refactor(P7): re-export the toolmode-define and sel-mask helpers`,
which carries `scripts/framework_api.ts` and nothing else.

§11 foresaw a wider gap than this. `ITransDataType` / `TransDataType` /
`TransDataElem` / `TransDataList` are still missing, but they are step 3's
problem, not step 1's; and the property classes turned out to be reachable
already through `@framework/pathux`, so they needed no hub change at all.

### G7 — the transform-data interface was not on the hub

`AddonAPI.registerTransType` has existed since P7, but the type it takes had
not: `ITransDataType`, `TransformDefine` (what every implementor returns from
`transformDefine()`), and `TransDataElem` / `TransDataList` (the two classes it
must subclass) were reachable only by relative path into
`scripts/editors/view3d/transform/`. A geometry addon could be *registered* but
not *written* — P7's defect, not LeafMesh's. Fixed in
`10fe2fb7 refactor(P7): re-export the transform-data interface from the hub`,
which carries `scripts/framework_api.ts` and `transform_ops.ts` and nothing
else.

The re-export is routed through `transform_ops.js` rather than
`transform_base.js`, for the same reason the hub's `MeshTransType` line already
is: the hub depends on `transform_ops.js` either way, whereas a direct edge on
`transform_base.js` puts `framework_api.ts` into one more import cycle and
`check:layers` refuses the +1.

### G8 — an addon enabled after startup had unreachable tool paths

`parseToolPath` builds its `toolpath -> class` map once, on the first call, and
never again (`scripts/path.ux/scripts/path-controller/toolsys/toolpath.ts`). An
addon that is not `defaultEnabled` registers its ToolOps when the user enables
it, which is always after the first menu or keymap has parsed a path — so every
one of its tools answered `unknown tool`, by path, forever. The leafmesh addon
is the first builtin with `defaultEnabled: false`, which is why nothing had hit
this before; §8's headless sequence hit it on its first `createTool`.

Not LeafMesh's defect and not fixable from an addon, so it is P7's by §2's test.
A miss now rescans `ToolClasses` before deciding the tool is absent. Fixed in
path-controller `5049af1 fix(toolpath): rescan tool paths when a lookup misses`,
carried into the parent by the gitlink bump that records this gap.

This one is under `scripts/` only in the sense that the vendored submodule lives
there; the criterion-12 audit reads it as a submodule pointer, not a host edit.
