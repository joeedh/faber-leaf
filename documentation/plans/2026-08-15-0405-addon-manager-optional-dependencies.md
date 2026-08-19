# P14 — addon manager: optional dependencies — `[xhigh]`

**Status:** landed 2026-08-19.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W3 step 0, §5 phase 10, §9.3 P14.
**Reference:** [documentation/addons.md](../addons.md).

**Workstream / phase:** W3 / phase 10.

**Depends on:** P9. **Blocks:** P15, P16, P17.

**Authoring effort:** **`[xhigh]`** — this defines what "optional" *means*
across four systems that currently disagree, and that semantics is what P15,
P16 and every third-party addon inherit.

**Closes:** the *registry* half of success criterion 12 — P11 proves a
third-party geometry type needs no `scripts/` edit, but only if the addon
manager can actually load a third-party addon that declares one. §9.5 pairs the
two.

---

## 1. Goal

Make an addon genuinely optional: declarable as optional, force-disablable at
boot, depended on optionally by another addon, and absent from a build without
breaking the build.

## 2. Why it is `xhigh`

"Optional" is not one property. It is four, owned by four systems that have
never had to agree:

| System | Question it answers | Where |
| --- | --- | --- |
| **Manifest schema** | may this addon be absent? | `scripts/addon/manifest.ts` |
| **Dependency resolver** | what happens when a declared dependency is missing? | `manifest.ts:163-165` |
| **Build-time module resolution** | does `@addon/<id>/api` resolve when the addon does not ship? | `addon_api_plugin.js:54-58` |
| **Boot-time enable/disable** | can a *builtin* be turned off? | `addon.ts:430-439` |

Today each answers differently and none of the answers is "yes". Pick a single
semantics here, or P15 and P16 will each invent their own and the third-party
story will be whatever falls out.

## 3. Current state

> Written 2026-08-15, before P10–P13 landed. §10.1 re-verifies every
> citation below and corrects three of the claims — §3.3 is stale outright.

### 3.1 `"optional": true` is silently dropped

- `AddonManifest` (`manifest.ts:9-47`) does not declare the field.
- `validateManifest` (`:123-135`) does not read it.
- `install.ts:113` does not act on it.

So a manifest can say `"optional": true` today, and nothing anywhere observes
it. That is worse than an error: it looks like it works.

### 3.2 A missing dependency throws

`manifest.ts:163-165`, inside the topological sort:

```ts
const dep = byId.get(depId)
if (!dep) {
  throw new Error(`addon "${m.id}" depends on unknown addon "${depId}"`)
}
```

The throw escapes the resolver. One absent addon does not disable its
dependents — it fails the whole resolution pass. This is also why P13 cannot
stage its delete.

### 3.3 Builtins cannot be disabled

`addon.ts:430-439` has no disable path for builtins. `startAddons(false)`
registers them via `addon_register.ts` rather than through the manifest flow,
so the enable/disable machinery does not apply to them at all.

### 3.4 Build-time resolution is unconditional

`addon_api_plugin.js:54-58` resolves `@addon/<id>/api` at build time regardless
of whether the addon ships. An optional peer import therefore either resolves to
a module that will not exist at runtime, or fails the build.

### 3.5 `addons/builtin/*` is not a workspace glob

`pnpm-workspace.yaml` lists `addons/*`, not `addons/builtin/*`. So a builtin
addon **cannot own a package dependency**. That is where P16's optional
`@sculptcore/api` has to live — pnpm hard-fails on an unresolvable
`workspace:*`, so hanging it off the host is not an option. Fix the glob here,
or P16 has nowhere to put it.

## 4. The semantics to define

Write these down in `documentation/addons.md` as normative, then implement:

**Optional addon.** `"optional": true` in the manifest. Means: the build may
omit it, the user may disable it, and its absence is a normal state — not an
error, not a warning at every boot. Non-optional builtins remain required and
their absence is still a hard error.

**Optional dependency.** Distinguish two forms in the manifest:

```jsonc
"dependencies": ["a"],           // required: absent → this addon does not load
"optionalDependencies": ["b"]    // absent → this addon loads, degraded
```

`optionalDependencies` participate in *ordering* (if present, load first) but
not in *satisfiability*.

**Missing required dependency.** Disable the dependent addon and everything
transitively requiring it, record the reason, surface it in the addon UI — and
**do not throw**. Resolution must complete and return a partition:
`{loaded, disabled: [{id, reason}]}`. A throw out of the resolver takes the app
down for one bad manifest, which is exactly the failure P8 spent its time
removing from `api_define.ts`.

**Force-disable.** A boot-time mechanism (query param, localStorage key, and a
CLI flag for the NW.js shell) that disables an addon by id **including
builtins**, before registration. This is what P8's, P15's and P16's exit
criteria all test against — three plans depend on it existing.

**Capability query.** `api.has('sculptcore')` (P7 §9) is answered from the
loaded set. An addon with an optional dependency uses it to degrade rather than
crash.

**Build-time resolution.** `@addon/<id>/api` for an addon not in the current
distribution resolves to a **stub module that throws on use, not on import**,
so an optional peer import type-checks and bundles but fails loudly if actually
reached without the guard. Pair it with a types-only stub for tsconfig `paths`
(P16 needs the same shape for `@sculptcore/api`).

## 5. Plan

1. **Manifest schema.** Add `optional` and `optionalDependencies` to
   `AddonManifest`, `validateManifest`, and the documented schema in
   `documentation/addons.md`. Reject unknown fields loudly from here on —
   silently dropping `optional` is the root defect and it should be impossible
   to repeat.
2. **Resolver.** Rewrite `manifest.ts`'s topological sort to return the
   `{loaded, disabled}` partition instead of throwing. Keep the *cycle* error a
   throw — a cycle is a programming error, not a configuration state. Preserve
   deterministic ordering (sort by id within a dependency level) so addon load
   order is reproducible; P17 depends on that.
3. **Builtin disable path.** Extend `addon.ts:430-439` so builtins go through
   the same enable/disable state as installed addons, and make
   `addon_register.ts` / `startAddons(false)` respect it.
4. **Force-disable mechanism**, per §4. Must work in the browser, in NW.js, and
   headlessly (`--eval` / CLI flag), because that is where the tests run.
5. **`addon_api_plugin.js`**: stub resolution for absent addons, plus the
   tsconfig `paths` types-only stub. Generated from the distribution's addon
   list once P17 exists; until then, from the on-disk set.
6. **`pnpm-workspace.yaml`**: add `addons/builtin/*`. Verify `pnpm i` from clean
   and that no existing package name collides.
7. **Prove it on a throwaway addon**, before LiteMesh depends on any of it (§6).

## 6. Prove it on a throwaway first

Create `addons/builtin/_optional_probe/` (or a test fixture addon): optional,
with an optional dependency on a second throwaway addon. Exercise:

- both present → both load, in dependency order;
- dependency force-disabled → probe loads, `api.has(...)` returns false, its
  degraded path runs;
- probe force-disabled → app boots, nothing else notices;
- dependency **required** instead of optional and absent → probe is disabled
  with a recorded reason, app still boots, no throw;
- a cycle → still throws, with the existing message.

Doing this on throwaways rather than on LiteMesh is the difference between
finding the semantics wrong in an afternoon and finding it wrong halfway
through P15. Delete the probe addons at the end of the plan, or keep them as
permanent test fixtures — the latter is preferable, and they are cheap.

## 7. Tests

- The five cases in §6, as automated tests.
- `pnpm i` from clean after the workspace-glob change; `pnpm build` green.
- A build that omits an optional addon bundles successfully and the stub throws
  only when actually reached.
- P8's exit criterion re-run **for real** this time: boot with the mesh addon
  force-disabled (if P13 has not yet deleted it) and reach an empty viewport.
- Addon UI shows disabled addons with their reason.

## 8. Risks

- **The semantics gets decided implicitly by P15's needs.** That is the failure
  this plan exists to prevent — hence §6's throwaway-first rule.
- **The resolver rewrite changes load order** and surfaces the TDZ /
  circular-dependency fragility in `framework_api.ts` and `builtin_registry.ts`
  that P17 owns. Mitigation: keep ordering deterministic (§5 step 2); if a
  latent cycle turns into a crash, that is a genuine P17 finding — report it,
  do not paper over it by pinning the old order.
- **Workspace-glob change breaks the pnpm link graph** in a way only a clean
  install shows. Mitigation: clean install in the same commit, and P1's CI
  installs from clean.
- **Stub modules hide real breakage.** A stub that throws on *import* fails
  the build; one that never throws hides a missing guard. The "throws on use"
  choice is deliberate — document it.

## 9. Exit criteria

- A builtin addon can be declared `"optional": true` and that field is
  **observed** — by the schema, the resolver, and the installer.
- A builtin can be force-disabled at boot, in browser, NW.js and headless.
- An addon can declare an optional dependency, load without it, and detect its
  absence via `api.has(...)`.
- A missing required dependency disables the dependent and records a reason
  instead of throwing; the app still boots.
- All five §6 cases pass on throwaway addons, before LiteMesh depends on any of
  it.
- `addons/builtin/*` is a pnpm workspace glob and a clean install is green.
- `documentation/addons.md` documents the semantics normatively.

---

## 10. Execution log

### 10.1 The citations, re-verified against the tree (step 1)

The §3 citations are a 2026-08-15 snapshot taken before P10–P13 landed. Walked
one at a time:

| Citation | Verdict |
| --- | --- |
| `AddonManifest` at `manifest.ts:9-47` | line range **exact**; the interface is named **`IAddonManifest`** |
| `validateManifest` at `:123-135` | those lines are the *return literal*; the validator spans `:67-136`. The claim — nothing reads `optional` — holds |
| `install.ts:113` | points into the `buildMode === 'source'` branch, which has nothing to do with `optional`. See below |
| `manifest.ts:163-165` (throw on unknown dep) | **exact** |
| `addon.ts:430-439` (builtins cannot be disabled) | line range **exact** — it is the dependency loop in `enable()`. The surrounding claim is **stale**; see below |
| `addon_api_plugin.js:54-58` | **exact**. The consequence drawn from it is half right; see below |
| `pnpm-workspace.yaml` lists `addons/*` | **exact**. `addons/code_editor` is the only package it currently matches |

Three of them need their *claims* corrected, not just their line numbers.

**§3.1 / `install.ts`.** The installer never reads `optional`, which is what
§3.1 says — but there is nothing for it to read at install time. `optional` is a
*resolve-time* property; `install.ts` already routes its manifest through
`validateManifest`, so the field starts flowing the moment the schema declares
it. The installer needs no change, and the citation is dropped rather than
fixed.

**§3.3 — "builtins cannot be disabled" is stale.** There is no
`addon_register.ts` in the tree; it was replaced by the unified pipeline
(`builtin_registry.ts` → `registerBuiltin` → `pendingSources` →
`_materializePending` → `enable`), and a builtin now flows through *exactly* the
same lifecycle as a third-party addon. `disable('sculptcore')` already works.
What is genuinely missing is different and narrower: **no boot-time override
exists**. Settings' `_loadAddons()` pass 1 re-enables anything with a persisted
enabled flag, and nothing anywhere can say "this id does not load at all,
whatever the manifest and the prefs say". That is the hole force-disable fills.

**§3.4 — the build-time failure is only half the story.** The plugin hard-fails
the build when `addons/builtin/<id>/src/api.ts` is missing from disk. But when
the file *is* on disk and the addon is merely absent at **runtime**, the
generated stub resolves `globalThis._addons.getAddonAPI(id)` to `undefined`,
falls back to `{}` and emits `export const X = undefined` for every symbol —
silent, not loud. Both halves are wrong in opposite directions: absent-on-disk
is too loud (at the wrong time), absent-at-runtime is too quiet.

Two items §4 asks for already exist:

- **`api.has(id)`** is at `addon_base.ts:317`, and its doc comment already
  states the degrade-rather-than-crash rationale. P14 does not add it; P14 makes
  its answer *mean* something.
- **A CLI-arg reader** is at `scripts/core/app_argv.ts` (`getArg`, `getArgList`,
  NW.js `nw.App.argv`, empty in the browser). The force-disable flag reads
  through it rather than parsing argv again.

### 10.2 The semantics, decided (step 1)

§2's point is that "optional" is four questions with four owners. These are the
answers this phase implements; everything downstream inherits them.

**D1 — force-disable means the addon is never loaded.** Not "loaded but off":
no record, no module import, absent from `idmap`. This is the strongest form and
it is the only one that makes `api.has(id)` correct *by construction* — with a
record present, `has()` would have to start distinguishing loaded-from-enabled
and every caller would have to care. It is also the state a distribution that
omits the addon is actually in, which is what P15 and P16 need to test against.
The manager keeps the id and a reason so the UI can say what happened.

**D2 — only a missing *required* dependency becomes a partition entry.** A
cycle and a duplicate id stay throws: they are programming errors, not
configuration states, and no amount of runtime tolerance makes a cyclic graph
loadable. A missing dependency, by contrast, is exactly what a shipped
distribution looks like from the inside.

**D3 — `optionalDependencies` order, they never satisfy.** They take part in the
topological sort (present → loaded first) and in `api.deps` wiring, and they are
ignored by satisfiability *and* by `disable()`'s dependent check — an optional
dependent must never block its optional dependency from being turned off, or
"optional" means nothing at the only moment it is tested.

**D4 — load order becomes deterministic by id.** The existing sort is DFS in
input order, which is reproducible only if the *input* is; `storage.list()`
ordering is a filesystem detail. Roots are now visited in id order, so the
enable order is a function of the manifest set alone. P17 depends on that.

**D5 — unknown manifest fields are rejected.** Silently dropping `optional` is
the root defect of §3.1, and the only way it cannot recur is for an unrecognised
key to be an error naming the key.

**D6 — the build-time stub throws on use, per symbol.** When `api.ts` is on disk
and the addon is not loaded at runtime, each export becomes a sentinel that
throws on call / construct / property access, naming the addon and the symbol —
instead of today's silent `undefined`. An addon **absent from disk** keeps the
hard build error: there is nothing to type-check a consumer against, and
inventing export names for a module that does not exist would trade a loud build
failure for a silent runtime one. The distribution-driven variant (source
present, deliberately excluded from the bundle) is P17's, and it lands on this
same sentinel path.

A CJS-`Proxy` stub was tried first, since it would have made *any* named import
resolve for an addon absent from disk. It does not work: esbuild's `__toESM`
interop snapshots the module's own property names at import time, so the proxy's
`get` trap is never reached from the consumer and every symbol reads back
`undefined` — the silent failure again, one layer down. Verified against
esbuild directly before the design was settled.

**D7 — no types-only tsconfig stub is needed.** `tools/gen-tsconfig-paths.mjs`
already derives every `@addon/<id>/api` alias from the on-disk tree, so a
consumer type-checks whenever the source is in the repo — which, per D6, is the
only case where compiling against it is meaningful. §5 step 5's "types-only
stub" is therefore not implemented, and the reason is recorded here rather than
left as an unexplained omission.

### 10.3 Steps 2–7 (landed 2026-08-19)

**Step 2 — the resolver.** `sortManifestsByDeps` is gone; `resolveManifests`
returns `{loaded, disabled}` (`DisabledAddon = {id, reason, dependency,
message}`). Cycles, self-cycles and duplicate ids still throw with their
existing messages (D2). Roots are visited in id order and `optionalDependencies`
are visited sorted, so the order is a function of the manifest set alone (D4).
`AddonManager._materializePending` drops each disabled id from `pendingSources`
and records it in the new `unloaded: Map<string, UnloadedAddon>` — so a broken
manifest costs exactly one addon.

**Step 3 — nothing to do.** §10.1 already established that §3.3 was stale: a
builtin flows through the same `registerBuiltin → pendingSources →
_materializePending → enable` pipeline as an installed addon, and
`disable('sculptcore')` worked before this phase. The hole was the boot-time
override, which is step 4.

**Step 4 — force-disable** (`scripts/addon/force_disable.ts`): query param,
`localStorage`, and `--disable-addon` unioned once per session. The guard sits
in all three source-collection paths (`registerBuiltin`, `collectIndexSources`,
`collectInstalledSources`) and in `enable()`, so a force-disabled addon is never
imported and can never be turned on by a persisted pref (D1).

**`api.has()` was redefined**, not added: `addon_base.ts` answered
"is a record present", which a *disabled* addon also satisfies. It now answers
`window._addons.isEnabled(id)` — loaded *and* enabled. Safe to change outright:
grep found no pre-existing call sites.

**Step 5 — the stub.** Each export is `export const X = __pick("X")`, and
`__pick` falls back to a `__missing(name)` sentinel: a `Proxy` over a function
that throws on call, construct or property access, naming the addon, the symbol
and `api.has("<id>")`, and distinguishing "addon not loaded" from "addon does
not export this" (D6). Two things it must not do — throw at import, and cost
bundle size: the first pass inlined a `hasOwnProperty` ternary per export and
pushed the fixture bundle from 15 KB to 31 KB, hence the hoisted `__pick`. (An
`__missing(__name)` parameter also collides with esbuild's own `__name` helper
and gets renamed to `__name2`; it is `__sym`.) Per D7 no types-only tsconfig
stub was added.

**Step 6 — `addons/builtin/*`** is now a workspace glob. It matches no package
today (no builtin has a `package.json`), which is the point: P16's optional
`@sculptcore/api` dependency has somewhere to live without a workspace edit.
`pnpm i` from the existing lockfile reports all 14 projects up to date — no new
packages, no name collision.

**Step 7 — the probes.** `tests/fixtures/addons/optional_probe{,_dep,_broken}`,
kept as permanent fixtures per §6. `tests/integration/addon_optional_probe.test.ts`
runs three headless NW.js boots and reports the manager state back through
`--eval` → `globalThis.__evalTestResult` → the `--dump` JSON. §6's five cases:

| Case | Where |
| --- | --- |
| both present → both load, in dependency order | boot 1 |
| dependency force-disabled → probe loads degraded, `api.has()` false | boot 2 |
| probe force-disabled → app boots, nothing else notices | boot 3 |
| required dependency absent → disabled with a reason, no throw | boot 1 (`optional_probe_broken`) |
| a cycle → still throws | `tests/unit/addon_manifest.test.ts` |

7/7 green, ~50 s for the three boots — under `slow.mjs`'s bar, so it stays in
the default run.

**§7's remaining items.** The addon UI lists `unloaded` entries with their
reason under *Not loaded* (`SettingsEditor.buildAddonsSettings`). "Boot with the
mesh addon force-disabled" is moot — P13 deleted that addon; the equivalent
proof is boot 3. The stub-throws-only-when-reached case is
`tests/integration/addon_api_resolver.test.ts`, which re-imports the built entry
with no host installed and asserts each symbol throws on use rather than reading
back `undefined`.

**A note for P15/P16.** `_materializePending` wires optional deps into
`api.deps` silently when present and skips them when absent, so an optional
dependent reads `api.deps[id]?.exports[id]` only behind `api.has(id)`. The
fixture pair is the copyable shape.
