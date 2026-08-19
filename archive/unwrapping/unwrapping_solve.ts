import {util, math, Vector2, Vector3, Matrix4, Number2} from '@framework/api'
import {Solver, Constraint} from '@framework/pathux'
import '../../../../scripts/util/numeric.js'

import '../../../../scripts/extern/Math.js'

import {MeshTypes, MeshFlags} from './mesh_base'
import {AttrRef, UVLayerElem} from './mesh_customdata'
import {UVWrangler} from './unwrapping'
import {Edge, Face, Loop, Mesh, Vertex} from './mesh'

export function relaxUVs(
  mesh: Mesh,
  cd_uv: AttrRef<UVLayerElem>,
  _loops: Iterable<Loop> = mesh.loops,
  doPack = false,
  boundaryWeight = 400.0,
  buildFromSeams = false
) {
  const loops = new Set<Loop>(_loops)

  const faces = new Set<Face>()
  for (const l of loops) {
    faces.add(l.f)
  }

  const wr = new UVWrangler(mesh, faces, cd_uv)
  wr.buildIslands(buildFromSeams)

  const islandmap = new Map()
  const badset = new WeakSet()

  for (const island of wr.islands) {
    for (const v of island) {
      islandmap.set(v, island)
      let bad = true

      for (const l of wr.vertMap.get(v)!) {
        islandmap.set(l, island)
        if (bad && loops.has(l)) {
          bad = false
        }
      }

      if (bad) {
        badset.add(v)
      }
    }
  }

  //for (let v of wr.uvMesh.verts) {
  //  cos.push(new Vector3(v));
  //  v.index = vi++;
  //}

  const avg = new Vector3()
  const cd_corner = wr.cd_corner

  for (const island of wr.islands) {
    if (island.size < 5) {
      continue
    }

    for (const v of island) {
      if (badset.has(v)) {
        continue
      }

      let w = 1.0
      let tot = 0.0
      avg.zero()

      for (const l of wr.vertMap.get(v)!) {
        l.f.flag |= MeshFlags.UPDATE

        let seam = !!(l.e.flag & MeshFlags.SEAM)
        seam = seam || l === l.radial_next
        seam = seam || islandmap.get(l) !== islandmap.get(v)

        if (seam) {
          w = boundaryWeight
          break
        }

        if (cd_corner.get(v).hasPins) {
          w += boundaryWeight * 2.0
        }
      }

      avg.addFac(v.co, w)
      tot += w

      for (const e of v.edges) {
        const v2 = e.otherVertex(v)
        const w = 1.0

        if (badset.has(v2)) {
          continue
        }

        avg.addFac(v2.co, w)
        tot += w
      }

      if (tot > 0) {
        avg.mulScalar(1.0 / tot)
        v.co.load(avg)
        v.co[2] = 0.0
      }
    }

    const area = island.area
    wr.updateAABB(island)

    if (area === 0 || island.area === 0) {
      continue
    }

    const ratio = Math.sqrt(area) / Math.sqrt(island.area)
    const cent = new Vector2(island.min).interp(island.max, 0.5)

    for (const v of island) {
      //v.sub(cent).mulScalar(ratio).add(cent);
      v.co[2] = 0.0
    }
  }

  if (doPack) {
    wr.packIslands(true, true)
  }

  wr.finish()
}

export class SolveTri {
  l1: Loop
  l2: Loop
  l3: Loop

  v1: Vertex
  v2: Vertex
  v3: Vertex

  area: number
  worldArea: number

  constructor(l1: Loop, l2: Loop, l3: Loop, v1: Vertex, v2: Vertex, v3: Vertex) {
    this.l1 = l1
    this.l2 = l2
    this.l3 = l3

    this.v1 = v1
    this.v2 = v2
    this.v3 = v3

    this.area = math.tri_area(this.v1.co, this.v2.co, this.v3.co)
    this.worldArea = math.tri_area(l1.v.co, l2.v.co, l3.v.co)
  }
}

export class UnWrapSolver {
  preserveIslands: boolean
  selLoopsOnly: boolean
  mesh: Mesh
  faces: Set<Face>
  cd_uv: AttrRef<UVLayerElem>
  uvw: UVWrangler
  solvers: any[]
  tris: SolveTri[]
  tottri: number = 0
  saved = false

  constructor(
    mesh: Mesh,
    faces: Iterable<Face>,
    cd_uv = new AttrRef<UVLayerElem>(),
    preserveIslands = false,
    selLoopsOnly = false
  ) {
    if (!cd_uv.exists) {
      cd_uv = mesh.loops.customData.getLayerRef(UVLayerElem)
    }

    this.preserveIslands = preserveIslands
    this.selLoopsOnly = selLoopsOnly

    this.mesh = mesh
    this.faces = new Set(faces)
    this.cd_uv = cd_uv
    this.uvw = new UVWrangler(mesh, faces, cd_uv)
    this.solvers = []
    this.tris = []
  }

  start(cd_uv?: AttrRef<UVLayerElem>): void {
    if (cd_uv !== undefined) {
      this.cd_uv = cd_uv
    }

    const wr = this.uvw

    console.log('this.preserveIslands', this.preserveIslands)

    wr.needTopo = true
    wr.buildIslands(!this.preserveIslands)

    for (const island of wr.islands) {
      wr.updateAABB(island)

      island.oldmin = new Vector2(island.min)
      island.oldmax = new Vector2(island.max)
      island.oldsize = new Vector2(island.max).sub(island.min)
    }

    for (const island of wr.islands) {
      let ok = !(this.selLoopsOnly && !island.hasSelLoops)
      ok = ok && !island.hasPins
      ok = ok && !this.preserveIslands

      if (!ok) {
        continue
      }

      const no = new Vector3()
      const co = new Vector3()
      let tot = 0.0

      for (const v of island) {
        for (const l of wr.vertMap.get(v)!) {
          no.add(l.f.no)
        }
      }

      if (no.dot(no) < 0.00001) {
        continue
      }

      no.normalize()

      let variance = 0.0
      tot = 0.0

      for (const v of island) {
        for (const l of wr.vertMap.get(v)!) {
          const th = Math.acos(no.dot(l.f.no) * 0.99999)
          variance += th * th
          tot++
        }
      }

      if (tot !== 0.0) {
        variance = variance / tot
      }

      console.log('normal variance of island patch:', variance)

      if (variance > 1.0) {
        //continue;
      }

      const mat = new Matrix4()
      mat.makeNormalMatrix(no)
      mat.invert()

      for (const v of island) {
        co.zero()
        let tot = 0.0

        for (const l of wr.vertMap.get(v)!) {
          co.add(l.v.co)
          tot++
        }

        if (!tot) {
          continue
        }

        co.mulScalar(1.0 / tot)

        co.multVecMatrix(mat)
        co[2] = 0.0
        v.co.load(co)

        //v.multVecMatrix(mat);
        //v.interp(co, 0.5);
      }

      wr.updateAABB(island)

      for (const v of island) {
        v.co.sub(island.min)
      }

      wr.updateAABB(island)
    }

    const cd_corner = wr.cd_corner

    for (const v of this.uvw.uvMesh!.verts) {
      const cv = cd_corner.get(v)

      cv.vel = new Vector2()
      cv.oldco = new Vector2()
      cv.oldvel = new Vector2()
    }

    if (!this.preserveIslands) {
      this.packIslands()
    }

    this.buildSolver()
    wr.finish()
  }

  packIslands() {
    this.uvw.packIslands(true, true)
  }

  buildSolver(includeArea = true) {
    this.solvers = []
    this.tris.length = 0

    const mesh = this.mesh

    const ltris = mesh.loopTris!
    const trimap = new Map()
    const uvw = this.uvw

    const cd_corner = uvw.cd_corner

    for (const v of uvw.uvMesh!.verts) {
      cd_corner.get(v)!.tris = []
    }

    const faces = this.faces
    console.log(faces)

    for (let i = 0; i < ltris.length; i += 3) {
      const l1 = ltris[i],
        l2 = ltris[i + 1],
        l3 = ltris[i + 2]

      if (!faces.has(l1.f) || !faces.has(l2.f) || !faces.has(l3.f)) {
        continue
      }

      const v1 = uvw.loopMap.get(l1)!
      const v2 = uvw.loopMap.get(l2)!
      const v3 = uvw.loopMap.get(l3)!

      if (v1 === v2 || v1 === v3 || v2 === v3) {
        continue
      }

      const tri = new SolveTri(l1, l2, l3, v1, v2, v3)
      this.tris.push(tri)

      trimap.set(l1, tri)
      trimap.set(l2, tri)
      trimap.set(l3, tri)

      for (let j = 0; j < 3; j++) {
        const v = uvw.loopMap.get(ltris[i + j])!
        cd_corner.get(v).tris!.push(tri)
      }
    }

    for (const v of uvw.uvMesh!.verts) {
      v.co[2] = 0.0
    }

    for (const v of uvw.uvMesh!.verts) {
      let tot = 0
      let totarea = 0

      for (const tri of cd_corner.get(v).tris!) {
        const w = math.winding(tri.v1.co, tri.v2.co, tri.v3.co)
        tot += w ? 1 : -1

        totarea += math.tri_area(tri.v1.co, tri.v2.co, tri.v3.co)
      }

      cd_corner.get(v).area = totarea
      cd_corner.get(v).wind = tot >= 0.0
    }

    /*
    on factor;
    
    load_package "avector";
    load_package "trigsimp";
    
    let (v1x-v2x)**2 + (v1y - v2y)**2 = 1.0;
    
    v1 := avec(v1x, v1y, 0.0);
    v2 := avec(v2x, v2y, 0.0);
    v3 := avec(v3x, v3y, 0.0);
    
    t1 := v2 - v1;
    t2 := v3 - v2;
    t3 := v1 - v3;
         
    l1 := VMOD t1;
    l2 := VMOD t2;
    l3 := VMOD t3;
        
    s := (l1+l2+l3)/2.0;
    f := sqrt(s*(s-l1)*(s-l2)*(s-l3));
    f := (f*wind - goal)*kmul;
    
    on fort;
    dv1x := trigsimp df(f, v1x);
    dv1y := trigsimp df(f, v1y);
    dv2x := trigsimp df(f, v2x);
    dv2y := trigsimp df(f, v2y);
    dv3x := trigsimp df(f, v3x);
    dv3y := trigsimp df(f, v3y);
    off fort;
    */

    function area_c(params: [number, Vector3, Vector3, Vector3, number, number]): number {
      const w1 = params[0]
      const v1 = params[1]
      const v2 = params[2]
      const v3 = params[3]
      const goal = params[4]
      const mul = params[5]

      v1[2] = v2[2] = v3[2] = 0.0

      const w2 = math.winding(v1, v2, v3) ? 1.0 : -1.0
      let ret = (math.tri_area(v1, v2, v3) * w2 - goal) * mul

      //ret *= ret;
      ret = Math.abs(ret)

      return ret
      //return Math.abs(ret);
    }

    function badnum(n: number) {
      return isNaN(n) || !isFinite(n) ? 0.0 : n
    }

    function area_c_df(params: [number, Vector3, Vector3, Vector3, number, number], gs: number[][]) {
      let ans1, ans2, ans3, ans4, ans5

      const sqrt = Math.sqrt

      const w1 = params[0]
      const v1 = params[1]
      const v2 = params[2]
      const v3 = params[3]
      const goal = params[4]
      const kmul = params[5]

      v1[2] = v2[2] = v3[2] = 0.0

      const v1x = v1[0],
        v1y = v1[1]
      const v2x = v2[0],
        v2y = v2[1]
      const v3x = v3[0],
        v3y = v3[1]

      const wind = math.winding(v1, v2, v3) ? 1.0 : -1.0

      ans1 =
        ((2.0 *
          sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) *
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) +
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))) *
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) -
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))) *
        (v1x - v3x) *
        kmul *
        wind
      const dv1x =
        ans1 /
        (8.0 *
          sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) *
          sqrt(
            -(sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))
          ))

      ans1 =
        ((2.0 *
          sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) *
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) +
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))) *
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) -
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))) *
        (v1y - v3y) *
        kmul *
        wind
      const dv1y =
        ans1 /
        (8.0 *
          sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) *
          sqrt(
            -(sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))
          ))

      ans1 =
        -(
          (2.0 *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0) +
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) +
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))
        ) *
        (v2x - v3x) *
        kmul *
        wind
      const dv2x =
        ans1 /
        (8.0 *
          sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) *
          sqrt(
            -(sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))
          ))

      ans1 =
        -(
          (2.0 *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0) +
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) +
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))
        ) *
        (v2y - v3y) *
        kmul *
        wind
      const dv2y =
        ans1 /
        (8.0 *
          sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) *
          sqrt(
            -(sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))
          ))

      ans1 =
        -(
          (2.0 *
            sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) * v1x -
              sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) * v2x +
              v2x -
              v3x) +
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) * (v1x - v3x) -
                sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) * (v2x - v3x))) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) -
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) * (v1x - v3x) +
              sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) * (v2x - v3x))
        ) *
        kmul *
        wind
      const dv3x =
        ans1 /
        (8.0 *
          sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) *
          sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) *
          sqrt(
            -(sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))
          ))

      ans1 =
        -(
          (2.0 *
            sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) * v1y -
              sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) * v2y +
              v2y -
              v3y) +
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) * (v1y - v3y) -
                sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) * (v2y - v3y))) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) -
          (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
            (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) * (v1y - v3y) +
              sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) * (v2y - v3y))
        ) *
        kmul *
        wind
      const dv3y =
        ans1 /
        (8.0 *
          sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) *
          sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2) *
          sqrt(
            -(sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) + 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 + sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2)) *
              (sqrt((v2x - v3x) ** 2 + (v2y - v3y) ** 2) - 1.0 - sqrt((v1x - v3x) ** 2 + (v1y - v3y) ** 2))
          ))

      gs[0][0] = badnum(dv1x)
      gs[0][1] = badnum(dv1y)
      gs[1][0] = badnum(dv2x)
      gs[1][1] = badnum(dv2y)
      gs[2][0] = badnum(dv3x)
      gs[2][1] = badnum(dv3y)
    }

    const t1 = new Vector2()
    const t2 = new Vector2()

    function angle_c(params: [Vertex, Vertex, Vertex, number, number]): number {
      const v1 = params[0]
      const v2 = params[1]
      const v3 = params[2]
      const goalth = params[3]
      const wind = params[4]

      v1.co[2] = v2.co[2] = v3.co[2] = 0.0

      const w = math.winding(v1.co, v2.co, v3.co) ? 1.0 : -1.0

      t1.load(v1.co).sub(v2.co).normalize()
      t2.load(v3.co).sub(v2.co).normalize()

      let th = -(t1[1] * t2[0] - t1[0] * t2[1])
      th = Math.asin(th * 0.99999)

      //let ret = Math.acos(t1.dot(t2)*0.999999)*w - goalth;
      const ret = th - goalth

      //ret = Math.abs(ret);
      //ret *= ret;

      return ret * ret
    }

    //console.log(this.uvw.islands);

    this.tottri = 0

    const wr = this.uvw
    for (const island of wr.islands) {
      wr.updateAABB(island)

      let ok = !island.hasPins && !this.preserveIslands
      ok = ok && !(this.selLoopsOnly && !island.hasSelLoops)

      if (ok) {
        for (const v of island) {
          v.co.sub(island.min).div(island.boxsize)
          v.co[2] = 0.0
        }
      }
    }

    for (const island of this.uvw.islands) {
      if (this.selLoopsOnly && !island.hasSelLoops) {
        continue
      }

      const tris = new Set<SolveTri>()
      const solver = new Solver()

      this.solvers.push(solver)

      for (const v of island) {
        for (const tri of cd_corner.get(v)!.tris!) {
          tris.add(tri)
        }
      }

      let totw = 0.0
      let totarea = 0.0
      let totarea2 = 0.0

      for (const tri of tris) {
        this.tottri++

        const w = math.winding(tri.v1.co, tri.v2.co, tri.v3.co)
        totw += w ? 1 : -1
        totarea += tri.area
        totarea2 += tri.worldArea
      }

      const wind = 1.0 //totw >= 0 ? 1 : -1;

      const t3 = new Vector3()
      const t4 = new Vector3()

      const df = 0.0001
      let maxarea = 0.0

      function makeAngleCon(l1: Loop, l2: Loop, l3: Loop, v1: Vertex, v2: Vertex, v3: Vertex, wind: number): void {
        t3.load(l1.v.co).sub(l2.v.co).normalize()
        t4.load(l3.v.co).sub(l2.v.co).normalize()

        //let goalth = Math.acos(t3.dot(t4));
        const w = math.winding(v1.co, v2.co, v3.co) ? 1.0 : -1.0

        t3.cross(t4)
        let goalth = t3.vectorLength() * wind

        if (w !== wind) {
          //goalth = -goalth;
        }

        goalth = Math.asin(goalth * 0.9999999)

        //if (w !== wind) {
        //goalth = Math.PI - goalth;
        //}

        const params = [v1, v2, v3, goalth, wind] as const
        const klst = [v1, v2, v3].filter((v) => !cd_corner.get(v).hasPins).map((v) => v.co)

        if (klst.length > 0) {
          const con = new Constraint('angle_c', angle_c, klst, params)
          const r = con.evaluate()

          con.df = df

          //con.k = 1.0 / (1.0 + Math.abs(r));
          //con.k = 1/(1.0+math.tri_area(v1, v2, v3) / maxarea);

          solver.add(con)
        }
      }

      const ratio = 1.0 / totarea2
      //console.log("totarea", totarea, totarea2, ratio);

      if (totarea === 0.0) {
        for (const tri of tris) {
          for (let j = 0 as Number2; j < 2; j++) {
            tri.v1.co[j] = Math.random()
            tri.v2.co[j] = Math.random()
            tri.v3.co[j] = Math.random()
          }

          tri.area = math.tri_area(tri.v1.co, tri.v2.co, tri.v3.co)
          totarea += tri.area
        }
      } else if (isNaN(totarea)) {
        console.error('UVs had NaNs in them; fixing. . .')
        for (const tri of tris) {
          for (let j = 0 as Number2; j < 2; j++) {
            tri.v1.co[j] = Math.random()
            tri.v2.co[j] = Math.random()
            tri.v3.co[j] = Math.random()
          }
        }
      } else if (totarea2 === 0.0) {
        continue
      }

      for (const tri of tris) {
        tri.area = math.tri_area(tri.v1.co, tri.v2.co, tri.v3.co)
        maxarea = Math.max(tri.area, maxarea)
      }

      for (const tri of tris) {
        const goal = tri.worldArea * ratio * wind * 1.0
        const params = [wind, tri.v1.co, tri.v2.co, tri.v3.co, goal, 100.0 / totarea] as const
        const klst = [tri.v1, tri.v2, tri.v3].filter((v) => !cd_corner.get(v).hasPins).map((v) => v.co)

        if (includeArea && klst.length > 0) {
          const con = new Constraint('area_c', area_c, klst, params)
          con.df = df
          const r = Math.abs(con.evaluate())
          con.threshold = 0.0001
          //con.k = 1/(1.0+tri.area/maxarea);

          //solver.add(con);
        }

        solver.simple = false

        //con.funcDv = area_c_df;
        makeAngleCon(tri.l1, tri.l2, tri.l3, tri.v1, tri.v2, tri.v3, wind)
        makeAngleCon(tri.l2, tri.l3, tri.l1, tri.v2, tri.v3, tri.v1, wind)
        makeAngleCon(tri.l3, tri.l1, tri.l2, tri.v3, tri.v1, tri.v2, wind)
      }
    }

    //console.log("Islands: ", this.uvw.islands.length);
    //console.log(slv);
  }

  solveIntern(slv: Solver, count: number, gk = 1.0) {
    const doneset = new WeakSet()
    const idxmap = new Map<any, number>()

    const start = util.time_ms()

    //return slv.solve(count, gk);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    function log(...args: any[]): void {
      //console.log(...args);
    }

    const pmap = new Set()
    let tot = 0
    const vec = [] as Vector2[]

    if (slv.constraints.length === 0) {
      return 0.0
    }

    for (const con of slv.constraints) {
      for (const v of con.klst) {
        if (!pmap.has(v)) {
          pmap.add(v)
          tot++
        }
      }
    }

    log('CS', slv.constraints.length, tot * 2)

    slv.randCons = true
    //return slv.solve(count, gk, false);

    let ki = 0

    for (const con of slv.constraints) {
      for (const uv of con.klst) {
        if (!doneset.has(uv)) {
          idxmap.set(uv, ki)
          doneset.add(uv)
          vec.push(uv as unknown as Vector2)
          ki += 2
        }
      }
    }

    const rowsize = ki

    log('rowsize', rowsize)

    if (slv.constraints.length === 0) {
      log('empty solver detected')
      return
    }

    const matrix = new Array<number[]>(slv.constraints.length)

    for (let i = 0; i < slv.constraints.length; i++) {
      const row = new Array<number>(rowsize)
      matrix[i] = row

      for (let j = 0; j < row.length; j++) {
        row[j] = 0
      }
    }

    const col = [] as number[]

    let toterr = 0.0

    for (let i = 0; i < slv.constraints.length; i++) {
      const con = slv.constraints[i]
      const r1 = con.evaluate()

      toterr += Math.abs(r1)

      col.push(r1)

      if (isNaN(r1)) {
        log(con)
        throw new Error('NaN')
      }

      const row = matrix[i] as number[]

      for (let j = 0; j < con.klst.length; j++) {
        const uv = con.klst[j]
        const gs = con.glst[j]

        const idx = idxmap.get(uv)

        if (idx === undefined) {
          throw new Error()
        }

        if (isNaN(gs[0]) || isNaN(gs[1])) {
          log(con)
          throw new Error('NaN2!')
        }

        // this is a genuinely baffling errro
        row[idx] = gs[0]
        row[idx + 1] = gs[1]
      }
    }

    //matrix = numeric.ccsSparse(matrix);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const numeric = (window as unknown as any)['numeric'] as any

    const matrixT = numeric.transpose(matrix)
    //let matrix1 = numeric.dotMMsmall(matrixT, matrix);
    const matrix1 = numeric.dot(matrixT, matrix)

    const svd = numeric.svd(matrix1)
    function makeMatrix(rows: number, cols: number, setIdentity = true) {
      const ret = new Array<number[]>(rows)

      for (let i = 0; i < rows; i++) {
        ret[i] = new Array<number>(cols)

        for (let j = 0; j < cols; j++) {
          ret[i][j] = 0.0
        }

        if (setIdentity) {
          ret[i][i] = 1.0
        }
      }

      return ret
    }

    const totrows = svd.S.length
    const sigma = makeMatrix(totrows, totrows, false)
    const S = svd.S

    //window.sigma = sigma;

    for (let i = 0; i < S.length; i++) {
      let f = S[i]
      f = f !== 0.0 ? 1.0 / f : 0.0

      sigma[i][i] = f
    }
    //sigma = numeric.transpose(sigma);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(matrix as unknown as any).slv = slv

    /*
    window.sigma = sigma;
    window.col = col;
    window.mat1 = matrix1;
    window.mat = matrix;
    window.matT = matrixT;
    */

    const V = numeric.transpose(svd.V)
    log('psuedo inverse')
    const pinv = numeric.dotMMsmall(numeric.dotMMsmall(svd.U, sigma), V)
    const b = numeric.dotMMsmall(pinv, matrix1)

    const c = numeric.dotMMsmall(pinv, matrixT)

    log('B', b)
    log('C', c)
    log('col', col)
    const col2 = numeric.dot(c, col)
    log('result', col2)

    for (let i = 0; i < col2.length; i += 2) {
      const x = col2[i],
        y = col2[i + 1]
      const v = vec[i >> 1]

      v[0] += -x * gk
      v[1] += -y * gk
    }

    log(vec)
    return toterr

    //return slv.solve(count, gk, false)
    /*
      matrix = MathJS.matrix(matrix, 'sparse');
      //matrix = MathJS.transpose(matrix);

      let matrixT = MathJS.transpose(matrix);
      let matrix1 = MathJS.multiply(matrixT, matrix);
      let matrixI;

      window.mat = matrix1;
      window.col = col;

      let ok = true;
      let col2;

      try {
        matrixI = MathJS.inv(matrix1);
      } catch (error) {
        util.print_stack(error);
        ok = false;
      }

      if (ok) {
        console.log("Inversion worked");

        window.imat = matrixI;
        let matrixF = MathJS.multiply(matrixI, matrixT);
        window.fmat = matrixF;
      }
    }

    //return this.solver.solve(count, gk, false);
    return toterr; //slv.solve(count, gk, false);
    */
  }

  solve(count: number, gk = 1.0) {
    const err = 0.0

    const uvmesh = this.uvw.uvMesh!
    const damp = 0.95

    const cd_corner = this.uvw.cd_corner

    for (const v of uvmesh.verts) {
      const cv = cd_corner.get(v)

      v.co[0] += cv.vel[0] * damp
      v.co[1] += cv.vel[1] * damp

      cv.oldco.load(v.co)
      v.co[2] = 0.0
    }

    for (const slv of this.solvers) {
      //iterate guess-seidel
      slv.solve(1, gk)

      //least squares
      //err += this.solveIntern(slv, count, gk);

      //guess-seidel
      slv.solve(1, gk)
    }

    for (const v of uvmesh.verts) {
      const cv = cd_corner.get(v)

      cv.vel.load(v.co).sub(cv.oldco)
    }

    return err
  }

  step(extraCount = 0, gk = 1.0) {
    const count = 1 + extraCount
    const count2 = 3

    let time = util.time_ms()
    let err: number | undefined

    const uvmesh = this.uvw.uvMesh!
    const tmp = new Vector3()

    const smoothvs = new Set<Vertex>()
    for (const island of this.uvw.islands) {
      if (this.selLoopsOnly && !island.hasSelLoops) {
        continue
      }

      for (const v of island) {
        smoothvs.add(v)
      }
    }

    const cd_corner = this.uvw.cd_corner

    const vsmooth = (fac: number): void => {
      for (const v of smoothvs) {
        if (cd_corner.get(v).hasPins) {
          continue
        }

        tmp.zero()
        let w = 1.0

        if (cd_corner.get(v).corner) {
          w = 10
        }

        tmp.addFac(v.co, w)
        let tot = w

        for (const e of v.edges) {
          let w2 = 1.0
          const v2 = e.otherVertex(v)
          const cv = cd_corner.get(v2)

          if (cv.hasPins) {
            w2 = 10000.0
          } else if (cv.corner) {
            //w = 10;
          }

          tmp.addFac(v2.co, w2)
          tot += w2
        }

        if (tot === 0) {
          continue
        }

        tmp.mulScalar(1.0 / tot)
        v.co.interp(tmp, fac)
        v.co[2] = 0.0
      }
    }

    let si = 0
    const solvestep = (gk = 1.0, damp = 0.95) => {
      //this.buildSolver();

      const cd_corner = this.uvw.cd_corner

      for (let i = 0; i < count; i++) {
        for (const v of uvmesh.verts) {
          const cv = cd_corner.get(v)

          v.co[0] += cv.vel[0] * damp
          v.co[1] += cv.vel[1] * damp

          cv.oldco.load(v.co)
        }

        err = this.solve(count, gk)
        //vsmooth(0.05);

        for (const v of uvmesh.verts) {
          const cv = cd_corner.get(v)

          cv.vel.load(v.co).sub(cv.oldco)
        }

        si++
      }

      return gk
    }

    for (let i = 0; i < count2; i++) {
      vsmooth(0.75)
    }

    this.solve(count, gk)
    console.log('gk', gk)
    //solvestep(gk);

    if (0) {
      for (let i = 0; i < count2; i++) {
        //gk = solvestep(gk);
      }
      //solvestep(0.05, 0.0);

      for (let i = 0; i < count2; i++) {
        //  vsmooth(0.5);
      }

      this.buildSolver(false)

      for (let i = 0; i < 2; i++) {
        //XXX
        //gk = solvestep(gk*0.3);
      }
    }

    time = util.time_ms() - time
    console.log('time:', time.toFixed(2) + 'ms')

    console.log('error', err)
    console.log('tottri', this.tottri)

    const cd_uv = this.cd_uv

    for (const v of this.uvw.uvMesh!.verts) {
      const ls = this.uvw.vertMap.get(v)!

      for (const l of ls) {
        cd_uv.get(l).uv.load(v.co)
      }
    }
  }

  save() {
    if (this.saved) {
      console.error('Already saved')
      return
    }

    this.saved = true
    ;(this.mesh as unknown as number) = this.mesh.lib_id

    this.uvw.save()

    for (const tri of this.tris) {
      ;(tri.l1 as unknown as number) = tri.l1.eid
      ;(tri.l2 as unknown as number) = tri.l2.eid
      ;(tri.l3 as unknown as number) = tri.l3.eid
    }
    this.faces = this.faces.map((f) => f.eid)

    this.solvers.length = 0

    return this
  }

  restore(mesh: Mesh): boolean {
    if (!this.saved) {
      console.error('UnwrapSolver is not saved')
      return false
    }

    if ((this.mesh as unknown as number) !== mesh.lib_id) {
      console.warn('Meshes differ')
      return false
    }

    const fs = new Set<Face>()
    for (const feid of this.faces as unknown as Set<number>) {
      const f = mesh.eidMap.get<Face>(feid)
      if (f?.type !== MeshTypes.FACE) {
        console.warn('Missing face ' + feid)
        return false
      }

      fs.add(f)
    }

    this.faces = fs

    for (const tri of this.tris) {
      tri.l1 = mesh.eidMap.get<Loop>(tri.l1 as unknown as number)
      tri.l2 = mesh.eidMap.get<Loop>(tri.l2 as unknown as number)
      tri.l3 = mesh.eidMap.get<Loop>(tri.l3 as unknown as number)

      if (!tri.l1 || !tri.l2 || !tri.l3) {
        console.warn('Missing tri loops')
        return false
      }
    }

    if (!this.uvw.restore(mesh)) {
      return false
    }

    this.mesh = mesh
    this.saved = false

    this.buildSolver()

    return true
  }

  static restoreOrRebuild(
    mesh: Mesh,
    facesIn: Iterable<Face>,
    solver: UnWrapSolver,
    cd_uv?: AttrRef<UVLayerElem>,
    preserveIslands = false,
    selLoopsOnly = false
  ) {
    const faces = new Set(facesIn)

    if (cd_uv === undefined) {
      cd_uv = mesh.loops.customData.getLayerRef<UVLayerElem>('uv')
    }

    if (cd_uv.i === -1) {
      throw new Error('no UV layer')
    }

    let bad = false

    if (!solver) {
      console.warn('No solver')
      bad = true
    } else if (solver.preserveIslands !== preserveIslands) {
      console.log('preserveIslands differs')
      bad = true
    } else if (!!solver.selLoopsOnly !== !!selLoopsOnly) {
      console.log('selLoopsOnly differ')
      bad = true
    } else if (solver.faces.size !== faces.size) {
      console.log('Face list size differs; old:', solver.faces.size, 'new:', faces.size)
      bad = true
    } else if (solver.cd_uv !== cd_uv) {
      console.warn('new UV layer')
      bad = true
    } else {
      for (const f of faces) {
        if (!(f.eid in solver.faces)) {
          console.warn('New face ' + f.eid, f)
          bad = true
          break
        }
      }
    }

    bad = bad || !solver.restore(mesh)

    if (bad) {
      console.warn('Making new solver')
      solver = new UnWrapSolver(mesh, faces, cd_uv, preserveIslands, selLoopsOnly)
      solver.start()
    }

    return solver
  }

  finish() {
    const wr = this.uvw

    for (const f of this.faces) {
      f.flag |= MeshFlags.UPDATE
    }

    for (const island of wr.islands) {
      wr.updateAABB(island)
    }

    if (!this.preserveIslands) {
      this.packIslands()
    } else {
      /*
      for (const island of wr.islands) {
        let ok = this.preserveIslands;
        ok = ok || (this.selLoopsOnly && !island.hasSelLoops);
        ok = ok && !island.hasPins;
        ok = ok && island.oldsize !== undefined && island.oldmin;

        if (!ok) {
          continue;
        }

        wr.updateAABB(island);

        for (let v of island) {
          v.sub(island.min).div(island.boxsize).mul(island.oldsize).add(island.oldmin);
        }

        wr.updateAABB(island);
      }
      */
    }

    wr.finish()
  }
}

export function fixSeams(mesh: Mesh, cd_uv: AttrRef<UVLayerElem>) {
  const wrangler = new UVWrangler(mesh, mesh.faces, cd_uv)
  wrangler.buildIslands()

  const seams = new Set()

  const tmp1 = new Vector2()
  const tmp2 = new Vector2()

  function error(params: [Edge]) {
    const e = params[0]

    if (e.l === undefined) {
      return 0
    }

    const l1 = e.l,
      l2 = l1.radial_next
    const uv1a = l1.customData.get(cd_uv).uv
    const uv1b = l1.next.customData.get(cd_uv).uv
    const uv2a = l2.next.customData.get(cd_uv).uv
    const uv2b = l2.customData.get(cd_uv).uv

    const texSize = 1024.0

    function round(n: number) {
      return Math.floor(n + 0.01)
    }

    tmp1.load(uv1a).sub(uv2a)
    tmp2.load(uv1b).sub(uv2b)

    tmp1.mulScalar(texSize)
    tmp2.mulScalar(texSize)

    let err = 0.0

    //err += Math.abs(len1 - round(len1));
    //err += Math.abs(len2 - round(len2));
    err += Math.abs(tmp1[0] - round(tmp1[0])) ** 2
    err += Math.abs(tmp1[1] - round(tmp1[1])) ** 2
    err += Math.abs(tmp2[0] - round(tmp2[0])) ** 2
    err += Math.abs(tmp2[1] - round(tmp2[1])) ** 2

    return err
  }

  const solver = new Solver()

  for (const l1 of mesh.loops) {
    if (l1.radial_next === l1) {
      continue
    }

    const l2 = l1.radial_next
    const uv1a = l1.customData.get(cd_uv).uv
    const uv1b = l1.next.customData.get(cd_uv).uv
    const uv2a = l2.next.customData.get(cd_uv).uv
    const uv2b = l2.customData.get(cd_uv).uv

    const d1 = uv1a.vectorDistance(uv2a)
    const d2 = uv1b.vectorDistance(uv2b)

    if (d1 > 0.0001 || d2 > 0.0001) {
      const e = l1.e

      if (!seams.has(e)) {
        const con = new Constraint('', error, [uv1a, uv1b, uv2a, uv2b], [e], 1.0)
        solver.add(con)
      }

      seams.add(l1.e)
    }
  }

  //for (let e of seams) {
  //let err = error([e]);
  //console.log("err", err);
  //}

  //XXX this is absurdly small. . .
  const gk = 0.000005
  solver.solve(500, gk, true)
  console.log(solver, gk)

  console.log('Wrangler', wrangler)
  console.log('Seams', seams)
}
