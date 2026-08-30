import {expect, test} from '@playwright/test'

/**
 * Boots the real app under WebGPU, loads a committed `.wproj` project file
 * through the in-page `_appstate.loadFileAsync` API, asserts the data
 * library populated, then waits for the accumulation renderer to settle and
 * screenshots the 3D canvas.
 */

// Committed sample project (note the space in the filename — encoded for the URL).
const WPROJ_URL = '/examples/sculpt%20test.wproj'

test('loads a .wproj project and renders it', async ({page}) => {
  // Uncaught JS exceptions are hard failures (this is how a bad load or a
  // WebGPU init throw surfaces). Generic resource 404s during app boot are
  // benign — collect failing URLs for diagnostics but don't fail on them.
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('requestfailed', (req) => failedRequests.push(`${req.failure()?.errorText ?? 'failed'} ${req.url()}`))
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`HTTP ${res.status()} ${res.url()}`)
  })

  // Force the WebGPU backend (renderer_flag.ts reads ?renderer=).
  await page.goto('/?renderer=webgpu')

  // App booted and built its UI screen.
  await page.waitForFunction(() => !!(window as any)._appstate?.screen, undefined, {timeout: 60_000})

  // WebGPU actually initialized in this browser.
  expect(await page.evaluate(() => !!navigator.gpu)).toBe(true)

  // Load the project file from inside the page so it shares the app's realm.
  const counts = await page.evaluate(async (url) => {
    const appstate = (window as any)._appstate
    const buf = await fetch(url).then((r) => r.arrayBuffer())

    await appstate.loadFileAsync(buf, {
      load_library   : true,
      load_screen    : false,
      load_settings  : false,
      reset_toolstack: true,
      reset_context  : true,
    })

    // datalib.mesh is aliased to brush (known bug), so count every block set.
    let total = 0
    for (const lib of appstate.datalib.libs) {
      for (const _unusedBlock of lib) total++
    }
    return total
  }, WPROJ_URL)

  if (failedRequests.length) {
    // eslint-disable-next-line no-console
    console.warn(`[e2e] non-fatal failed requests during boot/load:\n${failedRequests.join('\n')}`)
  }
  expect(pageErrors, `uncaught page errors during load:\n${pageErrors.join('\n')}`).toEqual([])
  expect(counts, 'no data blocks loaded from .wproj').toBeGreaterThan(0)

  // The 3D viewport renders into the framework's own `#webgl` canvas
  // (appended to <body>); `#canvas2d`/`#canvas3d` in index.html are unused
  // overlays. The WebGPU viewport also initializes asynchronously on the
  // first draw and the renderer accumulates samples per frame, so pump a
  // batch of frames: force a layout pass, then drive `redraw_viewport`
  // once per rAF (reset on the first frame only).
  // Force the path.ux screen to lay out its areas: a real viewport change
  // fires the window resize the screen listens to (the loaded screen's
  // areas otherwise stay unsized → glSize [0,0] → nothing renders).
  await page.setViewportSize({width: 1280, height: 800})
  await page.evaluate(async () => {
    const w = window as any
    const screen = w._appstate.screen
    // path.ux's screen.update() is a deferred generator — completeUpdate()
    // drains it synchronously so sareas actually get laid out. Without this
    // the View3D area stays zero-sized and renders nothing.
    screen.on_resize([screen.size[0], screen.size[1]], [w.innerWidth, w.innerHeight])
    screen.completeUpdate()
    screen.completeSetCSS()
    screen.completeUpdate()

    const app = w._appstate
    const view3d = screen.sareas.map((sa: any) => sa.area).find((a: any) => a?.constructor.define?.().has3D)
    const scene = app.ctx.scene

    // SHOW_RENDER (=2) drives the full RealtimeEngine render of the scene's
    // renderable meshes (materials + lighting), not just the grid overlay.
    if (view3d) view3d.flag |= 2

    const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

    // The committed sample file stores a degenerate object transform: every
    // object's `scale` input is [0,0,0]. SceneObject.exec() composes the
    // output matrix as identity·rotate·scale·parent, so a zero scale yields
    // an all-zero matrix — collapsing the geometry (and its bounding box) to
    // a point, which the renderer draws as nothing. Repair any zero/NaN
    // scale to unit scale so the loaded mesh is actually visible.
    for (const ob of [...(scene?.objects ?? [])]) {
      const s = ob.inputs?.scale?.getValue?.()
      if (s) {
        const bad = !isFinite(s.dot(s)) || s.dot(s) === 0
        if (bad) ob.inputs.scale.setValue([1, 1, 1])
      }
    }

    // Object transform matrices are computed by SceneObject.exec() in the
    // dependency graph, but graph.exec() only runs nodes flagged dirty —
    // and a freshly-loaded object node is clean. Flag each object dirty, run
    // the graph to populate the matrices, then pump a few frames.
    for (const ob of [...(scene?.objects ?? [])]) ob.graphUpdate?.()
    w.updateDataGraph?.(true)
    for (let i = 0; i < 5; i++) {
      w.redraw_viewport?.(i === 0)
      await raf()
    }

    // Now frame the camera on the largest object so the loaded geometry
    // fills the view (viewSelected() with no selection only frames origin).
    let best: any
    let bestSize = -1
    for (const ob of [...(scene?.objects ?? [])]) {
      try {
        const bb = ob.getBoundingBox?.()
        if (bb) {
          const d = bb[0].vectorDistance(bb[1])
          if (d > bestSize) {
            bestSize = d
            best = ob
          }
        }
      } catch {
        /* object has no bounds */
      }
    }
    view3d?.viewSelected?.(best)

    // Accumulate samples for the final image.
    for (let i = 0; i < 60; i++) {
      w.redraw_viewport?.(false)
      await raf()
    }
  })

  // Let the last accumulation frames settle before the capture.
  await page.waitForTimeout(500)

  const canvas = page.locator('#webgl')
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveScreenshot('sculpt-test.png', {maxDiffPixelRatio: 0.05})
})
