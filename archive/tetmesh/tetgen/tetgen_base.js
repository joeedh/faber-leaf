import {LogContext} from '../../addons/builtin/mesh/src/mesh_base.js'

export const TetFlags = {
  SELECT           : 1,
  HIDE             : 2,
  UPDATE           : 4,
  TEMP1            : 8,
  TEMP2            : 16,
  TEMP3            : 32,
  ITER_EDGE_TETS1  : 1 << 6,
  SURFACE          : 1 << 7,
  ITER_EDGE_TETSEND: 1 << 21, //max depth 16 for TetEdge.tets iterator
  MAKEFACE_TEMP    : 1 << 22,
  FLIP_HEX         : 1 << 23,
}

export const TetRecalcFlags = {
  NORMALS    : 1,
  RENDER     : 2,
  TESSELATION: 4,
  ALL        : 1 | 2 | 4,
}

export const TetTypes = {
  VERTEX: 1,
  EDGE  : 2,
  LOOP  : 4,
  FACE  : 8,
  PLANE : 16,
  CELL  : 32,
}

export class TetLogContext extends LogContext {
  constructor() {
    super()
  }

  newVertex(t) {
    if (this.onnew) {
      this.onnew(t)
    }
  }

  killVertex(t) {
    if (this.onkill) {
      this.onkill(t)
    }
  }

  newEdge(t) {
    if (this.onnew) {
      this.onnew(t)
    }
  }

  killEdge(t) {
    if (this.onkill) {
      this.onkill(t)
    }
  }

  newFace(t) {
    if (this.onnew) {
      this.onnew(t)
    }
  }

  killFace(t) {
    if (this.onkill) {
      this.onkill(t)
    }
  }

  newCell(t) {
    if (this.onnew) {
      this.onnew(t)
    }
  }

  killCell(t) {
    if (this.onkill) {
      this.onkill(t)
    }
  }
}
