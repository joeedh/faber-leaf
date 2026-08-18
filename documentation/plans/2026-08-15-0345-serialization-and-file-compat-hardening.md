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
> **Re-verified in full on 2026-08-18** as step 1 of §7. The `vendor/nstructjs`,
> `missing_addon.ts`, `sceneobject.ts`, `migrations.ts`, `file_migrations.ts` and
> `scene.ts` citations were all still exact; the `lib_api.ts` and `appstate.ts`
> ones had drifted by 2-3 lines and are corrected below. Findings that change the
> plan's own premises are in §4.1a and §4.2a.

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
| `scripts/core/lib_api.ts:1031`, `:1042`, `:1044-1046` | now `:1058`, `:1067-1080` |
| `scripts/core/lib_api.ts:615-617` | |
| `scripts/core/appstate.ts:808` | now `:745-749` |
| `scripts/sceneobject/sceneobject.ts:413-416` | now `:410-433` |
| `scripts/core/missing_addon.ts:34-44`, `:82-89`, `:262` | now `:34-43`, `:157-172`, `:222` |
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

### 4.1a The live defect, confirmed (measured 2026-08-18)

`MissingDataBlock.fromUnknownBlock` (`missing_addon.ts:82-89`) sets
`_origClsname`, `_origBytes`, `name` and `lib_type` — and **never `lib_id`**. The
block therefore reaches `BlockSet.push` with `lib_id === -1` and is handed a
fresh one (`lib_api.ts:615-617`), so every inbound `DataRef` dangles. Criterion
6's failure, reproduced exactly as §4.1 predicts it.

Three sites compound it:

- `Library.loadSTRUCT` (`lib_api.ts:1031-1046`) discards the **entire
  `BlockSet`** (`this.libs.remove(lib)`) when its `type` string matches no
  registered `BlockType`. Preserving blocks is pointless if the set that holds
  them is dropped first.
- `SceneObject.dataLink` (`sceneobject.ts:413-416`) replaces an unresolvable
  `data` reference with a `NullObject` and logs. It captures the original
  `lib_id` into a local and then drops it, so the association is destroyed in
  memory before the save that overwrites it on disk.
- `missing_customdata.ts:44` registers the placeholder from **module scope**,
  which the repo's addon rules forbid outright ("no module-scope
  `*.register(...)` side effects — they bypass the per-addon registry and can't
  be cleanly unregistered"). It belongs in the mesh addon's `register(api)` hook.
  This is the "addon-side mirror" the §4.1 table means.

Byte preservation itself is already working: `appstate.ts:347-356` re-emits
`_origClsname` + `_origBytes` verbatim rather than re-packing. Criterion 5 is
therefore much closer to passing than criterion 6, and the two must not share a
test.

**Resolved 2026-08-18.** All five sites are fixed:

- `missing_addon.ts` gained `recoverBlockHeader(istruct, bytes)` (`:92`), which
  decodes the payload's `DataBlock` prefix through a `BlockHeaderShell` whose
  `static structName = 'DataBlock'`. Reading it through the *per-file* manager
  means the fields come back under the schema the file was written with, not
  this build's. It sanity-checks `lib_id`/`name` and returns undefined rather
  than inventing an identity, so an older or truncated payload degrades to the
  old behaviour. `fromUnknownBlock` (`:157`) now applies the recovered
  `lib_id`/`lib_flag`/`lib_users`/`name`, and `BlockSet.push` preserves any
  `lib_id >= 0`.
- `Library.loadSTRUCT` (`lib_api.ts:1067-1080`) keeps a `BlockSet` whose type
  string matches no registered class, recording the original name in
  `_origTypeName` and re-typing the set to `MissingDataBlock`. `BlockSet.STRUCT`
  writes `savedTypeName()` (`:508`, `:527`) so the re-save does not rename the
  whole set to the placeholder's type.
- `DataRef.fromBlock` (`lib_api.ts:460`) reads the block's *instance*
  `lib_type` instead of its constructor's `blockDefine().typeName`. Identical
  for every ordinary block — the instance field is initialized from that static
  — but a placeholder now reports the type it stands in for.
- `SceneObject.dataLink` (`sceneobject.ts:410`) keeps the original id. It
  substitutes a `NullObject` only for the *drawable* role and copies
  `lib_id`/`lib_type`/`name` onto it, so `DataRef.fromBlock` re-emits the
  original reference on save. The stand-in is deliberately not a
  `MissingDataBlock`: making the placeholder a `SceneObjectData` would put
  `scripts/core/missing_addon.ts -> scripts/sceneobject/sceneobject_base.ts`
  into the big core/scene cycle, and the `no-circular` budget only moves down.
- `missing_customdata.ts` no longer registers from module scope; the mesh
  addon publishes `OpaqueCustomDataElem` from its `register(api)` hook and
  clears it in `unregister()` (`addons/builtin/mesh/src/main.ts`).

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

### 4.2a Sweep results (§7 step 1, measured 2026-08-18)

The blast radius is **seven declarations, every one of them inside the mesh
addon**, and every element type is mesh-internal:

| Site | Declaration |
| --- | --- |
| `addons/builtin/mesh/src/mesh.ts:323` | `_elists : array(mesh.ElementList)` |
| `addons/builtin/mesh/src/customdata.ts:640` | `_layers : array(mesh.LayerSet)` |
| `addons/builtin/mesh/src/mesh_types.ts:2442` | `__loops : iter(mesh.Loop)` |
| `addons/builtin/mesh/src/mesh_types.ts:2843` | `lists : array(mesh.LoopList)` |
| `addons/builtin/mesh/src/mesh_grids.ts:611` | `points : array(mesh.GridVert)` |
| `addons/builtin/mesh/src/mesh_grids_kdtree.ts:418` | `nodes : array(mesh_grid.CompressedKdNode)` |
| `addons/builtin/mesh/src/mesh_grids_quadtree.ts:322` | `nodes : array(mesh_grid.CompressedQuadNode)` |

The last two are invisible to the obvious sweep: their `STRUCT` is assembled at
runtime by `makeCompressedNodeStruct()`, so the struct name never appears as a
literal beside a `STRUCT =`. Any re-run of this sweep must scan references across
whole files, not only inside literal `STRUCT` bodies.

**§4.2's stated consequence is wrong, and is corrected here.** "A curve or tet
datablock throws on save in a build without its addon" does not happen. A
`DataBlock` is not written through a struct field at all: `appstate.ts:343-370`
writes the block list by hand, and a `MissingDataBlock` short-circuits to raw
bytes at `:347-356` without ever entering `do_pack`.

More generally the scalar concrete path is **unreachable today**, because every
field in the tree that can receive a placeholder is declared `abstract(...)`:

| Field | Placeholder it can receive |
| --- | --- |
| `scripts/scene/scene.ts:354` — `toolmodes : array(abstract(ToolMode))` | `MissingToolMode` |
| `scripts/core/graph.ts:1340` — `nodes : iter(abstract(graph.Node))` | `MissingNode` |
| `scripts/core/graph.ts` — `graph.KeyValPair.val : abstract(Object)` | `MissingNodeSocket` (sockets ride inside `KeyValPair`) |
| `scripts/graph/node_group.js:13-14` — `abstract(graph.NodeSocketType)` | `MissingNodeSocket` |
| six `array(abstract(mesh.CustomDataElem \| mesh.CustomDataLayer))` sites | `OpaqueCustomDataElem` |

So §4.2 is a **latent** trap rather than a live one: it fires the first time
anyone declares a concrete `struct(T)` / `array(T)` over a type another addon can
subclass — which P12's LeafMesh and P17's sculptcore-less build both make likely.
Fix it anyway, because the cost is small and the failure is silent, but schedule
it behind §4.1a, which *is* live.

Two corrections to §4.2's budget:

- **The containers need no separate fix.** There are five recursion sites, not
  one — `StructArrayField:1142`, `StructIterField:1398`, `StructIterKeysField:1759`,
  `StructStaticArrayField:2042`, `StructOptionalField:2191` — and all five call
  `do_pack`, which dispatches on the *element* type descriptor
  (`struct_intern2.ts:348-379`). A single fix in `StructStructField.pack:735`
  covers every container form. What the containers need is **test coverage**, not
  code.
- The scalar hook to copy is `StructTStructField.pack:854-855`, verified still
  exact.

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

### 4.3a Decision (closed 2026-08-18): option (a), with two corrections

**Chosen: (a), name-derived ids.** `stableStructId(name)` in
`vendor/nstructjs/src/struct_intern.ts` is an FNV-1a of the struct name folded
into `[0x100000, 0x7fffffff)`, and `STRUCT.assignStructId` uses it for every
registration. It is on by default, so a `STRUCT` has to opt *out* to get
registration-order ids back — the failure mode is silent, so the safe scheme is
the one you get without asking. `STRUCT.stableIdOverrides` pins a name to an id
for the one case the scheme cannot resolve by itself (see below).

Two things §4.3 got wrong, both found by reading the format rather than the
code that writes it:

1. **This is not a read break, and it needs no compatibility table.** Every
   `.wproj` embeds its own schema (`write_scripts()`, `appstate.ts:306`), and
   the reader parses it into a *per-file* `STRUCT` (`appstate.ts:677-682`) —
   ids in the stream have always been resolved against the file's own table, not
   the reader's. So an old file opens under the new scheme and a new file opens
   under the old one, with no table and no migration. The compatibility table
   §4.3 asked for is the schema block, and it was already there.

2. **The break is narrower, and it is on the write side.** What actually depends
   on two builds agreeing is `MissingDataBlock._origBytes`: bytes captured from
   one file and spliced verbatim into another (`appstate.ts:345-356`). Their
   nested `abstract(...)` ids belong to the *writing* file's table, and the
   file they are spliced into declares the *saving* build's. Pinning ids makes
   those two tables agree by construction — which is the whole fix, and it only
   works for files written under the new scheme.

**The residue.** A pre-v9 file whose blocks are preserved and re-saved by a
partial build produces exactly the corruption §4.3 describes, and nothing can
repair it without parsing the preserved bytes — option (b), rejected. So
`MissingDataBlock._legacyStructIds` records where the bytes came from (set from
the file version at load, persisted), and the save path warns by name. This is
the honest scope: an old file always opens; only *round-tripping the parts an
old build could not understand* is lost. `tests/integration/file_compat.test.ts`
pins both halves against `curve-addon-scene-v8.wproj`.

**Collisions.** With a 31-bit space, a collision needs two struct names to hash
alike; `assignStructId` throws naming both, at registration, rather than letting
two structs share an id. The fix is a `stableIdOverrides` entry, not a rename —
renaming a struct breaks every file that contains it.

**Format version.** `APP_VERSION` 8 → 9, and `STABLE_STRUCT_ID_VERSION = 9` in
`scripts/core/const.ts` names what the bump means so the load path can ask.

| file version | struct ids | opens in a v9 build | opens in a v8 build |
| ------------ | ---------- | ------------------- | ------------------- |
| ≤ 8 | registration order | yes | yes |
| ≥ 9 | name-derived | yes | yes (schema is in the file) |

The last cell is why decision #9 (§6) gets a narrower answer than it expected:
this change is not the one-way break, so the guard it asks for is not owed by
*this* step. Step 6 still owes it for the breaks that are one-way.

**Editing warning for nstructjs.** Everything between `//$KEYWORD_CONFIG_START`
and `//$KEYWORD_CONFIG_END` in `struct_intern.ts` is spliced into a template
literal by `tools/rollup_configurable.config.js`, so a backtick anywhere in that
range — comments included — breaks `build/nstructjs_configurable.js` only, while
the other six bundles build fine. There is a comment on the marker now.

### 4.4 Ownership of the migrations

The mesh addon currently owns file migrations that are not mesh-specific:
`addons/builtin/mesh/src/migrations.ts:33,46`,
`scripts/core/file_migrations.ts:60-62`, `scripts/core/appstate.ts:1013-1028`,
`appstate.ts:657-664`.

Split: host-owned format migrations move to `file_migrations.ts` and stay;
genuinely mesh-shaped ones are contributed through P7's
`registerFileMigrator` case and leave with the addon. Getting this wrong means
P13 deletes a migration every old file needs.

## 5. Fixtures

Three existing fixtures die with the mesh addon and must be rehomed **before**
P13:

- `tests/integration/graph_missing_nodes.test.ts:8-13`
- `tests/lib/scene-fixture.ts:14-19,22-47`
- `examples/error-test.wproj`

Two things the 2026-08-15 snapshot did not record, both found in step 1:

- **`scene-fixture.ts` is a scaffold, not a fixture.** `makeHeadlessAppState`,
  `saveSceneToBytes` and `loadSceneFromBytes` all throw `NotImplementedError`.
  So step 4 is not "rehome a fixture", it is "build the harness every fixture in
  the §5 table needs". Budget for that explicitly. Its header also cites a plan
  by an absolute path from another machine
  (`/root/.claude/plans/we-will-be-working-peppy-wreath.md`) — repoint it at this
  document while rewriting.
- **The jsdom/swc unit harness cannot import the real modules.**
  `graph_missing_nodes.test.ts:8-13` says so directly: `graph.ts` and
  `missing_addon.ts` transitively pull in path.ux, which the transform can't
  handle, so that test drives `vendor/nstructjs` directly with stand-in classes
  instead. P10's round-trip tests therefore belong in the **NW.js integration**
  workspace, not `tests/unit/` — or they will quietly test stand-ins rather than
  the shipping code.

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

### 5a. What step 4 actually built, and four corrections (2026-08-18)

Delivered:

| Artifact | |
| --- | --- |
| `tests/integration/fixtures/curve-addon-scene.wproj` | the committed fixture — a curve DataBlock + a `SceneObject` referencing it, written under addon set A |
| `tests/integration/fixtures/curve-addon-scene.json` | what the authoring build recorded: `lib_id`s, names, vert/edge counts. The test asserts against these, not against re-derived values |
| `tools/gen-file-compat-fixtures.mjs` | the one-shot generator. Run by hand; never by a test |
| `tests/integration/file_compat.test.ts` | two headless boots, criteria 5/6/7/8 as four separate assertions |

**Correction 1 — "curve + tet + hair" is really just curve.** `TetMesh` and
`strands` are *core* DataBlocks (`scripts/tet/tetgen.js:94`,
`scripts/hair/strand.js:131`); only their toolmodes are addon-owned. `curve`
(`addons/builtin/curve/src/curve.ts:332`) is the sole geometry block type in the
tree an addon owns, so it is the only one that can go missing. It also ships
`defaultEnabled: false`, which supplies the asymmetry for free: the generator
turns it on, the default build reading the file back does not have it. The
tetmesh addon still earns its place — enabling it in the third boot is the
"addon set B *adds* an addon" half of criterion 8.

**Correction 2 — the §5 struct-path rows are already covered, in the right
place.** Per §4.2a the concrete `struct(T)` / `array(T)` path is unreachable
from a `.wproj` today, so a fixture for it would have to be synthetic. Step 2
already put that coverage where it belongs and where the next submodule update
cannot lose it: `vendor/nstructjs/tests/unknown_struct_field.test.ts`, scalar
and container both. Nothing further is owed for those two rows.

**Correction 3 — the harness is a generator, not `tests/lib/scene-fixture.ts`.**
§5 itself establishes that the jsdom unit workspace cannot import the real
modules, so a fixture harness living there would test stand-ins. The generator
drives the shipping app through the NW.js test harness instead, and the
assertions live in the integration workspace. `scene-fixture.ts` is therefore
step 8's problem (delete or repoint), not step 4's.

**Correction 4 — two latent crashes the fixture found, both fixed here.**

- `Node.inherit()` no longer exists on `scripts/core/graph.ts` (socket
  inheritance became unconditional — see the `getsocks` walk at `:616-650`), but
  `scripts/nullobject/nullobject.js:54` and `scripts/tet/tetgen.js:86` still
  called it. `new NullObject()` and `new TetMesh()` therefore *always* threw.
  That made §4.1a's `SceneObject.dataLink` stub — which builds a `NullObject` —
  dead on arrival, so this is on P10's critical path, not adjacent to it.
- `createFile({save_screen: false})` writes a file `loadFile_loadScreen` throws
  on. Not fixed here (out of scope), but recorded: it is why the fixture is
  written with the screen, and it is a real one-way asymmetry between the two
  halves of the format.

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

### 6a. Decision (closed 2026-08-18): there is no one-way break, and the guard ships anyway

**Is a one-way break acceptable?** The question turns out to be moot for the
change that prompted it. §4.3a established that the id-scheme change is *not*
one-way: a `.wproj` embeds its own struct schema and both `FileHelper.read` and
`loadFile_start` build a per-file `STRUCT` from it, so a v9 file opens in a v8
build and a v8 file opens in a v9 build. Nothing in P10 breaks reading in either
direction, so nothing here is owed a "you must upgrade" story.

That leaves the second half — **does the app say so out loud?** — which is worth
answering on its own terms, because the *reason* §6 asks for the guard before
the break is that a guard is useless the day you need it. Shipped in
**APP_VERSION 9** (this plan's release), before any break exists:

- `BREAKING_FILE_VERSIONS` in `scripts/core/const.ts` — empty today, and
  expected to stay that way. Most version bumps do not belong in it, precisely
  because the schema travels inside the file. A version goes in only when that
  stops being true: the header layout changes, or a block type stops being
  self-describing.
- `isBreakingFileVersion(version, breaking?, reads?)` beside it — the
  classification, with the list injectable so it is testable without a real
  break to point at (`tests/unit/file_version_guard.test.ts`).
- `AppState.checkFileVersion`, called from `loadFile_start` immediately after
  the header's `uint16` version and before anything is decoded. A newer
  *non*-breaking file logs and shows a notification and then loads normally; a
  newer file across a declared break throws `FileLoadError` naming both versions
  instead of failing somewhere downstream as a corrupt read. The notification is
  wrapped in a `try` because the startup file loads before the screen exists.

The save-side fallback §6 offers ("at minimum warn on save that the file will
not open in older versions") is deliberately **not** implemented. It is the
consolation prize for shipping a break without a guard, and warning on every
save about a break that does not exist would be noise. The one real
cross-version residue P10 does introduce — pre-v9 unknown-block bytes spliced
into a v9 file — already warns at exactly the moment it applies, on the block
that has it (§4.3a).

What a future break owes, then: add its version to `BREAKING_FILE_VERSIONS`,
and note that every build from v9 onward will refuse it by name. That is the
guarantee this step buys.

`documentation/embedding.md` does not exist yet (P20); when it does, it should
carry the table in §4.3a plus the sentence that v9 is the first release with a
forward-version guard.

## 7. Plan of record

1. ~~**Sweep.** Grep for every `struct(T)` / `array(T)` / `iter(T)` declaration
   whose `T` is owned by an addon. That set is the blast radius of §4.2. Record
   it in this document.~~ **Done 2026-08-18 — see §4.2a**, which also corrects
   §4.2's premise and re-prioritises the work behind §4.1a.
2. ~~Fix `vendor/nstructjs`: `StructStructField.pack` + the `do_pack` container
   recursion, with tests in nstructjs's own suite. Submodule commit + gitlink
   bump.~~ **Done 2026-08-18** — submodule `8b50385`, gitlink `1966699d`. One
   fix in `StructStructField.pack` covers every container form, because all five
   container handlers funnel through `do_pack`.
3. ~~Fix the seven `lib_api` / `appstate` / `sceneobject` / `missing_addon`
   defects, with `lib_id` recovery as the acceptance criterion.~~
   **Done 2026-08-18 — see the resolution note in §4.1a.** Criteria 5 and 6 are
   now believed to hold; step 4's fixtures are what will prove it.
4. ~~Build and commit the fixtures (§5).~~ **Done 2026-08-18 — see §5a.**
   `tests/integration/fixtures/curve-addon-scene.wproj` (committed bytes),
   `tools/gen-file-compat-fixtures.mjs` (the one-shot generator), and
   `tests/integration/file_compat.test.ts` (criteria 5, 6, 7 and 8, asserted
   separately). All four criteria pass.
5. ~~Close open decision #3 and implement the chosen id scheme, with the version
   bump and the compatibility table.~~ **Done 2026-08-18 — see §4.3a.** Option
   (a): `stableStructId` in nstructjs (on by default), `APP_VERSION` 8 → 9, and
   the legacy-file residue recorded on the placeholder and warned about on save.
   No compatibility table is needed — the schema block already is one.
6. ~~Close open decision #9 and land the version guard / warning.~~
   **Done 2026-08-18 — see §6a.** There is no one-way break to warn about; the
   forward-version guard (`BREAKING_FILE_VERSIONS` +
   `AppState.checkFileVersion`) ships in v9 anyway, so a future break can be
   refused by name rather than surfacing as corruption.
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

~~Run the nstructjs suite in CI (it is a workspace package; P1's `test` job
should already cover it — verify).~~ **Verified 2026-08-18.** `vendor/nstructjs`
is listed in `pnpm-workspace.yaml` and its `test` script (`vitest run`) is one
of the tasks `turbo test` runs, so `unknown_struct_field.test.ts` is gated.

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
