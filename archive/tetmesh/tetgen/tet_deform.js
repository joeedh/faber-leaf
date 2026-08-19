import * as math from '../util/math.js'
import {Vector3} from '../util/vectormath.js'
import {TetFlags} from './tetgen_base.js'

export function tetSolve(tm, verts = tm.verts, steps = 2) {
  let dt = 1.0
  let damp = 0.95

  let cells = new Set()
  for (let v of verts) {
    for (let e of v.edges) {
      for (let l of e.loops) {
        for (let p of l.f.planes) {
          cells.add(p.c)
        }
      }
    }
  }

  function error(c) {
    let vs = c.verts

    let err = 0.0
    for (let e of c.edges) {
      let dis = e.v1.vectorDistance(e.v2)
      dis -= e.startLength
      err += dis * dis
    }

    return err

    let volume = math.tet_volume(vs[0], vs[1], vs[2], vs[3])
    if (Math.abs(volume) < 0.000001) {
      for (let i = 0; i < vs.length; i++) {
        for (let j = 0; j < 3; j++) {
          vs[i][j] += (Math.random() - 0.5) * 0.00001
        }
      }
    }

    return volume - c.startVolume
  }

  let gs = new Array(16)
  for (let i = 0; i < gs.length; i++) {
    gs[i] = new Vector3()
  }

  for (let v of verts) {
    v.oldco.load(v)
    v.vel.mulScalar(damp)
    v.addFac(v.vel, dt * v.w)
  }

  let toterr = 0.0

  for (let step = 0; step < steps; step++) {
    toterr = 0.0

    for (let c of cells) {
      let vlen = c.verts.length

      //if (!c.isTet()) {
      //  continue;
      //}

      let df = 0.000001
      let totg = 0.0

      let r1 = error(c)
      toterr += Math.abs(r1)

      for (let i = 0; i < vlen; i++) {
        let v = c.verts[i]
        let g = gs[i]

        for (let j = 0; j < 3; j++) {
          let orig = v[j]
          v[j] += df

          let r2 = error(c)

          g[j] = (r2 - r1) / df
          totg += g[j] * g[j]

          v[j] = orig
        }
      }

      if (totg === 0.0) {
        continue
      }

      r1 /= totg
      let gk = 0.85

      for (let i = 0; i < vlen; i++) {
        let v = c.verts[i]
        let g = gs[i]

        let w = v.w

        for (let j = 0; j < 3; j++) {
          v[j] += -r1 * g[j] * gk * w
        }
      }
    }
  }

  console.log('error:', toterr.toFixed(4))

  //vertexSmooth(tm, tm.verts);

  for (let v of tm.verts) {
    v.acc.load(v.vel)

    v.vel.load(v).sub(v.oldco)
    v.acc.sub(v.vel).negate()
    v.flag |= TetFlags.UPDATE
  }
}
