# Addons

Most of the framework's editing features ship as **addons** under
`addons/builtin/<id>/src/`. Each builtin addon is a self-contained
TypeScript module that:

- Declares a manifest (id, name, version, dependencies, …)
- Registers its classes (DataBlocks, ToolModes, ToolOps, CustomDataElems,
  Editors, SceneObjectData, plain nstructjs classes) through the
  `AddonAPI` dispatcher
- Imports framework primitives through the `@framework/api` alias
- Imports another addon's public surface through `@addon/<id>/api`

Builtin addons today: `leafmesh` and `litemesh`. `leafmesh` is the home of the
`LeafMesh` DataBlock, its attribute layers, and its picking / selection /
modeling ops; `litemesh` owns the sculptcore-backed mesh, the sculpt toolmode,
the brushes, and the `litemesh.add_*` entries in the Add menu.

Every class an addon owns is registered from its `register(api)` hook, through
`api.register` / `api.registerAll` — there is no generated class list to keep
in sync.

Which of them a given build actually ships is a
[distribution](#distributions), not a property of the addon.

## Anatomy

```
addons/builtin/<id>/
├── manifest.json    # id, version, entry, dependencies
├── package.json     # only if the addon has dependencies of its own
└── src/
    ├── main.ts      # the entry: addonDefine + register/unregister/handleArgv/validArgv
    ├── api.ts       # public surface re-exported to peer addons via @addon/<id>/api
    └── *.ts         # implementation
```

Two ways an addon ships:

- **In-bundle (builtin).** Statically imported by a distribution manifest
  (`distributions/<id>/index.ts`), which hands it to
  `addonManager.registerBuiltin(manifest, module)` at boot.
- **Out-of-bundle (per-addon esbuild output).** Built by
  `tools/build-addons.js` into `build/addons/<id>/main.js` and dynamically
  imported by `AddonManager` from `build/addons/index.json`.

Neither *enables* anything: both are **sources**, and both flow through the
same `start()` → resolve → topo-sort → `enable()` lifecycle, calling the same
`register(api)` hook. Ship mode is a build fact, not a behavioural one — which
is what makes moving an addon between the two a build change only.

In-bundle is a concession, not a tier: an addon is in-bundle exactly as long as
its source is too entangled with `scripts/` to compile separately.

## Manifest schema

`manifest.json` is parsed by `validateManifest` (`scripts/addon/manifest.ts`)
for builtin and third-party addons alike. **An unrecognised key is an error**
naming the key — `optional` spent this project's whole history being silently
dropped, and a validator that ignores what it does not understand is how that
happens.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | matches `/^[a-z][a-z0-9_-]*$/`; the key for `idmap`, `@addon/<id>/api` and `api.has(id)` |
| `name` | yes | human-readable, shown in the addon UI |
| `version` | yes | semver `MAJOR.MINOR.PATCH` |
| `entry` | yes | entry file relative to the manifest; no `..` |
| `dependencies` | no | ids that **must** be present — absent → this addon does not load |
| `optionalDependencies` | no | ids loaded first *when present*, ignored when absent |
| `optional` | no | may a build ship without this addon (default `false`) |
| `defaultEnabled` | no | `false` ships the addon loaded but disabled (default `true`) |
| `buildMode` | no | `'prebuilt'` (default) or `'source'` |
| `buildAssets` | no | extra esbuild entry points / externals this addon contributes to the main bundle (in-bundle builtins only) — see [Not in this build](#not-in-this-build) |
| `author`, `description`, `icon`, `permissions` | no | metadata; `permissions` is reserved |

An id may not appear in both `dependencies` and `optionalDependencies`.

## Optional addons and optional dependencies

These semantics are normative — the resolver, the boot path and
`@addon/<id>/api` all implement exactly this. The reasoning behind each choice
is recorded in
[the P14 plan](plans/2026-08-15-0405-addon-manager-optional-dependencies.md)
§10.2.

**An optional addon** (`"optional": true`) may be absent from a build and may
be turned off by the user. Its absence is a normal state — not an error and not
a per-boot warning. A non-optional addon's absence remains a defect.

**A required dependency that is missing disables the dependent, and does not
throw.** `resolveManifests()` returns a partition — `{loaded, disabled}` — and
the manager records each disabled entry in `addonManager.unloaded` with a
reason (`missing-dep`, or `dep-disabled` for whatever transitively required
it). The Settings ▸ Addons tab lists them under *Not loaded* with that reason.
One bad manifest must never take the app down.

**A cycle or a duplicate id still throws.** Those are programming errors, not
configuration states; no amount of runtime tolerance makes a cyclic graph
loadable.

**`optionalDependencies` order, they never satisfy.** A present one is loaded
first and wired into `api.deps`; an absent one is ignored. They are also
ignored by `disable()`'s dependent check — an optional dependent must never
block its optional dependency from being turned off, or "optional" means
nothing at the one moment it is tested.

**Load order is a function of the manifest set alone.** Roots are visited in id
order, so enable order does not inherit `storage.list()`'s filesystem ordering.

**`api.has(id)` answers "loaded *and* enabled"** — a disabled addon has had its
classes, ops and menu entries unregistered, so it is no more usable than an
absent one. That is the guard an optional dependent degrades on:

```ts
export function register(api: AddonAPI<IAddon>) {
  if (api.has('litemesh')) {
    const lm = api.deps['litemesh'].exports['litemesh']
    // …full path
  } else {
    // …degraded path; not an error
  }
}
```

`tests/fixtures/addons/optional_probe*` are the worked example, exercised by
`tests/integration/addon_optional_probe.test.ts`.

## Force-disable

Force-disable withholds an addon **before it is loaded at all**: no module
import, no record, absent from `idmap`. Not "loaded but off" — that is what
makes `api.has(id)` correct by construction, and it is the state a distribution
that omits the addon is actually in. It applies to builtins as well as
installed addons. The manager keeps the id and a reason in `unloaded` so the UI
can say what happened.

Three sources, unioned and read once per session
(`scripts/addon/force_disable.ts`):

| Source | Form | Where it works |
| --- | --- | --- |
| URL query | `?disableAddons=a,b` | browser, and NW.js via its page URL |
| localStorage | `disabledAddons` = `a,b` | anywhere storage is permitted |
| CLI flag | `--disable-addon=<id>` (repeatable, also comma-separated) | the NW.js shell and the headless harness |

`setForceDisabledIds(ids)` overrides the detected set for tests and for a host
that decides its own distribution; `undefined` restores detection.

## Not in this build

An in-bundle builtin can depend on something that is not always installed — a
git submodule, a native binding. The rule, one predicate in
`tools/builtin_addons.js`:

> **A builtin addon whose optional workspace dependency is absent is not part of
> this build.**

Not "loaded but broken", not "stubbed": absent, the same state
[force-disable](#force-disable) produces, reached from the install rather than
from a flag. The addon declares the dependency in its **own** `package.json`,
never the host's:

```json
{
  "name": "@faber-leaf/addon-litemesh",
  "optionalDependencies": { "@sculptcore/api": "workspace:*" }
}
```

`optionalDependencies` is not a stylistic choice — it is the only `workspace:`
field pnpm tolerates when the target package is absent. `dependencies` and
`devDependencies` both hard-fail the whole install with
`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`; measured on pnpm 10.30.3. It still links
normally when the package is there, so the present-engine build is unchanged.

`discoverBuiltins()` resolves every such entry under the addon's
`node_modules/` or the repo root's. One predicate, four consumers, so the three
representations of "this build" cannot drift apart:

| Consumer | Available | Not available |
| --- | --- | --- |
| `tools/gen-tsconfig-paths.mjs` | `@builtin/<id>` → the addon's `entry` | → `scripts/addon/unavailable_builtin.ts`, and `addons/builtin/<id>` joins the generated `exclude` |
| `tools/esbuilder.js` alias | same | same (so the subtree never enters the bundle) |
| `tools/esbuilder.js` assets | the manifest's `buildAssets` are added | contributes nothing — its artifacts stop being a missing-file error |
| `AddonManager.registerBuiltin` | registers the real module | sees `unavailableBuiltin`, records `unloaded` with reason `not-in-build` |

`exclude` is *generated* rather than written in `tsconfig.json` because a child
config's `exclude` replaces its base's outright — it cannot be split between the
two. And `exclude` only filters the *initial* file set, so it is the
`@builtin/<id>` alias, not the exclusion, that actually keeps an absent addon's
source out of the program.

The `@builtin/<id>` indirection is why a distribution imports the entry through
an alias and the manifest relatively: the entry is conditional, the metadata
never is.

Nothing a developer does day to day exercises any of this, so CI does: the
`no-sculptcore` job in `.github/workflows/pr.yml` deinits the sculptcore
submodule, then typechecks, builds the `faber-leaf-core` distribution
(`pnpm build:core`) and runs `pnpm smoke:core`
(`tools/distribution-smoke.mjs`) — which boots the real app headlessly and
models, saves and reloads a mesh with the engine absent. The static gates alone
pass on a tree that boots to a blank error screen, which is why the runtime half
exists.

## The `register(api)` hook

```ts
import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {MyMesh, MyToolMode, MyToolOp, MyCustomDataElem} from './stuff.js'

export const addonDefine: IAddonDefine = {
  name       : 'My Addon',
  version    : [1, 0, 0],
  author     : 'you',
  description: '...',
}

export function register(api: AddonAPI<IAddon>) {
  api.registerAll(MyMesh, MyToolMode, MyToolOp, MyCustomDataElem)
}

export function unregister()  {}
export function handleArgv()  {}
export function validArgv()   {}
```

`api.register(cls)` dispatches by class type — one call handles
`ToolOp` / `ToolMode` / `DataBlock` / `CustomDataElem` / `SceneObjectData` /
`Editor` / plain `nstructjs` registration. `api.registerAll(...classes)` is
the bulk variant. Classes registered this way are tracked per addon, so
`api.unregisterAll()` cleanly tears them back out on disable.

**Do not** write module-scope `ToolOp.register(Foo)` / `ToolMode.register(Foo)`
/ etc. side effects in addon code. They bypass the per-addon registry, can't
run in dependency order, and can't be undone on disable.

The one exception is `nstructjs.inlineRegister(this, structSrc)` written as a
static-field initializer:

```ts
class Foo {
  static STRUCT = nstructjs.inlineRegister(this, `
    Foo {
      x : float;
    }
  `)
}
```

`inlineRegister` runs at class-definition time and *must* complete before the
class is first instantiated, which may happen before any addon's
`register(api)` runs. It's idempotent — leave it where it is.

## Distributions

A **distribution** is the product this bundle is: which addons ship, which
startup scene opens, what the window is called. It is a manifest, not a fork —
`distributions/<id>/index.ts`, and nothing in it may hold product logic. Both of
today's are ~20 lines:

```ts
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

`bundled(manifest, module)` is the in-bundle form: the entry comes in through
the `@builtin/<id>` alias and the manifest relatively, because the entry is
conditional and the metadata is not — see
[Not in this build](#not-in-this-build). `external(id)` names an addon that is
already discoverable from `build/addons/index.json`; both take an optional
`{enabled}` that overrides the manifest's `defaultEnabled`, so an addon that
ships off in one product can ship on in another.

`scripts/entry_point.js` imports exactly one of these, through `@distribution`,
and calls `addonManager.loadDistribution(dist)` before `startAddons()`. That is
the only place the app names a product.

**The addon list is an allow-list for shipped first-party addons only.** A
builtin — in-bundle, or an `index.json` entry carrying `builtin: true` — that the
distribution omits is never loaded — no module import, no record, the same state
[Force-disable](#force-disable) produces, so `api.has(id)` stays correct by
construction (reason `not-in-distribution`).

Two kinds of addon are *not* filtered, because neither one is a shipping
decision:

- **Third-party addons the user installed from storage.** Installing one was a
  user decision.
- **Test fixtures** (`tests/fixtures/addons/*`). They appear in `index.json`
  only when the build was asked for them (`tools/build-addons.js
  --include-fixtures`), which is a harness concern. `index.json` records the
  difference as `builtin` / `kind`, so the manager reads it rather than
  inferring it from where the entry came from.

Both exemptions are still force-disablable — that combination is what
`tests/integration/addon_optional_probe.test.ts` drives.

**The startup scene is selected by name.** Addons contribute named scenes with
`api.registerDefaultSceneBuilder(name, fn, toolMode?)` and the distribution picks
one, which is what keeps the startup file independent of addon load order. With
nothing selected and exactly one scene registered, that one is used — so unit
tests and single-geometry builds need no manifest.

Building a non-default distribution is `node tools/esbuilder.js --distribution
<name>` (`pnpm build:core` for `faber-leaf-core`). `tools/distributions.mjs`
reads two facts out of the entry file's *source* before esbuild runs: what
`@distribution` resolves to, and which `@builtin/<id>` specifiers it imports.
That second set decides which addons contribute build assets (litemesh's WASM) —
it is the same specifier esbuild resolves, not a guess about intent.

`registerBuiltin` only records a *source*: it validates the manifest, honours
force-disable, the distribution allow-list and the not-in-build sentinel, and
hands the rest to `start()`. Nothing is registered or enabled here, so an
in-bundle addon has no earlier lifecycle than an out-of-bundle one — it is just
already imported. (Registering after `start()` has run, as tests and HMR do,
materializes and enables it immediately so it still behaves like a boot-time
builtin.)

The runtime surface peer addons see through `@addon/<id>/api` comes from the
addon's own `src/api.ts`; `register(api)` is where classes actually register.

## `@framework/api` — single framework-import surface

Addons reach for framework primitives (Vector3, ToolOp, DataBlock, pathux UI,
…) through one alias:

```ts
import {Vector3, ToolOp, FloatProperty, DataBlock} from '@framework/api'
import type {ViewContext, IAddon, AddonAPI} from '@framework/api'
```

- The alias resolves to `scripts/framework_api.ts`, configured in both
  `tools/esbuilder.js` and `tools/build-addons.js` and emitted into the
  generated `tsconfig.paths.json` (`pnpm gen:paths`) that `tsconfig.json`
  extends.
- pathux is re-exported wholesale (`export * from './path.ux/scripts/pathux.js'`),
  so the full `nstructjs` / `ToolOp` / property classes / KeyMap / HotKey /
  DataAPI / UIBase surface is available without extra wiring.
- If you need a framework symbol that isn't re-exported yet, **add it to
  `scripts/framework_api.ts`** — do not write `../../../../scripts/foo.js`.

Cross-layer edges are machine-checked rather than listed in prose: `pnpm
check:layers` fails on any `error`-severity rule and on any count over its
`tools/layer-baseline.json` budget. A host file importing addon source, or an
addon reaching a peer through a `scripts/...` path, is caught there.

## `@addon/<id>/api` — peer-addon import surface

When one addon imports another, it goes through the typed shim file
`addons/builtin/<id>/src/api.ts`. The `tools/addon_api_plugin.js` esbuild
plugin reads that shim and replaces each import with a runtime lookup:

```ts
// In addon B:
import {SomeMeshClass} from '@addon/mesh/api'
// → resolved at runtime to globalThis._addons.getAddonAPI('mesh').exports['mesh'].SomeMeshClass
```

This indirection lets the loader topologically sort by manifest
`dependencies` and lets the addon be disabled cleanly.

**Main-bundle lazy-access rule.** The same `@addon/<id>/api` plugin is also
wired into the *main* esbuild (`tools/esbuilder.js`), so main-bundle code can
import an addon's surface without statically pulling its source into the main
bundle. But the generated stub binds `export const X = __pick("X")` at the
consumer module's **load time**, and in the main bundle that runs *before*
`AddonManager.start()` enables any addon — so an eager module-scope read gets a
sentinel that throws the moment it is called, constructed or dereferenced
(naming the addon and the symbol), rather than the value. Main-bundle code must therefore access addon
exports lazily (via the getters in `scripts/addon/addon_base.ts`'s
`lookupAddonExport`), never through eager `@addon/<id>/api` value imports used
at module top level. Inside an addon's own bundle the ordering is guaranteed by
the manifest `dependencies`, so eager imports are fine there.

The `api.ts` shim must list every value an addon publishes to peers, and the
namespace the addon passes to `api.exportNamespace('<id>', {...})` from inside
`register()` must mirror that list at runtime — the shim is what consumers
compile against, the namespace is what they get.

## Adding a new builtin addon — checklist

1. `addons/builtin/<id>/manifest.json` — id, version, entry, dependencies
2. `addons/builtin/<id>/src/main.ts` — `addonDefine` + `register(api)` /
   `unregister()` / `handleArgv()` / `validArgv()`
3. `addons/builtin/<id>/src/api.ts` — re-export the addon's public surface
4. `addons/builtin/<id>/package.json` if the addon has npm/workspace
   dependencies of its own — the host's `scripts/package.json` must not carry
   them. A dependency that may be absent goes in `optionalDependencies`; see
   [Not in this build](#not-in-this-build)
5. Implementation modules use `@framework/api` and `@addon/<id>/api` only
   (no `../../../../scripts/...`)
6. Add it to whichever distributions ship it (`distributions/<id>/index.ts`):
   `external('<id>')`, or — in-bundle only — `bundled(manifest, module)` with a
   static `@builtin/<id>` import, plus the manifest's `buildAssets` for any
   extra entry point the bundle has to emit. See
   [Distributions](#distributions).
7. `pnpm gen:paths` (picks up `@addon/<id>/api` and `@builtin/<id>`), then
   `pnpm build` and `npx tsgo --noEmit` should both stay green
