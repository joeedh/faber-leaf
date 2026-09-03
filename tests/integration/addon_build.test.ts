/**
 * End-to-end test for tools/build-addons.js. Step 5 of the refactor
 * (plan §7.2 Layer D).
 *
 * Approach:
 *   1. Run the build script against the test fixture in tests/fixtures/addons/,
 *      into a private --out-dir (never the shared build/addons the app loads).
 *   2. Verify the expected output files exist + the index.json shape.
 *   3. Dynamic-import the built module and exercise register/unregister with
 *      a mock AddonAPI to confirm the addon's exportNamespace landed.
 *
 * This test deliberately avoids pulling in the full app code (no pathux, no
 * mesh, no scripts/core). It only consumes the build artifact + a hand-rolled
 * mock API, so it runs in the standard jest+jsdom environment without
 * extra config.
 */

import {execSync} from 'node:child_process'
import fs from 'node:fs'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isDefaultBackendPass} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '../..')
// A private output directory, not the shared `build/addons`: this suite wipes
// its output before building, and every other suite that boots the app reads
// `build/addons/index.json` while it does.
const OUT_DIR_REL = 'build/addons-buildtest'
const OUT_DIR = Path.join(REPO_ROOT, 'build', 'addons-buildtest')
const TEST_ADDON_BUILT_ENTRY = Path.join(OUT_DIR, 'test_addon', 'src', 'main.js')
const INDEX_PATH = Path.join(OUT_DIR, 'index.json')

// No NW.js boot, so no backend: runs once, in the wasm pass (see ./split).
const describeOnce = isDefaultBackendPass() ? describe : describe.skip

describeOnce('tools/build-addons.js', () => {
  beforeAll(() => {
    // Clean output then build the fixture addon. Slow-ish (~few seconds for
    // esbuild's first invocation) but acceptable for a CI smoke test.
    fs.rmSync(OUT_DIR, {recursive: true, force: true})
    execSync(`node tools/build-addons.js --include-fixtures --out-dir ${OUT_DIR_REL}`, {
      cwd  : REPO_ROOT,
      stdio: 'pipe',
    })
  }, 30000)

  afterAll(() => {
    fs.rmSync(OUT_DIR, {recursive: true, force: true})
  })

  test('emits the built addon entry', () => {
    expect(fs.existsSync(TEST_ADDON_BUILT_ENTRY)).toBe(true)
  })

  test('emits a valid index.json describing the fixture', () => {
    const json = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'))
    expect(Array.isArray(json)).toBe(true)
    const entry = json.find((e: {manifest: {id: string}}) => e.manifest.id === 'test_addon')
    expect(entry).toBeDefined()
    expect(entry.manifest.entry).toBe('src/main.ts')
    expect(entry.builtin).toBe(false)
    expect(entry.kind).toBe('fixture')
  })

  test('built addon imports and registers correctly', async () => {
    // Dynamic-import the built file via file:// URL (Jest+ESM supports this).
    const fileUrl = 'file://' + TEST_ADDON_BUILT_ENTRY
    const mod = (await import(fileUrl)) as {
      addonDefine: {name: string}
      register: (api: {exportNamespace?: (n: string, e: unknown) => void; addonId?: string}) => void
      unregister: () => void
      seen: string[]
    }

    expect(mod.addonDefine.name).toBe('Test Addon')
    expect(mod.seen).toEqual([])

    let exported: Record<string, unknown> | undefined
    const api = {
      addonId        : 'test_addon',
      exportNamespace: (name: string, exports: unknown) => {
        if (name === 'test_addon') exported = exports as Record<string, unknown>
      },
    }

    mod.register(api)
    expect(mod.seen).toEqual(['register'])
    expect(exported).toBeDefined()
    expect((exported as {greet: (n: string) => string}).greet('world')).toBe('hello world')

    mod.unregister()
    expect(mod.seen).toEqual(['register', 'unregister'])
  })
})
