/* Standalone repro: load `dyntopo test.wproj`, capture the loaded mesh state,
 * run ViewContext.replay (reload serialized base + re-exec toolops), and diff.
 * Replay is how "undo after a dyntopo stroke" actually works for a loaded file.
 * Run: node tools/repro_replay_dyntopo.mjs   (needs the 5099 dev server up). */
import {chromium} from '@playwright/test'

const PORT = process.env.E2E_PORT ?? 5099
const BASE = `http://localhost:${PORT}`
const WPROJ = '/examples/dyntopo%20test.wproj'

const browser = await chromium.launch({
  channel: 'chromium',
  args   : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=default', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  const t = m.type()
  if (t === 'error' || t === 'warning') console.log(`[page.${t}]`, m.text())
})

await page.goto(`${BASE}/?renderer=webgpu`)
await page.waitForFunction(() => !!window._appstate?.screen, undefined, {timeout: 60000})
console.log('app booted; navigator.gpu =', await page.evaluate(() => !!navigator.gpu))

// Inline position-buffer stats reader (order-independent corruption signals).
const posStats = () => {
  const g = globalThis
  const mesh = g._appstate?.ctx?.object?.data
  if (!mesh) return {error: 'no active mesh'}
  const wasm = mesh.wasm
  const spatial = mesh.spatial
  try {
    spatial.update?.(wasm.gpu)
  } catch (e) {}
  const buffersVec = wasm.gpu?.buffers
  const buffers = wasm.HEAPU8 !== undefined ? buffersVec : wasm.getBoundVector('', buffersVec)
  let n = 0
  let nan = 0
  let mn = [1e30, 1e30, 1e30]
  let mx = [-1e30, -1e30, -1e30]
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < (buffers.length | 0); i++) {
    const buf = buffers[i]
    if (buf?.name !== 'position' || !(buf.size | 0) || !(buf.elemsize | 0)) continue
    const floatCount = (buf.size | 0) * (buf.elemsize | 0)
    const bytes = floatCount * 4
    let u8
    if (wasm.HEAPU8 !== undefined) u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data, bytes)
    else u8 = wasm.pointerBytes?.(buf, 'data', bytes)
    if (!u8 || u8.length < bytes) continue
    const f = new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + bytes))
    for (let j = 0; j < f.length; j += 3) {
      const x = f[j]
      const y = f[j + 1]
      const z = f[j + 2]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        nan++
        continue
      }
      n++
      cx += x
      cy += y
      cz += z
      if (x < mn[0]) mn[0] = x
      if (y < mn[1]) mn[1] = y
      if (z < mn[2]) mn[2] = z
      if (x > mx[0]) mx[0] = x
      if (y > mx[1]) mx[1] = y
      if (z > mx[2]) mx[2] = z
    }
  }
  return {
    renderVerts: n,
    nan,
    bboxMin  : mn.map((v) => +v.toFixed(4)),
    bboxMax  : mx.map((v) => +v.toFixed(4)),
    centroid : [cx / (n || 1), cy / (n || 1), cz / (n || 1)].map((v) => +v.toFixed(4)),
    meshVerts: mesh.mesh?.v?.count ?? '?',
  }
}

const counts = await page.evaluate(async (url) => {
  const appstate = window._appstate
  const buf = await fetch(url).then((r) => r.arrayBuffer())
  await appstate.loadFileAsync(buf, {
    load_library   : true,
    load_screen    : false,
    load_settings  : false,
    reset_toolstack: true, // true = restore the file's saved toolstack (replay ops)
    reset_context  : true,
  })
  const ts = appstate.toolstack
  const ops = []
  for (let i = 0; i < ts.length; i++) ops.push(ts[i]?.constructor?.name ?? '?')
  return {toolstackLen: ts.length, cur: ts.cur, ops}
}, WPROJ)
console.log('toolstack:', JSON.stringify(counts, null, 1))

const loaded = await page.evaluate(posStats)
console.log('LOADED  state:', JSON.stringify(loaded))

// Run the real undo mechanism: full replay (reload serialized base + re-exec).
const replayInfo = await page.evaluate(async () => {
  const ctx = window._appstate.ctx
  const t0 = performance.now()
  await ctx.replay(() => true)
  return {ms: Math.round(performance.now() - t0)}
})
console.log('replay done in', replayInfo.ms, 'ms')

const replayed = await page.evaluate(posStats)
console.log('REPLAYED state:', JSON.stringify(replayed))

if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'))
await browser.close()
console.log('done')
