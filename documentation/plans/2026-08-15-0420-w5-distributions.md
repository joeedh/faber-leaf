# P17 — W5a: distributions + cycle cleanup

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W5 steps 0–2, §5 phase 11, §9.3 P17.

**Workstream / phase:** W5 / phase 11.

**Depends on:** P16. **Blocks:** P20.

**Authoring effort:** high.

**Closes:** success criterion 10.

---

## 1. Goal

Replace the hand-ordered entry point with a declared distribution, and ship two
of them from one tree — `faber-leaf` (full) and `faber-leaf-core` (no
sculptcore) — so the mechanism has two consumers from day one.

Plus the thing that has to happen alongside it: kill the load-order fragility,
because a distribution manifest makes addon load order *arbitrary* and the tree
currently depends on it being fixed.

## 2. Step 0 — the packaging test, before anything else

`tests/integration/tetmesh_real_build.test.ts` is the **only** test that
`tools/build-addons.js` produces a working external per-addon bundle with a
correct `index.json` dependency entry. Everything in this workstream rests on
that pipeline.

P13 was instructed to re-point it before deleting `tetmesh`. **Verify that
happened.** If it did not, the pipeline has been uncovered since P13 and
re-pointing it is this plan's first commit, not its last.

LeafMesh is the natural target — zero dependencies, same as `tetmesh` had. A
purpose-built fixture addon is also fine and is arguably better, since it will
not drift as LeafMesh grows.

## 3. Step 1 — the distribution manifest

`scripts/entry_point.js` today is a hand-ordered list of side-effect imports
with comments explaining TDZ hazards ("Must come AFTER the mesh default_scene
import so this builder wins"). That is not embeddable and it is barely
maintainable.

```ts
// distributions/faber-leaf/index.ts
export default defineDistribution({
  addons: [litemesh, sculpt, boxmodel, uv_editor, node_editor, leafmesh],
  defaultScene: 'litemesh-sphere',
  branding: {title: 'Faber Leaf'},
})
```

```ts
// distributions/faber-leaf-core/index.ts
export default defineDistribution({
  addons: [leafmesh, leafmesh_modeling, uv_editor, node_editor],
  defaultScene: 'leafmesh-cube',
  branding: {title: 'Faber Leaf Core'},
})
```

- `entry_point` becomes generic: load the distribution, register its addons
  through the P14 resolver, build the default scene through P7's
  `registerDefaultSceneBuilder`.
- `tools/esbuilder.js` takes `--distribution <name>`; the default is
  `faber-leaf`.
- **A distribution is a manifest + entry file, not a fork.** Nothing in
  `distributions/*/` may contain product logic. If something needs to differ
  beyond addon set / default scene / branding, that is a missing addon
  boundary — fix it there. Enforce with a size budget: a distribution file over
  ~50 lines is a smell.
- Build assets follow the addon set (P16 step 3), so `faber-leaf-core` does not
  try to copy the WASM artifacts.

`faber-leaf` is what ships and what developers run. `faber-leaf-core` exists to
serve embedders **and** to keep the boundary from rotting — re-point P16's
`--no-sculptcore` CI lane at it, so the lane builds a real product rather than a
crippled full build.

### 3.1 What `faber-leaf-core` contains

Frozen here, from P12's decision #8: LeafMesh plus the modeling toolmode at
P12 §4's scope, the UV editor (P18), and the node/material editor. No
sculptcore, no LiteMesh, no sculpting.

If P12's scope was cut, this list shrinks with it — reconcile against P12's
final §4 rather than against its plan.

## 4. Step 2 — the load-order fragility

`framework_api.ts` carries comments about export ordering to dodge TDZ ("MUST be
re-exported BEFORE context.ts"); `builtin_registry.ts` has import-order comments
too. Those are circular-dependency smells, and today they are survivable only
because the load order is hardcoded.

A distribution manifest makes load order **data**. P14's resolver sorts
deterministically, but a distribution can legitimately list addons in any order
and a third party will. Under a cycle, that turns a fixed hazard into a
non-deterministic crash.

- Run `pnpm cyclecheck`, publish the count in this document, and drive it to a
  clean baseline. The BREP delete (P13) should already have cut it sharply —
  measure before assuming.
- Gate it in CI at the achieved baseline, ratcheted the way P1 ratcheted
  `check:layers`.
- Remove the ordering comments **only** once the cycle they dodge is gone.
  Deleting the comment while keeping the cycle is worse than either.
- Add a test that loads the same distribution with its addon list shuffled and
  asserts identical resulting state. That is the direct test of the property
  that matters, and it is cheap.

## 5. Tests

- **Criterion 10**: both distributions build from one tree, boot, and pass a
  smoke test. No file exists in one distribution's source that does not exist in
  the other's — the only difference is the manifest.
- **Packaging**: the re-pointed external-addon build test passes, including the
  `index.json` dependency entry.
- **Shuffle test** (§4): distribution addon order does not affect resulting
  state.
- `pnpm cyclecheck` at or below the published baseline, gated.
- `faber-leaf-core` runs the P12 modeling flow end to end; `faber-leaf` runs the
  full sculpt suites.
- Both distributions' `.wproj` files interoperate to the degree P10 defines:
  a core-written file opens in full, and a full-written file opens in core with
  LiteMesh blocks preserved-but-inert.

## 6. Risks

- **The packaging test is already dead.** Mitigation: §2 checks first.
- **`defineDistribution` grows product logic.** Mitigation: the 50-line budget
  and the "manifest + entry file, not a fork" rule, stated in the file's own
  header.
- **Cycles cannot be driven to zero.** Then the shuffle test will be flaky
  rather than green, and that is the signal. An unresolvable cycle gets a dated
  exemption naming the plan that closes it, same rule as P9.
- **`faber-leaf-core` becomes a second-class build nobody runs.** Mitigation:
  it *is* the `--no-sculptcore` CI lane, so it runs on every PR.
- **Two distributions diverge in behaviour** through addon-conditional code
  spreading. Mitigation: `api.has(...)` (P14) is the only sanctioned form, and
  it belongs in addons, never in the host.

## 7. Exit criteria

- Criterion 10: `faber-leaf` and `faber-leaf-core` both build, boot and smoke
  from a single tree, differing only in their distribution manifest.
- `tools/esbuilder.js --distribution <name>` works; `entry_point` contains no
  addon-specific import.
- An external-mode addon packaging test exists and passes.
- `pnpm cyclecheck` is gated at a published baseline and the TDZ ordering
  comments are gone (or the surviving cycles carry dated exemptions).
- The shuffle test passes.
- P16's `--no-sculptcore` lane is re-pointed at `faber-leaf-core`.
