/* eslint-disable no-console */
/* Probe: load ts2.wproj and render WITHOUT replay, then optionally replay.
 * Distinguishes a pre-existing load/render crash from a replay-path crash. */
import {chromium} from '@playwright/test'

const PORT = process.env.E2E_PORT ?? 5099
const BASE = `http://localhost:${PORT}`
const WPROJ = '/examples/ts2.wproj'
const DO_REPLAY = process.env.DO_REPLAY === '1'

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
console.log('loaded')

// Let it render a few frames.
await page.waitForTimeout(2000)
const mv0 = await page.evaluate(() => window._appstate?.ctx?.object?.data?.mesh?.v?.count ?? -1)
console.log('after load+render: mesh.v.count =', mv0)

if (DO_REPLAY) {
  const len = await page.evaluate(async () => {
    const ctx = window._appstate.ctx
    await ctx.replay(() => true)
    return window._appstate.toolstack.length
  })
  console.log('replayed, toolstack len', len)
  await page.waitForTimeout(1500)
  const mv1 = await page.evaluate(() => window._appstate?.ctx?.object?.data?.mesh?.v?.count ?? -1)
  console.log('after replay+render: mesh.v.count =', mv1)
}

await browser.close()
console.log('DONE OK')
