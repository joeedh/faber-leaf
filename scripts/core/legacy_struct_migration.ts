import {nstructjs} from '../path.ux/scripts/pathux.js'

/**
 * Legacy struct-name migration for nstructjs inherit -> inlineRegister.
 *
 * Background: classes that used the deprecated `nstructjs.inherit(Child, Parent)`
 * form WITHOUT an explicit struct name registered under their bare class name
 * (e.g. `StrandSet`, `NumProperty`, `MeshEditor`). Because the bundler emits
 * those as `var X = class extends Y {}`, the runtime `.name` could even end up
 * collision-mangled (observed: `CurvVert2` -> `CurvVert22`, `DispLayerVert` ->
 * `DispLayerVert3`). Files saved by those builds embed the bare/mangled name in
 * their self-describing schema block.
 *
 * Those classes now register under stable module-qualified names via
 * `nstructjs.inlineRegister(this, `module.Class { ... }`)`. When loading a
 * legacy file, its embedded schema still names the structs by their old name,
 * so `STRUCT.parse_structs` cannot match them to the renamed classes and would
 * silently deserialize them into empty dummy classes (data loss).
 *
 * Fix: before `parse_structs`, rewrite the embedded schema by parsing it into
 * the nstructjs AST, renaming both struct DECLARATIONS and struct TYPE
 * REFERENCES (in `array(...)`, `iter(...)`, `abstract(...)`, `optional(...)`,
 * `static_array[...]`) through the map below, then re-emitting via the
 * canonical `STRUCT.fmt_struct` serializer. Struct *ids* are preserved, so the
 * binary body's polymorphic id->struct references keep resolving — only the
 * name attached to each id changes, which is exactly what lets `readObject`
 * find the renamed class.
 *
 * The map is keyed by every old name a file could contain (bare source name and,
 * where applicable, the collision-mangled bundle name). New module-qualified
 * names are never keys, so this pass is a no-op for files written after the
 * migration. Generated from `.migration-ref/name-map.json` (renamed entries).
 *
 * The table below holds only the *host-owned* structs. Entries whose target
 * lives in an addon are contributed by that addon through
 * {@link registerLegacyStructNames}, so a renamed struct's migration entry
 * travels with the struct rather than accumulating in core (plan §2.4).
 */
export const HOST_LEGACY_STRUCT_NAMES: Record<string, string> = {
  BSplineCurve        : 'curve1d.BSplineCurve',
  BVHToolMode         : 'view3d.BVHToolMode',
  BoolProperty        : 'toolprop.BoolProperty',
  BounceCurve         : 'curve1d.BounceCurve',
  CodeEditor          : 'code_editor.CodeEditor',
  CurvToolMode        : 'curvetest.CurvToolMode',
  DataPathBrowser     : 'editors.DataPathBrowser',
  DrawerEditor        : 'editors.DrawerEditor',
  EaseCurve           : 'curve1d.EaseCurve',
  ElasticCurve        : 'curve1d.ElasticCurve',
  EquationCurve       : 'curve1d.EquationCurve',
  FloatArrayProperty  : 'toolprop.FloatArrayProperty',
  GraphItToolMode     : 'graphit.GraphItToolMode',
  GuassianCurve       : 'curve1d.GuassianCurve',
  ImageEditor         : 'image.ImageEditor',
  ImageNode           : 'shader.ImageNode',
  IntProperty         : 'toolprop.IntProperty',
  ListProperty        : 'toolprop.ListProperty',
  Mat4Property        : 'toolprop.Mat4Property',
  MixNode             : 'shader.MixNode',
  MorphEditor         : 'morph.MorphEditor',
  MorphToolMode       : 'morph.MorphToolMode',
  NodeGroup           : 'graph.NodeGroup',
  NodeGroupInputs     : 'graph.NodeGroupInputs',
  NodeGroupInst       : 'graph.NodeGroupInst',
  NodeGroupOutputs    : 'graph.NodeGroupOutputs',
  NodeViewer          : 'node.NodeViewer',
  NullObject          : 'nullobject.NullObject',
  NumProperty         : 'toolprop.NumProperty',
  ObjectEditor        : 'view3d.ObjectEditor',
  PFace               : 'subsurf_tester.PFace',
  PVert               : 'subsurf_tester.PVert',
  PanToolMode         : 'view3d.PanToolMode',
  ParamToolMode       : 'parameterizer.ParamToolMode',
  PatchTester         : 'subsurf_tester.PatchTester',
  QuatProperty        : 'toolprop.QuatProperty',
  RandCurve           : 'curve1d.RandCurve',
  SimpleCurveBase     : 'curve1d.SimpleCurveBase',
  Strand              : 'hair.Strand',
  StrandSet           : 'hair.StrandSet',
  StrandTool          : 'strand.StrandTool',
  StringSetProperty   : 'toolprop.StringSetProperty',
  SubsurfTangentTester: 'subsurf_tester.SubsurfTangentTester',
  Vec2Property        : 'toolprop.Vec2Property',
  Vec3Property        : 'toolprop.Vec3Property',
  Vec4Property        : 'toolprop.Vec4Property',
  _NumberPropertyBase : 'toolprop._NumberPropertyBase',
}

const contributions = new Map<string, Record<string, string>>()

/** Invalidated whenever a contribution is added or removed. */
let mergedMap: Record<string, string> | undefined
let mergedRE: RegExp | undefined

/**
 * Contribute legacy struct-name entries owned by `ownerId` (an addon id).
 * Registering twice under the same id replaces the previous set.
 */
export function registerLegacyStructNames(ownerId: string, entries: Record<string, string>): void {
  contributions.set(ownerId, entries)
  mergedMap = undefined
  mergedRE = undefined
}

export function unregisterLegacyStructNames(ownerId: string): void {
  contributions.delete(ownerId)
  mergedMap = undefined
  mergedRE = undefined
}

/** The host table plus every live contribution. Host entries never lose. */
export function getLegacyStructNameMap(): Record<string, string> {
  if (mergedMap === undefined) {
    mergedMap = {}
    for (const entries of contributions.values()) {
      Object.assign(mergedMap, entries)
    }
    Object.assign(mergedMap, HOST_LEGACY_STRUCT_NAMES)
  }
  return mergedMap
}

// Matches any old name as a standalone identifier token. The leading
// `(?<![.\w])` guard means a module-qualified NEW name (e.g. `hair.Strand`) does
// NOT match the bare key (`Strand`), so files written after the migration skip
// parsing entirely. Used only as a cheap pre-check — correctness does not depend
// on it (the parse loop renames by exact equality).
function legacyNameRE(): RegExp {
  if (mergedRE === undefined) {
    mergedRE = new RegExp(
      '(?<![.\\w])(?:' +
        Object.keys(getLegacyStructNameMap())
          .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|') +
        ')(?![\\w])'
    )
  }
  return mergedRE
}

/** Test-only helper — clears every contribution, leaving the host table. */
export function _resetLegacyStructNamesForTests(): void {
  contributions.clear()
  mergedMap = undefined
  mergedRE = undefined
}

const StructEnum = nstructjs.parser.StructEnum as Record<string, number>

/**
 * Recursively rewrite any struct-name references buried in a field's
 * TypeDescriptor tree. Returns true if anything was renamed.
 */
function renameTypeRefs(type: any, map: Record<string, string>): boolean {
  if (!type || typeof type !== 'object') {
    return false
  }

  switch (type.type) {
    case StructEnum.STRUCT:
    case StructEnum.TSTRUCT: {
      // .data holds the referenced struct name
      const repl = map[type.data]
      if (repl !== undefined) {
        type.data = repl
        return true
      }
      return false
    }
    case StructEnum.ARRAY:
    case StructEnum.ITER:
    case StructEnum.ITERKEYS:
    case StructEnum.STATIC_ARRAY:
      // container types nest the element descriptor under .data.type
      return renameTypeRefs(type.data?.type, map)
    case StructEnum.OPTIONAL:
      // optional(T) nests the descriptor directly under .data
      return renameTypeRefs(type.data, map)
    default:
      return false
  }
}

/**
 * Rewrite the embedded schema text of a legacy file so old struct names map to
 * their new module-qualified names. Idempotent and a no-op for files that
 * contain no legacy names (returns the input unchanged). Never throws: on any
 * parse/emit failure it logs and returns the original text so loading can
 * proceed (the loader's existing missing-struct handling then applies).
 */
export function remapLegacyStructSchema(structsText: string): string {
  if (!structsText || !legacyNameRE().test(structsText)) {
    return structsText
  }

  const map = getLegacyStructNameMap()

  try {
    const parser = nstructjs.parser.struct_parse
    const STRUCT = nstructjs.STRUCT as unknown as {
      fmt_struct(stt: unknown): string
    }

    parser.input(structsText)

    let out = ''
    let changed = false

    while (!parser.at_end()) {
      const stt = parser.parse(undefined, false) as {
        name: string
        fields: {type: unknown}[]
      }

      const repl = map[stt.name]
      if (repl !== undefined) {
        stt.name = repl
        changed = true
      }

      for (const f of stt.fields) {
        if (renameTypeRefs(f.type, map)) {
          changed = true
        }
      }

      out += STRUCT.fmt_struct(stt) + '\n'

      // Consume trailing whitespace between structs (and after the final one) so
      // `at_end()` becomes true at EOF — this mirrors STRUCT.parse_structs, which
      // tolerates the trailing newline that write_scripts always emits.
      let tok = parser.peek() as {value?: string} | undefined
      while (tok && (tok.value === '\n' || tok.value === '\r' || tok.value === '\t' || tok.value === ' ')) {
        tok = parser.peek() as {value?: string} | undefined
      }
    }

    // If nothing actually changed, keep the original text verbatim rather than
    // risk any cosmetic round-trip difference from the re-emit.
    return changed ? out : structsText
  } catch (error) {
    console.warn('legacy struct-schema migration failed; loading file as-is', error)
    return structsText
  }
}
