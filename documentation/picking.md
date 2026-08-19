# Viewport picking

Picking (click-select, brush/circle select, box select, transform snapping) is
**geometric** and **addon-owned**: each object type implements its own picking
as overridable methods on its `SceneObjectData` subclass, and core walks the
visible objects and dispatches to them. There is no GPU id-buffer.

> Historical note: picking used to render object/element ids into an offscreen
> `GPUSelectBuffer` (`gl.readPixels`) and sample it. That was WebGL-only, so it
> died when the realtime renderer went WebGPU-only (see
> [rendering.md](rendering.md)). It and the old `FindnearestClass` registry
> (`findnearest_mesh.ts` / `findnearest_object.ts`) have been deleted.

## The SceneObjectData picking API

Four overridable instance methods on `SceneObjectData`
(`scripts/sceneobject/sceneobject_base.ts`):

```ts
castViewRay(ctx, view3d, object, selectMask, mpos: Vector2): FindNearestRet[] | undefined
findNearest(ctx, view3d, object, selectMask, mpos: Vector2, limit): FindNearestRet[] | undefined
castScreenCircle(ctx, view3d, object, selectMask, mpos: Vector2, radius): ScreenPickResult
castScreenRect(ctx, view3d, object, selectMask, min: Vector2, max: Vector2): ScreenPickResult
```

- `object` is the owning `SceneObject` (data has no transform of its own — read
  `object.outputs.matrix.getValue()` for the world matrix).
- `mpos` / `min` / `max` are **view-local screen coordinates** (see
  `View3D.getLocalMouse`).
- `selectMask` is a `SelMask` bitfield (`scripts/editors/view3d/selectmode.ts`);
  the method decides what to honor (object bits vs `SelMask.GEOM`).

| Method | Returns | `dis` metric | Used by |
|---|---|---|---|
| `castViewRay` | nearest single surface hit | distance from camera along the ray | transform surface-snap, view ops |
| `findNearest` | nearest element(s) near a point | screen-space pixel distance | click select (object + mesh-edit) |
| `castScreenCircle` | all elements within `radius` px | — | brush/circle select |
| `castScreenRect` | all elements inside the screen rect | — | box select |

`FindNearestRet` and `ScreenPickResult` are defined in
`scripts/editors/view3d/findnearest.ts` (and re-exported from `@framework/api`).
`ScreenPickResult` is three parallel arrays:

```ts
interface ScreenPickResult {
  elements: unknown[]          // Element[] (mesh) | int indices (LiteMesh) | SceneObject (base)
  elementObjects: SceneObject[]
  elementDists: number[]
}
```

`elements` is `unknown[]` on purpose: core must not depend on the mesh addon's
`Element` type. Each consumer narrows it locally.

## The core dispatcher

`scripts/editors/view3d/findnearest.ts` exports two thin dispatchers:

- **`FindNearest(ctx, selectMask, mpos, view3d?, limit)`** — walks
  `view3d.sortedObjects`, calls `ob.data.findNearest(...)` on each, concatenates,
  and **sorts by `dis` ascending** so `[0]` is the nearest hit across all objects.
- **`castViewRay(ctx, selectMask, mpos, view3d?, mode?)`** — same walk via
  `ob.data.castViewRay(...)`, then returns the single closest positive-`dis` hit.
  (`mode`/`CastModes` is retained only for call-site compatibility; picking is
  always geometric now.)

The dispatcher does **not** pre-filter by object type — it calls the method on
every visible object and lets the method gate on `selectMask` itself. This is
what lets a single `Mesh` respond to both object-mode (`SelMask.MESH`) and
edit-mode (`SelMask.GEOM`) picking through one set of methods.

`brush`/`box` select ops call `mesh.castScreenCircle` / `mesh.castScreenRect`
**directly** on the active mesh (they already know the object), not through the
dispatcher.

## Base-class defaults (free object-level picking)

The `SceneObjectData` base implements all four methods using
`getBoundingBox()` + the projected origin, gated on the data's own
`dataDefine().selectMask` (via `_ownSelectMask()`):

- `castViewRay` — ray vs the world AABB (`aabb_ray_isect`); hit point = box
  center, `dis` = distance along the ray.
- `findNearest` — min screen distance from `mpos` to the projected origin + the
  8 projected AABB corners; a hit if within `limit`.
- `castScreenCircle` / `castScreenRect` — projected origin inside the
  circle/rect; returns the object itself as the single element.

So **any object type with a sensible bounding box is pickable with zero bespoke
code** — Light, NullObject, Camera, and StrandSet all rely on this. They only
need a correct `selectMask` in `dataDefine()` (this is why `Light` now declares
`SelMask.LIGHT` instead of `0`).

## LeafMesh picking — the brute-force path

`LeafMeshData` (`addons/builtin/leafmesh/src/leafmesh.ts`) overrides all four
methods and delegates each to `pick.ts`. That file does unprojection and result
packing only; the geometry itself is in `pick_geom.ts`, which imports nothing
from `scripts/` and is unit-tested directly:

- **`castViewRay`** unprojects the cursor to an object-local ray and calls
  `rayCastMesh`, which walks the triangulation cache.
- **`castScreenCircle`** projects each element's representative point straight
  from object-local to screen (`localProjector` — no world-space round trip)
  and keeps what lands inside the radius.
- **`castScreenRect`** runs the same containment test against the rect, ordered
  by distance from its centre.
- **`findNearest`** reduces that same circle query to the nearest hit per
  requested domain — so click-select and brush-select agree by construction —
  plus an object-level hit when `selectMask & SelMask.OBJECT`.

All four early-out unless `selectMask` addresses this object, and the domains
queried are derived from the mask, so object-mode picking returns only the
OBJECT-level hit (not stray face hits).

The queries are brute force deliberately: LeafMesh declines the spatial
capability rather than faking one, and the contract exposes queries and never
structures — so an acceleration tree can be added later without a caller
noticing.

### Frustum primitives

Box select needed real frustum intersection, which didn't exist before:

| Where | What |
|---|---|
| `scripts/util/frustum.ts` | `point_in_frustum`, `aabb_frustum_isect` (p-vertex test), `tri_frustum_isect` (conservative SAT over the 6 planes). Dependency-free so it unit-tests in isolation. |
| `scripts/util/isect.ts` | re-exports the above (and is the home of the existing cone tests `aabb_cone_isect` / `tri_cone_isect`). |

A frustum is an array of `Vector4` plane equations `[nx,ny,nz,d]` with **inward**
normals; a point is inside when `dot(n,p)+d >= 0` for every plane. A plane is
fitted to each of the 6 faces of the unprojected corner box and each normal
flipped so the 8-corner centroid is on its positive side, so plane
winding/order never has to be reasoned about.

No pick path calls these TS helpers today: LiteMesh builds its planes in C++
(`buildScreenRectPlanes`, below) and LeafMesh tests screen-space containment
instead. They stay as the reference the C++ side is checked against, and they
unit-test in isolation (`tests/unit/isect_frustum.test.ts`).

## Selection operators

| Op | File | Calls |
|---|---|---|
| `SelectCircleLeafMeshOp` (brush) | `addons/builtin/leafmesh/src/select_ops.ts` | `data.castScreenCircle(...)` |
| `SelectBoxLeafMeshOp` (element box) | `addons/builtin/leafmesh/src/select_ops.ts` | `data.castScreenRect(...)` |
| `SelectNearestLeafMeshOp` (element click) | `addons/builtin/leafmesh/src/select_ops.ts` | `data.findNearest(...)` |
| `ObjectBoxSelectOp` (object box) | `scripts/sceneobject/selectops.js` | `ob.data.castScreenRect(...)` for every visible object |
| `ObjectSelectOneOp` (click) | `scripts/sceneobject/selectops.js` | via `FindNearest` |

Element ops register from their addon's `register(api)` hook
(`api.registerAll(..., ...LEAFMESH_SELECT_OPS, ...)`). The object box-select
tool is reachable via `StandardTools.BoxSelect` → `object.select_box`.

Both box ops are modal: `on_mousedown` records the drag start, `on_mousemove`
redraws the rubber-band rectangle, `on_mouseup` samples once and ends.

## LiteMesh / sculptcore SpatialTree (native + WASM)

`LiteMesh` (`scripts/lite-mesh/litemesh.ts`) wraps a sculptcore `Mesh` +
`SpatialTree` and overrides `castScreenCircle` / `castScreenRect` to call the
C++ tree. The same cone (circle) and frustum (rect) math runs natively:

- **C++** (`sculptcore/source/spatial/`): `SpatialTree::castScreenCircle(co, ray,
  r1, r2, faces, verts)` and `castScreenRect(near0..far3, faces, verts)`.
  `SpatialNode::collect{Cone,Frustum}{Faces,Verts}` walk the tree gated by
  `aabbConeIsects` / `aabbFrustumIsects` (litestl `math/geom.h`). Face indices
  are deduped (a face spans two tris). The frustum planes are built + auto-oriented
  in C++ (`buildScreenRectPlanes`).
- **Marshaling** (see [native-napi-electron.md](native-napi-electron.md)): the
  cone endpoints and the 8 rect corners cross as individual bound `float3`s
  (float3 *arrays* can't cross the WASM boundary); face/vert results come back as
  `Vector<int>` out-params. On WASM the binding runtime constructs the int
  vectors; the native N-API backend constructs them via `makeIntVector`
  (`source/napi/`), recovered the same way `makeNodeVector` recovers
  `Vector<SpatialNode*>`. Both backends read the result with
  `getBoundVector`.

`LiteMesh.castScreenRect` is also what makes a LiteMesh respond to the
object-level box-select walk.

## Adding picking to a new object type

1. Give the data's `dataDefine()` a `selectMask` bit (a `SelMask.*` value) so the
   base gate lets it through.
2. If a correct `getBoundingBox()` is enough, you're done — the base defaults
   give object-level ray/click/circle/rect picking for free.
3. For per-element picking, override the relevant methods and return
   `FindNearestRet[]` / `ScreenPickResult`. Keep the addon's element type out of
   core: store it in `ScreenPickResult.elements` (typed `unknown[]`) and narrow
   in the addon's own ops.

## Tests

- `tests/unit/isect_frustum.test.ts` — the frustum predicates over a known unit
  box (point/aabb/tri, in/out/straddle/wrap cases) plus cone regressions.
- `sculptcore/tests/test_spatial_pick.cc` (GTest) — `SpatialTree`
  `castScreenCircle` / `castScreenRect` over a unit grid: cone hits, frustum
  sub-rect / whole-grid / outside / degenerate cases. Run with
  `node make.mjs test test_spatial_pick`.

The JS BVH `facesInFrustum` / `facesInCone` traversal can't be unit-tested in the
jsdom harness (it drags in vectormath/three/path.ux); the C++ GTest covers the
equivalent tree traversal, and the frustum/cone math is shared logic verified by
the isect unit test.
