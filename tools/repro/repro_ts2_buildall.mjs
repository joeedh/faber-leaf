/* Distinguish stale-GPU-buffer corruption from real mesh-data corruption.
 * Two grabs of the top step's single undo+redo round trip:
 *   - plain (incremental spatial.update, as the renderer sees it)
 *   - forced buildAll() before grab (GPU buffers rebuilt fresh from mesh)
 * If buildAll makes P==Q but plain doesn't, the bug is tree currency / GPU
 * regen flagging, not the undo/redo of mesh data. */
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
  window.__grabTo = (label, forceBuildAll) => {
    const mesh = globalThis._appstate?.ctx?.object?.data
    if (!mesh) {
      window.__snaps[label] = null
      return -1
    }
    const wasm = mesh.wasm
    const spatial = mesh.spatial
    try {
      if (forceBuildAll) spatial.buildAll?.()
    } catch (e) {
      console.log('buildAll err', String(e))
    }
    try {
      spatial.update?.(wasm.gpu)
    } catch (e) {
      console.log('spatial.update err', String(e))
    }
    const buffersVec = wasm.gpu?.buffers
    const buffers = wasm.HEAPU8 !== undefined ? buffersVec : wasm.getBoundVector('', buffersVec)
    const chunks = []
    let total = 0
    for (let i = 0; i < (buffers.length | 0); i++) {
      const buf = buffers[i]
      if (buf?.name !== 'position' || !(buf.size | 0) || !(buf.elemsize | 0)) continue
      const fc = (buf.size | 0) * (buf.elemsize | 0)
      const bytes = fc * 4
      let u8
      if (wasm.HEAPU8 !== undefined) u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data, bytes)
      else u8 = wasm.pointerBytes?.(buf, 'data', bytes)
      if (!u8 || u8.length < bytes) continue
      chunks.push(new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + bytes)))
      total += chunks[chunks.length - 1].length
    }
    const out = new Float32Array(total)
    let o = 0
    for (const c of chunks) {
      out.set(c, o)
      o += c.length
    }
    window.__snaps[label] = out
    return total
  }
  window.__msdiff = (pa, pb) => {
    const a = window.__snaps[pa]
    const b = window.__snaps[pb]
    if (!a || !b) return {error: 'missing'}
    const toVecs = (arr) => {
      const m = (arr.length / 3) | 0
      const v = new Array(m)
      for (let i = 0; i < m; i++) v[i] = [arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]]
      v.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])
      return v
    }
    const va = toVecs(a)
    const vb = toVecs(b)
    const m = Math.min(va.length, vb.length)
    let ms = 0
    let msw = 0
    for (let i = 0; i < m; i++) {
      const dx = va[i][0] - vb[i][0]
      const dy = va[i][1] - vb[i][1]
      const dz = va[i][2] - vb[i][2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d > 1e-5) ms++
      if (d > msw) msw = d
    }
    return {lenA: a.length, lenB: b.length, ms, msw}
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

// PLAIN round trip
const plain = await page.evaluate(() => {
  const ts = window._appstate.toolstack
  window.__grabTo('P', false)
  ts.undo()
  ts.redo()
  window.__grabTo('Q', false)
  return window.__msdiff('P', 'Q')
})
console.log('PLAIN  (incremental update):', JSON.stringify(plain))

// BUILDALL round trip (fresh state)
const ba = await page.evaluate(() => {
  const ts = window._appstate.toolstack
  window.__grabTo('P2', true)
  ts.undo()
  ts.redo()
  window.__grabTo('Q2', true)
  return window.__msdiff('P2', 'Q2')
})
console.log('BUILDALL (fresh from mesh):', JSON.stringify(ba))

console.log('\nVERDICT:')
if ((plain.ms ?? 0) > 50 && (ba.ms ?? 0) <= 50)
  console.log('  => STALE GPU BUFFERS: mesh data is correct; redo fails to flag leaves for GPU regen')
else if ((ba.ms ?? 0) > 50) console.log('  => REAL MESH CORRUPTION: undo/redo corrupts vertex data itself')
else console.log('  => clean both ways')

await browser.close()
