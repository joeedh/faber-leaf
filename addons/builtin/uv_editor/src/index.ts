/**
 * The UV editor's host-free core — P18 §5 step 3.
 *
 * Everything re-exported here runs under plain jest, because none of it
 * imports a value from `scripts/`. That is what lets the editor be driven
 * headlessly against the in-memory `IUVSource` double, in a build with no
 * geometry engine at all.
 *
 * The addon shell — the editor component, its ToolOps, registration — is
 * `main.ts` and is not part of this module.
 */

export {
  UV_PIN,
  UV_SELECT,
  UV_SNAP_LIMIT,
  applyUVFlag,
  applyUVRotate,
  applyUVScale,
  applyUVTranslate,
  buildUVDrawGeometry,
  gatherUVTransData,
  listSelectedUVs,
  pickNearestUV,
  readUVRings,
  restoreUVFlags,
  restoreUVTransData,
  ringElements,
  selectAllUVs,
  selectLinkedUV,
  selectOneUV,
  snapshotUVFlags,
  uvIslandOf,
  uvIslands,
} from './uv_edit_geom.js'

export type {
  UVDrawGeometry,
  UVFlagAction,
  UVFlagSnapshot,
  UVPickHit,
  UVPickOptions,
  UVPropOptions,
  UVRings,
  UVScope,
  UVSelectMode,
  UVSelectOneMode,
  UVTransData,
  UVTransOptions,
} from './uv_edit_geom.js'
