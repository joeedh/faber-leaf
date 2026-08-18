/**
 * P10 §4.4a: which side of the addon boundary each file migration sits on.
 *
 * The migrators themselves cannot be imported here — `migrations.ts` reaches
 * `@framework/api` and `mesh_grids.js`, which pull path.ux in at module load —
 * so ownership is checked against the source, the same way §9's registration
 * cases are in addon_registries.test.ts. That is enough to catch the two
 * failures that actually happen: a mesh-shaped migration drifting back into the
 * host, and a migrator registered at module scope so disabling mesh cannot take
 * it out again.
 */

import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const MIGRATIONS = read('addons/builtin/mesh/src/migrations.ts')
const MESH_MAIN = read('addons/builtin/mesh/src/main.ts')
const APPSTATE = read('scripts/core/appstate.ts')

const MESH_MIGRATOR_IDS = ['mesh.grid.v4.quadtreeRepair', 'mesh.grid.v5.flagNormalsUpdate', 'mesh.grid.v6.flagIdsRegen']

describe('mesh owns the migrations that read a Mesh block', () => {
  test('all three grid migrators live in the addon', () => {
    for (const id of MESH_MIGRATOR_IDS) {
      expect([id, MIGRATIONS.includes(`'${id}'`)]).toEqual([id, true])
    }
  })

  test('the host no longer walks datalib.mesh to upgrade a file', () => {
    const start = APPSTATE.search(/^ {2}do_versions\(/m)
    expect(start).toBeGreaterThan(-1)

    const body = APPSTATE.slice(start, APPSTATE.indexOf('\n  }', start))
    expect(body).not.toMatch(/QuadTreeGrid|datalib\.mesh/)
    expect(body).toMatch(/runFileMigrations\(/)
  })

  test('registration is the addon lifecycle, not a module side effect', () => {
    // A bare call at column 0 is module scope; the ones inside the exported
    // helpers are indented.
    expect(MIGRATIONS).not.toMatch(/^registerFileMigrator\(/m)

    expect(MIGRATIONS).toMatch(/^export function registerMeshFileMigrators\(\): void \{/m)
    expect(MIGRATIONS).toMatch(/^export function unregisterMeshFileMigrators\(\): void \{/m)
  })

  test('mesh calls both halves, so disabling it takes the migrations with it', () => {
    expect(MESH_MAIN).toMatch(/registerMeshFileMigrators\(\)/)
    expect(MESH_MAIN).toMatch(/unregisterMeshFileMigrators\(\)/)

    const unreg = MESH_MAIN.search(/^export function unregister\(\)/m)
    expect(unreg).toBeGreaterThan(-1)
    expect(MESH_MAIN.slice(unreg)).toMatch(/unregisterMeshFileMigrators\(\)/)
  })
})
