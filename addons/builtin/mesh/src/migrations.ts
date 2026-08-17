/**
 * Mesh-side file-version migrations.
 *
 * Registers the v4/v5/v6 grid migrations with core/file_migrations.ts so
 * `appstate.do_versions` doesn't need to import from mesh. See plan §3.
 *
 * Imported as a side effect from scripts/entry_point.js right after
 * default_scene.js. Once mesh moves out of the main bundle (step 6 of the
 * plan's follow-up), this file's registration moves into the addon's
 * register() hook.
 */

import {registerFileMigrator} from '@framework/api'
import type {IFileMigrator, Library} from '@framework/api'
import {GridBase} from './mesh_grids.js'

function forEachGriddedMesh(
  datalib: Library,
  visit: (mesh: {loops: Iterable<{customData: Record<number, unknown>}>}, cd_grid: number) => void
): void {
  // datalib.mesh is the iterable of Mesh blocks. The type is loose because
  // appstate.ts's `do_versions` already operates on the same shape via
  // `unknown` casts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const mesh of (datalib as any).mesh) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cd_grid = GridBase.meshGridOffset(mesh as any)
    if (cd_grid < 0) continue
    visit(mesh, cd_grid)
  }
}

const flagNormalsUpdate: IFileMigrator<Library> = {
  id         : 'mesh.grid.v5.flagNormalsUpdate',
  fromVersion: 4,
  apply: ({datalib}) => {
    forEachGriddedMesh(datalib, (mesh, cd_grid) => {
      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid] as {flagNormalsUpdate(): void}
        grid.flagNormalsUpdate()
      }
    })
  },
}

const flagIdsRegen: IFileMigrator<Library> = {
  id         : 'mesh.grid.v6.flagIdsRegen',
  fromVersion: 5,
  apply: ({datalib}) => {
    forEachGriddedMesh(datalib, (mesh, cd_grid) => {
      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid] as {flagIdsRegen(): void}
        grid.flagIdsRegen()
      }
    })
  },
}

registerFileMigrator(flagNormalsUpdate)
registerFileMigrator(flagIdsRegen)
