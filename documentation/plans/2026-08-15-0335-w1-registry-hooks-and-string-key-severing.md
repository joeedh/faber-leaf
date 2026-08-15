# P8 — W1c: registry hooks + string-key severing

**Status:** plan — not started.

**Date:** 2026-08-15

**Strategy:** [Faber Leaf refactor strategy](./2026-08-15-0237-faber-leaf-refactor-strategy.md)
§4 W1 steps 0 and 2, §5 phase 5, §9.3 P8.

**Workstream / phase:** W1 / phase 5.

**Depends on:** P7 (the contract and the `AddonAPI` cases must exist to register
*into*). **Blocks:** P9, P10, P11, P18.

**Authoring effort:** high — won by enumeration, not by reasoning.

**Closes:** the *sever* half of success criterion 2.

> Line references spot-checked on 2026-08-15. Re-verify before editing.

---

## 1. Goal

Make the host boot, and stay booted, with the mesh addon absent — by converting
every host→BREP edge into either a registry lookup or nothing at all.

After this plan the BREP is still in the tree. Nothing in `scripts/` requires it.
P13 then deletes a leaf.

## 2. Step 0 comes first: the invisible edges

Classes E (inheritance), F (string-keyed) and G (serialization) are invisible to
`check:layers`, to `typecheck`, and to a grep for import paths. They are what
actually stops this work, and they must be severed **before** the mechanical
registry conversion, because the conversion will otherwise look complete while
the app still throws on boot.

| Edge | Location | Class |
| --- | --- | --- |
| `getStructByName('mesh.Mesh')` — **throws from the AppState constructor** | `scripts/data_api/api_define.ts:339-344` | F |
| `'mesh.vertex_smooth()'` in a default keymap | `scripts/editors/view3d/view3d.ts:680` | F |
| `selmask=17` keymap literals | closed by **P6** | F |
| `CurveSpline extends Mesh` | `curve.ts:75` | E |
| `Strand extends CurveSpline` | `strand_types.js:36` | E |
| `LEGACY_STRUCT_NAME_MAP` — maps bare legacy names onto `mesh.*` targets | `scripts/core/legacy_struct_migration.ts:34-102` | G |

### 2.1 `api_define.ts:339-344`

The current code is *deliberately* string-keyed — its comment says it fetches
the struct by stable nstructjs name "so core never imports the addon-owned Mesh
class." That was the right instinct and the wrong mechanism: it converts an
import edge into a **hard boot failure** when the addon is absent, thrown from
the `AppState` constructor with a message that tells the user to import a bridge
file.

Replace with the P7 hook: the mesh addon contributes its Data API subtree from
its `register(api)` (`api.registerDataKind` / the props-panel case), and
`api_define.ts` iterates contributions. Absent addon → absent subtree → empty
viewport, not a throw.

Same treatment for the `buildCDAPI` / `buildProcMeshAPI` calls and the six mesh
side-effect imports in that file. Model the mechanism on
`api_define_registry.js`, which already does this correctly for another case.

### 2.2 `view3d.ts:680`

`new HotKey('W', [], 'mesh.vertex_smooth()')` — a host default keymap naming an
addon ToolOp. Keymap entries must come from the addon that owns the tool, added
in its `register(api)` and removed on unregister. Check for a second failure
mode while doing it: an unresolvable toolpath in a keymap should log and skip,
never throw at keymap build time.

### 2.3 The inheritance chain

`CurveSpline extends Mesh` and `Strand extends CurveSpline` mean curves and
hair are BREP subclasses. Both leave with P13 (open decision #4), so the
severing here is: confirm nothing *else* inherits from them, record the chain in
this document, and make sure `scripts/hair/` and `scripts/tet/` are inside
P1's widened `check:layers` `from` set so the edge is at least counted.

Do not attempt to reparent `CurveSpline` onto something else. If curves are
archived (decision #4, P13), the work is wasted; if they are ported, it is P19's
kind of work, not this plan's.

### 2.4 `legacy_struct_migration.ts`

The table maps bare legacy struct names (`CotanVert`) onto module-qualified ones
(`mesh.CotanVert`). Once `mesh.CotanVert` is not a registered struct, the
migration rewrites an old name into a name that resolves to nothing — which is
*better* than leaving it bare only if the unknown-struct path works, which is
P10's job.

Here: split the table by owning addon, and let each addon contribute its own
entries through the P7 `registerFileMigrator` case. The host keeps only the
entries for host-owned structs. This is also what P4's struct-rename guidance
depends on.

## 3. Step 1: the mechanical registry conversion

### 3.1 `data_api/api_define.ts`

Covered in §2.1. Exit: no mesh import, no `getStructByName('mesh.*')`, no throw.

### 3.2 `view3d_draw.ts`

Submit through the render queue for anything the `SceneObjectData` contract says
is drawable; drop the `Mesh` value import. Watch for two things:

- `view3d_draw.ts:170-222` (element iteration) and `:302-368` (active/highlight
  element → shader uniforms) are P7 capabilities. Use them; do not re-derive.
- `camera.ts:163,165` `scheduleRawGLPass` **throws** on the WebGPU adapter
  (`queue_adapter.ts:229-234`). "Everything goes through the queue" is not yet
  true. If this plan hits it, fix the call site here — it is a two-line
  conversion — rather than leaving a landmine for P11.

### 3.3 `PropsEditor.ts`

Replace the branch on concrete type with `api.registerPropsPanel(...)` (P7 §9).
`PropsEditor` is a dense site — `:138,166,168,189-196,235-237,367-387,494-513,633-637`
all touch mesh-specific capability. Convert each to either a registered panel
contribution or a P7 optional-capability query. The CustomData-layer UI
(`:367-387,494-513`) is the biggest chunk and is genuinely generic once it talks
to the attribute vocabulary rather than to `CustomData` the BREP class.

### 3.4 `entry_point.js`

Delete the mesh imports **and the five-module re-export**. That re-export is a
public commitment to the BREP: anything downstream importing the entry point
gets `Mesh` and friends whether it asked or not. Removing it is a breaking
change for external consumers and should be called out in the release notes
alongside P5's texture-paint gap.

### 3.5 `AddonAPI`

P7 adds the six dispatch cases. This plan is their first real consumer — if a
case turns out to have the wrong shape, fix it in P7's files and say so here,
rather than working around it locally.

## 4. Non-goals

- Deleting anything (P13).
- Driving `check:layers` to zero and flipping severities (P9).
- The serialization round-trip (P10). This plan makes the app *boot* without the
  addon; it does not make files *safe* without it.

## 5. Tests

- **The gate**: boot with the mesh addon force-disabled and reach an **empty
  viewport** rather than a constructor throw. Requires P14's force-disable, which
  lands later — until then, simulate by not importing the addon in a test
  harness build. Write the test now against whichever mechanism exists; re-point
  it at the real force-disable in P14.
- **Keymap**: an unresolvable toolpath logs and skips.
- **Props panels**: with the mesh addon present, the properties tab is
  unchanged (screenshot or DOM-shape assertion) — the conversion must be
  behaviour-neutral.
- **Grep tests**, added to CI: no `getStructByName('mesh.` in `scripts/`; no
  `'mesh.` toolpath literal in a host keymap; the P7 "no host branch on concrete
  type" test extended to `scripts/editors/properties/` and
  `scripts/editors/view3d/view3d_draw.ts`.
- `pnpm check:layers` well below P1's baseline — this is the plan that moves the
  number most. Record the delta.
- Full `pnpm test` on both sculptcore backends; the app must still behave
  identically with the addon present.

## 6. Risks

- **The invisible edges are not fully enumerated.** The six above came from a
  targeted review, not an exhaustive sweep. Mitigation: before starting, run and
  record a full sweep for (a) `extends` across the addon boundary, (b) string
  literals matching `^mesh\.` anywhere in `scripts/`, (c) `getStructByName` /
  `getStruct` / `nstructjs.` name lookups, (d) `defineAPI` path strings naming
  mesh. Put the results in this document under
  `## Sweep (measured YYYY-MM-DD)`.
- **`PropsEditor` conversion changes the UI subtly.** Mitigation: the
  behaviour-neutral assertion in §5.
- **Removing the `entry_point` re-export breaks an external consumer.**
  Mitigation: it is intentional and it is announced.
- **P14's force-disable does not exist yet**, so the headline exit criterion is
  tested through a proxy. Mitigation: P14 re-runs it for real, and P15's exit
  criterion depends on the same mechanism.

## 7. Exit criteria

- Booting with the mesh addon absent reaches an empty viewport. No throw from
  the `AppState` constructor, the keymap builder, or `getDataAPI()`.
- No `scripts/` file imports, names, or inherits from a BREP type — verified by
  the four sweeps in §6 plus the grep tests in §5.
- The mesh addon contributes its Data API subtree, props panels, keymap entries
  and struct-migration entries through `AddonAPI`; nothing registers at module
  scope.
- With the addon present, behaviour is unchanged and the full test suite is
  green on both backends.
- `pnpm check:layers` count recorded against P1's baseline.
