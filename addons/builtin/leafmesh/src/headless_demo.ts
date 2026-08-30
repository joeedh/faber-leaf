/**
 * The §8 headline, as a module the harness can call: a cube modelled into a
 * hole-bearing shape by a scripted sequence of the real ToolOps, and a tube
 * whose holed cap goes through the same ops — because no §4 op *creates* a
 * hole ring, so the cube's hole is an opening in its surface and the tube is
 * what proves the ops handle a face that carries one.
 *
 * Every step runs through `ctx.toolstack.execTool`, so what is exercised is the
 * op — its selection reading, its undo snapshot, its invalidation — and not the
 * pure function underneath, which `tests/unit/leafmesh/` already covers. Modal
 * ops are run with `is_modal = false`, which is the seam `modeling_ops.ts`
 * documents for exactly this.
 *
 * Drive it from the NW.js harness (documentation/native-electron-test-harness.md);
 * `--dump` is how an eval reports back, since renderer stdout does not reach the
 * launcher. The invocation is written out in plan §12, step 8.
 */

import type {ToolContext} from '@framework/api'
import {SceneObject} from '@framework/api'

import {Domain} from './attrs.js'
import {LeafMeshData} from './leafmesh.js'
import {makeCube, makeTube} from './primitives.js'
import {applySelection, faceHoleCount, faceVerts, flushSelection, selectAll} from './select_geom.js'
import type {SelectDomain} from './select_geom.js'
import {ELEM_NONE, LeafMesh} from './topo.js'

/** What one step of a sequence did to the mesh. */
export interface DemoStep {
  step: string
  verts: number
  edges: number
  faces: number
  holeRings: number
  boundaryEdges: number
  euler: number
  repairs: number
  /** Undone and redone in place: the mesh came back, and then went forward. */
  undoOk?: boolean
  redoOk?: boolean
}

/** A whole shape: its steps, and what undoing the lot made of it. */
export interface DemoShape {
  name: string
  steps: DemoStep[]
  baseHash: string
  finalHash: string
  undoneHash: string
  replayHash: string
  undoRestoresBase: boolean
  replayMatchesFinal: boolean
}

export interface LeafMeshDemoReport {
  ok: boolean
  error?: string
  shapes: DemoShape[]
}

/** An edge with one corner is a rim: how an opening shows up in the counts. */
function boundaryEdges(mesh: LeafMesh): number {
  let n = 0
  for (const e of mesh.e) {
    let corners = 0
    for (const _unusedC of mesh.edgeCorners(e)) {
      corners++
    }
    if (corners === 1) {
      n++
    }
  }
  return n
}

function holeRings(mesh: LeafMesh): number {
  let n = 0
  for (const f of mesh.f) {
    n += faceHoleCount(mesh, f)
  }
  return n
}

/** `V − E + F − H`; two for a closed surface of genus zero, zero for a torus. */
function eulerTerm(mesh: LeafMesh): number {
  return mesh.v.array.count - mesh.e.array.count + mesh.f.array.count - holeRings(mesh)
}

/**
 * A digest of the geometry, so undo and redo can be compared without shipping
 * every coordinate back through the dump. Sorted, and so blind to handle order:
 * an undo hands the mesh back as a copy and a redo re-runs the op against it,
 * which reallocates handles the op is free to hand out in any order.
 */
function meshHash(mesh: LeafMesh): string {
  const rows: string[] = []
  const q = (x: number): number => Math.round(x * 4096) | 0

  for (const v of mesh.v) {
    rows.push(`v ${q(mesh.v.co[v * 3])} ${q(mesh.v.co[v * 3 + 1])} ${q(mesh.v.co[v * 3 + 2])}`)
  }
  for (const f of mesh.f) {
    const vs = faceVerts(mesh, f)
      .map((v) => `${q(mesh.v.co[v * 3])},${q(mesh.v.co[v * 3 + 1])},${q(mesh.v.co[v * 3 + 2])}`)
      .sort()
    rows.push(`f ${vs.join(' ')}`)
  }
  rows.sort()

  let h = 0x811c9dc5
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      h = (h ^ row.charCodeAt(i)) >>> 0
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return h.toString(16).padStart(8, '0')
}

function centroid(mesh: LeafMesh, f: number): [number, number, number] {
  const vs = faceVerts(mesh, f)
  const c: [number, number, number] = [0, 0, 0]

  for (const v of vs) {
    c[0] += mesh.v.co[v * 3]
    c[1] += mesh.v.co[v * 3 + 1]
    c[2] += mesh.v.co[v * 3 + 2]
  }
  return [c[0] / vs.length, c[1] / vs.length, c[2] / vs.length]
}

/** The face whose centroid is nearest `co` — how a fixture names what it wants. */
function faceNear(mesh: LeafMesh, co: readonly [number, number, number]): number {
  let best = ELEM_NONE
  let bestDist = Infinity

  for (const f of mesh.f) {
    const c = centroid(mesh, f)
    const d = Math.hypot(c[0] - co[0], c[1] - co[1], c[2] - co[2])
    if (d < bestDist) {
      bestDist = d
      best = f
    }
  }
  return best
}

function vertNear(mesh: LeafMesh, co: readonly [number, number, number]): number {
  let best = ELEM_NONE
  let bestDist = Infinity

  for (const v of mesh.v) {
    const d = Math.hypot(mesh.v.co[v * 3] - co[0], mesh.v.co[v * 3 + 1] - co[1], mesh.v.co[v * 3 + 2] - co[2])
    if (d < bestDist) {
      bestDist = d
      best = v
    }
  }
  return best
}

/** Both ends on the given radius and height: an edge of one of a tube's rings. */
function ringEdge(mesh: LeafMesh, radius: number, z: number): number {
  const on = (v: number): boolean =>
    Math.abs(Math.hypot(mesh.v.co[v * 3], mesh.v.co[v * 3 + 1]) - radius) < 1e-6 &&
    Math.abs(mesh.v.co[v * 3 + 2] - z) < 1e-6

  for (const e of mesh.e) {
    if (on(mesh.e.v1[e]) && on(mesh.e.v2[e])) {
      return e
    }
  }
  return ELEM_NONE
}

function select(mesh: LeafMesh, domain: SelectDomain, elems: readonly number[]): void {
  for (const d of [Domain.VERT, Domain.EDGE, Domain.FACE] as SelectDomain[]) {
    selectAll(mesh, d, false)
  }
  applySelection(mesh, domain, elems, 'replace')
  flushSelection(mesh, domain)
}

/** Add a LeafMesh object to the scene and make it the one the ops will find. */
function addObject(ctx: ToolContext, name: string): LeafMeshData {
  const data = new LeafMeshData()
  data.name = name
  ctx.datalib.add(data)

  const sob = new SceneObject()
  ctx.datalib.add(sob)
  sob.data = data
  data.lib_addUser(sob)

  const scene = ctx.scene
  scene.add(sob)
  scene.objects.setSelect(sob, true)
  scene.objects.setActive(sob)
  sob.graphUpdate()
  data.graphUpdate()

  return data
}

function record(mesh: LeafMesh, step: string): DemoStep {
  return {
    step,
    verts        : mesh.v.array.count,
    edges        : mesh.e.array.count,
    faces        : mesh.f.array.count,
    holeRings    : holeRings(mesh),
    boundaryEdges: boundaryEdges(mesh),
    euler        : eulerTerm(mesh),
    repairs      : mesh.validateAndRepair(),
  }
}

/**
 * Build the op by toolpath and run it non-modally. The drag ops read their
 * width from an input, so with `is_modal` off they need no pointer at all.
 */
function execTool(ctx: ToolContext, path: string): void {
  const tool = ctx.api.createTool(ctx, path)
  tool.is_modal = false
  ctx.toolstack.execTool(ctx, tool)
}

/** One entry of a shape's script: what to select, and which tool to run on it. */
interface DemoOp {
  step: string
  pick: (mesh: LeafMesh) => void
  tool: string
}

/**
 * One shape: `build` seeds the mesh, then each entry runs its ToolOp against
 * whatever `pick` selected, and is immediately undone and redone in place —
 * §8's undo/redo cycle, one per tool. It has to be *in place*: a redo re-runs
 * `exec` against the live selection, so redoing a whole run only reproduces it
 * when the selections are on the undo stack too, which is what the
 * `leafmesh.select_*` ops are for and what this fixture deliberately isn't
 * using. Undoing the whole run is exact either way, and is checked at the end.
 *
 * All of it happens while this shape's object is the active one, because that
 * is where every op's `undo` looks for its mesh.
 */
function runShape(ctx: ToolContext, name: string, build: (mesh: LeafMesh) => void, script: DemoOp[]): DemoShape {
  const data = addObject(ctx, name)
  build(data.mesh)

  const steps: DemoStep[] = [record(data.mesh, 'build')]
  const baseHash = meshHash(data.mesh)

  for (const entry of script) {
    const before = meshHash(data.mesh)

    entry.pick(data.mesh)
    execTool(ctx, entry.tool)

    const step = record(data.mesh, entry.step)
    const after = meshHash(data.mesh)

    ctx.toolstack.undo()
    step.undoOk = meshHash(data.mesh) === before

    ctx.toolstack.redo()
    step.redoOk = meshHash(data.mesh) === after

    steps.push(step)
  }
  const finalHash = meshHash(data.mesh)

  for (let i = 0; i < script.length; i++) {
    ctx.toolstack.undo()
  }
  const undoneHash = meshHash(data.mesh)

  // Replay from the base the undo just restored: it leaves the scene holding
  // the finished shape rather than the cube, and the sequence proving itself
  // reproducible is what makes the numbers above worth reading.
  for (const entry of script) {
    entry.pick(data.mesh)
    execTool(ctx, entry.tool)
  }
  const replayHash = meshHash(data.mesh)

  return {
    name,
    steps,
    baseHash,
    finalHash,
    undoneHash,
    replayHash,
    undoRestoresBase  : undoneHash === baseHash,
    replayMatchesFinal: replayHash === finalHash,
  }
}

/** Select every face, which is what a subdivide-everything step wants. */
function selectAllFaces(mesh: LeafMesh): void {
  selectAll(mesh, Domain.FACE, true)
  flushSelection(mesh, Domain.FACE)
}

const CUBE_SCRIPT: DemoOp[] = [
  {step: 'subdivide every face', pick: selectAllFaces, tool: 'leafmesh.subdivide(cuts=1)'},
  {
    step: 'inset a quad of the top',
    pick: (mesh) => select(mesh, Domain.FACE, [faceNear(mesh, [0.5, 0.5, 1])]),
    tool: 'leafmesh.inset_faces(amount=0.25)',
  },
  // Each of these runs on what the one before it left selected.
  {step: 'extrude it into a boss', pick: () => {}, tool: 'leafmesh.extrude_region(offset=0.5)'},
  {step: 'inset the boss cap', pick: () => {}, tool: 'leafmesh.inset_faces(amount=0.2)'},
  {step: 'split the cap centre off, opening the boss', pick: () => {}, tool: 'leafmesh.split_off()'},
  {
    step: 'bevel the far corner',
    pick: (mesh) => select(mesh, Domain.VERT, [vertNear(mesh, [-1, -1, -1])]),
    tool: 'leafmesh.bevel_verts(amount=0.3)',
  },
]

const TUBE_SCRIPT: DemoOp[] = [
  {
    step: 'inset the holed cap',
    pick: (mesh) => select(mesh, Domain.FACE, [faceNear(mesh, [0, 0, 0.5])]),
    tool: 'leafmesh.inset_faces(amount=0.1)',
  },
  {step: 'extrude the holed cap', pick: () => {}, tool: 'leafmesh.extrude_region(offset=0.3)'},
  {
    step: 'subdivide an edge of the hole ring',
    pick: (mesh) => select(mesh, Domain.EDGE, [ringEdge(mesh, 0.5, 0.5)]),
    tool: 'leafmesh.subdivide(cuts=1)',
  },
  {
    step: 'cut a loop that meets the holed caps',
    pick: (mesh) => select(mesh, Domain.EDGE, [ringEdge(mesh, 1, 0.5)]),
    tool: 'leafmesh.loop_cut(t=0.5)',
  },
]

/**
 * A cube taken to a shape with a hole through its raised boss, and a tube whose
 * cap already carries one. Returns a plain object so `--dump` can carry it out.
 */
export function runLeafMeshHeadlessDemo(ctx: ToolContext): LeafMeshDemoReport {
  const shapes: DemoShape[] = []

  try {
    shapes.push(runShape(ctx, 'DemoCube', (mesh) => makeCube(mesh, 2), CUBE_SCRIPT))
    shapes.push(runShape(ctx, 'DemoTube', (mesh) => makeTube(mesh, 12, 1, 0.5), TUBE_SCRIPT))
  } catch (err) {
    return {ok: false, error: String((err as Error)?.stack ?? err), shapes}
  }

  const ok = shapes.every(
    (s) =>
      s.undoRestoresBase &&
      s.replayMatchesFinal &&
      s.steps.every((step) => step.repairs === 0 && step.undoOk !== false && step.redoOk !== false)
  )
  return {ok, shapes}
}
