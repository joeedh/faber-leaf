# Feature Flags

**Source:** `scripts/core/feature-flag.ts` (the manager),
`addons/builtin/litemesh/src/feature_flags.ts` (an example flag set).

Feature flags are boolean knobs that control opt-in or experimental features.
They are persisted per-user through the app storage backend
(`scripts/core/app_storage.ts`) and exposed to the Data API so they can be
wired into UI panels with the standard binding system.

**Flags belong to addons, not to the host.** A flag describes a feature, and
features live in addons, so the host defines none: an addon registers its own
from its `register(api)` hook and a build without that addon neither lists the
flag in Settings nor knows the key exists. See
[addons.md](addons.md) for what "not in this build" means.

## Using a flag

Import the singleton and call `get`:

```ts
import {FeatureFlags} from '@framework/api' // '../core/feature-flag' from host code

if (FeatureFlags.get('sculptcore.quad_remesher')) {
  // ...
}
```

`get` returns the stored override if one exists, otherwise the registered
default — and `false` if no addon in this build registered the key at all, so a
gate on an absent addon's flag reads closed rather than throwing.

To gate a whole feature's UI, cover every surface:

- widgets/panels — wrap the `buildHeader`/`buildSettings` calls in
  `if (FeatureFlags.get(...))` (see `SculptCorePaintMode` for
  `litemesh.quad_remesh`);
- the op-search menu — override the ToolOp's `static canRun(ctx)` to return the
  flag (`searchBoxOk` consults it, and it also blocks execution).

The singleton is also exposed as the `window.FeatureFlags` debug-surface global
(see [debugSurface.md](debugSurface.md)) for CDP / `--eval` probes; `set`
persists immediately, so probes should restore the prior value.

## Setting / resetting a flag

```ts
FeatureFlags.set('sculptcore.quad_remesher', false) // override
FeatureFlags.reset('sculptcore.quad_remesher')      // back to default
```

`set` persists the change and emits a `FLAG_SET` bus event (`FeatureFlagManager`
event channel) so listeners can react at runtime.

## Reacting to changes

```ts
import messageBus from '../core/bus'
import {FeatureFlagManager} from '../core/feature-flag'

messageBus.on(FeatureFlagManager, 'FLAG_SET', ({key, value}) => {
  // ...
})
```

## Adding a flag

Flags go in the owning addon, in one `as const satisfies readonly FeatureFlag[]`
array — `addons/builtin/<id>/src/feature_flags.ts` by convention:

```ts
import type {FeatureFlag} from '@framework/api'

export const MY_FEATURE_FLAGS = [
  {
    key        : 'my_feature.thing',
    description: 'Human-readable description shown in UI',
    type       : 'bool',
    value      : false,   // default value
  },
] as const satisfies readonly FeatureFlag[]

type MyFeatureFlagKey = (typeof MY_FEATURE_FLAGS)[number]['key']

declare global {
  interface FeatureFlagRegistry extends Record<MyFeatureFlagKey, boolean> {}
}
```

`uiName` is optional; if omitted the key is used as the display label.

Register the array first thing in `register(api)`, before anything that might
read a flag — an unregistered key reads `false`, so a late registration
silently takes the default path for one boot:

```ts
api.registerFeatureFlags(MY_FEATURE_FLAGS)
```

`registerFeatureFlags` undoes itself when the addon is disabled (the
definitions drop; stored *values* stay, so re-enabling restores the user's
toggles).

`FeatureFlagKeys` is `keyof FeatureFlagRegistry`, which every addon merges its
own keys into by declaration merging — that is what keeps
`FeatureFlags.get('my_feature.thing')` typo-checked without the host ever
naming a key. A build where all such augmentations are absent degrades the type
to `string`: looser, but never wrong.

## Data API / UI binding

`FeatureFlagManager.defineAPI` registers each flag as a bool property on the
manager's `DataStruct`, and the manager is rooted in the context tree at
`settings.featureFlags` (via an `AppSettings` getter — flag storage stays
separate from AppSettings persistence). Flag keys contain dots, which datapath
member names cannot, so each property's apiname is the mangled
`featureFlagApiName(key)` (non-word characters → `_`):

```
settings.featureFlags.sculptcore_quad_remesher
```

`getDataAPI()` is one-shot and runs *before* addons start, so by the time an
addon registers, the struct is already built. `AddonAPI.registerFeatureFlags`
therefore declares each flag's member against the live `_appstate.api` as well —
`defineFeatureFlagMember` is the shared helper, and `FeatureFlags.markDefined`
keeps the two routes from declaring the same key twice.

That also means these paths are **not** in the generated catalog
(`pnpm gen:paths`), which only walks what `getDataAPI()` builds — the same way
none of an addon's other paths are. They resolve at runtime; the e2e test below
is what guards them.

The Settings editor (`scripts/editors/settings/SettingsEditor.ts`) lists every
flag as a checkbox in its **Feature Flags** tab, built from
`FeatureFlags.definitions` + `featureFlagApiName`, so new flags appear there
with no editor changes. `tests/e2e/settings_editor.e2e.ts` guards the tab and
the path round-trip.

## Persistence and merge semantics

Flags are serialized as JSON under the storage key `feature-flags-app`, written
through `getAppStorage()` (`scripts/core/app_storage.ts`) — **not** raw
`localStorage` or mathl's emulated local storage. The backend is chosen at
runtime: the browser build stores the JSON in `localStorage`, while the NW.js
build writes it to a discrete `feature-flags.json` file under the `.sculptcore`
directory (`<repo>/.sculptcore` from source, `~/.sculptcore` when packaged).
The key→filename mapping lives in `FILE_NAMES` in `app_storage.ts`.

The `save()` / `merge()` path uses last-write-wins by `mtime`: if the same key
appears in both the in-memory list and the stored JSON, whichever has the higher
`mtime` wins. Unknown keys from storage are preserved (forward-compatible).
`value: undefined` in storage means "use the default" — only explicit overrides
are stored.
