import {ShaderProgram, Camera, IUniformsBlock} from '../webgl/webgl.js'

import {Vector3, Matrix4} from '../util/vectormath.js'
import * as util from '../util/util.js'
import {RenderEngine, RenderSettings} from './renderengine_base.js'
import type {Light} from '../light/light.js'
import type {SceneObject} from '../sceneobject/sceneobject.js'
import {DrawModes} from '../sceneobject/drawmode.js'
import type {View3D} from '../editors/all.js'
import type {Scene} from '../scene/scene.js'
import type {Material} from '../core/material.js'
import type {RequestedAttrDesc} from '../shadernodes/shader_nodes_wgsl'

// WebGPU-only renderengine. The realtime engine constructs a
// `WebGpuRenderGraph` of `GraphNodeRef`s every frame and dispatches via
// it.
import {WebGpuRenderGraph, type GraphNodeRef, type DispatchHooks} from '../webgpu/render_graph.js'
import {RenderTarget} from '../webgpu/render_target.js'
import type {WebGpuRenderContext} from '../webgpu/render_context.js'
import type {Pipeline} from '../webgpu/pipeline.js'
import {GpuBuffer} from '../webgpu/buffer.js'
import {GpuTexture, createSampler} from '../webgpu/texture.js'
import {TextureUsage} from '../webgpu/flags.js'
import {asMaterialAttrConsumer} from '../core/vertex_layout.js'
import {
  buildMaterialPipelineDescriptor,
  buildMaterialVertexLayout,
  buildPipelineDescriptor,
  lookupWgslShader,
} from '../shaders/wgsl_shaders.js'
import {LightGenWgsl, type IRenderLights} from '../shadernodes/shader_lib_wgsl.js'
import {getActiveWebGpuViewport, ensureCanvasDepth} from '../editors/view3d/view3d_draw_webgpu.js'
import * as bluenoise from '../shadernodes/bluenoise_mask.js'

export const LightIdSymbol = Symbol('light_id')

// Blue-noise jitter sampler — inlined from the GL-era realtime_passes.ts
// so the WebGPU-only engine has no remaining dependency on that file.
// Generates `totpoint` 2D samples in roughly the unit disk via a Lloyd-
// relaxation loop, normalised so each component sits in roughly [-1, 1].
// The third tuple element is the sample's radius (used by callers that
// weight by distance from centre — the renderengine itself ignores it).
function makeBlue(totpoint: number): [number, number, number][] {
  let dimen = Math.sqrt(totpoint)
  dimen = Math.ceil(Math.max(dimen, 2.0))

  const PX = 0
  const PY = 1
  const PTOT = 2

  const r = 1.0 / dimen
  const ps = new Float64Array(PTOT * totpoint)

  for (let pi = 0; pi < ps.length; pi += PTOT) {
    const x = Math.random()
    const y = Math.random()
    const th = x * Math.PI * 2.0
    ps[pi + PX] = Math.cos(th) * y
    ps[pi + PY] = Math.sin(th) * y
  }

  const getr = (x: number, y: number) => {
    let d = Math.sqrt(x * x + y * y)
    d = d * d * (3.0 - 2.0 * d)
    return r + d * r * 3
  }

  const doStep = () => {
    for (let pi1 = 0; pi1 < ps.length; pi1 += PTOT) {
      const x1 = ps[pi1 + PX]
      const y1 = ps[pi1 + PY]
      let sumx = 0
      let sumy = 0
      let tot = 0

      const r1 = getr(x1, y1)
      ps[pi1 + PX] -= x1 * 0.005
      ps[pi1 + PY] -= y1 * 0.005

      for (let pi2 = 0; pi2 < ps.length; pi2 += PTOT) {
        if (pi1 === pi2) continue
        const x2 = ps[pi2 + PX]
        const y2 = ps[pi2 + PY]
        const r2 = getr(x2, y2)
        const rtest = (r1 + r2) * 0.5
        if (rtest === 0.0 || isNaN(rtest)) continue
        const dx = x1 - x2
        const dy = y1 - y2
        let dis = dx * dx + dy * dy
        if (dis > rtest * rtest) continue
        dis = Math.sqrt(dis)
        let w = 1.0 - dis / rtest
        w = w * w * (3.0 - 2.0 * w)
        w *= w
        sumx += dx * w
        sumy += dy * w
        tot += w
      }

      if (!tot) continue
      sumx /= tot
      sumy /= tot
      ps[pi1 + PX] += sumx * 0.14
      ps[pi1 + PY] += sumy * 0.14
    }
  }

  for (let step = 0; step < 40; step++) doStep()

  let len = 0.0
  for (let pi = 0; pi < ps.length; pi += PTOT) {
    const x = ps[pi + PX]
    const y = ps[pi + PY]
    const d = x * x + y * y
    if (d > len) len = d
  }
  len = Math.sqrt(len)

  const ret: [number, number, number][] = []
  for (let pi = 0; pi < ps.length; pi += PTOT) {
    const x = ps[pi + PX] / len
    const y = ps[pi + PY] / len
    ret.push([x, y, Math.sqrt(x * x + y * y)])
  }
  return ret
}

const jcache: Record<number, [number, number, number][]> = {}
function getJitterSamples(totpoint: number): [number, number, number][] {
  if (totpoint in jcache) return jcache[totpoint]
  jcache[totpoint] = totpoint < 2 ? [[0, 0, 1]] : makeBlue(totpoint)
  return jcache[totpoint]
}

export class RenderLight {
  light: SceneObject<Light>
  id: number
  co: Vector3
  seed: number
  _digest: util.HashDigest

  constructor(light: SceneObject<Light>, id: number) {
    this.light = light
    this._digest = new util.HashDigest()
    this.id = id
    this.co = new Vector3()
    this.seed = 0

    if (light !== undefined) {
      this.calcCo()
    }
  }

  calcUpdateHash() {
    const hash = this._digest
    hash.reset()

    if (!this.light) {
      return 0
    }

    const light = this.light

    const mat = light.outputs.matrix.getValue()
    mat.addToHashDigest(hash)

    for (const k in light.data.inputs) {
      let sock = light.data.inputs[k]
      if (sock.edges.length > 0) {
        sock = sock.edges[0]
      }

      sock.addToUpdateHash(hash)
    }

    return hash.get()
  }

  calcCo() {
    this.co.load(this.light.locationWorld)
    util.seed(this.seed * 3)

    const r = this.light.data.inputs.radius.getValue()

    const x = (util.random() - 0.5) * 2.0 * r
    const y = (util.random() - 0.5) * 2.0 * r
    const z = (util.random() - 0.5) * 2.0 * r

    this.co[0] += x
    this.co[1] += y
    this.co[2] += z
  }

  update(light: SceneObject<Light>, uSample: number) {
    this.light = light
    this.seed = uSample
    this.calcCo()
  }
}

// Per-engine identity object threaded through `ob.draw(view3d, gl,
// uniforms, program)`. The WebGPU draw queue uses this object as the
// lookup key in `wgpu.pipelineBindings`; we register the pre-compiled
// `Pipeline` against it ourselves so the queue adapter doesn't fall back
// to its bgra8unorm registry path.
interface WebgpuEngineProgram {
  uniforms: IUniformsBlock
  name: string
  // `undefined` (not absent) — the queue adapter's registry fallback
  // only kicks in if `wgslKey` is present.
  wgslKey?: undefined
}

interface WebgpuMaterialState {
  program: WebgpuEngineProgram
  pipeline: Pipeline
  hash: number
  // Compiled material WGSL + the geometry attributes it reads — the contract
  // handed to sculptcore for LiteMesh draw batches (M6). The pipeline above
  // serves regular meshes drawn via the scene walk; a LiteMesh instead routes
  // its sculpt batch through the C++ tree shader, fed from these.
  wgsl: string
  requestedAttrs: RequestedAttrDesc[]
  /** Seeds `sampler_<id>_tex/_smp` views per frame (image nodes). */
  setTextureUniforms?: (device: GPUDevice, uniforms: Record<string, unknown>) => void
}

export class RealtimeEngine extends RenderEngine {
  _digest: util.HashDigest
  projmat: Matrix4
  lights: Record<string, RenderLight>
  light_idgen: number
  gl: WebGL2RenderingContext
  scene: Scene
  _last_camerahash?: number
  uSample: number
  weightSum: number
  maxSamples: number
  _last_update_hash?: number
  _queueResetSamples = false
  camera: Camera

  // WebGPU render graph state. Lazily built on the first frame and
  // rebuilt whenever `renderSettings` change or the viewport resizes.
  // `webgpuTargets` keeps the per-pass RenderTargets alive across frames
  // so we don't reallocate textures every frame.
  webgpuGraph?: WebGpuRenderGraph
  webgpuNodes?: GraphNodeRef[]
  webgpuTargets: Map<string, RenderTarget> = new Map()
  // Frame parity for AccumPass ⇄ PassThruPass ping-pong; flipped per
  // _renderWebGPU call so accumOut writes to the slot that PassThru just
  // sampled and vice versa.
  webgpuPing: 0 | 1 = 0
  _webgpuLastSize: [number, number] = [0, 0]
  _webgpuLastUpdateHash?: number
  // Per-material WGSL pipeline cache for the BasePass scene walk.
  // Keyed by Material identity. Separate from view3d_draw_webgpu's cache
  // because the renderengine renders to an rgba16float RenderTarget while
  // view3d_draw_webgpu targets the bgra8unorm canvas — same WGSL, different
  // pipeline-format key, so the underlying pipelineBindings entries don't
  // collide.
  webgpuMaterialStates: WeakMap<Material, WebgpuMaterialState> = new WeakMap()
  // Single shared pipeline for the NormalPass scene walk. Reuses the
  // existing `NormalPassShader` WGSL — see `wgsl_shaders.ts:1260`.
  webgpuNormalProgram?: WebgpuEngineProgram
  webgpuNormalPipeline?: Pipeline
  // Phase 3 — per-pass bind-group resources.
  // PassUniforms (mat4x4*4 + vec2 + f32 + f32 → 272 bytes) lives in
  // `webgpuPassBuffers[node].pass`. Pass-specific uniforms (AccumUniforms,
  // SharpenUniforms, AOUniforms) live in `.extra` when applicable.
  // Keyed by GraphNodeRef identity — rebuilt alongside the node list.
  webgpuPassBuffers: WeakMap<GraphNodeRef, {pass: GpuBuffer; extra?: GpuBuffer}> = new WeakMap()
  webgpuLinearSampler?: GPUSampler
  webgpuNearestSampler?: GPUSampler
  webgpuBlueTexture?: GpuTexture
  _webgpuRng: util.MersenneRandom = new util.MersenneRandom()

  // Caller installs this to encode grid / widgets / drawDrawLines /
  // toolmode debug after `OutputPass`. Receives the live
  // `WebGpuRenderContext`, an open `GPURenderPassEncoder` attached to the
  // canvas swap-chain (load-not-clear so OutputPass's pixels stay), and
  // the jittered projection matrix already applied to the rendered scene.
  encodeOverlaysCB?: (rctx: WebGpuRenderContext, pass: GPURenderPassEncoder, projmat: Matrix4) => void
  // Live for the duration of the `webgpuGraph.exec` call — the
  // `hooks.encodeOverlays` callback reads these to re-open a pass
  // against the same canvas attachment OutputPass just wrote.
  private _overlayCtx?: WebGpuRenderContext
  private _overlaySurfaceView?: GPUTextureView
  private _overlayDepthView?: GPUTextureView
  private _overlayViewport?: {x: number; y: number; w: number; h: number}
  private _overlayProjmat?: Matrix4

  constructor(view3d: View3D, settings?: RenderSettings) {
    super(view3d, settings)

    this.camera = view3d.activeCamera

    this._digest = new util.HashDigest()
    this.renderSettings = settings ? settings : new RenderSettings()

    this.projmat = new Matrix4()
    this.lights = {}
    this.light_idgen = 1

    this.view3d = view3d
    const v3d = view3d
    this.gl = v3d.gl
    this.scene = v3d.ctx.scene!

    this._last_camerahash = undefined

    this.uSample = 0.0
    this.weightSum = 0.0
    this.maxSamples = 8

    this._last_update_hash = undefined
  }

  // Per-pass output format. Matches the colorTarget on every
  // `registerWgslPass(...)` entry in `wgsl_render_passes.ts` so the
  // RenderTargets we allocate accept the compiled pipelines.
  static readonly WEBGPU_PASS_FORMAT: GPUTextureFormat = 'rgba16float'
  static readonly WEBGPU_DEPTH_FORMAT: GPUTextureFormat = 'depth24plus'

  // Acquires the WebGpuRenderContext that `view3d_draw_webgpu.ts`
  // initialized for this engine's canvas. Returns undefined if the async
  // init hasn't completed yet — callers must fall back to GL for the
  // frame in that case.
  _getWebGpuCtx(): WebGpuRenderContext | undefined {
    const canvas = (this.view3d as unknown as {canvas?: HTMLCanvasElement | OffscreenCanvas}).canvas
    return getActiveWebGpuViewport(canvas)?.ctx
  }

  // Allocates (or reuses) a RenderTarget by name. Sized to the viewport;
  // a size change destroys the prior set and forces a fresh build.
  _ensureTarget(
    device: GPUDevice,
    key: string,
    w: number,
    h: number,
    colorFormats: GPUTextureFormat[] = [RealtimeEngine.WEBGPU_PASS_FORMAT]
  ): RenderTarget {
    const cached = this.webgpuTargets.get(key)
    if (cached?.width === w && cached.height === h && cached.colorFormats.length === colorFormats.length) {
      return cached
    }
    cached?.destroy()
    const target = new RenderTarget({
      device,
      width : w,
      height: h,
      colorFormats,
      depthFormat: RealtimeEngine.WEBGPU_DEPTH_FORMAT,
      label      : `RealtimeEngine.${key}`,
    })
    this.webgpuTargets.set(key, target)
    return target
  }

  // WebGPU sibling of `rebuildGraph()`. Mirrors the same conditional
  // structure (renderSettings.ao adds NormalPass + AOPass; renderSettings.sharpen
  // adds two SharpenPass nodes) but emits GraphNodeRefs against the
  // PascalCase pass keys in `wgsl_render_passes.ts`. The ping-pong pair
  // (accumA/accumB) is bound at exec time via `webgpuPing`.
  rebuildGraphWebGPU(device: GPUDevice, w: number, h: number): GraphNodeRef[] {
    // Free any targets that the previous topology owned but won't be
    // referenced by the new node list — keeps texture memory bounded
    // across an `ao`/`sharpen` toggle.
    const fresh = new Map<string, RenderTarget>()
    const target = (key: string, colorFormats?: GPUTextureFormat[]) => {
      const t = this._ensureTarget(device, key, w, h, colorFormats)
      fresh.set(key, t)
      return t
    }

    const nodes: GraphNodeRef[] = []

    if (this.renderSettings.ao) {
      nodes.push({
        passKey: 'NormalPass',
        target : target('normal'),
        label  : 'NormalPass',
      })
      nodes.push({
        passKey: 'AOPass',
        target : target('ao'),
        label  : 'AOPass',
      })
    }

    // BasePass is MRT when SSS is on: colors[0] = lit color, colors[1] = SSS
    // irradiance (rgb) + max world scatter radius (a — footprint + mask),
    // colors[2] = per-channel world scatter radius (rgb). When SSS is off it
    // stays single-attachment (byte-identical to before; sculptcore's C++ tree
    // shader, which reuses the same material WGSL, also stays single-output).
    const baseFormats = this.renderSettings.sss
      ? [RealtimeEngine.WEBGPU_PASS_FORMAT, RealtimeEngine.WEBGPU_PASS_FORMAT, RealtimeEngine.WEBGPU_PASS_FORMAT]
      : [RealtimeEngine.WEBGPU_PASS_FORMAT]
    nodes.push({
      passKey: 'BasePass',
      target : target('base', baseFormats),
      label  : 'BasePass',
    })

    // Screen-space SSS chain — only when enabled. Two separable blur passes
    // diffuse the SSS irradiance (BasePass colors[1]); the composite folds the
    // result back into the lit color before AccumPass reads it. Targets are
    // owned by the local `target()` helper, so toggling SSS off frees them.
    if (this.renderSettings.sss) {
      nodes.push({
        passKey: 'SSSBlurPass',
        defines: {SAMPLES: this.renderSettings.sssWidth},
        target : target('sssBlurA'),
        label  : 'SSSBlurPass.x',
      })
      nodes.push({
        passKey: 'SSSBlurPass',
        defines: {SAMPLES: this.renderSettings.sssWidth, AXIS_Y: true},
        target : target('sssBlurB'),
        label  : 'SSSBlurPass.y',
      })
      nodes.push({
        passKey: 'SSSCompositePass',
        target : target('sssComposite'),
        label  : 'SSSCompositePass',
      })
    }

    // Ping-pong slot is resolved at exec time — we register both
    // possible targets up front so neither one gets evicted between
    // frames.
    target('accumA')
    target('accumB')
    nodes.push({
      passKey: 'AccumPass',
      target : target('accumA'), // overridden in _renderWebGPU
      label  : 'AccumPass',
    })
    nodes.push({
      passKey: 'PassThruPass',
      target : target('accumB'), // overridden in _renderWebGPU
      label  : 'PassThruPass',
    })

    if (this.renderSettings.sharpen) {
      nodes.push({
        passKey: 'SharpenPass',
        defines: {SAMPLES: this.renderSettings.sharpenWidth},
        target : target('sharpx'),
        label  : 'SharpenPass.x',
      })
      nodes.push({
        passKey: 'SharpenPass',
        defines: {SAMPLES: this.renderSettings.sharpenWidth, AXIS_Y: true},
        target : target('sharpy'),
        label  : 'SharpenPass.y',
      })
    }

    // Phase 3.4 (deferred to Phase 5 — caller cleanup): OutputPass writes
    // to an engine-owned RenderTarget. Driving it directly into the canvas
    // swapchain would require coordinating GPUCanvasContext.getCurrentTexture
    // with `view3d_draw_webgpu.ts` (which currently owns surface acquisition).
    // That rewiring lands when view3d.ts moves to the WebGPU-only path.
    nodes.push({
      passKey: 'OutputPass',
      target : target('output'),
      label  : 'OutputPass',
    })

    // Destroy any leftover targets the old node list owned that the new
    // one no longer references.
    for (const [key, t] of this.webgpuTargets) {
      if (!fresh.has(key)) t.destroy()
    }
    this.webgpuTargets = fresh

    return nodes
  }

  _renderWebGPU(camera: Camera, viewbox_pos: number[], viewbox_size: number[], scene: Scene): void {
    const canvas = (this.view3d as unknown as {canvas?: HTMLCanvasElement | OffscreenCanvas}).canvas
    const viewport = getActiveWebGpuViewport(canvas)
    if (!viewport) {
      // GpuContext.create is still pending — drop this frame; the next
      // one will pick up the live context once view3d_draw_webgpu's
      // init promise resolves.
      return
    }
    const ctx = viewport.ctx

    const w = Math.max(1, Math.floor((viewbox_size as number[])[0]))
    const h = Math.max(1, Math.floor((viewbox_size as number[])[1]))

    const settingsHash = this.renderSettings.calcUpdateHash()
    const sizeChanged = this._webgpuLastSize[0] !== w || this._webgpuLastSize[1] !== h
    if (!this.webgpuNodes || sizeChanged || this._webgpuLastUpdateHash !== settingsHash) {
      this.webgpuNodes = this.rebuildGraphWebGPU(ctx.device, w, h)
      this._webgpuLastSize = [w, h]
      this._webgpuLastUpdateHash = settingsHash
    }

    if (!this.webgpuGraph) {
      this.webgpuGraph = new WebGpuRenderGraph(ctx)
    }

    // Mirror the per-frame weight accumulation that the GL `AccumPass`
    // does in `realtime_passes.ts:856`. Each sample contributes weight
    // w=1.0; OutputPass divides by the running sum. Without this,
    // weightSum stays at 0 (clamped to 1) and the OutputPass divide
    // produces a brightness blow-out as samples accumulate.
    this.weightSum += 1.0

    // Swap AccumPass / PassThruPass targets each frame so the accumulator
    // reads from last frame's PassThru slot and writes the other.
    const accumA = this.webgpuTargets.get('accumA')!
    const accumB = this.webgpuTargets.get('accumB')!
    for (const node of this.webgpuNodes) {
      if (node.passKey === 'AccumPass') node.target = this.webgpuPing === 0 ? accumA : accumB
      if (node.passKey === 'PassThruPass') node.target = this.webgpuPing === 0 ? accumB : accumA
    }
    this.webgpuPing = this.webgpuPing === 0 ? 1 : 0

    // Phase 3.4 — point OutputPass at the canvas swap-chain. The
    // attachments cover the full canvas (WebGPU rejects partial-sized
    // attachments), but a viewport+scissor restricts the actual draw to
    // the view3d region so multi-area screens render to the correct
    // rectangles. Acquired per-frame because the swap-chain texture is
    // ephemeral.
    const canvasTex = viewport.gpu.canvasContext.getCurrentTexture()
    const surfaceW = canvasTex.width
    const surfaceH = canvasTex.height
    ctx.size = [surfaceW, surfaceH]
    const depth = ensureCanvasDepth(viewport, surfaceW, surfaceH)
    const px = Math.max(0, Math.min(Math.floor((viewbox_pos as number[])[0]), surfaceW))
    const py = Math.max(0, Math.min(Math.floor((viewbox_pos as number[])[1]), surfaceH))
    const pw = Math.max(0, Math.min(w, surfaceW - px))
    const ph = Math.max(0, Math.min(h, surfaceH - py))
    const outputNode = this.webgpuNodes.find((n) => n.passKey === 'OutputPass')
    if (outputNode) {
      outputNode.surface = {
        view      : canvasTex.createView(),
        format    : viewport.gpu.surfaceFormat,
        depthView : depth.view,
        viewport  : {x: px, y: py, w: pw, h: ph},
        clearColor: {r: 0.15, g: 0.15, b: 0.15, a: 1},
      }
    }

    // Overlay-port Phase 1 — record the canvas attachment so the
    // `encodeOverlays` hook can re-open a load-not-clear pass against the
    // same view OutputPass writes to. The actual encoding happens via
    // `encodeOverlaysCB`, which the View3D caller installs.
    const overlayProjmat = this._jitteredProjMatrix(camera, [w, h])
    this._overlayCtx = ctx
    this._overlaySurfaceView = outputNode?.surface?.view
    this._overlayDepthView = outputNode?.surface?.depthView
    this._overlayViewport = outputNode?.surface?.viewport
    this._overlayProjmat = overlayProjmat

    const hooks: DispatchHooks = {
      bindGroupForPass: (node, pipeline) => {
        return this._buildPostProcessBindGroup(ctx, node, pipeline, camera, [w, h], scene)
      },
      encodeMeshNormalPass: (node, pass) => {
        this.encodeMeshNormalPass(ctx, node, pass, camera, [w, h], scene)
      },
      encodeMeshBasePass: (node, pass) => {
        this.encodeMeshBasePass(ctx, node, pass, camera, [w, h], scene)
      },
      encodeOverlays: (rctx) => {
        this._encodeOverlays(rctx)
      },
    }

    ctx.beginFrame()
    try {
      this.webgpuGraph.exec(this.webgpuNodes, hooks)
    } finally {
      ctx.endFrame()
      this._overlayCtx = undefined
      this._overlaySurfaceView = undefined
      this._overlayDepthView = undefined
      this._overlayViewport = undefined
      this._overlayProjmat = undefined
    }
  }

  // Phase 1.2 — opens a load-not-clear render pass against the canvas
  // surface OutputPass just wrote, scissored to the same view3d region.
  // Dispatches to the caller-supplied `encodeOverlaysCB`. Pipelines used
  // inside the callback should default to `depthCompare='less'` and
  // `depthWriteEnabled=true` so overlays z-test against each other (the
  // depth buffer here is OutputPass's; it isn't loaded with scene depth
  // yet — that's a Phase 2 follow-up if z-testing against scene geometry
  // turns out to matter).
  _encodeOverlays(rctx: WebGpuRenderContext): void {
    if (!this.encodeOverlaysCB) return
    const view = this._overlaySurfaceView
    const projmat = this._overlayProjmat
    if (!view || !projmat) return
    const depthView = this._overlayDepthView
    const vp = this._overlayViewport

    const desc: GPURenderPassDescriptor = {
      label           : 'RealtimeEngine.overlays',
      colorAttachments: [
        {
          view,
          loadOp : 'load',
          storeOp: 'store',
        },
      ],
    }
    if (depthView) {
      desc.depthStencilAttachment = {
        view        : depthView,
        depthLoadOp : 'load',
        depthStoreOp: 'store',
      }
    }

    rctx.renderStageDesc(desc, (pass) => {
      if (vp && vp.w > 0 && vp.h > 0) {
        pass.setViewport(vp.x, vp.y, vp.w, vp.h, 0, 1)
        pass.setScissorRect(vp.x, vp.y, vp.w, vp.h)
      }
      try {
        this.encodeOverlaysCB!(rctx, pass, projmat)
      } catch (err) {
        console.error('[renderengine.webgpu] encodeOverlaysCB threw:', err)
      }
    })
  }

  // Build the RenderLight-style map the WGSL light helper expects. We
  // pull straight from `scene.lights` rather than the legacy `this.lights`
  // table to avoid stale shadow-map state leaking through. The WGSL light
  // helper only reads `.light` off each entry — see
  // `LightGenWgsl.setUniforms`.
  _buildWebgpuRLights(scene: Scene): IRenderLights {
    const rlights: IRenderLights = {}
    let lid = 0
    for (const light of scene.lights) {
      rlights[lid++] = {light} as unknown as IRenderLights[string]
    }
    return rlights
  }

  // Compile (or reuse) the rgba16float-targeted material pipeline for
  // `mat`. Recompiles when the material's update hash changes or when
  // `mat._regen` is set. Registers the resulting pipeline against the
  // engine's per-material program identity in `ctx.pipelineBindings` so
  // `WebGPUDrawQueueAdapter` resolves the right pipeline at draw time.
  _ensureWebgpuMaterial(
    ctx: WebGpuRenderContext,
    scene: Scene,
    mat: Material,
    rlights: IRenderLights,
    vdmMode = false,
    vdmPtex = false
  ): WebgpuMaterialState | undefined {
    let lightHash = 0
    for (const k in rlights) lightHash = (lightHash * 31 + rlights[k].light.data.type) | 0

    // Pass-specific defines for the material WGSL. WITH_AO gates the
    // ambient-occlusion sample inside AMBIENT_WGSL — flipping it must
    // re-compile the pipeline, so it folds into the material hash.
    // VDM_MODE (mesh carries a VdmStore) adds the @group(3) sampling path;
    // it folds into the hash the same way so an attach/detach re-pushes.
    const matDefines: Record<string, number | string | boolean> = {}
    if (this.renderSettings.ao) matDefines.WITH_AO = 1
    if (this.renderSettings.sss) matDefines.WITH_SSS = 1
    if (vdmMode) matDefines.VDM_MODE = 1
    // VDM_PTEX swaps in the per-grid-table sampler (X2); folded the same way
    // so a store-backend change re-pushes.
    if (vdmMode && vdmPtex) matDefines.VDM_PTEX = 1
    let defHash = 0
    for (const k of Object.keys(matDefines).sort()) {
      for (let i = 0; i < k.length; i++) {
        defHash = (defHash * 31 + k.charCodeAt(i)) | 0
      }
    }

    const hash =
      (((mat as unknown as {calcUpdateHash?: () => number}).calcUpdateHash?.() ?? 0) * 1009 +
        lightHash * 17 +
        defHash) |
      0

    const existing = this.webgpuMaterialStates.get(mat)
    if (existing?.hash === hash && !(mat as unknown as {_regen?: number})._regen) {
      return existing
    }

    type WgslDef = {
      wgsl: string
      setUniforms: (graph: unknown, uniforms: Record<string, unknown>) => void
      requestedAttrs?: RequestedAttrDesc[]
      generator?: {setTextureUniforms(device: GPUDevice, uniforms: Record<string, unknown>): void}
    }
    let def: WgslDef
    try {
      def = (
        mat as unknown as {
          generateWgsl: (s: unknown, l: IRenderLights, d?: Record<string, number | string | boolean>) => WgslDef
        }
      ).generateWgsl(scene, rlights, matDefines)
    } catch (err) {
      console.error(`[renderengine.webgpu] mat-${mat.lib_id} generateWgsl failed:`, err)
      return undefined
    }

    const desc = buildMaterialPipelineDescriptor(
      def.wgsl,
      `engine-material-${mat.lib_id}`,
      buildMaterialVertexLayout(def.requestedAttrs)
    )
    // BasePass target is rgba16float — rewrite the registry's default
    // bgra8unorm color target so the pipeline matches our RenderTarget.
    // When SSS is on the fragment emits a 2-location FsOut (lit color + SSS
    // data) and BasePass is a 2-attachment MRT, so the pipeline carries two
    // color targets; when SSS is off it stays single-target (byte-identical to
    // before, and the sculptcore C++ tree shader path is unaffected).
    if (this.renderSettings.sss) {
      // colors[0] keeps the material's alpha blend (src-alpha). colors[1] (SSS
      // irradiance + max radius) and colors[2] (per-channel radius) MUST NOT be
      // alpha-blended: their alpha/values are data, not coverage, so src-alpha
      // blending would partially mix each fragment. Because the mesh's faces are
      // not drawn in depth order, that turns into order-dependent partial blends
      // across the surface (a hard seam / banding). Disable blend so the
      // depth-nearest fragment writes raw SSS data verbatim.
      desc.colorTargets = [
        {...desc.colorTargets[0], format: RealtimeEngine.WEBGPU_PASS_FORMAT},
        {...desc.colorTargets[0], format: RealtimeEngine.WEBGPU_PASS_FORMAT, blend: undefined},
        {...desc.colorTargets[0], format: RealtimeEngine.WEBGPU_PASS_FORMAT, blend: undefined},
      ]
    } else {
      desc.colorTargets = desc.colorTargets.map((t) => ({...t, format: RealtimeEngine.WEBGPU_PASS_FORMAT}))
    }

    let pipeline: Pipeline
    try {
      ctx.device.pushErrorScope('validation')
      pipeline = ctx.pipelineCache.get(desc)
      void ctx.device.popErrorScope().then((err) => {
        if (err) console.error(`[renderengine.webgpu] mat-${mat.lib_id} validation:`, err.message)
      })
    } catch (err) {
      console.error(`[renderengine.webgpu] mat-${mat.lib_id} pipeline compile threw:`, err)
      return undefined
    }

    const program = existing?.program ?? {
      uniforms: {} as IUniformsBlock,
      name    : `engine-mat-${mat.lib_id}`,
    }
    def.setUniforms((mat as unknown as {graph: unknown}).graph, program.uniforms as unknown as Record<string, unknown>)
    LightGenWgsl.setUniforms(program.uniforms as unknown as Record<string, unknown>, scene, rlights)
    ctx.pipelineBindings.set(program, pipeline)

    const state: WebgpuMaterialState = {
      program,
      pipeline,
      hash,
      wgsl              : def.wgsl,
      requestedAttrs    : def.requestedAttrs ?? [],
      setTextureUniforms: def.generator
        ? (device, uniforms) => def.generator!.setTextureUniforms(device, uniforms)
        : undefined,
    }
    this.webgpuMaterialStates.set(mat, state)
    return state
  }

  // Compile (or reuse) the shared NormalPassShader pipeline targeting
  // the engine's rgba16float NormalPass RenderTarget. Single pipeline
  // for the whole scene — no per-material variation.
  _ensureWebgpuNormalProgram(ctx: WebGpuRenderContext): WebgpuEngineProgram {
    if (this.webgpuNormalProgram && this.webgpuNormalPipeline) {
      return this.webgpuNormalProgram
    }
    const entry = lookupWgslShader('NormalPassShader')
    if (!entry) {
      throw new Error('RealtimeEngine: NormalPassShader not registered — see scripts/shaders/wgsl_shaders.ts')
    }
    const desc = buildPipelineDescriptor(entry)
    desc.colorTargets = desc.colorTargets.map((t) => ({...t, format: RealtimeEngine.WEBGPU_PASS_FORMAT}))

    const pipeline = ctx.pipelineCache.get(desc)
    const program: WebgpuEngineProgram = {
      uniforms: {} as IUniformsBlock,
      name    : 'engine-normalpass',
    }
    ctx.pipelineBindings.set(program, pipeline)
    this.webgpuNormalProgram = program
    this.webgpuNormalPipeline = pipeline
    return program
  }

  // Build the per-frame uniform bag used by BasePass / NormalPass scene
  // walks. Mirrors `render_intern` / `render_normals` on the GL side.
  _buildEngineFrameUniforms(
    camera: Camera,
    viewbox_size: number[],
    scene: Scene,
    projectionMatrix: Matrix4
  ): IUniformsBlock {
    return {
      projectionMatrix,
      // `normalMatrix` here lands in ObjectUniforms.normalMatrix via the
      // UniformBindings reflection — it is the per-object world rotation,
      // not the camera view rotation. Encoders below overwrite this with
      // `ob.outputs.matrix.getValue().copy().makeRotationOnly()` per draw.
      normalMatrix : new Matrix4(),
      viewportSize : viewbox_size,
      size         : viewbox_size,
      ambientColor : scene.envlight.color,
      ambientPower : scene.envlight.power,
      uSample      : this.uSample + 1,
      near         : camera.near,
      far          : camera.far,
      aspect       : camera.aspect,
      polygonOffset: 0.0,
      object_id    : 0,
      objectMatrix : new Matrix4(),
    } as unknown as IUniformsBlock
  }

  // Phase 3 — ensure a pair of (linear, nearest) samplers exists on the
  // engine. Both clamp-to-edge for post-process input textures; blue-noise
  // sampling uses a `repeat`-mode sampler returned separately below.
  _ensurePostProcessSamplers(ctx: WebGpuRenderContext): void {
    if (!this.webgpuLinearSampler) {
      this.webgpuLinearSampler = createSampler(ctx.device, {
        magFilter: 'linear',
        minFilter: 'linear',
      })
    }
    if (!this.webgpuNearestSampler) {
      this.webgpuNearestSampler = createSampler(ctx.device, {
        magFilter   : 'nearest',
        minFilter   : 'nearest',
        // createSampler defaults mipmapFilter to 'linear' — override so
        // the sampler counts as Non-Filtering. Needed for the
        // texture_depth_2d binding at @binding(7), which only accepts
        // Non-Filtering or Comparison samplers.
        mipmapFilter: 'nearest',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      })
    }
  }

  // Phase 3.2 — lazily upload the blue-noise mask to a GpuTexture once.
  // Reuses the cmyk data already shipped for the GL `getBlueMask`; only
  // the texture upload changes. RGBA8 is enough — the WGSL only consumes
  // `.x` and squishes the value to 10 buckets anyway.
  _ensureBlueTexture(ctx: WebGpuRenderContext): GpuTexture {
    if (this.webgpuBlueTexture) return this.webgpuBlueTexture
    const mask = bluenoise.cmyk
    const size = mask.dimen
    const comps = mask.components
    const data = mask.mask
    const pixels = new Uint8Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      const src = i * comps
      const dst = i * 4
      for (let j = 0; j < 4; j++) {
        pixels[dst + j] = j < comps ? data[src + j] : 0xff
      }
    }
    const tex = new GpuTexture(ctx.device, {
      label : 'RealtimeEngine.blueNoise',
      width : size,
      height: size,
      format: 'rgba8unorm',
      usage : TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    })
    ctx.device.queue.writeTexture(
      {texture: tex.handle},
      pixels,
      {bytesPerRow: size * 4, rowsPerImage: size},
      {width: size, height: size, depthOrArrayLayers: 1}
    )
    this.webgpuBlueTexture = tex
    return tex
  }

  // Lazy per-node uniform-buffer allocation. Pass buffer is always 272 bytes
  // (PassUniforms). Extra buffer is created only for passes that declare
  // a binding-4 uniform (AccumPass / SharpenPass / AOPass).
  _ensurePassBuffers(ctx: WebGpuRenderContext, node: GraphNodeRef): {pass: GpuBuffer; extra?: GpuBuffer} {
    const cached = this.webgpuPassBuffers.get(node)
    if (cached) return cached
    const pass = new GpuBuffer(ctx.device, {
      label: `RealtimeEngine.${node.label ?? node.passKey}.PassUniforms`,
      size : 272,
      usage: 'uniform',
    })
    let extraSize = 0
    if (node.passKey === 'AccumPass' || node.passKey === 'SharpenPass') extraSize = 16
    if (node.passKey === 'AOPass') extraSize = 32
    if (node.passKey === 'SSSBlurPass' || node.passKey === 'SSSCompositePass') extraSize = 16
    const extra =
      extraSize > 0
        ? new GpuBuffer(ctx.device, {
            label: `RealtimeEngine.${node.label ?? node.passKey}.Extra`,
            size : extraSize,
            usage: 'uniform',
          })
        : undefined
    const entry = {pass, extra}
    this.webgpuPassBuffers.set(node, entry)
    return entry
  }

  // Locate the upstream `RenderTarget` whose color attachment feeds
  // `node.fbo_rgba_tex`. Follows the same edges the GL graph wires in
  // `rebuildGraph()`:
  //
  //   AOPass        ← NormalPass
  //   AccumPass     ← BasePass
  //   PassThruPass  ← AccumPass (current ping target)
  //   SharpenPass.x ← PassThruPass
  //   SharpenPass.y ← SharpenPass.x
  //   OutputPass    ← SharpenPass.y (if sharpen) else PassThruPass
  //
  // Returns the actual target reference, which for AccumPass / PassThruPass
  // reflects the per-frame ping-pong swap (target is overridden in
  // `_renderWebGPU` before `exec`).
  _getPassInputTarget(node: GraphNodeRef): RenderTarget {
    if (!this.webgpuNodes) {
      throw new Error('_getPassInputTarget called before webgpuNodes built')
    }
    const nodes = this.webgpuNodes
    const idx = nodes.indexOf(node)
    if (node.passKey === 'AOPass') {
      const nor = nodes.find((n) => n.passKey === 'NormalPass')
      if (!nor) throw new Error('AOPass without NormalPass upstream')
      return nor.target
    }
    if (node.passKey === 'AccumPass') {
      // When SSS is on, the composite has already folded scatter into the lit
      // color; AccumPass reads it instead of raw BasePass.
      const composite = nodes.find((n) => n.passKey === 'SSSCompositePass')
      if (composite) return composite.target
      const base = nodes.find((n) => n.passKey === 'BasePass')
      if (!base) throw new Error('AccumPass without BasePass upstream')
      return base.target
    }
    if (node.passKey === 'SSSBlurPass') {
      const isYAxis = node.defines?.AXIS_Y === true
      if (isYAxis) {
        // Y reads the X-pass output (the nearest prior SSSBlurPass).
        for (let i = idx - 1; i >= 0; i--) {
          if (nodes[i].passKey === 'SSSBlurPass') return nodes[i].target
        }
        throw new Error('SSSBlurPass.y without SSSBlurPass.x upstream')
      }
      // X reads the SSS irradiance attachment — BasePass colors[1]. The bind
      // group (below) selects color index 1; here we just return the target.
      const base = nodes.find((n) => n.passKey === 'BasePass')
      if (!base) throw new Error('SSSBlurPass.x without BasePass upstream')
      return base.target
    }
    if (node.passKey === 'SSSCompositePass') {
      // Primary input (binding 1) is the lit BasePass colors[0]; the blurred
      // and original SSS textures are added as extras in the bind group.
      const base = nodes.find((n) => n.passKey === 'BasePass')
      if (!base) throw new Error('SSSCompositePass without BasePass upstream')
      return base.target
    }
    if (node.passKey === 'PassThruPass') {
      const accum = nodes.find((n) => n.passKey === 'AccumPass')
      if (!accum) throw new Error('PassThruPass without AccumPass upstream')
      return accum.target
    }
    if (node.passKey === 'SharpenPass') {
      const isYAxis = node.defines?.AXIS_Y === true
      if (isYAxis) {
        // find sharpx (the first SharpenPass before this one)
        for (let i = idx - 1; i >= 0; i--) {
          if (nodes[i].passKey === 'SharpenPass') return nodes[i].target
        }
        throw new Error('SharpenPass.y without SharpenPass.x upstream')
      }
      const passThru = nodes.find((n) => n.passKey === 'PassThruPass')
      if (!passThru) throw new Error('SharpenPass.x without PassThruPass upstream')
      return passThru.target
    }
    if (node.passKey === 'OutputPass') {
      // Walk back to the nearest upstream post-process target.
      for (let i = idx - 1; i >= 0; i--) {
        const k = nodes[i].passKey
        if (
          k === 'SharpenPass' ||
          k === 'PassThruPass' ||
          k === 'AccumPass' ||
          k === 'SSSCompositePass' ||
          k === 'BasePass'
        ) {
          return nodes[i].target
        }
      }
      throw new Error('OutputPass without any upstream pass')
    }
    throw new Error(`_getPassInputTarget: unknown passKey "${node.passKey}"`)
  }

  // Pack PassUniforms (mat4x4*4 + vec2 + f32 + f32 → 272 bytes) and write
  // to the buffer. Matches `PASS_UNIFORMS_WGSL` in `wgsl_render_passes.ts`.
  _writePassUniforms(buf: GpuBuffer, camera: Camera, viewbox_size: number[]): void {
    const data = new Float32Array(68) // 272 / 4
    // 4 mat4x4 (16 floats each) = 64 floats
    const proj = camera.rendermat.getAsArray()
    const iproj = camera.irendermat.getAsArray()
    const view = camera.cameramat.getAsArray()
    const iview = camera.icameramat.getAsArray()
    for (let i = 0; i < 16; i++) data[i] = proj[i]
    for (let i = 0; i < 16; i++) data[16 + i] = iproj[i]
    for (let i = 0; i < 16; i++) data[32 + i] = view[i]
    for (let i = 0; i < 16; i++) data[48 + i] = iview[i]
    data[64] = viewbox_size[0]
    data[65] = viewbox_size[1]
    data[66] = this.uSample
    data[67] = Math.max(this.weightSum, 1)
    buf.write(data)
  }

  // Write the binding-4 pass-specific uniforms when applicable.
  _writeExtraUniforms(
    ctx: WebGpuRenderContext,
    node: GraphNodeRef,
    buf: GpuBuffer,
    scene: Scene,
    viewbox_size: number[]
  ): void {
    if (node.passKey === 'AccumPass') {
      const data = new Float32Array(4)
      data[0] = 1.0 // AccumUniforms.w — historically hard-coded 1.0; preserved.
      buf.write(data)
      return
    }
    if (node.passKey === 'SharpenPass') {
      const data = new Float32Array(4)
      data[0] = this.renderSettings.sharpenFac
      buf.write(data)
      return
    }
    if (node.passKey === 'AOPass') {
      // AOUniforms: blueUVOff(vec2) + blueUVScale(vec2) + dist + factor + steps + _pad
      const env = scene.envlight as unknown as {ao_fac: number; ao_dist: number}
      const data = new Float32Array(8)
      const blue = this._ensureBlueTexture(ctx)
      this._webgpuRng.seed(this.uSample)
      data[0] = this._webgpuRng.random()
      data[1] = this._webgpuRng.random()
      data[2] = viewbox_size[0] / blue.width
      data[3] = viewbox_size[1] / blue.height
      data[4] = env.ao_dist
      data[5] = env.ao_fac
      data[6] = 10240
      data[7] = 0
      buf.write(data)
      return
    }
    if (node.passKey === 'SSSBlurPass') {
      // SSSBlurUniforms: falloff, maxScreenPx, pad, pad. The per-pixel world
      // scatter radius (with the node's CPU-side unit factor already folded in)
      // comes from BasePass colors[1].a; falloff here is a global shape knob.
      const data = new Float32Array(4)
      data[0] = this.renderSettings.sssFalloff
      data[1] = 64.0 // maxScreenPx — clamp the screen-space kernel half-width
      buf.write(data)
      return
    }
    if (node.passKey === 'SSSCompositePass') {
      const data = new Float32Array(4)
      data[0] = this.renderSettings.sssStrength
      buf.write(data)
      return
    }
  }

  // Phase 3.1 — entry point for `DispatchHooks.bindGroupForPass`. Builds
  // a single @group(0) bind group whose entries cover PassUniforms, the
  // input color/depth textures, the sampler, and any per-pass extras
  // (AccumUniforms / SharpenUniforms / AOUniforms + blue-noise pair).
  _buildPostProcessBindGroup(
    ctx: WebGpuRenderContext,
    node: GraphNodeRef,
    pipeline: Pipeline,
    camera: Camera,
    viewbox_size: number[],
    scene: Scene
  ): GPUBindGroup {
    this._ensurePostProcessSamplers(ctx)
    const linear = this.webgpuLinearSampler!
    const nearest = this.webgpuNearestSampler!

    const buffers = this._ensurePassBuffers(ctx, node)
    this._writePassUniforms(buffers.pass, camera, viewbox_size)
    if (buffers.extra) this._writeExtraUniforms(ctx, node, buffers.extra, scene, viewbox_size)

    const input = this._getPassInputTarget(node)
    // The SSS X-blur reads the SSS irradiance/radius attachment (BasePass
    // colors[1]); every other pass reads colors[0]. The Y-blur reads its
    // X-pass output, which is a single-attachment target, so index 0 there.
    const isSssBlurX = node.passKey === 'SSSBlurPass' && node.defines?.AXIS_Y !== true
    const colorIndex = isSssBlurX ? 1 : 0
    const colorView = input.colors[colorIndex].view
    const depthView = input.depth?.view
    if (!depthView) {
      throw new Error(`bindGroupForPass: input target for "${node.passKey}" has no depth attachment`)
    }

    const entries: GPUBindGroupEntry[] = [
      {binding: 0, resource: {buffer: buffers.pass.handle}},
      {binding: 1, resource: colorView},
      {binding: 2, resource: linear},
      {binding: 3, resource: depthView},
      // binding 7 — non-filtering sampler dedicated to fbo_depth_tex.
      // depth24plus only supports `Depth`/`UnfilterableFloat` sample types,
      // so it can't share `linear` (a Filtering sampler). The shaders
      // declare `texture_depth_2d` at binding 3 + `sampler` at binding 7.
      {binding: 7, resource: nearest},
    ]

    if (node.passKey === 'AccumPass') {
      entries.push({binding: 4, resource: {buffer: buffers.extra!.handle}})
      // binding 5 — previous-frame accumulator. PassThruPass's target is
      // already swapped to the slot we wrote last frame (see ping-pong in
      // `_renderWebGPU`), so it doubles as the lastBuf source.
      const passThru = this.webgpuNodes!.find((n) => n.passKey === 'PassThruPass')
      if (!passThru) throw new Error('AccumPass bind: no PassThruPass node to source lastBuf from')
      entries.push({binding: 5, resource: passThru.target.colors[0].view})
    } else if (node.passKey === 'SharpenPass') {
      entries.push({binding: 4, resource: {buffer: buffers.extra!.handle}})
    } else if (node.passKey === 'AOPass') {
      const blue = this._ensureBlueTexture(ctx)
      entries.push({binding: 4, resource: {buffer: buffers.extra!.handle}})
      entries.push({binding: 5, resource: blue.view})
      entries.push({binding: 6, resource: nearest})
    } else if (node.passKey === 'SSSBlurPass') {
      entries.push({binding: 4, resource: {buffer: buffers.extra!.handle}})
      // binding 8 — per-channel world scatter radius (BasePass colors[2]),
      // sampled at the center pixel to build the per-channel blur weights. It's a
      // per-pixel constant (not blurred), so both the X and Y pass read it from
      // the base pass directly.
      const base = this.webgpuNodes!.find((n) => n.passKey === 'BasePass')
      if (!base) throw new Error('SSSBlurPass bind: no BasePass to source per-channel radius from')
      entries.push({binding: 8, resource: base.target.colors[2].view})
    } else if (node.passKey === 'SSSCompositePass') {
      entries.push({binding: 4, resource: {buffer: buffers.extra!.handle}})
      // binding 5 — the diffused SSS (Y-blur output, single attachment).
      const blurY = this.webgpuNodes!.find((n) => n.passKey === 'SSSBlurPass' && n.defines?.AXIS_Y === true)
      if (!blurY) throw new Error('SSSCompositePass bind: no SSSBlurPass.y to source blurred SSS from')
      entries.push({binding: 5, resource: blurY.target.colors[0].view})
      // binding 6 — the original (sharp) SSS irradiance, BasePass colors[1],
      // for the energy-conserving difference composite.
      const base = this.webgpuNodes!.find((n) => n.passKey === 'BasePass')
      if (!base) throw new Error('SSSCompositePass bind: no BasePass to source original SSS from')
      entries.push({binding: 6, resource: base.target.colors[1].view})
    }

    return ctx.device.createBindGroup({
      label : `RealtimeEngine.${node.label ?? node.passKey}.bg0`,
      layout: pipeline.handle.getBindGroupLayout(0),
      entries,
    })
  }

  // Per-sample AA jitter applied as a clip-space translation on the
  // projection matrix. Single source of truth — both backends should
  // route through this. Uses deterministic blue-noise samples from
  // `getJitterSamples` (realtime_passes.ts:146) indexed by `uSample`,
  // sized so each shift stays inside ±filterWidth/2 pixels. No
  // `Math.random()` — keeping the sequence reproducible makes the
  // accumulator's per-sample frame hash stable for caching and debug.
  _jitteredProjMatrix(camera: Camera, viewbox_size: number[]): Matrix4 {
    const jit = getJitterSamples(55)
    const shift = jit[this.uSample % jit.length]
    const r = this.renderSettings.filterWidth
    const sx = ((shift[0] * r) / viewbox_size[0]) * 0.5
    const sy = ((shift[1] * r) / viewbox_size[1]) * 0.5
    const proj = new Matrix4(this.getProjMat(camera, viewbox_size))
    const jitterMat = new Matrix4()
    jitterMat.translate(sx, sy, 0.0)
    proj.preMultiply(jitterMat)
    return proj
  }

  // Phase 2.1 — scene walk that the WebGpuRenderGraph dispatcher invokes
  // for the BasePass node. Compiles each material's WGSL pipeline
  // against `WEBGPU_PASS_FORMAT` and delegates the per-object draws to
  // `ob.draw()` which routes through `createDrawQueue` →
  // `WebGPUDrawQueueAdapter`.
  encodeMeshBasePass(
    ctx: WebGpuRenderContext,
    node: GraphNodeRef,
    pass: GPURenderPassEncoder,
    camera: Camera,
    viewbox_size: number[],
    scene: Scene
  ): void {
    void node
    void pass

    const matrix = this._jitteredProjMatrix(camera, viewbox_size)

    const rlights = this._buildWebgpuRLights(scene)
    const uniforms = this._buildEngineFrameUniforms(camera, viewbox_size, scene, matrix)

    // Seed AO sampling slots. The WGSL declares `passAO_tex`/`passAO_smp`
    // unconditionally; when WITH_AO is unset the layout drops them, so
    // missing seeds are harmless. When WITH_AO is set, `UniformBindings`
    // routes these into @group(0) bindings 1/2 against the material
    // pipeline.
    const aoTarget = this.webgpuTargets.get('ao')
    if (aoTarget && this.renderSettings.ao) {
      this._ensurePostProcessSamplers(ctx)
      const aoColor = aoTarget.colors[0]
      if (aoColor) {
        ;(uniforms as unknown as Record<string, unknown>).passAO_tex = aoColor.view
        ;(uniforms as unknown as Record<string, unknown>).passAO_smp = this.webgpuLinearSampler!
      }
    }

    // ctx.drawmats backs the WebGPU draw queue's default uniforms; refresh
    // it before issuing draws so the camera matrices stay consistent.
    ctx.drawmats = camera

    const view3d = this.view3d
    for (const ob of scene.objects.renderable) {
      if (!ob.data.usesMaterial) continue
      const mats = (ob.data as unknown as {materials: ArrayLike<Material | undefined>}).materials
      if (!mats || mats.length === 0) continue
      const mat = mats[0]
      if (!mat) continue

      // A VdmStore-carrying mesh renders through the VDM fragment path:
      // VDM_MODE folds into the material hash so an attach/detach re-pushes.
      // (Per-material cache: a mat shared across meshes follows the last push.)
      const vdmMode = !!(ob.data as unknown as {hasVdm?: boolean}).hasVdm
      const vdmPtex = !!(ob.data as unknown as {vdmIsPtex?: boolean}).vdmIsPtex
      const state = this._ensureWebgpuMaterial(ctx, scene, mat, rlights, vdmMode, vdmPtex)
      if (!state) continue

      // LiteMesh integration: its sculpt draw batch renders with the C++ tree
      // shader, not this BasePass pipeline. Feed it the compiled material WGSL +
      // requested attribute set so sculptcore builds the matching vertex buffers
      // and draws with the material. Guarded on two cheap signatures so the work
      // runs only when something actually changed, never per frame:
      //   • material hash — the WGSL/attr set changed; re-push both (setDrawShader
      //     rebuilds the C++ ShaderDef: drops the batch, flags leaves).
      //   • attr-layer signature — the *mesh* layers changed (a color/UV layer
      //     added or removed) while the material is unchanged. The requested
      //     descriptors can be byte-identical (a layer whose domain matches the
      //     category default), so setRequestedAttrs would short-circuit and the
      //     buffers would stay default-filled; refreshRequestedAttrs forces the
      //     per-attribute buffers to re-gather without relinking the shader.
      // Duck-typed to keep the renderengine decoupled from any one geometry provider.
      const treeProvider = ob.data as unknown as {
        setRequestedAttrs?: (reqs: RequestedAttrDesc[]) => void
        setDrawShader?: (wgsl: string) => void
        getMissingAttrSlots?: () => number[]
        attrLayersSignature?: () => number
        refreshRequestedAttrs?: () => void
        _engineDrawShaderHash?: number
        _engineAttrLayersSig?: number
      }
      // Per-object draw mode: only TEXTURED objects get the material WGSL; a
      // SOLID (or BOUNDS/WIRE) object renders with the basic tree shader, so
      // push an empty draw shader instead (hash 0 keys the "no material" state).
      const wantMaterial = (ob.drawMode & DrawModes.TEXTURED) !== 0
      const effHash = wantMaterial ? state.hash : 0
      const layerSig = treeProvider.attrLayersSignature?.() ?? 0
      const matChanged = treeProvider._engineDrawShaderHash !== effHash
      const layersChanged = treeProvider._engineAttrLayersSig !== layerSig
      if (typeof treeProvider.setDrawShader === 'function' && (matChanged || layersChanged)) {
        try {
          if (!wantMaterial) {
            if (matChanged) {
              treeProvider.setDrawShader('')
            }
          } else {
            treeProvider.setRequestedAttrs?.(state.requestedAttrs)
            if (matChanged) {
              treeProvider.setDrawShader(state.wgsl)
            } else {
              // Only the mesh layers moved — re-gather buffers, keep the shader.
              treeProvider.refreshRequestedAttrs?.()
            }
            const missing = treeProvider.getMissingAttrSlots?.() ?? []
            if (missing.length > 0) {
              const names = state.requestedAttrs.filter((r) => missing.includes(r.slot)).map((r) => r.name)
              console.warn(
                `[renderengine.webgpu] mat-${mat.lib_id}: ${missing.length} requested attribute(s) ` +
                  `absent on the mesh, rendering with defaults: ${names.join(', ')}`
              )
            }
          }
          treeProvider._engineDrawShaderHash = effHash
          treeProvider._engineAttrLayersSig = layerSig
        } catch (err) {
          console.error(`[renderengine.webgpu] tree attr push failed for mat-${mat.lib_id}:`, err)
        }
      } else if (matChanged || layersChanged) {
        // Every other provider that binds material attributes by name
        // (geometry-contract §10.2). It draws with the BasePass pipeline
        // compiled just above, so it needs the requested set and nothing else —
        // the WGSL push is the sculptcore-tree path's business.
        const consumer = asMaterialAttrConsumer(ob.data)
        if (consumer) {
          try {
            consumer.setRequestedAttrs(wantMaterial ? state.requestedAttrs : [])
            treeProvider._engineDrawShaderHash = effHash
            treeProvider._engineAttrLayersSig = layerSig
          } catch (err) {
            console.error(`[renderengine.webgpu] attr push failed for mat-${mat.lib_id}:`, err)
          }
        }
      }

      // X3 tessellated tier: hand the mesh a TESS_TIER material variant
      // (position-only vertex input + derivative flat normal); the mesh then
      // substitutes its own indexed draw of the GPU-amplified render level
      // for the batch. Guarded on the same material hash as the normal push.
      const tessMesh = ob.data as unknown as {
        tessellatedDisplay?: boolean
        setTessDrawWgsl?: (wgsl: string) => void
        _engineTessHash?: number
      }
      if (tessMesh.tessellatedDisplay && typeof tessMesh.setTessDrawWgsl === 'function') {
        if (tessMesh._engineTessHash !== state.hash) {
          try {
            const tessDefines: Record<string, number | string | boolean> = {TESS_TIER: 1}
            if (this.renderSettings.ao) tessDefines.WITH_AO = 1
            if (this.renderSettings.sss) tessDefines.WITH_SSS = 1
            const tdef = (
              mat as unknown as {
                generateWgsl: (
                  s: unknown,
                  l: IRenderLights,
                  d?: Record<string, number | string | boolean>
                ) => {wgsl: string}
              }
            ).generateWgsl(scene, rlights, tessDefines)
            tessMesh.setTessDrawWgsl(tdef.wgsl)
            tessMesh._engineTessHash = state.hash
          } catch (err) {
            console.error(`[renderengine.webgpu] mat-${mat.lib_id} tess variant failed:`, err)
          }
        }
      }

      // Image-node textures: re-seed the texture views/samplers every frame
      // (getGpuTex re-uploads + swaps views when an image regenerates).
      state.setTextureUniforms?.(ctx.device, state.program.uniforms as unknown as Record<string, unknown>)

      const obMat = ob.outputs.matrix.getValue() as Matrix4
      uniforms.objectMatrix = obMat
      uniforms.normalMatrix = obMat.copy().makeRotationOnly()
      try {
        ob.draw(view3d, this.gl, uniforms, state.program as unknown as ShaderProgram)
      } catch (err) {
        console.error(`[renderengine.webgpu] BasePass ob-${ob.lib_id} draw threw:`, err)
      }
    }
  }

  // Scene walk for the NormalPass node. Every renderable draws with the
  // single `NormalPassShader` WGSL pipeline — no material variation.
  encodeMeshNormalPass(
    ctx: WebGpuRenderContext,
    node: GraphNodeRef,
    pass: GPURenderPassEncoder,
    camera: Camera,
    viewbox_size: number[],
    scene: Scene
  ): void {
    void node
    void pass

    const program = this._ensureWebgpuNormalProgram(ctx)
    const uniforms = this._buildEngineFrameUniforms(camera, viewbox_size, scene, this.getProjMat(camera, viewbox_size))
    ctx.drawmats = camera

    const view3d = this.view3d
    for (const ob of scene.objects.renderable) {
      if (!ob.data.usesMaterial) continue
      // Sculptcore-tree objects (LiteMesh) draw via their own installed
      // material shader and ignore the NormalPassShader handed in here, so
      // they can't emit a correct view-normal pass. Skip them — they render
      // only in the BasePass. Drawing them here would also run their
      // once-per-frame batch rebuild a second time, freeing GPU buffers the
      // BasePass's encoded commands still reference. (Cost: no SSAO
      // contribution from LiteMeshes yet.) Duck-typed to keep the
      // renderengine decoupled from the lite-mesh layer.
      if (typeof (ob.data as unknown as {setDrawShader?: unknown}).setDrawShader === 'function') continue
      const obMat = ob.outputs.matrix.getValue() as Matrix4
      uniforms.objectMatrix = obMat
      uniforms.normalMatrix = obMat.copy().makeRotationOnly()
      try {
        ob.draw(view3d, this.gl, uniforms, program as unknown as ShaderProgram)
      } catch (err) {
        console.error(`[renderengine.webgpu] NormalPass ob-${ob.lib_id} draw threw:`, err)
      }
    }
  }

  // Sharpen parameters live on `renderSettings.sharpenWidth`/`sharpenFac`
  // and are read directly by the WGSL SharpenPass's uniform-buffer seed in
  // `_buildPostProcessBindGroup`. Changing them invalidates the settings
  // hash, which triggers a graph rebuild — no per-frame sync needed here.
  update(_gl: WebGL2RenderingContext) {}

  resetRender() {
    //console.log("reset render frame");
    this.uSample = 0
    this.weightSum = 0.0
  }

  addLight(light: SceneObject<Light>) {
    const id = this._getLightId(light)
    const rlight = new RenderLight(light, id)

    this.lights[id] = rlight
    return rlight
  }

  updateLight(light: SceneObject<Light>) {
    const id = this._getLightId(light)

    if (!(id in this.lights)) {
      this.addLight(light)
    }

    this.lights[id].update(light, this.uSample)
  }

  updateLights() {
    for (const k in this.lights) {
      this.lights[k].update(this.lights[k].light, this.uSample)
    }
  }

  _getLightId(light: SceneObject<Light>) {
    const lightAny = light as any
    if (typeof lightAny[LightIdSymbol] === 'undefined') {
      lightAny[LightIdSymbol] = this.light_idgen++
    }

    return lightAny[LightIdSymbol] as number
  }

  updateSceneLights() {
    for (const light of this.scene.lights) {
      const id = this._getLightId(light)

      if (!(id in this.lights)) {
        this.lights[id] = new RenderLight(light, id)
      }
    }
  }

  render(camera: Camera, gl: WebGL2RenderingContext, viewbox_pos: number[], viewbox_size: number[], scene: Scene) {
    const shash = this.renderSettings.calcUpdateHash()
    if (this._last_update_hash !== shash) {
      this._last_update_hash = shash
      this.resetSamples()
      this._queueResetSamples = false
    } else if (this._queueResetSamples) {
      this.resetSamples()
      this._queueResetSamples = false
    }

    if (this.uSample >= this.renderSettings.minSamples) {
      this._render(camera, gl, viewbox_pos, viewbox_size, scene)
      return
    }

    let max = 1000

    while (this.uSample < this.renderSettings.minSamples && max--) {
      this._render(camera, gl, viewbox_pos, viewbox_size, scene)
    }
  }

  _render(camera: Camera, gl: WebGL2RenderingContext, viewbox_pos: number[], viewbox_size: number[], scene: Scene) {
    this.scene = scene
    this.gl = gl
    this.camera = camera

    const hash = camera.generateUpdateHash()
    if (hash !== this._last_camerahash) {
      this.uSample = 0
      this.weightSum = 0.0
      this._last_camerahash = hash
    }

    this.uSample++

    this.updateSceneLights()
    this.updateLights()

    this._renderWebGPU(camera, viewbox_pos, viewbox_size, scene)
  }

  getProjMat(camera: Camera, viewbox_size: number[]) {
    void viewbox_size
    const pmat = this.projmat

    pmat.load(camera.rendermat)
    return pmat
  }

  queueResetSamples() {
    this._queueResetSamples = true
  }

  resetSamples() {
    this.uSample = 0
    this.weightSum = 0.0
  }

  destroy(gl: WebGL2RenderingContext) {
    void gl
    for (const t of this.webgpuTargets.values()) t.destroy()
    this.webgpuTargets.clear()
    this.webgpuNodes = undefined
    this.webgpuGraph = undefined
  }
}

RenderEngine.register(RealtimeEngine)
