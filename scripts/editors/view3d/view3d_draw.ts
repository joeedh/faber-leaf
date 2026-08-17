import {Vector3} from '../../util/vectormath.js'
import {Mesh, MeshFlags, MeshTypes} from '../../../addons/builtin/mesh/src/mesh.js'
import {LayerTypes} from '../../webgl/simplemesh.js'
import {SelMask} from '../../core/select_types.js'
import {Shaders} from '../../shaders/shaders.js'
import {View3DFlags} from './view3d_base.js'
import type {View3D} from './view3d.js'
import type {SceneObject} from '../../sceneobject/sceneobject.js'
import type {Element} from '../../../addons/builtin/mesh/src/mesh_types.js'
import type {ShaderProgram as RealShaderProgram} from '../../webgl/webgl.js'
import {FrameContext} from '../../render/queue'
import {createDrawQueue} from '../../render/queue_factory.js'

declare global {
  interface Window {
    _Colors: typeof Colors
  }
}

//TODO: get rid of this file

export const Colors = {
  DRAW_DEBUG    : [0, 1.0, 0.5, 1.0],
  SELECT        : [1.0, 0.8, 0.4, 1.0],
  UNSELECT      : [1.0, 0.2, 0.0, 1.0],
  ACTIVE        : [0.3, 1.0, 0.3, 1.0],
  LAST          : [0.0, 0.3, 1.0, 1.0],
  HIGHLIGHT     : [1.0, 1.0, 0.3, 1.0],
  POINTSIZE     : 7,
  POLYGON_OFFSET: 1.0,
  FACE_UNSEL    : [0.75, 0.75, 0.75, 0.3],
  DRAW_DEBUG2   : [1.0, 0.3, 0.1, 1.0],
}
window._Colors = Colors //debugging global

export function elemColor(e: {flag: number}): number[] {
  if (e.flag & MeshFlags.DRAW_DEBUG) {
    return Colors.DRAW_DEBUG
  } else if (e.flag & MeshFlags.DRAW_DEBUG2) {
    return Colors.DRAW_DEBUG2
  } else if (e.flag & MeshFlags.SELECT) {
    return Colors.SELECT
  } else {
    return Colors.UNSELECT
  }
}

export class OrigRef {
  ref: number
  e: Element
  co: Vector3

  constructor(element: Element, ref: number) {
    this.ref = ref //eid
    this.e = element
    this.co = new Vector3()
  }
}

export class LoopTriRet {
  ref: number | undefined
  ls: [number, number, number]
  i: number

  constructor() {
    this.ref = undefined //eid
    this.ls = [0, 0, 0]
    this.i = 0
  }
}

//let origrets
export class MeshDrawInterface {
  constructor(mesh: Mesh, meshcache: MeshCache) {}

  destroy(gl: WebGL2RenderingContext): void {}

  origVerts(mesh: Mesh): void {}

  origEdges(mesh: Mesh): void {}

  origFaceCenters(mesh: Mesh): void {}

  origFaces(mesh: Mesh): void {}

  sync(view3d: View3D, gl: WebGL2RenderingContext, object: SceneObject): void {}

  draw(
    view3d: View3D,
    gl: WebGL2RenderingContext,
    object: SceneObject,
    uniforms: Uniforms,
    program: RealShaderProgram
  ): void {}

  drawIDs(
    view3d: View3D,
    gl: WebGL2RenderingContext,
    object: SceneObject,
    uniforms: Uniforms,
    program?: RealShaderProgram
  ): boolean | void {}
}

// Lightweight type aliases for drawing subsystem types not yet fully typed
type MeshCache = {
  makeChunkedMesh(name: string, layerTypes: number): ChunkedMesh
  getMesh(name: string): ChunkedMesh
  meshes: {[key: string]: ChunkedMesh}
  partialGen: number
}

type ChunkedMesh = {
  point(id: number, co: {co: Vector3} | Vector3): DrawPrimitive
  line(id: number, v1: {co: Vector3} | Vector3, v2: {co: Vector3} | Vector3): DrawPrimitive
  tri(id: number, v1: {co: Vector3} | Vector3, v2: {co: Vector3} | Vector3, v3: {co: Vector3} | Vector3): DrawPrimitive
  draw(gl: WebGL2RenderingContext, uniforms: Uniforms, program: ShaderProgram): void
}

type DrawPrimitive = {
  ids(...ids: number[]): void
  colors(...colors: number[][]): void
}

type Uniforms = {
  [key: string]: number | number[] | Float32Array | {getFloat32Array(): Float32Array}
}

type ShaderProgram = {
  uniforms: Uniforms
  bind(gl: WebGL2RenderingContext): void
}

//let orig_rets = util.cachering.fromConstructor(OrigRef, 128);
//let ltri_rets = util.cachering.fromConstructor(LoopTriRet, 128);

export class BasicMeshDrawer extends MeshDrawInterface {
  _regen: boolean
  mc: MeshCache

  constructor(mesh: Mesh, meshcache: MeshCache) {
    super(mesh, meshcache)

    this._regen = true
    this.mc = meshcache
  }

  destroy(gl: WebGL2RenderingContext): void {}

  origVerts(mesh: Mesh): void {
    // NOTE: references commented-out orig_rets — dead code
  }

  origEdges(mesh: Mesh): void {
    // NOTE: references commented-out orig_rets — dead code
  }

  origFaceCenters(mesh: Mesh): void {
    // NOTE: references commented-out orig_rets — dead code
  }

  origFaces(mesh: Mesh): void {
    // NOTE: references commented-out orig_rets — dead code
  }

  loopTris(mesh: Mesh): void {
    // NOTE: references commented-out ltri_rets — dead code
  }

  _generate(view3d: View3D, gl: WebGL2RenderingContext, object: SceneObject): void {
    const mesh = object.data as Mesh
    const mc = this.mc
    const layerTypes = LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.ID

    const vm = mc.makeChunkedMesh('verts', layerTypes)

    for (const v of mesh.verts) {
      if (v.flag & MeshFlags.HIDE) continue

      const p = vm.point(v.eid, v)

      p.ids(v.eid)
      p.colors(elemColor(v))
    }

    const em = mc.makeChunkedMesh('edges', layerTypes)
    for (const e of mesh.edges) {
      if (e.flag & MeshFlags.HIDE) continue

      const l = em.line(e.eid, e.v1, e.v2)

      const c = elemColor(e)

      l.ids(e.eid, e.eid)
      l.colors(c, c)
    }

    const fm = mc.makeChunkedMesh('faces', layerTypes)

    const ltris = mesh.loopTris!

    for (let i = 0; i < ltris.length; i += 3) {
      const l1 = ltris[i]
      const l2 = ltris[i + 1]
      const l3 = ltris[i + 2]
      const f = l1.f

      if (f.flag & MeshFlags.HIDE) {
        continue
      }

      let c: number[] = elemColor(f)
      if (!(f.flag & MeshFlags.SELECT)) {
        c = Colors.FACE_UNSEL
      }

      const tri = fm.tri(i, l1.v, l2.v, l3.v)

      tri.colors(c, c, c)
      tri.ids(f.eid, f.eid, f.eid)
    }
  }

  sync(view3d: View3D, gl: WebGL2RenderingContext, object: SceneObject): void {
    if (this._regen) {
      this._regen = false
      this._generate(view3d, gl, object)

      return
    }

    const mc = this.mc
    const mesh = object.data as Mesh

    const fm = mc.getMesh('faces')
    const ulist = mesh.lastUpdateList
    const eidMap = mesh.eidMap
    const ltris = mesh._ltris!
    mc.partialGen = mesh.partialUpdateGen

    for (const eid in ulist) {
      const f = eidMap.get(parseInt(eid))
      if (f?.type != MeshTypes.FACE || f.flag & MeshFlags.HIDE) {
        continue
      }

      let li = mesh._ltrimap_start[f.eid]
      const len = mesh._ltrimap_len[f.eid]

      let c: number[] = elemColor(f)
      if (!(f.flag & MeshFlags.SELECT)) {
        c = Colors.FACE_UNSEL
      }

      for (let i = 0; i < len; i++) {
        const idx = li

        const l1 = ltris[li++]
        const l2 = ltris[li++]
        const l3 = ltris[li++]

        const tri = fm.tri(idx, l1.v, l2.v, l3.v)

        tri.colors(c, c, c)
        tri.ids(f.eid, f.eid, f.eid)
      }
    }

    const em = mc.getMesh('edges')
    for (const eid in ulist) {
      const e = eidMap.get(parseInt(eid))

      if (e?.type != MeshTypes.EDGE || e.flag & MeshFlags.HIDE) {
        continue
      }

      const l = em.line(e.eid, e.v1, e.v2)

      const c = elemColor(e)

      l.ids(e.eid, e.eid)
      l.colors(c, c)
    }

    const vm = mc.getMesh('verts')
    for (const eid in ulist) {
      const v = eidMap.get(parseInt(eid))

      if (v?.type != MeshTypes.VERTEX || v.flag & MeshFlags.HIDE) {
        continue
      }

      if (v.flag & MeshFlags.HIDE) continue

      const p = vm.point(v.eid, v)

      p.ids(v.eid)
      p.colors(elemColor(v))
    }
  }

  draw(
    view3d: View3D,
    gl: WebGL2RenderingContext,
    object: SceneObject,
    uniforms: Uniforms,
    program: RealShaderProgram
  ): void {
    if (!(view3d.ctx.selectMask & (SelMask.VERTEX | SelMask.EDGE | SelMask.FACE))) {
      return
    }

    if (this._regen) {
      this._regen = false
      this._generate(view3d, gl, object)
    }

    const mc = this.mc

    const mesh = object.data as Mesh

    const selmode = view3d.ctx.selectMask
    const program2 = Shaders.MeshEditShader
    //let program2 = Shaders.MeshIDShader;

    if (!(view3d.flag & View3DFlags.SHOW_RENDER)) {
      const frame: FrameContext = {gl, uniforms: uniforms as any, program: program as RealShaderProgram}
      const queue = createDrawQueue(frame)
      mesh.drawQ(view3d, queue, frame, object)
    }

    function drawElements(
      list: {active?: {eid: number}; highlight?: {eid: number}; last?: {eid: number}},
      smesh: ChunkedMesh,
      alpha = 1.0
    ) {
      program2.uniforms.active_id = list.active !== undefined ? list.active.eid : -1
      program2.uniforms.highlight_id = list.highlight !== undefined ? list.highlight.eid : -1
      program2.uniforms.last_id = list.last !== undefined ? list.last.eid : -1
      program2.uniforms.projectionMatrix = view3d.activeCamera.rendermat

      program2.uniforms.polygonOffset = Colors.POLYGON_OFFSET
      uniforms.polygonOffset = Colors.POLYGON_OFFSET
      program2.uniforms.active_color = Colors.ACTIVE
      program2.uniforms.highlight_color = Colors.HIGHLIGHT
      program2.uniforms.last_color = Colors.LAST
      program2.uniforms.alpha = alpha
      program2.uniforms.pointSize = Colors.POINTSIZE

      smesh.draw(gl, uniforms, program2)
    }

    if (selmode & SelMask.VERTEX) {
      drawElements(mesh.verts, mc.meshes['verts'])
    }

    drawElements(mesh.edges, mc.meshes['edges'])

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    //gl.depthMask(0);
    //drawElements(mesh.faces, mc.meshes["faces"], 0.1);
    //gl.depthMask(1);
    drawElements(mesh.faces, mc.meshes['faces'], 0.1)
    gl.disable(gl.BLEND)
    //console.log(mc.meshes["faces"]);
  }

  drawIDs(view3d: View3D, gl: WebGL2RenderingContext, object: SceneObject, uniforms: Uniforms): boolean | void {
    if (this._regen) {
      this._regen = false
      this._generate(view3d, gl, object)
    }

    if (object.data === undefined || !(object.data instanceof Mesh)) return false

    const mesh = object.data
    const mc = this.mc

    const program2 = Shaders.MeshIDShader
    program2.bind(gl)

    const drawElements = (list: {}, smesh: ChunkedMesh) => {
      program2.uniforms.object_id = object.lib_id
      program2.uniforms.projectionMatrix = view3d.activeCamera.rendermat
      program2.uniforms.objectMatrix = object.outputs.matrix.getValue()
      program2.uniforms.pointSize = Colors.POINTSIZE

      gl.disable(gl.BLEND)
      gl.disable(gl.DITHER)
      smesh.draw(gl, uniforms, program2)
      gl.enable(gl.DITHER)
    }

    //console.log("drawing ids");
    program2.uniforms.polygonOffset = 0 //Colors.POLYGON_OFFSET;
    drawElements(mesh.faces, mc.meshes['faces'])

    program2.uniforms.polygonOffset = Colors.POLYGON_OFFSET
    drawElements(mesh.verts, mc.meshes['verts'])
    drawElements(mesh.edges, mc.meshes['edges'])

    gl.finish()

    return false
  }
}
