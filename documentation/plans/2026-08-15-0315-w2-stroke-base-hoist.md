# P4 — W2a: hoist the stroke base

**Status:** landed 2026-08-16. The sweep in §2 is the measured one; the
strikethroughs record where the 2026-08-15 draft was wrong.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W2 step 0, §5 phase 3, §9.3 P4.

**Workstream / phase:** W2 / phase 3.

**Depends on:** P1. **Blocks:** P5 (and therefore P13).

**Authoring effort:** high — the difficulty is enumeration, not reasoning.

---

## 1. Goal

Break the inheritance edge from the **surviving** sculptcore stroke stack into
the **deleted** PBVH stack, so that P5 can be a delete rather than a rewrite.

An earlier draft of the strategy called W2 "leaf code with almost no inbound
dependencies" and scheduled it as the low-risk opener. That is false in the
most direct way possible: `SculptCorePaintMode` — the toolmode this refactor
keeps — extends `PaintToolModeBase`, which lives in the files being deleted.

## 2. Current state / Sweep (measured 2026-08-16)

Step 1's sweep, run against the tree rather than the 2026-08-15 snapshot. The
draft table listed six edges; there are **fifteen**, and two of the six were
wrong.

Class E (inheritance and struct) edges from surviving code into `pbvh_*`:

| Surviving file | Imported from the deletion set |
| --- | --- |
| `scripts/editors/view3d/tools/sculptcore.ts` | `PaintToolModeBase` — `SculptCorePaintMode` **extends** it |
| `…/sculptcore_ops.ts` | `PaintSample`, `SymAxisMap` |
| `…/sculptcore_bindings.ts` | `PaintSample` |
| `…/stroke_paint_op.ts` | `PaintSample`, `PaintSampleProperty`, `BrushProperty`, `PaintToolModeBase` |
| `…/stroke_driver.ts` | `PaintSample` |
| `…/stroke_driver_native.ts` | `PaintSample` |
| `…/pbvh.ts` | `PaintToolModeBase` (deletion-set file, re-pointed anyway) |
| `…/pbvh_bvhdef.ts`, `…/pbvh_holefiller.ts` | `PaintSample`, `BrushProperty`, `PaintSampleProperty` |
| `…/pbvh_sculptops.ts`, `…/pbvh_texpaint.ts` | `PaintSample`, `SymAxisMap` |
| `scripts/test/test_sculpt.js`, `…/test_sculpt_run.js` | `PaintSample` |
| `addons/builtin/pbvh_sculpt/src/api.ts`, `…/main.ts` | `PaintToolModeBase` |

Corrections to the draft table:

- `stroke_driver_native.ts` imports **`PaintSample`**, not `PaintToolModeBase`.
- `stroke_paint_op.ts` imports four symbols, not two — including
  `PaintToolModeBase`, which it narrows `ctx.toolmode` against in `modalEnd`.
- The two `scripts/test/` drivers and the `pbvh_sculpt` addon shell were missing
  entirely. Neither is reachable by grepping `scripts/editors/view3d/tools/`.
- ~~`StrokeProperty`~~ does not exist anywhere in the tree.
- ~~`SculptTools`, `BrushSpacingModes`~~ already live in `scripts/brush/`, which
  is host code and survives. Nothing to hoist.

Nothing else the step-1 checklist named turned up: no `nstructjs` struct string
names a `pbvh` module, no `tooldef().toolpath` under a `pbvh.*` namespace is
referenced from a keymap or saved toolstack, and `TOOL_TO_SCULPTBRUSH` is
keyed on `SculptTools` values, not module paths.

`tools.ts:10`'s bare `import './pbvh_base.js'` is a side-effect registration
import and is **deliberately left in place** — P5 removes it along with the file.

Sizes: `pbvh_base.ts` 2,073 → 1,698 lines, `pbvh.ts` 2,584,
`pbvh_paintsample.ts` 300 → `stroke_base.ts` 699.

**Serialization constraint.** `examples/brush_asymmetric_toolstack.wproj`
already embeds `BrushProperty`, `PaintSample` and `PaintSampleProperty` in a
serialized toolstack (`scripts/core/appstate.ts:370-371` writes it when the
user-facing `save_toolstack` option is set; `:712-714,949-960` reads it back).
So these struct names are **on disk today**.

## 3. Non-goals

- Deleting anything. Not one file is removed in this plan.
- Moving the stroke stack into an addon. `scripts/lite-mesh/` and the sculpt
  toolmode become an addon in P15; doing it here would couple two independent
  risks.
- Refactoring the stroke driver's design. See
  [strokeDriverReport.md](../strokeDriverReport.md) — the architecture is
  fine, it is only in the wrong file.

## 4. Plan

### Step 1 — the Class E sweep

Before moving anything, produce the *complete* list, not the six edges above.
Grep for every symbol exported by `pbvh_base.ts` and `pbvh_paintsample.ts` and
find its consumers outside the `pbvh_*` set. Record the list in this document
under `## Sweep (measured YYYY-MM-DD)`.

Things the grep must specifically cover, because they are not `import` lines:

- `extends` clauses (the actual hazard).
- `nstructjs` struct names — a class whose `STRUCT` string names a `pbvh`
  module is on disk regardless of where the file lives.
- ToolOp `tooldef().toolpath` strings under a `pbvh.*` namespace that a keymap
  or a saved toolstack references.
- `TOOL_TO_SCULPTBRUSH`-style tables (see the
  `reference_add_sculpt_brush` checklist) that map tool names to brushes.

### Step 2 — create `stroke_base.ts`

**As built: 699 lines, not ~1,700**, containing, with **no BREP imports**:

- `PaintSample`, `PaintSampleProperty` (`git mv`'d whole from
  `pbvh_paintsample.ts`, which is why the file keeps its history)
- `BrushProperty`, `BRUSH_PROP_TYPE`, `BrushPropTypes`
- `SymAxisMap`
- **all** of `PaintToolModeBase`

Three drafting errors, corrected against the tree:

- ~~`StrokeProperty`, `SculptTools`, `BrushSpacingModes`~~ — see §2.
- ~~the non-BVH *half* of `PaintToolModeBase`~~. Read whole, the class is
  already BREP-free: it holds brush/symmetry/dyntopo state and abstract
  `drawBrush`. There is no half to leave behind, so the §6 risk ("the hoisted
  module drags BREP imports along") did not materialize and nothing had to be
  handed to P7.
- ~~`PaintOpBase`~~ is deliberately **not** hoisted, nor is `PaintOpMesh`.
  Their only consumers are files P5 deletes; hoisting them would move BVH-typed
  code into the surviving module for no one's benefit. They stay in
  `pbvh_base.ts` and die with it.

Location: host-owned for now —
`scripts/editors/view3d/tools/stroke_base.ts`, alongside the existing
`stroke_driver.ts` / `stroke_paint_op.ts`, which are already host files. P15
moves the whole cluster into `addons/builtin/litemesh/` as one unit; splitting
the move across two plans would double the churn for no gain.

**What stays behind in `pbvh_base.ts`:** everything that touches the PBVH
itself — BVH node types, the BVH-driven sample gathering, `PaintOpBase` and
`PaintOpMesh`. `pbvh_base.ts` then imports `stroke_base.ts`, inverting the
dependency. It is deleted whole in P5.

### Step 3 — preserve the struct names

The hoist must not change any `nstructjs` struct name, because
`brush_asymmetric_toolstack.wproj` and any user file with `save_toolstack` set
carries them.

Two options; pick per symbol:

- **Keep the name.** `PaintSample.STRUCT` stays `PaintSample` (or whatever it
  is today, verbatim) even though the file moved. nstructjs keys off the struct
  name, not the module path, so a pure file move is invisible to the format.
  **This is the default and should cover every symbol.**
- If a name genuinely must change, add an entry to
  `scripts/core/legacy_struct_migration.ts`'s rename table — but note that
  table's entries currently point *into* the deletion set and P8 rewrites it,
  so coordinate rather than adding debt.

Every symbol took the default: not one struct name changed, so
`legacy_struct_migration.ts` was left alone.

Verified by `tests/unit/stroke_base_struct_names.test.ts`, which reads the
schema out of `examples/brush_asymmetric_toolstack.wproj`'s header directly
(`WPRJ` + u32 version + u32 schema length + the schema as text) and checks it
against the `inlineRegister` bodies in `stroke_base.ts`. Reading the header
rather than booting the app keeps this in the unit suite; the assertion is
*on-disk fields ⊆ source-declared fields*, not equality, because the committed
example predates several field additions and a reader only needs somewhere to
put every value the file actually carries.

### Step 4 — re-point the surviving imports

Update the fifteen files in §2 to import from `stroke_base.ts`. Nothing else
changes; the classes are the same classes.

### Step 5 — verify the stroke path end-to-end

The hoist touches the class hierarchy of the live sculpt stack, so a compile is
not evidence.

- Headless: drive a real stroke through `window._sculptcoreStrokeTester`, which
  runs the actual `SculptPaintOp` (`is_modal=false` + `execTool`) — see
  [debugStrokeGuide.md](../debugStrokeGuide.md). The op path **is** testable;
  do not skip this on the grounds that it is modal.
- The `sculptcore_*` integration suites must be green on both backends
  (`SC_TEST_BACKEND=wasm`, then `native`).
- `stroke_driver_parity.test.ts` specifically, since `stroke_driver_native.ts`
  is one of the re-pointed files.

## 5. Tests

- Existing `tests/integration/sculptcore_*.test.ts` and
  `stroke_driver_parity.test.ts` green on both backends — these are the
  regression net and they already exist.
- New: a round-trip test asserting the struct-name set of
  `examples/brush_asymmetric_toolstack.wproj` is unchanged across the hoist.
  This one is cheap and it is the only thing standing between a file move and a
  silent format break. Landed as `tests/unit/stroke_base_struct_names.test.ts`
  (6 tests) — see step 3 for why it reads the header instead of round-tripping.
- ~~`pnpm check:layers` does not regress against P1's baseline.~~ **It does, by
  4 on `no-circular`, and the budget was raised to 773 / total 2487.** This is
  the one sanctioned increase in the refactor and it is structural, not a
  mistake: `pbvh_paintsample.ts` had *zero* cycle edges (it imported only
  `bezier`, `pathux` and `view3d_base`), while `stroke_base.ts` inherits the
  four imports that come with `BrushProperty` / `PaintToolModeBase` —
  `view3d_toolmode` (the `ToolMode` base class), `widgets` (`WidgetFlags`),
  `view3d` (`View3D`) and `proceduralTex` (`new ProceduralTex()`). All four
  route back through `tools/tools.ts → sculptcore.ts → stroke_base`, so
  `stroke_base` joins the app-wide SCC and contributes 4 outbound + 12 inbound
  edges; `pbvh_base.ts` shed 10 in exchange. None of the four is severable —
  each symbol is used as a value or as the base class, and type-only edges are
  counted here (`tsPreCompilationDeps: true`).

  ~~**P5 must pay this back.**~~ **Paid, 2026-08-16: 773 → 713** (total
  2487 → 2318), below the pre-P4 769. Deleting the nine `pbvh*.ts` files and the
  `tools.ts` side-effect import removed the inbound edges and closed the short
  `stroke_base → view3d → tools.ts → pbvh_base → stroke_base` cycle outright.
  `tools/layer-baseline.json`'s `$exception` key has been replaced by a `$note`
  recording the repayment; P9 step 1 has nothing left to reconcile.

  **This hoist was incomplete.** `pbvh_base.ts` also held three registered
  ToolOps, two of which (`brush.set_radius`, `brush.set_radius_mode`) are
  geometry-agnostic — they touch only `PaintToolModeBase` and `SculptBrush` —
  and are invoked by the *surviving* sculptcore toolmode's keymap and header
  strip. They belonged in this hoist. P5 found them (via a toolpath-string
  sweep, since `tsgo` cannot see a string) and moved them to `stroke_base.ts`.
  See P5 §0.6.

## 6. Risks

- **A missed `extends`.** Mitigation: step 1's sweep is written down in this
  document, and P5's exit criterion is a mechanical grep for inbound edges.
- **Struct-name drift during the move.** Mitigation: step 3's round-trip test.
- **The hoisted module drags BREP imports along.** If `PaintToolModeBase`'s
  non-BVH half turns out to reference `Mesh`, that reference is the actual
  boundary — push it down into the PBVH half rather than widening
  `stroke_base.ts`. If it cannot be pushed down, say so here and hand the
  problem to P7 (the geometry contract), which is where a host↔geometry
  question belongs.

## 7. Exit criteria

All met 2026-08-16.

- [x] `grep -rn "from '\./pbvh" scripts/editors/view3d/tools/sculptcore*.ts scripts/editors/view3d/tools/stroke_*.ts`
  returns nothing.
- [x] No surviving file `extends` a class defined under `pbvh_*` or
  `addons/builtin/pbvh_sculpt/`.
- [x] Sculpting works end-to-end: `sculptcore_stroke_tester`,
  `sculptcore_brushes`, `sculptcore_parity` and `stroke_driver_parity` are green
  on both backends (53/53 native, 50 + 3 skipped wasm).
- [x] `examples/brush_asymmetric_toolstack.wproj` round-trips with an unchanged
  struct-name set.
