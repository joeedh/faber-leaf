/**
 * LeafMesh addon entry point.
 *
 * Loaded as its own out-of-bundle esbuild build (`build/addons/leafmesh/`), not
 * compiled into the main bundle — LeafMesh is a leaf with no host imports, so
 * there is nothing forcing it in-bundle the way mesh/sculptcore are forced.
 * That also makes it the stronger proof of success criterion 12: its modules
 * physically cannot reach `scripts/` internals by relative path.
 *
 * `"dependencies": []` — the first builtin with none. See P11 §4.
 *
 * This module registers the kind descriptor, the data class, the OBJ importer,
 * and the modeling toolmode with its selection ops (P12).
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {LEAFMESH_VERTEX_ATTRS} from './draw.js'
import * as leafmesh from './index.js'
import {LEAFMESH_CAPABILITIES, LeafMeshData, LeafMeshSymmetry} from './leafmesh.js'
import {LEAFMESH_OBJ_FORMAT} from './obj.js'
import {LEAFMESH_SELECT_OPS} from './select_ops.js'
import {LeafMeshToolMode} from './toolmode.js'
import {LeafMeshTransType} from './transtype.js'

export const addonDefine: IAddonDefine = {
  name       : 'Leaf Mesh',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Corner-based polygon mesh geometry type.',
}

export function register(api: AddonAPI<IAddon>) {
  // Keep in sync with addons/builtin/leafmesh/src/api.ts.
  api.exportNamespace('leafmesh', {...leafmesh, LEAFMESH_CAPABILITIES, LeafMeshData, LeafMeshSymmetry})
  api.register(LeafMeshData)

  // Declaring a capability is what makes `asElementSource` and friends return
  // non-undefined, so this list and leafmesh.ts's AssertExtends block have to
  // agree; they share LEAFMESH_CAPABILITIES so that they cannot drift.
  api.registerDataKind({
    id              : 'leafmesh',
    uiName          : 'Leaf Mesh',
    factory         : LeafMeshData,
    capabilities    : LEAFMESH_CAPABILITIES,
    usesMaterial    : true,
    vertexAttrs     : LEAFMESH_VERTEX_ATTRS,
    importExtensions: LEAFMESH_OBJ_FORMAT.extensions,
  })

  // The format registry is what a file dialog reads; the kind's
  // `importExtensions` above is what a "which kind claims this file" query
  // reads. Both point at the same parser (P11 §6).
  api.registerFileFormat(LEAFMESH_OBJ_FORMAT)

  // The modeling toolmode and its selection ops (P12 step 1). One `register`
  // dispatch each — no module-scope `ToolMode.register` side effect.
  api.registerAll(LeafMeshToolMode, ...LEAFMESH_SELECT_OPS)

  // Implementor #2 of `ITransDataType` (P12 §6) — grab/rotate/scale, snapping
  // and proportional edit, with `transform_ops.ts` naming no geometry type.
  api.registerTransType(LeafMeshTransType)
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
