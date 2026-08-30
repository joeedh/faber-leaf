/* Repro the saved-toolstack undo bug:
 * load ts2.wproj (restores saved toolstack) -> CTX.replay() -> step undo/redo,
 * snapshotting order-independent vertex-position stats at each step. */
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
  const t = m.type()
  if (t === 'error') console.log(`[${t}]`, m.text())
})

await page.goto(`${BASE}/?renderer=webgpu`)
await page.waitForFunction(() => !!window._appstate?.screen, undefined, {timeout: 60000})

const POSSTATS = `(() => {
  const g = globalThis
  const mesh = g._appstate?.ctx?.object?.data
  if (!mesh) return {error: 'no active mesh'}
  const wasm = mesh.wasm, spatial = mesh.spatial
  try { spatial.update?.(wasm.gpu) } catch (e) {}
  const buffersVec = wasm.gpu?.buffers
  const buffers = wasm.HEAPU8 !== undefined ? buffersVec : wasm.getBoundVector('', buffersVec)
  let n = 0, nan = 0, big = 0
  let mn = [1e30,1e30,1e30], mx = [-1e30,-1e30,-1e30]
  let cx=0, cy=0, cz=0, sumsq=0
  for (let i = 0; i < (buffers.length|0); i++) {
    const buf = buffers[i]
    if (!buf || buf.name !== 'position' || !(buf.size|0) || !(buf.elemsize|0)) continue
    const floatCount = (buf.size|0)*(buf.elemsize|0); const bytes = floatCount*4
    let u8
    if (wasm.HEAPU8 !== undefined) u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data, bytes)
    else u8 = wasm.pointerBytes?.(buf, 'data', bytes)
    if (!u8 || u8.length < bytes) continue
    const f = new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset+bytes))
    for (let j = 0; j < f.length; j += 3) {
      const x=f[j], y=f[j+1], z=f[j+2]
      if (!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)) { nan++; continue }
      if (Math.abs(x)>100||Math.abs(y)>100||Math.abs(z)>100) big++
      n++; cx+=x; cy+=y; cz+=z; sumsq += x*x+y*y+z*z
      if (x<mn[0])mn[0]=x; if (y<mn[1])mn[1]=y; if (z<mn[2])mn[2]=z
      if (x>mx[0])mx[0]=x; if (y>mx[1])mx[1]=y; if (z>mx[2])mx[2]=z
    }
  }
  return {rv:n, nan, big, min:mn.map(v=>+v.toFixed(3)), max:mx.map(v=>+v.toFixed(3)),
          c:[cx/(n||1),cy/(n||1),cz/(n||1)].map(v=>+v.toFixed(4)),
          sumsq:+sumsq.toFixed(1), mv: mesh.mesh?.v?.count ?? '?'}
})()`

const stat = async (label) => {
  const s = await page.evaluate(POSSTATS)
  console.log(label.padEnd(16), JSON.stringify(s))
  return s
}

// load with saved toolstack restored
const ts = await page.evaluate(async (url) => {
  const buf = await fetch(url).then((r) => r.arrayBuffer())
  await window._appstate.loadFileAsync(buf, {
    load_library   : true,
    load_screen    : false,
    load_settings  : false,
    reset_toolstack: true,
    reset_context  : true,
  })
  const ts2 = window._appstate.toolstack
  const ops = []
  for (let i = 0; i < ts2.length; i++) ops.push(ts2[i]?.constructor?.name ?? '?')
  return {len: ts2.length, cur: ts2.cur, ops}
}, WPROJ)
console.log('toolstack:', JSON.stringify(ts))

await stat('LOADED')

// replay the whole stack
const rep = await page.evaluate(async () => {
  const ctx = window._appstate.ctx
  const t0 = performance.now()
  await ctx.replay(() => true)
  return {ms: Math.round(performance.now() - t0), cur: window._appstate.toolstack.cur}
})
console.log('replay:', JSON.stringify(rep))
await stat('REPLAYED')

// step undo to the bottom, snapshotting
const len = ts.len
for (let i = 0; i < len; i++) {
  const info = await page.evaluate(() => {
    const app = window._appstate
    const ts2 = app.toolstack
    if (ts2.cur < 0) return {cur: ts2.cur, op: null, done: true}
    const op = ts2[ts2.cur]?.constructor?.name
    app.toolstack.undo()
    return {cur: ts2.cur, op}
  })
  if (info.done) {
    console.log('  (no more to undo)')
    break
  }
  const s = await stat(`UNDO->${info.cur} (${info.op})`)
  if (s.nan || s.big) {
    console.log('  *** CORRUPTION DETECTED ***')
  }
}

// step redo back up
for (let i = 0; i < len; i++) {
  const info = await page.evaluate(() => {
    const app = window._appstate
    const ts2 = app.toolstack
    if (ts2.cur >= ts2.length - 1) return {done: true}
    app.toolstack.redo()
    return {cur: ts2.cur, op: ts2[ts2.cur]?.constructor?.name}
  })
  if (info.done) {
    console.log('  (no more to redo)')
    break
  }
  const s = await stat(`REDO->${info.cur} (${info.op})`)
  if (s.nan || s.big) {
    console.log('  *** CORRUPTION DETECTED ***')
  }
}

await browser.close()
