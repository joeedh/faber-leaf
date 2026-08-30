import {keymap} from '../../../path.ux/scripts/util/simple_events.js'
import {TransformData, TransDataType, PropModes, TransDataList, ITransDataType} from './transform_base.js'
// Same reason, for transform_base.js: the hub already depends on this module,
// so routing the interface through it keeps framework_api.ts out of one more
// import cycle (§8).
export {TransDataElem, TransDataList, TransDataType} from './transform_base.js'
export type {ITransDataType, TransformDefine} from './transform_base.js'
import {
  ToolOp,
  FlagProperty,
  EnumProperty,
  Vec3Property,
  Mat4Property,
  FloatProperty,
  BoolProperty,
  PropFlags,
  PropertySlots,
  StringSetProperty,
  ContextLike,
  ToolDef,
} from '../../../path.ux/scripts/pathux.js'
import {SelMask} from '../../../core/select_types.js'
import {InvalidationKind} from '../../../core/geometry_contract.js'
import {Vector2, Vector3, EulerOrders, Vector4, Matrix4} from '../../../util/vectormath.js'
import {View3DOp} from '../view3d_ops.js'
import {isect_ray_plane} from '../../../path.ux/scripts/util/math.js'
import {calcTransCenter} from './transform_query.js'
import {castViewRay} from '../findnearest.js'

import {ModalFlags} from '../../../core/modalflags.js'
import {invalidatableOf} from '../../../core/data_kinds.js'

import type {ViewContext} from '../../../core/context.js'

interface NumericVal {
  sign: number
  str: string
  value: number
}

type TransformOpInputs = {
  types: StringSetProperty
  value: Vec3Property
  space: Mat4Property
  snapMode: EnumProperty
  constraint: Vec3Property
  constraint_space: Mat4Property
  selmask: FlagProperty
  propMode: EnumProperty
  propRadius: FloatProperty
  propEnabled: BoolProperty
}

type UndoMap = {[name: string]: unknown}

/*
Transform refactor:

- Allow passing custom TransDataType classes
- Allow working on UI data (e.g. non-saved)
  so widgets can use transform more flexibly.

* */

export const SnapModes = {
  NONE   : 0,
  SURFACE: 1, //uses depth buffer
}

export class TransformOp<InputSet extends PropertySlots = {}, OutputSet extends PropertySlots = {}> extends View3DOp<
  InputSet & TransformOpInputs,
  OutputSet
> {
  numericVal: NumericVal | undefined
  _mpos: Vector2
  _first: boolean
  tdata: TransformData | undefined
  centfirst: boolean
  center: Vector3
  _types: ITransDataType[] | undefined
  _undo: UndoMap

  constructor() {
    super()

    this.numericVal = undefined

    this._mpos = new Vector2()
    this._first = true

    this.tdata = undefined
    this.centfirst = true
    this.center = new Vector3()
    this._undo = {}
  }

  exec(ctx: ViewContext) {
    if (!this.modalRunning) {
      this.genTransData(ctx)
    }
  }

  //called only during modal mode
  numericSet(val: number) {
    throw new Error('numericSet: implement me!')
  }

  static canRun<CTX extends ContextLike>(_ctx: CTX, _toolop?: ToolOp | undefined): boolean {
    const ctx = _ctx as unknown as ViewContext
    return ctx.view3d !== undefined
  }

  setConstraintFromString(c: string) {
    const axis = new Vector3()
    const map: {[key: string]: number} = {
      x: 0,
      y: 1,
      z: 2,
    }

    for (let i = 0; i < c.length; i++) {
      const ax = c[i].toLowerCase()

      if (ax in map) {
        axis[map[ax] as 0 | 1 | 2] = 1.0
      }
    }

    this.inputs.constraint.setValue(axis)
    return this
  }

  static invoke(ctx: ViewContext, args: Record<string, unknown>) {
    const tool = super.invoke(ctx, args) as TransformOp

    if ('constraint' in args) {
      tool.setConstraintFromString(args.constraint as string)
    }

    //console.log("TRANSFROM INVOKE", args);

    if (!('selmask' in args)) {
      tool.inputs.selmask.setValue(ctx.selectMask)
    }

    if (!('propEnabled' in args)) {
      tool.inputs.propEnabled.setValue(ctx.scene.propEnabled)
    }

    if (!('propMode' in args)) {
      tool.inputs.propMode.setValue(ctx.scene.propMode)
    }

    if (!('propRadius' in args)) {
      tool.inputs.propRadius.setValue(ctx.scene.propRadius)
    }

    return tool
  }

  static tooldef(): ToolDef {
    return {
      uiname  : 'transform base',
      is_modal: true,

      inputs: {
        types           : TransDataType.buildTypesProp(TransDataType.defaultTypeNames()).private(),
        value           : new Vec3Property(),
        space           : new Mat4Property().private(),
        snapMode        : new EnumProperty(SnapModes.NONE, SnapModes),
        constraint      : new Vec3Property([1.0, 1.0, 1.0]).private(), //locked constraint axes
        constraint_space: new Mat4Property().private(),
        selmask         : new FlagProperty('GEOM', SelMask).private(),
        propMode        : new EnumProperty(0, PropModes, undefined, 'Prop Mode', 'Proportional (magnet) mode'),
        propRadius: new FloatProperty(
          0.125,
          'propradius',
          'Prop Radius',
          'Proportional radius',
          PropFlags.SAVE_LAST_VALUE
        ),
        propEnabled     : new BoolProperty(false),
      },
    }
  }

  getTransTypes(ctx: ViewContext) {
    if (this._types !== undefined) {
      return this._types
    }

    this._types = []
    for (const name of this.inputs.types.getValue()) {
      // A name can outlive its type: it is saved in the op's inputs, and the
      // addon that contributed the type can be disabled between runs (§8).
      const type = TransDataType.getClass(name)

      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- kept explicit; see unit/transform_registry.test.ts
      if (!type || !type.isValid(ctx, this)) {
        continue
      }
      this._types.push(type)
    }

    return this._types
  }

  genTransData(ctx: ViewContext) {
    const tdata = (this.tdata = new TransformData())
    const propradius = this.inputs.propRadius.getValue()
    const selmask = this.inputs.selmask.getValue()

    const propmode: number | undefined = !this.inputs.propEnabled.getValue()
      ? undefined
      : Number(this.inputs.propMode.getValue())

    for (const type of this.getTransTypes(ctx)) {
      let list = type.genData(ctx, selmask, propmode as number, propradius, this)
      if (list === undefined || list.length === 0) {
        continue
      }

      list.type = type

      if (!(list instanceof TransDataList)) {
        list = new TransDataList(type, list)
      }

      tdata.push(list)
    }

    return tdata
  }

  calcCenter(ctx: ViewContext, selmask: number) {
    const center = new Vector3()
    let tot = 0.0

    for (const list of this.tdata!) {
      if (!list.type.isValid(ctx, this)) {
        continue
      }

      const cent2 = list.type.getCenter(ctx, list, selmask)
      if (cent2 !== undefined) {
        center.add(cent2)
        tot++
      }
    }

    if (tot > 0) {
      center.mulScalar(1.0 / tot)
    }

    return center
  }

  calcUndoMem(ctx: ViewContext) {
    let tot = 0

    const types = this.getTransTypes(ctx)
    const map: {[name: string]: ITransDataType} = {}
    for (const t of types) {
      map[t.transformDefine().name] = t
    }

    for (const k in this._undo) {
      const ud = this._undo[k]
      const type = map[k]

      tot += type.calcUndoMem ? type.calcUndoMem(ctx, ud) : 0
    }

    return tot
  }

  undoPre(ctx: ViewContext, checkTransData = true) {
    if (checkTransData) {
      this.genTransData(ctx)
    }

    this._undo = {}

    for (const list of this.tdata!) {
      this._undo[list.type.transformDefine().name] = list.type.undoPre(ctx, list)
    }
  }

  undo(ctx: ViewContext) {
    const udata = this._undo
    for (const k in udata) {
      for (const type of this.getTransTypes(ctx)) {
        if (type.transformDefine().name === k) {
          type.undo(ctx, udata[k])
        }
      }
    }

    window.redraw_viewport()
  }

  modalStart(ctx: ViewContext) {
    ctx.setModalFlag(ModalFlags.TRANSFORMING)

    const promise = super.modalStart(ctx)

    this.numericVal = undefined
    this.tdata = this.genTransData(ctx)

    for (const _unusedT of this.getTransTypes(ctx)) {
      const mctx = this.modal_ctx! as ViewContext
      const ret = calcTransCenter(mctx, this.inputs.selmask.getValue(), mctx.view3d.transformSpace)

      if (!this.inputs.constraint_space.wasSet) {
        this.inputs.constraint_space.setValue(ret.spaceMatrix)
      }
    }

    this.center = this.calcCenter(ctx, this.inputs.selmask.getValue())

    return promise
  }

  applyTransform(ctx: ViewContext, mat: Matrix4) {
    const tdata = this.tdata!
    const do_prop = this.inputs.propEnabled.getValue()

    for (const list of tdata) {
      for (const td of list) {
        list.type.applyTransform(ctx, td, do_prop, mat, this)
      }

      list.type.update(ctx, list)
    }
  }

  doUpdates(ctx: ViewContext) {
    const tdata = this.tdata!

    for (const list of tdata) {
      list.type.update(ctx, list)
    }
  }

  modalEnd(was_canceled?: boolean) {
    this.centfirst = true
    this.tdata = undefined

    //make sure selection buffer doesn't get messed up by
    //partial update, do a full sync to gpu on mouse up

    const ctx = this.modal_ctx! as ViewContext
    ctx.clearModalFlag(ModalFlags.TRANSFORMING)

    // Capability-narrowed rather than kind-tested: any provider that declares
    // INVALIDATION gets the end-of-modal position flush.
    for (const ob of ctx.selectedObjects) {
      invalidatableOf(ob.data)?.invalidate(InvalidationKind.POSITIONS)
    }

    return super.modalEnd(was_canceled)
  }

  cancel() {
    this.applyTransform(this.modal_ctx! as ViewContext, new Matrix4())
    this.tdata = undefined
    this.modalEnd(true)
  }

  finish() {
    this.tdata = undefined
    this.modalEnd(false)
  }

  on_pointerup(e: PointerEvent) {
    if (e.button !== 0) {
      this.cancel()
    } else {
      this.finish()
    }

    window.redraw_viewport()
  }

  on_mousewheel(e: WheelEvent & {x: number; y: number}) {
    let dy = 1.0 + e.deltaY * 0.001
    dy = Math.max(dy, 0.001)

    const r = this.inputs.propRadius.getValue() * dy
    this.inputs.propRadius.setValue(r)

    const mctx = this.modal_ctx! as ViewContext
    mctx.scene.propRadius = r

    const mpos = new Vector2()
    const view3d = mctx.view3d

    if (e.x !== undefined && e.y !== undefined) {
      mpos.load(view3d.getLocalMouse(e.x, e.y))
    } else if (!this._first) {
      mpos.load(this._mpos)
    } else {
      return
    }

    this.updatePropRadius(r, mpos)
  }

  updatePropRadius(r: number, mpos: Vector2) {
    this.inputs.propRadius.setValue(r)
    const mctx = this.modal_ctx! as ViewContext
    mctx.scene.propRadius = r

    this.updateDrawLines(mpos[0], mpos[1])
    this.updateTransData()
    this.exec(mctx)
  }

  updateTransData() {
    const mctx = this.modal_ctx! as ViewContext
    this.applyTransform(mctx, new Matrix4())
    this.tdata = undefined

    this.genTransData(mctx)
    this.undoPre(mctx, false)
  }

  updateDrawLines(localX: number, localY: number) {
    const ctx = this.modal_ctx! as ViewContext

    if (this.centfirst) {
      this.centfirst = false
      this.center.load(this.calcCenter(ctx, this.inputs.selmask.getValue()))
    }

    //return;

    const axis_colors: string[] = ['red', 'green', 'blue']
    const view3d = ctx.view3d

    const c = this.inputs.constraint.getValue()
    this.resetDrawLines()

    const cent = this.calcCenter(ctx, this.inputs.selmask.getValue())

    const sco = new Vector4(cent as unknown as number[])
    sco[3] = 1.0
    view3d.project(sco)

    const dpi = window.devicePixelRatio

    let r = this.inputs.propRadius.getValue()
    r *= view3d.glSize[1] / sco[3] / dpi

    if (this.inputs.propEnabled.getValue()) {
      this.addDrawCircle2D(sco as unknown as Vector2, r, 'rgba(0.8,0.8,0.8,1.0)' as unknown as Vector4)
    }

    if (c.dot(c) === 1.0) {
      const v1 = new Vector3(c)
      const v2 = new Vector3()

      v1.multVecMatrix(this.inputs.constraint_space.getValue())
      v2.load(v1).mulScalar(1000.0).add(this.center)
      v1.mulScalar(-1000.0).add(this.center)

      let axis = 0
      for (let i = 0; i < 3; i++) {
        if (c[i] !== 0.0) {
          axis = i
          break
        }
      }

      this.addDrawLine(v1, v2, axis_colors[axis] as unknown as Vector4)
    } else if (c.dot(c) === 2.0) {
      const v1 = new Vector3()
      const v2 = new Vector3()
      let axis = 0

      for (let i = 0; i < 3; i++) {
        if (c[i] === 0.0) {
          axis = i
          break
        }
      }

      v1[((axis + 1) % 3) as 0 | 1 | 2] -= 1000.0
      v2[((axis + 1) % 3) as 0 | 1 | 2] += 1000.0
      v1.multVecMatrix(this.inputs.constraint_space.getValue())
      v2.multVecMatrix(this.inputs.constraint_space.getValue())
      v1.add(this.center)
      v2.add(this.center)

      this.addDrawLine(v1, v2, axis_colors[(axis + 1) % 3] as unknown as Vector4)

      v1.zero()
      v2.zero()
      v1[((axis + 2) % 3) as 0 | 1 | 2] -= 1000.0
      v2[((axis + 2) % 3) as 0 | 1 | 2] += 1000.0
      v1.multVecMatrix(this.inputs.constraint_space.getValue())
      v2.multVecMatrix(this.inputs.constraint_space.getValue())
      v1.add(this.center)
      v2.add(this.center)
      this.addDrawLine(v1, v2, axis_colors[(axis + 2) % 3] as unknown as Vector4)
    }
  }

  on_pointermove(e: PointerEvent) {
    const mctx = this.modal_ctx! as ViewContext
    const view3d = mctx.view3d

    this._mpos.load(view3d.getLocalMouse(e.x, e.y))
    this._first = false

    this.updateDrawLines(this._mpos[0], this._mpos[1])
  }

  doNumericInput(key: number) {
    if (this.numericVal === undefined) {
      this.numericVal = {
        sign : 1,
        str  : '',
        value: 0.0,
      }
    }

    const num = this.numericVal

    if (key === keymap['-']) {
      num.sign *= -1
    } else if (key >= keymap['Key0'] && key <= keymap['Key9']) {
      num.str += key - keymap['Key0']
    } else if (key === keymap['.']) {
      if (num.str === '') {
        num.str = '0'
      }

      num.str += '.'
    } else if (key === keymap['Backspace']) {
      if (num.str.length > 0) {
        num.str = num.str.slice(0, num.str.length - 1)
      }
    }

    let f = num.str
    if (f.endsWith('.')) {
      f = f.slice(0, f.length - 1)
    }

    if (f.length === 0) {
      return
    }

    if (isNaN(parseFloat(f))) {
      // eslint-disable-next-line no-console
      console.error('Numeric input error! ' + f)
      return
    }

    const fval = parseFloat(f) * num.sign
    this.numericSet(fval)

    this.exec(this.modal_ctx! as ViewContext)
    window.redraw_viewport()
  }

  on_keydown(e: KeyboardEvent) {
    let doprop = false
    let sign = undefined

    if (e.ctrlKey && (e.keyCode === keymap['='] || e.keyCode === keymap['-'])) {
      doprop = true
      sign = e.keyCode === keymap['='] ? 1.0 : -1.0
    }

    if (e.keyCode === keymap['NumPlus'] || e.keyCode === keymap['NumMinus']) {
      doprop = true
      sign = e.keyCode === keymap['NumPlus'] ? 1.0 : -1.0
    }

    if (doprop) {
      let r = this.inputs.propRadius.getValue()
      const step = 0.15

      r *= 1.0 + step * sign!

      this.updatePropRadius(r, this._mpos)

      return
    }

    let numeric = e.keyCode === keymap['-'] || e.keyCode === keymap['.']
    numeric = numeric || (e.keyCode >= keymap['Key0'] && e.keyCode <= keymap['Key9'])
    numeric = numeric || e.keyCode === keymap['Backspace']

    if (numeric) {
      this.doNumericInput(e.keyCode)
      return
    }

    switch (e.keyCode) {
      case keymap['Escape']:
        //if (!this.numericVal) {
        this.cancel()
        //} else {
        //  this.numericVal = undefined;
        //}
        break
      case keymap['Enter']:
        this.finish()
        break
      case keymap['X']:
      case keymap['Y']:
      case keymap['Z']: {
        const axis = e.keyCode - keymap['X']

        const c = new Vector3()
        if (e.shiftKey) {
          c[(axis + 1) % 3] = c[(axis + 2) % 3] = 1.0
        } else {
          c[axis] = 1.0
        }

        this.inputs.constraint.setValue(c)
        this.exec(this.modal_ctx! as ViewContext)
        break
      }
    }

    window.redraw_viewport()
  }

  execPre(ctx: ViewContext) {
    this.genTransData(ctx)
    this.center = this.calcCenter(ctx, this.inputs.selmask.getValue())
  }

  execPost(ctx: ViewContext) {
    //prevent reference leaks from keeping this.tdata around
    this.tdata = undefined
  }
}

export class TranslateOp extends TransformOp {
  mpos: Vector3
  first: boolean

  constructor(start_mpos?: Vector3) {
    super()

    this.mpos = new Vector3()

    if (start_mpos !== undefined) {
      this.mpos.load(start_mpos)
      this.mpos[2] = 0.0

      this.first = false
    } else {
      this.first = true
    }
  }

  static tooldef() {
    return {
      uiname     : 'Translate',
      description: 'Translation tool',
      toolpath   : 'view3d.translate',
      is_modal   : true,
      inputs     : {},
      icon       : -1,
    }
  }

  numericSet(val: number) {
    const off = this.inputs.value.getValue()
    off.zero()
    const con = this.inputs.constraint.getValue()

    const mask = 1 * +!!con[0] + 2 * +!!con[1] + 4 * +!!con[2]

    switch (mask) {
      case 0:
      case 7:
        off[0] = off[1] = off[2] = val
        break
      case 1:
        off[0] = val
        break
      case 2:
        off[1] = val
        break
      case 4:
        off[2] = val
        break
      case 3:
        off[0] = off[1] = val
        break
      case 5:
        off[0] = off[2] = val
        break
      case 6:
        off[1] = off[2] = val
    }
  }

  on_pointermove(e: PointerEvent) {
    super.on_pointermove(e)

    if (this.numericVal !== undefined) {
      return
    }

    const ctx = this.modal_ctx! as ViewContext
    const view3d = ctx.view3d

    const cent = this.center
    const scent = new Vector4(cent as unknown as number[])

    const mpos = view3d.getLocalMouse(e.x, e.y)
    const x = mpos[0]
    const y = mpos[1]

    if (this.first) {
      this.mpos[0] = x
      this.mpos[1] = y
      this.first = false
      return
    }

    const dx = x - this.mpos[0]
    const dy = y - this.mpos[1]

    const scent2 = new Vector4(scent)

    scent2[3] = 1.0
    view3d.project(scent2)

    scent2[0] += dx
    scent2[1] += dy

    scent2[3] = 1.0
    view3d.unproject(scent2)

    scent.load(scent2)

    const off = new Vector3(scent).sub(cent)

    let con = this.inputs.constraint.getValue()
    const is_plane = con.dot(con) != 0.0 && con.dot(con) != 1.0 && con.dot(con) != 3.0

    if (is_plane) {
      //are we constraining to a plane?
      con = new Vector3(con)
      for (let i = 0; i < con.length; i++) {
        con[i] = con[i] == 0.0 ? 1.0 : 0.0
      }
      con.normalize()
      con.multVecMatrix(this.inputs.constraint_space.getValue())
      con.normalize()

      const cent2 = new Vector3(this.center)
      view3d.project(cent2)
      //cent2.negate();

      const view = view3d.getViewVec(cent2[0] + dx, cent2[1] + dy)

      const isect = isect_ray_plane(this.center, con, view3d.activeCamera.pos, view)

      if (isect !== undefined) {
        off.load(isect).sub(cent)
      } else {
        return
      }
      //(planeorigin, planenormal, rayorigin, raynormal)
      //isect_ray_plane
    } else if (con.dot(con) != 3.0) {
      //project to line
      const p1 = new Vector3(cent)
      const p2 = new Vector3(scent)

      view3d.project(p1)
      view3d.project(p2)

      const n = new Vector3(con)

      const mm = new Matrix4(this.inputs.constraint_space.getValue())

      n.multVecMatrix(mm)
      n.normalize()

      const worldn = new Vector3(n)
      const n2 = new Vector3(n)

      n2.load(cent).add(n)
      n.load(cent)

      view3d.project(n)
      view3d.project(n2)

      const t = new Vector3()
      view3d.project(t.load(scent))
      t.sub(n)

      n.sub(n2).negate().normalize()

      const s = t[0] * n[0] + t[1] * n[1]

      view3d.project(p1.load(cent))
      p1.addFac(n, s)
      view3d.unproject(p1)
      off.load(p1).sub(cent)

      p2.load(cent).addFac(worldn, s)
    }

    const snap = this.inputs.snapMode.getValue()
    if (snap == SnapModes.SURFACE) {
      const co = new Vector3(this.center).add(off)
      const sco = new Vector3(co)

      view3d.project(sco)

      const ret = castViewRay(ctx, SelMask.OBJECT | SelMask.GEOM, sco, view3d)

      if (ret.length > 0) {
        co.sub(ret[0].p3d).negate()
        off.add(co)
      }
    }

    this.inputs.value.setValue(off)

    this.exec(ctx)
    this.doUpdates(ctx)
    window.redraw_viewport(true)
  }

  exec(ctx: ViewContext) {
    super.exec(ctx)

    const mat = new Matrix4()

    let off = new Vector3(this.inputs.value.getValue())
    //off.mul(this.inputs.constraint.getValue());

    const con = this.inputs.constraint.getValue()
    if (con.dot(con) !== 3.0) {
      const cmat = this.inputs.constraint_space.getValue()
      const icmat = new Matrix4(cmat)
      icmat.invert()

      off = new Vector3(off)
      off.multVecMatrix(icmat)
      //off.mul(this.inputs.constraint.getValue());
      off.multVecMatrix(cmat)
    }

    mat.translate(off[0], off[1], off[2])

    this.applyTransform(ctx, mat)
  }
}

ToolOp.register(TranslateOp)

export class ScaleOp extends TransformOp {
  mpos: Vector3
  first: boolean

  constructor(start_mpos?: Vector3) {
    super()

    this.mpos = new Vector3()

    if (start_mpos !== undefined) {
      this.mpos.load(start_mpos)
      this.mpos[2] = 0.0

      this.first = false
    } else {
      this.first = true
    }
  }

  static tooldef() {
    return {
      uiname     : 'Scale',
      description: 'Scale tool',
      toolpath   : 'view3d.scale',
      is_modal   : true,
      inputs     : {},
      icon       : -1,
    }
  }

  numericSet(val: number) {
    const off = this.inputs.value.getValue()
    off.zero().addScalar(1.0)

    const con = this.inputs.constraint.getValue()

    const mask = 1 * +!!con[0] + 2 * +!!con[1] + 4 * +!!con[2]

    switch (mask) {
      case 0:
      case 7:
        off[0] = off[1] = off[2] = val
        break
      case 1:
        off[0] = val
        break
      case 2:
        off[1] = val
        break
      case 4:
        off[2] = val
        break
      case 3:
        off[0] = off[1] = val
        break
      case 5:
        off[0] = off[2] = val
        break
      case 6:
        off[1] = off[2] = val
    }

    this.inputs.value.setValue(off)
  }

  on_pointermove(e: PointerEvent) {
    super.on_pointermove(e)

    if (this.numericVal !== undefined) {
      return
    }

    const ctx = this.modal_ctx! as ViewContext
    const view3d = ctx.view3d

    const cent = this.center
    const scent = new Vector3(cent)

    const mpos = new Vector3().load2(view3d.getLocalMouse(e.x, e.y))
    mpos[2] = 0.0

    const x = mpos[0]
    const y = mpos[1]

    if (this.first) {
      this.mpos[0] = x
      this.mpos[1] = y
      this.mpos[2] = 0.0

      this.first = false
      return
    }

    const dx = x - this.mpos[0]
    const dy = y - this.mpos[1]

    view3d.project(scent)
    scent[0] += dx
    scent[1] += dy
    view3d.unproject(scent)

    const off = new Vector3(scent).sub(cent)

    let con = this.inputs.constraint.getValue()
    const is_plane = con.dot(con) != 0.0 && con.dot(con) != 1.0 && con.dot(con) != 3.0

    if (is_plane) {
      //are we constraining to a plane?
      con = new Vector3(con)
      for (let i = 0; i < con.length; i++) {
        con[i] = con[i] == 0.0 ? 1.0 : 0.0 ? 1.0 : 0.0
      }
      con.normalize()
      con.multVecMatrix(this.inputs.constraint_space.getValue())
      con.normalize()

      const cent2 = new Vector3(this.center)
      view3d.project(cent2)
      //cent2.negate();

      const view = view3d.getViewVec(cent2[0] + dx, cent2[1] + dy)

      const isect = isect_ray_plane(this.center, con, view3d.camera.pos, view)

      if (isect !== undefined) {
        off.load(isect).sub(cent)
      } else {
        return
      }
      //(planeorigin, planenormal, rayorigin, raynormal)
      //isect_ray_plane
    } else if (Math.abs(con.dot(con) - 3.0) > 0.001) {
      //project to line
      const p1 = new Vector3(cent)
      const p2 = new Vector3(scent)

      view3d.project(p1)
      view3d.project(p2)

      const n = new Vector3(con)

      const mm = new Matrix4(this.inputs.constraint_space.getValue())

      n.multVecMatrix(mm)
      n.normalize()

      const worldn = new Vector3(n)
      const n2 = new Vector3(n)

      n2.load(cent).add(n)
      n.load(cent)

      view3d.project(n)
      view3d.project(n2)

      const t = new Vector3()
      view3d.project(t.load(scent))
      t.sub(n)

      n.sub(n2).negate().normalize()

      const s = t[0] * n[0] + t[1] * n[1]

      view3d.project(p1.load(cent))
      p1.addFac(n, s)
      view3d.unproject(p1)
      off.load(p1).sub(cent)

      p2.load(cent).addFac(worldn, s)
    } else {
      scent.load(cent)
      view3d.project(scent)

      this.mpos[2] = scent[2]
      mpos[2] = scent[2]

      const l1 = this.mpos.vectorDistance(scent)
      const l2 = mpos.vectorDistance(scent)
      let ratio = 1.0

      if (l1 !== 0.0 && l2 !== 0.0) {
        ratio = l2 / l1
      }

      off[0] = off[1] = off[2] = ratio
    }

    this.inputs.value.setValue(off)

    this.exec(ctx)
    this.doUpdates(ctx)
    window.redraw_viewport()
  }

  exec(ctx: ViewContext) {
    super.exec(ctx)
    const mat = new Matrix4()

    let off = new Vector3(this.inputs.value.getValue())
    //off.mul(this.inputs.constraint.getValue());
    const cent = this.center

    const con = this.inputs.constraint.getValue()
    mat.translate(cent[0], cent[1], cent[2])

    if (con.dot(con) !== 3.0) {
      const cmat = this.inputs.constraint_space.getValue()
      const icmat = new Matrix4(cmat)
      icmat.invert()

      off = new Vector3(off)
      off.multVecMatrix(icmat)
      //off.mul(this.inputs.constraint.getValue());
      off.multVecMatrix(cmat)

      mat.scale(1.0 + off[0], 1.0 + off[1], 1.0 + off[2])
    } else {
      mat.scale(off[0], off[1], off[2])
    }
    mat.translate(-cent[0], -cent[1], -cent[2])

    this.applyTransform(ctx, mat)
  }
}

ToolOp.register(ScaleOp)

export class RotateOp<Inputs extends PropertySlots = {}, Outputs extends PropertySlots = {}> extends TransformOp<
  Inputs & {
    euler: Vec3Property
  },
  Outputs
> {
  mpos: Vector3
  last_mpos: Vector3
  start_mpos: Vector3
  thsum: number
  trackball: boolean | number
  first: boolean

  constructor(start_mpos?: Vector3) {
    super()

    this.mpos = new Vector3()
    this.last_mpos = new Vector3()
    this.start_mpos = new Vector3()
    this.thsum = 0
    this.trackball = false

    if (start_mpos !== undefined) {
      this.mpos.load(start_mpos)
      this.mpos[2] = 0.0

      this.first = false
    } else {
      this.first = true
    }
  }

  static tooldef() {
    return {
      uiname     : 'Rotate',
      description: 'Rotate',
      toolpath   : 'view3d.rotate',
      is_modal   : true,
      inputs: {
        euler: new Vec3Property(),
      },
      icon       : -1,
    }
  }

  on_pointermove(e: PointerEvent) {
    if (this.numericVal !== undefined) {
      return
    }

    if (this.trackball) {
      return this.on_pointermove_trackball(e)
    } else {
      return this.on_pointermove_normal(e)
    }
  }

  on_keydown(e: KeyboardEvent) {
    if (e.keyCode === keymap['R'] && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      this.trackball = !this.trackball
    } else {
      return super.on_keydown(e)
    }
  }

  on_pointermove_normal(e: PointerEvent) {
    super.on_pointermove(e)

    const ctx = this.modal_ctx! as ViewContext
    const view3d = ctx.view3d

    const cent = this.center
    const scent = new Vector3(cent)

    view3d.project(scent)

    const mpos = new Vector3().load2(view3d.getLocalMouse(e.x, e.y))
    mpos[2] = scent[2]

    const x = mpos[0]
    const y = mpos[1]
    this.mpos[0] = x
    this.mpos[1] = y
    this.mpos[2] = mpos[2]

    if (this.first) {
      this.last_mpos.load(this.mpos)
      this.start_mpos.load(this.mpos)

      this.first = false
      return
    }

    const rco = new Vector3([mpos[0], mpos[1], scent[2]])
    view3d.unproject(rco)

    //this.makeTempLine(cent, rco, "orange");

    const axismap: {[key: number]: number} = {
      3: 2, //xy
      5: 1, //zy,
      6: 0, //xz,
      0: 0,
      1: 0,
      2: 1,
      4: 2,
    }

    const con = this.inputs.constraint.getValue()
    if (con.dot(con) !== 3.0) {
      let mask = 0
      for (let i = 0; i < con.length; i++) {
        mask |= con[i] !== 0.0 ? 1 << i : 0
      }

      const axis = axismap[mask]

      const cmat = this.inputs.constraint_space.getValue()
      const icmat = new Matrix4(cmat)
      icmat.invert()

      const view1 = view3d.getViewVec(this.mpos[0], this.mpos[1])
      //let view2 = view3d.getViewVec(this.last_mpos[0], this.last_mpos[1]);
      const view2 = view3d.getViewVec(this.last_mpos[0], this.last_mpos[1])

      const plane = new Vector3()
      plane[axis] = 1.0

      plane.multVecMatrix(cmat)
      const origin = new Vector3(this.center)

      plane.normalize()
      view1.normalize()
      view2.normalize()

      const near = -view3d.activeCamera.near - 0.000001
      //near *= -1.0 / (view3d.activeCamera.far - view3d.activeCamera.near);

      let rayOrigin = new Vector3([this.mpos[0], this.mpos[1], near])
      const lastco = new Vector3([this.last_mpos[0], this.last_mpos[1], near])

      view3d.unproject(rayOrigin)
      view3d.unproject(lastco)

      rayOrigin = view3d.activeCamera.pos

      const isect1 = isect_ray_plane(origin, plane, rayOrigin, view1)
      const isect2 = isect_ray_plane(origin, plane, lastco, view2)

      this.makeTempLine(isect1, this.center, 'green')
      //this.makeTempLine(isect2, this.center, "blue");

      /*
      for (let i=-10; i<=10; i++) {
        for (let j=0; j<2; j++) {
          let v1 = new Vector3(this.center);
          let v2 = new Vector3(this.center);

          let j2 = j ? 2 : 1;

          v1[(axis + j2) % 3] -= 2.5;
          v2[(axis + j2) % 3] += 2.5;
          let df = 0.2;

          j2 = j ? 1 : 2;
          v1[(axis + j2) % 3] += df * i;
          v2[(axis + j2) % 3] += df * i;

          this.makeTempLine(v1, v2, "teal");
        }
      }
      //*/

      if (!isect1 || !isect2) {
        return
      }

      view3d.project(isect1)
      view3d.project(isect2)

      isect1.sub(scent)
      isect2.sub(scent)

      //isect1.sub(this.center);
      //isect2.sub(this.center);

      isect1.normalize()
      isect2.normalize()

      let w = isect1[0] * isect2[1] - isect1[1] * isect2[0]

      w = Math.asin(w * 0.999)

      if (plane.dot(view2) < 0.0) {
        w *= -1
      }
      this.thsum += w

      //this.inputs.euler.getValue().zero();
      //this.inputs.euler.getValue()[axis] = this.thsum;

      this._update()
    } else {
      const v1 = new Vector2(this.mpos).sub(scent)
      const v2 = new Vector2(this.last_mpos).sub(scent)

      v1.normalize()
      v2.normalize()

      let w = v1[0] * v2[1] - v1[1] * v2[0]

      w = -Math.asin(w * 0.999)
      this.thsum += w

      this._update()

      /*
      let mat = new Matrix4();
      let rmat = new Matrix4(view3d.activeCamera.rendermat);
      rmat.makeRotationOnly();

      let irmat = new Matrix4(rmat);
      let eul = new Vector3();

      irmat.invert();

      let rotmat = new Matrix4();
      rotmat.euler_rotate_order(0, 0, this.thsum, EulerOrders.XYZ);

      mat.multiply(irmat);
      mat.multiply(rotmat);
      mat.multiply(rmat);

      mat.decompose(new Vector3(), eul);

      this.inputs.euler.setValue(eul);

      // */
    }

    this.exec(ctx)

    this.last_mpos.load(this.mpos)
  }

  _update() {
    if (this.trackball) {
      return
    }

    const ctx = this.modal_ctx! as ViewContext
    const view3d = ctx.view3d

    const cent = this.center
    const scent = new Vector3(cent)

    view3d.project(scent)

    //this.makeTempLine(cent, rco, "orange");

    const axismap: {[key: number]: number} = {
      3: 2, //xy
      5: 1, //zy,
      6: 0, //xz,
      0: 0,
      1: 0,
      2: 1,
      4: 2,
    }

    const con = this.inputs.constraint.getValue()
    if (con.dot(con) !== 3.0) {
      let mask = 0
      for (let i = 0; i < con.length; i++) {
        mask |= con[i] !== 0.0 ? 1 << i : 0
      }

      const axis = axismap[mask]

      const cmat = new Matrix4(this.inputs.constraint_space.getValue())
      cmat.makeRotationOnly()

      const icmat = new Matrix4(cmat)
      icmat.invert()

      const eul = this.inputs.euler.getValue()

      eul.zero()
      eul[axis] = this.thsum

      const mat = new Matrix4()
      mat.euler_rotate_order(eul[0], eul[1], eul[2], EulerOrders.XYZ)
      mat.multiply(icmat)
      mat.decompose(new Vector3(), eul, undefined, undefined, undefined, EulerOrders.XYZ)

      this.inputs.euler.setValue(eul)
    } else {
      const mat = new Matrix4()
      const rmat = new Matrix4(view3d.activeCamera.rendermat)
      rmat.makeRotationOnly()

      const irmat = new Matrix4(rmat)
      const eul = new Vector3()

      irmat.invert()

      const rotmat = new Matrix4()
      rotmat.euler_rotate_order(0, 0, this.thsum, EulerOrders.XYZ)

      mat.multiply(irmat)
      mat.multiply(rotmat)
      mat.multiply(rmat)

      mat.decompose(new Vector3(), eul)

      this.inputs.euler.setValue(eul)
    }
  }

  numericSet(value: number) {
    this.thsum = (value / 180.0) * Math.PI
    this._update()
  }

  on_pointermove_trackball(e: PointerEvent) {
    super.on_pointermove(e)

    const ctx = this.modal_ctx! as ViewContext
    const view3d = ctx.view3d

    const cent = this.center
    const scent = new Vector3(cent)

    view3d.project(scent)
    scent[2] = 0.0

    const mpos = new Vector3().load2(view3d.getLocalMouse(e.x, e.y))
    mpos[2] = 0.0

    const x = mpos[0]
    const y = mpos[1]

    if (this.first) {
      this.mpos[0] = x
      this.mpos[1] = y
      this.mpos[2] = 0.0

      this.last_mpos.load(this.mpos)

      this.first = false
      return
    }

    const rx = x - this.mpos[0]
    const ry = y - this.mpos[1]

    const rot = new Vector3()

    const mat = new Matrix4()
    const rscale = 0.004
    rot[0] = rx * rscale
    rot[1] = ry * rscale

    const cmat = new Matrix4(view3d.activeCamera.cameramat)
    cmat.makeRotationOnly()

    const cmat2 = new Matrix4(cmat)
    cmat2.invert()

    //mat.multiply(cmat);
    mat.euler_rotate(rot[0], rot[1], rot[2])
    //mat.euler_rotate(0, 0, rx*rscale);
    //mat.multiply(cmat);

    mat.decompose(undefined, rot)

    this.inputs.euler.setValue(rot)

    this.exec(ctx)
    this.doUpdates(ctx)
    window.redraw_viewport()

    this.last_mpos.load(mpos)
  }

  exec(ctx: ViewContext) {
    super.exec(ctx)
    const mat = new Matrix4()

    const cent = this.center

    const con = this.inputs.constraint.getValue()
    let eul = this.inputs.euler.getValue()

    const axismap: {[key: number]: number} = {
      3: 2, //xy
      5: 1, //zy,
      6: 0, //xz,
      0: 0,
      1: 0,
      2: 1,
      4: 2,
    }

    if (con.dot(con) !== 3.0) {
      eul = new Vector3(eul)

      let mask = 0
      for (let i = 0; i < con.length; i++) {
        mask |= con[i] !== 0.0 ? 1 << i : 0
      }

      const axis = axismap[mask]

      const cmat = this.inputs.constraint_space.getValue()
      const icmat = new Matrix4(cmat)
      icmat.invert()

      //console.log(cmat.toString());

      const mat2 = new Matrix4()
      mat2.euler_rotate_order(eul[0], eul[1], eul[2], EulerOrders.XYZ)
      mat2.multiply(cmat)

      //avoid gimble lock
      const order = axis === 1 ? EulerOrders.YZX : EulerOrders.XYZ

      mat2.decompose(new Vector3(), eul, undefined, undefined, undefined, order)

      eul[(axis + 1) % 3] = 0
      eul[(axis + 2) % 3] = 0

      mat.euler_rotate_order(eul[0], eul[1], eul[2], order)
      mat.multiply(icmat)
    } else {
      mat.euler_rotate_order(eul[0], eul[1], eul[2], EulerOrders.XYZ)
    }

    const mat2 = new Matrix4()
    //mat2.translate(-off[0], -off[1], -off[2]);
    mat2.translate(cent[0], cent[1], cent[2])
    mat2.multiply(mat)
    mat2.translate(-cent[0], -cent[1], -cent[2])
    //mat2.translate(off[0], off[1], off[2]);

    this.applyTransform(ctx, mat2)

    window.redraw_viewport(true)
  }
}

ToolOp.register(RotateOp)
