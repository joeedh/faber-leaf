# P20 — W5b: de-globalize + the embedding API — `[xhigh]`

**Status:** implemented 2026-08-19.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W5 steps 3–4, §5 phase 13, §9.3 P20.

**Workstream / phase:** W5 / phase 13.

**Depends on:** P17 (distributions), P18 (the UV editor no longer needs
`window.redraw_uveditors`). **Blocks:** nothing — this is the last plan.

**Authoring effort:** **`[xhigh]`** — the audit is large, several of the globals
are load-bearing for external addons, and the output is a public contract the
project has to keep.

**Closes:** success criterion 15. Also documents decision #9's file-format
break.

---

## 1. Goal

Make it possible to embed Faber Leaf: `mountFaberLeaf(container, options)`
returning a handle, two instances on one page, and a written contract saying
what an embedder may rely on.

Getting there means the app can no longer assume it owns the document.

## 2. The audit

Measured 2026-08-15, excluding `scripts/path.ux/` (a submodule with its own
globals — in scope only where the host reads them) and `scripts/extern/`.

### 2.1 `_appstate` — 197 references across 48 files

*(2026-08-19: 183 references across 39 files by the time P20 ran — P13–P18
deleted files that held some of them. The shape of the work is unchanged.)*

Assigned once, `appstate.ts:1171`: `window._appstate = new AppState()`.
Densest consumers: `scripts/core/app_ops.js` (16), `editor_base.ts` (14),
`appstate.ts` (11), `addon/addon_base.ts` (11), `core/settings.ts` (8),
`scene/scene.ts` (7), plus `scripts/lite-mesh/litemesh_*test_support.ts` (25
between them — those move to the addon in P15).

This is the single-instance assumption in its purest form and it is the bulk of
the work. 197 sites is too many for one commit; sequence it:

1. Give `AppState` an explicit accessor (`getAppState()`), backed by an
   instance registry rather than a global.
2. Convert call sites in tranches, by directory, each its own commit.
3. Keep `window._appstate` as a **deprecated alias to the first-mounted
   instance** until the end, then decide (§4) whether it stays as a
   compatibility shim.

Do not attempt "thread the instance through every call" — most of these sites
are inside classes that already have a context or an editor reference, and
reaching the instance from there is the actual fix. A blanket parameter is a
worse API and a much larger diff.

### 2.2 `globalThis._framework` — **do not delete**

`scripts/_framework_runtime.ts:27` sets `{api, pathux}`; externalized addon
bundles are compiled against stubs that look it up
(`tools/framework_api_plugin.js:114-116`, `tools/build-addons.js:119,148`).
This is the **entire external-addon ship mode**. Deleting it breaks every
third-party addon, and P17's packaging test exists to prove that mode works.

The fix is a **per-instance registry**, not removal: `globalThis._framework`
stays as the module-namespace carrier (module namespaces are genuinely global —
that part is correct), while anything instance-scoped moves out of it. Audit
what is actually in there today and confirm it is only namespaces.

Note the warning path at `framework_api_plugin.js:115-116`: an addon loaded
before `_framework_runtime.ts` runs gets `undefined` exports with a
`console.warn`. Under P17's distribution loading that ordering is data — make it
an error, or make the lookup lazy.

### 2.3 `window.DEBUG`

Set by path.ux (`config/const.ts:279`) and re-set by
`scripts/setup_pathux.js:105`. Read at `lib_api.ts:719`, `view3d.ts:1492`,
`simplemesh.ts:656,728,781,1473`, `webgl.ts:237,1274`,
`mesh.ts:4659` (dies with P13), plus the `gpuBrush` surface
(`sculptcore_gpu_stroke.ts:27,59`, `brush_compute.ts:184`, `context.ts:470`).

All reads are `window.DEBUG?.x` guards, so this is low-risk. It is a developer
surface documented in [debugSurface.md](../debugSurface.md) and driven over CDP
by the test harness — **keep it**, but scope the instance-specific parts
(`gpuBrush`) under the instance handle and leave the boolean toggles global.
Breaking CDP-driven tests to satisfy a purity goal is a bad trade.

### 2.4 `window._SelMask`

`selectmode.ts:54`. P6 moved the constants to `scripts/core/select_types.ts`;
this line is the last export of them onto the window. Check whether anything
still reads it (nothing in-tree does as of the audit) and delete it. If the
NW.js test harness or a `--eval` script uses it, move it under the debug
surface instead.

*(2026-08-19: the assignment moved with the constants — it was
`select_types.ts:240`, with its `Window` interface member at `:42`. Nothing
in-tree, in `nwjs/` or in `tests/` read it, so both are deleted.)*

### 2.5 `window.redraw_uveditors`

**Already deleted by P18** (§4 constraint 4). Verify, do not re-do.

### 2.6 The document itself

`index.html` hardcodes `#loading-overlay`, `#loading-logo`, `#loading-spinner`,
`#loading-text`, `#iconsheet`, `#content`, `#canvas2d`, `#canvas3d`, and
`<body onload="init()">`.

- `#iconsheet` is read by `setup_pathux.js:68`. It must become a
  container-relative lookup or an injected asset, or two instances fight over
  one element.

  *(2026-08-19: `setupIconsRastered` — the `config.svgIcons === false` branch —
  looked up `#iconsheet16` … `#iconsheet64`, ids that exist in no HTML in the
  repo, so it could only ever build an `IconManager` over seven nulls. It is
  deleted along with the `svgIcons` switch rather than container-scoped.)*
- `#canvas2d` / `#canvas3d` are declared in `index.html` but **no in-tree
  script looks them up by id** — the only fixed-id canvas lookups are `#webgl`
  (`editor_base.ts:1198`, `test_harness.ts:385`), which `index.html` does not
  define. Resolve that discrepancy as part of the audit: either `#webgl` is
  created at runtime, or one of those two paths is dead. Do not carry a
  hardcoded id forward without knowing which.

  *(2026-08-19, resolved: `#webgl` is created at runtime by `initWebGL()`
  (`view3d.ts:87`), which appends it to `document.body` and caches it on the
  `window._gl` global — so both lookups are live, and the canvas plus the GL
  context are two more per-instance things wearing a global. `#canvas2d` /
  `#canvas3d` are dead markup and are deleted. The two live lookups are now
  `editor_base.ts:1216` and `test_harness.ts:391`.)*
- `onload="init()"` is a global entry hook and is exactly what
  `mountFaberLeaf` replaces.
- Every id must become container-scoped. The rule: **no `document.getElementById`
  in host code**; look up within the mount container.

## 3. `mountFaberLeaf`

```ts
const handle = mountFaberLeaf(container, {
  distribution: faberLeaf,   // P17
  scene?: ...,
  branding?: ...,
})
handle.unmount()
```

Requirements:

- Returns a handle owning the instance's `AppState`, its DOM, its GPU
  resources, and its debug surface.
- `unmount()` actually releases — WebGPU device resources, event listeners,
  timers, and the instance's registry entry. An embedder that mounts and
  unmounts in a loop must not leak. Test it.
- Two instances on one page, side by side, each with its own scene, each
  interactive. That is criterion 15's literal test and it is the one that finds
  every remaining global.
- Storage keys must be namespaced per instance or explicitly shared — settings,
  feature flags (P16), autosave/OPFS. Two instances sharing an autosave slot
  would be data loss. Decide per subsystem and write it down; the default should
  be *shared for preferences, per-instance for documents*.

`index.html` becomes a thin consumer of `mountFaberLeaf`, so the shipped app
uses the same path an embedder does. Anything else and the embedding path rots.

*(2026-08-19, as built. `scripts/mount.ts` holds `mountFaberLeaf` plus
`mountedInstances()`; the process-wide half of the old `appstate.init()` is now
the idempotent `initProcessGlobals()`, and per-instance boot stays in
`AppState.start()`. `AppState` gained `container`, `glCanvas`, `enableAutosave`
and a teardown-hook list — the last so layers above core register their own
releases (`initWebGL` registers `disposeWebGL`) without core importing them.
`destroy()` runs those hooks, stops autosave and removes the screen. The old
one-instance boot pair `appstate.preinit()` / `appstate.init()` is deleted — a
function that registers "the" instance is the single-instance assumption in
miniature.*

*`mountFaberLeaf` is exported from `scripts/entry_point.js`, **not**
`scripts/framework_api.ts`: the hub sits inside the host's import-cycle knot, so
re-exporting `mount.ts` there put `no-circular` one over budget — and mounting
the app is a page-level act an addon has no business performing. Embedders
import it from the built bundle, which is exactly what the test does.*

*Instance count is not fixed at two: `state.enableAutosave` is true only for the
first mount, because the autosave backend has one slot per app identity. §7 of
[embedding.md](../embedding.md) records that.)*

## 4. `documentation/embedding.md`

The deliverable is as much the document as the code:

- **What an embedder may rely on** — `mountFaberLeaf`, the handle, the
  distribution mechanism (P17), `@framework/api`, the addon manifest schema
  (P14).
- **What is explicitly not stable** — `window.DEBUG` internals, everything under
  `scripts/` not re-exported through `@framework/api`, any global still present
  as a shim.
- **Distribution overrides**: branding, default scene, addon set, and their
  limits (P17's "manifest, not a fork" rule).
- **Semver policy on `@framework/api`.** Say what a breaking change is and how
  it is announced. Without this, the hub is a promise nobody made and everybody
  assumed.
- **Fate of the compatibility shims**: whether `window._appstate` survives as a
  first-instance alias, and if so for how long. Pick one and date it.

  *(2026-08-19: it survives, aliasing the **first-mounted** instance, and both
  it and `window._gl` are dated **2027-02-01** in
  [embedding.md](../embedding.md) §5. `window._SelMask` and
  `window.redraw_uveditors` were deleted outright — nothing read them.)*

### 4.1 Also record decision #9

The strategy assigns the file-format break's *documentation* here even though
P10 implemented it. Write the user-facing note: what changed, which versions
interoperate, what happens when an old build opens a new file. This is the last
plan, so it is the last chance for the format story to be written down
coherently rather than distributed across P10, P13 and P15's release notes.

## 5. Tests

- **Criterion 15**: two instances mounted in one page, both interactive, both
  with independent scenes and selections. Automated, not a manual check.
- Mount → unmount → mount in a loop with no growth in WebGPU resources,
  listeners, or registry entries.

  *(2026-08-19: both live in `tests/integration/mount_lifecycle.test.ts`, which
  drives the real NW.js app headlessly and reaches `mountFaberLeaf` by importing
  the shipped bundle — so the test fails if the embedding export ever stops
  being reachable the way an embedder reaches it. The grep gate below is
  `tests/unit/document_scope.test.ts`.)*
- The shipped `index.html` boots through `mountFaberLeaf`, and the existing
  full-app suites pass unchanged through it.
- P17's external-addon packaging test still passes — `globalThis._framework`
  must still work (§2.2).
- CDP-driven harness tests still work (`CTX`, `CTX.debug`, `window.DEBUG`), per
  [debugSurface.md](../debugSurface.md). Update that doc for anything that moved
  under the handle.
- A grep gate: no `document.getElementById` / `document.querySelector` in host
  code outside the mount bootstrap.
- Two instances with different distributions (`faber-leaf` and
  `faber-leaf-core`) on one page — the strongest form of the test, and worth
  attempting even if it is not made a hard requirement.

  *(2026-08-19: not done, and not a defect in the mount. The addon registry is
  process-wide, so the distribution is read once by the first mount; a second
  instance under a different one would need the registry made per-instance,
  which is a larger change than P20. Recorded as a limit in
  [embedding.md](../embedding.md) §3 and §7 rather than left implied.)*

## 6. Risks

- **Deleting `globalThis._framework` breaks every external addon.** This is the
  headline hazard. Mitigation: §2.2 — it stays, and P17's packaging test is the
  regression guard.
- **197 `_appstate` sites, converted mechanically, hide a semantic change.**
  Mitigation: tranche by directory, one commit each, full suite per tranche.
  Resist a single sweeping regex.
- **The audit misses a global** that only two-instance mode reveals — which is
  precisely why criterion 15's test is two instances and not one clean mount.
- **CDP / NW.js harness breakage.** The whole test infrastructure drives the app
  through globals. Mitigation: §2.3's decision to keep `window.DEBUG` and scope
  only the instance-specific parts.
- **`unmount()` looks like it works but leaks GPU resources.** Mitigation: the
  loop test with an explicit resource count, not an eyeball check.
- **Scope creep into a general plugin API.** This plan mounts the app in a
  container and writes down the contract. It does not redesign
  `@framework/api`.

## 7. Exit criteria

- Criterion 15: `mountFaberLeaf(container, options)` exists, returns a handle
  with a working `unmount()`, and two instances run side by side on one page in
  an automated test.
- `index.html` boots through it, and the full suites pass.
- `window._appstate`, `window._SelMask`, `window.redraw_uveditors` and every
  fixed-id DOM lookup are gone from host code, or survive only as documented,
  dated compatibility shims.
- `globalThis._framework` still works and external-addon packaging still passes.
- `documentation/embedding.md` exists, covering the guarantees, the non-
  guarantees, distribution overrides, the `@framework/api` semver policy, the
  shim end-dates, and decision #9's format break.
- [debugSurface.md](../debugSurface.md) is updated for anything that moved under
  the instance handle.
