import {Vector4} from '@framework/api'
import {Texture} from '@framework/api'

///XXX truly ancient code
export const PCOS = 0
export const PEID = PCOS + 16 * 3
export const PCOLOR = PEID + 1
export const PTOT = PCOLOR + 4

export class PatchList {
  patchdata: Float32Array
  eidMap: Map<number, number>
  gltex?: Texture
  texdimen?: number

  constructor() {
    this.patchdata = new Float32Array()
    this.eidMap = new Map()
    this.gltex = undefined
    this.texdimen = undefined
  }

  destroy(gl: WebGL2RenderingContext) {
    if (this.gltex !== undefined) {
      this.gltex.destroy(gl)
      this.gltex = undefined
    }
  }
}

//export class SubSurf
export class PatchData {
  ns: Float64Array
  ps: Float64Array
  eid: number
  i: number
  color: [number, number, number, number] | Vector4
  flag: number

  constructor() {
    this.ps = new Float64Array(16 * 3)
    this.ns = new Float64Array(16 * 3) //normals?

    this.eid = 0
    this.i = 0
    this.color = [1, 1, 1, 1]
    this.flag = 0
  }
}
