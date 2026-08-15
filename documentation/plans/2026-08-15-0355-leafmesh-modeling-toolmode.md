# P12 — LeafMesh modeling toolmode

**Status:** plan — not started.

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
| subdivide | |
| loop-cut | |

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
as long as nothing calls `compact()` mid-session. Assert that: `compact()` has
exactly two callers (serialize, GPU upload) and neither runs inside a ToolOp.

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
