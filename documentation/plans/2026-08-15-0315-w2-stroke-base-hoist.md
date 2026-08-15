# P4 — W2a: hoist the stroke base

**Status:** plan — not started.

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

## 2. Current state

Class E (inheritance) edges from surviving code into `pbvh_*`:

| Surviving file | Imports from the deletion set |
| --- | --- |
| `scripts/editors/view3d/tools/sculptcore.ts:22` | `PaintToolModeBase` from `./pbvh_base` — `SculptCorePaintMode` **extends** it |
| `scripts/editors/view3d/tools/sculptcore_ops.ts:27,28` | `PaintSample` from `./pbvh_paintsample`, `SymAxisMap` from `./pbvh_base` |
| `scripts/editors/view3d/tools/sculptcore_bindings.ts:9` | `PaintSample` |
| `scripts/editors/view3d/tools/stroke_paint_op.ts:13,14` | `PaintSample`, `PaintSampleProperty` |
| `scripts/editors/view3d/tools/stroke_driver.ts:14` | `PaintSample` |
| `scripts/editors/view3d/tools/stroke_driver_native.ts:21` | `PaintToolModeBase` |

Sizes (verified by the review): `pbvh_base.ts` 2,073 lines, `pbvh.ts` 2,584,
`pbvh_paintsample.ts` 300.

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

New module (~1,700 lines) containing, with **no BREP imports**:

- `PaintSample`, `PaintSampleProperty`
- `BrushProperty`
- `SymAxisMap`
- `StrokeProperty`, `SculptTools`, `BrushSpacingModes`
- the non-BVH half of `PaintToolModeBase` and `PaintOpBase`

Location: host-owned for now —
`scripts/editors/view3d/tools/stroke_base.ts`, alongside the existing
`stroke_driver.ts` / `stroke_paint_op.ts`, which are already host files. P15
moves the whole cluster into `addons/builtin/litemesh/` as one unit; splitting
the move across two plans would double the churn for no gain.

**What stays behind in `pbvh_base.ts`:** everything that touches the PBVH
itself — BVH node types, the BVH-driven sample gathering, the `Mesh`-typed
halves of `PaintToolModeBase`. `pbvh_base.ts` then imports `stroke_base.ts`,
inverting the dependency. It is deleted whole in P5.

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

Verify by round-tripping `examples/brush_asymmetric_toolstack.wproj` before and
after: load, save, and diff the struct-name set.

### Step 4 — re-point the surviving imports

Update the six files in §2 to import from `stroke_base.ts`. Nothing else
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
  silent format break.
- `pnpm check:layers` does not regress against P1's baseline.

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

- `grep -rn "from '\./pbvh" scripts/editors/view3d/tools/sculptcore*.ts scripts/editors/view3d/tools/stroke_*.ts`
  returns nothing.
- No surviving file `extends` a class defined under `pbvh_*` or
  `addons/builtin/pbvh_sculpt/`.
- Sculpting works end-to-end: the headless stroke tester and the
  `sculptcore_*` integration suites are green on both backends.
- `examples/brush_asymmetric_toolstack.wproj` round-trips with an unchanged
  struct-name set.
