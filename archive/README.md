# `archive/` — rescued, not maintained

Code that was deleted from the live tree but is too expensive to lose. It does
**not** compile against the current host, it is excluded from the build, from
`tsconfig`, from `check:layers`, from eslint and from prettier, and nothing
imports it. It is here to be *read* and ported, not to be kept working.

Everything here was moved by P13 — [the TS BREP
delete](../documentation/plans/2026-08-15-0400-w1-delete-ts-brep.md) — whose §2
table records the disposition of every feature the delete touched.

The loose `*.png` files at this directory's top level are an unrelated
screenshot dump from old debugging sessions and are gitignored.

| Directory | Was | Depended on | Who would port it |
| --- | --- | --- | --- |
| `subsurf/` | `addons/builtin/subsurf/` | BREP `Mesh` | none scheduled; sculptcore owns multires subdivision now |
| `curve/` | `addons/builtin/curve/` | `CurveSpline extends Mesh` | none scheduled |
| `tetmesh/addon/` | `addons/builtin/tetmesh/` | BREP `Mesh` + `tetgen/` below | none scheduled |
| `tetmesh/tetgen/` | `scripts/tet/` | BREP `bvh.ts`, `customdata.ts`, `mesh_base.ts` | none scheduled — 3,875 lines of tetrahedral meshing, the reason this directory exists at all |
| `hair/strands/` | `scripts/hair/` | `Strand extends CurveSpline` | none scheduled |
| `hair/addon/` | `addons/strand/` | the strand types above | none scheduled |

`uv-editor/` was here until P18 rewrote it: the editor is now
`addons/builtin/uv_editor/` over `IUVSource`, and which of the old behaviours
came back is recorded in [that plan](../documentation/plans/2026-08-15-0425-w4-iuvsource-uv-editor.md)
§5 step 7 rather than in a file here.

`unwrapping/` followed it in P19. The angle solver, the relaxer and the packer
are `addons/builtin/uv_editor/src/{uv_wrangler,uv_solve}.ts`, rebuilt around
integer handles from `IUVSource` — the port could not keep `UVWrangler`'s
representation, which held `Loop` objects. Three capabilities were dropped
rather than ported: voxel unwrap, the paramizer (`mesh_paramizer.ts`) and
`fixSeams`. Each is a row in `ImmediateTODOs.md` with the `git show` incantation
that recovers it, and the reasoning is in
[the port plan](../documentation/plans/2026-08-15-0430-w4-unwrapping-port.md)
§3.4, §3.2 and §6.

**Porting any of these means rewriting it against LeafMesh**, because each one
subclasses or consumes the BREP `Mesh` that no longer exists. That is a feature
project. Nothing here is a mechanical move.

**Files saved with this data still open.** P10 made an absent addon's blocks
survive a load/save round trip as preserved-but-inert data, so a `.wproj`
containing curve, tet, hair or subsurf objects loads, keeps its bytes, and says
which addon is missing — it just cannot draw or edit them.
