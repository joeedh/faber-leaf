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

Builtin addons today: `leafmesh` and `sculptcore`. `leafmesh` is the home of
the `LeafMesh` DataBlock, its attribute layers, and its picking / selection /
modeling ops; `sculptcore` owns the sculpt toolmode, the brushes, and the
`litemesh.add_*` entries in the Add menu.

Every class an addon owns is registered from its `register(api)` hook, through
`api.register` / `api.registerAll` — there is no generated class list to keep
in sync.

## Anatomy

```
addons/builtin/<id>/
├── manifest.json         # id, version, entry, dependencies
└── src/
    ├── main.ts           # external entry point (per-addon esbuild output)
    ├── addon_register.ts # internal entry — registerInternalAddon(...)
    ├── api.ts            # public surface re-exported to peer addons via @addon/<id>/api
    └── *.ts              # implementation
```

Two ways an addon ships:

- **Internal (in-bundle).** Imported eagerly from `scripts/entry_point.js`.
  Calls `addonManager.registerInternalAddon({manifest, exports, register})`
  at module load.
- **External (per-addon esbuild output).** Loaded by `AddonManager` from
  `build/addons/<id>/main.js`. Calls the `register(api)` export at addon-
  init time.

Both paths converge on the same `register(api)` hook, so the registration
code is identical regardless of ship mode.

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
  if (api.has('sculptcore')) {
    const sc = api.deps['sculptcore'].exports['sculptcore']
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

## Internal-addon registration

The `addon_register.ts` file (loaded at module-import time from
`scripts/entry_point.js`) wires the addon into `AddonManager`:

```ts
import {addonManager} from '@framework/api'
import {MyToolMode, MyMesh} from './stuff.js'

if (!addonManager.idmap.has('my_addon')) {
  addonManager.registerInternalAddon({
    manifest: {
      id          : 'my_addon',
      name        : 'My Addon',
      version     : '1.0.0',
      entry       : 'internal',
      dependencies: ['mesh'],
      buildMode   : 'prebuilt',
      author      : 'you',
      description : '…',
    },
    exports: {
      // Mirrors src/api.ts — what peer addons see via @addon/my_addon/api.
      my_addon: {MyToolMode, MyMesh},
    },
    register(api) {
      api.registerAll(MyToolMode, MyMesh)
    },
  })
}
```

`exports` declares the runtime surface for `@addon/<id>/api`. `register(api)`
runs after the record is wired in and is the place to do the actual class
registration.

## `@framework/api` — single framework-import surface

Addons reach for framework primitives (Vector3, ToolOp, DataBlock, pathux UI,
…) through one alias:

```ts
import {Vector3, ToolOp, FloatProperty, DataBlock} from '@framework/api'
import type {ViewContext, IAddon, AddonAPI} from '@framework/api'
```

- The alias resolves to `scripts/framework_api.ts`, configured in both
  `tools/esbuilder.js` and `tools/build-addons.js` and listed in
  `tsconfig.json` `paths`.
- pathux is re-exported wholesale (`export * from './path.ux/scripts/pathux.js'`),
  so the full `nstructjs` / `ToolOp` / property classes / KeyMap / HotKey /
  DataAPI / UIBase surface is available without extra wiring.
- If you need a framework symbol that isn't re-exported yet, **add it to
  `scripts/framework_api.ts`** — do not write `../../../../scripts/foo.js`.

The lone exceptions in the tree are documented in
`documentation/archive/TODO.md` and represent known cross-layer references that
need a deeper restructure — today the announcement shim in
`sculptcore/src/api.ts`, for classes that haven't yet physically moved out of
`scripts/editors/view3d/tools/`. (The mesh → `pbvh_sculpt` `instanceof` check
that used to be listed here went away with that addon in P5; mesh now tests
`instanceof PaintToolModeBase` off `@framework/api`.)

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

The `api.ts` shim must list every value an addon publishes to peers, and
the corresponding `addon_register.ts`'s `exports.<id>` object must mirror
that list at runtime.

## Adding a new builtin addon — checklist

1. `addons/builtin/<id>/manifest.json` — id, version, entry, dependencies
2. `addons/builtin/<id>/src/main.ts` — `addonDefine` + `register(api)` /
   `unregister()` / `handleArgv()` / `validArgv()`
3. `addons/builtin/<id>/src/addon_register.ts` if shipping internal —
   `addonManager.registerInternalAddon(...)` with a `register(api)` callback
4. `addons/builtin/<id>/src/api.ts` — re-export the addon's public surface
5. Implementation modules use `@framework/api` and `@addon/<id>/api` only
   (no `../../../../scripts/...`)
6. Add the manifest id to `scripts/entry_point.js` if it ships internal
7. `pnpm build` and `npx tsgo --noEmit` should both stay green
