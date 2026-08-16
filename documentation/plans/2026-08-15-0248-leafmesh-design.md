# LeafMesh — the built-in geometry type

**Status:** design. Resolves open decision #1 of
[2026-08-15-0237-faber-leaf-refactor-strategy.md](./2026-08-15-0237-faber-leaf-refactor-strategy.md).

**Date:** 2026-08-15

---

<!-- toc -->

- [1. What this is and why](#1-what-this-is-and-why)
- [2. The founding principle: faces have holes](#2-the-founding-principle-faces-have-holes)
- [3. Element model](#3-element-model)
- [4. Storage](#4-storage)
- [5. Attributes](#5-attributes)
- [6. Topology contract](#6-topology-contract)
- [7. Operations](#7-operations)
- [8. Triangulation and the CDT](#8-triangulation-and-the-cdt)
  - [8.1 Which CDT — the decision](#81-which-cdt--the-decision)
  - [8.2 Ported design](#82-ported-design)
  - [8.3 Known limits](#83-known-limits)
- [9. Sculptcore interop](#9-sculptcore-interop)
- [10. What LeafMesh deliberately lacks](#10-what-leafmesh-deliberately-lacks)
- [11. Consequences of holes across the codebase](#11-consequences-of-holes-across-the-codebase)
- [12. Layout, size, and build order](#12-layout-size-and-build-order)
- [13. Test plan](#13-test-plan)
- [14. Open questions](#14-open-questions)

<!-- tocstop -->

---

## 1. What this is and why

`LeafMesh` is Faber Leaf's built-in geometry type: a small, non-BREP,
struct-of-arrays polygon mesh with **first-class support for faces with
holes** and a constrained Delaunay triangulator.

It exists to serve four jobs at once:

1. **Make `faber-leaf-core` a real product.** After the BREP is deleted and
   sculptcore made optional, a build without sculptcore has zero geometry
   types. LeafMesh is what it models with.
2. **Be the worked example for addon authors.** It ships as an addon
   (`addons/builtin/leafmesh/`), in-bundle by default. If adding a geometry
   type requires touching anything under `scripts/`, LeafMesh will expose it
   first — it is the executable form of success criterion #7 in the strategy
   report.
3. **Be the second implementor of `IGeometrySource` / `IUVSource`.** An
   interface with one implementor is a guess. LeafMesh + LiteMesh is two.
4. **Anchor the mesh mental model.** Faces-with-holes is not an optional
   capability bolted on later; it is the shape of every face-touching API in
   the system.

The name: `SimpleMesh` is already taken by the GPU draw-batch class in
`scripts/webgl/simplemesh.ts`, so `LeafMesh` it is.

## 2. The founding principle: faces have holes

A face is **a list of loops**, not a list of vertices:

```
Face
 ├── loop 0   outer boundary   (CCW w.r.t. face normal)
 ├── loop 1   hole             (CW)
 └── loop 2   hole             (CW)
```

`listCount == 1` is the common case, not the only case. This single decision
propagates everywhere, and the propagation is the point — §11 enumerates it.
The rule that keeps it honest:

> **No API anywhere in Faber Leaf may accept or return "the vertices of a
> face" as a flat list.** Face geometry is always addressed through its loop
> list.

A flat vert list is how holes get silently dropped, and it is exactly the API
shape the old BREP encouraged. Where a flat list is unavoidable at a boundary
(OBJ import, GPU index buffers) the lossiness is documented and localized.

**This is not a novel invention — it is convergence.** Sculptcore's C++ `Mesh`
already models faces this way: `mesh.h` carries `f.l` (loop-list head),
`f.list_count`, `l.c` / `l.size` / `l.f`, and `c.next` / `c.prev` / `c.l`, and
`triangulate.h` explicitly branches on `m.f.list_count[f] != 1` to route
multi-loop faces to CDT. LeafMesh mirrors that model deliberately, which is
what makes §9 (interop) nearly free.

## 3. Element model

Five element domains, mirroring sculptcore one-for-one.

| Domain | Fields (authoritative) | Fields (derived) |
| --- | --- | --- |
| **Vert** `v` | `co: float3` | `e` (disk head) |
| **Edge** `e` | `v1`, `v2` | `c` (radial head), disk links `d1n/d1p/d2n/d2p` |
| **Corner** `c` | `v`, `next` | `e`, `l`, `prev`, `radialNext`, `radialPrev` |
| **Loop** `l` | `c` (first corner), `next` (sibling loop) | `size`, `f` |
| **Face** `f` | `l` (first loop) | `listCount` |

A **corner** is one vertex-in-one-loop incidence — the thing the old BREP
called a `Loop`, and where per-face-vertex data (UVs, vertex colors, corner
normals) lives. A **loop** here is the *ring*: a closed cycle of corners. The
naming follows sculptcore, not Blender/BMesh; the doc header of the module
says so loudly, because it is the single most likely source of confusion for
anyone coming from the deleted BREP.

Elements are addressed by **`int32` index**, never by object reference.
`ELEM_NONE = -1`. There are no `Vertex` / `Edge` / `Face` JS classes. This is
the sharpest departure from the BREP, and it is deliberate: the BREP's
dominant cost was millions of small JS objects and the GC pressure they
create. Ergonomic wrappers exist (§7) but are strictly optional views, never
storage.

## 4. Storage

Struct-of-arrays over growable typed arrays, with a per-domain freemap and
paged allocation — again mirroring sculptcore's `ElemData`.

```ts
class ElemArray {
  capacity: number
  freemap: Uint8Array          // 1 = free
  freeList: number[]
  cols: Map<string, TypedArray>
}
```

Four properties this buys, each load-bearing:

- **Zero-copy GPU upload.** `v.co` is already a `Float32Array` in vertex-buffer
  layout. No gather pass before `writeBuffer`.
- **Cheap sculptcore handoff.** Matching layout means LeafMesh ↔ sculptcore is
  a column copy, not a topology walk (§9).
- **Attributes are just columns.** Adding a layer is one allocation, not a
  mutation of every element object.
- **Flat GC pressure.** Element count no longer drives heap object count.

Allocation is paged with a `hint` parameter (allocate near a given element),
matching sculptcore's signature, so spatial locality is preserved when new
geometry is created near existing geometry.

**Deletion is tombstoned**, not compacting: `freemap[i] = 1`, index pushed to
the free list. Indices stay stable across edits, which is what lets tool
state, selection, and undo hold raw indices safely. A `compact()` pass exists
for serialization and for the GPU path; it returns the remap tables.

## 5. Attributes

Named, typed, domain-keyed layers. The type vocabulary is sculptcore's
`AttrType` verbatim (`Float`, `Float2`, `Float3`, `Float4`, `Int`, `Int2`,
`Int3`, `Int4`, `Short`, `Byte`, `Bool`) so a layer transfers between backends
with no conversion table.

```ts
mesh.attrs.add(Domain.CORNER, 'uv', AttrType.Float2)
mesh.attrs.add(Domain.FACE,   'group', AttrType.Int)
mesh.attrs.add(Domain.VERT,   'select', AttrType.Bool)
```

Conventions, matching the engine so files and code read the same on both
sides:

- `v.co` (Float3) and `v.no` (Float3) are built-in columns, not layers.
- **UVs live on the CORNER domain.** This is what makes per-face-corner UVs,
  UV seams, and hole rings in UV space representable at all.
- Selection and flags are attributes (`select`, `hide`) on their domain — not
  bitfields on element structs. This is how the host stays generic: `SelMask`
  addresses domains, and the provider maps domain → attribute.
- Layer flags mirror sculptcore's: `TEMP` (not serialized), `DERIVED`
  (rebuildable, dropped on write).

Interpolation for new geometry goes through one hook —
`interpCorner(dst, srcs[], weights[])` — so every op that creates geometry
carries attributes without each op knowing the layer list.

## 6. Topology contract

Deliberately **weaker than a BREP**, and explicit about it.

**Authoritative state** (serialized, never inferred): `v.co`, `e.v1/v2`,
`c.v`, `c.next`, `l.c`, `l.next`, `f.l`, and all attribute layers.

**Derived state** (rebuildable by `rebuildDerivedTopo()`): disk cycles,
radial cycles, `c.e`, `c.prev`, `c.l`, `l.size`, `l.f`, `f.listCount`.

Consequences worth stating:

- Serialization writes authoritative columns only. Files are smaller and
  forward-compatible with link-representation changes.
- A corrupt or partial file is recoverable: `validateAndRepair()` rebuilds
  cycles from the authoritative endpoints (ported from sculptcore's
  `validateAndRepair`, which LiteMesh already relies on at load).
- **Non-manifold is allowed.** Radial cycles are lists, not pairs. An edge may
  have 0, 1, 2, or N faces. LeafMesh makes no manifoldness guarantee and no op
  may assume one.
- A monotonic `topoStamp` bumps on every topology mutation. Caches (normals,
  triangulation, spatial) key validity on it. Same mechanism as sculptcore's
  `topo_stamp`.

## 7. Operations

The Euler-op surface is intentionally tiny. This is the whole list:

```
makeVert(co, hint?)            killVert(v)
makeEdge(v1, v2, hint?)        killEdge(e)
makeFace(loops[][], hint?)     killFace(f)       // loops[0] = outer
addFaceLoop(f, verts[])        removeFaceLoop(f, l)
splitEdge(e, t)                joinFaces(f1, f2, e)
```

Note `makeFace` takes **`loops: number[][]`** — an array of vertex rings — not
a flat vert array. The single-loop call is `makeFace([verts])`. Making the
common case one character noisier is the price of making the principle
unforgettable, and it is worth paying.

Everything else (extrude, inset, bevel, subdivide, bridge) is **not** in
LeafMesh. Those are modeling *tools* and belong in a toolmode addon built on
this surface. If a tool needs a new primitive, the primitive is added here
deliberately, one at a time, with a test.

Optional ergonomic wrappers (`VertRef`, `FaceRef`) provide `for (const c of
mesh.faceCorners(f))`-style iteration over indices. They are views over the
arrays, allocation-free where possible, and no internal code path depends on
them.

## 8. Triangulation and the CDT

### 8.1 Which CDT — the decision

**Port sculptcore's C++ CDT to TypeScript. Do not reuse the existing TS one.**

I read both. The existing TS CDT is `addons/builtin/mesh/src/mesh_tess.js`
(class `CDT`, ~1,100-line file), and it is not a candidate:

- **It is built on the BREP.** `constrain()` does `let me = new Mesh()` and
  drives the whole algorithm through `makeVertex` / `makeEdge` / `makeFace`,
  radial cycles (`l.radial_next`), and `MeshFlags.TEMP2/TEMP3`. It cannot
  survive the deletion of the thing it is built on. Porting it off the BREP is
  a rewrite, not a move.
- **The complexity is wrong.** Constraint enforcement is a triple loop —
  `for (si < edges.length>>1) { for (e1 of me.edges) { for (e2 of me.edges) …
  line_line_cross … } }` — i.e. O(n³) with a `util.set` allocated per inner
  iteration.
- **It has a live correctness bug.** The triangle hash is
  `a | (b << 13) | (c << 25)`, which collides above 8,192 elements and
  overflows into the sign bit past ~128. Duplicate-triangle detection silently
  fails on any non-trivial input.
- It depends on `scripts/util/delaunay.js`, an unmodified copy of the classic
  Bowyer-Watson gist (`234` lines, array-of-arrays points, `throw new
  Error('Eek! Coincident points!')`).

Sculptcore's `source/mesh/utils/delaunay.h` (697 lines) is a different class
of artifact:

- `constrainedDelaunay2D(points, constraints, out_tris, restore_delaunay)` is
  **already pure 2D** — its only dependencies are `float2`, `Vector`, `Set`,
  `span`. It has no `Mesh` dependency at all, so the port is mechanical.
- It is a complete CDT: Bowyer-Watson → constraint recovery by edge flips
  (`cdtRecoverEdge`) → Lawson restore (`cdtLawsonRestore`) → adjacency
  (`cdtBuildAdjacency`) → **parity flood-fill from the super-triangle**
  (`cdtFloodInterior`).
- **That flood-fill is the hole support.** Seeding from outside and toggling
  inside/outside on every constraint crossing classifies hole interiors as
  exterior automatically, with no winding-order bookkeeping and no special
  case. Holes are not a feature added to this algorithm; they fall out of it.
- Degenerate handling is deliberate and documented: <3 unique points,
  all-collinear input, and constraint-recovery failure each return empty +
  success, so callers fall back rather than crash.
- It is already tested — `tests/test_constrained_delaunay.cc` (306 lines).

The decisive argument is not code quality, though: it is **parity**. Two
backends triangulating the same face two different ways means two different
silhouettes, two different UV layouts, and two sets of test fixtures. One
ported algorithm means `faber-leaf-core` and the sculptcore build produce
identical triangles, and the C++ test vectors port over as the TS test
fixtures. That is worth far more than the ~600 lines the port costs.

### 8.2 Ported design

Two layers, mirroring the C++ split.

**Layer 1 — `cdt2d.ts`, pure and dependency-free.**

```ts
/** Constrained Delaunay of a 2D region, possibly with holes. No Steiner
 *  points. `constraints` are undirected closed rings: outer plus each hole.
 *  Returns flat CCW index triples into `points`; exterior and hole interiors
 *  are dropped. Empty result + ok on degenerate or unrecoverable input. */
export function cdt2d(
  points: Float64Array,        // xy pairs
  constraints: Int32Array,     // ab pairs
  opts?: {restoreDelaunay?: boolean; maxTris?: number}
): {tris: Int32Array; ok: boolean}
```

No mesh dependency, no host dependency, independently testable, reusable by
the UV editor for island triangulation. **`float2` becomes `Float64Array`** —
JS numbers are doubles anyway, and the extra precision makes the
`inCircumcircle` determinant meaningfully more robust than the C++ original
for free.

**Layer 2 — `triangulate.ts`, mesh-aware.**

```ts
export function triangulateFace(mesh: LeafMesh, f: number, out: Tri[]): boolean
```

Ported from `triangulateComplexFace`: fit a plane normal over the **outer loop
only**, build a 2D basis, project every loop's corners, emit one closed
constraint ring per loop, call `cdt2d`, then map each output index triple back
to its originating `(vert, corner)` pair so per-corner attributes follow onto
the triangles.

Fast path, ported from `triangulateFaceFanCb` + `loopIsConvex2D`: a
single-loop convex face fans directly. Everything else — any face with
`listCount > 1`, and any concave face — goes through CDT. **Fan is never the
default.** A fan over a face with holes produces silent garbage, which is
precisely the failure mode this design exists to prevent.

**Caching.** Each face caches its triangle range, invalidated by `topoStamp`.
Draw-batch construction consumes the cache, so a static mesh triangulates once.

### 8.3 Known limits

Carried over from the C++ and to be documented in the module header, not
discovered later:

- **No Steiner points.** Output vertices are input vertices only. A constraint
  configuration that cannot be recovered by flipping (a vertex lying exactly
  on a constraint segment, a self-intersecting boundary) returns empty; the
  caller falls back to a fan and flags the face. Acceptable for face
  triangulation; not a general-purpose meshing kernel.
- **Quadratic inner scans.** `cdtFindEdgeTri` / `cdtOtherTri` are linear
  triangle scans, and point dedup is O(n²). Fine for n-gons of tens of verts —
  the actual workload. Add a `maxTris` guard and a dev-mode warning so nobody
  discovers this by feeding it a point cloud. If a large-input use case ever
  appears, the fix is an edge→triangle map, localized to two functions.
- **Not exact predicates.** `inCircumcircle` is a floating determinant, not
  Shewchuk. The doubles help; adversarial input can still produce a
  non-Delaunay-but-valid triangulation. Valid is what matters here.

## 9. Sculptcore interop

Because the element models match, conversion is a column copy plus index
remap, not a topology rebuild:

```ts
leafMeshToSculptcore(mesh: LeafMesh): Mesh   // engine-side
sculptcoreToLeafMesh(m: Mesh): LeafMesh
```

Attribute layers transfer by name and type with no conversion table (§5).
Faces with holes survive the round trip in both directions, because both sides
model them natively.

This unlocks the workflow that makes the whole optional-sculptcore story
coherent:

- `faber-leaf-core` models with LeafMesh and never loads the engine.
- The full build models in LeafMesh, converts to sculptcore to sculpt,
  converts back. The conversion is the seam, and it is cheap and lossless.
- Files written by either build load in the other, modulo sculpt-specific
  layers which `missing_addon.ts` round-trips opaquely.

Worth stating plainly: this is the payoff for mirroring sculptcore's model
rather than inventing a new one. A "simpler" bespoke structure would have
bought nothing and cost this.

## 10. What LeafMesh deliberately lacks

Enumerated so scope creep is visible when it happens:

- No BVH — the host's `util/spatial.ts` `GenericIsect` covers ray/nearest.
- No dyntopo, multires, grids, or displacement. Those are sculptcore's.
- No subdivision surfaces.
- No mesh log / delta undo. Snapshot undo; LeafMesh meshes are small by
  construction, and if a mesh is big enough to need delta undo it belongs in
  sculptcore.
- No solvers, remeshers, curvature, or parameterization *in the core module*.
  (UV unwrapping is ported per strategy-report decision #6, but it lands as a
  separate module consuming `IUVSource`, not as part of LeafMesh.)
- No modeling tools (§7).

**Target size: 3,500–4,500 lines**, against 63,059 for the BREP it replaces.
If a PR pushes past ~5,000, that is the signal to ask whether the addition
belongs in a toolmode addon instead.

## 11. Consequences of holes across the codebase

The principle only holds if every consumer respects it. Each of these is a
review checkpoint:

1. **`IGeometrySource` exposes `forEachFaceLoop(f, cb)`**, never
   `getFaceVerts(f)`. The flat accessor does not exist, so it cannot be
   misused.
2. **Normals come from the outer loop only.** Newell over ring 0. A hole
   contributing to the face normal flips it for large holes. Unit-tested.
3. **Area and centroid subtract holes.** Signed-area accumulation over all
   rings gives this for free provided hole winding is enforced (§14 Q2).
4. **Triangulation is CDT by default** (§8.2). Fan only for convex
   single-loop.
5. **`IUVSource.readUVs` returns ring boundaries**, not just corner data, so
   the UV editor can draw hole rings and unwrapping can treat them as
   boundaries. This directly shapes the W4 interface in the strategy report —
   worth landing before that interface is frozen.
6. **Serialization writes the loop list.** Hole topology round-trips.
7. **Selection of a face selects all its rings.** Ring-level selection is not a
   concept; a hole is not independently selectable.
8. **Import/export is lossy at the boundary and says so.** OBJ has no hole
   concept: import produces single-loop faces; export triangulates (default) or
   emits bridged loops (opt-in). Documented at the call site, not buried.
9. **GPU index buffers are triangles**, so holes are already resolved by the
   time anything reaches a draw batch. No special case downstream.

## 12. Layout, size, and build order

```
addons/builtin/leafmesh/
├── manifest.json            # id: leafmesh, dependencies: [], buildMode: prebuilt
└── src/
    ├── main.ts              # register() — DataBlock, data kind, API contributions
    ├── api.ts               # public surface for @addon/leafmesh/api
    ├── leafmesh.ts          # LeafMesh DataBlock, SceneObjectData impl        ~900
    ├── elem_array.ts        # SoA storage, freemap, paged alloc               ~400
    ├── attrs.ts             # attribute layers + interpolation                ~450
    ├── topo.ts              # Euler ops, rebuildDerivedTopo, validateAndRepair ~700
    ├── cdt2d.ts             # ported constrainedDelaunay2D — pure 2D          ~450
    ├── triangulate.ts       # face → tris, plane fit, fan fast path           ~300
    ├── draw.ts              # DrawQueue submission, GPU buffer build          ~350
    ├── pick.ts              # castViewRay / findNearest / circle / rect       ~300
    ├── uv_source.ts         # IUVSource implementation                        ~250
    ├── serialize.ts         # nstructjs read/write of authoritative columns    ~250
    └── primitives.ts        # cube, plane, grid, sphere, cylinder-with-hole    ~200
```

It is an **addon with zero dependencies**, in-bundle in the default
distribution. Nothing under `scripts/` imports it, which is what keeps
`core-no-addons` enforceable at `severity: error` and makes LeafMesh the proof
that the addon path is sufficient.

Build order within refactor phase 5–6:

1. `elem_array.ts` + `attrs.ts` + `topo.ts` — headless, unit-tested, no host
   dependency.
2. `cdt2d.ts` — port with the C++ tests ported alongside, in the same PR.
3. `triangulate.ts` + `primitives.ts` — first visible geometry.
4. `leafmesh.ts` + `draw.ts` — it renders.
5. `pick.ts` — it is selectable; validates `IGeometrySource`.
6. `serialize.ts` — it round-trips.
7. `uv_source.ts` — validates `IUVSource`; unblocks W4's second implementor.

Steps 1–3 have no dependency on the rest of the refactor and can start
immediately, in parallel with phase 2 (deleting the TS sculpting stack).

## 13. Test plan

- **`cdt2d` vector tests** ported from `tests/test_constrained_delaunay.cc`,
  plus: square-with-square-hole, square-with-two-holes, nested-hole rejection,
  concave L, collinear input, duplicate points, self-intersecting boundary
  (must return empty + `ok: false`, not throw).
- **Property tests** on random simple polygons with holes: every output
  triangle is inside the region; total area equals outer minus holes within
  epsilon; no triangle spans a hole; no duplicate triangles (the bug the old
  hash had).
- **Euler-op invariants**: after any op sequence, `rebuildDerivedTopo()` is a
  no-op — the live links already match what a rebuild produces. This one test
  catches most topology bugs.
- **Round-trip**: LeafMesh → serialize → load → identical authoritative state,
  holes included.
- **Interop**: LeafMesh → sculptcore → LeafMesh is identity on topology and
  attributes, for a mesh with holes. Runs only when sculptcore is present.
- **Parity**: the same hole-bearing face triangulated by TS `cdt2d` and by the
  C++ `constrainedDelaunay2D` yields the same triangle set. This is the test
  that keeps the two backends honest over time.

## 14. Open questions

1. **Does LeafMesh keep disk/radial cycles live, or rebuild on demand?**
   Sculptcore supports both (`freezeTopo`/`thawTopo`). Recommend: live by
   default, with the derived columns dropped on serialize. Add freezing only
   if profiling asks.
2. ~~**Is hole winding enforced or inferred?**~~ **Resolved in P3** — enforced
   on `makeFace` / `addFaceLoop`, with `fixWinding()` for importers. The face
   normal is Newell's over ring 0, so ring 0 is CCW by definition and is never
   reordered; only holes are forced CW. See
   [the P3 plan](2026-08-15-0310-leafmesh-core-storage-topo-cdt.md) §4.1.
3. **Do nested holes (island-in-hole) need support?** The parity flood-fill
   handles them correctly for free. Recommend: allow, test, do not advertise.
4. ~~**`Float64Array` or `Float32Array` for `v.co`?**~~ **Resolved in P3** —
   `Float32Array` for `v.co` (zero-copy GPU upload, matching sculptcore's
   layout), `Float64Array` inside `cdt2d` where the predicates need it. See
   [the P3 plan](2026-08-15-0310-leafmesh-core-storage-topo-cdt.md) §4.2.
