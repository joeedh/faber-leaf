export {AttrType} from '@sculptcore/api/sculptcore/mesh/AttrType'

/**
 * LiteMesh element domains. Frozen literals rather than an alias of the mesh
 * addon's `MeshTypes` — they share the values `SelMask` reserves (see
 * `scripts/core/select_types.ts`), but a host module must not derive them from
 * an addon.
 */
export const LTMeshTypes = {
  VERTEX: 1,
  EDGE  : 2,
  FACE  : 4,
  LOOP  : 8,
  HANDLE: 16,
} as const

export type LTMeshType = number
