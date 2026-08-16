# PBVH Texture Painting (`pbvh_texpaint.ts` / `pbvh_texpaint_blur.ts`)

> **⚠ REMOVED 2026-08-16 — this documents code that is no longer in the tree.**
> Both files went with the TS PBVH sculpting stack in P5
> ([plan](plans/2026-08-15-0320-w2-delete-ts-sculpting-stack.md)). They were
> WebGL2-only and already inoperative on the WebGPU renderer before the delete.
>
> This file is **kept deliberately**, as the behavioral specification for the
> deferred sculptcore port —
> [plans/2026-08-16-1450-texpaint-sculptcore-port.md](plans/2026-08-16-1450-texpaint-sculptcore-port.md).
> Read it as "what the replacement must do", not as a guide to live code. Every
> path, symbol and line reference below is historical; recover the source with
> `git show <pre-P5-commit>:scripts/editors/view3d/tools/pbvh_texpaint.ts`.

`scripts/editors/view3d/tools/pbvh_texpaint.ts` implements **`TexPaintOp`**, the
3D texture-painting brush stroke, and `pbvh_texpaint_blur.ts` implements
**`BrushBlurFBO`**, the optional smear/smudge helper. Together they let you drag
the cursor over a mesh in the 3D viewport and splat color into the object's
*active image texture* through its UV layout.

Both are **WebGL2-only** (they use the `_gl` global, FBOs, and GLSL shaders) and
predate the WebGPU/sculptcore rewrite. `TexPaintOp` is a modal `ToolOp` driven
from the PBVH/BVH sculpt toolmode (`BVHToolMode`), registered at module scope
with `ToolOp.register(TexPaintOp)` (toolpath `bvh.texpaint`).

> Note: this documents the code as it stands. There is an older near-identical
> writeup at `documentation/oldTexPaintTool.md`; this file is the current
> combined reference for both source files.

---

## 1. The core trick: rasterize in UV space, evaluate the brush in screen space

A brush drag is converted into a sequence of **dabs** ("dots"). For each dab the
op:

1. Ray-casts from the cursor through the BVH to the surface hit point.
2. Gathers front-facing triangles within the brush radius (`bvh.closestTris`).
3. Builds a temporary `SimpleMesh` of those triangles **positioned at their UV
   coordinates** (remapped to clip space), carrying each vertex's projected
   *screen* position and *world* position as extra custom vertex layers.
4. Renders that UV-space mesh into the texture's draw FBO with a brush shader.
   The rasterizer walks UV space (so every texel under the UV island is touched),
   but each fragment knows its projected screen position, so the **circular brush
   falloff and any procedural texture are evaluated in screen/world space** — this
   is what produces projection painting.
5. Saves the affected texels into undo tiles *before* drawing.
6. Swaps the painted FBO back into the texture.

---

## 2. Op definition and inputs

`tooldef()` — `toolpath: 'bvh.texpaint'`, `is_modal: true`:

| Input | Type | Meaning |
|-------|------|---------|
| `brush` | `BrushProperty` | the `SculptBrush`: color, bgcolor, radius, strength, spacing, `texUser` procedural texture. |
| `samples` | `PaintSampleProperty` | accumulated `PaintSample` dab records (also used to replay the stroke in `exec`). |
| `rendermat` | `Mat4Property` | camera `rendermat` captured at sample time. |
| `glSize` | `Vec2Property` | GL drawing-buffer size. |
| `viewSize` | `Vec2Property` | logical view size. |
| `symmetryAxes` | `FlagProperty` | `{X,Y,Z}` symmetry flags (sourced from `mesh.symFlag`). |
| `doBlur` | `BoolProperty` | enables the smear/blur FBO path. |

Per-instance modal state: `first`, `start_mpos`, `last_mpos`, `mpos`, `last_p`
(last hit world pos; `[3]` = perspective `w`), `last_radius`, the undo-tile
accumulators `_tiles` / `_tilemap`, and an optional `blurfbo`.

### `PaintSample`

`PaintSample` (`pbvh_paintsample.ts`) is the serializable per-dab record shared
with the sculpt tools. Texpaint uses only a subset of its many fields: `p`
(world hit, `p[3]` = `w`), `viewvec` / `vieworigin` (the dab ray, for backface
culling and facing fade), `color`, `strength`, `angle`, `radius`, and `mpos`
(a `Vector2`, marked `@deprecated`, holding the dab's screen position). Samples
are pushed onto `inputs.samples` so a finished stroke replays deterministically.

---

## 3. Stroke lifecycle

### `modalStart(ctx)`
Sets `first = true` and refreshes the UV island data via
`getUVWrangler(mesh, true, true)` (see §6).

### `on_mousemove(e)` — the dab generator
The heart of the stroke:

1. Converts the event to local mouse coords, updates `this.mpos`, and pushes the
   raw `e.x/e.y` into `toolmode.mpos` so the toolmode keeps drawing the brush
   circle.
2. Builds the symmetry-axis list from `mesh.symFlag`; fetches the BVH with
   `getBVH({autoUpdate: false})`.
3. Captures `rendermat`, `glSize`, `viewSize` from the active camera/view into
   the op inputs.
4. **Ray cast with symmetry:** builds a ray from `view3d.getViewVec`; for each
   mirrored axis it transforms the ray into object space, negates that axis
   component, transforms back, and `bvh.castRay`s, keeping the nearest hit
   (`isect`). The hit feeds `toolmode.debugSphere`.
5. **First-sample bootstrap:** on the first move it only records
   `start_mpos`/`last_mpos`/`last_p` and returns (no paint).
6. **Radius in world units:** projects the hit with `rendermat` for perspective
   `w` (returns early if `w < 0`, i.e. behind the camera), then
   `radius = sradius / max(glSize) * |w|`.
7. **Optional blur:** if `doBlur`, lazily creates a `BrushBlurFBO`, updates it to
   the pixel radius (`sradius * devicePixelRatio`, min 4), and renders the local
   surface UVs into it (see §7).
8. **Spacing → steps:** `steps = dist(hit, last_p) / (radius * spacing)`; returns
   if `< 1` so dabs stay evenly spaced along the drag.
9. **Emit dabs:** for each step it interpolates position (`last_p → hit`),
   perspective `w`, and `mpos` (`last_mpos → mpos`); fills a fresh `PaintSample`
   (color = `brush.bgcolor` if Ctrl held, else `brush.color`; `angle` = stroke
   direction `atan2(dy, dx)`); pushes it to `inputs.samples`; and calls
   `execDot(ctx, ps)` immediately so painting is live.
10. Advances `last_mpos` / `last_p` and requests a redraw.

### `exec(ctx)` — non-modal replay
Re-applies a finished stroke from stored `samples` (redo / file replay): checks a
`uv` loop layer exists, refreshes the UV wrangler, then `execDot`s every sample.

### `on_mouseup(e)` / `modalEnd(wasCanceled)`
Mouse-up ends the modal op. `modalEnd` clears the toolmode's custom `_radius`
override so the toolmode resumes normal brush-circle drawing.

---

## 4. `execDot(ctx, ps)` — painting one dab

### Texture prep
Bails unless `ctx.mesh` + `ctx.activeTexture` exist and the texture is `ready`.
Forces the image to `ImageTypes.FLOAT_BUFFER` (destroying any stale `glTex` /
`_drawFBO` first) so paint accumulates in float precision, then fetches the
texture's draw FBO and GL texture and sets `gpuHasData = true`.

### Gather triangles
`bvh.closestTris(co, radius)` → `BVHTri` set. Filtered to **front-facing** tris
(`t.no.dot(ps.viewvec) <= 0`), recomputing each tri normal/area and accumulating
an area-weighted average normal `avgno`. Resolves custom-data layers: `cd_uv`
(required, loop-domain), and a `color` layer (loop-domain on multires grids, else
vert-domain). Grid meshes read UVs straight off grid points; ordinary meshes read
them off the triangulated loop list `mesh._ltris`.

### Build the UV-space `SimpleMesh`
Two `SimpleMesh`es (`LOC | UV | CUSTOM`): `sm` for triangles, `line_sm` for
seam-guard geometry. Extra custom vertex layers on `sm`:

- `sm_loc` (vec4) — projected **screen** position of the vertex.
- `sm_worldloc` (vec3) — **world** position.
- `sm_params` (vec2) — per-vertex params; `[0]` is the facing term
  `|vno · viewvec| ** 3` (a fresnel-like fade).

Per surviving triangle:
1. Loads the three UVs; `processuv()` snaps each to the texel grid (with the
   `window.DD5` debug offset) to reduce seam bleeding.
2. Optionally insets/outsets the UV-triangle edges by `window.DD6` (edge normals
   `ue1..ue3`) to grow the rasterized footprint slightly.
3. Projects world positions to screen (`project(p, rendermat, viewSize)`) into
   `p1..p3` (`[3]` = perspective `w`).
4. Computes the dab center's barycentric coords within the *screen* triangle
   (`math.barycentric_v2` on `brushco` = the dab's screen `mpos`) and a
   perspective weight `w2`, used to bound the painted UV region.
5. Remaps UVs from `[0,1]` to clip space (`*2 - 1`) and emits a triangle via
   `sm.tri(...)`, attaching `sm_loc` / `sm_worldloc` / `sm_params`.
6. **Seam guard:** for any triangle edge the wrangler marks as a UV seam
   (`wrangler.seamEdge`), it extrudes a quad outward along the per-corner UV
   tangent (`cd_corner.bTangent`, scaled by `window.DDD`) so paint bleeds *past*
   the UV-island border and seams don't show a hard edge. These quads carry the
   same custom layers so they shade identically.

`umin` / `umax` track the texel bounding box of everything drawn (plus an 8-texel
margin) — used both for the scissor rectangle and for undo-tile selection.

### Undo tiling
- `saveUndoTile_intern(tx, ty)` allocates a `GPUTile` from `tileManager` and blits
  the current texture sub-region (`UNDO_TILESIZE`-sized tiles) into the tile's FBO
  with the texture's blit shader. Tile id = `ty*rowsize + tx`.
- `saveUndoTile(smin, smax)` clamps/expands the dab bbox to whole tiles and saves
  every not-yet-saved tile into `_tilemap` / `_tiles`. On the **first** dab the
  whole texture is saved (via the `fbo.__first` flag); afterward only the bbox.

### Draw the dab
- Binds the draw FBO at texture size, disables depth, and sets a **scissor** to
  `umin..umax` (after the first dab) so only touched texels change.
- Clears to mid-grey, then blits the *current* texture into the FBO so paint
  composites over existing content.
- Builds uniforms: `size`, `aspect`, identity `projectionMatrix` / `objectMatrix`,
  `uColor` = `ps.color` with alpha premultiplied by `strength`, `brushCo` =
  screen `mpos`, `radius`, `brushAngle`.
- Gets the brush shader via `getShader(gl, brush)` (see §5) and binds it. If a
  blur FBO is active it enables the `BLUR_MODE` define and binds the blur texture
  + screen-space view box (`vboxMin/Max`, `screenSize`); if the brush has a
  procedural texture it sets `BRUSH_TEX` / `BRUSH_TEX_SPACE` defines and binds the
  texture's uniforms.
- Sets blending
  (`blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ZERO, CONSTANT_ALPHA)` with
  `blendColor` supplying the constant alpha), draws `sm` then `line_sm`, unbinds,
  and calls `texture.swapWithFBO(gl)` to make the painted FBO the new texture.

The trailing `if (haveColor && 0)` block is dead/experimental vertex-color debug
code (gated off with `&& 0`).

---

## 5. Brush shader (`getShader` + `TexturePaintShader`)

`getShader(gl, brush)` clones `ShaderDef.TexturePaintShader`
(`scripts/shaders/shaders.ts`). When the brush has a procedural texture
(`brush.texUser.texture`, a `ProceduralTex`), it splices that texture's generated
GLSL into the fragment source: `tex.genGlslPre(...)` replaces the
`//{BRUSH_TEX_PRE}` marker and `tex.genGlsl(...)` (wrapped in a block scope)
replaces the `BRUSH_TEX_CODE` marker; the result is compiled with `getShader`.
Procedural-texture and blur behavior are further toggled at draw time via shader
`defines` (`BRUSH_TEX`, `BRUSH_TEX_SPACE`, `BLUR_MODE`).

The shader itself is where the "UV-raster / screen-eval" split lives:
- The **vertex** stage sets `gl_Position` from the UV-space `position` (so the
  triangle rasterizes across its UV footprint) but forwards `vSmLoc` (the screen
  position from `sm_loc`), `vWorldCo`, `vScreenCo`, and `vParams` to the fragment
  stage.
- The **fragment** stage computes the circular falloff in **screen space**:
  `dis = length(brushCo.xy - vSmLoc.xy/vSmLoc.w) / radius`, clamped to `[0,1]`,
  multiplied by the facing fade `vParams[0]`, into `c[3]` (alpha). A procedural
  `BRUSH_TEX` block, if enabled, evaluates in world space (`vWorldCo * texScale`)
  and multiplies the result into `c`.

---

## 6. UV wrangler (`getUVWrangler`)

`getUVWrangler(mesh, ...)` (mesh addon's `unwrapping`) builds and caches the
per-loop UV-island structure the dab pass relies on:

- `islandLoopMap` / `loopMap` — loop → island / loop → island-loop lookups.
- `cd_corner` — per-island-corner custom layer holding `corner`, `bTangent`
  (border tangent, used to extrude the seam guard), etc.
- `seamEdge(e)` — whether a mesh edge is a UV seam.

`modalStart` and `exec` call it with rebuild flags set; `execDot` fetches the
already-built cache.

---

## 7. Blur / smear path (`pbvh_texpaint_blur.ts`)

`BrushBlurFBO` is used only when `doBlur` is set. Its `draw()` renders the BVH
nodes' draw geometry into a small square FBO sized to the brush footprint, using
`BrushBlurShader`, which writes `vec4(uv, id, 1)` — i.e. it **bakes the UV
coordinates of the surface currently under the brush into a screen-space patch**.

Key details:
- `update(gl, size)` resizes the FBO to `size × size` and lazily compiles the
  shader (`ShaderProgram.fromDef`).
- `draw(...)` regenerates the camera matrices, computes the screen-space brush
  rectangle in normalized coords (`vboxMin` / `vboxMax`, with `mpos` scaled by
  `devicePixelRatio` and y-flipped), and stores them on the instance for the main
  shader to read.
- The blur **vertex shader** remaps each projected point from the `[vboxMin,
  vboxMax]` screen rectangle into the full FBO (so the brush patch fills it),
  while the **fragment shader** emits `vec4(vUv, vId, 1)`.
- It walks `bvh.nodes` and draws every node's `drawData` (no per-node culling in
  the current code — the aabb/sphere test is commented out); logs
  `"NO DRAW DATA!"` if nothing drew.

The main brush shader, in `BLUR_MODE`, then samples this UV patch (`blurFBO`) to
pull existing texture content along the drag — a smudge/smear effect instead of
stamping flat color.

---

## 8. Undo

Undo **is implemented** — the `console.warn('implement me!')` lines in `undoPre`
and `undo` are stale leftovers, not missing code.

- `undoPre` clears `_tiles` / `_tilemap` at stroke start; tiles are then populated
  during painting by `saveUndoTile` (§4).
- `undo` re-binds the texture's draw FBO, redraws the current FBO, then blits every
  saved `GPUTile` back over the painted region with `blitFramebuffer`, restoring
  the pre-stroke texels, and swaps the FBO back into the texture. It defensively
  retries (up to ~5 s) if the texture isn't `ready` / `glTex` yet.

---

## 9. Notable quirks / debug knobs

- **`window.DDD` / `DD5` / `DD6`** are live-tunable debug globals (declared at the
  top of `pbvh_texpaint.ts`) controlling seam-guard extrusion distance, UV-snap
  offset, and edge inset respectively. Development knobs, not real settings.
- Both files are **WebGL2-only** and reach GL through `_gl`; they are not part of
  the WebGPU/sculptcore rendering path.
- Considerable commented-out experimental code remains (alternate radius formulas,
  the `&& 0` vertex-color debug block, the `line_sm` seam lines, `#if 0` shader
  noise blocks, and the blur node-culling test).
- `execDot` also carries a stray `console.error('BLUR')` and `console.error('NO
  DRAW DATA!')` in the blur path — diagnostic noise, not errors.
