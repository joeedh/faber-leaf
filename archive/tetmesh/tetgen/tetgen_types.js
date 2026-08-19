import {Vector2, Vector3, Vector4, Matrix4, Quat} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as math from '../util/math.js'
import {nstructjs} from '../path.ux/scripts/pathux.js'

import {TetTypes, TetFlags, TetRecalcFlags} from './tetgen_base.js'

let vniters = new Array(1024)
vniters.cur = 0

export class VertNeighborIter {
  constructor() {
    this.ret = {done: false, value: undefined}
    this.done = true
    this.v = undefined
    this.i = 0
  }

  reset(v) {
    this.v = v
    this.i = 0
    this.done = false
    this.ret.done = false

    return this
  }

  finish() {
    if (!this.done) {
      this.done = true
      vniters.cur--
      this.v = undefined
      this.ret.value = undefined
      this.ret.done = true
    }

    return this
  }

  return() {
    this.finish()

    return this.ret
  }

  [Symbol.iterator]() {
    return this
  }

  next() {
    let ret = this.ret
    let v = this.v

    if (this.i >= v.valence) {
      this.finish()
      return this.ret
    }

    let e = v.edges[this.i]
    this.i++

    ret.value = e.otherVertex(v)
    return ret
  }
}

for (let i = 0; i < vniters.length; i++) {
  vniters[i] = new VertNeighborIter()
}

export class TetElement {
  constructor(type) {
    this.initTetElement(type)
  }

  initTetElement(type) {
    this.eid = -1
    this.flag = 0
    this.index = 0
    this.type = type
    this.customData = []
  }

  loadSTRUCT(reader) {
    reader(this)
  }
}

TetElement.STRUCT = `
tet.TetElement {
  type       : byte;
  eid        : int;
  flag       : int;
  index      : int;
  customData : array(abstract(mesh.CustomDataElem)); 
}
`
nstructjs.register(TetElement)

export class TetVertex extends Vector3 {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  tet.TetVertex {
  0     : float;
  1     : float;
  2     : float;
}`
  )

  constructor(co) {
    super(co)

    this.initTetElement(TetTypes.VERTEX)

    this.oldco = new Vector3()
    this.vel = new Vector3()
    this.acc = new Vector3()

    this.mass = 1.0
    this.w = 1.0

    this.no = new Vector3()
    this.edges = []

    //seal object to make js engine optimizers happier
    Object.seal(this)
  }

  get valence() {
    return this.edges.length
  }

  get neighbors() {
    return vniters[vniters.cur++].reset(this)
  }

  loadSTRUCT(reader) {
    reader(this)
    super.loadSTRUCT(reader)

    this.oldco.load(this.co)
  }
}

util.mixin(TetVertex, TetElement)

let etetiters = new Array(16)
etetiters.cur = 0

export class EdgeTetIter {
  constructor() {
    this.e = undefined
    this.l = undefined
    this._i = 0
    this.ret = {done: true, value: undefined}
    this.done = true
  }

  reset(e) {
    this.e = e
    this.ret.done = false
    this.ret.value = undefined
    this.done = false
    this.l = e.l
    this._i = 0
    this.flag = 1 << (etetiters.cur + TetFlags.ITER_EDGE_TETS1)

    if (e.l) {
      let _i = 0
      let l = e.l
      let flag = this.flag

      do {
        if (_i++ > 100) {
          console.error('Infinite loop error')
          break
        }

        l.t.flag &= ~flag

        l = l.radial_next
      } while (l !== e.l)
    }

    return this
  }

  [Symbol.iterator]() {
    return this
  }

  next() {
    if (!this.l) {
      return this.finish()
    }

    if (this._i++ > 100) {
      console.error('Infinite loop error')
      return this.finish()
    }

    this.l = this.l.radial_next
    let _i = 0

    while (this.l !== this.e.l && this.l.t.flag & this.flag) {
      this.l = this.l.radial_next

      if (_i++ > 100) {
        console.error('Infinite loop error')
        break
      }
    }

    if (this.l === this.e.l) {
      return this.finish()
    }

    let ret = this.ret

    ret.value = this.l.t
    ret.done = false

    return ret
  }

  finish() {
    if (!this.done) {
      this.e = undefined //avoid reference leak

      etetiters.cur--
      this.ret.done = true
      this.ret.value = undefined
    }

    return this.ret
  }

  return() {
    return this.finish()
  }
}

for (let i = 0; i < etetiters.length; i++) {
  etetiters[i] = new EdgeTetIter()
}

export class TetEdge extends TetElement {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  tet.TetEdge {
  v1 : int | this.v1.eid;
  v2 : int | this.v2.eid;
}`
  )

  constructor() {
    super(TetTypes.EDGE)

    this.v1 = undefined
    this.v2 = undefined

    this.startLength = 0.0

    this.l = undefined
  }

  get cells() {
    return etetiters[etetiters.cur++].reset(this)
  }

  get loops() {
    let this2 = this

    return (function* () {
      if (!this2.l) {
        return
      }

      let l = this2.l
      let _i = 0
      do {
        if (_i++ > 100) {
          console.error('Infinite loop error')
          break
        }

        yield l

        l = l.radial_next
      } while (l !== this2.l)
    })()
  }

  otherVertex(v) {
    if (v === this.v1) {
      return this.v2
    } else if (v === this.v2) {
      return this.v1
    } else {
      throw new Error('Vertex not in edge')
    }
  }
}

export class TetLoop extends TetElement {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  tet.TetLoop {
  v    : int | this.v.eid;
  next : int | this.next.eid;
  prev : int | this.prev.eid;
}`
  )

  constructor() {
    super(TetTypes.LOOP)

    this.v = this.e = this.f = undefined
    this.next = this.prev = undefined

    this.radial_next = this.radial_prev = undefined
  }
}

//always a triangle
export class TetFace extends TetElement {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  tet.TetFace {
  loops      : iter(l, int) | l.eid;
  no         : vec3;
  cent       : vec3;
}`
  )

  constructor() {
    super(TetTypes.FACE)

    this.p = undefined //first tet plane in plane linked list
    this.l = undefined //start loop

    this.no = new Vector3()
    this.cent = new Vector3()
    this.area = 0.0

    this.loops = []
  }

  isTri() {
    return this.loops.length === 3
  }

  isQuad() {
    return this.loops.length === 4
  }

  calcCent() {
    this.cent.zero()
    let tot = 0.0

    for (let l of this.loops) {
      this.cent.add(l.v)
      tot++
    }

    if (tot) {
      this.cent.mulScalar(1.0 / tot)
    }

    return this
  }

  get planes() {
    let this2 = this

    return (function* () {
      if (!this2.p) {
        return
      }

      let l = this2.p
      let _i = 0
      do {
        if (_i++ > 100) {
          console.error('Infinite loop error')
          break
        }

        yield l

        l = l.plane_next
      } while (l !== this2.p)
    })()
  }

  calcNormal(cd_disp = -1) {
    let ls = this.loops

    function v(v) {
      if (cd_disp >= 0) {
        return v.customData[cd_disp].worldCo
      } else {
        return v
      }
    }

    if (this.loops.length === 4) {
      this.area = math.tri_area(v(ls[0].v), v(ls[1].v), v(ls[2].v))
      this.area += math.tri_area(v(ls[0].v), v(ls[2].v), v(ls[3].v))
      this.no.load(math.normal_quad(v(ls[0].v), v(ls[1].v), v(ls[2].v), v(ls[3].v)))
    } else {
      this.area = math.tri_area(v(ls[0].v), v(ls[1].v), v(ls[2].v))
      this.no.load(math.normal_tri(v(ls[0].v), v(ls[1].v), v(ls[2].v)))
    }

    return this
  }
}

export const CellTypes = {
  TET: 0, //tetrahedron
  HEX: 1, //cube
}

//planes are to faces as loops are to edges
export class TetPlane extends TetElement {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  tet.TetPlane {
  no          : vec3;
  cent        : vec3;
  f           : int | this.f.eid;
  c           : int | this.c.eid;
}`
  )

  constructor() {
    super(TetTypes.PLANE)

    this.f = undefined
    this.c = undefined //cell

    this.no = new Vector3()
    this.cent = new Vector3()

    this.plane_next = this.plane_prev = undefined
  }

  loadSTRUCT(reader) {
    super.loadSTRUCT(reader)
  }
}

export class TetCell extends TetElement {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  tet.TetCell {
  faces         : iter(f, int) | f.eid;
  verts         : iter(v, int) | v.eid;
  planes        : iter(p, int) | p.eid;
  cellType      : int;
  startVolume   : float;
  volume        : float;
  cent          : vec3;
}`
  )

  constructor() {
    super(TetTypes.CELL)

    this.cellType = CellTypes.TET

    this.volume = 0
    this.startVolume = 0

    this.cent = new Vector3()

    this.planes = []
    this.faces = []
    this.edges = []
    this.verts = []
  }

  isTet() {
    return this.planes.length === 4
  }

  isHex() {
    return this.planes.length === 6
  }

  calcCent() {
    this.cent.zero()
    let tot = 0.0

    for (let v of this.verts) {
      this.cent.add(v)
      tot++
    }

    if (tot) {
      this.cent.mulScalar(1.0 / tot)
    }

    return this.cent
  }

  _regenEdges() {
    this.edges.length = 0
    let flag = TetFlags.MAKEFACE_TEMP

    for (let f of this.faces) {
      for (let l of f.loops) {
        l.e.flag &= ~flag
      }
    }

    for (let f of this.faces) {
      for (let l of f.loops) {
        if (!(l.e.flag & flag)) {
          l.e.flag |= flag
          this.edges.push(l.e)
        }
      }
    }

    return this
  }
}

export const TetClasses = {
  [TetTypes.VERTEX]: TetVertex,
  [TetTypes.EDGE]  : TetEdge,
  [TetTypes.LOOP]  : TetLoop,
  [TetTypes.FACE]  : TetFace,
  [TetTypes.PLANE] : TetPlane,
  [TetTypes.CELL]  : TetCell,
}
