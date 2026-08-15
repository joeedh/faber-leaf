# P14 — addon manager: optional dependencies — `[xhigh]`

**Status:** plan — not started.

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
