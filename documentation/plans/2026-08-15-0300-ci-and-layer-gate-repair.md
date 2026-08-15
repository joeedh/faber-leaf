# P1 — CI + layer-gate repair

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§2.4, §5 phase 1, §9.3 P1.

**Workstream / phase:** new (from the adversarial review) / phase 1.

**Depends on:** nothing. **Blocks:** everything — P2, P3(soft), P4, P6.

**Authoring effort:** high.

**Closes:** success criteria 0a, 0b, 0c; contributes the CI lane for criterion 4.

> File/line references below were carried from the strategy doc and its
> [adversarial review](../research/2026-08-15-faber-leaf-adversarial-review-architecture.md)
> and spot-checked on 2026-08-15. Re-verify before editing.

---

## 1. Goal

Make *done* checkable. Every other plan in this refactor ends at "green
`pnpm test` + `pnpm typecheck` + `pnpm check:layers` + a bootable app". Today
none of those three run on a pull request, two of the four layer rules point at
a directory that has not existed since the addon migration, `check:layers`
cannot spawn on Windows, and the typecheck program barely contains the addons.

This plan builds the gates and **publishes the real violation baseline**. That
baseline number, not today's vacuous `288 warnings / 0 errors`, is the budget
W1 is scheduled against.

## 2. Why this goes first

Opening with any deletion means deleting against gates that do not run. This
phase is cheap, touches no product code, and is the only one that makes the
other thirteen verifiable. It is also the phase that produces the estimate the
rest of the schedule needs.

## 3. Current state

| Fact | Evidence |
| --- | --- |
| The only workflow is a deploy | `.github/workflows/deploy-pages.yml` — builds + deploys on push to `master`; runs no test, typecheck, lint, or layer check |
| That workflow is sculptcore-shaped | `:29-32` recursive submodule checkout, `:73-95` emsdk install + WASM build from source, `:105-130` coi-serviceworker for COOP/COEP (`SharedArrayBuffer`) |
| Two layer rules are dead | `.dependency-cruiser.cjs:23,39` — `core-no-mesh` / `util-no-mesh` target `to: {path: '^scripts/mesh/'}`; that directory does not exist |
| `core-no-addons` is carved out | `:51-52` — `from` covers only `^scripts/(core\|util\|scene\|sceneobject)/`, and `dependencyTypesNot: ['type-only']` permits type imports. Direct-dependency only, so `core/context.ts → tet/tetgen.js → addons/builtin/mesh/src/bvh.js` is invisible |
| The renderer is excluded from the graph | `:67-79` `options.exclude.path` drops `scripts/renderengine` and `scripts/shadernodes` |
| Windows spawn failure | `tools/check-layers.js:22` — `execFile('npx.cmd', …)` without `shell: true` → `spawn EINVAL` |
| The gate only fails on `error` | `check-layers.js` exits non-zero only when depcruise does, and every rule is `severity: warn` |
| Typecheck is entry-point-scoped | root `tsconfig.json` uses `"files": ["scripts/typescript_entry.ts", "scripts/data_api/generated/datapaths.ts"]`, not `include` — addon sources enter the program only through that entry's mesh imports, which W1 deletes |
| `scripts/tsconfig.json` has no `paths` | so anything under `scripts/` importing `@addon/<id>/api` typechecks only from the repo root |
| Root `paths` lists seven addons by hand | `tsconfig.json` — `@addon/{mesh,subsurf,mesh_edit,curve,pbvh_sculpt,sculptcore,tetmesh}/api`; no `@sculptcore/api` mapping at all (it resolves purely through the pnpm workspace symlink) |
| `test` / `typecheck` run through turbo | `package.json:22-23` — `turbo typecheck`, `turbo test`; `turbo.json` declares both tasks with `dependsOn: ["^…"]` |

## 4. Non-goals

- Driving the violation count to zero. That is P9. This plan **measures**.
- Adding the `--no-sculptcore` lane. That is P16 — it cannot pass yet.
- Changing any rule's severity to `error`. Also P9.
- Restructuring turbo's task graph beyond what CI needs.

## 5. Plan

### Step 1 — repair `.dependency-cruiser.cjs`

Land as one commit, with the before/after counts in the commit message.

- `core-no-mesh`, `util-no-mesh`: `^scripts/mesh/` → `^addons/builtin/mesh/`.
- `core-no-addons`: drop the `scripts/editors/` rationale from the comment and
  widen `from` to include `^scripts/(editors|tet|hair|render|renderengine|shadernodes|webgpu|shaders)/`.
  Keep `core-no-view3d-tools` as-is; it is still meaningful.
- Split the type-only exemption into its own visible rule,
  `core-no-addons-typeonly` (`severity: warn`, `dependencyTypes: ['type-only']`),
  so type leaks are *counted* rather than silently permitted. Class A leaks
  (`lib_api.ts`, `context.ts`, `editor_base.ts`, `transform_base.ts`) should
  show up here and nowhere else.
- Remove `scripts/renderengine` and `scripts/shadernodes` from
  `options.exclude.path`. Leave `scripts/path.ux`, `scripts/mathl`,
  `scripts/extern`, `sculptcore`, `build`, `dist` excluded.
- Add two rules that do not fire today and must never start:
  `core-no-litemesh` (`from: ^scripts/(core|util|scene|sceneobject)/`,
  `to: ^scripts/lite-mesh/`) and `core-no-sculptcore`
  (`to: '@sculptcore/'` — match the alias, since `sculptcore/` is
  `doNotFollow`). Both `warn` for now; P9 flips them.

Because `core-no-addons` is direct-dependency-only, add
`{path: '^addons/', dependencyTypesNot: ['type-only'], reachable: true}` as a
*separate* rule (`core-no-addons-transitive`) rather than changing the existing
one. Transitive reachability is what catches `core → tet → mesh`, and keeping
it separate keeps the two numbers legible.

### Step 2 — fix `check-layers.js`

- `tools/check-layers.js:22` — spawn through `shell: true` on win32, or resolve
  the depcruise binary directly from `node_modules/.bin` and spawn `process.execPath`
  against its JS entry (preferred: no shell quoting hazard).
- Add `--exit-code-on-warn` behaviour behind a flag: `--max-warnings <n>`,
  defaulting to the published baseline, so the count can only go **down**
  before P9 flips severities. This is the ratchet mechanism P9 inherits.
- Print a per-rule summary table (rule name → count) so the baseline is
  reviewable, not a single number.

### Step 3 — widen the typecheck program

- Root `tsconfig.json`: replace `files` with
  `"include": ["scripts/**/*.ts", "addons/**/*.ts", "tools/**/*.mjs"]` plus the
  existing generated datapaths, and `"exclude"` for `scripts/path.ux`,
  `scripts/mathl`, `node_modules`, `build`, `dist`, `addons/**/pending-port/**`.
  Expect new errors; fix or `// @ts-expect-error` with a tracking comment.
- Add a `paths` block to `scripts/tsconfig.json` mirroring the root one so
  `@framework/api` and `@addon/<id>/api` resolve from inside `scripts/`.
- Generate the `@addon/<id>/api` path entries from the on-disk addon list at
  typecheck time (a small `tools/gen-tsconfig-paths.mjs`, run by
  `pnpm gen:paths`) rather than hand-maintaining seven literals — P11, P14 and
  P15 all add addons, and a hand-maintained list is how the leafmesh/litemesh
  entries get forgotten.
- If the include-widening turns out to be a multi-day fix-up, land it as its
  own commit after steps 1–2 rather than blocking the workflow.

### Step 4 — the PR workflow

New `.github/workflows/pr.yml`, `on: [pull_request]` plus `push: [master]`,
running the **full sculptcore-present configuration** (§1 of the strategy: that
is the default and the merge gate).

Jobs:

1. `install` — checkout with `submodules: recursive`, pnpm, node, cache.
2. `typecheck` — `pnpm typecheck` (runs `gen:paths` first).
3. `lint` — `pnpm eslint .` and `pnpm format:check`.
4. `layers` — `pnpm check:layers` with the published `--max-warnings` baseline.
5. `test` — `pnpm test`. Excludes `tests/integration/slow.mjs` suites by
   construction; add a nightly `test:slow` schedule separately.

Sculptcore build cost is the risk. Budget it explicitly here:

- Reuse `deploy-pages.yml:73-95`'s emsdk install and WASM build, but cache the
  emsdk install and the sculptcore build directory keyed on the submodule SHA
  plus `DEPS_REVISION`.
- If a cold full lane exceeds ~20 min, split: a fast `pr-fast.yml` (typecheck,
  lint, layers, unit tests) that gates every PR, and the sculptcore integration
  lane gating merge to `master`. **Do not** solve a slow full lane by gating on
  a cheaper configuration — the merge gate stays sculptcore-present.

### Step 5 — publish the baseline

Append a `## Baseline (measured YYYY-MM-DD)` section to *this document* with:

- total violations after step 1, broken out per rule;
- the `core-no-addons` / `core-no-addons-transitive` split, which is the W1
  budget proper;
- the `core-no-addons-typeonly` count, which is the Class A set and should
  evaporate for free at P13;
- the `no-circular` count, which P17 inherits.

P9 re-measures against this table and is not allowed to start from a fresh one.

## 6. Tests

- **Negative test for the layer gate**: a CI job that adds a deliberate
  `scripts/core/` → `addons/builtin/mesh/` value import in a scratch commit and
  asserts `check:layers` fails. Run it as a one-off during this plan and record
  the output; do not keep it in the workflow.
- **Negative test for typecheck**: introduce a deliberate type error in
  `addons/builtin/mesh/src/` and confirm `pnpm typecheck` fails. This is
  criterion 0c and it is the one most likely to silently not hold.
- **Windows**: `pnpm check:layers` must run clean on win32 (the primary dev
  platform), not only in CI's Linux container.

## 7. Risks

- **Widening the typecheck program surfaces a large error backlog** in addon
  code that has never been type-checked. Mitigation: land the widening
  separately from the workflow so the workflow is not blocked by it; if the
  backlog is large, gate `typecheck` on the widened program only after the
  backlog is cleared, and record the count here.
- **A slow full lane invites gating on a cheap one.** Explicitly rejected
  above; if it happens, it silently reverts criterion 0a.
- **Baseline drift.** Between P1 and P9 the number moves as other plans land.
  The `--max-warnings` ratchet is what keeps it monotone; update the number in
  the same PR that reduces it.

## 8. Exit criteria

- 0a — a PR workflow runs `pnpm test`, `pnpm typecheck`, `pnpm eslint`,
  `pnpm check:layers` on the full sculptcore-present configuration and blocks
  merge on failure.
- 0b — `check:layers` runs clean on Windows; the repaired rules target
  `^addons/builtin/mesh/`, include `scripts/editors/`, `scripts/tet/` and
  `scripts/hair/` in their `from` sets, count type-only imports in a dedicated
  rule, and no longer exclude `renderengine` / `shadernodes`.
- 0c — a deliberate type error in an addon source file fails CI.
- The baseline section of this document is filled in.
