# Old Texture-Paint Tool (`pbvh_texpaint.ts`)

> **⚠ REMOVED 2026-08-16 — this documents code that is no longer in the tree.**
> See [pbvhTexPaint.md](pbvhTexPaint.md), which supersedes this file and carries
> the same warning, and the deferred port plan
> [plans/2026-08-16-1450-texpaint-sculptcore-port.md](plans/2026-08-16-1450-texpaint-sculptcore-port.md).

`scripts/editors/view3d/tools/pbvh_texpaint.ts` implements `TexPaintOp`, the
legacy **3D texture-painting** brush stroke. It is a modal `ToolOp` driven from
the PBVH/BVH sculpt toolmode (`BVHToolMode`): you drag the cursor over a mesh in
the 3D viewport and color is splatted into the object's *active image texture*
through its UV layout. It is a WebGL2-only tool (uses `_gl`, FBOs, GLSL shaders)
and predates the WebGPU/sculptcore rewrite — hence "old".

This document describes how it works as it currently stands; note that parts of
it (undo, in particular) are explicitly stubbed/incomplete.

---

## 1. Big picture

The op converts a brush drag into a series of **dabs** ("dots"). For each dab it:

1. Ray-casts from the cursor through the BVH to find the surface hit point.
2. Gathers the triangles within the brush radius of that hit (`bvh.closestTris`).
3. Builds a temporary `SimpleMesh` of those triangles **in UV space** (each tri's
   vertex positions are its UV coordinates, remapped to clip space), carrying the
   world/screen positions and per-vertex parameters as custom vertex layers.
4. Renders that UV-space mesh into the texture's draw FBO with a brush shader,
   additively blending the brush color where the dab overlaps. The shader uses the
   carried screen/world coordinates to evaluate the brush falloff in *screen* space
   while rasterizing in *UV* space — this is what makes it "project paint".
5. Saves the affected texture region into undo tiles before drawing.
6. Swaps the FBO result back into the texture.

The key trick: **rasterize in UV space, evaluate the brush in screen space.** The
triangle is drawn at its UV positions (so every texel under the UV island gets
shaded), but each fragment knows its projected screen position, so the circular
brush mask and texture-projection are computed as if painting on screen.

---

## 2. Inputs / op definition

`tooldef()` (`toolpath: 'bvh.texpaint'`, `is_modal: true`) declares these inputs:

| Input | Type | Meaning |
|-------|------|---------|
| `brush` | `BrushProperty` | the `SculptBrush` (color, radius, strength, spacing, `texUser` procedural texture). |
| `samples` | `PaintSampleProperty` | accumulated `PaintSample` dab records for the stroke (also used for replay in `exec`). |
| `rendermat` | `Mat4Property` | camera `rendermat` captured at sample time. |
| `glSize` | `Vec2Property` | GL drawing-buffer size. |
| `viewSize` | `Vec2Property` | logical view size. |
| `symmetryAxes` | `FlagProperty` | `{X,Y,Z}` symmetry flags (read from `mesh.symFlag`). |
| `doBlur` | `BoolProperty` | enables the smear/blur FBO path. |

Per-instance modal state: `first`, `start_mpos`, `last_mpos`, `mpos`, `last_p`
(last hit world pos, `[3]` = perspective w), `last_radius`, the undo-tile
accumulators `_tiles` / `_tilemap`, and an optional `blurfbo`.

---

## 3. `PaintSample`

`PaintSample` (`pbvh_paintsample.ts`) is the serializable per-dab record shared
with the sculpt tools; the texpaint tool uses only a subset of its many fields:

- `p` — world-space hit point (`p[3]` holds perspective `w`).
- `viewvec` / `vieworigin` — the ray for this dab (used for backface culling and
  the per-vertex facing fade).
- `color`, `strength`, `angle`, `radius`.
- `mpos` (a `Vector2`, marked `@deprecated`) — the screen position of the dab.

Samples are pushed onto `inputs.samples` so the whole stroke can be re-applied
deterministically by `exec()`.

---

## 4. Stroke lifecycle (modal flow)

### `modalStart(ctx)`
Resets `first = true` and refreshes the UV island data with
`getUVWrangler(mesh, true, true)` (see §6).

### `on_mousemove(e)` — the dab generator
This is the heart of the stroke. For each pointer move:

1. Converts the event to local mouse coords and updates `this.mpos`; pushes the
   raw `e.x/e.y` into `toolmode.mpos` so the toolmode keeps drawing the brush
   circle.
2. Builds the symmetry axis list from `mesh.symFlag` and gets the BVH
   (`getBVH({autoUpdate: false})`).
3. Captures `rendermat`, `glSize`, `viewSize` from the active camera/view into the
   op inputs.
4. **Ray cast (with symmetry):** for each axis it builds a ray
   (`origin`/`view` from `view3d.getViewVec`); for mirrored axes it transforms the
   ray into object space, negates the axis component, and transforms back, then
   `bvh.castRay`. It keeps the nearest hit (`isect`). The hit point feeds
   `toolmode.debugSphere`.
5. **First sample bootstrap:** on the very first move it just records
   `start_mpos`/`last_mpos`/`last_p` and returns (no paint).
6. **Radius in world units:** projects the hit point with `rendermat` to get
   perspective `w` (returns early if behind the camera, `w < 0`), then scales the
   pixel radius into world units via `radius = sradius/max(glSize) * |w|`.
7. **Optional blur:** if `doBlur`, lazily creates a `BrushBlurFBO`, updates it to
   the pixel radius, and renders the local surface UVs into it (see §7).
8. **Spacing → steps:** `steps = dist(hit, last_p) / (radius * spacing)`; returns
   if `< 1` so dabs are evenly spaced along the drag.
9. **Emit dabs:** for each step it interpolates position (`last_p → hit`),
   perspective `w`, and `mpos` (`last_mpos → mpos`), fills a fresh `PaintSample`
   (color = `brush.bgcolor` if Ctrl is held else `brush.color`, `angle` =
   stroke direction `atan2(dy,dx)`), pushes it to `inputs.samples`, and calls
   `execDot(ctx, ps)` immediately so painting is live.
10. Advances `last_mpos`/`last_p` and requests a viewport redraw.

### `exec(ctx)` — non-modal replay
Re-applies a finished stroke from its stored `samples` (used for redo / file
replay): verifies a `uv` loop layer exists, refreshes the UV wrangler, and calls
`execDot` for every stored sample.

### `on_mouseup(e)` / `modalEnd(wasCanceled)`
Mouse-up ends the modal op. `modalEnd` clears the toolmode's custom `_radius`
override so the toolmode resumes normal brush-circle drawing.

---

## 5. `execDot(ctx, ps)` — painting one dab

This ~700-line method does the actual GL work. Outline:

### Texture prep
- Bails unless `ctx.mesh` and `ctx.activeTexture` exist and the texture is `ready`.
- Forces the image to `ImageTypes.FLOAT_BUFFER` (destroying any stale `glTex` /
  `_drawFBO` first), so paint accumulates in float precision.
- Gets the texture's draw FBO (`texture.getDrawFBO(gl)`) and GL texture; marks
  `gpuHasData = true`.

### Gather triangles
- `bvh.closestTris(co, radius)` → set of `BVHTri` near the hit.
- Filters to **front-facing** tris (`t.no.dot(ps.viewvec) <= 0`), recomputing each
  tri normal/area and accumulating an area-weighted average normal `avgno`.
- Looks up custom-data layers: `cd_uv` (required; loop-domain `uv`), and a
  `color` layer (loop-domain when the mesh has multires grids, else vert-domain).
  Grid meshes read UVs straight off grid points; ordinary meshes read UVs off the
  triangulated loop list `mesh._ltris`.

### Build the UV-space `SimpleMesh`
Two `SimpleMesh`es are created (`LOC | UV | CUSTOM`): `sm` for triangles and
`line_sm` for the seam-guard geometry. Extra custom vertex layers:

- `sm_loc` (vec4) — projected **screen** position of each vertex.
- `sm_worldloc` (vec3) — **world** position.
- `sm_params` (vec2) — per-vertex parameters; `[0]` is the facing term
  `|vno · viewvec| ** 3` (a fresnel-like fade).

For each surviving triangle:
1. Loads the three UVs; `processuv()` snaps each UV to the texel grid (with the
   debug-tunable `window.DD5` offset) to reduce seam bleeding.
2. Optionally insets/outsets the UV triangle edges by `window.DD6` (`ue1..ue3`
   edge normals) to grow the rasterized footprint slightly.
3. Projects the world positions to screen with `project(p, rendermat, viewSize)`
   into `p1..p3` (`[3]` = perspective `w`).
4. Computes barycentric coords of the dab center (`brushco`, the dab's screen
   `mpos`) within the *screen* triangle (`math.barycentric_v2`), and a perspective
   weight `w2`, used to bound the painted UV region (`umin`/`umax`).
5. Remaps the UVs from `[0,1]` to clip space (`*2-1`) and emits a triangle into
   `sm` via `sm.tri(...)`, attaching `sm_loc`, `sm_worldloc`, `sm_params`.
6. **Seam guard:** for any triangle edge that the UV wrangler marks as a seam
   (`wrangler.seamEdge`), it extrudes a quad outward along the per-corner UV
   tangent (`cd_corner.bTangent`, scaled by `window.DDD`) so paint bleeds *past*
   the UV-island border and seams don't show a hard edge. These quads carry the
   same `sm_loc`/`sm_worldloc`/`sm_params` so they shade identically.

`umin`/`umax` track the texel bounding box of everything drawn (plus an 8-texel
margin), used both for the scissor rectangle and for undo-tile selection.

### Undo tiling
- `saveUndoTile_intern(tx,ty)` allocates a `GPUTile` from `tileManager`, and blits
  the current texture sub-region (in `UNDO_TILESIZE`-sized tiles) into the tile's
  FBO via the texture's blit shader. Tile id = `ty*rowsize + tx`.
- `saveUndoTile(smin,smax)` clamps/expands the dab bbox to whole tiles and saves
  every not-yet-saved tile into `_tilemap`/`_tiles`. On the **first** dab the whole
  texture is saved (the `fbo.__first` flag); afterward only the dab bbox.

### Draw the dab
- Binds the draw FBO sized to the texture, disables depth, and sets a **scissor**
  to `umin..umax` (after the first dab) so only the touched region is touched.
- Clears to mid-grey then blits the *current* texture into the FBO (so painting
  composites over existing content).
- Builds uniforms (`size`, `aspect`, `projectionMatrix`/`objectMatrix` identity,
  `uColor` = `ps.color` with alpha pre-multiplied by `strength`, `brushCo` =
  screen `mpos`, `radius`, `brushAngle`).
- Gets the brush shader via `getShader(gl, brush)` (see §8) and binds it. If a
  blur FBO is active it switches the shader into `BLUR_MODE` and binds the blur
  texture + screen-space view box; if the brush has a procedural texture it sets
  `BRUSH_TEX` / `BRUSH_TEX_SPACE` defines and binds the texture's uniforms.
- Sets additive-ish alpha blending
  (`blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ZERO, CONSTANT_ALPHA)` with
  `blendColor` driving the constant alpha), draws `sm` then `line_sm`, then
  unbinds and calls `texture.swapWithFBO(gl)` to make the painted FBO the new
  texture content.

The trailing `if (haveColor && 0)` block is dead/experimental vertex-color
debugging code (gated off with `&& 0`).

---

## 6. UV wrangler (`getUVWrangler`)

`getUVWrangler(mesh, ...)` (from the mesh addon's `unwrapping`) builds and caches
the per-loop UV-island structure the dab pass relies on:

- `islandLoopMap` / `loopMap` — loop → island / loop → island-loop lookups.
- `cd_corner` — a custom layer per island corner holding `corner`, `bTangent`
  (border tangent, used to extrude the seam guard), etc.
- `seamEdge(e)` — whether a mesh edge is a UV seam.

`modalStart` and `exec` call it with the rebuild flags set; `execDot` fetches the
already-built one.

---

## 7. Blur / smear path (`BrushBlurFBO`)

`pbvh_texpaint_blur.ts` defines `BrushBlurFBO`, used only when `doBlur` is set.
`draw()` renders the BVH nodes' draw geometry into a small square FBO sized to the
brush, using `BrushBlurShader` which writes `vec4(uv, id, 1)` — i.e. it bakes the
**UV coordinates of the surface under the brush** into a screen-space patch
(`vboxMin`/`vboxMax` map the brush's screen rect into the FBO). The main brush
shader, in `BLUR_MODE`, then samples that patch to smear existing texture content
(a pull/smudge effect) instead of stamping flat color.

---

## 8. Brush shader (`getShader`)

`getShader(gl, brush)` clones `ShaderDef.TexturePaintShader` and, when the brush
has a procedural texture (`brush.texUser.texture`, a `ProceduralTex`), splices the
texture's generated GLSL into the fragment source: `tex.genGlslPre(...)` is
substituted for the `//{BRUSH_TEX_PRE}` marker and `tex.genGlsl(...)` (wrapped in
a block scope) for the `BRUSH_TEX_CODE` marker. The result is compiled with
`getShader`. Procedural-texture and blur behavior are further toggled at draw time
through shader `defines` (`BRUSH_TEX`, `BRUSH_TEX_SPACE`, `BLUR_MODE`).

---

## 9. Undo

Undo **is implemented** — the `console.warn('implement me!')` lines in `undoPre`
and `undo` are stale leftovers, not an indication that the code is missing.

- `undoPre` clears `_tiles`/`_tilemap` at the start of the stroke; the tiles are
  then populated during painting by `saveUndoTile` (§5).
- `undo` re-binds the texture's draw FBO, redraws the current FBO, then blits every
  saved `GPUTile` back over the painted region with `blitFramebuffer`, restoring
  the pre-stroke texels, and swaps the FBO back into the texture. It also
  defensively retries (up to ~5 s) if the texture isn't `ready`/`glTex` yet.

---

## 10. Notable quirks / debug knobs

- **`window.DDD` / `DD5` / `DD6`** are live-tunable debug globals (declared at the
  top of the file) controlling seam-guard extrusion distance, UV snap offset, and
  edge inset respectively. They are development knobs, not real settings.
- The op is **WebGL2-only** and reaches GL through the `_gl` global; it is not part
  of the WebGPU/sculptcore rendering path.
- Lots of commented-out experimental code remains (alternate radius formulas, the
  vertex-color debug block, line-mesh seam drawing).
- Registered at module scope with `ToolOp.register(TexPaintOp)` — i.e. it is a
  core/legacy tool, not an addon-registered one.
