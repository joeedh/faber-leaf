import {Shapes} from '@framework/api'
import {FindNearest} from '@framework/api'
import {ToolMode} from '@framework/api'
import {HotKey, KeyMap} from '@framework/pathux'
import {Icons} from '@framework/api'
import {SelMask} from '@framework/api'
import {resolveMeshes} from '../../mesh/src/mesh_ops_base.js'
import {Vector2, Vector3, Vector4, Matrix4} from '@framework/api'
import {Shaders} from '@framework/api'
import {TranslateOp} from '@framework/api'
import {SelOneToolModes} from '@framework/api'

import {ObjectFlags, SceneObject} from '@framework/api'
import {Mesh} from '../../mesh/src/mesh.js'
import {DataAPI, DataStruct, eventWasMouseDown, nstructjs} from '@framework/pathux'
import '../../mesh/src/mesh_flagops.js'

import {MeshFlags} from '../../mesh/src/mesh_base.js'
import {SelectEdgeLoopOp, type SelectOneOp} from '../../mesh/src/select_ops.js'
import type {ViewContext} from '@framework/api'
import type {BoundingBox} from '@framework/api'
import type {View3D} from '@framework/api'
import {IUniformsBlock} from '@framework/api'

export class MeshToolBase extends ToolMode {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
mesh_edit.MeshToolBase {
}`
  )

  transformConstraint: string | undefined
  transparentMeshElements: boolean
  drawOwnIds: boolean
  meshPath: string
  selectMask: number
  drawSelectMask: number
  start_mpos: Vector2
  last_mpos: Vector2
  vertexPointSize: number
  drawCursor: boolean = true
  cursor: Vector3 | undefined

  constructor(ctx: ViewContext) {
    super(ctx)

    this.transformConstraint = undefined //string, e.g. xy

    this.transparentMeshElements = false
    this.drawOwnIds = true
    this.meshPath = 'object'
    this.selectMask = SelMask.GEOM
    this.drawSelectMask = SelMask.EDGE | SelMask.VERTEX | SelMask.HANDLE

    this.start_mpos = new Vector2()
    this.last_mpos = new Vector2()

    this.vertexPointSize = 8
  }

  defineKeyMap(): KeyMap {
    this.keymap = new KeyMap([
      new HotKey('A', [], "mesh.toggle_select_all(mode='AUTO')"),
      new HotKey('A', ['alt'], "mesh.toggle_select_all(mode='SUB')"),
      new HotKey('D', [], 'mesh.subdivide()'),
      new HotKey('G', [], "view3d.translate(selmask='VERTEX|HANDLE')"),
      new HotKey('X', [], 'mesh.delete_selected()'),
    ])

    return this.keymap
  }

  buildFakeContext(ctx: ViewContext) {
    /*
    const objs: any[] = []
    let paths = this.getMeshPaths()

    //make copy
    const paths2: string[] = []
    for (const p of paths) {
      paths2.push(p)
    }
    paths = paths2

    const getObjects = (): any[] => {
      for (const mesh of resolveMeshes(ctx, paths)) {
        let ob: any
        if (mesh.ownerId !== undefined) {
          ob = ctx.datalib.get(mesh.ownerId)
        }

        if (ob === undefined) {
          ob = new SceneObject()
          ob.data = mesh
        }

        objs.push(ob)
      }

      return objs
    }

    const this2 = this
    const selectMask = this.selectMask

    return ctx.override({
      selectedMeshObjects: getObjects,
      selectedObjects    : getObjects,
      selectMask         : () => selectMask,
      mesh: function () {
        return this.api.getValue(this, paths[0])
      },
    })
    */
  }

  clearHighlight(ctx: ViewContext): void {
    window.redraw_viewport()

    for (const mesh of resolveMeshes(ctx, this.getMeshPaths())) {
      for (const k of mesh.elists.keys()) {
        const list = mesh.elists.get(k)!

        if (list.highlight !== undefined) {
          list.highlight = undefined
          window.redraw_viewport()
        }
      }
    }
  }

  getMeshPaths(): string[] {
    return ['_all_objects_']
  }

  static toolModeDefine() {
    return {
      name       : 'basemesh',
      uiname     : 'Edit Geometry',
      icon       : Icons.MESHTOOL,
      flag       : 0,
      selectMode : SelMask.OBJECT,
      description: 'Edit vertices/edges/faces',
    }
  }

  static defineAPI(api: DataAPI<ViewContext>): DataStruct<ViewContext> {
    const tstruct = super.defineAPI(api)
    return tstruct
  }

  on_mousedown(e: PointerEvent, x: number, y: number, was_touch?: boolean): boolean | void {
    const ctx = this.ctx!

    this.start_mpos[0] = x
    this.start_mpos[1] = y

    this.findHighlight(e, x, y)

    if (this.hasWidgetHighlight()) {
      return false
    }

    if (this.ctx.mesh && e.button === 0 && e.ctrlKey && !e.altKey) {
      const mesh = this.ctx.mesh
      const edge = mesh.edges.highlight

      if (edge) {
        const tool = SelectEdgeLoopOp.invoke(this.ctx, {})
        let mode: number

        if (e.shiftKey) {
          mode = edge.flag & MeshFlags.SELECT ? SelOneToolModes.SUB : SelOneToolModes.ADD
        } else {
          mode = SelOneToolModes.UNIQUE
        }

        tool.inputs.mode.setValue(mode)
        tool.inputs.edgeEid.setValue(edge.eid)
        this.ctx.api.execTool(this.ctx, tool)

        return true
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (e.button === 1 || e.ctrlKey || e.altKey || e.metaKey) {
      return false
    }

    const mpos = new Vector3([x, y])

    for (const mesh of resolveMeshes(this.ctx, this.getMeshPaths())) {
      for (const list of mesh.getElemLists()) {
        if (!(list.type & this.selectMask) || !list.highlight) {
          continue
        }

        const elem = list.highlight

        let mode: number

        if (e.shiftKey) {
          mode = elem.flag & MeshFlags.SELECT ? SelOneToolModes.SUB : SelOneToolModes.ADD
        } else {
          mode = SelOneToolModes.UNIQUE
        }

        const tool = ctx.api.createTool<SelectOneOp>(this.ctx, 'mesh.selectone(setActiveObject=0)')
        tool.inputs.eid.setValue(elem.eid)
        tool.inputs.meshPaths.setValue(this.getMeshPaths())
        tool.inputs.mode.setValue(mode)
        tool.inputs.selmask.setValue(this.selectMask)

        ctx.toolstack.execTool(this.ctx, tool)

        return true
      }
    }

    /*
    let ret = castViewRay(ctx, ctx.selectMask, mpos, ctx.view3d, CastModes.FRAMEBUFFER);
    let p;
    if (ret !== undefined) {
      p = ret.p3d;
    } else {
      p = new Vector3();
      p.multVecMatrix(this.ctx.view3d.cursor3D);
    }

    let toolop = ctx.api.createTool(ctx, "mesh.extrude_one_vertex()");

    toolop.inputs.meshPaths.setValue(this.getMeshPaths());
    toolop.inputs.co.setValue(p);
    ctx.toolstack.execTool(this.ctx, toolop);

    console.log(ret);
    return true;
    */

    return e.button === 0 // || (e.touches !== undefined && e.touches.length === 0);
  }

  getAABB(): [Vector3, Vector3] | undefined {
    const d: number = 1e17
    let ret: [Vector3, Vector3] | undefined

    function minmax(v: Vector3): void {
      if (ret === undefined) {
        ret = [new Vector3(v), new Vector3(v)]
      } else {
        ret[0].min(v)
        ret[1].max(v)
      }
    }

    for (const mesh of resolveMeshes(this.ctx, this.getMeshPaths())) {
      const matrix = new Matrix4()

      if (mesh.ownerId !== undefined) {
        const ob = this.ctx.datalib.get<SceneObject>(mesh.ownerId)

        if (ob) {
          matrix.load(ob.outputs.matrix.getValue())
        }
      }

      const co = new Vector3()

      for (const v of mesh.verts.selected.editable) {
        co.load(v.co).multVecMatrix(matrix)
        minmax(co)
      }

      if (mesh.handles) {
        for (const h of mesh.handles.selected.editable) {
          co.load(h.co).multVecMatrix(matrix)
          minmax(co)
        }
      }
    }

    return ret
  }

  getViewCenter(): BoundingBox | undefined {
    let ret = this.getAABB()
    if (ret !== undefined) {
      const cent = new Vector3(ret[0]).interp(ret[1], 0.5)
      ret = [cent, cent]
    }

    return ret
  }

  update(): this {
    super.update()
    return this
  }

  //ensure we don't have sculpt bvhs, which lack wire verts
  //and might include grid verts
  checkMeshBVHs(ctx: any = this.ctx): void {
    for (const ob of ctx.selectedMeshObjects) {
      ob.data.getBVH({autoUpdate: true, wireVerts: true})
    }
  }

  findHighlight(
    e: any,
    x: number,
    y: number,
    selectMask: number = this.selectMask
  ): {elem: any; mesh: any} | undefined {
    const view3d = this.ctx.view3d

    this.checkMeshBVHs(this.ctx)

    if (e.ctrlkey && !e.altKey) {
      selectMask = SelMask.EDGE
    }

    let ret: any = this.findnearest3d(view3d, x, y, selectMask)
    let found: boolean = false

    if (ret !== undefined && ret.length > 0) {
      for (const item of ret) {
        if (item.mesh) {
          ret = item
          found = true
          break
        }
      }
    }

    if (found) {
      const elem = ret.data
      const mesh = ret.mesh

      const redraw: boolean = mesh.getElemList(elem.type).highlight !== elem

      mesh.clearHighlight()
      mesh.setHighlight(elem)

      if (redraw) {
        window.redraw_viewport()
      }

      return {
        elem: elem,
        mesh: mesh,
      }
    } else {
      let redraw: boolean = false

      for (const mesh of resolveMeshes(this.ctx, this.getMeshPaths())) {
        for (const elist of mesh.getElemLists()) {
          if (elist.highlight) {
            redraw = true
          }
        }

        if (redraw) {
          mesh.clearHighlight()
        }
      }

      if (redraw) {
        window.redraw_viewport()
      }

      return undefined
    }
  }

  on_mousemove(e: PointerEvent, x: number, y: number, was_touch?: boolean): boolean | void {
    this.last_mpos[0] = x
    this.last_mpos[1] = y

    if (e.ctrlKey || e.altKey || e.metaKey) {
      return false
    }

    if (this.hasWidgetHighlight()) {
      return false
    }

    const mdown = eventWasMouseDown(e)
    if (!mdown && super.on_mousemove(e, x, y, was_touch)) {
      return true
    }

    if (mdown) {
      const dist: number = this.last_mpos.vectorDistance(this.start_mpos)
      let ok: boolean = false

      for (const mesh of resolveMeshes(this.ctx, this.getMeshPaths())) {
        for (const v of mesh.verts.selected.editable) {
          ok = true
          break
        }
        for (const h of mesh.handles.selected.editable) {
          ok = true
          break
        }

        if (ok) {
          break
        }
      }

      ok = ok && dist > 4
      if (ok) {
        const tool = TranslateOp.invoke(this.ctx, {}) as TranslateOp

        if (this.transformConstraint) {
          tool.setConstraintFromString(this.transformConstraint)
        }

        tool.inputs.selmask.setValue(SelMask.GEOM)
        this.ctx.toolstack.execTool(this.ctx, tool)

        return true
      }
    } else {
      const found = this.findHighlight(e, x, y)
      return Boolean(found)
    }
  }

  findnearest3d(view3d: View3D, x: number, y: number, selmask: number) {
    return FindNearest(this.ctx, selmask, new Vector2([x, y]), view3d)
  }

  drawsObjectIdsExclusively(obj: SceneObject, check_mesh: boolean = false): boolean {
    let ret: any = !check_mesh || obj.data instanceof Mesh

    ret = ret && (obj.flag & ObjectFlags.SELECT || obj === this.ctx.scene.objects.active)
    ret = ret && !(obj.flag & ObjectFlags.HIDE)

    return ret
  }

  drawIDs(view3d: View3D, gl: WebGL2RenderingContext, uniforms: IUniformsBlock, selmask?: number): void {
    if (selmask === undefined) {
      selmask = this.ctx.selectMask
    }

    if (!this.drawOwnIds) {
      return
    }

    view3d.activeCamera.regen_mats()

    uniforms = Object.assign({}, uniforms)

    const matrix = new Matrix4(uniforms.objectMatrix)

    const camdist: number = view3d.activeCamera.pos.vectorDistance(view3d.activeCamera.target)

    for (const mesh of resolveMeshes(this.ctx, this.getMeshPaths())) {
      if (mesh.ownerMatrix && mesh.ownerId !== undefined) {
        uniforms.objectMatrix.load(matrix).multiply(mesh.ownerMatrix)
        uniforms.object_id = mesh.ownerId
      } else {
        uniforms.objectMatrix.load(matrix)
        //selection system needs some sort of object id
        uniforms.object_id = 131072
      }

      const program: any = Shaders.MeshIDShader

      uniforms.pointSize = this.vertexPointSize * 1.5
      uniforms.polygonOffset = 1.0

      gl.enable(gl.DEPTH_TEST)
      gl.depthMask(true)

      gl.disable(gl.DITHER)
      gl.disable(gl.BLEND)

      uniforms.polygonOffset = 0.0
      uniforms.alpha = 1.0

      mesh.drawElements(view3d, gl, SelMask.FACE, uniforms, program)

      selmask &= ~SelMask.FACE

      if (selmask) {
        uniforms.polygonOffset = 1.0

        mesh.drawElements(view3d, gl, selmask, uniforms, program)
      }
    }
  }

  drawSphere(
    gl: WebGL2RenderingContext,
    view3d: View3D,
    p: Vector3,
    scale: number = 0.01,
    color: number[] = [1, 0.4, 0.2, 1.0]
  ): void {
    const cam = this.ctx.view3d.activeCamera
    const mat = new Matrix4()

    const co = new Vector4().load3(p)
    mat.translate(co[0], co[1], co[2])

    co[3] = 1.0
    co.multVecMatrix(cam.rendermat)

    scale = Math.abs(co[3] * scale)
    mat.scale(scale, scale, scale)

    Shapes.SPHERE.draw(
      gl,
      {
        projectionMatrix: cam.rendermat,
        objectMatrix    : mat,
        color           : color,
      },
      Shaders.WidgetMeshShader
    )
  }

  on_drawend(view3d: any): void {
    if (!this.ctx) {
      return
    }

    const gl = view3d.gl as WebGL2RenderingContext
    const cam = this.ctx.view3d.activeCamera

    const uniforms: any = {
      normalMatrix    : cam.cameramat,
      projectionMatrix: cam.rendermat,
      objectMatrix    : new Matrix4(),
      size            : view3d.glSize,
      aspect          : cam.aspect,
      near            : cam.near,
      far             : cam.far,
    }

    const camdist: number = view3d.activeCamera.pos.vectorDistance(view3d.activeCamera.target)
    const datalib = this.ctx.datalib

    for (const mesh of resolveMeshes(this.ctx, this.getMeshPaths())) {
      if (mesh === undefined) {
        console.warn('nonexistent mesh')
        continue
      }

      let object: SceneObject | undefined
      if (mesh.ownerId) {
        object = datalib.get<SceneObject>(mesh.ownerId)
      }

      if (mesh.ownerMatrix !== undefined) {
        uniforms.objectMatrix.load(mesh.ownerMatrix)
      } else {
        uniforms.objectMatrix.makeIdentity()
      }

      const program: any = Shaders.MeshEditShader

      if (!this.transparentMeshElements) {
        gl.enable(gl.DEPTH_TEST)
        gl.depthMask(true)
      } else {
        gl.depthMask(false)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.disable(gl.DEPTH_TEST)
      }

      uniforms.pointSize = this.vertexPointSize
      uniforms.polygonOffset = 1.0

      mesh.drawElements(view3d, gl, this.drawSelectMask, uniforms, program, object, true)

      if (this.transparentMeshElements) {
        gl.depthMask(true)
        gl.enable(gl.DEPTH_TEST)
      }
    }

    this.drawCursor = this.hasWidgetHighlight()

    if (this.drawCursor && this.cursor !== undefined) {
      this.drawSphere(gl, view3d, this.cursor)
    }
  }

  drawObject(gl: WebGL2RenderingContext, uniforms: any, program: any, object: any, mesh: any): boolean {
    if (!(object.data instanceof Mesh)) {
      return super.drawObject(gl, uniforms, program, object, mesh)
    }

    const view3d = this.ctx.view3d

    if (program === Shaders.BasicLitMesh) {
      const image = this.ctx.activeTexture

      if (image?.ready) {
        uniforms.texture = image.getGlTex(gl)
        program = Shaders.BasicLitMeshTexture
      } else {
        uniforms.texture = undefined
      }
    } else {
      uniforms.texture = undefined
    }
    object.draw(view3d, gl, uniforms, program)

    return true
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadSTRUCT(reader: any): void {
    reader(this)
    super.loadSTRUCT(reader)
  }
}
