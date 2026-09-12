import {ToolStack, UndoFlags} from '../path.ux/scripts/pathux.js'
import type {ToolOpAny, IToolOpConstructor} from '../path.ux/scripts/pathux.js'
import type {ToolContext, ViewContext} from './context.js'

/**
 * The app's undo stack. Adds three things to path.ux's ToolStack: the undo
 * memory limit follows AppSettings, every edit bumps `state.changeId` so the
 * autosave dirty gate fires, and trimming the stack nudges the GC.
 */
export class AppToolStack extends ToolStack<ToolContext, ViewContext> {
  constructor(ctx?: ToolContext) {
    super(ctx)

    this.enforceMemLimit = true
    this.memLimit = 512 * 1024 * 1024
  }

  _syncSettings(ctx: ToolContext = this.ctx): this {
    const settings = ctx.settings

    this.enforceMemLimit = settings.limitUndoMem
    this.memLimit = settings.undoMemLimit * 1024 * 1024
    return this
  }

  /** Mark the document changed so the autosave dirty gate fires. */
  _markChanged(ctx: ToolContext = this.ctx): void {
    const state = ctx?.state
    if (state) {
      state.changeId++
    }
  }

  override limitMemory(limit?: number, ctx?: ToolContext): number {
    const mem = (this.calcMemSize(ctx as never) / 1024 / 1024).toFixed(3) + 'mb'
    // eslint-disable-next-line no-console
    console.warn('Toolstack Memory:', mem)

    window.setTimeout(() => {
      // garbage collect if we have access to it
      ;(window as unknown as {gc?: () => void}).gc?.()
    })

    return super.limitMemory(limit, ctx as never)
  }

  override async execTool(ctx: ToolContext, toolop: ToolOpAny, event?: PointerEvent): Promise<void> {
    this._syncSettings(ctx)
    await super.execTool(ctx, toolop, event)

    if (!(this.getToolUndoFlag(toolop) & UndoFlags.NO_UNDO)) {
      this._markChanged(ctx)
    }
  }

  override async execOrRedo(ctx: ToolContext, tool: ToolOpAny, compareInputs = false): Promise<boolean> {
    this._syncSettings(ctx)
    const pushed = await super.execOrRedo(ctx, tool as AppToolStack[number], compareInputs)
    this._markChanged(ctx)
    return pushed
  }

  override async foldOrExec(ctx: ToolContext, toolop: ToolOpAny): Promise<boolean> {
    this._syncSettings(ctx)
    const pushed = await super.foldOrExec(ctx, toolop)
    this._markChanged(ctx)
    return pushed
  }

  override async undo(): Promise<void> {
    this._syncSettings()
    const before = this.cur
    await super.undo()

    if (this.cur !== before) {
      this._markChanged()
    }
  }

  override async redo(): Promise<void> {
    this._syncSettings()
    const before = this.cur
    await super.redo()

    if (this.cur !== before) {
      this._markChanged()
    }
  }

  private getToolUndoFlag(toolop: ToolOpAny): number {
    if (toolop.undoflag !== undefined) {
      return toolop.undoflag
    }
    const cls = toolop.constructor as unknown as IToolOpConstructor
    return cls.tooldef().undoflag ?? 0
  }
}
