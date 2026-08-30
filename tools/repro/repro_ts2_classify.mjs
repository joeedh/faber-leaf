/* eslint-disable no-console */
/* Characterize the undo->redo round-trip loss. Capture index-aligned mesh co
 * at three points of the TOP step: P (replayed top), U (after one undo), Q
 * (after redo back to top). Q should equal P exactly. For each vert where
 * P != Q, classify: Q==U (redo didn't re-apply), else "other". Also dump the
 * worst few and whether they were created during the step (absent at U). */
import {chromium} from '@playwright/test'

const PORT = process.env.E2E_PORT ?? 5099
const BASE = `http://localhost:${PORT}`
const WPROJ = '/examples/ts2.wproj'

const browser = await chromium.launch({
  channel: 'chromium',
  args   : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=default', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[error]', m.text())
})

await page.goto(`${BASE}/?renderer=webgpu`)
await page.waitForFunction(() => !!window._appstate?.screen, undefined, {timeout: 60000})

await page.evaluate(() => {
  window.__co = () => {
    const mesh = globalThis._appstate?.ctx?.object?.data
    const wasm = mesh.wasm
    const cls = wasm.manager.findVectorClass('float')
    const vec = wasm.manager.constructWith(cls.findDefaultConstructor())
    mesh.mesh.dumpVertCo(vec)
    const arr = wasm.getBoundVector(cls.buildFullName(), vec)
    const m = new Map()
    for (let i = 0; i + 3 < arr.length; i += 4) m.set(arr[i] | 0, [arr[i + 1], arr[i + 2], arr[i + 3]])
    return m
  }
})

await page.evaluate(async (url) => {
  const buf = await fetch(url).then((r) => r.arrayBuffer())
  await window._appstate.loadFileAsync(buf, {
    load_library   : true,
    load_screen    : false,
    load_settings  : false,
    reset_toolstack: true,
    reset_context  : true,
  })
}, WPROJ)
await page.evaluate(() => {
  window.requestAnimationFrame = () => 0
})

const len = await page.evaluate(async () => {
  await window._appstate.ctx.replay(() => true)
  return window._appstate.toolstack.length
})
console.log('replayed, len', len)

const res = await page.evaluate(() => {
  const ts = window._appstate.toolstack
  const P = window.__co()
  ts.undo()
  const U = window.__co()
  ts.redo()
  const Q = window.__co()
  const eq = (a, b) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6
  let qEqU = 0
  let qOther = 0
  let createdInStep = 0
  let worst = 0
  let worstIdx = -1
  const diffs = []
  for (const [idx, p] of P) {
    const q = Q.get(idx)
    if (!q) continue
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    if (d <= 1e-6) continue
    if (d > worst) {
      worst = d
      worstIdx = idx
    }
    const u = U.get(idx)
    if (!u) createdInStep++ // vert absent after undo => created during step 3
    if (eq(q, u)) qEqU++
    else qOther++
    if (diffs.length < 6)
      diffs.push({
        idx,
        p: p.map((x) => +x.toFixed(4)),
        u: u ? u.map((x) => +x.toFixed(4)) : null,
        q: q.map((x) => +x.toFixed(4)),
        d: +d.toFixed(4),
      })
  }
  return {sizeP: P.size, sizeU: U.size, sizeQ: Q.size, qEqU, qOther, createdInStep, worst, worstIdx, diffs}
})
console.log('sizes: P(top)=' + res.sizeP + ' U(undo)=' + res.sizeU + ' Q(redo)=' + res.sizeQ)
console.log(
  'P!=Q verts: Q==U (redo no-op)=' +
    res.qEqU +
    '  Q==other=' +
    res.qOther +
    '  createdInStep(absent@U)=' +
    res.createdInStep
)
console.log('worst=' + res.worst.toFixed(5) + ' @v' + res.worstIdx)
console.log('samples:')
for (const d of res.diffs)
  console.log(
    '  v' +
      d.idx +
      ' d=' +
      d.d +
      ' P=' +
      JSON.stringify(d.p) +
      ' U=' +
      JSON.stringify(d.u) +
      ' Q=' +
      JSON.stringify(d.q)
  )

await browser.close()
