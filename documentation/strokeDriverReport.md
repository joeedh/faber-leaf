# Brush Stroke Driver — Technical Report

How the view3d sculpt tool turns raw pointer/device input into a series of brush
dabs. Covers the driver's layered architecture, stroke-method modes
(PATH / Anchored / Drag Dot), dab spacing, symmetry, device inputs / pen
dynamics, coordinate handling, and the dyntopo / GPU-brush interaction.

---

## Architecture at a glance

The stroke driver is a three-layer stack, deliberately separated so the
geometry-free math is unit-testable in isolation:

| Layer | File | Responsibility |
|---|---|---|
| Pure math | `scripts/util/stroke_math.ts` | Catmull-Rom → Bezier, arc-length walk. No dependencies. |
| Sample generator | `scripts/editors/view3d/tools/stroke_driver.ts` (`BrushStrokeDriver`) | pointer input → evenly-spaced `PaintSample` dabs; raycasting, projection, stroke-method branching. **Does not mirror, does not touch geometry.** |
| Modal ToolOp base | `scripts/editors/view3d/tools/stroke_paint_op.ts` (`StrokeDriverOp`) | modal pointer plumbing, timer tick, View3D adapters. |
| Sculpt ToolOp | `scripts/editors/view3d/tools/sculptcore_ops.ts` (`SculptPaintOp`) | owns the undo/meshlog step, mirroring, dab application into the sculptcore C++/WASM kernel, dyntopo, GPU path. |

The transport object between layers is `PaintSample`
(`scripts/editors/view3d/tools/stroke_base.ts:54`).

```
pointer event ─▶ StrokeDriverOp.on_pointermove ─▶ driver.push (enqueue)
                                                        │
   5ms timer ─▶ flushDriver ─▶ driver.poll ─▶ PaintSample[] (object-local, spaced)
                                                        │
                        SculptPaintOp.applyDab ─▶ primary dab + mirrored dabs
                                                        │
                          applyDabOne ─▶ raycast ─▶ wasmExec.applyDab / GPU.dab
```

---

## 1. Where the driver lives & overall control flow

### Entry (mousedown)
`SculptCorePaintMode.on_mousedown` (`sculptcore.ts:858`). On left-button-down
(no alt) it copies the active brush, resolves shift→smooth / ctrl→eyedropper or
extend, then launches the modal op:
`ctx.api.execTool(ctx, 'sculptcore.paint()', {brush, symmetryAxes})`
(`sculptcore.ts:894`). The ToolOp is registered under `sculptcore.paint`,
`is_modal: true` (`sculptcore_ops.ts:124`).

### The ToolOp that owns a stroke
`SculptPaintOp extends StrokeDriverOp` (`sculptcore_ops.ts:66`);
`StrokeDriverOp` (`stroke_paint_op.ts:39`) is the generic modal base.

### Lifecycle

**Begin — mousedown → step open:**
- `SculptPaintOp.undoPre(ctx)` (`sculptcore_ops.ts:171`) resets per-stroke state
  (`prevDabLocal`, `prevPrimaryDabCenter`, `dabSeed`, `lastDynTopoS = -Infinity`,
  `gpuDecided=false`), pre-increments the process-global non-accumulate generation
  stamp `curStrokeGen = ++nextStrokeGen`, snapshots `symmetryAxes` as an op input,
  then `ensureExecutor(ctx)` + `exec.beginStep(hasDyntopo)` — the **beginStep**
  boundary that opens the shared C++ `MeshLog` undo step (stores `logStepId`).
- `StrokeDriverOp.modalStart(ctx)` (`stroke_paint_op.ts:182`) constructs the
  `BrushStrokeDriver` with all adapters and starts a `setInterval(…, 5)` timer
  that drives `timer_on_tick → flushDriver`.

**Per-move sampling — mousemove:**
- `StrokeDriverOp.on_pointermove(e)` (`stroke_paint_op.ts:228`) stores
  `lastEvent`, converts the event to a `StrokeInput` (`toStrokeInput`) and
  `driver.push(...)` — **enqueue only**, no synchronous sampling.
- The 5 ms timer calls `flushDriver()` (`stroke_paint_op.ts:216`):
  `for (const ps of driver.poll()) { inputs.samples.push(ps); applyDab(ctx, ps, e) }`.
  Sampling (`poll`) is thus decoupled from input arrival and batched on the tick.

**Dab emission:** `SculptPaintOp.applyDab` (`sculptcore_ops.ts:364`) → primary
`applyDabOne(...,0)` plus one `applyDabOne` per symmetry mirror.

**End — mouseup → flush trailing + close step:**
- `StrokeDriverOp.on_pointerup(e)` (`stroke_paint_op.ts:236`): `driver.end()`,
  a synchronous `flushDriver()` to apply the trailing spline segment, then
  `modalEnd(false)`.
- `SculptPaintOp.modalEnd` (`sculptcore_ops.ts:741`) → `finishStroke` →
  `finishStrokeTail` (`:767`): commits any preview dab, ends the dyntopo stroke,
  optional auto-defrag, then `executor.endStep()` — the **endStep** boundary that
  closes the meshlog step.
- Escape cancels (`driver.reset()` + `modalEnd(true)`); Enter/Space commit.

**Non-modal replay:** `SculptPaintOp.exec(ctx)` (`sculptcore_ops.ts:814`) replays
the stored `inputs.samples` through `applyDab`, then `finishStroke`. This is how
undo/redo re-execution and the headless test harness run.

### The driver poll loop
`BrushStrokeDriver.poll()` (`stroke_driver.ts:201`):
1. Snapshots the camera `rendermat`/size and inverts it.
2. Snapshots the object matrix and builds `_iobmat` (world→local), `_iobmatDir`
   (translation-cleared, for directions), `_localRendermat` (local→clip),
   `_localIrendermat`.
3. Drains `inQueue` through `ingest()`.
4. If `ended`, calls `flush()` (trailing segment) and sets `done=true`.

---

## 2. Stroke spacing / dab emission

Spacing lives in the PATH path only, in `emitSegment` (`stroke_driver.ts:445`):

- Each fully-determined Catmull-Rom segment becomes a cubic Bezier in **both**
  screen and world space via `crToBezier(p0,p1,p2,p3, ALPHA=0.5)` — centripetal
  Catmull-Rom, which avoids cusps/loops on jittery input.
- Spacing distance:
  - **SCREEN mode:** `spacingDist = max(spacing * 2 * radiusPx, 1e-5)`.
  - **WORLD mode:** converts the screen-px radius to world units at the segment
    midpoint (`worldRadiusAt`), then `spacingDist = max(spacing * 2 * worldRadius,
    1e-5)`.
  - So **spacing is a fraction of brush diameter** (`spacing × 2 × radius`);
    `brush.spacing` is that fraction.
- Even spacing comes from `arcLengthWalk(drivingB, spacingDist, walkCarry)`
  (`stroke_driver.ts:469`); the returned `carryOut` is stored so cadence is
  **continuous across abutting segments** (no clustering at joints).
  `arcLengthWalk` (`stroke_math.ts:151`) approximates arc length with 32 straight
  chords and interpolates the parameter within a chord.
- For each emitted `t`, `emitSegment` interpolates world/screen position and
  normal, accumulates `strokeS += spacing`, computes deltas + travel angle from
  the previous sample, and stores a per-dab world-curve slice
  `ps.curve = subCubic(worldB, t ± 0.15)` (used by oriented falloffs).

### First dab & lookahead
- The first control point emits one **raw, non-interpolated** dab immediately
  (`emitRaw`, `isInterp=false`).
- A 1-segment lookahead gates the rest: a segment is only emitted once its right
  neighbor exists, because centripetal Catmull-Rom needs the next point to define
  the tangent.
- `flush()` emits the final trailing segment with `rightClamp=true` (duplicates
  the last point) when the stroke ends.

---

## 3. Stroke methods / modes

### Enums
`StrokeMethod` (`scripts/brush/brush_base.ts:61`):
```
PATH     = 0   // arc-length Catmull-Rom/Bezier walk (default)
ANCHORED = 1
DRAG_DOT = 2
```
`AnchoredLiveMode` (`brush_base.ts:71`): `RADIUS = 0`, `ANGLE = 1`.

These are per-brush settings (`scripts/brush/brush.ts`, defaults `PATH` /
`RADIUS`). GRAB and KELVINLET brushes default to `ANCHORED`; Snake Hook stays on
`PATH` deliberately. `SculptPaintOp.getStrokeMethod()` reads `brush.strokeMethod`
(`sculptcore_ops.ts:289`); `getAnchoredLiveMode()` reads `brush.anchoredLiveMode`.

### Per-method branching
`BrushStrokeDriver.ingest` (`stroke_driver.ts:245`), `method = strokeMethod ??
PATH`. The three modes fork:

**PATH** — falls through to the spline machinery (§2): arc-length walked,
spacing-gated.

**ANCHORED** — `ingestAnchored` (`:340`) + `emitAnchored` (`:397`):
- The first input establishes `anchorCP` and emits there; it **requires a real
  surface hit** (cannot start over empty space).
- Every later input re-emits **one dab pinned at the anchor** (never
  arc-length-walked; one input = one dab).
- Post-anchor, later inputs project onto the **plane through the anchor facing the
  camera as it was at anchor time** (`projectOntoAnchorPlane`, using
  `anchorCP.viewvec` as the plane normal) — so the drag tracks the view plane, not
  the deforming surface (important for Grab / Kelvinlet).
- The live drag rides on the sample: `ps.anchorVec` = object-local
  anchor→cursor vector. Per `anchoredLiveMode`: `ANGLE` sets
  `ps.liveAngle = atan2(dy,dx)`; `RADIUS` sets `ps.radius = dragPx` (screen-space
  drag length). So **radius/rotation grows with drag distance, dab pinned at the
  initial point.**

**DRAG_DOT** — `emitDot` (`:431`): one dab centered on the **live cursor** per
input (follows the cursor), non-interpolated, no arc-length walk, no compounding.
Tracks `previewCP` for the overlay.

`flush()` early-returns for non-PATH methods — there is no trailing spline.

### The "no-compounding" invariant
Compounding avoidance is enforced **downstream** in `applyDabOne` via a
preview/rollback mechanism, not in the driver. For any non-PATH method
(`doPreview = strokeMethod !== PATH`, `sculptcore_ops.ts:685`):
- Before applying a new dab, if a preview is active,
  `wasmExec.rollbackPreviewDab()` undoes the previous provisional dab.
- The new dab is applied inside `beginPreviewDab` / `extendPreviewDab`, so it too
  is provisional.
- Only at stroke end does `finishStrokeTail` call `commitPreviewDab()` to keep the
  final one.

Result: at any moment only the **current** live dab exists — never the sum of all
intermediate dabs.

**Regression test:** `tests/integration/sculptcore_anchored_dragdot.test.ts`. It
runs a "direct" stroke (2 points, straight to the final position) vs. a "wander"
stroke (5 points through unrelated intermediates ending at the **same** final
point), for both Grab (ANCHORED) and Clay + `strokeMethod:2` (DRAG_DOT). The
checksum is the sum of squared vertex-position magnitudes. Invariants:
- The direct drag measurably displaces the mesh (`> 1e-4`).
- **`|wander.after − direct.after| < directDelta × 0.1`** — the wandering stroke
  lands in the same final state; if rollback were broken, the four extra dabs
  would compound and the wander result would be far larger.
- Undo restores the original state for both.

---

## 4. Symmetry handling

Symmetry is applied **on the TS side in `SculptPaintOp`, after the driver** — the
driver explicitly does not mirror.

- Axis bitflag `{X:1, Y:2, Z:4}` is a `FlagProperty` op input
  (`stroke_paint_op.ts:66`), snapshotted from the toolmode in `undoPre` and read
  back via `getSymmetryAxes` (`sculptcore_ops.ts:410`).
- The mirror table `SymAxisMap` (`stroke_base.ts:351`) maps each of the 8 axis-bit
  combinations to a list of per-component sign-flip `Vector3`s (e.g. X →
  `[[-1,1,1]]`; X+Y+Z → 7 reflections covering all octants).
- `applyDab` (`sculptcore_ops.ts:387`) applies the primary dab, then for each
  `muls[i]` in `SymAxisMap[sym]` calls `applyDabOne(ctx, ps, muls[i], i+1)`.
- `applyDabOne` copies the sample and reflects it: `ps = ps.copy();
  ps.mirror(mirrorFlips)`.
- `PaintSample.mirror(mul)` (`stroke_base.ts:241`) multiplies positions
  (`p`, `dp`, `origp`), **folds `diag(mul)` into `rendermat`** (so the per-pixel
  radius stays flip-invariant), re-derives mirrored `screenP` / `dScreenP`, flips
  all direction vectors (`viewvec`, `viewPlane`, `vieworigin`, `vec`, `dvec`,
  `anchorVec`) and angles by the product of signs, and toggles `mirrored`.
- After reflecting, `applyDabOne` re-raycasts the mesh to snap the mirrored center
  onto the surface (except ANCHORED, which uses the resolved `ps.p` / `ps.vec`
  directly).

Per-mirror state is kept separate so images don't cross-contaminate:
`prevDabLocal[mirrorIdx]` for Snake grab deltas, `_dabDynTopoDue` shared so all
sides remesh together, and `curStrokeDir` reflected per image for the oriented Box
falloff.

> **Note:** this path implements **plane-mirror symmetry only** (X/Y/Z and their
> combinations via `SymAxisMap`). There is no radial / angular-count symmetry.

---

## 5. Device inputs / pen dynamics

### Raw event → StrokeInput
`StrokeDriverOp.toStrokeInput(e)` (`stroke_paint_op.ts:129`) pulls `pressure`
(`e.pressure` for pen/touch, else `1.0`), `tiltX`, `tiltY`, `twist`
(`e.twist ?? 0`), pre-resolves `invert` (ctrl + `BrushFlags.INVERT`) and
`useAltBrush` (ctrl for polygroup, else shift).

### Pressure → params (radius / strength / spacing)
`StrokeDriverOp.makeParamProvider()` (`stroke_paint_op.ts:149`) returns a
`StrokeParamProvider` closure that, per pressure value, evaluates each
brush-dynamics channel:
`getchannel(key,val) = ch.useDynamics ? val * ch.curve.evaluate(pressure) : val`
for `radius`, `strength`, `spacing`, `color`. The driver calls this per control
point, so **pressure maps to radius/strength/spacing multiplicatively via the
brush's per-channel `Curve1D`**, evaluated in TS. Params are interpolated per dab
in `makeSample`.

### Per-dab device samples into the WASM kernel
`pushBrushDeviceInputs(wasmBrush, ps)` (`sculptcore_bindings.ts:120`), called each
dab, pushes device inputs into the C++ dynamics stack:
`PRESSURE = ps.pressure`, `TILTX = tiltX/90`, `TILTY = tiltY/90`,
`TWIST = twist/360`. (Only PRESSURE is currently consumed; tilt/twist are pushed
but inert until a channel maps to them.) `DeviceType`
(`sculptcore_bindings.ts:12`) mirrors the C++ enum: PRESSURE, TILTX, TILTY, SPEED,
ANGLE, CURVATURE, TWIST.

### The 32-sample curves
`configureBrushDynamics(...)` (`sculptcore_bindings.ts:66`) runs **once per
stroke** when the brush is freshly built. For each dynamic channel
(`strength` / `radius` / `autosmooth`) it adds a `PRESSURE` device with `MULTIPLY`
mix and **bakes the channel's `Curve1D` into a 32-entry lookup table**
(`DYN_CURVE_SAMPLES = 32`): loop `i in 0..31`, `x = i/31`,
`y = ch.curve.evaluate(x)`, `setPropDynamicSample(propId, PRESSURE, i, 32, y)`.
This is the C++-side replacement for the TS `getchannel` curve eval. A second pass
does the same for per-kernel scalar uniforms enumerated from the C++ manifest
(`queryUniformManifest` → `addUniformDynamic` / `setUniformDynamicSample`).

So pen dynamics are applied **twice by design**: the TS `makeParamProvider` (base
radius/strength/spacing, which drive spacing math and dab size) and the baked
32-sample C++ device curves (which drive the deform strength/radius/uniforms
inside `loadProps`).

---

## 6. Coordinate handling

### Space modes
`StrokeSpaceMode` (`stroke_driver.ts:43`): `SCREEN` / `WORLD`. `SculptPaintOp`
uses the default `SCREEN`.

### Projection adapter
`StrokeDriverOp.makeProjection()` (`stroke_paint_op.ts:168`) wraps View3D:
`project`, `unproject`, `getViewVec`, `getLocalMouse`, `cameraPos`
(`view3d.activeCamera.pos`), `rendermat`, `glSize`, `size`.

### Per-input raycast
In `ingest`: screen pos from `getLocalMouse`, view ray dir from `getViewVec`,
origin from `cameraPos`. For PATH/DRAG_DOT it casts `rayCast(origin, dir)`. On a
miss after a prior hit, `synthesizeMiss` projects the last hit onto the
camera-facing plane at the cursor. ANCHORED post-anchor uses
`projectOntoAnchorPlane` instead (§3).

### The mesh raycast
`SculptPaintOp.makeRayCast()` (`sculptcore_ops.ts:326`) transforms the world
origin/dir into object-local (inverse object matrix; directions use a
translation-cleared inverse), calls `mesh.rayCast(o, d)`, and transforms the hit
`p` / `normal` back to world.

### Object-local emission
`getObjectMatrix()` (`sculptcore_ops.ts:316`) returns the object's local→world
matrix, so the driver emits **object-local** PaintSamples: `makeSample`
(`stroke_driver.ts:565`) converts position via `_iobmat`, directions via
translation-free `_iobmatDir` (then re-normalized), `vieworigin` = camera pos in
local, and `rendermat`/`irendermat` = local→clip / clip→local — so a screen-px
radius measured against them lands in object units. This lets `applyDabOne`
raycast the mesh directly without a per-dab world↔local conversion.

### Per-dab frame in applyDabOne
(`sculptcore_ops.ts:441`) `viewvec` from `ps.viewvec`; for non-ANCHORED it
re-raycasts `mesh.rayCast(vieworigin, viewvec)` for the definitive surface `p`,
`normal`, `isectFace`. World-units-per-pixel `dist` is computed by projecting `p`
and a +1px offset and unprojecting, then `radius = brush.resolveWorldRadius(radius,
dist)`. The dab **normal** for plane-family brushes may be swapped to the view
vector via `resolvePlaneDabNormal(...)`. Stroke tangent `strokeDir` (from
consecutive primary centers, mirror-reflected) feeds the oriented Box/wing
falloff.

---

## 7. Interaction with dyntopo & the GPU brush path

### CPU vs GPU decision
Decided **once per stroke, on the first primary dab**
(`mirrorIdx === 0 && !gpuDecided`, `sculptcore_ops.ts:651`) via
`GpuStrokeController.tryBegin(...)` (`sculptcore_gpu_stroke.ts:186`). `tryBegin`
returns undefined (→ CPU) unless:
- Feature flag `sculptcore.gpu_brush` (or `…_verify` shadow) is on.
- Modal (or debug non-modal allowed).
- **Dyntopo disabled and autosmooth == 0** (GPU is incompatible with both).
- Brush kernel is KELVINLET or GRAB only (GRAB additionally needs
  `sculptcore.gpu_brush_grab` unless shadow).
- A live WebGPU device exists and `GpuBrush_beginStroke` succeeds.

If chosen, each dab routes through `gpu.dab(center, normal, radius, filterRadius,
mirrorIdx, nonAccum)`; if GPU init fails before any dispatch it aborts and the
whole stroke falls back to CPU. The CPU `wasmExec.applyDab` is skipped unless
`!gpu || gpu.shadow`. **Shadow-verify mode** keeps the CPU authoritative and runs
the GPU in parallel to diff per dab. Finalization is async (`mapAsync` readback):
`finishStroke` awaits `gpuCompletion` and chains undo/redo onto it.

### Dyntopo "due" per dab
(`sculptcore_ops.ts:550`) Dyntopo runs at its own `dynTopoSpacing` along the
stroke, not every dab, and only if `dt.enabled && !mesh.multiresActive` (multires
forces it off). The remesh-due decision:
```
dynTopoDue = mirrorIdx === 0
  ? (ps.strokeS - lastDynTopoS >= dt.dynTopoSpacing)
  : this._dabDynTopoDue
```
It is decided **once on the primary dab** and cached in `_dabDynTopoDue` so every
mirror image remeshes on the same samples (otherwise the primary would consume the
spacing budget and starve the mirror sides). When due, it resolves edge goals,
builds `DynTopoParams` via `configureDynTopoParams`, and advances
`lastDynTopoS = ps.strokeS`. The pre-pass, node filter, deform, and topo-chunk
seal all run inside the single `wasmExec.applyDab(prog, center, normal,
filterRadius, params ?? 0, dtEnabled ? dabSeed++ : 0)` call — `dabSeed` drives
dyntopo's independent-set selection. A stroke-long topology thaw is released at the
end via `endDynTopoStroke()`.

---

## Key file / symbol index

- `scripts/util/stroke_math.ts` — `crToBezier:52`, `evalCubic:90`, `subCubic:127`, `arcLengthWalk:151`
- `scripts/editors/view3d/tools/stroke_driver.ts` — `BrushStrokeDriver:118`, `poll:201`, `ingest:245`, `ingestAnchored:340`, `flush:349`, `emitRaw:380`, `emitAnchored:397`, `emitDot:431`, `emitSegment:445`, `worldRadiusAt:513`, `projectOntoAnchorPlane:549`, `makeSample:565`; `StrokeSpaceMode:43`
- `scripts/editors/view3d/tools/stroke_paint_op.ts` — `StrokeDriverOp:39`, `toStrokeInput:129`, `makeParamProvider:149`, `makeProjection:168`, `modalStart:182`, `flushDriver:216`, `on_pointermove:228`, `on_pointerup:236`
- `scripts/editors/view3d/tools/sculptcore_ops.ts` — `SculptPaintOp:66`, `undoPre:171`, `getStrokeMethod:289`, `getObjectMatrix:316`, `makeRayCast:326`, `applyDab:364`, `applyDabOne:423`, dyntopo-due `:550`, GPU decision `:651`, preview/rollback `:685`, `finishStrokeTail:767`, `exec:814`
- `scripts/editors/view3d/tools/sculptcore_bindings.ts` — `DeviceType:12`, `DYN_CURVE_SAMPLES:43`, `configureBrushDynamics:66`, `pushBrushDeviceInputs:120`, `buildBrushProgram:210`, `configureDynTopoParams:339`, `builSculptcoreBrush:359`
- `scripts/editors/view3d/tools/sculptcore_gpu_stroke.ts` — `tryBegin:186`, `dab:432`, `finish:518`
- `scripts/editors/view3d/tools/stroke_base.ts` — `PaintSample:54`, `mirror:241`, `SymAxisMap:351`
- `scripts/editors/view3d/tools/sculptcore.ts` — `on_mousedown:858`, `drawBrush:936`
- `scripts/brush/brush_base.ts` — `StrokeMethod:61`, `AnchoredLiveMode:71`
- `tests/integration/sculptcore_anchored_dragdot.test.ts` — the no-compounding regression test

---

## Notable design points

- The driver is deliberately **geometry- and mirror-agnostic**; all reflection,
  undo, kernel dispatch, and dyntopo live in `SculptPaintOp`.
- Spacing = `brush.spacing × 2 × radius` with cross-segment carry, so cadence is
  uniform along the whole path.
- ANCHORED / DRAG_DOT bypass the spline entirely (one input = one dab) and rely on
  **preview/rollback** for no-compounding; PATH uses the arc-length walk.
- Symmetry is **plane-mirror only** (X/Y/Z + combinations via `SymAxisMap`); there
  is no radial/angular symmetry in this path.
- Pen dynamics are applied twice by design: the TS-side param provider (spacing +
  dab size) and the C++-side baked 32-sample device curves (deform
  strength/radius/uniforms inside `loadProps`).
