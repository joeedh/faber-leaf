/**
 * Registry of "data kinds" — the categories of data that can be attached to a
 * SceneObject. Today: 'mesh', 'curve', 'light', 'camera', 'tetmesh', 'litemesh',
 * 'strand', 'nullobject', ... Each scene-object data class declares its kind via
 * `dataDefine().dataKind`; the registry holds factory hooks, importers, and any
 * other per-kind plug-ins the framework needs.
 *
 * Core consumes this registry through callbacks instead of importing concrete
 * data classes; that lets the mesh subsystem (and any other) live in an addon.
 * See plan §3.
 *
 * Like `core/geometry_contract.ts`, this module imports nothing but the
 * contract: a registry whose whole job is to keep the host off concrete types
 * cannot itself name them, and a type-only import is still an edge on the
 * module graph. Hence `GeometryDataRef` for instances and a generic `Ctx` for
 * the app context, which `AddonAPI` binds to the real `ToolContext`.
 */

import {
  resolveKindId,
  asActiveElementSource,
  asAttributeSource,
  asElementSource,
  asInvalidatable,
  asSpatialQueryable,
  asSymmetryAware,
  asTriangleSource,
  hasCapability,
} from './geometry_contract'
import type {
  GeometryCapability,
  GeometryDataRef,
  IActiveElementSource,
  IAttributeSource,
  IElementSource,
  IGeometryKindCapabilities,
  IInvalidatable,
  ISpatialQueryable,
  ISymmetryAware,
  ITriangleSource,
} from './geometry_contract'
import type {VertexAttrDesc} from './vertex_layout'

export interface IDataKindDescriptor<Ctx = unknown> extends IGeometryKindCapabilities {
  /** Stable kind id used by data files and ctx queries. */
  id: string

  /** Constructor for the data type (used by importers, default-factory hooks). */
  factory?: new () => GeometryDataRef

  /** Imports a file of this kind. Receives the bytes, returns a new data instance. */
  importFromBytes?(ctx: Ctx, bytes: Uint8Array, filename?: string): GeometryDataRef | undefined

  /** Optional human-readable name for menus. */
  uiName?: string

  /** Optional list of file extensions this kind can import (e.g. ['.obj']). */
  importExtensions?: string[]

  /**
   * The vertex attributes this kind's draw path binds, by slot — the
   * provider's half of documentation/geometry-contract.md §10. A kind that
   * renders authored materials must cover
   * {@link MATERIAL_BASE_VERTEX_ATTRS}; anything beyond that is the kind's own
   * always-present set, and a material's `AttributeNode` reads are added to it
   * per-material at compile time.
   */
  vertexAttrs?: readonly VertexAttrDesc[]
}

const _kinds = new Map<string, IDataKindDescriptor>()

export function registerDataKind(desc: IDataKindDescriptor): void {
  if (_kinds.has(desc.id)) {
    throw new Error(`data kind "${desc.id}" is already registered`)
  }
  _kinds.set(desc.id, desc)
}

export function unregisterDataKind(id: string): void {
  _kinds.delete(id)
}

export function getDataKind(id: string): IDataKindDescriptor | undefined {
  return _kinds.get(id)
}

export function listDataKinds(): IDataKindDescriptor[] {
  return Array.from(_kinds.values())
}

/** Test-only helper — clears the registry. Do not use from app code. */
export function _resetDataKindsForTests(): void {
  _kinds.clear()
}

// ---------------------------------------------------------------------------
// Capability queries — "ask the registry, never the type"
// ---------------------------------------------------------------------------

/**
 * The kind descriptor for a data instance, or undefined if its kind was never
 * registered. Unregistered is not an error: a provider that only wants the
 * required surface (`documentation/geometry-contract.md` §2) need not register
 * a descriptor at all, it simply claims no optional capabilities.
 */
export function kindOf(data: GeometryDataRef | undefined): IDataKindDescriptor | undefined {
  const id = resolveKindId(data)
  return id ? _kinds.get(id) : undefined
}

export function dataHasCapability(data: GeometryDataRef | undefined, cap: GeometryCapability): boolean {
  return hasCapability(kindOf(data), cap)
}

export function elementSourceOf(data: GeometryDataRef | undefined): IElementSource | undefined {
  return asElementSource(data, kindOf(data))
}

export function invalidatableOf(data: GeometryDataRef | undefined): IInvalidatable | undefined {
  return asInvalidatable(data, kindOf(data))
}

export function spatialQueryableOf(data: GeometryDataRef | undefined): ISpatialQueryable | undefined {
  return asSpatialQueryable(data, kindOf(data))
}

export function attributeSourceOf(data: GeometryDataRef | undefined): IAttributeSource | undefined {
  return asAttributeSource(data, kindOf(data))
}

export function triangleSourceOf(data: GeometryDataRef | undefined): ITriangleSource | undefined {
  return asTriangleSource(data, kindOf(data))
}

export function symmetryAwareOf(data: GeometryDataRef | undefined): ISymmetryAware | undefined {
  return asSymmetryAware(data, kindOf(data))
}

export function activeElementSourceOf(data: GeometryDataRef | undefined): IActiveElementSource | undefined {
  return asActiveElementSource(data, kindOf(data))
}
