import {isect_ray_plane, Matrix4, ToolOp, Vector2, Vector3, Vector4} from '../../../path.ux/scripts/pathux.js'
import {castViewRay} from '../findnearest.js'
import {SelMask} from '../../../core/select_types.js'
import {InvalidationKind} from '../../../core/geometry_contract.js'
import {SnapModes, TransformOp} from './transform_ops.js'
import {MeshFlags} from '../../../../addons/builtin/mesh/src/mesh_base.js'
import type {Edge, Face, Vertex} from '../../../../addons/builtin/mesh/src/mesh_types.js'
import type {Mesh} from '../../../../addons/builtin/mesh/src/mesh.js'
import type {ViewContext} from '../../../core/context.js'

class Region {
  faces: Set<Face>
  verts: Set<Vertex>
  edges: Set<Edge>
  outervs: Set<Vertex>
  outeres: Set<Edge>
  startCos: Map<Vertex, Vector3>
  dirmap: Map<Vertex, Vector3>
  no: Vector3

  constructor() {
    this.faces = new Set()
    this.verts = new Set()
    this.edges = new Set()

    this.outervs = new Set<Vertex>()
    this.outeres = new Set<Edge>()
    this.startCos = new Map()

    this.dirmap = new Map() /* Maps vertices to unit vectors. */
    this.no = new Vector3()
  }
}

export class InsetTransformOp extends TransformOp {
  startMpos: Vector2
  scale: number
  plane: Vector3
  regions: Region[] | undefined

  constructor(start_mpos?: Vector2) {
    super()

    this.startMpos = new Vector2()
    this.scale = 1.0
    this.plane = new Vector3()

    this.regions = undefined

    if (start_mpos !== undefined) {
      this.startMpos.load(start_mpos)
      this.startMpos[2] = 0.0

      this._first = false
    } else {
      this._first = true
    }
  }

  static tooldef() {
    return {
      uiname     : 'Inset Transform',
      description: '',
      toolpath   : 'view3d.transform_inset',
      is_modal   : true,
      inputs     : ToolOp.inherit({}),
      icon       : -1,
    }
  }

  numericSet(val: number) {
    console.error('numericSet: implement me')
  }

  on_pointermove(e: PointerEvent) {
    super.on_pointermove(e)

    const ctx = this.modal_ctx!
    const view3d = ctx.view3d
    const mesh = ctx.mesh

    const mpos = new Vector2(view3d.getLocalMouse(e.x, e.y))

    if (this._first) {
      this.startMpos.load(mpos)
      this._first = false
      return
    }

    const regions = this.getRegions(mesh!)
    this.scale = 0.001 //XXX

    const offset = mpos.vectorDistance(this.startMpos) * this.scale

    console.log('offset:', offset)
    this.inputs.value.setValue(new Vector3([offset, 0.0, 0.0]))

    this.exec(ctx)
    this.doUpdates(ctx)
    window.redraw_viewport(true)
  }

  getRegions(mesh: Mesh) {
    if (this.regions) {
      return this.regions
    }

    const regions: Region[] = []
    const stack: Face[] = []
    const visit = new WeakSet()

    for (const f of mesh.faces.selected.editable) {
      if (visit.has(f)) {
        continue
      }

      stack.length = 0
      stack.push(f)
      visit.add(f)

      const region = new Region()
      regions.push(region)

      while (stack.length > 0) {
        const f2 = stack.pop()!
        region.faces.add(f2)

        for (const list of f2.lists) {
          for (const l of list) {
            for (const l2 of l.e.loops) {
              if (l2.f.flag & MeshFlags.HIDE) {
                continue
              }

              if (l2.f.flag & MeshFlags.SELECT && !visit.has(l2.f)) {
                stack.push(l2.f)
                visit.add(l2.f)
              }
            }
          }
        }
      }

      console.log(region.faces)

      for (const f2 of region.faces) {
        for (const list of f2.lists) {
          for (const l of list) {
            region.verts.add(l.v)
            region.edges.add(l.e)
          }
        }
      }

      for (const e of region.edges) {
        let bound = false

        for (const l of e.loops) {
          if (l.f.flag & MeshFlags.HIDE) {
            continue
          }

          if (!region.faces.has(l.f)) {
            bound = true
            break
          }
        }

        if (bound) {
          region.outeres.add(e)
          region.outervs.add(e.v1)
          region.outervs.add(e.v2)
        }
      }

      console.log('boundary', region.outeres, region.outervs)

      const t1 = new Vector3()
      const t2 = new Vector3()
      const t3 = new Vector3()
      const t4 = new Vector3()
      const no = new Vector3()

      for (const v of region.outervs) {
        let e1
        let e2

        region.startCos.set(v, new Vector3(v.co))

        for (const e of v.edges) {
          if (region.outeres.has(e)) {
            if (!e1) {
              e1 = e
            } else if (!e2) {
              e2 = e
              break
            }
          }
        }

        if (!e1 || !e2) {
          console.warn('Missing edge', e1, e2)
          continue
        }

        let l1
        let l2
        for (const l of e1.loops) {
          if (region.faces.has(l.f)) {
            l1 = l
            break
          }
        }

        for (const l of e2.loops) {
          if (region.faces.has(l.f)) {
            l2 = l
            break
          }
        }

        if (!l1 || !l2) {
          continue
        }

        no.load(l1.f.no)
        if (l1.f.no.dot(l2.f.no) < 0.0) {
          no.addFac(l2.f.no, -1.0).normalize()
        } else {
          no.add(l2.f.no).normalize()
        }

        const vp = e1.otherVertex(v)
        const vn = e2.otherVertex(v)

        t1.load(v.co).sub(vp.co).normalize()
        t2.load(vn.co).sub(v.co).normalize()
        t1.add(t2).cross(no).normalize()

        /* Enforce winding. */

        if (v !== l1.v) {
          t1.negate()
        }

        region.dirmap.set(v, new Vector3(t1))
      }
    }

    this.regions = regions
    return regions
  }

  exec(ctx: ViewContext) {
    super.exec(ctx)
    const mesh = ctx.mesh!

    const regions = this.getRegions(mesh)
    const offset = this.inputs.value.getValue()[0]

    for (const region of regions) {
      for (const v of region.outervs) {
        const startco = region.startCos.get(v)
        const dir = region.dirmap.get(v)

        if (!dir) {
          console.log('no dir', v)
          continue
        }

        v.co.load(startco!).addFac(dir, offset)
        v.flag |= MeshFlags.UPDATE
      }
    }

    mesh.invalidate(InvalidationKind.TOPOLOGY)
    window.redraw_viewport(true)
  }

  execPost(ctx: ViewContext) {
    this.regions = undefined
  }
}

ToolOp.register(InsetTransformOp)
