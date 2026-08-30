import {nstructjs, Vector2, Vector3, Vector4} from '../../../../scripts/path.ux/pathux'
import {cachering} from '../../../../scripts/util/util'
import {AttrType} from './litemesh_base'
import {AttrPageType} from './litemesh_page'

export type AttrPageOf<T extends AttrType> = AttrPageType & {type: T}

export abstract class Attribute<T extends AttrType, V extends number | number[] | Vector2 | Vector3 | Vector4> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.Attribute {
      name: string;
      pageSize: int;
      pages: array(abstract(litemesh.AttrPage));
    }
  `
  )

  name: string = ''
  type: AttrType
  pageSize: number = 4096
  // since there is no such thing as a float3[] array buffer,
  // we store each component in a separate page
  pageDivisor: number = 1
  pages: AttrPageOf<T>[] = []

  constructor(type: AttrType) {
    this.type = type
  }

  abstract get(i: number): V
  abstract set(i: number, value: V): void

  loadSTRUCT(reader: nstructjs.StructReader<this>) {
    reader(this)
  }
}

export type AttributeAny = Attribute<AttrType, any>

class NumberAttribute<TYPE extends AttrType> extends Attribute<TYPE, number> {
  get(i: number): number {
    return this.pages[~~(i / this.pageSize)]!.data![i % this.pageSize]
  }
  set(i: number, value: number): void {
    this.pages[~~(i / this.pageSize)]!.data![i % this.pageSize] = value
  }
}

export class FloatAttribute extends NumberAttribute<AttrType.Float> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.FloatAttribute {}')
  constructor() {
    super(AttrType.Float)
  }
}
export class ByteAttribute extends NumberAttribute<AttrType.Byte> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.ByteAttribute {}')
  constructor() {
    super(AttrType.Byte)
  }
}

export class IntAttribute extends NumberAttribute<AttrType.Int> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.IntAttribute {}')
  constructor() {
    super(AttrType.Int)
  }
}

export class ShortAttribute extends NumberAttribute<AttrType.Short> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.ShortAttribute {}')
  constructor() {
    super(AttrType.Short)
  }
}

export class Float2Attribute extends Attribute<AttrType.Float2, Vector2> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.Float2Attribute {}')
  protected cachering = cachering.fromConstructor(Vector2, 64)

  constructor() {
    super(AttrType.Float2)
  }

  /** Warning: returns values in a cachering! */
  get(i: number) {
    const i2 = (i % this.pageSize) * 2
    const data = this.pages[~~(i / this.pageSize)].data!
    const x = data[i2]
    const y = data[i2 + 1]
    return this.cachering.next().loadXY(x, y)
  }

  set(i: number, value: Vector2): void {
    const i2 = (i % this.pageSize) * 2
    const data = this.pages[~~(i / this.pageSize)].data!
    data[i2] = value[0]
    data[i2 + 1] = value[1]
  }
}

export class Float3Attribute extends Attribute<AttrType.Float3, Vector3> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.Float3Attribute {}')
  protected cachering = cachering.fromConstructor(Vector3, 64)

  constructor() {
    super(AttrType.Float3)
  }

  /** Warning: returns values in a cachering! */
  get(i: number) {
    const i2 = (i % this.pageSize) * 3
    const data = this.pages[~~(i / this.pageSize)].data!
    const x = data[i2]
    const y = data[i2 + 1]
    const z = data[i2 + 2]
    return this.cachering.next().loadXYZ(x, y, z)
  }

  set(i: number, value: Vector3): void {
    const i2 = (i % this.pageSize) * 3
    const data = this.pages[~~(i / this.pageSize)].data!
    data[i2] = value[0]
    data[i2 + 1] = value[1]
    data[i2 + 2] = value[2]
  }
}

export class Float4Attribute extends Attribute<AttrType.Float4, Vector4> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.Float4Attribute {}')
  protected cachering = cachering.fromConstructor(Vector4, 64)

  constructor() {
    super(AttrType.Float4)
  }

  /** Warning: returns values in a cachering! */
  get(i: number) {
    const i2 = (i % this.pageSize) * 4
    const data = this.pages[~~(i / this.pageSize)].data!
    const x = data[i2]
    const y = data[i2 + 1]
    const z = data[i2 + 2]
    const w = data[i2 + 3]
    return this.cachering.next().loadXYZW(x, y, z, w)
  }

  set(i: number, value: Vector4): void {
    const i2 = (i % this.pageSize) * 4
    const data = this.pages[~~(i / this.pageSize)].data!
    data[i2] = value[0]
    data[i2 + 1] = value[1]
    data[i2 + 2] = value[2]
    data[i2 + 3] = value[3]
  }
}

export class Int2Attribute extends Attribute<AttrType.Int2, Vector2> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.Int2Attribute {}')
  protected cachering = cachering.fromConstructor(Vector2, 64)

  constructor() {
    super(AttrType.Int2)
  }

  /** Warning: returns values in a cachering! */
  get(i: number) {
    const i2 = (i % this.pageSize) * 2
    const data = this.pages[~~(i / this.pageSize)].data!
    const x = data[i2]
    const y = data[i2 + 1]
    return this.cachering.next().loadXY(x, y)
  }

  set(i: number, value: Vector2): void {
    const i2 = (i % this.pageSize) * 2
    const data = this.pages[~~(i / this.pageSize)].data!
    data[i2] = value[0]
    data[i2 + 1] = value[1]
  }
}

export class Int3Attribute extends Attribute<AttrType.Int3, Vector3> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.Int3Attribute {}')
  protected cachering = cachering.fromConstructor(Vector3, 64)

  constructor() {
    super(AttrType.Int3)
  }

  /** Warning: returns values in a cachering! */
  get(i: number) {
    const i2 = (i % this.pageSize) * 3
    const data = this.pages[~~(i / this.pageSize)].data!
    const x = data[i2]
    const y = data[i2 + 1]
    const z = data[i2 + 2]
    return this.cachering.next().loadXYZ(x, y, z)
  }

  set(i: number, value: Vector3): void {
    const i2 = (i % this.pageSize) * 3
    const data = this.pages[~~(i / this.pageSize)].data!
    data[i2] = value[0]
    data[i2 + 1] = value[1]
    data[i2 + 2] = value[2]
  }
}

export class Int4Attribute extends Attribute<AttrType.Int4, Vector4> {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.Int4Attribute {}')
  protected cachering = cachering.fromConstructor(Vector4, 64)

  constructor() {
    super(AttrType.Int4)
  }

  /** Warning: returns values in a cachering! */
  get(i: number) {
    const i2 = (i % this.pageSize) * 4
    const data = this.pages[~~(i / this.pageSize)].data!
    const x = data[i2]
    const y = data[i2 + 1]
    const z = data[i2 + 2]
    const w = data[i2 + 3]
    return this.cachering.next().loadXYZW(x, y, z, w)
  }

  set(i: number, value: Vector4): void {
    const i2 = (i % this.pageSize) * 4
    const data = this.pages[~~(i / this.pageSize)].data!
    data[i2] = value[0]
    data[i2 + 1] = value[1]
    data[i2 + 2] = value[2]
    data[i2 + 3] = value[3]
  }
}

export class BoolAttribute extends ByteAttribute {
  static STRUCT = nstructjs.inlineRegister(this, 'litemesh.BoolAttribute {}')

  constructor() {
    super()
  }
}

export const AttributeClasses = {
  [AttrType.Float] : FloatAttribute,
  [AttrType.Byte]  : ByteAttribute,
  [AttrType.Bool]  : BoolAttribute,
  [AttrType.Short] : ShortAttribute,
  [AttrType.Int]   : IntAttribute,
  [AttrType.Float3]: Float3Attribute,
  [AttrType.Int2]  : Int2Attribute,
  [AttrType.Int3]  : Int3Attribute,
  [AttrType.Int4]  : Int4Attribute,
} as const
