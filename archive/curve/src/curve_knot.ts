import {CustomDataElem, ICustomDataElemDef} from '../../mesh/src/customdata'
import {DataAPI, DataStruct, nstructjs} from '@framework/pathux'
import {MeshTypes} from '../../mesh/src/mesh_base'
import {Vertex} from '../../mesh/src/mesh'

export enum KnotFlags {}

export class KnotDataLayer extends CustomDataElem<number> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
mesh.KnotDataLayer {
  knot         : float;
  computedKnot : float;
  flag         : float;
  tilt         : float;
}`
  )

  knot: number
  computedKnot: number
  flag: KnotFlags
  tilt: number

  constructor() {
    super()
    this.knot = 1.0
    this.computedKnot = 0.0
    this.flag = 0.0
    this.tilt = 0.0
  }

  static defineAPI(api: DataAPI, dstruct: DataStruct) {
    super.defineAPI(api, dstruct)

    dstruct
      .float('knot', 'speed', 'Point Speed')
      .on('change', function () {
        window['redraw_viewport']()
      })
      .range(0.0, 10.0)

    dstruct.float('computedKnot', 'computedKnot', 'computedKnot').readOnly()
    dstruct
      .float('tilt', 'tilt', 'Point Tilt')
      .range(-Math.PI * 2.0, Math.PI * 2.0)
      .baseUnit('radian')
      .displayUnit('degree')
      .on('change', () => {
        window['redraw_viewport']()
      })
  }

  copyTo(b: this) {
    b.knot = this.knot
    b.computedKnot = this.computedKnot
    b.flag = this.flag
    b.tilt = this.tilt
  }

  interp(dest: this, datas: this[], ws: number[]) {
    dest.knot = dest.computedKnot = dest.tilt = 0.0

    let sum = 0.0

    for (let i = 0; i < datas.length; i++) {
      dest.knot += datas[i].knot * ws[i]
      dest.computedKnot += datas[i].computedKnot * ws[i]
      dest.tilt += datas[i].tilt * ws[i]
      sum += ws[i]
    }

    if (sum !== 0.0) {
      dest.knot /= sum
      dest.computedKnot /= sum
      dest.tilt /= sum
    }
  }

  validate(): boolean {
    return true
  }

  static define(): ICustomDataElemDef {
    return {
      elemTypeMask: MeshTypes.VERTEX | MeshTypes.HANDLE, //see MeshTypes in mesh.js
      typeName    : 'knot',
      uiTypeName  : 'Knot',
      defaultName : 'Knot Layer',
      //elemSize     : 3,
      flag        : 0,
    }
  }
}

export function getKnot(v: Vertex): KnotDataLayer {
  for (let cd of v.customData) {
    if (cd instanceof KnotDataLayer) {
      return cd
    }
  }

  throw new Error('Failed to find knot')
}
