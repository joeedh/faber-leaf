# P11 — LeafMesh host integration

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§5 phase 8, §9.3 P11. **Design:**
[LeafMesh](./2026-08-15-0248-leafmesh-design.md) §12 steps 4–7.

**Workstream / phase:** risk mitigation / phase 8.

**Depends on:** P3 (the headless core), P8 (the host must accept a contributed
geometry type). Uses P7's contract. **Blocks:** P12, P18.

**Authoring effort:** high.

**Closes:** success criterion 12 (proved); contributes to 13.

---

## 1. Goal

Turn P3's headless library into a registered geometry addon: a DataBlock, a
`SceneObjectData`, a draw path, picking, serialization, OBJ import — **without
touching a single file under `scripts/`**.

## 2. This is the worked example, not just a feature

Success criterion 12 is "a third-party geometry type can be added with no
`scripts/` edit." LeafMesh is how that is proved, and the proof only counts if
the constraint is honoured literally.

> **If adding LeafMesh requires a change under `scripts/`, P7 or P8 is not
> finished. Fix P7/P8. Do not special-case LeafMesh.**

That rule is the plan's main value. Every `scripts/` edit this plan is tempted
to make is a defect report against the contract, and writing it down as such is
worth more than the edit.

Keep a running list in this document under `## Contract gaps (found
YYYY-MM-DD)`: what LeafMesh needed, which host file would have had to change,
and how P7/P8 was extended instead.

## 3. Deliverables

Design §12 steps 4–7, under `addons/builtin/leafmesh/`:

| File | Budget | Contents |
| --- | --- | --- |
| `src/leafmesh.ts` | ~900 | the `LeafMesh` DataBlock + `SceneObjectData` implementation of P7's `IGeometrySource` |
| `src/draw.ts` | ~350 | VBO build from the triangulation cache, material-slot submission |
| `src/pick.ts` | ~300 | `castViewRay` / `findNearest` / `castScreenCircle` / `castScreenRect` |
| `src/serialize.ts` | ~250 | nstructjs STRUCT; columns out, derived topology rebuilt on load |
| `src/main.ts`, `src/api.ts` | ~150 | the `register(api)` hook and the peer-addon shim |
| `manifest.json` | — | **`"dependencies": []`** |
| OBJ import | ~250 | §6 |

`src/uv_source.ts` is deliberately **not** here — it lands in P18, where the
interface it implements is actually designed.

## 4. The manifest is the first test

`"dependencies": []`. Every builtin addon in the tree today declares
`["mesh"]` — including `sculptcore` itself. LeafMesh is the first builtin with
no dependencies at all, which means it is also the first one that proves the
dependency machinery is not load-bearing in the wrong direction.

`"buildMode": "prebuilt"` like the others. `"optional"` is meaningless until
P14 makes it real; leave it off rather than writing a field that is silently
dropped (`manifest.ts:9-47` does not declare it, `validateManifest:123-135` does
not read it, `install.ts:113` does not act on it).

## 5. Serialization

- **Authoritative columns only.** `v.co`, `e.v1/v2`, `c.v`, `c.next`, `l.c`,
  `l.next`, `f.l`, `f.listCount`, plus every non-`TEMP`, non-`DERIVED`
  attribute layer. Disk and radial cycles, `c.e`, `c.prev`, `c.l`, `l.size`,
  `l.f` are rebuilt by `rebuildDerivedTopo()` on load (P3).
- **Compact before writing.** `compact()` returns remap tables (P3); apply them
  to the columns being written so a file never carries tombstones. Anything
  holding indices across the compaction — nothing should, at save time — is a
  bug.
- Follow LiteMesh's precedent: a `_data` blob field
  (`iter(byte)` + a `serialize()` hook), which keeps the per-element read out of
  nstructjs's per-byte path. That path is a measured startup hotspot for large
  meshes, so do not serialize elements individually.
- **`TEMP` layers must be marked `TEMP`.** The LiteMesh experience is that
  spatial `.node` attributes written by accident bloat and then corrupt files.
- Round-trip must survive the addon being absent — that is P10's machinery, and
  LeafMesh is a good second test of it.

## 6. OBJ import

Import is table stakes for an embeddable host (§6 of the strategy). Reimplement
OBJ against LeafMesh:

- **`f` lines are already loop lists.** OBJ's `f a/b/c d/e/f …` maps directly
  onto `makeFace([verts])`, and OBJ files in the wild contain n-gons that the
  BREP importer silently fanned. This is the cheapest possible demonstration of
  why faces-are-loop-lists was the right call.
- Corner UVs (`vt`) land on the CORNER domain, matching P3's convention.
- Winding: OBJ does not guarantee it. Call `fixWinding()` (P3 §4.1) on import —
  this is exactly the importer case the enforcement decision provided for.
- **FBX is out of scope.** Say so; do not let it creep in.
- Register the format through P7's `registerFileFormat` case, not by editing a
  host format table.

## 7. Draw and the vertex layout

Expect P7 §8 to be the thing that bites. Without the vertex-layout contract,
LeafMesh either reuses `LIT_MESH_VERTEX_LAYOUT` verbatim (and cannot carry its
own attributes) or cannot use the material system at all.

So:

- Declare LeafMesh's attribute set in its kind descriptor (P7 §5) and build the
  vertex layout from it via the generalized builder.
- Prove it: **a material with an `AttributeNode` reading a LeafMesh-authored
  attribute layer must render**, through both compile sites
  (`renderengine_realtime.ts:708`, `view3d_draw_webgpu.ts:490`). That is
  criterion 13, and it is not proved by the mesh appearing on screen in a flat
  colour.
- If `camera.ts:163,165`'s `scheduleRawGLPass` throw surfaces here, P8 was
  supposed to have fixed the call site — report it back rather than working
  around it.

Draw sources triangles from P3's per-face triangulation cache, keyed on
`topoStamp`. A static mesh uploads once.

## 8. Picking

Four overrides on the `SceneObjectData` subclass, per
[picking.md](../picking.md): `castViewRay`, `findNearest`, `castScreenCircle`,
`castScreenRect`. Geometric, addon-owned, no GPU id-buffer.

LeafMesh has no spatial acceleration structure in P3. Answer P7's
`closestElements` by brute force initially and **decline the spatial-acceleration
capability** rather than faking it — a slow honest answer is a valid provider,
and it is the case P7 §5.1 was designed for. Add acceleration only if P12's
toolmode makes it necessary, and then as a real structure, not as a reach-through
`getBVH()`.

`_ownSelectMask` claims a bit through P6's registry — LeafMesh is the first
consumer of that mechanism.

## 9. Plan of record

1. `manifest.json` + `main.ts` + `api.ts`; register nothing but the kind
   descriptor. Confirm the app boots and the addon appears in the addon list.
2. `leafmesh.ts` — DataBlock + `SceneObjectData`, against P7's interfaces.
   Compile before implementing: the type errors are the contract's to-do list.
3. `serialize.ts` — round-trip a primitive from P3 through `.wproj`.
4. `draw.ts` — flat render first, then the attribute-driven material (§7).
5. `pick.ts` — click-select, box, circle.
6. OBJ import (§6).
7. The criterion-12 audit: `git diff --stat scripts/` for the whole plan must be
   **empty**.

## 10. Tests

- **Criterion 12**: `git diff --stat scripts/` across the plan's commits is
  empty. Assert it in the PR description, and add a CI check if the branch
  layout allows.
- **Criterion 13**: an `AttributeNode` material on a LeafMesh renders through
  both compile sites — a rendered-output comparison, not a "did not throw".
- Round-trip: a cube and a hole-bearing cylinder survive `.wproj` save/load with
  attributes, selection, and material slots intact.
- Round-trip with the addon **absent** (P10's machinery): the block's bytes and
  `lib_id` survive.
- OBJ: a file with an n-gon and a file with a hole-bearing face import with the
  correct face count — not a fanned approximation.
- Picking: vertex/edge/face click-select, box-select, circle-select on a mesh
  with holes.
- The BREP is still present during all of this. That is deliberate — P13 has a
  safety net, and a regression here is attributable.

## 11. Risks

- **The temptation to edit `scripts/`.** It will happen, it will look like a
  one-line fix, and taking it invalidates the plan's entire purpose.
  Mitigation: §2's rule and the running gap list.
- **The host layer is under-budgeted.** The design's 3,500–4,500-line total
  covers P3 *and* this; the adversarial review's judgement is that the host half
  is the one that overruns. If it does, that is a finding about P7's contract
  size, not about LeafMesh — record it.
- **Vertex-layout work turns out to still be undone.** Then criterion 13 cannot
  be closed here and P7 is not finished. Do not close it by hardcoding
  `LIT_MESH_VERTEX_LAYOUT`.
- **Serialization written per-element.** Mitigation: §5's blob-field precedent,
  decided up front rather than after a profile.

## 12. Exit criteria

- LeafMesh renders, picks, round-trips through `.wproj`, and imports an OBJ
  file — with the BREP still present.
- A material with an `AttributeNode` renders on a LeafMesh object.
- **No file under `scripts/` changed.** Any contract gap found is recorded here
  and closed in P7 or P8.
- `pnpm check:layers` unchanged (LeafMesh introduces no host edges by
  construction); `pnpm test` and `pnpm typecheck` green.
