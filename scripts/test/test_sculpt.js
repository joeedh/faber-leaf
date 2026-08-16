import {TestAction} from './test_base.js'
import {getBrushes} from '../brush/brush.ts'
import {Vector2, Vector3, Vector4, Quat, Matrix4} from '../util/vectormath.js'
import * as util from '../util/util.js'
import * as math from '../util/math.js'
import {PaintSample} from '../editors/view3d/tools/stroke_base.ts'

export class SculptAction extends TestAction {
  constructor(brushtool, delay = 0, op = 'bvh.paint', args = {}) {
    super()

    this.tool = brushtool
    this.args = args
    this.toolpath = op

    //internal members
    this.toolop = undefined
    this.brush = undefined

    this.points = []
  }

  reset() {
    this.toolop = undefined
    return this
  }

  exec(ctx) {
    let brushes = getBrushes(ctx, false)

    let brush = (this.brush = brushes[this.tool].copy())

    for (let k in this.args) {
      if (brush[k] !== undefined) {
        brush[k] = this.args[k]
      }
    }

    let args = this.args
    let pressure = args.pressure !== undefined ? args.pressure : 1.0
    let invert = args.invert !== undefined ? args.invert : false

    return new Promise((accept, reject) => {
      let toolop = this.getToolOp(ctx)

      let mesh = ctx.mesh
      let bvh = mesh.getBVH()

      toolop.modalRunning = false
      toolop.modal_ctx = ctx

      toolop.undoPre(ctx)

      for (let vp of this.points) {
        toolop.sampleViewRay(vp.rendermat, vp.mpos, vp.viewvec, vp.viewp, pressure, invert)
      }

      toolop.execPre(ctx)
      toolop.exec(ctx)
      toolop.execPost(ctx)

      accept()
    })
  }

  getToolOp(ctx) {
    if (this.toolop) {
      return this.toolop
    }

    let brush = this.brush

    let cls = ctx.api.parseToolPath(this.toolpath)

    let toolop = cls.invoke(ctx, {})

    for (let k in this.args) {
      if (k in toolop.inputs) {
        toolop.inputs[k].setValue(this.args[k])
      }
    }

    toolop.inputs.brush.setValue(brush)
    this.toolop = toolop

    return toolop
  }

  append(viewp, viewvec, rendermat, mpos) {
    viewp = new Vector3(viewp)
    viewvec = new Vector3(viewvec)
    rendermat = rendermat.clone()
    mpos = new Vector2(mpos)

    this.points.push({
      viewp,
      viewvec,
      rendermat,
      mpos,
    })

    return this
  }
}
