import type {View3D} from '../editors/all.js'
import {registerDataAPI} from '../data_api/api_define_registry.js'
import {nstructjs, util, DataAPI, DataStruct} from '../path.ux/pathux.js'

const sdigest = new util.HashDigest()

export class RenderSettings {
  sharpen: boolean
  filterWidth: number
  sharpenWidth: number
  sharpenFac: number
  minSamples: number
  ao: boolean
  // Screen-space subsurface scattering. The per-pixel world scatter radius
  // (incl. the node's CPU-side unit factor) is carried in the MRT BasePass;
  // these are the global blur/composite knobs.
  sss: boolean
  sssWidth: number // separable-blur sample count → SAMPLES define (graph rebuild)
  sssFalloff: number // diffusion-profile falloff shape
  sssStrength: number // composite blend strength

  static STRUCT: string

  constructor() {
    this.sharpen = false
    this.filterWidth = 1.5
    this.sharpenWidth = 1
    this.sharpenFac = 0.4
    this.minSamples = 1
    this.ao = true
    this.sss = false
    this.sssWidth = 7
    this.sssFalloff = 1.0
    this.sssStrength = 1.0
  }

  calcUpdateHash() {
    sdigest.reset()
    sdigest.add(!!this.sharpen)
    sdigest.add(this.filterWidth)
    sdigest.add(this.sharpenWidth)
    sdigest.add(this.ao)
    // sss/sssWidth change the node topology + SAMPLES define → must rebuild
    // the graph (allocates/frees the SSS targets), so they fold into the hash.
    sdigest.add(!!this.sss)
    sdigest.add(this.sssWidth)

    return sdigest.get()
  }

  static defineAPI(api: DataAPI, struct?: DataStruct): DataStruct {
    const st = struct ?? api.mapStruct(this, true)

    st.bool('sharpen', 'sharpen', 'Sharpen')
    st.int('sharpenWidth', 'sharpenWidth', 'Sharpen Width').noUnits()
    st.float('filterWidth', 'filterWidth', 'AA Width').noUnits()
    st.float('sharpenFac', 'sharpenFac', 'Sharpen Fac').noUnits()
    st.int('minSamples', 'minSamples', 'Min Samples', 'Minimum samples to render before drawing to screen')
      .noUnits()
      .range(0, 10)

    return st
  }
}
RenderSettings.STRUCT = `
renderengine_realtime.RenderSettings {
  sharpen      : bool;
  filterWidth  : float;
  sharpenWidth : int;
  sharpenFac   : float;
  minSamples   : int;
  sss          : bool;
  sssWidth     : int;
  sssFalloff   : float;
  sssStrength  : float;
}
`
nstructjs.register(RenderSettings)

export class RenderEngine {
  settings: RenderSettings
  renderSettings: RenderSettings
  view3d: View3D

  static engines: (typeof RenderEngine)[]

  constructor(view3d: View3D, settings?: RenderSettings) {
    this.view3d = view3d
    this.settings = settings ?? new RenderSettings()
    this.renderSettings = this.settings
  }
  update(gl: WebGL2RenderingContext, view3d: unknown): void {
    void gl
    void view3d
  }

  resetRender(): void {}

  // `gl` stays in the signature for source-compat with legacy call sites
  // that still pass it; the realtime engine ignores it. Overlay encoding
  // is no longer part of this contract — install
  // `RealtimeEngine.encodeOverlaysCB` instead.
  render(
    camera: unknown,
    gl: WebGL2RenderingContext,
    viewbox_pos: unknown,
    viewbox_size: unknown,
    scene: unknown
  ): void {
    void camera
    void gl
    void viewbox_pos
    void viewbox_size
    void scene
  }

  destroy(gl: WebGL2RenderingContext): void {
    void gl
  }

  static register(cls: typeof RenderEngine) {
    this.engines.push(cls)
  }
}
RenderEngine.engines = []

registerDataAPI(RenderSettings)
