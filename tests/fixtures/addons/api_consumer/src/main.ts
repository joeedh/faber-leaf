/**
 * Test fixture: imports from `@addon/leafmesh/api` so the integration test can
 * verify the resolver plugin emits a runtime-lookup stub instead of inlining
 * the addon's source. See tests/integration/addon_api_resolver.test.ts.
 *
 * The named imports here are deliberately the ones leafmesh's api.ts exports as
 * values (not types). If any of these names disappear from that api.ts the
 * build fails loudly, which is the point of the fixture.
 */

import {LeafMesh, LeafMeshData, AttrType, makeCube} from '@addon/leafmesh/api'

export const seen: string[] = []

export const addonDefine = {
  name       : 'API Consumer',
  version    : 1,
  author     : 'tests',
  description: 'Smoke-test for the @addon/<id>/api resolver',
} as const

/** Returns the runtime-resolved symbols so the test can confirm they matched
 * the values the host registered. */
export function getResolvedSymbols() {
  return {LeafMesh, LeafMeshData, AttrType, makeCube}
}

export function register() {
  seen.push('register')
}

export function unregister() {
  seen.push('unregister')
}
