import {BinaryWriter} from './binarylib.js'
import {invalidatableOf} from '../core/data_kinds.js'
import {InvalidationKind} from '../core/geometry_contract.js'

export function exportSTLMesh(meshes) {
  let tottri = 0

  for (let mesh of meshes) {
    if (mesh.bvh) {
      //might be in sculpt mode, in which case tesselation may not be
      //fully up to date
      invalidatableOf(mesh)?.invalidate(InvalidationKind.TOPOLOGY)
    }

    let ltris = mesh.loopTris
    tottri += ltris.length / 3
  }

  let bin = new BinaryWriter()

  bin.data = new Array(80)
  for (let i = 0; i < 80; i++) {
    bin.data[i] = 0
  }

  function vec3(v) {
    bin.float32(v[0])
    bin.float32(v[1])
    bin.float32(v[2])
  }

  bin.int32(tottri)

  for (let mesh of meshes) {
    let ltris = mesh.loopTris

    for (let i = 0; i < ltris.length; i += 3) {
      let l1 = ltris[i],
        l2 = ltris[i + 1],
        l3 = ltris[i + 2]

      vec3(l1.f.no)
      vec3(l1.v)
      vec3(l2.v)
      vec3(l3.v)
      bin.uint16(0)
    }
  }

  return bin.finish()
}
