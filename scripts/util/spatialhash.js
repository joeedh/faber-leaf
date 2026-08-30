import {Vector3, Vector4} from './vectormath.js'

let scache = {}
let rcache = {}
scache[0] = [new Vector4([0, 0, 0, 1])]
rcache[0] = [new Vector4([0, 0, 0, 1])]

function getSearchOff(n, rect = false) {
  let cache = rect ? rcache : scache

  if (n in cache) {
    return cache[n]
  }

  console.log('Making searchoff of size ' + n)

  let list = []
  for (let x = -n; x <= n; x++) {
    for (let y = -n; y <= n; y++) {
      for (let z = -n; z <= n; z++) {
        if (!rect && x * x + y * y + z * z > n * n) {
          continue
        }

        let w = 1.0 - Math.sqrt(x * x + y * y + z * z) / Math.sqrt(n * 3.0)

        list.push(new Vector4([x, y, z, w]))
      }
    }
  }

  cache[n] = list
  return list
}
window._getSearchOff3 = getSearchOff

var hashsizes = [
  /*2, 5, 11, 19, 37, 67, 127, */ 223, 383, 653, 1117, 1901, 3251, 5527, 9397, 15991, 27191, 46229, 78593, 133631,
  227177, 38619, 656587, 1116209, 1897561, 3225883, 5484019, 9322861, 15848867, 26943089, 45803279, 77865577, 132371489,
  225031553,
]

const SUSED = 0
const SID = 1
const SX = 2
const SY = 3
const SZ = 4
const SR = 5
const CIX = 6
const CIY = 7
const CIZ = 8
const STOT = 9

function hash3(x, y, z) {
  let f1 = (x * 27191) % 45803279
  let f2 = (y * 27191) % 45803279
  let f3 = (z * 27191) % 45803279

  f3 = (f3 + 225031553) % 45803279
  f3 = (f3 + 132371489) % 45803279

  f2 = (f2 + 132371489) % 45803279

  let f = (f1 + f2) % 45803279
  f = (f + f3) % 45803279

  return f
}

window._hash3 = hash3

export class SpatialHash {
  constructor(cellsize, size) {
    if (!cellsize) {
      throw new Error('cellsize cannot be undefined')
    }

    this.cursize = 0
    this.cellsize = cellsize
    this.size = hashsizes[this.cursize]
    this.used = 0

    if (size !== undefined) {
      for (let i = 0; i < hashsizes.length; i++) {
        if (hashsizes[i] > size * 3) {
          this.cursize = i
          break
        }
      }
    }

    this.table = new Float64Array(this.size * STOT)
  }

  _resize() {
    this.size = hashsizes[this.cursize]
    let tab = this.table

    console.log('resizing hashtable to', this.size)

    this.table = new Float64Array(this.size * STOT)

    let co = new Vector3()

    for (let i = 0; i < tab.length; i += STOT) {
      if (tab[i]) {
        let id = tab[i + SID]
        co[0] = tab[i + SX]
        co[1] = tab[i + SY]
        co[2] = tab[i + SZ]
        let r = tab[i + SR]

        this.addPoint(id, co, r)
      }
    }
  }

  closestVerts(co, r) {
    let cz = 1.0 / this.cellsize

    let ix1 = ~~(co[0] * cz)
    let iy1 = ~~(co[1] * cz)
    let iz1 = ~~(co[2] * cz)

    let rsqr = r * r
    let rsteps = Math.ceil(r * cz)

    let size = this.size
    let tab = this.table
    let ret = new Set()

    for (let off of getSearchOff(rsteps)) {
      let ix2 = ix1 + off[0]
      let iy2 = iy1 + off[1]
      let iz2 = iz1 + off[2]

      let hash = hash3(ix2, iy2, iz2)
      let _i = 0
      let idx = (hash % size) * STOT
      let probe = 0

      while (tab[idx]) {
        let x = tab[idx + SX]
        let y = tab[idx + SY]
        let z = tab[idx + SZ]

        let dx = x - co[0]
        let dy = y - co[1]
        let dz = z - co[2]

        if (dx * dx + dy * dy + dz * dz <= rsqr) {
          ret.add(tab[idx + SID])
        }

        probe = (probe + 1) * 2
        idx = ((hash + probe) % size) * STOT

        if (_i++ > 100000) {
          console.error('infinite loop detected')
          break
        }
      }
    }

    return ret
  }

  static fromMesh(mesh, verts) {
    verts = new Set(verts)

    if (verts.size === 0) {
      return new SpatialHash(1.0)
    }

    let minlen = 1e17
    let maxlen = -1e17
    let avglen = 0
    let tot = 0
    let edges = new Set()

    let min = new Vector3().addScalar(1e17)
    let max = new Vector3().addScalar(-1e17)

    for (let v of verts) {
      min.min(v)
      max.max(v)

      for (let e of v.edges) {
        edges.add(e)
      }
    }

    for (let e of edges) {
      let dis = e.v1.vectorDistance(e.v2)
      minlen = Math.min(dis, minlen)
      maxlen = Math.max(dis, maxlen)
      avglen += dis
      tot++
    }

    if (tot) {
      avglen /= tot
    }

    let cellsize

    if (tot === 0) {
      let density = Math.cbrt(verts.size)
      let size = new Vector3(max).sub(min)

      let dimen = Math.min(Math.min(max[0], max[1]))
      dimen = Math.max(dimen, 0.0001)

      cellsize = size / density
    } else {
      cellsize = (minlen + maxlen) * 0.75
    }

    let shash = new SpatialHash(cellsize, verts.size)
    for (let v of verts) {
      shash.addPoint(v.eid, v)
    }

    return shash
  }

  addPoint(id, co, r = 0) {
    if (this.used >= this.size / 3) {
      this.cursize += 2
      this._resize()
    }

    let cz = 1.0 / this.cellsize
    let ix = ~~(co[0] * cz)
    let iy = ~~(co[1] * cz)
    let iz = ~~(co[2] * cz)

    let hash = hash3(ix, iy, iz)
    let size = this.size
    let tab = this.table
    let idx = (hash % size) * STOT
    let probe = 0
    let _i = 0

    while (tab[idx]) {
      probe = (probe + 1) * 2
      idx = ((hash + probe) % size) * STOT

      if (_i++ > 100000) {
        console.error('infinite loop detected in spatialhash code')
        break
      }
    }

    tab[idx] = 1.0
    tab[idx + 1] = id
    tab[idx + 2] = co[0]
    tab[idx + 3] = co[1]
    tab[idx + 4] = co[2]
    tab[idx + 5] = r
    tab[idx + 6] = ix
    tab[idx + 7] = iy
    tab[idx + 8] = iz

    this.used++

    return true
  }
}
