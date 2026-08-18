'use strict'

import './feature-flag'
import {ViewContext} from './context'
import {AppToolStack} from './toolstack'
import '../editors/node/MaterialEditor'
import '../addon/addon'
import {tileManager} from '../image/gpuimage'

import './platform'

import {
  initSimpleController,
  checkForTextBox,
  keymap,
  nstructjs,
  _onEventsStart,
  _onEventsStop,
} from '../path.ux/scripts/pathux'

import './polyfill'

// fbxloader's side-effect import lives in entry_point.js now; was here as a
// hangover from when fbxloader was in scripts/util/. Removed in plan §12.

import {loadShapes} from '../webgl/simplemesh_shapes'

import '../editors/resbrowser/resbrowser'
import '../editors/resbrowser/resbrowser_ops'
import '../editors/resbrowser/resbrowser_types'

// View3D toolmode registrations moved out of core: entry_point.js side-effect
// imports `editors/view3d/tools/tools` so the addon registry sees them. core
// itself only depends on the ToolMode base + the toolmode enum builder.
import {App} from '../editors/editor_base'
import {Library, DataBlock, DataRef, BlockFlags, BlockLoader} from './lib_api'
import * as util from '../util/util'
import {getDataAPI} from '../data_api/api_define'
import {BinaryReader, BinaryWriter} from '../util/binarylib'
import {remapLegacyStructSchema} from './legacy_struct_migration'
import * as cconst from './const'
import {AppSettings} from './settings'
import {getAppStorage} from './app_storage'

export class FileLoadError extends Error {}

import {Collection} from '../scene/collection'
import {PropsEditor} from '../editors/properties/PropsEditor'
import '../light/light'
import {DefaultBrushes, DynTopoFlags, DynTopoOverrides, SculptBrush, SculptTools} from '../brush/index'
import {APP_VERSION, CompressionFlags, STABLE_STRUCT_ID_VERSION} from './const'
import type {Screen} from '../path.ux/scripts/pathux'
import type {DataAPI} from '../path.ux/scripts/pathux'
import {genDefaultFile, RootFileOp, RootLoadFileOp} from './gen_default_file'
import {AutosaveManager} from './autosave'
import {startStorageSync} from './storage_sync'
import {applyMissingAddonHooks, installMissingAddonHooks, MissingDataBlock, recoverBlockHeader} from './missing_addon'
import {runFileMigrations} from './file_migrations'
import './app_ops.js'
import {BinWriter} from 'nstructjs'

// Install the nstructjs placeholder hooks before any file is loaded.
// See plan §4 and scripts/core/missing_addon.ts.
installMissingAddonHooks()

declare let _appstate: AppState
declare let JSZip: {
  deflate(data: number[] | Uint8Array, options?: {level?: number}): Uint8Array
  inflate(data: Uint8Array): Uint8Array
}

export const BlockTypes = {
  SCREEN   : 'scrn',
  DATABLOCK: 'dblk',
  SETTINGS : 'sett',
  LIBRARY  : 'libr',
  TOOLSTACK: 'tstk',
}

export class FileBlock {
  type: string
  data: unknown

  constructor(type: string, data: unknown) {
    this.type = type
    this.data = data
  }
}

export class FileData {
  blocks: FileBlock[]
  save_screen: boolean | undefined
  load_screen: boolean | undefined

  constructor() {
    this.blocks = []
    this.save_screen = undefined
    this.load_screen = undefined
  }
}

interface CreateFileArgs {
  save_screen?: boolean
  save_settings?: boolean
  save_library?: boolean
  save_toolstack?: boolean
  compress?: boolean
}

interface LoadFileArgs {
  reset_toolstack?: boolean
  load_screen?: boolean
  load_settings?: boolean
  load_library?: boolean
  reset_context?: boolean
}

interface FileContext {
  file: BinaryReader
  istruct: InstanceType<typeof nstructjs.STRUCT>
  flag: number
  version: number
  args: LoadFileArgs
  buf: ArrayBuffer | DataView
  datablocks: [string, DataBlock][]
  found_screen: boolean
  found_toolstack?: boolean
  datalib: Library | undefined
  screen: Screen | undefined
  lastscreens?: DataBlock[]
  lastscreens_active?: DataBlock | undefined
  toolstack?: AppToolStack
  getblock?: (dataref: DataRef<DataBlock> | DataBlock | number | undefined) => DataBlock | undefined
  getblock_addUser?: (
    dataref: DataRef<DataBlock> | DataBlock | number | undefined,
    user: DataBlock
  ) => DataBlock | undefined
}

export class AppState {
  arguments: string[]
  saveHandle: unknown
  settings: AppSettings
  ctx: ViewContext
  toolstack: AppToolStack
  api: DataAPI
  screen: Screen<ViewContext>
  datalib: Library
  ignoreEvents: boolean
  modalFlag: number
  three_scene: unknown
  three_renderer: unknown
  playing: boolean
  filename?: string
  /** Monotonic edit counter; the autosave dirty gate compares against it. */
  changeId: number
  /** Periodic crash-recovery autosave (constructed once the app has booted). */
  autosave?: AutosaveManager

  constructor() {
    this.arguments = []
    this.saveHandle = undefined
    this.settings = new AppSettings()
    this.ctx = new ViewContext(this as unknown as AppState)
    this.toolstack = new AppToolStack(this.ctx)
    this.api = getDataAPI()
    this.screen = undefined as unknown as Screen<ViewContext>
    this.datalib = new Library()

    this.ignoreEvents = false

    this.modalFlag = 0

    this.three_scene = undefined
    this.three_renderer = undefined

    this.playing = false
    this.changeId = 0
  }

  unswapScreen(): void {
    const screen = this.screen

    if ((screen as unknown as {_swapScreen?: Screen})._swapScreen === undefined) {
      console.warn('Bad call to appstate.unswapScreen()')
      return
    }

    const screen2 = (screen as unknown as {_swapScreen: Screen})._swapScreen
    ;(screen as unknown as {_swapScreen?: Screen})._swapScreen = undefined

    this.setScreen(screen2)
  }

  swapScreen(screen: Screen): void {
    ;(screen as unknown as {_swapScreen: Screen})._swapScreen = this.screen
    this.setScreen(screen, false)
  }

  setScreen(screen: Screen<any>, trigger_destroy = true): void {
    this.screen.unlisten()
    this.screen.remove(trigger_destroy)

    this.screen = screen
    screen.ctx = this.ctx

    document.body.appendChild(this.screen as unknown as HTMLElement)

    screen.listen()
    screen.setCSS()
    screen.update()
  }

  stopEvents(): this {
    this.ignoreEvents = true
    return this
  }

  startEvents(): this {
    this.ignoreEvents = false
    return this
  }

  start(loadDefaultFile = true): void {
    this.loadSettings()

    this.ctx = new ViewContext(this as unknown as AppState)

    window.addEventListener('contextmenu', (e) => {
      if (this.ignoreEvents) {
        return
      }

      const screen = _appstate.screen
      if (screen === undefined) {
        return
      }

      const elem = screen.pickElement(e.x, e.y)
      console.log(elem, elem?.tagName, '|')

      if (elem && elem.tagName !== 'TEXTBOX-X') {
        e.preventDefault()
      }
    })

    this.screen = document.createElement('webgl-app-x') as unknown as Screen<ViewContext>
    this.screen.ctx = this.ctx
    this.screen.size[0] = window.innerWidth - 45
    this.screen.size[1] = window.innerHeight - 45

    document.body.appendChild(this.screen as unknown as HTMLElement)
    this.screen.setCSS()
    this.screen.listen()

    if (loadDefaultFile) {
      genDefaultFile(this)
    }
    this.filename = 'unnamed.' + cconst.FILE_EXT

    // Start crash-recovery autosave now that storage + the default file exist;
    // offer to recover a newer backup before the user starts editing.
    this.autosave = new AutosaveManager(this)
    this.autosave.start()
    void this.autosave.checkRecovery()

    // Converge settings/flags across concurrent NW.js instances sharing one
    // worktree's `.sculptcore` (no-op in the browser / single instance).
    startStorageSync()
  }

  createFile(args: CreateFileArgs = {save_screen: true, save_settings: false, save_library: true}): ArrayBuffer {
    if (args.save_library === undefined) {
      args.save_library = true
    }

    if (args.save_toolstack === undefined) {
      args.save_toolstack = false
    }

    if (args.save_screen === undefined) {
      args.save_screen = true
    }

    let compflag = 0

    if (args.compress) {
      compflag = CompressionFlags.JSZIP
    }

    const file = new BinaryWriter()
    let header: BinaryWriter

    const docompress = compflag & CompressionFlags.JSZIP

    if (docompress) {
      header = new BinaryWriter()
    } else {
      header = file
    }

    header.string(cconst.FILE_MAGIC)
    header.uint16(cconst.APP_VERSION)
    header.uint16(compflag)

    const buf = nstructjs.write_scripts()

    file.int32(buf.length)
    file.bytes(buf as unknown as Uint8Array)

    function writeblock(type: string, object: unknown): void {
      if (type?.length != 4) {
        throw new Error('bad type in writeblock: ' + type)
      }

      file.string(type)
      const data = [] as number[]

      nstructjs.manager.write_object(data, object)

      file.int32(data.length)
      file.bytes(data as unknown as Uint8Array)
    }

    if (args.save_settings) {
      writeblock(BlockTypes.SETTINGS, this.settings)
    }

    if (!args.save_library) {
      // BinaryWriter.finish() already yields the ArrayBuffer, so the `.buffer`
      // this used to read was `undefined`. Latent: the only caller that reaches
      // this branch is createSettingsFile(), which nothing calls today.
      return file.finish()
    }

    writeblock(BlockTypes.LIBRARY, this.datalib)

    for (const lib of this.datalib.libs) {
      if (!args.save_screen && lib.type.blockDefine().typeName == 'screen') {
        continue
      }

      for (const block of lib) {
        // If this block is a placeholder for an unloaded addon, re-emit the
        // original class name + raw bytes so the file round-trips without
        // loss. See plan §4 and scripts/core/missing_addon.ts.
        if (block instanceof MissingDataBlock) {
          // Pre-v9 bytes carry registration-order struct ids; this file's schema
          // declares name-derived ones, so any nested abstract() inside them is
          // unresolvable. Nothing can fix it without parsing bytes we preserved
          // precisely so we would not have to. See plan §4.3.
          if (block._legacyStructIds) {
            console.warn(
              `preserved block "${block.name}" (${block._origClsname}) came from a pre-v${STABLE_STRUCT_ID_VERSION} ` +
                'file; its struct ids are not portable into this one'
            )
          }

          file.string(BlockTypes.DATABLOCK)
          const origBytes = block._origBytes
          const len = block._origClsname.length + origBytes.length + 4
          file.int32(len)
          file.int32(block._origClsname.length)
          file.string(block._origClsname)
          file.bytes(origBytes)
          continue
        }

        const typeName = block.constructor.blockDefine().typeName
        const data = new nstructjs.BinWriter()

        file.string(BlockTypes.DATABLOCK)

        nstructjs.manager.write_object(data, block)
        const len = typeName.length + data.length + 4

        file.int32(len)
        file.int32(typeName.length)
        file.string(typeName)
        file.bytes(data.finish())
      }
    }

    if (args.save_toolstack) {
      writeblock(BlockTypes.TOOLSTACK, this.toolstack)
    }

    if (docompress) {
      const fileData = JSZip.deflate(file.data.finish(), {level: 1})

      file.data = new BinWriter()
      file.data.pushBytes(fileData)
      header.int32(file.data.length)
      header.concat(file)

      return header.finish()
    }

    return file.finish()
  }

  testUndoFileIO(): void {
    const file = this.createUndoFile()
    this.loadUndoFile(file)
    window.redraw_viewport()
  }

  testFileIO(): void {
    const file = this.createFile({save_settings: true})
    this.loadFile(file)
    window.redraw_viewport()
  }

  loadUndoFile(buf: ArrayBuffer): void {
    this.loadFile(buf, {
      load_screen    : false,
      load_settings  : false,
      reset_toolstack: false,
    })

    this._execEditorOnFileLoad()
  }

  switchScreen(sblock: DataBlock & {screen: Screen}): void {
    const screen2 = sblock.screen

    if (this.screen === screen2) {
      return
    }

    this.ctx.datalib.setActive(sblock)

    if (screen2 === undefined) {
      throw new Error('screen2 cannot be undefined')
    }

    const screen = this.screen
    if (screen !== undefined) {
      for (const sarea of screen.sareas) {
        if (sarea.area) {
          sarea.area.on_area_inactive()
        }
      }

      screen.unlisten()
      screen.remove(false)
    }

    this.screen = screen2 as unknown as Screen<ViewContext>
    screen2.ctx = this.ctx

    screen2.listen()
    screen2.regenBorders()
    screen2.setCSS()

    for (const sarea of screen2.sareas) {
      if (sarea.area) {
        sarea.ctx = sarea.area.ctx = this.ctx
      }
      sarea.setCSS()

      if (sarea.area) {
        sarea.area.on_area_active()
        sarea.area.setCSS()
      }
    }

    document.body.appendChild(screen2 as unknown as HTMLElement)
  }

  _execEditorOnFileLoad(): void {
    window.setTimeout(() => {
      for (const sarea of this.screen.sareas) {
        sarea._init()

        for (const area of sarea.editors) {
          area._init()
        }
      }

      for (const sarea of this.screen.sareas) {
        for (const area of sarea.editors) {
          if ('onFileLoad' in area && typeof area.onFileLoad === 'function') {
            area.onFileLoad(area === sarea.area)
          }
        }
      }
    }, 350)
  }

  loadFileAsync(buf: ArrayBuffer | DataView, args?: LoadFileArgs): Promise<void> {
    const this2 = this

    return new Promise((accept, reject) => {
      const readblocks = function* (filectx: FileContext): Generator<void, void, unknown> {
        let args = filectx.args
        filectx.datablocks = []
        const file = filectx.file

        window.FILE_LOADING = true

        while (!file.at_end()) {
          this2.loadFile_readBlock(filectx)
          yield
        }

        args = filectx.args

        if (!args.load_library) {
          window.FILE_LOADING = false
          return
        }

        if (filectx.datalib === undefined) {
          window.FILE_LOADING = false

          throw new Error('failed to load file')
        }
      }

      let step = 0.0

      const log = function (...args: unknown[]): void {
        console.log.apply(console, args as Parameters<typeof console.log>)
      }

      const gen = function* (): Generator<void, void, unknown> {
        log('begin')
        const filectx = this2.loadFile_start(buf, args)
        yield

        step += 1.0

        let time = util.time_ms()

        const startstep = 0

        log('reading blocks')
        for (const block of readblocks(filectx)) {
          const file = filectx.file
          const perc = file.i / file.view.buffer.byteLength

          step = startstep + perc * 4.0

          if (util.time_ms() - time > 50) {
            time = util.time_ms()
            yield
          }
        }

        yield

        log('initializing datalib')
        this2.loadFile_initDatalib(filectx)
        step += 1.0

        yield

        log('loading screen data, if any')
        this2.loadFile_loadScreen(filectx)
        step += 1.0

        yield

        log('finishing')
        this2.loadFile_finish(filectx)
        step += 1.0

        log('done')

        accept()
      }

      const iter = gen()[Symbol.iterator]()

      if (this.screen) {
        this.screen.remove()
      }

      const pcirc = document.createElement('progress-circle-x') as unknown as {
        init(): void
        startTimer(): void
        value: number
        remove(): void
      }
      pcirc.init()

      document.body.appendChild(pcirc as unknown as HTMLElement)
      pcirc.startTimer()

      const timer = window.setInterval(() => {
        const perc = step / 6.0

        pcirc.value = perc

        const percStr = (perc * 100).toFixed(1) + '%'
        console.log(util.termColor(percStr, 'green'))

        let item
        try {
          item = iter.next()
        } catch (error) {
          pcirc.remove()
          window.clearInterval(timer)
          reject(error as Error)
        }

        if (item?.done) {
          pcirc.remove()
          window.clearInterval(timer)
        }
      }, 5)
    })
  }

  loadFile(buf: ArrayBuffer | DataView, args?: LoadFileArgs): void {
    console.warn('Load File')
    let ret
    try {
      ret = this.loadFile_intern(buf, args)
    } catch (error) {
      window.FILE_LOADING = false
      throw error
    }

    return ret
  }

  loadFile_intern(buf: ArrayBuffer | DataView, args?: LoadFileArgs): void {
    const filectx = this.loadFile_start(buf, args)
    this.loadFile_readBlocks(filectx)
    this.loadFile_initDatalib(filectx)
    this.loadFile_loadScreen(filectx)
    this.loadFile_finish(filectx)
  }

  testFileCompression(): void {
    const buf = this.createFile({compress: true})
    this.loadFile(buf, {reset_toolstack: false, load_screen: false, load_settings: false})
    window.redraw_viewport(true)
  }

  loadFile_start(
    buf: ArrayBuffer | DataView,
    args: LoadFileArgs = {reset_toolstack: true, load_screen: true, load_settings: false}
  ): FileContext {
    let lastscreens: DataBlock[] | undefined = undefined
    let lastscreens_active: DataBlock | undefined = undefined

    args.load_library = args.load_library === undefined ? true : args.load_library
    args.reset_context = args.reset_context === undefined ? args.reset_toolstack : args.reset_context

    if (!args.load_screen && args.load_library) {
      lastscreens = []

      lastscreens_active = this.datalib.libmap.screen.active

      for (const sblock of this.datalib.libmap.screen) {
        lastscreens.push(sblock)
      }
    }

    const filectx: FileContext = {} as FileContext
    filectx.file = new BinaryReader(buf)

    let file = filectx.file

    const s = file.string(4)
    if (s !== cconst.FILE_MAGIC) {
      throw new FileLoadError('Not a valid file')
    }

    const version = file.uint16()
    const flag = file.uint16()

    if (flag & CompressionFlags.JSZIP) {
      const len = file.uint32()

      let udata = new Uint8Array(file.view.buffer, file.i, len)
      udata = JSZip.inflate(udata)

      file = filectx.file = new BinaryReader(udata.buffer)
    }

    const len = file.int32()
    const structs = file.string(len)

    const istruct = new nstructjs.STRUCT()

    // Rewrite legacy bare/mangled struct names (from the old nstructjs.inherit
    // form) to their new module-qualified names before parsing the embedded
    // schema, so renamed classes still resolve. No-op for post-migration files.
    istruct.parse_structs(remapLegacyStructSchema(structs))

    // The read-time onUnknownClass hook is resolved off this per-file STRUCT
    // instance, not the global manager — wire it so unknown nodes/sockets/
    // toolmodes/customdata are preserved instead of dropped. See plan blocker A.
    applyMissingAddonHooks(istruct)

    filectx.lastscreens_active = lastscreens_active
    filectx.lastscreens = lastscreens
    filectx.istruct = istruct
    filectx.flag = flag
    filectx.version = version
    filectx.args = args
    filectx.buf = buf
    filectx.datablocks = []
    filectx.found_screen = false
    filectx.datalib = undefined
    filectx.screen = undefined

    return filectx
  }

  loadFile_readBlock(filectx: FileContext): DataBlock | AppSettings | undefined {
    const {istruct, flag, version, args, buf, file} = filectx

    const type = file.string(4)
    const len = file.int32()

    console.log('len', len)
    const data = file.bytes(len)
    const dataView = new DataView(new Uint8Array(data).buffer)

    if (type === BlockTypes.TOOLSTACK) {
      console.warn('File had a toolstack')
      filectx.found_toolstack = true
      filectx.toolstack = istruct.readObject(dataView, AppToolStack)
    } else if (args.load_screen && type === BlockTypes.SCREEN) {
      console.warn('Old screen block detected')

      const screen = istruct.readObject(dataView, App)
      filectx.found_screen = true
    } else if (args.load_library && type === BlockTypes.LIBRARY) {
      filectx.datalib = istruct.readObject(dataView, Library)

      this.datalib.destroy()
      this.datalib = filectx.datalib!
    } else if (args.load_library && type === BlockTypes.DATABLOCK) {
      const file2 = new BinaryReader(dataView)

      let len = file2.int32()
      const clsname = file2.string(len)

      const cls = DataBlock.getClass(clsname)
      len = dataView.byteLength - len - 4
      const data2 = file2.bytes(len)
      let block: DataBlock | undefined

      if (!args.load_screen && cls?.blockDefine().typeName === 'screen') {
        return undefined
      }

      if (cls === undefined) {
        // The addon that owns clsname isn't loaded. Preserve the bytes in a
        // MissingDataBlock placeholder so the next save round-trips the data.
        // See plan §4 and scripts/core/missing_addon.ts.
        console.warn(`unknown block type "${clsname}" — preserving as MissingDataBlock`)
        const bytes = new Uint8Array(data2)
        block = MissingDataBlock.fromUnknownBlock(
          clsname,
          bytes,
          recoverBlockHeader(istruct, bytes),
          version < STABLE_STRUCT_ID_VERSION
        )
      } else {
        block = istruct.readObject(data2, cls)
      }

      if (cls?.blockDefine().typeName === 'screen') {
        ;(block as unknown as {screen: {_ctx: ViewContext}}).screen._ctx = this.ctx
      }

      filectx.datablocks.push([clsname, block])

      return block
    } else if (args.load_settings && type === BlockTypes.SETTINGS) {
      const settings = istruct.readObject(dataView, AppSettings)

      this.settings.destroy()
      this.settings = settings

      return settings
    }

    return undefined
  }

  loadFile_readBlocks(filectx: FileContext): void {
    let args = filectx.args
    const datablocks = (filectx.datablocks = [])
    const file = filectx.file

    window.FILE_LOADING = true

    tileManager.clear()

    while (!file.at_end()) {
      this.loadFile_readBlock(filectx)
    }

    args = filectx.args

    if (!args.load_library) {
      window.FILE_LOADING = false
      return
    }

    const {istruct, screen, found_screen, datalib, flag, version, buf} = filectx

    if (datalib === undefined) {
      window.FILE_LOADING = false

      throw new Error('failed to load file')
    }
  }

  loadFile_initDatalib(filectx: FileContext): void {
    const {screen, found_screen, datalib, version, datablocks} = filectx

    if (!datalib) {
      throw new Error('datalib is undefined')
    }

    for (const dblock of datablocks) {
      datalib.getLibrary(dblock[0]).add(dblock[1], true)
    }

    this.do_versions(version, datalib)

    function getblock(dataref: DataRef<DataBlock> | DataBlock | number | undefined): DataBlock | undefined {
      if (dataref === undefined) {
        return undefined
      }

      if (typeof dataref === 'object' && dataref instanceof DataBlock) {
        return dataref
      }

      return datalib!.get(dataref)
    }

    filectx.getblock = getblock

    function getblock_addUser(
      dataref: DataRef<DataBlock> | DataBlock | number | undefined,
      user: DataBlock
    ): DataBlock | undefined {
      if (dataref === undefined) {
        return undefined
      }

      if (typeof dataref === 'object' && dataref instanceof DataBlock) {
        return dataref
      }

      const addUser = dataref !== undefined && !(dataref instanceof DataBlock)

      const ret = datalib!.get(dataref)

      if (addUser && ret !== undefined) {
        ret.lib_addUser(user)
      }

      return ret
    }

    filectx.getblock_addUser = getblock_addUser

    for (const lib of datalib.libs) {
      for (const block of lib) {
        block.lib_users = block.lib_flag & BlockFlags.FAKE_USER ? 1 : 0
      }
    }

    for (const lib of datalib.libs) {
      lib.dataLink(getblock as BlockLoader, getblock_addUser as BlockLoader)
    }
    datalib.afterSTRUCT()
  }

  loadFile_loadScreen(filectx: FileContext): void {
    let {screen, getblock, getblock_addUser, found_screen, datalib, version, args, datablocks} = filectx

    if (!datalib) {
      return
    }

    if (args.load_screen && screen === undefined) {
      screen = (datalib as unknown as {libmap: {screen: {active: DataBlock; [key: number]: DataBlock}}}).libmap.screen
        .active as unknown as Screen
      if (screen === undefined) {
        screen = (datalib as unknown as {libmap: {screen: {[key: number]: DataBlock}}}).libmap
          .screen[0] as unknown as Screen
        ;(datalib as unknown as {libmap: {screen: {active: DataBlock}}}).libmap.screen.active =
          screen as unknown as DataBlock
      }

      screen = (screen as unknown as {screen: Screen}).screen
    }

    if (screen !== undefined) {
      found_screen = filectx.found_screen = true

      if (this.screen !== screen && this.screen !== undefined) {
        this.screen.destroy()
        this.screen.remove()
      }

      document.body.appendChild(screen as unknown as HTMLElement)

      let ok = false

      for (const sblock of (this.datalib as unknown as {screen: Iterable<DataBlock>}).screen) {
        ;(sblock as unknown as {screen: {ctx: ViewContext}}).screen.ctx = this.ctx

        if ((sblock as unknown as {screen: Screen}).screen === this.screen) {
          ok = true
        }

        for (const sarea of (sblock as unknown as {screen: Screen}).screen.sareas) {
          for (const editor of sarea.editors) {
            if ('dataLink' in editor && typeof editor.dataLink === 'function') {
              editor.dataLink(sblock, getblock!, getblock_addUser!)
            }
          }
        }
      }

      if (!ok) {
        for (const sarea of this.screen.sareas) {
          for (const editor of sarea.editors) {
            if ('dataLink' in editor && typeof editor.dataLink === 'function') {
              editor.dataLink(undefined, getblock!, getblock_addUser!)
            }
          }
        }
      }

      this.screen = screen as unknown as Screen<ViewContext>
      this.screen.ctx = this.ctx
      this.screen._init()
      this.screen.listen()

      for (const sarea of this.screen.sareas) {
        if (sarea.area) {
          sarea.area.push_ctx_active()
          sarea.area.pop_ctx_active()
        }
      }
    }
  }

  loadFile_finish(filectx: FileContext): void {
    const {lastscreens, found_screen, screen, version, datalib, lastscreens_active, datablocks, args} = filectx

    if (!datalib) {
      return
    }

    this.do_versions_post(version, datalib)

    window.FILE_LOADING = false

    if (args.reset_context) {
      this.ctx.reset()
    }

    if (args.reset_toolstack) {
      this.toolstack.reset(this.ctx)

      if (filectx.found_toolstack) {
        this.toolstack = filectx.toolstack!
        this.toolstack.ctx = this.ctx
      } else {
        this.toolstack.execTool(
          this.ctx,
          new RootLoadFileOp(filectx.buf instanceof DataView ? filectx.buf.buffer : filectx.buf)
        )
      }
    }

    if (!args.load_screen) {
      this.modalFlag = 0

      for (const sblock of lastscreens!) {
        if (!datalib.has(sblock)) {
          sblock.lib_id = sblock.graph_id = -1
          datalib.add(sblock)
        }
      }

      ;(datalib as unknown as {libmap: {screen: {active: DataBlock | undefined}}}).libmap.screen.active =
        lastscreens_active
    }

    if (found_screen) {
      this.screen.afterSTRUCT()
    }

    if (this.screen) {
      this.screen.update()
      this.screen.regenBorders()
      this.screen.on_resize(this.screen.size, [window.innerWidth, window.innerHeight])
      this.screen.update()
    }

    this._execEditorOnFileLoad()
  }

  clearStartupFile(): void {
    console.log('clearing startup file')
    getAppStorage().remove(cconst.APP_KEY_NAME)
  }

  saveStartupFile(): void {
    const buf = this.createFile({save_settings: false, compress: true})

    try {
      getAppStorage().setBlob(cconst.APP_KEY_NAME, buf)
      console.log(`saved startup file; ${(buf.byteLength / 1024).toFixed(2)}kb`)
      this.ctx.message('Saved startup file')
    } catch (error) {
      console.warn((error as Error).stack)
      console.warn((error as Error).message)
      this.ctx.error('Failed to save startup file')
    }
  }

  do_versions(version: number, datalib: Library): void {
    if (version < 4) {
      for (const mesh of datalib.mesh) {
        const cd_grid = mesh.loops.customData.getLayerIndex('QuadTreeGrid')

        if (cd_grid < 0) {
          continue
        }

        for (const l of mesh.loops) {
          const grid = l.customData[cd_grid] as unknown as {updateNormalQuad(l: unknown): void; pruneDeadPoints(): void}
          grid.updateNormalQuad(l)
          grid.pruneDeadPoints()
        }
      }
    }

    // Mesh-grid migrations (v5: flagNormalsUpdate, v6: flagIdsRegen) live in
    // scripts/mesh/migrations.ts and register themselves with the
    // file_migrations registry. See plan §3.
    runFileMigrations({fromVersion: version, toVersion: APP_VERSION, datalib})

    if (version < 7) {
      for (const brush of datalib.brush) {
        if (brush.tool === SculptTools.GRAB) {
          brush.dynTopo.overrideMask &= ~(DynTopoOverrides as unknown as {ALL: number}).ALL
          brush.dynTopo.flag &= ~DynTopoFlags.ENABLED
        }
      }
    }

    if (version !== APP_VERSION) {
      this.mergeDefaultBrushes()
    }
  }

  mergeDefaultBrushes(datalib: Library = this.datalib): void {
    for (const k in DefaultBrushes.brushes) {
      const b1 = datalib.get(k)

      if (!b1 || !(b1 instanceof SculptBrush)) {
        continue
      }

      const b2 = '__original_brush_' + b1.name
      const b2Block = datalib.get(b2)

      if (!b2Block || !(b2Block instanceof SculptBrush)) {
        continue
      }

      if (b1.equals(b2Block, false, true) && !b1.equals(DefaultBrushes.brushes[k], false, true)) {
        console.log('Found unmodified default brush ' + b1.name)
        console.log(b1, b2Block)
        const defaultBrush = DefaultBrushes.brushes[k]
        console.log(
          'hashes (b1, b2, default):',
          b1.calcHashKey(),
          b2Block.calcHashKey(),
          defaultBrush.calcHashKey(),
          defaultBrush.equals(b1)
        )
        console.log('-->', defaultBrush.calcHashKey(), defaultBrush.copy().calcHashKey())

        const radius = b1.radius
        const strength = b1.strength

        DefaultBrushes.brushes[k].copyTo(b1, false)
        DefaultBrushes.brushes[k].copyTo(b2Block, false)

        console.log('hash4', b1.calcHashKey(), b2Block.calcHashKey())

        b1.strength = strength
        b1.radius = radius
      }
    }
  }

  do_versions_post(version: number, datalib: Library): void {
    console.log('VERSION', version)

    if (version < 1) {
      for (const scene of datalib.scene) {
        scene.collection = new Collection()
        this.datalib.add(scene.collection)
        scene.collection.lib_addUser(scene)
        ;(scene as unknown as {_loading: boolean})._loading = true
        for (const ob of scene.objects) {
          scene.collection.add(ob)
        }
        ;(scene as unknown as {_loading: boolean})._loading = false
      }
    }

    if (version < 3) {
      const screen = this.screen

      const props = document.createElement('screenarea-x') as unknown as {
        size: number[]
        ctx: ViewContext
        _init(): void
        switch_editor(cls: unknown): void
      }
      props.size[0] = 5
      props.size[1] = screen.size[1]
      props.ctx = this.ctx
      props._init()

      props.switch_editor(PropsEditor)
      ;(screen as unknown as HTMLElement).appendChild(props as unknown as HTMLElement)
    }
  }

  createSettingsFile(): ArrayBuffer {
    const args: CreateFileArgs = {
      save_settings: true,
      save_screen  : false,
      save_library : false,
    }

    return this.createFile(args)
  }

  saveSettings(): void {
    this.settings.save()
  }

  loadSettings(): void {
    try {
      this.loadSettings_intern()
    } catch (error) {
      util.print_stack(error as Error)
      console.log('Failed to load settings')
    }
  }

  loadSettings_intern(): void {
    this.settings.load()

    setTimeout(() => {
      window.redraw_viewport()
    }, 10)
  }

  createUndoFile(): ArrayBuffer {
    const args: CreateFileArgs = {
      save_screen  : false,
      save_settings: false,
    }

    return this.createFile(args)
  }

  destroy(): void {
    this.screen.unlisten()
  }

  draw(): void {}
}

export function preinit(): void {
  window._appstate = new AppState() as unknown as AppState
}

export function init(): void {
  loadShapes()
  initSimpleController()

  let animreq: number | undefined
  const f = (): void => {
    animreq = undefined

    _appstate.draw()
  }
  window.redraw_all = function (): void {
    if (animreq !== undefined) {
      return
    }

    animreq = requestAnimationFrame(f)
  }

  let lastKey: number | undefined = undefined

  const on_keydown = (e: KeyboardEvent): void => {
    lastKey = e.keyCode

    if (e.keyCode === keymap['C']) {
      e.preventDefault()
      e.stopPropagation()

      const mpos = _appstate.screen.mpos
      const elem = _appstate.screen.pickElement(mpos[0], mpos[1])

      console.log(elem ? elem.tagName : elem, mpos)
    }

    if (e.keyCode === keymap['R'] && e.ctrlKey) {
      e.preventDefault()
    }

    const mpos = _appstate.screen ? _appstate.screen.mpos : [0, 0]
    const preventdef = !(_appstate.screen && checkForTextBox(_appstate.screen, mpos[0], mpos[1]))
    if (preventdef && e.keyCode === keymap['A'] && e.ctrlKey) {
      e.preventDefault()
    }
  }

  _onEventsStart(() => window.addEventListener('keydown', on_keydown))
  _onEventsStop(() => window.removeEventListener('keydown', on_keydown))

  let graphreq: number | undefined = undefined

  function gf(): void {
    graphreq = undefined
    _appstate.datalib.graph.exec(_appstate.ctx)
  }

  window.updateDataGraph = function (force = false): void {
    if (force) {
      _appstate.datalib.graph.exec(_appstate.ctx)
      return
    }

    if (graphreq !== undefined) {
      return
    }

    graphreq = 1
    setTimeout(gf, 1)
  }

  _appstate.start()
}
