/**
 * The feature flags litemesh owns, registered from its `register(api)` hook.
 *
 * They live here rather than in the host because a flag describes a feature and
 * every one of these describes a sculptcore feature — a build without this addon
 * must not offer them in Settings, and reading one there must not throw.
 *
 * The `declare global` block below is what keeps `FeatureFlags.get('…')` typo-
 * checked from every call site without the host ever naming a key: the registry
 * interface is empty in `scripts/core/feature-flag.ts` and each addon merges its
 * own keys into it (P16 W3b step 5).
 *
 * Storage is keyed by the flag name, so these strings are user-visible state —
 * renaming one silently resets that toggle for every existing user.
 */

import type {FeatureFlag} from '@framework/api'

export const LITEMESH_FEATURE_FLAGS = [
  {
    key        : 'sculptcore.quad_remesher',
    description: 'Enable quad remesher',
    type       : 'bool',
    value      : true,
  },
  {
    key        : 'sculptcore.auto_defrag',
    description: 'Auto-compact mesh DRAM layout at stroke end when fragmented (dyntopo)',
    type       : 'bool',
    value      : true,
  },
  {
    key        : 'sculptcore.select_flush_prefer_op_domain',
    description: "Prefer an op's own selected domain over a derived one; when off, merge instead",
    type       : 'bool',
    value      : true,
  },
  {
    key        : 'sculptcore.gpu_brush',
    uiName     : 'GPU Brushes',
    description: 'Run eligible global brushes (kelvinlet) on the GPU when dyntopo is off',
    type       : 'bool',
    value      : true,
  },
  {
    key        : 'sculptcore.gpu_brush_grab',
    uiName     : 'GPU Grab Brush',
    description: 'Also run the grab brush on the GPU (off until soak; needs GPU Brushes on)',
    type       : 'bool',
    value      : false,
  },
  {
    key        : 'sculptcore.gpu_brush_verify',
    uiName     : 'GPU Brush Shadow-Verify',
    description: 'Run GPU-eligible dabs on both paths and diff them (CPU stays authoritative)',
    type       : 'bool',
    value      : false,
  },
  {
    key        : 'sculptcore.cpp_stroke_driver',
    uiName     : 'C++ Stroke Driver',
    description: 'Sample sculpt strokes with the sculptcore C++ sampler instead of the TS one',
    type       : 'bool',
    value      : true,
  },
  {
    key        : 'sculptcore.backface_cull',
    uiName     : 'Backface Culling',
    description: 'Cull back-facing triangles when drawing the sculpt surface (needs consistent winding)',
    type       : 'bool',
    value      : false,
  },
  {
    key        : 'sculptcore.sculpt_layers',
    uiName     : 'Sculpt Layers',
    description: 'Sculpt-layer stack: the LiteMesh layer panel + edit-target sculpting (experimental)',
    type       : 'bool',
    value      : false,
  },
  {
    key        : 'sculptcore.multires',
    uiName     : 'Multires Subsurf',
    description: 'Multiresolution subdivision sculpting: the LiteMesh multires panel + level ops (experimental)',
    type       : 'bool',
    value      : false,
  },
  {
    key        : 'sculptcore.vdm_sculpt',
    uiName     : 'VDM Sculpting',
    description: 'Vector-displacement sculpting: the LiteMesh VDM panel + Draw-brush texel splatting (experimental)',
    type       : 'bool',
    value      : false,
  },
] as const satisfies readonly FeatureFlag[]

type LiteMeshFeatureFlagKey = (typeof LITEMESH_FEATURE_FLAGS)[number]['key']

declare global {
  interface FeatureFlagRegistry extends Record<LiteMeshFeatureFlagKey, boolean> {}
}
