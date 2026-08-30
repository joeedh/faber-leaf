import {AttributeAny, AttributeClasses} from './litemesh_types'
import {nstructjs} from '../../../../scripts/path.ux/pathux'
import {AttrType} from './litemesh_base'

export class AttrSet {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
        litemesh.AttrSet {
            attrs: iter(abstract(litemesh.Attribute)) | Array.from(this.attrs.values());
        }
    `
  )

  attrs: Map<string, AttributeAny> = new Map()

  constructor() {
    //
  }

  ensureAttr(type: AttrType, name: string) {
    if (!this.attrs.has(name)) {
      const AttrClass = AttributeClasses[type as keyof typeof AttributeClasses]
      const attr = new AttrClass()
      attr.name = name
      this.attrs.set(name, attr)
    }
    return this.attrs.get(name)!
  }

  addAttr(attr: AttributeAny) {
    if (this.attrs.has(attr.name)) {
      throw new Error(`Attribute ${attr.name} already exists`)
    }
    this.attrs.set(attr.name, attr)
  }

  loadSTRUCT(reader: nstructjs.StructReader<this>) {
    reader(this)
    const attrs = this.attrs as unknown as AttributeAny[]
    this.attrs = new Map(attrs.map((attr) => [attr.name, attr]))
  }
}
