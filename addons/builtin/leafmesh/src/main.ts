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
 * This module registers the kind descriptor and nothing else; the DataBlock,
 * draw, picking, serialization and OBJ import arrive in P11 steps 2-6, and the
 * descriptor grows `factory` / `capabilities` / `vertexAttrs` with them.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import * as leafmesh from './index.js'

export const addonDefine: IAddonDefine = {
  name       : 'Leaf Mesh',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Corner-based polygon mesh geometry type.',
}

export function register(api: AddonAPI<IAddon>) {
  // Keep in sync with addons/builtin/leafmesh/src/api.ts.
  api.exportNamespace('leafmesh', {...leafmesh})

  // No `factory` yet: the descriptor's data class is P11 step 2. A kind with
  // no declared capabilities claims only the required surface, which is the
  // honest answer while there is no data class to claim them for.
  api.registerDataKind({
    id    : 'leafmesh',
    uiName: 'Leaf Mesh',
  })
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
