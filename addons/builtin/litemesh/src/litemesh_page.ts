import {StructReader} from 'nstructjs'
import {nstructjs} from '../../../../scripts/path.ux/pathux'
import {AttrType} from './litemesh_base'

export abstract class AttrPage<T, TYPE extends AttrType> {
  type: TYPE
  length: number
  data?: T

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
        litemesh.AttrPage {
            type: byte;
            length: int;
        }
    `
  )

  constructor(type: TYPE, length: number) {
    this.type = type
    this.length = length
  }

  abstract construct(): void
}

export class IntPage extends AttrPage<Int32Array, AttrType.Int> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.IntPage {
        data: iter(int) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Int, length)
  }

  construct() {
    this.data = new Int32Array(this.length)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Int32Array(this.data)
    }
  }
}

export class ShortPage extends AttrPage<Int16Array, AttrType.Short> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.ShortPage {
        data: iter(short) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Short, length)
  }

  construct() {
    this.data = new Int16Array(this.length)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Int16Array(this.data)
    }
  }
}

export class BytePage extends AttrPage<Int8Array, AttrType.Byte> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.BytePage {
        data: iter(byte) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Byte, length)
  }

  construct() {
    this.data = new Int8Array(this.length)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Int8Array(this.data)
    }
  }
}

export class FloatPage extends AttrPage<Float32Array, AttrType.Float> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.FloatPage {
        data: iter(float) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Float, length)
  }

  construct() {
    this.data = new Float32Array(this.length)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Float32Array(this.data)
    }
  }
}

export class Vec2Page extends AttrPage<Float32Array, AttrType.Float2> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.Vec2Page {
        data: iter(float) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Float2, length)
  }

  construct() {
    this.data = new Float32Array(this.length * 2)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Float32Array(this.data)
    }
  }
}

export class Vec3Page extends AttrPage<Float32Array, AttrType.Float3> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.Vec3Page {
        data: iter(float) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Float3, length)
  }

  construct() {
    this.data = new Float32Array(this.length * 3)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Float32Array(this.data)
    }
  }
}

export class Vec4Page extends AttrPage<Float32Array, AttrType.Float4> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.Vec4Page {
        data: iter(float) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Float4, length)
  }

  construct() {
    this.data = new Float32Array(this.length * 4)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Float32Array(this.data)
    }
  }
}

export class Int2Page extends AttrPage<Int32Array, AttrType.Int2> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.Int2Page {
        data: iter(int) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Int2, length)
  }

  construct() {
    this.data = new Int32Array(this.length * 2)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Int32Array(this.data)
    }
  }
}

export class Int3Page extends AttrPage<Int32Array, AttrType.Int3> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.Int3Page {
        data: iter(int) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Int3, length)
  }

  construct() {
    this.data = new Int32Array(this.length * 3)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Int32Array(this.data)
    }
  }
}

export class Int4Page extends AttrPage<Int32Array, AttrType.Int4> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
    litemesh.Int4Page {
        data: iter(int) | this.data ?? [];
    }
    `
  )
  constructor(length: number) {
    super(AttrType.Int4, length)
  }

  construct() {
    this.data = new Int32Array(this.length * 4)
  }

  loadSTRUCT(reader: StructReader) {
    reader(this)
    if (!this.data?.length) {
      this.data = undefined
    } else {
      this.data = new Int32Array(this.data)
    }
  }
}

export const AttrPageClasses = {
  [AttrType.Bool]  : BytePage,
  [AttrType.Byte]  : BytePage,
  [AttrType.Short] : ShortPage,
  [AttrType.Int]   : IntPage,
  [AttrType.Float] : FloatPage,
  [AttrType.Float2]: Vec2Page,
  [AttrType.Float3]: Vec3Page,
  [AttrType.Float4]: Vec4Page,
  [AttrType.Int2]  : Int2Page,
  [AttrType.Int3]  : Int3Page,
  [AttrType.Int4]  : Int4Page,
} as const

export type AttrPageType =
  | IntPage
  | BytePage
  | FloatPage
  | Vec2Page
  | Vec3Page
  | Vec4Page
  | Int2Page
  | Int3Page
  | Int4Page
