import {defineConfig, devices} from '@playwright/test'

/**
 * Playwright e2e config for Faber Leaf.
 *
 * These tests boot the *real* app in a GPU-backed Chromium (the realtime
 * renderer is WebGPU-only), load a `.wproj` project file through
 * `window._appstate.loadFileAsync`, and screenshot the rendered result.
 *
 * - Specs live in `tests/e2e/` with a `.e2e.ts` suffix so Jest's
 *   `*.test.ts` glob never collects them (and vice-versa).
 * - The dev server (`tools/serv.js`) is started automatically on a
 *   dedicated test port (5099) — separate from the dev port (5007) — so
 *   running e2e tests never collides with a hand-started `pnpm serv`.
 *   `pnpm build` runs first because `index.html` dynamically imports
 *   `build/entry_point.js`, which must exist before the page can boot.
 * - `reuseExistingServer: false` makes Playwright always start/stop the
 *   server itself (and restart it each run).
 */

const PORT = Number(process.env.E2E_PORT ?? 5099)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir  : './tests/e2e',
  testMatch: '**/*.e2e.ts',

  // WASM load + WebGPU init + first render can be slow.
  timeout: 120_000,
  expect : {timeout: 30_000},

  fullyParallel: false,
  workers      : 1,

  reporter: [['list'], ['html', {open: 'never'}]],

  use: {
    baseURL: BASE_URL,
    trace  : 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        channel      : 'chromium',
        // WebGPU needs a real adapter; gpucontext.ts throws without one.
        // New-headless Chromium can use the GPU with these flags. If the
        // GPU isn't exposed headless on this machine, set headless:false.
        launchOptions: {
          args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=default', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],

  webServer: {
    command            : `pnpm build && node tools/serv.js ${PORT}`,
    url                : `${BASE_URL}/`,
    reuseExistingServer: false,
    timeout            : 180_000,
    stdout             : 'pipe',
    stderr             : 'pipe',
  },
})
