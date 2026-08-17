/**
 * Registry of importable / exportable file formats.
 *
 * Core knows how to read and write its own project file and nothing else. Every
 * interchange format — STL, OBJ, glTF — belongs to whichever subsystem owns the
 * data it carries, and is contributed here through `AddonAPI.registerFileFormat`
 * so that disabling that subsystem removes the menu entry rather than leaving a
 * command that throws. See `documentation/geometry-contract.md` §9.
 *
 * A format declares only what it can do; the host's import/export ops build
 * their file-dialog filters from the registry, sorted by id for determinism.
 *
 * `Ctx` is the app context, left generic so this module imports nothing: a
 * registry that reaches the host it serves would put every core module that
 * reads it back on the host's import graph. `AddonAPI` binds it to the real
 * `ToolContext`, so addon authors still get a typed `ctx`.
 */

export interface IFileFormat<Ctx = unknown> {
  /** Stable id, e.g. 'stl'. Also the de-dup key. */
  id: string

  /** Label for menus and file-dialog filters. */
  uiName: string

  /** Extensions including the dot, lowercase: `['.stl']`. */
  extensions: string[]

  /**
   * Read `bytes` into the scene. Absent means the format is export-only.
   * Throwing is how a reader reports a malformed file; the caller reports it.
   */
  importFromBytes?(ctx: Ctx, bytes: Uint8Array, filename?: string): void

  /** Serialize the current selection or scene. Absent means import-only. */
  exportToBytes?(ctx: Ctx): Uint8Array | ArrayBuffer | string
}

const _formats = new Map<string, IFileFormat>()

export function registerFileFormat(fmt: IFileFormat): void {
  if (_formats.has(fmt.id)) {
    throw new Error(`file format "${fmt.id}" is already registered`)
  }
  _formats.set(fmt.id, fmt)
}

export function unregisterFileFormat(id: string): void {
  _formats.delete(id)
}

export function getFileFormat(id: string): IFileFormat | undefined {
  return _formats.get(id)
}

/** All formats, sorted by id — registration order is never load-bearing. */
export function listFileFormats(): IFileFormat[] {
  return Array.from(_formats.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function listImportFormats(): IFileFormat[] {
  return listFileFormats().filter((f) => typeof f.importFromBytes === 'function')
}

export function listExportFormats(): IFileFormat[] {
  return listFileFormats().filter((f) => typeof f.exportToBytes === 'function')
}

/** The importer claiming `filename`'s extension, or undefined. */
export function formatForFilename(filename: string): IFileFormat | undefined {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) {
    return undefined
  }

  const ext = filename.slice(dot).toLowerCase()
  return listImportFormats().find((f) => f.extensions.includes(ext))
}

/** Test-only helper. */
export function _resetFileFormatsForTests(): void {
  _formats.clear()
}
