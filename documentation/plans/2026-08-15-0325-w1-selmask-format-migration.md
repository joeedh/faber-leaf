# P6 — W1a: `SelMask` format migration

**Status:** plan — not started.

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

## 1. Goal

Sever the host's selection vocabulary from the BREP's element-type bits, and do
it in a way that does not silently change the meaning of already-saved files.

## 2. This is a file-format change, not a refactor

That framing is the whole plan. `SelMask` is a set of raw integers derived from
`MeshTypes`, and those integers are **persisted**:

| Where the bits are persisted | |
| --- | --- |
| `scripts/scene/scene.ts:350` | `ToolMode.selectMask` — serialized |
| `scripts/editors/view3d/view3d_toolmode.ts:549` | |
| `addons/builtin/mesh_edit/src/boxmodel.ts:31-43` | |
| keymap strings | `mesh_edit/src/mesheditor.ts:391,392`, `mesh_edit/src/meshtool.ts:67`, `addons/curvetest/curvaturetool.js:49`, `addons/subsurf_tester/subsurf_tangent_test.js:655-659` — all `selmask=17` or `selmask=1` |

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
HANDLE: MeshTypes.HANDLE,
```

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
'../../addons/builtin/mesh/src/mesh_base'`). 56 files reference `SelMask`;
the strategy counts 144 uses across 42 files for the constants overall.

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

- `ToolMode.selectMask` (`scene.ts:350`) and `view3d_toolmode.ts:549`.
- Bump `APP_VERSION` and add the reader migration: an old file's `int` is
  decoded against the frozen table in step 1; a bit with no name (the `1 << 10`
  case) round-trips as an opaque `'unknown:10'` token rather than being dropped.
- Writers only ever emit names.

Names are what make the format survive the addon set changing, which is the same
property P10 builds for everything else.

### Step 3 — make `OBJECT` an `&`-test

`OBJECT` is currently a fixed union of eight bits, so `mask === SelMask.OBJECT`
and `mask & SelMask.OBJECT` mean different things and only the second one
survives a new geometry type being registered. Sweep every comparison against
`OBJECT` and convert equality tests to `&`-tests. This is a small change and it
is the one that lets step 4 exist.

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
- Allocation must be **stable across runs** for a given addon set — derive it
  from the sorted registered name, not from load order, or a `.wproj` saved with
  addon A loaded and reopened with addons A+B changes meaning. Alternatively
  (and more robustly) do not persist object bits numerically at all, since step
  2 already persists names. Prefer that: numeric object bits then exist only
  in-memory and allocation order stops mattering.

If step 2 fully covers the persisted paths, say so explicitly here and drop the
stability requirement — but check `boxmodel.ts:31-43` before concluding it.

### Step 5 — move the constants and invert the dependency

- `git mv` the constants into `scripts/core/select_types.ts` (host-owned,
  `scripts/core/`, which the layer rules protect).
- `SelMask`'s geometry bits are now **defined** there as literals, not derived
  from `MeshTypes`.
- The mesh addon imports `SelMask` from the host through `@framework/api` and
  asserts at registration that `MeshTypes.VERTEX === SelMask.VERTEX` etc. — a
  cheap runtime check that catches drift while both exist.
- `scripts/editors/view3d/selectmode.ts` re-exports from the new module for one
  release so the 42 files are not all touched at once; then sweep and delete the
  re-export in the same plan (do not leave it — a re-export shim outlives its
  deadline by default).
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
  `scripts/core/`, `scripts/editors/` no longer import `MeshTypes`.
- A pre-migration `.wproj` opens with its selection mode intact, and an unnamed
  legacy bit round-trips.
- `SelMask`'s object half accepts a newly registered geometry type without a
  host edit — the mechanism P11 will use.
- The layer-violation count is below P1's baseline by the four named edges.
