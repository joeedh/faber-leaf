/* Per-step undo/redo corruption localizer.
 * load ts2.wproj -> replay to top -> for each cursor level, do a single
 * undo()+redo() round trip and check if 'position' buffers return identical.
 * The first level whose round trip is lossy pinpoints the buggy step.
 * Snapshots are kept in-page; only compact summaries cross to node. */
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
  if (t === 'error' || t === 'warning') console.log(`[${t}]`, m.text())
})

await page.goto(`${BASE}/?renderer=webgpu`)
await page.waitForFunction(() => !!window._appstate?.screen, undefined, {timeout: 60000})

// Install in-page helpers: snapshot positions into a Float32Array, and a
// multiset-diff between two stored snapshots.
await page.evaluate(() => {
  window.__snaps = {}
  window.__grab = () => {
    const g = globalThis
    const mesh = g._appstate?.ctx?.object?.data
    if (!mesh) return null
    const wasm = mesh.wasm
    const spatial = mesh.spatial
    try {
      spatial.update?.(wasm.gpu)
    } catch (e) {}
    const buffersVec = wasm.gpu?.buffers
    const buffers = wasm.HEAPU8 !== undefined ? buffersVec : wasm.getBoundVector('', buffersVec)
    const chunks = []
    let total = 0
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
      chunks.push(f)
      total += f.length
    }
    const out = new Float32Array(total)
    let o = 0
    for (const c of chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  }
  // element-wise + sorted-multiset diff
  window.__diff = (pa, pb) => {
    const a = window.__snaps[pa]
    const b = window.__snaps[pb]
    if (!a || !b) return {error: 'missing snap'}
    const n = Math.min(a.length, b.length)
    let nDiff = 0
    let worst = 0
    for (let j = 0; j < n; j += 3) {
      const dx = a[j] - b[j]
      const dy = a[j + 1] - b[j + 1]
      const dz = a[j + 2] - b[j + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d > 1e-6) nDiff++
      if (d > worst) worst = d
    }
    // sorted multiset
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
    return {lenA: a.length, lenB: b.length, nDiff, worst, ms, msw}
  }
})

// load + suppress rAF
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
console.log('replayed, toolstack len', len)

// Per-step single round-trip localizer. Walk from top down; at each level
// snapshot P, undo+redo, snapshot Q, diff, then descend one.
let cur = await page.evaluate(() => window._appstate.toolstack.cur)
console.log('top cur', cur)

const results = []
while (cur >= 1) {
  const r = await page.evaluate((c) => {
    const ts = window._appstate.toolstack
    window.__snaps.P = window.__grab()
    ts.undo()
    const afterUndo = ts.cur
    ts.redo()
    const afterRedo = ts.cur
    window.__snaps.Q = window.__grab()
    const d = window.__diff('P', 'Q')
    // descend for next iteration
    ts.undo()
    return {c, afterUndo, afterRedo, descend: ts.cur, d}
  }, cur)
  results.push(r)
  const d = r.d
  const tag = (d.ms ?? 0) > 50 ? '  <<< LOSSY' : ''
  console.log(
    `step cur=${r.c}: undo->${r.afterUndo} redo->${r.afterRedo} | nDiff=${d.nDiff} worst=${(d.worst || 0).toFixed(5)} ms=${d.ms} msw=${(d.msw || 0).toFixed(5)}${tag}`
  )
  cur = r.descend
}

const lossy = results.filter((r) => (r.d.ms ?? 0) > 50).map((r) => r.c)
console.log('\nLOSSY STEPS (single round-trip):', JSON.stringify(lossy))

await browser.close()
