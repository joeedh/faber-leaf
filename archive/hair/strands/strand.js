import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../util/vectormath.js'
import * as util from '../util/util.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'
import * as math from '../util/math.js'
import {DataBlock} from '../core/lib_api.js'
import {SceneObjectData} from '../sceneobject/sceneobject_base.js'
import {Node, NodeFlags} from '../core/graph.js'
import {SelMask} from '../core/select_types.js'
import {Icons} from '../editors/icon_enum.js'
import {StrandFlags} from './strand_base.js'
import {Strand} from './strand_types.js'

export class StrandSelectSet extends Set {
  constructor() {
    super()
  }

  remove(s) {
    this.delete(s)
  }

  get editable() {
    let this2 = this
    return (function* () {
      for (let s of this) {
        if (!(s.flag & StrandFlags.HIDE)) {
          yield s
        }
      }
    })()
  }
}

export class StrandList extends Array {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
StrandList {
  _list : array(abstract(hair.Strand));
  highlight : int | this.highlight !== undefined ? this.highlight.id : -1;
  active : int | this.active !== undefined ? this.active.id : -1;
}
`
  )

  constructor() {
    super()

    this.selected = new StrandSelectSet()
    this.idxmap = new Map()
    this._list = undefined //used by STRUCT
    this.active = undefined
    this.highlight = undefined
  }

  push(item) {
    if (item.flag & StrandFlags.SELECT) {
      this.selected.add(item)
    }

    let i = this.length
    this.idxmap.set(item, i)

    super.push(item)
  }

  setSelect(item, state) {
    if (state) {
      item.flag |= StrandFlags.SELECT
      this.selected.add(item)
    } else {
      item.flag &= ~StrandFlags.SELECT
      this.selected.delete(item)
    }
  }

  remove(item) {
    let i = this.idxmap.get(item)
    if (i === undefined) {
      console.warn(item)
      throw new Error('strand not in list')
    }

    if (i === this.length - 1) {
      this.length--
      return
    }

    let last = this[this.length - 1]

    this.idxmap.set(last, i)
    this[i] = last
    this.length--

    return this
  }

  loadSTRUCT(reader) {
    reader(this)

    for (let item of this._list) {
      this.push(item)
    }

    this._list = undefined
  }
}

export class StrandSet extends SceneObjectData {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  hair.StrandSet {
  idgen      : int;
  strands    : StrandList;
  target     : DataRef | DataRef.fromBlock(this.target);
}`
  )
  constructor() {
    super()

    this.idgen = 0
    this.idmap = new Map()
    this.strands = new StrandList()

    this.target = undefined
  }

  static blockDefine() {
    return {
      typeName   : 'strands',
      defaultName: 'Strands',
      uiName     : 'Strands',
      icon       : Icons.STRANDS,
      flag       : 0,
    }
  }

  static dataDefine() {
    return {
      name          : 'strands',
      selectMask    : SelMask.STRANDS,
      selectTypeName: 'STRANDS',
    }
  }

  static nodedef() {
    return {
      uiname : 'Strands',
      name   : 'strands',
      inputs : {...super.nodedef().inputs},
      outputs: {...super.nodedef().outputs},
      flag   : NodeFlags.SAVE_PROXY,
    }
  }

  drawQ(view3d, queue, frame, object) {
    queue.scheduleRawGLPass((gl) => {
      for (let s of this.strands) {
        s.draw(view3d, gl, frame.uniforms, frame.program, object)
      }
    })
  }

  copyTo(b) {
    super.copyTo(b, false)
  }

  setSelect(s, state) {
    return this.strands.setSelect(s, state)
  }

  loadSTRUCT(reader) {
    reader(this)
    super.loadSTRUCT(reader)

    let idmap = (this.idmap = new Map())
    for (let s of this.strands) {
      idmap.set(s.id, s)
    }

    this.strands.active = idmap.get(this.strands.active)
    this.strands.highlight = idmap.get(this.strands.highlight)
  }

  dataLink(getblock, getblock_us) {
    super.dataLink(getblock, getblock_us)

    this.target = getblock_us(this.target, this)

    for (let s of this.strands) {
      s.dataLink(this, getblock, getblock_us)
    }
  }
}
DataBlock.register(StrandSet)
SceneObjectData.register(StrandSet)
