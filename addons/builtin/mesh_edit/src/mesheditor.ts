import {FindNearest, FindNearestRet} from '@framework/api'
import {ToolMode} from '@framework/api'
import {HotKey, KeyMap} from '@framework/pathux'
import {Icons} from '@framework/api'
import {SelMask} from '@framework/api'
import '../../../../scripts/path.ux/scripts/util/struct.js'
import {MeshToolBase} from './meshtool'
import {Vector2, Vector3, Matrix4} from '@framework/api'
import {Shaders} from '@framework/api'
import {util} from '@framework/api'

import {AttrRef, ColorLayerElem, Mesh, Vertex} from '../../mesh/src/mesh.js'
import {Vector4, Number3} from '@framework/api'
import {ToolMacro, startMenu, createMenu, nstructjs} from '@framework/pathux'
import {PackFlags} from '@framework/api'
import {InflateWidget, RotateWidget, ScaleWidget, TranslateWidget} from '@framework/api'
import {LayerTypes, PrimitiveTypes, SimpleMesh} from '@framework/api'
import {CurvVert, getCurveVerts} from '../../mesh/src/mesh_curvature.js'
import {getFaceSets} from '../../mesh/src/mesh_facesets.js'
import type {SceneObject} from '@framework/api'
import {UniformTriRemesher} from '../../mesh/src/mesh_remesh.js'
import type {BlockLoader, BlockLoaderAddUser, DataRef} from '@framework/api'
import type {Scene} from '@framework/api'
import type {ViewContext} from '@framework/api'
import type {View3D} from '@framework/api'
import type {StructReader} from '@framework/api'

export class MeshEditor extends MeshToolBase {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
mesh_edit.MeshEditor {
  mesh                : DataRef | DataRef.fromBlock(obj.mesh);
  drawflag            : int;
  drawLoops           : bool;
  drawCurvatures      : bool;
  drawNormals         : bool;
}`
  )

  drawflag = 0
  loopMesh: SimpleMesh | undefined
  normalMesh: SimpleMesh | undefined
  curvatureMesh: SimpleMesh | undefined
  selectMask: number
  drawNormals: boolean
  drawSelectMask: number
  drawLoops: boolean
  drawCurvatures: boolean
  _last_update_loop_key: string
  _last_normals_key: string
  _last_update_curvature: string

  mesh: Mesh | undefined
  sceneObject?: SceneObject

  constructor(ctx: ViewContext) {
    super(ctx)

    this.loopMesh = undefined
    this.normalMesh = undefined

    this.selectMask = SelMask.VERTEX

    this.drawNormals = false
    this.drawSelectMask = this.selectMask
    this.drawLoops = false
    this.drawCurvatures = false

    this._last_update_loop_key = ''
    this._last_normals_key = ''
    this._last_update_curvature = ''
  }

  static toolModeDefine() {
    return {
      name        : 'mesh',
      uiname      : 'Edit Geometry',
      icon        : Icons.MESHTOOL,
      flag        : 0,
      selectMode  : 1 | 2 | 4 | 8 | 16 | 32,
      description : 'Edit vertices/edges/faces',
      transWidgets: [TranslateWidget, ScaleWidget, RotateWidget, InflateWidget],
    }
  }

  static buildEditMenu(): string[] {
    return [
      'mesh.delete_selected()',
      'mesh.toggle_select_all()',
      'mesh.subdivide_smooth()',
      'mesh.subdivide_simple()',
      'mesh.extrude_regions(transform=true)',
      'mesh.vertex_smooth()',
      "mesh.select_more_less(mode='ADD')",
      "mesh.select_more_less(mode='SUB')",
      "mesh.select_linked(mode='ADD')",
      'mesh.create_face()',
    ]
  }

  static buildElementSettings(container: any): void {
    super.buildElementSettings(container)
    const path = 'scene.tools.' + this.toolModeDefine().name
  }

  static buildSettings(container: any): void {
    container.useIcons()

    const twocol = container.twocol(2)
    const column1 = twocol.col()
    const column2 = twocol.col()

    let strip: any
    let panel: any

    const path = 'scene.tools.' + this.toolModeDefine().name

    panel = column1.panel('Viewport')
    strip = panel.row().strip()

    strip.prop(path + '.drawLoops')
    strip.prop(path + '.drawCurvatures')
    strip.prop(path + '.drawNormals')

    panel = column1.panel('Tools')
    strip = panel.row().strip()

    strip.tool('mesh.select_brush()')

    strip.tool('mesh.edgecut()')
    strip.tool(`mesh.delete_selected()`)

    strip = panel.row().strip()
    strip.tool('mesh.bisect()')
    strip.tool('mesh.symmetrize()')

    strip = panel.row().strip()
    strip.tool('mesh.flip_long_tris()')
    strip.tool('mesh.tris_to_quads()')
    strip.tool('mesh.triangulate()')

    panel = column1.panel('Misc Tools')

    panel.toolPanel('mesh.test_solver()').closed = true

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.subdivide_smooth()')
    strip.tool('mesh.vertex_smooth()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.smooth_curvature_directions()')
    strip.tool('mesh.mark_singularity()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.unmark_singularity()')
    strip.tool('mesh.relax_rake_uv_cells()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.fix_normals()')
    strip.tool('mesh.test_multigrid_smooth()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.split_edges()')
    strip.tool('mesh.split_edges_smart()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.dissolve_verts()')
    strip.tool('mesh.cleanup_quads()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.cleanup_tris()')
    strip.tool('mesh.rotate_edges()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.collapse_edges()')
    strip.tool('mesh.dissolve_edges()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.random_flip_edges()')
    strip.tool('mesh.dissolve_edgeloops()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.select_shortest_edgeloop()')
    strip.tool('mesh.select_longest_edgeloop()')

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.button('Dissolve Shortest Loop', () => {
      const ctx = strip.ctx

      //let tool1 = ctx.api.createTool(ctx, "mesh.toggle_select_all(mode='ADD')");
      //let tool2 = ctx.api.createTool(ctx, "mesh.tris_to_quads(mode='ADD')");
      const tool3 = ctx.api.createTool(ctx, 'mesh.select_shortest_edgeloop()')
      const tool4 = ctx.api.createTool(ctx, 'mesh.dissolve_edgeloops()')

      const macro = new ToolMacro()
      //macro.add(tool1);
      //macro.add(tool2);
      macro.add(tool3)
      macro.add(tool4)

      ctx.api.execTool(ctx, macro)
    })
    strip.button('Dissolve Longest Loop', () => {
      const ctx = strip.ctx

      //let tool1 = ctx.api.createTool(ctx, "mesh.toggle_select_all(mode='ADD')");
      //let tool2 = ctx.api.createTool(ctx, "mesh.tris_to_quads(mode='ADD')");
      const tool3 = ctx.api.createTool(ctx, 'mesh.select_longest_edgeloop()')
      const tool4 = ctx.api.createTool(ctx, 'mesh.dissolve_edgeloops()')

      const macro = new ToolMacro()
      //macro.add(tool1);
      //macro.add(tool2);
      macro.add(tool3)
      macro.add(tool4)

      ctx.api.execTool(ctx, macro)
    })

    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool('mesh.flip_normals')
    strip.tool('mesh.bevel')
    strip.tool('mesh.inset_regions')

    panel = column1.panel('Transform')

    strip = panel.row().strip()
    strip.useIcons(true)
    strip.prop('scene.propEnabled')
    strip.useIcons(false)
    strip.prop('scene.propMode')

    strip = panel.row().strip()
    strip.prop('scene.propRadius')

    panel = column2.panel('Remeshing')
    strip = panel.row().strip()
    strip.useIcons(false)
    strip.tool("mesh.remesh(remesher='UNIFORM_TRI')|Tri Remesh")
    strip.tool("mesh.remesh(remesher='UNIFORM_QUAD')|Quad Remesh")

    panel.toolPanel('mesh.interactive_remesh()')
    strip = panel.row().strip()

    strip.tool("mesh.interactive_remesh(mode='GEN_CROSSFIELD')", {
      label: 'CrossField Gen',
    })
    strip.tool("mesh.interactive_remesh(mode='OPT_CROSSFIELD')", {
      label: 'CrossField Opt',
    })

    panel.toolPanel('mesh.opt_remesh_params()').closed = true

    panel = column2.panel('UV')

    strip = panel.col().strip()
    strip.useIcons(false)
    strip.tool("mesh.set_flag(elemMask='EDGE' flag='SEAM')", {label: 'Set Seam'})
    strip.tool("mesh.clear_flag(elemMask='EDGE' flag='SEAM')", {label: 'Clear Seam'})
    strip.tool("mesh.toggle_flag(elemMask='EDGE' flag='SEAM')", {label: 'Toggle Seam'})

    panel = column2.panel('MultiRes')

    strip = panel.row().strip()
    strip.tool('mesh.add_or_subdivide_grids()')
    strip.tool('mesh.reset_grids()')
    strip.tool('mesh.delete_grids()')

    strip = panel.row().strip()
    strip.tool('mesh.apply_grid_base()')
    strip.tool('mesh.smooth_grids()')
    strip.tool('mesh.grids_test()')

    panel = column2.panel('Non-Manifold')
    strip = panel.row().strip()
    strip.tool('mesh.select_non_manifold')
    strip.tool('mesh.fix_manifold')
  }

  static buildHeader(header: any, addHeaderRow: () => any): void {
    header.prop('mesh.symFlag')

    const row = addHeaderRow()

    let strip = row.strip()

    strip.useIcons()
    strip.inherit_packflag |= PackFlags.HIDE_CHECK_MARKS

    strip.prop('scene.selectMaskEnum[VERTEX]')
    if (this.haveHandles()) {
    }
    strip.prop('scene.selectMaskEnum[EDGE]')
    strip.prop('scene.selectMaskEnum[FACE]')

    strip = row.strip()
    strip.tool('mesh.toggle_select_all()')
    strip.tool('mesh.select_brush()')

    strip = row.strip()
    strip.tool('mesh.edgecut()')
    strip.tool('mesh.subdivide_smooth()')
    strip.tool('mesh.vertex_smooth()')

    strip = row.strip()
    strip.prop('scene.tool.transformWidget[translate]')
    strip.prop('scene.tool.transformWidget[scale]')
    strip.prop('scene.tool.transformWidget[rotate]')
    strip.prop('scene.tool.transformWidget[inflate]')
    strip.prop('scene.tool.transformWidget[NONE]')

    /*
    strip.tool("mesh.add_or_subdivide_grids()");
    strip.tool("mesh.reset_grids()");
    strip.tool("mesh.delete_grids()");
    strip.tool("mesh.apply_grid_base()");
    strip.tool("mesh.smooth_grids()");
    strip.tool("mesh.grids_test()");
     */

    strip = row.strip()
    strip.tool('mesh.symmetrize()')
    strip.tool('mesh.bisect()')
    strip.tool(`mesh.delete_selected`)

    strip = row.strip()
    strip.pathlabel('mesh.triCount', 'Triangles')
  }

  static haveHandles(): boolean | undefined {
    return false
  }

  static defineAPI(api: any): any {
    const tstruct = super.defineAPI(api)

    const mstruct = api.mapStruct(Mesh, false)

    tstruct.struct('mesh', 'mesh', 'Mesh', mstruct)
    tstruct.bool('drawLoops', 'drawLoops', 'Draw Loops').icon(Icons.SHOW_LOOPS)
    tstruct.bool('drawCurvatures', 'drawCurvatures', 'Draw Curvatures').icon(Icons.SHOW_CURVATURE)
    tstruct.bool('drawNormals', 'drawNormals', 'Draw Normals').icon(Icons.SHOW_NORMALS)

    const onchange = () => {
      window.redraw_viewport()
    }

    return tstruct
  }

  defineKeyMap(): KeyMap {
    this.keymap = new KeyMap([
      new HotKey('A', [], "mesh.toggle_select_all(mode='AUTO')"),
      new HotKey('A', ['alt'], "mesh.toggle_select_all(mode='SUB')"),
      new HotKey('J', ['alt'], 'mesh.tris_to_quads()'),
      new HotKey('J', [], 'mesh.connect_verts()'),
      new HotKey('S', ['alt'], 'view3d.inflate()'),
      new HotKey('S', ['ctrl', 'alt'], 'view3d.to_sphere()'),
      new HotKey('G', ['shift'], () => {
        const template = ["mesh.select_similar(mode='NUMBER_OF_EDGES')|Number of Edges"]

        const menu = createMenu(this.ctx, 'Select Similar', template)
        const screen = this.ctx.screen

        startMenu(menu, screen.mpos[0], screen.mpos[1])
      }),

      //new HotKey("T", [], "mesh.quad_smooth()"),

      //new HotKey("D", [], "mesh.subdivide_smooth()"),
      //new HotKey("D", [], "mesh.subdivide_smooth_loop()"),
      new HotKey('Y', [], 'mesh.test_color_smooth()'),
      new HotKey('D', [], 'mesh.dissolve_verts()'),
      new HotKey('D', ['shift'], 'mesh.duplicate()'),
      new HotKey('K', [], 'mesh.subdiv_test()'),
      //new HotKey("D", [], "mesh.test_collapse_edge()"),
      new HotKey('F', [], 'mesh.create_face()'),
      new HotKey('G', [], "view3d.translate(selmask='VERTEX|HANDLE')"),
      new HotKey('R', [], "view3d.rotate(selmask='VERTEX|HANDLE')"),
      new HotKey('L', [], 'mesh.pick_select_linked()'),
      new HotKey('=', ['ctrl'], "mesh.select_more_less(mode='ADD')"),
      new HotKey('-', ['ctrl'], "mesh.select_more_less(mode='SUB')"),
      new HotKey('L', ['shift'], 'mesh.pick_select_linked(mode="SUB")'),
      new HotKey('X', [], 'mesh.delete_selected()'),

      new HotKey('E', [], 'mesh.extrude_regions(transform=true)'),
      new HotKey('E', ['alt'], 'mesh.extrude_individual_faces(transform=true)'),

      new HotKey('R', ['shift'], 'mesh.edgecut()'),
      new HotKey('I', ['ctrl'], 'mesh.select_inverse()'),
      new HotKey('C', [], 'mesh.select_brush()'),
    ])

    return this.keymap
  }

  getMeshPaths(): string[] {
    const rets: string[] = []

    //for (let ob of this.ctx.selectedMeshObjects) {
    //  let path  = `library.mesh[${ob.lib_id}]`
    //}

    if (this.meshPath === undefined) {
      this._getObject()

      if (this.sceneObject !== undefined) {
        const ob = this.sceneObject
        //set path to parent SceneObject so resolveMesh knows to
        //set ownerMatrix and ownerId
        const path = `objects[${ob.lib_id}]`
        return [path]
      } else {
        return []
      }
      //let path = "scene.tools." + this.constructor.toolModeDefine().name;
      //path += ".mesh";
    }

    return [this.meshPath]
  }

  on_mousedown(e: any, x: number, y: number, was_touch: boolean): any {
    return super.on_mousedown(e, x, y, was_touch)
  }

  onActive(): void {
    super.onActive()
  }

  onInactive(): void {
    super.onInactive()
  }

  _getObject(): void {
    const ctx = this.ctx

    if (!ctx?.object || !(ctx.object.data instanceof Mesh)) {
      this.sceneObject = undefined
      this.mesh = undefined

      return
    }

    this.sceneObject = ctx.object
    this.mesh = this.sceneObject.data as Mesh
    this.mesh.owningToolMode = this.constructor.toolModeDefine().name
  }

  update(): this {
    this._getObject()
    super.update()
    return this
  }

  findnearest3d(view3d: View3D, x: number, y: number, selmask: number): FindNearestRet<unknown>[] {
    /*
    make sure findnearest api gets the right mesh
    */
    //let ctx = this.buildFakeContext(this.ctx);
    const ctx = this.ctx
    return FindNearest(ctx, selmask, new Vector2([x, y]), view3d)
  }

  on_mousemove(e: PointerEvent, x: number, y: number, was_touch?: boolean): boolean | void {
    return super.on_mousemove(e, x, y, was_touch)
  }

  updateCurvatureMesh(gl: WebGL2RenderingContext): void {
    const mesh = this.mesh!
    const key = '' + mesh.lib_id + ':' + mesh.updateGen + ':' + mesh.verts.length + ':' + mesh.eidgen.cur

    const cd_curv = new AttrRef<CurvVert>(getCurveVerts(mesh))

    //CurvVert.propegateUpdateFlags(mesh, cd_curv);
    const cd_cotan = mesh.verts.customData.getLayerIndex('cotan')
    const cd_fset = getFaceSets(mesh, false)

    /*
    for (let v of mesh.verts) {
      let cv = v.customData[cd_curv];
      cv.check(v, cd_cotan, undefined, cd_fset);
    }*/

    if (this.curvatureMesh && key === this._last_update_curvature) {
      return
    }

    if (this.curvatureMesh) {
      this.curvatureMesh.destroy(gl)
    }

    this._last_update_curvature = key

    const sm = (this.curvatureMesh = new SimpleMesh(LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.UV))
    sm.primflag = PrimitiveTypes.LINES

    const co1 = new Vector3()
    const co2 = new Vector3()

    const white = new Vector4([1, 1, 1, 1])

    let no = new Vector3()

    const amat = new Float64Array(16)
    const mat = new Matrix4()

    const VIS_UV_COLORS = false

    const cd_vis = new AttrRef<ColorLayerElem>(-1)

    if (VIS_UV_COLORS) {
      cd_vis.i = mesh.verts.customData.getNamedLayerIndex('_rakevis', 'color')

      if (cd_vis.i < 0) {
        cd_vis.i = mesh.verts.addCustomDataLayer('color', '_rakevis').index
      }

      for (const v of mesh.verts.selected.editable) {
        const cv = v.customData.get(cd_curv)
        cv.check(v, cd_cotan, true, cd_fset)
      }

      const remesh = new UniformTriRemesher(mesh)
      remesh.propRakeDirections()
    }

    for (let i = 0; i < amat.length; i++) {
      amat[i] = 0.0
    }

    const calcNorLen = (v: Vertex): number => {
      let tot = 0
      let sum = 0

      for (const v2 of v.neighbors) {
        sum += v2.co.vectorDistance(v.co)
        tot++
      }

      return tot ? sum / tot : 1.0
    }

    console.warn('updating curvature lines')

    no = new Vector3()

    const dd3 = 1.0
    for (const v of mesh.verts.selected.editable) {
      const cv = v.customData.get(cd_curv)
      cv.check(v, cd_cotan, true, cd_fset)

      if (VIS_UV_COLORS) {
        const visc = v.customData.get(cd_vis).color
        visc[0] = Math.fract(cv.diruv[0])
        visc[1] = Math.fract(cv.diruv[1])
        visc[2] = Math.fract(cv.diruv[2])
        visc[3] = 1.0

        //cv.relaxUvCells(v, cd_curv);
      }

      const size = calcNorLen(v) * 0.5

      let k1 = cv.k1 * 0.1 * dd3

      if (0 && cv.k1 !== 0.0) {
        k1 = Math.abs(1.0 / cv.k1)
      }

      no.load(cv.dir)
      //no.load(cv.no);
      no.normalize()

      co1.load(v.co)

      for (let i = 0; i < 2; i++) {
        co2.load(v.co).addFac(no, i === 0 ? size * 0.5 : size * 0.1) //size*k1);

        let line = sm.line(co1, co2)
        line.colors(white, white)

        co2.load(v.co).addFac(no, -size * 0.1) //size*k1);

        line = sm.line(co1, co2)
        line.colors(white, white)

        no.cross(v.no).normalize()
      }
    }
  }

  updateLoopMesh(gl: WebGL2RenderingContext): void {
    const mesh = this.mesh!
    const key = '' + mesh.lib_id + ':' + mesh.updateGen + ':' + mesh.verts.length + ':' + mesh.eidgen.cur

    if (key === this._last_update_loop_key) {
      return
    }

    this._last_update_loop_key = key

    if (this.loopMesh) {
      this.loopMesh.destroy(gl)
    }

    const sm = (this.loopMesh = new SimpleMesh(LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.UV))
    sm.primflag = PrimitiveTypes.LINES

    const a = new Vector3()
    const b = new Vector3()
    const c = new Vector3()
    const d = new Vector3()
    const e = new Vector3()
    const g = new Vector3()
    const h = new Vector3()
    const color = new Vector4([0, 0, 0, 1])

    const ctmps = util.cachering.fromConstructor(Vector3, 64)
    const rtmps = new util.cachering(() => [new Vector3(), new Vector3(), new Vector3()], 32)

    function calcloop(l: any): any {
      let fac: number
      const f = l.f

      const ret = rtmps.next()
      const a = ret[0]
      const b = ret[1]
      const c = ret[2]

      if (l.f.area) {
        let count = 0.0

        for (const list of l.f.lists) {
          for (const l of list) {
            count++
          }
        }

        fac = (Math.sqrt(l.f.area) / count) * 0.35
        fac = (fac + a.vectorDistance(b) * 0.2) * 0.5
      } else {
        fac = a.vectorDistance(b) * 0.2
      }

      g.load(b).sub(a).cross(f.no).normalize()
      h.load(l.v).interp(l.next.v, 0.5).sub(f.cent).negate().normalize()

      //if (g.dot(h) < 0.0) {
      //  g.negate();
      //}
      g.load(h)

      a.load(l.v).addFac(g, fac)
      b.load(l.next.v).addFac(g, fac)

      //a.load(l.v).sub(f.cent).mulScalar(fac).add(f.cent);
      //b.load(l.next.v).sub(f.cent).mulScalar(fac).add(f.cent);

      c.load(a).interp(b, 0.5)
      a.interp(c, 0.225)
      b.interp(c, 0.225)

      const scale = l.v.vectorDistance(f.cent) * 0.03

      for (let _i = 0; _i < 3; _i++) {
        const i = _i as Number3
        a[i] += (Math.random() - 0.5) * scale
        b[i] += (Math.random() - 0.5) * scale
        c[i] += (Math.random() - 0.5) * scale
      }

      return ret
    }

    for (const f of mesh.faces.selected) {
      f.calcCent()

      for (const l of f.loops) {
        const [a, b, c] = calcloop(l)

        let line = sm.line(a, b)
        line.colors(color, color)

        if (f.no.dot(f.no) === 0.0) {
          f.calcCent()
          f.calcNormal()
        }

        d.load(b).interp(f.cent, 0.1)

        line = sm.line(b, d)
        line.colors(color, color)

        if (l.radial_next !== l) {
          const [a2, b2, c2] = calcloop(l.radial_next)

          const t = Math.random() * 0.5 + 0.5

          d.load(a).interp(b, t)
          e.load(a2).interp(b2, 1.0 - t)
          line = sm.line(d, e)
          line.colors(color, color)
        }
      }
    }
  }

  updateNormalsMesh(gl: WebGL2RenderingContext): void {
    const mesh = this.mesh
    if (!mesh) {
      return
    }

    const key =
      '' +
      mesh.lib_id +
      ':' +
      mesh.verts.selected.size +
      ':' +
      mesh.updateGen +
      ':' +
      mesh.verts.length +
      ':' +
      mesh.eidgen.cur

    if (key === this._last_normals_key) {
      return
    }

    this._last_normals_key = key

    if (this.normalMesh) {
      this.normalMesh.destroy(gl)
    }

    const sm = (this.normalMesh = new SimpleMesh(LayerTypes.LOC | LayerTypes.COLOR | LayerTypes.UV))

    const co1 = new Vector3()
    const co2 = new Vector3()

    const white = new Vector4([1, 1, 1, 1])

    for (const v of mesh.verts.selected.editable) {
      co1.load(v.co)

      let edist = 0.0
      let tot = 0

      for (const v2 of v.neighbors) {
        edist += v2.co.vectorDistance(v.co)
        tot++
      }

      if (tot) {
        edist /= tot
      } else {
        edist = 1.0
      }

      co2.load(co1).addFac(v.no, edist * 0.5)

      const line = sm.line(co1, co2)
      line.colors(white, white)
    }
  }

  on_drawend(view3d: any): void {
    super.on_drawend(view3d)

    const gl = view3d.gl as WebGL2RenderingContext
    const ob = this.ctx.object
    const color = [1, 0.8, 0.7, 1.0]

    if (!ob) {
      return
    }

    const uniforms = {
      projectionMatrix: view3d.activeCamera.rendermat,
      objectMatrix    : ob.outputs.matrix.getValue(),
      object_id       : ob.lib_id,
      aspect          : view3d.activeCamera.aspect,
      size            : view3d.glSize,
      near            : view3d.activeCamera.near,
      far             : view3d.activeCamera.far,
      color           : color,
      uColor          : color,
      alpha           : 1.0,
      opacity         : 1.0,
      polygonOffset   : 1.0,
    }

    if (this.drawCurvatures && this.mesh) {
      this.updateCurvatureMesh(gl)

      if (this.curvatureMesh) {
        gl.enable(gl.DEPTH_TEST)
        this.curvatureMesh.draw(gl, uniforms, Shaders.WidgetMeshShader)
      }
    }

    if (this.drawNormals && this.mesh) {
      this.updateNormalsMesh(gl)

      if (this.normalMesh) {
        gl.enable(gl.DEPTH_TEST)
        this.normalMesh.draw(gl, uniforms, Shaders.WidgetMeshShader)
      }
    }

    if (this.drawLoops && this.mesh) {
      this.updateLoopMesh(gl)

      if (this.loopMesh) {
        gl.enable(gl.DEPTH_TEST)
        this.loopMesh.draw(gl, uniforms, Shaders.WidgetMeshShader)
      }
    }
  }

  on_drawstart(view3d: any): void {
    if (!this.ctx) return

    this._getObject()

    let mask = this.ctx.selectMask
    mask = mask | (SelMask.EDGE | SelMask.FACE)

    this.selectMask = this.ctx.selectMask
    this.drawSelectMask = mask

    if (this.mesh !== undefined) {
      if (this.mesh.drawflag !== this.drawflag) {
        this.mesh.drawflag = this.drawflag
        this.mesh.regenRender()
      }
    }

    super.on_drawstart(view3d)
  }

  dataLink(scene: Scene, getblock: BlockLoader, getblock_addUser: BlockLoaderAddUser): void {
    super.dataLink(scene, getblock, getblock_addUser)
    this.mesh = getblock_addUser<Mesh>(this.mesh as unknown as DataRef, scene)
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)
    if (this.mesh !== undefined) {
      this.mesh.owningToolMode = this.constructor.toolModeDefine().name
    }
  }
}
