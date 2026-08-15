# P1 — CI + layer-gate repair

**Status:** implemented 2026-08-15 on `faber-leaf-refactor`. Steps 1–5 landed;
baseline published in §9. Blocks marked **Correction (landed 2026-08-15)** record
where the plan as written turned out to be wrong — the code follows the
correction, not the original text.

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
>
> Re-verified against the tree during implementation. Every citation in §3 held
> except `.dependency-cruiser.cjs:67-79` (the `exclude` block runs to `:82`;
> `:79` lands mid-array on `'docs'`), corrected below. §3 describes the
> **pre-P1** state and is left as a historical record; the rows added during
> implementation are marked by their content, not by a date.

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
| The renderer is excluded from the graph | `:67-82` `options.exclude.path` drops `scripts/renderengine` and `scripts/shadernodes` |
| Those exclusions are unanchored | `:65,:67-82` — `'sculptcore'` also matches `addons/builtin/sculptcore/` and `scripts/editors/view3d/tools/sculptcore*.ts`; `'build'` / `'dist'` / `'docs'` match anywhere in a path. The graph was silently truncated, so *no* number measured before this plan is trustworthy |
| Type-only edges did not exist in the graph | `options.tsPreCompilationDeps` is unset, so dependency-cruiser analyses the **post**-compilation graph. `dependencyTypesNot: ['type-only']` on `core-no-addons` was therefore a no-op, and any `dependencyTypes: ['type-only']` rule would have reported 0 against 170+ real `import type` statements |
| Windows spawn failure | `tools/check-layers.js:22` — `execFile('npx.cmd', …)` without `shell: true` → `spawn EINVAL` |
| The gate only fails on `error` | `check-layers.js` exits non-zero only when depcruise does, and every rule is `severity: warn` |
| Typecheck is entry-point-scoped | root `tsconfig.json` uses `"files": ["scripts/typescript_entry.ts", "scripts/data_api/generated/datapaths.ts"]`, not `include` — addon sources enter the program only through that entry's mesh imports, which W1 deletes |
| `scripts/tsconfig.json` has no `paths` | so anything under `scripts/` importing `@addon/<id>/api` typechecks only from the repo root |
| `scripts/tsconfig.json` checks **nothing** | its `"files": ["scripts/typescript_entry.ts"]` is resolved relative to `scripts/`, i.e. `scripts/scripts/typescript_entry.ts`, which does not exist. `@sculptcore/frontend#typecheck` is the only turbo task covering frontend code, so `turbo typecheck` had no frontend coverage at all |
| `pnpm eslint .` cannot gate anything | 17,412 errors / 49 warnings on a clean checkout (10,677 `@typescript-eslint/no-shadow`, 1,718 `no-unused-vars`, 1,409 `one-var`), and it OOMs at node's default heap |
| `pnpm format:check` reached into submodules | no `sculptcore/` or `scripts/mathl/` entry in `.prettierignore`, so the parent-repo gate failed on diffs this repo cannot land |
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
  `to: ^scripts/lite-mesh/`) and `core-no-sculptcore`. Both `warn` for now;
  P9 flips them.

  > **Correction (landed 2026-08-15).** `core-no-sculptcore` cannot match the
  > alias `'@sculptcore/'`: dependency-cruiser matches rules against *resolved*
  > paths, and pnpm resolves the workspace symlink to
  > `sculptcore/typescript/api/index.ts`. The rule ships as
  > `to: {path: ['^sculptcore/', '^node_modules/@sculptcore/']}`, and
  > `sculptcore/` stays in `doNotFollow` (anchored) so the module is a graph
  > leaf that the rule can still match. Verified with a scratch
  > `@sculptcore/api` import in `scripts/core/`: the rule fires.

- Set `options.tsPreCompilationDeps: true`. Without it there are no `type-only`
  edges in the graph at all, so `core-no-addons-typeonly` measures nothing.
  Anchor every `exclude` / `doNotFollow` pattern (`^sculptcore/`, `^build/`,
  `^scripts/path\.ux/`, …) — unanchored, they were truncating the graph.

Because `core-no-addons` is direct-dependency-only, add
`core-no-addons-transitive` as a *separate* rule
(`to: {path: '^addons/', reachable: true}`) rather than changing the existing
one. Transitive reachability is what catches `core → tet → mesh`, and keeping
it separate keeps the two numbers legible.

> **Correction (landed 2026-08-15).** The originally-proposed
> `{path: '^addons/', dependencyTypesNot: ['type-only'], reachable: true}` is
> rejected by dependency-cruiser's schema — `reachable` and `dependencyTypes*`
> are mutually exclusive branches of a `oneOf`
> (`data/forbidden/5/to must NOT have additional properties`). The
> `dependencyTypesNot` clause is dropped; the transitive count therefore
> includes type-only edges, which is the conservative direction.

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

  > **Correction (landed 2026-08-15).** Mirroring the root config would leave
  > two programs to keep in sync, and would not have fixed the real problem:
  > `scripts/tsconfig.json`'s `files` entry resolved to the nonexistent
  > `scripts/scripts/typescript_entry.ts`, so the workspace task was checking
  > nothing. It ships as a bare `{"extends": "../tsconfig.json"}` instead —
  > `include`/`exclude` in a base config resolve relative to that base, so the
  > workspace program and the root program are byte-identical (both 501 files,
  > verified with `--listFiles`). One program, one source of truth, and
  > `addons/**` is covered by the only turbo task that covers frontend code.
  >
  > Turbo needed a matching fix: it hashes each package's *own* files, and
  > `addons/` is outside `scripts/`, so an addon-only edit was a cache hit on
  > `@sculptcore/frontend#typecheck` — a stale green. `addons/**/*.ts` and
  > `tsconfig.paths.json` are now in `turbo.json`'s `globalDependencies`.
  > Verified: the §6 negative test fails from a warm cache.
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
3. ~~`lint` — `pnpm eslint`~~ and `pnpm format:check`.

   > **Correction (landed 2026-08-15).** This step assumed `pnpm eslint .` was
   > a viable gate. It is not, and **ESLint is deferred out of P1 entirely** —
   > the workflow ships without a lint step.
   >
   > A clean checkout reports **17,412 errors / 49 warnings**, and the run OOMs
   > at node's default heap. Clearing that is not this plan's job: it is neither
   > "touches no product code" (§2) nor within P9's remit as written. A ratchet
   > was built (`tools/check-lint.mjs` — programmatic ESLint, re-execs with
   > `--max-old-space-size=8192`, per-rule budgets in `tools/lint-baseline.json`,
   > fails when a rule's count grows, budget 0 for any rule not in the
   > baseline). It works and is wired to `pnpm check:lint`, but it is **not in
   > CI**: ratcheting a backlog nobody has triaged locks in ~17k violations as
   > acceptable, at tens of minutes of CI wall-clock per PR. Triage first, then
   > gate. That decision belongs to P9, which is the plan that owns the lint /
   > layer cleanup.
   >
   > Three real ESLint-configuration bugs were found on the way and **are**
   > fixed here, since they mislead anyone who runs `pnpm eslint` by hand:
   >
   > - `globalIgnores` never excluded build output. `.prettierignore` skips
   >   `build/`, but ESLint has no `.gitignore` awareness, so `eslint .` was
   >   type-aware-linting the esbuild bundles — 43 MB of generated JS including
   >   a single 25 MB `build/entry_point.js`.
   > - ESLint 10 resolves the config file from each *linted file's* directory
   >   upward, not from the cwd. `scripts/path.ux/` and `scripts/mathl/` carry
   >   their own `eslint.config.js`, so those submodules were being linted under
   >   their own rules — the root `globalIgnores` entries for them were dead.
   >   Both `pnpm eslint` and `check-lint.mjs` now pin the root config
   >   (`--config eslint.config.js` / `overrideConfigFile`).
   > - Consequently the 17,412 figure is not a measurement of *this repo's*
   >   backlog — it counts bundle and submodule noise. Whoever picks this up
   >   should re-measure rather than trust it.
   >
   > `pnpm format:check` *is* viable, once scoped, and does ship as a gate:
   > `.prettierignore` had no `sculptcore/` or `scripts/mathl/` entry, so the
   > parent-repo gate was failing on submodule files. With those (and generated
   > output) ignored, 26 files needed formatting — all tooling, tests, and two
   > `scripts/lite-mesh/` helpers. They were formatted here, and the gate is
   > green and blocking.
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

### Status at implementation (2026-08-15)

| Criterion | State | Evidence |
| --- | --- | --- |
| 0a | met **minus the `pnpm eslint` clause**; one manual step outstanding | `.github/workflows/pr.yml` runs `pnpm typecheck`, `pnpm format:check`, `pnpm check:layers`, `pnpm test` on `pull_request` + `push: master`, sculptcore-present. ESLint deferred to P9 — see the §5 step 4 correction |
| 0b | met | `pnpm check:layers` exits 0 on win32; rules target `^addons/builtin/mesh/`, `HOST` covers `editors`/`tet`/`hair`/`renderengine`/`shadernodes`, `core-no-addons-typeonly` counts type-only edges, renderer no longer excluded |
| 0c | met | §6 negative test: a bad annotation in `addons/builtin/mesh/src/mesh_ops.ts` fails `pnpm typecheck` from a warm turbo cache |
| Baseline | met for layers; **lint baseline deliberately not published** | §9 |

**Deferred out of 0a:** the `pnpm eslint` clause. P1's job was to make "done"
checkable, not to adopt a 17k-violation backlog as the definition of done. The
ratchet tooling is in the tree (`pnpm check:lint`) and the ESLint config bugs
that made the number meaningless are fixed; wiring it into CI waits on P9
triaging the backlog. Nothing else in 0a changed.

**Outstanding manual step for 0a:** a workflow file does not by itself block a
merge — the `checks` and `test` jobs have to be marked as required status
checks in the repository's branch-protection settings for `master`. That is a
GitHub repo setting, not a file in this tree, and it has not been done. Until
it is, the gates *run* and report but do not *block*, which is exactly the
silent half-measure risk §7 warns about.

---

## 9. Baseline (measured 2026-08-15)

Measured on branch `faber-leaf-refactor` with the repaired
`.dependency-cruiser.cjs` (step 1) via `pnpm check:layers`, cruising
`scripts` + `addons`. Committed machine-readably as
`tools/layer-baseline.json`; `pnpm check:layers --update-baseline` regenerates
it, and `--list <rule>` prints the offending edges.

**The pre-P1 figure of `288 warnings / 0 errors` was not merely vacuous, it was
wrong.** Two rules pointed at a directory deleted in the addon migration, the
renderer was excluded, and — the part not anticipated by the plan — every
`exclude` / `doNotFollow` pattern was unanchored, so `'sculptcore'` silently
dropped `addons/builtin/sculptcore/` and the view3d sculptcore tools from the
graph entirely. No number measured before this plan should be reused.

### Totals

| | |
| --- | --- |
| Modules cruised | 527 |
| Violations | **2,483** warn / 0 error / 0 info |

### Per rule

| Rule | Count | Who inherits it |
| --- | ---: | --- |
| `core-no-mesh` | 2 | W1 |
| `core-no-view3d-tools` | 0 | — (holds; must not start) |
| `util-no-mesh` | 0 | — (holds; must not start) |
| `core-no-addons` | 65 | **W1 — the budget proper** |
| `core-no-addons-typeonly` | 15 | P13 (evaporates for free) |
| `core-no-addons-transitive` | 1,632 | W1, indirectly |
| `core-no-litemesh` | 0 | — (holds; must not start) |
| `core-no-sculptcore` | 0 | W3 (must not start) |
| `no-circular` | 769 | P17 |

### The `core-no-addons` / `core-no-addons-transitive` split

65 direct value edges from a host layer into `addons/`, against 1,632 modules in
`scripts/(core|util|scene|sceneobject)/` that *reach* addon source at all. The
ratio is the point: severing the 65 named imports is the mechanical part, and
the 1,632 is what tells you whether it worked. A W1 that lands 65 → 0 while the
transitive count stays four figures has moved imports around, not severed a
layer.

Neither number is the count of *files* to edit — dependency-cruiser counts
edges, and one module can carry several.

### The `core-no-addons-typeonly` set (Class A)

15 edges, and the strategy's predicted Class A members are all present and
account for four of them:

- `scripts/core/context.ts`
- `scripts/core/lib_api.ts`
- `scripts/editors/editor_base.ts`
- `scripts/editors/view3d/transform/transform_base.ts`

The other eleven are `scripts/editors/`-side: `PropsEditor`,
`pbvh_holefiller`, `sculptcore.ts`, `transform_inset`, `transform_ops`,
`transform_types`, `view3d_draw`, `view3d_toolmode`, `view3d_utils`,
`view3d.ts`, `widget_tools.ts`.

This number is only measurable at all because of `tsPreCompilationDeps` (§3);
before this plan it would have read 0 against 170+ real `import type`
statements.

### `no-circular` — two numbers, and P17 needs both

| Configuration | Count |
| --- | ---: |
| `tsPreCompilationDeps: true` (what ships) | **769** |
| post-compilation graph (the old behaviour) | 341 |

The 428-cycle difference is entirely type-only edges. P17 should treat 341 as
the *runtime* cycle count and 769 as the count a reader of the source sees;
severing a type-only cycle is usually a one-line `import type` → interface move,
and severing a runtime one is not. Reporting only one of them will make P17's
progress look either impossibly fast or impossibly slow.

### Edges outside the rules' `from` sets

24 `scripts/` → `addons/` edges originate outside the `HOST` prefix and so are
counted by nothing:

| From | Edges |
| --- | ---: |
| `scripts/entry_point.js` | 10 |
| `scripts/data_api/api_define.ts` | 6 |
| `scripts/typescript_entry.ts` | 4 |
| `scripts/typescript_entry.js` | 1 |
| `scripts/camera/camera.ts` | 1 (type-only, → curve) |
| `scripts/lite-mesh/litemesh_base.ts` | 1 |

Recorded rather than folded into the rule: the entry points are *supposed* to
reference addons (that is what an entry point does), and `api_define.ts` is
exactly the registry W1 rewrites. Widening `from` to all of `^scripts/` here
would have inflated the W1 budget by 24 edges that W1 does not owe.

### Lint baseline — deliberately not measured

There is no lint baseline in this plan, and `tools/lint-baseline.json` is not
committed. See the §5 step 4 correction: the ~17k-violation backlog has not been
triaged, and the only figure anyone has (17,412) was measured through a
misconfigured ESLint that was linting build output and two submodules. Publishing
a per-rule table from that would hand P9 a baseline it should not trust.

`tools/check-lint.mjs --update-baseline` produces the table when someone wants
it. Whoever does should budget roughly half an hour of single-core wall-clock per
run on this tree.

### Reproducing

```
pnpm check:layers                 # gate; exits 1 on any budget overrun
pnpm check:layers --list core-no-addons
pnpm check:layers --update-baseline
pnpm check:lint --list
```

P9 re-measures against this table. It does not start from a fresh one.
