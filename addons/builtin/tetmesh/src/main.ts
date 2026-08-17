/**
 * Tet Mesh addon entry point.
 *
 * Loaded by AddonManager as an out-of-bundle per-addon esbuild build.
 * Registration happens in `register(api)`; module-scope side effects are
 * limited to STRUCT string assembly + `nstructjs.inlineRegister` (where
 * applicable).
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {TetMeshTool} from './tetmesh.js'
import {MakeTetMesh, TetSmoothVerts, TetToMesh, Tetrahedralize, TetTest, TetFixNormalsOp} from './tet_ops.js'

export const addonDefine: IAddonDefine = {
  name       : 'Tet Mesh',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Tetrahedral mesh editing toolmode.',
}

export function register(api: AddonAPI<IAddon>) {
  // Keep in sync with addons/builtin/tetmesh/src/api.ts.
  api.exportNamespace('tetmesh', {TetMeshTool})
  api.registerAll(MakeTetMesh, TetSmoothVerts, TetToMesh, Tetrahedralize, TetTest, TetFixNormalsOp, TetMeshTool)

  api.registerLegacyStructNames({TetMeshTool: 'tetmesh.TetMeshTool'})
}
export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
