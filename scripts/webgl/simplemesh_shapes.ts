import type {SimpleMesh} from './simplemesh'
import {readOBJToSimpleMesh} from './simplemesh_obj'
import {ShapeOBJs} from './shape_data'

/**loadShapes will put widget meshes here, with the same keys as in
   ShapeOBJs*/
export const Shapes = {} as {[k in keyof typeof ShapeOBJs]: SimpleMesh}

export function loadShapes() {
  const ShapeSources = ShapeOBJs as {[k: string]: string}
  for (const k in ShapeSources) {
    Shapes[k as keyof typeof ShapeOBJs] = readOBJToSimpleMesh(atob(ShapeSources[k]))
  }
}
