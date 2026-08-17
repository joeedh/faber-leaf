export function makeCurvToolMode(api) {
  let exports = {}

  const nstructjs = api.nstructjs

  const DrawFlags = (exports.DrawFlags = {
    COLOR: 1,
  })

  const {LayerTypes, PrimitiveTypes, SimpleMesh} = api.simplemesh
  const {KDrawModes} = api.mesh

  let CurvToolMode = (exports.CurvToolMode = class CurvToolMode extends api.toolmode.MeshToolBase {
    static STRUCT = nstructjs.inlineRegister(
      this,
      `
  curvetest.CurvToolMode {
    drawFlag       : int;
    drawScale      : float;
    drawVerts      : bool;
    drawTangents   : bool;
    kDrawMode      : int;
  }
  `
    )

    constructor() {
      super()

      this.kDrawMode = KDrawModes.TAN

      this.selectMask = api.SelMask.VERTEX
      this.vertexPointSize = 3

      this.drawTangents = true

      this.curveMesh = undefined
      this.drawFlag = 0
      this.drawScale = 1.0
      this.drawVerts = true

      this._last_cmesh_key = ''
    }

    defineKeyMap() {
      super.defineKeyMap()

      let km = this.keymap
      km.add(new api.pathux.HotKey('R', [], "view3d.rotate(selmask='VERTEX|HANDLE')"))

      return this.keymap
    }

    static defineAPI(api) {
      let st = super.defineAPI(api)

      let onchange = () => window.redraw_viewport(true)

      st.flags('drawFlag', 'drawFlag', DrawFlags, 'Draw Flags')
      st.float('drawScale', 'drawScale', 'Scale').noUnits().range(0.001, 25.0)
      st.bool('drawVerts', 'drawVerts', 'Draw Verts').on('change', onchange)
      st.bool('drawTangents', 'drawTangents', 'Draw Tangents').on('change', onchange)

      st.enum('kDrawMode', 'kDrawMode', KDrawModes, 'Tangent Draw Mode').on('change', () => {
        window.redraw_viewport(true)
      })

      return st
    }

    static buildHeader(header, addRow) {
      let row = addRow()

      let strip = row.strip()
      strip.useIcons(false)

      strip.tool('curvetool.test()')
      strip.prop('scene.tool.drawVerts')
    }

    static buildSettings(con) {
      let panel = con.panel('Tools')

      let strip = panel.strip()
      strip.useIcons(false)
      strip.tool('curvetool.test()')
      strip.tool('curvetool.smooth()')

      strip = panel.strip()
      strip.useIcons(false)
      strip.prop('scene.tool.drawFlag')

      panel.useIcons(false)
      panel.prop('scene.tool.drawScale')
      panel.prop('scene.tool.drawVerts')
      panel.prop('scene.tool.drawTangents')
      panel.prop('scene.tool.kDrawMode')

      panel = con.panel('Settings')
      panel.useIcons(false)
      panel.prop('mesh.vertsData.curvetest.settings.smoothTangents')
      panel.prop('mesh.vertsData.curvetest.settings.weightMode')
    }

    updateCurveMesh(gl) {
      if (!this.mesh) {
        return
      }

      let mesh = this.mesh
      let cd_curvt = mesh.verts.customData.getLayerIndex('curvetest')

      let key = '' + mesh.lib_id + ':' + mesh.updateGen + ':' + cd_curvt
      key += ':' + this.kDrawMode

      if (this.curveMesh && key === this._last_cmesh_key) {
        return
      }

      this._last_cmesh_key = key

      console.log('rebuild curve mesh', key)

      if (this.curveMesh) {
        this.curveMesh.destroy(gl)
      }

      let lf = LayerTypes
      let lflag = lf.LOC | lf.COLOR | lf.UV

      let sm = (this.curveMesh = new SimpleMesh(lflag))
      sm.primflag = PrimitiveTypes.LINES

      if (cd_curvt < 0) {
        console.log('no curve verts')
        return
      }

      let white = [1, 1, 1, 1]
      let tmp = new Vector3()

      for (let v of mesh.verts) {
        let pv = v.customData[cd_curvt]

        let dis = 0
        let tot = 0
        for (let v2 of v.neighbors) {
          let dis2 = v.vectorDistance(v2)
          dis += dis2
          tot++
        }

        if (tot) {
          dis /= tot
        }

        dis = Math.max(dis, 0.01)

        let v1 = v
        let v2 = tmp.zero()

        let t = v2
        switch (this.kDrawMode) {
          case KDrawModes.TAN:
            t.load(pv.tan)
            break
          case KDrawModes.NO:
            t.load(pv.no)
            break
          case KDrawModes.BIN:
            t.load(pv.bin)
            break
          case KDrawModes.DK1:
            t.load(pv.dk1)
            break
          case KDrawModes.D2K1:
            t.load(pv.d2k1)
            break
          case KDrawModes.D3K1:
            t.load(pv.d3k1)
            break

          case KDrawModes.DK2:
            t.load(pv.dk2)
            break
          case KDrawModes.D2K2:
            t.load(pv.d2k2)
            break
          case KDrawModes.D3K2:
            t.load(pv.d3k2)
            break

          case KDrawModes.DK3:
            t.load(pv.dk3)
            break
          case KDrawModes.D2K3:
            t.load(pv.d2k3)
            break
          case KDrawModes.D3K3:
            t.load(pv.d3k3)
            break
          case KDrawModes.ERROR:
            t.load(pv.errorvec)
            break
          case KDrawModes.SMOOTH_TAN:
            t.load(pv.smoothTan)
            break
        }

        v2.normalize()

        v2.mulScalar(dis)

        v2.add(v)

        let l = sm.line(v1, v2)
        l.colors(white, white)
      }
    }

    on_drawend(view3d) {
      const gl = view3d.gl
      if (this.drawVerts) {
        super.on_drawend(view3d)
      }

      let ob = this.ctx.object
      let color = [1, 0.8, 0.7, 1.0]

      let uniforms = {
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
        polygonOffset   : 2.0,
      }

      this.mesh = this.ctx.mesh

      if (this.mesh && this.drawTangents) {
        this.updateCurveMesh(gl)

        if (this.curveMesh) {
          gl.enable(gl.DEPTH_TEST)

          this.curveMesh.draw(gl, uniforms, api.Shaders.WidgetMeshShader)
        }
      }
    }

    static toolModeDefine() {
      return {
        name        : 'curvetest',
        uiname      : 'Curvature Tester',
        icon        : api.Icons.CIRCLE_SEL,
        description : 'Curvature Tester Tool',
        transWidgets: [],
        flag        : 0,
      }
    }
  })

  api.register(CurvToolMode)

  return exports
}
