/* eslint-disable no-console */
/* Determine whether undo or redo corrupts, per step.
 * Single replay pass: the replay stopCB fires after each step, so we grab
 * ground-truth G{cur} at every cursor. Then walk down with undo()/up with
 * redo(), comparing each restored state to its ground truth (sorted-multiset,
 * order-independent). The first half (undo or redo) whose state != ground
 * truth is the lossy one. */
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

await page.evaluate(() => {
  window.__snaps = {}
  window.__grabTo = (label) => {
    const g = globalThis
    const mesh = g._appstate?.ctx?.object?.data
    if (!mesh) {
      window.__snaps[label] = null
      return -1
    }
    const wasm = mesh.wasm
    const spatial = mesh.spatial
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
  window.__sortedOf = (label) => {
    const arr = window.__snaps[label]
    if (!arr) return null
    const m = (arr.length / 3) | 0
    const v = new Array(m)
    for (let i = 0; i < m; i++) v[i] = [arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]]
    v.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])
    window.__snaps['sorted_' + label] = v
    return m
  }
  window.__msdiff = (pa, pb) => {
    window.__sortedOf(pa)
    window.__sortedOf(pb)
    const va = window.__snaps['sorted_' + pa]
    const vb = window.__snaps['sorted_' + pb]
    if (!va || !vb) return {error: 'missing'}
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
    return {lenA: va.length, lenB: vb.length, m, ms, msw}
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

// Single replay; grab ground truth at each cursor in the stopCB.
const info = await page.evaluate(async () => {
  const ts = window._appstate.toolstack
  const grabbed = []
  await window._appstate.ctx.replay(() => {
    const n = window.__grabTo('G' + ts.cur)
    grabbed.push([ts.cur, n])
    return true
  })
  return {top: ts.cur, grabbed}
})
console.log('replayed; ground-truth grabs (cur,floats):', JSON.stringify(info.grabbed))
const top = info.top

// Walk down with undo(), comparing each to ground truth.
console.log('\n-- UNDO descent vs ground truth --')
const undoRes = []
for (let target = top - 1; target >= 0; target--) {
  const r = await page.evaluate((t) => {
    const ts = window._appstate.toolstack
    ts.undo()
    window.__grabTo('U' + ts.cur)
    return {cur: ts.cur, d: window.__msdiff('U' + ts.cur, 'G' + ts.cur)}
  }, target)
  undoRes.push(r)
  const tag = (r.d.ms ?? 0) > 50 ? '  <<< UNDO LOSSY' : ''
  console.log(
    `undo to cur=${r.cur}: ms=${r.d.ms} msw=${(r.d.msw || 0).toFixed(5)} (lenU=${r.d.lenA} lenG=${r.d.lenB})${tag}`
  )
}

// Walk back up with redo(), comparing each to ground truth.
console.log('\n-- REDO ascent vs ground truth --')
const redoRes = []
for (let target = 1; target <= top; target++) {
  const r = await page.evaluate(() => {
    const ts = window._appstate.toolstack
    ts.redo()
    window.__grabTo('R' + ts.cur)
    return {cur: ts.cur, d: window.__msdiff('R' + ts.cur, 'G' + ts.cur)}
  })
  redoRes.push(r)
  const tag = (r.d.ms ?? 0) > 50 ? '  <<< REDO LOSSY' : ''
  console.log(
    `redo to cur=${r.cur}: ms=${r.d.ms} msw=${(r.d.msw || 0).toFixed(5)} (lenR=${r.d.lenA} lenG=${r.d.lenB})${tag}`
  )
}

console.log('\nVERDICT:')
const firstUndoBad = undoRes.find((r) => (r.d.ms ?? 0) > 50)
const firstRedoBad = redoRes.find((r) => (r.d.ms ?? 0) > 50)
console.log('  first lossy UNDO at cur =', firstUndoBad ? firstUndoBad.cur : 'none')
console.log('  first lossy REDO at cur =', firstRedoBad ? firstRedoBad.cur : 'none')

await browser.close()
