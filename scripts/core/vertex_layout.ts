/**
 * The vertex-layout half of the host geometry contract —
 * documentation/geometry-contract.md §10.
 *
 * A pipeline's `vertexBuffers` array is positional: entry `n` describes the
 * buffer the draw path binds at slot `n`, and `null` means "the shader declares
 * no `@location(n)`". Building that array from a declared attribute set is the
 * same computation everywhere, so it lives here once — sculptcore's batch
 * executor and the host's material compile sites both call it.
 *
 * Like the rest of `core/`, this module imports nothing but the contract.
 */

import {AttrType} from './geometry_contract'

/**
 * Scalar component type of a vertex attribute, in GPU terms. Deliberately not
 * {@link AttrType}: that is a *storage* vocabulary (what a layer holds), this is
 * a *vertex-fetch* vocabulary (how the rasterizer reads it). `UNORM8` is the
 * pair's one asymmetry — a byte layer is fetched normalized, not as an integer.
 */
export enum VertexScalarType {
  FLOAT32 = 0,
  FLOAT16 = 1,
  UNORM8 = 2,
  UINT16 = 3,
  UINT32 = 4,
  SINT16 = 5,
  SINT32 = 6,
}

/** The shape of one attribute: a scalar type and a component count. */
export interface VertexAttrShape {
  scalar: VertexScalarType
  /** Component count, 1–4. */
  elemSize: number
}

/** One attribute a pipeline consumes, at the `@location` the shader declares. */
export interface VertexAttrDesc extends VertexAttrShape {
  /** Source attribute name on the geometry (`position`, `normal`, `uv`, …). */
  name: string
  /** Vertex `@location`, and the buffer slot the draw path must bind it at. */
  slot: number
  /** Byte stride, when the source buffer's is not the one the shape implies
   * (padded elements, or a component type WebGPU cannot fetch directly). */
  arrayStride?: number
}

const SCALAR_BYTES: Readonly<Record<VertexScalarType, number>> = {
  [VertexScalarType.FLOAT32]: 4,
  [VertexScalarType.FLOAT16]: 2,
  [VertexScalarType.UNORM8] : 1,
  [VertexScalarType.UINT16] : 2,
  [VertexScalarType.UINT32] : 4,
  [VertexScalarType.SINT16] : 2,
  [VertexScalarType.SINT32] : 4,
}

/** Bytes one element of this attribute occupies, and so its `arrayStride`. */
export function vertexStrideFor(shape: VertexAttrShape): number {
  return SCALAR_BYTES[shape.scalar] * Math.max(1, shape.elemSize)
}

/**
 * The `GPUVertexFormat` for a shape. WebGPU has no 1- or 3-component 8/16-bit
 * vertex formats, so those widen to the next legal one — the extra components
 * are read and discarded, which is why the stride comes from
 * {@link vertexStrideFor} and not from the format.
 *
 * A narrower format than the WGSL variable is legal and intended: `float32x3`
 * data into a `vec4f` input default-fills the missing components (w to 1).
 */
export function vertexFormatFor(shape: VertexAttrShape): GPUVertexFormat {
  const n = Math.max(1, Math.min(shape.elemSize, 4))
  const wide = n >= 3 ? 4 : 2

  switch (shape.scalar) {
    case VertexScalarType.FLOAT32:
      return (n === 1 ? 'float32' : `float32x${n}`) as GPUVertexFormat
    case VertexScalarType.UINT32:
      return (n === 1 ? 'uint32' : `uint32x${n}`) as GPUVertexFormat
    case VertexScalarType.SINT32:
      return (n === 1 ? 'sint32' : `sint32x${n}`) as GPUVertexFormat
    case VertexScalarType.FLOAT16:
      return `float16x${wide}` as GPUVertexFormat
    case VertexScalarType.UNORM8:
      return `unorm8x${wide}` as GPUVertexFormat
    case VertexScalarType.UINT16:
      return `uint16x${wide}` as GPUVertexFormat
    case VertexScalarType.SINT16:
      return `sint16x${wide}` as GPUVertexFormat
    default:
      return 'float32x4'
  }
}

/**
 * The positional `vertexBuffers` descriptor for a declared attribute set. Slots
 * no attribute claims come back `null`; the array is exactly long enough to
 * hold the highest claimed slot. A duplicate slot is a caller bug and throws —
 * silently keeping one of the two produces a pipeline that draws garbage.
 */
export function buildVertexBufferLayout(attrs: Iterable<VertexAttrDesc>): (GPUVertexBufferLayout | null)[] {
  const out: (GPUVertexBufferLayout | null)[] = []

  for (const attr of attrs) {
    if (attr.slot < 0) {
      throw new Error(`vertex attribute "${attr.name}" has a negative slot ${attr.slot}`)
    }
    while (out.length <= attr.slot) {
      out.push(null)
    }
    if (out[attr.slot]) {
      throw new Error(`vertex slot ${attr.slot} claimed twice (by "${attr.name}")`)
    }

    out[attr.slot] = {
      arrayStride: attr.arrayStride ?? vertexStrideFor(attr),
      attributes : [{shaderLocation: attr.slot, offset: 0, format: vertexFormatFor(attr)}],
    }
  }

  return out
}

/**
 * The vertex shape a storage {@link AttrType} fetches as, or undefined when the
 * type has no vertex representation at all (`Bool`) and must be converted by
 * the provider before it can be bound.
 */
export function vertexShapeForAttrType(type: AttrType): VertexAttrShape | undefined {
  switch (type) {
    case AttrType.Float:
      return {scalar: VertexScalarType.FLOAT32, elemSize: 1}
    case AttrType.Float2:
      return {scalar: VertexScalarType.FLOAT32, elemSize: 2}
    case AttrType.Float3:
      return {scalar: VertexScalarType.FLOAT32, elemSize: 3}
    case AttrType.Float4:
      return {scalar: VertexScalarType.FLOAT32, elemSize: 4}
    case AttrType.Int:
      return {scalar: VertexScalarType.SINT32, elemSize: 1}
    case AttrType.Int2:
      return {scalar: VertexScalarType.SINT32, elemSize: 2}
    case AttrType.Int3:
      return {scalar: VertexScalarType.SINT32, elemSize: 3}
    case AttrType.Int4:
      return {scalar: VertexScalarType.SINT32, elemSize: 4}
    case AttrType.Short:
      return {scalar: VertexScalarType.SINT16, elemSize: 1}
    case AttrType.Byte:
      return {scalar: VertexScalarType.UNORM8, elemSize: 1}
    default:
      return undefined
  }
}

/**
 * The vertex interface every generated material shader declares before its
 * requested attributes (`shader_nodes_wgsl.ts`'s `VsIn`). A geometry provider
 * that wants to render authored materials must bind these two slots; the
 * material's own `AttributeNode` reads start at slot 2.
 */
export const MATERIAL_BASE_VERTEX_ATTRS: readonly VertexAttrDesc[] = Object.freeze([
  Object.freeze({name: 'position', slot: 0, scalar: VertexScalarType.FLOAT32, elemSize: 3}),
  Object.freeze({name: 'normal', slot: 1, scalar: VertexScalarType.FLOAT32, elemSize: 3}),
])

/**
 * One attribute a compiled material asks the geometry to bind: which layer, at
 * which `@location`, how many components wide. The shader generator's own
 * descriptor carries more (WGSL field name, category) and extends this; a
 * provider needs only these three to satisfy the request.
 */
export interface MaterialAttrRequest {
  /** Attribute-layer name on the geometry (e.g. `uv`, `color`). */
  name: string
  /** Vertex `@location` the generator assigned — always 2 or above. */
  slot: number
  /** Component count the shader declares, 2-4. */
  elemSize: number
}

/**
 * Optional provider capability (geometry-contract §10.2): take the material's requested set so the
 * next draw binds those attributes by name. Both material compile sites push it
 * whenever the compiled set changes. A provider that renders only the base
 * attributes does not implement it and is simply never called.
 */
export interface IMaterialAttrConsumer {
  setRequestedAttrs(reqs: readonly MaterialAttrRequest[]): void
}

/**
 * Feature-detect {@link IMaterialAttrConsumer}. Detected rather than declared
 * on the kind descriptor, because the two compile sites also serve providers
 * that predate the kind registry.
 */
export function asMaterialAttrConsumer(data: unknown): IMaterialAttrConsumer | undefined {
  const consumer = data as Partial<IMaterialAttrConsumer> | undefined
  return typeof consumer?.setRequestedAttrs === 'function' ? (consumer as IMaterialAttrConsumer) : undefined
}
