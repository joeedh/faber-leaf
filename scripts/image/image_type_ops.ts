/**
 * `image.set_type` — the one non-UV tool rescued from the archived image
 * editor (P18 §5 step 4).
 *
 * The archive split this across an `ImageBlockOp` base and a one-method
 * subclass; there was only ever the one subclass, so it is one class here.
 * Undo is a whole-block copy because a type conversion rewrites the pixel
 * buffer — there is no smaller record of it than the buffer itself.
 */

import {DataRef, DataRefProperty} from '../core/lib_api.js'
import {ImageBlock, ImageFlags, ImageTypes} from './image.js'
import {EnumProperty, ToolOp, type ToolDef} from '../path.ux/scripts/pathux.js'
import type {ToolContext} from '../core/context'

type SetImageTypeInputs = {
  image: DataRefProperty<ImageBlock>
  type: EnumProperty<number>
}

export class SetImageTypeOp extends ToolOp<SetImageTypeInputs, {}, ToolContext, ToolContext> {
  _undoRef?: DataRef
  _undoImage?: ImageBlock

  static tooldef(): ToolDef {
    return {
      uiname  : 'Set Image Type',
      toolpath: 'image.set_type',
      inputs: {
        image: new DataRefProperty(ImageBlock),
        type : new EnumProperty(ImageTypes.FLOAT_BUFFER, ImageTypes),
      },
    }
  }

  undoPre(ctx: ToolContext): void {
    const image = ctx.datalib.get<ImageBlock>(this.inputs.image.getValue())

    this._undoRef = undefined
    this._undoImage = undefined

    if (!image) {
      return
    }

    this._undoRef = DataRef.fromBlock(image)
    this._undoImage = image.copy()
  }

  undo(ctx: ToolContext): void {
    if (!this._undoRef || !this._undoImage) {
      return
    }

    const image = ctx.datalib.get<ImageBlock>(this._undoRef)

    if (!image) {
      // eslint-disable-next-line no-console
      console.warn('Missing image in undo handler')
      return
    }

    this._undoImage.copyTo(image)
    image.flag |= ImageFlags.UPDATE
    image.glReady = false
    image.ready = false
  }

  exec(ctx: ToolContext): void {
    const image = ctx.datalib.get<ImageBlock>(this.inputs.image.getValue())

    if (!image) {
      // eslint-disable-next-line no-console
      console.warn('Missing image', this.inputs.image.getValue())
      return
    }

    image.convertTypeTo(this.inputs.type.getValue())
    image.flag |= ImageFlags.UPDATE
    image.update()
  }
}

ToolOp.register(SetImageTypeOp)
