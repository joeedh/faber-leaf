/**
 * Mesh addon entry point.
 *
 * The mesh subsystem ships in the main bundle (the app's data_api eagerly
 * imports Mesh/CustomData at startup, so it can't be a separate bundle without
 * duplication). It is registered as an in-bundle builtin *source* by
 * `addons/builtin/builtin_registry.ts`, then enabled through the same unified
 * pipeline as every other addon — this module's `register(api)` hook publishes
 * the runtime surface and registers mesh's classes.
 *
 * Module-scope TDZ injections (setMeshTools/setInsetHoleOp/setShapesObjLoader)
 * run at import time, before any mesh op executes; they must stay at module
 * scope to break import cycles. See the per-line comments.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {SelMask, setInsetHoleOp, setShapesObjLoader} from '@framework/api'
import {ALL_MESH_REGISTRATIONS} from './register_classes.js'
import * as mesh from './mesh.js'
import {setMeshTools} from './mesh.js'
import {MeshTools} from './mesh_stdtools.js'
import {InsetHoleOp} from './mesh_extrudeops.js'
import {readOBJ} from './objloader.js'

// Inject MeshTools into mesh.ts. mesh.ts cannot statically import
// mesh_stdtools.ts because that pulls select_ops → mesh_ops_base → mesh
// and creates a TDZ-hazardous import cycle.
setMeshTools(MeshTools)

// Inject InsetHoleOp into widget_tools.ts. Same cycle hazard:
// widget_tools → mesh_extrudeops → mesh_ops_base → mesh.
setInsetHoleOp(InsetHoleOp)

// Inject readOBJ into webgl/simplemesh_shapes.ts. Same cycle hazard:
// simplemesh_shapes is re-exported by framework_api.ts; statically importing
// objloader.js → mesh.ts from it would re-enter mesh.ts before
// SceneObjectData is bound.
setShapesObjLoader(readOBJ)

import * as mesh_base from './mesh_base.js'
import * as mesh_types from './mesh_types.js'
import * as customdata from './customdata.js'
import * as mesh_utils from './mesh_utils.js'
import * as paramizer from './mesh_paramizer.js'
import * as displacement from './mesh_displacement.js'
import * as curvature from './mesh_curvature.js'
import * as curvature_test from './mesh_curvature_test.js'
import * as unwrapping from './unwrapping.js'
import * as bvh from './bvh.js'
import {MeshOp, MeshDeformOp, saveUndoMesh, loadUndoMesh} from './mesh_ops_base.js'
import {MeshOpBaseUV} from './mesh_uvops_base.js'
import {KDrawModes} from './mesh_curvature_test.js'

// Side-effect import: registers `OpaqueCustomDataElem` with core's
// `missing_addon` hook so files referencing unloaded customdata classes can
// round-trip. See plan §3.
import './missing_customdata.js'

const meshExports = {
  ...mesh,
  ...mesh_base,
  ...mesh_types,
  ...customdata,
  utils: mesh_utils,
  paramizer,
  displacement,
  curvature,
  curvature_test,
  unwrapping,
  bvh,
  KDrawModes,
  MeshOp,
  MeshDeformOp,
  MeshOpBaseUV,
  saveUndoMesh,
  loadUndoMesh,
  // BVH classes are also exposed at the top level for backward compatibility
  // with `api.mesh.BVH` consumers.
  ...bvh,
}

export const addonDefine: IAddonDefine = {
  name       : 'Mesh',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Mesh DataBlock, custom data, BVH, and mesh utilities.',
}

/**
 * `SelMask`'s geometry bits used to be *defined* as `MeshTypes.VERTEX` etc. P6
 * froze them as literals in the host so the host stops importing this addon;
 * this catches the two drifting apart while both still exist.
 */
function assertSelMaskAgreement(): void {
  const pairs: [string, number, number][] = [
    ['VERTEX', mesh_base.MeshTypes.VERTEX, SelMask.VERTEX],
    ['EDGE', mesh_base.MeshTypes.EDGE, SelMask.EDGE],
    ['FACE', mesh_base.MeshTypes.FACE, SelMask.FACE],
    ['HANDLE', mesh_base.MeshTypes.HANDLE, SelMask.HANDLE],
  ]

  for (const [name, meshBit, selBit] of pairs) {
    if (meshBit !== selBit) {
      throw new Error(
        `MeshTypes.${name} (${meshBit}) no longer matches SelMask.${name} (${selBit}); ` +
          'the selection wire format is frozen — see scripts/core/select_types.ts'
      )
    }
  }
}

export function register(api: AddonAPI<IAddon>) {
  assertSelMaskAgreement()

  // Keep these namespaces in sync with `addons/builtin/mesh/src/api.ts` so the
  // typed `@addon/mesh/api` shim resolves to the same surface at runtime.
  api.exportNamespace('mesh', meshExports)
  api.exportNamespace('mesh_utils', {...mesh_utils})
  api.exportNamespace('bvh', {...bvh})
  api.exportNamespace('unwrapping', {...unwrapping})

  api.registerAll(...ALL_MESH_REGISTRATIONS)
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
