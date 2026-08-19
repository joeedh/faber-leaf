import {CurveSpline} from '../../addons/builtin/curve/src/curve.js'
import {AttachFlags, AttachTypes} from './strand_base.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'

export class AttachPoint {
  constructor(mode = AttachTypes.ABSOLUTE) {
    this.mode = mode
    this.co = new Vector3()
    this.ray = new Vector3()
    this.maxdis = 0
    this.flag = AttachFlags.BOTH
    this.obj = undefined
  }

  dataLink(owner, getblock, getblock_us) {
    this.obj = getblock_us(this.obj, owner)
  }

  loadSTRUCT(reader) {
    reader(this)
  }
}
AttachPoint.STRUCT = `
AttachPoint {
  mode        : int;
  co          : vec3;
  ray         : vec3;
  maxdis      : float;
  flag        : int;
  obj         : DataRef | DataRef.fromBlock(this.obj);
}
`

nstructjs.register(AttachPoint)

export class Strand extends CurveSpline {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  hair.Strand {
  id          : int;
  attachPoint : AttachPoint;
}`
  )
  constructor() {
    super()

    this.flag = 0
    this.id = -1
    this.attachPoint = new AttachPoint()
  }

  dataLink(owner, _getblock, _getblock_us) {
    function getblock(block) {
      return _getblock(block, owner)
    }
    function getblock_us(block) {
      return _getblock_us(block, owner)
    }

    super.dataLink(getblock, getblock_us)
    this.attachPoint.dataLink(getblock, getblock_us)
  }
}
