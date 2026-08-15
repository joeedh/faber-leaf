# P2 — W0: rename + identity migration

**Status:** done — landed 2026-08-15. Steps 1 and 4 in commit `09570d73`
(+ sculptcore `905c4c4`); steps 2, 3 and 5 in the commit that flipped this line.
Corrections found while implementing are folded into the text below and marked
**[corrected]**.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W0, §5 phase 2, §9.3 P2.

**Workstream / phase:** W0 / phase 2.

**Depends on:** P1 (so the rename is verified by something). **Blocks:** nothing.

**Authoring effort:** high.

**Settles:** open decision #7 (freeze the storage keys, or migrate them).

> Line references carried from the strategy doc; re-verify before editing.

---

## 1. Goal

Finish the rename from `webgl-app-framework` to Faber Leaf **without losing any
user's startup scene, settings, or installed third-party addons.**

The rename looks like trivia and is not: the old name is simultaneously the
pnpm root package name, the NW.js manifest name, the key Chromium derives the
profile and Crashpad directory from, two raw `localStorage` keys, and an
**IndexedDB database name**. Renaming that last one blind uninstalls every
third-party addon the user has, silently.

## 2. Why now

The rename is currently *half-applied* — the GitHub remote is already
`joeedh/faber-leaf` and `index.html:15` already says `<title>FaberLeaf</title>`
— which is the state that breeds inconsistency bugs. It is also entirely
independent of W1–W5, so it can run in parallel with the spine and get out of
the way.

## 3. Current state

**Cosmetic (safe to change).**

| Item | Location |
| --- | --- |
| pnpm root package name | `package.json:2` — `"webgl-app-framework"` |
| Readme | tracked as `Readme.MD` (git on Windows is case-insensitive, so the working tree shows `README.md` — use the tracked spelling in `git` commands) |
| Tests workspace package | `@webgl-app-framework/tests-integration`, referenced by the root `test:slow` script (`package.json:24`) |
| **[corrected]** two more workspace packages the plan missed | `@webgl-app-framework/tests` (`tests/package.json`) and `@webgl-app-framework/addon-code-editor` (`addons/code_editor/package.json`) |
| App package misnamed | `scripts/package.json` is `@sculptcore/frontend` for what is the *app*, not sculptcore |
| gh-pages publish clone URL | `tools/publish-gh-pages.sh:14` — still the old GitHub URL; works only through GitHub's rename redirect |
| Already done | git remote; `index.html:15` |
| Needs no change | `.gitmodules` (four separate repos); `.github/workflows/deploy-pages.yml:127-129` hardcodes no repo name or base path — all app references are relative |
| Leave alone | `@sculptcore/api` — that is the real sculptcore package name |

**Load-bearing (each is the old name used as a persistent key).**

| Key | Location | Cost of renaming blind |
| --- | --- | --- |
| `APP_KEY_NAME` | `scripts/core/const.ts:2` | the seed for the two below |
| localStorage `webgl-app-framework` (startup scene) | `scripts/core/app_storage.ts:97-98` | the user's startup scene |
| localStorage `webgl-app-framework-settings` | `app_storage.ts:97-98`, `scripts/core/settings.ts:44` | all app settings |
| IndexedDB db `webgl-app-framework-addons` | `scripts/addon/storage.ts:189` | **every installed third-party addon vanishes** |
| NW.js profile + `.cache` dir | `nwjs/profile_dir.mjs:22,24` | profile and Crashpad dump location moves |
| `package.json` `name` | `package.json:2` | pnpm root name **and** NW.js manifest name **and** the key Chromium derives profile/Crashpad from (`nwjs/window.html:18-23`) |

**[corrected]** The last two rows overstate the coupling. `profile_dir.mjs` never
reads the manifest — it hardcodes the app name as a literal (it is
dependency-free ESM shared with the crash toolkit), so `package.json`'s `name`
and the profile path are two independent edits that merely have to agree. And
because `nwjs/launch.mjs` *always* passes an explicit `--user-data-dir`, the
manifest-name-derived Chromium default in `window.html` is dead in practice; the
only real consumer of that default was the stale fallback in
`sculptcore/crash/dump.mjs`.

## 4. Decision (open decision #7)

**Migrate, do not freeze.** Freezing leaves a shipping product whose on-disk
identity contradicts its name forever, and the migration is bounded: two
`localStorage` copies and one IndexedDB rename. The rename of the *NW.js
profile directory* is the one place a freeze is defensible — see step 4.

## 5. Plan

### Step 1 — cosmetic rename (one commit)

- `package.json` `name` → `faber-leaf`. **Note this also moves the NW.js
  profile**; step 4 handles that, so land steps 1 and 4 together or keep the
  profile-dir derivation pinned in step 1 and change it in step 4.
- `Readme.MD`, branding strings, `tools/publish-gh-pages.sh:14`.
- `@webgl-app-framework/tests-integration` → `@faber-leaf/tests-integration`,
  updating `package.json:24`'s `test:slow` filter in the same commit.
- `scripts/package.json` `@sculptcore/frontend` → `@faber-leaf/host`; update
  every `workspace:` reference and `pnpm-workspace.yaml` consumers.
- Run `pnpm i` from clean and `pnpm build` — pnpm workspace renames break
  silently until reinstall.

### Step 2 — the storage-key migration module

New `scripts/core/identity_migration.ts`, called once from app boot **before**
`app_storage` or `settings` read anything:

```ts
const LEGACY_APP_KEY = 'webgl-app-framework'

// [corrected] the storage backend is injected rather than fetched via
// getAppStorage(): a runtime import of app_storage drags in scripts/util/util.js
// -> path.ux, which jest cannot load, and the module would not be unit-testable.
// entry_point.js passes getAppStorage() in.
export async function migrateAppIdentity(storage: AppStorage): Promise<void> {
  migrateTextKey(storage, LEGACY_APP_KEY, APP_KEY_NAME)
  migrateTextKey(storage, LEGACY_APP_KEY + '-settings', APP_KEY_NAME + '-settings')
  await migrateAddonDatabase(LEGACY_APP_KEY + '-addons', ADDON_DB_NAME)
}
```

**[corrected]** Two supporting changes this needed:

- `scripts/core/const.ts` imported `config/config.js` solely to re-export
  `cacheSelectBufs`, which **nothing consumes**. Removing it makes `const.ts`
  import-free, which is what lets `app_storage.ts`, `addon/storage.ts` and this
  module all take `APP_KEY_NAME` from one place instead of re-spelling literals.
- `scripts/addon/storage.ts` now exports `ADDON_DB_NAME` (` `${APP_KEY_NAME}-addons` `)
  so the migration targets the exact name the addon backend opens; a unit test
  asserts the two agree.

Migration is a no-op on file-backed (NW.js) storage: `FILE_NAMES` in
`app_storage.ts` maps keys to **fixed filenames** (`startup.bin`,
`settings.json`), so the rename moved only the keys, never the files.

Rules the implementation must follow:

- **Copy, then mark, never move.** Write the new key, write a
  `<newkey>-migrated-from-legacy` marker, and leave the legacy key in place.
  A user who downgrades keeps a working install; disk cost is one scene blob.
- **Idempotent.** If the new key exists, do nothing — never overwrite newer
  data with older.
- **Never throw.** A failed migration must degrade to "fresh profile", not to
  "app does not boot". Log loudly through the same path a failed file migration
  uses.

### Step 3 — the IndexedDB rename (the dangerous one)

IndexedDB has no rename primitive. The migration is: open the legacy database,
enumerate its object stores, open the new database at the same schema version,
copy every record in one transaction per store, then leave the legacy database
intact (do **not** `deleteDatabase` in the same release).

- Guard on `indexedDB.databases()` where available; fall back to opening the
  legacy name and treating `onupgradeneeded` firing at version 1 as "no legacy
  data" (then abort the upgrade and delete the accidentally-created empty db).
- The store list must be read from the legacy db, not hardcoded, so a schema
  the current build does not know about still copies.
- After copy, verify record counts per store and only then write the marker.
- Schedule the legacy-database deletion for a later release, tracked in
  `ImmediateTODOs.md`. Not in this plan.

### Step 4 — the NW.js profile directory

`nwjs/profile_dir.mjs:22,24` hardcodes the app name in the profile and `.cache`
path (**[corrected]** — it does not derive it from the manifest; see §3).
Changing it relocates the profile, which loses Chromium-level state (not app
state — that is steps 2–3) and moves where Crashpad dumps land
(`documentation/plans/crashpad.md`).

Two acceptable outcomes; pick one and state it in the commit message:

- **(a) Move it**, and update `documentation/plans/crashpad.md` plus the
  `SC_CRASHDUMP_DIR` guidance so the toolkit still finds dumps. Add a one-time
  copy of the old profile dir if present.
- **(b) Pin the profile name** to the legacy string in `profile_dir.mjs` with a
  comment explaining that it is a Chromium-level key, not a brand string.

Recommend (a) with the copy, so nothing is left carrying the old name.

**Taken: (a) without the one-time copy.** Copying a live Chromium profile
carries a stale `SingletonLock` and GPU caches into the new directory — a worse
failure mode than starting clean, for state that is entirely regenerable. The
cost is that pre-rename crash dumps stay under the old
`%LOCALAPPDATA%\webgl-app-framework\` path; `documentation/plans/crashpad.md`
says so.

### Step 5 — sweep

`grep -rn "webgl-app-framework"` over the tree; every surviving hit is either
the legacy constant in `identity_migration.ts`, a test fixture asserting the
migration, or a bug.

**[corrected]** Three categories of hit are legitimately *not* the app identity
and are left alone: the on-disk checkout path (`C:/dev/webgl-app-framework`,
which the repo directory and the agent worktree still use — quoted throughout
`CLAUDE.md` and the research docs), the vendored-nstructjs branch name
`webgl-app-framework-patches`, and completed plans quoting historical commands.
Two `Readme.MD` files under `scripts/` now read "the Faber Leaf repo (formerly
webgl-app-framework)" rather than dropping the old name, since they exist to
point readers at where the code went.

## 6. Tests

- **Unit** (`tests/unit/`): `migrateAppIdentity` is idempotent; does not
  overwrite existing new-key data; tolerates a corrupt legacy blob; tolerates
  `localStorage` throwing (private-browsing / quota).
- **Integration**: seed a fake legacy IndexedDB with two addon records, run the
  migration, assert both records exist under the new database name with
  identical bytes, and that the legacy database still exists.

**[corrected]** Both live in one file, `tests/unit/identity_migration.test.ts`
(11 tests), because `fake-indexeddb` is installed globally by
`tests/lib/jest-setup.ts` in the *unit* workspace — the NW.js integration suites
have no IndexedDB. "Corrupt legacy blob" needs no dedicated case: values move as
opaque text and are never parsed, so any byte sequence round-trips; the
round-trip tests use non-base64 payloads to keep that honest.
- **Manual, required before ship**: take a real profile written by the current
  build (with at least one third-party addon installed from
  `addons/` — e.g. `graphit` or `morph`), run the renamed build, and confirm
  the startup scene, settings, and the installed addon all survive.
- `pnpm i` from clean, `pnpm test`, `pnpm build` green under the new names.

## 7. Risks

- **IndexedDB copy failure is silent and total.** Mitigation: copy-not-move,
  count verification before the marker, and the manual test above is a
  ship-blocker, not a nice-to-have.
- **Package rename breaks the pnpm workspace link graph** in a way that only
  shows on a clean install. Mitigation: `rm -rf node_modules && pnpm i` in the
  same commit, and let P1's CI (which installs from clean) be the gate.
- **Crashpad dumps silently stop being found** after the profile moves.
  Mitigation: step 4 updates the crashpad doc in the same change.

## 8. Exit criteria

- `pnpm i` from clean, `pnpm test`, `pnpm build` all green under the new names.
- A profile written by the pre-rename build opens with its scene, settings and
  installed third-party addons intact.
- `grep -rn "webgl-app-framework"` returns only the legacy constant and its
  tests.
- Open decision #7 recorded as settled in the strategy doc's §9.4 table.
