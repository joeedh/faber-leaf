/**
 * `OpaqueCustomDataElem` — placeholder for a `CustomDataElem` subclass whose
 * addon isn't loaded. Lives in the mesh addon because `CustomDataElem` is
 * mesh-defined; the addon publishes it to core's `missing_addon.ts` from its
 * `register(api)` hook (see `main.ts`) so the layer rule `core-no-addons`
 * stays clean. See plan §3.
 */

import {nstructjs} from '@framework/pathux'
import {CustomDataElem} from './customdata.js'

/**
 * Stand-in for a `CustomDataElem` subclass whose addon isn't loaded. Holds
 * the original struct name + any dynamic fields nstructjs deposited from the
 * file's schema. Intentionally NOT registered through
 * `CustomDataElem.register()` so it doesn't appear in the customdata menus —
 * its only purpose is to keep bytes alive across save/reload.
 */
export class OpaqueCustomDataElem extends CustomDataElem<unknown> {
  _origClsname: string = ''

  static define() {
    return {
      elemTypeMask: 0,
      typeName    : 'OpaqueCustomDataElem',
      uiTypeName  : 'Missing (Addon Disabled)',
      defaultName : 'Missing',
      valueSize   : undefined,
      flag        : 0,
    }
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
OpaqueCustomDataElem {
  _origClsname : string;
}
  `
  )
}
