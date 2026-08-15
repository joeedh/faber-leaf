/* Compare the GPU 'position' buffer multiset against the mesh.dumpVertCo
 * multiset IN THE SAME STATE. This removes the P-vs-Q confound: it tells us
 * directly whether the GPU buffers are consistent with the mesh at a given
 * moment. Done at: (1) after replay (top), (2) after one undo+redo round trip. */
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
  // GPU position buffer -> sorted vec3 multiset
  window.__gpuVecs = () => {
    const mesh = globalThis._appstate?.ctx?.object?.data
    const wasm = mesh.wasm,
      spatial = mesh.spatial
    let updErr = null
    try {
      spatial.update?.(wasm.gpu)
    } catch (e) {
      updErr = String(e)
    }
    const buffersVec = wasm.gpu?.buffers
    const buffers = wasm.HEAPU8 !== undefined ? buffersVec : wasm.getBoundVector('', buffersVec)
    const v = []
    for (let i = 0; i < (buffers.length | 0); i++) {
      const buf = buffers[i]
      if (!buf || buf.name !== 'position' || !(buf.size | 0) || !(buf.elemsize | 0)) continue
      const fc = (buf.size | 0) * (buf.elemsize | 0),
        bytes = fc * 4
      let u8
      if (wasm.HEAPU8 !== undefined) u8 = new Uint8Array(wasm.HEAPU8.buffer, buf.data, bytes)
      else u8 = wasm.pointerBytes?.(buf, 'data', bytes)
      if (!u8 || u8.length < bytes) continue
      const f = new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + bytes))
      for (let j = 0; j + 2 < f.length; j += 3) v.push([f[j], f[j + 1], f[j + 2]])
    }
    v.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])
    return {v, updErr}
  }
  // mesh.dumpVertCo -> sorted vec3 multiset
  window.__meshVecs = () => {
    const mesh = globalThis._appstate?.ctx?.object?.data
    const wasm = mesh.wasm
    const cls = wasm.manager.findVectorClass('float')
    const vec = wasm.manager.constructWith(cls.findDefaultConstructor())
    mesh.mesh.dumpVertCo(vec)
    const arr = wasm.getBoundVector(cls.buildFullName(), vec)
    const v = []
    for (let i = 0; i + 3 < arr.length; i += 4) v.push([arr[i + 1], arr[i + 2], arr[i + 3]])
    v.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])
    return v
  }
  // For each GPU vec, is it present (within eps) in the mesh multiset? Count misses.
  window.__gpuConsistency = () => {
    const g = window.__gpuVecs(),
      gpu = g.v,
      mesh = window.__meshVecs()
    // build a quantized set of mesh coords for membership test
    const Q = 1e4
    const key = (p) => `${Math.round(p[0] * Q)},${Math.round(p[1] * Q)},${Math.round(p[2] * Q)}`
    const set = new Set()
    for (const p of mesh) set.add(key(p))
    let miss = 0
    const sample = []
    for (const p of gpu) {
      if (!set.has(key(p))) {
        miss++
        if (sample.length < 4) sample.push(p.map((x) => +x.toFixed(4)))
      }
    }
    return {gpuCount: gpu.length, meshCount: mesh.length, miss, sample, updErr: g.updErr}
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

const top = await page.evaluate(() => window.__gpuConsistency())
console.log('AT TOP (after replay): GPU vs mesh =>', JSON.stringify(top))

const rt = await page.evaluate(() => {
  const ts = window._appstate.toolstack
  ts.undo()
  ts.redo()
  return window.__gpuConsistency()
})
console.log('AFTER undo+redo:       GPU vs mesh =>', JSON.stringify(rt))

console.log('\nVERDICT:')
console.log('  TOP miss =', top.miss, '| ROUNDTRIP miss =', rt.miss)
if (rt.miss > top.miss + 100) console.log('  => undo/redo INTRODUCES stale GPU verts not in mesh')
else if (top.miss > 100) console.log('  => GPU already inconsistent with mesh AT TOP (replay/update gap)')
else console.log('  => GPU stays consistent with mesh')

await browser.close()
