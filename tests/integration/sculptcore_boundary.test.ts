/**
 * Boundary-constraint integration test (ImmediateTODOs: polyline-graph
 * invariance under brush strokes with/without dyntopo, plus undo/redo).
 *
 * Drives the real NW.js app headlessly per backend on the spherified
 * `litemesh-cube` scene, runs `__boundaryTest()` (addons/builtin/litemesh/src/
 * litemesh_boundarytest_support.ts) via `--eval`, and asserts the structured
 * result reflected into the `--dump` JSON as `boundarytest`. The driver marks
 * three seam paths into a pole junction with the real `litemesh.mark_seam`
 * ToolOp, then observes the constraint network through
 * `LiteMesh.boundaryGraphStats()`: non-2-valence vertex count and connected
 * component count are invariant under feature-preserving remeshing, so a
 * change in either means a brush stroke damaged the constraint network.
 *
 * Prerequisites (else self-skips, logged): a resolvable NW.js and the app
 * bundle (`pnpm build`). The native leg additionally needs the N-API addon
 * (`make.mjs build node`); without it only the WASM leg runs.
 */

import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfileArgs} from './nwjs_boot'
import {backendTable, selectedBackends} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
const BUNDLE = Path.join(REPO_ROOT, 'build', 'entry_point.js')
const NATIVE_ADDON = Path.join(REPO_ROOT, 'sculptcore', 'build', 'native-node', 'sculptcore_node.node')

interface GraphStats {
  flaggedEdges: number
  graphVerts: number
  non2ValenceVerts: number
  components: number
}

interface BoundaryTestResult {
  ok: boolean
  error?: string
  baseline0?: GraphStats
  marked?: GraphStats
  markUndo?: GraphStats
  markRedo?: GraphStats
  strokeNoDyntopo?: GraphStats
  strokeDyntopo?: GraphStats
  strokeUndo?: GraphStats
  strokeRedo?: GraphStats
  strokeSmooth?: GraphStats
  sharpPathEdges?: number
  sharpEdgeFlagSharp?: number
  sharpEdgeFlagSeam?: number
  seamFeatureVerts?: number
  sharpFeatureVerts?: number
  seamVertsUnchanged?: boolean
  unionGrewBy?: number
  poleVerts?: number[]
  pathEdgeCounts?: number[]
  junction?: number[]
  radius?: number
  leavesBeforeDyntopo?: number
  leavesAfterDyntopo?: number
}

/** Resolve the NW.js executable via the nwjs/ workspace package. */
function resolveNwjsExe(): string | undefined {
  try {
    const exe = execFileSync(
      'node',
      ['-e', "require('nw').findpath().then(p=>process.stdout.write(p),()=>process.exit(1))"],
      {
        cwd     : REPO_ROOT,
        encoding: 'utf-8',
      }
    ).trim()
    return exe && fs.existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}

/** Boot headlessly under `backend`, run __boundaryTest(), return its result. */
function runBoundaryTest(nwExe: string, backend: 'wasm' | 'native'): BoundaryTestResult {
  const out = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), 'scbound-')), `${backend}.json`)
  const env = {...process.env}
  execFileSync(
    nwExe,
    [
      REPO_ROOT,
      ...isolatedProfileArgs(),
      '--apptest-headless',
      '--no-devtools',
      '--backend',
      backend,
      '--gen-scene',
      'litemesh-cube',
      // Moderate density: long enough seam paths for clear graph structure,
      // enough verts under the dab for dyntopo to actually split/collapse.
      '--scene-arg',
      'subdiv=32',
      '--eval',
      '__boundaryTest()',
      '--dump',
      out,
      '--exit',
    ],
    {cwd: REPO_ROOT, env, encoding: 'utf-8', stdio: 'pipe', timeout: 120000}
  )
  if (!fs.existsSync(out)) throw new Error(`${backend} dump not written to ${out}`)
  const dump = JSON.parse(fs.readFileSync(out, 'utf-8')) as {boundarytest?: BoundaryTestResult}
  if (!dump.boundarytest) throw new Error(`${backend} dump has no boundarytest result`)
  return dump.boundarytest
}

const nwExe = resolveNwjsExe()
const haveBundle = fs.existsSync(BUNDLE)
const haveNative = fs.existsSync(NATIVE_ADDON)
const backends = selectedBackends(haveNative)
const canRun = !!nwExe && haveBundle && backends.length > 0

if (!canRun) {
  const why = [
    !nwExe && 'nw not resolvable (nwjs/ workspace)',
    !haveBundle && `app bundle missing (${Path.relative(REPO_ROOT, BUNDLE)}; run pnpm build)`,
  ]
    .filter(Boolean)
    .join('; ')
  // eslint-disable-next-line no-console
  console.warn(`[sculptcore-boundary] skipped: ${why}`)
} else if (!haveNative) {
  // eslint-disable-next-line no-console
  console.warn('[sculptcore-boundary] native leg skipped: addon missing (run make.mjs build node)')
}

const maybe = canRun ? describe : describe.skip

maybe.each(backendTable(backends))('sculptcore boundary constraints (%s)', (backend) => {
  let r: BoundaryTestResult

  beforeAll(() => {
    r = runBoundaryTest(nwExe!, backend)
  }, 180000)

  test('driver ran cleanly', () => {
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sculptcore-boundary] ${backend} driver error:\n${r.error}`)
    }
    expect(r.ok).toBe(true)
    expect(r.poleVerts).toHaveLength(4)
  })

  test('fresh scene has an empty constraint graph', () => {
    expect(r.baseline0).toEqual({flaggedEdges: 0, graphVerts: 0, non2ValenceVerts: 0, components: 0})
  })

  test('marking 3 seam paths builds a junctioned polyline graph', () => {
    // Each mark must flag fresh edges (the paths only share vertices).
    expect(r.pathEdgeCounts!.every((n) => n > 0)).toBe(true)
    expect(r.marked!.flaggedEdges).toBeGreaterThan(0)
    // V = E + components - cycles; the A→B meridian riding through pole D
    // closes one A→D→C→A cycle, so V is E or E+1 depending on routing.
    expect(r.marked!.graphVerts).toBeGreaterThanOrEqual(r.marked!.flaggedEdges)
    // Two meridians + an equator arc → junction/endpoint verts exist, all in
    // one connected component.
    expect(r.marked!.non2ValenceVerts).toBeGreaterThan(0)
    expect(r.marked!.components).toBe(1)
  })

  test('toolstack undo of the mark ops restores the empty graph', () => {
    expect(r.markUndo).toEqual(r.baseline0)
  })

  test('toolstack redo of the mark ops restores the marked graph', () => {
    expect(r.markRedo).toEqual(r.marked)
  })

  test('stroke with dyntopo OFF leaves the graph untouched', () => {
    // Frozen topology: every field must match exactly, not just invariants.
    expect(r.strokeNoDyntopo).toEqual(r.marked)
  })

  test('dyntopo stroke actually remeshed (split seam edges)', () => {
    // Splits along the flagged seams under the dab propagate the seam flag to
    // both halves, so flaggedEdges growing past marked's proves remeshing ran.
    expect(r.strokeDyntopo!.flaggedEdges).toBeGreaterThan(r.marked!.flaggedEdges)
  })

  test('stroke with dyntopo ON preserves the polyline-graph invariants', () => {
    // flaggedEdges/graphVerts legitimately change (splits add 2-valence chain
    // verts); junction/endpoint count and connectivity must not.
    expect(r.strokeDyntopo!.non2ValenceVerts).toBe(r.marked!.non2ValenceVerts)
    expect(r.strokeDyntopo!.components).toBe(r.marked!.components)
  })

  test('MeshLog undo of both strokes restores the marked graph', () => {
    expect(r.strokeUndo).toEqual(r.marked)
  })

  test('MeshLog redo restores the post-dyntopo graph', () => {
    expect(r.strokeRedo).toEqual(r.strokeDyntopo)
  })

  test('SMOOTH stroke (boundary-aware bsmooth kernel) over the seam leaves the graph intact', () => {
    // The SMOOTH tool now routes to the bsmooth kernel. With dyntopo OFF the
    // topology is frozen, so smoothing the seam junction must not add, drop, or
    // re-flag any boundary edge — the constraint graph is byte-for-byte equal.
    expect(r.strokeSmooth).toEqual(r.strokeRedo)
  })

  test('marking a sharp-edge path (the sharp tool path) flags EDGE_SHARP only', () => {
    // The sharp tool drives markEdgePath(kind=1). EDGE_SHARP is a separate
    // attribute from EDGE_SEAM, so the marked path reads sharp=1 / seam=0.
    expect(r.sharpPathEdges!).toBeGreaterThan(0)
    expect(r.sharpEdgeFlagSharp).toBe(1)
    expect(r.sharpEdgeFlagSeam).toBe(0)
  })

  test('featureVerts(kind) returns per-kind vertex sets; seam set is untouched', () => {
    // featureVerts(1) (sharp) is non-empty after the mark; featureVerts(0)
    // (seam) is unchanged by the sharp mark — the two flags are independent.
    expect(r.sharpFeatureVerts!).toBeGreaterThan(0)
    expect(r.seamFeatureVerts!).toBeGreaterThan(0)
    expect(r.seamVertsUnchanged).toBe(true)
  })

  test('the union boundary graph counts sharp edges alongside seams', () => {
    // boundaryGraphStats unions all boundary flags. The sharp path shares the
    // pole verts with the seam network, so some of its edges were already
    // seam-flagged (already in the union); the union grows by the sharp-only
    // edges — positive (sharp edges ARE counted) but ≤ the total sharp count.
    expect(r.unionGrewBy!).toBeGreaterThan(0)
    expect(r.unionGrewBy!).toBeLessThanOrEqual(r.sharpPathEdges!)
  })
})
