/**
 * Step 4a measurement for the per-face material plan
 * (documentation/plans/2026-07-16-1700-per-face-material-attribute.md): how far
 * does material assignment cut across the spatial tree's grouping, and so what
 * would splitting draws by material actually cost?
 *
 * Exposes `globalThis.__materialFragTest()`; the NW.js headless harness drives
 * it from `--eval` and stores the result on `__evalTestResult`.
 *
 * Two granularities, because they answer different questions:
 *  - per GPU node -> the draw-command count. Splitting emits one command per
 *    (GPU node x slot it touches), so `gpu.distinctSum` IS the post-split
 *    command count; today's count is the node count, and the ratio is the
 *    multiplier against the 2.0ms/frame baseline.
 *  - per leaf -> the implementation cost. GpuData::slices already holds a
 *    contiguous vert range per leaf, so if leaves are almost all single-slot,
 *    splitting can reorder whole LeafSlices by slot instead of sorting tris
 *    within a leaf.
 *
 * Regions are built from face-index ranges: on a freshly generated spherified
 * cube that is generation order (side-major, then grid), i.e. spatially
 * coherent. `speckle` is the control for exactly that assumption -- it assigns
 * at random, so if the coherent scenarios score like speckle then index order
 * is not spatial and the coherent numbers are meaningless.
 */

import {LiteMesh} from './litemesh'
import type {ViewContext} from '../../../../scripts/core/context'

interface Hist {
  /** Entries measured (leaves, or GPU nodes == today's draw commands). */
  nodes: number
  /** Entries touching more than one slot. */
  straddling: number
  straddleFrac: number
  /** Sum of distinct slots per entry. For GPU nodes: the post-split command count. */
  distinctSum: number
  maxDistinct: number
  histogram: Record<number, number>
}

export interface MaterialFragScenario {
  name: string
  slots: number
  leaf: Hist
  gpu: Hist
  /** Post-split draw commands / today's draw commands. null when invalid. */
  multiplier: number | null
  /** False when the tree reported no GPU nodes — see the leak note in the file
   * header. Never let an invalid run report a plausible multiplier. */
  valid: boolean
}

export interface MaterialFragTestResult {
  ok: boolean
  error?: string
  faces?: number
  gpuTriTarget?: number
  drawCommands?: number
  scenarios?: MaterialFragScenario[]
}

function summarize(stats: {id: number; distinct: number; mask: number}[]): Hist {
  const h: Hist = {
    nodes       : stats.length,
    straddling  : 0,
    straddleFrac: 0,
    distinctSum : 0,
    maxDistinct : 0,
    histogram   : {},
  }
  for (const s of stats) {
    h.distinctSum += s.distinct
    if (s.distinct > 1) {
      h.straddling++
    }
    if (s.distinct > h.maxDistinct) {
      h.maxDistinct = s.distinct
    }
    h.histogram[s.distinct] = (h.histogram[s.distinct] ?? 0) + 1
  }
  h.straddleFrac = h.nodes > 0 ? h.straddling / h.nodes : 0
  return h
}

/** Deterministic LCG — the speckle control must be reproducible run to run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Scenario {
  name: string
  slots: number
  slotOf: (f: number, n: number, rand: () => number) => number
}

const SCENARIOS: Scenario[] = [
  /* Two big contiguous regions — the "paint half the model" case. */
  {name: 'halves2', slots: 2, slotOf: (f, n) => (f < n / 2 ? 0 : 1)},
  /* Four contiguous quarters. */
  {name: 'quarters4', slots: 4, slotOf: (f, n) => Math.min(3, Math.floor((f * 4) / n))},
  /* The six generated cube sides — the most realistic "materials on a model". */
  {name: 'sides6', slots: 6, slotOf: (f, n) => Math.min(5, Math.floor((f * 6) / n))},
  /* 64 alternating bands over 4 slots: much more boundary, still coherent. */
  {name: 'bands64x4', slots: 4, slotOf: (f, n) => Math.floor((f * 64) / n) % 4},
  /* Adversarial control: random per face. Also validates that the coherent
   * scenarios really are spatially coherent — if they score like this one,
   * face-index order is not spatial and their numbers mean nothing. */
  {name: 'speckle4', slots: 4, slotOf: (_f, _n, rand) => Math.floor(rand() * 4)},
]

async function materialFragTest(opts?: {only?: string}): Promise<MaterialFragTestResult> {
  const r: MaterialFragTestResult = {ok: false}
  try {
    const ctx = _appstate.ctx as ViewContext
    const mesh = ctx.scene.objects.active!.data as LiteMesh
    const m = mesh.mesh as unknown as {f: {count: number}}
    const n = m.f.count

    r.faces = n
    /* The tree's own value, not the global that may never have been set. */
    r.gpuTriTarget = (mesh.spatial as unknown as {gpu_tri_target: number}).gpu_tri_target

    /* Today's command count. On wasm `commands` is already array-like; native
     * needs the getBoundVector hop (see batch.ts vecMember). */
    try {
      const batch = (mesh.spatial as unknown as {getDrawBatch(): {commands: ArrayLike<unknown>}}).getDrawBatch()
      const raw = batch.commands as ArrayLike<unknown>
      r.drawCommands =
        typeof raw?.length === 'number'
          ? raw.length
          : (mesh.wasm as unknown as {getBoundVector(n: string, v: never): ArrayLike<unknown>}).getBoundVector(
              '',
              batch.commands as never
            ).length
    } catch (e) {
      r.drawCommands = -1
    }

    const all: number[] = []
    for (let f = 0; f < n; f++) {
      all.push(f)
    }

    r.scenarios = []
    for (const sc of SCENARIOS) {
      if (opts?.only && sc.name !== opts.only) {
        continue
      }
      /* Reset to slot 0 so scenarios don't inherit each other's assignment. */
      mesh.assignMaterialToFaces(all, 0)

      const rand = lcg(0x5eed)
      const bySlot: number[][] = []
      for (let s = 0; s < sc.slots; s++) {
        bySlot.push([])
      }
      for (let f = 0; f < n; f++) {
        bySlot[sc.slotOf(f, n, rand)].push(f)
      }
      /* Slot 0 is the default — only the others need writing. */
      for (let s = 1; s < sc.slots; s++) {
        if (bySlot[s].length > 0) {
          mesh.assignMaterialToFaces(bySlot[s], s)
        }
      }

      const leaf = summarize(mesh.materialStats(true))
      const gpu = summarize(mesh.materialStats(false))
      const valid = gpu.nodes > 0 && leaf.nodes > 0
      r.scenarios.push({
        name : sc.name,
        slots: sc.slots,
        leaf,
        gpu,
        multiplier: valid ? gpu.distinctSum / gpu.nodes : null,
        valid,
      })
    }

    mesh.assignMaterialToFaces(all, 0)
    r.ok = true
  } catch (e) {
    r.error = `${e}\n${e instanceof Error ? e.stack : ''}`
  }
  return r
}

declare global {
  interface Window {
    __materialFragTest: typeof materialFragTest
  }
}

window.__materialFragTest = materialFragTest
