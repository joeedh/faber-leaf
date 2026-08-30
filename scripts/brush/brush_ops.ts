import {ToolOp, StringProperty, nstructjs, PropertySlots, ToolDef, Vector4} from '../path.ux/scripts/pathux.js'
import {SculptBrush, DefaultBrushes, getBrushes} from './brush'
import {Icons} from '../editors/icon_enum.js'
import type {ToolContext} from '../core/context'
import {BlockLoader, BlockLoaderAddUser} from '../core/lib_api.js'

export class BrushOp<InputSlots extends PropertySlots = {}, OutputSlots extends PropertySlots = {}> extends ToolOp<
  InputSlots & {
    dataPath: StringProperty
  },
  OutputSlots
> {
  _undo:
    | {
        dview: DataView | undefined
      }
    | undefined

  static tooldef(): ToolDef {
    return {
      inputs: {
        dataPath: new StringProperty('scene.tools.sculpt'),
      },
      toolpath: '',
      uiname  : '',
    }
  }

  constructor() {
    super()
    this._undo = undefined
  }

  static invoke(ctx: ToolContext, args: any) {
    const tool = super.invoke(ctx, args)
    if (ctx.toolmode && !('dataPath' in args)) {
      tool.inputs.dataPath.setValue('scene.tools.' + ctx.toolmode.constructor.toolModeDefine().name)
    }
    return tool
  }

  getBrush(ctx: ToolContext): SculptBrush | undefined {
    const brush = ctx.api.getValue(ctx, this.inputs.dataPath.getValue()) as SculptBrush | undefined

    if (!brush) {
      // eslint-disable-next-line no-console
      console.warn('No brush at datapath ' + this.inputs.dataPath.getValue())
    }

    return brush
  }

  undoPre(ctx: ToolContext) {
    const undo = (this._undo = {
      dview: undefined as DataView | undefined,
    })

    const brush = this.getBrush(ctx)
    if (brush) {
      let data: number[] | Uint8Array | DataView = []
      nstructjs.writeObject(data, brush)

      data = new Uint8Array(data)
      data = new DataView(data.buffer)
      undo.dview = data
    }
  }

  undo(ctx: ToolContext) {
    const brush = this.getBrush(ctx)

    if (!brush) {
      return
    }

    const dview = this._undo!.dview
    if (!dview) {
      // eslint-disable-next-line no-console
      console.warn('Warning, brush existed but not undo data')
      return
    }

    const brush2 = nstructjs.readObject(dview, SculptBrush)

    const gb = (dref: Parameters<typeof ctx.datalib.get>[0]) => {
      return ctx.datalib.get(dref)
    }

    const gb_us = (dref: Parameters<typeof ctx.datalib.get>[0], owner?: unknown) => {
      if (!owner) {
        owner = brush2
      }

      const block = ctx.datalib.get(dref)
      if (block) {
        block.lib_addUser(owner as Parameters<typeof block.lib_addUser>[0])
      }

      return block
    }

    brush2.dataLink(gb as BlockLoader, gb_us as BlockLoaderAddUser)

    if (brush.texUser.texture) {
      brush.texUser.texture.lib_remUser(brush)
    }

    brush2.copyTo(brush)

    if (brush.texUser.texture) {
      brush.texUser.texture.lib_addUser(brush)
    }
  }
}

export class LoadDefaultBrush<
  InputSlots extends PropertySlots = {},
  OutputSlots extends PropertySlots = {},
> extends BrushOp<InputSlots, OutputSlots> {
  static tooldef() {
    return {
      uiname  : 'Load Brush Defaults',
      toolpath: 'brush.load_default',
      inputs  : {},
      icon    : Icons.RELOAD,
    }
  }

  exec(ctx: ToolContext) {
    const brush = this.getBrush(ctx)
    if (!brush) {
      return
    }

    let brush2: SculptBrush | undefined
    const comb = DefaultBrushes.brushes['Comb']

    if (brush.name === comb?.name && brush.tool === comb?.tool) {
      brush2 = comb
    } else {
      for (const k in DefaultBrushes.brushes) {
        const brush3 = DefaultBrushes.brushes[k]

        if (brush3.tool === brush.tool) {
          brush2 = brush3
          break
        }
      }
    }

    if (!brush2) {
      // eslint-disable-next-line no-console
      console.warn('No default brush found for tool:', brush.tool)
      return
    }

    if (brush.texUser.texture) {
      brush.texUser.texture.lib_remUser(brush)
    }

    brush2.copyTo(brush)

    if (brush.texUser.texture) {
      brush.texUser.texture.lib_addUser(brush)
    }

    brush.graphUpdate()
    window.updateDataGraph()
  }
}

ToolOp.register(LoadDefaultBrush)

export class SwapBrushColors<
  InputSlots extends PropertySlots = {},
  OutputSlots extends PropertySlots = {},
> extends BrushOp<InputSlots, OutputSlots> {
  static tooldef() {
    return {
      uiname     : 'Swap Colors',
      toolpath   : 'brush.swap_colors',
      description: 'Swap primary and secondary colors',
      inputs     : {},
      icon       : Icons.SWAP_COLORS,
    }
  }

  exec(ctx: ToolContext) {
    const brush = this.getBrush(ctx)
    if (!brush) {
      return
    }

    const tmp = new Vector4(brush.color)
    brush.color.load(brush.bgcolor)
    brush.bgcolor.load(tmp)

    brush.graphUpdate()
    window.updateDataGraph()
  }
}

ToolOp.register(SwapBrushColors)

export class ReloadAllBrushes extends ToolOp {
  static tooldef() {
    return {
      uiname     : 'Reload All Brushes',
      toolpath   : 'brush.reload_all_defaults',
      description: 'Reload all brushes from defaults',
      icon       : Icons.RELOAD,
    }
  }

  exec(ctx: ToolContext) {
    getBrushes(ctx, true)
  }
}
ToolOp.register(ReloadAllBrushes)
