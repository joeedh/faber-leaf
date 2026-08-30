import {PropertySlots, Vector2, Vector3, Vector4} from '../../path.ux/scripts/pathux.js'
import {ToolOpBase} from '../../core/toolopbase'
import {DrawLine, DrawQuad} from './view3d_base'

export abstract class View3DOp<InputSet extends PropertySlots, OutputSet extends PropertySlots> //
  extends ToolOpBase<InputSet, OutputSet>
{
  drawlines: DrawLine[]
  drawquads: DrawQuad[]
  drawlines2d: SVGLineElement[]

  constructor() {
    super()

    this.drawlines = []
    this.drawquads = []
    this.drawlines2d = []
  }

  modalEnd(wasCancelled?: boolean) {
    this.resetDrawLines()
    return super.modalEnd(wasCancelled ?? false)
  }

  addDrawQuad(v1: Vector3, v2: Vector3, v3: Vector3, v4: Vector3, color: Vector4, useZ = true) {
    const dq = this.modal_ctx!.view3d.makeDrawQuad(v1, v2, v3, v4, color, useZ)
    this.drawquads.push(dq)
    return dq
  }

  addDrawLine(v1: Vector3, v2: Vector3, color: Vector4, useZ = true) {
    const dl = this.modal_ctx!.view3d.makeDrawLine(v1, v2, color, useZ)
    this.drawlines.push(dl)
    return dl
  }

  addDrawLine2D(v1: Vector2, v2: Vector2, color: Vector4) {
    // overdraw.line() expects a CSS color string; existing callers pass a Vector4 — preserve behavior via a localized cast.
    const dl = this.modal_ctx!.view3d.overdraw!.line(v1, v2, color as unknown as string)
    this.drawlines2d.push(dl)

    return dl
  }

  addDrawCircle2D(p: Vector2, r: number, color: Vector4, quality = 15) {
    let steps = Math.ceil((r * 2.0 * Math.PI) / quality)
    steps = Math.max(steps, 6)

    let t = -Math.PI
    const dt = (2.0 * Math.PI) / (steps - 1)
    const p1 = new Vector2()
    const p2 = new Vector2()

    for (let i = 0; i < steps; i++, t += dt) {
      p1[0] = Math.sin(t) * r + p[0]
      p1[1] = Math.cos(t) * r + p[1]

      if (i > 0) {
        this.addDrawLine2D(p2, p1, color)
      }

      p2.load(p1)
    }
  }

  resetTempGeom() {
    this.resetDrawLines()
  }

  resetDrawLines() {
    for (const dl of this.drawlines) {
      this.modal_ctx!.view3d.removeDrawLine(dl)
    }

    for (const dl of this.drawlines2d) {
      dl.remove()
    }

    for (const dq of this.drawquads) {
      this.modal_ctx!.view3d.removeDrawQuad(dq)
    }

    this.drawlines.length = 0
    this.drawquads.length = 0
    this.drawlines2d.length = 0
  }

  removeDrawLine(dl: DrawLine | SVGLineElement) {
    if (dl instanceof DrawLine) {
      if (this.drawlines.includes(dl)) {
        this.modal_ctx!.view3d.removeDrawLine(dl)
        this.drawlines.remove(dl)
      }
    } else if (this.drawlines2d.includes(dl)) {
      this.drawlines2d.remove(dl)
      dl.remove()
    }
  }
}
