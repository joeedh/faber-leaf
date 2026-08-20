/**
 * Sculptcore fuzz-stroke driver. Exposes `globalThis.__fuzzTest(opts)`, driven
 * from the Electron headless harness via `--eval` (see
 * `tests/integration/sculptcore_fuzz.test.ts`); the structured result is
 * reflected into the `--dump` JSON as `fuzztest`.
 *
 * Each iteration picks a random sculptcore-valid brush tool, runs a random
 * stroke (random surface anchor, 1–6 dabs, grab-style tools march the dabs),
 * and with a 1/5 probability toggles dynamic topology on/off first. After every
 * stroke it refreshes the spatial tree (the "wait for redraw" the interactive
 * path does) and scans live vertex positions for non-finite floats. The full
 * action list is logged (seed + per-stroke params) so any run is replayable.
 *
 * Motivation (ImmediateTODOs): hunt the intermittent dyntopo crash. The PRNG is
 * seeded, so a crashing run's `seed` reproduces it exactly.
 */

import {peekAppState} from '@framework/api'
import {SculptTools} from '../../../../scripts/brush/brush_base'
import {DynTopoFlagsSC} from '../../../../scripts/brush/brush_base'
import {DefaultBrushes, type SculptBrush} from '../../../../scripts/brush/index'
import {runSculptcoreStroke} from './sculptcore_ops'
import {TOOL_TO_SCULPTBRUSH, resolveToolDabPolicy} from './sculptcore_bindings'
import {LiteMesh} from './litemesh'

/** One logged stroke — enough to replay the run deterministically. */
interface FuzzAction {
  i: number
  tool: number
  toolName: string
  /** Object-local anchor of the (first) dab. */
  p: [number, number, number]
  dabs: number
  strength: number
  radius: number
  /** Dyntopo enabled for this stroke. */
  dyntopo: boolean
  /** This stroke flipped the dyntopo flag before running. */
  toggledDyntopo: boolean
}

interface FuzzTestResult {
  ok: boolean
  error?: string
  seed: number
  iters: number
  /** Strokes actually run before stopping (== iters unless it crashed/timed out). */
  ranStrokes: number
  /** Index of the stroke that threw, if any. */
  crashedAt?: number
  /** First stroke whose post-stroke scan saw a non-finite vertex. */
  nonFiniteAt?: number
  finalVertCount?: number
  log: FuzzAction[]
}

/** mulberry32 — tiny seedable PRNG so a crashing seed replays bit-for-bit. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Geometry-deforming sculptcore tools (the dyntopo-relevant set). Color /
 * poly-group / mask paint need attribute layers and aren't useful for the
 * topology fuzzer, so they're excluded. */
function fuzzTools(): number[] {
  const skip = new Set<number>([
    SculptTools.COLOR,
    SculptTools.PAINT_SMOOTH,
    SculptTools.POLYGROUP,
    SculptTools.MASK_PAINT,
  ])
  return Object.keys(TOOL_TO_SCULPTBRUSH)
    .map(Number)
    .filter((t) => !skip.has(t))
}

/** Scan live vertex positions for NaN/Inf — the crash/corruption signal. */
function hasNonFinite(mesh: LiteMesh): boolean {
  const {co} = mesh.dumpVertCo()
  for (let i = 0; i < co.length; i++) {
    const p = co[i]
    if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) return true
  }
  return false
}

function fuzzTest(opts: {iters?: number; seed?: number; maxMs?: number} = {}): FuzzTestResult {
  const iters = opts.iters ?? 50
  const seed = (opts.seed ?? 0x1234abcd) >>> 0
  const maxMs = opts.maxMs ?? 60_000
  const result: FuzzTestResult = {ok: false, seed, iters, ranStrokes: 0, log: []}

  try {
    const mesh = peekAppState()?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const slotMap = DefaultBrushes.slotMap
    const need = (tool: number): SculptBrush => {
      if (slotMap[tool]) {
        return slotMap[tool]
      }
      throw new Error(`no default brush for tool ${tool}`)
    }

    // Recover the pole distance R from live verts, derive a brush radius.
    const {co} = mesh.dumpVertCo()
    if (co.length === 0) throw new Error('mesh has no vertices')
    let R = 0
    for (let i = 0; i < co.length; i++) {
      const r = Math.hypot(co[i][0], co[i][1], co[i][2])
      if (r > R) R = r
    }
    const radius = Math.max(R * 0.25, 1e-3)

    const rng = mulberry32(seed)
    const tools = fuzzTools()
    const t0 = Date.now()

    for (let i = 0; i < iters; i++) {
      if (Date.now() - t0 > maxMs) break

      const tool = tools[Math.floor(rng() * tools.length)] ?? SculptTools.DRAW
      const brush = need(tool)
      if (!brush) continue

      // Random surface anchor: a live vertex, projected to the sphere of radius
      // R, with its (normalized) position as the dab normal.
      const v = co[Math.floor(rng() * co.length)]
      let nx = v[0],
        ny = v[1],
        nz = v[2]
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len
      const p: [number, number, number] = [nx * R, ny * R, nz * R]
      const normal = [nx, ny, nz]

      // 1/5: toggle dyntopo before the stroke.
      const toggle = rng() < 0.2
      if (toggle) {
        brush.dynTopoSC.flag ^= DynTopoFlagsSC.ENABLED
      }
      const dyntopo = brush.dynTopoSC.enabled

      const dabCount = 1 + Math.floor(rng() * 6)
      const strength = 0.25 + rng() * 0.75
      const savedStrength = brush.strength
      brush.strength = strength

      // Grab-style brushes need moving dabs (grabTo is the per-dab delta); march
      // a tangent direction across the surface near the anchor.
      const dabs: {p: number[]; normal: number[]}[] = []
      if (resolveToolDabPolicy(tool).isGrab) {
        // Build a tangent perpendicular to the normal.
        let tx = -ny,
          ty = nx,
          tz = 0
        if (Math.hypot(tx, ty, tz) < 1e-4) {
          tx = 0
          ty = -nz
          tz = ny
        }
        const tl = Math.hypot(tx, ty, tz) || 1
        tx /= tl
        ty /= tl
        tz /= tl
        const step = radius * 0.3
        for (let d = 0; d < dabCount; d++) {
          dabs.push({p: [p[0] + tx * step * d, p[1] + ty * step * d, p[2] + tz * step * d], normal})
        }
      } else {
        for (let d = 0; d < dabCount; d++) dabs.push({p: [...p], normal})
      }

      result.log.push({
        i,
        tool,
        toolName: SculptTools[tool] ?? String(tool),
        p,
        dabs: dabCount,
        strength,
        radius,
        dyntopo,
        toggledDyntopo: toggle,
      })

      runSculptcoreStroke({mesh, brush, dabs, radius})
      brush.strength = savedStrength

      // "Wait for redraw": the interactive path refreshes the spatial tree (and
      // GPU buffers) after each stroke; mirror that so dyntopo currency bugs that
      // only surface during the spatial walk are exercised here too.
      try {
        ;(mesh.spatial as unknown as {update?: (gpu: unknown) => void}).update?.(
          (mesh.wasm as unknown as {gpu: unknown}).gpu
        )
      } catch {
        /* headless GPU refresh is best-effort */
      }

      result.ranStrokes = i + 1
      if (result.nonFiniteAt === undefined && hasNonFinite(mesh)) {
        result.nonFiniteAt = i
      }
    }

    result.finalVertCount = mesh.dumpVertCo().idx.length
    result.ok = true
  } catch (err) {
    result.crashedAt = result.ranStrokes
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  ;(globalThis as {__fuzzTestResult?: FuzzTestResult}).__fuzzTestResult = result
  return result
}

;(globalThis as {__fuzzTest?: typeof fuzzTest}).__fuzzTest = fuzzTest

export {fuzzTest}
