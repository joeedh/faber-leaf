# P10 — serialization + file-compat hardening — `[xhigh]`

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W1 step 5, §5 phase 7, §9.3 P10.

**Workstream / phase:** W1 / phase 7.

**Depends on:** P8. **Blocks:** P13, P15.

**Authoring effort:** **`[xhigh]`** — the one plan whose failure mode is silent
and discovered months later, in user files that cannot be re-created. It also
reaches into `vendor/nstructjs` and has to close a format question for a format
that is already shipping.

**Settles:** open decisions #3 (struct-id stability) and #9 (one-way format
break). **Closes:** success criteria 5, 6, 7, 8; contributes to 9.

> Line references spot-checked on 2026-08-15 against `vendor/nstructjs`.
> Re-verify the rest before editing.

---

## 1. Goal

Make this invariant true, and testable:

> **A `.wproj` opened by a build that does not have the addon which wrote part
> of it must load, preserve that part byte-exactly, re-save it intact, and
> re-open in the full build as live objects.**

## 2. This is not BREP cleanup

It applies to *any* addon that is not loaded — disabled by the user,
uninstalled, absent from the `faber-leaf-core` distribution, or deleted from the
tree. So it is written **once, generically**, against the addon boundary, and
not as a special case for the mesh addon. If a fix only works because the class
is called `Mesh`, it is the wrong fix.

Three distributions and one plan make this urgent simultaneously: P13 deletes
addons, P15 makes LiteMesh optional, and P17 ships a build that never had
sculptcore. All three produce files a *different* build must read.

## 3. Why it is `xhigh`

Everything else in this refactor fails loudly — a throw, a red test, a blank
viewport. This fails quietly: a file loads, looks fine, is re-saved, and has
silently lost the association between a scene object and its geometry. The user
finds out when they open it in the full build a month later and the model is
gone. There is no recovery, because the bytes were overwritten by the save that
looked successful.

The tree passes **none** of criteria 5–8 today, and their failure modes are
different enough — crash on load, silent reference loss, throw on save, silent
mis-decode — that one "it round-trips" assertion would hide three of them. Test
all four separately.

## 4. The four failures

### 4.1 Bytes + identity (criteria 5, 6)

Seven known defects in the preserve-unknown-data path:

| Site | |
| --- | --- |
| `scripts/core/lib_api.ts:1033`, `:1041`, `:1044-1046` | |
| `scripts/core/lib_api.ts:615-617` | |
| `scripts/core/appstate.ts:806` | |
| `scripts/sceneobject/sceneobject.ts:413-416` | |
| `scripts/core/missing_addon.ts:34-44`, `:82-89`, `:262` | |
| `addons/builtin/mesh/src/missing_customdata.ts:44` | the addon-side mirror of the same bug |

The load-bearing one is **parsing the preserved bytes far enough to recover
`lib_id`**. A `DataBlock` whose bytes are preserved but whose `lib_id` is not
recovered cannot be referenced: every `DataRef` pointing at it dangles, so the
`SceneObject` → geometry association is lost even though the geometry bytes
survived. Preserving bytes without identity is preserving a file the user
cannot open.

So the placeholder must:

- retain the original struct name and id,
- retain the raw payload verbatim (`_origBytes`),
- **decode `lib_id` and the block's own name/type from that payload** without
  understanding the rest of it,
- present itself to the `Library` as a real block for reference-resolution
  purposes, so `DataRef`s resolve to it,
- and re-serialize under the original identity, not the placeholder's.

### 4.2 The second struct path (criterion 7)

The unknown-class hooks are wired into **`StructTStructField` only** — the
`abstract(T)` path. `vendor/nstructjs/src/struct_intern2.ts:854-855` shows
`onSerializeUnknown` consulted there and an override struct looked up.

`StructStructField.pack` (`:735-739`) does not consult it at all:

```ts
let stt = manager.get_struct(type.data as string);
packer_debug("struct", stt.name);
manager.write_struct(data, val, stt);
```

It writes against the **declared** struct unconditionally. So a field declared
as a concrete `struct(T)` — not `abstract(T)` — hands the placeholder to
`write_struct` under `T`'s schema and it throws (or, worse, writes garbage).

Consequence today, before any deletion: **a curve or tet datablock throws on
save** in a build without its addon.

This is a change in `vendor/nstructjs`, which is a submodule. Budget:

- the fix in `StructStructField.pack` — consult `onSerializeUnknown` the same
  way `StructTStructField.pack` does, and fall back to the declared struct;
- **containers**: `StructArrayField.pack:1142` recurses through `do_pack`, so
  `array(T)` and `iter(T)` of a concrete `T` are affected identically. Fixing
  only the scalar path leaves the container path broken and it is the more
  common declaration. Cover both;
- a test **in nstructjs's own suite** (it has one — `vitest`), not only in this
  repo, because that is what stops the fix being lost on the next submodule
  update;
- a submodule commit + a gitlink bump in the same logical change, per the repo's
  submodule rules.

`array(abstract(T))` is already safe. `array(T)` is not. That distinction is the
one to grep the codebase for.

### 4.3 Struct-id stability (criterion 8, open decision #3)

nstructjs assigns struct ids by **global registration order** and embeds them in
`abstract(...)` payloads. So the id of every struct registered after a given
point shifts when the addon set changes — and **not only when an addon is
deleted**: adding a builtin addon shifts ids for everything registered after it.
This refactor does both, repeatedly.

Preserved `_origBytes` containing nested `abstract(...)` payloads carry ids that
were valid under the *writing* build's registration order. Replay them under a
different order and they decode as the wrong struct — silently, because an id is
just an integer.

Two options; **close this decision in this plan**:

- **(a) Pin ids in the format.** Give each struct a stable id derived from its
  name (a hash, or an explicit registry file), so registration order stops
  mattering. Correct, permanent, and a format-version bump. Registration-order
  ids remain readable through a compatibility table keyed on file version.
- **(b) Rewrite ids inside `_origBytes` on save** — walk the preserved payload,
  find nested `abstract(...)` ids, and remap them from the writing build's table
  to this build's. Requires the writing build's table to be *in the file*
  (it is not, today) and requires parsing bytes the whole design exists to avoid
  parsing.

**Recommend (a).** (b) makes every save depend on correctly walking data the
build does not understand, which is precisely the operation this plan is trying
to eliminate. (a) costs a version bump and a name→id table, and it makes the
format order-independent forever, which is a property `faber-leaf-core` needs
anyway (its addon set is different by construction).

Whichever is chosen: the file must record the table (or the scheme version) it
was written under, or neither option is verifiable.

### 4.4 Ownership of the migrations

The mesh addon currently owns file migrations that are not mesh-specific:
`addons/builtin/mesh/src/migrations.ts:33,46`,
`scripts/core/file_migrations.ts:60-62`, `scripts/core/appstate.ts:1010-1025`,
`appstate.ts:654-660`.

Split: host-owned format migrations move to `file_migrations.ts` and stay;
genuinely mesh-shaped ones are contributed through P7's
`registerFileMigrator` case and leave with the addon. Getting this wrong means
P13 deletes a migration every old file needs.

## 5. Fixtures

Three existing fixtures die with the mesh addon and must be rehomed **before**
P13:

- `tests/.../graph_missing_nodes.test.ts:8-13`
- `tests/.../scene-fixture.ts:14-19,22-47`
- `examples/error-test.wproj`

Watch `scripts/scene/scene.ts:354`'s serialized toolmode array: it will
contaminate every newly built fixture with whatever toolmodes the authoring
build had. Build fixtures with an explicit, minimal toolmode set.

**New fixtures must exercise concrete struct fields** (`struct(T)`,
`array(T)`), because §4.2 is the path with *no coverage at all*. A fixture built
only from `abstract(T)` fields would pass today and prove nothing.

Fixtures needed:

| Fixture | Exercises |
| --- | --- |
| curve + tet + hair data written by the full build | criteria 5–8 end to end (this is the headline test) |
| a block with a concrete `struct(T)` field of an unloaded class | §4.2 scalar path |
| a block with an `array(T)` of an unloaded class | §4.2 container path |
| a scene whose `SceneObject` references an unloaded geometry block by `DataRef` | criterion 6 |
| the same file re-saved by the partial build and re-opened by the full build | the whole invariant |

Generate them from the current build and **commit the bytes**. A fixture
regenerated by the build under test proves nothing.

## 6. Open decision #9 — the one-way format break

Answer both halves explicitly:

- **Is a one-way break acceptable?** Recommended: yes for the id-scheme change
  (§4.3 option (a)), which bumps the format version — old files read, new files
  do not open in old builds. That is normal and users accept it.
- **Does the app say so out loud?** Yes, and this is the part that gets skipped.
  A file written under the new scheme opened by an old build currently produces
  a decode failure that looks like corruption. Add a version guard the *old*
  build can honour — which means, in practice, shipping the guard **before** the
  break, and this plan must state which release does that. If that is not
  possible, the app must at minimum warn on save that the file will not open in
  older versions.

Record the decision, and the release it lands in, in P20's
`documentation/embedding.md` as well — external embedders pin versions.

## 7. Plan of record

1. **Sweep.** Grep for every `struct(T)` / `array(T)` / `iter(T)` declaration
   whose `T` is owned by an addon. That set is the blast radius of §4.2. Record
   it in this document.
2. Fix `vendor/nstructjs`: `StructStructField.pack` + the `do_pack` container
   recursion, with tests in nstructjs's own suite. Submodule commit + gitlink
   bump.
3. Fix the seven `lib_api` / `appstate` / `sceneobject` / `missing_addon`
   defects, with `lib_id` recovery as the acceptance criterion.
4. Build and commit the fixtures (§5).
5. Close open decision #3 and implement the chosen id scheme, with the version
   bump and the compatibility table.
6. Close open decision #9 and land the version guard / warning.
7. Split the file migrations (§4.4).
8. Rehome the three dying fixtures.

Steps 1–4 are the ones that must be complete before P13 is scheduled. Steps 5–6
must be complete before the *first release* that changes the addon set.

## 8. Tests

Four separate assertions, one per criterion — never one combined "round-trips"
test:

- **5**: bytes of the unknown block are byte-identical after load→save.
- **6**: `lib_id` and every inbound `DataRef` resolve after load→save→load.
- **7**: saving a file containing unknown data on **both** nstructjs struct
  paths (`struct(T)` and `array(T)`) does not throw.
- **8**: a file written with addon set A opens correctly under addon set B,
  where B adds *and* removes an addon relative to A.
- Plus the end-to-end: full build writes curve+tet+hair → partial build opens,
  edits something unrelated, saves → full build opens and the curve/tet/hair
  objects are live.
- And criterion 9's half: settings + startup file load in a build with a
  different addon set.

Run the nstructjs suite in CI (it is a workspace package; P1's `test` job should
already cover it — verify).

## 9. Risks

- **A silent id mis-decode passes every test we thought to write.** Mitigation:
  criterion 8's A/B addon-set test, and preferring the scheme (§4.3(a)) that
  makes the failure impossible rather than the one that makes it detectable.
- **The nstructjs change breaks other consumers of the submodule.** Mitigation:
  the fix is additive (consult a hook that is `undefined` by default), and it is
  tested in nstructjs's own suite.
- **Fixtures regenerate.** Mitigation: commit bytes; add a test that fails if a
  fixture file's hash changes.
- **Scope creep into a format redesign.** The invariant in §1 is the scope. A
  better file format is not this plan.
- **P13 gets scheduled before steps 1–4 land.** Mitigation: it is P13's stated
  dependency, and P13's exit criterion is "P10's round-trip test still green".

## 10. Exit criteria

- Criteria 5, 6, 7, 8 each pass as a separate, named test.
- A `.wproj` carrying curve, tet and hair data opens in a build without the
  owning addon, re-saves **byte-identically** with `lib_id`s and `DataRef`s
  intact, and re-opens in the full build as live objects.
- Saving never throws on either nstructjs struct path, scalar or container, and
  the fix lives in `vendor/nstructjs` with its own test.
- Open decisions #3 and #9 are recorded as settled in the strategy doc's §9.4
  table, with the chosen id scheme and the release that ships the version guard
  named here.
- The three dying fixtures are rehomed and the new concrete-struct-field
  fixtures are committed.
