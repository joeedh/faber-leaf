/**
 * Mesh-side file-version migrations.
 *
 * Every migration that reads a `Mesh` block lives here, registered with
 * core/file_migrations.ts, so the host never imports mesh to upgrade a file and
 * these leave with the addon rather than being deleted with it (plan §4.4a).
 * Format-shaped migrations — the ones about the file rather than about mesh
 * data — stay in `AppState.do_versions`.
 *
 * Registration is the addon's `register(api)` / `unregister()` pair, not a
 * module side effect, so disabling mesh takes these with it.
 */

import {registerFileMigrator, unregisterFileMigrator} from '@framework/api'
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

/**
 * The v3->v4 grid repair, until now inline in `AppState.do_versions`. It still
 * runs before the two above: the registry sorts by `fromVersion`, which is the
 * order it had there.
 */
const quadtreeRepair: IFileMigrator<Library> = {
  id         : 'mesh.grid.v4.quadtreeRepair',
  fromVersion: 3,
  apply: ({datalib}) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const mesh of (datalib as any).mesh) {
      const cd_grid = mesh.loops.customData.getLayerIndex('QuadTreeGrid')
      if (cd_grid < 0) continue

      for (const l of mesh.loops) {
        const grid = l.customData[cd_grid] as {updateNormalQuad(l: unknown): void; pruneDeadPoints(): void}
        grid.updateNormalQuad(l)
        grid.pruneDeadPoints()
      }
    }
  },
}

const MESH_FILE_MIGRATORS: IFileMigrator<Library>[] = [quadtreeRepair, flagNormalsUpdate, flagIdsRegen]

export function registerMeshFileMigrators(): void {
  for (const m of MESH_FILE_MIGRATORS) {
    registerFileMigrator(m as IFileMigrator)
  }
}

export function unregisterMeshFileMigrators(): void {
  for (const m of MESH_FILE_MIGRATORS) {
    unregisterFileMigrator(m.id)
  }
}
