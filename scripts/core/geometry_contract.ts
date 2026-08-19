/**
 * The host geometry contract — everything the host is permitted to ask of
 * geometry, and nothing else.
 *
 * Normative prose: `documentation/geometry-contract.md`. Read it first; this
 * file is the machine-checkable half and assumes you know why each group exists.
 *
 * Three rules govern edits here:
 *  - **No concrete geometry type may be named.** Not in a type, not in a doc
 *    comment except in §12-style "who implements this" notes, and never as an
 *    import. If you cannot describe a capability without naming one, it is not
 *    yet a contract.
 *  - **Optional capabilities are declared, then queried.** A provider opts in by
 *    listing the capability on its kind descriptor *and* implementing the
 *    interface. Duck-typing is not opting in — see {@link asElementSource}.
 *  - **Bulk in, bulk out.** No accessor takes or returns a single element. A
 *    provider whose geometry lives behind a WASM or worker boundary must not pay
 *    a round trip per element, and the only way to guarantee that is to make the
 *    per-element call unspellable.
 *
 * This module imports nothing but `path.ux` vector types, and that is a rule
 * too: a contract that reaches into the host it constrains is not a contract.
 * The required surface (§2) is therefore declared where it is implemented, in
 * `sceneobject/sceneobject_base.ts`, whose imports it already needs; the
 * optional, host-independent half lives here.
 */

import type {Vector3} from '../path.ux/scripts/pathux.js'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Element domains. Not every provider has all five; a provider declares which
 * it has via {@link IElementSource.hasDomain} and the host must ask first.
 *
 * The numbering is shared with the geometry backends and with the engine's
 * attribute vocabulary on purpose — a layer should round-trip as a column copy,
 * not as a conversion. `tests/unit/geometry_contract.test.ts` pins the
 * agreement; do not renumber one side.
 */
export enum ElementDomain {
  VERT = 0,
  EDGE = 1,
  CORNER = 2,
  LOOP = 3,
  FACE = 4,
}

export const ELEMENT_DOMAIN_COUNT = 5

/** Attribute value types. Shares numbering with {@link ElementDomain}'s note. */
export enum AttrType {
  Float = 0,
  Float2 = 1,
  Float3 = 2,
  Float4 = 3,
  Int = 4,
  Int2 = 5,
  Int3 = 6,
  Int4 = 7,
  Short = 8,
  Byte = 9,
  Bool = 10,
}

/**
 * An opaque element identifier. The host must not do arithmetic on it, infer
 * ordering from it, or persist it. It is valid only until the owning provider's
 * {@link IElementSource.topoStamp} changes.
 */
export type ElementHandle = number

/** A batch of handles. `Int32Array` is the preferred concrete form. */
export type ElementHandles = Int32Array | readonly ElementHandle[]

/**
 * What the *caller* changed — never what the provider should rebuild. The
 * provider derives its own rebuild set, because only it knows what it caches.
 */
export enum InvalidationKind {
  TOPOLOGY = 1,
  POSITIONS = 2,
  ATTRIBUTES = 4,
  SELECTION = 8,
  MATERIALS = 16,
  ALL = 1 | 2 | 4 | 8 | 16,
}

/** Optional capabilities, declared on the kind descriptor and queried by the host. */
export enum GeometryCapability {
  /** Element iteration and stable handles (§4). */
  ELEMENTS = 'elements',
  /** Fine-grained {@link IInvalidatable.invalidate} instead of full rebuild (§5). */
  INVALIDATION = 'invalidation',
  /** Accelerated nearest-element queries (§6). */
  SPATIAL = 'spatial',
  /** Named per-element attribute layers (§7). */
  ATTRIBUTES = 'attributes',
  /** Triangle extraction for export and host-side analysis (§7). */
  TRIANGLES = 'triangles',
  /** Mirror/symmetry state honoured by transforms (§7). */
  SYMMETRY = 'symmetry',
  /** Active and highlighted element, fed to shader uniforms (§7). */
  ACTIVE_ELEMENT = 'activeElement',
}

/**
 * One vertex attribute a kind supplies to materials. `location` is the WGSL
 * `@location` the attribute binds to; the host builds a vertex-buffer layout
 * from the declared set rather than from a fixed global default. See §10.
 */
export interface IDeclaredAttribute {
  readonly name: string
  readonly type: AttrType
  readonly domain: ElementDomain
  readonly location: number
}

// ---------------------------------------------------------------------------
// Optional capabilities
// ---------------------------------------------------------------------------

/**
 * Element iteration and stable handles (§4). Every accessor is bulk; there is
 * no single-element form on purpose.
 *
 * `out` parameters let a caller reuse scratch buffers across a stroke. A
 * provider must honour a correctly-sized `out` and is free to allocate when one
 * is absent or too small. What comes back may be a *view* onto `out` rather
 * than `out` itself, so compare buffers, never object identity.
 */
export interface IElementSource {
  /**
   * Bumped whenever held handles may have become stale. Read before a batch,
   * re-read after; a provider may bump it conservatively.
   */
  readonly topoStamp: number

  hasDomain(domain: ElementDomain): boolean
  elementCount(domain: ElementDomain): number

  listElements(domain: ElementDomain, out?: Int32Array): Int32Array
  listSelected(domain: ElementDomain, out?: Int32Array): Int32Array

  /** Positions for `n` handles, as `3n` components. */
  getPositions(domain: ElementDomain, handles: ElementHandles, out?: Float64Array): Float64Array
  setPositions(domain: ElementDomain, handles: ElementHandles, co: Float64Array): void

  getSelected(domain: ElementDomain, handles: ElementHandles, out?: Uint8Array): Uint8Array
  setSelected(domain: ElementDomain, handles: ElementHandles, selected: Uint8Array): void
}

/**
 * The invalidation protocol (§5). One method replaces the nine-name vocabulary
 * the host used before P7; `range` is an optimisation hint a provider may ignore.
 */
export interface IInvalidatable {
  invalidate(what: InvalidationKind, domain?: ElementDomain, range?: ElementHandles): void
}

/**
 * Spatial queries (§6). The contract exposes the *query*, never the structure —
 * there is no `getBVH()` and there must never be one. A provider without an
 * acceleration structure may answer by brute force.
 */
export interface ISpatialQueryable {
  closestElements(co: Vector3, radius: number, domain: ElementDomain, out?: Int32Array): Int32Array
}

export interface IAttributeLayerInfo {
  readonly name: string
  readonly type: AttrType
  readonly domain: ElementDomain
  readonly active: boolean
}

/** Named, typed, per-domain attribute layers (§7). */
export interface IAttributeSource {
  listAttributes(domain?: ElementDomain): readonly IAttributeLayerInfo[]
  getAttribute(domain: ElementDomain, name: string, handles: ElementHandles, out?: ArrayBufferView): ArrayBufferView
  setAttribute(domain: ElementDomain, name: string, handles: ElementHandles, values: ArrayBufferView): void
  setActiveAttribute(domain: ElementDomain, name: string): void
}

/** Triangle extraction (§7) — the cheapest end-to-end proof a type is wired in. */
export interface ITriangleSource {
  extractTriangles(): {positions: Float64Array; indices: Int32Array; normals?: Float64Array}
}

/** Mirror/symmetry state (§7), read by transforms. Bit per axis: 1=x, 2=y, 4=z. */
export interface ISymmetryAware {
  readonly symmetryAxes: number
}

/** Active and highlighted element (§7), fed to shader uniforms. */
export interface IActiveElementSource {
  getActiveElement(domain: ElementDomain): ElementHandle | undefined
  getHighlightElement(domain: ElementDomain): ElementHandle | undefined
}

// ---------------------------------------------------------------------------
// UV editing (§11)
// ---------------------------------------------------------------------------

/** Per-UV-element state. Bit flags so a whole layer round-trips as one column. */
export enum UVFlags {
  SELECT = 1,
  PIN = 2,
}

/**
 * The UV-editing surface, reached through the `core/uv_sources.ts` resolver
 * rather than a capability narrow — a source need not be the geometry object.
 *
 * A *UV element* is one (geometry element, layer) pair — a corner on a mesh
 * that stores UVs per corner, a vertex on one that stores them per vertex — and
 * its handle obeys the same rules as {@link ElementHandle}: opaque, and valid
 * only until {@link IUVSource.topoStamp} changes. Every accessor is bulk, for
 * the reason given in this file's header.
 */
export interface IUVSource {
  /**
   * Handle-validity stamp, carrying {@link IElementSource.topoStamp}'s meaning
   * and, where a source is both, its value. Declared here as well so that a
   * source with no geometry behind it is still a complete one.
   */
  readonly topoStamp: number

  /** Layer names in layer order; an index into this array is a `layer`. */
  listUVLayers(): readonly string[]

  /** Layer the UV editor edits by default, or -1 when there are no layers. */
  readonly activeUVLayer: number

  /** The domain UV elements live on — per-corner and per-vertex both occur. */
  readonly uvDomain: ElementDomain

  /**
   * UV element handles in `layer`. Restricted to those owned by `owners` when
   * given, which is how the editor scopes to a selection without a per-element
   * query.
   */
  listUVElements(layer: number, owners?: ElementHandles): Int32Array

  /**
   * The geometry element each UV element belongs to, in {@link uvDomain}. This
   * is the only primitive needed to keep a 3D selection and a UV selection in
   * sync, in either direction.
   */
  getUVOwners(layer: number, handles: ElementHandles, out?: Int32Array): Int32Array

  /** `2n` components for `n` handles, u before v. */
  getUVs(layer: number, handles: ElementHandles, out?: Float32Array): Float32Array
  setUVs(layer: number, handles: ElementHandles, uv: Float32Array): void

  getUVFlags(layer: number, handles: ElementHandles, out?: Uint8Array): Uint8Array
  setUVFlags(layer: number, handles: ElementHandles, flags: Uint8Array): void

  /**
   * The UV elements coincident with each of `handles` — what "welded" means for
   * a move, and what "select linked" walks. Returned CSR-style because the
   * per-handle fan sizes vary: `offsets` has `handles.length + 1` entries and
   * indexes `values`. A per-handle call would be a round trip per element.
   */
  getUVFans(layer: number, handles: ElementHandles): {offsets: Int32Array; values: Int32Array}

  /**
   * Faces carrying UV data in `layer`. `selectedOnly` restricts them to the
   * source's selected faces, which is the entire meaning of the editor's
   * `selectedFacesOnly` — the filter belongs to the source, not to editor state.
   */
  listUVFaces(layer: number, selectedOnly?: boolean): Int32Array

  /**
   * Each face's UV elements in winding order, CSR-style like
   * {@link IUVSource.getUVFans}: `offsets` has `faces.length + 1` entries and
   * indexes `values`. It is what the editor draws and picks against; without it
   * a caller would rebuild rings out of the geometry, which is the BREP-shaped
   * coupling this contract exists to prevent.
   */
  getUVFaceRings(layer: number, faces: ElementHandles): {offsets: Int32Array; values: Int32Array}
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * A scene-object data instance, seen from the contract. Structural on purpose:
 * naming the class here would drag the whole host into a module that is meant to
 * constrain it. The narrowing helpers below only ever cast it.
 */
export type GeometryDataRef = object

/**
 * Resolve a data instance's kind id: `dataDefine().dataKind`, falling back to a
 * lowercased `dataDefine().name`, cached on the constructor.
 *
 * It lives in this module — which imports nothing — so that both the registry
 * (`core/data_kinds.ts`) and the base class (`SceneObjectData.dataKindOf`) can
 * call the one copy. Either of those importing the other closes a cycle, and two
 * copies of the rule would eventually disagree.
 */
export function resolveKindId(data: GeometryDataRef | undefined): string | undefined {
  if (!data) {
    return undefined
  }

  const ctor = data.constructor as unknown as {
    dataDefine?: () => {dataKind?: string; name?: string}
    _cachedDataKind?: string
  }

  if (typeof ctor._cachedDataKind === 'string') {
    return ctor._cachedDataKind
  }
  if (typeof ctor.dataDefine !== 'function') {
    return undefined
  }

  const def = ctor.dataDefine()
  const kind = def.dataKind ?? (def.name ? def.name.toLowerCase() : undefined)
  ctor._cachedDataKind = kind
  return kind
}

/**
 * The capability half of a kind descriptor. Split out so `core/data_kinds.ts`
 * can mix it into `IDataKindDescriptor` without this file depending on the
 * registry (which depends on this one).
 */
export interface IGeometryKindCapabilities {
  /** Optional capabilities this kind claims. Absent means none. */
  capabilities?: readonly GeometryCapability[]
  /** Vertex attributes this kind supplies to materials (§10). */
  attributes?: readonly IDeclaredAttribute[]
  /** Whether the kind participates in material slots. */
  usesMaterial?: boolean
}

export function hasCapability(kind: IGeometryKindCapabilities | undefined, cap: GeometryCapability): boolean {
  return !!kind?.capabilities?.includes(cap)
}

/**
 * Narrow `data` to a capability interface, but only if its kind *declared* the
 * capability. Duck-typing deliberately does not qualify: a provider that
 * happens to have the methods but did not declare them will not be routed to,
 * because the host gates UI on the declaration and a silently-working call path
 * would let the two disagree.
 */
function narrow<T>(
  data: GeometryDataRef | undefined,
  kind: IGeometryKindCapabilities | undefined,
  cap: GeometryCapability
): T | undefined {
  if (!data || !hasCapability(kind, cap)) {
    return undefined
  }
  return data as unknown as T
}

export function asElementSource(
  data: GeometryDataRef | undefined,
  kind: IGeometryKindCapabilities | undefined
): IElementSource | undefined {
  return narrow<IElementSource>(data, kind, GeometryCapability.ELEMENTS)
}

export function asInvalidatable(
  data: GeometryDataRef | undefined,
  kind: IGeometryKindCapabilities | undefined
): IInvalidatable | undefined {
  return narrow<IInvalidatable>(data, kind, GeometryCapability.INVALIDATION)
}

export function asSpatialQueryable(
  data: GeometryDataRef | undefined,
  kind: IGeometryKindCapabilities | undefined
): ISpatialQueryable | undefined {
  return narrow<ISpatialQueryable>(data, kind, GeometryCapability.SPATIAL)
}

export function asAttributeSource(
  data: GeometryDataRef | undefined,
  kind: IGeometryKindCapabilities | undefined
): IAttributeSource | undefined {
  return narrow<IAttributeSource>(data, kind, GeometryCapability.ATTRIBUTES)
}

export function asTriangleSource(
  data: GeometryDataRef | undefined,
  kind: IGeometryKindCapabilities | undefined
): ITriangleSource | undefined {
  return narrow<ITriangleSource>(data, kind, GeometryCapability.TRIANGLES)
}

export function asSymmetryAware(
  data: GeometryDataRef | undefined,
  kind: IGeometryKindCapabilities | undefined
): ISymmetryAware | undefined {
  return narrow<ISymmetryAware>(data, kind, GeometryCapability.SYMMETRY)
}

export function asActiveElementSource(
  data: GeometryDataRef | undefined,
  kind: IGeometryKindCapabilities | undefined
): IActiveElementSource | undefined {
  return narrow<IActiveElementSource>(data, kind, GeometryCapability.ACTIVE_ELEMENT)
}

// ---------------------------------------------------------------------------
// Compile-time conformance
// ---------------------------------------------------------------------------

/**
 * `type _ = AssertExtends<MyType, IGeometrySource>` fails to compile unless
 * `MyType` really satisfies the interface. Implementors put one of these next
 * to their class declaration; that is the contract's primary gate, and it is a
 * typecheck rather than a runtime test on purpose.
 */
export type AssertExtends<T extends U, U> = T
