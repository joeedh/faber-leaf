/**
 * Integration-test support for the VDM *fragment render* path (workstream V3
 * of documentation/plans/displacementAndSubSurf.md — the headless screenshot
 * A/B gate). Exposes `globalThis.__vdmRenderTest(mode)`, driven by the NW.js
 * harness via `--eval` before a `--screenshot`; the structured result reflects
 * into the `--dump` JSON as `evalResult`.
 *
 * The three modes render the same scene three ways:
 *   'flat' — undisplaced mesh, plain node material (the baseline image);
 *   'vdm'  — undisplaced mesh + a VdmStore holding one analytic splat dab,
 *            material regenerated with VDM_MODE (fragment displacement +
 *            derivative shading normal — the path under test);
 *   'ref'  — the *same* analytic dab applied to the real vertex positions
 *            (`setVertCo`), plain material — the ground-truth shading.
 *
 * The dab replicates `vdm_splat.cc` exactly: displacement = dabNormal · amp ·
 * falloff(|p − c| / radius) with amp = strength·radius·0.5 and the smoothstep
 * falloff w²(3−2w), alpha = 0 (no fold clamp) — so on a fresh store the vdm
 * and ref surfaces agree up to texel discretization. The dab is placed on the
 * sphere point facing the default camera so the bump is visible on screen,
 * and the viewport is switched to SHOW_RENDER so the RealtimeEngine BasePass
 * pushes the material (with `hasVdm` → VDM_MODE) through the real M6 wiring.
 */

import {Material} from '../../../../scripts/core/material'
import {AttributeNode, DiffuseNode, OutputNode} from '../../../../scripts/shadernodes/shader_nodes'
import {View3DFlags} from '../../../../scripts/editors/view3d/view3d_base'
import {LiteMesh} from './litemesh'
import {numVecOut} from './litemesh_vdmtest_support'

interface VdmRenderResult {
  ok: boolean
  error?: string
  mode?: string
  /** UV charts created (per-face unwrap; must be > 0). */
  charts?: number
  /** Sphere radius recovered from the vertex positions. */
  sphereR?: number
  /** Dab radius / amplitude actually used. */
  radius?: number
  amp?: number
  /** 'vdm': texels the splat wrote (must be > 0). */
  texelsTouched?: number
  /** 'vdm': live tiles after the splat (must be > 0). */
  tileCount?: number
  /** 'ref': vertices moved by the analytic dab (must be > 0). */
  refMoved?: number
  /** 'tessvdm': texels the post-build second splat wrote (must be > 0). */
  texels2?: number
  /** 'tessvdm': the tess tier re-finalized after the second splat (X3 4b:
   * texel-only change re-runs just the finalize off VdmStore.contentRev). */
  refinalized?: boolean
}

/** The C++ splat's smoothstep falloff (vdm_splat.cc): 1 at center, 0 at r. */
function falloff(dist: number, radius: number): number {
  if (dist >= radius) return 0
  const w = 1 - dist / radius
  return w * w * (3 - 2 * w)
}

/** X2 additions: 'mrflat' = multires-enabled base, no VDM (the Ptex baseline
 * image); 'ptex' = multires + a PTEX-backend store configured from the stack's
 * S2 adjacency, one splat dab, rendered through the VDM_PTEX sampler.
 * X3 additions: 'mrcoarse' = edit level 1 drawn normally (the coarse cage
 * look); 'tess' = edit level 1 with tessellatedDisplay — the GPU-amplified
 * finest level drawn through the TESS_TIER material variant. tess should
 * match mrflat's silhouette (same geometry) and differ from mrcoarse. */
function vdmRenderTest(
  mode: 'flat' | 'vdm' | 'ref' | 'mrflat' | 'ptex' | 'mrcoarse' | 'tess' | 'tessvdm'
): VdmRenderResult {
  const result: VdmRenderResult = {ok: false, mode}
  const g = globalThis as unknown as {
    _appstate?: {
      ctx?: {
        object?: {data?: unknown}
        scene?: {lights: Iterable<unknown>; toolmode?: {drawFeatureOverlay?: boolean}}
        view3d?: {flag: number; activeCamera: {pos: ArrayLike<number>}}
      }
      datalib: {add(b: unknown): void}
    }
    __evalTestResult?: VdmRenderResult
    __vdmRenderFlagLoop?: boolean
  }
  try {
    const app = g._appstate
    const mesh = app?.ctx?.object?.data
    if (!(mesh instanceof LiteMesh)) throw new Error('active object is not a LiteMesh')
    const view3d = app?.ctx?.view3d
    if (!view3d) throw new Error('no view3d')
    const wasm = mesh.wasm

    // Multires modes materialize the finest level first (its grid-chart UVs
    // are synthesized by the engine); the packed/atlas modes unwrap below.
    const multires =
      mode === 'mrflat' || mode === 'ptex' || mode === 'mrcoarse' || mode === 'tess' || mode === 'tessvdm'
    // 3 levels: dense enough that per-vertex lattice normals converge and
    // the tess chain spans two stencil levels (1 -> 3).
    if (multires && !mesh.multiresEnable(3)) throw new Error('multiresEnable failed')
    if (mode === 'mrcoarse' || mode === 'tess') {
      mesh.multiresSetLevel(1) // edit the coarse level; tess amplifies to 3
      if (mode === 'tess') {
        mesh.tessellatedDisplay = true
      }
    }

    const {idx, co} = mesh.dumpVertCo()
    let R = 0
    for (const p of co) {
      const l = Math.hypot(p[0], p[1], p[2])
      if (l > R) R = l
    }
    result.sphereR = R

    if (!multires) {
      // UV + frames prep runs in every atlas mode so the A/B mesh state is
      // uniform. Seam only the 12 cube edges (Dijkstra between spherified
      // corners) → 6 large charts; per-face charts are too small for stable
      // gradient normals.
      const corners: number[] = []
      for (let ci = 0; ci < 8; ci++) {
        const s3 = R / Math.sqrt(3)
        const dir = [(ci & 1 ? 1 : -1) * s3, (ci & 2 ? 1 : -1) * s3, (ci & 4 ? 1 : -1) * s3]
        let best = 0
        let bestD = Infinity
        for (let i = 0; i < idx.length; i++) {
          const p = co[i]
          const d = (p[0] - dir[0]) ** 2 + (p[1] - dir[1]) ** 2 + (p[2] - dir[2]) ** 2
          if (d < bestD) {
            bestD = d
            best = idx[i]
          }
        }
        corners.push(best)
      }
      const meshApi = mesh.mesh as unknown as {markSeamPath(a: number, b: number, s: number): number}
      for (let a = 0; a < 8; a++) {
        for (const bit of [1, 2, 4]) {
          const b = a ^ bit
          if (b > a) meshApi.markSeamPath(corners[a], corners[b], 1)
        }
      }
      result.charts = mesh.generateUVFromSeams(0.02).charts
    }
    wasm.Mesh_updateFrames(mesh.mesh)
    // Dab at the center of the cube *side* best facing the (fixed default)
    // camera: deterministic, on-screen, and (cap ≈ 29° < the side's 45°
    // half-extent) inside one UV chart, clear of seam-arc gradient streaks.
    const camPos = view3d.activeCamera.pos
    let n: number[] = [1, 0, 0]
    let bestDot = -Infinity
    for (const axis of [0, 1, 2]) {
      for (const sign of [1, -1]) {
        const d = sign * camPos[axis]
        if (d > bestDot) {
          bestDot = d
          n = [0, 0, 0]
          n[axis] = sign
        }
      }
    }
    const c = [n[0] * R, n[1] * R, n[2] * R]
    const radius = R * 0.5
    const strength = 1.0
    const amp = strength * radius * 0.5 // matches the splat kernel's scaling
    result.radius = radius
    result.amp = amp

    if (mode === 'vdm') {
      wasm.SpatialTree_fillDetailCarrier(mesh.spatial, 1)
      const store = wasm.VdmStore_new(1024, 32)
      result.texelsTouched = wasm.Mesh_vdmSplatDab(
        mesh.mesh,
        mesh.spatial,
        store,
        c[0],
        c[1],
        c[2],
        n[0],
        n[1],
        n[2],
        radius,
        strength,
        0.0,
        0
      )
      result.tileCount = (store as unknown as {tileCount(): number}).tileCount()
      mesh.attachVdmStore(store) // LiteMesh owns + uploads it from here on
    } else if (mode === 'ptex' || mode === 'tessvdm') {
      wasm.SpatialTree_fillDetailCarrier(mesh.spatial, 1)
      // Patch space + adjacency come from the multires stack's S2 grids.
      const store = wasm.VdmStore_new(64, 16)
      const links = numVecOut(mesh, 'int32')
      ;(mesh._multires as unknown as {vdmAdjacencyOut(out: never): void}).vdmAdjacencyOut(links.vec as never)
      const linkArr = links.read()
      const gridCount = (linkArr.length / 8) | 0
      ;(store as unknown as {configurePtex(g: number, r: number, l: never): void}).configurePtex(
        gridCount,
        0,
        links.vec as never
      )
      result.charts = gridCount
      result.texelsTouched = wasm.Mesh_vdmSplatDab(
        mesh.mesh,
        mesh.spatial,
        store,
        c[0],
        c[1],
        c[2],
        n[0],
        n[1],
        n[2],
        radius,
        strength,
        0.0,
        0
      )
      result.tileCount = (store as unknown as {tileCount(): number}).tileCount()
      mesh.attachVdmStore(store)
      if (mode === 'tessvdm') {
        // Edit coarse, render the finest with the VDM applied at amplified
        // verts (X3 stage 3 — true displaced silhouettes).
        mesh.multiresSetLevel(1)
        mesh.tessellatedDisplay = true
      }
    } else if (mode === 'ref') {
      let moved = 0
      for (let i = 0; i < idx.length; i++) {
        const p = co[i]
        const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])
        const s = falloff(d, radius)
        if (s <= 0) continue
        mesh.setVertCo(idx[i], p[0] + n[0] * amp * s, p[1] + n[1] * amp * s, p[2] + n[2] * amp * s)
        moved++
      }
      result.refMoved = moved
      mesh.recalcNormals()
      mesh.rebuildSpatialFromEdit()
    }

    // A plain diffuse node material; the AttributeNode requests a COLOR layer
    // that doesn't exist, so it default-fills white (a lit, non-black surface).
    const mat = new Material()
    const diff = new DiffuseNode()
    const output = new OutputNode()
    const attr = new AttributeNode()
    attr.attrName = 'basecolor'
    attr.category = 2 // COLOR
    mat.graph.add(diff)
    mat.graph.add(output)
    mat.graph.add(attr)
    attr.outputs.color.connect(diff.inputs.color)
    diff.outputs.surface.connect(output.inputs.surface)
    app!.datalib.add(mat)
    ;(mesh as unknown as {materials: Array<unknown> & {active?: unknown}}).materials[0] = mat

    // The seam overlay would draw every edge (markAllSeams) over the A/B
    // images — and would track the ref displacement but not the vdm one.
    const toolmode = app?.ctx?.scene?.toolmode
    if (toolmode) toolmode.drawFeatureOverlay = false

    // Rendered shading: the engine BasePass owns the LiteMesh draw from here
    // (and pushes the material WGSL with VDM_MODE when hasVdm). The solid pass
    // would revert the draw shader every frame (view3d_draw_webgpu #1).
    // Re-assert per frame: the screen relayout after the harness eval swaps in
    // a fresh View3D whose flag snapshot predates this call.
    if (!g.__vdmRenderFlagLoop) {
      g.__vdmRenderFlagLoop = true
      const assertRenderMode = (): void => {
        const v = g._appstate?.ctx?.view3d
        if (v) v.flag |= View3DFlags.SHOW_RENDER
        const tm = g._appstate?.ctx?.scene?.toolmode
        if (tm) tm.drawFeatureOverlay = false
        requestAnimationFrame(assertRenderMode)
      }
      requestAnimationFrame(assertRenderMode)
    }
    view3d.flag |= View3DFlags.SHOW_RENDER

    result.ok = true

    // The tessellated state builds asynchronously (amplify + finalize on the
    // device) and the draw falls back to the batch until it lands — wait for
    // it (plus a settle frame) so the screenshot deterministically captures
    // the tessellated render. The harness awaits the returned promise.
    if (mode === 'tess' || mode === 'tessvdm') {
      const tessMesh = mesh as unknown as {tessReady?: boolean}
      return (async () => {
        const t0 = Date.now()
        while (!tessMesh.tessReady) {
          if (Date.now() - t0 > 30000) {
            result.ok = false
            const be = (mesh as unknown as {_tessLastError?: string})._tessLastError
            result.error = 'tessellated state timeout' + (be ? `: ${be}` : '')
            g.__evalTestResult = result
            return result
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        // 4b gate (tessvdm): a texel-only change after the build must
        // re-finalize (storeRev catch-up), not rebuild or go stale. Splat a
        // second dab offset along the surface, then wait for the swap.
        if (mode === 'tessvdm') {
          const tstate = (mesh as unknown as {_tessState?: {storeRev: number}})._tessState
          const rev0 = tstate?.storeRev
          // Perpendicular axis with the smallest |n| component.
          let perp = [1, 0, 0]
          if (Math.abs(n[0]) >= Math.abs(n[1])) perp = Math.abs(n[1]) <= Math.abs(n[2]) ? [0, 1, 0] : [0, 0, 1]
          const len = Math.hypot(n[0] * 0.8 + perp[0] * 0.6, n[1] * 0.8 + perp[1] * 0.6, n[2] * 0.8 + perp[2] * 0.6)
          const c2 = [0, 1, 2].map((i) => ((n[i] * 0.8 + perp[i] * 0.6) / len) * R)
          const n2 = [0, 1, 2].map((i) => c2[i] / R)
          result.texels2 = wasm.Mesh_vdmSplatDab(
            mesh.mesh,
            mesh.spatial,
            mesh.vdmStore!,
            c2[0],
            c2[1],
            c2[2],
            n2[0],
            n2[1],
            n2[2],
            radius * 0.7,
            strength,
            0.0,
            0
          )
          const t1 = Date.now()
          // Generous window: under full-suite load (many sequential NW boots)
          // the async re-finalize can lose a 30 s race without being wrong.
          while ((mesh as unknown as {_tessState?: {storeRev: number}})._tessState?.storeRev === rev0) {
            if (Date.now() - t1 > 90000) {
              result.ok = false
              result.error = 'tess re-finalize timeout'
              g.__evalTestResult = result
              return result
            }
            // The re-finalize is kicked from the draw path — force a frame
            // each poll tick so it can't stall if the rAF loop starves.
            ;(globalThis as unknown as {redraw_viewport?: () => void}).redraw_viewport?.()
            await new Promise((r) => setTimeout(r, 100))
          }
          result.refinalized = true
        }
        await new Promise((r) => setTimeout(r, 300))
        g.__evalTestResult = result
        return result
      })() as unknown as VdmRenderResult
    }
  } catch (err) {
    result.error = String(err instanceof Error ? err.stack ?? err.message : err)
  }
  g.__evalTestResult = result
  return result
}

;(globalThis as {__vdmRenderTest?: typeof vdmRenderTest}).__vdmRenderTest = vdmRenderTest

export {vdmRenderTest}
