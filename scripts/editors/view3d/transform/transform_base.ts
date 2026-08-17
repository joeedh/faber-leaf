/*
Transform interface refactor:

1. Refactor TransDataType
  - Should be able to pass in custom TransDataTypes to transform ops,
    maybe via subclassing?
  - Or maybe I'll make a new ListProperty tool property, so I can pass in
    lists of strings.

2. Add a transformDefine to transDataType abstract class:
  static transformDefine() {return {
    name   : "",
    uiname : "",
    flag   : 0
  }}

3.  Add a isValid static to transDataType
  static isValid(ctx) {
    //return if ctx is valid for this data
  }
*/

import {Vector3, Vector2, Matrix4} from '../../../util/vectormath.js'
import {ToolOp, StringSetProperty, ToolOpAny} from '../../../path.ux/scripts/pathux.js'
import type {ToolContext} from '../../../core/context.js'
import type {Mesh} from '../../../../addons/builtin/mesh/src/mesh.js'
import type {TransformOp} from './transform_ops.js'

export interface TransformDefine {
  name: string
  uiname: string
  flag: number
  icon: number
}

export const ConstraintSpaces = {
  WORLD : 0,
  LOCAL : 1,
  NORMAL: 2,
  //2-16 are reserved for further global types

  //children will add types here
}

//proportional edit mode, "magnet tool"
export const PropModes = {
  SMOOTH     : 0,
  SHARP      : 1,
  EXTRA_SHARP: 2,
  SPHERE     : 3,
  LINEAR     : 4,
  CONSTANT   : 5,
}

export class TransDataElem<D1 = undefined, D2 = undefined> {
  data1!: D1
  data2!: D2
  no: Vector3 | undefined
  index: number
  symFlag: number
  w: number
  type: typeof TransDataType

  constructor(typecls?: typeof TransDataType) {
    this.no = undefined

    this.index = -1
    this.symFlag = 0 //see MeshSymFlags
    this.w = 1.0
    this.type = typecls!
  }
}

export class TransDataList<D1 = undefined, D2 = undefined> extends Array<TransDataElem<D1, D2>> {
  type: ITransDataType

  constructor(typeclass: ITransDataType, data?: Iterable<TransDataElem<D1, D2>>) {
    super()

    this.type = typeclass

    if (data !== undefined) {
      for (const item of data) {
        this.push(item)
      }
    }
  }
}

export class TransformData extends Array<TransDataList<undefined, undefined>> {
  center: Vector3
  scenter: Vector2

  constructor() {
    super()

    this.center = new Vector3()
    this.scenter = new Vector2()
  }
}

export const TransDataTypes: ITransDataType[] = []
export const TransDataMap: {[name: string]: ITransDataType} = {}

/**
 * interface for creating and manipulating a transform data type
 */
export interface ITransDataType<D1 = any, D2 = any, TransElem = TransDataElem<D1, D2>, UndoData = any> {
  transformDefine(): TransformDefine
  isValid(ctx: ToolContext, toolop?: TransformOp): boolean
  buildTypesProp(default_value?: string | Iterable<string>): StringSetProperty
  //calcPropCurve(dis: number, propmode: number, propradius: number): number
  genData(
    ctx: ToolContext,
    selectmode: number,
    propmode: number,
    propradius: number,
    toolop: TransformOp
  ): TransDataList<D1, D2> | undefined
  applyTransform(ctx: ToolContext, elem: TransElem, do_prop: boolean, matrix: Matrix4, toolop: TransformOp): void
  calcUndoMem(ctx: ToolContext, undodata: any): number
  undoPre(ctx: ToolContext, elemlist: TransDataList<D1, D2>): UndoData
  undo(ctx: ToolContext, undodata: UndoData): void
  getCenter(
    ctx: ToolContext,
    list: TransDataList<D1, D2> | TransElem[],
    selmask: number,
    spacemode?: number,
    space_matrix_out?: Matrix4,
    toolop?: TransformOp
  ): Vector3 | undefined
  calcAABB(ctx: ToolContext, selmask: number): [Vector3, Vector3] | undefined
  getOriginMatrix(
    ctx: ToolContext,
    list: TransDataList<D1, D2> | TransElem[],
    selmask: number,
    spacemode: number,
    space_matrix_out?: Matrix4
  ): Matrix4 | undefined
  update(ctx: ToolContext, elemlist: TransDataList<D1, D2>): void
}

/**
 * this is not really a base class, just a helper to register types and store
 *  a few convenience functions for ITransDataType implementations to use if they so choose
 */
export class TransDataType {
  static transformDefine(): TransformDefine {
    return {
      name  : '',
      uiname: '',
      flag  : 0,
      icon  : -1,
    }
  }

  static isValid(ctx: ToolContext, toolop?: ToolOp): boolean {
    return true
  }

  static buildTypesProp(default_value?: string | Iterable<string>): StringSetProperty {
    const def = new Set<string>()

    for (const cls of TransDataTypes) {
      const tdef = cls.transformDefine()

      def.add(tdef.name)
    }

    return new StringSetProperty(default_value, def)
  }

  /** `undefined` when nothing is registered under that name — a saved tool
   * input can outlive the addon that contributed its type. */
  static getClass(name: string): ITransDataType | undefined {
    return TransDataMap[name]
  }

  /**
   * Every registered type's name, sorted — the default for a transform op's
   * `types` input. `TransformOp.getTransTypes` filters by `isValid`, so a type
   * that does not apply to the op in hand costs nothing; a hardcoded list costs
   * a newly contributed geometry type its transform outright. See
   * documentation/geometry-contract.md §8.
   */
  static defaultTypeNames(): string[] {
    return TransDataTypes.map((cls) => cls.transformDefine().name).sort()
  }

  static register(type: ITransDataType): void {
    const def = type.transformDefine()

    if (TransDataTypes.indexOf(type) >= 0) {
      return
    }

    TransDataTypes.push(type)
    TransDataMap[def.name] = type
  }

  /** Counterpart to {@link register}, so an addon that contributes a transform
   * type can be disabled. See documentation/geometry-contract.md §8. */
  static unregister(type: ITransDataType): void {
    const i = TransDataTypes.indexOf(type)
    if (i >= 0) {
      TransDataTypes.splice(i, 1)
    }

    const def = type.transformDefine()
    if (TransDataMap[def.name] === type) {
      delete TransDataMap[def.name]
    }
  }

  static calcPropCurve(dis: number, propmode: number, propradius: number): number {
    dis /= propradius
    dis = 1.0 - Math.min(Math.max(dis, 0.0), 1.0)

    if (propmode === PropModes.SMOOTH) {
      dis = dis * dis * (3.0 - 2.0 * dis)
    } else if (propmode === PropModes.SPHERE) {
      dis = 1.0 - (1.0 - dis) * (1.0 - dis)
    } else if (propmode === PropModes.SHARP) {
      dis *= dis
    } else if (propmode === PropModes.EXTRA_SHARP) {
      dis *= dis * dis * dis
    } else if (propmode === PropModes.CONSTANT) {
      dis = 1.0
    }

    return dis
  }

  static genData(ctx: ToolContext, selectmode: number, propmode: number, propradius: number, toolop: ToolOp): void {}

  static applyTransform(
    ctx: ToolContext,
    elem: TransDataElem<undefined, undefined>,
    do_prop: boolean,
    matrix: Matrix4,
    toolop: ToolOp
  ): void {}

  static undoPre(ctx: ToolContext, elemlist: TransDataList<undefined, undefined>): void {
    //returns undo data
  }

  static undo(ctx: ToolContext, undodata: TransDataList<undefined, undefined>): void {}

  /**
   * @param ctx                : instance of ToolContext or a derived class
   * @param selmask            : SelMask
   * @param spacemode          : ConstraintSpaces
   * @param space_matrix_out   : Matrix4, optional, matrix to put constraint space in
   */
  static getCenter(
    ctx: ToolContext,
    list: TransDataList | TransDataElem[],
    selmask: number,
    spacemode?: number,
    space_matrix_out?: Matrix4,
    toolop?: ToolOp
  ): Vector3 | undefined {
    return undefined
  }

  static calcAABB(ctx: ToolContext, selmask: number): [Vector3, Vector3] | undefined {
    return undefined
  }

  static getOriginMatrix(
    ctx: ToolContext,
    list: TransDataList | TransDataElem[],
    selmask: number,
    spacemode: number,
    space_matrix_out?: Matrix4
  ): Matrix4 | undefined {
    return undefined
  }

  static update(ctx: ToolContext, elemlist: TransDataList<undefined, undefined>): void {}
}
