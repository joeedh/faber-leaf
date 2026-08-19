/**
 * @jest-environment node
 *
 * Verifies that a builtin addon builds as a real per-addon artifact via
 * tools/build-addons.js — the same path a third-party addon takes, and the only
 * test that exercises it. It was written against `tetmesh`; P13 deleted the TS
 * BREP and with it that addon, so it now watches `leafmesh`, which is the
 * better subject anyway: `"dependencies": []`, `buildMode: "prebuilt"`, and no
 * host import at all, so its bundle is what a third party's would look like.
 *
 * What this test does NOT do (would need the full browser pathux runtime):
 *   - Actually instantiate LeafMeshToolMode and exercise its keymap.
 *   - Load the bundle in a real browser context.
 *
 * What it DOES do:
 *   1. Asserts `build/addons/leafmesh/src/main.js` exists and registers
 *      LeafMeshToolMode via the addon-api `register(api)` hook.
 *   2. Asserts the in-bundle registration sites stay gone: the per-addon
 *      `addon_register.ts` files were deleted, and the view3d tools index does
 *      not reach for the toolmode.
 *   3. Asserts the addon index lists leafmesh as a prebuilt builtin with no
 *      dependencies, so the loader has nothing to topo-sort it after.
 */

import {execSync} from 'node:child_process'
import fs from 'node:fs'
import Path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isDefaultBackendPass} from './split'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = Path.resolve(Path.dirname(__filename), '..', '..')
const LEAFMESH_BUNDLE = Path.join(REPO_ROOT, 'build/addons/leafmesh/src/main.js')
const TOOLS_TS = Path.join(REPO_ROOT, 'scripts/editors/view3d/tools/tools.ts')
const OLD_ADDON_REGISTER_TS = Path.join(REPO_ROOT, 'scripts/editors/view3d/tools/addon_register.ts')
const INDEX_JSON = Path.join(REPO_ROOT, 'build/addons/index.json')

// No NW.js boot, so no backend: runs once, in the wasm pass (see ./split).
const describeOnce = isDefaultBackendPass() ? describe : describe.skip

describeOnce('leafmesh as a real per-addon bundle', () => {
  beforeAll(() => {
    if (!fs.existsSync(LEAFMESH_BUNDLE)) {
      execSync('node tools/build-addons.js --include-fixtures', {
        cwd  : REPO_ROOT,
        stdio: 'pipe',
      })
    }
  }, 60000)

  test('leafmesh bundle exists and registers LeafMeshToolMode via the addon-api hook', () => {
    expect(fs.existsSync(LEAFMESH_BUNDLE)).toBe(true)
    const built = fs.readFileSync(LEAFMESH_BUNDLE, 'utf-8')
    // The class is inlined because toolmode.ts is the addon's local source.
    expect(built).toContain('LeafMeshToolMode')
    // Registration goes through `api.registerAll(...)` in the addon's
    // `register(api)` hook (no module-scope ToolMode.register side effect).
    expect(built).toMatch(/registerAll\s*\([^)]*LeafMeshToolMode/)
  })

  test('the in-bundle registration sites are gone', () => {
    // The per-addon addon_register.ts side-effect files were deleted by the
    // unified-registrator refactor (registration now lives in each addon's
    // main.ts register() hook, reached through the distribution manifest).
    expect(fs.existsSync(OLD_ADDON_REGISTER_TS)).toBe(false)
    // The view3d tools index never names the leafmesh toolmode: an
    // out-of-bundle addon is not importable from the host bundle, and success
    // criterion 12 is that adding LeafMesh needs no `scripts/` edit.
    const tools = fs.readFileSync(TOOLS_TS, 'utf-8')
    expect(tools).not.toMatch(/\bLeafMesh/)
  })

  test('index.json lists leafmesh as a prebuilt builtin with no dependencies', () => {
    const index = JSON.parse(fs.readFileSync(INDEX_JSON, 'utf-8'))
    const leaf = index.find((e: {manifest: {id: string}}) => e.manifest.id === 'leafmesh')
    expect(leaf).toBeDefined()
    expect(leaf.manifest.dependencies).toEqual([])
    expect(leaf.manifest.buildMode).toBe('prebuilt')
    expect(leaf.builtin).toBe(true)
  })
})
