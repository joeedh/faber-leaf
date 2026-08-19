# P17 — W5a: distributions + cycle cleanup

**Status:** landed — steps 0, 1 and 2 all complete.

**Citations note:** the file:line references below were a 2026-08-15 snapshot
taken before any of this work landed. Where step 1 found one stale, the text is
corrected in place and marked **(corrected 2026-08-19)** — the plan is kept
honest rather than left as a record of what the tree used to look like.

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

**Verified (2026-08-19):** P13 did re-point it. `tetmesh_real_build.test.ts` is
gone and `tests/integration/leafmesh_real_build.test.ts` covers the same ground,
including the `index.json` entry (`buildMode: "prebuilt"`, `dependencies: []`).
The pipeline was never uncovered, so this was not a commit.

## 3. Step 1 — the distribution manifest

**(corrected 2026-08-19)** `scripts/entry_point.js` was described here as a
hand-ordered list of side-effect imports with TDZ comments ("Must come AFTER the
mesh default_scene import so this builder wins"). By the time this step ran, W1
had already collapsed that to a single side-effect import of
`addons/builtin/builtin_registry.ts` — the *ordering* hazard was gone, but the
hardcoded product was not, which is what this step actually removed.

```ts
// distributions/faber-leaf/index.ts — as landed
import {bundled, defineDistribution, external} from '../../scripts/addon/distribution'
import * as litemesh from '@builtin/litemesh'
import litemeshManifest from '../../addons/builtin/litemesh/manifest.json'

export default defineDistribution({
  id   : 'faber-leaf',
  title: 'FaberLeaf',
  addons: [bundled(litemeshManifest, litemesh), external('leafmesh')],
  defaultScene: 'litemesh-sphere',
})
```

```ts
// distributions/faber-leaf-core/index.ts — as landed
import {defineDistribution, external} from '../../scripts/addon/distribution'

export default defineDistribution({
  id   : 'faber-leaf-core',
  title: 'FaberLeaf Core',
  addons: [external('leafmesh', {enabled: true})],
  defaultScene: 'leafmesh-cube',
})
```

- `entry_point` becomes generic: one `import distribution from '@distribution'`,
  then `addon.loadDistribution(distribution)` before `startAddons(true)`.
  `addons/builtin/builtin_registry.ts` is deleted.
- `tools/esbuilder.js` takes `--distribution <name>`; the default is
  `faber-leaf`. `tools/distributions.mjs` reads the two facts the build needs
  out of the entry file's *source* — what `@distribution` resolves to, and which
  `@builtin/<id>` specifiers it imports — rather than evaluating it.
- **A distribution is a manifest + entry file, not a fork.** Nothing in
  `distributions/*/` may contain product logic. If something needs to differ
  beyond addon set / default scene / branding, that is a missing addon
  boundary — fix it there. Enforce with a size budget: a distribution file over
  ~50 lines is a smell. (Landed at 24 and 20 lines.)
- Build assets follow the addon set (P16 step 3), so `faber-leaf-core` does not
  try to copy the WASM artifacts.
- **The addon list is an allow-list for shipped first-party addons only.** A
  builtin — in-bundle, or a `build/addons/index.json` entry carrying
  `builtin: true` — that the distribution omits is never loaded — no module
  import, no record — the same state `force_disable.ts` produces, so
  `api.has(id)` is correct by construction (reason `not-in-distribution`).
  Two kinds of addon are *not* filtered, because neither is a shipping
  decision: third-party addons the user installed from storage (installing one
  was a user decision), and the `tests/fixtures/addons/*` fixtures, which are in
  the index only when the build was asked for them (`--include-fixtures`) and
  are a harness concern. `index.json` already records the difference as
  `builtin` / `kind`, so the manager reads it rather than inferring it. Both
  exemptions remain force-disablable, which is what
  `addon_optional_probe.test.ts` drives.
- **Named default scenes replaced the one-slot last-wins hook.** P7's
  `registerDefaultSceneBuilder` took a builder and the last registration won,
  which *was itself* the load-order dependency step 2 exists to remove. It now
  takes `(name, fn, toolMode?)` and the distribution selects by name. Fallback:
  with nothing selected and exactly one scene registered, that one is used, so
  unit tests and single-geometry builds keep working.

`faber-leaf` is what ships and what developers run. `faber-leaf-core` exists to
serve embedders **and** to keep the boundary from rotting — P16's
`--no-sculptcore` CI lane is re-pointed at it (`pnpm build:core` →
`pnpm smoke:core`), so the lane builds a real product rather than a crippled
full build.

### 3.1 What `faber-leaf-core` contains

**(corrected 2026-08-19)** This section named `sculpt`, `boxmodel`, `uv_editor`,
`node_editor` and `leafmesh_modeling` as addons. None of those exist as addons
in the tree: the modeling toolmode ships *inside* `leafmesh`, the sculpt
toolmode and box-modeling mode ship inside `litemesh`, and the UV / node editors
are host editors, not addons. The plan's rule still holds — reconcile against
what P12 actually shipped, not against its plan — so the honest lists are:

| | `faber-leaf` | `faber-leaf-core` |
| --- | --- | --- |
| `litemesh` | in-bundle, default-on | absent |
| `leafmesh` | external, manifest default (off) | external, forced **on** |
| startup scene | `litemesh-sphere` (sculpt mode) | `leafmesh-cube` (leafmesh mode) |
| feature flags | 11 (all `sculptcore.*`, litemesh-owned) | 0 |

No sculptcore, no LiteMesh, no sculpting in core — which is the frozen decision
#8 requirement. The UV editor arrives with P18 and is a host editor either way.

`faber-leaf-core` needed a startup scene of its own, so `leafmesh` gained
`addons/builtin/leafmesh/src/leafmesh_default_scene.ts` (cube + default material
+ light) registered as `leafmesh-cube`.

## 4. Step 2 — the load-order fragility

`framework_api.ts` carries comments about export ordering to dodge TDZ ("MUST be
re-exported BEFORE context.ts" — `scripts/framework_api.ts:112,115`). That is a
circular-dependency smell, and it is survivable only because the load order is
hardcoded. **(corrected 2026-08-19)** The plan also cited import-order comments
in `builtin_registry.ts`; that file is deleted by step 1, so `framework_api.ts`
is the whole of it.

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

**Landed 2026-08-19.** The finder walks the shipped graph from
`scripts/core/appstate.ts` (320 modules) and found **16** cycles. Every one with
a host file in it is closed; the **9** that remain are wholly inside the vendored
`path.ux` (8) and `mathl` (1) submodules, so the ratchet counts the two owners
separately and budgets host at **0**.

| knot | cycles | fix |
| --- | --- | --- |
| `render/queue_factory` → `webgpu/queue_adapter` → `webgl/simplemesh` | 1 | the adapter imported `simplemesh.ts` for the `PrimitiveTypes` enum alone, dragging in the shader stack and the WebGPU queue with it. The enum family moved to the new zero-import leaf `scripts/webgl/primitive_types.ts`; `simplemesh.ts` re-exports it. |
| `view3d` ⇄ `view3d_toolmode` | 4 | the toolmode base imported the editor that hosts it, for `DrawLine` (already defined in `view3d_base.ts` and merely re-exported by `view3d.ts`) and `ITempText`. `ITempText` moved down beside `DrawLine`/`DrawQuad`; the toolmode imports `view3d_base.ts`. |
| `core/context` → `resbrowser` → `screengen` → `PropsEditor` → ... → back | 2 | both return edges were `ViewContext` imports that never needed a value: one already type-only in `texture/proceduralTex.ts`, one outright unused in `addon/addon_base.ts`. |

`tools/check-cycles.js` + `tools/cycle-baseline.json` are the ratchet, wired into
`pr.yml` as `pnpm cyclecheck`; `pnpm cyclecheck:list` prints the raw report. A
cycle counts as submodule-owned only when **every** member is under `path.ux` or
`mathl`, so a new host cycle routed through a submodule is still host.

The `framework_api.ts` ordering comments are gone on evidence rather than on
faith: the same walk started at `scripts/framework_api.ts` also reports 9 cycles,
all submodule, and `check:layers` holds `core-no-addons`, `core-no-addons-typeonly`
and `core-no-addons-transitive` at 0 — so no host module imports an addon and the
"the chain re-enters the addon before its base class is bound" hazard cannot
arise.

One wart survives, recorded in the baseline's `$note`: `core/context.ts` still
value-imports seven editor classes to use as `getContextArea()` keys. That closes
no cycle now, but it is why core cannot be embedded without the editors; a
name-keyed lookup through `areaclasses` would finish the job.

## 5. Tests

- **Criterion 10**: both distributions build from one tree, boot, and pass a
  smoke test. No file exists in one distribution's source that does not exist in
  the other's — the only difference is the manifest. **Met (2026-08-19)**:
  `tools/distribution-smoke.mjs` (table-driven, one row per distribution) boots
  the built bundle and asserts the distribution id, window title, enabled and
  absent addon ids, feature-flag count, the startup file's object set, and a
  `.wproj` save/load round-trip. `faber-leaf` → 17.5 MB bundle, 11 flags,
  `[LiteMesh, Light]`; `faber-leaf-core` → 14.1 MB bundle, 0 flags,
  `[LeafMeshData, Light]` plus the leafmesh modelling demo. 14.1 MB is the same
  size P16 measured for the sculptcore-deinited build, which is the evidence
  that `faber-leaf-core` on a full tree equals the engine-absent build.
- **Packaging**: the re-pointed external-addon build test passes, including the
  `index.json` dependency entry.
- **Shuffle test** (§4): distribution addon order does not affect resulting
  state. **Met (2026-08-19)**: `tests/unit/distribution_shuffle.test.ts` walks
  all 120 permutations of a five-addon fixture — a required chain, a diamond, an
  optional dependency and an addon whose required dependency is absent — and
  asserts each one yields the same `resolveManifests` order and disabled set and
  the same `isInDistribution` / `distributionEnabled` / `activeDefaultScene`
  answers, plus an anchor assertion that the shared answer is the *right* one
  rather than merely a stable one. It is a true unit test because
  `scripts/addon/distribution.ts` and `scripts/addon/manifest.ts` are both
  zero-import leaves.
- `pnpm cyclecheck` at or below the published baseline, gated. **Met
  (2026-08-19)**: host 0, submodule 9.
- `faber-leaf-core` runs the P12 modeling flow end to end; `faber-leaf` runs the
  full sculpt suites.
- Both distributions' `.wproj` files interoperate to the degree P10 defines:
  a core-written file opens in full, and a full-written file opens in core with
  LiteMesh blocks preserved-but-inert.

**Local-run hazard:** `pnpm build:core` overwrites `build/` in place and the
integration suites run against whatever is sitting there, so a core build
followed by `pnpm test` fails with a wall of unrelated-looking assertions. Run
`pnpm build` again first. CI is unaffected — the two lanes are separate jobs on
separate runners.

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
