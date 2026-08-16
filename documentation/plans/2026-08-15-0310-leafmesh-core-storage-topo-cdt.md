# P3 — LeafMesh core: storage, attributes, topology, CDT — `[xhigh]`

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§5 phase 0, §9.3 P3. **Design:**
[LeafMesh — the built-in geometry type](./2026-08-15-0248-leafmesh-design.md) §3–§8, §12 steps 1–3, §13.

**Workstream / phase:** risk mitigation / phase 0 — starts on day one, no inbound
dependency at all.

**Depends on:** nothing. **Blocks:** P11, P12, and (through them) P13.

**Authoring effort:** **`[xhigh]`** — this plan picks the storage model,
attribute layout and topology representation that P11, P12 and P18 build
against and that a shipped `.wproj` encodes. It is the most expensive shape in
the refactor to get wrong.

**Settles:** LeafMesh design open questions **2** (winding enforcement) and
**4** (F32 vs F64 for `v.co`). Design questions 1 and 3 are answered in passing
below.

---

## 1. Goal

Build the headless half of LeafMesh: struct-of-arrays storage, attribute
layers, the Euler-op surface, derived-topology rebuild, a ported constrained
Delaunay triangulator, and enough primitives to make a cube.

**Nothing in this plan imports `scripts/`.** No DataBlock, no
`SceneObjectData`, no addon registration, no draw path, no picking. Those are
P11. This is a library with a unit suite, and the tree does not reference it
when the plan ends.

## 2. Why it goes first, and why it is `xhigh`

It is the only track with no inbound dependency, so it absorbs schedule slack
for free. And it is the plan whose output everything downstream is written
against: change the corner/loop model after P12 ships and the modeling toolmode
is rewritten; change the attribute type vocabulary after P11 ships and every
`.wproj` written in between is a migration.

The design document already made the hard calls (§2 faces-are-loop-lists, §4
SoA + tombstoned deletion, §5 sculptcore's `AttrType` verbatim, §8.1 port the
C++ CDT rather than reuse the BREP one). This plan's job is to *execute* them
and close the two open questions the design deferred.

## 3. Deliverables

Under `addons/builtin/leafmesh/src/` — the directory is created here even
though `manifest.json` and `main.ts` do not arrive until P11, so no files move
later.

| File | Budget | Contents |
| --- | --- | --- |
| `elem_array.ts` | ~400 | SoA storage, freemap, free list, paged alloc with `hint`, `compact()` returning remap tables |
| `attrs.ts` | ~450 | typed named domain-keyed layers, `AttrType` vocabulary, `TEMP`/`DERIVED` flags, `interpCorner` |
| `topo.ts` | ~700 | the ten Euler ops, disk/radial cycles, `rebuildDerivedTopo()`, `validateAndRepair()`, `topoStamp` |
| `cdt2d.ts` | ~450 | ported `constrainedDelaunay2D`, pure 2D, zero dependencies |
| `triangulate.ts` | ~300 | plane fit over the outer loop, projection, per-loop constraint rings, fan fast path, per-face cache |
| `primitives.ts` | ~200 | plane, grid, cube, sphere, cylinder-with-hole |
| `index.ts` | ~30 | the module's own barrel — **not** `api.ts`, which is the addon surface P11 adds |

Plus tests under `tests/unit/leafmesh/`.

Total budget ~2,500 lines. The design's overall 3,500–4,500 figure covers this
plus P11's host layer; the adversarial review is right that the *host* half is
under-budgeted (see P11 §7), but this half is not.

## 4. Design decisions to close in this plan

### 4.1 Question 2 — hole winding: enforce

**Enforce on `makeFace` / `addFaceLoop`** (outer CCW w.r.t. the face normal,
holes CW), with a `fixWinding(f)` helper that importers call.

Rationale: signed area, centroid, and point-in-face all become trivial and
correct-by-construction (design §11 items 2–3), and the alternative —
inferring — has to run a containment test per ring on every query. `cdt2d`'s
parity flood-fill is winding-agnostic, so this is a decision about the *rest*
of the system, not about the triangulator.

Enforcement means: compute the signed area of each ring in the face's 2D basis
at construction, reverse rings whose sign is wrong, and record in the module
header that construction may reorder corners. Ops that build faces from
existing corners (`joinFaces`) re-run the check.

**As implemented, only holes are ever reversed.** The face normal is Newell's
sum over ring 0, so ring 0 is CCW about it *by definition* — there is no
"wrong sign" an outer ring can have, and reversing it would only flip the
normal and leave the relationship unchanged. The rule is therefore
*Newell-defines-the-normal*: ring 0 is authoritative and untouched, and every
hole is forced CW against the normal it implies. `fixWinding` re-imposes only
that second half, which is what makes it meaningful on a face whose positions
later moved (a mirror, an importer) — the normal flips under a stored hole
order that no longer matches.

### 4.2 Question 4 — `v.co` is `Float32Array`; `cdt2d` is `Float64Array`

F32 for `co` keeps the GPU upload zero-copy and matches sculptcore's layout,
which is what makes the P11 interop a column copy. F64 inside `cdt2d` costs
nothing (JS numbers are doubles anyway) and makes the `inCircumcircle`
determinant meaningfully more robust than the C++ original.

The seam is one conversion in `triangulate.ts`, which projects to 2D anyway.

### 4.3 Question 1 — live cycles, dropped on serialize

Keep disk and radial cycles **live** (maintained by every Euler op). Serialize
authoritative columns only. Add no freeze/thaw mechanism until profiling asks
for one — and note that if it is ever added, it must be
`topoStamp`-invalidating, because the dyntopo experience
(`dyntopo-live-stroke-profile`) is that frozen-topology reads under a mutating
op are a deterministic crash, not a flake.

### 4.4 Question 3 — nested holes: allow, test, do not advertise

The parity flood-fill handles island-in-hole correctly for free. Add the test
vector; do not add API surface for it.

## 5. Plan

### Step 1 — `elem_array.ts` + `attrs.ts`

Land together; neither is testable without the other.

- `ElemArray`: `capacity`, `freemap: Uint8Array`, `freeList: number[]`,
  `cols: Map<string, TypedArray>`. Growth doubles; columns grow in lockstep.
- Paged allocation with a `hint` (allocate near a given index) matching
  sculptcore's signature, so spatial locality survives when new geometry is
  created near existing geometry.
- **Deletion is tombstoned.** `freemap[i] = 1`, index onto the free list.
  Indices stay stable across edits — this is what lets tool state, selection
  and undo hold raw `int32` indices safely. `compact()` exists for
  serialization and GPU upload and **returns the remap tables**; nothing may
  call it implicitly.
- `attrs.ts`: layers are `(domain, name, AttrType)` triples backed by columns
  in the domain's `ElemArray`. The type vocabulary is sculptcore's verbatim
  (`Float`, `Float2/3/4`, `Int`, `Int2/3/4`, `Short`, `Byte`, `Bool`) so a
  layer transfers between backends with no conversion table.
- Built-in columns, not layers: `v.co` (Float3, F32), `v.no` (Float3).
- Conventions, matching the engine: **UVs on the CORNER domain**; `select` and
  `hide` are attributes on their domain, not bitfields — this is what lets the
  host address selection by *domain* and the provider map domain → attribute
  (and it is what P6's host-owned `SelMask` talks to).
- One interpolation hook: `interpCorner(dst, srcs[], weights[])`. Every op that
  creates geometry routes through it, so no op knows the layer list.
- Layer flags mirror sculptcore's: `TEMP` (not serialized), `DERIVED`
  (rebuildable, dropped on write).

Tests: allocation/free/realloc invariants; column growth preserves values;
`compact()` remap tables are correct and round-trip indices; adding a layer
after 10k elements exist backfills correctly.

### Step 2 — `topo.ts`

The full Euler surface, and nothing beyond it (design §7):

```
makeVert(co, hint?)            killVert(v)
makeEdge(v1, v2, hint?)        killEdge(e)
makeFace(loops[][], hint?)     killFace(f)      // loops[0] = outer
addFaceLoop(f, verts[])        removeFaceLoop(f, l)
splitEdge(e, t)                joinFaces(f1, f2, e)
```

- `makeFace` takes `loops: number[][]`. The single-loop call is
  `makeFace([verts])`. Making the common case one character noisier is the
  price of the founding principle; it is worth paying.
- **Non-manifold is allowed.** Radial cycles are lists, not pairs; an edge may
  have 0, 1, 2 or N faces. No op may assume manifoldness — assert this in the
  module header and in review.
- `topoStamp` is monotonic and bumps on every topology mutation. Normal,
  triangulation and (later) spatial caches key validity on it.
- `rebuildDerivedTopo()` reconstructs disk cycles, radial cycles, `c.e`,
  `c.prev`, `c.l`, `l.size`, `l.f`, `f.listCount` from the authoritative set
  (`v.co`, `e.v1/v2`, `c.v`, `c.next`, `l.c`, `l.next`, `f.l`, layers).
- `validateAndRepair()` — ported in spirit from sculptcore's, which LiteMesh
  already relies on at load — recovers a corrupt or partial file. It must be
  **non-destructive on faces**: the BREP-era `validateAndRepair` killed faces
  it could not fix, which is why
  [mesh-serialize-derived-topo-plan](../../CLAUDE.md) records it as not
  reusable. Report and skip, do not delete.

Tests: the **Euler-op invariant suite** — after any random op sequence,
`rebuildDerivedTopo()` is a no-op, i.e. the live links already equal what a
rebuild produces. This single property test catches most topology bugs and is
the highest-value test in the plan.

### Step 3 — `cdt2d.ts`, ported with its tests

Port `sculptcore/source/mesh/utils/delaunay.h` (697 lines,
`constrainedDelaunay2D` at `:556`). It is already pure 2D — its only
dependencies are `float2`, `Vector`, `Set`, `span` — so the port is mechanical.

```ts
export function cdt2d(
  points: Float64Array,      // xy pairs
  constraints: Int32Array,   // ab pairs — undirected closed rings, outer + each hole
  opts?: {restoreDelaunay?: boolean; maxTris?: number}
): {tris: Int32Array; ok: boolean}
```

Port each stage, keeping the C++ function names as TS function names so the two
stay diffable:

| C++ | TS | Note |
| --- | --- | --- |
| `inCircumcircle` (`:57`) | same | floating determinant, F64 here |
| `cdtFindEdgeTri` (`:201`), `cdtOtherTri` (`:223`) | same | linear scans — see limits below |
| `cdtRecoverEdge` (`:250`) | same | constraint recovery by edge flips |
| `cdtLawsonRestore` (`:285`) | same | gated on `restoreDelaunay` |
| `cdtBuildAdjacency` (`:316`) | same | |
| `cdtFloodInterior` (`:333`) | same | **this is the hole support** |

The flood fill is the point: seeding outside the super-triangle and toggling
inside/outside on every constraint crossing classifies hole interiors as
exterior automatically, with no winding bookkeeping and no special case. Holes
fall out of the algorithm rather than being bolted onto it.

**Port `sculptcore/tests/test_constrained_delaunay.cc` (306 lines) in the same
PR**, as `tests/unit/leafmesh/cdt2d.test.ts`. The C++ vectors become the TS
fixtures; that is what keeps the two backends producing the same triangles
(design §8.1's decisive argument was parity, not code quality).

Degenerate handling is carried over deliberately, not discovered later: fewer
than 3 unique points, all-collinear input, and constraint-recovery failure each
return **empty + success**, so callers fall back rather than crash. A
self-intersecting boundary returns empty + `ok: false`.

Documented limits, in the module header:

- **No Steiner points.** Output vertices are input vertices only.
- **Quadratic inner scans.** `cdtFindEdgeTri` / `cdtOtherTri` are linear
  triangle scans and point dedup is O(n²). Fine for n-gons of tens of verts —
  the actual workload. Add the `maxTris` guard and a dev-mode warning so nobody
  discovers this by feeding it a point cloud. The fix, if ever needed, is an
  edge→triangle map localized to two functions.
- **Not exact predicates.** Adversarial input can still produce a
  valid-but-not-Delaunay triangulation. Valid is what matters.

Explicitly **not** used: `addons/builtin/mesh/src/mesh_tess.js` (BREP-built,
O(n³) constraint enforcement, and a triangle hash `a | (b<<13) | (c<<25)` that
collides above 8,192 elements) or `scripts/util/delaunay.js`. Both leave with
P13.

### Step 4 — `triangulate.ts` + `primitives.ts`

- `triangulateFace(mesh, f, out): boolean`, ported from
  `triangulate.h`'s `triangulateComplexFace` path (`:204` branches on
  `list_count != 1`): fit a plane normal over the **outer loop only** (Newell
  over ring 0 — a hole contributing to the normal flips it for large holes),
  build a 2D basis, project every loop's corners, emit one closed constraint
  ring per loop, call `cdt2d`, map each output index triple back to its
  originating `(vert, corner)` pair so per-corner attributes follow onto the
  triangles.
- Fast path from `triangulateFaceFanCb` (`:23`) + `loopIsConvex2D` (`:92`): a
  **convex single-loop** face fans directly. Fan is never the default — a fan
  over a face with holes produces silent garbage, which is precisely the
  failure mode this design exists to prevent. On `cdt2d` failure, fall back to
  a fan **and flag the face** so it is visibly wrong rather than quietly wrong.
- Per-face triangle-range cache invalidated by `topoStamp`, so a static mesh
  triangulates once.
- `primitives.ts`: plane, grid, cube, UV sphere, and a
  **cylinder-with-a-hole-in-its-cap** — the last one exists so every downstream
  consumer has a hole-bearing fixture available from day one.

## 6. Tests

Under `tests/unit/leafmesh/`, all sculptcore-free so they run in every lane.

- **CDT vectors**: the ported C++ suite, plus square-with-square-hole,
  square-with-two-holes, nested hole (island-in-hole), concave L, collinear
  input, duplicate points, self-intersecting boundary (empty + `ok: false`, not
  a throw).
- **CDT properties** on random simple polygons with holes: every output
  triangle lies inside the region; total area equals outer minus holes within
  epsilon; no triangle spans a hole; **no duplicate triangles** (the bug the
  old TS hash had).
- **Euler invariants**: `rebuildDerivedTopo()` is a no-op after any op
  sequence (step 2).
- **Winding**: `makeFace` leaves ring 0 exactly as given and reverses a hole
  ring supplied CCW (§4.1 — an outer ring has no wrong sign to correct);
  `fixWinding` reports 0 changes on a healthy face and reverses a hole once
  the face normal has flipped under it; signed area of a face with holes
  equals outer minus holes.
- **Normals**: a face with a large hole has the same normal as the same face
  without it (the outer-loop-only rule).
- **Attributes**: `interpCorner` carries UVs across `splitEdge`; `TEMP` layers
  are absent from a `compact()` snapshot.
- **Parity** (runs only when sculptcore is present, and is allowed to be
  skipped in the `--no-sculptcore` lane): the same hole-bearing face
  triangulated by TS `cdt2d` and C++ `constrainedDelaunay2D` yields the same
  triangle set. This is the test that keeps the backends honest over time; wire
  it in P11 if the harness is not available here.

## 7. Risks

- **Scope creep into modeling ops.** extrude/inset/bevel/subdivide/bridge are
  *tools* and belong in P12's toolmode, not here (design §7, §10). If a tool
  needs a new primitive, it is added here deliberately, one at a time, with a
  test. Budget breach past ~5,000 lines total is the signal.
- **The tombstone/compaction seam.** Stable indices are load-bearing for undo
  and tool state; an implicit `compact()` anywhere silently corrupts both.
  Mitigation: `compact()` returns remaps and has exactly two callers (serialize,
  GPU upload), both added in P11.
- **Port drift.** Once the TS CDT diverges from the C++ one, the parity test is
  the only thing that notices. Keep function names identical and note the C++
  line numbers in the TS module header.
- **F32 `co` in modeling ops.** Booleans-adjacent operations would want F64.
  None are in scope; revisit only if P12 hits it, and revisit as "an F64 shadow
  column", not as a storage change.

## 8. Exit criteria

- The unit suite is green, including the ported C++ CDT vectors and the
  Euler-invariant property test.
- `pnpm typecheck` covers the new directory (P1 step 3 made `addons/**` part of
  the program).
- **Nothing else in the tree references it** — `grep -rn "leafmesh" scripts/`
  returns nothing. That is the whole point of phase 0.
- Design open questions 2 and 4 are marked resolved in
  [the design doc](./2026-08-15-0248-leafmesh-design.md) §14 with a pointer
  here.
