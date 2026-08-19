import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as math from '../util/math.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'

import {TetTypes, TetFlags, TetRecalcFlags} from './tetgen_base.js'
import {CustomData, CustomDataElem} from '../../addons/builtin/mesh/src/customdata.js'
import {getArrayTemp} from '../../addons/builtin/mesh/src/mesh_base.js'
import {TetElement} from './tetgen_types.js'

export class TetSelectSet extends Set {
  constructor() {
    super()
  }

  get editable() {
    let this2 = this

    return (function* () {
      for (let elem of this) {
        if (!(elem.flag & TetFlags.HIDE)) {
          yield elem
        }
      }
    })()
  }

  loadSTRUCT(reader) {
    reader(this)
  }
}

let elemiters = new Array(512)
elemiters.cur = 0

export class TetElementIter {
  constructor() {
    this.list = undefined
    this.ret = {done: true, value: undefined}
    this.done = true
    this.i = 0

    this.active = undefined
    this.highlight = undefined
  }

  reset(list) {
    this.list = list
    this.i = 0
    this.ret.done = false
    this.ret.value = undefined
    this.done = false

    return this
  }

  finish() {
    if (!this.done) {
      elemiters.cur--

      this.done = true
      this.ret.done = true
      this.ret.value = undefined
      this.list = undefined
    }

    return this.ret
  }

  [Symbol.iterator]() {
    return this
  }

  next() {
    let i = this.i,
      list = this.list.list

    while (i < list.length && list[i] === undefined) {
      i++
    }

    if (i >= list.length) {
      return this.finish()
    }

    this.ret.value = list[i]
    this.i = i + 1

    return this.ret
  }

  return() {
    return this.finish()
  }
}

for (let i = 0; i < elemiters.length; i++) {
  elemiters[i] = new TetElementIter()
}

export class TetElementList {
  constructor(type) {
    this.type = type

    this.list = []
    this.freelist = []
    this.selected = new TetSelectSet()
    this.customData = new CustomData()
    this.length = 0

    this.local_eidmap = {}
    this.idxmap = {}
  }

  [Symbol.iterator]() {
    return elemiters[elemiters.cur++].reset(this)
  }

  push(elem) {
    if (elem.eid < 0) {
      throw new Error('tried to add element with eid less then zero')
    }

    if (elem.eid in this.local_eidmap) {
      throw new Error('element already in list')
    }

    let i

    if (this.freelist.length > 0) {
      i = this.freelist.pop()
    } else {
      i = this.list.length
      this.list.length++
    }

    this.list[i] = elem

    this.local_eidmap[elem.eid] = elem
    this.idxmap[elem.eid] = i

    this.length++

    return this
  }

  selectAll() {
    for (let elem of this) {
      this.selected.add(elem)
      elem.flag |= TetFlags.SELECT | TetFlags.UPDATE
    }

    return this
  }

  selectNone() {
    for (let elem of this) {
      elem.flag &= ~TetFlags.SELECT
      elem.flag |= TetFlags.UPDATE
    }

    this.selected.clear()

    return this
  }

  setSelect(elem, state) {
    if (!!state !== !!(elem.flag & TetFlags.SELECT)) {
      elem.flag |= TetFlags.UPDATE
    }

    if (state) {
      elem.flag |= TetFlags.SELECT
      this.selected.add(elem)
    } else {
      elem.flag &= ~TetFlags.SELECT
      this.selected.delete(elem)
    }

    return this
  }

  initElem(elem) {
    elem.customData.length = 0

    for (let layer of this.customData.flatlist) {
      let cls = CustomDataElem.getTypeClass(layer.typeName)
      elem.customData.push(new cls())
    }
  }

  addCustomDataLayer(typecls_or_typename, name) {
    if (typeof typecls_or_typename === 'string') {
      typecls_or_typename = CustomDataElem.getTypeClass(typecls_or_typename)
    }

    let layer = this.customData.addLayer(typecls_or_typename, name)

    for (let elem of this) {
      elem.customData.push(new typecls_or_typename())
    }

    return layer
  }

  remCustomDataLayer(cd_idx) {
    this.customData.remLayer(this.customData.flatlist[cd_idx])

    for (let elem of this) {
      let i = cd_idx

      while (i < elem.customData.length - 1) {
        elem.customData[i] = elem.customData[i + 1]
        i++
      }

      elem.customData.length--
    }
  }

  customDataInterp(target, elems, ws) {
    let datas = getArrayTemp(elems.length)

    for (let ci = 0; ci < target.customData.length; ci++) {
      let cd = target.customData[ci]

      let i = 0
      for (let target of elems) {
        datas[i++] = target.customData[ci]
      }

      cd.interp(cd, datas, ws)
    }

    for (let i = 0; i < datas.length; i++) {
      datas[i] = undefined
    }

    return this
  }

  remove(elem) {
    if (!(elem.eid in this.local_eidmap)) {
      throw new Error('element not in list')
    }

    if (elem === this.active) {
      this.active = undefined
    }

    if (elem === this.highlight) {
      this.highlight = undefined
    }

    this.selected.delete(elem)

    let idx = this.idxmap[elem.eid]

    if (this.list[idx] !== elem) {
      throw new Error('element was not in list')
    }

    delete this.idxmap[elem.eid]
    delete this.local_eidmap[elem.eid]

    this.list[idx] = undefined
    this.length--

    return this
  }

  compact() {
    let list = this.list
    this.freelist.length = 0
    let idxmap = (this.idxmap = {})

    let ei = 0
    for (let i = 0; i < list.length; i++) {
      let elem = list[i]

      if (elem) {
        list[ei] = elem
        idxmap[elem.eid] = ei
        ei++
      }
    }

    list.length = ei

    return this
  }

  _save() {
    let ret = []

    for (let item of this.list) {
      if (item !== undefined) {
        ret.push(item)
      }
    }

    return ret
  }

  loadSTRUCT(reader) {
    reader(this)

    let i = 0

    for (let elem of this.list) {
      if (elem.flag & TetFlags.SELECT) {
        this.selected.add(elem)
      }

      this.local_eidmap[elem.eid] = elem
      this.idxmap[elem.eid] = i++
    }

    this.length = i

    this.highlight = this.local_eidmap[this.highlight]
    this.active = this.local_eidmap[this.active]
  }
}

TetElementList.STRUCT = `
tet.TetElementList {
  type          : int;
  list          : array(abstract(Object)) | this._save();
  active        : int | this.active !== undefined ? this.active.eid : -1;
  highlight     : int | this.highlight !== undefined ? this.highlight.eid : -1;
  customData    : mesh.CustomData;
}
`
nstructjs.register(TetElementList)
