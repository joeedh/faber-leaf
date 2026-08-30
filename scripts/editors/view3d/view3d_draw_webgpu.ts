/**
 * WebGPU sibling of `view3d_draw.ts` / `View3D.viewportDraw_intern`.
 *
 * Owns the per-canvas WebGPU lifecycle (`GpuContext` +
 * `WebGpuRenderContext`) and drives a single canvas-targeted render
 * pass that walks the scene-object draw chain. Because
 * `createDrawQueue` in `scripts/render/queue_factory.ts` already
 * branches on `isWebGPU()` + the registered active context, all we
 * have to do here is:
 *
 *   1. Construct + register the `WebGpuRenderContext` once per canvas.
 *   2. Each frame: acquire the canvas surface, open one full-canvas
 *      render pass, set viewport/scissor to the view3d region, then
 *      drive the existing scene-object draw chain inside it.
 *
 * The color + depth attachments cover the *entire canvas surface*
 * (otherwise WebGPU rejects the pass with a size-mismatch). The
 * view3d region inside that canvas is enforced with `setViewport`
 * + `setScissorRect` so multi-area screens render to the right
 * rectangles.
 *
 * The legacy WebGL `ShaderProgram` objects in `view3d_shaders.Shaders`
 * are replaced by `wgslKey`-tagged stubs at init (see
 * `loadWgslShaderStubs` in `view3d.ts`), so existing `ob.draw(view3d,
 * gl, uniforms, program)` calls flow through `createDrawQueue` →
 * `WebGPUDrawQueueAdapter`, which resolves the pipeline from the
 * WGSL registry via that key.
 */

import {Matrix4, Vector2} from '../../path.ux/scripts/util/vectormath.js'
import type {Vector3, Vector4} from '../../path.ux/scripts/util/vectormath.js'
import type {DrawMats, IUniformsBlock, ShaderProgram} from '../../webgl/webgl.js'
import {SimpleMesh, LayerTypes} from '../../webgl/simplemesh.js'
import type {FrameContext} from '../../render/queue.js'
import {isWebGPU} from '../../core/renderer_flag.js'
import {GpuContext} from '../../webgpu/gpucontext.js'
import {WebGpuRenderContext} from '../../webgpu/render_context.js'
import {GpuTexture} from '../../webgpu/texture.js'
import {TextureUsage} from '../../webgpu/flags.js'
import {setActiveWebGpuContext, createDrawQueue} from '../../render/queue_factory.js'
import {View3DFlags} from './view3d_base.js'
import {getWebGpuDebug} from '../debug/webgpu_debug.js'
import * as view3d_shaders from '../../shaders/shaders.js'
import {
  buildMaterialPipelineDescriptor,
  buildMaterialVertexLayout,
  buildSolidTexturedWgsl,
  type MaterialVertexAttr,
} from '../../shaders/wgsl_shaders.js'
import {asMaterialAttrConsumer, type MaterialAttrRequest} from '../../core/vertex_layout.js'
import type {Pipeline} from '../../webgpu/pipeline.js'
import {LightGenWgsl, type IRenderLights} from '../../shadernodes/shader_lib_wgsl.js'
import {sharedLinearSampler} from '../../shadernodes/shader_nodes_wgsl.js'
import {nextUniformFrameEpoch} from '../../webgpu/uniform_bindings.js'
import {ImageNode} from '../../shadernodes/shader_nodes.js'
import {DrawModes} from '../../sceneobject/drawmode.js'

export interface WebGpuViewport {
  gpu: GpuContext
  ctx: WebGpuRenderContext
  /** Cached depth texture; recreated when canvas surface size changes. */
  depth: GpuTexture | undefined
  depthSize: [number, number]
}

const viewports = new WeakMap<HTMLCanvasElement | OffscreenCanvas, WebGpuViewport>()

// Lookup the viewport state for a canvas. Returned object exposes the
// `GpuContext` (device, canvasContext, surfaceFormat) and the live
// `WebGpuRenderContext` — needed by the FBO debug editor to encode its
// own blit pass against the canvas after view3d's frame submit.
export function getActiveWebGpuViewport(
  canvas: HTMLCanvasElement | OffscreenCanvas | undefined
): WebGpuViewport | undefined {
  if (!canvas) return undefined
  return viewports.get(canvas)
}
const inflightInits = new WeakMap<HTMLCanvasElement | OffscreenCanvas, Promise<WebGpuViewport>>()

/**
 * Release a canvas's GPU state — its depth texture, its device, and both
 * WeakMap entries. Called by an app instance's teardown; mounting and
 * unmounting in a loop must not accumulate devices.
 */
export function destroyWebGpuViewport(canvas: HTMLCanvasElement | OffscreenCanvas | undefined): void {
  if (!canvas) {
    return
  }

  const viewport = viewports.get(canvas)

  viewports.delete(canvas)
  inflightInits.delete(canvas)

  if (viewport === undefined) {
    return
  }

  const dbg = globalThis as unknown as {__webgpuDebug?: {viewport?: WebGpuViewport}}
  if (dbg.__webgpuDebug?.viewport === viewport) {
    dbg.__webgpuDebug = undefined
  }

  viewport.depth?.destroy()
  viewport.depth = undefined
  viewport.gpu.destroy()
}

function fakeDrawMats(): DrawMats {
  return {} as DrawMats
}

async function initViewport(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  size: [number, number]
): Promise<WebGpuViewport> {
  const gpu = await GpuContext.create({canvas, powerPreference: 'high-performance'})
  const ctx = new WebGpuRenderContext({
    device  : gpu.device,
    drawmats: fakeDrawMats(),
    size,
    surfaceFormat: gpu.surfaceFormat,
  })
  setActiveWebGpuContext(ctx)
  const viewport: WebGpuViewport = {gpu, ctx, depth: undefined, depthSize: [0, 0]}
  viewports.set(canvas, viewport)
  // Debug hook — exposes the live device + ctx so the DevTools console
  // can `gpuDevice.popErrorScope()` etc. without touching app code.
  ;(globalThis as unknown as {__webgpuDebug?: unknown}).__webgpuDebug = {
    gpu,
    ctx,
    device: gpu.device,
    viewport,
  }
  gpu.device.addEventListener?.('uncapturederror', (ev) => {
    const e = ev as unknown as {error: GPUError}
    // eslint-disable-next-line no-console
    // eslint-disable-next-line no-console
    console.error('[webgpu] uncapturederror:', e.error.message)
  })
  return viewport
}

// Canvas-sized depth attachment, cached on the viewport. Used both by
// the smoke-test `drawViewportWebGpu` path and by `RealtimeEngine`'s
// OutputPass surface attachment so both stay in sync on resize.
export function ensureCanvasDepth(viewport: WebGpuViewport, w: number, h: number): GpuTexture {
  return ensureDepth(viewport, w, h)
}

function ensureDepth(viewport: WebGpuViewport, w: number, h: number): GpuTexture {
  if (viewport.depth && viewport.depthSize[0] === w && viewport.depthSize[1] === h) {
    return viewport.depth
  }
  viewport.depth?.destroy()
  viewport.depth = new GpuTexture(viewport.gpu.device, {
    label : 'view3d.depth',
    width : w,
    height: h,
    format: 'depth24plus',
    usage : TextureUsage.RENDER_ATTACHMENT,
  })
  viewport.depthSize = [w, h]
  return viewport.depth
}

const warnedFeatures = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (warnedFeatures.has(key)) return
  warnedFeatures.add(key)
  // eslint-disable-next-line no-console
  console.warn(`[webgpu] ${key}: ${message}`)
}

// Kick (or look up) the per-canvas WebGPU init. Returns the viewport
// once GpuContext.create has resolved, undefined while still pending.
// Used by `view3d.viewportDraw_intern` to drive the renderengine without
// invoking the smoke-test `drawSceneWebGpu` draws.
export function primeWebGpuViewport(canvas: HTMLCanvasElement | OffscreenCanvas): WebGpuViewport | undefined {
  const existing = viewports.get(canvas)
  if (existing) return existing
  let pending = inflightInits.get(canvas)
  if (!pending) {
    const initSize: [number, number] = [Math.max(1, canvas.width | 0), Math.max(1, canvas.height | 0)]
    pending = initViewport(canvas, initSize).finally(() => {
      inflightInits.delete(canvas)
    })
    inflightInits.set(canvas, pending)
    pending
      .then(() => {
        // The first frame's caller returned early before init resolved.
        // Nothing else will schedule a frame (the rAF loop only re-fires
        // on redraw_viewport() / interaction), so kick one ourselves once
        // the device is up.
        const w = window as unknown as {redraw_viewport?: () => void}
        w.redraw_viewport?.()
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[webgpu] init failed — falling back to WebGL on next frame', err)
      })
  }
  return undefined
}

/**
 * `view3d.viewportDraw_intern`'s WebGPU sibling. Synchronous —
 * kicks the async device init on the first call and returns; the
 * frame draws on the second `redraw_viewport()` after init resolves.
 */
export function drawViewportWebGpu(view3d: ViewLike): void {
  if (!isWebGPU()) return
  const canvas = view3d.canvas
  if (!canvas) return

  const viewport = primeWebGpuViewport(canvas)
  if (!viewport) return

  // New frame: reset the per-draw uniform-buffer ring (see uniform_bindings).
  nextUniformFrameEpoch()

  if (view3d.activeCamera) viewport.ctx.drawmats = view3d.activeCamera

  const canvasTex = viewport.gpu.canvasContext.getCurrentTexture()
  // The canvas texture is sized to the full HTMLCanvasElement
  // (canvas.width × canvas.height), so the depth attachment MUST
  // match that, not the view3d region's glSize.
  const surfaceW = canvasTex.width
  const surfaceH = canvasTex.height
  viewport.ctx.size = [surfaceW, surfaceH]
  const depth = ensureDepth(viewport, surfaceW, surfaceH)

  const desc: GPURenderPassDescriptor = {
    label                 : 'view3d.canvasPass',
    colorAttachments: [
      {
        view      : canvasTex.createView(),
        clearValue: {r: 0.15, g: 0.15, b: 0.15, a: 1},
        loadOp    : 'clear',
        storeOp   : 'store',
      },
    ],
    depthStencilAttachment: {
      view           : depth.view,
      depthClearValue: 1.0,
      depthLoadOp    : 'clear',
      depthStoreOp   : 'store',
    },
  }

  viewport.ctx.beginFrame()
  try {
    viewport.ctx.renderStageDesc(desc, (pass) => {
      // Clip to the view3d region inside the full-canvas attachments.
      const x = clamp(view3d.glPos[0] | 0, 0, surfaceW)
      const y = clamp(view3d.glPos[1] | 0, 0, surfaceH)
      const w = clamp(view3d.glSize[0] | 0, 0, surfaceW - x)
      const h = clamp(view3d.glSize[1] | 0, 0, surfaceH - y)
      if (w > 0 && h > 0) {
        pass.setViewport(x, y, w, h, 0, 1)
        pass.setScissorRect(x, y, w, h)
      }
      drawSceneWebGpu(view3d)
    })

    // Mirror the WebGL `getFBODebug(gl).pushFBO('render_final', ...)`
    // call in renderengine_realtime.ts. No-op unless a DebugEditor sarea
    // is open. The encoder is still the active frame's encoder, so the
    // copy is submitted atomically with the canvas pass.
    if (viewport.ctx.encoder) {
      getWebGpuDebug(viewport.gpu.device).pushTexture('render_final', canvasTex, viewport.ctx.encoder)
    }
  } finally {
    viewport.ctx.endFrame()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Drive the scene-object draw chain plus a minimal set of overlays
 * inside the open WebGPU render pass.
 *
 * Each overlay is wrapped in its own try/catch so a failure in one
 * (say, an unported widget pipeline) doesn't kill the entire frame.
 */
function drawSceneWebGpu(view3d: ViewLike): void {
  // Leaving rendered mode (SHOW_RENDER/ONLY_RENDER off): each object either
  // gets the solid-mode *textured* draw shader (drawMode TEXTURED + an image
  // node in its material — see updateSolidTexturedDrawShader) or reverts to
  // the basic solid shader. The engine material WGSL must never leak into the
  // solid pass (it needs the engine's group1/2 bindings) — that was #1.
  const inRender = view3d.flag !== undefined && view3d.flag & (View3DFlags.SHOW_RENDER | View3DFlags.ONLY_RENDER)
  if (!inRender) {
    const scn = (view3d as ViewLike & {ctx?: {scene?: SceneLike}}).ctx?.scene
    const renderable = scn?.objects?.renderable
    if (renderable) {
      for (const ob of renderable) {
        try {
          updateSolidTexturedDrawShader(view3d, ob)
        } catch (err) {
          warnOnce('solidTexDrawShader', `${(err as Error).message}`)
        }
      }
    }
  }

  // Scene-object meshes — routes through createDrawQueue, which
  // returns the WebGPU adapter while currentPass is open.
  try {
    view3d.drawObjects?.()
  } catch (err) {
    warnOnce('drawObjects', `${(err as Error).message}`)
  }

  drawSceneWebGpuOverlays(view3d)
}

/** Duck-typed litemesh surface for the solid-textured draw-shader push. */
interface SolidTexDataLike extends DataLike {
  _hasMaterialDrawShader?: boolean
  _engineDrawShaderHash?: number
  _solidTexKey?: string
  solidTexUniforms?: Record<string, unknown>
  setDrawShader?: (wgsl: string) => void
  setRequestedAttrs?: (reqs: unknown[]) => void
  attrItems?: {attrName: string; use: number}[]
}

/** `AttrUseFlags.UV` (litemesh attr categories; duck-typed to avoid a
 * lite-mesh import cycle from this draw module). */
const ATTR_USE_UV = 4

/**
 * Per-object solid-mode textured draw (drawMode TEXTURED, the default): find
 * the material's active image node (graph.nodes order — node clicks
 * pushToFront, so index 0 of its type is the active one), and install a
 * basic-lit + texture draw shader on the litemesh, sampling the mesh's UV
 * layer when one exists. Reverts to the plain basic shader when the object
 * has no ready image (or a non-TEXTURED drawMode) — including the engine
 * material WGSL left over from render mode (#1).
 */
function updateSolidTexturedDrawShader(view3d: ViewLike, ob: SceneObjectLike): void {
  const d = ob.data as SolidTexDataLike | undefined
  if (!d || typeof d.setDrawShader !== 'function') {
    return
  }

  const device = viewports.get(view3d.canvas)?.gpu.device
  const drawMode = (ob as unknown as {drawMode?: number}).drawMode ?? DrawModes.TEXTURED

  // The active (first) image node with a ready image, if any.
  let image: unknown
  if (device && (drawMode & DrawModes.TEXTURED) !== 0) {
    const mat = d.materials && d.materials.length > 0 ? d.materials[0] : undefined
    const nodes = (mat as unknown as {graph?: {nodes?: Iterable<unknown>}} | undefined)?.graph?.nodes
    if (nodes) {
      for (const node of nodes) {
        if (node instanceof ImageNode) {
          const img = (node as unknown as {imageUser?: {image?: {ready?: boolean}}}).imageUser?.image
          if (img?.ready) {
            image = img
            break
          }
        }
      }
    }
  }

  const tex =
    image && device
      ? (image as unknown as {getGpuTex(dv: GPUDevice): {view: GPUTextureView} | undefined}).getGpuTex(device)
      : undefined

  if (!tex || !device) {
    // Nothing to texture — revert any installed draw shader (engine material
    // from render mode, or a stale solid-tex shader).
    if (d._hasMaterialDrawShader) {
      try {
        d.setDrawShader('')
        d._engineDrawShaderHash = undefined
      } catch (err) {
        warnOnce('revertDrawShader', `${(err as Error).message}`)
      }
    }
    d._solidTexKey = undefined
    d.solidTexUniforms = undefined
    return
  }

  const imageInfo = image as unknown as {lib_id: number; updateGen?: number}
  const uvItem = d.attrItems?.find((it) => (it.use & ATTR_USE_UV) !== 0)
  const key = `solidtex:${imageInfo.lib_id}:${imageInfo.updateGen ?? 0}:${uvItem?.attrName ?? ''}`
  if (d._solidTexKey !== key) {
    if (uvItem) {
      d.setRequestedAttrs?.([
        {
          name    : uvItem.attrName,
          category: ATTR_USE_UV,
          field   : 'attr_uv',
          wgslType: 'vec2f',
          gpuType : 2,
          elemSize: 2,
          slot    : 2,
        },
      ])
    } else {
      d.setRequestedAttrs?.([])
    }
    d.setDrawShader(buildSolidTexturedWgsl(!!uvItem))
    d._solidTexKey = key
    // Force the engine to re-push its material WGSL when render mode returns.
    d._engineDrawShaderHash = undefined
  }
  // Re-seed every frame: the view identity changes when the image regenerates.
  d.solidTexUniforms = {solidtex_tex: tex.view, solidtex_smp: sharedLinearSampler(device)}
}

function drawSceneWebGpuOverlays(view3d: ViewLike): void {
  drawGridWebGpu(view3d)
  drawDrawLinesWebGpu(view3d)

  // Toolmode overlays — most call SimpleMesh.draw / SimpleMesh.drawLines,
  // which route through createDrawQueue on WebGPU. The legacy
  // gl.enable/depthMask/blendFunc bookkeeping inside on_drawstart/end
  // hits the permissive stub which no-ops it.
  const scene = (view3d as ViewLike & {ctx?: {scene?: SceneLike}}).ctx?.scene
  if (scene?.toolmode) {
    try {
      scene.toolmode.on_drawstart?.(view3d)
    } catch (err) {
      warnOnce('toolmode.on_drawstart', `${(err as Error).message}`)
    }
  }

  // Widgets — `WidgetShape.draw` calls `this.mesh.draw(gl)` which
  // SimpleMesh routes through the queue on WebGPU.
  try {
    view3d.widgets?.draw?.(view3d, view3d.gl as WebGL2RenderingContext)
  } catch (err) {
    warnOnce('widgets', `${(err as Error).message}`)
  }

  if (scene?.toolmode) {
    try {
      scene.toolmode.on_drawend?.(view3d)
    } catch (err) {
      warnOnce('toolmode.on_drawend', `${(err as Error).message}`)
    }
  }

  // MVP shader-network path — when SHOW_RENDER / ONLY_RENDER is set,
  // compile per-material WGSL and re-issue the scene-object draws with
  // the material's pipeline. No AO / accumulation / offscreen passes
  // yet (TODO: rebuild the pass graph through WebGpuRenderGraph once
  // each WGSL pass sibling lands).
  if (view3d.flag !== undefined && view3d.flag & (View3DFlags.SHOW_RENDER | View3DFlags.ONLY_RENDER)) {
    drawRenderWebGpu(view3d)
  }
}

/**
 * MVP replacement for `View3D.drawRender` on the WebGPU backend.
 *
 * Walks `scene.objects.renderable`, compiles each object's first
 * material to WGSL via `Material.generateWgsl`, registers the resulting
 * `Pipeline` in `frame.pipelineBindings` keyed by a per-material
 * identity object, then issues `ob.draw(view3d, gl, uniforms, prog)`
 * which routes through `createDrawQueue` → `WebGPUDrawQueueAdapter`
 * and resolves the right pipeline.
 *
 * Scope vs. the WebGL `RealtimeEngine.render_intern`:
 *   - No AO / Accum / Output / NormalPass offscreen FBOs (the MVP draws
 *     straight to the canvas).
 *   - Lights are pulled directly off `scene.objects.lights` — no
 *     `RenderLight` wrapper or shadow render, just an empty map so the
 *     shader-network compile falls back to its ambient term.
 *   - Material hash diff is honored so we only recompile when the graph
 *     or a uniform changes.
 */
interface MaterialWebGpuState {
  // Per-material identity object used as the `program` arg threaded
  // through `ob.draw` and looked up in `frame.pipelineBindings`.
  program: {uniforms: IUniformsBlock; name: string; wgslKey?: undefined}
  pipeline: Pipeline
  hash: number
  /** What this material's `AttributeNode` reads asked the geometry to bind. */
  requestedAttrs: MaterialAttrRequest[]
  /** Seeds `sampler_<id>_tex/_smp` views per frame (image nodes). */
  setTextureUniforms?: (device: GPUDevice, uniforms: Record<string, unknown>) => void
}

const materialStates = new WeakMap<object, MaterialWebGpuState>()
/** Last material hash whose requested-attr set was pushed to a given geometry. */
const pushedAttrHash = new WeakMap<object, number>()
const loggedMaterialWgsl = new Set<number>()

function ensureMaterialPipeline(
  wgpu: WebGpuRenderContext,
  scene: SceneLike,
  mat: MaterialLike,
  rlights: IRenderLights
): MaterialWebGpuState | undefined {
  // Include the light-count fingerprint so adding/removing a light
  // triggers a recompile — the WGSL embeds `MAXPLIGHT`/`MAXSLIGHT` as
  // baked-in literals (the preprocessor substitutes after #ifdef
  // expansion), so the same material with a different light count
  // produces a different pipeline.
  let lightHash = 0
  for (const k in rlights) lightHash = (lightHash * 31 + rlights[k].light.data.type) | 0
  const hash = ((mat.calcUpdateHash?.() ?? 0) * 1009 + lightHash) | 0
  const existing = materialStates.get(mat)
  if (existing?.hash === hash && !mat._regen) {
    return existing
  }

  let def
  try {
    def = mat.generateWgsl(scene, rlights)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[webgpu] mat-${mat.lib_id} generateWgsl failed:`, err)
    return undefined
  }

  if (!loggedMaterialWgsl.has(mat.lib_id)) {
    loggedMaterialWgsl.add(mat.lib_id)
    // eslint-disable-next-line no-console
    console.log(`[webgpu] mat-${mat.lib_id} WGSL:\n${def.wgsl}`)
  }

  const desc = buildMaterialPipelineDescriptor(
    def.wgsl,
    `material-${mat.lib_id}`,
    buildMaterialVertexLayout(def.requestedAttrs)
  )
  const interchangeable = new Set<GPUTextureFormat>(['bgra8unorm', 'rgba8unorm'])
  desc.colorTargets = desc.colorTargets.map((t) =>
    interchangeable.has(t.format) ? {...t, format: wgpu.surfaceFormat} : t
  )

  let pipeline: Pipeline
  try {
    // Capture WGSL compilation + pipeline validation errors. WebGPU
    // surfaces them asynchronously through error scopes; without this
    // they only show up as `uncapturederror` toasts with no link to
    // which material was being built.
    wgpu.device.pushErrorScope('validation')
    pipeline = wgpu.pipelineCache.get(desc)
    void wgpu.device.popErrorScope().then((err) => {
      // eslint-disable-next-line no-console
      if (err) console.error(`[webgpu] mat-${mat.lib_id} pipeline validation error:`, err.message)
    })
    void pipeline.module.getCompilationInfo().then((info) => {
      const bad = info.messages.filter((m) => m.type === 'error' || m.type === 'warning')
      if (bad.length > 0) {
        // eslint-disable-next-line no-console
        console.group(`[webgpu] mat-${mat.lib_id} WGSL compilation messages`)
        for (const m of bad) {
          console[m.type === 'error' ? 'error' : 'warn'](`${m.type} at L${m.lineNum}:${m.linePos}: ${m.message}`)
        }
        // eslint-disable-next-line no-console
        console.groupEnd()
      }
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[webgpu] mat-${mat.lib_id} pipeline compile threw:`, err)
    return undefined
  }

  const program = existing?.program ?? {uniforms: {} as IUniformsBlock, name: `webgpu-mat-${mat.lib_id}`}
  def.setUniforms(mat.graph, program.uniforms as unknown as Record<string, unknown>)
  // Per-light uniforms (POINTLIGHTS[i].co, .power, ...) — packed into
  // the same uniforms block; `UniformBindings.write` parses the flat
  // array keys via `ArrayedStructWriter` when the slot type is
  // `array<Struct, N>`.
  LightGenWgsl.setUniforms(program.uniforms as unknown as Record<string, unknown>, scene, rlights)
  wgpu.pipelineBindings.set(program, pipeline)

  const gen = (def as {generator?: {setTextureUniforms(d: GPUDevice, u: Record<string, unknown>): void}}).generator
  const state: MaterialWebGpuState = {
    program,
    pipeline,
    hash,
    requestedAttrs    : def.requestedAttrs ?? [],
    setTextureUniforms: gen ? (device, u) => gen.setTextureUniforms(device, u) : undefined,
  }
  materialStates.set(mat, state)
  return state
}

function drawRenderWebGpu(view3d: ViewLike): void {
  const ctx = (view3d as ViewLike & {ctx?: {scene?: SceneLike}}).ctx
  const scene = ctx?.scene
  if (!scene) {
    warnOnce('drawRenderWebGpu.scene', 'no scene on view3d.ctx — skipping render pass')
    return
  }

  const viewport = viewports.get(view3d.canvas)
  if (!viewport) return
  const wgpu = viewport.ctx

  const camera = view3d.activeCamera
  const uniforms: IUniformsBlock = {
    projectionMatrix: camera.rendermat,
    normalMatrix    : camera.normalmat,
    viewportSize    : view3d.glSize,
    ambientColor    : scene.envlight?.color,
    ambientPower    : scene.envlight?.power ?? 1.0,
    uSample         : 1,
    near            : camera.near,
    far             : camera.far,
    aspect          : camera.aspect,
    size            : view3d.glSize,
    polygonOffset   : 0.0,
    objectMatrix    : new Matrix4(),
    object_id       : 0,
  } as unknown as IUniformsBlock

  const renderable = scene.objects?.renderable
  if (!renderable) return

  // Build a minimal IRenderLights map from scene.lights. We skip the
  // full RenderLight wrappers (shadow maps + hash digests) — the
  // material WGSL path only reads `.light` to pull the underlying
  // SceneObject<Light>.
  const rlights: IRenderLights = {}
  const sceneLights = scene.lights
  if (sceneLights) {
    let lid = 0
    for (const light of sceneLights) {
      // Cast is intentional: we only populate the `.light` slot — the
      // other RenderLight fields (shadowmap, _digest, co, seed) are
      // unused by the WGSL light-uniform path.
      rlights[lid++] = {light} as unknown as IRenderLights[string]
    }
  }

  let nTotal = 0
  let nUsesMat = 0
  let nWithMat = 0
  let nDrawn = 0
  for (const ob of renderable) {
    nTotal++
    const data = ob.data as DataLike | undefined
    if (!data?.usesMaterial) continue
    nUsesMat++
    const mats = data.materials
    const mat = mats && mats.length > 0 ? mats[0] : undefined
    if (!mat) continue
    nWithMat++

    const state = ensureMaterialPipeline(wgpu, scene, mat, rlights)
    if (!state) continue

    // Hand the geometry the attributes this material reads by name, so it
    // binds them at the slots the pipeline above declares (geometry-contract
    // §10.2). Re-pushed only when the compiled set can have changed.
    // Sculptcore-tree providers are skipped: they render with their own
    // installed shader, which this path never compiles for them.
    const treeDrawn = typeof (data as SolidTexDataLike).setDrawShader === 'function'
    const consumer = treeDrawn ? undefined : asMaterialAttrConsumer(data)
    if (consumer && pushedAttrHash.get(data) !== state.hash) {
      pushedAttrHash.set(data, state.hash)
      try {
        consumer.setRequestedAttrs(state.requestedAttrs)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[webgpu] mat-${mat.lib_id} requested-attr push threw:`, err)
      }
    }

    // Image-node textures: re-seed views/samplers per frame (view identity
    // changes when an image regenerates).
    state.setTextureUniforms?.(wgpu.device, state.program.uniforms as unknown as Record<string, unknown>)

    try {
      ob.draw(view3d, view3d.gl as WebGL2RenderingContext, uniforms, state.program as unknown as ShaderProgram)
      nDrawn++
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[webgpu] drawRender ob ${ob.lib_id} ob.draw threw:`, err)
    }
  }

  if (!loggedRenderSummary) {
    loggedRenderSummary = true
    // eslint-disable-next-line no-console
    console.log(
      `[webgpu] drawRenderWebGpu: ${nTotal} total, ${nUsesMat} usesMaterial, ${nWithMat} with material slot, ${nDrawn} drawn`
    )
  }
}
let loggedRenderSummary = false

export function drawGridWebGpu(view3d: ViewLike): void {
  if (!view3d.grid) return
  if (view3d.flag === undefined || !(view3d.flag & View3DFlags.SHOW_GRID)) return

  const program = view3d_shaders.Shaders.BasicLineShader
  if (!program) {
    warnOnce('grid', 'view3d_shaders.Shaders.BasicLineShader not initialized')
    return
  }

  try {
    const uniforms: IUniformsBlock = {
      ...sharedUniforms(view3d),
      objectMatrix : new Matrix4(),
      polygonOffset: 0.0,
      alpha        : 1.0,
    } as unknown as IUniformsBlock
    submitMeshWebGpu(view3d, view3d.grid, program, uniforms)
  } catch (err) {
    warnOnce('grid', `${(err as Error).message}`)
  }
}

export function drawDrawLinesWebGpu(view3d: ViewLike): void {
  const drawlines = view3d.drawlines
  if (!drawlines || drawlines.length === 0) return

  const program = view3d_shaders.Shaders.BasicLineShader
  if (!program) {
    warnOnce('drawDrawLines', 'view3d_shaders.Shaders.BasicLineShader not initialized')
    return
  }

  try {
    const sm = new SimpleMesh(LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.UV)
    const sm2 = new SimpleMesh(LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.UV)
    for (let i = 0; i < drawlines.length; i++) {
      const dl = drawlines[i] as DrawLineLike
      const line = (dl.useZ ? sm : sm2).line(dl.v1, dl.v2)
      line.uvs(new Vector2([0, 0]), new Vector2([1, 1]))
      line.colors(dl.color, dl.color)
    }
    const uniforms: IUniformsBlock = {
      ...sharedUniforms(view3d),
      objectMatrix : new Matrix4(),
      polygonOffset: 2.5,
      alpha        : 1.0,
    } as unknown as IUniformsBlock
    submitMeshWebGpu(view3d, sm2 as unknown as SimpleMesh, program, uniforms)
    submitMeshWebGpu(view3d, sm as unknown as SimpleMesh, program, uniforms)
    // Don't sm.destroy(gl) — gl is the throwing Proxy. The buffers
    // are short-lived; GpuBuffers get GC'd along with the SimpleMesh.
  } catch (err) {
    warnOnce('drawDrawLines', `${(err as Error).message}`)
  }
}

/**
 * Submit a SimpleMesh-like through createDrawQueue. The WebGPU adapter
 * resolves `program.wgslKey` against the WGSL shader registry, then
 * calls `mesh.drawGPU(pass, pipeline, uniforms)` after uploading any
 * pending vertex buffers via `_uploadGpuBuffers`.
 */
function submitMeshWebGpu(view3d: ViewLike, mesh: SimpleMesh, program: ShaderProgram, uniforms: IUniformsBlock): void {
  const frame: FrameContext = {gl: view3d.gl as WebGL2RenderingContext, uniforms, program}
  const queue = createDrawQueue(frame)
  queue.submit({pipeline: program, mesh, uniforms})
}

function sharedUniforms(view3d: ViewLike): IUniformsBlock {
  const cam = view3d.activeCamera
  return {
    projectionMatrix: cam.rendermat,
    normalMatrix    : cam.normalmat,
    near            : cam.near,
    far             : cam.far,
    aspect          : cam.aspect,
    size            : view3d.glSize,
    polygonOffset   : 0.0,
    object_id       : 0,
  } as unknown as IUniformsBlock
}

// Minimal structural type — we don't import View3D to avoid pulling
// the whole editor module graph into the WebGPU module.
// Structural view3d shape consumed by the WebGPU draw helpers. Exported so
// View3D can satisfy it without `as unknown as Parameters<typeof …>` casts
// at the callsites in view3d.ts.
export interface ViewLike {
  canvas: HTMLCanvasElement | OffscreenCanvas
  activeCamera: DrawMatsCamera
  glSize: ArrayLike<number>
  glPos: ArrayLike<number>
  size: ArrayLike<number>
  gl: unknown
  flag?: number
  grid?: SimpleMesh
  drawlines?: ArrayLike<DrawLineLike>
  drawObjects?: () => void
  widgets?: {draw?: (view3d: ViewLike, gl: WebGL2RenderingContext) => void}
}

interface SceneLike {
  toolmode?: {
    on_drawstart?: (view3d: ViewLike) => void
    on_drawend?: (view3d: ViewLike) => void
  }
  envlight?: {color?: unknown; power?: number}
  objects?: {renderable: Iterable<SceneObjectLike>}
  lights?: Iterable<unknown>
}

interface SceneObjectLike {
  lib_id: number
  data?: DataLike
  draw: (view3d: ViewLike, gl: WebGL2RenderingContext, uniforms: IUniformsBlock, program: ShaderProgram) => void
}

interface DataLike {
  usesMaterial?: boolean
  materials?: ArrayLike<MaterialLike | undefined>
}

interface MaterialLike {
  lib_id: number
  graph: Parameters<
    typeof import('../../shadernodes/shader_nodes_wgsl.js').WgslShaderGenerator.prototype.setMaterialUniforms
  >[0]
  _regen?: number | boolean
  calcUpdateHash?: () => number
  generateWgsl: (
    scene: unknown,
    rlights: IRenderLights
  ) => {
    wgsl: string
    setUniforms: (graph: unknown, uniforms: Record<string, unknown>) => void
    requestedAttrs?: MaterialVertexAttr[]
  }
}

interface DrawMatsCamera extends DrawMats {
  rendermat: Matrix4
  normalmat: Matrix4
  near: number
  far: number
  aspect: number
}

interface DrawLineLike {
  v1: Vector3
  v2: Vector3
  color: Vector4
  useZ: boolean
}

/**
 * Replacement for `window._gl` when the app boots in WebGPU mode.
 *
 * WebGPU encodes pixel-pipeline state (blend, depth, viewport, clear
 * color, polygon offset, ...) into the pipeline + render-pass
 * descriptors rather than via per-call gl.enable/gl.depthMask/etc, so
 * the imperative GL state-setting calls have no per-frame WebGPU
 * equivalent. The stub silently no-ops those — they're dead writes,
 * not failures.
 *
 * Actual GPU work (draws, buffer uploads, texture creation, shader
 * compiles) still throws so a stray legacy code path surfaces at the
 * exact line that needed an `isWebGPU()` guard.
 */

// WebGL state-management methods that have no per-call WebGPU
// equivalent (handled by pipeline state / pass descriptor instead).
// These are SILENT NO-OPS on the stub — legacy code that calls them
// is harmless.
const SILENT_NOOP_METHODS = new Set([
  'enable',
  'disable',
  'isEnabled',
  'depthMask',
  'depthFunc',
  'depthRange',
  'blendFunc',
  'blendFuncSeparate',
  'blendEquation',
  'blendEquationSeparate',
  'blendColor',
  'colorMask',
  'stencilMask',
  'stencilFunc',
  'stencilFuncSeparate',
  'stencilOp',
  'stencilOpSeparate',
  'cullFace',
  'frontFace',
  'lineWidth',
  'polygonOffset',
  'scissor',
  'viewport',
  'clearColor',
  'clearDepth',
  'clearStencil',
  'clear',
  'pixelStorei',
  'hint',
  'activeTexture',
  'bindTexture',
  'bindFramebuffer',
  'bindRenderbuffer',
  'bindBuffer',
  'bindBufferBase',
  'bindBufferRange',
  'bindVertexArray',
  'bindSampler',
  'useProgram',
  'flush',
  'finish',
  'getError',
  'disableVertexAttribArray',
  'enableVertexAttribArray',
  'uniform1i',
  'uniform1f',
  'uniform2f',
  'uniform2fv',
  'uniform2i',
  'uniform2iv',
  'uniform3f',
  'uniform3fv',
  'uniform3i',
  'uniform3iv',
  'uniform4f',
  'uniform4fv',
  'uniform4i',
  'uniform4iv',
  'uniform1iv',
  'uniform1fv',
  'uniformMatrix2fv',
  'uniformMatrix3fv',
  'uniformMatrix4fv',
  'vertexAttribPointer',
  'vertexAttribIPointer',
  'vertexAttribDivisor',
  'sampleCoverage',
])

// Methods whose return value the caller probably reads — give them
// something innocuous instead of a throw. (E.g. getParameter is used
// for capability detection.)
const SAFE_GETTER_METHODS = new Set([
  'getParameter',
  'getExtension',
  'getSupportedExtensions',
  'getContextAttributes',
  'getUniformLocation',
  'getAttribLocation',
])

const noop = () => undefined

/**
 * Per-name access counter for stub members. Opt-in: enable from devtools
 * via `window.__webgpuStubAudit = true` then run the app for a session
 * and read `window.__webgpuStubAuditCounts` to see which
 * `SILENT_NOOP_METHODS` / `SAFE_GETTER_METHODS` / enum entries are
 * still live. Zero-count entries are candidates for removal — moving
 * them out of the no-op set causes a clear runtime error if any caller
 * actually depended on them.
 */
const stubAuditCounts = new Map<string, number>()
function bumpAudit(name: string): void {
  const w = globalThis as unknown as {__webgpuStubAudit?: boolean; __webgpuStubAuditCounts?: Map<string, number>}
  if (!w.__webgpuStubAudit) return
  stubAuditCounts.set(name, (stubAuditCounts.get(name) ?? 0) + 1)
  w.__webgpuStubAuditCounts = stubAuditCounts
}

export function makeWebGpuGlStub(canvas: HTMLCanvasElement | OffscreenCanvas): WebGL2RenderingContext {
  const target = {canvas} as {canvas: typeof canvas}
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop === 'canvas') return t.canvas
      if (typeof prop === 'symbol') return undefined
      const name = prop as string
      if (SILENT_NOOP_METHODS.has(name)) {
        bumpAudit(name)
        return noop
      }
      if (SAFE_GETTER_METHODS.has(name)) {
        bumpAudit(name)
        // Return a function that gives `null` for any lookup (which is
        // exactly what WebGL returns for missing uniforms/attribs/extensions).
        return () => null
      }
      // WebGL enum constants are all-caps. Return a placeholder number so
      // legacy code can read e.g. `gl.DEPTH_TEST` without crashing.
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
        bumpAudit(name)
        return 0
      }
      throw new Error(
        `[webgpu] WebGL property "${name}" accessed on WebGPU stub — ` +
          `this code path needs an isWebGPU() guard (or, if it's harmless ` +
          `state, add it to SILENT_NOOP_METHODS in view3d_draw_webgpu.ts).`
      )
    },
  }) as unknown as WebGL2RenderingContext
  return proxy
}
