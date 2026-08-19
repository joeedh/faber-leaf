# P16 — W3b: sculptcore build decoupling

**Status:** done — steps 1–6 landed.

Sections below marked **Landed** record what was actually built, which in
steps 1–3 is not what was planned; the reasoning is kept because it is the
part P17 inherits.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§1, §4 W3 steps 2–4, §5 phase 10, §9.3 P16.

**Workstream / phase:** W3 / phase 10.

**Depends on:** P15. **Blocks:** P17.

**Authoring effort:** high.

**Closes:** success criteria 3 and 4; contributes to 9.

---

## 1. Goal

`git submodule deinit sculptcore` must yield a tree that installs, typechecks,
builds, boots, and runs its tests — **while the sculptcore-present build stays
the default and stays exactly as easy to work in as it is today.**

Both halves are the deliverable. A boundary that is real but makes normal
development worse will be undone.

## 2. The submodule stays

Open decision #10 is resolved: **no**, the submodule does not go away. It
remains the default acquisition path. Explicitly **out of scope**:

- a `setup:sculptcore` clone script,
- `sculptcore.lock.json`,
- any replacement for `git submodule`.

The deliverable is *tolerance of absence*, not a new acquisition mechanism.

## 3. What still reaches into sculptcore from the host

| Site | |
| --- | --- |
| `tools/esbuilder.js:37,46` | copies `sculptcore/typescript/build/sculptcore-browser.{wasm,js}` into the bundle as explicit entries; `:67` also globs `*/build/sculptcore.js` |
| `scripts/entry_point.js:37,47,71` | direct sculptcore reach-through (the plan’s `:83,93` was a stale snapshot) |
| `scripts/webgl/batch.ts`, `scripts/webgpu/batch.ts`, `scripts/webgpu/brush_compute.ts`, `scripts/sculptcore_demo.ts` | host modules built on sculptcore types — missed by the 2026-08-15 survey |
| `scripts/core/feature-flag.ts:64,103-131,174-249,254` | **the sculptcore feature flags are hardcoded in host code** |
| `pnpm-workspace.yaml` | six sculptcore paths listed literally; an absent path is a hard failure |
| `tsconfig.json` | no `@sculptcore/api` mapping at all — it resolves purely through the pnpm workspace symlink, so removing the submodule breaks typecheck with a confusing error |

That table is the pre-work survey; every row is closed. The four host modules
moved into the litemesh addon (`git mv`, step 3); `entry_point.js` and
`esbuilder.js` go through the availability predicate; the flags moved to the
addon (step 5); and `pnpm-workspace.yaml`/`tsconfig.json` needed no change at
all once the dependency became an `optionalDependencies` `workspace:*` (step 1).
No file under `scripts/` imports from sculptcore any more — which is what the
step-6 lane now keeps true.

## 4. Plan

### Step 1 — the dependency moves to the addon — **Landed**

The premise was half wrong. Measured on pnpm 10.30.3 (pinned by the root
`packageManager` field):

| | absent target |
| --- | --- |
| workspace **path**, literal | tolerated |
| workspace **path**, glob matching nothing | tolerated |
| `dependencies: workspace:*` | **hard fail** `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` |
| `devDependencies: workspace:*` | **hard fail**, same error |
| `optionalDependencies: workspace:*` | tolerated; links normally when present |

So `pnpm-workspace.yaml` needed no change at all — the glob rewrite was
unnecessary, and the six literal paths stay. The half that was right is the one
that mattered: the `workspace:*` **dependency** is the hard failure, so it had to
move off the host and be declared optional.

What landed:

- `addons/builtin/litemesh/package.json` — new workspace package, with
  `@sculptcore/api` and `@litestl/typescript-runtime` in **`optionalDependencies`**.
  That field is not a preference here; per the table it is the only `workspace:`
  field that tolerates absence.
- `scripts/package.json` — both entries deleted. Zero source references to either
  package remain under `scripts/`, so the host no longer depends on the engine
  even nominally.

This is also the availability signal steps 2 and 3 turned out to need, so it did
double duty.

### Step 2 — the addon leaves the build, not the engine — **Landed, differently**

**The types-only stub was rejected.** litemesh imports four `@sculptcore/api`
subpath families (`api`, `sculptcore/brush/*`, `sculptcore/gpu/*`,
`sculptcore/mesh/*`) across 41 import sites. A stub covering that is not
"`IWasmInterface` and nothing else" — it is a large hand-written surface whose
only job is to let code compile that can never run, and it carries exactly the
drift risk §6 already names. Nor was moving litemesh out-of-bundle an option: it
has 192 relative imports into `scripts/` across 34 files, and untangling those is
P17's distribution work.

The rule that replaced it:

> **A builtin addon whose optional workspace dependency is absent is not part of
> this build.**

Absent, not stubbed — the same state force-disable produces, reached from the
install instead of from a flag. Nothing has to compile against an engine that is
not there, so there is no stub to drift.

`tools/builtin_addons.js` (new) is the single predicate: for each
`addons/builtin/<id>/manifest.json`, every `workspace:` entry in that addon's
`optionalDependencies` must resolve under the addon's `node_modules/` or the repo
root's. It has four consumers, so the representations cannot disagree:

| Consumer | Unavailable |
| --- | --- |
| `tools/gen-tsconfig-paths.mjs` | `@builtin/<id>` -> `scripts/addon/unavailable_builtin.ts`; `addons/builtin/<id>` joins the generated `exclude` |
| `tools/esbuilder.js` alias | same, so the subtree never enters the bundle |
| `tools/esbuilder.js` assets | the manifest's `buildAssets` contribute nothing |
| `AddonManager.registerBuiltin` | sees the `unavailableBuiltin` sentinel, records `unloaded` reason `not-in-build` |

Two TS-config facts forced the shape. A child config's `exclude` **replaces** its
base's outright, so `exclude` could not be split between `tsconfig.json` and the
generated base — it moved wholesale into the generated file. And `exclude` only
filters the *initial* file set, so an excluded file that an included file imports
still joins the program: it is the `@builtin/<id>` alias, not the exclusion, that
actually keeps the source out.

The predicate, the sentinel module, the `not-in-build` reason and the
`@builtin/<id>` alias are all documented in [addons.md](../addons.md).

### Step 3 — `tools/esbuilder.js` — **Landed as planned**

The WASM and JS artifact copies became a `buildAssets` field on the addon
manifest (`{entryPoints, external}`, validated by `scripts/addon/manifest.ts`
like every other field — an unknown key is still an error).
`collectBuildAssets()` gathers it from the *available* addons only, so an absent
addon contributes nothing and its artifacts stop being a missing-file error.

`tools/esbuilder.js` now contains no `sculptcore` reference of any kind,
including in comments.

### Step 4 — `scripts/entry_point.js` — **Landed**

The reach-through (actually `:37,47,71`) is gone. It did two things, and they
needed different homes:

- **Engine boot.** `scripts/core/boot_tasks.ts` (new) is a tiny registry —
  `registerBootTask` / `unregisterBootTask` / `listBootTasks` / `runBootTasks` —
  awaited at the end of `AddonManager.start()`. litemesh's `register()` reads its
  own `getArg('backend')` and registers `loadWasm()` as its boot task, so the host
  neither names the engine nor knows a backend flag exists.
- **Host modules built on sculptcore types.** `scripts/webgpu/batch.ts`,
  `scripts/webgl/batch.ts` and `scripts/webgpu/brush_compute.ts` moved into the
  addon (`gpu_batch.ts`, `gl_batch.ts`, `brush_compute.ts`);
  `scripts/sculptcore_demo.ts` was deleted. The §3 survey missed all four.

Verified on both backends headlessly: the startup scene still contains a
`LiteMesh`, which is the proof the boot task ran — `buildLiteMeshDefaultScene`
executes inside `appstate.init` and cannot construct one from a cold engine.
`--backend native` additionally reports `__nativeManager` live, so the addon's own
argv handling reaches sculptcore.

### Step 5 — feature flags — **Landed**

All eleven flags in `feature-flag.ts` were `sculptcore.*`, so moving them left
the host with **zero** — which is the right end state, not an accident: a flag
describes a feature and features live in addons.

- `addons/builtin/litemesh/src/feature_flags.ts` holds all eleven, verbatim —
  same keys, same descriptions, same defaults. `api.registerFeatureFlags(...)`
  (the seventh `AddonAPI` case) is called first thing in `register()`, before
  anything can read one: an unregistered key reads `false`, so a late
  registration would silently take the default path for one boot.
- **`getDataAPI()` is one-shot and runs before addons start**, so a flag
  registered by an addon cannot ride on `defineAPI`. `registerFeatureFlags`
  declares each member against the live `_appstate.api` too; `defineAPI` and the
  addon path share `defineFeatureFlagMember` and are de-duplicated by
  `markDefined`, so neither can double-declare. The consequence is that
  `settings.featureFlags.*` leaves the generated path catalog — exactly as the
  addon's other paths already had.
- **Persistence is untouched.** Storage stays keyed by flag name under
  `feature-flags-app`, and the per-key `mtime` merge already preserved unknown
  keys, so a build without the addon keeps values it cannot interpret and hands
  them back when the addon returns. Nothing was renamed.
- **Typo-checking survived the move without the host naming a key.**
  `FeatureFlagKeys` is now `keyof FeatureFlagRegistry`, a `declare global`
  interface each addon merges its own keys into. With every augmentation absent
  it degrades to `string` — looser, never wrong, and it is what makes the
  sculptcore-free typecheck pass.
- `get` on an unregistered key returns `false` rather than throwing, and
  `set`/`reset` create the stored row on demand, so a settings blob carrying an
  absent addon's flags loads. **Criterion 9's flag half is closed.**

Verified headlessly in both configurations. With sculptcore present: 11
definitions, all 11 resolving as datapaths against the live API, a set-via-path
round-trip, and an unknown key reading `false`. With it absent: 0 definitions, 0
settings entries, `unloaded: litemesh:not-in-build`, and the app still boots.

### Step 6 — the `--no-sculptcore` CI lane — **Landed**

`.github/workflows/pr.yml` gained a third job, `no-sculptcore`, running beside
the two that were already there. The full lane is untouched and still primary.

The lane is: checkout `submodules: recursive` → `git submodule deinit -f
sculptcore` → `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm build`
→ `pnpm smoke:no-sculptcore`. No emsdk, no CMake, no WASM cache.

- **`actions/checkout` cannot init a subset of submodules**, so the lane takes
  all of them and drops one. path.ux, mathl and nstructjs are not optional; the
  app does not boot without them. The deinit step then *asserts* `sculptcore/`
  is empty, because a silently-failed deinit would make the whole job test the
  default configuration.
- **`--frozen-lockfile` survives the deinit.** pnpm discovers workspace packages
  from the filesystem, and the six sculptcore importers recorded in
  `pnpm-lock.yaml` are skipped rather than treated as drift — measured locally
  at 9 resolved projects against a 15-importer lockfile, frozen check green.
  This is what step 1's `optionalDependencies` choice bought.
- **The static gates are not sufficient on their own** — typecheck and build
  both pass on a tree that boots to a blank error screen — so the lane ends in
  `tools/no-sculptcore-smoke.mjs`: boot NW.js headlessly, assert `litemesh` is
  recorded `not-in-build` and that zero feature flags are registered (step 5),
  enable `leafmesh`, run its modelling demo (cube + tube, 12 ToolOp steps with
  undo and replay checked at each), fingerprint the geometry, `createFile` →
  `loadFile`, and require the fingerprint back.
- **The script refuses to run when litemesh is available** (exit 2, overridable
  with `--allow-sculptcore` for development). Without that, any step that
  quietly kept the engine would turn this job into a slower copy of `test` —
  green, and testing the wrong thing.

Verified locally against a build with `@sculptcore/api` unresolvable: predicate
`litemesh: not in this build`, bundle 14.1 mb against 17.4 mb, boot reports
`litemesh:not-in-build` and `flagDefs: 0`, both demo shapes model with
`undoRestoresBase` and `replayMatchesFinal` true, and a 58 KB `.wproj` round-trips
to an identical fingerprint.

P17 re-points it at the `faber-leaf-core` distribution.

## 5. Tests

- The `--no-sculptcore` lane, green, as described. **Done** — `pnpm
  smoke:no-sculptcore`, run against a locally-simulated absent engine.
- The **full** lane unchanged: same commands, same speed, same developer
  experience. If `pnpm i && pnpm build` gets slower or gains a step, that is a
  regression against criterion 4.
- Feature-flag persistence: a `localStorage` settings blob written by the
  current build loads under the new registration scheme with every flag value
  preserved.
- A settings blob containing flags for an absent addon loads without error and
  without those flags appearing in the UI.
- `pnpm typecheck` green **both** with and without the submodule. **Done** —
  and now gated, one job each.

## 6. Risks

- **Bit-rot of optionality** — the named risk this plan is built around.
  Mitigation: step 6's lane, and it must be a required check, not an
  informational one. The job exists; **marking it required is a repo-settings
  change only an admin can make**, and is still outstanding — same as the
  `layers` job P9 left behind.
- ~~**pnpm's glob tolerance is not what we assume.**~~ Measured in step 1: globs
  and literal paths are both tolerated, `workspace:*` dependencies are not. No
  workspace-file generation needed.
- ~~**The types-only stub drifts from the real interface.**~~ Retired with the stub
  itself (step 2). The replacement has no surface to drift: an unavailable addon
  compiles nothing, so there is nothing to keep in sync.
- **The availability predicate and the build disagree.** The new form of the drift
  risk, and why `tools/builtin_addons.js` is one function with four consumers
  rather than three parallel implementations. Mitigation: step 6's lane exercises
  all four at once.
- **Feature-flag key drift silently resets user settings.** Mitigation: step 5's
  key-identity rule plus the persistence test.
- **The full build gets harder to work in.** Explicitly a failure. If a step
  makes the default configuration worse, find another way.

## 7. Exit criteria

- **Met.** Criterion 3: with the submodule deinitialized, `pnpm i`,
  `pnpm typecheck`, `pnpm build` and a headless boot all succeed, and the smoke
  test models a LeafMesh cube.
- **Met.** Criterion 4: the full sculptcore-present lane still gates merges and
  is no harder to work in than before — same commands, same two jobs, and the
  third runs beside them rather than in front of them.
- **Outstanding, admin-only.** The `--no-sculptcore` lane is a required CI
  check. The job is committed; flipping it to required is a repo setting.
- **Met.** Sculptcore's feature flags are registered by their owning addon with
  their `localStorage` keys unchanged.
- **Met.** `tools/esbuilder.js`, `scripts/entry_point.js` and
  `scripts/core/feature-flag.ts` contain no sculptcore reference. One mention
  survives, in an `entry_point.js` comment naming sculptcore's WASM as the
  example of a boot task an addon might own — prose, not a dependency.
- **Met.** The sculptcore submodule is still the default acquisition path; no
  clone script or lockfile was added.
