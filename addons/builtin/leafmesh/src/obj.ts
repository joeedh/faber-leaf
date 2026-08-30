/**
 * OBJ import, host-facing half — P11 §6. The parse lives in `obj_read.ts`,
 * which imports nothing from `scripts/`; this file turns the result into a
 * scene object and hands the format to the registry.
 *
 * Registration goes through `AddonAPI.registerFileFormat`, so disabling the
 * addon removes the importer rather than leaving a menu entry that throws.
 * FBX is deliberately out of scope (§6).
 */

import type {IFileFormat, ToolContext} from '@framework/api'
import {InvalidationKind, SceneObject, makeDefaultMaterial} from '@framework/api'

import {LeafMeshData} from './leafmesh.js'
import type {ObjReadStats} from './obj_read.js'
import {readOBJ} from './obj_read.js'

/** Strip the directory and the extension: `models/head.obj` → `head`. */
function blockName(filename: string | undefined): string {
  if (filename === undefined || filename.length === 0) {
    return 'OBJ'
  }

  const base = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base) || 'OBJ'
}

export interface ObjImportResult {
  data: LeafMeshData
  stats: ObjReadStats
}

/** Decode and parse, without touching the scene — the testable half of import. */
export function leafMeshFromOBJ(bytes: Uint8Array, filename?: string): ObjImportResult {
  const data = new LeafMeshData()
  const {stats} = readOBJ(new TextDecoder().decode(bytes), data.mesh)

  data.name = blockName(filename)
  data.invalidate(InvalidationKind.ALL)

  return {data, stats}
}

/**
 * Import into `ctx`'s scene as a new selected, active object, the way the
 * default-scene builder does it.
 */
export function importOBJIntoScene(ctx: ToolContext, bytes: Uint8Array, filename?: string): LeafMeshData {
  const {data, stats} = leafMeshFromOBJ(bytes, filename)
  const lib = ctx.datalib
  const scene = ctx.scene

  lib.add(data)

  const mat = makeDefaultMaterial()
  lib.add(mat)
  data.materials.push(mat)
  mat.lib_addUser(data)

  const ob = new SceneObject()
  lib.add(ob)
  ob.data = data
  ob.name = data.name
  data.lib_addUser(ob)

  scene.add(ob)
  scene.objects.setSelect(ob, true)
  scene.objects.setActive(ob)

  ob.graphUpdate()
  data.graphUpdate()

  if (stats.warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`OBJ import: ${stats.warnings.length} problem(s)`, stats.warnings)
  }
  ctx.message?.(`Imported ${stats.verts} vertices, ${stats.faces} faces`)

  return data
}

export const LEAFMESH_OBJ_FORMAT: IFileFormat<ToolContext> = {
  id        : 'obj',
  uiName    : 'Wavefront OBJ',
  extensions: ['.obj'],

  importFromBytes(ctx, bytes, filename) {
    importOBJIntoScene(ctx, bytes, filename)
  },
}
