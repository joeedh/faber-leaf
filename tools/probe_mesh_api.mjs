/* Probe the in-page LiteMesh/sculptcore mesh object to find an accessor for
 * raw vertex co (mesh truth, independent of GPU buffers). */
import {chromium} from '@playwright/test'
const PORT = process.env.E2E_PORT ?? 5099
const BASE = `http://localhost:${PORT}`
const browser = await chromium.launch({
  channel: 'chromium',
  args   : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=default', '--ignore-gpu-blocklist'],
})
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
}, '/examples/ts2.wproj')

const info = await page.evaluate(() => {
  const mesh = globalThis._appstate?.ctx?.object?.data
  const out = {}
  out.dataKeys = Object.keys(mesh)
  out.hasMeshHandle = !!mesh.mesh
  try {
    const m = mesh.mesh
    out.meshType = m?.constructor?.name
    out.meshProps = m ? Object.keys(m).slice(0, 40) : null
    // try m.v
    const v = m?.v
    out.vType = v?.constructor?.name
    out.vKeys = v ? Object.keys(v).slice(0, 40) : null
    out.vCount = v?.count ?? v?.length ?? null
    // try co
    const co = v?.co
    out.coType = co?.constructor?.name
    out.coKeys = co ? Object.keys(co).slice(0, 30) : null
    out.coLen = co?.length ?? null
    // sample
    if (co && typeof co.get === 'function') {
      out.coGet0 = co.get(0)
    } else if (co && co[0] !== undefined) {
      out.coIdx0 = co[0]
    }
  } catch (e) {
    out.err = String(e)
  }
  return out
})
console.log(JSON.stringify(info, null, 2))
await browser.close()
