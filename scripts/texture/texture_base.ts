import {DataAPI, DataStruct, nstructjs, ToolProperty} from '../path.ux/pathux.js'
import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../path.ux/scripts/pathux.js'
import {Container} from '../path.ux/scripts/core/ui.js'
import {StructReader} from '../path.ux/scripts/util/nstructjs.js'

export const Textures: ITextureShaderConstructor[] = []
export const TextureShaders: {[k: string]: ITextureShaderConstructor} = {}
export type TexPropTypeBase = number | Vector2 | Vector3 | Vector4 | Matrix4 | string | Quat
export type TexPropType = TexPropTypeBase | TexPropTypeBase[]
export type TexProperty = ToolProperty<TexPropType>
export type TexPropertyBlock = {[k: string]: TexProperty}

export const TextureShaderFlags = {
  HAS_COLOR: 1,
}

//export type TexUniformType = number | number[] | Matrix4 | Vector2 | Vector3 | Vector4

export type ITextureShaderDef = {
  typeName: string
  uiName?: string
  fragmentPre?: string
  flag?: number
  uniforms?: {[k: string]: TexProperty}
  params?: {[k: string]: TexProperty}
}

export interface ITextureShaderConstructor<T = any> {
  new (): T

  textureDefine(): ITextureShaderDef

  STRUCT: string
}

export class TextureShader {
  ['constructor']: ITextureShaderConstructor<this> = this['constructor']

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  TextureShader {
    typeName : string;
    flag     : int;
    id       : int;
    params   : string | JSON.stringify(this.params);
    uniforms : string | JSON.stringify(this.uniforms);
  }
`
  )

  typeName: string
  params: {[k: string]: TexPropType} = {}
  uniforms: {[k: string]: TexPropType} = {}
  flag = 0
  id = -1

  constructor() {
    const def = this.constructor.textureDefine()
    this.typeName = def.typeName

    for (const k in def.params) {
      const prop = def.params[k]
      this.params[k] = prop.copy().getValue()
    }

    for (const k in def.uniforms) {
      this.uniforms[k] = def.uniforms[k].copy().getValue()
    }
  }

  copyTo(b: this): this {
    const def = this.constructor.textureDefine()

    b.flag = this.flag
    b.id = this.id

    for (let i = 0; i < 2; i++) {
      const list1 = i ? this.uniforms : this.params
      const list2 = i ? b.uniforms : b.params
      const slist = i ? def.uniforms ?? {} : def.params ?? {}

      for (const k in list1) {
        const v = list1[k] as unknown
        let finalV: TexPropType | undefined

        if (!(k in slist)) {
          if (v instanceof Array) {
            finalV = (v as TexProperty[]).map((prop) => prop.copy().getValue()) as unknown as TexPropType
          } else if (v instanceof ToolProperty) {
            finalV = v.copy().getValue()
          }
        } else {
          const prop = slist[k].copy()
          prop.setValue(v as TexPropType)
          finalV = prop.getValue()
        }

        if (finalV !== undefined) {
          list2[k] = finalV
        } else {
          // eslint-disable-next-line no-console
          console.warn('Unreachable code in tex copyTo', this, b)
        }
      }
    }

    return b
  }

  static textureDefine() {
    return {
      typeName   : '',
      uiName     : '',
      fragmentPre: '',
      flag       : 0, //e.g. TextureShaderFlags.HAS_COLOR
      uniforms: {
        //ToolProperties
      },
      params: {
        //ToolProperties
      },
    } as ITextureShaderDef
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = struct ?? api.mapStruct(this)

    st.string('typeName', 'type', 'Type', 'Type Name').readOnly()
    const sdef = this.textureDefine()

    for (let i = 0; i < 2; i++) {
      const key = i ? 'uniforms' : 'params'
      const list = sdef[key]

      const st2 = st.struct(key, key, key)

      for (const k in list) {
        const prop = list[k]

        st2.fromToolProp(k, prop)
      }
    }

    return st
  }

  static buildUI(container: Container) {
    const def = this.textureDefine()

    for (let i = 0; i < 2; i++) {
      const key = i ? ('uniforms' as const) : ('params' as const)
      const slist = def[key] ?? {}
      const path = key + '.'

      for (const k in slist) {
        const prop = slist[k]

        let apiName = k
        if (prop.apiname && prop.apiname.length > 0) {
          apiName = prop.apiname
        }

        container.prop(path + apiName)
      }
    }
  }

  genCode(): string {
    return `

float fsample(vec3 co, vec3 colorOut) {
}    

    `
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    this.params = JSON.parse(this.params as unknown as string)
    this.uniforms = JSON.parse(this.uniforms as unknown as string)

    for (let i = 0; i < 2; i++) {
      const list = (i ? this.uniforms : this.params) as unknown as any

      for (const k in list) {
        const arr = list[k] as number[] | Matrix4

        if (!(arr instanceof Array)) {
          continue
        }

        let v: Vector2 | Vector3 | Vector4 | Matrix4 | undefined

        switch (arr.length) {
          case 2:
            v = new Vector2(arr)
            break
          case 3:
            v = new Vector3(arr)
            break
          case 4:
            v = new Vector4(arr)
            break
          case 16:
            v = new Matrix4(arr as unknown as number[])
        }

        list[k] = v!
      }
    }
  }

  static register(cls: ITextureShaderConstructor) {
    const def = cls.textureDefine()

    if (cls.textureDefine === TextureShader.textureDefine) {
      throw new Error('missing textureDefine')
    }

    if (cls.STRUCT === TextureShader.STRUCT || !cls.STRUCT) {
      throw new Error('Texture generators must have nstructjs scripts')
      //console.warn('Auto-registering texture shader with nstructjs. . .')
      //cls.STRUCT = nstructjs.inherit(cls, TextureShader) + `\n}`
      //nstructjs.register(cls)
    } else if (!(cls as unknown as any).structName) {
      throw new Error('You wrote a STRUCT script but forgot to register it with nstructjs')
    }

    TextureShaders[def.typeName] = cls
    Textures.push(cls)
  }

  static getTextureClass(name: string): ITextureShaderConstructor | undefined {
    for (const cls of Textures) {
      if (cls.textureDefine().typeName === name) {
        return cls
      }
    }
  }
}
