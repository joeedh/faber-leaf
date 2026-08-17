/**
 * The vertex-layout half of the host geometry contract —
 * documentation/geometry-contract.md §10. What is pinned here is that one
 * builder serves both draw paths, and that the slots a material reserves stay
 * reserved.
 */

import {AttrType} from '../../scripts/core/geometry_contract'
import {
  MATERIAL_BASE_VERTEX_ATTRS,
  VertexScalarType,
  buildVertexBufferLayout,
  vertexFormatFor,
  vertexShapeForAttrType,
  vertexStrideFor,
  type VertexAttrDesc,
} from '../../scripts/core/vertex_layout'

const f32 = (slot: number, elemSize: number, name = `a${slot}`): VertexAttrDesc => ({
  name,
  slot,
  elemSize,
  scalar: VertexScalarType.FLOAT32,
})

describe('vertex formats', () => {
  test('a one-component 32-bit attribute uses the unsuffixed format', () => {
    // WebGPU has no `float32x1`; emitting one fails pipeline creation.
    expect(vertexFormatFor({scalar: VertexScalarType.FLOAT32, elemSize: 1})).toBe('float32')
    expect(vertexFormatFor({scalar: VertexScalarType.UINT32, elemSize: 1})).toBe('uint32')
    expect(vertexFormatFor({scalar: VertexScalarType.SINT32, elemSize: 1})).toBe('sint32')
  })

  test('32-bit attributes keep their component count', () => {
    expect(vertexFormatFor({scalar: VertexScalarType.FLOAT32, elemSize: 3})).toBe('float32x3')
    expect(vertexFormatFor({scalar: VertexScalarType.SINT32, elemSize: 4})).toBe('sint32x4')
  })

  test('narrow types widen to a legal format but keep their real stride', () => {
    // There is no `unorm8x3` / `float16x3`; the extra fetched components are
    // discarded, so the stride must come from the shape, not the format.
    const shape = {scalar: VertexScalarType.UNORM8, elemSize: 3}
    expect(vertexFormatFor(shape)).toBe('unorm8x4')
    expect(vertexStrideFor(shape)).toBe(3)

    expect(vertexFormatFor({scalar: VertexScalarType.FLOAT16, elemSize: 2})).toBe('float16x2')
    expect(vertexStrideFor({scalar: VertexScalarType.FLOAT16, elemSize: 2})).toBe(4)
  })
})

describe('buildVertexBufferLayout', () => {
  test('places each attribute at its own slot and nulls the gaps', () => {
    const layout = buildVertexBufferLayout([f32(0, 3), f32(3, 4)])

    expect(layout).toHaveLength(4)
    expect(layout[0]).toEqual({
      arrayStride: 12,
      attributes : [{shaderLocation: 0, offset: 0, format: 'float32x3'}],
    })
    expect(layout[1]).toBeNull()
    expect(layout[2]).toBeNull()
    expect(layout[3]!.arrayStride).toBe(16)
  })

  test('an explicit arrayStride wins over the one the shape implies', () => {
    const layout = buildVertexBufferLayout([{...f32(0, 3), arrayStride: 16}])
    expect(layout[0]!.arrayStride).toBe(16)
    expect(layout[0]!.attributes[0].format).toBe('float32x3')
  })

  test('two attributes on one slot throw rather than silently losing one', () => {
    expect(() => buildVertexBufferLayout([f32(1, 3, 'normal'), f32(1, 2, 'uv')])).toThrow(/claimed twice/)
    expect(() => buildVertexBufferLayout([{...f32(0, 3), slot: -1}])).toThrow(/negative slot/)
  })

  test('an empty set is an empty layout, not a default one', () => {
    expect(buildVertexBufferLayout([])).toEqual([])
  })
})

describe('storage type to vertex shape', () => {
  test('the float and int families map component-for-component', () => {
    expect(vertexShapeForAttrType(AttrType.Float3)).toEqual({
      scalar  : VertexScalarType.FLOAT32,
      elemSize: 3,
    })
    expect(vertexShapeForAttrType(AttrType.Int2)).toEqual({
      scalar  : VertexScalarType.SINT32,
      elemSize: 2,
    })
  })

  test('a type with no vertex representation declines instead of guessing', () => {
    expect(vertexShapeForAttrType(AttrType.Bool)).toBeUndefined()
  })
})

describe('the material base interface', () => {
  test('reserves slots 0 and 1 for position and normal', () => {
    expect(MATERIAL_BASE_VERTEX_ATTRS.map((a) => [a.name, a.slot])).toEqual([
      ['position', 0],
      ['normal', 1],
    ])
  })

  test('is frozen — a provider declaring it must not be able to edit it', () => {
    expect(Object.isFrozen(MATERIAL_BASE_VERTEX_ATTRS)).toBe(true)
    expect(Object.isFrozen(MATERIAL_BASE_VERTEX_ATTRS[0])).toBe(true)
  })

  test('builds the layout a generated material VsIn declares', () => {
    const layout = buildVertexBufferLayout([...MATERIAL_BASE_VERTEX_ATTRS])
    expect(layout.map((l) => l?.attributes[0].format ?? null)).toEqual(['float32x3', 'float32x3'])
  })
})
