/**
 * Per-version file migration registry.
 *
 * appstate.ts runs migrations on a freshly-read file before handing it to the
 * datalib. Today those migrations live inline and import directly from mesh
 * (e.g. `GridBase.meshGridOffset` for the v5→v6 migration). The mesh subsystem
 * is moving into an addon (see plan §3), so the migrations get registered here
 * by whichever subsystem owns the data they touch.
 *
 * Migrators run in ascending `fromVersion` order. Each migrator is responsible
 * for inspecting the load context, mutating in place, and stopping cleanly if
 * the data it cares about isn't present (e.g. the mesh addon is disabled).
 *
 * `Lib` is the datalib, left generic so this module imports nothing: a registry
 * on the host's import graph puts every core module that reads it there too.
 * `AddonAPI` binds it to the real `Library`.
 */

/** Context passed to every migrator. */
export interface IFileMigrationContext<Lib = unknown> {
  fromVersion: number
  toVersion: number
  datalib: Lib
}

export interface IFileMigrator<Lib = unknown> {
  /** Stable id, used for logging and de-duping. */
  id: string

  /** The version this migrator upgrades from. */
  fromVersion: number

  /** Apply the migration. Should be idempotent if possible. */
  apply(ctx: IFileMigrationContext<Lib>): void
}

const _migrators: IFileMigrator[] = []

export function registerFileMigrator(m: IFileMigrator): void {
  if (_migrators.some((x) => x.id === m.id)) {
    throw new Error(`file migrator "${m.id}" already registered`)
  }
  _migrators.push(m)
  _migrators.sort((a, b) => a.fromVersion - b.fromVersion)
}

export function unregisterFileMigrator(id: string): void {
  const idx = _migrators.findIndex((m) => m.id === id)
  if (idx >= 0) _migrators.splice(idx, 1)
}

export function listFileMigrators(): readonly IFileMigrator[] {
  return _migrators
}

export function runFileMigrations(ctx: IFileMigrationContext): void {
  for (const m of _migrators) {
    if (m.fromVersion < ctx.fromVersion) continue
    if (m.fromVersion >= ctx.toVersion) break
    try {
      m.apply(ctx)
    } catch (e) {
      console.error(`file migrator "${m.id}" threw:`, e)
    }
  }
}

/** Test-only helper. */
export function _resetFileMigratorsForTests(): void {
  _migrators.length = 0
}
