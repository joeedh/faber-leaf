# P5 — W2b: delete the TS sculpting stack

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W2 step 1, §5 phase 3, §9.3 P5.

**Workstream / phase:** W2 / phase 3.

**Depends on:** P4 (the inheritance edge must already be cut).
**Blocks:** P13.

**Authoring effort:** high — a delete whose difficulty is checklist completeness.

**Settles:** open decision #5 (texture painting).

> Line/size references carried from the strategy doc and its
> [adversarial review](../research/2026-08-15-faber-leaf-adversarial-review-architecture.md).
> Re-verify before editing.

---

## 1. Goal

Remove the TypeScript PBVH sculpting implementation. Sculpting continues to work
through sculptcore, which is the only sculpting backend the target architecture
has.

## 2. Why now

W2 is the workstream with the fewest inbound edges once P4 has cut the
inheritance one, so it converts a large amount of code into deleted code early
and cheaply. It also removes a second sculpting implementation that every
subsequent plan would otherwise have to keep working.

Deleting the *TS* PBVH stack does not remove sculpting; it removes the
duplicate. Sculptcore is the implementation.

## 3. The deletion set

| Path | Size / note |
| --- | --- |
| `scripts/editors/view3d/tools/pbvh.ts` | 2,584 lines |
| `…/pbvh_base.ts` | 1,698 lines after P4's hoist (was 2,073); still holds `PaintOpBase` / `PaintOpMesh`, which P4 deliberately left here |
| `…/pbvh_bvhdef.ts` | |
| `…/pbvh_holefiller.ts` | |
| ~~`…/pbvh_paintsample.ts`~~ | **gone** — P4 `git mv`'d it to `stroke_base.ts`, which **survives**. Do not delete it. |
| `…/pbvh_sculptops.ts` | **6,196 lines — the fifth-largest file in the tree** |
| `…/pbvh_texpaint.ts`, `…/pbvh_texpaint_blur.ts` | see §5 |
| `…/pbvh_ui.ts` | |
| `addons/builtin/pbvh_sculpt/src/{main,api}.ts` + `manifest.json` | the addon shell |
| `scripts/test/test_sculpt.js`, `scripts/test/test_sculpt_run.js` | |
| the `@framework/api` surface that exists only for `pbvh_sculpt` | see step 4 |

Eight `pbvh*.ts` files after P4, ~14,560 lines total.

Also remove `tools.ts:10`'s bare `import './pbvh_base.js'`. P4 left it in place
on purpose — it is a side-effect registration import, and it is the last edge
closing the short `stroke_base → view3d → tools.ts → pbvh_base → stroke_base`
cycle. P4 raised the `no-circular` budget by 4 to land; **P5 pays it back** —
see that plan's §5 and `tools/layer-baseline.json`'s `$exception`.

**`pbvh_sculptops.ts` is not leaf code.** At 6,196 lines it contains ToolOps
with registered tool paths, keymap entries, and very likely UI panel references.
Budget it as a real read: every `tooldef().toolpath` in it is a Class F
string-keyed edge that a keymap or a saved toolstack may hold.

## 4. Explicitly out of scope

The BREP-side sculpting-adjacent files leave with **P13**, not here:

- `mesh_grids*.ts`, `mesh_displacement.ts`, `multigrid_smooth.js`,
  `mesh_remesh.js`

They are BREP data structures that happen to be used by sculpting, not sculpting
code. Deleting them here would entangle W2 with W1 for no benefit.

Also out of scope: `scripts/lite-mesh/`, the sculptcore toolmode, the stroke
driver, and anything under `addons/builtin/sculptcore/`. Those are the surviving
implementation.

## 5. Open decision #5 — texture painting

**Recommendation: accept the gap.**

`pbvh_texpaint.ts` / `pbvh_texpaint_blur.ts` implement texture painting against
the TS PBVH. Sculptcore has no texture-paint kernel today. Deleting these
removes the feature.

The alternative — keeping the TS PBVH alive solely to paint textures — keeps
15k lines and a second geometry-traversal implementation alive for one feature,
which is exactly the coupling this refactor exists to remove.

Required if this recommendation is taken:

- Record the regression in `ImmediateTODOs.md` as a named, dated gap with the
  intended replacement (a sculptcore texture-paint kernel behind the existing
  `texpaint_bridge.ts` seam).
- Check `scripts/webgpu/texpaint_bridge.ts` before deleting: if it is a
  generic host↔GPU seam it **stays** (it is the landing pad for the eventual
  replacement); if it is a PBVH adapter it goes.
- Say it out loud in the release notes for the version that drops it. A silently
  removed feature is a bug report.

If instead the decision is to keep texture painting, that is a *port* onto
sculptcore and it becomes its own plan scheduled before this one — do not
resolve it by leaving `pbvh_texpaint.ts` in the tree.

## 6. Plan

### Step 1 — verify P4's exit condition holds

`grep -rn "pbvh" scripts/ addons/ --include=*.ts --include=*.js` from outside
the deletion set. Every remaining hit is a file this plan must edit or delete.
If any surviving file still `extends` a deletion-set class, stop: P4 is not
finished.

### Step 2 — split `scripts/brush/`

`scripts/brush/` mixes the backend-neutral brush *model* with PBVH-specific
implementation:

| File | Disposition |
| --- | --- |
| `brush.ts`, `brush_base.ts`, `brush_dynamics.ts`, `brush_enums.ts`, `brush_ops.ts`, `index.ts` | **stay** — channels, dynamics, presets, the `SculptBrush` DataBlock. Backend-neutral by construction; the brush model is what the UI binds to. |
| `brush_dyntopo.ts` | **delete** — BREP/PBVH dyntopo settings |
| `brush_dyntopo_sc.ts` | **stays** — the sculptcore dyntopo settings |

`SculptBrush` is a serialized DataBlock, so any field removed from it (the
`brush_dyntopo` settings block) is a **file-format change**. Two options:

- Keep the field, reading and ignoring it, until P10 has the generic
  unknown-data machinery. **Preferred** — it is one dead field and it costs
  nothing.
- Or write a migration. Only if the field is actively harmful.

Do not silently drop it: a brush preset saved by the current build must still
load.

### Step 3 — audit `scripts/webgpu/brush_compute.ts`

Same question as `scripts/brush/`: is it a generic GPU brush-dispatch seam, or
a PBVH-node-shaped one? The GPU sculpt brushes that ship today
(`documentation/gpuBrushes.md`) dispatch against sculptcore's node VBOs, so a
generic seam **stays** and a PBVH-shaped one goes. Answer the question with a
read, not a guess — the GPU brush path is live, default-on, and its failure mode
is a silent wrong-looking stroke.

`scripts/webgpu/stencil_compute.ts` is a related stranded file; the strategy
assigns it to P15, so leave it.

### Step 4 — remove the `@framework/api` surface that existed for `pbvh_sculpt`

Symbols exported from `scripts/framework_api.ts` (the `@framework/api` hub)
solely so `pbvh_sculpt` could import them are now dead. Remove them in the same
change — a hub export with no consumer is a coupling waiting to be re-created.

Every symbol removed here must be checked against `addons/builtin/*/src/api.ts`
shims first; a symbol re-exported by another addon's api shim is not dead.

### Step 5 — keymaps, tool paths, and the toolmode list

- Remove `pbvh_sculpt`'s entries from any default keymap.
- Remove its ToolMode from the toolmode registry. Note `scene.ts:354`'s toolmode
  array is *serialized*, so a `.wproj` saved with the PBVH sculpt toolmode
  active carries it. P10 builds the general machinery for this; until then, the
  reader must tolerate an unknown toolmode by falling back to the default rather
  than throwing. **Verify this specifically** — it is the most likely
  user-visible breakage from this plan.
- Remove its `manifest.json` and its entry from `IN_BUNDLE_BUILTIN_IDS` /
  `addon_register.ts`. Note that `manifest.ts:163-165` throws on an unknown
  *dependency*, so any addon declaring `pbvh_sculpt` as a dependency must be
  updated in the same commit. (Today none do — every builtin declares `mesh` —
  but re-check.)

### Step 6 — delete

One commit, `git rm`. Do not stage the delete across several commits: the tree
does not compile in between.

## 7. Tests

- `tests/integration/sculptcore_*.test.ts` green on both backends
  (`SC_TEST_BACKEND=wasm`, then `native`) — sculpting still works.
- The headless stroke tester (`window._sculptcoreStrokeTester`) drives a real
  stroke end to end.
- **New**: load `examples/*.wproj` files that were saved with the PBVH sculpt
  toolmode active and assert they open with a sane toolmode rather than
  throwing. Add at least one such fixture *before* deleting, since after the
  delete it cannot be created.
- A brush preset saved by the pre-delete build still loads (step 2).
- `pnpm test`, `pnpm typecheck`, `pnpm check:layers` at or below P1's baseline —
  this plan should move the layer count **down**.

## 8. Risks

- **`pbvh_sculptops.ts` hides string-keyed edges.** 6,196 lines of ToolOps with
  registered paths. Mitigation: step 1's grep plus an explicit sweep of
  `toolpath` strings in that file before deleting.
- **Texture painting disappears without anybody deciding it should.**
  Mitigation: §5 makes it an explicit, recorded decision with a release note.
- **A serialized toolmode or brush field breaks old files.** Mitigation: step 2
  keeps the brush field; step 5 adds the toolmode fallback and step 7 adds the
  fixture.
- **`brush_compute.ts` is deleted when it was the live GPU path.** Mitigation:
  step 3 is a read, and the GPU brush suite must stay green.

## 9. Exit criteria

- Sculpting works end to end through sculptcore; the integration suites are
  green on both backends.
- `grep -rn "pbvh" scripts/ addons/` returns nothing.
- `scripts/brush/` contains only backend-neutral brush model code plus
  `brush_dyntopo_sc.ts`.
- Open decision #5 is recorded as settled in the strategy doc's §9.4 table, with
  the `ImmediateTODOs.md` entry and release note in place if the gap was
  accepted.
- The layer-violation count is at or below P1's baseline.
