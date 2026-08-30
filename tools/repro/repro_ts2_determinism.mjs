/* Is dyntopo replay deterministic? Load+replay twice (fresh page state each
 * time via reload) and compare index-aligned mesh co. If they differ, replay
 * itself is non-deterministic, which explains why a re-recorded meshlog can't
 * match the post-replay mesh exactly. */
import {chromium} from '@playwright/test'

const PORT = process.env.E2E_PORT ?? 5099
const BASE = `http://localhost:${PORT}`
const WPROJ = '/examples/ts2.wproj'

const browser = await chromium.launch({
  channel: 'chromium',
  args   : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=default', '--ignore-gpu-blocklist'],
})

async function replayAndGrab() {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)))
  await page.goto(`${BASE}/?renderer=webgpu`)
  await page.waitForFunction(() => !!window._appstate?.screen, undefined, {timeout: 60000})
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
  await page.evaluate(async () => {
    await window._appstate.ctx.replay(() => true)
  })
  const co = await page.evaluate(() => {
    const mesh = globalThis._appstate?.ctx?.object?.data
    const wasm = mesh.wasm
    const cls = wasm.manager.findVectorClass('float')
    const vec = wasm.manager.constructWith(cls.findDefaultConstructor())
    mesh.mesh.dumpVertCo(vec)
    const arr = wasm.getBoundVector(cls.buildFullName(), vec)
    const out = []
    for (let i = 0; i + 3 < arr.length; i += 4) out.push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3])
    return out
  })
  await page.close()
  return co
}

const a = await replayAndGrab()
const b = await replayAndGrab()
console.log('replay1 floats', a.length, 'replay2 floats', b.length)

const ma = new Map()
const mb = new Map()
for (let i = 0; i + 3 < a.length; i += 4) ma.set(a[i] | 0, [a[i + 1], a[i + 2], a[i + 3]])
for (let i = 0; i + 3 < b.length; i += 4) mb.set(b[i] | 0, [b[i + 1], b[i + 2], b[i + 3]])
let diff = 0
let worst = 0
let worstIdx = -1
let onlyA = 0
let onlyB = 0
for (const [idx, ca] of ma) {
  const cb = mb.get(idx)
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
for (const [idx] of mb) if (!ma.has(idx)) onlyB++
console.log(
  `replay1 vs replay2: sizeA=${ma.size} sizeB=${mb.size} diff=${diff} worst=${worst.toFixed(5)} @v${worstIdx} onlyA=${onlyA} onlyB=${onlyB}`
)
console.log(diff === 0 && onlyA === 0 && onlyB === 0 ? '  => DETERMINISTIC' : '  => NON-DETERMINISTIC replay')

await browser.close()
