/* Per-render-vertex undo/redo corruption localizer.
 * load ts2.wproj -> CTX.replay() -> snapshot positions at cursor=top,
 * undo to base, redo to top, snapshot again, diff element-wise. A lossless
 * undo/redo round-trip should reproduce identical positions (deterministic
 * topology replay => same GPU batch order). */
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

// Snapshot every 'position' render-buffer concatenated in buffer order as a
// plain Float32Array (returned as a regular array for transfer).
const SNAP = `(() => {
  const g = globalThis
  const mesh = g._appstate?.ctx?.object?.data
  if (!mesh) return {error: 'no active mesh'}
  const wasm = mesh.wasm, spatial = mesh.spatial
  try { spatial.update?.(wasm.gpu) } catch (e) {}
  const buffersVec = wasm.gpu?.buffers
  const buffers = wasm.HEAPU8 !== undefined ? buffersVec : wasm.getBoundVector('', buffersVec)
  const out = []
  for (let i = 0; i < (buffers.length|0); i++) {
    const buf = buffers[i]
    if (!buf || buf.name !== 'position' || !(buf.size|0) || !(buf.elemsize|0)) continue
    const floatCount = (buf.size|0)*(buf.elemsize|0); const bytes = floatCount*4
    let u8
    if (wasm.HEAPU8 !== undefined) u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data, bytes)
    else u8 = wasm.pointerBytes?.(buf, 'data', bytes)
    if (!u8 || u8.length < bytes) continue
    const f = new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset+bytes))
    for (let j = 0; j < f.length; j++) out.push(f[j])
  }
  return {arr: out, mv: mesh.mesh?.v?.count ?? -1}
})()`

const snap = async () => await page.evaluate(SNAP)

// load + replay
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

// Suppress the rAF render loop: replay yields via setTimeout between steps, so a
// live frame can render the spatial tree mid-mutation -> a pre-existing
// render-vs-mutation OOB race unrelated to meshlog undo. We snapshot positions
// synchronously (one spatial.update + buffer read) instead.
await page.evaluate(() => {
  window.__rafReal = window.requestAnimationFrame
  window.requestAnimationFrame = () => 0
})

const len = await page.evaluate(async () => {
  const ctx = window._appstate.ctx
  await ctx.replay(() => true)
  return window._appstate.toolstack.length
})
console.log('replayed, toolstack len', len)

const a = await snap()
console.log('snap A (replayed, top):', a.arr?.length, 'floats, mv', a.mv)

// undo to base
await page.evaluate((n) => {
  const ts = window._appstate.toolstack
  for (let i = 0; i < n + 2; i++) {
    if (ts.cur < 0) break
    ts.undo()
  }
}, len)
const mid = await page.evaluate(() => window._appstate.toolstack.cur)
console.log('undone to cur', mid)

// redo to top
await page.evaluate((n) => {
  const ts = window._appstate.toolstack
  for (let i = 0; i < n + 2; i++) {
    if (ts.cur >= ts.length - 1) break
    ts.redo()
  }
}, len)
const top = await page.evaluate(() => window._appstate.toolstack.cur)
console.log('redone to cur', top)

const b = await snap()
console.log('snap B (redone, top):', b.arr?.length, 'floats, mv', b.mv)

// diff element-wise (vec3 stride)
if (a.arr && b.arr) {
  const n = Math.min(a.arr.length, b.arr.length)
  let worst = 0
  let worstIdx = -1
  let nDiff = 0
  let sumAbs = 0
  const hist = {}
  for (let j = 0; j < n; j += 3) {
    const dx = a.arr[j] - b.arr[j]
    const dy = a.arr[j + 1] - b.arr[j + 1]
    const dz = a.arr[j + 2] - b.arr[j + 2]
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d > 1e-6) {
      nDiff++
      sumAbs += d
      const bucket = Math.floor(Math.log10(d))
      hist[bucket] = (hist[bucket] || 0) + 1
    }
    if (d > worst) {
      worst = d
      worstIdx = j / 3
    }
  }
  console.log(`lengths A=${a.arr.length} B=${b.arr.length}`)
  console.log(
    `vec3 diffs >1e-6: ${nDiff} of ${n / 3}; sumAbs=${sumAbs.toFixed(4)}; worst=${worst.toFixed(5)} at rv#${worstIdx}`
  )
  console.log('log10(d) histogram:', JSON.stringify(hist))

  // Discriminate reordering vs corruption: compare SORTED multisets of vec3s.
  // If A and B are permutations of each other, sorted lists match -> mesh fine,
  // only GPU batch order differs. If they differ -> real corruption.
  const toVecs = (arr) => {
    const v = []
    for (let j = 0; j + 2 < arr.length; j += 3) v.push([arr[j], arr[j + 1], arr[j + 2]])
    v.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])
    return v
  }
  const va = toVecs(a.arr)
  const vb = toVecs(b.arr)
  let msMismatch = 0
  let msWorst = 0
  const m = Math.min(va.length, vb.length)
  for (let i = 0; i < m; i++) {
    const dx = va[i][0] - vb[i][0]
    const dy = va[i][1] - vb[i][1]
    const dz = va[i][2] - vb[i][2]
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d > 1e-5) msMismatch++
    if (d > msWorst) msWorst = d
  }
  console.log(`SORTED multiset: mismatches >1e-5: ${msMismatch} of ${m}; worst=${msWorst.toFixed(5)}`)
  console.log(msMismatch < 100 ? '  => REORDERING (mesh coords fine)' : '  => REAL CORRUPTION (multiset changed)')

  if (worstIdx >= 0) {
    const j = worstIdx * 3
    console.log(
      `  worst rv: A=[${a.arr[j].toFixed(4)},${a.arr[j + 1].toFixed(4)},${a.arr[j + 2].toFixed(4)}] B=[${b.arr[j].toFixed(4)},${b.arr[j + 1].toFixed(4)},${b.arr[j + 2].toFixed(4)}]`
    )
  }
}

await browser.close()
