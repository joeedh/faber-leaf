# P16 — W3b: sculptcore build decoupling

**Status:** plan — not started.

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
| `scripts/entry_point.js:83,93` | direct sculptcore reach-through |
| `scripts/core/feature-flag.ts:64,103-131,174-249,254` | **the sculptcore feature flags are hardcoded in host code** |
| `pnpm-workspace.yaml` | six sculptcore paths listed literally; an absent path is a hard failure |
| `tsconfig.json` | no `@sculptcore/api` mapping at all — it resolves purely through the pnpm workspace symlink, so removing the submodule breaks typecheck with a confusing error |

## 4. Plan

### Step 1 — `pnpm-workspace.yaml`

Glob the six sculptcore paths so absence is tolerated:

```yaml
- 'sculptcore'
- 'sculptcore/typescript'
- 'sculptcore/tests'
- 'sculptcore/tests/testViewer3D'
- 'sculptcore/source/litestl/binding/typescriptRuntime'
- 'sculptcore/source/litestl/tests'
```

pnpm tolerates a glob matching nothing; it does not tolerate a literal path that
does not exist. Verify that claim against the pnpm version in use before relying
on it — if it does not hold, the fallback is generating the workspace file, and
that is a materially worse outcome worth knowing about early.

**pnpm hard-fails on an unresolvable `workspace:*` dependency.** So the
dependency on `@sculptcore/api` must hang off the **litemesh addon package**, not
the host — and it must be declared optional. That is why P14 had to add
`addons/builtin/*` to the workspace globs: without it, a builtin addon cannot
own a package dependency at all.

### Step 2 — `tsconfig` paths + a types-only stub

Add an `@sculptcore/api` entry to `paths` with a fallback to a types-only stub
(`types/sculptcore-stub/`), so `pnpm typecheck` passes in exactly the
configuration this workstream exists to support. Without it, the `--no-sculptcore`
lane fails at typecheck and the lane gets disabled, which is how optionality
bit-rots.

The stub declares the `IWasmInterface` surface and nothing else. It must never
be reachable at runtime — P14's "throws on use, not on import" stub rule applies.

Generate the entry through P1's `tools/gen-tsconfig-paths.mjs` rather than
hand-editing, so it stays consistent with the addon path entries.

### Step 3 — `tools/esbuilder.js`

The WASM and JS artifact copies (`:37,46,67`) become **addon-contributed build
assets**: the litemesh (or sculptcore) addon declares the files it needs copied,
and the bundler reads that declaration. Absent addon → no declaration → no copy,
and no missing-file error.

This also serves P17, where a distribution's asset set is derived from its addon
list.

### Step 4 — `scripts/entry_point.js:83,93`

Delete the reach-through. Whatever it does belongs in the sculptcore addon's
`register(api)` — same treatment as P15's `:70,75`.

### Step 5 — feature flags

`feature-flag.ts` hardcodes sculptcore's flags in host code. Flags describe
addon features, so addons must be able to register them:

- Add a flag-registration hook (`api.registerFeatureFlag(...)`) or extend P7's
  `AddonAPI` set — decide which, and be consistent with the six cases already
  added there.
- Move `sculptcore.gpu_brush`, `gpu_brush_verify`, `gpu_brush_grab`,
  `sculpt_layers`, `multires`, `vdm_sculpt` and the rest into the owning addon.
- **Persistence must survive the move.** Flags live in `localStorage` keyed by
  name ([featureFlags.md](../featureFlags.md)); keep the key strings identical
  or users lose their settings. This is the same class of hazard as P2's storage
  keys and P4's struct names — a rename that looks internal but is persisted.
- A flag whose owning addon is absent must not appear in the UI, and reading it
  must return a defined default rather than throwing.

Criterion 9 ("settings + startup file load in a sculptcore-free build") is
partly closed here: a settings blob containing flags for an absent addon must
load.

### Step 6 — the `--no-sculptcore` CI lane

Add it alongside the full lane. The full lane stays primary and keeps gating
merges (§1, criterion 4).

The lane: `git submodule deinit sculptcore` (or a checkout that never inits it)
→ `pnpm i` → `pnpm typecheck` → `pnpm build` → boot headlessly → smoke test
(create a LeafMesh cube, model something, save, load).

This lane is **the single highest-leverage piece of CI in the plan**. Nothing a
developer does day to day exercises the boundary, so without it the boundary is
"removable in principle, six months ago". It is cheap — no submodule checkout,
no emsdk, no WASM build — which is the argument for it, not against.

P17 re-points it at the `faber-leaf-core` distribution.

## 5. Tests

- The `--no-sculptcore` lane, green, as described.
- The **full** lane unchanged: same commands, same speed, same developer
  experience. If `pnpm i && pnpm build` gets slower or gains a step, that is a
  regression against criterion 4.
- Feature-flag persistence: a `localStorage` settings blob written by the
  current build loads under the new registration scheme with every flag value
  preserved.
- A settings blob containing flags for an absent addon loads without error and
  without those flags appearing in the UI.
- `pnpm typecheck` green **both** with and without the submodule.

## 6. Risks

- **Bit-rot of optionality** — the named risk this plan is built around.
  Mitigation: step 6's lane, and it must be a required check, not an
  informational one.
- **pnpm's glob tolerance is not what we assume.** Mitigation: verify in step 1
  before building on it; the fallback (generating the workspace file) is worth
  knowing about on day one rather than day five.
- **The types-only stub drifts from the real interface.** Mitigation: generate
  it from `sculptcore/typescript/api/wasm.ts` if practical; otherwise a test in
  the full lane asserting the real interface still satisfies the stub.
- **Feature-flag key drift silently resets user settings.** Mitigation: step 5's
  key-identity rule plus the persistence test.
- **The full build gets harder to work in.** Explicitly a failure. If a step
  makes the default configuration worse, find another way.

## 7. Exit criteria

- Criterion 3: with the submodule deinitialized, `pnpm i`, `pnpm typecheck`,
  `pnpm build` and a headless boot all succeed, and the smoke test models a
  LeafMesh cube.
- Criterion 4: the full sculptcore-present lane still gates merges and is no
  harder to work in than before.
- The `--no-sculptcore` lane is a required CI check.
- Sculptcore's feature flags are registered by their owning addon with their
  `localStorage` keys unchanged.
- `tools/esbuilder.js`, `scripts/entry_point.js` and `scripts/core/feature-flag.ts`
  contain no sculptcore reference.
- The sculptcore submodule is still the default acquisition path; no clone
  script or lockfile was added.
