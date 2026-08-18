/**
 * The host-facing half of LeafMesh drawing — P11 step 4.
 *
 * LeafMesh brings its own {@link Drawable} rather than filling a `SimpleMesh`,
 * for one reason: `SimpleIsland` binds a fixed buffer per layer *type* (uv at
 * slot 2, colour at 3), and a material's `AttributeNode` reads start at slot 2
 * as well. That collision is the first entry under
 * documentation/geometry-contract.md §11, and binding requested attributes by
 * name at the slot the shader generator assigned is the whole of the fix.
 *
 * Geometry is unshared triangle corners (see `draw_buffers.ts`) uploaded once
 * per invalidation; a static mesh uploads on its first frame and never again.
 */

import type {Drawable, IUniformsBlock, ShaderProgram, VertexAttrDesc} from '@framework/api'
import {BufferUsage, MATERIAL_BASE_VERTEX_ATTRS} from '@framework/api'

import {buildDrawGeometry, gatherDrawAttr} from './draw_buffers.js'
import type {DrawGeometry} from './draw_buffers.js'
import {LeafMesh} from './topo.js'
import type {Tri} from './triangulate.js'
import {TriangulationCache} from './triangulate.js'

/**
 * One attribute a compiled material asks the geometry for, at the slot its
 * generated `VsIn` declares. Structurally the subset of the host's
 * `RequestedAttrDesc` a provider actually needs — a nominal import would drag
 * the shader-node layer into the addon for three fields.
 */
export interface RequestedDrawAttr {
  name: string
  slot: number
  elemSize: number
}

/**
 * What LeafMesh always binds, whatever the material: the base vertex interface
 * and nothing else. Everything past slot 1 follows the material, so it cannot
 * be declared here — see documentation/geometry-contract.md §10.2.
 */
export const LEAFMESH_VERTEX_ATTRS: readonly VertexAttrDesc[] = MATERIAL_BASE_VERTEX_ATTRS

/** Every live face's triangles, through the per-face memo. */
function collectTris(mesh: LeafMesh, cache: TriangulationCache): Tri[] {
  const out: Tri[] = []
  for (const f of mesh.f) {
    for (const tri of cache.get(mesh, f)) {
      out.push(tri)
    }
  }
  return out
}

interface SlotBuffer {
  data: Float32Array
  gpu?: GPUBuffer
  /** Bytes actually uploaded, so a shrink re-writes rather than under-fills. */
  uploaded: number
}

export class LeafMeshDrawable implements Drawable {
  private readonly mesh: LeafMesh
  private readonly cache: TriangulationCache
  private readonly slots = new Map<number, SlotBuffer>()

  private geom?: DrawGeometry
  private tris: Tri[] = []
  private requested: readonly RequestedDrawAttr[] = []
  private dirty = true
  private device?: GPUDevice
  private warnedWebGL = false

  constructor(mesh: LeafMesh, cache: TriangulationCache) {
    this.mesh = mesh
    this.cache = cache
  }

  get triCount(): number {
    return this.geom?.triCount ?? 0
  }

  /** Drop the CPU arrays; the GPU buffers are reused if the size still fits. */
  invalidate(): void {
    this.dirty = true
  }

  /**
   * Install the attribute set the compiled material asks for. A no-op when the
   * set is unchanged, so the per-frame push from the render engine does not
   * re-gather every attribute of every mesh.
   */
  setRequestedAttrs(reqs: readonly RequestedDrawAttr[]): void {
    if (this.requested.length === reqs.length) {
      let same = true
      for (let i = 0; i < reqs.length; i++) {
        const a = this.requested[i]
        const b = reqs[i]
        if (a.name !== b.name || a.slot !== b.slot || a.elemSize !== b.elemSize) {
          same = false
          break
        }
      }
      if (same) {
        return
      }
    }

    this.requested = reqs.map((r) => ({name: r.name, slot: r.slot, elemSize: r.elemSize}))
    this.dirty = true
  }

  /** Attribute names the material asked for that this mesh has no layer for. */
  missingAttrs(): string[] {
    if (this.dirty) {
      this.rebuild()
    }
    return this.requested.filter((r) => !this.slots.has(r.slot)).map((r) => r.name)
  }

  private rebuild(): void {
    this.dirty = false
    this.tris = collectTris(this.mesh, this.cache)
    this.geom = buildDrawGeometry(this.mesh, this.tris)
    this.slots.clear()

    this.setSlot(0, this.geom.position)
    this.setSlot(1, this.geom.normal)

    for (const req of this.requested) {
      if (req.slot < MATERIAL_BASE_VERTEX_ATTRS.length) {
        continue
      }
      const data = gatherDrawAttr(this.mesh, this.tris, req.name, req.elemSize)
      if (data !== undefined) {
        this.setSlot(req.slot, data)
      }
    }
  }

  private setSlot(slot: number, data: Float32Array): void {
    this.slots.set(slot, {data, uploaded: -1})
  }

  /**
   * Called by the WebGPU draw adapter before `drawGPU`, and the only place a
   * provider is handed the device — hence the underscore, which is the
   * adapter's name for the hook, not ours.
   */
  _uploadGpuBuffers(device: GPUDevice): void {
    if (this.device !== device) {
      // A device change invalidates every buffer handle we hold.
      for (const slot of this.slots.values()) {
        slot.gpu = undefined
        slot.uploaded = -1
      }
      this.device = device
    }
    if (this.dirty) {
      this.rebuild()
    }

    for (const [slot, buf] of this.slots) {
      const bytes = buf.data.byteLength
      if (bytes === 0) {
        continue
      }
      if (buf.gpu === undefined || buf.gpu.size < bytes) {
        buf.gpu?.destroy()
        buf.gpu = device.createBuffer({
          label: `LeafMeshDrawable.slot${slot}`,
          size : (bytes + 3) & ~3,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        })
        buf.uploaded = -1
      }
      if (buf.uploaded !== bytes) {
        device.queue.writeBuffer(buf.gpu, 0, buf.data.buffer, buf.data.byteOffset, bytes)
        buf.uploaded = bytes
      }
    }
  }

  drawGPU(pass: GPURenderPassEncoder, _pipeline: GPURenderPipeline, _uniforms: IUniformsBlock): void {
    if (this.dirty || this.geom === undefined) {
      // Reached only if the adapter skipped `_uploadGpuBuffers`; without a
      // device there is nothing to bind, so drawing nothing is the honest
      // outcome rather than a validation error.
      return
    }

    for (const [slot, buf] of this.slots) {
      if (buf.gpu !== undefined) {
        pass.setVertexBuffer(slot, buf.gpu)
      }
    }

    if (this.geom.triCount > 0) {
      pass.draw(this.geom.triCount * 3, 1, 0, 0)
    }
  }

  draw(_gl: WebGL2RenderingContext, _uniforms: IUniformsBlock, _program: ShaderProgram): void {
    // The realtime renderer is WebGPU-only; the WebGL queue adapter is reached
    // only when WebGPU failed to come up, and a warning beats an exception
    // storm on every object of every frame.
    if (!this.warnedWebGL) {
      this.warnedWebGL = true
      console.warn('leafmesh: the WebGL draw path is not implemented — LeafMesh renders on WebGPU only.')
    }
  }

  dispose(): void {
    for (const buf of this.slots.values()) {
      buf.gpu?.destroy()
    }
    this.slots.clear()
    this.geom = undefined
    this.tris = []
    this.dirty = true
  }
}
