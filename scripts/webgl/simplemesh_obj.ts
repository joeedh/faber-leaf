/**
 * The `SimpleMesh` half of the widget-shape OBJ reader; the parsing itself is
 * {@link ./obj_parse}, which stays free of framework imports.
 */

import {Vector3, Vector4} from '../path.ux/scripts/pathux'
import {parseOBJTris} from './obj_parse'
import {LayerTypes, SimpleMesh} from './simplemesh'

const WHITE = new Vector4([1, 1, 1, 1])

/** Layers the widget pipelines bind: `LIT_MESH_VERTEX_LAYOUT` plus MeshIDShader's id. */
const SHAPE_LAYERS = LayerTypes.LOC | LayerTypes.NORMAL | LayerTypes.UV | LayerTypes.COLOR | LayerTypes.ID

export function readOBJToSimpleMesh(buf: string): SimpleMesh {
  const {positions, normals} = parseOBJTris(buf)
  const smesh = new SimpleMesh(SHAPE_LAYERS)
  const co = [new Vector3(), new Vector3(), new Vector3()]
  const no = new Vector3()

  for (let i = 0; i < positions.length; i += 9) {
    for (let j = 0; j < 3; j++) {
      co[j].loadXYZ(positions[i + j * 3], positions[i + j * 3 + 1], positions[i + j * 3 + 2])
    }
    no.loadXYZ(normals[i], normals[i + 1], normals[i + 2])

    smesh.tri(co[0], co[1], co[2]).normals(no, no, no).colors(WHITE, WHITE, WHITE)
  }

  return smesh
}
