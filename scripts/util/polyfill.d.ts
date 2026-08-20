import type {AppState} from '../core/appstate'

export interface INumberList {
  [k: number]: number

  length: number

  slice(start: number, end: number): INumberList
}

export declare global {
  declare function updateDataGraph(immediate?: boolean)

  /* This goes here for use by STRUCT scripts;
   * it's deliberately wrong to force you to
   * properly import it in other code.*/
  declare function DataRef(): void

  declare interface Set {
    map(func: (item: any) => any)

    filter(func: (item: any) => boolean)
  }

  /* window.D* debug variables.
   * These are created at the console.
   * only.
   **/
  declare interface Window {
    D1: number | undefined
    D2: number | undefined
    D3: number | undefined
    D4: number | undefined
    D5: number | undefined
    D6: number | undefined
    DTST2: number | undefined
    _appstate: AppState
    FILE_LOADING: boolean
    /** view3d.ts owns this; it is a throwing WebGPU stub, not a real context. */
    _gl: WebGL2RenderingContext
    /** resetRenderEngine defaults to true */
    redraw_viewport(resetRenderEngine?: boolean, drawCount?: number): void
    /** resetRenderEngine defaults to true */
    redraw_viewport_p(resetRenderEngine?: boolean, drawCount?: number): Promise<void>
    redraw_all(): void
    updateDataGraph(force?: boolean): void
    _genDefaultFile: typeof import('../core/appstate').genDefaultFile
  }

  declare const DEBUG: any
  declare const _appstate: AppState

  /**
   * `AppState` reachable as a type without importing `core/appstate` — what
   * lets `core/app_instance.ts` stay import-free (P20 §2.1).
   */
  declare type AppStateGlobal = AppState

  declare interface HTMLCanvasElement {
    dpi: number
  }
}
