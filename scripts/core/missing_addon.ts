/**
 * Placeholders that preserve serialized data referencing classes whose addon
 * isn't currently loaded.
 *
 * Goal: if a file references a DataBlock / ToolMode / CustomDataElem subclass
 * from an addon that's been disabled or uninstalled, the load path substitutes
 * a placeholder that stores the original class name + all the field values
 * deserialized via the file's schema. On the next save we re-emit those values
 * under the original class's struct id + schema. When the addon is later
 * re-enabled and the file is re-loaded, the data round-trips back to the real
 * class without loss.
 *
 * Two read mechanisms:
 *   1. MissingDataBlock — populated in `appstate.ts`'s explicit DataBlock
 *      load path; the bytes + class name are already in hand there. Stored
 *      as opaque bytes.
 *   2. MissingToolMode / OpaqueCustomDataElem — populated via the patched
 *      nstructjs `onUnknownClass` hook. The hook returns the placeholder
 *      class; nstructjs then walks the *file's* schema fields, depositing
 *      each value on the placeholder by name (so the placeholder carries
 *      the original data as dynamic properties). The matching
 *      `onSerializeUnknown` hook makes write_object emit the original
 *      class's struct id + schema, not the placeholder's. See plan §4.
 */

import {DataBlock, setMissingDataBlockType} from './lib_api.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'
import {ToolMode} from '../editors/view3d/view3d_toolmode.js'
import {MissingNode, MissingNodeSocket} from './graph.js'

// Constructor for the mesh-addon's `OpaqueCustomDataElem` placeholder.
// Registered at addon-load time via `registerOpaqueCustomDataElem` so this
// module stays mesh-agnostic (see plan §3).
let opaqueCustomDataElemCls: (new () => unknown) | null = null

/**
 * Called from the mesh addon's `register(api)` hook to publish its
 * `OpaqueCustomDataElem` placeholder class, and with null from `unregister()`.
 * The class must extend mesh's `CustomDataElem` — core does not reference that
 * base directly to keep the `core-no-addons` layer rule clean.
 */
export function registerOpaqueCustomDataElem(cls: (new () => unknown) | null): void {
  opaqueCustomDataElemCls = cls
}

/**
 * The `DataBlock` base fields every block payload starts with, recovered from a
 * payload whose own class is unregistered. `lib_id` is the load-bearing one:
 * without it the placeholder is handed a fresh id and every inbound `DataRef`
 * dangles (plan §4.1).
 */
export interface RecoveredBlockHeader {
  lib_id: number
  lib_flag: number
  lib_users: number
  name: string
  lib_userData: string
}

/**
 * Shell class whose `structName` names `DataBlock`, so `read_object` looks the
 * *file's* `DataBlock` schema up by name and walks exactly the base-class prefix
 * that every block payload begins with, stopping before the subclass fields it
 * cannot interpret. Deliberately has no side effects in `loadSTRUCT` — this must
 * not build graph state, only report what the bytes say.
 */
class BlockHeaderShell {
  static structName = 'DataBlock'

  loadSTRUCT(reader: (obj: BlockHeaderShell) => void): void {
    reader(this)
  }
}

interface FileStructManager {
  structs: Record<string, unknown>
  read_object: (data: DataView, cls: unknown) => unknown
}

/**
 * Decode a block payload's `DataBlock` prefix. `istruct` must be the per-file
 * manager, so the fields are read under the schema the file was written with
 * rather than this build's — an older file whose `graph.Node` differed would
 * otherwise mis-decode silently.
 *
 * Returns undefined when the prefix cannot be trusted: a subclass that
 * redeclares a base field name moves it out of the prefix (`mergeScripts` keeps
 * the child's position), and a truncated or foreign payload throws. Callers fall
 * back to the pre-recovery behaviour rather than inventing an identity.
 */
export function recoverBlockHeader(istruct: unknown, bytes: Uint8Array): RecoveredBlockHeader | undefined {
  const manager = istruct as FileStructManager

  if (!manager?.structs || !('DataBlock' in manager.structs)) {
    return undefined
  }

  let header: Partial<RecoveredBlockHeader>
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    header = manager.read_object(view, BlockHeaderShell) as Partial<RecoveredBlockHeader>
  } catch (error) {
    console.warn('could not recover the block header of an unknown block', error)
    return undefined
  }

  if (!Number.isInteger(header.lib_id) || header.lib_id! < 0 || typeof header.name !== 'string') {
    console.warn('recovered block header failed its sanity check', header)
    return undefined
  }

  return header as RecoveredBlockHeader
}

/**
 * Stand-in for a DataBlock whose class isn't registered (the addon that owned
 * it isn't loaded). Holds the raw on-disk bytes and the original class name so
 * appstate's writer can round-trip them on the next save, plus the `lib_id`
 * recovered from those bytes so inbound `DataRef`s still resolve to it.
 */
export class MissingDataBlock extends DataBlock {
  /** Original class name (e.g. "Mesh") that the load path tried to resolve. */
  _origClsname: string = ''

  /** Raw bytes that were intended for the original class's loadSTRUCT. */
  _origBytes: Uint8Array = new Uint8Array()

  /**
   * True when `_origBytes` came out of a file written before struct ids were
   * derived from struct names. Nested `abstract(...)` ids inside those bytes
   * belong to that file's registration-order id space and cannot be resolved
   * against this one; the save path warns rather than pretending otherwise.
   */
  _legacyStructIds: boolean = false

  static blockDefine() {
    return {
      typeName   : 'MissingDataBlock',
      defaultName: 'Missing Addon Data',
      uiName     : 'Missing',
      flag       : 0,
      icon       : -1,
    }
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
MissingDataBlock {
  _origClsname     : string;
  _origBytes       : array(byte);
  _legacyStructIds : bool;
}
  `
  )

  /**
   * Helper used by appstate.ts during load when DataBlock.getClass returns
   * undefined. Builds a placeholder, copying the bytes out of the
   * just-read block-header so the writer can re-emit them.
   *
   * `header` is what `recoverBlockHeader` made of those same bytes. Passing it
   * is what keeps inbound `DataRef`s resolving; without it the block reaches
   * `BlockSet.push` with `lib_id === -1` and is renumbered.
   *
   * `legacyStructIds` says the source file predates name-derived struct ids —
   * see the field it sets.
   */
  static fromUnknownBlock(
    clsname: string,
    bytes: Uint8Array,
    header?: RecoveredBlockHeader,
    legacyStructIds = false
  ): MissingDataBlock {
    const block = new MissingDataBlock()
    block._origClsname = clsname
    block._origBytes = new Uint8Array(bytes)
    block._legacyStructIds = legacyStructIds
    block.name = header?.name ?? `Missing: ${clsname}`
    block.lib_type = clsname // pretend to be the original type for datalib bookkeeping

    if (header !== undefined) {
      block.lib_id = header.lib_id
      block.lib_flag = header.lib_flag
      block.lib_users = header.lib_users
    }

    return block
  }
}

DataBlock.register(MissingDataBlock)

// Library.loadSTRUCT needs the class to keep an unknown block type's BlockSet
// alive; it cannot import this module, which imports it.
setMissingDataBlockType(MissingDataBlock)

// ----------------------------------------------------------------------------
// MissingToolMode — placeholder for a ToolMode subclass from an unloaded addon
// ----------------------------------------------------------------------------

/**
 * Stand-in for a ToolMode whose subclass isn't registered. Carries the
 * original struct name (set by nstructjs's abstract unpack hook) and any
 * fields the loader deposited as dynamic properties. Filtered out of the
 * runtime toolmode_map in scene.ts but kept in scene.toolmodes so re-save
 * round-trips it.
 */
export class MissingToolMode extends ToolMode {
  _origClsname: string = ''

  static toolModeDefine() {
    return {
      name       : 'MissingToolMode',
      uiname     : 'Missing (Addon Disabled)',
      icon       : -1,
      flag       : 0,
      description: 'Placeholder for a tool mode whose addon is not loaded.',
    }
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
MissingToolMode {
  _origClsname : string;
}
  `
  )
}

// MissingToolMode is intentionally NOT registered with ToolMode.register() —
// it must not appear in the toolmode enum or be selectable; it's only ever
// instantiated by the onUnknownClass hook for round-tripping serialized data.

// ----------------------------------------------------------------------------
// OpaqueCustomDataElem placeholder lives in the mesh addon
// (`addons/builtin/mesh/src/missing_customdata.ts`) since its base class
// `CustomDataElem` is mesh-defined. The mesh addon calls
// `registerOpaqueCustomDataElem` (above) at load time so the hook below can
// hand it back from `onUnknownClass` — keeping core mesh-agnostic.
// ----------------------------------------------------------------------------
// nstructjs hooks
// ----------------------------------------------------------------------------

// nstructjs schema (NStruct) and manager shapes — the public typings don't
// expose these internals; cast to permissive local shapes.
interface SchemaField {
  name: string
  get?: string
}
interface FileSchema {
  name: string
  id: number
  fields: SchemaField[]
}
interface NStructManager {
  idgen: number
  stableIds?: boolean
  assignStructId?: (stt: FileSchema) => number
  structs: Record<string, FileSchema>
  struct_cls: Record<string, unknown>
  struct_ids: Record<number, FileSchema>
  null_natives?: Record<string, number>
  onUnknownClass?: (clsname: string, schema: FileSchema) => unknown
  onSerializeUnknown?: (obj: unknown) => string | undefined
}

function getManager(): NStructManager {
  return nstructjs.manager as unknown as NStructManager
}

/**
 * Register an unknown class's *file* schema into the global nstructjs manager so
 * the save path's `get_struct(_origClsname)` and `write_scripts()` can find it.
 * Idempotent. Mirrors what `parse_structs` does for an unknown struct: assigns
 * the id and stores the schema + a dummy class. Fixes the save-side blocker for
 * every placeholder kind (graph node/socket, toolmode, customdata).
 */
function registerMissingStructGlobally(clsname: string, fileSchema: FileSchema): void {
  const manager = getManager()
  if (clsname in manager.structs) {
    return
  }

  // The file's own id belongs to the per-file istruct's id space, so it is
  // reassigned here — by name under the stable-id scheme, which is what makes
  // the id we write match the one the addon itself would have used.
  fileSchema.name = clsname
  if (manager.assignStructId) {
    manager.assignStructId(fileSchema)
  } else {
    fileSchema.id = manager.idgen++
  }

  const dummy = function (this: unknown) {} as unknown as {
    structName: string
    newSTRUCT: () => unknown
    prototype: Record<string, unknown>
  }
  dummy.structName = clsname
  dummy.prototype.structName = clsname
  dummy.prototype.loadSTRUCT = function (this: unknown, reader: (obj: unknown) => void) {
    reader(this)
  }
  dummy.newSTRUCT = function (this: new () => unknown) {
    return new this()
  }

  manager.structs[clsname] = fileSchema
  manager.struct_cls[clsname] = dummy
  manager.struct_ids[fileSchema.id] = fileSchema
}

/**
 * Preserve the *file's* schema for every struct this build does not know, so the
 * next `write_scripts()` re-emits them and a later load — with the owning addon
 * back — can still read the bytes `MissingDataBlock` kept. Without this the
 * placeholder's payload survives a save while the addon is off, but the schema
 * needed to interpret it does not, and the next load dies on
 * `this.structs[cls.structName]`.
 *
 * It cannot be narrowed to the one class that was parked: a DATABLOCK record
 * names the block's `blockDefine().typeName` ("leafmesh"), never its struct name
 * ("leafmesh.LeafMeshData"), and with the addon absent nothing maps one to the
 * other. Everything the file declares and this build lacks is, by construction,
 * from something not loaded — which is exactly what has to survive.
 *
 * The `onUnknownClass` hook does the same for the placeholder kinds it handles;
 * the DataBlock path never reaches that hook, because appstate resolves block
 * classes itself.
 */
export function preserveMissingBlockSchemas(istruct: unknown): void {
  const structs = (istruct as {structs?: Record<string, FileSchema>} | undefined)?.structs
  if (!structs) {
    return
  }

  const manager = getManager()
  for (const name in structs) {
    if (!(name in manager.structs)) {
      registerMissingStructGlobally(name, structs[name])
    }
  }
}

/**
 * Re-attach the base graph save-getters that `write_scripts(include_code=false)`
 * stripped from the embedded file schema. Without them the writer packs live
 * objects where ints/arrays are expected (see plan "Why getter re-injection is
 * needed"). Getter strings are copied by field name from the live base schema
 * (`graph.Node` / `graph.NodeSocketType`), which retains them.
 */
function reinjectGraphGetters(fileSchema: FileSchema, kind: 'node' | 'socket'): void {
  const manager = getManager()
  const baseName = kind === 'node' ? 'graph.Node' : 'graph.NodeSocketType'
  const fieldNames = kind === 'node' ? ['inputs', 'outputs'] : ['node', 'edges']

  const base = manager.structs[baseName]
  if (!base) {
    return
  }

  for (const name of fieldNames) {
    const baseField = base.fields.find((f) => f.name === name)
    const field = fileSchema.fields.find((f) => f.name === name)
    if (baseField?.get !== undefined && field !== undefined) {
      field.get = baseField.get
    }
  }
}

/**
 * Installs the onUnknownClass + onSerializeUnknown hooks on nstructjs's
 * global manager so that unknown Node / NodeSocketType / ToolMode /
 * CustomDataElem subclasses are preserved instead of crashing the load. Must be
 * called once at app start, before any file is loaded.
 *
 * The placeholder kind is chosen by sniffing the file schema's field names (the
 * dotted namespace prefix is unreliable across the many subclasses; nstructjs's
 * `inlineRegister` flattens base fields into every subclass schema, so base
 * field names are always present). Every branch also registers the schema into
 * the global manager so the next save can round-trip it.
 */
export function installMissingAddonHooks(): void {
  const manager = getManager()

  manager.onUnknownClass = (clsname: string, fileSchema: FileSchema) => {
    const names = new Set((fileSchema?.fields ?? []).map((f) => f.name))

    // Graph socket: socketName + edges + socketType.
    if (names.has('socketName') && names.has('edges') && names.has('socketType')) {
      registerMissingStructGlobally(clsname, fileSchema)
      reinjectGraphGetters(fileSchema, 'socket')
      return MissingNodeSocket
    }

    // Graph node: inputs + outputs + graph_ui_pos.
    if (names.has('inputs') && names.has('outputs') && names.has('graph_ui_pos')) {
      registerMissingStructGlobally(clsname, fileSchema)
      reinjectGraphGetters(fileSchema, 'node')
      return MissingNode
    }

    // Mesh CustomDataElem subclass (mesh.* + CustomData), if the placeholder
    // has been published by the mesh addon.
    if (clsname.startsWith('mesh.') && clsname.includes('CustomData') && opaqueCustomDataElemCls) {
      registerMissingStructGlobally(clsname, fileSchema)
      return opaqueCustomDataElemCls
    }

    // Fallback: treat as a ToolMode placeholder.
    registerMissingStructGlobally(clsname, fileSchema)
    return MissingToolMode
  }

  manager.onSerializeUnknown = (obj: unknown) => {
    const placeholder = obj as {_origClsname?: string} | null
    return placeholder?._origClsname || undefined
  }
}

/**
 * Wire a per-file `STRUCT` instance so unknown classes route to the placeholder
 * hooks. Copies the global manager's onUnknownClass / onSerializeUnknown onto the
 * per-file `istruct` — the read path resolves the hook off the manager instance
 * that owns the read (plan blocker A). Call after `parse_structs` and after
 * `installMissingAddonHooks()` has populated the global hooks.
 *
 * The `parse_structs` dummy classes no longer need scrubbing here: vendor
 * nstructjs flags them (`isParseStructsDummy`) and the read path now treats a
 * flagged dummy as unknown whenever an `onUnknownClass` hook is installed, so the
 * placeholder / `_origClsname` machinery engages for genuinely-unknown classes
 * while real registered classes are untouched.
 */
export function applyMissingAddonHooks(struct: unknown): void {
  const src = getManager()
  const dst = struct as unknown as NStructManager
  dst.onUnknownClass = src.onUnknownClass
  dst.onSerializeUnknown = src.onSerializeUnknown
}
