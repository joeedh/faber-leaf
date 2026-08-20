# Embedding Faber Leaf

Faber Leaf mounts as a component: one call puts an app instance inside a
container element, and the handle it returns takes it back down again. The
shipped shells — `index.html` in the browser, `nwjs/window.html` on the desktop
— boot through exactly that call, so an embedder never runs a path the product
does not.

```ts
import {mountFaberLeaf} from './build/entry_point.js'
import faberLeaf from './distributions/faber-leaf.js'

const handle = await mountFaberLeaf(document.querySelector('#app'), {
  distribution: faberLeaf,
})

// …later
handle.unmount()
```

## 1. What you may rely on

### `mountFaberLeaf(container, options)`

| option | meaning |
| --- | --- |
| `distribution` | The product definition (§3). Read once, by the **first** mount on the page. |
| `iconSheetUrl` | Explicit icon-sheet URL. Process-wide; the first mount wins. |
| `loadDefaultFile` | Open the built-in default scene. Defaults to `true`. |
| `activate` | Make this the instance the app's globals resolve to. Defaults to `true`. |

Returns a promise for a handle:

| member | meaning |
| --- | --- |
| `state` | The instance's `AppState`. **Not** stable — see §2. |
| `container` | The element passed in. |
| `activate()` | Route `getAppState()` and everything built on it to this instance. |
| `unmount()` | Release the DOM, the WebGPU device, listeners, timers and the registry entry. Idempotent. |

`unmount()` is a real release, not a hide: the instance's canvas leaves the
document, its `GPUDevice` is destroyed, its autosave timer is cleared, and its
registry entry is dropped. Mounting and unmounting in a loop does not grow any
of those — `tests/integration/mount_lifecycle.test.ts` asserts it, mounting and
unmounting three times in the real app and then running two instances side by
side.

`mountFaberLeaf` ships from the bundle entry (`build/entry_point.js`), not from
`@framework/api`. Mounting the app is a page-level act; an addon runs *inside*
an instance and has no business starting another.

### The instance registry

```ts
import {getAppState, peekAppState, listAppInstances, withAppInstance} from '@framework/api'
```

`getAppState()` returns the active instance and throws if none is mounted;
`peekAppState()` returns `undefined` instead. `withAppInstance(state, fn)` runs
`fn` with `state` active and restores the previous one afterwards. Addon code
should reach the app through these and never through a global.

### `@framework/api`

The single import surface for addons (`scripts/framework_api.ts`). Everything
re-exported there is part of the contract; nothing else under `scripts/` is.
See [addons.md](addons.md).

### The addon manifest schema

`addons/<id>/manifest.json`, as consumed by `tools/build-addons.js` and the
runtime loader. Documented in [addons.md](addons.md).

### `globalThis._framework`

The runtime namespace externalized addon bundles resolve `@framework/api`
against. It is load-bearing for every packaged addon and is **not** going away.

## 2. What is explicitly not stable

- **`handle.state` and everything reachable from it.** `AppState`, `ViewContext`,
  `Library`, the editors — internal shape, changed without notice.
- **Anything under `scripts/` that `@framework/api` does not re-export.** A deep
  import is a private API by definition.
- **`window.DEBUG` and `CTX`.** Debug and test-automation surfaces
  ([debugSurface.md](debugSurface.md)). Their contents move whenever the code
  behind them does.
- **Every remaining global shim** (§5).
- **The `.wproj` format's internals.** The compatibility *contract* is stable
  (§4); the bytes are not.

## 3. Distribution overrides

A distribution is a manifest, not a fork — P17's rule. It declares:

- **which addons ship**, in-bundle or external, and which start enabled;
- **the startup scene**;
- **branding** — the product name the window and the UI use.

That is the whole override surface. Anything a distribution cannot express is a
missing feature of the distribution mechanism, not a licence to patch
`scripts/`. Two distributions differ only by their manifest; if one needs a code
change the other does not, the change belongs behind an addon or a feature flag
([featureFlags.md](featureFlags.md)).

The distribution is read once per page, by the first mount. A page cannot mount
two instances under two different distributions today — the addon registry is
process-wide.

## 4. File-format compatibility (open decision #9)

**There is no one-way break.** A `.wproj` carries its own struct schema, so an
older build decodes a newer file's blocks and preserves whatever it has no class
for. That is the guarantee:

- **Newer file, older build** — opens. Anything the build does not understand is
  round-tripped byte-identically as a preserved block, not merged and not
  dropped. The app warns: *"File is from a newer version; unrecognized parts are
  preserved as-is."*
- **Older file, newer build** — opens, and migrates on load.
- **A genuinely one-way break** would be listed in `BREAKING_FILE_VERSIONS`
  (`scripts/core/const.ts`). The list is **empty**, and a file above it is
  refused with *"It cannot be opened here — please update"* rather than surfacing
  as corruption. The guard shipped in format 9 so that a future break can
  announce itself; it does not describe one that happened.

What did change, at format 9: struct ids are derived from struct **names** rather
than registration order (`STABLE_STRUCT_ID_VERSION`). The consequence is narrow
and only affects preserved bytes — blocks preserved out of a pre-9 file cannot be
spliced into a file written by this build, because their ids mean something else.
Format 8 also moved selection masks from ints to names.

Current `APP_VERSION` is **9**.

## 5. Compatibility shims, and when they end

| shim | status | ends |
| --- | --- | --- |
| `window._appstate` | Alias to the **first-mounted** instance. Kept for the devtools console, the CDP harness (`nwjs/cdp.mjs`) and the e2e suites. | **2027-02-01.** Migrate to `CTX` / `getAppState()`; it names the wrong instance the moment a second one mounts. |
| `window._gl` | Alias to the active instance's context (a throwing WebGPU stub under the default renderer). | **2027-02-01.** Read `state.glCanvas` / `ctx.gl` instead. |
| `globalThis._framework` | **Permanent.** Not a shim — the addon runtime seam (§1). | — |
| `window.DEBUG`, `CTX` | **Permanent**, contents unstable (§2). | — |

`window._SelMask` and `window.redraw_uveditors` were removed outright; nothing
read them. The fixed-id DOM lookups went with them — `#canvas2d`, `#canvas3d`
and `#content` are gone from `index.html`, and `#webgl` is now reached as
`state.glCanvas`. `tests/unit/document_scope.test.ts` keeps them out: host code
under `scripts/` may not call `document.getElementById` / `querySelector`, with
one exemption for `setup_pathux.js`, which resolves the process-wide icon sheet
from the host page (`#iconsheet`) when the embedder supplies no `iconSheetUrl`.
That is what the NW.js shell relies on — `nwjs/window.html` sits one directory
below the app root, so a path-relative default would aim at `nwjs/assets/`.

## 6. `@framework/api` semver policy

The hub is versioned with the app.

- **Breaking** — removing an export, narrowing a type, or changing a function's
  runtime behaviour in a way a caller can observe. Allowed only on a **major**
  bump.
- **Additive** — a new export, a widened parameter type, a new optional field.
  **Minor**.
- **Fixes** — behaviour brought back in line with documented intent. **Patch**.

Announcing a break, in order:

1. the export is marked `@deprecated` in `scripts/framework_api.ts` with the
   version that removes it, for at least one minor release;
2. `documentation/addons.md` records the replacement;
3. the removal lands in the next major.

Re-exporting a symbol through the hub is a commitment. If a symbol should not
carry one, do not export it — an addon that deep-imports instead has taken the
risk knowingly (§2).

## 7. Limits worth knowing

- **One distribution per page** (§3).
- **Icon sheet, units and path.ux constants are process-wide.** They are
  configured by the first mount; later mounts inherit them.
- **Preferences are shared; documents are per-instance; autosave is neither.**
  Settings and feature flags live under one `localStorage` namespace
  (`APP_KEY_NAME`) for the whole page — two instances see the same preferences,
  deliberately. Each instance owns its own `Library`, so scenes, selections and
  undo stacks are independent. Crash-recovery autosave is the exception: the
  backend has a single slot per app identity, so **only the first-mounted
  instance arms it** (`AppState.enableAutosave`). A second instance's document
  is not backed up, and cannot clobber the first one's recovery slot. If you
  need autosave for an embedded instance, save explicitly.
- **`unmount()` does not undo the process boot.** Addons stay registered and
  path.ux stays configured; a later `mountFaberLeaf` reuses both.
