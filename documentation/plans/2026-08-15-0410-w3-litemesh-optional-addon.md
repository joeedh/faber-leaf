# P15 — W3a: LiteMesh becomes an optional addon

**Status:** in progress — §3 steps 4 and 6 decided 2026-08-19.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W3 step 1, §5 phase 10, §9.3 P15.

**Workstream / phase:** W3 / phase 10.

**Depends on:** P13 (the BREP is gone), P14 (optionality is real).
**Blocks:** P16.

**Authoring effort:** high — a move plus five edge cuts.

---

## 1. Goal

Move `scripts/lite-mesh/` and the sculpt/boxmodel toolmodes out of the host and
into `addons/builtin/litemesh/`, declared optional, so that the entire
sculptcore-dependent half of the application sits behind one gate.

## 2. Why this is the shape

30 files, ~15,318 lines, and **30+ files importing `@sculptcore/api`**. Almost
all of them end up inside this addon. Once they do, "does this build have
sculptcore?" has exactly one answer site: is the litemesh addon registered.

Absent sculptcore, the addon does not register. That is the whole mechanism.

## 3. Cut the host edges first

`scripts/` → `lite-mesh` edges. Line numbers **re-measured 2026-08-19**;
the 2026-08-15 originals are in parentheses where they drifted.

| Site | Kind |
| --- | --- |
| `scripts/data_api/api_define.ts:50` (was 63) | `import '../lite-mesh/litemesh.js'` — side-effect |
| `scripts/editors/view3d/view3d_draw_webgpu.ts:55` (was 50) | `buildSolidTexturedWgsl` from `litemesh_wgsl.js` — **cut 2026-08-19** |
| `scripts/framework_api.ts:226` (was 157) | `export {LiteMesh} from './lite-mesh/index.js'` — the hub re-exports it |
| `scripts/editors/view3d/tools/boxmodel.ts:28,29` (was 27,28) | `SelectLoopLiteMeshOp`, `SelectNearestLiteMeshOp`, `localRay`, `LiteMesh` |
| `scripts/entry_point.js:38,43` (was 70,75) | side-effect imports of `litemesh_test_scene.js` and `litemesh_default_scene.js` |
| `scripts/webgpu/stencil_compute.ts` | stranded — assigned here by the strategy; **stays**, 2026-08-19 |
| `scripts/renderengine/renderengine_realtime.ts:1250,1393` (was 1253) | already duck-typed; verify it stays that way |

The `sculptcore*.ts` toolmode files (`sculptcore.ts:37`,
`sculptcore_bindings.ts:6`, `sculptcore_gpu_stroke.ts:21`,
`sculptcore_ops.ts:3`) also import LiteMesh — those **move with it**, so they
are not edges to cut. P4's `stroke_driver_native.ts` no longer names LiteMesh
at all; it moves in §4 for cluster cohesion, not because it is an edge.

Everything else that says "LiteMesh" in `scripts/` is already a comment, a
duck-typed check, or a feature-flag *description string*
(`feature-flag.ts:231,238,245` — §6's subject). That is the baseline §9's
`grep` criterion is measured against.

Cuts, in order:

1. **`api_define.ts:50`** — replace the side-effect import with the P7/P8
   `registerDataKind` contribution from the addon's `register(api)`. Same
   pattern P8 applied to the mesh addon; this is its second use.
2. **`framework_api.ts:226`** — delete. A host hub re-exporting a concrete
   geometry type is the coupling in its purest form. Consumers move to
   `@addon/litemesh/api`.
3. **`entry_point.js:38,43`** — default scene and test scene become
   `registerDefaultSceneBuilder` contributions (P7 §9). This is also what P17
   needs: a distribution picks its default scene, it is not hardcoded in the
   entry point.
4. **`view3d_draw_webgpu.ts:55`** — `buildSolidTexturedWgsl` is shader
   construction for a specific geometry type. Either it moves into the addon and
   is supplied through the material/vertex-layout contract (P7 §8), or it is
   genuinely generic and moves into `scripts/shaders/`. Decide by reading it;
   do not leave a LiteMesh-named symbol imported by a host draw file.
   **Decided 2026-08-19: generic → `scripts/shaders/wgsl_shaders.ts`.** See §3.1.
5. **`boxmodel.ts:28,29`** — the boxmodel toolmode moves into the addon
   wholesale. It is a LiteMesh toolmode.
6. **`stencil_compute.ts`** — same question as `brush_compute.ts` in P5: generic
   GPU seam (stays) or LiteMesh-shaped (moves). Read it.
   **Decided 2026-08-19: generic GPU seam → stays in `scripts/webgpu/`.** See §3.1.

Cutting these **before** the move keeps the move mechanical and keeps
`check:layers` interpretable throughout. Two of them can only be *partly* done
that way: cuts 1 and 2 hand their responsibility to `addons/builtin/litemesh/`,
which does not exist until §4. They are therefore cut **as part of** the move
commit; cuts 4 and 6 are the reads, and they land first.

### 3.1 Steps 4 and 6 — the two read-and-decide cuts (landed 2026-08-19)

**`buildSolidTexturedWgsl` is generic — moved to `scripts/shaders/wgsl_shaders.ts`**,
next to `buildMaterialVertexLayout` / `buildMaterialPipelineDescriptor`, whose
family it belongs to. The evidence is the *binding convention*: it declares
`@group(0)` frame, `@group(1)` material texture+sampler, `@group(2)` object —
which is `wgsl_shaders.ts`'s convention, and explicitly **not** the one
`litemesh_wgsl.ts`'s own header describes ("sculptcore's `WebGPUBatchExecutor`
only binds `@group(0)` per draw, so … are packed into a single
`SpatialUniforms` struct"). Its vertex layout is P7's material contract
(position/normal at 0/1, requested attrs from 2), and its caller
(`updateSolidTexturedDrawShader`) is already fully duck-typed over
`setDrawShader`/`setRequestedAttrs`/`attrItems`. Nothing about it is LiteMesh
except the file it happened to be sitting in. A second geometry type with a
TEXTURED draw mode needs exactly this function, which is the test §8 states.

What is left in `litemesh_wgsl.ts` is now uniformly the sculptcore spatial
`ShaderDef` ports, so the file moves with the addon without a caveat.

**`stencil_compute.ts` is a generic GPU seam — it stays in `scripts/webgpu/`.**
Its only import is `./flags`; its API is `stencilAmplify(device, levels,
srcPositions)` (a CSR SpMV chain) and `tessFinalize(device, count, pos, nor,
tan, topo, vdm?)`, both parameterized entirely by `GPUDevice` + typed arrays.
Its inputs are *multires-grid*-shaped, not LiteMesh-shaped — and multires grids
are a sculptcore store, so any geometry type that materializes CC levels
through the engine reaches this the same way. It is the `brush_compute.ts`
answer from P5, for the same reason. The addon imports it through
`@framework/api`; the hub does not export these symbols yet, so §4 adds
`stencilAmplify` / `tessFinalize` / `StencilLevel` / `TessTopoInputs` /
`TessVdmInputs` to `framework_api.ts` as part of the move.

Note what the bit-consistency contract in that file's header means for the
decision: the `fma` chain has to match `StencilTable::eval` bit-for-bit, and
the stage-1 gate compares GPU readback against the CPU-materialized level. That
gate is a *host* gate over a *host* device. Moving the kernel into an addon
would put the reference implementation and the thing it is pinned to on
opposite sides of an optional boundary.

## 4. The move

`git mv scripts/lite-mesh/ addons/builtin/litemesh/src/`, plus the sculpt and
boxmodel toolmodes from `scripts/editors/view3d/tools/`, plus P4's
`stroke_base.ts` cluster (`stroke_base.ts`, `stroke_driver.ts`,
`stroke_driver_native.ts`, `stroke_paint_op.ts`) — P4 deliberately deferred
their final home to this plan so the cluster moves once.

`manifest.json`:

```jsonc
{
  "id": "litemesh",
  "buildMode": "prebuilt",
  "optional": true,
  "dependencies": [],
  "optionalDependencies": []
}
```

`"optional": true` is meaningful because P14 made it so. `dependencies` is empty
— the `mesh` dependency every builtin used to carry died with P13.

The sculptcore *addon* (`addons/builtin/sculptcore/`) also exists; decide
whether litemesh depends on it (`"dependencies": ["sculptcore"]`) or whether the
two merge. Prefer keeping them separate with a required dependency: the
sculptcore addon is the engine binding, litemesh is the geometry type. One gate
is still one gate, because a required dependency that is absent disables the
dependent (P14).

Use `git mv` throughout (repo convention) so history follows.

## 5. Serialization is the risk, not the move

This is the **first time P10's unknown-addon machinery runs on data users
actually have.** Every existing `.wproj` contains LiteMesh blocks, sculpt
toolmodes, and — where sculpt layers or multires are in use — engine-owned
stores.

Verify explicitly, on real files from `examples/`:

- A LiteMesh DataBlock survives load→save with the addon disabled, bytes and
  `lib_id` intact, and re-opens live with the addon enabled.
- The serialized toolmode array (`scene.ts:354`) tolerates a sculpt toolmode
  that is not registered — P5 added the fallback; this exercises it.
- Sculpt layers and multires stores round-trip as opaque data.
- Struct names are unchanged by the move. A file move must not rename a struct;
  if any struct name embeds a module path, P4's rule applies — keep the name or
  add a migration entry.

If any of this fails, it is a P10 defect and it must be fixed in P10's files,
because the same failure will hit every third-party addon.

## 6. Feature flags

`feature-flag.ts` hardcodes the sculptcore flags in host code
(`:64,103-131,174-249,254`). Those flags describe addon features. Moving them is
P16's step, but note the interaction here: a flag registered by the host for a
feature in a disabled addon shows up in the UI as a knob that does nothing.
Either move them with the addon now, or accept the cosmetic issue for one plan
and record it — do not leave it undecided.

## 7. Tests

- **The gate**: the app boots with the litemesh addon force-disabled (P14's
  mechanism), reaching a viewport with LeafMesh available and no LiteMesh. Not a
  crash, not an empty screen with an error toast.
- With the addon enabled, **everything still works**: full sculptcore
  integration suites on both backends, the GPU brush suite, the stroke tester,
  the boxmodel toolmode.
- §5's serialization checks on real `examples/*.wproj` files.
- `pnpm check:layers`: `core-no-litemesh` and `core-no-sculptcore` still hold at
  `error` — they were flipped in P9 at zero and must remain at zero. This plan
  is the one most likely to violate them, which is why they were flipped early.
- `pnpm typecheck` — the addon's sources are in the program (P1 step 3) and
  `@addon/litemesh/api` resolves through P1's generated `paths`.

## 8. Risks

- **A missed host edge only shows at runtime.** Type-only edges compile;
  side-effect imports do not appear in a symbol grep. Mitigation: after the
  move, `grep -rn "lite-mesh\|litemesh\|LiteMesh" scripts/` must return only
  comments. The measured list in §3 already shows the survivors are mostly
  comments — keep it that way.
- **`buildSolidTexturedWgsl` and `stencil_compute.ts` get moved without being
  read**, taking generic shader/GPU code into an addon where a second geometry
  type cannot reach it. Mitigation: §3 steps 4 and 6 are reads, not moves.
- **Serialization breaks on real user files.** Mitigation: §5, on `examples/`
  rather than on fixtures.
- **The move is huge and the diff is unreviewable.** Mitigation: land §3's cuts
  as individual commits first; then the move commit is pure `git mv` plus
  manifest.

## 9. Exit criteria

- The app boots with the litemesh addon force-disabled; LeafMesh is available
  and modelling works (P12).
- With it enabled, the full sculptcore integration suites are green on both
  backends and nothing about the sculpt experience changed.
- `grep -rn "lite-mesh" scripts/` returns only comments.
- `core-no-litemesh` and `core-no-sculptcore` hold at `severity: error` with
  zero violations.
- Existing `examples/*.wproj` files round-trip with the addon both enabled and
  disabled.
