/**
 * `faber-leaf-core` — the same tree with no sculptcore, for embedders.
 *
 * It is also P16's `no-sculptcore` CI lane, so the engine boundary is exercised
 * by a real product on every PR rather than by a crippled full build. The only
 * difference from `faber-leaf` is this file.
 */

import {defineDistribution, external} from '../../scripts/addon/distribution'

export default defineDistribution({
  id   : 'faber-leaf-core',
  title: 'FaberLeaf Core',

  // No litemesh, so nothing here reaches sculptcore. leafmesh ships default-off
  // in the full product; here it is the only geometry type, so it is on.
  // uv_editor names no geometry type, so it is the same addon in both.
  addons: [external('leafmesh', {enabled: true}), external('uv_editor')],

  defaultScene: 'leafmesh-cube',
})
