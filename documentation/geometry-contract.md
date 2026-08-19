# The host geometry contract

**Status:** normative. Landed by P7 (W1b), plan
[`plans/2026-08-15-0330-w1-host-geometry-contract.md`](plans/2026-08-15-0330-w1-host-geometry-contract.md).

This document defines everything the host is permitted to ask of geometry, and
everything a geometry provider must supply to be a first-class citizen of the
scene. It is the contract that lets a geometry type live in an addon.

The TypeScript lives in two files, and the split is itself part of the contract:

- [`scripts/core/geometry_contract.ts`](../scripts/core/geometry_contract.ts) — the
  vocabulary and the optional capabilities (§3–§7). **It imports nothing** but
  `path.ux` vector types. A module that constrains the host must not reach into
  it; keeping the imports at zero is what makes that checkable rather than
  aspirational.
- [`scripts/sceneobject/sceneobject_base.ts`](../scripts/sceneobject/sceneobject_base.ts) —
  the required surface (§2), because it is the only half that must name host
  types (a viewport, a draw queue, a pick result) and that file already imports
  every one of them to declare `SceneObjectData`. Declaring them anywhere else
  duplicates the whole host-facing import set into a second core module, which
  `pnpm check:layers` charges for as new cycles.

This document is the *why*; those files are the *what*, and they carry doc
comments pointing back at each host call site.

Conformance is a typecheck. `AssertExtends<T, U>` (exported from
`geometry_contract.ts`) fails to compile unless `T` really satisfies `U`;
`SceneObjectData`, `Mesh`, and `LiteMesh` each carry one next to their
declaration. Because §2 was derived from `SceneObjectData`, every subclass
conforms for free — the assertions exist to catch drift in either direction, a
base method that changes shape or a contract clause no provider supplies.

---

## 0. The rule

> **When the host needs to know something type-specific, it asks the registry,
> never the type.**

Every rule below is a restatement of that one. `instanceof` becomes a registry
lookup or a method. A hardcoded list of type names becomes a registration. A
hardcoded vertex layout becomes a layout derived from a declared attribute set.

A corollary that is easy to miss: **this document must be readable without
knowing which geometry types exist.** If a capability cannot be described
without naming one, it is not yet a contract. Concrete type names appear here
only in §12, and in call-site citations where the code being cited names them.

## 1. Who may implement it

```
Layer 1 (host)     defines these interfaces, calls them, and knows nothing else
Layer 2 (addons)   implement them, and register through AddonAPI
```

The host may not import a provider. A provider may not reach around the
contract into host internals. Both directions are enforced by
`pnpm check:layers`.

A provider is **not** obliged to implement everything here. §2's four groups are
required; §3's are optional and feature-detected. A provider that implements
only the required groups is a valid, useful provider: it appears in the outliner,
renders, picks, transforms as a whole object, saves, and loads. What it loses by
declining the optional groups is sub-object editing, not membership.

## 2. Required: what every geometry provider supplies

### 2.1 The kind descriptor

Static data, held by the registry, read *before* the host decides whether to
call the instance at all. This is deliberately data and not a method table — the
host must be able to answer "can this scene contain a thing that does X" without
instantiating anything.

| Field | Meaning |
| --- | --- |
| `id` | Stable string, written into save files. Never change it; add a migration instead. |
| `uiName` | Human-readable label for menus. |
| `factory` | Constructs an empty instance. |
| `selectTypeName` | The name of this kind's `SelMask` bit. The select-type registry allocates the number; **the number is never persisted** (see [select_types](../scripts/core/select_types.ts)). |
| `importExtensions` / `importFromBytes` | Optional file-import hook. |
| `usesMaterial` / `materialSlotPolicy` | Whether the kind participates in material slots, and whether slots are per-object or per-element. |
| `attributes` | The declared attribute set — see §10. This is what makes attribute-driven materials work for the kind. |
| `capabilities` | The set of optional capabilities (§3) this kind claims. |

`capabilities` is what gates UI. A tool that needs per-element selection must not
appear enabled for a kind that has not claimed `ELEMENTS`; discovering the gap by
calling a method and catching a throw is not acceptable, because by then the menu
item has already been drawn.

**Host call sites:** `core/data_kinds.ts:1-57`; `sceneobject_base.ts:394,428`;
`context.ts:226,323,372`.

### 2.2 Instance core

The per-instance surface the host calls every frame or every edit.

- **Bounds.** A world-space AABB. Everything from frustum culling to
  frame-selected to fallback picking rides on this, so a provider that cannot
  compute a tight box must still return a correct conservative one — a wrong box
  is worse than a loose box.
- **Transform.** `applyMatrix` bakes a matrix into the provider's own
  coordinates. Distinct from the scene-object matrix, which the host owns.
- **Draw submission.** Four entries: main draw, wireframe, selection outline,
  and id-buffer paint. All go through the draw queue; none of them may touch a
  device directly. See the caveat in §11.
- **Picking.** Four entries: ray cast, nearest-to-point, screen circle, screen
  rectangle. Each receives a select mask and must return nothing when the mask
  does not include a bit it owns. The base implementations answer at
  whole-object granularity from the bounding box, so a provider gets object-level
  picking for free and overrides only for sub-element picking.
- **Selection state.** Which of the provider's own `SelMask` bits are set.

**Host call sites:** `sceneobject_base.ts:163,191,196,230,284,315,356,358,362,364`
and `:77`.

**Undo is deliberately absent.** A geometry provider does not implement undo.
The host's undo runs through the transform contract (§8) and through
tool-specific snapshots taken by the editors; `SceneObjectData` has no undo
surface at all and must not grow one. This was a documented error in the
strategy doc's §3 through 2026-08-16 and is corrected here: what a provider owes
undo is that its state be reachable through the other groups, not that it manage
history.

### 2.3 Datablock lifecycle

`copy`, `copyAddUsers`, `dataLink`, `destroy`, `swapDataBlockContents`,
`onContextLost`. Almost all of this is inherited `DataBlock` behaviour; a
provider overrides only where it holds resources the base class cannot see —
GPU buffers, WASM allocations, worker handles.

`onContextLost` is the one most often forgotten and the one whose absence is
invisible until a device reset. A provider holding any GPU resource must
implement it.

**Host call sites:** `sceneobject_base.ts:159,368,370`;
`sceneobject.ts:269,364-380,410-417`.

### 2.4 Graph participation

Every provider is a node in the dependency graph: a `depend` input, a `depend`
output, an `exec`, and the `SAVE_PROXY` inherit flag. The host uses this to
sequence recomputation; a provider that skips it will render stale after
upstream edits.

Note that graph invalidation (`graphUpdate`) is **not** part of §5's invalidation
vocabulary. Saying "my contents changed" and saying "my downstream dependents
must re-run" are different statements and both are needed; collapsing them would
make every attribute tweak re-run the whole graph.

**Host call sites:** `sceneobject_base.ts:90-98,134`; `sceneobject.ts:279-293`.

### 2.5 Self-description

`defineAPI` (data-API paths), `getTools` (the tool set offered for this kind),
`buildPropertiesTab` (the properties-editor panel), `_ownSelectMask`.

This is how a provider contributes UI without the host knowing it exists. A
provider that hardcodes nothing and declares everything here needs no host edit
to ship.

**Host call sites:** `sceneobject_base.ts:82,111,138,191,442`.

## 3. Optional: feature-detected capabilities

Each of these is a separate interface. A provider opts in by implementing it and
listing the capability in its kind descriptor. The host asks the registry, gates
the UI, and only then calls.

| Capability | What it buys | Section |
| --- | --- | --- |
| `ELEMENTS` | element iteration, stable handles, sub-object selection | §4 |
| `INVALIDATION` | fine-grained "this changed" instead of full rebuild | §5 |
| `SPATIAL` | accelerated nearest-element queries (proportional edit, snapping) | §6 |
| `ATTRIBUTES` | named per-element attribute layers | §7 |
| `TRIANGLES` | triangle extraction for export and for host-side analysis | §7 |
| `SYMMETRY` | mirror/symmetry state honoured by transforms | §7 |
| `ACTIVE_ELEMENT` | active + highlighted element, fed to shader uniforms | §7 |

**The feature-detection rule.** The host writes
`if (hasCapability(kind, Capability.ELEMENTS)) { … }`, never a 22-method
interface every provider must stub. A provider that cannot do proportional edit
must be *unable to opt into it*, not obliged to throw from a required method.

## 4. Element handles

The single most consequential design decision in this contract.

The host wants to walk selected elements and hold identifiers across an edit.
The obvious shape — an iterator of element *objects* — is wrong here, because a
provider whose geometry lives across a WASM boundary would pay a round trip per
element. At the sizes this application targets, that is not a constant factor.

**The contract is therefore:**

1. An element handle is an **opaque non-negative integer**. The host must not
   do arithmetic on it, infer ordering from it, or persist it.
2. Handles are valid **until the provider's `topoStamp` changes**. The host reads
   `topoStamp` before a batch and re-reads it after; if it moved, held handles
   are stale and must be re-acquired. A provider bumps `topoStamp` on any change
   that could invalidate a handle, and is permitted to bump it conservatively.
3. All accessors are **bulk**: arrays in, arrays out. Positions for *n* handles
   come back as one `Float64Array` of length `3n`, not as *n* vector objects.
   There is no single-element accessor in the contract, on purpose — adding one
   is how the per-element round trip comes back.
4. Elements live in **domains**: point, edge, face, corner. Not every provider
   has all four. A provider declares which it has; the host must ask before
   querying a domain.

Handle stability is cheap for some providers and expensive for others, which is
why it is expressed as a stamp rather than as a guarantee. A provider using
tombstoned indices satisfies it for free. A provider that compacts on edit bumps
the stamp and the host re-acquires.

**Host call sites:** `transform_types.ts:78,92-93,334,340-341,470,485,552-553`;
`view3d_draw.ts:170-222`.

## 5. Invalidation

Today the host has **nine** different ways to say "this changed", spread across
about thirty call sites in six files. They are not nine capabilities; they are
one capability with nine names, and the names describe *what the provider should
rebuild* rather than *what the caller changed*. That is backwards: the caller
knows what it changed and cannot know what any given provider caches.

**The contract is one method:**

```
invalidate(what: InvalidationKind, range?: ElementRange): void
```

`InvalidationKind` is a flag set:

| Kind | The caller is saying |
| --- | --- |
| `TOPOLOGY` | elements were added, removed, or reconnected |
| `POSITIONS` | element positions moved; connectivity is unchanged |
| `ATTRIBUTES` | a named attribute layer's values or layout changed |
| `SELECTION` | which elements are selected changed |
| `MATERIALS` | material assignment changed |
| `ALL` | everything above |

`range`, when given, names the affected element handles; omitting it means "all
of them". A provider is always free to ignore `range` and rebuild wholesale — it
is an optimisation hint, not a correctness contract. **Neither provider that
exists today consumes it.** `Mesh`'s per-element flagging is `flagElemUpdate`,
which takes live element objects rather than handles, and `LiteMesh`'s is
`markVertsMovedGPU`, which takes a bound engine handle vector — rebuilding one
from an `Int32Array` on every call would cost more than the narrowing saves. The
parameter stays in the signature because a provider *may* honour it; the two
that ship do not, and callers must not assume otherwise.

Everything the old vocabulary requested is *derived* by the provider from what
the caller declares. A provider that needs an acceleration structure rebuilt
after positions move rebuilds it when it sees `POSITIONS`; the host never asks
for a BVH, because the host does not know whether this provider has one. The
same goes for tessellation, draw buffers, and UV caches.

### 5.1 What each provider derives

`LeafMesh` (`addons/builtin/leafmesh/src/leafmesh.ts`) maps onto its caches:

| The caller said | `LeafMesh` rebuilds |
| --- | --- |
| `TOPOLOGY \| POSITIONS` | `triCache.invalidate()` |
| `TOPOLOGY` | `mesh.topoStamp++` |
| `TOPOLOGY \| POSITIONS \| ATTRIBUTES` | `_drawable.invalidate()` |
| anything at all | `updateGen++`, then `graphUpdate()` |

`LiteMesh` (`scripts/lite-mesh/litemesh.ts`) derives almost everything lazily
inside the engine, so the same table has exactly one live row — `TOPOLOGY |
POSITIONS` → `regenBounds()`. Its other `regen*` methods are empty stubs, and
`invalidate` still calls them so that the mapping is visible in the source
rather than being an unexplained gap.

The two tables differing is the point. The host declares the same thing to both
and neither provider's caching strategy leaks back into the call site.

### 5.2 `recalcNormals` is not invalidation

Normals are the one member of the old vocabulary that did **not** collapse.
`recalcNormals()` is an O(mesh) *computation* whose cost the caller schedules,
not a declaration of what changed — folding it into `POSITIONS` would make the
per-element invalidation in `transform_types.ts:applyTransform` O(mesh · n) for
an n-element transform. It stays an explicit call, and the host sites that need
it make it once per update rather than once per element.

### 5.3 The mapping applied by P7

| Old | New |
| --- | --- |
| `regenAll` | `invalidate(ALL)` |
| `regenRender` | `invalidate(POSITIONS)` — or `ATTRIBUTES`, per call site |
| `regenElementsDraw` | `invalidate(POSITIONS)` |
| `regenTessellation` | `invalidate(TOPOLOGY)` |
| `regenBVH` | `invalidate(POSITIONS)` |
| `regenUVEditor` | `invalidate(SELECTION)` |
| `recalcNormals` | unchanged — see §5.2 |
| `flagElemUpdate(e)` | unchanged — provider-internal, not a host call |
| `graphUpdate` | unchanged — see §2.4 |

**Host call sites converted:** `scripts/editors/view3d/transform/` —
`transform_inset.ts`, `transform_ops.ts` (3), `transform_types.ts` (4);
`scripts/editors/properties/PropsEditor.ts` (2, one three-call cluster each);
`scripts/util/stlformat.js` (1, through `invalidatableOf`).

Both providers declare `GeometryCapability.INVALIDATION` on their kind
descriptor and assert `AssertExtends<…, IInvalidatable>`, so a provider that
drops the method fails the typecheck rather than the viewport. The host is held
to the collapse by a grep in `tests/unit/geometry_contract.test.ts` — a `regen*`
call reappearing in a contract-clean directory fails that suite.

## 6. Spatial queries

The host currently reaches through geometry to an acceleration structure and
calls methods on it. That couples the host to a particular structure, and it
means a provider without one cannot be asked the question at all.

**The contract exposes the query, not the structure:**

```
closestElements(co, radius, domain): ElementHandles
```

There is no `getBVH()`, and there must never be one. A provider with an
acceleration structure uses it; a provider without one answers by brute force; a
provider for which the question is meaningless declines the `SPATIAL` capability
and the host disables the features that need it (proportional edit falls back to
unconnected mode, snapping falls back to object snapping).

**Host call sites:** `transform_types.ts:110-115`; `PropsEditor.ts:633-637`.

## 7. The smaller optional capabilities

**Attribute layers.** Named, typed, per-domain value layers, with one layer per
type optionally marked active. The vocabulary — layer type names and value types
— is shared with §10's declared attribute set and with the engine's; keeping the
three identical is a hard requirement, because a mismatch shows up as a material
that renders with default values instead of an error.
Host call sites: `PropsEditor.ts:138,168,367-387,494-513`; `api_define.ts:312`.

**Triangle extraction.** One call returning positions plus indices. Every
geometry type can answer it, even by approximation, and it is the cheapest
possible end-to-end proof that a new type is wired in: if a provider can export
STL, its data is really reaching the host.
Host call sites: `stlformat.js:13,33,40-43`; `app_ops.js:203-228`.

**Symmetry state.** A flag set naming mirrored axes, read by transforms so an
edit on one side reproduces on the other. Read directly off geometry today.
Host call sites: `transform_types.ts:87,246`.

**Active / highlight element.** Two handles that feed shader uniforms so the
active and hovered elements draw differently. Small, but it is a genuine host
demand and it is currently satisfied by reading fields off a concrete type.
Host call sites: `view3d_draw.ts:302-368`.

## 8. `ITransDataType` — the transform contract

Transform is its own interface with its own lifetime, and it is **not** a subset
of the geometry contract. Different consumer (transform ops only), different
lifetime (one transform session), and — importantly — different implementors:
one of the four registered today is a *widget*, not geometry at all.

So: this registry describes **things a transform operator can move**. Do not
narrow it to geometry, and do not assume an entry has a kind descriptor.

The interface is twelve methods, in four groups:

- **Identity and eligibility** — `transformDefine` (name and UI label),
  `isValid` (can this type participate in the current context at all),
  `buildTypesProp` (the property that carries the participating type set).
- **Data generation** — `genData` builds the per-element transform list from the
  current selection, honouring select mode, proportional-edit mode and radius.
  This is where proportional falloff weights are assigned.
- **Application** — `applyTransform` moves one element by one matrix; `update`
  is called once at the end of each interactive step so the type can flush.
- **Undo** — `undoPre` snapshots, `undo` restores, `calcUndoMem` reports the
  snapshot's size so the host's undo-memory budget can evict. **This is where
  geometry undo lives** (see §2.2).

Two rules about registration:

1. Registration goes through `AddonAPI` (§9) inside a `register(api)` hook.
   Module-scope registration is forbidden **for addon-contributed types**,
   because it cannot be undone and therefore breaks addon unload. Three of the
   four types registered today are host code with no `register()` hook to move
   to and stay module-scope, each with a comment saying so: `ObjectTransType`
   (SceneObject is core), `TransMovWidget` (the widget-drag pseudo-type — not
   geometry, and `isValid` keeps it out of ordinary transform ops), and
   `LiteMeshTransType` (host code until P12 gives LiteMesh an addon). Only
   `MeshTransType` has an owning addon, and it registers from that addon's hook
   via `AddonAPI.registerTransType`.
2. The set of participating types is **derived from the registry**, sorted by
   name for determinism — `TransDataType.defaultTypeNames()`, which is what a
   transform op's `types` input defaults to. Registration order is not stable
   and must never be load-bearing. `TransformOp.getTransTypes` then filters by
   `isValid`, so a type that does not apply to the op in hand costs nothing.

A name outlives its type: it is stored in the op's inputs, and the addon that
contributed the type can be disabled between the save and the replay. So
`TransDataType.getClass` returns `ITransDataType | undefined`, and every lookup
must skip a miss rather than dereference it.

**Host call sites:** `transform_base.ts:108-141,175-177,186-188`;
`transform_ops.ts:181,201-219,271-300`.

## 9. Registration: the `AddonAPI` surface

A geometry addon registers everything it contributes through one object, and
everything registered through it is unregisterable. That second property is the
whole point: module-scope registration works exactly once and cannot be undone,
so an addon that registers at module scope can be loaded but never unloaded.

| Call | Registers |
| --- | --- |
| `register` / `registerAll` | ToolOp, DataBlock, ToolMode, CustomDataElem, Editor, SceneObjectData, nstructjs, `defineAPI` (existing) |
| `registerTransType` | §8 |
| `registerDataKind` | §2.1 |
| `registerDefaultSceneBuilder` | the default scene, so a distribution's is not host-hardcoded |
| `registerFileMigrator` / `registerFileFormat` | file-format evolution |
| `registerUVSource` | the UV contract, when it is implemented |
| `registerPropsPanel` | a properties-editor panel, replacing the host's branch on concrete type |
| `has(id)` | capability query — lets an addon degrade instead of crash when an optional dependency is absent |

`has` deserves a note. An addon that needs an optional subsystem has three
options: hard-depend and fail to load without it, crash at first use, or ask and
degrade. Only the third produces a distribution that can ship without the
subsystem, which is the point of the layered architecture.

**Host call sites:** `addon_base.ts:331-405`.

## 10. The vertex-layout contract

A material authored with an attribute node declares vertex inputs beyond the
fixed set the host's default pipeline descriptor supplies. Today that fixed set
is one geometry type's layout, used as a global default, so such materials render
correctly through exactly one draw path and silently render with default values
through every other.

This is the difference between "a new geometry type renders" and "a new geometry
type renders the material system users actually author."

**The contract:**

1. A kind descriptor declares its **attribute set** (`vertexAttrs`, §2.1): for
   each attribute a name, a shape, and the slot the draw path binds it at.
2. The host builds a vertex-buffer layout **from a declared set**. The layout
   builder (`core/vertex_layout.ts`) is generic and knows nothing about any
   geometry backend; a backend that needs backend-specific layout logic wraps
   the generic builder rather than replacing it.
3. Every pipeline-compile site takes the layout as a parameter. There is no
   default layout. A default is how the coupling survives a refactor that was
   supposed to remove it.

There are two compile sites and both must be threaded. Threading one leaves
materials working in one viewport path and broken in the other, which is harder
to diagnose than not working at all.

### 10.1 Two vocabularies, one table

`AttrType` (§7) says what a layer *stores*; `VertexScalarType` says how the
rasterizer *fetches* it. They are deliberately separate enums —
`vertexShapeForAttrType` converts, and declines (returns undefined) for the
storage types WebGPU has no vertex format for, rather than guessing one.

The format and stride tables live once, in `core/vertex_layout.ts`. The
sculptcore batch executor keeps its own engine-type → `VertexScalarType` map
and calls the shared builder; it no longer carries a second format table. Two
consequences worth knowing:

- **Stride does not follow format.** WebGPU has no 1- or 3-component 8/16-bit
  vertex format, so those widen (`unorm8x3` → `unorm8x4`) while the stride stays
  what the source buffer actually uses. `VertexAttrDesc.arrayStride` overrides
  the shape-implied stride for exactly this reason.
- **A narrower format than the WGSL variable is legal and intended** —
  `float32x3` data feeding a `vec4f` input default-fills the missing components.
  Providers rely on this; do not "fix" it by padding.

### 10.2 The material vertex interface

The layout a material pipeline needs follows the **material**, not the geometry
type: every generated `VsIn` opens with `MATERIAL_BASE_VERTEX_ATTRS`
(`position` at slot 0, `normal` at slot 1) and then declares one input per
`AttributeNode` read, at slot 2 upward. `buildMaterialVertexLayout` builds
exactly that, and throws if a requested attribute claims a reserved slot.

A geometry provider that wants to render authored materials must therefore bind
those two slots, and must bind the material's requested attributes by *name* at
the slots the generator assigned. `vertexAttrs` on the kind descriptor is the
always-present part of that — what the provider binds regardless of the
material.

The host tells it which: a provider implementing `IMaterialAttrConsumer`
(`setRequestedAttrs(reqs)`, feature-detected by `asMaterialAttrConsumer`) is
handed the compiled `MaterialAttrRequest[]` from *both* compile sites, whenever
the compiled set can have changed. Feature-detected rather than declared on the
kind descriptor, because these sites also serve providers that predate the kind
registry.

**Host call sites:** `wgsl_shaders.ts` (`buildMaterialVertexLayout` /
`buildMaterialPipelineDescriptor`); `webgpu/batch.ts` (`getPipeline`);
`renderengine_realtime.ts`; `view3d_draw_webgpu.ts`.

## 11. Known gaps

**The BREP mesh's declared slots collide with the material ones.** Its draw path
(`SimpleIsland`) binds one buffer per layer type at fixed slots — `uv` at 2,
`color` at 3 — while a material's `AttributeNode` reads also start at slot 2. So
an attribute-node material drawn over a BREP mesh gets whatever that mesh
happens to have bound at that slot, not the attribute it asked for. This is not
a regression: the previous fixed layout declared the same two slots and was
equally wrong, just silently. §10 makes it visible by having both sides declare
what they bind. The fix is for that draw path to bind requested attributes by
name, and it belongs to the plan that replaces the BREP mesh (§12), not here.

**The second material compile site is unreachable from `View3D.draw`.**
`view3d_draw_webgpu.ts`'s `drawRenderWebGpu` runs only when `SHOW_RENDER` /
`ONLY_RENDER` is set, but `View3D.draw` hands those flags to `RealtimeEngine`
and returns before the path that would call it. So the two sites cannot diverge
observably today — and equally, a fix applied to one and not the other cannot be
caught by rendering. Both are kept in step by hand until the smoke-test path is
either deleted or given a caller; that decision belongs to the plan that rebuilds
the pass graph, not here.

**"Just submit through the render queue" is not yet uniformly true.** At least
one host draw path schedules a raw-GL pass through the queue
(`camera.ts:163,165`), and the WebGPU adapter throws on that entry
(`queue_adapter.ts:229-234`). A provider that follows this contract will not hit
it, but a host developer wiring up a new draw path can, and the failure is a
runtime throw rather than a compile error. Fixing the call site belongs to the
plans that touch those paths, not to this contract.

**A UV source in an addon cannot be checked by jest.** An addon imports the
framework through `@framework/api`, which the unit workspace does not resolve,
so neither real provider is reachable from `tests/unit`. The rules therefore
live in `scripts/core/uv_source_conformance.ts` — jest-free, exported from the
hub — and run *inside* the app: each addon carries a
`*_uvsource_support.ts` driver, and one headless NW.js boot reports both results
through `--dump` (`tests/integration/uv_source_conformance.test.ts`).
`tests/lib/uv_source_conformance.ts` is a thin jest wrapper over the same rules,
so the in-memory grid still reports one failure per rule. The gap that remains
is the asymmetry: a provider added to an addon is only as checked as its driver.

## 12. Who implements this today

Kept deliberately short, and deliberately last: this section is the only place
in the document where concrete type names belong.

- **LiteMesh** declares `INVALIDATION` and nothing else
  (`LITEMESH_DATA_KIND`, `litemesh.ts`), so every other narrow returns
  undefined for it. Its geometry lives in the engine behind a paged attribute
  store, which is why reaching it takes an adapter over bound bulk accessors
  rather than a narrow — the shape `IUVSource` below is built in. Of the old
  nine-name invalidation vocabulary it implemented three, as empty stubs —
  which is the clearest evidence available that the vocabulary was not a
  contract anyone could satisfy.
- **LeafMesh** implements the required groups plus elements, attributes,
  triangles and symmetry, and is the first implementor of `ITransDataType`'s
  peer `IUVSource`. (The BREP mesh was implementor #2 of everything until P13
  deleted it.)

`IUVSource` is counted separately, because it is registered rather than narrowed
to and so its implementors need not appear above:

- **LeafMesh**, through `addons/builtin/leafmesh/src/uv_source.ts` — UVs on the
  corner domain, so a UV element handle *is* a corner handle and `getUVOwners`
  is the identity.
- **LiteMesh**, through `addons/builtin/litemesh/src/uv_source.ts` — an adapter
  over bulk accessors bound on sculptcore's `Mesh`, because attribute values are
  paged behind `AttrData<T>` and reachable one element at a time otherwise. A UV
  element is a corner and its owner is a vertex, so owners are many-to-one and a
  seam is two corners of one vertex disagreeing.
- **An in-memory grid**, `tests/lib/uv_grid_source.ts` — no geometry object at
  all, and owners that are many-to-one. It exists so the interface cannot
  quietly become one mesh's storage.

All three answer to the one rule set in `scripts/core/uv_source_conformance.ts`;
where each runs it from is §11.

**The contract must never be down to one implementor.** A contract with one
implementor has not been tested, it has been described.
