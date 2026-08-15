/* Measure mesh-co drift across repeated undo+redo cycles. Replay to top,
 * snapshot index-aligned mesh co (M0). Then repeat {undo; redo} N times,
 * snapshotting after each, and report max |co - M0| per cycle. If it grows,
 * undo/redo loses a little each round trip => accumulating visible corruption. */
import {chromium} from '@playwright/test'

const PORT = process.env.E2E_PORT ?? 5099
const BASE = `http://localhost:${PORT}`
const WPROJ = '/examples/ts2.wproj'
const CYCLES = +(process.env.CYCLES ?? 8)

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
    const mesh = globalThis._appstate?.ctx?.object?.data,
      wasm = mesh.wasm
    const cls = wasm.manager.findVectorClass('float')
    const vec = wasm.manager.constructWith(cls.findDefaultConstructor())
    mesh.mesh.dumpVertCo(vec)
    const arr = wasm.getBoundVector(cls.buildFullName(), vec)
    const m = new Map()
    for (let i = 0; i + 3 < arr.length; i += 4) m.set(arr[i] | 0, [arr[i + 1], arr[i + 2], arr[i + 3]])
    return m
  }
  window.__M0 = null
  window.__snapM0 = () => {
    window.__M0 = window.__co()
  }
  window.__driftVsM0 = () => {
    const a = window.__M0,
      b = window.__co()
    let diff = 0,
      worst = 0,
      worstIdx = -1,
      onlyA = 0,
      onlyB = 0
    for (const [idx, ca] of a) {
      const cb = b.get(idx)
      if (!cb) {
        onlyA++
        continue
      }
      const d = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2])
      if (d > 1e-6) {
        diff++
        if (d > worst) {
          worst = d
          worstIdx = idx
        }
      }
    }
    for (const [idx] of b) if (!a.has(idx)) onlyB++
    return {sizeA: a.size, sizeB: b.size, diff, worst, worstIdx, onlyA, onlyB}
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
  window.__rafReal = window.requestAnimationFrame
  window.requestAnimationFrame = () => 0
})

const len = await page.evaluate(async () => {
  await window._appstate.ctx.replay(() => true)
  return window._appstate.toolstack.length
})
console.log('replayed, len', len)
await page.evaluate(() => window.__snapM0())

for (let i = 1; i <= CYCLES; i++) {
  const r = await page.evaluate(() => {
    const ts = window._appstate.toolstack
    ts.undo()
    ts.redo()
    return window.__driftVsM0()
  })
  console.log(
    `cycle ${i}: diff=${r.diff} worst=${r.worst.toFixed(5)} @v${r.worstIdx} onlyA=${r.onlyA} onlyB=${r.onlyB} (sizeA=${r.sizeA} sizeB=${r.sizeB})`
  )
}

await browser.close()
