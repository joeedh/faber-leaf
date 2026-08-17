/**
 * Mesh Edit addon entry point.
 *
 * Ships in the main bundle (transitively depends on mesh, which is in-bundle).
 * Registered as an in-bundle builtin source by
 * `addons/builtin/builtin_registry.ts` and enabled through the unified
 * pipeline; this module's `register(api)` registers its classes + publishes its
 * surface.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'
import {MeshToolBase} from './meshtool.js'
import {MeshEditor} from './mesheditor.js'

export const addonDefine: IAddonDefine = {
  name       : 'Mesh Edit',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Mesh-editing toolmode (vertex/edge/face selection, transform, ops).',
}

export function register(api: AddonAPI<IAddon>) {
  // Keep in sync with `addons/builtin/mesh_edit/src/api.ts`.
  api.exportNamespace('mesh_edit', {MeshToolBase, MeshEditor})
  api.registerAll(MeshToolBase, MeshEditor)

  // Contribute the primitive-creation ops to the View3D "Add" menu. These were
  // formerly hard-coded in MainMenu.js; the menu builder now assembles them from
  // every enabled addon, and these are removed automatically on disable.
  const SEP = api.pathux.Menu.SEP
  api.menuEntries('add', [
    'mesh.procedural_add()',
    SEP,
    'mesh.make_cube()',
    'mesh.make_sphere()',
    'mesh.make_ico_sphere()',
    'mesh.make_cylinder()',
  ])

  api.registerLegacyStructNames({
    MeshEditor  : 'mesh_edit.MeshEditor',
    MeshToolBase: 'mesh_edit.MeshToolBase',
  })
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
