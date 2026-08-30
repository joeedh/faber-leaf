import * as constants from './const'
import type {AppState} from './appstate'
import * as util from '../util/util'
import {ArrayBufferProperty, ToolOp, UndoFlags} from '../path.ux/pathux'
import {SelMask} from './select_types'
import {ScreenBlock} from '../editors/editor_base'
import {Collection} from '../scene/collection'
import {Scene} from '../scene/scene'
import type {ToolContext} from './context'
import {Library} from './lib_api'
import {genDefaultScreen} from '../editors/screengen'
import {buildDefaultSceneContents, getDefaultToolMode} from './default_file'
import {getAppStorage} from './app_storage'
import {getAppState} from './app_instance'

/*root operator for when loading files*/
export class RootFileOp extends ToolOp {
  static tooldef() {
    return {
      undoflag: UndoFlags.IS_UNDO_ROOT | UndoFlags.NO_UNDO,
      uiname  : 'File Start',
      toolpath: 'app.__new_file',
    }
  }
}

export class RootLoadFileOp extends ToolOp<{
  fileBuffer: ArrayBufferProperty
}> {
  constructor(buffer?: ArrayBuffer | SharedArrayBuffer) {
    super()

    if (buffer !== undefined) {
      this.inputs.fileBuffer.setValue(buffer as ArrayBuffer)
    }
  }

  // can only run in toolsys re-exec
  static canRun(ctx: ToolContext, toolop?: ToolOp) {
    return false
  }

  static tooldef() {
    return {
      undoflag: UndoFlags.IS_UNDO_ROOT | UndoFlags.NO_UNDO,
      uiname  : 'File Start',
      toolpath: 'app.__load_file',
      inputs: {
        fileBuffer: new ArrayBufferProperty(),
      },
    }
  }

  exec(ctx: ToolContext) {
    const {fileBuffer} = this.getInputs()
    if (fileBuffer.byteLength > 0) {
      ctx.state.loadFile(fileBuffer, {
        reset_toolstack: false,
        load_screen    : false,
        load_settings  : false,
        reset_context  : false,
      })
    }
  }
}
ToolOp.register(RootLoadFileOp)

/** Root operator that builds a file. */
export class BasicFileOp extends ToolOp {
  constructor() {
    super()
  }

  exec(ctx: ToolContext) {
    const scene = new Scene()
    const lib = ctx.datalib

    lib.add(scene)
    lib.setActive(scene)

    const collection = new Collection()
    lib.add(collection)

    scene.collection = collection
    collection.lib_addUser(scene)

    const screenblock = new ScreenBlock()
    screenblock.screen = getAppState().screen as typeof screenblock.screen

    lib.add(screenblock)
    lib.setActive(screenblock)

    // Anything more than an empty scene (the classic startup cube + light) is
    // contributed by whichever subsystem registered a default-scene builder
    // — today the mesh subsystem, soon a builtin addon. See plan §3.
    buildDefaultSceneContents(ctx, lib, scene)

    window.updateDataGraph()

    // The subsystem that contributed the default scene picks the startup
    // toolmode (e.g. sculptcore for the litemesh sphere); fall back to 'object'
    // if that mode isn't registered (its addon disabled).
    const wantMode = getDefaultToolMode()
    scene.switchToolMode(Scene.toolModeProp.values[wantMode] !== undefined ? wantMode : 'object')
    // note: switchToolMode sets the select mask, we set it
    // to VERTEX here
    scene.selectMask = SelMask.VERTEX
  }

  static tooldef() {
    return {
      undoflag: UndoFlags.IS_UNDO_ROOT | UndoFlags.NO_UNDO,
      uiname  : 'File Start',
      toolpath: 'app.__new_file_basic',
    }
  }
}

export function genDefaultFile(appstate: AppState, dont_load_startup = 0) {
  getAppState().saveHandle = undefined

  const startup = dont_load_startup ? undefined : getAppStorage().getBlob(constants.APP_KEY_NAME)
  if (startup) {
    try {
      appstate.loadFile(startup.buffer as ArrayBuffer)
      if (
        !(appstate.ctx.toolstack[0] instanceof RootLoadFileOp) &&
        !(appstate.ctx.toolstack[0] instanceof BasicFileOp) &&
        !(appstate.ctx.toolstack[1] instanceof BasicFileOp)
      ) {
        appstate.ctx.toolstack.prepend(new RootLoadFileOp(startup.buffer as ArrayBuffer))
        appstate.ctx.toolstack.cur = 0
      }
      return
    } catch (error) {
      util.print_stack(error as Error)
      // eslint-disable-next-line no-console
      console.warn('Failed to load startup file')
    }
  }

  const tool = new BasicFileOp()

  appstate.datalib = new Library()
  appstate.toolstack.execTool(appstate.ctx, tool)

  genDefaultScreen(appstate)
}
