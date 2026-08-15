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
| **Kind descriptor** (static, registry-held) | identity, factory, import hooks, `_ownSelectMask`, material-slot policy, declared attribute set | `core/data_kinds.ts:1-58`; `sceneobject_base.ts:405`; `context.ts:222,318,362`. This is *data*, not a method table — it is what the host reads to decide whether to even call the instance. |
| **Instance core** | bounds, transform, `applyMatrix`, draw submission, the four picking entries, selection state, undo push/pop + `calcUndoMem` | the existing `SceneObjectData` surface (`:153,186,220,274,305,346,348,352,354`) plus `applyMatrix` (`sceneobject_base.ts:67`) and `calcUndoMem` (`toolstack.js:7-8,29-41`; `transform_ops.ts:265-294`) |
| **Datablock lifecycle** | `copy`, `copyAddUsers`, `dataLink`, `destroy`, `swapDataBlockContents`, `onContextLost` | `sceneobject_base.ts:149,358,360`; `sceneobject.ts:269,364-380,410-417`. Already largely a DataBlock concern — the work is writing it down, not inventing it. |
| **Graph participation** | `inputs.depend`, `exec`, `SAVE_PROXY` | `sceneobject_base.ts:80,124`; `sceneobject.ts:279-293` |
| **Self-description** | `defineAPI`, `getTools`, `buildPropertiesTab` | `sceneobject_base.ts:72,101,128,181,419` |
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
13 required methods. Three things are wrong with how it is used, and they are
the same bug:

- `transform_ops.ts:177` hardcodes `['mesh', 'object', 'litemesh']`.
- `MeshTransType` is **745 lines living in the host**
  (`transform_types.ts:38-782`) — geometry-specific code inside Layer 1.
- `scripts/lite-mesh/litemesh_transtype.ts:202` registers at **module scope**,
  which this project's own addon rules forbid (no module-scope `*.register(...)`).

Plan:

1. Document the 13 methods properly — what each is called with, when, and what
   proportional edit / snapping expect from it. Today the contract is "read
   `MeshTransType`".
2. Move registration onto `AddonAPI` (`api.registerTransType(...)` inside the
   addon's `register(api)` hook).
3. Replace `transform_ops.ts:177`'s literal with a registry query, ordered
   deterministically (registration order is not stable — sort by name).
4. `MeshTransType`'s 745 lines stay put in this plan and **leave with P13**.
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

## 10. Plan of record

1. **Sweep first.** Re-verify every line reference in §3's capability table
   against the tree, and record the result in this document under
   `## Sweep (verified YYYY-MM-DD)`. §9.3 is explicit that both prior rounds of
   errors in the strategy doc were grounding failures; this table is the input
   to the most expensive plan in the refactor.
2. Write `documentation/geometry-contract.md` — prose first, before any TS. If a
   capability cannot be described without naming `Mesh`, it is not yet a
   contract.
3. Land the interfaces as types only, with the BREP and LiteMesh compiling
   against them. No behaviour change; the two implementors are asserted by the
   compiler, not by tests, at this stage.
4. Land the `AddonAPI` cases (§9), each with a trivial test registration.
5. Land the invalidation collapse (§5.1), which is the largest behavioural
   change here — nine call-site families mapped onto one enum, verified by the
   existing viewport tests.
6. Land the vertex-layout contract (§8) with a material carrying an
   `AttributeNode` rendering through **both** compile sites.
7. Move `ITransDataType` registration onto `AddonAPI` and replace
   `transform_ops.ts:177`.

## 11. Tests

- **Two implementors compile.** The BREP and LiteMesh both satisfy every
  interface, with no `as unknown as` escapes. This is the primary gate and it is
  a typecheck, not a runtime test.
- **No new host branch on concrete type.** A grep-based test asserting no
  `instanceof Mesh` / `instanceof LiteMesh` / `.type === 'mesh'` in
  `scripts/core/`, `scripts/scene/`, `scripts/sceneobject/`,
  `scripts/editors/view3d/transform/`. Add it now; it is the regression net for
  P8 and P11.
- **Transform registry**: removing `'litemesh'` from the registry makes
  transform decline it rather than crash; `transform_ops.ts` contains no type
  literal.
- **Vertex layout**: an `AttributeNode` material renders correctly through the
  non-LiteMesh path — today it does not, and that is the point.
- **Invalidation**: existing viewport/transform integration suites green after
  the nine→one collapse.
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
