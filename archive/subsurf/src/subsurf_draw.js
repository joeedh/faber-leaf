import {Vector2, Vector3, Vector4, Quat, Matrix4} from '@framework/api'
import {util} from '@framework/api'
import {MeshDrawInterface, OrigRef} from '@framework/api'
import {Mesh, MeshTypes, MeshFlags} from '../../mesh/src/mesh.js'
import {createPatches} from './subsurf_mesh.js'
import {Texture} from '@framework/api'

let orig_rets = util.cachering.fromConstructor(OrigRef, 128)

import {subdivide} from './subsurf_mesh.js'

export class SubsurfMesh extends MeshDrawInterface {
  constructor(mesh) {
    super()

    this.mesh_ref = mesh.lib_id
    this.smesh = undefined

    this.ototvert = mesh.verts.length
    this.ototedge = mesh.verts.length
    this.ototface = mesh.verts.length

    this.origverts = {}
    this.origfaces = {}
    this.origedges = {}

    this.patches = undefined
    this.partialGen = undefined
    this.gen = undefined
  }

  draw(ctx, view3d, gl, object, uniforms, program) {
    this.mesh_ref = object.data.lib_id

    if (this.needsRecalc(object.data) || this.smesh === undefined) {
      this.update(ctx, view3d, gl, object)
    }

    this.smesh.draw(gl, uniforms, program)
  }

  destroy(gl) {
    if (this.patches !== undefined) {
      this.patches.destroy(gl)
      this.patches = undefined
    }

    if (this.smesh !== undefined) {
      this.smesh.destroy(gl)
      this.smesh = undefined
    }
  }

  needsRecalc(mesh) {
    //console.log(this.partialGen, mesh.partialUpdateGen, this.gen, mesh.updateGen);

    if (mesh.partialUpdateGen !== this.partialGen || this.gen !== mesh.updateGen) {
      return true
    }

    if (this.smesh === undefined) {
      return true
    }

    let m1 = mesh
    let m2 = this.smesh

    let bad = false

    bad = bad || this.ototvert !== m1.verts.length
    bad = bad || this.ototedge !== m1.edges.length
    bad = bad || this.ototface !== m1.faces.length

    if (bad) {
      return true
    }

    let origverts = this.origverts
    let origedges = this.origedges
    let origfaces = this.origfaces

    for (let v of m1.verts) {
      if (!(v.eid in origverts)) return true
    }
    for (let e of m1.edges) {
      if (!(e.eid in origedges)) return true
    }
    for (let f of m1.faces) {
      if (!(f.eid in origfaces)) return true
    }

    return false
  }

  syncVerts(mesh) {
    let smesh = this.smesh
    this.partialGen = mesh.partialUpdateGen
  }

  generate(mesh, gl) {
    this.partialGen = mesh.partialUpdateGen
    this.gen = mesh.updateGen

    this.ototedge = mesh.edges.length
    this.ototface = mesh.faces.length
    this.ototvert = mesh.verts.length

    let ov = (this.origverts = {})
    let oe = (this.origedges = {})
    let of = (this.origfaces = {})

    mesh.updateIndices()

    for (let v of mesh.verts) {
      ov[v.eid] = v.index
    }

    for (let e of mesh.edges) {
      oe[e.eid] = e.index
    }

    for (let f of mesh.faces) {
      of[f.eid] = f.index
    }

    let smesh = (this.smesh = mesh.copy())

    smesh.setOrigIndex()

    subdivide(smesh)

    smesh.recalcNormals()
    smesh.regenTessellation()
    smesh.regenRender()

    if (this.patches !== undefined) {
      this.patches.destroy(gl)
    }

    this.patches = createPatches(smesh)
    let dimen = this.patches.texdimen

    console.log(dimen, dimen * dimen, this.patches.patchdata.length / 4, 'ss texture dimen')
    this.patches.gltex = Texture.load(gl, dimen, dimen, this.patches.patchdata)
    //this.patches = new Float64Array(smesh.faces.length*16*3);
  }

  update(ctx, view3d, gl, object) {
    this.mesh_ref = object.data.lib_id

    if (!this.needsRecalc(object.data)) {
      this.syncVerts(object.data)
    } else {
      this.generate(object.data, gl)
    }
  }
}

export class SubsurfDrawer extends MeshDrawInterface {
  constructor() {
    super()

    this.cache = {}
  }

  get(object) {
    if (!(object.data.eid in this.cache)) {
      this.cache[object.data.eid] = new SubsurfMesh(object.data)
    }

    return this.cache[object.data.eid]
  }

  destroy(gl) {
    for (let k in this.cache) {
      let sm = this.cache[k]

      sm.destroy(gl)
    }

    this.cache = {}
  }

  draw(view3d, gl, object, uniforms, program) {
    let ss = this.get(object)

    let mesh = object.data

    if (mesh.updateGen != this.updateGen) {
      this.updateGen = mesh.updateGen
      ss.update(view3d.ctx, view3d, gl, object)
    }

    ss.draw(view3d.ctx, view3d, gl, object, uniforms, program)

    mesh.checkPartialUpdate(gl)
  }

  drawIDs(view3d, gl, object, uniforms, program) {
    let ss = this.get(object)

    //ss.update(view3d.ctx, view3d, gl, object);
    //ss.draw(view3d.ctx, view3d, gl, object);
  }
}
