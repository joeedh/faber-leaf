# P7 — W1b: the host geometry contract — `[xhigh]`

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§3 (all of it), §4 W1 steps 1 and 3(a)(b), §5 phase 4, §9.3 P7.

**Workstream / phase:** W1 / phase 4.

**Depends on:** P6 (`SelMask` must already be host-owned — a geometry contract
that speaks the BREP's selection bits is not a geometry contract).
**Blocks:** P8, P11, P12, P15, P18 — everything that implements against it.

**Authoring effort:** **`[xhigh]`** — this writes the interfaces the entire
target architecture rests on. Five plans implement against them. A wrong
boundary here is not a local mistake.

**Closes:** contributes the contract half of success criteria 12, 13, 14.

> Line references carried from the strategy doc §3 and its
> [adversarial review](../research/2026-08-15-faber-leaf-adversarial-review-architecture.md).
> **Re-verify every one before editing** — §3's capability table is the input
> to this plan and its accuracy is the plan's accuracy.

---

## 1. Goal

Write down, as real documented TypeScript, the four interfaces through which the
host is permitted to talk to geometry — and prove each one against **two**
implementors, because a contract with one implementor has not been tested, it
has been described.

## 2. The rule this plan encodes

> When the host needs to know something type-specific, it asks the **registry**,
> never the type.

Every design question in this plan reduces to that sentence. `instanceof Mesh`
becomes a registry lookup or a method. A hardcoded `['mesh', 'object',
'litemesh']` list becomes a registration. A hardcoded vertex layout becomes a
layout derived from a declared attribute set.

## 3. Why it is `xhigh`, and what "getting it wrong" looks like

The failure mode is not a compile error. It is a host that compiles without
`Mesh` and **cannot do anything with what replaces it** — an interface covering
the eight obvious capabilities (bounds, draw, pick, select, undo) while the
other fourteen stay as host-side branches on concrete type. That host passes
`check:layers`, ships, and then rejects the first third-party geometry type
somebody writes.

§3 counts it precisely: `SceneObjectData`'s existing contract covers roughly
**eight of the twenty-two things the host demands today**. This plan is about
the other fourteen.

## 4. Deliverables

1. `documentation/geometry-contract.md` — the normative document. Each
   capability: what the host asks, why, what a provider that cannot do it should
   return, and which host call site depends on it.
2. `scripts/core/geometry_contract.ts` (or `scripts/sceneobject/`, wherever
   `SceneObjectData` lives) — the TS interfaces, with doc comments pointing at
   the host call sites.
3. `ITransDataType` promoted from a base class to a documented interface, with
   its registration on `AddonAPI`.
4. `IUVSource` **declared** — implemented in P18.
5. The `AddonAPI` extension: six missing dispatch cases plus a capability query.
6. The vertex-layout contract (§8) — the piece no workstream previously owned.
7. Two implementors compiling against all of it: LiteMesh and the BREP.

## 5. `IGeometrySource`

Not one interface. §3's twenty-two capabilities do not all belong on the same
object, and forcing them to is how the interface becomes unimplementable. Split
along who asks and when:

| Group | Contents | Notes |
| --- | --- | --- |
| **Kind descriptor** (static, registry-held) | identity, factory, import hooks, `_ownSelectMask`, material-slot policy, declared attribute set | `core/data_kinds.ts:1-57`; `sceneobject_base.ts:394,428`; `context.ts:226,323,372`. This is *data*, not a method table — it is what the host reads to decide whether to even call the instance. |
| **Instance core** | bounds, transform, `applyMatrix`, draw submission, the four picking entries, selection state | the existing `SceneObjectData` surface (`:163,191,196,230,284,315,356,358,362,364`) plus `applyMatrix` (`sceneobject_base.ts:77`). **Not undo** — see sweep correction 2; undo lives on `ITransDataType` (§6). |
| **Datablock lifecycle** | `copy`, `copyAddUsers`, `dataLink`, `destroy`, `swapDataBlockContents`, `onContextLost` | `sceneobject_base.ts:159,368,370`; `sceneobject.ts:269,364-380,410-417`. Already largely a DataBlock concern — the work is writing it down, not inventing it. |
| **Graph participation** | `inputs.depend`, `exec`, `SAVE_PROXY` | `sceneobject_base.ts:90-98,134`; `sceneobject.ts:279-293` |
| **Self-description** | `defineAPI`, `getTools`, `buildPropertiesTab` | `sceneobject_base.ts:82,111,138,191,442` |
| **Optional capabilities** (feature-detected) | element iteration + stable eids, invalidation/regen (9 methods), spatial acceleration, CustomData layers, triangle extraction, symmetry state, active/highlight element | see §6 |

**The feature-detection rule.** Optional capabilities are queried, never assumed:
`if (geom.elements) { … }`, not a 22-method interface every provider must stub.
A provider that cannot do proportional edit should be *unable to opt into it*,
not obliged to throw from a required method. The host asks the registry whether
the capability exists; the answer gates the UI, not just the call.

### 5.1 The hard ones

**Element iteration + stable eids** (`transform_types.ts:78,92-93,334,340-341,470,485,552-553`;
`view3d_draw.ts:170-222`). The host wants to walk selected elements and hold
identifiers across an edit. Design constraint: LeafMesh uses tombstoned `int32`
indices that are stable by construction, sculptcore uses its own handles, and
the BREP uses `eid`s. The contract is therefore **opaque integer handles valid
until `topoStamp` changes**, plus a bulk accessor — not an iterator of element
*objects*, which would force a per-element WASM round trip for the LiteMesh
implementor. Bulk arrays in, bulk arrays out; this is the same lesson §4 W4
draws for `IUVSource` and it applies here first.

**Invalidation / regen, 9 methods** (`transform_types.ts:367-368,498,500,670-671,699,712,716-717`;
`PropsEditor.ts:166,189-196,235-237`). Nine host-visible ways to say "this
changed". That is a vocabulary problem, not a capability problem. Collapse it to
a single `invalidate(what: InvalidationKind, range?)` with a documented enum
(`TOPOLOGY | POSITIONS | ATTRIBUTES | SELECTION | MATERIALS | ALL`) and map the
nine existing calls onto it. Doing this collapse *here*, while both implementors
exist, is much cheaper than doing it after the BREP is gone and the mapping
evidence has been deleted.

**Spatial acceleration** (`transform_types.ts:110-115` — `mesh.getBVH().closestVerts`;
`PropsEditor.ts:633-637`). The host currently reaches through to a BVH object.
Replace with the *query*, not the structure: `closestElements(co, radius, domain)`.
A provider without an acceleration structure answers by brute force or declines
the capability. Never expose `getBVH()`.

**Material slots + shader/attribute negotiation** (`sceneobject_base.ts:56-58`;
`renderengine_realtime.ts:1226-1299`). This is where §8 attaches.

**Symmetry / mirror state** (`transform_types.ts:85,246`) and **active/highlight
element** (`view3d_draw.ts:302-368`, which feeds shader uniforms). Small, but
both are currently read directly off the mesh. Both become instance-core
accessors.

**Triangle extraction for export** (`stlformat.js:13,33,40-43`;
`app_ops.js:203-228`). One method returning positions + indices. Every geometry
type can answer it, and STL export is the cheapest possible end-to-end proof
that a new type is wired in.

## 6. `ITransDataType`

It already exists — `scripts/editors/view3d/transform/transform_base.ts:108-141`,
12 required methods (`calcPropCurve`, the 13th, is commented out at `:112`).
**It also owns undo**: `undoPre` / `undo` / `calcUndoMem` are three of the twelve,
and sweep correction 2 shows they are the *only* geometry-undo surface the host
has. Three things are wrong with how it is used, and they are the same bug:

- `transform_ops.ts:177` hardcodes `['mesh', 'object', 'litemesh']`.
- `MeshTransType` is **743 lines living in the host**
  (`transform_types.ts:38-780`) — geometry-specific code inside Layer 1.
- Registration happens at **module scope** in four places, which this project's
  own addon rules forbid (no module-scope `*.register(...)`):
  `transform_types.ts:782` (`MeshTransType`), `transform_types.ts:1041`
  (`ObjectTransType`), `widget_utils.ts:154` (`TransMovWidget`), and
  `scripts/lite-mesh/litemesh_transtype.ts:202` (`LiteMeshTransType`).

`TransMovWidget` is worth pausing on: a *widget* implements `ITransDataType`.
The registry therefore does not describe geometry, it describes "things a
transform op can move", and the documentation must say so — otherwise §6 step 3
narrows the default set to geometry kinds and silently drops the widget.

Plan:

1. Document the 12 methods properly — what each is called with, when, and what
   proportional edit / snapping expect from it. Today the contract is "read
   `MeshTransType`".
2. Move all four registrations onto `AddonAPI` (`api.registerTransType(...)`
   inside the addon's `register(api)` hook). The two in `transform_types.ts` and
   the one in `widget_utils.ts` are host-side and have no addon to move into
   yet; they register through the same call from the host's own bootstrap, so
   there is exactly one registration path.
3. Derive `transform_ops.ts:177`'s default from the registry rather than a
   literal, ordered deterministically (registration order is not stable — sort by
   name). Note this is a *default value*, not a dispatch: `getTransTypes`
   (`:197-213`) already resolves through `TransDataType.getClass`, so nothing
   downstream changes.
4. `MeshTransType`'s 743 lines stay put in this plan and **leave with P13**.
   Moving them now would be churn on code scheduled for deletion. But they must
   compile against the documented interface, since they are implementor #2.

`ITransDataType` is **not** a subset of `IGeometrySource` and must not be folded
into it. Different lifetime (per-transform-session), different consumer
(transform ops only), different implementors possible.

## 7. `IUVSource` — declared here, implemented in P18

Write the interface and its doc section now, because P11's LeafMesh and P15's
LiteMesh both need to know what they will implement, and because designing it
next to `IGeometrySource` is what keeps the two consistent about handles and
bulk access.

Constraints (from §4 W4): opaque handles, bulk arrays-in / arrays-out, **no
per-element round trips across the WASM boundary**. Do not design it against
BREP element types — `addons/builtin/mesh_edit/pending-port/` is a *spec*, not
source (P18).

No implementors land in this plan. Do not let that soften the design; an
undesigned `IUVSource` is how P18 turns into a rewrite.

## 8. The vertex-layout contract

This is the piece §3 flags as owned by no workstream, and it is the difference
between "LeafMesh renders" and "LeafMesh renders the material system users
actually author."

`scripts/shaders/wgsl_shaders.ts:1361-1370`:

```ts
export function buildMaterialPipelineDescriptor(wgsl: string, label: string): PipelineDescriptor {
  return {label, wgsl, vertexBuffers: LIT_MESH_VERTEX_LAYOUT, ...}
}
```

The doc comment above it already admits the problem: a material with an
`AttributeNode` declares `@location(2+)` inputs this fixed layout does not
supply, so *"those materials only render correctly through the
LiteMesh/sculptcore draw path."*

The only dynamic layout builder in the tree is `scripts/webgpu/batch.ts:380-443`,
and it is 100% sculptcore-bound (`import {Buffer, DrawBatch, DrawCommand,
ShaderDef} from '@sculptcore/api'`).

Plan:

1. Add a **declared attribute set** to the kind descriptor (§5): name, type,
   and `@location`, per geometry type. This is the same vocabulary as
   `attrs.ts`'s `AttrType` (P3) and sculptcore's — keep it identical.
2. Generalize `batch.ts:380-443`'s layout builder into a sculptcore-free
   function taking that declared set and returning a `vertexBuffers` descriptor.
   The sculptcore-specific half stays behind, consuming the generic half.
3. Thread it through **both** compile sites: `renderengine_realtime.ts:708` and
   `view3d_draw_webgpu.ts:490`. Both, or materials work in one viewport path and
   not the other.
4. `buildMaterialPipelineDescriptor` takes the layout as a parameter;
   `LIT_MESH_VERTEX_LAYOUT` becomes LiteMesh's declared set rather than a global
   default. Keeping it as a default is how the coupling survives.

**Caveat to record, not to fix here:** `scripts/camera/camera.ts:163,165` calls
`queue.scheduleRawGLPass(...)`, which **throws** on the WebGPU adapter
(`scripts/webgpu/queue_adapter.ts:229-234`). "Just submit through the render
queue" is not yet uniformly true. Note it in the contract document so P11 does
not discover it as a surprise; fixing it is P8/P11 work at the call site.

## 9. `AddonAPI` extension

`scripts/addon/addon_base.ts:331-405` dispatches ToolOp / DataBlock / ToolMode /
CustomDataElem / Editor / SceneObjectData / nstructjs / `defineAPI`. Add:

| Case | For |
| --- | --- |
| `registerTransType` | §6 |
| `registerDataKind` | §5's kind descriptor; `core/data_kinds.ts` |
| `registerDefaultSceneBuilder` | so a distribution's default scene is not host-hardcoded (P17) |
| `registerFileMigrator` / `registerFileFormat` | P10 |
| `registerUVSource` | P18 |
| `registerPropsPanel` | P8 — replaces `PropsEditor`'s branch on concrete type |
| `api.has('sculptcore')` | capability query, so addons **degrade instead of crash** (P14, P16) |

Extend, do not replace. Each case follows the existing dispatch shape and is
unregisterable, because that is the property module-scope registration destroys.

Until this lands, **success criterion #12 is unachievable by construction** —
there is no way for an addon to contribute a geometry type without editing
`scripts/`.

## Sweep (verified 2026-08-17)

Every file:line in §3's capability table, in §3's vertex-layout subsection, and
in §§5–9 of this plan was re-read against the tree at `02290864`. **All 21 cited
files exist.** The table below records only what moved or was wrong; everything
not listed was found exactly where the strategy doc says it is, including the
whole of `transform_types.ts` (78, 92-93, 110-115, 246, 334, 340-341, 367-368,
470, 485, 498, 500, 552-553, 670-671, 699, 712, 716-717), `PropsEditor.ts` (138,
166, 168, 189-196, 235-237, 367-387, 494-513, 633-637), `sceneobject.ts` (269,
279-293, 364-380, 410-417), `view3d_draw.ts` (170-222, 302-368),
`renderengine_realtime.ts` (708, 1226-1299), `api_define.ts:312`,
`toolstack.js` (7-8, 29-41), `transform_ops.ts` (177, 265-294), `stlformat.js`
(13, 33, 40-43), `app_ops.js:203-228`, `transform_base.ts:108-141`,
`addon_base.ts:331-405`, `wgsl_shaders.ts:1361-1370`, `batch.ts:380-443`,
`view3d_draw_webgpu.ts:490`, `camera.ts` (163, 165), `queue_adapter.ts:229-234`
and `litemesh_transtype.ts:202`.

### Line drift

P6 (W1a) inserted `selectTypeName` handling into `sceneobject_base.ts`, shifting
it by ~+10 throughout. `context.ts` drifted from earlier phases.

| Cited | Now | What is there |
| --- | --- | --- |
| `sceneobject_base.ts:56-58` | `66-68` | `material` / `materials` / `usesMaterial` |
| `sceneobject_base.ts:67` | `77` | `applyMatrix` |
| `sceneobject_base.ts:72` | `82` | `static dataDefine` |
| `sceneobject_base.ts:80` | `90-98` | `nodedef` → `inputs.depend` |
| `sceneobject_base.ts:101` | `111` | `defineAPI` |
| `sceneobject_base.ts:124` | `134` | `exec` |
| `sceneobject_base.ts:128` | `138` | `getTools` |
| `sceneobject_base.ts:149` | `159` | `copyAddUsers` |
| `sceneobject_base.ts:153` | `163` | `getBoundingBox` |
| `sceneobject_base.ts:181,186` | `191` | `_ownSelectMask` |
| `sceneobject_base.ts:220` | `196` | `castViewRay` |
| `sceneobject_base.ts:274` | `230` | `findNearest` |
| `sceneobject_base.ts:305` | `284` | `castScreenCircle` |
| `sceneobject_base.ts:346` | `315` | `castScreenRect` |
| `sceneobject_base.ts:348,352,354` | `356,358,362,364` | `drawIdsQ` / `drawQ` / `drawWireframeQ` / `drawOutlineQ` |
| `sceneobject_base.ts:358,360` | `368,370` | `onContextLost` / `dataLink` |
| `sceneobject_base.ts:405` | `394` and `428` | `static register` / `static dataKindOf` |
| `sceneobject_base.ts:419` | `442` | `buildPropertiesTab` |
| `context.ts:222,318,362` | `226,323,372` | the three `dataKindOf(...) === 'mesh'` sites |
| `transform_types.ts:85` | `87` | `td.symFlag = mesh.symFlag` (the `:246` twin is exact) |
| `core/data_kinds.ts:1-58` | `1-57` | file is 57 lines |

### Corrections — the citation was right, the claim was not

These are not drift. Each changes what this plan has to do.

1. **`ITransDataType` has 12 required methods, not 13.** `transform_base.ts:109-140`:
   `transformDefine`, `isValid`, `buildTypesProp`, `genData`, `applyTransform`,
   `calcUndoMem`, `undoPre`, `undo`, `getCenter`, `calcAABB`, `getOriginMatrix`,
   `update`. The 13th is `calcPropCurve`, **commented out** at `:112`. §6 step 1
   documents twelve.

2. **`SceneObjectData` has no undo at all.** `grep -n 'undo\|Undo'` over
   `sceneobject_base.ts` and `sceneobject.ts` returns nothing. §3 lists "undo
   push/pop" among the obvious half that "maps onto `SceneObjectData:…`"; it does
   not. Geometry undo runs through `ITransDataType.undoPre`/`undo`
   (`transform_ops.ts:284-294`) and, for CustomData edits, through `PropsEditor`'s
   own `saveUndoMesh`/`loadUndoMesh` (`:136,163`) — i.e. **through the transform
   registry and through a host editor, never through the geometry object.**
   Consequence for §5: undo does not belong in "instance core". A provider does
   not implement undo; it implements enough of the contract that the *host* can.
   `calcUndoMem` is likewise an `ITransDataType` method (`transform_base.ts:121`),
   not a geometry-source one — so the §3 row "Undo beyond push/pop (`calcUndoMem`)"
   is filed under the wrong interface.

3. **There are four module-scope `TransDataType.register` calls, not one.**
   §6 names only `litemesh_transtype.ts:202`. The full set:
   `transform_types.ts:782` (`MeshTransType`), `transform_types.ts:1041`
   (`ObjectTransType`), `widget_utils.ts:154` (`TransMovWidget`),
   `litemesh_transtype.ts:202` (`LiteMeshTransType`). §6 step 2 moves all four.

4. **`widget_utils.ts:154` registers a *widget* as a trans type.** `ITransDataType`
   therefore already has a non-geometry implementor, and it is not in the
   hardcoded `['mesh','object','litemesh']` list — it is opted into per-op. §6's
   "different implementors possible" is not hypothetical, and the registry must
   not assume its entries describe geometry.

5. **`transform_ops.ts:177` is a default value, not a dispatch.** The registry
   query already exists — `getTransTypes` (`:197-213`) reads
   `this.inputs.types.getValue()` and resolves through `TransDataType.getClass`.
   The literal is the `StringSetProperty` default. So §6 step 3 is narrower than
   "replace the literal with a registry query": it is "derive the default from the
   registry", and the sort-by-name determinism requirement applies to that
   default, not to a new lookup.

6. **`MeshTransType` is 743 lines, not 745** — the object literal is
   `transform_types.ts:38-780`. `:782` is correction 3's register call.

## 10. Plan of record

1. **Sweep first.** ✅ Done — see [Sweep (verified 2026-08-17)](#sweep-verified-2026-08-17)
   above. §3's capability table was re-read line by line; six substantive
   corrections, listed there, feed §§5 and 6.
2. Write `documentation/geometry-contract.md` — prose first, before any TS. If a
   capability cannot be described without naming `Mesh`, it is not yet a
   contract. ✅ Done.
3. Land the interfaces as types only, with the BREP and LiteMesh compiling
   against them. No behaviour change; the two implementors are asserted by the
   compiler, not by tests, at this stage. ✅ Done — with one correction to the
   shape this section assumed. The interfaces do **not** all live in
   `core/geometry_contract.ts`. Declaring the required surface (§2) there means
   importing `editors/all`, `render/queue`, `findnearest`, `context`,
   `sceneobject`, and `lib_api` into core — measured cost, +46
   `core-no-addons-transitive` and +27 `no-circular` over P1's baseline, because
   a second core module then duplicates the whole host-facing import set. §2 is
   therefore declared in `sceneobject/sceneobject_base.ts`, which already imports
   every one of those to declare the class; `core/geometry_contract.ts` holds the
   vocabulary and the optional capabilities and **imports nothing** but path.ux
   vector types. Conformance is asserted with `AssertExtends` on
   `SceneObjectData`, `Mesh`, and `LiteMesh`.
4. Land the `AddonAPI` cases (§9), each with a trivial test registration.
   ✅ Done — `tests/unit/addon_registries.test.ts`. Correction to the shape this
   section assumed: `AddonAPI` itself **cannot be imported into a jest suite** —
   `addon_base.ts` pulls path.ux at module load and jsdom has no `PointerEvent`.
   The three new leaf registries (`core/file_formats.ts`, `core/props_panels.ts`,
   `core/uv_sources.ts`) are therefore exercised functionally, and `AddonAPI`'s
   own wiring — every §9 case exists, each pushes exactly one undo thunk,
   `unregisterAll` drains them — is asserted against its source text. That is
   the property worth pinning anyway: a case added without its undo.
   `addons/builtin/mesh/src/migrations.ts` still calls raw `registerFileMigrator`
   at module scope; moving it into the addon's `register()` hook is P10's.
5. Land the invalidation collapse (§5.1), which is the largest behavioural
   change here — nine call-site families mapped onto one enum, verified by the
   existing viewport tests. ✅ Done — 24 host call sites across
   `editors/view3d/transform/`, `editors/properties/`, and `util/stlformat.js`,
   with `invalidate()` on both providers and a grep net in
   `tests/unit/geometry_contract.test.ts`. Two corrections: **nine names collapse
   to eight**, because `recalcNormals()` is a *computation* the caller schedules,
   not a declaration — folding it into `POSITIONS` makes the per-element site in
   `applyTransform` O(mesh · n). And **`range` is not consumed by either
   implementor**; `Mesh` flags by live element object and `LiteMesh` by bound
   engine handle vector, so building an `Int32Array` for it would cost more than
   it saves. Both recorded in the contract document §5.
6. Land the vertex-layout contract (§8) with a material carrying an
   `AttributeNode` rendering through **both** compile sites. ✅ Done —
   `core/vertex_layout.ts` holds the format/stride tables and the builder;
   `webgpu/batch.ts` keeps only an engine-type → `VertexScalarType` map;
   `buildMaterialPipelineDescriptor` takes the layout as a parameter and both
   compile sites pass one built from the material's own `requestedAttrs`.
   Correction: the material layout follows the **material**, not the geometry
   kind — the two compile sites are per-material and shared across kinds, so
   deriving the layout from `vertexAttrs` would need a per-(material, kind)
   pipeline cache. `vertexAttrs` on the kind descriptor is therefore the
   provider's *declaration* of the slots it always binds, and the collision it
   exposes between the BREP mesh's fixed `uv`@2 / `color`@3 and a material's
   requested slot 2 is recorded as a known gap (contract §11) rather than fixed
   here — that draw path must bind by name, which is P13's.
7. Move `ITransDataType` registration onto `AddonAPI` and replace
   `transform_ops.ts:177`. ✅ Done — the default is now
   `TransDataType.buildTypesProp(TransDataType.defaultTypeNames())` (the line
   had drifted to `:181`), and `MeshTransType` registers from the mesh addon's
   `register(api)` hook via `api.registerTransType`. The addon reaches the class
   through `@framework/api`, which re-exports it via `transform_ops.js` — a
   direct hub edge to `transform_types.js` closes four more cycles, because that
   module imports the mesh addon, which imports the hub.
   Correction: only one of the four registrations moves. `ObjectTransType`
   (SceneObject) and `TransMovWidget` (the widget-drag pseudo-type) are host
   code with no `register()` hook to move to, and `LiteMeshTransType` is host
   code until P12 gives it an addon; all three stay module-scope with a comment
   saying why. `MeshTransType` itself also still lives in host code — P11 moves
   the class, this step moves only the registration, so the class is re-exported
   from `framework_api.ts` for the addon to reach.
   A latent crash surfaced doing it: `getTransTypes` dereferenced
   `TransDataType.getClass(name)` unchecked, and a registry-derived default
   makes an unregistered name reachable (disable the addon, replay a saved op).
   `getClass` now returns `ITransDataType | undefined` and the loop skips it.

## 11. Tests

- **Two implementors compile.** The BREP and LiteMesh both satisfy every
  interface, with no `as unknown as` escapes. This is the primary gate and it is
  a typecheck, not a runtime test.
- **No new host branch on concrete type.** A grep-based test asserting no
  `instanceof Mesh` / `instanceof LiteMesh` / `.type === 'mesh'` in
  `scripts/core/`, `scripts/scene/`, `scripts/sceneobject/`,
  `scripts/editors/view3d/transform/`. Add it now; it is the regression net for
  P8 and P11. ✅ `tests/unit/geometry_contract.test.ts`. Those three patterns
  alone find nothing — P6 already replaced them with
  `SceneObjectData.dataKindOf(x) === 'mesh'`, which is the same branch wearing
  the registry's clothes. The test therefore also greps for the kind-string
  compare, and carries an allowlist of the three that survive
  (`context.ts:226,323,372`) plus an assertion that every allowed line still
  matches — a stale allowance is a hole, not a pass.
- **Transform registry**: removing `'litemesh'` from the registry makes
  transform decline it rather than crash; `transform_ops.ts` contains no type
  literal. ✅ `tests/unit/transform_registry.test.ts` (7), checked against the
  source, the same way `addon_registries.test.ts` checks `AddonAPI`. Neither
  module can be imported into a unit test: `transform_ops.ts` reaches the view3d
  editor and `_appstate` at load, and even `transform_base.ts` pulls
  `scripts/util/vectormath.js` — a `.js` file, which this ESM-mode jest treats
  as CJS, so its `.ts` imports fail to resolve. The suite pins the derived
  default, the sorted walk, `getClass`'s `| undefined`, the skip in
  `getTransTypes`, `unregister` clearing both containers, that each of the three
  host-owned module-scope registrations still carries its reason, and that
  `MeshTransType`'s registration lives in the mesh addon.
  Note for whoever writes the next source-reading test: this workspace runs jest
  under `--experimental-vm-modules`, so `__dirname` does not exist. Use
  `fileURLToPath(import.meta.url)`. Both earlier P7 suites had picked up
  `__dirname` and were failing under `pnpm test`; fixed here.
- **Vertex layout**: an `AttributeNode` material renders correctly through the
  non-LiteMesh path — today it does not, and that is the point. ✅ Partly.
  `tests/unit/vertex_layout.test.ts` pins the builder (12 tests) and both
  compile sites now build the layout from the material's own requested set, so
  the *pipeline* is right on both paths. The BREP path still binds the wrong
  buffer at slot 2 — see the known gap in contract §11; that is a draw-path bug,
  not a layout one, and the layout change is what made it legible.
- **Invalidation**: existing viewport/transform integration suites green after
  the nine→one collapse. ✅ `tests/unit/geometry_contract.test.ts` (9) plus the
  full suite below.
- `pnpm check:layers` below P1's baseline.

## 12. Risks

- **Over-abstraction.** Twenty-two capabilities can become a 22-method interface
  nobody can implement. Mitigation: §5's split plus mandatory feature detection
  for the optional group; a provider that implements only the kind descriptor
  and instance core must be a *valid, useful* provider (it renders and picks).
- **Under-abstraction.** The eight obvious capabilities get an interface and the
  other fourteen stay as host branches. Mitigation: §11's grep test, and §10
  step 1's sweep — you cannot skip what you have enumerated.
- **The vertex-layout work is engine work.** It touches the renderer and the
  WebGPU batch builder, neither of which is geometry-addon territory, and it is
  the single most likely item to slip out of this plan and into nobody's. It is
  in scope. If it must be split, split it into its own plan with a number, not
  into a TODO.
- **Designing `IUVSource` without an implementor.** Mitigation: it is small and
  its constraints are already fixed by the WASM boundary; P18 is allowed to
  revise it and is the only plan that is.
- **The BREP is implementor #2 and it is scheduled for deletion.** Once P13
  lands, LeafMesh (P11) and LiteMesh become the two implementors. Keep it that
  way — the contract must never be down to one.

## 13. Exit criteria

- `documentation/geometry-contract.md` exists and describes all four interfaces
  without naming a concrete geometry type.
- The interfaces exist as TS, with **at least two implementors compiling against
  each** (`IUVSource` excepted — declared only).
- `transform_ops.ts` contains no hardcoded type list; `ITransDataType`
  registration goes through `AddonAPI` and no longer happens at module scope.
- `AddonAPI` has the six new dispatch cases and `has(...)`.
- A material with an `AttributeNode` renders through a non-LiteMesh draw path.
- The "no host branch on concrete type" grep test is in CI and green.

### Verdict (2026-08-17)

Met, with two criteria narrowed by what the sweep found:

- ✅ `documentation/geometry-contract.md` — eleven sections, no concrete geometry
  type named in any interface.
- ✅ Interfaces as TS, two implementors each: `AssertExtends` on `SceneObjectData`,
  `Mesh` and `LiteMesh`; `IUVSource` declared only, as planned.
- ⚠️ `transform_ops.ts` has no hardcoded type list, and the one *addon-owned*
  type registers through `AddonAPI`. The other three registrations are host code
  with no `register()` hook and stay at module scope with a stated reason — see
  step 7's correction. "No module-scope registration" is an addon rule, not a
  universal one; the contract §8 now says so and the test enforces the reason.
- ✅ `AddonAPI` has seven new dispatch cases (six planned plus
  `registerDefaultSceneBuilder`) and `has(...)`, each with an undo thunk.
- ⚠️ Both compile sites build the pipeline layout from the material's own
  requested attributes, so an `AttributeNode` material *compiles* correctly on
  the non-LiteMesh path. It does not yet *draw* correctly: the BREP path binds a
  fixed buffer at slot 2. That is a draw-path bug (contract §11, P13), and the
  layout work is what made it visible rather than silent.
- ✅ `tests/unit/geometry_contract.test.ts` runs in `pnpm test` and is green.

Gates at landing: `npx tsgo --noEmit` clean (app and `tests/tsconfig.json`);
`pnpm check:layers` OK — `no-circular` 673, `core-no-addons-transitive`
1564 → 1472, total 2277 → 2185, every other counter unmoved; `pnpm build` OK;
`pnpm test` 7/7 turbo tasks, unit 29 suites / 266 tests.
