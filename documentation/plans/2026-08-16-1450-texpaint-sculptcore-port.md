# Texture painting: port to sculptcore

**Status: plan — DEFERRED. Not scheduled.**
This document exists so that the capability deleted in P5 is not lost track of.
It is deliberately *not* sequenced ahead of P5 (W2b), and nothing in the Faber
Leaf refactor roadmap blocks on it. Pick it up when texture painting is wanted
again as a product feature; until then the app ships without 3D texture paint.

- Supersedes the implementation described in `documentation/pbvhTexPaint.md` and
  the older `documentation/oldTexPaintTool.md`. Both are retained as the
  behavioral reference for what is being reproduced.
- Parent roadmap: `documentation/plans/2026-08-15-0237-faber-leaf-refactor-strategy.md`
  (§9.4 open decision #5, settled as *delete now, port plan deferred*).
- Deletion that motivated this: `documentation/plans/2026-08-15-0320-w2-delete-ts-sculpting-stack.md` §5.

---

## 1. What was removed, and why the port cannot reuse it

P5 deleted, as part of the TS sculpting stack:

| File | Lines | Role |
|------|-------|------|
| `scripts/editors/view3d/tools/pbvh_texpaint.ts` | 1206 | `TexPaintOp` — the modal stroke, UV-space rasterizer, undo tiler |
| `scripts/editors/view3d/tools/pbvh_texpaint_blur.ts` | 189 | `BrushBlurFBO` — the smear/smudge UV patch |
| `scripts/webgpu/texpaint_bridge.ts` | 117 | WebGL2→WebGPU readback shim |

None of it is a viable base for the port, for three independent reasons:

1. **It was already inoperative.** Both files reach GL through the `_gl` global.
   The default renderer is WebGPU-only, and `view3d_draw_webgpu.ts:902` throws
   `[webgpu] WebGL property "${name}" accessed on WebGPU stub` on the first such
   access. The feature had no working path on the shipping renderer before P5
   touched it — the delete removed dead code, not a regression.
2. **It hung off the deleted stack.** `TexPaintOp` was driven from `BVHToolMode`
   and consumed `PaintSample`, `bvh.closestTris`, `mesh._ltris`, `getUVWrangler`
   and the mesh-addon `cd_corner` layer. Every one of those is either gone or
   belongs to the legacy `Mesh` path, not `LiteMesh`.
3. **The bridge is gone too.** The P5 plan called `texpaint_bridge.ts` "the
   landing pad for the eventual replacement". On inspection it was a WebGL2
   isolation shim with **zero callers repo-wide**, so it went with the delete.
   The port therefore lands on WebGPU directly and needs no bridge.

Treat `documentation/pbvhTexPaint.md` as a specification of *behavior to
reproduce* (§1 "rasterize in UV space, evaluate the brush in screen space"
remains the correct core trick), not as code to revive.

---

## 2. Why sculptcore already contains most of this

The strong reason to port rather than rewrite in TS: **sculptcore already runs
the pbvhTexPaint algorithm**, for vector displacement. `sculptcore/source/vdm/vdm_splat.h`
opens with, verbatim:

> rasterize a dab's footprint into the store's UV tiles — the pbvhTexPaint
> pattern with a float3 payload and world-space falloff.

The pieces that made `pbvh_texpaint.ts` expensive to maintain are already built,
tested and shipping in `sculptcore/source/vdm/`:

| pbvh_texpaint.ts concern | sculptcore equivalent |
|---|---|
| "which triangles are under the dab" (`bvh.closestTris`) | `SpatialTree::filterNodes` + per-face gate (`vdm_splat.cc`) |
| UV-space triangle rasterization at texture resolution | `vdm_splat.cc` face-UV rasterizer |
| the texture itself | `VdmStore` — sparse tiled texel store, `tile_size²` blocks allocated on first write (`vdm_store.h`) |
| undo tiles (`GPUTile`, `saveUndoTile`) | `VdmStore::beginDelta()`/`endDelta()` → self-inverse `VdmDelta`, `MeshLog` chunk |
| GPU residency + upload of painted texels | `vdm_gpu.cc` (stable atlas slots) |
| procedural brush texture spliced into GLSL | `.sbrush` / `.stex` DSL + `brush/texture_eval.h`, CPU and WGSL emitted in lockstep |
| brush falloff, spacing, symmetry, stroke replay | `BrushStrokeDriver` + `stroke_driver.cc` (host-driven, already the contract for every other brush) |

So the port is mostly a **payload change plus a parameterization change**, not a
new subsystem: `float3` tangent displacement → `float4` premultiplied color, and
Ptex/atlas grid UVs → the mesh's authored UV layer.

---

## 3. Proposed shape of the port

Five workstreams, roughly in dependency order. Sizes are estimates, not commitments.

### T1 — `TexPaintStore` (C++, sculptcore)
Generalize `VdmStore`'s payload, or clone it, to carry `float4` texels. Prefer
**templating the existing store on its payload type** over a copy: the tiling,
delta/undo bracket, bound pyramid and GPU-slot bookkeeping are payload-agnostic,
and the `bound` field simply becomes unused (or a max-alpha) for color. Decide
this with a read of `vdm_store.cc` — if the bound pyramid is too entangled, a
sibling store is acceptable.

Backing an *existing* image datablock rather than an engine-private store is the
main open question; see §5.

### T2 — UV parameterization
`VdmStore` today keys texels off either the packed corner-UV atlas or the Ptex
per-grid lattice (`VdmBackend::{ATLAS,PTEX}`). Texture painting needs a third
mode: the mesh's **authored** UV attribute, with real islands, seams and
overlaps. The rasterizer changes little; what is new is seam handling —
`vdm_splat.h` records that "UV-seam skirts (one-texel copies for seamless
bilinear reads) are not yet implemented". `pbvh_texpaint.ts` solved the same
problem with its seam-guard quads (extruding along `cd_corner.bTangent`); that
approach ports, but the skirt-copy approach is cleaner and benefits VDM too.
**Land the skirt work once, for both.**

### T3 — the paint kernel
A `texpaint.sbrush` (or an `accum_mode`-style variant of `color.sbrush`) that
evaluates falloff in screen space from the projected texel position — the
"UV-raster / screen-eval" split of `pbvhTexPaint.md` §5 — and blends into the
texel with the existing color mix modes (`color.sbrush mixMode`, 9 modes, already
shipping). Facing fade (`|n·v|³`) and the procedural-texture multiply come from
the DSL, not from hand-written shader source.

### T4 — host wiring (TS)
- A `litemesh.texpaint_*` ToolOp family for lifecycle (target image, resolution,
  bake/flush), matching the `litemesh.vdm_*` precedent.
- Stroke input through `BrushStrokeDriver` + `SculptPaintOp`, with per-kernel
  policy **queried** via `resolveDabPolicy` — no tool-name conditionals in the
  host (see `documentation/strokeDriverReport.md` and the engine-side contract).
- Brush UI: reuse the sculpt brush datablock; add whatever texpaint-only props
  survive triage (`doBlur` almost certainly does not — see §4).

### T5 — render path
Painted texels reach the material through the existing WebGPU attribute-driven
material contract (`documentation/shader-attributes.md`). If the store backs an
image datablock (§5) this is mostly "upload the dirty tiles"; if it is
engine-private it needs an explicit bake-to-image step, which T4's ToolOp family
must expose.

---

## 4. Explicitly out of scope

- **The smear/blur path (`BrushBlurFBO`).** It rendered surface UVs into a small
  FBO so the brush could pull existing texels along the drag. Reproducing it
  needs a screen-space UV patch on the WebGPU side; it is a separate feature, not
  part of restoring basic painting. `colorsmooth.sbrush` already covers the
  common "soften what's there" need for vertex colors and is the better model.
- **The debug globals** `window.DDD` / `DD5` / `DD6` (seam extrusion, UV snap
  offset, edge inset). These were development knobs. Any value they encoded
  becomes a real parameter or a constant, not a global.
- **Legacy `Mesh` support.** The port targets `LiteMesh` only. Painting on the
  old `Mesh` path is not restored.
- **File-format compatibility with old texpaint strokes.** `bvh.texpaint` ToolOps
  were never persisted in a way that needs replaying; P10's generic unknown-data
  machinery covers anything that turns up.

---

## 5. Open questions to settle before starting

1. **Who owns the texels?** Two options, and this is the load-bearing decision:
   - *Engine-owned store* (mirrors VDM): sculptcore owns a `TexPaintStore`,
     undo rides `MeshLog`, and a ToolOp bakes to an image datablock on demand.
     Consistent with everything else in the engine; costs an explicit bake step.
   - *Image-datablock-owned*: sculptcore writes into texels the host owns, undo
     is the host's problem. Cheaper to display, but re-invents the undo tiling
     that `VdmStore` already gets right, on the host side, in TS.

   Recommendation: **engine-owned**, for undo alone.
2. **Store or template?** Whether `VdmStore` templates cleanly on payload (§T1).
3. **Skirts now or later?** T2 argues for landing UV-seam skirts once for both
   VDM and texpaint. That makes T2 partly a VDM improvement and it could be
   pulled forward independently of this plan.
4. **Multires/Ptex interaction.** A mesh can already carry a Ptex-parameterized
   VDM store. Whether texture painting on such a mesh paints the Ptex lattice or
   the authored UV layer is a UX decision, not just a technical one.

---

## 6. Sequencing note

Nothing in the refactor roadmap (P5–P10) depends on this. Reasonable trigger
points to schedule it: after P10 (the unknown-data/format work), or whenever
texture painting is wanted as a shipping feature. If it is scheduled, T2's skirt
work is the piece most likely to be worth splitting out and landing early on its
own, since VDM benefits from it immediately.
