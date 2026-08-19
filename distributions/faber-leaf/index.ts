/**
 * `faber-leaf` — the full product. What ships and what developers run.
 *
 * A manifest, not a fork: addon set, startup scene, title. Product logic
 * belongs in an addon. See scripts/addon/distribution.ts for the rules.
 */

import {bundled, defineDistribution, external} from '../../scripts/addon/distribution'

import * as litemesh from '@builtin/litemesh'
import litemeshManifest from '../../addons/builtin/litemesh/manifest.json'

export default defineDistribution({
  id   : 'faber-leaf',
  title: 'FaberLeaf',

  // litemesh is in-bundle; leafmesh and uv_editor ship as their own builds
  // under build/addons/. leafmesh is still default-off here and uv_editor
  // default-on — each addon's manifest says which, and neither is overridden.
  // Order is not load-bearing — the resolver sorts, and the startup scene is
  // chosen by name below.
  addons: [bundled(litemeshManifest, litemesh), external('leafmesh'), external('uv_editor')],

  defaultScene: 'litemesh-sphere',
})
