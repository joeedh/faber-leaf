import {Icons} from '../editors/icon_enum.js'
export {BrushDynamics} from './brush_dynamics'
import {SculptTools} from './brush_enums'
export * from './brush_enums'

export const BrushSpacingModes = {
  NONE: 0,
  EVEN: 1,
}

/** Unit `SculptBrush.radius` is expressed in. SCREEN pixels scale with the view
 * (zooming changes the sculpted footprint); WORLD units are mesh-space and stay
 * fixed. Resolved per dab by `SculptBrush.resolveWorldRadius`. */
export enum BrushRadiusModes {
  SCREEN = 0,
  WORLD = 1,
}

/** How the color paint brush blends its color onto the vertex color layer.
 * Values MUST match the `mixMode` switch in color.sbrush. MIX reproduces the
 * original straight lerp. */
export enum ColorMixModes {
  MIX = 0,
  MULTIPLY = 1,
  SCREEN = 2,
  OVERLAY = 3,
  DIFFERENCE = 4,
  ADD = 5,
  SUBTRACT = 6,
  DARKEN = 7,
  LIGHTEN = 8,
}

/* How the stroke driver turns pointer input into dabs. Path (default) is the
 * existing arc-length Catmull-Rom/Bezier walk. Anchored fixes the dab origin
 * on the first input and re-derives a live radius or angle from the drag
 * vector on every subsequent input (see anchoredLiveMode) — it replaces the
 * old bespoke grabAnchor mechanism and unifies Grab/Kelvinlet/Snake Hook onto
 * one anchor implementation. DragDot follows the live cursor, emitting one
 * rollback-able preview dab per pointer move. */
export enum StrokeMethod {
  PATH = 0,
  ANCHORED = 1,
  DRAG_DOT = 2,
}

/* For StrokeMethod.ANCHORED, which scalar the drag vector's length/angle
 * drives live: RADIUS scales the brush radius by drag distance, ANGLE maps the
 * drag vector's screen-space angle onto a rotation (e.g. a twist-style tool).
 * Only consulted when the brush sets `anchoredDragRadius`; otherwise the drag
 * drives the angle alone and the brush keeps its own radius. */
export enum AnchoredLiveMode {
  RADIUS = 0,
  ANGLE = 1,
}

export enum BrushFlags {
  SELECT = 1,
  SHARED_SIZE = 2,
  DYNTOPO = 4,
  INVERT_CONCAVE_FILTER = 8,
  MULTIGRID_SMOOTH = 16,
  PLANAR_SMOOTH = 32,
  CURVE_RAKE_ONLY_POS_X = 64, //for debugging purposes, restrict curavture raking to one side of the mesh
  INVERT = 128,
  LINE_FALLOFF = 256,
  SQUARE = 512,
  USE_LINE_CURVE = 1024,
  /* Accumulate deformation across passes within a stroke (Blender "Accumulate
   * on"). CLEAR (the default) = non-accumulate: each pass measures from the
   * vertex's stroke-start position so repeated passes converge. See
   * sculptcore/documentation/plans/nonAccumMode.md. Deform brushes only. */
  ACCUMULATE = 2048,
  /* Cavity automasking: scale brush strength by a per-vertex local-convexity
     factor (masks convex bumps by default). See sculptcore automask.h and
     documentation/plans/2026-07-14-2007-cavity-automasking.md. */
  AUTOMASK_CAVITY = 4096,
  /* Invert cavity automasking (mask concavities instead of convexities). */
  AUTOMASK_CAVITY_INVERT = 8192,
  /* Reshape the cavity factor through `cavityCurve` instead of the linear remap. */
  AUTOMASK_CAVITY_CURVE = 16384,
  /* View-normal automasking: fade geometry whose normal turns edge-on to the
     camera, which is where a dab otherwise tears the silhouette. See
     documentation/plans/2026-07-25-1138-view-normal-automasking.md. */
  AUTOMASK_VIEW_NORMAL = 32768,
  /* Also drop geometry facing away from the view instead of fading it
     symmetrically with the front-facing side. The brush-local value; whether it
     or the tool mode's scene-wide toggle is the one that counts is decided by
     SHARED_CULL_BACKFACES. */
  CULL_BACKFACES = 65536,
  /* Read backface culling from the tool mode's scene-wide toggle rather than
     this brush's own CULL_BACKFACES (the SHARED_SIZE pattern, for culling). */
  SHARED_CULL_BACKFACES = 131072,
}

export enum DynTopoModes {
  SCREEN = 0,
  WORLD = 1,
}

export enum DynTopoFlags {
  SUBDIVIDE = 1,
  COLLAPSE = 2,
  ENABLED = 8,
  FANCY_EDGE_WEIGHTS = 16,
  QUAD_COLLAPSE = 32,
  ALLOW_VALENCE4 = 64,
  DRAW_TRIS_AS_QUADS = 128,
  ADAPTIVE = 256,
}

export enum DynTopoOverrides {
  //these are mirrored with DynTopoFlags
  SUBDIVIDE = 1,
  COLLAPSE = 2,
  //4 used to be INHERIT_DEFAULT, moved to DynTopoOverrides.NONE
  ENABLED = 8,
  FANCY_EDGE_WEIGHTS = 16,
  QUAD_COLLAPSE = 32,
  ALLOW_VALENCE4 = 64,
  DRAW_TRIS_AS_QUADS = 128,
  ADAPTIVE = 256,
  //end of DynTopoFlags mirror

  //these mirror properties instead of flags
  VALENCE_GOAL = 1 << 16,
  EDGE_SIZE = 1 << 17,
  DECIMATE_FACTOR = 1 << 18,
  SUBDIVIDE_FACTOR = 1 << 19,
  MAX_DEPTH = 1 << 20,
  EDGE_COUNT = 1 << 21,
  NONE = 1 << 22,
  REPEAT = 1 << 23,
  SPACING_MODE = 1 << 24,
  SPACING = 1 << 25,
  EDGEMODE = 1 << 26,
  SUBDIV_MODE = 1 << 27,
  EVERYTHING = ((1 << 27) - 1) & ~(1 << 22), //all flags except for NONE
}

export enum SubdivModes {
  SIMPLE = 0,
  SMART = 1,
}

// --- Sculptcore dynamic-topology settings (DynTopoSettingsSC) -----------------
// These back the sculptcore-native dyntopo path (brush_dyntopo_sc.ts), distinct
// from the legacy pbvh DynTopo* enums above. The mode enum mirrors the C++
// `sculptcore::dyntopo::DynTopoMode` int values so it maps 1:1 onto
// DynTopoParams.mode.

// How the per-dab target edge length (l_max) is resolved in TS. l_min is then
// l_max * collapseRatio. See DynTopoSettingsSC.resolveEdgeGoal.
export enum DynTopoEdgeModeSC {
  WORLD = 0, // edgeSize is a world-space (object-local) length
  PERCENT = 1, // edgeSize is a percentage of the brush radius
  PIXELS = 2, // edgeSize is a multiple of the projected pixel size at the dab
}

// Mirrors sculptcore::dyntopo::DynTopoMode (Subdivide=0, Collapse=1, Both=2).
export enum DynTopoSCMode {
  SUBDIVIDE = 0,
  COLLAPSE = 1,
  BOTH = 2,
}

export enum DynTopoFlagsSC {
  ENABLED = 1,
  DO_FLIPS = 2,
  DO_SMOOTH = 4,
  PRESERVE_FEATURES = 8,
}

export enum DynTopoOverridesSC {
  // Mirrored with DynTopoFlagsSC.
  ENABLED = 1,
  DO_FLIPS = 2,
  DO_SMOOTH = 4,
  PRESERVE_FEATURES = 8,
  // end DynTopoFlagsSC mirror

  // These mirror scalar/enum properties instead of flags.
  // (bits 14/15 sit in the free gap below the scalar block so NONE/EVERYTHING
  // keep their serialized bit values.)
  MAX_COLLAPSES = 1 << 14,
  DYNTOPO_SPACING = 1 << 15,
  EDGE_MODE = 1 << 16,
  EDGE_SIZE = 1 << 17,
  COLLAPSE_RATIO = 1 << 18,
  GRADE = 1 << 19,
  MODE = 1 << 20,
  SMOOTH_LAMBDA = 1 << 21,
  MAX_SPLITS = 1 << 22,
  MAX_ROUNDS = 1 << 23,

  NONE = 1 << 24, // set => inherit everything from the tool-mode defaults
  EVERYTHING = (1 << 24) - 1, // all override bits except NONE
}

export const SculptIcons = {} as {[k: string]: number}
for (const k in SculptTools) {
  SculptIcons[k] = (Icons as any)['SCULPT_' + k]
}
