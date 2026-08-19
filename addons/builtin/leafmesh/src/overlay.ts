/**
 * The framework-facing half of the selection overlay — P12 step 2.
 *
 * `overlay_geom.ts` decides *what* to draw; this file only turns those arrays
 * into `SimpleMesh` batches and hands them to `MeshEditShader`. Everything it
 * needs is already on the hub, so LeafMesh gets a viewport overlay without a
 * single line under `scripts/` (P12 §2).
 */

import type {IUniformsBlock, SceneObject, View3D} from '@framework/api'
import {LayerTypes, Matrix4, PrimitiveTypes, Shaders, SimpleMesh, Vector3, Vector4} from '@framework/api'

import type {LeafMeshData} from './leafmesh.js'
import {buildSelectionOverlay, overlayCacheKey} from './overlay_geom.js'
import type {OverlayBatch, OverlayGeometry, OverlayRequest} from './overlay_geom.js'

/**
 * `MeshEditShader` tints any vertex whose id equals `active_id` /
 * `highlight_id` / `last_id`, and `SimpleIsland` fills unset ids with `-1` —
 * so `-1` is exactly the wrong sentinel. Colours are already baked per vertex
 * by `overlay_geom.ts`; this switches the shader's own tinting off.
 */
const NO_ID = -2

/** Overlay lines and points are drawn opaque; a face fill carries its own alpha. */
const OVERLAY_ALPHA = 1.0

const DEFAULT_POINT_SIZE = 6.0

function buildBatch(batch: OverlayBatch, primflag: PrimitiveTypes): SimpleMesh | undefined {
  if (batch.count === 0) {
    return undefined
  }

  const sm = new SimpleMesh(LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.ID)
  sm.primflag = primflag

  const co = batch.co
  const color = batch.color
  const p = new Vector3()
  const q = new Vector3()
  const r = new Vector3()
  const c1 = new Vector4()
  const c2 = new Vector4()
  const c3 = new Vector4()

  const load = (dst: Vector3, i: number): Vector3 => {
    dst[0] = co[i * 3]
    dst[1] = co[i * 3 + 1]
    dst[2] = co[i * 3 + 2]
    return dst
  }
  const loadColor = (dst: Vector4, i: number): Vector4 => {
    dst[0] = color[i * 4]
    dst[1] = color[i * 4 + 1]
    dst[2] = color[i * 4 + 2]
    dst[3] = color[i * 4 + 3]
    return dst
  }

  if (primflag === PrimitiveTypes.POINTS) {
    for (let i = 0; i < batch.count; i++) {
      sm.point(load(p, i)).colors(loadColor(c1, i))
    }
  } else if (primflag === PrimitiveTypes.LINES) {
    for (let i = 0; i + 1 < batch.count; i += 2) {
      sm.line(load(p, i), load(q, i + 1)).colors(loadColor(c1, i), loadColor(c2, i + 1))
    }
  } else {
    for (let i = 0; i + 2 < batch.count; i += 3) {
      sm.tri(load(p, i), load(q, i + 1), load(r, i + 2)).colors(
        loadColor(c1, i),
        loadColor(c2, i + 1),
        loadColor(c3, i + 2)
      )
    }
  }

  return sm
}

/**
 * The three `SimpleMesh` batches for one `LeafMeshData`, rebuilt only when
 * {@link overlayCacheKey} changes.
 */
export class LeafMeshOverlay {
  private key = ''
  private points?: SimpleMesh
  private lines?: SimpleMesh
  private tris?: SimpleMesh

  /** Rebuild if anything the geometry depends on has moved. */
  update(data: LeafMeshData, req: OverlayRequest): void {
    const key = overlayCacheKey(data.updateGen ?? 0, req)
    if (key === this.key) {
      return
    }
    this.key = key

    const geom: OverlayGeometry = buildSelectionOverlay(data.mesh, req, data.triCache)
    this.dispose()
    this.points = buildBatch(geom.points, PrimitiveTypes.POINTS)
    this.lines = buildBatch(geom.lines, PrimitiveTypes.LINES)
    this.tris = buildBatch(geom.tris, PrimitiveTypes.TRIS)
  }

  /**
   * Fills last so the wires and points sit over their own tint — every WGSL
   * pipeline is depth-tested and the batches are lifted apart geometrically,
   * but submission order still decides ties.
   */
  draw(gl: WebGL2RenderingContext, uniforms: IUniformsBlock): void {
    const program = Shaders.MeshEditShader
    if (program === undefined) {
      return
    }

    for (const sm of [this.tris, this.lines, this.points]) {
      sm?.draw(gl, uniforms, program)
    }
  }

  dispose(): void {
    // No `destroy(gl)`: on WebGPU `gl` is a throwing Proxy, and the GpuBuffers
    // are collected with the SimpleMesh.
    this.points = undefined
    this.lines = undefined
    this.tris = undefined
  }
}

const OVERLAYS = new WeakMap<LeafMeshData, LeafMeshOverlay>()

function overlayFor(data: LeafMeshData): LeafMeshOverlay {
  let overlay = OVERLAYS.get(data)
  if (overlay === undefined) {
    overlay = new LeafMeshOverlay()
    OVERLAYS.set(data, overlay)
  }
  return overlay
}

export interface DrawOverlayOptions {
  pointSize?: number
}

/**
 * Draw `object`'s selection overlay into the open pass. Call from a toolmode's
 * `on_drawend` — that hook runs inside both the solid pass and the render-mode
 * overlay pass, whereas `drawQ` is skipped for renderables in render mode.
 */
export function drawLeafMeshOverlay(
  view3d: View3D,
  object: SceneObject,
  data: LeafMeshData,
  req: OverlayRequest,
  opts: DrawOverlayOptions = {}
): void {
  const overlay = overlayFor(data)
  overlay.update(data, req)

  const cam = view3d.activeCamera
  const uniforms = {
    projectionMatrix: cam.rendermat,
    normalMatrix    : cam.cameramat,
    objectMatrix    : new Matrix4(object.outputs.matrix.getValue()),
    size            : view3d.glSize,
    aspect          : cam.aspect,
    near            : cam.near,
    far             : cam.far,
    alpha           : OVERLAY_ALPHA,
    pointSize       : opts.pointSize ?? DEFAULT_POINT_SIZE,
    active_id       : NO_ID,
    highlight_id    : NO_ID,
    last_id         : NO_ID,
  } as unknown as IUniformsBlock

  overlay.draw(view3d.gl as WebGL2RenderingContext, uniforms)
}

/** Drop an object's cached batches — the toolmode does this on deactivation. */
export function releaseLeafMeshOverlay(data: LeafMeshData): void {
  OVERLAYS.get(data)?.dispose()
  OVERLAYS.delete(data)
}
