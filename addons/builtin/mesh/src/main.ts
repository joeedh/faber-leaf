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
import {
  GeometryCapability,
  MATERIAL_BASE_VERTEX_ATTRS,
  MeshTransType,
  SelMask,
  VertexScalarType,
  registerOpaqueCustomDataElem,
  setInsetHoleOp,
  setShapesObjLoader,
} from '@framework/api'
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
import {CDLayerPanel, ChangeActCDLayerOp, MESH_PROPS_PANELS} from './props_panels.js'

import {OpaqueCustomDataElem} from './missing_customdata.js'

// Side-effect imports that used to sit in `scripts/entry_point.js`, where they
// pulled the mesh subsystem into the host's own module graph: the startup-cube
// scene builder and the FBX loader's `window._testFBX` debug hook.
import './default_scene.js'
import './fbxloader.js'

import {registerMeshFileMigrators, unregisterMeshFileMigrators} from './migrations.js'

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

  // Every file migration that reads a Mesh block (plan §4.4a). Registered
  // here, not as a module side effect, so disabling mesh takes them with it.
  registerMeshFileMigrators()

  // Lets core round-trip files naming a customdata class no loaded addon
  // defines. Not an `api.register` — the placeholder is deliberately kept out
  // of the customdata menus. See plan §3.
  registerOpaqueCustomDataElem(OpaqueCustomDataElem)

  // Keep these namespaces in sync with `addons/builtin/mesh/src/api.ts` so the
  // typed `@addon/mesh/api` shim resolves to the same surface at runtime.
  api.exportNamespace('mesh', meshExports)
  api.exportNamespace('mesh_utils', {...mesh_utils})
  api.exportNamespace('bvh', {...bvh})
  api.exportNamespace('unwrapping', {...unwrapping})

  api.registerAll(...ALL_MESH_REGISTRATIONS)

  api.registerDataKind({
    id          : 'mesh',
    uiName      : 'Mesh',
    factory     : mesh.Mesh,
    usesMaterial: true,
    capabilities: [GeometryCapability.INVALIDATION],
    // SimpleIsland uploads one buffer per LayerType at the canonical slots
    // (WGSL_VERTEX_SLOTS) regardless of what the material reads; see
    // documentation/geometry-contract.md §10.
    vertexAttrs: [
      ...MATERIAL_BASE_VERTEX_ATTRS,
      {name: 'uv', slot: 2, scalar: VertexScalarType.FLOAT32, elemSize: 2},
      {name: 'color', slot: 3, scalar: VertexScalarType.FLOAT32, elemSize: 4},
    ],
  })

  // The mesh's transform bridge (§8). The class still lives in host code —
  // P11 moves it here alongside the geometry it transforms — but the
  // registration is the addon's, so disabling the addon takes it with it.
  api.registerTransType(MeshTransType)

  // Hotkeys for mesh's own ToolOps. These used to sit in View3D's default
  // keymap, where they outlived the tools they named.
  api.registerKeymapEntries('view3d', new api.KeyMap([new api.HotKey('W', [], 'mesh.vertex_smooth()')]))

  // Legacy nstructjs names for mesh's CustomData elements, split out of core's
  // table. `CurvVert22` / `DispLayerVert3` are collision-mangled bundle names.
  api.registerLegacyStructNames({
    CotanVert        : 'mesh.CotanVert',
    CurvVert         : 'mesh.CurvVert',
    CurvVert2        : 'mesh.CurvVert2',
    CurvVert22       : 'mesh.CurvVert2',
    CurvVert2Settings: 'mesh.CurvVert2Settings',
    DFieldElem       : 'mesh.DFieldElem',
    DFieldSettings   : 'mesh.DFieldSettings',
    DispLayerSettings: 'mesh.DispLayerSettings',
    DispLayerVert    : 'mesh.DispLayerVert',
    DispLayerVert3   : 'mesh.DispLayerVert',
    MultiGridData    : 'mesh.MultiGridData',
    MultiGridSettings: 'mesh.MultiGridSettings',
    ParamVert        : 'mesh.ParamVert',
    ParamVertSettings: 'mesh.ParamVertSettings',
    SolverElem       : 'mesh.SolverElem',
    SolverSettings   : 'mesh.SolverSettings',
  })

  // The properties-editor contributions the host used to build by branching on
  // concrete type (plan §3.3).
  api.register(ChangeActCDLayerOp)
  api.registerUIElement(CDLayerPanel)

  for (const panel of MESH_PROPS_PANELS) {
    api.registerPropsPanel(panel)
  }
}

export function unregister() {
  unregisterMeshFileMigrators()
  registerOpaqueCustomDataElem(null)
}
export function handleArgv() {}
export function validArgv() {}
