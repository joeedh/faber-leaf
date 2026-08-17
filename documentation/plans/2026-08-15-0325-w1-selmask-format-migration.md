# P6 — W1a: `SelMask` format migration

**Status:** done (2026-08-16). Citations re-verified 2026-08-16 (see §0); the
per-step notes below record where the implementation departed from the draft.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W1 step 1, §5 phase 4, §9.3 P6.

**Workstream / phase:** W1 / phase 4.

**Depends on:** P1. **Blocks:** P7 (and therefore the rest of W1).

**Authoring effort:** high.

**Closes:** contributes to success criterion 9.

> Line references spot-checked on 2026-08-15 against the working tree; re-verify
> before editing.

---

## 0. Citation re-verification (2026-08-16, post-P5)

Every file:line in this document re-measured against the tree. Most held. The
corrections, and the things the 2026-08-15 draft did not know:

1. **`boxmodel.ts` is not in the mesh_edit addon.** It lives at
   `scripts/editors/view3d/tools/boxmodel.ts` — a *host* file — and its
   persisted field is `boxModelSelMode : int` at **line 35**, inside an
   `inlineRegister` STRUCT, not lines 31–43 of an addon file. This matters
   because §5 step 4 defers a decision to "check `boxmodel.ts:31-43`": the
   answer is that `boxModelSelMode` is a *geometry-half* mask
   (`SelMask.VERTEX` by default, only ever tested against `VERTEX`/`EDGE`/
   `FACE`), so it never carries an object bit and step 4's stability
   requirement does not apply to it.

2. **`ToolMode`'s persisted field is `storedSelectMask`, not `selectMask`.**
   `view3d_toolmode.ts:549` is exactly right, but the field on that line is
   `storedSelectMask : int`. `ToolMode.selectMask` (line 62) is *not*
   serialized — it is recomputed from `toolModeDefine().selectMode` at line 84.
   So there are three persisted sites, not two: `Scene.selectMask`
   (`scene.ts:350`), `ToolMode.storedSelectMask`, and
   `BoxModelToolMode.boxModelSelMode`.

3. **Step 2's mechanism already exists two lines above the field it targets.**
   `Scene.STRUCT`'s `toolmode_i` is written as
   `string | obj.constructor.toolModeProp.keys[obj.toolmode_i]` and resolved
   back in `Scene.loadSTRUCT` (`scene.ts:831`), including the
   unknown-name-falls-back-to-0 case. That is the name-persistence pattern this
   plan wants, already in the same STRUCT. Follow it rather than inventing one.

4. **Step 3 is one line, not a sweep.** Exactly one equality comparison against
   `SelMask.OBJECT` exists in the tree: `scripts/sceneobject/sceneobject_ops.js:108`
   (`if (selmask == SelMask.OBJECT)`). Every other use is already an `&`-test.

5. **`SelMask` has two members the draft did not list:** `GEOM` and `SGEOM`,
   both `VERTEX | EDGE | FACE` (7) and both derived from `MeshTypes`. They are
   duplicates of each other. `GEOM` is the default value of the `selmask`
   `FlagProperty` on the transform ops (`transform_ops.ts:183`), so it is
   load-bearing; neither may change value.

6. **Scale, re-counted:** 55 files reference `SelMask` (186 uses); 34 files
   import from `selectmode.ts`. The draft's "56 files" was measured pre-P5.

7. **Ten files under `scripts/` import `MeshTypes`, not four.** The four this
   plan names (`selectmode.ts:1`, `transform_types.ts:4`, `PropsEditor.ts:32`,
   `lite-mesh/litemesh_base.ts:1`) are the ones that import it *for selection
   vocabulary*, which is P6's business. The other six are not:
   - `scripts/editors/image/pending-port/{uv_ops,uv_selectops,uv_transformops}.js`
     — excluded from the build by `tsconfig.json:40` and imported by nothing.
     P18/P19 (the UV editor rewrite) own these.
   - `transform_inset.ts:5`, `transform_ops.ts:40`, `view3d_draw.ts:2` — these
     walk an actual `Mesh` (`MeshFlags`, element iteration). They are BREP
     consumers, and P13 deletes them along with the BREP.

   §8's exit criterion is therefore overstated and is corrected there.

8. **Confirmed exactly as written:** `selectmode.ts:1` and `:54`,
   `scene.ts:350`, `transform_types.ts:4-5`, `PropsEditor.ts:2,32`,
   `litemesh_base.ts:1-2`, `selecttool.ts:67-68`, and all nine `selmask=`
   keymap literals (`mesheditor.ts:391,392`, `meshtool.ts:67`,
   `curvaturetool.js:49`, `subsurf_tangent_test.js:655-659`).

---

## 1. Goal

Sever the host's selection vocabulary from the BREP's element-type bits, and do
it in a way that does not silently change the meaning of already-saved files.

## 2. This is a file-format change, not a refactor

That framing is the whole plan. `SelMask` is a set of raw integers derived from
`MeshTypes`, and those integers are **persisted**:

| Where the bits are persisted | Field | Half |
| --- | --- | --- |
| `scripts/scene/scene.ts:350` | `Scene.selectMask : int` (defaults to `OBJECT`) | object |
| `scripts/editors/view3d/view3d_toolmode.ts:549` | `ToolMode.storedSelectMask : int` | either |
| `scripts/editors/view3d/tools/boxmodel.ts:35` | `BoxModelToolMode.boxModelSelMode : int` | geometry |
| keymap strings | `mesh_edit/src/mesheditor.ts:391,392`, `mesh_edit/src/meshtool.ts:67`, `addons/curvetest/curvaturetool.js:49`, `addons/subsurf_tester/subsurf_tangent_test.js:655-659` — all `selmask=17` or `selmask=1` | geometry |

Move a bit and every one of those changes meaning. `selmask=17` is
`VERTEX | HANDLE`; nothing in the string says so.

**One encouraging fact:** `scripts/editors/view3d/tools/selecttool.ts:67-68`
already writes `view3d.translate(selmask='OBJECT')`. The enum-property parser
already accepts names — the name form is not new machinery, it is an existing
form that only some call sites use.

## 3. Current state

`scripts/editors/view3d/selectmode.ts:1`:

```ts
import {MeshTypes} from '../../../addons/builtin/mesh/src/mesh_base.js'
```

A **host** file, four directories deep in `scripts/editors/`, importing values
from the addon the refactor deletes. `SelMask`'s geometry half is literally
`MeshTypes`:

```ts
VERTEX: MeshTypes.VERTEX,   // 1
EDGE  : MeshTypes.EDGE,     // 2
FACE  : MeshTypes.FACE,     // 4
//8 is MeshTypes.LOOP,
HANDLE: MeshTypes.HANDLE,   // 16
GEOM  : MeshTypes.VERTEX | MeshTypes.EDGE | MeshTypes.FACE,   // 7
SGEOM : MeshTypes.VERTEX | MeshTypes.EDGE | MeshTypes.FACE,   // 7, a duplicate of GEOM
```

`GEOM` is the default of the transform ops' `selmask` `FlagProperty`
(`transform_ops.ts:183`), so it is load-bearing. `SGEOM` is byte-identical to it
and has no distinct meaning; leave both in place rather than deleting one, since
a `FlagProperty`'s key set is what parses `selmask='…'` strings.

The object half is a **hardcoded enumeration of concrete geometry types** in
host code:

```ts
MESH: 1 << 8, LIGHT: 1 << 9, CAMERA: 1 << 11, NULLOBJECT: 1 << 12,
PROCMESH: 1 << 13, TETMESH: 1 << 14, STRANDS: 1 << 15,
OBJECT: (1 << 8) | (1 << 9) | (1 << 10) | … | (1 << 15)
```

Two things to notice, because they shape the plan:

- `1 << 10` is in `OBJECT` but has **no name** — a retired type. Any scheme that
  round-trips through names must not lose it.
- The object bits are per-`SceneObjectData`-type. **LeafMesh will need one**,
  and so will any third-party geometry type (success criterion 12). A
  fixed 8-bit hardcoded list in a host file cannot deliver that. So this plan is
  not only about decoupling from `MeshTypes`; the object half has to become
  *registry-allocated*.

Other coupled sites: `scripts/editors/view3d/transform/transform_types.ts:4-5`,
`scripts/editors/properties/PropsEditor.ts:2,32`,
`scripts/lite-mesh/litemesh_base.ts:1` (`import {MeshTypes} from
'../../addons/builtin/mesh/src/mesh_base'`). 55 files reference `SelMask` (186
uses); 34 import it from `selectmode.ts`. Six further `scripts/` files import
`MeshTypes` for reasons that are **not** P6's — see §0.7.

`window._SelMask = SelMask` at `selectmode.ts:54` is a global; P20 gates it. Do
not delete it here.

## 4. Non-goals

- Redesigning selection. The semantics stay identical.
- Removing `window._SelMask` (P20).
- Registering LeafMesh's object bit (P11) — this plan only makes it *possible*.

## 5. Plan

### Step 1 — freeze the wire format, in writing

Before any code moves, write the bit layout into
`scripts/core/select_types.ts`'s header as a permanent contract:

```
1  VERTEX     8  LOOP (reserved, never reused)
2  EDGE      16  HANDLE
4  FACE
```

Bits 1/2/4/8/16 are **reserved forever** with those meanings, whether or not a
BREP exists to use them. That is what keeps `selmask=17` meaning
`VERTEX | HANDLE` after the mesh addon is gone. Reserving a bit costs nothing;
recovering from having reused one costs a file-format migration.

Bit 8 stays reserved even though LeafMesh has a LOOP domain of its own — the
domain is a *LeafMesh* concept, and if LeafMesh wants a loop selection mode it
takes bit 8, which is the meaning it already had.

### Step 2 — persist selection modes as names

Change the serialized representation from `int` to `string[]` (or a
space-delimited string, whichever nstructjs handles more cheaply for a flag
enum):

- The three fields in §2's table: `Scene.selectMask`,
  `ToolMode.storedSelectMask`, `BoxModelToolMode.boxModelSelMode`.
- Bump `APP_VERSION` and decode an old file's `int` against the frozen table in
  step 1; a bit with no name (the `1 << 10` case) round-trips as an opaque
  `'unknown:10'` token rather than being dropped.
- Writers only ever emit names.

**Follow the `toolmode_i` precedent** (§0.3), which sits two lines below
`selectMask` in the same STRUCT: write the name through a STRUCT expression
(`string | <expr>`) and resolve it in `loadSTRUCT`. Because nstructjs embeds the
schema in the file and reads each field per the *file's* schema, an old file's
`int` arrives as a number in the same property — so `loadSTRUCT` sees either a
number (old) or a string (new) and normalizes. That is the whole migration; no
`registerFileMigrator` entry is needed, and none should be added, since the
migration registry operates on the datalib after the read and cannot see a
per-field type change.

Names are what make the format survive the addon set changing, which is the same
property P10 builds for everything else.

### Step 3 — make `OBJECT` an `&`-test

`OBJECT` is currently a fixed union of eight bits, so `mask === SelMask.OBJECT`
and `mask & SelMask.OBJECT` mean different things and only the second one
survives a new geometry type being registered. Sweep every comparison against
`OBJECT` and convert equality tests to `&`-tests. This is a small change and it
is the one that lets step 4 exist.

Measured: **one** such comparison exists —
`scripts/sceneobject/sceneobject_ops.js:108`. Everything else already `&`-tests.

**Done, but not as a plain `&`-test.** `getStdTools` uses `ctx.selectMask` to
decide *which type's* tools to hand back, and a scene's mask can legitimately
name exactly one object type — `addons/builtin/tetmesh/src/tetmesh.ts:60` sets
`selectMode: SelMask.TETMESH`, which must fall through to the tetmesh entry in
`ObjectDataTypes`, not to `ObjectTools`. A bare `selmask & SelMask.OBJECT` would
have swallowed that case and broken per-type tool routing. The landed form is a
popcount test — whole-object mode is any mask naming *more than one* object
type:

```js
let objbits = selmask & SelMask.OBJECT
if (objbits && (objbits & (objbits - 1)) !== 0) {
  return ObjectTools
}
```

That is equality-free, so it survives new types registering, and it keeps the
single-bit behaviour the old `=== SelMask.OBJECT` had by accident. A grep guard
in `tests/unit/select_types.test.ts` (§6) keeps the equality form from returning.

### Step 4 — registry-allocate the object bits

`SelMask`'s object half becomes a small registry in `select_types.ts`:

- The retired/known names keep their current bits, hardcoded, forever
  (`MESH: 1 << 8` … `STRANDS: 1 << 15`, plus `1 << 10` reserved-unnamed). Do not
  renumber — those values are on disk.
- New types allocate from bit 16 upward through
  `registerSelectType(name): number`, called from a `SceneObjectData`
  registration (the natural home is P7's `AddonAPI` extension, so keep the
  function signature trivially wrappable).
- `OBJECT` becomes a derived value: the OR of every registered object bit,
  recomputed on registration. With step 3 done, nothing compares against it by
  equality, so it can move.
- ~~Allocation must be **stable across runs** for a given addon set~~
  **Requirement dropped.** Step 2 covers *every* persisted path: the three
  fields of §2's table are the complete set (`boxmodel.ts:31-43` re-read — its
  `boxModelSelMode` is one of them, and its `storedSelectMask` comes from
  `ToolMode.STRUCT`), and all three now write names. Keymap literals are the
  only other place a mask is spelled out, and step 6 converts those to names
  too. So numeric object bits exist **in-memory only**, allocation order cannot
  reach a file, and no sorted-name derivation is needed. The unit test
  `a registry-allocated bit persists by name` pins this: it registers a type,
  resets the registry, re-registers it behind a different type so it gets a
  *different* bit, and asserts the persisted name still resolves.

The bit is claimed through an optional `selectTypeName` on `dataDefine()`;
`SceneObjectData.register` calls `registerSelectType(name)` and throws if the
type also declares a `selectMask` that disagrees. The six builtin types declare
the name they already hold, so registration re-asserts their frozen bits rather
than allocating. `registerSelectType` is idempotent, so several types may share
a name/bit (the curve and mesh addons reuse `MESH` / `PROCMESH`).

### Step 5 — move the constants and invert the dependency

- `git mv` the constants into `scripts/core/select_types.ts` (host-owned,
  `scripts/core/`, which the layer rules protect).
- `SelMask`'s geometry bits are now **defined** there as literals, not derived
  from `MeshTypes`.
- The mesh addon imports `SelMask` from the host through `@framework/api` and
  asserts at registration that `MeshTypes.VERTEX === SelMask.VERTEX` etc. — a
  cheap runtime check that catches drift while both exist.
- ~~`scripts/editors/view3d/selectmode.ts` re-exports from the new module for
  one release so the 42 files are not all touched at once; then sweep and delete
  the re-export in the same plan.~~ **No shim.** The plan already required
  deleting it before landing, so the shim only adds an intermediate state; and
  the real number is 34 importers of a two-symbol module, which is a mechanical
  sweep. `selectmode.ts` is `git mv`'d whole to `scripts/core/select_types.ts`
  (it is nothing *but* these constants) and the 34 imports are re-pointed in the
  same commit.
- Fix the four named sites: `selectmode.ts:1`, `transform_types.ts:4-5`,
  `PropsEditor.ts:2,32`, `lite-mesh/litemesh_base.ts:1`. Note the last one also
  imports `AttrType` from `@sculptcore/api` on line 2 — that is P15's problem,
  leave it.

### Step 6 — keymap strings

Convert every `selmask=17` / `selmask=1` literal to the name form
(`selmask='VERTEX|HANDLE'`), matching `selecttool.ts:67`'s existing style. This
covers the two `addons/` non-builtin addons (`curvetest`, `subsurf_tester`) as
well — they are in-tree and they will break otherwise.

The numeric form must keep parsing, because third-party addons and user keymaps
outside the tree use it. Decode it against the frozen table.

**Nine literals converted** (`mesheditor.ts:391-392`, `meshtool.ts:67`,
`curvaturetool.js:49`, `subsurf_tangent_test.js:655-659`). This needed an
upstream fix: a keymap argument reaches `FlagProperty.parseArg`, and the
inherited `EnumPropertyBase.parseArg` (`toolprop.ts:1532`) resolves a *single*
key name only — `'VERTEX|HANDLE'` threw. `FlagProperty` now overrides
`parseArg` to split on `|` and OR the bits, in the path.ux submodule on branch
`faber-leaf-refactor` (committed with this phase, gitlink bumped in the same
commit). The alternative — inventing union names in `SelMask` to dodge the
parser — would have put presentation concerns into the frozen wire format.

## 6. Tests

- **Format**: a `.wproj` saved by the current build opens with its selection
  mode *and* its toolmode `selectMask` intact. This is the criterion; build the
  fixture from the current build before starting.
- **Format, reverse**: an unnamed bit (`1 << 10`) in an old file survives a
  load/save round-trip.
- **Unit**: `SelMask.OBJECT` includes a newly registered type's bit; an
  `&`-test against `OBJECT` matches that type; no equality test remains
  (a grep-based test is acceptable here and is worth having).
- **Keymap**: both `selmask=17` and `selmask='VERTEX|HANDLE'` parse to the same
  mask.
- `pnpm check:layers`: the `core-no-mesh` / `core-no-addons` counts drop by the
  `selectmode.ts` / `transform_types.ts` / `PropsEditor.ts` edges. Record the
  delta against P1's baseline in the commit message.
- `grep -rn "addons/builtin/mesh" scripts/lite-mesh/` returns nothing.

**Results.** `tests/unit/select_types.test.ts` — 22 tests over the frozen bits,
the name round-trip (including `unknown:10`), `normalizeSelMask`, keymap
parsing, the registry, and the `SelMask.OBJECT` equality grep guard: all pass.
Both format criteria were measured headlessly against the real app rather than
asserted (`nw … --apptest-headless --eval`): an existing APP_VERSION-7 `.wproj`
opens with `selectMask 65280` and re-saves/reloads identically, with names in
the raw bytes; a synthetic scene round-trips `selectMask 1280`
(`MESH | 1 << 10`, so the retired unnamed bit survives), `boxModelSelMode 6`
and `storedSelectMask 17`. `check:layers` moved `core-no-addons` 25 → 24 and
`no-circular` 713 → 673 (baseline lowered in `tools/layer-baseline.json`);
`core-no-mesh` is unchanged at 2 — the remaining two edges are P13's BREP
consumers, not selection vocabulary. The `lite-mesh` grep returns only two
prose mentions in comments, no imports.

## 7. Risks

- **A missed persisted site silently changes meaning.** The failure mode is a
  user's box-modeling toolmode opening in the wrong selection mode — annoying,
  hard to attribute, and not caught by any compile. Mitigation: step 1 freezes
  the layout so *no* bit changes value at all; the migration is additive.
- **Registry allocation reorders bits between builds.** Mitigation: step 4's
  preferred branch — never persist object bits numerically.
- **The re-export shim becomes permanent.** Mitigation: it is deleted inside
  this plan, not scheduled for later.
- **56 files touched.** Mostly mechanical import rewrites. Land the move as one
  commit and the semantic changes (steps 2–4) as separate ones, so a bisect can
  tell them apart.

## 8. Exit criteria

- `grep -rn "addons/builtin/mesh" scripts/lite-mesh/` returns nothing, and
  ~~`scripts/core/`, `scripts/editors/` no longer import `MeshTypes`~~ **no host
  file imports `MeshTypes` for *selection vocabulary*.** Six files keep the
  import for reasons outside this plan (§0.7): three are build-excluded and
  belong to P18/P19, three are BREP consumers and go with P13. Writing the
  criterion the original way would force P6 to do P13's job.
- A pre-migration `.wproj` opens with its selection mode intact, and an unnamed
  legacy bit round-trips.
- `SelMask`'s object half accepts a newly registered geometry type without a
  host edit — the mechanism P11 will use.
- The layer-violation count is below P1's baseline by the four named edges.
  Measured: `core-no-addons` −1 and `no-circular` −40 (2318 → 2277 total). The
  circular drop is larger than "four edges" because the ~30 modules that only
  wanted `SelMask` no longer import a view3d editor module at all.
