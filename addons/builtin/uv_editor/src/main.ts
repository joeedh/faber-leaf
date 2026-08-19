/**
 * UV editor addon entry point — P18 §5 step 3.
 *
 * Out-of-bundle like leafmesh, and for a stronger reason: this addon must not
 * be able to reach a geometry type even by accident. It talks to whatever
 * registered an `IUVSource` and to nothing else, which is exit criterion 11,
 * and a physical build boundary is a better guarantee of that than a lint rule.
 *
 * Default-on in every distribution, including the one with no geometry engine
 * — the editor is useful the moment any source exists.
 *
 * Registration is thin on purpose: the behaviour is `index.ts`, which imports
 * no host value and is unit-tested against the in-memory double. The editor
 * component and the `uveditor.*` ToolOps attach here as they land.
 */

import type {AddonAPI, IAddon, IAddonDefine} from '@framework/api'

import * as uvEditor from './index.js'

export const addonDefine: IAddonDefine = {
  name       : 'UV Editor',
  version    : [1, 0, 0],
  author     : 'joeedh',
  description: 'Edits UV layouts for any geometry type that registers an IUVSource.',
}

export function register(api: AddonAPI<IAddon>) {
  // Keep in sync with addons/builtin/uv_editor/src/api.ts.
  api.exportNamespace('uv_editor', {...uvEditor})
}

export function unregister() {}
export function handleArgv() {}
export function validArgv() {}
