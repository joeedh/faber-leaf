# P11 — LeafMesh host integration

**Status:** in progress — step 1 landed 2026-08-18 (see §4a).

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

## 4a. Step 1 as landed (2026-08-18)

`manifest.json`, `src/main.ts`, `src/api.ts`. `register(api)` publishes the
namespace and calls `registerDataKind({id: 'leafmesh', uiName: 'Leaf Mesh'})` —
no `factory`, no `capabilities`, no `vertexAttrs`, because there is no data
class yet to claim them for. Those fields grow with steps 2 and 4.

**LeafMesh ships external, not in-bundle.** This plan did not pin it and the
design doc §12 said "in-bundle in the default distribution", which is now
corrected there to match. The two builtin flavours are not interchangeable: an in-bundle builtin is statically
imported by `addons/builtin/builtin_registry.ts` and compiled into the main
bundle; an external one is its own `build/addons/<id>/` esbuild build,
dynamic-imported at runtime and listed in `build/addons/index.json`. The
in-bundle set exists for the *duplication-unavoidable* subsystems — mesh and
sculptcore are in the main bundle because the app's `data_api` eagerly imports
them — and LeafMesh is the opposite of that: a leaf with no host imports at all.

External is also the stronger criterion-12 proof, and mechanically so rather
than by assertion. Its bundle's esbuild metafile lists exactly eight inputs,
every one of them `addons/builtin/leafmesh/src/*`, and `'leafmesh'` was added to
`EXTERNAL_IDS` in `tools/check-addon-duplication.js` so the build fails if any
leafmesh module ever also lands in the main bundle. A module that cannot be in
the main bundle cannot reach `scripts/` by relative path.

Consequences worth knowing before step 2:

- **It needs a build.** `pnpm build` runs `tools/build-addons.js`, but a bare
  `node tools/esbuilder.js`-only workflow will leave `build/addons/leafmesh/`
  stale. Rebuild addons after touching anything under `src/`.
- **`--include-fixtures`.** `node tools/build-addons.js` alone drops
  `api_consumer` and `test_addon` from `index.json` and breaks their suites; the
  flag is not optional in a checkout that runs the addon tests.
- **`defaultEnabled: false`**, matching every other builtin. Tests enable it
  explicitly. P13 is where the default flips, if it ever does.

Verified by booting NW.js headless (`--apptest-headless --app-storage-dir <tmp>
--eval … --dump`): `leafmesh` appears in `mgr.addons` with `dependencies: []`,
`mgr.enable('leafmesh')` returns `{ok: true}` (so `register()` and
`registerDataKind` did not throw), and `api.exports.leafmesh` carries the same
19 value exports `src/api.ts` re-exports. `git diff --stat scripts/` empty;
`pnpm check:layers` unchanged (all ten rules at delta 0); `npx tsgo --noEmit`
clean.

**No contract gap found.** Nothing under `scripts/` had to change for a
zero-dependency addon to register a data kind, which is P8's `registerDataKind`
hook and P7's `IDataKindDescriptor` doing exactly their job.

## 4b. Step 2 as landed (2026-08-18)

`src/leafmesh.ts` (~560 lines, under the ~900 budget) holds `LeafMeshData
extends SceneObjectData`, and `LEAFMESH_CAPABILITIES` — the single list both
`main.ts`'s descriptor and the file's own `AssertExtends` block read, so a
claimed-but-unimplemented capability cannot compile. All seven optional
capabilities are claimed: `ELEMENTS`, `INVALIDATION`, `SPATIAL`, `ATTRIBUTES`,
`TRIANGLES`, `SYMMETRY`, `ACTIVE_ELEMENT`.

Decisions worth recording:

- **Selection is an attribute layer**, `.select`, one Byte column per domain,
  created on first write. It stays out of `topo.ts` (selection is a host
  concept, not a topological one) and gets persistence for free from §5's
  column writer, since it is an ordinary non-`TEMP` layer.
- **The two vocabularies are cast, not converted.** leafmesh's `Domain` /
  `AttrType` and the host's `ElementDomain` / `AttrType` are numerically
  identical by design, so an attribute layer round-trips as a column copy. TS
  enums are nominal, so the agreement is not expressible as a compile-time
  assertion; `tests/unit/leafmesh/contract_vocabulary.test.ts` pins it at
  runtime instead. Both modules are import-safe under jest — `geometry_contract`
  has type-only imports — so this is a plain unit test, not an integration one.
- **`closestElements` is brute force.** The contract exposes the query and never
  the structure, so an acceleration tree can land later without touching a
  caller.
- **`getPositions` on a non-vertex domain returns the element centre**, and
  `setPositions` translates by the centre delta — the only reading of "move this
  face" that does not also reshape it.
- Two additions to P3 files, both addon-local: `ElemArray.copyFrom(src)`
  (column-wise clone, matching by name) and `LeafMesh.copy()` / `get arrays()`,
  which `LeafMeshData.copy()` needs. `copy()` preserves handles rather than
  compacting, because callers hold them.

`leafmesh.ts` is **not** unit-testable: `tests/jest.config.ts` has no
`moduleNameMapper` entry for `@framework/*`. Its verification is therefore
`npx tsgo --noEmit` plus the in-file `AssertExtends` block plus a headless
NW.js probe.

Verified by that probe (`--apptest-headless --eval … --dump`), on a `makeCube`
of size 2: `hasCapability` true for all seven; 8 verts / 12 edges / 6 faces;
bounding box `[-1,-1,-1] … [1,1,1]`; 12 triangles with 24 vertex normals;
`listAttributes(VERT)` reporting the lazily-created `.select`; face centre
`[0,0,-1]`; `closestElements(origin, 10, FACE)` returning all 6; active-element
round-trip; and `copy()` yielding a real `LeafMeshData` that carries the
selection and is independent of its source. `dataDefine()` reports kind
`leafmesh`, select-type name `LEAFMESH`, and a registry-allocated mask of
`65536` (`1 << 16`, per P6).

`git status --porcelain scripts/` empty after `pnpm gen:paths` — the generated
path catalogue does not enumerate addon block types, so registering a kind does
not dirty `scripts/`. `pnpm check:layers` unchanged (all ten rules at delta 0).
Unit suites 34/34, 328 tests. The integration package's one failure
(`sculptcore_gpu_brush`, native, `rel = 0.0156…`) is pre-existing and was proved
independent by an A/B run with the leafmesh entry stripped from
`build/addons/index.json`.

**No contract gap found.** P7's interfaces were implementable as written, and
P8's `registerDataKind` took `factory` / `capabilities` / `usesMaterial` without
extension.

## 4c. Step 3 as landed (2026-08-18)

`src/serialize.ts` (278 lines) is the blob; `leafmesh.ts` gained the field that
carries it into a `.wproj`, plus the `serialize()` hook behind it and a
`loadSTRUCT` that rehydrates the mesh and drops the carrier:

```
leafmesh.LeafMeshData {
  _data        : arraybuffer(byte) | this.serialize();
  symmetryAxes : int;
}
```

**Layout.** A 16-byte header (two magic words, a version, a reserved word), five
element counts, then the authoritative columns in a fixed order — `v.co`,
`e.v1`, `e.v2`, `c.v`, `c.next`, `l.c`, `l.next`, `f.l` — then a layer count and,
per layer, `(domain, type, flags, ctorTag)`, `(size, 0)`, an f64 fill, a
length-prefixed name, and the column data. Everything is kept 4-byte aligned so a
column is a bulk copy rather than a `DataView` loop; the reader copies out of the
blob rather than viewing into it, because the `Uint8Array` nstructjs hands back
carries no alignment guarantee of its own. Byte order is the host's, as it is for
LiteMesh's engine blob.

Decisions worth recording:

- **Dense on disk, live mesh untouched.** §5 originally said to `compact()`
  before writing; that bullet is corrected in place. Saving must not move an
  element out from under a handle holder, so `denseOrder()` builds the same remap
  table `compact()` would and the writer gathers through it.
- **The fill is written as an f64**, not packed into the u32 header words
  alongside the layer's domain/type/flags/width. A column's fill is an ordinary
  `number` and is routinely fractional; a `0.5` mask fill truncates to `0` the
  moment it goes through an integer field, and every page allocated lazily
  afterwards is then wrong. `tests/unit/leafmesh/serialize.test.ts` pins that
  case specifically.
- **A layer's width is checked, not trusted.** On load the layer is re-declared
  through `attrs.add(...)`, which owns the width for a known name; if the file
  disagrees the load throws rather than reinterpreting the bytes.
- **Only `persistentLayers()` are written**, which is where the `TEMP` exclusion
  §5 asks for already lives — so the LiteMesh failure mode (spatial `.node`
  attributes bloating and then corrupting files) is structurally unavailable.
- **`loadSTRUCT` clears the active and highlight handles.** The file is
  renumbered on the way in, so a saved handle would name a different element.
  Selection survives because it is an ordinary attribute layer (§4b), not a
  handle.
- **An empty or truncated `_data` loads as an empty mesh**, not as a throw: the
  file still opens and the block is visibly empty rather than absent.

**Tests.** `tests/unit/leafmesh/serialize.test.ts`, 7 tests: a cube round-trips;
a hole-bearing face keeps both rings, in order; tombstones never reach the file;
attribute layers survive and `TEMP` ones do not; a `0.5` float fill survives; an
empty mesh round-trips; and a foreign blob and a future version each throw with a
distinguishable message.

**Probe.** End to end through `.wproj` with the addon *absent* in the middle —
build a cube with a corner `uv` layer, a vertex selection and `symmetryAxes = 5`;
save; disable `leafmesh`; load (the block parks as a `MissingDataBlock`, 1023
bytes, `lib_id` kept); re-save while parked; re-enable; load. Result: the block
comes back as a real `LeafMeshData` on its original object, 8 verts / 12 edges /
6 faces, `uv[0] == 0.25`, `symmetryAxes == 5`, selection `[0,1,2]`, 12 triangles,
`validateAndRepair()` returning 0.

**Two host defects found — both P10's, neither a P7/P8 contract gap.** The probe
above failed twice before it passed, in `AddonAPI.unregisterAll` and in the
`MissingDataBlock` save path. Neither fix contains anything LeafMesh-shaped —
the teardown bug was reproduced against `curve` and `mesh` unchanged — so §2's
rule does not apply: this is not a host change made to accommodate a new geometry
type, it is a bug in the previous phase that a new geometry type was the first to
walk into. They are recorded and fixed as a **P10 commit**, under §11 of
[2026-08-15-0345-serialization-and-file-compat-hardening.md](2026-08-15-0345-serialization-and-file-compat-hardening.md),
so P11's own diff keeps `scripts/` empty per criterion 12. `file_compat.test.ts`
gained the enable/disable cycle that would have caught them.

## 4d. Step 4a as landed (2026-08-18) — flat render

Two modules, split on whether they can see the host:

- `src/draw_buffers.ts` (190 lines) — pure CPU, imports nothing from `scripts/`,
  so plain jest can exercise it. Flattens the triangulation into **unshared
  triangle corners**: `buildDrawGeometry` (position + normal, `triCount * 9`
  floats each), `recalcVertexNormals` (area-weighted, into the derived `v.no`
  column `topo.ts` declares but never fills), and `gatherDrawAttr` /
  `resolveDrawAttr` / `drawAttrNames` for the attribute half.
- `src/draw.ts` (200 lines) — `LeafMeshDrawable implements Drawable`. Owns one
  CPU array and one `GPUBuffer` per slot, binds slot 0 = position, 1 = normal,
  and (step 4b) any requested attribute at the slot the shader generator
  assigned.

`leafmesh.ts` gained `get drawable()`, `drawQ`, and the two lifecycle overrides
that free the buffers (`onContextLost`, `destroy`); `invalidate()` forwards
TOPOLOGY | POSITIONS | ATTRIBUTES to the drawable. `main.ts` declares
`vertexAttrs: LEAFMESH_VERTEX_ATTRS` on the kind descriptor.

Decisions worth recording:

- **Unshared corners, not an index buffer.** An attribute layer may live on any
  domain — a UV on a corner, a material index on a face — and one shared vertex
  cannot carry two values of one attribute. Three vertices per triangle costs
  memory and buys a single gather routine that is correct for every domain.
- **LeafMesh brings its own `Drawable` rather than filling a `SimpleMesh`.**
  `SimpleIsland.drawGPU` binds a fixed buffer per layer *type* — uv at slot 2,
  colour at 3 — and a material's `AttributeNode` reads start at slot 2 as well.
  That collision is the first entry under
  [geometry-contract.md](../geometry-contract.md) §11, which says the fix
  belongs to whatever replaces the BREP mesh, not to this plan. Binding by name
  at the slot the generator assigned sidesteps it entirely.
- **No host edit was needed to get a device.** `WebGPUDrawQueueAdapter.submit`
  already calls a duck-typed `_uploadGpuBuffers(device)` on the submitted mesh
  and pre-binds a shared zero buffer to every pipeline slot the mesh does not
  supply, so an addon `Drawable` is a first-class citizen of the queue as it
  stands. The underscore is the adapter's name for the hook, not ours.
- **`vertexAttrs` stops at the base pair.** Everything past slot 1 follows the
  *material*, not the geometry (geometry-contract §10.2), so the kind descriptor
  declares position and normal and nothing else.
- **`camera.ts:163,165` did not surface.** §7 asked for a report if the
  `scheduleRawGLPass` throw appeared here; it did not — P8's call-site fix
  holds.

**Tests.** `tests/unit/leafmesh/draw_buffers.test.ts`, 16 tests: a quad
flattens to unshared corners; every corner position matches its vertex; an
empty mesh yields empty buffers; a flat grid gets unit +z normals and a cube
gets outward ones; area weighting favours the larger triangle; corner beats
vertex in name resolution; a missing name gathers to `undefined`; vertex, face
and corner layers each gather onto the right element; a narrow layer zero-fills
with w = 1 and a wide one truncates; a `Byte` layer is copied numerically
rather than normalized; and `drawAttrNames` skips dot-prefixed and boolean
layers and deduplicates across domains.

**Probe.** Headless NW.js, WebGPU up: empty the scene to one light, render and
capture; add a size-4 LeafMesh cube, render and capture again; diff. **60,627
pixels changed** (3.1% of a 1745×1122 canvas), mean colour of the changed
region **(97, 97, 97)** — lit grey, which is exactly what `BASIC_LIT_MESH_WGSL`
produces with vertex colour `#ifdef`-ed out. `drawable.triCount === 12` for the
cube's six quads.

**One contract gap, G1 below** — the WebGPU usage-flag constants were not on the
hub. Fixed as its own P7 commit, so this step's diff keeps `scripts/` empty per
criterion 12.

## 5. Serialization

- **Authoritative columns only.** `v.co`, `e.v1/v2`, `c.v`, `c.next`, `l.c`,
  `l.next`, `f.l`, plus every non-`TEMP`, non-`DERIVED` attribute layer. Disk
  and radial cycles, `c.e`, `c.prev`, `c.l`, `l.size`, `l.f` and `f.listCount`
  are rebuilt by `rebuildDerivedTopo()` on load (P3). (This list said
  `f.listCount` was authoritative; it is not — `topo.ts:975`, inside
  `rebuildDerivedTopo`, recomputes it from the loop ring. Corrected 2026-08-18.)
- **Dense on disk, but do not compact the live mesh.** (This bullet said
  "compact before writing", calling `compact()` on the mesh being saved.
  Corrected 2026-08-18: saving is not allowed to move an element out from under
  a handle holder — a toolmode's active element, an undo step, a modal
  operator's cached indices — and `compact()` does exactly that. `serialize.ts`
  builds the same remap table `compact()` would, uses it to write dense columns,
  and leaves the mesh alone. The file still never carries tombstones.)
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
  (`renderengine_realtime.ts:713`, `view3d_draw_webgpu.ts:494` — the plan's
  2026-08-15 line numbers, 708/490, drifted by the P7/P8 commits). That is
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

1. ~~`manifest.json` + `main.ts` + `api.ts`; register nothing but the kind
   descriptor. Confirm the app boots and the addon appears in the addon
   list.~~ **Done 2026-08-18 — see §4a.**
2. ~~`leafmesh.ts` — DataBlock + `SceneObjectData`, against P7's interfaces.
   Compile before implementing: the type errors are the contract's to-do
   list.~~ **Done 2026-08-18 — see §4b.**
3. ~~`serialize.ts` — round-trip a primitive from P3 through `.wproj`.~~
   **Done 2026-08-18 — see §4c.**
4. `draw.ts` — flat render first, then the attribute-driven material (§7).
   Flat render **done 2026-08-18 — see §4d**; the attribute-driven half is the
   second half of this step.
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

## Contract gaps (found 2026-08-18)

Per §2, each entry is: what LeafMesh needed, which host file would otherwise
have been special-cased, and how P7/P8 was extended instead.

### G1 — WebGPU usage-flag constants were not on the hub

**Needed.** A provider that brings its own `Drawable` creates its own vertex
buffers, so it calls `device.createBuffer({usage: VERTEX | COPY_DST})`. The TS
DOM lib in use declares `GPUBufferUsage` as a *type* and not as a runtime
value, which is why `scripts/webgpu/flags.ts` mirrors the spec-fixed numbers in
the first place.

**Would have been special-cased as.** A second private copy of the same
constants inside `addons/builtin/leafmesh/src/draw.ts` — spec-fixed, so it
would have worked, and would have been the addon quietly re-deriving a host
primitive rather than importing one.

**Fixed in P7 as.** `framework_api.ts` re-exports `BufferUsage`, `TextureUsage`,
`ShaderStage` and `MapMode` from `scripts/webgpu/flags.js`. The hub rule in
CLAUDE.md already covers this case — "if a symbol is missing from the hub, add
it there" — and every addon that draws needs them, not just this one.
