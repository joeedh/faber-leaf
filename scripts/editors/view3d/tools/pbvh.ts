import './pbvh_bvhdef'

import {WidgetFlags} from '../widgets/widgets.js'
import {ToolModes} from '../view3d_toolmode.js'
import {BVH, BVHFlags, BVHNode} from '../../../../addons/builtin/mesh/src/bvh.js'
import {KeyMap, HotKey} from '../../editor_base'
import {Icons} from '../../icon_enum.js'
import {SelMask} from '../selectmode.js'
import * as util from '../../../util/util.js'

import '../../../../addons/builtin/subsurf/src/subsurf_loop_stencil.js'

import {
  AttrRef,
  ColorLayerElem,
  Face,
  FaceSetElem,
  IntElem,
  Loop,
  MaskElem,
  Mesh,
  UVLayerElem,
  Vertex,
} from '../../../../addons/builtin/mesh/src/mesh.js'
import {Shapes} from '../../../webgl/simplemesh_shapes.js'
import {Shaders} from '../../../shaders/shaders.js'
import {Vector2, Vector3, Vector4, Matrix4} from '../../../util/vectormath.js'
import {Container, IndexRange, math, Number3, PackFlags, UIBase} from '../../../path.ux/scripts/pathux.js'
import {MeshFlags} from '../../../../addons/builtin/mesh/src/mesh.js'
import {SimpleMesh, LayerTypes, PrimitiveTypes} from '../../../webgl/simplemesh'
import {GridBase, GridSettings, GridSettingFlags} from '../../../../addons/builtin/mesh/src/mesh_grids.js'
import {nstructjs} from '../../../path.ux/scripts/pathux.js'

import {
  SculptTools,
  SculptBrush,
  SculptIcons,
  PaintToolSlot,
  BrushFlags,
  DynTopoFlags,
  DynTopoSettings,
  DynTopoOverrides,
} from '../../../brush/index'

import './pbvh_holefiller'
import './pbvh_sculptops'
import './pbvh_base'
import './pbvh_texpaint'

import {calcConcave, getBVH} from './pbvh_base'
import {PaintToolModeBase} from './stroke_base.js'
import {buildBVHSettings} from './pbvh_ui'
import {trianglesToQuads, TriQuadFlags} from '../../../../addons/builtin/mesh/src/mesh_utils.js'
import {TetMesh} from '../../../tet/tetgen.js'
import {DispContext, DispLayerVert} from '../../../../addons/builtin/mesh/src/mesh_displacement.js'
import {IUniformsBlock, ShaderProgram, Texture} from '../../../webgl/webgl.js'
import {
  getFaceSetColor,
  getFaceSets,
  getFaceSetsAttr,
  getNextFaceSet,
} from '../../../../addons/builtin/mesh/src/mesh_facesets.js'
import {eventWasTouch, haveModal} from '../../../path.ux/scripts/util/simple_events.js'
import {enumValues} from '../../../util/enum-utils'
import {ParamVert} from '../../../../addons/builtin/mesh/src/mesh_paramizer'
import type {SceneObject} from '../../../sceneobject/sceneobject'
import type {BlockLoader, BlockLoaderAddUser} from '../../../core/lib_api'
import type {Scene} from '../../../scene/scene'
import type {StructReader} from '../../../path.ux/scripts/util/nstructjs'
import type {View3D} from '../view3d'
import type {ViewContext} from '../../../core/context'

export class BVHToolMode extends PaintToolModeBase {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
view3d.BVHToolMode {
  drawBVH                : bool;
  drawCavityMap          : bool;
  drawFlat               : bool;
  drawWireframe          : bool;
  drawValidEdges         : bool;
  drawNodeIds            : bool;
  drawMask               : bool;
  drawDispDisField       : bool;
  editDisplaced          : bool;
  drawColPatches         : bool;
  symmetryAxes           : int;
  gridEditDepth          : int;
  enableMaxEditDepth     : bool;
  tool                   : int;
  slots                  : iterkeys(PaintToolSlot);
  sharedBrushRadius      : float;
  dynTopo                : DynTopoSettings;
  reprojectCustomData    : bool;
}`
  )

  _apiDynTopo: DynTopoSettings

  constructor(manager: any) {
    super(manager)

    this._apiDynTopo = new Proxy(this.dynTopo, {
      get: (target: any, key: string | symbol): any => {
        const brush = this.getBrush()

        if (brush && key === 'overrideMask') {
          return brush.dynTopo.overrideMask
        }

        const all = !brush || brush.dynTopo.overrideMask & DynTopoOverrides.NONE

        if (all) {
          return (this.dynTopo as any)[key]
        }

        if (key !== 'flag') {
          const key2 = DynTopoSettings.apiKeyToOverride(key as string)

          if (!key2) {
            return (brush.dynTopo as any)[key]
          }

          let override = DynTopoOverrides[key2 as keyof typeof DynTopoOverrides] as unknown as number
          override = brush.dynTopo.overrideMask & override

          if (override) {
            return (brush.dynTopo as any)[key]
          } else {
            return (this.dynTopo as any)[key]
          }
        } else {
          //create merged flags
          let flag = 0

          const f1 = this.dynTopo.flag
          const f2 = brush.dynTopo.flag
          const oflag = brush.dynTopo.overrideMask

          for (const k in DynTopoFlags) {
            const f = DynTopoFlags[k] as unknown as number

            if (oflag & f) {
              flag |= f2 & f ? f : 0
            } else {
              flag |= f1 & f ? f : 0
            }
          }

          return flag
        }
      },
      set: (target: any, key: string | symbol, val: any): boolean => {
        const brush = this.getBrush()

        const all = !brush || brush.dynTopo.overrideMask & DynTopoOverrides.NONE

        if (brush && key === 'overrideMask') {
          brush.dynTopo.overrideMask = val
          return true
        } else if (all) {
          ;(this.dynTopo as any)[key] = val
          return true
        }

        if (key !== 'flag') {
          const key2 = DynTopoSettings.apiKeyToOverride(key as string)

          if (
            key2 &&
            brush.dynTopo.overrideMask & (DynTopoOverrides[key2 as keyof typeof DynTopoOverrides] as unknown as number)
          ) {
            ;(brush.dynTopo as any)[key] = val
          } else {
            ;(this.dynTopo as any)[key] = val
          }
        } else {
          const flag = 0
          const oflag = brush.dynTopo.overrideMask

          for (const k in DynTopoFlags) {
            const f = DynTopoFlags[k] as unknown as number
            const dynTopo = oflag & f ? brush.dynTopo : this.dynTopo

            if (val & f) {
              dynTopo.flag |= f
            } else {
              dynTopo.flag &= ~f
            }
          }
        }

        return true
      },
    })
  }

  get _brushSizeHelper(): number {
    const brush = this.getBrush()

    if (!brush) {
      return 55.0
    }

    if (brush.flag & BrushFlags.SHARED_SIZE) {
      return this.sharedRadiusFor(brush.radiusMode)
    } else {
      return brush.radius
    }
  }

  set _brushSizeHelper(val: number) {
    const brush = this.getBrush()

    if (!brush) {
      return
    }

    if (brush.flag & BrushFlags.SHARED_SIZE) {
      this.setSharedRadius(val, brush.radiusMode)
    } else {
      brush.radius = val
    }
  }

  get _apiBrushHelper(): any {
    return this.getBrush()
  }

  set _apiBrushHelper(brush: any) {
    if (brush === undefined) {
      return
    }

    const oldbrush = this.getBrush()
    if (oldbrush === brush) {
      return
    }

    const scene = this.ctx ? this.ctx.scene : undefined
    this.slots[this.tool].setBrush(brush, scene)
  }

  get _apiInheritDynTopo(): boolean {
    const brush = this.getBrush()
    if (!brush) {
      return false
    }

    return !!(brush.dynTopo.overrideMask & DynTopoOverrides.NONE)
  }

  set _apiInheritDynTopo(v: boolean) {
    const brush = this.getBrush()
    if (!brush) {
      return
    }

    if (v) {
      brush.dynTopo.overrideMask |= DynTopoOverrides.NONE
    } else {
      brush.dynTopo.overrideMask &= ~DynTopoOverrides.NONE
    }
  }

  static buildEditMenu(): string[] {
    return ['brush.set_radius()', 'paint.clear_mask()']
  }

  static register(cls: any): void {
    ToolModes.push(cls)
    //WidgetTool.register(cls);
  }

  static toolModeDefine(): any {
    return {
      name        : 'sculpt',
      uiname      : 'Sculpt',
      icon        : Icons.SCULPT_MODE,
      flag        : 0,
      description : 'Sculpt Mode',
      selectMode  : SelMask.OBJECT | SelMask.GEOM, //if set, preferred selectmode, see SelModes
      transWidgets: [],
    }
  }

  static buildSettings(container: Container<ViewContext>): void {
    buildBVHSettings(container, this.toolModeDefine().name)
  }

  static buildHeader(header: any, addHeaderRow: any): void {
    super.buildHeader(header, addHeaderRow)

    const name = this.toolModeDefine().name

    let strip = header.strip()
    strip.prop(`scene.tools.${name}.drawBVH`)
    strip.prop(`scene.tools.${name}.drawFlat`)
    strip.prop(`scene.tools.${name}.drawWireframe`)
    strip.prop(`scene.tools.${name}.drawCavityMap`)
    strip.prop(`scene.tools.${name}.drawMask`)

    strip = header.strip()
    strip.prop(`scene.tools.${name}.editDisplaced`)
    strip.prop(`scene.tools.${name}.drawDispDisField`)

    strip = header.strip()
    strip.useIcons(false)
    strip.prop(`scene.tools.${name}.drawValidEdges`)

    let row = addHeaderRow()
    const path = `scene.tools.${name}.brush`

    strip = row.strip()
    strip.prop(`scene.tools.${name}.tool`)
    strip.tool('mesh.symmetrize()')
    strip.prop(`scene.tools.${name}.symmetryAxes`)

    row = addHeaderRow()
    strip = row.strip()
    strip.prop(path + '.dynamics.radius.useDynamics')
    strip.prop(`scene.tools.${name}.brushRadius`)

    strip.prop(path + '.dynamics.strength.useDynamics')
    strip.prop(path + '.strength')
    strip.prop(path + '.flag[SHARED_SIZE]', PackFlags.HIDE_CHECK_MARKS)

    strip = row.strip()
    strip.pathlabel('mesh.triCount', 'Triangles')

    strip.prop(path + '.spacing')

    row = addHeaderRow()
    strip = row.strip()
    strip.tool('mesh.edgecut()')
    strip.prop(`scene.tools.${name}.reprojectCustomData`)

    header.flushUpdate()
  }

  static defineAPI(api: any): any {
    const st = super.defineAPI(api)

    st.flags('symmetryAxes', 'symmetryAxes', {
      X: 1,
      Y: 2,
      Z: 4,
    }).icons({
      X: Icons.SYM_X,
      Y: Icons.SYM_Y,
      Z: Icons.SYM_Z,
    })

    st.float('sharedBrushRadius', 'sharedBrushRadius', 'Shared Radius').noUnits().range(0, 450)
    st.float('_brushSizeHelper', 'brushRadius', 'Radius').noUnits().range(0, 450).step(1.0)

    function onchange(this: any): void {
      const pbvh = this.dataref
      const mesh = pbvh.ctx.mesh

      if (mesh?.bvh && !mesh.bvh.dead) {
        const bvh = mesh.bvh

        for (const node of bvh.nodes) {
          if (node.leaf) {
            node.flag |= BVHFlags.UPDATE_DRAW
            bvh.updateNodes.add(node)
          }
        }

        bvh.update()
        window.redraw_viewport(true)
      }
    }

    st.bool('drawWireframe', 'drawWireframe', 'Draw Wireframe').on('change', onchange).icon(Icons.DRAW_SCULPT_WIREFRAME)
    st.bool('drawValidEdges', 'drawValidEdges', 'Valid Edges Only')
      .description('Draw sculpt wireframe with valid edges only,\n instead of all tris')
      .on('change', onchange)
      .icon(Icons.DRAW_SCULPT_WIREFRAME)
    st.bool('drawBVH', 'drawBVH', 'Draw BVH').on('change', onchange)
    st.bool('drawCavityMap', 'drawCavityMap', 'Cavity Map').on('change', onchange)
    st.bool('drawMask', 'drawMask', 'Draw Mask').on('change', onchange)

    st.bool('drawColPatches', 'drawColPatches', 'Draw Color Patches').on('change', onchange)

    st.bool('drawNodeIds', 'drawNodeIds', 'Draw BVH Vertex IDs').on('change', onchange)
    st.bool('drawFlat', 'drawFlat', 'Draw Flat').on('change', onchange).icon(Icons.DRAW_SCULPT_FLAT)
    st.enum('tool', 'tool', util.deleteTsEnumIntegers(SculptTools)).icons(SculptIcons)

    st.bool('enableMaxEditDepth', 'enableMaxEditDepth', 'Multi Resolution Editing')
    st.int('gridEditDepth', 'gridEditDepth', 'Edit Depth', 'Maximum quad tree grid edit level').range(0, 15).noUnits()

    st.struct('_apiBrushHelper', 'brush', 'Brush', api.mapStruct(SculptBrush))

    st.struct('_apiDynTopo', 'dynTopo', 'DynTopo', api.mapStruct(DynTopoSettings))
    st.bool('_apiInheritDynTopo', 'inheritDynTopo', 'Inherit Everything')

    st.bool('editDisplaced', 'editDisplaced', 'Displaced').on('change', onchange)
    st.bool('drawDispDisField', 'drawDispDisField', 'Draw Dis Field').on('change', onchange)
    st.bool('reprojectCustomData', 'reprojectCustomData', 'Reproject UVs & colors')

    return st
  }

  defineKeyMap(): void {
    this.keymap = new KeyMap([
      new HotKey('F', [], 'brush.set_radius()'),
      new HotKey('.', [], 'view3d.view_selected()'),
      new HotKey('M', ['alt'], 'paint.clear_mask()'),
    ])
  }

  drawBrush(view3d: View3D): void {
    this.clearBrushLines()

    if (haveModal()) {
      return
    }

    const drawCircle = (x: number, y: number, r: number, mat: Matrix4 = new Matrix4(), z: number = 0.0): void => {
      const p = new Vector3()
      const lastp = new Vector3()
      const steps = Math.max(Math.ceil((Math.PI * r * 2) / 20), 8)
      let th = -Math.PI
      const dth = (2.0 * Math.PI) / (steps - 1)

      r /= devicePixelRatio

      const dpi = UIBase.getDPI()

      const mpos = view3d.getLocalMouse(x, y)
      x = mpos[0]
      y = mpos[1]
      //y -= r * 0.5;

      for (let i = 0; i < steps; i++, th += dth) {
        p[0] = x + Math.cos(th) * r
        p[1] = y + Math.sin(th) * r
        p[2] = z

        p.multVecMatrix(mat)
        if (i > 0) {
          this._brush_lines.push(view3d.overdraw!.line(lastp, p, 'red'))
        }
        lastp.load(p)
      }
    }

    const brush = this.getBrush()
    if (!brush) {
      return
    }

    const radius = brush.flag & BrushFlags.SHARED_SIZE ? this.sharedRadiusFor(brush.radiusMode) : brush.radius

    const r = this._radius !== undefined ? this._radius : radius
    drawCircle(this.mpos[0], this.mpos[1], r)
  }

  getBVH(mesh: Mesh, useGrids: boolean = true): BVH {
    return mesh.getLastBVH()
  }

  on_mousemove(e: any, x: number, y: number, was_touch: boolean): any {
    const ret = super.on_mousemove(e, x, y, was_touch)

    this.mpos[0] = e.x
    this.mpos[1] = e.y

    if (this.ctx && this.ctx.view3d) {
      this.drawBrush(this.ctx.view3d)
    }

    return ret
  }

  on_mousedown(e: any, x: number, y: number): boolean {
    super.on_mousedown(e, x, y, eventWasTouch(e))

    this.mpos[0] = e.x
    this.mpos[1] = e.y

    if (e.button === 0 && !e.altKey) {
      let brush = this.getBrush()

      const isColor = brush.tool === SculptTools.PAINT || brush.tool === SculptTools.PAINT_SMOOTH
      const smoothtool = isColor ? SculptTools.PAINT_SMOOTH : SculptTools.SMOOTH
      let drawFaceSet = this.lastFaceSet

      if (brush.tool === SculptTools.FACE_SET_DRAW) {
        if (e.ctrlKey) {
          const view3d = this.ctx.view3d
          const ob = this.ctx.object!
          const mesh = this.ctx.mesh!

          const bvh = mesh.getBVH({autoUpdate: false})

          const view = view3d.getViewVec(e.x, e.y)
          let origin = view3d.activeCamera.pos

          const obmat = ob.outputs.matrix.getValue()
          const matinv = new Matrix4(obmat)
          matinv.invert()

          origin = new Vector3(origin)
          origin.multVecMatrix(matinv)

          const view4 = new Vector4().loadXYZ(view[0], view[1], view[2])
          view4[3] = 0.0
          view4.multVecMatrix(matinv)
          view.load(view4).normalize()

          const cd_fset = getFaceSets(mesh, true)

          const isect = bvh.castRay(origin, view)
          if (isect?.tri?.l1) {
            const f = isect.tri.l1.f
            drawFaceSet = this.lastFaceSet = Math.abs((f.customData[cd_fset] as IntElem).value)
          }
        } else {
          drawFaceSet = this.lastFaceSet = getNextFaceSet(this.ctx.mesh)
        }
      }

      const dynmask = 0

      const isTexPaint = brush.tool === SculptTools.TEXTURE_PAINT

      if (e.shiftKey && !isTexPaint) {
        brush = this.getBrush(smoothtool)
      }

      const radius = brush.flag & BrushFlags.SHARED_SIZE ? this.sharedRadiusFor(brush.radiusMode) : brush.radius

      brush = brush.copy()

      brush.dynTopo.loadDefaults(this.dynTopo)

      if (e.ctrlKey && !isTexPaint) {
        const t = brush.color
        brush.color = brush.bgcolor
        brush.bgcolor = t
      }
      brush.radius = radius

      if (brush.tool === SculptTools.BVH_DEFORM) {
        this.ctx.api.execTool(this.ctx, 'bvh.bvh_deform()', {
          brush       : brush,
          symmetryAxes: this.symmetryAxes,
        })
      } else if (brush.tool === SculptTools.HOLE_FILLER) {
        this.ctx.api.execTool(this.ctx, 'bvh.hole_filler()', {
          brush       : brush,
          symmetryAxes: this.symmetryAxes,
        })
      } else if (brush.tool === SculptTools.TEXTURE_PAINT) {
        this.ctx.api.execTool(this.ctx, 'bvh.texpaint()', {
          brush       : brush,
          symmetryAxes: this.symmetryAxes,
          doBlur      : e.shiftKey,
        })
      } else {
        this.ctx.api.execTool(this.ctx, 'bvh.paint()', {
          brush              : brush,
          drawFaceSet        : drawFaceSet,
          symmetryAxes       : this.symmetryAxes,
          dynTopoDepth       : brush.dynTopo.maxDepth,
          useMultiResDepth   : this.enableMaxEditDepth,
          reprojectCustomData: this.reprojectCustomData,
        })
      }

      return true
    }

    window.redraw_viewport()

    return false
  }

  on_mouseup(e: any, x: number, y: number, wasTouch: boolean): boolean {
    super.on_mouseup(e, x, y, wasTouch)

    this.mdown = false

    return false
  }

  getMeshMresSettings(mesh: Mesh): GridSettings | undefined {
    const cd_grid = GridBase.meshGridOffset(mesh)

    if (cd_grid >= 0) {
      return mesh.loops.customData.flatlist[cd_grid].getTypeSettings() as GridSettings
    }

    return undefined
  }

  updateMeshMres(mesh: Mesh): void {
    const cd_grid = GridBase.meshGridOffset(mesh)

    if (cd_grid < 0) {
      return
    }

    const mres = this.getMeshMresSettings(mesh)
    if (!mres) {
      return
    }
    let flag = mres.flag

    if (this.enableMaxEditDepth) {
      flag |= GridSettingFlags.ENABLE_DEPTH_LIMIT
    } else {
      flag &= ~GridSettingFlags.ENABLE_DEPTH_LIMIT
    }

    const update = flag !== mres.flag || this.gridEditDepth !== mres.depthLimit

    mres.depthLimit = this.gridEditDepth
    mres.flag = flag

    if (update) {
      for (const l of mesh.loops) {
        // grid.update lives on GridBase subtype; bypass via any rather than over-constraining here.
        const grid = l.customData[cd_grid] as any
        grid.update(mesh, l, cd_grid)
      }

      mesh.regenRender()
      mesh.regenBVH()
      mesh.graphUpdate()

      window.redraw_viewport(true)
    }
  }

  update(): this {
    super.update()

    //hackishly update triangle count
    //in the UI
    if (this.ctx.mesh?.bvh && this.ctx.mesh.bvh.cd_grid.i >= 0) {
      const mesh = this.ctx.mesh
      const bvh = this.ctx.mesh.bvh
      let tottri = 0
      const gridAttr = bvh.cd_grid

      for (const l of mesh.loops) {
        const grid = gridAttr.get(l)

        tottri += grid.totTris
      }

      mesh.uiTriangleCount = tottri
    }

    if (!this.ctx?.object || !(this.ctx.object.data instanceof Mesh)) {
      return this
    }

    let key = '' + this.enableMaxEditDepth
    if (this.enableMaxEditDepth) {
      key += ':' + this.gridEditDepth
    }

    key += ':' + this.ctx.object.data.lib_id

    if (key !== this._last_enable_mres) {
      this._last_enable_mres = key
      this.updateMeshMres(this.ctx.object.data)
    }
    return this
  }

  destroy(): void {}

  onActive(): void {}

  onInactive(): void {
    this.clearBrushLines()

    if (!this.ctx?.object) {
      return
    }
    const ctx = this.ctx

    super.onInactive()

    const ob = ctx.object!
    if ((ob.data instanceof Mesh || ob.data instanceof TetMesh) && ob.data.bvh) {
      if (ob.data instanceof Mesh) {
        ob.data.regenTessellation()
        ob.data.regenBVH()
      } else {
        ob.data.regenRender()
        ob.data.regenNormals()

        ob.data.bvh.destroy(ob.data as unknown as Mesh)
        ob.data.bvh = undefined
      }
    }
  }

  on_drawend(view3d: any): void {
    if (!this.ctx?.scene) {
      return
    }

    const gl = view3d.gl as WebGL2RenderingContext
    this.drawBrush(view3d)

    const ctx = this.ctx
    const scene = ctx.scene

    const uniforms: IUniformsBlock = {
      projectionMatrix: view3d.activeCamera.rendermat,
      //normalMatrix    : new Matrix4()
      objectMatrix    : new Matrix4(),
      object_id       : -1,
      size            : view3d.glSize,
      near            : view3d.activeCamera.near,
      far             : view3d.activeCamera.far,
      aspect          : view3d.activeCamera.aspect,
      polygonOffset   : 0.0,
      color           : [1, 0, 0, 1],
      alpha           : 1.0,
    }

    const program = Shaders.ObjectLineShader

    if (1) {
      const co = this.debugSphere
      const s = 0.1

      uniforms.objectMatrix.translate(co[0], co[1], co[2])
      uniforms.objectMatrix.scale(s, s, s)

      Shapes.SPHERE.draw(gl, uniforms, program)
      uniforms.objectMatrix.makeIdentity()
    }

    const drawNodeAABB = (bvh: any, node: any, matrix: Matrix4): void => {
      if (!node.leaf) {
        for (const c of node.children) {
          drawNodeAABB(bvh, c, matrix)
        }

        return
      }

      if (node.uniqueTris.size === 0) {
        return
      }

      matrix = new Matrix4(matrix)
      uniforms.objectMatrix = matrix

      const size = new Vector3(node.max).sub(node.min)

      gl.disable(gl.CULL_FACE)
      gl.disable(gl.BLEND)

      const f = node.id * 0.1
      uniforms.color[0] = Math.fract(f * Math.sqrt(3.0))
      uniforms.color[1] = Math.fract(f * Math.sqrt(5.0) + 0.234)
      uniforms.color[2] = Math.fract(f * Math.sqrt(2.0) + 0.8234)
      uniforms.color[3] = 1.0

      uniforms.uColor = uniforms.color

      const camera = view3d.activeCamera

      uniforms.aspect = camera.aspect
      uniforms.near = camera.near
      uniforms.far = camera.far
      uniforms.size = view3d.glSize
      uniforms.polygonOffset = 0.0
      uniforms.opacity = uniforms.alpha = 1.0

      const white = new Vector4([1, 1, 1, 1])

      if (bvh.isDeforming) {
        const lf = LayerTypes
        const lflag = lf.LOC | lf.COLOR

        const sm = new SimpleMesh(lflag)
        sm.primflag |= PrimitiveTypes.LINES

        for (const e of node.boxedges) {
          const v1 = new Vector3(e.v1)
          const v2 = new Vector3(e.v2)

          const line = sm.line(v1, v2)
          line.colors(white, white)
        }

        sm.drawLines(gl, uniforms, program)
        sm.destroy(gl)
      } else {
        const smat = new Matrix4()
        smat.scale(size[0], size[1], size[2])

        const tmat = new Matrix4()
        tmat.translate(node.min[0] + size[0] * 0.5, node.min[1] + size[1] * 0.5, node.min[2] + size[2] * 0.5)

        matrix.multiply(tmat)
        matrix.multiply(smat)

        uniforms.objectMatrix.load(matrix)

        Shapes.CUBE.drawLines(gl, uniforms, program)
      }
    }

    for (const ob of scene.objects.selected.editable) {
      if (!(ob.data instanceof Mesh) && !(ob.data instanceof TetMesh)) {
        continue
      }

      const matrix = new Matrix4(ob.outputs.matrix.getValue())

      uniforms.object_id = ob.lib_id

      const mesh = ob.data as Mesh
      const bvh = this.getBVH(mesh)

      if (this.drawBVH) {
        for (const node of bvh.nodes) {
          if (node.leaf) {
            drawNodeAABB(bvh, node, matrix)
          }
        }
      }
    }
  }

  /*
   * called for all objects;  returns true
   * if an object if the toolmode drew the object
   * itself
   */
  drawObject(
    gl: WebGL2RenderingContext,
    uniforms: IUniformsBlock,
    program: ShaderProgram,
    object: SceneObject,
    mesh: Mesh
  ): boolean {
    if (!(this.ctx?.object && object === this.ctx.object)) {
      return false
    }

    const symflag = mesh.symFlag
    const axes = [-1]
    for (let i = 0; i < 3; i++) {
      if (symflag & (1 << i)) {
        axes.push(i)
      }
    }

    const drawFlat = this.drawFlat
    const brush = this.getBrush()

    const drawNode = (node: BVHNode, matrix: Matrix4): void => {
      if (!node.leaf) {
        for (const c of node.children) {
          drawNode(c, matrix)
        }

        return
      }

      matrix = new Matrix4(matrix)
      uniforms.objectMatrix = matrix

      const size = new Vector3(node.max).sub(node.min)

      const smat = new Matrix4()
      smat.scale(size[0], size[1], size[2])

      const tmat = new Matrix4()
      tmat.translate(node.min[0] + size[0] * 0.5, node.min[1] + size[1] * 0.5, node.min[2] + size[2] * 0.5)

      matrix.multiply(tmat)
      matrix.multiply(smat)

      gl.disable(gl.CULL_FACE)
      gl.disable(gl.BLEND)

      uniforms.objectMatrix.load(matrix)
    }

    const ob = object //let ob = this.ctx.object;
    let bvh: BVH

    const cd_fset = getFaceSetsAttr(mesh) as AttrRef<FaceSetElem>

    //update all normals on first bvh build
    if (!mesh.bvh) {
      bvh = this.getBVH(mesh)

      for (const n of bvh.nodes) {
        if (n.leaf) {
          n.setUpdateFlag(BVHFlags.UPDATE_NORMALS)
        }
      }

      bvh.update()
    } else {
      bvh = this.getBVH(mesh)
    }

    const isDeforming = bvh.isDeforming
    const cd_node = bvh.cd_node

    const dynTopo = this._apiDynTopo

    let hideQuadEdges = false

    if (mesh instanceof Mesh) {
      hideQuadEdges = !!(dynTopo.flag & DynTopoFlags.DRAW_TRIS_AS_QUADS)

      const key = '' + mesh.lib_id + ':' + hideQuadEdges
      let update = false

      if (this._last_hqed !== key) {
        this._last_hqed = key
        update = true
      }

      bvh.hideQuadEdges = hideQuadEdges

      if (update) {
        const quadflag = MeshFlags.QUAD_EDGE
        for (const e of mesh.edges) {
          e.flag &= ~quadflag
        }

        trianglesToQuads(mesh, mesh.faces, TriQuadFlags.DEFAULT | TriQuadFlags.MARK_ONLY)

        for (const node of bvh.nodes) {
          if (!node.leaf) {
            continue
          }

          node.flag |= BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_INDEX_VERTS
          bvh.updateNodes.add(node)
        }

        bvh.update()
      }
    }

    for (const node of new Set(bvh.nodes)) {
      if (!node || node.id < 0) {
        continue
      }

      bvh.checkJoin(node)
    }

    const parentoff = bvh.drawLevelOffset

    let fullDraw = false

    const grid_off = GridBase.meshGridOffset(mesh)
    const have_grids = grid_off >= 0
    const white = [1, 1, 1, 1]
    const red = [1, 0, 0, 1]

    let cd_color = new AttrRef<ColorLayerElem>()
    let have_color: boolean | undefined

    let drawkey = ''

    if (have_grids) {
      GridBase.syncVertexLayers(mesh)
      cd_color = mesh.loops.customData.getLayerRef('color')
      have_color = cd_color.i >= 0
    } else {
      cd_color = mesh.verts.customData.getLayerRef('color')
      have_color = cd_color.i >= 0
    }

    drawkey += ':' + cd_color.i + ':' + object.lib_id + ':' + mesh.lib_id

    if (drawkey !== this._last_draw_key) {
      this._last_draw_key = drawkey
      fullDraw = true
    }

    for (const node of bvh.nodes) {
      node.flag &= ~BVHFlags.TEMP_TAG

      if (fullDraw && node.leaf) {
        node.flag |= BVHFlags.UPDATE_DRAW
      }
    }

    const drawnodes = new Set<BVHNode>()

    const sortnodes = bvh.nodes.filter((n: BVHNode) => n.leaf)
    sortnodes.sort((a: BVHNode, b: BVHNode) => b.depth - a.depth)

    for (const node of sortnodes) {
      let p = node

      let ok = node.parent && node.parent.subtreeDepth > node.depth + 1
      ok = ok || (node.leaf && bvh.isDeforming)

      if (ok) {
        node.flag |= BVHFlags.TEMP_TAG

        drawnodes.add(node)
        continue
      }

      if (bvh.isDeforming) {
        continue
      }

      //go parentoff levels up
      for (let i = 0; i < parentoff; i++) {
        if (!p.parent || p.flag & BVHFlags.TEMP_TAG) {
          break
        }

        p = p.parent

        /*
        let p2 = p.parent ? p.parent : p;

        let d;
        let bad = false;

        for (let c of p2.children) {
          if (d === undefined) {
            d = c.subtreeDepth;
          } else {
            bad = bad || c.subtreeDepth !== d;
          }
        }

        if (!bad) {
          p = p2;
        } else {
          break;
        }
        */
      }

      p.flag |= BVHFlags.TEMP_TAG

      drawnodes.add(p)

      if (node.flag & BVHFlags.UPDATE_DRAW) {
        p.flag |= BVHFlags.UPDATE_DRAW
      }
    }

    for (const node of new Set(drawnodes)) {
      let p2 = node.parent
      while (p2) {
        if (p2.flag & BVHFlags.TEMP_TAG) {
          node.flag &= ~BVHFlags.TEMP_TAG
          p2.flag |= node.flag & BVHFlags.UPDATE_DRAW
          break
        }
        p2 = p2.parent
      }
    }

    let t1 = new Vector3()
    let t2 = new Vector3()
    let t3 = new Vector3()

    const drawBVH = this.drawBVH
    const drawNodeIds = this.drawNodeIds
    const puv3 = [0, 0, 0, 0]
    const puv2 = [0, 1, 0, 0]
    const puv1 = [1, 0, 0, 0]

    /*
    on factor;

    procedure tbez(a, b, c, w1, w2);
      w1*a + w2*b + (1.0-w1-w2)*c;

    p1 := tbez(k1, k2, k6, w1, w2);
    p2 := tbez(k2, k3, k4, w1, w2);
    p3 := tbez(k6, k4, k5, w1, w2);

    quad := tbez(p1, p2, p3, w1, w2);

    p1 := tbez(k1,  k2,  k12, w1, w2);
    p2 := tbez(k2,  k3,  k13, w1, w2);
    p3 := tbez(k12, k13, k11, w1, w2);

    p4 := tbez(k3,  k4,  k14, w1, w2);
    p5 := tbez(k4,  k5,  k6, w1, w2);
    p6 := tbez(k14, k6,  k7, w1, w2);

    p7 := tbez(k11, k15, k10, w1, w2);
    p8 := tbez(k15,  k7, k8, w1, w2);
    p9 := tbez(k10,  k8, k9, w1, w2);

    a1 := tbez(p1, p2, p3, w1, w2);
    a2 := tbez(p4, p5, p6, w1, w2);
    a3 := tbez(p7, p8, p9, w1, w2);

    cubic := tbez(a1, a2, a3, w1, w2);

    **/
    const nv1 = new Vector3()
    const nv2 = new Vector3()
    const nv3 = new Vector3()
    const editDisplaced = this.editDisplaced
    const drawDispDisField = this.drawDispDisField
    const drawWireframe = this.drawWireframe
    const drawValidEdges = this.drawValidEdges
    const drawCavityMap = this.drawCavityMap
    const drawColPatches = this.drawColPatches
    const drawMask = this.drawMask

    const cd_uv = mesh.loops.customData.getLayerRef(UVLayerElem)
    const haveUvs = cd_uv.i >= 0

    const tstart = util.time_ms()

    if (bvh.computeValidEdges !== drawValidEdges) {
      for (const node of bvh.nodes) {
        node.flag |= BVHFlags.UPDATE_INDEX_VERTS | BVHFlags.UPDATE_DRAW
        bvh.updateNodes.add(node)
      }
    }

    bvh.computeValidEdges = drawValidEdges
    bvh.update()

    const vn1 = new Vector3()

    let nsmooth: ((v: any, fac?: number) => Vector3) | undefined
    const nsmooth_rets = util.cachering.fromConstructor(Vector3, 16)

    if (have_grids) {
      nsmooth = function (v: any, fac: number = 1.0): Vector3 {
        let tot = 0
        const n = nsmooth_rets.next().zero()

        for (const v2 of v.neighbors) {
          n.add(v2.no)
          tot++
        }

        if (tot > 0) {
          n.mulScalar(1.0 / tot)
          n.interp(v.no, 1.0 - fac)
          n.normalize()
        } else {
          n.load(v.no)
        }

        return n
      }
    } else {
      nsmooth = function (v: any, fac: number = 1.0): Vector3 {
        let tot = 0
        const n = nsmooth_rets.next().zero()

        for (const e of v.edges) {
          const v2 = e.otherVertex(v)

          const w = v.vectorDistanceSqr(v2)

          for (const l of e.loops) {
            n.addFac(l.f.no, w)
            tot += w
          }
        }

        if (tot > 0) {
          n.mulScalar(1.0 / tot)
          n.interp(v.no, 1.0 - fac)
          n.normalize()
        } else {
          n.load(v.no)
        }

        return n
      }
    }

    nsmooth = (v: any) => v.no

    function vcavity(v: any): number {
      return 1.0 - calcConcave(v)
    }

    let cd_mask: AttrRef<MaskElem>

    if (have_grids) {
      cd_mask = mesh.loops.customData.getLayerRef('mask')
    } else {
      cd_mask = mesh.verts.customData.getLayerRef('mask')
    }

    if (this.drawMask && cd_mask.i !== this._last_cd_mask) {
      this._last_cd_mask = cd_mask.i

      for (const node of bvh.nodes) {
        bvh.updateNodes.add(node)
        node.flag |= BVHFlags.UPDATE_DRAW | BVHFlags.UPDATE_MASK
      }
    }

    const norvisit = new WeakSet()

    if (isDeforming) {
      const {data, dimen} = bvh.makeNodeDefTexture()

      if (bvh.glLeafTex?.createParams.width !== dimen) {
        if (bvh.glLeafTex) {
          bvh.glLeafTex.destroy(gl)
        }

        const tex = gl.createTexture()

        bvh.glLeafTex = new Texture(undefined, tex)
        gl.bindTexture(gl.TEXTURE_2D, tex)

        bvh.glLeafTex.texParameteri(gl, gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        bvh.glLeafTex.texParameteri(gl, gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        bvh.glLeafTex.texParameteri(gl, gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        bvh.glLeafTex.texParameteri(gl, gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      }

      bvh.glLeafTex.createParams.width = dimen
      bvh.glLeafTex.texImage2D(gl, gl.TEXTURE_2D, 0, gl.RGBA32F, dimen, dimen, 0, gl.RGBA, gl.FLOAT, data)

      gl.bindTexture(gl.TEXTURE_2D, null)
    }

    function genNodeMesh_index(node: BVHNode): void {
      const nodes: BVHNode[] = []

      //count verts
      function buildNodes(n: BVHNode): void {
        if (n.leaf) {
          nodes.push(n)
        }

        for (const n2 of n.children) {
          buildNodes(n2)
        }
      }

      buildNodes(node)

      let totvert = 0
      let totedge = 0
      let tottri = 0
      let updateColors = false
      let updateUvs = false
      // TODO: shader paths assume vcol data is present; reinstate `cd_color.i >= 0` once the shaders handle missing vcol layers.
      let haveColors = true

      haveColors = haveColors || drawMask || drawCavityMap || drawDispDisField

      for (const n2 of nodes) {
        totedge += (n2.indexEdges?.length ?? 0) >> 1
        totvert += n2.indexVerts?.length ?? 0
        tottri += ~~((n2.indexTris.length ?? 0) / 3 + 0.00001)

        if (drawMask && cd_mask.i >= 0 && n2.flag & BVHFlags.UPDATE_MASK) {
          n2.flag &= ~BVHFlags.UPDATE_MASK
          updateColors = true
        }
      }

      let i = 0
      for (const n2 of nodes) {
        for (const l of n2.indexLoops!) {
          l.index = i++
        }
      }

      let lflag = LayerTypes.LOC | LayerTypes.INDEX | LayerTypes.UV | LayerTypes.NORMAL
      if (haveColors) {
        lflag |= LayerTypes.COLOR
      }

      if (isDeforming) {
        lflag |= LayerTypes.CUSTOM
      }

      let sm = node.drawData
      if (!sm) {
        sm = node.drawData = new SimpleMesh(lflag)
        sm.indexedMode = true

        updateColors = haveColors
        updateUvs = cd_uv.i >= 0
      } else {
        const island = sm.islands[0]

        if (island.totvert !== totvert || island.tottri !== tottri || island.drawCavityMap !== drawCavityMap) {
          updateUvs = cd_uv.i >= 0
          updateColors = haveColors
        }

        //XXX for testing purposes
        updateUvs = cd_uv.i >= 0
      }

      const island = sm.island

      island.totvert = totvert
      island.tottri = tottri
      island.drawCavityMap = drawCavityMap

      island.regen = true
      island.indexedMode = true

      let idx = island.getIndexBuffer(PrimitiveTypes.TRIS)

      let defv
      if (isDeforming) {
        defv = island.getDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 2, 'BVHDefVs')

        defv.bufferHint = gl.DYNAMIC_DRAW
        defv.setCount(tottri * 3, true)
        defv = defv._getWriteData()
      }

      idx.setCount(tottri * 3, true)
      idx = idx._getWriteData()

      island.tri_cos.bufferHint = gl.DYNAMIC_DRAW
      island.tri_normals.bufferHint = gl.DYNAMIC_DRAW
      island.tri_uvs.bufferHint = gl.DYNAMIC_DRAW

      if (haveColors) {
        island.tri_colors.bufferHint = gl.DYNAMIC_DRAW
      }

      let vcos = island.tri_cos
      let vnos = island.tri_normals
      let vuvs
      let vcolors
      let colormul
      let uvmul

      if (cd_uv.i >= 0) {
        updateUvs = updateUvs || island.tri_uvs.dataUsed / 2 !== totvert
      }

      if (updateUvs) {
        vuvs = island.tri_uvs
        uvmul = vuvs.glSizeMul

        vuvs.setCount(totvert, true)
        vuvs = vuvs._getWriteData()
      }

      updateColors = updateColors || island.tri_colors.dataUsed / 4 !== totvert
      updateColors = updateColors || drawCavityMap || drawDispDisField

      if (brush.tool === SculptTools.FACE_SET_DRAW) {
        updateColors = true
      }

      updateColors = updateColors && haveColors

      if (!updateColors) {
        for (const n of nodes) {
          if (n.flag & BVHFlags.UPDATE_COLORS) {
            updateColors = true

            n.flag &= ~BVHFlags.UPDATE_COLORS
          }
        }
      }

      if (updateColors) {
        vcolors = island.tri_colors
        colormul = vcolors.glSizeMul

        vcolors.setCount(totvert, true)
        vcolors = vcolors._getWriteData()
      }

      vcos.setCount(totvert, true)
      vcos = vcos._getWriteData()

      vnos.setCount(totvert, true)
      const nomul = vnos.glSizeMul
      vnos = vnos._getWriteData()

      let vi = 0

      let lineidx
      if (drawWireframe) {
        lineidx = island.getIndexBuffer(PrimitiveTypes.LINES)

        lineidx.setCount(totedge * 2, true)
        lineidx = lineidx._getWriteData()
      }

      const black = [0, 0, 0, 1]
      const white = [1, 1, 1, 1]

      const displayers = mesh.verts.customData.getLayerSet('displace', false)
      const cd_disp = new AttrRef<DispLayerVert>()
      const cd_pvert = new AttrRef<ParamVert>()

      if (displayers && displayers.length > 0) {
        cd_disp.i = displayers[displayers.length - 1].index
        const dctx = new DispContext()
        dctx.reset(mesh, cd_disp.i)

        cd_pvert.i = dctx.cd_pvert?.i ?? -1
        //cd_disp = mesh.verts.customData.getLayerIndex("displace");
      }

      const ntmp = new Vector3()
      const ntmp2 = new Vector3()

      for (const n2 of nodes) {
        const ilen = n2.indexVerts!.length

        for (let i = 0; i < ilen; i++) {
          const v = n2.indexVerts[i]
          const l = n2.indexLoops[i]

          if (!v || v.eid < 0) {
            vi++
            //debugger;
            continue
          }

          let j

          j = vi * 3

          if (editDisplaced && cd_disp.i >= 0) {
            const dv = v.customData.get(cd_disp)

            const co = dv.worldco
            //co = dv.smoothco;

            if (!norvisit.has(dv)) {
              dv.no.zero()

              for (const f of (v as Vertex).faces) {
                ntmp.load(f.no)
                ntmp2.load(f.cent)

                f.calcNormal(cd_disp.i)
                dv.no.add(f.no)

                f.no.load(ntmp)
                f.cent.load(ntmp2)
              }

              dv.no.normalize()
              norvisit.add(dv)
            }

            if (isDeforming) {
              const n3 = cd_node.get(v).node
              if (!n3?.boxvdata) {
                console.warn('eek!', v, n3)
                vcos[j++] = 0.0
                vcos[j++] = 0.0
                vcos[j++] = 0.0
              } else {
                const uvw = n3.boxvdata.get(v)

                vcos[j++] = uvw[0]
                vcos[j++] = uvw[1]
                vcos[j++] = uvw[2]

                j = vi * 2

                defv[j++] = n3.leafTexUV[0]
                defv[j++] = n3.leafTexUV[1]
              }
            } else {
              vcos[j++] = co[0]
              vcos[j++] = co[1]
              vcos[j++] = co[2]
            }

            j = vi * 3
            vnos[j++] = dv.no[0] * nomul
            vnos[j++] = dv.no[1] * nomul
            vnos[j++] = dv.no[2] * nomul
          } else {
            if (isDeforming) {
              const n3 = cd_node.get(v).node

              if (!n3?.boxvdata) {
                if (Math.random() > 0.97) {
                  console.warn('eek!', v, n3)
                }

                vcos[j++] = 0.0
                vcos[j++] = 0.0
                vcos[j++] = 0.0
              } else {
                const uvw = n3.boxvdata.get(v)

                vcos[j++] = uvw[0]
                vcos[j++] = uvw[1]
                vcos[j++] = uvw[2]

                j = vi * 2

                defv[j++] = n3.leafTexUV[0]
                defv[j++] = n3.leafTexUV[1]
              }
            } else {
              vcos[j++] = v.co[0]
              vcos[j++] = v.co[1]
              vcos[j++] = v.co[2]
            }

            j = vi * 3
            vnos[j++] = v.no[0] * nomul
            vnos[j++] = v.no[1] * nomul
            vnos[j++] = v.no[2] * nomul
          }

          let colormul2 = colormul

          if (drawMask && cd_mask.i >= 0) {
            const mask = v.customData.get(cd_mask).value
            colormul2 *= mask * 0.8 + 0.2
          }

          if (drawCavityMap) {
            let f = vcavity(v)
            f = f * f * (3.0 - 2.0 * f)
            f *= 1.25

            colormul2 *= f
          }

          if (updateColors) {
            if (drawDispDisField && cd_pvert.i >= 0) {
              const pv = v.customData.get(cd_pvert)

              let dis = pv.disUV[0]
              dis = Math.fract(dis * 1.5)

              j = vi * 4

              vcolors[j++] = dis * colormul
              vcolors[j++] = dis * colormul
              vcolors[j++] = dis * colormul
              vcolors[j++] = 1.0
            } else if (cd_color.i >= 0) {
              const c = v.customData.get(cd_color).color

              j = vi * 4

              vcolors[j++] = c[0] * colormul2
              vcolors[j++] = c[1] * colormul2
              vcolors[j++] = c[2] * colormul2
              vcolors[j++] = c[3] * colormul
            } else {
              j = vi * 4

              vcolors[j++] = colormul2
              vcolors[j++] = colormul2
              vcolors[j++] = colormul2
              vcolors[j++] = colormul
            }

            if (cd_fset.i >= 0 && l.eid >= 0 && l instanceof Loop && l.f) {
              j = vi * 4
              const fset = l.f.customData.get(cd_fset).value
              const color = getFaceSetColor(fset)

              vcolors[j++] *= color[0]
              vcolors[j++] *= color[1]
              vcolors[j++] *= color[2]
              vcolors[j++] *= color[3]
            }
          }

          if (updateUvs) {
            const uv = l.customData.get(cd_uv).uv
            j = vi * 2

            vuvs[j++] = uv[0] * uvmul
            vuvs[j++] = uv[1] * uvmul
          }

          vi += 1
        }
      }

      let ti = 0
      let ei = 0
      let base = 0

      for (const n of nodes) {
        const lmap = n.indexTris
        const li = 0

        for (let i = 0; i < lmap.length; i += 3) {
          const i1 = lmap[i] + base
          const i2 = lmap[i + 1] + base
          const i3 = lmap[i + 2] + base

          idx[ti++] = i1
          idx[ti++] = i2
          idx[ti++] = i3
        }

        if (drawWireframe) {
          const emap = n.indexEdges

          for (let i = 0; i < emap.length; i++) {
            lineidx[ei++] = emap[i] + base
          }
        }

        base += n.indexVerts.length
      }

      island.totline = totedge
    }

    function genNodeMesh(node: any): void {
      if (!drawColPatches) {
        return genNodeMesh_index(node)
      }

      if (util.time_ms() - tstart > 15) {
        //return;
      }

      if (node.drawData) {
        node.drawData.reset(gl)
      }

      const vpatch = false
      let vpatch2: boolean | undefined = drawColPatches //drawColPatches;
      let vpatch3: boolean | undefined = false

      vpatch2 = vpatch2 && have_color
      vpatch2 = vpatch2 && !have_grids

      vpatch3 = vpatch3 && have_color
      vpatch3 = vpatch3 && !have_grids

      let lflag = LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.UV | LayerTypes.NORMAL | LayerTypes.ID

      if (vpatch) {
        lflag |= LayerTypes.CUSTOM
      }

      let sm = node.drawData

      let primc1
      let primc2
      let primc3
      let primc4
      let primc5
      let primc6
      let primuv

      if (!sm) {
        sm = new SimpleMesh(lflag)
        if (vpatch) {
          primuv = sm.primuv = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primUV')
          primc1 = sm.primc1 = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc1')
          primc2 = sm.primc2 = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc2')
          primc3 = sm.primc3 = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc3')
          primc4 = sm.primc4 = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc4')
          primc5 = sm.primc5 = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc5')
          primc6 = sm.primc6 = sm.addDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc6')
        }
      } else {
        if (vpatch) {
          primuv = sm.primuv
          primc1 = sm.primc1
          primc2 = sm.primc2
          primc3 = sm.primc3
          primc4 = sm.primc4
          primc5 = sm.primc5
          primc6 = sm.primc6
        }
        if (0 && vpatch) {
          primuv = sm.getDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primUV')
          primc1 = sm.getDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc1')
          primc2 = sm.getDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc2')
          primc3 = sm.getDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc3')
          primc4 = sm.getDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc4')
          primc5 = sm.getDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc5')
          primc6 = sm.getDataLayer(PrimitiveTypes.TRIS, LayerTypes.CUSTOM, 4, 'primc6')
        }
      }

      const island = sm.island

      island.tri_cos.bufferHint = gl.DYNAMIC_DRAW
      island.tri_normals.bufferHint = gl.DYNAMIC_DRAW
      island.tri_uvs.bufferHint = gl.DYNAMIC_DRAW
      island.tri_colors.bufferHint = gl.DYNAMIC_DRAW

      //count triangles
      let tottri = 0

      function countrec(node: any): void {
        if (node.leaf) {
          tottri += node.uniqueTris.size
        } else {
          for (const c of node.children) {
            countrec(c)
          }
        }
      }

      countrec(node)
      if (!tottri) {
        return
      }

      if (!vpatch2) {
        sm.island.setPrimitiveCount(PrimitiveTypes.TRIS, tottri)
      } else {
        sm.island.setPrimitiveCount(PrimitiveTypes.TRIS, 0)
      }

      if (vpatch) {
        primc1 = primc1._getWriteData()
        primc2 = primc2._getWriteData()
        primc3 = primc3._getWriteData()
        primc4 = primc4._getWriteData()
        primc5 = primc5._getWriteData()
        primc6 = primc6._getWriteData()
        primuv = primuv._getWriteData()
      }

      const nmul = sm.island.tri_normals.glSizeMul
      const cmul = sm.island.tri_colors.glSizeMul
      const uvmul = sm.island.tri_uvs.glSizeMul

      const tri_cos = sm.island.tri_cos._getWriteData()
      const tri_nos = sm.island.tri_normals._getWriteData()
      const tri_cls = sm.island.tri_colors._getWriteData()
      const tri_ids = sm.island.tri_ids._getWriteData()
      const tri_uvs = sm.island.tri_uvs._getWriteData()

      let ti = 0

      let colorfilter: (v: Vertex, fac?: number) => Vector4
      const cfrets = util.cachering.fromConstructor(Vector4, 16)

      if (have_grids) {
        colorfilter = function (v, fac = 0.5) {
          const ret = cfrets.next().zero()
          let tot = 0.0

          fac = 1.0 - fac

          for (const v2 of v.neighbors) {
            const clr = v2.customData.get(cd_color).color
            const w = 1.0

            tot += w
            ret.addFac(clr, w)
          }

          if (tot === 0.0) {
            ret.load(v.customData.get(cd_color).color)
          } else {
            ret.mulScalar(1.0 / tot)
            ret.interp(v.customData.get(cd_color).color, fac)
          }

          return ret
        }
      } else {
        colorfilter = function (v, fac = 0.5) {
          const ret = cfrets.next().zero()
          let tot = 0.0
          fac = 1.0 - fac

          for (const e of v.edges) {
            const v2 = e.otherVertex(v)
            const clr = v2.customData.get(cd_color).color
            const w = 1.0

            tot += w
            ret.addFac(clr, w)
          }

          if (tot === 0.0) {
            ret.load(v.customData.get(cd_color).color)
          } else {
            ret.mulScalar(1.0 / tot)
            ret.interp(v.customData.get(cd_color).color, fac)
          }

          return ret
        }
      }

      const tmp1 = new Vector3()
      const tmp2 = new Vector3()
      const tmp3 = new Vector3()
      const tmp4 = new Vector3()
      const tvt = new Vector3()
      const tvn = new Vector3()

      const tn1 = new Vector3()
      const tn2 = new Vector3()
      const tn3 = new Vector3()
      const tn4 = new Vector3()

      const tc1 = new Vector4()
      const tc2 = new Vector4()
      const tc3 = new Vector4()
      const tc4 = new Vector4()
      const tc5 = new Vector4()
      tc1[3] = tc2[3] = tc3[3] = 1.0
      //let cd_node = have_grids ? mesh.loops.customData.getLayerIndex("bvh")
      //                         : mesh.verts.customData.getLayerIndex("bvh");
      const cd_node = bvh.cd_node

      function rec(node: any): void {
        if (!node.leaf) {
          for (const c of node.children) {
            rec(c)
          }

          return
        }

        const n = new Vector3()
        const id = object.lib_id

        tc1.zero().addScalar(1.0)
        tc2.zero().addScalar(1.0)
        tc3.zero().addScalar(1.0)

        function doline(sm: any, t1: Vector3, t2: Vector3, v1: any, v2: any): void {
          if (have_grids) {
            sm.line(t1, t2)
          } else {
            if (mesh.getEdge(v1, v2)) {
              sm.line(t1, t2)
            }
          }
        }

        for (const tri of node.uniqueTris) {
          if (vpatch2) {
            const t1 = tri.v1
            const t2 = tri.v2
            const t3 = tri.v3

            tmp1.load(t1).interp(t2, 0.5)
            tmp2.load(t2).interp(t3, 0.5)
            tmp3.load(t3).interp(t1, 0.5)
            tmp4
              .load(t1)
              .add(t2)
              .add(t3)
              .mulScalar(1.0 / 3.0)

            tn1.load(t1.no).interp(t2.no, 0.5).normalize()
            tn2.load(t2.no).interp(t3.no, 0.5).normalize()
            tn3.load(t3.no).interp(t1.no, 0.5).normalize()
            tn4.load(t1.no).add(t2.no).add(t3.no).normalize()

            const f = mesh.eidMap.get<Face>(tri.id)

            const w1 = 1.0 / 3.0

            let c1 = t1.customData.get(cd_color).color
            let c2 = t2.customData.get(cd_color).color
            let c3 = t3.customData.get(cd_color).color
            if (1) {
              c1 = colorfilter(t1, w1)
              c2 = colorfilter(t2, w1)
              c3 = colorfilter(t3, w1)
            }

            tc1.load(c1).interp(c2, 0.5)
            tc2.load(c2).interp(c3, 0.5)
            tc3.load(c3).interp(c1, 0.5)

            tc4
              .load(c1)
              .add(c2)
              .add(c3)
              .mulScalar(1.0 / 3.0)

            tc5.zero()
            let tot = 0.0
            for (const l of f.lists[0]) {
              tc5.add(colorfilter(l.v, w1))
              tot++
            }
            tc5.mulScalar(1.0 / tot)

            const ca = t1.customData.get(cd_color).color
            const cb = t2.customData.get(cd_color).color
            const cc = t3.customData.get(cd_color).color

            const startl = f.lists[0].l

            const w2 = 1.0 / 6.0

            ///*
            if (f.lists[0].length > 3) {
              if (startl.next.v === tri.v2) {
                tc3.load(tc5)
                tmp3.load(f.cent)
              } else if (startl.next.v === tri.v3) {
                tc2.load(tc5)
                tmp2.load(f.cent)
              } else {
                tc1.load(tc5)
                tmp1.load(f.cent)
              } //*/
            }

            tc5.load(ca).interp(cb, 0.5)
            tc1.interp(tc5, w2)

            tc5.load(cb).interp(cc, 0.5)
            tc2.interp(tc5, w2)

            tc5.load(cc).interp(ca, 0.5)
            tc3.interp(tc5, w2)

            const n = math.normal_tri(t1, t2, t3)

            const q1 = sm.quad(tmp4, tmp3, t1, tmp1)
            q1.normals(tn4, tn3, t1.no, tn1)
            q1.colors(tc4, tc3, c1, tc1)
            //q1.id(id, id, id, id);

            const q2 = sm.quad(tmp4, tmp1, t2, tmp2)
            q2.normals(tn4, tn1, t2.no, tn2)
            q2.colors(tc4, tc1, c2, tc2)
            //q2.id(id, id, id, id);

            const q3 = sm.quad(tmp4, tmp2, t3, tmp3)
            q3.normals(tn4, tn2, t3.no, tn3)
            q3.colors(tc4, tc2, c3, tc3)
            //q3.id(id, id, id, id);

            continue
          }
          /*
          t1.load(tri.v1);
          t2.load(tri.v2);
          t3.load(tri.v3);


          for (let i=0; i<3; i++) {
            t1[i] += (Math.random()-0.5)*0.05;
            t2[i] += (Math.random()-0.5)*0.05;
            t3[i] += (Math.random()-0.5)*0.05;

          }//*/

          //*
          const tv1 = tri.v1
          const tv2 = tri.v2
          const tv3 = tri.v3
          t1 = tv1.co
          t2 = tv2.co
          t3 = tv3.co
          //*/

          let i = ti * 3
          tri_cos[i++] = t1[0]
          tri_cos[i++] = t1[1]
          tri_cos[i++] = t1[2]

          tri_cos[i++] = t2[0]
          tri_cos[i++] = t2[1]
          tri_cos[i++] = t2[2]

          tri_cos[i++] = t3[0]
          tri_cos[i++] = t3[1]
          tri_cos[i++] = t3[2]

          let no1
          let no2
          let no3

          if (!drawFlat && nsmooth !== undefined) {
            no1 = nsmooth(t1)
            no2 = nsmooth(t2)
            no3 = nsmooth(t3)
          } else {
            no1 = tri.no
            no2 = tri.no
            no3 = tri.no
          }

          i = ti * 3
          tri_nos[i++] = no1[0] * nmul
          tri_nos[i++] = no1[1] * nmul
          tri_nos[i++] = no1[2] * nmul

          tri_nos[i++] = no2[0] * nmul
          tri_nos[i++] = no2[1] * nmul
          tri_nos[i++] = no2[2] * nmul

          tri_nos[i++] = no3[0] * nmul
          tri_nos[i++] = no3[1] * nmul
          tri_nos[i++] = no3[2] * nmul

          i = ti
          tri_ids[i++] = id
          tri_ids[i++] = id
          tri_ids[i++] = id

          if (haveUvs) {
            let uv1
            let uv2
            let uv3

            if (have_grids) {
              uv1 = tv1.customData.get(cd_uv).uv
              uv2 = tv2.customData.get(cd_uv).uv
              uv3 = tv3.customData.get(cd_uv).uv
            } else {
              const ltris = mesh._ltris

              let l1
              let l2
              let l3
              let bad = false

              if (tri.l1) {
                l1 = tri.l1
                l2 = tri.l2
                l3 = tri.l3
              } else if (tri.tri_idx % 3 === 0) {
                l1 = ltris![tri.tri_idx]
                l2 = ltris![tri.tri_idx + 1]
                l3 = ltris![tri.tri_idx + 2]
              } else {
                bad = true
              }

              bad = bad || !l1 || !l2 || !l3

              if (!bad) {
                uv1 = l1.customData.get(cd_uv).uv
                uv2 = l2.customData.get(cd_uv).uv
                uv3 = l3.customDat.geta(cd_uv).uv
              } else {
                const f = mesh.eidMap.get<Face>(tri.id)

                l1 = l2 = l3 = undefined

                for (const l of f.loops) {
                  if (l.v === tri.v1) {
                    l1 = l
                  } else if (l.v === tri.v2) {
                    l2 = l
                  } else if (l.v === tri.v3) {
                    l3 = l
                  }
                }

                if (l1 && l2 && l3) {
                  uv1 = l1.customData.get(cd_uv).uv
                  uv2 = l2.customData.get(cd_uv).uv
                  uv3 = l3.customData.get(cd_uv).uv
                } else {
                  uv1 = uv2 = uv3 = undefined
                }
              }
            }

            i = ti * 2

            if (uv1 && uv2 && uv3) {
              tri_uvs[i++] = uv1[0] * uvmul
              tri_uvs[i++] = uv1[1] * uvmul
              tri_uvs[i++] = uv2[0] * uvmul
              tri_uvs[i++] = uv2[1] * uvmul
              tri_uvs[i++] = uv3[0] * uvmul
              tri_uvs[i++] = uv3[1] * uvmul
            }
          }

          let cv1 = 1.0
          let cv2 = 1.0
          let cv3 = 1.0

          if (drawCavityMap) {
            cv1 = vcavity(tri.v1)
            cv2 = vcavity(tri.v2)
            cv3 = vcavity(tri.v3)

            if (!have_color) {
              for (let j = 0; j < 3; j++) {
                tc1[j as Number3] = cv1
                tc2[j as Number3] = cv2
                tc3[j as Number3] = cv3
              }
              tc1[3] = tc2[3] = tc3[3] = 1.0
            }
          }

          if (drawNodeIds && cd_node.i >= 0) {
            const node1 = tri.v1.customData[cd_node.i].node
            const node2 = tri.v2.customData[cd_node.i].node
            const node3 = tri.v3.customData[cd_node.i].node

            const id1 = node1 ? node1._id : 0
            const id2 = node2 ? node2._id : 0
            const id3 = node3 ? node3._id : 0

            tc1[0] = Math.fract(id1 * 13.234344)
            tc2[0] = Math.fract(id2 * 13.234344)
            tc3[0] = Math.fract(id3 * 13.234344)

            tc1[1] = tc2[1] = tc3[1] = 0.5
          } else if (have_color) {
            //*
            const c1 = tri.v1.customData.get(cd_color).color
            const c2 = tri.v2.customData.get(cd_color).color
            const c3 = tri.v3.customData.get(cd_color).color
            //*/

            tc1.load(c1)
            tc2.load(c2)
            tc3.load(c3)

            for (const j of IndexRange(3)) {
              tc1[j] *= cv1
              tc2[j] *= cv2
              tc3[j] *= cv3
            }

            if (!c1 || !c2 || !c3) {
              let v = !c1 ? tri.v1 : undefined

              v = !v && !c2 ? tri.v2 : v
              v = !v && !c3 ? tri.v3 : v

              let l = v.loopEid
              l = mesh.eidMap.get(l)
              if (l && l.eid === v.loopEid) {
                l.customData.get(bvh.cd_grid).checkCustomDataLayout(mesh)
              }
            }
            /*
            let c1 = colorfilter(tri.v1);
            let c2 = colorfilter(tri.v2);
            let c3 = colorfilter(tri.v3);
            //*/

            //tri2.custom(primc1, c1, c1, c1);
            //tri2.custom(primc2, c2, c2, c2);
            //tri2.custom(primc3, c3, c3, c3);
          }

          if (vpatch) {
            const c1 = colorfilter(tri.v1, 1)
            const c2 = colorfilter(tri.v2, 1)
            const c3 = colorfilter(tri.v3, 1)

            i = ti * 4
            primuv[i++] = puv1[0]
            primuv[i++] = puv1[1]
            i += 2
            primuv[i++] = puv2[0]
            primuv[i++] = puv2[1]
            i += 2
            primuv[i++] = puv3[0]
            primuv[i++] = puv3[1]
            i += 2

            i = ti * 4

            const ca = tri.v1.customData.get(cd_color).color
            const cb = tri.v2.customData.get(cd_color).color
            const cc = tri.v3.customData.get(cd_color).color

            for (let j = 0; j < 12; j++) {
              primc1[i + j] = ca[j % 4]
              primc2[i + j] = cb[j % 4]
              primc3[i + j] = cc[j % 4]

              primc4[i + j] = c1[j % 4]
              primc5[i + j] = c2[j % 4]
              primc6[i + j] = c3[j % 4]
            }
          }

          i = ti * 4

          tri_cls[i++] = tc1[0] * cmul
          tri_cls[i++] = tc1[1] * cmul
          tri_cls[i++] = tc1[2] * cmul
          tri_cls[i++] = tc1[3] * cmul

          tri_cls[i++] = tc2[0] * cmul
          tri_cls[i++] = tc2[1] * cmul
          tri_cls[i++] = tc2[2] * cmul
          tri_cls[i++] = tc2[3] * cmul

          tri_cls[i++] = tc3[0] * cmul
          tri_cls[i++] = tc3[1] * cmul
          tri_cls[i++] = tc3[2] * cmul
          tri_cls[i++] = tc3[3] * cmul

          ti += 3

          //*
          if (drawWireframe) {
            doline(sm, t1, t2, tri.v1, tri.v2)
            doline(sm, t2, t3, tri.v2, tri.v3)
            doline(sm, t3, t1, tri.v3, tri.v1)
          }
          //*/
          /*
          continue

          const tri2 = sm.tri(t1, t2, t3)

          if (haveUvs) {
            let uv1, uv2, uv3

            if (have_grids) {
              uv1 = t1.customData[cd_uv].uv
              uv2 = t2.customData[cd_uv].uv
              uv3 = t3.customData[cd_uv].uv
            } else {
              const ltris = mesh.loopTris

              const l1 = ltris[tri.tri_idx]
              const l2 = ltris[tri.tri_idx + 1]
              const l3 = ltris[tri.tri_idx + 2]

              uv1 = l1.customData[cd_uv].uv
              uv2 = l2.customData[cd_uv].uv
              uv3 = l3.customData[cd_uv].uv
            }

            tri2.uvs(uv1, uv2, uv3)
          }
          //n.load(tri.v1.no).add(tri.v2.no).add(tri.v3.no).normalize();

          if (!drawFlat) {
            tri2.normals(tri.v1.no, tri.v2.no, tri.v3.no)
          } else {
            //n.load(tri.no);
            //n.load(tri.v1.no).add(tri.v2.no).add(tri.v3.no).normalize();
            n.load(math.normal_tri(tri.v1, tri.v2, tri.v3))
            tri2.normals(n, n, n)
          }

          tri2.custom(primuv, puv1, puv2, puv3)

          tri2.ids(id, id, id)

          //let cv1 = 1.0, cv2=1.0, cv3=1.0;

          if (drawCavityMap) {
            cv1 = vcavity(tri.v1)
            cv2 = vcavity(tri.v2)
            cv3 = vcavity(tri.v3)

            if (!have_color) {
              for (let j = 0; j < 3; j++) {
                tc1[j] = cv1
                tc2[j] = cv2
                tc3[j] = cv3
              }
              tc1[3] = tc2[3] = tc3[3] = 1.0

              tri2.colors(tc1, tc2, tc3)
            }
          }

          if (drawNodeIds && cd_node.i >= 0) {
            const node1 = tri.v1.customData[cd_node.i].node
            const node2 = tri.v2.customData[cd_node.i].node
            const node3 = tri.v3.customData[cd_node.i].node

            const id1 = node1 ? node1._id : 0
            const id2 = node2 ? node2._id : 0
            const id3 = node3 ? node3._id : 0

            tc1[0] = Math.fract(id1 * 3.234344)
            tc2[0] = Math.fract(id2 * 3.234344)
            tc3[0] = Math.fract(id3 * 3.234344)

            tc1[1] = tc2[1] = tc3[1] = 0.5

            tri2.colors(tc1, tc2, tc3)
          } else if (have_color) {
            //const c1 = tri.v1.customData[cd_color].color
            //const c2 = tri.v2.customData[cd_color].color
            //const c3 = tri.v3.customData[cd_color].color
            
            tc1.load(c1)
            tc2.load(c2)
            tc3.load(c3)

            for (let j = 0; j < 3; j++) {
              tc1[j] *= cv1
              tc2[j] *= cv2
              tc3[j] *= cv3
            }

            if (!c1 || !c2 || !c3) {
              let v = !c1 ? tri.v1 : undefined

              v = !v && !c2 ? tri.v2 : v
              v = !v && !c3 ? tri.v3 : v

              let l = v.loopEid
              l = mesh.eidMap.get(l)
              if (l && l.eid === v.loopEid) {
                l.customData[bvh.cd_grid].checkCustomDataLayout(mesh)
              }

              console.error('customdata error', c1, c2, c3, tri)
              tri2.colors(red, red, red)
              continue
            }
            
            //let c1 = colorfilter(tri.v1);
            //let c2 = colorfilter(tri.v2);
            //let c3 = colorfilter(tri.v3);

            //tri2.custom(primc1, c1, c1, c1);
            //tri2.custom(primc2, c2, c2, c2);
            //tri2.custom(primc3, c3, c3, c3);

            tri2.colors(tc1, tc2, tc3)
          } else {
            tri2.colors(white, white, white)
          }
          */
        }
      }

      rec(node)
      sm.gen = 0
      node.drawData = sm
    }

    const axismat = new Matrix4()

    for (const node of bvh.nodes) {
      if (node.drawData && !(node.flag & BVHFlags.TEMP_TAG)) {
        node.drawData.destroy(gl)
        node.drawData = undefined
        continue
      }

      if (node.flag & BVHFlags.TEMP_TAG) {
        let update = !!(node.flag & BVHFlags.UPDATE_DRAW)
        update = update || !node.drawData

        if (update) {
          genNodeMesh(node)
          node.flag &= ~BVHFlags.UPDATE_DRAW
        }

        if (!node.drawData) {
          continue
        }

        let f = node.id * 0.1 * Math.sqrt(3.0)
        f = Math.fract(f * 10.0)

        let program2

        if (isDeforming) {
          program2 = Shaders.SculptShaderHexDeform
        } else if (drawColPatches) {
          program2 = Shaders.SculptShader
        } else {
          program2 = Shaders.SculptShaderSimple
        }

        if (!drawBVH) {
          uniforms.uColor = [1, 1, 1, 1]
        } else {
          let f2 = 1.0
          if (update) {
            f2 = 0.5
          }

          if (!node.__id2) {
            node.__id2 = ~~(Math.random() * 1024 * 1024)
          }

          uniforms.uColor = [f * f2, f2 * Math.fract(f * 3.23423 + 0.432), f2 * Math.fract(f * 5.234 + 0.13432), 1.0]
        }

        uniforms.alpha = 1.0

        const tex = this.ctx.activeTexture
        if (tex) {
          const gltex = tex.getGlTex(gl)
          if (gltex) {
            uniforms.text = gltex
            uniforms.hasTexture = 1.0
          } else {
            uniforms.text = undefined
            uniforms.hasTexture = 0.0
          }
        } else {
          uniforms.text = undefined
          uniforms.hasTexture = 0.0
        }

        uniforms.iTime = util.time_ms() / 10000.0

        if (node.drawData.gen === 0) {
          //  uniforms.uColor = [f, f, f, 1.0];
        }

        for (const axis of axes) {
          const oldmat = uniforms.objectMatrix

          if (axis !== -1) {
            const scale = [1, 1, 1]
            scale[axis] = -1

            //let imat = new Matrix4(object.outputs.matrix.getValue());
            //let mat2 = new Matrix4(uniforms.objectMatrix);

            //imat.invert();
            //mat2.multiply(imat);

            const mat2 = new Matrix4()
            mat2.scale(scale[0], scale[1], scale[2])

            mat2.preMultiply(object.outputs.matrix.getValue())

            uniforms.objectMatrix = mat2
          }

          if (drawFlat) {
            program2.defines.DRAW_FLAT = null
          } else {
            delete program2.defines.DRAW_FLAT
          }

          if (!('ddd' in window)) {
            //window.ddd = 0;
          }

          if (isDeforming) {
            if (!program2.defines.WITH_BOXVERTS) {
              const dimen = bvh.glLeafTex.createParams.width

              uniforms.nodeDefTex = bvh.glLeafTex
              uniforms.nodeDefTexDu = 1.0 / dimen + 0.00001
              uniforms.nodeDefTexUV = node.leafTexUV
            } else {
              for (let i = 0; i < 8; i++) {
                const key = `boxverts[${i}]`
                //uniforms[key] = new Vector3(node.boxverts[(i+window.ddd)%8]);
                uniforms[key] = new Vector3(node.boxverts[i])
                //let loc = program2.uniformloc(key);
                //gl.uniform3fv(loc, new Vector3(node.boxverts[i]));
              }
            }
          }

          if (drawWireframe) {
            //uniforms.polygonOffset = window.d || 10.0;
            let off = uniforms.polygonOffset ?? 0.0
            const old = off
            off = off !== 0.0 ? off * 2.0 : 0.2

            uniforms.polygonOffset = off
            const clr = uniforms.uColor
            uniforms.uColor = [0, 0, 0, 1]
            node.drawData.drawLines(gl, uniforms, program2)
            uniforms.uColor = clr
            uniforms.polygonOffset = old
          }

          node.drawData.primflag &= ~PrimitiveTypes.LINES
          node.drawData.draw(gl, uniforms, program2)

          if (drawWireframe) {
            // uniforms.polygonOffset = window.d || 10.0;
            //node.drawData.drawLines(gl, uniforms, program2);
            //uniforms.polygonOffset = 0.0;
          }

          uniforms.objectMatrix = oldmat
        }

        if (0) {
          uniforms.alpha = 0.5

          gl.depthMask(false)
          gl.disable(gl.DEPTH_TEST)
          gl.enable(gl.CULL_FACE)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

          node.drawData.draw(gl, uniforms, program2)

          gl.depthMask(true)
          gl.disable(gl.CULL_FACE)
          gl.disable(gl.BLEND)
          gl.enable(gl.DEPTH_TEST)
        }

        gl.disable(gl.CULL_FACE)
        node.drawData.gen++
      }

      node.flag &= ~(BVHFlags.TEMP_TAG | BVHFlags.UPDATE_DRAW)
    }

    if (0 && have_grids) {
      //XXX make this an option
      for (const loop of mesh.loops) {
        const grid = loop.customData[grid_off] as GridBase
        grid.debugDraw(gl, uniforms, object)
      }
    }

    return true
  }

  dataLink(scene: Scene, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser): void {
    for (const k in this.slots) {
      this.slots[k].dataLink(scene, getblock, getblock_addUser)
    }

    for (const tool of enumValues(SculptTools)) {
      if (!(tool in this.slots)) {
        this.slots[tool as unknown as number] = new PaintToolSlot(tool as SculptTools)
      }
    }
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)

    //deal with old files
    if (Array.isArray(this.slots)) {
      const slots = this.slots
      this.slots = {}

      for (const slot of slots) {
        this.slots[slot.tool] = slot
      }
    }

    // also happens in old files
    if ('brush' in this) {
      this.tool = (this as unknown as any)['brush'].tool
      delete this.brush
    }
  }
}

// NOTE: BVHToolMode is registered through the pbvh_sculpt addon's register()
// lifecycle (api.register), NOT at module scope — so disabling the addon
// removes its toolmode (and viewport header icon). See addons/builtin/
// pbvh_sculpt/src/main.ts.
