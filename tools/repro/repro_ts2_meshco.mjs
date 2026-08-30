/* Read mesh-truth vert co (mesh.mesh.dumpVertCo) across a single undo+redo
 * round trip of the top step. Index-aligned compare => definitively shows
 * whether the MESH vertex data is corrupted (vs stale GPU leaf buffers). */
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
  window.__snaps = {}
  // returns Map idx -> [x,y,z]; also stores raw
  window.__grabCo = (label) => {
    const mesh = globalThis._appstate?.ctx?.object?.data
    if (!mesh) return -1
    const wasm = mesh.wasm
    const cls = wasm.manager.findVectorClass('float')
    const ctor = cls.findDefaultConstructor()
    const vec = wasm.manager.constructWith(ctor)
    mesh.mesh.dumpVertCo(vec)
    const arr = wasm.getBoundVector(cls.buildFullName(), vec)
    const m = new Map()
    for (let i = 0; i + 3 < arr.length; i += 4) m.set(arr[i] | 0, [arr[i + 1], arr[i + 2], arr[i + 3]])
    window.__snaps[label] = m
    return m.size
  }
  window.__diffCo = (pa, pb) => {
    const a = window.__snaps[pa]
    const b = window.__snaps[pb]
    if (!a || !b) return {error: 'missing'}
    let onlyA = 0
    let onlyB = 0
    let diff = 0
    let worst = 0
    let worstIdx = -1
    let same = 0
    for (const [idx, ca] of a) {
      const cb = b.get(idx)
      if (!cb) {
        onlyA++
        continue
      }
      const dx = ca[0] - cb[0]
      const dy = ca[1] - cb[1]
      const dz = ca[2] - cb[2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d > 1e-6) {
        diff++
        if (d > worst) {
          worst = d
          worstIdx = idx
        }
      } else same++
    }
    for (const [idx] of b) if (!a.has(idx)) onlyB++
    return {sizeA: a.size, sizeB: b.size, onlyA, onlyB, diff, same, worst, worstIdx}
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

const res = await page.evaluate(() => {
  const ts = window._appstate.toolstack
  const nP = window.__grabCo('P')
  ts.undo()
  const nU = window.__grabCo('U')
  ts.redo()
  const nQ = window.__grabCo('Q')
  return {nP, nU, nQ, PvQ: window.__diffCo('P', 'Q'), PvU: window.__diffCo('P', 'U')}
})
console.log('mesh vert counts: P(top)=' + res.nP + ' U(undone)=' + res.nU + ' Q(redone)=' + res.nQ)
console.log('P vs U (one undo):     ', JSON.stringify(res.PvU))
console.log('P vs Q (undo+redo):    ', JSON.stringify(res.PvQ))

console.log('\nVERDICT:')
const d = res.PvQ
if ((d.diff ?? 0) > 50 || (d.onlyA ?? 0) > 0 || (d.onlyB ?? 0) > 0)
  console.log(
    '  => REAL MESH-DATA CORRUPTION: vertex co differs after undo+redo (diff=' +
      d.diff +
      ', onlyA=' +
      d.onlyA +
      ', onlyB=' +
      d.onlyB +
      ', worst=' +
      (d.worst || 0).toFixed(5) +
      ' @v' +
      d.worstIdx +
      ')'
  )
else console.log('  => mesh co IDENTICAL after undo+redo => corruption is STALE GPU BUFFERS, not mesh data')

await browser.close()
